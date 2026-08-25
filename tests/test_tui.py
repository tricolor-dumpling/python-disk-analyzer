"""tui 模块单元测试：interactive_ui 的空目录边界 / 导航 / 退出 / C 切换 / 异常透传。

- 全链路 patch tui._getch（C3 后为模块内真实函数），清屏走 _ANSI_AVAILABLE=False
  回退分支，os.system 兜底打桩，杜绝 ANSI 转义与真实 cls 输出；
- 屏幕尺寸打桩为固定值，保证列表渲染确定；
- MsvcrtUnavailableError 透传语义：_getch 缺失 msvcrt 时抛出，interactive_ui 不吞。

不依赖真实终端输入；所有按键序列全部注入。
"""

import contextlib
import io
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import tui
from exceptions import MsvcrtUnavailableError

ROOT = Path("C:\\Users\\Test")


class InteractiveUiTests(unittest.TestCase):
    """interactive_ui 主循环：空目录方向键不越界、导航、Q 退出、C 切换。"""

    def setUp(self):
        # 关闭 ANSI 渲染：清屏走 os.system('cls') 回退（打桩），输出全部进 stdout 缓冲
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

    def _run_ui(self, keys, inputs=None, sizes=None, contents=None, root=ROOT):
        """注入按键序列与 input 返回值运行 interactive_ui，返回 (结果, 渲染输出)。"""
        sizes = sizes if sizes is not None else {}
        contents = contents if contents is not None else {}
        buf = io.StringIO()
        with contextlib.ExitStack() as stack:
            stack.enter_context(mock.patch.object(tui, "_getch", side_effect=keys))
            if inputs is not None:
                stack.enter_context(mock.patch("builtins.input", side_effect=inputs))
            else:
                stack.enter_context(mock.patch("builtins.input", return_value=""))
            with contextlib.redirect_stdout(buf):
                result = tui.interactive_ui(root, sizes, contents, "test-driver")
        return result, buf.getvalue()

    def test_empty_dir_arrow_keys_do_not_overrun(self):
        """空目录下方向键（ANSI 前缀/单键/回车）全部安全无操作，Q 正常退出。"""
        keys = [b"\xe0", b"H", b"\xe0", b"P", b"w", b"s", b"\r", b"Q"]
        result, output = self._run_ui(keys)
        self.assertEqual(result, ("quit", None))
        self.assertIn("空文件夹", output)

    def test_enter_subdir_and_backspace(self):
        """Enter 进入子目录、Backspace 返回上级，路径切换反映在渲染输出。"""
        contents = {
            ROOT: [("Docs", True, 200), ("a.txt", False, 5)],
            ROOT / "Docs": [("f1.txt", False, 1)],
        }
        sizes = {ROOT: 205, ROOT / "Docs": 200}
        keys = [b"\r", b"\x08", b"q"]
        result, output = self._run_ui(keys, sizes=sizes, contents=contents)
        self.assertEqual(result, ("quit", None))
        # Enter 后渲染到子目录，再 Backspace 回到根
        self.assertIn("当前路径: C:\\Users\\Test\\Docs", output)
        self.assertIn("f1.txt", output)
        self.assertIn("当前路径: C:\\Users\\Test\n", output.replace("\r", ""))

    def test_q_exits_immediately(self):
        """Q 键直接返回 ('quit', None)。"""
        result, _ = self._run_ui([b"Q"])
        self.assertEqual(result, ("quit", None))

    def test_c_cancel_with_empty_input(self):
        """C 输入为空（取消）回到 UI 继续，不切换路径。"""
        keys = [b"C", b"q"]
        inputs = [""]
        result, output = self._run_ui(keys, inputs=inputs)
        self.assertEqual(result, ("quit", None))
        self.assertIn("请输入新的扫描路径", output)

    def test_c_change_to_valid_path(self):
        """C 输入存在的路径返回 ('change', 解析后路径)。"""
        with tempfile.TemporaryDirectory() as tmp:
            keys = [b"C"]
            inputs = [tmp]
            result, _ = self._run_ui(keys, inputs=inputs)
            self.assertEqual(result[0], "change")
            self.assertEqual(Path(result[1]), Path(tmp).resolve())

    def test_c_invalid_path_keeps_ui(self):
        """C 输入不存在的路径提示后返回 UI 继续（任意键 + Q 退出）。"""
        keys = [b"C", b"x", b"q"]
        inputs = ["Z:\\definitely\\not\\here"]
        result, output = self._run_ui(keys, inputs=inputs)
        self.assertEqual(result, ("quit", None))
        self.assertIn("路径不存在", output)

    def test_display_renders_driver_and_size(self):
        """界面渲染包含驱动名与当前目录总计大小。"""
        sizes = {ROOT: 123456}
        result, output = self._run_ui([b"q"], sizes=sizes)
        self.assertEqual(result, ("quit", None))
        self.assertIn("test-driver", output)
        self.assertIn("120.56 KB", output)  # human_size(123456)


