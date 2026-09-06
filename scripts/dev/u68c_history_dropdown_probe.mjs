/* ============================================================
   阶段 G · u68c_history_dropdown_probe.mjs（G-3 P-2 浏览历史下拉验收）
   - 场景（桩态确定性 + 双浏览器 + 关键帧供 gpt-5.6-luna 判读）：
     ① 两次浏览后 #btn-browse-history 时钟按钮出现（≥2 条历史）；
     ② 点击 → 下拉面板打开，条目 = 最近 8 倒序（命令面板同款分组样式）；
     ③ 点击条目 → browsePath 发起（与 chips 一致）+ 面板关闭；
     ④ 键盘：↑↓ 循环移动焦点、Enter 浏览、Esc 关闭；
     ⑤ 外部点击关闭；<2 条历史按钮隐藏；
     ⑥ 截图：面板打开 1366（亮/暗）；
     ⑦ console 0。
   - 运行：node scripts/dev/u68c_history_dropdown_probe.mjs
            [--base http://127.0.0.1:5000/] [--out <目录>]
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
const OUT = path.resolve(arg("out", path.join(os.tmpdir(), "u68c_history")));
fs.mkdirSync(OUT, { recursive: true });

const RESULT = { meta: { base: BASE, out: OUT, node: process.version }, checks: [], shots: [], consoleErrors: [] };
function check(name, ok, detail) {
    RESULT.checks.push({ name, ok: !!ok, detail: detail || "" });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = (page, name) => page.screenshot({
    path: path.join(OUT, name.endsWith(".png") ? name : name + ".png"),
    fullPage: false,
});

const STUB_FN = String.raw`
window.__stub = { fetchLog: [], browseCount: 0, lastBrowsePath: null };
window.fetch = function (url, options) {
  options = options || {};
  const key = (options.method || "GET").toUpperCase() + " " + String(url).split("?")[0];
  window.__stub.fetchLog.push(key);
  const json = (o, s) => Promise.resolve({ ok: (s || 200) < 400, status: s || 200,
    json: () => Promise.resolve(JSON.parse(JSON.stringify(o))) });
  if (key === "GET /api/health") return json({ ok: true, ready: true, dll: "stub-dll", message: "Everything 已就绪", busy: false });
  if (key === "GET /api/settings") return json({ ok: true, settings: { auto_save: false, last_roots: ["D:\\", "C:\\"] }, data_dir: "C:\\stub\\data", snapshots_dir: "C:\\stub\\snapshots" });
  if (key === "POST /api/browse") {
    let p = "D:\\";
    try { p = JSON.parse(options.body).path || "D:\\"; } catch (e) {}
    window.__stub.browseCount++;
    window.__stub.lastBrowsePath = p;
    return json({ ok: true, root: p, parent: (p === "D:\\" ? null : "D:\\"),
      directories: [ { name: "sub", path: p + "sub", is_dir: true, size: 12000, size_human: "11.72 KB" } ],
      files: [], total_dirs: 1, total_files: 0, source: "sdk", source_at: "2026-09-04T10:00:00" });
  }
  if (key === "GET /api/fullscan/status") return json({ ok: true, status: { running: false, roots: ["C:\\", "D:\\"], roots_done: 2, roots_total: 2, current_root: null, error: null, result_ready: true, save_ready: true, progress_pct: 100, scan_version: 1, stop_requested: false, stop_reason: null, phase: "idle" } });
  if (key === "GET /api/snapshots") return json({ ok: true, sessions: [], count: 0 });
  if (key === "GET /api/overview") return json({ ok: true, ready: true, scanning: false, roots: [], completed_at: "2026-09-04T10:00:00" });
  if (key === "POST /api/open-path") return json({ ok: true, launched: true, message: "ok" });
  return json({ ok: true });
};
`;

async function newPage(browser) {
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    const p = await ctx.newPage();
    const errs = [];
    p.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text()); });
    p.on("pageerror", (e) => errs.push("pageerror: " + e.message));
    await p.addInitScript(() => {
        try { localStorage.setItem("pds_theme_v1", "light"); } catch (e) {}
        try { localStorage.setItem("pds_onboarding_dismissed_v1", "1"); } catch (e) {}
        try { sessionStorage.setItem("pds_auto_started_v1", "1"); } catch (e) {}
    });
    await p.addInitScript(STUB_FN);
    await p.goto(BASE, { waitUntil: "load" });
    return { page: p, errs };
}

/* 制造 ≥3 条浏览历史：浏览 D:\ → D:\a → D:\b */
async function plantHistory(page) {
    await page.waitForFunction(() => document.getElementById("browse-root") !== null, null, { timeout: 15000 }).catch(() => {});
    await wait(600);
    const browse = (p) => page.evaluate((path) => {
        document.getElementById("browse-root").value = path;
        document.getElementById("btn-browse").click();
    }, p);
    await browse("D:\\");
    await wait(300);
    await browse("D:\\a");
    await wait(300);
    await browse("D:\\b");
    await wait(400);
}

