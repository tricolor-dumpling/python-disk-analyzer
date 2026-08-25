"""P12·W2.9 安全两项测试：SEC-1 设置投毒矩阵（W2.6 已落地，此处回归锚定）
与 SEC-2 Host 白名单中间件。"""

import tempfile
import unittest
from pathlib import Path
from unittest import mock

import env
from app import app


class HostGuardTests(unittest.TestCase):
    """SEC-2：Host 白名单（防 DNS rebinding）。"""

    def test_forged_host_gets_403_json(self):
        """伪造域名 Host → 403 JSON（页面与 API 同样拦截）。"""
        with app.test_client() as client:
            resp = client.get("/api/health", headers={"Host": "evil.example.com"})
            self.assertEqual(resp.status_code, 403)
            body = resp.get_json()
            self.assertIs(body["ok"], False)
            self.assertIn("非法访问来源", body["error"])
            resp.close()

    def test_loopback_hosts_pass(self):
        """127.0.0.1:port / localhost:port / [::1]:port 正常放行。"""
        with app.test_client() as client:
            for host in ("127.0.0.1:5000", "localhost:5000", "[::1]:5000"):
                with mock.patch.object(env, "load_config", return_value={}), \
                        mock.patch("sdk.DLL_PATH", "C:\\fake.dll"), \
                        mock.patch("sdk.is_everything_ipc_ready", return_value=True):
                    resp = client.get("/api/health", headers={"Host": host})
                self.assertEqual(resp.status_code, 200, f"Host {host} 应放行")
                resp.close()


class SettingsPoisonRegressionTests(unittest.TestCase):
    """SEC-1 回归锚点：投毒键 400 且不落盘（详细矩阵见 W2.6 K4 测试）。"""

    def test_poison_keys_rejected_and_not_persisted(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        config_path = Path(tmp.name) / "config.json"
        with app.test_client() as client, \
                mock.patch.object(env, "_default_config_path", return_value=config_path):
            for key in ("everything_exe", "everything_dll", "everything_startup_args"):
                resp = client.post("/api/settings", json={key: "C:\\evil.exe"})
                self.assertEqual(resp.status_code, 400)
                resp.close()
        self.assertFalse(config_path.exists(), "投毒请求不得产生任何落盘")


if __name__ == "__main__":
    unittest.main()
