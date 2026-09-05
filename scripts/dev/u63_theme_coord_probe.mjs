/* ============================================================
   阶段 E（R4/R5）· u63_theme_coord_probe.mjs（E-4 主题扩散中心=真实鼠标坐标验收探针）
   - 覆盖手册 2-15 验收口径（阶段 E 专属纪律）：
     · 顶栏 #btn-theme：按钮内中心/边缘两点——扩散起点应=点击坐标；
     · 设置弹窗 .theme-opt 选项：中心/边缘（+12px 偏离）两点——扩散起点应=点击坐标
       （修复前=控件矩形中心，偏离点也以中心扩散——2-15 确定性根因）；
     · 键盘路径（Tab 聚焦 radio + Space 触发 change，无指针事件）→ 回退控件中心
       （A19 断言面兼容：change 无坐标 → pointFrom 中心）；
     · 程序化 change（smoke A19 同款 dispatchEvent）→ 无坐标 → 控件中心兜底；
     · chromium + msedge 双浏览器；录屏 + 扩散关键帧截图供 gpt-5.6-luna 判读。
   - 扩散中心客观测量（DOM 采样）：主题切换触发后下一帧（~16ms）读取
     ::view-transition-new(root) 的 clip-path 圆起点——WAAPI 动画 keyframe 起点
     为 circle(0px at X Y)，经 getComputedStyle(root,'::view-transition-new(root)')
     无法直接读伪元素；改用注入测量钩子：theme.js 在动画 keyframe 记录起始中心
     （window.__vtStart），探针读取对比点击坐标（容差 ±6px）。
     ⚠️ 不修改生产逻辑——测量钩子由探针 addInitScript 注入（读 clip-path keyframe
     起点到 window.__vtStart），仅观测。
   - 桩态：addInitScript 覆写 fetch（同 u62）。
   - 输出：--out 目录 result.json + keyframes/*.png + video/*.webm。
   - 运行：node scripts/dev/u63_theme_coord_probe.mjs [--base http://127.0.0.1:5000/]
            [--out <目录>] [--no-video] [--browsers chromium|msedge|both]
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
const OUT = path.resolve(arg("out", path.join(os.tmpdir(), "u63_theme_coord")));
const VIDEO = process.argv.indexOf("--no-video") < 0;
const BROWSERS = (arg("browsers", "both") === "both") ? ["chromium", "msedge"] : [arg("browsers", "chromium")];

fs.mkdirSync(path.join(OUT, "keyframes"), { recursive: true });
fs.mkdirSync(path.join(OUT, "video"), { recursive: true });

const RESULT = {
    meta: { base: BASE, out: OUT, video: VIDEO, browsers: BROWSERS, node: process.version, startedAt: new Date().toISOString() },
    checks: [],
    browsers: {},
};

function check(name, cond, detail) {
    RESULT.checks.push({ name, pass: !!cond, detail: detail || "" });
    console.log((cond ? "  ✔ " : "  ✖ ") + name + (cond ? "" : " :: " + detail));
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 桩态 fetch（同 u62） ---------------- */
const STUB_FN = `
window.__stub = { startCount: 0 };
window.fetch = function (url, options) {
  options = options || {};
  const key = (options.method || "GET").toUpperCase() + " " + String(url).split("?")[0];
  const json = (o, s) => Promise.resolve({ ok: (s || 200) < 400, status: s || 200,
    json: () => Promise.resolve(JSON.parse(JSON.stringify(o))) });
  if (key === "OPTIONS /api/fullscan/stop") return json({ ok: true }, 200);
  if (key === "GET /api/health") return json({ ok: true, ready: true, dll: "stub-dll", message: "Everything 已就绪", busy: false });
  if (key === "GET /api/settings") return json({ ok: true, settings: { auto_save: true, last_roots: ["D:\\\\", "C:\\\\"] }, data_dir: "C:\\\\stub\\\\data", snapshots_dir: "C:\\\\stub\\\\snapshots" });
  if (key === "POST /api/settings") return json({ ok: true, settings: {} });
  if (key === "POST /api/browse") return json({ ok: true, root: "D:\\\\", parent: null,
    directories: [ { name: "data", path: "D:\\\\data", is_dir: true, size: 12000, size_human: "11.72 KB" } ],
    files: [ { name: "readme.txt", path: "D:\\\\readme.txt", is_dir: false, size: 100, size_human: "100 B" } ],
    total_dirs: 1, total_files: 1, source: "sdk", source_at: "2026-09-05T12:00:00" });
  if (key === "GET /api/fullscan/status") return json({ ok: true, status: { running: false, roots: ["C:\\\\", "D:\\\\"], roots_done: 0, roots_total: 2,
    current_root: null, error: null, result_ready: false, save_ready: false, progress_pct: 0,
    scan_version: 1, stop_requested: false, stop_reason: null, phase: "idle", lock_holder: null, row_done: 0, row_total: 0, stop_ack_at: null } });
  if (key === "POST /api/fullscan/start") { window.__stub.startCount += 1; return json({ ok: true, message: "全量扫描任务已提交，后台执行中", status: { running: true } }); }
  if (key === "POST /api/fullscan/stop") return json({ ok: true, stopped: true });
  if (key === "GET /api/snapshots") return json({ ok: true, sessions: [], count: 0 });
  if (key === "GET /api/overview") return json({ ok: true, ready: false, scanning: false, empty_reason: "no_scan", roots: [] });
  if (key === "POST /api/save") return json({ ok: true, message: "保存完成", session: { roots: {} }, skipped: false });
  if (key === "POST /api/save/undo") return json({ ok: true, message: "已撤销" });
  if (key === "POST /api/open-path") return json({ ok: true, launched: true });
  if (key === "GET /api/export") return json({ ok: false, error: "暂无可导出的全量扫描结果，请先完成全量扫描" }, 404);
  return json({ ok: true });
};
`;

