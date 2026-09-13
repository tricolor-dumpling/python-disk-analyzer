/* R1 重构用：对运行中的应用截三页 × 亮暗 1440x900，输出到 ui-review/shots/ */
import { launch, shot, wait, arg } from "./_harness.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "../../ui-review/shots");
const BASE = arg("base", "http://127.0.0.1:5000");
const TAG = arg("tag", "cur");

const SHOTS = [
    { hash: "#/", theme: "light", name: "workspace" },
    { hash: "#/", theme: "dark", name: "workspace" },
    { hash: "#/compare", theme: "light", name: "compare" },
    { hash: "#/compare", theme: "dark", name: "compare" },
    { hash: "#/snapshots", theme: "light", name: "snapshots" },
    { hash: "#/snapshots", theme: "dark", name: "snapshots" },
];

const browser = await launch();
try {
    const ctx = await browser.newContext({ viewport: { width: +arg("w", "1440"), height: +arg("h", "900") }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    const errors = [];
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    page.on("pageerror", (e) => errors.push(String(e)));
    for (const s of SHOTS) {
        await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
        await page.evaluate((t) => {
            try {
                localStorage.setItem("pds_theme_v1", t);
                localStorage.setItem("pds_onboarding_dismissed_v1", "1");
            } catch (e) {}
        }, s.theme);
        await page.goto(BASE + "/?r=" + Math.random().toString(36).slice(2) + s.hash, { waitUntil: "domcontentloaded" });
        await page.evaluate((t) => { document.documentElement.setAttribute("data-theme", t); }, s.theme);
        await wait(1400);
        await shot(page, path.join(OUT, `r1-${TAG}-${s.name}-${s.theme}.png`));
        const scroll = await page.evaluate(() => ({
            docW: document.documentElement.scrollWidth, winW: innerWidth,
            docH: document.documentElement.scrollHeight, winH: innerHeight,
        }));
        const ok = scroll.docW <= scroll.winW && scroll.docH <= scroll.winH;
        console.log("shot", s.name, s.theme, ok ? "zero-scroll OK" : "ZERO-SCROLL OVERFLOW " + JSON.stringify(scroll));
    }
    if (errors.length) { console.log("CONSOLE_ERRORS:"); errors.slice(0, 20).forEach((e) => console.log("  " + e)); }
    else console.log("CONSOLE_ERRORS: none");
} finally {
    await browser.close();
}
