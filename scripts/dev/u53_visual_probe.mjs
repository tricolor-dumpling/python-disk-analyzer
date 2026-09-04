/* ============================================================
   阶段 B（R1）· u53_visual_probe.mjs（视觉验收场景截图收集）
   - 场景（供 gpt-5.6-luna 判读；全部桩态确定性渲染）：
     · stopping-<vp>.png            B-9：stop_requested && running → 状态栏
       「正在停止…（等待扫描引擎响应）」+ 停止按钮禁用（active 闪烁保持）
     · badge-index-*.png            B-14：source=index → 徽章「来自全量扫描索引」
     · badge-sdk-*.png              B-14：source=sdk → 无缓存徽章（隐藏）
     · badge-scanning-*.png         B-14：source=scanning → 徽章「扫描中」
     · export-success-*.png         B-15：导出成功 toast（Blob 下载后）
     · export-fail-404-*.png        B-15：导出 404 → error toast（不再裸 JSON）
     · export-fail-409-*.png        B-16：导出 409 reason=scanning → toast
   - 运行：node scripts/dev/u53_visual_probe.mjs [--base http://127.0.0.1:5000/]
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
const OUT = path.resolve(arg("out", path.join(os.tmpdir(), "u53_visual")));
fs.mkdirSync(OUT, { recursive: true });

const VP = { w: 1366, h: 768 };

/* 桩 fetch：scanState = idle|running|stopping|done；browseSource 控制 source；
   exportMode 控制 /api/export 响应形态 */
const STUB_FN = `
window.__stub = { scanState: "idle", browseSource: "sdk", exportMode: "ok", fetchLog: [], scanVersion: 1 };
window.fetch = function (url, options) {
  options = options || {};
  const key = (options.method || "GET").toUpperCase() + " " + String(url).split("?")[0];
  window.__stub.fetchLog.push(key);
  const json = (o, s) => Promise.resolve({ ok: (s || 200) < 400, status: s || 200,
    json: () => Promise.resolve(JSON.parse(JSON.stringify(o))) });
  if (key === "GET /api/health") return json({ ok: true, ready: true, dll: "stub-dll", message: "Everything 已就绪", busy: false });
  if (key === "GET /api/settings") return json({ ok: true, settings: { auto_save: false, last_roots: ["D:\\\\", "C:\\\\"] }, data_dir: "C:\\\\stub\\\\data", snapshots_dir: "C:\\\\stub\\\\snapshots" });
  if (key === "POST /api/browse") {
    const src = window.__stub.browseSource;
    const base = { root: "D:\\\\", parent: null,
      directories: [ { name: "data", path: "D:\\\\data", is_dir: true, size: 12000, size_human: "11.72 KB" } ],
      files: [ { name: "readme.txt", path: "D:\\\\readme.txt", is_dir: false, size: 100, size_human: "100 B" } ],
      total_dirs: 1, total_files: 1 };
    if (src === "index") return json({ ...base, source: "index", source_at: "2026-09-03T12:34:00" });
    if (src === "scanning") return json({ ...base, source: "scanning", scanning: true, progress: 40, message: "该盘正在扫描中，完成后即可即时浏览", directories: [], files: [], total_dirs: 0, total_files: 0 });
    return json({ ...base, source: "sdk", source_at: "2026-09-04T10:00:00" });
  }
  if (key === "GET /api/fullscan/status") {
    const s = window.__stub.scanState;
    const mk = (o) => ({ roots: ["C:\\\\", "D:\\\\"], roots_total: 2, error: null, scan_version: window.__stub.scanVersion, lock_holder: null, row_done: 0, row_total: 0, stop_ack_at: null, ...o });
    if (s === "stopping") return json({ ok: true, status: mk({ running: true, roots_done: 0, current_root: "C:\\\\", result_ready: false, save_ready: false, progress_pct: 40, stop_requested: true, stop_reason: "user", phase: "scanning", lock_holder: "fullscan", stop_ack_at: "2026-09-04T10:00:01" }) });
    if (s === "done") return json({ ok: true, status: mk({ running: false, roots_done: 2, current_root: null, result_ready: true, save_ready: true, progress_pct: 100, stop_requested: false, stop_reason: null, phase: "idle" }) });
    return json({ ok: true, status: mk({ running: false, roots_done: 0, current_root: null, result_ready: false, save_ready: false, progress_pct: 0, stop_requested: false, stop_reason: null, phase: "idle" }) });
  }
  if (key === "GET /api/snapshots") return json({ ok: true, sessions: [], count: 0 });
  if (key === "GET /api/overview") return json({ ok: true, ready: false, scanning: false, empty_reason: "no_scan", roots: [] });
  if (key === "GET /api/export") {
    const m = window.__stub.exportMode;
    if (m === "404") return json({ ok: false, error: "暂无可导出的全量扫描结果，请先完成全量扫描" }, 404);
    if (m === "409") return json({ ok: false, error: "扫描进行中，暂无可导出的结果，请等待扫描完成后再导出", reason: "scanning" }, 409);
    const body = "name,size\\nreadme.txt,100\\n";
    // headers 用 Headers 形状（downloadExport 调 resp.headers.get）
    const hdrs = { "content-type": "text/csv; charset=utf-8-sig", "content-disposition": "attachment; filename=report.csv" };
    return Promise.resolve({ ok: true, status: 200, headers: { get: (k) => hdrs[k.toLowerCase()] || null },
      blob: () => Promise.resolve(new Blob([body], { type: "text/csv" })), text: () => Promise.resolve(body), json: () => Promise.resolve({ ok: true }) });
  }
  return json({ ok: true });
};
`;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function newPage(browser) {
    const page = await browser.newPage({ viewport: { width: VP.w, height: VP.h } });
    const errs = [];
    page.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text()); });
    page.on("pageerror", (e) => errs.push("pageerror: " + e.message));
    // 预置引导关闭标记 + 主题偏好（onboarding 弹层会拦截点击）
    await page.addInitScript(() => {
        try { localStorage.setItem("pds_onboarding_dismissed_v1", "1"); } catch (e) {}
        try { localStorage.setItem("pds_theme_v1", "light"); } catch (e) {}
    });
    await page.addInitScript(STUB_FN);
    await page.goto(BASE, { waitUntil: "load", timeout: 20000 }).catch(() => {});
    await page.waitForFunction(() => !!document.getElementById("btn-fullscan"), { timeout: 15000 }).catch(() => {});
    return { page, errs };
}

