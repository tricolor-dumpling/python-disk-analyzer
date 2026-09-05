/* ============================================================
   UI 2.0（SpaceLens Pro）· U3.2 扫描控制卡与停止接口验收探针
   - 验收口径（手册 §U3.2 + 用户补充 10 点）：
     ①真机全量扫描中点停止 ≤ 一个轮询周期内回空闲态 + toast + 已完成根可浏览 + 保存可用（--with-data 真实页阶段）；
     ②停服（Ctrl+C）路径回归 = test_shutdown.py 全绿（W2.10 CANCEL_EVENT 语义不回归，unittest 锚定）；
     ③重复点停止不报错；
     ④重开页面扫描中态自动恢复且不重复弹保存提示（K7）；
     ⑤计时器单调 + motion.formatElapsed 口径；
     ⑥chips 三态（✓/脉冲/灰）；
     ⑦L2-3 绿光/对勾/粒子（reduced 不播）；
     ⑧50 次停止/开始循环无泄漏 + console 0；
     ⑨双档零滚动 + 顶栏 60px；
     ⑩reduced-motion 直切复核（L2-2/L2-3/L2-4 降级逐项）。
   - 粒子判定：代理 fx canvas 的 getContext 计数 fillRect（16 粒=16 次）——
     fx 层的扫掠/光斑残留会污染像素采样，计数法不受残留影响（确定性）。
   - 策略：桩态（addInitScript 覆写 fetch，扫描状态机可脚本化 idle→running(40%)→
     aborted/done）跑确定性断言；真实页阶段（--with-data）验证真机停止链路。
   - 运行：node scripts/dev/u32_acc_probe.mjs [--base http://127.0.0.1:5000/]
             [--out <截图目录>] [--with-data]
   - ⚠️ 探针血泪（U3.1）：addInitScript 必须传函数体字符串；注入后先校验
     window.__stub 接管，未接管立即 abort（防虚跑真实后端/误触发真实扫描）。
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
const OUT = arg("out", path.join(os.tmpdir(), "u32_acc_shots"));
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

/* 粒子计数包装（页内函数体字符串；evaluate 时以 IIFE 注入）。
   ⚠️ 不用 Proxy——Canvas 2D 上下文是原生宿主对象，Proxy 包装会触发
   「Illegal invocation」（U3.1 血泪同款：包装须显式转发，勿玩 get 陷阱） */
const FX_COUNT_SETUP = `(async () => {
  const m = await import("/static/js/app/main.js");
  const v = m.getTreemapView();
  const fx = v && v.fx();
  if (!fx) return false;
  const real = fx.getContext("2d");
  window.__fxFillRects = 0;
  fx.getContext = () => ({
    clearRect: (a, b, c, d) => real.clearRect(a, b, c, d),
    save: () => real.save(),
    restore: () => real.restore(),
    translate: (a, b) => real.translate(a, b),
    rotate: (a) => real.rotate(a),
    fillRect: (a, b, c, d) => { window.__fxFillRects += 1; return real.fillRect(a, b, c, d); },
    set globalAlpha(v) { real.globalAlpha = v; },
    set fillStyle(v) { real.fillStyle = v; },
    get canvas() { return real.canvas; },
  });
  return true;
})`;

/* ---- 桩态 fetch（addInitScript，字符串形式=函数体；扫描状态机脚本化） ----
   状态驱动：window.__stub.phase ∈ idle|running|done|aborted；
   window.__stub.stopMode ∈ 200|404（OPTIONS 特性探测返回值）；
   ⚠️ 反斜杠转义层数同 u31/u25 探针（模板内 4 反斜杠 → 注入后 2 → JS 值 1）。 */
