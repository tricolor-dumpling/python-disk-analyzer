"""快照模块（任务 D6）：磁盘扫描树的持久化快照。

快照 = 仅显式保存 + 干净退出自动保存两种落盘路径；刷新 / 跳转 / 中断永不落盘。
一份快照 = gzip 压缩的 JSONL 文件：首行为头部（JSON 对象），其后每行一个
{ "p": 路径, "s": 大小 } 行。头部带 CRC，写毕 flush + os.fsync 一次，临时文件 +
os.replace 原子替换；并发写用 O_CREAT|O_EXCL 锁文件互斥（冲突抛 SnapshotBusyError）。

设计要点：
- 四个原子谓词（完整树 ∧ 非脏 ∧ 指纹变 ∧ 当日未落）决定自动保存是否允许；
- 每日写量硬上界 MAX_BYTES_PER_DAY（跨根全局字节记账）；
- 台账 ledger.json 记录每根最后指纹 / 末次自动落盘日期 / 当日自动次数；
- 滚动保留：同根 + 同模式按 mtime 保留最新 KEEP_EXPLICIT / KEEP_AUTO 份；
- 存档目录固定为 %LOCALAPPDATA%/PythonDiskScanner/snapshots（Phase 0 统一），
  可用 --snapshot-dir / DSA_SNAPSHOT_DIR 覆盖，DSA_NO_SNAPSHOT 禁用。

依赖：仅标准库 + datadir。Python 3.9+ 兼容。
"""

import gzip
import json
import os
import re
import uuid
import zlib
from datetime import datetime
from pathlib import Path

import datadir

try:
    import winreg
except ImportError:  # 非 Windows 平台无 winreg，仅 machine guid 读取依赖它
    winreg = None

# =================【常量】=================
SNAPSHOT_FORMAT_VERSION = 1
MAX_ROWS = 500000
# 102.4 MiB 每日写量硬上界（= 102.4 * 1024 * 1024 = 107374182 字节）
MAX_BYTES_PER_DAY = int(102.4 * 1024 * 1024)
AUTO_MAX_PER_ROOT_PER_DAY = 1
KEEP_EXPLICIT = 30
KEEP_AUTO = 10

# 谓词失败原因（稳定字符串标识，供界面/日志使用）
REASON_OK = "ok"
REASON_NOT_TREE_COMPLETE = "tree_incomplete"
REASON_DIRTY = "dirty"
REASON_FINGERPRINT_UNCHANGED = "fingerprint_unchanged"
REASON_ALREADY_SAVED_TODAY = "already_saved_today"

_LEDGER_FILENAME = "ledger.json"
_DAY_WRITES_FILENAME = "day_writes.json"
_LOCK_FILENAME = ".snapshot.lock"
_MACHINE_GUID_FILENAME = ".pythondiskscanner_machine_guid"
_SNAPSHOT_SUFFIX = ".snap.gz"

# 头部字段顺序（也是 CRC 覆盖的规范字段序）
_HEADER_FIELDS = ("format", "machine_guid", "root", "created_at", "auto")

_ILLEGAL_CHARS = frozenset('<>:"/\\|?*')

# 文件名 {root_name}_{YYYYMMDD_HHMMSS}_{auto|explicit}_{guid8}.snap.gz
_SNAPSHOT_NAME_RE = re.compile(
    r"^(?P<root>.+)_(?P<ts>\d{8}_\d{6})_(?P<mode>auto|explicit)"
    r"_(?P<guid8>[0-9A-Fa-f]{8})\.snap\.gz$"
)


class SnapshotError(Exception):
    """快照模块异常基类。"""


class SnapshotBusyError(SnapshotError):
    """快照并发写冲突：锁文件已存在，另一个保存正在进行。"""


class SnapshotCorruptError(SnapshotError):
    """快照文件损坏或无法解析（gzip 损坏 / 头部 CRC 失败 / 字段非法 / 文件名失配）。"""


# =================【路径与环境】=================


def default_snapshot_dir(app_dir=None):
    """返回默认快照目录 Path（目录不存在时自动创建）。

    Phase 0 起统一走数据目录 %LOCALAPPDATA%\\PythonDiskScanner\\snapshots，
    不再使用 portable.flag 便携分支。app_dir 参数仅保留用于旧测试/嵌入调用的
    签名兼容，不再影响目录解析结果。
    """
    snap_dir = datadir.get_data_dir() / "snapshots"
    snap_dir.mkdir(parents=True, exist_ok=True)
    return snap_dir


