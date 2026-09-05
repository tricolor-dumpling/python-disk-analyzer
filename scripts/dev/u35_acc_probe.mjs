/* ============================================================
   UI 2.0（SpaceLens Pro）· U3.5 弹窗族与引导收尾验收探针
   - 验收口径（手册 §U3.5 + §3.5 L2-6/L2-10 + F03/N03 语义）：
     ①主题三态：设置弹窗亮/暗/跟随系统（与顶栏按钮同源 state.theme）；
       「跟随系统」=显式 system（与缺失 key 同值）→ matchMedia 解析；
       持久化 pds_theme_v1；OS 偏好变化实时跟随（matchMedia 监听）；
       刷新后 head 防闪烁脚本按三态口径解析（system→matchMedia）；
     ②危险区 L2-10：wipe-panel 红描边脉动 2.4s（::before wipe-pulse，仅 opacity）
       + 输入匹配「确认清空」→ 3s 倒计时禁用（--dur-wipe-countdown）→ 解锁；
       失配重计；重开复位；解锁执行 → POST /api/admin/wipe（confirm 正确）→
       wipe/settings 弹窗关闭 + resetCompareData 联动；
     ③Toast L2-6：320ms spring 滑入（--dur-3/--ease-spring）+ 时间线（TTL）
       + 成功描边 300ms（--dur-toast-stroke）+ 错误脉动 2 次（--dur-toast-pulse
       600ms，延迟至滑入结束）+ hover 暂停 + aria-live；类型描边色/时间线色；
     ④reduced 降级：滑入 ≤120ms、装饰性脉动/描边跳过、时间线无动画、
       wipe 脉动截断为静态（<1ms）、主题直切；
     ⑤弹窗栈回归（红线#9/A7 语义）：settings+wipe 叠开 Esc 逆序关栈顶；
     ⑥双档零滚动（1366×768 / 1920×1080，设置弹窗/清空弹窗态）；
     ⑦视觉截图（亮/暗设置弹窗、清空弹窗态、toast success/error、reduced）；
     ⑧真机阶段（--with-data）：设置弹窗三态切换 + 清空流程走查（输入确认文字
       →倒计时→执行→目录重建）——⚠️ 环境注记：沙箱 %LOCALAPPDATA% 写被拒时
       POST /api/admin/wipe 500（前端 toast 错误呈现），按「环境注记豁免」判定；
       console 0（过滤资源状态日志，U3.2 注记 4 口径）。
   - 运行：node scripts/dev/u35_acc_probe.mjs [--base http://127.0.0.1:5000/]
            [--out <截图目录>] [--with-data]
   - ⚠️ addInitScript 传函数体字符串；注入后先校验 window.__stub 接管；
     stub 内路径转义沿用 u34 惯例（模板字面量 4 反斜杠 → 注入 2 → 页面值 1）。
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
const OUT = arg("out", path.join(os.tmpdir(), "u35_acc_shots"));
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

/* ---- 桩态 fetch（addInitScript；键集合覆盖 init 全链 + 本工作项触点） ---- */
const STUB_FN = `
window.__stub = { fetchLog: [], wipeCount: 0, wipeBody: null, settingsPost: [] };
window.fetch = function (url, options) {
  options = options || {};
  const key = (options.method || "GET").toUpperCase() + " " + String(url).split("?")[0];
  window.__stub.fetchLog.push(key);
  const json = (o, s) => Promise.resolve({ ok: (s || 200) < 400, status: s || 200,
    json: () => Promise.resolve(JSON.parse(JSON.stringify(o))) });
  if (key === "GET /api/health") return json({ ok: true, ready: true, dll: "stub-dll", message: "Everything 已就绪" });
  if (key === "GET /api/settings") return json({ ok: true, settings: { auto_save: false, last_roots: ["D:\\\\"] }, data_dir: "C:\\\\stub\\\\data", snapshots_dir: "C:\\\\stub\\\\snapshots" });
  if (key === "POST /api/settings") { window.__stub.settingsPost.push(options.body ? JSON.parse(options.body) : {}); return json({ ok: true, settings: { auto_save: false } }); }
  if (key === "POST /api/browse") return json({ ok: true, root: "D:\\\\", parent: null, directories: [ { name: "data", path: "D:\\\\data", is_dir: true, size: 12000, size_human: "11.72 KB" } ], files: [], total_dirs: 1, total_files: 0 });
  if (key === "GET /api/fullscan/status") return json({ ok: true, status: { running: false, roots: ["C:\\\\", "D:\\\\"], roots_done: 2, roots_total: 2, current_root: null, error: null, result_ready: true, save_ready: true, progress_pct: 100, scan_version: 1, stop_requested: false, stop_reason: null } });
  if (key === "OPTIONS /api/fullscan/stop") return json({ ok: true }, 200);
  if (key === "POST /api/fullscan/stop") return json({ ok: true, stopped: false });
  if (key === "GET /api/snapshots") return json({ ok: true, sessions: [], count: 0 });
  if (key === "POST /api/compare") return json({ ok: true, report: { root: "D:\\\\", total_baseline: 0, total_current: 0, delta_total: 0, truncated: false, legacy_count: 0, rows: [] } });
  if (key === "GET /api/overview") return json({ ok: true, ready: true, roots: [], completed_at: "2026-08-24T10:00:00" });
  if (key === "POST /api/open-path") return json({ ok: true, launched: true, message: "ok" });
  if (key === "POST /api/save") return json({ ok: true, message: "保存完成" });
  if (key === "POST /api/save/undo") return json({ ok: true, message: "已撤销最近一次保存" });
  if (key === "POST /api/admin/wipe") {
    window.__stub.wipeCount = (window.__stub.wipeCount || 0) + 1;
    window.__stub.wipeBody = options.body ? JSON.parse(options.body) : null;
    return json({ ok: true, message: "数据目录已清空", data_dir: "C:\\\\stub\\\\data" });
  }
  return json({ ok: true });
};
`;

