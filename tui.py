"""终端交互界面（TUI）模块（C3 拆分自 main.py）。

职责：
- msvcrt 受保护导入（try/except ImportError → None，仅 Windows 可用）与统一
  按键读取 _getch（缺失时抛 MsvcrtUnavailableError，中文提示，行为与拆分前一致）；
- ANSI/VT 渲染基础设施：ANSI_CLEAR_SCREEN/ANSI_HIDE_CURSOR/ANSI_SHOW_CURSOR、
  _enable_vt_processing（SetConsoleMode 开启 VT，启用 STD_OUTPUT_HANDLE/
  ENABLE_VIRTUAL_TERMINAL_PROCESSING，二者在 sdk.py 定义）、_ANSI_AVAILABLE
  模块级探测标志、_write_ansi/_clear_screen/_hide_cursor/_show_cursor；
- 交互主界面 interactive_ui/_interactive_ui_loop。

_ANSI_AVAILABLE 是保存在本模块的模块级可变全局（模块加载时探测一次、测试可
改写模拟回退环境），请通过「tui._ANSI_AVAILABLE」读写，不要 from-import 后再
赋值（那会断掉共享）。_getch 同样以 tui._getch 为桩写入点（interactive_ui 内部
从本模块命名空间调用它）。依赖方向：本模块只依赖 utils/exceptions/sdk。
"""

import ctypes
import os
import shutil
import sys
from pathlib import Path

# =================【受保护导入：msvcrt 仅 Windows 可用】=================
try:
    import msvcrt
except ImportError:  # 非 Windows 平台没有 msvcrt，仅交互界面按键读取依赖它
    msvcrt = None

from utils import APP_NAME, human_size
from exceptions import MsvcrtUnavailableError
from sdk import BOOL, DWORD, ENABLE_VIRTUAL_TERMINAL_PROCESSING, STD_OUTPUT_HANDLE

# ------------【ANSI 终端渲染：清屏与光标管理（替代逐帧 cls 子进程）】------------
# Windows 10 1607 起的内置控制台与 Windows Terminal 原生支持 ANSI/VT 转义；
# 更老的控制台（Win10 早期 conhost）默认关闭 VT，程序启动时用 SetConsoleMode
# 显式开启；开启失败或非 Windows 时自动回退 os.system('cls') 兜底，保证任何
# 环境下交互界面都能正常刷新，绝不因 ANSI 不可用而崩溃。
ANSI_CLEAR_SCREEN = "\x1b[2J\x1b[H"  # 清屏并归位（ED2 + CUP 1;1），替代逐帧 cls 子进程
ANSI_HIDE_CURSOR = "\x1b[?25l"       # 隐藏光标（DECTCEM），进入交互界面时发送
ANSI_SHOW_CURSOR = "\x1b[?25h"       # 恢复显示光标（DECTCEM），退出交互界面时发送


def _getch():
    """统一按键读取封装：interactive_ui 与 main 中所有按键读取均改走本函数。

    msvcrt 仅在 Windows 上存在；缺失（如 Linux/macOS）时抛出带清晰中文说明的
    异常，由上层捕获后优雅退出，绝不静默崩溃。
    """
    if msvcrt is None:
        raise MsvcrtUnavailableError(
            "本程序交互界面依赖 Windows 的 msvcrt 模块，请在 Windows 上运行"
        )
    return msvcrt.getch()


def _enable_vt_processing():
    """尝试开启 Windows 控制台 VT 处理（ENABLE_VIRTUAL_TERMINAL_PROCESSING = 0x0004）。

    返回 True 表示 ANSI 序列可用；非 Windows、取不到控制台句柄或
    SetConsoleMode 失败时返回 False，上层渲染回退到 os.system('cls')，绝不崩溃。
    """
    if os.name != 'nt':
        return False
    try:
        kernel32 = ctypes.windll.kernel32
        # 显式声明 Win32 函数的参数/返回类型：控制台句柄按 c_void_p 完整传递，
        # 避免 64 位进程里默认 c_int 截断句柄，导致 SetConsoleMode 静默失败、
        # 明明支持 ANSI 却误回退到逐帧 cls。
        kernel32.GetStdHandle.argtypes = [DWORD]
        kernel32.GetStdHandle.restype = ctypes.c_void_p
        kernel32.GetConsoleMode.argtypes = [ctypes.c_void_p, ctypes.POINTER(DWORD)]
        kernel32.GetConsoleMode.restype = BOOL
        kernel32.SetConsoleMode.argtypes = [ctypes.c_void_p, DWORD]
        kernel32.SetConsoleMode.restype = BOOL
        handle = kernel32.GetStdHandle(STD_OUTPUT_HANDLE)
        mode = DWORD()
        if not kernel32.GetConsoleMode(handle, ctypes.byref(mode)):
            return False
        return bool(kernel32.SetConsoleMode(
            handle, mode.value | ENABLE_VIRTUAL_TERMINAL_PROCESSING))
    except Exception:
        return False


# 模块加载时探测一次并缓存；回退/降级测试可通过改写本标志模拟环境。
_ANSI_AVAILABLE = _enable_vt_processing()


def _write_ansi(code):
    """向 stdout 写入 ANSI 序列并立即刷新（ANSI 不可用时为无操作）。"""
    if _ANSI_AVAILABLE:
        sys.stdout.write(code)
        sys.stdout.flush()


def _clear_screen():
    """整屏清屏：ANSI 可用时发送清屏码，否则回退到平台默认的 cls 兜底。"""
    if _ANSI_AVAILABLE:
        _write_ansi(ANSI_CLEAR_SCREEN)
    else:
        os.system('cls')


def _hide_cursor():
    """隐藏光标（仅 ANSI 模式生效；回退模式下为无操作，光标保持可见）。"""
    _write_ansi(ANSI_HIDE_CURSOR)


def _show_cursor():
    """恢复显示光标（仅 ANSI 模式生效；回退模式下为无操作）。"""
    _write_ansi(ANSI_SHOW_CURSOR)


def interactive_ui(root_path, sizes, contents, driver_name):
    """
    显示终端交互式界面，返回用户操作。
    返回: ('quit', None) 或 ('change', new_path_str)
    """
    _hide_cursor()
    try:
        return _interactive_ui_loop(root_path, sizes, contents, driver_name)
    finally:
        _show_cursor()


def _interactive_ui_loop(root_path, sizes, contents, driver_name):
    """交互主循环本体（由 interactive_ui 的 try/finally 保证退出时恢复光标）。"""
    current_path = root_path
    selected_idx = 0

    while True:
        term_height = shutil.get_terminal_size().lines
        list_height = max(5, term_height - 7)

        _clear_screen()
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

        key = _getch()
        if key in (b'\xe0', b'\x00'):
            key = _getch()
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
            # 切换路径（input() 输入期间恢复光标可见，结束后重新隐藏）
            _clear_screen()
            print("请输入新的扫描路径 (例如 C:\\ 或 D:\\Downloads):")
            try:
                _show_cursor()
                new_path = input().strip()
            finally:
                _hide_cursor()
            if new_path:
                try:
                    p = Path(new_path).resolve()
                    if p.exists():
                        return ('change', str(p))
                    else:
                        print(f"路径不存在: {p}，按任意键继续...")
                        _getch()
                except MsvcrtUnavailableError:
                    raise  # 非 Windows：透传 main() 统一处理，避免误报“无效路径”
                except Exception as e:
                    print(f"无效路径: {e}，按任意键继续...")
                    _getch()
            # 如果取消或无效，回到UI继续