/* ============================================================
   阶段C（R2）· u56_relate_probe.mjs（C-7 关系目录树验收探针）
   - 场景（全部桩态确定性渲染，供 gpt-5.6-luna 判读 + DOM 采样）：
     ① relate-tree-basic：关系视图渲染（树显示/表格隐藏/treemap 隐藏互斥终态）
     ② relate-lazy-expand：单击目录 → 懒展开下钻（复用 browse 加载，1 次/节点）
     ③ relate-virtual：>200 子项虚拟化（251 项仅渲染窗口行 + spacer）
     ④ relate-keyboard：↑↓ 移动、Enter 下钻、← 返回上级（真实键盘）
     ⑤ relate-narrow：窄屏（357×651）树形态截图（供 Luna 判读）
   - 运行：node scripts/dev/u56_relate_probe.mjs [--base http://127.0.0.1:5000/]
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
const OUT = path.resolve(arg("out", path.join(os.tmpdir(), "u56_relate")));
fs.mkdirSync(OUT, { recursive: true });

const RESULT = { meta: { base: BASE, out: OUT, node: process.version }, checks: [], shots: [], consoleErrors: [] };
function check(name, ok, detail) {
    RESULT.checks.push({ name, ok: !!ok, detail: detail || "" });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = (page, name) => page.screenshot({ path: path.join(OUT, name), fullPage: false });
function decodeEntities(s) {
    return String(s || "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"');
}

/* 桩 fetch：browse 大目录（250 目录触发虚拟化）/ 子目录（懒展开）；scanState=done */
const STUB_FN = String.raw`
window.__stub = { scanState: "done", fetchLog: [], big: false };
(function () {
  try { window.__stub.big = localStorage.getItem("pds_u56_big") === "1"; } catch (e) {}
})();
window.fetch = function (url, options) {
  options = options || {};
  const key = (options.method || "GET").toUpperCase() + " " + String(url).split("?")[0];
  window.__stub.fetchLog.push(key);
  const json = (o, s) => Promise.resolve({ ok: (s || 200) < 400, status: s || 200,
    json: () => Promise.resolve(JSON.parse(JSON.stringify(o))) });
  if (key === "GET /api/health") return json({ ok: true, ready: true, dll: "stub-dll", message: "Everything 已就绪", busy: false });
  if (key === "GET /api/settings") return json({ ok: true, settings: { auto_save: false, last_roots: ["D:\\", "C:\\"] }, data_dir: "C:\\stub\\data", snapshots_dir: "C:\\stub\\snapshots" });
  if (key === "POST /api/browse") {
    const body = options.body ? JSON.parse(options.body) : {};
    const p = body.path || "D:\\";
    if (p === "D:\\" && window.__stub.big) {
      const dirs = [];
      for (let i = 0; i < 250; i++) dirs.push({ name: "dir" + String(i).padStart(3, "0"), path: "D:\\dir" + String(i).padStart(3, "0"), is_dir: true, size: 1000 + i, size_human: "1 KB" });
      return json({ ok: true, root: "D:\\", parent: null, directories: dirs,
        files: [{ name: "readme.txt", path: "D:\\readme.txt", is_dir: false, size: 100, size_human: "100 B" }],
        total_dirs: 250, total_files: 1, source: "sdk", source_at: "" });
    }
    if (p === "D:\\") return json({ ok: true, root: "D:\\", parent: null,
      directories: [
        { name: "data", path: "D:\\data", is_dir: true, size: 12000, size_human: "11.72 KB" },
        { name: "docs", path: "D:\\docs", is_dir: true, size: 4000, size_human: "3.91 KB" },
      ],
      files: [{ name: "readme.txt", path: "D:\\readme.txt", is_dir: false, size: 100, size_human: "100 B" }],
      total_dirs: 2, total_files: 1, source: "sdk", source_at: "" });
    if (p === "D:\\data") return json({ ok: true, root: "D:\\data", parent: "D:\\",
      directories: [{ name: "deep", path: "D:\\data\\deep", is_dir: true, size: 5000, size_human: "4.88 KB" }],
      files: [{ name: "a.txt", path: "D:\\data\\a.txt", is_dir: false, size: 10, size_human: "10 B" }],
      total_dirs: 1, total_files: 1, source: "sdk", source_at: "" });
    if (p === "D:\\docs") return json({ ok: true, root: "D:\\docs", parent: "D:\\",
      directories: [{ name: "guide", path: "D:\\docs\\guide", is_dir: true, size: 2000, size_human: "1.95 KB" }],
      files: [{ name: "manual.pdf", path: "D:\\docs\\manual.pdf", is_dir: false, size: 2048, size_human: "2 KB" }],
      total_dirs: 1, total_files: 1, source: "sdk", source_at: "" });
    return json({ ok: true, root: p, parent: "D:\\", directories: [], files: [], total_dirs: 0, total_files: 0, source: "sdk", source_at: "" });
  }
  if (key === "GET /api/fullscan/status") {
    return json({ ok: true, status: { running: false, roots: ["C:\\", "D:\\"], roots_done: 2, roots_total: 2, current_root: null, error: null, result_ready: true, save_ready: true, progress_pct: 100, scan_version: 1, stop_requested: false, stop_reason: null, phase: "idle" } });
  }
  if (key === "GET /api/snapshots") return json({ ok: true, sessions: [], count: 0 });
  if (key === "GET /api/overview") return json({ ok: true, ready: false, scanning: false, empty_reason: "no_scan", roots: [] });
  return json({ ok: true });
};
`;

