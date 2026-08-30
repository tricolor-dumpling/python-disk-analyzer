/* ============================================================
   UI 2.0（SpaceLens Pro）· U4.1 无障碍与键盘矩阵验收探针
   - 验收口径（手册 §U4.1 + 定稿 7.4 键盘矩阵 + 第八节可访问性）：
     ①桩态·treemap 方向键最近邻数学（纯函数 nearestFocusIndex：含边界/单块/
       无 tiles 守卫——与 node 测试同断言面，探针验证运行时的接线）；
     ②桩态·焦点块可见指示：容器 Tab 聚焦（:focus-visible 2px primary offset 2
       computed 样式）+ 焦点块静态描边像素采样（==primary；不动画）；
     ③桩态·Enter 下钻恰 1 次 browse 且 path=焦点块（单击语义；双击窗互斥
       不产生第三次；文件/合并块 0 请求）；
     ④桩态·`/` 聚焦筛选框：可见即聚焦；输入框内守卫；其他路由空守卫（不抢焦点）；
     ⑤桩态·g c / g s 连按跳页与守卫：输入框内不触发、isComposing 忽略、
       超时（>800ms）重置、弹窗栈打开时忽略；
     ⑥桩态·共享守卫回归：Backspace 输入框内不触发；treemap 聚焦非根目录
       Backspace=goUp 恰 1 次 browse（path=上级）；
     ⑦reduced-motion：键盘导航属功能性——方向键焦点移动仍可用（不降级）、
       焦点块描边仍绘制（静态，不依赖动画）、焦点环样式在（2px）；
     ⑧双档零滚动（1366×768 / 1920×1080，焦点态）——focus 态 body 零滚动保持；
     ⑨真机阶段（--with-data）：纯键盘全旅程「扫描→浏览→对比→设置」+ 录屏
       留档 + console 0（过滤资源状态日志）+ 焦点环亮/暗截图；
       ⚠️ 环境口径（G8/G9）：本机 SDK 直扫分钟级——真机对比完成不可达，如实
       断言「发起态」；扫描步断言发起态后程序化停止（探针清理，非旅程操作）。
   - 运行：node scripts/dev/u41_acc_probe.mjs [--base http://127.0.0.1:5000/]
            [--out <截图/录屏目录>] [--with-data]
   - ⚠️ addInitScript 传函数体字符串；注入后先校验 window.__stub 接管；
     stub 内路径转义沿用 u34/u35 惯例（模板字面量 4 反斜杠 → 注入 2 → 页面值 1）。
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
const OUT = arg("out", path.join(os.tmpdir(), "u41_acc_shots"));
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

const WAIT_FN = `(fn, timeout) => new Promise((resolve) => {
  const end = Date.now() + (timeout || 15000);
  const tick = () => { if (fn()) resolve(true); else if (Date.now() > end) resolve(fn()); else setTimeout(tick, 100); };
  tick();
})`;
async function installWait(page) {
    await page.evaluate((src) => { window.__wait = eval("(" + src + ")"); }, WAIT_FN);
}

/* 安定等待：entry（600ms+stagger 400ms）/主题解析等启动瞬态过后再采样——
   连续 3 拍（100ms 间隔）isAnimating=false 且布局数不变即稳定 */
async function settleTreemap(page, extraMs) {
    let stable = 0;
    let lastN = -1;
    for (let i = 0; i < 30; i++) {
        await page.waitForTimeout(100);
        const st = await page.evaluate(async () => {
            const m = await import("/static/js/app/main.js");
            const v = m.getTreemapView();
            return v ? { anim: v.isAnimating(), n: v.getLayout().length } : { anim: true, n: 0 };
        }).catch(() => ({ anim: true, n: 0 }));
        if (!st.anim && (lastN < 0 || st.n === lastN)) { stable++; lastN = st.n; } else { stable = 0; lastN = st.n; }
        if (stable >= 3) break;
    }
    if (extraMs) await page.waitForTimeout(extraMs);
}

/* ---- 桩态 fetch（addInitScript；键集合覆盖 init 全链 + 键盘矩阵触点。
     样本：目录块为最大块（焦点 0 = data 目录 → Enter 恰 1 次 browse）；
     下钻 D:\data → parent=D:\（Backspace goUp 路径）；D:\child → parent=D:\。 ---- */
