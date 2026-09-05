"""Flask 本地 Web 入口（Phase 2：API + 前端最小闭环）。

职责：
- GET / 返回单页（web/templates/index.html）；
- 11 条 API 路由（见 docs §3 路由表）：健康检查、前台浏览、后台全量、保存/
  撤销、快照历史、对比、设置、一键清空；
- 只绑定 127.0.0.1，threaded=True；启动时默认自动打开浏览器；
- 所有与 Everything SDK 的接触（前台浏览）都会与 fullscan 共用同一把全局扫描锁，
  避免并发调用 DLL 重入。

测试通过 app.test_client() 进行，不真正启动服务器；真实启动入口见
run_server()/__main__。
"""

import atexit
import os
import subprocess
import sys
import threading
import time
import urllib.request
import uuid
import webbrowser
from datetime import datetime
from pathlib import Path

from flask import Flask, jsonify, render_template, request

import cli as cli_module
import compare
import datadir
import env
import fullscan
import messages
import scan
import sdk
import session
import snapshots
import utils
from exceptions import EverythingEnvironmentError, EverythingQueryError
from flask import Response

BASE_DIR = Path(__file__).resolve().parent
TEMPLATE_DIR = BASE_DIR / "web" / "templates"
STATIC_DIR = BASE_DIR / "web" / "static"

app = Flask(
    __name__,
    template_folder=str(TEMPLATE_DIR),
    static_folder=str(STATIC_DIR),
)


def _json_error(message, status=400, code=None, detail=None, **extra):
    """统一错误响应（P12·W1.3 additive 扩展）。

    旧形态 {ok:false,error} 保持不变；code/detail/extra 键仅在提供时附加
    （新形态 {ok:false,error[,code][,detail][,...]}），前端渲染器对两种
    形态双向容忍（RT-N04）。
    """
    payload = {"ok": False, "error": message}
    if code is not None:
        # W2.13：code 既支持数字错误码也支持稳定字符串标识（machine_mismatch 等）
        payload["code"] = int(code) if isinstance(code, int) else str(code)
    if detail:
        payload["detail"] = str(detail)
    for key, value in extra.items():
        if value is not None:
            payload[key] = value
    return jsonify(payload), status


def _json_ok(**payload):
    body = {"ok": True}
    body.update(payload)
    return jsonify(body)


# P12·W3.3（RT-N08）：404/405 统一 JSON 化——沿用旧形态 {ok:false,error}
# （W1.3 渲染器已容忍无 code/detail 的旧形态，不再制造第三种形态）。
@app.errorhandler(404)
def _not_found(_error):
    return _json_error("接口不存在", 404)


@app.errorhandler(405)
def _method_not_allowed(_error):
    return _json_error("方法不被允许", 405)


# =================【页面】=================


@app.get("/")
def index():
    return render_template("index.html")


# =================【0. 健康检查】=================


def _health_payload():
    """健康探测主体（P12·W1.3 degraded 分类；W2.1 busy 契约）。返回 JSON 字典。

    - 锁被占（扫描中）→ 立即返回 busy 形态，绝不阻塞 Werkzeug 线程：
      {ready:false,busy:true,reason:"scanning"}——**硬性契约 busy ≠ 未就绪**；
    - 病因② DLL 失效 → degraded="dll"；① config 损坏 → "config"；
      ③ 未安装 → "not_installed"；意外异常由 api_health 兜底。
    """
    # P12·W2.1：非阻塞 acquire，拿不到立即返回（不释放未持有的锁）
    acquired = scan.SCAN_LOCK.acquire(blocking=False)
    if not acquired:
        # 阶段B（B-18）：busy 分支 additive lock_holder/since——busy 只表示
        # 「某处正持有 SDK 锁」，不区分持有者是不可解释的根源；此处透出
        # 持有者名称与开始时刻，前端据此细分文案（全量扫描/对比/浏览占用）。
        holder = scan._lock_holder() or {}
        payload = {
            "ok": True, "ready": False, "busy": True, "reason": "scanning",
            "dll": str(sdk.DLL_PATH) if sdk.DLL_PATH else None,
            "message": "Everything 正在扫描中（健康检查暂缓探测）",
        }
        if holder.get("holder"):
            payload["lock_holder"] = holder["holder"]
        if holder.get("since"):
            payload["lock_since"] = holder["since"]
        return payload
    try:
        try:
            cfg = env.load_config()
            dll = sdk.DLL_PATH or sdk.resolve_everything_dll(config=cfg)
        except FileNotFoundError:
            return {
                "ok": True, "ready": False, "dll": None, "degraded": "dll",
                "message": "SDK DLL 缺失或配置失效",
            }
        bad = env.config_health()
        ready = bool(sdk.is_everything_ipc_ready(dll))
        if ready:
            return {"ok": True, "ready": True, "dll": str(dll), "message": "Everything 已就绪"}
        installed = env.find_everything_exe(config=cfg) is not None
        if not installed:
            return {
                "ok": True, "ready": False, "dll": str(dll), "degraded": "not_installed",
                "message": "未检测到 Everything，请先安装并启动",
            }
        if bad:
            return {
                "ok": True, "ready": False, "dll": str(dll), "degraded": "config",
                "message": f"配置文件损坏：{bad}",
            }
        return {"ok": True, "ready": False, "dll": str(dll), "message": "Everything IPC 尚未就绪"}
    finally:
        scan.SCAN_LOCK.release()


@app.get("/api/health")
def api_health():
    try:
        body = _health_payload()
    except Exception as exc:  # 意外异常兜底：不再伪装成正常结构
        body = {
            "ok": True, "ready": False, "dll": None, "degraded": "error", "busy": False,
            "message": f"环境检测异常：{exc}",
        }
    # P12·W2.1：锁空闲路径补 additive busy:false（busy:true 仅出现在锁被占形态）
    if isinstance(body, dict) and "busy" not in body:
        body["busy"] = False
    return jsonify(body)


# =================【1. 空间概览】=================


