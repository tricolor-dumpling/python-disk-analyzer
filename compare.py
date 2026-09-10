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

P4（问题 5，全部为 additive 可选参数，缺省行为一字不改）：
- depth=N（≥1）：键集合在产行前折叠到「相对对比根的第 N 层」（_rollup），用于
  先看某层目录的总增量再下钻；不给 depth 时仍是既有叶子/全量口径；
- 汇总字段 rows_total / zero_count / zero_total / max_growth / max_release /
  depth：全量聚合行口径（Top-N 切片之前），消除摘要与 delta_total 的自相矛盾。

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


def _leaf_keys(keys):
    """O(n) 叶子路径判定（阶段F 回归修复：替换原 O(n²) 前缀遍历）。

    返回 keys 中「非任何其他键祖先」的路径集合，语义与旧实现完全等价：
    p 非叶子 ⟺ ∃q∈keys, q≠p, normcase(q).startswith(normcase(p).rstrip('\\') + '\\')。
    等价变换：p 非叶子 ⟺ normcase(p).rstrip('\\') ∈ ancestors，其中
    ancestors = 所有 keys 路径的逐级父目录（normcase + rstrip('\\') 规范化）。
    对每个 key 只需沿其自身父链上溯 O(深度) 次，总体 O(n·深度) ≈ O(n)。

    边界（与旧实现一致）：
    - 盘根 'C:\\'：normcase 后 'c:\\'，rstrip('\\') 得 'c:'；根是任何键的父时
      其 'c:' 出现在祖先集合 → 判非叶子；否则判叶子（盘根无子键场景）；
    - 大小写不敏感：Windows 路径 'C:\\A' 与 'c:\\a' 视为同键前缀匹配。
    """
    if not keys:
        return set()
    ancestors = set()
    for k in keys:
        norm_k = os.path.normcase(k).rstrip("\\")
        parent = os.path.dirname(norm_k)
        while parent and parent.rstrip("\\") != norm_k:
            ancestors.add(parent.rstrip("\\"))
            nxt = os.path.dirname(parent)
            if nxt == parent:
                break
            parent = nxt
    return {k for k in keys if os.path.normcase(k).rstrip("\\") not in ancestors}


def _norm_key(path):
    """路径归一化比较键：normcase + 去尾部反斜杠（'D:\\' 与 'd:' 视为同键）。"""
    return os.path.normcase(str(path)).rstrip("\\")


def _relative_depth(path, root):
    """path 相对 root 的层级：root 自身 0、直接子项 1、逐级递增；不在 root 下返回 None。"""
    p = _norm_key(path)
    r = _norm_key(root)
    if r and p == r:
        return 0
    if r and not p.startswith(r + "\\"):
        return None
    rest = (p[len(r):] if r else p).lstrip("\\")
    return len([x for x in rest.split("\\") if x])


def _ancestor_at_depth(path, root, depth):
    """取 path 在 root 下第 depth 层的祖先**原串切片**（保留原大小写与分隔符）。

    normcase 在 Windows 上仅做小写化 + 分隔符归一（长度不变），故可按长度在原串
    上定位第 depth 个分隔符，避免把 'D:\\Apps' 折成 'd:\\apps' 后污染行路径。
    """
    s = str(path)
    norm_s = _norm_key(s)
    norm_r = _norm_key(root)
    if norm_r and not norm_s.startswith(norm_r + "\\"):
        return path
    start = len(norm_r) + 1 if norm_r else 0
    rest = norm_s[start:]
    idx = -1
    for _ in range(depth):
        nxt = rest.find("\\", idx + 1)
        if nxt < 0:
            return path
        idx = nxt
    return s[:start + idx]


