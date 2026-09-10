/* P2 红线 B 复核：用户真实数据目录跑测前后零变化（清单 + 尺寸 + mtime 三口径） */
import fs from "node:fs";
import path from "node:path";

const BASE = "docs/问题核查资料_20260908/p2/_datadir_baseline_prerun.json";
const ROOT = "C:/Users/Laptop/AppData/Local/PythonDiskScanner";

const norm = (p) => String(p).replace(/\\\\/g, "\\").replace(/\//g, "\\").toLowerCase();

function walk(dir, out) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.posix.join(dir, e.name);
        if (e.isDirectory()) walk(p, out);
        else {
            const st = fs.statSync(p);
            out.push({ name: norm(p), Length: st.size, mtime: st.mtime.toISOString() });
        }
    }
    return out;
}

const base = JSON.parse(fs.readFileSync(BASE, "utf-8"));
/* ⚠️ 基线由 PowerShell `ConvertTo-Json` 写出：DateTime 被序列化为 .NET 纪元
   `/Date(<epoch-ms>)/` 且毫秒被四舍五入（实测同一次 tick 会差 1ms）。
   故 mtime 比对按「解析后的 epoch 差 ≤2ms」判定，而非字符串相等。 */
const parseDotNetDate = (v) => {
    if (typeof v === "number") return v;
    const m = /\/Date\((-?\d+)\)\//.exec(String(v));
    if (m) return Number(m[1]);
    const t = Date.parse(String(v));
    return isNaN(t) ? null : t;
};
const MTIME_TOL_MS = 2;
const baseline = base.entries.map((e) => ({
    name: norm(e.FullName), Length: e.Length,
    mtimeMs: parseDotNetDate(e.LastWriteTimeUtc),
}));
const now = walk(ROOT, []).sort((a, b) => (a.name < b.name ? -1 : 1));
const bmap = new Map(baseline.map((e) => [e.name, e]));
const nmap = new Map(now.map((e) => [e.name, e]));

const added = [...nmap.keys()].filter((k) => !bmap.has(k));
const removed = [...bmap.keys()].filter((k) => !nmap.has(k));
const sizeChanged = [...nmap.keys()].filter((k) => bmap.has(k) && bmap.get(k).Length !== nmap.get(k).Length);
const mtimeChanged = [...nmap.keys()].filter((k) => {
    if (!bmap.has(k)) return false;
    const a = bmap.get(k).mtimeMs, b = nmap.get(k).mtimeMs;
    if (a === null || b === null) return true;
    return Math.abs(a - b) > MTIME_TOL_MS;
});
const mtimeExact = [...nmap.keys()].filter((k) => bmap.has(k) && bmap.get(k).mtimeMs === nmap.get(k).mtimeMs);

const sum = (a) => a.reduce((s, e) => s + (e.Length || 0), 0);
console.log("基线（跑测前） : " + baseline.length + " 文件 / " + sum(baseline) + " B");
console.log("收尾（跑测后） : " + now.length + " 文件 / " + sum(now) + " B");
console.log("mtime 判据      : 解析 .NET /Date(ms)/ 后按 |Δ| ≤ " + MTIME_TOL_MS + "ms 比较（ConvertTo-Json 毫秒舍入）");
console.log("新增=" + added.length + "  删除=" + removed.length + "  尺寸变化=" + sizeChanged.length +
    "  mtime 超差=" + mtimeChanged.length + "  mtime 完全相等=" + mtimeExact.length + "/" + baseline.length);
for (const k of added.slice(0, 5)) console.log("  + " + k);
for (const k of removed.slice(0, 5)) console.log("  - " + k);
for (const k of sizeChanged.slice(0, 5)) console.log("  ~size " + k);
for (const k of mtimeChanged.slice(0, 5)) console.log("  ~mtime " + k);
const pass = added.length === 0 && removed.length === 0 && sizeChanged.length === 0 && mtimeChanged.length === 0;
console.log(pass ? "红线 B：PASS（零变化：无新增/删除/尺寸变化，mtime 全部在舍入容差内）" : "红线 B：FAIL");
process.exit(pass ? 0 : 1);
