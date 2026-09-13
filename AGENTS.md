# AGENTS.md — 项目级 Agent 工作约束

本文件约束在本仓库中工作的 AI agent。改动代码前必读；**做出任何更改后，必须同步检查并更新本文件与 `README.md`**（见第 6 节）。

## 1. 项目形态速览

Windows 本地磁盘分析工具，三种形态共用同一套后端模块：Web UI（`app.py`，主形态）、TUI（`main.py` 无参）、CLI（`main.py <target>`）。详细代码地图见 `README.md`，定位文件先查那里，不要盲目全文搜索。

## 2. 环境红线（本机 Windows）

- 本机 PowerShell 为 **5.1 Desktop**：无 `&&`/`||`、无三元/空合并语法；pwsh 每次调用是全新进程，不保留 cwd/变量。
- `npm`/`pnpm`/`npx` 不在 PATH 上；本机**无 Chrome**，浏览器自动化用 dsh 的 `browser_*` 工具，不要从 pwsh 启动无头浏览器。
- 运行/测试入口：`.venv` 在项目根；`python -m pytest tests -q --ignore=tests/archive_pre_p12` 跑后端（`archive_pre_p12` 引用已删除模块，收集期即报错，须排除），`node --test scripts/dev/*.test.mjs` 跑前端纯 JS 单测。

## 3. 架构红线（违反即返工）

