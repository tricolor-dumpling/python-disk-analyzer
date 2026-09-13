/* u74 改造取证：1920 宽度截取 工作台存储概览 / 对比页 / 快照页 */
import { chromium, arg, wait } from "./_harness.mjs";
import fs from "node:fs"; import path from "node:path";
const OUT = path.resolve(arg("out", "test-report/redesign")); fs.mkdirSync(OUT, { recursive: true });
const b = await chromium.launch({ headless: true });
const p = await (await b.newContext({ viewport: { width: 1920, height: 1080 } })).newPage();
await p.goto("http://127.0.0.1:5000/", { waitUntil: "domcontentloaded" }); await wait(2200);
if (await p.locator("#btn-onboarding-close").count()) await p.click("#btn-onboarding-close").catch(() => {});
await wait(400);
await p.fill("#browse-root", "C:\\"); await p.click("#btn-browse");
await p.waitForSelector("canvas", { timeout: 30000 }).catch(() => {}); await wait(1500);
await p.screenshot({ path: path.join(OUT, "w01-workspace-1920.png") });
await p.goto("http://127.0.0.1:5000/#/compare"); await wait(3000);
// 等自动对比完成
const t0 = Date.now();
while (Date.now() - t0 < 150000) {
  await wait(3000);
  const body = await p.evaluate(() => document.body.innerText);
  if (!body.includes("正在对比")) break;
}
await wait(800);
await p.screenshot({ path: path.join(OUT, "w02-compare-full-1920.png"), fullPage: true });
await p.goto("http://127.0.0.1:5000/#/snapshots"); await wait(2000);
await p.screenshot({ path: path.join(OUT, "w03-snapshots-full-1920.png"), fullPage: true });
console.log("DONE");
await b.close();
