/* ============================================================
   阶段 P3 · p03_rail_layout_probe.mjs（问题 3/4 右栏排版自适应验收探针）
   ------------------------------------------------------------
   目标（计划第九章 · P3）：
     三视口（1366×768 / 1440×900 / 1920×1080）
     × 三态（idle / scanning / done）
     → 右栏（#side-rail）文本溢出 / 竖排 / 兄弟重叠 / 横向逃逸 / 内滚 量化。

   判据（硬违规，任一 >0 即 exit 1）：
     1. clipped   **文本被硬切**：元素内文本节点的 Range 外延超出其内容盒 >1px，
                  且 computed text-overflow ≠ ellipsis（既未换行也无省略号）。
                  —— 对应 D3-4「禁止裸 nowrap + 无 overflow」。
                  ⚠️ 判据用「文本外延 vs 内容盒」，不用 scrollWidth−clientWidth：
                  装饰性绝对定位伪元素也计入可滚动溢出区（`.btn-stop::after
                  {inset:-2px}` 的呼吸光环恒贡献 2px），会把装饰误判为文字裁切。
     2. escape   元素边框盒右/左缘越过 #side-rail 内容盒 → 被 overflow-x:hidden 静默切掉。
     3. overlap  同容器直接子元素两两 rect 交集 >4px（父子包含豁免）→ 压盖。
     4. titleWrap 卡标题（右栏 h2）文本行数 >1 → 竖排/折行（「存储概 / 览」形态）。
     5. railScroll（仅 1366×768，P6 红线口径）右栏 scrollHeight > clientHeight+1。
     6. console  console.error / pageerror 计数 >0。

   允许并单独统计（非违规）：
     · ellipsis  元素显式声明了 text-overflow:ellipsis + overflow:hidden
                 （有省略号提示的截断 = D3-4 明确允许的第二种策略）。

   桩态纪律：
     · fetch 全量覆写（零真实后端依赖）；三态文案为**真实长文案**
       （长盘符/长盘名/长 ETA），否则复现不出竖排与裁切。
     · 扫描态 ETA：先让首拍落 scanStartTs，再对 Date.now 施加 +7385s 偏移，
       使「已用时 / 预计剩余」进入小时量级（真实长文案），不伪造 DOM。
     · dense 对照图：idle@1366 额外裁剪 .tool-row 区域，文件名带 --label，
       供「密度开关删除前后对照 2 张」使用。

   用法：
     node scripts/dev/p03_rail_layout_probe.mjs --base http://127.0.0.1:5000/ \
          --out <绝对目录> --label prefix|postfix
   输出：
     <out>/rail-<state>-<w>x<h>.png   ×9
     <out>/toolbar-<label>-1366x768.png（密度对照）
     <out>/layout.json  逐文本节点 scrollWidth/clientWidth + 卡片 rect + rail 内滚
     <out>/summary.json 违规汇总 + 判定
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
const OUT = path.resolve(arg("out", path.join(os.tmpdir(), "p03_rail_layout")));
const LABEL = arg("label", "run");
fs.mkdirSync(OUT, { recursive: true });

const VIEWPORTS = [
    { w: 1366, h: 768 },
    { w: 1440, h: 900 },
    { w: 1920, h: 1080 },
];
const STATES = ["idle", "scanning", "done"];

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---- 桩态：三根（含一条长盘名/长路径根） + 三盘容量的概览数据 ----
   真实长文案来源：根 `E:\项目归档\2024年度\原始数据（第三批）` 同时作为
   扫描卡「当前」盘名、盘符 chips 标签与概览 chips 标签（复现竖排/裁切）。 */
