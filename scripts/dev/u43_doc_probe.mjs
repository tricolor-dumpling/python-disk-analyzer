/* U4.3 文档与版本收口验收探针
   用法：node scripts/dev/u43_doc_probe.mjs
   依赖：Flask 5000（真实页 DOM/console/零滚动）+ 静态 8771（桩页行为最小集）
   覆盖：
     ① README v2.0.0 陈述 vs 实现（标题/版本/顶栏八组/路由三页/主题三态/快捷键矩阵/紧凑档说明）
     ② grep 断言：app.js 零引用（web+smoke+README）、smoke legacy 注册表零残留、style.css 无死分区（对照清单）
     ③ hex 门禁 style.css = 0（只减不增）
     ④ 版本一致性：README v2.0.0 = 状态栏版本 = HEAD 注释（UI 2.0 SpaceLens Pro）
     ⑤ console 0（真实页加载 + 路由往返）
   输出：逐项 PASS/FAIL；退出码 0/1。 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const { chromium } = require("C:/Users/26024/.dsh/profiles/web/node_modules/playwright");

const STUB_BASE = "http://127.0.0.1:8771/tests/web/smoke.html";
const REAL_BASE = "http://127.0.0.1:5000/";

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log("  ✔ " + label); }
  else { fail++; console.log("  ✘ " + label); }
}
function section(t) { console.log("\n== " + t + " =="); }

/* ---------- ① README 内容断言（文件层） ---------- */
section("① README v2.0.0 关键陈述（文件层）");
const readme = readFileSync("README.md", "utf8");
const head = readme.split("\n").slice(0, 6).join("\n");
const has = (s, l) => ok(readme.includes(s), l);
has("v2.0.0", "README 声明 v2.0.0");
has("UI 2.0（SpaceLens Pro）", "README 标识 UI 2.0（SpaceLens Pro）");
has("App Shell", "README 陈述 App Shell");
has("单屏", "README 陈述单屏应用");
has("#/compare", "README 陈述 #/compare 路由");
has("#/snapshots", "README 陈述 #/snapshots 路由");
has("跟随系统", "README 陈述主题三态（跟随系统）");
has("Ctrl/⌘K", "README 陈述命令面板 Ctrl/⌘K");
ok(readme.includes("键盘矩阵") || readme.includes("快捷键矩阵"), "README 陈述键盘矩阵");
has("Backspace", "README 陈述 Backspace 上级");
has("↑` `↓` `←` `→", "README 陈述方向键焦点块移动") || has("最近邻移动焦点块", "README 陈述方向键最近邻移动焦点块");
has("紧凑档", "README 陈述 1366×768 紧凑档");
has("零滚动", "README 陈述零滚动");
ok(/v2\.0\.0/.test(head), "README 头部（前 6 行）即含版本号（升版注记落位）");