def get_snapshot_dir(override=None):
    """解析有效快照目录：override 优先，其次 DSA_SNAPSHOT_DIR，再其次默认目录。

    仅做解析（不做创建）：override / 环境变量分支不强制建目录，写方按需 mkdir；
    默认分支经 default_snapshot_dir() 已自动创建。
    """
    if override is not None:
        return Path(override)
    env = os.environ.get("DSA_SNAPSHOT_DIR")
    if env:
        return Path(env)
    return default_snapshot_dir()


def is_snapshot_disabled():
    """DSA_NO_SNAPSHOT 环境变量非空且非 '0' 时为 True（禁用一切快照落盘）。"""
    value = os.environ.get("DSA_NO_SNAPSHOT")
    return bool(value) and value != "0"


# =================【机器标识】=================


def _read_registry_machine_guid():
    """读取注册表 HKLM\\SOFTWARE\\Microsoft\\Cryptography\\MachineGuid；失败返回 None。"""
    if winreg is None:
        return None
    try:
        with winreg.OpenKey(
            winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Cryptography"
        ) as key:
            value, _ = winreg.QueryValueEx(key, "MachineGuid")
            return str(value)
    except OSError:
        return None


def _read_guid_file(fpath):
    try:
        value = Path(fpath).read_text(encoding="utf-8").strip()
    except OSError:
        return None
    return value or None


