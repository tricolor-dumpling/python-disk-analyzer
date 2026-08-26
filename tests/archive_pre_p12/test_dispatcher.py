"""dispatcher 模块单元测试：EverythingQueryDispatcher 统一查询调度器。

通过注入 MockSDK（模拟 Everything SDK DLL 接口）驱动全部逻辑分支，跨平台可跑、
不依赖真实 Everything 进程/DLL：
- 串行：单工作线程，QueryW 从不同时并发（max_active 计数）；
- 防抖：同 search 破窗内合并、破窗外新建第二次 QueryW；
- 代际：A 慢查询执行中提交 B，各自结果互不污染；
- 队列满：超过容量抛 DispatcherError；
- 查询失败：QueryW=0 时抛带 error_code 的 DispatcherError；
- 空结果：返回空列表；
- 取消/关闭/行契约/请求标志/多线程压力等补充用例。
"""

import threading
import time
import unittest
from concurrent.futures import CancelledError

import sdk
from dispatcher import DEFAULT_REQUEST_FLAGS, DispatcherError, EverythingQueryDispatcher


def _row(path, size=0, is_folder=False, is_volume=False):
    """构造 MockSDK 用的单条结果行。"""
    return {
        "path": path,
        "size": size,
        "is_folder": is_folder,
        "is_volume": is_volume,
    }


class MockSDK:
    """模拟 Everything SDK DLL 接口，供 EverythingQueryDispatcher 注入测试。

    暴露 SetSearchW / SetRequestFlags / QueryW / GetNumResults /
    GetResultFullPathNameW / GetResultSize / IsFolderResult / IsVolumeResult /
    GetLastError。
    - results: dict(search -> list[dict])，每条 {"path","size","is_folder","is_volume"}
    - delay: float 或 dict(search->float)，QueryW 返回前的可控延迟（模拟慢查询）
    - fail: dict(search->int)，命中则 QueryW 返回 0 并把 GetLastError 置为该错误码
    - hold: 可选 threading.Event，提供且未 set 时 QueryW 阻塞等待（配合 query_started
      事件构造「某查询确定执行中」的窗口）
    """

    def __init__(self, results=None, delay=0.0, fail=None, hold=None):
        self.results = results or {}
        self.delay = delay
        self.fail = fail or {}
        self.hold = hold
        self._lock = threading.Lock()
        self.query_count = 0
        self.query_searches = []
        self.active_count = 0
        self.max_active = 0
        self.last_search = None
        self.last_flags = None
        self.last_error = 0
        self.query_started = threading.Event()
        self._current_search = None

    def Everything_SetSearchW(self, search):
        self._current_search = search
        self.last_search = search

    def Everything_SetRequestFlags(self, flags):
        self.last_flags = flags

    def Everything_QueryW(self, wait):
        search = self._current_search
        with self._lock:
            self.query_count += 1
            self.query_searches.append(search)
            self.active_count += 1
            if self.active_count > self.max_active:
                self.max_active = self.active_count
        self.query_started.set()
        try:
            if self.hold is not None and not self.hold.is_set():
                self.hold.wait(timeout=10)
            delay = self.delay.get(search, 0.0) if isinstance(self.delay, dict) else self.delay
            if delay:
                time.sleep(delay)
        finally:
            with self._lock:
                self.active_count -= 1
        code = self.fail.get(search)
        if code is not None:
            self.last_error = code
            return 0
        self.last_error = 0
        return 1

    def Everything_GetNumResults(self):
        return len(self.results.get(self._current_search, ()))

    def Everything_GetResultFullPathNameW(self, index, buffer, buffer_chars):
        row = self.results[self._current_search][index]
        buffer.value = row["path"]
        return len(row["path"]) + 1

    def Everything_GetResultSize(self, index, size_out):
        row = self.results[self._current_search][index]
        size_out.value = row.get("size", 0)
        return bool(row.get("size", 0))

    def Everything_IsFolderResult(self, index):
        return bool(self.results[self._current_search][index].get("is_folder", False))

    def Everything_IsVolumeResult(self, index):
        return bool(self.results[self._current_search][index].get("is_volume", False))

    def Everything_GetLastError(self):
        return self.last_error


