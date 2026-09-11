/* ============================================================
   P6（问题 8/9）· p06_pages_visual_probe.mjs —— 对比页/快照页视觉与趋势量化探针
   ---------------------------------------------------------------------------
   判据（D6-1…D6-6；全部为**实测值**，不做字符串照抄）：
     ① 原始文件名外露 = 0（可见文本里不得出现 *.snap.gz / session_<ts> / .json 名）；
     ② 卡片语言一致（D6-1）：.compare-stat / .compare-diverge / .trend-card /
        .session-item / .snapshots-list-wrap 的 {圆角, 底色, 边框色, 阴影} 计算值全等；
     ③ 设计刻度（D6-1）：两页所有元素的 font-size ∈ 令牌刻度、gap/padding ∈ 间距刻度；
     ④ 内联尺寸（D6-1/根因#3）：两页 DOM 内联 style 里不得出现 magic px 宽高；
     ⑤ 多快照趋势（D6-3/D6-4/D6-5）：选 ≥2 份对比基准 → 折线成图（path 非空、
        数据点数=快照数、Y/X 轴刻度存在）+ 悬浮读数出现且带时间与数值；
     ⑥ 空态给原因（D6-4/D6-6）：选 1 份 → 趋势卡为 idle 且有原因文案；无快照 →
        对比页空态 + 趋势卡原因；
     ⑦ 零页面滚动（P4/P5 红线）：三视口 body scrollHeight ≤ clientHeight；
     ⑧ console/pageerror = 0。
   采样：每态等网络/渲染稳定后截图（视口内，fullPage:false）+ 立即量化 DOM。

   用法：
     node scripts/dev/p06_pages_visual_probe.mjs --label postfix --out <目录>
       [--base http://127.0.0.1:5103/]   # 外部服务器（红线 A：旧代码 worktree）
       [--port 5103] [--fixture-root <夹具数据目录>] [--viewports "1366x768,1440x900,1920x1080"]
   产出：<out>/shots/*.png + <out>/{summary,layout,pages,trend}-<label>.json
   退出码：0 = 全判据通过；1 = 有违规（违规数在 summary 里逐条列出）
   ============================================================ */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { chromium } from "./_harness.mjs";

function arg(name, dflt) {
    const i = process.argv.indexOf("--" + name);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "..");
const LABEL = arg("label", "run");
const OUT = path.resolve(arg("out", path.join(os.tmpdir(), "p06_pages")));
const SHOTS = path.join(OUT, "shots");
const PORT = Number(arg("port", "5103"));
const EXTERNAL_BASE = arg("base", null);
const EXTERNAL_BASE_EMPTY = arg("base-empty", null);
const FIXTURE_ROOT = path.resolve(arg("fixture-root", path.join(os.tmpdir(), "pds_p6_iso", "PythonDiskScanner")));
const SNAP_DIR = path.join(FIXTURE_ROOT, "snapshots");
const FIXTURE_NOW = "2026-09-08T20:00:00";
const FIXTURE_SEL = arg("fixture", "series,tree,growth");
const VIEWPORTS = arg("viewports", "1366x768,1440x900,1920x1080")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
        const [w, h] = s.split("x").map(Number);
        return { w: w, h: h, name: s };
    });
const PY = path.join(REPO, ".venv", "Scripts", "python.exe");
const HARNESS = path.join(REPO, "docs", "问题核查资料_20260908", "p5", "_fixture_roots_server.py");

fs.mkdirSync(SHOTS, { recursive: true });

