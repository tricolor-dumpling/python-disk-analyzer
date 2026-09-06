/* ============================================================
   阶段 D（R3）· u58_auto_scan_probe.mjs（D-1 自动扫描恰一次断言）
   - 验收口径（阶段D 专属纪律）：
     · 冷启动（无会话）→ /api/fullscan/start POST 计数 = 1（Network 计数）；
     · 刷新（sessionStorage 保持）→ 计数仍 = 1（恢复轮询态，不重复触发）；
     · 扫描中刷新 → 恢复运行态（progress.running），不重发 start；
     · 保存恰一次：自动保存会话数 +1（桩态 /api/save 计数 = 1）；
     · Everything 未就绪 → 不自动发起（门控不进入 ready 分支）；
     · 当日已有快照会话 → 不自动发起（防同日重复全扫）。
   - 桩态：addInitScript 覆写 fetch（零真实后端），sessionStorage 可控。
   - 输出：--out 目录 result.json（结构化 PASS/FAIL）+ 控制台摘要。
   - 运行：node scripts/dev/u58_auto_scan_probe.mjs [--base http://127.0.0.1:5000/]
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
const OUT = path.resolve(arg("out", path.join(os.tmpdir(), "u58_auto_scan")));
fs.mkdirSync(OUT, { recursive: true });

/* 桩 fetch：scanState idle|running|done；hasTodaySession / healthReady / saveFail 可控 */
const STUB_FN = `
window.__stub = {
  scanState: "idle", healthReady: true, hasTodaySession: false, saveFail: false,
  startCount: 0, saveCount: 0, statusCount: 0, fetchLog: [],
  reset: function () { this.startCount = 0; this.saveCount = 0; this.statusCount = 0; this.fetchLog.length = 0; }
};
window.fetch = function (url, options) {
  options = options || {};
  const key = (options.method || "GET").toUpperCase() + " " + String(url).split("?")[0];
  window.__stub.fetchLog.push(key);
  const json = (o, s) => Promise.resolve({ ok: (s || 200) < 400, status: s || 200,
    json: () => Promise.resolve(JSON.parse(JSON.stringify(o))) });
  if (key === "GET /api/health") {
    return window.__stub.healthReady
      ? json({ ok: true, ready: true, dll: "stub-dll", message: "Everything 已就绪", busy: false })
      : json({ ok: true, ready: false, dll: "stub-dll", message: "Everything IPC 尚未就绪", busy: false });
  }
  if (key === "GET /api/settings") return json({ ok: true, settings: { auto_save: true, last_roots: ["D:\\\\", "C:\\\\"] }, data_dir: "C:\\\\stub\\\\data", snapshots_dir: "C:\\\\stub\\\\snapshots" });
  if (key === "POST /api/browse") return json({ ok: true, root: "D:\\\\", parent: null,
    directories: [], files: [], total_dirs: 0, total_files: 0, source: "sdk", source_at: "2026-09-05T12:00:00" });
  if (key === "GET /api/fullscan/status") {
    window.__stub.statusCount += 1;
    const s = window.__stub.scanState;
    const base = { roots: ["C:\\\\", "D:\\\\"], roots_total: 2, error: null, scan_version: 1,
      stop_requested: false, stop_reason: null, phase: "idle", lock_holder: null, row_done: 0, row_total: 0, stop_ack_at: null };
    if (s === "running") return json({ ok: true, status: { ...base, running: true, roots_done: 0, current_root: "C:\\\\", result_ready: false, save_ready: false, progress_pct: 40, phase: "scanning", lock_holder: "fullscan" } });
    if (s === "done") return json({ ok: true, status: { ...base, running: false, roots_done: 2, current_root: null, result_ready: true, save_ready: true, progress_pct: 100 } });
    return json({ ok: true, status: { ...base, running: false, roots_done: 0, current_root: null, result_ready: false, save_ready: false, progress_pct: 0 } });
  }
  if (key === "POST /api/fullscan/start") {
    window.__stub.startCount += 1;
    window.__stub.scanState = "running";
    return json({ ok: true, message: "全量扫描任务已提交，后台执行中", status: { running: true, roots: ["C:\\\\", "D:\\\\"], roots_total: 2, roots_done: 0, current_root: "C:\\\\", result_ready: false, save_ready: false, progress_pct: 40, scan_version: 1, stop_requested: false, stop_reason: null, phase: "scanning", lock_holder: "fullscan", row_done: 0, row_total: 0, stop_ack_at: null } });
  }
  if (key === "POST /api/fullscan/stop") return json({ ok: true, stopped: true, status: { running: false, roots: ["C:\\\\", "D:\\\\"], roots_total: 2, roots_done: 0, current_root: null, result_ready: false, save_ready: false, progress_pct: 0, scan_version: 1, stop_requested: true, stop_reason: "user", phase: "idle", lock_holder: null, row_done: 0, row_total: 0, stop_ack_at: null } });
  if (key === "GET /api/snapshots") {
    if (window.__stub.hasTodaySession) return json({ ok: true, sessions: [ { session_id: "s-today", auto: true, machine_guid: "stub", created_at: "2026-09-05T09:00:00", roots: { "C:\\\\": { root: "C:\\\\", snapshot: "C.snap.gz", snapshot_path: "C:\\\\stub\\\\C.snap.gz", skipped: false } } } ], count: 1 });
    return json({ ok: true, sessions: [], count: 0 });
  }
  if (key === "POST /api/save") {
    window.__stub.saveCount += 1;
    if (window.__stub.saveFail) return json({ ok: false, error: "保存失败：模拟错误" }, 409);
    return json({ ok: true, message: "保存完成", session: { session_id: "s-auto", auto: true, machine_guid: "stub", roots: { "C:\\\\": { root: "C:\\\\", snapshot: "C.snap.gz", snapshot_path: "C:\\\\stub\\\\C.snap.gz", skipped: false } } }, saved: [{ root: "C:\\\\", snapshot: "C.snap.gz", bytes: 100 }], failed: [], skipped: false });
  }
  if (key === "GET /api/overview") return json({ ok: true, ready: false, scanning: false, empty_reason: "no_scan", roots: [] });
  return json({ ok: true });
};
`;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const RESULT = { meta: { base: BASE, out: OUT, node: process.version }, checks: [], consoleErrors: [] };

