"""scan 模块单元测试：目录深度排序键 / 扫描根判定 / 惰性 contents / SDK 全流程。

- _dir_sort_key：严格单调（盘根/子目录/UNC/混合分隔符/尾斜杠）；
- _is_scan_root：大小写/尾斜杠/盘根/UNC/普通目录不误判；
- LazyContents：按需构建/有界淘汰/未知键/缓存只读；
- _build_lazy_contents：与旧算法等价（稳定排序、同 size 子目录在前）；
- scan_via_everything_sdk：注入 FakeEverythingSDK 驱动聚合与惰性 contents 装配。

不依赖真实 Everything 进程；Windows 路径语义相关的用例在非 Windows 上跳过。
"""

import ctypes
import io
import os
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

import sdk
from scan import (
    MAX_FILES_PER_DIR,
    SCAN_PROGRESS_REFRESH_INTERVAL,
    LazyContents,
    _build_lazy_contents,
    _dir_sort_key,
    _is_scan_root,
    scan_via_everything_sdk,
)
import scan

ROOT = Path("C:\\Users\\Test")


class FakeEverythingSDK:
    """按 (类型, 路径, 大小) 记录驱动 SDK 全流程的注入替身。

    类型取值为 "file"/"folder"/"volume"/None；None 表示路径获取失败的记录
    （Everything_GetResultFullPathNameW 返回 0）。所有方法仅记录调用，
    不触碰真实 DLL。
    """

    def __init__(self, rows, num_results=None, query_ok=True, last_error=0):
        self.rows = list(rows)
        self.num_results_value = num_results if num_results is not None else len(self.rows)
        self.query_ok = query_ok
        self.last_error_value = last_error
        self.calls = []

    def Everything_SetSearchW(self, s):
        self.calls.append(("SetSearchW", s))

    def Everything_SetRequestFlags(self, f):
        self.calls.append(("SetRequestFlags", f))

    def Everything_QueryW(self, wait):
        self.calls.append(("QueryW", wait))
        return self.query_ok

    def Everything_GetNumResults(self):
        self.calls.append(("GetNumResults",))
        return self.num_results_value

    def Everything_IsFolderResult(self, i):
        return 1 if i < len(self.rows) and self.rows[i][0] == "folder" else 0

    def Everything_IsVolumeResult(self, i):
        return 1 if i < len(self.rows) and self.rows[i][0] == "volume" else 0

    def Everything_GetResultFullPathNameW(self, i, buffer, chars):
        self.calls.append(("GetResultFullPathNameW", i))
        if i >= len(self.rows) or self.rows[i][0] is None:
            return 0
        buffer.value = self.rows[i][1]
        return 1

    def Everything_GetResultSize(self, i, size_ptr):
        self.calls.append(("GetResultSize", i))
        size_ptr.value = self.rows[i][2]
        return 1

    def Everything_GetLastError(self):
        self.calls.append(("GetLastError",))
        return self.last_error_value


def run_scan(root, rows, **fake_kwargs):
    """以注入方式运行 scan_via_everything_sdk，返回 (fake, sizes, contents)。"""
    fake = FakeEverythingSDK(rows, **fake_kwargs)
    with mock.patch.object(scan, "log"), \
            mock.patch.object(sdk, "load_everything_sdk", return_value=fake), \
            mock.patch.object(sdk, "DLL_PATH", "C:\\fake\\Everything64.dll"):
        sizes, contents = scan_via_everything_sdk(root)
    return fake, sizes, contents


