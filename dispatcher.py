"""Everything 查询统一调度器（D3）。

把 Everything SDK 的阻塞查询统一收敛到单一执行线程，解决「查询入口散落各处、
多线程并发触发 SDK 阻塞调用」的问题：

- 进程内并发 = 1：同一时刻只执行一个 SDK 阻塞查询，其余进入有界队列（默认 32，
  满则抛异常）；
- 250ms 防抖：相同 search 在窗口内重复提交时合并，共享同一次执行，不重复查询 SDK；
- 代际令牌：每次实际执行 SDK 查询分配自增代数，提交方只接受自己代数对应的结果，
  被取消/过期的慢查询结果直接丢弃，绝不污染其它提交方；
- 统一错误码：Everything_QueryW 返回 0 时读 Everything_GetLastError()，抛
  DispatcherError（携带 error_code 属性）；
- 线程安全：全部共享状态由一把 threading.Condition 保护，跨线程可提交查询，
  冲突路径无忙等（阻塞等待全部走 Condition.wait）；
- 红线：本调度器不提供任何「强制重建 Everything 索引」类方法。

依赖：仅标准库 + sdk 模块（sdk 提供 Win32 常量与默认 SDK 模块注入点）。
Python 3.9+ 兼容；不引入第三方依赖。
"""

import ctypes
import threading
import time
from collections import deque
from concurrent.futures import CancelledError, Future

import sdk


__all__ = [
    "CancelledError",
    "DEFAULT_REQUEST_FLAGS",
    "DispatcherError",
    "EverythingQueryDispatcher",
]

# 默认请求标志：完整路径 + 文件大小，保证返回行含 path 与 size 字段。
DEFAULT_REQUEST_FLAGS = (
    sdk.EVERYTHING_REQUEST_FULL_PATH_AND_FILE_NAME | sdk.EVERYTHING_REQUEST_SIZE
)

# 请求内部状态
_PENDING = "pending"
_RUNNING = "running"
_DONE = "done"
_FAILED = "failed"
_CANCELLED = "cancelled"


class DispatcherError(RuntimeError):
    """调度器统一错误。SDK 查询失败时携带 Everything 错误码（error_code:int）。

    队列满、调度器已关闭等非 SDK 失败也复用本异常，此时 error_code 为 None。
    """

    def __init__(self, message, error_code=None):
        super().__init__(message)
        self.error_code = error_code


class _Request:
    """一次（按 search 去重合并后的）实际 SDK 执行单元。

    多个提交方可能因 250ms 防抖共享同一个 _Request：它们各自的 Future 都挂在
    futures 上，执行完成后统一投递同一份结果；代际令牌（generation）在真正
    执行前由调度器分配，用于区分先后两次不同执行。
    """

    def __init__(self, search, request_flags, submitted_at):
        self.search = search
        self.request_flags = request_flags
        self.submitted_at = submitted_at
        self.generation = 0  # 执行时由调度器分配自增代数
        self.state = _PENDING
        self.cancelled = False
        self.futures = []  # 共享本次执行的全部提交方
        self.result = None
        self.error = None

    @property
    def pending(self):
        """仍可共享执行（排队中/执行中且未被取消）。"""
        return self.state in (_PENDING, _RUNNING) and not self.cancelled

    def terminal_outcome(self):
        """终态快照 (kind, payload)，kind ∈ {'result','error','cancelled'}；非终态返回 None。"""
        if self.state == _DONE:
            return ("result", self.result)
        if self.state == _FAILED:
            return ("error", self.error)
        if self.state == _CANCELLED or self.cancelled:
            return ("cancelled", None)
        return None


