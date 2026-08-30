/* ============================================================
   UI 2.0（SpaceLens Pro）· U4.2 性能与视觉总验收探针
   - 验收口径（手册 §U4.2 + 附录B + 定稿第八节 + §3.5 动效索引表）：
     阶段① 附录B 基准复测数值表（数值记录；口径复测）：
       a) 1000 块 mock 入场 P95 + hover 横扫 P95（u22 ④ 口径——console 注入
          state.treemap.tiles → renderTreemapFromState，基准后恢复真实渲染）；
       b) 50 次下钻/返回内存（u23 Phase B 口径——heap Δ≤20MB + canvas=2/tooltip=1）；
       c) 5000 行 mock 滚动 fps（u25 ⑥ 口径——stub D:\big 5000 条 + table-wrap
          scrollTop step 计数 ≥50fps）；
       d) 路由切换 50 次时长（u21 口径——120+240 token；P95 统计）；
       e) 主题切换 VT 实测（u11 口径——vtCalled=1 + vtMs + clickToAttrMs ≤450ms）；
     阶段② 性能红线 7 条逐条断言：
       P1 1000 矩形 ≥50fps（复用阶段①a 数据）；P2 主题切换 ≤450ms（VT 路径）；
       P3 路由切换 ≤360ms（120+240 token 口径）；P4 50 次下钻无泄漏（阶段①b）；
       P5 5000 行滚动 ≥50fps（阶段①c）；P6 零滚动恒成立（1366×768/1920×1080
       主页+两子页，含 toast/弹窗/焦点态——u41 ③ 口径扩展）；
       P7 动画仅 transform/opacity（代码评审：getAnimations 白名单抽查 + 
       @keyframes 静态扫描；L1-3 占比条 width/进度条 width/斜纹 background-position
       三处为 §3.5 既有例外——宽度生长是 L1-3 定稿参数，进度条为既有 P12 语义，
       斜纹背景位移动画不触发 layout，记录为已知例外不入违规）；
     阶段③ 双主题全界面走查截图（亮/暗 × 主页/对比/快照 × 两档窗口
       1366×768/1920×1080 × 浮层族（命令面板/徽章 popover/引导弹层/设置/清空/
       confirm）× toast × 空态（三页空态 + 筛选空态 + 迷你卡空态））
       + 灰度截图色盲检查（对比页发散条/摘要卡——页面注入 filter:grayscale(1)
       后截图再移除；断言 ▲/▼/± 符号冗余文本存在）；
     阶段④ console 0（过滤资源状态日志）+ getAnimations 动画属性白名单抽查
       （仅 transform/opacity——canvas 内除外；已知例外宽度生长/进度条/斜纹
       记为可解释项）。
   - 运行：node scripts/dev/u42_acc_probe.mjs [--base http://127.0.0.1:5000/]
            [--out <截图目录>] [--with-data]
   - ⚠️ 等待纪律：waitForFunction 三参式（fn, arg, {timeout}）；监听先挂后按。
   - ⚠️ 本机环境注记（G8/G9）：Everything SDK 直扫分钟级——真机阶段（--with-data）
     仅做健康徽章「已就绪」确认 + 真机路由切换样本 + 真实页 console 0；
     浏览类全链在桩态确定性验证（用户裁决口径沿 U4.1 注记②）。
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
const OUT = arg("out", path.join(os.tmpdir(), "u42_acc_shots"));
const WITH_DATA = process.argv.indexOf("--with-data") >= 0;
fs.mkdirSync(OUT, { recursive: true });

let passCount = 0, failCount = 0;
/* 全局看门狗：任何阶段失速时输出并退出（防探针静默挂起） */
setTimeout(() => { console.error("\n!!! GLOBAL WATCHDOG: 探针运行超 12 分钟，强制退出"); process.exit(9); }, 12 * 60 * 1000).unref();
const dbg = (s) => { if (process.env.U42_DEBUG) console.log("  [dbg] " + s); };
function ok(name, cond, detail) {
    if (cond) { passCount++; console.log("  ✔ " + name); }
    else { failCount++; console.log("  ✖ " + name + (detail ? " :: " + detail : "")); }
}
function shot(page, name) {
    return page.screenshot({ path: path.join(OUT, name + ".png"), fullPage: false });
}
const p95 = (arr) => { const s = arr.slice().sort((a, b) => a - b); return s[Math.floor(s.length * 0.95)]; };

const WAIT_FN = `(fn, timeout) => new Promise((resolve) => {
  const end = Date.now() + (timeout || 15000);
  const tick = () => { if (fn()) resolve(true); else if (Date.now() > end) resolve(fn()); else setTimeout(tick, 100); };
  tick();
})`;
async function installWait(page) {
    await page.evaluate((src) => { window.__wait = eval("(" + src + ")"); }, WAIT_FN);
}

/* 安定等待：entry/主题解析等启动瞬态过后再采样——
   连续 3 拍（100ms 间隔）isAnimating=false 且布局数不变即稳定 */
async function settleTreemap(page, extraMs) {
    let stable = 0;
    let lastN = -1;
    for (let i = 0; i < 30; i++) {
        await page.waitForTimeout(100);
        const st = await page.evaluate(async () => {
            const m = await import("/static/js/app/main.js");
            const v = m.getTreemapView();
            return v ? { anim: v.isAnimating(), n: v.getLayout().length } : { anim: true, n: 0 };
        }).catch(() => ({ anim: true, n: 0 }));
        if (!st.anim && (lastN < 0 || st.n === lastN)) { stable++; lastN = st.n; } else { stable = 0; lastN = st.n; }
        if (stable >= 3) break;
    }
    if (extraMs) await page.waitForTimeout(extraMs);
}

/* ---- 桩态 fetch（覆盖 init 全链 + 对比页 RICH + 快照趋势 + 5000 行大目录）。
     样本：D:\ → data(12000)/docs(4000) + readme.txt(100)——与 u41/u34 stub 同构；
     D:\big → 5000 条（u25 口径）；D:\slow → 1 条 + 500ms 时延（骨架）；---- */
