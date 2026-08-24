"""env 模块单元测试：启动参数规范化 / 配置 IO / Everything.exe 定位 / 启动流程。

- _normalize_startup_args：脏数据回退与副本语义；
- load_config/save_config：回读一致、损坏/非 dict/缺失/目录等异常输入；
- find_everything_exe：临时目录放假 exe 的基本路径与 config 缓存优先；
- ensure_everything_running：注入 is_running/is_ipc_ready/popen/sleep 与假时钟，
  覆盖 4 个致命场景（严禁真实启动 Everything.exe）与成功路径（写回配置/去重）。

全程不触碰真实 config.json（config_path 一律注入临时目录）。
"""

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import env
import sdk
from env import (
    DEFAULT_EVERYTHING_STARTUP_ARGS,
    _normalize_startup_args,
    ensure_everything_running,
    find_everything_exe,
    load_config,
    save_config,
)
from exceptions import EverythingEnvironmentError


class _StubClock:
    """确定性假时钟：monotonic 读自身累计值，sleep 推进它（杜绝真实等待）。"""

    def __init__(self):
        self.t = 0.0

    def monotonic(self):
        return self.t

    def sleep(self, seconds):
        self.t += seconds


class NormalizeStartupArgsTests(unittest.TestCase):
    """_normalize_startup_args：只接受非空且全为 str 的 list，其余回退默认值。"""

    def test_none_falls_back_to_default(self):
        """None（config 缺失该键）回退默认 ["-startup"]。"""
        self.assertEqual(_normalize_startup_args(None), list(DEFAULT_EVERYTHING_STARTUP_ARGS))

    def test_non_list_string_falls_back(self):
        """字符串等非 list 脏数据回退默认。"""
        self.assertEqual(_normalize_startup_args("startup"), list(DEFAULT_EVERYTHING_STARTUP_ARGS))
        self.assertEqual(_normalize_startup_args(42), list(DEFAULT_EVERYTHING_STARTUP_ARGS))

    def test_empty_list_falls_back(self):
        """空列表回退默认（避免启动命令为纯 exe）。"""
        self.assertEqual(_normalize_startup_args([]), list(DEFAULT_EVERYTHING_STARTUP_ARGS))

    def test_list_with_non_str_falls_back(self):
        """含非字符串元素（如数字）回退默认。"""
        self.assertEqual(
            _normalize_startup_args(["-startup", 3]),
            list(DEFAULT_EVERYTHING_STARTUP_ARGS),
        )

    def test_valid_list_returns_copy(self):
        """合法列表原样返回且为新副本，不共享引用（改返回值不影响入参）。"""
        raw = ["-startup", "/min"]
        result = _normalize_startup_args(raw)
        self.assertEqual(result, ["-startup", "/min"])
        self.assertIsNot(result, raw)
        result.append("/extra")
        self.assertEqual(raw, ["-startup", "/min"])

    def test_default_is_fresh_list_each_call(self):
        """每次回退都返回全新默认列表，互不共享。"""
        a = _normalize_startup_args(None)
        b = _normalize_startup_args("junk")
        self.assertEqual(a, b)
        self.assertIsNot(a, b)


