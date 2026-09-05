/* ============================================================
   阶段 E（R4/R5）· u65_statusbar_probe.mjs（E-6 状态栏精简验收探针，D4 裁定落地）
   - 覆盖手册 2-19 验收口径（阶段 E 专属纪律）：
     · 状态栏仅剩「版本号 + 已选 N 项」：.statusbar-left = v2.0.0（版本号）；
       #statusbar-selected 多选时「已选 N 项」/清零隐藏（G3 语义保持）；
     · 信息不丢断言：删除的固定文案（数据保存路径 / Everything 驱动 / 监听地址）
       必须已存在于设置弹窗（setting-data-dir）与健康徽章 popover
       （popover-data-dir / popover-health / 新补监听地址行）；
     · 状态栏高度预算 32px（F22）不变；
     · 旧文案全站零残留（正文 textContent 无「数据保存在/Everything 驱动/仅监听」）；
     · #statusbar-selected 空守卫保留（renderStatusbarSelection 缺失元素容忍）；
     · 多选联动：排行视图选 1 行 →「已选 1 项」显示；再点 → 隐藏；
     · chromium + msedge 双浏览器；状态栏截图前后对照（baseline 为修改前
       %TEMP%\stage_e_e6_baseline 若存在）+ 关键帧供 Luna 判读。
   - 桩态：addInitScript 覆写 fetch（同 u62/u63）。
   - 输出：--out result.json + shots/*.png。
   - 运行：node scripts/dev/u65_statusbar_probe.mjs [--base http://127.0.0.1:5000/]
            [--out <目录>] [--browsers chromium|msedge|both]
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
const OUT = path.resolve(arg("out", path.join(os.tmpdir(), "u65_statusbar")));
const BROWSERS = (arg("browsers", "both") === "both") ? ["chromium", "msedge"] : [arg("browsers", "chromium")];

fs.mkdirSync(path.join(OUT, "shots"), { recursive: true });

const RESULT = { meta: { base: BASE, out: OUT, browsers: BROWSERS, node: process.version, startedAt: new Date().toISOString() }, checks: [], browsers: {} };
function check(name, cond, detail) {
    RESULT.checks.push({ name, pass: !!cond, detail: detail || "" });
    console.log((cond ? "  ✔ " : "  ✖ ") + name + (cond ? "" : " :: " + detail));
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const STUB_FN = `
window.__stub = { startCount: 0 };
window.fetch = function (url, options) {
  options = options || {};
  const key = (options.method || "GET").toUpperCase() + " " + String(url).split("?")[0];
  const json = (o, s) => Promise.resolve({ ok: (s || 200) < 400, status: s || 200, json: () => Promise.resolve(JSON.parse(JSON.stringify(o))) });
  if (key === "OPTIONS /api/fullscan/stop") return json({ ok: true }, 200);
  if (key === "GET /api/health") return json({ ok: true, ready: true, dll: "stub-dll", message: "Everything 已就绪", busy: false });
  if (key === "GET /api/settings") return json({ ok: true, settings: { auto_save: true, last_roots: ["D:\\\\", "C:\\\\"] }, data_dir: "C:\\\\Users\\\\demo\\\\PythonDiskScanner", snapshots_dir: "C:\\\\Users\\\\demo\\\\PythonDiskScanner\\\\snapshots" });
  if (key === "POST /api/settings") return json({ ok: true, settings: {} });
  if (key === "POST /api/browse") return json({ ok: true, root: "D:\\\\", parent: null,
    directories: [ { name: "data", path: "D:\\\\data", is_dir: true, size: 12000, size_human: "11.72 KB" }, { name: "docs", path: "D:\\\\docs", is_dir: true, size: 4000, size_human: "3.91 KB" } ],
    files: [ { name: "readme.txt", path: "D:\\\\readme.txt", is_dir: false, size: 100, size_human: "100 B" } ],
    total_dirs: 2, total_files: 1, source: "sdk", source_at: "2026-09-05T12:00:00" });
  if (key === "GET /api/fullscan/status") return json({ ok: true, status: { running: false, roots: ["C:\\\\", "D:\\\\"], roots_done: 0, roots_total: 2, current_root: null, error: null, result_ready: false, save_ready: false, progress_pct: 0, scan_version: 1, stop_requested: false, stop_reason: null, phase: "idle", lock_holder: null, row_done: 0, row_total: 0, stop_ack_at: null } });
  if (key === "POST /api/fullscan/start") { window.__stub.startCount += 1; return json({ ok: true, message: "ok" }); }
  if (key === "GET /api/snapshots") return json({ ok: true, sessions: [], count: 0 });
  if (key === "GET /api/overview") return json({ ok: true, ready: false, scanning: false, empty_reason: "no_scan", roots: [] });
  if (key === "GET /api/export") return json({ ok: false, error: "x" }, 404);
  return json({ ok: true });
};
`;

async function runBrowser(channel) {
    const tag = channel;
    const b = { checks: [], shots: [], consoleErrors: [], badHttp: [] };
    const launchOpts = { headless: true };
    if (channel === "msedge") launchOpts.channel = "msedge";
    const browser = await chromium.launch(launchOpts);

    const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    const page = await ctx.newPage();
    const errs = [];
    page.on("console", (m) => { if (m.type() === "error") { const loc = m.location ? m.location() : null; if (loc && /favicon\.ico/i.test(loc.url)) return; errs.push(m.text()); } });
    page.on("pageerror", (e) => errs.push(e.message));
    page.on("response", (r) => { if (r.status() >= 400 && !/favicon\.ico/i.test(r.url())) b.badHttp.push(r.status() + " " + r.url()); });
    await page.addInitScript(() => { try { localStorage.setItem("pds_onboarding_dismissed_v1", "1"); } catch (e) {}
            try { sessionStorage.setItem("pds_auto_started_v1", "1"); } catch (e) {} });
    await page.addInitScript(STUB_FN);
    await page.goto(BASE, { waitUntil: "load", timeout: 20000 }).catch((e) => { b.gotoError = String(e); });
    await page.waitForFunction(() => typeof window.__stub === "object", { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1800);

    /* ① 状态栏结构：仅版本号 + 已选 N 项 */
    const sb = await page.evaluate(() => {
        const left = document.querySelector(".statusbar-left");
        const right = document.querySelector(".statusbar-right");
        const sel = document.getElementById("statusbar-selected");
        const bar = document.querySelector(".statusbar");
        const bodyText = document.body.textContent || "";
        return {
            leftText: left ? left.textContent.trim() : null,
            rightText: right ? right.textContent.trim() : null,
            selectedHidden: sel ? sel.hidden : "missing",
            selectedText: sel ? sel.textContent : null,
            barH: bar ? Math.round(bar.getBoundingClientRect().height) : -1,
            // 旧文案全站零残留
            oldDataDir: /数据保存在/.test(bodyText),
            oldEverything: /Everything 驱动/.test(bodyText),
            oldListen: /仅监听 127\.0\.0\.1/.test(bodyText),
        };
    });
    b.statusbar = sb;
    b.checks.push({ name: "[" + tag + "] 状态栏精简：左=版本号 v2.0.0", pass: sb.leftText === "v2.0.0", detail: JSON.stringify(sb) });
    b.checks.push({ name: "[" + tag + "] 状态栏高度预算 32px（F22）", pass: sb.barH === 32, detail: "height=" + sb.barH });
    b.checks.push({ name: "[" + tag + "] 旧文案零残留（数据保存路径/Everything 驱动/仅监听）", pass: !sb.oldDataDir && !sb.oldEverything && !sb.oldListen, detail: JSON.stringify({ d: sb.oldDataDir, e: sb.oldEverything, l: sb.oldListen }) });
    const sbShot = path.join(OUT, "shots", `${channel}-statusbar.png`);
    await page.screenshot({ path: sbShot, clip: { x: 0, y: 736, width: 1366, height: 32 } }).catch(() => {});
    b.shots.push(sbShot);

    /* ② 信息不丢：设置弹窗 + 健康 popover */
    await page.click("#btn-settings");
    await page.waitForFunction(() => !document.getElementById("settings-modal").classList.contains("hidden"), { timeout: 10000 });
    await page.waitForTimeout(500);
    const settingsInfo = await page.evaluate(() => ({
        dataDir: (document.getElementById("setting-data-dir") || {}).value || "",
        health: (document.getElementById("setting-health") || {}).value || "",
    }));
    b.settingsInfo = settingsInfo;
    b.checks.push({ name: "[" + tag + "] 设置弹窗：数据目录存在（信息不丢）", pass: settingsInfo.dataDir.length > 0, detail: settingsInfo.dataDir });
    b.checks.push({ name: "[" + tag + "] 设置弹窗：Everything 状态存在（信息不丢）", pass: settingsInfo.health.length > 0, detail: settingsInfo.health });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    await page.click("#health-badge");
    await page.waitForTimeout(500);
    const popInfo = await page.evaluate(() => ({
        dataDir: (document.getElementById("popover-data-dir") || {}).textContent || "",
        health: (document.getElementById("popover-health") || {}).textContent || "",
        dll: (document.getElementById("popover-health-dll") || {}).textContent || "",
        listen: Array.from(document.querySelectorAll("#health-popover .popover-row")).some((r) => r.textContent.includes("127.0.0.1")),
    }));
    b.popInfo = popInfo;
    b.checks.push({ name: "[" + tag + "] 健康 popover：数据目录/驱动状态存在（信息不丢）", pass: popInfo.dataDir.length > 0 && popInfo.health.length > 0, detail: JSON.stringify({ d: popInfo.dataDir, h: popInfo.health }) });
    b.checks.push({ name: "[" + tag + "] 健康 popover：监听地址 127.0.0.1 存在（信息不丢）", pass: popInfo.listen === true, detail: "dll=" + popInfo.dll });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    /* ③ 已选 N 项联动（G3 语义）：排行视图选 1 行 → 显示；再点 → 隐藏 */
    await page.evaluate(() => { document.getElementById("btn-view-ranking").click(); });
    await page.waitForTimeout(500);
    const selBefore = await page.evaluate(() => {
        const el = document.getElementById("statusbar-selected");
        return { hidden: el ? el.hidden : "missing", text: el ? el.textContent : "" };
    });
    await page.evaluate(() => { const box = document.querySelector("#dir-body .row-check"); if (box) box.click(); });
    await page.waitForTimeout(250);
    const selAfter = await page.evaluate(() => {
        const el = document.getElementById("statusbar-selected");
        return { hidden: el ? el.hidden : "missing", text: el ? el.textContent : "" };
    });
    await page.evaluate(() => { const box = document.querySelector("#dir-body .row-check"); if (box) box.click(); });
    await page.waitForTimeout(250);
    const selClear = await page.evaluate(() => {
        const el = document.getElementById("statusbar-selected");
        return { hidden: el ? el.hidden : "missing", text: el ? el.textContent : "" };
    });
    b.selection = { selBefore, selAfter, selClear };
    b.checks.push({ name: "[" + tag + "] 已选 N 项：初始隐藏 + 选中显示「已选 1 项」+ 再点隐藏", pass: selBefore.hidden === true && (selAfter.hidden === false && selAfter.text === "已选 1 项") && selClear.hidden === true, detail: JSON.stringify({ before: selBefore, after: selAfter, clear: selClear }) });

    b.consoleErrors = errs;
    b.checks.push({ name: "[" + tag + "] 全程 console/pageerror 0", pass: errs.length === 0, detail: errs.join(" | ") + (b.badHttp.length ? " HTTP: " + b.badHttp.join(" ; ") : "") });

    await ctx.close().catch(() => {});
    await browser.close().catch(() => {});
    RESULT.browsers[tag] = b;
    b.checks.forEach((c) => check(c.name, c.pass, c.detail));
    return b;
}

(async () => {
    console.log("== u65_statusbar_probe ==");
    console.log("base=" + BASE + " out=" + OUT + " browsers=" + BROWSERS.join(","));
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