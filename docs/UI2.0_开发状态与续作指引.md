# UI 2.0 开发状态与续作指引

更新时间：2026-08-26（U2.0 完成会话修订，用于换机续作）

## 当前状态

- **分支**：`ui2.0`（已推送 GitHub origin，换机后 `git checkout ui2.0` 即可续作）；`main` 未动，仍是 P12 归档完成线。
- **提交链**：`5ec0061`(P12 尾) → `df01038`(U1.0) → `62281ab`(U1.1 实现) → `25faea2`(U1.1 验收记录) → `3d0e736`(换机交接文档) → `5466bde`(U1.2) → `83ebadd`(U1.2 顺手修复) → `b06c3ab`(U1.3) →（本次：U2.0 模块化）。
- **进度**：U1.0-U1.3、**U2.0 全部完成**（实现 + 验收 ①-③）；**下一步 = U2.1（hash 路由与三页面装配）**。
- 验收用 Flask(5000)/静态服务(8771) 已停止；工作区仅 `.venv/`、`dsh-image-gen/`、未跟踪《定稿》三个已知未跟踪项；`docs/UI终版方案…定稿.md` 未入库。

## 本次会话完成内容：U2.0 app.js 模块化拆分（行为等价重构）

验收口径与结果（详细记录在《docs/UI2.0_开发执行手册.md》头部 U2.0 执行记录）：

| 项 | 结果 | 证据 |
|---|---|---|
| 模块化落地 | ✅ | 旧 app.js 1502 行 → 18 个新模块 1581 行（api/icons/state/theme/labels + components×9 + pages×3 + main）+ app.js 空壳注释；index.html 改 `<script type="module" src="js/app/main.js">`；renderComposition 与 browse-chart 按映射表 D12 物理删除 |
| 行为等价（main） | legacy **7/7** ✅ | 旧 v1 断言在 module 化 app 上全过 |
| 行为等价（十二项机制） | v2-A4~A10 移植全绿 ✅ | A4/A5 文件行零请求/目录行恰一请求、A6 筛选空态、A7 弹窗栈、A8 busy 徽章、A9/A10 浏览竞态 |
| ① Network 前后对照 | **API 序列完全一致** ✅ | `settings→snapshots→fullscan/status→overview→health→POST browse`（前后同）；探针 `scripts/dev/u20_network_probe.mjs`（before/after json 已存） |
| ② Console 零报错 | ✅ | 四视口探针 errs=[] + 真实页 errs=[] |
| ③ §3.6 十二项逐条 | ✅ | 见手册执行记录（smoke 覆盖 9 项 + 代码评审 3 项） |
| **视觉等价（像素级）** | ✅ | 四视口截图与 U1.3 基线（b06c3ab worktree 同探针）**SHA256 逐字节一致**（819827bc/97a76cbb/7ded2bc5/6dcbe143） |
| smoke v2 / unittest / hex / node | 11/12（A3 占位）/ **259+1 已知挂账** / 0 / 9/9 | P13 竞态本轮进入**连续失败段**（既有挂账，未触碰 snapshots.py） |

**验收工具（已入库）**：`scripts/dev/u20_network_probe.mjs`（前后对照）；`u13_viewport_probe.mjs`（+`--base`/`--out` 参数化，可指向任意版本做像素级对照——**对比方法：git worktree add 目标版本 → 该目录起 Flask → 同探针同参 → Get-FileHash 比对**，曾因此法证明 U2.0 与 U1.3 四视口逐字节一致）。

