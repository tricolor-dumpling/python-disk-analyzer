"""test_refresh — D4 两级刷新 r/R + 指纹门（scan 新 API / keyrouter 注册 / tui 按键分支）。

覆盖：
- compute_fingerprint：正常三字段 / os.stat 失败 / 超过 50 万退化 / 查询失败 /
  60s 缓存命中 / 过期重探测 / force 跳过缓存 / clear_fingerprint_cache；
- fingerprints_equal：相等/失配/探测失败恒不等/None；
- light_refresh：只取直接子项、结构与 (name,is_dir,size) 一致、按大小倒序、
  top 截断、失败返回 None、忽略卷条目（与深刷口径一致）、盘符根尾斜杠匹配；
- deep_refresh：等价包装 scan（数据正确）、cancel_event 预置抛 ScanCancelledError、
  未置位正常完成、everything 注入跳过 DLL 加载；
- keyrouter：r/R 已注册（映射 + 帮助文案 + 无重复/无黑名单冲突）；
- tui：r@根指纹相同不重扫（毫秒返回「数据未变」）/ 不同升级深刷 / 探测失败
  升级深刷（不崩溃）/ 非根轻刷摘要 / 深扫在途 r 合并待办(E_SCAN_IN_PROGRESS) /
  在途 R 合并待办(E_BUSY) / Esc 取消 / 完成后消费合并待办 / 深扫 60s 冷却提示。

全部 SDK 交互经注入的 FakeEverythingSDK 或 mock 桩驱动，不依赖真实 Everything。
线程类测试用事件门控保证确定性（CPython GIL：worker 在事件置位后的收尾写入
在主线程被唤醒前完成）。
"""

import ctypes
import io
import os
import tempfile
import threading
import time
import unittest
from contextlib import ExitStack, redirect_stdout
from pathlib import Path
from unittest import mock

import keyrouter
import scan
import sdk
import tui
from scan import (
    FINGERPRINT_CACHE,
    FINGERPRINT_CACHE_TTL,
    FINGERPRINT_ERR_QUERY_FAILED,
    FINGERPRINT_ERR_STAT_FAILED,
    FINGERPRINT_ERR_TOO_MANY,
    FINGERPRINT_MAX_COUNT,
    ScanCancelledError,
    clear_fingerprint_cache,
    compute_fingerprint,
    deep_refresh,
    fingerprint_key,
    fingerprints_equal,
    light_refresh,
)

ROOT = Path("C:\\Users\\Test")


def make_fingerprint(file_count=10, dir_count=2, root_mtime=12345.0, ok=True, error_code=None):
    return {
        "file_count": file_count,
        "dir_count": dir_count,
        "root_mtime": root_mtime,
        "ok": ok,
        "error_code": error_code,
    }


class FakeEverythingSDK:
    """注入式 SDK 替身：按 (类型, 路径, 大小) 记录驱动指纹/轻刷/深刷。

    类型取 "file"/"folder"/"volume"/None；None 表示路径获取失败。query_calls 计数
    Everything_QueryW 调用（缓存生效/force/clear 断言的依据）。
    """

    def __init__(self, rows, num_results=None, query_ok=True, last_error=0):
        self.rows = list(rows)
        self.num_results_value = num_results if num_results is not None else len(self.rows)
        self.query_ok = query_ok
        self.last_error_value = last_error
        self.query_calls = 0

    def Everything_SetSearchW(self, s):
        self.set_search = s

    def Everything_SetRequestFlags(self, f):
        self.request_flags = f

    def Everything_QueryW(self, wait):
        self.query_calls += 1
        self.last_wait = wait
        return self.query_ok

    def Everything_GetNumResults(self):
        return self.num_results_value

    def Everything_IsFolderResult(self, i):
        return 1 if i < len(self.rows) and self.rows[i][0] == "folder" else 0

    def Everything_IsVolumeResult(self, i):
        return 1 if i < len(self.rows) and self.rows[i][0] == "volume" else 0

    def Everything_GetResultFullPathNameW(self, i, buffer, chars):
        if i >= len(self.rows) or self.rows[i][0] is None:
            return 0
        buffer.value = self.rows[i][1]
        return 1

    def Everything_GetResultSize(self, i, size_ptr):
        size_ptr.value = self.rows[i][2]
        return 1

    def Everything_GetLastError(self):
        return self.last_error_value


