"""keyrouter 模块单元测试（任务 D2）：键位注册表 / 动作常量 / 纯函数映射 / 禁键黑名单 / 帮助文案。

覆盖：
- key_to_action：每个注册键（含大小写、0xe0/0x00 扩展前缀）映射正确；
- 未知键一律 ACT_NONE；黑名单示例键（Ctrl+C/Z/V、Tab、Ctrl+Break、F1-F12、
  Alt+任意）→ ACT_NONE；
- 注册键优先于 0x00 前缀黑名单通配（0x00H/0x00P 方向键不被 Alt 通配误伤）；
- 注册表无重复键字节、与黑名单精确条目无重叠；
- help_text() 非空、含主要键名，且由注册表字段同源生成。
"""

import unittest

import keyrouter
from keyrouter import (
    ACT_BACK,
    ACT_CHANGE_ROOT,
    ACT_ENTER,
    ACT_MOVE_DOWN,
    ACT_MOVE_UP,
    ACT_NONE,
    ACT_QUIT,
    ACT_SAVE_SNAPSHOT,
    FORBIDDEN_KEYS,
    KEY_BINDINGS,
    help_text,
    key_to_action,
)

# 黑名单示例（精确序列）：Ctrl+C / Ctrl+Z / Ctrl+V / Tab / Ctrl+Break
FORBIDDEN_SAMPLES = (b"\x03", b"\x1a", b"\x16", b"\t", b"\x00\x00")
# 黑名单示例（F 键：0x00/0xe0 前缀 + 扫描码）
FUNC_KEY_SAMPLES = (
    b"\x00\x3b", b"\xe0\x3b",  # F1
    b"\x00\x44", b"\xe0\x44",  # F10
    b"\x00\x85", b"\xe0\x85",  # F11
    b"\x00\x86", b"\xe0\x86",  # F12
)


class ActionConstantTests(unittest.TestCase):
    """动作常量：全部存在且为模块级字符串常量。"""

    def test_existing_action_constants_are_str(self):
        for name in ("ACT_MOVE_UP", "ACT_MOVE_DOWN", "ACT_ENTER", "ACT_BACK",
                     "ACT_CHANGE_ROOT", "ACT_QUIT"):
            self.assertTrue(hasattr(keyrouter, name), "缺少常量 %s" % name)
            self.assertIsInstance(getattr(keyrouter, name), str)

    def test_reserved_future_action_constants_are_str(self):
        for name in ("ACT_REFRESH_LIGHT", "ACT_REFRESH_DEEP", "ACT_PATH_JUMP",
                     "ACT_SAVE_SNAPSHOT", "ACT_HISTORY", "ACT_HELP", "ACT_NONE"):
            self.assertTrue(hasattr(keyrouter, name), "缺少预留常量 %s" % name)
            self.assertIsInstance(getattr(keyrouter, name), str)


class KeyToActionTests(unittest.TestCase):
    """key_to_action：注册键映射、大小写同键、扩展键前缀、未知键归 ACT_NONE。"""

    def test_move_up_all_variants(self):
        for kb in (b"w", b"W", b"\xe0H", b"\x00H"):
            self.assertEqual(key_to_action(kb), ACT_MOVE_UP, "键 %r 应上移" % kb)

    def test_move_down_all_variants(self):
        # 大写 S 自 D8 起注册为保存快照（ACT_SAVE_SNAPSHOT），小写 s 保持下移
        for kb in (b"s", b"\xe0P", b"\x00P"):
            self.assertEqual(key_to_action(kb), ACT_MOVE_DOWN, "键 %r 应下移" % kb)
        self.assertEqual(key_to_action(b"S"), ACT_SAVE_SNAPSHOT)

    def test_enter_and_backspace(self):
        self.assertEqual(key_to_action(b"\r"), ACT_ENTER)
        self.assertEqual(key_to_action(b"\x08"), ACT_BACK)

    def test_change_root_and_quit_both_cases(self):
        self.assertEqual(key_to_action(b"c"), ACT_CHANGE_ROOT)
        self.assertEqual(key_to_action(b"C"), ACT_CHANGE_ROOT)
        self.assertEqual(key_to_action(b"q"), ACT_QUIT)
        self.assertEqual(key_to_action(b"Q"), ACT_QUIT)

    def test_unknown_keys_map_to_none(self):
        for kb in (b"x", b"X", b"a", b"1", b" ", b"\x01", b"\xff",
                   b"\xe0K", b"\x00z", b"\xe0", b"", b"abc"):
            self.assertEqual(key_to_action(kb), ACT_NONE, "未知键 %r 应归 ACT_NONE" % kb)

    def test_state_argument_is_accepted_and_ignored(self):
        self.assertEqual(key_to_action(b"w", state={"mode": "preview"}), ACT_MOVE_UP)

    def test_every_registered_key_maps_to_its_own_action(self):
        for entry in KEY_BINDINGS:
            for kb in entry["keys"]:
                self.assertEqual(
                    key_to_action(kb), entry["action"],
                    "注册键 %r 应映射到 %s" % (kb, entry["action"]),
                )


