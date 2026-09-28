"""阶段B（R1）新增后端契约测试（B-1/B-7/B-10/B-11/B-16/B-18）。

覆盖：
- 状态机四序列（首次扫描→队列→完成→重扫→中止→再次扫描），fake SDK：
  慢扫/可取消/二次/锁占用；
- status() additive：phase / lock_holder / row_done/row_total / stop_ack_at；
- start() 返回 {started, queued, phase}（非空 dict，布尔兼容）；
- 看门狗：单盘无进展超时 → error="SDK 无响应" 且协作取消（不硬杀模式——
  用缩短阈值打桩验证置位 CANCEL_EVENT + error 文案）；
- /api/compare：202+job_id / 400 基线非快照文件 / 409 扫描中 / 404 未知任务；
- /api/browse：source index/sdk/scanning 三场景；锁占用 409；
- /api/export：无结果 404 / 扫描中 409 reason=scanning / 中止 partial 提示；
- health busy：lock_holder additive。

编码规约继承既有契约护栏：with app.test_client() as client + 逐 resp close
（-W error::ResourceWarning 门禁）；新增字段一律 additive。
"""

import os
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

import app as app_module
import fullscan
import scan
import snapshots
from app import app

LOCAL_GUID = snapshots.get_machine_guid()


def _snapshot_file(tmp, root="C:\\T", rows=None, guid=None):
    """临时目录内生成一份合法快照文件（.snap.gz），返回路径 str。"""
    rows = rows if rows is not None else [
        {"p": "C:\\T", "s": 100}, {"p": "C:\\T\\a", "s": 40},
    ]
    p = snapshots.save_snapshot(
        root, rows,
        dir_path=Path(tmp), auto=False,
        machine_guid=guid or LOCAL_GUID,
        fingerprint={"count": len(rows), "crc32": 0},
    )
    return str(p)


def _reset_fullscan_state():
    fullscan.BROWSE_INDEX.clear()
    fullscan.USER_STOP_EVENT.clear()
    fullscan.CANCEL_EVENT.clear()
    fullscan._update_state(
        running=False, thread=None, current_root=None,
        error=None, cancelled=False, stop_requested=False,
        stop_reason=None, last_result=None,
        phase=fullscan.PHASE_IDLE, row_done=0, row_total=0,
        stop_ack_at=None, watchdog_roots_last_total={}, watchdog_checked_at=None,
    )