/* 开新页：预置场景 → 整页加载 → 关系视图 */
async function openRelate(browser, opts = {}) {
    const page = await browser.newPage({ viewport: { width: opts.width || 1366, height: opts.height || 768 } });
    const errs = [];
    page.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text()); });
    page.on("pageerror", (e) => errs.push("pageerror: " + e.message));
    await page.addInitScript(({ big }) => {
        try { localStorage.setItem("pds_u56_big", big ? "1" : "0"); } catch (e) {}
        try { localStorage.setItem("pds_onboarding_dismissed_v1", "1"); } catch (e) {}
            try { sessionStorage.setItem("pds_auto_started_v1", "1"); } catch (e) {}
        try { localStorage.setItem("pds_theme_v1", "light"); } catch (e) {}
    }, { big: !!opts.big });
    await page.addInitScript(STUB_FN);
    await page.goto(BASE, { waitUntil: "load", timeout: 20000 }).catch((e) => { RESULT.meta.gotoError = String(e); });
    await page.waitForFunction(() => !!document.getElementById("btn-view-relate"), { timeout: 15000 }).catch(() => {});
    await page.click("#btn-view-relate", { timeout: 5000 }).catch((e) => errs.push("click relate fail: " + e.message));
    await page.waitForTimeout(700);
    RESULT.consoleErrors.push(...errs.map((e) => "[relate] " + e));
    return { page, errs };
}

