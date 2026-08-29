/* ============================================================
   UI 2.0（SpaceLens Pro）· U3.3 快照管理页验收探针
   - 验收口径（手册 §U3.3 + N07/F15/F16/F17 + 红线#7）：
     ①页头装配（创建快照 F15 复用保存流程 + 撤销最近保存 F16=-确认弹窗流）；
     ②趋势卡×2（N07）：基线选取（≤24h / (24h,7d] 最近一份）、目标=该盘最新、
       ▲/▼ + 百分比（降级差值卡——/api/snapshots 无逐次总量字段 → 无折线）、
       无合适基线 →「暂无对比基线」、点击卡 → #/compare 预填（state.compare）；
     ③回灌不重发（路由往返不重打 /api/compare）；
     ④列表（F17）：会话分组/标签/逐盘「对比此快照」预填/跳过原因 tooltip（红线#7）；
     ⑤撤销确认流（POST /api/save/undo）+ 列表刷新；
     ⑥「创建快照」置灰/启用（N06：无全量数据置灰；扫描完成 → 可用 → POST /api/save）；
     ⑦清空数据（wipe）后列表/趋势卡复位（applySnapshotsView 空缓存回灌）；
     ⑧50 次路由往返节点无增长 + console 0；
     ⑨双档零滚动（1366×768 / 1920×1080 快照页 + 工作台）+ 800×700 窄屏例外截图；
     ⑩视觉截图（亮/暗/1920/800×700）。
   - 策略：桩态（addInitScript 覆写 fetch；__stub.snapMode ∈ single|trend|empty、
     __stub.phase ∈ idle|done）跑确定性断言；真实页阶段（--with-data）验证真机
     页面装配/零滚动/console 0（数据随真实会话，不做数值断言）。
   - 运行：node scripts/dev/u33_acc_probe.mjs [--base http://127.0.0.1:5000/]
           [--out <截图目录>] [--with-data]
   - ⚠️ addInitScript 传函数体字符串；注入后先校验 window.__stub 接管。
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
const OUT = arg("out", path.join(os.tmpdir(), "u33_acc_shots"));
const WITH_DATA = process.argv.indexOf("--with-data") >= 0;
fs.mkdirSync(OUT, { recursive: true });

let passCount = 0, failCount = 0;
function ok(name, cond, detail) {
    if (cond) { passCount++; console.log("  ✔ " + name); }
    else { failCount++; console.log("  ✖ " + name + (detail ? " :: " + detail : "")); }
}
function shot(page, name) {
    return page.screenshot({ path: path.join(OUT, name + ".png"), fullPage: false });
}

const WAIT_FN = `(fn, timeout) => new Promise((resolve) => {
  const end = Date.now() + (timeout || 15000);
  const tick = () => { if (fn()) resolve(true); else if (Date.now() > end) resolve(fn()); else setTimeout(tick, 100); };
  tick();
})`;
async function installWait(page) {
    await page.evaluate((src) => { window.__wait = eval("(" + src + ")"); }, WAIT_FN);
}

/* ---- 桩态 fetch（addInitScript；状态机：snapMode/phase 可脚本化） ---- */
const STUB_FN = `
window.__stub = { snapMode: "single", phase: "idle", fetchLog: [] };
window.fetch = function (url, options) {
  options = options || {};
  const key = (options.method || "GET").toUpperCase() + " " + String(url).split("?")[0];
  window.__stub.fetchLog.push(key);
  const json = (o, s) => Promise.resolve({ ok: (s || 200) < 400, status: s || 200,
    json: () => Promise.resolve(JSON.parse(JSON.stringify(o))) });
  const STATUS = {
    idle: { running: false, roots: ["C:\\\\", "D:\\\\"], roots_done: 0, roots_total: 2, current_root: null, error: null, result_ready: false, save_ready: false, progress_pct: 0, scan_version: 1, stop_requested: false, stop_reason: null },
    done: { running: false, roots: ["C:\\\\", "D:\\\\"], roots_done: 2, roots_total: 2, current_root: null, error: null, result_ready: true, save_ready: true, progress_pct: 100, scan_version: 7, stop_requested: false, stop_reason: null },
  };
  const SESSIONS = {
    single: [ { session_id: "s-20260824-120000-aabbccdd", auto: false, machine_guid: "aabbccdd-1234", created_at: "2026-08-24T12:00:00", roots: { "D:\\\\": { root: "D:\\\\", snapshot: "D_120000_a.snap.gz", snapshot_path: "C:\\\\snap\\\\D_120000_a.snap.gz", skipped: false } } } ],
    trend: [
      { session_id: "s-20260824-120000-aabbccdd", auto: false, machine_guid: "aabbccdd-1234", created_at: "2026-08-24T12:00:00", roots: { "D:\\\\": { root: "D:\\\\", snapshot: "D_120000_a.snap.gz", snapshot_path: "C:\\\\snap\\\\D_120000_a.snap.gz", skipped: false } } },
      { session_id: "s-20260824-100000-aabbccdd", auto: true, machine_guid: "aabbccdd-1234", created_at: "2026-08-24T10:00:00",
        roots: { "D:\\\\": { root: "D:\\\\", snapshot: "D_100000_b.snap.gz", snapshot_path: "C:\\\\snap\\\\D_100000_b.snap.gz", skipped: false },
                 "C:\\\\": { root: "C:\\\\", snapshot: null, snapshot_path: null, skipped: true, skip_reason: "day_budget_exceeded", notice: "今日写入量已达上限，自动保存跳过" } } },
      { session_id: "s-20260820-100000-aabbccdd", auto: false, machine_guid: "aabbccdd-1234", created_at: "2026-08-20T10:00:00", roots: { "D:\\\\": { root: "D:\\\\", snapshot: "D_0810_c.snap.gz", snapshot_path: "C:\\\\snap\\\\D_0810_c.snap.gz", skipped: false } } }
    ],
    empty: [],
  };
  if (key === "GET /api/health") return json({ ok: true, ready: true, dll: "stub-dll", message: "Everything 已就绪" });
  if (key === "GET /api/settings") return json({ ok: true, settings: { auto_save: false, last_roots: ["D:\\\\"] }, data_dir: "C:\\\\stub\\\\data", snapshots_dir: "C:\\\\stub\\\\snapshots" });
  if (key === "POST /api/settings") return json({ ok: true, settings: { auto_save: false } });
  if (key === "POST /api/browse") {
    const p = options.body ? JSON.parse(options.body).path : null;
    window.__stub.lastBrowse = p;
    return json({ ok: true, root: p, parent: null, directories: [ { name: "data", path: "D:\\\\data", is_dir: true, size: 12000, size_human: "11.72 KB" } ], files: [], total_dirs: 1, total_files: 0 });
  }
  if (key === "GET /api/fullscan/status") return json({ ok: true, status: STATUS[window.__stub.phase] || STATUS.idle });
  if (key === "OPTIONS /api/fullscan/stop") return json({ ok: true }, 200);
  if (key === "POST /api/fullscan/stop") return json({ ok: true, stopped: false, status: STATUS.idle });
  if (key === "GET /api/snapshots") return json({ ok: true, sessions: SESSIONS[window.__stub.snapMode] || [], count: (SESSIONS[window.__stub.snapMode] || []).length });
  if (key === "POST /api/save") { window.__stub.saveCount = (window.__stub.saveCount || 0) + 1; return json({ ok: true, message: "保存完成", session: {}, skipped: false }); }
  if (key === "POST /api/save/undo") { window.__stub.undoCount = (window.__stub.undoCount || 0) + 1; return json({ ok: true, message: "已撤销最近一次保存", session_id: "s-x", deleted: [], undeleted: [] }); }
  if (key === "POST /api/compare") return json({ ok: true, report: { root: "D:\\\\", total_baseline: 16000, total_current: 15990, delta_total: -10, truncated: false, legacy_count: 0, rows: [ { path: "D:\\\\data", baseline: 12000, current: 11990, delta: -10, growth_pct: -0.08, removed: false, added: false } ] } });
  if (key === "GET /api/overview") return json({ ok: true, ready: true, roots: [ { root: "D:\\\\", total: 1200000, total_human: "1.14 MB", index_ready: true, index_valid: true, directories: [], files: [], directory_count: 1, file_count: 1, record_count: 1, completed_at: "2026-08-24T10:00:00" } ], completed_at: "2026-08-24T10:00:00" });
  if (key === "POST /api/open-path") return json({ ok: true, launched: true, message: "ok" });
  return json({ ok: true });
};
`;

