# Python 智能磁盘分析工具

> **当前版本：v2.0.0**（2026-08-30）——Web 界面改版为 **UI 2.0（SpaceLens Pro）**：
> 单屏 App Shell + 子页面路由（`#/` / `#/compare` / `#/snapshots`）+ 主题三态（亮/暗/跟随系统）+
> 命令面板（`Ctrl/⌘K`）+ 键盘矩阵 + 扫描停止接口 + 紧凑档零滚动收口；
> 终端交互模式与数据引擎（Everything SDK / 快照 / 对比）保持同版演进。
> 版本历史：`v0.9.0-p12c`（P12 整改完成线）。

这是一个基于 Everything SDK 的 Windows 磁盘占用分析工具。程序通过 Everything 的索引高速读取文件路径和大小，然后在 Web 界面或终端里按目录展示空间占用，支持进入目录、返回上级、两级刷新、路径跳转、快照保存与历史对比。

## 功能特点

- 使用 Everything SDK 查询文件信息，避免 Python 逐目录慢速遍历。
- 自动按当前 Python 架构选择 `Everything32.dll`、`Everything64.dll`、`EverythingARM.dll` 或 `EverythingARM64.dll`（`everything-SDK\dll` 已自带 32/64 位两个，ARM 变体按需放入即可自动识别）。
- 自动检测 Everything 是否运行；未运行时尝试自动启动并等待数据库就绪。
- 支持 Everything 安装在非默认目录（注册表 / PATH / 常见安装目录均可发现）。
- 自动生成 `config.json` 缓存 Everything 路径，后续启动无需每次查注册表。
- `config.json` 不存在、损坏或路径失效时会自动回退到重新探测。
- 每个目录默认只缓存最大的 50 个文件条目，降低大磁盘扫描时的内存占用。
- 目录条目按需构建并只缓存最近访问的少量目录（有界缓存，上限 128 个目录），进一步降低扫描后的内存峰值。
- 目录大小自底向上汇总，父目录包含全部子目录；汇总止于扫描根，不向扫描根之上的路径传播。
- **Web 版（UI 2.0）**：单屏应用工作台，矩形图 / 排行 / 表格三视图、存储环形图、全量扫描控制与停止、快照管理与历史对比子页面（详见「Web 界面」节）。
- 终端交互式浏览目录占用，支持切换扫描路径。
- 两级刷新：`r` 轻刷当前目录、`R` 深刷全量重建；根目录轻刷走**指纹门**（`compute_fingerprint`，60 秒冷却缓存）——数据未变毫秒级返回「数据未变」，内容变化或探测失败自动升级为深刷；深刷有 60 秒冷却，在途可 `Esc` 取消。
- `/` 路径跳转：根内任意路径直接跳转、不触发重扫，自带最近 16 条跳转历史。
- 快照与历史对比：交互模式干净退出自动保存快照（gzip JSONL + 台账），支持 `--snapshot-dir` 自定义目录、`--no-snapshot` 禁用；非交互模式用 `--baseline` 与基线快照对比并打印 Top-N 变化。`S` 保存快照 / `H` 历史对比 / `h` 帮助键位已注册。
- Web 版目录/对比行内建「打开所在文件夹」「复制路径」行动闭环：≤2 次点击完成定位或复制；文件行不响应点击（0 个额外请求）。
- 启动 Everything 的子进程被绑定到 Windows 作业对象（`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`），程序退出时不会残留孤儿进程。

---

# Web 界面（UI 2.0 · SpaceLens Pro）

`app.py` 提供本地 Flask 服务（仅监听 `127.0.0.1`，默认端口 5000）。以下内容与当前实现逐条对应。

## 1. 单屏应用与布局

- **App Shell 单屏**：顶栏 60px → 路由视区（flex 剩余高度）→ 状态栏 32px；页面本身零滚动（`body overflow:hidden`），滚动只发生在面板内（列表/表格/会话列表等）。`<900px` 宽或 `<640px` 高时退化为传统页面滚动（声明的例外）。
- **顶栏**：品牌标识与标题「Python 磁盘扫描 · 空间分析工作台」；主导航三标签（工作台 / 对比 / 快照，激活态下划线 + 非活动标签消息圆点）；环境健康徽章（就绪/未就绪/检查中三态，点击弹出环境详情：数据目录、驱动状态、DLL、重试环境检测）；命令面板入口（搜索框形态按钮，`Ctrl K` 徽标）；主题切换按钮（亮 ↔ 暗）；开始扫描按钮（扫描中变为微型进度环，点击回工作台）；使用指引；设置。
- **状态栏**：左=「数据保存在 %LOCALAPPDATA%\PythonDiskScanner（快照、清单与配置） · v2.0.0」；右=「Everything 驱动 · 本地服务仅监听 127.0.0.1」+「已选 N 项」（列表多选时出现，清零隐藏）。
- 切换页面不刷新、不重载资源（hash 路由 SPA），浏览路径/多选/扫描状态跨页保持（回灌恢复，不重复发请求）。

## 2. 子页面路由

| 路由 | 页面 | 内容 |
|---|---|---|
| `#/`（默认；未知路由回落） | 工作台 | 路径行（盘符 datalist + 浏览 + 返回上级）→ 最近访问/浏览历史 chips → 面包屑（各层可点击回跳）→ 状态行/环境引导条/内存缓存徽标 → 筛选与排序（名称筛选 / 内容类型 / 排序）→ 视图工具栏 → 视图区（矩形图 / 排行 / 表格 / **关系目录** 四视图）→ 右栏四卡（存储概览 / 全量扫描 / 快照迷你 / 最近对比迷你） |
| `#/compare` | 对比工作台 | 页头（基线快照下拉 + 目标只读 + 开始对比）→ 摘要 3 卡（总变化 / 最大增长 / 可释放，数字滚动）→ 红绿发散图 → 明细表（变化 / 增速 / 路径 / 操作：定位、复制路径） |
| `#/snapshots` | 快照管理 | 页头（创建快照 + 撤销最近保存）→ 趋势卡 ×2（较昨日 / 较上周，差值卡；空态带原因行 + 窗口口径 tooltip）→ 会话分组列表（自动/手动标签、逐盘「对比此快照」、**逐盘/整会话「删除」**、跳过原因悬停提示） |

