/* ============================================================
   阶段 A（R0）· 问题复现探针 u50_repro_probe.mjs（新建，门禁 §肆）
   - 覆盖手册贰章「先复现」五项：2-2 视图残留 / 2-11 主题扩散铺满 /
     2-6 扫描动画回跳 / 2-9 停止反馈时间线 / 2-14 导出错误路径；
   - 双模式：
     · 桩态（默认）：addInitScript 覆写 fetch → 确定性断言 + 关键帧截图序列
       （动画期间每 100ms 一帧，供 GPT-5.6 Luna 识图判读）；
     · 真机（--with-data）：连真服务器（--base），真实渲染栈采样；
       数据未就绪（Everything 分钟级）按「请求发起态」口径记录并继续，
       不让测试无限等待（G8 纪律）。
   - 证据输出：--out 目录（默认 %TEMP%\u50_repro）：
     · view-0/100/500/800ms.png 三视图连点关键帧
     · theme-diffuse-*.png 主题扩散关键帧（每 100ms）
     · scan-anim-*.png 扫描环动画关键帧（每 100ms × 3s）
     · export-error-*.png 导出错误路径截图
     · result.json 全部断言与采样数据（结构化）
   - 录屏：--video 时对扫描动画段启动 recordVideo（webm 入 out/video/）。
   - 运行：node scripts/dev/u50_repro_probe.mjs [--base http://127.0.0.1:5000/]
            [--out <目录>] [--with-data] [--video] [--steps view|theme|scan|stop|export|all]
   - 纪律：探针只读 UI（不 POST 真实扫描/保存/删除——桩态全覆盖；
     --with-data 下除浏览/状态轮询外零写操作）。
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
const OUT = path.resolve(arg("out", path.join(os.tmpdir(), "u50_repro")));
const WITH_DATA = process.argv.indexOf("--with-data") >= 0;
const VIDEO = process.argv.indexOf("--video") >= 0;
const STEPS = new Set(
    arg("steps", "all").split(",").map((s) => s.trim()).filter(Boolean)
);
const ALL_STEPS = ["view", "theme", "scan", "stop", "export"];

fs.mkdirSync(OUT, { recursive: true });
const RESULT = {
    meta: {
        base: BASE, out: OUT, withData: WITH_DATA, video: VIDEO,
        node: process.version, startedAt: new Date().toISOString(),
        chromium: "playwright-bundled",
    },
    sections: {},
};

/* ---------------- 桩态 fetch（同 u31 约定；覆盖全部所需接口） ---------------- */
const STUB_FN = `
window.__stub = {
  scanState: "idle",       // idle | running | done | aborted
  exportReady: false,
  stopLatencyMs: 50,
  fetchLog: [],
  scanVersion: 1,
};
window.fetch = function (url, options) {
  options = options || {};
  const key = (options.method || "GET").toUpperCase() + " " + String(url).split("?")[0];
  window.__stub.fetchLog.push(key);
  const json = (o, s) => Promise.resolve({ ok: (s || 200) < 400, status: s || 200,
    json: () => Promise.resolve(JSON.parse(JSON.stringify(o))) });
  if (key === "GET /api/health") return json({ ok: true, ready: true, dll: "stub-dll", message: "Everything 已就绪" });
  if (key === "GET /api/settings") return json({ ok: true, settings: { auto_save: false, last_roots: ["D:\\\\", "C:\\\\"] }, data_dir: "C:\\\\stub\\\\data", snapshots_dir: "C:\\\\stub\\\\snapshots" });
  if (key === "POST /api/settings") return json({ ok: true, settings: {} });
  if (key === "POST /api/browse") {
    const p = options.body ? JSON.parse(options.body).path : null;
    if (p === "D:\\\\big") return json({ ok: true, root: "D:\\\\big", parent: "D:\\\\", directories: [ { name: "bigdir", path: "D:\\\\big\\\\bigdir", is_dir: true, size: 500, size_human: "500 B" } ], files: [], total_dirs: 1, total_files: 0 });
    return json({ ok: true, root: "D:\\\\", parent: null,
      directories: [ { name: "data", path: "D:\\\\data", is_dir: true, size: 12000, size_human: "11.72 KB" }, { name: "docs", path: "D:\\\\docs", is_dir: true, size: 4000, size_human: "3.91 KB" } ],
      files: [ { name: "pagefile.sys", path: "D:\\\\pagefile.sys", is_dir: false, size: 999999, size_human: "976.56 KB" }, { name: "readme.txt", path: "D:\\\\readme.txt", is_dir: false, size: 100, size_human: "100 B" } ],
      total_dirs: 2, total_files: 2 });
  }
  if (key === "GET /api/fullscan/status") {
    const s = window.__stub.scanState;
    if (s === "idle") return json({ ok: true, status: { running: false, roots: ["C:\\\\", "D:\\\\"], roots_done: 0, roots_total: 2, current_root: null, error: null, result_ready: false, save_ready: false, progress_pct: 0, scan_version: window.__stub.scanVersion, stop_requested: false, stop_reason: null } });
    if (s === "done") return json({ ok: true, status: { running: false, roots: ["C:\\\\", "D:\\\\"], roots_done: 2, roots_total: 2, current_root: null, error: null, result_ready: true, save_ready: true, progress_pct: 100, scan_version: window.__stub.scanVersion, stop_requested: false, stop_reason: null } });
    if (s === "aborted") return json({ ok: true, status: { running: false, roots: ["C:\\\\", "D:\\\\"], roots_done: 1, roots_total: 2, current_root: null, error: null, result_ready: false, save_ready: false, progress_pct: 50, scan_version: window.__stub.scanVersion, stop_requested: true, stop_reason: "user" } });
    return json({ ok: true, status: { running: true, roots: ["C:\\\\", "D:\\\\"], roots_done: 0, roots_total: 2, current_root: "C:\\\\", error: null, result_ready: false, save_ready: false, progress_pct: 40, scan_version: window.__stub.scanVersion, stop_requested: false, stop_reason: null } });
  }
  if (key === "POST /api/fullscan/start") { window.__stub.scanState = "running"; window.__stub.scanVersion++; return json({ ok: true, message: "全量扫描任务已提交，后台执行中" }); }
  if (key === "POST /api/fullscan/stop") {
    return new Promise((resolve) => setTimeout(() => {
      window.__stub.scanState = "aborted";
      resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, stopped: true, status: { running: false, roots: ["C:\\\\", "D:\\\\"], roots_done: 1, roots_total: 2, current_root: null, error: null, result_ready: false, save_ready: false, progress_pct: 50, scan_version: window.__stub.scanVersion, stop_requested: true, stop_reason: "user" } }) });
    }, window.__stub.stopLatencyMs));
  }
  if (key === "GET /api/snapshots") return json({ ok: true, sessions: [
    { session_id: "s-cur", auto: true, machine_guid: "3f2a1c9d", created_at: "2026-09-02T15:41:00", roots: { "C:\\\\": { root: "C:\\\\", snapshot: "C.snap.gz", snapshot_path: "C:\\\\stub\\\\C.snap.gz", skipped: false }, "D:\\\\": { root: "D:\\\\", snapshot: "D.snap.gz", snapshot_path: "C:\\\\stub\\\\D.snap.gz", skipped: false } } },
    { session_id: "s-23h", auto: false, machine_guid: "3f2a1c9d", created_at: "2026-09-01T16:41:00", roots: { "C:\\\\": { root: "C:\\\\", snapshot: "C.snap.gz", snapshot_path: "C:\\\\stub\\\\C23.snap.gz", skipped: false }, "D:\\\\": { root: "D:\\\\", snapshot: "D.snap.gz", snapshot_path: "C:\\\\stub\\\\D23.snap.gz", skipped: false } } },
    { session_id: "s-25h", auto: false, machine_guid: "3f2a1c9d", created_at: "2026-09-01T14:41:00", roots: { "C:\\\\": { root: "C:\\\\", snapshot: "C.snap.gz", snapshot_path: "C:\\\\stub\\\\C25.snap.gz", skipped: false }, "D:\\\\": { root: "D:\\\\", snapshot: "D.snap.gz", snapshot_path: "C:\\\\stub\\\\D25.snap.gz", skipped: false } } },
    { session_id: "s-8d", auto: false, machine_guid: "3f2a1c9d", created_at: "2026-08-25T15:41:00", roots: { "C:\\\\": { root: "C:\\\\", snapshot: "C.snap.gz", snapshot_path: "C:\\\\stub\\\\C8.snap.gz", skipped: false }, "D:\\\\": { root: "D:\\\\", snapshot: "D.snap.gz", snapshot_path: "C:\\\\stub\\\\D8.snap.gz", skipped: false } } },
    { session_id: "s-x", auto: false, machine_guid: "3f2a1c9d", created_at: "2026-09-02T13:41:00", roots: { "E:\\\\": { root: "E:\\\\", snapshot: "E.snap.gz", snapshot_path: "C:\\\\stub\\\\E.snap.gz", skipped: false } } },
  ], count: 5 });
  if (key === "POST /api/compare") return json({ ok: true, report: { root: "D:\\\\", total_baseline: 16000, total_current: 15990, delta_total: -10, truncated: false, legacy_count: 0, rows: [ { path: "D:\\\\data", baseline: 12000, current: 11990, delta: -10, growth_pct: -0.08, removed: false, added: false } ] } });
  if (key === "GET /api/overview") return json({ ok: true, ready: true, roots: [ { root: "D:\\\\", total: 4800000, total_human: "4.58 MB", index_ready: true, index_valid: true, directories: [ { name: "data", path: "D:\\\\data", size: 3000000, size_human: "2.86 MB" } ], files: [], directory_count: 2, file_count: 2, record_count: 4, completed_at: "2026-08-24T10:00:00" } ], completed_at: "2026-08-24T10:00:00" });
  if (key === "POST /api/save") return json({ ok: true, message: "保存完成", session: { roots: {} }, skipped: false });
  if (key === "POST /api/save/undo") return json({ ok: true, message: "已撤销", session_id: "s-cur", deleted: [], undeleted: [] });
  if (key === "POST /api/open-path") return json({ ok: true, launched: true, message: "ok" });
  if (key === "GET /api/export") {
    if (!window.__stub.exportReady) return json({ ok: false, error: "暂无可导出的全量扫描结果，请先完成全量扫描" }, 404);
    const fmt = /format=(csv|json)/.exec(String(url)) && RegExp.$1;
    const body = fmt === "json" ? JSON.stringify({ ok: true }) : "name,size\\nreadme.txt,100\\n";
    return Promise.resolve({ ok: true, status: 200, headers: { "content-type": fmt === "json" ? "application/json" : "text/csv; charset=utf-8-sig", "content-disposition": "attachment; filename=report." + fmt }, text: () => Promise.resolve(body), json: () => Promise.resolve({ ok: true }) });
  }
  return json({ ok: true });
};
`;

