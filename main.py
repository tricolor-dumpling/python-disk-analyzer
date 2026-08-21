"""程序入口与兼容层（C3 拆分 main.py 后保留的骨架）。

1. 入口：python main.py 直接运行（调用 cli.main(sys.argv[1:])；无参数时流程与
   拆分前逐字一致，提供 target 时进入非交互 Top-N 报告模式，--quiet 可抑制该
   模式下的过程日志与进度行，仅保留报告与错误；stdout/stderr 在 main 最早处
   被重配置为 UTF-8，GBK 控制台/管道下中文与 emoji 输出不抛编码异常）；
2. 兼容层：此前各任务/审查测试脚本均按「import main 后访问 main.<名字>」的
   方式使用全部公共/下划线 API（main.human_size/main._dir_sort_key/
   main.LazyContents/main.ensure_everything_running/main.interactive_ui/
   main.MsvcrtUnavailableError 等），这里把拆到 utils/sdk/env/scan/tui/exceptions
   里的所有顶层名字全量导回 main 命名空间，保证 import main 的可用名字集合
   与拆分前完全一致；
3. 可变全局与补丁敏感函数动态转发：DLL_PATH/VERBOSE/_ANSI_AVAILABLE/
   _GLOBAL_JOB_HANDLE/_getch/msvcrt/winreg，以及 env 装配层在函数体内从模块
   全局查找的 resolve_everything_dll/find_everything_exe/load_config/
   save_config/wait_for_everything_ipc/bind_pid_to_job_sandbox，采用自定义
   模块类型（__getattr__/__setattr__/__dir__）动态转发到其归属模块，而不是
   from-import 拷贝——拷贝会在赋值后断掉共享（例如 main._getch = 桩 必须
   真正落到 tui._getch 才会被 interactive_ui 读到；main.resolve_everything_dll
   = 桩 必须落到 env 才会被 ensure_everything_running 读到）。完整归属关系见
   下方 _LIVE_FORWARD 表。
"""

import os  # noqa: F401  # 兼容性保留：拆分前 import main 的顶层命名空间含这些标准库名字
import sys  # noqa: F401
import shutil  # noqa: F401
import ctypes  # noqa: F401
import functools  # noqa: F401
import subprocess  # noqa: F401
import time  # noqa: F401
import gc  # noqa: F401
import platform  # noqa: F401
import re  # noqa: F401
import json  # noqa: F401
import heapq  # noqa: F401
import types  # 用于自定义模块类型（可变全局动态转发）
from pathlib import Path  # noqa: F401
from collections import defaultdict  # noqa: F401

# =================【入口】=================
# cli 是装配层，不反向依赖 main（main → cli 单向）；此处先导入保证入口可用。
from cli import main, prompt_target_drive  # noqa: F401,E402

# =================【兼容性 re-export（静态拷贝）】=================
# 以下名字在拆分前后都不会被重新赋值，直接 from-import 拷贝即可保持等价。
from exceptions import MsvcrtUnavailableError, EverythingEnvironmentError  # noqa: F401
from utils import (  # noqa: F401
    APP_NAME,
    CONFIG_PATH,
    SCRIPT_DIR,
    _exit_with_error,
    _fatal,
    get_app_dir,
    human_size,
    log,
)
from sdk import (  # noqa: F401
    BOOL,
    DWORD,
    ENABLE_VIRTUAL_TERMINAL_PROCESSING,
    EVERYTHING_ERROR_IPC,
    EVERYTHING_ERROR_MEMORY,
    EVERYTHING_REQUEST_FILE_NAME,
    EVERYTHING_REQUEST_FULL_PATH_AND_FILE_NAME,
    EVERYTHING_REQUEST_PATH,
    EVERYTHING_REQUEST_SIZE,
    FULL_PATH_BUFFER_CHARS,
    INVALID_HANDLE_VALUE,
    JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    PROCESS_SET_QUOTA,
    PROCESS_TERMINATE,
    STD_OUTPUT_HANDLE,
    TH32CS_SNAPPROCESS,
    _everything_dll_name,
    _is_path_inside,
    _load_everything_sdk_cached,
    _valid_file_from_config,
    configure_everything_sdk,
    is_everything_ipc_ready,
    is_everything_query_ready,
    is_everything_ready,
    load_everything_sdk,
)
from env import (  # noqa: F401
    DEFAULT_EVERYTHING_STARTUP_ARGS,
    DEFAULT_EVERYTHING_STARTUP_TIMEOUT_SECONDS,
    _expand_everything_exe_candidates,
    _normalize_startup_args,
    _registry_everything_locations,
    ensure_everything_running,
    get_current_session_id,
    get_process_session_id,
    init_windows_job_sandbox,
    is_everything_process_running,
    is_everything_process_running_legacy,
    iter_process_ids_by_name,
    list_everything_process_sessions,
)
from scan import (  # noqa: F401
    MAX_FILES_PER_DIR,
    SCAN_PROGRESS_REFRESH_INTERVAL,
    LazyContents,
    _build_lazy_contents,
    _dir_sort_key,
    _is_scan_root,
    scan_via_everything_sdk,
)
from tui import (  # noqa: F401
    ANSI_CLEAR_SCREEN,
    ANSI_HIDE_CURSOR,
    ANSI_SHOW_CURSOR,
    _clear_screen,
    _enable_vt_processing,
    _hide_cursor,
    _interactive_ui_loop,
    _show_cursor,
    _write_ansi,
    interactive_ui,
)

