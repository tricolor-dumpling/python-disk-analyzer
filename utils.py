"""通用工具与全局配置模块（C3 拆分自 main.py）。

集中存放与具体业务无关的基础设施：应用名（APP_NAME）、日志开关（VERBOSE/log）、
人类可读大小格式化（human_size）、致命错误出口（_fatal/_exit_with_error）、
应用目录与配置路径（get_app_dir/SCRIPT_DIR/CONFIG_PATH）。

VERBOSE 为模块级可变全局，本模块的 log() 直接读取；其他模块如需关闭/恢复
日志输出，请通过「utils.VERBOSE = ...」写回（main 命名空间已动态转发到此处）。
_reconfigure_std_streams() 为 UTF-8 流重配置助手，由 cli.main() 在启动最早处调用
（不在 import 时调用，避免测试/嵌入方接管的流在导入期被改动）；本模块不依赖
任何项目内其他模块。
"""

import os
import sys
from pathlib import Path

# =================【全局配置与提示】=================
APP_NAME = "Python 智能磁盘分析工具"

VERBOSE = True


def _reconfigure_std_streams():
    """把 stdout/stderr 重配置为 UTF-8 输出（errors='replace'），全程防御、绝不抛异常。

    覆盖场景：
    - 真实 TextIOWrapper（控制台/重定向管道/文件）→ reconfigure 生效，编码切到 utf-8，
      GBK 代码页下 print 中文/emoji 不再抛 UnicodeEncodeError；
    - 测试或嵌入调用方接管的流（StringIO 等无 reconfigure 属性）→ 静默跳过；
    - 二进制流、自定义流、已关闭流、sys.stdout/stderr 为 None → 静默跳过。

    不 spawn 任何子进程（不使用 chcp 65001），零进程开销、零额外失败面。Windows
    真实控制台的渲染走 WriteConsoleW（UTF-16），与代码页无关；emoji 在旧式点阵字体
    下显示为方块属显示层问题，不影响管道/文件输出的字节正确性（UTF-8）。
    """
    for name in ("stdout", "stderr"):
        stream = getattr(sys, name, None)
        if stream is None:
            continue
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is None:
            continue
        try:
            reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


def get_app_dir():
    """源码运行时返回脚本目录；PyInstaller 打包后返回 exe 所在目录。"""
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


SCRIPT_DIR = get_app_dir()
# config.json 是启动加速缓存：路径存在才使用，失效时会自动重新探测。
CONFIG_PATH = SCRIPT_DIR / "config.json"


def log(message="", *, end="\n", flush=False, verbose=None):
    """统一状态输出入口，测试或嵌入调用时可关闭 verbose。"""
    enabled = VERBOSE if verbose is None else verbose
    if enabled:
        print(message, end=end, flush=flush)


def human_size(n: int) -> str:
    """人类可读的文件大小格式化"""
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024:
            return f"{n:.2f} {unit}"
        n /= 1024
    return f"{n:.2f} PB"


def _fatal(msg):
    """致命错误统一出口：打印（带 ❌ 前缀）并立即以退出码 1 结束进程。"""
    print(f"❌ {msg}")
    sys.exit(1)


def _exit_with_error(e):
    """打印致命交互错误并立即退出（msvcrt 不可用等统一走这里）。"""
    _fatal(str(e))