/* ---------------- 工具 ---------------- */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
/* name 为文件名（不含后缀）；统一补 .png（修复：调用方曾传带 .png 名导致 .png.png） */
const shot = (page, name) =>
    page.screenshot({ path: path.join(OUT, String(name).replace(/\.png$/i, "") + ".png"), fullPage: false });
async function installWait(page) {
    await page.evaluate((src) => { window.__wait = eval("(" + src + ")"); }, `
      (fn, timeout) => new Promise((resolve) => {
        const end = Date.now() + (timeout || 15000);
        const tick = () => { if (fn()) resolve(true); else if (Date.now() > end) resolve(fn()); else setTimeout(tick, 100); };
        tick();
      })`);
}
/* 每 100ms 关键帧序列（供 Luna 判读；n 帧） */
async function keyframes(page, name, n, gapMs = 100) {
    const files = [];
    for (let i = 0; i < n; i++) {
        const f = `${name}-${String(i).padStart(3, "0")}.png`;
        await shot(page, f);
        files.push(f);
        if (i < n - 1) await wait(gapMs);
    }
    return files;
}

async function newStubPage(browser) {
    const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
    const errs = [];
    page.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text()); });
    page.on("pageerror", (e) => errs.push("pageerror: " + e.message));
    await page.addInitScript(() => { try { localStorage.setItem("pds_onboarding_dismissed_v1", "1"); } catch (e) {} });
    await page.addInitScript(STUB_FN);
    await page.goto(BASE, { waitUntil: "load" });
    await installWait(page);
    const stubOk = await page.evaluate(() => typeof window.__stub === "object" && String(window.fetch).indexOf("__stub") !== -1).catch(() => false);
    if (!stubOk) throw new Error("桩态 fetch 未接管（防真实后端副作用，中止）");
    return { page, errs };
}

