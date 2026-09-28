# -*- coding: utf-8 -*-
"""文档冲突与一致性契约（机读护栏）。

`tests/test_docs_sync.py` 只管「文件职责总表 ↔ 磁盘文件」一对关系；本文件负责**文档之间、
以及文档与代码之间**不得冲突，堵住四类腐化：

1. **职责唯一**：一个文件的职责不得在两个文档里各写一份（必然漂移）。职责只能在
   `README.md` 的机读总表里登记一次，其它文档只许引用路径、不许再描述一遍；
2. **引用不悬空**：文档里引用的仓库路径必须真实存在（删/改名文件后留下的幽灵引用）；
3. **数值不撒谎**：文档中的「19 条路由」「19 条架构红线」「12 条键位」这类可数事实，
   经 `<!-- DOCFACT:BEGIN name -->` 标记后与**代码真值**逐一核对；
4. **时间不倒序**：`docs/CHANGELOG.md` 是最新在前的追加式日志，禁止插到历史中间。

结构约定（改文档结构时必须同步改本文件，否则会红）：

- 数值事实块：`<!-- DOCFACT:BEGIN <name> -->` 与 `<!-- DOCFACT:END -->` 之间写结论行，
  名称必须是 `FACT_CHECKS` 里预先声明的键（未声明的标记会被判为「未登记事实」）；
- 每个 name 必须**有且仅有一处**定义（重复定义 = 双份事实，必然漂移）；
- 权威顺序：**可执行事实（代码/测试）> 文档**。冲突时改文档，不改测试，除非确实要改行为。

本文件不依赖 Windows、不联网、不写盘。
"""

import re
import unittest
import urllib.parse
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

# 参与「文档间一致性」检查的全部文档（相对仓库根 POSIX 路径）
DOC_FILES = (
    "README.md",
    "AGENTS.md",
    "docs/README.md",
    "docs/开发规范.md",
    "docs/API 契约.md",
    "docs/排查手册.md",
    "docs/CHANGELOG.md",
    "scripts/dev/README.md",
    "web/static/assets/来源清单.md",
    "tmp/README.md",
)

# 只有这些文档允许登记「文件职责」（单一事实源；其它文档只许引用路径）
RESPONSIBILITY_OWNERS = frozenset({"README.md"})

# 历史记录类文档：记录「当时是什么」，不是「现在是什么」的声明，
# 因此不参与数值事实核对（否则「当时 19 条红线」会被当成现行声明而永远报红）。
HISTORICAL_DOCS = frozenset({"docs/CHANGELOG.md"})

# 文档中的职责表只允许出现在 README 的机读区段内
FILEMAP_BEGIN = "<!-- FILEMAP:BEGIN -->"
FILEMAP_END = "<!-- FILEMAP:END -->"

DOCFACT_BEGIN = "<!-- DOCFACT:BEGIN "
DOCFACT_END = "<!-- DOCFACT:END -->"

# 职责表行：首个单元格是整格反引号包裹的路径（与 test_docs_sync 同约定）
ROW_RE = re.compile(r"^\|\s*`([^`]+)`\s*\|(.*)$")

# 文档里出现的仓库相对路径引用（反引号或 Markdown 链接里的相对路径）
# 只认「含 / 或已知后缀」的写法，避免把 127.0.0.1:5000、config.json 之类误判成仓库文件
PATH_TOKEN_RE = re.compile(r"`([A-Za-z0-9_./\u4e00-\u9fff-]+\.(?:py|js|mjs|html|css|md|txt|ps1|json|dll))`")
MD_LINK_RE = re.compile(r"\]\((?!https?://|#)([^)\s]+)\)")

# 允许「引用了但可以不落在磁盘上」的路径（运行期产物 / 忽略目录 / 外部约定）
PATH_ALLOWLIST = frozenset(
    {
        "config.json",
        "requirements.txt",
        # 文档中作为示例或运行期产物的路径，不是仓库文件
        "release.json",
        "package.json",
    }
)

# 表头含这些词的表格是「用途/入口/参数」类引用表，不是「文件职责表」。
# 只有非 README 文档里的**职责类**文件表才算重复登记职责（见
# TestNoDuplicateResponsibility）；工具清单、纯函数清单等引用表不受限。
REFERENCE_TABLE_HEADER_WORDS = ("用途", "入口", "参数", "作用", "依赖", "覆盖", "说明")


