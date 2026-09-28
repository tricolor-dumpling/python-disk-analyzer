"""P12·W2.10 部署与停服健壮测试：防双实例探测与协作取消。"""

import os
import threading
import unittest
from pathlib import Path
from unittest import mock

import app as app_module
import fullscan


ROOT_A = Path("C:\\FakeA")
ROOT_B = Path("C:\\FakeB")


class DoubleInstanceTests(unittest.TestCase):
    """DEP-1：bind 前探测已有实例，能通则不重复 LISTENING。"""

    def test_run_server_returns_without_bind_when_occupied(self):
        """stub /api/health 可达 → run_server 直接 return，未调 app.run、未拉引导线程。"""
        fake_resp = mock.Mock()
        fake_resp.status = 200
        fake_resp.__enter__ = mock.Mock(return_value=fake_resp)
        fake_resp.__exit__ = mock.Mock(return_value=False)
        with mock.patch.object(app_module.urllib.request, "urlopen",
                               return_value=fake_resp) as probe, \
                mock.patch.object(app_module.webbrowser, "open") as wb_open, \
                mock.patch.object(app_module.app, "run") as flask_run, \
                mock.patch.object(app_module.threading, "Thread") as thread_cls:
            app_module.run_server(port=5999, open_browser=True)
        self.assertTrue(probe.called, "必须先做占用探测")
        flask_run.assert_not_called()
        thread_cls.assert_not_called()  # 不再启动 bootstrap 线程
        wb_open.assert_called_once_with("http://127.0.0.1:5999")

    def test_run_server_binds_when_free(self):
        """探测失败（无实例）→ 正常进入 app.run。"""
        with mock.patch.object(app_module.urllib.request, "urlopen",
                               side_effect=OSError("refused")), \
                mock.patch.object(app_module.webbrowser, "open"), \
                mock.patch.object(app_module.app, "run") as flask_run:
            app_module.run_server(port=5998, open_browser=False)
        self.assertTrue(flask_run.called)


class CancelScanTests(unittest.TestCase):
    """R-2：扫描中途 CANCEL_EVENT 置位 → 已完成根保留、error 为空、cancelled 记录。"""

    def setUp(self):
        fullscan.BROWSE_INDEX.clear()
        CANCEL_EVENT = fullscan.CANCEL_EVENT
        CANCEL_EVENT.clear()
        # 恢复状态字段
        self.addCleanup(fullscan.BROWSE_INDEX.clear)
        self.addCleanup(lambda: fullscan._update_state(
            running=False, thread=None, current_root=None,
            error=None, cancelled=False, last_result=None,
        ))

    def test_cancel_mid_scan_keeps_completed_roots(self):
        """第二根抛 ScanCancelledError：第一根仍在 BROWSE_INDEX，error=None。"""
        from scan import ScanCancelledError

        sizes_a = {ROOT_A: 100}
        contents_a = {ROOT_A: [("a.txt", False, 100)]}

        def fake_scan(root_path_obj, cancel_event=None, everything=None):
            if str(root_path_obj) == str(ROOT_B):
                raise ScanCancelledError("已取消")
            return sizes_a, contents_a

        with mock.patch.object(fullscan, "scan_via_everything_sdk",
                               side_effect=fake_scan):
            fullscan._run([ROOT_A, ROOT_B], None, scan_version=1)

        st = fullscan.status()
        self.assertFalse(st["running"])
        self.assertTrue(fullscan.BROWSE_INDEX.has_root(ROOT_A),
                        "已完成根必须保留")
        self.assertFalse(fullscan.BROWSE_INDEX.has_root(ROOT_B))
        state = fullscan._copy_state()
        self.assertIsNone(state["error"], "取消不算失败")
        self.assertTrue(state["cancelled"])

    def test_cancel_scan_sets_event_and_joins(self):
        """cancel_scan：置位事件并 join 在途线程（序列正确）。"""
        started = threading.Event()
        release = threading.Event()

        def worker():
            started.set()
            release.wait(timeout=2)

        t = threading.Thread(target=worker, daemon=True)
        fullscan._update_state(thread=t)
        t.start()
        started.wait(timeout=1)

        with mock.patch.object(fullscan.CANCEL_EVENT, "set",
                               wraps=fullscan.CANCEL_EVENT.set) as ev_set:
            threading.Thread(  # cancel_scan 会 join；先放行 worker
                target=release.set, daemon=True
            ).start()
            fullscan.cancel_scan(join_timeout=2)
            ev_set.assert_called_once()
        self.assertFalse(t.is_alive())
        self.assertTrue(fullscan.CANCEL_EVENT.is_set())


if __name__ == "__main__":
    unittest.main()
