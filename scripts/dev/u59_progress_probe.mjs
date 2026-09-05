/* ============================================================
   阶段 D（R3）· u59_progress_probe.mjs（D-3b 进度四要素 + ETA 稳定性断言）
   - 验收口径（手册 B-11/B-12/D-3b）：
     · running 态状态行含四要素：总进度 % / 已完成 x/y 盘 / 当前盘 / 已用时；
     · ETA 标注「估算」且不闪跳：两次采样变化 <10% 不更新文案；
     · reduced-motion 下 ETA/进度直显（不依赖动画）；
     · 队列（queued）态无「0/2」误导文案；
   - 桩态：addInitScript 覆写 fetch，scanState 可控；ETA 用根间均速推导。
   - 输出：--out 目录 result.json（结构化 PASS/FAIL）+ 采样截图（供 Luna 判读）。
   - 运行：node scripts/dev/u59_progress_probe.mjs [--base http://127.0.0.1:5000/]
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
const OUT = path.resolve(arg("out", path.join(os.tmpdir(), "u59_progress")));
fs.mkdirSync(OUT, { recursive: true });

/* 桩 fetch：scanState idle|running|queued|done；etaStep 控制 roots_done 推进节奏 */
const STUB_FN = `
window.__stub = { scanState: "idle", doneRoots: 0, scanVersion: 1, etaProbe: false, fetchLog: [] };
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
    return json({ ok: true, status: { ...base, running: false, roots_done: 0, current_root: null, result_ready: false, save_ready: false, progress_pct: 0 } });
  }
  if (key === "POST /api/fullscan/start") { window.__stub.scanState = "running"; return json({ ok: true, message: "全量扫描任务已提交", status: {} }); }
  if (key === "POST /api/fullscan/stop") return json({ ok: true, stopped: true, status: {} });
  if (key === "GET /api/snapshots") return json({ ok: true, sessions: [], count: 0 });
  if (key === "GET /api/overview") return json({ ok: true, ready: false, scanning: false, empty_reason: "no_scan", roots: [] });
  return json({ ok: true });
};
`;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const RESULT = { meta: { base: BASE, out: OUT, node: process.version }, checks: [], samples: [], consoleErrors: [] };

function check(name, cond, detail) {
    RESULT.checks.push({ name, pass: !!cond, detail: detail || "" });
    console.log((cond ? "  ✔ " : "  ✖ ") + name + (cond ? "" : " :: " + detail));
}

async function newPage(browser, reduced) {
    const page = await browser.newPage({
        viewport: { width: 1366, height: 768 },
        reducedMotion: reduced ? "reduce" : "no-preference",
    });
    const errs = [];
    page.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text()); });
    page.on("pageerror", (e) => errs.push("pageerror: " + e.message));
    await page.addInitScript(() => { try { localStorage.setItem("pds_onboarding_dismissed_v1", "1"); } catch (e) {} });
    // 预置自动扫描保护键：本探针手动驱动扫描状态机
    await page.addInitScript(() => { try { sessionStorage.setItem("pds_auto_started_v1", "1"); } catch (e) {} });
    await page.addInitScript(STUB_FN);
    await page.goto(BASE, { waitUntil: "load", timeout: 20000 }).catch((e) => { RESULT.meta.gotoError = String(e); });
    await page.waitForFunction(() => !!document.getElementById("btn-fullscan"), { timeout: 15000 }).catch(() => {});
    return { page, errs };
}

