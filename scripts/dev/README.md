# scripts/dev — 开发工具与探针

仅保留**可复用**的工具；历史一次性探针（p00/u11~u76 批次，共 72 个）已移至 `archive/` 仅供参考，不再维护，需要时按文件名查用途。

## 保留工具

| 文件 | 用途 | 用法 |
|---|---|---|
| `_harness.mjs` | 视觉探针统一入口：集中解析 Playwright/Chromium 路径（`PDS_PW`/`PDS_CHROME` 环境变量可覆盖），导出 `chromium`（自动注入 executablePath）、`arg()`、`wait()`、`shot()`、`screencast()`、页内 rAF 帧记录器源码。**新写浏览器探针从这里 import，不要重新硬编码路径** | `import { chromium, arg, shot } from "./_harness.mjs"` |
| `fixture_snapshots.mjs` | 快照夹具生成器：产出与 `snapshots.py` 格式完全兼容的 5 类快照会话（current / 23h / 25h / 8d / 跨盘），供快照删除、趋势卡、对比做离线确定性回归。**内置守卫：输出根落在真实数据目录 `%LOCALAPPDATA%\PythonDiskScanner` 内直接拒绝**（2026-09-13 起；确需覆盖加 `--allow-real-dir`） | `node scripts/dev/fixture_snapshots.mjs [--dir <根>] [--now <ISO>]`；接入 Web 用 `DSA_SNAPSHOT_DIR` 或重定向 `LOCALAPPDATA` |
| `destructive_acceptance.ps1` | 破坏性流程验收（PS 5.1 兼容）：重定向 LOCALAPPDATA 隔离数据目录后按序验证 save → 台账 → undo → 指纹谓词 → wipe 双确认 → 目录重建 | `powershell -File scripts\dev\destructive_acceptance.ps1 [-WhatIf] [-Cleanup]` |
| `treemap.test.mjs` | treemap 布局纯函数测试（node:test，零依赖） | `node --test scripts/dev/treemap.test.mjs` |
| `trend-window.test.mjs` | 趋势窗口纯函数测试 | `node --test scripts/dev/trend-window.test.mjs` |
| `motion-core.test.mjs` | 动效核心纯函数测试 | `node --test scripts/dev/motion-core.test.mjs` |
| `snapshot-view.test.mjs` | 快照页纯函数测试：日历（日期键解析/月份偏移/热力档位/网格与统计/HTML 断言）+ 会话可见性（savedRoots/sessionSavedBytes/isMeaningfulSession/splitSessions，2026-09-13 第二轮新增） | `node --test scripts/dev/snapshot-view.test.mjs` |
| `prefs.test.mjs` | 使用偏好持久化测试：默认回落/非法与越界清洗/未登记 id 拒写/恢复默认/存储不可用降级（2026-09-13 新增；自带 localStorage 打桩，直接 import 真实现） | `node --test scripts/dev/prefs.test.mjs` |
| `line-pick.test.mjs` | 折线点选纯函数测试：`nearestIndex`（读数游标）/`pointDist`/`pickIndex`（点选命中判定与半径边界）/`snapshotIndexOf`（基准点标记）（2026-09-13 第四轮新增；直接 import `viz/line.js` 真实现） | `node --test scripts/dev/line-pick.test.mjs` |

## 约定

- 新增探针/工具：可复用的放本目录并在上表登记；一次性核查脚本用完即归 `archive/`（或用完即删），保持本目录 ≤ 10 个文件。
- 浏览器探针依赖 `_harness.mjs` 的路径解析；沙盒内 Node spawn Chromium 会 EPERM，需用 dsh `browser_*` 工具或无沙盒环境运行。
- `archive/` 不保证能跑（历史脚本可能引用已删除的 docs 证据目录），只作实现参考。

## archive/ 命名速查

- `p00_*` / `p02_*` / `p0x_*`：早期视觉验收批次（帧录制、视口截图、布局/语义/像素探针）
- `u2x~u6x_*`：用户实测问题逐项核查探针（对应历史问题编号）
- `r1_*`：R 系视觉重设计截图脚本
- 详细原始说明见 `archive/README_阶段A_夹具与探针.md`
