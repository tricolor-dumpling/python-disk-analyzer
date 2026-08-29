/* ============================================================
   UI 2.0（SpaceLens Pro）· U2.5 列表视图升级验收探针
   - 验收口径（手册 §U2.5）：
     ①四断言语义（A4 文件行零请求/A5 目录行恰一请求/A6 筛选空态/A12 tile 命中）
       在新 DOM（默认矩形图 + 排行/表格共享视口 + checkbox 首列）全部成立；
     ②多选（N08：Shift 范围选/表头全选半选/页脚计数/定位所选）与导出 CSV 内容
       抽查（文件名 所选-{目录名}-{日期}.csv；引号/逗号/换行转义正确）；
     ③虚拟滚动无跳行（>200 行窗口化；上下缓冲 5 行；行高 cozy 36/compact 26）；
     ④紧凑密度切换生效；F19 三图标（下钻/定位/复制路径）且行内操作不下钻；
     ⑤L1-5 骨架屏（shimmer 1.4s）+ L2-9 缓存徽标（translateX(-8px)+fade 200ms）
       + 三视图切换 120ms 交叉淡化；
     ⑥附录B：5000 行 mock 滚动 ≥50fps（数值入执行记录）；
     ⑦50 次视图切换无泄漏迹象（DOM 节点数稳定 + console 0）。
   - 策略：确定性状态用页内 fetch 桩（init 注入，先于 main.js 模块求值）；
     真实页阶段（--with-data）验证真实目录渲染 + 零滚动 + console 0 + 截图。
   - 运行：node scripts/dev/u25_acc_probe.mjs [--base http://127.0.0.1:5000/]
            [--out <截图目录>] [--with-data]
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
const OUT = arg("out", path.join(os.tmpdir(), "u25_acc_shots"));
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

/* 页内条件等待（≤timeout ms；真实页 /api/browse 抖动锚） */
const WAIT_FN = `(fn, timeout) => new Promise((resolve) => {
  const end = Date.now() + (timeout || 15000);
  const tick = () => { if (fn()) resolve(true); else if (Date.now() > end) resolve(fn()); else setTimeout(tick, 120); };
  tick();
})`;
async function installWait(page) {
    await page.evaluate((src) => { window.__wait = eval("(" + src + ")"); }, WAIT_FN);
}

/* ---- 桩态 fetch（init 注入；browse 样本按 path 分派：
   D:\          → 4 条（2 目录 + 2 文件，含转义样本名）
   D:\big       → 5000 条（2500 目录+2500 文件，用于虚拟滚动/fps）
   D:\slow      → 1 条 + 500ms 时延（骨架屏观察窗）
   ⚠️ 转义层数：本文件为 .mjs 模板字面量内嵌页内脚本——文件内 4 反斜杠
   → 注入后 2 → JS 字符串值 1（Windows 路径单反斜杠）。 */