(async () => {
    const browser = await chromium.launch();
    try {
        /* ---- ① 时钟按钮出现与面板打开 ---- */
        const { page, errs } = await newPage(browser);
        await plantHistory(page);
        let r = await page.evaluate(() => ({
            btnHidden: document.getElementById("btn-browse-history").hidden,
            panelHidden: document.getElementById("browse-history").classList.contains("hidden"),
        }));
        check("①a 历史 ≥2 条 → 时钟按钮可见", !r.btnHidden, "btnHidden=" + r.btnHidden);
        check("①b 初始面板关闭", r.panelHidden, "");

        await page.evaluate(() => document.getElementById("btn-browse-history").click());
        await page.waitForFunction(() => !document.getElementById("browse-history").classList.contains("hidden"), null, { timeout: 5000 }).catch(() => {});
        await wait(300);
        r = await page.evaluate(() => {
            const items = Array.from(document.querySelectorAll("#browse-history .palette-item"));
            return {
                panelOpen: !document.getElementById("browse-history").classList.contains("hidden"),
                itemCount: items.length,
                labels: items.map((el) => (el.querySelector(".palette-item-label") || {}).textContent || ""),
                groupLabel: (document.querySelector("#browse-history .palette-group-label") || {}).textContent || "",
                expanded: document.getElementById("btn-browse-history").getAttribute("aria-expanded"),
            };
        });
        check("①c 点击时钟 → 面板打开", r.panelOpen, "");
        check("①d 条目 = 最近浏览倒序（D:\b, D:\a, D:\）", r.itemCount === 3 && r.labels[0] === "D:\\b" && r.labels[1] === "D:\\a" && r.labels[2] === "D:\\", JSON.stringify(r.labels));
        check("①e 分组标签「浏览历史（最近 N 条）」", r.groupLabel.indexOf("浏览历史") !== -1 && r.groupLabel.indexOf("最近 3") !== -1, r.groupLabel);
        check("①f aria-expanded=true", r.expanded === "true", r.expanded);
        await shot(page, "u68c-dropdown-open-light-1366");
        RESULT.shots.push("u68c-dropdown-open-light-1366.png");

        /* ---- ② 键盘：↑↓ 移动、Enter 浏览、Esc 关闭 ---- */
        await page.evaluate(() => {
            const first = document.querySelector("#browse-history .palette-item");
            if (first) first.focus();
        });
        await page.keyboard.press("ArrowDown");
        let focused = await page.evaluate(() => document.activeElement && document.activeElement.getAttribute("data-idx"));
        check("②a ↓ 移动到第 2 条", focused === "1", "idx=" + focused);
        await page.keyboard.press("ArrowUp");
        focused = await page.evaluate(() => document.activeElement && document.activeElement.getAttribute("data-idx"));
        check("②b ↑ 回到第 1 条", focused === "0", "idx=" + focused);
        await page.keyboard.press("Escape");
        let panelState = await page.evaluate(() => ({
            hidden: document.getElementById("browse-history").classList.contains("hidden"),
            expanded: document.getElementById("btn-browse-history").getAttribute("aria-expanded"),
            focusOnBtn: document.activeElement === document.getElementById("btn-browse-history"),
        }));
        check("②c Esc 关闭面板", panelState.hidden && panelState.expanded === "false", JSON.stringify(panelState));
        check("②d Esc 后焦点回时钟按钮", panelState.focusOnBtn, "");

        /* ---- ③ 点击条目 → browsePath 发起 + 面板关闭 ---- */
        await page.evaluate(() => document.getElementById("btn-browse-history").click());
        await page.waitForFunction(() => !document.getElementById("browse-history").classList.contains("hidden"), null, { timeout: 5000 }).catch(() => {});
        const before = await page.evaluate(() => window.__stub.browseCount);
        await page.evaluate(() => {
            const items = document.querySelectorAll("#browse-history .palette-item");
            items[1].click(); // D:\a
        });
        await wait(400);
        const after = await page.evaluate(() => ({
            count: window.__stub.browseCount,
            lastPath: window.__stub.lastBrowsePath,
            panelHidden: document.getElementById("browse-history").classList.contains("hidden"),
        }));
        check("③a 点击条目发起浏览（browseCount+1）", after.count === before + 1, "count " + before + "→" + after.count);
        check("③b 浏览路径 = 点击条目（D:\a）", after.lastPath === "D:\\a", after.lastPath);
        check("③c 浏览后面板关闭", after.panelHidden, "");

        /* ---- ④ 外部点击关闭 ---- */
        await page.evaluate(() => document.getElementById("btn-browse-history").click());
        await page.waitForFunction(() => !document.getElementById("browse-history").classList.contains("hidden"), null, { timeout: 5000 }).catch(() => {});
        await page.mouse.click(1000, 400); // 面板外
        await wait(300);
        const ext = await page.evaluate(() => document.getElementById("browse-history").classList.contains("hidden"));
        check("④ 外部点击关闭面板", ext, "");

        /* ---- ⑤ 暗色截图 + 双浏览器 ---- */
        await page.evaluate(() => document.getElementById("btn-browse-history").click());
        await page.waitForFunction(() => !document.getElementById("browse-history").classList.contains("hidden"), null, { timeout: 5000 }).catch(() => {});
        await page.evaluate(() => { document.getElementById("btn-theme").click(); });
        await wait(500);
        await shot(page, "u68c-dropdown-open-dark-1366");
        RESULT.shots.push("u68c-dropdown-open-dark-1366.png");

        /* <2 条历史 → 按钮隐藏（重置后只浏览 1 次） */
        const { page: p2, errs: errs2 } = await newPage(browser);
        await p2.waitForFunction(() => document.getElementById("browse-root") !== null, null, { timeout: 15000 }).catch(() => {});
        await wait(500);
        // 仅一次浏览 → 历史数 1（去重后）→ 按钮应隐藏
        await p2.evaluate(() => {
            document.getElementById("browse-root").value = "D:\\";
            document.getElementById("btn-browse").click();
        });
        await wait(500);
        const r2 = await p2.evaluate(() => document.getElementById("btn-browse-history").hidden);
        check("⑤ <2 条历史 → 时钟按钮隐藏", r2 === true, "hidden=" + r2);

        const b2 = await chromium.launch();
        try {
            const { page: p3, errs: errs3 } = await newPage(b2);
            await plantHistory(p3);
            await p3.evaluate(() => document.getElementById("btn-browse-history").click());
            await p3.waitForFunction(() => !document.getElementById("browse-history").classList.contains("hidden"), null, { timeout: 5000 }).catch(() => {});
            const r3 = await p3.evaluate(() => document.querySelectorAll("#browse-history .palette-item").length);
            check("⑥ 第二浏览器同结论（3 条目）", r3 === 3, "items=" + r3);
            RESULT.consoleErrors = errs.concat(errs2, errs3);
        } finally {
            await b2.close();
        }
        RESULT.consoleErrors = errs.concat(errs2);
        check("⑦ console 0", RESULT.consoleErrors.length === 0, RESULT.consoleErrors.join("\n"));
    } finally {
        await browser.close();
    }

    const fails = RESULT.checks.filter((c) => !c.ok);
    console.log("\n=== u68c G-3 浏览历史下拉 ===");
    RESULT.checks.forEach((c) => console.log((c.ok ? "  ✔ " : "  ✖ ") + c.name + (c.ok ? "" : " :: " + c.detail)));
    console.log("shots: " + RESULT.shots.join(", "));
    console.log("consoleErrors: " + RESULT.consoleErrors.length);
    fs.writeFileSync(path.join(OUT, "u68c-result.json"), JSON.stringify(RESULT, null, 2), "utf-8");
    process.exit(fails.length ? 1 : 0);
})().catch((e) => {
    console.error("\n=== u68c UNHANDLED ERROR ===");
    console.error(e && e.stack ? e.stack : String(e));
    process.exit(2);
});