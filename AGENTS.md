# AGENTS.md — 项目级 Agent 工作约束

本文件约束在本仓库中工作的 AI agent。**改动代码前必读**；做出任何更改后，必须同步检查并更新本文件与
`README.md`（见第 7 节）。文件职责与 API 的单一事实源在 `README.md`（操作手册见 `docs/开发规范.md`，
迭代记录追加到 `docs/CHANGELOG.md`），本文件只写**约束与纪律**。

## 1. 项目形态速览

Windows 本地磁盘分析工具，三种形态共用同一套后端模块：

- Web UI（主形态）：`app.py`（Flask，仅 `127.0.0.1:5000`，默认自动开浏览器）
- TUI：`main.py` 无参数进入
- CLI：`main.py <TARGET> [--top/--quiet/--export/--baseline/...]`

定位文件先查 `README.md` 的「代码地图（文件职责总表）」，不要盲目全文搜索。

## 2. 环境红线（本机 Windows）

- 本机 PowerShell 为 **5.1 Desktop**：无 `&&`/`||`、无三元/空合并语法；每次 `pwsh` 调用都是全新进程，不保留 cwd/变量。
- `npm`/`pnpm`/`npx` 不在 PATH 上；本机**无 Chrome**（有 Edge）。浏览器自动化一律用 DSH 的 `browser_*` 工具，
  **不要**从 pwsh 启动无头浏览器。
- 运行/测试入口：`.venv` 在项目根；`.venv\Scripts\python.exe -m pytest tests -q` 跑后端（362 项）。
  前端纯 JS 单测正常环境用 `node --test scripts/dev/`（86 项）；**在 DSH 沙盒里多进程隔离会假红**
  （`test at scripts\dev:1:1 'test failed'`），改用单进程模式：
  `node --test-isolation=none --test "scripts/dev/*.test.mjs"`。
- DSH 文件沙盒在本工作区可能无法授予写权限（`SetNamedSecurityInfoW ... Win32 5`）：**以工作区目录作为
  `workdir` 的 pwsh 调用会直接失败**，改用工作区外目录作 `workdir`（如 `C:\Users\Laptop`），
  在命令内 `Set-Location 'D:\deepseek\python-disk-analyzer'`；`read`/`write`/`edit`/`glob`/`grep` 工具不受影响。

## 3. 架构红线（违反即返工）

1. **扫描锁单例**：一切触碰 Everything SDK 的调用（主扫描/轻刷/深刷/指纹探测/健康探测/前台浏览）必须经过
   `scan.SCAN_LOCK`（`fullscan.GLOBAL_SCAN_LOCK` 是同一把锁的别名）。新增 DLL 调用路径前先确认走锁。
2. **依赖方向无环**：`datadir`/`exceptions`/`utils` 为叶子（不 import 项目内模块）；`sdk → utils`；
   `scan → utils/sdk/exceptions`；`snapshots → datadir`；`session → datadir`（不反向依赖 snapshots）；
   `compare → snapshots/utils`；`env → utils/exceptions/sdk`；`fullscan → scan/utils`；
   `tui/cli/app` 在其上。**禁止反向 import**。
3. **可变全局经模块属性读写**：`sdk.DLL_PATH`、`utils.VERBOSE`、`tui._ANSI_AVAILABLE`、`tui._getch`、`env._GLOBAL_JOB_HANDLE`。
   禁止 `from x import 名字` 后再赋值（会断掉共享）。`main.py` 的兼容层靠 `_LIVE_FORWARD`（13 项）动态转发，
   **新增被外部以 `main.<名字>` 使用的顶层可变全局/补丁敏感函数时，必须登记进 `_LIVE_FORWARD`**。
4. **协作取消**：停止/看门狗只置位 `threading.Event`（`fullscan.CANCEL_EVENT`/`USER_STOP_EVENT`），
   由扫描循环周期性检查并抛 `ScanCancelledError`。**绝不硬杀线程**（看门狗：单盘 15 分钟无行更新）。
