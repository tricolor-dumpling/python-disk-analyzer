# Python 磁盘分析工具（SpaceLens Pro）

基于 Everything SDK 的 Windows 本地磁盘空间分析工具，提供三种使用形态：

- **Web UI（主形态）**：Flask 本地单页应用（UI 2.0「SpaceLens Pro」），`python app.py` 启动，仅绑定 `127.0.0.1`，自动打开浏览器。
- **TUI**：终端交互界面（msvcrt 按键 + ANSI/VT 渲染）。
- **CLI**：非交互 Top-N 报告与 CSV/JSON 导出，便于脚本集成。

核心能力：毫秒级全盘扫描（Everything SDK）、目录占用浏览、快照保存/撤销、快照间/快照与当前对比（增量 Top-N、深度折叠、趋势折线）、一键清空数据目录。

## 运行环境

- Windows（依赖 Everything 与 `everything-SDK/dll/Everything64.dll|Everything32.dll`）
- Python 3.9+；CLI/TUI 仅标准库，Web 形态需 `pip install -r requirements.txt`（flask>=3.0.2）
- 数据目录：`%LOCALAPPDATA%\PythonDiskScanner\`（`snapshots/`、`exports/`、`config.json`、session 清单），可用 `--snapshot-dir` / `DSA_SNAPSHOT_DIR` / `DSA_NO_SNAPSHOT` 覆盖

## 快速开始

```powershell
pip install -r requirements.txt
python app.py            # Web UI（推荐）
python main.py           # TUI 交互模式
python main.py C:\ -top 20 -quiet          # 非交互 Top-N
python main.py C:\ --export csv            # 导出全部目录占用到 exports\
```

## 代码地图（快速定位）

### 后端（仓库根目录，扁平模块，Python）

| 文件 | 职责 |
|---|---|
| `main.py` | 程序入口与**兼容层**：把拆分到各模块的顶层名字全量导回 `main` 命名空间（`main.human_size` 等旧用法不受影响）；可变全局用自定义模块类型动态转发 |
| `app.py` | Flask Web 入口：单页 + 19 条 API 路由；打包（frozen）时 web 资源外置到 exe 同级 `web\` |
| `cli.py` | 命令行装配层：参数解析、交互/非交互分流、`--export/--output/--baseline/--no-snapshot`；启动最早处做 UTF-8 流重配置 |
| `tui.py` | 终端交互界面：msvcrt 按键、ANSI 渲染、状态栏/帮助/快照保存/历史对比模态、两级刷新 r/R |
| `scan.py` | Everything SDK 扫描主流程；惰性 contents；指纹轻刷/深刷；**全局扫描锁 `SCAN_LOCK` 唯一持有实体** |
| `fullscan.py` | 后台全量扫描调度：枚举盘符、逐根扫描、状态机（idle/queued/scanning/finishing）、看门狗（单盘 15 分钟无行更新→协作取消）、用户停止事件 |
| `sdk.py` | Everything SDK 封装与 Win32 常量；DLL 解析/加载/IPC 健康检查；`sdk.DLL_PATH` 跨模块共享可变全局 |
| `env.py` | 运行环境协调：config.json 读写、Everything.exe 定位（注册表）、进程会话判定、Job Object 防孤儿沙盒、启动与 IPC 等待 |
| `snapshots.py` | 快照持久化：gzip JSONL（首行头部带 CRC）、临时文件 + `os.replace` 原子替换、`O_EXCL` 锁文件互斥、四原子谓词自动保存、每日写字节上限、滚动保留 |
| `compare.py` | 纯对比引擎（无 UI）：快照间/快照与内存树 diff、`|delta|` 降序、`depth=N` 折叠、`drop_zero`、增速（≥1MiB 基数） |
| `session.py` | `session_*.json` 清单：一次保存 = C/D 各一份快照 + 一条清单；支撑 Web 历史列表与"撤销最近一次保存" |
| `datadir.py` | 数据根目录统一与一键清空（`wipe_data`）；只依赖标准库 |
| `messages.py` | 横幅文案模板资产：界面层只经 `render_message` 取文案 |
| `keyrouter.py` | 键位注册表 `KEY_BINDINGS` 单一事实源：按键分发与帮助文案同源生成 |
| `utils.py` | 通用工具：`human_size`、`log`/`VERBOSE`、UTF-8 流重配置、`_fatal` |
| `exceptions.py` | 公共异常（独立成模块避免循环导入） |

### 前端（`web/`，无构建步骤的原生 ES Module）

| 路径 | 职责 |
|---|---|
| `web/templates/index.html` | 单页骨架（含主题防闪烁内联脚本、内联 SVG favicon） |
| `web/static/css/tokens.css` / `style.css` | 设计令牌与样式 |
| `web/static/js/app/main.js` | 前端装配入口：壳级绑定 → router 初始化 → 工作台挂载 → 异步 init 链 |
| `web/static/js/app/router.js` `state.js` `api.js` `theme.js` | 路由 / 全局状态 / API 封装 / 三态主题（light\|dark\|system） |
| `web/static/js/app/prefs.js` | **使用偏好**（2026-09-13 新增）：白名单注册表 + 单一 localStorage 文档 `pds_prefs_v1`（默认视图/合并阈值/列表筛选排序/对比深度与隐藏零变化），读写统一清洗，设置弹窗「使用偏好」区由注册表驱动 |
| `web/static/js/app/pages/` | 三个页面：`workspace.js`（工作台）、`snapshots.js`、`compare.js` |
| `web/static/js/app/components/` | 组件：drives、scan、settings、modals、onboarding、palette-cmd、statusbar、topbar、toast、storage（存储概览卡）、snapshot-mini、**snapshot-view**（快照页纯函数：日历月历热力图 + 会话可见性判定，零依赖可单测）等 |
| `web/static/js/app/viz/` | 可视化：`treemap.js`（矩形图）、`donut.js`、`line.js`（趋势折线：坐标轴/读数/**点选命中判定**——点中的点 = 对比基准，2026-09-13 第四轮）、`relate.js` |

### 测试与开发脚本

| 路径 | 说明 |
|---|---|
| `tests/test_*.py` | 正式 pytest 用例（scan/compare/snapshots/tui/web/security/shutdown/stale_lock/undo 等） |
| `tests/archive_pre_p12/` | P12 之前的历史用例归档（非现行） |
| `tests/web/smoke.html` | 前端冒烟页（`?suite=v2`，标题 `[PASS n/n]` 即绿）。⚠️ **会话夹具必须照抄 `/api/snapshots` 真实载荷**：`session.py` 字段 **+ additive `total_by_root`**（`app.py` api_snapshots 为每个存过快照的盘补算该盘总量）。漏掉 `total_by_root` → `snapshot-view.js` 的 `sessionSavedBytes/isMeaningfulSession` 判定该会话「空」→ 整页列表/日历/对比基准全空，A15/A17/A18/A20 连锁变红（2026-09-13 实测踩过） |
| `scripts/dev/` | 可复用开发工具（用法见 `scripts/dev/README.md`）：`_harness.mjs` 浏览器探针统一入口、`fixture_snapshots.mjs` 快照夹具、`destructive_acceptance.ps1` 破坏性流程验收、6 个 `*.test.mjs` 纯 JS 单测（treemap / trend-window / motion-core / **snapshot-view** / **prefs** / **line-pick**）；历史一次性探针在 `scripts/dev/archive/` |
| `everything-SDK/dll/` | 运行时依赖的 Everything DLL（仅保留 32/64 两个 DLL） |
| `问题/问题清单.md` | 当前待办的用户实测问题清单（UI 问题需借助截图多次确认定位） |

## API 概览（app.py）

健康/概览：`GET /api/health`、`GET /api/overview`、`GET /api/roots`；浏览：`POST /api/browse`、`POST /api/open-path`；全量扫描：`POST /api/fullscan/start`、`GET /api/fullscan/status`、`POST /api/fullscan/stop`；快照：`POST /api/save`、`POST /api/save/undo`、`GET /api/snapshots`、`POST /api/snapshot/delete`、`GET /api/series`；对比：`POST /api/compare`、`GET /api/compare/status`；设置与导出：`GET|POST /api/settings`、`GET /api/export`；管理：`POST /api/admin/wipe`。

## 测试

```powershell
python -m pytest tests -q --ignore=tests/archive_pre_p12   # 后端（archive_pre_p12 引用已删除模块，不参与收集）
node --test scripts/dev/treemap.test.mjs scripts/dev/trend-window.test.mjs scripts/dev/motion-core.test.mjs scripts/dev/snapshot-view.test.mjs scripts/dev/prefs.test.mjs scripts/dev/line-pick.test.mjs
```

## 使用偏好（2026-09-13 新增）

界面选择里属于「使用习惯」的部分统一由 `web/static/js/app/prefs.js` 记录到本机
localStorage（单一文档 `pds_prefs_v1`，白名单注册表 `PREF_REGISTRY`），刷新/重开自动沿用，
设置弹窗「使用偏好」区可回显、修改与一键恢复默认（清空数据目录**不会**清掉这些偏好）。

| 已落地为偏好 | 键 | 默认 | 落点 |
|---|---|---|---|
| 默认视图 | `view.mode` | `treemap` | 工作台矩形图/排行/表格/关系 |
| 矩形图合并阈值 | `view.mergeTop` | `24` | 工作台工具栏 −/+ |
| 默认内容类型 | `list.kind` | `all` | 排行/表格筛选 |
| 默认排序 | `list.sort` | `size-desc` | 排行/表格排序 |
| 默认对比深度 | `compare.depth` | `""`（叶子） | 空间对比页 |
| 默认隐藏零变化 | `compare.hideZero` | `true` | 空间对比页 |

既有持久项（保持不变）：后端 `config.json` 的 `auto_save`/`last_roots`/`theme`（`GET|POST /api/settings`）、
localStorage 散键 `pds_theme_v1`（主题三态）、`pds_selected_drives_v1`（引导选盘）、`pds_last_browse_v1`（上次浏览位置）。

**可做设置但本次刻意未落地**（需单独设计，不做半成品）：快照保留上限/滚动清理条数（与
`snapshots.py` 四原子谓词 + 每日字节上限强耦合，属数据安全策略）、自动保存触发条件（后端语义，
与「问题 1：一次会话多次扫描」未决项绑定）、默认对比快照路径（快照会被删除，持久化路径易失效误导）、
快照页筛选条件（属临时视图状态，保留反而像「列表丢了数据」）、数据目录/`everything_*`（安全红线：禁止网页写入）。

## 界面约定（2026-09-13 实测后固定）

- **设置弹窗**分三分页「常规 / 使用偏好 / 危险区」（`#tab-*` + `#pane-*`；`←/→` 可切，活动分页本次会话内记忆）。
  面板固定高度、只有内容区滚动——原单页内容 1045px，768px 高的屏幕会让整个弹窗（含标题与底部按钮）一起滚。
