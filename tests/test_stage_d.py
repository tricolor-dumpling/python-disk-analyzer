"""阶段D（R3）新增后端契约测试（D-2 自动保存链路支撑、D-1 状态事实）。

覆盖（隔离数据目录，禁真实 %LOCALAPPDATA%）：
- 自动保存恰一次：完成 → save_ready=true → POST /api/save {auto:true}
  → 会话数 +1、session.auto=true、快照文件生成、fullscan.mark_saved
  → save_ready=false（frontend K7+save_ready 双门控的「恰一次」后端事实）；
- 自动保存谓词拒绝：台账当日已保存/指纹未变 → 逐盘 skipped 条目
  （skip_reason），无新会话；
- 保存失败可见：save_snapshot 抛错 → 响应 failed 清单含错误文案
  （frontend toast 不吞错误；全失败时 409「本次没有生成任何快照」）；
- 无结果 409「暂无可保存」（自动保存前置保护）；
- /api/snapshots 会话含 created_at（D-1「当日快照会话」判断的数据事实）。

编码规约继承既有契约护栏：with app.test_client() as client + 逐 resp close
（-W error::ResourceWarning 门禁）；新增字段一律 additive；snapshots.py 零改动
（P-1/P13 禁碰纪律，本文件只读消费其既有谓词）。
"""

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import fullscan
import session as session_module
import snapshots
from app import app

LOCAL_GUID = snapshots.get_machine_guid()


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
        saved_scan_version=0, scan_version=0,
    )


def _run_completed_scan(roots=("C:\\TA", "D:\\TB")):
    """用 fake SDK 完成一次全量扫描（等后台线程收尾），返回 status。"""
    def fake_scan(root_path_obj, everything=None, cancel_event=None, progress=None):
        sizes = {Path(root_path_obj): 100, Path(root_path_obj) / "a": 40}
        contents = {Path(root_path_obj): [("a", False, 40)]}
        if progress:
            progress(2, 2)
        return sizes, contents

    with mock.patch.object(fullscan, "scan_via_everything_sdk", side_effect=fake_scan):
        ret = fullscan.start(roots=list(roots), everything=object())
        thread = fullscan._copy_state()["thread"]
        if thread is not None:
            thread.join(timeout=5)
    return ret, fullscan.status()


