# -*- coding: utf-8 -*-
"""P0-4 校验：三类新夹具与 snapshots.py / compare.py / session.py 兼容性。"""
import glob
import os
import sys

sys.path.insert(0, r"D:/deepseek/python-disk-analyzer")
from snapshots import load_snapshot
from compare import compare_snapshots
from session import list_sessions

root = os.environ["DSA_SNAPSHOT_DIR"]
files = sorted(glob.glob(os.path.join(root, "*.snap.gz")))
n_fail = 0
for f in files:
    try:
        load_snapshot(f)
    except Exception as e:  # noqa: BLE001
        n_fail += 1
        print("LOAD FAIL", os.path.basename(f), e)
print("load_snapshot OK:", len(files) - n_fail, "/", len(files))

def pick(sub):
    return [f for f in files if sub in f][0]

# growth: D:\ 正/负/零 混合 + 第 4 层深
g0 = load_snapshot(pick("20260907_170000"))
g1 = load_snapshot(pick("20260908_170000"))
d = {r["path"]: r["delta"] for r in compare_snapshots(g0, g1)["rows"]}
print("growth delta[D:\\] =", d.get("D:\\"), "(expect +50)")
print("growth delta[D:\\apps] =", d.get("D:\\apps"), "(expect +100)")
print("growth delta[D:\\apps\\framework\\core\\engine] =", d.get("D:\\apps\\framework\\core\\engine"), "(expect +80, 4层深)")
print("growth delta[D:\\data] =", d.get("D:\\data"), "(expect 0)")
print("growth delta[D:\\docs] =", d.get("D:\\docs"), "(expect -50)")

# flat: 全 0 增量
f0 = load_snapshot(pick("20260907_110000"))
f1 = load_snapshot(pick("20260908_110000"))
df = {r["path"]: r["delta"] for r in compare_snapshots(f0, f1)["rows"]}
print("flat all_zero =", all(v == 0 for v in df.values()), "rows =", len(df))

# series: 6 时刻同根递进总量（用 D:\ 根总量）
step = []
for tag in ["20260907_230000", "20260908_030000", "20260908_070000",
            "20260908_130000", "20260908_150000", "20260908_190000"]:
    s = load_snapshot(pick(tag))
    total = next((r["s"] for r in s["rows"] if r["p"].rstrip("\\/") == "D:"), None)
    step.append(total)
print("series D:\\ totals =", step, "monotonic_increasing =", all(step[i] < step[i + 1] for i in range(len(step) - 1)))

# session 枚举（数据目录根 = fixture root）
froot = root + os.sep + ".."
se = list_sessions(froot)
print("list_sessions count =", len(se) if se else 0)
print("P0-FIXTURE-VALIDATION-DONE")