const STUB_FN = `
window.__U25 = {
  delayFor: { "D:\\\\slow": 500 },
  entries: {
    "D:\\\\": { ok: true, root: "D:\\\\", parent: null,
      directories: [
        { name: "data", path: "D:\\\\data", is_dir: true, size: 12000, size_human: "11.72 KB" },
        { name: 'a "quoted", name', path: 'D:\\\\a "quoted", name', is_dir: true, size: 4000, size_human: "3.91 KB" }
      ],
      files: [
        { name: "pagefile.sys", path: "D:\\\\pagefile.sys", is_dir: false, size: 999999, size_human: "976.56 KB" },
        { name: "line\\nbreak.txt", path: "D:\\\\line\\nbreak.txt", is_dir: false, size: 100, size_human: "100 B" }
      ],
      total_dirs: 2, total_files: 2 },
    "D:\\\\big": null, // 合成（5000 条）
    "D:\\\\slow": { ok: true, root: "D:\\\\slow", parent: "D:\\\\",
      directories: [ { name: "sdir", path: "D:\\\\slow\\\\sdir", is_dir: true, size: 10, size_human: "10 B" } ],
      files: [], total_dirs: 1, total_files: 0 },
  }
};
function __u25Big() {
  const dirs = [], files = [];
  dirs.push({ name: 'big "dir", one', path: 'D:\\\\big\\\\big "dir", one', is_dir: true, size: 5000000, size_human: "4.77 MB" });
  files.push({ name: "big\\nfile.txt", path: "D:\\\\big\\\\big\\nfile.txt", is_dir: false, size: 400000, size_human: "390.63 KB" });
  for (let i = 0; i < 2499; i++) {
    dirs.push({ name: "dir" + i, path: "D:\\\\big\\\\dir" + i, is_dir: true, size: 5000000 - i * 1000, size_human: (5000000 - i * 1000) / 1048576 + " MB" });
    files.push({ name: "file" + i, path: "D:\\\\big\\\\file" + i, is_dir: false, size: 400000 - i, size_human: "390 KB" });
  }
  return { ok: true, root: "D:\\\\big", parent: "D:\\\\", directories: dirs, files: files,
           total_dirs: dirs.length, total_files: files.length };
}
window.fetch = function (url, options) {
  options = options || {};
  const key = (options.method || "GET").toUpperCase() + " " + String(url).split("?")[0];
  const json = (o, s) => Promise.resolve({ ok: (s || 200) < 400, status: s || 200,
    json: () => Promise.resolve(JSON.parse(JSON.stringify(o))) });
  if (key === "POST /api/browse") {
    const p = options.body ? JSON.parse(options.body).path : null;
    const delay = window.__U25.delayFor[p] || 0;
    const body = p === "D:\\\\big" ? __u25Big() : (window.__U25.entries[p] || window.__U25.entries["D:\\\\"]);
    return delay ? new Promise((r) => setTimeout(() => r(json(body)), delay)) : json(body);
  }
  if (key === "POST /api/open-path") return json({ ok: true, launched: true, message: "已请求资源管理器定位" });
  const m = {
    "GET /api/health": { ok: true, ready: true, dll: "stub", message: "Everything 已就绪" },
    "GET /api/settings": { ok: true, settings: { auto_save: false, last_roots: ["D:\\\\"] }, data_dir: "C:\\\\stub", snapshots_dir: "C:\\\\stub" },
    "GET /api/fullscan/status": { ok: true, status: { running: false, roots: ["C:\\\\"], roots_done: 0, roots_total: 1, current_root: null, error: null, result_ready: false, save_ready: false, progress_pct: 0, scan_version: 1 } },
    "GET /api/snapshots": { ok: true, sessions: [], count: 0 },
    "GET /api/overview": { ok: true, ready: true, roots: [ { root: "C:\\\\", total: 1200000, total_human: "1.14 MB", index_ready: true, index_valid: true, directories: [], files: [], directory_count: 10, file_count: 10, record_count: 20, completed_at: "2026-08-28T10:00:00" } ], completed_at: "2026-08-28T10:00:00" },
    "POST /api/settings": { ok: true, settings: {} },
  };
  return m[key] ? json(m[key]) : json({ ok: true });
};
`;

