/* ============================================================
   阶段 G · u68a_calibre_annotation_probe.mjs（G-1 P-5 口径标注验收）
   - 场景（桩态确定性渲染 + 双浏览器 + 关键帧供 gpt-5.6-luna 判读）：
     ① 存储概览卡图例标注行「逻辑尺寸，未计硬链接重叠」存在性（DOM 采样）；
     ② chips title 含口径文案；环形 aria-label 含口径文案；
     ③ 设置弹窗数据目录区 .calibre-note 标注存在性；
     ④ 截图：概览卡亮/暗 + 设置弹窗亮（1366×768）；
     ⑤ console 0。
   - 运行：node scripts/dev/u68a_calibre_annotation_probe.mjs
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
const OUT = path.resolve(arg("out", path.join(os.tmpdir(), "u68a_calibre")));
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

const CALIBRE = "逻辑尺寸，未计硬链接重叠";

const STUB_FN = String.raw`
window.__stub = { theme: "light", fetchLog: [] };
window.fetch = function (url, options) {
  options = options || {};
  const key = (options.method || "GET").toUpperCase() + " " + String(url).split("?")[0];
  window.__stub.fetchLog.push(key);
  const json = (o, s) => Promise.resolve({ ok: (s || 200) < 400, status: s || 200,
    json: () => Promise.resolve(JSON.parse(JSON.stringify(o))) });
  if (key === "GET /api/health") return json({ ok: true, ready: true, dll: "stub-dll", message: "Everything 已就绪", busy: false });
  if (key === "GET /api/settings") return json({ ok: true, settings: { auto_save: false, last_roots: ["D:\\", "C:\\"] }, data_dir: "C:\\stub\\data", snapshots_dir: "C:\\stub\\snapshots" });
  if (key === "POST /api/browse") return json({ ok: true, root: "D:\\", parent: null,
    directories: [ { name: "data", path: "D:\\data", is_dir: true, size: 12000, size_human: "11.72 KB" } ],
    files: [], total_dirs: 1, total_files: 0, source: "sdk", source_at: "2026-09-04T10:00:00" });
  if (key === "GET /api/fullscan/status") return json({ ok: true, status: { running: false, roots: ["C:\\", "D:\\"], roots_done: 2, roots_total: 2, current_root: null, error: null, result_ready: true, save_ready: true, progress_pct: 100, scan_version: 1, stop_requested: false, stop_reason: null, phase: "idle" } });
  if (key === "GET /api/snapshots") return json({ ok: true, sessions: [], count: 0 });
  if (key === "GET /api/overview") return json({ ok: true, ready: true, scanning: false,
    roots: [ { root: "C:\\", total: 500000000, total_human: "476.84 MB", index_ready: true, index_valid: true, directories: [], files: [], directory_count: 1, file_count: 1, record_count: 1, completed_at: "2026-09-04T10:00:00" },
             { root: "D:\\", total: 1200000000, total_human: "1.12 GB", index_ready: true, index_valid: true, directories: [], files: [], directory_count: 1, file_count: 1, record_count: 1, completed_at: "2026-09-04T10:00:00" } ],
    completed_at: "2026-09-04T10:00:00" });
  if (key === "POST /api/open-path") return json({ ok: true, launched: true, message: "ok" });
  return json({ ok: true });
};
`;

async function newPage(browser, theme) {
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    const p = await ctx.newPage();
    const errs = [];
    p.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text()); });
    p.on("pageerror", (e) => errs.push("pageerror: " + e.message));
    await p.addInitScript(({ theme }) => {
        try { localStorage.setItem("pds_theme_v1", theme); } catch (e) {}
        try { localStorage.setItem("pds_onboarding_dismissed_v1", "1"); } catch (e) {}
        try { sessionStorage.setItem("pds_auto_started_v1", "1"); } catch (e) {}
    }, { theme });
    await p.addInitScript(STUB_FN);
    await p.goto(BASE, { waitUntil: "load" });
    return { page: p, errs };
}

(async () => {
    const browser = await chromium.launch();
    try {
        /* ---- ① 概览卡图例标注 + chips title + aria-label（亮色） ---- */
        const { page, errs } = await newPage(browser, "light");
        await page.waitForFunction(() => document.querySelector(".donut-legend-calibre") !== null, null, { timeout: 15000 }).catch(() => {});
        await wait(800); // sweep/count-up 入场
        let r = await page.evaluate((cal) => {
            const legend = (document.querySelector(".donut-legend-calibre") || {}).textContent || "";
            const chip = document.querySelector("#overview-chips .chip");
            const chipTitle = chip ? chip.getAttribute("title") || "" : "";
            const aria = document.getElementById("overview-donut").getAttribute("aria-label") || "";
            return { legend, chipTitle, aria };
        }, CALIBRE);
        check("①a 概览图例标注行存在且文案=D5 裁定原文", r.legend.trim() === CALIBRE, JSON.stringify(r.legend));
        check("①b chips title 含口径", r.chipTitle.indexOf(CALIBRE) !== -1, r.chipTitle);
        check("①c 环形 aria-label 含口径", r.aria.indexOf(CALIBRE) !== -1, r.aria);
        await shot(page, "u68a-overview-light-1366");
        RESULT.shots.push("u68a-overview-light-1366.png");

        /* ---- ② 设置弹窗数据目录区标注 ---- */
        await page.evaluate(() => { document.getElementById("btn-settings").click(); });
        await page.waitForFunction(() => document.querySelector("#settings-modal .calibre-note") !== null, null, { timeout: 5000 }).catch(() => {});
        await wait(400);
        r = await page.evaluate((cal) => {
            const note = (document.querySelector("#settings-modal .calibre-note") || {}).textContent || "";
            const dataDirVal = (document.getElementById("setting-data-dir") || {}).value || "";
            return { note, dataDirVal };
        }, CALIBRE);
        check("②a 设置弹窗数据目录区 .calibre-note 存在且文案正确", r.note.trim() === CALIBRE, JSON.stringify(r.note));
        check("②b 数据目录值未被标注污染（仍是路径）", /\\/.test(r.dataDirVal), r.dataDirVal);
        await shot(page, "u68a-settings-light-1366");
        RESULT.shots.push("u68a-settings-light-1366.png");

        /* ---- ③ 暗色主题截图 ---- */
        await page.evaluate(() => { document.getElementById("btn-theme").click(); });
        await wait(600);
        await shot(page, "u68a-overview-dark-1366");
        RESULT.shots.push("u68a-overview-dark-1366.png");

        RESULT.consoleErrors = errs;
        check("③ console 0", errs.length === 0, errs.join("\n"));

        /* ---- ④ 双浏览器（第二实例核对同结论——桩态确定性） ---- */
        const b2 = await chromium.launch();
        try {
            const { page: p2, errs: errs2 } = await newPage(b2, "light");
            await p2.waitForFunction(() => document.querySelector(".donut-legend-calibre") !== null, null, { timeout: 15000 }).catch(() => {});
            const r2 = await p2.evaluate((cal) => ((document.querySelector(".donut-legend-calibre") || {}).textContent || "").trim(), CALIBRE);
            check("④ 第二浏览器同结论（标注确定性）", r2 === CALIBRE, r2);
            RESULT.consoleErrors = RESULT.consoleErrors.concat(errs2);
        } finally {
            await b2.close();
        }
    } finally {
        await browser.close();
    }

    const fails = RESULT.checks.filter((c) => !c.ok);
    console.log("\n=== u68a P-5 口径标注 ===");
    RESULT.checks.forEach((c) => console.log((c.ok ? "  ✔ " : "  ✖ ") + c.name + (c.ok ? "" : " :: " + c.detail)));
    console.log("shots: " + RESULT.shots.join(", "));
    console.log("consoleErrors: " + RESULT.consoleErrors.length);
    fs.writeFileSync(path.join(OUT, "u68a-result.json"), JSON.stringify(RESULT, null, 2), "utf-8");
    process.exit(fails.length ? 1 : 0);
})();
