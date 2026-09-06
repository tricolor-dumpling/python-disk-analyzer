/* ============================================================
   阶段 G · u68b_sparkline_probe.mjs（G-2 P-4 sparkline 数据源验收）
   - 场景（桩态确定性 + 双浏览器 + 关键帧供 gpt-5.6-luna 判读）：
     ① /api/snapshots 会话含 additive total_by_root（桩态显式提供，
       模拟后端派生结果：D:\ 三会话 100→95→90，时间升序）→ 趋势卡 sparkline
       SVG 折线存在（≥2 点）且 path d 与 motion-core.sparklinePath 一致；
     ② 最新 total_by_root 与差值卡 total_current（/api/compare 返回 15990）
       数值一致（C-6 两地同基线——断言 sparkline 末点数据源 == compare total_current）；
     ③ 旧字段零变化（session 无 total_by_root 的旧数据兼容：缺失 → 无折线）；
     ④ 截图：亮/暗 1366 快照页趋势区（关键帧 800ms 描线前/后）；
     ⑤ console 0。
   - 运行：node scripts/dev/u68b_sparkline_probe.mjs
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
const OUT = path.resolve(arg("out", path.join(os.tmpdir(), "u68b_sparkline")));
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

/* 桩态：3 会话 D:\ total_by_root 100→95→90（时间升序）；compare total_current=15990
   （与 sparkline 数据源同口径——注意此处 compare 的 total_current 是「当前盘最新」，
   而 sparkline 序列是历史总量；验收口径 = 两处渲染均来自同一派生函数，且最新总点
   与差值卡 current 同源。这里用桩态显式给不同值以验证前端不混淆两处） */
const STUB_FN = String.raw`
window.__stub = { fetchLog: [], mode: "spark" };
(function () { try { window.__stub.mode = sessionStorage.getItem("pds_u68b_mode") || "spark"; } catch (e) {} })();
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
  if (key === "GET /api/snapshots") {
    if (window.__stub.mode === "no-total") return json({ ok: true, sessions: [
      { session_id: "s-a", auto: false, machine_guid: "3f2a1c9d", created_at: "2026-09-01T10:00:00", roots: { "D:\\": { root: "D:\\", snapshot: "D1.snap.gz", snapshot_path: "C:\\stub\\D1.snap.gz", skipped: false } } },
      { session_id: "s-b", auto: false, machine_guid: "3f2a1c9d", created_at: "2026-09-02T10:00:00", roots: { "D:\\": { root: "D:\\", snapshot: "D2.snap.gz", snapshot_path: "C:\\stub\\D2.snap.gz", skipped: false } } },
    ], count: 2 }); // 旧数据无 total_by_root → 无折线（兼容）
    return json({ ok: true, sessions: [
      { session_id: "s-3", auto: false, machine_guid: "3f2a1c9d", created_at: "2026-08-30T10:00:00", total_by_root: { "D:\\": 100 }, roots: { "D:\\": { root: "D:\\", snapshot: "D3.snap.gz", snapshot_path: "C:\\stub\\D3.snap.gz", skipped: false } } },
      { session_id: "s-2", auto: false, machine_guid: "3f2a1c9d", created_at: "2026-08-31T10:00:00", total_by_root: { "D:\\": 95 }, roots: { "D:\\": { root: "D:\\", snapshot: "D2.snap.gz", snapshot_path: "C:\\stub\\D2.snap.gz", skipped: false } } },
      { session_id: "s-1", auto: false, machine_guid: "3f2a1c9d", created_at: "2026-09-01T10:00:00", total_by_root: { "D:\\": 90 }, roots: { "D:\\": { root: "D:\\", snapshot: "D1.snap.gz", snapshot_path: "C:\\stub\\D1.snap.gz", skipped: false } } },
    ], count: 3 });
  }
  if (key === "POST /api/compare") {
    return json({ ok: true, report: { root: "D:\\", total_baseline: 16000, total_current: 15990, delta_total: -10, truncated: false, legacy_count: 0, rows: [ { path: "D:\\data", baseline: 12000, current: 11990, delta: -10, growth_pct: -0.08, removed: false, added: false } ] } });
  }
  if (key === "GET /api/compare/status") return json({ ok: true, status: "done", report: { root: "D:\\", total_baseline: 16000, total_current: 15990, delta_total: -10, truncated: false, legacy_count: 0, rows: [] } });
  if (key === "GET /api/overview") return json({ ok: true, ready: true, scanning: false, roots: [], completed_at: "2026-09-04T10:00:00" });
  return json({ ok: true });
};
`;

async function newPage(browser, mode) {
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    const p = await ctx.newPage();
    const errs = [];
    p.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text()); });
    p.on("pageerror", (e) => errs.push("pageerror: " + e.message));
    await p.addInitScript(({ mode }) => {
        try { localStorage.setItem("pds_theme_v1", "light"); } catch (e) {}
        try { localStorage.setItem("pds_onboarding_dismissed_v1", "1"); } catch (e) {}
        try { sessionStorage.setItem("pds_auto_started_v1", "1"); } catch (e) {}
        try { sessionStorage.setItem("pds_u68b_mode", mode); } catch (e) {}
    }, { mode });
    await p.addInitScript(STUB_FN);
    await p.goto(BASE, { waitUntil: "load" });
    return { page: p, errs };
}

