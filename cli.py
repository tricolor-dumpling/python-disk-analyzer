"""命令行入口模块（C3 拆分自 main.py；D1 增加命令行参数与非交互模式；D2 增加
UTF-8 流重配置与 --quiet 静默非交互过程日志；D3 增加 --export/--output 目录
占用报告导出 CSV/JSON；D9 增加 --snapshot-dir/--no-snapshot/--baseline 与
干净退出自动保存快照）。

职责：组合各模块完成主控制流——解析命令行参数（可选 target、--top、--quiet 与
--export/--output），按是否提供 target 分派：交互模式（等待输入目标路径、初始化
作业对象沙盒、确保 Everything 运行环境就绪、执行 Everything SDK 扫描、进入交互
界面并处理切换路径/退出）或非交互模式（同一条 env 启动/等待 + scan 链路，打印
Top-N 目录占用报告后退出；--export 时另把全部目录聚合占用导出到 CSV/JSON 文件，
不进入 TUI）。交互路径的输出文案与 UX 与拆分前逐字一致。

D9 快照集成（装配层职责扩展）：
- --snapshot-dir PATH 覆盖快照目录（写入 DSA_SNAPSHOT_DIR 环境变量，交互与非
  交互模式都生效）；--no-snapshot 置 DSA_NO_SNAPSHOT=1 禁用自动保存；
- --baseline PATH 在非交互模式加载基线快照，与本次扫描 sizes 经
  compare.diff_from_current 对比后按 Top-N 打印 format_row 版式变化报告；
- 交互主流程正常退出（Q 或主循环结束）统一归口 _auto_save_on_exit：四原子谓词
  （snapshots.should_auto_save）通过则 save_snapshot(auto=True) 落盘退出快照并
  补齐台账；失败/未通过一律静默（仅 verbose 提示），绝不阻塞/干扰退出流程。

main() 启动最早处调用 utils._reconfigure_std_streams()：把 stdout/stderr 重配置为
UTF-8（GBK 控制台/管道下 print 中文与 emoji 不再 UnicodeEncodeError，测试接管
stdout 时静默跳过）。--quiet 仅非交互模式生效：把进程内 utils.VERBOSE 置 False，
抑制 🚀/🧩 等过程日志与 \r 进度行；Top-N 报告与 _fatal/扫描失败等必要输出不经
VERBOSE 门控、始终保留；交互模式下 --quiet 同 --top/--export/--output 一样被忽略。

--export/--output 仅非交互模式生效：--export 取值 csv/json（非法值报 argparse
错误，退出码 2），--output 需与 --export 搭配（headless 下单独给出 --output 报
argparse 错误，退出码 2）；导出全部目录（含扫描根与各级子目录）的聚合占用，不受
--top 限制；--output 未指定时按 _default_export_path 在数据目录 exports\ 下自动命名
disk_report_YYYYMMDD_HHMMSS.<csv|json>；写文件失败（OSError，如目录不可写）→
打印中文提示（非 ANSI）并退出码 1；成功后的确认行经 log() 输出，--quiet 下被
抑制（保持 D2「仅输出 Top-N 报告与错误信息」的静默契约）。

本模块是装配层（依赖 env/sdk/scan/tui/utils/exceptions），不定义业务状态；
不 import main，也不被任何其他模块 import（main.py 仅从本模块取 main）。
"""

import argparse
import csv
import datetime
import gc
import io
import json
import os
import sys
from pathlib import Path

import utils
import datadir
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
import scan  # P12·W2.1：SCAN_LOCK 经模块属性访问（可 patch）
from scan import _is_scan_root, compute_fingerprint, scan_via_everything_sdk
from compare import CompareError, diff_from_current, format_row, top_growth
from snapshots import (
    SnapshotCorruptError,
    consume_last_save_notice,
    get_machine_guid,
    get_snapshot_dir,
    is_snapshot_disabled,
    load_ledger,
    load_snapshot,
    save_snapshot,
    should_auto_save,
    update_ledger_after_save,
)
from tui import _clear_screen, _getch, interactive_ui


