/* ============================================================
   P0-3 · p00_frame_recorder.mjs —— A 类帧级记录器（v2，P0 返工修正）
   - 用途：视图切换（排行→关系）的「DOM 帧 + 像素帧」双轨同步取证。
     · DOM 轨：页内 rAF 记录器（≈16.7ms/帧）逐帧采样 #treemap-wrap 的
       hidden / computed opacity / elementFromPoint 归属 / 激活视图 / 动画数；
     · 像素轨：CDP Page.startScreencast（实测 20–46ms/帧）在同一轮序列
       内同步采集 JPEG 像素帧，并按「相对触发点」时间戳与 DOM 轨对齐。
   - 硬闸门：对「排行→关系」切换必须复现 P2 基线的违规帧
     （非活动视图 hidden=false && opacity=1 && elementFromPoint
      落回 treemap-canvas）。P2 基线：rank2relate 63 帧 / 9 违规 /
      首个违规 ts=9946。
   - ⚠️ 知识（P0 返工要点）：page.screenshot() ≈130ms/张，无法覆盖
     33ms 级违规窗口，绝不能作为「帧级」证据；像素级证据一律走 CDP
     screencast。本脚本不再用 page.screenshot 冒充关键帧；唯一的
     page.screenshot 输出是终态图 terminal-relate.png（文件名不含时间戳）。
   - 时间对齐（双时钟锚点）：
     · DOM 帧 ts = page performance.now() - rec.start（页面时钟）；
     · 像素帧 ts = CDP metadata.timestamp*1000 - t0（Node 墙钟派生）；
     · 触发锚点：点击瞬间同时记录 page 时钟 pagePerfAtClick（页内
       evaluate 读取）与 Node 墙钟 nodeWallAtClick（Node 侧就近读取）；
     · 统一换算「相对触发点偏移」：
         domOff(frame)  = frame.ts - (pagePerfAtClick - recStart)
         pxOff(px)      = px.ts - (nodeWallAtClick - t0)
     · 违规窗口 = [domOff(firstBad), domOff(lastBad)]，像素帧落在
       [首-5ms, 末+5ms] 内即标记为 violation-window 像素证据。
   - 参数（统一口径）：
     --base http://127.0.0.1:5000/   --out <绝对路径>
     --repeats 3（每序列轮数，取违规帧最多一轮）
     --with-data（连真后端；默认桩态 fetch 确定性复现）
     --quality 60（CDP screencast JPEG 质量）
   - 输出：
     · frames.json           最差轮全部 DOM 帧
     · summary.json          逐轮 帧数/违规帧数/首末违规偏移 + 对齐锚点
     · screencast/           最差轮全部像素帧 px-<seq>-trig+<off>ms.jpg
                             + px-timeline.json（含 in-window 标记）
     · violation-window/     违规窗口内像素帧副本（问题 2 像素级证据）
     · terminal-relate.png   终态静态图（page.screenshot，无时间戳）
   - 纪律：finally { browser.close() }；headless 默认 true。
   ============================================================ */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { launch, arg, wait, shot, frameRecorderSource, screencast } from "./_harness.mjs";

const BASE = arg("base", "http://127.0.0.1:5000/");
const OUT = path.resolve(arg("out", path.join(os.tmpdir(), "p00_frame_recorder_" + Date.now())));
const WITH_DATA = process.argv.indexOf("--with-data") >= 0;
const REPEATS = parseInt(arg("repeats", "3"), 10);
const QUALITY = parseInt(arg("quality", "60"), 10);
const WIN_TOL = 5; // 违规窗口容差 ms（像素帧采样粒度粗于 DOM，取 ±5ms）

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

function badIndices(frames) {
    const idx = [];
    frames.forEach((f, i) => { if (isBad(f)) idx.push(i); });
    return idx;
}

