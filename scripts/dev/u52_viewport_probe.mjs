/* ============================================================
   阶段 B（R1）· u52_viewport_probe.mjs（B-12 验收：三视口截图）
   - 视口：1366×768 / 1920×1080 / 357×651（手册 B-12 验收口径）；
   - 场景：扫描中（桩态 running 40%+排队中 queued）与完成态，
     检查扫描卡按钮/进度行/状态栏无重叠溢出（视觉判读交 gpt-5.6-luna）；
   - 桩态：addInitScript 覆写 fetch（零真实后端）；
   - 输出：--out 目录下 scan-running-<w>x<h>.png / scan-queued-<w>x<h>.png
     / scan-done-<w>x<h>.png + result.json（结构采样：各元素 rect）。
   - 运行：node scripts/dev/u52_viewport_probe.mjs [--base http://127.0.0.1:5000/]
            [--out <目录>]
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
const OUT = path.resolve(arg("out", path.join(os.tmpdir(), "u52_viewport")));
fs.mkdirSync(OUT, { recursive: true });

const VIEWPORTS = [
    { w: 1366, h: 768 },
    { w: 1920, h: 1080 },
    { w: 357, h: 651 },
];

const RESULT = { meta: { base: BASE, out: OUT, node: process.version }, shots: [], samples: [] };

/* 桩 fetch：scanState = idle | running | queued | done */
const STUB_FN = `
window.__stub = { scanState: "idle", fetchLog: [], scanVersion: 1 };
window.fetch = function (url, options) {
  options = options || {};
  const key = (options.method || "GET").toUpperCase() + " " + String(url).split("?")[0];
  window.__stub.fetchLog.push(key);
  const json = (o, s) => Promise.resolve({ ok: (s || 200) < 400, status: s || 200,
    json: () => Promise.resolve(JSON.parse(JSON.stringify(o))) });
  if (key === "GET /api/health") return json({ ok: true, ready: true, dll: "stub-dll", message: "Everything 已就绪", busy: false });
  if (key === "GET /api/settings") return json({ ok: true, settings: { auto_save: false, last_roots: ["D:\\\\", "C:\\\\"] }, data_dir: "C:\\\\stub\\\\data", snapshots_dir: "C:\\\\stub\\\\snapshots" });
  if (key === "POST /api/browse") return json({ ok: true, root: "D:\\\\", parent: null,
    directories: [ { name: "data", path: "D:\\\\data", is_dir: true, size: 12000, size_human: "11.72 KB" }, { name: "docs", path: "D:\\\\docs", is_dir: true, size: 4000, size_human: "3.91 KB" } ],
    files: [ { name: "readme.txt", path: "D:\\\\readme.txt", is_dir: false, size: 100, size_human: "100 B" } ],
    total_dirs: 2, total_files: 1, source: "sdk", source_at: "2026-09-03T12:00:00" });
  if (key === "GET /api/fullscan/status") {
    const s = window.__stub.scanState;
    const base = { roots: ["C:\\\\", "D:\\\\"], roots_total: 2, error: null, scan_version: window.__stub.scanVersion };
    if (s === "done") return json({ ok: true, status: { ...base, running: false, roots_done: 2, current_root: null, result_ready: true, save_ready: true, progress_pct: 100, stop_requested: false, stop_reason: null, phase: "idle", lock_holder: null, row_done: 0, row_total: 0, stop_ack_at: null } });
    if (s === "queued") return json({ ok: true, status: { ...base, running: true, roots_done: 0, current_root: null, result_ready: false, save_ready: false, progress_pct: 0, stop_requested: false, stop_reason: null, phase: "queued", lock_holder: "browse", row_done: 0, row_total: 0, stop_ack_at: null } });
    return json({ ok: true, status: { ...base, running: true, roots_done: 0, current_root: "C:\\\\", result_ready: false, save_ready: false, progress_pct: 40, stop_requested: false, stop_reason: null, phase: "scanning", lock_holder: "fullscan", row_done: 100000, row_total: 400000, stop_ack_at: null } });
  }
  if (key === "GET /api/snapshots") return json({ ok: true, sessions: [], count: 0 });
  if (key === "GET /api/overview") return json({ ok: true, ready: false, scanning: true, empty_reason: "scanning", roots: [], progress_pct: 40, current_root: "C:\\\\", roots_done: 0, roots_total: 2 });
  return json({ ok: true });
};
`;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    const browser = await chromium.launch({ headless: true });
    const errs = [];
    for (const vp of VIEWPORTS) {
        const page = await browser.newPage({ viewport: { width: vp.w, height: vp.h } });
        page.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text()); });
        page.on("pageerror", (e) => errs.push("pageerror: " + e.message));
        await page.addInitScript(STUB_FN);
        await page.goto(BASE, { waitUntil: "load", timeout: 20000 }).catch((e) => {
            RESULT.meta.gotoError = String(e);
        });
        // 等扫描卡渲染
        await page.waitForFunction(() => !!document.getElementById("btn-fullscan"), { timeout: 15000 }).catch(() => {});

        // 场景 A：扫描中（running）
        await page.evaluate(() => { window.__stub.scanState = "running"; });
        await page.waitForFunction(
            () => document.getElementById("progress") && document.getElementById("progress").classList.contains("running"),
            { timeout: 10000 }
        ).catch(() => {});
        await wait(500);
        const f1 = `scan-running-${vp.w}x${vp.h}.png`;
        await page.screenshot({ path: path.join(OUT, f1), fullPage: false });
        RESULT.shots.push(f1);

        // 场景 B：排队中（queued）
        await page.evaluate(() => { window.__stub.scanState = "queued"; });
        await page.waitForFunction(
            () => (document.getElementById("fullscan-status-text") || {}).textContent &&
                document.getElementById("fullscan-status-text").textContent.indexOf("等待扫描引擎空闲") !== -1,
            { timeout: 10000 }
        ).catch(() => {});
        await wait(500);
        const f2 = `scan-queued-${vp.w}x${vp.h}.png`;
        await page.screenshot({ path: path.join(OUT, f2), fullPage: false });
        RESULT.shots.push(f2);

        // 场景 C：完成态
        await page.evaluate(() => { window.__stub.scanState = "done"; });
        await page.waitForFunction(
            () => (document.getElementById("fullscan-status-text") || {}).textContent &&
                document.getElementById("fullscan-status-text").textContent.indexOf("已完成") !== -1,
            { timeout: 10000 }
        ).catch(() => {});
        await wait(500);
        const f3 = `scan-done-${vp.w}x${vp.h}.png`;
        await page.screenshot({ path: path.join(OUT, f3), fullPage: false });
        RESULT.shots.push(f3);

        // 结构采样：扫描卡关键元素 rect（重叠判读依据）
        const sample = await page.evaluate(() => {
            const ids = ["btn-fullscan", "btn-stop-scan", "btn-save", "btn-export-csv", "btn-export-json",
                         "progress", "progress-pct", "fullscan-status", "scan-elapsed", "scan-eta", "scan-roots", "btn-scan-help"];
            const rects = {};
            ids.forEach((id) => {
                const el = document.getElementById(id);
                if (el && !el.hasAttribute("hidden") && getComputedStyle(el).display !== "none") {
                    const r = el.getBoundingClientRect();
                    rects[id] = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
                }
            });
            return { vw: window.innerWidth, vh: window.innerHeight, rects: rects, statusText: (document.getElementById("fullscan-status-text") || {}).textContent || "" };
        });
        RESULT.samples.push(sample);
        await page.close();
    }
    RESULT.consoleErrors = errs;
    fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(RESULT, null, 2), "utf-8");
    console.log("== u52_viewport_probe ==");
    RESULT.shots.forEach((s) => console.log("shot=" + path.join(OUT, s)));
    RESULT.samples.forEach((s) => console.log("vp=" + s.vw + "x" + s.vh + " status=" + s.statusText + " rects=" + Object.keys(s.rects).length));
    if (errs.length) console.log("console errors:\n" + errs.join("\n"));
    console.log("result=" + path.join(OUT, "result.json"));
    await browser.close();
    process.exit(errs.length ? 1 : 0);
})();
