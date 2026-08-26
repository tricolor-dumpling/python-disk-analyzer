"""D9 集成测试：cli 新参数（--snapshot-dir/--no-snapshot/--baseline）、交互模式
干净退出自动保存、main 兼容层 re-export 命名空间。

注入点全部走 cli 命名空间 from-import 绑定（cli.is_snapshot_disabled /
cli.should_auto_save / cli.save_snapshot / cli.compute_fingerprint /
cli.update_ledger_after_save / cli.get_snapshot_dir / cli.get_machine_guid），
链路不触达真实 Everything 进程与真实快照目录；环境变量（DSA_SNAPSHOT_DIR /
DSA_NO_SNAPSHOT）每用例自行设置/清理，不污染同进程其它测试模块。
"""

import contextlib
import io
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import cli
import compare
import dispatcher
import keyrouter
import messages
import snapshots


class _EnvIsolationMixin:
    """用例级环境变量隔离：DSA_SNAPSHOT_DIR / DSA_NO_SNAPSHOT 每用例清空、结束时复原。"""

    def setUp(self):
        self._orig_snapshot_dir = os.environ.get("DSA_SNAPSHOT_DIR")
        self._orig_no_snapshot = os.environ.get("DSA_NO_SNAPSHOT")
        os.environ.pop("DSA_SNAPSHOT_DIR", None)
        os.environ.pop("DSA_NO_SNAPSHOT", None)
        self.addCleanup(self._restore_env)

    def _restore_env(self):
        self._set_or_del("DSA_SNAPSHOT_DIR", self._orig_snapshot_dir)
        self._set_or_del("DSA_NO_SNAPSHOT", self._orig_no_snapshot)

    @staticmethod
    def _set_or_del(key, value):
        if value is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = value


class CliArgumentTests(_EnvIsolationMixin, unittest.TestCase):
    """D9 参数解析与生效：--snapshot-dir 设环境变量、--no-snapshot 置禁用、
    --baseline 缺失文件报错（退出码 1 或 2）。"""

    def test_snapshot_dir_sets_env_var(self):
        """--snapshot-dir 把覆盖目录（绝对化后）写入 DSA_SNAPSHOT_DIR，且无需真实交互流程。"""
        with tempfile.TemporaryDirectory() as tmp:
            buf = io.StringIO()
            with mock.patch.object(cli, "_run_interactive", return_value=None), \
                    contextlib.redirect_stdout(buf):
                cli.main(argv=["--snapshot-dir", tmp])
        self.assertEqual(os.environ.get("DSA_SNAPSHOT_DIR"), str(Path(tmp).resolve()))
        self.assertFalse(snapshots.is_snapshot_disabled(), "仅设目录不隐含禁用快照")

    def test_snapshot_dir_env_visible_to_snapshots_module(self):
        """设置后 snapshots.get_snapshot_dir() 读到同一覆盖目录（同源生效验证）。"""
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.object(cli, "_run_interactive", return_value=None), \
                    contextlib.redirect_stdout(io.StringIO()):
                cli.main(argv=["--snapshot-dir", tmp])
            self.assertEqual(str(snapshots.get_snapshot_dir()), str(Path(tmp).resolve()))

    def test_no_snapshot_disables_auto_save(self):
        """--no-snapshot 写入 DSA_NO_SNAPSHOT=1，is_snapshot_disabled() 随之返回 True。"""
        buf = io.StringIO()
        with mock.patch.object(cli, "_run_interactive", return_value=None), \
                contextlib.redirect_stdout(buf):
            cli.main(argv=["--no-snapshot"])
        self.assertEqual(os.environ.get("DSA_NO_SNAPSHOT"), "1")
        self.assertTrue(snapshots.is_snapshot_disabled())

    def test_snapshot_dir_resolved_absolute(self):
        """相对路径的 --snapshot-dir 也按绝对路径写入（相对 cwd 解析），避免环境变量歧义。"""
        buf = io.StringIO()
        with mock.patch.object(cli, "_run_interactive", return_value=None), \
                contextlib.redirect_stdout(buf):
            cli.main(argv=["--snapshot-dir", "rel_snaps_dir"])
        abs_value = str(Path("rel_snaps_dir").resolve())
        self.assertTrue(os.path.isabs(os.environ.get("DSA_SNAPSHOT_DIR", "")))
        self.assertEqual(os.environ.get("DSA_SNAPSHOT_DIR"), abs_value)

    def test_baseline_missing_file_reports_error(self):
        """--baseline 指向不存在的文件 → 中文提示并以退出码 1（需求允许 1 或 2）结束，
        扫描/环境链路不触达。"""
        with tempfile.TemporaryDirectory() as tmp:
            missing = str(Path(tmp) / "no_such.snap.gz")
            buf = io.StringIO()
            with mock.patch.object(cli, "init_windows_job_sandbox"), \
                    mock.patch.object(cli, "ensure_everything_running") as ensure, \
                    mock.patch.object(cli, "scan_via_everything_sdk") as scan, \
                    contextlib.redirect_stdout(buf):
                with self.assertRaises(SystemExit) as cm:
                    cli.main(argv=[tmp, "--baseline", missing])
        self.assertIn(cm.exception.code, (1, 2))
        self.assertIn("基线快照不存在", buf.getvalue())
        ensure.assert_not_called()
        scan.assert_not_called()

    def test_baseline_corrupt_file_reports_error(self):
        """--baseline 指向损坏/无内容的文件 → SnapshotCorruptError 收敛为中文提示 + 退出码 1。"""
        with tempfile.TemporaryDirectory() as tmp:
            bad = Path(tmp) / "bad.snap.gz"
            bad.write_bytes(b"not a gzip at all")
            buf = io.StringIO()
            with mock.patch.object(cli, "init_windows_job_sandbox"), \
                    contextlib.redirect_stdout(buf):
                with self.assertRaises(SystemExit) as cm:
                    cli.main(argv=[tmp, "--baseline", str(bad)])
        self.assertEqual(cm.exception.code, 1)
        self.assertIn("基线快照", buf.getvalue())