1. **扫描锁单例**：一切触碰 Everything SDK 的调用必须经过 `scan.SCAN_LOCK`（= `fullscan.GLOBAL_SCAN_LOCK`）。新增调用 DLL 的代码路径时，先确认走锁。
2. **依赖方向无环**：`datadir`/`exceptions`/`utils` 为叶子（不 import 项目内模块）；`sdk → utils`；`scan → utils/sdk`；`snapshots → datadir`；`session → datadir`；`compare → snapshots/utils`；`tui/cli/env` 在其上。禁止反向 import。
3. **可变全局经模块属性读写**：`sdk.DLL_PATH`、`utils.VERBOSE`、`tui._ANSI_AVAILABLE`、`tui._getch`。禁止 `from x import 名字` 后再赋值（断共享）。`main.py` 的兼容层靠自定义模块类型动态转发，新增顶层可变全局需同步登记 `_LIVE_FORWARD`。
4. **协作取消**：停止/看门狗/关机只置位 `threading.Event`，由扫描循环周期性检查并抛 `ScanCancelledError`。**绝不硬杀线程**。
5. **文案集中**：用户可见文案走 `messages.py` 模板（`render_message`）；键位/帮助以 `keyrouter.KEY_BINDINGS` 为单一事实源，新增键位只改注册表。
6. **快照写入原子性**：临时文件 + `os.replace`；并发写用 `O_CREAT|O_EXCL` 锁文件；自动保存受四原子谓词与每日字节上限约束——改动 `snapshots.py` 时不要绕过这些护栏。
7. **对比引擎纯化**：`compare.py` 不做任何 UI/颜色，只产数据；表现层逻辑放 TUI/前端。
8. **前端无构建**：`web/static/js/app/` 是原生 ES Module，直接改源文件即可，没有打包步骤；新增模块在 `main.js` 装配链中注册时注意依赖顺序（壳级绑定 → router → 页面挂载 → 异步 init）。
9. **快照格式**：头部 `format` 版本（`SNAPSHOT_FORMAT_VERSION`）变更必须同步 `compare` 的版本校验与 `tests/test_snapshot_golden.py` 金样。
10. **legacy 阈值三处同值**：`compare._LEGACY_SIZE_THRESHOLD` / `snapshots._LEGACY_SIZE_THRESHOLD` / `scan.SIZE_UNKNOWN_MAX_BYTES` 必须保持一致（依赖方向不允许互 import，由测试强制）。
11. **使用偏好单一入口**（2026-09-13 新增）：界面「使用习惯」类持久化（默认视图、矩形图合并阈值、列表类型/排序、对比深度与隐藏零变化）一律走 `web/static/js/app/prefs.js` 的 `PREF_REGISTRY` + 单一 localStorage 文档 `pds_prefs_v1`，禁止新散键、禁止在页面里自行 `localStorage.setItem` 偏好。设置弹窗「使用偏好」区由注册表渲染（`prefGroups()`），不得硬编码偏好项。后端 `/api/settings` 白名单（`auto_save`/`last_roots`/`theme`）保持不变，UI 偏好**不进** `config.json`。
12. **盘符联动契约**（2026-09-13 修订，原 D15 废止）：存储概览卡盘符 chip 点击 = 切环形/图例 **且** 左侧视图区浏览该盘——与「浏览此盘」共用 `goBrowseRoot()` 单一收口（正向先落 `selectedRoot` 再 `browsePath`，反向 `pds:browse` 事件在 `root === selectedRoot` 时即时返回，不成环）。`tests/web/smoke.html` 的 **A14** 是该契约的断言面，改语义必须同步 A14。
13. **可视化优先纯函数**（2026-09-13 新增）：快照页日历等新增可视化，模型与 HTML 生成放 `components/*.js` 且**零 import 零 DOM 依赖**（如 `snapshot-view.js`：日历热力图 + 会话可见性判定），由 `node --test` 直接覆盖；页面模块只持有状态与事件委托。
14. **快照列表只展示「有内容」的会话 + 夹具隔离**（2026-09-13 第二/三轮）：会话在展示层分三组——`meaningful`（有内容且非夹具，唯一可见组）/ `empty`（全盘 skipped 或保存后 0 字节）/ `fixture`（全部保存根命中测试命名 `FIXTURE_ROOT_RE`，如 `C:\SDK1`）。后两组由 `components/snapshot-view.js` 的 `splitSessions` 过滤，列表头给「已隐藏 N 个空会话 · M 个测试会话 + 清理」；**后端契约不变**——`tests/test_stage_d.py` 明确「全盘 skipped 仍生成会话清单」（审计轨迹），不得改为后端不落盘。大小字段缺失按「有内容」保留；夹具判定只认明确测试命名，禁止用「路径不存在」这类猜测。
15. **设置弹窗分页**（2026-09-13 第二轮）：设置项分「常规 / 使用偏好 / 危险区」三分页（`#tab-*` / `#pane-*`，`.settings-body` 内滚、面板不整窗滚动）；新增设置项必须挂到某一分页，不得再往单页堆叠（原单页 1045px 高，768px 屏整窗滚动）。
16. **对比盘范围不变量**（2026-09-13 第三轮）：对比基准的**多选必须同盘**（`#compare-scope` 选定盘范围 → 基准列表只列该盘的各次保存；`enforceSameDrive()` 兜底丢弃跨盘选中项）。理由：一次保存会同时写多个盘，但对比与趋势以**盘**为单位，混选不同盘的不同时间点没有意义。基准下拉按**会话分组**（组头「时间 · 该次保存含 D: C:」）；夹具/空会话不进基准列表。改对比选择语义时必须同步 A18 与本节。
17. **测试产物绝不进真实数据目录**（2026-09-13 第三轮）：`scripts/dev/fixture_snapshots.mjs` 内置守卫——输出根落在 `%LOCALAPPDATA%\PythonDiskScanner` 内直接拒绝（`--allow-real-dir` 才可覆盖）；历史遗留的夹具会话已移入 `<数据目录>\_quarantine\`（不被 `session.list_sessions()` 扫描），禁止再把探针产物写回真实数据根。
18. **对比基准「两层选择」语义**（2026-09-13 第四轮，用户实测反馈定稿）：对比页 `state.baselines` = 用户在多选下拉里的**选中集**（决定折线看哪几次，也是跨路由重挂的记忆所在），`state.baseline` = 其中的**主对比基准**（决定下方摘要/表格与哪一份比，缺省 = 选中集里最新一份）。
    - **折线点选只改 `baseline`，绝不动选中集**——点一下折线不得把多选塌缩成单选（否则折线消失）；
    - ⚠️ **主基准的读取口径必须是 `#compare-baseline.dataset.base`（表单层显式值）或 state，绝不用 `sel.value`**：`<select multiple>` 的 `value` 恒等于「DOM 里第一个 selected 项」，多选下永远是最新一份（这正是「多选后下方对比恒跟最近一份比」的根因）；给多选赋 `value` 还会清掉其余选中项，改完必须按 state 重放镜像（`mirrorPicksToSelect`，幂等可重入）。收口在 `pages/compare.js` 的 `setPrimaryBaseline` / `primaryBaseline` / `mirrorPicksToSelect`；
    - 点选落地只在 `pages/compare.js` 的 `pickBaselineFromTrend()` 收口（命中判定是 `viz/line.js` 的纯函数 `pickIndex`，viz 层零业务语义）；换基准沿用既有语义：下钻根失效 + 结果缓存弃用 + 重跑 `/api/compare`；
    - 任何会重建基准选项/重算预填的路径（`rebuildBaselineOptions` / `ensurePrefill` / 会话晚到广播）都必须以选中集优先于「默认最近一份」，不得悄悄收敛选择集。
    - `tests/web/smoke.html` 的 **A22** 是该契约的断言面（断言 `dataset.base` + 选中集份数 + `data-active` + 重发请求的 baseline），改语义必须同步 A22 与 README「界面约定」。

## 4. 编码约定

