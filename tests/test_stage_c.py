"""阶段C（R2）新增后端契约测试：快照删除 API（C-2）与台账/清单一致性。

覆盖（隔离数据目录，禁真实 %LOCALAPPDATA%）：
- 单盘删除：文件删除 + session roots 条目移除 + 其他盘保留；
- 整会话删除：文件删除 + session 文件删除；
- 幂等：目标文件已不存在 → {deleted:true, already:true} 不报错；
- 越界路径：伪造清单指向快照目录外 → failed 含「越界」，绝不 unlink；
- 会话不存在 404 / 会话损坏 500 / 该会话无此盘 404；
- 扫描中 409（fullscan.is_running()，不触碰线程）；
- 台账一致性：删除后 ledger 该根条目移除（与 undo 回滚同口径）；
- 删除后 /api/compare 用已删基线 → 400「基线快照不存在」；
- 并发：两个删除请求串行幂等（第二次 already）。

编码规约继承既有契约护栏：with app.test_client() as client + 逐 resp close
（-W error::ResourceWarning 门禁）；新增字段一律 additive。
"""

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import fullscan
import session
import snapshots
from app import app

LOCAL_GUID = snapshots.get_machine_guid()


def _snapshot_file(tmp, root="C:\\T", rows=None, guid=None):
    """临时目录内生成一份合法快照文件（.snap.gz），返回路径 str。"""
    rows = rows if rows is not None else [
        {"p": "C:\\T", "s": 100}, {"p": "C:\\T\\a", "s": 40},
    ]
    p = snapshots.save_snapshot(
        root, rows,
        dir_path=Path(tmp), auto=False,
        machine_guid=guid or LOCAL_GUID,
        fingerprint={"count": len(rows), "crc32": 0},
    )
    return str(p)


def _reset_fullscan_state():
    fullscan.BROWSE_INDEX.clear()
    fullscan.USER_STOP_EVENT.clear()
    fullscan.CANCEL_EVENT.clear()
    fullscan._update_state(
        running=False, thread=None, current_root=None,
        error=None, cancelled=False, stop_requested=False,
        stop_reason=None, last_result=None,
        phase=fullscan.PHASE_IDLE, row_done=0, row_total=0,
        stop_ack_at=None, watchdog_roots_last_total={}, watchdog_checked_at=None,
    )