@app.get("/api/overview")
def api_overview():
    """返回最近全量结果的轻量概览，供仪表盘图表使用。"""
    scan_status = fullscan.status()
    scan_result = fullscan.result()
    if not scan_result or not scan_result.get("roots"):
        if scan_status.get("running"):
            return _json_ok(
                ready=False, scanning=True, empty_reason="scanning", roots=[],
                progress_pct=scan_status.get("progress_pct", 0),
                current_root=scan_status.get("current_root"),
                roots_done=scan_status.get("roots_done", 0),
                roots_total=scan_status.get("roots_total", 0),
            )
        return _json_ok(ready=False, scanning=False, empty_reason="no_scan", roots=[])
    roots = []
    for root, item in scan_result["roots"].items():
        index_ready = bool(fullscan.BROWSE_INDEX.has_root(root))
        stats = fullscan.BROWSE_INDEX.root_stats(root) or {"total": 0, "directory_count": 0, "file_count": 0}
        children = fullscan.BROWSE_INDEX.children(root)
        dirs = [
            {"name": str(name), "path": str(Path(root) / name), "size": int(size),
             "size_human": compare.human_size(int(size))}
            for name, is_dir, size in children if is_dir
        ]
        files = [
            {"name": str(name), "path": str(Path(root) / name), "size": int(size),
             "size_human": compare.human_size(int(size))}
            for name, is_dir, size in children if not is_dir
        ]
        total = int(stats["total"])
        roots.append({"root": root, "total": total, "total_human": compare.human_size(total) if index_ready else None,
                      "directories": dirs[:10], "files": files[:10],
                      "index_ready": index_ready,
                      "index_valid": index_ready,
                      "empty_reason": "empty_result" if index_ready and total == 0 else (None if index_ready else "invalid_index"),
                      "directory_count": int(stats["directory_count"]),
                      "file_count": int(stats["file_count"]),
                      "record_count": len(item.get("rows", [])),
                      "completed_at": scan_result.get("completed_at")})
    return _json_ok(ready=True, roots=roots, completed_at=scan_result.get("completed_at"))


# =================【2. 前台浏览】=================


@app.post("/api/browse")
def api_browse():
    data = request.get_json(silent=True) or {}
    raw_root = data.get("root")
    if not raw_root:
        return _json_error("缺少 root 参数")
    root = Path(raw_root)
    if not root.exists():
        return _json_error(f"路径不存在: {root}")
    # P12·W2.5（E）：目录校验下沉到 API——文件路径浏览返回明确 400
    if not root.is_dir():
        return _json_error(f"不是一个目录: {root}")
    current = Path(data.get("path") or raw_root)
    if not current.exists():
        return _json_error(f"目录不存在: {current}")
    if not current.is_dir():
        return _json_error(f"不是一个目录: {current}")

    # ① 已完成根的内存索引：不获取 SDK 锁，直接返回。
    indexed_root = fullscan.BROWSE_INDEX.root_for(current)
    requested_root = fullscan.BROWSE_INDEX.root_for(root)
    if indexed_root is not None and requested_root == indexed_root:
        items = fullscan.BROWSE_INDEX.children(current)
        # 阶段B（B-13）：source=index + source_at（索引完成时刻）
        source = "index"
        last_result = fullscan.result()
        source_at = (last_result or {}).get("completed_at")
    else:
        # ② 全量扫描中：已完成盘仍可浏览；正在扫描的盘给出可理解的进度态。
        if fullscan.is_running():
            status = fullscan.status()
            current_root = status.get("current_root")
            if current_root:
                active_root = Path(current_root)
                if fullscan.BROWSE_INDEX.root_for(current) == str(active_root):
                    # 这个分支理论上已由 ① 覆盖，保留以明确已完成盘优先。
                    items = fullscan.BROWSE_INDEX.children(current)
                    source = "index"
                    source_at = (fullscan.result() or {}).get("completed_at")
                else:
                    try:
                        in_active_root = fullscan._path_key(current).startswith(
                            fullscan._path_key(active_root).rstrip("/") + "/"
                        ) or fullscan._path_key(current) == fullscan._path_key(active_root)
                    except Exception:
                        in_active_root = False
                    if in_active_root or fullscan._path_key(root) == fullscan._path_key(active_root):
                        return _json_ok(
                            root=str(current),
                            parent=str(current.parent) if current != root else None,
                            directories=[], files=[], total_dirs=0, total_files=0,
                            scanning=True,
                            # 阶段B（B-13）：source additive
                            source="scanning",
                            source_at=datetime.now().isoformat(timespec="seconds"),
                            progress=status.get("progress_pct", 0),
                            message="该盘正在扫描中，完成后即可即时浏览",
                        )
            return _json_error(
                "全量扫描进行中，请等待完成后再浏览目录",
                status=409,
            )

        # ③ 没有可用全量索引时，退回 Everything SDK。
        # 阶段B（B-7 ③）：SDK 分支改非阻塞 acquire（与 health/compare 同口径），
        # 拿不到立即 409（不再阻塞式排队等锁造成请求挂死）；锁持有者登记 browse。
        if not scan.SCAN_LOCK.acquire(blocking=False):
            return _json_error(
                "索引/扫描占用中，请稍候再试",
                status=409,
            )
        scan._mark_lock_holder("browse")
        try:
            sizes, contents = scan.scan_via_everything_sdk(current)
        except EverythingQueryError as exc:
            # P12·W1.3：类型化查询错误 → 502 + 码表文案（不出裸错误码）；
            # code=2 叠加 Session 0 判定：Everything 全在其他会话（或当前会话
            # 为 0）→ service_only=True，文案改会话对齐提示。
            text = messages.render_everything_error(exc.code)
            extra = {}
            if exc.code == sdk.EVERYTHING_ERROR_IPC:
                sessions = env.list_everything_process_sessions()
                current_session = env.get_current_session_id()
                if sessions and (
                    current_session == 0
                    or all(s != current_session for s in sessions)
                ):
                    extra["service_only"] = True
                    text = (
                        "Everything 正以服务方式运行于其他会话，本会话无法连接；"
                        "请以管理员身份对齐运行后重试"
                    )
            return _json_error(f"扫描失败: {text}", status=502, code=exc.code, **extra)
        except Exception as exc:
            return _json_error(f"扫描失败: {exc}", status=500)
        finally:
            scan._clear_lock_holder()
            scan.SCAN_LOCK.release()

        try:
            items = contents.get(current, [])
        except Exception:
            items = []
        # 阶段B（B-13）：真实 SDK 直扫来源（不再靠字段缺失猜测缓存）
        source = "sdk"
        source_at = datetime.now().isoformat(timespec="seconds")

    directories = []
    files = []
    for name, is_dir, size in items:
        entry = {
            "name": str(name),
            "path": str(current / name),
            "is_dir": bool(is_dir),
            "size": int(size),
            "size_human": compare.human_size(int(size)),
        }
        if is_dir:
            directories.append(entry)
        else:
            files.append(entry)

    directories.sort(key=lambda x: (-x["size"], x["name"].casefold()))
    files.sort(key=lambda x: (-x["size"], x["name"].casefold()))
    parent = current.parent if current != root else None
    # 阶段B（B-13）：source additive（index=索引命中/sdk=真实直扫/scanning=扫描中）
    return _json_ok(
        root=str(current),
        parent=str(parent) if parent is not None else None,
        directories=directories[:200],
        files=files[:200],
        total_dirs=len(directories),
        total_files=len(files),
        source=source,
        source_at=source_at,
    )


