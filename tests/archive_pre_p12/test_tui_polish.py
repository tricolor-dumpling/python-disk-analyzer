"""任务 D8 tui.py 打磨集成 单元测试：状态栏 / 首启引导 / 帮助页 / H 对比 / S 保存 / 终端行门。

覆盖（与 tests/test_tui.py 同款约定：全链路 patch tui._getch、_ANSI_AVAILABLE=False
回退、shutil.get_terminal_size 打桩、os.system 打桩、输出进 StringIO）：
- 状态栏：常驻底行含根/当前路径/数据时间/键位缩写；ANSI 可用时反转色；进入子目录后
  当前路径联动刷新；
- 首启引导：数据目录缺失时首次进入交互循环打印一次（模块标志复位后验证），第二次
  不再打印；数据目录存在时不打印；_first_launch_data_missing 的 env/默认目录两分支；
- h 帮助页：KEY_BINDINGS 同源键位表 + 快照位置 + 口径说明 2 行，任意键返回列表态；
- H 历史对比：无快照提示 / 序号列表(含时间) / 空回车=最新 / 序号选择 / 非数字与越界
  序号横幅 / CompareError 红字返回 / 真实 compare 引擎渲染 format_row 增量降序行；
- S 保存：成功(INFO_SNAPSHOT_SAVED+路径) / SnapshotBusyError / OSError / ValueError /
  DSA_NO_SNAPSHOT 禁用三态（五态）;
- 终端行门：<12 行只显示居中提示 + 状态栏、不渲染列表；resize 后自动恢复。

不依赖真实终端、Everything 与快照目录：全部按键/input/终端尺寸注入，
snapshots/compare 侧接口全部 mock 或注入。
"""

import contextlib
import io
import os
import re
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import compare
import keyrouter
import snapshots
import tui

ROOT = Path("C:\\Users\\Test")


class _TuiBase(unittest.TestCase):
    """公共 setUp：关闭 ANSI 渲染、打桩终端尺寸与 cls，提供 _run_ui 注入框架。"""

    def setUp(self):
        self._ansi = tui._ANSI_AVAILABLE
        self._msvcrt = tui.msvcrt
        self.addCleanup(setattr, tui, "_ANSI_AVAILABLE", self._ansi)
        self.addCleanup(setattr, tui, "msvcrt", self._msvcrt)
        tui._ANSI_AVAILABLE = False
        term = mock.patch("shutil.get_terminal_size", return_value=os.terminal_size((120, 40)))
        term.start()
        self.addCleanup(term.stop)
        cls_patch = mock.patch("os.system")
        cls_patch.start()
        self.addCleanup(cls_patch.stop)

    def _run_ui(self, keys, inputs=None, sizes=None, contents=None, root=ROOT, patches=(), term=None):
        """注入按键序列/input 返回值/终端尺寸序列运行 interactive_ui。

        patches: 需在 UI 运行期间生效的 patcher 列表；返回的 mocks 与 patches 一一
        对应（便于 call/未调用断言）。返回 (结果, 渲染输出, mocks)。
        """
        sizes = sizes if sizes is not None else {}
        contents = contents if contents is not None else {}
        buf = io.StringIO()
        with contextlib.ExitStack() as stack:
            stack.enter_context(mock.patch.object(tui, "_getch", side_effect=keys))
            if inputs is not None:
                stack.enter_context(mock.patch("builtins.input", side_effect=inputs))
            else:
                stack.enter_context(mock.patch("builtins.input", return_value=""))
            if term is not None:
                stack.enter_context(mock.patch("shutil.get_terminal_size", side_effect=term))
            mocks = [stack.enter_context(p) for p in patches]
            with contextlib.redirect_stdout(buf):
                result = tui.interactive_ui(root, sizes, contents, "test-driver")
        return result, buf.getvalue(), mocks


