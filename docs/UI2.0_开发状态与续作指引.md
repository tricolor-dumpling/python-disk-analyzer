# UI 2.0 开发状态与续作指引

更新时间：2026-08-26（晚间会话修订，用于换机续作）

## 当前状态

- **分支**：`ui2.0`（已推送 GitHub origin，换机后 `git checkout ui2.0` 即可续作）；`main` 未动，仍是 P12 归档完成线。
- **提交链**：`5ec0061`(P12 尾) → `df01038`(U1.0) → `62281ab`(U1.1 实现) → `25faea2`(U1.1 验收记录) →（本次：本交接文档更新）。
- **进度**：U1.0、U1.1 全部完成（实现 + 六节流程最终验收）；**下一步 = U1.2（motion.js 动效工具库）**。
- 工作区干净；验收用 Flask(5000)/静态服务(8771) 已停止。

## 本次会话完成内容：U1.1 六节流程最终验收

验收口径与结果（详细记录在《docs/UI2.0_开发执行手册.md》头部 U1.1 执行记录）：

| 项 | 结果 | 证据 |
|---|---|---|
| smoke 默认 v1 | 7/7 ✅ | 标题 `[suite=v1][PASS 7/7]` |
| smoke `?suite=v2` | 2/2 ✅ | A0 骨架自检 + A1 主题语义 |
| ① 亮↔暗切换（VT 圆形扩散 ≤450ms） | ✅ | 真实页点击走 VT（`vtCalled=1`），动画参数 450ms，完成 ~470–481ms（含渲染闭环开销），点击→生效 ~6–16ms；双向可切 |
| ② 刷新后主题保持 | ✅ | 真实页点击 dark → **reload 后仍 dark**（head 防闪烁脚本冷启动生效） |
| ③ 清 key 后跟随系统 | ✅ | 无 key 时 `initTheme=系统偏好(light)`（`initFollowsSystem=true`） |
| ④ reduced-motion ≤80ms 无扩散 | ✅ | 模拟 `matches=true`：`vtCalled=0` 直切，点击→生效 **0.7ms** |
| ⑤ hex 色值门禁 | ✅ | `style.css = 51`（基线 51 未增；tokens.css 35 为豁免文件） |
| unittest 门禁 | ✅ | `Ran 260 tests in 0.941s OK`（`-W error::ResourceWarning`） |
| Console / 运行时错误 | ✅ | 探针捕获 `errs=[]`（覆盖加载 + 三次切换） |
| 零滚动双档窗口目检 | 记录不判 | 按手册属 **U1.3 A2** 断言项；本机默认视口(1280×720)观测旧布局 `docScrollHeight 1813 > 720`（App Shell 前的预期中间态） |

**验收工具（已入库，可复用）**：
- `scripts/dev/u11_acc_probe.user.js`（SHA256 `44a025a6…`）：注入后自动执行"初始主题→¹切换→²切回→reduced 直切"并返回 JSON 指标 + 控制台错误捕获。
- `scripts/dev/u11_scroll_probe.user.js`（SHA256 `670d344a…`）：返回视口/滚动观测值。
- 复跑方式：在支持 UserScript 注入的浏览器工具中，脚本 `@match http://127.0.0.1/*`、`@grant none`（顶层 `return R` 为结果），目标 `http://127.0.0.1:5000/`（Flask 已启动时）。

**流水线参考**（本机实测）：
- Flask：`.venv\Scripts\python.exe -X utf8 app.py --no-browser`（仅 127.0.0.1:5000）。
- smoke：`.venv\Scripts\python.exe -m http.server 8771 --bind 127.0.0.1 --directory .` → 浏览器开 `http://127.0.0.1:8771/tests/web/smoke.html`（默认 v1）与 `?suite=v2`。
- 门禁见下方「新电脑起手步骤」第 3 条。

**本次验收发现（已注记，勿静默处理）**：
1. 本机 `.venv` = Python 3.14.3 + Flask 3.1.3（与前一次会话的 3.11.8/3.0.2 不同，两套环境均验证 260 用例全绿；新机可任装其一，建议 3.12+）。
2. `app.js:142` 存在 U1.1 提交引入的**换行丢失格式回归**（`HANDLED_SCAN_KEY` 与 `loadHandledScanVersion()` 挤在一行；非行为问题）——U1.2 顺手修复或 U4.3 统一处理。
3. U1.1 暗色视觉是**部分适配**：旧 `style.css` 仍有硬编码白底，部分卡片/控件偏亮；这是 U1.3 style.css 分区重构前的中间状态，**不要在 U1.1 擅自扩大范围**。
4. 《定稿》（`docs/UI终版方案_SpaceLensPro视觉动效与功能补全_定稿.md` v1.2）**在 git 中无副本**（原机器未跟踪）。本手册自包含执行不受影响；U4.3 归档时需回补或挂损失注记。

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