class GetchTests(unittest.TestCase):
    """_getch 与 MsvcrtUnavailableError 透传语义。"""

    def test_getch_raises_without_msvcrt(self):
        """msvcrt 缺失时 _getch 抛 MsvcrtUnavailableError，中文提示。"""
        original = tui.msvcrt
        self.addCleanup(setattr, tui, "msvcrt", original)
        tui.msvcrt = None
        with self.assertRaises(MsvcrtUnavailableError) as ctx:
            tui._getch()
        self.assertIn("msvcrt", str(ctx.exception))

    def test_msvcrt_unavailable_propagates_from_ui(self):
        """interactive_ui 不吞 _getch 抛出的 MsvcrtUnavailableError（透传给 main）。"""
        original = tui._ANSI_AVAILABLE
        self.addCleanup(setattr, tui, "_ANSI_AVAILABLE", original)
        tui._ANSI_AVAILABLE = False
        with mock.patch.object(
            tui, "_getch",
            side_effect=MsvcrtUnavailableError("本程序交互界面依赖 Windows 的 msvcrt 模块"),
        ), contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(MsvcrtUnavailableError):
                tui.interactive_ui(ROOT, {}, {}, "test-driver")


class ClampSelectionTests(unittest.TestCase):
    """P12·W1.5：_clamp_selection 纯函数边界。"""

    def test_clamp_selection_boundaries(self):
        self.assertEqual(tui._clamp_selection(-3, 2), 0)
        self.assertEqual(tui._clamp_selection(5, 2), 1)
        self.assertEqual(tui._clamp_selection(0, 0), 0)
        self.assertEqual(tui._clamp_selection(2, 0), 0)
        self.assertEqual(tui._clamp_selection(1, 3), 1)
        self.assertEqual(tui._clamp_selection(-1, 0), 0)


class _SyncThread:
    """同步执行的 Thread 替身：start() 立即运行 target（深刷收缩夹具用）。"""

    def __init__(self, target=None, args=(), daemon=None, name=None):
        self._target = target
        self._args = args

    def start(self):
        self._target(*self._args)

    def join(self, timeout=None):  # pragma: no cover - 夹具不依赖 join
        pass


class DeepRefreshShrinkTests(unittest.TestCase):
    """P12·W1.5：深刷收缩夹具下 ↑/Enter 不抛 IndexError（修复前稳定崩溃）。"""

    def setUp(self):
        self._ansi = tui._ANSI_AVAILABLE
        self.addCleanup(setattr, tui, "_ANSI_AVAILABLE", self._ansi)
        tui._ANSI_AVAILABLE = False
        term = mock.patch("shutil.get_terminal_size",
                          return_value=os.terminal_size((120, 40)))
        term.start()
        self.addCleanup(term.stop)
        cls_patch = mock.patch("os.system")
        cls_patch.start()
        self.addCleanup(cls_patch.stop)

    def _run_shrink(self, keys):
        """大目录 → 深刷收缩至 1 项的夹具：返回 (结果, 渲染输出)。

        初始 ROOT 有 3 个子项；按 R 触发深刷，deep_refresh 返回仅剩 1 个子目录
        的小树；threading.Thread 打桩为同步执行，深刷在按键处理内完成。
        """
        big_contents = {
            ROOT: [("a", True, 30), ("b", True, 20), ("c.txt", False, 10)],
        }
        small_sizes = {ROOT / "OnlyDir": 5, ROOT: 5}
        small_contents = {
            ROOT: [("OnlyDir", True, 5)],
            ROOT / "OnlyDir": [],
        }
        buf = io.StringIO()
        with contextlib.ExitStack() as stack:
            stack.enter_context(mock.patch.object(tui, "_getch", side_effect=list(keys)))
            stack.enter_context(mock.patch("tui.threading.Thread", _SyncThread))
            stack.enter_context(mock.patch.object(
                tui, "deep_refresh", return_value=(small_sizes, small_contents)
            ))
            with contextlib.redirect_stdout(buf):
                result = tui.interactive_ui(ROOT, {ROOT: 60}, big_contents, "test-driver")
        return result, buf.getvalue()

    def test_deep_refresh_shrink_no_indexerror(self):
        """下移两次→深刷收缩→上移→Enter→退出：全程不抛 IndexError 且正常退出。

        （修复前：收缩后 selected_idx==2 越界，↑ 后 Enter 访问 items[2] 稳定崩溃）
        """
        keys = [b"\xe0P", b"\xe0P", b"R", b"\xe0H", b"\r", b"Q"]
        result, output = self._run_shrink(keys)
        self.assertEqual(result, ("quit", None))

    def test_selection_after_shrink_is_valid(self):
        """收缩后按 ↓ 再 Enter 进入现存子目录，输出含其路径。"""
        keys = [b"\xe0P", b"\xe0P", b"R", b"\xe0P", b"\r", b"Q"]
        result, output = self._run_shrink(keys)
        self.assertEqual(result, ("quit", None))
        expected = str(ROOT / "OnlyDir")
        self.assertIn(expected, output.replace("\r", ""), "Enter 应回退到合法选中项并进入 OnlyDir")


if __name__ == "__main__":
    unittest.main()