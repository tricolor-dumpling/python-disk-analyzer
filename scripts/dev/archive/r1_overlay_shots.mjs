/* R1 重构用：浮层族截图（设置弹窗 / 命令面板 / 健康 popover / 使用指引） */
import { launch, shot, wait, arg } from "./_harness.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "../../ui-review/shots");
const BASE = arg("base", "http://127.0.0.1:5000");
const THEME = arg("theme", "dark");

const browser = await launch();
try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
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

    await page.locator("#btn-settings").click(); await wait(500);
    await shot(page, path.join(OUT, `r1-ovl-settings-${THEME}.png`));
    await page.keyboard.press("Escape"); await wait(300);

    await page.locator("#btn-palette").click(); await wait(400);
    await page.locator("#palette-input").fill("快照"); await wait(400);
    await shot(page, path.join(OUT, `r1-ovl-palette-${THEME}.png`));
    await page.keyboard.press("Escape"); await wait(300);

    await page.locator("#health-badge").click(); await wait(500);
    await shot(page, path.join(OUT, `r1-ovl-health-${THEME}.png`));
    await page.keyboard.press("Escape"); await wait(300);

    await page.locator("#btn-guide").click(); await wait(600);
    await shot(page, path.join(OUT, `r1-ovl-onboarding-${THEME}.png`));
    console.log("done");
} finally {
    await browser.close();
}
