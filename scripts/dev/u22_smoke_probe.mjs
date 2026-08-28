/* U2.2 冒烟双 suite 探针（smoke.html，静态 8771）
   用法：node scripts/dev/u22_smoke_probe.mjs [suite=all|v2|legacy]
   输出：每 suite 的 x/y 通过数与失败明细；收集 console/pageerror。
   Playwright 依赖本机 profile（与项目零前端依赖纪律无关）。 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require("C:/Users/26024/.dsh/profiles/web/node_modules/playwright");

const BASE = "http://127.0.0.1:8771/tests/web/smoke.html";
const suites = process.argv[2] === undefined || process.argv[2] === "all" ? ["v2", "legacy"] : [process.argv[2]];

(async () => {
  const browser = await chromium.launch();
  let failed = false;
  for (const suite of suites) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const errs = [];
    page.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text()); });
    page.on("pageerror", (e) => errs.push("pageerror: " + e.message));
    await page.goto(BASE + "?suite=" + suite, { waitUntil: "load" });
    // 结果写进标题 [suite=x][PASS n/m]
    await page.waitForFunction(
      () => /\[suite=[^\]]+\]\[(?:PASS|FAIL) \d+\/\d+\]/.test(document.title),
      { timeout: 30000 }
    ).catch(() => {});
    const title = await page.title();
    const summary = await page.textContent("#smoke-summary").catch(() => "(no summary)");
    // 失败行明细
    const rows = await page.$$eval("#smoke-table tr", (trs) =>
      trs.slice(1).map((tr) => {
        const tds = tr.querySelectorAll("td");
        return { id: tds[0] && tds[0].textContent, name: tds[1] && tds[1].textContent, result: tds[2] && tds[2].textContent, detail: tds[3] && tds[3].textContent };
      })
    );
    const fails = rows.filter((r) => r.result === "FAIL");
    console.log("[" + suite + "] title=" + title);
    console.log("[" + suite + "] summary=" + summary.replace(/\s+/g, " ").trim());
    fails.forEach((f) => console.log("[" + suite + "] FAIL " + f.id + " " + f.name + " :: " + (f.detail || "")));
    if (errs.length) console.log("[" + suite + "] ERRORS:\n" + errs.join("\n"));
    if (fails.length || errs.length) failed = true;
    await page.close();
  }
  await browser.close();
  process.exit(failed ? 1 : 0);
})();
