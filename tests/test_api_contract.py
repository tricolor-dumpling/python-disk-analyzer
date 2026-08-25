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
import env
import fullscan
import messages
import scan
import snapshots
import sdk
import app as app_module
from app import app
from exceptions import EverythingQueryError


def _write_probe_file(tmpdir):
    """在临时目录写一个真实存在的文件，返回其路径字符串。"""
    probe = Path(tmpdir) / "probe.txt"
    probe.write_text("x", encoding="utf-8")
    return str(probe)


GUID = "deadbeef-1234-5678-9abc-def012345678"
# W2.13 起 /api/compare 默认强校验：契约夹具一律使用本机 guid（异机见 test_machine.py）
LOCAL_GUID = snapshots.get_machine_guid()


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
                _keys(body), {"ok", "ready", "dll", "message", "busy"},  # W2.1 additive
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

    def test_browse_file_path_returns_not_a_directory(self):
        """P12·W2.5（E）：root 指向文件路径 → 400「不是一个目录」。"""
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        probe = _write_probe_file(tmp.name)
        with app.test_client() as client:
            resp = client.post("/api/browse", json={"root": probe})
            self.assertEqual(resp.status_code, 400)
            self.assertIn("不是一个目录", resp.get_json()["error"])
            resp.close()

    def test_404_returns_json(self):
        """P12·W3.3：未知接口 → 404 + JSON（旧形态 {ok,error}），非 HTML。"""
        with app.test_client() as client:
            resp = client.get("/api/no-such")
            self.assertEqual(resp.status_code, 404)
            self.assertIn("json", resp.headers["Content-Type"])
            body = resp.get_json()
            self.assertIs(body["ok"], False)
            self.assertTrue(body["error"])
            resp.close()

    def test_wipe_double_confirmation(self):
        """P12·W3.5 回归：错确认 400、正确确认 200 且重建空 snapshots/exports。"""
        import datadir

        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        data_root = Path(tmp.name) / "PythonDiskScanner"
        with app.test_client() as client:
            # 错误确认 → 400 JSON
            resp = client.post("/api/admin/wipe", json={"confirm": "错误的确认"})
            self.assertEqual(resp.status_code, 400)
            self.assertIs(resp.get_json()["ok"], False)
            resp.close()

            # 正确确认 → 200，且数据目录重建空结构
            with mock.patch.object(datadir, "get_data_dir", return_value=data_root):
                resp = client.post("/api/admin/wipe", json={"confirm": "确认清空"})
            self.assertEqual(resp.status_code, 200)
            self.assertIs(resp.get_json()["ok"], True)
            resp.close()
            self.assertTrue((data_root / "snapshots").is_dir())
            self.assertTrue((data_root / "exports").is_dir())

    def test_405_returns_json(self):
        """P12·W3.3：方法不允许 → 405 + JSON。"""
        with app.test_client() as client:
            resp = client.delete("/api/health")
            self.assertEqual(resp.status_code, 405)
            self.assertIn("json", resp.headers["Content-Type"])
            body = resp.get_json()
            self.assertIs(body["ok"], False)
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

    def test_settings_post_whitelist_matrix(self):
        """P12·W2.6（K4）/W2.9（SEC-1）：白名单矩阵——everything_*/未知键 400，
        合法键 200 且落盘无脏键；last_roots 超 5 截断。"""
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        config_path = Path(tmp.name) / "config.json"
        with app.test_client() as client:
            # everything_* 投毒链：固定文案 400，且不落盘
            for key in ("everything_exe", "everything_dll", "everything_startup_args"):
                resp = client.post(f"/api/settings", json={key: "C:\\evil.exe"})
                self.assertEqual(resp.status_code, 400, f"{key} 必须 400")
                body = resp.get_json()
                self.assertIn("安全限制", body["error"])
                self.assertIn("everything_", body["error"])
                resp.close()
            self.assertFalse(config_path.exists(), "被拒写入不得落盘")

            # 未知键 → 400
            resp = client.post("/api/settings", json={"hacker_key": "x"})
            self.assertEqual(resp.status_code, 400)
            self.assertIn("不允许写入设置项", resp.get_json()["error"])
            resp.close()

            # 合法键：200；last_roots 6 项截断为 5
            six_roots = ["C:\\", "D:\\", "E:\\", "F:\\", "G:\\", "H:\\"]
            with mock.patch.object(env, "_default_config_path", return_value=config_path):
                resp = client.post("/api/settings", json={"auto_save": True, "last_roots": six_roots})
            self.assertEqual(resp.status_code, 200)
            saved = resp.get_json()["settings"]
            self.assertIs(saved["auto_save"], True)
            self.assertEqual(len(saved["last_roots"]), 5, "last_roots 必须截断为 5")
            resp.close()

            # 落盘内容无脏键（config.json 只含白名单键）
            import json as _json
            on_disk = _json.loads(config_path.read_text(encoding="utf-8"))
            self.assertNotIn("hacker_key", on_disk)
            for forbidden in ("everything_exe", "everything_dll"):
                self.assertNotIn(forbidden, on_disk)

    def test_settings_post_rejects_bad_types(self):
        """P12·W2.6（K4）：类型不符（auto_save 非布尔 / theme 非枚举）→ 400。"""
        with app.test_client() as client:
            resp = client.post("/api/settings", json={"auto_save": "yes"})
            self.assertEqual(resp.status_code, 400)
            resp.close()
            resp = client.post("/api/settings", json={"theme": "solarized"})
            self.assertEqual(resp.status_code, 400)
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

    def test_query_error_typed_response(self):
        """P12·W1.3：SDK 抛 EverythingQueryError(2) → POST /api/browse 502 且
        body={ok:false,error:中文文案,code:2}（无裸错误码）。"""
        calls = {}

        def fake_scan(root_path_obj, cancel_event=None, everything=None):
            calls["root"] = str(root_path_obj)
            raise EverythingQueryError(2)

        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        with app.test_client() as client:
            with mock.patch.object(fullscan.BROWSE_INDEX, "root_for", return_value=None), \
                    mock.patch.object(fullscan, "is_running", return_value=False), \
                    mock.patch.object(scan, "scan_via_everything_sdk", side_effect=fake_scan), \
                    mock.patch.object(env, "list_everything_process_sessions", return_value=[]), \
                    mock.patch.object(env, "get_current_session_id", return_value=1):
                resp = client.post(
                    "/api/browse",
                    json={"root": tmp.name, "path": tmp.name},
                )
            self.assertEqual(resp.status_code, 502)
            body = resp.get_json()
            self.assertIs(body["ok"], False)
            self.assertEqual(body["code"], 2)
            self.assertIn(messages.render_everything_error(2), body["error"])
            self.assertNotIn("service_only", body, "会话列表为空时不得误报 service_only")
            resp.close()

    def test_service_only_flag(self):
        """P12·W1.3：Everything 全在 Session 0、当前会话为 1 → service_only=True
        且文案含「管理员」对齐提示。"""
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        with app.test_client() as client:
            with mock.patch.object(fullscan.BROWSE_INDEX, "root_for", return_value=None), \
                    mock.patch.object(fullscan, "is_running", return_value=False), \
                    mock.patch.object(
                        scan, "scan_via_everything_sdk",
                        side_effect=EverythingQueryError(2),
                    ), \
                    mock.patch.object(env, "list_everything_process_sessions",
                                      return_value=[0]), \
                    mock.patch.object(env, "get_current_session_id", return_value=1):
                resp = client.post("/api/browse", json={"root": tmp.name, "path": tmp.name})
            self.assertEqual(resp.status_code, 502)
            body = resp.get_json()
            self.assertIs(body["service_only"], True)
            self.assertIn("管理员", body["error"])
            resp.close()

    def test_health_degraded_dll_not_installed_config(self):
        """P12·W1.3：health 三种 degraded 分支（dll / not_installed / config），
        均含 message 且 ready=False。"""
        corrupt_tmp = tempfile.TemporaryDirectory()
        self.addCleanup(corrupt_tmp.cleanup)
        corrupt_config = Path(corrupt_tmp.name) / "config.json"
        corrupt_config.write_text("{broken json", encoding="utf-8")
        fake_dll = "C:\\fake\\Everything64.dll"

        # 病因② DLL 解析失败
        with app.test_client() as client:
            with mock.patch.object(sdk, "DLL_PATH", None), \
                    mock.patch.object(sdk, "resolve_everything_dll",
                                      side_effect=FileNotFoundError("未找到 DLL")):
                resp = client.get("/api/health")
            body = resp.get_json()
            self.assertEqual(body["degraded"], "dll")
            self.assertIs(body["ready"], False)
            self.assertTrue(body["message"])
            resp.close()

        # 病因③ 未安装（找不到 Everything.exe）
        with app.test_client() as client:
            with mock.patch.object(sdk, "DLL_PATH", fake_dll), \
                    mock.patch.object(sdk, "is_everything_ipc_ready", return_value=False), \
                    mock.patch.object(env, "find_everything_exe", return_value=None):
                resp = client.get("/api/health")
            body = resp.get_json()
            self.assertEqual(body["degraded"], "not_installed")
            self.assertIs(body["ready"], False)
            self.assertIn("安装", body["message"])
            resp.close()

        # 病因① config.json 损坏（config_health 经 _default_config_path 注入）
        with app.test_client() as client:
            with mock.patch.object(sdk, "DLL_PATH", fake_dll), \
                    mock.patch.object(sdk, "is_everything_ipc_ready", return_value=False), \
                    mock.patch.object(env, "find_everything_exe", return_value=Path("C:\\e\\Everything.exe")), \
                    mock.patch.object(env, "_default_config_path", return_value=corrupt_config):
                resp = client.get("/api/health")
            body = resp.get_json()
            self.assertEqual(body["degraded"], "config")
            self.assertIs(body["ready"], False)
            self.assertIn("配置文件损坏", body["message"])
            resp.close()

    def test_health_ready_shape_unchanged(self):
        """P12·W1.3 additive：就绪分支键集合保持 {ok,ready,dll,message} 不变。"""
        with app.test_client() as client:
            with mock.patch.object(sdk, "DLL_PATH", "C:\\fake\\Everything64.dll"), \
                    mock.patch.object(sdk, "is_everything_ipc_ready", return_value=True):
                resp = client.get("/api/health")
            body = resp.get_json()
            self.assertEqual(_keys(body), {"ok", "ready", "dll", "message", "busy"})  # W2.1 additive
            resp.close()

    def test_legacy_error_shape_still_ok(self):
        """RT-N04 并存锚点：未迁移动作（缺参 400）仍为 {ok,error} 两键。"""
        with app.test_client() as client:
            resp = client.post("/api/browse", json={"path": "X:\\y"})  # 缺 root
            self.assertEqual(resp.status_code, 400)
            body = resp.get_json()
            self.assertEqual(_keys(body), {"ok", "error"}, "旧形态必须原样保留")
            resp.close()

    def test_open_path_happy_and_errors(self):
        """P12·W1.4：合法 tmp 路径（mock Popen）→ 200 launched:true；
        相对路径/控制字符/不存在 → 400 且 error 为中文。"""
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        probe = _write_probe_file(tmp.name)

        with app.test_client() as client:
            with mock.patch.object(app_module, "subprocess") as fake_sp:
                fake_sp.Popen.return_value = mock.Mock()
                resp = client.post("/api/open-path", json={"path": probe})
            self.assertEqual(resp.status_code, 200)
            body = resp.get_json()
            self.assertIs(body["ok"], True)
            self.assertIs(body["launched"], True)
            self.assertIn("资源管理器", body["message"])
            resp.close()

            # 相对路径 → 400
            resp = client.post("/api/open-path", json={"path": "relative\\path.txt"})
            self.assertEqual(resp.status_code, 400)
            self.assertIn("绝对路径", resp.get_json()["error"])
            resp.close()

            # 控制字符 → 400
            resp = client.post("/api/open-path", json={"path": probe + "\x01"})
            self.assertEqual(resp.status_code, 400)
            self.assertIn("控制字符", resp.get_json()["error"])
            resp.close()

            # 不存在且不在索引 → 400
            missing = str(Path(tmp.name) / "no_such_dir" / "x.txt")
            resp = client.post("/api/open-path", json={"path": missing})
            self.assertEqual(resp.status_code, 400)
            self.assertIn("不存在", resp.get_json()["error"])
            resp.close()

    def test_open_path_rejects_non_string(self):
        """P12·W1.4：path=123 / null → 400。"""
        with app.test_client() as client:
            for bad in (123, None):
                resp = client.post("/api/open-path", json={"path": bad})
                self.assertEqual(resp.status_code, 400, f"path={bad!r} 应 400")
                self.assertIs(resp.get_json()["ok"], False)
                resp.close()

    def test_open_path_spawn_failure_degrades(self):
        """P12·W1.4：Popen 抛 OSError → 200 launched:false（前端降级复制）。"""
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        probe = _write_probe_file(tmp.name)
        with app.test_client() as client:
            with mock.patch.object(app_module, "subprocess") as fake_sp:
                fake_sp.Popen.side_effect = OSError("spawn denied")
                resp = client.post("/api/open-path", json={"path": probe})
            self.assertEqual(resp.status_code, 200)
            body = resp.get_json()
            self.assertIs(body["launched"], False)
            self.assertIn("复制", body["message"])
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
            machine_guid=LOCAL_GUID,
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
                 "truncated", "legacy_count", "baseline_created_at",
                 "current_completed_at", "rows"},  # W2.11 additive
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
