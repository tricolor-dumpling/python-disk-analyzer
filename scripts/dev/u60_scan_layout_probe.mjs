/* ============================================================
   阶段 D（R3）· u60_scan_layout_probe.mjs（D-3b 三视口扫描卡布局验收）
   - 验收口径（手册 B-12/D-3b + 阶段D 专属纪律）：
     · 三视口（1366×768 / 1920×1080 / 357×651）× 三态（running/queued/done）
       截图 + 元素 rect 采样——无重叠/溢出（Luna 判读 + 客观 rect 交叉检测）；
     · 按钮语义随状态（重新扫描/重试扫描/开始全量扫描）采样；
     · console 0（无未处理 Promise/运行时错误）。
   - 桩态：addInitScript 覆写 fetch；扫描卡 scrollIntoView 聚焦（窄屏声明例外）。
   - 输出：--out 目录 scan-<state>-<w>x<h>.png ×9 + result.json（rect/重叠检测）。
   - 运行：node scripts/dev/u60_scan_layout_probe.mjs [--base http://127.0.0.1:5000/]
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
const OUT = path.resolve(arg("out", path.join(os.tmpdir(), "u60_scan_layout")));
fs.mkdirSync(OUT, { recursive: true });

const VIEWPORTS = [
    { w: 1366, h: 768 },
    { w: 1920, h: 1080 },
    { w: 357, h: 651 },
];

const STUB_FN = `
window.__stub = { scanState: "idle", doneRoots: 0, scanVersion: 1, errorMode: false, fetchLog: [] };
window.fetch = function (url, options) {
  options = options || {};
  const key = (options.method || "GET").toUpperCase() + " " + String(url).split("?")[0];
  window.__stub.fetchLog.push(key);
  const json = (o, s) => Promise.resolve({ ok: (s || 200) < 400, status: s || 200,
    json: () => Promise.resolve(JSON.parse(JSON.stringify(o))) });
  if (key === "GET /api/health") return json({ ok: true, ready: true, dll: "stub-dll", message: "Everything 已就绪", busy: false });
  if (key === "GET /api/settings") return json({ ok: true, settings: { auto_save: false, last_roots: ["D:\\\\", "C:\\\\"] }, data_dir: "C:\\\\stub\\\\data", snapshots_dir: "C:\\\\stub\\\\snapshots" });
  if (key === "POST /api/browse") return json({ ok: true, root: "D:\\\\", parent: null,
    directories: [], files: [], total_dirs: 0, total_files: 0, source: "sdk", source_at: "2026-09-05T12:00:00" });
  if (key === "GET /api/fullscan/status") {
    const s = window.__stub.scanState;
    const done = window.__stub.doneRoots;
    const base = { roots: ["C:\\\\", "D:\\\\"], roots_total: 2, error: null, scan_version: window.__stub.scanVersion,
      stop_requested: false, stop_reason: null, phase: "idle", lock_holder: null, row_done: 100000, row_total: 400000, stop_ack_at: null };
    if (s === "running") return json({ ok: true, status: { ...base, running: true, roots_done: done, current_root: done >= 1 ? "D:\\\\" : "C:\\\\", result_ready: false, save_ready: false, progress_pct: done >= 1 ? 70 : 40, phase: "scanning", lock_holder: "fullscan" } });
    if (s === "queued") return json({ ok: true, status: { ...base, running: true, roots_done: 0, current_root: null, result_ready: false, save_ready: false, progress_pct: 0, phase: "queued", lock_holder: "browse" } });
    if (s === "done") return json({ ok: true, status: { ...base, running: false, roots_done: 2, current_root: null, result_ready: true, save_ready: true, progress_pct: 100 } });
    if (s === "error") return json({ ok: true, status: { ...base, running: false, roots_done: 0, current_root: null, result_ready: false, save_ready: false, progress_pct: 0, error: "SDK 无响应（桩态）" } });
    return json({ ok: true, status: { ...base, running: false, roots_done: 0, current_root: null, result_ready: false, save_ready: false, progress_pct: 0 } });
  }
  if (key === "POST /api/fullscan/start") { window.__stub.scanState = "running"; return json({ ok: true, message: "全量扫描任务已提交", status: {} }); }
  if (key === "POST /api/fullscan/stop") return json({ ok: true, stopped: true, status: {} });
  if (key === "GET /api/snapshots") return json({ ok: true, sessions: [], count: 0 });
  if (key === "POST /api/save") return json({ ok: true, message: "保存完成", session: {}, saved: [], failed: [], skipped: false });
  if (key === "GET /api/overview") return json({ ok: true, ready: false, scanning: false, empty_reason: "no_scan", roots: [] });
  return json({ ok: true });
};
`;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const RESULT = { meta: { base: BASE, out: OUT, node: process.version }, shots: [], samples: [], overlaps: [], consoleErrors: [] };

/* 同卡内元素 rect 交叉检测（卡片边界内）——排除父子包含关系
   （btn-fullscan-label 在 btn-fullscan 内、scan-elapsed/scan-eta 在 fullscan-status 内
   属设计嵌套，非重叠）；只报兄弟元素间的真实压盖。 */
