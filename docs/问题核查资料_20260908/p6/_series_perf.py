# -*- coding: utf-8 -*-
r"""P6（D6-6）· GET /api/series 性能实测夹具（证据侧脚本，**非生产代码**）。

做什么
------
1. 在 %TEMP% 隔离目录生成 N 份真实快照（gzip JSONL + 头部 CRC，走生产
   `snapshots.save_snapshot`），每份 rows 行（缺省 5 × 130000，对齐提示词
   §一.1.3 的「5 份 × 13 万行」口径）；
2. 用 Flask test_client（进程内，无网络噪声）测三组耗时：
     · 冷启动（清空 app._SERIES_CACHE / _ROOT_TOTAL_CACHE 后首次请求）
     · 缓存命中（同参数复跑）
     · 换 path 的冷启动（缓存键含 path → 必须实解析）
3. 对照测 `/api/snapshots` 的耗时（P6 给 `_snapshot_root_total` 加了缓存，
   D6-3 约束「不得让 /api/snapshots 变慢」——本脚本给出实测数字）。

隔离与红线
----------
- 快照目录 = `%TEMP%\pds_p6_perf\snapshots`；`DSA_SNAPSHOT_DIR`/`LOCALAPPDATA`
  在 import 生产模块前重定向到该夹具目录；
- 不触碰用户真实数据目录、不调用 Everything SDK、不启动任何服务。

用法
----
  .venv\\Scripts\\python.exe docs\\问题核查资料_20260908\\p6\\_series_perf.py \
      [--snapshots 5] [--rows 130000] [--out <目录>]
"""

import argparse
import json
import os
import statistics
import sys
import tempfile
import time
from datetime import datetime, timedelta
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT))


def _parse_args():
    ap = argparse.ArgumentParser(description="P6 /api/series 性能实测（证据侧夹具）")
    ap.add_argument("--snapshots", type=int, default=5)
    ap.add_argument("--rows", type=int, default=130000)
    ap.add_argument("--repeats", type=int, default=3)
    ap.add_argument("--out", default=None, help="结果 JSON 输出目录（缺省 = 本文件同级 perf/）")
    return ap.parse_args()


ARGS = _parse_args()
OUT_DIR = Path(ARGS.out) if ARGS.out else (Path(__file__).resolve().parent / "perf")
OUT_DIR.mkdir(parents=True, exist_ok=True)

FIXTURE_HOME = Path(tempfile.gettempdir()) / "pds_p6_perf"
SNAP_DIR = FIXTURE_HOME / "snapshots"
SNAP_DIR.mkdir(parents=True, exist_ok=True)

# ---- 隔离：数据目录/快照目录一律落在 %TEMP% 夹具内（必须在 import 生产模块前设置）
os.environ["LOCALAPPDATA"] = str(FIXTURE_HOME / "home")
os.environ["DSA_SNAPSHOT_DIR"] = str(SNAP_DIR)
os.environ.pop("DSA_NO_SNAPSHOT", None)

import snapshots  # noqa: E402  生产模块
from app import app, _SERIES_CACHE, _ROOT_TOTAL_CACHE  # noqa: E402

ROOT = "D:\\PERF"