def prompt_target_drive(max_attempts=3):
    """运行入口处再询问扫描路径，避免 import main 时阻塞测试或复用。

    P12·W2.12（DEF-024）：管道喂 EOF / Ctrl-C → 「已取消输入，退出。」并
    sys.exit(1)，不再让 None/异常静默向下走；空输入重问，≤max_attempts 次
    仍为空 → 同款 fatal，杜绝静默扫描 cwd。
    """
    for attempt in range(1, max_attempts + 1):
        try:
            raw = input("请输入扫描的目标路径 (例如 C:\\Users 或 D:\\): ").strip()
        except (EOFError, KeyboardInterrupt):
            print("已取消输入，退出。")
            sys.exit(1)
        if raw:
            return raw
        remaining = max_attempts - attempt
        if remaining > 0:
            print(f"路径为空，请重新输入（还可尝试 {remaining} 次）")
    print("错误: 扫描路径为空")
    sys.exit(1)


def _parse_top_n(raw):
    """--top 参数值解析：仅接受 1-200 的整数，非法值报 argparse 错误（退出码 2）。"""
    try:
        value = int(raw)
    except ValueError:
        raise argparse.ArgumentTypeError(f"无效的 --top 值：{raw!r}（应为 1-200 的整数）")
    if not 1 <= value <= 200:
        raise argparse.ArgumentTypeError(f"无效的 --top 值：{value}（应为 1-200 的整数）")
    return value


def _parse_export_format(raw):
    """--export 取值解析：仅接受 csv/json，非法值报 argparse 错误（退出码 2）。"""
    if raw not in ("csv", "json"):
        raise argparse.ArgumentTypeError(f"无效的 --export 值：{raw!r}（应为 csv 或 json）")
    return raw


def _parse_args(argv):
    """argparse 参数定义：可选位置参数 target + --top N（默认 10，校验 1-200）+
    --quiet + --export/--output（目录占用报告导出）。headless 下 --output 未搭配
    --export 时在解析期报 argparse 错误（退出码 2）；交互模式（无 target）忽略。"""
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
    parser.add_argument(
        "--export",
        metavar="{csv,json}",
        type=_parse_export_format,
        default=None,
        help=(
            "非交互模式下把目录占用报告导出到文件：csv 或 json。导出全部目录"
            "（含扫描根与各级子目录）的聚合占用大小，不受 --top 限制；仅目录级"
            "聚合（不含文件明细）。--quiet 不影响导出文件生成，屏幕 Top-N 报告"
            "照常打印。交互模式下忽略。"
        ),
    )
    parser.add_argument(
        "--output",
        metavar="PATH",
        default=None,
        help=(
            "导出文件路径（需与 --export 搭配）。未指定时在当前目录自动命名"
            "disk_report_YYYYMMDD_HHMMSS.<csv|json>，格式后缀跟随 --export。"
            "交互模式下忽略。"
        ),
    )
    parser.add_argument(
        "--snapshot-dir",
        metavar="PATH",
        default=None,
        help=(
            "覆盖快照存储目录（等效设置 DSA_SNAPSHOT_DIR 环境变量）；交互与非"
            "交互模式均生效。不指定时使用默认目录（见 README「快照存储位置」）。"
        ),
    )
    parser.add_argument(
        "--no-snapshot",
        action="store_true",
        help=(
            "禁用快照自动保存（等效 DSA_NO_SNAPSHOT=1）：交互模式干净退出不再"
            "自动落盘退出快照。"
        ),
    )
    parser.add_argument(
        "--baseline",
        metavar="PATH",
        default=None,
        help=(
            "非交互模式下指定基线快照文件（.snap.gz）：加载该快照并与本次扫描"
            "结果对比，按变化量打印 Top-N 对比报告（compare.format_row 版式）；"
            "交互模式下忽略。"
        ),
    )
    parser.add_argument(
        "--allow-other-machine",
        action="store_true",
        default=False,
        help=(
            "允许与其它机器生成的基线快照对比，数字仅供参考"
            "（P12·W2.13：默认拦截异机基线）。"
        ),
    )
    parsed = parser.parse_args(argv)
    if parsed.target is not None and parsed.output is not None and parsed.export is None:
        parser.error("--output 需要与 --export 搭配使用（例如 --export csv --output 报告.csv）")
    return parsed


