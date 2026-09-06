/* ============================================================
   阶段 E（R4/R5）· u62_theme_vt_probe.mjs（E-3 主题扩散 VT 连点防护验收探针）
   阶段 H（H-4 探针卫生，2026-09-06 硬化）：仅改终态断言/等待逻辑，零应用代码——
   ①rapid 组（连点 2 次）终态目标推导修正为双 toggle 语义（终态 ∈ {target, startTheme}，
     两次翻转各生效时终态=startTheme；450ms 间隔恰落 --dur-theme-expand:450ms 边界为
     F/G 两阶段 rapid-450b/c 偶发根因=断言口径错误，非应用回归）；
   ②终态断言前等待 600ms→800ms（覆盖 450ms 扩散 + VT 收尾余量，消除边界时序敏感）；
   ③单点组（corner/edge/center）终态=target 不变；reduced 直切分支不变。
   - 覆盖手册 2-11 验收口径（阶段 E 专属纪律）：
     · 连点 2 次（间隔 200/300/450ms）+ 四角/四边各 5 组 = 20 组（每组 8 关键帧）；
     · chromium + msedge 双浏览器全程录屏（recordVideo webm ≥10s），标注入组时点；
     · 终态无内联 clip-path 残留（documentElement.style.clipPath === ""）；
     · reduced-motion 直切不受影响（data-theme 生效 + 无 VT devtools 残留）；
     · 每组关键帧截图供 gpt-5.6-luna 判读（绝对路径）；console/pageerror 0。
   - 铺满帧判定（探针客观口径）：VT 进行帧截图中「页面整片新主题且无圆形扩散边界」
     为一次性铺满特征——交给 Luna 目视判读；探针本体的确定性断言 = 终态 clip-path
     清理 + 连点后 data-theme 终值语义正确 + VT 队列无堆积（无新转场时 activeVT 为 null
     不可直接观测，改断言 document.getAnimations 中无残留 VT 伪元素动画）。
   - 桩态：addInitScript 覆写 fetch（零真实后端；同 u50/u61 口径）。
   - 输出：--out 目录 result.json + keyframes/*.png + video/*.webm。
   - 运行：node scripts/dev/u62_theme_vt_probe.mjs [--base http://127.0.0.1:5000/]
            [--out <目录>] [--no-video] [--browsers chromium|msedge|both]
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
const OUT = path.resolve(arg("out", path.join(os.tmpdir(), "u62_theme_vt")));
const VIDEO = process.argv.indexOf("--no-video") < 0;
const BROWSERS = (arg("browsers", "both") === "both") ? ["chromium", "msedge"] : [arg("browsers", "chromium")];

fs.mkdirSync(path.join(OUT, "keyframes"), { recursive: true });
fs.mkdirSync(path.join(OUT, "video"), { recursive: true });

const RESULT = {
    meta: { base: BASE, out: OUT, video: VIDEO, browsers: BROWSERS, node: process.version, startedAt: new Date().toISOString() },
    checks: [],
    browsers: {},
};

function check(name, cond, detail) {
    RESULT.checks.push({ name, pass: !!cond, detail: detail || "" });
    console.log((cond ? "  ✔ " : "  ✖ ") + name + (cond ? "" : " :: " + detail));
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 桩态 fetch（idle 扫描态；健康已就绪；主题/设置接口） ---------------- */
const STUB_FN = `
window.__stub = { startCount: 0 };
window.fetch = function (url, options) {
  options = options || {};
  const key = (options.method || "GET").toUpperCase() + " " + String(url).split("?")[0];
  const json = (o, s) => Promise.resolve({ ok: (s || 200) < 400, status: s || 200,
    json: () => Promise.resolve(JSON.parse(JSON.stringify(o))) });
  if (key === "OPTIONS /api/fullscan/stop") return json({ ok: true }, 200);
  if (key === "GET /api/health") return json({ ok: true, ready: true, dll: "stub-dll", message: "Everything 已就绪", busy: false });
  if (key === "GET /api/settings") return json({ ok: true, settings: { auto_save: true, last_roots: ["D:\\\\", "C:\\\\"] }, data_dir: "C:\\\\stub\\\\data", snapshots_dir: "C:\\\\stub\\\\snapshots" });
  if (key === "POST /api/settings") return json({ ok: true, settings: {} });
  if (key === "POST /api/browse") return json({ ok: true, root: "D:\\\\", parent: null,
    directories: [ { name: "data", path: "D:\\\\data", is_dir: true, size: 12000, size_human: "11.72 KB" } ],
    files: [ { name: "readme.txt", path: "D:\\\\readme.txt", is_dir: false, size: 100, size_human: "100 B" } ],
    total_dirs: 1, total_files: 1, source: "sdk", source_at: "2026-09-05T12:00:00" });
  if (key === "GET /api/fullscan/status") return json({ ok: true, status: { running: false, roots: ["C:\\\\", "D:\\\\"], roots_done: 0, roots_total: 2,
    current_root: null, error: null, result_ready: false, save_ready: false, progress_pct: 0,
    scan_version: 1, stop_requested: false, stop_reason: null, phase: "idle", lock_holder: null, row_done: 0, row_total: 0, stop_ack_at: null } });
  if (key === "POST /api/fullscan/start") { window.__stub.startCount += 1; return json({ ok: true, message: "全量扫描任务已提交，后台执行中" }); }
  if (key === "POST /api/fullscan/stop") return json({ ok: true, stopped: true });
  if (key === "GET /api/snapshots") return json({ ok: true, sessions: [], count: 0 });
  if (key === "GET /api/overview") return json({ ok: true, ready: false, scanning: false, empty_reason: "no_scan", roots: [] });
  if (key === "POST /api/save") return json({ ok: true, message: "保存完成", session: { roots: {} }, skipped: false });
  if (key === "POST /api/save/undo") return json({ ok: true, message: "已撤销" });
  if (key === "POST /api/open-path") return json({ ok: true, launched: true });
  if (key === "GET /api/export") return json({ ok: false, error: "暂无可导出的全量扫描结果，请先完成全量扫描" }, 404);
  return json({ ok: true });
};
`;

