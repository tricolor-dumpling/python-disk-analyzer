"""snapshots 模块单元测试（任务 D6）。

覆盖：目录解析与 override/环境变量优先级、便携标记切换、机器标识稳定性、
save+load 往返、原子替换无 .tmp 残留、MAX_ROWS 超限、四原子谓词真值表、
自动日配额、滚动保留、损坏文件检测与自检归类、并发锁、禁用开关、日字节上界。
全部用 tempfile 隔离，不触碰真实 %LOCALAPPDATA%。
"""

import gzip
import json
import os
import tempfile
import unittest
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from unittest import mock

import snapshots
from snapshots import (
    AUTO_MAX_PER_ROOT_PER_DAY,
    KEEP_AUTO,
    KEEP_EXPLICIT,
    MAX_BYTES_PER_DAY,
    MAX_ROWS,
    SNAPSHOT_FORMAT_VERSION,
    SnapshotBusyError,
    SnapshotCorruptError,
    day_write_budget_ok,
    default_snapshot_dir,
    get_machine_guid,
    get_snapshot_dir,
    is_snapshot_disabled,
    list_snapshots,
    load_ledger,
    load_snapshot,
    record_day_writes,
    save_snapshot,
    scan_snapshot_dir,
    should_auto_save,
)


def patch_env(**overrides):
    """在测试范围内设置环境变量（键为真实变量名），并中和 DSA_SNAPSHOT_DIR / DSA_NO_SNAPSHOT。"""
    env = dict(overrides)
    env.setdefault("DSA_SNAPSHOT_DIR", "")
    env.setdefault("DSA_NO_SNAPSHOT", "")
    return mock.patch.dict(os.environ, env, clear=False)


MACHINE_GUID = "deadbeef-1234-5678-9abc-def012345678"


class SnapshotsTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="snaptest_")
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)


class ConstantsTests(SnapshotsTestCase):
    def test_constants_have_expected_values(self):
        self.assertEqual(SNAPSHOT_FORMAT_VERSION, 1)
        self.assertEqual(MAX_ROWS, 500000)
        self.assertEqual(MAX_BYTES_PER_DAY, 107374182)
        self.assertEqual(AUTO_MAX_PER_ROOT_PER_DAY, 1)
        self.assertEqual(KEEP_EXPLICIT, 30)
        self.assertEqual(KEEP_AUTO, 10)


class SnapshotDirTests(SnapshotsTestCase):
    def test_get_snapshot_dir_default_uses_localappdata(self):
        local = self.dir / "local"
        with patch_env(LOCALAPPDATA=str(local)):
            d = get_snapshot_dir()
        self.assertEqual(d, local / "PythonDiskScanner" / "snapshots")
        self.assertTrue(d.exists(), "默认目录应被自动创建")

    def test_get_snapshot_dir_override_wins(self):
        override = self.dir / "override_dir"
        with patch_env(DSA_SNAPSHOT_DIR=str(self.dir / "env_dir")):
            d = get_snapshot_dir(override=override)
        self.assertEqual(d, Path(override))

    def test_get_snapshot_dir_env_priority(self):
        env_dir = self.dir / "env_dir"
        with patch_env(DSA_SNAPSHOT_DIR=str(env_dir)):
            d = get_snapshot_dir()
        self.assertEqual(d, Path(env_dir))

    def test_portable_flag_ignored_uses_data_dir(self):
        """Phase 0 起默认快照目录不再跟随 portable.flag，统一走数据目录。"""
        app = self.dir / "portable_app"
        app.mkdir(parents=True)
        (app / "portable.flag").write_text("", encoding="utf-8")
        local = self.dir / "local"
        with patch_env(LOCALAPPDATA=str(local)):
            d = default_snapshot_dir(app_dir=app)
        self.assertEqual(d, local / "PythonDiskScanner" / "snapshots")
        self.assertTrue(d.exists())

    def test_default_uses_localappdata(self):
        local = self.dir / "local"
        with patch_env(LOCALAPPDATA=str(local)):
            d = default_snapshot_dir()
        self.assertEqual(d, local / "PythonDiskScanner" / "snapshots")
        self.assertTrue(d.exists())


