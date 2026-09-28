# Python 磁盘分析工具（SpaceLens Pro）

基于 Everything SDK 的 Windows 本地磁盘空间分析工具，三种形态共用同一套后端模块：

- **Web UI（主形态）**：Flask 本地单页应用（UI 2.0「SpaceLens Pro」）——`python app.py` 启动，只绑定 `127.0.0.1`，默认自动打开浏览器。
- **TUI**：终端交互界面（msvcrt 按键 + ANSI/VT 渲染）——`python main.py`。
- **CLI**：非交互 Top-N 报告与 CSV/JSON 导出——`python main.py <TARGET> ...`。

核心能力：毫秒级全盘扫描、目录占用浏览（矩形图/排行/表格/关系四视图）、快照保存与撤销、
快照间与「快照 vs 当前」对比（增量 Top-N、深度折叠、多快照趋势折线）、一键清空数据目录。

> **本文档是项目入口**：只放「项目说明 + 快速开始 + 开发导航」。
> 详细内容已按主题拆到 `docs/`，见下方导航表——**别把新内容继续堆进本文件**。
> 其中**文件职责总表**在 [`docs/代码地图.md`](docs/代码地图.md)，改动任何文件都必须同步它，否则 `pytest` 会红。

---

## 快速开始

```powershell
pip install -r requirements.txt
python app.py                              # Web UI（推荐）
python main.py                             # TUI 交互模式
python main.py C:\ -top 20 --quiet         # 非交互 Top-N 报告
python main.py C:\ --export csv            # 导出全部目录聚合占用到 exports\
python main.py C:\ --baseline <快照文件>    # 与基线快照对比后打印变化报告
```

## 运行环境与依赖

- **Windows**：依赖本机 Everything 与仓库内 `everything-SDK/dll/*.dll`（不经 pip 安装）。
- **Python 3.9+**：CLI/TUI 仅标准库；Web 形态需要 `flask>=3.0.2`（见 `requirements.txt`）。
- **环境变量**：`DSA_SNAPSHOT_DIR`（覆盖快照目录）、`DSA_NO_SNAPSHOT`（禁用一切快照落盘）。
- **数据目录**：`%LOCALAPPDATA%\PythonDiskScanner\`（`snapshots/`、`exports/`、`config.json`、session 清单）。

---

## 开发文档导航

| 想知道什么 | 看哪里 |
|---|---|
| **哪个文件干什么**、有哪些 API 与命令 | [`docs/代码地图.md`](docs/代码地图.md)（**文件职责事实源**，改文件必同步） |
| API 响应形状、错误码、HTTP 状态约定 | [`docs/API 契约.md`](docs/API%20契约.md)（**权威在 `tests/test_api_contract.py`**） |
| **分支怎么用**、一次开发怎么走、提交格式 | [`docs/开发规范.md`](docs/开发规范.md) |
| **为什么这么设计**（动手优化前先读） | [`docs/架构决策记录.md`](docs/架构决策记录.md)（9 条 ADR：理由 + 代价 + 易错点） |
| 界面交互契约、使用偏好清单 | [`docs/界面契约.md`](docs/界面契约.md) |
| 启动参数、端口、双实例、发版校验 | [`docs/部署与运维.md`](docs/部署与运维.md) |
| 出故障了（症状 → 处置） | [`docs/排查手册.md`](docs/排查手册.md) |
| 历史快照里 ≥16 TiB 的异常数据 | [`docs/legacy 快照迁移指引.md`](docs/legacy%20快照迁移指引.md) |
| 改代码不能违反什么（红线） | [`AGENTS.md`](AGENTS.md) |
| 文档体系怎么管、缺什么 | [`docs/README.md`](docs/README.md)（索引 + 管理规范） |
| 每次开发做了什么 | [`docs/CHANGELOG.md`](docs/CHANGELOG.md) |

---

## 测试与验证

```powershell
python -m pytest tests -q          # 后端全量（含文档同步与文档一致性两套契约）
node --test scripts/dev/           # 前端纯 JS 单测（沙盒内改用 node --test-isolation=none --test "scripts/dev/*.test.mjs"）
```

<!-- DOCFACT:BEGIN pytest_nodes -->
**可数事实**：`pytest tests` 当前收集 **372** 项（与实跑一致：372 = 通过数 + 失败数，子测试另计）。
测试增减后本行会过期，`tests/test_docs_consistency.py` 会按 `tests/` 下实际用例数与本行核对。
<!-- DOCFACT:END -->

- 后端测试经 `app.test_client()` 进行，不真正启动服务器、不联网。
- 前端冒烟：浏览器打开 `tests/web/smoke.html`，标题出现 `[suite=v2][PASS 23/23]` 即绿；
  失败时标题会写明失败编号（如 `[FAIL 3/23 · A18,A20,A22]`）。
- 跑冒烟时**不要重复打开页面**——重新 open 会打断正在跑的套件，产生「壳未 boot」假红。

## 数据目录与产物隔离

- 真实数据：`%LOCALAPPDATA%\PythonDiskScanner\`（session 清单在根，快照在 `snapshots\`，导出在 `exports\`）。
- **测试/夹具产物绝不写入真实数据目录**：`scripts/dev/fixture_snapshots.mjs` 内置守卫，默认写 `%TEMP%`；
  历史遗留夹具已隔离在 `<数据目录>\_quarantine\`（该子目录不被 `session.list_sessions()` 扫描）。
- 截图、测试报告等一次性产物不入库，用临时目录或系统 Temp。

---

## 版本与分支（要点）

- **版本标记纪律**：开发过程中**不得**自行改版本号、打 tag、建 Release；
  唯一触发条件是**项目负责人显性通知**（如「发版 v2.2.0」）。详解见
  [`docs/开发规范.md`](docs/开发规范.md) 与 [`AGENTS.md`](AGENTS.md) 第 5 节。
- **分支模型**：`main` 为唯一长期分支；短期分支 `feature/` `fix/` `docs/` `refactor/`，
  一个分支一件事、合并后即删。完整规范（含准入条件）见 [`docs/开发规范.md`](docs/开发规范.md)。
- **远端状态**：本地 `main` 于 2026-09-28 经 `git push --mirror` 覆盖远端，两边已一致；
  此后正常 `git push` / `git pull` 即可。