const LONG_ROOT = "E:\\项目归档\\2024年度\\原始数据（第三批）";
const ROOTS_JSON = JSON.stringify(["C:\\", "D:\\", LONG_ROOT]);
const LONG_ROOT_JSON = JSON.stringify(LONG_ROOT);
const STUB_FN = `
window.__stub = { scanState: "idle", scanVersion: 1, fetchLog: [] };
window.fetch = function (url, options) {
  options = options || {};
  var key = (options.method || "GET").toUpperCase() + " " + String(url).split("?")[0];
  window.__stub.fetchLog.push(key);
  var json = function (o, s) { return Promise.resolve({ ok: (s || 200) < 400, status: s || 200,
    json: function () { return Promise.resolve(JSON.parse(JSON.stringify(o))); } }); };
  var ROOTS = ${ROOTS_JSON};
  var LONG = ${LONG_ROOT_JSON};
  if (key === "GET /api/health") return json({ ok: true, ready: true, dll: "stub-dll", message: "Everything 已就绪", busy: false });
  if (key === "GET /api/settings") return json({ ok: true, settings: { auto_save: true, last_roots: ROOTS }, data_dir: "C:\\\\stub\\\\data", snapshots_dir: "C:\\\\stub\\\\snapshots" });
  if (key === "POST /api/browse") return json({ ok: true, root: "D:\\\\", parent: null,
    directories: [
      { name: "2024年度归档资料与原始影像（第三批）", path: "D:\\\\2024年度归档资料与原始影像（第三批）", is_dir: true, size: 39800000000, size_human: "37.07 GB" },
      { name: "data", path: "D:\\\\data", is_dir: true, size: 1200000000, size_human: "1.12 GB" }
    ],
    files: [ { name: "readme.txt", path: "D:\\\\readme.txt", is_dir: false, size: 102400, size_human: "100 KB" } ],
    total_dirs: 2, total_files: 1, source: "sdk", source_at: "2026-09-11T12:00:00" });
  if (key === "GET /api/fullscan/status") {
    var s = window.__stub.scanState;
    var base = { roots: ROOTS, roots_total: 3, error: null, scan_version: window.__stub.scanVersion,
      stop_requested: false, stop_reason: null, phase: "idle", lock_holder: null,
      row_done: 250000, row_total: 900000, stop_ack_at: null };
    if (s === "scanning") return json({ ok: true, status: Object.assign({}, base, {
      running: true, roots_done: 1, current_root: LONG,
      result_ready: false, save_ready: false, progress_pct: 41, phase: "scanning", lock_holder: "fullscan" }) });
    if (s === "done") return json({ ok: true, status: Object.assign({}, base, {
      running: false, roots_done: 3, current_root: null, result_ready: true, save_ready: false,
      progress_pct: 100, autosave_outcome: { outcome: "saved", saved: ROOTS, failed: [], skipped_roots: [] } }) });
    return json({ ok: true, status: Object.assign({}, base, {
      running: false, roots_done: 0, current_root: null, result_ready: false, save_ready: false, progress_pct: 0 }) });
  }
  if (key === "GET /api/snapshots") return json({ ok: true, count: 1, sessions: [ {
    id: "20260911-120000", created_at: "2026-09-11T12:00:00", kind: "auto", roots: ROOTS,
    total: 121791848819, total_human: "113.43 GB", note: "自动保存" } ] });
  if (key === "GET /api/overview") {
    var s2 = window.__stub.scanState;
    var rootsData = [
      { root: "C:\\\\", total: 42992622633, total_human: "40.04 GB", index_ready: true, index_valid: true, directories: [], files: [], directory_count: 12, file_count: 240, record_count: 252, completed_at: "2026-09-11T11:58:00" },
      { root: "D:\\\\", total: 51539607552, total_human: "48.00 GB", index_ready: true, index_valid: true, directories: [], files: [], directory_count: 30, file_count: 900, record_count: 930, completed_at: "2026-09-11T11:59:00" },
      { root: LONG, total: 27259618634, total_human: "25.39 GB", index_ready: true, index_valid: true, directories: [], files: [], directory_count: 8, file_count: 4100, record_count: 4108, completed_at: "2026-09-11T12:00:00" }
    ];
    if (s2 === "scanning") return json({ ok: true, ready: true, scanning: true, empty_reason: "scanning",
      roots: rootsData, progress_pct: 41, current_root: LONG, roots_done: 1, roots_total: 3 });
    if (s2 === "done") return json({ ok: true, ready: true, scanning: false, roots: rootsData, completed_at: "2026-09-11T12:00:00" });
    return json({ ok: true, ready: true, scanning: false, roots: rootsData, completed_at: "2026-09-11T11:00:00" });
  }
  if (key === "GET /api/compare/status") return json({ ok: true, running: false });
  return json({ ok: true });
};
`;