# =================【2. 后台全量】=================


@app.post("/api/open-path")
def api_open_path():
    """在资源管理器中定位路径（P12·W1.4 行动闭环，DEF-009 P0-4）。

    校验清单（任一不过 → 400 中文错误）：
    ① path 为非空 str；② 绝对路径；③ 无控制字符（ord<32）；
    ④ 长度 ≤ 32768；⑤ 位于已完成扫描索引内或真实存在。
    处理：subprocess.Popen(list 形参免注入) 调 explorer /select；
    spawn OSError → launched:false（前端降级为复制路径）。
    已知限制：explorer 定位失败仍静默（RT-N10，README 已记录）。
    """
    data = request.get_json(silent=True) or {}
    path = data.get("path")
    if not isinstance(path, str) or not path.strip():
        return _json_error("path 必须是非空字符串")
    try:
        if not Path(path).is_absolute():
            return _json_error(f"path 必须是绝对路径: {path}")
    except (OSError, ValueError):
        return _json_error("path 不是合法路径")
    if any(ord(c) < 32 for c in path):
        return _json_error("path 含有非法控制字符")
    if len(path) > 32768:
        return _json_error("path 过长（超过 32768 字符）")
    in_index = fullscan.BROWSE_INDEX.contains(path)
    if not in_index:
        try:
            exists = Path(path).exists()
        except OSError:
            exists = False
        if not exists:
            return _json_error(f"路径不存在且不在扫描索引中: {path}")
    try:
        subprocess.Popen(["explorer", "/select,", path], close_fds=True)
    except OSError:
        return _json_ok(
            launched=False, message="无法调起资源管理器，路径已复制"
        )
    return _json_ok(launched=True, message="已请求资源管理器定位")


@app.post("/api/fullscan/start")
def api_fullscan_start():
    started = fullscan.start()
    if not started:
        if fullscan.is_running():
            return _json_error(
                "全量扫描已在运行中",
                status=409,
            )
        return _json_error("未发现可扫描的本地盘符", status=400)
    return _json_ok(message="全量扫描任务已提交，后台执行中", status=fullscan.status())


@app.get("/api/fullscan/status")
def api_fullscan_status():
    return _json_ok(status=fullscan.status())


# U3.2（D10 唯一新增接口）：用户停止。请求体可空（{}）；运行中 → 置用户停止
# 事件并返回 stopped=true；空闲 → stopped=false（幂等，不报错）。响应含
# status 原样（additive：stop_requested/stop_reason）。停服路径（W2.10）不经过
# 本接口——CANCEL_EVENT 由 atexit cancel_scan 单独承担，语义互不污染。
@app.post("/api/fullscan/stop")
def api_fullscan_stop():
    stopped = fullscan.request_stop()
    return _json_ok(stopped=stopped, status=fullscan.status())


# =================【3. 保存 / 撤销】=================


def _save_fullscan_result(auto):
    """从最近一次全量结果生成各根快照 + session 清单（P12·W2.11 语义补全）。

    - **逐盘 try 成败清单**（B-1 缓解，不做全事务）：单盘失败不再一损俱损，
      响应 additive 携带 saved/failed/skipped_roots 三张清单；
    - **台账备份**（B-2）：保存前抓取每根台账条目，写入清单 additive 字段
      ``ledger_backup``，undo 时按其回滚，保证指纹谓词不抑制下次自动保存。
    """
    if fullscan.is_running():
        raise ValueError("全量扫描进行中，暂不能保存")
    scan_result = fullscan.result()
    if not scan_result or not scan_result.get("roots"):
        raise ValueError("暂无可保存的全量扫描结果，请先完成全量扫描")

    roots_map = scan_result["roots"]
    machine_guid = snapshots.get_machine_guid()
    snap_dir = snapshots.get_snapshot_dir()
    session_id = session.build_session_id(machine_guid=machine_guid)

    roots_payload = {}
    ledger_backup = {}
    saved_list = []
    failed_list = []
    skipped_roots = []
    any_saved = False
    any_skipped = False
    for root, item in roots_map.items():
        rows = item["rows"]
        # P12·W2.11（B-2）：保存前抓取该根当前台账条目（undo 回滚依据）
        try:
            current_ledger = snapshots.load_ledger(snap_dir)
            ledger_backup[root] = current_ledger.get(root)
        except Exception:
            ledger_backup[root] = None
        try:
            saved_path = snapshots.save_snapshot(
                root,
                rows,
                dir_path=snap_dir,
                auto=auto,
                machine_guid=machine_guid,
                tree_complete=auto,
                dirty=False,
            )
        except Exception as exc:
            failed_list.append(
                {"root": root, "error": f"保存 {root} 快照失败: {exc}"}
            )
            continue
        if saved_path is None:  # auto=True 被谓词或日配额拒绝
            notice = snapshots.consume_last_save_notice()
            if notice is not None:
                entry = {
                    "root": root,
                    "snapshot": None,
                    "snapshot_path": None,
                    "skipped": True,
                    "skip_reason": snapshots.REASON_DAY_BUDGET_EXCEEDED,
                    "notice": notice,
                }
            else:
                entry = {
                    "root": root,
                    "snapshot": None,
                    "snapshot_path": None,
                    "skipped": True,
                    "skip_reason": "predicate_rejected",
                }
            roots_payload[root] = entry
            skipped_roots.append({"root": root, "skip_reason": entry["skip_reason"]})
            any_skipped = True
            continue
        entry = {
            "root": root,
            "snapshot": saved_path.name,
            "snapshot_path": str(saved_path),
            "skipped": False,
        }
        soft_notice = snapshots.consume_last_save_notice()
        if soft_notice is not None:
            entry["notice"] = soft_notice
        roots_payload[root] = entry
        try:
            saved_bytes = int(saved_path.stat().st_size)
        except OSError:
            saved_bytes = 0
        saved_list.append(
            {"root": root, "snapshot": saved_path.name, "bytes": saved_bytes}
        )
        any_saved = True

    if not any_saved and not skipped_roots:
        raise ValueError("本次没有生成任何快照：" + "；".join(f["error"] for f in failed_list))

    session_payload = {
        "session_id": session_id,
        "auto": bool(auto),
        "machine_guid": machine_guid,
        "roots": roots_payload,
        # P12·W2.11（B-2）additive：undo 台账回滚依据
        "ledger_backup": ledger_backup,
    }
    session_file = session.save_session(session_payload)
    fullscan.mark_saved(scan_version=scan_result.get("scan_version"))
    return {
        "session": session_payload,
        "session_file": str(session_file),
        "skipped": any_skipped,
        # P12·W2.11 additive：逐盘成败清单
        "saved": saved_list,
        "failed": failed_list,
        "skipped_roots": skipped_roots,
    }


