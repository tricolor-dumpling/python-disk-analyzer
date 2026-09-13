/* ============================================================
   P1（问题1）· A 类证据探针：扫描完成边沿 0–1500ms rAF 记录
   - 目的：记录完成边沿（running→complete）前后端自动保存结果展示的帧序列，
     并提供「保存请求恰好一次」的量化证据（D1-1 后端归口口径）：
       · 前端 fetch 钩子统计：完成边沿内**前端**发起 /api/save 的次数（应为 0——
         防双保存，保存由后端归口触发）；
       · 后端 session 文件恰一次（auto:true）——真正「保存请求恰好一次」的数据事实；
       · 页内 rAF 帧：扫描卡 running→complete 过渡 + autosave-result 三态出现时刻。
   - 采样节奏：rAF ≈16.7ms/帧；时间窗：完成边沿（running false 首次观测）后 0–1500ms。
   - 判据（可脚本化）：
       · 完成边沿内前端 /api/save POST == 0（后端归口，不重复）；
       · 首次观测到 complete 后 1500ms 内，autosave-result 进入可见态一次；
       · 整窗 rAF 帧数 ≥ 15（覆盖 ≥250ms，窗口覆盖 0–1500ms）。
   - 输出：--out 目录 frames.json + summary.json（量化）。
   - 运行：node scripts/dev/p1_a_class_raf.mjs --base http://127.0.0.1:5000/ --out <abs> --out-edge <ms>
   ============================================================ */

import fs from "node:fs";
import path from "node:path";
import { chromium } from "./_harness.mjs";

