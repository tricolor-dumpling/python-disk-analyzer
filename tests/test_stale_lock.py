"""P12·W2.3 陈旧锁检测测试：死 PID/TTL/活进程/非法内容 四夹具。"""

import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

import snapshots


GUID = "deadbeef-1234"
ROWS = [{"p": "C:\\T", "s": 100}]
FP = {"count": 1, "crc32": 3}


class StaleLockTests(unittest.TestCase):
    """_acquire_lock 偷锁判定矩阵（W2.3 §3）。"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.dir_path = Path(self._tmp.name)
        self.lock_path = self.dir_path / snapshots._LOCK_FILENAME

    def _dead_pid(self):
        """拿一个确定已退出的真实 PID（避免猜数字）。"""
        proc = subprocess.Popen(
            [sys.executable, "-c", "pass"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        proc.wait(timeout=10)
        return proc.pid

    def _write_lock(self, content, age_seconds=0.0):
        self.lock_path.write_text(content, encoding="utf-8")
        if age_seconds:
            old = time.time() - age_seconds
            os.utime(self.lock_path, (old, old))

    def test_dead_pid_fresh_mtime_is_busy(self):
        """死 PID＋mtime<600s → Busy（TTL 未到不偷）。"""
        self._write_lock(str(self._dead_pid()), age_seconds=0)
        with self.assertRaises(snapshots.SnapshotBusyError):
            snapshots.save_snapshot(
                "C:\\T", ROWS, dir_path=self.dir_path, auto=False,
                machine_guid=GUID, fingerprint=FP,
            )

    def test_dead_pid_expired_lock_stolen_and_save_succeeds(self):
        """死 PID＋mtime≥600s → 偷锁成功、后续保存正常。"""
        self._write_lock(str(self._dead_pid()), age_seconds=snapshots.STALE_LOCK_TTL_SECONDS + 60)
        saved = snapshots.save_snapshot(
            "C:\\T", ROWS, dir_path=self.dir_path, auto=False,
            machine_guid=GUID, fingerprint=FP,
        )
        self.assertIsNotNone(saved)
        self.assertFalse(self.lock_path.exists(), "保存完成后锁必须释放")

    def test_live_pid_over_ttl_is_busy(self):
        """活 PID＋超 TTL → Busy（活进程优先于 TTL，绝不偷活锁）。"""
        self._write_lock(str(os.getpid()),
                         age_seconds=snapshots.STALE_LOCK_TTL_SECONDS + 60)
        with self.assertRaises(snapshots.SnapshotBusyError):
            snapshots.save_snapshot(
                "C:\\T", ROWS, dir_path=self.dir_path, auto=False,
                machine_guid=GUID, fingerprint=FP,
            )

    def test_illegal_content_uses_ttl_only(self):
        """锁内容非法 → 按 PID 未知处理，仅 TTL 生效：新锁 Busy、过期锁可偷。"""
        # 非法内容 + 新 mtime → Busy
        self._write_lock("not-a-pid", age_seconds=0)
        with self.assertRaises(snapshots.SnapshotBusyError):
            snapshots.save_snapshot(
                "C:\\T", ROWS, dir_path=self.dir_path, auto=False,
                machine_guid=GUID, fingerprint=FP,
            )
        # 非法内容 + 过期 mtime → 偷锁成功
        self._write_lock("not-a-pid", age_seconds=snapshots.STALE_LOCK_TTL_SECONDS + 60)
        saved = snapshots.save_snapshot(
            "C:\\T", ROWS, dir_path=self.dir_path, auto=False,
            machine_guid=GUID, fingerprint=FP,
        )
        self.assertIsNotNone(saved)


if __name__ == "__main__":
    unittest.main()