def build_rows(count):
    """合成行数**精确等于 count** 的树（父目录行含全部后代，与真实扫描同构）。

    结构：ROOT → 20 个 dir → 每 dir 20 个 sub → 每 sub N 个文件行；
    目录行在其全部文件行之后写出（父行大小 = 后代之和），根行最后写。
    行序截断到 count-1 后重写根行合计——截断只发生在文件行区，
    因此层级关系保持自洽（根行 = 其余行之和）。
    """
    top = 20
    mid = 20
    dirs = top * (1 + mid)              # 20 + 400
    files_total = max(1, count - 1 - dirs)
    per_sub = -(-files_total // (top * mid))  # 向上取整，截断在下方精确对齐
    rows = []
    for a in range(top):
        a_path = "%s\\dir%02d" % (ROOT, a)
        for b in range(mid):
            b_path = "%s\\sub%02d" % (a_path, b)
            for f in range(per_sub):
                size = 4096 + ((a * 31 + b * 17 + f * 7) % 512) * 8
                rows.append({"p": "%s\\file%03d.bin" % (b_path, f), "s": size})
    if len(rows) < files_total:
        raise SystemExit("合成行数不足：%d < %d" % (len(rows), files_total))
    rows = rows[:files_total]
    # 文件行齐备后再补目录行（父 = 子和；目录行以「其后代文件之和」写出）
    sums = {}
    for row in rows:
        parent = row["p"].rsplit("\\", 1)[0]
        sums[parent] = sums.get(parent, 0) + row["s"]
    dir_rows = []
    for a in range(top):
        a_path = "%s\\dir%02d" % (ROOT, a)
        a_sum = 0
        for b in range(mid):
            b_path = "%s\\sub%02d" % (a_path, b)
            b_sum = sums.get(b_path, 0)
            if b_sum:
                dir_rows.append({"p": b_path, "s": b_sum})
                a_sum += b_sum
        if a_sum:
            dir_rows.append({"p": a_path, "s": a_sum})
    rows = rows + dir_rows
    rows = rows[: count - 1]
    rows.append({"p": ROOT, "s": sum(r["s"] for r in rows)})
    return rows


def ensure_fixtures():
    rows = build_rows(ARGS.rows)
    paths = []
    base = datetime(2026, 9, 1, 10, 0, 0)
    for i in range(ARGS.snapshots):
        stamp = base + timedelta(days=i)
        name = "PERF_%s_explicit_%08x.snap.gz" % (stamp.strftime("%Y%m%d_%H%M%S"), i)
        target = SNAP_DIR / name
        if target.exists():
            paths.append(str(target))
            continue
        p = snapshots.save_snapshot(
            ROOT, rows, dir_path=SNAP_DIR, auto=False,
            machine_guid="p6perf-0000-4000-8000-00000000perf",
            fingerprint={"count": len(rows), "crc32": i}, now=stamp,
        )
        paths.append(str(p))
    return sorted(paths), len(rows)


def timed(fn, repeats):
    """返回 (每次耗时 ms 列表, 末次结果)。ms[0] = 冷启动（首跑），其余为复跑。"""
    out = []
    for _ in range(repeats):
        t0 = time.perf_counter()
        value = fn()
        out.append((time.perf_counter() - t0) * 1000.0)
    return out, value


def _case(times, **extra):
    data = {
        "ms": [round(x, 2) for x in times],
        "ms_first": round(times[0], 2),
        "ms_median": round(statistics.median(times), 2),
        "ms_min": round(min(times), 2),
    }
    data.update(extra)
    return data


def main():
    paths, row_count = ensure_fixtures()
    sizes = [Path(p).stat().st_size for p in paths]
    result = {
        "meta": {
            "generated_at": datetime.now().isoformat(timespec="seconds"),
            "snapshot_dir": str(SNAP_DIR),
            "snapshots": len(paths),
            "rows_per_snapshot": row_count,
            "rows_total_if_all_parsed": row_count * len(paths),
            "file_bytes": sizes,
            "file_bytes_total": sum(sizes),
            "note": "耗时 = Flask test_client 进程内往返（无网络/无浏览器），单位 ms",
        },
        "cases": {},
        "paths": paths,
    }

    with app.test_client() as client:
        # ① 冷启动（清空两级缓存）
        _SERIES_CACHE.clear()
        _ROOT_TOTAL_CACHE.clear()
        times, resp = timed(
            lambda: client.get("/api/series", query_string={"root": ROOT, "snapshots": paths}),
            ARGS.repeats,
        )
        body = resp.get_json()
        result["cases"]["series_cold"] = _case(
            times,
            count=body["count"],
            rows_total=body["rows_total"],
            bytes_last_point=body["points"][-1]["bytes"],
            response_bytes=len(resp.get_data()),
            cached_flags=[p["cached"] for p in body["points"]],
        )

        # ② 缓存命中
        times, resp = timed(
            lambda: client.get("/api/series", query_string={"root": ROOT, "snapshots": paths}),
            ARGS.repeats,
        )
        body = resp.get_json()
        result["cases"]["series_warm"] = _case(
            times, cached_flags=[p["cached"] for p in body["points"]]
        )

        # ③ 换 path（缓存键含 path → 首跑必实解析，复跑命中）
        sub = "%s\\dir00" % ROOT
        times, resp = timed(
            lambda: client.get("/api/series",
                               query_string={"root": ROOT, "snapshots": paths, "path": sub}),
            ARGS.repeats,
        )
        body = resp.get_json()
        result["cases"]["series_path_cold_then_warm"] = _case(
            times,
            path=sub,
            bytes_last_point=body["points"][-1]["bytes"],
            cached_flags=[p["cached"] for p in body["points"]],
        )

        # ④ depth 口径（再换一次缓存键）
        times, resp = timed(
            lambda: client.get("/api/series",
                               query_string={"root": ROOT, "snapshots": paths,
                                             "path": sub, "depth": 2}),
            ARGS.repeats,
        )
        body = resp.get_json()
        result["cases"]["series_depth2"] = _case(
            times,
            rows_last_point=body["points"][-1]["rows"],
            bytes_last_point=body["points"][-1]["bytes"],
        )

        # ⑤ 共享缓存自证：清掉 series 自己的键、保留根统计缓存 → 根口径点应仍命中
        _SERIES_CACHE.clear()
        times, resp = timed(
            lambda: client.get("/api/series", query_string={"root": ROOT, "snapshots": paths}),
            1,
        )
        body = resp.get_json()
        result["cases"]["series_after_series_cache_clear_shared_root"] = _case(
            times, cached_flags=[p["cached"] for p in body["points"]]
        )

        # ⑥ /api/snapshots 对照（P6 给它加了根总量缓存；D6-3 约束「不得变慢」）
        import session as session_module

        session_module.save_session(
            {
                "session_id": "session_p6_perf_1",
                "auto": False,
                "machine_guid": "p6perf-0000-4000-8000-00000000perf",
                "created_at": "2026-09-05T10:00:00",
                "roots": {
                    ROOT: {"root": ROOT, "snapshot": Path(paths[-1]).name,
                           "snapshot_path": paths[-1], "skipped": False},
                },
            },
            dir_path=SNAP_DIR.parent,
        )
        from unittest import mock

        with mock.patch.object(session_module, "list_sessions",
                               return_value=sorted((SNAP_DIR.parent).glob("session_*.json"))):
            _ROOT_TOTAL_CACHE.clear()
            times, resp = timed(lambda: client.get("/api/snapshots"), ARGS.repeats)
            result["cases"]["snapshots_cold_total_cache"] = _case(times)
            times, resp = timed(lambda: client.get("/api/snapshots"), ARGS.repeats)
            body = resp.get_json()
            result["cases"]["snapshots_warm_total_cache"] = _case(
                times, total_by_root=(body["sessions"][0] or {}).get("total_by_root")
            )

    result["verdict"] = {
        "series_cold_median_ms": result["cases"]["series_cold"]["ms_median"],
        "series_cold_first_ms": result["cases"]["series_cold"]["ms_first"],
        "series_warm_median_ms": result["cases"]["series_warm"]["ms_median"],
        "snapshots_cold_ms": result["cases"]["snapshots_cold_total_cache"]["ms_first"],
        "snapshots_warm_ms": result["cases"]["snapshots_warm_total_cache"]["ms_median"],
        "shared_root_cache": result["cases"]["series_after_series_cache_clear_shared_root"]["cached_flags"],
    }
    out_file = OUT_DIR / "series_perf.json"
    out_file.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({k: v for k, v in result["cases"].items()}, ensure_ascii=False, indent=2))
    print("PERF_JSON=%s" % out_file)
    print("VERDICT=%s" % json.dumps(result["verdict"], ensure_ascii=False))


if __name__ == "__main__":
    main()
