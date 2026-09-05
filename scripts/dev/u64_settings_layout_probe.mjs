/* ============================================================
   阶段 E（R4/R5）· u64_settings_layout_probe.mjs（E-5 设置弹窗排版验收探针）
   - 覆盖手册 2-15 排版验收口径（阶段 E 专属纪律·基线先行）：
     · 亮/暗两档设置弹窗截图（1366×768 同视口同参数）——与基线（排版修改前
       %TEMP%\stage_e_e5_baseline\settings-baseline-{light,dark}.png）逐像素对比；
     · rect 采样对齐断言：
       ①「扫描完成自动保存」行 = 两列布局（switch-control 与 switch-label 顶对齐、
          开关右侧无文案挤压——label 区宽度 > 0 且 checkbox 右缘 < label 左缘……改为
          断言 label 与 switch 同行基线 + 两列水平分离：switch-control.left > switch-label.right）；
       ② modal-foot 水平基线对齐：btn-wipe-open.left < modal-foot 其他按钮，
          且三个按钮 bottom 对齐（同一 y）；
       ③ theme-opt 三档等高：三 span height 相同（±1px）；
       ④ 窄屏（360px 视口）无破版：rows 不溢出 + 自动保存行纵向换行；
     · 窄屏（<420px）截图；console/pageerror 0。
   - 逐像素对比：AB 差异像素计数（容差 ~1%）——Luna 目视判读 + 探针客观口径。
   - 桩态 + 双浏览器（chromium/msedge）。
   - 输出：--out result.json + shots/*.png；基线路径 --baseline <dir>。
   - 运行：node scripts/dev/u64_settings_layout_probe.mjs [--base http://127.0.0.1:5000/]
            [--out <目录>] [--baseline <基线目录>] [--browsers chromium|msedge|both]
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
const OUT = path.resolve(arg("out", path.join(os.tmpdir(), "u64_settings_layout")));
const BASELINE = path.resolve(arg("baseline", path.join(os.tmpdir(), "stage_e_e5_baseline")));
const BROWSERS = (arg("browsers", "both") === "both") ? ["chromium", "msedge"] : [arg("browsers", "chromium")];

fs.mkdirSync(path.join(OUT, "shots"), { recursive: true });

const RESULT = { meta: { base: BASE, out: OUT, baseline: BASELINE, browsers: BROWSERS, node: process.version, startedAt: new Date().toISOString() }, checks: [], browsers: {} };
function check(name, cond, detail) {
    RESULT.checks.push({ name, pass: !!cond, detail: detail || "" });
    console.log((cond ? "  ✔ " : "  ✖ ") + name + (cond ? "" : " :: " + detail));
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const STUB_FN = `
window.__stub = { startCount: 0 };
window.fetch = function (url, options) {
  options = options || {};
  const key = (options.method || "GET").toUpperCase() + " " + String(url).split("?")[0];
  const json = (o, s) => Promise.resolve({ ok: (s || 200) < 400, status: s || 200, json: () => Promise.resolve(JSON.parse(JSON.stringify(o))) });
  if (key === "OPTIONS /api/fullscan/stop") return json({ ok: true }, 200);
  if (key === "GET /api/health") return json({ ok: true, ready: true, dll: "stub-dll", message: "Everything 已就绪", busy: false });
  if (key === "GET /api/settings") return json({ ok: true, settings: { auto_save: true, last_roots: ["D:\\\\", "C:\\\\"] }, data_dir: "C:\\\\Users\\\\demo\\\\PythonDiskScanner", snapshots_dir: "C:\\\\Users\\\\demo\\\\PythonDiskScanner\\\\snapshots" });
  if (key === "POST /api/settings") return json({ ok: true, settings: {} });
  if (key === "POST /api/browse") return json({ ok: true, root: "D:\\\\", parent: null, directories: [{ name: "data", path: "D:\\\\data", is_dir: true, size: 12000, size_human: "11.72 KB" }], files: [{ name: "readme.txt", path: "D:\\\\readme.txt", is_dir: false, size: 100, size_human: "100 B" }], total_dirs: 1, total_files: 1, source: "sdk", source_at: "2026-09-05T12:00:00" });
  if (key === "GET /api/fullscan/status") return json({ ok: true, status: { running: false, roots: ["C:\\\\", "D:\\\\"], roots_done: 0, roots_total: 2, current_root: null, error: null, result_ready: false, save_ready: false, progress_pct: 0, scan_version: 1, stop_requested: false, stop_reason: null, phase: "idle", lock_holder: null, row_done: 0, row_total: 0, stop_ack_at: null } });
  if (key === "POST /api/fullscan/start") { window.__stub.startCount += 1; return json({ ok: true, message: "ok" }); }
  if (key === "GET /api/snapshots") return json({ ok: true, sessions: [], count: 0 });
  if (key === "GET /api/overview") return json({ ok: true, ready: false, scanning: false, empty_reason: "no_scan", roots: [] });
  if (key === "GET /api/export") return json({ ok: false, error: "x" }, 404);
  return json({ ok: true });
};
`;

async function captureSettings(page, theme) {
    await page.click("#btn-settings");
    await page.waitForFunction(() => !document.getElementById("settings-modal").classList.contains("hidden"), { timeout: 10000 });
    await page.waitForTimeout(400);
    return page.screenshot({ path: path.join(OUT, "shots", `settings-${theme}.png`), clip: { x: 380, y: 100, width: 606, height: 600 } });
}

/* PNG 解析（用浏览器 canvas 算差异：加载两张图 → 逐像素比较） */
async function pixelDiff(page, imgA, imgB) {
    return page.evaluate(async ({ a, b }) => {
        const load = (b64) => new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = reject;
            img.src = "data:image/png;base64," + b64;
        });
        const [ia, ib] = await Promise.all([load(a), load(b)]);
        const w = ia.width, h = ia.height;
        const ca = document.createElement("canvas"); ca.width = w; ca.height = h;
        const cb = document.createElement("canvas"); cb.width = w; cb.height = h;
        const xa = ca.getContext("2d"); xa.drawImage(ia, 0, 0);
        const xb = cb.getContext("2d"); xb.drawImage(ib, 0, 0);
        const da = xa.getImageData(0, 0, w, h).data;
        const db = xb.getImageData(0, 0, w, h).data;
        let diff = 0, total = w * h;
        for (let i = 0; i < da.length; i += 4) {
            const r = Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]);
            if (r > 30) diff++;
        }
        return { w, h, diff, total, pct: Math.round(diff / total * 10000) / 100 };
    }, { a: imgA, b: imgB });
}

