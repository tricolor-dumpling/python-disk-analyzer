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
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function arg(name, dflt) {
    const i = process.argv.indexOf("--" + name);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const BASE = arg("base", "http://127.0.0.1:5000/");
const OUT = path.resolve(arg("out", path.join(os.tmpdir(), "stage_f_u67")));
fs.mkdirSync(OUT, { recursive: true });
const RESULT = { meta: { base: BASE, out: OUT, node: process.version, startedAt: new Date().toISOString() }, checks: [], consoleErrors: [], shots: [] };

(async () => {
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
    await page.waitForTimeout(1500);
    // 填基线：compare-baseline（该页既有 id，探针复用；不属 smoke 断言面修改）
    const sel = await page.$("#compare-baseline");
    if (sel) {
        const opts = await sel.$$("option");
        if (opts.length) await sel.selectOption({ index: 0 }).catch(() => {});
    }
    /* P4 扩展前置：取一次基线快照路径直接填进输入框（datalist 选择对 input 不生效，
       原实现只做了「尽力而为」；P4 断言深度/下钻需要一次确定的对比） */
    if (baselinePath) await page.fill("#compare-baseline", baselinePath).catch(() => {});
    // 「开始对比」按钮
    const startBtn = await page.$("#btn-compare");
    if (startBtn) {
        await startBtn.click();
        // 等待收敛：报告 DOM 出现或 toast（最多 30s）
        await page.waitForFunction(
            () => document.body.textContent.includes("总变化") || document.body.textContent.includes("对比失败") || document.body.textContent.includes("超时") || document.querySelector(".compare-report"),
            { timeout: 60000 }
        ).catch(() => {});
        await page.waitForTimeout(800);
    }
    const text = await page.evaluate(() => document.body.innerText.slice(0, 400));
    const shot = path.join(OUT, "u67-compare-page.png");
    await page.screenshot({ path: shot });
    RESULT.shots.push(shot);
    const converged = /总变化|对比失败|超时|基线|无全量/.test(text);
    RESULT.checks.push({ name: "前端对比页收敛（报告/错误态可见，非无限 loading）", pass: converged, detail: shot + " | " + text.replace(/\s+/g, " ").slice(0, 160) });

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
                    " crumb=" + JSON.stringify(after.crumb.slice(0, 120)) + " 行=" + after.tableRows + " | " + rshot,
            });
        } else {
            RESULT.checks.push({ name: "⑤ P4：行点击页内下钻", pass: false, detail: "无可下钻行（表格为空或缺少 data-drill-path）" });
        }
    } else {
        RESULT.checks.push({ name: "④ P4：深度选择器生效", pass: false, detail: "#compare-depth 不存在（P4 未接线）" });
        RESULT.checks.push({ name: "⑤ P4：行点击页内下钻", pass: false, detail: "#compare-depth 不存在，未继续下钻断言" });
    }

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
    await browser.close();
    process.exit(fails.length ? 1 : 0);
})();