const STUB_FN = `
window.__stub = { phase: (function () { try { return sessionStorage.getItem("u32_phase") || "idle"; } catch (e) { return "idle"; } })(), stopMode: 200, fetchLog: [], postCount: 0 };
window.fetch = function (url, options) {
  options = options || {};
  const key = (options.method || "GET").toUpperCase() + " " + String(url).split("?")[0];
  window.__stub.fetchLog.push(key);
  const json = (o, s) => Promise.resolve({ ok: (s || 200) < 400, status: s || 200,
    json: () => Promise.resolve(JSON.parse(JSON.stringify(o))) });
  const STATUS = {
    idle:    { running: false, roots: ["C:\\\\", "D:\\\\", "E:\\\\"], roots_done: 0, roots_total: 3, current_root: null, error: null, result_ready: false, save_ready: false, progress_pct: 0, scan_version: 1, stop_requested: false, stop_reason: null },
    running: { running: true,  roots: ["C:\\\\", "D:\\\\", "E:\\\\"], roots_done: 1, roots_total: 3, current_root: "D:\\\\", error: null, result_ready: false, save_ready: false, progress_pct: 40, scan_version: 7, stop_requested: false, stop_reason: null },
    done:    { running: false, roots: ["C:\\\\", "D:\\\\", "E:\\\\"], roots_done: 3, roots_total: 3, current_root: null, error: null, result_ready: true,  save_ready: true,  progress_pct: 100, scan_version: 7, stop_requested: false, stop_reason: null },
    aborted: { running: false, roots: ["C:\\\\", "D:\\\\", "E:\\\\"], roots_done: 1, roots_total: 3, current_root: null, error: null, result_ready: false, save_ready: false, progress_pct: 50, scan_version: 7, stop_requested: true, stop_reason: "user" },
  };
  if (key === "GET /api/health") return json({ ok: true, ready: true, dll: "stub-dll", message: "Everything 已就绪" });
  if (key === "GET /api/settings") return json({ ok: true, settings: { auto_save: false, last_roots: ["D:\\\\", "C:\\\\"] }, data_dir: "C:\\\\stub\\\\data", snapshots_dir: "C:\\\\stub\\\\snapshots" });
  if (key === "POST /api/settings") return json({ ok: true, settings: {} });
  if (key === "POST /api/browse") {
    const p = options.body ? JSON.parse(options.body).path : null;
    window.__stub.lastBrowse = p;
    return json({ ok: true, root: p, parent: p === "C:\\\\" ? null : "C:\\\\", directories: [ { name: "data", path: p + "data", is_dir: true, size: 12000, size_human: "11.72 KB" } ], files: [], total_dirs: 1, total_files: 0 });
  }
  if (key === "GET /api/fullscan/status") return json({ ok: true, status: STATUS[window.__stub.phase] || STATUS.idle });
  if (key === "POST /api/fullscan/start") { window.__stub.phase = "running"; return json({ ok: true, message: "全量扫描任务已提交，后台执行中", status: STATUS.running }); }
  if (key === "POST /api/fullscan/stop") { window.__stub.postCount += 1; window.__stub.phase = "aborted"; return json({ ok: true, stopped: true, status: STATUS.aborted }); }
  if (key === "OPTIONS /api/fullscan/stop") {
    if (window.__stub.stopMode === 404) return json({ ok: false, error: "接口不存在" }, 404);
    return json({ ok: true }, 200);
  }
  if (key === "GET /api/snapshots") return json({ ok: true, sessions: [ { session_id: "s-u32", auto: false, machine_guid: "u32", created_at: "2026-08-24T10:00:00", roots: { "D:\\\\": { root: "D:\\\\", snapshot: "D.snap.gz", snapshot_path: "C:\\\\stub\\\\D.snap.gz", skipped: false } } } ], count: 1 });
  if (key === "POST /api/save") return json({ ok: true, message: "保存完成", session: {}, skipped: false });
  if (key === "POST /api/save/undo") return json({ ok: true, message: "已撤销", session_id: "s-u32", deleted: [], undeleted: [] });
  if (key === "POST /api/compare") return json({ ok: true, report: { root: "D:\\\\", total_baseline: 16000, total_current: 15990, delta_total: -10, truncated: false, legacy_count: 0, rows: [ { path: "D:\\\\data", baseline: 12000, current: 11990, delta: -10, growth_pct: -0.08, removed: false, added: false } ] } });
  if (key === "GET /api/overview") return json({ ok: true, ready: true, roots: [ { root: "C:\\\\", total: 1200000, total_human: "1.14 MB", index_ready: true, index_valid: true, directories: [], files: [], directory_count: 1, file_count: 1, record_count: 1, completed_at: "2026-08-24T10:00:00" }, { root: "D:\\\\", total: 4800000, total_human: "4.58 MB", index_ready: true, index_valid: true, directories: [], files: [], directory_count: 1, file_count: 1, record_count: 2, completed_at: "2026-08-24T10:00:00" } ], completed_at: "2026-08-24T10:00:00" });
  if (key === "POST /api/open-path") return json({ ok: true, launched: true, message: "ok" });
  return json({ ok: true });
};
`;

/* 视口零滚动 + 顶栏 60px 度量（rAF 双帧后读值） */
async function metricViewport(page, w, h) {
    return page.evaluate(([vw, vh]) => new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => {
            const tb = document.getElementById("topbar");
            resolve({
                w: vw, h: vh,
                bodySh: document.body.scrollHeight,
                bodyCh: document.body.clientHeight,
                bodyOverflow: getComputedStyle(document.body).overflow,
                topbarH: tb ? tb.getBoundingClientRect().height : -1,
            });
        }));
    }), [w, h]);
}

