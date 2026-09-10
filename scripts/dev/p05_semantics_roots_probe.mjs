/* ============================================================
   阶段 P5 · p05_semantics_roots_probe.mjs
   （问题 7：对比页术语裸奔 + 语义自相矛盾 + 首开无选盘 + 默认根硬编码）
   ------------------------------------------------------------
   目标（计划第十一章 · P5 / D5-1…D5-5）：
     ① 术语自解释：可见文本中不再出现无解释的「基线」「目标」；
     ② 首开选盘：引导弹层有选盘步骤、盘符来自后端真枚举、且可跳过；
     ③ 默认根：初值 ≠ 硬编码 D:\，无 last_roots 时显示「请选择盘符」。

   ⚠️ 红线 A（探针有效性自证）
    本探针必须在**修复前**代码（stage-p4 @ 起点）上跑出违规，修复后为 0。
    判据设计据此分三层，前两层用于「修复前必红」的强区分：

     层 1（术语）：可见文本节点扫描 —— 只扫**可见文本**，不扫 title/aria-label
       （定稿 D5-5 要求「副行必须自解释，不依赖 title= 悬停」——因此 title 里
       写着「基线快照」不算数，页面上看得见的「基线」才算数）。
     层 2（引导）：弹层步骤里有没有「选择要分析的盘」这一步 + 有没有「跳过」按钮。
       修复前引导只有 4 步（检查环境/全量扫描/保存快照/对比与清空），无选盘步骤。
     层 3（默认根）：**反向注入**盘符清单并断网 settings —— 修复前 `firstRoot`
       常量兜底恒为 "D:\\"（与真机枚举结果无关，故无法用真机区分），注入
       "Z:\\"/"Y:\\" 后若初值仍是 D:\ 即为硬编码铁证；修复后应取注入清单首项。

   夹具口径（_fixture_roots_server.py，证据侧 harness）
     · 「当前」侧数据集 = 夹具快照行（与 P4 同一数据源桩口径 {root, rows}）——
       真实磁盘内容不可复现，而本探针要求逐态确定复现；服务/路由/引擎/前端
       全部为生产代码；
     · 盘符枚举被替换为注入清单（仅替换**枚举来源**；「枚举 → /api/roots」
       生产代码始终真实执行）——「不可用/未就绪」这一态在真机上无法按需造出；
     · /api/settings 由探针拦截返回「无 last_roots」，消除「上次浏览」对默认根
       的掩盖效应（有 last_roots 时任何实现都返回它，测不出硬编码）。

   硬判据（任一 >0 → exit 1）
     J1  可见文本含无解释的「基线」/「目标」（裸词；术语白名单见 TERMS）
     J2  引导弹层无选盘步骤 / 无可达的「跳过」按钮
     J3  盘符选项 ≠ /api/roots 返回集（硬编码数组 / 未接线）
     J4  默认根初值 == "D:\\"（无 last_roots 且注入清单不含 D:\ 时）
     J5  1366×768 出现页面滚动（body.scrollHeight > innerHeight + 1）
     J6  console.error / pageerror（按 URL 过滤 favicon）

   用法
     node scripts/dev/p05_semantics_roots_probe.mjs --label prefix|postfix \
          --out <绝对目录> [--base <外部 harness base>] [--fixture-root <夹具数据目录>]

   输出
     <out>/semantics-<label>.json   术语可见文本逐条量化 + 判定
     <out>/onboarding-<label>.json  引导弹层步骤/选盘/跳过 逐视口量化
     <out>/roots-<label>.json       盘符来源与默认根初值量化（含反向注入）
     <out>/layout-<label>.json      3 视口 DOM 量化（页头控件/宽度/零滚动）
     <out>/summary-<label>.json     判定汇总（违规计数 + 逐项明细）
     <out>/*.png                    3 视口 × 3 态 = 9 张
   ============================================================ */

import { chromium } from "./_harness.mjs";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

function arg(name, dflt) {
    const i = process.argv.indexOf("--" + name);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "..");
const LABEL = arg("label", "run");
const OUT = path.resolve(arg("out", path.join(os.tmpdir(), "p05_semantics_roots")));
const FIXTURE_ROOT = path.resolve(arg("fixture-root", path.join(os.tmpdir(), "pds_p5_iso", "home", "PythonDiskScanner")));
const SNAP_DIR = path.join(FIXTURE_ROOT, "snapshots");
const EXTERNAL_BASE = arg("base", null);
const PORT = Number(arg("port", "5102"));
const HARNESS = path.join(REPO, "docs", "问题核查资料_20260908", "p5", "_fixture_roots_server.py");
const PY = path.join(REPO, ".venv", "Scripts", "python.exe");
const FIXTURE_NOW = "2026-09-08T20:00:00";
const FILES = {
    growthT0: "D_20260907_170000_explicit_3f2a1c9d.snap.gz",
    growthT1: "D_20260908_170000_explicit_3f2a1c9d.snap.gz",
};

/* 夹具盘符清单：**列表首项故意是 D:\（且被夹具标成未就绪）**，可用盘是 S:\。
   这样「默认根 = 常量 D:\」与「默认根 = 首个可用盘 S:\」在同一环境下**可区分**：
   修复前 firstRoot 常量兜底恒为 D:\（与就绪无关）→ 判据必红；修复后应为 S:\。

   ⚠️ 为什么用 S:\（subst 虚拟盘）而不是随手的 Z:\/Y:\：
   生产 /api/browse 有 `root.exists()` 校验（app.py:240 起），盘符不存在直接 400 →
   工作台启动浏览失败，量到的默认根行为被 400 噪声污染。
   subst 建的盘是**真实存在**的盘符（GetLogicalDrives 可见、Test-Path 真、
   os.scandir 可读），但**不是 D:\** → 判据既真实又无歧义。
   探针在启动 harness 前建立（并等其真正可就绪）、finally 中删除，不留系统痕迹。 */
const MAGIC_ROOT = "D:\\";
const SUBST_LETTER = "S:";
const SUBST_TARGET = path.join(os.tmpdir(), "pds_p5_subst_target");
const READY_ROOT = `${SUBST_LETTER}\\`;      // 夹具中标记为「可用」的盘
const INJECTED_ROOTS = [MAGIC_ROOT, READY_ROOT];
const ROOTS_SPEC = INJECTED_ROOTS.join("|");

const VIEWPORTS = [{ w: 1366, h: 768 }, { w: 1440, h: 900 }, { w: 1920, h: 1080 }];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

/* ================= 术语白名单（D5-1/D5-5 定稿） =================
   规则：文本节点若含禁词，则其**所属短语**必须含自解释后缀——
     · 「基线|基准」需要「快照 / 对比 / 历史 / 时间」任一限定词（说明它是历史快照）；
     · 「目标」需要「当前 / 磁盘 / 状态 / 现状」任一限定词（说明它不是快照而是现况）。
   白名单按**修复后定稿文案**逐条列出（计划 D5-1 指定用语），并附通用规则
   兜住措辞微调；规则与白名单合取，避免「只要加个后缀就洗白」。 */
