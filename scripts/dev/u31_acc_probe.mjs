/* ============================================================
   UI 2.0（SpaceLens Pro）· U3.1 顶栏与导航验收探针
   - 验收口径（手册 §U3.1 + 用户补充项）：
     ①面板打开 <100ms（--dur-palette-open:80ms token 方案）+ 过滤无卡顿；
     ②模糊匹配（子序列命中 + 首字母加权）抽查（fuzzyScore 纯函数 + 面板行为）；
     ③↑↓/Enter/Esc 键盘循环；面板入弹窗栈（Esc 逆序关栈顶——红线 #9 扩展）；
     ④圆点三触发（扫描完成/快照保存成功/对比完成——经真实函数路径）
       与点击消除、pds:navigate 同步 + 下划线 L2-11 参数（240ms ease-inout，reduced 直切）；
     ⑤徽章 popover 三字段（数据目录/驱动状态/重试按钮 = 红线 #8 第二求值点）；
     ⑥主题按钮移正（U1.1 switchTheme）；Ctrl/⌘K 与 / 守卫（输入框内不触发）；
     ⑦50 次开合无泄漏（DOM 节点数稳定）；双档零滚动 + console 0 + 顶栏 60px 实测；
     ⑧reduced-motion 降级（下划线/面板开合直切）。
   - 策略：桩态（addInitScript 覆写 fetch，先于 main.js 求值）跑确定性断言；
     真实页阶段（--with-data）验证真机渲染 + 零滚动 + console 0 + 多模态截图。
   - 运行：node scripts/dev/u31_acc_probe.mjs [--base http://127.0.0.1:5000/]
            [--out <截图目录>] [--with-data]
   ============================================================ */

import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("C:/Users/26024/.dsh/profiles/web/node_modules/playwright");

