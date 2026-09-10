# -*- coding: utf-8 -*-
"""P4 契约证伪自证：**默认参数下**引擎输出与 stage-p3（`d37627e`）逐字段相等。

做法
- `git show stage-p3:compare.py` 取出修复前引擎源码，落到 %TEMP% 并以独立模块
  名导入（同进程并存两版引擎），避免"看起来一样"式的口头保证。
- 数据源：%TEMP% 夹具（`fixture_snapshots.mjs --fixture growth,flat`）真实
  `.snap.gz`，经**真实** `snapshots.load_snapshot` 读取（CRC/头部校验生效）。
- 比对面：compare_snapshots / diff_from_current 的**全部既有返回键**逐字段相等
  （含 rows 列表逐行、逐键、逐值），以及 top_growth 默认排序的逐行相等。

用法
  python docs/问题核查资料_20260908/p4/_verify_backcompat.py
输出
  逐用例比对结果 + 末尾 `BACKCOMPAT-VERDICT: PASS|FAIL`（exit 0/1）
"""

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO))

import compare as new_compare          # noqa: E402  修复后引擎
import snapshots                       # noqa: E402

LEGACY_KEYS = [
    "root", "total_baseline", "total_current", "delta_total",
    "rows", "truncated", "legacy_count",
]


def _load_p3_engine():
    """从 git 取出 stage-p3 的 compare.py 并作为独立模块导入。"""
    src = subprocess.run(
        ["git", "show", "stage-p3:compare.py"],
        cwd=str(REPO), capture_output=True, check=True,
    ).stdout.decode("utf-8")
    tmp = Path(tempfile.gettempdir()) / "p4_stage_p3_compare.py"
    tmp.write_text(src, encoding="utf-8")
    spec = importlib.util.spec_from_file_location("compare_stage_p3", tmp)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module, tmp


def _diff_fields(label, old, new, keys):
    """逐字段比对（rows 逐行逐键），返回差异明细列表。"""
    problems = []
    for key in keys:
        if key not in new:
            problems.append("%s: 新引擎缺键 %s" % (label, key))
            continue
        a, b = old.get(key), new.get(key)
        if a != b:
            if key == "rows" and isinstance(a, list) and isinstance(b, list):
                if len(a) != len(b):
                    problems.append("%s.rows 行数 %d != %d" % (label, len(a), len(b)))
                for i, (ra, rb) in enumerate(zip(a, b)):
                    if ra != rb:
                        problems.append("%s.rows[%d] 不等: %r != %r" % (label, i, ra, rb))
                        break
            else:
                problems.append("%s.%s 不等: %r != %r" % (label, key, a, b))
    return problems


def main():
    p3, p3_path = _load_p3_engine()
    fixture_root = Path(os.environ.get(
        "P4_FIXTURE_ROOT", Path(tempfile.gettempdir()) / "pds_p4_iso" / "home" / "PythonDiskScanner"
    ))
    snap_dir = fixture_root / "snapshots"
    f = {
        "growthT0": snap_dir / "D_20260907_170000_explicit_3f2a1c9d.snap.gz",
        "growthT1": snap_dir / "D_20260908_170000_explicit_3f2a1c9d.snap.gz",
        "flatA": snap_dir / "D_20260907_110000_explicit_3f2a1c9d.snap.gz",
        "flatB": snap_dir / "D_20260908_110000_explicit_3f2a1c9d.snap.gz",
    }
    for name, path in f.items():
        if not path.is_file():
            print("夹具缺失: %s (%s)" % (name, path))
            return 2

    g0, g1 = snapshots.load_snapshot(f["growthT0"]), snapshots.load_snapshot(f["growthT1"])
    f0, f1 = snapshots.load_snapshot(f["flatA"]), snapshots.load_snapshot(f["flatB"])
    sizes1 = {Path(r["p"]): int(r["s"]) for r in g1["rows"]}

    cases = [
        ("compare_snapshots(growth) 默认", lambda m: m.compare_snapshots(g0, g1)),
        ("compare_snapshots(growth) leaf_only=True",
         lambda m: m.compare_snapshots(g0, g1, leaf_only=True)),
        ("compare_snapshots(flat) leaf_only=True",
         lambda m: m.compare_snapshots(f0, f1, leaf_only=True)),
        ("diff_from_current(growth) 默认",
         lambda m: m.diff_from_current(sizes1, g0["rows"])),
        ("diff_from_current(growth) leaf_only=True",
         lambda m: m.diff_from_current(sizes1, g0["rows"], leaf_only=True)),
        ("diff_from_current(growth) machine_guid 同值",
         lambda m: m.diff_from_current(sizes1, g0["rows"],
                                       machine_guid=g0["header"]["machine_guid"])),
    ]

    problems = []
    rows_compared = 0
    print("修复前引擎: %s (stage-p3:compare.py)" % p3_path)
    print("夹具: %s" % snap_dir)
    for label, fn in cases:
        old, new = fn(p3), fn(new_compare)
        probs = _diff_fields(label, old, new, LEGACY_KEYS)
        rows_compared += len(old.get("rows") or [])
        verdict = "PASS" if not probs else "FAIL"
        print("  [%s] %-46s rows=%d delta_total=%s" % (
            verdict, label, len(old.get("rows") or []), old.get("delta_total")))
        problems.extend(probs)

    # top_growth 默认排序逐行相等（cli.py:518 的默认调用）
    for n in (10, 3, 100):
        a = p3.top_growth(p3.compare_snapshots(g0, g1, leaf_only=True), n)
        b = new_compare.top_growth(new_compare.compare_snapshots(g0, g1, leaf_only=True), n)
        ok = a == b
        rows_compared += len(a)
        print("  [%s] top_growth(leaf, n=%d) 默认排序逐行相等 rows=%d" % (
            "PASS" if ok else "FAIL", n, len(a)))
        if not ok:
            problems.append("top_growth(n=%d) 不等" % n)

    # machine_mismatch 分支（异常路径）行为一致
    try:
        p3.diff_from_current(sizes1, g0["rows"], machine_guid="other-guid",
                             local_machine_guid="local-guid")
        old_kind = "no-raise"
    except p3.CompareError as exc:
        old_kind = getattr(exc, "kind", None)
    try:
        new_compare.diff_from_current(sizes1, g0["rows"], machine_guid="other-guid",
                                      local_machine_guid="local-guid")
        new_kind = "no-raise"
    except new_compare.CompareError as exc:
        new_kind = getattr(exc, "kind", None)
    ok = old_kind == new_kind == "machine_mismatch"
    print("  [%s] machine_mismatch 分支 kind 一致 (%s)" % ("PASS" if ok else "FAIL", new_kind))
    if not ok:
        problems.append("machine_mismatch 分支不等: %r != %r" % (old_kind, new_kind))

    print("比对字段组=%d 用例=%d 逐行比对行数=%d" % (len(LEGACY_KEYS), len(cases) + 4, rows_compared))
    print("新增键（additive，不参与旧契约比对）: %s" % sorted(
        set(new_compare.compare_snapshots(g0, g1)) - set(LEGACY_KEYS)))
    if problems:
        print("差异明细:")
        for p in problems:
            print("  - " + p)
    print("BACKCOMPAT-VERDICT: " + ("PASS" if not problems else "FAIL"))
    return 0 if not problems else 1


if __name__ == "__main__":
    sys.exit(main())