function check(name, cond, detail) {
    RESULT.checks.push({ name, pass: !!cond, detail: detail || "" });
    console.log((cond ? "  ✔ " : "  ✖ ") + name + (cond ? "" : " :: " + detail));
}

async function newPage(browser, presetKey) {
    const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
    const errs = [];
    page.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text()); });
    page.on("pageerror", (e) => errs.push("pageerror: " + e.message));
    await page.addInitScript(() => { try { localStorage.setItem("pds_onboarding_dismissed_v1", "1"); } catch (e) {} });
    if (presetKey) {
        await page.addInitScript(() => { try { sessionStorage.setItem("pds_auto_started_v1", "1"); } catch (e) {} });
    }
    await page.addInitScript(STUB_FN);
    await page.goto(BASE, { waitUntil: "load", timeout: 20000 }).catch((e) => { RESULT.meta.gotoError = String(e); });
    await page.waitForFunction(() => !!document.getElementById("btn-fullscan"), { timeout: 15000 }).catch(() => {});
    return { page, errs };
}

async function waitAutoStartSettled(page) {
    // 等自动扫描发起链收敛（健康 ready → 派发 → start POST → 写保护键）
    await wait(1200);
    await page.evaluate(() => {
        if (window.__stub.scanState === "running" && document.getElementById("progress")) {
            document.getElementById("progress").classList.add("running");
        }
    });
}

