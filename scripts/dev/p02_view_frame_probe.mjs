/* ============================================================
   阶段 P2（工作区视图切换残留 · 问题 2）· p02_view_frame_probe.mjs
   帧级（rAF）视图切换残留探针 —— **修复前/修复后必须用同一支探针**，
   以其在修复前代码上仍能抓到违规帧自证探针口径未被放宽（P2 红线 A）。

   - 口径来源：`docs/问题核查资料_20260908/P2-视图切换帧级证据.json`（63–69 帧 /
     8–12 违规 / 首违规 opacity=1 且命中 treemap-canvas）。本探针是 P0
     `_harness.frameRecorderSource()` 记录器的**正式化**（同一字段词典 + 更严判据）。
   - 判据（每帧，与 DoD 1/3/4 对齐）：
       · 违规帧 = 帧所属序列目标视图 ≠ treemap，且该帧
         (`#treemap-wrap` 无 hidden 属性 ∨ computed opacity > 0 ∨ 命中测试落在矩形图内)
         —— 即「非矩形图视图下矩形图仍可见/仍拦截命中」；
       · 连点变体（2ms 内同步派发 12 次点击，跨视图交错）= DoD 3「无闪烁式重现」；
       · 隐藏态下 hover 列表行 → 矩形图 canvas 像素签名必须不变（DoD 4）；
       · 骨架屏层序/覆盖（DoD 5）；
       · 矩形图↔列表切换仍须发生 120ms 交叉淡化（DoD 2 的「保留」侧：动画存在 + 入向
         层在上 + 出向层在下 + `pointer-events` 收束）。
   - 采样节奏：rAF ≈16.7ms/帧；每组序列「记录起点 → 60ms 后触发 → 触发后 400ms 停录」
     （覆盖 120ms 动画 + 收尾），要求 ≥60 帧（不达标则记为窗口不足，不得当 PASS）。
   - 输出：`<out>/frames.json`（全帧）+ `<out>/summary.json`（逐序列量化 + 判据结论）。
   - 运行：node scripts/dev/p02_view_frame_probe.mjs --base http://127.0.0.1:5000/ --out <证据目录>
            [--stub]（默认桩态确定性：覆写 fetch，不发真实 /api/browse）
   - 退出码：0 = 全部判据通过；1 = 有违规帧或窗口不足。
   - 纪律：headless + finally browser.close()；不写用户真实数据目录（桩态不发请求）。
   ============================================================ */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { chromium } from "./_harness.mjs";