class SerialExecutionTests(unittest.TestCase):
    """串行：同一时刻只执行一个 SDK 阻塞查询。"""

    def test_two_concurrent_submissions_never_overlap_queryw(self):
        mock = MockSDK(
            results={
                "a": [_row("C:\\a1", 10)],
                "b": [_row("C:\\b1", 20)],
            },
            delay={"a": 0.05, "b": 0.05},
        )
        dispatcher = EverythingQueryDispatcher(sdk_module=mock)
        self.addCleanup(dispatcher.shutdown)

        future_a = dispatcher.query_async("a")
        future_b = dispatcher.query_async("b")
        rows_a = future_a.result(timeout=5)
        rows_b = future_b.result(timeout=5)

        self.assertEqual(rows_a[0]["path"], "C:\\a1")
        self.assertEqual(rows_b[0]["path"], "C:\\b1")
        self.assertEqual(mock.query_searches, ["a", "b"])
        self.assertEqual(mock.query_count, 2)
        self.assertEqual(mock.max_active, 1, "QueryW 不应被并发调用")


class DebounceTests(unittest.TestCase):
    """250ms 防抖：窗口内合并、窗口外新建执行。"""

    def test_same_search_within_window_merges_into_one_execution(self):
        mock = MockSDK(results={"x": [_row("C:\\x", 1)]})
        dispatcher = EverythingQueryDispatcher(sdk_module=mock, debounce_seconds=0.25)
        self.addCleanup(dispatcher.shutdown)

        first = dispatcher.query_async("x")
        second = dispatcher.query_async("x")  # 窗口内立即重复

        rows_first = first.result(timeout=5)
        rows_second = second.result(timeout=5)

        self.assertEqual(mock.query_count, 1, "窗口内重复提交不应重复查询 SDK")
        self.assertEqual(rows_first, rows_second)

    def test_same_search_after_window_triggers_second_query(self):
        mock = MockSDK(results={"x": [_row("C:\\x", 1)]})
        dispatcher = EverythingQueryDispatcher(sdk_module=mock, debounce_seconds=0.05)
        self.addCleanup(dispatcher.shutdown)

        dispatcher.query("x")
        self.assertEqual(mock.query_count, 1)
        time.sleep(0.15)  # 超过 50ms 窗口
        dispatcher.query("x")
        self.assertEqual(mock.query_count, 2, "超过窗口后应触发第二次 QueryW")


class GenerationTests(unittest.TestCase):
    """代际令牌：慢查询结果到达时不污染后续请求。"""

    def test_slow_query_does_not_pollute_next_query(self):
        mock = MockSDK(
            results={
                "A": [_row("C:\\AAA", 1)],
                "B": [_row("C:\\BBB", 2)],
            },
            delay={"A": 0.1, "B": 0.0},
        )
        dispatcher = EverythingQueryDispatcher(sdk_module=mock)
        self.addCleanup(dispatcher.shutdown)

        future_a = dispatcher.query_async("A")
        future_b = dispatcher.query_async("B")  # A 执行中提交 B（B 排队）

        rows_a = future_a.result(timeout=5)
        rows_b = future_b.result(timeout=5)

        self.assertEqual(rows_a[0]["path"], "C:\\AAA")
        self.assertEqual(rows_b[0]["path"], "C:\\BBB")
        self.assertEqual(mock.query_searches, ["A", "B"])
        self.assertEqual(dispatcher._generation, 2, "两次执行应分配两个自增代数")


class QueueCapacityTests(unittest.TestCase):
    """有界队列：超过容量抛异常。"""

    def test_queue_full_raises_dispatcher_error(self):
        hold = threading.Event()
        mock = MockSDK(results={"hold": [_row("C:\\h")]}, hold=hold)
        dispatcher = EverythingQueryDispatcher(sdk_module=mock, queue_size=2)
        self.addCleanup(dispatcher.shutdown)
        self.addCleanup(hold.set)  # 先于 shutdown 执行，避免 worker 卡在 hold

        dispatcher.query_async("hold")
        self.assertTrue(mock.query_started.wait(timeout=2), "首个查询应已进入执行")
        dispatcher.query_async("q1")
        dispatcher.query_async("q2")
        with self.assertRaises(DispatcherError):
            dispatcher.query_async("q3")

        hold.set()  # 放行在途查询，随后排空 q1/q2


class QueryFailureTests(unittest.TestCase):
    """查询失败：QueryW=0 时抛带错误码的 DispatcherError。"""

    def test_query_failure_raises_with_error_code(self):
        mock = MockSDK(fail={"bad": 42})
        dispatcher = EverythingQueryDispatcher(sdk_module=mock)
        self.addCleanup(dispatcher.shutdown)

        with self.assertRaises(DispatcherError) as ctx:
            dispatcher.query("bad")
        self.assertEqual(ctx.exception.error_code, 42)

    def test_query_failure_error_code_matches_getlasterror(self):
        mock = MockSDK(fail={"boom": 7})
        dispatcher = EverythingQueryDispatcher(sdk_module=mock)
        self.addCleanup(dispatcher.shutdown)

        future = dispatcher.query_async("boom")
        with self.assertRaises(DispatcherError) as ctx:
            future.result(timeout=5)
        self.assertEqual(ctx.exception.error_code, 7)


