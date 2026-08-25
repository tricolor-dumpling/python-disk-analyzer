"""快照格式 golden 护栏（P12·W1.0，DEF-030 转规约）。

锁定快照 format v1 红线：save_snapshot 写入 -> load_snapshot 读回，
header 五规范字段（format/machine_guid/root/created_at/auto）逐项相等、
rows 逐条 {p,s} 相等；0 字节行与超大数行（>= 2**53）原样保留（当前不过滤，
先锁现状——W1.1 哨兵收口改实现时同 PR 改期望）。

全程注入 machine_guid 与临时 dir_path，不触碰真实数据目录。
"""

import gzip
import json
import os
import tempfile
import unittest
from pathlib import Path

import snapshots


GUID = "deadbeef-1234-5678-9abc-def012345678"


def _save_and_load(rows, tmp):
    """在 tmp 目录保存一份显式快照并立即读回，返回 (loaded, final_path)。"""
    d = Path(tmp)
    final_path = snapshots.save_snapshot(
        "C:\\Users\\Demo",
        rows,
        dir_path=d,
        auto=False,
        machine_guid=GUID,
        fingerprint={"count": len(rows), "crc32": 0},
    )
    self_path = snapshots.load_snapshot(final_path)
    return self_path, final_path


class SnapshotGoldenTests(unittest.TestCase):
    """save_snapshot/load_snapshot 往返 golden：header 五字段 + rows 逐条相等。"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tmp = self._tmp.name

    def test_roundtrip_preserves_header_and_rows(self):
        """普通行往返：header 五规范字段一致、rows 逐条 p/s 相等、format==v1。"""
        rows = [
            {"p": "C:\\Users\\Demo", "s": 1000},
            {"p": "C:\\Users\\Demo\\Docs", "s": 700},
            {"p": "C:\\Users\\Demo\\Docs\\a.txt", "s": 300},
        ]
        loaded, final_path = _save_and_load(rows, self.tmp)

        header = loaded["header"]
        # 五规范字段逐一断言（_public_header 不含 crc，但写盘头部带 crc）
        self.assertEqual(header["format"], snapshots.SNAPSHOT_FORMAT_VERSION)
        self.assertEqual(header["format"], 1, "快照 format v1 红线")
        self.assertEqual(header["machine_guid"], GUID)
        self.assertEqual(header["root"], "C:\\Users\\Demo")
        self.assertIsInstance(header["created_at"], str)
        self.assertIs(header["auto"], False)
        # 写盘文件首行头部应额外携带 crc（读回的公共 header 不暴露它）
        with gzip.open(str(final_path), "rt", encoding="utf-8") as fh:
            raw_header = json.loads(fh.readline())
        self.assertIn("crc", raw_header)

        # rows 逐条 p/s 相等（顺序保持）
        self.assertEqual(loaded["rows"], rows)

        # 文件名符合命名规则且与头部匹配（load_snapshot 已校验，这里再锚一次）
        self.assertTrue(str(final_path).endswith(".snap.gz"))

    def test_zero_size_and_big_rows_kept(self):
        """锁现状：s=0 与 s=2**53 行原样保留（当前不过滤；W1.1 改期望时同 PR）。"""
        big = 2 ** 53
        rows = [
            {"p": "C:\\Users\\Demo", "s": big + 10},
            {"p": "C:\\Users\\Demo\\empty_dir", "s": 0},
            {"p": "C:\\Users\\Demo\\big.bin", "s": big},
            {"p": "C:\\Users\\Demo\\zero.txt", "s": 0},
        ]
        loaded, _ = _save_and_load(rows, self.tmp)
        self.assertEqual(loaded["rows"], rows, "0 字节与大数行当前均不过滤（锁现状）")


if __name__ == "__main__":
    unittest.main()
