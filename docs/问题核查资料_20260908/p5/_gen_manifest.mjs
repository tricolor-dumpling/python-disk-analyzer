/* P5 证据清单生成器：扫描 docs/问题核查资料_20260908/p5/**，逐文件算 SHA-256，
   并汇总两份探针 summary JSON 的量化结果，输出 manifest.json。
   用法：node docs/问题核查资料_20260908/p5/_gen_manifest.mjs */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const DIR = path.resolve("docs/问题核查资料_20260908/p5");
const REL = "docs/问题核查资料_20260908/p5";

const readJson = (p) => {
    try { return JSON.parse(fs.readFileSync(p, "utf-8").replace(/^\uFEFF/, "")); }
    catch (e) { return null; }
};

function sha256(file) {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/* 图片像素尺寸（PNG IHDR：宽高各 4 字节大端，偏移 16/20） */
function pngSize(file) {
    const b = fs.readFileSync(file);
    if (b.length < 24 || b.toString("ascii", 1, 4) !== "PNG") return null;
    return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

const PURPOSE = {
    "baseline_prefix_final": "修复前（stage-p4 起点代码 @328ce70 的 web/ 源码）探针证据：术语裸奔、无选盘步骤、默认根硬编码 D:\\ —— 红线 A 的「修复前必红」对照面。3 视口 × 3 态截图 + 5 份量化 JSON。",
    "postfix": "修复后（本阶段 HEAD）探针证据：同一探针、同一夹具口径，0 违规。3 视口 × 3 态截图 + 5 份量化 JSON。",
    "_baseline_prefix_cs1": "变更集 1 当时的修复前基线（探针第一版：注入 Z:\\|Y:\\、术语判据未加旧称检查）。保留作为方法学演进留痕，**不作为红线 A 的对照数据**（对照以 baseline_prefix_final 为准）。",
};

const entries = [];
const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
            if (e.name === "__pycache__") continue;
            walk(p);
        } else {
            const rel = path.relative(DIR, p).replace(/\\/g, "/");
            const st = fs.statSync(p);
            const rec = {
                path: path.resolve(p),
                rel: REL + "/" + rel,
                bytes: st.size,
                mtime: st.mtime.toISOString(),
                sha256: sha256(p),
            };
            if (/\.png$/i.test(e.name)) {
                const sz = pngSize(p);
                if (sz) { rec.width = sz.w; rec.height = sz.h; }
                rec.role = "screenshot";
            } else if (/\.log$/i.test(e.name)) {
                rec.role = "harness-log";
            } else {
                rec.role = "quantitative-json";
            }
            entries.push(rec);
        }
    }
};
walk(DIR);

/* 去重统计（按 sha256）：P5 的 9+2 张图若像素完全相同则会被识别出来 */
const byHash = new Map();
entries.filter((e) => e.role === "screenshot").forEach((e) => {
    const k = e.sha256;
    if (!byHash.has(k)) byHash.set(k, []);
    byHash.get(k).push(e.rel);
});

/* 量化摘要（直接从探针 summary JSON 取真实数字，不手抄） */
function summaryOf(label, dirPrefix) {
    const p = path.join(DIR, dirPrefix, "summary-" + label + ".json");
    const j = readJson(p);
    if (!j) return null;
    return {
        file: REL + "/" + dirPrefix + "/summary-" + label + ".json",
        totals: j.totals,
        perState: (j.perState || []).map((s) => ({
            vkey: s.vkey, state: s.state,
            termHits: s.hits, nakedViolations: s.bad,
        })),
        violationCount: (j.violations || []).length,
    };
}

const onb = (label, dirPrefix) => {
    const j = readJson(path.join(DIR, dirPrefix, "onboarding-" + label + ".json"));
    if (!j) return null;
    return (j.samples || []).map((s) => ({
        vkey: s.vkey,
        stepCount: s.measure.stepCount,
        hasPicker: s.measure.hasPicker,
        pickerRoots: (s.measure.rootOptions || []).map((o) => o.root),
        skipButtons: (s.measure.skipButtons || []).map((b) => b.text),
        open: s.measure.visible,
    }));
};