5. **文案集中**：用户可见文案走 `messages.render_message`（模板资产在 `messages.BANNER_TEMPLATES`）；
   键位与帮助以 `keyrouter.KEY_BINDINGS` 为单一事实源，新增键位只改注册表。界面文案映射集中在 `labels.js`。
6. **快照写入原子性与配额**：临时文件 + `os.replace`；并发写用 `O_CREAT|O_EXCL` 锁文件
   （`STALE_LOCK_TTL_SECONDS=600` 判陈旧）；自动保存受 `snapshots.should_auto_save` 四原子谓词
   与 `MAX_BYTES_PER_DAY`（102.4 MiB）日配额约束——改 `snapshots.py` 时**不要绕过这些护栏**。
7. **对比引擎纯化**：`compare.py` 不做任何 UI/颜色，只产数据；表现层（着色/横幅/版式）放 TUI/前端。
8. **前端无构建**：`web/static/js/app/` 是原生 ES Module，直接改源文件，无打包步骤。新增模块须在
   `main.js` 装配链中登记（壳级绑定 → router → 页面挂载 → 异步 init）。
9. **快照格式**：`SNAPSHOT_FORMAT_VERSION` 变更必须同步 `compare` 的版本校验与
   `tests/test_snapshot_golden.py` 金样。
10. **legacy 阈值三处同值**：`compare._LEGACY_SIZE_THRESHOLD` / `snapshots._LEGACY_SIZE_THRESHOLD` /
    `scan.SIZE_UNKNOWN_MAX_BYTES` 必须保持一致（均为 `16 * 1024 ** 4` = 16 TiB）。依赖方向不允许互 import，由测试强制。
11. **使用偏好单一入口**：界面「使用习惯」类持久化一律走 `web/static/js/app/prefs.js` 的 `PREF_REGISTRY`
    + 单一 localStorage 文档 `pds_prefs_v1`；**禁止新散键、禁止在页面里自行 `localStorage.setItem` 偏好**。
    设置弹窗「使用偏好」区由注册表渲染。后端 `/api/settings` 白名单（`auto_save`/`last_roots`/`theme`）保持不变，
    UI 偏好**不进** `config.json`。
12. **盘符联动契约**：存储概览卡盘符 chip 点击 = 切环形/图例**且**左侧视图区浏览该盘，与「浏览此盘」共用
    `goBrowseRoot()` 单一收口（正向先落 `selectedRoot` 再 `browsePath`，反向 `pds:browse` 事件在
    `root === selectedRoot` 时即时返回，不成环）。`tests/web/smoke.html` 的 **A14** 是该契约的断言面。
13. **可视化优先纯函数**：快照日历等可视化，模型与 HTML 生成放 `components/*.js` 且**零 import 零 DOM 依赖**
    （如 `snapshot-view.js`），由 `node --test` 直接覆盖；页面模块只持有状态与事件委托。
14. **快照列表只展示「有内容且非夹具」的会话 + 夹具隔离**：会话在展示层分三组——`meaningful`（有内容且非夹具，
    唯一可见组）/ `empty`（全盘 skipped 或 0 字节）/ `fixture`（保存根全部命中 `FIXTURE_ROOT_RE`，如 `C:\SDK1`），
    由 `components/snapshot-view.js` 的 `splitSessions` 过滤。**后端契约不变**——`tests/test_stage_d.py`
    明确「全盘 skipped 仍生成会话清单」（审计轨迹），不得改为后端不落盘。大小字段缺失按「有内容」保留。
15. **设置弹窗分页**：设置项分「常规 / 使用偏好 / 危险区」三分页（`#tab-*` / `#pane-*`，`.settings-body` 内滚、
    面板不整窗滚动）；**新增设置项必须挂到某一分页**，不得再往单页堆叠。