- 路由切换动效 120ms 页出 + 240ms 页入；切换后焦点移至页头标题。
- **对比口径说明**：对比的「目标」为当前磁盘最新状态（页面以「目标 = 同盘符最新快照」作只读标识）；「基线」为所选（或自动取最近一份）快照。趋势卡/迷你卡点击即预填基线并跳转对比页。
- 空态文案（统一规范）：未扫描「还没有空间索引。先做一次全量扫描，几分钟后这里会长出你的磁盘地图。」；空目录「这个目录是空的。」；无快照「还没有快照。全量扫描后保存一份，变化趋势从这里开始记录。」；未选基线「选择一份基线快照，开始对比两个时间点的空间变化。」；趋势卡无基线「暂无对比基线」+ 原因行（「最近快照 …，超出 N 天窗口，请保存新快照后查看」/「还没有快照，先做全量扫描并保存」）；筛选无结果「没有匹配「…」的条目，试试更短的关键词。」。

## 3. 主题三态（亮 / 暗 / 跟随系统）

- 顶栏按钮：亮 ↔ 暗显式切换（点击即生效；圆形扩散转场 450ms；系统减弱动效时直切）；顶栏切换会写入显式偏好并退出「跟随系统」。
- 设置弹窗：主题分段单选（亮 / 暗 / 跟随系统），选择即生效（与「保存设置」按钮解耦）。
- 「跟随系统」实时跟随操作系统亮暗变化（`prefers-color-scheme` 监听）；偏好持久化 `pds_theme_v1`（`light|dark|system`；缺失/非法 = 跟随系统）；首访默认跟随系统。
- 防闪烁：`index.html` 头部内联脚本在样式生效前设定 `data-theme`，冷启动不闪白/闪黑。

## 4. 命令面板（Ctrl/⌘K）

- 打开方式：顶栏搜索框按钮 或 `Ctrl/⌘K`。
- 本地模糊过滤（子序列命中 + 前缀/精确加权），分组展示：**页面**（三页跳转）、**盘符**、**最近访问**、**浏览历史**（最近 8 条）、**快照**（未跳过盘）、**命令**（开始扫描、保存快照、开始对比、导出 CSV、导出 JSON、切换主题、打开设置、使用指引）。
- `↑` `↓` 循环选择、`Enter` 执行、`Esc` 关闭；面板视作浮层入弹窗栈（弹窗打开时触发键忽略）。

## 5. 键盘矩阵

单键快捷键仅在事件目标非输入框/非可编辑元素、且输入法组词中（`isComposing`）一律忽略：

| 键 | 行为 | 备注 |
|---|---|---|
| `Ctrl/⌘K` | 打开命令面板 | 顶栏搜索框唯一快捷键 |
| `Esc` | 关闭浮层（按打开逆序）/ 退出视图全屏 | 弹窗栈管理 |
| `R` | 快捷刷新当前目录 | 弹窗打开时忽略 |
| `Backspace` | 返回上级目录 | 输入框内不触发 |
| `Enter` | 下钻：列表行（既有）或矩形图焦点块（=单击语义） | 焦点位于矩形图容器时 |
| `/` | 聚焦筛选框 | 仅工作台；其他路由为空守卫 |
| `g` `c` / `g` `s` | 连按跳 `#/compare` / `#/snapshots` | vim 风格，首次 `g` 后 800ms 窗口；超时/其他键/修饰键重置 |
| `↑` `↓` `←` `→` | 矩形图聚焦后：最近邻移动焦点块 | 箭头键仅当焦点在矩形图容器内消费，不抢列表/页面滚动 |

- 焦点环全局统一 2px primary / offset 2（`:focus-visible`）；矩形图容器可键盘聚焦（Tab 进入，从最大块起）；路由切换后焦点移至页头标题；toast 容器 `aria-live=polite`；矩形图容器带 aria-label 摘要（当前目录、条目数与最大子项）。
- 增/减信息一律叠加 ▲/▼/± 符号冗余（灰度截图可辨），不单靠红绿颜色。

## 6. 工作台视图区

- **矩形图（Treemap，默认视图）**：squarified 布局；10 色固定调色板按目录名哈希取色（跨导航颜色稳定，同一目录永远同色）；小于合并阈值的条目并入「其他」合并块（中性灰蓝）；单击=下钻（FLIP 转场 450ms），双击=回到本级根；悬停高亮 + tooltip（名称 / 大小 / 占比 / 点击下钻，150ms 延迟）；标签三级（≥48px 全量 / 24–48px 仅名称 / <24px 无；>1500 块隐藏小标签）；扫描中实时生长；仅扫描中的雷达扫掠特效（reduced-motion 关闭）。
- **迷你条带**：矩形图视图上方 48px 上级目录构成条带（静态，色块可点击跳回；无上级缓存自动隐藏）。
- **排行 / 表格**：`120ms` 交叉淡化切换；排行=占比条 + 数字（`font-variant-numeric: tabular-nums`）；表格列=名称 / 类型 / 大小 / 占比（独立 5 列：复选/名称/大小/占比/类型）。
- **关系目录（阶段C·C-7）**：第 4 视图「关系」= 父子层级树（D3 裁定）：树根=当前浏览数据，目录行可展开（`▸` caret + 文件夹图标）、文件为叶子；**懒展开**= 单击目录行走 `browsePath` 下钻（复用既有加载，1 次/节点按需请求）；>200 子项虚拟化（行高 cozy 36 / compact 26 同列表口径）；键盘可达（`↑↓` 移动、`→`/`Enter` 下钻展开、`←` 返回上级、`Home`/`End` 首尾）；与矩形图/排行/表格互斥终态（防视图残留，同 C-1 断言面）。
- **密度差异（阶段C·C-8，手册 2-12 推荐方向）**：cozy=完整图标 + 占比条；compact=隐藏尺寸条与行图标（仅名称 + 数值，高密度极简）；行高 cozy 36px / compact 26px（虚拟滚动实测，u24 断言面同步）。
- **多选与导出**：复选框 + `Shift` 范围选；页脚 sticky「共 N 项 · 已选 N 项 · [定位所选] [导出所选 CSV]」；CSV 由前端生成（UTF-8 BOM，Excel 可直接打开，列表头 名称/路径/类型/大小(字节)/大小(可读)）。
- **虚拟滚动**：超过 200 行启用，固定行高（舒适 36px / 紧凑 26px）零漂移，滚动窗口重渲染不重放入场动画。
- **视图工具栏**：`−/+` 调整「其他」合并阈值（仅矩形图视图；默认 24，步长 10，范围 1–200）；「紧凑列表/舒适列表」密度切换；「全屏」= 视图区铺满（`Esc` 退出）。
- 行内操作（目录行 hover 显示）：下钻 / 打开所在文件夹 / 复制路径；文件行不响应点击（0 个额外请求，红线语义）。

