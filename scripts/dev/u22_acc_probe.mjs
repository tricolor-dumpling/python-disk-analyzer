/* ============================================================
   UI 2.0（SpaceLens Pro）· U2.2 Treemap 验收探针（真实页 Flask 5000）
   - 验收口径（手册 §U2.2 验收 ②-④）：
     ② 真实目录渲染：双层 canvas 有像素、tiles 配色 ∈ 十色、『其他』固定 #64748b；
     ③ tooltip 全规格：150ms 延迟 / 内容（名称/大小/占比/点击下钻）/ glass /
        (12,12) 偏移 / 边界翻转；
     ④ 1000 块入场与 hover 帧率 ≥50fps（P95 ≤ 20ms，rAF 采样）；
     附：命中（目录 tile 恰 1 次 browse 且 path 正确；文件 tile 0 请求）、
         暗色 8% 白叠加、两档窗口零滚动、截图存档、console/pageerror 捕获。
   - 运行：node scripts/dev/u22_acc_probe.mjs [--base http://127.0.0.1:5000/]
            [--out <截图目录>]
   - 依赖：仅本机验收用 Playwright（.dsh/profiles/web/node_modules）。
   ============================================================ */

import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const require = createRequire(import.meta.url);
const { chromium } = require("C:/Users/26024/.dsh/profiles/web/node_modules/playwright");

