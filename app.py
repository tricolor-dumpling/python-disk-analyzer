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

import os
import sys
import threading
import webbrowser
from pathlib import Path

from flask import Flask, jsonify, render_template, request

import compare
import datadir
import env
import fullscan
import scan
import sdk
import session
import snapshots
import utils

BASE_DIR = Path(__file__).resolve().parent
TEMPLATE_DIR = BASE_DIR / "web" / "templates"
STATIC_DIR = BASE_DIR / "web" / "static"

app = Flask(
    __name__,
    template_folder=str(TEMPLATE_DIR),
    static_folder=str(STATIC_DIR),
)


def _json_error(message, status=400):
    return jsonify({"ok": False, "error": message}), status


def _json_ok(**payload):
    body = {"ok": True}
    body.update(payload)
    return jsonify(body)


# =================【页面】=================


@app.get("/")
def index():
    return render_template("index.html")


# =================【0. 健康检查】=================


@app.get("/api/health")
def api_health():
    try:
        config = env.load_config()
        if sdk.DLL_PATH is None:
            sdk.DLL_PATH = sdk.resolve_everything_dll(config=config)
        ready = bool(sdk.is_everything_ipc_ready(sdk.DLL_PATH))
        return _json_ok(
            ready=ready,
            dll=str(sdk.DLL_PATH),
            message="Everything 已就绪" if ready else "Everything IPC 尚未就绪",
        )
    except Exception as exc:
        return _json_ok(
            ready=False,
            dll=None,
            message=f"Everything 不可用：{exc}",
        )


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
    current = Path(data.get("path") or raw_root)
    if not current.exists():
        return _json_error(f"目录不存在: {current}")

    # ① 已完成根的内存索引：不获取 SDK 锁，直接返回。
    indexed_root = fullscan.BROWSE_INDEX.root_for(current)
    requested_root = fullscan.BROWSE_INDEX.root_for(root)
    if indexed_root is not None and requested_root == indexed_root:
        items = fullscan.BROWSE_INDEX.children(current)
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
                            progress=status.get("progress_pct", 0),
                            message="该盘正在扫描中，完成后即可即时浏览",
                        )
            return _json_error(
                "全量扫描进行中，请等待完成后再浏览目录",
                status=409,
            )

        # ③ 没有可用全量索引时，退回 Everything SDK。
        try:
            with fullscan.GLOBAL_SCAN_LOCK:
                sizes, contents = scan.scan_via_everything_sdk(current)
        except Exception as exc:
            return _json_error(f"扫描失败: {exc}", status=500)

        try:
            items = contents.get(current, [])
        except Exception:
            items = []

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
    return _json_ok(
        root=str(current),
        parent=str(parent) if parent is not None else None,
        directories=directories[:200],
        files=files[:200],
        total_dirs=len(directories),
        total_files=len(files),
    )


# =================【2. 后台全量】=================


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
    return _json_ok(message="全量扫描已启动", status=fullscan.status())


@app.get("/api/fullscan/status")
def api_fullscan_status():
    return _json_ok(status=fullscan.status())


# =================【3. 保存 / 撤销】=================


