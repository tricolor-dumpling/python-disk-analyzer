"""cli 模块单元测试：main 的致命出口路径、成功装配流程与非交互 Top-N 模式。

- 路径不存在 → _fatal(SystemExit code=1)；
- EverythingEnvironmentError 捕获 → _fatal(SystemExit code=1)；
- 扫描失败 → 提示后 SystemExit(1)；
- interactive_ui 抛 MsvcrtUnavailableError → _exit_with_error(SystemExit(1))；
- 成功流程（quit）：不退出进程，正常返回。
- 非交互模式（提供 target）：Top-N 排序/human_size 版式/合计行正确、退出码 0、
  interactive_ui 不被调用；非法 --top → SystemExit(2)。

关键注入点均为 cli 命名空间内 from-import 的绑定（cli.ensure_everything_running /
cli.scan_via_everything_sdk / cli.interactive_ui），不依赖 main 的 _MainModule 转发；
input 经 builtins 打桩，确保不触达真实 Everything 进程。

注意：cli.main 现接受 argv 参数（argv=None 时读 sys.argv[1:]）。单元测试一律显式
传 argv=[]，避免 unittest discover 模式下把 sys.argv[1:]（如 ['discover', '-s', ...]）
误当作命令行参数解析。
"""

import contextlib
import io
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import cli
import compare
import snapshots

LOCAL_MACHINE_GUID = snapshots.get_machine_guid()
import utils
from exceptions import EverythingEnvironmentError, MsvcrtUnavailableError


class CliEdgeGuardTests(unittest.TestCase):
    """P12·W2.12 CLI 边角：空路径 fatal、prompt EOF/空输入防护。"""

    def test_headless_empty_target_fatal_exit1(self):
        """headless 传 "" → SystemExit(1)＋「扫描路径为空」，未触达 ensure/scan。"""
        buf = io.StringIO()
        with contextlib.ExitStack() as stack:
            ensure = stack.enter_context(mock.patch.object(cli, "ensure_everything_running"))
            scan = stack.enter_context(mock.patch.object(cli, "scan_via_everything_sdk"))
            stack.enter_context(mock.patch.object(cli, "init_windows_job_sandbox"))
            stack.enter_context(contextlib.redirect_stdout(buf))
            try:
                cli.main(argv=[""])
                exc = None
            except SystemExit as e:
                exc = e
        self.assertIsNotNone(exc)
        self.assertEqual(exc.code, 1)
        self.assertIn("扫描路径为空", buf.getvalue())
        ensure.assert_not_called()
        scan.assert_not_called()

    def test_prompt_eof_exits_gracefully(self):
        """管道喂 EOF → 「已取消输入，退出。」+ sys.exit(1)，无 traceback。"""
        buf = io.StringIO()
        with mock.patch("builtins.input", side_effect=EOFError), \
                contextlib.redirect_stdout(buf):
            with self.assertRaises(SystemExit) as ctx:
                cli.prompt_target_drive()
        self.assertEqual(ctx.exception.code, 1)
        self.assertIn("已取消输入", buf.getvalue())

    def test_prompt_keyboard_interrupt_exits_gracefully(self):
        """Ctrl-C 同款优雅退出（exit 1，中文提示）。"""
        buf = io.StringIO()
        with mock.patch("builtins.input", side_effect=KeyboardInterrupt), \
                contextlib.redirect_stdout(buf):
            with self.assertRaises(SystemExit) as ctx:
                cli.prompt_target_drive()
        self.assertEqual(ctx.exception.code, 1)

    def test_prompt_empty_input_retries_then_fatal(self):
        """空输入重问 ≤3 次；有效输入直接返回；三次仍空 → fatal exit 1。"""
        buf = io.StringIO()
        answers = iter(["", "   ", "C:\\Windows"])
        with mock.patch("builtins.input", side_effect=lambda *a: next(answers)), \
                contextlib.redirect_stdout(buf):
            self.assertEqual(cli.prompt_target_drive(), "C:\\Windows")
        self.assertIn("还可尝试", buf.getvalue())

        buf2 = io.StringIO()
        answers2 = iter(["", "", "", ""])
        with mock.patch("builtins.input", side_effect=lambda *a: next(answers2)), \
                contextlib.redirect_stdout(buf2):
            with self.assertRaises(SystemExit) as ctx:
                cli.prompt_target_drive()
        self.assertEqual(ctx.exception.code, 1)
        self.assertIn("扫描路径为空", buf2.getvalue())

    def test_import_main_has_no_dispatcher_names(self):
        """import main 成功且 dispatcher 名字按预期消失（无 AttributeError）。"""
        import importlib

        main_mod = importlib.import_module("main")
        self.assertFalse(hasattr(main_mod, "DispatcherError"))
        self.assertFalse(hasattr(main_mod, "EverythingQueryDispatcher"))