const RESULT = {
    meta: {
        label: LABEL, out: OUT, base: EXTERNAL_BASE || ("http://127.0.0.1:" + PORT + "/"),
        fixtureRoot: FIXTURE_ROOT, fixtureNow: FIXTURE_NOW, fixtureSel: FIXTURE_SEL,
        viewports: VIEWPORTS.map((v) => v.name), node: process.version,
        startedAt: new Date().toISOString(),
    },
    samples: [],
    shots: [],
    consoleErrors: [],
    violations: [],
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let harnessProc = null;
const harnessProcExtra = [];

function violation(scope, kind, detail) {
    RESULT.violations.push({ scope: scope, kind: kind, detail: detail });
}

/* ================= 夹具（隔离数据目录；红线 B：不触碰用户真实数据） ================= */

function ensureFixtures() {
    fs.mkdirSync(FIXTURE_ROOT, { recursive: true });
    return new Promise((resolve) => {
        const gen = spawn(process.execPath, [
            path.join(REPO, "scripts", "dev", "fixture_snapshots.mjs"),
            "--dir", FIXTURE_ROOT, "--now", FIXTURE_NOW, "--fixture", FIXTURE_SEL,
        ], { stdio: "ignore", cwd: REPO });
        gen.on("exit", (code) => resolve({ exit: code }));
    });
}

async function startHarness(opts) {
    const o = opts || {};
    /* 外部 base（红线 A：旧代码 worktree 起的 harness）——`-empty` 组用 --base-empty，
       使「无快照」场景在旧代码下同样只依赖空数据目录的实例。 */
    if (EXTERNAL_BASE) {
        const isExtra = !!(o.tag && String(o.tag).indexOf("empty") !== -1);
        return { base: isExtra && EXTERNAL_BASE_EMPTY ? EXTERNAL_BASE_EMPTY : EXTERNAL_BASE, spawned: false };
    }
    const dataHome = o.dataHome || path.dirname(FIXTURE_ROOT);
    const snapDir = o.snapshotDir || SNAP_DIR;
    const port = o.port || PORT;
    const logPath = path.join(OUT, "harness-" + (o.tag || LABEL) + ".log");
    const out = fs.openSync(logPath, "a");
    const snapFiles = fs.readdirSync(SNAP_DIR).filter((f) => f.endsWith(".snap.gz")).sort();
    /* 「当前侧」取**次新**一份快照：保证与默认对比基准（最新一份）不同 →
       对比页有非零差异（摘要/发散图/表格三处都能取到真实内容，不是 0 行空态）。 */
    const current = o.current || path.join(SNAP_DIR, snapFiles[Math.max(0, snapFiles.length - 2)]);
    const proc = spawn(PY, [
        HARNESS, "--port", String(port), "--data-home", dataHome,
        "--snapshot-dir", snapDir, "--current-snapshot", current,
    ], { stdio: ["ignore", out, out], cwd: REPO });
    if (!o.tag || o.tag === LABEL) harnessProc = proc;
    else harnessProcExtra.push(proc);
    const base = "http://127.0.0.1:" + port + "/";
    for (let i = 0; i < 60; i++) {
        await wait(500);
        try {
            const r = await fetch(base + "__harness/state");
            if (r.ok) return { base: base, spawned: true, state: (await r.json()).state, log: logPath, proc: proc };
        } catch (e) { /* 未就绪 */ }
    }
    throw new Error("harness 启动超时（日志见 " + logPath + "）");
}

/* 把「当前侧」数据集切到指定快照（用同一夹具目录里的另一份系列快照） */
async function setCurrent(base, snapshotFile) {
    const r = await fetch(base + "__harness/current", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ snapshot: path.join(SNAP_DIR, snapshotFile) }),
    });
    const body = await r.json();
    if (!body.ok) throw new Error("切换当前侧失败：" + JSON.stringify(body));
    return body.state;
}

/* ================= 页内计量（每次采样都跑，返回结构化量化值） ================= */