/* 测量钩子（观测性注入，不改生产逻辑）：监听 documentElement.animate 的
   ::view-transition-new(root) clip-path 动画，记录起始圆心到 window.__vtStart */
const MEASURE_HOOK = `
(() => {
  if (window.__vtStartInstalled) return;
  window.__vtStartInstalled = true;
  window.__vtStart = null;
  const origAnimate = Element.prototype.animate;
  Element.prototype.animate = function (keyframes, options) {
    if (options && options.pseudoElement === "::view-transition-new(root)") {
      try {
        // theme.js 传 object 形式 {clipPath: [from, to]}；数组形式也在支持内
        let first = null;
        if (Array.isArray(keyframes)) first = keyframes[0];
        else if (keyframes && typeof keyframes === "object" && Array.isArray(keyframes.clipPath)) first = { clipPath: keyframes.clipPath[0] };
        if (first && typeof first.clipPath === "string") {
          const m = /circle\\(\\s*0px\\s+at\\s+([\\d.]+)px\\s+([\\d.]+)px/.exec(first.clipPath);
          if (m) window.__vtStart = { x: parseFloat(m[1]), y: parseFloat(m[2]) };
        }
      } catch (e) { /* 测量钩子异常不影响切换 */ }
    }
    return origAnimate.apply(this, arguments);
  };
})();
`;

