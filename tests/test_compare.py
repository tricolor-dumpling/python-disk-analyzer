"""compare 模块现状护栏（P12·W1.0，冲突9）。

锁定 _rows_to_map 对大小写键的现状行为（'C:\\' 与 'c:\\' 共存为两个独立键）、
_merge 输出行键与排序次序；int 校验非法输入抛 CompareError。
合计口径（total_* = sum(map.values())）的现状由 W1.2 下沉公共助手时同 PR 改期望，
本文件先锁「行级」行为，避免护栏与整改互相踩踏。
"""

import unittest

import compare
import scan
import snapshots
from compare import CompareError, _merge, _rows_to_map


def _snapshot_dict(root, rows):
    """构造 compare_snapshots 接受的最小快照结构（header 合法、root 一致）。"""
    return {
        "header": {"format": 1, "machine_guid": "abcd1234", "root": root,
                   "created_at": "2026-08-24T00:00:00", "auto": False},
        "rows": [{"p": p, "s": s} for p, s in rows],
    }


class TotalFromRootRowsTests(unittest.TestCase):
    """P12·W1.2：合计口径下沉——根行优先，缺失回退顶层行求和，空集为 0。"""

    def test_fixture_7050_to_6050_root_delta(self):
        """夹具：基线根 7050（=4000+2500+550 直属）→ 当前 deep=1500，delta==-1000==根行 delta。"""
        baseline = _snapshot_dict(
            "T:\\",
            [("T:\\", 7050), ("T:\\s", 4000), ("T:\\s\\deep", 2500)],
        )
        current = _snapshot_dict("T:\\", [("T:\\", 6050), ("T:\\s", 4000), ("T:\\s\\deep", 1500)])
        report = compare.compare_snapshots(baseline, current)
        self.assertEqual(report["total_baseline"], 7050)
        self.assertEqual(report["total_current"], 6050)
        self.assertEqual(report["delta_total"], -1000)
        root_row = next(r for r in report["rows"] if r["path"] == "T:\\")
        self.assertEqual(report["delta_total"], root_row["delta"], "合计必须等于根行 delta")
        self.assertNotEqual(
            report["delta_total"],
            sum(r["delta"] for r in report["rows"]),
            "合计不得等于明细行累加（祖先重复计数即回归）",
        )

    def test_nested_ancestors_not_double_counted(self):
        """多层祖先嵌套树：total_baseline == 根行值而非 sum(rows)。"""
        baseline = _snapshot_dict(
            "C:\\T",
            [("C:\\T", 900), ("C:\\T\\a", 500), ("C:\\T\\a\\b", 300), ("C:\\T\\a\\b\\c", 100)],
        )
        current = _snapshot_dict("C:\\T", [("C:\\T", 800), ("C:\\T\\a", 400), ("C:\\T\\a\\b", 200), ("C:\\T\\a\\b\\c", 50)])
        report = compare.compare_snapshots(baseline, current)
        self.assertEqual(report["total_baseline"], 900)
        self.assertNotEqual(report["total_baseline"], 900 + 500 + 300 + 100)

    def test_mixed_case_root_row_hit(self):
        """根行 'c:\\t' vs header root 'C:\\T'：走 normcase 命中分支，不跌入顶层求和回退。"""
        baseline = _snapshot_dict(
            "C:\\T",
            [("c:\\t", 100), ("D:\\x", 999)],   # 回退分支会把两行都当顶层求和 → 1099
        )
        current = _snapshot_dict("C:\\T", [("c:\\t", 150), ("D:\\x", 999)])
        report = compare.compare_snapshots(baseline, current)
        self.assertEqual(report["total_baseline"], 100, "大小写混合根行应命中 hint 分支")

    def test_fallback_sums_top_level_rows_only(self):
        """回退分支单独覆盖：root 行缺失时只累加顶层行（子行不重复计入）。"""
        mapping = {"C:\\T": 100, "C:\\T\\sub": 60, "D:\\other": 40}
        self.assertEqual(compare._total_from_root_rows(mapping, root_hint="E:\\"), 140)
        self.assertEqual(compare._total_from_root_rows(mapping), 140)
        self.assertEqual(compare._total_from_root_rows({}, root_hint=None), 0)

    def test_leaf_only_removes_ancestor_rows(self):
        """leaf_only=True 后 rows 不含任何为祖先的行；合计不受影响。"""
        baseline = _snapshot_dict(
            "T:\\",
            [("T:\\", 7050), ("T:\\s", 4000), ("T:\\s\\deep", 2500)],
        )
        current = _snapshot_dict("T:\\", [("T:\\", 6050), ("T:\\s", 4000), ("T:\\s\\deep", 1500)])
        full = compare.compare_snapshots(baseline, current)
        leaf = compare.compare_snapshots(baseline, current, leaf_only=True)
        ancestor_paths = {"T:\\", "T:\\s"}
        for row in leaf["rows"]:
            self.assertNotIn(row["path"], ancestor_paths, "leaf 口径不得包含祖先行")
        self.assertIn("T:\\s\\deep", [r["path"] for r in leaf["rows"]])
        # 合计口径与 leaf 无关
        self.assertEqual(leaf["delta_total"], full["delta_total"])
        self.assertEqual(full["delta_total"], -1000)