/* ---------------- §1 三视图快速连点（2-2 视图残留） ---------------- */
async function sectionView(browser) {
    const { page, errs } = await newStubPage(browser);
    const out = { clickTimes: [], shots: [], hiddenAt: {}, residualDetected: false, notes: [] };
    // 等待浏览数据渲染（treemap 首帧）
    await page.waitForFunction(() => {
        const w = document.getElementById("treemap-wrap");
        return w && !w.hasAttribute("hidden") && w.querySelectorAll("canvas").length > 0;
    }, { timeout: 15000 }).catch(() => {});
    out.initial = await page.evaluate(() => ({
        treemapHidden: document.getElementById("treemap-wrap").hasAttribute("hidden"),
        tableHidden: document.getElementById("table-wrap").hasAttribute("hidden"),
        canvas: document.querySelectorAll("#treemap-wrap canvas").length,
        treemapActive: (document.getElementById("btn-view-treemap") || {}).classList
            ? document.getElementById("btn-view-treemap").classList.contains("btn-primary") : null,
    }));
    // 快速连点序列（三视图来回 8 击，无中间等待——复现「快速切换」）
    const seq = ["ranking", "table", "treemap", "ranking", "table", "treemap", "ranking", "table"];
    const t0 = Date.now();
    for (const m of seq) {
        await page.click("#btn-view-" + m, { timeout: 3000 }).catch(() => out.notes.push("click fail: " + m));
        out.clickTimes.push(Date.now() - t0);
    }
    // 关键帧 0/100/500/800ms
    out.shots.push("view-000.png"); await shot(page, "view-000");
    await wait(100); out.shots.push("view-100.png"); await shot(page, "view-100");
    await wait(400); out.shots.push("view-500.png"); await shot(page, "view-500");
    await wait(300); out.shots.push("view-800.png"); await shot(page, "view-800");
    // 终态断言：当前视图按钮高亮、另一容器 hidden、canvas 不残留
    out.final = await page.evaluate(() => {
        const tw = document.getElementById("treemap-wrap");
        const tb = document.getElementById("table-wrap");
        const active = (id) => (document.getElementById(id) || {}).classList &&
            document.getElementById(id).classList.contains("btn-primary");
        const tableActive = active("btn-view-table");
        const rankingActive = active("btn-view-ranking");
        const treemapActive = active("btn-view-treemap");
        const mode = tableActive ? "table" : rankingActive ? "ranking" : treemapActive ? "treemap" : null;
        return {
            mode,
            treemapHidden: tw.hasAttribute("hidden"),
            tableHidden: tb.hasAttribute("hidden"),
            canvas: document.querySelectorAll("#treemap-wrap canvas").length,
            canvasPainted: (() => { // canvas 是否仍实际绘制（残留检测：非 0 且未 hidden 却有 canvas 动画）
                const c = tw.querySelector("canvas");
                if (!c) return false;
                const ctx = c.getContext && (c.getContext("2d"));
                return !!ctx;
            })(),
            viewAreaChildren: document.getElementById("view-area").children.length,
        };
    });
    out.hiddenAt = {
        after800_treemapHidden: out.final.treemapHidden,
        after800_tableHidden: out.final.tableHidden,
    };
    // 残留判定：终态非 treemap 时 treemap-wrap 必须 hidden；未 hidden 即残留
    out.residualDetected = out.final.mode !== "treemap" && !out.final.treemapHidden;
    out.consoleErrors = errs;
    await page.close();
    return out;
}

