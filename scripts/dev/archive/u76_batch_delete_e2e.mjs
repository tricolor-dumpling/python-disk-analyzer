/* u76 批量删除真链路：勾选 1 个「跳过」空会话 → 批量删除 → 确认弹窗 → 验证数量-1 */
import { chromium, arg, wait } from "./_harness.mjs";
import fs from "node:fs"; import path from "node:path";
const OUT = path.resolve(arg("out", "test-report/redesign")); fs.mkdirSync(OUT, { recursive: true });
const b = await chromium.launch({ headless: true });
const p = await (await b.newContext({ viewport: { width: 1920, height: 1080 } })).newPage();
const errs = []; p.on("pageerror", (e) => errs.push(String(e)));
await p.goto("http://127.0.0.1:5000/#/snapshots", { waitUntil: "domcontentloaded" }); await wait(2500);
if (await p.locator("#btn-onboarding-close").count()) await p.click("#btn-onboarding-close").catch(() => {});
await wait(500);
const before = await p.locator("#snapshots-list-count").innerText();
console.log("before:", before);
// 找一个 0 盘的空会话勾选
const emptyItem = p.locator(".session-item", { hasText: "0 个盘" }).first();
await emptyItem.locator(".act-sel-session").check(); await wait(400);
await p.click("#snap-btn-batch-del"); await wait(600);
await p.screenshot({ path: path.join(OUT, "v6-batch-confirm.png") });
const confirmVisible = await p.locator("#confirm-modal:not(.hidden)").count();
console.log("confirm modal:", confirmVisible);
await p.click("#btn-confirm-ok"); await wait(2000);
const after = await p.locator("#snapshots-list-count").innerText();
console.log("after:", after);
await p.screenshot({ path: path.join(OUT, "v6-batch-done.png") });
const n = (s) => Number((s.match(/共 (\d+)/) || [])[1] || -1);
console.log(n(after) === n(before) - 1 ? "PASS 批量删除生效" : "FAIL 数量未减", "| pageerrors:", errs.length, errs.slice(0, 2));
await b.close();