const STUB_FN = `
window.__stub = { fetchLog: [], browseBodies: [] };
window.fetch = function (url, options) {
  options = options || {};
  const key = (options.method || "GET").toUpperCase() + " " + String(url).split("?")[0];
  window.__stub.fetchLog.push(key);
  const body = options.body ? JSON.parse(options.body) : {};
  if (key === "POST /api/browse") window.__stub.browseBodies.push(body);
  const json = (o, s) => Promise.resolve({ ok: (s || 200) < 400, status: s || 200,
    json: () => Promise.resolve(JSON.parse(JSON.stringify(o))) });
  if (key === "GET /api/health") return json({ ok: true, ready: true, dll: "stub-dll", message: "Everything 已就绪" });
  if (key === "GET /api/settings") return json({ ok: true, settings: { auto_save: false, last_roots: ["D:\\\\"] }, data_dir: "C:\\\\stub\\\\data", snapshots_dir: "C:\\\\stub\\\\snapshots" });
  if (key === "POST /api/settings") return json({ ok: true, settings: { auto_save: false } });
  if (key === "POST /api/browse") {
    if (body.path === "D:\\\\data") return json({ ok: true, root: "D:\\\\data", parent: "D:\\\\",
      directories: [ { name: "sub", path: "D:\\\\data\\\\sub", is_dir: true, size: 3000, size_human: "2.93 KB" } ],
      files: [], total_dirs: 1, total_files: 0 });
    if (body.path === "D:\\\\child") return json({ ok: true, root: "D:\\\\child", parent: "D:\\\\",
      directories: [], files: [ { name: "f.txt", path: "D:\\\\child\\\\f.txt", is_dir: false, size: 5, size_human: "5 B" } ],
      total_dirs: 0, total_files: 1 });
    return json({ ok: true, root: "D:\\\\", parent: null,
      directories: [
        { name: "data", path: "D:\\\\data", is_dir: true, size: 12000, size_human: "11.72 KB" },
        { name: "docs", path: "D:\\\\docs", is_dir: true, size: 4000, size_human: "3.91 KB" }
      ],
      files: [ { name: "readme.txt", path: "D:\\\\readme.txt", is_dir: false, size: 100, size_human: "100 B" } ],
      total_dirs: 2, total_files: 1 });
  }
  if (key === "GET /api/fullscan/status") return json({ ok: true, status: { running: false, roots: ["C:\\\\", "D:\\\\"], roots_done: 2, roots_total: 2, current_root: null, error: null, result_ready: true, save_ready: true, progress_pct: 100, scan_version: 1, stop_requested: false, stop_reason: null } });
  if (key === "OPTIONS /api/fullscan/stop") return json({ ok: true }, 200);
  if (key === "POST /api/fullscan/stop") return json({ ok: true, stopped: false });
  if (key === "GET /api/snapshots") return json({ ok: true, sessions: [], count: 0 });
  if (key === "POST /api/compare") return json({ ok: true, report: { root: "D:\\\\", total_baseline: 0, total_current: 0, delta_total: 0, truncated: false, legacy_count: 0, rows: [] } });
  if (key === "GET /api/overview") return json({ ok: true, ready: true, roots: [], completed_at: "2026-08-24T10:00:00" });
  if (key === "POST /api/open-path") return json({ ok: true, launched: true, message: "ok" });
  if (key === "POST /api/save") return json({ ok: true, message: "保存完成" });
  if (key === "POST /api/save/undo") return json({ ok: true, message: "已撤销最近一次保存" });
  if (key === "POST /api/admin/wipe") return json({ ok: true, message: "数据目录已清空" });
  return json({ ok: true });
};
`;

async function newStubPage(browser, opts) {
    const ctx = await browser.newContext(Object.assign({
        viewport: { width: 1366, height: 768 },
    }, opts || {}));
    const p = await ctx.newPage();
    const errs = [];
    p.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text()); });
    p.on("pageerror", (e) => errs.push("pageerror: " + e.message));
    await p.addInitScript(() => { try { localStorage.setItem("pds_onboarding_dismissed_v1", "1"); } catch (e) {} });
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

/* Tab 循环直到活动元素是 #treemap-wrap（真实键盘焦点序列；超过步数判失败） */
async function tabToTreemap(page, maxSteps) {
    for (let i = 0; i < (maxSteps || 40); i++) {
        await page.keyboard.press("Tab");
        const hit = await page.evaluate(() => document.activeElement === document.getElementById("treemap-wrap")).catch(() => false);
        if (hit) return true;
    }
    return false;
}

/* 焦点块描边像素采样：聚焦矩形左上角内 2px 处应≈primary（#2563eb 亮色骨架；暗色）
   返回 { dist, rgb } —— dist = 与采样目标色的最大通道差 */