/* ---------------- §2 主题快速连点（2-11 扩散铺满 + 2-15 扩散中心） ---------------- */
async function sectionTheme(browser) {
    const { page, errs } = await newStubPage(browser);
    const out = { themeBefore: null, themeAfter: null, diffusionShots: [], clickCoords: null, radioCenter: null, vtSupported: null };
    await page.waitForFunction(() => !!document.getElementById("btn-theme"), { timeout: 15000 });
    out.themeBefore = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
    out.vtSupported = await page.evaluate(() => typeof document.startViewTransition === "function");
    // 快速连点 3 击（间隔 ~60ms）
    const box = await page.locator("#btn-theme").boundingBox();
    out.clickCoords = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
    for (let i = 0; i < 3; i++) {
        await page.mouse.click(out.clickCoords.x, out.clickCoords.y);
        await wait(60);
    }
    // 扩散关键帧（点击后每 100ms × 7）
    out.diffusionShots = await keyframes(page, "theme-diffuse", 7, 100);
    out.themeAfter = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
    // 2-15：设置弹窗主题单选扩散中心 = 控件 rect 中心（点偏离处也以中心扩散——已知根因）
    await page.click("#btn-settings");
    await wait(300);
    const radio = await page.locator("#setting-theme-dark").boundingBox();
    out.radioCenter = radio && { x: Math.round(radio.x + radio.width / 2), y: Math.round(radio.y + radio.height / 2) };
    if (radio) {
        // 点击偏离中心 +12px 的位置
        await page.mouse.click(Math.round(radio.x + radio.width / 2 + 12), Math.round(radio.y + radio.height / 2));
        await wait(60);
        out.settingsDiffusionShots = await keyframes(page, "theme-settings-diffuse", 5, 100);
    }
    out.consoleErrors = errs;
    await page.close();
    return out;
}

