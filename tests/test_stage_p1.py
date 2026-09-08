"""阶段 P1 新增护栏测试（问题 1 · 扫描完成自动保存与多次扫描策略）。

先写测试、后实现（TDD 护栏纪律）。本文件是 D1-1（后端归口）/D1-2（跳过可见可补救）
的**先验护栏**：
- 扫描完成 → 后端自动保存恰一次（session auto:true）；
- 自动保存尊重 config.auto_save（缺键=ON）与 DSA_NO_SNAPSHOT / is_snapshot_disabled()；
- 自动保存被谓词跳过 → skip_reason 精确透出 + save_ready 保持（手动入口可用）；
- 自动保存失败 → 不崩溃扫描线程 + save_ready 保持 + 手动「仍要保存(auto:false)」可补救；
- 后端归口天然覆盖「子页面完成仍保存」（与前端路由无关）。

隔离纪律：全部写盘类断言只在 mock 数据目录 + DSA_SNAPSHOT_DIR 重定向内执行，
**禁止**触碰真实 %LOCALAPPDATA%\\PythonDiskScanner。
"""

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import env
import fullscan
import session as session_module
import snapshots
from app import app


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
        autosave_outcome=None,
    )


def _run_completed_scan(roots=("C:\\P1A", "D:\\P1B")):
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


class P1AutosaveIsolatedBase(unittest.TestCase):
    """隔离数据目录 + 卸载注册的自动保存回调（测试间互不污染）。"""

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
        # 隔离：每个测试后注销全局自动保存回调，防止污染其他测试文件
        from app import unregister_p1_autosave
        self.addCleanup(unregister_p1_autosave)

    def _manual_auto_save(self):
        """等价于前端 POST /api/save {auto:true}（显式触发器）。"""
        with app.test_client() as client:
            resp = client.post("/api/save", json={"auto": True})
            body = resp.get_json()
            resp.close()
        return resp.status_code, body


class P1ResultCallbackContractTests(P1AutosaveIsolatedBase):
    """D1-1：全量结果就绪时后端产生一次「结果就绪回调」（自动保存归口挂点）。"""

    def test_completed_scan_fires_result_callback_once_with_result(self):
        """完成扫描（ok+roots）→ 注册回调被调用恰一次，且收到 last_result。"""
        seen = []
        cb = lambda res: seen.append(res)
        try:
            fullscan.register_result_callback(cb)
            _run_completed_scan()
        finally:
            try:
                fullscan.unregister_result_callback(cb)
            except Exception:
                pass
        self.assertEqual(len(seen), 1, "完成一次扫描 → 结果回调恰好一次")
        self.assertTrue(seen[0]["ok"])
        self.assertTrue(seen[0]["roots"])
        self.assertEqual(seen[0]["scan_version"], 1)


