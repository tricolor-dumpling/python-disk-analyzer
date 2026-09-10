/* ============================================================
   阶段C（R2）· u57_list_diff_probe.mjs（C-8 排行/表格差异化 + 密度差异验收）
   - 场景（全部桩态确定性渲染，供 gpt-5.6-luna 判读 + DOM 采样）：
     ① ranking-vs-table：同一数据排行/表格两视图——列结构差异（表格独立列
       大小/占比/类型；排行极简名称+条+大小）+ 截图
     ② cozy-vs-compact：密度差异——compact 隐藏尺寸条与行图标（仅数值）、
       cozy 完整 icon+条；行高 cozy 36 / compact 26（getBoundingClientRect 实测）
     ③ virtual-row-height：虚拟滚动模式行高 36/26 实测（u24 断言面同步）
   - 运行：node scripts/dev/u57_list_diff_probe.mjs [--base http://127.0.0.1:5000/]
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
const OUT = path.resolve(arg("out", path.join(os.tmpdir(), "u57_list")));
fs.mkdirSync(OUT, { recursive: true });

const RESULT = { meta: { base: BASE, out: OUT, node: process.version }, checks: [], shots: [], consoleErrors: [] };
function check(name, ok, detail) {
    RESULT.checks.push({ name, ok: !!ok, detail: detail || "" });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = (page, name) => page.screenshot({ path: path.join(OUT, name), fullPage: false });

const STUB_FN = String.raw`
window.__stub = { scanState: "done", big: false };
(function () {
  try { window.__stub.big = localStorage.getItem("pds_u57_big") === "1"; } catch (e) {}
})();
window.fetch = function (url, options) {
  options = options || {};
  const key = (options.method || "GET").toUpperCase() + " " + String(url).split("?")[0];
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
        { name: "media", path: "D:\\media", is_dir: true, size: 2600000, size_human: "2.48 MB" },
        { name: "backup", path: "D:\\backup", is_dir: true, size: 500, size_human: "500 B" },
      ],
      files: [
        { name: "pagefile.sys", path: "D:\\pagefile.sys", is_dir: false, size: 999999, size_human: "976.56 KB" },
        { name: "readme.txt", path: "D:\\readme.txt", is_dir: false, size: 100, size_human: "100 B" },
      ],
      total_dirs: 4, total_files: 2, source: "sdk", source_at: "" });
    return json({ ok: true, root: p, parent: "D:\\", directories: [], files: [], total_dirs: 0, total_files: 0, source: "sdk", source_at: "" });
  }
  if (key === "GET /api/fullscan/status") return json({ ok: true, status: { running: false, roots: ["D:\\"], roots_done: 1, roots_total: 1, current_root: null, error: null, result_ready: true, save_ready: true, progress_pct: 100, scan_version: 1 } });
  if (key === "GET /api/snapshots") return json({ ok: true, sessions: [], count: 0 });
  if (key === "GET /api/overview") return json({ ok: true, ready: true, scanning: false, roots: [] });
  return json({ ok: true });
};
`;

async function openStub(browser) {
    const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
    const errs = [];
    page.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text()); });
    page.on("pageerror", (e) => errs.push("pageerror: " + e.message));
    await page.addInitScript(() => {
        try { localStorage.setItem("pds_onboarding_dismissed_v1", "1"); } catch (e) {}
            try { sessionStorage.setItem("pds_auto_started_v1", "1"); } catch (e) {}
        try { localStorage.setItem("pds_theme_v1", "light"); } catch (e) {}
    });
    await page.addInitScript(STUB_FN);
    await page.goto(BASE, { waitUntil: "load", timeout: 20000 }).catch((e) => { RESULT.meta.gotoError = String(e); });
    await page.waitForFunction(() => !!document.getElementById("btn-view-ranking"), { timeout: 15000 }).catch(() => {});
    RESULT.consoleErrors.push(...errs);
    return { page, errs };
}

/* 视图切换后等待列表行渲染完成（数据到达 + crossfade 120ms + L1-2 stagger 动画
   + 占比条 600ms 生长收束）——截图前必须行 opacity=1（否则入场首帧近空白，
   Luna 判读会误报「主体为空」）。 */
async function waitListRows(page, n, timeoutMs) {
    await page.waitForFunction((cnt) => document.querySelectorAll("#dir-body tr:not(.v-spacer)").length >= cnt,
        { timeout: timeoutMs || 8000, arg: n }).catch(() => {});
    await page.waitForTimeout(900); // 动画收束（crossfade 120 + stagger 24×12 + 条 600）
}