# =================【compute_fingerprint / fingerprints_equal】================


class FingerprintTests(unittest.TestCase):
    """指纹探测：正常三字段 / 失败退化路径 / 60s 缓存 / force / clear。"""

    def setUp(self):
        clear_fingerprint_cache()
        self.addCleanup(clear_fingerprint_cache)
        # 真实临时目录：os.stat 走真实路径，SDK 交互全部注入
        self.tmp = Path(tempfile.mkdtemp(prefix="fp_scan_"))
        self.addCleanup(lambda: None)  # 临时目录由系统清理，避免跨平台删除差异

    def test_normal_returns_three_fields_and_ok(self):
        """正常探测：返回 file_count/dir_count/root_mtime 三字段且 ok=True。"""
        fake = FakeEverythingSDK(
            [("file", str(self.tmp / "a.txt"), 10), ("folder", str(self.tmp / "sub"), 0)]
        )
        fp = compute_fingerprint(self.tmp, everything=fake)
        self.assertTrue(fp["ok"])
        self.assertIsNone(fp["error_code"])
        self.assertEqual(fp["file_count"], 2)
        self.assertEqual(fp["dir_count"], 1)
        self.assertIsInstance(fp["root_mtime"], float)
        self.assertEqual(fake.query_calls, 1)
        self.assertIn("path:", fake.set_search)

    def test_stat_failure_yields_ok_false(self):
        """os.stat 失败（根目录不可访问）→ ok=False + 专用错误码，不崩溃。"""
        fake = FakeEverythingSDK([])
        with mock.patch.object(scan.os, "stat", side_effect=OSError(2, "No such file")):
            fp = compute_fingerprint(self.tmp, everything=fake)
        self.assertFalse(fp["ok"])
        self.assertIsNone(fp["root_mtime"])
        self.assertEqual(fp["error_code"], FINGERPRINT_ERR_STAT_FAILED)
        self.assertEqual(fake.query_calls, 0, "stat 失败后不应再发起 SDK 查询")

    def test_query_failure_reports_everything_error_code(self):
        """Everything_QueryW 失败 → ok=False + 透传 Everything 错误码。"""
        fake = FakeEverythingSDK([], query_ok=False, last_error=sdk.EVERYTHING_ERROR_IPC)
        fp = compute_fingerprint(self.tmp, everything=fake)
        self.assertFalse(fp["ok"])
        self.assertEqual(fp["error_code"], sdk.EVERYTHING_ERROR_IPC)

    def test_too_many_results_degraded_ok_false(self):
        """结果数超 50 万 → 退化路径 dir_count=None + ok=False + 专用错误码，不崩溃。"""
        fake = FakeEverythingSDK([], num_results=FINGERPRINT_MAX_COUNT + 1)
        fp = compute_fingerprint(self.tmp, everything=fake)
        self.assertFalse(fp["ok"])
        self.assertIsNone(fp["dir_count"])
        self.assertEqual(fp["error_code"], FINGERPRINT_ERR_TOO_MANY)
        self.assertEqual(fp["file_count"], FINGERPRINT_MAX_COUNT + 1)

    def test_cache_hit_within_ttl_skips_query(self):
        """60s 冷却内第二次调用直接返回缓存，不重新查询（毫秒级门控依据）。"""
        fake = FakeEverythingSDK([])
        first = compute_fingerprint(self.tmp, everything=fake)
        second = compute_fingerprint(self.tmp, everything=fake)
        self.assertIs(first, second, "冷却内应返回同一缓存对象（不重新探测）")
        self.assertEqual(fake.query_calls, 1)

    def test_cache_expired_after_ttl_recomputes(self):
        """缓存超过 60s 后失效 → 重新探测并比较（旧指纹与新指纹当场可辨）。"""
        fake = FakeEverythingSDK([])
        first = compute_fingerprint(self.tmp, everything=fake)
        # 把缓存条目的 computed_at 拨回 TTL+1 秒前，模拟过期
        key = fingerprint_key(self.tmp)
        fp, _ = FINGERPRINT_CACHE[key]
        FINGERPRINT_CACHE[key] = (fp, time.time() - FINGERPRINT_CACHE_TTL - 1)
        second = compute_fingerprint(self.tmp, everything=fake)
        self.assertEqual(fake.query_calls, 2, "过期后必须重新探测")
        self.assertEqual(first, second, "目录未变时两次独立探测的指纹应一致（这才是『数据未变』的依据）")

    def test_force_skips_cache(self):
        """force=True 跳过 60s 缓存强制重新探测（并刷新缓存）。"""
        fake = FakeEverythingSDK([])
        compute_fingerprint(self.tmp, everything=fake)
        compute_fingerprint(self.tmp, everything=fake, force=True)
        self.assertEqual(fake.query_calls, 2)

    def test_clear_fingerprint_cache_forces_requery(self):
        """clear_fingerprint_cache() 清空全部条目；后再调用重新查询。"""
        fake = FakeEverythingSDK([])
        compute_fingerprint(self.tmp, everything=fake)
        self.assertIn(fingerprint_key(self.tmp), FINGERPRINT_CACHE)
        clear_fingerprint_cache()
        self.assertEqual(FINGERPRINT_CACHE, {})
        compute_fingerprint(self.tmp, everything=fake)
        self.assertEqual(fake.query_calls, 2)

    def test_fingerprints_equal_semantics(self):
        """指纹相等判定：仅双 ok 且三项一致为 True；失败/失配/缺失基线恒判不等。"""
        a = make_fingerprint()
        self.assertTrue(fingerprints_equal(a, dict(a)))
        self.assertFalse(fingerprints_equal(a, make_fingerprint(file_count=11)))
        self.assertFalse(fingerprints_equal(a, make_fingerprint(dir_count=3)))
        self.assertFalse(fingerprints_equal(a, make_fingerprint(root_mtime=1.0)))
        self.assertFalse(fingerprints_equal(a, make_fingerprint(ok=False)))
        self.assertFalse(fingerprints_equal(None, a))
        self.assertFalse(fingerprints_equal(a, None))


