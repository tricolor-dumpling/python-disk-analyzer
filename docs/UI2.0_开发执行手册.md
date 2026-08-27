# UI 2.0（SpaceLens Pro）· 开发执行手册

> ✅ 执行记录：（待填。每个工作项完成后在此追加一行，格式仿 P12：`U1.1：完成内容摘要｜测试结果｜遗留挂账`）
>
> - **U1.0：门禁双 suite 与基线核定。** smoke.html 增加 `?suite=v2` 注册表（A0 骨架自检）与 suite 名显示，默认仍 v1，只加不删｜unittest `discover -s tests -t . -W error::ResourceWarning` = **260 用例全绿（1 skip，环境性）**；smoke v1 = **7/7**、v2 = **1/1**（浏览器实测）；style.css hex 色值基线 = **51**｜⚠️ 偏差注记：①环境实测 Python 3.11.8 + flask 3.0.2（手册继承的 P12 记载为 3.14.3/3.1.3；`.venv` 已按现状重建，`--system-site-packages` 引全局 flask，pip 当前无网络）；②npm 11.17.0 实际存在（P12 记「无 npm」），但零新增依赖纪律不变；③发现 10 个**未跟踪**的 P12 前旧草稿测试（test_web/test_refresh/test_dispatcher 等，断言 P12 已废弃的旧行为如「已启动」「Everything 不可用」）混入 discover 造成 6 项假红——已归档至 `tests/archive_pre_p12/`（无 `__init__.py` 不被收集，文件保留可查），权威门禁以 git 跟踪的 tests/ 为准。
> - **U1.1：tokens.css 与主题体系（最终验收完成 2026-08-26）。** 实现（62281ab）：全量设计 tokens、head 防闪烁主题解析、`switchTheme()`（View Transitions 450ms 圆形扩散 / reduced-motion 直切）、临时主题按钮、smoke v2 A1｜**六节流程验收结果**：①亮↔暗切换 = 真实页点击 VT 路径实测 `vtCalled=1`、点击→data-theme 生效 ~6–16ms、VT 完成 ~470–481ms（动画参数 450ms，§3.5 以参数为验收口径，端到端含渲染闭环开销）；②刷新持久化 = 真实页点击 dark → reload 后 data-theme=dark（防闪烁头脚本冷启动生效）；③清 key 跟随系统 = 无 key 时 `initTheme=系统偏好(light)` 成立（`initFollowsSystem=true`）；④reduced-motion = 模拟 `matches=true` 时 `vtCalled=0` 直切、点击→生效 ~0.7ms（≤80ms 达标）；⑤hex 门禁 style.css=**51**（基线 51 未增；tokens.css 35 为豁免文件）｜smoke v1=**7/7**、v2=**2/2**；unittest **260 OK**（0.94s，`-W error::ResourceWarning`）；console/运行时错误 **0**（探针 errs=[]，覆盖加载+三次切换）｜⚠️偏差注记：①本机 `.venv`=Python 3.14.3+Flask 3.1.3（与 U1.0 行注记的 3.11.8/3.0.2 不同，以本机实测为准）；②零滚动双档窗口目检属 **U1.3 A2** 范畴——本机默认视口（1280×720）观测旧布局 docScrollHeight 1813>720（预期中间态），U1.3 验收时再判；③app.js:142 `HANDLED_SCAN_KEY` 与 `loadHandledScanVersion()` 换行丢失（U1.1 提交引入的格式回归，非行为问题，U1.2 顺手修复或 U4.3 统一处理）；④《定稿》v1.2 源文件仓库内无副本（原机器未跟踪），本手册自包含执行不受影响，U4.3 归档时需回补｜⚠️挂账：`tests.test_budget.DayBudgetTests.test_concurrent_saves_serialize_accounting` 为预存 Windows 并发锁竞态，偶发/连续失败（`.snapshot.lock` 与并发 `read_text()` 句柄共享冲突导致 `_release_lock()` unlink 静默失败，后续同 PID 永久 busy）；本轮遵守红线未触碰 `snapshots.py`，转 backlog/P13。
> - **U1.2：motion 动效工具库（motion-core.js / motion.js / node 测试 / smoke A11）。** 新增 `web/static/js/app/motion-core.js`（零 DOM 纯函数：`lerp`/`easeOutExpo`/`easeOutCubic`/`easeSpring` 常量/`clamp01`/`formatElapsed`/`fnv1a`（含 `fnv1a("a")=0xE40C292C` 公开参考值锚点）与 `web/static/js/app/motion.js`（11 导出：`reducedMotion`/`countUp`/`ripple`/`staggerIn`/`pageOut`/`pageIn`/`flip`/`sparkline`/`confetti`/`shake`/`drawCheck`）；所有时长/缓动**仅经 `getComputedStyle(document.documentElement)` 读 motion token**（禁魔法数）；`countUp` 首帧同步写 `fmt(from)`、`dataset.v` 调用瞬间记账、reduced 直显终值；零新增依赖（原生 ES Module/零构建链）｜node 测试 = **9/9 绿**（手册 8 用例 + `easeSpring` 镜像一致性 1 例；本机沙箱以 `node --test-isolation=none --test "scripts/dev/*.test.mjs"` 等价运行——沙箱禁子进程 spawn，真机命令仍为 `node --test scripts/dev/`）；smoke v1 = **7/7**、v2 = **3/3**（新接入 A11：终值精确/dataset.v 记账/首帧不空白/二次调用/reduced 直显）；验收①=9 用例绿；验收②=真实页（Flask 5000）console 手动 countUp 实测：滚动 10497→12164→12345 单调、终值精确、二次调用首帧非空白、reduced 直显 777、**errs=[]**（另对全部 11 个导出做真机试跑：ripple span 注入/按时回收、stagger/pageOut/pageIn/flip/sparkline/drawCheck/shake 终态无残留、confetti 播后清空且 reduced 跳过）；验收③=零依赖｜hex 门禁 style.css = **51**（基线未增）；unittest = **260 OK**（首轮 1 fail 为已知挂账 P13 竞态复现——`test_budget.py:79`，复跑即绿，未触碰 `snapshots.py`）｜⚠️偏差注记：①tokens.css 增补 6 个 §3.5 专用时长 token（`--dur-page-in:240ms`/`--dur-ripple:450ms`/`--dur-flip:450ms`/`--dur-sparkline:800ms`/`--dur-draw-check:400ms`/`--dur-stagger-step:40ms`，§3.4 原表无对应值，为同时满足「禁魔法数」与 §3.5 验收口径而增补，无 hex、不动既有值，标注 U1.2 扩展）；②验收探针入库 `scripts/dev/u12_acc_probe.user.js`（SHA256 `2153aaf6…`，@match http://127.0.0.1/*，需 Flask 5000）；③smoke 页 module 载入 motion.js 要求 http 访问（file:// 下 A11 显式失败，非回归）；④顺手项 app.js:142 换行回归已单独小提交修复。
> - **U1.3：App Shell 骨架与门禁切换（实现 + 验收完成）。** `index.html` 重构为单屏骨架（§3.3 预算：顶栏 60 + 工具栏行 48 + 内容 flex + 状态栏 32；右栏 300px；`<900px`/`<640px` 恢复滚动）；全部 app.js 契约 id/类原样保留（搬家不改行为，app.js 零改动）；新增空位占位：N13 导航标签位（nav-tabs，占位期 hidden）、N10 视图工具栏位（沿用 视图切换+密度）、N09 迷你条带位（strip-slot）、N02 命令面板浮层位（palette-slot）；`style.css` 全量分区重构（base/layout/topbar/cards/list/overlays/motion + 响应式段），**hex 色值 51 → 0**（全量 token 化；暗色适配统一 token 化，U1.1 挂账「部分适配」核销）；tokens.css 增补迁移色值组（亮/暗双侧，见偏差注记②）；smoke：**默认 suite 切 v2**、v1 断言挂 `?suite=legacy` 保留（U2.5 退役）、v2 接入 A2（零滚动）+ A3 占位、脚手架自身按单屏组织（body 零滚动、面板内滚）｜测试与验收：**smoke 默认 v2 = 4/5**（A0/A1/A2/A11 绿，A3 待 U2.1 接入；非失败项）；**legacy = 7/7**（保 id 策略验证：行为未变）；unittest = **260 OK**；hex = **0**（基线 51 只减不增）；验收①两档窗口零滚动 = **1366×768 与 1920×1080 实测 `scrollHeight==clientHeight`、body overflow:hidden、顶栏 60/状态栏 32**（探针 `scripts/dev/u13_viewport_probe.mjs`：四视口 json+截图；另 800×700 窄屏实测恢复纵向滚动为声明例外 ✓；首启引导态与常态两轮均零滚动）；验收②=legacy 7/7；验收④=真实页手工走查（本机 Everything 就绪 + 真实 55 目录数据）：设置弹窗开合、主题 VT 切换（暗色全壳 token 化）、密度/表格视图切换、目录行下钻（D:\→D:\虚拟机 8 子目录、面包屑/返回上级）、筛选、对比发起与「跨盘拒绝」提示、快照卡真实会话、徽章「已就绪」——全部正常，console/pageerror **0**｜⚠️偏差注记：①**browse-chart 容器物理删除（D12）与「app.js 零改动 + legacy 全绿」硬约束冲突**（`renderComposition()` 无空守卫，app.js:469-476，删除即令渲染链抛错、legacy 全红）——本项采取「元素保留 + `#browse-chart{display:none!important}`」达成 D12 视觉语义（构成图不再显示），物理删除与 renderComposition 一并归 U2.0 模块化（§3.1 映射表既定路线）；②tokens.css 增补原 style.css :root 语义色值（亮色 18 hex + 暗色 4 hex + 9 个 rgba/无色项，暗色为「部分适配」统一 token 化的补全值）；非色值度量变量（--fs-*/--radius-*/--space-*）保留在 style.css 本地 :root 待 U4.3 收口；③style.css 删除规则清单（已迁移/取代）：`.container/.grid-main/.side`（→ .app/.shell/.main-col/.side-rail 壳布局）、`.composition-*/.donut-bg/.donut-value/.legend-dir/.legend-file`（D12 隐藏容器配套）、`.footer`（→ .statusbar 32px 常驻）、旧 :root 色值块（全部迁 tokens.css）；新增增强：`.dir-table th` 面板内滚 sticky 表头、数字处 `font-variant-numeric:var(--font-num)`（§3.4 规则）；④坑位记录：`.nav-tabs{display:flex}` 会覆盖 `[hidden]` 属性（作者样式 > UA 样式），占位期以 `.nav-tabs[hidden]{display:none!important}` 显式关闭——后续新增暂藏元素必须遵守；⑤右栏现为 3+1 卡（对比卡待 U3.4 迁子页面），768 高下右栏有面板内滚（§3.4 允许），页面级零滚动不受影响。
> - **U2.0：app.js 模块化拆分（行为等价重构，实现 + 验收完成）。** 旧 app.js（1502 行）按 §3.1 映射表迁入 `web/static/js/app/`，新增 18 个模块合计 1581 行：`api.js`（$ / esc / api / postJson / humanBytes / signedBytes，55 行）、`icons.js`（30）、`state.js`（APP_STATE，15）、`theme.js`（U1.1 主题，37）、`labels.js`（SKIP_REASON_TEXT/skipReasonText，15；scan↔snapshots 共享叶子，防互引成环）、`components/`（toast 26 / statusbar 12 / onboarding 27 / feedback 23（renderApiError 叶子）/ topbar 92（健康徽章+环境门控 红线#4/#8/#10）/ storage 45（概览卡）/ modals 135（弹窗栈+通用 confirm，红线#9）/ settings 104（设置+wipe）/ scan 220（K7+轮询单链+保存 红线#2/#3/#7））、`pages/`（workspace 389（浏览核心+竞态+行操作+最近浏览 红线#1/#11/#12）/ snapshots 106 / compare 176）、`main.js`（74：bind 拆分装配 + start() 自启动 + smoke 导入面）；`app.js` 清空为过渡注释壳（U4.3 删除）；index.html 改 `<script type="module" src="…/js/app/main.js">`；**映射表既定删除项落地：renderComposition 函数与 browse-chart 容器物理删除（D12，U1.3 已 CSS 隐藏过渡，视觉零变化）**｜测试与验收：smoke 默认 v2 = **11/12**（A0/A1/A2/A4-A11 全绿；A3 占位待 U2.1）；**legacy = 7/7**（旧断言在 module 化 app 上全过 = 行为等价主证明）；unittest = **259 OK + 1 已知挂账**（P13 竞态本轮复现并进入连续失败段——该测试前置 UX 前端零 py 改动，已挂账 backlog/P13 未触碰 `snapshots.py`；库内其余用例全绿）；hex 门禁 = **0**；node = 9/9；验收①Network 前后对照 = **API 请求序列完全一致**（`GET /`→tokens→style→(模块图)→`/api/settings`→`/api/snapshots`→`/api/fullscan/status`→`/api/overview`→`/api/health`→`POST /api/browse`；探针 `scripts/dev/u20_network_probe.mjs` 已存 before/after json；唯一差异=静态资源由单 app.js 变为 18 个模块文件，属模块化本质）；验收②Console/运行时错误 **0**；验收③§3.6 十二项逐条：机制#1（v2-A9/A10 绿）、#2（K7 持久化随 scan.js·代码评审）、#3（轮询单链+完成边沿·代码评审）、#4（renderApiError 双形态 v2-A0+w13 绿）、#5（esc·代码评审）、#6（postJson·代码评审）、#7（SKIP_REASON_TEXT 迁 labels.js·代码评审）、#8（evaluateEnvGate v2-A8 路径绿）、#9（v2-A7 绿）、#10（v2-A8 绿）、#11（v2-A4/A5 绿）、#12（v2-A6 绿）；**视觉多模态验收 = 四视口（1366×768 亮/1920×1080/1366×768 暗/800×700）截图与 U1.3 基线（b06c3ab 临时 worktree 同探针同参）逐字节一致（SHA256 相同：`819827bc…`/`97a76cbb…`/`7ded2bc5…`/`6dcbe143…`）——像素级行为等价；另目检真实页设置弹窗/暗色/下钻等交互正常｜⚠️偏差注记：①手册 §3.1 提 getJson 但旧源码无此函数（GET 一律 api(url)），以源码为准未另造；②APP_STATE 保持现行形状 `{lastBrowseData, health}`，§3.2 目标形状的路由/视图等命名空间待 U2.1 路由落地时对齐（本阶段无消费方，不预置空壳字段）；③跨模块可变状态经导出访问器读写（模块化拆分副作用，条款行为等价）：workspace（setCurrentRoot/getCurrentRoot/getCurrentPath/getLastRoots/applyLastRoots/resetBrowseHistory）、snapshots（getSessionsCache/setSessionsCache）、scan（setAutoSaveSetting/resetHandledScanVersion）、settings（setDataDir）；④旧 bind() 拆分为 bind<组件>()（独立注册，顺序差异无行为影响），main.start() 调用顺序 = 旧 init() 顺序；⑤smoke 页改为「经典打桩脚本（解析期执行）→ module 断言框架」双段结构——**教训：若 stub 与 app 同在 module，main.js 求值自启动会先于 stub 安装（本项实测首跑 A0 红），经典脚本先行是硬纪律**；⑥confirm 与弹窗栈同放 components/modals.js（映射表「通用 confirm」拆分留 U3.5 弹窗族收尾）；⑦pds:state 自定义事件未启用——模块依赖图无环（直接导入即无环解），事件机制待 U2.1 路由跨页联动启用；⑧smoke legacy 注册表经导入面微调（getSessionsCache/setSessionsCache/getCurrentPath 访问器，脚手架适配非行为改动）；⑨本机 `/api/health` 响应时延随 Everything DLL 探测抖动（偶发秒级），u20 探针以「等到 browse 或 15s」为锚——环境抖动非逻辑问题。⚠️挂账：P13 竞态连续失败段（既有挂账，本轮未新增）。
> - **U2.1：hash 路由与三页面装配（实现 + 验收完成）。** 新增 `js/app/router.js`（`createRouter`：表驱动 "/"|"/compare"|"/snapshots"、未知回落 "/"、转场互斥串行队列、`pds:navigate` 自定义事件、切页焦点管理（`[data-page-title]` tabindex=-1+focus）、pause/resume 挂点、首渲染直装免闪屏；页面注册表由 main.js 注入——router 零业务依赖、模块图无环）；页面契约 `render(state)→Node / mount / unmount`：`pages/workspace.js` 工作台模板（=U1.3 index.html 工作台区域机械搬移，结构/类/ID 逐字一致）+ `restoreWorkspaceView()` 回灌、`pages/compare.js`/`pages/snapshots.js` 占位页（§3.3 页头 64px 骨架 + 定稿 6.5 空态文案，U3.4/U3.3 填充）；topbar N13 导航标签接线（原生锚点→hashchange→router；激活态 `.is-active` 由 router 于 pds:navigate 同步；下划线 L2-11 动效 U3.1 补）；`index.html` 纯壳化（顶栏 + `#route-view` + 状态栏 + 浮层族；工作台内容迁入 workspace.js 模板）；`state.js` §3.2 目标形状落地（`route` 为真字段由 router 维护，余命名空间按 §3.2 默认预置、随功能工作项启用；旧键 lastBrowseData/healthPayload 保留过渡）；非主页 DOM 缺失空守卫（setStatus/renderFullscanState/renderScanRootChips/saveSnapshot/refreshSnapshots/renderSnapshotList/rebuildBaselineSuggest/renderCompareResult/wipeData + workspace 渲染族）+ **回挂视图回灌**（applySnapshotsView/applyScanView/restoreWorkspaceView——切页不丢=状态与显示双保持）；smoke 脚手架改为 App Shell 结构（顶栏+route-view+弹窗+toast，页面内容与真实页共用同一模板源码）+ **A3 实装**（未知路由回落/state.route 正确/页面切换渲染/往返状态保持/导航激活态同步）｜测试与验收：smoke 默认 v2 = **12/12 全绿**（A0-A11 全部实装；A3 转正）；**legacy = 7/7**；node = 9/9；hex = **0**；unittest = **260 OK**（P13 挂账本轮未复现）；验收①切页总时长 = **120(pageOut)+240(pageIn)=360ms 口径**（token 值决定；实测首跳 hashchange→换装完成 144ms，串行队列下连点二次切换亦正确收敛）；验收②切页不丢 = A3 + 探针实测（往返后 rows 7 / 面包屑 D: / 快照会话 1 / 扫描状态文本恢复 / 激活标签同步）；验收③子页面期间无页级渲染循环（treemap 未接入，占位说明；router.pause 挂点已备）；②Console/错误 = **0**（探针 errs=[] 覆盖亮/暗两轮）；**视觉多模态验收** = 三页截图（工作台/对比/快照 × 亮/暗）目检合格——导航标签新亮相（工作台默认激活、暗色 token 化一致）、页头 64px+空态居版式符合 §3.3/§3.5、零滚动保持；焦点管理实测 `activeElement=H1`（页头标题）｜⚠️偏差注记：①工作台首挂不刷概览（init 链仍按 settings→snapshots→status→overview→health→browse 历史时序，Network 前后对照**内容+顺序完全一致**；概览刷新仅回挂路径执行）；②路由注册表由 main.js 注入（与定稿骨架「router 自含 routes」表述略异——保持 router 零业务依赖、避免 pages↔router 环，行为等价：回落/转场/事件/焦点全部按 §3.3/定稿 §7.2）；③占位页页头副行含「U3.x 接线」开发期注记（UI 透明；U3.3/U3.4 填充时替换）；④state.route 之外命名空间为默认预置（无消费方不迁模块级状态——跨页保持由模块持久天然满足，随功能工作项逐项迁入 state）；⑤A3 断言等待 600ms 覆盖 120+240 转场；⑥`#route-view{aria-live=polite}` 标注路由区（切页朗读提示，不喧哗）。

