# Python 磁盘分析工具（SpaceLens Pro）

基于 Everything SDK 的 Windows 本地磁盘空间分析工具，三种形态共用同一套后端模块：

- **Web UI（主形态）**：Flask 本地单页应用（UI 2.0「SpaceLens Pro」）——`python app.py` 启动，只绑定 `127.0.0.1`，默认自动打开浏览器。
- **TUI**：终端交互界面（msvcrt 按键 + ANSI/VT 渲染）——`python main.py`。
- **CLI**：非交互 Top-N 报告与 CSV/JSON 导出——`python main.py <TARGET> ...`。

核心能力：毫秒级全盘扫描、目录占用浏览（矩形图/排行/表格/关系四视图）、快照保存与撤销、
快照间与「快照 vs 当前」对比（增量 Top-N、深度折叠、多快照趋势折线）、一键清空数据目录。

> **本文档是项目唯一入口**：项目说明、逐文件职责总表、API 概览、Git 分支规范、文档维护规范都在这里。
> 文件职责总表由 `tests/test_docs_sync.py` 机械校验——**新增或删除任何文件都必须同步本表**，否则测试会红。

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

## 代码地图（文件职责总表）

<!-- FILEMAP:BEGIN -->

> 下面每张表的路径列是**机读区段**：`tests/test_docs_sync.py` 会双向比对磁盘实际文件，
> 新增文件未登记、或删文件后残留条目，都会让 pytest 变红。

### 后端模块（仓库根，扁平 Python 模块）

| 文件 | 职责 |
|---|---|
| `main.py` | 程序入口与**兼容层**：把拆分出去的顶层名字全量导回 `main` 命名空间；`_LIVE_FORWARD`（13 项）用自定义模块类型把可变全局与补丁敏感函数动态转发到归属模块（`DLL_PATH`→sdk、`VERBOSE`→utils、`_ANSI_AVAILABLE`/`_getch`/`msvcrt`→tui、`winreg`/`_GLOBAL_JOB_HANDLE`/`resolve_everything_dll`/`find_everything_exe`/`load_config`/`save_config`/`wait_for_everything_ipc`/`bind_pid_to_job_sandbox`→env） |
| `app.py` | Flask Web 入口（主形态）：单页 + 19 条路由；只绑 `127.0.0.1`、`threaded=True`、默认自动开浏览器（`run_server(port=5000, open_browser=True, debug_log=False)`）；前台浏览与后台全量共用 `scan.SCAN_LOCK`，防 DLL 重入 |
| `cli.py` | 命令行装配层：参数解析与交互/非交互分流；启动最早处调 `utils._reconfigure_std_streams()` 重配置 UTF-8 流；交互退出统一经 `_auto_save_on_exit` 走四原子谓词自动保存（未通过一律静默） |
| `tui.py` | 终端交互界面：msvcrt 受保护导入与 `_getch`、ANSI/VT 渲染与 `_ANSI_AVAILABLE`、主循环 `interactive_ui`、r/R 两级刷新（60s 冷却 + 指纹门）、`/` 路径跳转模态、`S` 保存与 `H` 历史对比模态、反转色状态栏与 `h` 全屏帮助 |
| `scan.py` | Everything SDK 扫描主流程，**全局扫描锁唯一持有实体** `SCAN_LOCK`；常量 `MAX_FILES_PER_DIR=50`、`SCAN_PROGRESS_REFRESH_INTERVAL=10000`、`SIZE_UNKNOWN_MAX_BYTES=16TiB`；惰性 contents（`LazyContents`）、指纹探测与轻刷/深刷、协作取消（`ScanCancelledError`） |
| `fullscan.py` | 后台全量扫描调度：盘符枚举（GetLogicalDrives，失败回退 A-Z）、单后台线程串行扫描、状态机 `idle/queued/scanning/finishing`、看门狗（单盘 15 分钟无行更新 → 置 `CANCEL_EVENT` 协作取消，绝不硬杀线程）、`GLOBAL_SCAN_LOCK` 为 `scan.SCAN_LOCK` 别名、`BROWSE_INDEX` 前台浏览索引 |
| `sdk.py` | Everything SDK 与 Win32 常量封装：DLL 架构选择与解析、函数签名声明、IPC 健康检查（`is_everything_ipc_ready` 等）；**`sdk.DLL_PATH` 是跨模块可变全局**，env 与 scan 都通过模块属性读写 |
| `env.py` | 运行环境协调：`config.json` 读写、Everything.exe 定位（含 winreg 受保护导入）、进程枚举与会话判定、Job Object 防孤儿沙盒（`_GLOBAL_JOB_HANDLE`）、Everything 启动与 IPC 等待（`ensure_everything_running`，并在其中回填 `sdk.DLL_PATH`） |
| `snapshots.py` | 快照持久化：gzip JSONL（首行 header 带 CRC）；`SNAPSHOT_FORMAT_VERSION=1`、`MAX_ROWS=500000`、`MAX_BYTES_PER_DAY=102.4MiB`、`AUTO_MAX_PER_ROOT_PER_DAY=1`、`KEEP_EXPLICIT=30`、`KEEP_AUTO=10`、`STALE_LOCK_TTL_SECONDS=600`；临时文件 + `os.replace` 原子替换、`O_EXCL` 锁文件、`should_auto_save` 四原子谓词、日配额台账（`ledger.json`/`day_writes.json`） |
| `compare.py` | 纯对比引擎（零 UI/零颜色）：快照间与「快照 vs 内存树」diff、`|delta|` 降序、`depth=N` 折叠、`drop_zero`、`growth_pct`（基数 `MIN_GROWTH_BASE_BYTES=1MiB`）、legacy 标记；依赖 snapshots/utils |
| `session.py` | `session_*.json` 清单读写：一次保存 = 各盘快照 + 一条清单，支撑历史列表聚合与「撤销最近一次保存」；进程内自增序号保证同微秒不重号 |
| `datadir.py` | 数据根目录统一（`get_data_dir` 等）与一键清空 `wipe_data`；叶子模块，只依赖标准库 |
| `messages.py` | 横幅文案模板资产 `BANNER_TEMPLATES` + `render_message`：界面层取用户可见文案的唯一入口 |
| `keyrouter.py` | 键位注册表 `KEY_BINDINGS` 单一事实源（12 条：W/↑、s/↓、Enter、Backspace、C、r、R、`/`、S、H、h、Q），同时驱动按键分发与帮助文案生成 |
| `utils.py` | 通用工具与全局配置：`APP_NAME`、`VERBOSE`/`log`、`human_size`、`_reconfigure_std_streams`、`_fatal`、`SCRIPT_DIR`/`CONFIG_PATH`；不依赖任何项目内模块 |
| `exceptions.py` | 公共异常：`MsvcrtUnavailableError`、`EverythingEnvironmentError`、`EverythingQueryError`；独立成模块以避免循环导入 |