class EverythingQueryDispatcher:
    """线程安全的 Everything 查询统一调度器。

    参数：
    - sdk_module：默认注入 sdk 模块；测试可替换为模拟 DLL 接口的 MockSDK
      （直接暴露 Everything_SetSearchW/Everything_SetRequestFlags/
      Everything_QueryW/Everything_GetNumResults/... 方法）。当注入对象不含
      Everything_QueryW 时按 sdk 模块处理：调用其 load_everything_sdk 加载真实 DLL。
    - queue_size：有界队列容量（默认 32），满时提交抛 DispatcherError。
    - debounce_seconds：防抖窗口（默认 0.25 秒）。
    """

    DEFAULT_QUEUE_SIZE = 32
    DEFAULT_DEBOUNCE_SECONDS = 0.25

    def __init__(
        self,
        sdk_module=None,
        queue_size=DEFAULT_QUEUE_SIZE,
        debounce_seconds=DEFAULT_DEBOUNCE_SECONDS,
    ):
        if queue_size < 1:
            raise ValueError("queue_size 必须 >= 1")
        if debounce_seconds < 0:
            raise ValueError("debounce_seconds 不能为负")
        self._sdk_module = sdk if sdk_module is None else sdk_module
        self._dll = None  # 惰性解析后的 DLL/模拟对象
        self._queue_size = int(queue_size)
        self._debounce_seconds = float(debounce_seconds)
        self._cond = threading.Condition()
        self._queue = deque()  # 待执行的 _Request（FIFO）
        self._debounce = {}  # search -> _Request（防抖合并表）
        self._generation = 0  # 代际令牌计数器
        self._in_flight = None  # 正在执行的 _Request（或无）
        self._shutdown = False
        self._worker = threading.Thread(
            target=self._run,
            name="everything-query-dispatcher",
            daemon=True,
        )
        self._worker.start()

    # =================【公开 API】=================

    def query(self, search, request_flags=None):
        """同步阻塞查询，返回结果行列表（每行含 path/size/is_folder/is_volume）。

        内部基于 query_async，失败时抛 DispatcherError（带 error_code）。
        """
        return self.query_async(search, request_flags=request_flags).result()

    def query_async(self, search, request_flags=None):
        """异步提交查询，立即返回 concurrent.futures.Future。

        相同 search 在防抖窗口内重复提交时合并共享同一次执行（Future.result()
        得到同一份结果）；窗口过后或队列满时成为独立请求（满则抛 DispatcherError）。
        """
        if not isinstance(search, str):
            raise TypeError("search 必须是 str")
        if request_flags is not None and not isinstance(request_flags, int):
            raise TypeError("request_flags 必须是 int 或 None")

        future = Future()
        outcome = None  # 仅当合并目标已终态时携带 (kind, payload)
        with self._cond:
            if self._shutdown:
                raise DispatcherError("调度器已关闭，无法提交新查询")
            now = time.monotonic()
            self._prune_debounce_locked(now)
            entry = self._debounce.get(search)
            if entry is not None and (now - entry.submitted_at) <= self._debounce_seconds:
                if entry.pending:
                    entry.futures.append(future)
                else:
                    outcome = entry.terminal_outcome()
                    if outcome is None:  # 理论不可达：防御性回退为共享执行
                        entry.futures.append(future)
            else:
                if len(self._queue) >= self._queue_size:
                    raise DispatcherError(
                        f"查询队列已满（容量 {self._queue_size}），请稍后重试"
                    )
                entry = _Request(search, request_flags, submitted_at=now)
                entry.futures.append(future)
                self._queue.append(entry)
                self._debounce[search] = entry
                self._cond.notify()
        if outcome is not None:
            self._deliver(future, outcome)
        return future

    def cancel_all(self):
        """取消全部排队与在途请求；各提交方的 Future 立即变为 CancelledError。

        在途的阻塞 SDk 调用无法被中断：其结果的代际与请求失配后将被丢弃。
        """
        futures_to_cancel = []
        with self._cond:
            self._debounce.clear()
            queued = list(self._queue)
            self._queue.clear()
            for request in queued:
                if request.pending:
                    request.cancelled = True
                    request.state = _CANCELLED
                    futures_to_cancel.extend(request.futures)
                    request.futures = []
            in_flight = self._in_flight
            if in_flight is not None and not in_flight.cancelled:
                in_flight.cancelled = True
                futures_to_cancel.extend(in_flight.futures)
                in_flight.futures = []
        for future in futures_to_cancel:
            future.cancel()

    def shutdown(self, wait=True):
        """停止调度器：不再接受新查询，并（wait=True 时）等待工作线程退出。

        已排队的请求会继续按序执行完（优雅排空）；如需立即丢弃排队请求请先
        cancel_all()。幂等，可重复调用。
        """
        with self._cond:
            if not self._shutdown:
                self._shutdown = True
                self._cond.notify_all()
        if wait:
            worker = self._worker
            if worker is not None and worker.is_alive() and worker is not threading.current_thread():
                worker.join()

    # =================【内部实现】=================

    def _run(self):
        """单一工作线程：串行取队列、分配代际、执行阻塞 SDK 查询、投递结果。"""
        while True:
            with self._cond:
                while not self._queue and not self._shutdown:
                    self._cond.wait()
                if not self._queue:
                    break  # 已关闭且队列排空
                self._prune_debounce_locked()
                request = self._queue.popleft()
                if request.cancelled:
                    continue
                self._generation += 1
                request.generation = self._generation
                request.state = _RUNNING
                self._in_flight = request

            # 锁外执行阻塞 SDK 查询（不占用锁，避免阻塞其它提交方）
            result, error = self._execute_safely(request)

            with self._cond:
                self._in_flight = None
                if request.cancelled:
                    # 代际令牌：被取消的慢查询结果到达时直接丢弃，绝不投递
                    continue
                if error is not None:
                    request.state = _FAILED
                    request.error = error
                else:
                    request.state = _DONE
                    request.result = result
                futures = list(request.futures)
                request.futures = []

            # 锁外投递，避免 Future 回调重入调度器时死锁
            for future in futures:
                if error is not None:
                    future.set_exception(error)
                else:
                    future.set_result(result)

    def _execute_safely(self, request):
        result = None
        error = None
        try:
            result = self._execute(request.search, request.request_flags)
        except Exception as exc:  # 含 DispatcherError 与 DLL 丢弃的各类异常
            error = exc
        return result, error

    def _execute(self, search, request_flags):
        """执行一次 Everything 阻塞查询，返回结果行列表。"""
        everything = self._everything()
        everything.Everything_SetSearchW(search)
        everything.Everything_SetRequestFlags(
            DEFAULT_REQUEST_FLAGS if request_flags is None else request_flags
        )
        if not everything.Everything_QueryW(True):
            code = everything.Everything_GetLastError()
            raise DispatcherError(
                f"Everything 查询失败：{search!r}（错误码 {code}）",
                error_code=code,
            )
        num_results = everything.Everything_GetNumResults()
        rows = []
        for index in range(num_results):
            buffer = ctypes.create_unicode_buffer(sdk.FULL_PATH_BUFFER_CHARS)
            everything.Everything_GetResultFullPathNameW(
                index, buffer, sdk.FULL_PATH_BUFFER_CHARS
            )
            path = buffer.value
            size = ctypes.c_ulonglong()
            everything.Everything_GetResultSize(index, size)
            rows.append(
                {
                    "path": path if isinstance(path, str) else "",
                    "size": int(size.value),
                    "is_folder": bool(everything.Everything_IsFolderResult(index)),
                    "is_volume": bool(everything.Everything_IsVolumeResult(index)),
                }
            )
        return rows

    def _everything(self):
        """惰性解析底层 DLL：注入对象自带 Everything_QueryW 则直用，否则按 sdk 模块加载。"""
        dll = self._dll
        if dll is None:
            mod = self._sdk_module
            if callable(getattr(mod, "Everything_QueryW", None)):
                dll = mod
            else:
                dll = mod.load_everything_sdk(mod.DLL_PATH, include_result_functions=True)
            self._dll = dll
        return dll

    def _prune_debounce_locked(self, now=None):
        """清理防抖表中已出窗口的条目（锁内调用）。"""
        if now is None:
            now = time.monotonic()
        cutoff = now - self._debounce_seconds
        stale = [key for key, req in self._debounce.items() if req.submitted_at < cutoff]
        for key in stale:
            del self._debounce[key]

    @staticmethod
    def _deliver(future, outcome):
        """按终态快照投递结果（锁外调用）。"""
        kind, payload = outcome
        if kind == "result":
            future.set_result(payload)
        elif kind == "error":
            future.set_exception(payload)
        elif kind == "cancelled":
            future.cancel()