def main(argv=None):
    """程序入口：解析命令行参数（argv 缺省取 sys.argv[1:]）后按 target 分派。

    - 启动最早处重配置 stdout/stderr 为 UTF-8（_reconfigure_std_streams），
      保证 GBK 控制台/管道下中文与 emoji 输出不抛 UnicodeEncodeError；
    - 未提供 target（含只给 --top/--quiet/--export/--output/--baseline）→ 交互模式
      _run_interactive，行为与拆分前逐字一致，--quiet/--export/--output/--baseline
      被忽略（--snapshot-dir/--no-snapshot 例外，两种模式都生效）；
    - 提供 target → 非交互模式 _run_headless，打印 Top-N 报告后以退出码 0 结束；
      --quiet 生效时把进程内 VERBOSE 置 False：过程日志与进度行静默，
      Top-N 报告与 _fatal/扫描失败等必要输出始终保留；
    - --snapshot-dir PATH 覆盖快照目录、--no-snapshot 禁用自动保存（均写入对应
      环境变量，交互/非交互都生效）；--baseline PATH 在非交互模式加载基线快照、
      与本次扫描 diff 后按 Top-N 打印对比报告（缺失/损坏 → 中文提示 + 退出码 1）；
    - --export csv|json 时把全部目录聚合占用导出到文件（不受 --top 限制），
      --output 未指定时在当前目录自动命名；导出写失败 → 中文提示 + 退出码 1。
    """
    _reconfigure_std_streams()
    args = _parse_args(argv)
    # D9：--snapshot-dir / --no-snapshot 在两种模式下都生效（写入环境变量，
    # snapshots 模块的 get_snapshot_dir / is_snapshot_disabled 会读取）。
    if args.snapshot_dir is not None:
        os.environ["DSA_SNAPSHOT_DIR"] = str(Path(args.snapshot_dir).resolve())
    if args.no_snapshot:
        os.environ["DSA_NO_SNAPSHOT"] = "1"
    if args.quiet and args.target is not None:
        utils.VERBOSE = False
    log(f"🚀 {APP_NAME}启动中...")
    if args.target is None:
        return _run_interactive()
    return _run_headless(
        args.target, args.top, args.quiet, args.export, args.output,
        args.baseline,
        allow_other_machine=bool(getattr(args, "allow_other_machine", False)),
    )


def _run_interactive():
    """交互模式主流程：与拆分前 cli.main() 逐字一致（提示输入 → 环境就绪 → 扫描 → TUI 循环）。

    D9：主循环正常退出（Q / 其他分支 break）后统一归口 _auto_save_on_exit，
    仅当本会话完成过 ≥1 次完整扫描且快照未禁用时才可能落盘退出快照。
    """
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
    completed_scans = 0  # D9：本会话完成的完整扫描次数（干净退出自动保存条件之一）

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

        completed_scans += 1

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

    # D9：干净退出自动保存统一归口（Q 或主循环结束后的正常退出路径）。
    # 扫描失败 / 环境错误等异常退出（sys.exit 提前返回）不会走到这里。
    if completed_scans > 0:
        _auto_save_on_exit(root_path_obj, dir_sizes)


