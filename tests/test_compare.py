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