> **依据**：《docs/UI终版方案_SpaceLensPro视觉动效与功能补全_定稿.md》（v1.2，下称《定稿》）。本手册把《定稿》展开为**可直接执行的开发文档**：开发者**只看本文档即可完成全部开发任务**，无需回读《定稿》；确需视觉动机说明时再查阅对应章节。
> **适用对象**：本改版（建议版本号 v2.0.0）的开发执行者与验收人。
> **冲突裁决**：本文档与《定稿》不一致处，以本文档为准，并在该工作项「阶段信息」下加 `⚠️ 偏差注记`；不得静默修改方案语义。

---

## 一、全局执行纪律（每一工作项都必须遵守）

1. **六节流程**：每个工作项按「阶段信息 → 设计 → 实现步骤 → 测试 → 验收 → DoD 与回滚」顺序执行，不得跳过测试与验收；未完成项如实记录，不伪造验收结果。
2. **合并闸门**（每项独立提交前全部通过）：
   - 后端/全局：`.venv\Scripts\python.exe -m unittest discover -s tests -t .` 全绿；改过任何 `py` 文件的，追加 `-W error::ResourceWarning`；
   - 前端：浏览器打开 `tests/web/smoke.html` 全绿（suite 规则见 U1.0/U1.3：U1.0 起支持 `?suite=v2`，**U1.3 起 v2 为默认门禁**）；
   - 色值门禁：`style.css` 中十六进制色值出现次数 **不得高于 U1.0 记录的基线**（只减不增，新颜色一律走 `tokens.css` 变量；统计命令见附录B）；
   - 改动过 `index.html`/`js` 的，验收步骤必须包含 1366×768 与 1920×1080 两档窗口下的零滚动目检（桌面断点内）。
