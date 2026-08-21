"""命令行入口模块（C3 拆分自 main.py；D1 增加命令行参数与非交互模式；D2 增加
UTF-8 流重配置与 --quiet 静默非交互过程日志）。

职责：组合各模块完成主控制流——解析命令行参数（可选 target、--top 与 --quiet），按
是否提供 target 分派：交互模式（等待输入目标路径、初始化作业对象沙盒、确保
Everything 运行环境就绪、执行 Everything SDK 扫描、进入交互界面并处理切换
路径/退出）或非交互模式（同一条 env 启动/等待 + scan 链路，打印 Top-N 目录
占用报告后退出，不进入 TUI）。交互路径的输出文案与 UX 与拆分前逐字一致。

main() 启动最早处调用 utils._reconfigure_std_streams()：把 stdout/stderr 重配置为
UTF-8（GBK 控制台/管道下 print 中文与 emoji 不再 UnicodeEncodeError，测试接管
stdout 时静默跳过）。--quiet 仅非交互模式生效：把进程内 utils.VERBOSE 置 False，
抑制 🚀/🧩 等过程日志与 \r 进度行；Top-N 报告与 _fatal/扫描失败等必要输出不经
VERBOSE 门控、始终保留；交互模式下 --quiet 同 --top 一样被忽略。

本模块是装配层（依赖 env/sdk/scan/tui/utils/exceptions），不定义业务状态；
不 import main，也不被任何其他模块 import（main.py 仅从本模块取 main）。
"""

import argparse
import gc
import sys
from pathlib import Path

import utils
from utils import (
    APP_NAME,
    _exit_with_error,
    _fatal,
    _reconfigure_std_streams,
    human_size,
    log,
)
from exceptions import EverythingEnvironmentError, MsvcrtUnavailableError
from env import ensure_everything_running, init_windows_job_sandbox
from scan import _is_scan_root, scan_via_everything_sdk
from tui import _clear_screen, _getch, interactive_ui


def prompt_target_drive():
    """运行入口处再询问扫描路径，避免 import main 时阻塞测试或复用。"""
    return input("请输入扫描的目标路径 (例如 C:\\Users 或 D:\\): ").strip()


def _parse_top_n(raw):
    """--top 参数值解析：仅接受 1-200 的整数，非法值报 argparse 错误（退出码 2）。"""
    try:
        value = int(raw)
    except ValueError:
        raise argparse.ArgumentTypeError(f"无效的 --top 值：{raw!r}（应为 1-200 的整数）")
    if not 1 <= value <= 200:
        raise argparse.ArgumentTypeError(f"无效的 --top 值：{value}（应为 1-200 的整数）")
    return value


def _parse_args(argv):
    """argparse 参数定义：可选位置参数 target + --top N（默认 10，校验 1-200）+ --quiet。"""
    parser = argparse.ArgumentParser(
        description=(
            f"{APP_NAME}（Everything SDK 高速扫描目录占用）。"
            "提供 TARGET 进入非交互模式：扫描后打印 Top-N 目录占用报告并退出；"
            "不带参数进入交互界面。"
        ),
    )
    parser.add_argument(
        "target",
        nargs="?",
        default=None,
        metavar="TARGET",
        help="可选扫描路径；提供后进入非交互模式，缺省进入交互模式。",
    )
    parser.add_argument(
        "--top",
        metavar="N",
        type=_parse_top_n,
        default=10,
        help="非交互模式下打印的目录条数（1-200，默认 10）；交互模式下忽略。",
    )
    parser.add_argument(
        "--quiet",
        action="store_true",
        help=(
            "非交互模式下仅输出 Top-N 报告与错误信息，抑制 🚀/🧩 等过程日志"
            "与扫描进度行（\r），便于下游脚本逐行解析；交互模式下忽略。"
        ),
    )
    return parser.parse_args(argv)