class DirSortKeyTests(unittest.TestCase):
    """_dir_sort_key：按 Path 组件数计深的严格单调深度键。"""

    def test_drive_root_depth_is_one(self):
        """盘符根 C:\\ 深度为 1（不能与一级子目录同为 1）。"""
        self.assertEqual(_dir_sort_key(Path("C:\\")), 1)
        self.assertEqual(_dir_sort_key(Path("C:/")), 1)

    def test_each_level_increments(self):
        """逐层子目录深度 +1（修复动机：C:\\ 与 C:\\Users 此前同为 1）。"""
        self.assertEqual(_dir_sort_key(Path("C:\\Users")), 2)
        self.assertEqual(_dir_sort_key(Path("C:\\Users\\a")), 3)
        self.assertEqual(_dir_sort_key(Path("C:\\Users\\a\\b")), 4)

    def test_unc_root_and_children(self):
        """UNC 根 \\\\server\\share 计为 1 个组件，其子目录同样逐层 +1。"""
        self.assertEqual(_dir_sort_key(Path("\\\\server\\share")), 1)
        self.assertEqual(_dir_sort_key(Path("\\\\server\\share\\dir")), 2)
        self.assertEqual(_dir_sort_key(Path("\\\\server\\share\\dir\\sub")), 3)

    def test_mixed_separators_equal(self):
        """混合分隔符 C:/a/b 与 C:\\a\\b 的深度键一致。"""
        self.assertEqual(
            _dir_sort_key(Path("C:/Users/a")),
            _dir_sort_key(Path("C:\\Users\\a")),
        )

    def test_trailing_separator_folded(self):
        """尾随分隔符被 Path 折叠，不改变深度。"""
        self.assertEqual(_dir_sort_key(Path("C:\\Users\\")), 2)
        self.assertEqual(_dir_sort_key(Path("\\\\srv\\share\\")), 1)

    def test_parent_chain_strictly_monotonic(self):
        """沿 dirname 链父目录深度严格递减（拓扑序依据），直至自映射停止。"""
        for start in (Path("C:\\Users\\a\\b\\c"), Path("\\\\srv\\share\\d\\e")):
            d = start
            prev = _dir_sort_key(d)
            while True:
                parent_path = Path(os.path.dirname(d))
                if parent_path == d:
                    break
                cur = _dir_sort_key(parent_path)
                self.assertLess(cur, prev, f"{parent_path} 应严格浅于 {d}")
                prev = cur
                d = parent_path


@unittest.skipUnless(os.name == "nt", "盘符/UNC 大小写与尾斜杠语义仅 Windows 成立")
class IsScanRootWindowsTests(unittest.TestCase):
    """_is_scan_root 的 Windows 路径语义：大小写/尾斜杠/盘根/UNC。"""

    def test_case_insensitive_match(self):
        """大小写失配（Everything 原样返回）仍判定为根。"""
        self.assertTrue(_is_scan_root("c:\\users", Path("C:\\Users")))
        self.assertTrue(_is_scan_root("C:/USERS", Path("c:\\users")))

    def test_trailing_slash_folded(self):
        """尾斜杠形态（dirname/Everything 产物）与无尾斜杠相等。"""
        self.assertTrue(_is_scan_root("C:\\Users\\", Path("C:\\Users")))
        self.assertTrue(_is_scan_root("c:/users/", Path("C:/Users")))

    def test_drive_root_self_dirname(self):
        """盘符根 C:\\ 的 dirname 自映射为自身，仍判为根。"""
        self.assertTrue(_is_scan_root("C:\\", Path("C:\\")))
        self.assertTrue(_is_scan_root("C:/", Path("C:\\")))

    def test_unc_root(self):
        """UNC 根带/不带尾斜杠均判为根，其子目录不误判。"""
        self.assertTrue(_is_scan_root("\\\\server\\share", Path("\\\\server\\share")))
        self.assertTrue(_is_scan_root("\\\\server\\share\\", Path("\\\\server\\share")))
        self.assertFalse(_is_scan_root("\\\\server\\share\\docs", Path("\\\\server\\share")))


class IsScanRootBasicTests(unittest.TestCase):
    """_is_scan_root 的平台无关基本判定。"""

    def test_same_path_is_root(self):
        """与根完全相同的路径判定为根。"""
        root = Path("C:\\Users")
        self.assertTrue(_is_scan_root("C:\\Users", root))

    def test_child_not_misjudged(self):
        """普通子目录不能误判为根。"""
        self.assertFalse(_is_scan_root("C:\\Users\\a", Path("C:\\Users")))

    def test_unrelated_path_not_root(self):
        """无关路径（同级/其他盘）不判定为根。"""
        self.assertFalse(_is_scan_root("C:\\Windows", Path("C:\\Users")))
        self.assertFalse(_is_scan_root("D:\\Users", Path("C:\\Users")))