def get_machine_guid(guid_file=None):
    """返回稳定机器标识字符串。

    优先读注册表 MachineGuid；不可用时用稳定伪随机 UUID 存到数据目录根文件
    （仅一次，O_CREAT|O_EXCL 原子创建，跨进程并发时赢者写入、其余读回，保证
    同机稳定一致）。guid_file 供测试/嵌入注入回退文件位置；缺省为 Phase 0
    统一数据目录 %LOCALAPPDATA%\\PythonDiskScanner\\ 下的固定文件名。
    """
    guid = _read_registry_machine_guid()
    if guid:
        return guid
    if guid_file is not None:
        fpath = Path(guid_file)
    else:
        fpath = datadir.get_machine_guid_path()
    existing = _read_guid_file(fpath)
    if existing:
        return existing
    new_guid = str(uuid.uuid4())
    try:
        fpath.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(str(fpath), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError:
        return _read_guid_file(fpath) or new_guid
    except OSError:
        return new_guid
    else:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(new_guid)
        return new_guid


# =================【文件名与净化】=================


def _sanitize_name(name):
    """把 root 名净化成安全的文件名段：非法字符/控制字符替换为 '_'，去首尾空白与尾点。"""
    out = []
    for ch in str(name):
        if ch in _ILLEGAL_CHARS or ord(ch) < 32:
            out.append("_")
        else:
            out.append(ch)
    cleaned = "".join(out).strip().rstrip(".")
    return cleaned or "root"


def _root_name(root):
    """root -> 净化后的文件名用根名。

    取根路径的 basename（盘符根如 C:\\ 退化取盘符 C）；对 basename 净化非法字符。
    已知限制：不同盘同名目录（D:\\data 与 E:\\data）会得到相同根名、共用文件名
    命名空间；精确根比对以快照头部 root 字段为准。
    """
    root_str = str(root)
    name = Path(root_str).name
    if not name:
        name = root_str.rstrip("\\/:").strip()
    return _sanitize_name(name)


def _make_filename(root, now, mode, machine_guid):
    root_name = _root_name(root)
    ts = now.strftime("%Y%m%d_%H%M%S")
    guid8 = (str(machine_guid or "00000000"))[:8].lower()
    return "%s_%s_%s_%s%s" % (root_name, ts, mode, guid8, _SNAPSHOT_SUFFIX)


def _parse_filename(name):
    """解析快照文件名；不符合命名规则返回 None。"""
    match = _SNAPSHOT_NAME_RE.match(name)
    if not match:
        return None
    return {
        "root": match.group("root"),
        "timestamp": match.group("ts"),
        "mode": match.group("mode"),
        "guid8": match.group("guid8").lower(),
    }


# =================【指纹与台账】=================


def _canonical_json(obj):
    return json.dumps(obj, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def _fingerprints_equal(a, b):
    return _canonical_json(a) == _canonical_json(b)


def _fingerprint_of_rows(rows):
    """由行集合推导内容指纹：数量 + 路径/大小流的 CRC32（JSON 可序列化）。"""
    h = zlib.crc32(b"")
    for row in rows:
        h = zlib.crc32(str(row.get("p", "")).encode("utf-8"), h)
        h = zlib.crc32(str(row.get("s", 0)).encode("utf-8"), h)
    return {"count": len(rows), "crc32": h & 0xFFFFFFFF}


def _date_str(now=None):
    if now is None:
        now = datetime.now()
    return now.strftime("%Y-%m-%d")


def _ledger_path(dir_path=None):
    d = Path(dir_path) if dir_path is not None else get_snapshot_dir()
    return d / _LEDGER_FILENAME


def load_ledger(dir_path=None):
    """读取台账 dict {root: {date, last_fingerprint, auto_count}}；缺失/损坏返回 {}。"""
    path = _ledger_path(dir_path)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    if not isinstance(data, dict):
        return {}
    result = {}
    for key, value in data.items():
        if isinstance(key, str) and isinstance(value, dict):
            result[key] = value
    return result


def save_ledger(ledger, dir_path=None):
    """原子写台账（临时文件 + os.replace）；失败返回 False，不影响主流程。"""
    path = _ledger_path(dir_path)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(path.name + ".tmp")
        tmp.write_text(
            json.dumps(ledger, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        os.replace(str(tmp), str(path))
        return True
    except OSError:
        return False


def update_ledger_after_save(root, fingerprint, *, auto=False, now=None, dir_path=None):
    """快照落盘成功后更新台账，返回更新后的台账 dict。

    - 始终回写 last_fingerprint（显式/自动都记录，避免同一内容重复自动落盘）；
    - auto=True 时记录当日 date 并递增当日 auto_count（跨日重置为 1）。
    """
    ledger = load_ledger(dir_path)
    key = str(root)
    entry = ledger.get(key)
    if not isinstance(entry, dict):
        entry = {"date": None, "last_fingerprint": None, "auto_count": 0}
    entry["last_fingerprint"] = fingerprint
    if auto:
        today = _date_str(now)
        if entry.get("date") == today:
            entry["auto_count"] = int(entry.get("auto_count") or 0) + 1
        else:
            entry["auto_count"] = 1
        entry["date"] = today
    ledger[key] = entry
    save_ledger(ledger, dir_path)
    return ledger


def should_auto_save(
    root, *, tree_complete=True, dirty=False, fingerprint=None, ledger=None, now=None
):
    """四原子谓词：完整树 ∧ 非脏 ∧ 指纹变 ∧ 当日该根未自动落。返回 (bool, reason)。

    指纹「变」= 与台账该根 last_fingerprint 不同（无台账视为变）；「当日未落」=
    该根台账 date != 今日。ledger 缺省时按 get_snapshot_dir() 加载。
    """
    if ledger is None:
        ledger = load_ledger()
    if not tree_complete:
        return False, REASON_NOT_TREE_COMPLETE
    if dirty:
        return False, REASON_DIRTY
    entry = ledger.get(str(root))
    if entry is None:
        fingerprint_changed = True
    else:
        fingerprint_changed = not _fingerprints_equal(
            fingerprint, entry.get("last_fingerprint")
        )
    if not fingerprint_changed:
        return False, REASON_FINGERPRINT_UNCHANGED
    if entry is not None and entry.get("date") == _date_str(now):
        return False, REASON_ALREADY_SAVED_TODAY
    return True, REASON_OK


# =================【写量记账】=================


def _day_writes_path(dir_path=None):
    d = Path(dir_path) if dir_path is not None else get_snapshot_dir()
    return d / _DAY_WRITES_FILENAME


def _load_day_usage(dir_path=None, now=None):
    today = _date_str(now)
    path = _day_writes_path(dir_path)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        data = None
    if not isinstance(data, dict) or data.get("date") != today:
        return {"date": today, "bytes": 0}
    return {"date": today, "bytes": int(data.get("bytes") or 0)}


def _save_day_usage(usage, dir_path=None):
    path = _day_writes_path(dir_path)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(path.name + ".tmp")
        tmp.write_text(json.dumps(usage, ensure_ascii=False), encoding="utf-8")
        os.replace(str(tmp), str(path))
        return True
    except OSError:
        return False


def record_day_writes(bytes_written, *, now=None, dir_path=None):
    """把 bytes_written 记入当日全局写量（跨根），返回记账后的累计字节。"""
    usage = _load_day_usage(dir_path, now)
    usage["bytes"] = int(usage["bytes"]) + int(bytes_written)
    _save_day_usage(usage, dir_path)
    return usage["bytes"]


def day_write_budget_ok(bytes_written, now=None, dir_path=None):
    """检查当日再写 bytes_written 后是否仍在 MAX_BYTES_PER_DAY 上界内。"""
    usage = _load_day_usage(dir_path, now)
    return int(usage["bytes"]) + int(bytes_written) <= MAX_BYTES_PER_DAY


# =================【头部与 CRC】=================


def _crc32_bytes(data):
    return zlib.crc32(data) & 0xFFFFFFFF


def _header_crc_payload(header):
    """头部 CRC 覆盖的规范负载：固定字段序、无 crc 字段（写/读两侧同源，避免错位）。"""
    obj = {key: header.get(key) for key in _HEADER_FIELDS}
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def _build_header(root, now, auto, machine_guid):
    header = {
        "format": SNAPSHOT_FORMAT_VERSION,
        "machine_guid": str(machine_guid),
        "root": str(root),
        "created_at": now.isoformat(timespec="seconds"),
        "auto": bool(auto),
    }
    header["crc"] = _crc32_bytes(_header_crc_payload(header).encode("utf-8"))
    return header


def _public_header(header):
    return {key: header.get(key) for key in _HEADER_FIELDS}


def _validate_header(header, path):
    for field in _HEADER_FIELDS:
        if field not in header:
            raise SnapshotCorruptError("头部缺少字段 %s: %s" % (field, path))
    if not isinstance(header.get("format"), int) or isinstance(header.get("format"), bool):
        raise SnapshotCorruptError("头部 format 字段非法: %s" % path)
    if not isinstance(header.get("machine_guid"), str):
        raise SnapshotCorruptError("头部 machine_guid 字段非法: %s" % path)
    if not isinstance(header.get("root"), str):
        raise SnapshotCorruptError("头部 root 字段非法: %s" % path)
    if not isinstance(header.get("created_at"), str):
        raise SnapshotCorruptError("头部 created_at 字段非法: %s" % path)
    if not isinstance(header.get("auto"), bool):
        raise SnapshotCorruptError("头部 auto 字段非法: %s" % path)
    stored_crc = header.get("crc")
    if not isinstance(stored_crc, int) or isinstance(stored_crc, bool):
        raise SnapshotCorruptError("头部 CRC 缺失或类型错误: %s" % path)
    computed = _crc32_bytes(_header_crc_payload(header).encode("utf-8"))
    if computed != stored_crc:
        raise SnapshotCorruptError("头部 CRC 校验失败: %s" % path)
    info = _parse_filename(Path(path).name)
    if info is not None:
        if header["auto"] != (info["mode"] == "auto"):
            raise SnapshotCorruptError("文件名与头部模式不符: %s" % path)
        if (header["machine_guid"][:8]).lower() != info["guid8"]:
            raise SnapshotCorruptError("文件名与头部机器标识不符: %s" % path)
        if _root_name(header["root"]) != info["root"]:
            raise SnapshotCorruptError("文件名与头部根名称不符: %s" % path)


# =================【并发锁】=================


def _acquire_lock(directory):
    lock_path = directory / _LOCK_FILENAME
    try:
        fd = os.open(str(lock_path), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError:
        raise SnapshotBusyError("另一个快照保存正在进行（锁文件已存在）: %s" % lock_path)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(str(os.getpid()))
    except Exception:
        try:
            lock_path.unlink()
        except OSError:
            pass
        raise
    return lock_path


def _release_lock(lock_path):
    try:
        lock_path.unlink()
    except OSError:
        pass


# =================【写入】=================


def _write_snapshot(directory, name, header, rows):
    final_path = directory / name
    tmp_path = directory / ("." + name + ".tmp")
    try:
        with gzip.open(str(tmp_path), "wt", encoding="utf-8", newline="\n") as fh:
            fh.write(json.dumps(header, ensure_ascii=False))
            fh.write("\n")
            for row in rows:
                fh.write(json.dumps(row, ensure_ascii=False))
                fh.write("\n")
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(str(tmp_path), str(final_path))
    except OSError as exc:
        try:
            tmp_path.unlink()
        except OSError:
            pass
        raise OSError("快照写入失败(%s): %s" % (name, exc)) from exc
    except Exception:
        try:
            tmp_path.unlink()
        except OSError:
            pass
        raise
    return final_path


def save_snapshot(
    root,
    rows,
    *,
    dir_path=None,
    auto=False,
    machine_guid=None,
    fingerprint=None,
    tree_complete=True,
    dirty=False,
    now=None,
):
    """保存一份快照，返回最终文件 Path；自动保存被谓词拒绝时返回 None。

    rows: list[dict]，每行 {"p": 路径 str, "s": 大小 int}；超过 MAX_ROWS 抛 ValueError。
    - 显式保存(auto=False)不做日配额；
    - 自动保存(auto=True)必须先过四原子谓词（fingerprint 缺省时由 rows 推导，
      tree_complete/dirty 缺省为完整且非脏，由调用方按真实状态覆盖）；
    - 写流程：临时文件 .<name>.tmp -> gzip 写头行+逐行 -> flush+fsync 一次 ->
      os.replace 原子替换；写失败清理临时文件并抛 OSError 包装；
    - 并发写用 O_CREAT|O_EXCL 锁文件互斥，冲突抛 SnapshotBusyError；
    - 写成功后在锁内做同根+同模式滚动清理（保留最新 KEEP_* 份）并更新台账。
    """
    rows = list(rows)
    if len(rows) > MAX_ROWS:
        raise ValueError(
            "快照行数 %d 超过上限 %d，拒绝保存" % (len(rows), MAX_ROWS)
        )
    canonical_rows = []
    for index, row in enumerate(rows):
        if not isinstance(row, dict):
            raise TypeError("快照第 %d 行必须是 dict" % index)
        if "p" not in row or "s" not in row:
            raise TypeError("快照第 %d 行缺少 p/s 字段" % index)
        s = row["s"]
        if not isinstance(s, int) or isinstance(s, bool):
            raise TypeError("快照第 %d 行的 s 必须是 int" % index)
        canonical_rows.append({"p": row["p"], "s": s})

    if machine_guid is None:
        machine_guid = get_machine_guid()
    else:
        machine_guid = str(machine_guid)

    d = Path(dir_path) if dir_path is not None else get_snapshot_dir()
    d.mkdir(parents=True, exist_ok=True)
    if now is None:
        now = datetime.now()
    if fingerprint is None:
        fingerprint = _fingerprint_of_rows(canonical_rows)

    mode = "auto" if auto else "explicit"
    name = _make_filename(root, now, mode, machine_guid)
    lock_path = _acquire_lock(d)
    try:
        if auto:
            ok, _reason = should_auto_save(
                root,
                tree_complete=tree_complete,
                dirty=dirty,
                fingerprint=fingerprint,
                ledger=load_ledger(d),
                now=now,
            )
            if not ok:
                return None
        header = _build_header(root, now, auto, machine_guid)
        final_path = _write_snapshot(d, name, header, canonical_rows)
        _roll(d, root, mode)
        update_ledger_after_save(root, fingerprint, auto=auto, now=now, dir_path=d)
        return final_path
    finally:
        _release_lock(lock_path)


def _snapshot_sort_key(path):
    try:
        mtime = path.stat().st_mtime
    except OSError:
        mtime = 0.0
    return (mtime, path.name.lower())


def _roll(directory, root, mode):
    """同根 + 同模式滚动清理：按 mtime 保留最新 KEEP_* 份，其余删除。"""
    keep = KEEP_EXPLICIT if mode == "explicit" else KEEP_AUTO
    target_name = _root_name(root)
    matches = []
    for path in directory.glob("*" + _SNAPSHOT_SUFFIX):
        info = _parse_filename(path.name)
        if info is None:
            continue
        if info["root"] == target_name and info["mode"] == mode:
            matches.append(path)
    matches.sort(key=_snapshot_sort_key, reverse=True)
    for old in matches[keep:]:
        try:
            old.unlink()
        except OSError:
            pass


# =================【读取 / 列出 / 自检】=================


def load_snapshot(path):
    """读取并校验单份快照，返回 {"header": dict, "rows": [{"p","s"}, ...]}。

    校验 gzip 完整性 + 头部 CRC + 头部字段类型 + 文件名与头部匹配；任一不满足抛
    SnapshotCorruptError（文件不存在则原样抛 FileNotFoundError，不视为损坏）。
    """
    path = Path(path)
    raw = []
    try:
        with gzip.open(str(path), "rt", encoding="utf-8") as fh:
            for line in fh:
                raw.append(line.rstrip("\n"))
    except FileNotFoundError:
        raise
    except (OSError, EOFError, zlib.error, UnicodeDecodeError, ValueError) as exc:
        raise SnapshotCorruptError("gzip 数据损坏或无法解压: %s" % path) from exc

    if not raw:
        raise SnapshotCorruptError("空快照文件: %s" % path)
    try:
        header = json.loads(raw[0])
    except json.JSONDecodeError as exc:
        raise SnapshotCorruptError("头部 JSON 解析失败: %s" % path) from exc
    if not isinstance(header, dict):
        raise SnapshotCorruptError("头部不是 JSON 对象: %s" % path)
    _validate_header(header, path)

    rows = []
    for index in range(1, len(raw)):
        line = raw[index]
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError as exc:
            raise SnapshotCorruptError(
                "第 %d 行 JSON 解析失败: %s" % (index + 1, path)
            ) from exc
        if (
            not isinstance(row, dict)
            or not isinstance(row.get("p"), str)
            or isinstance(row.get("s"), bool)
            or not isinstance(row.get("s"), int)
        ):
            raise SnapshotCorruptError("第 %d 行字段非法: %s" % (index + 1, path))
        rows.append({"p": row["p"], "s": row["s"]})

    return {"header": _public_header(header), "rows": rows}


def scan_snapshot_dir(dir_path=None):
    """启动/调用时自检目录内的 *.snap.gz：返回 (ok_paths, corrupt_paths)，不删除文件。"""
    d = Path(dir_path) if dir_path is not None else get_snapshot_dir()
    if not d.exists():
        return [], []
    ok_paths = []
    corrupt_paths = []
    for path in sorted(d.glob("*" + _SNAPSHOT_SUFFIX)):
        try:
            load_snapshot(path)
            ok_paths.append(path)
        except (SnapshotCorruptError, OSError):
            corrupt_paths.append(path)
    ok_paths.sort(key=_snapshot_sort_key, reverse=True)
    corrupt_paths.sort(key=_snapshot_sort_key, reverse=True)
    return ok_paths, corrupt_paths


def list_snapshots(root=None, dir_path=None):
    """列出目录内快照文件（按时间降序）；root 非 None 时按净化根名过滤。"""
    d = Path(dir_path) if dir_path is not None else get_snapshot_dir()
    if not d.exists():
        return []
    files = [p for p in d.glob("*" + _SNAPSHOT_SUFFIX) if p.is_file()]
    if root is not None:
        target_name = _root_name(root)
        filtered = []
        for path in files:
            info = _parse_filename(path.name)
            if info is not None and info["root"] == target_name:
                filtered.append(path)
        files = filtered
    files.sort(key=_snapshot_sort_key, reverse=True)
    return files


__all__ = [
    "SNAPSHOT_FORMAT_VERSION",
    "MAX_ROWS",
    "MAX_BYTES_PER_DAY",
    "AUTO_MAX_PER_ROOT_PER_DAY",
    "KEEP_EXPLICIT",
    "KEEP_AUTO",
    "REASON_OK",
    "REASON_NOT_TREE_COMPLETE",
    "REASON_DIRTY",
    "REASON_FINGERPRINT_UNCHANGED",
    "REASON_ALREADY_SAVED_TODAY",
    "SnapshotError",
    "SnapshotBusyError",
    "SnapshotCorruptError",
    "default_snapshot_dir",
    "get_snapshot_dir",
    "is_snapshot_disabled",
    "get_machine_guid",
    "save_snapshot",
    "load_snapshot",
    "scan_snapshot_dir",
    "list_snapshots",
    "should_auto_save",
    "load_ledger",
    "save_ledger",
    "update_ledger_after_save",
    "record_day_writes",
    "day_write_budget_ok",
]