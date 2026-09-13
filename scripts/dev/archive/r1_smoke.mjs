/* R1 重构用：跑 tests/web/smoke.html 冒烟门禁（file://），输出断言汇总 */
import { launch, wait } from "./_harness.mjs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const URL = "http://127.0.0.1:8765/tests/web/smoke.html";

const browser = await launch();
try {
    const page = await (await browser.newContext()).newPage();
    const errors = [];
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(URL, { waitUntil: "domcontentloaded" });
    // 等待冒烟跑完：标题写入 [suite=v2][PASS x/y] 结论（smoke.html L334-335）
    for (let i = 0; i < 150; i++) {
        await wait(1000);
        const t = await page.title();
        if (/\[(PASS|FAIL) \d+\/\d+\]/.test(t)) break;
    }
    console.log("title:", await page.title());
    const res = await page.evaluate(() => {
        const s = window.__smoke || { results: [] };
        return s.results.map((r) => `${r.pass === true ? "PASS" : r.pass === false ? "FAIL" : "PEND"} ${r.id} ${r.name}${r.pass === false ? " :: " + (r.detail || "") : ""}`);
    });
    const pass = res.filter((r) => r.startsWith("PASS")).length;
    console.log(`smoke: ${pass}/${res.length} 通过`);
    res.filter((r) => !r.startsWith("PASS")).forEach((r) => console.log("  " + r));
    if (errors.length) { console.log("PAGE_ERRORS:"); errors.slice(0, 8).forEach((e) => console.log("  " + e)); }
} finally {
    await browser.close();
}