### Web 前端（`web/`，原生 ES Module，无构建步骤）

| 文件 | 职责 |
|---|---|
| `web/templates/index.html` | 应用壳骨架：防闪烁主题内联脚本 + 顶栏/路由视区/状态栏/设置弹窗三分页/toast 容器；状态栏版本号落点 `.statusbar-left` |
| `web/static/css/tokens.css` | 设计 token 单一来源：时长缓动、字号/圆角/间距刻度、亮暗主题色值与图表色板；JS 运行时读取时长 token |
| `web/static/css/style.css` | 全站样式表：应用壳/布局/顶栏/卡片/列表/矩形图/浮层/动效分区；色值一律引用 tokens |
| `web/static/js/app/api.js` | 基础工具：`$` 取元素、`esc` 转义、`api`/`postJson` 请求封装、`humanBytes`/`signedBytes` 字节格式化 |
| `web/static/js/app/state.js` | `APP_STATE` 单一状态树：route/browse/view/scan/snapshots/compare/treemap/ui 命名空间 |
| `web/static/js/app/theme.js` | 主题三态（亮/暗/跟随系统）持久化、View Transitions 圆形扩散切换、系统偏好监听 |
| `web/static/js/app/prefs.js` | **使用偏好**注册表 `PREF_REGISTRY`（单一 localStorage 文档 `pds_prefs_v1`）：白名单校验读写、恢复默认、分组渲染、启动回灌 state |
| `web/static/js/app/icons.js` | 内联 SVG 图标表 `ICONS`：目录/文件/盘符/时钟/成功/警告/关闭/下钻/对勾/停止 |
| `web/static/js/app/labels.js` | 共享文案映射：`skip_reason` 枚举 → 中文（scan 与 snapshots 共用，防循环依赖） |
| `web/static/js/app/keys.js` | 单键快捷键共享守卫：输入框/可编辑元素与输入法组词（`isComposing`）一律忽略 |
| `web/static/js/app/keyboard.js` | 键盘矩阵：`/` 聚焦筛选框、`g c`/`g s` 连按跳页、矩形图方向键移动焦点块与 Enter 下钻 |
| `web/static/js/app/motion-core.js` | 零 DOM 纯函数库：插值/缓动/cubicBezier/fnv1a 哈希/耗时与 ETA/sparkline 路径（`node --test` 直接覆盖） |
| `web/static/js/app/motion.js` | DOM 动效库（读 token 时长缓动 + `prefers-reduced-motion` 降级）：countUp/ripple/staggerIn/页面转场/FLIP/粒子/抖动/描边 |
| `web/static/js/app/palette.js` | 矩形图调色板：`fnv1a(名称)%10` 的 `colorFor` 取色 +「其他」合并块固定色 |
| `web/static/js/app/router.js` | 表驱动 hash 路由（`/`、`/compare`、`/snapshots`，未知回落 `/`）：出入场转场、导航标签同步、切页后页头焦点管理 |
| `web/static/js/app/main.js` | 入口装配：壳级绑定 → 页面注册表注入 router → 异步 init 链与自动全盘扫描；另导出 smoke 断言面 |
| `web/static/js/app/components/feedback.js` | `renderApiError` 统一错误渲染：主文案 + 错误码标签 + detail + 重试/查看帮助 |
| `web/static/js/app/components/statusbar.js` | 状态行 `setStatus`（ok/warn/err/busy）与状态栏「已选 N 项」计数渲染 |
| `web/static/js/app/components/toast.js` | toast 通知：滑入/成功描边/错误脉动/自动消失进度条 + hover 暂停与关闭 |
| `web/static/js/app/components/modals.js` | 弹窗栈：Esc 逆序关栈顶、Tab 焦点陷阱、R 守卫；`confirmDialog` 的 Promise 确认框 |
| `web/static/js/app/components/nav-dots.js` | 导航标签圆点提醒：`markNavDot` 挂点、点击消除、路由变化同步 |
| `web/static/js/app/components/topbar.js` | 顶栏徽章与门控：`refreshHealth` 轮询、`evaluateEnvGate`、健康 popover、导航下划线 |
| `web/static/js/app/components/drives.js` | 盘符清单唯一来源：`/api/roots` 取数排序去重、可用性标注、选择写 `last_roots` |
| `web/static/js/app/components/onboarding.js` | 首启引导弹层：步骤文案、关闭记忆、选盘步骤动态渲染与可跳过的选盘提交 |
| `web/static/js/app/components/storage.js` | 存储概览卡：环形图 + 盘符 chips 联动浏览、空/加载/数据/扫描中四态 |
| `web/static/js/app/components/scan.js` | 扫描卡状态机：启动/轮询/停止/ETA 计时、保存与撤销快照、CSV/JSON 导出 |
| `web/static/js/app/components/settings.js` | 设置弹窗三分页：自动保存/主题三态/使用偏好回显/危险区清空倒计时解锁 |
| `web/static/js/app/components/snapshot-mini.js` | 右栏快照迷你卡与「最近对比」迷你卡渲染、空态与跳转入口 |
| `web/static/js/app/components/snapshot-view.js` | 快照页**纯函数**：日历热力图模型与 HTML、会话有无内容判定与空/夹具会话拆分（`FIXTURE_ROOT_RE`）、最近快照列表；零 DOM 依赖，`node --test` 直接覆盖 |
| `web/static/js/app/components/palette-cmd.js` | 命令面板：Ctrl/⌘K 开合、条目模糊打分与分组渲染、键盘选择执行 |
| `web/static/js/app/components/list.js` | 排行/表格列表：筛选排序、多选与 Shift 范围选、虚拟滚动、CSV 导出、行内操作 |
| `web/static/js/app/pages/workspace.js` | 工作台页：目录浏览闭环、矩形图派发、四视图切换、面包屑/迷你条带/全屏下钻 |
| `web/static/js/app/pages/compare.js` | 空间对比页：基准/深度/隐藏零变化控件、摘要卡、趋势折线点选与结果表格下钻；主对比基准单一收口（`setPrimaryBaseline`/`primaryBaseline`/`mirrorPicksToSelect`） |
| `web/static/js/app/pages/snapshots.js` | 快照管理页：会话分组列表、日历筛选、批量删除、创建/撤销入口与趋势入口 |
| `web/static/js/app/viz/treemap.js` | 矩形图渲染器：squarified 布局纯函数 + 双层 canvas、命中测试、FLIP 下钻与雷达扫掠 |
| `web/static/js/app/viz/donut.js` | 环形图渲染器：双弧 SVG、入场 sweep + 中心 count-up、扫描中不确定弧与 hover 光晕 |
| `web/static/js/app/viz/line.js` | 多快照趋势折线：几何/命中/读数与点选纯函数（`PICK_RADIUS_PX=28`、`readoutLeft` 边界夹取）+ 零依赖 SVG 渲染 |
| `web/static/js/app/viz/relate.js` | 关系目录层级树：单击懒展开下钻、虚拟滚动、键盘可达、与其他视图互斥显隐 |