3. **受控修改护栏**：
   - **后端红线**：API 契约 additive（现有 13 个接口语义与字段零变更）；唯一新增接口 `POST /api/fullscan/stop`（U3.2）；快照格式 v1、`(sizes, contents)` 解包契约、`save_snapshot -> Path|None` 返回契约冻结；`scan.py/compare.py/snapshots.py` 本轮**禁止触碰**；
   - **前端红线**：§3.6 所列 12 项既有机制必须原样保留语义（允许搬家，不允许改行为）。
4. **提交规范**：一工作项一提交，message 格式 `UI2-U1.1: <摘要>`；禁止跨工作项混合提交，保证可单独 revert。
5. **环境事实**（继承 P12 实测，执行日复核）：Windows；Python 3.14.3（项目内 `.venv`，flask 3.1.3）；**无 npm/pnpm/npx，严禁引入需安装的依赖**；Node v24 可用（仅限 `node --test` 跑纯逻辑测试）；Web 服务 `http://127.0.0.1:5000`（仅回环）；前端为**原生 ES Modules**（`<script type="module">`，Flask 静态服务，无构建链）。
6. **偏差注记约定**：凡本文档所引 行号/函数名/字段 与当前源码不符的，以源码为准并加 `⚠️ 偏差注记`。

---

## 二、批次与并行轨道总览

| 批次 | 内容 | 关键路径 | 可并行项 |
|---|---|---|---|
| 批次一（U1）· 地基 | 门禁迁移、token/主题、动效库、App Shell 骨架 | U1.0 → U1.1 → U1.3 | U1.2 随时可并行 |
| 批次二（U2）· 核心可视化 | 模块化拆分、路由、Treemap、存储卡、列表 | U2.0 → U2.1 → U2.2 → U2.3 | U2.4 / U2.5 可与 U2.3 并行 |
| 批次三（U3）· 页面与闭环 | 顶栏/命令面板、扫描+停止接口、快照页、对比页、弹窗族 | U3.2（唯一后端项） | U3.1 / U3.3 / U3.4 相互独立；U3.5 收尾 |
| 批次四（U4）· 收口 | 无障碍、性能与视觉验收、文档版本 | U4.1 → U4.2 → U4.3 | — |

```
U1.0 门禁与基线核定【硬门槛，串行起点】
 ├──→ U1.1 tokens/主题 ──→ U1.3 App Shell 骨架（门禁切换 v2）──→ U2.0 app.js 模块化（行为等价）
 └──→ U1.2 motion.js（并行）────────────────────────┘                    ├──→ U2.1 路由与页面
                                                                          ├──→ U2.2 Treemap 渲染器 → U2.3 Treemap 交互特效
                                                                          ├──→ U2.4 存储概览卡（并行）
                                                                          └──→ U2.5 列表视图升级（并行；v1 断言在此退役）
U2 完成后 → U3.1 顶栏/命令面板 ─┬→ U3.5 弹窗族与引导 → 批次三闸门
                                ├→ U3.3 快照页（并行）
  U3.2 扫描卡＋停止接口（后端）─┴→ U3.4 对比页（并行）
批次三闸门 → U4.1 无障碍 → U4.2 性能与视觉验收 → U4.3 文档与版本收口 → 发版判定（v2.0.0）
```

分工建议：前端线（html/css/js）与后端线（仅 U3.2 的 py 改动）可两人并行；单人执行按上表关键路径串行。**同触 `index.html` 的相邻项（U1.3/U2.0/U2.1）串行合入，后项 rebase 后再动。**

---

## 三、目标架构与全局设计（开发者必读）

### 3.1 目标文件结构与旧代码映射

```
web/static/
  css/tokens.css          【新】全部设计变量 + motion tokens（唯一允许出现 hex 色值的 CSS 文件）
  css/style.css           【重构】分区+BEM：base/layout/topbar/cards/list/treemap/pages/overlays/motion
  js/app/main.js          【新】入口：装配 store/router/全局浮层（替代旧 app.js 尾部 init）
  js/app/state.js         【新】APP_STATE 单一来源 + localStorage 持久化
  js/app/api.js           【迁】postJson/getJson/esc/humanBytes/signedBytes（旧 app.js 基础工具）
  js/app/router.js        【新】hash 路由（约 60 行）
  js/app/motion-core.js   【新】纯函数：lerp/easing/formatElapsed（node --test 可测）
  js/app/motion.js        【新】DOM 动效：countUp/ripple/staggerIn/pageIn/pageOut/flip/sparkline/confetti
  js/app/palette.js       【新】FNV-1a 哈希取色（10 色）
  js/app/viz/treemap.js   【新】squarified + canvas 双层 + 命中检测 + 布局插值
  js/app/viz/donut.js     【新】SVG 环形图
  js/app/components/      【拆】topbar / breadcrumb / view-toolbar / treemap-card / list / storage /
  │                             scan / snapshot-mini / settings / palette-cmd / toast / statusbar / onboarding
  js/app/pages/           【新】workspace.js / compare.js / snapshots.js
  js/app.js               【过渡】U2.0 起清空为空壳注释，U4.3 删除文件
web/templates/index.html  【重构】App Shell 骨架
tests/web/smoke.html      【改造】双 suite（v1 存活至 U2.5 退役；v2 逐项接入）
```

**旧 → 新映射表**（重构时对照，防漏）：

| 旧位置（index.html / app.js） | 新归宿 | 备注 |
|---|---|---|
| topbar（徽章/指引/设置） | components/topbar | 新增导航标签 N13、搜索框 N02、主题按钮 |
| hero 首启引导折叠条 | components/onboarding（弹层） | 4 步内容不变；localStorage key `pds_onboarding_dismissed_v1` 沿用 |
| overview-panel 空间概览 | components/storage（环形图卡） | 数据源不变 `/api/overview` |
| 目录浏览 card（路径/面包屑/筛选/表格/browse-chart） | pages/workspace 视图区 | **browse-chart 与 renderComposition 删除**（定稿 D12）；其余逻辑迁移 |
| side 全量扫描 card | components/scan | 状态机扩展见 U3.2 |
| side 历史快照 card | pages/snapshots | 主页右栏留 snapshot-mini |
| 历史对比 section | pages/compare | 主页右栏留「最近对比」入口 |
| footer | components/statusbar（32px） | Everything 项改纯文本（定稿 F22 裁决） |
| settings/wipe/confirm 三弹窗 | components/settings + 通用 confirm | 保留 id：settings-modal/wipe-modal/confirm-modal |
| toast-container | components/toast | 动效升级 L2-6，id 不变 |

### 3.2 APP_STATE 形状（state.js 契约）

```js
export const APP_STATE = {
  theme: "light",                      // "light"|"dark"；持久化 pds_theme_v1
  route: "/",                          // 由 router 维护；"/"|"/compare"|"/snapshots"
  health: { state: "checking", detail: null },   // checking|ok|warn|err
  browse: { root: "D:\\", path: "D:\\", parent: null, history: [], seq: 0 },
  view: { mode: "treemap", density: "cozy", mergeTop: 24, sort: "size-desc", kind: "all", filter: "" },
  selection: { keys: [], anchor: null },          // N08 多选（key=条目 path）
  scan: { running: false, startTs: 0, roots: [], done: [], current: null,
          stopAvailable: false, stopRequested: false, version: 0, finishedAt: null },
  snapshots: { sessions: [] },
  compare: { baseline: "", target: "", result: null, lastSummary: null },  // lastSummary 供主页迷你卡
  treemap: { tiles: [], prev: new Map(), focusIdx: -1, hoverKey: null },
  ui: { fullscreen: false, paletteOpen: false, onboardingSeen: true },
};
```

**localStorage 键表**（沿用现有命名风格）：`pds_theme_v1`（新）、`pds_onboarding_dismissed_v1`（沿用）、`pds_handled_scan_version_v1`（沿用，K7）、`pds_last_browse_v1`（新，{root,path}，启动恢复失败回落 `D:\`）。

### 3.3 路由表与转场

| 路由 | 页面模块 | 内容 |
|---|---|---|
| `#/`（默认，未知路由回落） | pages/workspace | 视图区（treemap/排行/表格）+ 右栏三卡（storage/scan/snapshot-mini+最近对比） |
| `#/compare` | pages/compare | 页头 64px（基线 datalist+目标只读+开始对比）→ 摘要 3 卡 96px → 发散图 240px → 表格 flex:1 内滚 |
| `#/snapshots` | pages/snapshots | 页头 64px（创建快照+撤销）→ 趋势卡×2 128px → 会话列表 flex:1 内滚 |

转场（定稿 L0-5）：旧页 fadeSlide(-8px) 120ms → 换装 → 新页 fadeSlide(8px) 240ms；treemap 的 rAF 离场暂停/返场恢复；路由切换后焦点移至页头标题（`tabindex="-1"` + focus()）。

### 3.4 设计 token（tokens.css 全量内容，照抄即用）