class AutoSaveOnceContractTests(unittest.TestCase):
    """D-2：自动保存恰一次 + session.auto 标记 + save_ready 消费。"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.data_dir = Path(self._tmp.name) / "data"
        self.snap_dir = Path(self._tmp.name) / "snap"
        patchers = [
            mock.patch.object(session_module.datadir, "get_data_dir", return_value=self.data_dir),
            mock.patch.dict(os.environ, {"DSA_SNAPSHOT_DIR": str(self.snap_dir)}),
        ]
        for p in patchers:
            p.start()
            self.addCleanup(p.stop)
        _reset_fullscan_state()
        self.addCleanup(_reset_fullscan_state)
        self.snap_dir.mkdir(parents=True, exist_ok=True)
        self.data_dir.mkdir(parents=True, exist_ok=True)

    def _auto_save(self):
        with app.test_client() as client:
            resp = client.post("/api/save", json={"auto": True})
            body = resp.get_json()
            resp.close()
        return resp.status_code, body

    def test_auto_save_creates_session_exactly_once(self):
        """完成扫描 → 自动保存 → 会话数 +1、session.auto=true、快照文件生成；
        mark_saved 消费后 save_ready=false（前端 K7 门控的「恰一次」后端事实）。"""
        _ret, st = _run_completed_scan()
        self.assertTrue(st["result_ready"])
        self.assertTrue(st["save_ready"], "完成未保存时应 save_ready=true")

        code, body = self._auto_save()
        self.assertEqual(code, 200)
        self.assertTrue(body["session"]["auto"], "自动保存会话必须带 auto=true 标记（快照页「自动」标签）")
        self.assertEqual(len(body["saved"]), 2, "两盘均成功保存")
        sessions = session_module.list_sessions()
        self.assertEqual(len(sessions), 1, "自动保存后会话数应 +1")

        st2 = fullscan.status()
        self.assertFalse(st2["save_ready"], "自动保存消费后 save_ready 必须=false（恰一次门控）")

        # 手动再 POST auto（模拟前端失控）会再建会话——前端 K7/handledScanVersion
        # 才是「恰一次」闸门；此处登记后端无隐式闸门（需求=前端契约），仅记录事实
        code2, body2 = self._auto_save()
        self.assertEqual(code2, 200)
        self.assertEqual(len(session_module.list_sessions()), 2, "后端 auto 保存非幂等（由前端恰一次闸门兜底）")

    def test_save_session_created_at_present(self):
        """D-1「当日快照会话」判断的数据事实：/api/snapshots 会话含 created_at。"""
        _run_completed_scan(["C:\\TC"])
        self._auto_save()
        with app.test_client() as client:
            resp = client.get("/api/snapshots")
            body = resp.get_json()
            resp.close()
        self.assertEqual(len(body["sessions"]), 1)
        self.assertTrue(body["sessions"][0]["created_at"], "会话必须有 created_at（前端当日判断）")

    def test_auto_save_predicate_rejected_skips(self):
        """台账当日已保存/指纹未变 → auto 保存逐盘 skipped（skip_reason 透出；无新快照文件）。"""
        _run_completed_scan(["C:\\TD"])
        # 预置台账：指纹与本次结果一致 + date=今日 → should_auto_save 拒绝
        snapshots.save_ledger(
            {"C:\\TD": {"date": snapshots._date_str(None),
                        "last_fingerprint": snapshots._fingerprint_of_rows(
                            [{"p": "C:\\TD", "s": 100}, {"p": "C:\\TD\\a", "s": 40}]),
                        "auto_count": 1}},
            self.snap_dir,
        )
        code, body = self._auto_save()
        self.assertEqual(code, 200)
        self.assertTrue(body["skipped"], "谓词拒绝应置 skipped 标志")
        self.assertEqual(len(body["skipped_roots"]), 1)
        self.assertEqual(body["skipped_roots"][0]["root"], "C:\\TD")
        # 契约：全盘 skipped 仍生成会话清单（roots 全为 skipped 条目，无快照文件）
        sessions = session_module.list_sessions()
        self.assertEqual(len(sessions), 1, "全盘 skipped 仍生成会话清单（含 skip 条目）")
        loaded = session_module.load_session(sessions[0])
        entry = loaded["roots"]["C:\\TD"]
        self.assertTrue(entry["skipped"])
        self.assertEqual(entry["skip_reason"], "predicate_rejected")
        self.assertIsNone(entry["snapshot_path"], "skipped 条目不得有快照文件")
        self.assertEqual(len(list(self.snap_dir.glob("*.snap.gz"))), 0, "谓词拒绝不得落盘快照")

    def test_auto_save_failure_failed_list_visible(self):
        """save_snapshot 抛错 → 响应 failed 清单含错误文案（frontend toast 不吞错误）；
        全失败 → 409「本次没有生成任何快照」（错误必须可见）。"""
        _run_completed_scan(["C:\\TE"])
        with mock.patch.object(
            snapshots, "save_snapshot",
            side_effect=OSError("盘被占用模拟失败"),
        ):
            code, body = self._auto_save()
        self.assertEqual(code, 409)
        self.assertIn("本次没有生成任何快照", body["error"])
        self.assertEqual(len(session_module.list_sessions()), 0, "失败不得留下会话")

    def test_auto_save_no_result_409(self):
        """无全量结果 → 自动保存 409「暂无可保存」（前置保护）。"""
        code, body = self._auto_save()
        self.assertEqual(code, 409)
        self.assertIn("暂无可保存", body["error"])

    def test_auto_save_scanning_409(self):
        """扫描中禁止保存（既有 W2.4 语义保持）。"""
        fullscan._update_state(running=True)
        code, body = self._auto_save()
        self.assertEqual(code, 409)
        self.assertIn("扫描进行中", body["error"])


class AutoSavePartialFailureTests(unittest.TestCase):
    """D-2：逐盘成败清单——单盘失败不拖垮其他盘（P12·W2.11 语义保持）。"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.data_dir = Path(self._tmp.name) / "data"
        self.snap_dir = Path(self._tmp.name) / "snap"
        patchers = [
            mock.patch.object(session_module.datadir, "get_data_dir", return_value=self.data_dir),
            mock.patch.dict(os.environ, {"DSA_SNAPSHOT_DIR": str(self.snap_dir)}),
        ]
        for p in patchers:
            p.start()
            self.addCleanup(p.stop)
        _reset_fullscan_state()
        self.addCleanup(_reset_fullscan_state)
        self.snap_dir.mkdir(parents=True, exist_ok=True)
        self.data_dir.mkdir(parents=True, exist_ok=True)

    def test_partial_failure_reports_failed_list(self):
        """第二盘保存失败 → 第一盘已保存、failed 清单含第二盘错误、会话含第一盘。"""
        def fake_scan(root_path_obj, everything=None, cancel_event=None, progress=None):
            return {Path(root_path_obj): 100, Path(root_path_obj) / "a": 40}, \
                   {Path(root_path_obj): [("a", False, 40)]}

        with mock.patch.object(fullscan, "scan_via_everything_sdk", side_effect=fake_scan):
            fullscan.start(roots=["C:\\TF", "D:\\TG"], everything=object())
            thread = fullscan._copy_state()["thread"]
            if thread is not None:
                thread.join(timeout=5)

        real_save = snapshots.save_snapshot

        def fake_save(root, rows, *args, **kwargs):
            if str(root).startswith("D:"):
                raise OSError("第二盘失败模拟")
            return real_save(root, rows, *args, **kwargs)

        with mock.patch.object(snapshots, "save_snapshot", side_effect=fake_save):
            with app.test_client() as client:
                resp = client.post("/api/save", json={"auto": True})
                body = resp.get_json()
                resp.close()
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(len(body["saved"]), 1, "第一盘应已保存")
        self.assertEqual(len(body["failed"]), 1, "第二盘失败必须进 failed 清单")
        self.assertIn("第二盘失败模拟", body["failed"][0]["error"])
        sessions = session_module.list_sessions()
        self.assertEqual(len(sessions), 1)
        loaded = session_module.load_session(sessions[0])
        self.assertIn("C:\\TF", loaded["roots"])
        self.assertNotIn("D:\\TG", loaded["roots"])


if __name__ == "__main__":
    unittest.main()