const roots = (label, dirPrefix) => {
    const j = readJson(path.join(DIR, dirPrefix, "roots-" + label + ".json"));
    if (!j) return null;
    return {
        magicScan: j.magicScan,
        defaultRoot: (j.samples || []).filter((s) => s.measure).map((s) => ({
            vkey: s.vkey,
            browseRootValue: s.measure.browseRootValue,
            datalistOptions: s.measure.datalistOptions,
            rootsApiCalls: s.rootsApiCalls,
        })),
        apiRoots: (j.samples || []).filter((s) => s.returned).map((s) => ({ returned: s.returned })),
    };
};

const layout = (label, dirPrefix) => {
    const j = readJson(path.join(DIR, dirPrefix, "layout-" + label + ".json"));
    if (!j) return null;
    return (j.samples || []).map((s) => ({
        vkey: s.vkey, state: s.state,
        pageTitle: s.layout.pageTitle,
        pageSub: s.layout.pageSub,
        hasTargetInput: s.layout.hasTargetInput,
        hasCurrentRow: s.layout.hasCurrentRow,
        currentRowText: s.layout.currentRowText,
        bodyScrollHeight: s.layout.bodyScrollHeight,
        innerHeight: s.layout.innerHeight,
        controlCount: (s.layout.controls || []).length,
    }));
};

const manifest = {
    phase: "P5（对比语义说人话与首次启动选盘 · 问题 7）",
    generatedAt: new Date().toISOString(),
    branch: "stage-p5",
    startPoint: "stage-p4 @ 1c23270（tag p4-compare-depth）+ P4 挂账清理提交（tag p4-backlog-cleared）",
    evidenceRoot: DIR,
    probe: REL + "/../../scripts/dev/p05_semantics_roots_probe.mjs",
    fixtureHarness: REL + "/_fixture_roots_server.py",
    redlineB: REL + "/_verify_datadir_redline.mjs",
    redlineBOutput: REL + "/redline_b_datadir.txt",
    sampling: {
        viewports: ["1366x768", "1440x900", "1920x1080"],
        states: ["onboarding（首开引导含选盘步骤）", "compare-empty（对比页空态）", "compare-result（对比页有结果）", "workspace（工作台默认根）"],
        shotsPerRun: 9,
        note: "每态整页截图（fullPage:false，视口内）；同一 viewport×state 组合在所有视口下重复采样",
    },
    timeWindow: {
        fixtureNow: "2026-09-08T20:00:00",
        fixtureSnapshots: ["D_20260907_170000（对比基准）", "D_20260908_170000（当前侧数据集）"],
        probeRuns: entries
            .filter((e) => e.rol === "quantitative-json")
            .map((e) => ({ rel: e.rel, mtime: e.mtime })),
    },
    purpose: PURPOSE,
    quantitative: {
        prefix: {
            summary: summaryOf("prefix", "baseline_prefix_final"),
            onboarding: onb("prefix", "baseline_prefix_final"),
            roots: roots("prefix", "baseline_prefix_final"),
            layout: layout("prefix", "baseline_prefix_final"),
        },
        postfix: {
            summary: summaryOf("postfix", "postfix"),
            onboarding: onb("postfix", "postfix"),
            roots: roots("postfix", "postfix"),
            layout: layout("postfix", "postfix"),
        },
    },
    files: entries.sort((a, b) => (a.rel < b.rel ? -1 : 1)),
    counts: {
        total: entries.length,
        screenshots: entries.filter((e) => e.role === "screenshot").length,
        distinctScreenshotPixels: byHash.size,
        quantitativeJson: entries.filter((e) => e.role === "quantitative-json").length,
        logs: entries.filter((e) => e.role === "harness-log").length,
    },
    duplicatesByPixel: [...byHash.entries()].filter(([, v]) => v.length > 1)
        .map(([h, v]) => ({ sha256: h, files: v })),
};

fs.writeFileSync(path.join(DIR, "manifest.json"), JSON.stringify(manifest, null, 2), "utf-8");
console.log("manifest 项数=" + manifest.counts.total +
    " 截图=" + manifest.counts.screenshots +
    " 像素去重后=" + manifest.counts.distinctScreenshotPixels +
    " 量化JSON=" + manifest.counts.quantitativeJson +
    " 日志=" + manifest.counts.logs);
console.log("prefix total 违规=" + (manifest.quantitative.prefix.summary || {}).totals.total +
    "  postfix total 违规=" + (manifest.quantitative.postfix.summary || {}).totals.total);
console.log("重复像素组=" + manifest.duplicatesByPixel.length);
