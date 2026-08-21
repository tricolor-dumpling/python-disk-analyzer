"""cli 模块 D3 导出功能单元测试：--export/--output 的 CSV/JSON 导出、自动命名、
失败路径与交互模式忽略。

覆盖点：
- CSV：UTF-8 BOM、表头「路径,大小(字节),大小(可读)」、逗号/引号转义回读、
  按聚合大小降序（同大小按路径）、含扫描根、可读列用 human_size；
- JSON：结构（scan_root/exported_at/total_size_bytes/directories）、ISO 时间格式、
  ensure_ascii=False 中文原样 UTF-8、按大小降序、无 BOM、json.load 可回读；
- 导出不受 --top 限制（--top 只影响屏幕 Top-N 报告）；
- --output 自定义路径生效；缺省时在当前目录自动命名 disk_report_YYYYMMDD_HHMMSS.<ext>；
- 写失败（父目录不存在 / 目标是目录）→ 中文提示（非 ANSI）+ 退出码 1，且扫描
  失败先于导出退出（不生成文件）；
- --quiet 与 --export 正交：导出文件照常生成，stdout 只有报告（无确认行/日志/\r）；
- 交互模式忽略 --export/--output（含单独 --output 不触发 headless 专属校验）；
- headless 下 --output 未搭配 --export 或非法 --export 值 → argparse 退出码 2。

注入点与 test_cli 一致：cli 命名空间 from-import 绑定（cli.ensure_everything_running /
cli.scan_via_everything_sdk / cli.interactive_ui / cli.init_windows_job_sandbox）均打桩，
sizes 为注入的假 Path→int 字典（含扫描根键），导出目标一律 tempfile 目录，全程不
触达真实 Everything。

注意：凡断言导出文件内容的用例，断言必须放在 with tempfile.TemporaryDirectory()
块内（块退出即删除目录），与 test_cli 的文件无关断言在外面。
"""

import contextlib
import csv
import datetime
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import cli
import utils


