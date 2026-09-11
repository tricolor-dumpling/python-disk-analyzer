/* P5 红线 B 复核：用户真实数据目录跑测前后零变化（清单 + 尺寸 + mtime 三口径）。
   用法：
     node docs/问题核查资料_20260908/p5/_verify_datadir_redline.mjs --snapshot
        → 采集当前状态写入 _datadir_baseline_prerun.json（跑测**前**执行一次）
     node docs/问题核查资料_20260908/p5/_verify_datadir_redline.mjs
        → 复核：与基线逐文件比对，输出 新增/删除/尺寸/mtime 四口径结果

   ⚠️ 为什么基线也由本脚本（Node）采集，而不是沿用 P4 的 PowerShell 采集：
   PS 5.1 侧踩坑四次实测记录 ——
     1) `Select-Object FullName,Length,LastWriteTimeUtc` + ConvertTo-Json 会把 DateTime
        **展开成对象**（{value:"/Date(ms)/", DateTime:"..."}），且写的是本地时间；
     2) `[datetime]'1970-01-01'` 按本地时区解析（Kind=Local）→ 整体偏移 8 小时；
     3) `[datetime]'...Z'` 字面量的 Z 被忽略，同样偏移；
     4) 本机未加载 System 程序集，`[System.DateTimeOffset]::UtcNow` 返回 $null。
   同进程采集 + 比对可彻底消除跨运行时的时区/序列化口径差；
   Unix 毫秒 = Date.getTime()，两侧同源，无歧义。

   说明：P5 全程以隔离数据目录跑测（夹具服务在进程内改写 LOCALAPPDATA 与
   DSA_SNAPSHOT_DIR 指向 %TEMP%），本脚本证伪「跑测期间真实目录被写入/删除/改动」。 */
import fs from "node:fs";
import path from "node:path";

const BASE = "docs/问题核查资料_20260908/p8/_datadir_baseline_prerun.json";
const ROOT = "C:/Users/Laptop/AppData/Local/PythonDiskScanner";
const MODE_SNAPSHOT = process.argv.includes("--snapshot");
const MTIME_TOL_MS = 2;

const norm = (p) => String(p).replace(/\\\\/g, "\\").replace(/\//g, "\\").toLowerCase();

function walk(dir, out) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.posix.join(dir, e.name);
        if (e.isDirectory()) walk(p, out);
        else {
            const st = fs.statSync(p);
            /* 字段名 mtimeMs 与基线一致，且取 epoch 毫秒（Date.getTime()） */
            out.push({ name: norm(p), Length: st.size, mtimeMs: st.mtime.getTime() });
        }
    }
    return out;
}

const now = walk(ROOT, []).sort((a, b) => (a.name < b.name ? -1 : 1));
const sum = (a) => a.reduce((s, e) => s + (e.Length || 0), 0);

/* ---------------- 采集模式 ---------------- */
if (MODE_SNAPSHOT) {
    const payload = now.map((e) => ({ FullName: e.name, Length: e.Length, MtimeMs: e.mtimeMs }));
    fs.writeFileSync(BASE, JSON.stringify(payload, null, 2), "utf-8");
    console.log("已采集跑测前基线：" + payload.length + " 文件 / " + sum(payload) +
        " B → " + BASE);
    process.exit(0);
}

/* ---------------- 复核模式 ---------------- */
const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf-8").replace(/^\uFEFF/, ""));
const base = readJson(BASE);
const parseMtimeMs = (v) => {
    if (typeof v === "number") return v;
    if (v && typeof v === "object") {          // 兼容历史 PowerShell DateTime 展开形态
        if (typeof v.value === "number") return v.value;
        const mm = /\/Date\((-?\d+)\)\//.exec(String(v.value || ""));
        if (mm) return Number(mm[1]);
        const t0 = Date.parse(String(v.value || ""));
        return isNaN(t0) ? null : t0;
    }
    const m = /\/Date\((-?\d+)\)\//.exec(String(v));
    if (m) return Number(m[1]);
    const t = Date.parse(String(v));
    return isNaN(t) ? null : t;
};
const baseline = base.map((e) => ({
    name: norm(e.FullName), Length: e.Length,
    mtimeMs: typeof e.MtimeMs !== "undefined" ? parseMtimeMs(e.MtimeMs) : parseMtimeMs(e.LastWriteTimeUtc),
}));
const bmap = new Map(baseline.map((e) => [e.name, e]));
const nmap = new Map(now.map((e) => [e.name, e]));