(async () => {
    const browser = await chromium.launch({ headless: true });
    const RESULT = { meta: { base: BASE, out: OUT, node: process.version }, shots: [], consoleErrors: [] };

    // ---- 场景 1：B-9 停止反馈（stop_requested && running） ----
    {
        const { page, errs } = await newPage(browser);
        await page.evaluate(() => { window.__stub.scanState = "stopping"; });
        await page.waitForFunction(
            () => (document.getElementById("fullscan-status-text") || {}).textContent &&
                document.getElementById("fullscan-status-text").textContent.indexOf("正在停止") !== -1,
            { timeout: 10000 }
        ).catch(() => {});
        await wait(400);
        const f = "stopping-1366x768.png";
        await page.screenshot({ path: path.join(OUT, f) });
        RESULT.shots.push(f);
        // 采样：停止按钮态/状态文案
        RESULT.samples = RESULT.samples || [];
        RESULT.samples.push(await page.evaluate(() => ({
            scene: "stopping",
            statusText: (document.getElementById("fullscan-status-text") || {}).textContent || "",
            stopDisabled: document.getElementById("btn-stop-scan") ? document.getElementById("btn-stop-scan").disabled : null,
            stopActive: document.getElementById("btn-stop-scan") ? document.getElementById("btn-stop-scan").classList.contains("active") : null,
        })));
        RESULT.consoleErrors = RESULT.consoleErrors.concat(errs);
        await page.close();
    }

    // ---- 场景 2：B-14 缓存徽章三场景 ----
    for (const src of ["index", "sdk", "scanning"]) {
        const { page, errs } = await newPage(browser);
        await page.evaluate((s) => { window.__stub.browseSource = s; }, src);
        // 触发浏览（启动已自动浏览首根；强制再一次确保按当前 source）
        await page.evaluate(() => {
            const btn = document.getElementById("btn-browse");
            if (btn) btn.click();
        });
        await page.waitForFunction(
            () => !!document.getElementById("browse-cache-badge") &&
                document.getElementById("browse-cache-badge").classList.contains("hidden") === (window.__stub.browseSource === "sdk"),
            { timeout: 10000 }
        ).catch(() => {});
        await wait(400);
        const f = "badge-" + src + "-1366x768.png";
        await page.screenshot({ path: path.join(OUT, f) });
        RESULT.shots.push(f);
        RESULT.samples.push(await page.evaluate(() => {
            const badge = document.getElementById("browse-cache-badge");
            return {
                scene: "badge-" + window.__stub.browseSource,
                badgeHidden: badge ? badge.classList.contains("hidden") : null,
                badgeText: badge ? badge.textContent.trim() : "",
            };
        }));
        RESULT.consoleErrors = RESULT.consoleErrors.concat(errs);
        await page.close();
    }

    // ---- 场景 3：B-15/B-16 导出 toast（成功/404/409） ----
    for (const mode of ["ok", "404", "409"]) {
        const { page, errs } = await newPage(browser);
        // 导出可用性需要 done 态（isExportAvailable）
        await page.evaluate((m) => { window.__stub.scanState = "done"; window.__stub.exportMode = m; }, mode);
        await page.waitForFunction(() => !document.getElementById("btn-export-csv").disabled, { timeout: 10000 }).catch(() => {});
        await page.evaluate(() => { window.__stub.fetchLog.length = 0; });
        await page.click("#btn-export-csv");
        // 等 toast 出现
        await page.waitForFunction(() => document.querySelectorAll("#toast-container .toast").length > 0, { timeout: 8000 }).catch(() => {});
        await wait(300);
        const f = "export-" + mode + "-1366x768.png";
        await page.screenshot({ path: path.join(OUT, f) });
        RESULT.shots.push(f);
        RESULT.samples.push(await page.evaluate(() => ({
            scene: "export-" + window.__stub.exportMode,
            toastTexts: Array.from(document.querySelectorAll("#toast-container .toast")).map((t) => t.textContent),
        })));
        RESULT.consoleErrors = RESULT.consoleErrors.concat(errs);
        await page.close();
    }

    fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(RESULT, null, 2), "utf-8");
    console.log("== u53_visual_probe ==");
    RESULT.shots.forEach((s) => console.log("shot=" + path.join(OUT, s)));
    (RESULT.samples || []).forEach((s) => console.log("sample=" + JSON.stringify(s)));
    if (RESULT.consoleErrors.length) {
        console.log("console errors:\n" + RESULT.consoleErrors.join("\n"));
        process.exit(1);
    }
    console.log("result=" + path.join(OUT, "result.json"));
    await browser.close();
    process.exit(0);
})();