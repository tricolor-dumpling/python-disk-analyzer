/* ============================================================
   P0-3 · p00_viewport_shots.mjs —— C 类多视口静态截图（正式化）
   - 用途：对首页/对比页/快照页在默认三视口各截 1 张，作为后续
     阶段（P3/P4/P6/P7）的布局对照基线。
   - 视口默认：1366×768 / 1440×900 / 1920×1080（--viewports 覆盖，
     格式 w x h，逗号分隔）。
   - 路由：工作台 #/ （首页）、对比 #/compare、快照 #/snapshots
     （若目标路由不存在则记录 skip）。
   - 输出：<out>/<视口>/<page>-<w>x<h>.png + meta.json
   - 参数：--base / --out / --viewports "1366x768,1440x900,1920x1080"
   - 纪律：finally { browser.close() }；headless 默认 true。
   ============================================================ */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, launch, arg, wait } from "./_harness.mjs";

const BASE = arg("base", "http://127.0.0.1:5000/");
const OUT = path.resolve(arg("out", path.join(os.tmpdir(), "p00_viewport_shots_" + Date.now())));
const VIEWPORTS = (arg("viewports", "1366x768,1440x900,1920x1080") || "1366x768,1440x900,1920x1080")
    .split(",").map((s) => { const [w, h] = s.split("x").map((x) => parseInt(x, 10)); return { width: w, height: h }; });

const ROUTES = [
    { key: "workspace", label: "工作台", path: "#/" },
    { key: "compare", label: "对比", path: "#/compare" },
    { key: "snapshots", label: "快照", path: "#/snapshots" },
];

(async () => {
    console.log("== p00_viewport_shots ==");
    console.log("base=" + BASE + " out=" + OUT + " viewports=" + VIEWPORTS.map((v) => v.width + "x" + v.height).join(","));
    const browser = await launch();
    const meta = { base: BASE, viewports: VIEWPORTS, shots: [], node: process.version, startedAt: new Date().toISOString(), consoleErrors: {} };
    try {
        for (const vp of VIEWPORTS) {
            const vdir = path.join(OUT, vp.width + "x" + vp.height);
            fs.mkdirSync(vdir, { recursive: true });
            const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
            const page = await ctx.newPage();
            const errs = [];
            page.on("console", (m) => { if (m.type() === "error") { const loc = m.location ? m.location() : null; if (loc && /favicon\.ico/i.test(loc.url)) return; errs.push(m.text()); } });
            page.on("pageerror", (e) => errs.push(e.message));
            await page.addInitScript(() => { try { localStorage.setItem("pds_onboarding_dismissed_v1", "1"); } catch (e) {}
                    try { sessionStorage.setItem("pds_auto_started_v1", "1"); } catch (e) {} });
            await page.goto(BASE, { waitUntil: "load", timeout: 20000 }).catch((e) => { console.log("goto 失败: " + e.message); });
            for (const r of ROUTES) {
                const fp = path.join(vdir, r.key + "-" + vp.width + "x" + vp.height + ".png");
                await page.evaluate((p) => { location.hash = p; }, r.path).catch(() => {});
                await wait(1200); // 路由渲染 + 动画收敛
                await page.screenshot({ path: fp, fullPage: true }).catch((e) => { console.log("截图失败 " + r.key + ": " + e.message); });
                meta.shots.push({ page: r.key, label: r.label, viewport: vp.width + "x" + vp.height, file: fp });
                console.log("  " + r.label + " " + vp.width + "x" + vp.height + " → " + fp);
            }
            meta.consoleErrors[vp.width + "x" + vp.height] = errs;
            await ctx.close().catch(() => {});
        }
        fs.writeFileSync(path.join(OUT, "meta.json"), JSON.stringify(meta, null, 2), "utf-8");
        console.log("\nmeta.json 已写入: " + path.join(OUT, "meta.json"));
        console.log("截图总数: " + meta.shots.length);
    } finally {
        await browser.close().catch(() => {});
    }
})();