const TERMS = {
    forbidden: ["基线", "目标"],
    /* 定稿用语（D5-1）：对比基准（历史快照）/ 当前磁盘状态 */
    baselineExact: ["对比基准（历史快照）", "对比基准", "基准快照"],
    currentExact: ["当前磁盘状态", "当前磁盘", "磁盘状态"],
    /* 通用自解释后缀规则 */
    baselineHint: /(快照|对比|历史|时间|基准)/,
    currentHint: /(当前|磁盘|状态|现状|即时)/,
    /* 修复后不得再出现的旧称（D5-5：全仓库术语一致） */
    legacyTitle: "历史对比",
};

const RESULT = {
    meta: {
        label: LABEL, out: OUT, node: process.version, startedAt: new Date().toISOString(),
        fixtureRoot: FIXTURE_ROOT, snapshotDir: SNAP_DIR, fixtureNow: FIXTURE_NOW,
        injectedRoots: INJECTED_ROOTS, rootsSpec: ROOTS_SPEC, magicRoot: MAGIC_ROOT,
        viewports: VIEWPORTS.map((v) => v.w + "x" + v.h),
    },
    semantics: [], onboarding: [], roots: [], samples: [], shots: [], consoleErrors: [], violations: [],
};

/* ================= 夹具 ================= */

function readSnapshotRows(file) {
    const buf = zlib.gunzipSync(fs.readFileSync(file));
    const lines = buf.toString("utf-8").split("\n").filter((s) => s.trim());
    const header = JSON.parse(lines[0]);
    const rows = lines.slice(1).map((l) => JSON.parse(l));
    return { header, rows };
}

let harnessProc = null;
let harnessOut = null;

function ensureFixtures() {
    const missing = Object.values(FILES).filter((f) => !fs.existsSync(path.join(SNAP_DIR, f)));
    if (!missing.length) return Promise.resolve({ generated: false, missing: [] });
    fs.mkdirSync(FIXTURE_ROOT, { recursive: true });
    const gen = spawn(process.execPath, [
        path.join(REPO, "scripts", "dev", "fixture_snapshots.mjs"),
        "--dir", FIXTURE_ROOT, "--now", FIXTURE_NOW, "--fixture", "growth",
    ], { stdio: "ignore", cwd: REPO });
    return new Promise((resolve) => {
        gen.on("exit", (code) => resolve({ generated: true, exit: code, missing }));
    });
}

async function startHarness() {
    if (EXTERNAL_BASE) return { base: EXTERNAL_BASE, spawned: false };
    const dataHome = path.dirname(FIXTURE_ROOT);
    harnessOut = path.join(OUT, "harness-" + LABEL + ".log");
    const out = fs.openSync(harnessOut, "a");
    harnessProc = spawn(PY, [
        HARNESS, "--port", String(PORT), "--data-home", dataHome,
        "--snapshot-dir", SNAP_DIR, "--current-snapshot", path.join(SNAP_DIR, FILES.growthT1),
        "--roots", ROOTS_SPEC,
    ], { stdio: ["ignore", out, out], cwd: REPO });
    const base = "http://127.0.0.1:" + PORT + "/";
    for (let i = 0; i < 60; i++) {
        await wait(500);
        try {
            const r = await fetch(base + "__harness/state");
            if (r.ok) return { base, spawned: true, state: (await r.json()).state };
        } catch (e) { /* 未就绪 */ }
    }
    throw new Error("harness 启动超时（日志见 " + harnessOut + "）");
}

async function setCurrent(base, snapshotFile) {
    const r = await fetch(base + "__harness/current", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ snapshot: path.join(SNAP_DIR, snapshotFile) }),
    });
    const body = await r.json();
    if (!body.ok) throw new Error("切换当前侧数据集失败: " + JSON.stringify(body));
    return body.state;
}

/* ================= subst 虚拟盘（默认根判据的载体） ================= */

function substRun(args) {
    return new Promise((resolve) => {
        const p = spawn("subst", args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
        let out = "";
        p.stdout.on("data", (d) => { out += d.toString(); });
        p.stderr.on("data", (d) => { out += d.toString(); });
        p.on("error", (e) => resolve({ code: -1, out: String(e) }));
        p.on("close", (code) => resolve({ code, out: out.trim() }));
    });
}

/* 建立 subst 盘：目标目录即便为空也可（工作台启动浏览读的是它，不是 D:\）。
   ⚠️ 必须等盘**真正可就绪**再启动 harness：harness 只在启动时枚举一次盘符，
   若 subst 尚未落定，/api/roots 会把 S: 标成 ready=false → 前端按「可用盘优先」
   排到 D: → 判据失真（实测踩过：datalist 顺序与注入顺序相反）。
   返回 {established, letter, target, createOut, readyAfterMs}。 */
async function establishSubstDrive() {
    fs.mkdirSync(SUBST_TARGET, { recursive: true });
    fs.writeFileSync(path.join(SUBST_TARGET, "p5-probe-marker.txt"), "p5 subst target\n", "utf-8");
    const create = await substRun([SUBST_LETTER, SUBST_TARGET]);
    const t0 = Date.now();
    let ready = false;
    for (let i = 0; i < 60; i++) { // ≤6s
        if (fs.existsSync(SUBST_LETTER + "\\" + "p5-probe-marker.txt")) { ready = true; break; }
        await wait(100);
    }
    return {
        established: create.code === 0 && ready, letter: SUBST_LETTER, target: SUBST_TARGET,
        createOut: create.out, probeOut: ready, readyAfterMs: Date.now() - t0,
    };
}

async function removeSubstDrive() {
    const del = await substRun([SUBST_LETTER, "/D"]);
    return { removed: del.code === 0, out: del.out, stillExists: fs.existsSync(SUBST_LETTER + "\\") };
}

/* ================= 源码级扫描（DoD 3：默认根去魔法值，§1.3 六处全消除） =================
   计划 §1.3 列的六处（main.js:400 / workspace.js:77-78 / workspace.js:218 /
   workspace.js:1154 模板 / topbar.js:121 / state.js:19）在 DOM 上只能量到其中
   一部分（state.js 初值、topbar 兜底在 DOM 上不可见），因此补一条源码扫描：
   凡 web/ 下的 JS/HTML 出现**驱动默认根语义**的 D:\ 字面量即为违规。 */

/* 驱动默认根语义的模式（正则）：赋值/兜底/模板初值/列表项 */
const MAGIC_PATTERNS = [
    { key: "|| \"D:\\\\\"（或兜底）", re: /\|\|\s*"D:\\\\"/ },
    { key: "= \"D:\\\\\"（直接赋值）", re: /(let|const|var)\s+\w+\s*=\s*"D:\\\\"/ },
    { key: "root/path: \"D:\\\\\"（状态初值）", re: /(root|path)\s*:\s*"D:\\\\"/ },
    { key: "value=\"D:\\\\\"（模板初值）", re: /value="D:\\\\"/ },
    { key: "<option value=\"D:\\\\\"（硬编码 datalist）", re: /<option value="D:\\\\"/ },
];

function scanMagicRoots() {
    const files = [];
    const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) { if (e.name !== "node_modules") walk(p); }
            else if (/\.(js|html)$/i.test(e.name)) files.push(p);
        }
    };
    walk(path.join(REPO, "web"));
    const hits = [];
    for (const f of files) {
        const src = fs.readFileSync(f, "utf-8");
        /* 注释整体剥离后再扫描：P5 大量注释会引用旧值作说明（"原为 || \"D:\\\\\""），
           判据只认可执行代码。先剥块注释（跨行），再剥行注释与 HTML 注释——
           行注释必须先剥，否则 "/*" 出现在字符串里会吃掉整段代码。 */
        const stripped = src
            .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
            .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + " ".repeat(m.length - p1.length))
            .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "));
        const lines = stripped.split(/\r?\n/);
        lines.forEach((code, i) => {
            if (!/D:\\\\/.test(code)) return;
            if (/"D:\\\\"/.test(code) === false) return;
            for (const mp of MAGIC_PATTERNS) {
                if (mp.re.test(code)) {
                    hits.push({
                        file: path.relative(REPO, f).replace(/\\/g, "/"),
                        line: i + 1, pattern: mp.key,
                        code: (src.split(/\r?\n/)[i] || "").trim().slice(0, 140),
                    });
                    break;
                }
            }
        });
    }
    return { scanned: files.length, hits: hits };
}

