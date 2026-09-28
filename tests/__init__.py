"""tests 包初始化。

除包标识外，本文件还承载一个**沙盒环境兼容垫片**（W1.0 基线核定的前置事实，
见 docs/P12_开发执行手册.md W1.0 ⚠️偏差注记）：

Python 3.13+ 在 Windows 上给 tempfile.mkdtemp() 创建的目录设置了仅属主可访问
的显式安全描述符（DACL）。在 DSH 文件沙盒环境下运行时，该描述符会导致创建者
自身随后也无法访问目录（listdir/写入/删除全部 WinError 5「拒绝访问」），使所有
依赖 tempfile.TemporaryDirectory 的用例在清理阶段批量报 PermissionError。

此垫片仅在「mkdtemp 产物不可访问」的环境下替换为不设特殊 ACL 的等价实现：
随机名 + 重试的 os.mkdir，语义与标准库一致（返回 str 绝对路径、保证唯一）。
在正常环境（真实 Windows 用户会话 / POSIX）行为与标准库完全一致——目录仅以
默认方式创建；如需保留标准库的安全加固语义，可在确认环境影响后移除本垫片。
"""

import errno
import os
import tempfile

__all__ = []


def _mkdtemp_compat(suffix=None, prefix="tmp", dir=None):
    """tempfile.mkdtemp 的无特殊 DACL 等价实现（见模块 docstring）。"""
    suffix = "" if suffix is None else suffix
    prefix = "tmp" if prefix is None else prefix
    directory = os.fspath(dir) if dir is not None else tempfile.gettempdir()
    while True:
        name = prefix + os.urandom(8).hex() + suffix
        path = os.path.join(directory, name)
        try:
            os.mkdir(path)
        except FileExistsError:
            continue  # 碰撞概率 ~0；与标准库一致地重试
        except PermissionError as exc:  # 目录创建被拒（非碰撞）
            if exc.errno == errno.EEXIST:
                continue
            raise
        return path


def _probe_mkdtemp_broken():
    """探测当前环境是否存在「mkdtemp 产物创建者自身不可访问」问题。"""
    try:
        path = tempfile.mkdtemp(prefix="dsa_probe_")
    except OSError:
        return True  # 连创建都失败：交由原实现向上抛错，不再垫片
    try:
        os.listdir(path)
        os.rmdir(path)
    except OSError:
        return True
    finally:
        try:
            os.rmdir(path)
        except OSError:
            pass
    return False


if os.name == "nt" and _probe_mkdtemp_broken():
    tempfile.mkdtemp = _mkdtemp_compat
