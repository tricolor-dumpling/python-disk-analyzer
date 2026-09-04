/* ============================================================
   阶段 B（R1）· u51_poll_probe.mjs（B-17 验收探针：轮询频率）
   - 验收口径（手册贰章 2-16/B-17）：
     · 运行中（扫描/排队）30s 内 /api/fullscan/status 请求 ≤15 次；
     · 空闲 30s ≤6 次；
   - 桩态：addInitScript 覆写 fetch（零真实后端依赖），scanState 可切换
     idle → running，探针按 DOM 状态推进两个 30s 窗口并统计 fetchLog。
   - 输出：--out 目录 result.json（结构化计数与 PASS/FAIL）。
   - 运行：node scripts/dev/u51_poll_probe.mjs [--base http://127.0.0.1:5000/]
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
const OUT = path.resolve(arg("out", path.join(os.tmpdir(), "u51_poll")));
fs.mkdirSync(OUT, { recursive: true });

const WINDOW_MS = 30000; // B-17：30s 验收窗口
const RESULT = {
    meta: { base: BASE, out: OUT, node: process.version, startedAt: new Date().toISOString() },
    idle: { statusCalls: 0, pass: false, note: "" },
    running: { statusCalls: 0, pass: false, note: "" },
};

/* 桩 fetch：覆盖页面启动所需接口；status 按 __stub.scanState 返回 */
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
    directories: [ { name: "data", path: "D:\\\\data", is_dir: true, size: 12000, size_human: "11.72 KB" } ],
    files: [ { name: "readme.txt", path: "D:\\\\readme.txt", is_dir: false, size: 100, size_human: "100 B" } ],
    total_dirs: 1, total_files: 1, source: "sdk", source_at: "2026-09-03T12:00:00" });
  if (key === "GET /api/fullscan/status") {
    const s = window.__stub.scanState;
    const idleSt = { running: false, roots: ["C:\\\\", "D:\\\\"], roots_done: 0, roots_total: 2, current_root: null, error: null, result_ready: false, save_ready: false, progress_pct: 0, scan_version: window.__stub.scanVersion, stop_requested: false, stop_reason: null, phase: "idle", lock_holder: null, row_done: 0, row_total: 0, stop_ack_at: null };
    const runSt = { running: true, roots: ["C:\\\\", "D:\\\\"], roots_done: 0, roots_total: 2, current_root: "C:\\\\", error: null, result_ready: false, save_ready: false, progress_pct: 40, scan_version: window.__stub.scanVersion, stop_requested: false, stop_reason: null, phase: "scanning", lock_holder: "fullscan", row_done: 100000, row_total: 400000, stop_ack_at: null };
    return json({ ok: true, status: s === "running" ? runSt : idleSt });
  }
  if (key === "GET /api/snapshots") return json({ ok: true, sessions: [], count: 0 });
  if (key === "GET /api/overview") return json({ ok: true, ready: false, scanning: false, empty_reason: "no_scan", roots: [] });
  if (key === "POST /api/compare") return json({ ok: true, report: { root: "D:\\\\", total_baseline: 16000, total_current: 15990, delta_total: -10, truncated: false, legacy_count: 0, rows: [] } });
  if (key === "GET /api/compare/status") return json({ ok: true, status: "done", report: { root: "D:\\\\", total_baseline: 16000, total_current: 15990, delta_total: -10, truncated: false, legacy_count: 0, rows: [] } });
  return json({ ok: true });
};
`;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function countStatusCalls(page, windowMs) {
    await page.evaluate(() => { window.__stub.fetchLog.length = 0; });
    await wait(windowMs);
    return page.evaluate(() =>
        window.__stub.fetchLog.filter((k) => k === "GET /api/fullscan/status").length
    );
}

(async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const errs = [];
    page.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text()); });
    page.on("pageerror", (e) => errs.push("pageerror: " + e.message));
    await page.addInitScript(STUB_FN);
    await page.goto(BASE, { waitUntil: "load", timeout: 20000 }).catch((e) => {
        RESULT.meta.gotoError = String(e);
    });
    // 等待初始轮询完成（main.js start() 首拍 status）
    await page.waitForFunction(
        () => window.__stub && window.__stub.fetchLog.some((k) => k === "GET /api/fullscan/status"),
        { timeout: 15000 }
    ).catch(() => {});
    await wait(1000); // 让首个 6s 间隔链建立

    // ---- 阶段 1：空闲 30s（B-17：≤6 次） ----
    const idleCalls = await countStatusCalls(page, WINDOW_MS);
    RESULT.idle.statusCalls = idleCalls;
    RESULT.idle.pass = idleCalls <= 6;
    RESULT.idle.note = "空闲 30s status 请求 " + idleCalls + " 次（验收 ≤6）";

    // ---- 阶段 2：运行中 30s（B-17：≤15 次） ----
    await page.evaluate(() => { window.__stub.scanState = "running"; });
    // 等待前端感知 running（DOM：进度条 running 类）
    await page.waitForFunction(
        () => document.getElementById("progress") &&
            document.getElementById("progress").classList.contains("running"),
        { timeout: 10000 }
    ).catch(() => {});
    const runningCalls = await countStatusCalls(page, WINDOW_MS);
    RESULT.running.statusCalls = runningCalls;
    RESULT.running.pass = runningCalls <= 15;
    RESULT.running.note = "运行中 30s status 请求 " + runningCalls + " 次（验收 ≤15）";

    RESULT.consoleErrors = errs;
    const pass = RESULT.idle.pass && RESULT.running.pass && errs.length === 0;
    RESULT.pass = pass;
    fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(RESULT, null, 2), "utf-8");
    console.log("== u51_poll_probe ==");
    console.log("idle:    " + RESULT.idle.note + "  => " + (RESULT.idle.pass ? "PASS" : "FAIL"));
    console.log("running: " + RESULT.running.note + "  => " + (RESULT.running.pass ? "PASS" : "FAIL"));
    if (errs.length) console.log("console errors:\n" + errs.join("\n"));
    console.log("result=" + path.join(OUT, "result.json"));
    await browser.close();
    process.exit(pass ? 0 : 1);
})();