/* ---------------- §3 扫描动画（2-6 回跳候选：donut-spin 450°/回跳 90°） ---------------- */
async function sectionScan(browser) {
    const { page, errs } = await newStubPage(browser);
    const out = { angles: [], jumps: [], keyframes: [], animInfo: null, cycleMs: null };
    await page.waitForFunction(() => !!document.getElementById("btn-fullscan"), { timeout: 15000 });
    // 启动扫描（桩态 running）
    await page.evaluate(() => { window.__stub.scanState = "running"; });
    await page.click("#btn-fullscan");
    await page.waitForFunction(() => {
        const d = document.querySelector(".donut-box.is-indet .donut-indet");
        return !!d;
    }, { timeout: 15000 }).catch(() => {});
    out.animInfo = await page.evaluate(() => {
        const el = document.querySelector(".donut-indet");
        if (!el) return null;
        const cs = getComputedStyle(el);
        return { animationName: cs.animationName, duration: cs.animationDuration, iteration: cs.animationIterationCount, transform: cs.transform };
    });
    // 每 100ms 采样 transform 角度 × 3s（覆盖 ≥2 个 1.2s 周期）
    for (let i = 0; i < 30; i++) {
        const ang = await page.evaluate(() => {
            const el = document.querySelector(".donut-indet");
            if (!el) return null;
            const m = getComputedStyle(el).transform.match(/matrix\(([^)]+)\)/);
            if (!m) return null;
            const p = m[1].split(",").map(Number);
            return Math.round(Math.atan2(p[1], p[0]) * 180 / Math.PI * 100) / 100;
        });
        out.angles.push({ t: i * 100, deg: ang });
        const f = `scan-anim-${String(i).padStart(3, "0")}.png`;
        await shot(page, f);
        out.keyframes.push(f);
        // 环形区域特写（#overview-donut  bounding box，放大弧段供识图判读）
        const ring = await page.evaluate(() => {
            const el = document.querySelector("#overview-donut");
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { x: r.x, y: r.y, width: r.width, height: r.height };
        }).catch(() => null);
        if (ring && ring.width > 10) {
            const pad = { x: Math.max(0, ring.x - 12), y: Math.max(0, ring.y - 12),
                          width: ring.width + 24, height: ring.height + 24 };
            const rf = `scan-ring-${String(i).padStart(3, "0")}.png`;
            await page.screenshot({ path: path.join(OUT, rf), clip: pad });
            out.ringShots = out.ringShots || [];
            out.ringShots.push(rf);
        }
        await wait(100);
    }
    /* 回跳检测：相邻帧角度突变 > 45°（正常匀速 360°/1.2s ≈ 30°/100ms） */
    const a = out.angles.filter((x) => x.deg !== null);
    for (let i = 1; i < a.length; i++) {
        let d = a[i].deg - a[i - 1].deg;
        if (d > 180) d -= 360;
        if (d < -180) d += 360;
        if (Math.abs(d) > 45) out.jumps.push({ from: a[i - 1], to: a[i], deltaDeg: Math.round(d * 100) / 100 });
    }
    out.cycleMs = out.animInfo && /ms/.test(out.animInfo.duration)
        ? parseInt(out.animInfo.duration, 10) : null;
    out.consoleErrors = errs;
    await page.close();
    return out;
}