/* ---------- ② grep 断言 ---------- */
section("② grep：死代码零残留");
function grepFiles(pattern, files) {
  const re = new RegExp(pattern, "i");
  const hits = [];
  for (const f of files) {
    let t;
    try { t = readFileSync(f, "utf8"); } catch (e) { continue; }
    if (re.test(t)) hits.push(f);
  }
  return hits;
}
const webFiles = [];
(function walk(dir) {
  const fs = require("node:fs"), p = require("node:path");
  for (const f of fs.readdirSync(dir)) {
    const fp = p.join(dir, f);
    if (fs.statSync(fp).isDirectory()) walk(fp);
    else if (/\.(js|html|css|md)$/.test(f)) webFiles.push(fp);
  }
})("web");
const refs = grepFiles("app\\.js", webFiles.concat(["tests/web/smoke.html", "README.md"]));
ok(refs.length === 0, "app.js 零引用（web + smoke.html + README：命中 " + refs.join(",") + "）");
const legacyCode = grepFiles("ASSERTIONS_V1|suite=legacy|legacy suite", ["tests/web/smoke.html"]);
ok(legacyCode.length === 0, "smoke.html 无 legacy/v1 注册表残留（命中 " + legacyCode.join(",") + "）");
const smokeText = readFileSync("tests/web/smoke.html", "utf8");
ok(/const __SUITE_REGISTRIES = \{ v2: ASSERTIONS_V2 \}/.test(smokeText), "smoke 注册表仅 v2（ASSERTIONS_V2 唯一注册表）");
ok(/const ASSERTIONS_V2 = \[/.test(smokeText) && !/const ASSERTIONS_V1/.test(smokeText), "smoke 无 v1 断言注册表定义");
const css = readFileSync("web/static/css/style.css", "utf8");
const deadParts = grepFiles("browse-chart|\\.composition|donut-bg|legend-dir|legend-file|\\.grid-main|\\.footer[^a-z-]|page-body-empty", ["web/static/css/style.css"]);
ok(deadParts.length === 0, "style.css 无死分区残留（U1.3 删除清单 + U4.3 清理：命中 " + deadParts.join(",") + "）");
ok(!/\.snapshot-mini-line/.test(css), "style.css 无 .snapshot-mini-line（从未生成的死规则）");

/* ---------- ③ hex 门禁 ---------- */
section("③ hex 色值门禁");
const hexCount = (css.match(/#[0-9a-fA-F]{3,8}\b/g) || []).length;
ok(hexCount === 0, "style.css hex = 0（实测 " + hexCount + "）");
const noAppJsFile = !require("node:fs").existsSync("web/static/js/app.js");
ok(noAppJsFile, "web/static/js/app.js 物理已删除");

/* ---------- ④ 版本一致性 ---------- */
section("④ 版本一致性");
const indexHtml = readFileSync("web/templates/index.html", "utf8");
ok(/v2\.0\.0/.test(indexHtml), "index.html 状态栏版本 = v2.0.0");
ok(/v2\.0\.0/.test(readme), "README 版本 = v2.0.0（与状态栏一致）");
const jsHead = readFileSync("web/static/js/app/main.js", "utf8").split("\n").slice(0, 2).join(" ");
ok(/UI 2\.0（SpaceLens Pro）/.test(jsHead), "模块 HEAD 注释 = UI 2.0（SpaceLens Pro）");

/* ---------- ⑤ 桩页行为最小集（8771） ---------- */
section("⑤ 桩页：顶栏/路由/主题三态/快捷键矩阵（行为最小集）");
const browser = await chromium.launch();
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errs = [];
  page.on("pageerror", (e) => errs.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text()); });
  await page.goto(STUB_BASE + "?suite=v2", { waitUntil: "load" });
  await page.waitForFunction(() => /\[suite=[^\]]+\]\[(?:PASS|FAIL) \d+\/\d+\]/.test(document.title), { timeout: 60000 }).catch(() => {});
  ok(/\[suite=v2\]\[PASS \d+\/\d+\]/.test(await page.title()), "smoke v2 全绿（" + (await page.title()) + "）");

  // 顶栏（品牌完整性在 ⑥ 真实页断言——桩脚手架为最小同构，无 brand）
  const topbar = await page.evaluate(() => ({
    tabs: document.querySelectorAll(".nav-tab").length,
    badge: !!document.querySelector("#health-badge"),
    palette: !!document.querySelector("#btn-palette"),
    theme: !!document.querySelector("#btn-theme"),
    scanTop: !!document.querySelector("#btn-scan-top"),
    guide: !!document.querySelector("#btn-guide"),
    settings: !!document.querySelector("#btn-settings"),
  }));
  ok(topbar.badge && topbar.palette && topbar.theme && topbar.scanTop && topbar.guide && topbar.settings, "顶栏七组齐全（徽章/搜索框/主题/开始扫描/指引/设置）");
  ok(topbar.tabs === 3, "导航标签 3 个（工作台/对比/快照）");

  // 路由三页（标题/页头元素）
  const routeInfo = {};
  for (const h of ["#/", "#/compare", "#/snapshots"]) {
    await page.evaluate((hh) => { location.hash = hh; }, h);
    await page.waitForTimeout(700);
    routeInfo[h] = await page.evaluate(() => {
      const t = document.querySelector("[data-page-title]");
      return {
        title: t ? t.textContent : null,
        compare: {
          baseline: !!document.querySelector("#compare-baseline"),
          target: !!document.querySelector("#compare-target"),
          btn: !!document.querySelector("#btn-compare"),
        },
        snapshots: {
          create: !!document.querySelector("#btn-create-snapshot") || !!document.querySelector("#btn-snapshot-create") || !!document.querySelector("#btn-save-now"),
          undo: (() => { const els = document.querySelectorAll("button"); for (const b of els) if (b.textContent.includes("撤销")) return true; return false; })(),
          trends: document.querySelectorAll(".trend-card").length,
        },
        ws: {
          filter: !!document.querySelector("#browse-filter"),
          treemap: !!document.querySelector("#treemap-wrap"),
          density: !!document.querySelector("#btn-density"),
          merge: !!document.querySelector("#merge-group"),
        },
      };
    });
  }
  ok(routeInfo["#/"].title === "工作台", "路由 #/ → 工作台（页头标题）");
  ok(routeInfo["#/"].ws.filter && routeInfo["#/"].ws.treemap && routeInfo["#/"].ws.density && routeInfo["#/"].ws.merge, "工作台元素齐全（筛选框/矩形图/密度/合并阈值）");
  ok(routeInfo["#/compare"].title === "历史对比" && routeInfo["#/compare"].compare.baseline && routeInfo["#/compare"].compare.target && routeInfo["#/compare"].compare.btn, "路由 #/compare → 历史对比（基线下拉+目标只读+开始对比）");
  ok(routeInfo["#/snapshots"].title === "快照管理" && routeInfo["#/snapshots"].snapshots.trends >= 2, "路由 #/snapshots → 快照管理（趋势卡×2）");

  // 主题三态（设置弹窗 radio）
  await page.evaluate(() => { location.hash = "#/"; });
  await page.waitForTimeout(500);
  await page.evaluate(() => { const b = document.querySelector("#btn-settings"); if (b) b.click(); });
  await page.waitForTimeout(300);
  const theme = await page.evaluate(() => ({
    radios: document.querySelectorAll("#setting-theme input[type=radio]").length,
    labels: Array.from(document.querySelectorAll("#setting-theme label")).map((l) => l.textContent.trim()),
  }));
  ok(theme.radios === 3 && theme.labels.join() === "亮,暗,跟随系统", "设置弹窗主题三态（亮/暗/跟随系统，实测：" + theme.labels.join("/") + "）");
  await page.keyboard.press("Escape"); // 栈关闭（桩脚手架设置弹窗无 data-close 按钮，Esc 走栈）

  // 快捷键矩阵最小集：/ 聚焦筛选、g c、g s、Ctrl K、主题按钮切换
  const kbd = {};
  await page.evaluate(() => { const i = document.querySelector("#browse-filter"); if (i) i.blur(); });
  await page.keyboard.press("/");
  kbd.slash = await page.evaluate(() => document.activeElement && document.activeElement.id === "browse-filter");
  await page.keyboard.press("Escape");
  await page.evaluate(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); });
  await page.keyboard.press("g"); await page.keyboard.press("c");
  kbd.gc = await page.evaluate(() => location.hash);
  await page.keyboard.press("g"); await page.keyboard.press("s");
  kbd.gs = await page.evaluate(() => location.hash);
  await page.evaluate(() => { document.activeElement && document.activeElement.blur(); });
  await page.keyboard.press("Control+k");
  kbd.ctrlk = await page.evaluate(() => !document.querySelector("#palette") || !document.querySelector("#palette").classList.contains("hidden"));
  ok(kbd.slash === true, "/ 聚焦筛选框 #browse-filter");
  ok(kbd.gc === "#/compare", "g c → #/compare（实测 " + kbd.gc + "）");
  ok(kbd.gs === "#/snapshots", "g s → #/snapshots（实测 " + kbd.gs + "）");
  ok(kbd.ctrlk === true, "Ctrl K 打开命令面板");
  const t0 = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
  await page.evaluate(() => { const b = document.querySelector("#btn-theme"); if (b) b.click(); });
  await page.waitForTimeout(250);
  const t1 = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
  ok(t0 !== t1, "主题按钮切换 data-theme（" + t0 + " → " + t1 + "）");
  const persisted = await page.evaluate(() => localStorage.getItem("pds_theme_v1"));
  ok(persisted === "dark" || persisted === "light", "pds_theme_v1 持久化（" + persisted + "）");
  ok(errs.length === 0, "桩页 console/pageerror 0" + (errs.length ? "：" + errs.join(" | ") : ""));
  await page.close();
}