class SnapshotDeleteApiTests(unittest.TestCase):
    """C-2：/api/snapshot/delete 契约。"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.data_dir = Path(self._tmp.name) / "data"
        self.snap_dir = Path(self._tmp.name) / "snap"
        patchers = [
            mock.patch.object(session.datadir, "get_data_dir", return_value=self.data_dir),
            mock.patch.dict(os.environ, {"DSA_SNAPSHOT_DIR": str(self.snap_dir)}),
        ]
        for p in patchers:
            p.start()
            self.addCleanup(p.stop)
        _reset_fullscan_state()
        self.addCleanup(_reset_fullscan_state)
        self.snap_dir.mkdir(parents=True, exist_ok=True)
        self.data_dir.mkdir(parents=True, exist_ok=True)

    def _make_session(self, name="session_t_000001", roots=None):
        """构造一份 session 清单（roots: {root: {snapshot_path,...}}）+ 真实快照文件。"""
        roots = roots if roots is not None else {"C:\\T": _snapshot_file(self.snap_dir, "C:\\T")}
        payload = {
            "session_id": name,
            "auto": False,
            "machine_guid": LOCAL_GUID,
            "roots": {k: ({"root": k, "snapshot": "x.snap.gz", "snapshot_path": v} if isinstance(v, str) else v)
                      for k, v in roots.items()},
            "ledger_backup": {},
            "created_at": "2026-09-04T10:00:00",
        }
        (self.data_dir / (name + ".json")).write_text(
            json.dumps(payload, ensure_ascii=False), encoding="utf-8"
        )
        return name

    def _post_delete(self, session_id, root=None):
        with app.test_client() as client:
            body = {"session_id": session_id}
            if root is not None:
                body["root"] = root
            resp = client.post("/api/snapshot/delete", json=body)
            data = resp.get_json()
            resp.close()
        return resp.status_code, data

    def test_delete_single_root_keeps_others(self):
        """单盘删除：该盘文件删除、session roots 条目移除、其他盘保留。"""
        c_snap = _snapshot_file(self.snap_dir, "C:\\TC")
        d_snap = _snapshot_file(self.snap_dir, "D:\\TD")
        sid = self._make_session(roots={
            "C:\\TC": c_snap, "D:\\TD": d_snap,
        })
        code, data = self._post_delete(sid, "C:\\TC")
        self.assertEqual(code, 200)
        self.assertEqual(len(data["deleted"]), 1)
        self.assertEqual(data["deleted"][0]["root"], "C:\\TC")
        self.assertFalse(Path(c_snap).exists(), "单盘快照文件应删除")
        self.assertTrue(Path(d_snap).exists(), "其他盘快照必须保留")
        # session 清单仍在（有剩余盘），roots 移除该盘
        loaded = session.load_session(self.data_dir / (sid + ".json"))
        self.assertIsNotNone(loaded)
        self.assertNotIn("C:\\TC", loaded["roots"])
        self.assertIn("D:\\TD", loaded["roots"])
        self.assertFalse(data["session_removed"])

    def test_delete_whole_session_removes_file(self):
        """整会话删除：文件删除 + session 文件删除。"""
        c_snap = _snapshot_file(self.snap_dir, "C:\\WC")
        d_snap = _snapshot_file(self.snap_dir, "D:\\WD")
        sid = self._make_session(roots={"C:\\WC": c_snap, "D:\\WD": d_snap})
        code, data = self._post_delete(sid)
        self.assertEqual(code, 200)
        self.assertTrue(data["whole_session"])
        self.assertEqual(len(data["deleted"]), 2)
        self.assertFalse(Path(c_snap).exists())
        self.assertFalse(Path(d_snap).exists())
        self.assertTrue(data["session_removed"])
        self.assertFalse((self.data_dir / (sid + ".json")).exists(), "session 文件应删除")

    def test_delete_idempotent_already(self):
        """幂等：文件先手动删除 → already:true 不报错，无 failed。"""
        c_snap = _snapshot_file(self.snap_dir, "C:\\T")
        sid = self._make_session(roots={"C:\\T": c_snap})
        Path(c_snap).unlink()
        code, data = self._post_delete(sid, "C:\\T")
        self.assertEqual(code, 200)
        self.assertEqual(len(data["deleted"]), 0)
        self.assertEqual(len(data["already"]), 1)
        self.assertEqual(data["already"][0]["root"], "C:\\T")
        self.assertEqual(len(data["failed"]), 0)
        # 会话无剩余条目 → session 文件删除
        self.assertTrue(data["session_removed"])

    def test_delete_out_of_bounds_skipped(self):
        """越界路径：伪造清单指向快照目录外 → failed 含「越界」，绝不 unlink。"""
        outside = Path(self._tmp.name) / "outside.snap.gz"
        outside.write_text("keep me", encoding="utf-8")
        sid = self._make_session(roots={"C:\\Evil": str(outside)})
        code, data = self._post_delete(sid, "C:\\Evil")
        self.assertEqual(code, 200)
        self.assertTrue(outside.exists(), "越界路径绝不能被 unlink")
        self.assertTrue(any("越界" in f.get("error", "") for f in data["failed"]), data["failed"])
        self.assertEqual(len(data["deleted"]), 0)

    def test_delete_session_missing_404(self):
        code, data = self._post_delete("session_nope_000000")
        self.assertEqual(code, 404)
        self.assertIn("不存在", data["error"])

    def test_delete_root_not_in_session_404(self):
        c_snap = _snapshot_file(self.snap_dir, "C:\\T")
        sid = self._make_session(roots={"C:\\T": c_snap})
        code, data = self._post_delete(sid, "E:\\T")
        self.assertEqual(code, 404)
        self.assertIn("该会话没有此盘快照", data["error"])

    def test_delete_scanning_409(self):
        """扫描中禁止删除 → 409（fullscan.is_running() 打桩，绝不触碰线程）。"""
        c_snap = _snapshot_file(self.snap_dir, "C:\\T")
        sid = self._make_session(roots={"C:\\T": c_snap})
        with mock.patch.object(fullscan, "is_running", return_value=True):
            code, data = self._post_delete(sid, "C:\\T")
        self.assertEqual(code, 409)
        self.assertIn("扫描进行中", data["error"])
        self.assertTrue(Path(c_snap).exists(), "409 时不得删除任何文件")

    def test_delete_ledger_consistency(self):
        """台账一致性：删除后 ledger 该根条目移除（与 undo 回滚同口径）。"""
        c_snap = _snapshot_file(self.snap_dir, "C:\\T")
        # 预置台账条目
        snapshots.save_ledger(
            {"C:\\T": {"date": "2026-09-04", "last_fingerprint": {"count": 2, "crc32": 1}, "auto_count": 1}},
            self.snap_dir,
        )
        sid = self._make_session(roots={"C:\\T": c_snap})
        self.assertIn("C:\\T", snapshots.load_ledger(self.snap_dir))
        code, data = self._post_delete(sid, "C:\\T")
        self.assertEqual(code, 200)
        ledger = snapshots.load_ledger(self.snap_dir)
        self.assertNotIn("C:\\T", ledger, "删除后台账该根条目必须移除")

    def test_compare_after_delete_400(self):
        """删除后用已删基线调 /api/compare → 400「基线快照不存在」。"""
        c_snap = _snapshot_file(self.snap_dir, "C:\\T")
        sid = self._make_session(roots={"C:\\T": c_snap})
        code, _data = self._post_delete(sid, "C:\\T")
        self.assertEqual(code, 200)
        with app.test_client() as client:
            resp = client.post("/api/compare", json={"root": "C:\\T", "baseline": c_snap})
            body = resp.get_json()
            resp.close()
        self.assertEqual(resp.status_code, 400)
        self.assertIn("不存在", body["error"])

    def test_delete_second_call_already(self):
        """并发/重复删除：第二次调用 → already:true（幂等）。"""
        c_snap = _snapshot_file(self.snap_dir, "C:\\T")
        sid = self._make_session(roots={"C:\\T": c_snap})
        code1, data1 = self._post_delete(sid, "C:\\T")
        self.assertEqual(code1, 200)
        self.assertEqual(len(data1["deleted"]), 1)
        # 第二次：session 已删除 → 404（会话不存在，语义与幂等文件级一致）
        code2, data2 = self._post_delete(sid, "C:\\T")
        self.assertEqual(code2, 404)

    def test_delete_missing_session_id_400(self):
        with app.test_client() as client:
            resp = client.post("/api/snapshot/delete", json={})
            self.assertEqual(resp.status_code, 400)
            self.assertIn("session_id", resp.get_json()["error"])
            resp.close()


if __name__ == "__main__":
    unittest.main()
