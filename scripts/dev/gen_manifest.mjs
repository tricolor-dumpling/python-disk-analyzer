/* 生成 p00/manifest.json —— 逐项证据清单（绝对路径/用途/采样节奏/时间窗/量化摘要）。
   命令：node scripts/dev/gen_manifest.mjs --out <证据根>/manifest.json */
import fs from "node:fs";
import path from "node:path";
import { arg } from "./_harness.mjs";

const ROOT = path.resolve(arg("root", "D:/deepseek/python-disk-analyzer/docs/问题核查资料_20260908/p00"));
const OUT = path.resolve(arg("out", path.join(ROOT, "manifest.json")));

function load(p) {
    try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { return null; }
}
function abs(p) {
    return path.resolve(p).replace(/\\/g, "/");
}

const manifest = {
    phase: "P0 视觉验收证据清单",
    root_abs: abs(ROOT),
    generated_at: new Date().toISOString(),
    env: {
        base: "http://127.0.0.1:5000/",
        viewport_default: "1366x768",
        chromium: "C:/Users/Laptop/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe",
    },
    evidence_groups: [],
};

/* ---- frame_recorder: DOM 帧（rAF） ---- */
const fr = path.join(ROOT, "frame_recorder");
const frSum = load(path.join(fr, "summary.json"));
const frWorst = frSum && frSum.worst ? frSum.worst : null;
manifest.evidence_groups.push({
    key: "frame_recorder_dom",
    tool: "scripts/dev/p00_frame_recorder.mjs",
    purpose: "问题2 视图切换残留（排行→关系）—— DOM 轨：页内 rAF 逐帧记录 #treemap-wrap 的 hidden/opacity/elementFromPoint 归属",
    sampling: "rAF ≈16.7ms/帧；采样窗=触发前~100ms→动画全程+200ms收尾（本轮最差轮 88 帧）",
    criteria: "违规帧=非活动视图期间 #treemap-wrap 无 hidden 且 opacity>0 且 elementFromPoint 落回 treemap-canvas/wrap 内（与 P2-视图切换帧级证据.json 同口径）",
    vs_p2_baseline: {
        p2_rank2relate: { frames: 63, badFrames: 9, firstBad_op: "1", firstBad_hit: "treemap-canvas" },
        this_rank2relate: frWorst ? { round: frWorst.round, frames: frWorst.domFrames, badFrames: frWorst.badFrames, domBadOff_ms: frWorst.domBadOff } : null,
        sem: "帧数与违规帧数同量级、首违规特征一致（opacity=1 命中 treemap）→ DOM 轨硬闸门通过",
    },
    judge: "Luna 二轮：DOM 量化记录有效（与 P2 门禁口径一致），与像素轨互相印证；DOM 违规窗口 [11,144]ms 像素可辨残留始于 +78ms（合成器滞后使 DOM 状态早于可见像素）",
    files: [
        { path: abs(path.join(fr, "frames.json")), desc: "最差轮全部 DOM 帧（含 hidden/opacity/hit/inTm/activeView/acts/ts）" },
        { path: abs(path.join(fr, "summary.json")), desc: "逐轮帧数/违规帧数/首末违规偏移 + 双时钟对齐锚点 + 像素帧计数" },
        { path: abs(path.join(fr, "terminal-relate.png")), desc: "终态静态图（page.screenshot ≈130ms/张，仅观感，不含时间戳命名，不作帧级证据）" },
    ],
});