- **缓存徽标（阶段B·B-13/B-14）**：浏览响应 `source: index|sdk|scanning`——`index` 显示「来自全量扫描索引（完成于 …）」；`sdk`（真实 SDK 直扫）**不显示**缓存徽章（不再靠字段缺失猜测来源）；`scanning` 显示「扫描中」；`browsesCache` 缓存条目一并落地 source 与时间戳，回灌时恢复徽章（同路径重复浏览缓存命中不产生新 `/api/browse`）。

**右栏卡**（300px）：

- **存储概览卡**：环形图（已使用之环比——接口无真实容量字段，故不伪装成磁盘容量百分比）+ 盘符 chips（点击只切换环形图数据、不切换浏览目录；「浏览此盘」是唯一跳转浏览入口）+ 图例两行（本盘已用/全部盘累计）；全量扫描中自动跟随当前盘，用户手选后本扫描期内锁定；卡头含导出 CSV / 导出 JSON（阶段B·B-12 移入结果区，可用性=完成/中止部分根，扫描中禁用）。
- **全量扫描卡**：开始/停止/保存快照 + 「？」引导气泡（可折叠扫描提示块；阶段B·B-12 重排，导出按钮移概览卡）。
- **快照迷你卡**：最近一份快照（时间 + 自动/手动标签），点击跳对比页；「管理快照」直达 `#/snapshots`。
- **最近对比迷你卡**：最近一次对比摘要（▲/▼ + 变化量），点击跳 `#/compare`。

## 7. 扫描控制与停止

- **空闲**：「开始全量扫描」按钮（顶栏同步按钮，扫描中变微型进度环、点击回工作台并高亮扫描卡 + toast「扫描进行中 x%」；空闲点击进入「启动中…」提交态，提交结果经状态广播收敛）。
- **排队中**（阶段B·B-8）：SDK 锁被浏览/对比/上一轮尾段占用时，状态行显示「等待扫描引擎空闲…（扫描任务已提交，正在排队）」+ 盘符 chips 保持待办灰（不显示误导性「0/2 扫描中」）；前端轮询降频 2s。
- **扫描中**：进度条斜纹流光 + 头部亮点；状态行整合「总进度 % · 已完成 x/y 盘 · 当前 C:\」+ 已用时 + 预计剩余 ~T（估算，基于根间均速，标注「估算」不闪跳）；盘符 chips（已完成 ✓ / 进行中脉冲 / 待办灰）；按钮变红描边「停止」；扫描中可继续浏览已完成盘（当前盘返回进行中提示）。
- **完成**：进度条绿光扫过 + 条尾对勾描边 + 16 粒粒子庆祝（仅主页可见时播）+ 保存提示（立即保存 / 暂不保存，K7 防重复提示）。
- **停止（D10 + 阶段B·B-9/B-10）**：`POST /api/fullscan/stop`；停止请求 → 100ms 内状态行固定「正在停止…（等待扫描引擎响应）」、停止按钮禁用且保持红色激活态、chips 不重绘（任何轮询不覆盖停止文案）；最终「已停止，已完成部分可浏览」+ `stop_reason:user`；`status()` 透出 `stop_ack_at`。后端未上线时按钮自动隐藏（`OPTIONS` 特性探测，静默）。
- **返回重开自动恢复**：启动即轮询 `/api/fullscan/status`；若仍在运行直接进入扫描中态，无需手动检查。
- 停服（Ctrl+C / 进程退出）会协作取消在途扫描（最多等 5 秒收尾），与用户停止语义相互独立（`stop_reason: user | shutdown`）。
- **状态机（阶段B·B-7）**：`phase: idle/queued/scanning/finishing`——锁等待期=queued；`status()` additive `lock_holder`（fullscan/browse/compare 持有者）；看门狗：单盘 15 分钟无行更新 → `error="SDK 无响应"` 并协作取消（绝不硬杀线程）；`row_done/row_total` 估算行计数（UI 标注「估算」）。
- **日志策略（阶段B·B-17/B-20）**：Web 启动默认 `utils.VERBOSE=False`（`--verbose` 恢复 🧭 系列）；Werkzeug access log 默认 WARNING+（成功请求不再刷屏，`--debug-log` 保留开发调试日志）；错误与异常堆栈始终可见（不静默真正错误）。

## 8. 布局保证：零滚动与紧凑档

- 桌面断点（≥900px 宽 且 ≥640px 高）：1920×1080 与 1366×768 两档下主页 + 两个子页面 `body` 均零滚动；列表 5000 行、快照 50 份、对比 2000 行时仍零滚动（面板内滚生效）。
- **1366×768 紧凑档**（`max-height:820px`）：右栏自动收紧——折叠次级说明文案（保留主文案与动作）、卡内 padding/间距收紧、图例单行；整页无内滚、无溢出。
- 1920×1080 常规档在「扫描完成 + 保存提示条」满态下右栏出现面板内滚 = 声明允许的说明项（仅紧凑档保证无内滚）。
- 动画红线：仅 transform/opacity 过渡与动画（已知例外：占比条/进度条 width、扫描斜纹 background-position、顶栏扫描环 stroke-dashoffset，均为规格内参数）；`prefers-reduced-motion` 下循环动画静止、入场直显、转场直切、装饰性粒子/描边不播（功能性反馈保留 ≤120ms）。

## 9. 本地启动

```powershell
python app.py                  # 默认自动打开浏览器 http://127.0.0.1:5000/（日志策略：VERBOSE 关 + access log WARNING+）
python app.py --no-browser     # 只启动服务不打开浏览器（打包冒烟用）
python app.py --verbose        # 恢复 CLI 风格启动日志（🧭/🔎/🔌/✅ 系列）
python app.py --debug-log      # 保留 Werkzeug 完整 access log（开发调试；默认仅 WARNING+）
```