16. **对比盘范围不变量**：对比基准的**多选必须同盘**（`#compare-scope` 选定盘范围 → 基准列表只列该盘的各次保存；
    跨盘选中项由 `enforceSameDrive()` 兜底丢弃）。理由：一次保存会同时写多个盘，但对比与趋势以**盘**为单位。
17. **测试产物绝不进真实数据目录**：`scripts/dev/fixture_snapshots.mjs` 内置守卫——输出根落在
    `%LOCALAPPDATA%\PythonDiskScanner` 内直接拒绝（`--allow-real-dir` 才可覆盖）；历史遗留夹具已移入
    `<数据目录>\_quarantine\`（不被 `session.list_sessions()` 扫描）。禁止再把探针产物写回真实数据根。
18. **对比基准「两层选择」语义**：`state.baselines` = 用户在多选下拉里的**选中集**（决定折线看哪几次，也是跨路由
    重挂的记忆所在），`state.baseline` = 其中的**主对比基准**（决定下方摘要/表格与哪一份比，缺省 = 选中集里最新一份）。
    - **折线点选只改 `baseline`，绝不动选中集**——点一下折线不得把多选塌缩成单选（否则折线消失）；
    - ⚠️ **主基准的读取口径必须是 `#compare-baseline.dataset.base`（表单层显式值）或 state，绝不用 `sel.value`**
      （`<select multiple>` 的 `value` 恒等于 DOM 里第一个 selected 项）；
    - 点选落地只在 `pages/compare.js` 的 `pickBaselineFromTrend()` 收口（命中判定是 `viz/line.js` 的纯函数
      `pickIndex`，半径 `PICK_RADIUS_PX=28`）；任何重建基准选项的路径都不得悄悄收敛选择集。
    - `tests/web/smoke.html` 的 **A22** 是该契约的断言面（断言 `dataset.base` + 选中集份数 + `data-active` + 重发请求的 baseline）。
19. **文档同步由测试强制**（2026-09-28 新增）：`README.md` 的「文件职责总表」是唯一文件级事实源，
    `tests/test_docs_sync.py` 双向比对磁盘文件——**新增/删除/改名任何文件都必须同步该表**，
    否则 pytest 变红（`<!-- FILEMAP:BEGIN -->` / `<!-- FILEMAP:END -->` 之间为机读区段，结构变更须同步改该测试）。

## 4. 编码约定

- 用户可见输出（含报错提示）为**中文**；非 ASCII 输出前确保 `utils._reconfigure_std_streams()` 已生效（入口最早处调用）。
- Python 兼容 **3.9+**；CLI/TUI 路径仅标准库，第三方依赖只允许出现在 Web 形态（`flask`）。
- Windows 专有 API（msvcrt/winreg/ctypes）一律受保护导入（try/except ImportError），保持非 Windows 环境可 import。
- 测试命名 `tests/test_*.py`；仓库根不落地临时 `test_*.py` / 散置脚本（`.gitignore` 已拦截，开发探针放 `scripts/dev/`）。
- 开发工具纪律：`scripts/dev/` 只保留可复用工具（清单见 `scripts/dev/README.md`，≤10 个文件）；
  新写浏览器探针**必须** import `_harness.mjs`；**一次性核查脚本用完即删**（考古走 git 历史）。
- UI 问题排查**必须借助截图**（`browser_screenshot`）多次确认定位，不凭猜测改样式。

## 5. Git 分支与提交规范

完整规范见 `README.md`「Git 分支规范」，此处只列要点：

- `main` 是唯一长期分支，任何提交都应能直接跑起来；短期分支用 `feature/`、`fix/`、`docs/`、`refactor/`、
  `release/vX.Y.Z`、`hotfix/vX.Y.Z`，**一个分支一件事，合并后即删**。
- **已废止** `stage-*` 与 `ui*` 分支：历史于 **2026-09-28** 压缩为单一根提交（旧 224 条提交、14 个 tag、
  10 个分支已从本地删除），阶段性工作改用 `feature/<主题>`。