class P1BackendAutosaveContractTests(P1AutosaveIsolatedBase):
    """D1-1/D1-2/D1-3 后端归口自动保存护栏（RED：实现前失败）。"""

    def _register(self):
        from app import ensure_p1_autosave_registered
        ensure_p1_autosave_registered()

    def test_scan_completion_autosaves_exactly_once_auto_true(self):
        """DoD1：服务内扫描完成 → 后端自动保存恰一次，session.auto=true。"""
        self._register()
        _run_completed_scan(["C:\\P1C"])
        sessions = session_module.list_sessions()
        self.assertEqual(len(sessions), 1, "自动保存应生成恰一个 session")
        loaded = session_module.load_session(sessions[0])
        self.assertIs(loaded["auto"], True, "自动保存 session 必须 auto=true")

    def test_autosave_respects_config_auto_save_false(self):
        """DoD4：config.auto_save=false → 完成不自动保存，仅留手动入口。"""
        self._register()
        with mock.patch.object(env, "load_config", return_value={"auto_save": False}):
            _run_completed_scan(["C:\\P1D"])
        self.assertEqual(len(session_module.list_sessions()), 0, "auto_save=false 不得自动落盘")
        st = fullscan.status()
        self.assertTrue(st["result_ready"])
        self.assertTrue(st["save_ready"], "未自动保存 → save_ready 保持（手动可用）")

    def test_autosave_respects_dsa_no_snapshot(self):
        """红线：DSA_NO_SNAPSHOT / is_snapshot_disabled() 时绝不自动落盘。"""
        self._register()
        with mock.patch.dict(os.environ, {"DSA_NO_SNAPSHOT": "1"}):
            self.assertTrue(snapshots.is_snapshot_disabled(), "前置：is_snapshot_disabled 应为真")
            _run_completed_scan(["C:\\P1E"])
        self.assertEqual(len(session_module.list_sessions()), 0, "DSA_NO_SNAPSHOT 禁自动落盘")

    def test_autosave_skip_keeps_save_ready_and_precise_reason(self):
        """DoD2/D1-2：谓词跳过（当日已自动保存）→ save_ready 保持 + skip_reason 精确。"""
        self._register()
        # 预置台账：指纹与结果一致 + date=今日 → should_auto_save 拒绝
        snapshots.save_ledger(
            {"C:\\P1F": {"date": snapshots._date_str(None),
                         "last_fingerprint": snapshots._fingerprint_of_rows(
                             [{"p": "C:\\P1F", "s": 100}, {"p": "C:\\P1F\\a", "s": 40}]),
                         "auto_count": 1}},
            self.snap_dir,
        )
        _run_completed_scan(["C:\\P1F"])
        sessions = session_module.list_sessions()
        self.assertEqual(len(sessions), 1, "跳过仍生成会话清单（含 skip 条目）")
        loaded = session_module.load_session(sessions[0])
        entry = loaded["roots"]["C:\\P1F"]
        self.assertTrue(entry["skipped"])
        self.assertNotEqual(entry["skip_reason"], "predicate_rejected",
                            "跳过原因必须精确透出，不得退化为笼统 predicate_rejected")
        # 手动入口：跳过不消费 save_ready → 可「仍要保存」
        st = fullscan.status()
        self.assertTrue(st["save_ready"], "谓词跳过不得消费 save_ready（手动仍可保存）")

    def test_autosave_failure_keeps_save_ready_and_manual_remedy(self):
        """DoD5/D1-2：自动保存失败 → 不崩溃 + save_ready 保持 + 手动 auto:false 可补救。"""
        self._register()
        with mock.patch.object(
            snapshots, "save_snapshot", side_effect=OSError("写盘失败模拟")
        ):
            _run_completed_scan(["C:\\P1G"])   # 必须正常返回（回调不破坏扫描线程）
        # 自动保存失败 → 无 session；save_ready 保持
        self.assertEqual(len(session_module.list_sessions()), 0, "失败不得留下 session")
        st = fullscan.status()
        self.assertTrue(st["result_ready"])
        self.assertTrue(st["save_ready"], "自动保存失败 → 手动入口保留")
        # 「仍要保存（强制）」= auto:false 显式保存 → 应成功落盘（不改谓词，显式不受四原子限）
        with mock.patch.object(snapshots, "save_snapshot", wraps=snapshots.save_snapshot):
            _, body = self._manual_auto_save()
        # 显式(auto:false) 走成功路径，即使有 OSError 也是被 mock 移除后的真实实现
        self.assertEqual(len(body.get("saved", [])), 1, "手动 auto:false 应至少保存一盘")
        self.assertEqual(len(session_module.list_sessions()), 1, "手动保存后应有一个 session")

    def test_rest_save_auto_false_forces_save(self):
        """D1-2「仍要保存（强制）」= 显式 auto:false 不受四原子谓词限制（放行）。"""
        _run_completed_scan(["C:\\P1H"])
        # 预置台账诱导应被谓词跳过的指纹（当日已保存）
        snapshots.save_ledger(
            {"C:\\P1H": {"date": snapshots._date_str(None),
                         "last_fingerprint": snapshots._fingerprint_of_rows(
                             [{"p": "C:\\P1H", "s": 100}, {"p": "C:\\P1H\\a", "s": 40}]),
                         "auto_count": 1}},
            self.snap_dir,
        )
        with app.test_client() as client:
            resp = client.post("/api/save", json={"auto": False})
            body = resp.get_json()
            resp.close()
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(body.get("saved"), "显式 auto:false 应强制落盘（四原子仅约束自动）")
        self.assertGreaterEqual(len(list(self.snap_dir.glob("*.snap.gz"))), 1)


