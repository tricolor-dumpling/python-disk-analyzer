/* ============================================================
   阶段 P4 · p04_compare_depth_probe.mjs
   （问题 5：对比只能看最深目录 → 深度聚合/下钻；问题 6：无增量也列 0 行）
   ------------------------------------------------------------
   目标（计划第十章 · P4 / D4-1…D4-6）：
     ① 后端：/api/compare 的 depth 聚合、零增量过滤与排序、additive 汇总字段；
     ② 前端：深度选择器、隐藏零变化开关、空态判据、页内下钻 + 面包屑、摘要口径。

   口径（红线 A：探针必须先能在修复前代码上跑出违规）
     · 「当前」侧数据集 = 夹具快照行（_fixture_compare_server.py 的既定数据源
       桩，契约 {root, rows}）——真实磁盘内容不可复现，而本探针的判据要求逐态
       确定复现；服务/路由/引擎/前端全部为生产代码。
     · 判据全部由探针自行从夹具原始行（.snap.gz 直读）推导，不引用后端汇总字段
       作为期望值（避免自证循环）。

   硬判据（任一 >0 → exit 1）
     J1  depth 控件缺失 / depth 未被后端生效（depth=1 返回行 ≠ 顶层条目数）
     J2  Σ(返回行 delta) + 未覆盖残差 ≠ delta_total
         （残差 = 被折叠祖先与根的「直属字节」增量，由夹具原始行独立推算；
           真实扫描数据每目录/文件皆有行、父含子，残差恒为 0——见报告 §口径）
     J3  开「隐藏零变化」时返回行含 delta==0
     J4  表格实际渲染行数 ≠ 后端返回行数（前端自行增删行）
     J5  摘要三卡数值 ≠ 后端 additive 汇总字段
     J6  flat 夹具（两侧完全一致）未收敛到空态 / 仍渲染 0 增量数据行
     J7  行点击未触发页内下钻（无下钻根 / 面包屑未反映 / 下钻后 root 未换）
     J8  console.error / pageerror（按 URL 过滤 favicon）

   用法
     node scripts/dev/p04_compare_depth_probe.mjs --label prefix|postfix \
          --out <绝对目录> [--base <外部 harness base>] [--fixture-root <夹具数据目录>]
     （无 --base 时探针自行拉起 _fixture_compare_server.py，退出时回收）

   输出
     <out>/api-<label>.json       API 层逐次请求量化（depth 入参/行数/零行/汇总）
     <out>/layout-<label>.json    逐视口逐态 DOM 量化（控件/行/摘要/面包屑）
     <out>/summary-<label>.json   判定汇总（违规计数 + 逐项明细）
     <out>/*.png                  3 视口 × 4 态 = 12 张关键帧
   ============================================================ */

import { chromium } from "./_harness.mjs";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

function arg(name, dflt) {
    const i = process.argv.indexOf("--" + name);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "..");
const LABEL = arg("label", "run");
const OUT = path.resolve(arg("out", path.join(os.tmpdir(), "p04_compare_depth")));
const FIXTURE_ROOT = path.resolve(arg("fixture-root", path.join(os.tmpdir(), "pds_p4_iso", "home", "PythonDiskScanner")));
const SNAP_DIR = path.join(FIXTURE_ROOT, "snapshots");
const EXTERNAL_BASE = arg("base", null);
const PORT = Number(arg("port", "5101"));
const HARNESS = path.join(REPO, "docs", "问题核查资料_20260908", "p4", "_fixture_compare_server.py");
const PY = path.join(REPO, ".venv", "Scripts", "python.exe");
const FIXTURE_NOW = "2026-09-08T20:00:00";
const FILES = {
    growthT0: "D_20260907_170000_explicit_3f2a1c9d.snap.gz",
    growthT1: "D_20260908_170000_explicit_3f2a1c9d.snap.gz",
    flatA: "D_20260907_110000_explicit_3f2a1c9d.snap.gz",
    flatB: "D_20260908_110000_explicit_3f2a1c9d.snap.gz",
    // P4 挂账清理：树一致夹具（父=子和，任意 depth 残差恒为 0）
    treeT0: "D_20260907_050000_explicit_3f2a1c9d.snap.gz",
    treeT1: "D_20260908_050000_explicit_3f2a1c9d.snap.gz",
};
const ROOT = "D:\\";

const VIEWPORTS = [{ w: 1366, h: 768 }, { w: 1440, h: 900 }, { w: 1920, h: 1080 }];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

const RESULT = {
    meta: {
        label: LABEL, out: OUT, node: process.version, startedAt: new Date().toISOString(),
        fixtureRoot: FIXTURE_ROOT, snapshotDir: SNAP_DIR, fixtureNow: FIXTURE_NOW,
        viewports: VIEWPORTS.map((v) => v.w + "x" + v.h),
    },
    api: [], samples: [], shots: [], consoleErrors: [], violations: [],
};

/* ================= 夹具：原始行读取（期望值独立推导源） ================= */

