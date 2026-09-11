/* R1 重构用：驱动真实数据状态截图（浏览 D:\ 四视图 + 对比页真实对比）
   输出 ui-review/shots/r1-live-*.png */
import { launch, shot, wait, arg } from "./_harness.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "../../ui-review/shots");
const BASE = arg("base", "http://127.0.0.1:5000");
const THEME = arg("theme", "light");

const browser = await launch();
try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    const errors = [];
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    page.on("pageerror", (e) => errors.push(String(e)));

    await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
    await page.evaluate((t) => {
        try {
            localStorage.setItem("pds_theme_v1", t);
            localStorage.setItem("pds_onboarding_dismissed_v1", "1");
        } catch (e) {}
    }, THEME);
    await page.goto(BASE + "/?r=" + Date.now() + "#/", { waitUntil: "domcontentloaded" });
    await page.evaluate((t) => { document.documentElement.setAttribute("data-theme", t); }, THEME);
    await wait(1500);

    // 浏览 D:\（路径输入 + 点击「浏览」）
    const pathInput = page.locator(".path-row input").first();
    await pathInput.fill("D:\\");
    await page.locator("#btn-browse").click();
    await wait(3500);
    await shot(page, path.join(OUT, `r1-live-treemap-${THEME}.png`));

    // 排行 / 表格 / 关系 三视图
    for (const v of ["ranking", "table", "relate"]) {
        const btn = page.locator(`#btn-view-${v}`);
        if (await btn.count()) {
            await btn.click();
            await wait(900);
            await shot(page, path.join(OUT, `r1-live-${v}-${THEME}.png`));
        }
    }

    // 对比页：选最近两份基准 → 开始对比
    await page.goto(BASE + "/?r=" + Date.now() + "#/compare", { waitUntil: "domcontentloaded" });
    await page.evaluate((t) => { document.documentElement.setAttribute("data-theme", t); }, THEME);
    await wait(1500);
    const sel = page.locator("#compare-baseline");
    if (await sel.count()) {
        await sel.evaluate((el) => {
            const opts = [...el.options];
            opts.slice(0, 2).forEach((o) => { o.selected = true; });
            el.dispatchEvent(new Event("change", { bubbles: true }));
        });
        await wait(600);
        await page.locator("#btn-compare").click();
        await wait(6000);
    }
    await shot(page, path.join(OUT, `r1-live-compare-${THEME}.png`));

    if (errors.length) { console.log("CONSOLE_ERRORS:"); errors.slice(0, 20).forEach((e) => console.log("  " + e)); }
    else console.log("CONSOLE_ERRORS: none");
} finally {
    await browser.close();
}
