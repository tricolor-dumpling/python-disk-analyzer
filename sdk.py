"""Everything SDK 封装与 Win32 常量模块（C3 拆分自 main.py）。

职责：
- 全部 Win32 常量（BOOL/DWORD、作业对象 JOB_*、进程访问 PROCESS_*、
  控制台 STD_OUTPUT_HANDLE/ENABLE_VIRTUAL_TERMINAL_PROCESSING、
  Toolhelp 快照 TH32CS_SNAPPROCESS、INVALID_HANDLE_VALUE）；
- Everything SDK 常量（EVERYTHING_REQUEST_* / EVERYTHING_ERROR_* / FULL_PATH_BUFFER_CHARS）；
- SDK DLL 架构选择与配置缓存解析（_everything_dll_name/resolve_everything_dll/
  _valid_file_from_config/_is_path_inside）；
- SDK 加载/函数签名声明与 IPC 健康检查（load_everything_sdk/
  _load_everything_sdk_cached/configure_everything_sdk/is_everything_ipc_ready/
  is_everything_query_ready/is_everything_ready）。

DLL_PATH 模块级可变全局保存在本模块：env.ensure_everything_running 与
scan.scan_via_everything_sdk 均通过「sdk.DLL_PATH」读写（不要 from x import 后
再赋值，那会断掉跨模块共享）。依赖方向：本模块只依赖 utils（SCRIPT_DIR/log）。
"""

import ctypes
import functools
import os
import platform
from pathlib import Path

from utils import SCRIPT_DIR, log

BOOL = ctypes.c_int
DWORD = ctypes.c_uint32
# Windows API (Win32) 常量：作业对象限额、进程访问权限、控制台与 Toolhelp 快照
JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000  # 作业对象关闭时强制终止其全部子进程（防孤儿）
JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9  # SetInformationJobObject 的扩展限额信息类
PROCESS_SET_QUOTA = 0x0100  # 进程访问权限：允许设置进程内存配额
PROCESS_TERMINATE = 0x0001  # 进程访问权限：允许终止进程
STD_OUTPUT_HANDLE = -11  # GetStdHandle：标准输出句柄标识
ENABLE_VIRTUAL_TERMINAL_PROCESSING = 0x0004  # 控制台模式：启用 ANSI/VT 转义序列
TH32CS_SNAPPROCESS = 0x00000002  # Toolhelp 快照标志：枚举系统进程
INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value  # 无效句柄哨兵值

# Everything SDK Win32 常量
EVERYTHING_REQUEST_FILE_NAME = 0x00000001
EVERYTHING_REQUEST_PATH = 0x00000002
EVERYTHING_REQUEST_SIZE = 0x00000010
EVERYTHING_ERROR_MEMORY = 1
EVERYTHING_ERROR_IPC = 2
EVERYTHING_REQUEST_FULL_PATH_AND_FILE_NAME = 0x00000004
# Everything_GetResultFullPathNameW 的结果路径缓冲区字符数（含结尾 \0）
FULL_PATH_BUFFER_CHARS = 32768

# 当前解析出的 Everything SDK DLL 路径（模块级全局）。
# 由 env.ensure_everything_running 在启动检查时回填；scan.scan_via_everything_sdk
# 在未回填时自行解析。外部（测试/嵌入）读写一律走 sdk.DLL_PATH。
DLL_PATH = None


def _is_path_inside(path, base_dir):
    try:
        path.resolve().relative_to(Path(base_dir).resolve())
        return True
    except (OSError, ValueError):
        return False


def _valid_file_from_config(config, key, base_dir=None):
    """只接受真实存在的缓存路径，避免错误 JSON 卡死启动流程。"""
    value = config.get(key) if isinstance(config, dict) else None
    if not value:
        return None
    try:
        path = Path(os.path.expandvars(str(value))).expanduser()
        if path.exists():
            if base_dir is not None and not _is_path_inside(path, base_dir):
                return None
            return path
    except OSError:
        return None
    return None


def _everything_dll_name(machine=None, pointer_bits=None):
    machine = (machine or platform.machine() or "").upper()
    pointer_bits = pointer_bits or (ctypes.sizeof(ctypes.c_void_p) * 8)
    if "ARM" in machine:
        return "EverythingARM64.dll" if pointer_bits == 64 else "EverythingARM.dll"
    return "Everything64.dll" if pointer_bits == 64 else "Everything32.dll"