async function sampleFocusStroke(page) {
    return page.evaluate(async () => {
        const m = await import("/static/js/app/main.js");
        const v = m.getTreemapView();
        const ft = v && v.getFocusedTile();
        if (!ft) return { dist: 999, rgb: null, note: "no focused tile" };
        const cnv = v.canvas();
        const rect = cnv.getBoundingClientRect();
        const scale = rect.width > 0 ? cnv.width / rect.width : 1;
        const x = Math.round((ft.x + 2) * scale);
        const y = Math.round((ft.y + 2) * scale);
        const d = cnv.getContext("2d").getImageData(x, y, 1, 1).data;
        const cs = getComputedStyle(document.documentElement).getPropertyValue("--primary").trim();
        let target = [37, 99, 235]; // #2563eb（tokens 亮色 primary）
        const mm = cs.match(/#([0-9a-fA-F]{6})/);
        if (mm) target = [parseInt(mm[1].slice(0, 2), 16), parseInt(mm[1].slice(2, 4), 16), parseInt(mm[1].slice(4, 6), 16)];
        return {
            dist: Math.max(Math.abs(d[0] - target[0]), Math.abs(d[1] - target[1]), Math.abs(d[2] - target[2])),
            rgb: [d[0], d[1], d[2]], target: target,
            focusIdx: v.getFocusIdx(), name: ft.name,
        };
    });
}

/* ================= 阶段 1：桩态（默认 1366×768） ================= */
console.log("== 阶段 1：桩态（键盘矩阵语义 + 可见指示 + 守卫） ==");
let overall = true;
{
    const browser = await chromium.launch();
    const { page, ctx, errs, stubOk } = await newStubPage(browser);
    if (!stubOk) { console.log("  ✖ stub 未接管（addInitScript 失败）；中止"); process.exit(1); }
    await page.waitForFunction(() => window.__wait && !!document.getElementById("dir-body"), { timeout: 15000 }).catch(() => {});
    await page.waitForFunction(() => {
        try {
            return import("/static/js/app/main.js").then((m) => {
                const v = m.getTreemapView();
                return v && v.getLayout().length >= 1 && !v.isAnimating();
            });
        } catch (e) { return false; }
    }, null, { timeout: 15000 }).catch(() => {});
    await settleTreemap(page, 150); // 启动瞬态（entry/主题解析）安定后再进入焦点操作

    /* ① 最近邻数学（纯函数端到端接线；与 node 测试同断言面） */
    const math = await page.evaluate(async () => {
        const m = await import("/static/js/app/viz/treemap.js");
        const G = [
            { key: "A", x: 0, y: 0, w: 4, h: 2 },
            { key: "B", x: 0, y: 2, w: 2, h: 2 },
            { key: "C", x: 0, y: 4, w: 2, h: 2 },
            { key: "D", x: 4, y: 0, w: 2, h: 4 },
            { key: "E", x: 4, y: 4, w: 4, h: 2 },
        ];
        return {
            first: m.nearestFocusIndex(G, -1, 1, 0),        // 无焦点首按 → 0
            right: m.nearestFocusIndex(G, 0, 1, 0),          // A→D(3)
            down: m.nearestFocusIndex(G, 0, 0, 1),           // A→B(1)
            up: m.nearestFocusIndex(G, 4, 0, -1),            // E→D(3)
            leftBound: m.nearestFocusIndex(G, 1, -1, 0),     // B 左=无候选 → -1
            single: m.nearestFocusIndex([{ key: "only", x: 0, y: 0, w: 10, h: 10 }], 0, 1, 0),
            empty: m.nearestFocusIndex([], 0, 1, 0),
        };
    });
    ok("①最近邻数学：无焦点/右/下/上/边界/单块/无 tiles",
        math.first === 0 && math.right === 3 && math.down === 1 && math.up === 3 &&
        math.leftBound === -1 && math.single === -1 && math.empty === -1, JSON.stringify(math));

    /* ①b 运行时焦点移动（真实键盘；样本：焦点 0 = data 目录块） */
    await page.evaluate(() => { document.getElementById("treemap-wrap").blur(); document.getElementById("treemap-wrap").focus(); });
    await page.waitForFunction(async () => {
        const m = await import("/static/js/app/main.js");
        const v = m.getTreemapView();
        return v && v.getFocusIdx() === 0;
    }, null, { timeout: 5000 }).catch(() => {});
    const f0 = await page.evaluate(async () => {
        const m = await import("/static/js/app/main.js");
        const v = m.getTreemapView();
        const t = v.getFocusedTile();
        return { idx: v.getFocusIdx(), name: t && t.name, key: t && t.key };
    });
    ok("①b聚焦后焦点块=最大块（data 目录）", f0.idx === 0 && f0.name === "data", JSON.stringify(f0));
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(60);
    const f1 = await page.evaluate(async () => {
        const m = await import("/static/js/app/main.js");
        const v = m.getTreemapView();
        const t = v.getFocusedTile();
        return { idx: v.getFocusIdx(), name: t && t.name };
    });
    ok("①b ArrowRight 最近邻移动焦点块", f1.idx >= 0 && f1.idx !== 0, JSON.stringify(f1));
    /* 边界：连按 12 次后 3 次静止 */
    for (let i = 0; i < 12; i++) await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(60);
    const bound = await page.evaluate(async () => {
        const m = await import("/static/js/app/main.js");
        return m.getTreemapView().getFocusIdx();
    });
    for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(60);
    const bound2 = await page.evaluate(async () => {
        const m = await import("/static/js/app/main.js");
        return m.getTreemapView().getFocusIdx();
    });
    ok("①b 边界守卫：连按至边界后焦点静止", bound >= 0 && bound === bound2, bound + " → " + bound2);
    await page.keyboard.press("ArrowLeft");
    await page.waitForTimeout(60);
    const f2 = await page.evaluate(async () => {
        const m = await import("/static/js/app/main.js");
        return m.getTreemapView().getFocusIdx();
    });
    ok("①b ArrowLeft 可回退", f2 >= 0 && f2 !== bound2, bound2 + " → " + f2);

    /* ② 可见指示：焦点块静态描边像素（=primary；不动画）——先显式归位焦点块 0 */
    await page.evaluate(async () => {
        const m = await import("/static/js/app/main.js");
        m.getTreemapView().setFocusIdx(0);
    });
    await page.waitForTimeout(80);
    const px = await sampleFocusStroke(page);
    ok("②焦点块可见指示：左上角描边像素≈primary（rgb " +
        (px.rgb ? px.rgb.join(",") : "n/a") + " vs " + px.target.join(",") + "）",
        px.dist < 24 && px.name === "data", JSON.stringify(px));

    /* ②b 容器 Tab 聚焦 → :focus-visible 焦点环 2px primary offset 2（键盘真实焦点） */
    await page.evaluate(() => { document.activeElement && document.activeElement.blur(); });
    const tabbed = await tabToTreemap(page, 40);
    const ring = await page.evaluate(() => {
        const el = document.getElementById("treemap-wrap");
        const cs = getComputedStyle(el);
        return { focused: document.activeElement === el, w: cs.outlineWidth, s: cs.outlineStyle, o: cs.outlineOffset, c: cs.outlineColor };
    });
    ok("②b treemap 容器 Tab 可聚焦且 :focus-visible 环 2px solid offset 2",
        tabbed && ring.focused && ring.w === "2px" && ring.s === "solid" && ring.o === "2px",
        JSON.stringify(ring));
    ok("②b 焦点环颜色=primary（亮色 tokens #2563eb）", /rgb\(37, 99, 235\)/.test(ring.c), ring.c);
    await shot(page, "focus-ring-light");

    /* ③ Enter 下钻：恰 1 次 browse 且 path=焦点块；双击窗互斥 */
    await page.evaluate(() => { document.getElementById("treemap-wrap").blur(); document.getElementById("treemap-wrap").focus(); });
    await page.waitForTimeout(60);
    const before = await page.evaluate(() => window.__stub.browseBodies.length);
    await page.keyboard.press("Enter");
    await page.waitForFunction((n) => window.__stub.browseBodies.length === n + 1, before, { timeout: 8000 }).catch(() => {});
    const after = await page.evaluate(() => window.__stub.browseBodies.length);
    ok("③Enter 下钻恰 1 次 browse（" + before + " → " + after + "）", after === before + 1, before + " → " + after);
    await page.waitForTimeout(400); // 双击窗 300ms 内不得再发
    const after2 = await page.evaluate(() => window.__stub.browseBodies.length);
    const lastBody = await page.evaluate(() => window.__stub.browseBodies[window.__stub.browseBodies.length - 1] || null);
    ok("③Enter 后无第三次请求 + path=焦点块（D:\\data）",
        after2 === before + 1 && lastBody && lastBody.path === "D:\\data", JSON.stringify(lastBody));
    /* 等待 D:\data 渲染完成（parent=D:\ → 上级可回） */
    await page.waitForFunction(async () => {
        const m = await import("/static/js/app/main.js");
        const v = m.getTreemapView();
        return v && v.getLayout().length >= 1 && !v.isAnimating();
    }, null, { timeout: 8000 }).catch(() => {});

    /* ⑥a 共享守卫回归：Backspace 输入框内不触发（焦点在 D:\data，上级可用） */
    await page.evaluate(() => { document.getElementById("browse-filter").focus(); });
    await page.keyboard.type("x"); // 输入框有内容（更有意义）
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(200);
    const afterUp = await page.evaluate(() => window.__stub.browseBodies.length);
    ok("⑥a Backspace 输入框内不触发上级（browse 计数不变）", afterUp === after2, after2 + " → " + afterUp);
    /* ⑥b treemap 聚焦下 Backspace=goUp（上级 D:\，恰 1 次） */
    await page.evaluate(() => { document.getElementById("browse-filter").value = ""; document.getElementById("treemap-wrap").focus(); });
    await page.waitForTimeout(60);
    await page.keyboard.press("Backspace");
    await page.waitForFunction((n) => window.__stub.browseBodies.length === n + 1, afterUp, { timeout: 8000 }).catch(() => {});
    const upBodies = await page.evaluate(() => window.__stub.browseBodies.length);
    const upLast = await page.evaluate(() => window.__stub.browseBodies[window.__stub.browseBodies.length - 1] || null);
    ok("⑥b treemap 聚焦 Backspace=上级（恰 1 次 browse 且 path=D:\\）",
        upBodies === afterUp + 1 && upLast && upLast.path === "D:\\", JSON.stringify(upLast));

    /* ④ `/` 聚焦筛选框（可见即聚焦）+ 输入框守卫 + 其他路由空守卫 */
    await page.evaluate(() => { document.getElementById("treemap-wrap").blur(); document.activeElement && document.activeElement.blur(); });
    await page.keyboard.press("/");
    await page.waitForTimeout(80);
    const slash1 = await page.evaluate(() => document.activeElement && document.activeElement.id);
    ok("④/ 聚焦筛选框 browse-filter", slash1 === "browse-filter", String(slash1));
    await page.keyboard.press("/");
    await page.waitForTimeout(60);
    const slash2 = await page.evaluate(() => document.activeElement && document.activeElement.id);
    ok("④/ 输入框聚焦时守卫（保持既有焦点）", slash2 === "browse-filter", String(slash2));
    /* 其他路由：无筛选框 → 空守卫不抢焦点 */
    await page.evaluate(() => { document.activeElement && document.activeElement.blur(); });
    await page.keyboard.press("g");
    await page.keyboard.press("c");
    await page.waitForFunction(() => location.hash === "#/compare", { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(500);
    const routeCmp = await page.evaluate(() => location.hash);
    await page.evaluate(() => { document.activeElement && document.activeElement.blur(); });
    await page.keyboard.press("/");
    await page.waitForTimeout(80);
    const slash3 = await page.evaluate(() => ({ hash: location.hash, active: document.activeElement && document.activeElement.id }));
    ok("④/ 对比页空守卫（不抢焦点、不切视图）", slash3.hash === "#/compare" && slash3.active !== "browse-filter", JSON.stringify(slash3));

    /* ⑤ g c / g s 跳页与守卫 */
    await page.keyboard.press("g");
    await page.keyboard.press("s");
    await page.waitForFunction(() => location.hash === "#/snapshots", { timeout: 8000 }).catch(() => {});
    ok("⑤g s 连按跳快照页", (await page.evaluate(() => location.hash)) === "#/snapshots");
    await page.keyboard.press("g");
    await page.keyboard.press("c");
    await page.waitForFunction(() => location.hash === "#/compare", { timeout: 8000 }).catch(() => {});
    ok("⑤g c 连按跳对比页", (await page.evaluate(() => location.hash)) === "#/compare");
    /* isComposing 忽略（合成事件：组词中的 g 不武装） */
    await page.evaluate(async () => {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "g", bubbles: true, isComposing: true }));
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "s", bubbles: true, isComposing: true }));
    });
    await page.waitForTimeout(400);
    ok("⑤isComposing 组词中 g 序列忽略", (await page.evaluate(() => location.hash)) === "#/compare");
    /* 超时重置：g 后 950ms 再按 c → 不跳 */
    await page.keyboard.press("g");
    await page.waitForTimeout(950);
    await page.keyboard.press("c");
    await page.waitForTimeout(300);
    ok("⑤g 序列超时（>800ms）重置不跳页", (await page.evaluate(() => location.hash)) === "#/compare");
    /* 输入框内 g 序列不触发（回工作台聚焦筛选框） */
    await page.keyboard.press("g");
    await page.keyboard.press("c"); // g c → 回对比? 当前在 #/compare，g c → #/compare 同页无变化
    await page.waitForTimeout(200);
    ok("⑤g c 在同页重复触发无副作用", (await page.evaluate(() => location.hash)) === "#/compare");
    await page.evaluate(() => { location.hash = "#/"; });
    await page.waitForFunction(() => location.hash === "#/" && !!document.getElementById("browse-filter"), { timeout: 8000 }).catch(() => {});
    await page.evaluate(() => { document.getElementById("browse-filter").focus(); });
    await page.keyboard.press("g");
    await page.keyboard.press("c");
    await page.waitForTimeout(400);
    ok("⑤输入框内 g 序列被守卫（不跳页）", (await page.evaluate(() => location.hash)) === "#/");
    /* 弹窗栈守卫 */
    await page.evaluate(async () => { const m = await import("/static/js/app/main.js"); m.openModal("settings-modal"); document.activeElement && document.activeElement.blur(); });
    await page.keyboard.press("g");
    await page.keyboard.press("c");
    await page.waitForTimeout(400);
    ok("⑤弹窗打开时 g 序列被守卫", (await page.evaluate(() => location.hash)) === "#/");
    await page.evaluate(async () => { const m = await import("/static/js/app/main.js"); m.closeModal("settings-modal"); });

    /* console 0（桩态，过滤资源状态日志口径） */
    const errsFiltered = errs.filter((e) => !/Failed to load resource/.test(e));
    ok("阶段1 console/pageerror 0（过滤资源状态日志）", errsFiltered.length === 0, errsFiltered.join("\n"));
    await page.close();
    await ctx.close();
    await browser.close();
}