class MachineGuidTests(SnapshotsTestCase):
    def test_machine_guid_from_registry_stable(self):
        guid_file = self.dir / "guid"
        with mock.patch.object(
            snapshots, "_read_registry_machine_guid", return_value="REG-GUID-1234-abcd"
        ):
            first = get_machine_guid(guid_file=guid_file)
            second = get_machine_guid(guid_file=guid_file)
        self.assertEqual(first, "REG-GUID-1234-abcd")
        self.assertEqual(second, first)
        self.assertFalse(guid_file.exists(), "注册表命中时不应写回退文件")

    def test_machine_guid_fallback_stable_and_persisted(self):
        guid_file = self.dir / "guid"
        with mock.patch.object(
            snapshots, "_read_registry_machine_guid", return_value=None
        ):
            first = get_machine_guid(guid_file=guid_file)
            second = get_machine_guid(guid_file=guid_file)
        self.assertEqual(first, second)
        self.assertTrue(guid_file.exists())
        self.assertEqual(guid_file.read_text(encoding="utf-8").strip(), first)
        uuid.UUID(first)  # 必须是合法 UUID 形态


def test_machine_guid_fallback_defaults_to_data_dir(self):
        """未注入 guid_file 时，Phase 0 回退文件写到数据目录根而非 Path.home()。"""
        local = self.dir / "local"
        with patch_env(LOCALAPPDATA=str(local)), mock.patch.object(
            snapshots, "_read_registry_machine_guid", return_value=None
        ):
            first = get_machine_guid()
            second = get_machine_guid()
        self.assertEqual(first, second)
        guid_file = local / "PythonDiskScanner" / ".pythondiskscanner_machine_guid"
        self.assertTrue(guid_file.exists(), "GUID 回退文件应位于数据目录根")
        self.assertEqual(guid_file.read_text(encoding="utf-8").strip(), first)
        uuid.UUID(first)  # 必须是合法 UUID 形态


class SaveLoadTests(SnapshotsTestCase):
    def test_save_and_load_roundtrip(self):
        root = str(self.dir / "scanroot")
        rows = [{"p": root + "\\a.txt", "s": 1234}, {"p": root + "\\b", "s": 0}]
        path = save_snapshot(
            root, rows, dir_path=self.dir / "snaps", machine_guid=MACHINE_GUID
        )
        self.assertIsNotNone(path)
        self.assertTrue(path.exists())
        data = load_snapshot(path)
        self.assertEqual(data["header"]["format"], SNAPSHOT_FORMAT_VERSION)
        self.assertEqual(data["header"]["machine_guid"], MACHINE_GUID)
        self.assertEqual(data["header"]["root"], root)
        self.assertFalse(data["header"]["auto"])
        self.assertIsInstance(data["header"]["created_at"], str)
        self.assertTrue(data["header"]["created_at"])
        self.assertEqual(data["rows"], rows)

    def test_atomic_replace_no_tmp_residue(self):
        d = self.dir / "snaps"
        save_snapshot(
            str(self.dir / "root"),
            [{"p": "x", "s": 1}],
            dir_path=d,
            machine_guid=MACHINE_GUID,
        )
        residue = [p.name for p in d.iterdir() if ".tmp" in p.name]
        self.assertEqual(residue, [])

    def test_max_rows_exceeds_raises_valueerror(self):
        rows = [{"p": "x", "s": 1}] * (MAX_ROWS + 1)
        with self.assertRaises(ValueError):
            save_snapshot(
                str(self.dir / "root"), rows, dir_path=self.dir / "snaps",
                machine_guid=MACHINE_GUID,
            )

    def test_filename_guid_mismatch_raises_corrupt(self):
        d = self.dir / "snaps"
        path = save_snapshot(
            str(self.dir / "root"),
            [{"p": "x", "s": 1}],
            dir_path=d,
            machine_guid=MACHINE_GUID,
        )
        renamed = path.with_name(path.name.replace("deadbeef", "cafebabe"))
        path.rename(renamed)
        with self.assertRaises(SnapshotCorruptError):
            load_snapshot(renamed)