class StatusBarTests(_TuiBase):
    """状态栏：根/当前路径/数据时间/键位缩写 + ANSI 反转色 + 路径联动。"""

    def test_status_bar_shows_root_current_data_and_key_hints(self):
        contents = {ROOT: [("a.txt", False, 5)]}
        result, output, _ = self._run_ui([b"q"], sizes={ROOT: 5}, contents=contents)
        self.assertEqual(result, ("quit", None))
        self.assertIn("根: " + str(ROOT), output)
        self.assertIn("当前: " + str(ROOT), output)
        self.assertIn("数据: ", output)
        self.assertRegex(output, r"数据: \d{2}:\d{2}")
        self.assertIn("r轻", output)
        self.assertIn("R深", output)
        self.assertIn("S存", output)
        self.assertIn("H比", output)

    def test_status_bar_reverse_video_when_ansi_available(self):
        tui._ANSI_AVAILABLE = True
        result, output, _ = self._run_ui([b"q"], sizes={ROOT: 1})
        self.assertEqual(result, ("quit", None))
        self.assertIn("\x1b[7m", output)  # 反转色起始转义
        self.assertIn("\x1b[0m", output)  # 复位转义
        self.assertIn("根: " + str(ROOT), output)

    def test_status_bar_current_path_follows_navigation(self):
        contents = {
            ROOT: [("Docs", True, 100), ("a.txt", False, 5)],
            ROOT / "Docs": [("f1.txt", False, 1)],
        }
        sizes = {ROOT: 105, ROOT / "Docs": 100}
        result, output, _ = self._run_ui([b"\r", b"q"], sizes=sizes, contents=contents)
        self.assertEqual(result, ("quit", None))
        self.assertIn("当前: " + str(ROOT / "Docs"), output)