@app.post("/api/save")
def api_save():
    data = request.get_json(silent=True) or {}
    auto = bool(data.get("auto", False))
    try:
        payload = _save_fullscan_result(auto=auto)
    except ValueError as exc:
        return _json_error(str(exc), status=409)
    except OSError as exc:
        return _json_error(f"保存失败: {exc}", status=500)
    return _json_ok(message="保存完成", **payload)


@app.post("/api/save/undo")
def api_save_undo():
    sessions = session.list_sessions()
    if not sessions:
        return _json_error("没有可撤销的保存记录", status=404)
    latest = session.load_session(sessions[0])
    if not latest:
        return _json_error("最近一次保存记录损坏，无法撤销", status=500)

    deleted = []
    errors = []
    # P12·W2.11（SEC-4 搭车）：unlink 前目录边界校验——只删快照目录内的路径
    try:
        snapshots_root = Path(snapshots.get_snapshot_dir()).resolve()
    except OSError:
        snapshots_root = None
    for root_info in latest.get("roots", {}).values():
        snapshot_path = root_info.get("snapshot_path")
        if not snapshot_path:
            continue
        try:
            resolved = Path(snapshot_path).resolve()
            resolved.relative_to(snapshots_root)
        except (ValueError, OSError):
            errors.append(f"越界路径已跳过: {snapshot_path}")
            continue
        path = resolved
        try:
            if path.exists():
                path.unlink()
                deleted.append(str(path))
        except OSError as exc:
            errors.append(f"{snapshot_path}: {exc}")

    # P12·W2.11（B-2）：台账回滚——按保存前备份恢复每根台账条目，保证 undo 后
    # 指纹谓词不抑制下次自动保存；旧清单无该字段则跳过并附提示。
    ledger_backup = latest.get("ledger_backup")
    if isinstance(ledger_backup, dict):
        try:
            ledger = snapshots.load_ledger()
            for root_key, prev_entry in ledger_backup.items():
                if prev_entry is None:
                    ledger.pop(str(root_key), None)
                else:
                    ledger[str(root_key)] = prev_entry
            snapshots.save_ledger(ledger)
        except OSError as exc:
            errors.append(f"台账回滚失败: {exc}")
    else:
        errors.append("清单早于台账回滚功能，下次自动保存可能被指纹谓词抑制一次")

    try:
        session.delete_session(sessions[0])
    except OSError as exc:
        errors.append(f"清单删除失败: {exc}")

    return _json_ok(
        message="已撤销最近一次保存",
        session_id=latest.get("session_id"),
        deleted=deleted,
        undeleted=errors,
    )


# =================【3.5 快照删除（阶段C C-2，additive 新接口）】=================
# 删除粒度（D1 裁定）：{session_id, root}（单盘）或 {session_id}（整会话）。
# 设计要点：
# - 目录边界校验复用 api_save_undo 的 resolve().relative_to(snapshots_root) 模式；
# - 幂等：目标已不存在 → {deleted:true, already:true} 不报错；
# - 扫描中禁止删除 → 409（fullscan.is_running()，绝不触碰线程）；
# - 台账一致性：删除单盘后 ledger 中该根条目移除（与 undo 回滚同口径的「删除后
#   不再抑制下次自动保存」语义）；整会话同理按该会话各根清理；
# - 会话无剩余条目 → 删 session 文件；响应含逐目标成败清单（deleted/failed/already）。


def _resolve_snapshot_path(snapshot_path, snapshots_root):
    """目录边界校验：resolve 后必须位于 snapshots_root 内；越界返回 None。"""
    try:
        resolved = Path(snapshot_path).resolve()
        resolved.relative_to(snapshots_root)
    except (ValueError, OSError):
        return None
    return resolved


def _drop_ledger_roots(roots, snap_dir):
    """删除后台账一致性：从 ledger 移除被删根的条目（整会话=全部 roots；单盘=该根）。
    失败仅记录（不影响文件删除结果）。返回错误文案列表。"""
    errors = []
    try:
        ledger = snapshots.load_ledger(snap_dir)
        changed = False
        for root in roots:
            key = str(root)
            if key in ledger:
                ledger.pop(key, None)
                changed = True
        if changed:
            snapshots.save_ledger(ledger, snap_dir)
    except OSError as exc:
        errors.append(f"台账清理失败: {exc}")
    return errors