**本次实施注记（下一会话须知）**：
1. **smoke 双脚本结构（硬纪律）**：传输层打桩必须是**经典脚本**（解析期执行，先于一切 module 求值）；`main.js` 在模块求值时即 `start()` 自启动——若 stub 与断言同在一个 module，stub 安装晚于 app 启动（实测踩坑：A0 首红，修复后 legacy/v2 全绿）。后续往 smoke 加东西，依然遵循「经典 stub 先行 → module 断言」。
2. **跨模块可变状态一律经访问器**：workspace（setCurrentRoot/getCurrentRoot/getCurrentPath/getLastRoots/applyLastRoots/resetBrowseHistory）、snapshots（get/setSessionsCache）、scan（setAutoSaveSetting/resetHandledScanVersion）、settings（setDataDir）。ES Module 的 import 绑定只读，跨模块赋值必须走导出 setter。
3. **依赖图无环**：renderApiError→feedback.js、SKIP_REASON_TEXT→labels.js 两个共享叶子是防环关键；pds:state 事件机制未启用（无环时直接导入），U2.1 跨页联动时再启用。
4. **Flask 模板缓存**：`debug=False` 下改 index.html 必须**重启 Flask**（本次重演了 PID 31404 式旧模板事故，重启即解）。
5. **本机 /api/health 时延抖动**（Everything DLL 探测偶发秒级）：网络探针用「等到 browse 或 15s」锚点，勿用固定等待窗。
6. app.js 空壳留到 U4.3 删除；smoke 的 legacy 注册表留到 U2.5 退役。

## 本次会话完成内容：U1.3 App Shell 骨架与门禁切换（上一会话记录，保留）

验收口径与结果（详细记录在《docs/UI2.0_开发执行手册.md》头部 U1.3 执行记录）：

| 项 | 结果 | 证据 |
|---|---|---|
| ① 两档窗口零滚动（1366×768 / 1920×1080） | ✅ | 探针实测 `scrollHeight==clientHeight`（768/768、1080/1080）、`body overflow:hidden`、顶栏 60/状态栏 32；首启引导态与常态两轮均成立；800×700 窄屏恢复纵向滚动（声明例外 ✓） |
| ② legacy 全绿证明行为未变 | 7/7 ✅ | `?suite=legacy`（v1 注册表，U2.5 退役） |
| ③ hex 色值门禁 | 51 → **0** ✅ | style.css 全量 token 化（只减不增；暗色适配统一 token 化） |
| ④ 旧功能手工走查（真实页） | ✅ | 本机 Everything 就绪 + 真实 55 目录数据：设置弹窗/主题 VT 暗色/密度/表格视图/下钻（D:\→D:\虚拟机 8 子目录）/筛选/对比发起与「跨盘拒绝」/快照卡/徽章——全部正常，console/pageerror 0 |
| smoke 默认 suite | v2 = **4/5** ✅ | 默认即 v2（A0/A1/A2/A11 绿；A3 占位待 U2.1 接入，非失败项） |
| unittest | 260 OK ✅ | `-W error::ResourceWarning` 全绿 |

**验收工具（已入库，可复用）**：
- `scripts/dev/u13_viewport_probe.mjs`：真实页 + fetch 桩 + 四视口（1366×768 亮/1920×1080/1366×768 暗/800×700）零滚动指标与截图；`--steady` 用常态（收起首启引导）；依赖本机 `.dsh/profiles/web/node_modules/playwright`（仅本机验收，与项目零前端依赖纪律无关）。
- U1.2/U1.1 探针（`u12_acc_probe.user.js`、`u11_acc_probe.user.js`、`u11_scroll_probe.user.js`）依旧可复用。

