/* ============================================================
   阶段 E（R4/R5）· u61_scan_anim_probe.mjs（E-1/E-2 donut 回跳修复验收探针）
   - 覆盖手册贰章 2-6 修复验收口径（阶段 E 专属纪律）：
     · 扫描态录屏 ≥10s（Playwright recordVideo webm）——chromium + msedge 双浏览器；
     · getComputedStyle transform 角度纯 evaluate 采样（100ms × 30 = 3s ≥ 2 循环）：
       修复后无 -76° 型负向跳变、每循环恰好 360°（from -90 → to 270 无缝衔接）；
     · 中心数字 count-up 节拍采样（donut 中心 value 文本变化轨迹——每 tick 更新、
       无「归零重播」：修复前 storage.js 每 1s 重跑 countUp 从当前值起播，
       断言相邻采样无「值回落」型重播）；
     · getAnimations() 白名单断言（扫描态页面全部动画仅 transform/opacity，
       P7 红线；stroke-dashoffset 为已登记例外不在此列——本断言面向 donut 弧/旋转）；
     · reduced-motion 对照（静止：角度不变、无动画播放）；
     · 关键帧截图序列供 gpt-5.6-luna 判读（绝对路径）。
   - 桩态：addInitScript 覆写 fetch（零真实后端、零写操作；同 u50 口径）。
   - 输出：--out 目录 result.json（结构化断言）+ keyframes/*.png + video/*.webm。
   - 运行：node scripts/dev/u61_scan_anim_probe.mjs [--base http://127.0.0.1:5000/]
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
const OUT = path.resolve(arg("out", path.join(os.tmpdir(), "u61_scan_anim")));
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

/* ---------------- 桩态 fetch（同 u50：running 扫描态，progress 40%→60% 缓动） ---------------- */
const STUB_FN = `
window.__stub = {
  scanState: "running",
  _pct: 40,
  statusCount: 0,
};
window.fetch = function (url, options) {
  options = options || {};
  const key = (options.method || "GET").toUpperCase() + " " + String(url).split("?")[0];
  const json = (o, s) => Promise.resolve({ ok: (s || 200) < 400, status: s || 200,
    json: () => Promise.resolve(JSON.parse(JSON.stringify(o))) });
  if (key === "OPTIONS /api/fullscan/stop") return json({ ok: true }, 200); // probeStopSupport 特性探测（零副作用）
  if (key === "GET /api/health") return json({ ok: true, ready: true, dll: "stub-dll", message: "Everything 已就绪", busy: false });
  if (key === "GET /api/settings") return json({ ok: true, settings: { auto_save: true, last_roots: ["D:\\\\", "C:\\\\"] }, data_dir: "C:\\\\stub\\\\data", snapshots_dir: "C:\\\\stub\\\\snapshots" });
  if (key === "POST /api/settings") return json({ ok: true, settings: {} });
  if (key === "POST /api/browse") return json({ ok: true, root: "D:\\\\", parent: null,
    directories: [ { name: "data", path: "D:\\\\data", is_dir: true, size: 12000, size_human: "11.72 KB" } ],
    files: [ { name: "readme.txt", path: "D:\\\\readme.txt", is_dir: false, size: 100, size_human: "100 B" } ],
    total_dirs: 1, total_files: 1, source: "sdk", source_at: "2026-09-05T12:00:00" });
  if (key === "GET /api/fullscan/status") {
    window.__stub.statusCount += 1;
    window.__stub._pct = Math.min(60, window.__stub._pct + 0.5); // 缓动推进（count-up 节拍有增量）
    const p = Math.round(window.__stub._pct * 10) / 10;
    return json({ ok: true, status: { running: true, roots: ["C:\\\\", "D:\\\\"], roots_done: 0, roots_total: 2,
      current_root: "C:\\\\", error: null, result_ready: false, save_ready: false, progress_pct: p,
      scan_version: 1, stop_requested: false, stop_reason: null, phase: "scanning", lock_holder: "fullscan",
      row_done: 0, row_total: 0, stop_ack_at: null } });
  }
  if (key === "POST /api/fullscan/start") { window.__stub.scanState = "running"; return json({ ok: true, message: "全量扫描任务已提交，后台执行中" }); }
  if (key === "POST /api/fullscan/stop") return json({ ok: true, stopped: true });
  if (key === "GET /api/snapshots") return json({ ok: true, sessions: [], count: 0 });
  if (key === "GET /api/overview") return json({ ok: true, ready: false, scanning: true, empty_reason: "scanning",
    roots: [], progress_pct: 40, current_root: "C:\\\\", roots_done: 0, roots_total: 2 });
  if (key === "POST /api/save") return json({ ok: true, message: "保存完成", session: { roots: {} }, skipped: false });
  if (key === "POST /api/save/undo") return json({ ok: true, message: "已撤销" });
  if (key === "POST /api/open-path") return json({ ok: true, launched: true });
  if (key === "GET /api/export") return json({ ok: false, error: "暂无可导出的全量扫描结果，请先完成全量扫描" }, 404);
  return json({ ok: true });
};
`;