### 测试（`tests/`）

| 文件 | 职责 |
|---|---|
| `tests/__init__.py` | 测试包「沙盒兼容垫片」：探测 `tempfile.mkdtemp()` 在 Windows 沙盒下产物不可访问的问题，必要时替换为无特殊 ACL 的 `_mkdtemp_compat` |
| `tests/web/smoke.html` | 前端冒烟断言面（浏览器打开，标题 `[suite=v2][PASS 23/23]` 即绿）：解析期用 `SAMPLES` 桩接管 `fetch`，登记 **A0–A22 共 23 条**断言；失败时标题写 `[FAIL k/23 · A18,A20]` |
| `tests/test_api_contract.py` | Web API 字段契约：health/browse/settings/compare/series/snapshots 等响应形状与错误体 |
| `tests/test_budget.py` | 日配额接线：auto 硬门槛、explicit 软警告、通知通道、并发记账 |
| `tests/test_busy.py` | 统一持锁 busy 契约：health busy 形态、compare 409、跨模块锁同一性 |
| `tests/test_cli.py` | cli.main：致命出口路径、成功装配流程、非交互 Top-N 报告 |
| `tests/test_compare.py` | compare 现状护栏：总量/深度聚合、零值过滤、三处同值阈值常量、merge 排序 |
| `tests/test_docs_sync.py` | **文档同步契约**：必备文档存在性、README 骨架章节、文件职责总表与磁盘文件双向一致 |
| `tests/test_docs_consistency.py` | **文档冲突与一致性契约**：职责唯一（只有 README 可登记职责）、引用不悬空（幽灵路径）、数值事实不撒谎（`DOCFACT` 与代码真值核对）、CHANGELOG 时间不倒序 |
| `tests/test_env.py` | env：启动参数规范化、配置 IO 与迁移、Everything.exe 定位、启动流程 |
| `tests/test_export.py` | cli 导出：CSV/JSON 内容、自动命名、写失败退出、交互模式忽略 |
| `tests/test_fullscan.py` | fullscan：BrowseIndex shard 收缩、行数超限文案、停止事件状态 |
| `tests/test_machine.py` | machine_guid 强校验：引擎/CLI/Web/TUI 拦截与放行矩阵 |
| `tests/test_messages.py` | messages：Everything 错误码表完整性、已知/未知码渲染 |
| `tests/test_scan.py` | scan：目录深度排序键、扫描根判定、惰性 contents、SDK 全流程 |
| `tests/test_sdk.py` | sdk：DLL 名平台推断、DLL 解析选择、IPC 就绪逻辑、加载缓存 |
| `tests/test_security.py` | 安全：Host 白名单 403、设置投毒键拒收且不落盘 |
| `tests/test_shutdown.py` | 部署与停服：防双实例占用探测、协作取消保留已完成根 |
| `tests/test_snapshot_golden.py` | 快照格式 golden 护栏：往返保头/行、零与超大值、legacy 标记（改格式必须同步） |
| `tests/test_stale_lock.py` | 陈旧锁检测：死 PID/TTL/活进程/非法内容四夹具 |
| `tests/test_stage_b.py` | 阶段B 后端契约：扫描状态机、看门狗、compare/browse/export/health |
| `tests/test_stage_c.py` | 阶段C 后端契约：快照删除 API 与台账/清单一致性 |
| `tests/test_stage_d.py` | 阶段D 后端契约：自动保存链路、状态事实、部分失败清单（全盘 skipped 仍写清单） |
| `tests/test_stage_f.py` | 阶段F：`_leaf_keys` 与旧 O(n²) 等价、大样本性能、`_merge` leaf_only |
| `tests/test_stage_g.py` | 阶段G：`total_by_root` 派生（sparkline 数据源）护栏 |
| `tests/test_stage_p1.py` | P1：扫描完成回调与自动保存唯一性、跳过原因、失败可补救 |
| `tests/test_tui.py` | tui.interactive_ui：空目录边界、导航、退出、C 切换、异常透传 |
| `tests/test_undo.py` | 保存/撤销语义：台账回滚、逐盘成败、越界拒删、原子清单 |
| `tests/test_utils.py` | utils：`human_size` 格式化、`log` 的 VERBOSE 开关、流 UTF-8 重配置 |
| `tests/test_web_export.py` | Web 导出：`build_*` 与 CLI 产物等价、`/api/export` 契约与 legacy 行 |