```css
:root{
  --dur-1:120ms; --dur-2:200ms; --dur-3:320ms; --dur-4:600ms;
  --ease-out:cubic-bezier(.16,1,.3,1); --ease-spring:cubic-bezier(.34,1.56,.64,1); --ease-inout:cubic-bezier(.65,0,.35,1);
  --radius-card:16px; --radius-ctl:10px; --radius-chip:999px;
  --font-num:tabular-nums;
}
:root[data-theme="light"]{
  --bg:#f4f6fa; --bg-aurora-1:rgba(59,130,246,.10); --bg-aurora-2:rgba(125,211,252,.10);
  --card:#ffffff; --card-glass:rgba(255,255,255,.86);
  --text:#0f172a; --text-2:#475569; --muted:#64748b; --faint:#94a3b8;
  --border:#e2e8f0; --border-strong:#cbd5e1;
  --primary:#2563eb; --primary-hover:#1d4ed8; --primary-soft:#eff6ff;
  --accent:#7c5cff; --grad-brand:linear-gradient(135deg,#6366f1,#3b82f6);
  --success:#16a34a; --warning:#b45309; --danger:#dc2626;
  --up:#dc2626; --down:#16a34a;
  --glow-sm:0 0 0 transparent; --glow-md:0 0 0 transparent;
  --shadow-sm:0 1px 2px rgba(15,23,42,.05); --shadow-md:0 6px 20px rgba(15,23,42,.10);
  --shadow-lg:0 16px 40px rgba(15,23,42,.16);
}
:root[data-theme="dark"]{
  --bg:#0b1020; --bg-aurora-1:rgba(124,92,255,.08); --bg-aurora-2:rgba(56,189,248,.06);
  --card:#121a2e; --card-glass:rgba(18,26,46,.72);
  --text:#e5e7eb; --text-2:#cbd5e1; --muted:#94a3b8; --faint:#64748b;
  --border:rgba(255,255,255,.08); --border-strong:rgba(255,255,255,.16);
  --primary:#4f8cff; --primary-hover:#6ba1ff; --primary-soft:rgba(79,140,255,.12);
  --accent:#8b5cf6; --grad-brand:linear-gradient(135deg,#7c5cff,#4f8cff);
  --success:#34d399; --warning:#fbbf24; --danger:#f87171;
  --up:#f87171; --down:#34d399;
  --glow-sm:0 0 12px rgba(124,92,255,.25); --glow-md:0 0 24px rgba(124,92,255,.35);
  --shadow-sm:0 1px 2px rgba(0,0,0,.4); --shadow-md:0 8px 24px rgba(0,0,0,.45);
  --shadow-lg:0 20px 48px rgba(0,0,0,.55);
}
```

**Treemap 调色板**（palette.js）：`["#6366f1","#3b82f6","#06b6d4","#10b981","#84cc16","#eab308","#f59e0b","#ef4444","#ec4899","#a855f7"]`，取色=`fnv1a(目录名) % 10`；「其他」合并块固定 `#64748b`；暗色主题绘制时整块叠 `rgba(255,255,255,.08)`。

**使用规则**：`--faint` 仅用于禁用态与占位符（暗色卡底仅 ~3.5:1）；正文辅助文字最低 `--muted`。`--up/--down` 不得仅靠颜色：一律叠加 ▲/▼ 符号（色盲冗余）。数字处一律 `font-variant-numeric:tabular-nums`。

### 3.5 动效索引表（实现落点对照；参数为验收口径）

| 编号 | 名称 | 触发 | 参数摘要 | 实现落点 |
|---|---|---|---|---|
| L0-1 | 主题圆形扩散 | 点主题按钮 | circle 扩散 450ms ease-out；不支持则 240ms 交叉淡化 | motion.js switchTheme |
| L0-2 | 首屏入场 | 路由首次挂载 | fadeUp16 320ms，级差 40ms | motion.js staggerIn |
| L0-3 | 暗色极光 | 常驻（暗色） | 90s 漂移，opacity ≤0.08；亮色静态 | style.css keyframes |
| L0-4 | 顶栏流光线 | 扫描中 | 底边 1px 流光；静止无 | style.css |
| L0-5 | 页面转场 | 路由切换 | 出 120ms/入 240ms | motion.js pageIn/pageOut |
| L1-1 | 矩形生长 | treemap 数据到达 | scale .92→1+fade，stagger 12ms（≤400ms），600ms；>1500 块整画布 240ms | viz/treemap.js drawFrame |
| L1-2 | 列表行 stagger | 列表渲染 | 前 12 行 fadeSlide8，间隔 24ms | motion.js staggerIn |
| L1-3 | 占比条生长 | 列表渲染 | width 600ms ease-out，同屏同起点 | style.css transition |
| L1-4 | 数字 count-up | 统计数值变化 | 600ms easeOutExpo；reduced 直显终值 | motion.js countUp |
| L1-5 | 骨架屏 | 加载态 | shimmer 1.4s 循环；spinner 仅存于按钮 | style.css + 组件 |
| L2-1 | 按钮 | hover/active/click | -1px 抬升/scale .98/ripple 450ms | motion.js ripple |
| L2-2 | 扫描中按钮 | 扫描中 | 渐变 3s 流动+光环 2s（--glow-md） | style.css |
| L2-3 | 进度条 | 扫描中/完成 | 斜纹 1.2s+头部亮点；完成绿光 600ms+对勾描边 400ms | style.css + motion.js drawCheck |
| L2-4 | 完成庆祝 | 全量完成 | 粒子 **16 粒/600ms 单次**；先 toast；仅主页可见时播 | motion.js confetti |
| L2-5 | 行↔矩形联动 | hover | 双向 120ms；列表 scrollIntoView(nearest) | viz/treemap.js + list |
| L2-6 | Toast | 通知 | 滑入 320ms spring+时间线+成功描边 300ms+错误脉动 2 次+hover 暂停 | components/toast |
| L2-7 | 错误抖动 | 校验/请求失败 | shake 320ms ±4px×3 | motion.js shake |
| L2-8 | 徽章呼吸 | 未就绪 | badge-breathe 2.4s（现有保留）；就绪静止 | style.css（已有） |
| L2-9 | 缓存徽标 | 缓存命中 | translateX(-8px)+fade 200ms | style.css |
| L2-10 | 危险操作 | 清空确认 | 红描边脉动 2.4s；输入匹配后 3s 倒计时解锁 | components/settings |
| L2-11 | 导航下划线 | 切标签 | translateX+width 240ms ease-inout | components/topbar |
| L3-1 | 下钻转场 | 单击矩形 | FLIP 450ms ease-inout；双击回根 | viz/treemap.js |
| L3-2 | 扫描实时生长 | 扫描轮询 | 500ms 重排+lerp 300ms；子页面降频 2s | viz/treemap.js |
| L3-3 | 雷达扫掠 | 仅扫描中 | 12% 光带每 **6s**、opacity ≤0.06、lighter；reduced 关 | viz/treemap.js fx 层 |
| L3-4 | 环形图 | 入场/扫描 | sweep 800ms+count-up；扫描不确定弧 1.2s；hover 外扩 2px | viz/donut.js |
| L3-5 | Sparkline | 趋势卡 | 描线 800ms+终点脉冲 2s；▲/▼ 冗余 | motion.js sparkline |
| L3-6 | 红绿发散条 | 对比结果 | 中轴生长 500ms；徽标 pop-in spring | pages/compare |
| L3-7 | 迷你条带 | 常驻 | 静态不动画；hover 提亮 | viz/treemap.js strip |
| L3-8 | 全屏 | 工具栏 | FLIP 300ms 铺满+背景压暗；Esc 退 | view-toolbar |
| L3-9 | 合并阈值 | −/+ | 受影响块 lerp 300ms 重排 | viz/treemap.js |

**reduced-motion 降级总表**（`motion.js` 统一查询 `prefers-reduced-motion`）：循环类全部静止；入场类 opacity ≤120ms 或直显终值；转场类 ≤80ms；L2-4 不播放；toast/shake 等功能性反馈保留但 ≤120ms。

### 3.6 既有机制保留清单（前端红线，允许搬家不允许改行为）

| # | 机制 | 现位置（app.js 行号供参考） | smoke 断言 |
|---|---|---|---|
| 1 | browseSeq 浏览竞态防护（迟到响应不得覆盖新状态） | :552 起 | v1-竞态A/B → v2-A9/A10 |
| 2 | K7 已处理扫描代次持久化（防重复保存提示） | :104 | U3.2 验收步骤 |
| 3 | schedulePollFullscan 轮询单链 + _wasScanRunning 完成边沿 | :713 | U3.2 验收 |
| 4 | renderApiError 类型化/旧形态双容忍 | :200 | v1-断言0 → v2-A0 |
| 5 | esc() HTML 转义（一切 innerHTML 注入必经） | :44 | 代码评审项 |
| 6 | postJson 错误形态容忍 | :67 | v2-A0 |
| 7 | SKIP_REASON_TEXT 跳过原因文案 | :798 | U3.3 验收 |
| 8 | evaluateEnvGate/showBrowseGuide 环境门控 | :214/:244 | U3.1 验收 |
| 9 | 弹窗 Esc 按打开逆序关栈顶 + Tab 循环 + R 守卫 | W2.6 | v1-断言③ → v2-A7 |
| 10 | busy 健康徽章不降级/整页不进引导态 | W2.1 | v1-断言④ → v2-A8 |
| 11 | 文件行零请求 / 目录行恰一请求 | W1.4 | v1-断言① → v2-A4/A5 |
| 12 | 筛选空态「清除筛选」按钮 | W2.5 | v1-断言② → v2-A6 |

### 3.7 API 契约

现有 13 个接口（**零变更**）：`GET /`、`GET /api/health`、`GET /api/overview`、`POST /api/browse`、`POST /api/open-path`、`POST /api/fullscan/start`、`GET /api/fullscan/status`、`POST /api/save`、`POST /api/save/undo`、`GET /api/snapshots`、`POST /api/compare`、`GET|POST /api/settings`、`GET /api/export`、`POST /api/admin/wipe`。

**唯一新增**（U3.2）：

```
POST /api/fullscan/stop
请求体: {}（可空）
响应:   { "ok": true, "stopped": <bool>, "status": <fullscan.status() 原样> }
语义:   运行中→置用户停止事件, stopped=true; 空闲→stopped=false（幂等, 不报错）。
        status additive 新增字段: stop_requested:<bool>, stop_reason:null|"user"|"shutdown"。
前端:   启动时探测一次(对 404 静默), 404 则隐藏「停止」按钮。
```

