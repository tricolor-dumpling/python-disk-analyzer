"""运行环境协调模块（C3 拆分自 main.py）：Everything 环境自检与启动。

职责：
- config.json 读写（load_config/save_config）；
- Everything.exe 定位（find_everything_exe/_expand_everything_exe_candidates/
  _registry_everything_locations，含 winreg 受保护导入）；
- 进程枚举与会话判定（iter_process_ids_by_name/get_process_session_id/
  get_current_session_id/list_everything_process_sessions/
  is_everything_process_running/is_everything_process_running_legacy）；
- Windows 作业对象内核级防孤儿沙盒（_GLOBAL_JOB_HANDLE/init_windows_job_sandbox/
  bind_pid_to_job_sandbox）；
- Everything 启动与 IPC 等待（wait_for_everything_ipc/_normalize_startup_args/
  ensure_everything_running，含默认启动参数/超时常量）。

SDK DLL 路径全局（sdk.DLL_PATH）通过「import sdk; sdk.DLL_PATH」方式共享：
本模块只负责在 ensure_everything_running 中回填它，不另存副本，避免断掉共享。
依赖方向：本模块依赖 utils/exceptions/sdk；不依赖 scan/tui/cli/main。
"""

import ctypes
import json
import os
import re
import subprocess
import time
from pathlib import Path

# =================【受保护导入：winreg 仅 Windows 可用】=================
try:
    import winreg
except ImportError:  # 非 Windows 平台没有 winreg，仅注册表定位 Everything.exe 依赖它
    winreg = None

from utils import CONFIG_PATH, SCRIPT_DIR, log
from sdk import (
    DWORD,
    INVALID_HANDLE_VALUE,
    JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    PROCESS_SET_QUOTA,
    PROCESS_TERMINATE,
    TH32CS_SNAPPROCESS,
    _valid_file_from_config,
    is_everything_ipc_ready,
    resolve_everything_dll,
)
import sdk  # 可变全局 DLL_PATH 一律通过 sdk.DLL_PATH 读写
from exceptions import EverythingEnvironmentError

DEFAULT_EVERYTHING_STARTUP_TIMEOUT_SECONDS = 20
DEFAULT_EVERYTHING_STARTUP_ARGS = ["-startup"]


