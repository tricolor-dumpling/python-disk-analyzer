"""messages 模块单元测试（P12·W1.3 新增，小）。

覆盖 Everything 错误码表完整性（0-7 全覆盖、文案非空）与
render_everything_error 的已知码/未知码渲染。
"""

import unittest

from messages import EVERYTHING_ERROR_TEXT, render_everything_error


class EverythingErrorTextTests(unittest.TestCase):
    """EVERYTHING_ERROR_TEXT 码表与渲染函数。"""

    def test_error_text_covers_0_7(self):
        """码表必须覆盖 0-7 全部错误码且文案非空。"""
        self.assertTrue(set(range(8)) <= set(EVERYTHING_ERROR_TEXT))
        for code, (kind, text) in EVERYTHING_ERROR_TEXT.items():
            self.assertTrue(kind, f"code={code} 类别标识为空")
            self.assertTrue(text.strip(), f"code={code} 文案为空")

    def test_render_known_codes(self):
        """已知码渲染为码表文案（code=2 为 IPC 文案锚点）。"""
        self.assertEqual(render_everything_error(2), "无法连接 Everything（未运行或权限不足）")
        self.assertEqual(render_everything_error(0), "查询成功")

    def test_render_unknown_code_no_bare_number_leak(self):
        """未知码不出裸码：回退文案带中文说明并附错误码。"""
        text = render_everything_error(99)
        self.assertIn("Everything", text)
        self.assertIn("99", text)


if __name__ == "__main__":
    unittest.main()