function checkOverlap(rects) {
    const list = Object.entries(rects).filter(([, r]) => r);
    const hits = [];
    const contains = (inner, outer) =>
        inner.x >= outer.x && inner.y >= outer.y &&
        inner.x + inner.w <= outer.x + outer.w &&
        inner.y + inner.h <= outer.y + outer.h;
    for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
            const a = list[i][1], b = list[j][1];
            if (contains(a, b) || contains(b, a)) continue; // 父子嵌套（设计）
            const xOverlap = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
            const yOverlap = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
            if (xOverlap > 4 && yOverlap > 4) {
                hits.push({ a: list[i][0], b: list[j][0], xOverlap: Math.round(xOverlap), yOverlap: Math.round(yOverlap) });
            }
        }
    }
    return hits;
}

async function capture(page, vp, state) {
    await page.evaluate((st) => { window.__stub.scanState = st; }, state);
    const anchors = {
        running: () => (document.getElementById("fullscan-status-text") || {}).textContent &&
            document.getElementById("fullscan-status-text").textContent.indexOf("总进度") !== -1,
        queued: () => (document.getElementById("fullscan-status-text") || {}).textContent &&
            document.getElementById("fullscan-status-text").textContent.indexOf("等待扫描引擎空闲") !== -1,
        done: () => (document.getElementById("fullscan-status-text") || {}).textContent &&
            document.getElementById("fullscan-status-text").textContent.indexOf("已完成") !== -1,
        error: () => (document.getElementById("fullscan-status-text") || {}).textContent &&
            document.getElementById("fullscan-status-text").textContent.indexOf("失败") !== -1,
    };
    await page.waitForFunction(anchors[state] || (() => true), { timeout: 10000 }).catch(() => {});
    await wait(500);
    if (vp.w < 900) {
        await page.evaluate(() => {
            const card = document.querySelector('section[aria-label="全量扫描"]');
            if (card) card.scrollIntoView({ block: "start", behavior: "instant" });
        });
        await wait(300);
    }
    const f = `scan-${state}-${vp.w}x${vp.h}.png`;
    await page.screenshot({ path: path.join(OUT, f), fullPage: false });
    const sample = await page.evaluate(() => {
        const ids = ["btn-fullscan", "btn-stop-scan", "btn-save", "progress", "progress-pct",
                     "fullscan-status", "scan-elapsed", "scan-eta", "scan-roots", "btn-scan-help", "btn-fullscan-label"];
        const rects = {};
        ids.forEach((id) => {
            const el = document.getElementById(id);
            if (el && !el.hasAttribute("hidden") && getComputedStyle(el).display !== "none") {
                const r = el.getBoundingClientRect();
                rects[id] = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
            }
        });
        return {
            vw: window.innerWidth, vh: window.innerHeight,
            statusText: (document.getElementById("fullscan-status-text") || {}).textContent || "",
            startLabel: (document.getElementById("btn-fullscan-label") || {}).textContent || "",
            rects: rects,
        };
    });
    return { file: f, sample };
}

(async () => {
    const browser = await chromium.launch({ headless: true });
    const errs = [];
    for (const vp of VIEWPORTS) {
        const page = await browser.newPage({ viewport: { width: vp.w, height: vp.h } });
        page.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text()); });
        page.on("pageerror", (e) => errs.push("pageerror: " + e.message));
        await page.addInitScript(() => { try { localStorage.setItem("pds_onboarding_dismissed_v1", "1"); } catch (e) {} });
        await page.addInitScript(() => { try { localStorage.setItem("pds_theme_v1", "light"); } catch (e) {} });
        // 预置自动扫描保护键：本探针手动驱动状态机（防自动 start 干扰布局时序）
        await page.addInitScript(() => { try { sessionStorage.setItem("pds_auto_started_v1", "1"); } catch (e) {} });
        await page.addInitScript(STUB_FN);
        await page.goto(BASE, { waitUntil: "load", timeout: 20000 }).catch((e) => { RESULT.meta.gotoError = String(e); });
        await page.waitForFunction(() => !!document.getElementById("btn-fullscan"), { timeout: 15000 }).catch(() => {});

        for (const state of ["running", "queued", "done"]) {
            const { file, sample } = await capture(page, vp, state);
            RESULT.shots.push(file);
            RESULT.samples.push(sample);
            const overlaps = checkOverlap(sample.rects);
            if (overlaps.length) RESULT.overlaps.push({ file, overlaps });
        }
        await page.close();
    }
    RESULT.consoleErrors = errs;
    fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(RESULT, null, 2), "utf-8");
    console.log("== u60_scan_layout_probe ==");
    RESULT.shots.forEach((s) => console.log("shot=" + path.join(OUT, s)));
    RESULT.samples.forEach((s) => console.log("vp=" + s.vw + "x" + s.vh + " status=" + s.statusText + " label=" + s.startLabel + " rects=" + Object.keys(s.rects).length));
    if (RESULT.overlaps.length) {
        console.log("OVERLAPS:");
        RESULT.overlaps.forEach((o) => console.log("  " + o.file + ": " + JSON.stringify(o.overlaps)));
    }
    if (errs.length) console.log("console errors:\n" + errs.join("\n"));
    console.log("result=" + path.join(OUT, "result.json"));
    await browser.close();
    const failed = RESULT.overlaps.length > 0 || errs.length > 0;
    process.exit(failed ? 1 : 0);
})();