def _rollup(mapping, root, depth):
    """把键集合折叠到「相对 root 的第 depth 层」（P4·D4-1 深度聚合，O(n)）。

    语义（与真实扫描数据同构：scan.py 自底向上汇总后每个目录/文件各占一行、
    父目录大小已含全部后代）：
    - 每个键折叠到其 level == min(自身层级, depth) 的祖先；
    - 折叠目标本身即为键 → **取该键自身值**（已含后代，避免父子重复累加）；
      目标不是键（层级缺口，如只有 'D:\\a\\b\\c'）→ 取该组「顶层成员」（组内无
      祖先成员者）之和，同样不重复累加；
    - 根行（层级 0）不进结果：深度视图呈现聚合层，根合计由 delta_total 承载，
      因此「聚合行合计 == 根行 delta」在该层上精确成立（不完备数据集产生的
      「未列出直属字节」残差由调用方/探针显式记账）。

    depth 为 None 或 <1 时原样返回（既有叶子口径路径不经过本函数）。
    """
    if not mapping or depth is None or depth < 1:
        return mapping
    groups = {}
    for path in mapping:
        level = _relative_depth(path, root)
        if level is None or level <= 0:
            continue
        target = path if level <= depth else _ancestor_at_depth(path, root, depth)
        groups.setdefault(target, []).append(path)
    # 更浅的折叠目标（其下还有更深的折叠目标）不入行集：它的字节已由更深行承载，
    # 同时保留两者会造成父子重复计数（与 _leaf_keys 同思路的 O(n·深度) 祖先集合）。
    target_keys = {_norm_key(t) for t in groups}
    ancestors = set()
    for key in target_keys:
        parent = os.path.dirname(key)
        while parent and parent != key:
            ancestors.add(parent)
            nxt = os.path.dirname(parent)
            if nxt == parent:
                break
            parent = nxt
    index = {}
    for path in mapping:
        index.setdefault(_norm_key(path), path)
    rolled = {}
    for target, members in groups.items():
        if _norm_key(target) in ancestors:
            continue
        own = index.get(_norm_key(target))
        if own is not None:
            rolled[target] = mapping[own]
            continue
        member_keys = {_norm_key(m) for m in members}
        total = 0
        for member in members:
            if os.path.dirname(_norm_key(member)) in member_keys:
                continue  # 非顶层成员：其字节已含在祖先成员里
            total += mapping[member]
        rolled[target] = total
    return rolled


def _build_rows(b_map, c_map, leaf_only=False):
    """并集合并 + 逐键产行（**零过滤/排序/截断之前**）——_merge 与汇总统计同源。"""
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
        leaves = _leaf_keys(keys)
        rows = [r for r in rows if r["path"] in leaves]
    return rows


def _merge_from_rows(rows):
    """排序（主键 |delta| 降序、次键 path 升序，确定性稳定次序）+ 截断。"""
    rows.sort(key=lambda r: (-abs(r["delta"]), r["path"]))
    truncated = len(rows) > MAX_ROWS
    if truncated:
        rows = rows[:MAX_ROWS]
    return rows, truncated


def _summarize(rows, depth):
    """P4（D4-5）additive 汇总：**全量聚合行**口径（零过滤与 Top-N 切片之前）。"""
    zero_total = 0
    max_growth = 0
    max_release = 0
    for row in rows:
        delta = row["delta"]
        if delta == 0:
            zero_total += 1
        elif delta > 0:
            if delta > max_growth:
                max_growth = delta
        elif -delta > max_release:
            max_release = -delta
    return {
        "rows_total": len(rows),
        "zero_total": zero_total,
        "max_growth": max_growth,
        "max_release": max_release,
        "depth": depth,
    }


def _normalize_depth(depth):
    """depth 参数校验：None 或 ≥1 的 int（bool 不算）；非法抛 CompareError。"""
    if depth is None:
        return None
    if isinstance(depth, bool) or not isinstance(depth, int):
        raise CompareError("depth 必须是 ≥1 的整数（收到 %r）" % (depth,))
    if depth < 1:
        raise CompareError("depth 必须 ≥1（收到 %d）" % depth)
    return depth


def _merge(b_map, c_map, leaf_only=False):
    """并集合并 + 计算 delta/growth/removed/added + 排序 + 截断，返回 (rows, truncated)。

    P12·W1.2：leaf_only=True 时在排序截断前把行集合过滤为叶子路径——不存在
    其他键 q 使 normcase(q).startswith(normcase(p + '\\')) 且 q != p（即 p 不是
    任何其他键的祖先）。祖先行的增量已由其叶子承载，leaf 过滤避免排行/图表
    把同一份增量在祖先与后代上重复呈现；合计（_total_from_root_rows）不受影响。
    阶段F（R6）回归修复：叶子判定由 O(n²) 前缀遍历改为 O(n) 祖先集合
    （_leaf_keys），大根（C:\\ 13 万行）对比不再退化到分钟级/卡死。
    P4：深度聚合由 _rollup 在调用方先行完成，本函数不感知 depth——默认行集合
    语义（参数、次序、截断）一字不改。
    """
    return _merge_from_rows(_build_rows(b_map, c_map, leaf_only=leaf_only))



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