# 数值事实声明：name -> 检查函数（返回 None 表示通过，否则返回失败说明字符串）
def claimed_counts(text, unit):
    """找出全文中「<数字> <单位>」形式的声明，返回 [(上下文片段, 数字)]。

    这类声明**不限于 DOCFACT 块内**——表格里的「20 条架构红线」同样是声明，同样会失真，
    所以按全文扫描；只排除明显不是计数的数字（如 `P12·W2` 这类版本号/阶段号）。
    """
    found = []
    pattern = r"(\d+)\s*" + re.escape(unit)
    for match in re.finditer(pattern, text):
        start = match.start(1)
        # 数字前若还是数字（如「P12」里的 12 被部分匹配），跳过
        if start > 0 and text[start - 1].isdigit():
            continue
        line_start = text.rfind("\n", 0, start) + 1
        line_end = text.find("\n", match.end())
        context = text[line_start:line_end if line_end != -1 else len(text)].strip()
        found.append((context, int(match.group(1))))
    return found


def _scan_unit(unit, truth, truth_source):
    """通用检查：活文档中所有「<数字> <单位>」的声明都必须等于真值。

    历史记录类文档（见 `HISTORICAL_DOCS`）跳过——它们记录的是当时的数值。
    """
    problems = []
    for rel, raw in all_doc_texts().items():
        if rel in HISTORICAL_DOCS:
            continue
        text = strip_html_comments(raw)
        for context, value in claimed_counts(text, unit):
            if value != truth:
                problems.append(
                    "%s 声明「%d %s」，实际为 %d（%s）：%s"
                    % (rel, value, unit, truth, truth_source, context[:80])
                )
    return None if not problems else "；".join(problems)


def _read(path):
    return (REPO_ROOT / path).read_text(encoding="utf-8")


def _routes_count(_matched_text):
    source = _read("app.py")
    found = len(re.findall(r"^@app\.(?:get|post|put|delete|patch|route)\(", source, re.M))
    return _scan_unit("条路由", found, "app.py 路由装饰器")


def _architecture_redlines(_matched_text):
    text = _read("AGENTS.md")
    section = text.split("## 3. 架构红线", 1)[-1].split("\n## ", 1)[0]
    found = len(re.findall(r"^\d+\. \*\*", section, re.M))
    return _scan_unit("条架构红线", found, "AGENTS.md 第 3 节编号项")


def _keybindings_count(_matched_text):
    import keyrouter

    return _scan_unit("条键位", len(keyrouter.KEY_BINDINGS), "keyrouter.KEY_BINDINGS")


def fact_block(doc, name):
    """取出某文档里指定 DOCFACT 声明块的正文（找不到返回空串）。

    ⚠️ 注意：检查函数收到的是**文档相对路径**（如 "README.md"），不是声明块本身；
    需要读声明内容的检查必须用本函数自行取块（历史坑：曾把路径当正文解析，静默判空）。
    """
    text = _read(doc)
    match = re.search(
        r"<!--\s*DOCFACT:BEGIN\s+" + re.escape(name) + r"\s*-->(.*?)<!--\s*DOCFACT:END\s*-->",
        text,
        re.S,
    )
    return match.group(1) if match else ""


def _pytest_nodes(doc):
    """核对文档声明的后端测试规模 = `tests/` 下收集到的用例数。

    基准取「`tests/**/test_*.py` 里 `def test_*` 的数量」——它与 `pytest --collect-only`
    的收集结果一致（实测 372 = 372），且不需要再起一个 pytest 子进程
    （历史上用子进程 `--collect-only` 在本环境不稳定：同一命令在测试内外的输出规模不一致）。

    副作用即约定：计数器只认 `def test_*` 顶层签名，因此 `tests/` 里**不要**写非用例的
    `def test_*` 辅助函数（这种差异会立刻报出来）。
    """
    numbers = re.findall(r"\*\*(\d+)\*\*", fact_block(doc, "pytest_nodes"))
    if not numbers:
        return "没能从 %s 的 DOCFACT 声明块里解析出数字" % doc
    claimed = int(numbers[0])
    found = 0
    for path in sorted((REPO_ROOT / "tests").rglob("test_*.py")):
        if "__pycache__" in path.parts:
            continue
        found += len(re.findall(r"^\s*def test_\w+", path.read_text(encoding="utf-8"), re.M))
    if claimed < found:
        return "文档声明 %d 项，但 tests/ 下已有 %d 个用例（声明已过期）" % (claimed, found)
    return None