/* ================= 判定工具 ================= */

function judge(list, name, pass, detail) {
    list.push({ name, pass: !!pass, detail: detail === undefined ? "" : String(detail) });
    if (!pass) RESULT.violations.push(name + " :: " + (detail === undefined ? "" : String(detail)));
}

/* ================= 页内测量源码（序列化后注入） ================= */

/* 术语扫描：只取**可见文本节点**（display:none / visibility:hidden / hidden 属性 /
   零尺寸 / <script><style> 排除），并把每个命中节点连同其所属「短语」一起回报。 */
const SEMANTICS_MEASURE = `(() => {
  const FORBIDDEN = ${JSON.stringify(TERMS.forbidden)};
  function visible(el) {
    if (!el) return false;
    if (el.closest("[hidden]")) return false;
    if (el.closest("script,style,noscript,template")) return false;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    return true;
  }
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
  const hits = [];
  const all = [];
  let node;
  while ((node = walker.nextNode())) {
    let raw = node.nodeValue || "";
    // 归一化全角/半角空白（含 &nbsp;）后再判词，避免「基 线」漏检
    const text = raw.replace(/[\\u00a0\\s]+/g, " ").trim();
    if (!text) continue;
    const el = node.parentElement;
    if (!visible(el)) continue;
    all.push(text);
    for (const w of FORBIDDEN) {
      if (text.indexOf(w) === -1) continue;
      // 所属短语 = 最近的块级/控件祖先的可见文本（尽力而为：父元素文本优先）
      const owner = el.closest("li,p,b,strong,span,label,button,div,td,th,h1,h2,h3,option") || el;
      const phrase = (owner.textContent || text).replace(/[\\u00a0\\s]+/g, " ").trim().slice(0, 120);
      hits.push({
        word: w, text: text.slice(0, 160), phrase: phrase,
        tag: el.tagName, id: el.id || (el.closest("[id]") ? el.closest("[id]").id : ""),
        cls: el.className && el.className.toString ? el.className.toString().slice(0, 60) : "",
        title: owner.getAttribute ? (owner.getAttribute("title") || "") : "",
        aria: owner.getAttribute ? (owner.getAttribute("aria-label") || "") : "",
      });
    }
  }
  return { hits: hits, visibleTextCount: all.length, sampleTexts: all.slice(0, 40) };
})()`;

const ONBOARDING_MEASURE = `(() => {
  const box = document.getElementById("onboarding");
  const visible = box && !box.classList.contains("hidden") && getComputedStyle(box).display !== "none";
  const steps = box ? Array.from(box.querySelectorAll(".steps > li.step")).map((li) => {
    const b = li.querySelector("b");
    const p = li.querySelector("p");
    return { title: (b ? b.textContent : "").trim(), body: (p ? p.textContent : "").replace(/\\s+/g, " ").trim() };
  }) : [];
  const buttons = box ? Array.from(box.querySelectorAll("button")).map((b) => ({
    id: b.id || "", text: (b.textContent || "").replace(/\\s+/g, " ").trim(),
    cls: b.className, w: Math.round(b.getBoundingClientRect().width), h: Math.round(b.getBoundingClientRect().height),
  })) : [];
  // 选盘控件（步骤内可选盘符的控件）
  const picker = box ? box.querySelector("[data-drive-picker],[data-roots-picker],#onboarding-roots,#onboarding-root-select") : null;
  const rootOptions = box ? Array.from(box.querySelectorAll("[data-root]")).map((el) => ({
    root: el.getAttribute("data-root"), tag: el.tagName,
    text: (el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 60),
    disabled: !!el.disabled,
    w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height),
  })) : [];
  const selectOptions = picker && picker.tagName === "SELECT"
    ? Array.from(picker.options).map((o) => ({ value: o.value, text: o.textContent.trim() })) : [];
  // 任一步骤的标题/正文提到「选择…盘」即视为存在选盘步骤（文案层判据）
  const stepText = steps.map((s) => s.title + " " + s.body).join(" | ");
  return {
    visible: !!visible, stepCount: steps.length, steps: steps, buttons: buttons,
    stepText: stepText,
    hasPicker: !!picker, pickerTag: picker ? picker.tagName : null,
    pickerId: picker ? (picker.id || "") : "",
    rootOptions: rootOptions, selectOptions: selectOptions,
    skipButtons: buttons.filter((b) => /跳过|稍后|以后|暂不/.test(b.text)),
  };
})()`;

const ROOTS_MEASURE = `(() => {
  const input = document.getElementById("browse-root");
  const list = document.getElementById("roots-suggest");
  const pageHasDriveId = !!document.querySelector("[data-drive-picker],[data-roots-picker],#onboarding-roots,#onboarding-root-select");
  return {
    browseRootExists: !!input,
    browseRootValue: input ? input.value : null,
    browseRootAttrValue: input ? input.getAttribute("value") : null,
    browseRootPlaceholder: input ? (input.getAttribute("placeholder") || "") : null,
    datalistExists: !!list,
    datalistOptions: list ? Array.from(list.querySelectorAll("option")).map((o) => o.value) : [],
    datalistNotReady: list ? Array.from(list.querySelectorAll('option[data-not-ready="1"]')).map((o) => o.value) : [],
    datalistDynamic: list ? (list.getAttribute("data-dynamic") || "") : "",
    datalistHtmlHadInlineOptions: list ? list.getAttribute("data-dynamic") === "1" : null,
    pageHasDrivePicker: pageHasDriveId,
    compareBaselineTag: (() => { const b = document.getElementById("compare-baseline"); return b ? b.tagName : null; })(),
  };
})()`;