⚠️ 设计要点（U3.2 必读）：`fullscan.CANCEL_EVENT` 是 **P12·W2.10 的停服事件**，语义为「服务关闭，优雅收尾」。用户停止**不得复用**它——必须新增独立 `USER_STOP_EVENT`，扫描循环检查 `CANCEL_EVENT or USER_STOP_EVENT`，status 以 `stop_reason` 区分，前端据此分别显示「服务停止」与「已停止，已完成部分可浏览」。

---

---

# 四、批次一（U1）· 地基

## U1.0 · 门禁迁移与基线核定（硬门槛）

### 0. 阶段信息
前置：无。预估：0.5 人日。触碰：`tests/web/smoke.html`（只加不改）。分支：`ui2-u1.0`。
### 1. 设计
smoke.html 增加**双 suite**：URL 带 `?suite=v2` 跑新注册表 `ASSERTIONS_V2`（本项仅 0 号骨架自检），默认仍跑 v1——本项只加不删，门禁零真空。记录三项基线数：unittest 用例数、smoke v1 通过数、`style.css` hex 色值出现次数（附录B 命令）。
### 2. 实现步骤
- [ ] smoke.html：解析 `location.search` 得 suite；新增 `ASSERTIONS_V2=[]` 与 0 号自检断言（页面加载、`__assert` 可用）；`__runAssertions` 按 suite 选择注册表；标题显示当前 suite 名。
- [ ] 执行附录B 三条基线命令，数字写入本手册头部执行记录。
- [ ] 复核环境事实（Python/Flask/Node 实际版本），不符则在执行记录加偏差注记。
### 3. 测试
`?suite=v2` 与默认各开一次，均全绿；unittest 全绿。
### 4. 验收
三项基线数字已记录；双 suite 均绿；提交 `UI2-U1.0: 门禁双suite与基线核定`。
### 5. 文档更新
本手册头部执行记录追加一行。
### 6. DoD 与回滚
DoD：双 suite 可切换且全绿、基线在案。回滚：还原 smoke.html 单文件。

## U1.1 · tokens.css 与主题体系

### 0. 阶段信息
前置：U1.0。预估：1 人日。触碰：`css/tokens.css`（新）、`index.html`（head+顶栏暂挂主题按钮）、`style.css`（尾追加）、`app.js`（switchTheme）。分支：`ui2-u1.1`。
### 1. 设计
变量全表照抄 §3.4。初始主题解析：`localStorage pds_theme_v1` → `matchMedia("(prefers-color-scheme: dark)")` → light。**防闪烁**：`index.html` `<head>` 内联 3 行脚本，在样式表生效前设 `data-theme`。切换动画=定稿 L0-1（View Transitions 圆形扩散，代码骨架见《定稿》§7.2，本手册 §3.5 参数为准）。
### 2. 实现步骤
- [ ] 新建 `tokens.css`（§3.4 全量），`index.html` 于 `style.css` **之前**引入；head 加防闪烁内联脚本。
- [ ] `app.js` 增加 `switchTheme(next, ev)`（含 reduced-motion 直切分支）与 localStorage 读写；顶栏暂以现有「设置」旁临时按钮触发（U3.1 移正）。
- [ ] `style.css` 尾部追加：`::view-transition-old/new(root){animation:none;mix-blend-mode:normal}` 与主题过渡兜底规则；注释分块（沿用 P12 W3.4 风格）。
- [ ] smoke `?suite=v2` 接入 A1（主题切换）断言（附录A）。
### 3. 测试
smoke v2 全绿；unittest 全绿（例行）。
### 4. 验收
①亮↔暗切换 ≤450ms，自点击处圆形扩散；②刷新后主题保持；③清 localStorage 后跟随系统；④系统「减弱动态效果」开启时切换 ≤80ms 无扩散；⑤hex 色值计数未超基线（新色全在 tokens.css）。
### 5. 文档更新
执行记录一行。
### 6. DoD 与回滚
DoD：上述①-⑤。回滚：删 tokens.css 引入与 switchTheme，单提交 revert。

## U1.2 · motion.js 动效工具库（可与 U1.1 并行）

### 0. 阶段信息
前置：U1.0。预估：1 人日。触碰：`js/app/motion-core.js`（新）、`js/app/motion.js`（新）、`scripts/dev/motion-core.test.mjs`（新）。分支：`ui2-u1.2`。
### 1. 设计
`motion-core.js`（零 DOM，node --test 可测）：`lerp(a,b,t)`、`easeOutExpo(p)`、`easeOutCubic(p)`、`easeSpring` 常量、`clamp01`、`formatElapsed(sec)→"HH:MM:SS"`、`fnv1a(str)→uint32`（供 palette，放此处避免循环依赖）。
`motion.js`（DOM）：`reducedMotion()`、`countUp(el,to,{fmt,dur})`、`ripple(btn,ev)`、`staggerIn(els,{y,delay})`、`pageOut(el)/pageIn(el)`、`flip(fromRect,el,{dur})`、`sparkline(svg,path,{dur})`、`confetti(canvas,{x,y,count})`、`shake(el)`、`drawCheck(svgPath)`。签名与参数=§3.5 索引表。
### 2. 实现步骤
- [ ] 实现 motion-core 全部纯函数（无副作用，可 tree-shake 引用）。
- [ ] 实现 motion.js 全部函数；所有时长/缓动**只从 `getComputedStyle(document.documentElement)` 读 motion token**，禁止魔法数。
- [ ] `countUp` 首帧即写 `fmt(from)`（防首帧空白）；`reducedMotion()` 直返终值分支。
- [ ] `node --test scripts/dev/` 新增 8 用例：lerp 两端/中点、easeOutExpo(0)=0/(1)=1、clamp01 越界、formatElapsed(3722)="01:02:02"、fnv1a 稳定性与异名异色。
- [ ] smoke `?suite=v2` 接入 A11（countUp 终值与 dataset.v 记账）。
### 3. 测试
`node --test scripts/dev/` 全绿；smoke v2 全绿。
### 4. 验收
①8 用例绿；②浏览器 console 手动调 `countUp` 观察滚动与 reduced 分支；③未引入任何依赖。
### 5. 文档更新
执行记录一行。
### 6. DoD 与回滚
DoD：库可用且被测。回滚：删除三个新文件。

## U1.3 · App Shell 骨架与门禁切换（关键项，含保 id 搬家策略）

### 0. 阶段信息
前置：U1.1（U1.2 建议已完成）。预估：2 人日。触碰：`index.html`（重构）、`style.css`（重构分区）、`smoke.html`（v2 接布局断言并设为默认）。分支：`ui2-u1.3`。
### 1. 设计
按 §3.1 映射表把旧 DOM **搬进壳**：本项只动结构与样式，**不改任何 id 与行为逻辑**（`#dir-body`、`#health-badge`、`#browse-guide`、`#browse-filter`、`#btn-undo-save`、`#settings-modal`、`#wipe-modal`、`#confirm-modal`、`#toast-container` 等全部保留），app.js 零改动——因此 **v1 断言在本项后必须仍然全绿**，门禁无真空。布局规格：§3.3 主页图与定稿 §3.2-3.4（60+48+flex+32 高度预算；右栏 300px；紧凑档 `@media (max-height:820px)`；`<900px` 宽恢复页面滚动）。新增空容器：视图工具栏位、迷你条带位、命令面板浮层位、导航标签位（占位注释）。
### 2. 实现步骤
- [ ] `index.html` 重构为 App Shell：topbar（含导航标签占位）/ 面包屑工具栏行 / 视图区（内嵌旧浏览块）/ 右栏（旧概览、扫描、快照卡迁入）/ 状态栏 / 浮层区；`browse-chart` 容器删除（D12）。
- [ ] `style.css` 重构分区（base/layout/topbar/cards/list/overlays/motion），旧规则逐条迁移或删除（删除项记入执行记录）；body 零滚动与紧凑档 media query 落地。
- [ ] smoke：v2 接入 A2（零滚动：`body.scrollHeight<=innerHeight+1`）与 A3 占位；**默认 suite 切为 v2**；v1 断言改挂 `?suite=legacy` 保留（U2.5 退役）。
- [ ] 两档窗口（1366×768 / 1920×1080）目检零滚动；`<900px` 宽目检恢复滚动。
### 3. 测试
smoke v2 全绿 **且 legacy suite 全绿**（保 id 策略的验证）；unittest 全绿。
### 4. 验收
①两档窗口零滚动；②legacy 全绿证明行为未变；③色值门禁通过（重构期允许下降不允许上升）；④旧功能（浏览/扫描/对比/设置/清空）手工走查一遍可用。
### 5. 文档更新
执行记录一行（含 style.css 删除规则清单摘要）。
### 6. DoD 与回滚
DoD：壳成型、双 suite 绿、零滚动。回滚：revert 单提交（index/style/smoke 同提交）。

---

# 五、批次二（U2）· 核心可视化

## U2.0 · app.js 模块化拆分（行为等价重构）

### 0. 阶段信息
前置：U1.3。预估：2 人日。触碰：`js/app/**`（新）、`app.js`（清空为注释壳）、`index.html`（script 标签）。分支：`ui2-u2.0`。
### 1. 设计
**纯机械搬移**：按 §3.1 映射表把 app.js 逐段迁入模块，函数体不改；分散的可变状态集中进 `state.js`（`APP_STATE` 形状=§3.2，多余旧变量并入对应命名空间或保留模块内局部）；`index.html` 改 `<script type="module" src=".../js/app/main.js">`；`main.js` 装配顺序=旧 `init()` 调用顺序。§3.6 十二项机制随所在段落迁移，**语义逐条不变**。
### 2. 实现步骤
- [ ] 建 api.js/state.js（含 localStorage 键表读写）→ 迁基础工具 → 逐段迁组件模块（每迁一段刷新页面跑 legacy suite）→ main.js 装配 → app.js 清空为指向注释。
- [ ] 循环依赖处理：组件间通信一律经 `state.js` 与自定义事件（`window.dispatchEvent(new CustomEvent("pds:state"))`），禁止模块互引成环。
- [ ] smoke legacy 全绿后，把四断言+两竞态移植为 v2 语义（选择器不变，因 id 未变）——v2-A4/A5/A6/A7/A8/A9/A10 接入。
### 3. 测试
每搬一段：legacy+v2 双绿；最终：双 suite 全绿 + unittest 全绿。
### 4. 验收
①Network 面板对比重构前后请求序列一致（路径/时序）；②Console 零报错；③§3.6 十二项逐条抽查。
### 5. 文档更新
执行记录一行（含模块清单与行数对照）。
### 6. DoD 与回滚
DoD：行为等价证明（双 suite+Network 对照）。回滚：revert；app.js 壳恢复内容。