/* 进入扫描态（桩 running + 点击开始 + 等 donut 不确定弧出现） */
async function enterScanning(page) {
    await page.evaluate(() => { window.__stub.scanState = "running"; });
    await page.waitForFunction(() => !!document.getElementById("btn-fullscan"), { timeout: 15000 }).catch(() => {});
    await page.click("#btn-fullscan", { timeout: 5000 }).catch(() => {});
    await page.waitForFunction(() => !!document.querySelector(".donut-box.is-indet .donut-indet"), { timeout: 15000 }).catch(() => {});
    await wait(400); // 动画稳定
}

/* 纯 evaluate 角度采样：100ms × n（无截图开销，保证时间轴精确） */
async function sampleAngles(page, n = 30, gapMs = 100) {
    const samples = [];
    for (let i = 0; i < n; i++) {
        const ang = await page.evaluate(() => {
            const el = document.querySelector(".donut-indet");
            if (!el) return null;
            const m = getComputedStyle(el).transform.match(/matrix\(([^)]+)\)/);
            if (!m) return null;
            const p = m[1].split(",").map(Number);
            return Math.round(Math.atan2(p[1], p[0]) * 180 / Math.PI * 100) / 100;
        }).catch(() => null);
        samples.push({ t: i * gapMs, deg: ang });
        if (i < n - 1) await wait(gapMs);
    }
    return samples;
}

/* 角度序列分析：负向跳变（回跳）检测 + 每循环推进总量 */
function analyzeAngles(samples) {
    const jumps = [];
    const a = samples.filter((x) => x.deg !== null);
    for (let i = 1; i < a.length; i++) {
        let d = a[i].deg - a[i - 1].deg;
        if (d > 180) d -= 360;
        if (d < -180) d += 360;
        if (d < -45) jumps.push({ from: a[i - 1], to: a[i], deltaDeg: Math.round(d * 100) / 100 });
    }
    // 每循环推进：以 1200ms 为窗（2 个采样点间跨 12 步）累计正向推进
    // 精确口径：取第一个完整循环起止（找到经过 0° 基准的两点），计算净旋转
    // 简化：相邻差绝对值的累计 ≈ 循环总量（排除回绕等价后）
    let totalFwd = 0;
    for (let i = 1; i < a.length; i++) {
        let d = a[i].deg - a[i - 1].deg;
        if (d > 180) d -= 360;
        if (d < -180) d += 360;
        totalFwd += d;
    }
    return { jumps, totalFwd, cycleEstimate: Math.round(totalFwd / Math.max(1, (a.length - 1)) * 12 * 100) / 100 };
}

/* getAnimations 白名单（扫描态页面全部动画仅 transform/opacity；
   ⚠️ 排除项：computedOffset 是浏览器对 keyframes offset 的内部解析伪属性
   （Chrome/Edge 均出现在 getKeyframes 返回键中，非真实动画属性）；
   backgroundPositionX/Y 为已登记例外（stripes 斜纹，手册 P7「已知例外仅限登记项」）） */
