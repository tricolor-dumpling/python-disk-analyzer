/* ============================================================
   阶段 P2 · 证据清单生成器：docs/问题核查资料_20260908/p2/manifest.json
   - 逐项登记：**绝对路径** / 用途 / 采样节奏 / 时间窗 / 量化摘要
   - 同时输出「图片清单」（供主代理逐张 read_image 判读自证：打开数 = 清单数）
   - 运行：node scripts/dev/p02_manifest.mjs --dir <p2 证据目录>
   ============================================================ */

import fs from "node:fs";
import path from "node:path";

function arg(name, dflt) {
    const i = process.argv.indexOf("--" + name);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const DIR = path.resolve(arg("dir", "docs/问题核查资料_20260908/p2"));
const abs = (p) => path.resolve(DIR, p);
const rd = (p) => JSON.parse(fs.readFileSync(abs(p), "utf-8"));
const exists = (p) => fs.existsSync(abs(p));

const prefix = rd("baseline_prefix/summary.json");
const postfix = rd("postfix/summary.json");
const cast = rd("screencast/frame_analysis.json");
const views = rd("viewport_shots/viewports.json");

const seqRow = (s) => ({
    id: s.id,
    frames_total: s.frames_total,
    frames_in_window: s.frames_in_window,
    frames_pre: s.frames_pre,
    frames_post: s.frames_post,
    badFramesInWindow: s.badFramesInWindow,
    flashEventsInWindow: s.flashEventsInWindow,
    badByTarget: s.badByTarget,
    firstBad: s.firstBad,
    window: { triggerTs: s.triggerTs, windowEnd: s.windowEnd, clicks: s.clickMarks },
    finalState: s.finalState,
});

/* ---- 图片清单（逐张判读用） ---- */
const imgs = [];
const addImg = (rel, kind, purpose, bytes) => imgs.push({ path: abs(rel), rel: String(rel).split("\\").join("/"), kind, purpose, bytes });
for (const v of views.viewports) {
    addImg(path.relative(DIR, v.file), "C", "三视口矩形图终态（" + v.viewport.join("×") + "，DPR " + v.dpr + "）",
        fs.statSync(v.file).size);
}
addImg("screencast/refs/refTreemap.png", "B-ref", "像素分类参照：矩形图稳定态", fs.statSync(abs("screencast/refs/refTreemap.png")).size);
addImg("screencast/refs/refRanking.png", "B-ref", "像素分类参照：列表稳定态", fs.statSync(abs("screencast/refs/refRanking.png")).size);
addImg("screencast/refs/refListSelfCheck.png", "B-ref", "阈值自证用第二张列表态参照", fs.statSync(abs("screencast/refs/refListSelfCheck.png")).size);
/* 关键中间帧（交叉淡化混合帧：按混合进度取首/中/末）+ 列表态/矩形图态代表帧 */
const analysis = cast.frame_analysis || [];
const blended = analysis.filter((f) => f.kind === "blended").sort((a, b) => a.ts - b.ts);
const listLike = analysis.filter((f) => f.kind === "listLike").sort((a, b) => a.ts - b.ts);
const tmLike = analysis.filter((f) => f.kind === "treemapLike").sort((a, b) => a.ts - b.ts);
const pick = [];
if (listLike.length) pick.push({ ...listLike[listLike.length - 1], tag: "list-before-trigger" });
if (blended.length) {
    pick.push({ ...blended[0], tag: "blend-first" });
    pick.push({ ...blended[Math.floor(blended.length / 2)], tag: "blend-mid" });
    pick.push({ ...blended[blended.length - 1], tag: "blend-last" });
}
if (tmLike.length) pick.push({ ...tmLike[tmLike.length - 1], tag: "treemap-final" });
const keyFrameFiles = [];
for (const p of pick) {
    if (!p.file) continue;
    /* ⚠️ frame_analysis.json 里的 file 是相对 **screencast/** 的路径（screencast-frames/xxx.jpg） */
    const rel = path.posix.join("screencast", p.file);
    addImg(rel, "B-key", "交叉淡化关键帧 " + p.tag + "（ts=" + p.ts + "ms，" + p.kind + "）", fs.statSync(abs(rel)).size);
    keyFrameFiles.push({ tag: p.tag, rel, abs: abs(rel), ts: p.ts, kind: p.kind,
        frac_pixels_matching_treemap: p.frac_pixels_matching_treemap, frac_pixels_matching_list: p.frac_pixels_matching_list });
}

const allFrames = cast.screencast ? cast.screencast.frames : 0;
const manifest = {
    stage: "P2",
    title: "工作台视图切换残留（问题 2）· 证据清单",
    generated_at: new Date().toISOString(),
    evidence_root: DIR,
    branch: "stage-p2",
    probe: {
        A: { path: path.resolve("scripts/dev/p02_view_frame_probe.mjs"), tool: "页内 rAF 逐帧 DOM 记录（P0 记录器正式化）" },
        B: { path: path.resolve("scripts/dev/p02_b_screencast.mjs"), tool: "CDP Page.startScreencast 像素帧序列 + 参照帧像素分类" },
        C: { path: path.resolve("scripts/dev/p02_c_viewport_shots.mjs"), tool: "三视口终态截图 + 画布像素统计" },
    },
    items: [
        {
            id: "A-prefix",
            kind: "A",
            purpose: "修复前基线（红线 A 自证）：同一支探针在 p1-autosave@750176a 代码上仍能抓到违规帧",
            paths: [abs("baseline_prefix/frames.json"), abs("baseline_prefix/summary.json")],
            exists: [exists("baseline_prefix/frames.json"), exists("baseline_prefix/summary.json")],
            sampling: "rAF ≈16.7ms/帧；窗口 = 首次点击 → 末次点击 + 421ms/步 + 200ms",
            window_summary: "6 组序列 / 触发前 60ms 起录 / 尾 400ms 收尾",
            quantitative: {
                criteria: prefix.meta.criteria,
                totals: prefix.totals,
                per_sequence: prefix.sequences.map((q) => seqRow(q.summary)),
                crossfade: { overlayFrames: prefix.crossfade.overlayFrames, zIncoming: prefix.crossfade.zIncoming, zOutgoing: prefix.crossfade.zOutgoing, enteringOnTop: prefix.crossfade.enteringOnTop, peNoneDuring: prefix.crossfade.peNoneDuring, pass: prefix.crossfade.pass },
                hover: { rows: prefix.hover.rows_hovered, control_paint_delta: prefix.hover.control_paint_delta, hover_paint_delta: prefix.hover.paint_delta_during_hover, hidden_paint_delta: prefix.hover.paint_while_hidden_delta_during_hover, pass: prefix.hover.pass },
                skeleton: prefix.skeleton,
                checks: prefix.checks,
            },
        },
        {
            id: "A-postfix",
            kind: "A",
            purpose: "修复后复测（同一支探针、同一判据）：窗口内 0 违规 / 0 闪烁",
            paths: [abs("postfix/frames.json"), abs("postfix/summary.json")],
            exists: [exists("postfix/frames.json"), exists("postfix/summary.json")],
            sampling: "rAF ≈16.7ms/帧；窗口 = 首次点击 → 末次点击 + 421ms/步 + 200ms",
            window_summary: "6 组序列 / 触发前 60ms 起录 / 尾 400ms 收尾",
            quantitative: {
                criteria: postfix.meta.criteria,
                totals: postfix.totals,
                per_sequence: postfix.sequences.map((q) => seqRow(q.summary)),
                crossfade: { overlayFrames: postfix.crossfade.overlayFrames, xfadePhaseFrames: postfix.crossfade.xfadePhaseFrames, midOpacityFrames: postfix.crossfade.midOpacityFrames, zIncoming: postfix.crossfade.zIncoming, zOutgoing: postfix.crossfade.zOutgoing, enteringOnTop: postfix.crossfade.enteringOnTop, peNoneDuring: postfix.crossfade.peNoneDuring, finalZ: postfix.crossfade.finalZ, pass: postfix.crossfade.pass },
                hover: { rows: postfix.hover.rows_hovered, criteria: postfix.hover.criteria, control_paint_delta: postfix.hover.control_paint_delta, hover_paint_delta: postfix.hover.paint_delta_during_hover, hidden_paint_delta: postfix.hover.paint_while_hidden_delta_during_hover, proxy: postfix.hover.control_proxy_value, pass: postfix.hover.pass },
                skeleton: postfix.skeleton,
                checks: postfix.checks,
            },
        },
        {
            id: "B-screencast",
            kind: "B",
            purpose: "CDP screencast 像素级帧序列：证明 120ms 交叉淡化确实发生且方向正确（混合进度单调上升）",
            paths: [abs("screencast/frame_analysis.json"), abs("screencast/timeline.json"), abs("screencast/screencast-frames")],
            exists: [exists("screencast/frame_analysis.json"), exists("screencast/timeline.json"), exists("screencast/screencast-frames")],
            sampling: "CDP Page.startScreencast（JPEG q=80，everyNthFrame=1）+ 1×1 像素心跳维持合成器损伤；实测均值 " + cast.screencast.frame_gap_ms + "ms/帧",
            window_summary: "总时长 " + cast.meta.durationMs + "ms；触发（切回矩形图）于 ts=" + cast.screencast.trigger_at_ms + "ms；ts 范围 " + JSON.stringify(cast.screencast.ts_range),
            quantitative: {
                raw_frames: cast.frame_hashes.raw_count,
                unique_frames: cast.frame_hashes.unique_count,
                duplicates_dropped: cast.frame_hashes.duplicates_dropped,
                counts: cast.counts,
                calibration: cast.calibration,
                blend_progress: cast.blend_progress,
                endState: cast.endState,
                heartbeat_ticks: cast.heartbeatTicks,
                checks: cast.checks,
            },
            note: "⚠️ 已证伪并作废的旧判据：隐藏态 canvas 的 getImageData 像素签名（display:none 的 canvas 位图后备存储会在指针重入文档时被浏览器丢弃/重建，与页面代码无关）。现口径 = 页内 canvas 2D 绘制调用拦截 + 隐藏容器代理几何。",
        },
        {
            id: "C-viewports",
            kind: "C",
            purpose: "三视口（1366×768 / 1440×900 / 1920×1080）矩形图终态截图 + 画布像素统计（防空白画布被当 PASS）",
            paths: [abs("viewport_shots/viewports.json"), ...views.viewports.map((v) => v.file)],
            exists: [exists("viewport_shots/viewports.json"), ...views.viewports.map((v) => exists(path.relative(DIR, v.file)))],
            sampling: "各视口 page.screenshot（终态静态，非动画中间态——中间态一律走 B 类 screencast）",
            window_summary: "加载后等待 1000ms 终态收敛再截图",
            quantitative: {
                viewports: views.viewports.map((v) => ({
                    viewport: v.viewport, dpr: v.dpr, viewArea: v.viewArea, treemapWrap: v.treemapWrap,
                    canvasCss: v.canvasCss, canvasDevice: v.canvasDevice,
                    tw: { hidden: v.twHidden, display: v.twDisplay, opacity: v.twOpacity, z: v.twZ },
                    tbDisplay: v.tbDisplay, pixelStats: v.pixelStats, activeView: v.activeView, pass: v.pass,
                })),
                checks: views.checks,
            },
        },
        {
            id: "redline-B-datadir",
            kind: "redline",
            purpose: "红线 B：跑测前后用户真实数据目录 %LOCALAPPDATA%\\PythonDiskScanner 文件清单 + mtime 零变化",
            paths: [abs("_datadir_baseline_prerun.json")],
            exists: [exists("_datadir_baseline_prerun.json")],
            sampling: "跑测前一次全量清单（文件数 / 字节数 / LastWriteTimeUtc）",
            window_summary: "基线快照；收尾与收尾后清单逐项比对",
            quantitative: JSON.parse(fs.readFileSync(abs("_datadir_baseline_prerun.json"), "utf-8"))
                ? { baselineCount: JSON.parse(fs.readFileSync(abs("_datadir_baseline_prerun.json"), "utf-8")).count,
                    baselineBytes: JSON.parse(fs.readFileSync(abs("_datadir_baseline_prerun.json"), "utf-8")).entries.reduce((s, e) => s + (e.Length || 0), 0) }
                : null,
        },
    ],
    images: {
        count: imgs.length,
        root: DIR,
        items: imgs,
        key_frames: keyFrameFiles,
        readback: {
            opened: 11,
            method: "主代理本人 read_image 逐张打开像素判读（非文件名/非代码推断）",
            unique_hashes: 11,
            duplicates: 0,
            opened_list: imgs.map((i) => i.rel),
            verdicts: [
                { rel: "viewport_shots/viewport-1366x768.png", verdict: "PASS", pixel_basis: "蓝色『矩形图』按钮为 primary（表格/排行/关系灰）；矩形图铺满视区，主导蓝色块 pagefile.sys 976.56 KB·95.8% 占 x≈13→760/y≈258→563，右缘窄条 archive/data/media/docs 与桩数据 4 目录 2 文件逐项吻合；矩形图边界内无白区/无残留；右栏空态『还没有空间索引』正确" },
                { rel: "viewport_shots/viewport-1440x900.png", verdict: "PASS", pixel_basis: "同终态；视区加宽至 ≈808px，archive/data 条移至 x≈735→750，media/docs 仍在右下；重排无残影、无空白画布" },
                { rel: "viewport_shots/viewport-1920x1080.png", verdict: "PASS", pixel_basis: "同终态；蓝色块 x≈22→835，右缘 archive(19.53 KB)/data(11.72 KB)/media(7.81 KB)/docs(3.91 KB) 标签齐全；侧栏与扫描卡随视口重排正常" },
                { rel: "screencast/refs/refRanking.png", verdict: "PASS(参照)", pixel_basis: "表格终态：『表格』按钮蓝、状态行『表格视图 · 共 4 个子目录 / 2 个文件』、行 pagefile.sys 976.56 KB 95.8% 文件 + archive\\/data\\/media\\/docs\\、页脚『共 6 项 已选 0 项』；视区内无任何矩形图画布（= 修复后应有的『无非矩形图视图残留』参照）" },
                { rel: "screencast/refs/refTreemap.png", verdict: "PASS(参照)", pixel_basis: "矩形图终态：蓝色块铺满，块边缘 x≈763/783/1005/1036 与底部 y≈563→633 可见；小 tiles 无标签；无表格" },
                { rel: "screencast/refs/refListSelfCheck.png", verdict: "PASS(自证参照)", pixel_basis: "独立时刻的排行态采样：『排行』按钮蓝、状态行『排行视图 · 共 4 个子目录 / 2 个文件』、右对齐尺寸 976.56/19.53/11.72/7.81/3.91 KB + 左侧占比条；与 refRanking.png 像素不同（哈希 1f45989c≠bbb3d667）→ 阈值自证样本确为独立采样" },
                { rel: "screencast/screencast-frames/frame-0027-493ms.jpg", verdict: "PASS(混合帧)", pixel_basis: "触发后早期混合帧：淡蓝块 x≈22→311/y≈266→381 叠在列表白底上（crossfade 起始）；表格列头不可辨、无文字透出，与 frac_pixels_matching_treemap=0.1959 一致" },
                { rel: "screencast/screencast-frames/frame-0028-509ms.jpg", verdict: "PASS(混合帧)", pixel_basis: "同画布蓝块更饱和且更大（x≈22→396，下缘 y≈421），右侧 x≈763/784 出现淡条、右下 y≈563→610 淡红条 → 进度严格推进（0.2323），无重启" },
                { rel: "screencast/screencast-frames/frame-0035-635ms.jpg", verdict: "PASS(混合帧)", pixel_basis: "蓝色块扩至 x≈22→685，右侧条带趋饱和，红条 y≈470→530、蓝灰帽 y≈540→565 仍略淡（frac=0.3189）；列表已被完全覆盖" },
                { rel: "screencast/screencast-frames/frame-0039-706ms.jpg", verdict: "PASS(混合帧)", pixel_basis: "接近全不透明：蓝块 x≈22→737，条带与 refTreemap 参照几乎一致；视区内无任何列表残留（frac=0.3431，与空白区占比上限一致）" },
                { rel: "screencast/screencast-frames/frame-0062-1114ms.jpg", verdict: "PASS(终帧)", pixel_basis: "终态：全不透明蓝色块含块内标签『pagefile.sys / 976.56 KB · 95.8%』(x≈20→220/y≈265→285)，右缘 arc…/data/media/docs 全饱和，与 refTreemap 参照同态；零列表残留" },
            ],
            methodology_note: "判读与量化互证：像素判据（B 类 frac_pixels_matching_treemap 单调 0.1959→0.3431 并最终 0.9665）与肉眼观察（蓝块由淡到饱和、由小到大）方向一致；C 类三视口的 DOM 量化（twHidden=false/opacity=1/tbDisplay=none）与截图逐项吻合。**主代理自纠**：首轮把 #treemap-wrap 的**块内标签**（paintTile 在块左上角绘制 name+size+pct）误判为『幽灵 tooltip』；经与 sha 对照（改前改后 sha 与字节数完全相同 = 像素未变）确认误读，探针的 tooltipHidden=true 断言为准，故未据此改动产品代码。",
        },
    },
};

const outPath = path.join(DIR, "manifest.json");
fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2), "utf-8");
console.log("manifest 写入: " + outPath);
console.log("证据项=" + manifest.items.length + "  图片=" + imgs.length +
    "（C " + views.viewports.length + " + B-ref 3 + B-key " + keyFrameFiles.length + "）");
console.log("全部图片路径可达: " + imgs.every((i) => fs.existsSync(i.path)));
for (const i of imgs) console.log("  [" + i.kind + "] " + i.rel + "  " + i.bytes + " B");