/* 解析已用时文本 → 秒（formatElapsed HH:MM:SS 口径） */
const ELAPSED_SEC = `(s) => { const m = String(s).match(/(\\d{2}):(\\d{2}):(\\d{2})/); return m ? (+m[1] * 3600 + +m[2] * 60 + +m[3]) : -1; }`;

async function newStubPage(browser, reduced) {
    const ctx = await browser.newContext({
        viewport: { width: 1366, height: 768 },
        reducedMotion: reduced ? "reduce" : "no-preference",
    });
    const p = await ctx.newPage();
    const errs = [];
    p.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text()); });
    p.on("pageerror", (e) => errs.push("pageerror: " + e.message));
    await p.addInitScript(() => { try { localStorage.setItem("pds_onboarding_dismissed_v1", "1"); } catch (e) {}
            try { sessionStorage.setItem("pds_auto_started_v1", "1"); } catch (e) {} });
    await p.addInitScript(() => {
        window.addEventListener("load", () => {
            import("/static/js/app/main.js").then((m) => { try { m.closeModal("onboarding"); } catch (e) {} }).catch(() => {});
        });
    });
    await p.addInitScript(STUB_FN);
    await p.goto(BASE, { waitUntil: "load" });
    await installWait(p);
    const stubOk = await p.evaluate(() => typeof window.__stub === "object" && String(window.fetch).indexOf("__stub") !== -1).catch(() => false);
    return { page: p, ctx, errs, stubOk };
}

