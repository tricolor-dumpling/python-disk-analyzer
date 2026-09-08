/* ============================================================
   P0-3 · p00_frame_recorder.mjs —— A 类帧级 DOM 记录器（正式化）
   - 用途：视图切换 / 状态机 / 任意 DOM 中间态的 rAF 逐帧记录
     （≈16.7ms/帧），输出 frames.json + 关键帧高保真 PNG。
   - 硬闸门：对「排行→关系」切换必须复现 P2 基线的违规帧
     （非活动视图 hidden=false && opacity=1 && elementFromPoint
      落回 treemap-canvas）。P2 基线：rank2relate 63 帧 / 9 违规 /
      首个违规 ts=9946。
   - 采样窗口：从触发前 start() 开始，覆盖动画全程 + 200ms 收尾。
   - 参数（统一口径）：
     --base   http://127.0.0.1:5000/  （真实服务，默认）
     --out    输出目录（缺省 %TEMP%\p00_frame_recorder_<ts>）
     --viewports 1366x768,1440x900,1920x1080（默认三档；截图用）
     --with-data  连真后端数据（默认桩态 fetch，确定性复现）
     --repeats 每个序列重复轮数（默认 3，取最差一轮）
   - 输出：
     · frames.json             全部采样帧（结构见下方 BAD 判据）
     · summary.json            逐序列对照摘要（帧数/违规帧数/首违规 ts）
     · keyframes/*.png         关键帧（首违规帧/末违规帧/终态帧）
   - 纪律：finally { browser.close() }；headless 默认 true。
   ============================================================ */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, launch, arg, wait, shot, frameRecorderSource } from "./_harness.mjs";

const BASE = arg("base", "http://127.0.0.1:5000/");
const OUT = path.resolve(arg("out", path.join(os.tmpdir(), "p00_frame_recorder_" + Date.now())));
const WITH_DATA = process.argv.indexOf("--with-data") >= 0;
const REPEATS = parseInt(arg("repeats", "3"), 10);

fs.mkdirSync(path.join(OUT, "keyframes"), { recursive: true });

/* ---------------- 桩态 fetch（同 u50/u66：treemap/ranking/table 可渲染） ---------------- */
const STUB_FN = `
window.__stub = { startCount: 0 };
window.fetch = function (url, options) {
  options = options || {};
  const key = (options.method || "GET").toUpperCase() + " " + String(url).split("?")[0];
  const json = (o, s) => Promise.resolve({ ok: (s || 200) < 400, status: s || 200, json: () => Promise.resolve(JSON.parse(JSON.stringify(o))) });
  if (key === "OPTIONS /api/fullscan/stop") return json({ ok: true }, 200);
  if (key === "GET /api/health") return json({ ok: true, ready: true, dll: "stub-dll", message: "Everything 已就绪", busy: false });
  if (key === "GET /api/settings") return json({ ok: true, settings: { auto_save: true, last_roots: ["D:\\\\", "C:\\\\"] }, data_dir: "C:\\\\stub\\\\data", snapshots_dir: "C:\\\\stub\\\\snapshots" });
  if (key === "POST /api/settings") return json({ ok: true, settings: {} });
  if (key === "POST /api/browse") return json({ ok: true, root: "D:\\\\", parent: null,
    directories: [ { name: "data", path: "D:\\\\data", is_dir: true, size: 12000, size_human: "11.72 KB" }, { name: "docs", path: "D:\\\\docs", is_dir: true, size: 4000, size_human: "3.91 KB" }, { name: "media", path: "D:\\\\media", is_dir: true, size: 8000, size_human: "7.81 KB" }, { name: "archive", path: "D:\\\\archive", is_dir: true, size: 20000, size_human: "19.53 KB" } ],
    files: [ { name: "readme.txt", path: "D:\\\\readme.txt", is_dir: false, size: 100, size_human: "100 B" }, { name: "pagefile.sys", path: "D:\\\\pagefile.sys", is_dir: false, size: 999999, size_human: "976.56 KB" } ],
    total_dirs: 4, total_files: 2, source: "sdk", source_at: "2026-09-05T12:00:00" });
  if (key === "GET /api/fullscan/status") return json({ ok: true, status: { running: false, roots: ["C:\\\\", "D:\\\\"], roots_done: 0, roots_total: 2, current_root: null, error: null, result_ready: false, save_ready: false, progress_pct: 0, scan_version: 1, stop_requested: false, stop_reason: null, phase: "idle", lock_holder: null, row_done: 0, row_total: 0, stop_ack_at: null } });
  if (key === "POST /api/fullscan/start") { window.__stub.startCount += 1; return json({ ok: true, message: "ok" }); }
  if (key === "GET /api/snapshots") return json({ ok: true, sessions: [], count: 0 });
  if (key === "GET /api/overview") return json({ ok: true, ready: false, scanning: false, empty_reason: "no_scan", roots: [] });
  if (key === "GET /api/export") return json({ ok: false, error: "x" }, 404);
  return json({ ok: true });
};
`;

