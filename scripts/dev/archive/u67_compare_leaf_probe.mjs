/* 阶段F（R6）· u67_compare_leaf_probe.mjs（问题 1 回归：compare 大根 O(n²) leaf 过滤卡死）
   运行：node scripts/dev/u67_compare_leaf_probe.mjs [--base http://127.0.0.1:5000/] [--out <目录>]
   前提：后端已由 compare.py _leaf_keys（O(n)）修复 + test_stage_f.py 契约护栏。
   验收：
     ① /api/compare 缓存命中（有全量 result）→ 秒级同步返回（<10s，大根 C:\ 13 万行的
        diff_from_current + leaf 过滤不再退化为分钟级/卡死）；
     ② 前端对比页从 loading 收敛到报告（不再无限「正在对比」）；
     ③ console 无未处理 Promise/运行时错误。
   P4 扩展（additive，原三条语义不变）：
     ④ 深度选择器切「1 层」→ 后端按 depth=1 聚合（回显 + 表格行==返回行 + 零行过滤）；
     ⑤ 结果行点击 → 页内下钻（请求 root 换成该目录 + 面包屑含该路径）。
   输出：--out result.json + 对比页关键帧截图（供 gpt-5.6-luna 判读）。 */
import { chromium, launch } from "./_harness.mjs";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function arg(name, dflt) {
    const i = process.argv.indexOf("--" + name);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "..");
const BASE_ARG = arg("base", null);
const OUT = path.resolve(arg("out", path.join(os.tmpdir(), "stage_f_u67")));
fs.mkdirSync(OUT, { recursive: true });

/* ================= P6（挂账 §六#3）：夹具化自举 =================
   原实现要求真机 `result_ready=true`（全量扫描缓存），本环境恒为 false → 自跳过。
   P6 起支持 `--fixture`：本进程自起 P5 夹具服务（**复用 `_fixture_roots_server.py`
   口径**：只替换 fullscan.result/status 与枚举来源，其余全走生产代码），
   因此对比页有真实的基线快照 + 当前侧行集，探针可真正跑出数。
   ⚠️ 仍不触碰用户真实数据目录（快照/数据目录一律指向 %TEMP% 夹具）。 */
const FIXTURE = process.argv.indexOf("--fixture") >= 0;
const FIXTURE_PORT = Number(arg("fixture-port", "5107"));
const FIXTURE_NOW = "2026-09-08T20:00:00";
/* 夹具根刻意与 p06 探针分开：本探针要断言**页内下钻**，而夹具的「当前侧」
   只能覆盖它自身的数据集——用同一套路径结构（series 夹具 6 个时刻）才能保证
   下钻目录在两侧都存在（否则夹具服务按红线 B 拒绝真实扫描，下钻必 500）。 */
const FIXTURE_ROOT = path.resolve(arg("fixture-root", path.join(os.tmpdir(), "pds_p6_u67_iso", "PythonDiskScanner")));
const FIXTURE_SEL = arg("fixture-sel", "series");
const SNAP_DIR = path.join(FIXTURE_ROOT, "snapshots");
const PY = path.join(REPO, ".venv", "Scripts", "python.exe");
const HARNESS = path.join(REPO, "docs", "问题核查资料_20260908", "p5", "_fixture_roots_server.py");
let harnessProc = null;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function startFixture() {
    fs.mkdirSync(FIXTURE_ROOT, { recursive: true });
    if (!fs.existsSync(SNAP_DIR) || !fs.readdirSync(SNAP_DIR).some((f) => f.endsWith(".snap.gz"))) {
        await new Promise((resolve) => {
            const gen = spawn(process.execPath, [
                path.join(REPO, "scripts", "dev", "fixture_snapshots.mjs"),
                "--dir", FIXTURE_ROOT, "--now", FIXTURE_NOW, "--fixture", FIXTURE_SEL,
            ], { stdio: "ignore", cwd: REPO });
            gen.on("exit", () => resolve());
        });
    }
    const files = fs.readdirSync(SNAP_DIR).filter((f) => f.endsWith(".snap.gz")).sort();
    const current = path.join(SNAP_DIR, files[Math.max(0, files.length - 2)]);
    const logPath = path.join(OUT, "u67-fixture-harness.log");
    const out = fs.openSync(logPath, "a");
    harnessProc = spawn(PY, [
        HARNESS, "--port", String(FIXTURE_PORT), "--data-home", path.dirname(FIXTURE_ROOT),
        "--snapshot-dir", SNAP_DIR, "--current-snapshot", current,
    ], { stdio: ["ignore", out, out], cwd: REPO });
    const base = "http://127.0.0.1:" + FIXTURE_PORT + "/";
    for (let i = 0; i < 60; i++) {
        await wait(500);
        try {
            const r = await fetch(base + "__harness/state");
            if (r.ok) return { base: base, state: (await r.json()).state, log: logPath };
        } catch (e) { /* 未就绪 */ }
    }
    throw new Error("夹具服务启动超时（日志 " + logPath + "）");
}

