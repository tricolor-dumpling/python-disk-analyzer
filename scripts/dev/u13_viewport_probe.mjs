/* ============================================================
   UI 2.0（SpaceLens Pro）· U1.3 App Shell 验收探针
   - 真实页（Flask 5000）+ 预置 fetch 桩（页面内联,不依赖 Everything 环境）下：
     ① 两档窗口（1366×768 / 1920×1080）零滚动指标与截图（亮/暗两主题）；
     ② <900px 宽（800×700）滚动回退确认；
     ③ 控制台/页面错误捕获。
   - 运行：node scripts/dev/u13_viewport_probe.mjs [--base http://127.0.0.1:5000/] [--out <截图目录>]
   - 依赖：仅本机验收用 Playwright（.dsh/profiles/web/node_modules），
     不入 requirements/package.json（与项目零前端依赖纪律无冲突）。
   ============================================================ */

import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const require = createRequire(import.meta.url);
const { chromium } = require("C:/Users/26024/.dsh/profiles/web/node_modules/playwright");

/* 解析 --base / --out */
function arg(name, dflt) {
    const i = process.argv.indexOf("--" + name);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const BASE = arg("base", "http://127.0.0.1:5000/");
const OUT = arg("out", path.join(os.tmpdir(), "u13_shots"));
const STEADY = process.argv.indexOf("--steady") !== -1;

/* ---- fetch 桩（页面内联；文案/形状照抄真实接口键集合，仅供视觉验收） ---- */
const STUB_FN = `
window.__realFetch = window.fetch.bind(window);
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

const VIEWPORTS = [
    { name: "1366x768", width: 1366, height: 768, theme: "light" },
    { name: "1920x1080", width: 1920, height: 1080, theme: "light" },
    { name: "1366x768-dark", width: 1366, height: 768, theme: "dark" },
    { name: "800x700-narrow", width: 800, height: 700, theme: "light" },
];

const browser = await chromium.launch({ headless: true });
fs.mkdirSync(OUT, { recursive: true });
const report = [];

for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push("pageerror:" + String(e)));
    page.on("console", (m) => { if (m.type() === "error") errors.push("console.error:" + m.text()); });

    // 主题：dark 时预写 localStorage（head 防闪烁脚本同源读取）
    if (vp.theme === "dark") {
        await page.addInitScript(() => { try { localStorage.setItem("pds_theme_v1", "dark"); } catch (e) { /* ignore */ } });
    }
    // --steady：预置首启引导「已关闭」，截图反映常态（首启引导态零滚动由首次运行记录佐证）
    if (STEADY) {
        await page.addInitScript(() => { try { localStorage.setItem("pds_onboarding_dismissed_v1", "1"); } catch (e) { /* ignore */ } });
    }
    await page.addInitScript(new Function(STUB_FN));
    await page.goto(BASE, { waitUntil: "load" });
    await page.waitForTimeout(900); // 等 init 异步链 + 首屏渲染

    const m = await page.evaluate(() => {
        const $ = (s) => document.querySelector(s);
        const rail = $("#side-rail");
        const app = $("#app");
        return {
            scrollHeight: document.body.scrollHeight,
            clientHeight: document.body.clientHeight,
            innerHeight: window.innerHeight,
            bodyOverflow: getComputedStyle(document.body).overflow,
            appHeight: app ? Math.round(app.getBoundingClientRect().height) : -1,
            topbarHeight: $(".topbar") ? Math.round($(".topbar").getBoundingClientRect().height) : -1,
            statusbarHeight: $(".statusbar") ? Math.round($(".statusbar").getBoundingClientRect().height) : -1,
            railClient: rail ? rail.clientHeight : -1,
            railScroll: rail ? rail.scrollHeight : -1,
            mainRows: document.querySelectorAll("#dir-body .ranking-row, #dir-body .ranking-row-static").length,
            dataTheme: document.documentElement.getAttribute("data-theme"),
        };
    });
    const shot = path.join(OUT, vp.name + ".png");
    await page.screenshot({ path: shot, fullPage: false });
    report.push({
        viewport: vp.name,
        metrics: m,
        zeroScroll: m.scrollHeight - m.clientHeight <= 1 && m.bodyOverflow === "hidden",
        screenshot: shot,
        errors,
    });
    await ctx.close();
}

await browser.close();
console.log(JSON.stringify(report, null, 2));
