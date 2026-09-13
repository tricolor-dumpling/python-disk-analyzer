/* ============================================================
   阶段 P2 · C 类证据：三视口终态截图（1366×768 / 1440×900 / 1920×1080）
   - 目的：证明修复后三视口的矩形图终态渲染正常（跨视口无残留、无空白画布）。
   - 每条视口除截图外还输出**量化自证**：
       · viewArea / treemapWrap / canvas 的 CSS 与设备像素尺寸（DPR 适配核对）；
       · `#treemap-wrap` hidden=false、display≠none、opacity=1；
       · `#table-wrap` display=none（互斥终态）；
       · canvas 静态层像素统计（非背景像素占比 + 方差）——防「空白画布」被当 PASS。
   - 输出：<out>/viewport-{W}x{H}.png + viewports.json
   - 运行：node scripts/dev/p02_c_viewport_shots.mjs --base http://127.0.0.1:5000/ --out <证据目录>
   - 纪律：headless + finally browser.close()；桩态确定性（不发真实 /api/browse）。
   ============================================================ */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { chromium, shot } from "./_harness.mjs";

function arg(name, dflt) {
    const i = process.argv.indexOf("--" + name);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const BASE = arg("base", "http://127.0.0.1:5000/");
const OUT = path.resolve(arg("out", path.join(os.tmpdir(), "p02_c_viewports")));
fs.mkdirSync(OUT, { recursive: true });

const VIEWPORTS = [
    { w: 1366, h: 768 },
    { w: 1440, h: 900 },
    { w: 1920, h: 1080 },
];

const STUB_FN = fs.readFileSync(new URL("./p02_view_frame_probe.mjs", import.meta.url), "utf-8")
    .match(/const STUB_FN = `([\s\S]*?)`;/)[1];

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
    const browser = await chromium.launch({ headless: true });
    const summary = { meta: { base: BASE, out: OUT, startedAt: new Date().toISOString() }, viewports: [], checks: [] };
    let page = null;
    try {
        for (const vp of VIEWPORTS) {
            const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h } });
            page = await ctx.newPage();
            const errs = [];
            page.on("console", (m) => {
                if (m.type() !== "error") return;
                const loc = m.location ? m.location() : null;
                if (loc && /favicon\.ico/i.test(loc.url)) return;
                if (/favicon\.ico/i.test(m.text())) return;
                errs.push(m.text());
            });
            page.on("pageerror", (e) => errs.push("pageerror: " + e.message));
            await page.addInitScript(() => {
                try { localStorage.setItem("pds_onboarding_dismissed_v1", "1"); } catch (e) { /* ignore */ }
                try { sessionStorage.setItem("pds_auto_started_v1", "1"); } catch (e) { /* ignore */ }
            });
            await page.addInitScript(STUB_FN);
            await page.goto(BASE, { waitUntil: "load", timeout: 20000 });
            await page.waitForFunction(() => {
                const w = document.getElementById("treemap-wrap");
                return w && !w.hasAttribute("hidden") && w.querySelectorAll("canvas").length > 0;
            }, { timeout: 20000 });
            await wait(1000); // 终态收敛（入场动画 + 收尾）

            /* ⚠️ 证据卫生：无头浏览器指针默认停在视口原点，落在矩形图上会让
               `scheduleTooltip` 的 150ms 延迟到时后弹出 `..treemap-tooltip`，
               在截图里留下「幽灵 tooltip」。截图前把指针移出矩形图并等待收尾，
               随后**断言 tooltip 已隐藏**（判据的一部分，杜绝污染帧被当 PASS）。 */
            await page.mouse.move(vp.w - 6, 6); // 视口右上角（工具行区域，非矩形图）
            await wait(400);
            const hygiene = await page.evaluate(() => {
                const tt = document.querySelector(".treemap-tooltip");
                return { tooltipExists: !!tt, tooltipHidden: tt ? tt.hidden : null,
                         tooltipText: tt ? (tt.textContent || "").slice(0, 40) : null };
            });

            const file = path.join(OUT, "viewport-" + vp.w + "x" + vp.h + ".png");
            await shot(page, file);
            const detail = await page.evaluate(() => {
                const area = document.getElementById("view-area");
                const tw = document.getElementById("treemap-wrap");
                const tb = document.getElementById("table-wrap");
                const c = document.querySelector("#treemap-wrap canvas.treemap-canvas:not(.treemap-fx)");
                const rect = (e) => { const r = e.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; };
                const cs = getComputedStyle(tw);
                /* 静态层像素统计：非背景像素占比 + 通道方差（防空白画布） */
                let nonBg = 0, n = 0, sum = 0, sum2 = 0;
                try {
                    const d = c.getContext("2d").getImageData(0, 0, Math.min(c.width, 400), Math.min(c.height, 300)).data;
                    n = d.length / 4;
                    for (let i = 0; i < d.length; i += 4) {
                        const lum = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
                        if (d[i + 3] > 8 && lum > 12) nonBg++;
                        sum += lum; sum2 += lum * lum;
                    }
                } catch (e) { /* 读像素失败 → 由 n=0 暴露 */ }
                const mean = n ? sum / n : 0;
                const variance = n ? Math.max(0, sum2 / n - mean * mean) : 0;
                return {
                    viewport: [innerWidth, innerHeight],
                    dpr: window.devicePixelRatio,
                    viewArea: rect(area),
                    treemapWrap: rect(tw),
                    canvasCss: rect(c),
                    canvasDevice: [c.width, c.height],
                    twHidden: tw.hasAttribute("hidden"),
                    twDisplay: cs.display, twOpacity: cs.opacity, twZ: cs.zIndex,
                    tbDisplay: getComputedStyle(tb).display,
                    fxCanvas: (() => { const f = document.querySelector("#treemap-wrap canvas.treemap-fx"); return f ? [f.width, f.height] : null; })(),
                    pixelStats: { sampled: n, nonBgRatio: n ? Number((nonBg / n).toFixed(4)) : null, lumStdDev: Number(Math.sqrt(variance).toFixed(3)) },
                    activeView: ["btn-view-treemap", "btn-view-ranking", "btn-view-table", "btn-view-relate"]
                        .find((id) => { const e = document.getElementById(id); return e && e.classList.contains("btn-primary"); }),
                };
            });
            const pass = detail.twHidden === false && detail.twDisplay !== "none" &&
                parseFloat(detail.twOpacity) === 1 && detail.tbDisplay === "none" &&
                detail.activeView === "btn-view-treemap" &&
                detail.pixelStats.nonBgRatio !== null && detail.pixelStats.nonBgRatio > 0.05 &&
                detail.pixelStats.lumStdDev > 5 && errs.length === 0 &&
                hygiene.tooltipHidden === true; // 无幽灵 tooltip 污染
            summary.viewports.push({ ...detail, hygiene, file, consoleErrors: errs, pass });
            await ctx.close().catch(() => {});
        }
        summary.checks = summary.viewports.map((v) => ({
            name: "视口 " + v.viewport[0] + "×" + v.viewport[1] + "（DPR " + v.dpr + "）：矩形图终态 + 表格隐藏 + 非空白画布" +
                "（非背景像素 " + v.pixelStats.nonBgRatio + "，亮度 σ=" + v.pixelStats.lumStdDev +
                "，tooltip 已隐藏=" + v.hygiene.tooltipHidden + "）",
            pass: v.pass,
            detail: JSON.stringify({ tw: [v.twHidden, v.twDisplay, v.twOpacity], tb: v.tbDisplay, px: v.pixelStats, hygiene: v.hygiene, errs: v.consoleErrors }),
        }));
    } catch (e) {
        summary.fatal = String((e && e.stack) || e);
        summary.checks.push({ name: "C 类探针异常", pass: false, detail: summary.fatal });
    } finally {
        summary.finishedAt = new Date().toISOString();
        fs.writeFileSync(path.join(OUT, "viewports.json"), JSON.stringify(summary, null, 2), "utf-8");
        await browser.close().catch(() => {});
    }
    console.log("== P2 C 类三视口 ==");
    for (const c of summary.checks) console.log((c.pass ? "  ✔ " : "  ✖ ") + c.name + (c.pass ? "" : " :: " + (c.detail || "")));
    console.log("out=" + OUT);
    return summary.checks.filter((c) => !c.pass).length;
}

run().then((f) => process.exit(f ? 1 : 0)).catch((e) => { console.error(e); process.exit(1); });
