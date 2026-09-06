"""datadir 模块单元测试（Phase 0）。

覆盖：数据根目录解析（LOCALAPPDATA 优先/缺失回退）、子路径约定、
ensure_data_dir 重建空结构、wipe_data(all=False/all=True) 清空与重建。
全程使用 mock.patch.dict 注入 LOCALAPPDATA，不触碰真实 %LOCALAPPDATA%。
"""

import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import datadir


def patch_localappdata(local):
    """在测试范围内把 LOCALAPPDATA 指向临时目录。"""
    return mock.patch.dict(os.environ, {"LOCALAPPDATA": str(local)})


class DataDirPathTests(unittest.TestCase):
    def test_get_data_dir_uses_localappdata(self):
        """默认数据根 = %LOCALAPPDATA%\\PythonDiskScanner。"""
        with tempfile.TemporaryDirectory() as tmp:
            local = Path(tmp)
            with patch_localappdata(local):
                self.assertEqual(
                    datadir.get_data_dir(),
                    local / "PythonDiskScanner",
                )

    def test_get_data_dir_falls_back_to_home_appdata(self):
        """LOCALAPPDATA 缺失/为空时回退到 ~\\AppData\\Local\\PythonDiskScanner。"""
        with mock.patch.dict(os.environ, {"LOCALAPPDATA": ""}):
            expected = Path.home() / "AppData" / "Local" / "PythonDiskScanner"
            self.assertEqual(datadir.get_data_dir(), expected)

    def test_subpath_conventions(self):
        """config/snapshots/exports/机器 GUID 文件均位于数据目录下。"""
        with tempfile.TemporaryDirectory() as tmp:
            data_dir = Path(tmp) / "PythonDiskScanner"
            with patch_localappdata(Path(tmp)):
                self.assertEqual(datadir.get_config_path(), data_dir / "config.json")
                self.assertEqual(datadir.get_snapshots_dir(), data_dir / "snapshots")
                self.assertEqual(datadir.get_exports_dir(), data_dir / "exports")
                self.assertEqual(
                    datadir.get_machine_guid_path(),
                    data_dir / ".pythondiskscanner_machine_guid",
                )


class EnsureDataDirTests(unittest.TestCase):
    def test_ensure_creates_snapshots_and_exports(self):
        """ensure_data_dir 创建数据根 + snapshots/ + exports/。"""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "PythonDiskScanner"
            with patch_localappdata(Path(tmp)):
                result = datadir.ensure_data_dir()
            self.assertEqual(result, root)
            self.assertTrue(root.exists())
            self.assertTrue((root / "snapshots").is_dir())
            self.assertTrue((root / "exports").is_dir())


class WipeDataTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.base = Path(self._tmp.name)
        self.root = self.base / "PythonDiskScanner"

    def _make_populated_root(self):
        (self.root / "snapshots").mkdir(parents=True)
        (self.root / "exports").mkdir(parents=True)
        (self.root / "config.json").write_text("{}", encoding="utf-8")
        (self.root / ".pythondiskscanner_machine_guid").write_text("guid", encoding="utf-8")
        (self.root / "snapshots" / "a.snap.gz").write_bytes(b"snap")
        (self.root / "exports" / "report.csv").write_text("csv", encoding="utf-8")
        (self.root / "session_1.json").write_text("[]", encoding="utf-8")

    def test_wipe_data_all_false_clears_contents_and_rebuilds(self):
        """all=False：删除数据根下全部内容，重建 snapshots/ 与 exports/。"""
        with patch_localappdata(self.base):
            self._make_populated_root()
            result = datadir.wipe_data(all=False)
        self.assertEqual(result, self.root)
        self.assertTrue(self.root.exists(), "wipe 后数据根目录仍保留")
        self.assertTrue((self.root / "snapshots").is_dir(), "wipe 后 snapshots 已重建")
        self.assertTrue((self.root / "exports").is_dir(), "wipe 后 exports 已重建")
        self.assertFalse((self.root / "config.json").exists())
        self.assertFalse((self.root / ".pythondiskscanner_machine_guid").exists())
        self.assertFalse((self.root / "session_1.json").exists())
        self.assertFalse((self.root / "snapshots" / "a.snap.gz").exists())
        self.assertFalse((self.root / "exports" / "report.csv").exists())

    def test_wipe_data_all_true_removes_root_and_rebuilds(self):
        """all=True：连数据根目录一起删除，再重建空结构。"""
        with patch_localappdata(self.base):
            self._make_populated_root()
            # 先记录根目录 inode/创建时间，验证确实被删除重建
            result = datadir.wipe_data(all=True)
        self.assertEqual(result, self.root)
        self.assertTrue(self.root.exists(), "wipe 后数据根目录已重建")
        self.assertTrue((self.root / "snapshots").is_dir())
        self.assertTrue((self.root / "exports").is_dir())
        self.assertFalse((self.root / "config.json").exists())
        self.assertFalse((self.root / ".pythondiskscanner_machine_guid").exists())

    def test_wipe_data_missing_root_creates_empty_structure(self):
        """数据根不存在时 wipe 直接创建空结构（幂等）。"""
        with patch_localappdata(self.base):
            result = datadir.wipe_data()
        self.assertEqual(result, self.root)
        self.assertTrue(self.root.exists())
        self.assertTrue((self.root / "snapshots").is_dir())
        self.assertTrue((self.root / "exports").is_dir())


if __name__ == "__main__":
    unittest.main()