class FirstLaunchGuideTests(_TuiBase):
    """首启引导：模块标志复位后仅打印一次；数据目录存在/缺失两分支；探测函数两分支。"""

    def _reset_guide_flag(self):
        self._orig = tui._FIRST_LAUNCH_GUIDE_SHOWN
        self.addCleanup(setattr, tui, "_FIRST_LAUNCH_GUIDE_SHOWN", self._orig)

    def test_guide_printed_when_data_dir_missing_after_flag_reset(self):
        self._reset_guide_flag()
        tui._FIRST_LAUNCH_GUIDE_SHOWN = False
        with mock.patch.object(tui, "_first_launch_data_missing", return_value=True):
            result, output, _ = self._run_ui([b"q"])
        self.assertEqual(result, ("quit", None))
        self.assertIn("首启引导", output)
        self.assertIn("Everything", output)
        self.assertTrue(tui._FIRST_LAUNCH_GUIDE_SHOWN, "引导后模块标志应置位")

    def test_guide_not_printed_second_time(self):
        self._reset_guide_flag()
        tui._FIRST_LAUNCH_GUIDE_SHOWN = True  # 第一次进入已消费
        with mock.patch.object(tui, "_first_launch_data_missing", return_value=True) as detect:
            result, output, _ = self._run_ui([b"q"])
        self.assertEqual(result, ("quit", None))
        self.assertNotIn("首启引导", output)
        detect.assert_not_called()  # 标志已置位 → 不再检测也不再打印

    def test_guide_skipped_when_data_dir_present(self):
        self._reset_guide_flag()
        tui._FIRST_LAUNCH_GUIDE_SHOWN = False
        with mock.patch.object(tui, "_first_launch_data_missing", return_value=False):
            result, output, _ = self._run_ui([b"q"])
        self.assertEqual(result, ("quit", None))
        self.assertNotIn("首启引导", output)
        self.assertTrue(tui._FIRST_LAUNCH_GUIDE_SHOWN, "首次检测后标志即置位（检测只发生一次）")

    def test_data_missing_env_branch(self):
        with tempfile.TemporaryDirectory() as tmp:
            gone = str(Path(tmp) / "no-such-dir")
            with mock.patch.dict(os.environ, {"DSA_SNAPSHOT_DIR": gone}):
                self.assertTrue(tui._first_launch_data_missing())
            with mock.patch.dict(os.environ, {"DSA_SNAPSHOT_DIR": tmp}):
                self.assertFalse(tui._first_launch_data_missing())

    def test_data_missing_default_dir_semantics(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            app_dir = base / "program"  # 无 portable.flag
            snap_dir = base / "local" / "PythonDiskScanner" / "snapshots"
            env = dict(os.environ)
            env["LOCALAPPDATA"] = str(base / "local")
            env.pop("DSA_SNAPSHOT_DIR", None)
            env.pop("DSA_NO_SNAPSHOT", None)
            with mock.patch.dict(os.environ, env, clear=True), \
                    mock.patch.object(tui, "get_app_dir", return_value=str(app_dir)):
                self.assertTrue(tui._first_launch_data_missing(), "目录不存在 → 视为缺失")
                snap_dir.mkdir(parents=True)
                self.assertTrue(tui._first_launch_data_missing(), "目录为空 → 仍视为缺失")
                (snap_dir / "dummy.snap.gz").write_text("x", encoding="utf-8")
                self.assertFalse(tui._first_launch_data_missing(), "已有快照数据 → 非首启")


class HelpPageTests(_TuiBase):
    """h 全屏帮助：键位表 / 快照位置 / 口径说明 / 任意键返回列表态。"""

    def test_help_page_prints_key_table_snapshot_dir_and_returns(self):
        contents = {ROOT: [("a.txt", False, 5)]}
        snap_dir = Path("C:\\snapdir")
        result, output, _ = self._run_ui(
            [b"h", b"x", b"q"],
            sizes={ROOT: 5},
            contents=contents,
            patches=[mock.patch.object(tui.snapshots, "get_snapshot_dir", return_value=snap_dir)],
        )
        self.assertEqual(result, ("quit", None))
        self.assertIn("键位表", output)
        self.assertIn("[W/↑]", output)          # KEY_BINDINGS 同源展开
        self.assertIn("保存快照", output)        # S 条目（name/help 字段）
        self.assertIn("快照位置: " + str(snap_dir), output)
        self.assertIn("口径说明", output)
        self.assertIn("按任意键返回", output)
        self.assertIn("a.txt", output)          # 任意键后回到列表态（后续渲染仍含列表）

    def test_help_page_returns_to_list_state_without_extra_key(self):
        # 帮助页 _getch 消费的键不会触发动作：b"q" 作为「任意键」返回列表态,
        # 下一轮循环才真正退出 —— 说明帮助页读键隔离、不吞后续按键
        result, output, _ = self._run_ui(
            [b"h", b"q", b"w", b"q"], sizes={ROOT: 1},
            patches=[mock.patch.object(tui.snapshots, "get_snapshot_dir",
                                       return_value=Path("C:\\snapdir"))],
        )
        self.assertEqual(result, ("quit", None))
        self.assertIn("按任意键返回", output)


class HistoryViewTests(_TuiBase):
    """H 历史对比模态：无快照 / 序号列表 / 选择 / 渲染 / CompareError 红字。"""

    SNAP1 = Path("C:\\snaps\\C_20260822_103000_explicit_abcd1234.snap.gz")
    SNAP2 = Path("C:\\snaps\\C_20260821_090000_explicit_abcd1234.snap.gz")

    def test_history_no_snapshots_shows_prompt(self):
        result, output, _ = self._run_ui(
            [b"H", b"q"],
            patches=[mock.patch.object(tui.snapshots, "list_snapshots", return_value=[])],
        )
        self.assertEqual(result, ("quit", None))
        self.assertIn("该根暂无历史快照", output)

    def test_history_lists_snapshots_and_renders_diff_rows(self):
        sizes = {ROOT: 100}
        baseline = {
            "header": {"created_at": "2026-08-22T10:30:00", "root": str(ROOT)},
            "rows": [{"p": str(ROOT), "s": 100}],
        }
        diff = {
            "root": str(ROOT),
            "total_baseline": 100,
            "total_current": 500,
            "delta_total": 400,
            "rows": [
                {"path": "C:\\big", "baseline": 0, "current": 500, "delta": 500,
                 "growth_pct": None, "removed": False, "added": True},
                {"path": "C:\\small", "baseline": 100, "current": 0, "delta": -100,
                 "growth_pct": None, "removed": True, "added": False},
            ],
            "truncated": False,
        }
        patches = [
            mock.patch.object(tui.snapshots, "list_snapshots", return_value=[self.SNAP1, self.SNAP2]),
            mock.patch.object(tui.snapshots, "load_snapshot", return_value=baseline),
            mock.patch.object(tui.compare, "diff_from_current", return_value=diff),
        ]
        result, output, mocks = self._run_ui(
            [b"H", b"x", b"q"], inputs=[""], sizes=sizes, patches=patches)
        self.assertEqual(result, ("quit", None))
        # 序号列表（最近在前，显示文件名+时间）
        self.assertIn("1. " + self.SNAP1.name + " (2026-08-22 10:30:00)", output)
        self.assertIn("2. " + self.SNAP2.name + " (2026-08-21 09:00:00)", output)
        # 空回车=取最新 → 加载最新快照并与当前 sizes 对比
        mocks[1].assert_called_once_with(self.SNAP1)
        mocks[2].assert_called_once()
        self.assertEqual(mocks[2].call_args[0][0], sizes)
        self.assertEqual(mocks[2].call_args[0][1], baseline["rows"])
        # 标题 + format_row 增量降序渲染
        self.assertIn("历史对比: 2026-08-22 10:30:00 → 当前", output)
        self.assertIn("C:\\big", output)
        self.assertIn("+500.00 B", output)
        self.assertIn("C:\\small", output)
        self.assertIn("-100.00 B", output)
        self.assertIn("按任意键返回", output)

    def test_history_index_selects_specific_snapshot(self):
        loaded = []

        def fake_load(path):
            loaded.append(Path(path))
            if Path(path) == self.SNAP2:
                return {"header": {"created_at": "2026-08-21T09:00:00"}, "rows": []}
            return {"header": {"created_at": "2026-08-22T10:30:00"}, "rows": []}

        diff = {"root": str(ROOT), "rows": [], "truncated": False,
                "total_baseline": 0, "total_current": 0, "delta_total": 0}
        patches = [
            mock.patch.object(tui.snapshots, "list_snapshots", return_value=[self.SNAP1, self.SNAP2]),
            mock.patch.object(tui.snapshots, "load_snapshot", side_effect=fake_load),
            mock.patch.object(tui.compare, "diff_from_current", return_value=diff),
        ]
        result, output, _ = self._run_ui([b"H", b"x", b"q"], inputs=["2"], patches=patches)
        self.assertEqual(result, ("quit", None))
        self.assertEqual(loaded, [self.SNAP2], "输入序号 2 应选中第 2 条（较旧）快照")
        self.assertIn("历史对比: 2026-08-21 09:00:00 → 当前", output)

    def test_history_invalid_index_and_non_numeric_show_banner(self):
        patches = [
            mock.patch.object(tui.snapshots, "list_snapshots", return_value=[self.SNAP1]),
            mock.patch.object(tui.snapshots, "load_snapshot"),
            mock.patch.object(tui.compare, "diff_from_current"),
        ]
        result, output, mocks = self._run_ui([b"H", b"x", b"q"], inputs=["99"], patches=patches)
        self.assertEqual(result, ("quit", None))
        self.assertIn("无效序号", output)
        mocks[2].assert_not_called()  # 越界序号不进入对比
        result2, output2, mocks2 = self._run_ui([b"H", b"q"], inputs=["abc"], patches=patches)
        self.assertEqual(result2, ("quit", None))
        self.assertIn("无效序号", output2)
        mocks2[2].assert_not_called()

    def test_history_compare_error_shows_red_text_and_returns(self):
        tui._ANSI_AVAILABLE = True  # 红字仅在 ANSI 模式附加转义（本测试显式开启）
        baseline = {"header": {"created_at": "2026-08-22T10:30:00"}, "rows": []}
        patches = [
            mock.patch.object(tui.snapshots, "list_snapshots", return_value=[self.SNAP1]),
            mock.patch.object(tui.snapshots, "load_snapshot", return_value=baseline),
            mock.patch.object(tui.compare, "diff_from_current",
                              side_effect=compare.CompareError(
                                  "当前树与快照路径跨盘（根不一致），拒绝对比")),
        ]
        result, output, _ = self._run_ui([b"H", b"x", b"q"], inputs=[""], patches=patches)
        self.assertEqual(result, ("quit", None))
        self.assertIn("\x1b[31m", output)          # 红字转义
        self.assertIn("跨盘", output)              # 原因（中文）打印
        self.assertNotIn("按任意键返回", output)    # 错误路径立即返回列表态，无读键

    def test_history_renders_real_compare_engine_rows(self):
        baseline_rows = [
            {"p": str(ROOT), "s": 1000},
            {"p": str(ROOT / "a"), "s": 100},
            {"p": str(ROOT / "gone"), "s": 500},
        ]
        baseline = {"header": {"created_at": "2026-08-22T10:30:00", "root": str(ROOT)},
                    "rows": baseline_rows}
        sizes = {ROOT: 3000, ROOT / "a": 200}
        patches = [
            mock.patch.object(tui.snapshots, "list_snapshots", return_value=[self.SNAP1]),
            mock.patch.object(tui.snapshots, "load_snapshot", return_value=baseline),
        ]
        result, output, _ = self._run_ui(
            [b"H", b"x", b"q"], inputs=[""], sizes=sizes, patches=patches)
        self.assertEqual(result, ("quit", None))
        self.assertIn("历史对比: 2026-08-22 10:30:00 → 当前", output)
        for path_text in (str(ROOT), str(ROOT / "a"), str(ROOT / "gone")):
            self.assertIn(path_text, output)
        self.assertIn("按任意键返回", output)


class SaveSnapshotTests(_TuiBase):
    """S 保存：成功 / 禁用 / SnapshotBusyError / OSError / ValueError 五态。"""

    def test_save_success_prints_message_and_path(self):
        sizes = {ROOT: 100, ROOT / "a": 50}
        saved_path = Path("C:\\snaps\\C_20260822_103000_explicit_abcd1234.snap.gz")
        patches = [
            mock.patch.object(tui.snapshots, "is_snapshot_disabled", return_value=False),
            mock.patch.object(tui.snapshots, "save_snapshot", return_value=saved_path),
        ]
        result, output, mocks = self._run_ui([b"S", b"q"], sizes=sizes, patches=patches)
        self.assertEqual(result, ("quit", None))
        self.assertIn("快照已保存", output)
        self.assertIn(str(saved_path), output)
        expected_rows = [{"p": str(p), "s": int(v)} for p, v in sizes.items()]
        mocks[1].assert_called_once()
        self.assertEqual(mocks[1].call_args[0][0], ROOT)          # root = 当前根路径
        self.assertEqual(mocks[1].call_args[0][1], expected_rows)  # rows 构造
        self.assertEqual(mocks[1].call_args[1], {"auto": False})

    def test_save_busy_shows_warning(self):
        patches = [
            mock.patch.object(tui.snapshots, "is_snapshot_disabled", return_value=False),
            mock.patch.object(tui.snapshots, "save_snapshot",
                              side_effect=snapshots.SnapshotBusyError(
                                  "另一个快照保存正在进行（锁文件已存在）")),
        ]
        result, output, _ = self._run_ui([b"S", b"q"], sizes={ROOT: 1}, patches=patches)
        self.assertEqual(result, ("quit", None))
        self.assertIn("快照保存失败", output)
        self.assertIn("锁文件已存在", output)

    def test_save_os_error_shows_warning(self):
        patches = [
            mock.patch.object(tui.snapshots, "is_snapshot_disabled", return_value=False),
            mock.patch.object(tui.snapshots, "save_snapshot", side_effect=OSError("磁盘只读")),
        ]
        result, output, _ = self._run_ui([b"S", b"q"], sizes={ROOT: 1}, patches=patches)
        self.assertEqual(result, ("quit", None))
        self.assertIn("快照保存失败", output)
        self.assertIn("磁盘只读", output)

    def test_save_value_error_shows_warning(self):
        patches = [
            mock.patch.object(tui.snapshots, "is_snapshot_disabled", return_value=False),
            mock.patch.object(tui.snapshots, "save_snapshot",
                              side_effect=ValueError("快照行数 600000 超过上限")),
        ]
        result, output, _ = self._run_ui([b"S", b"q"], sizes={ROOT: 1}, patches=patches)
        self.assertEqual(result, ("quit", None))
        self.assertIn("快照保存失败", output)
        self.assertIn("超过上限", output)

    def test_save_disabled_no_call(self):
        patches = [
            mock.patch.object(tui.snapshots, "is_snapshot_disabled", return_value=True),
            mock.patch.object(tui.snapshots, "save_snapshot"),
        ]
        result, output, mocks = self._run_ui([b"S", b"q"], sizes={ROOT: 1}, patches=patches)
        self.assertEqual(result, ("quit", None))
        self.assertIn("已禁用", output)
        mocks[1].assert_not_called()


class TerminalGateTests(_TuiBase):
    """终端行门：<12 行只显示居中提示 + 状态栏、不渲染列表；resize 后恢复。"""

    def test_small_terminal_shows_banner_only_and_still_quits(self):
        contents = {ROOT: [("secret.txt", False, 1)]}
        term = iter([os.terminal_size((120, 11))])  # 11 行 < MIN_TERM_HEIGHT
        result, output, _ = self._run_ui(
            [b"Q"], sizes={ROOT: 1}, contents=contents, term=term)
        self.assertEqual(result, ("quit", None))
        self.assertIn("终端过小", output)          # 居中提示（banner）
        self.assertIn("根: " + str(ROOT), output)  # 仅状态栏仍在
        self.assertNotIn("secret.txt", output)     # 跳过列表渲染
        self.assertNotIn("当前路径:", output)      # 头部一并跳过
        self.assertNotIn("操作指引", output)       # 帮助行一并跳过

    def test_small_terminal_resize_recovers(self):
        contents = {ROOT: [("notice.txt", False, 1)]}
        term = iter([os.terminal_size((120, 11)), os.terminal_size((120, 40))])
        result, output, _ = self._run_ui(
            [b"w", b"q"], sizes={ROOT: 1}, contents=contents, term=term)
        self.assertEqual(result, ("quit", None))
        self.assertIn("终端过小", output)     # 第一轮：过小提示
        self.assertIn("notice.txt", output)  # resize 后第二轮恢复正常渲染
        self.assertIn("操作指引", output)


if __name__ == "__main__":
    unittest.main()