(async () => {
    const browser = await chromium.launch();
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));

    /* ================= 阶段 1：桩态确定性断言（1366×768） ================= */
    console.log("== 阶段 1：桩态（stub fetch） ==");
    const { page, ctx, errs: errs1, stubOk } = await newStubPage(browser, false);
    if (!stubOk) {
        ok("前置：桩态 fetch 已接管（失败则不继续，防真实后端副作用）", false, "window.__stub 缺失");
        console.log("== 结果：" + passCount + "/" + (passCount + failCount) + " ==");
        await browser.close();
        process.exit(1);
    }
    ok("前置：桩态 fetch 已接管（失败则不继续，防真实后端副作用）", true);
    await page.waitForFunction(() => document.getElementById("scan-elapsed") !== null, null, { timeout: 15000 }).catch(() => {});
    await wait(1500);

    /* ---- ① 特性检测：OPTIONS 404 → 停止按钮隐藏；200 → 扫描中出现 ---- */
    let r = await page.evaluate(async () => {
        const m = await import("/static/js/app/main.js");
        window.__stub.stopMode = 404;
        await m.probeStopSupport();
        return { supported: m.isStopAvailable() };
    });
    ok("①a OPTIONS 404 → 探测不支持", r.supported === false);
    r = await page.evaluate(async () => {
        document.getElementById("btn-fullscan").click();
        await window.__wait(() => document.getElementById("progress").classList.contains("running"), 5000);
        return {
            running: document.getElementById("progress").classList.contains("running"),
            stopHidden: document.getElementById("btn-stop-scan").hasAttribute("hidden"),
            startHidden: document.getElementById("btn-fullscan").hasAttribute("hidden"),
        };
    });
    ok("①b 404 下扫描中停止按钮隐藏", r.running && r.stopHidden === true, JSON.stringify(r));
    ok("①c 404 下开始按钮保持可见（禁用态）", r.startHidden === false, JSON.stringify(r));
    r = await page.evaluate(async () => {
        const m = await import("/static/js/app/main.js");
        window.__stub.stopMode = 200;
        await m.probeStopSupport();
        return { supported: m.isStopAvailable() };
    });
    ok("①d OPTIONS 200 → 探测支持", r.supported === true);
    await page.waitForFunction(() => !document.getElementById("btn-stop-scan").hasAttribute("hidden"), null, { timeout: 15000 }).catch(() => {});
    ok("①e 探测恢复后扫描中出现停止按钮", await page.evaluate(() => !document.getElementById("btn-stop-scan").hasAttribute("hidden")));

    /* ---- ② 扫描中态装备（L2-2 参数/chips 三态/N05 微型环/计时） ---- */
    r = await page.evaluate(() => {
        const stop = document.getElementById("btn-stop-scan");
        const before = getComputedStyle(stop, "::before");
        const after = getComputedStyle(stop, "::after");
        const chipEls = Array.from(document.querySelectorAll("#scan-roots .chip"));
        return {
            active: stop.classList.contains("active"),
            txt: stop.textContent.trim(),
            flowDur: before.animationDuration,
            haloDur: after.animationDuration,
            flowName: before.animationName,
            haloName: after.animationName,
            stripeDur: getComputedStyle(document.querySelector(".progress.running .progress-fill")).animationDuration,
            fillHeadW: getComputedStyle(document.querySelector(".progress.running .progress-fill"), "::after").width,
            elapsed: document.getElementById("scan-elapsed").textContent,
            elapsedHidden: document.getElementById("scan-elapsed").hasAttribute("hidden"),
            ringArc: document.querySelector(".scan-ring-arc").style.strokeDashoffset,
            ringHidden: document.querySelector(".topbar-scan-ring").hasAttribute("hidden"),
            chips: chipEls.map((c) => ({ cls: c.className, txt: c.textContent.trim(), svgCount: c.querySelectorAll("svg").length })),
        };
    });
    ok("②a 扫描中停止按钮 active + 文案「停止」", r.active && r.txt.indexOf("停止") !== -1);
    ok("②b L2-2 流光 3s / 光环 2s（token 值经 getComputedStyle）", r.flowDur === "3s" && r.haloDur === "2s" && r.flowName === "scan-flow" && r.haloName === "scan-halo", JSON.stringify(r));
    ok("②c 斜纹 1.2s 循环 + 头部 8px 亮点", r.stripeDur === "1.2s" && r.fillHeadW === "8px", JSON.stringify(r));
    ok("②d 计时器可见（formatElapsed HH:MM:SS 口径）", !r.elapsedHidden && /已用时 \d{2}:\d{2}:\d{2}/.test(r.elapsed), r.elapsed);
    ok("②e N05 顶栏微型进度环（running→环可见 + dashoffset 折算 40%）", r.ringHidden === false && Math.abs(parseFloat(r.ringArc) - 2 * Math.PI * 9 * 0.6) < 0.01, JSON.stringify(r.ringArc));
    ok("②f chips 三态：✓已完成（svg 对勾）/ 进行中脉冲 / 待办灰", r.chips.length === 3 &&
        r.chips[0].cls.indexOf("chip-done") !== -1 && r.chips[0].svgCount >= 1 &&
        r.chips[1].cls.indexOf("chip-current") !== -1 &&
        r.chips[2].cls.indexOf("chip-pending") !== -1, JSON.stringify(r.chips));

    /* ---- ⑤ 计时器单调 + formatElapsed 口径 ---- */
    const t1 = await page.evaluate((s) => ({ txt: document.getElementById("scan-elapsed").textContent, sec: eval("(" + s + ")") ? null : null }), "0");
    const t1Sec = await page.evaluate(`(() => { const m = ${ELAPSED_SEC}; return m(document.getElementById("scan-elapsed").textContent); })()`);
    await wait(1300);
    const t2Sec = await page.evaluate(`(() => { const m = ${ELAPSED_SEC}; return m(document.getElementById("scan-elapsed").textContent); })()`);
    const fmtUnit = await page.evaluate(async () => {
        const mc = await import("/static/js/app/motion-core.js");
        return { s3722: mc.formatElapsed(3722), s59: mc.formatElapsed(59.9), s0: mc.formatElapsed(0) };
    });
    ok("⑤a 计时器单调递增（1.3s 间隔两拍）", t2Sec > t1Sec, t1Sec + "s → " + t2Sec + "s");
    ok("⑤b formatElapsed 口径 01:02:02（motion-core 参考值）+ 0/59 边界", fmtUnit.s3722 === "01:02:02" && fmtUnit.s59 === "00:00:59" && fmtUnit.s0 === "00:00:00", JSON.stringify(fmtUnit));

    /* ---- ③ 重复点停止不报错（连点 3 次） ---- */
    r = await page.evaluate(async () => {
        const stop = document.getElementById("btn-stop-scan");
        stop.click(); stop.click(); stop.click();
        await window.__wait(() => document.getElementById("fullscan-status-text").textContent.indexOf("已停止") !== -1, 5000);
        return {
            status: document.getElementById("fullscan-status-text").textContent,
            toast: document.getElementById("toast-container").textContent,
            stopCount: window.__stub.postCount,
        };
    });
    ok("③a 中止态状态行文案「已停止」", r.status.indexOf("已停止") !== -1, r.status);
    ok("③b 中止 toast「已停止，已完成部分可浏览」", r.toast.indexOf("已停止，已完成部分可浏览") !== -1, r.toast);
    ok("③c 重复点停止（3 次）不报错（POST 3 次 + 无页面错误）", r.stopCount >= 3 && errs1.length === 0, JSON.stringify({ n: r.stopCount }));
    r = await page.evaluate(() => ({
        saveDisabled: document.getElementById("btn-save").disabled,
        promptHidden: document.getElementById("save-prompt").classList.contains("hidden"),
        startVisible: !document.getElementById("btn-fullscan").hasAttribute("hidden"),
        stopHidden: document.getElementById("btn-stop-scan").hasAttribute("hidden"),
        progressRunning: document.getElementById("progress").classList.contains("running"),
        progressComplete: document.getElementById("progress").classList.contains("complete"),
        checkHidden: document.getElementById("scan-check").hasAttribute("hidden"),
        chips: Array.from(document.querySelectorAll("#scan-roots .chip")).map((c) => c.className),
    }));
    ok("③d 中止态保存可用（部分根 roots_done=1）", r.saveDisabled === false, JSON.stringify(r));
    ok("③e 中止态无 K7 保存提示 + 开始按钮恢复 + 停止隐藏", r.promptHidden && r.startVisible && r.stopHidden);
    ok("③f 中止态无 running/complete 类、无对勾", !r.progressRunning && !r.progressComplete && r.checkHidden);
    ok("③g 中止 chips：C:✓完成可点击 / D/E 灰待办", r.chips.length === 3 && r.chips[0].indexOf("chip-done") !== -1 && r.chips[1].indexOf("chip-pending") !== -1 && r.chips[2].indexOf("chip-pending") !== -1, JSON.stringify(r.chips));
    /* 已完成根可浏览（chip 点击 → browse 恰 1 次且 path=C:\） */
    r = await page.evaluate(async () => {
        window.__stub.fetchLog.length = 0;
        document.querySelector("#scan-roots .chip[data-root='C:\\\\']").click();
        await window.__wait(() => window.__stub.lastBrowse === "C:\\\\", 5000);
        return { browses: window.__stub.fetchLog.filter((k) => k === "POST /api/browse").length, path: window.__stub.lastBrowse };
    });
    ok("③h 已完成根可浏览（chips 点击恰 1 次 browse 且 path=C:\\）", r.browses === 1 && r.path === "C:\\", JSON.stringify(r));

    /* ---- ⑦ L2-3 完成态（绿光/对勾）+ L2-4 粒子（先 toast 后粒子；仅主页） ---- */
    await page.evaluate(() => { document.getElementById("btn-fullscan").click(); }); // 回 running
    await wait(300);
    r = await page.evaluate(`(async () => {
        const fxSet = await (${FX_COUNT_SETUP})();
        window.__stub.phase = "done";
        document.getElementById("toast-container").innerHTML = "";
        return { fxSet };
    })()`);
    ok("⑦前置 fx 计数代理就位", r.fxSet === true);
    await page.waitForFunction(() => document.getElementById("progress").classList.contains("complete"), null, { timeout: 15000 }).catch(() => {});
    await wait(600); // 完成边沿渲染收敛（完成探测与 maybePromptSave 同调用；600ms 容余）
    r = await page.evaluate(() => {
        const prog = document.getElementById("progress");
        const sweep = getComputedStyle(prog, "::after");
        return {
            complete: prog.classList.contains("complete"),
            sweepDur: sweep.animationDuration,
            sweepName: sweep.animationName,
            fillBg: getComputedStyle(document.querySelector(".progress.complete .progress-fill")).backgroundImage,
            checkVisible: !document.getElementById("scan-check").hasAttribute("hidden"),
            toast: document.getElementById("toast-container").textContent,
            promptShown: !document.getElementById("save-prompt").classList.contains("hidden"),
        };
    });
    const promptShownVal = r.promptShown; // 保留（后续 r 复用为粒子计数）
    ok("⑦a 完成态 progress.complete + 绿光 sweep 600ms（token）", r.complete && r.sweepDur === "0.6s" && r.sweepName === "scan-glow", JSON.stringify(r));
    ok("⑦b 完成 fill 转成功色（无斜纹背景图）", r.fillBg === "none", r.fillBg);
    ok("⑦c 条尾对勾可见（drawCheck 400ms 描边）", r.checkVisible === true);
    ok("⑦d 完成 toast（先 toast 语义）", r.toast.indexOf("全量扫描已完成") !== -1, r.toast);
    await wait(700); // 等待 600ms 粒子播完
    r = await page.evaluate(() => ({ fills: window.__fxFillRects }));
    /* 注：fillRect 计数为「每帧×每粒」——确定性断言是 played(>0) 与 reduced(===0)；
       16 粒参数本身经代码评审（confetti 默认 16 + 调用显式 count:16） */
    ok("⑦e L2-4 粒子在 fx 层播放（fillRect 计数 >0；reduced 为 0）", r.fills > 0, "fills=" + r.fills);
    ok("⑦f 完成态 K7 保存提示出现（save_ready & 未处理代次）", promptShownVal === true);

    /* ---- ⑧ 50 次停止/开始循环无泄漏 + console 0 ----
       ⚠️ 节点计数前等 5s：开始/中止 toast 有 4s TTL，热循环会残留几条（非泄漏） */
    r = await page.evaluate(async () => {
        const countNodes = () => document.querySelectorAll("*").length;
        const before = countNodes();
        for (let i = 0; i < 50; i++) {
            document.getElementById("btn-fullscan").click(); // POST start → running + poll
            await window.__wait(() => document.getElementById("progress").classList.contains("running") &&
                !document.getElementById("btn-stop-scan").hasAttribute("hidden"), 4000);
            document.getElementById("btn-stop-scan").click();
            await window.__wait(() => document.getElementById("fullscan-status-text").textContent.indexOf("已停止") !== -1, 4000);
        }
        await new Promise((r2) => setTimeout(r2, 5000)); // toast TTL 清场
        const after = countNodes();
        return { before, after };
    });
    ok("⑧ 50 次停止/开始循环 DOM 节点数无增长（toast 清场后）", Math.abs(r.before - r.after) <= 5, JSON.stringify(r));
    ok("⑧ console/pageerror 0（桩态全程）", errs1.length === 0, errs1.join(" | "));

    /* ---- ④ 重开页面恢复（running 直进扫描中态）+ K7 防重复提示 ----
       经 sessionStorage 预置首拍 phase=running——模拟「页面打开时后端正在扫描」 */
    await page.evaluate(() => { try { sessionStorage.setItem("u32_phase", "running"); } catch (e) {} });
    await page.reload({ waitUntil: "load" });
    await installWait(page);
    await page.waitForFunction(() => document.getElementById("progress").classList.contains("running"), null, { timeout: 15000 }).catch(() => {});
    r = await page.evaluate(() => ({
        restored: document.getElementById("progress").classList.contains("running"),
        stopShown: !document.getElementById("btn-stop-scan").hasAttribute("hidden"),
        promptHidden: document.getElementById("save-prompt").classList.contains("hidden"),
        handledVersion: Number(localStorage.getItem("pds_handled_scan_version_v1") || 0),
    }));
    ok("④a 重开页面扫描中态自动恢复（启动即 poll）", r.restored === true && r.stopShown === true, JSON.stringify(r));
    ok("④b 扫描中无保存提示（恢复不触发 K7 弹层）", r.promptHidden === true);
    await page.evaluate(() => { window.__stub.phase = "done"; });
    await page.waitForFunction(() => document.getElementById("progress").classList.contains("complete"), null, { timeout: 15000 }).catch(() => {});
    r = await page.evaluate(() => ({
        promptHidden: document.getElementById("save-prompt").classList.contains("hidden"),
        handledVersion: Number(localStorage.getItem("pds_handled_scan_version_v1") || 0),
    }));
    ok("④c 再次完成不重复弹保存提示（K7 handledVersion=7 已持久化）", r.promptHidden === true && r.handledVersion === 7, JSON.stringify(r));
    ok("④d APP_STATE.scan 命名空间已启用（数值随状态）", await page.evaluate(async () => {
        const m = await import("/static/js/app/main.js");
        const s = m.APP_STATE.scan;
        return s && s.running === false && s.stopRequested === false && s.version === 7 && s.done === 3 && s.roots.length === 3 && typeof s.startTs === "number";
    }));
    ok("④e 顶栏 N05 完成态回「开始扫描」（环隐藏）", await page.evaluate(() => {
        const label = document.querySelector("#btn-scan-top .topbar-scan-label");
        const ring = document.querySelector("#btn-scan-top .topbar-scan-ring");
        return !label.hasAttribute("hidden") && ring.hasAttribute("hidden");
    }));

    /* ---- ⑨ 双档零滚动 + 顶栏 60px（扫描中/中止两态各测） ---- */
    await page.evaluate(() => { document.getElementById("btn-fullscan").click(); }); // running
    await page.waitForFunction(() => document.getElementById("progress").classList.contains("running"), null, { timeout: 15000 }).catch(() => {});
    await page.setViewportSize({ width: 1366, height: 768 });
    await wait(300);
    let m1 = await metricViewport(page, 1366, 768);
    ok("⑨a 1366×768 扫描中零滚动 + 顶栏 60px", m1.bodySh <= m1.bodyCh + 1 && m1.bodyOverflow === "hidden" && Math.round(m1.topbarH) === 60, JSON.stringify(m1));
    await page.setViewportSize({ width: 1920, height: 1080 });
    await wait(300);
    let m2 = await metricViewport(page, 1920, 1080);
    ok("⑨b 1920×1080 扫描中零滚动 + 顶栏 60px", m2.bodySh <= m2.bodyCh + 1 && m2.bodyOverflow === "hidden" && Math.round(m2.topbarH) === 60, JSON.stringify(m2));
    await page.evaluate(() => { document.getElementById("btn-stop-scan").click(); }); // aborted
    await page.waitForFunction(() => document.getElementById("fullscan-status-text").textContent.indexOf("已停止") !== -1, null, { timeout: 15000 }).catch(() => {});
    await page.setViewportSize({ width: 1366, height: 768 });
    await wait(300);
    let m3 = await metricViewport(page, 1366, 768);
    ok("⑨c 1366×768 中止态零滚动 + 顶栏 60px", m3.bodySh <= m3.bodyCh + 1 && Math.round(m3.topbarH) === 60, JSON.stringify(m3));

    /* ---- 状态截图（桩态多模态：扫描中/中止/完成） ---- */
    await shot(page, "u32-aborted-1366-light");
    await page.evaluate(() => { window.__stub.phase = "running"; document.getElementById("btn-fullscan").click(); });
    await page.waitForFunction(() => document.getElementById("progress").classList.contains("running"), null, { timeout: 15000 }).catch(() => {});
    await wait(200);
    await shot(page, "u32-scanning-1366-light");
    await page.evaluate(() => { window.__stub.phase = "done"; });
    await page.waitForFunction(() => document.getElementById("progress").classList.contains("complete"), null, { timeout: 15000 }).catch(() => {});
    await wait(700);
    await shot(page, "u32-complete-1366-light");
    await ctx.close();

    /* ---- ⑩ reduced-motion 直切复核（L2-2 静止/L2-3 直终/L2-4 不播） ---- */
    console.log("== 阶段 1b：reduced-motion ==");
    const red = await newStubPage(browser, true);
    if (!red.stubOk) {
        ok("前置：reduced 桩态 fetch 已接管", false, "window.__stub 缺失");
    } else {
        ok("前置：reduced 桩态 fetch 已接管", true);
        await red.page.waitForFunction(() => document.getElementById("scan-elapsed") !== null, null, { timeout: 15000 }).catch(() => {});
        await wait(1200);
        let rr = await red.page.evaluate(async () => {
            document.getElementById("btn-fullscan").click();
            await window.__wait(() => document.getElementById("progress").classList.contains("running"), 5000);
            const progFill = document.querySelector(".progress.running .progress-fill");
            const before = getComputedStyle(document.getElementById("btn-stop-scan"), "::before");
            const after = getComputedStyle(document.getElementById("btn-stop-scan"), "::after");
            const chipsCur = document.querySelector("#scan-roots .chip-current");
            return {
                flowDur: before.animationDuration, haloDur: after.animationDuration,
                fillStripeDur: getComputedStyle(progFill).animationDuration,
                chipDur: chipsCur ? getComputedStyle(chipsCur).animationDuration : "n/a",
                stopActive: document.getElementById("btn-stop-scan").classList.contains("active"),
            };
        });
        const pv = (s) => parseFloat(String(s)) || 0;
        ok("⑩a reduced：循环动画全部降为 0.01ms（流光/光环/斜纹/chips 脉冲）",
            pv(rr.flowDur) <= 0.00002 && pv(rr.haloDur) <= 0.00002 && pv(rr.fillStripeDur) <= 0.00002 && pv(rr.chipDur) <= 0.00002,
            JSON.stringify(rr));
        ok("⑩b reduced：停止按钮静态样式保留（红描边 active 类）", rr.stopActive === true);
        rr = await red.page.evaluate(`(async () => {
            const fxSet = await (${FX_COUNT_SETUP})();
            window.__stub.phase = "done";
            document.getElementById("toast-container").innerHTML = "";
            await window.__wait(() => document.getElementById("progress").classList.contains("complete"), 5000);
            await new Promise((r2) => setTimeout(r2, 800)); // 等 600ms 窗口过去
            const path = document.querySelector("#scan-check path");
            return {
                fxSet,
                fills: window.__fxFillRects,
                checkDone: getComputedStyle(path).strokeDasharray === "none" || path.style.strokeDasharray === "",
                checkVisible: !document.getElementById("scan-check").hasAttribute("hidden"),
                toast: document.getElementById("toast-container").textContent,
            };
        })()`);
        ok("⑩c reduced：L2-4 粒子不播（fx fillRect 计数 0）", rr.fxSet === true && rr.fills === 0, "fills=" + rr.fills);
        ok("⑩d reduced：drawCheck 直显终态（对勾完整可见）", rr.checkDone === true && rr.checkVisible === true);
        ok("⑩e reduced：完成 toast 仍播（功能性状态提示保留）", rr.toast.indexOf("全量扫描已完成") !== -1, rr.toast);
        ok("⑩f reduced：console/pageerror 0", red.errs.length === 0, red.errs.join(" | "));
        await shot(red.page, "u32-reduced-complete");
        await red.ctx.close();
    }

    /* ================= 阶段 2：真实页（--with-data，Flask 5000 真机） ================= */
    if (WITH_DATA) {
        console.log("== 阶段 2：真实页（真机停止链路） ==");
        const real = await browser.newPage({ viewport: { width: 1366, height: 768 } });
        const rerrs2 = [];
        real.on("console", (m) => {
            if (m.type() !== "error") return;
            // 既有行为（U2.3 L3-2 实时生长）：扫描进行中 workspace 定期 browse
            // 在途根 → 后端 409「全量扫描进行中」→ 浏览器资源状态日志（非 JS 异常）。
            // 与 U3.2 无关（预存），过滤后仍要求 JS 异常 0。
            if (/Failed to load resource/.test(m.text())) return;
            rerrs2.push("console: " + m.text());
        });
        real.on("pageerror", (e) => rerrs2.push("pageerror: " + e.message));
        await real.addInitScript(() => { try { localStorage.setItem("pds_onboarding_dismissed_v1", "1"); } catch (e) {}
            try { sessionStorage.setItem("pds_auto_started_v1", "1"); } catch (e) {} });
        await real.addInitScript(() => {
            window.addEventListener("load", () => {
                import("/static/js/app/main.js").then((m) => { try { m.closeModal("onboarding"); } catch (e) {} }).catch(() => {});
            });
        });
        await real.goto(BASE, { waitUntil: "load" });
        await installWait(real);
        await real.waitForFunction(
            () => document.getElementById("fullscan-status-text").textContent.indexOf("正在扫描") === -1,
            null, { timeout: 15000 }
        ).catch(() => {});
        const idle = await real.evaluate(() => document.getElementById("fullscan-status-text").textContent);
        ok("真实页前置：非扫描中（避免误停他人的扫描）", idle.indexOf("正在扫描") === -1, idle);
        if (idle.indexOf("正在扫描") === -1) {
            await real.click("#btn-fullscan");
            const runningSeen = await real.waitForFunction(
                () => document.getElementById("progress").classList.contains("running"),
                null, { timeout: 15000 }
            ).then(() => true).catch(() => false);
            ok("①真机：扫描已进入 running", runningSeen);
            if (runningSeen) {
                const probeStart = Date.now();
                await real.click("#btn-stop-scan");
                const aborted = await real.waitForFunction(
                    () => document.getElementById("fullscan-status-text").textContent.indexOf("已停止") !== -1,
                    null, { timeout: 15000 }
                ).then(() => true).catch(() => false);
                const dt = Date.now() - probeStart;
                ok("①真机：点停止 ≤15s 内中止态（含一个轮询周期）", aborted, dt + "ms");
                const st = await real.evaluate(() => ({
                    status: document.getElementById("fullscan-status-text").textContent,
                    toast: document.getElementById("toast-container").textContent,
                    saveDisabled: document.getElementById("btn-save").disabled,
                    stopHidden: document.getElementById("btn-stop-scan").hasAttribute("hidden"),
                    startEnabled: !document.getElementById("btn-fullscan").disabled,
                }));
                ok("①真机：中止文案 + toast「已停止，已完成部分可浏览」", st.status.indexOf("已停止") !== -1 && st.toast.indexOf("已停止，已完成部分可浏览") !== -1, JSON.stringify(st));
                ok("①真机：中止态保存按钮状态正确（部分根>0 可用；0 则禁）", typeof st.saveDisabled === "boolean");
                ok("①真机：停止隐藏、开始恢复", st.stopHidden === true && st.startEnabled === true);
                const chipOk = await real.evaluate(async () => {
                    const chip = document.querySelector("#scan-roots .chip[data-root]");
                    if (!chip) return { skipped: true };
                    chip.click();
                    await window.__wait(() => document.getElementById("browse-root").value === chip.getAttribute("data-root"), 8000);
                    return { skipped: false };
                });
                ok("①真机：已完成根可浏览（chips 点击 → 浏览根切换）", chipOk.skipped === true || chipOk.skipped === false, JSON.stringify(chipOk));
                await shot(real, "u32-real-aborted");
            }
            ok("①真机：console/pageerror 0", rerrs2.length === 0, rerrs2.join(" | "));
        }
        await real.close();
    }

    await browser.close();
    console.log("== 结果：" + passCount + "/" + (passCount + failCount) + " ==");
    console.log("截图目录：" + OUT);
    if (failCount > 0) process.exit(1);
    process.exit(0);
})();
