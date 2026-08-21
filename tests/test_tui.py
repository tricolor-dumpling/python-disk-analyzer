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


if __name__ == "__main__":
    unittest.main()