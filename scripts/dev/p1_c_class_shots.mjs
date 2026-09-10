/* ============================================================
   P1（问题1）· C 类证据探针 v2：扫描卡自动保存三态截图 + 数值化溢出 + 完整错误原因
   - 三态：saved（已自动保存）/ skipped（已跳过+原因可见）/ failed（失败+手动入口）
   - 视口：--viewport 1366x768 | 1920x1080（各状态各 1 张裁剪图 + 1 张整页图）
   - v2 补强（Luna 判读反馈，变更集6）：
       1. 整页 viewport 截图（非 clip）：`<state>-<w>x<h>-full.png`，判整页滚动容器无溢出；
       2. meta 数值化：结果区/卡片/右栏各自
          scrollWidth/clientWidth/scrollHeight/clientHeight + getBoundingClientRect()，
          以及整页 document.documentElement.scrollWidth/clientWidth（横向）与
          scrollHeight/clientHeight（纵向）；
       3. `areaOverflow` 语义澄清 → 拆为 `areaHorizOverflowOk`（横向：scrollWidth ≤
          clientWidth+1，即无横向裁剪/文本硬切）与 `areaVertOverflowNote`
          （纵向：scrollHeight vs clientHeight，.notice 随内容撑开，静态文案 case
          通常 scrollHeight≤clientHeight；若超标需说明）；
       4. failed 态：完整错误文本（area.title=完整异常串）写入 meta
          `failed_full_reason`/`failed_title_attr`；悬停提示即 title 属性（headless
          Chromium 不渲染原生 tooltip，故以 title 属性值 + 摘要对照为完整原因证据）。
   - 判据（可脚本化）：
       · 三态 class/文案关键字/保存按钮 disabled/console 0（favicon 404 除外）；
       · 结果区无横向溢出（scrollWidth ≤ clientWidth+1）；
       · 整页 documentElement.scrollWidth ≤ clientWidth（无整页横向滚动）。
   - 输出：--out/<state>-<w>x<h>.png（裁剪） + --out/<state>-<w>x<h>-full.png（整页）
            + meta_<state>_<w>x<h>.json（数值 + 判据 + console）。
   - 运行：node scripts/dev/p1_c_class_shots.mjs --base http://127.0.0.1:5000/ --out <abs> --state saved --viewport 1366x768
   ============================================================ */

import fs from "node:fs";
import path from "node:path";
import { chromium } from "./_harness.mjs";

