import os
import sys
import msvcrt
import shutil
import ctypes
import subprocess
import time
import gc
import platform
import re
import json
from pathlib import Path
from collections import defaultdict
import heapq

# =================【全局配置与提示】=================
APP_NAME = "Python 智能磁盘分析工具"
MAX_FILES_PER_DIR = 50
DEFAULT_EVERYTHING_STARTUP_TIMEOUT_SECONDS = 20
DEFAULT_EVERYTHING_STARTUP_ARGS = ["-startup"]

def get_app_dir():
    """源码运行时返回脚本目录；PyInstaller 打包后返回 exe 所在目录。"""
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent

SCRIPT_DIR = get_app_dir()
# config.json 是启动加速缓存：路径存在才使用，失效时会自动重新探测。
CONFIG_PATH = SCRIPT_DIR / "config.json"
DLL_PATH = None
VERBOSE = True

BOOL = ctypes.c_int
DWORD = ctypes.c_uint32

# Everything SDK Win32 常量
EVERYTHING_REQUEST_FILE_NAME = 0x00000001
EVERYTHING_REQUEST_PATH = 0x00000002
EVERYTHING_REQUEST_SIZE = 0x00000010
EVERYTHING_ERROR_MEMORY = 1
EVERYTHING_ERROR_IPC = 2
EVERYTHING_REQUEST_FULL_PATH_AND_FILE_NAME = 0x00000004

try:
    import winreg
except ImportError:
    winreg = None

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
        info.BasicLimitInformation.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE

        kernel32.SetInformationJobObject(
            _GLOBAL_JOB_HANDLE,
            9,  # JobObjectExtendedLimitInformation
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
        PROCESS_SET_QUOTA = 0x0100
        PROCESS_TERMINATE = 0x0001
        h_process = kernel32.OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, False, pid)
        if h_process:
            kernel32.AssignProcessToJobObject(_GLOBAL_JOB_HANDLE, h_process)
            kernel32.CloseHandle(h_process)
    except Exception:
        pass

def human_size(n: int) -> str:
    """人类可读的文件大小格式化"""
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024:
            return f"{n:.2f} {unit}"
        n /= 1024
    return f"{n:.2f} PB"

def log(message="", *, end="\n", flush=False, verbose=None):
    """统一状态输出入口，测试或嵌入调用时可关闭 verbose。"""
    enabled = VERBOSE if verbose is None else verbose
    if enabled:
        print(message, end=end, flush=flush)

def prompt_target_drive():
    """运行入口处再询问扫描路径，避免 import main 时阻塞测试或复用。"""
    return input("请输入扫描的目标路径 (例如 C:\\Users 或 D:\\): ").strip()

# =================【Everything 环境自检与启动】=================
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
    TH32CS_SNAPPROCESS = 0x00000002
    INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value

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
    everything = ctypes.WinDLL(str(dll_path))
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
    global DLL_PATH
    config = load_config(config_path)
    log(f"🧭 正在检查 Everything 运行环境，配置文件: {Path(config_path)}")
    try:
        DLL_PATH = Path(dll_path) if dll_path else resolve_everything_dll(config=config)
    except FileNotFoundError as e:
        log(f"❌ 错误：{e}")
        sys.exit(1)

    log(f"🔌 SDK DLL 已就绪: {DLL_PATH}")
    log("🔎 正在检查 Everything 进程和数据库状态...")
    running = is_running()
    if running:
        if wait_for_everything_ipc(DLL_PATH, is_ipc_ready, sleep, timeout_seconds):
            log("✅ Everything 已运行，IPC 和数据库均已就绪。")
            return True
        log("❌ Everything 已运行，但 IPC/数据库在等待超时后仍不可用。建议手动打开 Everything，确认可以正常搜索后再运行本工具。")
        sys.exit(1)

    log("⚠️ Everything.exe 未运行，正在尝试自动启动...")
    exe_path = Path(exe_path) if exe_path else find_everything_exe(config=config)
    if not exe_path:
        log("❌ 无法定位 Everything.exe。请确认 Everything 已安装，或将 Everything.exe 放在本程序目录/PATH 中。")
        sys.exit(1)

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

        if wait_for_everything_ipc(DLL_PATH, is_ipc_ready, sleep, timeout_seconds):
            config["everything_exe"] = str(exe_path)
            config["everything_dll"] = str(DLL_PATH)
            config["everything_startup_args"] = command[1:]
            save_config(config, config_path)
            log(f"💾 已更新配置缓存: {Path(config_path)}")
            log("✅ Everything IPC 已就绪。")
            return True

    log("❌ Everything 已启动，但 SDK IPC/数据库在等待超时后仍不可用。建议先手动打开 Everything，待其可正常搜索后再运行本工具。")
    sys.exit(1)

# =================【核心扫描：Everything SDK】=================
def scan_via_everything_sdk(root_path_obj):
    """使用 Everything SDK 高速扫描指定路径，返回 (sizes, contents)"""
    global DLL_PATH
    if DLL_PATH is None:
        DLL_PATH = resolve_everything_dll()
    everything = load_everything_sdk(DLL_PATH, include_result_functions=True)
    log(f"🧩 正在加载 Everything SDK: {DLL_PATH}")

    raw_path = str(root_path_obj)
    if not raw_path.endswith("\\"):
        raw_path += "\\"

    log(f"📝 正在设置 Everything 查询条件: path:\"{raw_path}\"")
    everything.Everything_SetSearchW(f'path:"{raw_path}"')
    everything.Everything_SetRequestFlags(
        EVERYTHING_REQUEST_FULL_PATH_AND_FILE_NAME |
        EVERYTHING_REQUEST_SIZE
    )

    log("⏳ 正在等待 Everything 返回查询结果...")
    if not everything.Everything_QueryW(True):
        raise RuntimeError(f"Everything查询失败: {everything.Everything_GetLastError()}")

    num_results = everything.Everything_GetNumResults()
    log(f"📈 Everything 返回 {num_results:,} 条记录")

    if num_results == 0:
        return {}, {}

    root_str = str(root_path_obj).rstrip("\\")
    root_lower = root_str.lower()
    root_prefix = root_lower + "\\"

    sizes = defaultdict(int)
    folder_files = defaultdict(list)
    folder_subdirs = defaultdict(set)

    buffer = ctypes.create_unicode_buffer(32768)
    file_size = ctypes.c_ulonglong()

    processed = 0
    refresh_interval = 10000
    last_refresh = 0

    # 第一阶段：收集文件大小，同时为每个目录保留最大的若干文件，避免 UI 占用过多内存。
    log("📥 正在读取文件结果并统计目录直接占用...")
    for i in range(num_results):
        if i - last_refresh >= refresh_interval:
            percent = i * 100 // num_results
            log(f"\r处理中 {percent:3d}% ({i:,}/{num_results:,})", end="", flush=True)
            last_refresh = i

        if everything.Everything_IsFolderResult(i) or everything.Everything_IsVolumeResult(i):
            continue

        if not everything.Everything_GetResultFullPathNameW(i, buffer, 32768):
            continue

        full_path = buffer.value
        if not full_path:
            continue

        full_path_lower = full_path.lower()
        if full_path_lower != root_lower and not full_path_lower.startswith(root_prefix):
            continue

        everything.Everything_GetResultSize(i, file_size)
        size = file_size.value
        if size <= 0:
            continue

        parent_dir = os.path.dirname(full_path)
        sizes[parent_dir] += size

        heap = folder_files[parent_dir]
        item = (size, os.path.basename(full_path))
        if len(heap) < MAX_FILES_PER_DIR:
            heapq.heappush(heap, item)
        elif size > heap[0][0]:
            heapq.heapreplace(heap, item)

        processed += 1

    log(f"\r处理中 100% ({num_results:,}/{num_results:,})")

    # 第二阶段：根据文件所在目录补全父子目录关系。
    log("🌲 正在构建目录树...")
    all_dirs = set(sizes.keys())
    for d in list(all_dirs):
        current = d
        while True:
            parent = os.path.dirname(current)
            if parent == current or current.lower() == root_lower:
                break
            folder_subdirs[parent].add(os.path.basename(current))
            all_dirs.add(parent)
            current = parent

    # 第三阶段：自底向上汇总，使父目录大小包含全部子目录。
    log("🧮 正在汇总父目录占用...")
    sorted_dirs = sorted(all_dirs, key=lambda p: p.count("\\"), reverse=True)
    for d in sorted_dirs:
        parent = os.path.dirname(d)
        if parent != d:
            sizes[parent] += sizes[d]

    cached_files = sum(len(v) for v in folder_files.values())
    log(f"📦 UI缓存文件数: {cached_files:,}")

    # 构建 contents 字典，供 TUI 逐级浏览时快速读取。
    log("🧱 正在准备交互界面数据...")
    contents = {}
    for folder in all_dirs:
        items = []
        for subdir in folder_subdirs[folder]:
            child = os.path.join(folder, subdir)
            items.append((subdir, True, sizes.get(child, 0)))
        for size, filename in sorted(folder_files[folder], reverse=True):
            items.append((filename, False, size))
        items.sort(key=lambda x: x[2], reverse=True)
        contents[Path(folder)] = items

    final_sizes = {Path(k): v for k, v in sizes.items()}
    return final_sizes, contents

