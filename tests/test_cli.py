"""cli 模块单元测试：main 的致命出口路径与成功装配流程。

- 路径不存在 → _fatal(SystemExit code=1)；
- EverythingEnvironmentError 捕获 → _fatal(SystemExit code=1)；
- 扫描失败 → 提示后 SystemExit(1)；
- interactive_ui 抛 MsvcrtUnavailableError → _exit_with_error(SystemExit(1))；
- 成功流程（quit）：不退出进程，正常返回。

关键注入点均为 cli 命名空间内 from-import 的绑定（cli.ensure_everything_running /
cli.scan_via_everything_sdk / cli.interactive_ui），不依赖 main 的 _MainModule 转发；
input 经 builtins 打桩，确保不触达真实 Everything 进程。
"""

import contextlib
import io
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import cli
from exceptions import EverythingEnvironmentError, MsvcrtUnavailableError


class CliMainTests(unittest.TestCase):
    """cli.main 的致命与成功路径。"""

    def _run_main(self, inputs, ensure_error=None, scan_error=None, ui_error=None):
        """打桩运行 cli.main()，返回 (ret, exc, 输出, ensure, scan, ui)。

        默认 ensure 成功、scan 成功返回空结果、interactive 返回 quit。
        """
        buf = io.StringIO()
        with contextlib.ExitStack() as stack:
            stack.enter_context(mock.patch("builtins.input", side_effect=inputs))
            stack.enter_context(mock.patch.object(cli, "init_windows_job_sandbox"))
            ensure = stack.enter_context(mock.patch.object(cli, "ensure_everything_running"))
            scan = stack.enter_context(
                mock.patch.object(cli, "scan_via_everything_sdk", return_value=({}, {}))
            )
            ui = stack.enter_context(
                mock.patch.object(cli, "interactive_ui", return_value=("quit", None))
            )
            if ensure_error is not None:
                ensure.side_effect = ensure_error
            if scan_error is not None:
                scan.side_effect = scan_error
            if ui_error is not None:
                ui.side_effect = ui_error
            with contextlib.redirect_stdout(buf):
                exc = None
                ret = None
                try:
                    ret = cli.main()
                except SystemExit as e:
                    exc = e
        return ret, exc, buf.getvalue(), ensure, scan, ui

    def test_missing_path_fatal_exit1(self):
        """扫描路径不存在 → SystemExit(1)，文案「指定的扫描路径不存在」，scan/UI 不触达。"""
        with tempfile.TemporaryDirectory() as tmp:
            missing = str(Path(tmp) / "missing_dir")
            ret, exc, output, _, scan, ui = self._run_main([missing])
        self.assertIsNone(ret)
        self.assertEqual(exc.code, 1)
        self.assertIn("指定的扫描路径不存在", output)
        scan.assert_not_called()
        ui.assert_not_called()

    def test_everything_environment_error_fatal(self):
        """ensure_everything_running 抛 EverythingEnvironmentError → SystemExit(1) 且中文文案透出。"""
        error = EverythingEnvironmentError("Everything 环境检查失败：测试注入")
        ret, exc, output, ensure, scan, ui = self._run_main(
            ["C:\\anything"], ensure_error=error,
        )
        self.assertIsNone(ret)
        self.assertEqual(exc.code, 1)
        self.assertIn("Everything 环境检查失败：测试注入", output)
        ensure.assert_called_once_with()
        scan.assert_not_called()
        ui.assert_not_called()

    def test_scan_failure_exit1(self):
        """scan 抛异常 → 打印「扫描失败」与提示，等待按键后 SystemExit(1)。"""
        with tempfile.TemporaryDirectory() as tmp:
            ret, exc, output, _, _, _ = self._run_main(
                [tmp, "任意键"], scan_error=RuntimeError("测试扫描失败"),
            )
        self.assertIsNone(ret)
        self.assertEqual(exc.code, 1)
        self.assertIn("扫描失败: 测试扫描失败", output)
        self.assertIn("请检查 Everything 是否正常运行", output)

    def test_msvcrt_unavailable_from_interactive_fatal(self):
        """interactive_ui 抛 MsvcrtUnavailableError → _exit_with_error → SystemExit(1)，文案含 msvcrt。"""
        with tempfile.TemporaryDirectory() as tmp:
            error = MsvcrtUnavailableError("本程序交互界面依赖 Windows 的 msvcrt 模块")
            ret, exc, output, _, _, _ = self._run_main([tmp], ui_error=error)
        self.assertIsNone(ret)
        self.assertEqual(exc.code, 1)
        self.assertIn("msvcrt", output)

    def test_success_flow_quit_returns_cleanly(self):
        """全链路成功：path 存在 → 扫描 → interactive 返回 quit → 正常退出进程（无 SystemExit）。"""
        with tempfile.TemporaryDirectory() as tmp:
            resolved = Path(tmp).resolve()
            ret, exc, output, _, scan, ui = self._run_main([tmp])
        self.assertIsNone(exc)
        self.assertIsNone(ret)
        self.assertIn("已安全退出", output)
        scan.assert_called_once()
        self.assertEqual(ui.call_args[0][0], resolved, "传给 UI 的根路径应为解析后路径")


if __name__ == "__main__":
    unittest.main()