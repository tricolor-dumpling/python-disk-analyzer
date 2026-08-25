"""Web API 字段契约护栏（P12·W1.0，RT-03）。

用 app.test_client() 直连，冻结既有响应键集合：
- GET  /api/health   -> {ok, ready, dll, message}
- POST /api/browse   正常 {ok, root, parent, directories, files,
                            total_dirs, total_files} / 错误 {ok, error}
- POST /api/compare  错误分支 {ok, error}（report 键集合由 W1.2 扩展时同 PR 增补）
- GET  /api/settings -> {ok, settings, data_dir, snapshots_dir}

web 契约测试编码规约（自此生效）：一律 ``with app.test_client() as client:``
且逐 resp 关闭（with-resp/close），杜绝 ResourceWarning；discover 统一加
``-W error::ResourceWarning``。新增字段一律 additive：本文件只允许「增键」，
删除既有键必须先改本文件并说明。
"""

import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import compare
import fullscan
import snapshots
import sdk
from app import app


GUID = "deadbeef-1234-5678-9abc-def012345678"


def _keys(body):
    return set(body.keys())


class ApiContractTests(unittest.TestCase):
    """既有 API 响应键集合冻结（additive 红线的对照基线）。"""

    def test_health_shape(self):
        """GET /api/health 就绪形态：键集合恰为 {ok, ready, dll, message}。"""
        with app.test_client() as client:
            with mock.patch.object(sdk, "DLL_PATH", "C:\\fake\\Everything64.dll"), \
                    mock.patch.object(sdk, "is_everything_ipc_ready", return_value=True):
                resp = client.get("/api/health")
            self.assertEqual(resp.status_code, 200)
            body = resp.get_json()
            self.assertEqual(
                _keys(body), {"ok", "ready", "dll", "message"},
                f"/api/health 键集合漂移: {_keys(body)}",
            )
            self.assertIs(body["ok"], True)
            self.assertIs(body["ready"], True)
            self.assertEqual(body["message"], "Everything 已就绪")
            resp.close()

    def test_browse_error_shape(self):
        """POST /api/browse 缺参错误形态：键集合恰为 {ok, error}。"""
        with app.test_client() as client:
            resp = client.post("/api/browse", json={})
            self.assertEqual(resp.status_code, 400)
            body = resp.get_json()
            self.assertEqual(_keys(body), {"ok", "error"})
            self.assertIs(body["ok"], False)
            self.assertTrue(body["error"])
            resp.close()

    def test_settings_get_shape(self):
        """GET /api/settings：键集合恰为 {ok, settings, data_dir, snapshots_dir}。"""
        with app.test_client() as client:
            resp = client.get("/api/settings")
            self.assertEqual(resp.status_code, 200)
            body = resp.get_json()
            self.assertEqual(
                _keys(body), {"ok", "settings", "data_dir", "snapshots_dir"},
                f"/api/settings 键集合漂移: {_keys(body)}",
            )
            self.assertIsInstance(body["settings"], dict)
            self.assertIsInstance(body["data_dir"], str)
            self.assertIsInstance(body["snapshots_dir"], str)
            resp.close()

    def test_compare_error_shape(self):
        """POST /api/compare 缺参错误形态：键集合恰为 {ok, error}。"""
        with app.test_client() as client:
            resp = client.post("/api/compare", json={})
            self.assertEqual(resp.status_code, 400)
            body = resp.get_json()
            self.assertEqual(_keys(body), {"ok", "error"})
            self.assertIn("root", body["error"])
            resp.close()

    def test_compare_report_shape_and_three_cards_consistent(self):
        """P12·W1.2：report 键集合冻结（+legacy_count additive）；三卡数值与直调
        diff_from_current 全等（CLI==Web==engine 同口径）。"""
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        baseline_rows = [
            {"p": "D:\\T", "s": 7050},
            {"p": "D:\\T\\sub", "s": 4000},
            {"p": "D:\\T\\sub\\deep", "s": 2500},
        ]
        current_rows = [
            {"p": "D:\\T", "s": 6050},
            {"p": "D:\\T\\sub", "s": 4000},
            {"p": "D:\\T\\sub\\deep", "s": 1500},
        ]
        baseline_file = snapshots.save_snapshot(
            "D:\\T",
            baseline_rows,
            dir_path=Path(tmp.name),
            auto=False,
            machine_guid=GUID,
            fingerprint={"count": len(baseline_rows), "crc32": 0},
        )
        # fullscan.result(root=...) 的返回契约是单根条目 {"root": ..., "rows": [...]}
        cached_result = {
            "root": "D:\\T",
            "rows": [{"p": row["p"], "s": row["s"]} for row in current_rows],
        }
        with app.test_client() as client:
            with mock.patch.object(fullscan, "is_running", return_value=False), \
                    mock.patch.object(fullscan, "result", return_value=cached_result):
                resp = client.post(
                    "/api/compare",
                    json={"root": "D:\\T", "baseline": str(baseline_file)},
                )
            self.assertEqual(resp.status_code, 200)
            body = resp.get_json()
            report = body["report"]
            self.assertEqual(
                _keys(report),
                {"root", "total_baseline", "total_current", "delta_total",
                 "truncated", "legacy_count", "rows"},
                f"/api/compare report 键集合漂移: {_keys(report)}",
            )
            # 三卡（基线总大小/当前总大小/总变化量）与直调引擎全等（根行口径）
            engine = compare.diff_from_current(
                {Path(row["p"]): int(row["s"]) for row in current_rows},
                baseline_rows,
            )
            self.assertEqual(report["total_baseline"], engine["total_baseline"])
            self.assertEqual(report["total_current"], engine["total_current"])
            self.assertEqual(report["delta_total"], engine["delta_total"])
            self.assertEqual(report["delta_total"], -1000)
            resp.close()


if __name__ == "__main__":
    unittest.main()