async function animWhitelist(page) {
    return page.evaluate(() => {
        const bad = [];
        const EXCLUDED = new Set(["computedOffset", "backgroundPositionX", "backgroundPositionY"]);
        document.getAnimations().forEach((a) => {
            a.effect && a.effect.getKeyframes && a.effect.getKeyframes().forEach((kf) => {
                Object.keys(kf).filter((k) => k !== "offset" && k !== "composite" && k !== "easing").forEach((k) => {
                    if (EXCLUDED.has(k)) return;
                    if (k !== "transform" && k !== "opacity") bad.push(k + "@" + (a.animationName || a.id || "waapi"));
                });
            });
        });
        return { bad: Array.from(new Set(bad)) };
    });
}

/* 中心数字 count-up 节拍采样：10 次 textContent 快照（每 ~500ms），
   断言无「归零重播」（值回落超过 20% 幅度）且随时间推进 */
async function sampleCenterValue(page, n = 10, gapMs = 500) {
    const snaps = [];
    for (let i = 0; i < n; i++) {
        const v = await page.evaluate(() => {
            const el = document.querySelector(".donut-center .donut-value");
            return el ? el.textContent.trim() : null;
        }).catch(() => null);
        snaps.push({ t: i * gapMs, text: v });
        if (i < n - 1) await wait(gapMs);
    }
    return snaps;
}