class DepthAggregationTests(unittest.TestCase):
    """P4（问题 5）：depth 深度聚合——折叠到相对根的第 N 层、根行不入行集。

    夹具与 scripts/dev/fixture_snapshots.mjs 的 growth 夹具同构（4 层深链 +
    正/零/负增量混合），数值直接取自该夹具的两份快照：
      t0：D:\\ 1000 / apps 500 / framework 300 / core 200 / engine 120 /
          lib.dll 100 / conf.bin 20 / data 300 / data\\docs 150 / docs 200 / docs\\old 150
      t1：D:\\ 1050 / apps 600 / framework 380 / core 280 / engine 200 /
          lib.dll 170 / conf.bin 30 / data 300 / data\\docs 150 / docs 150 / docs\\old 100
    """

    T0 = [
        ("D:\\", 1000), ("D:\\apps", 500), ("D:\\apps\\framework", 300),
        ("D:\\apps\\framework\\core", 200), ("D:\\apps\\framework\\core\\engine", 120),
        ("D:\\apps\\framework\\core\\engine\\lib.dll", 100),
        ("D:\\apps\\framework\\core\\engine\\conf.bin", 20),
        ("D:\\data", 300), ("D:\\data\\docs", 150),
        ("D:\\docs", 200), ("D:\\docs\\old", 150),
    ]
    T1 = [
        ("D:\\", 1050), ("D:\\apps", 600), ("D:\\apps\\framework", 380),
        ("D:\\apps\\framework\\core", 280), ("D:\\apps\\framework\\core\\engine", 200),
        ("D:\\apps\\framework\\core\\engine\\lib.dll", 170),
        ("D:\\apps\\framework\\core\\engine\\conf.bin", 30),
        ("D:\\data", 300), ("D:\\data\\docs", 150),
        ("D:\\docs", 150), ("D:\\docs\\old", 100),
    ]

    def _report(self, **kw):
        return compare.compare_snapshots(
            _snapshot_dict("D:\\", self.T0), _snapshot_dict("D:\\", self.T1), **kw
        )

    def test_depth1_rows_are_top_level_only_and_root_row_excluded(self):
        """depth=1：行集 = 顶层目录（3 条），不含根行；Σ(行 delta) == delta_total。"""
        report = self._report(depth=1)
        self.assertEqual(
            [r["path"] for r in report["rows"]],
            ["D:\\apps", "D:\\docs", "D:\\data"],  # 既有排序：|delta| 降序（100/-50/0）
        )
        self.assertNotIn("D:\\", [r["path"] for r in report["rows"]], "深度视图不呈现根行")
        deltas = {r["path"]: r["delta"] for r in report["rows"]}
        self.assertEqual(deltas, {"D:\\apps": 100, "D:\\data": 0, "D:\\docs": -50})
        self.assertEqual(sum(r["delta"] for r in report["rows"]), report["delta_total"])
        self.assertEqual(report["delta_total"], 50, "合计仍取原始根行 delta")

    def test_depth2_rolls_deep_chain_into_level2(self):
        """depth=2：4 层深链折叠到第 2 层（framework 取自身值，不累加后代）。"""
        report = self._report(depth=2)
        self.assertEqual(
            [r["path"] for r in report["rows"]],
            ["D:\\apps\\framework", "D:\\docs\\old", "D:\\data\\docs"],
        )
        deltas = {r["path"]: r["delta"] for r in report["rows"]}
        self.assertEqual(deltas["D:\\apps\\framework"], 80, "聚合=目标键自身值（380-300）")
        self.assertNotIn("D:\\apps\\framework\\core", deltas, "更深层键已折叠")
        self.assertNotIn("D:\\apps", deltas, "被折叠祖先不入行集")

    def test_depth_rows_keep_seven_keys_and_sign_flags(self):
        """聚合行行键仍为既有七项；removed/added 由聚合后的两侧映射判定。"""
        report = self._report(depth=1)
        expected = {"path", "baseline", "current", "delta", "growth_pct", "removed", "added"}
        for row in report["rows"]:
            self.assertEqual(set(row.keys()), expected)
        row = next(r for r in report["rows"] if r["path"] == "D:\\docs")
        self.assertEqual((row["baseline"], row["current"]), (200, 150))
        self.assertIs(row["removed"], False)

    def test_depth_wins_over_leaf_only(self):
        """depth 与 leaf_only 同传：以 depth 为准（rollup 行集互不重叠，不再叠叶子过滤）。"""
        with_depth = self._report(depth=1)
        both = self._report(depth=1, leaf_only=True)
        self.assertEqual(
            [r["path"] for r in with_depth["rows"]], [r["path"] for r in both["rows"]]
        )

    def test_no_depth_keeps_default_row_set(self):
        """不给 depth：行集合语义与既有完全一致（含根行与祖先行）。"""
        report = self._report()
        paths = [r["path"] for r in report["rows"]]
        self.assertIn("D:\\", paths)
        self.assertIn("D:\\apps", paths)
        self.assertEqual(len(paths), len(self.T0), "默认（leaf_only=False）逐键产行")

    def test_rollup_gap_uses_top_member_without_double_count(self):
        """层级缺口（根 D:\\a 下只有 D:\\a\\b\\c）：折叠到 D:\\a\\b，取顶层成员值不重复累加。"""
        baseline = _snapshot_dict("D:\\a", [("D:\\a\\b\\c", 100), ("D:\\a\\b\\c\\d.bin", 60)])
        current = _snapshot_dict("D:\\a", [("D:\\a\\b\\c", 150), ("D:\\a\\b\\c\\d.bin", 90)])
        report = compare.compare_snapshots(baseline, current, depth=1)
        self.assertEqual([r["path"] for r in report["rows"]], ["D:\\a\\b"])
        self.assertEqual(report["rows"][0]["baseline"], 100, "顶层成员值（含后代），非 160")
        self.assertEqual(report["rows"][0]["delta"], 50)

    def test_rollup_preserves_path_case(self):
        """折叠保留原大小写（normcase 仅用于比较键，不改行路径）。"""
        baseline = _snapshot_dict("D:\\T", [("D:\\T\\Apps\\Sub", 10)])
        current = _snapshot_dict("D:\\T", [("D:\\T\\Apps\\Sub", 30)])
        report = compare.compare_snapshots(baseline, current, depth=1)
        self.assertEqual([r["path"] for r in report["rows"]], ["D:\\T\\Apps"])

    def test_invalid_depth_rejected(self):
        """depth 必须是 ≥1 的 int；0/负数/bool/字符串一律 CompareError。"""
        for bad in (0, -1, True, "2"):
            with self.assertRaises(CompareError, msg="应拒绝 depth=%r" % (bad,)):
                self._report(depth=bad)

    def test_additive_summary_fields(self):
        """D4-5：additive 汇总字段（全量聚合行口径）与 delta_total 自洽。"""
        report = self._report(depth=1)
        for key in ("rows_total", "zero_count", "zero_total", "max_growth", "max_release", "depth"):
            self.assertIn(key, report)
        self.assertEqual(report["rows_total"], 3, "全量聚合行数（零行计入）")
        self.assertEqual(report["zero_total"], 1, "D:\\data 零增量")
        self.assertEqual(report["zero_count"], 1, "未开过滤时零行仍在返回行内")
        self.assertEqual(report["max_growth"], 100)
        self.assertEqual(report["max_release"], 50)
        self.assertEqual(report["depth"], 1)
        self.assertEqual(
            report["max_growth"] - report["max_release"], report["delta_total"],
            "摘要口径与 delta_total 自洽（本例：仅 apps 增长、docs 缩减）",
        )


