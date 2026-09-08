# 阶段 A（R0）开发产物用法说明

> 版本：v1.0　日期：2026-09-02
> 全部产物为**新增**（夹具/探针/文档），未修改任何生产代码；Rollback = 删除本批新增文件，不影响生产。

---

## 1. 快照夹具生成器 `scripts/dev/fixture_snapshots.mjs`

### 用途
生成五类快照会话（当前 / 23h / 25h / 8d / 跨盘），供阶段 C（快照删除/趋势卡）与阶段 B（对比）做离线确定性回归。产物与 `snapshots.py` 格式完全兼容（已用项目自身模块验证：`load_snapshot` 全读通、`compare_snapshots` 正确计算、`session.list_sessions` 可枚举）。

### 用法
```powershell
node scripts/dev/fixture_snapshots.mjs [--dir <夹具根>] [--now <ISO 时刻>]
# --dir  输出夹具根（缺省 %TEMP%\pds_fixture_snapshots_<ts>）
# --now  统一的「当前」参考时刻（程序化固定时间窗口用）
```

### 产出（以默认 2026-09-02T15:41:00 为参考）
| 会话 | 时间偏移 | 盘 | 语义 |
|---|---|---|---|
| current | 0h | C:\ D:\ | 今日自动快照（auto=true） |
| 23h | -23h | C:\ D:\ | 较昨日窗口（0<Δt≤24h）唯一命中 |
| 25h | -25h | C:\ D:\ | 较上周窗口（24h<Δt≤7d）命中 |
| 8d | -8d | C:\ D:\ | 双窗口外（空态对照） |
| cross-drive | -2h | E:\ | 跨盘基线（对比跨盘应拒绝） |

每个会话 = `snapshots/<盘>_<时间戳>_<auto|explicit>_<guid8>.snap.gz`（gzip JSONL，首行 header 含 CRC，与 `snapshots.py _build_header/_header_crc_payload` 同源）+ `session_<ts>_<guid8>_<seq>.json` 清单（`session.py` 结构）。

### 接入 `/api/snapshots` 与 `/api/compare`
启动 Flask 前把数据环境指向夹具根（二选一）：
```powershell
# 方式 A：LOCALAPPDATA 重定向（清单在夹具根，快照在夹具根\snapshots）
$env:LOCALAPPDATA = "<夹具根>\home"      # 需要夹具根\home\PythonDiskScanner 结构
# 方式 B：仅快照目录（趋势卡/对比走 DSA_SNAPSHOT_DIR）
$env:DSA_SNAPSHOT_DIR = "<夹具根>\snapshots"
```
然后 `python app.py --no-browser`，`GET /api/snapshots` 返回 5 会话、`POST /api/compare`（baseline=23h C 快照路径）返回正确 delta。