- 提交信息用中文，首行 ≤ 50 字写「做了什么」，正文写「为什么 + 怎么验证」。
- ⚠️ **当前本地 `main` 与 `origin/main` 已分叉**（远端仍是压缩前历史）：直接 `git push` 会被拒绝；
  要么 `git push --force origin main` 对齐，要么另建分支推送。这是**预期状态**，不要当成故障去「修」。

## 6. 数据与产物位置

- 运行时数据：`%LOCALAPPDATA%\PythonDiskScanner\`（`snapshots/`、`exports/`、session 清单、`config.json`）
  ——**不要**在项目目录生成这些数据。
- 快照目录可用 `--snapshot-dir` / `DSA_SNAPSHOT_DIR` 覆盖；`DSA_NO_SNAPSHOT` 禁用一切快照落盘（禁用时
  自动保存必须一并失效，见 `tests/test_stage_p1.py` 红线）。
- 截图、测试报告、核查资料等一次性产物**不入库**：统一放仓库根的 **`tmp/`**（整个目录被 `.gitignore`
  忽略，仅 `tmp/README.md` 说明入库），可随时 `Remove-Item -Recurse -Force tmp\*` 整体清理；
  也可用系统 Temp。**不要**散落在仓库根目录（根目录散文件是历史主要噪声源）。
- 落点分工：**可复用**开发工具/前端单测 → `scripts/dev/`（≤10 个文件）；一次性脚本/日志/截图/草稿 → `tmp/`；
  测试夹具 → `%TEMP%\pds_fixture_snapshots_<ts>`；要长期保留的文档 → `docs/`。
- **文档体系**（新增文档前先读 `docs/README.md` —— 那里是唯一索引 + 管理规范）：
  `README.md` = 事实源（文件职责、API、界面契约）；`AGENTS.md` = 约束与纪律（红线、编码约定、流程要点）；
  `docs/开发规范.md` = 操作手册（分支作用、标准流程、文档同步清单、提交格式）；
  `docs/API 契约.md` = 契约参考（**权威在 `tests/test_api_contract.py`**）；
  `docs/排查手册.md` = 症状→处置；`docs/CHANGELOG.md` = 每次开发完成的变更记录。
  三份主文档只允许**互相引用**，不得各自维护会漂移的副本；
  **新增/删除/改名任何文档都要同步 `docs/README.md` 第 1 节清单**；历史方案文档已清除，考古走 `git log`。

## 7. 变更后必做（文档同步硬约束）

每次提交更改前，agent 必须逐项检查：

1. **`README.md`**：新增/删除/改名任何文件 → 更新「代码地图（文件职责总表）」；路由/API 变更 → 「API 概览」；
   脚本、配置项、环境变量、数据路径变更 → 对应小节。
2. **`AGENTS.md`**：新增架构约束、依赖关系变化、新的共享全局、新的红线或编码约定时登记到第 3/4 节；
   **失效的约束要删除，不要留过期规则**。
3. **`main.py` 兼容层**：新增被外部以 `main.<名字>` 使用的顶层 API 时，登记回导与（若为可变全局）`_LIVE_FORWARD`。
4. **`keyrouter.py` / `messages.py`**：新增键位或用户可见文案时，改注册表/模板而非业务代码。
5. **测试边界**：改动涉及快照格式、API 契约、锁语义、阈值常量、UI 语义契约（如 A14/A22）时，
   同步更新对应 `tests/test_*.py` 或 `tests/web/smoke.html`。
6. **`tests/web/smoke.html` 三条硬纪律**（历史实测代价）：
   1. **会话夹具必须照抄后端真实载荷**——`session.py` 字段 **+ additive `total_by_root`**：漏掉它 → 会话被
      `isMeaningfulSession` 判为「空」→ 快照页列表/日历/对比基准全空，A15/A17/A18/A20 连锁红；
   2. **断言前置要自己建立、失败要轮询不靠固定 `wait`**——跨断言共享的使用偏好（如 `setMergeTop`）必须在用它的
      断言里显式复位；点击/浏览后的状态用 `__waitUntil` 轮询到目标态再断言（精确等值比较，不用 `indexOf`）；
      `browsePath` 对同路径会短路不发请求，不能假设「这次一定发请求」；
   3. **用浏览器工具跑 smoke 时不要重复打开页面**（重新 open 会打断正在跑的套件，出现「壳未 boot」假红）；
      一次 open 等标题出结论即可。
7. **前端零构建但模板会缓存**：`web/templates/index.html` 改动需**重启** Flask（Jinja 非 debug 模式缓存编译模板；
   静态 JS/CSS 不缓存，改完刷新即可）。
8. **`docs/CHANGELOG.md`**：**每次开发完成**（合并回 `main` 前）追加一条记录——
   变更 / 文件 / 验证 / 文档 / 遗留，五项齐全（模板见该文件开头）。
9. **`docs/README.md`**：新增/删除/改名任何**文档**、或立了新坑 → 同步第 1 节清单与「文档欠账」；
   临时产物一律进 `tmp/`（已忽略），不要留在仓库根。
10. **验收命令**（提交前全跑，见第 9 节）；其中 `tests/test_docs_sync.py` 专门盯第 1 条的落地。

## 8. 发版流程

1. **版本号唯一落点** = `web/templates/index.html` 状态栏 `.statusbar-left`（形如 `v2.1.1 · R1 视觉版`）；
   发版前改它并单独提交。
2. 打 **annotated tag**（`git tag -a vX.Y.Z -F <说明文件>`），`git push origin main` + `git push origin vX.Y.Z`。
3. Release 与资产上传走 GitHub REST API（本机**没有 `gh` CLI**）：
   - 令牌取法：`git credential fill`（`protocol=https` / `host=github.com`）→ 读 `password=`；
     **令牌只走管道/变量，禁止写进任何文件或提交**；
   - 建 Release：`POST /repos/<owner>/<repo>/releases`（`tag_name`/`target_commitish`/`name`/`body`）；
   - 传资产：`POST https://uploads.github.com/repos/<owner>/<repo>/releases/<id>/assets?name=<file>`。