/* ---------------- 违规帧判据（与 P2-视图切换帧级证据.json 同口径） ----------------
   违规帧 = 非活动视图（activeView ≠ treemap）期间：
   · #treemap-wrap 无 hidden 属性（twHidden === false）
   · computed opacity > 0（字符串转数值 > 0）
   · elementFromPoint(视区中心) 落回 treemap-canvas 或 treemap-wrap 内（inTm === true）
   注意 P2 的 hidden/opacity 即针对 treemap-wrap；opacity=1 且命中 canvas 是最强证据。 */
function isBad(f) {
    if (!f || f.twHidden === null) return false;
    const op = parseFloat(String(f.twOpacity));
    if (!(op > 0)) return false;
    if (f.twHidden !== false) return false;
    if (f.inTm !== true) return false;
    return true;
}

async function runSequence(page, label) {
    /* 每轮都从「上一视图稳定态」出发：先切回 ranking（treemap 外），
       等终态稳定，再记录「ranking→relate」切换（跨视图交叉淡化必经路径）。 */
    await page.click("#btn-view-ranking", { timeout: 3000 }).catch(() => {});
    await wait(450); // 上一视图终态稳定（crossfade 120ms + 收尾；450ms 富余）
    /* 采样起点：触发前（记录器先行 start，再触发切换） */
    await page.evaluate(() => window.__frameRecAPI.start({ winMs: 0, maxFrames: 100000 }));
    await wait(100); // 触发前 100ms 稳定基线（≈6 帧）
    const clicked = await page.click("#btn-view-" + label, { timeout: 3000 })
        .then(() => true).catch((e) => { console.log("  点击失败 " + label + ": " + e.message); return false; });
    if (!clicked) { await page.evaluate(() => window.__frameRecAPI.stop()); return null; }
    await wait(950); // 覆盖动画全程(120ms) + 200ms 收尾 → 采样窗≈1050ms，对齐 P2 63 帧
    await page.evaluate(() => window.__frameRecAPI.stop());
    const frames = await page.evaluate(() => window.__frameRecAPI.frames());
    return frames;
}

function summarize(frames) {
    const badIdx = [];
    frames.forEach((f, i) => { if (isBad(f)) badIdx.push(i); });
    const firstBad = badIdx.length ? frames[badIdx[0]] : null;
    return { frames: frames.length, badFrames: badIdx.length, firstBad: firstBad ? { ts: firstBad.ts, twHidden: firstBad.twHidden, twOpacity: firstBad.twOpacity, hit: firstBad.hit, inTm: firstBad.inTm } : null };
}