def load_config(config_path=CONFIG_PATH):
    """读取本地配置。配置不存在或损坏时返回空配置。"""
    try:
        path = Path(config_path)
        if not path.exists():
            return {}
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def save_config(config, config_path=CONFIG_PATH):
    """保存本地配置，失败时不影响主流程。"""
    try:
        path = Path(config_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(config, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        return True
    except OSError:
        return False


def _registry_everything_locations():
    """从注册表读取 Everything 的安装目录，覆盖非默认安装路径。"""
    if winreg is None:
        return []

    locations = []
    registry_keys = [
        (winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\App Paths\Everything.exe"),
        (winreg.HKEY_LOCAL_MACHINE, r"Software\Microsoft\Windows\CurrentVersion\App Paths\Everything.exe"),
        (winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Uninstall\Everything"),
        (winreg.HKEY_LOCAL_MACHINE, r"Software\Microsoft\Windows\CurrentVersion\Uninstall\Everything"),
        (winreg.HKEY_LOCAL_MACHINE, r"Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Everything"),
    ]

    for hive, key_path in registry_keys:
        try:
            with winreg.OpenKey(hive, key_path) as key:
                for value_name in ("", "InstallLocation", "DisplayIcon"):
                    try:
                        value, _ = winreg.QueryValueEx(key, value_name)
                    except OSError:
                        continue
                    locations.append(str(value))
        except OSError:
            continue
    return locations


def _expand_everything_exe_candidates(value):
    """将注册表/PATH/目录值展开为可能的 Everything.exe 路径。"""
    if not value:
        return []

    raw = os.path.expandvars(str(value)).strip()
    candidates = []

    quoted_exe = re.search(r'"([^"]*Everything\.exe)"', raw, re.IGNORECASE)
    if quoted_exe:
        candidates.append(Path(quoted_exe.group(1)))
    else:
        exe_index = raw.lower().find("everything.exe")
        if exe_index >= 0:
            exe_end = exe_index + len("everything.exe")
            candidates.append(Path(raw[:exe_end].strip().strip('"')))

    cleaned = raw.strip().strip('"')
    if cleaned:
        path = Path(cleaned)
        if path.name.lower() == "everything.exe":
            candidates.append(path)
        else:
            candidates.append(path / "Everything.exe")

    return candidates


def find_everything_exe(script_dir=SCRIPT_DIR, registry_install_locations=None, path_dirs=None, config=None):
    """查找 Everything.exe，支持注册表、PATH、当前目录和常见安装目录。"""
    script_dir = Path(script_dir)
    registry_install_locations = (
        _registry_everything_locations()
        if registry_install_locations is None
        else registry_install_locations
    )
    path_dirs = (
        os.environ.get("PATH", "").split(os.pathsep)
        if path_dirs is None
        else path_dirs
    )

    candidates = []
    config_exe = _valid_file_from_config(config or {}, "everything_exe")
    if config_exe:
        log(f"ℹ️ 使用配置缓存中的 Everything.exe: {config_exe}")
        candidates.append(config_exe)
    candidates.append(script_dir / "Everything.exe")
    for value in registry_install_locations:
        candidates.extend(_expand_everything_exe_candidates(value))
    for value in path_dirs:
        candidates.extend(_expand_everything_exe_candidates(value))
    candidates.extend([
        Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "Everything" / "Everything.exe",
        Path(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")) / "Everything" / "Everything.exe",
    ])

    seen = set()
    for candidate in candidates:
        try:
            resolved_key = str(candidate).lower()
            if resolved_key in seen:
                continue
            seen.add(resolved_key)
            if candidate.exists():
                return candidate
        except OSError:
            continue
    return None


def get_process_session_id(pid):
    """返回指定 PID 所在的 Windows SessionId。"""
    if os.name != "nt":
        return None
    try:
        session_id = DWORD()
        ok = ctypes.windll.kernel32.ProcessIdToSessionId(
            DWORD(pid),
            ctypes.byref(session_id),
        )
        return int(session_id.value) if ok else None
    except Exception:
        return None


def get_current_session_id():
    """返回当前 Python 进程所在的 Windows SessionId。"""
    return get_process_session_id(os.getpid())


def iter_process_ids_by_name(process_name):
    """使用 Toolhelp 快照枚举指定进程名的 PID，避免解析本地化 tasklist 文本。"""
    if os.name != "nt":
        return []

    kernel32 = ctypes.windll.kernel32

    class PROCESSENTRY32W(ctypes.Structure):
        _fields_ = [
            ("dwSize", DWORD),
            ("cntUsage", DWORD),
            ("th32ProcessID", DWORD),
            ("th32DefaultHeapID", ctypes.c_void_p),
            ("th32ModuleID", DWORD),
            ("cntThreads", DWORD),
            ("th32ParentProcessID", DWORD),
            ("pcPriClassBase", ctypes.c_long),
            ("dwFlags", DWORD),
            ("szExeFile", ctypes.c_wchar * 260),
        ]

    snapshot = kernel32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if snapshot == INVALID_HANDLE_VALUE:
        return []

    try:
        entry = PROCESSENTRY32W()
        entry.dwSize = ctypes.sizeof(PROCESSENTRY32W)
        pids = []
        if not kernel32.Process32FirstW(snapshot, ctypes.byref(entry)):
            return []
        target = process_name.lower()
        while True:
            if entry.szExeFile.lower() == target:
                pids.append(int(entry.th32ProcessID))
            if not kernel32.Process32NextW(snapshot, ctypes.byref(entry)):
                break
        return pids
    finally:
        kernel32.CloseHandle(snapshot)


def list_everything_process_sessions():
    """列出所有 Everything.exe 所在的 SessionId。"""
    sessions = []
    for pid in iter_process_ids_by_name("Everything.exe"):
        session_id = get_process_session_id(pid)
        if session_id is not None:
            sessions.append(session_id)
    return sessions


def is_everything_process_running(current_session_id=None, process_sessions=None):
    """仅当当前用户会话中存在 Everything.exe 时，才认为客户端已运行。"""
    if current_session_id is None:
        current_session_id = get_current_session_id()
    if current_session_id is None:
        return False

    if process_sessions is None:
        process_sessions = list_everything_process_sessions()
    return any(session_id == current_session_id for session_id in process_sessions)


def is_everything_process_running_legacy():
    """旧版兜底：只检查进程名。保留给调试，不参与主流程。"""
    try:
        res = subprocess.run(
            ["tasklist", "/FI", "IMAGENAME eq Everything.exe"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="ignore",
        )
        if "Everything.exe" in res.stdout:
            return True
    except Exception:
        pass
    return False


# =================【Windows 作业对象 (Job Object) 内核级防孤儿防线】=================
_GLOBAL_JOB_HANDLE = None


def init_windows_job_sandbox():
    """初始化内核级作业对象沙盒，配置“进程同生共死”限额标志位。"""
    global _GLOBAL_JOB_HANDLE
    if os.name != 'nt':
        return

    try:
        kernel32 = ctypes.windll.kernel32
        _GLOBAL_JOB_HANDLE = kernel32.CreateJobObjectW(None, None)
        if not _GLOBAL_JOB_HANDLE:
            return

        class JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
            _fields_ = [
                ("PerProcessUserTimeLimit", ctypes.c_int64),
                ("PerJobUserTimeLimit", ctypes.c_int64),
                ("LimitFlags", ctypes.c_uint32),
                ("MinimumWorkingSetSize", ctypes.c_size_t),
                ("MaximumWorkingSetSize", ctypes.c_size_t),
                ("ActiveProcessLimit", ctypes.c_uint32),
                ("Affinity", ctypes.c_void_p),
                ("PriorityClass", ctypes.c_uint32),
                ("SchedulingClass", ctypes.c_uint32),
            ]

        class IO_COUNTERS(ctypes.Structure):
            _fields_ = [
                ("ReadOperationCount", ctypes.c_uint64), ("WriteOperationCount", ctypes.c_uint64),
                ("OtherOperationCount", ctypes.c_uint64), ("ReadTransferCount", ctypes.c_uint64),
                ("WriteTransferCount", ctypes.c_uint64), ("OtherTransferCount", ctypes.c_uint64)
            ]

        class JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
            _fields_ = [
                ("BasicLimitInformation", JOBOBJECT_BASIC_LIMIT_INFORMATION),
                ("IoInfo", IO_COUNTERS),
                ("ProcessMemoryLimit", ctypes.c_size_t),
                ("JobMemoryLimit", ctypes.c_size_t),
                ("PeakProcessMemoryUsed", ctypes.c_size_t),
                ("PeakJobMemoryUsed", ctypes.c_size_t),
            ]

        info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE

        kernel32.SetInformationJobObject(
            _GLOBAL_JOB_HANDLE,
            JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
            ctypes.byref(info),
            ctypes.sizeof(info)
        )
    except Exception as e:
        print(f"⚠️ [SRE 警告] 内核沙盒初始化失败: {e}")


def bind_pid_to_job_sandbox(pid):
    """将指定 PID 的外部子进程强行捕获并锁入作业沙盒中"""
    global _GLOBAL_JOB_HANDLE
    if not _GLOBAL_JOB_HANDLE:
        return
    try:
        kernel32 = ctypes.windll.kernel32
        h_process = kernel32.OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, False, pid)
        if h_process:
            kernel32.AssignProcessToJobObject(_GLOBAL_JOB_HANDLE, h_process)
            kernel32.CloseHandle(h_process)
    except Exception:
        pass


def wait_for_everything_ipc(
    dll_path,
    is_ipc_ready=is_everything_ipc_ready,
    sleep=time.sleep,
    timeout_seconds=DEFAULT_EVERYTHING_STARTUP_TIMEOUT_SECONDS,
    progress_interval_seconds=5,
):
    """等待 Everything IPC 和数据库加载完成。"""
    deadline = time.monotonic() + timeout_seconds
    next_progress = time.monotonic() + progress_interval_seconds
    while time.monotonic() < deadline:
        if is_ipc_ready(dll_path):
            return True
        now = time.monotonic()
        if now >= next_progress:
            remaining = max(0, int(deadline - now))
            log(f"⏳ Everything 数据库仍在加载，最多再等待 {remaining} 秒...")
            next_progress = now + progress_interval_seconds
        sleep(0.5)
    return is_ipc_ready(dll_path)


def _normalize_startup_args(raw_args):
    """规范化 config 中的 everything_startup_args。

    只接受“非空且元素全为 str 的 list”；其余脏数据（None、非 list、
    空列表、含非字符串元素等）一律回退到默认 ["-startup"]，绝不因
    脏配置导致启动失败或崩溃。
    """
    if not isinstance(raw_args, list):
        return list(DEFAULT_EVERYTHING_STARTUP_ARGS)
    if not raw_args or not all(isinstance(arg, str) for arg in raw_args):
        return list(DEFAULT_EVERYTHING_STARTUP_ARGS)
    return list(raw_args)


def ensure_everything_running(
    dll_path=None,
    exe_path=None,
    config_path=CONFIG_PATH,
    is_running=is_everything_process_running,
    is_ipc_ready=is_everything_ipc_ready,
    popen=subprocess.Popen,
    sleep=time.sleep,
    timeout_seconds=DEFAULT_EVERYTHING_STARTUP_TIMEOUT_SECONDS,
):
    """检查 Everything 是否运行，若未运行则尝试启动，失败则退出。"""
    # 解析结果回填到 sdk.DLL_PATH（模块级全局，scan/scene 等模块从 sdk 读取）
    config = load_config(config_path)
    log(f"🧭 正在检查 Everything 运行环境，配置文件: {Path(config_path)}")
    try:
        sdk.DLL_PATH = Path(dll_path) if dll_path else resolve_everything_dll(config=config)
    except FileNotFoundError as e:
        raise EverythingEnvironmentError(f"错误：{e}") from e

    log(f"🔌 SDK DLL 已就绪: {sdk.DLL_PATH}")
    log("🔎 正在检查 Everything 进程和数据库状态...")
    running = is_running()
    if running:
        if wait_for_everything_ipc(sdk.DLL_PATH, is_ipc_ready, sleep, timeout_seconds):
            log("✅ Everything 已运行，IPC 和数据库均已就绪。")
            return True
        raise EverythingEnvironmentError(
            "Everything 已运行，但 IPC/数据库在等待超时后仍不可用。建议手动打开 Everything，确认可以正常搜索后再运行本工具。"
        )

    log("⚠️ Everything.exe 未运行，正在尝试自动启动...")
    exe_path = Path(exe_path) if exe_path else find_everything_exe(config=config)
    if not exe_path:
        raise EverythingEnvironmentError(
            "无法定位 Everything.exe。请确认 Everything 已安装，或将 Everything.exe 放在本程序目录/PATH 中。"
        )

    # 启动参数优先级：config 缓存的 everything_startup_args（非空 str list）→
    # 默认 ["-startup"] → 无参数兜底；重复命令自动去重。
    startup_args = _normalize_startup_args(config.get("everything_startup_args"))
    launch_attempts = []
    for candidate_args in (startup_args, DEFAULT_EVERYTHING_STARTUP_ARGS, []):
        command = [str(exe_path)] + list(candidate_args)
        if command not in launch_attempts:
            launch_attempts.append(command)
    for index, command in enumerate(launch_attempts, 1):
        try:
            proc = popen(command,
                         stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL)
            bind_pid_to_job_sandbox(proc.pid)
            log(f"✅ 已尝试启动 Everything：{' '.join(command)}")
        except Exception as e:
            log(f"⚠️ 第 {index} 次启动 Everything 失败 ({' '.join(command)}): {e}")
            continue

        if wait_for_everything_ipc(sdk.DLL_PATH, is_ipc_ready, sleep, timeout_seconds):
            config["everything_exe"] = str(exe_path)
            config["everything_dll"] = str(sdk.DLL_PATH)
            config["everything_startup_args"] = command[1:]
            save_config(config, config_path)
            log(f"💾 已更新配置缓存: {Path(config_path)}")
            log("✅ Everything IPC 已就绪。")
            return True

    raise EverythingEnvironmentError(
        "Everything 已启动，但 SDK IPC/数据库在等待超时后仍不可用。建议先手动打开 Everything，待其可正常搜索后再运行本工具。"
    )