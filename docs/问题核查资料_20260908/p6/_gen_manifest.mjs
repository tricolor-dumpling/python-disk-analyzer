/* ============================================================
   P6（问题 8/9）证据 manifest 生成器（证据侧脚本，非生产代码）
   - 逐项列出 docs/问题核查资料_20260908/p6/** 的**绝对路径 / 相对路径 /
     用途角色 / 采样节奏 / 时间窗 / 量化摘要 / SHA-256 / 字节数 / mtime**；
   - 量化摘要直接从探针产出的 JSON 里**读实测值**（不写死）；
   - 用法：node docs/问题核查资料_20260908/p6/_gen_manifest.mjs
   ============================================================ */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* ⚠️ 目录名含中文：必须走 fileURLToPath（直接取 URL.pathname 会拿到百分号编码路径） */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE);
const REPO = path.resolve(HERE, "..", "..", "..");

function sha256(file) {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function loadJson(file) {
    try { return JSON.parse(fs.readFileSync(file, "utf-8")); } catch (e) { return null; }
}

function pngSize(file) {
    try {
        const buf = fs.readFileSync(file);
        if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
        return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    } catch (e) { return null; }
}

function roleOf(rel) {
    if (/\.png$/i.test(rel)) return "screenshot";
    if (/\.json$/i.test(rel)) return "quantitative-json";
    if (/\.log$/i.test(rel)) return "probe-log";
    if (/\.py$/i.test(rel)) return "harness-script";
    if (/\.mjs$/i.test(rel)) return "generator-script";
    return "other";
}

function walk(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, out);
        else out.push(p);
    }
    return out;
}

const files = walk(ROOT)
    .filter((p) => path.basename(p) !== "manifest.json")
    .filter((p) => !p.includes("__pycache__"))
    .sort();

const items = files.map((p) => {
    const rel = path.relative(REPO, p).replace(/\\/g, "/");
    const st = fs.statSync(p);
    const it = {
        path: p.replace(/\\/g, "/"),
        rel: rel,
        bytes: st.size,
        mtime: st.mtime.toISOString(),
        sha256: sha256(p),
        role: roleOf(rel),
    };
    const dim = pngSize(p);
    if (dim) { it.width = dim.width; it.height = dim.height; }
    return it;
});

const post = {
    summary: loadJson(path.join(ROOT, "postfix", "summary-postfix.json")),
    layout: loadJson(path.join(ROOT, "postfix", "layout-postfix.json")),
    pages: loadJson(path.join(ROOT, "postfix", "pages-postfix.json")),
    trend: loadJson(path.join(ROOT, "postfix", "trend-postfix.json")),
};
const pre = {
    summary: loadJson(path.join(ROOT, "baseline_prefix", "summary-prefix.json")),
    layout: loadJson(path.join(ROOT, "baseline_prefix", "layout-prefix.json")),
    pages: loadJson(path.join(ROOT, "baseline_prefix", "pages-prefix.json")),
    trend: loadJson(path.join(ROOT, "baseline_prefix", "trend-prefix.json")),
};
const perf = loadJson(path.join(ROOT, "perf", "series_perf.json"));

function trendOf(pagesJson) {
    if (!pagesJson) return null;
    const out = {};
    for (const s of pagesJson.samples || []) {
        out[s.scenario + "@" + s.viewport] = s.measure ? {
            state: s.measure.trend.state,
            dots: s.measure.trend.dots,
            pathLen: s.measure.trend.pathLen,
            axisY: s.measure.trend.axisY,
            axisX: s.measure.trend.axisX,
            readout: s.measure.trend.readout,
            empty: s.measure.trend.emptyText,
            baselineMultiple: s.measure.baseline ? s.measure.baseline.multiple : null,
        } : { error: s.error };
    }
    return out;
}

function layoutOf(layoutJson) {
    if (!layoutJson) return null;
    const out = {};
    for (const r of layoutJson.rows || []) {
        out[r.scenario + "@" + r.viewport] = r;
    }
    return out;
}