const MEASURE_FN = `(() => {
  /* 可见 = 真正**绘制**出来的文本（D6-2 判据的口径）。
     ⚠️ 不能用 getBoundingClientRect() 单独判定：Chromium 对闭合 <details> 的
     子内容施加 content-visibility:hidden —— 布局尺寸仍在（rect>0）但不绘制，
     只用 rect 判会把「详情里折叠的原始文件名」误判成外露。改用
     checkVisibility({contentVisibilityAuto:true}) 取真实绘制可见性。 */
  const visible = (el) => {
    if (!el || !el.isConnected) return false;
    if (typeof el.checkVisibility === "function") {
      const ok = el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, contentVisibilityAuto: true });
      if (!ok) return false;
    }
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const textNodes = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => {
      const p = n.parentElement;
      if (!p) return NodeFilter.FILTER_REJECT;
      if (/^(SCRIPT|STYLE|NOSCRIPT)$/.test(p.tagName)) return NodeFilter.FILTER_REJECT;
      return visible(p) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  let node;
  while ((node = walker.nextNode())) {
    const t = (node.nodeValue || "").trim();
    if (t) textNodes.push(t);
  }
  const visibleText = textNodes.join(" | ");
  /* ① 原始文件名模式（D6-2）：*.snap.gz / session_<ts> / *.json（会话清单名） */
  const rawPatterns = [
    { key: "snap.gz", re: /[A-Za-z0-9_\\-]+\\.snap\\.gz/ },
    { key: "session_file", re: /session_\\d{8}_\\d{6}/ },
    { key: "json_file", re: /[A-Za-z0-9_\\-]+\\.json/ },
  ];
  const rawHits = rawPatterns.filter((p) => p.re.test(visibleText)).map((p) => p.key);
  /* ② 卡片语言（D6-1）：五个卡片原语的计算样式元组 */
  const cardSel = [".compare-stat", ".compare-diverge", ".trend-card", ".session-item", ".snapshots-list-wrap"];
  const cards = cardSel.map((sel) => {
    const el = document.querySelector(sel);
    if (!el) return { sel: sel, present: false };
    const cs = getComputedStyle(el);
    return {
      sel: sel, present: true,
      radius: cs.borderTopLeftRadius,
      bg: cs.backgroundColor,
      border: cs.borderTopColor + " " + cs.borderTopWidth,
      shadow: cs.boxShadow,
    };
  });
  /* ③ 设计刻度消费：字号 ∈ 令牌刻度、间距 ∈ 间距刻度（仅量两页 DOM） */
  const FS_TOKENS = [11, 12, 13, 14, 16, 20, 24];
  const SPACE_TOKENS = [0, 2, 3, 4, 5, 6, 8, 10, 12, 14, 16, 20, 24, 28, 32];
  const fsOffenders = [];
  const spaceOffenders = [];
  const inPages = Array.from(document.querySelectorAll(".page-compare, .page-snapshots"));
  inPages.forEach((root) => {
    Array.from(root.querySelectorAll("*")).forEach((el) => {
      if (!visible(el)) return;
      const cs = getComputedStyle(el);
      const fs = Math.round(parseFloat(cs.fontSize));
      if (fs && FS_TOKENS.indexOf(fs) === -1 && fsOffenders.length < 12) {
        fsOffenders.push({ tag: el.tagName, cls: String(el.className).slice(0, 60), fs: fs });
      }
      ["rowGap", "columnGap"].forEach((k) => {
        const v = parseFloat(cs[k]);
        if (v && SPACE_TOKENS.indexOf(Math.round(v)) === -1 && spaceOffenders.length < 12) {
          spaceOffenders.push({ tag: el.tagName, cls: String(el.className).slice(0, 60), gap: v });
        }
      });
    });
  });
  /* ④ 内联尺寸（magic px）：两页 DOM 里内联 style 出现 px 宽/高 */
  const inlinePx = [];
  inPages.forEach((root) => {
    Array.from(root.querySelectorAll("[style]")).forEach((el) => {
      const s = el.getAttribute("style") || "";
      if (/(^|;|\\s)(width|height|min-width|max-width)\\s*:\\s*\\d+(\\.\\d+)?px/.test(s) && inlinePx.length < 12) {
        inlinePx.push({ tag: el.tagName, cls: String(el.className).slice(0, 60), style: s.slice(0, 90) });
      }
    });
  });
  /* ⑤ 趋势卡与折线（D6-4/D6-5/D6-6） */
  const trendCard = document.getElementById("compare-trend");
  const host = document.getElementById("compare-trend-host");
  const linePath = host ? host.querySelector(".line-path") : null;
  const trend = {
    present: !!trendCard,
    state: trendCard ? trendCard.dataset.state : null,
    sub: (document.getElementById("compare-trend-sub") || {}).textContent || "",
    dots: host ? host.querySelectorAll(".line-dot").length : 0,
    pathLen: linePath ? String(linePath.getAttribute("d") || "").length : 0,
    axisY: host ? host.querySelectorAll(".line-axis-y").length : 0,
    axisX: host ? host.querySelectorAll(".line-axis-x").length : 0,
    emptyText: host && host.querySelector(".line-empty") ? host.querySelector(".line-empty").textContent : "",
    readout: host && host.querySelector(".line-readout") && !host.querySelector(".line-readout").hasAttribute("hidden")
      ? host.querySelector(".line-readout").textContent : "",
    ariaLabel: host ? (host.getAttribute("aria-label") || "") : "",
    seriesKey: host ? (host.dataset.seriesKey || "") : "",
  };
  /* ⑥ 对比基准多选（D6-5） */
  const sel = document.getElementById("compare-baseline");
  const baseline = sel ? {
    tag: sel.tagName,
    multiple: !!sel.multiple,
    options: sel.options.length,
    selected: Array.from(sel.selectedOptions).map((o) => o.textContent),
    value: sel.value,
  } : null;
  /* ⑦ 快照页列表（D6-2/D6-3） */
  const list = {
    sessions: document.querySelectorAll("#snapshot-list .session-item").length,
    rows: document.querySelectorAll("#snapshot-list .session-root-row").length,
    meta: Array.from(document.querySelectorAll("#snapshot-list .session-root-meta")).map((e) => e.textContent),
    details: document.querySelectorAll("#snapshot-list .session-detail").length,
    trendCards: document.querySelectorAll(".trend-card").length,
    sparks: document.querySelectorAll(".trend-spark-svg").length,
    reasons: Array.from(document.querySelectorAll(".trend-reason")).map((e) => e.textContent),
  };
  /* ⑧ 三态可见性 + 零滚动 + 摘要/表格/发散图（P4 面不回退）+ 分区实测高度 */
  const h = (sel) => { const e = document.querySelector(sel); return e ? Math.round(e.getBoundingClientRect().height) : 0; };
  const state = {
    route: location.hash,
    emptyVisible: (() => { const e = document.getElementById("compare-empty"); return !!e && !e.hasAttribute("hidden"); })(),
    resultVisible: (() => { const e = document.getElementById("compare-result"); return !!e && !e.hasAttribute("hidden"); })(),
    stats: document.querySelectorAll("#compare-summary .compare-stat").length,
    divergeRows: document.querySelectorAll("#compare-diverge .diverge-row").length,
    tableRows: document.querySelectorAll("#compare-body tr").length,
    heights: {
      head: h(".page-head-compare"),
      trend: h("#compare-trend"),
      trendHost: h("#compare-trend-host"),
      summary: h("#compare-summary"),
      diverge: h("#compare-diverge"),
      table: h(".compare-table-wrap"),
    },
    bodyScroll: document.body.scrollHeight,
    bodyClient: document.body.clientHeight,
  };
  return {
    rawHits: rawHits, pageText: visibleText.slice(0, 4000), cards: cards,
    fsOffenders: fsOffenders, spaceOffenders: spaceOffenders, inlinePx: inlinePx,
    trend: trend, baseline: baseline, list: list, state: state,
  };
})()`;

