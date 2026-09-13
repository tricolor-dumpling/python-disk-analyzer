/* u75 改版验收：
   V1 对比页：无发散图、控制条居中、摘要卡等宽、密度
   V2 快照页：无趋势卡、筛选条（盘符/类型/关键词即时过滤）、勾选+批量删除（干跑：勾选+按钮态，不真删）
   V3 存储概览联动：chip 点击 → 浏览输入框跟随；浏览他盘 → chip/环形跟随
*/
import { chromium, arg, wait } from "./_harness.mjs";
import fs from "node:fs"; import path from "node:path";
const OUT = path.resolve(arg("out", "test-report/redesign")); fs.mkdirSync(OUT, { recursive: true });
const results = [];
const rec = (n, ok, note) => { results.push({ n, ok, note }); console.log(`${ok ? "PASS" : "FAIL"} ${n}${note ? " — " + note : ""}`); };

const b = await chromium.launch({ headless: true });
const p = await (await b.newContext({ viewport: { width: 1920, height: 1080 } })).newPage();
const pageErrors = []; p.on("pageerror", (e) => pageErrors.push(String(e)));
const consoleErrs = []; p.on("console", (m) => { if (m.type() === "error") consoleErrs.push(m.text()); });

// ===== 工作台 + 联动 =====
await p.goto("http://127.0.0.1:5000/", { waitUntil: "domcontentloaded" }); await wait(2200);
if (await p.locator("#btn-onboarding-close").count()) await p.click("#btn-onboarding-close").catch(() => {});
await wait(400);
await p.fill("#browse-root", "C:\\"); await p.click("#btn-browse");
await p.waitForSelector("canvas", { timeout: 30000 }).catch(() => {}); await wait(1200);

// V3a: 点 D: chip → 浏览输入框应变为 D:\
const dChip = p.locator("#overview-chips .chip", { hasText: "D:" }).first();
if (await dChip.count()) {
  await dChip.click(); await wait(600);
  const v = await p.locator("#browse-root").inputValue();
  rec("V3a chip 点击联动浏览输入框", v.startsWith("D:"), "browse-root=" + v);
} else rec("V3a chip 联动", false, "无 D: chip");
await p.screenshot({ path: path.join(OUT, "v3a-chip-link.png") });

// V3b: 浏览回 C:\ → 存储概览 chip 激活态跟随回 C:
await p.fill("#browse-root", "C:\\"); await p.click("#btn-browse"); await wait(1500);
const activeChip = await p.locator("#overview-chips .chip.is-active").innerText().catch(() => "?");
rec("V3b 浏览联动 chip 激活跟随", activeChip.includes("C:"), "active=" + activeChip);

// ===== 对比页 =====
await p.goto("http://127.0.0.1:5000/#/compare"); await wait(2500);
const t0 = Date.now();
while (Date.now() - t0 < 150000) {
  await wait(3000);
  const body = await p.evaluate(() => document.body.innerText);
  if (!body.includes("正在对比")) break;
}
await wait(800);
await p.screenshot({ path: path.join(OUT, "v1-compare-redesign.png"), fullPage: true });
rec("V1a 发散图已移除", (await p.locator("#compare-diverge").count()) === 0 && (await p.locator(".diverge-row").count()) === 0);
const center = await p.evaluate(() => {
  const c = document.querySelector(".compare-controls");
  if (!c) return null;
  const kids = [...c.children];
  if (!kids.length) return null;
  const first = kids[0].getBoundingClientRect();
  const last = kids[kids.length - 1].getBoundingClientRect();
  const box = c.getBoundingClientRect();
  const leftGap = first.left - box.left, rightGap = box.right - last.right;
  return { leftGap: Math.round(leftGap), rightGap: Math.round(rightGap) };
});
rec("V1b 控制条居中", !!center && Math.abs(center.leftGap - center.rightGap) < 120, JSON.stringify(center));
const cards = await p.evaluate(() => [...document.querySelectorAll(".compare-stat")].map((el) => Math.round(el.getBoundingClientRect().width)));
rec("V1c 摘要卡等宽", cards.length === 3 && Math.max(...cards) - Math.min(...cards) < 4, JSON.stringify(cards));

// ===== 快照页 =====
await p.goto("http://127.0.0.1:5000/#/snapshots"); await wait(2000);
await p.screenshot({ path: path.join(OUT, "v2-snapshots-redesign.png"), fullPage: true });
rec("V2a 趋势卡已移除", (await p.locator("#trend-row").count()) === 0 && (await p.locator(".trend-card").count()) === 0);
rec("V2b 筛选条存在", (await p.locator("#snap-filter-root").count()) === 1 && (await p.locator("#snap-filter-kw").count()) === 1);

const totalBefore = (await p.locator("#snapshots-list-count").innerText().catch(() => "")).trim();
// 类型筛选=手动（本机大概率全为自动 → 应出空态）
await p.selectOption("#snap-filter-type", "manual"); await wait(500);
const afterFilter = await p.locator("#snapshots-list-count").innerText().catch(() => "");
const emptyShown = await p.locator(".empty-state").count();
await p.screenshot({ path: path.join(OUT, "v2b-filter-manual.png") });
rec("V2c 类型筛选生效", afterFilter.includes("已筛选") || emptyShown > 0, `before="${totalBefore}" after="${afterFilter}" empty=${emptyShown}`);
await p.selectOption("#snap-filter-type", "all"); await wait(500);

// 盘符筛选
const rootOpts = await p.locator("#snap-filter-root option").allInnerTexts();
rec("V2d 盘符筛选选项动态生成", rootOpts.length >= 2, JSON.stringify(rootOpts));

// 勾选 + 批量删除按钮态（不真删）
const cb = p.locator(".act-sel-session").first();
if (await cb.count()) {
  await cb.check(); await wait(400);
  const btnTxt = await p.locator("#snap-btn-batch-del").innerText();
  const disabled = await p.locator("#snap-btn-batch-del").isDisabled();
  rec("V2e 勾选后批量删除按钮激活", !disabled && btnTxt.includes("已选 1"), btnTxt + " disabled=" + disabled);
  // 全选再取消（验证全选联动）
  await p.locator("#snap-check-all").check(); await wait(400);
  const txt2 = await p.locator("#snap-btn-batch-del").innerText();
  await p.locator("#snap-check-all").uncheck(); await wait(400);
  const txt3 = await p.locator("#snap-btn-batch-del").innerText();
  rec("V2f 全选/取消联动", txt2.includes("已选") && !txt3.includes("已选"), `all="${txt2}" none="${txt3}"`);
} else rec("V2e/V2f", false, "无会话复选框");
await p.screenshot({ path: path.join(OUT, "v2e-batch.png") });

rec("V4 pageerror 0", pageErrors.length === 0, pageErrors.slice(0, 3).join("|"));
rec("V5 console 0", consoleErrs.filter((t) => !t.includes("favicon")).length === 0, consoleErrs.slice(0, 3).join("|"));
fs.writeFileSync(path.join(OUT, "u75-result.json"), JSON.stringify({ results, pageErrors, consoleErrs }, null, 2));
console.log("DONE");
await b.close();