# =================【TUI 终端交互式界面模块】=================
def interactive_ui(root_path, sizes, contents, driver_name):
    """
    显示终端交互式界面，返回用户操作。
    返回: ('quit', None) 或 ('change', new_path_str)
    """
    current_path = root_path
    selected_idx = 0

    while True:
        term_height = shutil.get_terminal_size().lines
        list_height = max(5, term_height - 7)

        os.system('cls')
        print(f"=== {APP_NAME} ===")
        print(f"内核驱动: {driver_name}")
        print(f"当前路径: {current_path}")
        print(f"当前目录总计: {human_size(sizes.get(current_path, 0))}")
        print("-" * 75)

        items = contents.get(current_path, [])
        if not items:
            print("  (空文件夹，或该驱动内核已启用系统安全裁剪拦截)")
        else:
            start_idx = max(0, selected_idx - list_height // 2)
            end_idx = min(len(items), start_idx + list_height)
            if end_idx - start_idx < list_height and len(items) > list_height:
                start_idx = len(items) - list_height

            for i in range(start_idx, end_idx):
                name, is_dir, size = items[i]
                prefix = " > " if i == selected_idx else "   "
                type_indicator = "[目录]" if is_dir else "[文件]"
                display_name = name if len(name) < 45 else name[:42] + "..."
                print(f"{prefix}{type_indicator:^6} {human_size(size):>10}  | {display_name}")

        print("-" * 75)
        print("操作指引: [W/S] 或 [↑/↓] 移动光标 | [Enter] 进入目录 | [Backspace] 返回上级 | [C] 切换扫描路径 | [Q] 退出")

        key = msvcrt.getch()
        if key in (b'\xe0', b'\x00'):
            key = msvcrt.getch()
            if key == b'H':   # 上
                if items:
                    selected_idx = max(0, selected_idx - 1)
            elif key == b'P': # 下
                if items:
                    selected_idx = min(len(items) - 1, selected_idx + 1)
        elif key in (b'w', b'W'):
            if items:
                selected_idx = max(0, selected_idx - 1)
        elif key in (b's', b'S'):
            if items:
                selected_idx = min(len(items) - 1, selected_idx + 1)
        elif key == b'\r':  # Enter
            if items and items[selected_idx][1]:
                current_path = current_path / items[selected_idx][0]
                selected_idx = 0
        elif key == b'\x08':  # Backspace
            if current_path != root_path:
                current_path = current_path.parent
                selected_idx = 0
        elif key in (b'q', b'Q'):
            return ('quit', None)
        elif key in (b'c', b'C'):
            # 切换路径
            os.system('cls')
            print("请输入新的扫描路径 (例如 C:\\ 或 D:\\Downloads):")
            new_path = input().strip()
            if new_path:
                try:
                    p = Path(new_path).resolve()
                    if p.exists():
                        return ('change', str(p))
                    else:
                        print(f"路径不存在: {p}，按任意键继续...")
                        msvcrt.getch()
                except Exception as e:
                    print(f"无效路径: {e}，按任意键继续...")
                    msvcrt.getch()
            # 如果取消或无效，回到UI继续

# =================【主控制流入口】=================
def main():
    log(f"🚀 {APP_NAME}启动中...")
    target_drive = prompt_target_drive()
    init_windows_job_sandbox()
    ensure_everything_running()  # 确保 Everything 已启动

    root_path_obj = Path(target_drive).resolve()
    if not root_path_obj.exists():
        print(f"❌ 错误: 指定的扫描路径不存在: {root_path_obj}")
        sys.exit(1)

    driver_label = "Everything SDK (高速总线版)"
    dir_sizes = None
    dir_contents = None

    # 主循环，支持切换路径
    while True:
        # 释放旧资源
        if dir_sizes is not None:
            del dir_sizes
        if dir_contents is not None:
            del dir_contents
        gc.collect()  # 强制回收

        print(f"\n🔍 开始扫描: {root_path_obj}")
        try:
            dir_sizes, dir_contents = scan_via_everything_sdk(root_path_obj)
        except Exception as e:
            print(f"❌ 扫描失败: {e}")
            print("请检查 Everything 是否正常运行，或尝试切换路径。")
            input("按任意键退出...")
            sys.exit(1)

        print("✅ 扫描数据准备完成，正在进入交互界面。")
        action, result = interactive_ui(root_path_obj, dir_sizes, dir_contents, driver_label)
        if action == 'quit':
            os.system('cls')
            print(f"已安全退出 {APP_NAME}。")
            break
        elif action == 'change':
            new_path_str = result
            new_path = Path(new_path_str).resolve()
            if new_path.exists():
                root_path_obj = new_path
                print(f"✅ 已切换到新路径: {root_path_obj}")
                # 继续循环，重新扫描
            else:
                print(f"❌ 路径无效: {new_path_str}，按任意键返回...")
                msvcrt.getch()
                # 继续使用旧路径
        else:
            break


if __name__ == "__main__":
    main()
