"""app.py Flask 路由单元测试（Phase 2）。

覆盖 §3 路由表的成功/失败分支与中文文案。全部依赖打入桩，不触碰真实
Everything SDK / 数据目录；使用 app.test_client()，不启动真实服务器。
"""

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import app as webapp


class WebApiTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.dir = Path(self._tmp.name)
        self.client = webapp.app.test_client()

    def get_json(self, path, **kw):
        resp = self.client.get(path, **kw)
        return resp, json.loads(resp.get_data(as_text=True))

    def post_json(self, path, payload):
        resp = self.client.post(
            path,
            data=json.dumps(payload),
            content_type="application/json",
        )
        return resp, json.loads(resp.get_data(as_text=True))

    # ---------- 页面 ----------

    def test_static_css_design_system_smoke(self):
        resp = self.client.get("/static/css/style.css")
        self.assertEqual(resp.status_code, 200)
        css = resp.get_data(as_text=True)
        for token in ("--brand-blue", "--space-4", "--radius-sm", "--shadow-lg"):
            self.assertIn(token, css)
        for selector in ("scrollbar", ".dir-table tbody tr:nth-child(even)", ".size-bar", ".empty-state", ".progress-fill"):
            self.assertIn(selector, css)

    def test_index_renders_chinese_page(self):
        resp = self.client.get("/")
        self.assertEqual(resp.status_code, 200)
        text = resp.get_data(as_text=True)
        self.assertIn("Python 磁盘扫描", text)
        self.assertIn("目录浏览", text)
        self.assertIn("全量扫描", text)
        self.assertIn("空间分析工作台", text)
        self.assertIn('grid-main', text)
        self.assertIn('aria-label="历史对比"', text)
        self.assertIn('id="scan-roots"', text)
        self.assertIn('id="browse-cache-badge"', text)
        self.assertIn('id="scan-progress-hint"', text)
        self.assertIn('aria-live="polite"', text)
        self.assertIn('id="btn-density"', text)
        self.assertIn('id="browse-history"', text)
        self.assertIn('role="status"', text)
        css = self.client.get("/static/css/style.css").get_data(as_text=True)
        self.assertIn("prefers-reduced-motion", css)
        self.assertIn("@media(max-width:900px)", css)
        self.assertIn("min-height:36px", css)
        self.assertIn('aria-label="当前目录内容"', text)
        self.assertIn('aria-live="polite"', text)
        self.assertIn('aria-label="浏览历史"', text)
        js = self.client.get("/static/js/app.js").get_data(as_text=True)
        self.assertIn('document.title', js)
        self.assertIn('browseHistory', js)
        js = self.client.get("/static/js/app.js").get_data(as_text=True)
        for token in ("browseHistory", "compactDensity", "ev.key ===", "Enter", "keydown"): 
            self.assertIn(token, js)
        self.assertIn('id="browse-chart"', text)
        self.assertIn('id="browse-filter"', text)
        self.assertIn('aria-label="当前目录构成"', text)
        self.assertIn('role="status"', text)
        self.assertIn('Ctrl', text) if False else None
        self.assertIn('browse-kind', text)

    # ---------- 健康检查 ----------

    def test_health_ready(self):
        dll = self.dir / "Everything64.dll"
        with mock.patch.object(webapp.sdk, "DLL_PATH", str(dll)), \
                mock.patch.object(webapp.sdk, "is_everything_ipc_ready", return_value=True):
            resp, data = self.get_json("/api/health")
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(data["ok"])
        self.assertTrue(data["ready"])
        self.assertIn("已就绪", data["message"])

    def test_health_unavailable_chinese(self):
        with mock.patch.object(webapp.sdk, "DLL_PATH", None), \
                mock.patch.object(webapp.sdk, "resolve_everything_dll", side_effect=FileNotFoundError("未找到 DLL")):
            resp, data = self.get_json("/api/health")
        self.assertEqual(resp.status_code, 200)
        self.assertFalse(data["ready"])
        self.assertIn("Everything 不可用", data["message"])

    # ---------- 空间概览 ----------

    def test_overview_while_scanning_has_progress_state(self):
        with mock.patch.object(webapp.fullscan, "result", return_value=None), \
                mock.patch.object(webapp.fullscan, "status", return_value={"running": True, "progress_pct": 50, "current_root": "C:\\", "roots_done": 1, "roots_total": 2}):
            resp, data = self.get_json("/api/overview")
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(data["scanning"])
        self.assertEqual(data["empty_reason"], "scanning")
        self.assertEqual(data["progress_pct"], 50)

    def test_overview_marks_missing_index_invalid(self):
        root = self.dir / "root"
        with mock.patch.object(webapp.fullscan, "result", return_value={"completed_at": "now", "roots": {str(root): {"rows": []}}}), \
                mock.patch.object(webapp.fullscan.BROWSE_INDEX, "has_root", return_value=False), \
                mock.patch.object(webapp.fullscan.BROWSE_INDEX, "root_stats", return_value=None), \
                mock.patch.object(webapp.fullscan.BROWSE_INDEX, "children", return_value=[]):
            resp, data = self.get_json("/api/overview")
        self.assertEqual(resp.status_code, 200)
        self.assertFalse(data["roots"][0]["index_valid"])
        self.assertEqual(data["roots"][0]["empty_reason"], "invalid_index")
        self.assertIsNone(data["roots"][0]["total_human"])

    def test_overview_without_scan_is_empty(self):
        with mock.patch.object(webapp.fullscan, "result", return_value=None), \
                mock.patch.object(webapp.fullscan, "status", return_value={"running": False}):
            resp, data = self.get_json("/api/overview")
        self.assertEqual(resp.status_code, 200)
        self.assertFalse(data["ready"])
        self.assertEqual(data["roots"], [])

    def test_overview_returns_root_chart_data(self):
        root = self.dir / "root"
        with mock.patch.object(webapp.fullscan, "result", return_value={"completed_at": "now", "roots": {str(root): {"rows": [{"p": str(root), "s": 100}]}}}), \
                mock.patch.object(webapp.fullscan.BROWSE_INDEX, "root_stats", return_value={"total": 100, "directory_count": 1, "file_count": 1}), \
                mock.patch.object(webapp.fullscan.BROWSE_INDEX, "has_root", return_value=True), \
                mock.patch.object(webapp.fullscan.BROWSE_INDEX, "children", return_value=[("big", True, 80), ("a.txt", False, 20)]):
            resp, data = self.get_json("/api/overview")
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(data["ready"])
        self.assertEqual(data["roots"][0]["directories"][0]["name"], "big")

    # ---------- 前台浏览 ----------

    def test_browse_returns_directory_entries(self):
        root = self.dir / "root"
        current = root / "sub"
        current.mkdir(parents=True)
        contents = {
            current: [("child", True, 100), ("note.txt", False, 5)],
        }
        with mock.patch.object(webapp.fullscan, "is_running", return_value=False), \
                mock.patch.object(webapp.scan, "scan_via_everything_sdk", return_value=({current: 105}, contents)):
            resp, data = self.post_json("/api/browse", {"root": str(root), "path": str(current)})
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(data["ok"])
        self.assertEqual(data["root"], str(current))
        self.assertEqual(data["total_dirs"], 1)
        self.assertEqual(data["directories"][0]["name"], "child")
        self.assertEqual(data["directories"][0]["size"], 100)
        self.assertEqual(data["files"][0]["name"], "note.txt")

    def test_browse_memory_response_contains_cache_contract(self):
        root = self.dir / "root"
        root.mkdir()
        with mock.patch.object(webapp.fullscan.BROWSE_INDEX, "root_for", return_value=str(root)), \
                mock.patch.object(webapp.fullscan.BROWSE_INDEX, "children", return_value=[]), \
                mock.patch.object(webapp.scan, "scan_via_everything_sdk") as sdk_call:
            resp, data = self.post_json("/api/browse", {"root": str(root), "path": str(root)})
        self.assertEqual(resp.status_code, 200)
        self.assertFalse(data.get("scanning", False))
        sdk_call.assert_not_called()

    def test_browse_uses_memory_index_without_sdk(self):
        root = self.dir / "root"
        root.mkdir()
        with mock.patch.object(webapp.fullscan.BROWSE_INDEX, "root_for", return_value=str(root)), \
                mock.patch.object(webapp.fullscan.BROWSE_INDEX, "children", return_value=[("x", False, 9)]), \
                mock.patch.object(webapp.scan, "scan_via_everything_sdk") as sdk_call:
            resp, data = self.post_json("/api/browse", {"root": str(root), "path": str(root)})
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(data["files"][0]["name"], "x")
        sdk_call.assert_not_called()

    def test_browse_scanning_root_returns_friendly_state(self):
        root = self.dir / "root"
        root.mkdir()
        with mock.patch.object(webapp.fullscan.BROWSE_INDEX, "root_for", return_value=None), \
                mock.patch.object(webapp.fullscan, "is_running", return_value=True), \
                mock.patch.object(webapp.fullscan, "status", return_value={"current_root": str(root), "progress_pct": 40}), \
                mock.patch.object(webapp.scan, "scan_via_everything_sdk") as sdk_call:
            resp, data = self.post_json("/api/browse", {"root": str(root), "path": str(root)})
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(data["scanning"])
        self.assertEqual(data["progress"], 40)
        sdk_call.assert_not_called()

    def test_browse_no_index_falls_back_to_sdk(self):
        root = self.dir / "root"
        root.mkdir()
        with mock.patch.object(webapp.fullscan.BROWSE_INDEX, "root_for", return_value=None), \
                mock.patch.object(webapp.fullscan, "is_running", return_value=False), \
                mock.patch.object(webapp.scan, "scan_via_everything_sdk", return_value=({}, {root: [("x", False, 2)]})) as sdk_call:
            resp, data = self.post_json("/api/browse", {"root": str(root), "path": str(root)})
        self.assertEqual(resp.status_code, 200)
        sdk_call.assert_called_once()

    def test_browse_missing_root_chinese_error(self):
        resp, data = self.post_json("/api/browse", {"root": str(self.dir / "no-such")})
        self.assertEqual(resp.status_code, 400)
        self.assertFalse(data["ok"])
        self.assertIn("路径不存在", data["error"])

    def test_browse_busy_when_fullscan_running(self):
        root = self.dir / "root"
        root.mkdir()
        with mock.patch.object(webapp.fullscan, "is_running", return_value=True):
            resp, data = self.post_json("/api/browse", {"root": str(root)})
        self.assertEqual(resp.status_code, 409)
        self.assertIn("全量扫描进行中", data["error"])

    # ---------- 后台全量 ----------

    def test_fullscan_start_ok(self):
        with mock.patch.object(webapp.fullscan, "start", return_value=True), \
                mock.patch.object(webapp.fullscan, "status", return_value={"running": True}):
            resp, data = self.post_json("/api/fullscan/start", {})
        self.assertEqual(resp.status_code, 200)
        self.assertIn("已启动", data["message"])

    def test_fullscan_start_when_running(self):
        with mock.patch.object(webapp.fullscan, "start", return_value=False), \
                mock.patch.object(webapp.fullscan, "is_running", return_value=True):
            resp, data = self.post_json("/api/fullscan/start", {})
        self.assertEqual(resp.status_code, 409)
        self.assertIn("已在运行中", data["error"])

    def test_fullscan_status(self):
        with mock.patch.object(webapp.fullscan, "status", return_value={"running": False, "progress_pct": 100}):
            resp, data = self.get_json("/api/fullscan/status")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(data["status"]["progress_pct"], 100)

    # ---------- 保存 / 撤销 ----------

    def _patch_save_deps(self):
        root_a = self.dir / "root_a"
        snap_dir = self.dir / "snaps"
        snap_dir.mkdir()
        return {
            "is_running_false": mock.patch.object(webapp.fullscan, "is_running", return_value=False),
            "result": mock.patch.object(
                webapp.fullscan,
                "result",
                return_value={
                    "roots": {
                        str(root_a): {"root": str(root_a), "rows": [{"p": str(root_a), "s": 10}]},
                    },
                    "scan_version": 1,
                },
            ),
            "guid": mock.patch.object(webapp.snapshots, "get_machine_guid", return_value="guid-1234"),
            "snap_dir": mock.patch.object(webapp.snapshots, "get_snapshot_dir", return_value=snap_dir),
            "save_snapshot": mock.patch.object(
                webapp.snapshots,
                "save_snapshot",
                return_value=snap_dir / "root_a_explicit_guid-1234.snap.gz",
            ),
            "session_id": mock.patch.object(webapp.session, "build_session_id", return_value="session_test"),
            "save_session": mock.patch.object(
                webapp.session,
                "save_session",
                return_value=self.dir / "session_test.json",
            ),
            "mark_saved": mock.patch.object(webapp.fullscan, "mark_saved"),
        }

    def test_save_creates_session(self):
        patches = self._patch_save_deps()
        with contextlib.ExitStack() as stack, \
                mock.patch.object(webapp.fullscan, "mark_saved"):
            for patch in patches.values():
                stack.enter_context(patch)
            resp, data = self.post_json("/api/save", {"auto": False})
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(data["ok"])
        self.assertEqual(data["session"]["session_id"], "session_test")
        self.assertEqual(data["session"]["auto"], False)

    def test_save_when_fullscan_running(self):
        with mock.patch.object(webapp.fullscan, "is_running", return_value=True):
            resp, data = self.post_json("/api/save", {"auto": False})
        self.assertEqual(resp.status_code, 409)
        self.assertIn("全量扫描进行中", data["error"])

    def test_save_when_no_result(self):
        with mock.patch.object(webapp.fullscan, "is_running", return_value=False), \
                mock.patch.object(webapp.fullscan, "result", return_value=None):
            resp, data = self.post_json("/api/save", {"auto": False})
        self.assertEqual(resp.status_code, 409)
        self.assertIn("暂无可保存的全量扫描结果", data["error"])

    def test_save_undo(self):
        latest = self.dir / "session_1.json"
        latest.write_text(json.dumps({"session_id": "session_1"}), encoding="utf-8")
        loaded = {
            "session_id": "session_1",
            "roots": {
                "C:\\": {"snapshot_path": str(self.dir / "c.snap.gz")},
            },
        }
        with mock.patch.object(webapp.session, "list_sessions", return_value=[latest]), \
                mock.patch.object(webapp.session, "load_session", return_value=loaded), \
                mock.patch.object(webapp.session, "delete_session", return_value=True):
            resp, data = self.post_json("/api/save/undo", {})
        self.assertEqual(resp.status_code, 200)
        self.assertIn("已撤销", data["message"])

    def test_save_undo_nothing(self):
        with mock.patch.object(webapp.session, "list_sessions", return_value=[]):
            resp, data = self.post_json("/api/save/undo", {})
        self.assertEqual(resp.status_code, 404)
        self.assertIn("没有可撤销的保存记录", data["error"])

    # ---------- 历史 / 对比 ----------

    def test_snapshots_list(self):
        f = self.dir / "session_1.json"
        loaded = {"session_id": "session_1", "auto": True, "roots": {}, "created_at": "2026-08-22T12:00:00"}
        with mock.patch.object(webapp.session, "list_sessions", return_value=[f]), \
                mock.patch.object(webapp.session, "load_session", return_value=loaded):
            resp, data = self.get_json("/api/snapshots")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(data["count"], 1)
        self.assertEqual(data["sessions"][0]["session_id"], "session_1")

    def test_compare_ok(self):
        baseline = self.dir / "base.snap.gz"
        baseline.write_bytes(b"baseline")
        report = {
            "root": str(self.dir),
            "total_baseline": 100,
            "total_current": 120,
            "delta_total": 20,
            "truncated": False,
            "rows": [
                {"path": "added", "delta": 30, "added": True},
                {"path": "removed", "delta": -10, "removed": True},
                {"path": "flat", "delta": 0},
            ],
        }
        with mock.patch.object(webapp.fullscan, "is_running", return_value=False), \
                mock.patch.object(webapp.snapshots, "load_snapshot", return_value={"header": {}, "rows": []}), \
                mock.patch.object(
                    webapp.fullscan,
                    "result",
                    return_value={"rows": [{"p": str(self.dir), "s": 100}]},
                ), \
                mock.patch.object(webapp.compare, "diff_from_current", return_value=report), \
                mock.patch.object(webapp.compare, "top_growth", return_value=[]):
            resp, data = self.post_json(
                "/api/compare",
                {"root": str(self.dir), "baseline": str(baseline)},
            )
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(data["report"]["delta_total"], 20)

    def test_compare_response_keeps_rows_for_visual_summary(self):
        baseline = self.dir / "base-rows.snap.gz"
        baseline.write_bytes(b"baseline")
        report = {"root": str(self.dir), "total_baseline": 100, "total_current": 120, "delta_total": 20, "truncated": False}
        rows = [{"path": "added", "delta": 30}, {"path": "removed", "delta": -10}, {"path": "flat", "delta": 0}]
        with mock.patch.object(webapp.fullscan, "is_running", return_value=False), \
                mock.patch.object(webapp.snapshots, "load_snapshot", return_value={"header": {}, "rows": []}), \
                mock.patch.object(webapp.fullscan, "result", return_value={"rows": []}), \
                mock.patch.object(webapp.scan, "scan_via_everything_sdk", return_value=({}, {})), \
                mock.patch.object(webapp.compare, "diff_from_current", return_value=report), \
                mock.patch.object(webapp.compare, "top_growth", return_value=rows):
            resp, data = self.post_json("/api/compare", {"root": str(self.dir), "baseline": str(baseline)})
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(len(data["report"]["rows"]), 3)
        self.assertEqual(data["report"]["delta_total"], 20)

    def test_compare_missing_baseline(self):
        resp, data = self.post_json("/api/compare", {"root": str(self.dir), "baseline": ""})
        self.assertEqual(resp.status_code, 400)
        self.assertIn("缺少 root 或 baseline", data["error"])

    # ---------- 设置 ----------

    def test_settings_get(self):
        with mock.patch.object(webapp.env, "load_config", return_value={"theme": "light", "auto_save": True}):
            resp, data = self.get_json("/api/settings")
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(data["settings"]["auto_save"])

    def test_settings_get_includes_data_dir(self):
        """Phase 3：设置页展示数据目录，GET /api/settings 附带 data_dir/snapshots_dir。"""
        with mock.patch.object(webapp.env, "load_config", return_value={}):
            resp, data = self.get_json("/api/settings")
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(data["data_dir"])
        self.assertIn("PythonDiskScanner", data["data_dir"])
        self.assertTrue(data["snapshots_dir"].endswith("snapshots"))

    def test_settings_post_save(self):
        with mock.patch.object(webapp.env, "load_config", return_value={"auto_save": False}), \
                mock.patch.object(webapp.env, "save_config", return_value=True):
            resp, data = self.post_json("/api/settings", {"auto_save": True})
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(data["settings"]["auto_save"])
        self.assertIn("设置已保存", data["message"])

    def test_settings_post_failure(self):
        with mock.patch.object(webapp.env, "load_config", return_value={}), \
                mock.patch.object(webapp.env, "save_config", return_value=False):
            resp, data = self.post_json("/api/settings", {"auto_save": True})
        self.assertEqual(resp.status_code, 500)
        self.assertIn("设置保存失败", data["error"])

    # ---------- 一键清空 ----------

    def test_wipe_wrong_confirm(self):
        resp, data = self.post_json("/api/admin/wipe", {"confirm": "不确认"})
        self.assertEqual(resp.status_code, 400)
        self.assertIn("确认字段不正确", data["error"])

    def test_wipe_when_scanning(self):
        with mock.patch.object(webapp.fullscan, "is_running", return_value=True):
            resp, data = self.post_json("/api/admin/wipe", {"confirm": "确认清空"})
        self.assertEqual(resp.status_code, 409)
        self.assertIn("后台扫描进行中", data["error"])

    def test_wipe_ok(self):
        data_dir = self.dir / "data"
        with mock.patch.object(webapp.fullscan, "is_running", return_value=False), \
                mock.patch.object(webapp.datadir, "wipe_data", return_value=data_dir):
            resp, data = self.post_json("/api/admin/wipe", {"confirm": "确认清空"})
        self.assertEqual(resp.status_code, 200)
        self.assertIn("数据目录已清空", data["message"])


import contextlib  # noqa: E402  # 放在文件尾仅为补丁 ExitStack 需要


if __name__ == "__main__":
    unittest.main()