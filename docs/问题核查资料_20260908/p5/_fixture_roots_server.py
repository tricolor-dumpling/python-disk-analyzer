# -*- coding: utf-8 -*-
"""P5 对比语义说人话 / 首开选盘 · 夹具服务（证据侧 harness，**非生产代码**）。

为什么需要它
------------
P5 的两组判据必须**确定复现**，而真实环境给不出这种确定性：

1. 盘符枚举（D5-3/D5-4）：真机 GetLogicalDrives 结果随插拔 U 盘/映射网络盘变化，
   且「不可用/未就绪」这一态在真机上无法按需造出 → 必须能注入盘符清单；
2. 对比语义（D5-1/D5-5）：「当前」侧 = fullscan.result(root) 缓存或 SDK 直扫真实磁盘
   （app.py :974 起同步路径 / :908 起异步路径），真实磁盘内容不可复现。

因此本 harness 只替换**两个数据源**，其余全部走生产代码：
- fullscan.result / fullscan.status / scan.scan_via_everything_sdk → 夹具快照行
  （**同一口径沿用 P4 `_fixture_compare_server.py`**：{root, rows} 契约，
  这正是 tests/test_api_contract.py:411-418 既有的数据源桩口径）；
- fullscan._enumerate_roots → 由 --roots 参数注入的盘符清单（P5 新增的唯一替换点）。

真实面（未替换，全部走生产代码）
--------------------------------
Flask 路由 / 模板 / 静态资源 / session 与 snapshots 读盘（真实 load_snapshot，
含 CRC 与头部校验）/ compare 引擎 / app.py 的两条对比返回路径 / 新增
GET /api/roots 路由本体 / 前端全部 JS。

⚠️ 关于 fullscan._enumerate_roots 的替换边界
--------------------------------------------
P5 授权清单明确「fullscan.py 只读复用 _enumerate_roots()，**不得修改其实现体**」。
本 harness 在**进程内** monkeypatch 该函数（等价 --roots 注入），生产文件一字未改：
- 未给 --roots 时**不替换**，走真实 GetLogicalDrives（用于「真实枚举」正例）；
- 给了 --roots 时替换为固定清单（用于「不可用/未就绪」等不可按需复现的态）。
被替换的只是**枚举来源**；「枚举结果 → /api/roots 响应」这段生产代码始终真实执行。

隔离与红线（红线 B：用户真实数据目录零写入）
--------------------------------------------
- 进程启动前改写 LOCALAPPDATA 与 DSA_SNAPSHOT_DIR 指向 %TEMP% 夹具目录，
  启动时打印实际生效的数据目录，供证据核对；
- scan.scan_via_everything_sdk 换成抛错桩：任何意外走到「SDK 直扫」分支都会
  立即失败（绝不触碰真实磁盘、绝不调用 Everything SDK）；
- snapshots.get_machine_guid 覆写为夹具 GUID（夹具固定值）：真实注册表 MachineGuid
  与夹具不同，不覆写会让每次对比都落到 W2.13 异机确认分支；
- 本文件不修改任何生产文件，仅在本进程内 monkeypatch 上述函数。

当前侧数据集控制
----------------
POST /__harness/current  {"snapshot": "<绝对路径.snap.gz>"}  → 切换当前侧数据集
GET  /__harness/state                                       → 回显当前状态（含盘符来源）
（仅存在于 harness 进程，不是生产路由；生产 404 处理器不受影响）

用法
----
  python _fixture_roots_server.py --port 5102 \
      --data-home <隔离 LOCALAPPDATA> \
      --snapshot-dir <夹具 snapshots 目录> \
      --current-snapshot <当前侧快照文件> \
      [--roots "C:\\|D:\\|Z:\\"]      # 可选：注入盘符清单（| 分隔；不给=真实枚举）
"""

import argparse
import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT))


def _parse_args():
    ap = argparse.ArgumentParser(description="P5 夹具服务（对比语义 + 盘符枚举，证据侧 harness）")
    ap.add_argument("--port", type=int, required=True)
    ap.add_argument("--data-home", required=True, help="隔离的 LOCALAPPDATA")
    ap.add_argument("--snapshot-dir", required=True, help="夹具快照目录（DSA_SNAPSHOT_DIR）")
    ap.add_argument("--current-snapshot", required=True, help="当前侧数据集来源快照")
    ap.add_argument("--roots", default=None,
                    help="注入盘符清单（| 分隔，如 'C:\\\\|D:\\\\|Z:\\\\'）；不给 = 走真实 GetLogicalDrives")
    return ap.parse_args()


ARGS = _parse_args()