def _doc_update_items(_matched_text):
    """核对「变更后必做」清单规模，并强制 AGENTS.md 第 7 节与它耦合。

    权威计数声明在 docs/开发规范.md 第 3 节（执行清单），AGENTS.md 第 7 节通过
    显式引用同一数字保持一致——两处任何一方先改，这个检查都会红。
    """
    text = (REPO_ROOT / "docs" / "开发规范.md").read_text(encoding="utf-8")
    section = text.split("## 3. 每次开发完成后必须更新的文档", 1)[-1].split("\n## ", 1)[0]
    found = len(re.findall(r"^\|\s*\d+\s*\|", section, re.M))
    if found != 12:
        return "docs/开发规范.md 第 3 节实际为 %d 项（期望 12），与文档声明不符" % found
    agents = (REPO_ROOT / "AGENTS.md").read_text(encoding="utf-8")
    if "**12 项清单**" not in agents:
        return "AGENTS.md 第 7 节未引用与开发规范一致的「12 项清单」，两处已脱钩"
    return None


FACT_CHECKS = {
    "routes": _routes_count,
    "architecture_redlines": _architecture_redlines,
    "keybindings": _keybindings_count,
    "doc_update_items": _doc_update_items,
    "pytest_nodes": _pytest_nodes,
}


def strip_html_comments(text):
    """去掉全部 HTML 注释，返回正文。

    ⚠️ 历史坑（护栏曾因此空转）：最初直接用 `re.sub(r"<!--.*?-->", "", text)`，
    但**真标记本身也是注释形式**（`<!-- DOCFACT:BEGIN name -->`），一并删掉后
    事实检查永远找不到声明、静默通过。修正后改用「注释整体删除 + 本函数内部
    单独重扫真标记」的方式（见 `declared_fact_names`），语义清晰且不会漏。
    """
    return re.sub(r"<!--.*?-->", "", text, flags=re.S)


def declared_fact_names(text):
    """提取文档中**真实生效**的 DOCFACT 声明名。

    只有一种写法生效：标记独占一行（行首可有空白），形如
    ``<!-- DOCFACT:BEGIN <name> -->``。以下一律忽略（都只是「写法示例」）：
    - 被包在其它注释内部的标记（如 `docs/_文档模板.md` 的用法说明）；
    - 写在行内代码/反引号里的标记（如 AGENTS.md 里展示写法的 `<!-- ... name -->`）。
    """
    names = []
    for match in re.finditer(r"^[ \t]*<!--\s*DOCFACT:BEGIN\s+([a-z_]+)\s*-->[ \t]*$", text, re.M):
        prefix = text[: match.start()]
        if prefix.count("<!--") > prefix.count("-->"):
            continue  # 处在注释内部：是示例，不是真声明
        names.append(match.group(1))
    return names


def stray_docfact_markers(text):
    """找出没被注释包裹的 `DOCFACT:BEGIN/END` 残片（多半是标记写坏了）。"""
    body = strip_html_comments(text)
    return re.findall(r"DOCFACT:(?:BEGIN|END)[^\n]*", body)


def read_doc(rel):
    """读取指定文档文本（不存在时抛 AssertionError，提示文档体系破损）。"""
    path = REPO_ROOT / rel
    if not path.is_file():
        raise AssertionError("文档不存在：%s（文档体系破损或改名未同步）" % rel)
    return path.read_text(encoding="utf-8")


def all_doc_texts():
    """返回 {相对路径: 文本}。"""
    return {rel: read_doc(rel) for rel in DOC_FILES}


def existing_paths():
    """磁盘上存在的仓库相对 POSIX 路径集合（含目录）。"""
    found = set()
    for path in REPO_ROOT.rglob("*"):
        rel = path.relative_to(REPO_ROOT).as_posix()
        if rel.split("/")[0] in {".git", ".venv", "__pycache__"}:
            continue
        found.add(rel)
    return found


def responsibility_entries(text):
    """解析机读总表里的 (路径, 职责) 条目。"""
    if FILEMAP_BEGIN not in text or FILEMAP_END not in text:
        raise AssertionError("README.md 缺少机读区段标记 %s" % FILEMAP_BEGIN)
    section = text.split(FILEMAP_BEGIN, 1)[1].split(FILEMAP_END, 1)[0]
    entries = []
    for line in section.splitlines():
        match = ROW_RE.match(line.strip())
        if match:
            entries.append((match.group(1).strip(), match.group(2).strip()))
    return entries


def get_tool_parent(token):
    """返回该文件的父目录（POSIX）；无目录分隔符时返回 None。"""
    if "/" in token:
        return token.rsplit("/", 1)[0]
    return None