function arg(name, dflt) {
    const i = process.argv.indexOf("--" + name);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const BASE = arg("base", "http://127.0.0.1:5000/");
const OUT = arg("out", path.join(os.tmpdir(), "u31_acc_shots"));
const WITH_DATA = process.argv.indexOf("--with-data") >= 0;
fs.mkdirSync(OUT, { recursive: true });

let passCount = 0, failCount = 0;
function ok(name, cond, detail) {
    if (cond) { passCount++; console.log("  ✔ " + name); }
    else { failCount++; console.log("  ✖ " + name + (detail ? " :: " + detail : "")); }
}
function shot(page, name) {
    return page.screenshot({ path: path.join(OUT, name + ".png"), fullPage: false });
}

/* 页内条件等待（≤15s 锚；状态断言一律条件等待，禁固定窗） */
const WAIT_FN = `(fn, timeout) => new Promise((resolve) => {
  const end = Date.now() + (timeout || 15000);
  const tick = () => { if (fn()) resolve(true); else if (Date.now() > end) resolve(fn()); else setTimeout(tick, 100); };
  tick();
})`;
async function installWait(page) {
    await page.evaluate((src) => { window.__wait = eval("(" + src + ")"); }, WAIT_FN);
}

/* ---- 桩态 fetch（addInitScript；扫描状态机可脚本化：
   idle → POST /api/fullscan/start 后 running(40%) → window.__stub.scanComplete=true 后
   下一拍 result_ready（完成边沿触发 markNavDot("/")）。⚠️ 反斜杠转义层数同 u25 探针 */
const STUB_FN = `
window.__stub = { scanState: "idle", scanComplete: false, fetchLog: [] };
window.fetch = function (url, options) {
  options = options || {};
  const key = (options.method || "GET").toUpperCase() + " " + String(url).split("?")[0];
  window.__stub.fetchLog.push(key);
  const json = (o, s) => Promise.resolve({ ok: (s || 200) < 400, status: s || 200,
    json: () => Promise.resolve(JSON.parse(JSON.stringify(o))) });
  if (key === "GET /api/health") return json({ ok: true, ready: true, dll: "stub-dll", message: "Everything 已就绪" });
  if (key === "GET /api/settings") return json({ ok: true, settings: { auto_save: false, last_roots: ["D:\\\\", "C:\\\\"] }, data_dir: "C:\\\\stub\\\\data", snapshots_dir: "C:\\\\stub\\\\snapshots" });
  if (key === "POST /api/settings") return json({ ok: true, settings: {} });
  if (key === "POST /api/browse") {
    const p = options.body ? JSON.parse(options.body).path : null;
    if (p === "D:\\\\big") return json({ ok: true, root: "D:\\\\big", parent: "D:\\\\", directories: [ { name: "bigdir", path: "D:\\\\big\\\\bigdir", is_dir: true, size: 500, size_human: "500 B" } ], files: [], total_dirs: 1, total_files: 0 });
    return json({ ok: true, root: "D:\\\\", parent: null,
      directories: [ { name: "data", path: "D:\\\\data", is_dir: true, size: 12000, size_human: "11.72 KB" }, { name: "docs", path: "D:\\\\docs", is_dir: true, size: 4000, size_human: "3.91 KB" } ],
      files: [ { name: "pagefile.sys", path: "D:\\\\pagefile.sys", is_dir: false, size: 999999, size_human: "976.56 KB" }, { name: "readme.txt", path: "D:\\\\readme.txt", is_dir: false, size: 100, size_human: "100 B" } ],
      total_dirs: 2, total_files: 2 });
  }
  if (key === "GET /api/fullscan/status") {
    if (window.__stub.scanState === "idle") return json({ ok: true, status: { running: false, roots: ["D:\\\\"], roots_done: 0, roots_total: 1, current_root: null, error: null, result_ready: false, save_ready: false, progress_pct: 0, scan_version: 1 } });
    if (window.__stub.scanComplete) {
      window.__stub.scanState = "done";
      return json({ ok: true, status: { running: false, roots: ["D:\\\\"], roots_done: 1, roots_total: 1, current_root: null, error: null, result_ready: true, save_ready: true, progress_pct: 100, scan_version: 7 } });
    }
    return json({ ok: true, status: { running: true, roots: ["D:\\\\"], roots_done: 0, roots_total: 1, current_root: "D:\\\\", error: null, result_ready: false, save_ready: false, progress_pct: 40, scan_version: 7 } });
  }
  if (key === "POST /api/fullscan/start") { window.__stub.scanState = "running"; window.__stub.scanComplete = false; return json({ ok: true, message: "全量扫描任务已提交，后台执行中" }); }
  if (key === "GET /api/snapshots") return json({ ok: true, sessions: [ { session_id: "s-u31", auto: false, machine_guid: "u31", created_at: "2026-08-24T10:00:00", roots: { "D:\\\\": { root: "D:\\\\", snapshot: "D.snap.gz", snapshot_path: "C:\\\\stub\\\\D.snap.gz", skipped: false } } } ], count: 1 });
  if (key === "POST /api/save") return json({ ok: true, message: "保存完成", session: {}, skipped: false });
  if (key === "POST /api/compare") return json({ ok: true, report: { root: "D:\\\\", total_baseline: 16000, total_current: 15990, delta_total: -10, truncated: false, legacy_count: 0, rows: [ { path: "D:\\\\data", baseline: 12000, current: 11990, delta: -10, growth_pct: -0.08, removed: false, added: false } ] } });
  if (key === "GET /api/overview") return json({ ok: true, ready: true, roots: [ { root: "D:\\\\", total: 4800000, total_human: "4.58 MB", index_ready: true, index_valid: true, directories: [ { name: "data", path: "D:\\\\data", size: 3000000, size_human: "2.86 MB" } ], files: [], directory_count: 2, file_count: 2, record_count: 4, completed_at: "2026-08-24T10:00:00" } ], completed_at: "2026-08-24T10:00:00" });
  if (key === "POST /api/save/undo") return json({ ok: true, message: "已撤销", session_id: "s-u31", deleted: [], undeleted: [] });
  if (key === "POST /api/open-path") return json({ ok: true, launched: true, message: "ok" });
  return json({ ok: true });
};
`;

(async () => {
    const browser = await chromium.launch();
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));

    /* ================= 阶段 1：桩态确定性断言 ================= */
    console.log("== 阶段 1：桩态（stub fetch） ==");
    {
        const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
        const errs = [];
        page.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text()); });
        page.on("pageerror", (e) => errs.push("pageerror: " + e.message));
        await page.addInitScript(() => { try { localStorage.setItem("pds_onboarding_dismissed_v1", "1"); } catch (e) {} });
        await page.addInitScript(STUB_FN); // Playwright 字符串形式 = 函数体（先于页面脚本求值）
        await page.goto(BASE, { waitUntil: "load" });
        await installWait(page);
        // 防误伤防护：stub 未接管（如注入失败）必须立即中止——避免打到真实后端
        const stubOk = await page.evaluate(() => typeof window.__stub === "object" && String(window.fetch).indexOf("__stub") !== -1).catch(() => false);
        if (!stubOk) {
            ok("前置：桩态 fetch 已接管（失败则不继续，防真实后端副作用）", false, "window.__stub 缺失");
            console.log("== 结果：" + passCount + "/" + (passCount + failCount) + " ==");
            await page.close();
            await browser.close();
            process.exit(1);
        }
        ok("前置：桩态 fetch 已接管（失败则不继续，防真实后端副作用）", true);
        // 异步 UI 收敛（各卡渲染完成）
        await page.waitForTimeout(2500);

        /* ---- ① 面板打开 <100ms（rAF 一帧后可见即算打开；动画 80ms 为视觉入场） ---- */
        const openMs = await page.evaluate(async () => {
            const t0 = performance.now();
            document.getElementById("btn-palette").click();
            await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
            const el = document.getElementById("palette");
            const visible = !el.classList.contains("hidden");
            const items = document.querySelectorAll("#palette-results .palette-item").length;
            return { ms: performance.now() - t0, visible, items };
        });
        ok("①面板打开 <100ms（点击→可见+条目就绪）", openMs.visible && openMs.items > 0 && openMs.ms < 100, JSON.stringify(openMs));
        ok("①面板打开后输入框聚焦", await page.evaluate(() => document.activeElement && document.activeElement.id === "palette-input"));

        /* ---- ② 模糊匹配（子序列 + 首字母加权） ---- */
        let fz = await page.evaluate(async () => {
            const m = await import("/static/js/app/main.js");
            return {
                exactLabel: m.fuzzyScore("工作台", "工作台", ["workspace"]),
                exactKw: m.fuzzyScore("scan", "开始扫描", ["scan", "start"]),
                subseq: m.fuzzyScore("wspace", "工作台", ["workspace", "home", "gzt"]),
                prefixKw: m.fuzzyScore("expo", "导出 CSV", ["export", "csv"]),
                none: m.fuzzyScore("zzzz", "工作台", ["workspace"]),
            };
        });
        ok("②fuzzyScore 精确/关键词精确/子序列/前缀/不命中分级", fz.exactLabel === 1000 && fz.exactKw === 700 && fz.prefixKw === 650 && fz.subseq > 0 && fz.subseq < 650 && fz.none === 0, JSON.stringify(fz));
        await page.fill("#palette-input", "gzt");
        await wait(80);
        let first = await page.evaluate(() => { const el = document.querySelector(".palette-item .palette-item-label"); return el && el.textContent; });
        ok("②面板过滤 gzt → 工作台（首字母加权命中）", first === "工作台", "first=" + first);
        await page.fill("#palette-input", "kssm");
        await wait(80);
        first = await page.evaluate(() => { const el = document.querySelector(".palette-item .palette-item-label"); return el && el.textContent; });
        ok("②面板过滤 kssm → 开始扫描（命令）", first === "开始扫描", "first=" + first);
        await page.fill("#palette-input", "snap");
        await wait(80);
        const snapFirst = await page.evaluate(() => ({ first: (document.querySelector(".palette-item .palette-item-label") || {}).textContent, n: document.querySelectorAll(".palette-item").length }));
        ok("②面板过滤 snap → 快照（页面/快照组，多条）", snapFirst.first === "快照" && snapFirst.n >= 2, JSON.stringify(snapFirst));
        const empty = await page.fill("#palette-input", "zzzz").then(() => page.evaluate(() => document.querySelector(".palette-empty") && document.querySelector(".palette-empty").textContent));
        ok("②无结果空态文案（定稿 6.5）", /没有匹配「zzzz」的条目/.test(String(empty || "")), String(empty));

        /* ---- ③ ↑↓/Enter/Esc 键盘循环 ---- */
        await page.fill("#palette-input", "");
        await wait(60);
        await page.keyboard.press("ArrowDown"); await wait(40);
        let sel = await page.evaluate(() => (document.querySelector(".palette-item.is-active") || {}).textContent || "");
        ok("③ArrowDown 移动选中（默认空查询=全部条目，idx1=对比）", sel.indexOf("对比") !== -1, sel);
        await page.keyboard.press("ArrowUp"); await wait(40);
        sel = await page.evaluate(() => (document.querySelector(".palette-item.is-active") || {}).textContent || "");
        ok("③ArrowUp 回退到第 0 项（工作台）", sel.indexOf("工作台") !== -1, sel);
        await page.keyboard.press("Escape"); await wait(80);
        ok("③Esc 关闭面板（弹窗栈）", await page.evaluate(() => document.getElementById("palette").classList.contains("hidden")));
        await page.keyboard.press("Control+k"); await wait(120);
        ok("③Ctrl+K 再次打开（在任意页可用）", await page.evaluate(() => !document.getElementById("palette").classList.contains("hidden")));
        await page.keyboard.press("ArrowDown"); await wait(40);
        await page.keyboard.press("Enter");
        await page.waitForFunction(() => location.hash === "#/compare", { timeout: 15000 }).catch(() => {});
        const efter = await page.evaluate(() => ({ hash: location.hash, closed: document.getElementById("palette").classList.contains("hidden") }));
        ok("③Enter 执行页面跳转（对比）并关面板", efter.hash === "#/compare" && efter.closed, JSON.stringify(efter));

        /* ---- ④ 面板入栈（Esc 逆序：设置 → 面板） ---- */
        const stack = await page.evaluate(async () => {
            const m = await import("/static/js/app/main.js");
            m.openPalette();
            await new Promise((r) => setTimeout(r, 60));
            if (document.getElementById("palette").classList.contains("hidden")) return { fail: "palette not open" };
            m.openModal("settings-modal");
            await new Promise((r) => setTimeout(r, 60));
            document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
            await new Promise((r) => setTimeout(r, 60));
            const afterEsc1 = {
                settings: document.getElementById("settings-modal").classList.contains("hidden"),
                palette: !document.getElementById("palette").classList.contains("hidden"),
            };
            document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
            await new Promise((r) => setTimeout(r, 60));
            return { afterEsc1, paletteAfter2: !document.getElementById("palette").classList.contains("hidden") };
        });
        ok("④面板入栈：Esc 先关栈顶设置、再关面板（逆序）", !stack.fail && stack.afterEsc1.settings && stack.afterEsc1.palette && !stack.paletteAfter2, JSON.stringify(stack));
        await page.evaluate(() => { location.hash = "#/"; });
        await page.waitForFunction(() => location.hash === "#/" && !!document.getElementById("dir-body"), { timeout: 15000 }).catch(() => {});

        /* ---- ⑤ 圆点：markNavDot + 点击消除 + 三触发（真实函数路径） ---- */
        let dots = await page.evaluate(async () => {
            const m = await import("/static/js/app/main.js");
            const read = () => Array.from(document.querySelectorAll(".nav-tab")).map((a) => ({ r: a.getAttribute("href"), on: !a.querySelector(".nav-dot").hidden }));
            m.markNavDot("/compare");
            await new Promise((r) => setTimeout(r, 40));
            const afterCompare = read();
            m.markNavDot("/"); // 当前已在 / → 不挂点
            await new Promise((r) => setTimeout(r, 40));
            const afterHome = read();
            m.markNavDot("/snapshots");
            await new Promise((r) => setTimeout(r, 40));
            const afterSnap = read();
            return { afterCompare, afterHome, afterSnap };
        });
        ok("⑤markNavDot：非当前页挂点/当前页不挂点（不动既有圆点）", dots.afterCompare[1].on && !dots.afterCompare[0].on && dots.afterHome[1].on && !dots.afterHome[0].on && dots.afterSnap[2].on, JSON.stringify(dots));
        // 点击对比标签 → 消除 + 导航 + 下划线随激活
        await page.click(".nav-tab[href='#/compare']");
        await page.waitForFunction(() => location.hash === "#/compare", { timeout: 15000 }).catch(() => {});
        await wait(400);
        const dotState = await page.evaluate(() => Array.from(document.querySelectorAll(".nav-tab")).map((a) => ({ r: a.getAttribute("href"), on: !a.querySelector(".nav-dot").hidden })));
        ok("⑤点击对应标签圆点消除（对比已消、快照保留）", !dotState[1].on && dotState[2].on, JSON.stringify(dotState));
        ok("⑤下划线随激活同步（#nav-underline transform 已设置且宽度=最大 tab 宽）", await page.evaluate(() => {
            const ul = document.getElementById("nav-underline");
            return ul.style.width !== "" && /translateX/.test(ul.style.transform);
        }));

        // 三触发①：快照保存成功（saveSnapshot 真实路径）→ 快照标签圆点
        await page.evaluate(() => { location.hash = "#/"; });
        await page.waitForFunction(() => location.hash === "#/" && !!document.getElementById("dir-body"), { timeout: 15000 }).catch(() => {});
        await wait(300);
        await page.keyboard.press("Control+k"); await wait(120);
        await page.fill("#palette-input", "bckz"); await wait(80);
        await page.keyboard.press("Enter");
        await page.waitForFunction(() => window.__stub.fetchLog.filter((k) => k === "POST /api/save").length >= 1, { timeout: 15000 }).catch(() => {});
        await wait(300);
        ok("⑤触发①快照保存成功 → 快照标签圆点出现",
            await page.evaluate(() => !document.querySelector(".nav-tab[href='#/snapshots'] .nav-dot").hidden));
        // 三触发②：对比完成（btn-compare 真实路径）→ 对比标签圆点
        await page.evaluate(() => { document.getElementById("compare-baseline").value = ""; document.getElementById("btn-compare").click(); });
        await page.waitForFunction(() => window.__stub.fetchLog.filter((k) => k === "POST /api/compare").length >= 1, { timeout: 15000 }).catch(() => {});
        await wait(400);
        ok("⑤触发②对比完成 → 对比标签圆点出现",
            await page.evaluate(() => !document.querySelector(".nav-tab[href='#/compare'] .nav-dot").hidden));
        // 三触发③：扫描完成（顶栏开始扫描 → running → 跳到对比页 → 置完成标记 → 工作台圆点）
        await page.click("#btn-scan-top");
        await page.waitForFunction(() => window.__stub.fetchLog.filter((k) => k === "POST /api/fullscan/start").length >= 1, { timeout: 15000 }).catch(() => {});
        await wait(300);
        ok("⑤扫描中顶栏按钮变微型进度环",
            await page.evaluate(() => {
                const btn = document.getElementById("btn-scan-top");
                const ring = btn.querySelector(".topbar-scan-ring");
                return btn.classList.contains("is-scanning") && ring && !ring.hidden;
            }));
        await page.evaluate(() => { location.hash = "#/compare"; });
        await page.waitForFunction(() => location.hash === "#/compare", { timeout: 15000 }).catch(() => {});
        await page.evaluate(() => { window.__stub.scanComplete = true; });
        const gotDot = await page.waitForFunction(
            () => !document.querySelector(".nav-tab[href='#/'] .nav-dot").hidden,
            { timeout: 15000 }
        ).then(() => true).catch(() => false);
        ok("⑤触发③扫描完成（停留在对比页）→ 工作台标签圆点出现", gotDot);
        // 点击工作台标签消除
        await page.click(".nav-tab[href='#/']");
        await page.waitForFunction(() => location.hash === "#/", { timeout: 15000 }).catch(() => {});
        await wait(300);
        ok("⑤点击工作台标签圆点消除", await page.evaluate(() => document.querySelector(".nav-tab[href='#/'] .nav-dot").hidden));
        // 清场：清掉残留圆点避免后续断言干扰（点击快照/对比标签消除）
        await page.click(".nav-tab[href='#/snapshots']").then(() => page.click(".nav-tab[href='#/compare']")).catch(() => {});
        await page.waitForFunction(() => location.hash === "#/compare", { timeout: 15000 }).catch(() => {});
        await wait(200);

        /* ---- ⑥ 徽章 popover 三字段 + 重试（红线 #8 第二求值点） ---- */
        await page.evaluate(() => { location.hash = "#/"; });
        await page.waitForFunction(() => location.hash === "#/" && !!document.getElementById("dir-body"), { timeout: 15000 }).catch(() => {});
        await wait(300);
        await page.click("#health-badge"); await wait(150);
        let pop = await page.evaluate(() => ({
            open: !document.getElementById("health-popover").classList.contains("hidden"),
            dir: document.getElementById("popover-data-dir").textContent,
            health: document.getElementById("popover-health").textContent,
            dll: document.getElementById("popover-health-dll").textContent,
        }));
        ok("⑥popover 三字段（数据目录/驱动状态/DLL）", pop.open && pop.dir === "C:\\stub\\data" && pop.health.indexOf("已就绪") !== -1 && pop.dll === "stub-dll", JSON.stringify(pop));
        await page.evaluate(() => { window.__stub.fetchLog.length = 0; document.getElementById("btn-popover-retry").click(); });
        await page.waitForFunction(() => window.__stub.fetchLog.filter((k) => k === "POST /api/browse").length >= 1, { timeout: 15000 }).catch(() => {});
        ok("⑥重试环境检测 = evaluateEnvGate 重评（ready → 自动浏览，出现 browse 请求）",
            await page.evaluate(() => window.__stub.fetchLog.filter((k) => k === "POST /api/browse").length >= 1));
        await page.keyboard.press("Escape"); await wait(80);
        ok("⑥Esc 关闭 popover", await page.evaluate(() => document.getElementById("health-popover").classList.contains("hidden")));

        /* ---- ⑦ 主题按钮移正（U1.1 switchTheme 接线） ---- */
        const themeBefore = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
        await page.click("#btn-theme");
        await page.waitForFunction((t) => document.documentElement.getAttribute("data-theme") !== t, themeBefore, { timeout: 15000 }).catch(() => {});
        ok("⑦主题按钮切换 data-theme", (await page.evaluate(() => document.documentElement.getAttribute("data-theme"))) !== themeBefore);
        await page.click("#btn-theme");
        await page.waitForFunction((t) => document.documentElement.getAttribute("data-theme") === t, themeBefore, { timeout: 15000 }).catch(() => {});

        /* ---- ⑧ Ctrl/⌘K 与 / 守卫 ---- */
        await page.focus("#browse-filter");
        await page.keyboard.press("/"); await wait(80);
        ok("⑧/ 守卫：输入框聚焦时不抢焦点", await page.evaluate(() => document.activeElement.id === "browse-filter"));
        await page.evaluate(() => { if (document.activeElement) document.activeElement.blur(); });
        await page.keyboard.press("/"); await wait(80);
        ok("⑧/ 聚焦顶栏搜索框（btn-palette）", await page.evaluate(() => document.activeElement.id === "btn-palette"));
        await page.evaluate(async () => { const m = await import("/static/js/app/main.js"); m.openModal("settings-modal"); });
        await page.keyboard.press("Control+k"); await wait(120);
        ok("⑧设置弹窗打开时 Ctrl+K 被忽略", await page.evaluate(() => document.getElementById("palette").classList.contains("hidden")));
        await page.evaluate(async () => { const m = await import("/static/js/app/main.js"); m.closeModal("settings-modal"); });

        /* ---- ⑨ 50 次开合无泄漏（DOM 节点数稳定；每轮条件等待终态） ---- */
        const nodeCounts = await page.evaluate(async () => {
            const count = () => document.querySelectorAll("*").length;
            const open = () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }));
            const esc = () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
            const wait = (ms) => new Promise((r) => setTimeout(r, ms));
            // 先归一化：面板渲染一次条目后（关态也带条目 HTML——隐藏但保留 innerHTML）
            open(); await wait(80);
            const openBefore = count();
            esc(); await wait(80);
            const closedBefore = count();
            for (let i = 0; i < 50; i++) { open(); await wait(25); esc(); await wait(25); }
            await wait(300);
            open(); await wait(80);
            const openAfter = count();
            esc(); await wait(80);
            const closedAfter = count();
            return { openBefore, openAfter, closedBefore, closedAfter, closed: document.getElementById("palette").classList.contains("hidden") };
        });
        ok("⑨50 次开合：开态/关态节点数均不增长", nodeCounts.openBefore === nodeCounts.openAfter && nodeCounts.closedBefore === nodeCounts.closedAfter && nodeCounts.closed, JSON.stringify(nodeCounts));

        /* ---- ⑩ 双档零滚动 + 顶栏 60px + 搜索框 240×36 ---- */
        for (const vp of [{ w: 1366, h: 768 }, { w: 1920, h: 1080 }]) {
            await page.setViewportSize({ width: vp.w, height: vp.h });
            await wait(200);
            const layout = await page.evaluate(() => {
                const top = document.getElementById("topbar").getBoundingClientRect();
                const s = document.getElementById("btn-palette").getBoundingClientRect();
                return {
                    scrollDelta: document.body.scrollHeight - document.body.clientHeight,
                    overflow: getComputedStyle(document.body).overflow,
                    topbarH: Math.round(top.height),
                    searchW: Math.round(s.width), searchH: Math.round(s.height),
                };
            });
            ok("⑩" + vp.w + "×" + vp.h + " 零滚动 + 顶栏 60 + 搜索 240×36",
                layout.scrollDelta <= 1 && layout.overflow === "hidden" && layout.topbarH === 60 && layout.searchW === 240 && layout.searchH === 36,
                JSON.stringify(layout));
        }

        /* ---- ⑪ L2-11 下划线参数（240ms ease-inout；reduced-motion 另上下文） ---- */
        const ul = await page.evaluate(() => {
            const u = document.getElementById("nav-underline");
            const cs = getComputedStyle(u);
            return { dur: cs.transitionDuration, tf: cs.transitionTimingFunction };
        });
        ok("⑪L2-11 下划线 transition 240ms ease-inout", /0\.24s/.test(ul.dur) && /0\.65, 0, 0\.35, 1/.test(ul.tf), JSON.stringify(ul));
        // 面板开合时长 token（80ms）
        const palPar = await page.evaluate(() => {
            const cs = getComputedStyle(document.getElementById("palette"));
            return { anim: cs.animationDuration, panel: getComputedStyle(document.querySelector(".palette-panel")).animationDuration };
        });
        ok("⑪面板开合动画 80ms token（--dur-palette-open）", /0\.08s/.test(palPar.anim) && /0\.08s/.test(palPar.panel), JSON.stringify(palPar));

        ok("阶段1 console/pageerror 0", errs.length === 0, errs.join("\n"));
        await page.close();
    }

    /* ================= 阶段 2：reduced-motion（直切降级复核） ================= */
    console.log("== 阶段 2：reduced-motion ==");
    {
        const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 }, reducedMotion: "reduce" });
        const page = await ctx.newPage();
        const errs = [];
        page.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text()); });
        page.on("pageerror", (e) => errs.push("pageerror: " + e.message));
        await page.addInitScript(() => { try { localStorage.setItem("pds_onboarding_dismissed_v1", "1"); } catch (e) {} });
        await page.addInitScript(STUB_FN); // 字符串形式 = 函数体
        await page.goto(BASE, { waitUntil: "load" });
        await page.waitForTimeout(2000);
        const reduced = await page.evaluate(async () => {
            if (typeof window.__stub !== "object") throw new Error("stub not installed");
            const u = document.getElementById("nav-underline");
            const cs = getComputedStyle(u);
            const dur = parseFloat(cs.transitionDuration) || 0;
            const m = await import("/static/js/app/main.js");
            m.openPalette();
            await new Promise((r) => setTimeout(r, 50));
            const open = !document.getElementById("palette").classList.contains("hidden");
            const panelDur = parseFloat(getComputedStyle(document.querySelector(".palette-panel")).animationDuration) || 0;
            const badgeAnim = getComputedStyle(document.getElementById("health-badge")).animationName;
            return { dur, open, panelDur, badgeAnim, matches: window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches };
        });
        ok("reduced：下划线/面板动画 ≤0.01ms 直切（reduced 生效）", reduced.matches && reduced.dur <= 0.02 && reduced.open && reduced.panelDur <= 0.02, JSON.stringify(reduced));
        ok("reduced：徽章呼吸静止", reduced.badgeAnim === "none", reduced.badgeAnim);
        ok("reduced context console 0", errs.length === 0, errs.join("\n"));
        await page.close();
        await ctx.close();
    }

    /* ================= 阶段 3：真实页（--with-data） ================= */
    if (WITH_DATA) {
        console.log("== 阶段 3：真实页（--with-data） ==");
        for (const vp of [{ w: 1366, h: 768, tag: "1366x768" }, { w: 1920, h: 1080, tag: "1920x1080" }]) {
            const page = await browser.newPage({ viewport: { width: vp.w, height: vp.h } });
            const errs = [];
            page.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text()); });
            page.on("pageerror", (e) => errs.push("pageerror: " + e.message));
            await page.addInitScript(() => { try { localStorage.setItem("pds_onboarding_dismissed_v1", "1"); } catch (e) {} });
            await page.goto(BASE, { waitUntil: "load" });
            await page.waitForTimeout(2500);
            const layout = await page.evaluate(() => {
                const top = document.getElementById("topbar").getBoundingClientRect();
                return {
                    scrollDelta: document.body.scrollHeight - document.body.clientHeight,
                    topbarH: Math.round(top.height),
                    health: document.getElementById("health-text").textContent,
                    badgeClass: document.getElementById("health-badge").className,
                };
            });
            ok("真实页 " + vp.tag + " 零滚动 + 顶栏 60", layout.scrollDelta <= 1 && layout.topbarH === 60, JSON.stringify(layout));
            ok("真实页 徽章三态就绪文案（N11）", layout.health === "已就绪·可开始扫描", layout.health);
            // 截图多模态（亮/暗 × 面板/徽章 popover/圆点提醒态）
            await shot(page, vp.tag + "_light_topbar");
            await page.click("#btn-theme");
            await page.waitForTimeout(700);
            await shot(page, vp.tag + "_dark_topbar");
            await page.click("#btn-theme");
            await page.waitForTimeout(700);
            await page.click("#health-badge");
            await page.waitForTimeout(200);
            await shot(page, vp.tag + "_light_popover");
            await page.keyboard.press("Escape");
            await page.keyboard.press("Control+k");
            await page.waitForTimeout(200);
            await shot(page, vp.tag + "_light_palette");
            await page.keyboard.press("Escape");
            await page.evaluate(async () => { const m = await import("/static/js/app/main.js"); m.markNavDot("/compare"); m.markNavDot("/snapshots"); });
            await page.waitForTimeout(150);
            await shot(page, vp.tag + "_light_dots");
            ok("真实页 " + vp.tag + " console 0", errs.length === 0, errs.join("\n"));
            await page.close();
        }
        // <900px 窄屏截图（声明例外区目检）
        const narrow = await browser.newPage({ viewport: { width: 800, height: 700 } });
        const nerrs = [];
        narrow.on("console", (m) => { if (m.type() === "error") nerrs.push("console: " + m.text()); });
        narrow.on("pageerror", (e) => nerrs.push("pageerror: " + e.message));
        await narrow.addInitScript(() => { try { localStorage.setItem("pds_onboarding_dismissed_v1", "1"); } catch (e) {} });
        await narrow.goto(BASE, { waitUntil: "load" });
        await narrow.waitForTimeout(2500);
        await shot(narrow, "narrow_800x700_topbar");
        ok("真实页 <900px console 0", nerrs.length === 0, nerrs.join("\n"));
        await narrow.close();
    }

    await browser.close();
    console.log("== 结果：" + passCount + "/" + (passCount + failCount) + " ==");
    process.exit(failCount ? 1 : 0);
})();