function readSnapshotRows(file) {
    const buf = zlib.gunzipSync(fs.readFileSync(file));
    const lines = buf.toString("utf-8").split("\n").filter((s) => s.trim());
    const header = JSON.parse(lines[0]);
    const rows = lines.slice(1).map((l) => JSON.parse(l));
    return { header, rows, map: new Map(rows.map((r) => [r.p, r.s])) };
}

function norm(p) { return String(p).replace(/[\\/]+$/, "").toLowerCase(); }
function isUnder(p, root) {
    const a = norm(p), b = norm(root);
    return a === b || a.startsWith(b + "\\");
}
function levelOf(p, root) {
    if (!isUnder(p, root)) return -1;
    const a = norm(p), b = norm(root);
    if (a === b) return 0;
    return a.slice(b.length).replace(/^\\+/, "").split("\\").filter(Boolean).length;
}
function ancestorAtLevel(p, root, depth) {
    /* 取第 depth 层祖先：按**原串**切片（保留原大小写，与后端 _ancestor_at_depth 同口径）。
       norm() 仅供比较/计数，绝不用来拼装返回路径。 */
    const s = String(p);
    const normS = norm(s);
    const normR = norm(root);
    if (normR && normS !== normR && !normS.startsWith(normR + "\\")) return p;
    const start = normR ? normR.length + 1 : 0;
    const rest = normS.slice(start);
    let idx = -1;
    for (let i = 0; i < depth; i++) {
        const nxt = rest.indexOf("\\", idx + 1);
        if (nxt < 0) return p;
        idx = nxt;
    }
    return s.slice(0, start + idx);
}
function directChild(p, child) {
    const a = p.toLowerCase(), b = child.toLowerCase();
    if (!b.startsWith(a + "\\")) return false;
    return b.slice(a.length + 1).indexOf("\\") === -1;
}

/* 未覆盖残差：delta_total − Σ(被返回行覆盖的键的「直属字节」增量)。
   直属增量 directDelta(p) = delta(p) − Σ delta(直接子键)。
   完备数据集（真实扫描：每目录/文件皆有行且父含子）下残差恒 0。 */
function residueOf(baseMap, curMap, root, returnedPaths) {
    const keys = new Set([...baseMap.keys(), ...curMap.keys()]);
    const under = [...keys].filter((k) => isUnder(k, root) && levelOf(k, root) >= 1);
    const delta = (p) => (curMap.get(p) || 0) - (baseMap.get(p) || 0);
    let covered = 0;
    for (const p of under) {
        if (!returnedPaths.some((r) => isUnder(p, r))) continue;
        let direct = delta(p);
        for (const c of under) if (directChild(p, c)) direct -= delta(c);
        covered += direct;
    }
    const total = (() => {
        const hint = [...keys].find((k) => norm(k) === norm(root));
        if (hint !== undefined) return delta(hint);
        let sum = 0;
        for (const p of under) {
            const parent = p.replace(/\\[^\\]+$/, "");
            if (!keys.has(parent) || !isUnder(parent, root) || levelOf(parent, root) === 0) sum += delta(p);
        }
        return sum;
    })();
    return { total, residue: total - covered, covered };
}

/* 参照规约（独立参照实现，用于「行集 + 数值 + 汇总口径」双向比对）：
   - depth=N：相对 root 第 N 层键 + 更浅且无后代者；根行不计（D4：深度视图只
     呈现聚合层，根合计由摘要卡承载）；目标键在则取自身值（已含后代），否则取
     组内顶层成员之和；被更深目标覆盖的更浅目标不入行集。
   - depth=null + leafOnly：叶子键（非任何其他键祖先），取自身值（app.py 既有口径）。
   ⚠️ 口径说明：本参照与后端 _rollup 同规约，作用是**钉住规约**；真正独立的
   守恒量校验是 J2（Σ + 残差 == delta_total，仅用夹具原始行推导）。 */
function referenceRows(baseMap, curMap, root, depth, leafOnly) {
    const keys = [...new Set([...baseMap.keys(), ...curMap.keys()])].filter((k) => isUnder(k, root));
    const index = new Map(keys.map((k) => [norm(k), k]));
    const value = (path) => ({
        baseline: baseMap.get(path) || 0, current: curMap.get(path) || 0,
        delta: (curMap.get(path) || 0) - (baseMap.get(path) || 0),
    });
    if (depth === null) {
        let selected = keys;
        if (leafOnly) {
            const norms = keys.map(norm);
            selected = keys.filter((k) => {
                const n = norm(k);
                return !norms.some((o) => o !== n && o.startsWith(n + "\\"));
            });
        }
        return new Map(selected.map((k) => [k, value(k)]));
    }
    const groups = new Map();
    for (const k of keys) {
        const lv = levelOf(k, root);
        if (lv <= 0) continue;
        const target = lv <= depth ? k : ancestorAtLevel(k, root, depth);
        if (!groups.has(target)) groups.set(target, []);
        groups.get(target).push(k);
    }
    const targetNorms = [...groups.keys()].map(norm);
    const isAncestorOfTarget = (t) => {
        const a = norm(t);
        return targetNorms.some((b) => b !== a && b.startsWith(a + "\\"));
    };
    const out = new Map();
    for (const [target, members] of groups) {
        if (isAncestorOfTarget(target)) continue;
        const own = index.get(norm(target));
        if (own !== undefined) {
            out.set(target, value(own));
            continue;
        }
        const memberNorms = new Set(members.map(norm));
        let b = 0, c = 0;
        for (const m of members) {
            const parent = norm(m).replace(/\\[^\\]+$/, "");
            if (memberNorms.has(parent)) continue;
            b += baseMap.get(m) || 0;
            c += curMap.get(m) || 0;
        }
        out.set(target, { baseline: b, current: c, delta: c - b });
    }
    return out;
}

