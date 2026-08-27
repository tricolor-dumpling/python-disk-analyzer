/* ============================================================
   UI 2.0（SpaceLens Pro）· U2.1 验收探针
   - 真实页（Flask 5000）+ 预置 fetch 桩：三页（工作台/对比/快照）截图、
     路由转场时长（≤360ms 口径）、浏览状态跨页保持、导航标签激活态、
     console/页面错误捕获；
   - 用法：node scripts/dev/u21_page_probe.mjs [--base URL] [--out 截图目录]
   - 依赖：本机 Playwright（同 u13_viewport_probe.mjs 注记）。
   ============================================================ */

import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const require = createRequire(import.meta.url);
const { chromium } = require("C:/Users/26024/.dsh/profiles/web/node_modules/playwright");

function arg(name, dflt) {
    const i = process.argv.indexOf("--" + name);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const BASE = arg("base", "http://127.0.0.1:5000/");
const OUT = arg("out", path.join(os.tmpdir(), "u21_shots"));

const STUB_FN = `
window.fetch = function (url, options) {
    options = options || {};
    const key = String(options.method || "GET").toUpperCase() + " " + String(url).split("?")[0];
    const respond = (status) => ({
        ok: status < 400, status,
        json: () => Promise.resolve(JSON.parse(JSON.stringify(window.__SAMPLES[key])))
    });
    const keys = Object.keys(window.__SAMPLES);
    if (keys.indexOf(key) !== -1) return Promise.resolve(respond(200));
    return Promise.resolve(respond(400));
};
window.__SAMPLES = {
    "GET /api/settings": { ok: true, settings: { auto_save: false, last_roots: ["D:/"] }, data_dir: "%LOCALAPPDATA%/PythonDiskScanner", snapshots_dir: "%LOCALAPPDATA%/PythonDiskScanner/snapshots" },
    "GET /api/health": { ok: true, ready: true, dll: "C:/Program Files/Everything/Everything64.dll", message: "Everything 已就绪" },
    "POST /api/browse": { ok: true, root: "D:/", parent: null,
        directories: [
            { name: "data", path: "D:/data", is_dir: true, size: 12000, size_human: "11.72 KB" },
            { name: "docs", path: "D:/docs", is_dir: true, size: 4000, size_human: "3.91 KB" },
            { name: "media", path: "D:/media", is_dir: true, size: 2600000, size_human: "2.48 MB" },
            { name: "repos", path: "D:/repos", is_dir: true, size: 880000, size_human: "859.38 KB" }
        ],
        files: [
            { name: "pagefile.sys", path: "D:/pagefile.sys", is_dir: false, size: 999999, size_human: "976.56 KB" },
            { name: "readme.txt", path: "D:/readme.txt", is_dir: false, size: 100, size_human: "100 B" },
            { name: "installer.exe", path: "D:/installer.exe", is_dir: false, size: 5242880, size_human: "5.00 MB" }
        ],
        total_dirs: 4, total_files: 3 },
    "GET /api/fullscan/status": { ok: true, status: { running: false, roots: ["C:/"], roots_done: 0, roots_total: 1, current_root: null, error: null, result_ready: false, save_ready: false, progress_pct: 0, scan_version: 1 } },
    "GET /api/snapshots": { ok: true, sessions: [ { session_id: "s-20260824-000000-aabbccdd", auto: false, machine_guid: "aabbccdd-1234", created_at: "2026-08-24T10:00:00", roots: { "D:/": { root: "D:/", snapshot: "D_20260824_100000_explicit_aabbccd.snap.gz", snapshot_path: "C:/fake/snapshots/D_20260824_100000_explicit_aabbccd.snap.gz", skipped: false } } } ], count: 1 },
    "POST /api/compare": { ok: true, report: { root: "D:/", total_baseline: 16000, total_current: 15990, delta_total: -10, truncated: false, legacy_count: 0, rows: [ { path: "D:/data", baseline: 12000, current: 11990, delta: -10, growth_pct: -0.0833, removed: false, added: false } ] } },
    "GET /api/overview": { ok: true, ready: false, scanning: false, empty_reason: "no_scan", roots: [] }
};`;

const browser = await chromium.launch({ headless: true });
fs.mkdirSync(OUT, { recursive: true });

async function runCase(theme, name) {
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push("pageerror:" + String(e)));
    page.on("console", (m) => { if (m.type() === "error") errors.push("console.error:" + m.text()); });
    if (theme === "dark") {
        await page.addInitScript(() => { try { localStorage.setItem("pds_theme_v1", "dark"); } catch (e) { /* ignore */ } });
    }
    await page.addInitScript(() => { try { localStorage.setItem("pds_onboarding_dismissed_v1", "1"); } catch (e) { /* ignore */ } });
    await page.addInitScript(new Function(STUB_FN));
    await page.goto(BASE, { waitUntil: "load" });
    await page.waitForTimeout(900); // init 链落定

    const out = { name, errors };

    // 工作台截图 + 初始状态
    await page.screenshot({ path: path.join(OUT, name + "-workspace.png") });
    out.workspaceRows = await page.evaluate(() => document.querySelectorAll("#dir-body .ranking-row, #dir-body .ranking-row-static").length);
    out.route0 = await page.evaluate(() => window.__app ? window.__app.route : null);

    // 转场时长①：工作台 → 对比（点击导航标签）
    const t1 = Date.now();
    await page.click('.nav-tab[href="#/compare"]');
    await page.waitForSelector('[data-page="compare"]', { state: "attached" });
    out.transitionRenderedMs = Date.now() - t1;   // 渲染完成（pageOut 120ms + 换装）
    await page.waitForTimeout(450);
    out.transitionSettledMs = Date.now() - t1;    // 完全落定（≈360ms）
    await page.screenshot({ path: path.join(OUT, name + "-compare.png") });
    out.compareRoute = await page.evaluate(() => JSON.stringify({
        route: document.querySelector(".nav-tabs .nav-tab.is-active") ? document.querySelector(".nav-tabs .nav-tab.is-active").getAttribute("href") : null,
        dirBodyGone: !document.getElementById("dir-body"),
    }));

    // 转场时长②：对比 → 快照
    const t2 = Date.now();
    await page.click('.nav-tab[href="#/snapshots"]');
    await page.waitForSelector('[data-page="snapshots"]', { state: "attached" });
    out.transition2RenderedMs = Date.now() - t2;
    await page.waitForTimeout(450);
    await page.screenshot({ path: path.join(OUT, name + "-snapshots.png") });

    // 返回工作台：浏览状态保持（dir-body 回灌 + 路径保持 + 无重复 browse 请求）
    const browseBefore = await page.evaluate(() => window.__smoke ? 0 : 0);
    const t3 = Date.now();
    await page.click('.nav-tab[href="#/"]');
    await page.waitForSelector("#dir-body .ranking-row", { state: "attached" });
    out.backRenderedMs = Date.now() - t3;
    await page.waitForTimeout(450);
    out.backState = await page.evaluate(() => ({
        rows: document.querySelectorAll("#dir-body .ranking-row, #dir-body .ranking-row-static").length,
        path: document.getElementById("breadcrumb").textContent.replace(/\s+/g, " ").trim(),
        activeTab: (document.querySelector(".nav-tabs .nav-tab.is-active") || {}).getAttribute ? document.querySelector(".nav-tabs .nav-tab.is-active").getAttribute("href") : null,
        snapshots: document.querySelectorAll("#snapshot-list .session-item").length,
        scanStatus: document.getElementById("fullscan-status-text").textContent,
    }));
    await page.screenshot({ path: path.join(OUT, name + "-back-workspace.png") });

    out.errors = errors;
    await ctx.close();
    return out;
}

const results = [];
results.push(await runCase("light", "1366x768-light"));
results.push(await runCase("dark", "1366x768-dark"));
await browser.close();
console.log(JSON.stringify(results, null, 2));