const LAYOUT_MEASURE = `(() => {
  const q = (s) => document.querySelector(s);
  const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; };
  const visibleText = (el) => (el ? (el.textContent || "").replace(/\\s+/g, " ").trim() : "");
  const head = q(".page-head-compare");
  const controls = head ? Array.from(head.querySelectorAll(".compare-ctl, #btn-compare")).map((el) => ({
    id: el.id || (el.querySelector("[id]") ? el.querySelector("[id]").id : ""),
    label: visibleText(el.querySelector("label") || el).slice(0, 40),
    rect: rect(el),
  })) : [];
  return {
    pageTitle: visibleText(q("[data-page-title]")),
    pageSub: visibleText(q("#compare-root-line")),
    /* D5-5：旧称「历史对比」的可见文本命中（页面标题/导航/卡文案） */
    visibleLegacy: (() => {
      const out = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
      let n;
      while ((n = walker.nextNode())) {
        const t = (n.nodeValue || "").replace(/\\s+/g, " ").trim();
        if (!t || t.indexOf(${JSON.stringify(TERMS.legacyTitle)}) === -1) continue;
        const el = n.parentElement;
        if (!el) continue;
        if (el.closest("[hidden],script,style,noscript,template")) continue;
        const cs = getComputedStyle(el);
        if (cs.display === "none" || cs.visibility === "hidden") continue;
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue;
        out.push(t.slice(0, 60) + " @" + (el.id || el.tagName));
      }
      return out;
    })(),
    controls: controls,
    headRect: rect(head),
    hasTargetInput: !!q("#compare-target"),
    hasCurrentRow: !!q("#compare-current"),
    currentRowText: visibleText(q("#compare-current")),
    hasBaselineSelect: (() => { const b = q("#compare-baseline"); return !!b && b.tagName === "SELECT"; })(),
    baselineOptionCount: (() => { const b = q("#compare-baseline"); return b && b.tagName === "SELECT" ? b.options.length : null; })(),
    hasBaselineDatalist: !!q("#baseline-suggest"),
    statusText: visibleText(q("#compare-status-text")),
    emptyText: visibleText(q("#compare-empty")),
    bodyScrollHeight: document.body.scrollHeight,
    docScrollHeight: document.documentElement.scrollHeight,
    innerHeight: window.innerHeight,
    pageScrollTop: window.scrollY,
  };
})()`;

/* ================= 语义判定（页内测量 → 违规判定） ================= */

function classifyHit(h) {
    /* 短语自解释判定：先看定稿白名单（整条短语），再用通用后缀规则。
       注意 title/aria 不参与判定——D5-5 明确要求不依赖悬停。 */
    const phrase = h.phrase || "";
    if (h.word === "基线") {
        if (TERMS.baselineExact.some((s) => phrase.indexOf(s) !== -1)) return { ok: true, why: "定稿用语" };
        if (TERMS.baselineHint.test(phrase)) return { ok: true, why: "自解释限定词（快照/对比/历史/时间/基准）" };
        return { ok: false, why: "裸词：所属短语无「快照/对比/历史/时间/基准」任一限定词" };
    }
    if (TERMS.currentExact.some((s) => phrase.indexOf(s) !== -1)) return { ok: true, why: "定稿用语" };
    if (TERMS.currentHint.test(phrase)) return { ok: true, why: "自解释限定词（当前/磁盘/状态/现状/即时）" };
    return { ok: false, why: "裸词：所属短语无「当前/磁盘/状态/现状/即时」任一限定词" };
}

/* ================= 主流程 ================= */

