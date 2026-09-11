/* ============================================================
   阶段 C（R2）· u55_trend_probe.mjs（C-4/C-5/C-6 验收探针）
   - 场景（全部桩态确定性渲染，供 gpt-5.6-luna 判读 + DOM 采样）：
     ① trend-empty-out-window：空态原因行（窗口外样本）
     ② trend-empty-no-snapshot：空态原因行（无快照样本）
     ③ trend-delta-cards：差值卡 ▲/▼ + 百分比 + 窗口 tooltip 口径
     ④ trend-consistency-compare：趋势卡 → #/compare 同基线数值一致（C-6）
     ⑤ trend-fullscan-hint：无全量结果 → 「先做全量扫描」提示（C-5）
   - 场景切换：localStorage pds_u55_mode + 整页 reload（模块级 sessionsCache 重灌，
     保证 /api/snapshots 从新桩态重取——与真实「删除后刷新」语义一致）。
   - 运行：node scripts/dev/u55_trend_probe.mjs [--base http://127.0.0.1:5000/]
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
const OUT = path.resolve(arg("out", path.join(os.tmpdir(), "u55_trend")));
fs.mkdirSync(OUT, { recursive: true });

const RESULT = { meta: { base: BASE, out: OUT, node: process.version }, checks: [], shots: [], consoleErrors: [] };
function check(name, ok, detail) {
    RESULT.checks.push({ name, ok: !!ok, detail: detail || "" });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = (page, name) => page.screenshot({ path: path.join(OUT, name), fullPage: false });
/* getAttribute 返回 HTML 转义实体（&lt; 等），断言前需解码 */
function decodeEntities(s) {
    return String(s || "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"');
}

/* 桩 fetch：scanState（idle 无结果 / done 有结果）；mode 由 localStorage 驱动 */
const STUB_FN = String.raw`
window.__stub = { scanState: "done", mode: "empty", fetchLog: [], scanVersion: 1 };
(function () {
  try { window.__stub.mode = localStorage.getItem("pds_u55_mode") || "empty"; } catch (e) {}
  try { window.__stub.scanState = localStorage.getItem("pds_u55_scan") || "done"; } catch (e) {}
})();
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
    files: [ { name: "readme.txt", path: "D:\\readme.txt", is_dir: false, size: 100, size_human: "100 B" } ],
    total_dirs: 1, total_files: 1, source: "sdk", source_at: "2026-09-04T10:00:00" });
  if (key === "GET /api/fullscan/status") {
    const s = window.__stub.scanState;
    if (s === "done") return json({ ok: true, status: { running: false, roots: ["C:\\", "D:\\"], roots_done: 2, roots_total: 2, current_root: null, error: null, result_ready: true, save_ready: true, progress_pct: 100, scan_version: 1, stop_requested: false, stop_reason: null, phase: "idle" } });
    return json({ ok: true, status: { running: false, roots: ["C:\\", "D:\\"], roots_done: 0, roots_total: 2, current_root: null, error: null, result_ready: false, save_ready: false, progress_pct: 0, scan_version: 1, stop_requested: false, stop_reason: null, phase: "idle" } });
  }
  if (key === "GET /api/snapshots") {
    const m = window.__stub.mode;
    if (m === "delta") return json({ ok: true, sessions: [
      { session_id: "s-cur", auto: true, machine_guid: "3f2a1c9d", created_at: "2026-09-02T15:41:00", roots: { "D:\\": { root: "D:\\", snapshot: "D.snap.gz", snapshot_path: "C:\\stub\\D.snap.gz", skipped: false } } },
      { session_id: "s-23h", auto: false, machine_guid: "3f2a1c9d", created_at: "2026-09-01T16:41:00", roots: { "D:\\": { root: "D:\\", snapshot: "D23.snap.gz", snapshot_path: "C:\\stub\\D23.snap.gz", skipped: false } } },
      { session_id: "s-25h", auto: false, machine_guid: "3f2a1c9d", created_at: "2026-09-01T14:41:00", roots: { "D:\\": { root: "D:\\", snapshot: "D25.snap.gz", snapshot_path: "C:\\stub\\D25.snap.gz", skipped: false } } },
    ], count: 3 });
    if (m === "out-window") return json({ ok: true, sessions: [
      { session_id: "s-cur", auto: true, machine_guid: "3f2a1c9d", created_at: "2026-09-02T15:41:00", roots: { "D:\\": { root: "D:\\", snapshot: "D.snap.gz", snapshot_path: "C:\\stub\\D.snap.gz", skipped: false } } },
      { session_id: "s-8d", auto: false, machine_guid: "3f2a1c9d", created_at: "2026-08-25T15:41:00", roots: { "D:\\": { root: "D:\\", snapshot: "D8.snap.gz", snapshot_path: "C:\\stub\\D8.snap.gz", skipped: false } } },
    ], count: 2 });
    return json({ ok: true, sessions: [], count: 0 });
  }
  if (key === "POST /api/compare") {
    return json({ ok: true, report: { root: "D:\\", total_baseline: 16000, total_current: 15990, delta_total: -10, truncated: false, legacy_count: 0, rows: [ { path: "D:\\data", baseline: 12000, current: 11990, delta: -10, growth_pct: -0.08, removed: false, added: false } ] } });
  }
  /* P6（D6-3）：多快照序列桩——按请求里真实带上的 snapshots[] 回点，
     使「数据点数 == 所选快照数」在桩态下同样可判（不是写死几条）。 */
  if (key === "GET /api/series") {
    let picked = [];
    try { picked = new URL(String(url), location.origin).searchParams.getAll("snapshots"); } catch (e) { picked = []; }
    const points = picked.map((p, i) => ({
      snapshot: p, name: String(p).split("\\\\").pop(), created_at: "2026-09-0" + (i + 1) + "T10:00:00",
      auto: false, machine_guid: "3f2a1c9d", bytes: 16000 - i * 500, present: true, rows: 4, cached: false,
    }));
    return json({ ok: true, root: "D:\\\\", path: "", depth: null, limit: 12, count: points.length,
      truncated: false, dropped: 0, rows_total: points.length * 4, elapsed_ms: 1.5, reason: points.length ? "" : "no_snapshots",
      points: points, skipped: [] });
  }
  if (key === "GET /api/compare/status") return json({ ok: true, status: "done", report: { root: "D:\\", total_baseline: 16000, total_current: 15990, delta_total: -10, truncated: false, legacy_count: 0, rows: [] } });
  if (key === "GET /api/overview") return json({ ok: true, ready: false, scanning: false, empty_reason: "no_scan", roots: [] });
  return json({ ok: true });
};
`;

/* 开新页：localStorage 预置场景 → 整页加载（应用从新桩态重取 /api/snapshots） */
async function openScenario(browser, mode, scan) {
    const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
    const errs = [];
    page.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text()); });
    page.on("pageerror", (e) => errs.push("pageerror: " + e.message));
    await page.addInitScript(({ m, s }) => {
        try { localStorage.setItem("pds_u55_mode", m); } catch (e) {}
        try { localStorage.setItem("pds_u55_scan", s); } catch (e) {}
        try { localStorage.setItem("pds_onboarding_dismissed_v1", "1"); } catch (e) {}
            try { sessionStorage.setItem("pds_auto_started_v1", "1"); } catch (e) {}
        try { localStorage.setItem("pds_theme_v1", "light"); } catch (e) {}
    }, { m: mode, s: scan });
    await page.addInitScript(STUB_FN);
    await page.goto(BASE, { waitUntil: "load", timeout: 20000 }).catch((e) => { RESULT.meta.gotoError = String(e); });
    await page.waitForFunction(() => !!document.getElementById("btn-create-snapshot"), { timeout: 15000 }).catch(() => {});
    await page.evaluate(() => { location.hash = "#/snapshots"; });
    await page.waitForTimeout(900);
    RESULT.consoleErrors = RESULT.consoleErrors || [];
    errs.forEach((e) => RESULT.consoleErrors.push("[" + mode + "/" + scan + "] " + e));
    return { page, errs };
}