### 开发脚本（`scripts/dev/`）

| 文件 | 职责 |
|---|---|
| `scripts/dev/README.md` | 开发工具清单与使用纪律（只保留可复用工具，一次性脚本用完即删） |
| `scripts/dev/_harness.mjs` | 浏览器探针统一入口：Playwright/Chromium 路径集中（`PDS_PW`/`PDS_CHROME` 可覆盖），导出 `launch`/`shot`/`screencast`/`arg`/`wait`/`frameRecorderSource` 等；新探针**必须** import 它 |
| `scripts/dev/fixture_snapshots.mjs` | 快照夹具生成器：造当前/23h/25h/8d/跨盘五类会话；默认写 `%TEMP%\pds_fixture_snapshots_<ts>`，**内置守卫拒绝写入真实数据目录**（须 `--allow-real-dir` 覆盖）；参数 `--dir`/`--now` |
| `scripts/dev/destructive_acceptance.ps1` | 隔离数据目录破坏性流程验收（PS 5.1 兼容）：重定向 LOCALAPPDATA → save/台账/undo/谓词/wipe 双确认/重建/打包冒烟；`-WhatIf` 干跑、`-Cleanup` 清理隔离根 |
| `scripts/dev/motion-core.test.mjs` | `motion-core.js` 纯函数单测（插值/缓动/哈希/ETA/sparkline） |
| `scripts/dev/treemap.test.mjs` | `viz/treemap.js` 布局与命中纯函数单测 |
| `scripts/dev/line-pick.test.mjs` | `viz/line.js` 点选命中纯函数单测 |
| `scripts/dev/trend-window.test.mjs` | `viz/line.js` 读数边界夹取（`readoutLeft`）单测 |
| `scripts/dev/prefs.test.mjs` | `prefs.js` 偏好读写与清洗单测 |
| `scripts/dev/snapshot-view.test.mjs` | `components/snapshot-view.js` 会话分组/夹具判定/日历模型单测 |

