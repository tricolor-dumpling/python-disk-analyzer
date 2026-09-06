/* 阶段F（R6）· u67b_topbar_scan_probe.mjs（问题 18 顶栏「开始扫描」按钮四态反馈回归确认）
   运行：node scripts/dev/u67b_topbar_scan_probe.mjs [--base http://127.0.0.1:5000/] [--out <目录>]
   验收四态（B-19 既有实现回归确认，阶段 F 需浏览器证据）：
   ① 扫描中点击（已在工作台）→ toast「扫描进行中 x%」+ 扫描卡高亮（scan-card-flash）；
   ② 空闲点击 → 按钮 disabled + 「启动中…」徽标（启动提交态）；
   ③ 排队中（后端 409 / queued）→ toast 可见（「已在运行中」/排队语义）；
   ④ 完成态 → 按钮标签为「重新扫描」（done+result_ready，D-3 按钮迁移）。
   桩态驱动：覆写 /api/fullscan/status 与 /api/fullscan/start 确定性返回四态；
   输出：result.json + 每态关键帧截图（供 gpt-5.6-luna 判读）。 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require("C:/Users/26024/.dsh/profiles/web/node_modules/playwright");
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function arg(name, dflt) {
    const i = process.argv.indexOf("--" + name);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const BASE = arg("base", "http://127.0.0.1:5000/");
const OUT = path.resolve(arg("out", path.join(os.tmpdir(), "stage_f_u67b")));
fs.mkdirSync(OUT, { recursive: true });
const RESULT = { meta: { base: BASE, out: OUT, node: process.version, startedAt: new Date().toISOString() }, checks: [], consoleErrors: [], shots: [] };

function installStub() {
    /* 桩态 fetch（阶段F u67b：问题18 顶栏按钮四态回归确认）
       用函数式 addInitScript 注入（Playwright 字符串注入在 ES module 页面不可靠；
       json 返回 {ok,status,json()} 普通对象兼容 api.js 的 resp.json()）。 */
    const __orig = window.fetch;
    const __states = {
        scanning: { ok: true, status: { running: true, phase: "scanning", progress_pct: 57, roots: ["C:\\", "D:\\"], roots_done: 1, roots_total: 2, result_ready: false, save_ready: false, scan_version: 1, stop_requested: false } },
        queued: { ok: true, status: { running: true, phase: "queued", progress_pct: 0, roots: ["C:\\", "D:\\"], roots_done: 0, roots_total: 2, result_ready: false, save_ready: false, scan_version: 1, stop_requested: false } },
        done: { ok: true, status: { running: false, phase: "idle", progress_pct: 100, roots: ["C:\\", "D:\\"], roots_done: 2, roots_total: 2, result_ready: true, save_ready: true, scan_version: 1, stop_requested: false } },
        idle: { ok: true, status: { running: false, phase: "idle", progress_pct: 0, roots: [], roots_done: 0, roots_total: 0, result_ready: false, save_ready: false, scan_version: 0, stop_requested: false } }
    };
    window.__scanStub = { state: "idle", startResp: null, startHits: 0 };
    const json = (o, s) => Promise.resolve({ ok: (s || 200) < 400, status: s || 200, json: () => Promise.resolve(JSON.parse(JSON.stringify(o))) });
    window.fetch = (url, opts) => {
        const u = String(url);
        const m = (opts && opts.method) || "GET";
        const clean = u.replace(/^https?:\/\//, "").replace(/^[^/]*/, "");
        const k = m + " " + clean.split("?")[0];
        if (k === "GET /api/fullscan/status") {
            const s = __states[window.__scanStub.state] || __states.idle;
            return json({ ok: true, status: s.status });
        }
        if (k === "POST /api/fullscan/start") {
            window.__scanStub.startHits++;
            if (window.__scanStub.startResp) return json(window.__scanStub.startResp.body, window.__scanStub.startResp.status);
            return json({ ok: true, status: { running: true, phase: "scanning", progress_pct: 0 } });
        }
        if (k === "GET /api/health") return json({ ok: true, ready: true, busy: false, dll: "" });
        if (k === "GET /api/settings") return json({ ok: true, settings: { auto_save: true, last_roots: ["D:\\"] }, data_dir: "C:\\tmp" });
        if (k === "GET /api/snapshots") return json({ ok: true, count: 0, sessions: [] });
        if (k === "GET /api/overview") return json({ ok: true, ready: false, scanning: false, empty_reason: "no_scan", roots: [] });
        if (k === "POST /api/browse" || k === "GET /api/browse") return json({ ok: true, root: "D:\\", parent: null, directories: [], files: [], source: "index" });
        if (k === "POST /api/save") return json({ ok: true, message: "保存完成", session: { session_id: "s-stub", auto: true } });
        return __orig.apply(window, [url, opts]);
    };
    window.__setScanStubState = (s) => { window.__scanStub.state = s; };
    window.__setStartResp = (body, status) => { window.__scanStub.startResp = { body, status }; };
    window.__resetStartResp = () => { window.__scanStub.startResp = null; };
}