@app.post("/api/snapshot/delete")
def api_snapshot_delete():
    """删除指定快照（单盘）或整会话（阶段C C-2）。

    请求体：{"session_id": str, "root": str(可选)}——root 省略 = 整会话删除。
    响应：{ok:true, session_id, root?, deleted:[...], already:[...], failed:[...],
          session_removed:bool}
    - 会话不存在 → 404「快照会话不存在」；
    - 会话 JSON 损坏 → 500「快照会话清单损坏」；
    - 单盘 root 未在该会话 roots 内 → 404「该会话没有此盘快照」；
    - 扫描中 → 409「全量扫描进行中，请等待完成后再删除」；
    - 越界路径跳过（failed 带「越界」文案），绝不 unlink 目录外文件；
    - 文件缺失 → already:true（幂等，不报错）；
    - 删除文件失败 → failed 带错误文案。
    """
    data = request.get_json(silent=True) or {}
    session_id = str(data.get("session_id") or "").strip()
    raw_root = data.get("root")
    if not session_id:
        return _json_error("缺少 session_id 参数")

    # 扫描中禁止删除（阶段C 纪律#9：409；绝不触碰线程，仅查询状态）
    if fullscan.is_running():
        return _json_error(
            "全量扫描进行中，请等待完成后再删除快照",
            status=409,
        )

    sessions = session.list_sessions()
    target = None
    sid_norm = session_id if session_id.endswith(".json") else session_id + ".json"
    for p in sessions:
        if p.name == sid_norm:
            target = p
            break
    if target is None:
        return _json_error(f"快照会话不存在: {session_id}", status=404)
    latest = session.load_session(target)
    if not latest:
        return _json_error("快照会话清单损坏，无法删除", status=500)

    roots_map = latest.get("roots") or {}
    if raw_root is not None:
        root_key = str(raw_root)
        entry = roots_map.get(root_key)
        if entry is None:
            # 兼容大小写/尾斜杠差异：按目录语义匹配
            matched_key = next(
                (k for k in roots_map if Path(k) == Path(root_key)), None
            )
            entry = roots_map.get(matched_key) if matched_key else None
            if entry is None:
                return _json_error(
                    f"该会话没有此盘快照: {root_key}", status=404
                )
            root_key = matched_key
        targets = [root_key]
        whole_session = False
    else:
        targets = list(roots_map.keys())
        whole_session = True

    try:
        snapshots_root = Path(snapshots.get_snapshot_dir()).resolve()
    except OSError:
        snapshots_root = None

    deleted = []
    already = []
    failed = []
    for root_key in targets:
        entry = roots_map.get(root_key) or {}
        snapshot_path = entry.get("snapshot_path")
        if not snapshot_path:
            already.append({"root": root_key, "reason": "no_snapshot_path"})
            continue
        if snapshots_root is None:
            failed.append({"root": root_key, "error": "快照目录不可用"})
            continue
        resolved = _resolve_snapshot_path(snapshot_path, snapshots_root)
        if resolved is None:
            failed.append(
                {"root": root_key, "error": f"越界路径已跳过: {snapshot_path}"}
            )
            continue
        try:
            if resolved.exists():
                resolved.unlink()
                deleted.append({"root": root_key, "snapshot": resolved.name})
            else:
                already.append({"root": root_key, "snapshot": resolved.name})
        except OSError as exc:
            failed.append({"root": root_key, "error": f"{snapshot_path}: {exc}"})

    # 台账一致性：删除成功的根从 ledger 移除（与 undo 回滚同口径）
    ledger_errors = _drop_ledger_roots(
        [d.get("root") for d in deleted if d.get("root")],
        snapshots.get_snapshot_dir(),
    )

    # 更新 session JSON：移除已删除根条目；无剩余条目则删 session 文件
    session_removed = False
    for root_key in targets:
        roots_map.pop(root_key, None)
    if whole_session or not roots_map:
        try:
            session_removed = session.delete_session(target)
        except OSError as exc:
            failed.append({"root": None, "error": f"会话清单删除失败: {exc}"})
    else:
        try:
            latest["roots"] = roots_map
            session.save_session(latest, dir_path=target.parent)
        except OSError as exc:
            failed.append({"root": None, "error": f"会话清单更新失败: {exc}"})

    # 台账清理失败信息并入 failed 清单（响应含逐目标成败清单）
    for err in ledger_errors:
        failed.append({"root": None, "error": err})

    return _json_ok(
        message="删除完成",
        session_id=session_id,
        root=root_key if not whole_session else None,
        whole_session=whole_session,
        deleted=deleted,
        already=already,
        failed=failed,
        session_removed=session_removed,
    )


# =================【4. 历史 / 对比】=================


@app.get("/api/snapshots")
def api_snapshots():
    sessions = session.list_sessions()
    items = []
    for path in sessions:
        data = session.load_session(path)
        if data:
            data["_file"] = path.name
            items.append(data)
    return _json_ok(sessions=items, count=len(items))


# 阶段B（B-1）：/api/compare 异步化——无全量缓存时不再阻塞请求线程直扫，
# 返回 202 + {job_id, status:"scanning"}，前端轮询 /api/compare/status。
# 后台任务 dict（job_id -> CompareJob，进程内单实例足够；锁内互斥）：
COMPARE_JOBS = {}
_COMPARE_JOBS_LOCK = threading.Lock()


def _compare_job_key(root, baseline):
    """对比任务键：root+baseline 归一化路径（同一对输入复用/去重）。"""
    return (str(root).casefold(), str(baseline).casefold())


def _run_compare_job(job_id, key, root, baseline_file, allow_other_machine):
    """后台对比任务：排队拿锁 → SDK 直扫 → diff → 记结果/错误（进程内 daemon 线程）。

    - 拿锁阻塞发生在后台线程（不阻塞 Web 请求线程）；锁被抢占时 phase=queued；
    - 持锁期间登记 lock_holder="compare"（B-18 健康 busy 区分持有者）；
    - 任何异常收敛为 status:"error"（绝不抛穿线程）。
    """
    def _set(**kw):
        with _COMPARE_JOBS_LOCK:
            job = COMPARE_JOBS.get(job_id)
            if job:
                job.update(kw)

    try:
        _set(phase="queued", status="queued", message="等待扫描引擎空闲…")
        with scan.sdk_lock("compare"):
            _set(phase="scanning", status="scanning", message="正在后台扫描当前盘…")
            current_sizes, _unused = scan.scan_via_everything_sdk(Path(root))
        baseline = snapshots.load_snapshot(baseline_file)
        report = compare.diff_from_current(
            current_sizes,
            baseline.get("rows") or [],
            machine_guid=baseline.get("header", {}).get("machine_guid"),
            leaf_only=True,
            local_machine_guid=snapshots.get_machine_guid(),
            allow_other_machine=bool(allow_other_machine or False),
        )
        rows = compare.top_growth(report, 100)
        baseline_created_at = str((baseline.get("header") or {}).get("created_at") or "")
        current_completed_at = datetime.now().isoformat(timespec="seconds")
        _set(
            phase="done",
            status="done",
            message=None,
            report={
                "root": report["root"],
                "total_baseline": report["total_baseline"],
                "total_current": report["total_current"],
                "delta_total": report["delta_total"],
                "truncated": report["truncated"],
                "legacy_count": int(report.get("legacy_count") or 0),
                "baseline_created_at": baseline_created_at,
                "current_completed_at": current_completed_at,
                "rows": rows,
            },
            done=True,
        )
    except compare.CompareError as exc:
        code = getattr(exc, "kind", None)
        _set(
            phase="error", status="error",
            error=str(exc),
            code=code if code == "machine_mismatch" else None,
        )
    except Exception as exc:
        _set(phase="error", status="error", error=str(exc))