class ExportCliTests(unittest.TestCase):
    """cli 命名空间的导出单元测试（直接调用导出函数与命名规则）。"""

    def test_default_export_path_naming_rule(self):
        """自动命名规则：disk_report_YYYYMMDD_HHMMSS.<后缀>，后缀跟随 --export 格式。"""
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            fixed = datetime.datetime(2026, 8, 21, 15, 30, 0)
            self.assertEqual(
                cli._default_export_path("csv", base_dir=base, now=fixed),
                base / "disk_report_20260821_153000.csv",
            )
            self.assertEqual(
                cli._default_export_path("json", base_dir=base, now=fixed),
                base / "disk_report_20260821_153000.json",
            )

    def test_export_report_csv_content(self):
        """CSV：BOM、表头、逗号/引号转义回读、降序（根最大排最前）、human_size 列。"""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            sizes = {
                root: 1500,
                root / "图片,视频\"目录": 800,
                root / "b": 400,
                root / "a": 200,
            }
            out = Path(tmp) / "rep.csv"
            cli.export_report_csv(root, sizes, out)
            raw = out.read_bytes()
            self.assertTrue(raw.startswith(b"\xef\xbb\xbf"), "CSV 必须以 UTF-8 BOM 开头")
            rows = list(csv.reader(io.StringIO(raw.decode("utf-8-sig"))))
            self.assertEqual(rows[0], ["路径", "大小(字节)", "大小(可读)"])
            self.assertEqual(len(rows), 5, "表头 + 扫描根 + 3 个子目录")
            self.assertEqual(rows[1][0], str(root))
            self.assertEqual(rows[1][1], "1500")
            self.assertEqual(rows[1][2], cli.human_size(1500))
            self.assertEqual(rows[2][0], str(root / "图片,视频\"目录"), "逗号/引号路径应可原样读回")
            self.assertEqual(rows[2][1], "800")
            self.assertEqual(rows[4][0], str(root / "a"))

    def test_export_report_csv_sorted_desc_and_path_tie_break(self):
        """CSV 排序：聚合大小降序；同大小按路径（不区分大小写）升序稳定。"""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            sizes = {root: 1000, root / "z": 300, root / "b": 500, root / "a": 500}
            out = Path(tmp) / "rep.csv"
            cli.export_report_csv(root, sizes, out)
            rows = list(csv.reader(io.StringIO(out.read_bytes().decode("utf-8-sig"))))
            self.assertEqual(rows[1][0], str(root), "扫描根 1000 最大排第一")
            self.assertEqual(rows[2][0], str(root / "a"), "同大小 500 时路径 a 在 b 前")
            self.assertEqual(rows[3][0], str(root / "b"))
            self.assertEqual(rows[4][0], str(root / "z"))

    def test_export_report_json_structure_and_iso_time(self):
        """JSON：结构完整、ISO 时间格式、中文原样 UTF-8（ensure_ascii=False）、无 BOM、可回读。"""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            sizes = {
                root: 1500,
                root / "中文字目录": 800,
                root / "b": 400,
                root / "a": 200,
            }
            out = Path(tmp) / "rep.json"
            cli.export_report_json(root, sizes, out)
            raw = out.read_bytes()
            self.assertFalse(raw.startswith(b"\xef\xbb\xbf"), "JSON 不应带 BOM")
            text = raw.decode("utf-8")
            self.assertIn("中文字目录", text, "ensure_ascii=False：中文必须原样 UTF-8")
            self.assertNotIn("\\u4e2d", text, "不得出现 \\uXXXX 转义")
            payload = json.loads(text)
            self.assertEqual(set(payload.keys()), {"scan_root", "exported_at", "total_size_bytes", "directories"})
            self.assertEqual(payload["scan_root"], str(root))
            self.assertRegex(payload["exported_at"], r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$")
            self.assertEqual(payload["total_size_bytes"], 1500, "合计=扫描根键聚合值")
            dirs = payload["directories"]
            self.assertEqual([d["size_bytes"] for d in dirs], [1500, 800, 400, 200], "必须按聚合大小降序")
            self.assertEqual(dirs[0]["path"], str(root), "扫描根包含在导出中")
            self.assertEqual(dirs[1]["path"], str(root / "中文字目录"))
            self.assertEqual(dirs[1]["size_human"], cli.human_size(800))
            self.assertEqual(set(dirs[2].keys()), {"path", "size_bytes", "size_human"})


class ExportHeadlessTests(unittest.TestCase):
    """cli.main 非交互模式 + --export/--output 的端到端行为（打桩扫描）。"""

    def setUp(self):
        # --quiet 会把进程内 utils.VERBOSE 置 False（global 副作用），每个用例
        # 结束后恢复原值，避免影响同进程内后续用例的日志断言。
        self._orig_verbose = utils.VERBOSE
        self.addCleanup(setattr, utils, "VERBOSE", self._orig_verbose)

    def _run_main(self, argv, sizes=None, scan_error=None):
        """打桩运行 cli.main(argv)，返回 (ret, exc, 输出)。"""
        buf = io.StringIO()
        with contextlib.ExitStack() as stack:
            stack.enter_context(mock.patch.object(cli, "init_windows_job_sandbox"))
            stack.enter_context(mock.patch.object(cli, "ensure_everything_running"))
            scan = stack.enter_context(
                mock.patch.object(
                    cli, "scan_via_everything_sdk",
                    return_value=(sizes if sizes is not None else {}, {}),
                )
            )
            stack.enter_context(mock.patch.object(cli, "interactive_ui"))
            if scan_error is not None:
                scan.side_effect = scan_error
            with contextlib.redirect_stdout(buf):
                exc = None
                ret = None
                try:
                    ret = cli.main(argv=argv)
                except SystemExit as e:
                    exc = e
        return ret, exc, buf.getvalue()

    def _run_main_expects_exit(self, argv):
        """运行 cli.main(argv)，断言抛 SystemExit，返回 (exc, stderr, ensure, scan, ui)。

        供 argparse 错误场景（--output 未搭配 --export / 非法 --export 值）使用：
        解析在流程启动前就已失败，ensure/scan/ui 均不得被触达。
        """
        err_buf = io.StringIO()
        with contextlib.ExitStack() as stack:
            stack.enter_context(mock.patch.object(cli, "init_windows_job_sandbox"))
            ensure = stack.enter_context(mock.patch.object(cli, "ensure_everything_running"))
            scan = stack.enter_context(mock.patch.object(cli, "scan_via_everything_sdk"))
            ui = stack.enter_context(mock.patch.object(cli, "interactive_ui"))
            with contextlib.redirect_stderr(err_buf):
                with self.assertRaises(SystemExit) as cm:
                    cli.main(argv=argv)
        return cm.exception, err_buf.getvalue(), ensure, scan, ui

    def test_export_csv_via_main(self):
        """main 链路导出 CSV：文件内容正确 + 屏幕 Top-N 报告照常打印 + 确认行存在。"""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            sizes = {root: 1500, root / "a": 800, root / "b": 400}
            out = Path(tmp) / "rep.csv"
            ret, exc, output = self._run_main(
                [tmp, "--export", "csv", "--output", str(out)], sizes=sizes,
            )
            self.assertIsNone(ret)
            self.assertIsNone(exc)
            rows = list(csv.reader(io.StringIO(out.read_bytes().decode("utf-8-sig"))))
            self.assertEqual(len(rows), 4, "表头 + 根 + 2 个子目录")
            lines = [ln for ln in output.splitlines() if ln]
            self.assertEqual(lines[1], "Top 10 目录占用排行:", "屏幕报告照常打印")
            self.assertIn("已导出目录占用报告", output)
            self.assertIn(str(out), output)

    def test_export_json_via_main(self):
        """main 链路导出 JSON：文件可由 json.load 回读且结构正确。"""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            sizes = {root: 900, root / "x": 600, root / "y": 300}
            out = Path(tmp) / "rep.json"
            ret, exc, _ = self._run_main(
                [tmp, "--export", "json", "--output", str(out)], sizes=sizes,
            )
            self.assertIsNone(ret)
            self.assertIsNone(exc)
            payload = json.loads(out.read_text(encoding="utf-8"))
            self.assertEqual(payload["scan_root"], str(root))
            self.assertEqual(payload["total_size_bytes"], 900)
            self.assertEqual([d["size_bytes"] for d in payload["directories"]], [900, 600, 300])

    def test_export_all_dirs_not_limited_by_top(self):
        """--top 只影响屏幕报告：--top 1 时导出仍含全部目录（表头 + 根 + 3 个子目录）。"""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            sizes = {root: 1500, root / "a": 800, root / "b": 400, root / "c": 200}
            out = Path(tmp) / "rep.csv"
            ret, exc, output = self._run_main(
                [tmp, "--top", "1", "--export", "csv", "--output", str(out)], sizes=sizes,
            )
            self.assertIsNone(ret)
            self.assertIsNone(exc)
            rows = list(csv.reader(io.StringIO(out.read_bytes().decode("utf-8-sig"))))
            self.assertEqual(len(rows), 5, "--top 1 不影响导出（导出全部目录）")
            lines = [ln for ln in output.splitlines() if ln]
            self.assertEqual(lines[1], "Top 1 目录占用排行:", "屏幕报告只显示 Top 1")

    def test_export_output_explicit_path_honored(self):
        """--output 指定的自定义路径生效，文件写入该路径。"""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            out = Path(tmp) / "custom" / "my_report.csv"
            out.parent.mkdir()
            ret, exc, _ = self._run_main(
                [tmp, "--export", "csv", "--output", str(out)], sizes={root: 900, root / "a": 900},
            )
            self.assertIsNone(ret)
            self.assertIsNone(exc)
            self.assertTrue(out.exists(), "--output 自定义路径应生效")
            self.assertTrue(out.read_bytes().startswith(b"\xef\xbb\xbf"))

    def test_export_default_auto_named_path(self):
        """未指定 --output：在当前目录自动生成 disk_report_YYYYMMDD_HHMMSS.json。"""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            orig_cwd = Path.cwd()
            try:
                os.chdir(tmp)
                before = set(p.name for p in Path(tmp).glob("disk_report_*.json"))
                ret, exc, _ = self._run_main(
                    [str(root), "--export", "json"], sizes={root: 500, root / "a": 300},
                )
                after = set(p.name for p in Path(tmp).glob("disk_report_*.json")) - before
            finally:
                os.chdir(orig_cwd)
            self.assertIsNone(ret)
            self.assertIsNone(exc)
            self.assertEqual(len(after), 1)
            name = after.pop()
            self.assertRegex(name, r"^disk_report_\d{8}_\d{6}\.json$")
            payload = json.loads((Path(tmp) / name).read_text(encoding="utf-8"))
            self.assertEqual(payload["total_size_bytes"], 500)

    def test_export_write_failure_missing_parent_exit1(self):
        """--output 父目录不存在 → 中文提示（非 ANSI）+ 退出码 1。"""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            out = Path(tmp) / "no_such_dir" / "a.csv"
            ret, exc, output = self._run_main(
                [tmp, "--export", "csv", "--output", str(out)], sizes={root: 100},
            )
        self.assertIsNone(ret)
        self.assertEqual(exc.code, 1)
        self.assertIn("导出报告失败", output)
        self.assertNotIn("\x1b", output)

    def test_export_write_failure_output_is_directory_exit1(self):
        """--output 指向已存在目录 → 中文提示 + 退出码 1。"""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            ret, exc, output = self._run_main(
                [tmp, "--export", "json", "--output", tmp], sizes={root: 100},
            )
        self.assertIsNone(ret)
        self.assertEqual(exc.code, 1)
        self.assertIn("导出报告失败", output)

    def test_export_quiet_still_writes_file(self):
        """--quiet 与 --export 正交：导出文件照常生成；stdout 只有报告（无确认行/日志/\r）。"""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            out = Path(tmp) / "rep.csv"
            ret, exc, output = self._run_main(
                [tmp, "--quiet", "--export", "csv", "--output", str(out)],
                sizes={root: 900, root / "a": 500},
            )
            self.assertIsNone(ret)
            self.assertIsNone(exc)
            self.assertTrue(out.exists(), "--quiet 不能阻止导出文件生成")
            rows = list(csv.reader(io.StringIO(out.read_bytes().decode("utf-8-sig"))))
            self.assertEqual(len(rows), 3, "表头 + 根 + 1 个子目录")
            lines = [ln for ln in output.splitlines() if ln]
            self.assertEqual(lines[0], "Top 10 目录占用排行:", "--quiet 时报告照常打印且为第一行")
            self.assertNotIn("已导出", output, "--quiet 抑制导出确认行（保持 D2 静默契约）")
            self.assertNotIn("🚀", output)
            self.assertNotIn("\r", output)

    def test_export_quiet_scan_failure_exits_before_export(self):
        """--quiet + 扫描失败：在导出之前退出，错误文案保留、不生成文件、退码 1。"""
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "rep.csv"
            ret, exc, output = self._run_main(
                [tmp, "--quiet", "--export", "csv", "--output", str(out)],
                scan_error=RuntimeError("测试扫描失败"),
            )
        self.assertIsNone(ret)
        self.assertEqual(exc.code, 1)
        self.assertFalse(out.exists(), "扫描失败时不得生成导出文件")
        self.assertIn("扫描失败: 测试扫描失败", output)

    def test_export_empty_scan(self):
        """空扫描：CSV 只有表头；JSON directories 为空、total 为 0，均正常导出。"""
        with tempfile.TemporaryDirectory() as tmp:
            out_csv = Path(tmp) / "e.csv"
            out_json = Path(tmp) / "e.json"
            ret, exc, _ = self._run_main(
                [tmp, "--export", "csv", "--output", str(out_csv)], sizes={},
            )
            self.assertIsNone(ret)
            self.assertIsNone(exc)
            rows = list(csv.reader(io.StringIO(out_csv.read_bytes().decode("utf-8-sig"))))
            self.assertEqual(rows, [["路径", "大小(字节)", "大小(可读)"]])
            ret, exc, _ = self._run_main(
                [tmp, "--export", "json", "--output", str(out_json)], sizes={},
            )
            self.assertIsNone(ret)
            self.assertIsNone(exc)
            payload = json.loads(out_json.read_text(encoding="utf-8"))
            self.assertEqual(payload["total_size_bytes"], 0)
            self.assertEqual(payload["directories"], [])

    def test_output_without_export_headless_error2(self):
        """headless 下 --output 未搭配 --export → argparse 报错退出码 2，不触发任何流程。"""
        with tempfile.TemporaryDirectory() as tmp:
            exc, err, ensure, scan, ui = self._run_main_expects_exit([tmp, "--output", "report.csv"])
            self.assertEqual(exc.code, 2)
            self.assertIn("--output 需要与 --export 搭配", err)
            ensure.assert_not_called()
            scan.assert_not_called()
            ui.assert_not_called()

    def test_invalid_export_value_error2(self):
        """非法 --export 取值（xml/pdf/空字符串）→ argparse 报错退出码 2，不触发任何流程。"""
        for bad in ("xml", "pdf", ""):
            with self.subTest(export=bad):
                with tempfile.TemporaryDirectory() as tmp:
                    exc, err, ensure, scan, ui = self._run_main_expects_exit(
                        [tmp, "--export", bad],
                    )
                self.assertEqual(exc.code, 2, f"--export {bad!r} 应报 argparse 错误退出码 2")
                self.assertIn("无效的 --export 值", err)
                ensure.assert_not_called()
                scan.assert_not_called()
                ui.assert_not_called()


class ExportInteractiveTests(unittest.TestCase):
    """交互模式（无 target）对 --export/--output 的忽略语义。"""

    def _run_interactive(self, argv, target):
        """打桩运行交互模式 cli.main(argv)，返回 (ret, exc, 输出, ui)。"""
        buf = io.StringIO()
        with contextlib.ExitStack() as stack:
            stack.enter_context(mock.patch("builtins.input", side_effect=[target]))
            stack.enter_context(mock.patch.object(cli, "init_windows_job_sandbox"))
            stack.enter_context(mock.patch.object(cli, "ensure_everything_running"))
            stack.enter_context(mock.patch.object(cli, "scan_via_everything_sdk", return_value=({}, {})))
            ui = stack.enter_context(
                mock.patch.object(cli, "interactive_ui", return_value=("quit", None))
            )
            with contextlib.redirect_stdout(buf):
                exc = None
                ret = None
                try:
                    ret = cli.main(argv=argv)
                except SystemExit as e:
                    exc = e
        return ret, exc, buf.getvalue(), ui

    def test_interactive_ignores_export_output(self):
        """交互模式给 --export/--output：行为与不带参数一致、不写文件、正常进入 UI。"""
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "should_not_exist.csv"
            ret_plain, exc_plain, output_plain, ui_plain = self._run_interactive([], tmp)
            ret_exp, exc_exp, output_exp, ui_exp = self._run_interactive(
                ["--export", "csv", "--output", str(out)], tmp,
            )
        self.assertIsNone(exc_plain)
        self.assertIsNone(exc_exp)
        self.assertIsNone(ret_exp)
        self.assertEqual(output_exp, output_plain, "交互模式下 --export/--output 不得改变任何输出")
        self.assertFalse(out.exists(), "交互模式下不得生成导出文件")
        ui_plain.assert_called_once()
        ui_exp.assert_called_once()

    def test_interactive_output_without_export_ignored(self):
        """交互模式给单独 --output：不触发 headless 专属校验（搭配校验仅 headless 生效）。"""
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "nope.csv"
            ret, exc, _, ui = self._run_interactive(["--output", str(out)], tmp)
            self.assertIsNone(exc)
            self.assertIsNone(ret)
            self.assertFalse(out.exists())
            ui.assert_called_once()


if __name__ == "__main__":
    unittest.main()