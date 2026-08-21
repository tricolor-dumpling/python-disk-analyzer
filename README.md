# Python 智能磁盘分析工具

这是一个基于 Everything SDK 的 Windows 终端磁盘占用分析工具。程序通过 Everything 的索引高速读取文件路径和大小，然后在终端里按目录展示空间占用，支持进入目录、返回上级和切换扫描路径。

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
- 启动 Everything 的子进程被绑定到 Windows 作业对象（`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`），程序退出时不会残留孤儿进程。

## 运行环境

- Windows（本程序仅支持 Windows，见下方「已知边界」）
- Python 3.9 或更高版本
- Everything 1.4.x
- Everything SDK DLL

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

进入交互界面后：

- `W` / `S` 或 `↑` / `↓` 方向键：上下移动光标
- `Enter`：进入选中的目录（仅对目录项生效，文件项不响应）
- `Backspace`：返回上级目录（不能高于扫描根）
- `C`：切换扫描路径，按提示输入新路径（例如 `C:\` 或 `D:\Downloads`），路径有效则重新扫描并进入
- `Q`：退出程序

### 非交互模式：命令行参数

提供扫描路径 `TARGET` 位置参数即进入非交互模式：扫描后打印 Top-N 目录占用报告并
退出，不进入交互界面。（交互模式下下列参数一律被忽略。）

```powershell
python <project PATH>\main.py D:\
python <project PATH>\main.py D:\ --top 20
python <project PATH>\main.py D:\ --quiet
python <project PATH>\main.py D:\ --export csv
python <project PATH>\main.py D:\ --export json --output D:\reports\disk_20260821.json
```

| 参数 | 说明 |
|---|---|
| `TARGET` | 可选扫描路径（如 `D:\`、`C:\Users`）；提供后进入非交互模式，缺省进入交互模式 |
| `--top N` | 非交互模式下屏幕 Top-N 报告的目录条数，1-200，默认 10；交互模式下忽略 |
| `--quiet` | 非交互模式下仅输出 Top-N 报告与错误信息，抑制 🚀/🧩 等过程日志与扫描进度行（\r），便于下游脚本逐行解析；交互模式下忽略 |
| `--export {csv,json}` | 把目录占用报告导出到文件：csv 或 json。导出**全部目录**（含扫描根与各级子目录）的聚合占用大小，不受 `--top` 限制；仅目录级聚合大小，不含文件明细；`--quiet` 不影响导出文件生成，屏幕 Top-N 报告照常打印。交互模式下忽略 |
| `--output PATH` | 导出文件路径，需与 `--export` 搭配使用；未指定时在当前目录自动命名 `disk_report_YYYYMMDD_HHMMSS.<后缀>`，格式后缀跟随 `--export`（csv 或 json）。交互模式下忽略 |

退出码约定：

- `0`：扫描完成（含按需导出），正常结束；
- `1`：致命错误——扫描路径不存在、Everything 环境未就绪、扫描失败、或导出文件写入失败；
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

## 项目结构

代码按职责拆分为多个模块（由最初的单文件 `main.py` 演进而来，`main.py`
仅保留入口与兼容层）：

```text
main.py          程序入口与兼容层：运行 python main.py 时调用 cli.main()；
                 同时把拆分后各模块的公共/下划线名字全量导回 main 命名空间，
                 并动态转发可变全局（DLL_PATH / VERBOSE / _ANSI_AVAILABLE /
                 _GLOBAL_JOB_HANDLE / _getch / msvcrt / winreg 等），保证旧脚本
                 import main 后按 main.<名字> 使用 API 的写法不变
cli.py           命令行装配层：主控制流——提示输入扫描路径、初始化作业对象沙盒、
                 确保 Everything 运行环境就绪、执行 SDK 扫描、进入交互界面并处理
                 切换路径/退出；不定义业务状态，main.py 仅从这里取 main
env.py           运行环境协调：config.json 读写、Everything.exe 定位（注册表 /
                 PATH / 程序目录 / 常见安装目录）、进程与会话判定（识别 Session 0
                 后台进程）、Windows 作业对象防孤儿沙盒、Everything 启动与
                 IPC/数据库就绪等待（默认 20 秒超时）
sdk.py           Everything SDK 封装与 Win32 常量：DLL 架构选择（32/64/ARM/ARM64）、
                 SDK 函数签名声明、IPC/数据库健康检查；DLL_PATH 模块级全局在此
scan.py          高速扫描：三阶段扫描主流程（文件收集 + 每目录最大 50 文件、
                 目录树构建、自底向上汇总）、扫描根判定（汇总止于扫描根）、
                 LazyContents 按需构建的有界缓存
tui.py           终端交互界面：msvcrt 受保护导入与统一按键读取 _getch、ANSI/VT
                 渲染（不可用时回退 os.system('cls')）、交互主循环
utils.py         通用工具：应用名、日志开关、human_size、致命错误出口、
                 应用目录与配置路径
exceptions.py    公共异常：MsvcrtUnavailableError、EverythingEnvironmentError
tests/           单元测试：test_cli / test_env / test_export / test_scan / test_sdk / test_tui /
                 test_utils，共 161 个用例
everything-SDK/  Everything SDK DLL（dll\ 下为 Everything32.dll、Everything64.dll）
```

`config.json` 是本机运行时缓存，会自动生成。项目迁移或分发时可以删除它，程序会重新探测并生成。

## 部署方法

### 源码部署

1. 安装 Python 3.9+。
2. 安装 Everything。
3. 将全部 `.py` 模块（`main.py`、`cli.py`、`env.py`、`sdk.py`、`scan.py`、`tui.py`、`utils.py`、`exceptions.py`）、`requirements.txt`、`README.md` 和 `everything-SDK` 放在同一目录。
4. 运行：

```powershell
python main.py
```

### 可选：打包为 exe

仓库当前不附带打包脚本与预构建产物（`PyInstaller` 仅为可选工具），如需
打包可自行安装：

```powershell
pip install pyinstaller
```

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

## 开发验证

运行全部单元测试（161 个用例）：

```powershell
python -m unittest discover -s tests -v
```

检查语法：

```powershell
python -m py_compile main.py cli.py env.py sdk.py scan.py tui.py utils.py exceptions.py
```