function arg(name, dflt) {
    const i = process.argv.indexOf("--" + name);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const BASE = arg("base", "http://127.0.0.1:5000/");
const OUT = path.resolve(arg("out", path.join(process.cwd(), ".tmp", "p1_c_class")));
const STATE = arg("state", "saved");
const VW = arg("viewport", "1366x768");
fs.mkdirSync(OUT, { recursive: true });
const [W, H] = VW.split("x").map(Number);

/* 期望态判据映射 */
const EXPECT = {
    saved: { cls: "notice-success", keyword: "已自动保存", saveDisabled: true },
    skipped: { cls: "notice-warn", keyword: "已跳过自动保存", saveDisabled: false },
    failed: { cls: "notice-error", keyword: "自动保存失败", saveDisabled: false },
};
const exp = EXPECT[STATE];
if (!exp) { console.error("unknown state: " + STATE); process.exit(2); }

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: W, height: H } });
    const errs = [];
    page.on("console", (m) => { if (m.type() === "error") { const loc = m.location ? m.location() : null; if (loc && /favicon\.ico/i.test(loc.url)) return; errs.push("console: " + m.text()); } });
    page.on("pageerror", (e) => errs.push("pageerror: " + e.message));
    await page.addInitScript(() => { try { localStorage.setItem("pds_onboarding_dismissed_v1", "1"); } catch (e) {} });
    await page.goto(BASE, { waitUntil: "load", timeout: 20000 }).catch((e) => console.log("goto err", e.message));
    await page.waitForFunction(() => !!document.getElementById("autosave-result"), { timeout: 20000 }).catch(() => {});

    // 等目标态出现（后端已定格；轮询 2-6s 传播）
    const t0 = Date.now();
    while (Date.now() - t0 < 20000) {
        const r = await page.evaluate((kw) => {
            const area = document.getElementById("autosave-result");
            return !!area && !area.classList.contains("hidden") &&
                area.textContent.indexOf(kw) !== -1;
        }, exp.keyword);
        if (r) break;
        await wait(500);
    }
    await wait(800); // 渲染稳定

    // v2 数值化采集：结果区/卡片/右栏 scroll 尺寸 + rect + 整页 documentElement
    const m = await page.evaluate(() => {
        const area = document.getElementById("autosave-result");
        const saveBtn = document.getElementById("btn-save");
        const card = document.querySelector('.card[aria-label="全量扫描"]');
        const rail = document.getElementById("side-rail");
        const de = document.documentElement;
        const scrollOf = (el) => (el ? {
            scrollWidth: el.scrollWidth, clientWidth: el.clientWidth,
            scrollHeight: el.scrollHeight, clientHeight: el.clientHeight,
        } : null);
        const rectOf = (el) => {
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
        };
        return {
            areaClass: area ? area.className : null,
            areaText: area ? area.textContent : null,
            areaTitle: area ? (area.getAttribute("title") || "") : "",
            areaScroll: scrollOf(area),
            areaRect: rectOf(area),
            cardScroll: scrollOf(card),
            cardRect: rectOf(card),
            railScroll: scrollOf(rail),
            railRect: rectOf(rail),
            pageScroll: { scrollWidth: de.scrollWidth, clientWidth: de.clientWidth, scrollHeight: de.scrollHeight, clientHeight: de.clientHeight },
            saveDisabled: saveBtn ? saveBtn.disabled : null,
            statusText: (document.getElementById("fullscan-status-text") || {}).textContent || "",
        };
    });

    // 语义判定（v2：明确两轴）
    //  横向：scrollWidth ≤ clientWidth+1 → 无横向溢出（文本无硬切，4.3-5 同口径）
    const areaHorizOk = m.areaScroll ? m.areaScroll.scrollWidth <= m.areaScroll.clientWidth + 1 : null;
    const cardHorizOk = m.cardScroll ? m.cardScroll.scrollWidth <= m.cardScroll.clientWidth + 1 : null;
    const railHorizOk = m.railScroll ? m.railScroll.scrollWidth <= m.railScroll.clientWidth + 1 : null;
    const pageHorizOk = m.pageScroll.scrollWidth <= m.pageScroll.clientWidth + 1; // 整页无横向滚动
    //  纵向：记录 scrollHeight vs clientHeight（.notice 随内容撑开，静态文案预期 ≤；
    //        右栏面板内滚是既有规格允许——只记录不判失败）
    const areaVertNote = m.areaScroll ? { scrollHeight: m.areaScroll.scrollHeight, clientHeight: m.areaScroll.clientHeight, verticalOverflow: m.areaScroll.scrollHeight > m.areaScroll.clientHeight + 1 } : null;
    const pageVertNote = { scrollHeight: m.pageScroll.scrollHeight, clientHeight: m.pageScroll.clientHeight, verticalOverflow: m.pageScroll.scrollHeight > m.pageScroll.clientHeight + 1 };

    // 截图：裁剪图（结果卡）保留为高分辨率补充
    const clip = m.cardRect ? { x: m.cardRect.x, y: Math.max(0, m.cardRect.y - 8), width: m.cardRect.w, height: m.cardRect.h + 60 } : undefined;
    const png = path.join(OUT, STATE + "-" + W + "x" + H + ".png");
    await page.screenshot({ path: png, clip }).catch((e) => console.log("shot err", e.message));
    // 整页 viewport 截图（非 clip，fullPage:false）：证明整页无横向/纵向溢出
    const pngFull = path.join(OUT, STATE + "-" + W + "x" + H + "-full.png");
    await page.screenshot({ path: pngFull }).catch((e) => console.log("shot full err", e.message));

    const passClass = m.areaClass && m.areaClass.indexOf(exp.cls) !== -1;
    const passText = m.areaText && m.areaText.indexOf(exp.keyword) !== -1;
    const passHoriz = areaHorizOk === true;
    const passBtn = m.saveDisabled === exp.saveDisabled;
    const passConsole = errs.length === 0;
    const passPageHoriz = pageHorizOk === true;

    const quant = {
        area: { textPreview: (m.areaText || "").slice(0, 60), title: m.areaTitle || null, scroll: m.areaScroll, rect: m.areaRect },
        card: { scroll: m.cardScroll, rect: m.cardRect },
        rail: { scroll: m.railScroll, rect: m.railRect },
        page: m.pageScroll,
        saveDisabled: m.saveDisabled,
        statusText: m.statusText,
    };
    // 判据与语义结论（v2 明确）
    const checks = {
        ["class=" + exp.cls]: passClass,
        ["text含「" + exp.keyword + "」"]: passText,
        "结果区无横向溢出(area scrollWidth≤clientWidth+1)": passHoriz,
        "整页无横向滚动(documentElement scrollWidth≤clientWidth+1)": passPageHoriz,
        ["保存按钮disabled=" + exp.saveDisabled]: passBtn,
        "console/pageerror 0(favicon 404 除外)": passConsole,
    };
    // 语义注记（驳回 Luna 对原 areaOverflow 的歧义）
    const semantics = {
        areaOverflow_v2: "areaHorizOverflowOk：横向判据 scrollWidth≤clientWidth+1（文本无硬切，与 4.3-5 同口径）；旧版布尔 areaOverflow:'true' 即该判据通过，现拆为两轴数值给出",
        areaHorizOverflowOk: areaHorizOk,
        areaVertOverflowNote: areaVertNote,
        cardHorizOverflowOk: cardHorizOk,
        railHorizOverflowOk: railHorizOk,
        pageHorizOverflowOk: pageHorizOk,
        pageVertOverflowNote: pageVertNote,
    };

    const meta = {
        state: STATE, viewport: VW, base: BASE,
        captured_at: new Date().toISOString(),
        absolute_png: path.resolve(png),
        absolute_png_full: path.resolve(pngFull),
        clip,
        quant,
        semantics,
        failed_full_reason: (STATE === "failed") ? (m.areaTitle || m.areaText || "") : null,
        failed_title_attr: (STATE === "failed") ? (m.areaTitle || "") : null,
        checks,
        consoleErrors: errs,
    };
    fs.writeFileSync(path.join(OUT, "meta_" + STATE + "_" + W + "x" + H + ".json"), JSON.stringify(meta, null, 2), "utf-8");
    console.log("== P1 C 类 v2 " + STATE + " " + VW + " ==");
    console.log("clip=" + meta.absolute_png);
    console.log("full=" + meta.absolute_png_full);
    console.log(JSON.stringify(meta.checks, null, 2));
    console.log("areas=scroll:" + JSON.stringify(m.areaScroll) + " page:" + JSON.stringify(m.pageScroll));
    console.log("failed_full_reason=" + (meta.failed_full_reason || "").slice(0, 120));
    console.log("console errors=" + JSON.stringify(errs));
    await browser.close();
    process.exit((passClass && passText && passHoriz && passBtn && passPageHoriz) ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });