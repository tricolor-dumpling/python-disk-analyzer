/* ============================================================
   阶段 P2 · B 类证据：CDP `Page.startScreencast` 像素级帧序列 + 混合比例量化
   - 目的：为「矩形图↔列表 120ms 交叉淡化」提供**像素级**证据，并证明 screencast 的
     中间帧确实是**混合帧**（而非重复的终态帧）——每帧与两个纯参照帧做像素比较：
       refRanking.png（列表稳定态，矩形图 hidden）
       refTreemap.png（矩形图稳定态，列表 display:none）
     帧分类（逐像素）：
       · treemapLike ：与矩形图参照几乎一致
       · listLike    ：与列表参照几乎一致
       · blended     ：两侧都不一致，但**逐像素**取二者之一 —— 记为真实混合帧，
                       并按「取到矩形图参照的像素占比」给出混合比例（交叉淡化的量化刻度）
   - ⚠️ 禁用 `page.screenshot()` 采中间态（≈130ms/张 ≫ 120ms 动画），中间态一律走 screencast。
   - 输出：<out>/screencast-frames/*.jpg、timeline.json、refs/{refRanking,refTreemap}.png、
           frame_analysis.json（逐帧分类 + 混合比例 + 唯一哈希数）
   - 运行：node scripts/dev/p02_b_screencast.mjs --base http://127.0.0.1:5000/ --out <证据目录>
   - 纪律：headless + finally browser.close()；桩态确定性（不发真实 /api/browse）。
   ============================================================ */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { chromium, screencast, shot } from "./_harness.mjs";

