/* u72 修复点专项回归：
   R1 表格目录行整行点击下钻（修复后）
   R2 扫描完成态：skipped 时 save-prompt 隐藏、autosave-result 单条、btn-save 可用、导出按钮可用
   R3 子页面按 R 不产生 pageerror
   R4 对比页空 root 趋势卡不发 400（监听 /api/series 400）
   R5 完成一次真实对比（基线 vs 当前），确认正常出结果不误报超时
   R6 取消对比后无僵尸轮询（取消后 6s 内无新 /api/compare 请求）
*/
import { chromium, arg, wait } from "./_harness.mjs";
import fs from "node:fs";
import path from "node:path";
const OUT = path.resolve(arg("out", "test-report/uitest"));
fs.mkdirSync(OUT, { recursive: true });
const results = [];
const rec = (n, ok, note) => { results.push({ n, ok, note }); console.log(`${ok ? "PASS" : "FAIL"} ${n}${note ? " — " + note : ""}`); };

const b = await chromium.launch({ headless: true });
const p = await (await b.newContext({ viewport: { width: 1366, height: 768 } })).newPage();
const pageErrors = []; p.on("pageerror", (e) => pageErrors.push(String(e)));
const series400 = []; p.on("response", (r) => { if (r.url().includes("/api/series") && r.status() >= 400) series400.push(r.status()); });

await p.goto("http://127.0.0.1:5000/", { waitUntil: "domcontentloaded" });
await wait(2200);
if (await p.locator("#btn-onboarding-close").count()) await p.click("#btn-onboarding-close").catch(() => {});
await wait(400);

// R1: 表格目录行整行点击下钻
await p.fill("#browse-root", "C:\\"); await p.click("#btn-browse");
await p.waitForSelector("canvas", { timeout: 30000 }).catch(() => {}); await wait(1200);
await p.click("#btn-view-table"); await wait(600);
await p.waitForSelector("table tbody tr", { timeout: 20000 }).catch(() => {});
console.log("debug rows=", await p.locator("table tbody tr").count(),
  " canvases=", await p.locator("canvas").count(),
  " bodyTail=", (await p.evaluate(() => document.body.innerText.slice(0, 300))).replace(/\n/g, "|"));
await p.screenshot({ path: path.join(OUT, "u72-debug-table.png") });
await p.locator("table tbody tr td").nth(1).click(); await wait(1500);
const pathTxt = await p.evaluate(() => (document.querySelector("#breadcrumb")?.innerText || "").replace(/\s+/g, ""));
rec("R1 目录行整行点击下钻", pathTxt.includes("C:\\Users"), "breadcrumb=" + pathTxt);
await p.screenshot({ path: path.join(OUT, "u72-r1-drilldown.png") });
// 文件行不响应（点 pagefile.sys 行名，路径不应变）
await p.locator(".crumb[data-path]").first().click().catch(() => {}); await wait(800); // 回 C:\
const fileCell = p.locator("table tbody tr td", { hasText: "pagefile.sys" }).first();
if (await fileCell.count()) { await fileCell.click(); await wait(800); }
const after = await p.evaluate(() => (document.querySelector("#breadcrumb")?.innerText || "").replace(/\s+/g, ""));
rec("R1b 文件行不响应点击", !after.includes("pagefile"), "after=" + after);

// R2: 完成态通知（当前后端 autosave_outcome=skipped: already_saved_today）
const noticeVisible = await p.locator("#autosave-result:not(.hidden)").count();
const promptVisible = await p.locator("#save-prompt:not(.hidden)").count();
const saveDisabled = await p.locator("#btn-save").isDisabled().catch(() => null);
const exportCsvDisabled = await p.locator("#btn-export-csv").isDisabled().catch(() => "no-el");
const noticeText = (await p.locator("#autosave-result").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 80);
rec("R2a skipped 态 save-prompt 已隐藏", promptVisible === 0, `notice=${noticeVisible} prompt=${promptVisible}`);
rec("R2b 保存快照按钮可用", saveDisabled === false, "disabled=" + saveDisabled);
rec("R2c 导出 CSV 可用（不耦合 save_ready）", exportCsvDisabled === false, "disabled=" + exportCsvDisabled);
rec("R2d 通知文案单一入口", !noticeText.includes("仍要保存"), noticeText);
await p.screenshot({ path: path.join(OUT, "u72-r2-scan-card.png") });

// R3: 子页面按 R 无 pageerror
await p.goto("http://127.0.0.1:5000/#/compare"); await wait(1500);
const errBefore = pageErrors.length;
await p.keyboard.press("r"); await wait(800);
rec("R3 对比页按 R 无崩溃", pageErrors.length === errBefore, "pageErrors=" + pageErrors.length);

// R4: 对比页趋势卡（root 已由默认盘落定，属正常路径；记录是否有 series 400）
rec("R4 无 /api/series 4xx", series400.length === 0, "400s=" + series400.join(","));
await p.screenshot({ path: path.join(OUT, "u72-r4-compare-idle.png") });

// R5: 对比页加载会自动发起一次对比——等它跑完（最长 150s），验证不误报超时
{
  const t0 = Date.now(); let doneTxt = "";
  while (Date.now() - t0 < 150000) {
    await wait(3000);
    const body = await p.evaluate(() => document.body.innerText);
    if (body.includes("正在对比")) continue;
    doneTxt = body.match(/总变化[^\n]{0,40}|共\s*\d+\s*条[^\n]{0,20}|无变化[^\n]{0,20}|没有差异[^\n]{0,20}|对比失败[^\n]{0,40}|对比超时[^\n]{0,20}/)?.[0] || "";
    if (doneTxt) break;
    if (Date.now() - t0 > 150000) break;
  }
  await p.screenshot({ path: path.join(OUT, "u72-r5-compare-result.png") });
  rec("R5 对比完成且未误报超时", !!doneTxt && !doneTxt.includes("超时") && !doneTxt.includes("失败"), doneTxt || "timeout");
}

// R6: 取消对比无僵尸轮询——手动再发起一次并立即取消
let compareReqs = 0;
p.on("request", (r) => { if (r.url().includes("/api/compare")) compareReqs++; });
const startBtn = p.locator("button", { hasText: "开始对比" }).first();
if (await startBtn.count() && !(await startBtn.isDisabled().catch(() => true))) {
  await startBtn.click(); await wait(1500);
  const cancelBtn = p.locator("button", { hasText: "取消" }).first();
  if (await cancelBtn.count()) { await cancelBtn.click(); await wait(500); }
  const at = compareReqs; await wait(6000);
  rec("R6 取消后轮询停止", compareReqs - at <= 1, `cancel时=${at} 6s后=${compareReqs}`);
} else rec("R6 取消轮询", false, "无法再次发起对比");

rec("R7 全程 pageerror 0", pageErrors.length === 0, pageErrors.slice(0, 3).join("|"));
fs.writeFileSync(path.join(OUT, "u72-result.json"), JSON.stringify({ results, pageErrors }, null, 2));
console.log("DONE");
await b.close();
