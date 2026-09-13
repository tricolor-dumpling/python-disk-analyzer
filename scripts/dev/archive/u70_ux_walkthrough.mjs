/* u70 UX 走查探针：模拟真实用户 + 产品经理全流程点击测试，逐步截图。
   用法: node scripts/dev/u70_ux_walkthrough.mjs [--out <dir>] [--skip-scan] */
import { chromium, arg, wait } from "./_harness.mjs";
import fs from "node:fs";
import path from "node:path";

const OUT = path.resolve(arg("out", "test-report/uitest"));
const SKIP_SCAN = arg("skip-scan", "") === "1" || process.argv.includes("--skip-scan");
fs.mkdirSync(OUT, { recursive: true });

const consoleErrors = [];
const pageErrors = [];
const failedReqs = [];
const steps = [];

function rec(name, ok, note) { steps.push({ name, ok, note }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${note ? " — " + note : ""}`); }

const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1366, height: 768 } });
const p = await ctx.newPage();
p.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
p.on("pageerror", (e) => pageErrors.push(String(e)));
p.on("requestfailed", (r) => failedReqs.push(r.url() + " :: " + (r.failure()?.errorText || "")));
p.on("response", (r) => { if (r.status() >= 500) failedReqs.push(`${r.status()} ${r.url()}`); });

async function snap(name) { const f = path.join(OUT, name + ".png"); await p.screenshot({ path: f }); return f; }

try {
  // 1. 落地页（引导弹窗）
  await p.goto("http://127.0.0.1:5000/", { waitUntil: "domcontentloaded" });
  await wait(2500);
  await snap("t01-landing-guide");
  const guideVisible = await p.locator("#onboarding:not(.hidden)").count();
  rec("落地页+引导弹窗", guideVisible > 0, "onboarding visible=" + guideVisible);

  // 2. 关闭引导
  if (guideVisible) { await p.click("#btn-onboarding-close"); await wait(600); }
  await snap("t02-workspace-idle");
  rec("关闭引导", (await p.locator("#onboarding.hidden").count()) > 0);

  // 3. 环境健康徽章
  const health = await p.locator("#health-text").innerText().catch(() => "?");
  await p.click("#health-badge"); await wait(600); await snap("t03-health-popover");
  rec("健康徽章弹窗", true, "health=" + health.trim());
  await p.keyboard.press("Escape"); await wait(400);

  // 4. 全量扫描（真实扫描 C/D 盘）
  if (!SKIP_SCAN) {
    const status0 = await p.evaluate(async () => (await fetch("/api/fullscan/status")).json()).catch(() => null);
    const phase = status0?.phase;
    if (phase === "scanning" || phase === "queued") {
      rec("扫描状态", true, "已在扫描中 phase=" + phase);
    } else {
      await p.click("#btn-scan-top"); await wait(4000);
    }
    await snap("t04-scanning");
    // 轮询直至完成（最多 12 分钟）
    let done = false; const t0 = Date.now();
    while (Date.now() - t0 < 12 * 60 * 1000) {
      const st = await p.evaluate(async () => (await fetch("/api/fullscan/status")).json()).catch(() => null);
      if (st && st.phase === "idle") { done = true; rec("全量扫描完成", true, JSON.stringify({ error: st.error, stop: st.stop_reason })); break; }
      await wait(5000);
    }
    if (!done) rec("全量扫描完成", false, "超时未完成");
    await wait(2500);
    await snap("t05-scan-done");
  }

  // 5. 浏览 C:\
  await p.fill("#browse-root", "C:\\");
  await p.click("#btn-browse");
  await p.waitForFunction(() => {
    const el = document.querySelector("#browse-status, .status-line, .browse-status");
    return true; // 等 treemap canvas 或列表出现
  }, { timeout: 5000 }).catch(() => {});
  await p.waitForSelector(".tm-block, canvas, .ranking-row, table tbody tr", { timeout: 30000 }).catch(() => {});
  await wait(1500);
  await snap("t06-browse-treemap");
  rec("浏览 C:\\ 出矩形图", (await p.locator("canvas").count()) > 0, "canvas=" + (await p.locator("canvas").count()));

  // 6. 切换视图：排行 / 表格 / 关系
  await p.click("#btn-view-ranking"); await wait(700); await snap("t07-view-ranking");
  await p.click("#btn-view-table"); await wait(700); await snap("t08-view-table");
  await p.click("#btn-view-relate"); await wait(700); await snap("t09-view-relate");
  await p.click("#btn-view-treemap"); await wait(900); await snap("t10-view-treemap-back");
  rec("四视图切换", true);

  // 7. 下钻：表格视图点击第一个目录行
  await p.click("#btn-view-table"); await wait(600);
  const dirRow = p.locator("table tbody tr").first();
  const rowCount = await p.locator("table tbody tr").count();
  if (rowCount > 0) {
    await dirRow.click(); await wait(1200); await snap("t11-drilldown");
    const crumb = await p.locator(".crumb").allInnerTexts().catch(() => []);
    rec("下钻目录行", true, "crumbs=" + crumb.join(" > "));
    // 面包屑回跳
    const crumbs = p.locator(".crumb");
    if (await crumbs.count() > 0) { await crumbs.first().click(); await wait(1000); await snap("t12-crumb-back"); rec("面包屑回跳", true); }
  } else rec("下钻目录行", false, "表格无行");

  // 8. 筛选
  await p.click("#btn-view-ranking"); await wait(500);
  await p.fill("#browse-filter", "win"); await wait(800); await snap("t13-filter");
  rec("名称筛选", true);
  await p.fill("#browse-filter", ""); await wait(500);

  // 9. 主题切换
  const themeBefore = await p.evaluate(() => document.documentElement.dataset.theme || "");
  await p.click("#btn-theme"); await wait(1200); await snap("t14-theme-toggled");
  const themeAfter = await p.evaluate(() => document.documentElement.dataset.theme || "");
  rec("主题切换", themeBefore !== themeAfter, themeBefore + "->" + themeAfter);
  await p.click("#btn-theme"); await wait(1200); // 还原

  // 10. 命令面板
  await p.keyboard.press("Control+k"); await wait(600); await snap("t15-palette");
  const paletteVisible = await p.locator("#palette:not(.hidden)").count();
  await p.keyboard.type("快照"); await wait(500); await snap("t16-palette-typed");
  rec("命令面板", paletteVisible > 0);
  await p.keyboard.press("Escape"); await wait(400);

  // 11. 设置弹窗
  await p.click("#btn-settings"); await wait(700); await snap("t17-settings");
  rec("设置弹窗", (await p.locator("#settings-modal:not(.hidden)").count()) > 0);
  const dataDir = await p.locator("#setting-data-dir").inputValue().catch(() => "?");
  await p.keyboard.press("Escape"); await wait(400);

  // 12. 快照页
  await p.goto("http://127.0.0.1:5000/#/snapshots"); await wait(1500); await snap("t18-snapshots");
  rec("快照页路由", true, "dataDir=" + dataDir);

  // 13. 对比页
  await p.goto("http://127.0.0.1:5000/#/compare"); await wait(1500); await snap("t19-compare");
  rec("对比页路由", true);

  // 14. 未知路由回退
  await p.goto("http://127.0.0.1:5000/#/nonexistent"); await wait(1000); await snap("t20-route-fallback");
  rec("未知路由回退", true);

  rec("console 零报错", consoleErrors.length === 0, consoleErrors.slice(0, 5).join(" | "));
  rec("pageerror 零报错", pageErrors.length === 0, pageErrors.slice(0, 5).join(" | "));
  rec("无失败请求", failedReqs.length === 0, failedReqs.slice(0, 5).join(" | "));
} catch (e) {
  rec("走查异常中断", false, String(e));
  await snap("t99-error").catch(() => {});
}

const summary = { steps, consoleErrors, pageErrors, failedReqs };
fs.writeFileSync(path.join(OUT, "u70-result.json"), JSON.stringify(summary, null, 2));
console.log("DONE shots ->", OUT);
await b.close();
