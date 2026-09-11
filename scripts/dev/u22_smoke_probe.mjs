/* U2.2 冒烟 suite 探针（smoke.html，静态 8771）
   用法：node scripts/dev/u22_smoke_probe.mjs [suite=all|v2]
   输出：每 suite 的 x/y 通过数与失败明细；收集 console/pageerror。
   ⚠️ U2.5：v1/legacy 断言已退役——门禁仅剩 v2（suites 默认只跑 v2）。
   Playwright 依赖本机 profile（与项目零前端依赖纪律无关）。 */
import { chromium, launch } from "./_harness.mjs";
const BASE = "http://127.0.0.1:8771/tests/web/smoke.html";
const suites = ["v2"];

(async () => {
  const browser = await chromium.launch();
  let failed = false;
  for (const suite of suites) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const errs = [];
    page.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text()); });
    page.on("pageerror", (e) => errs.push("pageerror: " + e.message));
    const t0 = Date.now();
    await page.goto(BASE + "?suite=" + suite, { waitUntil: "load" });
    /* 结果写进标题 [suite=x][PASS n/m]
       P6 探针修复（两处，均为「假绿」风险）：
       ① `page.waitForFunction(fn, opts)` 的第二参是 **arg** 不是 options——
          原写法把 {timeout:30000} 当成函数入参传了进去，实际超时是默认 30s；
          而 smoke v2 套件在本机实测耗时 ≈31s（30.1–31.1s，见 P8 门禁记录），
          于是等待**必然超时**：探针随后读到的是「尚未跑完」的页面 ——
          标题无结论标记、#smoke-summary 为空，但 rows/fails 均为空 →
          退出码 0 = **假绿**。
       ② 现在显式判「是否跑完」：未跑完 → 打印 SUITE_NOT_FINISHED 并按失败计。 */
    const finished = await page.waitForFunction(
      () => /\[suite=[^\]]+\]\[(?:PASS|FAIL) \d+\/\d+\]/.test(document.title),
      null,
      { timeout: 120000 }
    ).then(() => true).catch(() => false);
    const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);
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
    console.log("[" + suite + "] elapsed=" + elapsedSec + "s rows=" + rows.length + " finished=" + finished);
    if (!finished) {
      console.log("[" + suite + "] SUITE_NOT_FINISHED：等待结论标记超时（断言未跑完，按失败计）");
      failed = true;
    }
    fails.forEach((f) => console.log("[" + suite + "] FAIL " + f.id + " " + f.name + " :: " + (f.detail || "")));
    if (errs.length) console.log("[" + suite + "] ERRORS:\n" + errs.join("\n"));
    if (fails.length || errs.length) failed = true;
    await page.close();
  }
  await browser.close();
  process.exit(failed ? 1 : 0);
})();