class P1WebScanPathAutosaveTests(P1AutosaveIsolatedBase):
    """红线回归护栏（2026-09-09 事件）：自动保存只随**真实 Web 扫描路径**启用，
    绝不在 run_server 全局注册（否则直接调 fullscan.start() 的测试会把快照写进
    未隔离的真实数据目录）。本类验证：
    - D1-1 在注册点迁移后仍成立：经 POST /api/fullscan/start 发起的扫描完成后自动保存；
    - run_server 触发后**不**设置全局注册标志（杜绝 test_shutdown 泄漏污染）。"""

    def test_web_fullscan_start_autosaves_on_completion(self):
        """真实 Web 路径：POST /api/fullscan/start → 后台完成 → 后端自动保存（D1-1 保持）。"""
        def fake_scan(root_path_obj, everything=None, cancel_event=None, progress=None):
            sizes = {Path(root_path_obj): 100, Path(root_path_obj) / "a": 40}
            contents = {Path(root_path_obj): [("a", False, 40)]}
            if progress:
                progress(2, 2)
            return sizes, contents

        with mock.patch.object(fullscan, "_enumerate_roots", return_value=["C:\\P1W"]), \
                mock.patch.object(fullscan, "scan_via_everything_sdk", side_effect=fake_scan):
            with app.test_client() as client:
                resp = client.post("/api/fullscan/start", json={})
                body = resp.get_json()
                resp.close()
            self.assertEqual(resp.status_code, 200)
            # 等后台线程跑完（api_fullscan_start 内部已 ensure 注册自动保存回调）
            thread = fullscan._copy_state()["thread"]
            if thread is not None:
                thread.join(timeout=5)
        st = fullscan.status()
        self.assertTrue(st["result_ready"])
        self.assertFalse(st["save_ready"], "Web 路径自动保存后 save_ready 应消费")
        outcome = st["autosave_outcome"]
        self.assertIsNotNone(outcome, "Web 路径自动保存应记录 outcome")
        self.assertEqual(outcome["outcome"], "saved")
        self.assertEqual(len(session_module.list_sessions()), 1, "Web 路径自动保存生成恰一个 session")

    def test_run_server_does_not_globally_register_autosave(self):
        """红线根因：run_server 触发后**不得**设置全局注册标志（防止不隔离扫描被自动保存）。"""
        import app as app_module
        with mock.patch.object(app_module.urllib.request, "urlopen",
                               side_effect=OSError("refused")), \
                mock.patch.object(app_module.webbrowser, "open"), \
                mock.patch.object(app_module.app, "run"):
            app_module.run_server(port=5998, open_browser=False)
        self.assertFalse(app_module._p1_autosave_registered,
                         "run_server 不得全局注册自动保存（红线：不隔离扫描不得被写盘）")
        # 收尾清理：即便未来回归也不留污染
        app_module.unregister_p1_autosave()


class P1AutosaveStatusAdditiveTests(P1AutosaveIsolatedBase):
    """/api/fullscan/status additive：不破坏既有键集合，可新增 auto_save 结果域。"""

    def test_status_keeps_existing_contract_keys(self):
        _run_completed_scan(["C:\\P1I"])
        st = fullscan.status()
        for key in ("running", "roots", "roots_done", "roots_total",
                    "current_root", "error", "result_ready", "save_ready",
                    "progress_pct", "scan_version", "stop_requested",
                    "stop_reason", "phase", "lock_holder", "lock_since",
                    "row_done", "row_total", "stop_ack_at"):
            self.assertIn(key, st, "status 既有契约键不得丢失: " + key)


if __name__ == "__main__":
    unittest.main()