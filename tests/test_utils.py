"""utils 模块单元测试：human_size 大小格式化与 log 的 VERBOSE 开关行为。

全部为纯函数/模块级开关测试，不涉及真实环境；log 测试通过内置 print
打桩与 VERBOSE 全局的读写/恢复保证独立性与可重复性。
"""

import io
import unittest
from contextlib import redirect_stdout
from unittest import mock

from utils import VERBOSE, human_size, log


class HumanSizeTests(unittest.TestCase):
    """human_size：0/负值/常规/单位边界/PB 边界/舍入的确定性格式化。"""

    def test_human_size_zero(self):
        """0 字节输出 '0.00 B'（第一档即命中，不进除法）。"""
        self.assertEqual(human_size(0), "0.00 B")

    def test_human_size_negative(self):
        """负值原样透出（仍按字节档格式化，不崩溃）。"""
        self.assertEqual(human_size(-5), "-5.00 B")

    def test_human_size_small_bytes(self):
        """1024 以下输出字节档，两位小数补齐。"""
        self.assertEqual(human_size(1), "1.00 B")
        self.assertEqual(human_size(371), "371.00 B")
        self.assertEqual(human_size(1023), "1023.00 B")

    def test_human_size_unit_boundaries(self):
        """2 的 10 次幂整数倍恰好对应 KB/MB/GB/TB 各档边界。"""
        self.assertEqual(human_size(1024), "1.00 KB")
        self.assertEqual(human_size(1024 ** 2), "1.00 MB")
        self.assertEqual(human_size(1024 ** 3), "1.00 GB")
        self.assertEqual(human_size(1024 ** 4), "1.00 TB")

    def test_human_size_fractional(self):
        """非整数倍输出精确到两位小数。"""
        self.assertEqual(human_size(1536), "1.50 KB")       # 1.5 KB
        # 1049088 / 1024 = 1024.5 仍不小于 1024，继续进位到 MB 后舍入
        self.assertEqual(human_size(1024 ** 2 + 512), "1.00 MB")

    def test_human_size_pb_boundary(self):
        """PB 档边界：2**50 恰为 1.00 PB；再大 1024 倍输出 1024.00 PB。"""
        self.assertEqual(human_size(2 ** 50), "1.00 PB")
        self.assertEqual(human_size(2 ** 50 + 2 ** 49), "1.50 PB")
        self.assertEqual(human_size(2 ** 60), "1024.00 PB")

    def test_human_size_tb_rounding_artifact(self):
        """2**50-1 仍小于 1024 TB，但两位小数舍入后显示 '1024.00 TB'（锁定现有行为）。"""
        self.assertEqual(human_size(2 ** 50 - 1), "1024.00 TB")


class LogVerboseTests(unittest.TestCase):
    """log 的 VERBOSE 模块级开关与 verbose 参数覆盖行为。"""

    def setUp(self):
        # 记录并恢复调用前的 VERBOSE，保证测试相互独立
        self._original_verbose = VERBOSE
        self.addCleanup(setattr, __import__("utils"), "VERBOSE", self._original_verbose)

    def test_verbose_true_prints(self):
        """VERBOSE=True 时 log 调用 print 输出消息。"""
        with mock.patch("builtins.print") as fake_print:
            log("hello")
        fake_print.assert_called_once_with("hello", end="\n", flush=False)

    def test_verbose_false_silent(self):
        """VERBOSE=False 时 log 不产生任何输出。"""
        utils = __import__("utils")
        utils.VERBOSE = False
        with mock.patch("builtins.print") as fake_print:
            log("should not print")
        fake_print.assert_not_called()

    def test_verbose_param_overrides_global(self):
        """verbose 参数显式覆盖模块级开关：全局关 + verbose=True 仍打印。"""
        utils = __import__("utils")
        utils.VERBOSE = False
        with mock.patch("builtins.print") as fake_print:
            log("forced on", verbose=True)
        fake_print.assert_called_once()

    def test_verbose_param_can_suppress(self):
        """全局开 + verbose=False 时静默。"""
        with mock.patch("builtins.print") as fake_print:
            log("forced off", verbose=False)
        fake_print.assert_not_called()

    def test_log_passes_end_flush(self):
        """log 的 end/flush 参数原样透传给 print（进度条刷新路径依赖）。"""
        with mock.patch("builtins.print") as fake_print:
            log("progress", end="", flush=True)
        fake_print.assert_called_once_with("progress", end="", flush=True)

    def test_log_verbose_false_quiet_via_stdout(self):
        """等价验证：关闭 verbose 后 stdout 无任何内容（不经 print 打桩）。"""
        utils = __import__("utils")
        utils.VERBOSE = False
        buf = io.StringIO()
        with redirect_stdout(buf):
            log("silent line")
        self.assertEqual(buf.getvalue(), "")


if __name__ == "__main__":
    unittest.main()