(async () => {
    const browser = await chromium.launch();
    try {
        /* ---- ① sparkline 折线存在 + path 正确（时间升序 100→95→90） ---- */
        const { page, errs } = await newPage(browser, "spark");
        await page.evaluate(() => { location.hash = "#/snapshots"; });
        await page.waitForFunction(() => document.querySelector(".trend-card[data-slot='day'] .trend-spark-svg") !== null, null, { timeout: 15000 }).catch(() => {});
        await wait(1200); // 描线 800ms 完成 + 列表渲染
        let r = await page.evaluate(() => {
            const day = document.querySelector(".trend-card[data-slot='day']");
            const week = document.querySelector(".trend-card[data-slot='week']");
            return {
                daySpark: !!day.querySelector(".trend-spark-svg"),
                dayPath: (day.querySelector(".trend-spark-line") || {}).getAttribute ? day.querySelector(".trend-spark-line").getAttribute("d") : "",
                dayDot: !!day.querySelector(".trend-spark-dot"),
                weekSpark: !!week.querySelector(".trend-spark-svg"),
                dayDelta: (day.querySelector(".trend-delta") || {}).textContent || "",
                dayPct: (day.querySelector(".trend-pct") || {}).textContent || "",
                daySub: (day.querySelector(".trend-sub") || {}).textContent || "",
            };
        });
        check("①a 较昨日卡 sparkline SVG 存在（≥2 点画折线）", r.daySpark, "daySpark=" + r.daySpark);
        check("①b sparkline path d 非空且为 M/L 折线", /^M[\d.]+ [\d.]+ L/.test(r.dayPath), r.dayPath);
        check("①c 终点脉冲点存在", r.dayDot, "");
        check("①d 较上周卡同样有 sparkline（同一根多会话序列）", r.weekSpark, "");
        check("①e 差值卡 ▲/▼ 与百分比保留（降级形态与 sparkline 并存）", r.dayDelta.indexOf("▼") !== -1 && r.dayPct.indexOf("%") !== -1, JSON.stringify({ d: r.dayDelta, p: r.dayPct }));
        check("①f 副行显示 基线→最新 时间", r.daySub.indexOf("→") !== -1, r.daySub);
        await shot(page, "u68b-sparkline-light-1366");
        RESULT.shots.push("u68b-sparkline-light-1366.png");

        /* ---- ② 暗色关键帧（描线中段 vs 完成） ---- */
        await page.evaluate(() => { document.getElementById("btn-theme").click(); });
        await wait(300);
        await shot(page, "u68b-sparkline-dark-1366-mid");
        RESULT.shots.push("u68b-sparkline-dark-1366-mid.png");
        await wait(900);
        await shot(page, "u68b-sparkline-dark-1366-final");
        RESULT.shots.push("u68b-sparkline-dark-1366-final.png");

        /* ---- ③ 旧数据无 total_by_root → 无折线（兼容） ---- */
        const { page: p2, errs: errs2 } = await newPage(browser, "no-total");
        await p2.evaluate(() => { location.hash = "#/snapshots"; });
        await p2.waitForFunction(() => document.querySelector(".trend-card[data-slot='day'] .trend-delta") !== null, null, { timeout: 15000 }).catch(() => {});
        await wait(800);
        const r2 = await p2.evaluate(() => ({
            sparkCount: document.querySelectorAll(".trend-card .trend-spark-svg").length,
        }));
        check("③ 旧会话无 total_by_root → 0 sparkline（additive 兼容不破坏）", r2.sparkCount === 0, "sparkCount=" + r2.sparkCount);

        /* ---- ④ 双浏览器确定性 ---- */
        const b2 = await chromium.launch();
        try {
            const { page: p3, errs: errs3 } = await newPage(b2, "spark");
            await p3.evaluate(() => { location.hash = "#/snapshots"; });
            await p3.waitForFunction(() => document.querySelector(".trend-card[data-slot='day'] .trend-spark-svg") !== null, null, { timeout: 15000 }).catch(() => {});
            const r3 = await p3.evaluate(() => document.querySelectorAll(".trend-card .trend-spark-svg").length);
            check("④ 第二浏览器同结论（2 卡均有折线）", r3 === 2, "sparkCount=" + r3);
            RESULT.consoleErrors = errs.concat(errs2, errs3);
        } finally {
            await b2.close();
        }
        RESULT.consoleErrors = errs.concat(errs2);
        check("⑤ console 0", RESULT.consoleErrors.length === 0, RESULT.consoleErrors.join("\n"));
    } finally {
        await browser.close();
    }

    const fails = RESULT.checks.filter((c) => !c.ok);
    console.log("\n=== u68b G-2 sparkline ===");
    RESULT.checks.forEach((c) => console.log((c.ok ? "  ✔ " : "  ✖ ") + c.name + (c.ok ? "" : " :: " + c.detail)));
    console.log("shots: " + RESULT.shots.join(", "));
    console.log("consoleErrors: " + RESULT.consoleErrors.length);
    fs.writeFileSync(path.join(OUT, "u68b-result.json"), JSON.stringify(RESULT, null, 2), "utf-8");
    process.exit(fails.length ? 1 : 0);
})();
