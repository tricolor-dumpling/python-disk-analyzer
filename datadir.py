"""数据根目录统一与一键清空模块（Phase 0）。

职责：
- get_data_dir()：返回统一数据根目录 %LOCALAPPDATA%\\PythonDiskScanner（纯计算，
  不创建；LOCALAPPDATA 缺失/为空时回退到 ~\\AppData\\Local）；
- get_config_path()/get_snapshots_dir()/get_exports_dir()：返回数据目录下的
  约定子路径；
- ensure_data_dir()：创建数据根目录并重建约定空结构（snapshots/exports）；
- wipe_data(all=False)：一键清空数据目录。all=False 时删除数据根下所有内容后
  重建空结构；all=True 时连数据根目录本身一起删除后重建。失败时抛出 OSError，
  由调用方向用户提示。

约定：本模块不依赖项目内其他模块（只依赖标准库），以确保 snapshot/env/cli/tui
均可安全导入而不会循环依赖。
"""

import os
import shutil
from pathlib import Path

APP_DIR_NAME = "PythonDiskScanner"
SNAPSHOTS_DIR_NAME = "snapshots"
EXPORTS_DIR_NAME = "exports"
CONFIG_FILENAME = "config.json"
MACHINE_GUID_FILENAME = ".pythondiskscanner_machine_guid"


def _local_appdata_dir():
    """返回本地应用数据根目录（%LOCALAPPDATA% 或回退 ~\\AppData\\Local）。"""
    local = os.environ.get("LOCALAPPDATA")
    if not local:
        local = str(Path.home() / "AppData" / "Local")
    return Path(local)


def get_data_dir():
    """返回统一数据根目录 Path（纯计算，不创建）。"""
    return _local_appdata_dir() / APP_DIR_NAME


def get_config_path():
    """返回数据目录下的 config.json 路径。"""
    return get_data_dir() / CONFIG_FILENAME


def get_snapshots_dir():
    """返回数据目录下的 snapshots 路径。"""
    return get_data_dir() / SNAPSHOTS_DIR_NAME


def get_exports_dir():
    """返回数据目录下的 exports 路径。"""
    return get_data_dir() / EXPORTS_DIR_NAME


def get_machine_guid_path():
    """返回数据目录根下的机器 GUID 回退文件路径。"""
    return get_data_dir() / MACHINE_GUID_FILENAME


def ensure_data_dir():
    """创建数据根目录及约定空结构（snapshots/ 与 exports/），返回数据根。"""
    root = get_data_dir()
    (root / SNAPSHOTS_DIR_NAME).mkdir(parents=True, exist_ok=True)
    (root / EXPORTS_DIR_NAME).mkdir(parents=True, exist_ok=True)
    return root


def wipe_data(all=False):
    """清空数据目录并重建空结构。

    - all=False：删除数据根目录下的全部内容（子目录/文件），保留数据根目录本身；
    - all=True：连数据根目录一起删除；
    两个分支最终都调用 ensure_data_dir() 重建 root + snapshots/ + exports/。
    删除失败（文件被占用/权限不足）时 OSError 会向上传播，由调用方提示。
    """
    root = get_data_dir()
    if root.exists():
        if all:
            shutil.rmtree(root)
        else:
            for child in root.iterdir():
                if child.is_dir() and not child.is_symlink():
                    shutil.rmtree(child)
                else:
                    child.unlink()
    return ensure_data_dir()