## U2.1 · 路由与三页面装配

### 0. 阶段信息
前置：U2.0。预估：1 人日。触碰：`js/app/router.js`（新）、`js/app/pages/*`（新）、`components/topbar`（标签接线）。分支：`ui2-u2.1`。
### 1. 设计
路由表与转场=§3.3；router 骨架=《定稿》§7.2（`transitionTo`：router.pause→pageOut→replaceChildren(render(state))→pageIn→resume）。页面模块暴露 `render(state)→Node` 与 `mount()/unmount()`（unmount 停自身 rAF/轮询）。未知路由回落 `#/`。浏览器前进后退原生可用（hashchange）。
### 2. 实现步骤
- [ ] router.js：表驱动、回落、`pds:navigate` 自定义事件、焦点管理（切后 focus 页头标题）。
- [ ] pages/workspace 先装现有浏览块；compare/snapshots 先放占位头（U3.3/U3.4 填充）。
- [ ] topbar 导航标签接线（下划线 L2-11 可先静态，动效 U3.1 补）；命令面板入口占位。
- [ ] smoke v2 接入 A3（未知路由回落 + 切页后 APP_STATE.route 正确）。
### 3. 测试
smoke v2 全绿；手动：三页互切、前进后退、刷新后路由保持。
### 4. 验收
切页总时长 ≤360ms；浏览路径/多选/扫描状态切页不丢；子页面期间 treemap rAF 已停（任务管理器 CPU 归零）。
### 5. 文档更新
执行记录一行。
### 6. DoD 与回滚
DoD：三页可切、状态保持。回滚：revert。

## U2.2 · Treemap 渲染器（viz/treemap.js + palette.js）

### 0. 阶段信息
前置：U2.1。预估：3 人日。触碰：`viz/treemap.js`、`palette.js`、`components/treemap-card`、`pages/workspace`、`scripts/dev/treemap.test.mjs`。分支：`ui2-u2.2`。
### 1. 设计
**squarified 布局**（Bruls 算法，~40 行纯函数，放 motion-core 同级可测）：输入 `[{key,value}]` 按 value 降序，逐个尝试加入当前行，以 `worst(row, w)`（行内矩形最大宽高比）决定换行；输出 `[{key,x,y,w,h}]`，面积和=总面积。
**渲染**：双层 canvas（静态层：矩形+文字；特效层：扫掠/粒子/光晕，按需重绘）；`devicePixelRatio` 适配；resize rAF 节流。**标签三级**：块高 ≥48px 名称+大小+占比 / 24–48px 仅名称（ellipsis） / <24px 无标签；>1500 块关闭 <24px 层且入场改整画布交叉淡化。**命中检测**：`pointerclick` 坐标逆序遍历 tiles。**tooltip**：定稿 4.3 规格（玻璃底/偏移 12,12/延迟 150ms/边界翻转），内容=名称/大小/占比/「点击下钻」。**取色**：`fnv1a(name)%10`（U1.2 已备）。
数据接入：`/api/browse` 响应的 children（⚠️ 执行时核对字段名）→ `tiles=[{key:path,name,size,pct,color}]`，`mergeTop`（state.view.mergeTop）以外的项并入「其他」。
### 2. 实现步骤
- [ ] `layoutSquaried(items,x,y,w,h)` 纯函数 + node --test（面积守恒/宽高比上界/单块/空输入）。
- [ ] 静态层绘制（含标签三级与暗色 8% 白叠加）+ DPR + resize。
- [ ] 接入 workspace：数据到达→布局→L1-1 入场（drawFrame 插值，`prev:Map` 机制=《定稿》§7.2）。
- [ ] tooltip 组件与命中高亮；「其他」合并与 −/+ 阈值（L3-9 lerp 重排）。
- [ ] smoke v2 接入 A12（点击 tile 恰触发 1 次 /api/browse，参数 path 正确）。
### 3. 测试
node --test 全绿；smoke v2 全绿；附录B 帧率基准（1000 块 mock）≥50fps。
### 4. 验收
①布局数学用例全绿；②真实目录渲染标签/配色/「其他」正确；③tooltip 全规格；④1000 块入场与 hover 达标。
### 5. 文档更新
执行记录一行。
### 6. DoD 与回滚
DoD：渲染器四能力（布局/绘制/命中/tooltip）达标。回滚：revert；workspace 回退列表视图默认。

## U2.3 · Treemap 交互与特效

### 0. 阶段信息
前置：U2.2。预估：2 人日。触碰：`viz/treemap.js`、`components/view-toolbar`、`components/breadcrumb`。分支：`ui2-u2.3`。
### 1. 设计
单击=下钻（复用 `browsePath(path)`，FLIP：记录点击矩形→450ms ease-inout 放大铺满→新数据 L1-1 入场）；双击=回本级根（300ms 内二次点击判定，防误触）；`Backspace`=上级。hover 联动（L2-5）：列表行 `data-path` ↔ tile.key 双向 120ms，列表侧 `scrollIntoView({block:"nearest"})`。迷你条带（L3-7）：48px 条带渲染上级构成（数据=上级 browse 响应缓存；盘根隐藏），点击跳回。全屏（L3-8）：视图区 `position:fixed` 铺满+背景压暗+Esc。扫描实时生长（L3-2）：全量扫描中每 500ms 用最新 status/browse 增量重排（lerp 300ms），子页面降频 2s（router 暴露当前路由给 scan 轮询）。雷达扫掠（L3-3）：特效层 6s/次、opacity ≤0.06。
### 2. 实现步骤
- [ ] 下钻 FLIP + 双击判定 + Backspace；面包屑 push 联动。
- [ ] 双向 hover 联动（事件委托，避免千级行监听器）。
- [ ] 迷你条带、全屏、合并阈值接线（工具栏 −/+ 与视图切换按钮）。
- [ ] 特效层：扫掠 + 新块一次性描边光晕；`prefers-reduced-motion` 全分支。
- [ ] smoke v2 接入 A13（双击不产生第三次 browse——防抖回归）。
### 3. 测试
smoke v2 全绿；附录B 交互帧率（1000 块 hover/下钻）≥50fps。
### 4. 验收
定稿 L3-1/2/3/7/8/9 参数逐条目测+录屏留档；连续下钻/返回 50 次无监听器泄漏（DevTools Memory 对比）。
### 5. 文档更新
执行记录一行。
### 6. DoD 与回滚
DoD：六特效达标且降级正确。回滚：revert。

## U2.4 · 存储概览卡（viz/donut.js，可与 U2.3 并行）

### 0. 阶段信息
前置：U2.1。预估：1 人日。触碰：`viz/donut.js`、`components/storage`、`components/snapshot-mini`（最近对比入口一并）。分支：`ui2-u2.4`。
### 1. 设计
SVG 双弧环（底弧 `--border-strong`、数据弧 `--grad-brand` 描边）：入场 sweep 800ms（stroke-dashoffset 插值）+ 中心 count-up（L1-4）；扫描中该盘切不确定旋转弧 1.2s；hover 弧段外扩 2px+`--glow-sm`。盘符 chips：**只切环形数据不切目录（D15）**；全量扫描中自动跟随 `status` 当前盘，用户手选后本扫描期锁定；「浏览此盘」按钮→`browsePath(root)`。图例两行（已使用/可用，▲无、纯静态）。空态/加载态文案按定稿 6.5。⚠️ 执行时核对 `/api/overview` 实际字段名并记偏差注记；缺「总容量」字段时以盘符 chips+已用值降级为「已用排行」形态，**不改后端**。
### 2. 实现步骤
- [ ] donut.js（sweep/不确定弧/hover）+ storage 卡装配 + chips D15 逻辑 + 自动跟随。
- [ ] snapshot-mini：最近快照条目 +「管理快照」入口 + 空态（N06）；「最近对比」迷你卡（`state.compare.lastSummary`，空态引导文案）。
- [ ] smoke v2 接入 A14（chips 点击不触发 /api/browse）。
### 3. 测试
smoke v2 全绿；手动：扫描中自动跟随与手动锁定。
### 4. 验收
L3-4 参数逐条；D15 行为正确；紧凑档（<820px 高）下卡高达标。
### 5. 文档更新
执行记录一行（含 overview 字段核对结论）。
### 6. DoD 与回滚
DoD：卡四态（空/载/数据/扫描）齐全。回滚：revert。

## U2.5 · 列表视图升级（排行/表格/多选/虚拟滚动）—— v1 断言在此退役

### 0. 阶段信息
前置：U2.2（联动依赖 tile）。预估：2 人日。触碰：`components/list`、`components/view-toolbar`、`smoke.html`（v1 退役）。分支：`ui2-u2.5`。
### 1. 设计
三视图共用视口容器：treemap / 排行（现 ranking 逻辑迁移）/ 表格（现 table 逻辑迁移）；切换 120ms 交叉淡化。筛选行（名称/类型/排序）沿用现有 id 与语义（红线 #12 空态清除保留）。**多选 N08**：表格首列 checkbox（表头全选/半选），Shift 范围选；页脚固定行「共 N 项 · 已选 N 项 · [定位所选][导出所选 CSV]」；导出=前端 Blob（复用 esc/CSV 转义与 humanBytes，D9）。**行操作 F19**：hover 浮现 下钻/定位（open-path）/复制路径 三图标（触屏长按）。**虚拟滚动**：>200 行启用，行高 cozy 36px / compact 26px，上下缓冲 5 行；排序筛选后重算窗口。骨架屏（L1-5）替代 spinner；缓存徽标（L2-9）。
### 2. 实现步骤
- [ ] 视图切换框架与两列表迁移（保 id：`#dir-body` 等不变以延续断言）。
- [ ] 多选全套 + 页脚行 + Blob 导出（文件名 `所选-{目录名}-{日期}.csv`）。
- [ ] 行操作三图标 + 触屏长按；虚拟滚动；骨架屏；缓存徽标。
- [ ] smoke：v2-A4/A5/A6 断言核对通过后，**删除 legacy suite**，门禁仅剩 v2。
### 3. 测试
smoke v2 全绿；附录B：5000 行 mock 滚动 ≥50fps。
### 4. 验收
①四断言语义在新 DOM 全部成立；②多选/导出内容抽查正确（含引号逗号转义）；③虚拟滚动无跳行；④紧凑密度切换生效。
### 5. 文档更新
执行记录一行（注明 v1 退役）。
### 6. DoD 与回滚
DoD：三视图+多选+虚拟滚动达标。回滚：revert。

