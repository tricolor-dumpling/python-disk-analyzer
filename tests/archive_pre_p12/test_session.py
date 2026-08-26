"""session 模块单元测试（Phase 1）。

覆盖：session id 生成、保存/读取回环、中文 ensure_ascii=False、损坏返回 None、
列表排序、删除。全程使用临时目录注入 dir_path，不触碰真实数据目录。
"""

import tempfile
import unittest
from datetime import datetime
from pathlib import Path

import session


class SessionTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.dir = Path(self._tmp.name)

    def test_build_session_id_format(self):
        sid = session.build_session_id(
            now=datetime(2026, 8, 22, 15, 30, 0, 123456),
            machine_guid="deadbeef-1234-5678-9abc-def012345678",
        )
        self.assertTrue(sid.startswith("session_20260822_153000_123456_deadbeef"))
        self.assertTrue(sid.endswith(".json"))

    def test_save_and_load_roundtrip(self):
        payload = {
            "session_id": session.build_session_id(),
            "auto": True,
            "machine_guid": "guid-1",
            "roots": {
                "C:\\": {"root": "C:\\", "snapshot": "c.snap.gz", "snapshot_path": "C:\\snap\\c.snap.gz"},
                "D:\\": {"root": "D:\\", "snapshot": "d.snap.gz", "snapshot_path": "C:\\snap\\d.snap.gz"},
            },
        }
        path = session.save_session(payload, dir_path=self.dir)
        self.assertTrue(path.exists())
        data = session.load_session(path)
        self.assertEqual(data["session_id"], payload["session_id"])
        self.assertEqual(data["roots"]["C:\\"]["snapshot"], "c.snap.gz")
        self.assertTrue(data["created_at"])
        # 中文与 ensure_ascii=False：中文原样落盘
        text = path.read_text(encoding="utf-8")
        self.assertNotIn("\\u", text)

    def test_save_session_with_chinese(self):
        payload = {"session_id": "session_测试", "roots": {"目录": {"说明": "磁盘扫描"}}}
        path = session.save_session(payload, dir_path=self.dir)
        self.assertIn("磁盘扫描", path.read_text(encoding="utf-8"))
        self.assertEqual(session.load_session(path)["roots"]["目录"]["说明"], "磁盘扫描")

    def test_load_missing_or_corrupt_returns_none(self):
        self.assertIsNone(session.load_session(self.dir / "no.json"))
        bad = self.dir / "bad.json"
        bad.write_text("{not json", encoding="utf-8")
        self.assertIsNone(session.load_session(bad))
        not_dict = self.dir / "arr.json"
        not_dict.write_text("[1, 2, 3]", encoding="utf-8")
        self.assertIsNone(session.load_session(not_dict))

    def test_list_sessions_sorted_by_name_desc(self):
        ids = []
        for i in range(3):
            payload = {"session_id": session.build_session_id(), "n": i}
            session.save_session(payload, dir_path=self.dir)
            ids.append(payload["session_id"])
        listed = [p.name for p in session.list_sessions(self.dir)]
        self.assertEqual(listed, list(reversed(ids)))

    def test_delete_session(self):
        path = session.save_session({"session_id": "session_temp"}, dir_path=self.dir)
        self.assertTrue(session.delete_session(path))
        self.assertFalse(path.exists())
        self.assertFalse(session.delete_session(path))

    def test_session_path_ignores_duplicate_suffix(self):
        path = session.session_path("session_x.json", dir_path=self.dir)
        self.assertEqual(path.name, "session_x.json")
        path2 = session.session_path("session_x", dir_path=self.dir)
        self.assertEqual(path, path2)


if __name__ == "__main__":
    unittest.main()