class ZeroFilterAndOrderingTests(unittest.TestCase):
    """P4（问题 6）：零增量过滤（排序/截断之前）+ top_growth 排序口径。

    三个独立成因的对应护栏：
      ① _merge 逐键产行（delta 可为 0）→ drop_zero 在排序前剔除；
      ② top_growth 按有符号 delta 降序 → 负增量被挤出 Top-N → order_by="abs"；
      ③ 摘要口径（见 DepthAggregationTests.test_additive_summary_fields）。
    默认参数（不传新参）行为必须一字不改——cli.py:518 / tui.py:593 的同口径红线。
    """

    T0 = DepthAggregationTests.T0
    T1 = DepthAggregationTests.T1

    def _report(self, **kw):
        return compare.compare_snapshots(
            _snapshot_dict("D:\\", self.T0), _snapshot_dict("D:\\", self.T1), **kw
        )

    def test_drop_zero_removes_zero_rows_before_output(self):
        """drop_zero=True：零行不入返回行集，汇总字段仍记录「全量零行数」。"""
        report = self._report(depth=1, drop_zero=True)
        self.assertEqual([r["path"] for r in report["rows"]], ["D:\\apps", "D:\\docs"])
        self.assertEqual(report["zero_count"], 0, "返回行中的零行数（开过滤时恒 0）")
        self.assertEqual(report["zero_total"], 1, "全量聚合行中的零行数（D:\\data）")
        self.assertEqual(report["rows_total"], 3, "全量聚合行数（零过滤之前）")
        self.assertEqual(report["max_growth"], 100, "汇总取全量口径，不受过滤影响")
        self.assertEqual(report["max_release"], 50)

    def test_drop_zero_default_off_keeps_zero_rows(self):
        """不传 drop_zero：零行仍在返回行集（默认行为一字不改）。"""
        report = self._report(depth=1)
        self.assertEqual(len(report["rows"]), 3)
        self.assertEqual(report["zero_count"], 1)

    def test_leaf_only_default_unaffected_by_new_flags(self):
        """leaf_only 默认路径（app.py 既有调用形态）在不开新参时不含零过滤。"""
        report = self._report(leaf_only=True)
        zero_rows = [r for r in report["rows"] if r["delta"] == 0]
        self.assertEqual(len(zero_rows), 1, "既有 app 调用（leaf_only=True）仍含零行")
        self.assertEqual(zero_rows[0]["path"], "D:\\data\\docs")

    def test_top_growth_default_signed_order_unchanged(self):
        """默认 order_by="delta"：有符号降序——正增量挤压负增量（缺陷原貌，锁现状）。"""
        result = {"rows": [
            {"path": "C:\\a", "delta": 10},
            {"path": "C:\\b", "delta": -1000},
            {"path": "C:\\c", "delta": 5},
        ]}
        self.assertEqual([r["path"] for r in compare.top_growth(result, 2)], ["C:\\a", "C:\\c"])
        self.assertEqual([r["path"] for r in compare.top_growth(result, 3)],
                         ["C:\\a", "C:\\c", "C:\\b"])

    def test_top_growth_abs_order_keeps_both_signs(self):
        """order_by="abs"：按 |delta| 降序（次键 path 升序）——正负增量同榜。"""
        result = {"rows": [
            {"path": "C:\\a", "delta": 10},
            {"path": "C:\\b", "delta": -1000},
            {"path": "C:\\c", "delta": 5},
        ]}
        self.assertEqual([r["path"] for r in compare.top_growth(result, 2, order_by="abs")],
                         ["C:\\b", "C:\\a"])
        tied = {"rows": [{"path": "C:\\z", "delta": -7}, {"path": "C:\\y", "delta": 7}]}
        self.assertEqual([r["path"] for r in compare.top_growth(tied, 2, order_by="abs")],
                         ["C:\\y", "C:\\z"], "|delta| 相同时按 path 升序")

    def test_top_growth_abs_on_engine_result_keeps_negative(self):
        """引擎结果 + order_by="abs"：缩减目录不再被零行/正增量挤出榜单。"""
        report = self._report(depth=1, drop_zero=True)
        rows = compare.top_growth(report, 1, order_by="abs")
        self.assertEqual(rows[0]["path"], "D:\\apps")
        rows2 = compare.top_growth(report, 2, order_by="abs")
        self.assertIn("D:\\docs", [r["path"] for r in rows2], "负增量（-50）仍在榜")


