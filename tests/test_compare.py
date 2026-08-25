"""compare 模块现状护栏（P12·W1.0，冲突9）。

锁定 _rows_to_map 对大小写键的现状行为（'C:\\' 与 'c:\\' 共存为两个独立键）、
_merge 输出行键与排序次序；int 校验非法输入抛 CompareError。
合计口径（total_* = sum(map.values())）的现状由 W1.2 下沉公共助手时同 PR 改期望，
本文件先锁「行级」行为，避免护栏与整改互相踩踏。
"""

import unittest

import compare
from compare import CompareError, _merge, _rows_to_map


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
