"""P12·W2.13 machine_guid 强校验接线测试：三端拦截/放行矩阵。"""

import contextlib
import io
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import cli
import compare
import fullscan
import snapshots
import tui
from app import app

ROOT = Path("C:\\Users\\Test")
LOCAL_GUID = snapshots.get_machine_guid()
FOREIGN_GUID = "ffffffff-alien-machine-guid"


class EngineMachineCheckTests(unittest.TestCase):
    """compare.diff_from_current 默认拦截 / 显式放行 / 不传参行为不变。"""

    BASELINE_ROWS = [{"p": "C:\\T", "s": 100}]

    def test_foreign_baseline_blocked_by_default(self):
        exc = None
        try:
            compare.diff_from_current(
                {Path("C:\\T"): 120}, self.BASELINE_ROWS,
                machine_guid=FOREIGN_GUID, local_machine_guid=LOCAL_GUID,
            )
        except compare.CompareError as e:
            exc = e
        self.assertIsNotNone(exc)
        self.assertEqual(getattr(exc, "kind", None), "machine_mismatch")
        self.assertIn("机器标识不一致", str(exc))

    def test_allow_flag_passes(self):
        report = compare.diff_from_current(
            {Path("C:\\T"): 120}, self.BASELINE_ROWS,
            machine_guid=FOREIGN_GUID, local_machine_guid=LOCAL_GUID,
            allow_other_machine=True,
        )
        self.assertEqual(report["total_baseline"], 100)

    def test_no_local_arg_keeps_legacy_behavior(self):
        """不传新参的既有调用行为完全不变（additive 红线）。"""
        report = compare.diff_from_current(
            {Path("C:\\T"): 120}, self.BASELINE_ROWS, machine_guid=FOREIGN_GUID,
        )
        self.assertEqual(report["delta_total"], 20)

    def test_local_baseline_not_blocked(self):
        report = compare.diff_from_current(
            {Path("C:\\T"): 120}, self.BASELINE_ROWS,
            machine_guid=LOCAL_GUID, local_machine_guid=LOCAL_GUID,
        )
        self.assertEqual(report["delta_total"], 20)


class CliMachineFlagTests(unittest.TestCase):
    """CLI 端：异机基线默认 exit 1；--allow-other-machine 正常出报告。"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.snap_dir = Path(self._tmp.name)
        self.baseline = snapshots.save_snapshot(
            "C:\\T", [{"p": "C:\\T", "s": 100}],
            dir_path=self.snap_dir, auto=False, machine_guid=FOREIGN_GUID,
            fingerprint={"count": 1, "crc32": 5},
        )

    def _run(self, extra_args):
        buf = io.StringIO()
        with contextlib.ExitStack() as stack:
            stack.enter_context(mock.patch.object(cli, "ensure_everything_running"))
            stack.enter_context(mock.patch.object(cli, "init_windows_job_sandbox"))
            stack.enter_context(mock.patch.object(
                cli, "scan_via_everything_sdk",
                return_value=({Path("C:\\T"): 150}, {}),
            ))
            stack.enter_context(contextlib.redirect_stdout(buf))
            try:
                cli.main(argv=[str(self.snap_dir)] + extra_args +
                         ["--baseline", str(self.baseline)])
                exc = None
            except SystemExit as e:
                exc = e
        return exc, buf.getvalue()

    def test_cli_blocks_foreign_baseline_by_default(self):
        exc, output = self._run([])
        self.assertIsNotNone(exc)
        self.assertEqual(exc.code, 1)
        self.assertIn("机器标识不一致", output)

    def test_cli_allow_flag_produces_report(self):
        exc, output = self._run(["--allow-other-machine"])
        self.assertIsNone(exc)
        self.assertIn("合计变化", output)


class WebMachineMismatchTests(unittest.TestCase):
    """Web 端：409+code=machine_mismatch；allow:true 二次提交 200。"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.baseline = snapshots.save_snapshot(
            "C:\\X", [{"p": "C:\\X", "s": 100}],
            dir_path=Path(self._tmp.name), auto=False, machine_guid=FOREIGN_GUID,
            fingerprint={"count": 1, "crc32": 6},
        )
        cached = {"root": "C:\\X", "rows": [{"p": "C:\\X", "s": 130}]}

        class _Ctx:
            def __enter__(self):
                self.patches = [
                    mock.patch.object(fullscan, "is_running", return_value=False),
                    mock.patch.object(fullscan, "result", return_value=cached),
                ]
                for p in self.patches:
                    p.start()
                return self

            def __exit__(self, *a):
                for p in reversed(self.patches):
                    p.stop()

        self._ctx = _Ctx()

    def test_web_409_then_allow_second_submit_200(self):
        with app.test_client() as client, self._ctx:
            resp = client.post("/api/compare",
                               json={"root": "C:\\X", "baseline": str(self.baseline)})
            self.assertEqual(resp.status_code, 409)
            body = resp.get_json()
            self.assertEqual(body["code"], "machine_mismatch")
            resp.close()

            resp = client.post("/api/compare", json={
                "root": "C:\\X", "baseline": str(self.baseline),
                "allow_other_machine": True,
            })
            self.assertEqual(resp.status_code, 200)
            self.assertEqual(resp.get_json()["report"]["delta_total"], 30)
            resp.close()


class TuiMachineConfirmTests(unittest.TestCase):
    """TUI 端：异机基线红字确认——按 Y 进入对比视图，其他键返回列表态。"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.snap_dir = Path(self._tmp.name)
        patches = [
            mock.patch.dict(os.environ, {"DSA_SNAPSHOT_DIR": str(self.snap_dir)}),
            mock.patch("shutil.get_terminal_size",
                       return_value=os.terminal_size((120, 40))),
            mock.patch("os.system"),
            mock.patch.object(tui, "_ANSI_AVAILABLE", False),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        snapshots.save_snapshot(
            ROOT, [{"p": str(ROOT), "s": 100}],
            dir_path=self.snap_dir, auto=False, machine_guid=FOREIGN_GUID,
            fingerprint={"count": 1, "crc32": 7},
        )
        # 固定本机 guid（防注册表读取差异）
        p = mock.patch.object(snapshots, "get_machine_guid", return_value=LOCAL_GUID)
        p.start()
        self.addCleanup(p.stop)

    def _run(self, keys, inputs):
        buf = io.StringIO()
        with contextlib.ExitStack() as stack:
            stack.enter_context(mock.patch.object(tui, "_getch", side_effect=list(keys)))
            stack.enter_context(mock.patch("builtins.input", side_effect=list(inputs)))
            with contextlib.redirect_stdout(buf):
                result = tui.interactive_ui(
                    ROOT, {ROOT: 100},
                    {ROOT: [("a.txt", False, 100)]}, "test-driver",
                )
        return result, buf.getvalue()

    def test_press_y_enters_diff_view(self):
        result, output = self._run([b"H", b"y", b"x", b"Q"], [""])
        self.assertEqual(result, ("quit", None))
        self.assertIn("机器标识不一致", output.replace("\r", ""))
        self.assertIn("历史对比:", output, "按 Y 后应进入对比视图")

    def test_other_key_returns_to_list(self):
        result, output = self._run([b"H", b"n", b"Q"], [""])
        self.assertEqual(result, ("quit", None))
        self.assertIn("机器标识不一致", output.replace("\r", ""))
        self.assertNotIn("历史对比:", output.replace("\r", ""), "未按 Y 应返回列表态")


if __name__ == "__main__":
    unittest.main()