class LazyContentsTests(unittest.TestCase):
    """LazyContents：按需构建、有界缓存、未知键、只读 cache_size。"""

    def test_builder_lazy_and_cached(self):
        """builder 只在键被访问时调用一次，重复访问命中缓存不再调用。"""
        calls = []
        lc = LazyContents(lambda k: calls.append(k) or [("x", False, 1)])
        self.assertEqual(calls, [], "未访问时不应调用 builder")
        key = Path("C:\\a")
        self.assertEqual(lc.get(key), [("x", False, 1)])
        self.assertEqual(lc.get(key), [("x", False, 1)])
        self.assertEqual(calls, [key], "访问两次应只构建一次")

    def test_getitem_uses_missing(self):
        """dict 下标访问缺失键时经 __missing__ 构建并缓存。"""
        lc = LazyContents(lambda k: [("f", False, 7)])
        self.assertEqual(lc[Path("C:\\a")], [("f", False, 7)])
        self.assertEqual(lc.cache_size, 1)

    def test_get_unknown_returns_default(self):
        """builder 抛 KeyError（未知目录）时 get 返回默认值而不抛。"""
        lc = LazyContents(lambda k: (_ for _ in ()).throw(KeyError(k)))
        self.assertEqual(lc.get(Path("C:\\nope"), []), [])

    def test_bound_cache_eviction(self):
        """超出上限整体清空：cache_size 恒不超上限，旧键被淘汰。"""
        lc = LazyContents(lambda k: [], max_cached=3)
        keys = [Path(f"C:\\d{i}") for i in range(5)]
        for k in keys:
            lc.get(k) or []
            self.assertLessEqual(lc.cache_size, 3)
        self.assertEqual(lc.cache_size, 2)  # 淘汰后仅剩最近两个键
        self.assertIn(keys[3], lc)
        self.assertIn(keys[4], lc)
        self.assertNotIn(keys[0], lc, "超出上限整体清空后，最旧键应已淘汰")

    def test_max_cached_one(self):
        """max_cached=1 时每访问新键都整体清空，仅保留最新。"""
        lc = LazyContents(lambda k: [], max_cached=1)
        lc.get(Path("C:\\a")) or []
        lc.get(Path("C:\\b")) or []
        self.assertEqual(lc.cache_size, 1)
        self.assertIn(Path("C:\\b"), lc)
        self.assertNotIn(Path("C:\\a"), lc)

    def test_cache_size_readonly(self):
        """cache_size 为只读属性，赋值抛 AttributeError。"""
        lc = LazyContents(lambda k: [])
        with self.assertRaises(AttributeError):
            lc.cache_size = 99

    def test_clear_empties_cache(self):
        """clear() 清空缓存条目（键不再命中）。"""
        lc = LazyContents(lambda k: [("f", False, 0)])
        key = Path("C:\\a")
        lc.get(key)
        lc.clear()
        self.assertEqual(lc.cache_size, 0)
        self.assertNotIn(key, lc)


class BuildLazyContentsTests(unittest.TestCase):
    """_build_lazy_contents 与旧算法等价：稳定排序、同 size 子目录在前、大小写命中。"""

    def test_subdir_before_same_size_file(self):
        """同 size 时稳定排序保证子目录（先加入）排在文件之前。"""
        dir_sizes = {Path("C:\\root\\sub"): 100}
        folder_files = {"C:\\root": [(100, "f.txt")]}
        folder_subdirs = {"C:\\root": {"sub"}}
        contents = _build_lazy_contents(dir_sizes, folder_files, folder_subdirs)
        self.assertEqual(
            contents.get(Path("C:\\root")),
            [("sub", True, 100), ("f.txt", False, 100)],
        )

    def test_files_sorted_desc_stable_for_ties(self):
        """文件按 (大小, 文件名) 元组倒序排列；同 size 按文件名倒序（决定性）。"""
        folder_files = {"C:\\root": [(5, "f1"), (9, "f2"), (5, "f3")]}
        folder_subdirs = {"C:\\root": set()}
        contents = _build_lazy_contents({}, folder_files, folder_subdirs)
        self.assertEqual(
            contents.get(Path("C:\\root")),
            [("f2", False, 9), ("f3", False, 5), ("f1", False, 5)],
        )

    def test_case_mismatch_key_hit(self):
        """Everything 返回的大小写与访问 Path 失配时仍能命中（Path 相等比较）。"""
        folder_files = {"C:\\Users\\A": [(10, "a.txt")]}
        folder_subdirs = {"C:\\Users\\A": {"Sub"}}
        dir_sizes = {Path("c:/users/a/sub"): 3}
        contents = _build_lazy_contents(dir_sizes, folder_files, folder_subdirs)
        self.assertEqual(
            contents.get(Path("c:/users/a")),
            [("a.txt", False, 10), ("Sub", True, 3)],
        )

    def test_trailing_slash_key_hit(self):
        """带尾斜杠的键与不带尾斜杠的访问 Path 等价。"""
        folder_files = {"C:\\Users\\A\\": [(1, "x.txt")]}
        folder_subdirs = {"C:\\Users\\A\\": set()}
        contents = _build_lazy_contents({}, folder_files, folder_subdirs)
        self.assertEqual(contents.get(Path("C:\\Users\\A")), [("x.txt", False, 1)])

    def test_unknown_dir_returns_empty(self):
        """不在任何结构中的未知目录返回 []（与旧实现 .get() 缺失键一致）。"""
        contents = _build_lazy_contents({}, {"C:\\root": [(1, "a")]}, {"C:\\root": {"s"}})
        self.assertEqual(contents.get(Path("C:\\elsewhere")), [])

    def test_missing_subdir_size_defaults_zero(self):
        """dir_sizes 缺失子目录 size 时按 0 计入。"""
        folder_subdirs = {"C:\\root": {"orphan"}}
        contents = _build_lazy_contents({}, {}, folder_subdirs)
        self.assertEqual(
            contents.get(Path("C:\\root")),
            [("orphan", True, 0)],
        )

    def test_empty_folder_returns_empty(self):
        """没有任何文件/子目录的目录条目为空列表。"""
        contents = _build_lazy_contents({}, {"C:\\root": []}, {"C:\\root": set()})
        self.assertEqual(contents.get(Path("C:\\root")), [])

    def test_multi_subdir_ordered_by_size(self):
        """多个子目录按 size 倒序排列。"""
        dir_sizes = {Path("C:\\root\\s1"): 100, Path("C:\\root\\s2"): 50}
        folder_subdirs = {"C:\\root": {"s1", "s2"}}
        contents = _build_lazy_contents(dir_sizes, {}, folder_subdirs)
        self.assertEqual(
            contents.get(Path("C:\\root")),
            [("s1", True, 100), ("s2", True, 50)],
        )

    def test_lazy_object_caches_after_first_access(self):
        """返回的 LazyContents 对象首次访问后缓存命中（builder 不重复执行）。"""
        dir_sizes = {Path("C:\\root\\s"): 1}
        folder_subdirs = {"C:\\root": {"s"}}
        contents = _build_lazy_contents(dir_sizes, {}, folder_subdirs)
        self.assertEqual(contents.get(Path("C:\\root")), [("s", True, 1)])
        self.assertEqual(contents.get(Path("C:\\root")), [("s", True, 1)])
        self.assertEqual(contents.cache_size, 1)