### 项目文档（`docs/` 与仓库根）

| 文件 | 职责 |
|---|---|
| `README.md` | **本文件**：项目唯一入口（项目说明 + 代码地图 / 逐文件职责总表 + API 概览 + Git 分支规范 + 文档维护规范 + 界面契约 + 使用偏好） |
| `AGENTS.md` | AI agent 工作约束（约束类**唯一事实源**）：环境红线、20 条架构红线、编码约定、分支与提交要点、变更后必做、发版流程 |
| `docs/README.md` | **文档索引与管理规范**：文档清单（管什么/何时更新/权威性）、**自动生成触发条件与命名约定**、**文档冲突判定与权威优先级**、文档分级（长期/过程/记录/禁入库）、更新与淘汰规则、当前文档欠账登记 |
| `docs/_文档模板.md` | 新增文档的**强制模板**（下划线前缀 = 不参与索引编号）：复制后补齐「职责/权威来源/更新触发/唯一性声明」四要素 |
| `docs/开发规范.md` | 开发操作手册：分支作用表与准入条件、一次开发的标准流程、每次开发后必更文档的 12 项清单、提交信息格式 |
| `docs/API 契约.md` | API 契约参考（人读）：三条契约红线（additive/JSON 错误/白名单）、三种错误体形态、Everything 错误码表、HTTP 状态约定、冻结键集合速查（**权威在 `tests/test_api_contract.py`**） |
| `docs/排查手册.md` | 排查手册（症状 → 原因 → 处置）：环境与工具链、扫描与 Everything、快照与历史、界面与前端、诊断命令 |
| `docs/legacy 快照迁移指引.md` | 历史快照中 **≥16 TiB「已知异常大小」数据**的判定与处置：三处计数口径（`unknown_size_count`/`legacy_unknown_rows`/`legacy_count`）、要不要重建基线、重建步骤、5 条常见误区 |
| `docs/CHANGELOG.md` | 变更日志（时间倒序）：每次开发完成后追加一条记录（变更/文件/验证/文档/遗留）；亦保留历史阶段名索引 |

### 临时工作区（`tmp/`，整个目录不入库）