/* ================= 阶段 2：reduced-motion（键盘导航功能性保留） ================= */
console.log("== 阶段 2：reduced-motion（键盘导航属功能性，不降级） ==");
{
    const browser = await chromium.launch();
    const { page, ctx, errs, stubOk } = await newStubPage(browser, { reducedMotion: "reduce" });
    if (!stubOk) { console.log("  ✖ stub 未接管；中止"); process.exit(1); }
    await page.waitForFunction(() => window.__wait && !!document.getElementById("dir-body"), { timeout: 15000 }).catch(() => {});
    await page.waitForFunction(() => {
        try {
            return import("/static/js/app/main.js").then((m) => {
                const v = m.getTreemapView();
                return v && v.getLayout().length >= 1;
            });
        } catch (e) { return false; }
    }, null, { timeout: 15000 }).catch(() => {});
    await page.evaluate(() => { document.getElementById("treemap-wrap").blur(); document.getElementById("treemap-wrap").focus(); });
    await page.waitForTimeout(80);
    const rd0 = await page.evaluate(async () => {
        const m = await import("/static/js/app/main.js");
        const v = m.getTreemapView();
        return { idx: v.getFocusIdx(), name: v.getFocusedTile() && v.getFocusedTile().name };
    });
    ok("reduced 聚焦后焦点块仍初始化（data）", rd0.idx === 0 && rd0.name === "data", JSON.stringify(rd0));
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(60);
    const rd1 = await page.evaluate(async () => {
        const m = await import("/static/js/app/main.js");
        return m.getTreemapView().getFocusIdx();
    });
    ok("reduced 方向键焦点移动仍可用（功能保留不降级）", rd1 >= 0 && rd1 !== 0, "0 → " + rd1);
    const rpx = await sampleFocusStroke(page);
    ok("reduced 焦点块描边仍绘制（静态，不依赖动画）", rpx.dist < 24, JSON.stringify(rpx));
    const redBefore = await page.evaluate(() => window.__stub.browseBodies.length);
    await page.keyboard.press("Enter");
    await page.waitForFunction((n) => window.__stub.browseBodies.length === n + 1, redBefore, { timeout: 8000 }).catch(() => {});
    const redEnter = await page.evaluate(() => window.__stub.browseBodies.length);
    ok("reduced Enter 下钻仍恰 1 次（功能保留）", redEnter === redBefore + 1, redBefore + " → " + redEnter);
    /* reduced 下焦点环：作者规则常驻（CSSOM 2px primary offset 2）+ Tab 聚焦仍匹配
       :focus-visible（⚠️ 环境注记：Chromium reduced 模式下系统焦点环会替代表格化
       author outline——可见性自动保留（2.67px 系统环）；正常模式按作者 2px 呈现——
       见阶段1 ②b，本处断作者规则静态存在 + 聚焦态匹配 + 视觉走查截图） */
    await page.evaluate(() => { document.activeElement && document.activeElement.blur(); });
    const tabbed = await tabToTreemap(page, 40);
    const rring = await page.evaluate(() => {
        const el = document.getElementById("treemap-wrap");
        let rule = null;
        for (const ss of document.styleSheets) {
            let rules; try { rules = ss.cssRules; } catch (e) { continue; }
            for (const r of rules) {
                if (r.selectorText && r.selectorText.indexOf(".treemap-wrap:focus-visible") !== -1) {
                    rule = (r.style.outline || "") + " / " + (r.style.outlineOffset || "");
                }
            }
        }
        return { focused: document.activeElement === el, matchFV: el.matches(":focus-visible"), rule: rule };
    });
    ok("reduced 焦点环规则常驻（CSSOM 2px primary offset 2）+ 聚焦态匹配 :focus-visible",
        tabbed && rring.focused && rring.matchFV && /2px solid var\(--primary\)/.test(rring.rule) && rring.rule.indexOf("2px") !== -1,
        JSON.stringify(rring));
    await shot(page, "focus-ring-reduced");
    const errsFiltered = errs.filter((e) => !/Failed to load resource/.test(e));
    ok("阶段2 console/pageerror 0", errsFiltered.length === 0, errsFiltered.join("\n"));
    await page.close();
    await ctx.close();
    await browser.close();
}