- 重复启动复用已有实例：检测到 `127.0.0.1:5000` 已有本工具实例时直接打开其页面并退出。
- 配置与数据目录：`%LOCALAPPDATA%\PythonDiskScanner`（快照、清单、配置；可经设置弹窗查看，危险区可一键清空——输入「确认清空」后 3 秒倒计时解锁）。

---

## 运行环境

- Windows（本程序仅支持 Windows，见下方「已知边界」）
- Python 3.9 或更高版本
- Everything 1.4.x
- Everything SDK DLL
- 交互界面终端窗口高度建议至少 12 行（低于约 12 行时列表区被压缩、横幅提示「终端过小」）

当前项目已包含 `everything-SDK` 目录，目录结构如下：

```text
文件大小扫描/
  main.py
  cli.py
  env.py
  exceptions.py
  sdk.py
  scan.py
  tui.py
  utils.py
  keyrouter.py
  messages.py
  snapshots.py
  compare.py
  app.py
  fullscan.py
  session.py
  datadir.py
  web/
  tests/
  requirements.txt
  README.md
  everything-SDK/
    dll/
      Everything32.dll
      Everything64.dll
```

ARM/ARM64 版 `EverythingARM.dll`、`EverythingARM64.dll` 按需放入
`everything-SDK\dll` 后，程序会自动按当前 Python 架构选择对应的 DLL。

### 已知边界

本程序仅面向 Windows 运行：

- Everything SDK 通过 `ctypes` 加载调用，Everything 服务本身是 Windows 专属程序。
- 数据口径：Everything 未返回大小（「大小未知」哨兵 2^64-1）、读取失败或超过
  卷容量/16TB 兜底上限的条目不计入聚合，界面（TUI 轻刷摘要等）会标注
  「N 条大小未知」；历史快照中包含 ≥16TB 异常大小行时，加载对比会提示该基线
  含已知异常数据，建议重扫重建基线。
- 自动启动 Everything 时使用 Windows 作业对象（Job Object）沙盒，程序退出即终止由其启动的子进程，避免孤儿进程残留。
- 交互界面按键读取依赖 `msvcrt`：该导入是受保护的（`try/except ImportError`），非 Windows 平台 `import main` 不会崩溃，但进入交互界面时会抛出 `MsvcrtUnavailableError`（中文提示「请在 Windows 上运行」），由上层统一捕获后优雅退出。
- Everything.exe 注册表定位依赖 `winreg`：同样是受保护导入，非 Windows 平台自动跳过注册表候选路径。
- 「打开所在文件夹」经 `explorer /select` 实现：接口返回 `launched:true` 仅代表
  进程拉起成功，explorer 自身定位失败（如路径含逗号、事后被删除）仍为静默，
  此时以「复制路径」作为兜底。
- 空目录/0 字节条目口径：扫描结果会保留空目录与 0 字节条目；快照单份上限
  `MAX_ROWS=500000` 行，超限拒绝保存（提示缩小扫描根范围），开关版入 backlog。
- 闲置资产归宿（P12·W3.3 声明）：`snapshots.scan_snapshot_dir` 与
  `messages.INFO_SNAPSHOT_AUTO` 当前无生产调用方，「保留待接」（P13 候选：
  快照健康自检透出），本轮不删不改。

## pip 依赖

- **CLI/TUI**：仅 Python 标准库，零第三方依赖。
- **Web 版**（`app.py`）：需要 `pip install flask`（或 `pip install -r requirements.txt`，
  内含 `flask>=3.0.2`）。

Everything 访问依赖程序目录中的 `everything-SDK\dll\*.dll`，不经 pip 安装；
`requirements.txt` 中另有可选打包工具 pyinstaller 的提示。

## Everything 安装要求

客户机器需要安装 Everything，或者至少能让程序找到 `Everything.exe`。

程序会按以下顺序查找：

1. `config.json` 中缓存的 `everything_exe`
2. 程序目录下的 `Everything.exe`
3. 注册表中的 Everything 安装信息
4. 系统 `PATH`
5. 常见安装目录：
   - `C:\Program Files\Everything\Everything.exe`
   - `C:\Program Files (x86)\Everything\Everything.exe`

如果客户没有安装 Everything，程序会提示无法定位 `Everything.exe`，需要先安装 Everything 或将 `Everything.exe` 放到程序目录或 `PATH` 中。

## 配置文件

程序会自动生成 `config.json`，示例：

```json
{
  "everything_exe": "D:\\Everything\\Everything.exe",
  "everything_dll": "D:\\.python\\文件大小扫描\\everything-SDK\\dll\\Everything64.dll",
  "everything_startup_args": [
    "-startup"
  ]
}
```

说明：

- `config.json` 位于统一数据目录 `%LOCALAPPDATA%\PythonDiskScanner\config.json`；
  项目目录下的 `config.json` 仅为首次默认模板、不会被改写（P12·W2.13 D4 修订）。
- 不需要手动创建 `config.json`。
- 如果文件不存在，程序会自动探测并在成功启动 Everything 后写入。
- 如果 JSON 损坏或路径失效，程序会忽略缓存并重新探测。
- 启动失败时不会写入配置，避免缓存错误路径。
- 为避免 DLL 劫持风险，`everything_dll` 只有位于程序目录内时才会被采纳；指向外部目录的 DLL 路径会被忽略并重新按架构选择 SDK DLL。
- `everything_startup_args` 是自动启动 Everything 时使用的命令行参数，现已真正生效：
  - 仅接受「非空且元素全为字符串的数组」；其余脏数据（`null`、非数组、空数组、含非字符串元素等）一律回退到默认 `["-startup"]`，绝不因脏配置导致启动失败；
  - 自动启动时会依次尝试「配置参数 → 默认 `["-startup"]` → 不带参数」，重复的命令自动去重；
  - 启动成功后，会把本次实际使用的参数回写进 `config.json`，下次启动沿用它。

## 使用方法

建议先手动打开 Everything，并等待它完成索引加载。这样程序可以直接复用已加载的 Everything 数据库，启动和首次扫描速度会更快。

启动时程序会先检查 Everything 进程是否存在：