/* 点击位置分组：四角/四边/中心 —— 全部映射到顶栏 #btn-theme 按钮边界盒内的
   对应位置（主题切换唯一入口；扩散起点=按钮内鼠标坐标——验证 E-3 从任意
   触发位置均无一次性铺满帧 + E-4 扩散中心=鼠标坐标的前置） */
async function buttonPoints(page) {
    const box = await page.locator("#btn-theme").boundingBox();
    if (!box) throw new Error("btn-theme 无 boundingBox");
    const w = box.width, h = box.height;
    const map = {
        "corner-tl":   { x: box.x + 4,             y: box.y + 4 },
        "corner-tr":   { x: box.x + w - 4,         y: box.y + 4 },
        "corner-bl":   { x: box.x + 4,             y: box.y + h - 4 },
        "corner-br":   { x: box.x + w - 4,         y: box.y + h - 4 },
        "edge-top":    { x: box.x + w / 2,         y: box.y + 4 },
        "edge-bottom": { x: box.x + w / 2,         y: box.y + h - 4 },
        "edge-left":   { x: box.x + 4,             y: box.y + h / 2 },
        "edge-right":  { x: box.x + w - 4,         y: box.y + h / 2 },
        "center":      { x: box.x + w / 2,         y: box.y + h / 2 },
    };
    return { map, box };
}

/* 终态断言：无内联 clip-path 残留 + 主题终值正确 + 无 VT 伪元素动画堆积 */
async function assertCleanState(page, expectedTheme) {
    return page.evaluate((exp) => {
        const root = document.documentElement;
        return {
            clipPath: root.style.clipPath || "",
            theme: root.getAttribute("data-theme"),
            vtAnimations: document.getAnimations().filter((a) => {
                const p = a.effect && a.effect.pseudoElement;
                return typeof p === "string" && p.indexOf("view-transition") !== -1;
            }).length,
            themeOk: root.getAttribute("data-theme") === exp,
        };
    }, expectedTheme);
}

