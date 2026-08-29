/* ============================================================
   UI 2.0（SpaceLens Pro）· U2.4 存储概览卡验收探针
   - 验收口径（手册 §U2.4）：L3-4 参数逐条（sweep 800ms ease-inout + count-up +
     不确定弧 1.2s + hover 外扩/glow）；D15（chips 只切环形数据不切目录）；
     自动跟随/手选锁定（N04）；卡四态（空/载/数据/扫描）；紧凑档 <820px 卡高达标。
   - 策略：确定性状态用页内 fetch 桩（init 注入，先于 main.js 模块求值）；
     D15/arc 数学/跟随锁定均在桩态断言；真实页阶段（--with-scan：扫描运行中
     捕获不确定弧+跟随；--with-data：overview ready 时捕获数据态+零滚动+console 0）。
   - 运行：node scripts/dev/u24_acc_probe.mjs [--base http://127.0.0.1:5000/]
            [--out <截图目录>] [--with-scan] [--with-data]
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
const OUT = arg("out", path.join(os.tmpdir(), "u24_acc_shots"));
const WITH_SCAN = process.argv.indexOf("--with-scan") >= 0;
const WITH_DATA = process.argv.indexOf("--with-data") >= 0;
const SCAN_ONLY = process.argv.indexOf("--scan-only") >= 0; // 跳过桩态阶段，直奔真实扫描态（扫描窗口短时用）
fs.mkdirSync(OUT, { recursive: true });

let passCount = 0, failCount = 0;
function ok(name, cond, detail) {
    if (cond) { passCount++; console.log("  ✔ " + name); }
    else { failCount++; console.log("  ✖ " + name + (detail ? " :: " + detail : "")); }
}
function shot(page, name) {
    return page.screenshot({ path: path.join(OUT, name + ".png"), fullPage: false });
}

/* 页内条件等待（≤timeout ms，真实页 /api/browse 抖动锚） */
const WAIT_FN = `(fn, timeout) => new Promise((resolve) => {
  const end = Date.now() + (timeout || 15000);
  const tick = () => { if (fn()) resolve(true); else if (Date.now() > end) resolve(fn()); else setTimeout(tick, 120); };
  tick();
})`;
/* 安装 window.__wait（页内可用；值 = WAIT_FN 源码） */
async function installWait(page) {
    await page.evaluate((src) => { window.__wait = eval("(" + src + ")"); }, WAIT_FN);
}

/* ---- 桩态 fetch（init 注入；状态经 window.__OV 可变 —— 冒烟与探针共用键集合） ---- */
const STUB_FN = `
window.__OV = {
  mode: "data", // data | empty | scanning
  st: { running: false, roots: ["C:\\\\", "D:\\\\"], roots_done: 2, roots_total: 2,
        current_root: null, error: null, result_ready: true, save_ready: true,
        progress_pct: 100, scan_version: 1 },
  sample: { ok: true, ready: true, roots: [
    { root: "C:\\\\", total: 1200000, total_human: "1.14 MB", index_ready: true, index_valid: true,
      directories: [{ name: "Windows", path: "C:\\\\Windows", size: 900000, size_human: "879.11 KB" }],
      files: [], directory_count: 100, file_count: 1000, record_count: 1100, completed_at: "2026-08-28T10:00:00" },
    { root: "D:\\\\", total: 4800000, total_human: "4.58 MB", index_ready: true, index_valid: true,
      directories: [{ name: "data", path: "D:\\\\data", size: 3000000, size_human: "2.86 MB" }],
      files: [], directory_count: 200, file_count: 2000, record_count: 2200, completed_at: "2026-08-28T10:00:00" }
  ], completed_at: "2026-08-28T10:00:00" }
};
window.fetch = function (url, options) {
  options = options || {};
  const key = (options.method || "GET").toUpperCase() + " " + String(url).split("?")[0];
  const json = (o, s) => Promise.resolve({ ok: (s || 200) < 400, status: s || 200,
    json: () => Promise.resolve(JSON.parse(JSON.stringify(o))) });
  if (key === "GET /api/overview") {
    if (window.__OV.mode === "empty") return json({ ok: true, ready: false, scanning: false, empty_reason: "no_scan", roots: [] });
    if (window.__OV.mode === "scanning") return json({ ok: true, ready: false, scanning: true, empty_reason: "scanning",
      roots: [], progress_pct: window.__OV.st.progress_pct, current_root: window.__OV.st.current_root,
      roots_done: window.__OV.st.roots_done, roots_total: window.__OV.st.roots_total });
    return json(window.__OV.sample);
  }
  if (key === "GET /api/fullscan/status") return json({ ok: true, status: JSON.parse(JSON.stringify(window.__OV.st)) });
  const m = {
    "GET /api/health": { ok: true, ready: true, dll: "stub", message: "Everything 已就绪" },
    "GET /api/settings": { ok: true, settings: { auto_save: false, last_roots: ["D:\\\\"] }, data_dir: "C:\\\\stub", snapshots_dir: "C:\\\\stub" },
    "GET /api/snapshots": window.__OV.snapEmpty
      ? { ok: true, sessions: [], count: 0 }
      : { ok: true, sessions: [ { session_id: "s-20260824-000000-aabbccdd", auto: false, machine_guid: "aabbccdd", created_at: "2026-08-24T10:00:00", roots: { "D:\\\\": { root: "D:\\\\", snapshot: "D_20260824_100000.snap.gz", snapshot_path: "C:\\\\fake\\\\snapshots\\\\D_20260824_100000.snap.gz", skipped: false } } } ], count: 1 },
    "POST /api/browse": { ok: true, root: "D:\\\\", parent: null, directories: [], files: [], total_dirs: 0, total_files: 0 },
    "POST /api/compare": { ok: true, report: { root: "D:\\\\", total_baseline: 16000, total_current: 15990, delta_total: -10, truncated: false, legacy_count: 0, rows: [] } },
  };
  return m[key] ? json(m[key]) : json({ ok: true });
};
`;