**本次实施注记（下一会话须知）**：
1. **browse-chart 容器未物理删除**（D12 视觉语义已达成：`#browse-chart{display:none!important}`）：`renderComposition()` 无空守卫（app.js:469-476），删容器 + app.js 零改动 = legacy 全红。物理删除与 renderComposition 一并归 **U2.0 模块化迁移**（§3.1 映射表既定）。
2. **tokens.css 现含 U1.2 时长 token ×6 + U1.3 迁移色值组**（亮 18 hex + 暗 4 hex + rgba 项），style.css hex = **0**；非色值度量变量（--fs-*/--radius-*/--space-*）留在 style.css 本地 :root，U4.3 收口。
3. **占位隐藏坑**：`display` 规则会覆盖 `[hidden]`（作者样式 > UA 样式）——`.nav-tabs` 因此泄漏过一次，已用 `.nav-tabs[hidden]{display:none!important}` 修复；后续新增暂藏元素（如 U2.x 的空槽位）必须同样显式处理。
4. **smoke 门禁新口径**：默认 = v2（4/5，A3 待接）；`?suite=legacy` = v1 断言（7/7）；smoke 脚手架自身已按单屏组织（作者样式紧凑 + body 零滚动，供 A2 度量）；`?suite=v1/v2` 仍兼容。
5. 新增 DOM 槽位：`.nav-tabs`（hidden，U2.1 接线）、`.view-toolbar`（U2.3 扩展 阈值/全屏）、`.strip-slot`（N09 迷你条带，U2.3 装配）、`.palette-slot`（N02 命令面板，U3.1 装配）；对比卡暂留右栏（U3.4 迁 `#/compare`，主页仅留「最近对比」入口）。
6. 右栏现为 3+1 卡，768 高下右栏有面板内滚（§3.4 允许）；U3.4 迁走对比卡后余量增大，U2.4 环形图卡接替概览卡。

## 本次会话完成内容：U1.2 motion 动效工具库（上一会话记录，保留）

验收口径与结果（详细记录在《docs/UI2.0_开发执行手册.md》头部 U1.2 执行记录）：

| 项 | 结果 | 证据 |
|---|---|---|
| ① node 测试 | 9/9 ✅ | `node --test-isolation=none --test "scripts/dev/*.test.mjs"`（沙箱等价变体；手册 8 用例 + easeSpring 镜像 1 例；`fnv1a("a")=0xE40C292C` 公开参考值锚点） |
| ② console 手动 countUp | ✅ | 真实页（Flask 5000）dynamic import 手动调：滚动 10497→12164→12345 单调、终值精确、二次调用首帧非空白、reduced 直显 777、**errs=[]** |
| ② 全函数真机试跑（加测） | ✅ | ripple span 注入/按时回收；stagger/pageOut/pageIn/flip/sparkline/drawCheck/shake 终态无残留；confetti 播后清空且 reduced 跳过（painted 492px→0） |
| ③ 零依赖 | ✅ | 原生 ES Module + 零构建链；仅新增 node:test 测试（Node 自带，无 npm） |
| smoke v1 / v2 | 7/7 ✅ / 3/3 ✅ | v2 新接入 A11（终值/dataset.v 记账/首帧/reduced 直显） |
| unittest | 260 OK ✅ | 首轮 1 fail = 已知挂账 P13 竞态复现（`test_budget.py:79`），复跑即绿，未触碰 `snapshots.py` |
| hex 门禁 | 51 ✅ | style.css 未增；tokens.css 35 豁免（本轮仅增 6 个无 hex 的时长 token） |

**验收工具（已入库，可复用）**：
- `scripts/dev/u12_acc_probe.user.js`（SHA256 `2153aaf6…`）：真实页手动 countUp 自动探针（滚动采样/终值/记账/reduced/错误捕获），`@match http://127.0.0.1/*`、`@grant none`（顶层 `return R`），目标 `http://127.0.0.1:5000/`（Flask 已启动时）。
- U1.1 探针 `u11_acc_probe.user.js` / `u11_scroll_probe.user.js` 依旧可复跑（用途不变）。