| 文件 | 职责 |
|---|---|
| `tmp/README.md` | 临时产物落点与纪律：可放什么（一次性脚本/日志/截图/草稿）、绝对不放什么（运行数据/凭据/需长期保留物）、与 `scripts/dev/`、`%TEMP%` 的分工；`tmp/*` 被忽略、仅本说明入库 |

### 仓库配置与运行时依赖

| 文件 | 职责 |
|---|---|
| `web/static/assets/来源清单.md` | 界面素材来源与授权登记表 + 素材准入规则（当前无第三方素材，图标为内联 SVG） |
| `.gitignore` | 版本控制忽略规则：Python 缓存、本地运行期产物、打包输出、SDK DLL 白名单、`.venv/`、临时工作区 `tmp/*`、编辑器与系统噪声 |
| `requirements.txt` | 唯一第三方依赖清单：Web 形态 `flask>=3.0.2`（CLI/TUI 仅标准库）；pyinstaller 为可选打包工具（注释态） |
| `everything-SDK/dll/Everything64.dll` | 64 位 Everything SDK 运行库（运行时依赖，不经 pip） |
| `everything-SDK/dll/Everything32.dll` | 32 位 Everything SDK 运行库（32 位 Python 回退） |

<!-- FILEMAP:END -->

---

## API 概览

`app.py` 共 19 条路由（18 条 `/api/*` + 首页）。测试经 `app.test_client()` 进行，不真正启服务。

<!-- DOCFACT:BEGIN routes -->
**可数事实**：`app.py` 共 **19** 条路由 = 1 条页面路由（`GET /`）+ 18 条 API 路由。
本数值由 `tests/test_docs_consistency.py` 按 `app.py` 的路由装饰器**实际计数**核对——改路由必须同步本行。
<!-- DOCFACT:END -->

| 方法与路径 | 作用 |
|---|---|
| `GET /` | 返回单页 `web/templates/index.html` |
| `GET /api/health` | 环境健康与 busy 形态（含 `sdk`/Everything 就绪、锁占用） |
| `GET /api/overview` | 最近全量结果的轻量概览，供仪表盘图表使用（未就绪时给 `empty_reason`） |
| `GET /api/roots` | 本地盘符清单（枚举异常时返回空清单而非 500，前端回落「请选择盘符」） |
| `POST /api/browse` | 前台浏览某个目录（与后台全量共用 `scan.SCAN_LOCK`） |
| `POST /api/open-path` | 在资源管理器中定位路径（校验绝对路径/控制字符/长度/存在性，失败 400 中文错误） |
| `POST /api/fullscan/start` | 启动后台全量扫描（返回 `{started, queued, phase}`） |
| `GET /api/fullscan/status` | 全量扫描状态（phase/进度/锁持有者/停止确认） |
| `POST /api/fullscan/stop` | 协作停止：置位事件，由扫描循环自行退出（绝不硬杀线程） |
| `POST /api/save` | 保存快照（走四原子谓词与日配额） |
| `POST /api/save/undo` | 撤销最近一次保存（按清单删对应快照文件） |
| `GET /api/snapshots` | 会话历史列表（每条含各盘快照与 additive `total_by_root`） |
| `POST /api/snapshot/delete` | 删除单盘快照或整会话（扫描中 409；越界路径绝不 unlink） |
| `GET /api/series` | 多快照序列（趋势折线数据源）：参数 `root`/`snapshots`/`path`/`depth`；只读，绝不触发扫描 |
| `POST /api/compare` | 执行对比（快照间或快照 vs 当前），支持 `depth`/`drop_zero`/`order_by` |
| `GET /api/compare/status` | 异步对比作业状态（完成给 report，扫描中给 phase） |
| `GET|POST /api/settings` | 设置读写：白名单仅 `auto_save`/`last_roots`/`theme`，投毒键拒收 |
| `GET /api/export` | 导出目录占用报告 CSV/JSON（与 CLI `build_*` 同源；部分失败带 `X-Export-Partial`） |
| `POST /api/admin/wipe` | 一键清空数据目录（危险区，二次确认） |

## 命令行与键位

CLI（`cli.py`）：`TARGET`（可选，给了就进非交互模式）、`--top N`（1–200，默认 10）、`--quiet`、
`--export {csv,json}`、`--output PATH`（须与 `--export` 搭配）、`--snapshot-dir PATH`、
`--no-snapshot`、`--baseline PATH`、`--allow-other-machine`。