/* ---- 页内测量：文本节点 / 卡片 rect / 内滚 / 重叠 / 竖排 ---- */
function measure() {
    const rail = document.getElementById("side-rail");
    if (!rail) return { error: "no #side-rail" };
    const rr = rail.getBoundingClientRect();
    const rcs = getComputedStyle(rail);
    const padL = parseFloat(rcs.paddingLeft) || 0;
    const padR = parseFloat(rcs.paddingRight) || 0;
    const bL = parseFloat(rcs.borderLeftWidth) || 0;
    const bR = parseFloat(rcs.borderRightWidth) || 0;
    const cLeft = rr.left + padL + bL;
    const cRight = rr.right - padR - bR;

    const ident = (el) => {
        if (el.id) return "#" + el.id;
        const cls = typeof el.className === "string" && el.className.trim()
            ? "." + el.className.trim().split(/\s+/).join(".") : "";
        return el.tagName.toLowerCase() + cls;
    };
    const rectOf = (el) => {
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.x * 10) / 10, y: Math.round(r.y * 10) / 10,
                 w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10,
                 right: Math.round(r.right * 10) / 10, left: Math.round(r.left * 10) / 10 };
    };
    /* 行数 = 元素内所有非空文本节点所占**不同行顶坐标**数。
       ⚠️ 不能对含 <svg> 图标的标题直接 selectNodeContents().getClientRects().length
       ——SVG 元素自身也贡献 1 个 rect，会把单行标题误判为 2 行（首版探针缺陷，
       已在基线复现时发现并修正：图标不得计入文本行数）。 */
    const lineCount = (el) => {
        const tops = new Set();
        const w2 = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
        let t;
        while ((t = w2.nextNode())) {
            if (!t.nodeValue || !t.nodeValue.trim()) continue;
            const rng = document.createRange();
            rng.selectNodeContents(t);
            const rects = rng.getClientRects();
            for (let i = 0; i < rects.length; i++) tops.add(Math.round(rects[i].top));
        }
        return tops.size;
    };
    /* 文本实际外延（Range 逐文本节点 client rects 求并集）。
       ⚠️ 判「文本是否被硬切」必须用文本外延 vs 内容盒，**不能**用
       scrollWidth − clientWidth：装饰性绝对定位伪元素同样计入可滚动溢出区
       （实测 `.btn-stop::after{inset:-2px}` 的呼吸光环让 #btn-stop-scan
       恒有 scrollWidth−clientWidth = 2px，与文字无关——首版探针的第二处缺陷，
       已在修复前/后对照时定位并以文本外延判据取代）。 */
    const textExtent = (el) => {
        let L = Infinity, R = -Infinity;
        const w3 = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
        let t;
        while ((t = w3.nextNode())) {
            if (!t.nodeValue || !t.nodeValue.trim()) continue;
            const rng = document.createRange();
            rng.selectNodeContents(t);
            const rects = rng.getClientRects();
            for (let i = 0; i < rects.length; i++) {
                if (rects[i].width === 0 && rects[i].height === 0) continue;
                L = Math.min(L, rects[i].left);
                R = Math.max(R, rects[i].right);
            }
        }
        return L === Infinity ? null : { left: L, right: R };
    };

    /* 1) 逐文本节点（父元素去重） */
    const texts = [];
    const seen = new Set();
    const walker = document.createTreeWalker(rail, NodeFilter.SHOW_TEXT, null);
    let n;
    while ((n = walker.nextNode())) {
        const raw = n.nodeValue;
        if (!raw || !raw.trim()) continue;
        const el = n.parentElement;
        if (!el || seen.has(el)) continue;
        seen.add(el);
        const r = rectOf(el);
        if (r.w === 0 && r.h === 0) continue;
        const c = getComputedStyle(el);
        const inline = c.display.indexOf("inline") === 0;
        const lines = lineCount(el);
        const over = el.scrollWidth - el.clientWidth;
        const isEllipsis = c.textOverflow === "ellipsis" && (c.overflowX === "hidden" || c.overflowX === "clip");
        /* 文本外延 vs 内容盒（内容盒 = 边框盒 − 边框 − 内边距） */
        const ext = textExtent(el);
        const contentL = r.left + (parseFloat(c.borderLeftWidth) || 0) + (parseFloat(c.paddingLeft) || 0);
        const contentR = r.right - (parseFloat(c.borderRightWidth) || 0) - (parseFloat(c.paddingRight) || 0);
        const textOver = ext ? Math.round(Math.max(ext.right - contentR, contentL - ext.left) * 10) / 10 : 0;
        texts.push({
            sel: ident(el), tag: el.tagName, inline,
            text: raw.trim().slice(0, 70), textLen: raw.trim().length,
            clientW: el.clientWidth, scrollW: el.scrollWidth, over: inline ? 0 : over,
            rect: r, lines,
            whiteSpace: c.whiteSpace, overflowX: c.overflowX, textOverflow: c.textOverflow,
            overflowWrap: c.overflowWrap, wordBreak: c.wordBreak, display: c.display,
            textOver: Math.max(0, textOver),
            clipped: (textOver > 1 && !isEllipsis),
            ellipsized: (textOver > 1 && isEllipsis),
            escape: Math.round((Math.max(r.right - cRight, cLeft - r.left)) * 10) / 10,
        });
    }

    /* 2) 卡片 rect（右栏直接子节点） */
    const cards = Array.from(rail.children).map((el) => {
        const r = rectOf(el);
        return { sel: ident(el), rect: r, scrollH: el.scrollHeight, clientH: el.clientHeight };
    });

    /* 3) 兄弟重叠（限定容器：右栏与其卡片/卡头/行容器） */
    const containers = [rail].concat(Array.from(rail.querySelectorAll(
        ".card-head,.overview-head,.overview-actions,.storage-row,.donut-legend,.status-line,.chips-row,.progress-wrap,.row,.overview-roots,.card")));
    const overlaps = [];
    containers.forEach((box) => {
        const kids = Array.from(box.children).filter((el) => {
            const c = getComputedStyle(el);
            if (c.display === "none" || c.visibility === "hidden") return false;
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
        });
        const contains = (a, b) => a.left >= b.left - 0.5 && a.top >= b.top - 0.5 &&
            a.right <= b.right + 0.5 && a.bottom <= b.bottom + 0.5;
        for (let i = 0; i < kids.length; i++) {
            for (let j = i + 1; j < kids.length; j++) {
                const a = kids[i].getBoundingClientRect(), b = kids[j].getBoundingClientRect();
                if (contains(a, b) || contains(b, a)) continue;
                const xo = Math.min(a.right, b.right) - Math.max(a.left, b.left);
                const yo = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
                if (xo > 4 && yo > 4) {
                    overlaps.push({ box: ident(box), a: ident(kids[i]), b: ident(kids[j]),
                                    xOverlap: Math.round(xo), yOverlap: Math.round(yo) });
                }
            }
        }
    });

    /* 4) 卡标题行数（右栏 h2/h3：>1 行 = 竖排/折行） */
    const titles = Array.from(rail.querySelectorAll("h2,h3")).map((el) => {
        return { sel: ident(el), text: (el.textContent || "").trim(), lines: lineCount(el), rect: rectOf(el) };
    });

    return {
        vw: window.innerWidth, vh: window.innerHeight,
        rail: {
            rect: rectOf(rail), scrollW: rail.scrollWidth, clientW: rail.clientWidth,
            scrollH: rail.scrollHeight, clientH: rail.clientHeight,
            scrollDelta: rail.scrollHeight - rail.clientHeight,
            overflowX: rcs.overflowX, overflowY: rcs.overflowY,
            padding: rcs.padding, gap: rcs.gap, width: rcs.width, flex: rcs.flex,
        },
        cards, texts, overlaps, titles,
        statusText: (document.getElementById("fullscan-status-text") || {}).textContent || "",
        etaText: (document.getElementById("scan-eta") || {}).textContent || "",
        elapsedText: (document.getElementById("scan-elapsed") || {}).textContent || "",
        legendText: (document.getElementById("overview-legend") || {}).textContent || "",
    };
}

