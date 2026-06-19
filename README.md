# Python 智能磁盘分析工具

这是一个基于 Everything SDK 的 Windows 终端磁盘占用分析工具。程序通过 Everything 的索引高速读取文件路径和大小，然后在终端里按目录展示空间占用，支持进入目录、返回上级和切换扫描路径。

## 功能特点

- 使用 Everything SDK 查询文件信息，避免 Python 逐目录慢速遍历。
- 自动按当前 Python 架构选择 `Everything32.dll`、`Everything64.dll`、`EverythingARM.dll` 或 `EverythingARM64.dll`。
- 自动检测 Everything 是否运行；未运行时尝试启动。
- 支持 Everything 安装在非默认目录。
- 自动生成 `config.json` 缓存 Everything 路径，后续启动无需每次查注册表。
- `config.json` 不存在、损坏或路径失效时会自动回退到重新探测。
- 每个目录默认只缓存最大的 50 个文件条目，降低大磁盘扫描时的内存占用。
- 终端交互式浏览目录占用，支持切换扫描路径。

## 运行环境

- Windows
- Python 3.9 或更高版本
- Everything 1.4.x
- Everything SDK DLL

当前项目已包含 `everything-SDK` 目录时，推荐目录结构如下：

```text
文件大小扫描/
  main.py
  requirements.txt
  README.md
  everything-SDK/
    dll/
      Everything32.dll
      Everything64.dll
      EverythingARM.dll
      EverythingARM64.dll
```

## pip 依赖

本程序运行不需要安装第三方 pip 包，代码只使用 Python 标准库。

可以执行下面命令确认依赖文件：

```powershell
pip install -r requirements.txt
```

如果只运行源码，这条命令不会安装必需依赖。`requirements.txt` 中的 `pyinstaller` 只是可选打包工具。

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

- `W/S` 或方向键上下移动
- `Enter` 进入目录
- `Backspace` 返回上级
- `C` 切换扫描路径
- `Q` 退出

## 项目目录

```text
文件大小扫描/
  main.py                         # 主程序
  test_everything_environment.py  # 环境检测相关单元测试
  README.md
  requirements.txt
  everything-SDK/                 # Everything SDK，源码运行和打包分发都会用到
  packaging/pyinstaller/          # PyInstaller spec 文件
  scripts/build_min.ps1           # 最小分发包构建脚本
  releases/latest/                # 最新最小分发目录
  releases/file-size-scanner-min.zip
```

`config.json` 是本机运行时缓存，会自动生成。项目迁移或分发时可以删除它，程序会重新探测并生成。

## 部署方法

### 源码部署

1. 安装 Python 3.9+。
2. 安装 Everything。
3. 将 `main.py`、`requirements.txt`、`README.md` 和 `everything-SDK` 放在同一目录。
4. 运行：

```powershell
python main.py
```

### 可选：打包为 exe

如需打包，可以安装 PyInstaller：

```powershell
pip install pyinstaller
```

示例打包命令：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build_min.ps1
```

脚本会生成：

```text
releases/latest/
  file-size-scanner.exe
  README.md
  requirements.txt
  everything-SDK/
    dll/
      Everything32.dll
      Everything64.dll

releases/file-size-scanner-min.zip
```

打包后仍需确保 `everything-SDK\dll` 或匹配架构的 Everything DLL 能被程序找到。最小分发包已经把 32 位和 64 位 DLL 放在 exe 同级目录下。

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

运行单元测试：

```powershell
python -m unittest test_everything_environment.py
```

检查语法：

```powershell
python -m py_compile main.py test_everything_environment.py
```