- 如果当前用户会话中没有 Everything 客户端，程序会立即尝试自动启动，并默认等待最多 20 秒让 IPC 和数据库就绪。
- 如果当前用户会话中已有 Everything 客户端，程序不会重复启动，只等待最多 20 秒让 IPC 和数据库就绪。
- 如果只检测到 Session 0 / Services 中的 Everything 后台进程，不会把它当作当前用户可用客户端，程序仍会尝试启动当前用户会话中的 Everything。

超过该时间仍未就绪时，建议手动打开 Everything，确认主窗口可以正常搜索后再运行本工具。

在 PowerShell 中运行：

```powershell
python <project PATH>\main.py
```

根据提示输入扫描路径，例如：

```text
D:\
```

进入交互界面后（键位与界面底部「操作指引」行同源，由 `keyrouter` 注册表自动生成）：

- `W` / `↑`：向上移动光标；`s` / `↓`：向下移动光标（方向键与 Alt+方向键均支持）
- `Enter`：进入选中的目录（仅对目录项生效，文件项不响应）
- `Backspace`：返回上级目录（不能高于扫描根）
- `C`：切换扫描路径，按提示输入新路径（例如 `C:\` 或 `D:\Downloads`），路径有效则重新扫描并进入
- `r`：轻刷当前目录（只刷新当前目录的直接子项，不重建整棵树）
- `R`：深刷全量重建（重新执行完整扫描；60 秒冷却，冷却期间按 `R` 只提示不执行；在途深扫按 `Esc` 取消）
- `/`：路径跳转（在扫描根内输入任意路径直接跳转，不触发重扫；支持最近 16 条跳转历史）
- `S`：保存快照（键位已注册，见「快照与自动保存」）
- `H`：历史对比（键位已注册，现阶段命令行入口为 `--baseline`，见「历史对比」）
- `h`：帮助（键位已注册）
- `Q`：退出程序（干净退出会自动保存快照，见「快照与自动保存」）

### 终端要求

交互界面采用 ANSI/VT 渲染（不可用时自动回退逐帧 `cls`）。终端窗口高度建议
**至少 12 行**：低于该下限时列表可视区被压缩，界面横幅会提示「终端过小」；
终端较窄时目录名会截断显示（超长部分以 `...` 省略）。

### 非交互模式：命令行参数

提供扫描路径 `TARGET` 位置参数即进入非交互模式：扫描后打印 Top-N 目录占用报告并
退出，不进入交互界面。（交互模式下 `--top/--quiet/--export/--output/--baseline`
一律被忽略；`--snapshot-dir` 与 `--no-snapshot` 两种模式都生效。）

```powershell
python <project PATH>\main.py D:\
python <project PATH>\main.py D:\ --top 20
python <project PATH>\main.py D:\ --quiet
python <project PATH>\main.py D:\ --export csv
python <project PATH>\main.py D:\ --export json --output D:\reports\disk_20260821.json
python <project PATH>\main.py --snapshot-dir D:\snapshots
python <project PATH>\main.py --no-snapshot
python <project PATH>\main.py D:\ --baseline D:\snapshots\data_20260821_153000_auto_1a2b3c4d.snap.gz
```

| 参数 | 说明 |
|---|---|
| `TARGET` | 可选扫描路径（如 `D:\`、`C:\Users`）；提供后进入非交互模式，缺省进入交互模式 |
| `--top N` | 非交互模式下屏幕 Top-N 报告的目录条数，1-200，默认 10；交互模式下忽略 |
| `--quiet` | 非交互模式下仅输出 Top-N 报告与错误信息，抑制 🚀/🧩 等过程日志与扫描进度行（\r），便于下游脚本逐行解析；交互模式下忽略 |
| `--export {csv,json}` | 把目录占用报告导出到文件：csv 或 json。导出**全部目录**（含扫描根与各级子目录）的聚合占用大小，不受 `--top` 限制；仅目录级聚合大小，不含文件明细；`--quiet` 不影响导出文件生成，屏幕 Top-N 报告照常打印。交互模式下忽略 |
| `--output PATH` | 导出文件路径，需与 `--export` 搭配使用；未指定时在当前目录自动命名 `disk_report_YYYYMMDD_HHMMSS.<后缀>`，格式后缀跟随 `--export`（csv 或 json）。交互模式下忽略 |
| `--snapshot-dir PATH` | 覆盖快照存储目录（等效设置环境变量 `DSA_SNAPSHOT_DIR`）；交互与非交互模式都生效。不指定时用默认目录（见「快照存储位置」） |
| `--no-snapshot` | 禁用快照自动保存（等效设置 `DSA_NO_SNAPSHOT=1`）：交互模式干净退出不再自动落盘退出快照；显式保存同样被禁用 |
| `--baseline PATH` | 非交互模式下指定基线快照文件（`.snap.gz`）：加载该快照并与本次扫描结果对比，按变化量打印 Top-N 对比报告（`compare.format_row` 版式）；基线文件缺失/损坏 → 中文提示 + 退出码 1。交互模式下忽略 |

退出码约定：

- `0`：扫描完成（含按需导出/对比），正常结束；
- `1`：致命错误——扫描路径不存在、Everything 环境未就绪、扫描失败、导出文件写入失败、`--baseline` 文件缺失或损坏、对比失败（跨盘/跨根）；
- `2`：命令行参数错误（例如非法的 `--top` / `--export` 取值，或 headless 下单独给出 `--output` 未搭配 `--export`）。

CSV 导出格式：首行表头 `路径,大小(字节),大小(可读)`，其后每行一个目录（含扫描
根），按聚合大小降序；文件以 UTF-8 BOM（utf-8-sig）编码，Excel 可直接打开且中文
不乱码；路径中的逗号、引号按 CSV 规范自动转义，可原样读回。

JSON 导出格式：

```json
{
  "scan_root": "D:\\",
  "exported_at": "2026-08-21T15:30:00",
  "total_size_bytes": 123456789,
  "directories": [
    {"path": "D:\\a", "size_bytes": 100, "size_human": "100.00 B"}
  ]
}
```

`exported_at` 为 ISO 8601 格式的本地时间；`total_size_bytes` 为扫描根的聚合总大小；
`directories` 为目录级明细（`path` / `size_bytes` / `size_human`），按聚合大小降序
排列，含扫描根自身。

## 快照与自动保存

快照是磁盘扫描树的可持久化副本，用于历史对比。一套快照 = 一份 gzip 压缩的
JSONL 文件（首行头部 JSON，其后每行一个 `{"p": 路径, "s": 大小}` 目录记录）。

### 保存触发

- **干净退出自动保存**：交互模式正常退出（`Q` 或主流程正常结束）时自动保存一次，
  条件为「自动保存未禁用 且 本会话完成过 ≥1 次完整扫描」，并经过**四原子谓词**
  判定（任一不满足即不落盘）：
  1. 完整树（`tree_complete`）：本次扫描是完整扫描树（刷新/跳转/中断产生的
     不完整树永不落盘）；
  2. 非脏（`dirty`）：扫描期间无脏标记；
  3. 指纹变化（`fingerprint`）：根目录指纹（`scan.compute_fingerprint`，文件数/
     目录数/根 mtime）与台账中该根上次记录不同（无台账视为变化）；
  4. 当日未落（`date`）：同一根当天尚未自动落盘过（每根每日最多 1 份自动快照）。
- **显式保存**：`S` 键位已注册（显式保存入口随交互界面批次接线）；显式保存
  超「当日写量」上限时**仍会保存成功**，但界面给出软警告提示
  （「今日写入量已超上限，本次仍已保存」）；滚动保留最新 30 份。
- **Web 版**：全量扫描完成后工作台扫描卡出现保存提示「立即保存 / 暂不保存」；
  快照管理页可「创建快照」与「撤销最近保存」；设置弹窗可开启「扫描完成自动保存」。
- **Web 版快照删除（阶段C·C-2/C-3）**：快照管理页会话列表每行提供「删除」（单盘）
  与「整会话删除」按钮（`confirmDialog` 确认弹窗）；调用 `POST /api/snapshot/delete`
  （`{session_id, root}` 单盘 / `{session_id}` 整会话；目录边界校验复用
  `resolve().relative_to(snapshots_root)`；删除快照文件 + 更新 session JSON
  （无剩余条目删 session 文件）+ 台账 `ledger_backup` 一致语义；幂等
  `{deleted:true, already:true}` 不报错；扫描中 409 拒绝；响应含逐目标成败清单）。
  删除成功后刷新列表（已删项不再出现）并清 `trendCache` 中涉及被删基线的条目
  （防趋势卡缓存陈旧）；删除后 `/api/compare` 用已删基线 → 400「基线不存在」。

### 快照存储位置

按以下优先级解析：

1. `--snapshot-dir PATH` 命令行参数（写入环境变量 `DSA_SNAPSHOT_DIR`）；
2. 环境变量 `DSA_SNAPSHOT_DIR`；
3. 默认目录：`%LOCALAPPDATA%\PythonDiskScanner\snapshots`；若程序目录存在
   `portable.flag` 便携标记，则改为跟随程序目录 `<程序目录>\snapshots`。

禁用：`--no-snapshot` 或环境变量 `DSA_NO_SNAPSHOT`（非空且非 `'0'`）会关闭一切
快照落盘（自动保存与显式保存都被禁用）。

### 文件格式与命名

- 文件名：`{根名}_{YYYYMMDD_HHMMSS}_{auto|explicit}_{机器标识前8位}.snap.gz`
  （根名取扫描路径 basename，非法字符净化为 `_`）；
- 头部（首行 JSON）：`format`（版本 1）/ `machine_guid`（机器标识）/ `root`
  （扫描根绝对路径）/ `created_at` / `auto`（是否自动保存），附字段序 CRC 校验；
- 其后每行一个目录记录：`{"p": "D:\\data", "s": 1048576}`；
- 写入流程：临时文件 → gzip 逐行写 → 一次 `flush + fsync` → `os.replace` 原子
  替换；并发写用锁文件互斥，冲突抛「另一个快照保存正在进行」类提示；
- 大小上限：单份不超过 50 万行；写盘前检查当日全局写量（默认 102.4 MiB/天）。
  **近似语义声明**：同机多个写者经 `.snapshot.lock` 串行、配额检查与记账都在
  锁内完成；跨进程对 `day_writes.json` 的读改写存在有界 TOCTOU，极端并发下
  单日写入量可能略微超出预算，属可接受行为，不作为精确承诺。

### 台账与滚动保留

快照目录下维护 `ledger.json` 台账：记录每个根的「最后指纹 / 末次自动保存日期 /
当日自动次数」，是四原子谓词第 3、4 条的判定依据；自动保存落盘成功后账目顺带
更新。同根同模式的旧快照按时间滚动清理：自动快照保留最新 10 份、显式快照保留
最新 30 份。

## 历史对比

`--baseline PATH` 在非交互模式把**本次扫描结果**（不落盘）与基线快照做 diff：
按**带符号 delta 降序**排列（增长在前、缩减在后），取前 `--top N` 条，每行由
`compare.format_row` 渲染（右对齐带符号变化大小 + 增速列为辅列；增幅列仅对
基线 ≥ 1 MiB 的目录计算，小基数显示 `-`）。删除的目录标负 delta，新增目录标正 delta。

跨机器基线（P12·W2.13）：对比默认携带本机 `machine_guid` 强校验——基线来自
其他机器时三端（CLI/Web/TUI）一律拦截；CLI 用 `--allow-other-machine`、Web/TUI
用确认键可显式放行（数字仅供参考）。

示例输出（Top 3）：

```text
与基线快照对比 Top 3（基线: D:\snapshots\data_20260821_153000_auto_1a2b3c4d.snap.gz）:
   +12.34 MB      +5.00%  D:\data
   -8.10 MB      -2.00%  D:\old
   +1.00 KB         -    D:\new
           合计变化 | 基线 1.20 GB → 当前 1.21 GB（共 4 条差异）
