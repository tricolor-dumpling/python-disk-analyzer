"""本地盘全量后台扫描调度模块（Phase 1）。

职责：
- 枚举本地盘符（Windows GetLogicalDrives，失败回退 A-Z 探测）；
- 后台线程依序调用 scan_via_everything_sdk 扫描每个根，按根缓存 rows；
- 全局扫描锁 GLOBAL_SCAN_LOCK：后台全量与前台浏览共用，防止 Everything SDK
  并发调用 DLL 重入；
- start()/status()/result()/is_running()/mark_saved() 供 Web 调用。

线程模型：单后台线程 + 串行扫描。start() 在已有扫描运行时返回 False。
"""

import ctypes
import os
import threading
from datetime import datetime
from pathlib import Path

from scan import scan_via_everything_sdk, ScanCancelledError
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
    """启动后台全量扫描。返回 True 表示已启动，False 表示已在运行或无盘可扫。

    roots 缺省时调用 _enumerate_roots()；测试可注入临时路径列表或假盘符。
    everything 透传给 scan_via_everything_sdk（测试注入假 SDK）。
    """
    with _STATE_LOCK:
        if _STATE["running"]:
            return False
        scan_version = _STATE["scan_version"] + 1
        if roots is None:
            roots = _enumerate_roots()
        else:
            roots = [Path(r) for r in roots]
        roots = [r for r in roots if str(r).strip()]
        if not roots:
            return False
        if _STATE["running"]:
            return False
        BROWSE_INDEX.clear()
        # P12·W2.10：新扫描前清取消位（停服事件不可跨扫描残留）
        CANCEL_EVENT.clear()
        # U3.2（D10）：新扫描前同时清用户停止位，并重置停止记录
        USER_STOP_EVENT.clear()
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
    return True


def _run(roots, everything, scan_version):
    """后台线程主函数：串行扫描每个根并更新进度。"""
    result_roots = {}
    error = None
    cancelled = False
    try:
        with GLOBAL_SCAN_LOCK:
            for index, root in enumerate(roots):
                _update_state(
                    current_root=str(root),
                    roots_done=index,
                )
                # P12·W2.10：透传取消事件（停服时协作取消，不硬杀线程）
                # U3.2（D10）：用户停止与停服取消共用组合取消源（语义区分在 stop_reason）
                sizes, _unused_contents = scan_via_everything_sdk(
                    root, everything=everything,
                    cancel_event=_CancelOr(CANCEL_EVENT, USER_STOP_EVENT),
                )
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
            error=error,
            cancelled=cancelled,
            scan_finished_at=_now_iso(),
            last_result=last_result,
        )


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