class ConfigIOTests(unittest.TestCase):
    """load_config/save_config：回读一致与各类异常输入（一律临时路径）。"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.config_path = Path(self._tmp.name) / "config.json"

    def test_save_load_roundtrip(self):
        """保存后回读一致（含嵌套 dict/数字/中文）。"""
        data = {"everything_exe": "D:\\Everything\\Everything.exe", "nested": {"a": 1}}
        self.assertTrue(save_config(data, self.config_path))
        self.assertEqual(load_config(self.config_path), data)

    def test_save_unicode_preserved(self):
        """ensure_ascii=False：中文以 UTF-8 原文落盘。"""
        save_config({"名字": "磁盘工具"}, self.config_path)
        text = self.config_path.read_text(encoding="utf-8")
        self.assertIn("磁盘工具", text)

    def test_load_missing_file_returns_empty(self):
        """缺失文件返回 {}。"""
        self.assertEqual(load_config(self.config_path), {})

    def test_load_corrupt_json_returns_empty(self):
        """损坏 JSON 返回 {} 而不抛异常。"""
        self.config_path.write_text("{not json!!!", encoding="utf-8")
        self.assertEqual(load_config(self.config_path), {})

    def test_load_non_dict_json_returns_empty(self):
        """合法但非 dict 的 JSON（列表/数字/字符串）返回 {}。"""
        for payload in ("[1, 2, 3]", "42", '"text"'):
            self.config_path.write_text(payload, encoding="utf-8")
            self.assertEqual(load_config(self.config_path), {}, msg=f"payload={payload}")

    def test_load_empty_file_returns_empty(self):
        """空文件（JSONDecodeError）返回 {}。"""
        self.config_path.write_text("", encoding="utf-8")
        self.assertEqual(load_config(self.config_path), {})

    def test_load_directory_as_path_returns_empty(self):
        """config_path 指向目录时读失败（OSError）返回 {}。"""
        self.assertEqual(load_config(Path(self._tmp.name)), {})

    def test_save_creates_parent_dirs(self):
        """save_config 自动创建缺失的父目录。"""
        deep = Path(self._tmp.name) / "a" / "b" / "config.json"
        self.assertTrue(save_config({"x": 1}, deep))
        self.assertEqual(load_config(deep), {"x": 1})

    def test_save_fails_cleanly_when_parent_blocked(self):
        """父路径被普通文件占据时保存失败返回 False（不影响主流程）。"""
        blocker = Path(self._tmp.name) / "blocker"
        blocker.write_text("i am a file", encoding="utf-8")
        self.assertFalse(save_config({"x": 1}, blocker / "config.json"))


class ConfigMigrationTests(unittest.TestCase):
    """Phase 0：config.json 默认读写迁到数据目录，项目目录文件仅作首次模板。"""

    def test_save_load_default_uses_data_dir(self):
        """无 config_path 参数的 save_config/load_config 读写数据目录 config.json。"""
        with tempfile.TemporaryDirectory() as tmp:
            local = Path(tmp) / "local"
            data_config = local / "PythonDiskScanner" / "config.json"
            with mock.patch.dict(os.environ, {"LOCALAPPDATA": str(local)}):
                self.assertTrue(save_config({"x": 1}))
                self.assertEqual(load_config(), {"x": 1})
            self.assertTrue(data_config.exists())

    def test_load_default_falls_back_to_project_template(self):
        """数据目录 config 缺失时，load_config() 回退读取项目目录模板。"""
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp) / "project"
            project.mkdir()
            (project / "config.json").write_text(
                json.dumps({"everything_exe": "D:\\Everything\\Everything.exe"}, ensure_ascii=False),
                encoding="utf-8",
            )
            local = Path(tmp) / "local"
            with mock.patch.dict(os.environ, {"LOCALAPPDATA": str(local)}), mock.patch.object(
                env, "SCRIPT_DIR", project
            ):
                self.assertEqual(
                    load_config(),
                    {"everything_exe": "D:\\Everything\\Everything.exe"},
                )
            # 绝不回写项目模板
            self.assertTrue((project / "config.json").exists())
            self.assertFalse((local / "PythonDiskScanner" / "config.json").exists())

    def test_load_default_returns_empty_when_both_missing(self):
        """数据目录与项目模板都缺失时，load_config() 返回空配置。"""
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp) / "project"
            project.mkdir()
            local = Path(tmp) / "local"
            with mock.patch.dict(os.environ, {"LOCALAPPDATA": str(local)}), mock.patch.object(
                env, "SCRIPT_DIR", project
            ):
                self.assertEqual(load_config(), {})


class FindEverythingExeTests(unittest.TestCase):
    """find_everything_exe：临时目录放假 exe 验证基本路径与 config 缓存优先。"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tmp = Path(self._tmp.name)
        # 环境 log 含 emoji，GBK 控制台下 print 会抛 UnicodeEncodeError；打桩消除
        log_patcher = mock.patch.object(env, "log")
        log_patcher.start()
        self.addCleanup(log_patcher.stop)

    def test_found_in_script_dir(self):
        """exe 放在 script_dir 下时直接命中（默认候选）。"""
        exe = self.tmp / "Everything.exe"
        exe.write_bytes(b"MZ")
        self.assertEqual(
            find_everything_exe(script_dir=self.tmp, registry_install_locations=[], path_dirs=[]),
            exe,
        )

    def test_found_via_registry_location(self):
        """注册表位置（带引号的完整 exe 路径）命中。"""
        exe = self.tmp / "inst" / "Everything.exe"
        exe.parent.mkdir(parents=True)
        exe.write_bytes(b"MZ")
        locations = [f'"{exe}"']
        result = find_everything_exe(
            script_dir=self.tmp, registry_install_locations=locations, path_dirs=[],
        )
        self.assertEqual(result, exe)

    def test_found_via_path_dir(self):
        """PATH 目录（目录值自动拼接 Everything.exe）命中。"""
        dir_path = self.tmp / "bin"
        dir_path.mkdir()
        exe = dir_path / "Everything.exe"
        exe.write_bytes(b"MZ")
        self.assertEqual(
            find_everything_exe(script_dir=self.tmp, registry_install_locations=[], path_dirs=[str(dir_path)]),
            exe,
        )

    def test_config_cache_priority(self):
        """config 中的 everything_exe 存在时优先于 script_dir 默认候选。"""
        cached = self.tmp / "cached" / "Everything.exe"
        cached.parent.mkdir()
        cached.write_bytes(b"MZ")
        script_exe = self.tmp / "Everything.exe"
        script_exe.write_bytes(b"MZ")
        result = find_everything_exe(
            script_dir=self.tmp,
            registry_install_locations=[],
            path_dirs=[],
            config={"everything_exe": str(cached)},
        )
        self.assertEqual(result, cached)

    def test_config_nonexistent_path_ignored(self):
        """config 指定的缓存路径不存在时忽略并回退到默认候选。"""
        script_exe = self.tmp / "Everything.exe"
        script_exe.write_bytes(b"MZ")
        result = find_everything_exe(
            script_dir=self.tmp,
            registry_install_locations=[],
            path_dirs=[],
            config={"everything_exe": str(self.tmp / "missing" / "Everything.exe")},
        )
        self.assertEqual(result, script_exe)

    @unittest.skipUnless(os.name == "nt", "os.path.expandvars 的 %VAR% 语法仅 Windows 展开")
    def test_config_env_var_expansion(self):
        """config 中的 %TEMP% 等环境变量得到展开（_valid_file_from_config）。"""
        exe = Path(tempfile.gettempdir()) / "Everything.exe"
        try:
            exe.write_bytes(b"MZ")
        except OSError:
            self.skipTest("无法在临时目录写入 Everything.exe")
        self.addCleanup(lambda: exe.unlink(missing_ok=True))
        result = find_everything_exe(
            script_dir=self.tmp,
            registry_install_locations=[],
            path_dirs=[],
            config={"everything_exe": "%TEMP%\\Everything.exe"},
        )
        self.assertEqual(result, exe)

    def test_not_found_returns_none(self):
        """所有候选都不存在时返回 None（ProgramFiles 默认目录也被架空）。"""
        empty = Path(self._tmp.name) / "empty"
        empty.mkdir()
        fake_environ = {"ProgramFiles": str(empty), "ProgramFiles(x86)": str(empty)}
        with mock.patch.dict(os.environ, fake_environ):
            result = find_everything_exe(
                script_dir=self.tmp, registry_install_locations=[], path_dirs=[],
            )
        self.assertIsNone(result)