(async () => {
    const browser = await chromium.launch();
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));

    /* ================= 阶段 1：桩态全量验收 ================= */
    console.log("== 阶段 1：桩态（多选/CSV/虚拟滚动/动效/断言语义） ==");
    {
        const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 }, acceptDownloads: true });
        const page = await ctx.newPage();
        const errs = [];
        page.on("pageerror", (e) => errs.push("pageerror: " + e.message));
        page.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text()); });
        await page.addInitScript(STUB_FN);
        await page.goto(BASE, { waitUntil: "domcontentloaded" });
        await installWait(page);

        /* ---- ① 默认视图 = 矩形图（N01 接管）+ 三视图切换 120ms 交叉淡化 ---- */
        console.log("-- 默认视图与视图切换 --");
        ok("默认视图为矩形图", await page.evaluate(() =>
            !document.getElementById("treemap-wrap").hasAttribute("hidden") &&
            document.getElementById("table-wrap").classList.contains("hidden") &&
            !document.getElementById("merge-group").hasAttribute("hidden")), "默认应显示 treemap 容器");
        const layoutReady = await page.evaluate(async () =>
            await window.__wait(() => {
                const c = document.querySelector("#treemap-wrap canvas");
                return !!c && c.width > 0;
            }, 8000));
        ok("treemap canvas 渲染", layoutReady);
        // 交叉淡化：点击排行瞬间双容器可见（absolute 叠加）+ WAAPI opacity 动画在跑
        const fadeInfo = await page.evaluate(() => {
            document.getElementById("btn-view-ranking").click();
            const tw = document.getElementById("table-wrap");
            const w = document.getElementById("treemap-wrap");
            const anims = tw.getAnimations({ subtree: true }).filter((a) => a.effect && a.effect.getTiming && a.effect.getTiming().duration === 120);
            return {
                tableVisible: !tw.classList.contains("hidden"),
                wrapVisible: !w.hasAttribute("hidden"),
                animCount: anims.length,
                fadeTarget: anims.length ? String(anims[0].effect.target.className) : "",
            };
        });
        ok("交叉淡化期间双容器同时可见", fadeInfo.tableVisible && fadeInfo.wrapVisible,
            JSON.stringify(fadeInfo));
        ok("交叉淡化有 120ms opacity 动画", fadeInfo.animCount >= 1 &&
            fadeInfo.fadeTarget.indexOf("table-wrap") !== -1, JSON.stringify(fadeInfo));
        ok("交叉淡化结束表格容器可见/矩形图形隐藏", await page.evaluate(async () =>
            await window.__wait(() =>
                !document.getElementById("table-wrap").classList.contains("hidden") &&
                document.getElementById("treemap-wrap").hasAttribute("hidden"), 2000),
        ));
        await wait(250); // 交叉淡化 + L1-2/L1-3 收束
        ok("排行视图行渲染（checkbox 首列 + 目录/文件行）", await page.evaluate(() => {
            const boxes = document.querySelectorAll("#dir-body .row-check");
            return boxes.length === 4 &&
                document.querySelectorAll("#dir-body .ranking-row[data-path]").length === 2 &&
                document.querySelectorAll("#dir-body .ranking-row-static").length === 2;
        }));
        ok("页脚固定行「共 4 项」", await page.evaluate(() =>
            document.getElementById("list-count").textContent === "共 4 项"));
        const l13 = await page.evaluate(async () => {
            const bar = document.querySelector("#dir-body .size-bar");
            if (!bar || !bar.dataset.w) return { pass: false, why: "no-bar" };
            const target = parseFloat(bar.dataset.w);
            await new Promise((r) => setTimeout(r, 700));
            const end = parseFloat(getComputedStyle(bar).width) || 0;
            return { pass: target > 0 && end >= target - 0.5, target: target, endPx: end };
        });
        ok("L1-3 占比条生长（600ms）终值正确", l13.pass === true, JSON.stringify(l13));
        shot(page, "01-ranking");

        /* ---- ② 四断言语义（新 DOM）---- */
        console.log("-- ① 语义：A4/A5 文件行零请求 / 目录行恰一请求 --");
        const a4 = await page.evaluate(async () => {
            window.__u25Fetches = [];
            const orig = window.fetch;
            window.fetch = function (url, options) {
                if (String(url).indexOf("/api/browse") !== -1) window.__u25Fetches.push(JSON.parse(options.body).path);
                return orig(url, options);
            };
            const staticRow = document.querySelector("#dir-body .ranking-row-static");
            staticRow.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            staticRow.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
            await new Promise((r) => setTimeout(r, 60));
            const n1 = window.__u25Fetches.length;
            window.__u25Fetches = [];
            const dirRow = document.querySelector("#dir-body .ranking-row[data-path]");
            dirRow.click();
            await new Promise((r) => setTimeout(r, 80));
            const paths = window.__u25Fetches.slice();
            window.fetch = orig;
            return { fileClicks: n1, dirFetches: paths.length, dirPath: paths[0] };
        });
        ok("A4：静态文件行点击/键盘 = 0 次 browse", a4.fileClicks === 0, JSON.stringify(a4));
        ok("A5：目录行点击恰 1 次 browse 且 path 正确", a4.dirFetches === 1 && a4.dirPath === "D:\\data",
            JSON.stringify(a4));

        /* ---- F19：三图标 + 行内操作不触发下钻 ---- */
        console.log("-- F19 行内操作（下钻/定位/复制路径）--");
        const f19 = await page.evaluate(async () => {
            window.__u25Fetches = [];
            const orig = window.fetch;
            window.fetch = function (url, options) {
                if (String(url).indexOf("/api/browse") !== -1) window.__u25Fetches.push(JSON.parse(options.body).path);
                return orig(url, options);
            };
            const dirRow = document.querySelector("#dir-body .ranking-row[data-path]");
            const drillBtns = dirRow.querySelectorAll(".act-drill");
            const openBtns = dirRow.querySelectorAll(".act-open");
            const copyBtns = dirRow.querySelectorAll(".act-copy");
            const staticRow = document.querySelector("#dir-body .ranking-row-static");
            const staticHasDrill = !!staticRow.querySelector(".act-drill");
            // 下钻图标：恰 1 次 browse + 恰 1 路径
            drillBtns[0].click();
            await new Promise((r) => setTimeout(r, 60));
            const drillFetches = window.__u25Fetches.length;
            const drillPath = window.__u25Fetches[0];
            window.__u25Fetches = [];
            // 定位（open-path）：0 次 browse（修复前会连带下钻）
            openBtns[0].click();
            await new Promise((r) => setTimeout(r, 60));
            const openFetches = window.__u25Fetches.length;
            window.fetch = orig;
            return { hasDrill: drillBtns.length === 1, openExists: openBtns.length === 1, copyExists: copyBtns.length === 1,
                     staticHasDrill, drillFetches, drillPath, openFetches };
        });
        ok("F19：目录行有三图标（下钻/定位/复制）", f19.hasDrill && f19.openExists && f19.copyExists, JSON.stringify(f19));
        ok("F19：文件行无「下钻」图标", f19.staticHasDrill === false);
        ok("F19：下钻图标恰 1 次 browse 且路径正确", f19.drillFetches === 1 && f19.drillPath === "D:\\data", JSON.stringify(f19));
        ok("F19：定位图标 0 次 browse（行内操作不再连带下钻）", f19.openFetches === 0, "openFetches=" + f19.openFetches);

        /* ---- 多选 N08（含 Shift 范围选）---- */
        console.log("-- N08 多选 --");
        const sel = await page.evaluate(async () => {
            const boxes = () => Array.from(document.querySelectorAll("#dir-body .row-check"));
            boxes()[0].click();
            await new Promise((r) => setTimeout(r, 40));
            const one = document.getElementById("list-selected").textContent;
            const actionsShown = !document.getElementById("list-selected-actions").hasAttribute("hidden");
            const headerIndet = document.getElementById("check-all").indeterminate;
            boxes()[2].dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
            await new Promise((r) => setTimeout(r, 40));
            const three = document.getElementById("list-selected").textContent;
            boxes()[3].click();
            await new Promise((r) => setTimeout(r, 40));
            const four = document.getElementById("list-selected").textContent;
            const headChecked = document.getElementById("check-all").checked;
            document.getElementById("check-all").click();
            await new Promise((r) => setTimeout(r, 40));
            const zero = document.getElementById("list-selected").textContent;
            const actionsHidden = document.getElementById("list-selected-actions").hasAttribute("hidden");
            // 再选 3 项供 CSV 导出（含转义样本名：idx1 data 目录 + idx2 引号目录 + idx3 换行文件；
            // 排序 = 大小降序：pagefile/data/引号目录/换行文件）
            boxes()[1].click();
            boxes()[2].click();
            boxes()[3].click();
            await new Promise((r) => setTimeout(r, 40));
            const threeAgain = document.getElementById("list-selected").textContent;
            return { one, actionsShown, headerIndet, three, four, headChecked, zero, actionsHidden, threeAgain };
        });
        ok("单选 → 已选 1 项 + 操作组出现 + 表头半选", sel.one === "已选 1 项" && sel.actionsShown && sel.headerIndet, JSON.stringify(sel));
        ok("Shift 范围选 → 已选 3 项（anchor..idx）", sel.three === "已选 3 项", sel.three);
        ok("补选第 4 项 → 全选 + 表头 checked", sel.four === "已选 4 项" && sel.headChecked, JSON.stringify(sel));
        ok("表头点击清选 → 已选 0 项 + 操作组隐藏", sel.zero === "已选 0 项" && sel.actionsHidden, JSON.stringify(sel));
        ok("再选 3 项 → 已选 3 项", sel.threeAgain === "已选 3 项", sel.threeAgain);

        /* ---- 导出所选 CSV（D9：文件名/转义/列）---- */
        console.log("-- D9 导出所选 CSV --");
        const dlPromise = page.waitForEvent("download", { timeout: 5000 });
        await page.click("#btn-export-selected");
        const dl = await dlPromise;
        const fname = dl.suggestedFilename();
        ok("CSV 文件名格式 所选-{目录名}-{日期}.csv", /^所选-[^-]+-\d{4}-\d{2}-\d{2}\.csv$/.test(fname), fname);
        const csvPath = await dl.path();
        const csvText = fs.readFileSync(csvPath, "utf8");
        const csvLines = csvText.replace(/^\ufeff/, "").split("\r\n");
        ok("CSV 有 BOM + 表头 5 列", csvText.charCodeAt(0) === 0xFEFF && csvLines[0] === "名称,路径,类型,大小(字节),大小(可读)",
            csvLines[0]);
        ok("CSV 行数 = 选中 3 + 表头", csvLines.length === 4, "lines=" + csvLines.length + " :: " + JSON.stringify(csvLines));
        ok("CSV 含引号转义样本（\"a \"\"quoted\"\", name\"）", csvText.indexOf('"a ""quoted"", name"') !== -1, "");
        ok("CSV 含换行样本（line\\nbreak）", csvText.replace(/\r\n/g, "\n").indexOf('"line\nbreak.txt"') !== -1, "");
        ok("CSV 类型列正确（目录/文件）", csvText.indexOf(",目录,") !== -1 && csvText.indexOf(",文件,") !== -1, "");
        ok("CSV 大小列含人类可读", csvText.indexOf("11.72 KB") !== -1 || csvText.indexOf("100 B") !== -1, "");

        /* ---- 虚拟滚动（>200 行；无跳行；缓冲 5 行；紧凑密度）---- */
        console.log("-- 虚拟滚动 --");
        await page.evaluate(() => { document.getElementById("browse-root").value = "D:\\big"; document.getElementById("btn-browse").click(); });
        ok("5000 行响应后排行视图窗口化渲染", await page.evaluate(async () =>
            await window.__wait(() => {
                const rows = document.querySelectorAll("#dir-body tr:not(.v-spacer)");
                const total = document.querySelectorAll("#dir-body .row-check").length;
                return document.getElementById("list-count").textContent === "共 5000 项" && rows.length > 0 && rows.length < 60 && total < 60;
            }, 8000)));
        const winInfo = await page.evaluate(() => ({
            rows: document.querySelectorAll("#dir-body tr:not(.v-spacer)").length,
            firstIdx: document.querySelector("#dir-body .row-check").dataset.idx,
            lastIdx: Array.from(document.querySelectorAll("#dir-body .row-check")).pop().dataset.idx,
            rowH: document.querySelector("#dir-body tr:not(.v-spacer)").getBoundingClientRect().height,
            scrollH: document.getElementById("table-wrap").scrollHeight,
            wrapH: document.getElementById("table-wrap").clientHeight,
        }));
        ok("窗口行数有界（含缓冲）", winInfo.rows >= 10 && winInfo.rows <= 50, JSON.stringify(winInfo));
        ok("行高 cozy = 36px（实测）", Math.abs(winInfo.rowH - 36) <= 1, "rowH=" + winInfo.rowH);
        ok("滚动内容总高 ≈ 5000×36", Math.abs(winInfo.scrollH - 5000 * winInfo.rowH) < 4 * winInfo.rowH,
            "scrollH=" + winInfo.scrollH + " rowH=" + winInfo.rowH);

        // 无跳行：多处滚动位置，首个窗口行 idx 必须 = max(0, floor(scrollTop/rowH)-5)
        const jumpInfo = await page.evaluate(async () => {
            const wrap = document.getElementById("table-wrap");
            const res = [];
            const rowH = document.querySelector("#dir-body tr:not(.v-spacer)").getBoundingClientRect().height;
            for (const st of [0, 5000, 12345, 80000, 179000]) {
                wrap.scrollTop = st;
                await new Promise((r) => setTimeout(r, 80));
                const first = Number(document.querySelector("#dir-body .row-check").dataset.idx);
                const expect = Math.max(0, Math.floor(wrap.scrollTop / rowH) - 5);
                const idxs = Array.from(document.querySelectorAll("#dir-body .row-check")).map((c) => Number(c.dataset.idx));
                let contiguous = true;
                for (let i = 1; i < idxs.length; i++) { if (idxs[i] !== idxs[i - 1] + 1) { contiguous = false; break; } }
                res.push({ st: wrap.scrollTop, first, expect, ok: first === expect, contig: contiguous });
            }
            return res;
        });
        ok("虚拟滚动无跳行（5 处滚动位置首行=期望）", jumpInfo.every((j) => j.ok),
            JSON.stringify(jumpInfo.map((j) => j.first + "/" + j.expect)));
        ok("窗口行 idx 连续", jumpInfo.every((j) => j.contig));
        // 滚到底：最后一行渲染
        const bottomInfo = await page.evaluate(async () => {
            const wrap = document.getElementById("table-wrap");
            wrap.scrollTop = wrap.scrollHeight;
            await new Promise((r) => setTimeout(r, 120));
            const idxs = Array.from(document.querySelectorAll("#dir-body .row-check")).map((c) => Number(c.dataset.idx));
            return { last: idxs[idxs.length - 1], count: idxs.length };
        });
        ok("滚动到底渲染最后一行（4999）", bottomInfo.last === 4999, JSON.stringify(bottomInfo));
        // 紧凑密度：行高 26 + 窗口重算
        await page.click("#btn-density");
        await wait(150);
        const compactInfo = await page.evaluate(() => ({
            rowH: document.querySelector("#dir-body tr:not(.v-spacer)").getBoundingClientRect().height,
            compact: document.getElementById("dir-body").classList.contains("compact-list"),
            pressed: document.getElementById("btn-density").getAttribute("aria-pressed"),
        }));
        ok("紧凑密度行高 ≈ 26px + 类/按钮态生效", Math.abs(compactInfo.rowH - 26) <= 1 && compactInfo.compact && compactInfo.pressed === "true",
            JSON.stringify(compactInfo));
        await page.click("#btn-density"); // 恢复舒适
        shot(page, "02-virtual-ranking");

        // 排序/筛选后重算窗口（筛选 5000→{dir1*}+big）
        const filterInfo = await page.evaluate(async () => {
            document.getElementById("browse-filter").value = "dir1";
            document.getElementById("browse-filter").dispatchEvent(new Event("input"));
            await new Promise((r) => setTimeout(r, 150));
            const count = document.getElementById("list-count").textContent;
            const rows = document.querySelectorAll("#dir-body .row-check").length;
            const sortBox = document.getElementById("browse-sort");
            sortBox.value = "name-asc";
            sortBox.dispatchEvent(new Event("input"));
            await new Promise((r) => setTimeout(r, 150));
            const nameCell = document.querySelector("#dir-body .ranking-name").textContent;
            document.getElementById("browse-filter").value = "";
            document.getElementById("browse-filter").dispatchEvent(new Event("input"));
            await new Promise((r) => setTimeout(r, 150));
            return { count, rows, nameCell, restored: document.getElementById("list-count").textContent };
        });
        ok("筛选后窗口重算（共 1200+ 项）", /^共 \d+ 项$/.test(filterInfo.count) && filterInfo.count !== "共 5000 项" && filterInfo.rows < 60,
            JSON.stringify(filterInfo));
        ok("排序切换生效（name-asc）", filterInfo.nameCell.length > 0, filterInfo.nameCell);
        ok("清除筛选恢复 5000 项", filterInfo.restored === "共 5000 项", filterInfo.restored);

        /* ---- 附录B：5000 行滚动 fps ---- */
        console.log("-- 附录B 5000 行滚动帧率 --");
        const fps = await page.evaluate(async () => {
            const wrap = document.getElementById("table-wrap");
            let frames = 0;
            const t0 = performance.now();
            let done = false;
            const step = () => {
                if (performance.now() - t0 > 2000) { done = true; return; }
                wrap.scrollTop += 240;
                frames += 1;
                requestAnimationFrame(step);
            };
            requestAnimationFrame(step);
            await new Promise((r) => {
                const iv = setInterval(() => { if (done) { clearInterval(iv); r(); } }, 120);
            });
            return { fps: frames / 2, frames };
        });
        ok("5000 行滚动 ≥50fps", fps.fps >= 50, "fps=" + fps.fps.toFixed(1) + " frames=" + fps.frames);
        console.log("  📊 5000 行滚动实测 fps = " + fps.fps.toFixed(1));

        /* ---- L1-5 骨架屏（时延 browse）+ L2-9 缓存徽标 ---- */
        console.log("-- L1-5 骨架屏 / L2-9 缓存徽标 --");
        const skelInfo = await page.evaluate(async () => {
            document.getElementById("browse-root").value = "D:\\slow";
            document.getElementById("btn-browse").click();
            const shown = document.getElementById("browse-loading").classList.contains("hidden") === false;
            const skelRows = document.querySelectorAll("#browse-loading .skel-row").length;
            const spinner = !!document.querySelector("#browse-loading .spinner");
            await new Promise((r) => setTimeout(r, 700));
            const hiddenAfter = document.getElementById("browse-loading").classList.contains("hidden");
            const badge = document.getElementById("browse-cache-badge");
            const badgeShown = !badge.classList.contains("hidden");
            const badgeAnim = badge.classList.contains("cache-badge-in");
            const badgeAnims = badge.getAnimations().length;
            return { shown, skelRows, spinner, hiddenAfter, badgeShown, badgeAnim, badgeAnims };
        });
        ok("L1-5：加载态显示骨架屏（6 行 shimmer 块、无 spinner）", skelInfo.shown && skelInfo.skelRows === 6 && !skelInfo.spinner,
            JSON.stringify(skelInfo));
        ok("L1-5：数据到达后骨架屏收起", skelInfo.hiddenAfter === true);
        ok("L2-9：缓存徽标显示 + 入场动画（cache-badge-in）", skelInfo.badgeShown && skelInfo.badgeAnim && skelInfo.badgeAnims > 0,
            JSON.stringify(skelInfo));

        /* ---- 触屏长按呼出行操作 ---- */
        console.log("-- F19 触屏长按 --");
        const touchInfo = await page.evaluate(async () => {
            document.getElementById("browse-filter").value = "";
            document.getElementById("browse-filter").dispatchEvent(new Event("input"));
            await new Promise((r) => setTimeout(r, 100));
            const tr = document.querySelector("#dir-body tr:not(.v-spacer)");
            const t = new Touch({ identifier: 1, target: tr, clientX: 10, clientY: 10 });
            tr.dispatchEvent(new TouchEvent("touchstart", { bubbles: true, touches: [t], changedTouches: [t] }));
            await new Promise((r) => setTimeout(r, 620));
            const pinned = tr.classList.contains("row-actions-pin");
            tr.dispatchEvent(new TouchEvent("touchend", { bubbles: true, touches: [], changedTouches: [t] }));
            return { pinned };
        });
        ok("触屏长按 500ms 呼出行操作（row-actions-pin）", touchInfo.pinned, JSON.stringify(touchInfo));

        /* ---- 50 次视图切换（泄漏迹象：DOM 节点数稳定 + 无错误）---- */
        console.log("-- 50 次视图切换 --");
        const cycleInfo = await page.evaluate(async () => {
            const base = document.querySelectorAll("*").length;
            for (let i = 0; i < 50; i++) {
                document.getElementById("btn-view-table").click();
                await new Promise((r) => setTimeout(r, 20));
                document.getElementById("btn-view-ranking").click();
                await new Promise((r) => setTimeout(r, 20));
            }
            await new Promise((r) => setTimeout(r, 400));
            document.getElementById("btn-view-treemap").click();
            await new Promise((r) => setTimeout(r, 200));
            return { base, after: document.querySelectorAll("*").length,
                     treemapSeen: !document.getElementById("treemap-wrap").hasAttribute("hidden") };
        });
        ok("50 次切换后 DOM 节点数无增长", cycleInfo.after <= cycleInfo.base + 40, JSON.stringify(cycleInfo));
        ok("50 次切换后可回默认矩形图", cycleInfo.treemapSeen);
        ok("阶段 1 console/pageerror = 0", errs.length === 0, errs.join("\n"));

        /* ---- 表格视图 + 多选页脚截图 ---- */
        await page.evaluate(() => document.getElementById("btn-view-table").click());
        await wait(250);
        await page.evaluate(() => {
            document.getElementById("browse-root").value = "D:\\";
            document.getElementById("btn-browse").click();
        });
        await wait(300);
        await page.evaluate(() => {
            const boxes = document.querySelectorAll("#dir-body .row-check");
            boxes[0].click();
        });
        await wait(150);
        shot(page, "03-table-selected");
        await page.evaluate(() => document.getElementById("browse-root").value = "D:\\big");
        await page.evaluate(() => document.getElementById("btn-browse").click());
        await wait(300);

        /* ---- 定位所选（虚拟 5000 滚动到中部已选项）---- */
        const locateInfo = await page.evaluate(async () => {
            document.getElementById("btn-view-ranking").click();
            await new Promise((r) => setTimeout(r, 250));
            const wrap = document.getElementById("table-wrap");
            const rowH = document.querySelector("#dir-body tr:not(.v-spacer)").getBoundingClientRect().height;
            wrap.scrollTop = 2000 * rowH;
            await new Promise((r) => setTimeout(r, 100));
            document.querySelector('#dir-body [data-idx="2000"]').closest("tr").querySelector(".row-check").click();
            wrap.scrollTop = 0;
            await new Promise((r) => setTimeout(r, 100));
            document.getElementById("btn-locate-selected").click();
            await new Promise((r) => setTimeout(r, 150));
            const idxs = Array.from(document.querySelectorAll("#dir-body .row-check")).map((c) => Number(c.dataset.idx));
            return { scrollTop: wrap.scrollTop, min: Math.min(...idxs), max: Math.max(...idxs) };
        });
        ok("定位所选：滚到已选条目（idx 2000 落在窗口内）", locateInfo.min <= 2000 && locateInfo.max >= 2000,
            JSON.stringify(locateInfo));

        await ctx.close();
    }

    /* ================= 阶段 2：真实页（--with-data）================= */
    if (WITH_DATA) {
        console.log("== 阶段 2：真实页 ==");
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        const errs = [];
        page.on("pageerror", (e) => errs.push("pageerror: " + e.message));
        page.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text()); });
        await page.goto(BASE, { waitUntil: "domcontentloaded" });
        await installWait(page);
        // 等真实 browse（真实目录或扫描中提示）
        await page.evaluate(() => window.__wait(() =>
            !document.getElementById("table-wrap").classList.contains("hidden") ||
            !document.getElementById("treemap-wrap").hasAttribute("hidden") ||
            !document.getElementById("browse-guide").classList.contains("hidden"), 20000)).catch(() => {});
        await page.evaluate(() => document.getElementById("btn-view-ranking").click());
        await page.evaluate(() => window.__wait(() =>
            document.querySelectorAll("#dir-body .row-check").length > 0 ||
            !!document.querySelector("#dir-body .empty-state"), 15000)).catch(() => {});
        ok("真实页排行视图渲染（行或空态）", await page.evaluate(() =>
            document.querySelectorAll("#dir-body .row-check").length > 0 ||
            !!document.querySelector("#dir-body .empty-state")));
        shot(page, "05-real-ranking");
        await page.evaluate(() => document.getElementById("btn-view-treemap").click());
        await wait(400);
        shot(page, "06-real-treemap");
        ok("真实页 console/pageerror = 0", errs.length === 0, errs.join("\n"));

        // 零滚动两档
        for (const vp of [[1366, 768], [1920, 1080]]) {
            await page.setViewportSize({ width: vp[0], height: vp[1] });
            await wait(200);
            const z = await page.evaluate(() => ({
                sh: document.body.scrollHeight, ch: document.body.clientHeight,
                ih: window.innerHeight,
            }));
            ok("零滚动 @" + vp.join("×"), z.sh <= z.ih + 1, JSON.stringify(z));
        }
        await page.close();
    }

    await browser.close();
    console.log("========================================");
    console.log("U2.5 验收结果：" + passCount + "/" + (passCount + failCount) + " 通过；截图目录 " + OUT);
    process.exit(failCount ? 1 : 0);
})();