/* ---------------- §4 停止反馈时间线（2-9） ---------------- */
async function sectionStop(browser) {
    const { page, errs } = await newStubPage(browser);
    const out = { timeline: [] };
    await page.waitForFunction(() => !!document.getElementById("btn-fullscan"), { timeout: 15000 });
    await page.evaluate(() => { window.__stub.scanState = "running"; window.__stub.stopLatencyMs = 50; });
    await page.click("#btn-fullscan");
    await page.waitForFunction(() => !document.getElementById("btn-stop-scan").hidden, { timeout: 15000 });
    const tClick = Date.now();
    out.timeline.push({ event: "click-stop", ms: 0 });
    // 监听 toast（完成/中止边沿 toast）
    const toastSeen = page.evaluate(() => new Promise((resolve) => {
        const obs = new MutationObserver(() => {
            const t = document.querySelector("#toast-container");
            if (t && t.textContent && t.textContent.length > 0) resolve(t.textContent.trim());
        });
        obs.observe(document.querySelector("#toast-container"), { childList: true, subtree: true, characterData: true });
        setTimeout(() => { obs.disconnect(); resolve(null); }, 5000);
    }));
    await page.click("#btn-stop-scan");
    // 轮询状态文案变化（正在停止… → 已停止）
    await page.waitForFunction(() => {
        const t = document.getElementById("fullscan-status-text");
        return t && /已停止/.test(t.textContent);
    }, { timeout: 15000 });
    out.timeline.push({ event: "status-aborted-shown", ms: Date.now() - tClick });
    const toastText = await toastSeen;
    out.timeline.push({ event: "toast-seen", ms: Date.now() - tClick, text: toastText });
    out.finalStatus = await page.evaluate(() => ({
        text: document.getElementById("fullscan-status-text").textContent,
        stopHidden: document.getElementById("btn-stop-scan").hidden,
        startDisabled: document.getElementById("btn-fullscan").disabled,
        saveDisabled: document.getElementById("btn-save").disabled,
    }));
    out.consoleErrors = errs;
    await page.close();
    return out;
}

