/* ============================================================
   UI 2.0（SpaceLens Pro）· U2.3 交互与特效验收探针（真实页 Flask 5000）
   - 验收口径（手册 §U2.3 验收）：定稿 L3-1/2/3/7/8/9 参数逐条 + 双击防抖 +
     连续下钻/返回 50 次无监听器泄漏（heap 对比 + DOM 计数）。
   - ⚠️ 本机 /api/browse 存在 Everything IPC 时延抖动（秒级）：所有状态断言
     一律「条件等待 ≤15s」锚点（环境注记），不用固定等待窗。
   - 运行：node scripts/dev/u23_acc_probe.mjs [--base http://127.0.0.1:5000/]
            [--out <截图目录>]
   ============================================================ */

import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const require = createRequire(import.meta.url);
const { chromium } = require("C:/Users/26024/.dsh/profiles/web/node_modules/playwright");

function arg(name, dflt) {
    const i = process.argv.indexOf("--" + name);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const BASE = arg("base", "http://127.0.0.1:5000/");
const OUT = arg("out", path.join(os.tmpdir(), "u23_acc_shots"));
fs.mkdirSync(OUT, { recursive: true });

let passCount = 0, failCount = 0;
function ok(name, cond, detail) {
    if (cond) { passCount++; console.log("  ✔ " + name); }
    else { failCount++; console.log("  ✖ " + name + (detail ? " :: " + detail : "")); }
}

/* ---- Phase B（50 次循环）用的全 API 桩（页面内联；已独立验证浏览链可用） ---- */
const STUB_FN = `
window.fetch = function (url, options) {
  const key = String(options && options.method || "GET").toUpperCase() + " " + String(url).split("?")[0];
  const json = (o) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(JSON.parse(JSON.stringify(o))) });
  if (key === "POST /api/browse") {
    const body = JSON.parse(options.body);
    const p = String(body.path || "").replace(/\\\\+$/, "");
    const parts = p.split("\\\\");
    const parent = parts.length > 1 ? parts.slice(0, -1).join("\\\\") : null;
    const dirs = Array.from({ length: 8 }, (_, i) => ({
      name: "d" + (i + 1), path: p + "\\\\d" + (i + 1), is_dir: true,
      size: 1000000 - i * 1000, size_human: "976.56 KB",
    }));
    return json({ ok: true, root: p + "\\\\", parent: parent ? parent + "\\\\" : null,
                  directories: dirs, files: [], total_dirs: 8, total_files: 0 });
  }
  const m = {
    "GET /api/health": { ok: true, ready: true, dll: "stub", message: "Everything 已就绪" },
    "GET /api/settings": { ok: true, settings: { auto_save: false, last_roots: ["D:\\\\"] }, data_dir: "C:\\\\stub", snapshots_dir: "C:\\\\stub" },
    "GET /api/snapshots": { ok: true, sessions: [], count: 0 },
    "GET /api/fullscan/status": { ok: true, status: { running: false, roots: [], roots_done: 0, roots_total: 0, current_root: null, error: null, result_ready: false, save_ready: false, progress_pct: 0, scan_version: 1 } },
    "GET /api/overview": { ok: true, ready: false, scanning: false, empty_reason: "no_scan", roots: [] },
  };
  return m[key] ? json(m[key]) : json({ ok: true });
};
`;

/* 页内条件等待（≤timeout ms） */
const WAIT_FN = `(fn, timeout) => new Promise((resolve) => {
  const end = Date.now() + (timeout || 15000);
  const tick = () => { if (fn()) resolve(true); else if (Date.now() > end) resolve(fn()); else setTimeout(tick, 120); };
  tick();
})`;

(async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
    const errs = [];
    page.on("console", (m) => {
        if (m.type() !== "error") return;
        // 环境注记豁免：sandbox 身份写数据目录被拒 → POST /api/settings 500（预存偏差，见 response 注记）
        const loc = (m.location && m.location().url) || "";
        if (loc.indexOf("/api/settings") !== -1 && m.text().indexOf("Failed to load resource") !== -1) return;
        errs.push("console: " + m.text());
    });
    page.on("pageerror", (e) => errs.push("pageerror: " + e.message));
    page.on("response", (r) => {
        if (r.status() >= 400 && String(r.url()).indexOf("/api/settings") === -1) {
            errs.push("HTTP " + r.status() + " " + decodeURIComponent(r.url()).slice(0, 160));
        }
    });
    /* ⚠️ 环境注记：本会话 Flask 进程运行于受限身份（CodexSandboxUsers，数据目录仅
       ReadAndExecute）→ POST /api/settings 系统性 500"设置保存失败"（仅影响最近浏览
       持久化，前端已静默容忍；数据目录 ACL 本身 = 用户 FullControl，正常桌面运行不受影响）。
       属预存环境偏差（非 U2.3 引入），验收计数豁免该接口并在明细中注明。 */
    page.on("response", (r) => {
        if (r.status() >= 500 && String(r.url()).indexOf("/api/settings") !== -1) {
            console.log("  -（环境注记）POST /api/settings 500：受限身份写数据目录被拒（预存偏差）");
        }
    });

    /* ================= Phase A：真实页交互与特效 ================= */
    console.log("== 准备（真实页） ==");
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => {
        const t = document.getElementById("browse-status-text");
        return t && /排行视图/.test(t.textContent);
    }, { timeout: 15000 });
    await page.click("#btn-view-treemap");
    await page.waitForFunction(() => {
        const t = document.getElementById("browse-status-text");
        return t && /矩形图视图/.test(t.textContent);
    }, { timeout: 15000 });
    await page.waitForTimeout(1000); // 入场收束
    const base = await page.evaluate(async () => {
        const m = await import("/static/js/app/main.js");
        const v = m.getTreemapView();
        return { tiles: v.getTiles().length, layout: v.getLayout().length, path: m.getCurrentPath() };
    });
    ok("真实数据就位（tiles=" + base.tiles + "，根=" + base.path + "）", base.tiles > 0 && base.tiles === base.layout);

    /* ---- L3-9 合并阈值（根层 25 块：24+其他(55 项>24)） ---- */
    console.log("== L3-9 合并阈值 −/+ ==");
    const merge = await page.evaluate(async () => {
        const m = await import("/static/js/app/main.js");
        const w = (ms) => new Promise((r) => setTimeout(r, ms));
        if (!window.__wait) window.__wait = eval("(" + window.__WAIT_SRC + ")");
        const v = m.getTreemapView();
        const before = v.getTiles().length;
        document.getElementById("btn-merge-plus").click();
        await w(700);
        const label = document.getElementById("merge-top-label").textContent;
        const afterPlus = v.getTiles().length;
        document.getElementById("btn-merge-minus").click();
        await w(700);
        const afterMinus = v.getTiles().length;
        m.setMergeTop(1);
        await w(700);
        const atMin = v.getTiles().length;
        m.setMergeTop(24);
        await w(700);
        return { before, label, afterPlus, afterMinus, atMin };
    });
    ok("＋ → mergeTop 24→34 → tiles 25→35（34+其他）", merge.afterPlus === merge.before + 10 && merge.label === "34",
       JSON.stringify(merge));
    ok("− → 回 24（tiles 回 25）；下界 1 → tiles=2（1+其他）", merge.afterMinus === merge.before && merge.atMin === 2,
       JSON.stringify(merge));

    /* ---- L3-1 下钻 FLIP / 返回反向播放 ---- */
    console.log("== L3-1 下钻 FLIP / 返回反向播放 ==");
    const drillCtx = await page.evaluate(async () => {
        const m = await import("/static/js/app/main.js");
        const v = m.getTreemapView();
        const t = v.getLayout().find((x) => x.isDir && !x.isOther);
        const r = v.canvas().getBoundingClientRect();
        return t ? { path: t.path, name: t.name, cx: r.left + t.x + t.w / 2, cy: r.top + t.y + t.h / 2 } : null;
    });
    ok("取到首块目录 tile（path=" + (drillCtx && drillCtx.path) + "）", !!drillCtx, String(drillCtx));
    await page.evaluate(() => {
        window.__browseCalls = 0;
        const o = window.fetch;
        window.fetch = function (u, opt) {
            if (String(u).indexOf("/api/browse") !== -1) window.__browseCalls++;
            return o.apply(this, arguments);
        };
    });
    if (drillCtx) {
        await page.evaluate((p) => { window.__DRILL_PATH = p; }, drillCtx.path);
        await page.mouse.click(drillCtx.cx, drillCtx.cy);
        await page.waitForTimeout(430); // 300 双击窗 + FLIP 起始
        const mid = await page.evaluate(async () => {
            const m = await import("/static/js/app/main.js");
            return { transitioning: m.getTreemapView().isTransitioning() };
        });
        ok("下钻 FLIP 进行中（click+430ms transitioning）", mid.transitioning === true, JSON.stringify(mid));
        const arrived2 = await page.evaluate(async (a) => {
            const m = await import("/static/js/app/main.js");
            return eval("(" + a.wait + ")")(
                () => m.getCurrentPath() === a.path && m.getTreemapView().getTiles().length > 0,
                15000
            );
        }, { wait: WAIT_FN, path: drillCtx.path });
        ok("下钻到达子层（面包屑同步）", arrived2 === true, "path=" + drillCtx.path);
        const after = await page.evaluate(async () => {
            const m = await import("/static/js/app/main.js");
            return {
                path: m.getCurrentPath(),
                breadcrumb: document.getElementById("breadcrumb").textContent,
                tiles: m.getTreemapView().getTiles().length,
                calls: window.__browseCalls,
            };
        });
        ok("下钻恰 1 次浏览", after.calls === 1, "calls=" + after.calls);
        ok("面包屑含下钻目录名", after.breadcrumb.indexOf(drillCtx.name) !== -1, after.breadcrumb);
        // 等钻入入场动画收束（entry 600ms+stagger；避免与返回转场重叠）
        await page.evaluate(async () => {
            const m = await import("/static/js/app/main.js");
            await eval("(" + `(fn, timeout) => new Promise((resolve) => {
                const end = Date.now() + (timeout || 15000);
                const tick = () => { if (fn()) resolve(true); else if (Date.now() > end) resolve(fn()); else setTimeout(tick, 120); };
                tick();
            })` + ")")(
                () => !m.getTreemapView().isAnimating() && !m.getTreemapView().isTransitioning(),
                5000
            );
        });
        // 返回上级（反向播放）
        await page.click("#btn-back");
        await page.waitForTimeout(430);
        const midBack = await page.evaluate(async () => {
            const m = await import("/static/js/app/main.js");
            return m.getTreemapView().isTransitioning();
        });
        ok("返回上级反向播放进行中（click+430ms transitioning）", midBack === true, String(midBack));
        const backOk = await page.evaluate(async (WAIT) => {
            const m = await import("/static/js/app/main.js");
            return eval("(" + WAIT + ")")(
                () => m.getCurrentPath() === "D:\\" && m.getTreemapView().getTiles().length > 0,
                15000
            );
        }, WAIT_FN);
        ok("返回上级回到父层（根 + 25 块）", backOk === true);
        const backState = await page.evaluate(async () => {
            const m = await import("/static/js/app/main.js");
            return { path: m.getCurrentPath(), tiles: m.getTreemapView().getTiles().length };
        });
        ok("返回后 tiles 与根一致", backState.tiles === base.tiles, JSON.stringify(backState));
        await page.screenshot({ path: path.join(OUT, "l31-back-parent.png") });
    }

    /* ---- 双击回根防抖 ---- */
    console.log("== 双击回根防抖 ==");
    if (drillCtx) {
        await page.mouse.click(drillCtx.cx, drillCtx.cy); // 下钻
        await page.evaluate(async (WAIT) => {
            const m = await import("/static/js/app/main.js");
            return eval("(" + WAIT + ")")(
                () => m.getCurrentPath() === window.__DRILL_PATH,
                15000
            );
        }, WAIT_FN).catch(() => {});
        // 等钻入完成
        await page.waitForFunction(() => {
            const t = document.getElementById("browse-status-text");
            return t && /矩形图视图/.test(t.textContent) && document.getElementById("breadcrumb").textContent.indexOf("\\") !== -1;
        }, { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(700);
        const s2 = await page.evaluate(async () => {
            const m = await import("/static/js/app/main.js");
            const v = m.getTreemapView();
            const t = v.getLayout().find((x) => x.isDir && !x.isOther);
            const r = v.canvas().getBoundingClientRect();
            return t ? { cx: r.left + t.x + t.w / 2, cy: r.top + t.y + t.h / 2 } : null;
        });
        const inChild = await page.evaluate(async () => {
            const m = await import("/static/js/app/main.js");
            return { path: m.getCurrentPath(), parent: null };
        });
        if (s2 && inChild.path !== "D:\\") {
            await page.evaluate(() => { window.__browseCalls = 0; });
            await page.mouse.click(s2.cx, s2.cy);
            await page.waitForTimeout(110);
            await page.mouse.click(s2.cx, s2.cy);
            const dblOk = await page.evaluate(async (WAIT) => {
                const m = await import("/static/js/app/main.js");
                return eval("(" + WAIT + ")")(
                    () => window.__browseCalls === 1 && m.getCurrentPath() === "D:\\",
                    15000
                );
            }, WAIT_FN);
            const dbl = await page.evaluate(async () => {
                const m = await import("/static/js/app/main.js");
                return { calls: window.__browseCalls, path: m.getCurrentPath() };
            });
            ok("双击=回根且恰 1 次浏览（单击被取消）", dblOk === true, JSON.stringify(dbl));
        } else {
            ok("双击=回根且恰 1 次浏览（单击被取消）", false, JSON.stringify(inChild));
        }
        await page.waitForTimeout(600);
        // 回根等待恢复
        await page.evaluate(async (WAIT) => {
            const m = await import("/static/js/app/main.js");
            return eval("(" + WAIT + ")")(
                () => m.getCurrentPath() === "D:\\",
                15000
            );
        }, WAIT_FN).catch(() => {});
    }

    /* ---- L3-7 迷你条带 ---- */
    console.log("== L3-7 迷你条带 ==");
    await page.mouse.click(drillCtx.cx, drillCtx.cy); // 再下钻
    await page.evaluate(async (WAIT) => {
        const m = await import("/static/js/app/main.js");
        return eval("(" + WAIT + ")")(
            () => m.getCurrentPath() === window.__DRILL_PATH,
            15000
        );
    }, WAIT_FN).catch(() => {});
    await page.waitForTimeout(900);
    const strip = await page.evaluate(async () => {
        const slot = document.getElementById("strip-slot");
        const blocks = slot.querySelectorAll(".strip-block");
        const clickable = slot.querySelectorAll(".strip-block[data-strip-path]:not(.strip-block-static)");
        return {
            hidden: slot.hasAttribute("hidden"),
            count: blocks.length,
            hasOther: [...blocks].some((b) => b.textContent.indexOf("其他") !== -1),
            firstPath: clickable[0] ? clickable[0].getAttribute("data-strip-path") : null,
        };
    });
    ok("下钻后条带可见且 = 上级构成 25 块（24+其他）", strip.hidden === false && strip.count === 25,
       JSON.stringify({ hidden: strip.hidden, count: strip.count }));
    ok("条带含「其他」块", strip.hasOther === true);
    if (strip.firstPath) {
        await page.evaluate(() => { window.__browseCalls = 0; });
        await page.click("#strip-slot .strip-block[data-strip-path]:not(.strip-block-static)");
        const stripOk = await page.evaluate(async (a) => {
            const m = await import("/static/js/app/main.js");
            return eval("(" + a.wait + ")")(
                () => window.__browseCalls === 1 && m.getCurrentPath() === a.path,
                15000
            );
        }, { wait: WAIT_FN, path: strip.firstPath });
        ok("点击条带块 = 跳回该子目录（恰 1 次）", stripOk === true, "path=" + strip.firstPath);
    }
    await page.screenshot({ path: path.join(OUT, "l37-strip.png") });
    // 回根：条带隐藏
    await page.click("#btn-back");
    const stripRoot = await page.evaluate(async (WAIT) => {
        const m = await import("/static/js/app/main.js");
        return eval("(" + WAIT + ")")(
            () => m.getCurrentPath() === "D:\\",
            15000
        );
    }, WAIT_FN);
    const stripHidden = await page.evaluate(() => document.getElementById("strip-slot").hasAttribute("hidden"));
    ok("盘根时条带隐藏", stripRoot === true && stripHidden === true, "root=" + stripRoot + " hidden=" + stripHidden);

    /* ---- L3-8 全屏 ---- */
    console.log("== L3-8 全屏 ==");
    await page.click("#btn-view-fullscreen");
    await page.waitForTimeout(500);
    const fs = await page.evaluate(() => {
        const area = document.getElementById("view-area");
        const r = area.getBoundingClientRect();
        return {
            cls: area.className,
            inset: { l: r.left, t: r.top, w: r.width, h: r.height },
            vw: window.innerWidth, vh: window.innerHeight,
            veil: !!document.querySelector(".fullscreen-veil"),
            btn: document.getElementById("btn-view-fullscreen").getAttribute("aria-pressed"),
        };
    });
    ok("全屏：view-area fixed 铺满视口", fs.cls.indexOf("view-fullscreen") !== -1 &&
        Math.abs(fs.inset.w - fs.vw) < 2 && Math.abs(fs.inset.h - fs.vh) < 2 &&
        fs.inset.l === 0 && fs.inset.t === 0, JSON.stringify(fs.inset));
    ok("全屏：压暗 veil 在场 + 按钮态切换", fs.veil === true && fs.btn === "true");
    await page.screenshot({ path: path.join(OUT, "l38-fullscreen.png") });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    const fsExit = await page.evaluate(() => ({
        cls: document.getElementById("view-area").className,
        veil: !!document.querySelector(".fullscreen-veil"),
    }));
    ok("Esc 退出全屏（veil 移除）", fsExit.cls.indexOf("view-fullscreen") === -1 && fsExit.veil === false, JSON.stringify(fsExit));

    /* ---- L3-2 实时生长（真实页：验证事件接线与请求发起；节奏断言在 Phase B stub 页）
           + L3-3 扫掠 ---- */
    console.log("== L3-2 实时生长接线 / L3-3 扫掠（真实页） ==");
    await page.evaluate(() => {
        window.__browseStarts = 0;
        const o = window.fetch;
        window.fetch = function (u, opt) {
            if (String(u).indexOf("/api/browse") !== -1) window.__browseStarts++;
            return o.apply(this, arguments);
        };
        window.dispatchEvent(new CustomEvent("pds:scan", { detail: { running: true } }));
    });
    const liveWired = await page.evaluate(async () => {
        const end = Date.now() + 3000;
        while (Date.now() < end) {
            if (window.__browseStarts >= 1) return true;
            await new Promise((r) => setTimeout(r, 150));
        }
        return window.__browseStarts >= 1;
    });
    ok("扫描中 → 实时刷新请求已发起（事件接线；本机 IPC 秒级抖动致慢响应）", liveWired === true,
       "starts=" + (await page.evaluate(() => window.__browseStarts)));
    // 扫掠：fx 层 7.5s 窗口内应出现像素（6s 周期 + 1.2s 单次）
    const sweepFrames = await page.evaluate(async () => {
        const m = await import("/static/js/app/main.js");
        const fx = m.getTreemapView().fx();
        const ctx = fx.getContext("2d");
        let hits = 0;
        const beg = performance.now();
        while (performance.now() - beg < 7500) {
            const d = ctx.getImageData(0, 0, fx.width, fx.height).data;
            for (let i = 3; i < d.length; i += 4) { if (d[i] > 0) { hits++; break; } }
            if (hits >= 2) break;
            await new Promise((r) => setTimeout(r, 120));
        }
        return hits;
    });
    ok("扫掠光带出现（fx 层像素，6s 周期+1.2s 单次）", sweepFrames >= 2, "frames=" + sweepFrames);
    // reduced：扫掠关闭
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("pds:scan", { detail: { running: true } })));
    await page.waitForTimeout(700);
    const sweepReduced = await page.evaluate(async () => {
        const m = await import("/static/js/app/main.js");
        const fx = m.getTreemapView().fx();
        const ctx = fx.getContext("2d");
        const beg = performance.now();
        let hits = 0;
        while (performance.now() - beg < 2500) {
            const d = ctx.getImageData(0, 0, fx.width, fx.height).data;
            for (let i = 3; i < d.length; i += 4) { if (d[i] > 0) { hits++; break; } }
            await new Promise((r) => setTimeout(r, 200));
        }
        return hits;
    });
    ok("reduced-motion 扫掠关闭", sweepReduced === 0, "frames=" + sweepReduced);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("pds:scan", { detail: { running: false } })));
    await page.waitForTimeout(400);

    /* ================= Phase B：50 次下钻/返回无泄漏 ================= */
    console.log("== 50 次下钻/返回 泄漏检查（stub 快速循环） ==");
    const stubPage = await browser.newPage({ viewport: { width: 1366, height: 768 } });
    stubPage.on("pageerror", (e) => errs.push("[B] pageerror: " + e.message));
    stubPage.on("console", (m) => { if (m.type() === "error") errs.push("[B] console: " + m.text()); });
    await stubPage.addInitScript(STUB_FN);
    await stubPage.goto(BASE, { waitUntil: "domcontentloaded" });
    await stubPage.waitForFunction(() => {
        const t = document.getElementById("browse-status-text");
        return t && /排行视图/.test(t.textContent);
    }, { timeout: 15000 });
    await stubPage.click("#btn-view-treemap");
    await stubPage.waitForTimeout(800);
    /* L3-2 节奏断言（stub 页：浏览瞬时返回，512ms 高频 / 2s 低频可精确验证） */
    console.log("== L3-2 实时生长节奏（stub 页） ==");
    const cadence = await stubPage.evaluate(async () => {
        const w = (ms) => new Promise((r) => setTimeout(r, ms));
        window.__stubBrowse = 0;
        const o = window.fetch;
        window.fetch = function (u, opt) {
            if (String(u).indexOf("/api/browse") !== -1) window.__stubBrowse++;
            return o.apply(this, arguments);
        };
        window.dispatchEvent(new CustomEvent("pds:scan", { detail: { running: true } }));
        await w(1700);
        const mainFreq = window.__stubBrowse; // ≥2（500ms 节奏）
        window.__stubBrowse = 0;
        location.hash = "#/compare";
        await w(1000);
        window.__stubBrowse = 0; // 清首拍
        await w(2600);
        const subFreq = window.__stubBrowse; // ≈1（2s 低频）
        location.hash = "#/";
        await w(600);
        window.__stubBrowse = 0;
        await w(1600);
        const backFreq = window.__stubBrowse; // ≥2（回主页恢复 500ms）
        window.dispatchEvent(new CustomEvent("pds:scan", { detail: { running: false } }));
        await w(300);
        window.__stubBrowse = 0;
        await w(1300);
        const stopped = window.__stubBrowse; // 0（停止后不再刷新）
        window.fetch = o;
        return { mainFreq, subFreq, backFreq, stopped };
    });
    ok("主页 500ms/次（1.7s ≥2）", cadence.mainFreq >= 2, "mainFreq=" + cadence.mainFreq);
    ok("子页面 2s 低频（2.6s 1-2 次）", cadence.subFreq >= 1 && cadence.subFreq <= 2, "subFreq=" + cadence.subFreq);
    ok("回主页恢复 500ms（1.6s ≥2）", cadence.backFreq >= 2, "backFreq=" + cadence.backFreq);
    ok("扫描结束停止刷新（1.3s =0）", cadence.stopped === 0, "stopped=" + cadence.stopped);
    await stubPage.waitForTimeout(400);
    const heapBefore = await stubPage.evaluate(() => (performance.memory ? performance.memory.usedJSHeapSize : -1)).catch(() => -1);
    const cycle = await stubPage.evaluate(async () => {
        const m = await import("/static/js/app/main.js");
        const w = (ms) => new Promise((r) => setTimeout(r, ms));
        const v = m.getTreemapView();
        const canvas = v.canvas();
        const t0 = performance.now();
        for (let i = 0; i < 50; i++) {
            const r = canvas.getBoundingClientRect();
            const t = v.getLayout().find((x) => x.isDir && !x.isOther);
            if (!t) return { err: "no tile at cycle " + i, done: i };
            canvas.dispatchEvent(new MouseEvent("click", {
                clientX: r.left + t.x + t.w / 2, clientY: r.top + t.y + t.h / 2, bubbles: true,
            }));
            await w(400);
            const b = document.getElementById("btn-back");
            if (b && !b.disabled) b.click();
            await w(400);
        }
        return { done: 50, ms: performance.now() - t0 };
    });
    const heapAfter = await stubPage.evaluate(() => (performance.memory ? performance.memory.usedJSHeapSize : -1)).catch(() => -1);
    ok("50 次下钻/返回完成（" + Math.round((cycle.ms || 0) / 1000) + "s）", cycle.done === 50, JSON.stringify(cycle).slice(0, 120));
    if (heapBefore > 0 && heapAfter > 0) {
        const deltaMB = (heapAfter - heapBefore) / (1024 * 1024);
        ok("堆对比：50 次后 heap 增长受控（" + deltaMB.toFixed(1) + "MB ≤ 20MB）", deltaMB <= 20, deltaMB.toFixed(1) + "MB");
    } else {
        console.log("  -（performance.memory 不可用，跳过 heap 对比；DOM 计数仍校验）");
    }
    const domCounts = await stubPage.evaluate(async () => {
        const m = await import("/static/js/app/main.js");
        return {
            canvases: document.querySelectorAll("canvas").length,
            tooltips: document.querySelectorAll(".treemap-tooltip").length,
            views: m.getTreemapView() ? 1 : 0,
        };
    });
    ok("DOM 无泄漏：canvas=2 / tooltip=1 / 单视图", domCounts.canvases === 2 && domCounts.tooltips === 1 && domCounts.views === 1,
       JSON.stringify(domCounts));
    await stubPage.screenshot({ path: path.join(OUT, "l31-50cycles.png") });
    await stubPage.close();

    console.log("== console/pageerror ==");
    console.log(errs.length ? errs.join("\n") : "(none)");
    if (errs.length) failCount += errs.length;

    console.log("SUMMARY: " + passCount + " pass / " + failCount + " fail (" + passCount + "/" + (passCount + failCount) + ")");
    console.log("SHOTS: " + OUT);
    await browser.close();
    process.exit(failCount ? 1 : 0);
})();