class BaselineReportTotalsTests(unittest.TestCase):
    """P12·W1.2：_print_baseline_report 合计行与对比引擎同口径（CLI==engine）。"""

    def test_cli_totals_equal_engine(self):
        """同一输入下，合计行数字 == human_size(delta_total/total_baseline/total_current)。"""
        baseline_rows = [
            {"p": "C:\\T", "s": 7050},
            {"p": "C:\\T\\sub", "s": 4000},
            {"p": "C:\\T\\sub\\deep", "s": 2500},
        ]
        baseline = {
            "header": {"format": 1, "machine_guid": LOCAL_MACHINE_GUID, "root": "C:\\T",
                       "created_at": "2026-08-24T00:00:00", "auto": False},
            "rows": baseline_rows,
        }
        sizes = {
            Path("C:\\T"): 6050,
            Path("C:\\T\\sub"): 4000,
            Path("C:\\T\\sub\\deep"): 1500,
        }
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            cli._print_baseline_report(baseline, sizes, "fake_baseline.snap.gz", 10)
        output = buf.getvalue()
        engine = compare.diff_from_current(sizes, baseline_rows)
        # 合计行消费引擎的 delta_total（根行口径），而非明细行累加（-550+...）
        self.assertIn(cli.human_size(engine["delta_total"]), output,
                      "合计行必须输出引擎 delta_total（根行口径）")
        self.assertIn(cli.human_size(engine["total_baseline"]), output)
        self.assertIn(cli.human_size(engine["total_current"]), output)
        self.assertEqual(engine["delta_total"], -1000)