```

约束与口径：对比要求快照格式版本一致；root 由两域路径集合的公共前缀推导，
跨盘（如基线在 `C:`、扫描在 `D:`）拒绝并提示；行数据不携带机器信息，严格
机器一致性校验由 `load_snapshot` 在加载基线时完成。

合计口径（CLI / Web / TUI 三端一致）：**取扫描根行聚合值（根行缺失时回退
顶层行求和），不再逐行累加**——根行的聚合值已包含全部后代，明细行累加会把
祖先与后代重复计数。Web 端对比排行默认仅展示叶子目录（祖先行的变化已由其
叶子承载）。基线快照含 ≥16TB「已知异常大小」行时，三端均提示
「基线含 N 条已知异常大小数据，建议重扫重建基线」。

## 项目结构

代码按职责拆分为多个模块（由最初的单文件 `main.py` 演进而来，`main.py`
仅保留入口与兼容层）：

```text
main.py          程序入口与兼容层：运行 python main.py 时调用 cli.main()；
                 同时把拆分后各模块的公共/下划线名字全量导回 main 命名空间
                 （含 snapshots/compare/keyrouter/messages 与 scan
                 的新增 API），并动态转发可变全局（DLL_PATH / VERBOSE /
                 _ANSI_AVAILABLE / _GLOBAL_JOB_HANDLE / _getch / msvcrt /
                 winreg 等），保证旧脚本 import main 后按 main.<名字> 使用
                 API 的写法不变
