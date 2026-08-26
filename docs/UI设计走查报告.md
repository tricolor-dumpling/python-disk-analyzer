# UI 设计走查报告（Web 前端）

- 走查人：UI 设计评审（ox-alpha）
- 日期：2026-08-24
- 走查对象：`web/templates/index.html`、`web/static/css/style.css`、`web/static/js/app.js`
- 走查方式：静态代码走查 + 本地 mock 服务实际渲染体验（未安装 Flask，用标准库 mock 复用真实静态资源）；参考了 `test-report/shots/` 与 `ui-review/shots/` 下的历史截图（仅看图，未读任何测试报告）
- 本次体验截图存档：`docs/ui-audit/live-*.png`

## 总体评价

整体设计方向是健康的：信息架构清晰（概览 → 浏览/扫描 → 对比）、术语与 CLI 一致、有空的态/错误态/加载态意识、支持 `prefers-reduced-motion` 和 focus-visible、图标全部内联 SVG 无外部依赖。**主要问题集中在「CSS 类缺失导致的半成品控件」和「错误路径的体验」两条线上**，其中加载态是必须马上修的视觉 bug。

---

## P0 · 视觉缺陷（用户可直接看到坏了）

### 1. 加载遮罩完全没有样式（最严重）

`.spinner`、`.spinner-lg`、`.loading-overlay` 在 style.css 中**一个都不存在**。`#browse-loading` 是 `.table-wrap` 内的普通 div，设计意图显然是绝对定位遮罩（`.table-wrap` 已有 `position:relative`），但样式没写。实测（`live-03-loading-broken.png`）：

- spinner SVG 无宽高约束，渲染成 **720×720 的巨型圆环**盖住半页；
- 遮罩为 `position:static`，加载时把整个表格往下顶出视口，产生大面积空白和布局跳动——历史截图 `04-pm-bogus-size.png` 中的两块大空白正是它。

**修复建议**（补进 style.css 即可）：

```css
.loading-overlay{position:absolute;inset:0;z-index:5;display:flex;flex-direction:column;
  align-items:center;justify-content:center;gap:10px;background:rgba(255,255,255,.85);
  color:var(--muted);font-size:var(--fs-sm)}
.spinner{width:28px;height:28px;animation:spin 1s linear infinite}
.spinner-lg{width:36px;height:36px}
@keyframes spin{to{transform:rotate(360deg)}}
```

### 2. 设置弹窗的「自动保存」开关是裸 checkbox

`.switch`、`.switch-row`、`.switch-hint` 均未定义。实测（`live-04b-settings.png`）：标题与说明文字挤成一行，下面孤零零一个原生小方框，像半成品。建议补一个 iOS 式 toggle：

```css
.switch-row{display:flex;align-items:center;justify-content:space-between;gap:16px;margin:12px 0}
.switch-hint{display:block;font-size:var(--fs-xs);color:var(--muted);margin-top:2px}
.switch{appearance:none;width:40px;height:22px;flex:none;border-radius:999px;background:var(--border-strong);
  position:relative;cursor:pointer;transition:background .16s ease}
.switch::after{content:"";position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;
  background:#fff;box-shadow:var(--shadow-sm);transition:left .16s ease}
.switch:checked{background:var(--primary)}
.switch:checked::after{left:20px}
```

### 3. Toast 四种类型同一种颜色

`.toast-success/-warn/-error/-info` 未定义，实测成功与错误提示的左边框**同为蓝色** `rgb(37,99,235)`，只靠 18px 小图标区分，错误不够醒目。另外退场动画类 `.leaving` 也没有定义，JS 里 `setTimeout(...,200)` 在等一个不存在的动画。建议：

```css
.toast-success{border-left-color:var(--success)} .toast-success .toast-icon{color:var(--success)}
.toast-error  {border-left-color:var(--danger)}  .toast-error .toast-icon{color:var(--danger)}
.toast-warn   {border-left-color:#f59e0b}        .toast-warn .toast-icon{color:#f59e0b}
.toast{animation:toast-in .18s ease}
.toast.leaving{opacity:0;transform:translateX(12px);transition:opacity .2s ease,transform .2s ease}
@keyframes toast-in{from{opacity:0;transform:translateX(12px)}}
```

### 4. 首屏未做任何操作就满屏报错

`init()` 里无条件自动浏览 `D:\`，Everything 未就绪时（很常见的首次状态）用户一打开页面就看到红色状态行 + 红色错误框（历史截图 `01-initial.png`）。建议：health 未就绪时**跳过自动浏览**，浏览卡片显示引导性空态（「Everything 就绪后点击浏览」），并把错误码翻译成人话（见 P1-6）。

### 5. Ctrl+R 被页面劫持

`bindModalClose()` 的快捷键处理只判断 `ev.key === 'r'`，**不检查修饰键**且 `preventDefault()`——浏览器刷新快捷键 Ctrl+R 会被拦截并变成「重新扫描当前目录」。应加 `if (ev.ctrlKey || ev.altKey || ev.metaKey) return;`。另外单按 `r` 就重扫也容易误触发（焦点在任意按钮上时按 R 都会触发），建议改为需要显式按钮或加修饰键。

---

## P1 · 交互与信息设计问题

### 6. 错误文案重复 3–4 处且外露原始错误码

同一错误同时出现在状态行、错误通知框、（扫描失败时还有）全量扫描状态、对比状态；「Everything查询失败: 2」这类原始码对用户无意义。建议：错误只在一处主展示（通知框），状态行收敛为一句话；后端/前端维护一张错误码→文案+建议动作的映射表（如「Everything 未响应：请确认 Everything 已启动并完成索引后重试」）。

### 7. 浏览失败后旧数据残留

失败路径上 `showBrowseError()` 不清理 `#browse-chart`（目录/文件构成环形图）和旧表格，出现「红色报错 + 上一个目录的图表」并存的矛盾画面（历史截图 `02-error-state.png`）。失败时应隐藏图表、清空表格或显示占位。