/* ---------- ⑥ 真实页 DOM+console+零滚动（5000） ---------- */
section("⑥ 真实页：壳结构/版本/零滚动/console 0（路由往返）");
{
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  const errs = [];
  page.on("pageerror", (e) => errs.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text()); });
  await page.goto(REAL_BASE, { waitUntil: "load" });
  await page.waitForTimeout(2500);
  const shell = await page.evaluate(() => ({
    app: !!document.querySelector(".app#app"),
    shellCls: !!document.querySelector(".shell"),
    statusbar: document.querySelector(".statusbar-left") ? document.querySelector(".statusbar-left").textContent : null,
    version: /v2\.0\.0/.test((document.querySelector(".statusbar-left") || {}).textContent || ""),
    nav: document.querySelectorAll(".nav-tab").length,
    zeroScroll: document.documentElement.scrollHeight === document.documentElement.clientHeight &&
                document.body.scrollHeight === document.body.clientHeight,
  }));
  ok(shell.app && shell.shellCls, "真实页 App Shell（.app/.shell）");
  const brand = await page.evaluate(() => ({
    brand: !!document.querySelector(".brand"),
    logo: !!document.querySelector(".brand-logo"),
    h1: !!(document.querySelector(".brand h1") || {}).textContent,
    sub: !!(document.querySelector(".brand-sub") || {}).textContent,
  }));
  ok(brand.brand && brand.logo && brand.h1 && brand.sub, "真实页品牌区（brand/logo/标题/副标语）");
  ok(shell.version, "真实页状态栏版本 v2.0.0（" + (shell.statusbar || "").trim() + "）");
  ok(shell.nav === 3, "真实页导航标签 3 个");
  ok(shell.zeroScroll === true, "真实页 body 零滚动（1366×768；scrollHeight==clientHeight）");
  // 路由往返（#/compare 最后访问：真实对比为 SDK 直扫口径，仅断言发起态 DOM——G8 惯例）
  await page.evaluate(() => { location.hash = "#/snapshots"; });
  await page.waitForTimeout(700);
  await page.evaluate(() => { location.hash = "#/"; });
  await page.waitForTimeout(700);
  await page.evaluate(() => { location.hash = "#/compare"; });
  await page.waitForTimeout(700);
  const cmp = await page.evaluate(() => ({
    title: (document.querySelector("[data-page-title]") || {}).textContent,
    baseline: !!document.querySelector("#compare-baseline"),
    target: !!document.querySelector("#compare-target"),
    skeleton: !!document.querySelector("#compare-loading"),
  }));
  ok(cmp.title === "历史对比" && cmp.baseline && cmp.target, "真实页 #/compare 页头 DOM（标题/基线/目标只读）");
  await page.evaluate(() => { location.hash = "#/"; });
  await page.waitForTimeout(500);
  ok(errs.length === 0, "真实页 console/pageerror 0（加载 + 路由往返；" + (errs.length ? errs.join(" | ") : "") + "）");
  await page.close();
}
await browser.close();

console.log("\n===== u43_doc_probe 结果：" + pass + "/" + (pass + fail) + " =====");
process.exit(fail ? 1 : 0);