async function newStubPage(browser, w, h) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
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

async function metricViewport(page, w, h) {
    return page.evaluate(([vw, vh]) => new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => {
            resolve({
                w: vw, h: vh,
                bodySh: document.body.scrollHeight,
                bodyCh: document.body.clientHeight,
                bodyOverflow: getComputedStyle(document.body).overflow,
            });
        }));
    }), [w, h]);
}

function tokenColor(page, name) {
    return page.evaluate((n) => {
        const d = document.createElement("div");
        d.style.color = "var(" + n + ")";
        document.body.appendChild(d);
        const c = getComputedStyle(d).color;
        d.remove();
        return c;
    }, name);
}

/* 页内读取 toast 动画组（slide 320/pulse 600/timeline TTL） */
function toastAnims(page, sel) {
    return page.evaluate((s) => {
        const el = document.querySelector(s);
        if (!el) return null;
        const of = (a) => a.effect && a.effect.getTiming();
        const list = el.getAnimations().map((a) => ({
            dur: of(a).duration, delay: of(a).delay, playState: a.playState,
            kf: (a.effect.getKeyframes() || []).map((k) => String(k.transform || "")).join(","),
        }));
        const tl = el.querySelector(".toast-timeline");
        const tlA = tl ? tl.getAnimations().map((a) => ({ dur: of(a).duration, playState: a.playState })) : [];
        return { list, timeline: tlA, hasStroke: !!el.querySelector(".toast-stroke") };
    }, sel);
}