async function newStubPage(browser, w, h) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    const p = await ctx.newPage();
    const errs = [];
    p.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text()); });
    p.on("pageerror", (e) => errs.push("pageerror: " + e.message));
    await p.addInitScript(() => { try { localStorage.setItem("pds_onboarding_dismissed_v1", "1"); } catch (e) {} });
    await p.addInitScript(() => {
        window.addEventListener("load", () => {
            import("/static/js/app/main.js").then((m) => { try { m.closeModal("onboarding"); } catch (e) {} }).catch(() => {});
        });
    });
    await p.addInitScript(STUB_FN);
    await p.goto(BASE, { waitUntil: "load" });
    await installWait(p);
    const stubOk = await p.evaluate(() => typeof window.__stub === "object" && String(window.fetch).indexOf("__stub") !== -1).catch(() => false);
    return { page: p, ctx, errs, stubOk };
}

async function metricViewport(page, w, h) {
    return page.evaluate(([vw, vh]) => new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => {
            resolve({
                w: vw, h: vh,
                bodySh: document.body.scrollHeight,
                bodyCh: document.body.clientHeight,
                bodyOverflow: getComputedStyle(document.body).overflow,
            });
        }));
    }), [w, h]);
}

(async () => {
    const browser = await chromium.launch();
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));

    /* ================= 阶段 1：桩态确定性断言（1366×768） ================= */
    console.log("== 阶段 1：桩态（stub fetch） ==");
    const { page, errs: errs1, stubOk } = await newStubPage(browser, 1366, 768);
    if (!stubOk) {
        ok("前置：桩态 fetch 已接管", false, "window.__stub 缺失");
        await browser.close();
        process.exit(1);
    }
    ok("前置：桩态 fetch 已接管", true);
    await page.waitForFunction(() => document.getElementById("browse-root") !== null, null, { timeout: 15000 }).catch(() => {});
    await wait(1200);

    /* ---- ① 页面装配（single 模式：1 会话 → 无基线空态） ---- */
    let r = await page.evaluate(async () => {
        location.hash = "#/snapshots";
        await window.__wait(() => window.__stub && document.querySelector("[data-page='snapshots']"), 5000);
        return {
            routeOk: !!document.querySelector("[data-page='snapshots']"),
            create: !!document.getElementById("btn-create-snapshot"),
            undo: !!document.getElementById("btn-undo-save"),
            createDisabled: document.getElementById("btn-create-snapshot").disabled,
            undoDisabled: document.getElementById("btn-undo-save").disabled,
            cards: document.querySelectorAll(".trend-card").length,
            empties: Array.from(document.querySelectorAll(".trend-card.is-empty")).map((c) => c.textContent.trim()),
            items: document.querySelectorAll("#snapshot-list .session-item").length,
            countText: document.getElementById("snapshots-list-count").textContent,
        };
    });
    ok("①a 快照页装配（page-head + 趋势区 + 列表区）", r.routeOk && r.create && r.undo);
    ok("①b 无扫描结果 → 创建快照置灰（N06）", r.createDisabled === true);
    ok("①c 有会话 → 撤销可用", r.undoDisabled === false);
    ok("①d 趋势卡×2 且单快照均「暂无对比基线」", r.cards === 2 && r.empties.length === 2 && r.empties.every((t) => t.indexOf("暂无对比基线") !== -1), JSON.stringify(r.empties));
    ok("①e 列表 1 会话 + 计数", r.items === 1 && r.countText === "共 1 个快照会话");

    /* ---- ② 趋势卡（trend 模式）：基线选取/降级差值卡/无 sparkline ---- */
    r = await page.evaluate(async () => {
        const m = await import("/static/js/app/main.js");
        window.__stub.snapMode = "trend";
        window.__stub.fetchLog.length = 0;
        await m.refreshSnapshots();
        await window.__wait(() => document.querySelector(".trend-card[data-slot='day'] .trend-delta") &&
                                   document.querySelector(".trend-card[data-slot='week'] .trend-delta"), 8000);
        const day = document.querySelector(".trend-card[data-slot='day']");
        const week = document.querySelector(".trend-card[data-slot='week']");
        return {
            dayBaseline: day.getAttribute("data-baseline"),
            weekBaseline: week.getAttribute("data-baseline"),
            dayRoot: day.getAttribute("data-root"),
            dayTarget: day.getAttribute("data-target"),
            dayDelta: day.querySelector(".trend-delta").textContent,
            dayPct: day.querySelector(".trend-pct").textContent,
            dayCls: day.querySelector(".trend-delta").className,
            daySub: day.querySelector(".trend-sub").textContent,
            svgCount: document.querySelectorAll(".trend-card svg").length,
            cmpCount: window.__stub.fetchLog.filter((k) => k === "POST /api/compare").length,
            items: document.querySelectorAll("#snapshot-list .session-item").length,
            skipTitle: (document.querySelector("#snapshot-list .tag-skip") || {}).title || "",
            skipReason: (document.querySelector("#snapshot-list .skip-reason") || {}).textContent || "",
            autoTag: !!document.querySelector("#snapshot-list .tag-auto"),
            manualTag: !!document.querySelector("#snapshot-list .tag-manual"),
        };
    });
    ok("②a 较昨日基线 = ≤24h 最近一份（08-24 10:00）", r.dayBaseline === "C:\\snap\\D_100000_b.snap.gz", r.dayBaseline);
    ok("②b 较上周基线 = (24h,7d] 最近一份（08-20 10:00）", r.weekBaseline === "C:\\snap\\D_0810_c.snap.gz", r.weekBaseline);
    ok("②c 目标 = 该盘最新快照 + root 带盘符", r.dayRoot === "D:\\" && r.dayTarget === "C:\\snap\\D_120000_a.snap.gz", JSON.stringify({ root: r.dayRoot, target: r.dayTarget }));
    ok("②d 差值卡降级形态：▼ + 负值 + 百分比（无折线）", r.dayDelta.indexOf("▼") !== -1 && r.dayDelta.indexOf("-10.00 B") !== -1 && r.dayPct.indexOf("-0.06%") !== -1, JSON.stringify({ d: r.dayDelta, p: r.dayPct }));
    ok("②e 涨红降绿类（shrink=释放绿）", r.dayCls.indexOf("shrink") !== -1, r.dayCls);
    ok("②f 无 sparkline（0 svg——降级差值卡无折线）", r.svgCount === 0, "svg=" + r.svgCount);
    ok("②g 两卡各自恰 1 次 /api/compare（复用既有接口）", r.cmpCount === 2, "cmp=" + r.cmpCount);
    ok("②h 副行显示 基线→最新 时间", r.daySub.indexOf("2026-08-24 10:00:00") !== -1 && r.daySub.indexOf("2026-08-24 12:00:00") !== -1, r.daySub);
    ok("②i 列表 3 会话 + 自动/手动标签", r.items === 3 && r.autoTag && r.manualTag);
    ok("②j 跳过原因 tooltip + 可见文案（红线 #7 SKIP_REASON_TEXT）", r.skipTitle.indexOf("今日写入量已达上限") !== -1 && r.skipReason.indexOf("今日写入量已达上限") !== -1, JSON.stringify({ t: r.skipTitle, s: r.skipReason }));

    /* ---- ③ 趋势卡点击 → #/compare 预填；往返回灌不重发 ---- */
    r = await page.evaluate(async () => {
        const m = await import("/static/js/app/main.js");
        m.APP_STATE.compare.baseline = ""; m.APP_STATE.compare.root = ""; m.APP_STATE.compare.target = "";
        document.querySelector(".trend-card[data-slot='day']").click();
        await window.__wait(() => m.APP_STATE.route === "/compare", 5000);
        const prefill = { baseline: m.APP_STATE.compare.baseline, root: m.APP_STATE.compare.root, target: m.APP_STATE.compare.target };
        location.hash = "#/snapshots";
        await window.__wait(() => m.APP_STATE.route === "/snapshots" && document.querySelector(".trend-card[data-slot='day'] .trend-delta"), 5000);
        const cmpCount = window.__stub.fetchLog.filter((k) => k === "POST /api/compare").length;
        return { prefill, cmpCount };
    });
    ok("③a 点击趋势卡 → #/compare 且预填 baseline/root/target", r.prefill.baseline === "C:\\snap\\D_100000_b.snap.gz" && r.prefill.root === "D:\\" && r.prefill.target === "C:\\snap\\D_120000_a.snap.gz", JSON.stringify(r.prefill));
    ok("③b 返回路由从缓存回灌（compare 计数不增 = 不重发）", r.cmpCount === 2, "cmp=" + r.cmpCount);

    /* ---- ④ 逐盘「对比此快照」→ 预填 + 跳转 ---- */
    r = await page.evaluate(async () => {
        const m = await import("/static/js/app/main.js");
        m.APP_STATE.compare.baseline = ""; m.APP_STATE.compare.root = ""; m.APP_STATE.compare.target = "";
        document.querySelector("#snapshot-list .act-cmp-snap").click();
        await window.__wait(() => m.APP_STATE.route === "/compare", 5000);
        return { route: m.APP_STATE.route, baseline: m.APP_STATE.compare.baseline, target: m.APP_STATE.compare.target, root: m.APP_STATE.compare.root };
    });
    ok("④a 逐盘对比 → 预填该盘快照（baseline=点击项，target=该盘最新）", r.route === "/compare" && r.baseline === "C:\\snap\\D_120000_a.snap.gz" && r.target === "C:\\snap\\D_120000_a.snap.gz", JSON.stringify(r));
    await page.evaluate(() => { location.hash = "#/snapshots"; });
    await page.waitForFunction(() => document.querySelector(".trend-card[data-slot='day'] .trend-delta"), null, { timeout: 8000 }).catch(() => {});

    /* ---- ⑤ 撤销确认流 ---- */
    r = await page.evaluate(async () => {
        document.getElementById("btn-undo-save").click();
        await window.__wait(() => !document.getElementById("confirm-modal").classList.contains("hidden"), 3000);
        const modalShown = !document.getElementById("confirm-modal").classList.contains("hidden");
        document.getElementById("btn-confirm-ok").click();
        await window.__wait(() => (window.__stub.undoCount || 0) >= 1, 5000);
        await window.__wait(() => document.querySelectorAll("#snapshot-list .session-item").length === 3, 5000);
        return { modalShown, undoCount: window.__stub.undoCount, items: document.querySelectorAll("#snapshot-list .session-item").length };
    });
    ok("⑤a 撤销弹确认弹窗（红线确认流程）", r.modalShown === true);
    ok("⑤b 确认后 POST /api/save/undo + 列表刷新", r.undoCount >= 1 && r.items === 3, JSON.stringify(r));

    /* ---- ⑥ 「创建快照」随扫描状态置灰/启用 + 复用保存流程 ---- */
    r = await page.evaluate(async () => {
        const scan = await import("/static/js/app/components/scan.js");
        const m = await import("/static/js/app/main.js");
        const before = document.getElementById("btn-create-snapshot").disabled;
        window.__stub.phase = "done";
        await scan.pollFullscan();
        await window.__wait(() => document.getElementById("btn-create-snapshot").disabled === false, 5000);
        const after = document.getElementById("btn-create-snapshot").disabled;
        document.getElementById("btn-create-snapshot").click();
        await window.__wait(() => (window.__stub.saveCount || 0) >= 1, 5000);
        return { before, after, saveCount: window.__stub.saveCount };
    });
    ok("⑥a 空闲置灰 → 扫描完成（save_ready）启用", r.before === true && r.after === false, JSON.stringify({ b: r.before, a: r.after }));
    ok("⑥b 点击创建 → POST /api/save（复用保存流程）", r.saveCount >= 1, "save=" + r.saveCount);

    /* ---- ⑦ 清空（empty 模式）：列表/趋势卡复位 + 撤销灰置 ---- */
    r = await page.evaluate(async () => {
        const m = await import("/static/js/app/main.js");
        window.__stub.snapMode = "empty";
        await m.refreshSnapshots();
        await window.__wait(() => document.querySelectorAll("#snapshot-list .session-item").length === 0, 5000);
        return {
            undoDisabled: document.getElementById("btn-undo-save").disabled,
            emptyText: document.querySelector("#snapshot-list .empty-state") ? document.querySelector("#snapshot-list .empty-state").textContent : "MISSING",
            trendEmpties: document.querySelectorAll(".trend-card.is-empty").length,
            countText: document.getElementById("snapshots-list-count").textContent,
        };
    });
    ok("⑦a 空会话：撤销灰置 + 列表空态（定稿 6.5 文案）", r.undoDisabled === true && r.emptyText.indexOf("还没有快照") !== -1, JSON.stringify(r));
    ok("⑦b 空会话：趋势卡均「暂无对比基线」+ 计数归零", r.trendEmpties === 2 && r.countText === "共 0 个快照会话");

    /* ---- ⑧ 50 次路由往返节点无增长 + console 0 ---- */
    r = await page.evaluate(async () => {
        const countNodes = () => document.querySelectorAll("*").length;
        const before = countNodes();
        for (let i = 0; i < 50; i++) {
            location.hash = i % 2 === 0 ? "#/" : "#/snapshots";
            await new Promise((r) => setTimeout(r, 90));
        }
        location.hash = "#/snapshots";
        await new Promise((r) => setTimeout(r, 600));
        return { before, after: countNodes() };
    });
    ok("⑧a 50 次路由往返后 DOM 节点无增长（下降=toast TTL 到期，非泄漏）", r.after <= r.before + 5, JSON.stringify(r));
    ok("⑧b 阶段1 console/pageerror 0", errs1.length === 0, errs1.join(" | "));

    /* ---- ⑨ 双档零滚动（快照页含趋势数据 + 工作台）+ 800×700 窄屏截图 ---- */
    await page.setViewportSize({ width: 1366, height: 768 });
    await wait(400);
    let z1 = await metricViewport(page, 1366, 768);
    ok("⑨a 1366×768 快照页零滚动", z1.bodySh <= z1.bodyCh + 1, JSON.stringify(z1));
    await page.setViewportSize({ width: 1920, height: 1080 });
    await wait(400);
    let z2 = await metricViewport(page, 1920, 1080);
    ok("⑨b 1920×1080 快照页零滚动", z2.bodySh <= z2.bodyCh + 1, JSON.stringify(z2));
    await page.evaluate(() => { location.hash = "#/"; });
    await wait(700);
    let z3 = await metricViewport(page, 1920, 1080);
    ok("⑨c 1920×1080 工作台零滚动（迷你卡变更后回归）", z3.bodySh <= z3.bodyCh + 1, JSON.stringify(z3));

    /* ---- ⑩ 视觉截图（趋势差值形态：亮 1366 / 暗 1366 / 亮 1920 / 800×700 窄屏） ---- */
    // ⑨ 后 stub 处于 empty 模式且视图 1920——恢复 trend 态并回灌差值卡（模块缓存仍在）
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.evaluate(async () => {
        const m = await import("/static/js/app/main.js");
        // ⑦ 已把 stub 切到 empty（sessionsCache=[]）——恢复 trend 态并回灌差值卡
        // （trendCache 仍持有 ② 的对比结果，refresh 后从缓存渲染不重发）
        window.__stub.snapMode = "trend";
        location.hash = "#/snapshots";
        await window.__wait(() => document.querySelector(".trend-card[data-slot='day']"), 5000);
        await m.refreshSnapshots();
        await window.__wait(() => document.querySelector(".trend-card[data-slot='day'] .trend-delta") &&
                                   document.querySelector(".trend-card[data-slot='week'] .trend-delta"), 8000);
    });
    await wait(400);
    await shot(page, "u33-snapshots-light-1366");
    const darkOk = await page.evaluate(async () => {
        const m = await import("/static/js/app/main.js");
        m.switchTheme("dark", null);
        return document.documentElement.getAttribute("data-theme");
    });
    await wait(500);
    await shot(page, "u33-snapshots-dark-1366");
    ok("⑩a 暗色切换截图（snapshots-dark-1366.png）", darkOk === "dark");
    await page.evaluate(async () => {
        const m = await import("/static/js/app/main.js");
        m.switchTheme("light", null);
    });
    await page.setViewportSize({ width: 1920, height: 1080 });
    await wait(500);
    await shot(page, "u33-snapshots-light-1920");
    await page.setViewportSize({ width: 800, height: 700 });
    await wait(500);
    await shot(page, "u33-snapshots-narrow-800");
    await page.context().close();
    console.log("  截图目录：" + OUT);

    /* ================= 阶段 2：真实页（--with-data；Flask 5000） ================= */
    if (WITH_DATA) {
        console.log("== 阶段 2：真实页（Flask 5000） ==");
        const ctx2 = await browser.newContext({ viewport: { width: 1366, height: 768 } });
        const p2 = await ctx2.newPage();
        const errs2 = [];
        p2.on("console", (m) => {
            if (m.type() !== "error") return;
            // ⚠️ U3.2 注记 4：真实页资源状态日志（browse/compare 并发 409——锁竞争/
            // 扫描在途对既有接口属预存行为，非回归）不计入；其余 console 错误仍严格
            if (/Failed to load resource/i.test(m.text())) return;
            errs2.push("console: " + m.text());
        });
        p2.on("pageerror", (e) => errs2.push("pageerror: " + e.message));
        await p2.addInitScript(() => { try { localStorage.setItem("pds_onboarding_dismissed_v1", "1"); } catch (e) {} });
        await p2.goto(BASE, { waitUntil: "load" });
        await p2.evaluate(() => new Promise((r) => setTimeout(r, 1500)));
        await p2.evaluate(() => { location.hash = "#/snapshots"; });
        await p2.waitForFunction(() => document.querySelector("[data-page='snapshots']"), null, { timeout: 15000 }).catch(() => {});
        await p2.waitForFunction(() => document.querySelectorAll(".trend-card").length === 2, null, { timeout: 15000 }).catch(() => {});
        await new Promise((r) => setTimeout(r, 1000));
        const real = await p2.evaluate(() => ({
            cards: document.querySelectorAll(".trend-card").length,
            items: document.querySelectorAll("#snapshot-list .session-item").length,
            create: document.getElementById("btn-create-snapshot") ? document.getElementById("btn-create-snapshot").disabled : null,
            undo: document.getElementById("btn-undo-save") ? document.getElementById("btn-undo-save").disabled : null,
        }));
        ok("真实页 a：快照页装配（趋势卡×2 + 页头按钮）", real.cards === 2 && real.create !== null && real.undo !== null, JSON.stringify(real));
        const z4 = await metricViewport(p2, 1366, 768);
        ok("真实页 b：1366×768 零滚动", z4.bodySh <= z4.bodyCh + 1, JSON.stringify(z4));
        await shot(p2, "u33-real-snapshots-1366");
        await p2.setViewportSize({ width: 1920, height: 1080 });
        await new Promise((r) => setTimeout(r, 500));
        const z5 = await metricViewport(p2, 1920, 1080);
        ok("真实页 c：1920×1080 零滚动", z5.bodySh <= z5.bodyCh + 1, JSON.stringify(z5));
        ok("真实页 d：console/pageerror 0", errs2.length === 0, errs2.join(" | "));
        await ctx2.close();
    }

    await browser.close();
    console.log("== 结果：" + passCount + "/" + (passCount + failCount) + " ==");
    process.exit(failCount ? 1 : 0);
})();
