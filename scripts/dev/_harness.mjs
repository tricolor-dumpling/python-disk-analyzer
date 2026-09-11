/* ============================================================
   P0-3 视觉验收工具链统一入口 _harness.mjs
   - 统一 Playwright / Chromium 路径（环境变量可覆盖），消灭
     C:/Users/26024/... 与 C:/Users/Laptop/... 硬编码。
   - 导出：
     · PW_PATH      Playwright 包路径（PDS_PW 覆盖）
     · CHROMIUM_EXE Chromium 可执行路径（PDS_CHROME 覆盖）
     · chromium     Proxy 包装：launch() 自动注入 executablePath
                    （已有 executablePath / channel 时不注入，兼容 msedge）
     · launch()     chromium.launch({ executablePath, headless:true })
     · arg(name, dflt)   --name value 参数解析
     · wait(ms)          Promise 延时
     · shot(page, file, clip)  page.screenshot 封装（clip 可选）
     · frameRecorderSource()   页内 rAF 帧记录器源码（注入用）
     · screencast(page, opts)  CDP Page.startScreencast 帧序列
   - 依赖：仅 Node 标准库 + Playwright（本机 profile）。
   ============================================================ */

import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);

export const PW_PATH = process.env.PDS_PW ||
    "C:/Users/Laptop/.dsh/profiles/web/node_modules/playwright";
export const CHROMIUM_EXE = process.env.PDS_CHROME ||
    "C:/Users/Laptop/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe";

const { chromium: rawChromium } = require(PW_PATH);

/* Proxy 包装 chromium.launch：
   - 既有探针调用 chromium.launch({ headless: true })（无 executablePath），
     本机 playwright 1.63 期望 chromium-1243，只有 1234 → 必须自动注入。
   - 若调用方已传 executablePath 或 channel（如 msedge），不注入，避免冲突。 */
function makeLaunch(raw) {
    return (opts = {}) => {
        const o = { ...opts };
        if (!o.executablePath && !o.channel) o.executablePath = CHROMIUM_EXE;
        return raw(o);
    };
}

export const chromium = new Proxy(rawChromium, {
    get(target, prop) {
        if (prop === "launch") return makeLaunch(target.launch.bind(target));
        return target[prop];
    },
});

export function launch(opts = {}) {
    const o = { headless: true, ...opts };
    if (!o.executablePath && !o.channel) o.executablePath = CHROMIUM_EXE;
    return rawChromium.launch(o);
}