class ShouldAutoSaveTests(SnapshotsTestCase):
    def _root(self):
        return str(self.dir / "root")

    def test_truth_table_eight_combinations(self):
        root = self._root()
        now = datetime(2024, 1, 15, 12, 0, 0)
        fingerprint = {"file_count": 10, "dir_count": 2, "root_mtime": 1.5, "ok": True}
        for bits in range(8):
            tree_complete = bool(bits & 4)
            dirty = bool(bits & 2)
            changed = bool(bits & 1)
            if changed:
                ledger = {}  # 无台账视为变
            else:
                ledger = {
                    root: {
                        "date": "2024-01-14",
                        "last_fingerprint": fingerprint,
                        "auto_count": 1,
                    }
                }
            ok, _reason = should_auto_save(
                root,
                tree_complete=tree_complete,
                dirty=dirty,
                fingerprint=fingerprint,
                ledger=ledger,
                now=now,
            )
            expected = tree_complete and (not dirty) and changed
            self.assertEqual(ok, expected, "bits=%d" % bits)

    def test_reasons_ordered(self):
        root = self._root()
        now = datetime(2024, 1, 15, 12, 0, 0)
        fp = {"n": 1}
        ledger = {root: {"date": "2024-01-14", "last_fingerprint": fp, "auto_count": 0}}

        ok, reason = should_auto_save(root, tree_complete=False, dirty=False,
                                      fingerprint=fp, ledger=ledger, now=now)
        self.assertFalse(ok)
        self.assertEqual(reason, "tree_incomplete")

        ok, reason = should_auto_save(root, tree_complete=True, dirty=True,
                                      fingerprint=fp, ledger=ledger, now=now)
        self.assertFalse(ok)
        self.assertEqual(reason, "dirty")

        ok, reason = should_auto_save(root, tree_complete=True, dirty=False,
                                      fingerprint=fp, ledger=ledger, now=now)
        self.assertFalse(ok)
        self.assertEqual(reason, "fingerprint_unchanged")

        ledger2 = {root: {"date": "2024-01-15", "last_fingerprint": None, "auto_count": 1}}
        ok, reason = should_auto_save(root, tree_complete=True, dirty=False,
                                      fingerprint=fp, ledger=ledger2, now=now)
        self.assertFalse(ok)
        self.assertEqual(reason, "already_saved_today")

        ok, reason = should_auto_save(root, tree_complete=True, dirty=False,
                                      fingerprint=fp, ledger={}, now=now)
        self.assertTrue(ok)
        self.assertEqual(reason, "ok")


class AutoSaveTests(SnapshotsTestCase):
    def test_auto_save_daily_quota_and_rollover(self):
        d = self.dir / "snaps"
        root = str(self.dir / "root")
        now = datetime(2024, 1, 15, 12, 0, 0)
        rows = [{"p": root + "\\a", "s": 1}]
        p1 = save_snapshot(root, rows, dir_path=d, auto=True,
                           machine_guid=MACHINE_GUID, now=now)
        self.assertIsNotNone(p1)

        # 同日同指纹 → 被谓词拒绝，且不新增快照文件
        p2 = save_snapshot(root, rows, dir_path=d, auto=True,
                           machine_guid=MACHINE_GUID, now=now)
        self.assertIsNone(p2)
        self.assertEqual(len(list_snapshots(dir_path=d)), 1)

        # 次日 + 不同指纹 → 允许再次自动落盘
        rows2 = [{"p": root + "\\b", "s": 2}]
        p3 = save_snapshot(root, rows2, dir_path=d, auto=True,
                           machine_guid=MACHINE_GUID, now=now + timedelta(days=1))
        self.assertIsNotNone(p3)
        self.assertEqual(len(list_snapshots(dir_path=d)), 2)


class RollingTests(SnapshotsTestCase):
    def _save_many(self, count, auto, d, root, start=None):
        base = start or datetime(2024, 1, 15, 12, 0, 0)
        for i in range(count):
            save_snapshot(
                root,
                [{"p": root + "\\f%d" % i, "s": i}],
                dir_path=d,
                auto=auto,
                machine_guid=MACHINE_GUID,
                now=base + timedelta(seconds=i),
            )

    def test_roll_explicit_keeps_30(self):
        d = self.dir / "snaps"
        root = str(self.dir / "root")
        self._save_many(35, auto=False, d=d, root=root)
        self.assertEqual(len(list_snapshots(root=root, dir_path=d)), KEEP_EXPLICIT)
        self.assertEqual(len(list_snapshots(dir_path=d)), KEEP_EXPLICIT)

    def test_roll_auto_keeps_10(self):
        d = self.dir / "snaps"
        root = str(self.dir / "root")
        with mock.patch.object(snapshots, "should_auto_save", return_value=(True, "ok")):
            self._save_many(12, auto=True, d=d, root=root)
        self.assertEqual(len(list_snapshots(root=root, dir_path=d)), KEEP_AUTO)
        self.assertEqual(len(list_snapshots(dir_path=d)), KEEP_AUTO)