/* ---- frame_recorder: 像素帧（CDP screencast，与 DOM 轨同序列同步） ---- */
const frSc = path.join(fr, "screencast");
const frScTl = load(path.join(frSc, "px-timeline.json"));
const frScH = load(path.join(frSc, "px-hashes.json")) || {};
const frScFiles = [];
if (fs.existsSync(frSc)) {
    for (const f of fs.readdirSync(frSc).filter((x) => /\.jpg$/i.test(x)).sort()) {
        frScFiles.push(abs(path.join(frSc, f)));
    }
}
const frVw = path.join(fr, "violation-window");
const frVwFiles = [];
if (fs.existsSync(frVw)) {
    for (const f of fs.readdirSync(frVw).filter((x) => /\.jpg$/i.test(x)).sort()) {
        frVwFiles.push(abs(path.join(frVw, f)));
    }
}
const frInWin = (frScTl && frScTl.frames) ? frScTl.frames.filter((f) => f.inWin).length : null;
const frUniqueH = new Set(Object.values(frScH)).size;
manifest.evidence_groups.push({
    key: "frame_recorder_pixel",
    tool: "scripts/dev/p00_frame_recorder.mjs（复用 _harness.screencast）",
    purpose: "问题2 像素级证据—— CDP Page.startScreencast 在同一轮序列内同步采集像素帧，相对触发点时间戳与 DOM 轨对齐；违规窗口内帧单独标记",
    sampling: "CDP screencast 实测平均 ~30–46ms/帧（本机负载相关）；时窗=触发前~100ms→动画+200ms 收尾",
    alignment: "DOM ts=page perf-now - rec.start；px ts=CDP ts - t0；触发锚点 pagePerfAtClick/nodeWallAtClick 双时钟就近读取（偏差 ~1-3ms）；off(frame)=ts-(pagePerfAtClick-recStart)；off(px)=px.ts-(nodeWallAtClick-t0)；违规窗口=[首,末]off ±5ms",
    dom_violation_window_ms: (frScTl && frScTl.meta && frScTl.meta.domBadOff) || null,
    quantitative: {
        pixel_frames: frScFiles.length,
        pixel_hash_unique_total: (Object.keys(frScH).length ? frUniqueH + "/" + Object.keys(frScH).length : null),
        violation_window_pixels: frVwFiles.length,
        in_window_unique: frScTl && frScTl.frames ? new Set((frScTl.frames || []).filter((f) => f.inWin).map((f) => frScH[f.file])).size : null,
    },
    note: "像素证据采用 CDP screencast 而非 page.screenshot（≈130ms/张无法覆盖 33ms 级违规窗口）；文件名 px-<seq>-trig+<off>ms.jpg 的 off 为相对触发点真实偏移；对齐差异（须知）：+11/+28ms 两帧像素与触发前基线帧相同（合成器滞后），即 DOM 状态变化早于可见像素，像素级可辨识残留始于 +78ms",
    judge: "Luna 二轮 PASS（硬闸门成立）：violation-window 8 帧逐张确认 +78/+80ms 起可见大片彩色 treemap 矩形压在目录/关系区域上，随后 +94/+107/+123/+137ms 逐步变淡，与 frames.json twOpacity 递减（1→…→2.45e-06）及窗口 [11,144]ms 一致；上下文帧（-71…-17ms 无残留、+153…+183ms 残留消失）吻合",
    files: [
        { path: abs(path.join(frSc, "px-timeline.json")), desc: "像素帧相对触发点时间戳 + inWin 标记 + 违规窗口 meta" },
        { path: abs(path.join(frSc, "px-hashes.json")), desc: "每张像素帧 SHA-256 自证（unique/total）" },
        ...frScFiles.map((p) => ({ path: p, desc: "CDP screencast 像素帧（相对触发点真实 ts）" })),
        ...frVwFiles.map((p) => ({ path: p, desc: "违规窗口内像素帧副本（问题2 像素级残留证据）" })),
    ],
});

