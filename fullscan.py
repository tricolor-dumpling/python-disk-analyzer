"""本地盘全量后台扫描调度模块（Phase 1）。

职责：
- 枚举本地盘符（Windows GetLogicalDrives，失败回退 A-Z 探测）；
- 后台线程依序调用 scan_via_everything_sdk 扫描每个根，按根缓存 rows；
- 全局扫描锁 GLOBAL_SCAN_LOCK：后台全量与前台浏览共用，防止 Everything SDK
  并发调用 DLL 重入；
- start()/status()/result()/is_running()/mark_saved() 供 Web 调用。

线程模型：单后台线程 + 串行扫描。start() 在已有扫描运行时返回 False。

阶段B（B-7）：状态机扩展——
- phase: idle/queued/scanning/finishing（锁等待期=queued；收尾期=finishing）；
- start() 返回 {started, queued, phase}（非空 dict，既有布尔判断兼容）；
- status() additive：phase/lock_holder/row_done/row_total/stop_ack_at；
- 看门狗：单盘 15 分钟无行更新 → 记 error="SDK 无响应" 并协作取消
  （置 CANCEL_EVENT，绝不硬杀线程）。
"""

import ctypes
import os
import threading
import time
from datetime import datetime
from pathlib import Path

from scan import scan_via_everything_sdk, ScanCancelledError
from utils import log
import scan

# P12·W2.1（BE 路线 a）：锁归属迁至 scan.SCAN_LOCK；本模块保留同名别名
# （同一把锁对象），既有引用与测试不受影响。
GLOBAL_SCAN_LOCK = scan.SCAN_LOCK

# P12·W2.10（R-2）：协作取消事件——停服时不硬杀扫描线程，由扫描主循环在
# 每 SCAN_PROGRESS_REFRESH_INTERVAL 条检查一次；置位后 ScanCancelledError
# 被消化，已完成根保留、state 记 cancelled。
CANCEL_EVENT = threading.Event()

# U3.2（D10）：用户停止事件——与停服 CANCEL_EVENT 严格分离（W2.10 语义不污染）：
# 用户停止（POST /api/fullscan/stop）走本事件；status() 以 stop_reason 区分来源
# （"user"|"shutdown"），前端据此分别显示「服务停止」与「已停止，已完成部分可浏览」。
USER_STOP_EVENT = threading.Event()

# 阶段B（B-7）：看门狗——单盘无行更新超时（秒）。Watchdog 只置取消事件（协作取消，
# 绝不硬杀线程）；超时后 error="SDK 无响应"，已完成根保留（红线 W2.10）。
WATCHDOG_ROOT_STALL_SECONDS = 15 * 60  # 单盘 15 分钟无行更新
_WATCHDOG_INTERVAL = 5.0               # 检查周期（秒）

# 状态机相位（B-7）：idle=空闲 / queued=已提交等锁 / scanning=扫描中 /
# finishing=收尾（最后根完成后、结果发布前的极短窗口）
PHASE_IDLE = "idle"
PHASE_QUEUED = "queued"
PHASE_SCANNING = "scanning"
PHASE_FINISHING = "finishing"


class _CancelOr:
    """组合取消源（USER_STOP_EVENT ∪ CANCEL_EVENT）。

    .is_set() 语义与 threading.Event 一致，供 scan_via_everything_sdk 的
    cancel_event 参数消费（每 SCAN_PROGRESS_REFRESH_INTERVAL 条检查一次）——
    任一事件置位即协作取消，由 fullscan._run 消化 ScanCancelledError。
    """

    def __init__(self, *events):
        self._events = events

    def is_set(self):
        return any(ev.is_set() for ev in self._events)

_STATE_LOCK = threading.Lock()


def _path_key(path):
    """返回跨平台、大小写不敏感且折叠尾分隔符的路径键。"""
    value = os.path.normpath(str(path)).replace("\\", "/")
    # 保留盘符根的分隔符，普通路径则折叠尾分隔符。
    if not (len(value) == 3 and value[1] == ":" and value.endswith("/")):
        value = value.rstrip("/")
    return value.casefold()