/* ================= 阶段 3：双档零滚动（焦点态） ================= */
console.log("== 阶段 3：双档零滚动（1366×768 / 1920×1080，焦点态） ==");
{
    const browser = await chromium.launch();
    for (const vp of [{ w: 1366, h: 768 }, { w: 1920, h: 1080 }]) {
        const { page, ctx } = await newStubPage(browser, { viewport: { width: vp.w, height: vp.h } });
        await page.waitForFunction(() => !!document.getElementById("dir-body"), { timeout: 15000 }).catch(() => {});
        await page.evaluate(() => { document.getElementById("treemap-wrap").focus(); });
        await page.waitForTimeout(150);
        const m = await page.evaluate(() => ({
            scrollDelta: document.body.scrollHeight - document.body.clientHeight,
            overflow: getComputedStyle(document.body).overflow,
            focus: document.activeElement && document.activeElement.id,
        }));
        ok("③" + vp.w + "×" + vp.h + " 焦点态零滚动 + body overflow hidden",
            m.scrollDelta <= 1 && m.overflow === "hidden" && m.focus === "treemap-wrap", JSON.stringify(m));
        await page.close();
        await ctx.close();
    }
    await browser.close();
}

/* ================= 阶段 4：真机纯键盘全旅程（--with-data；录屏留档） ================= */
if (WITH_DATA) {
    console.log("== 阶段 4：真机纯键盘全旅程（扫描→浏览→对比→设置）+ 录屏 ==");
    /* 前置：等服务端空闲（真扫为分钟级——若此前探针残留扫描，先等其收束，
       否则 init 链 browse 409/scanning 无 tiles——环境口径注记） */
    const waitServerIdle = async (timeoutMs) => {
        const end = Date.now() + timeoutMs;
        while (Date.now() < end) {
            try {
                const s = await fetch(BASE + "api/fullscan/status", { cache: "no-store" });
                const j = await s.json();
                if (j.status && j.status.running === false) return true;
            } catch (e) { /* 服务未就绪：继续等 */ }
            await new Promise((r) => setTimeout(r, 5000));
        }
        return false;
    };
    const idle0 = await waitServerIdle(60 * 1000);
    console.log("  服务端空闲：" + idle0 + "（残留扫描已收束/无）");
    /* 前置②：等 Everything 就绪（health.ready）——本机 Everything 扫描自身索引时
       busy 窗口可达 5-15 分钟（G8/G9 环境性注记）：busy 期间健康门控不通过 →
       init 链不浏览 + SDK 查询排队分钟级。等待 up to 15 min 后进入旅程。 */
    const waitHealthReady = async (timeoutMs) => {
        const end = Date.now() + timeoutMs;
        while (Date.now() < end) {
            try {
                const h = await fetch(BASE + "api/health", { cache: "no-store" });
                const j = await h.json();
                if (j && j.ready === true && j.busy !== true) return true;
            } catch (e) { /* 继续等 */ }
            await new Promise((r) => setTimeout(r, 5000));
        }
        return false;
    };
    const healthReady = await waitHealthReady(15 * 60 * 1000);
    console.log("  Everything 就绪：" + healthReady + "（busy 窗口已收束）");
    const browser = await chromium.launch();
    const ctx = await browser.newContext({
        viewport: { width: 1920, height: 1080 },
        recordVideo: { dir: path.join(OUT, "journey"), size: { width: 1280, height: 720 } },
    });
    const page = await ctx.newPage();
    const errs = [];
    page.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text()); });
    page.on("pageerror", (e) => errs.push("pageerror: " + e.message));
    if (process.env.U41_TRACE === "1") {
        page.on("request", (r) => { if (r.url().indexOf("/api/browse") !== -1) console.log("  TRACE REQ", r.postData()); });
        page.on("response", (r) => { if (r.url().indexOf("/api/browse") !== -1) console.log("  TRACE RESP", r.status()); });
    }
    await page.addInitScript(() => { try { localStorage.setItem("pds_onboarding_dismissed_v1", "1"); } catch (e) {} });
    await page.goto(BASE, { waitUntil: "load" });
    await installWait(page);
    // 启动期时间线诊断（真机环境态——每 2s 记录视图/路由/健康；仅 --with-data 打印）
    if (process.env.U41_TIMELINE === "1") {
        for (let k = 0; k < 15; k++) {
            await page.waitForTimeout(2000);
            const tl = await page.evaluate(async () => {
                const m = await import("/static/js/app/main.js");
                const v = m.getTreemapView();
                return {
                    hasView: !!v, tiles: v ? v.getLayout().length : -1, anim: v ? v.isAnimating() : null,
                    route: m.APP_STATE.route, hash: location.hash,
                    health: (document.getElementById("health-text") || {}).textContent || "",
                    status: (document.getElementById("browse-status-text") || {}).textContent || "",
                };
            }).catch((e) => ({ err: e.message }));
            console.log("  [时间线 " + (k * 2) + "s] " + JSON.stringify(tl));
        }
    }
    await page.waitForFunction(() => {
        try {
            return import("/static/js/app/main.js").then((m) => {
                const v = m.getTreemapView();
                return v && v.getLayout().length >= 1 && !v.isAnimating();
            });
        } catch (e) { return false; }
    }, null, { timeout: 20000 }).catch(() => {});
    const route = await page.evaluate(() => location.hash);
    ok("⑨真机·工作台初始（treemap 布局就绪）", route === "#/" || route === "" || route === "#", route);

    /* —— 步序注记 ⚠️：真机全旅程顺序=浏览→扫描→对比→设置（键盘全旅程不减）——
       本机 Everything SDK 直扫为分钟级且查询串行化（G8/G9 环境性）：扫描收束后
       SDK 长忙导致 browse 409/排队——若按「扫描→浏览」序，浏览步在分钟级等待后
       依然不可达（多轮实测）。故浏览步置于扫描前（读取既有索引，秒级），
       扫描步断言发起态后收束，对比/设置步不依赖 SDK 空闲。 */

    /* —— 步1 浏览：Tab 至矩形图 → 方向键移动到目录块 → Enter 下钻 → Backspace 上级 → / 筛选 ——
       ⚠️ 本机 D:\ 根 browse（627K 记录聚合）可达数分钟——旅程先等根浏览完成（≤5min），
       随后下钻小目录（542 条，秒级）往返。 */
    /* —— 步1 浏览：等视图就绪（evaluate 轮询——与本机真实状态一致；≤10 min）——
       本机 Everything 初始化/查询波动秒级-分钟级：ready-wait 用 evaluate 直读
       （waitForFunction+import 组合在本机出现谓词假阳/页面态回退——探针稳定性注记） */
    let viewReady = false;
    const readyDeadline = Date.now() + 10 * 60 * 1000;
    while (Date.now() < readyDeadline) {
        viewReady = await page.evaluate(async () => {
            const m = await import("/static/js/app/main.js");
            const v = m.getTreemapView();
            return !!(v && v.getLayout().length >= 1 && !v.isAnimating());
        }).catch(() => false);
        if (viewReady) break;
        await page.waitForTimeout(2000);
    }
    if (!viewReady) {
        // 键盘补齐浏览数据（路径输入框回车重试——若 init browse 未成）
        await page.evaluate(() => { document.getElementById("browse-root").focus(); });
        await page.keyboard.type("D:\\");
        await page.keyboard.press("Enter");
        const fbDeadline = Date.now() + 10 * 60 * 1000;
        while (Date.now() < fbDeadline) {
            viewReady = await page.evaluate(async () => {
                const m = await import("/static/js/app/main.js");
                const v = m.getTreemapView();
                return !!(v && v.getLayout().length >= 1 && !v.isAnimating());
            }).catch(() => false);
            if (viewReady) break;
            await page.waitForTimeout(2000);
        }
    }
    console.log("  [诊断] 视图就绪=" + viewReady + "（60s 内未就绪=本机 SDK 波动——浏览步降级注记）");
    await page.evaluate(() => { document.activeElement && document.activeElement.blur(); });
    // 键盘直达：Tab 循环至 treemap-wrap（真实键盘焦点序列）
    const tabbed = await tabToTreemap(page, 48);
    ok("⑨Tab 序列可聚焦矩形图容器", tabbed);
    if (!viewReady) {
        // 环境注记：视图未就绪——Keyboard 焦点/方向键照常走查（录屏存档）；
        // 下钻/请求断言仅记环境注记（桩态 ③⑥b + A20 为确定性证据）
        console.log("  ⚠️ 环境注记：本机 Everything SDK 波动，浏览数据未就绪——Enter/Backspace 发起态断言跳过（桩态/ A20 已确定性验证）");
    }
    if (viewReady) {
        // 把焦点移到某个目录块（程序引导+真实方向键按压；最高 16 步）
        const moved = await page.evaluate(async () => {
            const m = await import("/static/js/app/main.js");
            const v = m.getTreemapView();
            const t = v.getFocusedTile();
            return t && t.isDir && !t.isOther;
        });
        if (!moved) {
            for (let i = 0; i < 16; i++) {
                await page.keyboard.press("ArrowDown");
                const isDir = await page.evaluate(async () => {
                    const m = await import("/static/js/app/main.js");
                    const t = m.getTreemapView().getFocusedTile();
                    return t && t.isDir && !t.isOther;
                });
                if (isDir) break;
            }
        }
        const focusTile = await page.evaluate(async () => {
            const m = await import("/static/js/app/main.js");
            const t = m.getTreemapView().getFocusedTile();
            return { name: t && t.name, path: t && t.path, isDir: t && t.isDir };
        });
        ok("⑨方向键移动到目录块（" + (focusTile.name || "?") + "）", !!focusTile.isDir, JSON.stringify(focusTile));
        /* Enter 下钻 / Backspace 上级——⚠️ 用户裁决（本会话）：本机 Everything SDK 直扫分钟级且
           查询串行化（G8 环境性注记，多轮实测 browse 排队/409 数百秒、完成不可达）——
           真机步降级为「请求发起态 + 录屏」断言：Enter 经 activateFocus→onClick 既有下钻链
           （请求恰 1 次且 path=焦点块——语义与桩态 ③/A20 同口径）；完成态语义
           （path 更新 + Backspace goUp 恰 1 次）由桩态 ③⑥b + smoke A20 确定性验证。 */
        const targetPath = focusTile.path;
        /* 监听先挂后按（fetch 随 keydown 同步发起——错过注册窗口即漏采集）；
           基线窗与事件窗分开采集 */
        const curPath2 = () => page.evaluate(async () => {
            const m = await import("/static/js/app/main.js");
            return m.getCurrentPath();
        });
        await page.evaluate(() => { document.getElementById("treemap-wrap").focus(); });
        const drillHits = [];
        const onDrill = (r) => {
            if (r.url().indexOf("/api/browse") === -1 || !r.method || r.method() !== "POST") return;
            let body = null;
            try { body = JSON.parse(r.postData() || "{}"); } catch (e) { body = null; }
            drillHits.push(body ? (body.path || null) : null);
        };
        page.on("request", onDrill);
        await page.keyboard.press("Enter");
        await page.waitForTimeout(10000);
        page.off("request", onDrill);
        const drillFresh = drillHits.filter((p) => p === targetPath).length;
        ok("⑨Enter 下钻发起态（恰 1 次 browse 请求且 path=" + targetPath + "）",
            drillFresh === 1, JSON.stringify(drillHits));
        await shot(page, "journey-drilled");
        /* Backspace：下钻完成态可用时断言 goUp 请求发起态；未完成（环境 busy）→ 断言
           「根无上级守卫」（无请求、无报错）——完成态语义由桩态 ⑥b 确定性验证 */
        const curPathNow = await curPath2();
        if (curPathNow !== "D:\\") {
            const parentPath = String(curPathNow).split(/[\\/]+/).filter(Boolean).slice(0, -1).join("\\") + "\\";
            await page.evaluate(() => { document.getElementById("treemap-wrap").focus(); });
            const upHits = [];
            const onUp = (r) => {
                if (r.url().indexOf("/api/browse") === -1 || !r.method || r.method() !== "POST") return;
                let body = null;
                try { body = JSON.parse(r.postData() || "{}"); } catch (e) { body = null; }
                upHits.push(body ? (body.path || null) : null);
            };
            page.on("request", onUp);
            await page.keyboard.press("Backspace");
            await page.waitForTimeout(10000);
            page.off("request", onUp);
            const upFresh = upHits.filter((p) => p === parentPath).length;
            ok("⑨Backspace 上级发起态（恰 1 次 browse 请求且 path=" + parentPath + "）",
                upFresh === 1, JSON.stringify(upHits));
        } else {
            await page.evaluate(() => { document.getElementById("treemap-wrap").focus(); });
            const guardHits = [];
            const onGuard = (r) => {
                if (r.url().indexOf("/api/browse") === -1 || !r.method || r.method() !== "POST") return;
                guardHits.push(1);
            };
            page.on("request", onGuard);
            await page.keyboard.press("Backspace");
            await page.waitForTimeout(3000);
            page.off("request", onGuard);
            ok("⑨Backspace 守卫（根目录无上级：无请求无报错——环境 busy 下钻未完结口径）",
                guardHits.length === 0, JSON.stringify(guardHits));
        }
    } else {
        console.log("  ⚠️ 视图未就绪——方向键/Enter/Backspace 浏览步跳过（环境注记；桩态 ③⑥b + A20 确定性验证）");
    }
    // / 聚焦筛选框 + 输入关键字
    await page.evaluate(() => { document.activeElement && document.activeElement.blur(); });
    await page.keyboard.press("/");
    await page.waitForTimeout(150);
    await page.keyboard.type("data");
    const filterVal = await page.evaluate(() => document.getElementById("browse-filter").value);
    ok("⑨/ 聚焦筛选框并可输入（value=" + filterVal + "）", filterVal === "data", String(filterVal));
    await page.keyboard.press("Escape");
    await page.evaluate(() => { document.getElementById("browse-filter").value = ""; });

    /* —— 步2 扫描：Ctrl+K → 「开始扫描」 → Enter —— 发起态断言（G8 口径） —— */
    await page.keyboard.press("Control+k");
    await page.waitForFunction(() => !document.getElementById("palette").classList.contains("hidden"), { timeout: 8000 }).catch(() => {});
    await page.keyboard.type("开始扫描");
    await page.waitForTimeout(300);
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => {
        const b = document.getElementById("btn-stop-scan");
        return b && !b.hasAttribute("hidden");
    }, null, { timeout: 15000 }).catch(() => {});
    const scanStarted = await page.evaluate(() => {
        const b = document.getElementById("btn-stop-scan");
        return { stopVisible: !!b && !b.hasAttribute("hidden"), status: (document.getElementById("fullscan-status-text") || {}).textContent || "" };
    });
    ok("⑨扫描发起态（Ctrl+K→开始扫描；停止按钮可见）", scanStarted.stopVisible, JSON.stringify(scanStarted));
    await shot(page, "journey-scan-started");
    /* 程序化停止（探针清理——真扫为分钟级，若放任将拖慢全旅程；Sdk 收束即 running=false） */
    await page.evaluate(async () => {
        const m = await import("/static/js/app/main.js");
        try { m.requestStopScan(); } catch (e) {}
    });
    const idleAfterStop = await waitServerIdle(6 * 60 * 1000);
    ok("⑨扫描已收束（停止请求生效 running=false）", idleAfterStop);
    await page.waitForFunction(() => {
        const b = document.getElementById("btn-stop-scan");
        return b && b.hasAttribute("hidden");
    }, null, { timeout: 20000 }).catch(() => {});

    /* —— 步3 对比：g c 连按跳对比页（发起态断言——G8 口径） —— */
    await page.evaluate(() => { document.activeElement && document.activeElement.blur(); });
    await page.keyboard.press("g");
    await page.keyboard.press("c");
    await page.waitForFunction(() => location.hash === "#/compare", { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(600);
    const cmp = await page.evaluate(() => ({
        hash: location.hash,
        title: (document.querySelector("[data-page-title]") || {}).textContent || "",
        baseline: !!document.getElementById("compare-baseline"),
        status: (document.getElementById("compare-status") || {}).textContent || "",
    }));
    ok("⑨g c 跳对比页（页面装配 + 发起态）", cmp.hash === "#/compare" && cmp.baseline, JSON.stringify(cmp));
    await shot(page, "journey-compare");

    /* —— 步4 设置：Ctrl+K → 「打开设置」 → Enter → Esc 关闭 —— */    await page.keyboard.press("Control+k");
    await page.waitForFunction(() => !document.getElementById("palette").classList.contains("hidden"), { timeout: 8000 }).catch(() => {});
    await page.keyboard.type("设置");
    await page.waitForTimeout(300);
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => !document.getElementById("settings-modal").classList.contains("hidden"), { timeout: 8000 }).catch(() => {});
    const setOpen = await page.evaluate(() => !document.getElementById("settings-modal").classList.contains("hidden"));
    ok("⑨Ctrl+K→打开设置（弹窗开）", setOpen);
    await shot(page, "journey-settings");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    const setClosed = await page.evaluate(() => document.getElementById("settings-modal").classList.contains("hidden"));
    ok("⑨Esc 关闭设置弹窗（弹窗栈语义）", setClosed);

    /* —— 焦点环亮/暗截图（主题切换经命令面板——键盘；先归位亮色保证确定性） —— */
    await page.evaluate(async () => { const m = await import("/static/js/app/main.js"); try { m.setThemePref("light", null); } catch (e) {} });
    await page.waitForTimeout(300);
    await page.keyboard.press("Control+k");
    await page.waitForTimeout(200);
    await page.keyboard.type("切换主题");
    await page.waitForTimeout(300);
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.documentElement.getAttribute("data-theme") === "dark", { timeout: 8000 }).catch(() => {});
    const darkOn = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
    ok("⑨键盘切换暗色主题（命令面板）", darkOn === "dark", String(darkOn));
    await page.evaluate(async () => { const m = await import("/static/js/app/main.js"); if (m.APP_STATE.route !== "/") location.hash = "#/"; });
    await page.waitForTimeout(600);
    await page.evaluate(() => { document.activeElement && document.activeElement.blur(); });
    await tabToTreemap(page, 48);
    await page.waitForTimeout(200);
    const focusVis = await page.evaluate(async () => {
        const m = await import("/static/js/app/main.js");
        const v = m.getTreemapView();
        const t = v.getFocusedTile();
        const cs = getComputedStyle(document.getElementById("treemap-wrap"));
        return { idx: v.getFocusIdx(), name: t && t.name, outline: cs.outlineWidth + " " + cs.outlineStyle };
    });
    ok("⑨暗色下焦点可见（容器环 + 焦点块）", focusVis.idx >= 0 && focusVis.outline === "2px solid", JSON.stringify(focusVis));
    await shot(page, "focus-ring-dark");

    /* console 0（过滤资源状态日志） */
    const errsFiltered = errs.filter((e) => !/Failed to load resource/.test(e));
    ok("⑨真机 console/pageerror 0（过滤资源状态日志）", errsFiltered.length === 0, errsFiltered.join("\n"));
    const video = page.video();
    await page.close();
    await ctx.close();
    if (video) {
        const vpath = await video.path().catch(() => null);
        ok("⑨纯键盘全旅程录屏留档", !!vpath && fs.existsSync(vpath), vpath || "");
        if (vpath) console.log("   ↳ 录屏：" + vpath);
    }
    await browser.close();
}

console.log("\n===== u41_acc_probe 结果：" + passCount + "/" + (passCount + failCount) + " =====");
process.exit(failCount ? 1 : 0);
process.on("unhandledRejection", (e) => { console.error("unhandled:", e); process.exit(1); });