function expectedLevels(baseMap, curMap, root, depth) {
    return [...referenceRows(baseMap, curMap, root, depth, false).keys()];
}

function topLevelCount(baseMap, curMap, root) {
    const keys = [...new Set([...baseMap.keys(), ...curMap.keys()])].filter((k) => isUnder(k, root));
    return keys.filter((k) => levelOf(k, root) === 1).length;
}

/* ================= harness 生命周期 ================= */

let harnessProc = null;
let harnessOut = null;

function ensureFixtures() {
    const missing = Object.values(FILES).filter((f) => !fs.existsSync(path.join(SNAP_DIR, f)));
    if (!missing.length) return { generated: false, missing: [] };
    fs.mkdirSync(FIXTURE_ROOT, { recursive: true });
    const gen = spawn(process.execPath, [
        path.join(REPO, "scripts", "dev", "fixture_snapshots.mjs"),
        "--dir", FIXTURE_ROOT, "--now", FIXTURE_NOW, "--fixture", "growth,flat,tree",
    ], { stdio: "ignore", cwd: REPO });
    return new Promise((resolve) => {
        gen.on("exit", (code) => resolve({ generated: true, exit: code, missing }));
    });
}

async function startHarness() {
    if (EXTERNAL_BASE) return { base: EXTERNAL_BASE, spawned: false };
    const dataHome = path.dirname(FIXTURE_ROOT);
    harnessOut = path.join(OUT, "harness-" + LABEL + ".log");
    const out = fs.openSync(harnessOut, "a");
    harnessProc = spawn(PY, [
        HARNESS, "--port", String(PORT), "--data-home", dataHome,
        "--snapshot-dir", SNAP_DIR, "--current-snapshot", path.join(SNAP_DIR, FILES.growthT1),
    ], { stdio: ["ignore", out, out], cwd: REPO });
    const base = "http://127.0.0.1:" + PORT + "/";
    for (let i = 0; i < 60; i++) {
        await wait(500);
        try {
            const r = await fetch(base + "__harness/state");
            if (r.ok) return { base, spawned: true };
        } catch (e) { /* 未就绪 */ }
    }
    throw new Error("harness 启动超时（日志见 " + harnessOut + "）");
}

async function setCurrent(base, snapshotFile) {
    const r = await fetch(base + "__harness/current", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ snapshot: path.join(SNAP_DIR, snapshotFile) }),
    });
    const body = await r.json();
    if (!body.ok) throw new Error("切换当前侧数据集失败: " + JSON.stringify(body));
    return body.state;
}