**本次实施注记（下一会话须知）**：
1. **tokens.css 增补 6 个 §3.5 专用时长 token**：`--dur-page-in:240ms`、`--dur-ripple:450ms`、`--dur-flip:450ms`、`--dur-sparkline:800ms`、`--dur-draw-check:400ms`、`--dur-stagger-step:40ms`（§3.4 原表无对应值，为满足「禁魔法数」+§3.5 验收口径增补；无 hex、未动既有值）。
2. **本机沙箱 node --test 需 `--test-isolation=none`**（沙箱禁子进程 spawn → EPERM）；真机直接 `node --test scripts/dev/` 即可。测试文件 `.mjs` 导入 `.js` 模块时 Node 会提示 MODULE_TYPELESS_PACKAGE_JSON（纯警告，不失败；不为此引入 package.json）。
3. **《定稿》v1.2 本地工作区有未跟踪副本**（`docs/UI终版方案_SpaceLensPro视觉动效与功能补全_定稿.md`），git 中仍无副本——**不要提交**，U4.3 回补时再入库；本手册自包含可执行，冲突以手册为准。
4. smoke 页以 `<script type="module">` 引入 motion.js 并挂 `window.__motion`：**module 要求 http 访问**（file:// 下 A11 显式失败，非回归，v1 不受影响）。
5. motion.js 的 `switchTheme` 仍留在 app.js（§3.5 实现落点的归并属于 U2.0 模块化，U1.2 未重复实现）；app.js:142 换行回归已顺手单独提交修复（非行为问题）。

## 已完成

### U1.0：门禁双 suite 与基线核定（`df01038`）

- `tests/web/smoke.html` 支持默认 v1、`?suite=v2`、`?suite=legacy` 注册表；v2 接入 A0 骨架自检。
- 基线核定：tracked unittest 260 用例、smoke v1 7/7、`style.css` hex 51。
- 10 个 P12 前旧草稿测试归档至 `tests/archive_pre_p12/`（原因见该目录 README）。

### U1.1：tokens.css 与主题体系（`62281ab` 实现 + `25faea2` 验收）

- 新增 `web/static/css/tokens.css`（手册 §3.4 全量设计变量，唯一允许 hex 的 CSS）。
- `web/templates/index.html`：head 3 行防闪烁主题解析（`pds_theme_v1` → `prefers-color-scheme` → light），`tokens.css` 在 `style.css` 之前加载；顶栏临时 `#btn-theme`（U3.1 移正）。
- `web/static/js/app.js`：`switchTheme()`（View Transitions 450ms 圆形扩散 / reduced-motion / 无 VT / 无坐标 → 直切）；主题键 `pds_theme_v1`。
- `web/static/css/style.css`：VT 新旧快照取消默认动画、无 VT/reduced 兜底规则（尾追加）。
- smoke v2 接入 A1。**六节流程最终验收 = 上表，全部通过。**

### U1.2：motion 动效工具库（`5466bde` + 顺手修复 `83ebadd`）

- 新增 `web/static/js/app/motion-core.js`（零 DOM 纯函数：`lerp`/`easeOutExpo`/`easeOutCubic`/`easeSpring` 常量/`clamp01`/`formatElapsed`/`fnv1a`）。
- 新增 `web/static/js/app/motion.js`（11 导出：`reducedMotion`/`countUp`/`ripple`/`staggerIn`/`pageOut`/`pageIn`/`flip`/`sparkline`/`confetti`/`shake`/`drawCheck`；时长/缓动仅读 motion token）。
- 新增 `scripts/dev/motion-core.test.mjs`（node:test 9 用例）与 `scripts/dev/u12_acc_probe.user.js`（真实页 countUp 验收探针）。
- `tests/web/smoke.html`：`<script type="module">` 引入 motion.js 挂 `window.__motion`；v2 接入 A11。
- `web/static/css/tokens.css`：增补 6 个 §3.5 专用时长 token（见实施注记 1）。
- 顺手修复 `app.js:142` 换行回归（单独小提交）。

### U1.3：App Shell 骨架与门禁切换（`b06c3ab`）

