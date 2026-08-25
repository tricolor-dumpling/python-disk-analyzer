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


if __name__ == "__main__":
    unittest.main()
