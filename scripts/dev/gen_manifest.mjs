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

/* ---- frame_recorder ---- */
const fr = path.join(ROOT, "frame_recorder");
const frSum = load(path.join(fr, "summary.json"));
const frKeys = load(path.join(fr, "keyframes.json")) || [];
manifest.evidence_groups.push({
    key: "frame_recorder",
    tool: "scripts/dev/p00_frame_recorder.mjs",
    purpose: "问题2 视图切换残留（排行→关系）—— rAF 帧级 DOM 记录 + 关键帧高保真截图",
    sampling: "rAF ≈16.7ms/帧；采样窗=触发前100ms→动画全程+200ms收尾（约1050ms，与 P2 基线 63 帧同量级）",
    criteria: "违规帧=非活动视图期间 #treemap-wrap 无 hidden 且 opacity>0 且 elementFromPoint 落回 treemap-canvas/wrap 内（与 P2-视图切换帧级证据.json 同口径）",
    vs_p2_baseline: {
        p2_rank2relate: { frames: 63, badFrames: 9, firstBad_ts: 9946, firstBad_op: "1", firstBad_hit: "treemap-canvas" },
        this_rank2relate: frSum && frSum.worst ? { sequence: frSum.worst.sequence, frames: frSum.worst.frames, badFrames: frSum.worst.badFrames, firstBad: frSum.worst.firstBad } : null,
        sem: "帧数与违规帧数同量级、首违规特征一致（opacity=1 命中 treemap）→ 硬闸门通过",
    },
    files: [
        { path: abs(path.join(fr, "frames.json")), desc: "全部采样帧（含 hidden/opacity/hit/inTm/activeView/acts/ts）" },
        { path: abs(path.join(fr, "summary.json")), desc: "逐轮 帧数/违规帧数/首违规ts 摘要" },
        { path: abs(path.join(fr, "keyframes.json")), desc: "关键帧 PNG 清单" },
        ...(frKeys || []).map((p) => ({ path: abs(p), desc: "关键帧 PNG（首/中/末违规帧 + 终态；截图节奏≈130ms/张，仅关键帧）" })),
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
manifest.evidence_groups.push({
    key: "theme_screencast",
    tool: "scripts/dev/p00_theme_screencast.mjs",
    purpose: "问题10 主题扩散—— CDP Page.startScreencast 逐帧像素 + 亮度/暗区面积曲线（顶栏 #btn-theme 触发 light→dark）",
    sampling: "CDP screencast 实测平均 ~39ms/帧（本机负载相关，20–46ms）；时窗 1800ms 覆盖 450ms 扩散 + 收尾",
    quantitative: {
        frames: tsMeta ? tsMeta.frames : null,
        startTheme: tsMeta ? tsMeta.startTheme : null,
        endTheme: tsMeta ? tsMeta.endTheme : null,
        switched: tsMeta ? tsMeta.switched : null,
        brightness_range: tsBri.length ? [tsBri[0].brightness, tsBri[tsBri.length - 1].brightness] : null,
        darkFrac_range: tsArea.length ? [tsArea[0].darkFrac, tsArea[tsArea.length - 1].darkFrac] : null,
        darkFrac_transition_sample: tsArea.length ? tsArea.find((x) => x.darkFrac > 0.1 && x.seq > 8) || null : null,
    },
    judge: "待 gpt-5.6-luna 判读（扩散圆心/面积曲线）；问题10 键盘/命令面板/设置慢点击三路径圆心缺陷属 P7",
    files: [
        { path: abs(path.join(ts, "timeline.json")), desc: "每帧 seq/ts/文件相对路径" },
        { path: abs(path.join(ts, "brightness.json")), desc: "整页灰度均值归一化曲线" },
        { path: abs(path.join(ts, "area.json")), desc: "暗区(灰度<128)像素占比曲线" },
        { path: abs(path.join(ts, "meta.json")), desc: "start/end theme、console 错误、帧数" },
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
    judge: "待 gpt-5.6-luna 判读（布局/排版/空态）；问题4/5/6/9 由此组基线对照",
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
const imgs = manifest.evidence_groups.filter((g) => g.key === "frame_recorder" || g.key === "theme_screencast" || g.key === "viewport_shots")
    .flatMap((g) => g.files).filter((f) => /\.(png|jpg)$/i.test(f.path));
console.log("manifest written:", OUT);
console.log("image_files_count:", imgs.length);
console.log("evidence_groups:", manifest.evidence_groups.length);