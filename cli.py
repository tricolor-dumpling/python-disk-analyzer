"""命令行入口模块（C3 拆分自 main.py）。

职责：组合各模块完成主控制流——等待输入目标路径、初始化作业对象沙盒、
确保 Everything 运行环境就绪、执行 Everything SDK 扫描、进入交互界面并
处理切换路径/退出。输出文案与交互 UX 与拆分前逐字一致。

本模块是装配层（依赖 env/sdk/scan/tui/utils/exceptions），不定义业务状态；
不 import main，也不被任何其他模块 import（main.py 仅从本模块取 main）。
"""

import gc
import sys
from pathlib import Path

from utils import APP_NAME, _exit_with_error, _fatal, log
from exceptions import EverythingEnvironmentError, MsvcrtUnavailableError
from env import ensure_everything_running, init_windows_job_sandbox
from scan import scan_via_everything_sdk
from tui import _clear_screen, _getch, interactive_ui


def prompt_target_drive():
    """运行入口处再询问扫描路径，避免 import main 时阻塞测试或复用。"""
    return input("请输入扫描的目标路径 (例如 C:\\Users 或 D:\\): ").strip()


def main():
    log(f"🚀 {APP_NAME}启动中...")
    target_drive = prompt_target_drive()
    init_windows_job_sandbox()
    try:
        ensure_everything_running()  # 确保 Everything 已启动
    except EverythingEnvironmentError as e:
        _fatal(str(e))

    root_path_obj = Path(target_drive).resolve()
    if not root_path_obj.exists():
        _fatal(f"错误: 指定的扫描路径不存在: {root_path_obj}")

    driver_label = "Everything SDK (高速总线版)"
    dir_sizes = None
    dir_contents = None

    # 主循环，支持切换路径
    while True:
        # 释放旧资源
        if dir_sizes is not None:
            del dir_sizes
        if dir_contents is not None:
            del dir_contents
        gc.collect()  # 强制回收

        print(f"\n🔍 开始扫描: {root_path_obj}")
        try:
            dir_sizes, dir_contents = scan_via_everything_sdk(root_path_obj)
        except Exception as e:
            print(f"❌ 扫描失败: {e}")
            print("请检查 Everything 是否正常运行，或尝试切换路径。")
            input("按任意键退出...")
            sys.exit(1)

        print("✅ 扫描数据准备完成，正在进入交互界面。")
        try:
            action, result = interactive_ui(root_path_obj, dir_sizes, dir_contents, driver_label)
        except MsvcrtUnavailableError as e:
            _exit_with_error(e)
        if action == 'quit':
            _clear_screen()
            print(f"已安全退出 {APP_NAME}。")
            break
        elif action == 'change':
            new_path_str = result
            new_path = Path(new_path_str).resolve()
            if new_path.exists():
                root_path_obj = new_path
                print(f"✅ 已切换到新路径: {root_path_obj}")
                # 继续循环，重新扫描
            else:
                print(f"❌ 路径无效: {new_path_str}，按任意键返回...")
                try:
                    _getch()
                except MsvcrtUnavailableError as e:
                    _exit_with_error(e)
                # 继续使用旧路径
        else:
            break