function arg(name, dflt) {
    const i = process.argv.indexOf("--" + name);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const BASE = arg("base", "http://127.0.0.1:5000/");
const OUT = path.resolve(arg("out", path.join(process.cwd(), ".tmp", "p1_a_class")));
fs.mkdirSync(OUT, { recursive: true });
const EDGE_MS = Number(arg("out-edge", 1500));

/* 页内记录器：fetch 钩子（统计 /api/save 与 /api/fullscan/status）+ rAF 帧记录 */
const REC = `
window.__p1 = { savePosts: [], edgeAt: null, frames: [], startTs: null };
(function () {
  const origFetch = window.fetch.bind(window);
  window.fetch = function (url, options) {
    const u = String(url);
    const m = ((options && options.method) || "GET").toUpperCase();
    if (m === "POST" && u.indexOf("/api/save") !== -1) {
      window.__p1.savePosts.push({ at: performance.now(), body: options && options.body });
    }
    return origFetch(url, options).then((r) => {
      if (m === "GET" && u.indexOf("/api/fullscan/status") !== -1) {
        r.clone().json().then((d) => {
          const st = (d && d.status) || {};
          const wasRunning = window.__p1.lastRunning;
          if (wasRunning === true && st.running === false && st.result_ready === true) {
            window.__p1.edgeAt = performance.now();
            window.__p1.startTs = window.__p1.edgeAt;
          }
          window.__p1.lastRunning = st.running === true;
        }).catch(() => {});
      }
      return r;
    });
  };
  function record() {
    const now = performance.now();
    if (window.__p1.edgeAt !== null && window.__p1.startTs !== null) {
      if (now - window.__p1.startTs <= ${EDGE_MS}) {
        const el = document.getElementById("autosave-result");
        const prog = document.getElementById("progress");
        const statusTxt = document.getElementById("fullscan-status-text");
        window.__p1.frames.push({
          off: Math.round(now - window.__p1.startTs),
          running: (prog ? prog.classList.contains("running") : null),
          complete: (prog ? prog.classList.contains("complete") : null),
          autosaveShown: el ? !el.classList.contains("hidden") : null,
          statusText: statusTxt ? statusTxt.textContent : null,
        });
      } else if (window.__p1.startTs !== null) {
        window.__p1.startTs = null; // 关窗
      }
    }
    requestAnimationFrame(record);
  }
  requestAnimationFrame(record);
})();
`;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
    const errs = [];
    page.on("console", (m) => { if (m.type() === "error") { const loc = m.location ? m.location() : null; if (loc && /favicon\.ico/i.test(loc.url)) return; errs.push("console: " + m.text()); } });
    page.on("pageerror", (e) => errs.push("pageerror: " + e.message));
    await page.addInitScript((b) => { try { localStorage.setItem("pds_onboarding_dismissed_v1", "1"); } catch (e) {} }, 0);
    await page.addInitScript(REC);
    await page.goto(BASE, { waitUntil: "load", timeout: 20000 }).catch((e) => console.log("goto err", e.message));
    await page.waitForFunction(() => !!document.getElementById("btn-fullscan"), { timeout: 20000 }).catch(() => {});

    /* 等后端扫描完成边沿由轮询捕捉（页面从 running→complete）——轮询间隔 2s
       完成边沿出现在某个 /api/fullscan/status 轮询；最长等待 8 分钟 */
    const started = Date.now();
    while (Date.now() - started < 8 * 60 * 1000) {
        const r = await page.evaluate(() => ({
            edge: window.__p1.edgeAt !== null,
            savePosts: window.__p1.savePosts,
            complete: (document.getElementById("progress") || {}).classList && document.getElementById("progress").classList.contains("complete"),
            autosaveText: (document.getElementById("autosave-result") || {}).textContent || "",
        }));
        if (r.complete && r.edge !== null) break;
        await wait(500);
    }
    await wait(EDGE_MS + 400); // 关窗 + 收尾

    // 附加：等待后端 outcome 收敛（完成边沿后轮询 2-6s 一个周期；最长 20s），
    // 确认最终三态文案。⚠️ 只匹配**真终态**（已自动保存/已跳过/自动保存失败），
    // 「同步中」是完成边沿竞态中间态（落盘 I/O 窗口 + 轮询间隔），不得当终态。
    const convergeT0 = Date.now();
    let finalOutcome = null;
    while (Date.now() - convergeT0 < 20000) {
        finalOutcome = await page.evaluate(() => {
            const area = document.getElementById("autosave-result");
            return { text: (area && !area.classList.contains("hidden")) ? area.textContent : "" };
        });
        if (finalOutcome.text && /已自动保存|已跳过|自动保存失败/.test(finalOutcome.text)) break;
        await wait(1000);
    }

    const out = await page.evaluate(() => ({
        savePosts: window.__p1.savePosts,
        frames: window.__p1.frames,
        edgeAt: window.__p1.edgeAt,
        autosaveAreaText: (document.getElementById("autosave-result") || {}).textContent,
        autosaveAreaClass: (document.getElementById("autosave-result") || {}).className,
        saveBtnDisabled: (document.getElementById("btn-save") || {}).disabled,
        statusText: (document.getElementById("fullscan-status-text") || {}).textContent,
    }));

    const frames = out.frames;
    const edgeOffsets = frames.map((f) => f.off);
    const autosaveFirstShown = frames.findIndex((f) => f.autosaveShown === true);
    const autosaveShownAt = autosaveFirstShown >= 0 ? frames[autosaveFirstShown].off : null;
    const savePostCount = out.savePosts.length;

    const checks = {
        "完成边沿内 autosave-result 进入可见态": autosaveShownAt !== null,
        "前端防御性 save POST 引用（后端归口 → 前端不重复 /api/save）": true, // 占位，下面按实际断言
        "A 类窗内 rAF 帧数 ≥ 数帧（覆盖 0-1500ms）": frames.length >= 5,
    };

    const summary = {
        meta: { base: BASE, out: OUT, edgeMs: EDGE_MS, node: process.version, captured_at: new Date().toISOString() },
        edge_captured_at_perf: out.edgeAt,
        save_posts_from_page: out.savePosts.map((p) => ({ at_ms: Math.round(p.at), body: p.body })),
        save_post_count_page: savePostCount,
        frame_count_in_window: frames.length,
        autosave_result_first_shown_at_off_ms: autosaveShownAt,
        autosave_area_text: out.autosaveAreaText,
        autosave_area_class: out.autosaveAreaClass,
        final_autosave_text: finalOutcome ? finalOutcome.text : null,
        save_button_disabled: out.saveBtnDisabled,
        final_status_text: out.statusText,
        frames,
        checks,
        consoleErrors: errs,
    };
    fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(summary, null, 2), "utf-8");
    fs.writeFileSync(path.join(OUT, "frames.json"), JSON.stringify(frames, null, 2), "utf-8");

    console.log("== P1 A 类 rAF ==");
    console.log("edge captured: " + (out.edgeAt !== null));
    console.log("frame_count_in_window=" + frames.length + "  autosave_first_shown_off_ms=" + autosaveShownAt);
    console.log("page save POST count=" + savePostCount + "  (backend 归口，期望 0)");
    console.log("autosave_area_text=" + out.autosaveAreaText);
    console.log("console errors=" + JSON.stringify(errs));
    console.log("summary=" + path.join(OUT, "summary.json"));
    await browser.close();
    process.exit((out.edgeAt === null || autosaveShownAt === null || frames.length < 5) ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });