/* ============================================================
   R1 视觉预览截图脚本（一次性工具，非探针门禁）
   - 复用 scripts/dev/_harness.mjs 的 Playwright 外部加载方式；
   - 输出：同目录 shot-{page}-{theme}-{w}x{h}.png
   - 运行：node shoot.mjs
   ============================================================ */
import { launch, shot, wait } from "../../scripts/dev/_harness.mjs";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const URL = pathToFileURL(path.join(HERE, "mockup.html")).href;

const SHOTS = [
    // 主视口 1440×900：三页 × 亮暗
    { page: "workspace", theme: "light", w: 1440, h: 900 },
    { page: "workspace", theme: "dark",  w: 1440, h: 900 },
    { page: "compare",   theme: "light", w: 1440, h: 900 },
    { page: "compare",   theme: "dark",  w: 1440, h: 900 },
    { page: "snapshots", theme: "light", w: 1440, h: 900 },
    { page: "snapshots", theme: "dark",  w: 1440, h: 900 },
    // 补充视口：1920×1080 / 1366×768（工作台与对比页各一）
    { page: "workspace", theme: "light", w: 1920, h: 1080 },
    { page: "compare",   theme: "light", w: 1366, h: 768 },
];

const browser = await launch();
try {
    for (const s of SHOTS) {
        const ctx = await browser.newContext({ viewport: { width: s.w, height: s.h } });
        const page = await ctx.newPage();
        await page.goto(`${URL}?page=${s.page}&theme=${s.theme}&shot=1`);
        await wait(400); // 等页面入场动画与字体稳定
        const file = path.join(HERE, `shot-${s.page}-${s.theme}-${s.w}x${s.h}.png`);
        await shot(page, file);
        console.log(`[ok] ${path.basename(file)}`);
        await ctx.close();
    }
} finally {
    await browser.close();
}
console.log("done");