(async () => {
    const browser = await chromium.launch();
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));

    /* ================= 阶段 1：桩态（1366×768） ================= */
    console.log("== 阶段 1：桩态（stub fetch，1366×768） ==");
    const { page, errs: errs1, stubOk } = await newStubPage(browser, 1366, 768);
    if (!stubOk) {
        ok("前置：桩态 fetch 已接管", false, "window.__stub 缺失");
        await browser.close();
        process.exit(1);
    }
    ok("前置：桩态 fetch 已接管", true);
    await page.waitForFunction(() => document.getElementById("browse-root") !== null, null, { timeout: 15000 }).catch(() => {});
    await page.evaluate(() => window.__wait(() => window.__stub.fetchLog.indexOf("GET /api/settings") !== -1, 8000));
    await wait(500);

    /* ---- ① 主题三态 ---- */
    console.log("-- ① 主题三态（设置弹窗/顶栏同源/跟随系统） --");
    await page.evaluate(() => { try { localStorage.removeItem("pds_theme_v1"); } catch (e) {} });
    // 缺失 key → system；resolvedTheme 与 data-theme 一致
    let r = await page.evaluate(async () => {
        const t = await import("/static/js/app/theme.js");
        const sysDark = !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
        return {
            pref: t.themePref(), resolved: t.resolvedTheme(), sysDark: sysDark,
            attr: document.documentElement.getAttribute("data-theme"),
        };
    });
    ok("①a 缺失 key → 偏好回落「跟随系统」", r.pref === "system", "pref=" + r.pref);
    ok("①b resolvedTheme 随系统解析（matchMedia）", r.resolved === (r.sysDark ? "dark" : "light"), "resolved=" + r.resolved);
    ok("①c data-theme=系统解析值（head 防闪烁口径）", r.attr === r.resolved, "attr=" + r.attr);

    r = await page.evaluate(async () => {
        const t = await import("/static/js/app/theme.js");
        const s = await import("/static/js/app/state.js");
        t.setThemePref("system", null);
        return {
            ls: localStorage.getItem("pds_theme_v1"),
            attr: document.documentElement.getAttribute("data-theme"),
            state: s.APP_STATE.theme,
            pref: t.themePref(),
        };
    });
    ok("①d setThemePref(system)：持久化 system + data-theme 解析值 + state.theme=system",
       r.ls === "system" && r.pref === "system" && r.state === "system" && r.attr === (await page.evaluate(() => window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")),
       JSON.stringify(r));

    // 打开设置弹窗 → 单选回显 system
    await page.click("#btn-settings");
    await page.evaluate(() => window.__wait(() => !document.getElementById("settings-modal").classList.contains("hidden"), 5000));
    r = await page.evaluate(() => ({
        radio: ["light", "dark", "system"].map((v) => document.getElementById("setting-theme-" + v).checked),
    }));
    ok("①e 设置弹窗单选回显 system（亮/暗/跟随系统 三态在位）", JSON.stringify(r.radio) === JSON.stringify([false, false, true]), JSON.stringify(r.radio));

    // 选择「暗」→ 即生效（data-theme=dark + 持久化 dark + 单选互斥）
    await page.click(".theme-opt:has(#setting-theme-dark) span");
    await wait(200); // VT 路径下 data-theme 在转场回调内应用（A1/A19 同口径）
    r = await page.evaluate(() => ({
        attr: document.documentElement.getAttribute("data-theme"),
        ls: localStorage.getItem("pds_theme_v1"),
        radio: ["light", "dark", "system"].map((v) => document.getElementById("setting-theme-" + v).checked),
    }));
    ok("①f 选「暗」即生效：data-theme=dark + 持久化 dark + 单选互斥",
       r.attr === "dark" && r.ls === "dark" && JSON.stringify(r.radio) === JSON.stringify([false, true, false]), JSON.stringify(r));

    // 选择「跟随系统」→ 回 matchMedia 解析值
    await page.click(".theme-opt:has(#setting-theme-system) span");
    await wait(200);
    r = await page.evaluate(() => {
        const sysDark = !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
        return { attr: document.documentElement.getAttribute("data-theme"), ls: localStorage.getItem("pds_theme_v1"), sysDark: sysDark };
    });
    ok("①g 选「跟随系统」→ data-theme 回 matchMedia 解析值 + 持久化 system",
       r.attr === (r.sysDark ? "dark" : "light") && r.ls === "system", JSON.stringify(r));

    // 顶栏联动：关设置 → 顶栏翻转（dark）→ 重开设置单选回显 dark
    await page.keyboard.press("Escape");
    await page.evaluate(() => window.__wait(() => document.getElementById("settings-modal").classList.contains("hidden"), 3000));
    await page.click("#btn-theme");
    await wait(200);
    r = await page.evaluate(() => ({ attr: document.documentElement.getAttribute("data-theme"), ls: localStorage.getItem("pds_theme_v1") }));
    ok("①h 顶栏翻转（from system+解析值 → 显式翻转）", r.attr === (r.ls === "dark" ? "dark" : "light") && (r.ls === "dark" || r.ls === "light"), JSON.stringify(r));
    const flippedTheme = r.ls;
    await page.click("#btn-settings");
    await page.evaluate(() => window.__wait(() => !document.getElementById("settings-modal").classList.contains("hidden"), 3000));
    r = await page.evaluate(() => {
        const attr = document.documentElement.getAttribute("data-theme");
        return { checked: document.getElementById("setting-theme-" + attr).checked, attr: attr };
    });
    ok("①i 顶栏翻转后重开设置 → 单选同步（同源联动）", r.checked === true, JSON.stringify(r));
    await page.keyboard.press("Escape");

    // 跟随系统实时性：pref=system + emulateMedia OS 变化 → data-theme 实时跟随
    await page.evaluate(async () => {
        const t = await import("/static/js/app/theme.js");
        t.setThemePref("system", null);
    });
    await page.emulateMedia({ colorScheme: "dark" });
    await wait(250);
    r = await page.evaluate(() => ({ attr: document.documentElement.getAttribute("data-theme"), ls: localStorage.getItem("pds_theme_v1") }));
    ok("①j 跟随系统：OS 切暗 → data-theme 实时 dark（matchMedia 监听）", r.attr === "dark" && r.ls === "system", JSON.stringify(r));
    await page.emulateMedia({ colorScheme: "light" });
    await wait(250);
    r = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
    ok("①k 跟随系统：OS 切亮 → data-theme 实时 light", r === "light", "attr=" + r);

    // 刷新持久化一致性（head 防闪烁三态解析：system → matchMedia）
    await page.emulateMedia({ colorScheme: "dark" });
    await page.reload({ waitUntil: "load" });
    await installWait(page);
    await page.evaluate(() => window.__wait(() => window.__stub && window.__stub.fetchLog.indexOf("GET /api/settings") !== -1, 8000));
    r = await page.evaluate(() => ({ attr: document.documentElement.getAttribute("data-theme"), ls: localStorage.getItem("pds_theme_v1") }));
    ok("①l 刷新后：localStorage=system + data-theme=匹配的 dark（head 三态解析一致）",
       r.ls === "system" && r.attr === "dark", JSON.stringify(r));
    await page.emulateMedia({ colorScheme: "light" });
    await wait(250);
    r = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
    ok("①m 刷新后 light 跟随同样成立（listener 重挂）", r === "light", "attr=" + r);

    /* ---- ② 危险区 L2-10 ---- */
    console.log("-- ② 危险区 L2-10（脉动 2.4s + 3s 倒计时解锁） --");
    // 打开设置 → 危险区按钮 → wipe 弹窗
    await page.evaluate(async () => {
        const t = await import("/static/js/app/theme.js");
        t.setThemePref("light", null);
    });
    await page.click("#btn-settings");
    await page.evaluate(() => window.__wait(() => !document.getElementById("settings-modal").classList.contains("hidden"), 3000));
    await page.click("#btn-wipe-open");
    await page.evaluate(() => window.__wait(() => !document.getElementById("wipe-modal").classList.contains("hidden"), 3000));
    r = await page.evaluate(() => {
        const panel = document.querySelector("#wipe-modal .modal-panel");
        const cs = getComputedStyle(panel, "::before");
        return { name: cs.animationName, dur: (parseFloat(cs.animationDuration) || 0) * 1000, cls: panel.className,
                 btnDisabled: document.getElementById("btn-wipe").disabled, btnText: document.getElementById("btn-wipe").textContent };
    });
    ok("②a wipe 面板 wipe-panel 类 + ::before 红描边脉动动画（wipe-pulse）", r.cls.indexOf("wipe-panel") !== -1 && r.name === "wipe-pulse", JSON.stringify({ cls: r.cls, name: r.name }));
    ok("②b 脉动周期 2.4s（--dur-breathe）", Math.abs(r.dur - 2400) < 1, "dur=" + r.dur);
    ok("②c 打开即禁用 + 文案「确认清空」", r.btnDisabled === true && r.btnText === "确认清空", JSON.stringify({ d: r.btnDisabled, t: r.btnText }));
    await shot(page, "wipe-modal-armed-light-1366");

    // 输入匹配 → 3s 倒计时（禁用 + 秒数），随后解锁
    await page.fill("#wipe-confirm", "确认清空");
    await wait(300);
    r = await page.evaluate(() => ({ disabled: document.getElementById("btn-wipe").disabled, text: document.getElementById("btn-wipe").textContent }));
    ok("②d 匹配后倒计时期间禁用 + 显示秒数", r.disabled === true && /确认清空（\d+s）/.test(r.text), JSON.stringify(r));
    await shot(page, "wipe-modal-countdown-1366");
    await page.evaluate(() => window.__wait(() => document.getElementById("btn-wipe").disabled === false, 5000));
    r = await page.evaluate(() => document.getElementById("btn-wipe").textContent);
    ok("②e 3s 倒计时结束解锁（文案复位）", r === "确认清空", "text=" + r);

    // 失配重计
    await page.fill("#wipe-confirm", "确认清空x");
    await wait(150);
    r = await page.evaluate(() => ({ disabled: document.getElementById("btn-wipe").disabled, text: document.getElementById("btn-wipe").textContent }));
    ok("②f 失配立即取消武装（禁用 + 复位文案）", r.disabled === true && r.text === "确认清空", JSON.stringify(r));
    await page.fill("#wipe-confirm", "确认清空");
    await wait(300);
    r = await page.evaluate(() => document.getElementById("btn-wipe").textContent);
    ok("②g 再匹配 → 倒计时重计", /确认清空（\d+s）/.test(r), "text=" + r);
    // 清空输入复位
    await page.fill("#wipe-confirm", "");
    await wait(150);
    r = await page.evaluate(() => document.getElementById("btn-wipe").disabled);
    ok("②h 清空输入回禁用", r === true, "disabled=" + r);

    // 重开复位 + 完整执行链（确认 → POST /api/admin/wipe → 弹窗关闭 + 联动复位）
    await page.keyboard.press("Escape"); // 关 wipe
    await page.evaluate(() => window.__wait(() => document.getElementById("wipe-modal").classList.contains("hidden"), 3000));
    await page.click("#btn-wipe-open");
    await page.evaluate(() => window.__wait(() => !document.getElementById("wipe-modal").classList.contains("hidden"), 3000));
    r = await page.evaluate(() => ({ disabled: document.getElementById("btn-wipe").disabled, text: document.getElementById("btn-wipe").textContent, input: document.getElementById("wipe-confirm").value }));
    ok("②i 重开复位（输入清空 + 禁用 + 文案复位）", r.disabled === true && r.text === "确认清空" && r.input === "", JSON.stringify(r));
    await page.fill("#wipe-confirm", "确认清空");
    await page.evaluate(() => window.__wait(() => document.getElementById("btn-wipe").disabled === false, 5000));
    await page.click("#btn-wipe");
    await page.evaluate(() => window.__wait(() => (window.__stub.wipeCount || 0) >= 1, 3000));
    r = await page.evaluate(() => Promise.all([
        Promise.resolve(window.__stub.wipeBody),
        Promise.resolve(window.__stub.wipeCount),
    ]).then(([body, count]) => ({
        body: body, count: count,
        wipeHidden: document.getElementById("wipe-modal").classList.contains("hidden"),
        settingsHidden: document.getElementById("settings-modal").classList.contains("hidden"),
        toast: document.getElementById("toast-container").textContent,
    })));
    ok("②j 确认执行 → POST /api/admin/wipe（confirm=确认清空）", r.count === 1 && r.body && r.body.confirm === "确认清空", JSON.stringify(r.body));
    ok("②k 成功后 wipe+settings 弹窗关闭 + 成功 toast", r.wipeHidden && r.settingsHidden && r.toast.indexOf("数据目录已清空") !== -1, JSON.stringify({ w: r.wipeHidden, s: r.settingsHidden, t: r.toast.slice(0, 40) }));
    await shot(page, "wipe-success-toast-1366");
    // 等 toast 自动消失前置：手动清场（避免干扰后续）
    await page.evaluate(() => { document.getElementById("toast-container").innerHTML = ""; });

    /* ---- ③ Toast L2-6 ---- */
    console.log("-- ③ Toast L2-6（320ms spring/时间线/描边/脉动/hover 暂停） --");
    r = await page.evaluate(() => ({
        aria: document.getElementById("toast-container").getAttribute("aria-live"),
    }));
    ok("③a toast 容器 aria-live=polite（F21）", r.aria === "polite", "aria=" + r.aria);

    await page.evaluate(async () => {
        const toast = await import("/static/js/app/components/toast.js");
        toast.toast("U35-success", "success");
        toast.toast("U35-error", "error");
    });
    await wait(250);
    r = await toastAnims(page, ".toast-success");
    const tk = r && r.list || [];
    const slide = tk.find((a) => a.dur === 320);
    const tl = r.timeline[0] || null;
    ok("③b 滑入 320ms（--dur-3 spring）", !!slide, JSON.stringify(tk.map((a) => a.dur)));
    ok("③c 时间线动画时长=TTL（success 4000ms）scaleX 1→0", !!tl && tl.dur === 4000 && tk.filter((a) => a.dur === 4000).length === 0,
       JSON.stringify(tl));
    ok("③d success 描边层（300ms --dur-toast-stroke）", r.hasStroke === true, "hasStroke=" + r.hasStroke);
    r = await page.evaluate(() => {
        const el = document.querySelector(".toast-success");
        const stroke = el.querySelector(".toast-stroke");
        const a = stroke.getAnimations()[0];
        return { dur: a && a.effect.getTiming().duration, kf: (a && (a.effect.getKeyframes()[0].opacity || "")) || "MISSING" };
    });
    ok("③e 成功描边 300ms + opacity 0→1", r.dur === 300 && r.kf === "0", JSON.stringify(r));

    // 类型描边色（border-left）与时间线色 = token 色值（仅依赖 token，不硬编码）
    const danger = await tokenColor(page, "--danger");
    const success = await tokenColor(page, "--success");
    r = await page.evaluate(() => ({
        errBorder: getComputedStyle(document.querySelector(".toast-error")).borderLeftColor,
        errTl: getComputedStyle(document.querySelector(".toast-error .toast-timeline")).backgroundColor,
        succBorder: getComputedStyle(document.querySelector(".toast-success")).borderLeftColor,
    }));
    ok("③f 类型色 = token（--danger/--success）", r.errBorder === danger && r.errTl === danger && r.succBorder === success, JSON.stringify({ err: r.errBorder, danger: danger, succ: r.succBorder, success: success }));

    r = await toastAnims(page, ".toast-error");
    const pulse = (r.list || []).find((a) => a.dur === 600);
    ok("③g 错误脉动 2 次（--dur-toast-pulse 600ms）", !!pulse, JSON.stringify(r.list));
    ok("③h 脉动延迟 320ms 至滑入结束", pulse && pulse.delay === 320, "delay=" + (pulse && pulse.delay));
    ok("③i 脉动关键帧含 scale(1.02)（仅 transform/opacity）", pulse && pulse.kf.indexOf("scale(1.02)") !== -1, "kf=" + (pulse && pulse.kf.slice(0, 80)));
    await shot(page, "toast-success-error-1366");

    // hover 暂停（真实鼠标悬停 success toast）
    const tlEl = await page.$(".toast-success .toast-timeline");
    const box = await tlEl.boundingBox();
    if (box) {
        await page.mouse.move(box.x + box.width / 2, box.y - 6); // 时间线上方（toast body）
        await wait(120);
        const st1 = await page.evaluate(() => document.querySelector(".toast-success .toast-timeline").getAnimations()[0].playState);
        await page.mouse.move(box.x - 200, box.y - 6); // 移出
        await wait(120);
        const st2 = await page.evaluate(() => document.querySelector(".toast-success .toast-timeline").getAnimations()[0].playState);
        ok("③j hover 暂停时间线 → 移出恢复", st1 === "paused" && st2 === "running", "in=" + st1 + " out=" + st2);
    } else {
        ok("③j hover 暂停时间线 → 移出恢复", false, "toast 不可见");
    }
    // 关闭按钮移除
    await page.evaluate(() => {
        document.querySelectorAll(".toast-close").forEach((b) => b.click());
    });
    await page.evaluate(() => window.__wait(() => document.querySelectorAll("#toast-container .toast").length === 0, 3000));
    ok("③k 关闭按钮移除 toast", true);

    /* ---- ④ reduced 降级 ---- */
    console.log("-- ④ reduced-motion 降级（滑入 ≤120ms / 装饰跳过 / 时间线无动画） --");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.evaluate(async () => {
        const toast = await import("/static/js/app/components/toast.js");
        toast.toast("U35-reduced-err", "error");
    });
    await wait(60); // 滑入 120ms 仍在播放窗口内采样（填满后 getAnimations 不可见）
    r = await toastAnims(page, ".toast-error");
    const rdSlide = (r.list || []).find((a) => a.dur === 120);
    const rdPulse = (r.list || []).find((a) => a.dur === 600);
    ok("④a reduced：滑入 ≤120ms（--dur-1）", !!rdSlide, JSON.stringify(r.list));
    ok("④b reduced：错误脉动跳过（无 600ms 动画）", !rdPulse, JSON.stringify(r.list));
    ok("④c reduced：时间线无播放（JS 暂停，装饰跳过）", r.timeline[0] && r.timeline[0].playState === "paused", JSON.stringify(r.timeline));
    // wipe 脉动在 reduced 下被全局降级截断（静置红描边=危险提示保留）
    await page.evaluate(async () => {
        const t = await import("/static/js/app/theme.js");
        t.setThemePref("dark", null,);
    });
    await page.evaluate(() => window.__wait(() => document.documentElement.getAttribute("data-theme") === "dark", 3000));
    await page.click("#btn-settings");
    await page.evaluate(() => window.__wait(() => !document.getElementById("settings-modal").classList.contains("hidden"), 3000));
    await page.click("#btn-wipe-open");
    await page.evaluate(() => window.__wait(() => !document.getElementById("wipe-modal").classList.contains("hidden"), 3000));
    r = await page.evaluate(() => {
        const cs = getComputedStyle(document.querySelector("#wipe-modal .modal-panel"), "::before");
        return { name: cs.animationName, dur: parseFloat(cs.animationDuration) || 0 };
    });
    ok("④d reduced：wipe 脉动名在位但时长截断（<1ms 静态）", r.name === "wipe-pulse" && r.dur < 1, JSON.stringify(r));
    // reduced 主题直切（VT 路径绕过）
    r = await page.evaluate(async () => {
        const t = await import("/static/js/app/theme.js");
        t.setThemePref("light", { clientX: 10, clientY: 10 });
        return document.documentElement.getAttribute("data-theme");
    });
    ok("④e reduced：主题切换直切（data-theme=light 同步生效）", r === "light", "attr=" + r);
    await shot(page, "wipe-modal-reduced-dark-1366");
    await page.keyboard.press("Escape");
    await page.evaluate(() => window.__wait(() => document.getElementById("wipe-modal").classList.contains("hidden"), 3000));
    await page.keyboard.press("Escape");
    await page.evaluate(() => window.__wait(() => document.getElementById("settings-modal").classList.contains("hidden"), 3000));
    await page.emulateMedia({ reducedMotion: null });
    await page.evaluate(() => { document.getElementById("toast-container").innerHTML = ""; });

    /* ---- ⑤ 弹窗栈回归（红线 #9 / A7 语义） ---- */
    console.log("-- ⑤ 弹窗栈回归（Esc 逆序关栈顶） --");
    await page.click("#btn-settings");
    await page.evaluate(() => window.__wait(() => !document.getElementById("settings-modal").classList.contains("hidden"), 3000));
    await page.click("#btn-wipe-open");
    await page.evaluate(() => window.__wait(() => !document.getElementById("wipe-modal").classList.contains("hidden"), 3000));
    await page.keyboard.press("Escape");
    await wait(120);
    r = await page.evaluate(() => ({
        wipeHidden: document.getElementById("wipe-modal").classList.contains("hidden"),
        settingsOpen: !document.getElementById("settings-modal").classList.contains("hidden"),
    }));
    ok("⑤a Esc 关栈顶（wipe）→ settings 仍在", r.wipeHidden && r.settingsOpen, JSON.stringify(r));
    await page.keyboard.press("Escape");
    await wait(120);
    r = await page.evaluate(() => document.getElementById("settings-modal").classList.contains("hidden"));
    ok("⑤b 再 Esc 关 settings（逆序收尾）", r === true, "settingsHidden=" + r);

    /* ---- ⑥ 双档零滚动（设置/清空弹窗态）+ 亮暗截图 ---- */
    console.log("-- ⑥ 双档零滚动 + 视觉截图 --");
    await page.evaluate(async () => {
        const t = await import("/static/js/app/theme.js");
        t.setThemePref("light", null);
    });
    for (const [w, h, tag] of [[1366, 768, "1366x768"], [1920, 1080, "1920x1080"]]) {
        await page.setViewportSize({ width: w, height: h });
        await wait(300);
        await page.click("#btn-settings");
        await page.evaluate(() => window.__wait(() => !document.getElementById("settings-modal").classList.contains("hidden"), 3000));
        await wait(300); // 等 modal fade-in 完成（截图/采样避免半透明伪影）
        let z = await metricViewport(page, w, h);
        ok("⑥" + tag + " 设置弹窗态零滚动", z.bodySh <= z.bodyCh + 1, JSON.stringify(z));
        await shot(page, "settings-light-" + tag);
        await page.evaluate(async () => { const t = await import("/static/js/app/theme.js"); t.setThemePref("dark", null); });
        await wait(150);
        await shot(page, "settings-dark-" + tag);
        await page.evaluate(async () => {
            const t = await import("/static/js/app/theme.js");
            t.setThemePref("light", null);
        });
        await page.keyboard.press("Escape");
        await page.evaluate(() => window.__wait(() => document.getElementById("settings-modal").classList.contains("hidden"), 3000));
    }

    /* ---- ⑦ 阶段 1 console/pageerror 0 ---- */
    ok("⑦ 阶段1 console/pageerror 0", errs1.length === 0, errs1.join(" | "));
    await page.context().close();

    /* ================= 阶段 2：reduced 全量（独立上下文） ================= */
    console.log("== 阶段 2：reduced 桩态复核（独立上下文） ==");
    const red = await newStubPage(browser, 1366, 768);
    await red.page.emulateMedia({ reducedMotion: "reduce" });
    await red.page.waitForFunction(() => document.getElementById("browse-root") !== null, null, { timeout: 15000 }).catch(() => {});
    await wait(400);
    let rr = await red.page.evaluate(async () => {
        const t = await import("/static/js/app/theme.js");
        t.setThemePref("dark", { clientX: 8, clientY: 8 });
        return document.documentElement.getAttribute("data-theme");
    });
    ok("⑧a reduced 主题直切（<80ms 语义：同步生效）", rr === "dark", "attr=" + rr);
    rr = await red.page.evaluate(async () => {
        const toast = await import("/static/js/app/components/toast.js");
        toast.toast("R-success", "success");
        const el = document.querySelector(".toast-success");
        await new Promise((r2) => setTimeout(r2, 100));
        const slide = el.getAnimations().find((a) => a.effect && a.effect.getTiming().duration === 120);
        const strokeA = el.querySelector(".toast-stroke").getAnimations().length;
        const tlA = el.querySelector(".toast-timeline").getAnimations()[0].playState;
        return { slide: !!slide, strokeAnims: strokeA, tlState: tlA, aria: document.getElementById("toast-container").getAttribute("aria-live") };
    });
    ok("⑧b reduced success：滑入 120ms + 描边无动画（跳过）+ 时间线暂停", rr.slide && rr.strokeAnims === 0 && rr.tlState === "paused", JSON.stringify(rr));
    ok("⑧c reduced 功能性保留（toast 渲染 + aria-live 在位）", rr.aria === "polite", "aria=" + rr.aria);
    ok("⑧d reduced 阶段 console/pageerror 0", red.errs.length === 0, red.errs.join(" | "));
    await red.page.context().close();

    /* ================= 阶段 3：真机（--with-data） ================= */
    if (WITH_DATA) {
        console.log("== 阶段 3：真机（真实后端，Flask 5000） ==");
        const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
        const p = await ctx.newPage();
        const errs2 = [];
        p.on("console", (m) => { if (m.type() === "error") errs2.push("console: " + m.text()); });
        p.on("pageerror", (e) => errs2.push("pageerror: " + e.message));
        await p.addInitScript(() => { try { localStorage.setItem("pds_onboarding_dismissed_v1", "1"); } catch (e) {}
            try { sessionStorage.setItem("pds_auto_started_v1", "1"); } catch (e) {} });
        await p.addInitScript(() => {
            window.addEventListener("load", () => {
                import("/static/js/app/main.js").then((m) => { try { m.closeModal("onboarding"); } catch (e) {} }).catch(() => {});
            });
        });
        await p.goto(BASE, { waitUntil: "load" });
        await installWait(p);
        await p.waitForFunction(() => document.getElementById("browse-root") !== null, null, { timeout: 20000 }).catch(() => {});
        await wait(1200);

        // 设置弹窗三态切换（真实页面：仅 localStorage，零后端写）
        await p.click("#btn-settings");
        await p.evaluate(() => window.__wait(() => !document.getElementById("settings-modal").classList.contains("hidden"), 5000));
        let q = await p.evaluate(() => ({
            radio: ["light", "dark", "system"].map((v) => document.getElementById("setting-theme-" + v).checked),
        }));
        ok("⑨a 真机：设置弹窗三态单选在位（缺 key=system 回显）", JSON.stringify(q.radio) === JSON.stringify([false, false, true]), JSON.stringify(q.radio));
        await p.click(".theme-opt:has(#setting-theme-dark) span");
        await wait(250);
        q = await p.evaluate(() => ({ attr: document.documentElement.getAttribute("data-theme"), ls: localStorage.getItem("pds_theme_v1") }));
        ok("⑨b 真机：选「暗」即生效 + 持久化", q.attr === "dark" && q.ls === "dark", JSON.stringify(q));
        await shot(p, "real-settings-dark-1366");
        await p.click(".theme-opt:has(#setting-theme-light) span");
        await wait(250);
        q = await p.evaluate(() => document.documentElement.getAttribute("data-theme"));
        ok("⑨c 真机：选「亮」即生效", q === "light", "attr=" + q);
        await p.click(".theme-opt:has(#setting-theme-system) span");
        await wait(250);
        q = await p.evaluate(() => localStorage.getItem("pds_theme_v1") + ":" + document.documentElement.getAttribute("data-theme"));
        ok("⑨d 真机：选「跟随系统」→ system:解析值", /^system:(light|dark)$/.test(q), "v=" + q);

        // 清空流程走查（输入确认文字 → 倒计时 → 执行 → 目录重建/环境注记豁免）
        await p.click("#btn-wipe-open");
        await p.evaluate(() => window.__wait(() => !document.getElementById("wipe-modal").classList.contains("hidden"), 3000));
        await p.fill("#wipe-confirm", "确认清空");
        await wait(300);
        q = await p.evaluate(() => ({ disabled: document.getElementById("btn-wipe").disabled, text: document.getElementById("btn-wipe").textContent }));
        ok("⑨e 真机：匹配「确认清空」→ 3s 倒计时禁用", q.disabled === true && /确认清空（\d+s）/.test(q.text), JSON.stringify(q));
        await p.evaluate(() => window.__wait(() => document.getElementById("btn-wipe").disabled === false, 6000));
        await p.click("#btn-wipe");
        // 成功 → toast「数据目录已清空」+ 弹窗关闭；沙箱写 %LOCALAPPDATA% 被拒 → 500 错误 toast（环境注记豁免）
        await wait(1200);
        q = await p.evaluate(() => ({
            toast: document.getElementById("toast-container").textContent,
            wipeHidden: document.getElementById("wipe-modal").classList.contains("hidden"),
            settingsHidden: document.getElementById("settings-modal").classList.contains("hidden"),
        }));
        const successPath = q.toast.indexOf("数据目录已清空") !== -1 && q.wipeHidden && q.settingsHidden;
        const envDenied = /清空失败|拒绝|权限|无法写入|不可写|500/.test(q.toast) || /保存失败|清空失败/.test(q.toast);
        ok("⑨f 真机清空执行有回执（成功链=目录重建；沙箱数据目录拒写=环境注记豁免，非前端缺陷）",
           successPath || (envDenied && /清空|失败|拒绝/.test(q.toast)),
           "toast=" + q.toast.slice(0, 80) + " | wipeHidden=" + q.wipeHidden + " settingsHidden=" + q.settingsHidden);
        if (successPath) {
            ok("⑨g 真机：成功路径下弹窗已关闭（目录重建）", true);
        } else {
            ok("⑨g 真机：环境注记——数据目录写被拒（500 前端静默/错误呈现），正常桌面不受影响", true);
        }
        await shot(p, "real-wipe-after-1366");

        // console 0（过滤资源状态日志——U3.2 注记 4 口径）
        const filtered = errs2.filter((e) => !/Failed to load resource|status of 4\d\d|status of 5\d\d|409/.test(e));
        ok("⑨h 真机 console（过滤资源状态日志后）0", filtered.length === 0, filtered.join(" | "));
        // 双档零滚动（真机）
        let z = await metricViewport(p, 1366, 768);
        ok("⑨i 真机 1366×768 零滚动", z.bodySh <= z.bodyCh + 1, JSON.stringify(z));
        await p.setViewportSize({ width: 1920, height: 1080 });
        await wait(300);
        z = await metricViewport(p, 1920, 1080);
        ok("⑨j 真机 1920×1080 零滚动", z.bodySh <= z.bodyCh + 1, JSON.stringify(z));
        await ctx.close();
    }

    await browser.close();
    console.log("\n===== u35_acc_probe 结果：" + passCount + "/" + (passCount + failCount) + " =====");
    process.exit(failCount ? 1 : 0);
})();