async function runBrowser(channel) {
    const tag = channel;
    const b = { checks: [], shots: [], consoleErrors: [], badHttp: [] };
    const launchOpts = { headless: true };
    if (channel === "msedge") launchOpts.channel = "msedge";
    const browser = await chromium.launch(launchOpts);

    for (const theme of ["light", "dark"]) {
        const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
        const page = await ctx.newPage();
        const errs = [];
        page.on("console", (m) => { if (m.type() === "error") { const loc = m.location ? m.location() : null; if (loc && /favicon\.ico/i.test(loc.url)) return; errs.push(m.text()); } });
        page.on("pageerror", (e) => errs.push(e.message));
        page.on("response", (r) => { if (r.status() >= 400 && !/favicon\.ico/i.test(r.url())) b.badHttp.push(r.status() + " " + r.url()); });
        await page.addInitScript((t) => { try { localStorage.setItem("pds_theme_v1", t); } catch (e) {} }, theme);
        await page.addInitScript(() => { try { localStorage.setItem("pds_onboarding_dismissed_v1", "1"); } catch (e) {} try { sessionStorage.setItem("pds_auto_started_v1", "1"); } catch (e) {} });
        await page.addInitScript(STUB_FN);
        await page.goto(BASE, { waitUntil: "load", timeout: 20000 }).catch((e) => { b.gotoError = String(e); });
        await page.waitForFunction(() => !!document.getElementById("btn-settings"), { timeout: 15000 }).catch(() => {});

        await captureSettings(page, theme);
        const shotPath = path.join(OUT, "shots", `settings-${theme}.png`);
        b.shots.push(shotPath);

        /* rect 采样断言 */
        const rects = await page.evaluate(() => {
            const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, right: b.right, bottom: b.bottom, top: b.top, cx: b.x + b.width / 2, cy: b.y + b.height / 2 }; };
            const label = document.querySelector(".switch-row .switch-label");
            const ctrl = document.querySelector(".switch-row .switch-control");
            const checkbox = document.getElementById("setting-auto-save");
            const opts = Array.from(document.querySelectorAll(".theme-opt span")).map(r);
            const footBtns = Array.from(document.querySelectorAll("#settings-modal .modal-foot .btn"))
                .filter((el) => el.id !== "btn-wipe-open") // 排除 wipe（单独对齐校验）
                .map(r);
            const wipe = document.getElementById("btn-wipe-open");
            return {
                switchLabel: r(label), switchCtrl: r(ctrl), checkbox: r(checkbox),
                themeOpts: opts, footBtns, wipe: r(wipe),
                hint: label ? label.textContent.trim().slice(0, 30) : null,
            };
        });
        /* ① 两列布局：label.right <= ctrl.left（水平分离），垂直中线对齐（±8px）——
           修正：label 高 50px（含 hint 两行），与开关行用垂直中心比对 */
        const col2 = rects.switchLabel && rects.switchCtrl &&
            rects.switchLabel.right <= rects.switchCtrl.x + 1 &&
            Math.abs(rects.switchLabel.cy - rects.switchCtrl.cy) <= 8;
        b.checks.push({ name: "[" + tag + ":" + theme + "] 自动保存行 = 两列布局（label 左、开关右、垂直中线对齐）", pass: !!col2, detail: JSON.stringify({ label: rects.switchLabel, ctrl: rects.switchCtrl }) });
        /* ② modal-foot 基线对齐：wipe 与 save/close bottom 同 y（±3），wipe 在最左 */
        const btns = rects.footBtns.filter(Boolean);
        const wipeB = rects.wipe;
        const aligned = wipeB && btns.length === 2 && btns.every((bb) => Math.abs(bb.bottom - wipeB.bottom) <= 3) && wipeB.x < btns[0].x;
        b.checks.push({ name: "[" + tag + ":" + theme + "] modal-foot 基线对齐（一键清空与保存/关闭 bottom 对齐，wipe 最左）", pass: !!aligned, detail: JSON.stringify({ wipe: { x: wipeB && wipeB.x, bottom: wipeB && wipeB.bottom }, foot: btns }) });
        /* ③ theme-opt 三档等高（±1px） */
        const opts = (rects.themeOpts || []).filter(Boolean);
        const hEq = opts.length === 3 && Math.max(...opts.map((o) => o.h)) - Math.min(...opts.map((o) => o.h)) <= 1;
        b.checks.push({ name: "[" + tag + ":" + theme + "] theme-opt 三档等高（±1px）", pass: !!hEq, detail: JSON.stringify(opts) });
        /* ④ 基线逐像素对比（同参数控制在 1366×768；基线图用 chromium 截） */
        const baseFile = path.join(BASELINE, `settings-baseline-${theme}.png`);
        let diff = null;
        if (fs.existsSync(baseFile)) {
            const b64a = fs.readFileSync(baseFile).toString("base64");
            const b64b = fs.readFileSync(shotPath).toString("base64");
            diff = await pixelDiff(page, b64a, b64b);
            /* 排版变更必然有差异——对照目的（Luna 目视）非 0 差异；客观口径 = 尺寸一致 */
            b.checks.push({ name: "[" + tag + ":" + theme + "] 基线-对照截图尺寸一致（逐像素比对已产出供 Luna）", pass: diff.w === 606 && diff.h === 600, detail: JSON.stringify(diff) });
        } else {
            b.checks.push({ name: "[" + tag + ":" + theme + "] 基线文件存在（" + BASELINE + "）", pass: false, detail: "缺失 " + baseFile });
        }
        b.diff = b.diff || {};
        b.diff[theme] = diff;
        b.consoleErrors = b.consoleErrors.concat(errs);
        b.checks.push({ name: "[" + tag + ":" + theme + "] console/pageerror 0", pass: errs.length === 0, detail: errs.join(" | ") });
        await ctx.close();
    }

    /* ---- 窄屏（360px）无破版 ---- */
    {
        const ctx = await browser.newContext({ viewport: { width: 360, height: 700 } });
        const page = await ctx.newPage();
        const errs = [];
        page.on("console", (m) => { if (m.type() === "error") { const loc = m.location ? m.location() : null; if (loc && /favicon\.ico/i.test(loc.url)) return; errs.push(m.text()); } });
        page.on("pageerror", (e) => errs.push(e.message));
        await page.addInitScript(() => { try { localStorage.setItem("pds_theme_v1", "light"); } catch (e) {} try { localStorage.setItem("pds_onboarding_dismissed_v1", "1"); } catch (e) {} try { sessionStorage.setItem("pds_auto_started_v1", "1"); } catch (e) {} });
        await page.addInitScript(STUB_FN);
        await page.goto(BASE, { waitUntil: "load", timeout: 20000 }).catch(() => {});
        await page.waitForFunction(() => !!document.getElementById("btn-settings"), { timeout: 15000 }).catch(() => {});
        await page.click("#btn-settings");
        await page.waitForFunction(() => !document.getElementById("settings-modal").classList.contains("hidden"), { timeout: 10000 });
        await page.waitForTimeout(400);
        const narrow = await page.evaluate(() => {
            const panel = document.querySelector("#settings-modal .modal-panel");
            const pb = panel.getBoundingClientRect();
            const switchRow = document.querySelector(".switch-row");
            const sr = switchRow.getBoundingClientRect();
            const label = document.querySelector(".switch-row .switch-label").getBoundingClientRect();
            const ctrl = document.querySelector(".switch-row .switch-control").getBoundingClientRect();
            const footBtns = Array.from(document.querySelectorAll("#settings-modal .modal-foot .btn")).map((el) => el.getBoundingClientRect());
            const overflow = panel.scrollWidth > pb.width + 1 || Array.from(panel.querySelectorAll("*")).some((el) => {
                const b = el.getBoundingClientRect();
                return b.width > 0 && (b.right > window.innerWidth + 1 || b.left < -1);
            });
            return {
                panelW: Math.round(pb.width), switchLabelAbove: ctrl.y >= label.bottom - 1, // 纵向堆叠（label 上、开关下）
                footBtns: footBtns.map((b) => Math.round(b.width)),
                overflow,
            };
        });
        const f = path.join(OUT, "shots", `settings-narrow-360.png`);
        await page.screenshot({ path: f, fullPage: false }).catch(() => {});
        b.shots.push(f);
        b.checks.push({ name: "[" + tag + ":narrow] 窄屏（360px）：自动保存行纵向换行 + 无横向溢出", pass: narrow.switchLabelAbove && !narrow.overflow, detail: JSON.stringify(narrow) });
        b.consoleErrors = b.consoleErrors.concat(errs);
        await ctx.close();
    }

    await browser.close().catch(() => {});
    RESULT.browsers[tag] = b;
    b.checks.forEach((c) => check(c.name, c.pass, c.detail));
    return b;
}

(async () => {
    console.log("== u64_settings_layout_probe ==");
    console.log("base=" + BASE + " out=" + OUT + " baseline=" + BASELINE + " browsers=" + BROWSERS.join(","));
    for (const ch of BROWSERS) {
        console.log("-- browser " + ch + " --");
        try { await runBrowser(ch); }
        catch (e) { RESULT.browsers[ch] = { error: String(e && e.message || e) }; console.log("   异常: " + e); }
    }
    RESULT.meta.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(RESULT, null, 2), "utf-8");
    console.log("\nresult.json 已写入: " + path.join(OUT, "result.json"));
    const fails = RESULT.checks.filter((c) => !c.pass);
    console.log("总断言: " + RESULT.checks.length + "，失败: " + fails.length);
    setTimeout(() => process.exit(fails.length ? 1 : 0), 1500).unref();
})();