def main(argv=None):
    """程序入口：解析命令行参数（argv 缺省取 sys.argv[1:]）后按 target 分派。

    - 启动最早处重配置 stdout/stderr 为 UTF-8（_reconfigure_std_streams），
      保证 GBK 控制台/管道下中文与 emoji 输出不抛 UnicodeEncodeError；
    - 未提供 target（含只给 --top/--quiet）→ 交互模式 _run_interactive，
      行为与拆分前逐字一致，--quiet 被忽略；
    - 提供 target → 非交互模式 _run_headless，打印 Top-N 报告后以退出码 0 结束；
      --quiet 生效时把进程内 VERBOSE 置 False：过程日志与进度行静默，
      Top-N 报告与 _fatal/扫描失败等必要输出始终保留。
    """
    _reconfigure_std_streams()
    args = _parse_args(argv)
    if args.quiet and args.target is not None:
        utils.VERBOSE = False
    log(f"🚀 {APP_NAME}启动中...")
    if args.target is None:
        return _run_interactive()
    return _run_headless(args.target, args.top, args.quiet)


def _run_interactive():
    """交互模式主流程：与拆分前 cli.main() 逐字一致（提示输入 → 环境就绪 → 扫描 → TUI 循环）。"""
    target_drive = prompt_target_drive()
    init_windows_job_sandbox()
    try:
        ensure_everything_running()  # 确保 Everything 已启动
    except EverythingEnvironmentError as e:
        _fatal(str(e))

    root_path_obj = Path(target_drive).resolve()
    if not root_path_obj.exists():
        _fatal(f"错误: 指定的扫描路径不存在: {root_path_obj}")

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
        try:
            action, result = interactive_ui(root_path_obj, dir_sizes, dir_contents, driver_label)
        except MsvcrtUnavailableError as e:
            _exit_with_error(e)
        if action == 'quit':
            _clear_screen()
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
                try:
                    _getch()
                except MsvcrtUnavailableError as e:
                    _exit_with_error(e)
                # 继续使用旧路径
        else:
            break


def _run_headless(raw_target, top_n, quiet=False):
    """非交互模式：路径校验 → 作业沙盒 → 环境就绪 → 扫描 → 打印 Top-N 报告。

    quiet=True 时把进程内 utils.VERBOSE 置 False（与 main() 的 --quiet 处理幂等，
    保证直接调用本函数也能获得同样的静默语义）；Top-N 报告与错误输出（_fatal/
    扫描失败文案）不经 VERBOSE 门控，始终输出。

    与交互模式复用同一条 env 启动/等待 + scan 链路，但不进入 TUI、不调用
    interactive_ui；正常路径以退出码 0 结束，报告为简洁中文纯文本版式。
    """
    if quiet:
        utils.VERBOSE = False
    root_path_obj = Path(raw_target).resolve()
    if not root_path_obj.exists():
        _fatal(f"错误: 指定的扫描路径不存在: {root_path_obj}")

    init_windows_job_sandbox()
    try:
        ensure_everything_running()  # 确保 Everything 已启动
    except EverythingEnvironmentError as e:
        _fatal(str(e))

    try:
        dir_sizes, _unused_contents = scan_via_everything_sdk(root_path_obj)
    except Exception as e:
        print(f"扫描失败: {e}")
        sys.exit(1)

    _print_top_n_report(root_path_obj, dir_sizes, top_n)


def _print_top_n_report(root_path_obj, dir_sizes, top_n):
    """打印 Top-N 目录占用报告（简洁中文版式，无 ANSI 转义/装饰符号）。

    从 sizes 中剔除扫描根自身后按聚合大小降序取前 top_n 个目录（不足全列）；
    每行「大小（human_size 右对齐） 路径」；末行合计=扫描根总大小与目录总数。
    """
    entries = [
        (size, path)
        for path, size in dir_sizes.items()
        if not _is_scan_root(path, root_path_obj)
    ]
    entries.sort(key=lambda item: (-item[0], str(item[1]).casefold()))
    total_size = dir_sizes.get(root_path_obj, 0)
    total_dirs = len(entries)

    print(f"\nTop {top_n} 目录占用排行:")
    for size, path in entries[:top_n]:
        print(f"{human_size(size):>12}  {path}")
    print(f"{human_size(total_size):>12}  合计: 共 {total_dirs} 个目录")