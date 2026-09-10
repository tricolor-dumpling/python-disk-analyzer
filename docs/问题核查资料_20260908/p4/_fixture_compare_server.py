# -*- coding: utf-8 -*-
"""P4 对比深度/零增量验收 · 夹具对比服务（证据侧 harness，**非生产代码**）。

为什么需要它
------------
/api/compare 的「当前」侧 = fullscan.result(root) 缓存或 SDK 直扫真实磁盘
（app.py 同步路径 :974 起 / 异步路径 :908 起）。真实磁盘内容不可复现，而 P4 的
判据（零增量空态 / 正负增量同榜 / 深度聚合 / 下钻）必须逐一确定复现，因此本
harness 只替换**一个数据源**：把 fullscan.result(root) 换成夹具快照行——这正是
tests/test_api_contract.py:411-418 既有的数据源桩口径（{root, rows} 契约）。

真实面（未替换，全部走生产代码）
--------------------------------
Flask 路由 / 模板 / 静态资源 / session 与 snapshots 读盘（真实 load_snapshot，
含 CRC 与头部校验）/ compare 引擎 / app.py 的两条对比返回路径 / 前端全部 JS。

隔离与红线（红线 B：用户真实数据目录零写入）
--------------------------------------------
- 进程启动前改写 LOCALAPPDATA 与 DSA_SNAPSHOT_DIR 指向 %TEMP% 夹具目录，
  启动时打印实际生效的数据目录，供证据核对；
- scan.scan_via_everything_sdk 被换成抛错桩：任何意外走到「SDK 直扫」分支都会
  立即失败（绝不触碰真实磁盘、绝不调用 Everything SDK）；
- snapshots.get_machine_guid 覆写为夹具 GUID（夹具固定值）：真实注册表
  MachineGuid 与夹具不同，不覆写会让每次对比都落到 W2.13 异机确认分支；
- 本文件不修改任何生产文件，仅在本进程内 monkeypatch 上述三个函数。

当前侧数据集控制
----------------
POST /__harness/current  {"snapshot": "<绝对路径.snap.gz>"}  → 切换当前侧数据集
GET  /__harness/state                                       → 回显当前状态
（仅存在于 harness 进程，不是生产路由；生产 404 处理器不受影响）

用法
----
  python _fixture_compare_server.py --port 5101 \
      --data-home <隔离 LOCALAPPDATA> \
      --snapshot-dir <夹具 snapshots 目录> \
      --current-snapshot <当前侧快照文件>
"""

import argparse
import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT))


def _parse_args():
    ap = argparse.ArgumentParser(description="P4 夹具对比服务（证据侧 harness）")
    ap.add_argument("--port", type=int, required=True)
    ap.add_argument("--data-home", required=True, help="隔离的 LOCALAPPDATA")
    ap.add_argument("--snapshot-dir", required=True, help="夹具快照目录（DSA_SNAPSHOT_DIR）")
    ap.add_argument("--current-snapshot", required=True, help="当前侧数据集来源快照")
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


# =================【数据源替换（唯一被替换的生产行为）】=================

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


def _fake_is_running():
    return False


def _fake_status():
    """fullscan.status 的夹具替身：声称「当前根的全量扫描已完成、结果可用」。

    为什么需要：/api/compare 的同步快路径只在 fullscan.result(root) 有行时命中，
    而前端与 u67 等探针会先读 /api/fullscan/status 的 result_ready 决定后续路径；
    不替换该状态，页面会按「无缓存」走 202 + SDK 直扫分支（真实磁盘扫描，红线 B）。
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
    }


# =================【启动】=================

if __name__ == "__main__":
    utils.VERBOSE = False
    _load_current(ARGS.current_snapshot)
    print(
        "HARNESS_READY port=%d data_dir=%s snapshot_dir=%s current=%s root=%s rows=%d guid=%s"
        % (
            ARGS.port,
            datadir.get_data_dir(),
            snapshots.get_snapshot_dir(),
            _CURRENT["snapshot"],
            _CURRENT["root"],
            len(_CURRENT["rows"]),
            _CURRENT["machine_guid"],
        ),
        flush=True,
    )
    appmod.app.run(host="127.0.0.1", port=ARGS.port, threaded=True, debug=False)
