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

## 2026-09-28 · 补写部署与运维（文档欠账清零，第六轮）

- 变更：把最后 2 项欠账（「部署与多实例运维说明」+「发布产物校验清单」）**合并成一篇**成文——
  两者同属「跑起来 / 交出去」的运维面，拆两篇会立刻产生重复内容。
  - 新增 `docs/部署与运维.md`：三种形态启动参数（Web 的 `--no-browser`/`--verbose`/`--debug-log`）、
    端口与绑定（仅 `127.0.0.1`、默认 5000 且**无命令行开关可改**）、防双实例探测口径
    （`/api/health` 1 秒超时、返回 200 即视为已有本工具实例 → 打印提示后**直接退出不 bind**）、
    两种端口占用情形的不同行为、停服协作取消（`atexit` → `cancel_scan(join_timeout=5)`，超时放弃、不硬杀）、
    作业沙箱差异、数据目录与隔离根、常用运维命令，以及**可勾选的发版交付校验清单**
    （发版前 / 打包结构 / 发版后外部校验 / 收尾）。
  - 成文过程中**实测发现一处行为差异并如实登记**：作业对象沙盒（`KILL_ON_JOB_CLOSE`）只在 CLI/TUI 的
    启动路径调用 `init_windows_job_sandbox()`，**Web 形态（`python app.py`）未调用**（grep 调用点：0 次）——
    因此 Web 退出后，本次自动拉起的 Everything 会继续运行。属已知行为而非故障，已在文档写明运维口径；
    若需统一，应在 `app.py` 启动路径补调用（属行为变更，须同步 `tests/test_shutdown.py`）。
- 文件：新增 `docs/部署与运维.md`；修改 `docs/README.md`（索引 + 欠账表改为「当前无未还欠账」）、
  `README.md`（文件总表 +1）、`tests/test_docs_consistency.py`（`DOC_FILES` 纳入）。
- 验证：`.venv\Scripts\python.exe -m pytest tests -q` 全绿（**371** 项，本轮只增文档未加用例）；
  两套文档契约 15 项全绿；文档引用的函数/常量/行为逐条读码核实（`_another_instance_running`、
  `_shutdown_fullscan`、`fullscan.cancel_scan` 的 `join_timeout=5`、`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`、
  `init_windows_job_sandbox` 的调用点计数）。
- 文档：`docs/README.md` 第 4 节现为「当前无未还欠账」，保留 4 项已还清记录与欠账判断门槛
  （「不写会不会让人做错事」）。
- 遗留：无未还欠账；后续发现新缺口按 `docs/README.md` 第 4 节格式登记即可。

## 2026-09-28 · 补写架构决策记录 ADR（第五轮）

- 变更：还清「ADR」这项欠账——「为什么这么设计」此前只散落在源码的阶段标记注释里
  （`P12·W1.1`、`阶段B（B-7）` 等），新人只看到「这样做」、看不到「为什么不能那样做」，
  容易在「优化」时把必要约束拆掉。
  - 新增 `docs/架构决策记录.md`：**9 条按主题**（非按时间）记录的决策，每条写
    「决策 / 理由 / **代价** / 易错点 / 索引位置」——① 用 Everything SDK 换来全局串行化；
    ② 全局扫描锁是正确性要求而非性能优化；③ 协作取消、绝不硬杀线程；④ 快照原子写 + 独占锁 +
    陈旧锁判定；⑤ 自动保存用四原子谓词而非定时器；⑥ 依赖无环 + 可变全局走模块属性 + `main.py` 兼容层；
    ⑦ 前端零构建（含「改模板要重启、改静态不用」这一不对称踩坑点）；⑧ UI 偏好与后端配置分家；
    ⑨ 展示层过滤不改变后端契约（后端清单是审计轨迹）。
  - **只记有代价的决策**：显然的做法与纯实现细节不写，避免 ADR 退化成代码复述。
  - 与红线分工明确：ADR 讲「为什么」，`AGENTS.md` 第 3 节讲「不许违反」，两者只互相引用。
- 文件：新增 `docs/架构决策记录.md`；修改 `docs/README.md`（索引 + 欠账移入「已还清」）、
  `README.md`（文件总表 +1）、`AGENTS.md`（第 1 节加「想知为什么 → 查 ADR」入口、第 6 节文档体系补全）、
  `tests/test_docs_consistency.py`（`DOC_FILES` 纳入，使其同样受冲突检查约束）。
- 验证：`.venv\Scripts\python.exe -m pytest tests -q` 全绿（**371** 项，本轮只增文档未加用例）；
  两套文档契约 15 项全绿。ADR 引用的**全部标识符逐一实测存在**：`fullscan.GLOBAL_SCAN_LOCK is scan.SCAN_LOCK`、
  `STALE_LOCK_TTL_SECONDS==600`、`SnapshotBusyError`、`should_auto_save`、`sdk.is_everything_ready`、
  `app.ALLOWED_SETTING_KEYS`、`app._static_no_cache`、`main._LIVE_FORWARD`、`splitSessions`、
  `PREF_REGISTRY` / `pds_prefs_v1`。
- 文档：`docs/README.md` 欠账表仅余 2 项（部署与多实例运维说明、发布产物校验清单）。
- 遗留：余下 2 项价值中等（运维/发版面向），按「不写会不会让人做错事」衡量可暂缓；
  建议下次发版前顺手补「发布产物校验清单」，把 `AGENTS.md` 第 8 节的步骤拆成可勾选清单。