(async () => {
    const browser = await chromium.launch({ headless: true });

    /* ---- 场景 1：冷启动（无会话、无保护键、health ready）→ start POST 恰 1 次 ----
       会话数 0 + 无 sessionStorage 键 → 自动发起恰一次。
       ⚠️ 不能 reset()：自动扫描链在页面加载即触发，reset 会清掉计数。 */
    {
        const { page, errs } = await newPage(browser, false);
        await waitAutoStartSettled(page);
        const counts = await page.evaluate(() => ({
            start: window.__stub.startCount,
            key: (() => { try { return sessionStorage.getItem("pds_auto_started_v1"); } catch (e) { return null; } })(),
        }));
        check("冷启动（无会话）→ /api/fullscan/start POST 恰 1 次", counts.start === 1, "startCount=" + counts.start);
        check("冷启动 → 保护键已写入 pds_auto_started_v1", counts.key === "1", "key=" + counts.key);
        RESULT.consoleErrors = RESULT.consoleErrors.concat(errs);
        await page.close();
    }

    /* ---- 场景 2：刷新（sessionStorage 保持）→ 不重复触发，恢复轮询态 ----
       保护键仍在 → autoStartEnabled=false → 0 次 start */
    {
        const { page, errs } = await newPage(browser, true); // 预置保护键 = 模拟刷新后的会话
        await page.evaluate(() => { window.__stub.reset(); });
        await waitAutoStartSettled(page);
        const start = await page.evaluate(() => window.__stub.startCount);
        check("刷新（保护键保持）→ 不重复触发（start POST = 0）", start === 0, "startCount=" + start);
        RESULT.consoleErrors = RESULT.consoleErrors.concat(errs);
        await page.close();
    }

    /* ---- 场景 3：扫描中刷新 → 恢复运行态，不重发 start ----
       后端 running=true（桩初始 scanState=running）→ tryAutoStartFullscan 不发起 */
    {
        const { page, errs } = await newPage(browser, false);
        await page.evaluate(() => { window.__stub.reset(); window.__stub.scanState = "running"; });
        await waitAutoStartSettled(page);
        const r = await page.evaluate(() => ({
            start: window.__stub.startCount,
            running: (document.getElementById("progress") || {}).classList ?
                document.getElementById("progress").classList.contains("running") : false,
        }));
        check("扫描中刷新 → 恢复运行态（progress.running）", r.running === true, JSON.stringify(r));
        check("扫描中刷新 → 不重发 start POST", r.start === 0, "startCount=" + r.start);
        RESULT.consoleErrors = RESULT.consoleErrors.concat(errs);
        await page.close();
    }

    /* ---- 场景 4：Everything 未就绪 → 不自动发起 ----
       门控不进入 ready 分支 → 无 pds:auto-scan-start 派发 → 0 次 start */
    {
        const { page, errs } = await newPage(browser, false);
        await page.evaluate(() => { window.__stub.reset(); window.__stub.healthReady = false; });
        await waitAutoStartSettled(page);
        const start = await page.evaluate(() => window.__stub.startCount);
        check("Everything 未就绪 → 不自动发起（start POST = 0）", start === 0, "startCount=" + start);
        RESULT.consoleErrors = RESULT.consoleErrors.concat(errs);
        await page.close();
    }

    /* ---- 场景 5：当日已有快照会话 → 不自动发起（防同日重复全扫） ---- */
    {
        const { page, errs } = await newPage(browser, false);
        await page.evaluate(() => { window.__stub.reset(); window.__stub.hasTodaySession = true; });
        await waitAutoStartSettled(page);
        const start = await page.evaluate(() => window.__stub.startCount);
        check("当日已有快照会话 → 不自动发起（start POST = 0）", start === 0, "startCount=" + start);
        RESULT.consoleErrors = RESULT.consoleErrors.concat(errs);
        await page.close();
    }

    /* ---- 场景 6：自动保存恰一次（完成边沿 save POST = 1） ----
       冷启动自动扫描（start=1）→ 完成（scanState=done）→ maybePromptSave → saveSnapshot(true)。
       ⚠️ 不 reset：start 计数来自冷启动本身（=1），save 计数为完成边沿新增（=1）。 */
    {
        const { page, errs } = await newPage(browser, false);
        await waitAutoStartSettled(page);
        await page.evaluate(() => { window.__stub.scanState = "done"; });
        // 等完成态渲染触发自动保存
        await page.waitForFunction(() => window.__stub.saveCount >= 1, { timeout: 8000 }).catch(() => {});
        await wait(400);
        const counts = await page.evaluate(() => ({ save: window.__stub.saveCount, start: window.__stub.startCount }));
        check("自动保存恰一次（/api/save POST = 1）", counts.save === 1, "saveCount=" + counts.save);
        check("自动保存场景 start 恰 1 次", counts.start === 1, "startCount=" + counts.start);
        RESULT.consoleErrors = RESULT.consoleErrors.concat(errs);
        await page.close();
    }

    /* ---- 场景 7：自动保存失败 → 错误可见 + 手动保存入口恢复 ----
       saveFail=true → saveSnapshot 返回 false → save-prompt 恢复可见（手动「立即保存」入口）。
       ⚠️ 不 reset：start 计数来自冷启动（=1）；save 计数为失败的那一次（=1）。 */
    {
        const { page, errs } = await newPage(browser, false);
        await page.evaluate(() => { window.__stub.saveFail = true; });
        await waitAutoStartSettled(page);
        await page.evaluate(() => { window.__stub.scanState = "done"; });
        await page.waitForFunction(() => window.__stub.saveCount >= 1, { timeout: 8000 }).catch(() => {});
        await wait(600);
        const r = await page.evaluate(() => ({
            saveCount: window.__stub.saveCount,
            promptVisible: (() => { const p = document.getElementById("save-prompt"); return p && !p.classList.contains("hidden"); })(),
            errorToast: Array.from(document.querySelectorAll("#toast-container .toast")).some((t) => t.textContent.indexOf("保存失败") !== -1 || t.textContent.indexOf("模拟错误") !== -1),
        }));
        check("自动保存失败 → 错误 toast 可见", r.errorToast === true, JSON.stringify(r));
        check("自动保存失败 → 手动保存入口恢复（save-prompt 可见）", r.promptVisible === true, JSON.stringify(r));
        RESULT.consoleErrors = RESULT.consoleErrors.concat(errs);
        await page.close();
    }

    fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(RESULT, null, 2), "utf-8");
    console.log("== u58_auto_scan_probe ==");
    console.log("result=" + path.join(OUT, "result.json"));
    if (RESULT.consoleErrors.length) {
        console.log("console errors:\n" + RESULT.consoleErrors.join("\n"));
    }
    await browser.close();
    const failed = RESULT.checks.some((c) => !c.pass) || RESULT.consoleErrors.length > 0;
    process.exit(failed ? 1 : 0);
})();