const RESULT = {
    meta: { base: BASE, out: OUT, label: LABEL, node: process.version, startedAt: new Date().toISOString(),
            viewports: VIEWPORTS.map((v) => v.w + "x" + v.h), states: STATES.slice() },
    shots: [], samples: [], consoleErrors: [],
};

async function forcePoll(page) {
    await page.evaluate(async () => {
        const m = await import("/static/js/app/components/scan.js");
        await m.pollFullscan();
    }).catch(() => {});
    await wait(250);
}

async function anchor(page, state) {
    if (state === "scanning") return page.waitForFunction(
        () => /总进度/.test((document.getElementById("fullscan-status-text") || {}).textContent || ""), { timeout: 12000 }).catch(() => {});
    if (state === "done") return page.waitForFunction(
        () => /全量扫描已完成/.test((document.getElementById("fullscan-status-text") || {}).textContent || ""), { timeout: 12000 }).catch(() => {});
    return page.waitForFunction(
        () => /尚未开始全量扫描/.test((document.getElementById("fullscan-status-text") || {}).textContent || ""), { timeout: 12000 }).catch(() => {});
}

async function setState(page, state) {
    await page.evaluate((s) => { window.__stub.scanState = s; }, state);
    await forcePoll(page);
    await anchor(page, state);
    if (state === "scanning") {
        /* 首拍已落 scanStartTs → 施加时间偏移，使「已用时/预计剩余」进入小时量级
           （真实长文案；不伪造 DOM 文本） */
        await page.evaluate(() => {
            if (window.__p03TimeShifted) return;
            const real = Date.now;
            Date.now = () => real.call(Date) + 7385000;
            window.__p03TimeShifted = true;
        });
        await forcePoll(page);
        await page.waitForFunction(
            () => { const e = document.getElementById("scan-eta"); return !!e && !e.hidden && /预计剩余/.test(e.textContent || ""); },
            { timeout: 12000 }).catch(() => {});
    }
    await wait(400);
}