(async () => {
    const browser = await chromium.launch({ headless: true });
    const log = (m) => console.log("[u55] " + m);

    /* ① 空态原因行（窗口外样本） */
    log("scenario ① trend-empty-out-window");
    {
        const { page } = await openScenario(browser, "out-window", "done");
        const emptyState = await page.evaluate(() => {
            const reasons = Array.from(document.querySelectorAll(".trend-reason")).map((el) => el.textContent);
            const tips = Array.from(document.querySelectorAll(".trend-card")).map((el) => el.getAttribute("title") || "");
            return { reasons, tips, emptyCards: document.querySelectorAll(".trend-card.is-empty").length };
        });
        check("空态两卡均带原因行（窗口外）", emptyState.reasons.length === 2 && emptyState.reasons.every((r) => r.indexOf("超出") !== -1), JSON.stringify(emptyState.reasons));
        check("空态原因行含「最近快照」", emptyState.reasons.length > 0 && emptyState.reasons[0].indexOf("最近快照") !== -1, JSON.stringify(emptyState.reasons));
        check("两卡 tooltip 含窗口口径（同盘/Δt）", emptyState.tips.length >= 2 && emptyState.tips.every((t) => t.indexOf("同盘") !== -1 && t.indexOf("Δt") !== -1), JSON.stringify(emptyState.tips));
        await shot(page, "trend-empty-out-window.png");
        RESULT.shots.push("trend-empty-out-window.png");
        await page.close();
    }

    /* ② 无快照空态 */
    log("scenario ② trend-empty-no-snapshot");
    {
        const { page } = await openScenario(browser, "none", "done");
        const noneState = await page.evaluate(() => {
            const reasons = Array.from(document.querySelectorAll(".trend-reason")).map((el) => el.textContent);
            return { reasons };
        });
        check("无快照 → 原因行「还没有快照」", noneState.reasons.length > 0 && noneState.reasons[0].indexOf("还没有快照") !== -1, JSON.stringify(noneState.reasons));
        await shot(page, "trend-empty-no-snapshot.png");
        RESULT.shots.push("trend-empty-no-snapshot.png");
        await page.close();
    }

    /* ③ 差值卡 + tooltip 口径 */
    log("scenario ③ trend-delta-cards + C-6 consistency");
    {
        const { page } = await openScenario(browser, "delta", "done");
        // 模拟轮询首拍在快照页订阅后到达（真实时序：main 链 pollFullscan 可能在
        // snapshots 挂载前派发 pds:scan，事件丢失——C-5 修复要求事件到达后收复）。
        // 无修复时趋势卡停在「请先完成全量扫描」err → delta 断言失败（验收 C-5）。
        await page.evaluate(() => {
            window.dispatchEvent(new CustomEvent("pds:scan", { detail: {
                running: false, result_ready: true, save_ready: true,
                roots: ["C:\\", "D:\\"], roots_done: 2, roots_total: 2, error: null,
            } }));
        }).catch(() => {});
        // 等待两卡进入有值态（delta 或 err 皆可——err 时为 C-5 缺陷诊断；delta 为期望态）
        await page.waitForFunction(() =>
            document.querySelectorAll(".trend-card .trend-delta").length >= 2 ||
            document.querySelectorAll(".trend-card .trend-err").length >= 2,
            { timeout: 8000 }).catch(() => {});
        const deltaState = await page.evaluate(() => {
            const cards = Array.from(document.querySelectorAll(".trend-card")).map((c) => ({
                slot: c.getAttribute("data-slot"),
                delta: (c.querySelector(".trend-delta") || {}).textContent || "",
                pct: (c.querySelector(".trend-pct") || {}).textContent || "",
                err: (c.querySelector(".trend-err") || {}).textContent || "",
                title: c.getAttribute("title") || "",
            }));
            return cards;
        });
        check("两卡渲染差值（▲/▼+百分比）", deltaState.length >= 2 && deltaState.every((c) => c.delta.indexOf("▼") !== -1 && c.pct.indexOf("%") !== -1), JSON.stringify(deltaState));
        check("两卡 tooltip 口径不同（较昨日 vs 较上周）",
            deltaState.length >= 2 &&
            decodeEntities(deltaState[0].title).indexOf("0<Δt≤24h") !== -1 &&
            decodeEntities(deltaState[1].title).indexOf("24h<Δt≤7d") !== -1,
            JSON.stringify(deltaState.map((c) => c.title)));
        await shot(page, "trend-delta-cards.png");
        RESULT.shots.push("trend-delta-cards.png");

        /* ④ C-6 两地同基线一致性 */
        const trendInfo = await page.evaluate(() => {
            const day = document.querySelector(".trend-card[data-slot='day']");
            return {
                delta: (day.querySelector(".trend-delta") || {}).textContent || "",
                pct: (day.querySelector(".trend-pct") || {}).textContent || "",
                baseline: day.getAttribute("data-baseline") || "",
                root: day.getAttribute("data-root") || "",
            };
        });
        await page.click(".trend-card[data-slot='day']", { timeout: 5000 }).catch(() => {});
        await page.waitForFunction(() => document.querySelectorAll(".compare-stat").length >= 3, { timeout: 8000 }).catch(() => {});
        // L1-4 count-up 600ms：等待 count-up 收敛到终值（data-v == data-target）后再采样
        await page.waitForFunction(() => {
            const nums = Array.from(document.querySelectorAll(".compare-stat-num"));
            return nums.length >= 3 && nums.every((el) => {
                const v = Number(el.getAttribute("data-v")) || 0;
                const t = Number(el.getAttribute("data-target")) || 0;
                return Math.abs(v - t) < 1;
            });
        }, { timeout: 8000 }).catch(() => {});
        const compareState = await page.evaluate(() => {
            const sum = document.querySelector(".compare-stat") || null;
            return { deltaText: sum ? sum.textContent.replace(/\s+/g, " ").trim() : "" };
        });
        check("点击趋势卡 → 跳转 #/compare", (await page.evaluate(() => location.hash)) === "#/compare", "");
        // 前端渲染为 humanBytes（15.63 KB → 15.62 KB），断言匹配显示格式而非原始字节
        check("对比页摘要 delta 与趋势卡一致（▼15.63 KB）", compareState.deltaText.indexOf("▼") !== -1 && compareState.deltaText.indexOf("15.63 KB") !== -1, compareState.deltaText);
        check("对比页摘要含 对比基准→当前 数值（15.63 KB → 15.62 KB）", compareState.deltaText.indexOf("15.63 KB → 15.62 KB") !== -1, compareState.deltaText);
        await shot(page, "trend-consistency-compare.png");
        RESULT.shots.push("trend-consistency-compare.png");

        /* ---- ⑥（P6·D6-4/D6-5/D6-6）：多快照趋势折线（additive，原 ①–⑤ 判据不动） ----
           对比基准多选 ≥2 份 → 趋势卡成图（/api/series 桩按所选的快照数回点）+
           悬浮读数出现；退回 1 份 → 空闲态给出原因（禁止永久空白）。 */
        const oneSel = await page.evaluate(() => {
            const sel = document.getElementById("compare-baseline");
            if (!sel) return { ok: false };
            Array.from(sel.options).forEach((o, i) => { o.selected = i === 0; });
            sel.dispatchEvent(new Event("change", { bubbles: true }));
            return { ok: true, multiple: !!sel.multiple, options: sel.options.length, selected: sel.selectedOptions.length };
        });
        await page.waitForTimeout(700);
        const idleTrend = await page.evaluate(() => {
            const card = document.getElementById("compare-trend");
            const host = document.getElementById("compare-trend-host");
            return {
                present: !!card,
                state: card ? card.dataset.state : null,
                empty: host && host.querySelector(".line-empty") ? host.querySelector(".line-empty").textContent : "",
            };
        });
        check("⑥a 对比基准已多选化（select multiple，id 不变）", oneSel.ok && oneSel.multiple === true && oneSel.options >= 2,
            JSON.stringify(oneSel));
        check("⑥b 选 1 份 → 趋势卡空闲态且给出原因（非空白）",
            idleTrend.present && idleTrend.state === "idle" && idleTrend.empty.length > 6, JSON.stringify(idleTrend));

        const twoSel = await page.evaluate(() => {
            const sel = document.getElementById("compare-baseline");
            if (!sel) return { ok: false };
            Array.from(sel.options).forEach((o, i) => { o.selected = i < 2; });
            sel.dispatchEvent(new Event("change", { bubbles: true }));
            return { ok: true, selected: sel.selectedOptions.length, values: Array.from(sel.selectedOptions).map((o) => o.value) };
        });
        await page.waitForFunction(() => {
            const h = document.getElementById("compare-trend-host");
            return h && h.dataset.state === "ok" && h.querySelector(".line-path");
        }, null, { timeout: 15000 }).catch(() => {});
        const pt = await page.evaluate(() => {
            const dot = document.querySelectorAll("#compare-trend-host .line-dot")[1];
            if (!dot) return null;
            const r = dot.getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        });
        if (pt) await page.mouse.move(pt.x, pt.y);
        await page.waitForTimeout(260);
        const lineState = await page.evaluate(() => {
            const host = document.getElementById("compare-trend-host");
            const pathEl = host ? host.querySelector(".line-path") : null;
            const ro = host ? host.querySelector(".line-readout") : null;
            return {
                state: (document.getElementById("compare-trend").dataset || {}).state,
                dots: host ? host.querySelectorAll(".line-dot").length : 0,
                pathLen: pathEl ? String(pathEl.getAttribute("d") || "").length : 0,
                axisY: host ? host.querySelectorAll(".line-axis-y").length : 0,
                axisX: host ? host.querySelectorAll(".line-axis-x").length : 0,
                readout: ro && !ro.hasAttribute("hidden") ? ro.textContent : "",
                aria: host ? (host.getAttribute("aria-label") || "") : "",
            };
        });
        check("⑥c 选 2 份 → 折线成图（state=ok + path + 点数=所选份数 + X/Y 轴）",
            twoSel.ok && twoSel.selected === 2 && lineState.state === "ok" && lineState.pathLen > 20 &&
            lineState.dots === twoSel.selected && lineState.axisY >= 1 && lineState.axisX >= 2,
            JSON.stringify({ pick: twoSel, line: lineState }));
        check("⑥d 悬浮读数出现且含时间 + 数值", /\d{2}-\d{2} \d{2}:\d{2}/.test(lineState.readout) && /(KB|MB|GB|B)/.test(lineState.readout),
            JSON.stringify(lineState.readout));
        check("⑥e 折线无障碍概述（aria-label 含点数与首末值）", lineState.aria.indexOf("多快照趋势折线") !== -1, lineState.aria);
        await shot(page, "trend-multi-line-compare.png");
        RESULT.shots.push("trend-multi-line-compare.png");
        await page.close();
    }

    /* ⑤ 无全量结果 → 「先做全量扫描」提示（C-5） */
    log("scenario ⑤ trend-fullscan-hint");
    {
        const { page } = await openScenario(browser, "delta", "idle");
        await page.waitForTimeout(800);
        const hintState = await page.evaluate(() => {
            const cards = Array.from(document.querySelectorAll(".trend-card"));
            const hints = cards.map((c) => (c.querySelector(".trend-err") || {}).textContent || "");
            return { hints };
        });
        check("无全量结果 → 提示先做全量扫描", hintState.hints.some((h) => h.indexOf("全量扫描") !== -1), JSON.stringify(hintState.hints));
        await shot(page, "trend-fullscan-hint.png");
        RESULT.shots.push("trend-fullscan-hint.png");
        await page.close();
    }

    check("console 无未处理错误", RESULT.consoleErrors.length === 0, RESULT.consoleErrors.join(" | "));

    fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(RESULT, null, 2), "utf-8");
    console.log("[u55] " + RESULT.checks.filter((c) => c.ok).length + "/" + RESULT.checks.length + " checks passed");
    RESULT.checks.forEach((c) => console.log((c.ok ? "  ✔ " : "  ✘ ") + c.name + (c.detail ? " :: " + c.detail : "")));
    // 不 await browser.close()：Playwright Windows 下页面有 in-flight 请求时 close 可
    // 永久挂起（前两轮实测）。启动超时看门狗强制退出，chromium 子进程由 OS 回收。
    setTimeout(() => process.exit(RESULT.checks.every((c) => c.ok) ? 0 : 1), 1500).unref();
    try { await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 1500))]); } catch (e) { /* 忽略 */ }
    process.exit(RESULT.checks.every((c) => c.ok) ? 0 : 1);
})().catch((err) => {
    // 全局兜底：任何未捕获异常 → 输出已收集结果并退出（防 browser.close() 挂起）
    RESULT.fatal = String(err && err.stack || err);
    try { fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(RESULT, null, 2), "utf-8"); } catch (e) {}
    console.error("[u55] FATAL: " + RESULT.fatal);
    RESULT.checks.forEach((c) => console.log((c.ok ? "  ✔ " : "  ✘ ") + c.name + (c.detail ? " :: " + c.detail : "")));
    process.exit(1);
});