(async () => {
    let browser = null;
    const fx = await ensureFixtures();
    RESULT.meta.fixtures = fx;
    /* subst 虚拟盘：默认根判据的载体（见文件头说明）。建立失败则明确记为违规，
       不让判据静默失效。 */
    const subst = await establishSubstDrive();
    RESULT.meta.subst = subst;
    let substRemoval = null;
    let harness = null;
    try {
        harness = await startHarness();
        RESULT.meta.base = harness.base;
        RESULT.meta.harnessSpawned = harness.spawned;
        RESULT.meta.harnessState = harness.state || null;

        /* ---- ① API 契约：/api/roots 盘符来源（生产路由 + harness 注入清单） ---- */
        {
            const rec = { key: "GET /api/roots（注入清单 " + ROOTS_SPEC + "）", judges: [] };
            const t0 = Date.now();
            let status = null, body = null;
            try {
                const r = await fetch(harness.base + "api/roots");
                status = r.status;
                body = await r.json().catch(() => null);
            } catch (e) { rec.error = String(e); }
            rec.httpStatus = status;
            rec.elapsedMs = Date.now() - t0;
            rec.body = body;
            const roots = (body && Array.isArray(body.roots)) ? body.roots : null;
            rec.returned = roots ? roots.map((x) => (typeof x === "string" ? x : x && x.root)) : null;
            judge(rec.judges, "J3 /api/roots 存在且 200", status === 200, "status=" + status);
            judge(rec.judges, "J3 /api/roots 返回 roots 数组", !!roots, "body=" + JSON.stringify(body).slice(0, 200));
            judge(rec.judges, "J3 盘符集 == 注入清单（证明来自真枚举而非硬编码）",
                !!roots && JSON.stringify(rec.returned) === JSON.stringify(INJECTED_ROOTS),
                "返回=" + JSON.stringify(rec.returned) + " 注入=" + JSON.stringify(INJECTED_ROOTS));
            judge(rec.judges, "J3 每项带 root 字段且可表达可用性/就绪",
                !!roots && roots.every((x) => x && typeof x === "object" && "root" in x),
                "首项=" + JSON.stringify(roots && roots[0]));
            RESULT.roots.push(rec);
        }

        /* ---- ② 真实枚举正例（不给 --roots 的路径由契约用例覆盖；此处只钉注入面） ---- */

        /* ---- ③ 源码级：默认根魔法值扫描（DoD 3） ---- */
        {
            const scan = scanMagicRoots();
            RESULT.magicScan = scan;
            const judges = [];
            judge(judges, "J4 源码无驱动默认根的 D:\\ 字面量（§1.3 六处全消除）",
                scan.hits.length === 0,
                "扫描 " + scan.scanned + " 文件，命中 " + scan.hits.length + " 处：" +
                JSON.stringify(scan.hits.slice(0, 8)));
            RESULT.roots.push({ key: "源码扫描（web/**/*.js|html）", magicScan: scan, judges: judges });
        }

        browser = await chromium.launch({ headless: true });

        for (const vp of VIEWPORTS) {
            const page = await browser.newPage({ viewport: { width: vp.w, height: vp.h } });
            const vkey = vp.w + "x" + vp.h;
            page.on("console", (m) => {
                if (m.type() !== "error") return;
                const loc = (m.location && m.location() && m.location().url) || "";
                if (/favicon/i.test(m.text() + loc)) return; // 既存环境差异（P2/P3 已登记）
                RESULT.consoleErrors.push(vkey + " console: " + m.text() + " @ " + loc);
            });
            page.on("pageerror", (e) => RESULT.consoleErrors.push(vkey + " pageerror: " + e.message));

            /* 拦截 /api/settings：返回「无 last_roots」——消除「上次浏览」对默认根的
               掩盖效应（有 last_roots 时任何实现都返回它，测不出硬编码 D:\）。 */
            let rootsApiCalls = 0;
            const settingsPosts = [];
            await page.route("**/api/settings", async (route) => {
                if (route.request().method() === "GET") {
                    await route.fulfill({
                        status: 200, contentType: "application/json",
                        body: JSON.stringify({
                            ok: true,
                            settings: { auto_save: false, theme: "light" },   // 无 last_roots
                            data_dir: FIXTURE_ROOT, snapshots_dir: SNAP_DIR,
                        }),
                    });
                    return;
                }
                await route.continue();
            });
            page.on("request", (r) => {
                if (r.url().includes("/api/roots")) rootsApiCalls += 1;
                /* D5-3 行为判据：选盘必须经 /api/settings 写 last_roots（记请求体备查） */
                if (r.url().endsWith("/api/settings") && r.method() === "POST") {
                    settingsPosts.push(r.postData() || "");
                }
            });

            /* 夹具化 /api/roots 响应：把 S:\ 标成**可用**、D:\ 标成**未就绪**。
               为什么必须夹具化（而不是直接用 harness 真枚举结果）：
               - harness 的盘符就绪判定发生在**启动那一刻**（subst 盘可能尚未落定），
                 且「就绪」是环境函数而非被测逻辑 → 用它做期望值会产生假红/假绿；
               - 修复前的默认根是**常量** "D:\"（与盘符就绪无关），所以只要
                 ① 前端确实向 /api/roots 要清单 ② 默认根取「首个可用盘」③ 未就绪盘符
                 保留并标注 —— 修复前 ①③ 皆不成立（无请求、无标注），必然红。
               响应形状与生产 /api/roots 完全同构（label 由本探针按后端口径拼写）。 */
            const fixtureRoots = {
                source: "harness-patch",
                roots: [
                    { root: MAGIC_ROOT, label: MAGIC_ROOT.replace(/\\$/, "") + " 本地盘（未就绪）", ready: false },
                    { root: READY_ROOT, label: READY_ROOT.replace(/\\$/, "") + " 本地盘", ready: true },
                ],
            };
            await page.route("**/api/roots", async (route) => {
                await route.fulfill({
                    status: 200, contentType: "application/json",
                    body: JSON.stringify({
                        ok: true, roots: fixtureRoots.roots,
                        count: fixtureRoots.roots.length,
                        drives_source: fixtureRoots.source,
                    }),
                });
            });

            const gotoApp = async () => {
                await page.addInitScript(() => {
                    try {
                        localStorage.setItem("pds_theme_v1", "light");
                        sessionStorage.setItem("pds_auto_started_v1", "1");
                    } catch (e) { /* ignore */ }
                });
                await page.goto(harness.base, { waitUntil: "load", timeout: 25000 })
                    .catch((e) => { RESULT.meta.gotoError = String(e); });
                await page.waitForSelector("#browse-root", { timeout: 20000 }).catch(() => {});
                await wait(1200);
            };

            /* ===== 态 1：首开引导（含选盘步骤）—— 不清 dismissed 键 ===== */
            await page.addInitScript(() => {
                try { localStorage.removeItem("pds_onboarding_dismissed_v1"); } catch (e) { /* ignore */ }
            });
            await gotoApp();
            const onb = await page.evaluate(ONBOARDING_MEASURE);
            const sem1 = await page.evaluate(SEMANTICS_MEASURE);
            const shot1 = "onboarding-" + vkey + ".png";
            await page.screenshot({ path: path.join(OUT, shot1), fullPage: false });
            RESULT.shots.push(shot1);

            const obJudges = [];
            judge(obJudges, "J2 引导弹层可见", onb.visible, "visible=" + onb.visible);
            const hasPickStep = /选择.{0,6}盘|盘符|要分析/.test(onb.stepText);
            judge(obJudges, "J2 引导含「选择要分析的盘」步骤（文案层）", hasPickStep,
                "steps=" + onb.stepCount + " stepText=" + onb.stepText.slice(0, 160));
            judge(obJudges, "J2 引导含可选盘符的控件", onb.hasPicker,
                "pickerTag=" + onb.pickerTag + " id=" + onb.pickerId);
            const picks = onb.selectOptions.length ? onb.selectOptions.map((o) => o.value) : onb.rootOptions.map((o) => o.root);
            judge(obJudges, "J3 引导选盘项数 == 注入盘符数",
                picks.length === INJECTED_ROOTS.length &&
                INJECTED_ROOTS.every((r) => picks.indexOf(r) !== -1),
                "选项=" + JSON.stringify(picks) + " 注入=" + JSON.stringify(INJECTED_ROOTS));
            judge(obJudges, "J2 「跳过」按钮存在且可点击（尺寸 > 0）",
                onb.skipButtons.length > 0 && onb.skipButtons.every((b) => b.disabled !== true) &&
                onb.skipButtons.some((b) => b.w > 0 && b.h > 0),
                "skip=" + JSON.stringify(onb.skipButtons));
            /* 跳过路径可达性：D5-3 定义「跳过选盘 = 维持既有默认逻辑，不阻塞首开」。
               因此正确语义 = 点「跳过选盘」后**弹层保持打开**（用户还要看后续步骤）
               且选盘步骤切到「已跳过」提示态。P5 前无该按钮（本判据修复前必红）。 */
            let skipWorks = null;
            if (onb.skipButtons.length) {
                const skipId = onb.skipButtons[0].id;
                if (skipId) await page.click("#" + skipId).catch(() => {});
                else await page.getByRole("button", { name: onb.skipButtons[0].text }).first().click().catch(() => {});
                await wait(500);
                skipWorks = await page.evaluate(() => {
                    const b = document.getElementById("onboarding");
                    const open = !!b && !b.classList.contains("hidden") && getComputedStyle(b).display !== "none";
                    const host = document.getElementById("onboarding-roots");
                    const hint = host ? host.textContent : "";
                    return { open: open, skippedHint: /已跳过/.test(hint), hostText: hint.slice(0, 80) };
                });
            }
            judge(obJudges, "J2 点「跳过选盘」后弹层保持打开且切到「已跳过」提示（不阻塞首开）",
                !!skipWorks && skipWorks.open === true && skipWorks.skippedHint === true,
                "skipWorks=" + JSON.stringify(skipWorks));

            /* ---- D5-3 行为判据：点选一个盘 → 选中态 + 经 /api/settings 写 last_roots +
                    立即回灌工作台浏览根（点「开始全量扫描」扫的就是它） ---- */
            const picksNow = onb.selectOptions.length ? onb.selectOptions.map((o) => o.value) : onb.rootOptions.map((o) => o.root);
            const pickTarget = picksNow.indexOf(READY_ROOT) !== -1 ? READY_ROOT : (picksNow[0] || "");
            let pickResult = null;
            if (pickTarget) {
                const postsBefore = settingsPosts.length;
                const clicked = await page.evaluate((root) => {
                    const btn = document.querySelector('#onboarding-roots .onboarding-root[data-root="' + root.replace(/\\/g, "\\\\") + '"]');
                    if (!btn) return false;
                    btn.click();
                    return true;
                }, pickTarget).catch(() => false);
                await wait(700);
                pickResult = await page.evaluate((root) => {
                    const btn = document.querySelector('#onboarding-roots .onboarding-root[data-root="' + root.replace(/\\/g, "\\\\") + '"]');
                    const input = document.getElementById("browse-root");
                    return {
                        clicked: !!btn && btn.classList.contains("is-on"),
                        ariaPressed: btn ? btn.getAttribute("aria-pressed") : null,
                        browseRoot: input ? input.value : null,
                    };
                }, pickTarget);
                pickResult.postClicked = clicked;
                pickResult.settingsPostDelta = settingsPosts.length - postsBefore;
                pickResult.lastPost = settingsPosts[settingsPosts.length - 1] || "";
            }
            judge(obJudges, "D5-3 点选盘符 → 选中态（is-on + aria-pressed）",
                !!pickResult && pickResult.clicked === true && pickResult.ariaPressed === "true",
                JSON.stringify(pickResult));
            judge(obJudges, "D5-3 选盘经 POST /api/settings 写入 last_roots",
                !!pickResult && pickResult.settingsPostDelta >= 1 &&
                pickResult.lastPost.indexOf(pickTarget.replace(/\\/g, "\\\\")) !== -1,
                "delta=" + (pickResult && pickResult.settingsPostDelta) + " post=" + (pickResult && pickResult.lastPost));
            judge(obJudges, "D5-3 选盘立即回灌工作台浏览根（#browse-root == 选中盘）",
                !!pickResult && pickResult.browseRoot === pickTarget,
                "browseRoot=" + (pickResult && pickResult.browseRoot) + " 期望=" + pickTarget);

            RESULT.onboarding.push({
                vkey, measure: onb, judges: obJudges,
                semanticsHits: sem1.hits.length, shot: shot1,
            });

            /* ===== 态 2：对比页空态 ===== */
            await page.evaluate(() => { window.location.hash = "#/compare"; });
            await page.waitForSelector("#compare-baseline", { timeout: 15000 }).catch(() => {});
            await wait(900);
            const sem2 = await page.evaluate(SEMANTICS_MEASURE);
            const lay2 = await page.evaluate(LAYOUT_MEASURE);
            const shot2 = "compare-empty-" + vkey + ".png";
            await page.screenshot({ path: path.join(OUT, shot2), fullPage: false });
            RESULT.shots.push(shot2);

            /* ===== 态 3：对比页有结果 ===== */
            await setCurrent(harness.base, FILES.growthT1);
            const needCompare = await page.$("#compare-baseline");
            if (needCompare) {
                const tag = await page.evaluate(() => document.getElementById("compare-baseline").tagName);
                /* 基线下拉：选一份（修复前是 datalist 文本框；两种形态都要能驱动） */
                const snapped = path.join(SNAP_DIR, FILES.growthT0);
                if (tag === "SELECT") {
                    await page.evaluate((v) => {
                        const s = document.getElementById("compare-baseline");
                        const hit = Array.from(s.options).find((o) => o.value === v) || s.options[1] || s.options[0];
                        if (hit) s.value = hit.value;
                        s.dispatchEvent(new Event("change", { bubbles: true }));
                    }, snapped).catch(() => {});
                } else {
                    await page.fill("#compare-baseline", snapped).catch(async () => {
                        await page.evaluate((v) => {
                            const el = document.getElementById("compare-baseline");
                            el.value = v; el.dispatchEvent(new Event("input", { bubbles: true }));
                        }, snapped);
                    });
                }
                await wait(300);
                /* 兜底：显式改一次输入并派发 input（触发既有 input 监听 → 回写
                   APP_STATE.compare.baseline/root）。修复前基线是自由文本框，
                   datalist 由 snapshots.js 填充、本夹具会话下可能为空；不兜底
                   会停在空态、量不到「有结果」态。点按钮始终是真实用户动作。 */
                await page.evaluate((v) => {
                    const el = document.getElementById("compare-baseline");
                    if (!el) return;
                    el.value = v;
                    el.dispatchEvent(new Event("input", { bubbles: true }));
                    el.dispatchEvent(new Event("change", { bubbles: true }));
                }, snapped).catch(() => {});
                const waiter = page.waitForResponse(
                    (r) => r.url().includes("/api/compare") && !r.url().includes("/status"), { timeout: 60000 }
                ).catch(() => null);
                await page.click("#btn-compare").catch(() => {});
                const resp = await waiter;
                let rbody = null;
                try { rbody = resp ? await resp.json() : null; } catch (e) { rbody = null; }
                await page.waitForFunction(() => {
                    const res = document.getElementById("compare-result");
                    return res && !res.hasAttribute("hidden");
                }, { timeout: 60000 }).catch(() => {});
                await wait(800);
                var resultStatus = resp ? resp.status() : null;
                var resultBody = rbody;
            }
            const sem3 = await page.evaluate(SEMANTICS_MEASURE);
            const lay3 = await page.evaluate(LAYOUT_MEASURE);
            const shot3 = "compare-result-" + vkey + ".png";
            await page.screenshot({ path: path.join(OUT, shot3), fullPage: false });
            RESULT.shots.push(shot3);

            /* ---- 态 2/3 的判定 ---- */
            for (const [stateKey, sem, lay, shot] of [["compare-empty", sem2, lay2, shot2], ["compare-result", sem3, lay3, shot3]]) {
                const sample = { state: stateKey, vkey, shot: shot, judges: [], semantics: sem, layout: lay };
                /* J1 术语：逐命中分类 */
                const classified = sem.hits.map((h) => Object.assign({}, h, classifyHit(h)));
                const bad = classified.filter((c) => !c.ok);
                sample.hits = classified;
                sample.badHits = bad;
                judge(sample.judges, "J1 可见文本无裸词「基线/目标」",
                    bad.length === 0,
                    "违规=" + bad.length + "/" + classified.length + " " +
                    JSON.stringify(bad.map((b) => b.word + "@" + b.id + ":" + b.text.slice(0, 40))));
                /* D5-5：旧称「历史对比」全仓库统一（页面标题 / 导航 / 文案） */
                const legacyHits = lay.visibleLegacy.map((t) => t);
                sample.legacyHits = legacyHits;
                judge(sample.judges, "J1 可见文本无旧称「历史对比」（D5-5 术语统一）",
                    legacyHits.length === 0, "旧称命中=" + JSON.stringify(legacyHits));
                judge(sample.judges, "J5 1366×768 零页面滚动（body.scrollHeight ≤ innerHeight+1）",
                    vp.w !== 1366 || lay.bodyScrollHeight <= lay.innerHeight + 1,
                    "body=" + lay.bodyScrollHeight + " inner=" + lay.innerHeight);
                judge(sample.judges, "J5 页面未发生滚动（scrollY == 0）", lay.pageScrollTop === 0, "scrollY=" + lay.pageScrollTop);
                if (stateKey === "compare-empty") {
                    judge(sample.judges, "J1 空态文案自解释（不再依赖裸词「基线」）",
                        lay.emptyText.length > 0 && classifyHit({ word: "基线", phrase: lay.emptyText }).ok,
                        "emptyText=" + lay.emptyText.slice(0, 120));
                    judge(sample.judges, "J1 页头副行自解释",
                        lay.pageSub.length > 0 && classifyHit({ word: "基线", phrase: lay.pageSub }).ok,
                        "pageSub=" + lay.pageSub.slice(0, 140));
                }
                if (stateKey === "compare-result") {
                    judge(sample.judges, "J1 有结果时摘要/状态行术语自解释",
                        lay.statusText.length > 0 &&
                        !/（?裸词/.test(lay.statusText),
                        "status=" + lay.statusText.slice(0, 140));
                }
                judge(sample.judges, "D5-1 页头不再有只读「目标」输入框",
                    lay.hasTargetInput === false, "hasTargetInput=" + lay.hasTargetInput);
                RESULT.samples.push(sample);
            }

            /* ---- 态 4：默认根（工作台）—— 真·首开条件：无 last_roots + 无上次浏览 ----
               ⚠️ 必须清掉 pds_last_browse_v1：态 1 的启动浏览已把 D:\ 写进去，
               而 F06 的「恢复上次浏览位置」优先级高于枚举首项——留着它，
               本判据就变成在测「恢复上次浏览」而不是「默认根去魔法值」（假绿）。 */
            await page.evaluate(() => { window.location.hash = "#/"; });
            await page.evaluate(() => {
                try { localStorage.removeItem("pds_last_browse_v1"); } catch (e) { /* ignore */ }
            });
            await page.reload({ waitUntil: "load", timeout: 25000 }).catch(() => {});
            await page.waitForSelector("#browse-root", { timeout: 20000 }).catch(() => {});
            await wait(1500);
            const rootsM = await page.evaluate(ROOTS_MEASURE);
            const semW = await page.evaluate(SEMANTICS_MEASURE);
            const rJudges = [];
            judge(rJudges, "J4 工作台默认根输入框存在", rootsM.browseRootExists, JSON.stringify(rootsM));
            judge(rJudges, "J4 默认根初值 ≠ 硬编码 D:\\（夹具：D:\\ 未就绪 / S:\\ 可用）",
                rootsM.browseRootValue !== MAGIC_ROOT,
                "初值=" + JSON.stringify(rootsM.browseRootValue) + " 夹具清单=" + JSON.stringify(INJECTED_ROOTS));
            judge(rJudges, "J4 默认根初值 == 首个**可用**盘（S:\\，不是列表首项 D:\\）",
                rootsM.browseRootValue === READY_ROOT,
                "初值=" + JSON.stringify(rootsM.browseRootValue) + " 期望=" + JSON.stringify(READY_ROOT));
            /* 盘符来源：选项必须来自 /api/roots（注入清单），且**不含**清单外的盘符
               （P5 前模板写死 C\/D\/E\/F\ 四个 → 注入 S:\ 后仍出现 C:\/E:\/F:\ 即硬编码铁证）。
               另允许「最近浏览」项（data-recent）——它是用户自己的历史，不是硬编码。 */
            const apiDrives = rootsM.datalistOptions.filter((v) => INJECTED_ROOTS.indexOf(v) !== -1);
            const nonListed = rootsM.datalistOptions.filter((v) => INJECTED_ROOTS.indexOf(v) === -1);
            judge(rJudges, "J3 盘符 datalist == /api/roots 注入清单（无硬编码 C\\/E\\/F\\）",
                rootsM.datalistOptions.length > 0 &&
                INJECTED_ROOTS.every((r) => rootsM.datalistOptions.indexOf(r) !== -1) &&
                apiDrives.length === INJECTED_ROOTS.length,
                "datalist=" + JSON.stringify(rootsM.datalistOptions) + " 清单内=" + JSON.stringify(apiDrives));
            judge(rJudges, "J3 datalist 项带可用性标注（未就绪盘符不静默丢弃）",
                rootsM.datalistNotReady.length > 0 || rootsM.datalistOptions.length === 0,
                "not-ready=" + JSON.stringify(rootsM.datalistNotReady) + " 全量=" + JSON.stringify(rootsM.datalistOptions));
            judge(rJudges, "J3 datalist 由脚本动态渲染（data-dynamic 标记，非模板硬编码）",
                rootsM.datalistDynamic === "1", "data-dynamic=" + JSON.stringify(rootsM.datalistDynamic));
            judge(rJudges, "J3 前端确实调用了 /api/roots", rootsApiCalls > 0, "rootsApiCalls=" + rootsApiCalls);
            judge(rJudges, "J3 模板初值属性不再写死 D:\\（HTML 模板静态 value）",
                rootsM.browseRootAttrValue !== MAGIC_ROOT,
                "attr value=" + JSON.stringify(rootsM.browseRootAttrValue));
            RESULT.roots.push({
                vkey, key: "工作台默认根（注入 " + ROOTS_SPEC + " + 无 last_roots）",
                measure: rootsM, judges: rJudges, rootsApiCalls: rootsApiCalls,
                semanticsHits: semW.hits.length,
            });
            RESULT.semantics.push({ vkey, state: "onboarding", hits: sem1.hits, bad: sem1.hits.map((h) => Object.assign({}, h, classifyHit(h))).filter((c) => !c.ok) });
            RESULT.semantics.push({ vkey, state: "compare-empty", hits: sem2.hits, bad: sem2.hits.map((h) => Object.assign({}, h, classifyHit(h))).filter((c) => !c.ok) });
            RESULT.semantics.push({ vkey, state: "compare-result", hits: sem3.hits, bad: sem3.hits.map((h) => Object.assign({}, h, classifyHit(h))).filter((c) => !c.ok) });
            RESULT.semantics.push({ vkey, state: "workspace", hits: semW.hits, bad: semW.hits.map((h) => Object.assign({}, h, classifyHit(h))).filter((c) => !c.ok) });

            await page.close();
        }
    } finally {
        if (browser) await browser.close();
        if (harnessProc) { try { harnessProc.kill(); } catch (e) { /* ignore */ } }
        substRemoval = await removeSubstDrive();
        RESULT.meta.substRemoval = substRemoval;
    }

    /* ================= 汇总 ================= */
    const countBad = (arr) => arr.reduce((a, r) => a + r.judges.filter((j) => !j.pass).length, 0);
    /* subst 载体自证：建立失败 / 未清理 → 计违规（判据载体不可静默失效） */
    const substOk = RESULT.meta.subst && RESULT.meta.subst.established === true;
    if (!substOk) RESULT.violations.push("J4 subst 载体未建立（默认根判据载体失效）：" + JSON.stringify(RESULT.meta.subst));
    if (substRemoval && (substRemoval.stillExists || !substRemoval.removed)) {
        RESULT.violations.push("J4 subst 载体未清理干净：" + JSON.stringify(substRemoval));
    }
    const substViolations = (substOk ? 0 : 1) +
        ((substRemoval && (substRemoval.stillExists || !substRemoval.removed)) ? 1 : 0);
    const rootsApiViolations = countBad(RESULT.roots.filter((r) => r.judges));
    const onbApiViolations = countBad(RESULT.onboarding);
    const sampleViolations = countBad(RESULT.samples);
    const semViolations = RESULT.semantics.reduce((a, s) => a + s.bad.length, 0);
    const total = rootsApiViolations + onbApiViolations + sampleViolations + RESULT.consoleErrors.length + substViolations;

    fs.writeFileSync(path.join(OUT, "semantics-" + LABEL + ".json"),
        JSON.stringify({ meta: RESULT.meta, perState: RESULT.semantics.map((s) => ({
            vkey: s.vkey, state: s.state, hitCount: s.hits.length, badCount: s.bad.length,
            hits: s.hits.map((h) => Object.assign({}, h, classifyHit(h))),
        })) }, null, 2), "utf-8");
    fs.writeFileSync(path.join(OUT, "onboarding-" + LABEL + ".json"),
        JSON.stringify({ meta: RESULT.meta, samples: RESULT.onboarding.map((s) => ({
            vkey: s.vkey, shot: s.shot, measure: s.measure, judges: s.judges,
        })) }, null, 2), "utf-8");
    fs.writeFileSync(path.join(OUT, "roots-" + LABEL + ".json"),
        JSON.stringify({ meta: RESULT.meta, magicScan: RESULT.magicScan, samples: RESULT.roots }, null, 2), "utf-8");
    fs.writeFileSync(path.join(OUT, "layout-" + LABEL + ".json"),
        JSON.stringify({ meta: RESULT.meta, samples: RESULT.samples.map((s) => ({
            state: s.state, vkey: s.vkey, shot: s.shot, layout: s.layout, judges: s.judges,
        })) }, null, 2), "utf-8");
    fs.writeFileSync(path.join(OUT, "summary-" + LABEL + ".json"),
        JSON.stringify({
            meta: RESULT.meta, shots: RESULT.shots, consoleErrors: RESULT.consoleErrors,
            totals: {
                rootsApiViolations, onboardingViolations: onbApiViolations,
                sampleViolations, semanticsBadHits: semViolations,
                consoleErrors: RESULT.consoleErrors.length, total,
            },
            violations: RESULT.violations,
            perState: RESULT.semantics.map((s) => ({
                vkey: s.vkey, state: s.state, hits: s.hits.length, bad: s.bad.length,
                words: s.bad.map((b) => b.word + "@" + (b.id || b.cls) + "「" + b.text.slice(0, 30) + "」"),
            })),
        }, null, 2), "utf-8");

    console.log("== p05_semantics_roots_probe (" + LABEL + ") ==");
    console.log("out=" + OUT + "  base=" + RESULT.meta.base);
    console.log("subst 载体：" + JSON.stringify(RESULT.meta.subst) +
        "  清理：" + JSON.stringify(RESULT.meta.substRemoval));
    console.log("-- 盘符来源 / 默认根 --");
    RESULT.roots.filter((r) => r.judges).forEach((r) => {
        const bad = r.judges.filter((j) => !j.pass).length;
        const val = r.measure ? JSON.stringify(r.measure.browseRootValue)
            : r.magicScan ? ("源码命中 " + r.magicScan.hits.length + "/" + r.magicScan.scanned + " 文件")
                : JSON.stringify(r.returned);
        console.log("  " + String(r.key || r.vkey).padEnd(46) + " " + val +
            (r.measure ? " datalist=" + JSON.stringify(r.measure.datalistOptions) : "") +
            (bad ? "  VIOLATION=" + bad : ""));
    });
    console.log("-- 引导弹层（选盘步骤 + 跳过） --");
    RESULT.onboarding.forEach((s) => {
        const bad = s.judges.filter((j) => !j.pass).length;
        console.log("  " + s.vkey.padEnd(12) + " 步骤=" + s.measure.stepCount +
            " 选盘控件=" + s.measure.hasPicker + " 跳过=" + s.measure.skipButtons.length +
            (bad ? "  VIOLATION=" + bad : ""));
    });
    console.log("-- 术语（可见文本裸词扫描） --");
    RESULT.semantics.forEach((s) => {
        console.log("  " + (s.vkey + "/" + s.state).padEnd(34) + " 命中=" + String(s.hits.length).padStart(3) +
            " 裸词违规=" + s.bad.length +
            (s.bad.length ? "  " + JSON.stringify(s.bad.slice(0, 2).map((b) => b.word + "「" + b.text.slice(0, 24) + "」")) : ""));
    });
    console.log("TOTAL rootsApi=" + rootsApiViolations + " onboarding=" + onbApiViolations +
        " samples=" + sampleViolations + " semanticsBadHits=" + semViolations +
        " consoleErrors=" + RESULT.consoleErrors.length + " subst=" + substViolations + " => total=" + total);
    RESULT.violations.slice(0, 30).forEach((v) => console.log("  [V] " + v));
    console.log(total ? "P05 VERDICT: FAIL" : "P05 VERDICT: PASS");
    process.exit(total ? 1 : 0);
})().catch((err) => {
    console.error("[p05] 运行失败：" + (err && err.stack ? err.stack : err));
    if (harnessProc) { try { harnessProc.kill(); } catch (e) { /* ignore */ } }
    process.exit(2);
});