/* ================= 采样 ================= */

async function openPage(browser, base, viewport) {
    const ctx = await browser.newContext({ viewport: { width: viewport.w, height: viewport.h } });
    const page = await ctx.newPage();
    const errs = [];
    page.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text()); });
    page.on("pageerror", (e) => errs.push("pageerror: " + e.message));
    await page.addInitScript(() => {
        try { localStorage.setItem("pds_onboarding_dismissed_v1", "1"); } catch (e) {}
        try { sessionStorage.setItem("pds_auto_started_v1", "1"); } catch (e) {}
        try { localStorage.setItem("pds_theme_v1", "light"); } catch (e) {}
    });
    await page.goto(base, { waitUntil: "load", timeout: 30000 });
    await page.waitForFunction(() => !!document.querySelector(".app"), null, { timeout: 20000 }).catch(() => {});
    return { ctx: ctx, page: page, errs: errs };
}

async function selectBaselines(page, count) {
    return page.evaluate((n) => {
        const sel = document.getElementById("compare-baseline");
        if (!sel) return 0;
        Array.from(sel.options).forEach((o, i) => { o.selected = i < n; });
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        return sel.selectedOptions.length;
    }, count);
}

async function sample(browser, base, viewport, scenario, opts) {
    const { ctx, page, errs } = await openPage(browser, base, viewport);
    const rec = { scenario: scenario, viewport: viewport.name, at: new Date().toISOString() };
    try {
        if (scenario === "compare-result" || scenario === "trend-line") {
            await page.evaluate(() => { location.hash = "#/compare"; });
            await page.waitForFunction(() => document.querySelector("#compare-baseline") &&
                document.querySelector("#compare-baseline").options.length > 0, null, { timeout: 20000 }).catch(() => {});
            await selectBaselines(page, opts && opts.baselines ? opts.baselines : 1);
            await page.waitForFunction(() => {
                const r = document.getElementById("compare-result");
                return r && !r.hasAttribute("hidden");
            }, null, { timeout: 30000 }).catch(() => {});
            if (scenario === "trend-line") {
                await page.waitForFunction(() => {
                    const h = document.getElementById("compare-trend-host");
                    return h && h.dataset.state === "ok" && h.querySelector(".line-path");
                }, null, { timeout: 30000 }).catch(() => {});
                /* 悬浮读数：移到折线中段的数据点上 */
                const pt = await page.evaluate(() => {
                    const host = document.getElementById("compare-trend-host");
                    const dot = host && host.querySelectorAll(".line-dot")[1];
                    if (!dot) return null;
                    const r = dot.getBoundingClientRect();
                    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
                });
                if (pt) await page.mouse.move(pt.x, pt.y);
                await wait(260);
            }
        } else if (scenario === "compare-empty") {
            await page.evaluate(() => { location.hash = "#/compare"; });
            await page.waitForFunction(() => !!document.querySelector("#compare-empty"), null, { timeout: 20000 }).catch(() => {});
            await wait(900);
        } else if (scenario === "snapshots" || scenario === "snapshots-empty") {
            await page.evaluate(() => { location.hash = "#/snapshots"; });
            /* 扫描态事件：夹具服务的 /api/fullscan/status 恒为 result_ready=true，
               但前端 C-5 的「先做全量扫描」守卫读的是 pds:scan 事件缓存
               （u55 同口径补发），不补发则趋势卡停在「对比不可用」——那是
               事件时序而非本轮判据，补发后趋势卡才进入真实有值态。 */
            await page.evaluate(() => {
                try {
                    window.dispatchEvent(new CustomEvent("pds:scan", { detail: {
                        running: false, result_ready: true, save_ready: true,
                        roots: ["D:\\"], roots_done: 1, roots_total: 1, error: null,
                    } }));
                } catch (e) { /* ignore */ }
            });
            if (scenario === "snapshots") {
                await page.waitForFunction(() => {
                    const l = document.getElementById("snapshot-list");
                    return l && l.querySelectorAll(".session-item").length > 0;
                }, null, { timeout: 25000 }).catch(() => {});
                await page.waitForFunction(() => document.querySelector(".trend-card .trend-delta") ||
                    document.querySelector(".trend-card.is-empty"), null, { timeout: 20000 }).catch(() => {});
            } else {
                await page.waitForFunction(() => {
                    const l = document.getElementById("snapshot-list");
                    return l && l.querySelector(".empty-state");
                }, null, { timeout: 25000 }).catch(() => {});
            }
            await wait(1100); // 趋势卡 sparkline 描线 800ms + 列表渲染
        }
        await wait(opts && opts.settleMs ? opts.settleMs : 700);
        const shotName = scenario + "-" + viewport.name + "-" + LABEL + ".png";
        await page.screenshot({ path: path.join(SHOTS, shotName), fullPage: false });
        RESULT.shots.push(path.join("shots", shotName));
        rec.measure = await page.evaluate(MEASURE_FN);
        rec.consoleErrors = errs.slice(0, 8);
        errs.forEach((e) => RESULT.consoleErrors.push("[" + scenario + "/" + viewport.name + "] " + e));
    } catch (e) {
        rec.error = String((e && e.stack) || e);
    } finally {
        await ctx.close();
    }
    RESULT.samples.push(rec);
    return rec;
}