function arg(name, dflt) {
    const i = process.argv.indexOf("--" + name);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const BASE = arg("base", "http://127.0.0.1:5000/");
const OUT = path.resolve(arg("out", path.join(os.tmpdir(), "p02_view_frame_probe")));
const STUB = process.argv.indexOf("--no-stub") < 0; // 默认桩态
const LABEL = arg("label", "run");

fs.mkdirSync(OUT, { recursive: true });

/* ---------------- 序列定义（问题 2 全序列覆盖） ----------------
   `settleMs` = 触发后停录时长；`tailMs` = 窗口后继续录制的收尾帧（不计入违规计账，
   仅用于核对终态收敛与「闪烁式重现」形态）。窗口 + 前导 + 收尾合计 ≥60 帧 @16.7ms。 */
const SEQ_LIST = [
    { id: "s1_tm2rank2table", by: "click", steps: ["ranking", "table"], settleMs: 421, tailMs: 400 },
    { id: "s2_tm2relate2rank", by: "click", steps: ["relate", "ranking"], settleMs: 421, tailMs: 400 },
    { id: "s3_rank2table2relate", by: "click", steps: ["table", "relate"], settleMs: 421, tailMs: 400 },
    { id: "s4_relate2table2treemap", by: "click", steps: ["table", "treemap"], settleMs: 421, tailMs: 400 },
    { id: "s5_tm2rank2table2relate2rank2table2treemap", by: "click",
      steps: ["ranking", "table", "relate", "ranking", "table", "treemap"], settleMs: 421, tailMs: 400 },
    { id: "s6_burst30ms", by: "click", steps: null, settleMs: 500, tailMs: 500, burst: true },
];
const BURST = ["ranking", "table", "relate", "ranking", "table", "treemap", "ranking", "table",
    "relate", "treemap", "ranking", "table"];
const BURST_GAP_MS = 30;

/* ---------------- 页内 2D 绘制调用拦截器（DoD 4 的可证伪口径） ----------------
   动机：`display:none` 的 canvas 其 GPU/位图后备存储在指针重新进入文档时会被浏览器
   丢弃并重建（实测：一次 hover 后 `getImageData` 由全 0 变为真实 tile 像素），
   因此「像素签名不变」在隐藏态是**伪判据**。改为拦截 canvas 2D 上下文的绘制调用：
   矩形图隐藏期间只要发生任何 fillRect/clearRect/drawImage/… 即为一次真实重绘事件。 */
const CTX_TRAP_SRC = `(() => {
  const calls = { total: 0, byMethod: {} };
  window.__p2paint = calls;
  const DRAW = ["fillRect", "strokeRect", "clearRect", "fillText", "strokeText", "drawImage",
                "fill", "stroke", "putImageData", "beginPath", "rect", "arc", "ellipse"];
  const origGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
    const ctx = origGetContext.call(this, type, ...rest);
    if (type !== "2d" || !ctx || ctx.__p2trapped) return ctx;
    try { ctx.__p2trapped = true; } catch (e) { return ctx; }
    for (const m of DRAW) {
      const fn = ctx[m];
      if (typeof fn !== "function") continue;
      ctx[m] = function (...args) {
        const tm = document.getElementById("treemap-wrap");
        calls.total += 1;
        calls.byMethod[m] = (calls.byMethod[m] || 0) + 1;
        if (tm && tm.hasAttribute("hidden")) calls.whileHidden = (calls.whileHidden || 0) + 1;
        return fn.apply(this, args);
      };
    }
    return ctx;
  };
})();`;

/* ---------------- 桩态 fetch（同 u50/u66 口径：确定性，不发真实 /api/browse） ---------------- */
const STUB_FN = `
window.__stub = { browseCount: 0, startCount: 0 };
window.fetch = function (url, options) {
  options = options || {};
  const key = (options.method || "GET").toUpperCase() + " " + String(url).split("?")[0];
  const json = (o, s) => Promise.resolve({ ok: (s || 200) < 400, status: s || 200, json: () => Promise.resolve(JSON.parse(JSON.stringify(o))) });
  if (key === "OPTIONS /api/fullscan/stop") return json({ ok: true }, 200);
  if (key === "GET /api/health") return json({ ok: true, ready: true, dll: "stub-dll", message: "Everything 已就绪", busy: false });
  if (key === "GET /api/settings") return json({ ok: true, settings: { auto_save: false, last_roots: ["D:\\\\", "C:\\\\"] }, data_dir: "C:\\\\stub\\\\data", snapshots_dir: "C:\\\\stub\\\\snapshots" });
  if (key === "POST /api/settings") return json({ ok: true, settings: {} });
  if (key === "POST /api/browse") { window.__stub.browseCount += 1; return json({ ok: true, root: "D:\\\\", parent: null,
    directories: [ { name: "data", path: "D:\\\\data", is_dir: true, size: 12000, size_human: "11.72 KB" }, { name: "docs", path: "D:\\\\docs", is_dir: true, size: 4000, size_human: "3.91 KB" }, { name: "media", path: "D:\\\\media", is_dir: true, size: 8000, size_human: "7.81 KB" }, { name: "archive", path: "D:\\\\archive", is_dir: true, size: 20000, size_human: "19.53 KB" } ],
    files: [ { name: "readme.txt", path: "D:\\\\readme.txt", is_dir: false, size: 100, size_human: "100 B" }, { name: "pagefile.sys", path: "D:\\\\pagefile.sys", is_dir: false, size: 999999, size_human: "976.56 KB" } ],
    total_dirs: 4, total_files: 2, source: "sdk", source_at: "2026-09-05T12:00:00" }); }
  if (key === "POST /api/fullscan/start") { window.__stub.startCount += 1; return json({ ok: true, message: "ok" }); }
  if (key === "GET /api/fullscan/status") return json({ ok: true, status: { running: false, roots: ["C:\\\\", "D:\\\\"], roots_done: 0, roots_total: 2, current_root: null, error: null, result_ready: false, save_ready: false, progress_pct: 0, scan_version: 1, stop_requested: false, stop_reason: null, phase: "idle", lock_holder: null, row_done: 0, row_total: 0, stop_ack_at: null } });
  if (key === "GET /api/snapshots") return json({ ok: true, sessions: [], count: 0 });
  if (key === "GET /api/overview") return json({ ok: true, ready: false, scanning: false, empty_reason: "no_scan", roots: [] });
  if (key === "GET /api/export") return json({ ok: false, error: "x" }, 404);
  return json({ ok: true });
};
`;

/* ---------------- 页内帧记录器（P0 记录器正式化 + 更严判据字段） ----------------
   帧字段：ts / twHidden / twOpacity / twZ / twClass / tbHidden / tbClass / hit / inTm /
           activeView / mode / acts / tmCanvasHash（矩形图静态 canvas 像素签名）
   API：window.__p2rec.start(maxMs) / .stop() / .frames() / .mark(label) / .canvasHash() */
const REC_SRC = `(() => {
  const rec = { running: false, start: 0, maxMs: 120000, frames: [], marks: [] };
  window.__p2rec = {
    start(maxMs) { rec.running = true; rec.start = performance.now(); rec.frames.length = 0; rec.marks.length = 0;
                   if (maxMs) rec.maxMs = maxMs; requestAnimationFrame(tick); },
    stop() { rec.running = false; },
    frames() { return rec.frames; },
    marks() { return rec.marks; },
    mark(label) { rec.marks.push({ label: label, ts: Math.round(performance.now() - rec.start) }); },
  };
  function locate(el) {
    let hit = "none";
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      if (n.tagName === "CANVAS") { hit = n.className.indexOf("treemap") >= 0 ? "treemap-canvas" : (n.id || "canvas"); break; }
      if (n.tagName === "TD" || n.tagName === "TH") { hit = n.tagName; break; }
      if (n.id && /(treemap|table|relate|rank|tab)/i.test(n.id)) { hit = n.id; break; }
    }
    if (hit === "none") hit = el ? el.tagName : "none";
    return hit;
  }
  function activeView() {
    const b = ["btn-view-treemap", "btn-view-ranking", "btn-view-table", "btn-view-relate"]
      .map((id) => document.getElementById(id)).find((e) => e && e.classList.contains("btn-primary"));
    return b ? b.id : null;
  }
  function modeOf() {
    const a = activeView();
    return a ? a.replace("btn-view-", "") : null;
  }
  function canvasHash() {
    const c = document.querySelector("#treemap-wrap canvas.treemap-canvas:not(.treemap-fx)");
    if (!c || !c.width) return null;
    try {
      const d = c.getContext("2d").getImageData(0, 0, Math.min(c.width, 240), Math.min(c.height, 160)).data;
      let h = 2166136261;
      for (let i = 0; i < d.length; i += 4) { h ^= d[i]; h = (h * 16777619) >>> 0; h ^= d[i + 3]; h = (h * 16777619) >>> 0; }
      return h >>> 0;
    } catch (e) { return null; }
  }
  window.__p2canvasHash = canvasHash;
  function tick() {
    if (!rec.running) return;
    const now = performance.now();
    const tw = document.getElementById("treemap-wrap");
    const tb = document.getElementById("table-wrap");
    const el = document.elementFromPoint(Math.floor(innerWidth / 2), Math.floor(innerHeight / 2));
    const hit = locate(el);
    const cs = tw ? getComputedStyle(tw) : null;
    rec.frames.push({
      ts: Math.round(now - rec.start),
      twHidden: tw ? tw.hasAttribute("hidden") : null,
      twOpacity: cs ? cs.opacity : null,
      twZ: cs ? cs.zIndex : null,
      twClass: tw ? tw.className : null,
      tbHidden: tb ? tb.hasAttribute("hidden") : null,
      tbClass: tb ? tb.className : null,
      hit: hit,
      inTm: hit === "treemap-canvas" || (tw && !!el && tw.contains(el)),
      activeView: activeView(),
      mode: modeOf(),
      acts: document.getAnimations().length,
    });
    if (now - rec.start >= rec.maxMs) { rec.running = false; return; }
    requestAnimationFrame(tick);
  }
})();`;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---- 帧内违规判据（单一实现，逐帧复用） ---- */
function frameViolationReasons(f) {
    const op = f.twOpacity === null ? null : parseFloat(f.twOpacity);
    const reasons = [];
    if (f.targetMode !== "treemap") {
        if (f.twHidden === false) reasons.push("tw-not-hidden");
        if (op !== null && op > 0) reasons.push("tw-opacity>0");
        if (f.inTm === true) reasons.push("hit-treemap");
    }
    return reasons;
}

async function run() {
    const browser = await chromium.launch({ headless: true });
    const RESULT = {
        meta: {
            label: LABEL, base: BASE, out: OUT, stub: STUB, node: process.version,
            startedAt: new Date().toISOString(),
            viewport: { width: 1366, height: 768 },
            criteria: "违规帧 = 目标视图≠treemap 且（twHidden=false ∨ opacity>0 ∨ 命中落在 treemap 内）",
            record_window: "起点 → 60ms → 触发 → +420ms 停录（覆盖 120ms 动画 + 收尾）",
        },
        sequences: [], checks: [], consoleErrors: [],
    };
    const consoleErrors = [];
    let page = null;
    try {
        const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
        page = await ctx.newPage();
        page.on("console", (m) => {
            if (m.type() === "error") {
                const loc = m.location ? m.location() : null;
                if (loc && /favicon\.ico/i.test(loc.url)) return;
                consoleErrors.push("console: " + m.text());
            }
        });
        page.on("pageerror", (e) => consoleErrors.push("pageerror: " + e.message));
        await page.addInitScript(() => {
            try { localStorage.setItem("pds_onboarding_dismissed_v1", "1"); } catch (e) { /* ignore */ }
            try { sessionStorage.setItem("pds_auto_started_v1", "1"); } catch (e) { /* ignore */ }
        });
        if (STUB) await page.addInitScript(STUB_FN);
        await page.addInitScript(CTX_TRAP_SRC);
        await page.addInitScript(REC_SRC);
        await page.goto(BASE, { waitUntil: "load", timeout: 20000 });
        await page.waitForFunction(() => {
            const w = document.getElementById("treemap-wrap");
            return w && !w.hasAttribute("hidden") && w.querySelectorAll("canvas").length > 0;
        }, { timeout: 20000 });
        await page.waitForTimeout(600);

        /* 起点：强制回到 treemap **稳定终态**（确保每序列 prev 明确、无残余动画接管终态）。
           注意：不能只 `.click()`——上次切换的 WAAPI 动画可能仍在跑（seq 守卫会放弃终态收束）。 */
        const probeState = () => page.evaluate(() => {
            const tw = document.getElementById("treemap-wrap");
            const tb = document.getElementById("table-wrap");
            const av = ["btn-view-treemap", "btn-view-ranking", "btn-view-table", "btn-view-relate"]
                .map((id) => document.getElementById(id)).find((e) => e && e.classList.contains("btn-primary"));
            const cs = tw ? getComputedStyle(tw) : null;
            const csb = tb ? getComputedStyle(tb) : null;
            return {
                activeView: av ? av.id : null,
                twHidden: tw ? tw.hasAttribute("hidden") : null,
                twOpacity: cs ? cs.opacity : null,
                twClass: tw ? tw.className : null,
                tbHidden: tb ? tb.hasAttribute("hidden") : null,
                tbDisplay: csb ? csb.display : null,
                tbClass: tb ? tb.className : null,
                anims: document.getAnimations().map((a) => ({
                    target: a.effect && a.effect.target ? (a.effect.target.id || a.effect.target.className) : "?",
                    state: a.playState,
                })),
                /* ⚠️ fill:"forwards" 的动画结束后仍留在 getAnimations()（playState="finished"），
                   只有 running/pending 才是「真在跑」——收敛判据必须按此口径。 */
                animsLive: document.getAnimations().filter((a) => a.playState === "running" || a.playState === "pending").length,
            };
        });
        const baseReset = async () => {
            const need = await page.evaluate(() => {
                const av = ["btn-view-treemap", "btn-view-ranking", "btn-view-table", "btn-view-relate"]
                    .map((id) => document.getElementById(id)).find((e) => e && e.classList.contains("btn-primary"));
                return !av || av.id !== "btn-view-treemap";
            });
            if (need) await page.evaluate(() => document.getElementById("btn-view-treemap").click());
            let last = null;
            for (let i = 0; i < 50; i++) { // 最长 5s
                last = await probeState();
                /* ⚠️ #table-wrap 用的是 `.hidden` **类**（不是 hidden 属性）；
                   #treemap-wrap 用的是 hidden **属性**（.treemap-wrap[hidden]{display:none!important}）。 */
                const tbHiddenOk = last.tbDisplay === "none" && String(last.tbClass).indexOf("hidden") >= 0;
                const ok = last.twHidden === false && parseFloat(last.twOpacity) === 1 &&
                    tbHiddenOk && last.animsLive === 0;
                if (ok) { await page.waitForTimeout(150); return { ok: true, state: last }; }
                await page.waitForTimeout(100);
            }
            RESULT.resetFailures = RESULT.resetFailures || [];
            RESULT.resetFailures.push(last);
            console.log("  ! baseReset 未收敛: " + JSON.stringify(last));
            return { ok: false, state: last };
        };

        for (const seq of SEQ_LIST) {
            await baseReset();
            /* 记录窗 = 触发前 60ms + 全序列（每步 settleMs）+ 尾部 tailMs + 1.2s 余量 */
            const seqSpan = seq.burst ? BURST.length * BURST_GAP_MS + seq.settleMs : seq.steps.length * seq.settleMs;
            await page.evaluate((ms) => window.__p2rec.start(ms), 60 + seqSpan + (seq.tailMs || 200) + 1200);
            await page.waitForTimeout(60); // 触发前基线帧
            const t0 = await page.evaluate(() => performance.now());
            await page.evaluate(() => window.__p2rec.mark("trigger"));
            let targets;
            if (seq.burst) {
                /* 30ms 连点（≥10 次）：页内定时器派发，避免 Node↔浏览器往返抖动 */
                await page.evaluate(({ modes, gap }) => {
                    window.__p2clicks = [];
                    modes.forEach((m, i) => setTimeout(() => {
                        const b = document.getElementById("btn-view-" + m);
                        if (b) b.click();
                        window.__p2clicks.push({ m: m, ts: Math.round(performance.now()) });
                    }, i * gap));
                }, { modes: BURST, gap: BURST_GAP_MS });
                targets = BURST;
                await page.waitForTimeout(BURST.length * BURST_GAP_MS + seq.settleMs);
            } else {
                targets = seq.steps;
                for (const m of seq.steps) {
                    await page.click("#btn-view-" + m, { timeout: 5000 });
                    await page.waitForTimeout(seq.settleMs);
                }
            }
            /* 停录多等 tailMs：把窗口后的收尾帧一并纳入 frames.json（用于核对终态收敛，
               不参与违规计账），并让每组序列稳定达到 ≥60 帧。 */
            await page.waitForTimeout(seq.tailMs || 200);
            const t1 = await page.evaluate(() => performance.now());
            const raw = await page.evaluate(() => { window.__p2rec.stop(); return window.__p2rec.frames(); });
            const marks = await page.evaluate(() => window.__p2rec.marks());
            const clicks = seq.burst ? await page.evaluate(() => (window.__p2clicks || [])) : [];
            const finalState = await page.evaluate(() => {
                const tw = document.getElementById("treemap-wrap");
                const tb = document.getElementById("table-wrap");
                const av = ["btn-view-treemap", "btn-view-ranking", "btn-view-table", "btn-view-relate"]
                    .map((id) => document.getElementById(id)).find((e) => e && e.classList.contains("btn-primary"));
                const cs = tw ? getComputedStyle(tw) : null;
                const csb = tb ? getComputedStyle(tb) : null;
                return {
                    activeView: av ? av.id : null,
                    twHidden: tw ? tw.hasAttribute("hidden") : null,
                    twDisplay: cs ? cs.display : null,
                    twZ: cs ? cs.zIndex : null,
                    twClass: tw ? tw.className : null,
                    tbHidden: tb ? tb.hasAttribute("hidden") : null,
                    tbDisplay: csb ? csb.display : null,
                    tbZ: csb ? csb.zIndex : null,
                    tbClass: tb ? tb.className : null,
                    visibleCanvas: Array.from(document.querySelectorAll("canvas")).filter((c) => {
                        const r = c.getClientRects();
                        if (!r || !r.length) return false;
                        const s = getComputedStyle(c);
                        return s.display !== "none" && s.visibility !== "hidden" && r[0].width > 0 && r[0].height > 0;
                    }).length,
                };
            });

            /* 逐帧标注「本帧所属序列目标视图」：多步序列按 marks 分段（触发点为锚，
               每步 span = (末帧时间 - 触发时间) / 步数；触发前帧 target = 首步） */
            const frames = [];
            const markMap = {};
            for (const mk of marks) markMap[mk.label] = mk.ts;
            const stepCount = seq.burst ? BURST.length : seq.steps.length;
            const spanEnd = raw.length ? raw[raw.length - 1].ts : 0;
            const triggerTs = markMap.trigger !== undefined ? markMap.trigger : (raw.length ? raw[0].ts : 0);
            const span = Math.max(1, spanEnd - triggerTs);
            const per = span / stepCount;
            for (const f of raw) {
                let idx = f.ts <= triggerTs ? 0
                    : Math.min(stepCount - 1, Math.floor((f.ts - triggerTs) / per));
                const target = seq.burst ? BURST[idx] : seq.steps[idx];
                /* 违规计账窗：触发点 → 触发点 + 步数×settleMs + 200ms 收尾
                   （触发前基线帧与窗口后残余帧不参与违规计账，但保留在 frames.json 供核对） */
                const windowEnd = triggerTs + stepCount * seq.settleMs + 200;
                frames.push({
                    ...f, stepIdx: idx, targetMode: target,
                    phase: f.ts <= triggerTs ? "pre" : (f.ts <= windowEnd ? "in_window" : "post"),
                });
            }
            const judged = [];
            const flashEvents = [];
            for (let i = 0; i < frames.length; i++) {
                const f = frames[i];
                const reasons = frameViolationReasons(f);
                /* 「闪烁式重现」= 窗口内矩形图由不可见 → 可见的跃迁（DoD 3 的形态判据） */
                if (f.phase === "in_window" && i > 0) {
                    const prev = frames[i - 1];
                    if (prev.twHidden === true && f.twHidden === false) {
                        flashEvents.push({ ts: f.ts, targetMode: f.targetMode, twOpacity: f.twOpacity, hit: f.hit });
                    }
                }
                judged.push({ ...f, violation: reasons.length > 0, reasons });
            }
            const bad = judged.filter((f) => f.violation);
            const badIn = bad.filter((f) => f.phase === "in_window");
            const histo = {};
            for (const f of judged) histo[f.targetMode] = (histo[f.targetMode] || 0) + 1;
            const histoIn = {};
            for (const f of judged.filter((x) => x.phase === "in_window")) {
                histoIn[f.targetMode] = (histoIn[f.targetMode] || 0) + 1;
            }
            const summary = {
                id: seq.id,
                by: seq.by,
                steps: seq.burst ? BURST : seq.steps,
                burstGapMs: seq.burst ? BURST_GAP_MS : null,
                frames_total: judged.length,
                frames_in_window: judged.filter((f) => f.phase === "in_window").length,
                frames_pre: judged.filter((f) => f.phase === "pre").length,
                frames_post: judged.filter((f) => f.phase === "post").length,
                frames_by_target: histo,
                frames_by_target_in_window: histoIn,
                badFrames: bad.length,
                badFramesInWindow: badIn.length,
                badByTarget: bad.reduce((m, f) => { m[f.targetMode] = (m[f.targetMode] || 0) + 1; return m; }, {}),
                badTsRange: bad.length ? [bad[0].ts, bad[bad.length - 1].ts] : null,
                firstBad: bad.length ? bad[0] : null,
                firstSix: judged.slice(0, 6),
                triggerTs: triggerTs,
                flashEvents: flashEvents,
                flashEventsInWindow: flashEvents.filter((e) => e.ts > triggerTs && e.ts <= triggerTs + stepCount * seq.settleMs + 200).length,
                clicks: clicks.length ? clicks : null,
                clickCount: seq.burst ? clicks.length : seq.steps.length,
                elapsedMs: Math.round(t1 - t0),
                finalState,
                windowOk: judged.length >= 60,
            };
            summary.flashTotal = flashEvents.length;
            RESULT.sequences.push({ summary, frames: judged });
            console.log("[" + seq.id + "] frames=" + summary.frames_total + " inWindow=" + summary.frames_in_window +
                " bad=" + summary.badFramesInWindow + " flash=" + summary.flashEventsInWindow +
                " byTarget=" + JSON.stringify(histoIn) + " clicks=" + summary.clickCount +
                " final=" + finalState.activeView);
        }

        /* 终态稳定等待（visibility 语义 + 无在跑动画）；hover/骨架屏/交叉淡化测量前统一调用 */
        const settleView = async (mode) => {
            await page.evaluate((m) => {
                const b = document.getElementById("btn-view-" + m);
                if (b) b.click();
            }, mode);
            await page.waitForFunction((m) => {
                const tw = document.getElementById("treemap-wrap");
                const tb = document.getElementById("table-wrap");
                if (!tw || !tb) return false;
                const cs = getComputedStyle(tw);
                const csb = getComputedStyle(tb);
                const live = document.getAnimations()
                    .filter((a) => a.playState === "running" || a.playState === "pending").length;
                if (live !== 0) return false;
                /* ⚠️ #table-wrap 的可见性语义 = `.hidden` 类；#treemap-wrap = hidden 属性 */
                const tbHiddenOk = csb.display === "none" && tb.classList.contains("hidden");
                return m === "treemap"
                    ? !tw.hasAttribute("hidden") && parseFloat(cs.opacity) === 1 && tbHiddenOk
                    : tw.hasAttribute("hidden") && parseFloat(cs.opacity) === 0;
            }, mode, { timeout: 8000, polling: 100 });
            await page.waitForTimeout(150);
        };

        /* ---- DoD 4：隐藏态下 hover 列表行不触发矩形图重绘 ----
           口径（可证伪；已排除伪判据）：
             · 主判据 = 页内 canvas 2D 绘制调用拦截器在「矩形图隐藏期间」的计数增量必须为 0
               （任何 fill/clear/drawImage 都是真实重绘）；
             · 副判据 = #treemap-wrap 全 hover 相位保持 `hidden` 属性 + computed opacity=0；
             · 代理判据 = 隐藏节点的 getBoundingClientRect() 恒为 0×0（display:none）——
               代理节点变化即「重绘」在视觉上可见；
             · ⚠️ 已作废判据：隐藏态 canvas 的 `getImageData` 像素签名。实测原因：`display:none`
               的 canvas 其位图后备存储在指针重新进入文档时被浏览器丢弃/重建（一次 hover 后
               由全 0 变为真实 tile 像素，nonZeroPixels 0→38400），与页面代码无关，
               该判据即使对修复前代码也「失败」，属口径缺陷，不得用作 PASS/FAIL 依据。 */
        await settleView("ranking");
        const hoverProbe = await page.evaluate(async () => {
            const tw = document.getElementById("treemap-wrap");
            window.__p2ev = { move: 0, leave: 0, resize: 0, scan: 0, anim: 0 };
            const onMove = () => { window.__p2ev.move += 1; };
            const onLeave = () => { window.__p2ev.leave += 1; };
            const onResize = () => { window.__p2ev.resize += 1; };
            const onScan = () => { window.__p2ev.scan += 1; };
            tw.addEventListener("pointermove", onMove, true);
            tw.addEventListener("pointerleave", onLeave, true);
            window.addEventListener("resize", onResize);
            window.addEventListener("pds:scan", onScan);
            const proxy = () => {
                const r = tw.getBoundingClientRect();
                return Math.round(r.width) + "x" + Math.round(r.height) + "/" + getComputedStyle(tw).display;
            };
            const sample = async (ms) => {
                const t0 = performance.now();
                let proxyChanges = 0, proxy0 = proxy(), frames = 0;
                while (performance.now() - t0 < ms) {
                    frames += 1;
                    if (proxy() !== proxy0) proxyChanges += 1;
                    if (document.getAnimations().some((a) => a.playState === "running")) window.__p2ev.anim += 1;
                    await new Promise((r) => setTimeout(r, 60));
                }
                return { proxyChanges, proxy0, frames };
            };
            const el = document.elementFromPoint(Math.floor(innerWidth / 2), Math.floor(innerHeight / 2));
            const centerHit = el ? (el.id || el.className || el.tagName) : "none";
            /* 对照组：静置 1200ms（与 hover 相位等长）——期间亦不得有任何绘制调用 */
            const paintBeforeControl = window.__p2paint.total;
            const hiddenBeforeControl = window.__p2paint.whileHidden || 0;
            const control = await sample(1200);
            const controlPaint = window.__p2paint.total - paintBeforeControl;
            const twBefore = { hidden: tw.hasAttribute("hidden"), op: getComputedStyle(tw).opacity, rect: proxy() };
            const rows = document.querySelectorAll("#dir-body tr");
            const evIdle = JSON.parse(JSON.stringify(window.__p2ev));
            return {
                control, controlPaint, hiddenBeforeControl, centerHit, twBefore, rows: rows.length, evIdle,
                paintTotal: window.__p2paint.total,
            };
        });
        const hoverSteps = [];
        if (hoverProbe.rows > 0) {
            for (let i = 0; i < hoverProbe.rows; i++) {
                await page.hover("#dir-body tr:nth-child(" + (i + 1) + ")").catch(() => {});
                await page.waitForTimeout(120);
                hoverSteps.push(await page.evaluate((idx) => {
                    const tw = document.getElementById("treemap-wrap");
                    const row = document.querySelector("#dir-body tr:nth-child(" + idx + ")");
                    const link = row ? row.classList.contains("row-linked") : null;
                    return {
                        idx: idx,
                        rowLinked: link,
                        twHidden: tw.hasAttribute("hidden"), twOp: getComputedStyle(tw).opacity,
                        paintTotal: window.__p2paint.total,
                        paintWhileHidden: window.__p2paint.whileHidden || 0,
                        events: JSON.parse(JSON.stringify(window.__p2ev)),
                    };
                }, i + 1));
            }
        }
        const hoverAfter = await page.evaluate(() => {
            const tw = document.getElementById("treemap-wrap");
            return {
                paintTotal: window.__p2paint.total,
                paintWhileHidden: window.__p2paint.whileHidden || 0,
                paintByMethod: window.__p2paint.byMethod,
                events: window.__p2ev,
                twAfter: { hidden: tw.hasAttribute("hidden"), op: getComputedStyle(tw).opacity },
            };
        });
        /* hover 相位（含其间的 tick）净增的隐藏态绘制调用 */
        const hoverPaintDelta = hoverAfter.paintTotal - hoverProbe.paintTotal;
        const lastStep = hoverSteps.length ? hoverSteps[hoverSteps.length - 1] : null;
        const hoverStepPaintDelta = lastStep ? lastStep.paintTotal - hoverProbe.paintTotal : 0;
        const hoverSig = {
            rows_hovered: hoverProbe.rows,
            center_hit: hoverProbe.centerHit,
            criteria: "隐藏期间 canvas 2D 绘制调用增量 == 0",
            control_idle_ms: 1200,
            control_proxy_changes: hoverProbe.control.proxyChanges,
            control_proxy_value: hoverProbe.control.proxy0,
            control_paint_delta: hoverProbe.controlPaint,
            paint_total_at_control_start: hoverProbe.paintTotal,
            paint_total_after_hover: hoverAfter.paintTotal,
            paint_delta_during_hover: hoverPaintDelta,
            paint_delta_during_hover_steps: hoverStepPaintDelta,
            paint_while_hidden_after: hoverAfter.paintWhileHidden,
            paint_by_method: hoverAfter.paintByMethod,
            events_control: hoverProbe.evIdle,
            events_after_hover: hoverAfter.events,
            steps: hoverSteps,
            tw_before: hoverProbe.twBefore,
            tw_after: hoverAfter.twAfter,
            pass: hoverProbe.rows > 0 &&
                hoverProbe.controlPaint === 0 && hoverPaintDelta === 0 &&
                hoverAfter.paintWhileHidden === 0 &&
                hoverProbe.control.proxyChanges === 0 &&
                hoverAfter.twAfter.hidden === true && parseFloat(hoverAfter.twAfter.op) === 0,
        };
        RESULT.hover = hoverSig;
        console.log("[hover] rows=" + hoverSig.rows_hovered + " centerHit=" + hoverSig.center_hit +
            " 代理节点=" + hoverSig.control_proxy_value + " 对照组代理变化=" + hoverSig.control_proxy_changes +
            " 绘制调用 Δ 对照=" + hoverSig.control_paint_delta + " hover=" + hoverSig.paint_delta_during_hover +
            " 隐藏期绘制=" + hoverSig.paint_while_hidden_after + " pass=" + hoverSig.pass);

        /* ---- DoD 5：骨架屏覆盖视区（层序 + 覆盖几何；覆盖判据按边框容差 ≤2px） ---- */
        const skeleton = await page.evaluate(() => {
            const area = document.getElementById("view-area");
            const load = document.getElementById("browse-loading");
            const tw = document.getElementById("treemap-wrap");
            if (!area || !load) return { error: "missing #view-area/#browse-loading" };
            const wasHidden = load.classList.contains("hidden");
            load.classList.remove("hidden");
            const ra = area.getBoundingClientRect();
            const rl = load.getBoundingClientRect();
            const csLoad = getComputedStyle(load);
            const csTw = tw ? getComputedStyle(tw) : null;
            const mid = { x: Math.floor(rl.left + rl.width / 2), y: Math.floor(rl.top + rl.height / 2) };
            const el = document.elementFromPoint(mid.x, mid.y);
            const hits = !!(el && load.contains(el));
            const border = parseFloat(csTw ? csTw.borderTopWidth : "0") || 0;
            const tol = Math.max(2, Math.ceil(border) + 1); // .table-wrap 1px 边框内缩
            const covers = rl.width >= ra.width - tol && rl.height >= ra.height - tol;
            const out = {
                viewArea: { w: Math.round(ra.width), h: Math.round(ra.height) },
                overlay: { w: Math.round(rl.width), h: Math.round(rl.height) },
                tol: tol,
                overlay_z: csLoad.zIndex, overlay_pos: csLoad.position,
                treemap_z: csTw ? csTw.zIndex : null,
                hitIsOverlay: hits, coversViewArea: covers,
                pass: covers && hits && Number(csLoad.zIndex) > Number(csTw && csTw.zIndex !== "auto" ? csTw.zIndex : 0),
            };
            if (wasHidden) load.classList.add("hidden");
            return out;
        });
        RESULT.skeleton = skeleton;
        console.log("[skeleton] " + JSON.stringify(skeleton));

        /* ---- DoD 2「保留」侧：矩形图↔列表切换仍发生 120ms 交叉淡化 ----
           在 table 稳定态下触发「切回矩形图」，用页内 rAF 逐帧采样（不截图，130ms/张 不可用）：
           入向 .treemap-wrap 必须在出向 .table-wrap **之上**（数值 z-index），
           交叉淡化期间两者均 pointer-events:none（不得拦截命中测试），收束后恢复。 */
        await settleView("table");
        const xfade = await page.evaluate(async () => {
            const tw = document.getElementById("treemap-wrap");
            const tb = document.getElementById("table-wrap");
            const waitFrame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
            const samples = [];
            const t0 = performance.now();
            document.getElementById("btn-view-treemap").click();
            for (let i = 0; i < 30; i++) {
                await waitFrame();
                const csTw = getComputedStyle(tw);
                const csTb = getComputedStyle(tb);
                samples.push({
                    off: Math.round(performance.now() - t0),
                    twOpacity: csTw.opacity, twZ: csTw.zIndex, twHidden: tw.hasAttribute("hidden"),
                    twClass: tw.className, twPE: csTw.pointerEvents,
                    tbOpacity: csTb.opacity, tbZ: csTb.zIndex, tbHidden: tb.hasAttribute("hidden"),
                    tbClass: tb.className, tbPE: csTb.pointerEvents,
                    acts: document.getAnimations().length,
                });
            }
            const finalCs = {
                twZ: getComputedStyle(tw).zIndex, twPE: getComputedStyle(tw).pointerEvents,
                tbDisplay: getComputedStyle(tb).display, twHidden: tw.hasAttribute("hidden"),
                tbHidden: tb.hasAttribute("hidden"),
            };
            return { samples, finalCs };
        });
        const overlayFrames = xfade.samples.filter((s) => s.twHidden === false && s.tbHidden === false);
        const mid = overlayFrames.filter((s) => {
            const o1 = parseFloat(s.twOpacity);
            const o2 = parseFloat(s.tbOpacity);
            return o1 > 0 && o1 < 1 && o2 > 0 && o2 < 1;
        });
        const xfadeOut = {
            overlayFrames: overlayFrames.length,
            midOpacityFrames: mid.length,
            maxActs: Math.max(0, ...xfade.samples.map((s) => s.acts)),
            zIncoming: overlayFrames.length ? overlayFrames[0].twZ : null,
            zOutgoing: overlayFrames.length ? overlayFrames[0].tbZ : null,
            enteringOnTop: overlayFrames.length ? overlayFrames.every((s) => Number(s.twZ) > Number(s.tbZ)) : null,
            peNoneDuring: overlayFrames.length ? overlayFrames.every((s) => s.twPE === "none" && s.tbPE === "none") : null,
            finalZ: xfade.finalCs,
            samples: xfade.samples,
            pass: overlayFrames.length > 0 && mid.length > 0 &&
                overlayFrames.every((s) => Number(s.twZ) > Number(s.tbZ)) &&
                overlayFrames.every((s) => s.twPE === "none" && s.tbPE === "none") &&
                xfade.finalCs.twPE === "auto" && xfade.finalCs.twHidden === false &&
                xfade.finalCs.tbDisplay === "none",
        };
        RESULT.crossfade = xfadeOut;
        console.log("[crossfade] overlayFrames=" + xfadeOut.overlayFrames + " midOpacity=" + xfadeOut.midOpacityFrames +
            " zIncoming=" + xfadeOut.zIncoming + " zOutgoing=" + xfadeOut.zOutgoing +
            " enteringOnTop=" + xfadeOut.enteringOnTop + " peNone=" + xfadeOut.peNoneDuring + " pass=" + xfadeOut.pass);

        /* ---- 判据汇总 ---- */
        const totalBad = RESULT.sequences.reduce((s, q) => s + q.summary.badFramesInWindow, 0);
        const totalInWindow = RESULT.sequences.reduce((s, q) => s + q.summary.frames_in_window, 0);
        const totalFlash = RESULT.sequences.reduce((s, q) => s + q.summary.flashEventsInWindow, 0);
        const minFrames = Math.min(...RESULT.sequences.map((q) => q.summary.frames_total));
        const burstSeq = RESULT.sequences.find((q) => q.summary.burstGapMs);
        RESULT.totals = { badFramesInWindow: totalBad, framesInWindow: totalInWindow, flashEvents: totalFlash };
        RESULT.checks = [
            { name: "探针有效窗口：每组序列 rAF ≥60 帧（最小 " + minFrames + "）", pass: minFrames >= 60 },
            { name: "DoD1 全部序列窗口内 0 违规帧（实际 " + totalBad + " / 窗口内 " + totalInWindow + " 帧）", pass: totalBad === 0 },
            { name: "DoD2 矩形图↔列表 120ms 交叉淡化保留（入向在上 + pointer-events 收束）", pass: xfadeOut.pass === true },
            { name: "DoD3 30ms 连点 " + (burstSeq ? burstSeq.summary.clickCount : 0) + " 次无闪烁式重现（违规 " +
              (burstSeq ? burstSeq.summary.badFramesInWindow : -1) + " / 重现事件 " +
              (burstSeq ? burstSeq.summary.flashEventsInWindow : -1) + "）",
              pass: !!burstSeq && burstSeq.summary.badFramesInWindow === 0 &&
                  burstSeq.summary.flashEventsInWindow === 0 && burstSeq.summary.clickCount >= 10 },
            { name: "DoD4 隐藏态 hover 列表行不触发矩形图重绘（" + hoverSig.rows_hovered + " 行；绘制调用 Δ 对照 " +
              hoverSig.control_paint_delta + " / hover " + hoverSig.paint_delta_during_hover +
              " / 隐藏期累计 " + hoverSig.paint_while_hidden_after + "）", pass: hoverSig.pass === true },
            { name: "DoD5 骨架屏覆盖视区且层序在矩形图之上", pass: skeleton.pass === true },
            { name: "console/pageerror 0", pass: consoleErrors.length === 0, detail: consoleErrors.join(" | ") },
        ];
    } catch (e) {
        RESULT.fatal = String((e && e.stack) || e);
        RESULT.checks.push({ name: "探针运行异常", pass: false, detail: RESULT.fatal });
    } finally {
        RESULT.consoleErrors = consoleErrors;
        RESULT.finishedAt = new Date().toISOString();
        fs.writeFileSync(path.join(OUT, "frames.json"), JSON.stringify(
            RESULT.sequences.map((q) => ({ id: q.summary.id, frames: q.frames })), null, 2), "utf-8");
        fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(RESULT, null, 2), "utf-8");
        await browser.close().catch(() => {});
    }

    console.log("\n== p02_view_frame_probe (" + LABEL + ") ==");
    for (const c of RESULT.checks) console.log((c.pass ? "  ✔ " : "  ✖ ") + c.name + (c.pass ? "" : " :: " + (c.detail || "")));
    console.log("out=" + OUT + " (frames.json + summary.json)");
    const fails = RESULT.checks.filter((c) => !c.pass).length;
    console.log("判据 " + RESULT.checks.length + " 项，失败 " + fails + " 项");
    return fails;
}

run().then((fails) => process.exit(fails ? 1 : 0)).catch((e) => { console.error(e); process.exit(1); });