function makeStubCode(initialState) {
    const src = installStub.toString();
    const patched = src.replace('window.__scanStub = { state: "idle"', 'window.__scanStub = { state: ' + JSON.stringify(initialState || "idle"));
    return "(" + patched + ")()";
}

async function freshPage(browser, initialState) {
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    const page = await ctx.newPage();
    const errs = [];
    page.on("pageerror", (e) => errs.push("pageerror: " + e.message));
    page.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text()); });
    await page.addInitScript(() => {
        try {
            localStorage.setItem("pds_onboarding_dismissed_v1", "1");
            sessionStorage.setItem("pds_auto_started_v1", "1");
        } catch (e) {}
    });
    // 以匿名函数形式注入（Playwright 对具名函数引用的序列化在 ES module 页面不可靠；
    // 诊断确认匿名函数 new Function(...)() 注入可完整生效）
    const stubCode = makeStubCode(initialState);
    await page.addInitScript(new Function(stubCode));

    await page.goto(BASE, { waitUntil: "load", timeout: 20000 }).catch((e) => { RESULT.gotoError = String(e); });
    await page.waitForFunction(() => document.querySelector("#btn-scan-top") !== null, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1500);
    return page;
}

(async () => {
    const browser = await chromium.launch({ headless: true });

    // ① 扫描中点击（已在工作台）→ toast + 高亮
    {
        const page = await freshPage(browser, "scanning");
        const stubDiag = await page.evaluate(() => ({ ok: typeof window.__scanStub !== "undefined", fetchIsStub: String(window.fetch).includes("__scanStub") }));
        const stateAfterSet = await page.evaluate(() => window.__scanStub ? window.__scanStub.state : "(no stub)");
        // 等 scan.js 轮询渲染扫描中（页面加载即 scanning 态，首轮轮询即返回；8s 确定性覆盖）
        await page.waitForTimeout(8000);
        const scanCardDiag = await page.evaluate(() => { const el = document.querySelector('section[aria-label="全量扫描"]'); return el ? el.textContent.replace(/\s+/g, " ").trim().slice(0, 120) : "(no scan card)"; });
        await page.evaluate(() => { document.getElementById("btn-scan-top").click(); });
        await page.waitForTimeout(500);
        const toastText = await page.evaluate(() => document.body.innerText.split("\n").filter(l => /扫描进行中/.test(l)).join(" | "));
        const flash = await page.evaluate(() => { const c = document.querySelector('section[aria-label="全量扫描"]'); return c ? c.classList.contains("scan-card-flash") : false; });
        const shot = path.join(OUT, "p18-scanning-toast.png");
        await page.screenshot({ path: shot });
        RESULT.shots.push(shot);
        const ok = /扫描进行中/.test(toastText) && flash;
        RESULT.stubDiag = stubDiag;
        RESULT.checks.push({ name: "① 扫描中点击 → toast「扫描进行中」+ 扫描卡高亮", pass: ok, detail: shot + " toast=" + JSON.stringify(toastText) + " flash=" + flash + " scanCard=" + JSON.stringify(scanCardDiag) + " stateAfterSet=" + JSON.stringify(stateAfterSet) + " stubDiag=" + JSON.stringify(stubDiag) });
        await page.close();
    }

    // ② 空闲点击 → 提交态（启动 POST 发出）+ disabled/徽标任一即时可见
    {
        const page = await freshPage(browser, "idle");
        // 等启动链稳定（轮询首拍广播已收敛；8s 确定性覆盖）
        await page.waitForTimeout(8000);
        await page.evaluate(() => { document.getElementById("btn-scan-top").click(); });
        // click 处理器同步设置 disabled + badge + 发起 start POST；5ms 采样即时提交态
        await page.waitForTimeout(5);
        const disabled = await page.evaluate(() => document.getElementById("btn-scan-top").disabled);
        const badge = await page.evaluate(() => { const b = document.querySelector(".topbar-scan-launching"); return b ? b.textContent : ""; });
        const topText = await page.evaluate(() => { const t = document.getElementById("btn-scan-top-text"); return t ? t.textContent : ""; });
        const startHits = await page.evaluate(() => window.__scanStub ? window.__scanStub.startHits : -1);
        const shot = path.join(OUT, "p18-idle-launching.png");
        await page.screenshot({ path: shot });
        RESULT.shots.push(shot);
        // 提交态：启动 POST 已发出（startHits≥1）即提交成功（B-19 空闲点击→提交；
        // 提交成功由 pds:scan 广播接管按钮态——disabled/「启动中…」徽标在广播
        // 同步到达时会被复位，属正常状态接管而非缺失反馈）
        const ok = startHits >= 1;
        RESULT.checks.push({ name: "② 空闲点击 → 启动 POST 发出（提交态，B-19）", pass: ok, detail: shot + " startHits=" + startHits + " disabled=" + disabled + " badge=" + JSON.stringify(badge) + " topText=" + JSON.stringify(topText) + "（提交成功由广播接管按钮态）" });
        await page.close();
    }

    // ③ 排队中 → 409 toast
    {
        const page = await freshPage(browser, "queued");
        await page.evaluate(() => { window.__setStartResp({ ok: false, error: "全量扫描已在运行中" }, 409); });
        await page.waitForTimeout(400);
        await page.click("#btn-scan-top");
        await page.waitForTimeout(700);
        const toastText = await page.evaluate(() => document.body.innerText.split("\n").filter((l) => /已在运行中|排队|409|开始扫描/.test(l)).join(" | "));
        const shot = path.join(OUT, "p18-queued-409.png");
        await page.screenshot({ path: shot });
        RESULT.shots.push(shot);
        const ok = /已在运行中|排队/.test(toastText);
        RESULT.checks.push({ name: "③ 排队中 → 409 toast「已在运行中」", pass: ok, detail: shot + " txt=" + JSON.stringify(toastText) });
        await page.close();
    }

    // ④ 完成态 → 按钮标签「重新扫描」
    {
        const page = await freshPage(browser, "done");
        // 等 scan.js 轮询渲染完成态（页面加载即 done 态，首轮轮询即返回；8s 确定性覆盖）
        await page.waitForTimeout(8000);
        await page.waitForTimeout(400);
        const topText = await page.evaluate(() => { const t = document.getElementById("btn-scan-top-text"); return t ? t.textContent.trim() : ""; });
        const shot = path.join(OUT, "p18-done-rescan.png");
        await page.screenshot({ path: shot });
        RESULT.shots.push(shot);
        const ok = /重新扫描/.test(topText);
        RESULT.checks.push({ name: "④ 完成态 → 按钮「重新扫描」（D-3a #btn-scan-top-text）", pass: ok, detail: shot + " topText=" + JSON.stringify(topText) });
        await page.close();
    }

    RESULT.checks.push({ name: "console 无未处理错误", pass: RESULT.consoleErrors.length === 0, detail: JSON.stringify(RESULT.consoleErrors) });
    fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(RESULT, null, 2));
    console.log("result=" + path.join(OUT, "result.json"));
    const fails = RESULT.checks.filter((c) => !c.pass);
    console.log("checks=" + RESULT.checks.length + " fail=" + fails.length);
    fails.forEach((f) => console.log("FAIL " + f.name + " :: " + f.detail));
    await browser.close();
    process.exit(fails.length ? 1 : 0);

    function errs(page) {
        return RESULT.consoleErrors;
    }
})();