(async () => {
    const browser = await chromium.launch();

    /* ================= 阶段 1：桩态四态 + D15 + 跟随锁定 + 紧凑档 ================= */
    console.log("== 阶段 1：桩态存储卡 ==");
    if (!SCAN_ONLY) {
        const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
        const errs = [];
        page.on("pageerror", (e) => errs.push("pageerror: " + e.message));
        page.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text()); });
        await page.addInitScript(STUB_FN);
        await page.goto(BASE, { waitUntil: "domcontentloaded" });
        await installWait(page);
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));

        /* ---- 数据态就位 ---- */
        const dataReady = await page.evaluate(async () => {
            const w = (ms) => new Promise((r) => setTimeout(r, ms));
            const okChips = await window.__wait(() => document.querySelectorAll("#overview-chips .chip").length >= 2, 8000);
            await w(900); // sweep 800ms 收束
            const arc = document.querySelector("#overview-donut .donut-arc");
            const dash = parseFloat(getComputedStyle(arc).strokeDasharray) || 0;
            return {
                okChips,
                dash,
                expect: 2 * Math.PI * 52 * (1200000 / (1200000 + 4800000)),
                sub: document.querySelector("#overview-donut .donut-sub").textContent,
                center: document.querySelector("#overview-donut .donut-value").textContent,
                legend: Array.from(document.querySelectorAll("#overview-legend .donut-legend-value")).map((e) => e.textContent),
                meta: document.getElementById("overview-meta").textContent,
            };
        });
        ok("数据态：chips ≥2 且默认激活首盘", dataReady.okChips && await page.evaluate(() => document.querySelector("#overview-chips .chip.is-active").getAttribute("data-root") === "C:\\"));
        ok("数据态：弧长 = 环比 20%（C 盘 1200000/6000000）", Math.abs(dataReady.dash - dataReady.expect) < 4,
           "dash=" + dataReady.dash.toFixed(1) + " expect=" + dataReady.expect.toFixed(1));
        ok("数据态：中心 = C 盘已用 1.14 MB（count-up 终值）", dataReady.center === "1.14 MB", dataReady.center);
        const legendInfo = await page.evaluate(() => ({
            labels: Array.from(document.querySelectorAll("#overview-legend .donut-legend-label")).map((e) => e.textContent.trim()),
            values: Array.from(document.querySelectorAll("#overview-legend .donut-legend-value")).map((e) => e.textContent),
        }));
        ok("数据态：图例两行（已使用/全部盘累计，纯静态）",
           legendInfo.labels.join("|") === "已使用|全部盘累计" && legendInfo.values.length === 2,
           JSON.stringify(legendInfo));
        ok("数据态：meta = 最近扫描", /最近扫描/.test(dataReady.meta), dataReady.meta);
        await shot(page, "1-data-1366x768-light");

        /* ---- D15：chips 点击只切环形数据 → 0 次 /api/browse；浏览此盘 → 恰 1 次 ---- */
        // 包一层调用记录（页面已有 stub fetch）
        await page.evaluate(() => {
            const orig = window.fetch;
            window.__calls = [];
            window.fetch = (u, o) => { window.__calls.push(String(u)); return orig(u, o); };
        });
        const chips = await page.$$("#overview-chips .chip");
        await chips[1].click();
        await page.evaluate(async () => { await window.__wait(() => document.querySelector("#overview-chips .chip.is-active").getAttribute("data-root") === "D:\\", 3000); });
        const afterChip = await page.evaluate(() => ({
            browses: window.__calls.filter((u) => u.indexOf("/api/browse") !== -1).length,
            sub: document.querySelector("#overview-donut .donut-sub") && document.querySelector("#overview-donut .donut-sub").textContent,
            legend0: (document.querySelector("#overview-legend .donut-legend-value") || {}).textContent || "",
        }));
        ok("D15：chips 点击 0 次 /api/browse（只切环形数据）", afterChip.browses === 0, "browses=" + afterChip.browses);
        ok("D15：环形中心/图例切到所选盘 D:\\", afterChip.sub === "D:\\" && afterChip.legend0.indexOf("4.58 MB") !== -1,
           afterChip.sub + " / " + afterChip.legend0);
        await page.waitForTimeout(400);
        const browseCount = await page.evaluate(() => window.__calls.filter((u) => u.indexOf("/api/browse") !== -1).length);
        await page.click("#btn-overview-browse");
        await page.evaluate(async () => { await window.__wait(() => window.__calls.filter((u) => u.indexOf("/api/browse") !== -1).length === 1, 3000); });
        const browseAfter = await page.evaluate(() => window.__calls.filter((u) => u.indexOf("/api/browse") !== -1).length);
        ok("「浏览此盘」= 唯一跳转入口：恰 1 次 /api/browse（此前 0）", browseAfter === browseCount + 1, browseAfter + " vs " + browseCount);

        /* ---- hover 外扩/glow（真实指针命中描边：arc 中点坐标 → native mouseenter） ---- */
        const mid = await page.evaluate(() => {
            const box = document.querySelector("#overview-donut .donut-box").getBoundingClientRect();
            const arc = document.querySelector("#overview-donut .donut-arc");
            const dash = parseFloat(getComputedStyle(arc).strokeDasharray) || 0;
            const pct = Math.min(1, dash / (2 * Math.PI * 52));
            const r = (52 / 120) * box.width;
            const ang = ((-90 + (pct * 360) / 2) * Math.PI) / 180;
            return { x: box.left + box.width / 2 + r * Math.cos(ang), y: box.top + box.height / 2 + r * Math.sin(ang), pct };
        });
        await page.mouse.move(mid.x, mid.y);
        await page.waitForTimeout(250); // 过渡收束（--dur-2 200ms）
        const hover = await page.evaluate(() => {
            const box = document.querySelector("#overview-donut .donut-box");
            const g = document.querySelector("#overview-donut .donut-arc-g");
            return { cls: box.className.includes("is-hover"), transform: getComputedStyle(g).transform, pct: null };
        });
        ok("hover：弧段外扩态生效（is-hover + scale 变换）", hover.cls && hover.transform !== "none", JSON.stringify({ cls: hover.cls, transform: hover.transform }));
        await page.mouse.move(10, 10); // 移出

        /* ---- 阶段 1b：迷你卡（N06 条目 + 全部会话折叠 + 最近对比摘要 + 迷你空态） ---- */
        await page.evaluate(() => {
            const rail = document.querySelector(".side-rail");
            if (rail) rail.scrollTop = rail.scrollHeight;
        });
        await page.waitForTimeout(200);
        const miniEntry = await page.evaluate(() => {
            const e = document.querySelector("#snapshot-mini-entry");
            return e ? e.textContent.replace(/\s+/g, " ").trim() : "";
        });
        ok("N06：迷你卡显示最近一份（时间 + 自动/手动 + 盘符）", /2026-08-24/.test(miniEntry) && /手动/.test(miniEntry) && /D:/.test(miniEntry), miniEntry.slice(0, 60));
        const compareMiniEmpty = await page.evaluate(() => String(document.querySelector("#compare-mini-body").textContent || "").replace(/\s+/g, " ").trim());
        ok("最近对比：空态引导文案（还没有对比记录）", /还没有对比记录/.test(compareMiniEmpty), compareMiniEmpty.slice(0, 50));
        await shot(page, "10-mini-cards");

        // 全部会话折叠区（默认收起 → 展开可见完整列表）
        const collBefore = await page.evaluate(() => document.getElementById("snapshot-mini-list").hidden);
        await page.click("#btn-snapshot-expand");
        await page.waitForTimeout(150);
        const collAfter = await page.evaluate(() => ({
            hidden: document.getElementById("snapshot-mini-list").hidden,
            items: document.querySelectorAll("#snapshot-list .session-item").length,
        }));
        ok("全部会话：默认收起、点击展开（1 会话条目）", collBefore === true && collAfter.hidden === false && collAfter.items === 1,
           JSON.stringify(collAfter));
        await shot(page, "11-snapshots-expanded");

        // 最近对比摘要（compare 桩 → lastSummary → 迷你卡 ▲/▼ + 数值）
        await page.evaluate(() => {
            document.getElementById("compare-baseline").value = "C:\\\\fake\\\\old.snap.gz";
        });
        await page.click("#btn-compare");
        await page.evaluate(async () => {
            await window.__wait(() => document.querySelector("#compare-mini-body .compare-mini-delta") !== null, 8000);
        });
        const cmpMini = await page.evaluate(() => ({
            delta: (document.querySelector("#compare-mini-body .compare-mini-delta") || {}).textContent || "",
            line: (document.querySelector("#compare-mini-body .compare-mini-item") || {}).textContent || "",
        }));
        ok("最近对比：摘要显示 ▲/▼ + 带符号变化量（-10 → ▼）",
           /▼/.test(cmpMini.delta) && /-/.test(cmpMini.delta) && /→/.test(cmpMini.line),
           JSON.stringify(cmpMini));
        await page.evaluate(() => { const rail = document.querySelector(".side-rail"); if (rail) rail.scrollTop = rail.scrollHeight; });
        await page.waitForTimeout(150);
        await shot(page, "12-compare-mini-summary");

        // 快照迷你空态（N06）：走真实 refreshSnapshots 路径（空 sessions → 工具行隐藏但 id 保留）
        await page.evaluate(() => { window.__OV.snapEmpty = true; });
        await page.evaluate(async () => {
            const ss = await import("/static/js/app/pages/snapshots.js");
            await ss.refreshSnapshots();
        });
        const miniEmpty = await page.evaluate(() => ({
            text: String(document.querySelector("#snapshot-mini-entry").textContent || "").replace(/\s+/g, " ").trim(),
            toolsHidden: document.getElementById("snapshot-mini-tools").hidden,
            undoPresent: !!document.getElementById("btn-undo-save"),
        }));
        ok("N06 空态：文案 + 工具行隐藏（ids 保留）", /还没有快照/.test(miniEmpty.text) && miniEmpty.toolsHidden === true && miniEmpty.undoPresent,
           JSON.stringify(miniEmpty));
        await shot(page, "13-mini-empty");
        // 恢复会话渲染（紧凑档断言依赖真实条目形态）
        await page.evaluate(() => { window.__OV.snapEmpty = false; });
        await page.evaluate(async () => {
            const ss = await import("/static/js/app/pages/snapshots.js");
            await ss.refreshSnapshots();
        });

        /* ---- 扫描态：不确定弧 + 自动跟随 + 手选锁定（N04） ---- */
        await page.evaluate(() => {
            window.__OV.mode = "scanning";
            window.__OV.st.running = true;
            window.__OV.st.current_root = "C:\\";
            window.__OV.st.progress_pct = 37;
            window.__OV.st.roots_done = 0;
            window.__OV.st.result_ready = false;
        });
        await page.click("#btn-overview-refresh");
        // 触发轮询链（idle 启动后无定时器；schedulePollFullscan 为 scan.js 导出）
        await page.evaluate(async () => {
            const s = await import("/static/js/app/components/scan.js");
            s.schedulePollFullscan();
        });
        await page.evaluate(async () => {
            await window.__wait(() => document.querySelector("#overview-donut .donut-box.is-indet") !== null, 5000);
            await window.__wait(() => document.querySelectorAll("#overview-chips .chip").length >= 2, 5000); // poll ≤1s 后 chips 就位
        });
        const scan1 = await page.evaluate(() => ({
            indet: !!document.querySelector("#overview-donut .donut-box.is-indet"),
            sub: document.querySelector("#overview-donut .donut-sub").textContent,
            center: document.querySelector("#overview-donut .donut-value").textContent,
            active: document.querySelector("#overview-chips .chip.is-active") && document.querySelector("#overview-chips .chip.is-active").getAttribute("data-root"),
            browseDisabled: document.getElementById("btn-overview-browse").disabled,
            meta: document.getElementById("overview-meta").textContent,
        }));
        ok("扫描态：不确定旋转弧 + 中心 % + 副行当前盘", scan1.indet && /%/.test(scan1.center) && scan1.sub === "C:\\",
           JSON.stringify(scan1));
        ok("扫描态：chips 自动跟随 current_root（C:\\ 激活）", scan1.active === "C:\\", scan1.active);
        ok("扫描态：未完成盘「浏览此盘」置灰", scan1.browseDisabled === true);
        ok("扫描态：meta 扫描中文案", /扫描中/.test(scan1.meta), scan1.meta);
        await shot(page, "2-scanning-1366x768-light");

        // 自动跟随：current_root → D:\（roots_done 0 → D 未完成；跟随高亮应移动）
        await page.evaluate(() => { window.__OV.st.current_root = "D:\\"; });
        await page.evaluate(async () => { await window.__wait(() => {
            const c = document.querySelector("#overview-chips .chip.is-active");
            return c && c.getAttribute("data-root") === "D:\\";
        }, 5000); });
        const follow = await page.evaluate(() => ({
            active: document.querySelector("#overview-chips .chip.is-active").getAttribute("data-root"),
            sub: document.querySelector("#overview-donut .donut-sub").textContent,
        }));
        ok("N04：自动跟随 —— current_root 切换后 chips/中心跟随 D:\\", follow.active === "D:\\" && follow.sub === "D:\\", JSON.stringify(follow));

        // 手选锁定：点 C:\ chip（第 1 个）→ current_root 再切 D:\ → 保持 C:\（本扫描期锁定）
        const lockChip = (await page.$$("#overview-chips .chip"))[0];
        await lockChip.click();
        await page.evaluate(() => { window.__OV.st.current_root = "D:\\"; });
        await page.waitForTimeout(2200); // ≥2 个轮询周期
        const lock = await page.evaluate(() => ({
            active: document.querySelector("#overview-chips .chip.is-active").getAttribute("data-root"),
            sub: document.querySelector("#overview-donut .donut-sub").textContent,
            center: document.querySelector("#overview-donut .donut-value").textContent,
        }));
        ok("N04：手选锁定 —— 用户点选 C:\\ 后不再自动跟随", lock.active === "C:\\" && lock.sub === "C:\\",
           JSON.stringify(lock));
        ok("N04：手选后中心仍随轮询进度更新（% 并 count-up）", /%/.test(lock.center), lock.center);

        // 扫描结束（无 result_ready 的收尾边沿）→ 回到 empty 态（stub overview=empty）
        await page.evaluate(() => {
            window.__OV.st.running = false;
            window.__OV.st.result_ready = false;
            window.__OV.mode = "empty";
        });
        await page.evaluate(async () => { await window.__wait(() => !document.querySelector("#overview-donut .donut-box.is-indet"), 8000); });
        const afterScan = await page.evaluate(() => ({
            empty: !!document.querySelector("#overview-roots .overview-empty"),
            text: document.querySelector("#overview-roots .overview-empty").textContent,
        }));
        ok("扫描结束：退出扫描态 → 空态（无结果收尾）", afterScan.empty && /还没有空间索引/.test(afterScan.text), afterScan.text);
        await shot(page, "3-empty-1366x768-light");

        /* ---- 空态文案（6.5 未扫描） ---- */
        await page.evaluate(() => { window.__OV.mode = "empty"; });
        await page.click("#btn-overview-refresh");
        await page.evaluate(async () => { await window.__wait(() => document.querySelector("#overview-roots .overview-empty") !== null, 5000); });
        const empty = await page.evaluate(() => document.querySelector("#overview-roots .overview-empty").textContent);
        ok("空态：定稿 6.5 文案（还没有空间索引 + 引导）", /还没有空间索引/.test(empty) && /全量扫描/.test(empty), empty.trim().slice(0, 40));

        /* ---- 紧凑档（<820px 高）卡高达标（定稿 3.3：环形 160→112 / padding 收 / 迷你卡单行） ---- */
        await page.evaluate(() => { window.__OV.mode = "data"; });
        await page.click("#btn-overview-refresh");
        await page.evaluate(async () => { await window.__wait(() => document.querySelectorAll("#overview-chips .chip").length >= 2, 5000); });
        await page.waitForTimeout(900);
        const compact = await page.evaluate(() => {
            const donut = document.querySelector("#overview-donut .donut-box").getBoundingClientRect();
            const panel = document.getElementById("overview-panel").getBoundingClientRect();
            const miniSub = document.querySelector(".snapshot-mini-sub");
            const cardPad = getComputedStyle(document.getElementById("overview-panel")).padding;
            return { donut: Math.round(donut.width), panel: Math.round(panel.height), pad: cardPad,
                     miniSubHidden: !miniSub || miniSub.offsetParent === null,
                     bodyScroll: document.body.scrollHeight - document.body.clientHeight,
                     railScroll: (() => { const rail = document.querySelector(".side-rail"); return rail ? rail.scrollHeight - rail.clientHeight : -1; })() };
        });
        ok("紧凑档：环形图 112px（160→112）", compact.donut === 112, "donut=" + compact.donut);
        ok("紧凑档：卡内 padding 收为 10/12", /10px/.test(compact.pad) && /12px/.test(compact.pad), compact.pad);
        ok("紧凑档：快照迷你卡单行（sub 隐藏）", compact.miniSubHidden);
        ok("紧凑档：body 零滚动（窄高内滚归面板）", compact.bodyScroll <= 1, "Δ=" + compact.bodyScroll);
        ok("紧凑档：卡自身高度 ≤ 面板 66%（目检参考）", compact.panel <= 768 * 0.45, "panel=" + compact.panel);
        console.log("  -（参考）紧凑档右栏内滚量 = " + compact.railScroll + "px（过渡期 5 卡，§3.4 面板内滚允许；U3.3/U3.4 迁走旧卡后回 <520px 预算）");
        await shot(page, "4-compact-1366x768-data");

        /* ---- 宽档 1920×1080 + 暗色 + 窄屏 ---- */
        await page.setViewportSize({ width: 1920, height: 1080 });
        await page.waitForTimeout(200);
        await shot(page, "5-data-1920x1080-light");
        const w1080 = await page.evaluate(() => ({
            donut: Math.round(document.querySelector("#overview-donut .donut-box").getBoundingClientRect().width),
            bodyScroll: document.body.scrollHeight - document.body.clientHeight,
        }));
        ok("宽档：环形 160px 常规档", w1080.donut === 160, "donut=" + w1080.donut);
        ok("宽档：body 零滚动", w1080.bodyScroll <= 1, "Δ=" + w1080.bodyScroll);

        await page.evaluate(async () => {
            const m = await import("/static/js/app/main.js");
            m.switchTheme("dark");
        });
        await page.waitForTimeout(500); // VT 450ms 收束
        await shot(page, "6-data-1366x768-dark");
        const dark = await page.evaluate(() => ({
            theme: document.documentElement.getAttribute("data-theme"),
            gradFrom: getComputedStyle(document.querySelector("#overview-donut .donut-grad-from")).stopColor,
        }));
        ok("暗色：data-theme=dark 且渐变 stop 取暗色 token", dark.theme === "dark" && /rgb/.test(dark.gradFrom), JSON.stringify(dark));

        await page.setViewportSize({ width: 800, height: 1100 });
        await page.waitForTimeout(300);
        await shot(page, "7-data-800-narrow");
        ok("窄屏 <900px：存储卡可用（chips 仍在）", await page.evaluate(() => document.querySelectorAll("#overview-chips .chip").length >= 2));

        ok("桩态阶段 console/pageerror 0", errs.length === 0, errs.join(" | "));
        await page.close();
    }

    /* ================= 阶段 2：真实页——扫描运行中（--with-scan / --scan-only） ================= */
    if (WITH_SCAN || SCAN_ONLY) {
        console.log("== 阶段 2：真实页扫描态 ==");
        const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
        const errs = [];
        page.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text()); });
        page.on("pageerror", (e) => errs.push("pageerror: " + e.message));
        await page.goto(BASE, { waitUntil: "domcontentloaded" });
        await installWait(page);
        const scanning = await page.evaluate(async () => {
            const w = (ms) => new Promise((r) => setTimeout(r, ms));
            const okIndet = await window.__wait(() => document.querySelector("#overview-donut .donut-box.is-indet") !== null, 15000);
            const st = await fetch("/api/fullscan/status").then((r) => r.json());
            // chips 补渲染随 pds:scan 轮询（≤1s）；真实扫描首秒可能由 overview 扫描载荷独占
            await window.__wait(() => document.querySelector("#overview-chips .chip.is-active") !== null, 6000);
            await w(400);
            return {
                okIndet, running: st.status.running,
                sub: document.querySelector("#overview-donut .donut-sub") && document.querySelector("#overview-donut .donut-sub").textContent,
                active: document.querySelector("#overview-chips .chip.is-active") && document.querySelector("#overview-chips .chip.is-active").getAttribute("data-root"),
                meta: document.getElementById("overview-meta") && document.getElementById("overview-meta").textContent,
            };
        });
        ok("真实扫描：不确定弧出现", scanning.okIndet);
        ok("真实扫描：跟随 current_root（sub/chips）", !scanning.running || (scanning.sub && scanning.active),
           JSON.stringify(scanning));
        await shot(page, "8-real-scanning-1366x768");
        ok("真实扫描：console/pageerror 0（settings 500 为环境注记豁免项）",
           errs.filter((e) => e.indexOf("/api/settings") === -1).length === 0, errs.join(" | "));
        await page.close();
    }

    /* ================= 阶段 3：真实页——数据态（--with-data） ================= */
    if (WITH_DATA) {
        console.log("== 阶段 3：真实页数据态 ==");
        const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
        const errs = [];
        page.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text()); });
        page.on("pageerror", (e) => errs.push("pageerror: " + e.message));
        await page.goto(BASE, { waitUntil: "domcontentloaded" });
        await installWait(page);
        const data = await page.evaluate(async () => {
            const w = (ms) => new Promise((r) => setTimeout(r, ms));
            const okChips = await window.__wait(() => document.querySelectorAll("#overview-chips .chip").length >= 1, 15000);
            await w(900);
            return {
                okChips,
                center: document.querySelector("#overview-donut .donut-value") && document.querySelector("#overview-donut .donut-value").textContent,
                sub: document.querySelector("#overview-donut .donut-sub") && document.querySelector("#overview-donut .donut-sub").textContent,
                chips: document.querySelectorAll("#overview-chips .chip").length,
                meta: document.getElementById("overview-meta") && document.getElementById("overview-meta").textContent,
                bodyScroll: document.body.scrollHeight - document.body.clientHeight,
            };
        });
        ok("真实数据态：chips 渲染", data.okChips && data.chips >= 1, "chips=" + data.chips);
        ok("真实数据态：中心数字/副行/就绪文案", data.center && data.sub && /(<index|最近扫描)/.test(data.meta),
           JSON.stringify(data));
        ok("真实数据态：body 零滚动", data.bodyScroll <= 1, "Δ=" + data.bodyScroll);
        await shot(page, "9-real-data-1366x768");
        ok("真实数据态：console/pageerror 0（settings 500 豁免）",
           errs.filter((e) => e.indexOf("/api/settings") === -1).length === 0, errs.join(" | "));
        await page.close();
    }

    await browser.close();
    console.log("== 结果：PASS " + passCount + " / FAIL " + failCount + "（截图目录 " + OUT + "） ==");
    process.exit(failCount ? 1 : 0);
})();