TUI 键位（单一事实源 `keyrouter.KEY_BINDINGS`，改键位只改注册表）：

<!-- DOCFACT:BEGIN keybindings -->
**可数事实**：注册表共 **12** 条键位（下表即其展开）。
`tests/test_docs_consistency.py` 按 `keyrouter.KEY_BINDINGS` 实际长度核对，新增键位必须同步本行与下表。
<!-- DOCFACT:END -->

| 键 | 动作 | 键 | 动作 |
|---|---|---|---|
| `W` / `↑` | 光标上移 | `S` | 保存快照 |
| `s` / `↓` | 光标下移 | `H` | 历史对比 |
| `Enter` | 进入目录 | `h` | 全屏帮助 |
| `Backspace` | 返回上级 | `q` / `Q` | 退出 |
| `C` | 切换扫描路径 | `/` | 路径跳转 |
| `r` | 轻量刷新 | `R` | 深度刷新 |

---

## Git 分支规范

> 目的：让「哪个分支能跑、哪个分支能发」一眼可判。**一个分支只做一件事**，合并后立即删除。

### 长期分支

| 分支 | 作用 | 准入条件 |
|---|---|---|
| `main` | **唯一长期分支**，稳定线；任何提交都应能直接 `python app.py` 跑起来 | `python -m pytest tests -q` 与 `node --test scripts/dev/` 全绿；文档已同步 |

### 短期分支（从 `main` 切出，用完即删）

| 分支前缀 | 用途 | 合并要求 |
|---|---|---|
| `feature/<主题>` | 新功能（如 `feature/snapshot-calendar`） | 测试全绿 + README 文件总表/API/界面约定同步 |
| `fix/<主题>` | 缺陷修复（含 UI 实测问题） | 附复现步骤与验证方式；UI 问题须有截图确认 |
| `docs/<主题>` | 纯文档变更（README/AGENTS/来源清单） | `tests/test_docs_sync.py` 必须绿 |
| `refactor/<主题>` | 不改行为的结构调整（模块拆分、纯函数提取） | 行为等价由既有测试证明，不新增功能 |
| `release/vX.Y.Z` | 发版冻结与打包验证 | 只允许版本号与发布相关改动 |
| `hotfix/vX.Y.Z` | 已发布版本的紧急修复 | 从对应 tag 切出，修完**同时**回合 `main` |

### 命名与提交规则

- 分支名全小写 + 短横线，禁止中文、空格与个人前缀；一个分支只承载一个主题。
- 提交信息用中文；首行 ≤ 50 字写「做了什么」，正文写「为什么 + 怎么验证的」。
- **已废止**：`stage-*` 阶段分支与 `ui*` 版本线分支（历史已于 2026-09-28 压缩为单一根提交，不再新建）。
  阶段性工作改用 `feature/<主题>`，界面重构改用 `feature/ui-<主题>`。

### 远端现状（务必先读）

本地 `main` 于 **2026-09-28** 主动压缩为**单一根提交**（旧 224 条提交、14 个 tag、10 个分支已从本地删除），
而 GitHub 的 `origin/main` 仍是压缩前的完整历史 —— **两者已分叉**，直接 `git push` 会被拒绝。两条出路：

- **路径 A（推荐）**：`git push --force origin main` —— 远端与新历史对齐，之后 push/pull 恢复正常。
- **路径 B**：保留远端旧历史 —— 本地另建分支推送，或干脆不推 `main`。

在做出选择前，本地 `main` 与 `origin/main` 的差异是**预期状态**，不是错误。

---

## 文档维护规范

**每次开发完成后（= 合并回 `main` 之前）必须同步对应文档**，这是硬约束，不是建议。
操作手册（分支怎么切、流程怎么走、清单怎么打勾）见 [`docs/开发规范.md`](docs/开发规范.md)；
每次迭代的产出记录追加到 [`docs/CHANGELOG.md`](docs/CHANGELOG.md)。
最低验收：`python -m pytest tests -q`、`node --test scripts/dev/` 全绿，其中 `tests/test_docs_sync.py` 专门盯文档同步。