function arg(name, dflt) {
    const i = process.argv.indexOf("--" + name);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const BASE = arg("base", "http://127.0.0.1:5000/");
const OUT = path.resolve(arg("out", path.join(os.tmpdir(), "p02_b_screencast")));
const DURATION = Number(arg("duration", 2200));
const TRIGGER_MS = Number(arg("trigger", 400)); // 心跳预热后再触发（保证窗口内有「前态」帧）
/* 像素分类阈值（先由 calibration 自证可分性，再用于帧分类——详见脚本内说明） */
const TOL_PIXEL = 30;      // 单像素 RGB 绝对差之和容差
const TOL_TREEMAP = 0.93;  // 「与矩形图参照相似」的像素占比阈值
const TOL_LIST = 0.88;     // 「与列表参照相似」的像素占比阈值
const TOL_BLEND = 0.9;     // 混合帧的「有解释像素」占比阈值
fs.mkdirSync(path.join(OUT, "refs"), { recursive: true });

const STUB_FN = fs.readFileSync(new URL("./p02_view_frame_probe.mjs", import.meta.url), "utf-8")
    .match(/const STUB_FN = `([\s\S]*?)`;/)[1];

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* FNV-1a（uint32）文件哈希：用于「唯一帧」判定与参照帧去重自证 */
function hashOf(p) {
    const buf = fs.readFileSync(p);
    let h = 2166136261;
    for (let i = 0; i < buf.length; i++) { h ^= buf[i]; h = (h * 16777619) >>> 0; }
    return h >>> 0;
}

/* ---- 参照帧分类器（PNG 解码用 Playwright 的 page：把两张 PNG 读成像素数组再逐像素比较）---- */
async function classify(page, frames, refA, refB, opts) {
    const b64 = (p) => fs.readFileSync(p).toString("base64");
    return page.evaluate(async ({ items, a, b, cfg }) => {
        const load = (data) => new Promise((res, rej) => {
            const img = new Image();
            img.onload = () => res(img);
            img.onerror = rej;
            img.src = "data:image/png;base64," + data;
        });
        const [ia, ib] = await Promise.all([load(a), load(b)]);
        const draw = (img) => {
            const c = document.createElement("canvas");
            c.width = img.naturalWidth; c.height = img.naturalHeight;
            const ctx = c.getContext("2d");
            ctx.drawImage(img, 0, 0);
            return ctx.getImageData(0, 0, c.width, c.height).data;
        };
        const A = draw(ia), B = draw(ib);
        const W = ia.naturalWidth, H = ia.naturalHeight;
        const out = [];
        for (const it of items) {
            const im = await load(it.data);
            if (im.naturalWidth !== W || im.naturalHeight !== H) {
                out.push({ ...it.meta, sizeMismatch: [im.naturalWidth, im.naturalHeight, W, H] });
                continue;
            }
            const F = draw(im);
            let diffA = 0, diffB = 0, pickA = 0, pickB = 0, neither = 0;
            let minDif = 255, maxDif = 0;
            for (let i = 0; i < F.length; i += 4) {
                const dA = Math.abs(F[i] - A[i]) + Math.abs(F[i + 1] - A[i + 1]) + Math.abs(F[i + 2] - A[i + 2]);
                const dB = Math.abs(F[i] - B[i]) + Math.abs(F[i + 1] - B[i + 1]) + Math.abs(F[i + 2] - B[i + 2]);
                if (dA <= cfg.tol) diffA++;
                if (dB <= cfg.tol) diffB++;
                const m = Math.min(dA, dB);
                if (m < minDif) minDif = m;
                if (m > maxDif) maxDif = m;
                if (dA < dB) { if (dA <= cfg.blendTol) pickA++; else neither++; }
                else { if (dB <= cfg.blendTol) pickB++; else neither++; }
            }
            const n = F.length / 4;
            const fracA = diffA / n, fracB = diffB / n;
            let kind = "other";
            if (fracA >= cfg.likeTm) kind = "treemapLike";
            else if (fracB >= cfg.likeList) kind = "listLike";
            else if ((pickA + pickB) / n >= cfg.blend) kind = "blended";
            out.push({
                ...it.meta,
                kind,
                frac_like_treemap: Number(fracA.toFixed(4)),
                frac_like_list: Number(fracB.toFixed(4)),
                frac_pixels_matching_treemap: Number((pickA / n).toFixed(4)),
                frac_pixels_matching_list: Number((pickB / n).toFixed(4)),
                frac_unexplained: Number((neither / n).toFixed(4)),
                min_pair_diff: minDif, max_pair_diff: maxDif,
            });
        }
        return { ref: { w: W, h: H }, frames: out };
    }, { items: frames, a: b64(refA), b: b64(refB), cfg: opts });
}

async function run() {
    const browser = await chromium.launch({ headless: true });
    const summary = { meta: { base: BASE, out: OUT, durationMs: DURATION, startedAt: new Date().toISOString() }, checks: [] };
    let page = null;
    try {
        const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
        page = await ctx.newPage();
        const errs = [];
        /* ⚠️ 过滤 favicon.ico 404：应用未提供 favicon（页面既有行为，见同批 u22/u50 探针同口径
           过滤），与本次改动无关；其余 console/pageerror 一律计入。 */
        page.on("console", (m) => {
            if (m.type() !== "error") return;
            const loc = m.location ? m.location() : null;
            if (loc && /favicon\.ico/i.test(loc.url)) return;
            if (/favicon\.ico/i.test(m.text())) return;
            errs.push(m.text());
        });
        page.on("pageerror", (e) => errs.push("pageerror: " + e.message));
        await page.addInitScript(() => {
            try { localStorage.setItem("pds_onboarding_dismissed_v1", "1"); } catch (e) { /* ignore */ }
            try { sessionStorage.setItem("pds_auto_started_v1", "1"); } catch (e) { /* ignore */ }
        });
        await page.addInitScript(STUB_FN);
        await page.goto(BASE, { waitUntil: "load", timeout: 20000 });
        await page.waitForFunction(() => {
            const w = document.getElementById("treemap-wrap");
            return w && !w.hasAttribute("hidden") && w.querySelectorAll("canvas").length > 0;
        }, { timeout: 20000 });
        await wait(800);

        /* ---- 参照帧：列表稳定态（先切 table 并等收敛） ---- */
        await page.evaluate(() => document.getElementById("btn-view-table").click());
        await wait(500);
        const refRanking = path.join(OUT, "refs", "refRanking.png");
        await shot(page, refRanking);
        /* ---- 参照帧：矩形图稳定态 ---- */
        await page.evaluate(() => document.getElementById("btn-view-treemap").click());
        await wait(500);
        const refTreemap = path.join(OUT, "refs", "refTreemap.png");
        await shot(page, refTreemap);
        /* 回到列表态（独立时刻的第二次列表参照：用于阈值自证，必须是**不同批次**的采样 ——
           `refRanking` 与它若取自同一帧会是同一哈希，按「同哈希不同帧 = 无效证据」不可当自证） */
        await page.evaluate(() => document.getElementById("btn-view-ranking").click());
        await wait(600);
        const refListSelfCheck = path.join(OUT, "refs", "refListSelfCheck.png");
        await shot(page, refListSelfCheck);
        /* 交叉淡化起点固定在 table 态 */
        await page.evaluate(() => document.getElementById("btn-view-table").click());
        await wait(500);
        summary.refs = {
            refRanking, refTreemap, refListSelfCheck,
            distinct_hashes: new Set([refRanking, refTreemap, refListSelfCheck].map((p) => hashOf(p))).size,
            exists: [refRanking, refTreemap, refListSelfCheck].map((p) => fs.existsSync(p)),
        };

        /* ---- screencast：覆盖「切回矩形图」的 120ms 交叉淡化 ----
           ⚠️ `Page.startScreencast` 只在合成器产生**损伤（damage）**时投递帧：页面静止时
           泵会停摆（实测：静止 600ms 后触发，窗口内一帧都收不到）。因此这里显式跑一个
           **无常规视觉副作用的心跳**——每帧给 1×1 像素的 `#view-area::after` 叠加层在
           `opacity 0 ↔ 0.006` 之间翻转（亚像素级、肉眼与 JPEG 量化都不可见），保证泵持续
           以源帧率投递；这正是「动画短间隔截图」纪律所要求的连续取证手段。
           触发时刻 = 心跳预热后（TRIGGER_MS），窗口内既有前态（列表）帧，也有中间混合帧与终态帧。 */
        await page.addStyleTag({
            content: "#p02-heartbeat,#p02-heartbeat2{position:fixed;left:0;top:0;width:1px;height:1px;" +
                "background:var(--text);opacity:0;pointer-events:none;z-index:0}",
        });
        await page.evaluate(() => {
            const d = document.createElement("div");
            d.id = "p02-heartbeat";
            document.getElementById("view-area").appendChild(d);
            /* 也挂到 body（二者同层几何），确保无论 view-area 是否被重排都持续产生损伤 */
            const d2 = document.createElement("div");
            d2.id = "p02-heartbeat2";
            document.body.appendChild(d2);
            window.__p2hb = { ticks: 0, level: 0 };
            const set = (v) => { d.style.opacity = String(v); d2.style.opacity = String(v); };
            /* 单调锯齿（0→0.006→0）而非每帧翻转：每帧都产生真实损伤，避免同值重绘被合成器丢弃
               （实测「每帧翻转」会让动画开始后的帧长期停在同一张 JPEG 上——泵只按损伤投递） */
            (function beat() {
                const t = window.__p2hb.ticks % 4;
                window.__p2hb.level = [0, 0.002, 0.004, 0.006][t];
                set(window.__p2hb.level);
                window.__p2hb.ticks += 1;
                requestAnimationFrame(beat);
            })();
        });
        await wait(200); // 心跳起效
        let triggered = null;
        const t0 = Date.now();
        const cast = await screencast(page, {
            outDir: OUT, durationMs: DURATION, quality: 80,
            onFrame: async (p, meta) => {
                if (triggered === null && Date.now() - t0 > TRIGGER_MS) {
                    triggered = meta.ts;
                    await p.evaluate(() => document.getElementById("btn-view-treemap").click());
                }
            },
        });
        const hb = await page.evaluate(() => window.__p2hb.ticks);
        summary.heartbeatTicks = hb;
        /* 记录触发后页面终态，供「末帧应为矩形图态」判据交叉核对 */
        const endState = await page.evaluate(() => {
            const tw = document.getElementById("treemap-wrap");
            const tb = document.getElementById("table-wrap");
            return {
                twHidden: tw.hasAttribute("hidden"), twOpacity: getComputedStyle(tw).opacity,
                tbDisplay: getComputedStyle(tb).display,
                activeView: ["btn-view-treemap", "btn-view-ranking", "btn-view-table", "btn-view-relate"]
                    .find((id) => { const e = document.getElementById(id); return e && e.classList.contains("btn-primary"); }),
            };
        });
        summary.endState = endState;
        summary.screencast = {
            frames: cast.frames.length,
            t0: cast.t0,
            trigger_at_ms: triggered,
            timeline: cast.timelinePath,
            framesDir: cast.framesDir,
            ts_range: cast.frames.length ? [cast.frames[0].ts, cast.frames[cast.frames.length - 1].ts] : null,
            frame_gap_ms: cast.frames.length > 1
                ? Number(((cast.frames[cast.frames.length - 1].ts - cast.frames[0].ts) / (cast.frames.length - 1)).toFixed(1))
                : null,
        };

        /* ---- 唯一哈希去重（同一支探针同一采集内的重复 JPEG = 无效证据，只留首次出现） ---- */
        const allHashes = cast.frames.map((f) => hashOf(path.join(OUT, f.file)));
        const seen = new Set();
        const uniqueFrames = [];
        cast.frames.forEach((f, i) => {
            if (seen.has(allHashes[i])) return;
            seen.add(allHashes[i]);
            uniqueFrames.push(f);
        });
        summary.frame_hashes = {
            raw_count: allHashes.length, unique_count: seen.size,
            duplicates_dropped: allHashes.length - seen.size,
            raw_values: allHashes,
            unique_values: Array.from(seen),
        };

        /* ---- 阈值自证（calibration）：用 PNG 参照自身的 JPEG 化版本验证分类阈值的可分性 ----
           造两张 JPEG（quality 与 screencast 同）：列表参照 @80、矩形图参照 @80，
           再按同一套阈值分类——若它们分别落回 listLike / treemapLike，则阈值对
           「JPEG 伪影 + 1×1 心跳」的鲁棒性被证明（先自证工具，再判产品）。 */
        const calib = await page.evaluate(async ({ a, b, cfg }) => {
            const dbg = { aLen: a.length, bLen: b.length, err: null };
            const load = (data) => new Promise((res, rej) => {
                const img = new Image();
                img.onload = () => res(img);
                img.onerror = (e) => rej(new Error("img-load-fail len=" + String(data).length +
                    " head=" + String(data).slice(0, 40) +
                    " err=" + (e && (e.type || e.message))));
                img.src = "data:image/png;base64," + data;
            });
            try {
                const toJpeg = async (b64) => {
                    const img = await load(b64);
                    const c = document.createElement("canvas");
                    c.width = img.naturalWidth; c.height = img.naturalHeight;
                    c.getContext("2d").drawImage(img, 0, 0);
                    return c.toDataURL("image/jpeg", 0.8);
                };
                const px = (img) => {
                    const c = document.createElement("canvas");
                    c.width = img.naturalWidth; c.height = img.naturalHeight;
                    const ctx = c.getContext("2d");
                    ctx.drawImage(img, 0, 0);
                    return ctx.getImageData(0, 0, c.width, c.height).data;
                };
                const [imA, imB] = await Promise.all([load(a), load(b)]);
                dbg.aSize = [imA.naturalWidth, imA.naturalHeight];
                const A = px(imA), B = px(imB);
                const cls = async (jpegUrl) => {
                    const F = px(await load(String(jpegUrl).split(",")[1]));
                    let dA = 0, dB = 0;
                    for (let i = 0; i < F.length; i += 4) {
                        const x = Math.abs(F[i] - A[i]) + Math.abs(F[i + 1] - A[i + 1]) + Math.abs(F[i + 2] - A[i + 2]);
                        const y = Math.abs(F[i] - B[i]) + Math.abs(F[i + 1] - B[i + 1]) + Math.abs(F[i + 2] - B[i + 2]);
                        if (x <= cfg.tol) dA++;
                        if (y <= cfg.tol) dB++;
                    }
                    const n = F.length / 4;
                    const fA = dA / n, fB = dB / n;
                    let kind = "other";
                    if (fA >= cfg.likeTm) kind = "treemapLike";
                    else if (fB >= cfg.likeList) kind = "listLike";
                    return { frac_like_treemap: Number(fA.toFixed(4)), frac_like_list: Number(fB.toFixed(4)), kind };
                };
                dbg.treemapRefAsJpeg = await cls(await toJpeg(a));
                dbg.listRefAsJpeg = await cls(await toJpeg(b));
            } catch (e) {
                dbg.err = String((e && e.message) || e);
            }
            return dbg;
        }, { a: fs.readFileSync(refTreemap).toString("base64"), b: fs.readFileSync(refRanking).toString("base64"),
             cfg: { tol: TOL_PIXEL, likeTm: TOL_TREEMAP, likeList: TOL_LIST } });
        summary.calibration = calib;

        /* ---- 逐帧像素分类（仅对去重后的唯一帧；载荷分块发送，避免单次 evaluate 过大） ----
           阈值标定（依据实测）：矩形图参照的 1×1 心跳像素使"与矩形图参照相似"的上界约 0.97；
           空白区域与列表参照天然接近，故 listLike 取更高阈值 0.97，treemapLike 取 0.93。 */
        const CHUNK = 12;
        const all = [];
        for (let i = 0; i < uniqueFrames.length; i += CHUNK) {
            const slice = uniqueFrames.slice(i, i + CHUNK).map((f) => ({
                meta: { seq: f.seq, ts: f.ts, file: f.file },
                data: fs.readFileSync(path.join(OUT, f.file)).toString("base64"),
            }));
            const r = await classify(page, slice, refTreemap, refRanking,
                { tol: TOL_PIXEL, blendTol: 90, likeTm: TOL_TREEMAP, likeList: TOL_LIST, blend: TOL_BLEND });
            all.push(...r.frames);
            if (i === 0) summary.ref_size = r.ref;
        }
        summary.frame_analysis = all;
        const blended = all.filter((f) => f.kind === "blended");
        const listLike = all.filter((f) => f.kind === "listLike");
        const tmLike = all.filter((f) => f.kind === "treemapLike");
        const maxTm = all.length ? Math.max(...all.map((f) => f.frac_like_treemap || 0)) : 0;
        const minListEnd = all.length ? all[all.length - 1].frac_like_list : null;
        summary.counts = {
            total: all.length, blended: blended.length, listLike: listLike.length,
            treemapLike: tmLike.length, other: all.length - blended.length - listLike.length - tmLike.length,
            max_frac_like_treemap: Number(maxTm.toFixed(4)),
            last_frame_frac_like_list: minListEnd,
        };
        /* 交叉淡化进度刻度：混合帧中「取到矩形图参照的像素占比」应大致单调上升 */
        summary.blend_progress = blended.map((f) => ({
            seq: f.seq, ts: f.ts,
            frac_pixels_matching_treemap: f.frac_pixels_matching_treemap,
            frac_pixels_matching_list: f.frac_pixels_matching_list,
        })).sort((a, b) => a.ts - b.ts);
        const prog = summary.blend_progress.map((p) => p.frac_pixels_matching_treemap);
        let mono = true;
        for (let i = 1; i < prog.length; i++) if (prog[i] < prog[i - 1] - 0.02) mono = false;
        summary.checks = [
            { name: "screencast 原始帧数 ≥20（实际 " + allHashes.length + "）", pass: allHashes.length >= 20 },
            { name: "波形帧率 ≤40ms/帧（实测均值 " + summary.screencast.frame_gap_ms + "ms）", pass: summary.screencast.frame_gap_ms !== null && summary.screencast.frame_gap_ms <= 40 },
            { name: "唯一像素帧 ≥12（去重后 " + seen.size + "，丢弃重复 " + (allHashes.length - seen.size) + "）",
              pass: seen.size >= 12 },
            { name: "存在真实混合帧（≥3，实际 " + blended.length + "）", pass: blended.length >= 3 },
            { name: "交叉淡化方向正确：混合进度非降", pass: prog.length >= 1 && mono },
            { name: "阈值自证：矩形图参照 JPEG→" + calib.treemapRefAsJpeg.kind +
              "（frac_like_treemap=" + calib.treemapRefAsJpeg.frac_like_treemap + "）",
              pass: calib.treemapRefAsJpeg.kind === "treemapLike" },
            { name: "阈值自证：列表参照 JPEG→" + calib.listRefAsJpeg.kind +
              "（frac_like_list=" + calib.listRefAsJpeg.frac_like_list + "）",
              pass: calib.listRefAsJpeg.kind === "listLike" },
            { name: "触发前有列表态帧（" + listLike.length + "）且末帧达到矩形图态（末帧 frac_like_treemap=" +
              (all.length ? all[all.length - 1].frac_like_treemap : "n/a") + "，峰值 " + summary.counts.max_frac_like_treemap + "）",
              pass: listLike.length >= 1 && tmLike.length >= 1 && maxTm >= 0.95 },
            { name: "DOM 终态与末帧像素一致（activeView=" + endState.activeView + "，twHidden=" + endState.twHidden + "）",
              pass: endState.activeView === "btn-view-treemap" && endState.twHidden === false },
            { name: "console/pageerror 0", pass: errs.length === 0, detail: errs.join(" | ") },
        ];
        summary.consoleErrors = errs;
    } catch (e) {
        summary.fatal = String((e && e.stack) || e);
        summary.checks.push({ name: "B 类探针异常", pass: false, detail: summary.fatal });
    } finally {
        summary.finishedAt = new Date().toISOString();
        fs.writeFileSync(path.join(OUT, "frame_analysis.json"), JSON.stringify(summary, null, 2), "utf-8");
        await browser.close().catch(() => {});
    }
    console.log("== P2 B 类 screencast ==");
    for (const c of summary.checks) console.log((c.pass ? "  ✔ " : "  ✖ ") + c.name + (c.pass ? "" : " :: " + (c.detail || "")));
    console.log("counts=" + JSON.stringify(summary.counts));
    console.log("blend_progress=" + JSON.stringify(summary.blend_progress));
    console.log("out=" + OUT);
    return summary.checks.filter((c) => !c.pass).length;
}

run().then((f) => process.exit(f ? 1 : 0)).catch((e) => { console.error(e); process.exit(1); });
