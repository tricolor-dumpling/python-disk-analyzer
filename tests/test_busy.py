"""P12·W2.1 统一持锁＋busy 契约测试：health busy 形态、compare 409、锁同一性。"""

import time
import unittest
from unittest import mock

import app as app_module
import fullscan
import scan
import sdk
from app import app


def _keys(body):
    return set(body.keys())


class BusyHealthContractTests(unittest.TestCase):
    """硬性契约：busy ≠ 未就绪。"""

    def test_health_busy_when_lock_held(self):
        """锁被占 → GET /api/health 立即返回 {ready:false,busy:true,reason:scanning}。"""
        with app.test_client() as client:
            with scan.SCAN_LOCK:  # 模拟全量扫描持锁（busy 分支在配置读取之前返回）
                t0 = time.time()
                resp = client.get("/api/health")
            elapsed_ms = (time.time() - t0) * 1000
        self.assertEqual(resp.status_code, 200)
        body = resp.get_json()
        self.assertIs(body["ok"], True)
        self.assertIs(body["ready"], False)
        self.assertIs(body["busy"], True)
        self.assertEqual(body["reason"], "scanning")
        self.assertIn("扫描中", body["message"])
        self.assertLess(elapsed_ms, 100, "busy 探测不得阻塞（应立即返回）")

    def test_health_idle_additive_busy_false(self):
        """锁空闲 → 原 ready/dll/message 字段不变＋busy:false additive。"""
        fake_dll = "C:\\fake\\Everything64.dll"
        with app.test_client() as client:
            with mock.patch.object(sdk, "DLL_PATH", fake_dll), \
                    mock.patch.object(sdk, "is_everything_ipc_ready", return_value=True):
                resp = client.get("/api/health")
        body = resp.get_json()
        self.assertIs(body["ready"], True)
        self.assertEqual(body["dll"], str(fake_dll))
        self.assertIs(body["busy"], False)
        self.assertEqual(_keys(body), {"ok", "ready", "dll", "message", "busy"})

    def test_compare_returns_409_when_scan_in_progress(self):
        """扫描中 POST /api/compare → 409 而非阻塞等待。"""
        import tempfile
        from pathlib import Path
        import snapshots
        snapshots_dir = tempfile.TemporaryDirectory()
        try:
            baseline = snapshots.save_snapshot(
                "C:\\x", [{"p": "C:\\x", "s": 1}],
                dir_path=Path(snapshots_dir.name), auto=False,
                machine_guid="deadbeef-1234",
                fingerprint={"count": 1, "crc32": 0},
            )
            with app.test_client() as client:
                with scan.SCAN_LOCK:
                    t0 = time.time()
                    resp = client.post(
                        "/api/compare",
                        json={"root": "C:\\x", "baseline": str(baseline)},
                    )
                elapsed_ms = (time.time() - t0) * 1000
            self.assertEqual(resp.status_code, 409)
            self.assertIn("稍后再对比", resp.get_json()["error"])
            self.assertLess(elapsed_ms, 100)
        finally:
            snapshots_dir.cleanup()

    def test_lock_identity_across_modules(self):
        """双模块锁同一性：scan.SCAN_LOCK 与 fullscan.GLOBAL_SCAN_LOCK 是同一对象。"""
        self.assertIs(scan.SCAN_LOCK, fullscan.GLOBAL_SCAN_LOCK)


def env_stub():
    """app 模块内通过 env 命名空间访问 load_config；供 patch 定位。"""
    import env
    return env


if __name__ == "__main__":
    unittest.main()
