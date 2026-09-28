# 变更日志（CHANGELOG）

本文件按**时间倒序**记录每次开发迭代的产出，配合 `README.md`「文档维护规范」使用：
每次开发完成后，除了更新 `README.md` 的文件总表与 `AGENTS.md` 的红线，**还要在下面追加一条记录**。

记录格式（一条一段，保持简短、可追溯）：

```
## YYYY-MM-DD · <分支名或主题>
- 变更：做了什么（面向使用者/开发者可感知的结果）
- 文件：新增/删除/改名的文件（同步 README 文件总表）
- 验证：跑了什么命令、结果如何
- 文档：同步更新了哪些文档
- 遗留：未完成项 / 已知限制（没有就写「无」）
```

---

## 2026-09-28 · 文档管理机制与 tmp 临时区补齐（第二轮）

- 变更：补上第一轮只立「规范」却没建「机制」的缺口。
  - `docs/README.md`：**文档唯一索引 + 管理规范** —— 9 份文档各管什么/何时更新/权威性；
    文档分级（长期 / 过程 / 记录 / 禁止入库）；更新与淘汰规则（禁止双份、过期即删、不留「已废弃」段落）；
    并**诚实登记 4 项文档欠账**（架构决策记录、legacy 快照迁移指引、部署与多实例运维、发布校验清单）。
  - `docs/API 契约.md`：三条契约红线（additive 只增不改 / 错误一律 JSON / 写入白名单）、三种错误体形态、
    Everything 错误码表（真实 0–7 码 + 未知码回退）、HTTP 状态约定、冻结键集合速查。
    **明确声明权威在 `tests/test_api_contract.py`**，文档只是人读摘要。
  - `docs/排查手册.md`：14 条真实症状 → 原因 → 处置（Everything IPC / Session 0 / DLL 架构、
    会话被判空隐藏、legacy 16TiB 行、陈旧锁、折线塌缩、模板缓存、冒烟重复 open、node 沙盒假红、
    pytest DACL 垫片、pwsh 工作区写权限），附 7 条拿来即用的诊断命令。
  - **`tmp/` 临时工作区**：新增 `tmp/README.md` 与 `.gitignore` 规则（`tmp/*` 忽略、`!tmp/README.md`），
    让开发临时产物有固定落点、可 `Remove-Item -Recurse -Force tmp\*` 一键清理；
    同时划清与 `scripts/dev/`（可复用工具）、`%TEMP%`（测试夹具）、真实数据目录（禁入库）的边界。
- 文件：新增 `docs/README.md`、`docs/API 契约.md`、`docs/排查手册.md`、`tmp/README.md`；
  修改 `README.md`（文件总表 +4 条、去 1 条重复的 `AGENTS.md` 登记、新增「临时工作区」小节）、
  `AGENTS.md`（第 6 节产物落点与文档体系、第 7 节新增第 9 项）、`.gitignore`。
- 验证：`.venv\Scripts\python.exe -m pytest tests -q` 全绿；文件总表与磁盘双向比对一致
  （新增文件全部登记，无僵尸条目）。
- 文档：`docs/README.md` 索引已同步为最新 9 份文档。
- 遗留：§4 登记的 4 项文档欠账（ADR、legacy 迁移指引、部署运维说明、发布校验清单）按需再写，
  刻意不先写——写文档的成本要用「不写会不会让人做错事」衡量。

## 2026-09-28 · docs/项目文档体系重建（基线）

- 变更：重建被清空的文档体系，把「文件职责」「分支作用」「开发后更新文档」固化为可执行规则。
  - `README.md`：项目唯一入口 —— 代码地图（逐文件职责总表，机读区段）、19 条路由的 API 概览、
    命令行与 TUI 键位、Git 分支规范、文档维护规范、测试与验证、界面契约、使用偏好。
  - `AGENTS.md`：AI agent 工作约束 —— 环境红线、19 条架构红线、编码约定、分支与提交、变更后必做、发版流程。
  - `scripts/dev/README.md`：开发工具清单（10 个可复用工具）与使用纪律。
  - `web/static/assets/来源清单.md`：界面素材来源与授权登记规则（当前无第三方素材）。
  - `docs/开发规范.md`、`docs/CHANGELOG.md`（本文件）：分支作业流程与变更记录落点。
- 文件：新增 `README.md`、`AGENTS.md`、`scripts/dev/README.md`、`web/static/assets/来源清单.md`、
  `docs/开发规范.md`、`docs/CHANGELOG.md`；删除一次性核查脚本（不留档）。
- 验证：`.venv\Scripts\python.exe -m pytest tests -q` 全绿（含 `tests/test_docs_sync.py` 6 项文档同步契约）。
- 文档：以上全部。
- 遗留：本地 `main` 与 `origin/main` 因历史压缩而分叉（远端保留压缩前历史，本地不参考远端文件）；
  如需推送须显式选择 `push --force` 或另建分支，属预期状态。

## 历史阶段（文档已清除，仅存代码痕迹）

以下阶段名保留在源码注释与测试文件名中，供检索历史上下文；**详细方案文档已不在仓库**，
需要考古时以 `git log`、源码注释与 `tests/test_stage_*.py` 为准：

| 阶段 | 可见痕迹 |
|---|---|
| P0–P6 | `scripts/dev/` 工具链、`tests/` 目录成型 |
| P12（W1–W3） | 缺陷修复与契约冻结轮次，注释标记 `P12·W1.x`/`W2.x`/`W3.x` |
| 阶段 B / C / D / F / G / P1 | 对应 `tests/test_stage_b.py` 等后端契约测试 |
| R1 | 视觉版本 `v2.1.1 · R1 视觉版`（`web/templates/index.html` 状态栏） |