# =================【light_refresh】================


class LightRefreshTests(unittest.TestCase):
    """轻刷：直接子项结构 / 排序 / top 截断 / 失败返回 None（平台无关路径）。"""

    def setUp(self):
        self.tmp_dir = Path(tempfile.mkdtemp(prefix="lr_scan_"))

    def _rows(self, base, extras=()):
        """(类型, 路径, 大小) 行集：base/xx 为直接子项，extras 为后代目录项。"""
        rows = [
            ("file", os.path.join(base, "a.txt"), 10),
            ("file", os.path.join(base, "b.bin"), 500),
            ("folder", os.path.join(base, "sub"), 0),
            ("file", os.path.join(base, "deep", "inner.txt"), 999),  # 后代 → 应过滤
        ]
        rows.extend(extras)
        return rows

    def test_direct_children_only_sorted_by_size(self):
        """只返回直接子项（后代被过滤），按大小倒序，元组结构 (name,is_dir,size)。"""
        base = str(self.tmp_dir)
        fake = FakeEverythingSDK(self._rows(base))
        items = light_refresh(self.tmp_dir, self.tmp_dir, everything=fake)
        self.assertEqual(
            items,
            [
                ("b.bin", False, 500),
                ("a.txt", False, 10),
                ("sub", True, 0),
            ],
        )
        for item in items:
            self.assertEqual(len(item), 3)
            self.assertIsInstance(item[2], int)

    def test_top_truncation(self):
        """top 截断：超过 top 个直接子项时只保留最大的 top 个。"""
        base = str(self.tmp_dir)
        rows = [("file", os.path.join(base, "f%02d.txt" % i), i) for i in range(1, 8)]
        fake = FakeEverythingSDK(rows)
        items = light_refresh(self.tmp_dir, self.tmp_dir, everything=fake, top=3)
        self.assertEqual(len(items), 3)
        self.assertEqual([s for _, _, s in items], [7, 6, 5])

    def test_failure_returns_none(self):
        """查询失败（QueryW False）→ 返回 None（TUI 友好降级依据）。"""
        fake = FakeEverythingSDK([], query_ok=False)
        self.assertIsNone(light_refresh(self.tmp_dir, self.tmp_dir, everything=fake))

    def test_empty_dir_returns_empty_list(self):
        """没有结果的目录返回空列表（不是 None——查询成功）。"""
        fake = FakeEverythingSDK([], num_results=0)
        self.assertEqual(light_refresh(self.tmp_dir, self.tmp_dir, everything=fake), [])

    def test_drive_root_trailing_backslash_matches_children(self):
        """current_dir 为盘符根（C:\\）时能匹配直接子项：尾斜杠折叠不误判为空。"""
        fake = FakeEverythingSDK([
            ("file", r"C:\a.txt", 10),
            ("file", r"C:\deep\x.txt", 99),  # 后代 → 应过滤
        ])
        items = light_refresh(Path("C:\\"), Path("C:\\"), everything=fake)
        self.assertEqual(items, [("a.txt", False, 10)])

    def test_volume_result_skipped_like_deep_scan(self):
        """卷条目（驱动根自身）不进轻刷结果，与深刷 IsVolumeResult 跳过口径一致。"""
        base = str(self.tmp_dir)
        fake = FakeEverythingSDK([
            ("volume", os.path.join(base, ""), 0),
            ("file", os.path.join(base, "a.txt"), 7),
        ])
        items = light_refresh(self.tmp_dir, self.tmp_dir, everything=fake)
        self.assertEqual(items, [("a.txt", False, 7)])