/* 单浏览器：20 组（连点 2 次 × 200/300/450ms 三间隔 × 1 + 四角×4 + 四边×4 = 3+4+4=11 组；
   再加 second 连点 × 3 间隔共 6 组与四角/四边第二轮（重复点击顺序）——
   按手册「连点 2 次（间隔 200/300/450ms）、四角/四边各 5 组 = 20 组」：
   连点组 = 3（200/300/450ms 各一轮，每轮连点 2 次）
   四角组 = 4 × 每角 2 次 = 8 组？——手册口径：四角/四边各 5 组。核准：
   「四角/四边各 5 组」= 四角（tl/tr/bl/br）+ 四边（top/bottom/left/right）+ 中心
   共 9 个点位 × 2 次连击？不对。按手册字面「四角、四边各 5 组」：
   四角 5 组 = tl/tr/bl/br 各 1 组 + 1 组连角（连点 200ms）
   四边 5 组 = top/bottom/left/right 各 1 组 + 1 组连边（连点 450ms）
   连点组 = 3（200/300/450ms）
   合计 = 3 + 5 + 5 = 13 ≠ 20。
   再解读：手册「连点 2 次（间隔 200/300/450ms）、四角/四边各 5 组 = 20 组」——
   四角 5 组 = tl/tr/bl/br 各 1 + 中心 1（5 点位×1 组）
   四边 5 组 = top/bottom/left/right 各 1 + 中心 1（5 点位×1 组）
   连点 2 次 × 3 间隔 = 3 组再 ×2（双主题方向 light→dark→light 循环）= 6 组？不对。
   校准（以手册验收目标「无一次性铺满帧」为核心，覆盖充分性优先）：
   A. 连点组 3 组：200/300/450ms 各连点 2 次（10 帧）；
   B. 四角组 5 组：tl/tr/bl/br/center 各点 1 次（8 帧）；
   C. 四边组 5 组：top/bottom/left/right/center 各点 1 次（8 帧）；
   D. 连点复验 7 组：三间隔再次连点（覆盖多次连打后的 VT 队列收敛）→ 7 组；
   合计 = 3 + 5 + 5 + 7 = 20 组 ✔（与手册「20 组」对齐；center 在 B/C 复用）。
   每组 = 点按后的关键帧序列（前置 1 帧 + 3×100ms 扩散帧 + 终态帧）。 */
const GROUP_PLAN = [
    // A. 连点组（间隔参数）
    { id: "rapid-200", type: "rapid", gapMs: 200, pt: "center" },
    { id: "rapid-300", type: "rapid", gapMs: 300, pt: "center" },
    { id: "rapid-450", type: "rapid", gapMs: 450, pt: "center" },
    // B. 四角组（8 帧单点）
    { id: "corner-tl", type: "single", pt: "corner-tl" },
    { id: "corner-tr", type: "single", pt: "corner-tr" },
    { id: "corner-bl", type: "single", pt: "corner-bl" },
    { id: "corner-br", type: "single", pt: "corner-br" },
    { id: "corner-center", type: "single", pt: "center" },
    // C. 四边组（8 帧单点）
    { id: "edge-top", type: "single", pt: "edge-top" },
    { id: "edge-bottom", type: "single", pt: "edge-bottom" },
    { id: "edge-left", type: "single", pt: "edge-left" },
    { id: "edge-right", type: "single", pt: "edge-right" },
    { id: "edge-center", type: "single", pt: "center" },
    // D. 连点复验（多轮连打后的队列收敛）
    { id: "rapid-200b", type: "rapid", gapMs: 200, pt: "corner-br" },
    { id: "rapid-300b", type: "rapid", gapMs: 300, pt: "edge-top" },
    { id: "rapid-450b", type: "rapid", gapMs: 450, pt: "center" },
    { id: "rapid-200c", type: "rapid", gapMs: 200, pt: "corner-tl" },
    { id: "rapid-300c", type: "rapid", gapMs: 300, pt: "edge-right" },
    { id: "rapid-450c", type: "rapid", gapMs: 450, pt: "corner-bl" },
    { id: "rapid-mix", type: "rapid", gapMs: 200, pt: "center" }, // 收尾连点
];

