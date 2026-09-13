/* R1 九项修复专项探针：对比页基准下拉 / toast 形态 / 主题扩散原点 */
import { launch, shot, wait, arg } from "./_harness.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../ui-review/shots");
const BASE = arg("base", "http://127.0.0.1:5000");

const browser = await launch();
try {
    const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(BASE + "/?r=" + Date.now(), { waitUntil: "domcontentloaded" });
    await page.evaluate(() => {
        try {
            localStorage.setItem("pds_theme_v1", "light");
            localStorage.setItem("pds_onboarding_dismissed_v1", "1");
            sessionStorage.setItem("pds_auto_started_v1", "1"); // 探针期不触发自动全扫
        } catch (e) {}
    });
    await page.goto(BASE + "/?r=" + Date.now() + "b#/compare", { waitUntil: "domcontentloaded" });
    await wait(2500);

    // ① 基准下拉：开面板 → 勾选第二项 → 校验选中数/提示/触发钮文案
    await page.locator("#baseline-trigger").click();
    await wait(400);
    await shot(page, path.join(OUT, "r1-fix-picker-open.png"));
    const opt2 = page.locator(".baseline-opt").nth(1);
    if (await opt2.count()) { await opt2.click(); await wait(1500); }
    const pickerState = await page.evaluate(() => ({
        selected: [...document.querySelector("#compare-baseline").selectedOptions].length,
        hint: document.querySelector("#compare-baseline-hint").textContent,
        trigger: document.querySelector("#baseline-trigger-text").textContent,
    }));
    console.log("picker:", JSON.stringify(pickerState));
    await shot(page, path.join(OUT, "r1-fix-picker-picked.png"));

    // ② toast 形态（右上）
    await page.evaluate(() => {
        const s = document.createElement("script");
        s.type = "module";
        s.textContent = 'import { toast } from "/static/js/app/components/toast.js"; toast("全量扫描已完成，已自动保存快照", "success"); setTimeout(() => toast("对比完成：变化 +5.91 GB", "info"), 300);';
        document.body.appendChild(s);
    });
    await wait(1200);
    await shot(page, path.join(OUT, "r1-fix-toast.png"));
    await page.evaluate(() => { document.querySelectorAll(".toast").forEach((t) => t.remove()); });
    await wait(300);

    // ③ 主题扩散原点（顶栏按钮，已知坐标点击）
    await page.evaluate(() => { window.__vt = null; const el = document.documentElement;
        const orig = el.animate.bind(el);
        el.animate = (kf, opts) => { if (opts && opts.pseudoElement) { window.__vt = kf; } return orig(kf, opts); };
    });
    const themeBtn = page.locator("#btn-theme");
    const bb = await themeBtn.boundingBox();
    const cx = Math.round(bb.x + bb.width / 2), cy = Math.round(bb.y + bb.height / 2);
    await page.mouse.click(cx, cy);
    await wait(300);
    const vt1 = await page.evaluate(() => window.__vt ? JSON.stringify(window.__vt) : null);
    console.log("topbar theme VT:", vt1, "| click at", cx, cy);
    await wait(600);
    // 设置弹窗主题选项
    await page.locator("#btn-theme").click(); await wait(800); // 切回 light
    await page.locator("#btn-settings").click(); await wait(800);
    await page.evaluate(() => { window.__vt = null; });
    const opt = page.locator("#setting-theme-dark");
    const ob = await opt.boundingBox();
    await page.mouse.click(Math.round(ob.x + 20), Math.round(ob.y + ob.height / 2));
    await wait(400);
    const vt2 = await page.evaluate(() => window.__vt ? JSON.stringify(window.__vt) : null);
    console.log("settings theme VT:", vt2, "| click at", Math.round(ob.x + 20), Math.round(ob.y + ob.height / 2));
    await shot(page, path.join(OUT, "r1-fix-settings-theme.png"));

    console.log("PAGE_ERRORS:", errors.length ? errors.join(" | ") : "none");
} finally {
    await browser.close();
}
