"""阶段G追加后端契约测试（G-2 P-4 sparkline 数据源 / G-6 P13-FIX 若落地）。

覆盖（隔离数据目录，禁真实 %LOCALAPPDATA%）：
- G-2 total_by_root 派生：
  - 会话各根快照 → /api/snapshots 每会话 additive total_by_root {root: bytes}；
  - 派生口径与 compare._total_from_root_rows 一致（根行聚合值，含后代聚合）；
  - 旧字段零变化：session_id/auto/machine_guid/roots/ledger_backup/created_at
    逐键与派生前一致（additive 契约）；
  - 缺失/损坏快照 → 该根不在 total_by_root（不报错）；
  - 跳过（skipped）根 → 不派生；
- G-6 P13-FIX（若授权落地）：test_budget 并发锁 50 轮纪律判定在门禁处跑，
  本文件不重复；此处补锁文件打开/清理的回归锚点（供 W2.3 陈旧锁语义回归）。

编码规约继承既有契约护栏：with app.test_client() as client + 逐 resp close
（-W error::ResourceWarning 门禁）；新增字段一律 additive。
"""

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import compare
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


class SnapshotsTotalByRootTests(unittest.TestCase):
    """G-2：/api/snapshots additive total_by_root 契约。"""

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
        self.snap_dir.mkdir(parents=True, exist_ok=True)
        self.data_dir.mkdir(parents=True, exist_ok=True)

    def _write_session(self, name, roots_payload, created_at="2026-09-05T10:00:00"):
        """直接写 session 清单（roots: {root: {snapshot_path,...}}）。"""
        payload = {
            "session_id": name,
            "auto": False,
            "machine_guid": LOCAL_GUID,
            "roots": roots_payload,
            "ledger_backup": {},
            "created_at": created_at,
        }
        (self.data_dir / (name + ".json")).write_text(
            json.dumps(payload, ensure_ascii=False), encoding="utf-8"
        )

    def _get_snapshots(self):
        with app.test_client() as client:
            resp = client.get("/api/snapshots")
            data = resp.get_json()
            resp.close()
        return resp.status_code, data

    def test_total_by_root_derived_from_root_row(self):
        """派生口径 = 根行聚合值（含后代聚合），与 compare 差值卡 total_current 一致。"""
        rows = [{"p": "C:\\T", "s": 100}, {"p": "C:\\T\\a", "s": 40}]
        snap = _snapshot_file(self.snap_dir, "C:\\T", rows=rows)
        self._write_session("session_g2_1", {"C:\\T": {
            "root": "C:\\T", "snapshot": "x.snap.gz", "snapshot_path": snap, "skipped": False,
        }})
        code, data = self._get_snapshots()
        self.assertEqual(code, 200)
        self.assertEqual(data["count"], 1)
        sess = data["sessions"][0]
        self.assertEqual(sess["total_by_root"], {"C:\\T": 100})
        # 与 compare._total_from_root_rows 同口径交叉验证
        loaded = snapshots.load_snapshot(Path(snap))
        expect = compare._total_from_root_rows(
            {row["p"]: row["s"] for row in loaded["rows"]},
            root_hint=loaded["header"]["root"],
        )
        self.assertEqual(sess["total_by_root"]["C:\\T"], expect)

    def test_old_fields_zero_change(self):
        """additive：既有字段逐键与派生前一致（绝不改写既有语义）。"""
        snap = _snapshot_file(self.snap_dir, "C:\\T")
        roots_payload = {"C:\\T": {
            "root": "C:\\T", "snapshot": "x.snap.gz", "snapshot_path": snap, "skipped": False,
        }}
        self._write_session("session_g2_2", roots_payload, created_at="2026-09-05T11:00:00")
        code, data = self._get_snapshots()
        sess = data["sessions"][0]
        keys = ["session_id", "auto", "machine_guid", "roots", "ledger_backup", "created_at"]
        for k in keys:
            self.assertIn(k, sess, "既有字段缺失: " + k)
        self.assertEqual(sess["session_id"], "session_g2_2")
        self.assertEqual(sess["auto"], False)
        self.assertEqual(sess["machine_guid"], LOCAL_GUID)
        self.assertEqual(sess["roots"], roots_payload)
        self.assertEqual(sess["ledger_backup"], {})
        self.assertEqual(sess["created_at"], "2026-09-05T11:00:00")
        # _file 为既有 additive（阶段 F 前已有），total_by_root 为本次新增
        self.assertEqual(sess["_file"], "session_g2_2.json")

    def test_missing_corrupt_snapshot_skipped(self):
        """缺失/损坏快照 → 该根不在 total_by_root（不报错，其余根正常）。"""
        good = _snapshot_file(self.snap_dir, "C:\\G")
        bad = str(self.snap_dir / "missing.snap.gz")  # 文件不存在
        corrupt = str(self.snap_dir / "corrupt.snap.gz")
        Path(corrupt).write_text("not gzip", encoding="utf-8")
        self._write_session("session_g2_3", {
            "C:\\G": {"root": "C:\\G", "snapshot": "g.snap.gz", "snapshot_path": good, "skipped": False},
            "C:\\M": {"root": "C:\\M", "snapshot": "m.snap.gz", "snapshot_path": bad, "skipped": False},
            "C:\\K": {"root": "C:\\K", "snapshot": "k.snap.gz", "snapshot_path": corrupt, "skipped": False},
        })
        code, data = self._get_snapshots()
        self.assertEqual(code, 200)
        sess = data["sessions"][0]
        self.assertEqual(sess["total_by_root"], {"C:\\G": 100},
                         "缺失/损坏根应跳过，良好根仍派生")

    def test_skipped_root_not_derived(self):
        """skipped 根（无快照文件）不参与派生。"""
        self._write_session("session_g2_4", {
            "C:\\S": {"root": "C:\\S", "snapshot": None, "snapshot_path": None,
                      "skipped": True, "skip_reason": "day_budget_exceeded"},
        })
        code, data = self._get_snapshots()
        self.assertEqual(code, 200)
        self.assertEqual(data["sessions"][0]["total_by_root"], {})

    def test_multi_session_per_root_sequence(self):
        """多会话同根 → total_by_root 各会话独立（sparkline 时间序列数据源）。

        ⚠️ 夹具注意：同根同日两次 save_snapshot 会落同名文件（时间戳+根名），
        后写覆盖先写——故两份快照分存不同子目录保证文件互异。
        """
        rows1 = [{"p": "C:\\T", "s": 100}, {"p": "C:\\T\\a", "s": 40}]
        rows2 = [{"p": "C:\\T", "s": 200}, {"p": "C:\\T\\a", "s": 60}]
        (self.snap_dir / "v1").mkdir(exist_ok=True)
        (self.snap_dir / "v2").mkdir(exist_ok=True)
        snap1 = str(snapshots.save_snapshot(
            "C:\\T", rows1, dir_path=self.snap_dir / "v1", auto=False,
            machine_guid=LOCAL_GUID, fingerprint={"count": len(rows1), "crc32": 1},
        ))
        snap2 = str(snapshots.save_snapshot(
            "C:\\T", rows2, dir_path=self.snap_dir / "v2", auto=False,
            machine_guid=LOCAL_GUID, fingerprint={"count": len(rows2), "crc32": 2},
        ))
        self.assertNotEqual(snap1, snap2)
        self._write_session("session_g2_5a", {"C:\\T": {
            "root": "C:\\T", "snapshot": Path(snap1).name, "snapshot_path": snap1, "skipped": False,
        }}, created_at="2026-09-05T08:00:00")
        self._write_session("session_g2_5b", {"C:\\T": {
            "root": "C:\\T", "snapshot": Path(snap2).name, "snapshot_path": snap2, "skipped": False,
        }}, created_at="2026-09-05T09:00:00")
        code, data = self._get_snapshots()
        self.assertEqual(code, 200)
        # 时间降序（list_sessions 按名降序）：后写者（b）在前
        seq = [s["total_by_root"]["C:\\T"] for s in data["sessions"]]
        self.assertEqual(seq, [200, 100], "各会话独立派生，改量反映在后续总点")


if __name__ == "__main__":
    unittest.main()