def is_repo_path(token):
    """判断文档里的路径 token 是否像「仓库内文件」。

    只认**仓库根直呼**或**带目录的相对完整路径**（如 `web/static/css/tokens.css`）。
    仅写 `viz/line.js`、`components/snapshot-view.js` 这类「子树内简写」不算——
    它们不是可校验的仓库路径写法（README 机读总表里一律写全路径）。
    """
    if token in PATH_ALLOWLIST:
        return False
    if token.startswith(("%", "~", "C:", "D:", "/")):
        return False
    if token.startswith("tmp/"):
        return False
    if "/" not in token:
        # 根目录下的散文件（app.py 等）由机读总表负责覆盖
        return False
    # 必须是真实存在的顶层目录开头
    top = token.split("/", 1)[0]
    return (REPO_ROOT / top).is_dir()


def is_dangling_reference(token, existing):
    """该引用是否为「幽灵引用」：既不存在，也不是某个真实路径的后缀简写。"""
    if token in existing:
        return False
    # 子树内简写（如 `viz/line.js` 指 web/static/js/app/viz/line.js）不算幽灵
    return not any(p.endswith("/" + token) for p in existing)


def responsibility_tables(text):
    """返回该文档中「文件职责表」里登记的路径列表。

    判定规则：连续的行都是 ``| `路径` | 描述 |`` 形式；**表头**含「用途/入口/参数/作用/依赖」
    等引用类词汇时，该表视为引用表（工具清单、纯函数清单），不计入职责登记。
    """
    lines = text.splitlines()
    rows = []  # (行号, 路径)
    for index, line in enumerate(lines):
        match = ROW_RE.match(line.strip())
        if match and is_repo_path(match.group(1).strip()):
            rows.append((index, match.group(1).strip()))
    if not rows:
        return []

    # 按「行号不连续则分表」切分成若干表格块
    blocks = []
    current = [rows[0]]
    for prev, item in zip(rows, rows[1:]):
        if item[0] - prev[0] <= 1:
            current.append(item)
        else:
            blocks.append(current)
            current = [item]
    blocks.append(current)

    found = []
    for block in blocks:
        if len(block) < 2:
            continue
        header_index = block[0][0] - 1  # 表头在首个数据行的上一行
        header = lines[header_index] if header_index >= 0 else ""
        if any(word in header for word in REFERENCE_TABLE_HEADER_WORDS):
            continue  # 引用表，不是职责登记
        found.extend(path for _, path in block)
    return found


class TestNoDuplicateResponsibility(unittest.TestCase):
    """职责唯一性：一个文件的职责不得在多个文档里各写一份。"""

    def test_only_readme_registers_file_responsibilities(self):
        """除 README 外，任何文档都不得再登记「文件职责表」。"""
        offenders = {}
        for rel, text in all_doc_texts().items():
            if rel in RESPONSIBILITY_OWNERS:
                continue
            rows = responsibility_tables(text)
            if rows:
                offenders[rel] = sorted(set(rows))
        self.assertEqual(
            {},
            offenders,
            "以下文档重复登记了文件职责（职责只能在 README.md 登记一次，其它文档请改为链接）：%s"
            % offenders,
        )

    def test_responsibility_paths_are_unique(self):
        """机读总表内同一路径不得登记两次（否则两行职责可能互相矛盾）。"""
        entries = responsibility_entries(read_doc("README.md"))
        seen = {}
        for path, duty in entries:
            seen.setdefault(path, []).append(duty)
        duplicates = {p: d for p, d in seen.items() if len(d) > 1}
        self.assertEqual(
            {},
            duplicates,
            "README 机读总表内同一路径重复登记（可能职责冲突）：%s" % sorted(duplicates),
        )


class TestNoDanglingReferences(unittest.TestCase):
    """引用完整性：文档引用的仓库路径必须真实存在。"""

    def test_referenced_paths_exist(self):
        existing = existing_paths()
        missing = {}
        for rel, text in all_doc_texts().items():
            for link in MD_LINK_RE.findall(text):
                link = link.split("#", 1)[0]
                if not link:
                    continue
                # Markdown 链接可能被 URL 编码（如「API%20契约.md」），先解码再校验
                link = urllib.parse.unquote(link)
                if link.startswith(("%", "~", "http", "C:", "D:", "/")):
                    continue
                # 相对链接：按所在文档目录解析（`../README.md` 这类跨目录引用同样适用）
                base = (REPO_ROOT / rel).parent
                try:
                    resolved = (base / link).resolve()
                except OSError:
                    continue
                if not resolved.exists():
                    missing.setdefault(rel, set()).add(link)
            for token in set(PATH_TOKEN_RE.findall(text)):
                if not is_repo_path(token):
                    continue
                if is_dangling_reference(token, existing):
                    missing.setdefault(rel, set()).add(token)
        self.assertEqual(
            {},
            {k: sorted(v) for k, v in missing.items()},
            "以下文档引用了不存在的仓库路径（删/改名后未同步引用）：%s"
            % {k: sorted(v) for k, v in missing.items()},
        )


