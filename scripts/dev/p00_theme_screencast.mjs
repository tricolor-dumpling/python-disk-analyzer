/* ============================================================
   P0-3 · p00_theme_screencast.mjs —— B 类 CDP 逐帧像素记录器（正式化）
   - 用途：主题扩散动画的 CDP Page.startScreencast 逐帧像素捕获
     （10–20ms/帧），输出帧序列 JPEG + 亮度/暗区面积曲线 JSON。
   - 覆盖问题 10（P7）：主题扩散圆心与「底边触底瞬间铺满」判据的前置基建。
     本 P0 只产出帧序列与量化曲线，视觉结论交 Luna。
   - 触发：点击顶栏 #btn-theme（switchTheme(undefined, ev) 携带真实
     clientX/clientY → ViewTransition 扩散；若环境不支持 VT 则直切，
     面积曲线呈阶跃即客观记录该环境行为）。
   - 量化（Node 端对每张 JPEG 用同浏览器离线页解码测量）：
     · brightness.json  每帧整页灰度均值归一化 [0,1]
     · area.json        每帧「暗区(灰度<128)像素占比」曲线
   - 输出：
     · screencast-frames/frame-<seq>-<ts>ms.jpg  逐帧 JPEG
     · timeline.json    每帧 seq/ts/文件相对路径
     · meta.json        运行元信息 + console 错误
   - 参数：--base / --out / --duration（默认 1800ms）/ --quality（默认 60）
   - 纪律：finally { browser.close() }；headless 默认 true。
   ============================================================ */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, launch, arg, wait, screencast } from "./_harness.mjs";

const BASE = arg("base", "http://127.0.0.1:5000/");
const OUT = path.resolve(arg("out", path.join(os.tmpdir(), "p00_theme_screencast_" + Date.now())));
const DURATION = parseInt(arg("duration", "1800"), 10);
const QUALITY = parseInt(arg("quality", "60"), 10);

/* 对一批 JPEG（绝对路径）在给定 page 里解码并测量亮度/暗区占比 */
async function measure(page, framePaths) {
    const result = [];
    for (const f of framePaths) {
        const b64 = fs.readFileSync(f).toString("base64");
        const m = await page.evaluate(async (dataUrl) => {
            const img = new Image();
            const c = document.createElement("canvas");
            c.width = 1366; c.height = 768;
            await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataUrl; });
            const g = c.getContext("2d");
            g.drawImage(img, 0, 0, c.width, c.height);
            const d = g.getImageData(0, 0, c.width, c.height).data;
            let dark = 0, sum = 0;
            const n = c.width * c.height;
            for (let i = 0; i < d.length; i += 4) {
                const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
                sum += l;
                if (l < 128) dark++;
            }
            return { brightness: sum / n / 255, darkFrac: dark / n };
        }, "data:image/jpeg;base64," + b64);
        result.push(m);
    }
    return result;
}

(async () => {
    console.log("== p00_theme_screencast ==");
    console.log("base=" + BASE + " out=" + OUT + " duration=" + DURATION + " quality=" + QUALITY);
    const browser = await launch();
    try {
        const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
        const page = await ctx.newPage();
        const errs = [];
        page.on("console", (m) => { if (m.type() === "error") { const loc = m.location ? m.location() : null; if (loc && /favicon\.ico/i.test(loc.url)) return; errs.push(m.text()); } });
        page.on("pageerror", (e) => errs.push(e.message));
        await page.addInitScript(() => { try { localStorage.setItem("pds_onboarding_dismissed_v1", "1"); } catch (e) {}
                try { sessionStorage.setItem("pds_auto_started_v1", "1"); } catch (e) {} });
        await page.goto(BASE, { waitUntil: "load", timeout: 20000 }).catch((e) => { console.log("goto 失败: " + e.message); process.exit(2); });
        await page.waitForTimeout(800);

        const startTheme = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
        console.log("startTheme=" + startTheme + "，点击 #btn-theme 触发切换");
        /* 移除可能的 toast 覆盖层（否则拦截点击），并确认按钮可点 */
        await page.evaluate(() => { const t = document.getElementById("toast-container"); if (t) t.remove(); });
        await page.waitForSelector("#btn-theme", { state: "visible", timeout: 10000 }).catch(() => {});
        /* screencast 先行启动（异步帧流），随即点击主题按钮 */
        let cap;
        const capPromise = screencast(page, { outDir: OUT, durationMs: DURATION, quality: QUALITY });
        await wait(50);
        await page.click("#btn-theme", { timeout: 3000 }).catch((e) => console.log("  #btn-theme 点击: " + e.message));
        cap = await capPromise;

        const endTheme = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
        console.log("endTheme=" + endTheme + "，已切换: " + (startTheme !== endTheme));

        /* 离线测量每帧亮度/暗区占比 */
        const measPage = await browser.newPage();
        const framePaths = cap.frames.map((f) => path.join(cap.framesDir, path.basename(f.file)));
        const meas = await measure(measPage, framePaths);
        await measPage.close().catch(() => {});
        const brightness = cap.frames.map((f, i) => ({ seq: f.seq, ts: f.ts, brightness: +meas[i].brightness.toFixed(5) }));
        const area = cap.frames.map((f, i) => ({ seq: f.seq, ts: f.ts, darkFrac: +meas[i].darkFrac.toFixed(5) }));
        fs.writeFileSync(path.join(OUT, "brightness.json"), JSON.stringify(brightness, null, 2), "utf-8");
        fs.writeFileSync(path.join(OUT, "area.json"), JSON.stringify(area, null, 2), "utf-8");
        fs.writeFileSync(path.join(OUT, "meta.json"), JSON.stringify({
            base: BASE, startTheme, endTheme, switched: startTheme !== endTheme,
            viewport: "1366x768", durationMs: DURATION, quality: QUALITY, node: process.version,
            consoleErrors: errs, startedAt: new Date().toISOString(), frames: cap.frames.length,
        }, null, 2), "utf-8");

        console.log("\ntimeline.json: " + cap.timelinePath);
        console.log("brightness.json: " + path.join(OUT, "brightness.json"));
        console.log("area.json: " + path.join(OUT, "area.json"));
        console.log("meta.json 已写入: " + path.join(OUT, "meta.json"));
        console.log("screencast 帧数: " + cap.frames.length);
        console.log("console/pageerror: " + errs.length);
    } finally {
        await browser.close().catch(() => {});
    }
})();