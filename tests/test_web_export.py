"""P12·W2.7 Web 导出测试：build_* 与 CLI 产物等价、/api/export 契约与 legacy 行。"""

import io
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import cli
import fullscan
from app import app


class BuildReportEquivalenceTests(unittest.TestCase):
    """build_report_csv/json 与旧文件版产物逐字节等价（CLI 守护）。"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tmp = Path(self._tmp.name)
        self.root = Path("C:\\Export")
        self.sizes = {self.root: 1500, self.root / "a": 800, self.root / "b": 400}

    def test_build_csv_matches_legacy_file_output(self):
        new_file = self.tmp / "new.csv"
        old_file = self.tmp / "old.csv"
        cli.export_report_csv(self.root, self.sizes, old_file)
        new_file.write_text(cli.build_report_csv(self.sizes), encoding="utf-8-sig",
                            newline="")
        self.assertEqual(
            old_file.read_bytes(), new_file.read_bytes(),
            "build_report_csv 产物必须与旧 export_report_csv 逐字节一致",
        )

    def test_build_json_matches_legacy_file_output(self):
        old_file = self.tmp / "old.json"
        cli.export_report_json(self.root, self.sizes, old_file)
        rebuilt = self.tmp / "new.json"
        rebuilt.write_text(cli.build_report_json(self.root, self.sizes),
                           encoding="utf-8", newline="\n")
        self.assertEqual(old_file.read_text(encoding="utf-8"),
                         rebuilt.read_text(encoding="utf-8"))


class WebExportApiTests(unittest.TestCase):
    """/api/export 契约：响应头、404/400 JSON、legacy 提示。"""

    def _mock_result(self, unknown=0):
        return {
            "roots": {
                "C:\\X": {
                    "root": "C:\\X",
                    "rows": [{"p": "C:\\X", "s": 500}, {"p": "C:\\X\\a", "s": 300}],
                    "unknown_size_count": unknown,
                }
            },
            "completed_at": "2026-08-24T10:00:00",
            "ok": True,
        }

    def test_export_csv_ok_headers_and_body(self):
        with app.test_client() as client:
            with mock.patch.object(fullscan, "result", return_value=self._mock_result()):
                resp = client.get("/api/export?format=csv&root=C:\\X")
            self.assertEqual(resp.status_code, 200)
            self.assertIn("text/csv", resp.headers["Content-Type"])
            self.assertIn("attachment; filename=disk_report_", resp.headers["Content-Disposition"])
            text = resp.get_data(as_text=True)
            first_line = text.lstrip("\ufeff").splitlines()[0]
            self.assertEqual(first_line, "路径,大小(字节),大小(可读)")
            resp.close()

    def test_export_bad_format_and_missing_result(self):
        with app.test_client() as client:
            with mock.patch.object(fullscan, "result", return_value=None):
                resp = client.get("/api/export?format=csv")
            self.assertEqual(resp.status_code, 404)
            self.assertIs(resp.get_json()["ok"], False)
            resp.close()

            resp = client.get("/api/export?format=xml&root=C:\\X")
            self.assertEqual(resp.status_code, 400)
            self.assertIn("csv", resp.get_json()["error"])
            resp.close()

            # 根不在结果中 → 404
            with mock.patch.object(fullscan, "result", return_value=self._mock_result()):
                resp = client.get("/api/export?format=json&root=D:\\Y")
            self.assertEqual(resp.status_code, 404)
            resp.close()

    def test_export_legacy_notice_lines(self):
        """unknown_size_count=3：CSV 首行提示行；JSON legacy_notice 非空。"""
        with app.test_client() as client:
            with mock.patch.object(fullscan, "result", return_value=self._mock_result(3)):
                csv_resp = client.get("/api/export?format=csv")
                json_resp = client.get("/api/export?format=json")
            csv_text = csv_resp.get_data(as_text=True).lstrip("\ufeff")
            self.assertTrue(csv_text.startswith("# 提示：本数据源含 3 条"), csv_text[:60])
            payload = json_resp.get_json()
            self.assertIn("3 条大小未知", payload["legacy_notice"])
            csv_resp.close()
            json_resp.close()


if __name__ == "__main__":
    unittest.main()