/* 单轮：返回 { round, domFrames, domBad, domBadOff:[first,last], pxFrames, anchors } */
async function runSequence(page, round, roundOut) {
    /* 每轮都从「上一视图稳定态」出发：先切回 ranking（treemap 外） */
    await page.evaluate(() => document.getElementById("btn-view-ranking").click()).catch(() => {});
    await wait(450); // 终态稳定（crossfade 120ms + 收尾）

    /* rAF 记录器启动（页面时钟） */
    await page.evaluate(() => window.__frameRecAPI.start({ winMs: 0, maxFrames: 100000 }));

    /* CDP screencast 异步启动（Node 墙钟），期间同步进行点击序列 */
    const scDir = path.join(roundOut, "sc");
    const scPromise = screencast(page, { outDir: scDir, durationMs: 1500, quality: QUALITY });

    await wait(100); // 触发前 100ms 稳定基线（DOM ≈6 帧）

    /* 触发锚点：页内读 page 时钟 + 派发点击（合成 click，监听器不校验 isTrusted）；
       Node 侧就近读墙钟。两时钟差 ~1-3ms，字体偏差在报告登记。 */
    const clickPerf = await page.evaluate(() => {
        const t = performance.now();
        const btn = document.getElementById("btn-view-relate");
        const ok = !!btn;
        btn.click();
        return { pagePerfAtClick: t, clicked: ok };
    }).catch((e) => ({ pagePerfAtClick: 0, clicked: false, error: String(e) }));
    const nodeWallAtClick = Date.now();

    if (!clickPerf.clicked) {
        await page.evaluate(() => window.__frameRecAPI.stop());
        await scPromise.catch(() => {});
        return null;
    }

    await wait(1350); // 动画全程(120ms) + 200ms 收尾 + screencast 尾部富余

    /* 停 DOM 记录器，取帧与 rec.start */
    await page.evaluate(() => window.__frameRecAPI.stop());
    const domFrames = await page.evaluate(() => window.__frameRecAPI.frames());
    const recMeta = await page.evaluate(() => window.__frameRecAPI.meta());
    const sc = await scPromise; // 等 screencast 收尾

    /* 时间对齐：统一到「相对触发点偏移」 */
    const recStart = recMeta && recMeta.start ? recMeta.start : (domFrames.length ? domFrames[0].ts : 0);
    const domOff = (ts) => ts - (clickPerf.pagePerfAtClick - recStart);
    const pxOff = (px) => px.ts - (nodeWallAtClick - sc.t0);
    const bad = badIndices(domFrames);
    const domBad = bad.map((i) => ({ idx: i, ts: domFrames[i].ts, off: Math.round(domOff(domFrames[i].ts)), ...domFrames[i] }));
    const domBadOff = domBad.length ? [domBad[0].off, domBad[domBad.length - 1].off] : null;

    /* 像素帧偏移 + 违规窗口标记 */
    const pxFrames = sc.frames.map((px, i) => {
        const off = Math.round(pxOff(px));
        const inWin = domBadOff ? (off >= domBadOff[0] - WIN_TOL && off <= domBadOff[1] + WIN_TOL) : false;
        return { ...px, off, inWin: inWin, order: i };
    });

    return {
        round,
        domFrames,
        domBadCount: domBad.length,
        domBadOff,
        pxFrames,
        anchors: {
            recStart,
            pagePerfAtClick: clickPerf.pagePerfAtClick,
            nodeWallAtClick,
            scT0: sc.t0,
            clickError: clickPerf.error || null,
        },
        scDir,
    };
}