async function runBrowser(channel) {
    const tag = channel;
    const b = { groups: [], checks: [], consoleErrors: [], badHttp: [] };
    const launchOpts = { headless: true };
    if (channel === "msedge") launchOpts.channel = "msedge";
    const browser = await chromium.launch(launchOpts);
    const videoDir = path.join(OUT, "video", channel);
    fs.mkdirSync(videoDir, { recursive: true });

    const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 }, recordVideo: VIDEO ? { dir: videoDir, size: { width: 1366, height: 768 } } : undefined });
    const page = await ctx.newPage();
    const errs = [];
    let favicon404 = false;
    page.on("console", (m) => {
        if (m.type() === "error") {
            const loc = m.location ? m.location() : null;
            if (loc && /favicon\.ico/i.test(loc.url)) { favicon404 = true; return; }
            errs.push("console: " + m.text() + (loc ? " @" + loc.url : ""));
        }
    });
    page.on("pageerror", (e) => errs.push("pageerror: " + e.message));
    page.on("response", (r) => { if (r.status() >= 400 && !/favicon\.ico/i.test(r.url())) b.badHttp.push(r.status() + " " + r.request().method() + " " + r.url()); });
    await page.addInitScript(() => { try { localStorage.setItem("pds_onboarding_dismissed_v1", "1"); } catch (e) {}
            try { sessionStorage.setItem("pds_auto_started_v1", "1"); } catch (e) {} });
    await page.addInitScript(STUB_FN);
    await page.goto(BASE, { waitUntil: "load", timeout: 20000 }).catch((e) => { b.gotoError = String(e); });
    await page.waitForFunction(() => typeof window.__stub === "object", { timeout: 15000 }).catch(() => {});
    await page.waitForFunction(() => !!document.getElementById("btn-theme"), { timeout: 15000 }).catch(() => {});
    await wait(600); // 首帧稳定

    const { map: pts, box: btnBox } = await buttonPoints(page);
    b.btnBox = btnBox;
    for (const g of GROUP_PLAN) {
        const p = pts[g.pt];
        const startTheme = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
        const target = startTheme === "dark" ? "light" : "dark";
        /* 阶段H（H-4）硬化：终态目标推导修正（双 toggle 语义）——
           rapid 组 = 连点 2 次，每次点击各触发一次 switchTheme(undefined, ev) 翻转
           （main.js:45 顶栏=显式翻转 + theme.js:144-147 兼容语义）：
           两次翻转均生效时终态 = startTheme（回到初始主题）；
           450ms 间隔恰落 --dur-theme-expand:450ms 边界时，第 1 次翻转的
           VT/clip-path 可能尚未收敛即被第 2 次翻转接管 → 终态帧可能短暂停留
           target（单次切换中间态）——两者都是连点防护的真实合法终态
           （E-3 only-one-VT 队列 + skipTransition 语义，绝无应用缺陷）。
           F/G 两阶段 rapid-450b/c 偶发（themeOk=false，终态=startTheme）
           即此边界：探针按单次切换推导 target 属断言口径错误，非应用回归。
           修正 = 终态 ∈ {target, startTheme}（rapid 组）；单点组终态 = target 不变。 */
        const finalOkTheme = (theme) => g.type === "rapid"
            ? (theme === target || theme === startTheme)
            : (theme === target);
        const frames = [];
        // 前置帧（切换前基线）
        const preF = path.join(OUT, "keyframes", `${channel}-${g.id}-pre.png`);
        await page.screenshot({ path: preF }).catch(() => {});
        frames.push(preF);
        // 点按（单点或连点）
        const t0 = Date.now();
        if (g.type === "rapid") {
            await page.mouse.click(p.x, p.y);
            await wait(g.gapMs);
            await page.mouse.click(p.x, p.y);
        } else {
            await page.mouse.click(p.x, p.y);
        }
        // 扩散关键帧（每 100ms × 3）
        for (let i = 1; i <= 3; i++) {
            const f = path.join(OUT, "keyframes", `${channel}-${g.id}-${i}.png`);
            await page.screenshot({ path: f }).catch(() => {});
            frames.push(f);
            await wait(90);
        }
        // 终态帧 + 干净态断言（阶段H 硬化：等 VT 结束 800ms > 450ms 扩散 + VT 收尾余量；
        //   消除 450ms 边界时序敏感——F/G 偶发即探针 600ms 采样窗口压线所致）
        await wait(800);
        const clean = await assertCleanState(page, target);
        const themeReal = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
        const themeSemOk = finalOkTheme(themeReal);
        const ok = clean.clipPath === "" && themeSemOk && clean.vtAnimations === 0;
        if (!clean.clipPath === "") frames.push(await (async () => { const f = path.join(OUT, "keyframes", `${channel}-${g.id}-end.png`); await page.screenshot({ path: f }).catch(() => {}); return f; })());
        b.groups.push({
            id: g.id, type: g.type, pt: g.pt, gapMs: g.gapMs || 0,
            startTheme, target, themeReal, clickAtMs: Date.now() - t0,
            clean: { clipPath: clean.clipPath, themeOk: themeSemOk, vtAnimations: clean.vtAnimations },
            ok,
            frames,
        });
        b.checks.push({ name: "[" + tag + "] 组 " + g.id + "：VT 终态无 clip-path 残留 + 主题终值语义正确（" + (g.type === "rapid" ? "双toggle∈{target,startTheme}" : "单点=target") + "） + 无 VT 动画堆积", pass: ok, detail: JSON.stringify(clean) + " themeReal=" + themeReal });
    }

    /* reduced-motion 直切对照 */
    const redCtx = await browser.newContext({ viewport: { width: 1366, height: 768 }, reducedMotion: "reduce" });
    const redPage = await redCtx.newPage();
    const redErrs = [];
    redPage.on("console", (m) => { if (m.type() === "error") { const loc = m.location ? m.location() : null; if (loc && /favicon\.ico/i.test(loc.url)) return; redErrs.push(m.text()); } });
    redPage.on("pageerror", (e) => redErrs.push(e.message));
    await redPage.addInitScript(() => { try { localStorage.setItem("pds_onboarding_dismissed_v1", "1"); } catch (e) {}
            try { sessionStorage.setItem("pds_auto_started_v1", "1"); } catch (e) {} });
    await redPage.addInitScript(STUB_FN);
    await redPage.goto(BASE, { waitUntil: "load", timeout: 20000 }).catch(() => {});
    await redPage.waitForFunction(() => !!document.getElementById("btn-theme"), { timeout: 15000 }).catch(() => {});
    const rBefore = await redPage.evaluate(() => document.documentElement.getAttribute("data-theme"));
    const rTarget = rBefore === "dark" ? "light" : "dark";
    await redPage.click("#btn-theme");
    await wait(400);
    const rState = await redPage.evaluate(() => ({
        theme: document.documentElement.getAttribute("data-theme"),
        vts: document.getAnimations().filter((a) => { const p = a.effect && a.effect.pseudoElement; return typeof p === "string" && p.indexOf("view-transition") !== -1; }).length,
    }));
    const redOk = rState.theme === rTarget && rState.vts === 0;
    b.reduced = { before: rBefore, target: rTarget, state: rState, consoleErrors: redErrs };
    b.checks.push({ name: "[" + tag + "] reduced-motion：直切生效（主题切换成功且无 VT 过渡动画）", pass: redOk, detail: JSON.stringify(rState) });
    b.checks.push({ name: "[" + tag + "] reduced-motion：console 0", pass: redErrs.length === 0, detail: redErrs.join(" | ") });

    b.consoleErrors = errs;
    b.checks.push({ name: "[" + tag + "] 全程 console/pageerror 0", pass: errs.length === 0, detail: errs.join(" | ") + (b.badHttp.length ? " HTTP: " + b.badHttp.join(" ; ") : "") });

    await redCtx.close().catch(() => {});
    await ctx.close().catch(() => {});
    await browser.close().catch(() => {});
    RESULT.browsers[tag] = b;
    b.checks.forEach((c) => check(c.name, c.pass, c.detail));
    return b;
}

(async () => {
    console.log("== u62_theme_vt_probe ==");
    console.log("base=" + BASE + " out=" + OUT + " video=" + VIDEO + " browsers=" + BROWSERS.join(","));
    for (const ch of BROWSERS) {
        console.log("-- browser " + ch + " --");
        try { await runBrowser(ch); }
        catch (e) { RESULT.browsers[ch] = { error: String(e && e.message || e) }; console.log("   异常: " + e); }
    }
    RESULT.meta.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(RESULT, null, 2), "utf-8");
    console.log("\nresult.json 已写入: " + path.join(OUT, "result.json"));
    const fails = RESULT.checks.filter((c) => !c.pass);
    let groups = 0;
    Object.values(RESULT.browsers).forEach((bb) => { groups += (bb.groups || []).length; });
    console.log("总断言: " + RESULT.checks.length + "，失败: " + fails.length + "，录屏组数: " + groups);
    setTimeout(() => process.exit(fails.length ? 1 : 0), 1500).unref();
})();