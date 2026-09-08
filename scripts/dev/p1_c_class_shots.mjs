/* ============================================================
   P1（问题1）· C 类证据探针：扫描卡自动保存三态截图（真实服务，非桩态）
   - 三态：saved（已自动保存）/ skipped（已跳过+原因可见）/ failed（失败+手动入口）
   - 视口：--viewport 1366x768 | 1920x1080（各状态各 1 张）
   - 判据（可脚本化，写入 meta.json）：
       · #autosave-result 可见且类名含期望态 class；
       · 文案不截断：scrollWidth ≤ clientWidth+1（4.3-5）；
       · 保存按钮 disabled 与态匹配（saved→禁用；skipped/failed→可用）；
       · console.error/pageerror 0（favicon 404 噪音除外——本机 P0 挂账）。
   - 输出：--out/<state>-<w>x<h>.png + meta.json（量化数据 + 绝对路径）。
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

    // 量化：文案不截断 + 按钮态 + 类名
    const m = await page.evaluate((expCls) => {
        const area = document.getElementById("autosave-result");
        const saveBtn = document.getElementById("btn-save");
        const card = document.querySelector('.card[aria-label="全量扫描"]');
        const rect = (el) => {
            const r = el.getBoundingClientRect();
            return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
        };
        return {
            areaClass: area ? area.className : null,
            areaText: area ? area.textContent : null,
            areaOverflow: area ? (area.scrollWidth <= area.clientWidth + 1) : null,
            areaRect: area ? rect(area) : null,
            saveDisabled: saveBtn ? saveBtn.disabled : null,
            cardRect: card ? rect(card) : null,
            statusText: (document.getElementById("fullscan-status-text") || {}).textContent || "",
        };
    }, exp.cls);

    // 截图：整卡（右栏扫描卡，宽视口可容）——clip 用卡 rect（页面顶部固定）
    const clip = m.cardRect ? { x: m.cardRect.x, y: Math.max(0, m.cardRect.y - 8), width: m.cardRect.w, height: m.cardRect.h + 60 } : undefined;
    const png = path.join(OUT, STATE + "-" + W + "x" + H + ".png");
    await page.screenshot({ path: png, clip }).catch((e) => console.log("shot err", e.message));

    const passClass = m.areaClass && m.areaClass.indexOf(exp.cls) !== -1;
    const passText = m.areaText && m.areaText.indexOf(exp.keyword) !== -1;
    const passOverflow = m.areaOverflow === true;
    const passBtn = m.saveDisabled === exp.saveDisabled;
    const passConsole = errs.length === 0;

    const meta = {
        state: STATE, viewport: VW, base: BASE,
        captured_at: new Date().toISOString(),
        absolute_png: path.resolve(png),
        clip,
        quant: m,
        checks: {
            ["class=" + exp.cls]: passClass,
            ["text含「" + exp.keyword + "」"]: passText,
            "原因文案不截断(scrollWidth≤clientWidth+1)": passOverflow,
            ["保存按钮disabled=" + exp.saveDisabled]: passBtn,
            "console/pageerror 0(favicon 404 除外)": passConsole,
        },
        consoleErrors: errs,
    };
    fs.writeFileSync(path.join(OUT, "meta_" + STATE + "_" + W + "x" + H + ".json"), JSON.stringify(meta, null, 2), "utf-8");
    console.log("== P1 C 类 " + STATE + " " + VW + " ==");
    console.log("png=" + meta.absolute_png);
    console.log(JSON.stringify(meta.checks, null, 2));
    console.log("areaText=" + (m.areaText || "").slice(0, 80));
    console.log("console errors=" + JSON.stringify(errs));
    await browser.close();
    process.exit((passClass && passText && passOverflow && passBtn) ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });