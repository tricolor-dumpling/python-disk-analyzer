"""sdk 模块单元测试：DLL 名平台推断 / DLL 解析选择 / IPC 就绪逻辑 / 加载缓存。

- _everything_dll_name：显式注入 machine/pointer_bits，或 patch platform.machine 模拟；
- resolve_everything_dll：临时目录放假 dll 验证候选顺序与 config 缓存；
- is_everything_ipc_ready：注入 fake DLL 驱动纯逻辑分支；真实 IPC 检查仅在
  Windows 且 Everything 进程运行时执行，否则跳过；
- load_everything_sdk：patch ctypes.WinDLL 计数，验证 str/Path 归一化共享缓存条目。

不依赖真实 Everything 进程/注册表；真实 IPC 用例受控跳过。
"""

import ctypes
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import sdk
from sdk import (
    EVERYTHING_ERROR_IPC,
    EVERYTHING_ERROR_MEMORY,
    _everything_dll_name,
    is_everything_ipc_ready,
    is_everything_query_ready,
    is_everything_ready,
    load_everything_sdk,
    resolve_everything_dll,
)


class EverythingDllNameTests(unittest.TestCase):
    """_everything_dll_name：按架构自动选择 DLL 文件名。"""

    def test_x64_machine(self):
        """AMD64 + 64 位指针 → Everything64.dll。"""
        self.assertEqual(_everything_dll_name(machine="AMD64", pointer_bits=64), "Everything64.dll")

    def test_x64_32bit_python(self):
        """AMD64 + 32 位指针（32 位 Python）→ Everything32.dll。"""
        self.assertEqual(_everything_dll_name(machine="AMD64", pointer_bits=32), "Everything32.dll")

    def test_x86_machine(self):
        """x86 + 32 位指针 → Everything32.dll。"""
        self.assertEqual(_everything_dll_name(machine="x86", pointer_bits=32), "Everything32.dll")

    def test_arm64_machine(self):
        """ARM64 + 64 位指针 → EverythingARM64.dll。"""
        self.assertEqual(_everything_dll_name(machine="ARM64", pointer_bits=64), "EverythingARM64.dll")

    def test_arm_32bit(self):
        """ARM + 32 位指针 → EverythingARM.dll。"""
        self.assertEqual(_everything_dll_name(machine="ARM", pointer_bits=32), "EverythingARM.dll")

    def test_machine_lowercase_normalized(self):
        """机器名大小写不敏感（.upper() 归一化）。"""
        self.assertEqual(_everything_dll_name(machine="arm64", pointer_bits=64), "EverythingARM64.dll")

    def test_platform_machine_patched(self):
        """machine 缺省时回退 platform.machine()，可通过 patch 模拟。"""
        with mock.patch("sdk.platform.machine", return_value="AMD64"):
            self.assertEqual(_everything_dll_name(pointer_bits=64), "Everything64.dll")
        with mock.patch("sdk.platform.machine", return_value="arm64"):
            self.assertEqual(_everything_dll_name(pointer_bits=64), "EverythingARM64.dll")

    def test_pointer_bits_default_from_ctypes(self):
        """pointer_bits 缺省时取当前解释器指针宽度（64 位解释器 → Everything64）。"""
        expected = "Everything64.dll" if ctypes.sizeof(ctypes.c_void_p) * 8 == 64 else "Everything32.dll"
        self.assertEqual(_everything_dll_name(machine="AMD64"), expected)


class ResolveEverythingDllTests(unittest.TestCase):
    """resolve_everything_dll：临时目录放假 dll 验证候选选择与 config 缓存。"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tmp = Path(self._tmp.name)
        # 静音模块日志
        patcher = mock.patch.object(sdk, "log")
        patcher.start()
        self.addCleanup(patcher.stop)

    def _touch(self, rel):
        p = self.tmp / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(b"fake dll")
        return p

    def test_finds_in_sdk_dir(self):
        """优先命中 everything-SDK/dll 目录下的架构 DLL。"""
        expected = self._touch("everything-SDK/dll/Everything64.dll")
        self.assertEqual(
            resolve_everything_dll(script_dir=self.tmp, machine="AMD64", pointer_bits=64),
            expected,
        )

    def test_falls_back_to_script_dir(self):
        """无 SDK 子目录时回退 script_dir 根目录。"""
        expected = self._touch("Everything64.dll")
        self.assertEqual(
            resolve_everything_dll(script_dir=self.tmp, machine="AMD64", pointer_bits=64),
            expected,
        )

    def test_prefers_sdk_dir_over_script_dir(self):
        """两处都存在时按候选顺序取 SDK 子目录。"""
        sdk_dir = self._touch("everything-SDK/dll/Everything64.dll")
        self._touch("Everything64.dll")
        self.assertEqual(
            resolve_everything_dll(script_dir=self.tmp, machine="AMD64", pointer_bits=64),
            sdk_dir,
        )

    def test_config_cache_priority(self):
        """config 缓存（base_dir 内）优先于候选路径。"""
        cached = self._touch("cached/Everything64.dll")
        self._touch("everything-SDK/dll/Everything64.dll")
        result = resolve_everything_dll(
            script_dir=self.tmp, machine="AMD64", pointer_bits=64,
            config={"everything_dll": str(cached)},
        )
        self.assertEqual(result, cached)

    def test_config_outside_base_dir_ignored(self):
        """config 路径在 base_dir 之外时视为无效，回退候选路径。"""
        outside = self._tmp.name + "_outside"
        try:
            Path(outside).mkdir(exist_ok=True)
            Path(outside, "Everything64.dll").write_bytes(b"x")
            expected = self._touch("everything-SDK/dll/Everything64.dll")
            result = resolve_everything_dll(
                script_dir=self.tmp, machine="AMD64", pointer_bits=64,
                config={"everything_dll": str(Path(outside) / "Everything64.dll")},
            )
            self.assertEqual(result, expected)
        finally:
            import shutil
            shutil.rmtree(outside, ignore_errors=True)

    def test_config_nonexistent_ignored(self):
        """config 指定的 dll 不存在时忽略并走候选。"""
        expected = self._touch("everything-SDK/dll/Everything64.dll")
        result = resolve_everything_dll(
            script_dir=self.tmp, machine="AMD64", pointer_bits=64,
            config={"everything_dll": str(self.tmp / "missing.dll")},
        )
        self.assertEqual(result, expected)

    def test_config_non_dict_ignored(self):
        """config 非 dict（脏 JSON）时按空配置处理。"""
        expected = self._touch("everything-SDK/dll/Everything64.dll")
        result = resolve_everything_dll(
            script_dir=self.tmp, machine="AMD64", pointer_bits=64, config="junk",
        )
        self.assertEqual(result, expected)

    def test_not_found_raises_filenotfound(self):
        """任何候选都不存在时抛 FileNotFoundError，文案含架构 DLL 名与已检查列表。"""
        with self.assertRaises(FileNotFoundError) as ctx:
            resolve_everything_dll(script_dir=self.tmp, machine="AMD64", pointer_bits=64)
        message = str(ctx.exception)
        self.assertIn("Everything64.dll", message)
        self.assertIn("已检查", message)
        self.assertIn("everything-SDK", message)


class _NoIsDbLoadedDll:
    """模拟旧版/精简 DLL：不存在 Everything_IsDBLoaded 符号。"""

    def Everything_SetSearchW(self, s):
        pass

    def Everything_QueryW(self, wait):
        return True

    def Everything_GetLastError(self):
        return 0


class IpcReadyLogicTests(unittest.TestCase):
    """is_everything_ipc_ready 的分支逻辑（注入 fake DLL，跨平台可跑）。"""

    def _dll(self, query_ok, last_error, db_loaded=True):
        dll = mock.Mock()
        dll.Everything_SetSearchW.return_value = None
        dll.Everything_QueryW.return_value = query_ok
        dll.Everything_IsDBLoaded.return_value = db_loaded
        dll.Everything_GetLastError.return_value = last_error
        return dll

    def _probe(self, dll):
        with mock.patch.object(sdk, "load_everything_sdk", return_value=dll):
            return is_everything_ipc_ready("C:\\fake\\Everything64.dll")

    def test_ready_when_query_ok(self):
        """查询成功即就绪。"""
        self.assertTrue(self._probe(self._dll(True, EVERYTHING_ERROR_IPC)))

    def test_ready_when_failure_not_ipc(self):
        """查询失败但错误非 IPC（如内存不足）仍视为可用。"""
        self.assertTrue(self._probe(self._dll(False, EVERYTHING_ERROR_MEMORY)))

    def test_not_ready_when_ipc_error(self):
        """查询失败且错误为 IPC 未连接 → 不可用。"""
        self.assertFalse(self._probe(self._dll(False, EVERYTHING_ERROR_IPC)))

    def test_not_ready_when_db_not_loaded(self):
        """数据库未加载完成 → 不可用（即使查询成功）。"""
        self.assertFalse(self._probe(self._dll(True, 0, db_loaded=False)))

    def test_missing_isdbloaded_treated_as_loaded(self):
        """DLL 无 Everything_IsDBLoaded 符号时按已加载处理（AttributeError 兜底）。"""
        self.assertTrue(self._probe(_NoIsDbLoadedDll()))

    def test_load_failure_returns_false(self):
        """加载 DLL 失败（如路径无效）返回 False 而不抛异常。"""
        with mock.patch.object(sdk, "load_everything_sdk", side_effect=OSError("load failed")):
            self.assertFalse(is_everything_ipc_ready("C:\\nope\\Everything64.dll"))


class QueryReadyPureTests(unittest.TestCase):
    """is_everything_query_ready / is_everything_ready 纯函数分支。"""

    def test_query_ready_pure(self):
        """查询成功，或失败原因非 IPC 时为 True。"""
        self.assertTrue(is_everything_query_ready(True, EVERYTHING_ERROR_IPC))
        self.assertTrue(is_everything_query_ready(False, EVERYTHING_ERROR_MEMORY))
        self.assertFalse(is_everything_query_ready(False, EVERYTHING_ERROR_IPC))

    def test_everything_ready_pure(self):
        """IPC 可用且数据库已加载才为 True。"""
        self.assertTrue(is_everything_ready(True, 0, True))
        self.assertFalse(is_everything_ready(True, 0, False))
        self.assertFalse(is_everything_ready(False, EVERYTHING_ERROR_IPC, True))
        self.assertTrue(is_everything_ready(False, EVERYTHING_ERROR_MEMORY, True))


@unittest.skipUnless(os.name == "nt", "真实 IPC/数据库检查仅 Windows 成立")
class IpcReadyRealTests(unittest.TestCase):
    """真实 Everything IPC 检查：Everything 进程未运行时跳过。"""

    def test_real_ipc_ready_returns_bool(self):
        """对真实 DLL 执行 IPC 探测，结果必须是 bool（不崩溃、不阻塞扫描）。"""
        try:
            with mock.patch.object(sdk, "log"):  # 日志含 emoji，GBK 控制台会编码失败
                dll_path = sdk.resolve_everything_dll()
        except FileNotFoundError:
            self.skipTest("SDK DLL 不存在，无法真实验证 IPC")
        import env
        if not env.is_everything_process_running():
            self.skipTest("Everything 进程未运行，跳过真实 IPC 检查")
        sdk._load_everything_sdk_cached.cache_clear()
        self.assertIsInstance(sdk.is_everything_ipc_ready(dll_path), bool)


@unittest.skipUnless(os.name == "nt", "ctypes.WinDLL 仅 Windows 存在")
class LoadSDKCacheTests(unittest.TestCase):
    """load_everything_sdk 的 lru 缓存：str/Path 归一化共享同一缓存条目。"""

    def setUp(self):
        sdk._load_everything_sdk_cached.cache_clear()
        self._dll_fake = mock.Mock()
        self._win_dll = mock.patch.object(
            sdk.ctypes, "WinDLL", return_value=self._dll_fake,
        )
        self._win_dll.start()
        self.addCleanup(self._win_dll.stop)
        self.addCleanup(sdk._load_everything_sdk_cached.cache_clear)

    def test_str_and_path_share_cache_entry(self):
        """同一文件的 str 与 Path 形式命中同一缓存条目（只加载一次）。"""
        first = load_everything_sdk("C:\\a\\Everything64.dll")
        again = load_everything_sdk(Path("C:\\a\\Everything64.dll"))
        self.assertIs(first, again, "str/Path 归一化后应共享缓存")
        self.assertEqual(sdk.ctypes.WinDLL.call_count, 1)

    def test_include_result_functions_is_separate_key(self):
        """include_result_functions 不同构成不同缓存键。"""
        load_everything_sdk("C:\\a\\Everything64.dll")
        load_everything_sdk("C:\\a\\Everything64.dll", include_result_functions=True)
        self.assertEqual(sdk.ctypes.WinDLL.call_count, 2)

    def test_different_paths_are_separate(self):
        """不同路径各占一个缓存条目。"""
        load_everything_sdk("C:\\a\\Everything64.dll")
        load_everything_sdk("C:\\b\\Everything64.dll")
        self.assertEqual(sdk.ctypes.WinDLL.call_count, 2)

    def test_configure_applied_to_loaded_dll(self):
        """加载后按 include_result_functions 完成了函数签名配置。"""
        dll = load_everything_sdk("C:\\a\\Everything64.dll", include_result_functions=True)
        self.assertIsNotNone(dll.Everything_SetRequestFlags.argtypes)
        self.assertEqual(dll.Everything_SetRequestFlags.restype, None)
        self.assertEqual(dll.Everything_GetResultFullPathNameW.argtypes[0], sdk.DWORD)
        minimal = load_everything_sdk("C:\\a\\Everything64.dll")
        self.assertIsNotNone(minimal.Everything_SetSearchW.argtypes)


if __name__ == "__main__":
    unittest.main()