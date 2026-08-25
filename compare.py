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

# P12·W1.1 legacy 标记阈值：>= 该值的行视为「已知异常大小」数据（Everything
# 哨兵/脏索引产物）。与 snapshots._LEGACY_SIZE_THRESHOLD、scan.SIZE_UNKNOWN_MAX_BYTES
# 三处同值（依赖方向不允许互 import，tests.test_compare 强制同值防单方漂移）。
_LEGACY_SIZE_THRESHOLD = 16 * 1024 ** 4


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


def _total_from_root_rows(mapping, root_hint=None):
    """从聚合行集合推导「合计」口径（P12·W1.2 下沉的公共助手，RT-01）。

    旧口径 total = sum(mapping.values()) 会把祖先行与后代行重复累加（根行的
    聚合值已包含全部后代），多根/嵌套树合计虚高。新口径：
    ① root_hint 给定：遍历键找 os.path.normcase(p) == os.path.normcase(root_hint)
       的根行，命中返回其值（大小写差异经 normcase 归一，'C:\\T' 与 'c:\\t' 命中）；
    ② 未给/未命中回退：顶层行 = p 使 normcase(os.path.dirname(p.rstrip('\\')))
       不在键集合中（盘根 dirname 自映射天然落入），求和返回（多根/根行缺失兜底；
       单根树下等价于根行值，不重复计数）；
    ③ 空 mapping → 0。
    """
    if not mapping:
        return 0
    if root_hint:
        hint_key = os.path.normcase(str(root_hint))
        for path, value in mapping.items():
            if os.path.normcase(path) == hint_key:
                return value
    keys_n = {os.path.normcase(k) for k in mapping}
    total = 0
    for path, value in mapping.items():
        parent = os.path.dirname(path.rstrip("\\"))
        if os.path.normcase(parent) not in keys_n:
            total += value
    return total


def _merge(b_map, c_map, leaf_only=False):
    """并集合并 + 计算 delta/growth/removed/added + 排序 + 截断，返回 (rows, truncated)。

    P12·W1.2：leaf_only=True 时在排序截断前把行集合过滤为叶子路径——不存在
    其他键 q 使 normcase(q).startswith(normcase(p + '\\')) 且 q != p（即 p 不是
    任何其他键的祖先）。祖先行的增量已由其叶子承载，leaf 过滤避免排行/图表
    把同一份增量在祖先与后代上重复呈现；合计（_total_from_root_rows）不受影响。
    """
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
    if leaf_only and rows:
        # 盘根键（如 'C:\'）normcase 后仍带尾反斜杠，先剥掉再加分隔符，
        # 否则前缀匹配失配会把根行误判为叶子。
        leaves = {
            p
            for p in keys
            if not any(
                q != p
                and os.path.normcase(q).startswith(
                    os.path.normcase(p).rstrip("\\") + "\\"
                )
                for q in keys
            )
        }
        rows = [r for r in rows if r["path"] in leaves]
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


def _count_legacy_rows(*maps):
    """统计若干 mapping（路径 -> 大小）中 >= _LEGACY_SIZE_THRESHOLD 的行数之和。"""
    return sum(
        1
        for mapping in maps
        for value in mapping.values()
        if value >= _LEGACY_SIZE_THRESHOLD
    )


def compare_snapshots(baseline, current, *, machine_guid=None, leaf_only=False):
    """对比两份快照，返回
    {'root', 'total_baseline', 'total_current', 'delta_total', 'rows',
     'truncated', 'legacy_count'}。

    校验（任一不满足抛 CompareError）：
    - 任一侧 header['format'] != SNAPSHOT_FORMAT_VERSION（版本不一致拒比）；
    - machine_guid 传入且与任一侧 header 的 machine_guid 不一致；未传时两侧
      机器标识不同（视为跨机器快照，拒比）；
    - 两侧 root 不同（路径大小写差异经 os.path.normcase 归一后视为同根）。

    rows 每行 {path, baseline, current, delta, growth_pct|None, removed, added}，
    按 delta 绝对降序（次键 path 升序）排列；行数 > MAX_ROWS 截断并置 truncated=True。
    P12·W1.2：合计口径下沉 _total_from_root_rows——取扫描根行聚合值（root 行
    缺失时回退顶层行求和），不再逐行累加；leaf_only=True 透传给 _merge，
    rows 仅保留叶子路径。
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
    rows, truncated = _merge(b_map, c_map, leaf_only=leaf_only)
    total_baseline = _total_from_root_rows(b_map, root_hint=b_root)
    total_current = _total_from_root_rows(c_map, root_hint=b_root)
    return {
        "root": b_root,
        "total_baseline": total_baseline,
        "total_current": total_current,
        "delta_total": total_current - total_baseline,
        "rows": rows,
        "truncated": truncated,
        # P12·W1.1（additive）：两侧「已知异常大小」行数，供界面提示重扫重建基线
        "legacy_count": _count_legacy_rows(b_map, c_map),
    }


def top_growth(compare_result, n=10):
    """按 delta 降序取前 n 行（增速次列 growth_pct 保留在行内）。"""
    rows = sorted(compare_result["rows"], key=lambda r: r["delta"], reverse=True)
    return rows[:n]


def diff_from_current(sizes, baseline_rows, machine_guid=None, *, leaf_only=False):
    """把内存中当前扫描 sizes（{Path: int}）与 baseline 快照行对比，返回与
    compare_snapshots 同构的 dict（当前树不需要落盘）。

    - sizes 键为 Path（scan 聚合产物），baseline_rows 为 load_snapshot(...)['rows']；
    - root 由两域路径集合的公共前缀推导（os.path.commonpath）；路径跨盘抛
      CompareError（与『跨根拒绝』口径一致）；
    - machine_guid 仅作为合成头标注传入（行数据不携带机器信息，严格机器校验由
      调用方在 load_snapshot 头部完成）。
    - P12·W1.2：合计口径下沉 _total_from_root_rows（root 行优先，缺失回退顶层
      行求和）；leaf_only=True 透传给 _merge，rows 仅保留叶子路径。
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
    rows, truncated = _merge(b_map, c_map, leaf_only=leaf_only)
    total_baseline = _total_from_root_rows(b_map, root_hint=root)
    total_current = _total_from_root_rows(c_map, root_hint=root)
    return {
        "root": root,
        "total_baseline": total_baseline,
        "total_current": total_current,
        "delta_total": total_current - total_baseline,
        "rows": rows,
        "truncated": truncated,
        # P12·W1.1（additive）：两侧「已知异常大小」行数，供界面提示重扫重建基线
        "legacy_count": _count_legacy_rows(b_map, c_map),
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