@app.post("/api/compare")
def api_compare():
    data = request.get_json(silent=True) or {}
    raw_root = data.get("root")
    baseline_path = data.get("baseline")
    if not raw_root or not baseline_path:
        return _json_error("缺少 root 或 baseline 参数")
    # 阶段B（B-1 ④）：baseline 前置校验——先报「不存在」（沿用原语义），
    # 再校验必须是快照文件（.snap.gz 后缀 + 非目录），否则 400「基线不是快照文件」
    # （目录/任意文件不再落入 500）。
    baseline_file = Path(baseline_path)
    if not baseline_file.exists():
        return _json_error(f"基线快照不存在: {baseline_file}")
    if baseline_file.is_dir() or not baseline_file.is_file():
        return _json_error(f"基线不是快照文件: {baseline_file}", status=400)
    if not str(baseline_file.name).endswith(".snap.gz"):
        return _json_error(f"基线不是快照文件: {baseline_file}", status=400)

    if fullscan.is_running():
        return _json_error(
            "全量扫描进行中，请等待完成后再对比",
            status=409,
        )

    # 阶段B（B-1 ①）：响应前先查 fullscan.result(root)——命中索引则同步秒级出报告。
    cached = fullscan.result(root=raw_root)
    if cached and cached.get("rows"):
        try:
            baseline = snapshots.load_snapshot(baseline_file)
        except Exception as exc:
            return _json_error(f"基线快照加载失败: {exc}", status=500)
        current_sizes = {
            Path(row["p"]): int(row["s"]) for row in cached["rows"]
        }
        try:
            report = compare.diff_from_current(
                current_sizes,
                baseline.get("rows") or [],
                machine_guid=baseline.get("header", {}).get("machine_guid"),
                leaf_only=True,
                local_machine_guid=snapshots.get_machine_guid(),
                allow_other_machine=bool(data.get("allow_other_machine") or False),
            )
        except compare.CompareError as exc:
            if getattr(exc, "kind", None) == "machine_mismatch":
                return _json_error(f"对比失败: {exc}", status=409, code="machine_mismatch")
            return _json_error(f"对比失败: {exc}", status=400)
        rows = compare.top_growth(report, 100)
        baseline_created_at = str((baseline.get("header") or {}).get("created_at") or "")
        last_fullscan = fullscan.result()
        current_completed_at = (last_fullscan or {}).get("completed_at")
        if not current_completed_at:
            current_completed_at = datetime.now().isoformat(timespec="seconds")
        return _json_ok(
            report={
                "root": report["root"],
                "total_baseline": report["total_baseline"],
                "total_current": report["total_current"],
                "delta_total": report["delta_total"],
                "truncated": report["truncated"],
                "legacy_count": int(report.get("legacy_count") or 0),
                "baseline_created_at": baseline_created_at,
                "current_completed_at": current_completed_at,
                "rows": rows,
            },
        )

    # 阶段B（B-1 ②）：无缓存不阻塞直扫——提交后台任务，202 + {job_id, status:"scanning"}。
    # 提交前保持 P12·W2.1（C-1）契约：SDK 锁被占用 → 立即 409（请求线程绝不排队挂死；
    # 异步排队只发生在后台任务线程）。同 key 任务去重：已有未完成任务 → 复用其 job_id。
    key = _compare_job_key(raw_root, baseline_path)
    job_id = None
    with _COMPARE_JOBS_LOCK:
        for jid, job in list(COMPARE_JOBS.items()):
            if job.get("root_case") == key[0] and job.get("baseline_case") == key[1]:
                if not job.get("done"):
                    job_id = jid
                break
    if job_id is None:
        acquired = scan.SCAN_LOCK.acquire(blocking=False)
        if not acquired:
            return _json_error("全量扫描进行中，请稍后再对比", status=409)
        scan.SCAN_LOCK.release()
        job_id = str(uuid.uuid4())
        with _COMPARE_JOBS_LOCK:
            COMPARE_JOBS[job_id] = {
                "root": str(raw_root),
                "baseline": str(baseline_path),
                "root_case": key[0],
                "baseline_case": key[1],
                "status": "queued",
                "phase": "queued",
                "message": "等待扫描引擎空闲…",
                "done": False,
                "created_at": datetime.now().isoformat(timespec="seconds"),
                "allow_other_machine": bool(data.get("allow_other_machine") or False),
            }
        threading.Thread(
            target=_run_compare_job,
            args=(job_id, key, raw_root, baseline_file,
                  bool(data.get("allow_other_machine") or False)),
            daemon=True,
            name="compare-background",
        ).start()
    return _json_ok(
        job_id=job_id,
        status="scanning",
        phase="queued",
        message="后台对比任务已提交，可轮询 /api/compare/status",
    ), 202


@app.get("/api/compare/status")
def api_compare_status():
    """阶段B（B-1）：对比任务轮询接口（新接口，13 个既有接口零变更）。
    - 未知 job → 404；完成 → {status:"done", report}；扫描中 → {status:"scanning", phase}。
    """
    job_id = (request.args.get("job_id") or "").strip()
    if not job_id:
        return _json_error("缺少 job_id 参数")
    with _COMPARE_JOBS_LOCK:
        job = COMPARE_JOBS.get(job_id)
        if job is None:
            return _json_error("对比任务不存在或已过期", status=404)
        snapshot = dict(job)
    # 完成/失败任务保留 60s 供前端消费后清理（防内存无限增长）
    if snapshot.get("done") or snapshot.get("status") == "error":
        with _COMPARE_JOBS_LOCK:
            if job.get("_expire_at") is None:
                job["_expire_at"] = time.time() + 60
        if snapshot.get("done"):
            return _json_ok(job_id=job_id, status="done", report=snapshot.get("report"))
        return _json_ok(
            job_id=job_id, status="error",
            error=snapshot.get("error"),
            code=snapshot.get("code"),
        )
    return _json_ok(
        job_id=job_id,
        status=snapshot.get("status") or "scanning",
        phase=snapshot.get("phase") or "scanning",
        message=snapshot.get("message"),
    )


