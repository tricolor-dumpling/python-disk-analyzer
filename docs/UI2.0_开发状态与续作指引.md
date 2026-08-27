# UI 2.0 开发状态与续作指引

更新时间：2026-08-26（U1.2 完成会话修订，用于换机续作）

## 当前状态

- **分支**：`ui2.0`（已推送 GitHub origin，换机后 `git checkout ui2.0` 即可续作）；`main` 未动，仍是 P12 归档完成线。
- **提交链**：`5ec0061`(P12 尾) → `df01038`(U1.0) → `62281ab`(U1.1 实现) → `25faea2`(U1.1 验收记录) → `3d0e736`(换机交接文档) →（本次：U1.2 实现与验收）。
- **进度**：U1.0、U1.1、**U1.2 全部完成**（实现 + 验收 ①-③）；**下一步 = U1.3（App Shell 骨架与门禁切换，v2 设为默认 suite）**。
- 验收用 Flask(5000)/静态服务(8771) 已停止；工作区仅 `.venv/`、`dsh-image-gen/`、未跟踪《定稿》三个已知未跟踪项。

## 本次会话完成内容：U1.2 motion 动效工具库

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

### U1.2：motion 动效工具库（本次提交）

- 新增 `web/static/js/app/motion-core.js`（零 DOM 纯函数：`lerp`/`easeOutExpo`/`easeOutCubic`/`easeSpring` 常量/`clamp01`/`formatElapsed`/`fnv1a`）。
- 新增 `web/static/js/app/motion.js`（11 导出：`reducedMotion`/`countUp`/`ripple`/`staggerIn`/`pageOut`/`pageIn`/`flip`/`sparkline`/`confetti`/`shake`/`drawCheck`；时长/缓动仅读 motion token）。
- 新增 `scripts/dev/motion-core.test.mjs`（node:test 9 用例）与 `scripts/dev/u12_acc_probe.user.js`（真实页 countUp 验收探针）。
- `tests/web/smoke.html`：`<script type="module">` 引入 motion.js 挂 `window.__motion`；v2 接入 A11。
- `web/static/css/tokens.css`：增补 6 个 §3.5 专用时长 token（见本次实施注记 1）。
- 顺手修复 `app.js:142` 换行回归（单独小提交）。

## 下一步：U1.3（App Shell 骨架与门禁切换，关键项）

按手册 §U1.3 全节执行（前置 U1.1；U1.2 已完成）:

- **保 id 搬家**：旧 DOM 搬进 App Shell 壳（topbar/面包屑工具栏/视图区/右栏三卡/状态栏/浮层区），`#dir-body`、`#health-badge`、`#browse-guide`、`#browse-filter`、`#btn-undo-save`、`#settings-modal`、`#wipe-modal`、`#confirm-modal`、`#toast-container` 等 id 与行为**全部保留**，app.js 零改动——v1 断言必须仍全绿（U1.3 起默认 suite 切为 v2，v1 挂 `?suite=legacy`）。
- `style.css` 分区重构（base/layout/topbar/cards/list/overlays/motion），旧规则逐条迁移或删除（删除项记入执行记录）；body 零滚动 + 紧凑档 media query；`browse-chart` 容器删除（D12）。
- 布局规格：60+48+flex+32 高度预算；右栏 300px；`@media (max-height:820px)` 紧凑档；`<900px` 宽恢复页面滚动。
- 验收：①两档窗口（1366×768/1920×1080）零滚动；②legacy suite 全绿（保 id 验证）；③hex 门禁（重构期只降不升）；④旧功能手工走查。
- **U1.1 注记**：暗色部分适配（旧 style.css 硬编码白底残留）在 U1.3 统一 token 化，勿提前扩大范围；零滚动断言 A2 在 U1.3 生效。

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

### 3. U1.1 暗色视觉部分适配

旧 `style.css` 仍有硬编码白底，部分卡片/控件偏亮；**U1.3 style.css 分区重构时统一 token 化，提前不要扩大范围**。

### 4. 旧实例 / 端口残留风险

启动 Flask 前先确认 5000 无旧实例（曾有 PID 31404 残留并缓存旧模板的事故）；静态 smoke 惯例用 8771。

### 5. 版本控制状态（已更新）

本地分支 `ui2.0` 已推送 origin（U1.2 起含 U1.1 验收记录与交接文档）；工作区仅三个**已知未跟踪项**：`.venv/`、`dsh-image-gen/`、`docs/UI终版方案_SpaceLensPro视觉动效与功能补全_定稿.md`（U4.3 才入库）。提交时**不要 `git add -A`**，按文件精确添加（历史教训：以上三项混入过工作区）。每工作项一提交，message 格式 `UI2-U1.x: <摘要>`。

## 续作路线

`U1.3 App Shell/门禁切换 → U2.0 模块化 → U2.1 路由 → U2.2 Treemap → U2.3 交互特效 → U2.4 存储卡 → U2.5 列表 → U3.1-U3.5 → U4.1-U4.3 → 发版判定（v2.0.0）`（U1.0/U1.1/U1.2 已完成）。

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
.\.venv\Scripts\python.exe -m http.server 8771 --bind 127.0.0.1 --directory .   # 然后浏览器开 /tests/web/smoke.html（默认 v1）与 ?suite=v2

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