cli.py           命令行装配层：主控制流——提示输入扫描路径、初始化作业对象
                 沙盒、确保 Everything 运行环境就绪、执行 SDK 扫描、进入
                 交互界面并处理切换路径/退出；D9 起提供 --snapshot-dir /
                 --no-snapshot / --baseline 参数，交互正常退出统一归口
                 干净退出自动保存（_auto_save_on_exit）
env.py           运行环境协调：config.json 读写、Everything.exe 定位（注册表 /
                 PATH / 程序目录 / 常见安装目录）、进程与会话判定（识别 Session 0
                 后台进程）、Windows 作业对象防孤儿沙盒、Everything 启动与
                 IPC/数据库就绪等待（默认 20 秒超时）
sdk.py           Everything SDK 封装与 Win32 常量：DLL 架构选择（32/64/ARM/ARM64）、
                 SDK 函数签名声明、IPC/数据库健康检查；DLL_PATH 模块级全局在此
scan.py          高速扫描：三阶段扫描主流程（文件收集 + 每目录最大 50 文件、
                 目录树构建、自底向上汇总）、扫描根判定（汇总止于扫描根）、
                 LazyContents 按需构建的有界缓存；D4 增加指纹门
                 （compute_fingerprint / FINGERPRINT_CACHE / fingerprints_equal /
                 clear_fingerprint_cache）、轻刷（light_refresh）与深刷
                 （deep_refresh，可取消，ScanCancelledError）
tui.py           终端交互界面：msvcrt 受保护导入与统一按键读取 _getch、ANSI/VT
                 渲染（不可用时回退 os.system('cls')）、交互主循环；键位分发、
                 两级刷新 r/R 与路径跳转 / 接在 keyrouter 动作上
keyrouter.py     键位注册表与纯函数按键分发：KEY_BINDINGS 单数据结构描述全部
                 注册键位（含 ACT_SAVE_SNAPSHOT=save_snapshot / ACT_HISTORY=
                 history / ACT_HELP=help 动作常量），help_text() 由注册表自动
                 生成操作指引行，禁键黑名单（Ctrl+C/Tab/F 键等）
messages.py      横幅文案模板资产：模板 ID（BANNER_TEMPLATES）+ render_message /
                 list_template_ids，错误/状态文案与界面层同源、不散落
snapshots.py     快照模块：自动/显式保存（四原子谓词、日配额、原子写、并发锁）、
                 台账 ledger.json、滚动保留、读取/列表/自检（save_snapshot /
                 load_snapshot / should_auto_save / load_ledger /
                 get_snapshot_dir / is_snapshot_disabled 等）
compare.py       历史对比引擎：compare_snapshots / diff_from_current（内存树与
                 基线快照对比）/ top_growth / format_row，纯引擎不做 UI
app.py           Web 版 Flask 应用：API 契约（/api/health /api/overview
                 /api/browse /api/open-path /api/fullscan/start|stop|status
                 /api/save /api/save/undo /api/snapshots /api/compare
                 /api/settings /api/export /api/admin/wipe）+ 单页壳服务
fullscan.py      Web 版后台全量扫描：多盘串行、GLOBAL_SCAN_LOCK、
                 USER_STOP_EVENT（用户停止）与 CANCEL_EVENT（停服取消）隔离、
                 status() 聚合轮询
session.py       Web 版快照会话台账：save_session / 会话分组数据结构
datadir.py       数据目录（%LOCALAPPDATA%\PythonDiskScanner）管理：路径、清空、
                 重建为空结构