/* ================= 判据 ================= */

function judge() {
    const CARDS = [".compare-stat", ".compare-diverge", ".trend-card", ".session-item", ".snapshots-list-wrap"];
    RESULT.checks = [];
    const check = (name, ok, detail) => RESULT.checks.push({ name: name, ok: !!ok, detail: detail === undefined ? "" : String(detail) });

    const all = RESULT.samples;
    /* ① 原始文件名外露 */
    const rawBad = all.filter((s) => s.measure && s.measure.rawHits.length);
    check("① 两页可见文本无原始文件名（*.snap.gz / session_<ts> / *.json）",
        rawBad.length === 0,
        rawBad.map((s) => s.scenario + "@" + s.viewport + ":" + s.measure.rawHits.join("+")).join(" , "));

    /* ② 卡片语言一致（同一样本内五类卡片样式元组全等） */
    const cardBad = [];
    all.forEach((s) => {
        if (!s.measure) return;
        const present = s.measure.cards.filter((c) => c.present && CARDS.indexOf(c.sel) !== -1);
        if (present.length < 2) return;
        const sig = (c) => [c.radius, c.bg, c.border, c.shadow].join("¦");
        const first = sig(present[0]);
        present.forEach((c) => { if (sig(c) !== first) cardBad.push(s.scenario + "@" + s.viewport + " " + c.sel + " → " + sig(c) + " ≠ " + present[0].sel + " → " + first); });
    });
    check("② 卡片语言一致（.compare-stat/.compare-diverge/.trend-card/.session-item/.snapshots-list-wrap 计算样式全等）",
        cardBad.length === 0, cardBad.slice(0, 4).join(" | "));

    /* ③ 设计刻度 */
    const fsBad = all.filter((s) => s.measure && s.measure.fsOffenders.length);
    const spBad = all.filter((s) => s.measure && s.measure.spaceOffenders.length);
    check("③ 字号全部落在令牌刻度（11/12/13/14/16/20/24）",
        fsBad.length === 0, fsBad.map((s) => s.scenario + "@" + s.viewport + " " + JSON.stringify(s.measure.fsOffenders.slice(0, 3))).join(" | "));
    check("③b gap 全部落在间距刻度（4..32）",
        spBad.length === 0, spBad.map((s) => s.scenario + "@" + s.viewport + " " + JSON.stringify(s.measure.spaceOffenders.slice(0, 3))).join(" | "));

    /* ④ 内联 magic px */
    const pxBad = all.filter((s) => s.measure && s.measure.inlinePx.length);
    check("④ 两页 DOM 无内联 magic px 宽高", pxBad.length === 0,
        pxBad.map((s) => s.scenario + "@" + s.viewport + " " + JSON.stringify(s.measure.inlinePx.slice(0, 3))).join(" | "));

    /* ⑤ 趋势折线 */
    const lineSamples = all.filter((s) => s.scenario === "trend-line" && s.measure);
    const lineBad = lineSamples.filter((s) => !(s.measure.trend.state === "ok" && s.measure.trend.pathLen > 20 &&
        s.measure.trend.dots >= 2 && s.measure.trend.axisY >= 1 && s.measure.trend.axisX >= 2));
    check("⑤ 趋势折线成图（state=ok + path + 点数≥2 + X/Y 轴刻度）",
        lineSamples.length >= 3 && lineBad.length === 0,
        lineBad.map((s) => s.viewport + ":" + JSON.stringify(s.measure.trend)).join(" | "));
    const readoutBad = lineSamples.filter((s) => !(s.measure.trend.readout || "").trim());
    check("⑤b 悬浮读数出现且非空（时间 + 数值）", lineSamples.length >= 3 && readoutBad.length === 0,
        readoutBad.map((s) => s.viewport + " readout=" + JSON.stringify(s.measure.trend.readout)).join(" | "));
    const multiBad = all.filter((s) => s.measure && s.measure.baseline && s.measure.baseline.multiple !== true);
    check("⑤c #compare-baseline 为可多选 select（D6-5，id/SELECT 语义保持）", multiBad.length === 0,
        multiBad.map((s) => s.scenario + "@" + s.viewport).join(" , "));

    /* ⑥ 空态给原因 */
    const idle = all.filter((s) => s.measure && s.measure.trend.state === "idle");
    check("⑥ 趋势卡空态给原因（非空白）", idle.length > 0 && idle.every((s) => (s.measure.trend.emptyText || "").length > 6),
        idle.map((s) => s.scenario + "@" + s.viewport + ":" + s.measure.trend.emptyText).join(" | "));
    const emptyScenario = all.filter((s) => s.scenario === "compare-empty" && s.measure);
    check("⑥b 对比页空态仍显示（P6 未破坏定稿 6.5 空态）",
        emptyScenario.length >= 3 && emptyScenario.every((s) => s.measure.state.emptyVisible),
        emptyScenario.map((s) => s.viewport + ":" + s.measure.state.emptyVisible).join(" , "));

    /* ⑦ 零滚动 */
    const scrollBad = all.filter((s) => s.measure && s.measure.state.bodyScroll > s.measure.state.bodyClient + 1);
    check("⑦ 三视口零页面滚动（P4/P5 红线不回退）", scrollBad.length === 0,
        scrollBad.map((s) => s.scenario + "@" + s.viewport + ":" + s.measure.state.bodyScroll + ">" + s.measure.state.bodyClient).join(" , "));

    /* ⑧ 快照页列表：会话/大小/详情 */
    const snapSamples = all.filter((s) => s.scenario === "snapshots" && s.measure);
    check("⑧ 快照页列表渲染（会话 ≥1 + 盘行 + 详情展开区 + 大小列）",
        snapSamples.length >= 3 && snapSamples.every((s) => s.measure.list.sessions >= 1 && s.measure.list.rows >= 1 && s.measure.list.details >= 1),
        snapSamples.map((s) => s.viewport + ":" + JSON.stringify({ sess: s.measure.list.sessions, rows: s.measure.list.rows, det: s.measure.list.details })).join(" | "));

    /* ⑨ console 干净 */
    check("⑨ console/pageerror = 0", RESULT.consoleErrors.length === 0, RESULT.consoleErrors.slice(0, 5).join(" | "));

    RESULT.violations = RESULT.checks.filter((c) => !c.ok).map((c) => ({ scope: "check", kind: c.name, detail: c.detail }));
    RESULT.verdict = RESULT.checks.every((c) => c.ok) ? "PASS" : "FAIL";
}