const added = [...nmap.keys()].filter((k) => !bmap.has(k));
const removed = [...bmap.keys()].filter((k) => !nmap.has(k));
const sizeChanged = [...nmap.keys()].filter((k) => bmap.has(k) && bmap.get(k).Length !== nmap.get(k).Length);
/* ⚠️ 不可解析 / NaN 的 mtime 必须**算作失败**，不能让判据悄悄通过：
   NaN 参与 `> tol` 比较恒为 false（JS 语义）——P5 第一版就因字段名写错
   （walk 里给的是 mtime，比对读的是 mtimeMs）把 43/43 全 NaN 判成「零变化」假绿。
   故：① 解析失败单列；② 逐文件 |Δ| 必须有限；③ maxDelta 有限性兜底。 */
const unparsable = [...nmap.keys()].filter((k) => bmap.has(k) && !Number.isFinite(bmap.get(k).mtimeMs));
const deltas = [...nmap.keys()]
    .filter((k) => bmap.has(k) && Number.isFinite(bmap.get(k).mtimeMs))
    .map((k) => Math.abs(bmap.get(k).mtimeMs - nmap.get(k).mtimeMs));
const mtimeChanged = [...nmap.keys()].filter((k) => {
    if (!bmap.has(k)) return false;
    const a = bmap.get(k).mtimeMs;
    if (!Number.isFinite(a)) return true;
    return Math.abs(a - nmap.get(k).mtimeMs) > MTIME_TOL_MS;
});
const mtimeExact = [...nmap.keys()].filter((k) => bmap.has(k) && bmap.get(k).mtimeMs === nmap.get(k).mtimeMs);
const maxDelta = deltas.length ? Math.max(...deltas) : 0;

console.log("基线（跑测前） : " + baseline.length + " 文件 / " + sum(baseline) + " B");
console.log("收尾（跑测后） : " + now.length + " 文件 / " + sum(now) + " B");
console.log("mtime 判据      : Unix 毫秒（Date.getTime()）逐文件比较，容差 |Δ| ≤ " + MTIME_TOL_MS + "ms");
console.log("新增=" + added.length + "  删除=" + removed.length + "  尺寸变化=" + sizeChanged.length +
    "  mtime 超差=" + mtimeChanged.length + "  mtime 解析失败=" + unparsable.length +
    "  mtime 完全相等=" + mtimeExact.length + "/" + baseline.length +
    "  最大 |Δmtime|=" + maxDelta + "ms");
for (const k of added.slice(0, 5)) console.log("  + " + k);
for (const k of removed.slice(0, 5)) console.log("  - " + k);
for (const k of sizeChanged.slice(0, 5)) console.log("  ~size " + k);
for (const k of mtimeChanged.slice(0, 5)) console.log("  ~mtime " + k);

const pass = added.length === 0 && removed.length === 0 && sizeChanged.length === 0 &&
    mtimeChanged.length === 0 && unparsable.length === 0 && Number.isFinite(maxDelta);
console.log(pass
    ? "红线 B：PASS（零变化：无新增/删除/尺寸变化，" + baseline.length +
      " 个文件 mtime 全部在容差内，最大 |Δ|=" + maxDelta + "ms）"
    : "红线 B：FAIL（新增=" + added.length + " 删除=" + removed.length + " 尺寸=" + sizeChanged.length +
      " mtime超差=" + mtimeChanged.length + " 解析失败=" + unparsable.length + " maxDelta=" + maxDelta + "）");
process.exit(pass ? 0 : 1);
