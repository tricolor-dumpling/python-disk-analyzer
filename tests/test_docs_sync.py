# -*- coding: utf-8 -*-
"""文档同步契约（2026-09-28 新增）。

`README.md` 的「文件职责总表」是本仓库**唯一的文件级事实源**。本用例以磁盘实际文件为
准做双向校验，堵住两个常见的文档腐化口子：

- 新增文件后忘记登记 → 总表缺条目（test_filemap_covers_every_file）；
- 删除/改名文件后留下僵尸条目 → 总表多条目（test_filemap_has_no_stale_entries）。

约定（改 README 结构时必须同步改本文件，否则测试会红）：

- 总表内容夹在 `<!-- FILEMAP:BEGIN -->` 与 `<!-- FILEMAP:END -->` 之间；
- 每行形如 ``| `相对/正斜杠/路径` | 职责 |``，路径为仓库相对 POSIX 路径；
- 被 `.gitignore` 排除的运行期产物不登记（见下方 IGNORED_* 清单）。

这些用例不依赖 Windows、不写盘、不联网。
"""

import re
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

# 文件职责总表所在文档（机读契约的事实源；2026-09-28 由根 README 拆出）
FILEMAP_DOC = REPO_ROOT / "docs" / "代码地图.md"
README = REPO_ROOT / "README.md"
AGENTS = REPO_ROOT / "AGENTS.md"

FILEMAP_BEGIN = "<!-- FILEMAP:BEGIN -->"
FILEMAP_END = "<!-- FILEMAP:END -->"

# 必须存在的文档（缺任何一个都视为文档体系破损）
REQUIRED_DOCS = (
    "README.md",
    "AGENTS.md",
    "docs/代码地图.md",
    "scripts/dev/README.md",
    "web/static/assets/来源清单.md",
)

# 与 .gitignore 对齐：这些路径不入库、也不需要登记职责
IGNORED_DIRS = frozenset(
    {
        ".git",
        ".venv",
        "__pycache__",
        ".pytest_cache",
        ".vscode",
        ".idea",
        "dsh-image-gen",
        "build",
        "dist",
        "releases",
        "packaging",
    }
)
IGNORED_NAMES = frozenset({"config.json", "Thumbs.db", "Desktop.ini"})
IGNORED_SUFFIXES = (".pyc", ".pyo", ".spec")

# 总表行：首个单元格必须是整格反引号包裹的路径
ROW_RE = re.compile(r"^\|\s*`([^`]+)`\s*\|")

# 根 README 必须保留的章节（项目入口的骨架：说明 + 快速开始 + 导航 + 验证）
README_REQUIRED_HEADINGS = (
    "## 快速开始",
    "## 开发文档导航",
    "## 测试与验证",
    "## 版本与分支（要点）",
)

AGENTS_REQUIRED_HEADINGS = (
    "## 3. 架构红线",
    "## 7. 变更后必做",
)


def _is_ignored(rel_posix):
    """判断仓库相对 POSIX 路径是否属于「不入库/不登记」范畴。"""
    parts = rel_posix.split("/")
    if any(part in IGNORED_DIRS for part in parts):
        return True
    if parts[-1] in IGNORED_NAMES:
        return True
    return rel_posix.endswith(IGNORED_SUFFIXES)


def disk_files():
    """返回磁盘上应当登记职责的全部文件（仓库相对 POSIX 路径，已排序）。"""
    found = []
    for path in REPO_ROOT.rglob("*"):
        if not path.is_file():
            continue
        rel = path.relative_to(REPO_ROOT).as_posix()
        if _is_ignored(rel):
            continue
        found.append(rel)
    return sorted(found)


def documented_files():
    """从文件职责总表所在文档（`docs/代码地图.md`）的机读区段解析出全部登记路径。"""
    text = FILEMAP_DOC.read_text(encoding="utf-8")
    if FILEMAP_BEGIN not in text or FILEMAP_END not in text:
        raise AssertionError(
            "docs/代码地图.md 缺少文件总表标记 %s / %s" % (FILEMAP_BEGIN, FILEMAP_END)
        )
    section = text.split(FILEMAP_BEGIN, 1)[1].split(FILEMAP_END, 1)[0]
    paths = set()
    for line in section.splitlines():
        match = ROW_RE.match(line.strip())
        if match:
            paths.add(match.group(1).strip())
    return sorted(paths)


class TestDocsExist(unittest.TestCase):
    """文档体系的必备文件与骨架章节。"""

    def test_required_docs_exist(self):
        missing = [name for name in REQUIRED_DOCS if not (REPO_ROOT / name).is_file()]
        self.assertEqual([], missing, "缺少必备文档：%s" % missing)

    def test_readme_has_required_headings(self):
        text = README.read_text(encoding="utf-8")
        missing = [h for h in README_REQUIRED_HEADINGS if h not in text]
        self.assertEqual([], missing, "README.md 缺少章节：%s" % missing)

    def test_filemap_doc_has_required_headings(self):
        """文件总表所在文档的骨架：职责总表 + 接口与命令（防止总表被挪走后又挪丢）。"""
        text = FILEMAP_DOC.read_text(encoding="utf-8")
        missing = [
            h
            for h in ("## 1. 文件职责总表", "## 2. 接口与命令")
            if h not in text
        ]
        self.assertEqual([], missing, "docs/代码地图.md 缺少章节：%s" % missing)

    def test_agents_has_required_headings(self):
        text = AGENTS.read_text(encoding="utf-8")
        missing = [h for h in AGENTS_REQUIRED_HEADINGS if h not in text]
        self.assertEqual([], missing, "AGENTS.md 缺少章节：%s" % missing)


class TestFileMapSync(unittest.TestCase):
    """文件职责总表与磁盘实际文件的双向一致性。"""

    def test_filemap_covers_every_file(self):
        """磁盘上每个文件都必须在总表里登记职责。"""
        missing = sorted(set(disk_files()) - set(documented_files()))
        self.assertEqual(
            [],
            missing,
            "以下文件未登记进 README 的「文件职责总表」：%s" % missing,
        )

    def test_filemap_has_no_stale_entries(self):
        """总表里不得残留已删除/改名的僵尸条目。"""
        stale = sorted(set(documented_files()) - set(disk_files()))
        self.assertEqual(
            [],
            stale,
            "以下条目在磁盘上不存在（多半是删文件后忘了同步总表）：%s" % stale,
        )

    def test_filemap_paths_are_posix_relative(self):
        """路径写法必须是仓库相对 POSIX 路径，避免 Windows 反斜杠混入。"""
        bad = [
            p
            for p in documented_files()
            if "\\" in p or p.startswith("/") or p.startswith("./") or ".." in p.split("/")
        ]
        self.assertEqual([], bad, "总表路径写法不合规：%s" % bad)


if __name__ == "__main__":
    unittest.main()