web/             前端资源：templates/index.html（App Shell 单页壳）+ static/
                 （css/tokens.css 设计 token、css/style.css、js/app/** 模块）
utils.py         通用工具：应用名、日志开关、human_size、致命错误出口、
                 应用目录与配置路径
exceptions.py    公共异常：MsvcrtUnavailableError、EverythingEnvironmentError
tests/           单元测试与前端冒烟：test_cli / test_env / test_export /
                 test_scan / test_sdk / test_tui / test_utils /
                 test_snapshot_golden / test_api_contract / test_compare /
                 test_budget / test_fullscan 等（共 266 项，见「开发验证」），
                 及 tests/web/smoke.html（传输层打桩的浏览器冒烟页，A0–A20）
everything-SDK/  Everything SDK DLL（dll\ 下为 Everything32.dll、Everything64.dll）
```

`config.json` 是本机运行时缓存，会自动生成。项目迁移或分发时可以删除它，程序会重新探测并生成。

## 部署方法

### 源码部署

1. 安装 Python 3.9+。
2. 安装 Everything。
3. 将全部 `.py` 模块（`main.py`、`cli.py`、`env.py`、`sdk.py`、`scan.py`、`tui.py`、`utils.py`、`exceptions.py`、`keyrouter.py`、`messages.py`、`snapshots.py`、`compare.py`）、`requirements.txt`、`README.md` 和 `everything-SDK` 放在同一目录。
4. 运行：

```powershell
python main.py
```

Web 版部署与停服行为（P12·W2.10 / UI2·U3.2）：

- **重复启动复用已有实例**：启动前探测 `127.0.0.1:<port>/api/health`，若已有
  实例在运行则直接打开已有页面并退出，不再二次监听（消除僵尸双 LISTENING）。
- **退出时取消后台扫描**：Ctrl+C / 进程退出会协作取消在途后台全量扫描
  （等待最多 5 秒收尾），已完成盘的结果保留、日志无裸 traceback。
- **Web 界面可主动停止扫描**（U3.2·D10）：扫描控制卡的「停止」按钮调用
  `POST /api/fullscan/stop`（运行中停止、空闲幂等不报错）；停止后已完成盘的
  结果保留、可继续浏览与保存快照。停止请求与停服取消相互独立、语义不混淆。
- Web 界面入口与操作详见上方「Web 界面（UI 2.0 · SpaceLens Pro）」节。

### 可选：打包为 exe

依赖 `PyInstaller`（可选工具），按需安装：

```powershell
pip install pyinstaller
```

**Web 版（推荐，Phase 5 起）**：一键打包 Flask 本地 Web 应用为单 exe
（含 `web/` 界面、自绘图标，双击启动自动开浏览器，无黑窗）：

```powershell
.\scripts\build_web.ps1            # 若 .tools\upx 存在则自动 UPX 压缩
.\scripts\build_web.ps1 -NoUpx     # 跳过 UPX（个别杀软误报时用）
```

产物在 `releases\PythonDiskScanner-web\`：`PythonDiskScanner.exe`（约 9.5 MB）
+ `everything-SDK\dll\`（32/64 位 DLL 随包提供）+ `使用说明.txt`，
另有同名 zip 分发包。图标由 `scripts\make_icon.py`（纯标准库）生成；
spec 位于 `packaging\pyinstaller\python-disk-scanner-web.spec`。

**终端版（旧）**：仍可打包 CLI 工具：

```powershell
pyinstaller main.py
```

打包后需确保 exe 同级目录存在 `everything-SDK\dll` 或与当前架构匹配的
Everything SDK DLL（程序按「exe 目录\everything-SDK\dll\ → exe 目录\」
顺序查找，打包后程序目录即 exe 所在目录）。

## 常见问题

### Web 版显示「Everything 尚未就绪」引导态

服务启动时会自动尝试拉起 Everything（冷启动，最长约 20 秒）。三种未就绪
环境的页面表现对照：

| 现象 | /api/health 表现 | 处理 |
|---|---|---|
| Everything 未运行 | `ready:false`，引导态「正在加载索引，最长约 20 秒」 | 等待自动拉起或点「重试环境检测」 |
| 以服务方式运行于其他会话（Session 0） | 浏览报错带 `code:2` 与 `service_only:true` | 以管理员身份对齐运行 |
| 未安装 Everything | `degraded:"not_installed"` | 先安装并启动 Everything |
| SDK DLL 缺失/配置失效 | `degraded:"dll"` | 检查 `everything-SDK\dll` 目录 |
| config.json 损坏 | `degraded:"config"` | 修复数据目录下 config.json |

首次索引加载可能持续约 20 秒，期间请勿重复点击；就绪后徽章变绿并自动浏览。

### 提示无法定位 Everything.exe

说明客户机器没有安装 Everything，或安装位置无法自动发现。解决方法：

- 安装 Everything。
- 将 `Everything.exe` 放到程序目录。
- 将 Everything 安装目录加入系统 `PATH`。
- 删除错误的 `config.json` 后重新运行。

### 程序停在“正在等待 Everything 返回查询结果”

这通常表示 Everything 正在处理大范围查询。程序自动启动 Everything 时会先等待最多 20 秒让数据库加载完成；首次运行、磁盘文件很多、Everything 正在重建索引时会更明显。

为了获得更快的启动体验，建议在运行本工具前先手动打开 Everything，等 Everything 主窗口可以正常搜索后再启动本程序。

### 提示未找到 Everything SDK DLL

请确认 `everything-SDK\dll` 目录存在，并包含与当前 Python 架构匹配的 DLL。64 位 Python 需要 `Everything64.dll`，32 位 Python 需要 `Everything32.dll`。

### 扫描结果为空

可能原因：

- Everything 尚未完成索引。
- Everything 没有索引该磁盘或目录。
- 输入路径不存在或权限不足。

可以先打开 Everything 客户端，确认搜索同一磁盘路径能看到结果。

### 快照保存失败

自动保存失败（如快照目录不可写、当日写量超限、并发写冲突）不影响程序退出，
仅在 verbose 模式提示一行；可用 `--snapshot-dir` 换个可写目录，或
`--no-snapshot` 关闭自动保存。

## 开发验证

unittest 全绿底线（2026-08 P12·W1.0 实测 177 项起，P12 全程完成后 **260** 项，
UI 2.0 阶段新增 fullscan/契约用例后当前 **266** 项；其中
`test_budget.DayBudgetTests.test_concurrent_saves_serialize_accounting`
存在预存 Windows 并发锁竞态（P13 挂账——`.snapshot.lock` unlink 与并发
`read_text()` 的共享冲突，偶发/连续失败，复跑即绿窗口随负载波动；该竞态为
既有问题，未随 UI 2.0 修复，禁碰 `snapshots.py`）：

```powershell
python -m unittest discover -s tests -t . -v
```

资源警告卫生门禁（ResourceWarning 一律视为失败；web 契约测试统一
with-resp/close 规约）：

```powershell
python -W error::ResourceWarning -m unittest discover -s tests -t .
```

> 说明：`-t .` 显式指定顶层目录，保证 `tests/__init__.py`（含 Windows +
> Python 3.13+ 下 tempfile 私有目录 ACL 的沙盒兼容垫片）随发现流程加载。
> 本机开发环境为 Python 3.14 + 项目内 `.venv`（Web 版依赖 Flask，CLI/TUI
> 仍零第三方依赖）；Web 版依赖见 `requirements.txt`。

前端门禁（UI 2.0 起，改 `web/static/js/app/` 任何模块提交前必跑）：
`tests/web/smoke.html` 冒烟页（默认 `?suite=v2`，A0–A20 共 21 项断言；
静态 http 服务打开即可，无需真实后端）；动效纯函数 `node --test scripts/dev/*.test.mjs`（25 项）。

检查语法：

```powershell
python -m py_compile main.py cli.py env.py sdk.py scan.py tui.py utils.py exceptions.py keyrouter.py messages.py snapshots.py compare.py app.py fullscan.py session.py datadir.py
```