/* ---------------- §5 导出错误路径（2-14） ---------------- */
async function sectionExport(browser) {
    const { page, errs } = await newStubPage(browser);
    const out = { errorPath: null, readyPath: null, shots: [] };
    await page.waitForFunction(() => !!document.getElementById("btn-export-csv"), { timeout: 15000 });
    // 错误路径：无全量结果（exportReady=false）→ 点击导出 CSV → 新页/新 tab 出现错误 JSON
    const popupP = page.waitForEvent("popup", { timeout: 8000 }).catch(() => null);
    await page.click("#btn-export-csv");
    const popup = await popupP;
    if (popup) {
        await popup.waitForLoadState("domcontentloaded").catch(() => {});
        const txt = await popup.evaluate(() => document.body.innerText).catch(() => "");
        const url = popup.url();
        out.errorPath = { url, bodySnippet: txt.slice(0, 200) };
        await popup.screenshot({ path: path.join(OUT, "export-error-popup.png") });
        out.shots.push("export-error-popup.png");
        await popup.close();
    } else {
        out.errorPath = { url: null, note: "无 popup（window.open 可能被拦截）" };
    }
    await shot(page, "export-error-main.png");
    out.shots.push("export-error-main.png");
    // 就绪路径：exportReady=true → 导出下载（断言 filename/content-type）
    await page.evaluate(() => { window.__stub.exportReady = true; });
    const dl = page.waitForEvent("download", { timeout: 8000 }).catch(() => null);
    await page.click("#btn-export-csv");
    const download = await dl;
    if (download) {
        out.readyPath = { suggested: download.suggestedFilename() };
    } else {
        // window.open 导航回退：新 tab 直接显示 CSV
        const popup2 = page.waitForEvent("popup", { timeout: 8000 }).catch(() => null);
        await page.click("#btn-export-csv");
        const p2 = await popup2;
        if (p2) {
            await p2.waitForLoadState("domcontentloaded").catch(() => {});
            out.readyPath = { popupBody: (await p2.evaluate(() => document.body.innerText).catch(() => "")).slice(0, 100) };
            await p2.close();
        } else {
            out.readyPath = { note: "无 download 事件亦无 popup" };
        }
    }
    out.consoleErrors = errs;
    await page.close();
    return out;
}

/* ---------------- 主流程 ---------------- */
(async () => {
    console.log("== u50_repro_probe ==");
    console.log("base=" + BASE + " out=" + OUT + " withData=" + WITH_DATA + " video=" + VIDEO + " steps=" + arg("steps", "all"));
    console.log("node=" + process.version + " started=" + RESULT.meta.startedAt);

    const launchOpts = { headless: true };
    if (VIDEO) launchOpts.recordVideo = { dir: path.join(OUT, "video"), size: { width: 1366, height: 768 } };
    const browser = await chromium.launch(launchOpts);

    const doStep = async (name, fn) => {
        if (!ALL_STEPS.includes(name)) return;
        if (!STEPS.has("all") && !STEPS.has(name)) return;
        console.log("-- 段 " + name + " --");
        try {
            const r = await fn(browser);
            RESULT.sections[name] = r;
            console.log("   完成（见 result.json）");
        } catch (e) {
            RESULT.sections[name] = { error: String(e && e.message || e) };
            console.log("   异常: " + e);
        }
    };

    await doStep("view", sectionView);
    await doStep("theme", sectionTheme);
    await doStep("scan", sectionScan);
    await doStep("stop", sectionStop);
    await doStep("export", sectionExport);

    RESULT.meta.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(RESULT, null, 2), "utf-8");
    console.log("\nresult.json 已写入: " + path.join(OUT, "result.json"));
    await browser.close();
    process.exit(0);
})();