class EmptyResultTests(unittest.TestCase):
    """空结果正常返回空列表。"""

    def test_empty_results_returns_empty_list(self):
        mock = MockSDK()  # 任意 search 均无结果
        dispatcher = EverythingQueryDispatcher(sdk_module=mock)
        self.addCleanup(dispatcher.shutdown)
        self.assertEqual(dispatcher.query("anything"), [])


class ResultRowContractTests(unittest.TestCase):
    """结果行契约与请求标志。"""

    def test_result_row_contract(self):
        mock = MockSDK(
            results={
                "x": [
                    _row("C:\\x.txt", 123, is_folder=False),
                    _row("C:\\dir", 0, is_folder=True),
                ]
            }
        )
        dispatcher = EverythingQueryDispatcher(sdk_module=mock)
        self.addCleanup(dispatcher.shutdown)

        rows = dispatcher.query("x")
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]["path"], "C:\\x.txt")
        self.assertEqual(rows[0]["size"], 123)
        self.assertFalse(rows[0]["is_folder"])
        self.assertFalse(rows[0]["is_volume"])
        self.assertTrue(rows[1]["is_folder"])

    def test_default_request_flags_applied(self):
        mock = MockSDK(results={"x": [_row("C:\\x")]})
        dispatcher = EverythingQueryDispatcher(sdk_module=mock)
        self.addCleanup(dispatcher.shutdown)
        dispatcher.query("x")
        self.assertEqual(mock.last_flags, DEFAULT_REQUEST_FLAGS)

    def test_explicit_request_flags_applied(self):
        mock = MockSDK(results={"x": [_row("C:\\x")]})
        dispatcher = EverythingQueryDispatcher(sdk_module=mock)
        self.addCleanup(dispatcher.shutdown)
        dispatcher.query("x", request_flags=sdk.EVERYTHING_REQUEST_FILE_NAME)
        self.assertEqual(mock.last_flags, sdk.EVERYTHING_REQUEST_FILE_NAME)


class CancelTests(unittest.TestCase):
    """cancel_all：丢弃慢查询的过期结果。"""

    def test_cancel_all_cancels_inflight_and_discards_result(self):
        hold = threading.Event()
        mock = MockSDK(results={"slow": [_row("C:\\slow")]}, hold=hold)
        dispatcher = EverythingQueryDispatcher(sdk_module=mock)
        self.addCleanup(dispatcher.shutdown)
        self.addCleanup(hold.set)

        future = dispatcher.query_async("slow")
        self.assertTrue(mock.query_started.wait(timeout=2))
        dispatcher.cancel_all()

        with self.assertRaises(CancelledError):
            future.result(timeout=5)

        hold.set()  # 慢查询此刻才返回结果，应被丢弃
        time.sleep(0.05)
        self.assertTrue(future.cancelled(), "慢结果不得复活已取消的 Future")


class ShutdownTests(unittest.TestCase):
    """shutdown：拒绝新查询、停掉工作线程。"""

    def test_shutdown_rejects_new_queries(self):
        mock = MockSDK(results={"x": [_row("C:\\x")]})
        dispatcher = EverythingQueryDispatcher(sdk_module=mock)
        dispatcher.shutdown(wait=True)

        with self.assertRaises(DispatcherError):
            dispatcher.query("x")
        self.assertFalse(dispatcher._worker.is_alive())


class CrossThreadTests(unittest.TestCase):
    """跨线程可调用：多线程并发提交且结果正确、无并发 QueryW。"""

    def test_multithreaded_submissions_are_correct_and_serial(self):
        count = 20
        results = {f"s{i}": [_row(f"C:\\s{i}", i)] for i in range(count)}
        mock = MockSDK(results=results, delay=0.005)
        dispatcher = EverythingQueryDispatcher(sdk_module=mock, queue_size=64)
        self.addCleanup(dispatcher.shutdown)

        errors = []

        def worker(i):
            try:
                rows = dispatcher.query(f"s{i}")
                if rows[0]["path"] != f"C:\\s{i}":
                    errors.append((i, "path 不匹配"))
            except Exception as exc:  # noqa: BLE001  # 收集任何异常以便断言失败
                errors.append((i, repr(exc)))

        threads = [threading.Thread(target=worker, args=(i,)) for i in range(count)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

        self.assertEqual(errors, [], f"多线程并发查询出现错误: {errors}")
        self.assertEqual(mock.max_active, 1)
        self.assertEqual(mock.query_count, count)


if __name__ == "__main__":
    unittest.main()