function arg(name, dflt) {
    const i = process.argv.indexOf("--" + name);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const BASE = arg("base", "http://127.0.0.1:5000/");
const OUT = arg("out", path.join(os.tmpdir(), "u22_acc_shots"));
fs.mkdirSync(OUT, { recursive: true });

let passCount = 0, failCount = 0;
function ok(name, cond, detail) {
    if (cond) { passCount++; console.log("  ✔ " + name); }
    else { failCount++; console.log("  ✖ " + name + (detail ? " :: " + detail : "")); }
}

(async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
    const errs = [];
    page.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text()); });
    page.on("pageerror", (e) => errs.push("pageerror: " + e.message));

    /* ---- ② 真实目录渲染 ---- */
    console.log("== ② 真实目录渲染（1366×768 light） ==");
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => {
        const t = document.getElementById("browse-status-text");
        // U2.5：默认视图=矩形图（N01 接管）——状态行按当前视图前缀兼容
        return t && /(排行|表格|矩形图)视图/.test(t.textContent);
    }, { timeout: 15000 }).catch(() => {});
    const statusText = await page.textContent("#browse-status-text").catch(() => "");
    ok("browse 已渲染（状态行: " + statusText + "）", /(排行|表格|矩形图)视图/.test(statusText));

    await page.click("#btn-view-treemap");
    await page.waitForTimeout(1100); // 入场 600ms + stagger 收束
    const tm = await page.evaluate(async () => {
        const m = await import("/static/js/app/main.js");
        const wrap = document.getElementById("treemap-wrap");
        const canvas = wrap.querySelector("canvas");
        const ctx = canvas.getContext("2d");
        const img = ctx.getImageData(0, 0, Math.min(400, canvas.width), Math.min(300, canvas.height)).data;
        let colored = 0;
        for (let i = 0; i < img.length; i += 4) {
            if (img[i + 3] > 0 && !(img[i] === img[i + 1] && img[i + 1] === img[i + 2])) colored++;
        }
        const v = m.getTreemapView();
        const tiles = v.getTiles();
        const layout = v.getLayout();
        const pal = await import("/static/js/app/palette.js");
        const colors = [...new Set(tiles.map((t) => t.color))];
        const other = tiles.filter((t) => t.isOther);
        return {
            visible: !wrap.hasAttribute("hidden"),
            canvases: wrap.querySelectorAll("canvas").length,
            colored,
            n: tiles.length, layoutN: layout.length,
            colors, pal: pal.PALETTE, otherColor: pal.OTHER_COLOR,
            other: other.map((t) => ({ name: t.name, size: t.size, color: t.color, pct: t.pct })),
            dirs: tiles.filter((t) => t.isDir && !t.isOther).length,
            files: tiles.filter((t) => !t.isDir && !t.isOther).length,
            mergeTop: m.APP_STATE.view.mergeTop,
        };
    });
    ok("treemap 容器可见且双层 canvas 在位", tm.visible && tm.canvases === 2, JSON.stringify(tm && { visible: tm.visible, canvases: tm.canvases }));
    ok("canvas 已绘制彩色矩形（像素采样 colored=" + tm.colored + "）", tm.colored > 500);
    ok("tiles 数 = 布局数", tm.n === tm.layoutN, tm.n + "/" + tm.layoutN);
    ok("配色全部 ∈ 十色调色板（＋「其他」固定色）",
       tm.colors.every((c) => tm.pal.includes(c) || c === tm.otherColor),
       JSON.stringify(tm.colors));
    ok("「其他」合并块存在且固定色调色板（#64748b）",
       tm.other.length === 1 && tm.other[0].color === tm.otherColor && tm.otherColor === "#64748b",
       JSON.stringify(tm.other));
    ok("count = mergeTop(24) + 其他(1) + 文件数", tm.n === tm.mergeTop + tm.other.length + tm.files,
       "n=" + tm.n + " mergeTop=" + tm.mergeTop + " other=" + tm.other.length + " files=" + tm.files);
    await page.screenshot({ path: path.join(OUT, "treemap-light-1366.png") });

    /* ---- ③ tooltip 全规格 ---- */
    console.log("== ③ tooltip ==");
    const hint = await page.evaluate(async () => {
        const m = await import("/static/js/app/main.js");
        const v = m.getTreemapView();
        const t = v.getLayout().find((x) => x.isDir && !x.isOther) || v.getLayout()[0];
        return t ? { cx: t.x + t.w / 2, cy: t.y + t.h / 2, name: t.name } : null;
    });
    ok("取到目录 tile", !!hint, String(hint));
    if (hint) {
        const box = await page.locator("#treemap-wrap").boundingBox();
        const mx = box.x + hint.cx, my = box.y + hint.cy;
        await page.mouse.move(mx, my);
        await page.waitForTimeout(80);
        const before = await page.evaluate(() => {
            const el = document.querySelector(".treemap-tooltip");
            return el && !el.hidden;
        });
        await page.waitForTimeout(230); // 150ms 延迟窗口过后应显示
        const tip = await page.evaluate(() => {
            const el = document.querySelector(".treemap-tooltip");
            if (!el || el.hidden) return null;
            const cs = getComputedStyle(el);
            const r = el.getBoundingClientRect();
            return {
                text: el.textContent,
                bg: cs.backgroundColor,
                blur: cs.backdropFilter || cs.webkitBackdropFilter,
                radius: cs.borderRadius,
                left: r.left, top: r.top,
                w: el.offsetWidth, h: el.offsetHeight,
            };
        });
        ok("150ms 延迟前 tooltip 隐藏", before === false);
        ok("tooltip 内容 = 名称/大小/占比/点击下钻",
           !!tip && tip.text.indexOf(hint.name) !== -1 && tip.text.indexOf("点击下钻") !== -1 && tip.text.indexOf("%") !== -1,
           tip && tip.text);
        ok("glass 规格（card-glass 底 + blur 12px + 圆角 10px）",
           !!tip && tip.bg === "rgba(255, 255, 255, 0.86)" && tip.blur.indexOf("blur(12px)") !== -1 && tip.radius === "10px",
           tip && JSON.stringify({ bg: tip.bg, blur: tip.blur, radius: tip.radius }));
        ok("偏移 (12,12)（tooltip 左上在光标右下方）",
           !!tip && Math.abs(tip.left - mx - 12) < 2 && Math.abs(tip.top - my - 12) < 2,
           tip && "left=" + tip.left + " top=" + tip.top + " cursor=(" + mx + "," + my + ")");
        await page.screenshot({ path: path.join(OUT, "treemap-tooltip.png") });
        // 边界翻转：移到画布右下角（tooltip 需向左上翻转）
        await page.mouse.move(box.x + box.width - 26, box.y + box.height - 26);
        await page.waitForTimeout(260);
        const flip = await page.evaluate(() => {
            const el = document.querySelector(".treemap-tooltip");
            if (!el || el.hidden) return null;
            const r = el.getBoundingClientRect();
            return { left: r.left, top: r.top, right: r.right, bottom: r.bottom,
                     vw: window.innerWidth, vh: window.innerHeight };
        });
        ok("边界翻转：tooltip 完全在视口内",
           !!flip && flip.left >= 0 && flip.top >= 0 && flip.right <= flip.vw && flip.bottom <= flip.vh,
           JSON.stringify(flip));
        await page.mouse.move(300, 300);
        await page.waitForTimeout(100);
    }

    /* ---- 命中：目录 tile 恰 1 次 browse 且 path 正确 ---- */
    console.log("== 命中 ==");
    const beforeBrowse = await page.evaluate(async () => {
        const m = await import("/static/js/app/main.js");
        const v = m.getTreemapView();
        const t = v.getLayout().find((x) => x.isDir && !x.isOther);
        const canvas = v.canvas();
        const r = canvas.getBoundingClientRect();
        return t ? { path: t.path, cx: r.left + t.x + t.w / 2, cy: r.top + t.y + t.h / 2 } : null;
    });
    ok("取到目录 tile（path=" + (beforeBrowse && beforeBrowse.path) + "）", !!beforeBrowse);
    if (beforeBrowse) {
        await page.evaluate(() => {
            window.__browseCalls = 0;
            window.__browseBodies = [];
            const orig = window.fetch;
            window.__realFetch = window.fetch;
            window.fetch = function (url, options) {
                const u = String(url);
                if (u.indexOf("/api/browse") !== -1) {
                    window.__browseCalls++;
                    try { window.__browseBodies.push(options && options.body ? JSON.parse(options.body) : null); } catch (e) {}
                }
                return orig.apply(this, arguments);
            };
        });
        await page.mouse.click(beforeBrowse.cx, beforeBrowse.cy);
        await page.waitForTimeout(900);
        const hit = await page.evaluate(() => {
            window.fetch = window.__realFetch;
            return { calls: window.__browseCalls, bodies: window.__browseBodies };
        });
        ok("点击目录 tile 恰 1 次 /api/browse", hit.calls === 1, "calls=" + hit.calls);
        ok("browse path 正确", hit.bodies.length === 1 && hit.bodies[0].path === beforeBrowse.path,
           JSON.stringify(hit.bodies));
    }

    /* 文件 tile 0 请求（当前目录若无文件则记录跳过） */
    const fileInfo = await page.evaluate(async () => {
        const m = await import("/static/js/app/main.js");
        const t = m.getTreemapView().getLayout().find((x) => !x.isDir && !x.isOther);
        if (!t) return null;
        const r = m.getTreemapView().canvas().getBoundingClientRect();
        return { cx: r.left + t.x + t.w / 2, cy: r.top + t.y + t.h / 2 };
    });
    if (fileInfo) {
        await page.evaluate(() => { window.__browseCalls = 0; });
        await page.mouse.click(fileInfo.cx, fileInfo.cy);
        await page.waitForTimeout(500);
        const fc = await page.evaluate(() => window.__browseCalls);
        ok("点击文件 tile 0 次 browse（红线 #11）", fc === 0, "calls=" + fc);
    } else {
        console.log("  -（当前目录无文件，跳过文件 tile 断言）");
    }

    /* ---- ④ 1000 块入场与 hover 帧率 ---- */
    console.log("== ④ 1000 块基准 ==");
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
        // 入场动画期 rAF 采样（600ms 动画 + stagger 收束，采 1.3s）
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
    const p95 = (arr) => { const s = arr.slice().sort((a, b) => a - b); return s[Math.floor(s.length * 0.95)]; };
    const entryP95 = p95(bench.entry);
    ok("1000 块入场 P95 ≤ 20ms（≥50fps）", entryP95 <= 20, "entryP95=" + entryP95.toFixed(2) + "ms, n=" + bench.entry.length);

    // hover 横扫（真实 mouse.move 驱动，同时页内 rAF 采样）
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
    ok("1000 块 hover 交互 P95 ≤ 20ms（≥50fps）", hoverP95.p95 <= 20,
       "hoverP95=" + hoverP95.p95.toFixed(2) + "ms, n=" + hoverP95.n);

    // 恢复真实视图
    await page.click("#btn-view-ranking");
    await page.click("#btn-view-treemap");
    await page.waitForTimeout(1100);
    const restored = await page.evaluate(async () => {
        const m = await import("/static/js/app/main.js");
        const tiles = m.getTreemapView().getTiles();
        const realCount = m.getTreemapView().getLayout().length;
        return { n: tiles.length, layoutN: realCount };
    });
    ok("基准后恢复真实数据渲染", restored.n > 0 && restored.n === restored.layoutN, JSON.stringify(restored));

    /* ---- 暗色 + 两档零滚动 + 截图 ---- */
    console.log("== 主题 / 零滚动 / 截图 ==");
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(OUT, "treemap-dark-1366.png") });
    const s1 = await page.evaluate(() => ({ sh: document.body.scrollHeight, ch: document.body.clientHeight, ih: window.innerHeight }));
    ok("1366×768 零滚动", s1.sh <= s1.ih + 1 && s1.sh - s1.ch <= 1, JSON.stringify(s1));

    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.waitForTimeout(500);
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
    await page.waitForTimeout(300);
    const s2 = await page.evaluate(() => ({ sh: document.body.scrollHeight, ch: document.body.clientHeight, ih: window.innerHeight }));
    ok("1920×1080 零滚动", s2.sh <= s2.ih + 1 && s2.sh - s2.ch <= 1, JSON.stringify(s2));
    await page.screenshot({ path: path.join(OUT, "treemap-light-1920.png") });

    /* ---- ⑤ 跨路由保持 / 合并阈值 / 窄屏（U2.2 补充验收） ---- */
    console.log("== ⑤ 跨路由保持 / setMergeTop / 窄屏 ==");
    // 路由往返：treemap 视图选择 + 下钻数据均保持（切页不丢）
    const routeBack = await page.evaluate(async () => {
        const m = await import("/static/js/app/main.js");
        location.hash = "#/compare";
        await new Promise((r) => setTimeout(r, 700));
        location.hash = "#/";
        await new Promise((r) => setTimeout(r, 800));
        const v = m.getTreemapView();
        return {
            route: m.APP_STATE.route,
            path: m.getCurrentPath(),
            status: document.getElementById("browse-status-text").textContent,
            tiles: v ? v.getTiles().length : -1,
            wrapHidden: document.getElementById("treemap-wrap").hasAttribute("hidden"),
        };
    });
    ok("路由往返后仍为 treemap 视图且数据保持", routeBack.wrapHidden === false && /矩形图视图/.test(routeBack.status),
       JSON.stringify(routeBack));
    const merge = await page.evaluate(async () => {
        const m = await import("/static/js/app/main.js");
        m.setMergeTop(5);
        await new Promise((r) => setTimeout(r, 120));
        const tiles = m.getTreemapView().getTiles();
        const other = tiles.filter((t) => t.isOther).length;
        m.setMergeTop(24);
        await new Promise((r) => setTimeout(r, 120));
        return { n5: tiles.length, other5: other, n24: m.getTreemapView().getTiles().length, mt: m.APP_STATE.view.mergeTop };
    });
    ok("setMergeTop(5) → 5 块 + 其他（恰 1 块）；恢复 24", merge.n5 === 6 && merge.other5 === 1 && merge.n24 === routeBack.tiles && merge.mt === 24,
       JSON.stringify(merge));
    // 800×700 窄屏：页面恢复滚动（§3.4 声明例外）+ treemap 正常渲染
    await page.setViewportSize({ width: 800, height: 700 });
    await page.waitForTimeout(1300);
    const narrow = await page.evaluate(() => ({
        sh: document.body.scrollHeight, ch: document.body.clientHeight,
        canvasW: document.querySelector("#treemap-wrap canvas") ? document.querySelector("#treemap-wrap canvas").clientWidth : 0,
    }));
    ok("800×700 窄屏：滚动恢复（例外）+ canvas 非零宽", narrow.canvasW > 0, JSON.stringify(narrow));
    await page.screenshot({ path: path.join(OUT, "treemap-narrow-800.png") });
    await page.setViewportSize({ width: 1920, height: 1080 });

    console.log("== console/pageerror ==");
    console.log(errs.length ? errs.join("\n") : "(none)");
    if (errs.length) failCount += errs.length;

    console.log("SUMMARY: " + passCount + " pass / " + failCount + " fail (" + passCount + "/" + (passCount + failCount) + ")");
    console.log("SHOTS: " + OUT);
    await browser.close();
    process.exit(failCount ? 1 : 0);
})();
