"""终端交互界面（TUI）模块（C3 拆分自 main.py）。

职责：
- msvcrt 受保护导入（try/except ImportError → None，仅 Windows 可用）与统一
  按键读取 _getch（缺失时抛 MsvcrtUnavailableError，中文提示，行为与拆分前一致）；
- ANSI/VT 渲染基础设施：ANSI_CLEAR_SCREEN/ANSI_HIDE_CURSOR/ANSI_SHOW_CURSOR、
  _enable_vt_processing（SetConsoleMode 开启 VT，启用 STD_OUTPUT_HANDLE/
  ENABLE_VIRTUAL_TERMINAL_PROCESSING，二者在 sdk.py 定义）、_ANSI_AVAILABLE
  模块级探测标志、_write_ansi/_clear_screen/_hide_cursor/_show_cursor；
- 交互主界面 interactive_ui/_interactive_ui_loop；
- D4 两级刷新 r/R：局部状态（last_r_at 60s 冷却 / deep_scan_in_progress /
  pending_r cap-1 合并待办），r@根指纹门（FINGERPRINT_CACHE + fingerprints_equal，
  命中「数据未变」毫秒返回、脏则升级深刷继承 R 全套保护），深扫后台线程 +
  Esc 置位 cancel_event 取消（ScanCancelledError → 「已取消」），横幅全部走
  messages.render_message（E_SCAN_IN_PROGRESS/E_BUSY/INFO_FINGERPRINT_SAME）。
- D5 路径跳转 /：_validate_jump_target 共享校验管线（Path 规范化 + 越界/存在性
  判定，边界语义与 scan._is_scan_root 一致）+ _run_path_input 输入模态（最近跳转
  历史 16 条、空回车/Ctrl-C 取消、错误横幅走 messages.render_message），
  ACT_PATH_JUMP 分支完成根内跳转、不触发重扫。
- D8 打磨集成：状态栏（反转色常驻底行：根/当前路径/数据时间/键位缩写，ANSI
  可用时 \x1b[7m 反白、否则纯文本）；首启引导（模块级标志不落盘，快照数据目录
  缺失时打印 4 行引导，仅首次进入交互循环检测一次）；h 全屏帮助（KEY_BINDINGS
  同源键位表 + 快照位置 + 口径说明 2 行，任意键返回列表态）；H 历史对比模态
  （选基线快照 → compare.diff_from_current → 增量降序视图，CompareError 红字
  返回）；S 保存快照模态（DSA_NO_SNAPSHOT 禁用 / SnapshotBusyError / OSError /
  ValueError 均中文横幅，不阻塞主循环）；终端 <12 行门（居中 E_TERM_TOO_SMALL
  + 仅状态栏，跳过列表渲染，仍响应 Q 退出，resize 后自动恢复）。

_ANSI_AVAILABLE 是保存在本模块的模块级可变全局（模块加载时探测一次、测试可
改写模拟回退环境），请通过「tui._ANSI_AVAILABLE」读写，不要 from-import 后再
赋值（那会断掉共享）。_getch 同样以 tui._getch 为桩写入点（interactive_ui 内部
从本模块命名空间调用它）。依赖方向：本模块只依赖
utils/exceptions/sdk/keyrouter/messages/scan/snapshots/compare（均不反向依赖
tui，无环）。
"""

import ctypes
import os
import shutil
import sys
import threading
import time
from datetime import datetime
from pathlib import Path

# =================【受保护导入：msvcrt 仅 Windows 可用】=================
try:
    import msvcrt
except ImportError:  # 非 Windows 平台没有 msvcrt，仅交互界面按键读取依赖它
    msvcrt = None

from utils import APP_NAME, get_app_dir, human_size
import datadir
from exceptions import MsvcrtUnavailableError
from sdk import BOOL, DWORD, ENABLE_VIRTUAL_TERMINAL_PROCESSING, STD_OUTPUT_HANDLE
from messages import render_message  # 横幅文案模板（E_SCAN_IN_PROGRESS/E_BUSY/INFO_FINGERPRINT_SAME/E_OUT_OF_ROOT/E_PATH_NOT_FOUND）
import scan  # 指纹门/轻刷/深刷：FINGERPRINT_CACHE 经 scan. 属性读写（可 patch）
from scan import (
    ScanCancelledError,
    compute_fingerprint,
    deep_refresh,
    fingerprints_equal,
    light_refresh,
)
import keyrouter  # 键位注册表与纯函数按键分发（D2）：帮助文案与按键分发均走注册表
import snapshots  # 快照模块（D8 S/H 分支）：保存/列表/加载/禁用判定/目录解析
import compare  # 历史对比引擎（D8 H 分支）：diff_from_current/format_row/CompareError

