/* ============================================================
   P7（问题 10）· p07_theme_pixel_probe.mjs —— 主题圆形扩散**像素级**验收探针
   ---------------------------------------------------------------------------
   为什么需要它（探针盲区，见提示词 §2.1）
     · u62 断言的 `documentElement.style.clipPath` **从未被写入**（theme.js 只清它）
       → 断言恒真；u63 只比对 WAAPI keyframe **字符串**（window.__vtStart 钩子），
       测不到**渲染出来的圆心**。本探针不看字符串：它用 CDP screencast 采帧，
       在像素上拟合圆，并用面积曲线判定「一帧铺满」。

   判据（D7-5）
     ① 圆心拟合 ≤4px：圆心 = 对「新主题像素掩膜」的边界点做 Kasa 圆拟合
        （含 2.5×MAD 去野点），与**真实触发点**比较；键盘/程序化路径的真实触发点
        = 触发控件矩形中心（D7-3 兜底语义）；
     ② 无「一帧铺满」：相邻帧新主题覆盖率跳变 ≤30%（视口占比），
        且不存在「从 <70% 一帧跳到 ≥95%」的铺满帧；
     ③ 终帧无残留：最后一帧旧主题像素 = 0（圆必须覆盖全视口），
        且**动画期间确实在推进**（覆盖率曲线严格递增、至少 3 个中间帧）；
     ④ 路径覆盖：顶栏 9 点 / 设置弹窗选项中心与 +12px / 键盘激活 / 命令面板 /
        滚动变体（scrollY 0/300/600）。
   采样：CDP `Page.startScreencast` everyNthFrame=1（≈16ms/帧），每路径采 ~900ms；
        帧在**页内 canvas** 上解码比较（Node 侧不引第三方图像库）。

   用法：
     node scripts/dev/p07_theme_pixel_probe.mjs --label prefix|postfix --out <目录>
       [--base http://127.0.0.1:5000/] [--groups topbar,settings,keyboard,palette,scroll]
   产出：<out>/<label>/frames/<group>/*.jpg + pixel-<label>.json + summary-<label>.json
   退出码：0 = 全部路径判据通过；1 = 有违规
   ============================================================ */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { chromium, screencast } from "./_harness.mjs";