def _auto_save_on_exit(root, sizes):
    """干净退出自动保存（D9）：条件满足时把最终扫描树落盘为 auto 快照。

    条件：is_snapshot_disabled() 为 False 且本会话完成过完整扫描（调用方保证
    completed_scans > 0 才调用本函数；真实扫描 sizes 必含根键，空 dict 是仅
    测试/退化输入，直接跳过，避免把空树写进真实快照目录）。

    链路：rows 由最终 sizes（{Path: int}）生成 [{p, s}] →
    fingerprint=compute_fingerprint(root) → ledger=load_ledger() →
    should_auto_save 四原子谓词（完整树 ∧ 非脏 ∧ 指纹变 ∧ 当日未落）→ 通过则
    save_snapshot(auto=True) → 成功后 update_ledger_after_save 补齐台账；
    失败/未通过一律静默（仅 verbose 提示），任何意外异常被消化，绝不阻塞、
    干扰或改变正常退出流程。
    """
    try:
        if is_snapshot_disabled() or not sizes:
            return
        # P12·W2.1：指纹探测段统一持 SDK 锁（与 Web 健康探测/对比互斥）
        with scan.SCAN_LOCK:
            fingerprint = compute_fingerprint(root)
        rows = [{"p": str(path), "s": size} for path, size in sizes.items()]
        dir_path = get_snapshot_dir()
        ledger = load_ledger(dir_path)
        ok, reason = should_auto_save(
            root,
            tree_complete=True,
            dirty=False,
            fingerprint=fingerprint,
            ledger=ledger,
        )
        if not ok:
            if utils.VERBOSE:
                log(f"📝 跳过退出自动保存（{reason}）")
            return
        try:
            saved = save_snapshot(
                root,
                rows,
                auto=True,
                dir_path=dir_path,
                machine_guid=get_machine_guid(),
                fingerprint=fingerprint,
            )
        except Exception as exc:  # SnapshotBusyError/OSError/ValueError 等一律静默
            if utils.VERBOSE:
                log(f"📝 退出自动保存失败: {exc}")
            return
        if saved is not None:
            update_ledger_after_save(root, fingerprint, auto=True, dir_path=dir_path)
            if utils.VERBOSE:
                log(f"📝 已自动保存退出快照: {saved}")
        # P12·W2.2：消费保存通知（auto 硬门槛跳过等），verbose 下记录一行
        notice = consume_last_save_notice()
        if notice is not None and utils.VERBOSE:
            log(f"⚠️ {notice.get('message') or '保存提示'}")
    except Exception:
        # 自动保存绝不影响正常退出：任何意外（含指纹探测异常）静默跳过
        if utils.VERBOSE:
            log("📝 退出自动保存跳过（异常）")


def _run_headless(
    raw_target, top_n, quiet=False, export_format=None, output=None,
    baseline_path=None, allow_other_machine=False,
):
    """非交互模式：路径校验 → 作业沙盒 → 环境就绪 → 扫描 → 打印 Top-N 报告 →（可选）导出。

    quiet=True 时把进程内 utils.VERBOSE 置 False（与 main() 的 --quiet 处理幂等，
    保证直接调用本函数也能获得同样的静默语义）；Top-N 报告与错误输出（_fatal/
    扫描失败文案）不经 VERBOSE 门控，始终输出。

    baseline_path 非 None 时（--baseline）：扫描前即校验/加载基线快照（缺失/
    损坏 → 中文提示 + 退出码 1，fail fast），扫描后把当前 sizes 与基线行经
    compare.diff_from_current 对比，按 Top-N 打印 format_row 版式变化报告
    （跨盘/根不一致 → CompareError → 中文提示 + 退出码 1）。

    export_format 为 'csv' 或 'json' 时，把扫描得到的全部目录聚合占用写入文件：
    - 导出范围不受 top_n 影响（--top 只作用于屏幕 Top-N 报告），含扫描根与各级
      子目录；数据源为 scan_via_everything_sdk 返回的 sizes（Path→int）；
    - output 未指定时用 _default_export_path 在数据目录 exports\ 下自动命名，后缀跟随格式；
    - 写文件失败（OSError，如目录不可写）→ 打印中文提示（非 ANSI）并以退出码 1
      结束；成功后的确认行经 log() 输出，--quiet 下被抑制（保持 D2 静默契约）。

    与交互模式复用同一条 env 启动/等待 + scan 链路，但不进入 TUI、不调用
    interactive_ui；正常路径以退出码 0 结束，报告为简洁中文纯文本版式。
    """
    if quiet:
        utils.VERBOSE = False
    # P12·W2.12（DEF-023）：空路径此前会 resolve 成 cwd 静默扫描当前目录，
    # 改为显式 fatal（退出码 1），与「路径不存在」同款出口。
    if not raw_target or not str(raw_target).strip():
        _fatal("错误: 扫描路径为空")
    root_path_obj = Path(raw_target).resolve()
    if not root_path_obj.exists():
        _fatal(f"错误: 指定的扫描路径不存在: {root_path_obj}")
    baseline = None
    if baseline_path is not None:
        baseline = _prepare_baseline(baseline_path)  # 缺失/损坏 → 中文提示 + 退出码 1

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

    if baseline is not None:
        _print_baseline_report(baseline, dir_sizes, baseline_path, top_n,
                           allow_other_machine=allow_other_machine)

    if export_format is not None:
        output_path = Path(output) if output is not None else _default_export_path(export_format)
        try:
            export_report(root_path_obj, dir_sizes, export_format, output_path)
        except OSError as e:
            print(f"导出报告失败: {e}")
            sys.exit(1)
        log(f"📄 已导出目录占用报告: {output_path}")


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