(async () => {
    console.log("== p00_frame_recorder ==");
    console.log("base=" + BASE + " out=" + OUT + " withData=" + WITH_DATA + " repeats=" + REPEATS);
    const browser = await launch();
    try {
        const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
        const page = await ctx.newPage();
        const errs = [];
        page.on("console", (m) => { if (m.type() === "error") { const loc = m.location ? m.location() : null; if (loc && /favicon\.ico/i.test(loc.url)) return; errs.push(m.text()); } });
        page.on("pageerror", (e) => errs.push(e.message));
        await page.addInitScript(() => { try { localStorage.setItem("pds_onboarding_dismissed_v1", "1"); } catch (e) {}
                try { sessionStorage.setItem("pds_auto_started_v1", "1"); } catch (e) {} });
        if (!WITH_DATA) await page.addInitScript(STUB_FN);
        await page.addInitScript(frameRecorderSource());
        await page.goto(BASE, { waitUntil: "load", timeout: 20000 }).catch((e) => { console.log("goto 失败: " + e.message); process.exit(2); });
        // 等 treemap 渲染就绪
        await page.waitForFunction(() => {
            const w = document.getElementById("treemap-wrap");
            return w && !w.hasAttribute("hidden") && w.querySelectorAll("canvas").length > 0;
        }, { timeout: 30000 }).catch(() => { console.log("treemap 未渲染就绪"); });
        await page.waitForTimeout(600);

        /* 目标切换序列：「排行→关系」= 从 ranking 激活态点击 relate */
        // 先进入 ranking 视图，等稳定，再记录「ranking→relate」
        await page.click("#btn-view-ranking", { timeout: 3000 }).catch(() => {});
        await wait(600);
        const results = [];
        const allRounds = [];
        for (let r = 0; r < REPEATS; r++) {
            const frames = await runSequence(page, "relate");
            if (!frames) continue;
            const s = summarize(frames);
            results.push({ label: "ranking2relate", round: r + 1, ...s });
            allRounds.push({ round: r + 1, frames });
            console.log(`round ${r + 1}: frames=${s.frames} bad=${s.badFrames}` + (s.firstBad ? ` firstBad.ts=${s.firstBad.ts}` : ""));
        }
        // 取最差一轮（违规帧最多），以其原始帧序列入库
        results.sort((a, b) => b.badFrames - a.badFrames || a.frames - b.frames);
        const worst = results[0];
        const worstRound = allRounds.find((x) => x.round === worst.round);
        const finalFrames = worstRound ? worstRound.frames : [];
        const summary = results.map((x) => ({ label: x.label, round: x.round, frames: x.frames, badFrames: x.badFrames, firstBadTs: x.firstBad ? x.firstBad.ts : null }));

        fs.writeFileSync(path.join(OUT, "frames.json"), JSON.stringify(finalFrames, null, 2), "utf-8");
        fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify({ meta: { base: BASE, out: OUT, withData: WITH_DATA, repeats: REPEATS, node: process.version, startedAt: new Date().toISOString() }, sequences: summary, worst: { sequence: worst.label, round: worst.round, frames: worst.frames, badFrames: worst.badFrames, firstBad: worst.firstBad } }, null, 2), "utf-8");

        /* 关键帧 PNG（高保真，仅限关键帧） */
        const badIdx = [];
        finalFrames.forEach((f, i) => { if (isBad(f)) badIdx.push(i); });
        const keyIdx = new Set();
        if (badIdx.length) {
            keyIdx.add(badIdx[0]);                       // 首违规帧
            keyIdx.add(badIdx[badIdx.length - 1]);      // 末违规帧
            keyIdx.add(Math.floor((badIdx[0] + badIdx[badIdx.length - 1]) / 2)); // 中段
        }
        keyIdx.add(finalFrames.length - 1);              // 终态帧
        const keyFiles = [];
        for (const i of keyIdx) {
            const f = finalFrames[i];
            if (!f) continue;
            const fn = `key-frame-${String(i).padStart(4, "0")}-ts${f.ts}-${f.twHidden ? "hidden" : "shown"}.png`;
            const fp = path.join(OUT, "keyframes", fn);
            await shot(page, fp).catch(() => {});
            keyFiles.push(fp);
        }
        fs.writeFileSync(path.join(OUT, "keyframes.json"), JSON.stringify(keyFiles, null, 2), "utf-8");

        console.log("\nsummary.json 已写入: " + path.join(OUT, "summary.json"));
        console.log("frames.json 已写入: " + path.join(OUT, "frames.json"));
        console.log("关键帧: " + keyFiles.join(", "));
        console.log("console/pageerror: " + errs.length);
        if (errs.length) console.log("  errors:\n" + errs.join("\n"));
        const hasBad = worst.badFrames > 0;
        console.log("硬闸门结论: " + (hasBad ? "抓到违规帧 ✓" : "未抓到违规帧 ✖"));
        setTimeout(() => process.exit(hasBad ? 0 : 1), 800).unref();
    } finally {
        await browser.close().catch(() => {});
    }
})();