def resolve_everything_dll(script_dir=SCRIPT_DIR, machine=None, pointer_bits=None, config=None):
    """根据当前 Python 进程架构自动选择 Everything SDK DLL。"""
    script_dir = Path(script_dir)
    config_dll = _valid_file_from_config(config or {}, "everything_dll", base_dir=script_dir)
    if config_dll:
        log(f"ℹ️ 使用配置缓存中的 SDK DLL: {config_dll}")
        return config_dll

    dll_name = _everything_dll_name(machine, pointer_bits)
    log(f"🔎 正在按 Python 架构选择 Everything SDK DLL: {dll_name}")
    candidates = [
        script_dir / "everything-SDK" / "dll" / dll_name,
        script_dir / dll_name,
    ]
    for candidate in candidates:
        if candidate.exists():
            return candidate
    searched = "\n  - ".join(str(p) for p in candidates)
    raise FileNotFoundError(f"未找到匹配当前 Python 架构的 Everything SDK DLL：{dll_name}\n已检查：\n  - {searched}")


def configure_everything_sdk(everything, include_result_functions=False):
    """集中声明 Everything SDK 函数签名，避免扫描和健康检查各自维护一份。"""
    everything.Everything_SetSearchW.argtypes = [ctypes.c_wchar_p]
    everything.Everything_SetSearchW.restype = None

    everything.Everything_QueryW.argtypes = [BOOL]
    everything.Everything_QueryW.restype = BOOL

    everything.Everything_GetLastError.restype = DWORD

    try:
        everything.Everything_IsDBLoaded.restype = BOOL
    except AttributeError:
        pass

    if not include_result_functions:
        return everything

    everything.Everything_SetRequestFlags.argtypes = [DWORD]
    everything.Everything_SetRequestFlags.restype = None
    everything.Everything_GetNumResults.restype = DWORD
    everything.Everything_GetResultFullPathNameW.argtypes = [
        DWORD,
        ctypes.c_wchar_p,
        DWORD,
    ]
    everything.Everything_GetResultFullPathNameW.restype = DWORD
    everything.Everything_GetResultSize.argtypes = [
        DWORD,
        ctypes.POINTER(ctypes.c_ulonglong),
    ]
    everything.Everything_GetResultSize.restype = BOOL
    everything.Everything_IsFolderResult.argtypes = [DWORD]
    everything.Everything_IsFolderResult.restype = BOOL
    everything.Everything_IsVolumeResult.argtypes = [DWORD]
    everything.Everything_IsVolumeResult.restype = BOOL
    return everything


def load_everything_sdk(dll_path, include_result_functions=False):
    """加载并配置 Everything SDK DLL，按 (归一化路径, include_result_functions) 缓存复用句柄。

    dll_path 先统一归一化为 str 再作为 lru_cache 键，避免同一路径的 Path 与
    str 形式被视作两个缓存键；缓存强引用 DLL 实例，天然维持 LoadLibrary 的
    引用计数，IPC 轮询与多次扫描不再重复加载 DLL。
    """
    return _load_everything_sdk_cached(str(dll_path), include_result_functions)


@functools.lru_cache(maxsize=None)
def _load_everything_sdk_cached(dll_path, include_result_functions=False):
    everything = ctypes.WinDLL(dll_path)
    return configure_everything_sdk(everything, include_result_functions)


def is_everything_query_ready(query_ok, last_error):
    """Everything SDK 查询成功，或失败原因不是 IPC 未连接时，才认为 IPC 可用。"""
    return bool(query_ok) or last_error != EVERYTHING_ERROR_IPC


def is_everything_ready(query_ok, last_error, is_db_loaded=True):
    """Everything IPC 可用且数据库已加载时，才认为可以执行阻塞扫描。"""
    return is_everything_query_ready(query_ok, last_error) and bool(is_db_loaded)


def is_everything_ipc_ready(dll_path):
    """通过 SDK IPC 查询确认 Everything 服务和数据库已经可用。"""
    try:
        everything = load_everything_sdk(dll_path)

        everything.Everything_SetSearchW("")
        query_ok = everything.Everything_QueryW(False)
        try:
            # Everything 刚启动时 IPC 可能已可用，但数据库仍在加载；此时同步扫描会长时间阻塞。
            is_db_loaded = bool(everything.Everything_IsDBLoaded())
        except AttributeError:
            is_db_loaded = True
        return is_everything_ready(query_ok, everything.Everything_GetLastError(), is_db_loaded)
    except Exception:
        return False