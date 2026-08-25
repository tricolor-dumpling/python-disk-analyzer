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
import unittest
from unittest import mock

import sdk
from app import app


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


if __name__ == "__main__":
    unittest.main()
