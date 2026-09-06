"""任务 D5 路径跳转/模态 单元测试：共享校验管线、输入历史、keyrouter '/' 注册、UI 集成。

覆盖：
- tui._validate_jump_target：根内绝对/相对/正反斜杠/尾分隔符 → ok；越界 →
  E_OUT_OF_ROOT；不存在/文件 → E_PATH_NOT_FOUND；空输入 → 取消（error_id=None）；
- 输入历史：仅成功才入（UI 集成验证）、去重、上限 16、失效灰显/不可选（模拟路径删除）；
- keyrouter：'/' 已注册到 ACT_PATH_JUMP、帮助文案含 "[/] 跳转"、注册表条目完整；
- interactive_ui 集成：/ 跳转更新当前路径、取消/失败不动路径、未知目录兜底不崩溃、
  模态内历史列示与序号选择。

不依赖真实终端：全部按键与 input() 注入，清屏走打桩分支（与 tests/test_tui.py 同款）。
"""

import contextlib
import io
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import keyrouter
import tui
from messages import render_message


class JumpValidationTests(unittest.TestCase):
    """_validate_jump_target：规范化、越界、存在性、空输入（表驱动）。"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        root = Path(self._tmp.name) / "root"
        root.mkdir()
        self.root = root
        self.sub = root / "sub"
        self.sub.mkdir()
        self.inner = root / "deep" / "inner"
        self.inner.mkdir(parents=True)
        self.txt = root / "a.txt"
        with open(self.txt, "w", encoding="utf-8") as fh:
            fh.write("x")

    def test_absolute_path_within_root_ok(self):
        ok, normalized, error_id = tui._validate_jump_target(str(self.sub), self.root)
        self.assertTrue(ok)
        self.assertEqual(normalized, str(self.sub.resolve()))
        self.assertIsNone(error_id)

    def test_scan_root_itself_ok(self):
        ok, normalized, error_id = tui._validate_jump_target(str(self.root), self.root)
        self.assertTrue(ok)
        self.assertEqual(normalized, str(self.root.resolve()))
        self.assertIsNone(error_id)

    def test_forward_slashes_ok(self):
        target = str(self.sub).replace("\\", "/")
        ok, normalized, error_id = tui._validate_jump_target(target, self.root)
        self.assertTrue(ok)
        self.assertEqual(normalized, str(self.sub.resolve()))

    def test_trailing_separator_ok(self):
        target = str(self.sub) + "\\"
        ok, normalized, error_id = tui._validate_jump_target(target, self.root)
        self.assertTrue(ok)
        self.assertEqual(normalized, str(self.sub.resolve()))

    def test_relative_path_resolved_against_scan_root(self):
        ok, normalized, error_id = tui._validate_jump_target("sub", self.root)
        self.assertTrue(ok)
        self.assertEqual(normalized, str(self.sub.resolve()))

    def test_relative_deep_path_ok(self):
        ok, normalized, error_id = tui._validate_jump_target("deep/inner", self.root)
        self.assertTrue(ok)
        self.assertEqual(normalized, str(self.inner.resolve()))

    @unittest.skipUnless(os.name == "nt", "Windows 路径比较大小写不敏感")
    def test_case_insensitive_within_root_ok(self):
        ok, normalized, error_id = tui._validate_jump_target(str(self.sub).upper(), self.root)
        self.assertTrue(ok)
        self.assertEqual(normalized, str(self.sub.resolve()))

    def test_out_of_root_rejected(self):
        ok, normalized, error_id = tui._validate_jump_target(str(self.root.parent), self.root)
        self.assertFalse(ok)
        self.assertEqual(error_id, "E_OUT_OF_ROOT")
        self.assertIsNone(normalized)

    def test_sibling_out_of_root_rejected_boundary_first(self):
        # 边界优先于存在性：扫描根之外的不存在路径也判越界
        ghost_sibling = str(Path(self._tmp.name) / "ghost")
        ok, normalized, error_id = tui._validate_jump_target(ghost_sibling, self.root)
        self.assertFalse(ok)
        self.assertEqual(error_id, "E_OUT_OF_ROOT")
        self.assertIsNone(normalized)

    def test_nonexistent_target_rejected(self):
        ok, normalized, error_id = tui._validate_jump_target(str(self.root / "ghost"), self.root)
        self.assertFalse(ok)
        self.assertEqual(error_id, "E_PATH_NOT_FOUND")
        self.assertIsNone(normalized)

    def test_file_target_rejected(self):
        ok, normalized, error_id = tui._validate_jump_target(str(self.txt), self.root)
        self.assertFalse(ok)
        self.assertEqual(error_id, "E_PATH_NOT_FOUND")
        self.assertIsNone(normalized)

    def test_empty_and_whitespace_input_is_cancel(self):
        for target in ("", "   "):
            ok, normalized, error_id = tui._validate_jump_target(target, self.root)
            self.assertFalse(ok)
            self.assertIsNone(normalized)
            self.assertIsNone(error_id)


class JumpHistoryTests(unittest.TestCase):
    """输入历史：去重、上限、失效标注（模拟路径删除）。"""

    def test_push_inserts_at_head_and_dedupes(self):
        history = []
        tui._push_jump_history(history, "C:\\a")
        tui._push_jump_history(history, "C:\\b")
        tui._push_jump_history(history, "C:\\a")  # 已存在 → 去重后插到头部
        self.assertEqual(history, ["C:\\a", "C:\\b"])

    def test_push_caps_at_max(self):
        history = []
        for i in range(20):
            tui._push_jump_history(history, "C:\\d%02d" % i)
        self.assertEqual(len(history), tui.JUMP_HISTORY_MAX)
        self.assertEqual(history[0], "C:\\d19")   # 最新在最前
        self.assertEqual(history[-1], "C:\\d04")  # 最旧被截断

    def test_push_returns_same_list(self):
        history = []
        result = tui._push_jump_history(history, "C:\\x")
        self.assertIs(result, history)

    def test_history_status_flags_deleted_path(self):
        # 失效灰显的依据：路径被删除后 is_dir 为 False（模拟路径删除）
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            gone = base / "gone"
            alive = base / "alive"
            gone.mkdir()
            alive.mkdir()
            history = [str(gone), str(alive)]
            self.assertTrue(tui._history_status(history)[0][2])
            gone.rmdir()
            status = tui._history_status(history)
            self.assertFalse(status[0][2])  # 失效 → 灰显不可选
            self.assertTrue(status[1][2])   # 仍存在 → 可选

    def test_history_status_indexes_are_1_based(self):
        status = tui._history_status(["C:\\a", "C:\\b", "C:\\c"])
        self.assertEqual([idx for idx, _, _ in status], [1, 2, 3])


class JumpKeyrouterTests(unittest.TestCase):
    """keyrouter：'/' 注册与帮助文案。"""

    def test_slash_key_maps_to_path_jump(self):
        self.assertEqual(keyrouter.key_to_action(b"/"), keyrouter.ACT_PATH_JUMP)

    def test_help_text_mentions_slash_jump(self):
        self.assertIn("[/] 跳转", keyrouter.help_text())

    def test_registry_entry_has_required_fields(self):
        entry = next(
            e for e in keyrouter.KEY_BINDINGS if e["action"] == keyrouter.ACT_PATH_JUMP
        )
        self.assertEqual(entry["keys"], (b"/",))
        self.assertEqual(entry["display"], "/")
        self.assertEqual(entry["help"], "跳转")
        for field in ("name", "action", "keys", "display", "help"):
            self.assertIn(field, entry)


class JumpUiIntegrationTests(unittest.TestCase):
    """interactive_ui 集成：/ 分支跳转、取消、失败、历史序号选择、未知目录兜底。"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        root = Path(self._tmp.name) / "root"
        root.mkdir()
        self.root = root
        self.sub = root / "sub"
        self.sub.mkdir()

        # 关闭 ANSI 渲染：清屏走 os.system('cls') 回退（打桩），输出全部进 stdout 缓冲
        self._ansi = tui._ANSI_AVAILABLE
        self.addCleanup(setattr, tui, "_ANSI_AVAILABLE", self._ansi)
        tui._ANSI_AVAILABLE = False
        term = mock.patch("shutil.get_terminal_size", return_value=os.terminal_size((120, 40)))
        term.start()
        self.addCleanup(term.stop)
        cls_patch = mock.patch("os.system")
        cls_patch.start()
        self.addCleanup(cls_patch.stop)

    def _run_ui(self, keys, inputs):
        """注入按键序列与 input 返回值运行 interactive_ui，返回 (结果, 渲染输出)。"""
        buf = io.StringIO()
        with contextlib.ExitStack() as stack:
            stack.enter_context(mock.patch.object(tui, "_getch", side_effect=keys))
            stack.enter_context(mock.patch("builtins.input", side_effect=inputs))
            with contextlib.redirect_stdout(buf):
                result = tui.interactive_ui(self.root, {}, {}, "test-driver")
        return result, buf.getvalue()

    def test_slash_jump_updates_current_path_and_records_history(self):
        expected = str(self.sub.resolve())
        push = mock.patch.object(tui, "_push_jump_history", wraps=tui._push_jump_history)
        with push as spy:
            result, output = self._run_ui([b"/", b"q"], [expected])
        self.assertEqual(result, ("quit", None))
        self.assertIn("当前路径: " + expected, output)
        self.assertIn("已按目录跳转", output)  # 不在扫描结果中的目录 → 提示横幅
        self.assertEqual(spy.call_count, 1)   # 成功才入历史
        self.assertEqual(spy.call_args[0][1], expected)

    def test_slash_cancel_with_empty_input_stays(self):
        push = mock.patch.object(tui, "_push_jump_history", wraps=tui._push_jump_history)
        with push as spy:
            result, output = self._run_ui([b"/", b"q"], [""])
        self.assertEqual(result, ("quit", None))
        self.assertIn("路径跳转", output)
        self.assertIn("当前路径: " + str(self.root), output)  # 未切换
        spy.assert_not_called()  # 取消不入历史

    def test_slash_nonexistent_target_shows_error_banner(self):
        push = mock.patch.object(tui, "_push_jump_history", wraps=tui._push_jump_history)
        with push as spy:
            result, output = self._run_ui([b"/", b"q"], [str(self.root / "ghost")])
        self.assertEqual(result, ("quit", None))
        self.assertIn(render_message("E_PATH_NOT_FOUND"), output)
        spy.assert_not_called()

    def test_slash_out_of_root_shows_error_banner(self):
        result, output = self._run_ui([b"/", b"q"], [str(self.root.parent)])
        self.assertEqual(result, ("quit", None))
        self.assertIn(render_message("E_OUT_OF_ROOT"), output)
        self.assertIn("当前路径: " + str(self.root), output)  # 未切换

    def test_slash_modal_lists_history_and_index_selects(self):
        expected = str(self.sub.resolve())
        # 第一次跳转成功入历史；第二次 / 模态列出最近跳转，空输入取消
        result, output = self._run_ui([b"/", b"/", b"q"], [expected, ""])
        self.assertEqual(result, ("quit", None))
        self.assertIn("最近跳转", output)
        self.assertIn("1. " + expected, output)
        # 第三次进入模态输入序号 1 → 走同一校验管线跳回 sub → 直接 q
        result2, _ = self._run_ui([b"/", b"/", b"q"], [expected, "1"])
        self.assertEqual(result2, ("quit", None))

    def test_slash_unscanned_dir_does_not_crash(self):
        inner = self.root / "deep" / "inner"
        inner.mkdir(parents=True)
        result, output = self._run_ui([b"/", b"q"], [str(inner)])
        self.assertEqual(result, ("quit", None))
        self.assertIn("已按目录跳转", output)
        self.assertIn("当前路径: " + str(inner.resolve()), output)


if __name__ == "__main__":
    unittest.main()