# =================【deep_refresh】================


class DeepRefreshTests(unittest.TestCase):
    """深刷：等价包装全量扫描 / cancel_event 取消 / everything 注入。"""

    def setUp(self):
        self.tmp_dir = Path(tempfile.mkdtemp(prefix="dr_scan_"))

    def _rows(self):
        base = str(self.tmp_dir)
        return [
            ("file", os.path.join(base, "Docs", "report.txt"), 100),
            ("file", os.path.join(base, "Docs", "b.txt"), 50),
            ("file", os.path.join(base, "root.txt"), 10),
        ]

    def test_deep_refresh_equals_full_scan_result(self):
        """deep_refresh 等价重新执行 scan_via_everything_sdk（聚合/contents 一致）。"""
        fake = FakeEverythingSDK(self._rows())
        with mock.patch.object(scan, "log"):
            sizes, contents = deep_refresh(self.tmp_dir, everything=fake)
        self.assertEqual(sizes[self.tmp_dir], 160)
        self.assertEqual(sizes[self.tmp_dir / "Docs"], 150)
        self.assertEqual(
            contents.get(self.tmp_dir),
            [("Docs", True, 150), ("root.txt", False, 10)],
        )

    def test_cancel_event_preset_raises_scan_cancelled(self):
        """cancel_event 预置 → 主循环立即抛 ScanCancelledError（深刷取消语义）。"""
        fake = FakeEverythingSDK([], num_results=15000)  # 大结果：构造大扫描
        cancel = threading.Event()
        cancel.set()
        with mock.patch.object(scan, "log"):
            with self.assertRaises(ScanCancelledError):
                deep_refresh(self.tmp_dir, cancel_event=cancel, everything=fake)

    def test_cancel_event_unset_completes(self):
        """cancel_event 已创建但未置位 → 深刷正常完成，不抛异常。"""
        fake = FakeEverythingSDK(self._rows())
        cancel = threading.Event()
        with mock.patch.object(scan, "log"):
            sizes, contents = deep_refresh(self.tmp_dir, cancel_event=cancel, everything=fake)
        self.assertEqual(sizes[self.tmp_dir], 160)
        self.assertEqual(contents.get(self.tmp_dir)[0][0], "Docs")

    def test_everything_injected_skips_dll_loading(self):
        """everything 注入时不再走 sdk.load_everything_sdk（load 被打桩为必失败）。"""
        fake = FakeEverythingSDK(self._rows())
        with mock.patch.object(scan, "log"), \
                mock.patch.object(sdk, "load_everything_sdk",
                                  side_effect=AssertionError("不应触发 DLL 加载")):
            sizes, _contents = deep_refresh(self.tmp_dir, everything=fake)
        self.assertEqual(sizes[self.tmp_dir], 160)


# =================【keyrouter：r/R 注册（新行为）】================