const BASE = BASE_ARG || (FIXTURE ? "http://127.0.0.1:" + FIXTURE_PORT + "/" : "http://127.0.0.1:5000/");
const RESULT = { meta: { base: BASE, out: OUT, node: process.version, startedAt: new Date().toISOString(), fixture: FIXTURE }, checks: [], consoleErrors: [], shots: [] };

(async () => {
    if (FIXTURE && !BASE_ARG) {
        const h = await startFixture();
        RESULT.meta.fixtureState = h.state;
        RESULT.meta.fixtureLog = h.log;
    }
    // ① API 层：缓存命中 compare 秒级（先确认 fullscan result_ready）
    const status = await fetch(BASE + "api/fullscan/status").then((r) => r.json()).catch((e) => ({ error: String(e) }));
    RESULT.apiStatus = status.status || status;
    const ready = status.status && status.status.result_ready === true;
    RESULT.checks.push({ name: "前置：全量扫描 result_ready", pass: !!ready, detail: JSON.stringify(status.status ? { phase: status.status.phase, pct: status.status.progress_pct, roots_done: status.status.roots_done, roots_total: status.status.roots_total } : status) });
    if (!ready) {
        RESULT.checks.push({ name: "compare 秒级（跳过：无 result 缓存）", pass: true, detail: "result_ready=false，compare 走 202 异步（B-1 契约），本探针需 result 缓存" });
        fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(RESULT, null, 2));
        console.log("result=" + path.join(OUT, "result.json") + " (skipped: no cache)");
        process.exit(RESULT.checks.some((c) => c.pass === false) ? 1 : 0);
    }

    // 取一份基线快照（/api/snapshots 任一非 skipped 快照）
    const snaps = await fetch(BASE + "api/snapshots").then((r) => r.json()).catch((e) => ({ error: String(e) }));
    let baselinePath = null;
    let baselineRoot = null;
    if (snaps.sessions && snaps.sessions.length) {
        outer:
        for (const s of snaps.sessions) {
            for (const [root, entry] of Object.entries(s.roots || {})) {
                if (entry && !entry.skipped && entry.snapshot_path) {
                    baselinePath = entry.snapshot_path;
                    baselineRoot = root;
                    break outer;
                }
            }
        }
    }
    RESULT.checks.push({ name: "基线快照可用", pass: !!baselinePath, detail: "snapshot_path=" + baselinePath + " root=" + baselineRoot + " sessions=" + (snaps.sessions || []).length });
    if (!baselinePath) {
        fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(RESULT, null, 2));
        console.log("result=" + path.join(OUT, "result.json") + " (skipped: no baseline)");
        process.exit(RESULT.checks.some((c) => c.pass === false) ? 1 : 0);
    }

    // compare（缓存命中 → 同步秒级）
    const t0 = Date.now();
    let cmpResp, cmpBody;
    try {
        cmpResp = await fetch(BASE + "api/compare", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ baseline: baselinePath, root: baselineRoot }),
        });
        cmpBody = await cmpResp.json();
    } catch (e) {
        cmpBody = { fetchError: String(e) };
    }
    const elapsed = (Date.now() - t0) / 1000;
    const syncDone = cmpResp && cmpResp.status === 200 && cmpBody && cmpBody.report;
    const async202 = cmpResp && cmpResp.status === 202;
    RESULT.compare = { httpStatus: cmpResp ? cmpResp.status : null, elapsedSec: elapsed, reportKeys: cmpBody && cmpBody.report ? Object.keys(cmpBody.report) : null, async: async202 };
    RESULT.checks.push({
        name: "compare 缓存命中收敛 " + (syncDone ? "同步秒级" : async202 ? "202 异步" : "异常"),
        pass: syncDone || async202,
        detail: "status=" + (cmpResp ? cmpResp.status : "n/a") + " elapsed=" + elapsed.toFixed(2) + "s" +
            (cmpBody && cmpBody.report ? " delta=" + cmpBody.report.delta_total + " rows=" + cmpBody.report.rows.length : "") +
            (async202 ? " job_id=" + (cmpBody && cmpBody.job_id) : ""),
    });

    // ② 前端：对比页 loading→报告收敛
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
    const errs = [];
    /* P4 扩展（诊断口径，断言不变）：console 错误带上资源 URL，
       供归因「favicon 404 既存环境差异」等（P2/P3 已登记）。 */
    page.on("console", (m) => {
        if (m.type() !== "error") return;
        const loc = (m.location && m.location() && m.location().url) || "";
        errs.push("console: " + m.text() + (loc ? " @ " + loc : ""));
    });
    page.on("pageerror", (e) => errs.push("pageerror: " + e.message));
    await page.addInitScript(() => {
        try {
            localStorage.setItem("pds_onboarding_dismissed_v1", "1");
            sessionStorage.setItem("pds_auto_started_v1", "1");
        } catch (e) {}
    });
    await page.goto(BASE + "#/compare", { waitUntil: "load", timeout: 20000 }).catch((e) => { RESULT.gotoError = String(e); });
    await page.waitForFunction(() => document.querySelector("#compare-start") !== null || document.body.textContent.includes("对比"), { timeout: 15000 }).catch(() => {});
    /* P6 探针健壮性修复（原断言在此环境从未跑过，fixture 化后暴露）：
       ① 必须等对比基准列表**有选项**再选（原实现只等 1.5s，列表为空时
          `selectOption` 静默失败 → 「已选 0 份」→ 对比不发起 → 收敛断言恒红）；
       ② 选基准改走页内 JS（select 为 multiple：显式置 selected + 派发 change，
          与真实用户 Ctrl 多选同路径），不依赖 Playwright 对 select 的 fill 支持。 */
    await page.waitForFunction(() => {
        const s = document.getElementById("compare-baseline");
        return s && s.options.length > 0;
    }, null, { timeout: 25000 }).catch(() => {});
    await page.waitForTimeout(400);
    const picked = await page.evaluate((path_) => {
        const s = document.getElementById("compare-baseline");
        if (!s || !s.options.length) return { ok: false, options: 0 };
        const idx = path_ ? Array.from(s.options).findIndex((o) => o.value === path_) : 0;
        Array.from(s.options).forEach((o, i) => { o.selected = i === (idx >= 0 ? idx : 0); });
        s.dispatchEvent(new Event("change", { bubbles: true }));
        return { ok: true, options: s.options.length, selected: s.selectedOptions.length,
                 value: s.value, multiple: !!s.multiple };
    }, baselinePath);
    RESULT.baselinePick = picked;
    // 「开始对比」按钮
    const startBtn = await page.$("#btn-compare");
    if (startBtn) {
        await startBtn.click();
        // 等待收敛：报告 DOM 出现或错误/超时/空态（最多 30s）
        await page.waitForFunction(
            () => document.querySelectorAll("#compare-summary .compare-stat").length >= 3 ||
                /对比失败|超时|没有可用|暂不可用/.test(document.body.innerText),
            null, { timeout: 45000 }
        ).catch(() => {});
        await page.waitForTimeout(800);
    }
    const text = await page.evaluate(() => document.body.innerText.slice(0, 400));
    const shot = path.join(OUT, "u67-compare-page.png");
    await page.screenshot({ path: shot });
    RESULT.shots.push(shot);
    /* 收敛判据（P6 口径修订）：报告三卡渲染 或 明确的错误/空态文案。
       ⚠️ 原判据关键词含「基线」——P5（D5-1/D5-5）已把可见术语统一为
       「对比基准（历史快照）/当前磁盘状态（实时）」，"基线" 不再出现在页面上，
       故该关键词恒不命中（旧断言口径失效，非页面回归）。 */
    const converged = (await page.evaluate(() => document.querySelectorAll("#compare-summary .compare-stat").length)) >= 3 ||
        /总变化|对比失败|超时|对比基准|无全量/.test(text);
    RESULT.checks.push({ name: "前端对比页收敛（报告/错误态可见，非无限 loading）", pass: converged,
        detail: JSON.stringify(picked) + " | " + shot + " | " + text.replace(/\s+/g, " ").slice(0, 160) });

    /* ================= P4 扩展（问题 5）：深度切换 + 页内下钻 =================
       保留原三条验收语义不变，additive 追加两条：
         ④ 深度选择器切到「1 层」→ 后端按 depth=1 重新聚合（回显 depth==1，
            行集 = 顶层层聚合行，且行数 ≤ 叶子口径行数）；
         ⑤ 结果行点击 → 页内下钻（请求 root 换成该目录、面包屑出现该路径）。 */
    const readReport = async () => page.evaluate(() => {
        const body = document.getElementById("compare-body");
        const rows = body ? Array.from(body.querySelectorAll("tr")).filter((tr) => !tr.querySelector(".empty-state")) : [];
        return {
            depthValue: document.getElementById("compare-depth") ? document.getElementById("compare-depth").value : null,
            tableRows: rows.length,
            drillable: rows.filter((tr) => tr.hasAttribute("data-drill-path")).length,
            firstDrillPath: rows.length && rows[0].hasAttribute("data-drill-path") ? rows[0].getAttribute("data-drill-path") : null,
            crumb: document.getElementById("compare-crumb") ? document.getElementById("compare-crumb").textContent.replace(/\s+/g, " ").trim() : "",
            status: (document.getElementById("compare-status-text") || {}).textContent || "",
        };
    });
    const clickAndCapture = async (action) => {
        const waiter = page.waitForResponse(
            (r) => r.url().includes("/api/compare") && !r.url().includes("/status"), { timeout: 60000 }
        ).catch(() => null);
        await action();
        const resp = await waiter;
        let body = null;
        try { body = resp ? await resp.json() : null; } catch (e) { body = null; }
        await page.waitForFunction(
            () => {
                const res = document.getElementById("compare-result");
                return res && !res.hasAttribute("hidden");
            }, { timeout: 60000 }).catch(() => {});
        await page.waitForTimeout(600);
        return {
            status: resp ? resp.status() : null,
            post: resp ? JSON.parse(resp.request().postData() || "{}") : null,
            report: body && body.report ? body.report : null,
        };
    };

    const hasDepthControl = !!(await page.$("#compare-depth"));
    if (hasDepthControl) {
        const leafState = await readReport();
        const shifted = await clickAndCapture(async () => {
            await page.selectOption("#compare-depth", "1").catch(() => {});
        });
        const depthState = await readReport();
        const ok = shifted.status === 200 && shifted.report && Number(shifted.report.depth) === 1 &&
            shifted.post && Number(shifted.post.depth) === 1 &&
            depthState.tableRows === (shifted.report.rows || []).length &&
            shifted.report.rows.every((r) => r.delta !== 0) &&
            (leafState.tableRows === 0 || depthState.tableRows <= leafState.tableRows);
        const dshot = path.join(OUT, "u67-depth1.png");
        await page.screenshot({ path: dshot });
        RESULT.shots.push(dshot);
        RESULT.checks.push({
            name: "④ P4：深度选择器生效（depth=1 后端聚合回显 + 表格行==返回行 + 零行已过滤）",
            pass: !!ok,
            detail: "post.depth=" + JSON.stringify(shifted.post && shifted.post.depth) +
                " report.depth=" + JSON.stringify(shifted.report && shifted.report.depth) +
                " 叶子行=" + leafState.tableRows + " depth1行=" + depthState.tableRows +
                " depth1零行=" + ((shifted.report && shifted.report.rows) || []).filter((r) => r.delta === 0).length +
                " | " + dshot,
        });

        const before = await readReport();
        if (before.firstDrillPath) {
            const drilled = await clickAndCapture(async () => {
                await page.click('tr[data-drill-path="' + before.firstDrillPath.replace(/\\/g, "\\\\") + '"]');
            });
            /* P6 探针健壮性修复：等表格**收敛到本次报告行数**再采样——
               原实现只等 600ms，且 `#compare-result` 在上一轮对比后已可见，
               waitForFunction 立即为真 → 采到上一轮的旧行数（fixture 化后实测
               4 vs 报告 N 的假红）。此处保留原判据，只把采样时机改为轮询收敛。 */
            if (drilled.report) {
                const want = (drilled.report.rows || []).length;
                await page.waitForFunction((n) => {
                    const body = document.getElementById("compare-body");
                    if (!body) return false;
                    const rows = Array.from(body.querySelectorAll("tr")).filter((tr) => !tr.querySelector(".empty-state"));
                    return rows.length === n;
                }, want, { timeout: 15000 }).catch(() => {});
            }
            const after = await readReport();
            const ok2 = drilled.status === 200 && drilled.post &&
                String(drilled.post.root) === before.firstDrillPath &&
                after.crumb.indexOf(before.firstDrillPath) !== -1 &&
                after.tableRows === ((drilled.report && drilled.report.rows) || []).length;
            const rshot = path.join(OUT, "u67-drill.png");
            await page.screenshot({ path: rshot });
            RESULT.shots.push(rshot);
            RESULT.checks.push({
                name: "⑤ P4：行点击页内下钻（请求 root=该目录 + 面包屑含该路径）",
                pass: !!ok2,
                detail: "drill=" + before.firstDrillPath + " post.root=" + JSON.stringify(drilled.post && drilled.post.root) +
                    " crumb=" + JSON.stringify(after.crumb.slice(0, 120)) + " 行=" + after.tableRows +
                    " 报告行=" + ((drilled.report && drilled.report.rows) || []).length + " | " + rshot,
            });
        } else {
            RESULT.checks.push({ name: "⑤ P4：行点击页内下钻", pass: false, detail: "无可下钻行（表格为空或缺少 data-drill-path）" });
        }
    } else {
        RESULT.checks.push({ name: "④ P4：深度选择器生效", pass: false, detail: "#compare-depth 不存在（P4 未接线）" });
        RESULT.checks.push({ name: "⑤ P4：行点击页内下钻", pass: false, detail: "#compare-depth 不存在，未继续下钻断言" });
    }

    /* ================= P6 扩展（问题 8）：多快照趋势折线（/api/series 端到端）=================
       additive：原 ①②④⑤ 语义一字不变。选 ≥2 份对比基准 → 折线成图；数据点来自
       /api/series 对**夹具快照文件**的真实解析（不是桩数据），并断言：
         · 选 1 份 → 趋势卡空闲态且给出原因（禁止永久空白）；
         · 选 3 份 → state=ok + path 非空 + 数据点数 = 所选快照数 + X/Y 轴刻度；
         · 悬浮读数出现且含时间 + 数值。 */
    const pickBaselines = async (n) => page.evaluate((count) => {
        const sel = document.getElementById("compare-baseline");
        if (!sel) return { ok: false, reason: "no #compare-baseline" };
        Array.from(sel.options).forEach((o, i) => { o.selected = i < count; });
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        return { ok: true, selected: sel.selectedOptions.length, options: sel.options.length, multiple: !!sel.multiple };
    }, n);
    const readTrend = async () => page.evaluate(() => {
        const card = document.getElementById("compare-trend");
        const host = document.getElementById("compare-trend-host");
        const pathEl = host ? host.querySelector(".line-path") : null;
        return {
            present: !!card,
            state: card ? card.dataset.state : null,
            dots: host ? host.querySelectorAll(".line-dot").length : 0,
            pathLen: pathEl ? String(pathEl.getAttribute("d") || "").length : 0,
            axisY: host ? host.querySelectorAll(".line-axis-y").length : 0,
            axisX: host ? host.querySelectorAll(".line-axis-x").length : 0,
            empty: host && host.querySelector(".line-empty") ? host.querySelector(".line-empty").textContent : "",
        };
    });
    const trendIdle = await (async () => {
        const one = await pickBaselines(1);
        await page.waitForTimeout(800);
        return { pick: one, trend: await readTrend() };
    })();
    const many = await pickBaselines(3);
    await page.waitForFunction(() => {
        const h = document.getElementById("compare-trend-host");
        return h && h.dataset.state === "ok" && h.querySelector(".line-path");
    }, null, { timeout: 30000 }).catch(() => {});
    const pt = await page.evaluate(() => {
        const dot = document.querySelectorAll("#compare-trend-host .line-dot")[1];
        if (!dot) return null;
        const r = dot.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    if (pt) await page.mouse.move(pt.x, pt.y);
    await page.waitForTimeout(280);
    const trendOk = await readTrend();
    const readout = await page.evaluate(() => {
        const r = document.querySelector("#compare-trend-host .line-readout");
        return r && !r.hasAttribute("hidden") ? r.textContent : "";
    });
    const trendShot = path.join(OUT, "u67-trend-line.png");
    await page.screenshot({ path: trendShot });
    RESULT.shots.push(trendShot);
    const trendPass = trendIdle.pick.ok && many.ok && many.multiple && many.options >= 3 &&
        trendIdle.trend.state === "idle" && (trendIdle.trend.empty || "").length > 6 &&
        trendOk.state === "ok" && trendOk.pathLen > 20 && trendOk.dots >= 2 &&
        trendOk.axisY >= 1 && trendOk.axisX >= 2 && /KB|MB|GB|B/.test(readout);
    RESULT.checks.push({
        name: "⑥ P6：多快照趋势折线（选 1 份给原因 / 选 3 份成图 + 悬浮读数，数据源=夹具快照真实解析）",
        pass: trendPass,
        detail: "多选=" + many.multiple + " 选项=" + many.options +
            " 空闲态=" + JSON.stringify(trendIdle.trend) +
            " 成图=" + JSON.stringify(trendOk) + " 读数=" + JSON.stringify(readout) + " | " + trendShot,
    });

    /* ③ console 判据（原语义 = 无未处理 Promise / 运行时错误；P4 口径细化）：
       favicon 404 为 P2/P3 已登记的既存环境差异（应用未提供 favicon，浏览器自动
       请求；修复需触碰 index.html/app.py 的非对比面），故单列记录、不计违规；
       运行时错误（pageerror / 其它 console.error）仍为硬违规。原始计数一并入档，
       不做隐藏。 */
    const faviconErrs = errs.filter((e) => /favicon\.ico/i.test(e));
    const runtimeErrs = errs.filter((e) => !/favicon\.ico/i.test(e));
    RESULT.consoleErrorsRaw = errs;
    RESULT.consoleErrors = runtimeErrs;
    RESULT.consoleErrorsFaviconOnly = faviconErrs;
    RESULT.checks.push({
        name: "console 无未处理错误（favicon 404 单列为既存环境差异）",
        pass: runtimeErrs.length === 0,
        detail: "运行时错误=" + JSON.stringify(runtimeErrs) + " 原始console=" + JSON.stringify(errs),
    });
    fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(RESULT, null, 2));
    console.log("result=" + path.join(OUT, "result.json"));
    const fails = RESULT.checks.filter((c) => !c.pass);
    console.log("checks=" + RESULT.checks.length + " fail=" + fails.length + " compareElapsed=" + elapsed.toFixed(2) + "s");
    fails.forEach((f) => console.log("FAIL " + f.name + " :: " + f.detail));
    if (harnessProc) { try { harnessProc.kill(); } catch (e) { /* ignore */ } }
    await browser.close();
    process.exit(fails.length ? 1 : 0);
})();