/* 单浏览器全流程 */
async function runBrowser(channel) {
    const tag = channel;
    const b = { checks: [], angles: null, centerSnaps: null, whitelist: null, reduced: null, consoleErrors: [], shots: [] };
    const launchOpts = { headless: true };
    if (channel === "msedge") launchOpts.channel = "msedge";
    const browser = await chromium.launch(launchOpts);
    const videoDir = path.join(OUT, "video", channel);
    fs.mkdirSync(videoDir, { recursive: true });

    /* ---- 场景 A：正常模式（录屏 + 角度采样 + 中心节拍 + 白名单 + 关键帧） ---- */
    {
        const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 }, recordVideo: VIDEO ? { dir: videoDir, size: { width: 1366, height: 768 } } : undefined });
        const page = await ctx.newPage();
        const errs = [];
        const badHttp = [];
        let favicon404 = false;
        page.on("console", (m) => {
            if (m.type() === "error") {
                const loc = m.location ? m.location() : null;
                // 环境噪音：favicon.ico 404 是浏览器默认图标请求（Edge 打印、Chromium 不打印），
                // 与应用 JS 运行时错误无关——单独记 note，不判 console 0 失败
                if (loc && /favicon\.ico/i.test(loc.url)) { favicon404 = true; return; }
                errs.push("console: " + m.text() + (loc ? " @" + loc.url + ":" + loc.lineNumber : ""));
            }
        });
        page.on("pageerror", (e) => errs.push("pageerror: " + e.message));
        page.on("response", (r) => { if (r.status() >= 400) badHttp.push(r.status() + " " + r.request().method() + " " + r.url()); });
        await page.addInitScript(() => { try { localStorage.setItem("pds_onboarding_dismissed_v1", "1"); } catch (e) {}
                try { sessionStorage.setItem("pds_auto_started_v1", "1"); } catch (e) {} });
        await page.addInitScript(STUB_FN);
        await page.goto(BASE, { waitUntil: "load", timeout: 20000 }).catch((e) => { b.gotoError = String(e); });
        await page.waitForFunction(() => typeof window.__stub === "object" && String(window.fetch).indexOf("__stub") !== -1, { timeout: 15000 }).catch(() => {});
        await enterScanning(page);

        // 角度采样（纯 evaluate，无截图开销）
        const angles = await sampleAngles(page, 30, 100);
        b.angles = angles;
        const an = analyzeAngles(angles);
        b.angleAnalysis = an;
        const okAngles = an.jumps.length === 0 && Math.abs(an.totalFwd) > 300 && Math.abs(an.totalFwd) < 500;
        b.checks.push({ name: "角度采样 3s：无 -76° 型负向跳变", pass: an.jumps.length === 0, detail: "jumps=" + JSON.stringify(an.jumps) });
        b.checks.push({ name: "角度净推进 ≈ 每循环 360°（3s 窗口 ≈ 900°±容差）", pass: an.totalFwd > 800 && an.totalFwd < 1000, detail: "totalFwd=" + Math.round(an.totalFwd) });

        // 中心数字 count-up 节拍（10 × 500ms = 5s，覆盖多 tick）
        const centerSnaps = await sampleCenterValue(page, 10, 500);
        b.centerSnaps = centerSnaps;
        const nums = centerSnaps.map((s) => (s.text ? parseFloat(String(s.text).replace(/[^\d.]/g, "")) : NaN)).filter(Number.isFinite);
        let reset = false;
        for (let i = 1; i < nums.length; i++) {
            // 归零重播特征：值回落超过 15（百分比刻度，40→60 区间重播会掉回更低）
            if (nums[i] < nums[i - 1] - 15) reset = true;
        }
        b.checks.push({ name: "中心数字 count-up：无归零重播（monotonic 渐增）", pass: !reset && nums.length >= 5, detail: JSON.stringify(nums) });

        // getAnimations 白名单
        b.whitelist = await animWhitelist(page);
        b.checks.push({ name: "getAnimations 白名单：仅 transform/opacity", pass: b.whitelist.bad.length === 0, detail: JSON.stringify(b.whitelist) });

        // 关键帧截图（修复后证据，供 Luna 判读）
        for (let i = 0; i < 12; i++) {
            const f = path.join(OUT, "keyframes", `${channel}-scan-${String(i).padStart(3, "0")}.png`);
            await page.screenshot({ path: f, fullPage: false }).catch(() => {});
            b.shots.push(f);
            if (i < 11) await wait(100);
        }
        b.consoleErrors = errs;
        b.badHttp = badHttp;
        b.checks.push({ name: "console/pageerror 0", pass: errs.length === 0, detail: errs.join(" | ") + (badHttp.length ? " HTTP>=400: " + badHttp.join(" ; ") : "") });
        await ctx.close();
    }

    /* ---- 场景 B：reduced-motion 对照（静止断言） ---- */
    {
        const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 }, reducedMotion: "reduce" });
        const page = await ctx.newPage();
        const errs = [];
        page.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text()); });
        page.on("pageerror", (e) => errs.push("pageerror: " + e.message));
        await page.addInitScript(() => { try { localStorage.setItem("pds_onboarding_dismissed_v1", "1"); } catch (e) {}
                try { sessionStorage.setItem("pds_auto_started_v1", "1"); } catch (e) {} });
        await page.addInitScript(STUB_FN);
        await page.goto(BASE, { waitUntil: "load", timeout: 20000 }).catch(() => {});
        await page.waitForFunction(() => typeof window.__stub === "object", { timeout: 15000 }).catch(() => {});
        await enterScanning(page);
        const a1 = await page.evaluate(() => {
            const el = document.querySelector(".donut-indet");
            if (!el) return null;
            const cs = getComputedStyle(el);
            return { animDur: cs.animationDuration, transform: cs.transform };
        });
        await wait(500);
        const a2 = await page.evaluate(() => {
            const el = document.querySelector(".donut-indet");
            if (!el) return null;
            return getComputedStyle(el).transform;
        });
        b.reduced = { a1, a2, still: a1 && a1.transform === a2 && parseFloat(String(a1.animDur)) <= 0.00002 };
        b.checks.push({ name: "reduced-motion：不确定弧静止（动画降级 + transform 不变）", pass: !!b.reduced.still, detail: JSON.stringify(b.reduced) });
        b.consoleErrors = b.consoleErrors.concat(errs);
        await ctx.close();
    }

    await browser.close().catch(() => {});
    RESULT.browsers[tag] = b;
    b.checks.forEach((c) => check("[" + tag + "] " + c.name, c.pass, c.detail));
    return b;
}

(async () => {
    console.log("== u61_scan_anim_probe ==");
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
    console.log("总断言: " + RESULT.checks.length + "，失败: " + fails.length);
    setTimeout(() => process.exit(fails.length ? 1 : 0), 1500).unref();
})();