class KeyrouterRefreshRegistrationTests(unittest.TestCase):
    """r/R 已注册进 KEY_BINDINGS（D4 起）：映射、帮助文案、无冲突。"""

    def test_r_key_maps_to_refresh_light(self):
        self.assertEqual(keyrouter.key_to_action(b"r"), keyrouter.ACT_REFRESH_LIGHT)

    def test_R_key_maps_to_refresh_deep(self):
        self.assertEqual(keyrouter.key_to_action(b"R"), keyrouter.ACT_REFRESH_DEEP)

    def test_help_text_mentions_light_and_deep(self):
        text = keyrouter.help_text()
        self.assertIn("[r] 轻刷", text)
        self.assertIn("[R] 深刷", text)

    def test_registry_contains_both_refresh_actions(self):
        actions = {entry["action"] for entry in keyrouter.KEY_BINDINGS}
        self.assertIn(keyrouter.ACT_REFRESH_LIGHT, actions)
        self.assertIn(keyrouter.ACT_REFRESH_DEEP, actions)

    def test_refresh_keys_not_duplicated_nor_forbidden(self):
        registered = set()
        for entry in keyrouter.KEY_BINDINGS:
            for kb in entry["keys"]:
                self.assertNotIn(kb, registered, "重复注册键字节: %r" % kb)
                registered.add(kb)
        for kb in (b"r", b"R"):
            self.assertNotIn(kb, keyrouter.FORBIDDEN_KEYS, "刷新键不应进禁键黑名单")


# =================【tui：r/R 按键分支 + 指纹门】================