class ScanStateMachineTests(unittest.TestCase):
    """B-7：状态机四序列（fake SDK）。"""

    def setUp(self):
        _reset_fullscan_state()
        self.addCleanup(_reset_fullscan_state)

    def test_first_scan_phase_sequence(self):
        """首次扫描：start 返回 {started:true, queued:false}；完成后 phase=idle。
        ⚠️ join 必须在 mock.patch 的 with 块内——后台线程真正调用被 patch 的
        scan_via_everything_sdk 发生在 start() 返回之后，patch 提前退出会让
        线程落到真实 SDK（everything=object() 崩溃 → error）。"""
        def fake_scan(root_path_obj, everything=None, cancel_event=None, progress=None):
            return {Path(root_path_obj): 100}, {Path(root_path_obj): [("a", False, 100)]}

        with mock.patch.object(fullscan, "scan_via_everything_sdk", side_effect=fake_scan):
            ret = fullscan.start(roots=["C:\\SDK1"], everything=object())
            self.assertIsInstance(ret, dict)
            self.assertTrue(ret["started"])
            self.assertFalse(ret["queued"])
            st = fullscan.status()
            self.assertEqual(st["phase"], fullscan.PHASE_SCANNING)
            thread = fullscan._copy_state()["thread"]
            if thread is not None:
                thread.join(timeout=3)
        self.assertFalse(thread is None, "start 应创建后台线程")
        st = fullscan.status()
        self.assertFalse(st["running"])
        self.assertEqual(st["phase"], fullscan.PHASE_IDLE)
        self.assertTrue(st["result_ready"])

    def test_second_scan_version_increments(self):
        """第二次扫描 scan_version 递增且最终收敛（completed→重扫序列）。"""
        def fake_scan(root_path_obj, everything=None, cancel_event=None, progress=None):
            return {Path(root_path_obj): 100}, {Path(root_path_obj): [("a", False, 100)]}

        with mock.patch.object(fullscan, "scan_via_everything_sdk", side_effect=fake_scan):
            fullscan.start(roots=["C:\\SDK2"], everything=object())
            t1 = fullscan._copy_state()["thread"]
            if t1: t1.join(timeout=3)
            v1 = fullscan.status()["scan_version"]
            fullscan.start(roots=["C:\\SDK2"], everything=object())
            t2 = fullscan._copy_state()["thread"]
            if t2: t2.join(timeout=3)
            v2 = fullscan.status()["scan_version"]
        self.assertGreater(v2, v1, "重扫 scan_version 必须递增")

    def test_queued_when_lock_held(self):
        """锁被占（模拟 browse/compare 直扫）→ start 返回 queued:true + phase=queued。
        ⚠️ patch 必须保持到线程取锁后调用 fake_scan——锁释放后、join 前都在
        patch 块内（后台线程真正调用 SDK 发生在锁释放之后）。"""
        def fake_scan(root_path_obj, everything=None, cancel_event=None, progress=None):
            return {Path(root_path_obj): 100}, {Path(root_path_obj): [("a", False, 100)]}

        with mock.patch.object(fullscan, "scan_via_everything_sdk", side_effect=fake_scan):
            with scan.sdk_lock("browse"):
                ret = fullscan.start(roots=["C:\\SDK3"], everything=object())
                thread = fullscan._copy_state()["thread"]
            # browse 锁已释放；patch 仍生效 → 后台线程取锁后走 fake_scan
            if thread is not None:
                thread.join(timeout=3)
        self.assertTrue(ret["started"])
        self.assertTrue(ret["queued"], "锁被占用时 start 必须报 queued")
        self.assertEqual(ret["phase"], fullscan.PHASE_QUEUED)

    def test_start_rejects_when_running(self):
        """运行中重复 start → {started:false}（请求 409 语义在 api 层）。"""
        fullscan._update_state(running=True)
        ret = fullscan.start(roots=["C:\\SDK4"])
        self.assertIsInstance(ret, dict)
        self.assertFalse(ret["started"])

    def test_stop_ack_at_recorded(self):
        """request_stop 记录 stop_ack_at（B-10）；新扫描 start 复位。
        ⚠️ 复位语义验证：构造带 stop_ack_at 的旧状态 → start() 同步复位（不依赖
        线程结果），patch 内 join 收尾。"""
        def fake_scan(root_path_obj, everything=None, cancel_event=None, progress=None):
            return {Path(root_path_obj): 100}, {Path(root_path_obj): [("a", False, 100)]}

        fullscan._update_state(running=True)
        self.assertTrue(fullscan.request_stop())
        st = fullscan.status()
        self.assertIsNotNone(st["stop_ack_at"])
        self.assertIn("stop_ack_at", st)
        # 旧扫描结束态带 stop_ack_at → 新 start() 复位
        fullscan._update_state(
            running=False, stop_requested=True, stop_reason="user",
            stop_ack_at="2026-09-03T10:00:00",
        )
        with mock.patch.object(fullscan, "scan_via_everything_sdk", side_effect=fake_scan):
            ret = fullscan.start(roots=["C:\\SDK5"], everything=object())
            thread = fullscan._copy_state()["thread"]
            if thread is not None:
                thread.join(timeout=3)
        self.assertTrue(ret["started"])
        st = fullscan.status()
        self.assertIsNone(st["stop_ack_at"], "start 必须复位 stop_ack_at")
        self.assertFalse(st["stop_requested"])

    def test_row_counts_propagate(self):
        """B-11：扫描层 progress 回调 → status row_done/row_total。
        ⚠️ 行计数在扫描完成时复位（设计），须在扫描中采样：fake_scan 调 progress
        后阻塞，等 status 出现计数后再放行。"""
        release = threading.Event()

        def fake_scan(root_path_obj, everything=None, cancel_event=None, progress=None):
            if progress:
                progress(5000, 10000)
            release.wait(timeout=3)  # 阻塞让测试采样扫描中状态
            return {Path(root_path_obj): 100}, {Path(root_path_obj): [("a", False, 100)]}

        captured = {}
        with mock.patch.object(fullscan, "scan_via_everything_sdk", side_effect=fake_scan):
            fullscan.start(roots=["C:\\SDK6"], everything=object())
            thread = fullscan._copy_state()["thread"]
            # 扫描中采样（fake 阻塞在 release）
            deadline = time.time() + 3
            while time.time() < deadline:
                st = fullscan.status()
                if st.get("row_total") == 10000:
                    break
                time.sleep(0.02)
            captured["st"] = fullscan.status()
            release.set()
            if thread is not None:
                thread.join(timeout=3)
        st = captured["st"]
        self.assertIn("row_done", st)
        self.assertIn("row_total", st)
        self.assertEqual(st["row_total"], 10000)
        self.assertEqual(st["row_done"], 5000)