# =================【可变全局与补丁敏感函数的动态转发】=================
# 前一类（DLL_PATH/VERBOSE/_ANSI_AVAILABLE/_GLOBAL_JOB_HANDLE/_getch/msvcrt/
# winreg）是“运行时会被读写或桩替换”的模块全局；后一类（env 装配层在函数体内
# 从模块全局查找的 resolver/finder/io 函数）在拆分前都在 main 命名空间，旧测试
# 通过 main.<函数> = 桩 注入。这里统一采用自定义模块类型（__getattr__/
# __setattr__/__dir__）动态转发到其归属模块，而不是 from-import 拷贝——拷贝会在
# 赋值后断掉共享（例如 main._getch = 桩 必须真正落到 tui._getch 才会被
# interactive_ui 读到；main.resolve_everything_dll = 桩 必须落到 env 才会被
# ensure_everything_running 读到）。归属关系：
# DLL_PATH→sdk、VERBOSE→utils、_ANSI_AVAILABLE→tui、_GLOBAL_JOB_HANDLE→env、
# _getch/msvcrt→tui、winreg→env、resolve_everything_dll/find_everything_exe/
# load_config/save_config/wait_for_everything_ipc/bind_pid_to_job_sandbox→env。
_LIVE_FORWARD = {
    "DLL_PATH": ("sdk", "DLL_PATH"),
    "VERBOSE": ("utils", "VERBOSE"),
    "_ANSI_AVAILABLE": ("tui", "_ANSI_AVAILABLE"),
    "_GLOBAL_JOB_HANDLE": ("env", "_GLOBAL_JOB_HANDLE"),
    "_getch": ("tui", "_getch"),
    "msvcrt": ("tui", "msvcrt"),
    "winreg": ("env", "winreg"),
    "resolve_everything_dll": ("env", "resolve_everything_dll"),
    "find_everything_exe": ("env", "find_everything_exe"),
    "load_config": ("env", "load_config"),
    "save_config": ("env", "save_config"),
    "wait_for_everything_ipc": ("env", "wait_for_everything_ipc"),
    "bind_pid_to_job_sandbox": ("env", "bind_pid_to_job_sandbox"),
}


class _MainModule(types.ModuleType):
    """main 模块的自定义类型：把上表可变全局动态转发到归属模块。

    - main.DLL_PATH 读取 ⇒ sdk.DLL_PATH 当前值（ensure_everything_running 回填
      后立即可见，不会读到导入时的旧拷贝）；
    - main.DLL_PATH = 路径 ⇒ 写入 sdk.DLL_PATH（scan/ensure 读到的就是它）；
    - main._getch = 桩 ⇒ 写入 tui._getch（interactive_ui 内部从 tui 命名空间
      调用 _getch，桩立即生效）；
    - dir(main) 同样包含这些名字，保证旧测试的“名字可用”检查不受影响。
    """

    def __getattr__(self, name):
        if name in _LIVE_FORWARD:
            mod_name, attr = _LIVE_FORWARD[name]
            return getattr(sys.modules[mod_name], attr)
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")

    def __setattr__(self, name, value):
        if name in _LIVE_FORWARD:
            mod_name, attr = _LIVE_FORWARD[name]
            setattr(sys.modules[mod_name], attr, value)
            return
        super().__setattr__(name, value)

    def __dir__(self):
        return sorted(set(super().__dir__()) | set(_LIVE_FORWARD))


# 将当前模块实例的类型替换为 _MainModule（types.ModuleType 的直接子类，
# 实例布局兼容，CPython 支持模块实例的 __class__ 替换）。
sys.modules[__name__].__class__ = _MainModule


if __name__ == "__main__":
    main(sys.argv[1:])