- `web/templates/index.html`：单屏 App Shell（顶栏 60 + 工具栏行 48 + 内容 flex + 状态栏 32；右栏 300px；`<900px`/`<640px` 恢复滚动）；全部 id/行为保留、app.js 零改动；新增槽位 N13 nav-tabs（hidden）、N10 view-toolbar、N09 strip-slot、N02 palette-slot。
- `web/static/css/style.css`：全量分区重构（base/layout/topbar/cards/list/overlays/motion + 响应式），**hex 51 → 0**（色值全量 token 化；暗色适配统一 token 化）。删除清单见手册 U1.3 执行记录偏差注记③。
- `web/static/css/tokens.css`：增补 U1.3 迁移色值组（亮/暗双侧）。
- `tests/web/smoke.html`：默认 suite 切 **v2**、v1 挂 `?suite=legacy`、v2 接入 A2（零滚动）+ A3 占位、脚手架自身零滚动组织。
- `scripts/dev/u13_viewport_probe.mjs`：两档窗口零滚动 + 暗色 + 窄屏验收探针（入库）。
- ⚠️ 偏差：`browse-chart` 未物理删除（D12 以 CSS 隐藏达成；renderComposition 无空守卫，物理删除归 U2.0）。

### U2.0：app.js 模块化拆分（本次提交）

- 新增 `web/static/js/app/` 18 个模块（api/icons/state/theme/labels + components/{toast,statusbar,onboarding,feedback,topbar,storage,modals,settings,scan} + pages/{workspace,snapshots,compare} + main）；`app.js` 清空为过渡注释壳（U4.3 删除）。
- `index.html` 改 `<script type="module" src="js/app/main.js">`；**renderComposition 与 browse-chart 容器物理删除**（映射表既定 D12，承接 U1.3 的偏差注记①路线）。
- `tests/web/smoke.html`：改为「经典打桩脚本 + module 断言框架」双段；v2 接入 A4-A10（四断言+两竞态移植）；legacy 沿用（U2.5 退役）。
- `scripts/dev/u20_network_probe.mjs`：Network 前后对照探针（入库）。
- 验收：legacy 7/7 + v2 11/12（A3 占位）+ API 序列前后一致 + Console 0 + **四视口截图与 U1.3 基线逐字节一致**（SHA256 相同）。

## 下一步：U2.1（hash 路由与三页面装配）

按手册 §U2.1 全节执行（前置 U2.0）：

- 路由表与转场 = §3.3：`#/`（workspace 现有浏览块内嵌）、`#/compare`、`#/snapshots`（后两者先放占位头，U3.3/U3.4 填充）；`transitionTo`：router.pause → `motion.pageOut`（120ms）→ replaceChildren(render(state)) → `motion.pageIn`（240ms）→ resume；未知路由回落 `#/`；hashchange 原生前进后退可用。
- 新文件：`router.js`（约 60 行骨架，`pds:navigate` 事件 + 切页后焦点移至页头标题）、`pages/workspace.js/compare.js/snapshots.js` 暴露 `render(state)→Node` + `mount()/unmount()`（unmount 停自身 rAF/轮询）；topbar 导航标签（N13，U1.3 已留 `nav-tabs` hidden 槽）接线（下划线 L2-11 可先静态）。
- **状态迁移**：`state.js` APP_STATE 按 §3.2 目标形状对齐（路由/视图/选择/扫描/快照/对比/treemap/ui 命名空间落地；U2.0 注记 2 的待命字段在此启用；跨视图状态迁入，切页不丢）；组件间跨页联动启用 `pds:state` 事件（U2.0 注记 3）。
- smoke v2：A3 接入（未知路由回落 + state.route 正确；A3 占位转正）。
- 验收：切页总时长 ≤360ms；浏览路径/多选/扫描状态切页不丢；子页面期间 treemap rAF 已停（U2.3 项，treemap 未接入前以页面内滚/轮询口径复核）；Network/console 常规门禁。
- **环境提示**：改 index.html/模板后 Flask 必须重启（debug=False 模板缓存）；smoke 双脚本结构纪律见 U2.0 注记 1。

## 当前未解决问题

### 1. 预存 Windows 快照锁竞态（高优先级挂账 → backlog/P13）

`tests.test_budget.DayBudgetTests.test_concurrent_saves_serialize_accounting` 偶发/连续失败：8 线程中可能仅 1 个保存成功，其余因 `.snapshot.lock` 残留、100 次重试耗尽。诊断认为 `_is_stale()` 并发读锁文件时 Windows 文件共享冲突导致 `_release_lock()` 的 unlink 被静默吞掉。**手册红线：不得修改 `snapshots.py`**；诊断脚本 `scripts/dev/diag_budget_race.py` 已入库。