| 变更类型 | 必须同步更新 |
|---|---|
| **每次开发完成** | [`docs/CHANGELOG.md`](docs/CHANGELOG.md) 追加一条（变更/文件/验证/文档/遗留） |
| 新增/删除/改名**任何文件** | 本文件「代码地图（文件职责总表）」——`tests/test_docs_sync.py` 会红 |
| 新增/改动 API 路由 | 本文件「API 概览」+ `tests/test_api_contract.py` |
| 新增/改动 CLI 参数 | 本文件「命令行与键位」+ `cli.py` 帮助文本 |
| 新增/改动 TUI 键位 | `keyrouter.KEY_BINDINGS`（唯一事实源）+ 本文件键位表 |
| 新增用户可见文案 | `messages.py` 模板（不是文档）；界面文案走 `labels.js`/`prefs.js` 注册表 |
| 新增使用偏好项 | `prefs.js` 的 `PREF_REGISTRY` + 本文件「使用偏好」 |
| 快照格式变更 | `SNAPSHOT_FORMAT_VERSION` + `compare` 版本校验 + `tests/test_snapshot_golden.py` + 本文档 |
| legacy 阈值常量变更 | `compare`/`snapshots`/`scan` 三处同值 + 本文档与 `AGENTS.md` 登记 |
| 界面语义契约变更 | 本文件「界面契约」+ `AGENTS.md` 架构红线 + `tests/web/smoke.html` 对应断言 |
| 数据目录/环境变量变更 | 本文件「运行环境」「数据目录」+ `AGENTS.md` |
| 新增架构红线/共享全局 | `AGENTS.md` 第 3 节（失效的约束要删掉，不留过期规则） |
| 发版 | `web/templates/index.html` 状态栏版本号 → tag → Release（见 `AGENTS.md`） |

---

## 测试与验证

```powershell
python -m pytest tests -q          # 后端全量（含文档同步与文档一致性两套契约）
node --test scripts/dev/           # 前端纯 JS 单测（沙盒内改用 node --test-isolation=none --test "scripts/dev/*.test.mjs"）
```

<!-- DOCFACT:BEGIN pytest_nodes -->
**可数事实**：`pytest tests` 当前收集 **371** 项（与实跑一致：371 = 通过数 + 失败数，子测试另计）。
测试增减后本行会过期，`tests/test_docs_consistency.py` 会跑一次 `pytest --collect-only` 取真实收集数与本行核对。
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

## 界面契约（易踩坑的既有约定）

- **设置弹窗**分三分页「常规 / 使用偏好 / 危险区」（`#tab-general`/`#tab-prefs`/`#tab-danger` 与对应 `#pane-*`）：
  面板固定高度、只有内容区滚动，整窗不滚动。新增设置项必须挂到某一分页。
- **盘符联动**：存储概览卡 chips 点击 = 切环形/图例**且**左侧视图区浏览该盘，与「浏览此盘」共用 `goBrowseRoot()` 单一收口。
- **快照列表只展示「有内容且非夹具」的会话**：全盘 skipped、保存后 0 字节、以及测试夹具会话（`FIXTURE_ROOT_RE` 命中，如 `C:\SDK1`）都不显示；列表头给「已隐藏 N 个空会话 · M 个测试会话 + 清理」。**后端契约不变**（全盘 skipped 仍写清单，作审计轨迹）。
- **对比以「盘」为范围**：一次保存会同时写多个盘，但对比与趋势的单位是盘；基准列表只列当前盘的各次保存（按会话分组），多选恒为同盘不同时间点。
- **对比基准两层语义**：多选 `state.baselines` = 折线看哪几次；点折线数据点 = 换主基准 `state.baseline`（折线不塌缩成单选）。
  主基准读取口径**必须是 `#compare-baseline.dataset.base` 或 state，绝不用 `sel.value`**（`<select multiple>` 的 `value` 恒为第一个 selected 项）。
- **折线读数**按实际宽度做边界夹取，最左/最右数据点都不越出卡片与视口。

## 使用偏好

界面「使用习惯」类持久化统一走 `web/static/js/app/prefs.js` 的 `PREF_REGISTRY` + 单一 localStorage 文档 `pds_prefs_v1`；
设置弹窗「使用偏好」区由注册表渲染，禁止新散键、禁止在页面里自行 `localStorage.setItem`。清空数据目录**不会**清掉偏好。

| 偏好 | 键 | 默认 |
|---|---|---|
| 默认视图 | `view.mode` | `treemap` |
| 矩形图合并阈值 | `view.mergeTop` | `24`（1–200） |
| 默认内容类型 | `list.kind` | `all` |
| 默认排序 | `list.sort` | `size-desc` |
| 默认对比深度 | `compare.depth` | `""`（叶子） |
| 默认隐藏零变化 | `compare.hideZero` | `true` |

后端 `config.json` 侧另有 `auto_save`/`last_roots`/`theme`（白名单固定，UI 偏好**不进** `config.json`）。