class EnsureEverythingRunningTests(unittest.TestCase):
    """ensure_everything_running：4 个致命场景 + 成功路径，全程注入假实现。"""

    DLL = "C:\\fake\\Everything64.dll"
    EXE = "C:\\Everything\\Everything.exe"

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.config_path = Path(self._tmp.name) / "config.json"
        # 记录调用前 sdk.DLL_PATH 并在结束后恢复，避免测试互相污染
        self.addCleanup(setattr, sdk, "DLL_PATH", sdk.DLL_PATH)
        # 环境 log 含 emoji，GBK 控制台下 print 会抛 UnicodeEncodeError；打桩消除
        log_patcher = mock.patch.object(env, "log")
        log_patcher.start()
        self.addCleanup(log_patcher.stop)

    def _run(self, **kwargs):
        """以假时钟 + 假进程替身运行 ensure_everything_running。

        返回 (outcome, popen, clock)：outcome 为返回值（成功）或
        EverythingEnvironmentError 实例（致命路径），供测试统一断言。
        """
        clock = _StubClock()
        proc = SimpleNamespace(pid=31415)
        popen = mock.Mock(return_value=proc)
        defaults = dict(
            dll_path=self.DLL,
            config_path=self.config_path,
            popen=popen,
            sleep=clock.sleep,
            timeout_seconds=0.2,
        )
        defaults.update(kwargs)
        try:
            with mock.patch.object(env, "time", clock):
                outcome = ensure_everything_running(**defaults)
        except EverythingEnvironmentError as e:
            outcome = e
        return outcome, popen, clock

    def test_fatal_dll_resolve_failure(self):
        """致命 1：DLL 解析失败（FileNotFoundError）→ EverythingEnvironmentError，中文带 错误： 前缀。"""
        with mock.patch.object(env, "resolve_everything_dll", side_effect=FileNotFoundError("未找到匹配当前 Python 架构的 Everything SDK DLL")):
            outcome, popen, _ = self._run(dll_path=None)
        popen.assert_not_called()
        self.assertIn("错误：", str(outcome))
        self.assertIn("未找到匹配", str(outcome))
        self._assert_environment_error(outcome)

    def test_fatal_running_but_ipc_timeout(self):
        """致命 2：进程在运行但 IPC/数据库等待超时 → 抛「已运行，但 IPC…不可用」。"""
        outcome, popen, _ = self._run(
            is_running=lambda: True,
            is_ipc_ready=lambda dll: False,
            timeout_seconds=0.2,
        )
        # 不应走到启动分支：popen 必须从未被调用
        popen.assert_not_called()
        self._assert_environment_error(outcome, "已运行，但 IPC/数据库在等待超时后仍不可用")

    def test_fatal_exe_not_found(self):
        """致命 3：未运行且找不到 Everything.exe → 抛「无法定位 Everything.exe」。"""
        with mock.patch.object(env, "find_everything_exe", return_value=None):
            outcome, popen, _ = self._run(
                is_running=lambda: False,
                is_ipc_ready=lambda dll: False,
                exe_path=None,
            )
        popen.assert_not_called()
        self._assert_environment_error(outcome, "无法定位 Everything.exe")

    def test_fatal_launched_but_ipc_timeout(self):
        """致命 4：启动后 IPC 仍不可用 → 抛「已启动，但 SDK IPC/数据库…不可用」，且启动参数去重（默认 vs 默认）。"""
        outcome, popen, _ = self._run(
            is_running=lambda: False,
            is_ipc_ready=lambda dll: False,
            exe_path=self.EXE,
        )
        popen.assert_called()
        commands = [c[0][0] for c in popen.call_args_list]
        self.assertEqual(commands, [[self.EXE, "-startup"], [self.EXE]], "默认参数重复命令应去重")
        for c in popen.call_args_list:
            self.assertEqual(c[1]["stdout"], subprocess.DEVNULL)
            self.assertEqual(c[1]["stderr"], subprocess.DEVNULL)
        self._assert_environment_error(outcome, "已启动，但 SDK IPC/数据库在等待超时后仍不可用")

    def test_launch_args_dedup_with_custom_config(self):
        """自定义启动参数与默认参数、无参数按序去重：恰好 3 次启动尝试。"""
        startup_json = {"everything_startup_args": ["-startup", "/min"]}
        self.config_path.write_text(json.dumps(startup_json, ensure_ascii=False), encoding="utf-8")
        outcome, popen, _ = self._run(
            is_running=lambda: False,
            is_ipc_ready=lambda dll: False,
            exe_path=self.EXE,
        )
        commands = [c[0][0] for c in popen.call_args_list]
        self.assertEqual(
            commands,
            [[self.EXE, "-startup", "/min"], [self.EXE, "-startup"], [self.EXE]],
        )
        self._assert_environment_error(outcome, "已启动，但 SDK IPC/数据库在等待超时后仍不可用")

    def test_success_running_and_ready_first_try(self):
        """成功 1：进程在运行且 IPC 立即可用 → True，不启动、不写配置。"""
        outcome, popen, _ = self._run(
            is_running=lambda: True,
            is_ipc_ready=lambda dll: True,
        )
        popen.assert_not_called()
        self.assertIs(outcome, True)
        self.assertFalse(self.config_path.exists(), "运行就绪路径不应回写配置")
        self.assertEqual(sdk.DLL_PATH, Path(self.DLL))

    def test_success_running_then_ipc_ready(self):
        """成功 2：进程在运行但 IPC 稍后可用（等待生效）→ True。"""
        ready_seq = iter([False, True])
        outcome, popen, clock = self._run(
            is_running=lambda: True,
            is_ipc_ready=lambda dll: next(ready_seq),
            timeout_seconds=10,
        )
        popen.assert_not_called()
        self.assertIs(outcome, True)
        self.assertEqual(clock.t, 0.5, "等待循环应调用一次 sleep(0.5) 后成功")

    def test_success_launch_and_config_writeback(self):
        """成功 3：未运行 → 启动成功且 IPC 就绪：返回 True、回写全部配置、参数去重。"""
        ready_seq = iter([False, True])
        outcome, popen, clock = self._run(
            is_running=lambda: False,
            is_ipc_ready=lambda dll: next(ready_seq),
            exe_path=self.EXE,
            timeout_seconds=10,
        )
        self.assertIs(outcome, True)
        popen.assert_called_once()
        self.assertEqual(popen.call_args[0][0], [self.EXE, "-startup"])
        # 配置回写：exe/dll/启动参数三项齐全
        written = json.loads(self.config_path.read_text(encoding="utf-8"))
        self.assertEqual(written["everything_exe"], self.EXE)
        self.assertEqual(written["everything_dll"], str(Path(self.DLL)))
        self.assertEqual(written["everything_startup_args"], ["-startup"])
        self.assertEqual(sdk.DLL_PATH, Path(self.DLL))

    def _assert_environment_error(self, outcome, keyword=None):
        """断言 outcome 为 EverythingEnvironmentError 且（可选）含中文关键词。"""
        self.assertIsInstance(outcome, EverythingEnvironmentError)
        if keyword is not None:
            self.assertIn(keyword, str(outcome))


if __name__ == "__main__":
    unittest.main()