# ---- 隔离：数据目录与快照目录一律落在 %TEMP% 夹具内（必须在 import 生产模块前设置）
os.environ["LOCALAPPDATA"] = str(Path(ARGS.data_home).resolve())
os.environ["DSA_SNAPSHOT_DIR"] = str(Path(ARGS.snapshot_dir).resolve())
os.environ.pop("DSA_NO_SNAPSHOT", None)

import app as appmod          # noqa: E402  生产 Flask 应用
import datadir                # noqa: E402
import fullscan               # noqa: E402
import scan                   # noqa: E402
import snapshots              # noqa: E402
import utils                  # noqa: E402


# =================【数据源替换（沿用 P4 口径）】=================

_CURRENT = {"snapshot": None, "root": None, "rows": [], "machine_guid": None}


def _load_current(snapshot_path):
    """载入当前侧数据集（真实 load_snapshot：CRC/头部校验全部生效）。"""
    loaded = snapshots.load_snapshot(Path(snapshot_path))
    _CURRENT["snapshot"] = str(Path(snapshot_path).resolve())
    _CURRENT["root"] = loaded.get("header", {}).get("root")
    _CURRENT["machine_guid"] = loaded.get("header", {}).get("machine_guid")
    _CURRENT["rows"] = [
        {"p": row["p"], "s": int(row["s"])} for row in (loaded.get("rows") or [])
    ]


def _under(path, root):
    """path == root 或位于 root 之下（大小写不敏感，尾部反斜杠归一）。"""
    p = os.path.normcase(str(path)).rstrip("\\")
    r = os.path.normcase(str(root)).rstrip("\\")
    return p == r or p.startswith(r + "\\")


# ---- P5 唯一新增替换点：盘符枚举来源（状态容器，供枚举替身与浏览索引共用）----
_ROOTS_MODE = "real"
_ROOTS_INJECTED = []


def _active_roots():
    """当前生效的盘符清单（注入清单优先，否则问枚举函数——保持单一事实来源）。"""
    if _ROOTS_MODE == "injected":
        return list(_ROOTS_INJECTED)
    try:
        return list(fullscan._enumerate_roots())
    except Exception:
        return []


def _fake_result(root=None):
    """fullscan.result 的夹具替身：按 root 过滤当前侧数据集（契约 {root, rows}）。"""
    if root is None:
        return {
            "roots": {},
            "completed_at": "2026-09-08T17:00:00",
            "scan_version": 1,
            "saved_scan_version": 0,
        }
    rows = [dict(r) for r in _CURRENT["rows"] if _under(r["p"], root)]
    return {"root": str(root), "rows": rows}


# ---- P5 新增替身：浏览索引（让 /api/browse 走「① 内存索引」快路径而非 SDK 直扫）----
# 为什么需要：P5 探针要读工作台默认根（#browse-root），而工作台启动浏览会打
# /api/browse。夹具进程没有真实 BROWSE_INDEX（真实索引由全量扫描建立），
# 于是该请求落到「③ SDK 直扫」→ _forbid_real_scan 抛错 → 500 → 浏览器 console
# 记 error（P4 血泪：console 判据必须干净）。此处按夹具行合成一个只读索引：
# 仍走生产 /api/browse 的全部校验与组装代码，只有「索引来源」是夹具。


def _sum_under(base_path):
    """夹具行中位于 base_path 之下（含自身）的字节合计。"""
    target = os.path.normcase(str(base_path).rstrip("\\"))
    total = 0
    for r in _CURRENT["rows"]:
        n = os.path.normcase(str(r["p"]).rstrip("\\"))
        if n == target or n.startswith(target + "\\"):
            total += int(r["s"])
    return total


def _fixture_child_entries(path):
    """把夹具行按 path 的直属子项聚合为 [(name, is_dir, size)]（/api/browse 契约）。

    夹具行里的键可能同时包含目录与文件；凡有更深层后代者为目录，否则视为文件。
    """
    base = str(path).rstrip("\\")
    prefix = os.path.normcase(base) + "\\"
    names = set()
    for r in _CURRENT["rows"]:
        p = str(r["p"])
        if not os.path.normcase(p).startswith(prefix):
            continue
        rest = p[len(base) + 1:]
        parts = [x for x in rest.split("\\") if x]
        if parts:
            names.add(parts[0])
    out = []
    for name in names:
        child = os.path.join(base, name)
        has_descendant = any(
            os.path.normcase(str(r["p"])) != os.path.normcase(child)
            and os.path.normcase(str(r["p"])).startswith(os.path.normcase(child) + "\\")
            for r in _CURRENT["rows"]
        )
        out.append((name, bool(has_descendant), _sum_under(child)))
    return sorted(out, key=lambda x: x[0].casefold())