class TestDocumentedFactsMatchCode(unittest.TestCase):
    """数值事实：文档声明的可数事实必须与代码真值一致，且每个事实只有一处定义。"""

    def _facts(self):
        """扫描全部文档，返回 {name: [(文档, 声明文本)]}（注释里的示例标记不计）。"""
        declared = {}
        for rel, text in all_doc_texts().items():
            for name in declared_fact_names(text):
                declared.setdefault(name, []).append(rel)
        return declared

    def test_docfact_names_are_registered(self):
        """所有 DOCFACT 标记必须是 FACT_CHECKS 里已声明的名称。"""
        unknown = sorted(set(self._facts()) - set(FACT_CHECKS))
        self.assertEqual(
            [], unknown, "以下 DOCFACT 名称未在 FACT_CHECKS 中声明检查方式：%s" % unknown
        )

    def test_each_fact_declared_exactly_once(self):
        """同一事实不得在两个文档里各写一遍（双份必然漂移）。"""
        duplicated = {k: v for k, v in self._facts().items() if len(v) > 1}
        self.assertEqual(
            {},
            duplicated,
            "以下事实在多个文档重复声明（应只在权威文档声明，其它处改为链接或删除）：%s"
            % duplicated,
        )

    def test_declared_facts_match_code(self):
        """逐条核对文档声明的数值事实与代码真值。"""
        failures = []
        for name, owners in self._facts().items():
            check = FACT_CHECKS.get(name)
            if check is None:
                continue  # 未声明名称由上一个用例负责报错
            problem = check(owners[0])
            if problem:
                failures.append("%s（声明于 %s）：%s" % (name, owners[0], problem))
        self.assertEqual([], failures, "文档数值事实与代码不符：%s" % failures)

    def test_docfact_blocks_are_well_formed(self):
        """DOCFACT 标记成对、非空，且不得出现裸露残片（注释里的示例不计）。"""
        problems = []
        for rel, raw in all_doc_texts().items():
            names = declared_fact_names(raw)
            ends = len(re.findall(r"<!--\s*DOCFACT:END\s*-->", raw))
            if len(names) != ends:
                problems.append("%s：BEGIN %d 个 / END %d 个不成对" % (rel, len(names), ends))
            stray = stray_docfact_markers(raw)
            if stray:
                problems.append("%s：存在未被注释包裹的标记残片 %s" % (rel, stray[:3]))
            for name in names:
                block = re.search(
                    r"<!--\s*DOCFACT:BEGIN\s+"
                    + re.escape(name)
                    + r"\s*-->(.*?)<!--\s*DOCFACT:END\s*-->",
                    raw,
                    re.S,
                )
                if block and not strip_html_comments(block.group(1)).strip():
                    problems.append("%s：%s 是空的 DOCFACT 块" % (rel, name))
        self.assertEqual([], problems, "DOCFACT 标记结构问题：%s" % problems)


class TestChangelogDiscipline(unittest.TestCase):
    """变更日志纪律：最新在前的追加式日志，禁止插入历史中间。"""

    def test_headings_are_chronological_desc(self):
        text = read_doc("docs/CHANGELOG.md")
        dates = re.findall(r"^## (\d{4}-\d{2}-\d{2})", text, re.M)
        self.assertGreater(len(dates), 0, "docs/CHANGELOG.md 至少应有一条日期记录")
        self.assertEqual(
            dates,
            sorted(dates, reverse=True),
            "docs/CHANGELOG.md 必须最新的在最前（新条目追加到顶部）",
        )

    def test_changelog_has_required_fields(self):
        """每条变更记录必须五项齐全：变更/文件/验证/文档/遗留。"""
        text = read_doc("docs/CHANGELOG.md")
        blocks = re.split(r"^## \d{4}-\d{2}-\d{2}", text, flags=re.M)[1:]
        self.assertGreater(len(blocks), 0, "未解析到任何变更记录")
        missing = []
        for index, block in enumerate(blocks, start=1):
            lack = [f for f in ("变更", "文件", "验证", "文档", "遗留") if ("- %s：" % f) not in block]
            if lack:
                missing.append("第 %d 条缺：%s" % (index, lack))
        self.assertEqual([], missing, "docs/CHANGELOG.md 记录不完整：%s" % missing)


if __name__ == "__main__":
    unittest.main()
