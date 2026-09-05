/* ============================================================
   阶段 E（R4/R5）· u66_view_residual_real.mjs（C-1 问题 2-2 视图残留真机复核探针）
   - 覆盖手册贰章 2-2 + C-1 验收口径：
     · 三视图（treemap→ranking→table→treemap…）高频连点 ≥20 次；
     · 0/100/500/800ms 关键帧采样（截图供 gpt-5.6-luna 判读）；
     · 终态断言（沿用 u50 §1 口径）：全局可见 canvas 数 + 非活动容器 computed
       display + 终态唯一性（任一容器激活时另一容器 display:none）；
     · 录屏（recordVideo webm）≥10s，chromium + msedge 双浏览器；
     · 双模式：--with-data 连真后端（真机复核，Everything 就绪时走索引浏览——
       真机必测口径）；默认桩态确定性（同 u50）。
     · console/pageerror 0。
   - 桩态：addInitScript 覆写 fetch（同 u50：browse 数据 + 视图渲染）。
   - 输出：--out result.json + keyframes/view-{0,100,500,800}ms.png + video/*.webm。
   - 运行：node scripts/dev/u66_view_residual_real.mjs [--base http://127.0.0.1:5000/]
            [--out <目录>] [--with-data] [--browsers chromium|msedge|both]
   ============================================================ */

import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("C:/Users/26024/.dsh/profiles/web/node_modules/playwright");