class _FixtureBrowseIndex:
    """BrowseIndex 只读替身（仅本进程；生产 fullscan.BROWSE_INDEX 未被改动）。"""

    def clear(self):
        return None

    def root_for(self, path):
        for root in _active_roots():
            if _under(path, root):
                return str(root)
        return None

    def has_root(self, path):
        return self.root_for(path) is not None

    def children(self, path):
        return _fixture_child_entries(path)

    def root_stats(self, root):
        rows = [r for r in _CURRENT["rows"] if _under(r["p"], root)]
        dirs = set()
        for r in rows:
            rel = str(r["p"])[len(str(root).rstrip("\\")):]
            for part in [x for x in rel.split("\\") if x][:-1]:
                dirs.add(part)
        return {"total": sum(int(r["s"]) for r in rows),
                "directory_count": len(dirs), "file_count": len(rows)}


fullscan.BROWSE_INDEX = _FixtureBrowseIndex()


def _fake_is_running():
    return False


def _fake_status():
    """fullscan.status 的夹具替身：声称「当前根的全量扫描已完成、结果可用」。

    字段与 fullscan.status() 的真实返回同构（缺一即前端三态渲染异常）。
    """
    return {
        "running": False,
        "roots": [_CURRENT["root"]] if _CURRENT["root"] else [],
        "roots_done": 1,
        "roots_total": 1,
        "current_root": None,
        "error": None,
        "result_ready": True,
        "save_ready": False,
        "progress_pct": 100,
        "scan_version": 1,
        "stop_requested": False,
        "stop_reason": None,
        "phase": "idle",
        "lock_holder": None,
        "lock_since": None,
        "row_done": len(_CURRENT["rows"]),
        "row_total": len(_CURRENT["rows"]),
        "stop_ack_at": None,
        "autosave_outcome": None,
    }


def _forbid_real_scan(*_args, **_kwargs):
    raise RuntimeError(
        "harness 禁止真实磁盘扫描：本进程只服务夹具数据（红线 B）。"
        "若走到这里说明当前侧数据集未覆盖请求 root。"
    )


fullscan.result = _fake_result
fullscan.is_running = _fake_is_running
fullscan.status = _fake_status
scan.scan_via_everything_sdk = _forbid_real_scan
snapshots.get_machine_guid = lambda guid_file=None: _CURRENT["machine_guid"]

# ---- P5 唯一新增替换点：盘符枚举来源（不替换实现体，仅按参数注入清单）----


def _install_roots_override(spec):
    """按 --roots 注入清单替换 fullscan._enumerate_roots（未给则保持真实枚举）。"""
    global _ROOTS_MODE, _ROOTS_INJECTED
    if not spec:
        return
    parts = [p for p in str(spec).split("|")]
    _ROOTS_INJECTED = [Path(p) for p in parts if p.strip()]
    _ROOTS_MODE = "injected"

    def _fake_enumerate_roots():
        return [Path(p) for p in _ROOTS_INJECTED]

    fullscan._enumerate_roots = _fake_enumerate_roots


_install_roots_override(ARGS.roots)


# =================【harness 控制面（非生产路由）】=================


@appmod.app.post("/__harness/current")
def _harness_set_current():
    from flask import jsonify, request

    payload = request.get_json(silent=True) or {}
    path = payload.get("snapshot")
    if not path or not Path(path).is_file():
        return jsonify({"ok": False, "error": "snapshot 不存在: %r" % (path,)}), 400
    _load_current(path)
    return jsonify({"ok": True, "state": _state()})


@appmod.app.get("/__harness/state")
def _harness_state():
    from flask import jsonify

    return jsonify({"ok": True, "state": _state()})


def _state():
    return {
        "snapshot": _CURRENT["snapshot"],
        "root": _CURRENT["root"],
        "rows": len(_CURRENT["rows"]),
        "machine_guid": _CURRENT["machine_guid"],
        "data_dir": str(datadir.get_data_dir()),
        "snapshot_dir": str(snapshots.get_snapshot_dir()),
        "roots_mode": _ROOTS_MODE,
        "roots_injected": [str(p) for p in _ROOTS_INJECTED],
    }


# =================【启动】=================

if __name__ == "__main__":
    utils.VERBOSE = False
    _load_current(ARGS.current_snapshot)
    print(
        "HARNESS_READY port=%d data_dir=%s snapshot_dir=%s current=%s root=%s rows=%d guid=%s roots_mode=%s"
        % (
            ARGS.port,
            datadir.get_data_dir(),
            snapshots.get_snapshot_dir(),
            _CURRENT["snapshot"],
            _CURRENT["root"],
            len(_CURRENT["rows"]),
            _CURRENT["machine_guid"],
            _ROOTS_MODE,
        ),
        flush=True,
    )
    appmod.app.run(host="127.0.0.1", port=ARGS.port, threaded=True, debug=False)