def _save_fullscan_result(auto):
    """从最近一次全量结果生成 C、D 各一份快照 + session 清单。"""
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
    any_saved = False
    any_skipped = False
    for root, item in roots_map.items():
        rows = item["rows"]
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
            raise ValueError(f"保存 {root} 快照失败: {exc}") from exc
        if saved_path is None:  # auto=True 被日配额谓词拒绝
            roots_payload[root] = {
                "root": root,
                "snapshot": None,
                "snapshot_path": None,
                "skipped": True,
                "skip_reason": "该根今天已自动保存过",
            }
            any_skipped = True
            continue
        roots_payload[root] = {
            "root": root,
            "snapshot": saved_path.name,
            "snapshot_path": str(saved_path),
            "skipped": False,
        }
        any_saved = True

    if not any_saved:
        raise ValueError("本次没有生成任何快照（可能因为今天已自动保存过）")

    session_payload = {
        "session_id": session_id,
        "auto": bool(auto),
        "machine_guid": machine_guid,
        "roots": roots_payload,
    }
    session_file = session.save_session(session_payload)
    fullscan.mark_saved(scan_version=scan_result.get("scan_version"))
    return {
        "session": session_payload,
        "session_file": str(session_file),
        "skipped": any_skipped,
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
    for root_info in latest.get("roots", {}).values():
        snapshot_path = root_info.get("snapshot_path")
        if not snapshot_path:
            continue
        path = Path(snapshot_path)
        try:
            if path.exists():
                path.unlink()
                deleted.append(str(path))
        except OSError as exc:
            errors.append(f"{snapshot_path}: {exc}")

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


@app.post("/api/compare")
def api_compare():
    data = request.get_json(silent=True) or {}
    raw_root = data.get("root")
    baseline_path = data.get("baseline")
    if not raw_root or not baseline_path:
        return _json_error("缺少 root 或 baseline 参数")
    baseline_file = Path(baseline_path)
    if not baseline_file.exists():
        return _json_error(f"基线快照不存在: {baseline_file}")

    if fullscan.is_running():
        return _json_error(
            "全量扫描进行中，请等待完成后再对比",
            status=409,
        )

    try:
        baseline = snapshots.load_snapshot(baseline_file)
    except Exception as exc:
        return _json_error(f"基线快照加载失败: {exc}", status=500)

    # 优先使用后台全量结果；没有就扫一次当前根。
    cached = fullscan.result(root=raw_root)
    if cached and cached.get("rows"):
        current_sizes = {
            Path(row["p"]): int(row["s"]) for row in cached["rows"]
        }
    else:
        try:
            with fullscan.GLOBAL_SCAN_LOCK:
                current_sizes, _unused = scan.scan_via_everything_sdk(Path(raw_root))
        except Exception as exc:
            return _json_error(f"当前扫描失败: {exc}", status=500)

    try:
        report = compare.diff_from_current(
            current_sizes,
            baseline.get("rows") or [],
            machine_guid=baseline.get("header", {}).get("machine_guid"),
            # P12·W1.2：Web 对比默认 leaf 口径——祖先行增量已由叶子承载，
            # 排行/图表不再把同一份增量在祖先与后代上重复呈现。
            leaf_only=True,
        )
    except compare.CompareError as exc:
        return _json_error(f"对比失败: {exc}", status=400)

    rows = compare.top_growth(report, 100)
    return _json_ok(
        report={
            "root": report["root"],
            "total_baseline": report["total_baseline"],
            "total_current": report["total_current"],
            "delta_total": report["delta_total"],
            "truncated": report["truncated"],
            # P12·W1.1/W1.2（additive）：基线含「已知异常大小」行数，前端出提示
            "legacy_count": int(report.get("legacy_count") or 0),
            "rows": rows,
        },
    )


# =================【5. 设置】=================


@app.route("/api/settings", methods=["GET", "POST"])
def api_settings():
    if request.method == "GET":
        return _json_ok(
            settings=env.load_config(),
            data_dir=str(datadir.get_data_dir()),
            snapshots_dir=str(datadir.get_snapshots_dir()),
        )
    data = request.get_json(silent=True) or {}
    config = env.load_config()
    config.update(data)
    if not env.save_config(config):
        return _json_error("设置保存失败，请检查数据目录是否可写", status=500)
    return _json_ok(settings=config, message="设置已保存")


# =================【6. 一键清空】=================


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


def run_server(port=5000, open_browser=True):
    """启动本地 Flask 服务（仅 127.0.0.1，threaded=True）。"""
    # 与 cli.main() 同款：把 stdout/stderr 重配置为 UTF-8，避免 GBK 控制台/管道下
    # log() 打印 emoji（ℹ️/🔎）抛 UnicodeEncodeError，从而污染 /api/health 的中文文案。
    _ensure_std_streams()
    utils._reconfigure_std_streams()
    TEMPLATE_DIR.mkdir(parents=True, exist_ok=True)
    STATIC_DIR.mkdir(parents=True, exist_ok=True)
    if open_browser:
        threading.Timer(
            0.8,
            lambda: webbrowser.open(f"http://127.0.0.1:{port}"),
        ).start()
    app.run(
        host="127.0.0.1",
        port=port,
        threaded=True,
        debug=False,
    )


if __name__ == "__main__":
    # 双击/直接运行默认自动打开浏览器；`--no-browser` 供打包冒烟测试使用。
    run_server(open_browser="--no-browser" not in sys.argv[1:])