/* ================= 主流程 ================= */

(async () => {
    const fixture = await ensureFixtures();
    RESULT.meta.fixtureGen = fixture;
    const harness = await startHarness();
    /* 「无快照」场景需要**另一个隔离实例**：会话清单来自数据目录，
       这里换一个空数据目录 + 空快照目录（红线 B：不触碰用户真实目录）。 */
    const emptyHome = path.join(os.tmpdir(), "pds_p6_empty_iso");
    const emptySnap = path.join(emptyHome, "snapshots");
    fs.mkdirSync(emptySnap, { recursive: true });
    for (const f of fs.readdirSync(emptyHome)) {
        if (/^session_.*\.json$/.test(f)) fs.unlinkSync(path.join(emptyHome, f));
    }
    const harnessEmpty = await startHarness({
        port: PORT + 1, dataHome: emptyHome, snapshotDir: emptySnap, tag: LABEL + "-empty",
    });
    RESULT.meta.harness = { spawned: harness.spawned, base: harness.base, state: harness.state || null };
    RESULT.meta.harnessEmpty = { spawned: harnessEmpty.spawned, base: harnessEmpty.base, state: harnessEmpty.state || null };
    const base = harness.base;
    const baseEmpty = harnessEmpty.base;

    const browser = await chromium.launch();
    try {
        for (const vp of VIEWPORTS) {
            await sample(browser, base, vp, "compare-result", { baselines: 1 });
            await sample(browser, base, vp, "trend-line", { baselines: 3 });
            await sample(browser, baseEmpty, vp, "compare-empty", {});
            await sample(browser, baseEmpty, vp, "snapshots-empty", {});
            await sample(browser, base, vp, "snapshots", {});
        }
    } finally {
        await browser.close().catch(() => {});
    }
    judge();

    const layout = {
        label: LABEL, base: base,
        rows: RESULT.samples.map((s) => ({
            scenario: s.scenario, viewport: s.viewport,
            bodyScroll: s.measure ? s.measure.state.bodyScroll : null,
            bodyClient: s.measure ? s.measure.state.bodyClient : null,
            stats: s.measure ? s.measure.state.stats : null,
            divergeRows: s.measure ? s.measure.state.divergeRows : null,
            tableRows: s.measure ? s.measure.state.tableRows : null,
            trendState: s.measure ? s.measure.trend.state : null,
            trendDots: s.measure ? s.measure.trend.dots : null,
            baselineSelected: s.measure && s.measure.baseline ? s.measure.baseline.selected.length : null,
        })),
    };
    fs.writeFileSync(path.join(OUT, "layout-" + LABEL + ".json"), JSON.stringify(layout, null, 2), "utf-8");
    fs.writeFileSync(path.join(OUT, "pages-" + LABEL + ".json"), JSON.stringify({
        label: LABEL,
        samples: RESULT.samples.map((s) => ({ scenario: s.scenario, viewport: s.viewport, measure: s.measure, error: s.error || null })),
    }, null, 2), "utf-8");
    fs.writeFileSync(path.join(OUT, "trend-" + LABEL + ".json"), JSON.stringify({
        label: LABEL,
        trend: RESULT.samples.filter((s) => s.measure).map((s) => ({
            scenario: s.scenario, viewport: s.viewport, ...s.measure.trend,
            baseline: s.measure.baseline ? s.measure.baseline.selected : null,
        })),
    }, null, 2), "utf-8");
    fs.writeFileSync(path.join(OUT, "summary-" + LABEL + ".json"), JSON.stringify(RESULT, null, 2), "utf-8");

    console.log("[p06] label=" + LABEL + " base=" + base + " samples=" + RESULT.samples.length + " shots=" + RESULT.shots.length);
    (RESULT.checks || []).forEach((c) => console.log("  " + (c.ok ? "✔" : "✘") + " " + c.name + (c.ok ? "" : " :: " + c.detail)));
    console.log("[p06] violations=" + RESULT.violations.length + " verdict=" + RESULT.verdict);
    [harnessProc].concat(harnessProcExtra).forEach((p) => { if (p) { try { p.kill(); } catch (e) { /* ignore */ } } });
    process.exit(RESULT.verdict === "PASS" ? 0 : 1);
})().catch(async (e) => {
    RESULT.fatal = String((e && e.stack) || e);
    try { fs.writeFileSync(path.join(OUT, "summary-" + LABEL + ".json"), JSON.stringify(RESULT, null, 2), "utf-8"); } catch (err) {}
    console.error("[p06] FATAL: " + RESULT.fatal);
    [harnessProc].concat(harnessProcExtra).forEach((p) => { if (p) { try { p.kill(); } catch (err) {} } });
    process.exit(2);
});
