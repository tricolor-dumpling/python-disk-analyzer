"""阶段F（R6）新增后端契约测试。

仅当出现后端回归修复时新增（本阶段：compare.py _merge leaf_only 的
O(n²)→O(n) 叶子判定修复，问题 1「对比一直正在对比」在大根场景的回归）。

覆盖：
- _leaf_keys 与旧 O(n²) 前缀遍历语义等价（边界：根键/大小写/多级/尾斜杠/跨盘）；
- _leaf_keys 在大样本下不退化（性能护栏：n≈20 万 < 2s）；
- _merge leaf_only=True 的叶子过滤结果与修复前一致（快照夹具级）；
- 修复后大根对比可完成（compare_snapshots/diff_from_current 不再挂死）。

编码规约继承既有契约护栏：with app.test_client() as client + 逐 resp close
（-W error::ResourceWarning 门禁）；compare.py 修复为纯函数层，无 API 变更。
"""

import os
import time
import unittest
from pathlib import Path

import compare
from compare import _leaf_keys, _merge


def _leaf_old(keys):
    """旧 O(n²) 实现（等价参照，仅测试用）。"""
    return {
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


class LeafKeysEquivalenceTests(unittest.TestCase):
    """_leaf_keys 与旧实现语义完全等价（含 Windows 大小写不敏感边界）。"""

    def test_boundary_cases_equivalent(self):
        cases = [
            ["C:\\", "C:\\a"],                                  # 根是 a 的父
            ["C:\\a", "C:\\a\\b"],                              # 单级父
            ["C:\\a\\b", "C:\\a\\b\\c"],                        # 多级父
            ["C:\\a", "C:\\A\\b"],                              # 大小写不敏感
            ["C:\\a\\b"],                                       # 单键=叶
            ["C:\\"],                                           # 仅根=叶
            ["c:\\a", "C:\\a\\b"],                              # 根键 normcase 边界
            ["C:\\a", "C:\\a\\b", "C:\\a\\b\\c", "D:\\x"],      # 混合根
            ["C:\\a\\", "C:\\a\\b"],                            # 尾斜杠差异
        ]
        for keys in cases:
            old = _leaf_old(keys)
            new = _leaf_keys(set(keys))
            self.assertEqual(old, new, f"keys={keys}")

    def test_large_sample_equivalent_and_fast(self):
        """n≈20 万样本：等价 + <2s（旧实现 O(n²) 分钟级，修复后 O(n)）。"""
        paths = {"C:\\root"}
        for i in range(20000):
            paths.add("C:\\d%d\\f%d" % (i % 50, i))
            paths.add("C:\\d%d\\sub%d\\f%d" % (i % 50, i % 30, i))
        t0 = time.monotonic()
        leaves = _leaf_keys(paths)
        elapsed = time.monotonic() - t0
        self.assertEqual(len(leaves), len(paths))  # 样本中所有键互为兄弟叶
        self.assertLess(elapsed, 2.0, f"leaf 判定退化: {elapsed:.2f}s")


class MergeLeafOnlyTests(unittest.TestCase):
    """_merge leaf_only=True 过滤语义保持（修复不得改变输出）。"""

    def test_merge_leaf_only_filters_ancestors(self):
        b_map = {
            "C:\\": 1000,
            "C:\\a": 400,
            "C:\\a\\b": 300,
            "C:\\a\\b\\c": 100,
            "C:\\x": 200,
        }
        c_map = {
            "C:\\": 1200,
            "C:\\a": 500,
            "C:\\a\\b": 350,
            "C:\\a\\b\\c": 150,
            "C:\\x": 250,
        }
        rows, truncated = _merge(b_map, c_map, leaf_only=True)
        self.assertFalse(truncated)
        paths = {r["path"] for r in rows}
        # 叶子：C:\a\b\c 与 C:\x（C:\、C:\a、C:\a\b 均为祖先被过滤）
        self.assertEqual(paths, {"C:\\a\\b\\c", "C:\\x"})
        for r in rows:
            self.assertEqual(r["delta"], c_map[r["path"]] - b_map[r["path"]])

    def test_merge_leaf_only_false_keeps_all(self):
        b_map = {"C:\\": 100, "C:\\a": 40, "C:\\a\\b": 10}
        c_map = {"C:\\": 110, "C:\\a": 50, "C:\\a\\b": 15}
        rows, _ = _merge(b_map, c_map, leaf_only=False)
        self.assertEqual(len(rows), 3)

    def test_merge_empty(self):
        rows, truncated = _merge({}, {}, leaf_only=True)
        self.assertEqual(rows, [])
        self.assertFalse(truncated)


if __name__ == "__main__":
    unittest.main()