class WatchdogTests(unittest.TestCase):
    """B-7：看门狗——单盘无行更新超时 → 协作取消 + error 文案（不硬杀）。"""

    def setUp(self):
        _reset_fullscan_state()
        self.addCleanup(_reset_fullscan_state)

    def test_watchdog_stalls_then_cancels(self):
        """打桩缩短阈值：扫描过程中 row_total 不变且超过阈值 → CANCEL_EVENT 置位
        且 error="SDK 无响应"。watchdog 检查周期与停滞阈值一并打桩加速。"""
        orig_seconds = fullscan.WATCHDOG_ROOT_STALL_SECONDS
        orig_interval = fullscan._WATCHDOG_INTERVAL
        fullscan.WATCHDOG_ROOT_STALL_SECONDS = 0.2  # 极短阈值加速测试
        fullscan._WATCHDOG_INTERVAL = 0.05         # 极短检查周期
        started = {"flag": False}

        def fake_scan(root_path_obj, everything=None, cancel_event=None, progress=None):
            started["flag"] = True
            # 第一根立即返回；第二根模拟卡住（等待取消事件）
            if str(root_path_obj) == "C:\\W1":
                if progress:
                    progress(1, 100)
                return {Path(root_path_obj): 100}, {Path(root_path_obj): [("a", False, 100)]}
            # 第二根：卡在循环里等 CANCEL_EVENT（协作检查语义）
            from scan import ScanCancelledError
            deadline = time.time() + 4
            while time.time() < deadline:
                if cancel_event is not None and cancel_event.is_set():
                    raise ScanCancelledError("watchdog cancelled")
                time.sleep(0.02)
            raise RuntimeError("watchdog 未触发取消（超限）")

        try:
            # 关键：join 必须在 patch 块内（后台线程真正调 fake_scan 在 start 之后）
            with mock.patch.object(fullscan, "scan_via_everything_sdk", side_effect=fake_scan):
                fullscan.start(roots=["C:\\W1", "C:\\W2"], everything=object())
                thread = fullscan._copy_state()["thread"]
                if thread: thread.join(timeout=8)
        finally:
            fullscan.WATCHDOG_ROOT_STALL_SECONDS = orig_seconds
            fullscan._WATCHDOG_INTERVAL = orig_interval

        st = fullscan.status()
        self.assertFalse(st["running"])
        self.assertIn("SDK 无响应", (st["error"] or ""), "看门狗超时必须记 error=SDK 无响应")
        self.assertTrue(fullscan.BROWSE_INDEX.has_root(Path("C:\\W1")), "已完成根保留")
        self.assertTrue(fullscan.CANCEL_EVENT.is_set(), "看门狗必须置协作取消事件")
        self.assertTrue(started["flag"])