function tally(sample) {
    const clipped = sample.texts.filter((t) => t.clipped);
    const ellipsized = sample.texts.filter((t) => t.ellipsized);
    const escape = sample.texts.filter((t) => t.escape > 1);
    const titleWrap = sample.titles.filter((t) => t.lines > 1);
    return {
        key: sample.state + "@" + sample.vw + "x" + sample.vh,
        clipped: clipped.length, ellipsized: ellipsized.length,
        escape: escape.length, overlap: sample.overlaps.length, titleWrap: titleWrap.length,
        railScrollDelta: sample.rail.scrollDelta,
        railScrollViolation: sample.vw === 1366 && sample.rail.scrollDelta > 1 ? 1 : 0,
        clippedList: clipped.map((t) => ({ sel: t.sel, text: t.text, textOver: t.textOver, over: t.over, whiteSpace: t.whiteSpace, textOverflow: t.textOverflow })),
        escapeList: escape.map((t) => ({ sel: t.sel, text: t.text, escape: t.escape })),
        overlapList: sample.overlaps,
        titleWrapList: titleWrap.map((t) => ({ sel: t.sel, text: t.text, lines: t.lines, w: t.rect.w })),
    };
}

(async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        for (const vp of VIEWPORTS) {
            const page = await browser.newPage({ viewport: { width: vp.w, height: vp.h } });
            page.on("console", (m) => {
                if (m.type() !== "error") return;
                const loc = (m.location && m.location() && m.location().url) || "";
                RESULT.consoleErrors.push(vp.w + "x" + vp.h + " console: " + m.text() + " @ " + loc);
            });
            page.on("pageerror", (e) => RESULT.consoleErrors.push(vp.w + "x" + vp.h + " pageerror: " + e.message));
            await page.addInitScript(() => { try { localStorage.setItem("pds_onboarding_dismissed_v1", "1"); } catch (e) {} });
            await page.addInitScript(() => { try { localStorage.setItem("pds_theme_v1", "light"); } catch (e) {} });
            await page.addInitScript(() => { try { sessionStorage.setItem("pds_auto_started_v1", "1"); } catch (e) {} });
            await page.addInitScript(STUB_FN);
            await page.goto(BASE, { waitUntil: "load", timeout: 25000 }).catch((e) => { RESULT.meta.gotoError = String(e); });
            await page.waitForFunction(() => !!document.getElementById("side-rail"), { timeout: 20000 }).catch(() => {});
            await page.waitForFunction(() => !!document.getElementById("overview-legend"), { timeout: 15000 }).catch(() => {});
            await wait(400);

            for (const state of STATES) {
                await setState(page, state);
                const sample = await page.evaluate(measure);
                sample.state = state;
                const f = `rail-${state}-${vp.w}x${vp.h}.png`;
                await page.screenshot({ path: path.join(OUT, f), fullPage: false });
                sample.shot = f;
                RESULT.shots.push(f);
                RESULT.samples.push(sample);
                if (state === "idle" && vp.w === 1366) {
                    const box = await page.locator(".tool-row").boundingBox();
                    const tf = `toolbar-${LABEL}-1366x768.png`;
                    if (box) await page.screenshot({ path: path.join(OUT, tf), clip: box });
                    sample.toolbarShot = box ? tf : null;
                    if (box) RESULT.shots.push(tf);
                }
            }
            await page.close();
        }
    } finally {
        await browser.close();
    }

    const summaries = RESULT.samples.map(tally);
    const totals = summaries.reduce((acc, s) => {
        acc.clipped += s.clipped; acc.escape += s.escape; acc.overlap += s.overlap;
        acc.titleWrap += s.titleWrap; acc.railScrollViolation += s.railScrollViolation;
        acc.ellipsized += s.ellipsized;
        return acc;
    }, { clipped: 0, escape: 0, overlap: 0, titleWrap: 0, railScrollViolation: 0, ellipsized: 0 });
    const consoleErrors = RESULT.consoleErrors.filter((m) => !/favicon/i.test(m));

    fs.writeFileSync(path.join(OUT, "layout.json"),
        JSON.stringify({ meta: RESULT.meta, samples: RESULT.samples }, null, 2), "utf-8");
    fs.writeFileSync(path.join(OUT, "summary.json"),
        JSON.stringify({ meta: RESULT.meta, totals, consoleErrors, perSample: summaries }, null, 2), "utf-8");

    const failed = totals.clipped > 0 || totals.escape > 0 || totals.overlap > 0 ||
        totals.titleWrap > 0 || totals.railScrollViolation > 0 || consoleErrors.length > 0;

    console.log("== p03_rail_layout_probe (" + LABEL + ") ==");
    console.log("out=" + OUT);
    summaries.forEach((s) => {
        console.log("  " + s.key.padEnd(20) + " clipped=" + s.clipped + " escape=" + s.escape +
            " overlap=" + s.overlap + " titleWrap=" + s.titleWrap +
            " railScrollΔ=" + s.railScrollDelta + (s.ellipsized ? " ellipsized=" + s.ellipsized : ""));
    });
    console.log("TOTAL clipped=" + totals.clipped + " escape=" + totals.escape + " overlap=" + totals.overlap +
        " titleWrap=" + totals.titleWrap + " railScrollViolation=" + totals.railScrollViolation +
        " consoleErrors=" + consoleErrors.length);
    summaries.forEach((s) => {
        s.clippedList.slice(0, 6).forEach((c) => console.log("  [clipped] " + s.key + " " + c.sel + " :: " + JSON.stringify(c)));
        s.escapeList.slice(0, 6).forEach((c) => console.log("  [escape ] " + s.key + " " + c.sel + " :: " + JSON.stringify(c)));
        s.overlapList.slice(0, 4).forEach((c) => console.log("  [overlap] " + s.key + " " + JSON.stringify(c)));
        s.titleWrapList.slice(0, 4).forEach((c) => console.log("  [title  ] " + s.key + " " + JSON.stringify(c)));
    });
    if (consoleErrors.length) console.log("console errors:\n" + consoleErrors.join("\n"));
    console.log(failed ? "P03 VERDICT: FAIL" : "P03 VERDICT: PASS");
    process.exit(failed ? 1 : 0);
})().catch((err) => {
    console.error("[p03] 运行失败：" + (err && err.stack ? err.stack : err));
    process.exit(2);
});