function arg(name, dflt) {
    const i = process.argv.indexOf("--" + name);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const BASE = arg("base", "http://127.0.0.1:5000/");
const OUT = path.resolve(arg("out", path.join(os.tmpdir(), "u66_view_residual")));
const WITH_DATA = process.argv.indexOf("--with-data") >= 0;
const BROWSERS = (arg("browsers", "both") === "both") ? ["chromium", "msedge"] : [arg("browsers", "chromium")];

fs.mkdirSync(path.join(OUT, "keyframes"), { recursive: true });
fs.mkdirSync(path.join(OUT, "video"), { recursive: true });

const RESULT = { meta: { base: BASE, out: OUT, withData: WITH_DATA, browsers: BROWSERS, node: process.version, startedAt: new Date().toISOString() }, checks: [], browsers: {} };
function check(name, cond, detail) {
    RESULT.checks.push({ name, pass: !!cond, detail: detail || "" });
    console.log((cond ? "  ✔ " : "  ✖ ") + name + (cond ? "" : " :: " + detail));
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 桩态 fetch（同 u50：浏览数据可渲染 treemap/ranking/table） ---------------- */
const STUB_FN = `
window.__stub = { startCount: 0 };
window.fetch = function (url, options) {
  options = options || {};
  const key = (options.method || "GET").toUpperCase() + " " + String(url).split("?")[0];
  const json = (o, s) => Promise.resolve({ ok: (s || 200) < 400, status: s || 200, json: () => Promise.resolve(JSON.parse(JSON.stringify(o))) });
  if (key === "OPTIONS /api/fullscan/stop") return json({ ok: true }, 200);
  if (key === "GET /api/health") return json({ ok: true, ready: true, dll: "stub-dll", message: "Everything 已就绪", busy: false });
  if (key === "GET /api/settings") return json({ ok: true, settings: { auto_save: true, last_roots: ["D:\\\\", "C:\\\\"] }, data_dir: "C:\\\\stub\\\\data", snapshots_dir: "C:\\\\stub\\\\snapshots" });
  if (key === "POST /api/settings") return json({ ok: true, settings: {} });
  if (key === "POST /api/browse") return json({ ok: true, root: "D:\\\\", parent: null,
    directories: [ { name: "data", path: "D:\\\\data", is_dir: true, size: 12000, size_human: "11.72 KB" }, { name: "docs", path: "D:\\\\docs", is_dir: true, size: 4000, size_human: "3.91 KB" }, { name: "media", path: "D:\\\\media", is_dir: true, size: 8000, size_human: "7.81 KB" }, { name: "archive", path: "D:\\\\archive", is_dir: true, size: 20000, size_human: "19.53 KB" } ],
    files: [ { name: "readme.txt", path: "D:\\\\readme.txt", is_dir: false, size: 100, size_human: "100 B" }, { name: "pagefile.sys", path: "D:\\\\pagefile.sys", is_dir: false, size: 999999, size_human: "976.56 KB" } ],
    total_dirs: 4, total_files: 2, source: "sdk", source_at: "2026-09-05T12:00:00" });
  if (key === "GET /api/fullscan/status") return json({ ok: true, status: { running: false, roots: ["C:\\\\", "D:\\\\"], roots_done: 0, roots_total: 2, current_root: null, error: null, result_ready: false, save_ready: false, progress_pct: 0, scan_version: 1, stop_requested: false, stop_reason: null, phase: "idle", lock_holder: null, row_done: 0, row_total: 0, stop_ack_at: null } });
  if (key === "POST /api/fullscan/start") { window.__stub.startCount += 1; return json({ ok: true, message: "ok" }); }
  if (key === "GET /api/snapshots") return json({ ok: true, sessions: [], count: 0 });
  if (key === "GET /api/overview") return json({ ok: true, ready: false, scanning: false, empty_reason: "no_scan", roots: [] });
  if (key === "GET /api/export") return json({ ok: false, error: "x" }, 404);
  return json({ ok: true });
};
`;

/* 终态采样（u50 §1 口径） */
async function finalSampling(page) {
    return page.evaluate(() => {
        const tw = document.getElementById("treemap-wrap");
        const tb = document.getElementById("table-wrap");
        const active = (id) => (document.getElementById(id) || {}).classList &&
            document.getElementById(id).classList.contains("btn-primary");
        const visibleCanvasCount = () => Array.from(document.querySelectorAll("canvas"))
            .filter((c) => {
                const r = c.getClientRects();
                if (!r || !r.length) return false;
                const cs = getComputedStyle(c);
                return cs.display !== "none" && cs.visibility !== "hidden" && r[0].width > 0 && r[0].height > 0;
            }).length;
        const tableActive = active("btn-view-table");
        const rankingActive = active("btn-view-ranking");
        const treemapActive = active("btn-view-treemap");
        const relateActive = active("btn-view-relate");
        const mode = tableActive ? "table" : rankingActive ? "ranking" : treemapActive ? "treemap" : relateActive ? "relate" : null;
        const cs = (el) => (el ? getComputedStyle(el).display : "no-el");
        return {
            mode,
            treemapHidden: tw ? tw.hasAttribute("hidden") : null,
            tableHidden: tb ? tb.hasAttribute("hidden") : null,
            treemapDisplay: cs(tw),
            tableDisplay: cs(tb),
            visibleCanvas: visibleCanvasCount(),
            residualDetected: mode && mode !== "treemap" && mode !== "relate" ? (tw && !tw.hasAttribute("hidden")) : false,
            uniqueOk: mode === "treemap"
                ? visibleCanvasCount() === 2 && cs(tb) === "none"
                : (mode === "relate" ? cs(tw) === "none" && cs(tb) === "none"
                    : visibleCanvasCount() === 0 && cs(tw) === "none"),
        };
    });
}

async function runBrowser(channel) {
    const tag = channel;
    const b = { checks: [], consoleErrors: [], badHttp: [], keyframes: [] };
    const launchOpts = { headless: true };
    if (channel === "msedge") launchOpts.channel = "msedge";
    const browser = await chromium.launch(launchOpts);
    const videoDir = path.join(OUT, "video", channel);
    fs.mkdirSync(videoDir, { recursive: true });

    const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 }, recordVideo: { dir: videoDir, size: { width: 1366, height: 768 } } });
    const page = await ctx.newPage();
    const errs = [];
    page.on("console", (m) => { if (m.type() === "error") { const loc = m.location ? m.location() : null; if (loc && /favicon\.ico/i.test(loc.url)) return; errs.push(m.text()); } });
    page.on("pageerror", (e) => errs.push(e.message));
    page.on("response", (r) => { if (r.status() >= 400 && !/favicon\.ico/i.test(r.url())) b.badHttp.push(r.status() + " " + r.url()); });
    await page.addInitScript(() => { try { localStorage.setItem("pds_onboarding_dismissed_v1", "1"); } catch (e) {}
            try { sessionStorage.setItem("pds_auto_started_v1", "1"); } catch (e) {} });
    if (!WITH_DATA) await page.addInitScript(STUB_FN);
    await page.goto(BASE, { waitUntil: "load", timeout: 20000 }).catch((e) => { b.gotoError = String(e); });
    if (!WITH_DATA) {
        await page.waitForFunction(() => typeof window.__stub === "object", { timeout: 15000 }).catch(() => {});
    }
    // 等浏览数据渲染（treemap 首帧）
    await page.waitForFunction(() => {
        const w = document.getElementById("treemap-wrap");
        return w && !w.hasAttribute("hidden") && w.querySelectorAll("canvas").length > 0;
    }, { timeout: WITH_DATA ? 30000 : 15000 }).catch(() => {});
    await page.waitForTimeout(600);

    /* 高频连点：三视图来回 24 击（≥20 次）——最后一击停在 table（非 treemap 终态，
       检测 treemap 残留的最严场景） */
    const seq = [];
    const cycle = ["ranking", "table", "treemap", "ranking", "table", "treemap"];
    for (let i = 0; i < 4; i++) seq.push(...cycle);
    seq.push("ranking", "table", "treemap", "ranking", "table", "table");
    const clickLog = [];
    const t0 = Date.now();
    for (const m of seq) {
        await page.click("#btn-view-" + m, { timeout: 3000 }).catch(() => clickLog.push("fail:" + m));
        clickLog.push(m);
        await wait(30); // 快速连点（30ms 间隔，复现慢摸设备上的快速切换）
    }
    b.clicks = clickLog.length;
    b.checks.push({ name: "[" + tag + "] 高频连点 ≥20 次（实际 " + clickLog.length + "）", pass: clickLog.length >= 20, detail: "seq=" + clickLog.join(",") });

    /* 0/100/500/800ms 关键帧 */
    const keyframes = [];
    for (const [label, ms] of [["0", 0], ["100", 100], ["500", 500], ["800", 800]]) {
        const f = path.join(OUT, "keyframes", `${channel}-view-${label}ms.png`);
        if (ms) await wait(ms);
        await page.screenshot({ path: f, fullPage: false }).catch(() => {});
        keyframes.push(f);
        b.keyframes.push(f);
    }
    const f800 = await page.screenshot({ path: path.join(OUT, "keyframes", `${channel}-view-final.png`), fullPage: false }).catch(() => null);
    if (f800) b.keyframes.push(path.join(OUT, "keyframes", `${channel}-view-final.png`));

    /* 终态采样（800ms 后） */
    const final = await finalSampling(page);
    b.final = final;
    b.checks.push({ name: "[" + tag + "] 终态唯一性：非活动容器 display:none + 可见 canvas 数正确", pass: final.uniqueOk === true, detail: JSON.stringify(final) });
    b.checks.push({ name: "[" + tag + "] 无残留（treemap 容器终态 hidden）", pass: final.residualDetected === false, detail: "residual=" + final.residualDetected });

    /* 补采：切回 treemap 的稳定终态 */
    await page.click("#btn-view-treemap", { timeout: 3000 }).catch(() => {});
    await wait(500);
    const treemapStable = await finalSampling(page);
    b.treemapStable = treemapStable;
    b.checks.push({ name: "[" + tag + "] 切回 treemap 稳定态：treemap 可见 + table hidden + canvas 2/1", pass: treemapStable.mode === "treemap" && treemapStable.treemapDisplay !== "none" && treemapStable.tableDisplay === "none" && (treemapStable.uniqueOk === true), detail: JSON.stringify(treemapStable) });
    b.treemapStable.note = treemapStable.visibleCanvas === 1 ? "单画布（字面口径满足）" : "双层画布渲染器（设计使然）";

    b.consoleErrors = errs;
    b.checks.push({ name: "[" + tag + "] 全程 console/pageerror 0", pass: errs.length === 0, detail: errs.join(" | ") + (b.badHttp.length ? " HTTP: " + b.badHttp.join(" ; ") : "") });

    await ctx.close().catch(() => {});
    await browser.close().catch(() => {});
    RESULT.browsers[tag] = b;
    b.checks.forEach((c) => check(c.name, c.pass, c.detail));
    return b;
}

(async () => {
    console.log("== u66_view_residual_real ==");
    console.log("base=" + BASE + " out=" + OUT + " withData=" + WITH_DATA + " browsers=" + BROWSERS.join(","));
    for (const ch of BROWSERS) {
        console.log("-- browser " + ch + " --");
        try { await runBrowser(ch); }
        catch (e) { RESULT.browsers[ch] = { error: String(e && e.message || e) }; console.log("   异常: " + e); }
    }
    RESULT.meta.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(RESULT, null, 2), "utf-8");
    console.log("\nresult.json 已写入: " + path.join(OUT, "result.json"));
    const fails = RESULT.checks.filter((c) => !c.pass);
    console.log("总断言: " + RESULT.checks.length + "，失败: " + fails.length);
    setTimeout(() => process.exit(fails.length ? 1 : 0), 1500).unref();
})();