export function arg(name, dflt) {
    const i = process.argv.indexOf("--" + name);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

export const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export async function shot(page, file, clip) {
    const opts = { path: file, fullPage: false };
    if (clip) opts.clip = clip;
    await page.screenshot(opts);
    return file;
}

/* ---------------- 页内 rAF 帧记录器（A 类：DOM 状态逐帧） ----------------
   注入：await page.addInitScript(frameRecorderSource) 或 page.evaluate(frameRecorderSource)
   控制：window.__frameRecAPI.start({ winMs, maxFrames }) / .stop() / .frames()
   字段词典（与 P2-视图切换帧级证据.json 对齐）：
     ts        相对记录起点的 ms（performance.now 差值）
     twHidden  #treemap-wrap.hasAttribute("hidden")
     twOpacity #treemap-wrap computed opacity（字符串）
     hit       elementFromPoint(视区中心) 的归属标识：
               treemap-canvas / table-canvas / relate-容器 id /
               rank-容器 id / TD/TH 行元素 / 最近祖先 id / 元素 tagName
     inTm      命中是否落在 treemap 画布/容器内
     activeView 当前激活视图按钮 id（.btn-primary）
     acts      运行中动画数 document.getAnimations().length
   违规帧判据（与 P2 同口径）：activeView ≠ treemap 且 !twHidden 且
     parseFloat(twOpacity)>0 且 inTm —— 即非活动视图仍在显示并拦截命中测试。 */
export function frameRecorderSource() {
    return `(() => {
  const rec = { running: false, start: 0, config: { winMs: 0, maxFrames: 100000 }, frames: [] };
  function locate(el) {
    let hit = "none";
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      if (n.tagName === "CANVAS") { hit = n.id || "canvas"; break; }
      if (n.tagName === "TD" || n.tagName === "TH") { hit = n.tagName; break; }
      if (n.id && /(treemap|table|relate|rank|tab)/i.test(n.id)) { hit = n.id; break; }
    }
    if (hit === "none") hit = el ? el.tagName : "none";
    return hit;
  }
  function tick() {
    if (!rec.running) return;
    const now = performance.now();
    const tw = document.getElementById("treemap-wrap");
    const el = document.elementFromPoint(Math.floor(innerWidth / 2), Math.floor(innerHeight / 2));
    const hit = locate(el);
    // 激活视图：优先四个视图按钮（btn-view-*），避免顶部扫描钮等其它 .btn-primary 干扰
    const viewBtn = ["btn-view-treemap", "btn-view-ranking", "btn-view-table", "btn-view-relate"]
        .map((id) => document.getElementById(id))
        .find((b) => b && b.classList.contains("btn-primary"));
    const active = viewBtn || document.querySelector(".btn-primary");
    const inTm = hit === "treemap-canvas" || (tw && !!el && tw.contains(el));
    rec.frames.push({
      ts: Math.round(now - rec.start),
      twHidden: tw ? tw.hasAttribute("hidden") : null,
      twOpacity: tw ? getComputedStyle(tw).opacity : null,
      hit,
      inTm,
      activeView: active ? (active.id || null) : null,
      acts: document.getAnimations().length,
    });
    if ((rec.config.winMs > 0 && now - rec.start >= rec.config.winMs) ||
        rec.frames.length >= rec.config.maxFrames) { rec.running = false; return; }
    requestAnimationFrame(tick);
  }
  window.__frameRecAPI = {
    start(opts) { rec.running = true; rec.start = performance.now(); Object.assign(rec.config, opts || {}); rec.frames.length = 0; requestAnimationFrame(tick); },
    stop() { rec.running = false; },
    frames() { return rec.frames; },
    meta() { return { start: rec.start }; },
  };
})();`;
}

/* ---------------- CDP screencast（B 类：逐帧像素帧序列） ----------------
   opts: { outDir, durationMs, quality(默认 60), onFrame(page, meta) 可选 }
   输出：<outDir>/frames/frame-<n>-<ts>.jpg + <outDir>/timeline.json
     （每帧：seq / ts(ms 相对起点) / jpeg 文件相对路径）
   帧含页面自身时间戳 metadata.timestamp（秒），换算为相对 ms。
   调用方负责在结束后自行关闭 browser。 */
export async function screencast(page, opts) {
    const { outDir, durationMs = 2000, quality = 60, onFrame, maxWidth, maxHeight } = opts || {};
    const framesDir = path.join(outDir, "screencast-frames");
    fs.mkdirSync(framesDir, { recursive: true });
    const client = await page.context().newCDPSession(page);
    const timeline = [];
    let seq = 0;
    const t0 = Date.now();
    client.on("Page.screencastFrame", async ({ data, sessionId, metadata }) => {
        const rawTs = Math.round((metadata.timestamp * 1000) - t0);
        seq += 1;
        const fname = `frame-${String(seq).padStart(4, "0")}-${rawTs}ms.jpg`;
        const fpath = path.join(framesDir, fname);
        fs.writeFileSync(fpath, Buffer.from(data, "base64"));
        /* seq = 回调到达序（稳定排序键）；rawTs=CDP metadata 时间戳推算（可能微抖动） */
        timeline.push({ seq, ts: rawTs, rawTs, file: path.relative(outDir, fpath) });
        if (onFrame) await onFrame(page, { seq, ts: rawTs, rawTs, metadata });
        try { await client.send("Page.screencastFrameAck", { sessionId }); }
        catch (e) { /* ack 失败不致命 */ }
    });
    /* P7（问题 10）additive：maxWidth/maxHeight 缩小采幅 → JPEG 编码更快 →
       帧间隔显著变小（主题扩散 450ms 动画需要 ≥数十帧才能测「相邻帧面积跳变」）。
       不传时行为与既有使用方完全一致（全尺寸）。 */
    const startOpts = { format: "jpeg", quality, everyNthFrame: 1 };
    if (maxWidth) startOpts.maxWidth = maxWidth;
    if (maxHeight) startOpts.maxHeight = maxHeight;
    await client.send("Page.startScreencast", startOpts);
    await wait(durationMs);
    try { await client.send("Page.stopScreencast"); } catch (e) { /* ignore */ }
    try { await client.detach(); } catch (e) { /* ignore */ }

    /* —— 时间戳单调化（返工 2）：Luna 发现 seq8 ts=160 后 seq9 ts=140 非单调 ——
       根因：CDP metadata.timestamp 是浏览器合成时钟，帧回调到达/交付存在亚帧抖动，
       个别 ts 比前一帧小。修复：以 seq（回调整体序）为稳定排序键，对 ts 做单调
       不减夹取（ts_i = max(rawTs_i, ts_{i-1})），并保留 rawTs 供透明核对。 */
    let clamped = false;
    timeline.sort((a, b) => a.seq - b.seq); // 保障按回调整体序排序
    let prev = -Infinity;
    for (const f of timeline) {
        if (f.ts < prev) { f.ts = prev; clamped = true; }
        prev = f.ts;
    }
    fs.writeFileSync(path.join(outDir, "timeline.json"), JSON.stringify({
        meta: { durationMs, quality, maxWidth: maxWidth || null, maxHeight: maxHeight || null,
                startedAt: new Date(t0).toISOString(), t0, frames: timeline.length,
                ts_policy: "ts 单调不减（按 seq 稳定序 + 单调夹取）；rawTs=CDP metadata 原始推算值保留核对", ts_clamped: clamped },
        frames: timeline,
    }, null, 2), "utf-8");
    return { frames: timeline, framesDir, timelinePath: path.join(outDir, "timeline.json"), t0 };
}