class ExitAutoSaveTests(_EnvIsolationMixin, unittest.TestCase):
    """交互模式干净退出自动保存：正常退出路径触发 should_auto_save + save_snapshot；
    禁用/谓词拒绝/保存失败/无扫描数据时跳过；换根退出用最终根。"""

    @staticmethod
    def _fingerprint():
        return {"file_count": 2, "dir_count": 1, "root_mtime": 1.0, "ok": True, "error_code": None}

    def test_clean_quit_triggers_auto_save(self):
        """正常退出：should_auto_save 以四原子谓词参数被调用且返回 ok →
        save_snapshot(auto=True) 随后执行、成功后 update_ledger_after_save 补齐台账。"""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            snap_dir = Path(tmp) / "snaps"
            sizes = {root: 12345, root / "a": 10000, root / "b": 2345}
            fp = self._fingerprint()
            with mock.patch.object(cli, "scan_via_everything_sdk", return_value=(sizes, {})), \
                    mock.patch.object(cli, "interactive_ui", return_value=("quit", None)), \
                    mock.patch("builtins.input", side_effect=[str(root)]), \
                    mock.patch.object(cli, "init_windows_job_sandbox"), \
                    mock.patch.object(cli, "ensure_everything_running"):
                with mock.patch.object(cli, "compute_fingerprint", return_value=fp) as fp_mock, \
                        mock.patch.object(cli, "get_snapshot_dir", return_value=snap_dir), \
                        mock.patch.object(cli, "load_ledger", return_value={}) as ledger_mock, \
                        mock.patch.object(
                            cli, "should_auto_save", return_value=(True, snapshots.REASON_OK)
                        ) as predicate_mock, \
                        mock.patch.object(
                            cli, "save_snapshot",
                            return_value=snap_dir / "fake.snap.gz",
                        ) as save_mock, \
                        mock.patch.object(
                            cli, "update_ledger_after_save", return_value={}
                        ) as ledger_update_mock, \
                        mock.patch.object(
                            cli, "get_machine_guid", return_value="test-machine-guid"
                        ):
                    buf = io.StringIO()
                    with contextlib.redirect_stdout(buf):
                        cli.main(argv=[])
            output = buf.getvalue()

        self.assertIn("已安全退出", output)
        fp_mock.assert_called_once_with(root)
        ledger_mock.assert_called_once_with(snap_dir)
        predicate_mock.assert_called_once_with(
            root, tree_complete=True, dirty=False, fingerprint=fp, ledger={},
        )
        save_mock.assert_called_once()
        args, kwargs = save_mock.call_args
        self.assertEqual(args[0], root)
        self.assertEqual(
            args[1],
            [{"p": str(root), "s": 12345}, {"p": str(root / "a"), "s": 10000},
             {"p": str(root / "b"), "s": 2345}],
            "rows 由最终 sizes 按 {p, s} 生成",
        )
        self.assertIs(kwargs["auto"], True)
        self.assertEqual(kwargs["dir_path"], snap_dir)
        self.assertEqual(kwargs["fingerprint"], fp)
        self.assertEqual(kwargs["machine_guid"], "test-machine-guid")
        ledger_update_mock.assert_called_once_with(
            root, fp, auto=True, dir_path=snap_dir,
        )

    def test_auto_save_skipped_when_disabled(self):
        """--no-snapshot 语义：is_snapshot_disabled()=True 时正常退出不触发指纹/谓词/落盘。"""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            snap_dir = Path(tmp) / "snaps"
            sizes = {root: 100}
            with mock.patch.object(cli, "scan_via_everything_sdk", return_value=(sizes, {})), \
                    mock.patch.object(cli, "interactive_ui", return_value=("quit", None)), \
                    mock.patch("builtins.input", side_effect=[str(root)]), \
                    mock.patch.object(cli, "init_windows_job_sandbox"), \
                    mock.patch.object(cli, "ensure_everything_running"):
                with mock.patch.object(cli, "is_snapshot_disabled", return_value=True), \
                        mock.patch.object(cli, "compute_fingerprint") as fp_mock, \
                        mock.patch.object(cli, "should_auto_save") as predicate_mock, \
                        mock.patch.object(cli, "save_snapshot") as save_mock, \
                        mock.patch.object(cli, "get_snapshot_dir", return_value=snap_dir):
                    buf = io.StringIO()
                    with contextlib.redirect_stdout(buf):
                        cli.main(argv=[])
            output = buf.getvalue()
        self.assertIn("已安全退出", output)
        fp_mock.assert_not_called()
        predicate_mock.assert_not_called()
        save_mock.assert_not_called()

    def test_auto_save_skipped_when_predicate_rejected(self):
        """四原子谓词拒绝（如 dirty）→ 不落盘、退出流程不受影响。"""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            snap_dir = Path(tmp) / "snaps"
            sizes = {root: 100}
            with mock.patch.object(cli, "scan_via_everything_sdk", return_value=(sizes, {})), \
                    mock.patch.object(cli, "interactive_ui", return_value=("quit", None)), \
                    mock.patch("builtins.input", side_effect=[str(root)]), \
                    mock.patch.object(cli, "init_windows_job_sandbox"), \
                    mock.patch.object(cli, "ensure_everything_running"):
                with mock.patch.object(cli, "compute_fingerprint", return_value=self._fingerprint()), \
                        mock.patch.object(cli, "get_snapshot_dir", return_value=snap_dir), \
                        mock.patch.object(cli, "load_ledger", return_value={}), \
                        mock.patch.object(
                            cli, "should_auto_save", return_value=(False, snapshots.REASON_DIRTY)
                        ) as predicate_mock, \
                        mock.patch.object(cli, "save_snapshot") as save_mock:
                    buf = io.StringIO()
                    with contextlib.redirect_stdout(buf):
                        cli.main(argv=[])
            output = buf.getvalue()
        self.assertIn("已安全退出", output)
        predicate_mock.assert_called_once()
        save_mock.assert_not_called()

    def test_auto_save_save_failure_is_silent_to_flow(self):
        """save_snapshot 抛异常（如锁冲突/写失败）→ 自动保存静默失败，退出流程不崩溃、
        台账不再补写（默认 verbose 下仅提示一行，不改变退出语义）。"""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            snap_dir = Path(tmp) / "snaps"
            sizes = {root: 100}
            with mock.patch.object(cli, "scan_via_everything_sdk", return_value=(sizes, {})), \
                    mock.patch.object(cli, "interactive_ui", return_value=("quit", None)), \
                    mock.patch("builtins.input", side_effect=[str(root)]), \
                    mock.patch.object(cli, "init_windows_job_sandbox"), \
                    mock.patch.object(cli, "ensure_everything_running"):
                with mock.patch.object(cli, "compute_fingerprint", return_value=self._fingerprint()), \
                        mock.patch.object(cli, "get_snapshot_dir", return_value=snap_dir), \
                        mock.patch.object(cli, "load_ledger", return_value={}), \
                        mock.patch.object(
                            cli, "should_auto_save", return_value=(True, snapshots.REASON_OK)
                        ), \
                        mock.patch.object(
                            cli, "save_snapshot", side_effect=OSError("磁盘只读（测试注入）")
                        ), \
                        mock.patch.object(cli, "update_ledger_after_save") as ledger_update_mock:
                    buf = io.StringIO()
                    with contextlib.redirect_stdout(buf):
                        cli.main(argv=[])
            output = buf.getvalue()
        self.assertIn("已安全退出", output)
        ledger_update_mock.assert_not_called()

    def test_auto_save_skipped_when_no_scan_data(self):
        """空 sizes（仅测试/退化输入；真实扫描 sizes 必含根键）→ 不探测指纹、不触达谓词/落盘。"""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            with mock.patch.object(cli, "scan_via_everything_sdk", return_value=({}, {})), \
                    mock.patch.object(cli, "interactive_ui", return_value=("quit", None)), \
                    mock.patch("builtins.input", side_effect=[str(root)]), \
                    mock.patch.object(cli, "init_windows_job_sandbox"), \
                    mock.patch.object(cli, "ensure_everything_running"):
                with mock.patch.object(cli, "compute_fingerprint") as fp_mock, \
                        mock.patch.object(cli, "should_auto_save") as predicate_mock, \
                        mock.patch.object(cli, "save_snapshot") as save_mock:
                    buf = io.StringIO()
                    with contextlib.redirect_stdout(buf):
                        cli.main(argv=[])
            output = buf.getvalue()
        self.assertIn("已安全退出", output)
        fp_mock.assert_not_called()
        predicate_mock.assert_not_called()
        save_mock.assert_not_called()

    def test_auto_save_after_change_root_uses_final_root_once(self):
        """换根后正常退出：自动保存只触发一次，root 为最终根路径（最后一次扫描的 sizes）。"""
        with tempfile.TemporaryDirectory() as tmp1, tempfile.TemporaryDirectory() as tmp2:
            root1 = Path(tmp1).resolve()
            root2 = Path(tmp2).resolve()
            sizes = {root1: 1000}
            with mock.patch.object(cli, "scan_via_everything_sdk", return_value=(sizes, {})), \
                    mock.patch.object(
                        cli, "interactive_ui",
                        side_effect=[("change", str(root2)), ("quit", None)],
                    ), \
                    mock.patch("builtins.input", side_effect=[str(root1)]), \
                    mock.patch.object(cli, "init_windows_job_sandbox"), \
                    mock.patch.object(cli, "ensure_everything_running"):
                with mock.patch.object(cli, "compute_fingerprint", return_value=self._fingerprint()), \
                        mock.patch.object(cli, "get_snapshot_dir", return_value=Path(tmp1) / "snaps"), \
                        mock.patch.object(cli, "load_ledger", return_value={}), \
                        mock.patch.object(
                            cli, "should_auto_save", return_value=(True, snapshots.REASON_OK)
                        ) as predicate_mock, \
                        mock.patch.object(
                            cli, "save_snapshot", return_value=Path(tmp1) / "fake.snap.gz"
                        ) as save_mock, \
                        mock.patch.object(cli, "update_ledger_after_save", return_value={}):
                    buf = io.StringIO()
                    with contextlib.redirect_stdout(buf):
                        cli.main(argv=[])
            output = buf.getvalue()
        self.assertIn("已切换到新路径", output)
        self.assertIn("已安全退出", output)
        self.assertEqual(save_mock.call_count, 1, "换根后退出只自动保存一次")
        self.assertEqual(predicate_mock.call_args.args[0], root2, "自动保存用最终根路径")