class CorruptTests(SnapshotsTestCase):
    def test_load_corrupt_gzip_raises(self):
        d = self.dir / "snaps"
        d.mkdir(parents=True)
        bad = d / "broken_20240101_000000_explicit_deadbeef.snap.gz"
        bad.write_bytes(b"this is not gzip data")
        with self.assertRaises(SnapshotCorruptError):
            load_snapshot(bad)

    def test_header_crc_mismatch_raises_corrupt(self):
        d = self.dir / "snaps"
        d.mkdir(parents=True)
        header = {
            "format": 1,
            "machine_guid": MACHINE_GUID,
            "root": str(self.dir / "r"),
            "created_at": "2024-01-15T12:00:00",
            "auto": False,
            "crc": 0,  # 故意错误 CRC
        }
        payload = (
            json.dumps(header) + "\n" + json.dumps({"p": "x", "s": 1}) + "\n"
        )
        path = d / "r_20240115_120000_explicit_deadbeef.snap.gz"
        with gzip.open(str(path), "wt", encoding="utf-8") as fh:
            fh.write(payload)
        with self.assertRaises(SnapshotCorruptError):
            load_snapshot(path)

    def test_scan_snapshot_dir_splits_ok_and_corrupt(self):
        d = self.dir / "snaps"
        good = save_snapshot(
            str(self.dir / "root"),
            [{"p": "x", "s": 1}],
            dir_path=d,
            machine_guid=MACHINE_GUID,
        )
        bad = d / "broken_20240101_000000_explicit_deadbeef.snap.gz"
        bad.write_bytes(b"garbage")
        ok_paths, corrupt_paths = scan_snapshot_dir(d)
        self.assertIn(good, ok_paths)
        self.assertIn(bad, corrupt_paths)
        self.assertTrue(bad.exists(), "自检不应删除损坏文件")

    def test_scan_missing_dir_returns_empty(self):
        ok_paths, corrupt_paths = scan_snapshot_dir(self.dir / "nope")
        self.assertEqual(ok_paths, [])
        self.assertEqual(corrupt_paths, [])


class ConcurrencyTests(SnapshotsTestCase):
    def test_concurrent_lock_raises_busy(self):
        d = self.dir / "snaps"
        d.mkdir(parents=True)
        (d / ".snapshot.lock").write_text(str(os.getpid()), encoding="utf-8")
        with self.assertRaises(SnapshotBusyError):
            save_snapshot(
                str(self.dir / "root"),
                [{"p": "x", "s": 1}],
                dir_path=d,
                machine_guid=MACHINE_GUID,
            )


class DisabledTests(SnapshotsTestCase):
    def test_snapshot_disabled_env(self):
        for value in ("", "0"):
            with patch_env(DSA_NO_SNAPSHOT=value):
                self.assertFalse(is_snapshot_disabled(), "value=%r" % value)
        for value in ("1", "true", "yes"):
            with patch_env(DSA_NO_SNAPSHOT=value):
                self.assertTrue(is_snapshot_disabled(), "value=%r" % value)


class DayBudgetTests(SnapshotsTestCase):
    def test_day_byte_budget(self):
        d = self.dir / "usage"
        self.assertTrue(day_write_budget_ok(MAX_BYTES_PER_DAY, dir_path=d))
        self.assertFalse(day_write_budget_ok(MAX_BYTES_PER_DAY + 1, dir_path=d))
        record_day_writes(MAX_BYTES_PER_DAY - 100, dir_path=d)
        self.assertTrue(day_write_budget_ok(99, dir_path=d))
        self.assertFalse(day_write_budget_ok(101, dir_path=d))

    def test_day_byte_budget_resets_next_day(self):
        d = self.dir / "usage"
        today = datetime(2024, 1, 15, 10, 0, 0)
        tomorrow = datetime(2024, 1, 16, 10, 0, 0)
        record_day_writes(MAX_BYTES_PER_DAY, now=today, dir_path=d)
        self.assertFalse(day_write_budget_ok(1, now=today, dir_path=d))
        self.assertTrue(day_write_budget_ok(MAX_BYTES_PER_DAY, now=tomorrow, dir_path=d))


class LedgerTests(SnapshotsTestCase):
    def test_load_save_update_ledger_roundtrip(self):
        d = self.dir / "snaps"
        root = str(self.dir / "root")
        fp = {"n": 1}
        ledger = snapshots.update_ledger_after_save(
            root, fp, auto=True, now=datetime(2024, 1, 15), dir_path=d
        )
        self.assertEqual(ledger[root]["last_fingerprint"], fp)
        self.assertEqual(ledger[root]["date"], "2024-01-15")
        self.assertEqual(ledger[root]["auto_count"], 1)
        # 重新加载持久化台账应一致
        reloaded = load_ledger(d)
        self.assertEqual(reloaded[root]["last_fingerprint"], fp)
        self.assertEqual(reloaded[root]["auto_count"], 1)
        # 损坏台账 -> 返回空
        corrupted = d / "ledger.json"
        corrupted.write_text("{ not valid", encoding="utf-8")
        self.assertEqual(load_ledger(d), {})


if __name__ == "__main__":
    unittest.main()