class CompJkeContractTests(unittest.TestCase):
    """B-1：/api/compare 202+job_id / 400 / 409 / 404 与 status 轮询。"""

    def setUp(self):
        _reset_fullscan_state()
        app_module.COMPARE_JOBS.clear()
        self.addCleanup(_reset_fullscan_state)
        self.addCleanup(app_module.COMPARE_JOBS.clear)

    def test_baseline_not_snapshot_file_400(self):
        """B-1 ④：baseline 是目录 → 400「基线不是快照文件」。"""
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        with app.test_client() as client:
            resp = client.post("/api/compare", json={"root": "C:\\T", "baseline": tmp.name})
            self.assertEqual(resp.status_code, 400)
            self.assertIn("基线不是快照文件", resp.get_json()["error"])
            resp.close()

    def test_baseline_missing_400(self):
        """baseline 不存在 → 400 基线快照不存在。"""
        with app.test_client() as client:
            resp = client.post("/api/compare", json={"root": "C:\\T", "baseline": "X:\\nosuch.snap.gz"})
            self.assertEqual(resp.status_code, 400)
            self.assertIn("不存在", resp.get_json()["error"])
            resp.close()

    def test_compare_202_async_job(self):
        """B-1 ②：无缓存 + 锁空闲 → 202 + {job_id, status:scanning}；status 轮询可完成。"""
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        baseline = _snapshot_file(tmp.name, root="C:\\T")
        fake_sizes = {Path("C:\\T"): 200, Path("C:\\T\\a"): 80}

        def fake_scan(root_path_obj, cancel_event=None, everything=None, progress=None):
            if progress:
                progress(10, 10)
            return fake_sizes, {}

        with app.test_client() as client:
            with mock.patch.object(fullscan, "is_running", return_value=False), \
                    mock.patch.object(fullscan, "result", return_value=None), \
                    mock.patch.object(scan, "scan_via_everything_sdk", side_effect=fake_scan):
                resp = client.post("/api/compare", json={"root": "C:\\T", "baseline": baseline})
            self.assertEqual(resp.status_code, 202, "无缓存应返回 202")
            body = resp.get_json()
            self.assertIn("job_id", body)
            self.assertEqual(body["status"], "scanning")
            job_id = body["job_id"]
            # 轮询到 done（后台任务同步假 SDK，立即完成）
            deadline = time.time() + 3
            report = None
            while time.time() < deadline:
                with app.test_client() as client2:
                    r2 = client2.get("/api/compare/status?job_id=" + job_id)
                    b2 = r2.get_json()
                    r2.close()
                if b2 and b2.get("status") == "done":
                    report = b2.get("report")
                    break
                time.sleep(0.05)
            self.assertIsNotNone(report, "202 任务应轮询到 done")
            self.assertEqual(report["delta_total"], 100)
            resp.close()

    def test_compare_status_unknown_job_404(self):
        """未知 job_id → 404。"""
        with app.test_client() as client:
            resp = client.get("/api/compare/status?job_id=nope")
            self.assertEqual(resp.status_code, 404)
            resp.close()

    def test_compare_locked_409(self):
        """B-1：SDK 锁被占（全量扫描）且无缓存 → 409（P12·C-1 契约保持）。"""
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        baseline = _snapshot_file(tmp.name, root="C:\\T")
        with app.test_client() as client:
            with scan.SCAN_LOCK:  # 模拟全量扫描持锁
                with mock.patch.object(fullscan, "is_running", return_value=False), \
                        mock.patch.object(fullscan, "result", return_value=None):
                    resp = client.post("/api/compare", json={"root": "C:\\T", "baseline": baseline})
            self.assertEqual(resp.status_code, 409)
            self.assertIn("稍后再对比", resp.get_json()["error"])
            resp.close()

    def test_compare_cached_sync_report(self):
        """B-1 ①：fullscan.result(root) 缓存命中 → 同步报告（非 202）。"""
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        baseline = _snapshot_file(tmp.name, root="C:\\T")
        cached = {
            "root": "C:\\T",
            "rows": [{"p": "C:\\T", "s": 200}, {"p": "C:\\T\\a", "s": 80}],
        }
        with app.test_client() as client:
            with mock.patch.object(fullscan, "is_running", return_value=False), \
                    mock.patch.object(fullscan, "result", return_value=cached):
                resp = client.post("/api/compare", json={"root": "C:\\T", "baseline": baseline})
            self.assertEqual(resp.status_code, 200)
            body = resp.get_json()
            self.assertIn("report", body)
            self.assertEqual(body["report"]["delta_total"], 100)
            resp.close()

    def test_compare_fullscan_running_409(self):
        """全量扫描运行中 → 409（既有 W2.4 语义）。"""
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        baseline = _snapshot_file(tmp.name, root="C:\\T")
        with app.test_client() as client:
            with mock.patch.object(fullscan, "is_running", return_value=True):
                resp = client.post("/api/compare", json={"root": "C:\\T", "baseline": baseline})
            self.assertEqual(resp.status_code, 409)
            self.assertIn("全量扫描进行中", resp.get_json()["error"])
            resp.close()


class BrowseSourceContractTests(unittest.TestCase):
    """B-13：/api/browse source 三场景 + 锁占用 409。"""

    def setUp(self):
        _reset_fullscan_state()
        self.addCleanup(_reset_fullscan_state)

    def test_browse_index_source(self):
        """索引命中 → source=index + source_at。"""
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        fullscan.BROWSE_INDEX.add_scan(root, {str(root): 100}, {str(root): [("a", False, 100)]})
        with app.test_client() as client:
            resp = client.post("/api/browse", json={"root": str(root), "path": str(root)})
            self.assertEqual(resp.status_code, 200)
            body = resp.get_json()
            self.assertEqual(body["source"], "index")
            self.assertIn("source_at", body)
            resp.close()

    def test_browse_sdk_source(self):
        """无索引 + SDK 直扫 → source=sdk。"""
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)

        def fake_scan(root_path_obj, cancel_event=None, everything=None, progress=None):
            return {str(root_path_obj): 100}, {str(root_path_obj): [("a", False, 100)]}

        with app.test_client() as client:
            with mock.patch.object(fullscan, "is_running", return_value=False), \
                    mock.patch.object(fullscan.BROWSE_INDEX, "root_for", return_value=None), \
                    mock.patch.object(scan, "scan_via_everything_sdk", side_effect=fake_scan):
                resp = client.post("/api/browse", json={"root": str(root), "path": str(root)})
            self.assertEqual(resp.status_code, 200)
            body = resp.get_json()
            self.assertEqual(body["source"], "sdk")
            resp.close()

    def test_browse_scanning_source(self):
        """全量扫描中（目标盘未完成）→ source=scanning + scanning:true。"""
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        with app.test_client() as client:
            with mock.patch.object(fullscan, "is_running", return_value=True), \
                    mock.patch.object(fullscan, "status", return_value={
                        "current_root": str(root), "progress_pct": 30,
                    }), \
                    mock.patch.object(fullscan.BROWSE_INDEX, "root_for", return_value=None):
                resp = client.post("/api/browse", json={"root": str(root), "path": str(root)})
            self.assertEqual(resp.status_code, 200)
            body = resp.get_json()
            self.assertIs(body["scanning"], True)
            self.assertEqual(body["source"], "scanning")
            resp.close()

    def test_browse_lock_held_409(self):
        """B-7 ③：SDK 锁被占（无索引且非扫描中，如对比直扫）→ 409 非阻塞。"""
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        with app.test_client() as client:
            with scan.SCAN_LOCK:
                with mock.patch.object(fullscan, "is_running", return_value=False), \
                        mock.patch.object(fullscan.BROWSE_INDEX, "root_for", return_value=None):
                    resp = client.post("/api/browse", json={"root": str(root), "path": str(root)})
            self.assertEqual(resp.status_code, 409)
            self.assertIn("占用", resp.get_json()["error"])
            resp.close()