(async () => {
    const browser = await chromium.launch({ headless: true });
    const log = (m) => console.log("[u56] " + m);

    /* ① 关系视图渲染 + 互斥终态 */
    log("scenario ① relate-tree-basic");
    {
        const { page } = await openRelate(browser);
        const st = await page.evaluate(() => {
            const tree = document.getElementById("relate-tree");
            const table = document.querySelector("#table-wrap > table.dir-table");
            return {
                modeActive: document.querySelector("#btn-view-relate").classList.contains("btn-primary"),
                treeHidden: tree ? tree.hasAttribute("hidden") : "no-el",
                tableHidden: table ? table.hasAttribute("hidden") : "no-el",
                treemapHidden: document.getElementById("treemap-wrap").hasAttribute("hidden"),
                rows: tree ? tree.querySelectorAll(".relate-row").length : 0,
                names: tree ? Array.from(tree.querySelectorAll(".relate-name")).map((n) => n.textContent) : [],
                status: (document.getElementById("browse-status-text") || {}).textContent || "",
            };
        });
        check("关系按钮高亮（btn-primary）", st.modeActive, JSON.stringify(st));
        check("树显示/表格隐藏/treemap 隐藏（互斥终态）",
            !st.treeHidden && st.tableHidden && st.treemapHidden, JSON.stringify(st));
        check("树渲染 3 行（2 目录 + 1 文件）", st.rows === 3 &&
            st.names.indexOf("data\\") !== -1 && st.names.indexOf("docs\\") !== -1 && st.names.indexOf("readme.txt") !== -1,
            JSON.stringify(st.names));
        check("状态行含「关系目录」", st.status.indexOf("关系目录") !== -1, st.status);
        /* 阶段C（C-7）防回归：首行不被 list-footer 遮挡（footer sticky+z2 且
           display:flex 覆盖 [hidden] UA——relate 激活时若 footer 未真正隐藏会
           盖住树首行；命中测试实证 elementFromPoint 首行返回 list-footer）。 */
        const hitOk = await page.evaluate(() => {
            const tree = document.getElementById("relate-tree");
            const row = Array.from(tree.querySelectorAll(".relate-row[data-path]"))
                .find((r) => r.getAttribute("data-path") === "D:\\data");
            if (!row) return false;
            const rc = row.getBoundingClientRect();
            const el = document.elementFromPoint(rc.left + rc.width / 2, rc.top + rc.height / 2);
            return !!el && !!el.closest('.relate-row[data-path="D:\\\\data"]');
        });
        check("首行不被页脚遮挡（命中测试）", hitOk, "elementFromPoint 首行应命中行内元素");
        await shot(page, "relate-tree-basic.png");
        RESULT.shots.push("relate-tree-basic.png");
        await page.close();
    }

    /* ② 懒展开：单击目录 → browse 下钻（复用加载） */
    log("scenario ② relate-lazy-expand");
    {
        const { page } = await openRelate(browser);
        const fetchBefore = await page.evaluate(() => window.__stub.fetchLog.filter((k) => k.indexOf("/api/browse") !== -1).length);
        const clickOk = await page.evaluate(() => {
            const row = Array.from(document.querySelectorAll(".relate-row[data-path]"))
                .find((r) => r.getAttribute("data-path") === "D:\\data");
            if (!row) return false;
            row.click();
            return true;
        });
        check("单击目录行分发成功", clickOk, "");
        await page.waitForTimeout(900);
        const st = await page.evaluate(() => ({
            names: Array.from(document.querySelectorAll(".relate-name")).map((n) => n.textContent),
            rows: document.querySelectorAll(".relate-row").length,
            status: (document.getElementById("browse-status-text") || {}).textContent || "",
            crumb: (document.getElementById("breadcrumb") || {}).textContent || "",
            fetchBrowse: window.__stub.fetchLog.filter((k) => k.indexOf("/api/browse") !== -1).length,
        }));
        check("懒展开下钻成功（deep\ + a.txt）", st.names.indexOf("deep\\") !== -1 && st.names.indexOf("a.txt") !== -1,
            JSON.stringify(st.names));
        check("下钻仅 1 次额外 browse 请求（懒展开 1 次/节点）",
            st.fetchBrowse === fetchBefore + 1, "before=" + fetchBefore + " after=" + st.fetchBrowse);
        check("面包屑显示当前层", st.crumb.indexOf("data") !== -1, st.crumb);
        await shot(page, "relate-lazy-expand.png");
        RESULT.shots.push("relate-lazy-expand.png");
        await page.close();
    }

    /* ③ 虚拟化：>200 子项 */
    log("scenario ③ relate-virtual");
    {
        const { page } = await openRelate(browser, { big: true });
        const st = await page.evaluate(() => {
            const tree = document.getElementById("relate-tree");
            return {
                vVirtual: tree.classList.contains("v-virtual"),
                renderedRows: tree.querySelectorAll(".relate-row").length,
                spacerCount: tree.querySelectorAll(".relate-spacer").length,
                scrollH: tree.scrollHeight,
                totalLabel: (document.getElementById("browse-status-text") || {}).textContent || "",
            };
        });
        check(">200 子项启用虚拟化", st.vVirtual, JSON.stringify(st));
        check("仅渲染窗口行（<60）", st.renderedRows < 60, "rendered=" + st.renderedRows);
        check("虚拟滚动容器有总高度（spacer 撑开）", st.scrollH > 7000, "scrollH=" + st.scrollH);
        await shot(page, "relate-virtual.png");
        RESULT.shots.push("relate-virtual.png");
        await page.close();
    }

    /* ④ 键盘：↑↓ 移动、Enter 下钻、← 返回上级 */
    log("scenario ④ relate-keyboard");
    {
        const { page } = await openRelate(browser);
        await page.evaluate(() => { document.getElementById("relate-tree").focus(); });
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("ArrowDown");
        const kb = await page.evaluate(() => {
            const f = document.querySelector(".relate-row.is-focus");
            return { focusPath: f ? f.getAttribute("data-path") : null, activeIsRow: !!f && document.activeElement === f };
        });
        check("↓↓ 移动焦点行（active 在行上）", kb.activeIsRow && !!kb.focusPath, JSON.stringify(kb));
        await page.keyboard.press("Enter");
        await page.waitForTimeout(900);
        const drilled = await page.evaluate(() => ({
            names: Array.from(document.querySelectorAll(".relate-name")).map((n) => n.textContent),
            focusBack: document.activeElement && document.activeElement.id === "relate-tree",
        }));
        check("Enter 下钻成功 + 焦点回树容器（键盘连续性）",
            (drilled.names.indexOf("guide\\") !== -1 && drilled.names.indexOf("manual.pdf") !== -1) && drilled.focusBack,
            JSON.stringify(drilled));
        await page.keyboard.press("ArrowLeft");
        await page.waitForTimeout(900);
        const back = await page.evaluate(() => ({
            names: Array.from(document.querySelectorAll(".relate-name")).map((n) => n.textContent).slice(0, 2),
            rows: document.querySelectorAll(".relate-row").length,
        }));
        check("← 返回上级（回根 3 入口）", back.rows >= 3, JSON.stringify(back));
        await page.close();
    }

    /* ⑤ 窄屏（357×651）截图（Luna 判读） */
    log("scenario ⑤ relate-narrow");
    {
        const { page } = await openRelate(browser, { width: 357, height: 651 });
        await page.evaluate(() => { window.scrollTo(0, 0); });
        await page.waitForTimeout(300);
        await shot(page, "relate-narrow-357x651.png");
        RESULT.shots.push("relate-narrow-357x651.png");
        await page.close();
    }

    check("console 无未处理错误", RESULT.consoleErrors.length === 0, RESULT.consoleErrors.join(" | "));

    fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(RESULT, null, 2), "utf-8");
    console.log("[u56] " + RESULT.checks.filter((c) => c.ok).length + "/" + RESULT.checks.length + " checks passed");
    RESULT.checks.forEach((c) => console.log((c.ok ? "  ✔ " : "  ✘ ") + c.name + (c.detail ? " :: " + c.detail : "")));
    setTimeout(() => process.exit(RESULT.checks.every((c) => c.ok) ? 0 : 1), 1500).unref();
    try { await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 1500))]); } catch (e) { /* 忽略 */ }
    process.exit(RESULT.checks.every((c) => c.ok) ? 0 : 1);
})().catch((err) => {
    RESULT.fatal = String(err && err.stack || err);
    try { fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(RESULT, null, 2), "utf-8"); } catch (e) {}
    console.error("[u56] FATAL: " + RESULT.fatal);
    RESULT.checks.forEach((c) => console.log((c.ok ? "  ✔ " : "  ✘ ") + c.name + (c.detail ? " :: " + c.detail : "")));
    process.exit(1);
});