const manifest = {
    phase: "P6（对比页/快照页重设计与多快照趋势 · 问题 8/9）",
    generatedAt: new Date().toISOString(),
    branch: "stage-p6p8",
    startPoint: "stage-p5 @ 300b527（tag p5-compare-semantics + 本批提示词入库）",
    evidenceRoot: ROOT.replace(/\\/g, "/"),
    probe: "scripts/dev/p06_pages_visual_probe.mjs（同判据 probe；红线 A 对照面 = baseline_prefix）",
    fixtureHarness: "docs/问题核查资料_20260908/p5/_fixture_roots_server.py（复用 P5 夹具口径：只替换 fullscan 数据源，其余全走生产代码）",
    fixtureFamily: {
        generator: "scripts/dev/fixture_snapshots.mjs",
        sel: "series,tree,growth",
        nowIso: "2026-09-08T20:00:00",
        isolateHome: "%TEMP%/pds_p6_iso（红线 B：绝不触碰用户真实数据目录）",
        emptyInstance: "%TEMP%/pds_p6_empty_iso（「无快照」场景的独立实例）",
    },
    sampling: {
        viewports: ["1366x768", "1440x900", "1920x1080"],
        scenarios: [
            "compare-result（1 份对比基准：摘要/发散图/表格 + 趋势卡空闲态）",
            "trend-line（3 份对比基准：多快照折线 + 悬浮读数）",
            "compare-empty（无快照实例：定稿 6.5 空态）",
            "snapshots-empty（无快照实例：快照页空态）",
            "snapshots（10 会话：趋势卡 sparkline + 会话列表卡片）",
        ],
        shotsPerRun: 15,
        settle: "等网络/渲染收敛（趋势卡 sparkline 描线 800ms）后 700ms 采样；fullPage:false（视口内）",
    },
    timeWindow: {
        fixtureNow: "2026-09-08T20:00:00",
        fixtureSnapshots: "series 6 份（09-07 23:00 → 09-08 19:00）+ tree 2 份 + growth 2 份 = 10 份",
        probeRuns: [
            { label: "prefix", code: "web/ @ 300b527（P5 起点，git worktree %TEMP%/p6_prefix）" },
            { label: "postfix", code: "web/ @ HEAD（P6 变更集 1-5）" },
        ],
    },
    purpose: {
        baseline_prefix: "红线 A 对照面：**同一探针、同一夹具口径、同一判据**跑修复前代码 —— 原始文件名外露 / 卡片语言不统一 / 内联 magic px / 无多快照折线（8 项违规）。",
        postfix: "修复后（HEAD）：0 违规 + 量化布局（页头/趋势卡/分区图/表格实测高度）+ 折线读数。",
        perf: "D6-6 性能实测：5 份 × 13 万行（65 万行）级 /api/series 冷启动与缓存命中耗时、与 /api/snapshots 共享缓存的对照。",
        _series_perf: "性能实测脚本（证据侧，非生产代码）：生成夹具快照并进程内计时。",
    },
    quantitative: {
        prefix: {
            verdict: pre.summary ? pre.summary.verdict : null,
            violations: pre.summary ? pre.summary.violations.map((v) => v.kind) : null,
            checks: pre.summary ? pre.summary.checks.map((c) => ({ name: c.name, ok: c.ok })) : null,
            trend: trendOf(pre.pages),
            layout: layoutOf(pre.layout),
        },
        postfix: {
            verdict: post.summary ? post.summary.verdict : null,
            violations: post.summary ? post.summary.violations.length : null,
            checks: post.summary ? post.summary.checks.map((c) => ({ name: c.name, ok: c.ok })) : null,
            trend: trendOf(post.pages),
            layout: layoutOf(post.layout),
        },
        perf: perf ? {
            snapshots: perf.meta.snapshots,
            rowsPerSnapshot: perf.meta.rows_per_snapshot,
            rowsTotalIfAllParsed: perf.meta.rows_total_if_all_parsed,
            seriesColdFirstMs: perf.cases.series_cold.ms_first,
            seriesColdMedianMs: perf.cases.series_cold.ms_median,
            seriesWarmMedianMs: perf.cases.series_warm.ms_median,
            pathColdFirstMs: perf.cases.series_path_cold_then_warm.ms_first,
            depth2ColdFirstMs: perf.cases.series_depth2.ms_first,
            snapshotsColdMs: perf.cases.snapshots_cold_total_cache.ms_first,
            snapshotsWarmMs: perf.cases.snapshots_warm_total_cache.ms_median,
            sharedRootCacheFlags: perf.cases.series_after_series_cache_clear_shared_root.cached_flags,
            note: "耗时 = Flask test_client 进程内往返（无网络/无浏览器），单位 ms",
        } : null,
    },
    counts: {
        total: items.length + 1,
        screenshots: items.filter((i) => i.role === "screenshot").length,
        screenshotsByLabel: {
            postfix: items.filter((i) => i.role === "screenshot" && i.rel.includes("/postfix/")).length,
            baseline_prefix: items.filter((i) => i.role === "screenshot" && i.rel.includes("/baseline_prefix/")).length,
        },
        quantitativeJson: items.filter((i) => i.role === "quantitative-json").length,
        scripts: items.filter((i) => i.role.endsWith("script")).length,
        logs: items.filter((i) => i.role === "probe-log").length,
    },
    files: items,
};

const out = path.join(ROOT, "manifest.json");
fs.writeFileSync(out, JSON.stringify(manifest, null, 2), "utf-8");
console.log("MANIFEST=" + out.replace(/\\/g, "/"));
console.log(JSON.stringify(manifest.counts, null, 1));
console.log("prefix verdict=" + (manifest.quantitative.prefix.verdict) +
    " violations=" + (manifest.quantitative.prefix.violations || []).length);
console.log("postfix verdict=" + (manifest.quantitative.postfix.verdict) +
    " violations=" + manifest.quantitative.postfix.violations);
