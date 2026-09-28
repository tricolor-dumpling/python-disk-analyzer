# scripts/dev/ — 开发工具清单

本目录**只保留可复用工具**（上限 10 个文件，含本清单）。使用纪律：

1. **一次性核查脚本用完即删**——不要留在仓库里，考古走 git 历史（本目录不设 `archive/`）。
2. **新写浏览器探针必须 `import` `_harness.mjs`**——统一 Playwright/Chromium 路径，禁止在脚本里硬编码
   `C:/Users/...` 之类的绝对路径。
3. 探针与验收脚本的产物（截图、夹具、隔离根）一律写到系统临时目录或隔离根，**绝不写进项目目录或真实数据目录**
   （见根 `AGENTS.md` 第 3.17 条）。

## 工具清单

| 文件 | 用途 | 入口 / 参数 |
|---|---|---|
| `_harness.mjs` | 浏览器探针与动效录像统一入口：集中 Playwright/Chromium 路径，导出 `launch`/`shot`/`screencast`/`arg`/`wait`/`frameRecorderSource` 等 | `import { launch, shot } from "./_harness.mjs"`；路径可用环境变量 `PDS_PW`（Playwright 包）与 `PDS_CHROME`（Chromium 可执行文件）覆盖 |
| `fixture_snapshots.mjs` | 快照夹具生成器：造当前 / 23h / 25h / 8d / 跨盘五类会话，供对比页与趋势折线离线回归 | `node scripts/dev/fixture_snapshots.mjs [--dir <夹具根>] [--now <ISO>]`；末端打印 `FIXTURE_ROOT=...` |
| `destructive_acceptance.ps1` | 隔离数据目录下的破坏性流程验收：save → 台账校验 → undo → 指纹谓词 → wipe 双确认 → 目录重建 → 打包冒烟 | `powershell -File scripts\dev\destructive_acceptance.ps1 [-WhatIf] [-Cleanup]` |
| `motion-core.test.mjs` | `motion-core.js` 纯函数单测（插值/缓动/cubicBezier/fnv1a/耗时与 ETA/sparkline） | `node --test scripts/dev/` |
| `treemap.test.mjs` | `viz/treemap.js` squarified 布局与命中纯函数单测 | 同上 |
| `line-pick.test.mjs` | `viz/line.js` 点选命中纯函数单测（`pickIndex` / `nearestIndex` / `pointDist`） | 同上 |
| `trend-window.test.mjs` | `viz/line.js` 读数边界夹取单测（`readoutLeft`） | 同上 |
| `prefs.test.mjs` | `prefs.js` 偏好注册表读写、越界夹取与清洗单测 | 同上 |
| `snapshot-view.test.mjs` | `components/snapshot-view.js` 会话分组、夹具判定、日历模型单测 | 同上 |

## 运行方式

```powershell
node --test scripts/dev/                                   # 正常环境
node --test-isolation=none --test "scripts/dev/*.test.mjs"  # 沙盒环境（单进程，避免子进程管道受限）
```

## 两条容易踩的坑

- **`fixture_snapshots.mjs` 有内置守卫**：解析出的输出根一旦落在真实数据目录
  `%LOCALAPPDATA%\PythonDiskScanner`（及其子目录）内，立刻拒绝执行并退出——这是为了防
  「探针产物污染真实快照历史」的历史事故复发。确实需要覆盖时必须显式传 `--allow-real-dir` 并自负风险。
  默认输出到 `%TEMP%\pds_fixture_snapshots_<ts>`。
- **`destructive_acceptance.ps1` 会改数据**：它通过重定向 `LOCALAPPDATA` 把 `config.json`/`snapshots/`/
  `exports/`/machine_guid 全部引入隔离根（默认 `D:\deepseek\dsa-isolated\<时间戳>`），再跑破坏性序列。
  只想验证隔离闸门逻辑时用 `-WhatIf` 干跑；跑完不想留现场用 `-Cleanup`。