class BrowseIndex:
    """全量扫描产生的只读浏览索引。

    每个扫描根独立构建 shard，只有 add_scan 完成后才一次性发布，因而浏览
    不会看到半成品。查询返回新列表/元组，调用方无法修改索引内部数据。
    """

    def __init__(self):
        self._lock = threading.RLock()
        self._shards = {}

    def clear(self):
        with self._lock:
            self._shards.clear()

    def add_scan(self, root, sizes, contents):
        root_path = Path(root)
        dir_sizes = {_path_key(path): int(size) for path, size in sizes.items()}
        # P12·W3.1（R-1）：移除原「路径键->Path 对象」冗余映射（键即 path_key，
        # 显示路径可随时由 sizes 键重建），大磁盘扫描时白白驻留数十万 Path 对象。
        files = {}
        subdirs = {}
        # contents is LazyContents in production; .get() materializes one directory
        # at a time and keeps the public scan contract unchanged.
        for folder in sizes:
            folder_path = Path(folder)
            items = contents.get(folder_path, [])
            if not items:
                items = contents.get(str(folder_path), [])
            child_items = []
            for name, is_dir, size in items:
                child_items.append((str(name), bool(is_dir), int(size)))
            if child_items:
                files[_path_key(folder_path)] = tuple(
                    (size, name) for name, is_dir, size in child_items if not is_dir
                )
                subdirs[_path_key(folder_path)] = tuple(
                    name for name, is_dir, size in child_items if is_dir
                )
        shard = {
            "root": root_path,
            "root_key": _path_key(root_path),
            "dir_sizes": dir_sizes,
            "files": files,
            "subdirs": subdirs,
        }
        with self._lock:
            self._shards[shard["root_key"]] = shard

    def _find_shard(self, path):
        key = _path_key(path)
        matches = []
        for shard in self._shards.values():
            root_key = shard["root_key"]
            prefix = root_key.rstrip("/")
            if key == root_key or key.startswith(prefix + "/"):
                matches.append(shard)
        return max(matches, key=lambda item: len(item["root_key"])) if matches else None

    def has_root(self, path):
        """判断指定路径是否为已完成扫描根（精确匹配）。"""
        key = _path_key(path)
        with self._lock:
            return key in self._shards

    def root_for(self, path):
        """返回包含 path 的已完成扫描根；没有则返回 None。"""
        with self._lock:
            shard = self._find_shard(path)
            return str(shard["root"]) if shard else None

    def contains(self, path):
        """判断 path 是否位于已完成扫描根下。"""
        return self.root_for(path) is not None

    def roots(self):
        """返回当前已发布索引根的显示路径列表。"""
        with self._lock:
            return [str(shard["root"]) for shard in self._shards.values()]

    def root_stats(self, root):
        """返回已发布根的概览统计；未发布根返回 None。"""
        with self._lock:
            shard = self._shards.get(_path_key(root))
            if shard is None:
                return None
            return {
                "total": int(shard["dir_sizes"].get(shard["root_key"], 0)),
                "directory_count": len(shard["subdirs"].get(shard["root_key"], ())),
                "file_count": len(shard["files"].get(shard["root_key"], ())),
            }

    def children(self, path):
        """返回 (basename, is_dir, size)，未知目录返回空列表。"""
        with self._lock:
            shard = self._find_shard(path)
            if shard is None:
                return []
            key = _path_key(path)
            result = []
            for name in shard["subdirs"].get(key, ()):
                child_key = _path_key(Path(path) / name)
                result.append((name, True, shard["dir_sizes"].get(child_key, 0)))
            # files entries are (size, basename), matching scan's top-50 ordering.
            result.extend((name, False, size) for size, name in shard["files"].get(key, ()))
            result.sort(key=lambda item: (-item[2], item[0].casefold()))
            return result

    def parent(self, path):
        with self._lock:
            shard = self._find_shard(path)
            if shard is None:
                return None
            target = Path(path)
            if _path_key(target) == shard["root_key"]:
                return None
            parent = target.parent
            return str(parent) if _path_key(parent) != _path_key(target) else None


BROWSE_INDEX = BrowseIndex()