## 2026-09-28 · 补写 legacy 快照迁移指引（第四轮）

- 变更：还清上一轮登记的最高风险文档欠账——**历史快照中 ≥16 TiB「已知异常大小」数据**的处置指引。
  此前用户看到合计偏大时无成文依据，只能翻源码注释。
  - 新增 `docs/legacy 快照迁移指引.md`：成因（Everything 对「大小未知」返回哨兵 `2^64-1`，
    历史实现裸读并当成真实字节数写进快照）、**三种计数口径的区别**（扫描过程的 `unknown_size_count`
    / 单份快照的 `legacy_unknown_rows` / 对比报告的 `legacy_count`）、两分钟自查表（含 Web 对比页
    warn 横幅与 TUI 提示的实际文案）、要不要处理的判断口径、重建基线步骤（含 `--baseline` /
    `--snapshot-dir` / `DSA_SNAPSHOT_DIR` / `DSA_NO_SNAPSHOT`）、**5 条常见误区**
    （如「调大阈值就不会提示」= 提示消失 ≠ 数据变准）。
  - 按 `docs/_文档模板.md` 四要素撰写（职责 / 权威来源 / 更新触发 / 唯一性声明），并声明
    「阈值与字段名以代码与测试为准」，避免与 `docs/API 契约.md` 的字段描述各写一份。
- 文件：新增 `docs/legacy 快照迁移指引.md`；修改 `docs/README.md`（索引 + 欠账移入「已还清」）、
  `README.md`（文件总表 +1）、`docs/排查手册.md`（§3.2 指向完整流程）、
  `tests/test_docs_consistency.py`（`DOC_FILES` 纳入新文档，使其同样受冲突检查约束）。
- 验证：`.venv\Scripts\python.exe -m pytest tests -q` 全绿（**371** 项，本轮只增文档未加用例）；
  两套文档契约 15 项全绿，新文档的路径引用与数值经全文扫描核对。
- 文档：`docs/README.md` 欠账表已更新；余下 3 项（ADR / 部署运维 / 发布校验清单）继续登记。
- 遗留：ADR 仍是最大缺口——「为什么这么设计」散落在源码注释的阶段标记里（`P12·W1.x` 等），
  建议后续**按主题分批**补（扫描锁单例 / 协作取消 / 日志压缩 / 原子写），而不是一次写一本通史。

## 2026-09-28 · 文档三大约束落地为可执行护栏（第三轮）

- 变更：把「按需自动生成文档 / 每次开发后更新文档 / 文档之间不可冲突」从**规范**升级为**机器执法**。
  - **新增 `tests/test_docs_consistency.py`（9 项）**：职责唯一（非 README 文档出现文件职责表即红）、
    引用不悬空（幽灵路径）、数值事实不撒谎（与代码真值核对）、CHANGELOG 时间不倒序且五项字段齐全。
  - **新增 `DOCFACT` 机制**：可数事实（路由数 / 架构红线数 / 键位数 / 清单项数 / 测试规模）用
    `<!-- DOCFACT:BEGIN name -->` 标记，由测试按代码真值核对；每个事实**全仓库只能声明一次**。
  - **全文数值扫描**：不只盯 `DOCFACT` 块——表格里的「20 条架构红线」等声明同样纳入核对，
    避免「块内对、块外错」。历史记录类文档（`docs/CHANGELOG.md`）豁免，因其记录的是当时的数值。
  - **新增 `docs/_文档模板.md`**：新增文档的强制骨架（职责 / 权威来源 / 更新触发 / 唯一性声明）；
    `docs/README.md` 新增「3.5 文档按需自动生成（不必先问）」与「3.6 文档冲突判定（不许冲突）」，
    给出**权威优先级**：可执行事实（代码/测试）> `README.md`（内容类）> `AGENTS.md`（约束类）> `docs/*`（参考）。
  - `AGENTS.md` 新增第 20 条红线，把上述约束写成 agent 纪律。
- 文件：新增 `tests/test_docs_consistency.py`、`docs/_文档模板.md`；修改 `README.md`（总表 +2 条、3 处 `DOCFACT`）、
  `AGENTS.md`（第 20 条红线 + 章内 `DOCFACT`）、`docs/README.md`（索引 + 两节新规则）、
  `docs/开发规范.md`（第 3 节 `DOCFACT`）。
- 验证：`.venv\Scripts\python.exe -m pytest tests -q` 全绿（**371** 项，含两套文档契约 15 项）；
  并以「故意植入冲突」实测护栏有效性：临时文档写错「17 条架构红线 / 23 条路由」并引用不存在的路径，
  测试恰好拦下这两类、且**只拦这两类**（无误报），删除探针后复绿。
- 文档：三道约束的判定规则落在 `docs/README.md` 第 3.5/3.6 节；`AGENTS.md` 第 3 节第 20 条只做引用，避免双份。
- 遗留：`FACT_CHECKS` 现覆盖 5 个可数事实，新出现的可数事实须自行注册检查函数，否则
  `test_docfact_names_are_registered` 会红（有意设计，防止「标了却没人管」）。
  本轮修掉两个曾让护栏**空转**的自身缺陷——`strip_html_comments` 曾把 `DOCFACT` 标记一并删除、
  检查函数曾把「文档路径」当成「声明正文」解析；两处均已加注释固化经验。

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