# =================【5. 设置】=================

# P12·W2.6（K4）/W2.9（SEC-1）：可写设置键白名单（冲突1 裁决——剔除 everything_*）。
# 白名单外键一律 400；everything_* 前缀固定文案拒写（投毒链封堵）。
ALLOWED_SETTING_KEYS = {
    "auto_save": bool,
    "last_roots": list,
    "theme": str,
}

_EVERYTHING_LOCKED_MESSAGE = (
    "安全限制：everything_* 只能由本机程序自动探测，不能从网页设置写入"
)


def validate_settings_payload(data):
    """校验并清洗设置写入载荷，返回 (clean_dict, error_message|None)。

    - 白名单外键 → 拒绝；everything_* 前缀 → 固定文案；
    - auto_save 必须 bool；theme 仅 light/dark；last_roots 必须字符串列表，
      且截断到前 5 项（与前端「最近浏览」上限一致）。
    """
    if not isinstance(data, dict):
        return None, "请求体必须是 JSON 对象"
    clean = {}
    for key, value in data.items():
        if isinstance(key, str) and key.startswith("everything_"):
            return None, _EVERYTHING_LOCKED_MESSAGE
        if key not in ALLOWED_SETTING_KEYS:
            return None, f"不允许写入设置项: {key}"
        expected = ALLOWED_SETTING_KEYS[key]
        if expected is bool:
            if not isinstance(value, bool):
                return None, f"{key} 必须是布尔值"
        elif expected is list:
            if not isinstance(value, list) or not all(isinstance(x, str) for x in value):
                return None, f"{key} 必须是字符串列表"
            value = [v for v in value if v.strip()][:5]
        else:  # str
            if not isinstance(value, str):
                return None, f"{key} 必须是字符串"
            if key == "theme" and value not in ("light", "dark"):
                return None, "theme 仅支持 light/dark"
        clean[key] = value
    return clean, None


@app.route("/api/settings", methods=["GET", "POST"])
def api_settings():
    if request.method == "GET":
        return _json_ok(
            settings=env.load_config(),
            data_dir=str(datadir.get_data_dir()),
            snapshots_dir=str(datadir.get_snapshots_dir()),
        )
    data = request.get_json(silent=True) or {}
    clean, error = validate_settings_payload(data)
    if error is not None:
        return _json_error(error, status=400)
    config = env.load_config()
    config.update(clean)
    if not env.save_config(config):
        return _json_error("设置保存失败，请检查数据目录是否可写", status=500)
    return _json_ok(settings=config, message="设置已保存")


# =================【6. Web 导出（P12·W2.7，G-1）】=================


@app.get("/api/export")
def api_export():
    """Web 导出：最近全量结果该根 rows 聚合 → CSV/JSON 下载。

    - format 非法 → 400 JSON；无全量结果 / 根未完成 → 404 JSON；
    - csv 响应头 text/csv; charset=utf-8-sig + attachment；json 为 application/json；
    - legacy 提示（RT-05 消费端）：unknown_size_count>0 时 CSV 表头前输出
      「# 提示：…」行（Excel 当首行数据属已知限制），JSON 加 additive
      ``legacy_notice`` 字段。
    """
    fmt = (request.args.get("format") or "").lower()
    if fmt not in ("csv", "json"):
        return _json_error("format 仅支持 csv 或 json")
    # 阶段B（B-16）：扫描中/排队中无结果 → 409 + reason:"scanning"（与 404 区分）
    if fullscan.is_running():
        return _json_error(
            "扫描进行中，暂无可导出的结果，请等待扫描完成后再导出",
            status=409, reason="scanning",
        )
    last = fullscan.result()
    roots_map = (last or {}).get("roots") or {}
    if not roots_map:
        return _json_error("暂无可导出的全量扫描结果，请先完成全量扫描", status=404)
    raw_root = request.args.get("root")
    if raw_root:
        target_key = next(
            (key for key in roots_map if Path(key) == Path(raw_root)), None
        )
        if target_key is None:
            return _json_error(f"该根尚未完成扫描或不在结果中: {raw_root}", status=404)
    else:
        target_key = next(iter(roots_map))
    item = roots_map[target_key]
    sizes_map = {Path(row["p"]): int(row["s"]) for row in (item.get("rows") or [])}
    root_path_obj = Path(target_key)
    unknown = int(item.get("unknown_size_count") or 0)
    # 阶段B（B-16）：中止部分根导出 → partial:true 提示行（CSV legacy 提示行先例）
    partial = bool(fullscan._copy_state().get("stop_requested")) if hasattr(fullscan, "_copy_state") else False
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"disk_report_{timestamp}.{fmt}"

    if fmt == "csv":
        body = cli_module.build_report_csv(sizes_map)
        if unknown > 0:
            body = (
                f"# 提示：本数据源含 {unknown} 条大小未知条目（未计入聚合），"
                "建议重新扫描后导出\r\n" + body
            )
        if partial:
            body = (
                "# 提示：本次导出为部分结果（扫描已中止，仅含已完成盘）\r\n" + body
            )
        resp = Response("\ufeff" + body, mimetype="text/csv; charset=utf-8-sig")
        resp.headers["Content-Disposition"] = f"attachment; filename={filename}"
        if partial:
            resp.headers["X-Export-Partial"] = "true"
        return resp
    # json
    import json as json_lib

    payload = json_lib.loads(cli_module.build_report_json(root_path_obj, sizes_map))
    payload["legacy_notice"] = (
        f"本数据源含 {unknown} 条大小未知条目（未计入聚合），建议重新扫描后导出"
        if unknown > 0
        else ""
    )
    payload["partial"] = partial
    resp = Response(
        json_lib.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        mimetype="application/json",
    )
    resp.headers["Content-Disposition"] = f"attachment; filename={filename}"
    if partial:
        resp.headers["X-Export-Partial"] = "true"
    return resp