(async () => {
    const browser = await chromium.launch({ headless: true });

    /* ---- 场景 1：running 态四要素（百分比/盘数/当前盘/已用时）+ ETA 估算标注 ----
       doneRoots=1 → ETA 可估算（已完成 1 根均耗时 × 剩余 1 根） */
    {
        const { page, errs } = await newPage(browser, false);
        await page.evaluate(() => { window.__stub.scanState = "running"; window.__stub.doneRoots = 1; });
        await page.waitForFunction(
            () => (document.getElementById("fullscan-status-text") || {}).textContent &&
                document.getElementById("fullscan-status-text").textContent.indexOf("总进度") !== -1,
            { timeout: 10000 }
        ).catch(() => {});
        // 等至少一轮轮询（ETA 依赖 scanStartTs 计时起点推进）
        await wait(2400);
        const s1 = await page.evaluate(() => ({
            statusText: (document.getElementById("fullscan-status-text") || {}).textContent || "",
            elapsed: (document.getElementById("scan-elapsed") || {}).textContent || "",
            eta: (document.getElementById("scan-eta") || {}).textContent || "",
            etaHidden: (document.getElementById("scan-eta") || {}).hasAttribute("hidden"),
            pct: (document.getElementById("progress-pct") || {}).textContent || "",
        }));
        check("running 状态行含「总进度 %」", s1.statusText.indexOf("总进度") !== -1 && s1.statusText.indexOf("70%") !== -1, s1.statusText);
        check("running 状态行含「已完成 x/y 盘」", /已完成\s*1\/2/.test(s1.statusText), s1.statusText);
        check("running 状态行含「当前盘」", s1.statusText.indexOf("当前") !== -1 && s1.statusText.indexOf("D:") !== -1, s1.statusText);
        check("running 显示「已用时」（HH:MM:SS）", /已用时 \d{2}:\d{2}:\d{2}/.test(s1.elapsed), s1.elapsed);
        check("ETA 标注「估算」", !s1.etaHidden && (s1.eta.indexOf("估算") !== -1 || s1.eta.indexOf("即将完成") !== -1), "eta=" + s1.eta + " hidden=" + s1.etaHidden);
        check("进度百分比独立元素", s1.pct.indexOf("70%") !== -1, s1.pct);
        const f1 = "running-四要素-1366x768.png";
        await page.screenshot({ path: path.join(OUT, f1) });
        RESULT.samples.push({ scene: "running-four-elements", shot: f1, ...s1 });
        RESULT.consoleErrors = RESULT.consoleErrors.concat(errs);
        await page.close();
    }

    /* ---- 场景 2：ETA 不闪跳（两次采样变化 <10% 不更新文案） ----
       根间均速假设下 elapsed 增长 → remain 增长缓慢；两次采样间 remain 变化
       <10% → 文案不变（同一字符串）；跨 >10% 才变化。 */
    {
        const { page, errs } = await newPage(browser, false);
        await page.evaluate(() => { window.__stub.scanState = "running"; window.__stub.doneRoots = 1; });
        await page.waitForFunction(
            () => (document.getElementById("scan-eta") || {}).textContent &&
                (document.getElementById("scan-eta") || {}).textContent.indexOf("预计剩余") !== -1,
            { timeout: 10000 }
        ).catch(() => {});
        await wait(200);
        const etaText1 = await page.evaluate(() => (document.getElementById("scan-eta") || {}).textContent || "");
        // 推进 roots_done=1 已保持；仅时间流逝（elapsed 增长 ~3s）→ remain 变化远 <10%
        await wait(3200);
        const etaText2 = await page.evaluate(() => (document.getElementById("scan-eta") || {}).textContent || "");
        const stable = etaText1 === etaText2;
        check("ETA 不闪跳：<10% 变化不更新文案", stable, "before=" + etaText1 + " after=" + etaText2);
        RESULT.samples.push({ scene: "eta-stability", before: etaText1, after: etaText2, stable });
        // 强制跨越阈值：roots_done 推进 0→1（elapsed 不变 → remain 减半）→ 文案应变化
        await page.evaluate(() => { window.__stub.doneRoots = 0; });
        await wait(200);
        const etaText3 = await page.evaluate(() => (document.getElementById("scan-eta") || {}).textContent || "");
        // done 从 1→0 → 无法估算（done<=0）→ eta 隐藏；再回 1 → 新文案
        await page.evaluate(() => { window.__stub.doneRoots = 1; });
        await wait(200);
        const etaText4 = await page.evaluate(() => (document.getElementById("scan-eta") || {}).textContent || "");
        RESULT.samples.push({ scene: "eta-cross-threshold", t3: etaText3, t4: etaText4 });
        check("ETA 场景 console 0", errs.length === 0, errs.join(" | "));
        RESULT.consoleErrors = RESULT.consoleErrors.concat(errs);
        await page.close();
    }

    /* ---- 场景 3：queued 态无「0/2」误导 + 排队文案 ---- */
    {
        const { page, errs } = await newPage(browser, false);
        await page.evaluate(() => { window.__stub.scanState = "queued"; });
        await page.waitForFunction(
            () => (document.getElementById("fullscan-status-text") || {}).textContent &&
                document.getElementById("fullscan-status-text").textContent.indexOf("等待扫描引擎空闲") !== -1,
            { timeout: 10000 }
        ).catch(() => {});
        await wait(400);
        const q = await page.evaluate(() => ({
            statusText: (document.getElementById("fullscan-status-text") || {}).textContent || "",
            etaHidden: (document.getElementById("scan-eta") || {}).hasAttribute("hidden"),
        }));
        check("queued 状态行 = 等待扫描引擎空闲（无 0/2 误导）", q.statusText.indexOf("等待扫描引擎空闲") !== -1 && q.statusText.indexOf("0/2") === -1, q.statusText);
        check("queued 不显示 ETA", q.etaHidden === true, "etaHidden=" + q.etaHidden);
        RESULT.consoleErrors = RESULT.consoleErrors.concat(errs);
        await page.close();
    }

    /* ---- 场景 4：reduced-motion 直显（进度/ETA 不依赖动画） ---- */
    {
        const { page, errs } = await newPage(browser, true);
        await page.evaluate(() => { window.__stub.scanState = "running"; window.__stub.doneRoots = 1; });
        await page.waitForFunction(
            () => (document.getElementById("fullscan-status-text") || {}).textContent &&
                document.getElementById("fullscan-status-text").textContent.indexOf("总进度") !== -1,
            { timeout: 10000 }
        ).catch(() => {});
        await wait(2400); // 等轮询推进计时（ETA 需 elapsed>0）
        const r = await page.evaluate(() => ({
            statusText: (document.getElementById("fullscan-status-text") || {}).textContent || "",
            elapsed: (document.getElementById("scan-elapsed") || {}).textContent || "",
            eta: (document.getElementById("scan-eta") || {}).textContent || "",
            etaHidden: (document.getElementById("scan-eta") || {}).hasAttribute("hidden"),
        }));
        check("reduced-motion：进度四要素直显", r.statusText.indexOf("总进度") !== -1 && /已用时/.test(r.elapsed) && !r.etaHidden && r.eta.indexOf("预计剩余") !== -1, JSON.stringify(r));
        const f2 = "running-reduced-1366x768.png";
        await page.screenshot({ path: path.join(OUT, f2) });
        RESULT.samples.push({ scene: "running-reduced", shot: f2, ...r });
        RESULT.consoleErrors = RESULT.consoleErrors.concat(errs);
        await page.close();
    }

    fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(RESULT, null, 2), "utf-8");
    console.log("== u59_progress_probe ==");
    console.log("result=" + path.join(OUT, "result.json"));
    if (RESULT.consoleErrors.length) {
        console.log("console errors:\n" + RESULT.consoleErrors.join("\n"));
    }
    await browser.close();
    const failed = RESULT.checks.some((c) => !c.pass) || RESULT.consoleErrors.length > 0;
    process.exit(failed ? 1 : 0);
})();