### 8. 全量扫描不可取消

长任务只有进度条，没有取消入口（TUI 里深刷支持 Esc 取消，Web 版没有对应能力）。建议后端暴露 cancel，进度条旁放「取消」次级按钮。

### 9. 弹窗无焦点管理

三个 modal 都有 `role="dialog" aria-modal="true"`，但打开不移焦、无焦点圈禁、关闭不还焦，confirm 弹窗不支持 Enter 确认。键盘与读屏用户实际用不了。建议封装 `openModal/closeModal`：打开时聚焦第一个可交互元素、Tab 循环、关闭时还原焦点。

### 10. 概览条形图：名称与条之间 ~340px 空白

`.overview-bar` 网格为 `minmax(70px,1fr) minmax(60px,1.5fr) auto`，宽屏下标签列被拉到 408px（实测值），阅读动线断裂（`live-01-initial.png`）。建议改为 `minmax(96px,200px) 1fr auto`，让条形占满剩余宽度。

### 11. 视图工具栏位置与语义

- 「排行 / 表格 / 紧凑列表」浮在「目录浏览」标题**上方**（`.view-toolbar` 在 `.card-head` 之前），看起来像属于上一张卡片，建议与标题同行右对齐；
- 前两个是「视图状态」、第三个是「切换动作」（文字显示的是要切去的状态），三者并排语义不一致，且 aria-pressed 无视觉按下态。建议把密度做成独立小开关，或三个统一为分段控件（选中态高亮当前状态）。

### 12. 历史快照列表暴露技术细节

会话标题下直接铺 `session_20260824_..._.json` 与 `C_xxx.snap.gz` 原始文件名，`.session-roots` 也无样式（默认圆点 + 断词换行 ".jso/n"）。用户关心的是：**什么时候、哪些盘、多大**。建议：主行=本地化时间 + 手动/自动标签，副行=盘符与快照总大小，文件路径收进「复制路径」次级操作或 title。

### 13. 时间格式不统一

快照列表做了 `T → 空格`，概览卡片的 `completed_at` 却原样输出 ISO 串（`2026-08-24T10:21:07`）。统一走一个 `formatDateTime()`。

---

## P2 · 视觉打磨与一致性

14. **环形图占位过大**：112px donut + 图例占据筛选区上方约 300px，只表达「目录/文件」两类的占比，信息密度低。建议缩到 64–72px 并与图例横排，或做成可折叠。
15. **「类型」列冗余**：只有 目录/文件 两个值，图标已表达；可换成扩展名或更有用的信息。
16. **小字号与低对比**：chips/meta/状态行大量 11–12px；`--faint:#94a3b8` 在浅底上对比度约 2.8:1，不达 WCAG AA（footer、session-sub、chips-label）。建议正文辅助信息不低于 12px、灰色文字对比度 ≥ 4.5:1。
17. **无深色模式**：`saveSettings` 里 theme 硬编码 `"light"`。CSS 变量体系已就绪，跟随 `prefers-color-scheme` 成本很低；磁盘分析是典型夜间场景，建议补齐。
18. **未扫描时的常驻控件**：0% 空进度条、禁用态「保存快照」一直可见，增加噪音；建议未开始扫描时隐藏，扫描后出现。
19. **盘符建议硬编码**：datalist 写死 `C:\ D:\ E:\ F:\`；后端已知实际盘符（fullscan/overview），应动态填充。
20. **健康徽章可点击但像标签**：点击打开设置只有 title 提示；未就绪状态建议在徽章旁直接给「查看解决方法」或点击弹出包含解决步骤的说明。
21. **确认弹窗输入框过窄**：清空确认输入框实测只有 188px（`.field input` 的 100% 规则没覆盖它），与其它表单控件不一致。
22. **重试按钮语义**：失败后「重试」用的是输入框当前值（会话根），不是刚才失败的路径，行为与预期不完全一致。

## 工程细节（影响后续 UI 迭代）

23. **style.css 压缩成 8 行超长行**：无法 review、无法增量修改；建议源码保持可读格式，发布时再压缩。
24. **用中文 aria-label 当布局选择器**：`.grid-main>section[aria-label="目录浏览"]` 控制栅格跨列——改文案即碎，建议改用 class。
25. **`window.__lastBrowseData` 全局变量** + 筛选每键全量 innerHTML 重绘：当前 ≤400 行可接受，建议至少加 150ms debounce；数据量大时考虑 DocumentFragment/虚拟滚动。
26. **`aria-live="polite"` 挂在整个概览 region**：innerHTML 大改时读屏会朗读整块内容；live region 应只包住状态文本（如 `#overview-meta`）。
27. **`.badge-warn`、`.stat-path` 未定义**：前者靠 `.badge` 默认琥珀色碰巧兜底（改默认色即坏），后者导致「变化最大目录」长路径无截断会撑破统计卡。补齐或删除。

---

## 修复优先级建议

| 优先级 | 事项 |
|---|---|
| P0（本周） | #1 加载遮罩样式、#2 开关样式、#3 toast 颜色与退场、#4 首屏报错、#5 Ctrl+R 劫持 |
| P1（下周） | #6 错误文案收敛、#7 残留图表、#8 取消扫描、#9 弹窗焦点管理、#10 概览条布局、#11 工具栏、#12 快照列表 |
| P2（排期） | #14–#22 打磨项、#23–#27 工程健康度 |

P0 五项全部是低成本高收益：#1/#2/#3 是补 CSS，#4/#5 是各一行级别的 JS 条件判断。
