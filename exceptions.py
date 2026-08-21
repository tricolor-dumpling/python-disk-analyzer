"""公共异常定义模块（C3 拆分自 main.py）。

MsvcrtUnavailableError 与 EverythingEnvironmentError 被 utils/sdk/env/scan/tui/cli
多个模块共同使用，独立成模块以避免循环导入：本模块不依赖任何项目内其他模块。
"""


class MsvcrtUnavailableError(RuntimeError):
    """非 Windows 环境缺少 msvcrt（终端按键读取）时的专用异常，提示语为中文。"""


class EverythingEnvironmentError(RuntimeError):
    """Everything 运行环境异常（SDK DLL 解析失败、IPC/数据库超时、无法定位可执行文件），提示语为中文。

    由 ensure_everything_running 抛出、main 统一捕获打印后退出；嵌入/测试场景可自行捕获处理。
    """