class ThresholdConstantsTests(unittest.TestCase):
    """P12·W1.1：scan/snapshots/compare 三处 legacy 阈值常量同值（防单方漂移）。"""

    def test_threshold_constants_identical(self):
        self.assertEqual(scan.SIZE_UNKNOWN_MAX_BYTES, 16 * 1024 ** 4)
        self.assertEqual(
            scan.SIZE_UNKNOWN_MAX_BYTES,
            snapshots._LEGACY_SIZE_THRESHOLD,
            "snapshots 阈值与 scan 兜底上限漂移",
        )
        self.assertEqual(
            snapshots._LEGACY_SIZE_THRESHOLD,
            compare._LEGACY_SIZE_THRESHOLD,
            "compare 阈值与 snapshots 阈值漂移",
        )

    def test_legacy_count_propagates(self):
        """P12·W1.1：两个公开函数的返回体挂 legacy_count（additive），两侧行自统计一致。"""
        huge = 16 * 1024 ** 4
        baseline = {
            "header": {"format": 1, "machine_guid": "g" * 8, "root": "C:\\T",
                       "created_at": "2026-08-24T00:00:00", "auto": False},
            "rows": [{"p": "C:\\T", "s": huge}, {"p": "C:\\T\\a", "s": 10}],
        }
        current = {
            "header": dict(baseline["header"]),
            "rows": [{"p": "C:\\T", "s": 50}],
        }
        report = compare.compare_snapshots(baseline, current)
        self.assertEqual(report["legacy_count"], 1)
        diff = compare.diff_from_current(
            {__import__("pathlib").Path("C:\\T"): 50},
            baseline["rows"],
        )
        self.assertEqual(diff["legacy_count"], 1)


