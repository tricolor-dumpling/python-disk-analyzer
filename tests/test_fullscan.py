"""fullscan 模块单元测试（P12·W3.1 新增）：BrowseIndex shard 收缩与超限文案。"""

import unittest
from pathlib import Path
from unittest import mock

import fullscan
import snapshots


ROOT = Path("C:\\W31")


class AddScanShardTests(unittest.TestCase):
    """R-1：add_scan 后 shard 不含 display_paths，浏览方法不受影响。"""

    def setUp(self):
        fullscan.BROWSE_INDEX.clear()
        self.addCleanup(fullscan.BROWSE_INDEX.clear)

    def test_add_scan_shard_omits_display_paths(self):
        """shard 键集合收缩为 {root, root_key, dir_sizes, files, subdirs}。"""
        sizes = {ROOT: 100, ROOT / "sub": 60}
        contents = {ROOT: [("sub", True, 60), ("a.txt", False, 40)]}

        class _FakeContents(dict):
            pass

        fc = _FakeContents(contents)
        fullscan.BROWSE_INDEX.add_scan(ROOT, sizes, fc)
        shard = fullscan.BROWSE_INDEX._shards[fullscan._path_key(ROOT)]
        self.assertNotIn("display_paths", shard)
        self.assertEqual(
            set(shard.keys()), {"root", "root_key", "dir_sizes", "files", "subdirs"}
        )
        # children()/has_root() 正常
        self.assertTrue(fullscan.BROWSE_INDEX.has_root(ROOT))
        children = fullscan.BROWSE_INDEX.children(ROOT)
        self.assertIn(("sub", True, 60), children)


class RowLimitMessageTests(unittest.TestCase):
    """save_snapshot 超限 ValueError 文案如实化（真因表述）。"""

    def test_row_limit_message_states_true_cause(self):
        with mock.patch.object(snapshots, "MAX_ROWS", 3):
            with self.assertRaises(ValueError) as ctx:
                snapshots.save_snapshot(
                    "C:\\T",
                    [{"p": f"C:\\T\\f{i}", "s": i} for i in range(10)],
                    dir_path=Path(__file__).parent / "__nonexistent__",
                    auto=False,
                    machine_guid="deadbeef-1234",
                )
        msg = str(ctx.exception)
        self.assertNotIn("500000", msg, "打桩上限 3 时不得误报默认值 500000")
        self.assertIn("上限 3", msg)
        self.assertIn("缩小扫描根范围", msg)


class UserStopEventTests(unittest.TestCase):
    """U3.2（D10）：用户停止事件——与停服 CANCEL_EVENT 严格分离，status additive。"""

    def setUp(self):
        fullscan.USER_STOP_EVENT.clear()
        fullscan.CANCEL_EVENT.clear()
        self.addCleanup(fullscan.USER_STOP_EVENT.clear)
        self.addCleanup(fullscan.CANCEL_EVENT.clear)
        self.addCleanup(fullscan.BROWSE_INDEX.clear)
        self.addCleanup(
            fullscan._update_state,
            running=False, thread=None, current_root=None,
            error=None, cancelled=False, stop_requested=False,
            stop_reason=None, last_result=None,
        )

    def test_request_stop_sets_user_event(self):
        """运行中 request_stop → USER_STOP_EVENT 置位 + stop_reason="user"，
        且不得触碰停服 CANCEL_EVENT。"""
        fullscan._update_state(running=True)
        self.assertTrue(fullscan.request_stop())
        self.assertTrue(fullscan.USER_STOP_EVENT.is_set())
        self.assertFalse(fullscan.CANCEL_EVENT.is_set(), "用户停止不得污染停服事件")
        state = fullscan._copy_state()
        self.assertTrue(state["stop_requested"])
        self.assertEqual(state["stop_reason"], "user")

    def test_stop_idempotent_when_idle(self):
        """空闲 request_stop → 返回 False、不改状态、不置任何事件（幂等）。"""
        fullscan._update_state(running=False)
        self.assertFalse(fullscan.request_stop())
        self.assertFalse(fullscan.USER_STOP_EVENT.is_set())
        self.assertFalse(fullscan.CANCEL_EVENT.is_set())
        state = fullscan._copy_state()
        self.assertFalse(state["stop_requested"])
        self.assertIsNone(state["stop_reason"])

    def test_start_clears_stop_events(self):
        """start() 同时 clear 两事件并重置停止记录（新扫描不继承旧停止状态）。"""

        def fake_scan(root_path_obj, everything=None, cancel_event=None):
            return {Path(root_path_obj): 10}, {Path(root_path_obj): []}

        fullscan.USER_STOP_EVENT.set()
        fullscan.CANCEL_EVENT.set()
        fullscan._update_state(stop_requested=True, stop_reason="user")
        with mock.patch.object(fullscan, "scan_via_everything_sdk",
                               side_effect=fake_scan):
            started = fullscan.start(roots=["C:\\U32"], everything=object())
        self.assertTrue(started)
        self.assertFalse(fullscan.USER_STOP_EVENT.is_set(), "start 须清用户停止位")
        self.assertFalse(fullscan.CANCEL_EVENT.is_set(), "start 须清停服取消位")
        state = fullscan._copy_state()
        self.assertFalse(state["stop_requested"])
        self.assertIsNone(state["stop_reason"])
        # 等待后台线程收尾（fake_scan 立即返回），避免测试泄漏线程
        thread = fullscan._copy_state()["thread"]
        if thread is not None:
            thread.join(timeout=3)

    def test_status_reports_stop_fields(self):
        """status() additive：idle 报 False/None；请求停止后报 True/"user"。"""
        st = fullscan.status()
        self.assertIn("stop_requested", st, "status 必须含 additive 字段 stop_requested")
        self.assertIn("stop_reason", st, "status 必须含 additive 字段 stop_reason")
        self.assertIs(st["stop_requested"], False)
        self.assertIsNone(st["stop_reason"])
        fullscan._update_state(running=True)
        fullscan.request_stop()
        st = fullscan.status()
        self.assertIs(st["stop_requested"], True)
        self.assertEqual(st["stop_reason"], "user")
        self.assertTrue(st["running"])


if __name__ == "__main__":
    unittest.main()
