"""历史对比引擎（任务 D7）：快照间 / 快照与内存树的双域纯引擎。

纯引擎与数据层，不做任何 UI（对比视图的界面接入由后续批次负责）。
对比仅限同根命名空间：两快照头部 root 不一致即拒绝；版本不一致
（header['format'] != SNAPSHOT_FORMAT_VERSION）或机器标识不一致（MachineGuid）
同样拒绝。增量 delta = current - baseline；排序主键 |delta| 降序、次键 path 升序
（确定性稳定次序）；增速列 growth_pct 仅对 baseline >= MIN_GROWTH_BASE_BYTES
（1 MiB）的目录计算（防小基数除零失真），否则为 None；行数超过 MAX_ROWS 截断
并标注 truncated。删除目录（current 无此键）标 removed=True（delta 为负）、
新增目录（baseline 无此键）标 added=True。删除红 / 新增绿着色、横幅等表现层内容
一律不在此模块，format_row 只出纯文本单行，颜色由 UI 层依据 removed/added/delta
自行添加。

数据源：
- compare_snapshots：两份 load_snapshot() 产物（或等价的 {'header','rows'} 结构）；
- diff_from_current：内存中当前扫描的 sizes（{Path: int}，scan 聚合产物）与
  baseline 快照行对比，当前树不落盘——供 TUI 的 H 视图『本次 vs 上次快照』直接
  使用；其 root 由两域路径集合的公共前缀推导（路径跨盘视为跨根、拒绝），
  machine_guid 仅作合成头标注（行数据不携带机器信息，严格机器校验由调用方在
  load_snapshot 头部完成）。

依赖：仅标准库 + snapshots（MAX_ROWS / SNAPSHOT_FORMAT_VERSION 单一来源）
+ utils（人类可读大小）。Python 3.9+ 兼容。
"""

import os
from pathlib import Path

from snapshots import MAX_ROWS, SNAPSHOT_FORMAT_VERSION
from utils import human_size


class CompareError(Exception):
    """对比引擎异常基类：版本 / 机器 / 根不一致或输入结构非法时抛出，提示语为中文。"""


# 增速次列的最小基数：旧值 ≥ 1 MiB 才计算 growth_pct（防小基数除零失真）
MIN_GROWTH_BASE_BYTES = 1024 * 1024


# =================【内部工具】=================


def _rows_to_map(rows, label):
    """把快照行列表（每行 {p, s}）规范化为 {路径 str: 大小 int}；结构非法抛 CompareError。"""
    mapping = {}
    for index, row in enumerate(rows):
        if not isinstance(row, dict):
            raise CompareError("%s 第 %d 行不是 dict" % (label, index))
        p = row.get("p")
        s = row.get("s")
        if not isinstance(p, str) or isinstance(s, bool) or not isinstance(s, int):
            raise CompareError("%s 第 %d 行缺少合法的 p/s 字段" % (label, index))
        mapping[p] = s
    return mapping


def _sizes_to_map(sizes, label):
    """把 scan 聚合的 sizes（{Path: int}）规范化为 {路径 str: 大小 int}。"""
    mapping = {}
    for key, value in sizes.items():
        if isinstance(value, bool) or not isinstance(value, int):
            raise CompareError("%s 中路径 %r 的大小不是 int" % (label, key))
        mapping[str(Path(str(key)))] = value
    return mapping


def _merge(b_map, c_map):
    """并集合并 + 计算 delta/growth/removed/added + 排序 + 截断，返回 (rows, truncated)。"""
    keys = set(b_map) | set(c_map)
    rows = []
    for p in keys:
        baseline = b_map.get(p, 0)
        current = c_map.get(p, 0)
        delta = current - baseline
        growth_pct = None
        if baseline >= MIN_GROWTH_BASE_BYTES:
            growth_pct = delta / baseline * 100.0
        rows.append(
            {
                "path": p,
                "baseline": baseline,
                "current": current,
                "delta": delta,
                "growth_pct": growth_pct,
                "removed": p not in c_map,
                "added": p not in b_map,
            }
        )
    # 排序：主键 |delta| 降序，次键 path 升序（确定性稳定次序，替代集合迭代的不确定序）
    rows.sort(key=lambda r: (-abs(r["delta"]), r["path"]))
    truncated = len(rows) > MAX_ROWS
    if truncated:
        rows = rows[:MAX_ROWS]
    return rows, truncated


def _validate_snapshot_header(header, label):
    """校验单侧快照头部（格式版本 / root / 机器标识字段），返回 (root, machine_guid)。"""
    if not isinstance(header, dict):
        raise CompareError("%s 快照头部缺失或非法" % label)
    if header.get("format") != SNAPSHOT_FORMAT_VERSION:
        raise CompareError(
            "%s 快照格式版本 %r 与当前版本 %d 不一致，拒绝对比"
            % (label, header.get("format"), SNAPSHOT_FORMAT_VERSION)
        )
    root = header.get("root")
    if not isinstance(root, str):
        raise CompareError("%s 快照头部缺少 root 字段" % label)
    return root, header.get("machine_guid")