(async () => {
    const browser = await chromium.launch({ headless: true });
    const log = (m) => console.log("[u57] " + m);

    /* ① 排行 vs 表格列结构差异 */
    log("scenario ① ranking-vs-table");
    {
        const { page } = await openStub(browser);
        // 排行视图
        await page.click("#btn-view-ranking", { timeout: 5000 });
        await waitListRows(page, 6);
        const rank = await page.evaluate(() => {
            const row = document.querySelector("#dir-body tr:not(.v-spacer)");
            const rankingRow = row ? row.querySelector(".ranking-row, .ranking-row-static") : null;
            return {
                rowCount: document.querySelectorAll("#dir-body tr:not(.v-spacer)").length,
                hasRankingRow: !!rankingRow,
                rankCells: rankingRow ? rankingRow.querySelectorAll(":scope > span, :scope > strong").length : 0,
                firstRankText: rankingRow ? rankingRow.textContent.replace(/\s+/g, " ").trim().slice(0, 60) : "",
                tableCols: row ? row.querySelectorAll("td").length : 0,
                hasColShare: !!document.querySelector("th.col-share"),
                hasColType: !!document.querySelector("th.col-type"),
            };
        });
        check("排行视图行渲染（6 行）", rank.rowCount === 6, "rowCount=" + rank.rowCount);
        check("排行行结构（名称+条+大小）", rank.hasRankingRow && rank.rankCells >= 3, JSON.stringify(rank));
        await shot(page, "ranking-1366.png");
        RESULT.shots.push("ranking-1366.png");
        // 表格视图
        await page.click("#btn-view-table", { timeout: 5000 });
        await waitListRows(page, 6);
        const tbl = await page.evaluate(() => {
            const row = document.querySelector("#dir-body tr:not(.v-spacer)");
            return {
                rowCount: document.querySelectorAll("#dir-body tr:not(.v-spacer)").length,
                tableCols: row ? row.querySelectorAll("td").length : 0,
                colNames: Array.from(document.querySelectorAll(".dir-table thead th")).map((th) => th.textContent.trim()),
                hasTypeCell: !!row && !!row.querySelector(".col-type"),
                hasSizeCell: !!row && !!row.querySelector(".col-size"),
                hasShareCell: !!row && !!row.querySelector(".col-share"),
            };
        });
        check("表格视图行渲染（6 行）", tbl.rowCount === 6, "rowCount=" + tbl.rowCount);
        check("表格列 = 5（checkbox/名称/大小/占比/类型）", tbl.tableCols === 5,
            "cols=" + tbl.tableCols + " names=" + JSON.stringify(tbl.colNames));
        check("表格差异化列（占比+类型独立列）", tbl.hasTypeCell && tbl.hasShareCell && tbl.hasSizeCell, JSON.stringify(tbl));
        check("排行 vs 表格列结构不同", rank.rankCells !== tbl.tableCols, "rank=" + rank.rankCells + " table=" + tbl.tableCols);
        await shot(page, "table-1366.png");
        RESULT.shots.push("table-1366.png");
        await page.close();
    }

    /* ② 列表信息完整性（P3/D3-6：密度开关已整体删除，行高唯一 36px——
         原「cozy vs compact 密度差异」对照段退役：compact 分支会 display:none
         掉占比条并零宽占比列（信息损失），D3-1 裁定唯一档 = cozy。
         保留并强化「信息不丢」正向断言 + 新增「密度入口已删除」断言） */
    log("scenario ② list-info-integrity");
    {
        const { page } = await openStub(browser);
        // 唯一档（原 cozy）：完整 icon + 条
        await page.click("#btn-view-ranking", { timeout: 5000 });
        await waitListRows(page, 6);
        const cozy = await page.evaluate(() => {
            const row = document.querySelector("#dir-body tr:not(.v-spacer)");
            const r = row ? row.getBoundingClientRect() : null;
            const body = document.getElementById("dir-body");
            return {
                rowH: r ? r.height : 0,
                compactClass: body.classList.contains("compact-list"),
                densityBtn: !!document.getElementById("btn-density"),
                sizeTrackVisible: (() => { const t = document.querySelector("#dir-body .size-track"); return t ? getComputedStyle(t).display !== "none" : false; })(),
                iconVisible: (() => { const i = document.querySelector("#dir-body .ranking-name > .icon, #dir-body .cell-name > .icon, #dir-body .dir-link > .icon"); return i ? getComputedStyle(i).display !== "none" : false; })(),
                nameVisible: (() => { const n = document.querySelector("#dir-body .ranking-name, #dir-body .cell-name"); return n ? getComputedStyle(n).display !== "none" : false; })(),
                sizeVisible: (() => { const s = document.querySelector("#dir-body strong, #dir-body .col-size"); return s ? getComputedStyle(s).display !== "none" : false; })(),
            };
        });
        check("列表完整信息（尺寸条 + icon 可见）", cozy.sizeTrackVisible && cozy.iconVisible, JSON.stringify(cozy));
        check("列表名称与数值仍可见", cozy.nameVisible && cozy.sizeVisible, JSON.stringify(cozy));
        check("列表行高 ≥ 32px（内容自适应合法）", cozy.rowH >= 32, "rowH=" + cozy.rowH);
        check("密度开关已删除（无 #btn-density / 无 .compact-list 类）", !cozy.densityBtn && !cozy.compactClass, JSON.stringify(cozy));
        await shot(page, "ranking-1366.png");
        RESULT.shots.push("ranking-1366.png");
        // 表格视图同验（唯一档）
        await page.click("#btn-view-table", { timeout: 5000 });
        await waitListRows(page, 6);
        const compactTbl = await page.evaluate(() => {
            const row = document.querySelector("#dir-body tr:not(.v-spacer)");
            return {
                rowH: row ? row.getBoundingClientRect().height : 0,
                sizeTrackVisible: (() => { const t = document.querySelector("#dir-body .size-track"); return t ? getComputedStyle(t).display !== "none" : false; })(),
            };
        });
        check("表格视图尺寸条可见（信息不丢）", compactTbl.sizeTrackVisible, JSON.stringify(compactTbl));
        check("表格行高 ≥ 24px（非虚拟内容自适应合法）", compactTbl.rowH >= 24, "rowH=" + compactTbl.rowH);
        await shot(page, "table-1366.png");
        RESULT.shots.push("table-1366.png");
        await page.close();
    }

    /* ③ 虚拟滚动行高（u24 断言面同步：>200 行虚拟模式行高唯一 36px） */
    log("scenario ③ virtual-row-height");
    {
        const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
        const errs = [];
        page.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text()); });
        page.on("pageerror", (e) => errs.push("pageerror: " + e.message));
        await page.addInitScript(() => {
            try { localStorage.setItem("pds_u57_big", "1"); } catch (e) {}
            try { localStorage.setItem("pds_onboarding_dismissed_v1", "1"); } catch (e) {}
            try { sessionStorage.setItem("pds_auto_started_v1", "1"); } catch (e) {}
        });
        await page.addInitScript(STUB_FN);
        await page.goto(BASE, { waitUntil: "load", timeout: 20000 }).catch((e) => { RESULT.meta.gotoError = String(e); });
        await page.waitForFunction(() => !!document.getElementById("btn-view-ranking"), { timeout: 15000 }).catch(() => {});
        await page.click("#btn-view-ranking", { timeout: 5000 });
        await waitListRows(page, 40);
        await page.waitForFunction(() => document.getElementById("dir-body").classList.contains("v-virtual"), { timeout: 8000 }).catch(() => {});
        const vCozy = await page.evaluate(() => {
            const body = document.getElementById("dir-body");
            const r = document.querySelector("#dir-body tr:not(.v-spacer)");
            return {
                vVirtual: body.classList.contains("v-virtual"),
                rowH: r ? r.getBoundingClientRect().height : 0,
            };
        });
        check(">200 行虚拟化启用", vCozy.vVirtual, JSON.stringify(vCozy));
        check("虚拟行高 ≈ 36px（u24 断言面；P3/D3-6 起唯一档）", Math.abs(vCozy.rowH - 36) <= 1, "rowH=" + vCozy.rowH);
        /* P3（D3-6）：原「compact 密度虚拟行高 26 / 隐藏尺寸条」断言段退役
           （#btn-density 已删除；虚拟行高唯一 36px，由上一行断言覆盖）。 */
        await shot(page, "virtual-ranking-250-rows.png");
        RESULT.shots.push("virtual-ranking-250-rows.png");
        RESULT.consoleErrors.push(...errs);
        await page.close();
    }

    check("console 无未处理错误", RESULT.consoleErrors.length === 0, RESULT.consoleErrors.join(" | "));

    fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(RESULT, null, 2), "utf-8");
    console.log("[u57] " + RESULT.checks.filter((c) => c.ok).length + "/" + RESULT.checks.length + " checks passed");
    RESULT.checks.forEach((c) => console.log((c.ok ? "  ✔ " : "  ✘ ") + c.name + (c.detail ? " :: " + c.detail : "")));
    setTimeout(() => process.exit(RESULT.checks.every((c) => c.ok) ? 0 : 1), 1500).unref();
    try { await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 1500))]); } catch (e) { /* 忽略 */ }
    process.exit(RESULT.checks.every((c) => c.ok) ? 0 : 1);
})().catch((err) => {
    RESULT.fatal = String(err && err.stack || err);
    try { fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(RESULT, null, 2), "utf-8"); } catch (e) {}
    console.error("[u57] FATAL: " + RESULT.fatal);
    RESULT.checks.forEach((c) => console.log((c.ok ? "  ✔ " : "  ✘ ") + c.name + (c.detail ? " :: " + c.detail : "")));
    process.exit(1);
});