---

# 六、批次三（U3）· 页面与闭环

## U3.1 · 顶栏与导航（徽章 popover / 命令面板 / 主题按钮）

### 0. 阶段信息
前置：U2.1。预估：2 人日。触碰：`components/topbar`、`components/palette-cmd`、`components/onboarding`（入口）。分支：`ui2-u3.1`。
### 1. 设计
顶栏从左至右：Logo｜导航标签×3（N13：下划线 L2-11 滑动；圆点提醒=扫描完成/保存成功/对比完成三触发，点击消除）｜健康徽章（三态+呼吸 L2-8；点击 popover：数据目录/驱动状态/重试按钮=红线 #8 门控迁入）｜搜索框 N02（240×36、kbd 徽标、占位「搜索或跳转…」）｜主题按钮｜开始扫描（全局态随 scan；扫描中=微型进度环，点击回主页）｜设置。**命令面板**：Ctrl/⌘K 或点击打开；数据源=页面×3+盘符+最近访问+浏览历史+快照+命令（开始扫描/保存快照/开始对比/导出/切换主题/打开设置/使用指引）；本地模糊匹配（子序列命中+首字母加权）；↑↓/Enter/Esc；玻璃面板居中 640px。
### 2. 实现步骤
- [ ] 标签+下划线+圆点；徽章三态迁移+popover；主题按钮接 U1.1 switchTheme。
- [ ] 命令面板：数据源聚合器、评分过滤、键盘循环、执行分发（页面跳转走 location.hash；命令走既有函数）。
- [ ] 首启引导弹层（4 步内容迁移，`pds_onboarding_dismissed_v1` 沿用）与「使用指引」重开入口。
- [ ] smoke v2 接入 A7（Esc 栈顶/Tab 循环/R 守卫——面板视作浮层入栈）。
### 3. 测试
smoke v2 全绿；手动键盘矩阵走查（面板/标签/徽章）。
### 4. 验收
定稿 N02/N13/F01/F02 行为逐条；面板打开 <100ms、过滤无卡顿；圆点三触发实测。
### 5. 文档更新
执行记录一行。
### 6. DoD 与回滚
DoD：顶栏八元素全功能。回滚：revert。

## U3.2 · 扫描控制卡与停止接口（唯一后端项）

### 0. 阶段信息
前置：U2.1（卡壳）；后端无前置。预估：2 人日。触碰：`fullscan.py`、`app.py`、`components/scan`、`tests/test_fullscan.py`、`tests/test_web.py`。分支：`ui2-u3.2`（py 与 js 可同项两提交：`UI2-U3.2a: 后端` / `UI2-U3.2b: 前端`）。
### 1. 设计
**后端**：`fullscan.py` 新增 `USER_STOP_EVENT = threading.Event()` 与 `def request_stop()`；扫描循环取消判定改为 `CANCEL_EVENT.is_set() or USER_STOP_EVENT.is_set()`；`start()` 同时 clear 两事件（⚠️ 执行时核对现有 start 是否已 clear CANCEL_EVENT，缺则补）；`status()` additive 新增 `stop_requested:bool` 与 `stop_reason:null|"user"|"shutdown"`（置位时记录来源）。`app.py` 新增路由（契约=§3.7）：运行中置 `USER_STOP_EVENT` 返回 `stopped:true`；空闲返回 `stopped:false`；幂等不报错。已完成根保留语义不变（W2.10 既有）。
**前端**：状态机=定稿 6.2 全态（空闲/扫描中/完成/中止/保存提示）；扫描中按钮变「停止」（红描边，404 特性检测隐藏）；进度条 L2-3 全套；耗时计时器（前端 `startTs`，`formatElapsed`）；盘符 chips（✓完成/脉冲进行中/灰待办）；页面重开自动恢复（启动即 `pollFullscan`，running 直接进扫描中态，K7 防重复提示）；顶栏微型进度环（N05）；完成庆祝（L2-3 绿光+对勾、L2-4 粒子 16 粒）；中止态 toast「已停止，已完成部分可浏览」+保存按钮可用。
### 2. 实现步骤
- [ ] py：USER_STOP_EVENT/request_stop/status 字段/路由；`tests/test_fullscan.py` 新增：`test_request_stop_sets_user_event`、`test_stop_idempotent_when_idle`、`test_start_clears_stop_events`、`test_status_reports_stop_fields`；`tests/test_web.py` 新增路由契约用例（200 形态/幂等）。
- [ ] js：scan 卡状态机重构（保留红线 #2/#3 机制）；停止按钮+特性检测；计时器与 chips；完成/中止两分支；顶栏微型环。
- [ ] smoke v2 接入 A8（busy 徽章不降级——红线 #10 迁移断言）。
### 3. 测试
`.venv\Scripts\python.exe -m unittest discover -s tests -t . -W error::ResourceWarning` 全绿（含 5 新用例）；smoke v2 全绿。
### 4. 验收
①真机全量扫描中点停止：≤一个轮询周期内按钮回空闲态、toast 出现、已完成根可浏览、保存可用；②停服（Ctrl+C）路径回归：扫描线程仍优雅收尾（W2.10 语义不回归）；③重复点停止不报错；④重开页面扫描中态自动恢复且不重复弹保存提示（K7）。
### 5. 文档更新
执行记录一行；README「全量扫描」节补一句停止说明。
### 6. DoD 与回滚
DoD：契约用例全绿+真机四条验收。回滚：py/js 各自 revert（两提交独立可回）。

## U3.3 · 快照管理页（#/snapshots，可与 U3.1 并行）

### 0. 阶段信息
前置：U2.1。预估：2 人日。触碰：`pages/snapshots`、`motion.js`（sparkline）。分支：`ui2-u3.3`。
### 1. 设计
布局=§3.3 表。趋势卡×2（N07）：基线选取=同盘符快照按 `created_at` 就近且 ≤24h（较昨日）/≤7d（较上周）；目标=该盘最新快照；调 `/api/compare` 计算 Δ；sparkline 数据=该盘按时间序最近 N 份快照的总用量序列（⚠️ 执行时核对 `/api/snapshots` 会话数据是否含逐次总量：若含则画折线，若不含则趋势卡降级为「两快照对比差值卡」（无折线、保留 ▲/▼ 与百分比），**不改后端**并记偏差注记）。无合适基线→「暂无对比基线」空态；点击卡→`#/compare` 并预填（state.compare）。列表区：会话分组渲染迁移（`renderSnapshotList` 语义）、auto/manual/added/removed 标签、逐盘「对比」按钮、跳过原因 tooltip（红线 #7 SKIP_REASON_TEXT）、「撤销最近保存」（红线确认弹窗流程）。
### 2. 实现步骤
- [ ] 页头（创建快照=复用保存流程；撤销=迁移）+ 会话列表迁移 + 跳过 tooltip。
- [ ] 趋势卡：基线选取器、compare 调用、sparkline（L3-5）或降级形态。
- [ ] 空态文案（定稿 6.5）三处接入。
### 3. 测试
smoke v2 全绿；手动：造 3 份跨天快照验证选取与降级两形态。
### 4. 验收
N07 规则逐条（含无基线/单快照边界）；列表全功能与旧版一致；跳过原因可见。
### 5. 文档更新
执行记录一行（含 snapshots 字段核对结论）。
### 6. DoD 与回滚
DoD：页全功能+趋势两形态。回滚：revert。

## U3.4 · 对比工作台页（#/compare，可与 U3.1/U3.3 并行）

### 0. 阶段信息
前置：U2.1。预估：2 人日。触碰：`pages/compare`。分支：`ui2-u3.4`。
### 1. 设计
布局=§3.3 表。基线 datalist（迁移 `rebuildBaselineSuggest`）；**目标只读=同盘符最新快照**（定稿 6.4 裁决）；开始对比→骨架屏→摘要 3 卡（总变化=Σdelta、最大增长=max(delta>0)、可释放=|Σ(delta<0)|，count-up L1-4）→红绿发散条形图（L3-6：中轴、左红右绿、生长 500ms、徽标 pop-in、▲/▼ 冗余）→表格（迁移现有 compare 表：变化/增速/路径/操作定位 F19；行 stagger）。主页「最近对比」迷你卡点击→本页并预填。结果写 `state.compare.lastSummary` 供迷你卡。
### 2. 实现步骤
- [ ] 页头+基线/目标+datalist；对比执行与骨架屏。
- [ ] 摘要 3 卡与发散图（纯 DOM/CSS 实现，无需 canvas）；表格迁移。
- [ ] 与主页迷你卡、快照页趋势卡的预填联动。
### 3. 测试
smoke v2 全绿；手动：从三个入口（趋势卡/迷你卡/直达）进入均正确预填。
### 4. 验收
定稿 6.4 流程逐条；发散图参数（L3-6）达标；空态文案正确。
### 5. 文档更新
执行记录一行。
### 6. DoD 与回滚
DoD：页全功能+三入口联动。回滚：revert。

## U3.5 · 弹窗族与引导收尾（批次三闸门项）

### 0. 阶段信息
前置：U3.1-U3.4。预估：1.5 人日。触碰：`components/settings`、`components/toast`、`smoke.html`。分支：`ui2-u3.5`。
### 1. 设计
设置弹窗（id 不变）：自动保存开关/数据目录/健康状态（现有）+「主题：亮/暗/跟随系统」（与顶栏按钮同源 state.theme）；危险区：清空确认弹窗加红描边脉动（L2-10）+输入匹配后 3s 倒计时解锁。Toast 升级（L2-6 全参数）。首启引导弹层若 U3.1 未完则本项收尾。**批次三闸门**：定稿第二节 F01-F24/N01-N13 全表逐项核对并勾选。
### 2. 实现步骤
- [ ] 设置弹窗改造+倒计时+脉动；toast 升级（时间线/描边/脉动/hover 暂停/aria-live）。
- [ ] F/N 全表核对，缺项当场补齐或挂账。
### 3. 测试
smoke v2 全绿；unittest 全绿。
### 4. 验收
全表核对单留档（执行记录附件）；清空流程真机走一遍（输入确认文字→倒计时→执行→目录重建）。
### 5. 文档更新
执行记录一行+核对单。
### 6. DoD 与回滚
DoD：批次三闸门通过。回滚：revert。