- 用户可见输出（含报错提示）为**中文**；非 ASCII 输出前确保 `utils._reconfigure_std_streams()` 已生效（入口最早处调用）。
- Python 兼容 **3.9+**；CLI/TUI 路径仅标准库，第三方依赖只允许出现在 Web 形态。
- Windows 专有 API（msvcrt/winreg/ctypes）一律受保护导入（try/except ImportError），保持非 Windows 环境可 import。
- 测试命名 `tests/test_*.py`；仓库根不落地临时 `test_*.py` / 散置脚本（.gitignore 已拦截，开发探针放 `scripts/dev/`）。
- 开发工具纪律：`scripts/dev/` 只保留可复用工具（清单见 `scripts/dev/README.md`）；新写浏览器探针必须 import `_harness.mjs`；一次性核查脚本用完即归 `scripts/dev/archive/`。
- UI 问题排查：必须借助截图（`browser_screenshot`）多次确认定位，不凭猜测改样式。

## 5. 数据与产物位置

- 运行时数据：`%LOCALAPPDATA%\PythonDiskScanner\`（snapshots/exports/session 清单/config.json）——**不要**在项目目录生成这些数据；测试/夹具产物**绝不**写这里（见第 3 节第 17 条），历史遗留已隔离在 `<数据目录>\_quarantine\`（该子目录不被 session 扫描）。
- 截图、测试报告、核查资料等一次性产物**不入库**，用临时目录或系统 Temp。
- `docs/` 目录不入库（历史方案文档已清除）；设计决策以简短形式沉淀到本文件或 README。

## 6. 变更后必做（维护文档的硬约束）

每次提交更改前，agent 必须检查并按需更新：

1. **README.md**：新增/删除/改名模块、路由、脚本、配置项、环境变量、数据路径时，同步更新「代码地图」「API 概览」「测试」对应小节。
2. **AGENTS.md**：新增架构约束、依赖关系变化、新的共享全局、新的红线或编码约定时，登记到第 3/4 节；失效的约束要删除，不要留过期规则。
3. **`main.py` 兼容层**：新增被外部以 `main.<名字>` 使用的顶层 API 时，登记回导与（若为可变全局）`_LIVE_FORWARD`。
4. **`keyrouter.py` / `messages.py`**：新增键位或用户可见文案时，改注册表/模板而非业务代码。
5. 改动涉及测试边界（快照格式、API 契约、锁语义、阈值常量、UI 语义契约如 A14）时，同步更新对应 `tests/test_*.py` 或 `tests/web/smoke.html`。
6. **`tests/web/smoke.html` 的两条硬纪律**（2026-09-13 实测代价：一次性红 5 项、事后又红 2 项）：
   1. **会话夹具必须照抄后端真实载荷**——`session.py` 字段 **+ additive `total_by_root`**（`app.py` api_snapshots 补算）。漏掉它 → 会话被 `isMeaningfulSession` 判为「空」→ 快照页列表/日历/对比基准全空，A15/A17/A18/A20 连锁红；改后端会话载荷字段时必须同步 smoke 的 `SAMPLES.snapshotsList/snapshotsTrend`（旧注释曾写「无逐次总量字段」，已过期作废）。
   2. **断言前置要自己建立、失败要轮询不靠固定 `wait`**——跨断言共享的**使用偏好**（如矩形图合并阈值 `setMergeTop`）必须在用它的断言里显式复位；点击/浏览后的状态用 `__waitUntil` 轮询到目标态再断言（精确等值比较，不用 `indexOf`——旧文本同样命中）；`browsePath` 对同路径会短路不发请求，不能假设「这次一定发请求」。
   3. 另：用浏览器工具跑 smoke 时**不要重复打开页面**（重新 open 会打断正在跑的套件，出现 A3/A6/A8–A16/A20 的「壳未 boot」假红）；一次 open 等标题出结论即可。
7. **前端零构建但模板会缓存**：`web/templates/index.html` 改动需**重启** Flask（Jinja 非 debug 模式缓存编译模板；静态 JS/CSS 不缓存，改完刷新即可）。改动后跑：
   `python -m pytest tests -q --ignore=tests/archive_pre_p12`、`node --test scripts/dev/*.test.mjs`、必要时 `tests/web/smoke.html`（浏览器打开，标题出现 `[suite=v2][PASS n/n]` 即绿）。

## 7. 常用命令

```powershell
python -m pytest tests -q --ignore=tests/archive_pre_p12   # 后端测试（archive_pre_p12 引用已删除模块，不参与收集）
node --test scripts/dev/treemap.test.mjs scripts/dev/trend-window.test.mjs scripts/dev/motion-core.test.mjs scripts/dev/snapshot-view.test.mjs scripts/dev/prefs.test.mjs scripts/dev/line-pick.test.mjs   # 前端纯 JS 单测
python app.py                             # 本地 Web UI（改 index.html 后需重启）
python main.py C:\ -top 20 --export csv   # 非交互报告
node scripts/dev/fixture_snapshots.mjs    # 生成快照夹具（对比/趋势离线回归用）
powershell -File scripts\dev\destructive_acceptance.ps1 -WhatIf  # 破坏性流程验收（干跑）
```