def compare_snapshots(baseline, current, *, machine_guid=None, leaf_only=False,
                      depth=None):
    """对比两份快照，返回
    {'root', 'total_baseline', 'total_current', 'delta_total', 'rows',
     'truncated', 'legacy_count', 'rows_total', 'zero_count', 'zero_total',
     'max_growth', 'max_release', 'depth'}。

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
    P4（additive，全部默认关闭、缺省行为一字不改）：
    - depth=N（≥1）：键集合先经 _rollup 折叠到相对根的第 N 层（不含根行）再产行，
      leaf_only 在该分支不参与（rollup 行集本身互不重叠）；合计口径仍取原始根行；
    - 汇总字段 rows_total / zero_total / max_growth / max_release / depth 恒为
      **全量聚合行**口径；zero_count 为**返回行**中的零行数。
    """
    b_root, b_mg = _validate_snapshot_header(baseline.get("header"), "baseline")
    c_root, c_mg = _validate_snapshot_header(current.get("header"), "current")
    depth = _normalize_depth(depth)
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
    total_baseline = _total_from_root_rows(b_map, root_hint=b_root)
    total_current = _total_from_root_rows(c_map, root_hint=b_root)
    if depth is not None:
        b_rows_map = _rollup(b_map, b_root, depth)
        c_rows_map = _rollup(c_map, b_root, depth)
        leaf_effective = False
    else:
        b_rows_map, c_rows_map, leaf_effective = b_map, c_map, leaf_only
    all_rows = _build_rows(b_rows_map, c_rows_map, leaf_only=leaf_effective)
    rows, truncated = _merge_from_rows(all_rows)
    report = {
        "root": b_root,
        "total_baseline": total_baseline,
        "total_current": total_current,
        "delta_total": total_current - total_baseline,
        "rows": rows,
        "truncated": truncated,
        # P12·W1.1（additive）：两侧「已知异常大小」行数，供界面提示重扫重建基线
        "legacy_count": _count_legacy_rows(b_map, c_map),
    }
    report.update(_summarize(all_rows, depth))
    report["zero_count"] = sum(1 for r in rows if r["delta"] == 0)
    return report


def top_growth(compare_result, n=10):
    """按 delta 降序取前 n 行（增速次列 growth_pct 保留在行内）。"""
    rows = sorted(compare_result["rows"], key=lambda r: r["delta"], reverse=True)
    return rows[:n]


def diff_from_current(sizes, baseline_rows, machine_guid=None, *,
                      leaf_only=False,
                      depth=None,
                      local_machine_guid=None,
                      allow_other_machine=False):
    """把内存中当前扫描 sizes（{Path: int}）与 baseline 快照行对比，返回与
    compare_snapshots 同构的 dict（当前树不需要落盘）。

    - sizes 键为 Path（scan 聚合产物），baseline_rows 为 load_snapshot(...)['rows']；
    - root 由两域路径集合的公共前缀推导（os.path.commonpath）；路径跨盘抛
      CompareError（与『跨根拒绝』口径一致）；
    - machine_guid 仅作为合成头标注传入（行数据不携带机器信息，严格机器校验由
      调用方在 load_snapshot 头部完成）。
    - P12·W1.2：合计口径下沉 _total_from_root_rows（root 行优先，缺失回退顶层
      行求和）；leaf_only=True 透传给 _merge，rows 仅保留叶子路径。
    - P12·W2.13（D2 三端接线，additive）：local_machine_guid 传入且与基线标注
      的 machine_guid 不同、且未 allow_other_machine 时抛 CompareError，其
      ``kind`` 属性为 "machine_mismatch"（additive 属性，不破坏既有捕获）。
      不传新参的既有调用行为完全不变（fail-open 兼容红线），接线方默认 fail-closed。
    - P4（additive）：depth 语义与 compare_snapshots 完全一致；下钻（以子目录为
      新根）由调用方负责把 baseline_rows 收窄到该子树（app.py
      _scope_baseline_rows），引擎只按传入行集合对比、root 由公共前缀推导，
      不额外做范围裁剪。
    """
    # 强校验（W2.13）：异机基线默认拦截，逃生口由调用方显式放行
    if (
        local_machine_guid is not None
        and machine_guid
        and str(machine_guid) != str(local_machine_guid)
        and not allow_other_machine
    ):
        exc = CompareError(
            "机器标识不一致：基线来自其他机器(%s)。如确认要在本机参考，"
            "请使用允许跨机对比的入口（CLI --allow-other-machine / Web 确认 / TUI 确认键）"
            % machine_guid
        )
        exc.kind = "machine_mismatch"
        raise exc
    depth = _normalize_depth(depth)
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
    total_baseline = _total_from_root_rows(b_map, root_hint=root)
    total_current = _total_from_root_rows(c_map, root_hint=root)
    if depth is not None:
        b_rows_map = _rollup(b_map, root, depth)
        c_rows_map = _rollup(c_map, root, depth)
        leaf_effective = False
    else:
        b_rows_map, c_rows_map, leaf_effective = b_map, c_map, leaf_only
    all_rows = _build_rows(b_rows_map, c_rows_map, leaf_only=leaf_effective)
    rows, truncated = _merge_from_rows(all_rows)
    report = {
        "root": root,
        "total_baseline": total_baseline,
        "total_current": total_current,
        "delta_total": total_current - total_baseline,
        "rows": rows,
        "truncated": truncated,
        # P12·W1.1（additive）：两侧「已知异常大小」行数，供界面提示重扫重建基线
        "legacy_count": _count_legacy_rows(b_map, c_map),
    }
    report.update(_summarize(all_rows, depth))
    report["zero_count"] = sum(1 for r in rows if r["delta"] == 0)
    return report



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