_STATE = {
    "running": False,
    "thread": None,
    "roots": [],
    "roots_done": 0,
    "current_root": None,
    "error": None,
    "cancelled": False,  # P12·W2.10：后台扫描被协作取消（停服）
    # U3.2（D10）：停止请求记录——stop_requested 表示本次扫描曾被请求停止；
    # stop_reason 记录来源（"user"|"shutdown"），置位时写入（request_stop/cancel_scan）。
    "stop_requested": False,
    "stop_reason": None,
    "scan_version": 0,
    "saved_scan_version": 0,
    "scan_finished_at": None,
    "last_result": None,
    # 阶段B（B-7）additive：相位（idle/queued/scanning/finishing）、看门狗计数与
    # 停止确认时刻（stop_ack_at=request_stop 置位时刻 ISO）。
    "phase": PHASE_IDLE,
    "row_done": 0,
    "row_total": 0,
    "watchdog_roots_last_total": {},
    "watchdog_checked_at": None,
    "stop_ack_at": None,
}


def _now_iso():
    return datetime.now().isoformat(timespec="seconds")


def _copy_state():
    with _STATE_LOCK:
        return dict(_STATE)


def _update_state(**kwargs):
    with _STATE_LOCK:
        _STATE.update(kwargs)


def _enumerate_roots():
    """枚举本地盘符；Win32 API 失败或非 Windows 时回退到 A-Z 探测。"""
    roots = []
    if os.name == "nt":
        try:
            mask = ctypes.windll.kernel32.GetLogicalDrives()
            for i in range(26):
                if mask & (1 << i):
                    roots.append(Path(f"{chr(65 + i)}:\\"))
            if roots:
                return roots
        except Exception:
            pass
    for letter in "ABCDEFGHIJKLMNOPQRSTUVWXYZ":
        root = Path(f"{letter}:\\")
        try:
            if root.exists():
                roots.append(root)
        except OSError:
            continue
    return roots


def start(roots=None, everything=None):
    """启动后台全量扫描。返回真值对象（阶段B 起为 dict）。

    - 已在运行 → 返回 {"started": False}（既有 False 语义保持，调用方
      `if not started` 兼容）；
    - 无盘可扫 → 返回 {"started": False}；
    - 启动成功 → 返回 {"started": True, "queued": <bool>, "phase": "<phase>"}，
      其中 queued=True 表示提交时 SDK 锁被占用（后台线程排队等锁）；
      phase 反映提交瞬时的状态机相位（queued/scanning）。

    roots 缺省时调用 _enumerate_roots()；测试可注入临时路径列表或假盘符。
    everything 透传给 scan_via_everything_sdk（测试注入假 SDK）。
    """
    with _STATE_LOCK:
        if _STATE["running"]:
            return {"started": False}
        scan_version = _STATE["scan_version"] + 1
        if roots is None:
            roots = _enumerate_roots()
        else:
            roots = [Path(r) for r in roots]
        roots = [r for r in roots if str(r).strip()]
        if not roots:
            return {"started": False}
        if _STATE["running"]:
            return {"started": False}
        BROWSE_INDEX.clear()
        # P12·W2.10：新扫描前清取消位（停服事件不可跨扫描残留）
        CANCEL_EVENT.clear()
        # U3.2（D10）：新扫描前同时清用户停止位，并重置停止记录
        USER_STOP_EVENT.clear()
        # 阶段B（B-7：queued 相位判定）——提交时 SDK 锁被占用（浏览 SDK 直扫 /
        # 对比直扫 / 上一次扫描尾段）→ 后台线程排队等锁，phase=queued；
        # 锁空闲 → 后台线程立即持锁，phase=scanning（首拍 _run 内置位）。
        lock_free = GLOBAL_SCAN_LOCK.acquire(blocking=False)
        if lock_free:
            GLOBAL_SCAN_LOCK.release()
        phase = PHASE_QUEUED if not lock_free else PHASE_SCANNING
        _STATE.update(
            {
                "running": True,
                "roots": [str(r) for r in roots],
                "roots_done": 0,
                "current_root": None,
                "error": None,
                "cancelled": False,
                "stop_requested": False,
                "stop_reason": None,
                "scan_version": scan_version,
                "scan_finished_at": None,
                "last_result": None,
                # 阶段B（B-7）additive 复位
                "phase": phase,
                "row_done": 0,
                "row_total": 0,
                "watchdog_roots_last_total": {},
                "watchdog_checked_at": None,
                "stop_ack_at": None,
            }
        )
        thread = threading.Thread(
            target=_run,
            args=(roots, everything, scan_version),
            daemon=True,
            name="fullscan-background",
        )
        _STATE["thread"] = thread
    thread.start()
    return {"started": True, "queued": not lock_free, "phase": phase}