- **快照页**左右两栏：左栏 = 快照日历（月历热力图，点日期筛选列表）+ **最近快照**快捷列表
  （填满左栏、点击同样按日筛选）；右列 = 筛选条 + 会话列表（`flex:1`，占满剩余高度；窄屏 <900px 上下堆叠）。
- **快照列表只显示「有内容且非夹具」的会话**：全盘跳过（自动保存被谓词拒绝）、保存后 0 字节、
  以及测试/夹具会话（根名如 `C:\SDK1`，见 `FIXTURE_ROOT_RE`）都不显示；列表头给
  「已隐藏 N 个空会话 · M 个测试会话 + 清理」。判定见 `components/snapshot-view.js`。
- **对比页以「盘」为范围**（`#compare-scope`）：一次保存会同时写入各盘快照，但对比与趋势的单位是**盘**——
  基准列表只列当前盘的各次保存（按会话分组，组头写明「该次保存含 D: C:」），因此**多选恒为同一盘的不同时间点**，
  不会再出现「C 盘某次 + D 盘另一次」的混选。
- **折线读数**（对比页多快照趋势）按读数实际宽度做边界夹取，最左/最右数据点都不越出卡片与视口。
- **对比页折线点选 = 选对比基准**（2026-09-13 第四轮，用户实测反馈）：对比页的「对比基准」多选有两个层次——
  ① 在基准下拉里勾选 = 决定**折线看哪几次**（`state.baselines`，跨路由往返的记忆）；
  ② **点折线上的某个数据点 = 决定「与哪一份比」**（`state.baseline`，下方摘要/表格立即按那份快照重算，
  折线**保留全部已选**、不塌缩成单选）。折线上用「基准环 + 实心点」（`.line-dot.is-active` +
  `#compare-trend-host[data-active]`）标出当前基准，「趋势」副行与页头「已选 N 份」提示给出
  「正与 <时间> 比」回执；未点选时基准 = 选中集里最新一份（与修复前一致）。图上空处点击不命中任何点，
  不会误改基准（命中半径 28px，见 `viz/line.js` 的 `pickIndex`）。
  - ⚠️ **主对比基准的读取口径是 `#compare-baseline.dataset.base`**（表单层显式值）——`<select multiple>`
    的 `value` 恒等于「DOM 里第一个 selected 项」，多选时永远是最新一份；修复前正是从 `sel.value`
    推断基准，才导致「多选后下方对比恒跟最近一份比，点选形同无效」。改这块前先读
    `pages/compare.js` 的「主对比基准单一收口」注记（`setPrimaryBaseline` / `primaryBaseline` /
    `mirrorPicksToSelect`）。