class TuiRefreshTests(unittest.TestCase):
    """interactive_ui 内 r/R 分支：指纹门 / 轻刷 / 在途合并待办 / Esc 取消 / 冷却。"""

    ROOT = ROOT

    def setUp(self):
        self._ansi = tui._ANSI_AVAILABLE
        self._msvcrt = tui.msvcrt
        self.addCleanup(setattr, tui, "_ANSI_AVAILABLE", self._ansi)
        self.addCleanup(setattr, tui, "msvcrt", self._msvcrt)
        tui._ANSI_AVAILABLE = False
        clear_fingerprint_cache()
        self.addCleanup(clear_fingerprint_cache)
        term = mock.patch("shutil.get_terminal_size", return_value=os.terminal_size((120, 40)))
        term.start()
        self.addCleanup(term.stop)
        cls_patch = mock.patch("os.system")
        cls_patch.start()
        self.addCleanup(cls_patch.stop)

    def _run_ui(self, keys, sizes=None, contents=None, root=None):
        """注入按键序列（可传 callable 以在按键之间插桩）运行 interactive_ui。"""
        sizes = sizes if sizes is not None else {}
        contents = contents if contents is not None else {}
        root = root if root is not None else self.ROOT
        buf = io.StringIO()
        with ExitStack() as stack:
            stack.enter_context(mock.patch.object(tui, "_getch", side_effect=keys))
            stack.enter_context(mock.patch("builtins.input", return_value=""))
            with redirect_stdout(buf):
                result = tui.interactive_ui(root, sizes, contents, "test-driver")
        return result, buf.getvalue()

    # ---- r@根指纹门 ----

    def test_r_at_root_same_fingerprint_skips_rescan(self):
        """指纹相同（含冷却内毫秒命中）：显示『数据未变』不重扫。"""
        fp = make_fingerprint()
        key = fingerprint_key(self.ROOT)
        FINGERPRINT_CACHE[key] = (fp, time.time())
        with mock.patch.object(tui, "compute_fingerprint", return_value=fp), \
                mock.patch.object(tui, "deep_refresh") as deep:
            result, output = self._run_ui([b"r", b"q"], sizes={self.ROOT: 1}, contents={})
        self.assertEqual(result, ("quit", None))
        self.assertIn("数据未变", output)
        deep.assert_not_called()

    def test_r_at_root_dirty_fingerprint_triggers_deep(self):
        """指纹不一致（计数变了）：升级为深刷，继承 R 全套保护。"""
        key = fingerprint_key(self.ROOT)
        FINGERPRINT_CACHE[key] = (make_fingerprint(file_count=10), time.time())
        called = threading.Event()

        def fake_deep(root_arg, cancel_event=None, everything=None):
            called.set()
            return ({self.ROOT: 1}, {self.ROOT: [("a", False, 1)]})

        with mock.patch.object(tui, "compute_fingerprint",
                               return_value=make_fingerprint(file_count=11)), \
                mock.patch.object(tui, "deep_refresh", side_effect=fake_deep) as deep:
            result, output = self._run_ui([b"r", b"q"], sizes={}, contents={})
        self.assertEqual(result, ("quit", None))
        self.assertTrue(called.wait(5), "深刷线程未启动")
        deep.assert_called_once()
        self.assertIn("已启动", output)
        self.assertNotIn("数据未变", output)

    def test_r_at_root_probe_failure_upgrades_to_deep(self):
        """指纹探测失败（ok=False 且无基线可比）：安全方向升级深刷，不崩溃不误报。"""
        bad = make_fingerprint(ok=False, error_code=FINGERPRINT_ERR_TOO_MANY)
        key = fingerprint_key(self.ROOT)
        FINGERPRINT_CACHE[key] = (bad, time.time())
        called = threading.Event()

        def fake_deep(root_arg, cancel_event=None, everything=None):
            called.set()
            return ({}, {})

        with mock.patch.object(tui, "compute_fingerprint", return_value=bad), \
                mock.patch.object(tui, "deep_refresh", side_effect=fake_deep) as deep:
            result, output = self._run_ui([b"r", b"q"], sizes={}, contents={})
        self.assertEqual(result, ("quit", None))
        self.assertTrue(called.wait(5), "探测失败应升级为深刷")
        deep.assert_called_once()
        self.assertNotIn("数据未变", output)

    # ---- 非根轻刷 ----

    def test_r_non_root_light_refresh_with_summary(self):
        """非根 r：直接 light_refresh 当前目录，更新视图并显示摘要行（文件+N）。"""
        root = self.ROOT
        contents = {root: [("Docs", True, 0)], root / "Docs": [("old.txt", False, 5)]}
        with mock.patch.object(tui, "light_refresh",
                               return_value=[("new.txt", False, 42)]) as lr:
            result, output = self._run_ui(
                [b"\r", b"r", b"q"], sizes={root: 5, root / "Docs": 5}, contents=contents)
        self.assertEqual(result, ("quit", None))
        self.assertIn("已轻刷: 文件+1", output)
        args, kwargs = lr.call_args
        self.assertEqual(args[0], root)
        self.assertEqual(args[1], root / "Docs")
        self.assertEqual(kwargs.get("top"), 50)

    def test_r_non_root_light_refresh_failure_stays_alive(self):
        """非根 r 轻刷失败（返回 None）：友好提示，界面不崩溃、可继续操作。"""
        root = self.ROOT
        contents = {root: [("Docs", True, 0)]}
        with mock.patch.object(tui, "light_refresh", return_value=None):
            result, output = self._run_ui([b"\r", b"r", b"w", b"q"],
                                          sizes={root: 1}, contents=contents)
        self.assertEqual(result, ("quit", None))
        self.assertIn("轻刷失败", output)

    # ---- 在途合并待办（cap-1） ----

    def test_r_during_deep_scan_merges_pending_banner(self):
        """深扫在途按 r：仅置合并待办并显示『深扫进行中』，不重复执行深扫。"""
        gate = threading.Event()

        def blocking_deep(root_arg, cancel_event=None, everything=None):
            gate.wait(timeout=10)  # 模拟长扫描：期间 r 只能合并待办
            return ({}, {})

        try:
            with mock.patch.object(tui, "deep_refresh", side_effect=blocking_deep) as deep:
                result, output = self._run_ui([b"R", b"r", b"Q"], sizes={}, contents={})
        finally:
            gate.set()
        self.assertEqual(result, ("quit", None))
        self.assertIn("深扫进行中", output)
        self.assertIn("已启动", output)
        deep.assert_called_once()  # r 不重复触发深扫

    def test_R_during_deep_scan_merges_pending_busy(self):
        """深扫在途重按 R：合并待办 cap-1 + E_BUSY 语义横幅，不叠加扫描。"""
        gate = threading.Event()

        def blocking_deep(root_arg, cancel_event=None, everything=None):
            gate.wait(timeout=10)
            return ({}, {})

        try:
            with mock.patch.object(tui, "deep_refresh", side_effect=blocking_deep) as deep:
                result, output = self._run_ui([b"R", b"R", b"Q"], sizes={}, contents={})
        finally:
            gate.set()
        self.assertEqual(result, ("quit", None))
        self.assertIn("已在途", output)  # E_BUSY → 「S 已在途：请稍后」
        self.assertEqual(deep.call_count, 1, "在途重按 R 不得叠加启动新扫描")

    # ---- Esc 取消 / 合并待办消费 / 冷却 ----

    def test_esc_cancels_in_flight_deep_scan(self):
        """Esc 置位 cancel_event → 深刷抛 ScanCancelledError → 显示『已取消』。"""
        cancelled_seen = threading.Event()
        keys = iter([b"R", b"\x1b", "WAIT", b"w", b"q"])

        def deep_scan(root_arg, cancel_event=None, everything=None):
            cancel_event.wait(timeout=10)
            cancelled_seen.set()
            raise ScanCancelledError("深刷已由用户取消(Esc)")

        def fake_getch():
            item = next(keys)
            if item == "WAIT":
                # 等 worker 处理完取消信号（GIL 保证其收尾写入已可见）
                if not cancelled_seen.wait(5):
                    raise AssertionError("取消信号未被深扫线程接收")
                item = next(keys)
            return item

        with mock.patch.object(tui, "deep_refresh", side_effect=deep_scan), \
                mock.patch.object(tui, "_getch", side_effect=fake_getch), \
                mock.patch("builtins.input", return_value=""), \
                redirect_stdout(io.StringIO()) as out:
            result = tui.interactive_ui(self.ROOT, {}, {}, "test-driver")
        self.assertEqual(result, ("quit", None))
        output = out.getvalue()
        self.assertIn("取消请求已发送", output)
        self.assertIn("深扫已取消", output)

    def test_pending_r_consumed_after_deep_scan_completes(self):
        """深扫完成后消费合并待办（cap-1）：补一次当前目录轻刷，不连锁深扫。"""
        root = self.ROOT
        gate = threading.Event()
        worker_done = threading.Event()
        keys = iter([b"R", b"r", "RELEASE", b"x", b"q"])

        def deep_scan(root_arg, cancel_event=None, everything=None):
            gate.wait(timeout=10)
            worker_done.set()
            return ({root: 9999}, {root: [("new.bin", False, 9999)]})

        def fake_getch():
            item = next(keys)
            if item == "RELEASE":
                gate.set()
                if not worker_done.wait(5):
                    raise AssertionError("深扫线程未在限时内完成")
                item = next(keys)
            return item

        with mock.patch.object(tui, "deep_refresh", side_effect=deep_scan), \
                mock.patch.object(tui, "_getch", side_effect=fake_getch), \
                mock.patch.object(tui, "light_refresh",
                                  return_value=[("new.bin", False, 9999)]) as lr, \
                mock.patch("builtins.input", return_value=""), \
                redirect_stdout(io.StringIO()) as out:
            result = tui.interactive_ui(root, {root: 0}, {root: [("a", False, 0)]}, "test-driver")
        self.assertEqual(result, ("quit", None))
        output = out.getvalue()
        self.assertIn("深扫进行中", output)  # 在途 r → 合并待办
        self.assertIn("已轻刷", output)      # 完成后消费待办 → 补一次轻刷
        lr.assert_called_once()
        self.assertEqual(lr.call_args[0][1], root, "合并待办应轻刷当前路径")

    def test_R_shows_cooldown_after_deep_scan(self):
        """深刷完成后 60s 冷却：再按 R 只提示不执行，不重复深扫。"""
        root = self.ROOT
        worker_done = threading.Event()
        keys = iter([b"R", "WAIT", b"R", b"q"])

        def deep_scan(root_arg, cancel_event=None, everything=None):
            worker_done.set()
            return ({root: 1}, {root: [("a", False, 1)]})

        def fake_getch():
            item = next(keys)
            if item == "WAIT":
                if not worker_done.wait(5):
                    raise AssertionError("深扫线程未在限时内完成")
                item = next(keys)
            return item

        with mock.patch.object(tui, "deep_refresh", side_effect=deep_scan) as deep, \
                mock.patch.object(tui, "_getch", side_effect=fake_getch), \
                mock.patch("builtins.input", return_value=""), \
                redirect_stdout(io.StringIO()) as out:
            result = tui.interactive_ui(root, {}, {}, "test-driver")
        self.assertEqual(result, ("quit", None))
        self.assertIn("深刷冷却中", out.getvalue())
        self.assertEqual(deep.call_count, 1, "冷却期内不得重复深扫")


if __name__ == "__main__":
    unittest.main()