/* ---- theme_screencast ---- */
const ts = path.join(ROOT, "theme_screencast");
const tsMeta = load(path.join(ts, "meta.json"));
const tsBri = load(path.join(ts, "brightness.json")) || [];
const tsArea = load(path.join(ts, "area.json")) || [];
const tsFrames = [];
if (fs.existsSync(path.join(ts, "screencast-frames"))) {
    for (const f of fs.readdirSync(path.join(ts, "screencast-frames")).filter((x) => x.endsWith(".jpg")).sort()) {
        tsFrames.push(abs(path.join(ts, "screencast-frames", f)));
    }
}
const tsCircles = load(path.join(ts, "circle_fit.json"));
const tsFits = (tsCircles && tsCircles.frames) ? tsCircles.frames.filter((f) => f.fit) : [];
const tsDev = tsFits.map((f) => parseFloat(f.fit.dev_from_click_px)).filter((x) => !Number.isNaN(x));
manifest.evidence_groups.push({
    key: "theme_screencast",
    tool: "scripts/dev/p00_theme_screencast.mjs",
    purpose: "问题10 主题扩散—— CDP Page.startScreencast 逐帧像素 + 亮度/暗区面积曲线 + 点击坐标 + 每帧圆拟合（顶栏 #btn-theme 触发 light→dark）",
    sampling: "CDP screencast 实测平均 ~30–46ms/帧（本机负载相关）；时窗 1800ms 覆盖 450ms 扩散 + 收尾；ts 单调不减",
    ts_policy: "ts 单调不减（按 seq 稳定序 + 单调夹取）；rawTs=CDP metadata 原始推算值保留核对；clamped 见 timeline.json meta",
    quantitative: {
        frames: tsMeta ? tsMeta.frames : null,
        clickCoord: tsMeta ? tsMeta.clickCoord : null,
        startTheme: tsMeta ? tsMeta.startTheme : null,
        endTheme: tsMeta ? tsMeta.endTheme : null,
        switched: tsMeta ? tsMeta.switched : null,
        brightness_range: tsBri.length ? [tsBri[0].brightness, tsBri[tsBri.length - 1].brightness] : null,
        darkFrac_range: tsArea.length ? [tsArea[0].darkFrac, tsArea[tsArea.length - 1].darkFrac] : null,
        circle_fit: tsFits.length ? {
            fitted_frames: tsFits.length,
            dev_from_click_px_min: tsDev.length ? Math.min(...tsDev) : null,
            dev_from_click_px_max: tsDev.length ? Math.max(...tsDev) : null,
            dev_from_click_px_mean: tsDev.length ? +(tsDev.reduce((a, b) => a + b, 0) / tsDev.length).toFixed(2) : null,
            valid_range: (tsCircles && tsCircles.meta && tsCircles.meta.valid_range) ? tsCircles.meta.valid_range : null,
            limitation: (tsCircles && tsCircles.meta && tsCircles.meta.limitation) ? tsCircles.meta.limitation : null,
            judge: "|圆心−点击坐标|≤4px（计划4.3-4）。Luna 二轮：圆心视觉位于右上点击区≈(995,30)，与 radial_rms_px 一致；但 radial_rms 以点击点为固定圆心，非独立圆心估计 → 条件性接受（P0 只产出数字与区间，独立圆心估计归 P7）",
            darkFrac_saturation: "darkFrac≥0.95（ts≥495）后拟合半径饱和 529-531px，几何上不可能覆盖 97.6% 视口 → 边界检测后期失效，valid_range 收窄为 ts 221–439（见 valid_range）",
        } : null,
        darkFrac_transition_sample: tsArea.length ? tsArea.find((x) => x.darkFrac > 0.1 && x.seq > 8) || null : null,
    },
    judge: "Luna 二轮：扩散平滑/无触底跳变 PASS；圆心条件性接受（视觉位于右上点击区，radial_rms 88/88≤4px，但非独立圆心估计）→ 独立圆心拟合+覆盖角度分布+底部触底关键帧由 P7 补；问题10 键盘/命令面板/设置慢点击三路径圆心缺陷属 P7",
    files: [
        { path: abs(path.join(ts, "timeline.json")), desc: "每帧 seq/ts/rawTs/文件相对路径（ts 单调不减）" },
        { path: abs(path.join(ts, "brightness.json")), desc: "整页灰度均值归一化曲线" },
        { path: abs(path.join(ts, "area.json")), desc: "暗区(灰度<128)像素占比曲线" },
        { path: abs(path.join(ts, "circle_fit.json")), desc: "每帧暗区边界圆拟合（center/radius/radial_rms=dev_from_click_px/点击坐标偏差）" },
        { path: abs(path.join(ts, "meta.json")), desc: "start/end theme、clickCoord、console 错误、帧数" },
        ...tsFrames.map((p) => ({ path: p, desc: "CDP screencast 逐帧 JPEG" })),
    ],
});