## 数据目录与测试产物隔离

- 真实数据：`%LOCALAPPDATA%\PythonDiskScanner\`（session 清单在根目录，快照在 `snapshots\`）。
- 历史遗留的测试/夹具会话已移出到 `%LOCALAPPDATA%\PythonDiskScanner\_quarantine\fixtures_20260913\`
  （29 个文件：24 份 `session_*.json` + 5 份 `SDK*.snap.gz`）；该子目录不被 `session.list_sessions()` 扫描，
  需要时可整体删除或人工检视。
- `scripts/dev/fixture_snapshots.mjs` 现在**拒绝**把夹具写进真实数据目录（要覆盖须显式 `--allow-real-dir`）。

## 架构红线（改动前必读，详见 AGENTS.md）

1. **扫描锁单例**：所有触碰 Everything SDK 的路径（主扫描/轻刷/深刷/指纹/健康探测/Web 前台浏览）必须经过 `scan.SCAN_LOCK`（`fullscan.GLOBAL_SCAN_LOCK` 为其别名），防止并发调用 DLL 重入。
2. **依赖方向无环**：`cli → env/scan/tui/utils/exceptions`；`tui → utils/exceptions/sdk/keyrouter/messages/scan/snapshots/compare`；`scan → utils/sdk`；`snapshots → datadir`；`datadir`/`exceptions`/`utils` 不依赖项目内模块。禁止反向 import。
3. **跨模块可变全局**（`sdk.DLL_PATH`、`utils.VERBOSE`、`tui._ANSI_AVAILABLE`、`tui._getch`）必须通过模块属性读写（`import sdk; sdk.DLL_PATH = ...`），禁止 `from x import` 后赋值（会断掉共享）。`main.py` 用自定义模块类型动态转发这些名字。
4. **文案不出现在业务代码**：横幅/错误文案统一走 `messages.render_message`；键位与帮助文案以 `keyrouter.KEY_BINDINGS` 为单一事实源。
5. **协作取消，绝不硬杀线程**：停止/看门狗只置位 Event，由扫描主循环每 `SCAN_PROGRESS_REFRESH_INTERVAL` 条检查，抛 `ScanCancelledError` 消化。