> ⚠️ 事实注记：夹具的 session 清单位于夹具根（非 `LOCALAPPDATA\PythonDiskScanner`），`session.list_sessions` 以数据目录根为准——若需 `/api/snapshots` 看到清单，请把 5 个 `session_*.json` 放到 `%LOCALAPPDATA%\PythonDiskScanner\`（或以 `LOCALAPPDATA` 重定向接入 `\home\PythonDiskScanner`）。阶段 C 实现期将按手册 W3.5 重定向规范收口接入方式。

---

## 2. 复现探针 `scripts/dev/u50_repro_probe.mjs`

### 用途
覆盖手册贰章「先复现」五项：2-2 视图残留 / 2-11 主题扩散铺满 / 2-6 扫描动画回跳 / 2-9 停止反馈时间线 / 2-14 导出错误路径。桩态确定性运行 + 关键帧截图（每 100ms）供 GPT-5.6 Luna 判读。

### 用法
```powershell
node scripts/dev/u50_repro_probe.mjs [--base http://127.0.0.1:5000/] [--out <目录>] [--with-data] [--video] [--steps view|theme|scan|stop|export|all]
```
- 默认桩态：`addInitScript` 覆写 fetch（零写操作、零真实扫描），确定性复现；
- `--with-data`：连真服务器（Everything 分钟级 busy 窗口照 G8 纪律按「请求发起态」记录）；
- `--video`：对逐帧段启用 Playwright recordVideo（webm 入 `<out>/video/`）；
- `--steps`：按需跑单段。

### 输出（`--out` 目录）
| 文件 | 内容 |
|---|---|
| `result.json` | 全部断言与采样（结构化为各 section） |
| `view-000/100/500/800.png` | 三视图连点关键帧（2-2） |
| `theme-diffuse-*.png` ×7 | 顶栏主题扩散关键帧（2-11） |
| `theme-settings-diffuse-*.png` ×5 | 设置弹窗主题扩散关键帧（2-15 扩散中心） |
| `scan-anim-*.png` ×30 | 整页扫描动画关键帧（2-6） |
| `scan-ring-*.png` ×30 | 环形图特写关键帧（2-6 判读用，clip 到 #overview-donut） |
| `export-error-*.png` | 导出错误路径截图（2-14） |

### 本机运行依赖
- Playwright 来自 DSH profile：`C:/Users/26024/.dsh/profiles/web/node_modules/playwright`（与既有 u2x/u3x 探针一致）；
- **受限沙箱限制**：Node spawn 子进程（chromium 启动）在受限管道捕获下会 `spawn EPERM`。以 **danger-full-access**（或无沙箱）环境运行，或按既有探针方式由外部进程管理 chromium。

---

## 3. 判读通道（GPT-5.6 Luna）

识图/判读必须由图像能力模型（opentoken 网关 `gpt-5.6-luna`，声明 `input:["image","text"]`）执行。DSH 部署中普通 `subagent` 工具强制继承默认模型（无图像能力）；**可指定模型通道 = workflow 工具的 `agent(prompt, {provider:"opentoken", model:"gpt-5.6-luna"})`**。已用该通道完成：
- 7 张既有截图逐图判读（对应手册贰章）；
- u50 探针关键帧判读（2-2/2-6/2-11）；
- 阶段 D：u52/u60 三视口×三态（running/queued/done × 1366/1920/357）+ u59 进度四要素截图判读（11 张全 PASS）。

> ⚠️ 判读环境注记：截图流必须给 **绝对路径**（Luna 子代理工作目录与父代理不同，相对路径会误报「文件不存在」）。

---

## 4. 阶段 D 探针（u58-u60，2026-09-05 新增）

### u58_auto_scan_probe.mjs（D-1 自动扫描恰一次）
- 冷启动（无会话）→ `/api/fullscan/start` POST 计数=1 + 保护键写入；刷新（sessionStorage 保持）→ 0；扫描中刷新 → 恢复运行态不重发；Everything 未就绪 → 0；当日已有快照会话 → 0；自动保存恰一次（save POST=1）；保存失败 → 错误 toast + 手动「立即保存」入口恢复。11/11 PASS。
- ⚠️ 场景 1/6/7 **不得 reset()**（自动扫描链在页面加载即触发，reset 会清掉计数）。

### u59_progress_probe.mjs（D-3b 进度四要素 + ETA 稳定性）
- running 态状态行四要素（总进度 %/已完成 x/y 盘/当前盘/已用时）+ ETA 标注「估算」；两次采样变化 <10% 不更新文案（不闪跳）；queued 无「0/2」误导；reduced-motion 直显。11/11 PASS。

### u60_scan_layout_probe.mjs（D-3b 三视口扫描卡布局）
- 三视口（1366×768/1920×1080/357×651）× 三态（running/queued/done）截图 + 元素 rect 采样（父子嵌套排除后的无重叠判定）+ console 0。9 张 Luna 判读全 PASS。

### 探针隔离纪律（阶段 D 起）
- 旧探针（u13-u57）与 smoke.html 预置 `sessionStorage.pds_auto_started_v1 = "1"`——自动扫描不干扰手动驱动扫描状态机的断言时序；u58 不预置（专测冷启动恰一次）。

---

## 5. 证据包

阶段 A 复现证据（门禁②）：
```
%TEMP%\fix_verif\
├─ result.json              u50 探针全量断言/采样结果
├─ scan-anim-*.png ×30      扫描动画整页关键帧（2-6）
├─ scan-ring-*.png ×30      环形图特写关键帧（2-6 判读）
├─ p13_50round.log          P13 test_budget 连续 50 轮基线（11/50 失败）
└─ fixture_snapshots\       五类快照夹具（session×5 + snap.gz×9）
```

*执行记录：2026-09-02 · 阶段 A（=R0）· 主代理执行 · 零生产代码改动。*

---

## 6. 阶段 P0（2026-09-08）视觉验收工具链与隔离夹具

> 本段为阶段 P0 新增。目标：统一探针引入路径 + 三类帧级/像素级/多视口取证工具正式化 + 三类对比夹具。**P0 硬闸门**：`p00_frame_recorder.mjs` 必须复现问题 2（视图切换残留）的违规帧。

### 6.1 统一引入 `scripts/dev/_harness.mjs`

所有该目录下探针的 Playwright 引入改为：

```javascript
import { chromium, launch } from "./_harness.mjs";
```

- `PW_PATH`（缺省 `C:/Users/Laptop/.dsh/profiles/web/node_modules/playwright`，`PDS_PW` 覆盖）+ `CHROMIUM_EXE`（缺省 `C:/Users/Laptop/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe`，`PDS_CHROME` 覆盖）。
- `chromium` 是 Proxy 包装：`chromium.launch(opts)` 在未传 `executablePath` 且未传 `channel` 时自动注入 `CHROMIUM_EXE`（既有调用 `{headless:true}` 无需改）；传 `channel:"msedge"` 时不注入。
- `launch(opts)` 同语义（默认 `headless:true`）。
- 通用：`arg(name, dflt)`、`wait(ms)`、`shot(page, file, clip)`、`frameRecorderSource()`（页内 rAF 记录器源码，含 `meta()` 暴露 rec.start 供双时钟对齐）、`screencast(page, opts)`（CDP 逐帧像素；**产出 ts 单调不减**，保留 rawTs 供核对，见 `timeline.json` meta）。
- 一次性改造脚本：`node scripts/dev/refactor_probe_imports.mjs [--check]`（仅动引入路径，断言零改动）。

### 6.2 `p00_frame_recorder.mjs`（A 类：DOM 帧 + CDP 像素帧双轨记录）

```powershell
node scripts/dev/p00_frame_recorder.mjs --base http://127.0.0.1:5000/ --out <绝对路径> [--repeats 3] [--with-data] [--quality 60]
```

- **双轨取证据，同一轮序列内同步**：
  - **DOM 轨**：页内 `requestAnimationFrame` 记录器（≈16.7ms/帧），逐帧采样 `#treemap-wrap` 的 `hidden` / computed `opacity` / `elementFromPoint(视区中心)` 归属 / 激活视图 / 运行中动画数；
  - **像素轨**：CDP `Page.startScreencast`（实测 20–46ms/帧，负载相关）在**同一轮序列**内同步采集 JPEG 像素帧，并按「相对触发点」时间戳与 DOM 轨对齐（双时钟锚点：DOM ts=page perf-now−rec.start；px ts=CDP ts−t0；触发瞬间就近读取两时钟，偏差~1–3ms，见 `summary.json`）。
- **采样窗**：触发前 100ms 基线 → 点击切换 → 动画全程 + 200ms 收尾。
- 默认桩态 fetch（确定性复现 treemap/ranking/table/relate 渲染）；`--with-data` 连真后端。
- **违规帧判据（与 `P2-视图切换帧级证据.json` 同口径）**：非活动视图期间 `#treemap-wrap` 无 `hidden` 且 `opacity>0` 且命中测试落回 `treemap-canvas`/wrap 内。
- **输出**：
  - `frames.json`（最差轮全部 DOM 帧）+ `summary.json`（逐轮 帧数/违规帧数/首末违规偏移 + 对齐锚点）；
  - `screencast/px-<seq>-trig+<off>ms.jpg`（最差轮全部像素帧，`off`=相对触发点真实偏移）+ `px-timeline.json` + `px-hashes.json`（每帧 SHA-256）；
  - `violation-window/`（落在 `[首违规 off, 末违规 off] ±5ms` 窗口内的像素帧副本，问题 2 的**像素级残留证据**）；
  - `terminal-relate.png`（终态图，仅观感）。
- **⚠️ 像素证据纪律（P0 返工要点）**：`page.screenshot()` ≈130ms/张，**无法**覆盖 33ms 级违规窗口，**绝不可**当作帧级证据、文件名**不得**带帧时间戳。像素级证据一律走 CDP screencast；`page.screenshot` 只能作终态静态图（无时间戳命名）。
- **硬闸门基线（P2 rank2relate）**：63 帧 / 9 违规 / 首违规 opacity=1 命中 treemap-canvas。P0 v2 实测（排行→关系，3 轮，取轮 1 最差）：**88 DOM 帧 / 9 违规 / badOff=[11,144]ms；16 像素帧，8 张落入违规窗口且 8/8 彼此唯一、7/7 区别于触发前基线** —— DOM 与像素双轨均满足对照，硬闸门通过。
- **像素证据纪律**：像素级帧一律 CDP screencast（见 §6.2 上文）；`page.screenshot`（≈130ms/张）只能作终态静态图、文件名不得带帧时间戳（本工具仅 `terminal-relate.png`，无时间戳）。

### 6.3 `p00_theme_screencast.mjs`（B 类：CDP 逐帧像素 + 圆心量化）

```powershell
node scripts/dev/p00_theme_screencast.mjs --base http://127.0.0.1:5000/ --out <绝对路径> [--duration 1800] [--quality 60]
```

- CDP `Page.startScreencast` 逐帧 JPEG（实测 30–46ms/帧，负载相关）+ 以 `page.mouse.click` 在 `#btn-theme` 中心触发（**记录点击坐标 clickCoord**）。
- 输出：`screencast-frames/frame-<seq>-<ts>ms.jpg`（ts 单调不减）+ `timeline.json` + `brightness.json` + `area.json`（暗区占比曲线）+ **`circle_fit.json`**（每帧暗区边界圆拟合）+ `meta.json`（clickCoord、start/end theme、console 错误）。
- **圆心量化（问题10 / P7 判据 4.3-4：|圆心−点击坐标|≤4px）**：扩散圆圆心=点击点（theme.js `circle(maxR at x,y)`），故以**点击点为圆心的径向残差**（弧上点到点击点距离 vs 半径 rEst 的 RMS）为判据数字 `dev_from_click_px`；半径取边界点到点击点距离的中位数；另附自由 Kasa 拟合 center/radius/residual（部分弧上数值病态，仅参考）。
- P0 实测（1366×768，105 帧）：88 帧可拟合，`dev_from_click_px` min=1.61 / max=2.28 / 均值=1.68px —— **全部 ≤4px**；**PASS/FAIL 仍由 Luna 判**，本工具只给数字。
- **timeline 时间戳口径**：`_harness.screencast()` 的 ts 单调不减（按 seq 稳定序 + 单调夹取），保留 rawTs=CDP metadata 原始推算值供核对（返工2）。
- 判读材料供 P7（问题 10）圆心/面积曲线；结论由 Luna 判。

### 6.4 `p00_viewport_shots.mjs`（C 类：多视口静态截图）

```powershell
node scripts/dev/p00_viewport_shots.mjs --base http://127.0.0.1:5000/ --out <绝对路径> [--viewports "1366x768,1440x900,1920x1080"]
```

- 对工作台/对比/快照三页 × 三视口各 1 张全页截图（默认 1366×768 / 1440×900 / 1920×1080）。
- 输出：`<out>/<视口>/<page>-<w>x<h>.png` + `meta.json`。作为后续阶段（P3/P4/P6）布局对照基线。

### 6.5 `fixture_snapshots.mjs` P0 新增三类夹具

```powershell
node scripts/dev/fixture_snapshots.mjs --dir <夹具根> --now <ISO> --fixture all
# --fixture 取值：all（缺省，五类 + P0 三类）| growth | flat | series 等
```

- `growth`：同一根 D:\ 两时刻，正/负/零增量混合 + ≥4 层深目录链（`D:\apps\framework\core\engine`），用于 P4 问题 5、6。
- `flat`：两时刻完全一致（全 0 增量），用于 P4 问题 6。
- `series`：同根 D:\ 6 个时刻递进总量，用于 P6 问题 8 多快照趋势。
- 与 `snapshots.py` 格式兼容已用项目自身模块校验（`load_snapshot` 19/19、`compare_snapshots` 增量正确、`session.list_sessions` 15 会话）。
- ⚠️ 新增会话时间戳已避开与既有五类的文件名冲突（相同 root+时间戳会产生同名 snap.gz 相互覆盖）。

*执行记录：2026-09-08 · 阶段 P0 · 开发子代理执行 · 零生产代码改动。*