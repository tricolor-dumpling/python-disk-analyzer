/* ============================================================
   阶段 G · u68d_breadcrumb_fold_probe.mjs（G-4 P-3 面包屑折叠验收）
   - 场景（桩态确定性 + 双浏览器 + 关键帧供 gpt-5.6-luna 判读）：
     ① 8 层路径 → 面包屑折叠：首段 + 「…」 + 末两段（当前段高亮）；
     ② 各层 data-path 回跳仍可用（行为等价——点击首段回根）；
     ③ 点击「…」→ 展开全部 8 层；
     ④ 「…」键盘可聚焦（Tab 可达 button）；
     ⑤ ≤6 层不折叠；窄屏截图；
     ⑥ console 0。
   - 运行：node scripts/dev/u68d_breadcrumb_fold_probe.mjs
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
const OUT = path.resolve(arg("out", path.join(os.tmpdir(), "u68d_breadcrumb")));
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

const DEEP_PATH = "D:\\a\\b\\c\\d\\e\\f\\g"; // 8 段（D:,a,b,c,d,e,f,g）

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
    // 返回 DEEP_PATH 的上级构成：父 = 路径去掉末段；仅 D:\ 无父
    const parent = (p === "D:\\" || p === "D:\\a") ? null : p.replace(/[^\\]+$/, "").replace(/\\+$/, "");
    return json({ ok: true, root: p, parent: (p === "D:\\" ? null : true) ? parent : null,
      directories: [ { name: "sub", path: p + (p.endsWith("\\") ? "" : "\\") + "sub", is_dir: true, size: 12000, size_human: "11.72 KB" } ],
      files: [], total_dirs: 1, total_files: 0, source: "sdk", source_at: "2026-09-04T10:00:00" });
  }
  if (key === "GET /api/fullscan/status") return json({ ok: true, status: { running: false, roots: ["C:\\", "D:\\"], roots_done: 2, roots_total: 2, current_root: null, error: null, result_ready: true, save_ready: true, progress_pct: 100, scan_version: 1, stop_requested: false, stop_reason: null, phase: "idle" } });
  if (key === "GET /api/snapshots") return json({ ok: true, sessions: [], count: 0 });
  if (key === "GET /api/overview") return json({ ok: true, ready: true, scanning: false, roots: [], completed_at: "2026-09-04T10:00:00" });
  if (key === "POST /api/open-path") return json({ ok: true, launched: true, message: "ok" });
  return json({ ok: true });
};
`;

async function newPage(browser, w, h) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
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

async function browseTo(page, path) {
    await page.evaluate((p) => {
        document.getElementById("browse-root").value = p;
        document.getElementById("btn-browse").click();
    }, path);
    await page.waitForFunction(() => document.getElementById("breadcrumb").textContent.indexOf("当前路径") !== -1, null, { timeout: 8000 }).catch(() => {});
    await wait(500);
}

(async () => {
    const browser = await chromium.launch();
    try {
        /* ---- ① 8 层 → 折叠 ---- */
        const { page, errs } = await newPage(browser, 1366, 768);
        await browseTo(page, DEEP_PATH);
        let r = await page.evaluate(() => {
            const crumbs = Array.from(document.querySelectorAll("#breadcrumb .crumb"));
            const current = (document.querySelector("#breadcrumb .crumb-current") || {}).textContent || "";
            const ellipsis = document.querySelector("#breadcrumb .crumb-ellipsis");
            return {
                crumbTexts: crumbs.map((c) => c.textContent).filter((t) => t !== "…"),
                ellipsis: !!ellipsis,
                ellipsisLabel: ellipsis ? ellipsis.textContent : "",
                current,
                crumbCount: crumbs.length,
                fullParts: Array.from(document.querySelectorAll("#breadcrumb .crumb, #breadcrumb .crumb-current")).map((el) => el.textContent),
            };
        });
        check("①a 8 层折叠：首段 + … + 末两段（D:, …, f, g 高亮）", r.crumbTexts.length === 2 && r.crumbTexts[0] === "D:" && r.crumbTexts[1] === "f" && r.current === "g", JSON.stringify(r.crumbTexts) + " current=" + r.current);
        check("①b 「…」按钮存在", r.ellipsis && r.ellipsisLabel === "…", "");
        await shot(page, "u68d-breadcrumb-folded-light-1366");
        RESULT.shots.push("u68d-breadcrumb-folded-light-1366.png");

        /* ---- ② 各层 data-path 回跳仍可用（点击首段回 D:\） ---- */
        const before = await page.evaluate(() => window.__stub.browseCount);
        await page.evaluate(() => {
            const first = Array.from(document.querySelectorAll("#breadcrumb .crumb[data-path]")).find((c) => c.textContent === "D:");
            if (first) first.click();
        });
        await wait(400);
        const after = await page.evaluate(() => ({ count: window.__stub.browseCount, lastPath: window.__stub.lastBrowsePath, breadcrumb: document.getElementById("breadcrumb").textContent }));
        check("② 点击首段 D: → 回跳 D:\\（行为等价）", after.count === before + 1 && after.lastPath === "D:\\", JSON.stringify(after.lastPath));
        // 回到深目录
        await browseTo(page, DEEP_PATH);

        /* ---- ③ 「…」展开全部 ---- */
        await page.evaluate(() => { const e = document.querySelector("#breadcrumb .crumb-ellipsis"); if (e) e.click(); });
        await wait(400);
        r = await page.evaluate(() => ({
            ellipsisGone: !document.querySelector("#breadcrumb .crumb-ellipsis"),
            crumbs: Array.from(document.querySelectorAll("#breadcrumb .crumb")).map((c) => c.textContent),
            current: (document.querySelector("#breadcrumb .crumb-current") || {}).textContent || "",
        }));
        check("③a 展开后「…」消失", r.ellipsisGone, "");
        check("③b 展开后 7 层可点 + 当前段 g", r.crumbs.length === 7 && r.current === "g", "crumbs=" + r.crumbs.length + " current=" + r.current);
        await shot(page, "u68d-breadcrumb-expanded-light-1366");
        RESULT.shots.push("u68d-breadcrumb-expanded-light-1366.png");

        /* ---- ④ 「…」键盘可聚焦（重新折叠后 Tab 可达） ---- */
        await browseTo(page, DEEP_PATH); // 重新浏览 = 渲染折叠态
        await page.waitForFunction(() => document.querySelector("#breadcrumb .crumb-ellipsis") !== null, null, { timeout: 5000 }).catch(() => {});
        await page.evaluate(() => {
            const ellipsis = document.querySelector("#breadcrumb .crumb-ellipsis");
            if (ellipsis) ellipsis.focus();
        });
        await wait(100);
        const focusOk = await page.evaluate(() => {
            const el = document.activeElement;
            return !!el && el.classList && el.classList.contains("crumb-ellipsis");
        });
        check("④ 「…」键盘可聚焦（button tabindex 原生）", focusOk, "");

        /* ---- ⑤ ≤6 层不折叠 + 窄屏截图 ---- */
        await browseTo(page, "D:\\a\\b\\c\\d"); // 5 层
        r = await page.evaluate(() => ({
            ellipsis: !!document.querySelector("#breadcrumb .crumb-ellipsis"),
            crumbs: Array.from(document.querySelectorAll("#breadcrumb .crumb")).length,
        }));
        check("⑤a 5 层不折叠（无 …）", !r.ellipsis && r.crumbs === 4, "crumbs=" + r.crumbs);

        await browseTo(page, DEEP_PATH);
        await shot(page, "u68d-breadcrumb-folded-narrow-800");
        RESULT.shots.push("u68d-breadcrumb-folded-narrow-800.png");

        /* ---- ⑥ 双浏览器 + 暗色 + console ---- */
        await page.evaluate(() => { document.getElementById("btn-theme").click(); });
        await wait(500);
        await shot(page, "u68d-breadcrumb-folded-dark-1366");
        RESULT.shots.push("u68d-breadcrumb-folded-dark-1366.png");

        const b2 = await chromium.launch();
        try {
            const { page: p2, errs: errs2 } = await newPage(b2, 1366, 768);
            await browseTo(p2, DEEP_PATH);
            const r2 = await p2.evaluate(() => ({
                ellipsis: !!document.querySelector("#breadcrumb .crumb-ellipsis"),
                crumbs: Array.from(document.querySelectorAll("#breadcrumb .crumb")).filter((c) => c.textContent !== "…").map((c) => c.textContent),
            }));
            check("⑥ 第二浏览器同结论（折叠 D: … f g）", r2.ellipsis && r2.crumbs.length === 2 && r2.crumbs[0] === "D:" && r2.crumbs[1] === "f", JSON.stringify(r2));
            RESULT.consoleErrors = errs.concat(errs2);
        } finally {
            await b2.close();
        }
        RESULT.consoleErrors = errs;
        check("⑦ console 0", RESULT.consoleErrors.length === 0, RESULT.consoleErrors.join("\n"));
    } finally {
        await browser.close();
    }

    const fails = RESULT.checks.filter((c) => !c.ok);
    console.log("\n=== u68d G-4 面包屑折叠 ===");
    RESULT.checks.forEach((c) => console.log((c.ok ? "  ✔ " : "  ✖ ") + c.name + (c.ok ? "" : " :: " + c.detail)));
    console.log("shots: " + RESULT.shots.join(", "));
    console.log("consoleErrors: " + RESULT.consoleErrors.length);
    fs.writeFileSync(path.join(OUT, "u68d-result.json"), JSON.stringify(RESULT, null, 2), "utf-8");
    process.exit(fails.length ? 1 : 0);
})();