### 2. 环境注记（跨机差异，已更新）

| 机器/记录 | Python | Flask |
|---|---|---|
| 手册 P12 继承记录 | 3.14.3 | 3.1.3 |
| U1.0 会话实测 | 3.11.8 | 3.0.2（`.venv` 为 `--system-site-packages` 重建，pip 断网） |
| U1.1 验收会话实测 | 3.14.3 | 3.1.3（本机 `.venv`，`pip` 可用） |

两套环境 unittest 均 260 绿；依赖仅 `flask>=3.0.2`（requirements.txt）。**新电脑建好 venv 后先跑一次 unittest 确认环境**。npm 12.17+ / Node 24.x 可用，但保持零前端依赖、零构建链纪律。**node 动效测试**：`node --test scripts/dev/`（motion-core.test.mjs 等；本机沙箱需 `--test-isolation=none` 变体，见本次实施注记 2）。

### 3. U1.1 暗色视觉部分适配 —— 已核销（U1.3）

U1.3 style.css 分区重构已把全部硬编码色值 token 化（hex 51→0，暗色补全），旧「部分适配」挂账注销；双主题视觉走查见本次 U1.3 验收（暗色截图与实测）。

### 4. 旧实例 / 端口残留风险

启动 Flask 前先确认 5000 无旧实例（曾有 PID 31404 残留并缓存旧模板的事故）；静态 smoke 惯例用 8771。

### 5. 版本控制状态（已更新）

本地分支 `ui2.0` 已推送 origin（U1.3 起含 U1.1 验收记录与交接文档）；工作区仅三个**已知未跟踪项**：`.venv/`、`dsh-image-gen/`、`docs/UI终版方案_SpaceLensPro视觉动效与功能补全_定稿.md`（U4.3 才入库）。提交时**不要 `git add -A`**，按文件精确添加（历史教训：以上三项混入过工作区）。每工作项一提交，message 格式 `UI2-U1.x: <摘要>`。

## 续作路线

`U2.0 模块化 → U2.1 路由 → U2.2 Treemap → U2.3 交互特效 → U2.4 存储卡 → U2.5 列表 → U3.1-U3.5 → U4.1-U4.3 → 发版判定（v2.0.0）`（U1.0/U1.1/U1.2/U1.3 已完成）。

## 新电脑起手步骤

```powershell
# 1. 拉取（main 不动，切 ui2.0）
git clone https://github.com/tricolor-dumpling/python-disk-analyzer.git
cd python-disk-analyzer
git checkout ui2.0

# 2. 建 venv 并装依赖（仅 flask；Everything 访问走程序目录 dll，不经 pip）
python -m venv .venv
.\.venv\Scripts\pip install -r requirements.txt

# 3. 门禁自查（三件套 + node 动效测试）
.\.venv\Scripts\python.exe -X utf8 -W error::ResourceWarning -m unittest discover -s tests -t .
powershell -Command "(Select-String -Path web\static\css\style.css -Pattern '#[0-9a-fA-F]{3,8}' -AllMatches).Matches.Count"   # 期望 ≤51
node --test --test-isolation=none "scripts/dev/*.test.mjs"   # 期望全绿（真机可直接 node --test scripts/dev/）
.\.venv\Scripts\python.exe -m http.server 8771 --bind 127.0.0.1 --directory .   # 然后浏览器开 /tests/web/smoke.html（U1.3 起默认 v2，4/5；v1 断言挂 ?suite=legacy，7/7）

# 4. （可选）本地 Flask 手测
.\.venv\Scripts\python.exe -X utf8 app.py --no-browser   # http://127.0.0.1:5000/

# 5. 提交前确认
git config user.name / user.email   # 无则先设置，保持与提交记录一致
git status --short
```

## 结束前命令

```powershell
git status --short
git log --oneline -4
git diff --stat   # 确认只含本工作项文件
```