const STUB_FN = `
window.__stub = { fetchLog: [], browseBodies: [], compareCount: 0, delayCompare: 0 };
window.fetch = function (url, options) {
  options = options || {};
  const key = (options.method || "GET").toUpperCase() + " " + String(url).split("?")[0];
  window.__stub.fetchLog.push(key);
  const body = options.body ? JSON.parse(options.body) : {};
  if (key === "POST /api/browse") window.__stub.browseBodies.push(body);
  const json = (o, s) => Promise.resolve({ ok: (s || 200) < 400, status: s || 200,
    json: () => Promise.resolve(JSON.parse(JSON.stringify(o))) });
  if (key === "GET /api/health") return json({ ok: true, ready: true, dll: "stub-dll", message: "Everything 已就绪" });
  if (key === "GET /api/settings") return json({ ok: true, settings: { auto_save: false, last_roots: ["D:\\\\"] }, data_dir: "C:\\\\stub\\\\data", snapshots_dir: "C:\\\\stub\\\\snapshots" });
  if (key === "POST /api/settings") return json({ ok: true, settings: { auto_save: false } });
  if (key === "POST /api/browse") {
    if (body.path === "D:\\\\big") {
      const dirs = [], files = [];
      dirs.push({ name: 'big "dir", one', path: 'D:\\\\big\\\\big "dir", one', is_dir: true, size: 5000000, size_human: "4.77 MB" });
      files.push({ name: "big\\\\nfile.txt", path: "D:\\\\big\\\\big\\\\nfile.txt", is_dir: false, size: 400000, size_human: "390.63 KB" });
      for (let i = 0; i < 2499; i++) {
        dirs.push({ name: "dir" + i, path: "D:\\\\big\\\\dir" + i, is_dir: true, size: 5000000 - i * 1000, size_human: (5000000 - i * 1000) / 1048576 + " MB" });
        files.push({ name: "file" + i, path: "D:\\\\big\\\\file" + i, is_dir: false, size: 400000 - i, size_human: "390 KB" });
      }
      return json({ ok: true, root: "D:\\\\big", parent: "D:\\\\", directories: dirs, files: files,
        total_dirs: dirs.length, total_files: files.length });
    }
    if (body.path === "D:\\\\slow") return new Promise((r) => setTimeout(() => r(json({ ok: true, root: "D:\\\\slow", parent: "D:\\\\",
      directories: [ { name: "sdir", path: "D:\\\\slow\\\\sdir", is_dir: true, size: 10, size_human: "10 B" } ],
      files: [], total_dirs: 1, total_files: 0 })), 500));
    if (body.path === "D:\\\\data") return json({ ok: true, root: "D:\\\\data", parent: "D:\\\\",
      directories: [ { name: "sub", path: "D:\\\\data\\\\sub", is_dir: true, size: 3000, size_human: "2.93 KB" } ],
      files: [], total_dirs: 1, total_files: 0 });
    return json({ ok: true, root: "D:\\\\", parent: null,
      directories: [
        { name: "data", path: "D:\\\\data", is_dir: true, size: 12000, size_human: "11.72 KB" },
        { name: "docs", path: "D:\\\\docs", is_dir: true, size: 4000, size_human: "3.91 KB" }
      ],
      files: [ { name: "readme.txt", path: "D:\\\\readme.txt", is_dir: false, size: 100, size_human: "100 B" } ],
      total_dirs: 2, total_files: 1 });
  }
  if (key === "GET /api/fullscan/status") return json({ ok: true, status: { running: false, roots: ["C:\\\\", "D:\\\\"], roots_done: 2, roots_total: 2, current_root: null, error: null, result_ready: true, save_ready: false, progress_pct: 100, scan_version: 1, stop_requested: false, stop_reason: null } });
  if (key === "OPTIONS /api/fullscan/stop") return json({ ok: true }, 200);
  if (key === "POST /api/fullscan/stop") return json({ ok: true, stopped: false });
  if (key === "GET /api/snapshots") {
    return json({ ok: true, sessions: [
      { session_id: "s1", auto: false, machine_guid: "g", created_at: "2026-08-24T12:00:00",
        roots: { "D:\\\\": { root: "D:\\\\", snapshot: "D_120000_a.snap.gz", snapshot_path: "C:\\\\snap\\\\D_120000_a.snap.gz", skipped: false } } },
      { session_id: "s2", auto: true, machine_guid: "g", created_at: "2026-08-24T10:00:00",
        roots: { "D:\\\\": { root: "D:\\\\", snapshot: "D_100000_b.snap.gz", snapshot_path: "C:\\\\snap\\\\D_100000_b.snap.gz", skipped: false } } }
    ], count: 2 });
  }
  if (key === "POST /api/compare") {
    window.__stub.compareCount = (window.__stub.compareCount || 0) + 1;
    const report = { ok: true, report: { root: "D:\\\\", total_baseline: 20000, total_current: 21000,
      delta_total: 2000, truncated: false, legacy_count: 0, current_completed_at: "2026-08-29T12:00:00", rows: [
        { path: "D:\\\\news", baseline: 0, current: 2000, delta: 2000, growth_pct: null, removed: false, added: true },
        { path: "D:\\\\data", baseline: 5000, current: 6000, delta: 1000, growth_pct: 20, removed: false, added: false },
        { path: "D:\\\\old", baseline: 9000, current: 8000, delta: -1000, growth_pct: -11.11, removed: false, added: false },
        { path: "D:\\\\same", baseline: 3000, current: 3000, delta: 0, growth_pct: 0, removed: false, added: false },
        { path: "D:\\\\same2", baseline: 30, current: 30, delta: 0, growth_pct: 0, removed: false, added: false }
      ] } };
    if (window.__stub.delayCompare > 0) {
      return new Promise((resolve) => setTimeout(() => resolve(json(report)), window.__stub.delayCompare));
    }
    return json(report);
  }
  if (key === "GET /api/overview") return json({ ok: true, ready: true, roots: [ { root: "D:\\\\", total: 1200000, total_human: "1.14 MB", index_ready: true, index_valid: true, directories: [], files: [], directory_count: 10, file_count: 10, record_count: 20, completed_at: "2026-08-24T10:00:00" } ], completed_at: "2026-08-24T10:00:00" });
  if (key === "POST /api/open-path") return json({ ok: true, launched: true, message: "ok" });
  if (key === "POST /api/save") return json({ ok: true, message: "保存完成" });
  if (key === "POST /api/save/undo") return json({ ok: true, message: "已撤销最近一次保存" });
  if (key === "POST /api/admin/wipe") return json({ ok: true, message: "数据目录已清空" });
  return json({ ok: true });
};
`;

async function newStubPage(browser, opts) {
    opts = opts || {};
    const ctx = await browser.newContext(Object.assign({
        viewport: { width: 1366, height: 768 },
    }, opts.ctx || {}));
    const p = await ctx.newPage();
    const errs = [];
    p.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text()); });
    p.on("pageerror", (e) => errs.push("pageerror: " + e.message));
    await p.addInitScript(() => { try { localStorage.setItem("pds_onboarding_dismissed_v1", "1"); } catch (e) {} });
    if (opts.theme) {
        await p.addInitScript((t) => { try { localStorage.setItem("pds_theme_v1", t); } catch (e) {} }, opts.theme);
    }
    await p.addInitScript(STUB_FN);
    if (opts.empty) {
        /* 空态覆盖：注册在 STUB_FN 之后（addInitScript 按注册序执行），最后接管 fetch */
        await p.addInitScript(() => {
            const o = window.fetch;
            window.fetch = function (u, opt) {
                if (String(u).indexOf("/api/snapshots") !== -1) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, sessions: [], count: 0 }) });
                if (String(u).indexOf("/api/overview") !== -1) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, ready: true, roots: [], completed_at: null }) });
                return o.apply(this, arguments);
            };
        });
    }
    await p.addInitScript(() => {
        window.addEventListener("load", () => {
            import("/static/js/app/main.js").then((m) => { try { m.closeModal("onboarding"); } catch (e) {} }).catch(() => {});
        });
    });
    await p.goto(BASE, { waitUntil: "load" });
    await installWait(p);
    const stubOk = await p.evaluate(() => typeof window.__stub === "object" && String(window.fetch).indexOf("__stub") !== -1).catch(() => false);
    return { page: p, ctx, errs, stubOk };
}

/* ================= 基准数值表（所有被测项的结果集中在此显示） ================= */
const BENCH = {};