/* ---- viewport_shots ---- */
const vs = path.join(ROOT, "viewport_shots");
const vsMeta = load(path.join(vs, "meta.json"));
const vsShots = (vsMeta && vsMeta.shots) || [];
manifest.evidence_groups.push({
    key: "viewport_shots",
    tool: "scripts/dev/p00_viewport_shots.mjs",
    purpose: "C 类多视口静态截图：工作台/对比/快照 × 1366×768/1440×900/1920×1080，作为后续阶段布局对照基线",
    sampling: "每态 1 张；page.screenshot(≈130ms/张) 仅用于静态终态",
    quantitative: { shots: vsShots.length, viewports: (vsMeta && vsMeta.viewports) || null },
    judge: "Luna 二轮：9/9 PASS（三视口×三页局部布局基线，无硬切/重叠/溢出）；问题4「扫描中右栏纵向挤压」观察无法在 P0 证据中定位（结构性原因：P0 三探针均未触发扫描，右栏恒为待机/浏览态，非扫描态；动态拥挤截图归 P3）",
    files: vsShots.map((s) => ({ path: abs(s.file), desc: (s.label || s.page) + " " + s.viewport + " 全页截图" })),
});

/* ---- fixtures ---- */
const fx = path.join(ROOT, "fixtures");
const fxv = load(path.join(fx, "fixture_validation.json"));
manifest.evidence_groups.push({
    key: "fixtures",
    tool: "scripts/dev/fixture_snapshots.mjs",
    purpose: "P0-4 三类隔离夹具参数化验证（growth/flat/series）",
    sampling: "静态数据；由项目自身模块 load_snapshot/compare_snapshots/list_sessions 校验",
    quantitative: fxv ? { load_ok: fxv.validation.load_snapshot_ok, growth_deltas: fxv.validation.growth, flat_all_zero: fxv.validation.flat.all_zero, series_totals: fxv.validation.series.D_root_totals, session_list: fxv.validation.session_list } : null,
    judge: "数据层校验（非视觉），无需 Luna",
    files: [{ path: abs(path.join(fx, "fixture_validation.json")), desc: "三类夹具生成与项目模块校验结果" }],
});

/* ---- baseline ---- */
const bl = path.join(ROOT, "baseline");
manifest.evidence_groups.push({
    key: "baseline",
    tool: "P0-2 门禁实测 + P0-3 工具链自证",
    purpose: "门禁基线表（命令/数字/耗时/结论）与 smoke A1、favicon 404 两类环境挂账登记",
    files: [{ path: abs(path.join(bl, "gate_baseline.json")), desc: "P0-2 门禁基线表（含环境实测、test_budget 竞态、smoke 20/21 A1 说明、探针跑通）" }],
});

fs.writeFileSync(OUT, JSON.stringify(manifest, null, 2), "utf-8");
const imgs = manifest.evidence_groups
    .filter((g) => /^frame_recorder_|^theme_screencast|^viewport_shots/.test(g.key))
    .flatMap((g) => g.files).filter((f) => /\.(png|jpg)$/i.test(f.path));
const uniqueImgs = new Set(imgs.map((f) => f.path));
console.log("manifest written:", OUT);
console.log("image_entries:", imgs.length, "image_unique:", uniqueImgs.size);
console.log("evidence_groups:", manifest.evidence_groups.length);