## 下一步：U1.2（motion.js 动效工具库）

按手册 §U1.2 全节执行（前置 U1.0，可与 U1.3 并行）：

- 新增 `web/static/js/app/motion-core.js`（纯函数，先写）：`lerp` / `easeOutExpo` / `easeOutCubic` / `clamp01` / `formatElapsed(sec)→"HH:MM:SS"` / `fnv1a(str)→uint32`（供 palette，放此处避免循环依赖）。
- 新增 `web/static/js/app/motion.js`（DOM）：`reducedMotion()` / `countUp` / `ripple` / `staggerIn` / `pageOut`/`pageIn` / `flip` / `sparkline` / `confetti` / `shake` / `drawCheck`；签名与参数=§3.5 索引表。
- 新增 `scripts/dev/motion-core.test.mjs`：node --test 8 用例（lerp 两端/中点、easeOutExpo(0)=0/(1)=1、clamp01 越界、formatElapsed(3722)="01:02:02"、fnv1a 稳定性与异名异色）。
- smoke v2 接入 A11（countUp 终值与 `dataset.v` 记账）。
- **纪律**：所有时长/缓动**只从 `getComputedStyle(document.documentElement)` 读 motion token**（禁止魔法数）；`countUp` 首帧即写 `fmt(from)`；`reducedMotion()` 直返终值分支；零新增依赖（原生 ES Modules/零构建链）。
- 完成标准：`node --test scripts/dev/` 全绿 + smoke v2 全绿 + 验收①8 用例绿 ②console 手动 countUp ③未引入依赖。
- 顺手项：修复 `app.js:142` 换行回归（单独小提交，与 U1.2 分开，保证可 revert）。

## 当前未解决问题

### 1. 预存 Windows 快照锁竞态（高优先级挂账 → backlog/P13）

`tests.test_budget.DayBudgetTests.test_concurrent_saves_serialize_accounting` 偶发/连续失败：8 线程中可能仅 1 个保存成功，其余因 `.snapshot.lock` 残留、100 次重试耗尽。诊断认为 `_is_stale()` 并发读锁文件时 Windows 文件共享冲突导致 `_release_lock()` 的 unlink 被静默吞掉。**手册红线：不得修改 `snapshots.py`**；诊断脚本 `scripts/dev/diag_budget_race.py` 已入库。

### 2. 环境注记（跨机差异，已更新）

| 机器/记录 | Python | Flask |
|---|---|---|
| 手册 P12 继承记录 | 3.14.3 | 3.1.3 |
| U1.0 会话实测 | 3.11.8 | 3.0.2（`.venv` 为 `--system-site-packages` 重建，pip 断网） |
| U1.1 验收会话实测 | 3.14.3 | 3.1.3（本机 `.venv`，`pip` 可用） |

两套环境 unittest 均 260 绿；依赖仅 `flask>=3.0.2`（requirements.txt）。**新电脑建好 venv 后先跑一次 unittest 确认环境**。npm 12.17+ / Node 24.x 可用，但保持零前端依赖、零构建链纪律。

### 3. U1.1 暗色视觉部分适配

见上文「本次验收发现」第 3 条；U1.3 前不要扩大范围。

### 4. 旧实例 / 端口残留风险

启动 Flask 前先确认 5000 无旧实例（曾有 PID 31404 残留并缓存旧模板的事故）；静态 smoke 惯例用 8771。

### 5. 版本控制状态（已更新）

本地分支 `ui2.0` 已推送 origin（含 `25faea2` 验收记录）；工作区干净。提交时**不要 `git add -A`**，按文件精确添加（历史教训：`.venv/`、`dsh-image-gen/`、未跟踪的《定稿》等混入过工作区）。每工作项一提交，message 格式 `UI2-U1.x: <摘要>`。

## 续作路线

`U1.2 motion 库 → U1.3 App Shell/门禁切换 → U2.0 模块化 → U2.1 路由 → U2.2 Treemap → U2.3 交互特效 → U2.4 存储卡 → U2.5 列表 → U3.1-U3.5 → U4.1-U4.3 → 发版判定（v2.0.0）`。

## 新电脑起手步骤

```powershell
# 1. 拉取（main 不动，切 ui2.0）
git clone https://github.com/tricolor-dumpling/python-disk-analyzer.git
cd python-disk-analyzer
git checkout ui2.0

# 2. 建 venv 并装依赖（仅 flask；Everything 访问走程序目录 dll，不经 pip）
python -m venv .venv
.\.venv\Scripts\pip install -r requirements.txt

# 3. 门禁自查（三件套）
.\.venv\Scripts\python.exe -X utf8 -W error::ResourceWarning -m unittest discover -s tests -t .
powershell -Command "(Select-String -Path web\static\css\style.css -Pattern '#[0-9a-fA-F]{3,8}' -AllMatches).Matches.Count"   # 期望 ≤51
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