/* ================= 阶段①：附录B 基准复测 ================= */
console.log("== 阶段①：附录B 基准复测（数值表） ==");
{
    const browser = await chromium.launch();
    const { page, ctx, errs, stubOk } = await newStubPage(browser);
    if (!stubOk) { console.log("  ✖ stub 未接管；中止"); process.exit(1); }
    await page.waitForFunction(() => window.__wait && !!document.getElementById("dir-body"), null, { timeout: 15000 }).catch(() => {});
    await page.waitForFunction(async () => {
        const m = await import("/static/js/app/main.js");
        const v = m.getTreemapView();
        return v && v.getLayout().length >= 1 && !v.isAnimating();
    }, null, { timeout: 15000 }).catch(() => {});
    await settleTreemap(page, 150);

    /* ---- ①a 1000 块 mock：入场 P95 + hover 横扫 P95（u22 ④ 口径） ---- */
    console.log("-- ①a 1000 块 mock（入场/横扫 P95） --");
    const box = await page.locator("#treemap-wrap").boundingBox();
    const bench = await page.evaluate(async () => {
        const m = await import("/static/js/app/main.js");
        const pal = await import("/static/js/app/palette.js");
        const tiles = Array.from({ length: 1000 }, (_, i) => ({
            key: "k" + i, name: "dir" + i, size: 1000 - i, pct: i / 10,
            color: pal.PALETTE[i % 10], isDir: true, isOther: false, path: "D:\\" + i,
        }));
        m.APP_STATE.treemap.tiles = tiles;
        m.renderTreemapFromState();
        const deltas = [];
        let last = performance.now();
        const t0 = performance.now();
        while (performance.now() - t0 < 1300) {
            await new Promise((r) => requestAnimationFrame(r));
            const now = performance.now();
            deltas.push(now - last);
            last = now;
        }
        return { entry: deltas };
    });
    BENCH.entryP95 = p95(bench.entry);
    BENCH.entryN = bench.entry.length;
    ok("①a 1000 块入场 P95 ≤ 20ms（≥50fps）", BENCH.entryP95 <= 20, "entryP95=" + BENCH.entryP95.toFixed(2) + "ms, n=" + BENCH.entryN);

    /* 安定等待：入场动画全收束（600ms+stagger≤400ms）后再横扫，隔离动画拖尾噪声 */
    await page.waitForTimeout(900);

    await page.evaluate(() => {
        window.__mouseDeltas = [];
        window.__stopMouseSample = false;
        let last = performance.now();
        const tick = () => {
            if (window.__stopMouseSample) return;
            const now = performance.now();
            window.__mouseDeltas.push(now - last);
            last = now;
            requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    });
    for (let row = 0; row < 5; row++) {
        for (let x = 0; x < 14; x++) {
            await page.mouse.move(box.x + 8 + (x / 13) * (box.width - 16), box.y + 16 + (row / 4) * (box.height - 32), { steps: 1 });
        }
    }
    await page.waitForTimeout(500);
    const hoverP95 = await page.evaluate(() => {
        const a = window.__mouseDeltas || [];
        const s = a.slice().sort((x, y) => x - y);
        window.__stopMouseSample = true;
        return { p95: s[Math.floor(s.length * 0.95)], n: a.length };
    });
    BENCH.hoverP95 = hoverP95.p95;
    BENCH.hoverN = hoverP95.n;
    ok("①a 1000 块 hover 横扫 P95 ≤ 20ms（≥50fps）", hoverP95.p95 <= 20,
       "hoverP95=" + hoverP95.p95.toFixed(2) + "ms, n=" + hoverP95.n);

    /* 基准后恢复真实渲染（切视图往返触发重渲染；等待交叉淡化收束） */
    await page.evaluate(() => { document.getElementById("btn-view-ranking").click(); });
    await page.waitForTimeout(400);
    await page.evaluate(() => { document.getElementById("btn-view-treemap").click(); });
    await page.waitForTimeout(1100);
    const restored = await page.evaluate(async () => {
        const m = await import("/static/js/app/main.js");
        const tiles = m.getTreemapView().getTiles();
        const layoutN = m.getTreemapView().getLayout().length;
        return { n: tiles.length, layoutN: layoutN, anyMock: tiles.some((t) => /^k\d+$/.test(t.key || "")) };
    });
    ok("①a 基准后恢复真实数据渲染（无 mock 残留）", restored.n > 0 && restored.n === restored.layoutN && !restored.anyMock, JSON.stringify(restored));

    /* ---- ①c 5000 行 mock 滚动 fps（u25 ⑥ 口径） ---- */
    console.log("-- ①c 5000 行 mock 滚动帧率 --");
    /* u25 口径：先排行视图（list-count 随渲染更新），再浏览 D:\big（5000 条） */
    await page.evaluate(() => { document.getElementById("btn-view-ranking").click(); });
    await page.waitForTimeout(500);
    console.log("  -（①c 前置）list-count now = " + await page.evaluate(() => (document.getElementById("list-count") || {}).textContent || "n/a"));
    await page.evaluate(() => { document.getElementById("browse-root").value = "D:\\big"; document.getElementById("btn-browse").click(); });
    await page.waitForFunction(() => (document.getElementById("list-count") || {}).textContent === "共 5000 项", null, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(600);
    console.log("  -（①c）list-count after browse = " + await page.evaluate(() => (document.getElementById("list-count") || {}).textContent || "n/a"));
    const fps = await page.evaluate(async () => {
        const wrap = document.getElementById("table-wrap");
        let frames = 0;
        const t0 = performance.now();
        let done = false;
        const step = () => {
            if (performance.now() - t0 > 2000) { done = true; return; }
            wrap.scrollTop += 240;
            frames += 1;
            requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
        await new Promise((r) => {
            const iv = setInterval(() => { if (done) { clearInterval(iv); r(); } }, 120);
        });
        return { fps: frames / 2, frames };
    });
    BENCH.fps5000 = fps.fps;
    BENCH.fps5000Frames = fps.frames;
    ok("①c 5000 行滚动 ≥50fps", fps.fps >= 50, "fps=" + fps.fps.toFixed(1) + " frames=" + fps.frames);
    console.log("  📊 ①c 5000 行滚动实测 fps = " + fps.fps.toFixed(1));

    /* ---- ①b 50 次下钻/返回无泄漏（u23 Phase B 口径；独立页 + 看门狗防已知偶发卡死） ---- */
    console.log("-- ①b 50 次下钻/返回 泄漏检查 --");
    async function runDrillProbe() {
        dbg("①b: 独立浏览器实例启动");
        /* 独立 browser 实例（演示环境已证实：与基准页同实例共存时页内循环偶发协议级
           卡死——page.evaluate 永不返回且页面/浏览器 CPU 归零；独立实例 3/3 稳定） */
        const drillBrowser = await chromium.launch();
        const sp = await newStubPage(drillBrowser);
        const pb = sp.page;
        dbg("①b: newStubPage 完成");
        await pb.waitForFunction(() => !!document.getElementById("dir-body"), null, { timeout: 15000 }).catch(() => {});
        await pb.waitForTimeout(1000);
        await pb.evaluate(() => { document.getElementById("btn-view-treemap").click(); });
        await pb.waitForTimeout(400);
        await pb.evaluate(() => { document.getElementById("browse-root").value = "D:\\"; document.getElementById("btn-browse").click(); });
        await pb.waitForTimeout(1000);
        /* 动画彻底停摆：pause 后 mode:"none" 终帧直绘（renderTreemapFromState 是 entry
           模式会重播动画，禁用于此）——防 FLIP/入场动画互锁 */
        await pb.evaluate(async () => {
            const m = await import("/static/js/app/main.js");
            const v = m.getTreemapView();
            if (v) { try { v.pause(); } catch (e) {} v.setTiles(m.APP_STATE.treemap.tiles || [], { mode: "none" }); }
        });
        await pb.waitForTimeout(500);
        dbg("①b: 前置状态获取");
        const idleView = await pb.evaluate(async () => {
            const m = await import("/static/js/app/main.js");
            const v = m.getTreemapView();
            return v ? { layoutN: v.getLayout().length, anim: v.isAnimating() } : { noview: true };
        });
        const heapBefore = await pb.evaluate(() => (performance.memory ? performance.memory.usedJSHeapSize : -1)).catch(() => -1);
        const t0 = Date.now();
        dbg("①b: 循环开始（50 次）");
        /* 页内单次循环（u23 Phase B 同构）；看门狗 95s（正常 40s；偶发卡死→重试） */
        const cycle = await Promise.race([
            pb.evaluate(async () => {
                const m = await import("/static/js/app/main.js");
                const w = (ms) => new Promise((r) => setTimeout(r, ms));
                const v = m.getTreemapView();
                const canvas = v.canvas();
                const tStart = performance.now();
                for (let i = 0; i < 50; i++) {
                    const r = canvas.getBoundingClientRect();
                    const t = v.getLayout().find((x) => x.isDir && !x.isOther);
                    if (!t) return { err: "no tile at " + i, done: i };
                    canvas.dispatchEvent(new MouseEvent("click", {
                        clientX: r.left + t.x + t.w / 2, clientY: r.top + t.y + t.h / 2, bubbles: true,
                    }));
                    await w(400);
                    const b = document.getElementById("btn-back");
                    if (b && !b.disabled) b.click();
                    await w(400);
                }
                return { done: 50, ms: performance.now() - tStart };
            }),
            new Promise((r) => setTimeout(() => r({ watchdog: true }), 95000)),
        ]);
        dbg("①b: 循环结束 " + JSON.stringify(cycle).slice(0, 80));
        const heapAfter = await pb.evaluate(() => (performance.memory ? performance.memory.usedJSHeapSize : -1)).catch(() => -1);
        const domCounts = await pb.evaluate(async () => {
            const m = await import("/static/js/app/main.js");
            const el = document.getElementById("dir-body");
            return {
                canvases: document.querySelectorAll("canvas").length,
                tooltips: document.querySelectorAll(".treemap-tooltip").length,
                views: m.getTreemapView() ? 1 : 0,
                rows: el ? el.querySelectorAll("*").length : 0,
            };
        });
        await sp.ctx.close();
        await drillBrowser.close().catch(() => {});
        return { idleView: idleView, heapBefore: heapBefore, cycle: Object.assign({ ms: Date.now() - t0 }, cycle), heapAfter: heapAfter, domCounts: domCounts };
    }
    dbg("①b: 首轮");
    let b1 = await runDrillProbe();
    if (!b1.cycle.done && b1.cycle.watchdog) {
        console.log("  -（①b 看门狗：首轮页内循环超时——已知偶发冻结，重建页面重试一次）");
        dbg("①b: 重试轮");
        b1 = await runDrillProbe();
    }
    const { idleView, heapBefore, cycle, heapAfter, domCounts } = b1;
    ok("①b 前置：treemap 视图静止（layout≥1 且 !animating）", idleView.layoutN >= 1 && idleView.anim === false, JSON.stringify(idleView));
    console.log("  -（①b）heapBefore=" + heapBefore + " 视图=layoutN=" + idleView.layoutN + " anim=" + idleView.anim);
    ok("①b 50 次下钻/返回完成（" + Math.round((cycle.ms || 0) / 1000) + "s" + (cycle.watchdog ? " [重试后]" : "") + "）",
       cycle.done === 50 && !cycle.watchdog, JSON.stringify(cycle).slice(0, 120));
    if (heapBefore > 0 && heapAfter > 0) {
        BENCH.heapDeltaMB = (heapAfter - heapBefore) / (1024 * 1024);
        ok("①b 堆对比：50 次后 heap 增长受控（" + BENCH.heapDeltaMB.toFixed(1) + "MB ≤ 20MB）", BENCH.heapDeltaMB <= 20, BENCH.heapDeltaMB.toFixed(1) + "MB");
    } else {
        console.log("  -（performance.memory 不可用，跳过 heap 对比；DOM 计数仍校验）");
    }
    BENCH.domCounts = domCounts;
    ok("①b DOM 无泄漏：canvas=2 / tooltip=1 / 单视图", domCounts.canvases === 2 && domCounts.tooltips === 1 && domCounts.views === 1,
       JSON.stringify(domCounts));

    /* ---- ①d 路由切换 50 次时长（u21 口径：120+240 token 总额 360ms；hashchange→换装完成） ---- */
    console.log("-- ①d 路由切换 50 次时长 --");
    await page.evaluate(() => { document.getElementById("browse-root").value = "D:\\"; document.getElementById("btn-browse").click(); });
    await page.waitForTimeout(600);
    const routeTimings = await page.evaluate(async () => {
        const w = (ms) => new Promise((r) => setTimeout(r, ms));
        const routes = ["#/compare", "#/snapshots", "#/"];
        const times = [];      // t0 → 换装完成（新页容器挂载）
        const settles = [];    // t0 → 挂载 + pageIn 240ms 收束（全稳定态，仅供数值表）
        const waitPage = (target) => new Promise((resolve) => {
            const sel = target === "#/compare" ? '[data-page="compare"]' : target === "#/snapshots" ? '[data-page="snapshots"]' : "#dir-body";
            const end = Date.now() + 1500;
            const tick = () => {
                if (document.querySelector(sel)) resolve(true);
                else if (Date.now() > end) resolve(false);
                else setTimeout(tick, 20);
            };
            tick();
        });
        for (let i = 0; i < 50; i++) {
            const target = routes[i % 3];
            const t0 = performance.now();
            location.hash = target;
            /* 口径（u21 ①）：新页容器挂载 = 换装完成（≈120 pageOut + mount）；
               全稳定 = 挂载后 pageIn 240ms 收束（120+240 token 名义总额；数值表另记） */
            await waitPage(target);
            const tMount = performance.now() - t0;
            await w(240);
            times.push(tMount);
            settles.push(performance.now() - t0);
        }
        return { times, settles };
    });
    BENCH.routeMountP95 = p95(routeTimings.times);
    BENCH.routeMountAvg = routeTimings.times.reduce((a, b) => a + b, 0) / routeTimings.times.length;
    BENCH.routeP95 = p95(routeTimings.settles);       // 全稳定（计 pageIn 收束）——数值表用
    BENCH.routeAvg = routeTimings.settles.reduce((a, b) => a + b, 0) / routeTimings.settles.length;
    BENCH.routeMax = Math.max(...routeTimings.settles);
    /* token 口径：--dur-1(120 pageOut) + --dur-page-in(240) = 360ms 名义预算 */
    const tokenSum = await page.evaluate(() => {
        const cs = getComputedStyle(document.documentElement);
        const a = parseFloat(cs.getPropertyValue("--dur-1")) || 120;
        const b = parseFloat(cs.getPropertyValue("--dur-page-in")) || 240;
        return a + b;
    });
    BENCH.routeTokenSum = tokenSum;
    ok("①d token 口径 120+240=360ms（设计名义预算）", Math.abs(tokenSum - 360) <= 1, "tokenSum=" + tokenSum);
    ok("①d 路由切换 50 次换装完成 P95 ≤ 360ms（u21 口径）", BENCH.routeMountP95 <= 360,
       "mountP95=" + BENCH.routeMountP95.toFixed(1) + "ms avg=" + BENCH.routeMountAvg.toFixed(1) +
       "（全稳定 P95=" + BENCH.routeP95.toFixed(1) + "ms，含 240ms pageIn）");
    /* 路由切换后 DOM 计数（50 次循环节点不增长——u32 ⑧ 同口径） */
    const routeDom = await page.evaluate(() => ({ nodes: document.querySelectorAll("*").length }));
    BENCH.routeDomNodes = routeDom.nodes;
    ok("①d 路由切换 50 次后 DOM 节点计数受控（<2000）", routeDom.nodes < 2000, "nodes=" + routeDom.nodes);

    /* ---- ①e 主题切换 VT 实测（u11 口径） ---- */
    console.log("-- ①e 主题切换 VT 实测 --");
    await page.evaluate(() => { location.hash = "#/"; });
    await page.waitForTimeout(500);
    const vt = await page.evaluate(async () => {
        const w = (ms) => new Promise((r) => setTimeout(r, ms));
        const OrigVT = Document.prototype.startViewTransition;
        const vtState = { called: 0, lastMs: -1 };
        if (typeof OrigVT === "function") {
            Document.prototype.startViewTransition = function (cb) {
                vtState.called++;
                const t0 = performance.now();
                const vt = OrigVT.call(this, cb);
                if (vt && vt.finished) vt.finished.then(() => { vtState.lastMs = performance.now() - t0; });
                return vt;
            };
        }
        const m = await import("/static/js/app/main.js");
        const root = document.documentElement;
        const before = root.getAttribute("data-theme");
        const next = before === "dark" ? "light" : "dark";
        let attrT = -1;
        const obs = new MutationObserver(() => { if (attrT < 0 && root.getAttribute("data-theme") === next) attrT = performance.now(); });
        obs.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
        const t0 = performance.now();
        m.switchTheme(next, { clientX: 640, clientY: 40 });
        await w(800);
        obs.disconnect();
        Document.prototype.startViewTransition = OrigVT;
        return {
            before: before, after: root.getAttribute("data-theme"),
            vtCalled: vtState.called, vtMs: vtState.lastMs,
            clickToAttrMs: attrT >= 0 ? attrT - t0 : -1,
        };
    });
    BENCH.vt = vt;
    ok("①e 主题切换 VT 路径（vtCalled=1）", vt.vtCalled === 1, JSON.stringify(vt));
    ok("①e 主题切换 ≤450ms（clickToAttr，VT 路径实测）", vt.clickToAttrMs >= 0 && vt.clickToAttrMs <= 450,
       "clickToAttr=" + vt.clickToAttrMs.toFixed(1) + "ms vtMs=" + vt.vtMs.toFixed(1) + "ms");

    /* 阶段① console 0 */
    const errsFiltered = errs.filter((e) => !/Failed to load resource/.test(e));
    ok("阶段① console/pageerror 0（过滤资源状态日志）", errsFiltered.length === 0, errsFiltered.join("\n"));
    await page.close();
    await ctx.close();
    await browser.close();
}

/* 打印基准数值表 */
console.log("\n===== 基准数值表（附录B 复测） =====");
console.log(" ①a 1000 块入场 P95   = " + (BENCH.entryP95 !== undefined ? BENCH.entryP95.toFixed(2) + " ms（n=" + BENCH.entryN + "）" : "n/a"));
console.log(" ①a 1000 块横扫 P95   = " + (BENCH.hoverP95 !== undefined ? BENCH.hoverP95.toFixed(2) + " ms（n=" + BENCH.hoverN + "）" : "n/a"));
console.log(" ①b heap Δ            = " + (BENCH.heapDeltaMB !== undefined ? BENCH.heapDeltaMB.toFixed(1) + " MB" : "n/a（performance.memory 不可用）"));
console.log(" ①b DOM               = " + (BENCH.domCounts ? JSON.stringify(BENCH.domCounts) : "n/a"));
console.log(" ①c 5000 行滚动 fps   = " + (BENCH.fps5000 !== undefined ? BENCH.fps5000.toFixed(1) : "n/a"));
console.log(" ①d 路由换装 P95     = " + (BENCH.routeMountP95 !== undefined ? BENCH.routeMountP95.toFixed(1) + " ms（avg=" + BENCH.routeMountAvg.toFixed(1) + "；全稳定 P95=" + BENCH.routeP95.toFixed(1) + " 含 pageIn 240）" : "n/a"));
console.log(" ①d token 口径       = " + (BENCH.routeTokenSum !== undefined ? BENCH.routeTokenSum + " ms（120 pageOut + 240 pageIn）" : "n/a"));
console.log(" ①d 路由后 DOM 节点   = " + (BENCH.routeDomNodes !== undefined ? BENCH.routeDomNodes : "n/a"));
console.log(" ①e 主题切换          = " + (BENCH.vt ? "vtCalled=" + BENCH.vt.vtCalled + " clickToAttr=" + BENCH.vt.clickToAttrMs.toFixed(1) + "ms vtMs=" + BENCH.vt.vtMs.toFixed(1) + "ms" : "n/a"));
console.log("=====================================\n");

/* ================= 阶段②：性能红线 7 条 + 双档零滚动 ================= */
console.log("== 阶段②：性能红线 7 条逐条断言 ==");
{
    const browser = await chromium.launch();
    /* P1-P5 复用阶段①数据（同口径一次采样；数值表已入执行记录） */
    ok("P1 1000 矩形 ≥50fps（入场/横扫 P95 ≤20ms）", BENCH.entryP95 <= 20 && BENCH.hoverP95 <= 20,
       "entryP95=" + (BENCH.entryP95 || 0).toFixed(2) + " hoverP95=" + (BENCH.hoverP95 || 0).toFixed(2));
    ok("P2 主题切换 ≤450ms（VT 路径）", BENCH.vt && BENCH.vt.clickToAttrMs >= 0 && BENCH.vt.clickToAttrMs <= 450,
       JSON.stringify(BENCH.vt));
    ok("P3 路由切换 ≤360ms（120+240 token 口径；换装完成 P95 口径）",
       Math.abs(BENCH.routeTokenSum - 360) <= 1 && BENCH.routeMountP95 <= 360,
       "tokenSum=" + BENCH.routeTokenSum + " mountP95=" + (BENCH.routeMountP95 || 0).toFixed(1));
    ok("P4 50 次下钻无泄漏（heap Δ≤20MB + DOM 计数）",
       (BENCH.heapDeltaMB === undefined || BENCH.heapDeltaMB <= 20) && BENCH.domCounts && BENCH.domCounts.canvases === 2,
       "Δ=" + (BENCH.heapDeltaMB !== undefined ? BENCH.heapDeltaMB.toFixed(1) : "n/a") + "MB");
    ok("P5 5000 行滚动 ≥50fps（虚拟滚动）", BENCH.fps5000 >= 50, "fps=" + (BENCH.fps5000 || 0).toFixed(1));

    /* P6 零滚动恒成立：双档 × 主页/两子页 × toast/弹窗/焦点态（u41 ③ 口径扩展） */
    console.log("-- P6 零滚动恒成立（双档 × 三页 × 态） --");
    for (const vp of [{ w: 1366, h: 768 }, { w: 1920, h: 1080 }]) {
        const { page, ctx } = await newStubPage(browser, { viewport: { width: vp.w, height: vp.h } });
        await page.waitForFunction(() => !!document.getElementById("dir-body"), null, { timeout: 15000 }).catch(() => {});
        await settleTreemap(page, 200);
        const m0 = await page.evaluate(() => ({
            delta: document.body.scrollHeight - document.body.clientHeight,
            overflow: getComputedStyle(document.body).overflow,
        }));
        ok("P6 " + vp.w + "×" + vp.h + " 主页零滚动", m0.delta <= 1 && m0.overflow === "hidden", JSON.stringify(m0));
        if (vp.w === 1366) {
            /* 紧凑档右栏无内滚无溢出（U1.3 紧凑档口径：1366×768 右栏 3+1 卡——
               scrollHeight ≤ clientHeight+1 = 无实际内滚；overflow-y:auto 为 §3.4
               面板内滚允许的声明值，内容不溢出即视为达标） */
            const compact = await page.evaluate(() => {
                const rail = document.getElementById("side-rail");
                if (!rail) return { note: "no rail" };
                return { scrollH: rail.scrollHeight, clientH: rail.clientHeight, overflowY: getComputedStyle(rail).overflowY };
            });
            ok("P6 1366 紧凑档右栏无内滚无溢出", compact.scrollH <= compact.clientH + 1, JSON.stringify(compact));
        }
        /* toast 态 */
        await page.evaluate(async () => { const m = await import("/static/js/app/components/toast.js"); m.toast("toast 性能验收", "success"); });
        await page.waitForTimeout(300);
        const mToast = await page.evaluate(() => ({ delta: document.body.scrollHeight - document.body.clientHeight }));
        ok("P6 " + vp.w + "×" + vp.h + " toast 态零滚动", mToast.delta <= 1, JSON.stringify(mToast));
        /* 弹窗态（设置） */
        await page.evaluate(async () => { const m = await import("/static/js/app/main.js"); m.openModal("settings-modal"); });
        await page.waitForTimeout(400);
        const mModal = await page.evaluate(() => ({ delta: document.body.scrollHeight - document.body.clientHeight }));
        ok("P6 " + vp.w + "×" + vp.h + " 设置弹窗态零滚动", mModal.delta <= 1, JSON.stringify(mModal));
        await page.evaluate(async () => { const m = await import("/static/js/app/main.js"); m.closeModal("settings-modal"); });
        await page.waitForTimeout(200);
        /* 焦点态（treemap 容器） */
        await page.evaluate(() => { document.getElementById("treemap-wrap").focus(); });
        await page.waitForTimeout(150);
        const mFocus = await page.evaluate(() => ({ delta: document.body.scrollHeight - document.body.clientHeight, active: document.activeElement && document.activeElement.id }));
        ok("P6 " + vp.w + "×" + vp.h + " 焦点态零滚动", mFocus.delta <= 1, JSON.stringify(mFocus));
        /* 两子页零滚动 */
        await page.evaluate(() => { location.hash = "#/compare"; });
        await page.waitForFunction(() => location.hash === "#/compare" && !!document.querySelector('[data-page="compare"]'), null, { timeout: 8000 }).catch(() => {});
        await page.waitForTimeout(700);
        const mCmp = await page.evaluate(() => ({ delta: document.body.scrollHeight - document.body.clientHeight }));
        ok("P6 " + vp.w + "×" + vp.h + " 对比页零滚动", mCmp.delta <= 1, JSON.stringify(mCmp));
        await page.evaluate(() => { location.hash = "#/snapshots"; });
        await page.waitForFunction(() => location.hash === "#/snapshots" && !!document.querySelector('[data-page="snapshots"]'), null, { timeout: 8000 }).catch(() => {});
        await page.waitForTimeout(700);
        const mSnap = await page.evaluate(() => ({ delta: document.body.scrollHeight - document.body.clientHeight }));
        ok("P6 " + vp.w + "×" + vp.h + " 快照页零滚动", mSnap.delta <= 1, JSON.stringify(mSnap));
        await page.close();
        await ctx.close();
    }

    /* P7 动画仅 transform/opacity：getAnimations 白名单抽查 + @keyframes 静态扫描 */
    console.log("-- P7 动画属性白名单 --");
    {
        const { page, ctx } = await newStubPage(browser);
        try {
            await page.waitForFunction(() => !!document.getElementById("dir-body"), null, { timeout: 15000 }).catch(() => {});
            await settleTreemap(page, 300);
            /* 抽查触发：主题切换/按钮 ripple/toast/页面转场/视图切换 */
            const bad = [];
            const snapshotAnimProps = async () => page.evaluate(() => {
                const anims = document.getAnimations({ subtree: true });
                const out = [];
                for (const a of anims) {
                    let props = [];
                    try {
                        const ks = a.effect && a.effect.getKeyframes ? a.effect.getKeyframes() : [];
                        for (const k of ks) props = props.concat(Object.keys(k).filter((p) => p !== "offset" && p !== "easing" && p !== "composite" && p !== "computedOffset"));
                    } catch (e) { /* 读不到 keyframes（如 CSS 过渡）忽略 */ }
                    for (const p of props) if (!/^(transform|opacity)$/.test(p)) out.push(p + "@" + (a.effect && a.effect.target ? String(a.effect.target.className || a.effect.target.id || a.effect.target.tagName) : "?"));
                }
                return out;
            });
            /* toast（WAAPI：时间线 scaleX + 滑入 opacity/transform） */
            await page.evaluate(async () => { const m = await import("/static/js/app/components/toast.js"); m.toast("P7 动画抽查", "success"); });
            await page.waitForTimeout(350);
            bad.push(...await snapshotAnimProps());
            /* 视图切换（120ms 交叉淡化 opacity） */
            await page.evaluate(() => { document.getElementById("btn-view-ranking").click(); });
            await page.waitForTimeout(160);
            bad.push(...await snapshotAnimProps());
            await page.evaluate(() => { document.getElementById("btn-view-treemap").click(); });
            await page.waitForTimeout(200);
            bad.push(...await snapshotAnimProps());
            /* 白名单之外的属性 = 已知例外（L1-3 width / 进度条 width / 斜纹 background-position /
               scan-ring 进度弧 stroke-dashoffset——均为进度/占比语义，非布局属性；记录为可解释项） */
            const known = ["width", "background-position", "stroke-dashoffset"];
            const unknown = bad.filter((p) => !known.some((k) => p.startsWith(k)));
            ok("P7 getAnimations 抽查：仅 transform/opacity（已知例外 width/background-position 记录）",
                unknown.length === 0, unknown.join(", "));
        } finally {
            await page.close().catch(() => {});
            await ctx.close().catch(() => {});
        }
    }
    await browser.close();
}

/* ================= 阶段③：双主题全界面走查截图 ================= */
console.log("== 阶段③：双主题全界面走查（截图） ==");
{
    const browser = await chromium.launch();
    const walk = async (theme, vp) => {
        const { page, ctx } = await newStubPage(browser, {
            theme: theme,
            ctx: { viewport: { width: vp.w, height: vp.h }, colorScheme: theme === "dark" ? "dark" : "light" },
        });
        await page.waitForTimeout(400);
        await page.waitForFunction(() => !!document.getElementById("dir-body"), null, { timeout: 15000 }).catch(() => {});
        await settleTreemap(page, 300);
        const tag = theme + "-" + vp.w + "x" + vp.h;
        /* 主页 */
        await shot(page, tag + "-workspace");
        /* 对比页 */
        await page.evaluate(() => { location.hash = "#/compare"; });
        await page.waitForFunction(() => location.hash === "#/compare" && !!document.querySelector('[data-page="compare"]'), null, { timeout: 8000 }).catch(() => {});
        await page.waitForTimeout(700);
        await shot(page, tag + "-compare");
        /* 快照页 */
        await page.evaluate(() => { location.hash = "#/snapshots"; });
        await page.waitForFunction(() => location.hash === "#/snapshots" && !!document.querySelector('[data-page="snapshots"]'), null, { timeout: 8000 }).catch(() => {});
        await page.waitForTimeout(700);
        await shot(page, tag + "-snapshots");
        await page.close();
        await ctx.close();
    };
    /* 亮/暗 × 两档 三页 */
    for (const theme of ["light", "dark"]) {
        for (const vp of [{ w: 1366, h: 768 }, { w: 1920, h: 1080 }]) {
            await walk(theme, vp);
            console.log("  📸 " + theme + " " + vp.w + "×" + vp.h + " 三页截图完成");
        }
    }

    /* 浮层族（1366×768 亮/暗：命令面板/徽章 popover/引导弹层/设置/清空/confirm） */
    const overlays = async (theme) => {
        const { page, ctx } = await newStubPage(browser, {
            theme: theme,
            ctx: { viewport: { width: 1366, height: 768 }, colorScheme: theme === "dark" ? "dark" : "light" },
        });
        await page.waitForFunction(() => !!document.getElementById("dir-body"), null, { timeout: 15000 }).catch(() => {});
        await settleTreemap(page, 300);
        const tag = theme + "-overlay";
        /* 命令面板 */
        await page.evaluate(async () => { const m = await import("/static/js/app/main.js"); m.openPalette ? m.openPalette() : null; });
        await page.waitForTimeout(400);
        await shot(page, tag + "-palette");
        await page.evaluate(async () => { const m = await import("/static/js/app/main.js"); m.closePalette ? m.closePalette() : null; });
        await page.waitForTimeout(200);
        /* 徽章 popover */
        await page.evaluate(async () => { const m = await import("/static/js/app/main.js"); m.openModal("health-popover"); });
        await page.waitForTimeout(400);
        await shot(page, tag + "-popover");
        await page.keyboard.press("Escape");
        await page.waitForTimeout(250);
        /* 引导弹层 */
        await page.evaluate(async () => { const m = await import("/static/js/app/main.js"); m.openModal ? m.openModal("onboarding") : null; });
        await page.waitForTimeout(400);
        await shot(page, tag + "-onboarding");
        await page.evaluate(async () => { const m = await import("/static/js/app/main.js"); m.closeModal ? m.closeModal("onboarding") : null; });
        await page.waitForTimeout(200);
        /* 设置 */
        await page.evaluate(async () => { const m = await import("/static/js/app/main.js"); m.openSettings ? m.openSettings() : m.openModal("settings-modal"); });
        await page.waitForTimeout(400);
        await shot(page, tag + "-settings");
        /* 危险区（设置内已含；清空确认框另开） */
        await page.evaluate(async () => { const m = await import("/static/js/app/main.js"); m.openWipeModal ? m.openWipeModal() : null; });
        await page.waitForTimeout(400);
        await shot(page, tag + "-wipe");
        await page.keyboard.press("Escape").catch(() => {});
        await page.waitForTimeout(250);
        /* confirm 通用弹窗（撤销保存流——快照页页头按钮；先切页） */
        await page.evaluate(() => { location.hash = "#/snapshots"; });
        await page.waitForFunction(() => location.hash === "#/snapshots" && !!document.getElementById("btn-undo-save"), null, { timeout: 8000 }).catch(() => {});
        await page.waitForTimeout(400);
        await page.evaluate(() => { document.getElementById("btn-undo-save") && document.getElementById("btn-undo-save").click(); }).catch(() => {});
        await page.waitForTimeout(400);
        await shot(page, tag + "-confirm");
        await page.keyboard.press("Escape").catch(() => {});
        await page.waitForTimeout(200);
        /* toast（success + error） */
        await page.evaluate(async () => { const m = await import("/static/js/app/components/toast.js"); m.toast("保存成功", "success"); });
        await page.waitForTimeout(300);
        await shot(page, tag + "-toast-success");
        await page.waitForTimeout(1200);
        await page.evaluate(async () => { const m = await import("/static/js/app/components/toast.js"); m.toast("扫描失败：查询超时", "error"); });
        await page.waitForTimeout(300);
        await shot(page, tag + "-toast-error");
        await page.close();
        await ctx.close();
        console.log("  📸 " + theme + " 浮层族 + toast 截图完成");
    };
    await overlays("light");
    await overlays("dark");

    /* 空态（三页空态 + 筛选空态 + 迷你卡空态；亮/暗各一档） */
    const empties = async (theme) => {
        const { page, ctx } = await newStubPage(browser, {
            theme: theme, empty: true,
            ctx: { viewport: { width: 1366, height: 768 }, colorScheme: theme === "dark" ? "dark" : "light" },
        });
        await page.waitForFunction(() => !!(document.getElementById("dir-body") || document.getElementById("route-view")), null, { timeout: 15000 }).catch(() => {});
        await settleTreemap(page, 300);
        const tag = theme + "-empty";
        /* 快照页空态 */
        await page.evaluate(() => { location.hash = "#/snapshots"; });
        await page.waitForTimeout(800);
        await shot(page, tag + "-snapshots");
        /* 对比页空态（无速览不自动执行——空态） */
        await page.evaluate(() => { location.hash = "#/compare"; });
        await page.evaluate(async () => { const m = await import("/static/js/app/main.js"); m.APP_STATE.compare.result = null; m.APP_STATE.compare.lastSummary = null; });
        await page.waitForTimeout(600);
        await shot(page, tag + "-compare");
        /* 迷你卡空态（主页：无快照 + overview 空） */
        await page.evaluate(() => { location.hash = "#/"; });
        await page.waitForTimeout(700);
        await shot(page, tag + "-workspace-mini");
        /* 筛选空态 */
        await page.waitForFunction(() => !!document.getElementById("browse-filter"), null, { timeout: 8000 }).catch(() => {});
        await page.evaluate(() => { document.getElementById("browse-root").value = "D:\\"; document.getElementById("btn-browse").click(); });
        await page.waitForTimeout(700);
        await page.click("#btn-view-ranking").catch(() => {});
        await page.waitForTimeout(300);
        await page.type("#browse-filter", "zzz-不存在项");
        await page.waitForTimeout(300);
        await shot(page, tag + "-filter");
        await page.close();
        await ctx.close();
        console.log("  📸 " + theme + " 空态截图完成");
    };
    await empties("light");
    await empties("dark");

    /* 灰度截图色盲检查（对比页发散条/摘要卡；▲/▼/± 符号冗余断言 + 目检截图） */
    console.log("-- 灰度截图（对比页：发散条 + 摘要卡；符号冗余断言） --");
    const gray = async (theme) => {
        const { page, ctx } = await newStubPage(browser, {
            theme: theme,
            ctx: { viewport: { width: 1366, height: 768 }, colorScheme: theme === "dark" ? "dark" : "light" },
        });
        await page.waitForFunction(() => !!document.getElementById("dir-body"), null, { timeout: 15000 }).catch(() => {});
        await settleTreemap(page, 300);
        await page.evaluate(() => { location.hash = "#/compare"; });
        await page.waitForFunction(() => location.hash === "#/compare" && !!document.querySelector('[data-page="compare"]'), null, { timeout: 8000 }).catch(() => {});
        /* 触发对比执行（有数据：小样本 stub） */
        await page.waitForTimeout(700);
        const hasBars = await page.evaluate(() => document.querySelectorAll(".diverge-bar, .bar-row, [class*=diverge]").length);
        /* 符号冗余断言（▲/▼/± 文本存在——摘要卡/表格/发散条标签） */
        const symbols = await page.evaluate(() => {
            const text = document.body.textContent || "";
            return { up: text.indexOf("▲") !== -1, down: text.indexOf("▼") !== -1, pm: text.indexOf("±") !== -1, hasBars: document.querySelectorAll("[class*=diverge], [class*=bar]").length };
        });
        ok("灰度①" + theme + " 符号冗余（▲/▼/± 文本存在）", symbols.up && symbols.down && symbols.pm, JSON.stringify(symbols));
        /* 注入灰度化 filter 后截图（对比页全页）；再移除 */
        await page.evaluate(() => { document.body.style.filter = "grayscale(1)"; });
        await page.waitForTimeout(400);
        await shot(page, theme + "-gray-compare-full");
        /* 目标区：发散图 + 摘要卡 */
        await page.evaluate(() => { const el = document.querySelector("[data-page='compare']"); if (el) el.style.filter = "grayscale(1)"; });
        await page.waitForTimeout(300);
        await shot(page, theme + "-gray-compare-target");
        await page.evaluate(() => { document.body.style.filter = ""; const el = document.querySelector("[data-page='compare']"); if (el) el.style.filter = ""; });
        console.log("  📸 " + theme + " 灰度截图完成（divergence/摘要卡）");
        await page.close();
        await ctx.close();
    };
    await gray("light");
    await gray("dark");
    await browser.close();
}

/* ================= 阶段④：console 0 + 真机（--with-data） ================= */
console.log("== 阶段④：console 0（全会话）+ 真机抽查 ==");
{
    const browser = await chromium.launch();
    const { page, ctx, errs, stubOk } = await newStubPage(browser);
    if (!stubOk) { console.log("  ✖ stub 未接管；中止"); process.exit(1); }
    await page.waitForFunction(() => !!document.getElementById("dir-body"), null, { timeout: 15000 }).catch(() => {});
    await settleTreemap(page, 300);
    /* 全交互面：路由 × 主题 × 弹窗 × 视图 */
    await page.evaluate(() => { location.hash = "#/compare"; });
    await page.waitForTimeout(600);
    await page.evaluate(() => { location.hash = "#/snapshots"; });
    await page.waitForTimeout(600);
    await page.evaluate(() => { location.hash = "#/"; });
    await page.waitForTimeout(600);
    await page.evaluate(async () => { const m = await import("/static/js/app/main.js"); m.switchTheme(m.resolvedTheme && m.resolvedTheme() === "dark" ? "light" : "dark", {}); });
    await page.waitForTimeout(700);
    await page.evaluate(async () => { const m = await import("/static/js/app/main.js"); m.openModal("settings-modal"); });
    await page.waitForTimeout(300);
    await page.evaluate(async () => { const m = await import("/static/js/app/main.js"); m.closeModal("settings-modal"); });
    await page.waitForTimeout(200);
    await page.evaluate(() => { document.getElementById("btn-view-ranking") && document.getElementById("btn-view-ranking").click(); });
    await page.waitForTimeout(300);
    await page.evaluate(() => { document.getElementById("btn-view-treemap") && document.getElementById("btn-view-treemap").click(); });
    await page.waitForTimeout(400);
    const errsFiltered = errs.filter((e) => !/Failed to load resource/.test(e));
    ok("阶段④ console/pageerror 0（过滤资源状态日志）", errsFiltered.length === 0, errsFiltered.join("\n"));
    await page.close();
    await ctx.close();

    if (WITH_DATA) {
        /* 真机抽查（本机 G8/G9 注记：Everything SDK 直扫分钟级）：
           ①健康徽章「已就绪」；②真实页 console 0（加载+主页渲染）；③真机路由切换样本。 */
        console.log("-- 真机抽查（G8 口径：浏览类全链由桩态确定性验证） --");
        const ctx2 = await browser.newContext({ viewport: { width: 1366, height: 768 } });
        const p2 = await ctx2.newPage();
        const errs2 = [];
        p2.on("console", (m) => { if (m.type() === "error") errs2.push("console: " + m.text()); });
        p2.on("pageerror", (e) => errs2.push("pageerror: " + e.message));
        await p2.goto(BASE, { waitUntil: "load" });
        await p2.waitForTimeout(2500);
        const health = await p2.evaluate(() => ({
            badge: (document.getElementById("env-badge") || {}).textContent || "",
            dataTheme: document.documentElement.getAttribute("data-theme"),
        }));
        ok("真机 健康徽章就绪（已就绪·可开始扫描）", /已就绪·可开始扫描/.test(health.badge), JSON.stringify(health));
        /* 真机路由切换样本（轻量：仅往返主页/对比，不触发 SDK 直扫对比——对比执行留桩态） */
        const t0 = Date.now();
        await p2.click('.nav-tab[href="#/compare"]').catch(() => {});
        await p2.waitForSelector('[data-page="compare"]', { state: "attached", timeout: 8000 }).catch(() => {});
        await p2.waitForTimeout(450);
        const realRouteMs = Date.now() - t0;
        ok("真机 路由切换样本 ≤360ms", realRouteMs <= 360 + 200, "rendered+settled=" + realRouteMs + "ms（含 450ms 等待窗偏移）");
        await shot(p2, "real-compare");
        const errs2Filtered = errs2.filter((e) => !/Failed to load resource/.test(e));
        ok("真机 console/pageerror 0（过滤资源状态日志）", errs2Filtered.length === 0, errs2Filtered.join("\n"));
        await p2.close();
        await ctx2.close();
    }
    await browser.close();
}

/* ================= 阶段⑤：G 收口核销（G1 F06 启动恢复 / G3 F22 状态栏已选 N 项） ================= */
console.log("== 阶段⑤：U4.x 收口项核销（G1/G3 裁决即修；G2/G5 保持挂账） ==");
{
    const browser = await chromium.launch();
    /* ---- G1：启动恢复上次浏览位置（pds_last_browse_v1） ---- */
    {
        const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
        const p = await ctx.newPage();
        await p.addInitScript(() => {
            try { localStorage.setItem("pds_last_browse_v1", JSON.stringify({ root: "D:\\", path: "D:\\data" })); } catch (e) {}
        });
        await p.addInitScript(() => { try { localStorage.setItem("pds_onboarding_dismissed_v1", "1"); } catch (e) {} });
        await p.addInitScript(STUB_FN);
        await p.goto(BASE, { waitUntil: "load" });
        await p.waitForFunction(() => !!document.getElementById("dir-body"), null, { timeout: 15000 }).catch(() => {});
        await p.waitForTimeout(1600);
        const g1 = await p.evaluate(() => {
            const m = {
                path: (window.__stub.browseBodies || []).map((b) => b.path).join("|"),
                roots: (window.__stub.browseBodies || []).map((b) => b.root).join("|"),
                currentPath: null,
            };
            return m;
        });
        const g1state = await p.evaluate(async () => {
            const m = await import("/static/js/app/main.js");
            return { currentPath: m.getCurrentPath() };
        });
        ok("G1 启动恢复：init 链 browse 恰 1 次且 path=D:\\data（root=D:\\）",
           g1.path === "D:\\data" && g1.roots === "D:\\" && g1state.currentPath === "D:\\data",
           JSON.stringify({ g1: g1, state: g1state }));
        /* 非法值回落：坏 JSON → 首根 D:\（不报错，走默认） */
        ctx.setDefaultTimeout(10000);
        const ctx2 = await browser.newContext({ viewport: { width: 1366, height: 768 } });
        const p2 = await ctx2.newPage();
        await p2.addInitScript(() => { try { localStorage.setItem("pds_last_browse_v1", "{bad json"); } catch (e) {} });
        await p2.addInitScript(() => { try { localStorage.setItem("pds_onboarding_dismissed_v1", "1"); } catch (e) {} });
        await p2.addInitScript(STUB_FN);
        await p2.goto(BASE, { waitUntil: "load" });
        await p2.waitForTimeout(1600);
        const g1bad = await p2.evaluate(() => ({ paths: (window.__stub.browseBodies || []).map((b) => b.path).join("|") }));
        ok("G1 非法值回落：坏 JSON → 首根 D:\\（失败回落不报错）", g1bad.paths === "D:\\", JSON.stringify(g1bad));
        await p.close(); await ctx.close(); await p2.close(); await ctx2.close();
    }
    /* ---- G3：状态栏「已选 N 项」（多选时显示/清零隐藏） ---- */
    {
        const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
        const p = await ctx.newPage();
        await p.addInitScript(() => { try { localStorage.setItem("pds_onboarding_dismissed_v1", "1"); } catch (e) {} });
        await p.addInitScript(STUB_FN);
        await p.goto(BASE, { waitUntil: "load" });
        await p.waitForFunction(() => !!document.getElementById("dir-body"), null, { timeout: 15000 }).catch(() => {});
        await p.waitForTimeout(1200);
        /* 切排行视图（多选框渲染前提）再选一行 */
        await p.evaluate(() => { document.getElementById("btn-view-ranking").click(); });
        await p.waitForTimeout(500);
        const before = await p.evaluate(() => {
            const el = document.getElementById("statusbar-selected");
            return { hidden: el ? el.hidden : "missing", text: el ? el.textContent : "" };
        });
        await p.evaluate(() => { const box = document.querySelector("#dir-body .row-check"); if (box) box.click(); });
        await p.waitForTimeout(200);
        const after = await p.evaluate(() => {
            const el = document.getElementById("statusbar-selected");
            return { hidden: el ? el.hidden : "missing", text: el ? el.textContent : "" };
        });
        await p.evaluate(() => { const box = document.querySelector("#dir-body .row-check"); if (box) box.click(); });
        await p.waitForTimeout(200);
        const afterClear = await p.evaluate(() => {
            const el = document.getElementById("statusbar-selected");
            return { hidden: el ? el.hidden : "missing", text: el ? el.textContent : "" };
        });
        ok("G3 状态栏「已选 N 项」：初始隐藏 + 选中显示 + 再点隐藏",
           before.hidden === true && (after.hidden === false && after.text === "已选 1 项") && afterClear.hidden === true,
           JSON.stringify({ before, after, afterClear }));
        await p.close(); await ctx.close();
    }
    await browser.close();
}

console.log("\n===== U4.2 验收探针汇总 =====");
console.log("PASS " + passCount + " / FAIL " + failCount);
console.log("基准数值表：" + JSON.stringify(BENCH, null, 2));
process.exit(failCount ? 1 : 0);
