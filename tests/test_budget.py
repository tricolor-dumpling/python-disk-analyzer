"""P12·W2.2 日配额接线测试：auto 硬门槛 / explicit 软警告 / 通知通道 / 并发记账。"""

import json
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

import snapshots


ROWS = [{"p": "C:\\T", "s": 1000}, {"p": "C:\\T\\a", "s": 500}]
FP = {"count": 2, "crc32": 7}


class DayBudgetTests(unittest.TestCase):
    """auto=硬门槛 / explicit=软警告（W2.2 设计）。"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.dir_path = Path(self._tmp.name)
        # 收紧日配额到 100 字节，便于触发超限分支
        patcher = mock.patch.object(snapshots, "MAX_BYTES_PER_DAY", 10)
        patcher.start()
        self.addCleanup(patcher.stop)

    def _day_writes_bytes(self):
        p = self.dir_path / "day_writes.json"
        if not p.exists():
            return 0
        try:
            return int(json.loads(p.read_text(encoding="utf-8")).get("bytes") or 0)
        except (OSError, ValueError):
            return -1

    def test_auto_over_budget_returns_none_with_notice(self):
        """auto 超限：None＋notice.reason==day_budget_exceeded＋day_writes 不变。"""
        saved = snapshots.save_snapshot(
            "C:\\T", ROWS, dir_path=self.dir_path, auto=True,
            machine_guid="deadbeef-1234", fingerprint=FP,
        )
        self.assertIsNone(saved, "auto 超限必须跳过（硬门槛）")
        notice = snapshots.consume_last_save_notice()
        self.assertIsNotNone(notice)
        self.assertEqual(notice["reason"], snapshots.REASON_DAY_BUDGET_EXCEEDED)
        self.assertIsNone(snapshots.consume_last_save_notice(), "通知必须读后即清")
        self.assertEqual(self._day_writes_bytes(), 0, "跳过时不得记账")

    def test_explicit_over_budget_saves_with_soft_warning(self):
        """explicit 超限：仍保存成功（返回 Path）＋软警告 notice。"""
        saved = snapshots.save_snapshot(
            "C:\\T", ROWS, dir_path=self.dir_path, auto=False,
            machine_guid="deadbeef-1234", fingerprint=FP,
        )
        self.assertIsNotNone(saved, "explicit 超限仍应保存成功（软警告）")
        notice = snapshots.consume_last_save_notice()
        self.assertIsNotNone(notice)
        self.assertEqual(notice["reason"], snapshots.REASON_DAY_BUDGET_EXCEEDED)
        self.assertIn("软警告", notice["message"])
        self.assertTrue(saved.exists())

    def test_under_budget_no_notice(self):
        """未超限：notice 为 None，行为与现状一致。"""
        with mock.patch.object(snapshots, "MAX_BYTES_PER_DAY", 10 * 1024 * 1024):
            for auto in (False, True):
                saved = snapshots.save_snapshot(
                    "C:\\T", ROWS, dir_path=self.dir_path, auto=auto,
                    machine_guid="deadbeef-1234",
                    fingerprint={"count": 99, "crc32": auto},  # 指纹变化避免谓词拒绝
                )
                if auto:
                    self.assertIsNotNone(saved)
                self.assertIsNone(snapshots.consume_last_save_notice())
        self.assertGreater(self._day_writes_bytes(), 0, "按实际大小记账")

    def test_concurrent_saves_serialize_accounting(self):
        """并发夹具：N 线程同目录保存 → day_writes.json 可解析、累计==实际大小之和。

        冲突线程按契约收到 SnapshotBusyError 后短暂重试（锁内串行语义），
        最终全部成功；记账必须精确等于各份实际大小之和。
        """
        with mock.patch.object(snapshots, "MAX_BYTES_PER_DAY", 10 * 1024 * 1024):
            sizes_on_disk = []
            sizes_lock = threading.Lock()
            threads = []
            for i in range(8):
                def worker(idx=i):
                    rows = [{"p": f"C:\\T{idx}", "s": 100 + idx}]
                    path = None
                    for _attempt in range(100):
                        try:
                            path = snapshots.save_snapshot(
                                f"C:\\T{idx}", rows, dir_path=self.dir_path,
                                auto=False, machine_guid="deadbeef-1234",
                                fingerprint={"count": idx + 10, "crc32": idx},
                                now=None,
                            )
                            break
                        except snapshots.SnapshotBusyError:
                            time.sleep(0.01)  # 锁被他人持有：稍后重试
                    if path is None:
                        return
                    with sizes_lock:
                        sizes_on_disk.append(path.stat().st_size)
                t = threading.Thread(target=worker)
                threads.append(t)
            for t in threads:
                t.start()
            for t in threads:
                t.join(timeout=30)
        self.assertEqual(len(sizes_on_disk), 8, "重试后全部保存都应成功")
        recorded = self._day_writes_bytes()
        actual_sum = sum(sizes_on_disk)
        self.assertEqual(recorded, actual_sum,
                         "锁内串行记账必须精确等于各份实际大小之和")

    def test_tui_style_explicit_over_budget_notice_consumable_twice_safe(self):
        """消费方重复消费安全：第二次读取为 None（读后即清契约）。"""
        snapshots.save_snapshot("C:\\T", ROWS, dir_path=self.dir_path, auto=False,
                                machine_guid="deadbeef-1234", fingerprint=FP)
        first = snapshots.consume_last_save_notice()
        second = snapshots.consume_last_save_notice()
        self.assertIsNotNone(first)
        self.assertIsNone(second)


if __name__ == "__main__":
    unittest.main()
