"""P12·W2.11 保存/撤销语义补全测试：台账回滚、逐盘成败、越界拒删、原子清单。"""

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import fullscan
import session
import snapshots


GUID = "deadbeef-1234"


class SaveUndoSemanticsTests(unittest.TestCase):
    """B-1/B-2/SEC-4/B-5 四件套。"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.data_dir = Path(self._tmp.name) / "data"
        self.snap_dir = Path(self._tmp.name) / "snap"
        # session 清单目录 → 隔离数据目录；快照目录经 DSA_SNAPSHOT_DIR 重定向
        patchers = [
            mock.patch.object(session.datadir, "get_data_dir", return_value=self.data_dir),
            mock.patch.dict(os.environ, {"DSA_SNAPSHOT_DIR": str(self.snap_dir)}),
        ]
        for p in patchers:
            p.start()
            self.addCleanup(p.stop)
        fullscan.BROWSE_INDEX.clear()

    def _mock_scan_result(self, roots):
        return {
            "roots": {
                root: {"root": root, "rows": [{"p": root, "s": 1000}]}
                for root in roots
            },
            "scan_version": 1,
        }

    def _post_save(self):
        from app import app

        with app.test_client() as client:
            with mock.patch.object(fullscan, "is_running", return_value=False), \
                    mock.patch.object(fullscan, "result",
                                      return_value=self._mock_scan_result(["C:\\T"])):
                resp = client.post("/api/save", json={"auto": False})
        return resp

    def _post_undo(self):
        from app import app

        with app.test_client() as client:
            resp = client.post("/api/save/undo", json={})
        return resp

    def test_save_undo_restores_fingerprint_predicate(self):
        """保存→undo→should_auto_save：指纹谓词判「变」（不抑制下次自动保存）。"""
        resp = self._post_save()
        self.assertEqual(resp.status_code, 200)
        snap_files = list(self.snap_dir.glob("*.snap.gz"))
        self.assertEqual(len(snap_files), 1)
        ledger = snapshots.load_ledger(self.snap_dir)
        self.assertIn("C:\\T", ledger, "保存后台账应记录该根")

        undo_resp = self._post_undo()
        self.assertEqual(undo_resp.status_code, 200)
        body = undo_resp.get_json()
        self.assertEqual(len(body["deleted"]), 1)
        self.assertFalse(list(self.snap_dir.glob("*.snap.gz")), "undo 后快照应删除")
        ledger_after = snapshots.load_ledger(self.snap_dir)
        self.assertNotIn(
            "C:\\T", ledger_after,
            "台账备份为 None 时 undo 应移除该根键（恢复到保存前状态）",
        )
        # 指纹谓词恢复：无台账 → 视为变化，不抑制下次自动保存
        ok, reason = snapshots.should_auto_save(
            "C:\\T", tree_complete=True, dirty=False,
            fingerprint={"count": 9, "crc32": 9}, ledger=ledger_after,
        )
        self.assertTrue(ok)

    def test_partial_failure_lists_saved_and_failed(self):
        """mock 第二盘 OSError：第一盘 saved、第二盘 failed、清单仍落盘。"""
        from app import app

        dummy = self.snap_dir / "dummy"
        self.snap_dir.mkdir(parents=True, exist_ok=True)
        dummy.write_text("x", encoding="utf-8")

        def fake_save(root, rows, **kwargs):
            if str(root) == "C:\\T2":
                raise OSError("disk full")
            return Path(dummy)

        sessions_before = set(p.name for p in session.list_sessions())
        with app.test_client() as client:
            with mock.patch.object(fullscan, "is_running", return_value=False), \
                    mock.patch.object(fullscan, "result",
                                      return_value=self._mock_scan_result(["C:\\T1", "C:\\T2"])), \
                    mock.patch.object(snapshots, "save_snapshot", side_effect=fake_save):
                resp = client.post("/api/save", json={"auto": False})
        self.assertEqual(resp.status_code, 200)
        body = resp.get_json()
        self.assertEqual([r["root"] for r in body["saved"]], ["C:\\T1"])
        self.assertEqual([f["root"] for f in body["failed"]], ["C:\\T2"])
        self.assertIn("disk full", body["failed"][0]["error"])
        sessions_after = set(p.name for p in session.list_sessions()) - sessions_before
        self.assertEqual(len(sessions_after), 1, "部分失败时清单仍必须落盘")

    def test_undo_rejects_out_of_snapshot_dir_paths(self):
        """伪造清单指向快照目录外：不 unlink，errors 含「越界」。"""
        outside = Path(self._tmp.name) / "outside.snap.gz"
        outside.write_text("keep me", encoding="utf-8")
        payload = {
            "session_id": "session_test_0001",
            "auto": False,
            "machine_guid": GUID,
            "roots": {
                "C:\\Evil": {
                    "root": "C:\\Evil",
                    "snapshot": "outside.snap.gz",
                    "snapshot_path": str(outside),
                    "skipped": False,
                }
            },
        }
        self.data_dir.mkdir(parents=True, exist_ok=True)
        (self.data_dir / "session_test_0001.json").write_text(
            json.dumps(payload, ensure_ascii=False), encoding="utf-8"
        )
        resp = self._post_undo()
        self.assertEqual(resp.status_code, 200)
        body = resp.get_json()
        self.assertTrue(outside.exists(), "越界路径绝不能被 unlink")
        self.assertTrue(any("越界" in e for e in body["undeleted"]), body["undeleted"])

    def test_session_atomic_write_no_tmp_leftover(self):
        """save_session 原子写：os.replace 内容完整且无 .tmp 残留。"""
        target_dir = self.data_dir / "sessions"
        path = session.save_session({"k": "v"}, dir_path=target_dir)
        self.assertTrue(path.exists())
        data = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(data["k"], "v")
        self.assertEqual(list(target_dir.glob("*.tmp")), [], "不得残留 .tmp 文件")


if __name__ == "__main__":
    unittest.main()