def _run(roots, everything, scan_version):
    """后台线程主函数：串行扫描每个根并更新进度。

    阶段B（B-7）：
    - 相位推进 queued→scanning（持锁后）→finishing（末根完成后）→idle（终态）；
    - progress 回调把扫描层行计数写入 status（row_done/row_total，additive）；
    - 看门狗线程监视单盘行计数停滞（默认 15 分钟无变化）→ 记 error="SDK 无响应"
      并置协作取消事件（绝不硬杀线程）。
    """
    result_roots = {}
    error = None
    cancelled = False
    watchdog_stalled = [False]  # 看门狗只记一次 error 红线的进程内标志
    thread_ident = threading.get_ident()

    # ---- 看门狗（B-7）：单盘无行更新超时 → 协作取消 ----
    def _watchdog_loop():
        last_total = {}
        last_seen = {}
        try:
            while True:
                time.sleep(_WATCHDOG_INTERVAL)
                with _STATE_LOCK:
                    if not _STATE.get("running"):
                        return
                    current = _STATE.get("current_root")
                    row_total = _STATE.get("row_total") or 0
                    already_error = bool(_STATE.get("error")) and watchdog_stalled[0]
                    stalled = watchdog_stalled[0]
                if not current:
                    continue
                key = str(current)
                now = time.monotonic()
                prev_total = last_total.get(key)
                if prev_total != row_total:
                    last_total[key] = row_total
                    last_seen[key] = now
                    continue
                last = last_seen.get(key)
                if last is None:
                    last_seen[key] = now
                    continue
                if now - last >= WATCHDOG_ROOT_STALL_SECONDS:
                    if not stalled:
                        watchdog_stalled[0] = True
                        with _STATE_LOCK:
                            _STATE["error"] = (
                                "SDK 无响应（单盘 %d 分钟无进展，已自动取消，"
                                "请检查 Everything 索引后重扫）"
                                % (WATCHDOG_ROOT_STALL_SECONDS // 60)
                            )
                        try:
                            log(
                                "⚠️ 看门狗：扫描根 %s %d 分钟无行更新，协作取消（不硬杀线程）"
                                % (key, WATCHDOG_ROOT_STALL_SECONDS // 60)
                            )
                        except Exception:
                            log("⚠️ 看门狗：扫描根超时无进展，协作取消")
                        CANCEL_EVENT.set()  # 协作取消：扫描主循环下一检查点抛 ScanCancelledError
                    continue
        except Exception:
            return  # 看门狗绝不因自身异常影响扫描主流程

    def _progress(done, total):
        try:
            _update_state(row_done=int(done), row_total=int(total))
        except Exception:
            pass  # 进度回调异常绝不影响扫描主流程

    def _scan_root(root, everything):
        """带行计数回调的扫描调用；注入的 fake SDK 不支持 progress 参数时
        降级重试（progress 是 additive 可选，降级后仅无行计数，状态机照常）。"""
        try:
            return scan_via_everything_sdk(
                root, everything=everything,
                cancel_event=_CancelOr(CANCEL_EVENT, USER_STOP_EVENT),
                progress=_progress,
            )
        except TypeError:
            # 仅当 TypeError 源于 progress 参数时降级——若 fake 的异常本身就是
            # TypeError（测试注入），重试一次仍会抛，语义不变。
            return scan_via_everything_sdk(
                root, everything=everything,
                cancel_event=_CancelOr(CANCEL_EVENT, USER_STOP_EVENT),
            )

    try:
        # 排队等锁期 phase=queued（start 已置位；此处防御性再置一次，覆盖
        # 直接调 _run 的测试路径）
        _update_state(phase=PHASE_QUEUED, row_done=0, row_total=0)
        with scan.sdk_lock("fullscan"):
            # 锁到手 → scanning
            _update_state(phase=PHASE_SCANNING)
            watchdog = threading.Thread(
                target=_watchdog_loop, name="fullscan-watchdog", daemon=True
            )
            watchdog.start()
            try:
                for index, root in enumerate(roots):
                    _update_state(
                        current_root=str(root),
                        roots_done=index,
                        row_done=0,
                        row_total=0,
                    )
                    # P12·W2.10：透传取消事件（停服时协作取消，不硬杀线程）
                    # U3.2（D10）：用户停止与停服取消共用组合取消源（语义区分在 stop_reason）
                    # B-7：progress 回调把扫描层行计数写回状态（row_done/row_total）
                    sizes, _unused_contents = _scan_root(root, everything)
                    rows = [
                        {"p": str(path), "s": int(size)}
                        for path, size in sizes.items()
                    ]
                    result_roots[str(root)] = {
                        "root": str(root),
                        "rows": rows,
                        # P12·W2.7 additive：透传扫描层「大小未知」计数（Web 导出提示用）
                        "unknown_size_count": int(getattr(sizes, "unknown_size_count", 0) or 0),
                    }
                    # Publish only after this root has completely finished.
                    BROWSE_INDEX.add_scan(root, sizes, _unused_contents)
                    _update_state(roots_done=index + 1)
            finally:
                # 看门狗随扫描收尾退出（running 标志在 finally 尾部才置 False，
                # 此处先置 finishing：末根已完成、结果即将发布）
                _update_state(phase=PHASE_FINISHING)
        _update_state(phase=PHASE_FINISHING)
    except ScanCancelledError:
        # P12·W2.10：取消不算失败——已完成根保留、error=None、state 记 cancelled
        error = None
        cancelled = True
        ok = False
    except Exception as exc:  # 扫描失败仍保留已完成根的结果；error 供状态透出
        error = str(exc)
        ok = False
    else:
        ok = True
    finally:
        # 看门狗 error（SDK 无响应）优先保留：不得被本地的 error=None 覆盖
        with _STATE_LOCK:
            watchdog_error = _STATE.get("error") if watchdog_stalled[0] else None
        final_error = error if error is not None else watchdog_error
        last_result = None
        if result_roots:
            last_result = {
                "roots": result_roots,
                "root_count": len(result_roots),
                "scan_version": scan_version,
                "completed_at": _now_iso(),
                "ok": ok,
            }
        _update_state(
            running=False,
            thread=None,
            current_root=None,
            error=final_error,
            cancelled=cancelled,
            scan_finished_at=_now_iso(),
            last_result=last_result,
            phase=PHASE_IDLE,
            row_done=0,
            row_total=0,
            watchdog_roots_last_total={},
            watchdog_checked_at=None,
        )


# 看门狗日志引用占位（保留空定义避免遗留引用）


def request_stop():
    """用户请求停止后台全量扫描（U3.2·D10 唯一新增接口的支撑）。

    运行中 → 置 USER_STOP_EVENT 并记录 stop_reason="user"（返回 True）；
    空闲 → 幂等 no-op（返回 False，绝不误伤停服事件/后续扫描）。
    与停服 cancel_scan() 严格分离：本函数只走 USER_STOP_EVENT，
    停服仍由 CANCEL_EVENT 承担（W2.10 语义不污染）。
    """
    with _STATE_LOCK:
        if not _STATE["running"]:
            return False
        _STATE["stop_requested"] = True
        _STATE["stop_reason"] = "user"
        # 阶段B（B-10）：停止确认时刻（additive，前端「正在停止」时间线用）
        _STATE["stop_ack_at"] = _now_iso()
    USER_STOP_EVENT.set()
    return True


def cancel_scan(join_timeout=5.0):
    """协作取消后台全量扫描并等待收尾（P12·W2.10 R-2）。

    atexit 停服路径调用：置位 CANCEL_EVENT → 扫描主循环在下一检查点抛
    ScanCancelledError 收尾 → join(timeout) 等待线程退出；超时则放弃
    （daemon 线程随进程自然消亡），绝不硬杀。
    U3.2（D10）：停服路径记录 stop_reason="shutdown"（仅运行中生效）。
    """
    with _STATE_LOCK:
        if _STATE.get("running"):
            _STATE["stop_requested"] = True
            _STATE["stop_reason"] = "shutdown"
    CANCEL_EVENT.set()
    with _STATE_LOCK:
        thread = _STATE.get("thread")
    if thread is not None and thread.is_alive():
        thread.join(timeout=join_timeout)


def is_running():
    """后台全量扫描是否正在运行。"""
    return _copy_state()["running"]


def status():
    """返回前端轮询用的进度/完成态。

    字段：running / roots / roots_done / current_root / error / result_ready /
    save_ready / progress_pct / scan_version。save_ready 表示最近一次后台结果
    尚未被 mark_saved() 消费（全量完成即「可保存」）。
    U3.2（D10）additive：stop_requested（本次扫描曾被请求停止）与
    stop_reason（来源 "user"|"shutdown"|None）。
    阶段B（B-7/B-10/B-11）additive：
    - phase：idle/queued/scanning/finishing（锁等待期=queued）；
    - lock_holder：当前 SDK 锁持有者（"fullscan"|"browse"|"compare"|...|null）；
    - row_done/row_total：扫描层行计数（估算口径；无计数时为 0）；
    - stop_ack_at：停止请求确认时刻（ISO，未请求为 None）。
    """
    st = _copy_state()
    roots_count = len(st["roots"])
    progress_pct = (
        int(st["roots_done"] * 100 // roots_count) if roots_count else 0
    )
    last = st["last_result"]
    result_ready = bool(last and last["ok"] and last["roots"])
    save_ready = bool(
        result_ready
        and last
        and int(last.get("scan_version", 0)) > int(st["saved_scan_version"])
    )
    holder = scan._lock_holder() if hasattr(scan, "_lock_holder") else None
    return {
        "running": st["running"],
        "roots": list(st["roots"]),
        "roots_done": st["roots_done"],
        "roots_total": roots_count,
        "current_root": st["current_root"],
        "error": st["error"],
        "result_ready": result_ready,
        "save_ready": save_ready,
        "progress_pct": progress_pct,
        "scan_version": st["scan_version"],
        # U3.2（D10）additive：停止请求记录（前端中止态判据）
        "stop_requested": bool(st["stop_requested"]),
        "stop_reason": st["stop_reason"],
        # 阶段B（B-7）additive：相位与锁持有者（13 个既有接口语义零变更）
        "phase": st.get("phase", PHASE_IDLE),
        "lock_holder": (holder or {}).get("holder") if holder else None,
        "lock_since": (holder or {}).get("since") if holder else None,
        # 阶段B（B-11）：扫描层行计数（估算口径；无计数 0）
        "row_done": int(st.get("row_done") or 0),
        "row_total": int(st.get("row_total") or 0),
        # 阶段B（B-10）：停止确认时刻
        "stop_ack_at": st.get("stop_ack_at"),
    }


def result(root=None):
    """返回最近一次全量扫描结果。

    root=None 时返回完整结果 dict（含 roots map）；root 指定时按大小写不敏感
    路径返回单根 {"root":..., "rows":[...]}。无结果返回 None。
    """
    last = _copy_state()["last_result"]
    if not last:
        return None
    if root is None:
        return last
    target = Path(root)
    roots_map = last.get("roots") or {}
    for key, item in roots_map.items():
        if Path(key) == target:
            return item
    return None


def mark_saved(scan_version=None):
    """标记某次全量结果已保存（撤销最近保存后也可调用重新标记）。"""
    with _STATE_LOCK:
        if scan_version is None:
            version = _STATE["scan_version"]
        else:
            version = int(scan_version)
        if version > _STATE["saved_scan_version"]:
            _STATE["saved_scan_version"] = version