# ------------【D4 刷新常量】------------
# 深刷 60 秒冷却（last_r_at 距上次深刷完成不足此值时按 R/r@根-脏 只提示不执行）
DEEP_REFRESH_COOLDOWN_SECONDS = 60.0
# 轻刷结果窗口上限（与扫描常量 MAX_FILES_PER_DIR 同量级的展示窗口）
LIGHT_REFRESH_TOP = 50

# ------------【D5 路径跳转常量】------------
# 跳转历史条数上限（仅成功跳转入历史、去重后插头部；模态内按序号 1-16 选择）
JUMP_HISTORY_MAX = 16

# ------------【D8 打磨常量】------------
# 终端高度下限：低于此值只显示居中提示 + 状态栏（跳过列表渲染，仍响应 Q 退出）
MIN_TERM_HEIGHT = 12
# 首启引导进程内标志：仅在首次进入交互循环时检测数据目录缺失并打印一次（不落盘）
_FIRST_LAUNCH_GUIDE_SHOWN = False

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


# =================【D8 打磨：状态栏 / 横幅 / 首启引导 / 帮助页 / 终端行门】================


def _center_text(text, width):
    """把纯文本按 width 居中（左侧补空格；过宽时原样返回，不截断）。"""
    pad = max(0, (width - len(text)) // 2)
    return " " * pad + text


def _format_status_bar(root_path, current_path, last_data_time):
    """状态栏文本：根 + 当前路径 + 数据时间 + 键位缩写；ANSI 可用时反转色常驻底行。

    反转色转义 \x1b[7m...\x1b[0m 仅在 _ANSI_AVAILABLE 为 True 时附加；
    回退环境输出纯文本行（键位/文案与 KeyRouter 注册表同源，防漂移）。
    """
    text = "根: {root} | 当前: {path} | 数据: {ts} | r轻 R深 /跳 S存 H比 h帮".format(
        root=root_path,
        path=current_path,
        ts=last_data_time.strftime("%H:%M"),
    )
    if _ANSI_AVAILABLE:
        return "\x1b[7m" + text + "\x1b[0m"
    return text


def _warn_banner(text):
    """warn 级横幅：⚠ 前缀 + ANSI 可用时黄色（回退纯文本；不阻塞主循环）。"""
    if _ANSI_AVAILABLE:
        return "\x1b[33m⚠ %s\x1b[0m" % text
    return "⚠ " + text


def _red_text(text):
    """error 级红字（ANSI 可用时红色，否则纯文本；用于跨根/机器不匹配等拒绝）。"""
    if _ANSI_AVAILABLE:
        return "\x1b[31m" + text + "\x1b[0m"
    return text


def _snapshot_display_time(path):
    """快照条目展示时间：优先文件名时间戳段（YYYYMMDD_HHMMSS），失败回退 mtime。

    返回 "文件名 (YYYY-MM-DD HH:MM:SS)" 或仅有文件名（都无法解析时）。
    自包含解析（不依赖 snapshots 内部函数）；根名含下划线也不受影响。
    """
    name = Path(path).name
    tokens = name.split("_")
    ts = None
    for i in range(len(tokens) - 1):
        if (
            len(tokens[i]) == 8 and tokens[i].isdigit()
            and len(tokens[i + 1]) == 6 and tokens[i + 1].isdigit()
        ):
            ts = tokens[i] + tokens[i + 1]
            break
    if ts is None:
        try:
            ts = datetime.fromtimestamp(Path(path).stat().st_mtime).strftime(
                "%Y%m%d_%H%M%S"
            )
        except OSError:
            ts = None
    if not ts:
        return name
    pretty = "%s-%s-%s %s:%s:%s" % (
        ts[0:4], ts[4:6], ts[6:8], ts[8:10], ts[10:12], ts[12:14],
    )
    return "%s (%s)" % (name, pretty)


def _first_launch_data_missing():
    """首启判定：快照数据目录缺失（只读探测，不创建目录、不落盘）。

    刻意不直接用 snapshots.get_snapshot_dir() 做存在性判定——其默认分支会在首次
    调用时顺手建目录，使「缺失」恒为 False；改为按 Phase 0 数据目录约定计算
    %LOCALAPPDATA%\\PythonDiskScanner\\snapshots 后检查是否已有任何快照文件
    （目录不存在/为空 = 视为缺失，语义等价）。
    """
    env = os.environ.get("DSA_SNAPSHOT_DIR")
    if env:
        return not Path(env).exists()
    try:
        directory = datadir.get_data_dir() / "snapshots"
    except Exception:
        return False
    return not any(directory.glob("*.snap.gz"))


def _maybe_show_first_launch_guide():
    """首启引导（D8）：进程内仅打印一次、不落盘；触发 = 快照数据目录缺失。

    仅首次进入交互循环时检测（标志前置置位），随后继续正常主循环；
    数据目录已存在（有快照数据）时静默跳过、不重复检测。
    """
    global _FIRST_LAUNCH_GUIDE_SHOWN
    if _FIRST_LAUNCH_GUIDE_SHOWN:
        return
    _FIRST_LAUNCH_GUIDE_SHOWN = True  # 检测只发生在首次进入交互循环
    if not _first_launch_data_missing():
        return
    print("首启引导: 本工具基于 Everything 索引展示磁盘目录占用(纯本地, 数据不上传)。")
    print("请确保 Everything 已运行; 未运行时扫描/刷新可能为空或失败。")
    print("r = 轻刷当前目录 | R = 深刷整棵扫描树(Esc 取消) | / = 根内路径跳转。")
    print("S = 保存快照 | H = 历史对比 | C = 换根 | Q = 退出。")


def _show_full_help():
    """h 全屏帮助（D8）：清屏后打印 KEY_BINDINGS 同源键位表 + 快照位置 + 口径说明。

    键位表逐条展开注册表条目的 name/keys/help（与 keyrouter.help_text 同源防漂移）；
    底部「按任意键返回」，_getch() 读一键后回到列表态，不阻塞主循环。
    """
    _clear_screen()
    print("========== 帮助 ==========")
    print("键位表:")
    for entry in keyrouter.KEY_BINDINGS:
        keys_repr = " ".join(repr(k) for k in entry["keys"])
        print("  [%s] %s | 键: %s | %s" % (
            entry["display"], entry["name"], keys_repr, entry["help"]))
    try:
        snap_location = snapshots.get_snapshot_dir()
    except Exception as exc:  # 目录解析失败也不让帮助页崩溃
        snap_location = "不可用(%s)" % exc
    print("快照位置: %s" % snap_location)
    print("口径说明①: 目录大小 = 直接子项(文件+子目录)占用合计, 按 1024 进制显示。")
    print("口径说明②: 数据来自 Everything 索引, 请保持其运行; 未索引/被系统裁剪项可能不显示。")
    print("按任意键返回")
    _getch()


# =================【D5 路径跳转：共享校验管线 + 输入模态】================


def _validate_jump_target(target, root_path):
    """校验路径跳转目标（与 C 换根同源的规范化/边界语义）。

    返回三元组 (ok, normalized, error_id)：
    - 合法：ok=True，normalized 为规范化绝对路径字符串（Path(target).resolve，
      处理盘符/正反斜杠/尾分隔符；相对输入按扫描根解析），error_id=None；
    - 越界：ok=False，error_id=E_OUT_OF_ROOT；
    - 目标为文件或不存在：ok=False，error_id=E_PATH_NOT_FOUND；
    - 空输入：ok=False，error_id=None（静默取消，不打印错误横幅）。
    边界规则：①目标必须在扫描根内或等于根——Path 相等比较（大小写不敏感、
    折叠尾随分隔符），与 scan._is_scan_root 的判定语义一致；②目标必须是存在的
    目录——Everything 查询语义优先、os.path.isdir 兜底，统一以 Path.is_dir 判定
    （文件/不存在都返回 E_PATH_NOT_FOUND）。非法路径（OSError/ValueError）按
    不存在处理，绝不抛给调用方。
    """
    if target is None or not target.strip():
        return (False, None, None)
    try:
        raw = target.strip()
        p = Path(raw)
        root = Path(root_path).resolve()
        if not p.is_absolute():
            p = root / p
        normalized = p.resolve()
        if normalized != root and root not in normalized.parents:
            return (False, None, "E_OUT_OF_ROOT")
        if not normalized.is_dir():
            return (False, None, "E_PATH_NOT_FOUND")
        return (True, str(normalized), None)
    except (OSError, ValueError):
        return (False, None, "E_PATH_NOT_FOUND")


def _push_jump_history(history, path):
    """成功跳转的路径入历史：去重（移除旧条目）后插到头部，上限 JUMP_HISTORY_MAX。

    仅由成功跳转（_run_path_input 返回 jumped=True）的调用方调用，保证「成功才入」。
    """
    if path in history:
        history.remove(path)
    history.insert(0, path)
    del history[JUMP_HISTORY_MAX:]
    return history


def _history_status(history):
    """历史条目状态 [(序号, 路径, 是否仍为有效目录)]（1 起始）。

    提示区展示与「灰显/不可选」判定共用同一份状态：路径已不存在（is_dir False）
    即标注失效（打印为灰显 + 「(已失效)」），且输入其序号仍会走共享校验管线被拒。
    """
    return [(i + 1, path, Path(path).is_dir()) for i, path in enumerate(history)]


def _run_path_input(current_path, root_path, history):
    """路径输入模态（与 C 换根同风格的 input() 行编辑，原生支持中文 IME 与空格）。

    提示区打印当前根与「最近跳转」编号列表（失效条目灰显标注「(已失效)」、
    不可选），输入序号等价于选择对应历史路径；路径输入走共享校验管线
    _validate_jump_target。返回 (normalized, True) 表示成功跳转；空输入/
    KeyboardInterrupt/EOFError → (None, False) 取消；校验失败 → 打印错误横幅
    （messages.render_message：E_OUT_OF_ROOT/E_PATH_NOT_FOUND）后 (None, False)。
    注：input() 无法拦截方向键/Esc 等瞬时键，历史改按「序号选择」实现；
    Esc 是否清行取决于控制台行编辑器（cmd 的 Esc 清空当前行 → 空行按取消处理），
    本模态不区分，属已知限制。
    """
    _clear_screen()
    print(f"路径跳转 (当前根: {root_path})")
    if history:
        print("最近跳转 (输入序号可直接跳转):")
        for idx, path, valid in _history_status(history):
            label = f"  {idx}. {path}"
            if not valid:
                label += " (已失效)"
                if _ANSI_AVAILABLE:
                    label = "\x1b[90m" + label + "\x1b[0m"
            print(label)
    print("请输入目标路径 (空回车/Ctrl+C=取消):")
    try:
        _show_cursor()
        raw = input()
    except (KeyboardInterrupt, EOFError):
        return (None, False)
    finally:
        _hide_cursor()
    raw = raw.strip()
    if not raw:
        return (None, False)
    if raw.isdigit():  # 序号选择历史条目；越界/非数字按路径输入处理（仍走同一校验管线）
        idx = int(raw)
        if 1 <= idx <= len(history):
            raw = history[idx - 1]
    ok, normalized, error_id = _validate_jump_target(raw, root_path)
    if not ok:
        if error_id is not None:
            print(render_message(error_id))
        return (None, False)
    return (normalized, True)


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
    # D8: 数据时间（状态栏 HH:MM）—— 最后一次扫描/刷新完成时刻；进入交互界面时为初值
    last_data_time = datetime.now()

    # ------------【D4 刷新局部状态】------------
    # view：sizes/contents 的可变引用容器；深扫线程完成整体替换
    view = {"sizes": sizes, "contents": contents}
    # D5: 路径跳转历史（仅成功跳转入历史；模态内按序号 1-16 选择）
    jump_history = []
    # scan_state：深扫在途标志 / 取消事件 / 合并待办(cap-1) / 结果 / 冷却时间戳
    scan_state = {
        "in_progress": False,  # 深扫后台线程在途
        "cancel_event": None,  # 当前深扫的取消事件（Esc 置位）
        "pending_r": False,    # 在途期间按 r/R 的合并待办（cap-1，只记一次）
        "result": None,        # 深扫完成结果 (sizes, contents)
        "cancelled": False,    # 当前深扫被 Esc 取消（worker 上报）
        "error": None,         # 当前深扫异常信息（worker 上报）
        "last_r_at": 0.0,      # 上次深扫完成时间戳（60s 冷却依据）
    }

    def _apply_scan_result():
        """深扫结果落到视图：替换 sizes/contents 局部引用（成功后再刷新视图）。"""
        nonlocal last_data_time
        if scan_state["result"] is None:
            return
        view["sizes"], view["contents"] = scan_state["result"]
        scan_state["result"] = None
        last_data_time = datetime.now()  # 深刷完成 → 状态栏数据时间刷新

    def _report_scan_finish():
        """深扫线程结束状态上报（取消/失败），显示为一行横幅（不阻塞主循环）。"""
        if scan_state["cancelled"]:
            scan_state["cancelled"] = False
            print("深扫已取消")
        elif scan_state["error"] is not None:
            print(f"深扫失败: {scan_state['error']}")
            scan_state["error"] = None

    def _cooldown_remaining():
        remain = DEEP_REFRESH_COOLDOWN_SECONDS - (time.time() - scan_state["last_r_at"])
        return remain if remain > 0 else 0.0

    def _start_deep_refresh():
        """启动深扫后台线程：主循环继续读键，Esc 置位 cancel_event 触发取消。

        阻塞式全量扫描放进 daemon 线程，交互循环不冻结；worker 完成后把
        (sizes, contents) 写入 scan_state["result"]，由下一轮 _apply_scan_result
        应用；取消/异常写入 cancelled/error 字段由 _report_scan_finish 上报，
        finally 里打冷却时间戳（深刷后 60s 冷却重武装）。
        """
        cancel_event = threading.Event()
        scan_state["cancel_event"] = cancel_event
        scan_state["in_progress"] = True

        def worker():
            try:
                new_sizes, new_contents = deep_refresh(root_path, cancel_event=cancel_event)
                scan_state["result"] = (new_sizes, new_contents)
            except ScanCancelledError:
                scan_state["cancelled"] = True
            except Exception as exc:
                scan_state["error"] = str(exc)
            finally:
                scan_state["in_progress"] = False
                scan_state["last_r_at"] = time.time()

        threading.Thread(target=worker, name="deep-refresh", daemon=True).start()

    def _do_light_refresh(target_dir):
        """对 target_dir 执行轻刷：更新视图条目并打印摘要行（文件+N / 净±X MB~）。

        失败返回友好提示（绝不让 TUI 崩溃）；摘要置于状态区，为文本行输出。
        P12·W1.1：经 stats 通道取回「大小未知」条数，N>0 时在摘要行后追加
        「N 条大小未知」，与主扫描口径一致。
        """
        nonlocal last_data_time
        stats = {}
        items = light_refresh(root_path, target_dir, top=LIGHT_REFRESH_TOP, stats=stats)
        if items is None:
            print("轻刷失败: Everything 查询未成功，请确认 Everything 正在运行")
            return
        old_items = view["contents"].get(target_dir, [])
        old_total = sum(s for _, _, s in old_items if isinstance(s, (int, float)))
        new_total = sum(s for _, _, s in items)
        view["contents"][target_dir] = items
        last_data_time = datetime.now()  # 轻刷完成 → 状态栏数据时间刷新
        sign = "+" if new_total >= old_total else "-"
        summary = f"已轻刷: 文件+{len(items)} / 净{sign}{human_size(abs(new_total - old_total))}~"
        unknown_count = int(stats.get("unknown_size_count") or 0)
        if unknown_count > 0:
            summary += f"，{unknown_count} 条大小未知"
        print(summary)

    def _handle_root_light_refresh():
        """r@根指纹门：缓存指纹与最新指纹一致 → 「数据未变」毫秒返回；否则升级深刷。

        比较基线取 FINGERPRINT_CACHE 旧条目，最新指纹经 compute_fingerprint
        （60s 内命中内部缓存直接返回 → 即为「毫秒级」门控命中）。相等判定走
        fingerprints_equal：任一探测失败（ok=False）恒判不等 → 升级深刷，
        继承 R 的保护（冷却检查 + in_progress 由调用分支保证），不崩溃。
        """
        cached = scan.FINGERPRINT_CACHE.get(scan.fingerprint_key(root_path))
        fresh = compute_fingerprint(root_path)
        if cached is not None and fingerprints_equal(cached[0], fresh):
            print(render_message("INFO_FINGERPRINT_SAME"))
            return
        remain = _cooldown_remaining()
        if remain > 0:
            print(f"深刷冷却中: 约 {int(remain)} 秒后可再次深刷")
        else:
            print("深扫已启动: 按 Esc 可取消")
            _start_deep_refresh()

    def _consume_pending():
        """深扫完成后消费合并待办（cap-1）：补一次当前目录轻刷，不连锁深扫。"""
        if scan_state["pending_r"] and not scan_state["in_progress"]:
            scan_state["pending_r"] = False
            _do_light_refresh(current_path)

    def _show_history_view():
        """D8 H 历史对比模态：选基线快照 → compare.diff_from_current → 增量视图。

        无快照/序号非法/读取失败 → 横幅返回列表态；CompareError（跨根/盘/机器
        不一致）→ 红字打印原因返回；成功 → 清屏打印标题 + 前 list_height 行
        format_row（增量降序）+ 「按任意键返回」（_getch 读一键后返回列表态）。
        全部提示不阻塞主循环、绝不抛出。
        """
        paths = snapshots.list_snapshots(root_path)
        if not paths:
            print(_warn_banner("该根暂无历史快照"))
            return
        _clear_screen()
        print("历史快照 (最近的在前, 空回车=取最新):")
        for idx, path in enumerate(paths, 1):
            print("  %d. %s" % (idx, _snapshot_display_time(path)))
        print("请输入序号 (空回车=最新; Ctrl+C=取消):")
        try:
            _show_cursor()
            raw = input()
        except (KeyboardInterrupt, EOFError):
            return
        finally:
            _hide_cursor()
        raw = raw.strip()
        if raw:
            if not raw.isdigit():
                print(_warn_banner("无效序号, 已返回列表"))
                return
            idx = int(raw)
            if not (1 <= idx <= len(paths)):
                print(_warn_banner("无效序号, 已返回列表"))
                return
            chosen = paths[idx - 1]
        else:
            chosen = paths[0]  # 空回车 = 取最新（列表已按时间降序）
        try:
            baseline = snapshots.load_snapshot(chosen)
        except (snapshots.SnapshotCorruptError, OSError, ValueError) as exc:
            print(_warn_banner("快照读取失败: %s" % exc))
            return
        baseline_time = str(baseline["header"].get("created_at", "")).replace("T", " ")
        if not baseline_time.strip():
            baseline_time = "未知时间"
        try:
            diff_result = compare.diff_from_current(view["sizes"], baseline["rows"])
        except compare.CompareError as exc:
            print(_red_text("历史对比失败(跨根/机器不匹配): %s" % exc))
            return
        _clear_screen()
        print("历史对比: %s → 当前" % baseline_time)
        for row in diff_result["rows"][:list_height]:
            print(compare.format_row(row))
        if diff_result.get("truncated"):
            print("(对比行数超限, 已截断)")
        print("按任意键返回")
        _getch()

    def _save_snapshot_now():
        """D8 S 保存快照模态（无输入）：禁用 → 提示；成功 → INFO_SNAPSHOT_SAVED+路径；
        失败（SnapshotBusyError/OSError/ValueError）→ 中文警告横幅，不阻塞主循环。"""
        if snapshots.is_snapshot_disabled():
            print(_warn_banner("快照功能已禁用(DSA_NO_SNAPSHOT 已设置)"))
            return
        rows = [{"p": str(p), "s": int(v)} for p, v in view["sizes"].items()]
        try:
            saved = snapshots.save_snapshot(root_path, rows, auto=False)
        except snapshots.SnapshotBusyError as exc:
            print(_warn_banner("快照保存失败(另一保存正在进行): %s" % exc))
            return
        except (OSError, ValueError) as exc:
            print(_warn_banner("快照保存失败: %s" % exc))
            return
        if saved is not None:
            print("%s: %s" % (render_message("INFO_SNAPSHOT_SAVED"), saved))
        else:
            print(_warn_banner("快照保存未完成"))

    while True:
        _apply_scan_result()

        term_size = shutil.get_terminal_size()
        term_height = term_size.lines
        list_height = max(5, term_height - 7)

        _clear_screen()

        if term_height < MIN_TERM_HEIGHT:
            # D8 终端行门：过小只显示居中提示 + 状态栏，跳过列表渲染；仍响应 Q 退出，
            # resize 后下一轮循环按新尺寸自动恢复
            items = []
            print(_center_text(render_message("E_TERM_TOO_SMALL"), term_size.columns))
            print(_format_status_bar(root_path, current_path, last_data_time))
        else:
            _maybe_show_first_launch_guide()

            print(f"=== {APP_NAME} ===")
            print(f"内核驱动: {driver_name}")
            print(f"当前路径: {current_path}")
            print(f"当前目录总计: {human_size(view['sizes'].get(current_path, 0))}")
            print("-" * 75)

            items = view["contents"].get(current_path, [])
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
            print(keyrouter.help_text())
            # D8 状态栏：反转色常驻底行（ANSI 可用时），回退纯文本
            print(_format_status_bar(root_path, current_path, last_data_time))

        key = _getch()
        if key in (b'\xe0', b'\x00'):  # 扩展键/Alt 组合：首字节为 0xe0 或 0x00，再读第二字节
            key = key + _getch()
        action = keyrouter.key_to_action(key)  # 纯函数键位路由（D2）
        if action == keyrouter.ACT_MOVE_UP:
            if items:
                selected_idx = max(0, selected_idx - 1)
        elif action == keyrouter.ACT_MOVE_DOWN:
            if items:
                selected_idx = min(len(items) - 1, selected_idx + 1)
        elif action == keyrouter.ACT_ENTER:  # Enter 进入目录
            if items and items[selected_idx][1]:
                current_path = current_path / items[selected_idx][0]
                selected_idx = 0
        elif action == keyrouter.ACT_BACK:  # Backspace 返回上级
            if current_path != root_path:
                current_path = current_path.parent
                selected_idx = 0
        elif action == keyrouter.ACT_QUIT:
            return ('quit', None)
        elif action == keyrouter.ACT_CHANGE_ROOT:
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
        elif action == keyrouter.ACT_PATH_JUMP:
            # D5: / 路径跳转 —— 根内跳转模态，不触发重扫（换根重扫仍走 C）
            target, jumped = _run_path_input(current_path, root_path, jump_history)
            if jumped:
                # 仅成功跳转的路径入历史（去重后插头部，上限 JUMP_HISTORY_MAX）
                _push_jump_history(jump_history, target)
                current_path = Path(target)
                selected_idx = 0
                if target not in view["contents"]:
                    print("该目录未在本次扫描结果中,已按目录跳转")
                    # 惰性 contents 兜底：尝试按需构建条目，未知目录返回 []，保持不崩溃
                    view["contents"].get(target, [])
        elif action == keyrouter.ACT_SAVE_SNAPSHOT:
            # D8: S 保存快照 —— 模态（无输入, 直接落盘; 失败中文横幅, 不阻塞主循环）
            _save_snapshot_now()
        elif action == keyrouter.ACT_HISTORY:
            # D8: H 历史对比 —— 选基线快照 → diff_from_current → 增量降序视图
            _show_history_view()
        elif action == keyrouter.ACT_HELP:
            # D8: h 全屏帮助 —— 键位表/快照位置/口径说明, 任意键返回列表态
            _show_full_help()
        elif action == keyrouter.ACT_REFRESH_LIGHT:
            # D4: r 轻刷 —— 在途合并待办(cap-1) / r@根指纹门 / 非根直接轻刷
            if scan_state["in_progress"]:
                scan_state["pending_r"] = True  # 合并待办，不重复执行
                print(render_message("E_SCAN_IN_PROGRESS"))
            elif current_path == root_path:
                _handle_root_light_refresh()  # 指纹门：命中数据未变 / 脏则升级深刷
            else:
                _do_light_refresh(current_path)
        elif action == keyrouter.ACT_REFRESH_DEEP:
            # D4: R 深刷 —— 60s 冷却未到且非在途 → 冷却提示；在途 → 合并待办(cap-1)
            if scan_state["in_progress"]:
                scan_state["pending_r"] = True  # 合并待办 cap-1（E_BUSY 语义）
                print(render_message("E_BUSY"))
            else:
                remain = _cooldown_remaining()
                if remain > 0:
                    print(f"深刷冷却中: 约 {int(remain)} 秒后可再次深刷")
                else:
                    print("深扫已启动: 按 Esc 可取消")
                    _start_deep_refresh()

        # D4: Esc 取消在途深扫（Esc → ACT_NONE，仅在深扫进行中生效）
        if action == keyrouter.ACT_NONE and key == b"\x1b" and scan_state["in_progress"]:
            if scan_state["cancel_event"] is not None:
                scan_state["cancel_event"].set()
                print("深扫取消请求已发送(Esc)")

        # 深扫线程状态上报与合并待办消费（横幅/摘要均为文本行，不阻塞主循环）
        _report_scan_finish()
        _consume_pending()