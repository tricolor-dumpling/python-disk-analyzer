# UI 2.0 开发状态与续作指引

更新时间：2026-08-26

## 今日停止点

按用户要求，今天停止验收与继续开发。下次打开后从 **U1.1 的最终验收/独立提交复核** 开始，不要直接跳到 U1.2。

## 已完成

### U1.0：门禁双 suite 与基线核定

已完成并已提交：`df01038 UI2-U1.0: 门禁双suite与基线核定...`

- `tests/web/smoke.html` 支持默认 v1、`?suite=v2`、`?suite=legacy` 注册表。
- v2 已接入 A0 骨架自检。
- 已记录基线：tracked unittest 260 用例、smoke v1 7/7、`style.css` hex 51 次。
- 10 个 P12 前旧草稿测试已保留并归档到 `tests/archive_pre_p12/`，避免污染 discovery；原因见该目录 README。
- 手册已写入 U1.0 执行记录与执行日环境偏差。

### U1.1：tokens.css 与主题体系

代码已经完成，**尚未完成明日最终验收和独立提交**：

- 新增 `web/static/css/tokens.css`，包含手册 §3.4 全量设计变量。
- `web/templates/index.html` 增加 head 防闪烁主题解析，并在 `style.css` 前加载 `tokens.css`。
- 顶栏增加临时 `#btn-theme` 主题按钮。
- `web/static/js/app.js` 增加 `switchTheme()`：主题持久化、View Transitions 圆形扩散、reduced-motion/不支持 VT 直切分支。
- `web/static/css/style.css` 增加 View Transitions 与无 VT/reduced-motion 兜底规则。
- smoke v2 已接入 A1。
- 已进行初步真实页面验证：light→dark 切换成功，刷新后 dark 保持；双 suite 在静态服务中曾验证 v1 7/7、v2 2/2。
- 当前 `style.css` hex 计数仍为 51，未超过 U1.0 基线。

## 明日第一步

1. 读取本文件和《docs/UI2.0_开发执行手册.md》头部执行记录。
2. 查看 `git status`，确认 U1.1 变更文件完整且没有误纳入 `.venv/`、`dsh-image-gen/` 或其他无关文件。
3. 按 U1.1 六节流程完成最终验收（用户今天已明确允许明天验收）：
   - smoke 默认 v1 与 `?suite=v2`；
   - 真实 Flask 页面主题切换、刷新持久化、清除 key 后跟随系统、reduced-motion；
   - 1366×768 与 1920×1080 零滚动目检；
   - unittest 与 hex 门禁；
   - Console 无新增报错。
4. 更新手册 U1.1 执行记录，将“验收暂停”改为实际结果。
5. 单独提交：`UI2-U1.1: tokens主题体系`。
6. 再开始 U1.2：`motion-core.js`、`motion.js`、`scripts/dev/motion-core.test.mjs`，然后 U1.3。

## 当前未解决问题

### 1. 预存 Windows 快照锁竞态（高优先级挂账）

`tests.test_budget.DayBudgetTests.test_concurrent_saves_serialize_accounting` 在当前机器上存在 flaky/连续失败：8 个线程中可能只有 1 个保存成功，其余因 `.snapshot.lock` 残留而 100 次重试耗尽。独立诊断确认残留锁文件与同进程 PID 活跃状态一致；可能根因是 `_is_stale()` 并发读取锁文件时，Windows 文件共享冲突导致 `_release_lock()` 的 unlink 被静默吞掉。

- 该问题在 UI2.0 开始前就存在，最初基线也出现过。
- 本轮严格遵守手册红线，未修改 `snapshots.py`。
- 已挂账至 backlog/P13，并在 UI2.0 手册 U1.1 执行记录中注明。
- 诊断脚本暂存于 `scripts/dev/diag_budget_race.py`，明日可继续使用或在收口时决定是否删除。

### 2. 环境与手册记录不一致

实际执行环境：Python 3.11.8、Flask 3.0.2、Node 24.19.0、npm 11.17.0；手册继承记录为 Python 3.14.3、Flask 3.1.3、无 npm。`.venv/` 是本地重建的 system-site-packages 虚拟环境，pip 联网安装曾超时。不要引入前端安装依赖，继续使用原生 ES Modules/零构建链。

### 3. U1.1 暗色视觉目前是部分适配

背景和 token 变量已切换，但旧 `style.css` 中仍有部分硬编码白色背景，因此部分卡片/控件在暗色主题中仍偏亮。这是 U1.3 style.css 分区重构、全面 token 化前的中间状态，不要在明天验收前擅自扩大 U1.1 范围。

### 4. 旧实例/端口缓存风险

之前发现 PID 31404 的旧 Flask 实例占用 5000 并缓存旧模板，已终止。下次启动前先确认 5000 端口没有旧实例；如有，停止后再启动项目 venv 服务。静态 smoke 服务此前使用 8771，仅用于本次验证。

### 5. 版本控制状态

本地工作分支为 `ui2.0`。U1.0 已提交；U1.1 和本交接文档待提交。`.venv/`、`dsh-image-gen/`、`docs/UI终版方案_SpaceLensPro视觉动效与功能补全_定稿.md` 属于当前工作区其他未跟踪内容，提交时不要使用 `git add -A`，必须按文件精确添加。

## 续作路线

`U1.1 最终验收/提交 → U1.2 motion 库 → U1.3 App Shell/门禁切换 → U2.0 模块化 → U2.1 路由 → U2.2 Treemap → U2.3 交互特效 → U2.4 存储卡 → U2.5 列表 → U3.1-U3.5 → U4.1-U4.3`。

## 结束前命令

```powershell
git status --short
git log --oneline -3
# 明日验收后再运行：
.venv\Scripts\python.exe -X utf8 -W error::ResourceWarning -m unittest discover -s tests -t .
```
