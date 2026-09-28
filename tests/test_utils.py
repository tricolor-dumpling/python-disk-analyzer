"""utils 模块单元测试：human_size 大小格式化、log 的 VERBOSE 开关行为与
_reconfigure_std_streams 的 UTF-8 流重配置防御性。

全部为纯函数/模块级开关测试，不涉及真实环境；log 测试通过内置 print
打桩与 VERBOSE 全局的读写/恢复保证独立性与可重复性。流重配置测试只对
mock.patch 出来的临时流生效，绝不触碰测试进程的真实 stdout/stderr。
"""

import io
import unittest
from contextlib import redirect_stdout
from unittest import mock

from utils import VERBOSE, _reconfigure_std_streams, human_size, log


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


class StdStreamReconfigureTests(unittest.TestCase):
    """_reconfigure_std_streams：四类接管场景都不抛异常，TextIOWrapper 类生效。

    全部通过 mock.patch 替换 sys.stdout/sys.stderr（退出即恢复），真实测试
    进程的输出流不被触碰。覆盖：真实 TextIOWrapper（生效）、StringIO（无
    reconfigure 跳过）、二进制流（跳过）、已关闭流（异常被吞）、None（跳过）、
    reconfigure 属性本身抛异常的自定义流（跳过）。
    """

    def test_textiowrapper_reconfigured_to_utf8(self):
        """真实 TextIOWrapper：reconfigure 后 encoding=utf-8、errors=replace（stdout 与 stderr 均生效）。"""
        out = io.TextIOWrapper(io.BytesIO())
        err = io.TextIOWrapper(io.BytesIO())
        self.addCleanup(out.close)
        self.addCleanup(err.close)
        with mock.patch("sys.stdout", out), mock.patch("sys.stderr", err):
            _reconfigure_std_streams()
        self.assertEqual(out.encoding, "utf-8")
        self.assertEqual(out.errors, "replace")
        self.assertEqual(err.encoding, "utf-8")
        self.assertEqual(err.errors, "replace")

    def test_stringio_taken_over_skipped(self):
        """StringIO 接管（测试/嵌入场景）：无 reconfigure，静默跳过且流未被破坏。"""
        out = io.StringIO()
        with mock.patch("sys.stdout", out), mock.patch("sys.stderr", io.StringIO()):
            _reconfigure_std_streams()
        self.assertFalse(hasattr(out, "reconfigure"))
        out.write("仍然可用\n")
        self.assertEqual(out.getvalue(), "仍然可用\n")

    def test_binary_stream_skipped(self):
        """二进制流接管：BytesIO 无 reconfigure，静默跳过。"""
        with mock.patch("sys.stdout", io.BytesIO()), mock.patch("sys.stderr", io.BytesIO()):
            _reconfigure_std_streams()  # 不抛异常即为通过

    def test_none_streams_skipped(self):
        """sys.stdout/stderr 为 None（嵌入/无控制台场景）：静默跳过。"""
        with mock.patch("sys.stdout", None), mock.patch("sys.stderr", None):
            _reconfigure_std_streams()  # 不抛异常即为通过

    def test_closed_stream_exception_swallowed(self):
        """已关闭的 TextIOWrapper：reconfigure 抛出的异常被吞掉，不向外传播。"""
        closed_out = io.TextIOWrapper(io.BytesIO())
        closed_out.close()
        closed_err = io.TextIOWrapper(io.BytesIO())
        closed_err.close()
        with mock.patch("sys.stdout", closed_out), mock.patch("sys.stderr", closed_err):
            _reconfigure_std_streams()  # 不抛异常即为通过

    def test_broken_reconfigure_swallowed(self):
        """reconfigure 属性存在但其调用抛异常的自定义流：异常被吞掉。"""

        class _BrokenStream:
            def reconfigure(self, **kwargs):
                raise RuntimeError("boom")

        with mock.patch("sys.stdout", _BrokenStream()), mock.patch("sys.stderr", _BrokenStream()):
            _reconfigure_std_streams()  # 不抛异常即为通过

    def test_helper_never_raises_in_any_combination(self):
        """组合兜底：真实 TextIOWrapper + StringIO + None 混合配对，两两组合都不抛异常。"""
        combos = [
            (io.TextIOWrapper(io.BytesIO()), io.StringIO()),
            (io.StringIO(), io.TextIOWrapper(io.BytesIO())),
            (None, io.TextIOWrapper(io.BytesIO())),
            (io.TextIOWrapper(io.BytesIO()), None),
        ]
        for out, err in combos:
            with self.subTest(stdout=type(out).__name__, stderr=type(err).__name__):
                with mock.patch("sys.stdout", out), mock.patch("sys.stderr", err):
                    _reconfigure_std_streams()  # 不抛异常即为通过


if __name__ == "__main__":
    unittest.main()