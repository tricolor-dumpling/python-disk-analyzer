"""session_*.json 清单读写模块（Phase 1）。

每次全量保存 = C、D 各一份 *.snap.gz + 一条 session_*.json 清单。
清单文件位于统一数据目录根，内容关联同一次保存产生的 C/D 快照，用于：
- Web 历史列表按「一次保存会话」聚合展示；
- 「撤销最近一次保存」按清单删除对应的两份快照文件。

本模块只依赖标准库 + datadir，不依赖 snapshots（避免与 snapshots 反向依赖）。
"""

import itertools
import json
import os
from datetime import datetime
from pathlib import Path

import datadir

SESSION_PREFIX = "session_"
SESSION_SUFFIX = ".json"

# 进程内自增序号：datetime.now() 在同一进程内可能多次相同（微秒精度），
# 用序号保证同一微秒内连续调用也不会生成重复 session id。
_SEQUENCE = itertools.count(1)


def _dir_path(dir_path=None):
    """session 清单存放目录：缺省为数据目录根。"""
    return Path(dir_path) if dir_path is not None else datadir.get_data_dir()


def build_session_id(now=None, machine_guid=None):
    """生成新的 session id：session_YYYYMMDD_HHMMSS_ffffff_<guid8>_<seq>.json。

    使用微秒时间戳 + 机器 GUID 前 8 位 + 进程内自增序号，保证连续保存不冲突。
    """
    now = now if now is not None else datetime.now()
    guid8 = (str(machine_guid or "00000000"))[:8].lower()
    sequence = next(_SEQUENCE)
    return (
        f"{SESSION_PREFIX}{now:%Y%m%d_%H%M%S_%f}_{guid8}_"
        f"{sequence:06d}{SESSION_SUFFIX}"
    )


def session_path(session_id, dir_path=None):
    """根据 session id 返回完整文件路径（自动补 .json 后缀）。"""
    sid = str(session_id)
    if not sid.endswith(SESSION_SUFFIX):
        sid += SESSION_SUFFIX
    return _dir_path(dir_path) / sid


def save_session(session, *, dir_path=None):
    """保存一条 session 清单，返回文件 Path。

    session 必须为 dict；函数会强制写入 created_at/session_id（若传入，以传入
    为准）。父目录自动创建；失败抛 OSError。
    """
    if not isinstance(session, dict):
        raise TypeError("session 必须是 dict")
    payload = dict(session)
    session_id = str(payload.get("session_id") or build_session_id())
    payload["session_id"] = session_id
    payload.setdefault("created_at", datetime.now().isoformat(timespec="seconds"))

    directory = _dir_path(dir_path)
    directory.mkdir(parents=True, exist_ok=True)
    path = session_path(session_id, dir_path=directory)
    # P12·W2.11（B-5）：tmp + os.replace 原子写（模式照抄 snapshots.save_ledger），
    # 杜绝读方读到半截 JSON。
    tmp_path = path.with_name(path.name + ".tmp")
    tmp_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    os.replace(str(tmp_path), str(path))
    return path


def load_session(path):
    """读取 session 清单；缺失/损坏/非 dict 一律返回 None（调用方可友好提示）。"""
    try:
        path = Path(path)
        if not path.exists():
            return None
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else None
    except (OSError, json.JSONDecodeError):
        return None


def list_sessions(dir_path=None):
    """返回数据目录根下的 session_*.json 清单列表（按 session 名字降序）。

    文件名含微秒时间戳，字典序降序即时间降序；不依赖文件系统 mtime 精度。
    """
    directory = _dir_path(dir_path)
    if not directory.exists():
        return []
    files = [
        p for p in directory.glob(SESSION_PREFIX + "*" + SESSION_SUFFIX)
        if p.is_file()
    ]
    files.sort(key=lambda p: p.name, reverse=True)
    return files


def delete_session(path):
    """删除一条 session 清单文件；文件不存在时静默返回 False。"""
    path = Path(path)
    try:
        path.unlink()
        return True
    except FileNotFoundError:
        return False
    except OSError:
        raise