class MainNamespaceTests(unittest.TestCase):
    """main 兼容层：新模块公共 API 全量回拷，旧「import main.<名字>」习惯可用且可调用。"""

    def _import_main(self):
        import main
        return main

    def test_main_re_exports_new_module_apis(self):
        """snapshots/compare/dispatcher/keyrouter/messages + scan 新 API 与归属模块同一对象。"""
        import main
        import scan
        self.assertIs(main.compute_fingerprint, scan.compute_fingerprint)
        self.assertIs(main.fingerprints_equal, scan.fingerprints_equal)
        self.assertIs(main.light_refresh, scan.light_refresh)
        self.assertIs(main.deep_refresh, scan.deep_refresh)
        self.assertIs(main.clear_fingerprint_cache, scan.clear_fingerprint_cache)
        self.assertIs(main.ScanCancelledError, scan.ScanCancelledError)
        self.assertIs(main.save_snapshot, snapshots.save_snapshot)
        self.assertIs(main.load_snapshot, snapshots.load_snapshot)
        self.assertIs(main.list_snapshots, snapshots.list_snapshots)
        self.assertIs(main.get_snapshot_dir, snapshots.get_snapshot_dir)
        self.assertIs(main.default_snapshot_dir, snapshots.default_snapshot_dir)
        self.assertIs(main.is_snapshot_disabled, snapshots.is_snapshot_disabled)
        self.assertIs(main.should_auto_save, snapshots.should_auto_save)
        self.assertIs(main.get_machine_guid, snapshots.get_machine_guid)
        self.assertIs(main.load_ledger, snapshots.load_ledger)
        self.assertIs(main.SNAPSHOT_FORMAT_VERSION, snapshots.SNAPSHOT_FORMAT_VERSION)
        self.assertIs(main.SnapshotError, snapshots.SnapshotError)
        self.assertIs(main.SnapshotBusyError, snapshots.SnapshotBusyError)
        self.assertIs(main.SnapshotCorruptError, snapshots.SnapshotCorruptError)
        self.assertIs(main.compare_snapshots, compare.compare_snapshots)
        self.assertIs(main.top_growth, compare.top_growth)
        self.assertIs(main.diff_from_current, compare.diff_from_current)
        self.assertIs(main.format_row, compare.format_row)
        self.assertIs(main.CompareError, compare.CompareError)
        self.assertIs(main.EverythingQueryDispatcher, dispatcher.EverythingQueryDispatcher)
        self.assertIs(main.DispatcherError, dispatcher.DispatcherError)
        self.assertIs(main.key_to_action, keyrouter.key_to_action)
        self.assertIs(main.help_text, keyrouter.help_text)
        self.assertIs(main.ACT_SAVE_SNAPSHOT, keyrouter.ACT_SAVE_SNAPSHOT)
        self.assertIs(main.ACT_HISTORY, keyrouter.ACT_HISTORY)
        self.assertIs(main.ACT_HELP, keyrouter.ACT_HELP)
        self.assertIs(main.render_message, messages.render_message)
        self.assertIs(main.list_template_ids, messages.list_template_ids)
        self.assertIs(main.BANNER_TEMPLATES, messages.BANNER_TEMPLATES)

    def test_main_new_apis_callable_without_side_effects(self):
        """关键名字存在且可调用；纯函数级调用无需真实环境即可验证行为回拷正确。"""
        import main
        for name in (
            "compute_fingerprint",
            "light_refresh",
            "deep_refresh",
            "clear_fingerprint_cache",
            "save_snapshot",
            "load_snapshot",
            "list_snapshots",
            "get_snapshot_dir",
            "should_auto_save",
            "compare_snapshots",
            "top_growth",
            "diff_from_current",
            "format_row",
            "key_to_action",
            "help_text",
            "render_message",
            "list_template_ids",
            "EverythingQueryDispatcher",
        ):
            self.assertTrue(callable(getattr(main, name)), "%s 应可调用" % name)
        # 行为级抽样：纯函数调用按回拷语义正常工作
        self.assertEqual(main.key_to_action(b"q"), keyrouter.ACT_QUIT)
        self.assertEqual(main.format_row({"path": "D:\\x", "delta": 512, "growth_pct": None}),
                         compare.format_row({"path": "D:\\x", "delta": 512, "growth_pct": None}))
        self.assertIn("D:\\x", main.format_row({"path": "D:\\x", "delta": 0, "growth_pct": None}))
        self.assertEqual(main.render_message("E_BUSY"), messages.render_message("E_BUSY"))
        self.assertIn("轻刷", main.help_text())
        self.assertEqual(main.SNAPSHOT_FORMAT_VERSION, snapshots.SNAPSHOT_FORMAT_VERSION)

    def test_main_dynamic_forwarding_still_intact(self):
        """可变全局动态转发不受新增静态 re-export 影响（DLL_PATH/VERBOSE 仍读写通）。"""
        import main
        import utils
        old = utils.VERBOSE
        try:
            main.VERBOSE = False
            self.assertFalse(utils.VERBOSE)
            self.assertFalse(main.VERBOSE)
        finally:
            utils.VERBOSE = old
        self.assertIn("VERBOSE", dir(main))


if __name__ == "__main__":
    unittest.main()