# P12·W2.9（SEC-2）：Host 白名单中间件——防 DNS rebinding（拦截域名形态 Host）。
# 仅本机回环来源放行；IP:端口形态不受影响。
@app.before_request
def _guard_host():
    raw_host = (request.host or "").lower()
    if raw_host.startswith("["):  # IPv6 字面量形态 [::1]:5000
        host = raw_host.split("]")[0].lstrip("[")
    else:
        host = raw_host.split(":")[0]
    if host not in ("127.0.0.1", "localhost", "::1"):
        return jsonify({"ok": False, "error": "非法访问来源（Host 校验失败）"}), 403
    return None  # 放行


# =================【7. 一键清空】=================


@app.post("/api/admin/wipe")
def api_admin_wipe():
    data = request.get_json(silent=True) or {}
    if data.get("confirm") != "确认清空":
        return _json_error("确认字段不正确；请输入“确认清空”以继续", status=400)
    if fullscan.is_running():
        return _json_error(
            "后台扫描进行中，请等待扫描结束后再清空",
            status=409,
        )
    try:
        root = datadir.wipe_data()
    except OSError as exc:
        return _json_error(f"清空失败：{exc}，请关闭相关文件后重试", status=500)
    return _json_ok(message="数据目录已清空", data_dir=str(root))


# =================【启动】=================


def _ensure_std_streams():
    """windowed 打包（PyInstaller console=False）下 sys.stdout/stderr 为 None，
    任何 print（scan/sdk/env 的进度与日志）都会抛 AttributeError；先把它们
    重定向到 devnull 兜底，再交给 _reconfigure_std_streams 统一转 UTF-8。
    控制台运行时不改变任何行为。
    """
    for name in ("stdout", "stderr"):
        stream = getattr(sys, name, None)
        if stream is None:
            setattr(
                sys,
                name,
                open(os.devnull, "w", encoding="utf-8", errors="replace"),
            )


def _bootstrap_everything():
    """bind 后台自动拉起 Everything（冲突3，P0 只做冷启动）。

    任何失败只记日志、绝不杀服务器——health 的 degraded 分类兜底呈现。
    """
    try:
        env.ensure_everything_running(
            timeout_seconds=env.DEFAULT_EVERYTHING_STARTUP_TIMEOUT_SECONDS
        )
    except EverythingEnvironmentError as exc:
        utils.log(f"[引导] 自动拉起未完成：{exc}")
    except Exception as exc:  # 任何失败不杀服务器
        utils.log(f"[引导] 自动拉起异常：{exc}")


def _another_instance_running(port):
    """P12·W2.10（DEP-1）：bind 前探测端口是否已被本工具实例占用。

    能取到 /api/health 200 → 视为已有实例；任何异常（连接拒绝/超时）都视为
    无实例，不影响正常启动。
    """
    try:
        with urllib.request.urlopen(
            f"http://127.0.0.1:{port}/api/health", timeout=1
        ) as resp:
            return resp.status == 200
    except Exception:
        return False


def _shutdown_fullscan():
    """停服收尾（P12·W2.10 R-2）：协作取消后台扫描并等待其收尾。"""
    try:
        fullscan.cancel_scan(join_timeout=5)
    except Exception:
        pass  # 退出路径绝不因收尾失败而抛错/裸 traceback


def run_server(port=5000, open_browser=True, debug_log=False):
    """启动本地 Flask 服务（仅 127.0.0.1，threaded=True）。

    阶段B（B-17/B-20）日志策略：
    - 默认（debug_log=False）：Werkzeug access log 降为 WARNING+（成功请求
      /api/fullscan/status 轮询不再刷屏）；**生产错误日志不静默**（WARNING+
      与异常堆栈仍输出）；
    - debug_log=True（CLI --debug-log）：保留完整 access log，供开发调试；
    - 启动必要提示（端口占用/防双实例探测结果）不经日志门控，始终可见。
    """
    # 与 cli.main() 同款：把 stdout/stderr 重配置为 UTF-8，避免 GBK 控制台/管道下
    # log() 打印 emoji（ℹ️/🔎）抛 UnicodeEncodeError，从而污染 /api/health 的中文文案。
    _ensure_std_streams()
    utils._reconfigure_std_streams()
    TEMPLATE_DIR.mkdir(parents=True, exist_ok=True)
    STATIC_DIR.mkdir(parents=True, exist_ok=True)
    # P12·W2.10（DEP-1）防双实例：bind 前探测，能通则复用已有实例页面
    if _another_instance_running(port):
        print(f"端口 {port} 已被本工具实例占用，将打开已有实例页面")
        if open_browser:
            webbrowser.open(f"http://127.0.0.1:{port}")
        return
    if open_browser:
        threading.Timer(
            0.8,
            lambda: webbrowser.open(f"http://127.0.0.1:{port}"),
        ).start()
    # P12·W2.10：退出时协作取消后台扫描（join 超时放弃，不硬杀）
    atexit.register(_shutdown_fullscan)
    # 阶段B（B-17/B-20）：Werkzeug 日志策略——默认 WARNING+（access log 关）；
    # --debug-log 保留完整请求日志（开发调试有据）；错误堆栈始终可见。
    try:
        import logging
        werkzeug_logger = logging.getLogger("werkzeug")
        if debug_log:
            werkzeug_logger.setLevel(logging.INFO)
        else:
            werkzeug_logger.setLevel(logging.WARNING)
    except Exception:
        pass  # 日志配置失败不影响服务启动
    # P12·W1.3：daemon 线程自动拉起，绝不阻塞 bind
    threading.Thread(
        target=_bootstrap_everything, name="everything-bootstrap", daemon=True
    ).start()
    app.run(
        host="127.0.0.1",
        port=port,
        threaded=True,
        debug=False,
    )


if __name__ == "__main__":
    # 双击/直接运行默认自动打开浏览器；`--no-browser` 供打包冒烟测试使用。
    # 阶段B（B-20）：Web 启动默认关闭 CLI 风格启动日志（utils.VERBOSE=False，
    # 🧭/🔎/🔌/✅ 系列不再刷屏；前端状态走健康徽章）；`--verbose` 恢复；
    # `--debug-log` 保留 Werkzeug access log（开发调试）。
    args = set(sys.argv[1:])
    if "--verbose" not in args:
        utils.VERBOSE = False
    run_server(
        open_browser="--no-browser" not in args,
        debug_log="--debug-log" in args,
    )