(async () => {
    console.log("== p00_frame_recorder v2 (DOM + CDP pixel) ==");
    console.log("base=" + BASE + " out=" + OUT + " withData=" + WITH_DATA + " repeats=" + REPEATS + " quality=" + QUALITY);
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
        await page.waitForFunction(() => {
            const w = document.getElementById("treemap-wrap");
            return w && !w.hasAttribute("hidden") && w.querySelectorAll("canvas").length > 0;
        }, { timeout: 30000 }).catch(() => { console.log("treemap 未渲染就绪"); });
        await page.waitForTimeout(600);
        await page.evaluate(() => document.getElementById("btn-view-ranking").click()).catch(() => {});
        await wait(600);

        const rounds = [];
        for (let r = 0; r < REPEATS; r++) {
            const roundOut = path.join(OUT, "round-" + (r + 1));
            const run = await runSequence(page, r + 1, roundOut);
            if (!run) { console.log(`round ${r + 1}: 触发失败`); continue; }
            rounds.push(run);
            console.log(`round ${r + 1}: domFrames=${run.domFrames.length} bad=${run.domBadCount}` +
                (run.domBadOff ? ` badOff=[${run.domBadOff[0]},${run.domBadOff[1]}] pxFrames=${run.pxFrames.length} pxInWin=${run.pxFrames.filter((p) => p.inWin).length}` : "") +
                (run.anchors.clickError ? " clickError=" + run.anchors.clickError : ""));
        }
        if (!rounds.length) { console.log("无有效轮次"); process.exit(1); }

        /* 取违规帧最多的一轮为最差轮 */
        rounds.sort((a, b) => b.domBadCount - a.domBadCount || b.domFrames.length - a.domFrames.length);
        const worst = rounds[0];
        const finalFrames = worst.domFrames;
        const px = worst.pxFrames.sort((a, b) => a.order - b.order);
        const inWin = px.filter((p) => p.inWin);

        /* 落盘：DOM 帧 + 摘要 */
        fs.mkdirSync(path.join(OUT, "screencast"), { recursive: true });
        fs.mkdirSync(path.join(OUT, "violation-window"), { recursive: true });
        fs.writeFileSync(path.join(OUT, "frames.json"), JSON.stringify(finalFrames, null, 2), "utf-8");

        const summary = rounds.map((r) => ({
            round: r.round, domFrames: r.domFrames.length, badFrames: r.domBadCount,
            domBadOff: r.domBadOff, pxFrames: r.pxFrames.length, pxInWindow: r.pxFrames.filter((p) => p.inWin).length,
        }));
        fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify({
            meta: { base: BASE, out: OUT, withData: WITH_DATA, repeats: REPEATS, quality: QUALITY, node: process.version, startedAt: new Date().toISOString() },
            alignment_method: "DOM ts=page perf-now - rec.start；px ts=CDP ts - t0；触发锚点 pagePerfAtClick/nodeWallAtClick 双时钟就近读取（偏差 ~1-3ms）；off(frame)=ts-(pagePerfAtClick-recStart)；off(px)=px.ts-(nodeWallAtClick-t0)；违规窗口=[首,末]off ±5ms",
            sequences: summary,
            worst: { round: worst.round, domFrames: worst.domFrames.length, badFrames: worst.domBadCount, domBadOff: worst.domBadOff, anchors: worst.anchors },
        }, null, 2), "utf-8");

        /* 像素帧落盘：screencast/ 全部 + violation-window/ 窗口内副本；文件名为相对触发点真实 ts */
        const pxTimeline = [];
        for (const p of px) {
            const src = path.join(worst.scDir, "screencast-frames", path.basename(p.file));
            if (!fs.existsSync(src)) continue;
            const fname = `px-${String(p.seq).padStart(4, "0")}-trig+${p.off}ms.jpg`;
            const dst = path.join(OUT, "screencast", fname);
            fs.copyFileSync(src, dst);
            pxTimeline.push({ seq: p.seq, off: p.off, inWin: p.inWin, file: path.relative(OUT, dst) });
            if (p.inWin) {
                const vname = `px-${String(p.seq).padStart(4, "0")}-trig+${p.off}ms.jpg`;
                fs.copyFileSync(src, path.join(OUT, "violation-window", vname));
            }
        }
        fs.writeFileSync(path.join(OUT, "screencast", "px-timeline.json"), JSON.stringify({
            meta: { round: worst.round, domBadOff: worst.domBadOff, winTolMs: WIN_TOL, anchors: worst.anchors },
            frames: pxTimeline,
        }, null, 2), "utf-8");

        /* 终态静态图（page.screenshot，无时间戳命名，仅供静态观感） */
        const termPng = path.join(OUT, "terminal-relate.png");
        await shot(page, termPng).catch(() => {});
        fs.writeFileSync(path.join(OUT, "terminal.json"), JSON.stringify({ path: termPng, note: "page.screenshot ≈130ms/张，仅终态观感，不作帧级证据" }, null, 2), "utf-8");

        /* 哈希自证（新像素帧互不相同） */
        const hashes = {};
        for (const p of pxTimeline) {
            const f = path.join(OUT, p.file);
            if (!fs.existsSync(f)) continue;
            const buf = fs.readFileSync(f);
            const h = createHash("sha256").update(buf).digest("hex").toUpperCase();
            hashes[p.file] = h;
        }
        fs.writeFileSync(path.join(OUT, "screencast", "px-hashes.json"), JSON.stringify(hashes, null, 2), "utf-8");
        const unique = new Set(Object.values(hashes));

        console.log("\nsummary.json 已写入: " + path.join(OUT, "summary.json"));
        console.log("frames.json 已写入: " + path.join(OUT, "frames.json"));
        console.log("像素帧 screencast/: " + pxTimeline.length + " 张，哈希 unique=" + unique.size + "/total=" + Object.keys(hashes).length);
        console.log("违规窗口像素 violation-window/: " + inWin.length + " 张");
        console.log("终态图: " + termPng);
        console.log("console/pageerror: " + errs.length);
        if (errs.length) console.log("  errors:\n" + errs.join("\n"));
        const hasBad = worst.domBadCount > 0 && inWin.length > 0;
        console.log("硬闸门结论: " + (hasBad ? "DOM 违规帧 + 窗口内像素帧齐备 ✓" : "未抓到违规帧或窗口内无像素帧 ✖"));
        setTimeout(() => process.exit(hasBad ? 0 : 1), 800).unref();
    } finally {
        await browser.close().catch(() => {});
    }
})();