def _prepare_baseline(baseline_path):
    """校验并加载 --baseline 快照；文件缺失/损坏/读取失败 → 中文提示 + 退出码 1。

    在扫描/环境就绪之前调用（fail fast）：缺文件、gzip 损坏、头部 CRC/字段
    校验失败（SnapshotCorruptError）都是用户可修正的输入问题；文案走 headless
    简洁纯文本契约（无 ❌/ANSI 装饰符）。
    """
    path = Path(baseline_path)
    if not path.exists():
        print(f"基线快照不存在: {path}")
        sys.exit(1)
    try:
        return load_snapshot(path)
    except SnapshotCorruptError as exc:
        print(f"基线快照损坏或无法解析: {exc}")
        sys.exit(1)
    except OSError as exc:
        print(f"基线快照读取失败: {exc}")
        sys.exit(1)


def _print_baseline_report(baseline, dir_sizes, baseline_path, top_n,
                           allow_other_machine=False):
    """打印与基线快照的 Top-N 变化对比（compare.format_row 版式，纯文本无 ANSI）。

    数据源：当前扫描 sizes 不落盘，与基线行经 compare.diff_from_current 对比；
    root 由两域路径集合公共前缀推导，跨盘/根不一致（CompareError）→ 中文提示 +
    退出码 1。行序与增速列口径与 TUI 历史对比一致（top_growth 取 delta 降序前 N）。
    P12·W2.13：默认携带本机 machine_guid 强校验——异机基线被拦截
    （CompareError.kind=="machine_mismatch"），--allow-other-machine 显式放行。
    """
    try:
        result = diff_from_current(
            dir_sizes,
            baseline.get("rows") or [],
            machine_guid=baseline.get("header", {}).get("machine_guid"),
            local_machine_guid=get_machine_guid(),
            allow_other_machine=allow_other_machine,
        )
    except CompareError as exc:
        print(f"对比失败: {exc}")
        sys.exit(1)
    rows = top_growth(result, top_n)
    print(f"\n与基线快照对比 Top {top_n}（基线: {baseline_path}）:")
    for row in rows:
        print(format_row(row))
    # P12·W1.2：legacy 提示——基线含「已知异常大小」行时建议重扫重建（合计口径
    # 已下沉 compare._total_from_root_rows，delta_total 自动获得根行口径）。
    legacy_count = int(result.get("legacy_count") or 0)
    if legacy_count > 0:
        print(
            "⚠ 基线含 {} 条已知异常大小数据，对比数字可能失真，建议重扫重建基线".format(
                legacy_count
            )
        )
    print(
        "{:>12}  合计变化 | 基线 {} → 当前 {}（共 {} 条差异）".format(
            human_size(result["delta_total"]),
            human_size(result["total_baseline"]),
            human_size(result["total_current"]),
            len(result["rows"]),
        )
    )


