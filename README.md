# Python 智能磁盘分析工具

这是一个基于 Everything SDK 的 Windows 终端磁盘占用分析工具。程序通过 Everything 的索引高速读取文件路径和大小，然后在终端里按目录展示空间占用，支持进入目录、返回上级、两级刷新、路径跳转、快照保存与历史对比。

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
- 终端交互式浏览目录占用，支持切换扫描路径。
- 两级刷新：`r` 轻刷当前目录、`R` 深刷全量重建；根目录轻刷走**指纹门**（`compute_fingerprint`，60 秒冷却缓存）——数据未变毫秒级返回「数据未变」，内容变化或探测失败自动升级为深刷；深刷有 60 秒冷却，在途可 `Esc` 取消。
- `/` 路径跳转：根内任意路径直接跳转、不触发重扫，自带最近 16 条跳转历史。
- 快照与历史对比：交互模式干净退出自动保存快照（gzip JSONL + 台账），支持 `--snapshot-dir` 自定义目录、`--no-snapshot` 禁用；非交互模式用 `--baseline` 与基线快照对比并打印 Top-N 变化。`S` 保存快照 / `H` 历史对比 / `h` 帮助键位已注册。
- 启动 Everything 的子进程被绑定到 Windows 作业对象（`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`），程序退出时不会残留孤儿进程。

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
  dispatcher.py
  snapshots.py
  compare.py
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
- 自动启动 Everything 时使用 Windows 作业对象（Job Object）沙盒，程序退出即终止由其启动的子进程，避免孤儿进程残留。
- 交互界面按键读取依赖 `msvcrt`：该导入是受保护的（`try/except ImportError`），非 Windows 平台 `import main` 不会崩溃，但进入交互界面时会抛出 `MsvcrtUnavailableError`（中文提示「请在 Windows 上运行」），由上层统一捕获后优雅退出。
- Everything.exe 注册表定位依赖 `winreg`：同样是受保护导入，非 Windows 平台自动跳过注册表候选路径。

## pip 依赖

本程序运行不需要安装第三方 pip 包，代码只使用 Python 标准库。

`requirements.txt` 目前只包含说明注释，`pip install -r requirements.txt`
不会安装任何必需依赖；其中的 `pyinstaller` 只是可选打包工具的提示。

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
  不做当日配额，滚动保留最新 30 份。

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

### 台账与滚动保留

快照目录下维护 `ledger.json` 台账：记录每个根的「最后指纹 / 末次自动保存日期 /
当日自动次数」，是四原子谓词第 3、4 条的判定依据；自动保存落盘成功后账目顺带
更新。同根同模式的旧快照按时间滚动清理：自动快照保留最新 10 份、显式快照保留
最新 30 份。

## 历史对比

`--baseline PATH` 在非交互模式把**本次扫描结果**（不落盘）与基线快照做 diff：
按变化量（`delta`）绝对值降序取前 `--top N` 条，每行由 `compare.format_row`
渲染（右对齐带符号变化大小 + 增速列 + 路径；增幅列仅对基线 ≥ 1 MiB 的目录
计算，小基数显示 `-`）。删除的目录标负 delta，新增目录标正 delta。

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

## 项目结构

代码按职责拆分为多个模块（由最初的单文件 `main.py` 演进而来，`main.py`
仅保留入口与兼容层）：

```text
main.py          程序入口与兼容层：运行 python main.py 时调用 cli.main()；
                 同时把拆分后各模块的公共/下划线名字全量导回 main 命名空间
                 （含 snapshots/compare/dispatcher/keyrouter/messages 与 scan
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
dispatcher.py    Everything 查询统一调度器：进程内并发=1、250ms 防抖合并、
                 代际令牌丢弃过期结果、统一错误码（DispatcherError）
snapshots.py     快照模块：自动/显式保存（四原子谓词、日配额、原子写、并发锁）、
                 台账 ledger.json、滚动保留、读取/列表/自检（save_snapshot /
                 load_snapshot / should_auto_save / load_ledger /
                 get_snapshot_dir / is_snapshot_disabled 等）
compare.py       历史对比引擎：compare_snapshots / diff_from_current（内存树与
                 基线快照对比）/ top_growth / format_row，纯引擎不做 UI
utils.py         通用工具：应用名、日志开关、human_size、致命错误出口、
                 应用目录与配置路径
exceptions.py    公共异常：MsvcrtUnavailableError、EverythingEnvironmentError
tests/           单元测试：test_cli / test_env / test_export / test_scan /
                 test_sdk / test_tui / test_utils，及 P12·W1.0 护栏
                 test_snapshot_golden / test_api_contract / test_compare，
                 共 177 个用例（基数以 W1.0 实测记录为准）
everything-SDK/  Everything SDK DLL（dll\ 下为 Everything32.dll、Everything64.dll）
```

`config.json` 是本机运行时缓存，会自动生成。项目迁移或分发时可以删除它，程序会重新探测并生成。

## 部署方法

### 源码部署

1. 安装 Python 3.9+。
2. 安装 Everything。
3. 将全部 `.py` 模块（`main.py`、`cli.py`、`env.py`、`sdk.py`、`scan.py`、`tui.py`、`utils.py`、`exceptions.py`、`keyrouter.py`、`messages.py`、`dispatcher.py`、`snapshots.py`、`compare.py`）、`requirements.txt`、`README.md` 和 `everything-SDK` 放在同一目录。
4. 运行：

```powershell
python main.py
```

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

unittest 全绿底线（基数以 2026-08 P12·W1.0 实测记录为准，当前实测 **177** 项，
含快照格式 golden / API 字段契约 / compare 现状护栏三类护栏回归）：

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

检查语法：

```powershell
python -m py_compile main.py cli.py env.py sdk.py scan.py tui.py utils.py exceptions.py keyrouter.py messages.py dispatcher.py snapshots.py compare.py
```