async function runBrowser(channel) {
    const tag = channel;
    const b = { cases: [], checks: [], consoleErrors: [], badHttp: [] };
    const launchOpts = { headless: true };
    if (channel === "msedge") launchOpts.channel = "msedge";
    const browser = await chromium.launch(launchOpts);
    const videoDir = path.join(OUT, "video", channel);
    fs.mkdirSync(videoDir, { recursive: true });

    const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 }, recordVideo: VIDEO ? { dir: videoDir, size: { width: 1366, height: 768 } } : undefined });
    const page = await ctx.newPage();
    const errs = [];
    page.on("console", (m) => {
        if (m.type() === "error") {
            const loc = m.location ? m.location() : null;
            if (loc && /favicon\.ico/i.test(loc.url)) return;
            errs.push("console: " + m.text() + (loc ? " @" + loc.url : ""));
        }
    });
    page.on("pageerror", (e) => errs.push("pageerror: " + e.message));
    page.on("response", (r) => { if (r.status() >= 400 && !/favicon\.ico/i.test(r.url())) b.badHttp.push(r.status() + " " + r.url()); });
    await page.addInitScript(() => { try { localStorage.setItem("pds_onboarding_dismissed_v1", "1"); } catch (e) {}
            try { sessionStorage.setItem("pds_auto_started_v1", "1"); } catch (e) {} });
    await page.addInitScript(MEASURE_HOOK);
    await page.addInitScript(STUB_FN);
    await page.goto(BASE, { waitUntil: "load", timeout: 20000 }).catch((e) => { b.gotoError = String(e); });
    await page.waitForFunction(() => typeof window.__stub === "object" && typeof window.__vtStartInstalled === "boolean" && window.__vtStartInstalled, { timeout: 15000 }).catch(() => {});
    await page.waitForFunction(() => !!document.getElementById("btn-theme"), { timeout: 15000 }).catch(() => {});

    /* ---- A. 顶栏按钮：中心 + 边缘（右缘）两点 ---- */
    const btnBox = await page.locator("#btn-theme").boundingBox();
    const socketTol = 6;
    const casesA = [
        { name: "btn-center", x: btnBox.x + btnBox.width / 2, y: btnBox.y + btnBox.height / 2, note: "顶栏主题按钮中心" },
        { name: "btn-edge", x: btnBox.x + btnBox.width - 4, y: btnBox.y + btnBox.height / 2, note: "顶栏主题按钮右缘" },
    ];
    for (const c of casesA) {
        await page.evaluate(() => { window.__vtStart = null; });
        const startTheme = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
        await page.mouse.click(c.x, c.y);
        await wait(300);
        const st = await page.evaluate(() => ({ start: window.__vtStart, theme: document.documentElement.getAttribute("data-theme") }));
        const dx = st.start ? Math.abs(st.start.x - c.x) : 9999;
        const dy = st.start ? Math.abs(st.start.y - c.y) : 9999;
        const ok = st.start && st.theme !== startTheme && dx <= socketTol && dy <= socketTol;
        const f = path.join(OUT, "keyframes", `${channel}-${c.name}.png`);
        await page.screenshot({ path: f }).catch(() => {});
        b.checks.push({ name: "[" + tag + "] " + c.name + "：扩散起点=点击坐标（±6px）", pass: ok, detail: JSON.stringify({ click: { x: Math.round(c.x), y: Math.round(c.y) }, start: st.start, themeMoved: st.theme !== startTheme }) });
        b.cases.push({ zone: "topbar", name: c.name, click: { x: Math.round(c.x), y: Math.round(c.y) }, start: st.start, themeMoved: st.theme !== startTheme, ok, shot: f });
        await wait(500); // VT 结束
    }

    /* ---- B. 设置弹窗主题选项：中心 + 边缘（+12px 偏离）----
       每次点「当前主题的相反选项」（保证真切换 + 坐标可测）：
       light→点 dark 选项；dark→点 light 选项 */
    await page.click("#btn-settings");
    await wait(350);
    const casesB = [
        { name: "opt-center", dx: 0, note: "设置选项中心" },
        { name: "opt-edge+12", dx: 12, note: "设置选项偏离中心 +12px" },
    ];
    for (const c of casesB) {
        await page.evaluate(() => { window.__vtStart = null; });
        const startTheme = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
        const want = startTheme === "dark" ? "light" : "dark"; // 相反选项（必切换）
        const target = await page.evaluate((w) => {
            const r = document.getElementById("setting-theme-" + w);
            if (!r) return null;
            const box = r.closest(".theme-opt") ? r.closest(".theme-opt").getBoundingClientRect() : null;
            return box ? { x: box.x + box.width / 2, y: box.y + box.height / 2, w: box.width, h: box.height } : null;
        }, want);
        if (!target) { b.checks.push({ name: "[" + tag + "] B " + c.name + "：设置选项可测（DOM 存在）", pass: false, detail: "setting-theme-" + want + " 缺失" }); continue; }
        const p = { x: target.x + c.dx, y: target.y };
        await page.mouse.click(p.x, p.y);
        await wait(300);
        const s2 = await page.evaluate(() => ({ start: window.__vtStart, theme: document.documentElement.getAttribute("data-theme") }));
        const d2x = s2.start ? Math.abs(s2.start.x - p.x) : 9999;
        const d2y = s2.start ? Math.abs(s2.start.y - p.y) : 9999;
        const ok2 = s2.start && s2.theme !== startTheme && d2x <= socketTol && d2y <= socketTol;
        const f2 = path.join(OUT, "keyframes", `${channel}-${c.name}.png`);
        await page.screenshot({ path: f2 }).catch(() => {});
        b.checks.push({ name: "[" + tag + "] " + c.name + "（设置弹窗）：扩散起点=点击坐标（±6px）", pass: ok2, detail: JSON.stringify({ click: { x: Math.round(p.x), y: Math.round(p.y) }, start: s2.start, themeMoved: s2.theme !== startTheme }) });
        b.cases.push({ zone: "settings", name: c.name, click: { x: Math.round(p.x), y: Math.round(p.y) }, start: s2.start, themeMoved: s2.theme !== startTheme, ok: ok2, shot: f2 });
        await wait(500);
    }

    /* ---- C. 键盘/程序化 change 路径（无指针事件 → 回退控件中心）----
       与 smoke A19 同款：checked=true + dispatchEvent(change)（无 pointerdown 记录）→
       bindThemeGroup 应变回退 pointFrom(input) 控件中心（旧语义保持） */
    await page.evaluate(() => { window.__vtStart = null; });
    const kbStartTheme = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
    const kbWant = kbStartTheme === "dark" ? "light" : "dark";
    await page.evaluate((w) => {
        const r = document.getElementById("setting-theme-" + w);
        r.checked = true;
        r.dispatchEvent(new Event("change", { bubbles: true }));
    }, kbWant);
    await wait(300);
    const kb = await page.evaluate(() => ({ start: window.__vtStart, theme: document.documentElement.getAttribute("data-theme") }));
    const kbCenter = await page.evaluate((w) => {
        const r = document.getElementById("setting-theme-" + w);
        const box = r.closest(".theme-opt").getBoundingClientRect();
        return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    }, kbWant);
    const kbOk = kb.start && kb.theme !== kbStartTheme && Math.abs(kb.start.x - kbCenter.x) <= socketTol && Math.abs(kb.start.y - kbCenter.y) <= socketTol;
    b.checks.push({ name: "[" + tag + "] 键盘/程序化 change（无坐标）→ 回退控件中心（±6px）", pass: kbOk, detail: JSON.stringify({ start: kb.start, center: kbCenter, themeMoved: kb.theme !== kbStartTheme }) });
    const fk = path.join(OUT, "keyframes", `${channel}-keyboard-center.png`);
    await page.screenshot({ path: fk }).catch(() => {});

    b.consoleErrors = errs;
    b.checks.push({ name: "[" + tag + "] 全程 console/pageerror 0", pass: errs.length === 0, detail: errs.join(" | ") + (b.badHttp.length ? " HTTP: " + b.badHttp.join(" ; ") : "") });

    await ctx.close().catch(() => {});
    await browser.close().catch(() => {});
    RESULT.browsers[tag] = b;
    b.checks.forEach((c) => check(c.name, c.pass, c.detail));
    return b;
}

(async () => {
    console.log("== u63_theme_coord_probe ==");
    console.log("base=" + BASE + " out=" + OUT + " video=" + VIDEO + " browsers=" + BROWSERS.join(","));
    for (const ch of BROWSERS) {
        console.log("-- browser " + ch + " --");
        try { await runBrowser(ch); }
        catch (e) { RESULT.browsers[ch] = { error: String(e && e.message || e) }; console.log("   异常: " + e); }
    }
    RESULT.meta.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(RESULT, null, 2), "utf-8");
    console.log("\nresult.json 已写入: " + path.join(OUT, "result.json"));
    const fails = RESULT.checks.filter((c) => !c.pass);
    console.log("总断言: " + RESULT.checks.length + "，失败: " + fails.length);
    setTimeout(() => process.exit(fails.length ? 1 : 0), 1500).unref();
})();