# =================【公开 API】=================


def compare_snapshots(baseline, current, *, machine_guid=None):
    """对比两份快照，返回
    {'root', 'total_baseline', 'total_current', 'delta_total', 'rows', 'truncated'}。

    校验（任一不满足抛 CompareError）：
    - 任一侧 header['format'] != SNAPSHOT_FORMAT_VERSION（版本不一致拒比）；
    - machine_guid 传入且与任一侧 header 的 machine_guid 不一致；未传时两侧
      机器标识不同（视为跨机器快照，拒比）；
    - 两侧 root 不同（路径大小写差异经 os.path.normcase 归一后视为同根）。

    rows 每行 {path, baseline, current, delta, growth_pct|None, removed, added}，
    按 delta 绝对降序（次键 path 升序）排列；行数 > MAX_ROWS 截断并置 truncated=True。
    """
    b_root, b_mg = _validate_snapshot_header(baseline.get("header"), "baseline")
    c_root, c_mg = _validate_snapshot_header(current.get("header"), "current")
    if os.path.normcase(b_root) != os.path.normcase(c_root):
        raise CompareError("跨根对比被拒绝：%s != %s" % (b_root, c_root))
    if machine_guid is not None:
        expected = str(machine_guid)
        if b_mg != expected or c_mg != expected:
            raise CompareError(
                "机器标识不一致：期望 %s，实际 baseline=%r / current=%r"
                % (expected, b_mg, c_mg)
            )
    elif b_mg != c_mg:
        raise CompareError(
            "快照机器标识不一致（baseline=%r, current=%r），拒绝对比" % (b_mg, c_mg)
        )

    b_map = _rows_to_map(baseline.get("rows") or [], "baseline")
    c_map = _rows_to_map(current.get("rows") or [], "current")
    rows, truncated = _merge(b_map, c_map)
    total_baseline = sum(b_map.values())
    total_current = sum(c_map.values())
    return {
        "root": b_root,
        "total_baseline": total_baseline,
        "total_current": total_current,
        "delta_total": total_current - total_baseline,
        "rows": rows,
        "truncated": truncated,
    }


def top_growth(compare_result, n=10):
    """按 delta 降序取前 n 行（增速次列 growth_pct 保留在行内）。"""
    rows = sorted(compare_result["rows"], key=lambda r: r["delta"], reverse=True)
    return rows[:n]


def diff_from_current(sizes, baseline_rows, machine_guid=None):
    """把内存中当前扫描 sizes（{Path: int}）与 baseline 快照行对比，返回与
    compare_snapshots 同构的 dict（当前树不需要落盘）。

    - sizes 键为 Path（scan 聚合产物），baseline_rows 为 load_snapshot(...)['rows']；
    - root 由两域路径集合的公共前缀推导（os.path.commonpath）；路径跨盘抛
      CompareError（与『跨根拒绝』口径一致）；
    - machine_guid 仅作为合成头标注传入（行数据不携带机器信息，严格机器校验由
      调用方在 load_snapshot 头部完成）。
    """
    b_map = _rows_to_map(baseline_rows, "baseline")
    c_map = _sizes_to_map(sizes, "current")
    keys = set(b_map) | set(c_map)
    if keys:
        try:
            root = os.path.commonpath(list(keys))
        except ValueError:
            raise CompareError("当前树与快照路径跨盘（根不一致），拒绝对比")
    else:
        root = ""
    rows, truncated = _merge(b_map, c_map)
    total_baseline = sum(b_map.values())
    total_current = sum(c_map.values())
    return {
        "root": root,
        "total_baseline": total_baseline,
        "total_current": total_current,
        "delta_total": total_current - total_baseline,
        "rows": rows,
        "truncated": truncated,
    }


def format_row(row):
    """渲染单行对比文本：右对齐带符号 delta + 增速列 + 路径。

    纯文本、无 ANSI 颜色（删除红 / 新增绿的着色由 UI 层依据 removed/added/delta
    自行完成）。增速为 None（小基数不计算）时显示 '-'。
    """
    delta = row.get("delta")
    if delta is None:
        delta = 0
    if delta > 0:
        delta_text = "+" + human_size(delta)
    elif delta < 0:
        delta_text = "-" + human_size(-delta)
    else:
        delta_text = human_size(0)
    growth = row.get("growth_pct")
    if growth is None:
        growth_text = "-"
    else:
        growth_text = "%+.2f%%" % growth
    return "{:>12} {:>10} {}".format(delta_text, growth_text, row.get("path", ""))


__all__ = [
    "MIN_GROWTH_BASE_BYTES",
    "CompareError",
    "compare_snapshots",
    "top_growth",
    "diff_from_current",
    "format_row",
]