class ForbiddenKeysTests(unittest.TestCase):
    """黑名单：已知但禁用的键不被执行（→ ACT_NONE），且不影响注册键。"""

    def test_ctrl_combos_and_tab_map_to_none(self):
        for kb in FORBIDDEN_SAMPLES:
            self.assertEqual(key_to_action(kb), ACT_NONE, "禁键 %r 应归 ACT_NONE" % kb)

    def test_function_keys_map_to_none(self):
        for kb in FUNC_KEY_SAMPLES:
            self.assertEqual(key_to_action(kb), ACT_NONE, "禁键 %r 应归 ACT_NONE" % kb)

    def test_alt_any_via_00_prefix_wildcard(self):
        # Alt+任意：0x00 前缀 + 任意第二字节（未注册的第二字节）→ ACT_NONE
        for second in (b"a", b"z", b"q", b"X", b"1", b"\x00"):
            self.assertEqual(key_to_action(b"\x00" + second), ACT_NONE)

    def test_registered_keys_win_over_00_prefix_wildcard(self):
        # 0x00 前缀在部分代码页下是扩展方向键前缀，注册键优先于黑名单通配
        self.assertEqual(key_to_action(b"\x00H"), ACT_MOVE_UP)
        self.assertEqual(key_to_action(b"\x00P"), ACT_MOVE_DOWN)

    def test_forbidden_structure(self):
        # 精确条目为 bytes；唯一的前缀通配条目为 (b'\x00',)
        wildcards = [k for k in FORBIDDEN_KEYS if not isinstance(k, bytes)]
        self.assertEqual(wildcards, [(b"\x00",)])
        for pattern in FORBIDDEN_KEYS:
            if isinstance(pattern, bytes):
                self.assertTrue(pattern, "黑名单不允许空字节序列")

    def test_every_exact_forbidden_pattern_maps_to_none(self):
        # 与“已知但禁用 → ACT_NONE”逐条对齐（Ctrl+M 因与 Enter 同字节未列入）
        for pattern in FORBIDDEN_KEYS:
            if isinstance(pattern, bytes):
                self.assertEqual(key_to_action(pattern), ACT_NONE)

    def test_no_overlap_between_registry_and_forbidden(self):
        registered = set()
        for entry in KEY_BINDINGS:
            registered.update(entry["keys"])
        for pattern in FORBIDDEN_KEYS:
            if isinstance(pattern, bytes):
                self.assertNotIn(pattern, registered,
                                 "注册键 %r 不应同时出现在黑名单" % pattern)


class RegistryTests(unittest.TestCase):
    """KEY_BINDINGS：结构完整、无重复键字节、恰好覆盖现有键位。"""

    def test_registry_has_no_duplicate_key_bytes(self):
        seen = set()
        for entry in KEY_BINDINGS:
            for kb in entry["keys"]:
                self.assertNotIn(kb, seen, "重复注册键字节: %r" % kb)
                seen.add(kb)

    def test_registry_has_required_fields(self):
        for entry in KEY_BINDINGS:
            for field in ("name", "action", "keys", "display", "help"):
                self.assertIn(field, entry, "注册表条目缺少字段 %s" % field)
            self.assertTrue(entry["keys"], "注册表条目 keys 不能为空: %s" % entry["name"])

    def test_registry_covers_existing_actions(self):
        actions = {entry["action"] for entry in KEY_BINDINGS}
        for action in (ACT_MOVE_UP, ACT_MOVE_DOWN, ACT_ENTER, ACT_BACK,
                       ACT_CHANGE_ROOT, ACT_QUIT):
            self.assertIn(action, actions, "注册表缺少动作 %s" % action)

    def test_future_keys_are_reserved_but_not_bound(self):
        # D4/D5 起 r/R 与 / 已注册为轻刷/深刷/路径跳转（对应 test_refresh/test_jump 用例）；
        # D8 起 S/H/h 已注册为保存快照/历史对比/帮助（大写 S 与下移 s 区分大小写）。
        # 本断言随 keyrouter 注册更新，不再视为“未绑定”。
        self.assertEqual(key_to_action(b"r"), keyrouter.ACT_REFRESH_LIGHT)
        self.assertEqual(key_to_action(b"R"), keyrouter.ACT_REFRESH_DEEP)
        self.assertEqual(key_to_action(b"/"), keyrouter.ACT_PATH_JUMP)
        self.assertEqual(key_to_action(b"S"), keyrouter.ACT_SAVE_SNAPSHOT)
        self.assertEqual(key_to_action(b"H"), keyrouter.ACT_HISTORY)
        self.assertEqual(key_to_action(b"h"), keyrouter.ACT_HELP)


class HelpTextTests(unittest.TestCase):
    """help_text：由注册表同源生成，非空、含主要键名与动作说明。"""

    def test_help_text_non_empty_with_prefix(self):
        text = help_text()
        self.assertTrue(text)
        self.assertIn("操作指引", text)

    def test_help_text_contains_main_key_names(self):
        text = help_text()
        for token in ("W", "S", "Enter", "Backspace", "C", "Q", "↑", "↓"):
            self.assertIn(token, text, "帮助文案缺少 %r" % token)

    def test_help_text_contains_main_action_labels(self):
        text = help_text()
        for token in ("进入目录", "返回上级", "切换扫描路径", "退出"):
            self.assertIn(token, text, "帮助文案缺少 %r" % token)

    def test_help_text_source_is_registry(self):
        # 每个注册条目的展示与说明都出现在生成文案中（同源防漂移）
        for entry in KEY_BINDINGS:
            self.assertIn(entry["display"], help_text())
            self.assertIn(entry["help"], help_text())


if __name__ == "__main__":
    unittest.main()