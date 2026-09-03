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
- u50 探针关键帧判读（2-2/2-6/2-11）。

> ⚠️ 判读环境注记：截图流必须给 **绝对路径**（Luna 子代理工作目录与父代理不同，相对路径会误报「文件不存在」）。

---

## 4. 证据包

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