4. **发布包结构**：顶层单目录 `python-disk-analyzer-X.Y.Z/`，内含全部根 `*.py` + `web/` +
   `everything-SDK/dll/` + `requirements.txt` + `README.md`（解压后 `pip install -r requirements.txt` →
   `python app.py` 可直接跑），排除 `__pycache__`/`.pyc`。Windows 自带 tar **不支持 `--transform`**：
   先 `Copy-Item` 到临时暂存目录，再 `tar -a -c -f out.zip -C <stageRoot> <dirname>`。
   ⚠️ 历史打包脚本 `scripts/build_min.ps1` **已不在仓库**，需要自动化打包时须重建该脚本。
5. **发完必做外部校验**：匿名 `HEAD` 资产下载 URL（应 200 且 `Content-Length` 与本地一致）+
   `GET /releases/latest` 核对 `assets[].state=uploaded`；并在临时目录解压包跑一次
   `python -c "import main, cli, compare, snapshots"` 与 `python main.py --help` 确认包自洽。
   临时产物（暂存目录、校验目录、令牌文件）用完即删。

## 9. 常用命令

```powershell
python -m pytest tests -q                                  # 后端全量（含文档同步契约）
node --test scripts/dev/                                   # 前端纯 JS 单测
python app.py                                              # 本地 Web UI（改 index.html 后需重启）
python main.py                                             # TUI
python main.py C:\ -top 20 --export csv                     # 非交互报告 + 导出
node scripts/dev/fixture_snapshots.mjs                     # 生成快照夹具（对比/趋势离线回归）
powershell -File scripts\dev\destructive_acceptance.ps1 -WhatIf   # 破坏性流程验收（干跑）
```

浏览器冒烟：打开 `tests/web/smoke.html`，标题出现 `[suite=v2][PASS 23/23]` 即绿。