class RowsToMapTests(unittest.TestCase):
    """_rows_to_map：结构校验 + 大小写键现状。"""

    def test_rows_to_map_case_keys_current_behavior(self):
        """'C:\\' 与 'c:\\' 作为两个独立键共存（现状：不归一）；int 校验抛 CompareError。"""
        rows = [
            {"p": "C:\\", "s": 100},
            {"p": "c:\\", "s": 200},
        ]
        mapping = _rows_to_map(rows, "baseline")
        self.assertEqual(mapping, {"C:\\": 100, "c:\\": 200})
        self.assertEqual(len(mapping), 2, "大小写键当前共存为两个独立键（锁现状）")

    def test_rows_to_map_rejects_non_int_size(self):
        """s 非 int（str/bool/缺失）抛 CompareError；p 非字符串同样抛。"""
        for bad in (
            {"p": "C:\\a", "s": "5"},
            {"p": "C:\\a", "s": True},
            {"p": "C:\\a"},
            {"p": 3, "s": 1},
            "not-a-dict",
        ):
            with self.assertRaises(CompareError, msg=f"应拒绝 {bad!r}"):
                _rows_to_map([bad], "baseline")


class MergeTests(unittest.TestCase):
    """_merge：输出行键、排序次序、removed/added 标记与截断。"""

    def test_output_row_keys_and_sort_order(self):
        """行键固定七项；排序主键 |delta| 降序、次键 path 升序。"""
        b_map = {"C:\\a": 100, "C:\\b": 50}
        c_map = {"C:\\a": 160, "C:\\c": 30}
        rows, truncated = _merge(b_map, c_map)
        self.assertFalse(truncated)
        expected_keys = {
            "path", "baseline", "current", "delta", "growth_pct", "removed", "added",
        }
        for row in rows:
            self.assertEqual(set(row.keys()), expected_keys)
        # |delta|: a=60, b=50(removed), c=30(added) -> 排序 a, b, c
        self.assertEqual([r["path"] for r in rows], ["C:\\a", "C:\\b", "C:\\c"])
        self.assertEqual(rows[0]["delta"], 60)
        self.assertIs(rows[0]["added"], False)
        self.assertEqual(rows[1]["removed"], True)
        self.assertEqual(rows[1]["current"], 0)
        self.assertIs(rows[2]["added"], True)
        self.assertEqual(rows[2]["baseline"], 0)

    def test_sort_tie_breaks_by_path_ascending(self):
        """|delta| 相同时按 path 升序（确定性稳定次序）。"""
        b_map = {"C:\\y": 10, "C:\\x": 20}
        c_map = {"C:\\y": 20, "C:\\x": 10}
        rows, _ = _merge(b_map, c_map)
        deltas = [abs(r["delta"]) for r in rows]
        self.assertEqual(deltas, sorted(deltas, reverse=True))
        tied = [r["path"] for r in rows if abs(r["delta"]) == 10]
        self.assertEqual(tied, sorted(tied))

    def test_growth_pct_none_below_min_base(self):
        """baseline < MIN_GROWTH_BASE_BYTES 时 growth_pct 为 None。"""
        rows, _ = _merge({"C:\\small": 100}, {"C:\\small": 200})
        self.assertIsNone(rows[0]["growth_pct"])
        rows, _ = _merge(
            {"C:\\big": compare.MIN_GROWTH_BASE_BYTES},
            {"C:\\big": compare.MIN_GROWTH_BASE_BYTES * 2},
        )
        self.assertIsNotNone(rows[0]["growth_pct"])


if __name__ == "__main__":
    unittest.main()
