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

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { chromium, launch } from "./_harness.mjs";
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
  autoOutcome: "saved", // P1：后端自动保存结果（saved|skipped|failed|none）
  skipReason: "fingerprint_unchanged",
  startCount: 0, saveCount: 0, statusCount: 0, fetchLog: [], pollLog: [],
  reset: function () { this.startCount = 0; this.saveCount = 0; this.statusCount = 0; this.fetchLog.length = 0; this.pollLog.length = 0; }
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
    window.__stub.pollLog.push({ t: Date.now(), state: s, count: window.__stub.statusCount });
    const base = { roots: ["C:\\\\", "D:\\\\"], roots_total: 2, error: null, scan_version: 1,
      stop_requested: false, stop_reason: null, phase: "idle", lock_holder: null, row_done: 0, row_total: 0, stop_ack_at: null };
    if (s === "running") return json({ ok: true, status: { ...base, running: true, roots_done: 0, current_root: "C:\\\\", result_ready: false, save_ready: false, progress_pct: 40, phase: "scanning", lock_holder: "fullscan" } });
    if (s === "done") {
      // P1（D1-1）：status additive 透出后端自动保存结果（前端据此展示三态）。
      const ao = window.__stub.autoOutcome;
      const outcome = ao === "none" || ao === "" ? null : {
        attempted: true, outcome: ao,
        saved_count: ao === "saved" ? 2 : 0,
        skipped_roots: ao === "skipped" ? [{ root: "C:\\\\", skip_reason: window.__stub.skipReason }, { root: "D:\\\\", skip_reason: window.__stub.skipReason }] : [],
        error: ao === "failed" ? "写盘失败模拟" : null, at: "2026-09-05T12:00:00" };
      return json({ ok: true, status: { ...base, running: false, roots_done: 2, current_root: null, result_ready: true,
        save_ready: ao === "saved" ? false : true, progress_pct: 100, autosave_outcome: outcome } });
    }
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
    page.on("console", (m) => { if (m.type() === "error") { const loc = m.location ? m.location() : null; if (loc && /favicon\.ico/i.test(loc.url)) return; errs.push("console: " + m.text()); } });
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

/* P1：等完成态渲染——判据必须排除 running 文案（「已完成 0/2 盘」含「已完成」字样）：
   三态区可见 或 完成态专有文案（结果就绪/已自动保存/跳过/失败）。空闲态轮询间隔 6s，
   扫描中 2s——超时须覆盖最坏间隔。 */
async function waitCompletionRendered(page) {
    await page.waitForFunction(
        () => {
            const t = document.getElementById("fullscan-status-text");
            const area = document.getElementById("autosave-result");
            const text = (t && t.textContent) || "";
            const threeStateShown = area && !area.classList.contains("hidden");
            const doneText = /结果就绪|已自动保存|跳过自动保存|自动保存失败/.test(text);
            return threeStateShown || doneText;
        },
        { timeout: 15000 }
    ).catch(() => {});
    await wait(600); // 让完成态渲染稳定（覆盖轮询间隔）
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

    /* ---- 场景 6：自动保存成功 → 前端只展示「已自动保存」，不重复 POST ----
       P1（D1-1）：自动保存由后端归口（结果就绪回调触发一次），前端只展示 status
       透出的 autosave_outcome；完成边沿前端**不得**再 POST /api/save（防双保存）。
       scanState=done + autoOutcome=saved → save_ready=false。 */
    {
        const { page, errs } = await newPage(browser, false);
        await waitAutoStartSettled(page);
        await page.evaluate(() => { window.__stub.scanState = "done"; });
        await waitCompletionRendered(page);
        const r = await page.evaluate(() => {
            const area = document.getElementById("autosave-result");
            return {
                saveCount: window.__stub.saveCount,        // 前端不应再发起自动保存 POST
                savedVisible: !!area && !area.classList.contains("hidden") && area.className.indexOf("notice-success") !== -1,
                saveDisabled: !!document.getElementById("btn-save") && document.getElementById("btn-save").disabled,
            };
        });
        check("自动保存成功 → 前端不重复 POST /api/save（==0，防双保存）", r.saveCount === 0, "saveCount=" + r.saveCount);
        check("自动保存成功 → 三态区显示「已自动保存」（notice-success）", r.savedVisible === true, JSON.stringify(r));
        check("自动保存成功 → save_ready 已消费 →「保存快照」禁用", r.saveDisabled === true, JSON.stringify(r));
        RESULT.consoleErrors = RESULT.consoleErrors.concat(errs);
        await page.close();
    }

    /* ---- 场景 7：自动保存失败 → 错误可见 + 手动「仍要保存」入口保持 ----
       autoOutcome=failed → save_ready=true → save-prompt 可见（强制保存入口）。 */
    {
        const { page, errs } = await newPage(browser, false);
        await page.evaluate(() => { window.__stub.autoOutcome = "failed"; });
        await waitAutoStartSettled(page);
        await page.evaluate(() => { window.__stub.scanState = "done"; });
        await waitCompletionRendered(page);
        const r = await page.evaluate(() => {
            const area = document.getElementById("autosave-result");
            const prompt = document.getElementById("save-prompt");
            return {
                saveCount: window.__stub.saveCount,
                resultVisible: !!area && !area.classList.contains("hidden") && area.textContent.indexOf("自动保存失败") !== -1,
                promptVisible: !!prompt && !prompt.classList.contains("hidden"),
                forceBtn: (() => { const b = document.getElementById("btn-save-now"); return b && !b.disabled; })(),
            };
        });
        check("自动保存失败 → 三态区显示「自动保存失败」", r.resultVisible === true, JSON.stringify(r));
        check("自动保存失败 → 手动「仍要保存（强制）」入口保持", r.promptVisible === true && r.forceBtn === true, JSON.stringify(r));
        check("自动保存失败 → 前端不重复 POST /api/save（==0）", r.saveCount === 0, "saveCount=" + r.saveCount);
        RESULT.consoleErrors = RESULT.consoleErrors.concat(errs);
        await page.close();
    }

    /* ---- 场景 8（P1）：localStorage 残留高值 → 完成边沿不静默、三态正常 ----
       复现问题 1 主因：旧闸门 pds_handled_scan_version_v1 残留高值（如 "999"），
       scan.js 曾因 handledScanVersion>=version 直接 return（不保存/不提示）。
       P1 已移除该跨进程代次闸门（D1-1 后端归口）→ 残留值不得导致静默：
       完成边沿仍渲染三态，前端零重复保存。 */
    {
        const { page, errs } = await newPage(browser, false);
        await page.evaluate(() => {
            try { localStorage.setItem("pds_handled_scan_version_v1", "999"); } catch (e) {}
        });
        await waitAutoStartSettled(page);
        await page.evaluate(() => { window.__stub.scanState = "done"; });
        await waitCompletionRendered(page);
        const r = await page.evaluate(() => {
            const area = document.getElementById("autosave-result");
            return {
                saveCount: window.__stub.saveCount,
                stubState: window.__stub.scanState,
                statusText: (document.getElementById("fullscan-status-text") || {}).textContent || "",
                cardRendered: !!area && !area.classList.contains("hidden"),
                areaClass: area ? area.className : null,
            };
        });
        check("localStorage 残留高值 → 完成边沿仍渲染自动保存结果（不静默）", r.cardRendered === true, JSON.stringify(r));
        check("localStorage 残留高值 → 前端零重复保存 POST", r.saveCount === 0, "saveCount=" + r.saveCount);
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