class ExportContractTests(unittest.TestCase):
    """B-16：导出四态——无结果 404 / 扫描中 409 / 完成下载 / 中止 partial。"""

    def setUp(self):
        _reset_fullscan_state()
        self.addCleanup(_reset_fullscan_state)

    def test_export_no_result_404(self):
        with app.test_client() as client:
            with mock.patch.object(fullscan, "is_running", return_value=False), \
                    mock.patch.object(fullscan, "result", return_value=None):
                resp = client.get("/api/export?format=csv")
            self.assertEqual(resp.status_code, 404)
            self.assertIn("暂无可导出", resp.get_json()["error"])
            resp.close()

    def test_export_scanning_409(self):
        """扫描中无结果 → 409 + reason:scanning（与 404 区分）。"""
        with app.test_client() as client:
            with mock.patch.object(fullscan, "is_running", return_value=True):
                resp = client.get("/api/export?format=csv")
            self.assertEqual(resp.status_code, 409)
            body = resp.get_json()
            self.assertEqual(body.get("reason"), "scanning")
            resp.close()

    def test_export_complete_download(self):
        """完成 → 200 CSV + Content-Disposition。"""
        last = {
            "roots": {"D:\\T": {"rows": [{"p": "D:\\T", "s": 100}]}},
            "scan_version": 1, "ok": True, "completed_at": "2026-09-02T12:00:00",
        }
        with app.test_client() as client:
            with mock.patch.object(fullscan, "is_running", return_value=False), \
                    mock.patch.object(fullscan, "result", return_value=last):
                resp = client.get("/api/export?format=csv&root=D%3A%5CT")
            self.assertEqual(resp.status_code, 200)
            self.assertIn("attachment", resp.headers["Content-Disposition"])
            self.assertTrue(resp.data.startswith(b"\xef\xbb\xbf"))
            resp.close()

    def test_export_aborted_partial_header(self):
        """中止部分根 → CSV 下载 + X-Export-Partial=true。"""
        last = {
            "roots": {"D:\\T": {"rows": [{"p": "D:\\T", "s": 100}]}},
            "scan_version": 1, "ok": False, "completed_at": "2026-09-02T12:00:00",
        }
        fullscan._update_state(stop_requested=True, stop_reason="user", last_result=last)
        with app.test_client() as client:
            with mock.patch.object(fullscan, "is_running", return_value=False):
                resp = client.get("/api/export?format=csv&root=D%3A%5CT")
            self.assertEqual(resp.status_code, 200)
            self.assertEqual(resp.headers.get("X-Export-Partial"), "true")
            self.assertIn("部分", resp.data.decode("utf-8-sig"))
            resp.close()


class HealthBusyHolderTests(unittest.TestCase):
    """B-18：health busy 分支 lock_holder additive（busy ≠ 未就绪 RT-02 零变更）。"""

    def test_health_busy_reports_lock_holder(self):
        with app.test_client() as client:
            with scan.sdk_lock("fullscan"):
                resp = client.get("/api/health")
            body = resp.get_json()
            self.assertIs(body["busy"], True)
            self.assertEqual(body.get("lock_holder"), "fullscan")
            self.assertIn("lock_since", body)
            resp.close()


if __name__ == "__main__":
    unittest.main()