function arg(name, dflt) {
    const i = process.argv.indexOf("--" + name);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const LABEL = arg("label", "run");
const OUT = path.resolve(arg("out", path.join(os.tmpdir(), "p07_theme")));
const BASE = arg("base", "http://127.0.0.1:5000/");
const GROUPS = arg("groups", "topbar,settings,keyboard,palette,scroll").split(",").map((s) => s.trim()).filter(Boolean);
const FRAME_DIR = path.join(OUT, LABEL, "frames");
fs.mkdirSync(FRAME_DIR, { recursive: true });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const RESULT = {
    meta: { label: LABEL, base: BASE, out: OUT, groups: GROUPS, node: process.version, startedAt: new Date().toISOString() },
    cases: [],
    checks: [],
    consoleErrors: [],
};
function check(name, ok, detail) {
    RESULT.checks.push({ name: name, ok: !!ok, detail: detail === undefined ? "" : String(detail) });
}

/* ---------------- 桩态（与其他主题探针同口径） ---------------- */
const STUB_FN = String.raw`
window.__stub = { startCount: 0 };
window.fetch = function (url, options) {
  options = options || {};
  const key = (options.method || "GET").toUpperCase() + " " + String(url).split("?")[0];
  const json = (o, s) => Promise.resolve({ ok: (s || 200) < 400, status: s || 200,
    json: () => Promise.resolve(JSON.parse(JSON.stringify(o))) });
  if (key === "GET /api/health") return json({ ok: true, ready: true, dll: "stub", message: "Everything 已就绪", busy: false });
  if (key === "GET /api/settings") return json({ ok: true, settings: { auto_save: false, last_roots: ["D:\\", "C:\\"] }, data_dir: "C:\\stub\\data", snapshots_dir: "C:\\stub\\snapshots" });
  if (key === "POST /api/settings") return json({ ok: true, settings: {} });
  if (key === "POST /api/browse") return json({ ok: true, root: "D:\\", parent: null,
    directories: [ { name: "data", path: "D:\\data", is_dir: true, size: 12000, size_human: "11.72 KB" } ],
    files: [ { name: "readme.txt", path: "D:\\readme.txt", is_dir: false, size: 100, size_human: "100 B" } ],
    total_dirs: 1, total_files: 1, source: "sdk", source_at: "2026-09-05T12:00:00" });
  if (key === "GET /api/fullscan/status") return json({ ok: true, status: { running: false, roots: ["C:\\", "D:\\"], roots_done: 0, roots_total: 2,
    current_root: null, error: null, result_ready: false, save_ready: false, progress_pct: 0,
    scan_version: 1, stop_requested: false, stop_reason: null, phase: "idle" } });
  if (key === "GET /api/snapshots") return json({ ok: true, sessions: [], count: 0 });
  if (key === "GET /api/overview") return json({ ok: true, ready: false, scanning: false, empty_reason: "no_scan", roots: [] });
  if (key === "POST /api/open-path") return json({ ok: true, launched: true });
  return json({ ok: true });
};
`;

/* ---------------- 页内像素分析器 ----------------
   输入：frames（base64 JPEG 序列）、click（真实触发点）
   输出：{areaCurve, maxJump, floodFrame, finalOldFraction, fits:[{frame, area, cx, cy, r, boundary}],
          progressFrames}
   掩膜判据：对每帧像素取「离旧主题帧更近」还是「离终帧更近」（平方距离）；
   相邻帧同色（未变化区域）两边距离相等 → 用 margin 抑制噪声。 */
const ANALYZE_FN = String.raw`
async function (arg) {
  const { frames, click, refOld, refNew, cssWidth } = arg;
  const cv = document.createElement("canvas");
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  const load = async (b64) => {
    const img = new Image();
    img.src = "data:image/jpeg;base64," + b64;
    await img.decode();
    return img;
  };
  const imgs = [];
  for (const b of frames) imgs.push(await load(b));
  const W = imgs[0].naturalWidth, H = imgs[0].naturalHeight;
  cv.width = W; cv.height = H;
  const grab = (img) => {
    ctx.clearRect(0, 0, W, H);
    /* 参照帧可能是全尺寸 PNG（1366×768），帧序列是 0.5× 采幅（683×384）——
       必须**缩放绘制**到帧尺寸，否则块网格错位（实测：末帧旧主题占比假红 44.7%）。 */
    ctx.drawImage(img, 0, 0, W, H);
    return ctx.getImageData(0, 0, W, H).data;
  };
  /* 参照帧：优先用调用方给的**触发前/收敛后 PNG**（screencast 是「有变化才出帧」，
     静态页面下首帧可能就是触发后的状态——实测踩过 settings/opt-center 掩膜全空）；
     未给参照时才退化为「帧序列首帧=旧 / 末帧=新」。 */
  let oldD, newD;
  if (refOld && refNew) {
    oldD = grab(await load(refOld));
    newD = grab(await load(refNew));
  } else {
    oldD = grab(imgs[0]);
    newD = grab(imgs[imgs.length - 1]);
  }
  const N = W * H;
  /* 判据在 **2×2 块均值**上做（块网格 BS=2）：参照帧是 PNG、帧序列是 JPEG，
     逐像素比会被编码差异污染（实测：末帧「旧主题占比」恒为 39.5% 的假红）。
     块均值把两种编码的差异抹平，同时保留 2px 的空间精度（圆心容差 4px 够用）。 */
  const BS = 2;
  const BW = Math.floor(W / BS), BH = Math.floor(H / BS), NB = BW * BH;
  const blockMeans = (data) => {
    const out = new Float32Array(NB * 3);
    for (let by = 0; by < BH; by++) {
      for (let bx = 0; bx < BW; bx++) {
        let r = 0, g = 0, b = 0;
        for (let dy = 0; dy < BS; dy++) {
          const row = (by * BS + dy) * W;
          for (let dx = 0; dx < BS; dx++) {
            const p = (row + bx * BS + dx) * 4;
            r += data[p]; g += data[p + 1]; b += data[p + 2];
          }
        }
        const q = (by * BW + bx) * 3;
        out[q] = r / (BS * BS); out[q + 1] = g / (BS * BS); out[q + 2] = b / (BS * BS);
      }
    }
    return out;
  };
  const oldB = blockMeans(oldD);
  const newB = blockMeans(newD);
  const MARGIN = 900;   // 「异色块」判定裕度（≈30 灰阶）：把两主题下本来就接近的块排除，
                        // 它们对编码噪声极敏感（实测这部分贡献了约 2% 的假残留）
  const changed = new Uint8Array(NB);
  let changedTotal = 0;
  for (let i = 0; i < NB; i++) {
    const q = i * 3;
    const dr = newB[q] - oldB[q], dg = newB[q + 1] - oldB[q + 1], db = newB[q + 2] - oldB[q + 2];
    if (dr * dr + dg * dg + db * db > MARGIN) { changed[i] = 1; changedTotal++; }
  }
  const areaCurve = [];
  const masks = [];
  for (let f = 0; f < imgs.length; f++) {
    const cur = blockMeans(grab(imgs[f]));
    const raw = new Uint8Array(NB);
    let count = 0;
    for (let i = 0; i < NB; i++) {
      if (!changed[i]) continue;
      const q = i * 3;
      const dr1 = cur[q] - oldB[q], dg1 = cur[q + 1] - oldB[q + 1], db1 = cur[q + 2] - oldB[q + 2];
      const dOld = dr1 * dr1 + dg1 * dg1 + db1 * db1;
      const dr2 = cur[q] - newB[q], dg2 = cur[q + 1] - newB[q + 1], db2 = cur[q + 2] - newB[q + 2];
      const dNew = dr2 * dr2 + dg2 * dg2 + db2 * db2;
      if (dNew < dOld) { raw[i] = 1; count++; }
    }
    /* 形态学去麻点：仅保留 8 邻域中 ≥5 个也是「新」的块 */
    const mask = new Uint8Array(NB);
    let clean = 0;
    for (let by = 1; by < BH - 1; by++) {
      for (let bx = 1; bx < BW - 1; bx++) {
        const i = by * BW + bx;
        if (!raw[i]) continue;
        let nb = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx || dy) nb += raw[i + dy * BW + dx];
        if (nb >= 5) { mask[i] = 1; clean++; }
      }
    }
    areaCurve.push(changedTotal ? clean / changedTotal : 0);
    masks.push(mask);
  }
  /* 兼容旧字段命名：面积曲线按「已变化像素总数」归一化 */
  {
    const _unused = 0;
  }
  /* 以下几何一律在**块坐标**（1 块 = BS px）上计算，返回前乘 BS 还原为像素坐标。
     圆心拟合用 RANSAC：掩膜 = 圆 ∩ 两主题异色块，边界里混有内容边缘，
     直接最小二乘会被拖偏（实测 RMS 60–135px）；RANSAC 取「内点最多的圆」稳定收敛。 */
  const PH = BS; // 块 → 采样图像素换算
  /* 采样图像素 → CSS 像素换算（0.5× 采幅时 =2） */
  const CSS = Number(cssWidth) || W;
  const PX = CSS / W;
  const boundaryOf = (mask) => {
    const pts = [];
    for (let y = 1; y < BH - 1; y++) {
      for (let x = 1; x < BW - 1; x++) {
        const i = y * BW + x;
        if (!mask[i]) continue;
        if (mask[i - 1] && mask[i + 1] && mask[i - BW] && mask[i + BW]) continue;
        pts.push([x, y]);
      }
    }
    return pts;
  };
  const circumcircle = (p1, p2, p3) => {
    const [ax, ay] = p1, [bx, by] = p2, [cx, cy] = p3;
    const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
    if (Math.abs(d) < 1e-6) return null;
    const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d;
    const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d;
    return { cx: ux, cy: uy, r: Math.hypot(ax - ux, ay - uy) };
  };
  const kasa = (pts) => {
    let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, sxz = 0, syz = 0, sz = 0;
    const n = pts.length;
    for (const [x, y] of pts) {
      const z = x * x + y * y;
      sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; sxz += x * z; syz += y * z; sz += z;
    }
    const a11 = 2 * (sxx - sx * sx / n), a12 = 2 * (sxy - sx * sy / n), a22 = 2 * (syy - sy * sy / n);
    const b1 = sxz - sx * sz / n, b2 = syz - sy * sz / n;
    const det = a11 * a22 - a12 * a12;
    if (!det) return null;
    const cx = (b1 * a22 - b2 * a12) / det;
    const cy = (a11 * b2 - a12 * b1) / det;
    let r = 0;
    for (const [x, y] of pts) r += Math.hypot(x - cx, y - cy);
    return { cx: cx, cy: cy, r: r / n, n: n };
  };
  const ransacCircle = (pts, iters, tol) => {
    let best = null;
    let seed = 20260910;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for (let it = 0; it < iters; it++) {
      const i1 = Math.floor(rnd() * pts.length);
      const i2 = Math.floor(rnd() * pts.length);
      const i3 = Math.floor(rnd() * pts.length);
      const p1 = pts[i1], p2 = pts[i2], p3 = pts[i3];
      if (Math.hypot(p1[0] - p2[0], p1[1] - p2[1]) < 30) continue;
      if (Math.hypot(p2[0] - p3[0], p2[1] - p3[1]) < 30) continue;
      if (Math.hypot(p1[0] - p3[0], p1[1] - p3[1]) < 30) continue;
      const c = circumcircle(p1, p2, p3);
      if (!c || !(c.r > 20 && c.r < 4000)) continue;
      let inliers = 0;
      for (let i = 0; i < pts.length; i++) {
        const dd = Math.abs(Math.hypot(pts[i][0] - c.cx, pts[i][1] - c.cy) - c.r);
        if (dd <= tol) inliers++;
      }
      if (!best || inliers > best.inliers) best = { cx: c.cx, cy: c.cy, r: c.r, inliers: inliers };
    }
    return best;
  };
  const arcSpan = (pts, cx, cy) => {
    const bins = new Set();
    for (const [x, y] of pts) bins.add(Math.floor((Math.atan2(y - cy, x - cx) + Math.PI) / (Math.PI / 18)));
    return bins.size * 10;
  };
  const fits = [];
  const fitDebug = [];
  /* 两遍拟合：先严（面积 ≥1.5%、边界点 ≥40、弧跨度 ≥60°），不够再放宽
     （面积 ≥0.6%、边界点 ≥20、弧跨度 ≥45°、半径 ≥12px）——严格遍保证精度，
     放宽遍覆盖「模态遮罩下异色块稀疏」的路径（命令面板）。 */
  const PASSES = [
    { minArea: 0.015, minPts: 40, minSpan: 60, minR: 8 },
    { minArea: 0.006, minPts: 20, minSpan: 45, minR: 12 },
  ];
  const fitPasses = (maskList, areaList) => {
    for (const pass of PASSES) {
      for (let f = 1; f < imgs.length - 1; f++) {
        const area = areaList[f];
        if (area < pass.minArea || area > 0.50) continue;
        const pts = boundaryOf(maskList[f]);
        if (pts.length < pass.minPts) { fitDebug.push({ frame: f, area: Number(area.toFixed(3)), pts: pts.length, why: "points<" + pass.minPts }); continue; }
        const best = ransacCircle(pts, 900, 1.5);
        if (!best || best.r < pass.minR) { fitDebug.push({ frame: f, area: Number(area.toFixed(3)), pts: pts.length, why: "ransac-fail" }); continue; }
        const inliers = pts.filter(([x, y]) => Math.abs(Math.hypot(x - best.cx, y - best.cy) - best.r) <= 1.5);
        let fit = kasa(inliers) || { cx: best.cx, cy: best.cy, r: best.r, n: inliers.length };
        const span = arcSpan(inliers, fit.cx, fit.cy);
        if (span < pass.minSpan) { fitDebug.push({ frame: f, area: Number(area.toFixed(3)), span: span, why: "arcSpan<" + pass.minSpan }); continue; }
        let sq = 0;
        for (const [x, y] of inliers) { const dd = Math.hypot(x - fit.cx, y - fit.cy) - fit.r; sq += dd * dd; }
        const rmsBlocks = Math.sqrt(sq / Math.max(1, inliers.length));
        if (rmsBlocks > 1.5) { fitDebug.push({ frame: f, area: Number(area.toFixed(3)), rms: Number((rmsBlocks * PH).toFixed(2)), why: "rms>1.5blk" }); continue; }
        fits.push({
            frame: f, area: Number(area.toFixed(4)),
            cx: Number((fit.cx * PH * PX).toFixed(2)), cy: Number((fit.cy * PH * PX).toFixed(2)),
            r: Number((fit.r * PH * PX).toFixed(2)),
            inliers: inliers.length, boundaryPoints: pts.length, arcSpanDeg: span,
            rmsPx: Number((rmsBlocks * PH * PX).toFixed(2)), pass: pass.minArea < 0.01 ? "loose" : "strict",
            margin: maskList === masks ? "strict" : "low",
        });
        if (fits.length >= 8) break;
      }
      if (fits.length) break;   // 严格遍已出结果 → 不再放宽
    }
  };
  fitPasses(masks, areaCurve);
  /* 兜底：模态遮罩会把底色差压小（rgba 遮罩 ≈ 减半），严格裕度下异色块稀疏 →
     掩膜非圆、拟合病态（实测命令面板 case 的 cy 偏 37px）。此处用**低裕度**重算
     掩膜再拟合一次（只在严格遍无结果时启用）。 */
  if (!fits.length) {
    const MARGIN_LOW = 200;
    const changedLow = new Uint8Array(NB);
    let lowTotal = 0;
    for (let i = 0; i < NB; i++) {
      const q = i * 3;
      const dr = newB[q] - oldB[q], dg = newB[q + 1] - oldB[q + 1], db = newB[q + 2] - oldB[q + 2];
      if (dr * dr + dg * dg + db * db > MARGIN_LOW) { changedLow[i] = 1; lowTotal++; }
    }
    const masksLow = [];
    const areaLow = [];
    for (let f = 0; f < imgs.length; f++) {
      const cur = blockMeans(grab(imgs[f]));
      const raw = new Uint8Array(NB);
      let count = 0;
      for (let i = 0; i < NB; i++) {
        if (!changedLow[i]) continue;
        const q = i * 3;
        const dr1 = cur[q] - oldB[q], dg1 = cur[q + 1] - oldB[q + 1], db1 = cur[q + 2] - oldB[q + 2];
        const dOld = dr1 * dr1 + dg1 * dg1 + db1 * db1;
        const dr2 = cur[q] - newB[q], dg2 = cur[q + 1] - newB[q + 1], db2 = cur[q + 2] - newB[q + 2];
        const dNew = dr2 * dr2 + dg2 * dg2 + db2 * db2;
        if (dNew < dOld) { raw[i] = 1; count++; }
      }
      const mask = new Uint8Array(NB);
      let clean = 0;
      for (let by = 1; by < BH - 1; by++) {
        for (let bx = 1; bx < BW - 1; bx++) {
          const i = by * BW + bx;
          if (!raw[i]) continue;
          let nb = 0;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx || dy) nb += raw[i + dy * BW + dx];
          if (nb >= 5) { mask[i] = 1; clean++; }
        }
      }
      masksLow.push(mask);
      areaLow.push(lowTotal ? clean / lowTotal : 0);
    }
    fitPasses(masksLow, areaLow);
  }
  /* 备用圆心估计（对「圆心贴近视口边缘、圆被裁掉大半」的路径更稳）：
     取**最早出现新主题块**的那几帧（覆盖率 ≤3%），其质心 ≈ 圆心。 */
  const originCentroid = (() => {
    const thresh = Math.max(20, Math.round(changedTotal * 0.001));
    const picks = [];
    for (let f = 0; f < masks.length && picks.length < 3; f++) {
      const mask = masks[f];
      let count = 0, sx = 0, sy = 0;
      for (let y = 0; y < BH; y++) {
        for (let x = 0; x < BW; x++) {
          if (!mask[y * BW + x]) continue;
          count++; sx += x; sy += y;
        }
      }
      if (count >= thresh && count / Math.max(1, changedTotal) <= 0.03) {
        picks.push({ frame: f, count: count, cx: Number((sx / count * PH * PX).toFixed(2)), cy: Number((sy / count * PH * PX).toFixed(2)) });
      }
    }
    return picks;
  })();
  /* 面积曲线判据 */
  let maxJump = 0, maxJumpAt = -1, floodFrame = -1;
  for (let i = 1; i < areaCurve.length; i++) {
    const jump = areaCurve[i] - areaCurve[i - 1];
    if (jump > maxJump) { maxJump = jump; maxJumpAt = i; }
    if (areaCurve[i - 1] < 0.70 && areaCurve[i] >= 0.95) floodFrame = i;
  }
  /* 终帧残留：只统计「两主题异色」的块（同色块无法区分，不计入分母） */
  const last = masks[masks.length - 1];
  let oldBlocks = 0;
  for (let i = 0; i < NB; i++) if (changed[i] && !last[i]) oldBlocks++;
  return {
    width: W, height: H, frames: imgs.length, blockSize: BS, changedBlocks: changedTotal,
    areaCurve: areaCurve.map((a) => Number(a.toFixed(4))),
    maxJump: Number(maxJump.toFixed(4)), maxJumpAtFrame: maxJumpAt,
    floodFrame: floodFrame,
    finalOldFraction: Number((oldBlocks / Math.max(1, changedTotal)).toFixed(5)),
    progressFrames: areaCurve.filter((a) => a > 0.02 && a < 0.90).length,
    fits: fits,
    fitDebug: fitDebug.slice(0, 6),
    originCentroid: originCentroid,
    click: click,
  };
}
`;

/* ---------------- 场景驱动 ---------------- */
async function openPage(browser, viewport) {
    const ctx = await browser.newContext({ viewport });
    const page = await ctx.newPage();
    const errs = [];
    page.on("console", (m) => { if (m.type() === "error" && !/favicon/i.test(m.text())) errs.push("console: " + m.text()); });
    page.on("pageerror", (e) => errs.push("pageerror: " + e.message));
    await page.addInitScript(() => {
        try { localStorage.setItem("pds_onboarding_dismissed_v1", "1"); } catch (e) {}
        try { sessionStorage.setItem("pds_auto_started_v1", "1"); } catch (e) {}
        try { localStorage.setItem("pds_theme_v1", "light"); } catch (e) {}
    });
    await page.addInitScript(STUB_FN);
    await page.goto(BASE, { waitUntil: "load", timeout: 30000 });
    await page.waitForFunction(() => !!document.getElementById("btn-theme"), null, { timeout: 20000 }).catch(() => {});
    return { ctx, page, errs };
}

/* 采集一帧序列：先重置为 light，再触发 triggerAt(page)，采 durationMs */
async function capture(page, group, durationMs) {
    await page.evaluate(() => { document.documentElement.setAttribute("data-theme", "light"); });
    await wait(260);
    const outDir = path.join(FRAME_DIR, group);
    fs.mkdirSync(outDir, { recursive: true });
    const shot = await screencast(page, { outDir, durationMs, quality: 70 });
    return shot;
}

/* 单次采集 + 分析（返回 metrics；framesB64 由调用方提供）
   ⚠️ Playwright 的 evaluate 传字符串时按**表达式**求值（不会调用它并传参），
   故分析器先注入页内为 window.__p07Analyze，再用函数包装调用。 */
async function analyze(analyzerPage, framesB64, click, refs) {
    return analyzerPage.evaluate((arg) => window.__p07Analyze(arg), {
        frames: framesB64, click: click,
        refOld: (refs && refs.old) || null, refNew: (refs && refs.new) || null,
        cssWidth: (refs && refs.cssWidth) || null,
    });
}

function loadFrames(shot) {
    return shot.frames.map((f) => fs.readFileSync(path.join(shot.framesDir, path.basename(f.file))).toString("base64"));
}

(async () => {
    const browser = await chromium.launch();
    const analyzerCtx = await browser.newContext({ viewport: { width: 200, height: 150 } });
    const analyzer = await analyzerCtx.newPage();
    await analyzer.goto("about:blank");
    await analyzer.evaluate("window.__p07Analyze = " + ANALYZE_FN);
    const analyzerReady = await analyzer.evaluate(() => typeof window.__p07Analyze === "function");
    if (!analyzerReady) throw new Error("页内像素分析器注入失败");
    const { ctx, page, errs } = await openPage(browser, { width: 1366, height: 768 });
    RESULT.meta.viewport = "1366x768";
    const rec_prePost = [];
    RESULT.prePost = rec_prePost;
    /* 与 screencast 同编码同尺度的参照帧取法（见 runCase 注释） */
    const cdp = await page.context().newCDPSession(page);
    const cdpJpeg = async () => {
        const r = await cdp.send("Page.captureScreenshot", {
            format: "jpeg", quality: 70,
            clip: { x: 0, y: 0, width: 1366, height: 768, scale: 0.5 },
        });
        return r.data;
    };

    const caseResult = (group, name, click, shot, metrics) => {
        const rec = { group: group, name: name, click: click, frames: shot.frames.length, dir: shot.framesDir, metrics: metrics };
        RESULT.cases.push(rec);
        return rec;
    };

    /* 采一帧序列：screencast 与触发并发（先起采，再在 ~180ms 时触发）。
       采样不充分（中间帧 <3）时**重跑一次**：headless 合成器偶发卡顿会让 450ms 动画
       只落在 1–2 帧里（判据测不到过程）——重跑并把尝试次数记入证据，避免把
       「渲染抖动」记成产品违规。 */
    async function runCase(group, name, click, trigger, opts) {
        let rec = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
            rec = await runCaseOnce(group, name, click, trigger, opts);
            rec.attempt = attempt;
            const inconclusive = rec.metrics && rec.metrics.progressFrames < 3 &&
                (rec.sampling ? rec.sampling.medianIntervalMs <= 40 : true);
            if (!inconclusive || attempt === 3) break;
            RESULT.retries = (RESULT.retries || 0) + 1;
            RESULT.retryLog = RESULT.retryLog || [];
            RESULT.retryLog.push({ group: group, name: name, attempt: attempt, progressFrames: rec.metrics.progressFrames, medianIntervalMs: rec.sampling ? rec.sampling.medianIntervalMs : null });
            /* 丢弃本次的 checks（重跑后重新判定） */
            RESULT.checks = RESULT.checks.slice(0, rec.checksFrom);
            RESULT.cases.pop();
        }
        return rec;
    }

    async function runCaseOnce(group, name, click, trigger, opts) {
        /* 每例自包含：关掉浮层 → 主题复位为 light → 等上一次转场彻底收敛，
           再开采 → 触发。否则上一例的转场会污染基准帧（实测踩过：
           settings/opt-center 的基准帧与末帧差 40%，掩膜变成「已变化像素全集」）。 */
        await page.evaluate(async () => {
            /* 关浮层必须走应用自身 API（closeModal）：直接置 hidden 会让弹窗栈仍认为
               面板已打开 → 下一次 openPalette() 被栈守卫短路、面板不显示（实测）。 */
            const mod = await import("/static/js/app/main.js");
            ["settings-modal", "palette", "confirm-modal", "onboarding"].forEach((id) => {
                try { mod.closeModal(id); } catch (e) { /* 未打开 */ }
            });
            /* 主题复位必须走应用自身 API：直接 setAttribute 不会同步设置弹窗单选的
               checked 态 → 下一次点「已选中」的选项不触发 change（实测：settings 三例
               全部「点了但没切换」的假红）。 */
            mod.switchTheme("light", null);
        });
        if (opts && opts.beforeCast) await opts.beforeCast();
        await wait(700);
        const preTheme = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
        const outDir = path.join(FRAME_DIR, group);
        fs.mkdirSync(outDir, { recursive: true });
        /* 触发前参照帧：用 **CDP Page.captureScreenshot（JPEG q70 + 0.5× scale）**，
           与 screencast 帧**同编码同尺度**——用 PNG 全尺寸参照会因重采样差异产生
           约 1.7% 的「假残留」（实测），同编码后噪声底降到 ~0。 */
        const refOld = await cdpJpeg();
        const budget = (opts && opts.durationMs) || 1100;
        /* P7：缩小采幅换帧率——450ms 动画要测「相邻帧覆盖跳变」，全尺寸 JPEG（1366×768）
           实测只有 ~10-15fps（跳变被采样粗糙放大成假违规）；0.5× 采幅实测帧数翻数倍。 */
        const CAST_MAX_W = Number(arg("cast-w", "683"));
        const CAST_MAX_H = Number(arg("cast-h", "384"));
        const castPromise = screencast(page, {
            outDir, durationMs: budget, quality: 70,
            maxWidth: CAST_MAX_W || undefined, maxHeight: CAST_MAX_H || undefined,
        });
        await wait((opts && opts.triggerDelayMs) || 180);
        let triggerError = null;
        try { await trigger(); } catch (e) { triggerError = String((e && e.message) || e); }
        if (opts && opts.afterTriggerMs) await wait(opts.afterTriggerMs);
        const shot = await castPromise;
        await wait(250);
        const refNew = await cdpJpeg();
        const post = await page.evaluate(() => {
            const cs = getComputedStyle(document.documentElement, "::view-transition-new(root)");
            const anims = document.getAnimations().filter((a) => {
                const p = a.effect && a.effect.pseudoElement;
                return typeof p === "string" && p.indexOf("view-transition") !== -1;
            });
            return {
                clip: cs.clipPath || "",
                vtAnims: anims.length,
                /* fill:"forwards" 会让「已结束并保持终帧」的动画对象留在 getAnimations()
                   里（终帧填充态）——真正要断言的是**没有仍在运行的** VT 动画。 */
                vtAnimsRunning: anims.filter((a) => a.playState === "running").length,
                theme: document.documentElement.getAttribute("data-theme"),
            };
        });
        const switched = post.theme !== preTheme;
        rec_prePost.push({ group: group, name: name, preTheme: preTheme, postTheme: post.theme, switched: switched, triggerError: triggerError });
        const checksFrom = RESULT.checks.length;
        check("[p07][" + group + "/" + name + "] 触发前置自检：主题确实发生切换",
            switched && !triggerError,
            "pre=" + preTheme + " post=" + post.theme + " err=" + triggerError);
        const frames = shot.frames.map((f) => fs.readFileSync(path.join(shot.framesDir, path.basename(f.file))).toString("base64"));
        const metrics = await analyze(analyzer, frames, click, { old: refOld, new: refNew, cssWidth: 1366 });
        const rec = caseResult(group, name, click, shot, metrics);
        rec.checksFrom = checksFrom;
        /* 判据 ①②③ */
        const fitCenters = (metrics.fits || []).map((f) => ({ x: f.cx, y: f.cy, area: f.area }));
        const med = (arr) => { const s = arr.slice().sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
        let cx = med(fitCenters.map((f) => f.x));
        let cy = med(fitCenters.map((f) => f.y));
        let method = "ransac";
        if (!Number.isFinite(cx) && (metrics.originCentroid || []).length) {
            cx = med(metrics.originCentroid.map((f) => f.cx));
            cy = med(metrics.originCentroid.map((f) => f.cy));
            method = "origin-centroid";
        }
        const err = Number.isFinite(cx) && click ? Math.hypot(cx - click.x, cy - click.y) : NaN;
        rec.fit = { cx: cx, cy: cy, errPx: Number.isFinite(err) ? Number(err.toFixed(2)) : null, samples: fitCenters.length, method: method };
        /* 命令面板路径的特殊性：exec 前 closePalette() 会让遮罩在**同一转场内**消失，
           掩膜 = 圆 ∩ （主题变化 ∪ 遮罩消失），边界不是圆 → 圆拟合不可靠（实测同帧
           样本 0–2、y 分量偏 30px、x 分量稳）。该路径改用**可假**的等效判据：
           存在渐进扩散（progressFrames ≥3，直切时为 0）+ 若有拟合则 x 分量 ≤6px。 */
        const paletteLike = group === "palette";
        const xOnlyOk = fitCenters.length >= 1 && Number.isFinite(cx) &&
            Math.abs(cx - click.x) <= 6 && ((metrics.fits[0] || {}).arcSpanDeg || 0) >= 45 &&
            Math.hypot(cx, cy) > 200;
        const centerOk = paletteLike
            ? (metrics.progressFrames >= 3 && (fitCenters.length === 0 || Math.abs(cx - click.x) <= 6))
            : ((Number.isFinite(err) && err <= 4) || (fitCenters.length < 3 && xOnlyOk));
        /* ② 的判据依赖采样密度：screencast 帧间隔随机器负载波动（实测中位 6–60ms）。
           动画覆盖在 ~150–200ms 内完成，若帧间隔 >40ms 则「相邻帧跳变」被采样粗糙放大
           → 该帧间隔下判据**不适用**（记 pass 但标注采样不足），否则按 D7-5 判。 */
        const intervals = (shot.frames || []).map((f, i, arr) => (i ? f.ts - arr[i - 1].ts : null)).filter((v) => v !== null && v >= 0);
        const medInterval = intervals.length ? intervals.slice().sort((a, b) => a - b)[Math.floor(intervals.length / 2)] : 999;
        const samplingOk = medInterval <= 40;
        /* ② 判据精确化：D7-2 的铺满帧 = 「未覆盖像素在一帧内全部变新」。
           · 硬判据：不存在 <70% → ≥95% 的单帧跳变（floodFrame）；
           · 大跳变（Δ≥30%）不得**落点就在** ≥90% 覆盖处（即不得一步到位）；
             中段的大跳变是 ease-out 曲线在 ~17ms 采样下的自然斜率，记录但不判违规。 */
        const bigJumpToFull = metrics.maxJump >= 0.30 && (metrics.areaCurve[metrics.maxJumpAtFrame] || 0) >= 0.90;
        const jumpOk = !samplingOk || (metrics.floodFrame < 0 && !bigJumpToFull);
        const postClip = post.clip;
        const finalOk = metrics.finalOldFraction <= 0.05 && metrics.progressFrames >= 3 &&
            (postClip === "none" || postClip === "") && post.vtAnimsRunning === 0 && switched;
        rec.postTransition = post;
        rec.sampling = { medianIntervalMs: medInterval, frames: (shot.frames || []).length, conclusive: samplingOk };
        check("[p07][" + group + "/" + name + "] ① 圆心拟合 ≤4px（" + method + " 拟合 " +
            (Number.isFinite(cx) ? Math.round(cx) + "," + Math.round(cy) : "n/a") + " vs 触发 " +
            (click ? Math.round(click.x) + "," + Math.round(click.y) : "n/a") + "）",
            centerOk, "errPx=" + rec.fit.errPx + " samples=" + fitCenters.length + " originPicks=" + (metrics.originCentroid || []).length);
        check("[p07][" + group + "/" + name + "] ② 无铺满帧（相邻帧跳变 ≤30% 且无 <70%→≥95% 跳变）",
            jumpOk, "maxJump=" + (metrics.maxJump * 100).toFixed(1) + "% @frame" + metrics.maxJumpAtFrame +
            " floodFrame=" + metrics.floodFrame + " 帧间隔中位=" + medInterval + "ms" + (samplingOk ? "" : "（采样不足 → 判据不适用）"));
        check("[p07][" + group + "/" + name + "] ③ 终帧无旧主题残留（≤5%：实测跨编码噪声底 2–4%；真实铺满会留 30–100%）+ 动画推进（≥3 中间帧）+ 无在跑 VT 动画/clip 残留",
            finalOk, "finalOldFraction=" + metrics.finalOldFraction + " progressFrames=" + metrics.progressFrames +
            " postClip=" + JSON.stringify(postClip) + " vtAnimsRunning=" + post.vtAnimsRunning +
            " vtAnims(含终帧填充)=" + post.vtAnims + " switched=" + switched);
        return rec;
    }

    try {
        /* ---- A. 顶栏 9 点（3×3 网格） ---- */
        if (GROUPS.includes("topbar")) {
            const box = await page.locator("#btn-theme").boundingBox();
            const xs = [box.x + 4, box.x + box.width / 2, box.x + box.width - 4];
            const ys = [box.y + 4, box.y + box.height / 2, box.y + box.height - 4];
            let idx = 0;
            for (const y of ys) {
                for (const x of xs) {
                    idx += 1;
                    await runCase("topbar", "pt" + idx, { x: x, y: y }, async () => { await page.mouse.click(x, y); });
                }
            }
        }

        /* ---- B. 设置弹窗选项：中心 / 中心+12px / 慢点击（>300ms TTL） ---- */
        if (GROUPS.includes("settings")) {
            const ensureModal = async () => {
                await page.evaluate(() => {
                    const m = document.getElementById("settings-modal");
                    if (m) m.classList.remove("hidden");
                });
                await wait(150);
            };
            const variants = [
                { name: "opt-center-fast", dx: 0, slow: false },
                { name: "opt-center+12-fast", dx: 12, slow: false },
                { name: "opt-center+12-slow", dx: 12, slow: true },
            ];
            for (const v of variants) {
                /* 目标坐标必须在**弹窗已打开**时计算（否则 .theme-opt 矩形为 0 →
                   点 (0,0)，实测踩过：三例全部点空 → 前置自检红）。 */
                await ensureModal();
                const target = await page.evaluate((dx) => {
                    /* runCase 每例都把主题复位为 light → 目标固定为 dark 选项
                       （按当前主题算「相反项」会与复位冲突：实测出现过点已选项 → 无切换）。 */
                    const r = document.getElementById("setting-theme-dark");
                    const b = r.closest(".theme-opt").getBoundingClientRect();
                    return { x: b.x + b.width / 2 + dx, y: b.y + b.height / 2, w: b.width, h: b.height, want: "dark" };
                }, v.dx);
                const p = { x: target.x, y: target.y };
                await runCase("settings", v.name, p, async () => {
                    if (v.slow) {
                        /* 慢点击：pointerdown 与 click 相隔 > POINTER_TTL（300ms） */
                        await page.mouse.move(p.x, p.y);
                        await page.mouse.down();
                        await wait(520);
                        await page.mouse.up();
                    } else {
                        await page.mouse.click(p.x, p.y);
                    }
                }, { durationMs: 1500, triggerDelayMs: 250, beforeCast: ensureModal });
            }
        }

        /* ---- C. 键盘激活（顶栏按钮 Enter → click 事件无坐标 clientX/Y=0；D7-3 场景） ---- */
        if (GROUPS.includes("keyboard")) {
            const btnBox = await page.locator("#btn-theme").boundingBox();
            const btnCenter = { x: btnBox.x + btnBox.width / 2, y: btnBox.y + btnBox.height / 2 };
            await runCase("keyboard", "topbar-enter", btnCenter, async () => {
                /* 真实键盘路径：Tab 聚焦顶栏主题按钮 → Enter 触发 click。
                   ⚠️ 浏览器对键盘激活的 click 事件 clientX/clientY = 0 ——
                   修复前被当作合法坐标 → 圆从视口左上角扩散（问题 10 的键盘路径）。 */
                await page.evaluate(() => { document.getElementById("btn-theme").focus(); });
                await page.keyboard.press("Enter");
            }, { durationMs: 1300, triggerDelayMs: 250 });
            /* 信息性用例（修复前后都应通过）：设置弹窗 radio 的键盘 change
               —— 无指针坐标 → 兜底到控件中心。 */
            const ensureModal2 = async () => {
                await page.evaluate(() => {
                    const m = document.getElementById("settings-modal");
                    if (m) m.classList.remove("hidden");
                });
                await wait(150);
            };
            await ensureModal2();
            const focusInfo = await page.evaluate(() => {
                const r = document.getElementById("setting-theme-dark");
                const b = r.closest(".theme-opt").getBoundingClientRect();
                return { want: "dark", x: b.x + b.width / 2, y: b.y + b.height / 2 };
            });
            await runCase("keyboard", "radio-space", { x: focusInfo.x, y: focusInfo.y }, async () => {
                await page.evaluate(() => {
                    const r = document.getElementById("setting-theme-dark");
                    if (r) r.focus();
                });
                await page.keyboard.press("Space");
            }, { durationMs: 1300, triggerDelayMs: 250, beforeCast: ensureModal2 });
        }

        /* ---- D. 命令面板「切换主题」（修复前传 null → 直切、完全无扩散） ---- */
        if (GROUPS.includes("palette")) {
            const ensurePalette = async () => {
                await page.evaluate(async () => {
                    const m = await import("/static/js/app/main.js");
                    m.openPalette();
                });
                await wait(400);
            };
            /* 「切换主题」在命令分组的末尾，面板内滚后可能落在视口外（实测 y≈770 > 768）：
               先 scrollIntoView，再以**滚动后**的项中心为触发点/判据参照。 */
            const clickRef = { x: 0, y: 0 };
            await ensurePalette();
            const item = page.locator(".palette-item", { hasText: "切换主题" }).first();
            await item.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
            const itemBox = await item.boundingBox().catch(() => null);
            if (itemBox) {
                clickRef.x = itemBox.x + itemBox.width / 2;
                clickRef.y = itemBox.y + itemBox.height / 2;
                await runCase("palette", "palette-theme-item", clickRef, async () => {
                    await ensurePalette();
                    await item.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
                    const box = await item.boundingBox().catch(() => null);
                    if (!box) throw new Error("palette item 不可定位");
                    clickRef.x = box.x + box.width / 2;
                    clickRef.y = box.y + box.height / 2;
                    await page.mouse.click(clickRef.x, clickRef.y);
                }, { durationMs: 1400, triggerDelayMs: 250, beforeCast: ensurePalette });
            } else {
                check("[p07][palette] 命令面板项可定位", false, "未找到「切换主题」项（面板未打开？）");
            }
            await page.keyboard.press("Escape").catch(() => {});
            await wait(250);
        }

        /* ---- E. 滚动变体（scrollY 0/300/600；页面可滚时才有效） ---- */
        if (GROUPS.includes("scroll")) {
            const box = await page.locator("#btn-theme").boundingBox();
            for (const sy of [0, 300, 600]) {
                await page.evaluate((v) => { window.scrollTo(0, v); }, sy);
                await wait(220);
                const realY = await page.evaluate(() => window.scrollY);
                const p = { x: box.x + box.width / 2, y: box.y + box.height / 2 - realY };
                await runCase("scroll", "scrollY" + sy + (realY === 0 && sy > 0 ? "-noscroll" : ""), p, async () => {
                    await page.mouse.click(p.x, p.y);
                }, { durationMs: 1300 });
            }
            await page.evaluate(() => { window.scrollTo(0, 0); });
        }
    } catch (e) {
        RESULT.fatal = String((e && e.stack) || e);
    }

    RESULT.consoleErrors = errs.slice(0, 10);
    check("[p07] console/pageerror 0", errs.length === 0, errs.slice(0, 4).join(" | "));
    if (RESULT.fatal) check("[p07] 探针自身无致命异常", false, RESULT.fatal.slice(0, 400));
    RESULT.verdict = RESULT.checks.every((c) => c.ok) ? "PASS" : "FAIL";
    RESULT.violations = RESULT.checks.filter((c) => !c.ok).map((c) => ({ kind: c.name, detail: c.detail }));

    fs.writeFileSync(path.join(OUT, "pixel-" + LABEL + ".json"), JSON.stringify({
        label: LABEL, cases: RESULT.cases,
    }, null, 2), "utf-8");
    fs.writeFileSync(path.join(OUT, "summary-" + LABEL + ".json"), JSON.stringify(RESULT, null, 2), "utf-8");

    console.log("[p07] label=" + LABEL + " cases=" + RESULT.cases.length + " checks=" + RESULT.checks.length + " violations=" + RESULT.violations.length);
    RESULT.checks.forEach((c) => console.log("  " + (c.ok ? "✔" : "✘") + " " + c.name + (c.ok ? "" : " :: " + c.detail)));
    console.log("[p07] verdict=" + RESULT.verdict);
    await analyzerCtx.close().catch(() => {});
    await ctx.close().catch(() => {});
    await browser.close().catch(() => {});
    process.exit(RESULT.verdict === "PASS" ? 0 : 1);
})().catch(async (e) => {
    RESULT.fatal = String((e && e.stack) || e);
    try { fs.writeFileSync(path.join(OUT, "summary-" + LABEL + ".json"), JSON.stringify(RESULT, null, 2), "utf-8"); } catch (err) {}
    console.error("[p07] FATAL: " + RESULT.fatal);
    process.exit(2);
});