class CliMainTests(unittest.TestCase):
    """cli.main 的致命与成功路径。"""

    def _run_main(self, inputs, ensure_error=None, scan_error=None, ui_error=None, argv=None):
        """打桩运行 cli.main(argv)，返回 (ret, exc, 输出, ensure, scan, ui)。

        默认 ensure 成功、scan 成功返回空结果、interactive 返回 quit。
        argv 缺省显式传空列表：不依赖测试发现模式下被污染的 sys.argv（见模块 docstring）；
        交互模式用例可通过 argv=... 传入要解析的命令行参数（如 ['--quiet']）。
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
                    ret = cli.main(argv=argv if argv is not None else [])
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

    def test_interactive_quiet_ignored(self):
        """只给 --quiet、无 target 时进入交互模式，--quiet 同 --top 一样被忽略，输出与不带它逐字一致。"""
        with tempfile.TemporaryDirectory() as tmp:
            ret_plain, exc_plain, output_plain, _, _, _ = self._run_main([tmp])
            ret_quiet, exc_quiet, output_quiet, _, _, _ = self._run_main([tmp], argv=["--quiet"])
        self.assertIsNone(exc_plain)
        self.assertIsNone(exc_quiet)
        self.assertIsNone(ret_quiet)
        self.assertNotEqual(output_plain, "")
        self.assertEqual(output_quiet, output_plain, "--quiet 在交互模式下不得改变任何输出")


class CliHeadlessTests(unittest.TestCase):
    """cli.main 的非交互 Top-N 模式：提供 target 即触发，不进入 TUI。

    注入点同交互模式（cli 命名空间 from-import 绑定）：cli.init_windows_job_sandbox /
    cli.ensure_everything_running / cli.scan_via_everything_sdk / cli.interactive_ui
    均打桩，全程不触达真实 Everything。
    """

    def setUp(self):
        # --quiet 会把进程内 utils.VERBOSE 置 False（global 副作用），每个用例
        # 结束后恢复原值，避免影响同进程内后续用例（如非 quiet 用例的日志断言）。
        self._orig_verbose = utils.VERBOSE
        self.addCleanup(setattr, utils, "VERBOSE", self._orig_verbose)

    def _run_main(self, argv, sizes=None, ensure_error=None, scan_error=None):
        """打桩运行 cli.main(argv)，返回 (ret, exc, 输出, ensure, scan, ui)。

        默认 ensure 成功、scan 成功返回传入 sizes（缺省空结果）。
        """
        buf = io.StringIO()
        with contextlib.ExitStack() as stack:
            stack.enter_context(mock.patch.object(cli, "init_windows_job_sandbox"))
            ensure = stack.enter_context(mock.patch.object(cli, "ensure_everything_running"))
            scan = stack.enter_context(
                mock.patch.object(
                    cli, "scan_via_everything_sdk",
                    return_value=(sizes if sizes is not None else {}, {}),
                )
            )
            ui = stack.enter_context(mock.patch.object(cli, "interactive_ui"))
            if ensure_error is not None:
                ensure.side_effect = ensure_error
            if scan_error is not None:
                scan.side_effect = scan_error
            with contextlib.redirect_stdout(buf):
                exc = None
                ret = None
                try:
                    ret = cli.main(argv=argv)
                except SystemExit as e:
                    exc = e
        return ret, exc, buf.getvalue(), ensure, scan, ui

    def test_headless_default_top10_sorted_report(self):
        """无 --top 默认 10；排行按聚合大小降序；合计=根总大小与目录总数；退码 0，不触达 UI。"""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            total = sum(1000 - i for i in range(15))
            sizes = {root: total}
            for i in range(15):
                sizes[root / f"d{i}"] = 1000 - i
            ret, exc, output, _, _, ui = self._run_main([tmp], sizes=sizes)
        self.assertIsNone(ret)
        self.assertIsNone(exc, "正常退出不应抛 SystemExit")
        lines = [ln for ln in output.splitlines() if ln]
        self.assertEqual("Top 10 目录占用排行:", lines[1])
        self.assertEqual(len(lines), 13, "启动日志 + 表头 + 10 行排行 + 合计行")
        self.assertEqual(f"{cli.human_size(1000):>12}  {root / 'd0'}", lines[2])
        self.assertEqual(f"{cli.human_size(991):>12}  {root / 'd9'}", lines[11])
        self.assertEqual(f"{cli.human_size(total):>12}  合计: 共 15 个目录", lines[12])
        ui.assert_not_called()

    def test_headless_top2_and_root_excluded(self):
        """--top 2 只列前 2；扫描根本身不进入排行但计入合计。"""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            sizes = {root: 1500, root / "a": 800, root / "b": 400, root / "c": 200}
            ret, exc, output, _, _, ui = self._run_main([tmp, "--top", "2"], sizes=sizes)
        self.assertIsNone(ret)
        self.assertIsNone(exc)
        lines = [ln for ln in output.splitlines() if ln]
        self.assertEqual("Top 2 目录占用排行:", lines[1])
        self.assertEqual(f"{cli.human_size(800):>12}  {root / 'a'}", lines[2])
        self.assertEqual(f"{cli.human_size(400):>12}  {root / 'b'}", lines[3])
        self.assertEqual(f"{cli.human_size(1500):>12}  合计: 共 3 个目录", lines[4])
        ui.assert_not_called()

    def test_headless_fewer_than_top_lists_all(self):
        """目录数不足 N 时全列，不补空行。"""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            sizes = {root: 900, root / "only": 900}
            ret, exc, output, _, _, ui = self._run_main([tmp, "--top", "50"], sizes=sizes)
        self.assertIsNone(ret)
        self.assertIsNone(exc)
        lines = [ln for ln in output.splitlines() if ln]
        self.assertEqual(len(lines), 4, "启动日志 + 表头 + 1 行 + 合计行")
        self.assertEqual(f"{cli.human_size(900):>12}  {root / 'only'}", lines[2])
        self.assertEqual(f"{cli.human_size(900):>12}  合计: 共 1 个目录", lines[3])
        ui.assert_not_called()

    def test_headless_missing_path_fatal_exit1(self):
        """target 不存在 → _fatal SystemExit(1)，不初始化沙盒/不 ensure/不扫描。"""
        with tempfile.TemporaryDirectory() as tmp:
            missing = str(Path(tmp) / "missing_dir")
            ret, exc, output, ensure, scan, ui = self._run_main([missing])
        self.assertIsNone(ret)
        self.assertEqual(exc.code, 1)
        self.assertIn("指定的扫描路径不存在", output)
        ensure.assert_not_called()
        scan.assert_not_called()
        ui.assert_not_called()

    def test_headless_everything_environment_error_fatal(self):
        """非交互：ensure_everything_running 抛 EverythingEnvironmentError → SystemExit(1)。"""
        error = EverythingEnvironmentError("Everything 环境检查失败：测试注入")
        with tempfile.TemporaryDirectory() as tmp:
            ret, exc, output, ensure, scan, ui = self._run_main([tmp], ensure_error=error)
        self.assertIsNone(ret)
        self.assertEqual(exc.code, 1)
        self.assertIn("Everything 环境检查失败：测试注入", output)
        scan.assert_not_called()
        ui.assert_not_called()

    def test_headless_scan_failure_exit1(self):
        """非交互：scan 抛异常 → 简洁纯文本文案（无 ❌/ANSI）+ SystemExit(1)，不触达 UI。"""
        with tempfile.TemporaryDirectory() as tmp:
            ret, exc, output, _, _, ui = self._run_main([tmp], scan_error=RuntimeError("测试扫描失败"))
        self.assertIsNone(ret)
        self.assertEqual(exc.code, 1)
        self.assertIn("扫描失败: 测试扫描失败", output)
        ui.assert_not_called()

    def test_headless_quiet_report_only_no_logs(self):
        """--quiet：stdout 只有报告（表头/排行/合计），无 🚀/🧩 等日志字符、无 \r 进度行。"""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            sizes = {root: 1500, root / "a": 800, root / "b": 400, root / "c": 200}
            ret, exc, output, _, _, ui = self._run_main([tmp, "--quiet"], sizes=sizes)
        self.assertIsNone(ret)
        self.assertIsNone(exc)
        lines = [ln for ln in output.splitlines() if ln]
        self.assertEqual("Top 10 目录占用排行:", lines[0], "启动日志被抑制，报告表头成为第一行")
        self.assertEqual(f"{cli.human_size(800):>12}  {root / 'a'}", lines[1])
        self.assertEqual(f"{cli.human_size(1500):>12}  合计: 共 3 个目录", lines[-1])
        self.assertNotIn("🚀", output)
        self.assertNotIn("🧩", output)
        self.assertNotIn("⏳", output)
        self.assertNotIn("📈", output)
        self.assertNotIn("\r", output)
        self.assertNotIn("处理中", output)
        ui.assert_not_called()

    def test_headless_quiet_scan_failure_keeps_error(self):
        """--quiet + 扫描失败：错误文案完整（简洁无 ❌）、日志被抑制、退码 1。"""
        with tempfile.TemporaryDirectory() as tmp:
            ret, exc, output, _, _, ui = self._run_main(
                [tmp, "--quiet"], scan_error=RuntimeError("测试扫描失败"),
            )
        self.assertIsNone(ret)
        self.assertEqual(exc.code, 1)
        self.assertIn("扫描失败: 测试扫描失败", output)
        self.assertNotIn("🚀", output)
        self.assertNotIn("❌", output)
        ui.assert_not_called()

    def test_headless_quiet_ensure_error_keeps_fatal(self):
        """--quiet + 环境错误：_fatal 的 ❌ 错误输出保留（错误永不静默）、日志被抑制、退码 1。"""
        error = EverythingEnvironmentError("Everything 环境检查失败：测试注入")
        with tempfile.TemporaryDirectory() as tmp:
            ret, exc, output, _, _, ui = self._run_main([tmp, "--quiet"], ensure_error=error)
        self.assertIsNone(ret)
        self.assertEqual(exc.code, 1)
        self.assertIn("Everything 环境检查失败：测试注入", output)
        self.assertIn("❌", output)
        self.assertNotIn("🚀", output)
        self.assertNotIn("🧩", output)
        ui.assert_not_called()

    def test_headless_quiet_missing_path_keeps_fatal(self):
        """--quiet + target 不存在：_fatal 的 ❌ 错误输出保留。"""
        with tempfile.TemporaryDirectory() as tmp:
            missing = str(Path(tmp) / "missing_dir")
            ret, exc, output, ensure, scan, ui = self._run_main([missing, "--quiet"])
        self.assertIsNone(ret)
        self.assertEqual(exc.code, 1)
        self.assertIn("指定的扫描路径不存在", output)
        self.assertIn("❌", output)
        self.assertNotIn("🚀", output)
        ensure.assert_not_called()
        scan.assert_not_called()
        ui.assert_not_called()

    def test_headless_no_quiet_logs_unchanged(self):
        """无 --quiet 的 headless 与 D1 行为一致：🚀 启动日志仍在、报告完整（等价回归锚点）。"""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            sizes = {root: 1200, root / "x": 700}
            ret, exc, output, _, _, ui = self._run_main([tmp], sizes=sizes)
        self.assertIsNone(ret)
        self.assertIsNone(exc)
        lines = [ln for ln in output.splitlines() if ln]
        self.assertIn("🚀", output, "非 quiet 时启动日志必须保留")
        self.assertEqual(lines[1], "Top 10 目录占用排行:")
        self.assertEqual(f"{cli.human_size(1200):>12}  合计: 共 1 个目录", lines[-1])
        ui.assert_not_called()

    def test_invalid_top_exits_nonzero(self):
        """非法 --top（0/201/非数字）→ argparse 报错 SystemExit(2)，不触发任何流程。"""
        for bad in ("0", "201", "abc"):
            with self.subTest(top=bad):
                with tempfile.TemporaryDirectory() as tmp:
                    buf = io.StringIO()
                    with contextlib.ExitStack() as stack:
                        stack.enter_context(mock.patch.object(cli, "init_windows_job_sandbox"))
                        ensure = stack.enter_context(mock.patch.object(cli, "ensure_everything_running"))
                        scan = stack.enter_context(mock.patch.object(cli, "scan_via_everything_sdk"))
                        ui = stack.enter_context(mock.patch.object(cli, "interactive_ui"))
                        with contextlib.redirect_stderr(buf):
                            with self.assertRaises(SystemExit) as cm:
                                cli.main(argv=[tmp, "--top", bad])
                self.assertEqual(cm.exception.code, 2)
                ensure.assert_not_called()
                scan.assert_not_called()
                ui.assert_not_called()

    def test_invalid_top_scan_failure_message_has_no_emoji(self):
        """非交互扫描失败的输出不应含 ❌/ANSI 装饰符（简洁中文版式要求）。"""
        with tempfile.TemporaryDirectory() as tmp:
            ret, exc, output, _, _, _ = self._run_main([tmp], scan_error=RuntimeError("测试扫描失败"))
        self.assertEqual(exc.code, 1)
        self.assertNotIn("❌", output)
        self.assertNotIn("\x1b", output)


if __name__ == "__main__":
    unittest.main()