@unittest.skipUnless(os.name == "nt", "扫描路径为 Windows 反斜杠路径，仅 Windows 上语义成立")
class ScanViaEverythingSdkTests(unittest.TestCase):
    """scan_via_everything_sdk 全流程（fake SDK 驱动）：聚合、修剪、惰性装配。"""

    ROOT = ROOT

    def test_empty_results_returns_empty_dicts(self):
        """Everything 返回 0 条记录时返回 ({}, {})，且为普通 dict。"""
        fake, sizes, contents = run_scan(self.ROOT, [])
        self.assertEqual(sizes, {})
        self.assertEqual(contents, {})
        self.assertIsInstance(sizes, dict)
        self.assertTrue(any(name == "GetNumResults" for name, *_ in fake.calls))

    def test_query_failure_raises_runtime_error(self):
        """Everything_QueryW 失败时抛 RuntimeError 并带查询失败文案。"""
        fake = FakeEverythingSDK([], query_ok=False, last_error=sdk.EVERYTHING_ERROR_IPC)
        with mock.patch.object(scan, "log"), \
                mock.patch.object(sdk, "load_everything_sdk", return_value=fake), \
                mock.patch.object(sdk, "DLL_PATH", "C:\\fake\\Everything64.dll"):
            with self.assertRaisesRegex(RuntimeError, "Everything查询失败"):
                scan_via_everything_sdk(self.ROOT)
        self.assertIn(("GetLastError",), fake.calls)

    def test_basic_aggregation_and_lazy_contents(self):
        """文件归并/父子树构建/自底向上汇总/惰性 contents 装配全链路。"""
        rows = [
            ("file", "C:\\Users\\Test\\root.txt", 10),
            ("file", "C:\\Users\\Test\\Docs\\report.txt", 100),
            ("file", "C:\\Users\\Test\\Docs\\b.txt", 50),
            ("file", "C:\\Users\\Test\\Docs\\Sub\\c.txt", 30),
        ]
        fake, sizes, contents = run_scan(self.ROOT, rows)

        # 汇总：根 = 直接文件 10 + Docs 全部 180
        self.assertEqual(sizes[Path("C:\\Users\\Test")], 190)
        self.assertEqual(sizes[Path("C:\\Users\\Test\\Docs")], 180)
        self.assertEqual(sizes[Path("C:\\Users\\Test\\Docs\\Sub")], 30)

        # 惰性 contents：根目录条目（子目录在前）与 Docs 条目
        self.assertEqual(
            contents.get(Path("C:\\Users\\Test")),
            [("Docs", True, 180), ("root.txt", False, 10)],
        )
        # Docs 的条目按大小倒序：report(100) > b(50) > Sub(30)（子目录压到尾部）
        self.assertEqual(
            contents.get(Path("C:\\Users\\Test\\Docs")),
            [("report.txt", False, 100), ("b.txt", False, 50), ("Sub", True, 30)],
        )
        self.assertEqual(contents.get(Path("C:\\Users\\Test\\Unknown")), [])

        # 查询参数与搜索条件记录
        self.assertIn(("SetSearchW", 'path:"C:\\Users\\Test\\"'), fake.calls)
        self.assertIn(
            ("SetRequestFlags",
             sdk.EVERYTHING_REQUEST_FULL_PATH_AND_FILE_NAME | sdk.EVERYTHING_REQUEST_SIZE),
            fake.calls,
        )
        self.assertIn(("QueryW", True), fake.calls)

    def test_skipped_rows_not_accumulated(self):
        """文件夹/卷记录、路径获取失败、越界记录、根外路径、0 字节文件全部跳过。"""
        rows = [
            ("folder", "C:\\Users\\Test\\Docs", 0),          # 文件夹记录 → 跳过
            ("volume", "C:\\Users\\Test\\Other", 0),         # 卷记录 → 跳过
            (None, "C:\\Users\\Test\\Broken\\x.txt", 5),     # 路径获取失败 → 跳过
            ("file", "C:\\Other\\outside.txt", 999),         # 根外路径 → 跳过
            ("file", "C:\\Users\\Test\\Docs\\zero.txt", 0),  # 0 字节 → 跳过
            ("file", "C:\\Users\\Test\\Docs\\real.txt", 42),  # 唯一有效记录
        ]
        fake, sizes, _ = run_scan(self.ROOT, rows, num_results=len(rows) + 3)
        # 只有 real.txt 进入统计（Docs = 42，根 = 42）
        self.assertEqual(sizes[Path("C:\\Users\\Test\\Docs")], 42)
        self.assertEqual(sizes[Path("C:\\Users\\Test")], 42)
        self.assertNotIn(Path("C:\\Other"), sizes)
        self.assertNotIn(Path("C:\\Users\\Test\\Broken"), sizes)

    def test_top50_truncation_per_dir(self):
        """每目录最多保留 MAX_FILES_PER_DIR 个最大文件（堆修剪）。"""
        rows = [
            ("file", f"C:\\Users\\Big\\Dir\\f{i:02d}.txt", i)
            for i in range(1, 56)
        ]
        fake, sizes, contents = run_scan(Path("C:\\Users\\Big"), rows)
        self.assertEqual(MAX_FILES_PER_DIR, 50)
        dir_items = contents.get(Path("C:\\Users\\Big\\Dir"))
        self.assertEqual(len(dir_items), 50, "超出 50 的文件应被截断")
        self.assertEqual(dir_items[0], ("f55.txt", False, 55))
        self.assertEqual(dir_items[-1], ("f06.txt", False, 6))  # 保留 6..55
        self.assertEqual(sizes[Path("C:\\Users\\Big\\Dir")], sum(range(1, 56)))
        self.assertEqual(
            contents.get(Path("C:\\Users\\Big")),
            [("Dir", True, sizes[Path("C:\\Users\\Big\\Dir")])],
        )

    def test_dll_auto_resolve_when_unset(self):
        """sdk.DLL_PATH 为 None 时自动解析并回填，再经 load 加载一次。"""
        fake = FakeEverythingSDK([])
        fake_resolve = mock.Mock(return_value="C:\\fake\\Everything64.dll")
        fake_load = mock.Mock(return_value=fake)
        with mock.patch.object(scan, "log"), \
                mock.patch.object(sdk, "DLL_PATH", None), \
                mock.patch.object(sdk, "resolve_everything_dll", fake_resolve), \
                mock.patch.object(sdk, "load_everything_sdk", fake_load):
            sizes, contents = scan_via_everything_sdk(self.ROOT)
        fake_resolve.assert_called_once_with()
        fake_load.assert_called_once_with("C:\\fake\\Everything64.dll", include_result_functions=True)
        self.assertEqual(sizes, {})
        self.assertEqual(contents, {})

    def test_all_logs_and_progress_suppressed_when_verbose_false(self):
        """VERBOSE=False（--quiet 生效的等价条件）时 scan 的全部 log（含 \r 进度行）静默。

        不 patch scan.log：用真实 log 走 stdout，验证 VERBOSE 门控对 🧩/📥/🌲 等
        过程日志与 \r 处理中进度行的抑制；同时校验记录确实被处理（合计大小），
        保证「无输出」断言不是空转。
        """
        rows = [
            ("file", f"C:\\Users\\Test\\Docs\\f{i:05d}.txt", i + 1)
            for i in range(SCAN_PROGRESS_REFRESH_INTERVAL + 1)
        ]
        fake = FakeEverythingSDK(rows)
        buf = io.StringIO()
        with mock.patch("utils.VERBOSE", False), \
                mock.patch.object(sdk, "load_everything_sdk", return_value=fake), \
                mock.patch.object(sdk, "DLL_PATH", "C:\\fake\\Everything64.dll"), \
                redirect_stdout(buf):
            sizes, contents = scan_via_everything_sdk(Path("C:\\Users\\Test"))
        self.assertEqual(buf.getvalue(), "", "VERBOSE=False 时任何 log/进度行都不得进入 stdout")
        # 每一行文件各计入 根+Docs 两处（聚合链路走通：无输出断言非空转）
        self.assertEqual(sum(sizes.values()), 2 * sum(range(1, len(rows) + 1)))
        self.assertTrue(any(name == "GetNumResults" for name, *_ in fake.calls))


if __name__ == "__main__":
    unittest.main()