def _sorted_export_entries(dir_sizes):
    """导出用目录条目：全部目录（含扫描根）按聚合大小降序，同大小按路径排序。

    与 _print_top_n_report 不同：导出不受 --top 限制，且扫描根本身也包含在内
    （sizes 的键扫描时必然含根：直接文件累加或子目录向上汇总都会落到根键）。
    """
    return sorted(
        dir_sizes.items(),
        key=lambda item: (-item[1], str(item[0]).casefold()),
    )


def _default_export_path(export_format, base_dir=None, now=None):
    """未指定 --output 时的自动命名：<数据目录/exports>/disk_report_YYYYMMDD_HHMMSS.<后缀>。

    导出默认目录遵循 Phase 0 约定：统一写入数据目录
    %LOCALAPPDATA%\\PythonDiskScanner\\exports。export_format 决定后缀（csv/json），
    与 --export 保持一致；base_dir/now 供测试注入（缺省分别取数据目录 exports/
    与当前时刻）。函数会确保 base_dir 存在，因此默认导出不会因目录缺失而失败。
    """
    base = Path(base_dir) if base_dir is not None else datadir.get_exports_dir()
    base.mkdir(parents=True, exist_ok=True)
    now = now if now is not None else datetime.datetime.now()
    return base / f"disk_report_{now:%Y%m%d_%H%M%S}.{export_format}"


def build_report_csv(dir_sizes, root_path_obj=None) -> str:
    """生成 CSV 报表文本（P12·W2.7 从文件写入中抽取的纯构建层）。

    表头「路径,大小(字节),大小(可读)」，其后每行一个目录（聚合大小降序）。
    与旧 export_report_csv 的文件内容逐字节等价（不含 BOM——BOM 由写侧的
    utf-8-sig 编码负责）。
    """
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["路径", "大小(字节)", "大小(可读)"])
    for path, size in _sorted_export_entries(dir_sizes):
        writer.writerow([str(path), size, human_size(size)])
    return buf.getvalue()


def build_report_json(root_path_obj, dir_sizes) -> str:
    """生成 JSON 报表文本（P12·W2.7 纯构建层，结构同旧 export_report_json）。"""
    payload = {
        "scan_root": str(root_path_obj),
        "exported_at": datetime.datetime.now().isoformat(timespec="seconds"),
        "total_size_bytes": dir_sizes.get(root_path_obj, 0),
        "directories": [
            {"path": str(path), "size_bytes": size, "size_human": human_size(size)}
            for path, size in _sorted_export_entries(dir_sizes)
        ],
    }
    return json.dumps(payload, ensure_ascii=False, indent=2) + "\n"


def export_report_csv(root_path_obj, dir_sizes, output_path):
    """导出 CSV：表头「路径,大小(字节),大小(可读)」，其后每行一个目录。

    编码 utf-8-sig（带 BOM），Excel 可直接打开且中文不乱码；路径中的逗号/引号
    由 csv 模块按规范转义；newline='' 避免 Windows 下写出 \r\r\n。
    （W2.7 起为 build_report_csv 的薄包装，CLI 产物逐字节等价。）
    """
    with open(output_path, "w", encoding="utf-8-sig", newline="") as f:
        f.write(build_report_csv(dir_sizes))


def export_report_json(root_path_obj, dir_sizes, output_path):
    """导出 JSON：scan_root/exported_at(ISO 时间)/total_size_bytes/directories。

    total_size_bytes 取扫描根键（自我汇总后的全部占用）；directories 为目录级
    明细（path/size_bytes/size_human），按聚合大小降序；ensure_ascii=False +
    indent=2，文件名 UTF-8 无 BOM。（W2.7 起为 build_report_json 薄包装。）
    """
    with open(output_path, "w", encoding="utf-8", newline="\n") as f:
        f.write(build_report_json(root_path_obj, dir_sizes))


def export_report(root_path_obj, dir_sizes, export_format, output_path):
    """按 export_format（csv/json）分发导出；写失败（OSError）由调用方捕获上报。"""
    if export_format == "csv":
        export_report_csv(root_path_obj, dir_sizes, output_path)
    else:
        export_report_json(root_path_obj, dir_sizes, output_path)