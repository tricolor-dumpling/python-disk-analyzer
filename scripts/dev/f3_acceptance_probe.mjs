/* 阶段F（R6）· F-3 标准验收链路浏览器段探针（真机走索引）
   运行：node scripts/dev/f3_acceptance_probe.mjs [--base http://127.0.0.1:5000/] [--out <目录>]
   输出：--out 目录 result.json + 关键帧截图（workspace/views/relate/theme/settings/narrow）。
   判读：截图交 gpt-5.6-luna（workflow agent provider=opentoken model=gpt-5.6-luna）。 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require("C:/Users/26024/.dsh/profiles/web/node_modules/playwright");
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function arg(name, dflt) {
    const i = process.argv.indexOf("--" + name);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const BASE = arg("base", "http://127.0.0.1:5000/");
const OUT = path.resolve(arg("out", path.join(os.tmpdir(), "stage_f_f3")));
fs.mkdirSync(OUT, { recursive: true });
const RESULT = { meta: { base: BASE, out: OUT, node: process.version, startedAt: new Date().toISOString() }, checks: [], consoleErrors: [], shots: [] };

(async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
    const errs = [];
    page.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text()); });
    page.on("pageerror", (e) => errs.push("pageerror: " + e.message));
    // 预置：引导弹窗关闭 + 隔离自动扫描（不干扰验收驱动；真机扫描序列单独 API 验证）
    await page.addInitScript(() => {
        try {
            localStorage.setItem("pds_onboarding_dismissed_v1", "1");
            sessionStorage.setItem("pds_auto_started_v1", "1");
        } catch (e) {}
    });
    await page.goto(BASE, { waitUntil: "load", timeout: 20000 }).catch((e) => { RESULT.gotoError = String(e); });
    await page.waitForFunction(() => document.querySelector("#btn-theme") !== null, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2000);

    // ④a 工作台（矩形图默认视图）
    const ws = path.join(OUT, "f3-workspace.png");
    await page.screenshot({ path: ws });
    RESULT.shots.push(ws);
    RESULT.checks.push({ name: "工作台矩形图默认视图截图", pass: true, detail: ws });

    // ④b 视图切换：排行→表格→矩形图→关系目录
    const viewIds = ["btn-view-ranking", "btn-view-table", "btn-view-treemap", "btn-view-relate"];
    for (const id of viewIds) {
        const el = await page.$("#" + id);
        if (!el) { RESULT.checks.push({ name: "视图按钮 " + id, pass: false, detail: "不存在" }); continue; }
        await el.click();
        await page.waitForTimeout(700); // 交叉淡化 120ms + 稳定
        const shot = path.join(OUT, "f3-view-" + id.replace("btn-view-", "") + ".png");
        await page.screenshot({ path: shot });
        RESULT.shots.push(shot);
        RESULT.checks.push({ name: "视图切换 " + id, pass: true, detail: shot });
    }

    // ④c 关系目录展开（懒展开一次 browse）
    await page.click("#btn-view-relate").catch(() => {});
    await page.waitForTimeout(500);
    const relateRow = await page.$(".relate-tree .relate-row");
    if (relateRow) {
        await relateRow.click();
        await page.waitForTimeout(900);
        const shot = path.join(OUT, "f3-relate-expanded.png");
        await page.screenshot({ path: shot });
        RESULT.shots.push(shot);
        RESULT.checks.push({ name: "关系目录懒展开", pass: true, detail: shot });
    } else {
        RESULT.checks.push({ name: "关系目录懒展开", pass: false, detail: "relate-row 不存在" });
    }

    // ⑦a 主题切换（顶栏按钮，VT 扩散）
    await page.click("#btn-theme");
    await page.waitForTimeout(800);
    const themeShot = path.join(OUT, "f3-theme-after.png");
    await page.screenshot({ path: themeShot });
    RESULT.shots.push(themeShot);
    const theme = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
    RESULT.checks.push({ name: "主题切换（顶栏）", pass: theme === "dark" || theme === "light", detail: "data-theme=" + theme + " " + themeShot });

    // ⑦b 设置弹窗（含主题三档/自动保存两列）
    await page.click("#btn-settings").catch(() => {});
    await page.waitForTimeout(500);
    const settingsShot = path.join(OUT, "f3-settings.png");
    await page.screenshot({ path: settingsShot });
    RESULT.shots.push(settingsShot);
    const settingIds = await page.$$eval("[id^=setting-]", (els) => els.map((e) => e.id));
    RESULT.checks.push({ name: "设置弹窗打开 + setting-* id 断言面", pass: settingIds.length > 3, detail: JSON.stringify(settingIds) + " " + settingsShot });
    await page.keyboard.press("Escape");

    // ⑦c 引导按钮 + 窄屏布局（357×651）
    await page.setViewportSize({ width: 357, height: 651 });
    await page.waitForTimeout(600);
    const narrowShot = path.join(OUT, "f3-narrow-357x651.png");
    await page.screenshot({ path: narrowShot });
    RESULT.shots.push(narrowShot);
    RESULT.checks.push({ name: "窄屏 357×651 布局截图", pass: true, detail: narrowShot });

    RESULT.consoleErrors = errs;
    RESULT.checks.push({ name: "console 无未处理错误", pass: errs.length === 0, detail: JSON.stringify(errs) });
    fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(RESULT, null, 2));
    console.log("result=" + path.join(OUT, "result.json"));
    const fails = RESULT.checks.filter((c) => !c.pass);
    console.log("checks=" + RESULT.checks.length + " fail=" + fails.length);
    fails.forEach((f) => console.log("FAIL " + f.name + " :: " + f.detail));
    await browser.close();
    process.exit(fails.length ? 1 : 0);
})();