async function postCompare(base, payload) {
    const t0 = Date.now();
    const r = await fetch(base + "api/compare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
    const body = await r.json().catch(() => ({}));
    return { httpStatus: r.status, elapsedMs: Date.now() - t0, body };
}

/* ================= 判定工具 ================= */

function judge(list, name, pass, detail) {
    list.push({ name, pass: !!pass, detail: detail === undefined ? "" : String(detail) });
    if (!pass) RESULT.violations.push(name + " :: " + (detail === undefined ? "" : String(detail)));
}

/* ================= API 层（逐 depth 入参量化） ================= */

async function apiPhase(base) {
    const cases = [
        { key: "growth-default(无 depth 旧调用)", dataset: FILES.growthT1, baseline: FILES.growthT0, payload: {} },
        { key: "growth-depth1", dataset: FILES.growthT1, baseline: FILES.growthT0, payload: { depth: 1 } },
        { key: "growth-depth2", dataset: FILES.growthT1, baseline: FILES.growthT0, payload: { depth: 2 } },
        { key: "growth-depth1+drop_zero+order_by=abs", dataset: FILES.growthT1, baseline: FILES.growthT0,
          payload: { depth: 1, drop_zero: true, order_by: "abs" } },
        { key: "growth-default+drop_zero+order_by=abs", dataset: FILES.growthT1, baseline: FILES.growthT0,
          payload: { drop_zero: true, order_by: "abs" } },
        { key: "flat-default(旧口径)", dataset: FILES.flatB, baseline: FILES.flatA, payload: {} },
        { key: "flat-depth1+drop_zero", dataset: FILES.flatB, baseline: FILES.flatA,
          payload: { depth: 1, drop_zero: true, order_by: "abs" } },
        /* P4 挂账清理：树一致夹具的正向用例——父=子和 ⇒ 残差恒 0，
           `Σ(聚合行 delta) == delta_total` 在干净数据上精确成立（无需残差项） */
        { key: "tree(一致夹具)depth2 残差应=0", dataset: FILES.treeT1, baseline: FILES.treeT0,
          payload: { depth: 2, drop_zero: true, order_by: "abs" }, requireZeroResidue: true },
        { key: "tree(一致夹具)depth3 残差应=0", dataset: FILES.treeT1, baseline: FILES.treeT0,
          payload: { depth: 3, drop_zero: true, order_by: "abs" }, requireZeroResidue: true },
        { key: "drill D:\\apps depth1", dataset: FILES.growthT1, baseline: FILES.growthT0, root: "D:\\apps",
          payload: { depth: 1, drop_zero: true, order_by: "abs" } },
        { key: "drill D:\\apps\\framework\\core depth1", dataset: FILES.growthT1, baseline: FILES.growthT0,
          root: "D:\\apps\\framework\\core", payload: { depth: 1, drop_zero: true, order_by: "abs" } },
    ];
    const apiBase = readSnapshotRows(path.join(SNAP_DIR, FILES.growthT0));
    const apiCur = readSnapshotRows(path.join(SNAP_DIR, FILES.growthT1));
    const flatBase = readSnapshotRows(path.join(SNAP_DIR, FILES.flatA));
    const flatCur = readSnapshotRows(path.join(SNAP_DIR, FILES.flatB));
    const treeBase = readSnapshotRows(path.join(SNAP_DIR, FILES.treeT0));
    const treeCur = readSnapshotRows(path.join(SNAP_DIR, FILES.treeT1));

    for (const c of cases) {
        await setCurrent(base, c.dataset);
        const root = c.root || ROOT;
        const payload = Object.assign({ root: root, baseline: path.join(SNAP_DIR, c.baseline) }, c.payload);
        const resp = await postCompare(base, payload);
        const report = (resp.body && resp.body.report) || null;
        const rows = (report && report.rows) || [];
        const isFlat = c.key.indexOf("flat") === 0;
        const isTree = c.key.indexOf("tree") === 0;
        const B = isTree ? treeBase : isFlat ? flatBase : apiBase;
        const C = isTree ? treeCur : isFlat ? flatCur : apiCur;
        const depth = payload.depth === undefined ? null : payload.depth;
        const rec = {
            key: c.key, request: payload, httpStatus: resp.httpStatus, elapsedMs: resp.elapsedMs,
            reportKeys: report ? Object.keys(report) : null,
            rowsTotalField: report ? report.rows_total : undefined,
            zeroCountField: report ? report.zero_count : undefined,
            zeroTotalField: report ? report.zero_total : undefined,
            maxGrowthField: report ? report.max_growth : undefined,
            maxReleaseField: report ? report.max_release : undefined,
            depthField: report ? report.depth : undefined,
            deltaTotal: report ? report.delta_total : undefined,
            rowCount: rows.length,
            rowDeltas: rows.map((r) => r.delta),
            rowPaths: rows.map((r) => r.path),
            zeroRows: rows.filter((r) => r.delta === 0).length,
            judges: [],
        };
        const baseMap = new Map([...B.map].filter(([k]) => isUnder(k, root)));
        const curMap = new Map([...C.map].filter(([k]) => isUnder(k, root)));
        const returned = rows.map((r) => r.path);
        const res = residueOf(baseMap, curMap, root, returned);
        rec.sumDelta = rows.reduce((a, r) => a + r.delta, 0);
        rec.residue = res.residue;
        rec.coveredDirect = res.covered;
        rec.deltaTotalRaw = res.total;
        rec.topLevelCount = topLevelCount(baseMap, curMap, root);

        /* 参照规约（depth 给定 → 聚合层；depth=null → app.py 既有 leaf_only 口径） */
        const ref = referenceRows(baseMap, curMap, root, depth, depth === null);
        {
            const refPaths = [...ref.keys()].sort();
            const refVisible = [...ref.entries()].filter(([, v]) => !payload.drop_zero || v.delta !== 0);
            /* 返回行集应等于「参照全量集合经同一过滤（drop_zero）」后的可见集合 */
            const cmpPaths = refVisible.map(([k]) => k).sort();
            const cmpDeltas = Object.fromEntries(refVisible.map(([k, v]) => [k, v.delta]));
            const refZeros = [...ref.values()].filter((v) => v.delta === 0).length;
            rec.expectedDepthRows = refPaths.length;
            rec.expectedVisibleRows = refVisible.length;
            rec.expectedPaths = cmpPaths;
            rec.expectedDeltas = cmpDeltas;
            judge(rec.judges, "J1 行集与参照规约一致（路径集合）",
                JSON.stringify([...returned].sort()) === JSON.stringify(cmpPaths),
                "返回=" + JSON.stringify([...returned].sort()) + " 参照=" + JSON.stringify(cmpPaths));
            const gotDeltas = Object.fromEntries(rows.map((r) => [r.path, r.delta]));
            judge(rec.judges, "J1 逐行 delta 与参照规约一致",
                JSON.stringify(Object.entries(gotDeltas).sort()) === JSON.stringify(Object.entries(cmpDeltas).sort()),
                "返回=" + JSON.stringify(gotDeltas) + " 参照=" + JSON.stringify(cmpDeltas));
            judge(rec.judges, "J1 返回行数==参照可见行数",
                rows.length === Math.min(refVisible.length, 100),
                "返回=" + rows.length + " 参照可见=" + refVisible.length);
            if (depth === 1 && !payload.drop_zero) {
                judge(rec.judges, "J1 (计划硬判据) depth=1 行数 == 顶层目录数",
                    rows.length === topLevelCount(baseMap, curMap, root),
                    "返回=" + rows.length + " 顶层条目=" + topLevelCount(baseMap, curMap, root));
            }
            if (report && "rows_total" in report) {
                const refGrowth = Math.max(0, ...[...ref.values()].map((v) => v.delta));
                const refRelease = Math.max(0, ...[...ref.values()].map((v) => -v.delta));
                judge(rec.judges, "J5 汇总字段口径 == 参照全量口径",
                    Number(report.rows_total) === refPaths.length &&
                    Number(report.zero_total) === refZeros &&
                    Number(report.max_growth) === refGrowth &&
                    Number(report.max_release) === refRelease &&
                    Number(report.zero_count) === rows.filter((r) => r.delta === 0).length,
                    "后端=" + JSON.stringify([report.rows_total, report.zero_total, report.max_growth,
                        report.max_release, report.zero_count]) +
                    " 参照=" + JSON.stringify([refPaths.length, refZeros, refGrowth, refRelease,
                        rows.filter((r) => r.delta === 0).length]));
            }
        }

        judge(rec.judges, "J2 Σ(行delta)+残差==delta_total",
            rec.sumDelta + rec.residue === rec.deltaTotalRaw,
            "Σ=" + rec.sumDelta + " 残差=" + rec.residue + " delta_total=" + rec.deltaTotalRaw);
        if (c.requireZeroResidue) {
            judge(rec.judges, "J2(树一致夹具) 残差==0 且 Σ==delta_total（计划硬判据原式）",
                rec.residue === 0 && rec.sumDelta === rec.deltaTotalRaw,
                "Σ=" + rec.sumDelta + " 残差=" + rec.residue + " delta_total=" + rec.deltaTotalRaw);
        }
        if (depth !== null) {
            judge(rec.judges, "J1 depth=" + depth + " 返回行数 > 0（无假空态）",
                !payload.drop_zero || rows.length > 0 || rec.expectedVisibleRows === 0,
                "rows=" + rows.length + " 参照可见=" + rec.expectedVisibleRows);
        }
        if (payload.drop_zero) {
            judge(rec.judges, "J3 开过滤时零行==0", rec.zeroRows === 0,
                "zeroRows=" + rec.zeroRows + " zero_count=" + rec.zeroCountField);
        }
        judge(rec.judges, "J5 additive 汇总字段齐备",
            report && ["rows_total", "zero_count", "zero_total", "max_growth", "max_release", "depth"].every((k) => k in report),
            "reportKeys=" + JSON.stringify(rec.reportKeys));
        if (report && "rows_total" in report) {
            judge(rec.judges, "J5 depth 回显==入参",
                (report.depth === null || report.depth === undefined) ? depth === null : Number(report.depth) === Number(depth),
                "回显=" + JSON.stringify(report.depth) + " 入参=" + JSON.stringify(depth));
        }
        if (isFlat && payload.drop_zero) {
            judge(rec.judges, "J6 flat 夹具返回 0 行", rows.length === 0, "rows=" + rows.length);
        }
        RESULT.api.push(rec);
    }
}

/* ================= UI 层（3 视口 × 4 态） ================= */

const STATES = [
    { key: "growth-depth1", dataset: FILES.growthT1, baseline: FILES.growthT0, depth: "1", hideZero: true, drill: null },
    { key: "growth-depth2-drill", dataset: FILES.growthT1, baseline: FILES.growthT0, depth: "2", hideZero: true,
      drill: "D:\\apps\\framework" },
    { key: "flat-empty", dataset: FILES.flatB, baseline: FILES.flatA, depth: "1", hideZero: true, drill: null },
    { key: "growth-default", dataset: FILES.growthT1, baseline: FILES.growthT0, depth: "", hideZero: true, drill: null },
];

function measure() {
    const q = (s) => document.querySelector(s);
    const depthSel = q("#compare-depth");
    const hideBox = q("#compare-hide-zero");
    const body = q("#compare-body");
    const rows = body ? Array.from(body.querySelectorAll("tr")) : [];
    const dataRows = rows.filter((tr) => !tr.querySelector(".empty-state"));
    const stats = Array.from(document.querySelectorAll("#compare-summary .compare-stat")).map((el) => ({
        label: (el.querySelector(".compare-stat-label") || {}).textContent || "",
        target: (el.querySelector(".compare-stat-num") || {}).getAttribute
            ? (el.querySelector(".compare-stat-num") || {}).getAttribute("data-target") : null,
        text: ((el.querySelector(".compare-stat-num") || {}).textContent || "").trim(),
    }));
    return {
        depthControl: !!depthSel,
        depthValue: depthSel ? depthSel.value : null,
        depthOptions: depthSel ? Array.from(depthSel.options).map((o) => o.value + ":" + o.textContent.trim()) : [],
        hideZeroControl: !!hideBox,
        hideZeroChecked: hideBox ? !!hideBox.checked : null,
        crumbText: (q("#compare-crumb") ? q("#compare-crumb").textContent : "").trim(),
        crumbItems: q("#compare-crumb")
            ? Array.from(q("#compare-crumb").querySelectorAll("[data-crumb-path]")).map((b) => b.getAttribute("data-crumb-path"))
            : [],
        drillableRows: dataRows.filter((tr) => tr.hasAttribute("data-drill-path")).length,
        rowDeltas: dataRows.map((tr) => {
            const cell = tr.querySelector(".delta-cell");
            return cell ? cell.textContent.trim() : null;
        }),
        tableRows: dataRows.length,
        divergeRows: Array.from(document.querySelectorAll("#compare-diverge .diverge-row")).length,
        emptyText: (body && body.querySelector(".empty-state"))
            ? body.querySelector(".empty-state").textContent.replace(/\s+/g, " ").trim() : "",
        divergeEmptyText: (() => {
            const e = document.querySelector("#compare-diverge .diverge-empty");
            return e ? e.textContent.replace(/\s+/g, " ").trim() : "";
        })(),
        statusText: (q("#compare-status-text") || {}).textContent || "",
        summary: stats,
        resultHidden: q("#compare-result") ? q("#compare-result").hasAttribute("hidden") : null,
    };
}

async function runState(page, base, state) {
    await setCurrent(base, state.dataset);
    const sample = { state: state.key, vw: page.viewportSize().width, vh: page.viewportSize().height, judges: [] };

    /* 表单：基线 + 深度 + 隐藏零变化 */
    await page.evaluate(() => { window.location.hash = "#/compare"; });
    await page.waitForSelector("#compare-baseline", { timeout: 15000 });
    await page.fill("#compare-baseline", path.join(SNAP_DIR, state.baseline));
    const hasDepth = await page.$("#compare-depth");
    if (hasDepth) {
        await page.selectOption("#compare-depth", state.depth === "" ? "" : state.depth).catch(async () => {
            await page.evaluate((v) => {
                const s = document.getElementById("compare-depth");
                s.value = v;
                s.dispatchEvent(new Event("change", { bubbles: true }));
            }, state.depth);
        });
    }
    const hasHide = await page.$("#compare-hide-zero");
    if (hasHide) {
        const checked = await page.evaluate(() => document.getElementById("compare-hide-zero").checked);
        if (checked !== state.hideZero) await page.click("#compare-hide-zero");
    }
    /* 下钻：先做一次对比，再点行下钻（页内下钻语义） */
    const clickCompare = async () => {
        const waiter = page.waitForResponse(
            (r) => r.url().includes("/api/compare") && !r.url().includes("/status"), { timeout: 60000 }
        ).catch(() => null);
        await page.click("#btn-compare");
        const resp = await waiter;
        let body = null;
        try { body = resp ? await resp.json() : null; } catch (e) { body = null; }
        await page.waitForFunction(
            () => {
                const res = document.getElementById("compare-result");
                return res && !res.hasAttribute("hidden");
            }, { timeout: 60000 }).catch(() => {});
        await wait(600);
        return { status: resp ? resp.status() : null, body: body, postData: resp ? resp.request().postData() : null };
    };
    let resp = await clickCompare();
    if (state.drill) {
        const sel = 'tr[data-drill-path="' + state.drill.replace(/\\/g, "\\\\") + '"]';
        const row = await page.$(sel);
        sample.drillRowFound = !!row;
        if (row) {
            /* 下钻 = 行点击触发**新的一次** /api/compare（以该目录为新根），
               必须捕获这一发的请求/响应作为本态口径（否则量到的是下钻前的报告） */
            const waiter = page.waitForResponse(
                (r) => r.url().includes("/api/compare") && !r.url().includes("/status"), { timeout: 60000 }
            ).catch(() => null);
            await row.click();
            const dresp = await waiter;
            let dbody = null;
            try { dbody = dresp ? await dresp.json() : null; } catch (e) { dbody = null; }
            await page.waitForFunction(
                () => {
                    const res = document.getElementById("compare-result");
                    return res && !res.hasAttribute("hidden");
                }, { timeout: 60000 }).catch(() => {});
            await wait(600);
            if (dresp) {
                resp = {
                    status: dresp.status(), body: dbody,
                    postData: dresp.request().postData(),
                };
            }
        }
    }
    sample.requestPost = resp.postData;
    sample.responseStatus = resp.status;
    sample.report = resp.body && resp.body.report ? resp.body.report : null;
    const dom = await page.evaluate(measure);
    sample.dom = dom;
    const shot = "compare-" + state.key + "-" + sample.vw + "x" + sample.vh + ".png";
    await page.screenshot({ path: path.join(OUT, shot), fullPage: false });
    sample.shot = shot;
    RESULT.shots.push(shot);

    /* ---- 判定 ---- */
    const r = sample.report;
    const rows = (r && r.rows) || [];
    const post = resp.postData ? JSON.parse(resp.postData) : {};
    const wantedDepth = state.depth === "" ? null : Number(state.depth);
    judge(sample.judges, "J1 深度选择器存在", dom.depthControl, "depthControl=" + dom.depthControl);
    if (dom.depthControl) {
        judge(sample.judges, "J1 页面向后端传 depth=" + JSON.stringify(wantedDepth),
            String(post.depth === undefined ? null : post.depth) === String(wantedDepth),
            "postData.depth=" + JSON.stringify(post.depth));
        judge(sample.judges, "J1 后端回显 depth",
            r && "depth" in r && String(r.depth) === String(wantedDepth), "report.depth=" + JSON.stringify(r && r.depth));
    }
    judge(sample.judges, "J3 隐藏零变化开关存在且默认开", dom.hideZeroControl && dom.hideZeroChecked === true,
        "control=" + dom.hideZeroControl + " checked=" + dom.hideZeroChecked);
    judge(sample.judges, "J4 表格渲染行数==后端返回行数", dom.tableRows === rows.length,
        "dom=" + dom.tableRows + " api=" + rows.length);
    judge(sample.judges, "J3 开过滤时返回行零行==0", rows.filter((x) => x.delta === 0).length === 0,
        "zero=" + rows.filter((x) => x.delta === 0).length);
    if (r && "max_growth" in r) {
        const g = dom.summary[1] || {}, rel = dom.summary[2] || {}, tot = dom.summary[0] || {};
        judge(sample.judges, "J5 摘要三卡==后端 additive 字段",
            Number(g.target) === Number(r.max_growth) && Number(rel.target) === Number(r.max_release) &&
            Number(tot.target) === Number(r.delta_total),
            "卡=" + [tot.target, g.target, rel.target].join("/") + " 后端=" +
            [r.delta_total, r.max_growth, r.max_release].join("/"));
    } else {
        judge(sample.judges, "J5 additive 汇总字段存在", false, "report 缺 max_growth/max_release");
    }
    if (state.key === "flat-empty") {
        judge(sample.judges, "J6 flat 空态收敛（0 数据行 + 无差异文案）",
            dom.tableRows === 0 && /无差异/.test(dom.emptyText), "rows=" + dom.tableRows + " text=" + dom.emptyText.slice(0, 60));
    }
    if (state.key.indexOf("growth") === 0) {
        judge(sample.judges, "J6/J1 有增量时行数>0 且正负同榜",
            dom.tableRows > 0, "rows=" + dom.tableRows);
    }
    if (state.drill) {
        judge(sample.judges, "J7 行可下钻（data-drill-path）", dom.drillableRows > 0, "drillable=" + dom.drillableRows);
        judge(sample.judges, "J7 下钻后面包屑反映新根", dom.crumbText.indexOf(state.drill) !== -1,
            "crumb=" + dom.crumbText);
        judge(sample.judges, "J7 下钻后请求 root==下钻根", String(post.root) === state.drill, "root=" + JSON.stringify(post.root));
    }
    RESULT.samples.push(sample);
    return sample;
}

/* ================= 主流程 ================= */

(async () => {
    let browser = null;
    const fx = await ensureFixtures();
    RESULT.meta.fixtures = fx;
    let harness = null;
    try {
        harness = await startHarness();
        RESULT.meta.base = harness.base;
        RESULT.meta.harnessSpawned = harness.spawned;

        await apiPhase(harness.base);

        browser = await chromium.launch({ headless: true });
        for (const vp of VIEWPORTS) {
            const page = await browser.newPage({ viewport: { width: vp.w, height: vp.h } });
            page.on("console", (m) => {
                if (m.type() !== "error") return;
                const loc = (m.location && m.location() && m.location().url) || "";
                if (/favicon/i.test(m.text() + loc)) return; // 既存环境差异（P2/P3 已登记）
                RESULT.consoleErrors.push(vp.w + "x" + vp.h + " console: " + m.text() + " @ " + loc);
            });
            page.on("pageerror", (e) => RESULT.consoleErrors.push(vp.w + "x" + vp.h + " pageerror: " + e.message));
            await page.addInitScript(() => {
                try {
                    localStorage.setItem("pds_onboarding_dismissed_v1", "1");
                    localStorage.setItem("pds_theme_v1", "light");
                    sessionStorage.setItem("pds_auto_started_v1", "1");
                } catch (e) { /* ignore */ }
            });
            /* 直达 #/compare：不挂载工作台页，避免工作台的 /api/browse（真实 Everything
               查询）在夹具环境下 500 干扰 console 判据（P4 只验对比页）。 */
            await page.goto(harness.base + "#/compare", { waitUntil: "load", timeout: 25000 })
                .catch((e) => { RESULT.meta.gotoError = String(e); });
            await page.waitForSelector("#compare-baseline", { timeout: 20000 }).catch(() => {});
            await wait(500);
            for (const st of STATES) await runState(page, harness.base, st);
            await page.close();
        }
    } finally {
        if (browser) await browser.close();
        if (harnessProc) { try { harnessProc.kill(); } catch (e) { /* ignore */ } }
    }

    /* 汇总量化与判定 */
    const apiViolations = RESULT.api.reduce((a, r) => a + r.judges.filter((j) => !j.pass).length, 0);
    const uiViolations = RESULT.samples.reduce((a, s) => a + s.judges.filter((j) => !j.pass).length, 0);
    const total = apiViolations + uiViolations + RESULT.consoleErrors.length;
    const perState = RESULT.samples.map((s) => ({
        key: s.state + "@" + s.vw + "x" + s.vh,
        tableRows: s.dom.tableRows, apiRows: (s.report && s.report.rows || []).length,
        depth: s.report ? s.report.depth : null,
        zeroRows: ((s.report && s.report.rows) || []).filter((r) => r.delta === 0).length,
        deltaTotal: s.report ? s.report.delta_total : null,
        sumDelta: ((s.report && s.report.rows) || []).reduce((a, r) => a + r.delta, 0),
        crumb: s.dom.crumbText, empty: s.dom.emptyText.slice(0, 80),
        violations: s.judges.filter((j) => !j.pass).length,
    }));

    fs.writeFileSync(path.join(OUT, "api-" + LABEL + ".json"),
        JSON.stringify({ meta: RESULT.meta, cases: RESULT.api }, null, 2), "utf-8");
    fs.writeFileSync(path.join(OUT, "layout-" + LABEL + ".json"),
        JSON.stringify({ meta: RESULT.meta, samples: RESULT.samples.map((s) => ({
            state: s.state, vw: s.vw, vh: s.vh, shot: s.shot, requestPost: s.requestPost,
            responseStatus: s.responseStatus, dom: s.dom, report: s.report, judges: s.judges,
        })) }, null, 2), "utf-8");
    fs.writeFileSync(path.join(OUT, "summary-" + LABEL + ".json"),
        JSON.stringify({
            meta: RESULT.meta, shots: RESULT.shots, consoleErrors: RESULT.consoleErrors,
            totals: { apiViolations, uiViolations, consoleErrors: RESULT.consoleErrors.length, total },
            violations: RESULT.violations, perState,
        }, null, 2), "utf-8");

    console.log("== p04_compare_depth_probe (" + LABEL + ") ==");
    console.log("out=" + OUT + "  base=" + RESULT.meta.base);
    console.log("-- API 层 --");
    RESULT.api.forEach((r) => {
        const bad = r.judges.filter((j) => !j.pass).length;
        console.log("  " + r.key.padEnd(38) + " http=" + r.httpStatus + " rows=" + String(r.rowCount).padStart(3) +
            " zero=" + r.zeroRows + " Σ=" + String(r.sumDelta).padStart(5) + " 残差=" + String(r.residue).padStart(4) +
            " delta_total=" + String(r.deltaTotalRaw).padStart(5) + " depth回显=" + JSON.stringify(r.depthField) +
            (bad ? "  VIOLATION=" + bad : ""));
    });
    console.log("-- UI 层（3 视口 × 4 态） --");
    perState.forEach((s) => console.log("  " + s.key.padEnd(30) + " 表格行=" + s.tableRows + " api行=" + s.apiRows +
        " depth=" + JSON.stringify(s.depth) + " 零行=" + s.zeroRows +
        (s.violations ? "  VIOLATION=" + s.violations : "")));
    console.log("TOTAL apiViolations=" + apiViolations + " uiViolations=" + uiViolations +
        " consoleErrors=" + RESULT.consoleErrors.length + " total=" + total);
    RESULT.violations.slice(0, 24).forEach((v) => console.log("  [V] " + v));
    console.log(total ? "P04 VERDICT: FAIL" : "P04 VERDICT: PASS");
    process.exit(total ? 1 : 0);
})().catch((err) => {
    console.error("[p04] 运行失败：" + (err && err.stack ? err.stack : err));
    if (harnessProc) { try { harnessProc.kill(); } catch (e) { /* ignore */ } }
    process.exit(2);
});