---

# 七、批次四（U4）· 收口

## U4.1 · 无障碍与键盘矩阵

### 0. 阶段信息
前置：批次三闸门。预估：1 人日。触碰：全局小修（motion.js/topbar/treemap/list）。分支：`ui2-u4.1`。

### 1. 设计
定稿 7.4 键盘矩阵全量落地：`Ctrl/⌘ K` 命令面板、`Esc` 关浮层/退全屏、treemap 聚焦后方向键最近邻移动、`Enter` 下钻、`Backspace` 上级、`/` 聚焦筛选、`g c`/`g s` 跳页（可选实现）。单键快捷键仅事件目标非输入框/可编辑元素且 `e.isComposing === false` 时触发（中文输入法防误触）。焦点环 2px primary offset 2 全局统一；treemap 容器 aria-label 摘要；toast `aria-live=polite`；路由切换后焦点移至页头标题。

### 2. 实现步骤
- [ ] 键盘矩阵逐条接线与全局快捷键守卫。
- [ ] 焦点环/aria/路由焦点管理三件套统一核查修补。
- [ ] 纯键盘走通「扫描→浏览→对比→设置」全旅程一遍并修断点。

### 3. 测试
smoke v2 全绿；键盘全旅程录屏留档。

### 4. 验收
①不碰鼠标完成全旅程；②焦点始终可见、顺序合理；③reduced-motion 降级总表逐行复核通过。

### 5. 文档更新
执行记录一行。

### 6. DoD 与回滚
DoD：三条验收全过。回滚：按问题点单独 revert。

## U4.2 · 性能与视觉总验收

### 0. 阶段信息
前置：U4.1。预估：1.5 人日。触碰：按发现的问题小修（允许 2 轮修复循环）。分支：`ui2-u4.2`。

### 1. 设计
执行附录B 全部基准 + 定稿第八节清单：性能红线 7 条（1000 矩形 ≥50fps、主题切换 ≤450ms、路由切换 ≤360ms、50 次下钻无泄漏、5000 行滚动 ≥50fps、零滚动恒成立、动画仅 transform/opacity）、双主题全界面走查（含浮层/空态/两档窗口紧凑档）、灰度截图色盲检查、hex 色值门禁终核。

### 2. 实现步骤
- [ ] 跑附录B 全部基准，数值记录成表。
- [ ] 问题清单分级（破相/掉帧/不一致），逐项修复。
- [ ] 复跑基准与门禁（至多 2 轮）。

### 3. 测试
全部门禁绿（unittest + smoke v2 + 色值门禁）；基准数值表入执行记录。

### 4. 验收
定稿第八节清单逐条 ✓；未达标项挂账并写明理由与去向。

### 5. 文档更新
执行记录 + 基准数值表。

### 6. DoD 与回滚
DoD：验收单全绿或挂账有据。回滚：按修复点单独 revert。

## U4.3 · 文档与版本收口

### 0. 阶段信息
前置：U4.2。预估：0.5 人日。触碰：`README.md`、`docs/开发方案.md`、本手册、`js/app.js` 空壳、smoke legacy 残留。分支：`ui2-u4.3`。

### 1. 设计
README 升版 **v2.0.0** 并改述界面（App Shell 单屏/子页面路由/主题切换/命令面板/停止扫描/快捷键）；`docs/开发方案.md` 进度区勾选本迭代并链接本手册；本手册执行记录收尾并标记「已完成」；删除 `js/app.js` 空壳与全部死代码（旧 browse-chart 渲染、legacy smoke suite、无用 CSS 分区）。

### 2. 实现步骤
- [ ] 死代码删除（逐项列清单入执行记录）。
- [ ] README 改述与升版；开发方案.md 勾选。

### 3. 测试
删除后全部门禁复跑：unittest 全绿 + smoke v2 全绿 + 色值门禁。

### 4. 验收
README 陈述与实现逐条对得上（无文档漂移）；grep 无 app.js 残留引用。

### 5. 文档更新
本手册标记完成；README/开发方案.md 落笔。

### 6. DoD 与回滚
DoD：门禁全绿+文档零漂移。回滚：revert。

---

## 八、总验收清单（发版判定依据，验收人逐项勾选）

| 组 | 条目 | 来源 |
|---|---|---|
| 功能 | F01-F24 逐项归宿与行为正确 | 定稿§2.1 / 本手册 U2-U3 各验收节 |
| 功能 | N01-N13 逐项行为正确 | 定稿§2.2 / 同上 |
| 布局 | 1920×1080 与 1366×768 主页+两子页 body 零滚动；5000 行/50 快照/2000 对比行仍零滚动 | U1.3/U2.5/U4.2 |
| 布局 | 1366×768 右栏紧凑档无内滚无溢出 | U1.3/U4.2 |
| 布局 | <900px 宽退化为滚动、功能不缺失 | U1.3 |
| 动效 | L0×5/L1×5/L2×11/L3×9 按参数逐条 | §3.5 索引表 |
| 动效 | reduced-motion 降级总表逐行 | §3.5 |
| 性能 | 1000 矩形 hover/下钻 ≥50fps；主题切换 ≤450ms；路由切换 ≤360ms；50 次下钻无泄漏；5000 行滚动 ≥50fps | 附录B |
| 一致性 | 双主题全界面走查；hex 色值 ≤基线；灰度截图增减可辨 | U4.2 |
| 可访问性 | 键盘全旅程；焦点管理；aria；reduced 全表 | U4.1 |
| 回归 | §3.6 十二项既有机制全部保持；unittest 全量绿 | 各项闸门 |

## 九、风险登记

| 风险 | 影响 | 对策 |
|---|---|---|
| smoke 门禁真空（重构期断言失效） | 回归失控 | U1.3 保 id 搬家使 legacy 存活；U2.5 才退役；每段搬移即跑双 suite |
| USER_STOP_EVENT 与停服 CANCEL_EVENT 混用 | 停止语义污染停服路径 | 独立事件+stop_reason 区分；U3.2 验收②专测停服回归 |
| `/api/overview`、`/api/snapshots` 字段不足（环形总容量/趋势序列） | 卡片/趋势卡无法按理想形态渲染 | 执行时核对；等价计算优先，确实缺失按 U2.4/U3.3 预案降级，禁改后端 |
| Canvas 千级文本绘制卡顿 | 交互掉帧 | 文本只在静态层；>1500 块隐藏小标签；基准卡住则降标签密度（记录偏差） |
| ESM 浏览器缓存旧模块 | 开发期「改了没生效」误判 | 开发期 Ctrl+F5；验收前硬刷新；不做构建链（D1） |
| 虚拟滚动与 smoke DOM 断言冲突 | 断言偶发失败 | smoke 数据量控制在 200 行内（窗口全渲染） |
| 超小高度（<640px）布局挤压 | 极端环境破相 | 断点例外已声明（恢复滚动）；不做专门适配 |

## 十、文档更新与进度日志约定

- 每项完成：本手册头部执行记录追加一行（格式见头部示例）。
- 迭代完成：`docs/开发方案.md` 进度区勾选；README 升版；本手册状态改「已完成」。
- 挂账项统一记执行记录，格式 `⚠️挂账：<事项>（<去向：backlog/P13/下一迭代>）`。

---

## 附录A · smoke v2 断言清单（编号随接入工作项递增）

| 编号 | 名称 | 语义 | 接入 |
|---|---|---|---|
| A0 | 骨架自检 | 页面加载、断言框架与 fetch 桩可用 | U1.0 |
| A1 | 主题切换 | data-theme 切换+localStorage 写入+reduced 分支 | U1.1 |
| A2 | 零滚动 | body.scrollHeight ≤ innerHeight+1（默认窗口） | U1.3 |
| A3 | 路由 | 未知路由回落 #/；切页后 state.route 正确 | U2.1 |
| A4/A5 | 文件行/目录行请求 | 静态文件行 0 次 browse；目录行恰 1 次（红线 #11） | U2.0 移植 |
| A6 | 筛选空态 | 清除筛选按钮出现/清空/恢复（红线 #12） | U2.0 移植 |
| A7 | 弹窗栈 | Esc 逆序关栈顶、Tab 循环、R 守卫（红线 #9；面板入栈） | U3.1 |
| A8 | busy 徽章 | 扫描中徽章不降级、整页不进引导态（红线 #10） | U3.2 |
| A9/A10 | 浏览竞态 | 迟到响应不覆盖；B 成功无错误框（红线 #1） | U2.0 移植 |
| A11 | countUp | 终值正确、dataset.v 记账、reduced 直显 | U1.2 |
| A12 | treemap 命中 | 点击 tile 恰 1 次 browse 且 path 正确 | U2.2 |
| A13 | 双击防抖 | 双击回根不产生第三次 browse | U2.3 |
| A14 | chips 语义 | 存储 chips 点击不触发 browse（D15） | U2.4 |

## 附录B · 基线与性能基准方法

1. **unittest 基线**：`.venv\Scripts\python.exe -m unittest discover -s tests -t .` 尾行用例数。
2. **色值门禁**：`powershell -Command "(Select-String -Path web\static\css\style.css -Pattern \"#[0-9a-fA-F]{3,8}\" -AllMatches).Matches.Count"`（U1.0 记基线，此后只减不增；tokens.css 不限）。
3. **1000 矩形 mock**：DevTools console 注入 `state.treemap.tiles = Array.from({length:1000},(_,i)=>({key:"k"+i,name:"dir"+i,size:1000-i,pct:i/10,color:palette(i%10)}))` 后触发重绘。
4. **帧率采样**：Performance 面板录 2s 交互（hover 横扫+连续下钻），统计帧时长 P95 ≤20ms。
5. **内存泄漏**：连续路由切换/下钻 50 次前后各拍 Heap 快照，DOM Node 与 Listener 计数不增长。
6. **零滚动检查**：两档窗口（DevTools 设 1366×768 / 1920×1080）下 `document.body.scrollHeight - document.body.clientHeight ≤ 1`。
