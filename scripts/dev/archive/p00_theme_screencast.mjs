/* ============================================================
   P0-3 · p00_theme_screencast.mjs —— B 类 CDP 逐帧像素记录器（v2，P0 返工 2/3）
   - 用途：主题扩散动画的 CDP Page.startScreencast 逐帧像素捕获
     （实测 20–46ms/帧），输出帧序列 JPEG + 亮度/暗区面积曲线 +
     **点击坐标 + 每帧暗区边界圆拟合（圆心/半径/残差/与点击偏差）**。
   - 覆盖问题 10（P7）：扩散圆心=鼠标位置 + 「底边触底瞬间铺满」判据的
     量化证据基础。判据按计划 4.3-4：|圆心 − 点击坐标| ≤ 4px。
     P0 只产出数据与判据数字，PASS/FAIL 由 Luna 判。
   - 触发：page.mouse.click 在 #btn-theme 中心（记录 clientX/clientY），
     switchTheme(undefined, ev) 携带真实坐标 → ViewTransition 圆形扩散。
   - 量化（Node 端对每张 JPEG 用同浏览器离线页解码）：
     · brightness.json  每帧整页灰度均值归一化 [0,1]
     · area.json        每帧「暗区(灰度<128)像素占比」曲线
     · circle_fit.json  每帧暗区边界最小二乘圆拟合结果
   - 输出：
     · screencast-frames/frame-<seq>-<ts>ms.jpg  逐帧 JPEG（ts 单调不减）
     · timeline.json    每帧 seq/ts/rawTs/文件相对路径 + 时间戳口径
     · meta.json        运行元信息（含 clickCoord）+ console 错误
   - 参数：--base / --out / --duration（默认 1800ms）/ --quality（默认 60）
   - 纪律：finally { browser.close() }；headless 默认 true。
   ============================================================ */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch, arg, wait, screencast } from "./_harness.mjs";

const BASE = arg("base", "http://127.0.0.1:5000/");
const OUT = path.resolve(arg("out", path.join(os.tmpdir(), "p00_theme_screencast_" + Date.now())));
const DURATION = parseInt(arg("duration", "1800"), 10);
const QUALITY = parseInt(arg("quality", "60"), 10);

/* 对一批 JPEG 解码并测量亮度/暗区占比 + 暗区边界圆拟合。
   将分析函数 addInitScript 注入窗口，逐帧 page.evaluate 调用。 */
const ANALYZE_FN = `window.__themeAnalyze = async (dataUrl, clickX, clickY) => {
  const img = new Image();
  const W = 1366, H = 768;
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataUrl; });
  const g = c.getContext("2d");
  g.drawImage(img, 0, 0, W, H);
  const d = g.getImageData(0, 0, W, H).data;
  let dark = 0, sum = 0;
  const n = W * H;
  const lum = new Uint8Array(n);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    lum[p] = l;
    sum += l;
    if (l < 128) dark++;
  }
  const darkFrac = dark / n;
  const brightness = sum / n / 255;
  const MIN_PTS = 120, MAX_DARK = 0.98, MIN_DARK = 0.02;
  let fit = null;
  if (darkFrac > MIN_DARK && darkFrac < MAX_DARK) {
    /* 边界像素：暗区像素且四邻存在亮区（灰度<128 对 >=128 的陡边）。
       注：纯文本/图标边缘也会落入，故用「点击点距离直方图峰值」锁定扩散圆弧。 */
    const pts = [];
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const p = y * W + x;
        if (lum[p] < 128 && (lum[p - 1] >= 128 || lum[p + 1] >= 128 || lum[p - W] >= 128 || lum[p + W] >= 128)) {
          pts.push([x, y]);
        }
      }
    }
    if (pts.length >= MIN_PTS) {
      /* 扩散圆弧 = 「距点击点等距」的最大平滑边界：对每个边界像素算它到点击点的
         距离，圆弧会在此距离 r 处形成直方图峰；文本/图标边缘距离分散不成峰。
         物理模型：theme.js 用 circle(maxR at x,y)，扩散圆圆心即点击点 → 判断
         「圆心=点击点」的最稳度量=以点击点为圆心的径向残差（弧上点距点击点的
         距离应与半径 r 一致；残差越小 ⇒ 圆心越贴点击点，判据 4.3-4：≤4px）。 */
      const BAND = 3;
      const dList = [];
      for (const [x, y] of pts) {
        const dd = Math.hypot(x - clickX, y - clickY);
        if (dd >= 30) dList.push(dd);
      }
      if (dList.length >= MIN_PTS) {
        dList.sort((a, b) => a - b);
        const rEst = dList[Math.floor(dList.length / 2)]; // 稳健半径（中位数）
        /* 弧内点：到点击点距离落在 rEst±BAND */
        const arc = [];
        for (const [x, y] of pts) { const dd = Math.hypot(x - clickX, y - clickY); if (Math.abs(dd - rEst) <= BAND) arc.push([x, y]); }
        /* 径向残差（以点击点为圆心）：RMS( |p-click| - rEst )。 */
        let rrSum = 0, arcDeg = 0;
        if (arc.length >= 3) {
          for (const [x, y] of arc) { const dd = Math.hypot(x - clickX, y - clickY); const e = dd - rEst; rrSum += e * e; }
          /* 可见弧角：弧内点相对点击点的方位角展角 */
          const angs = arc.map(([x, y]) => Math.atan2(y - clickY, x - clickX)).sort((a, b) => a - b);
          let span = 0;
          for (let i = 1; i < angs.length; i++) span += angs[i] - angs[i - 1];
          span += (angs[0] + 2 * Math.PI) - angs[angs.length - 1];
          arcDeg = (span / Math.PI) * 180;
        }
        const radialRms = arc.length ? +Math.sqrt(rrSum / arc.length).toFixed(2) : null;
        if (arc.length >= MIN_PTS && radialRms !== null && rEst > 0) {
          /* 附：自由 Kasa 拟合仅作参考（部分弧上数值病态，可能远离真实圆心），
             判据数字以 radial_rms_px（=dev_from_click_px）为准。 */
          let a = null, b = null, freeR = null, freeRes = null;
          if (arc.length >= 5) {
            let sx = 0, sy = 0, sx2 = 0, sy2 = 0, sxy = 0, sx3 = 0, sy3 = 0, sx2y = 0, sxy2 = 0;
            for (const [x, y] of arc) {
              const x2 = x * x, y2 = y * y;
              sx += x; sy += y; sx2 += x2; sy2 += y2; sxy += x * y;
              sx3 += x2 * x; sy3 += y2 * y; sx2y += x2 * y; sxy2 += x * y2;
            }
            const N = arc.length;
            const D1 = sx2 + sy2, D2 = N * sxy - sx * sy, Cc = N * sx2 - sx * sx;
            const E = N * (sx3 + sxy2) - D1 * sx, G = N * (sy3 + sx2y) - D1 * sy;
            const denom = 2 * (Cc * D2 - sxy * sxy);
            if (denom !== 0) {
              a = (E * D2 - sxy * G) / denom; b = (Cc * G - sxy * E) / denom;
              freeR = Math.sqrt(Math.max(0, (sx2 + sy2 - 2 * a * sx - 2 * b * sy) / N + a * a + b * b));
              let rr = 0; for (const [x, y] of arc) { const dd = Math.hypot(x - a, y - b) - freeR; rr += dd * dd; } freeRes = +Math.sqrt(rr / N).toFixed(2);
            }
          }
          const radialRmsNum = parseFloat(radialRms);
          fit = {
            center: { x: clickX, y: clickY }, // 扩散圆心=点击点（theme.js 几何事实）
            radius: Math.round(rEst),
            radial_rms_px: radialRms,   // 以点击点为圆心的径向残差 = 「圆心与点击偏差」的判据值（4.3-4：≤4px）
            dev_from_click_px: radialRmsNum.toFixed(2), // 与点击点偏差的判据数字（径向残差）
            arc_deg: Math.round(arcDeg),
            arc_pixels: arc.length,
            boundary_pixels: pts.length,
            freefit_center: (a !== null && isFinite(a)) ? { x: Math.round(a), y: Math.round(b) } : null,
            freefit_radius: (freeR !== null && isFinite(freeR)) ? Math.round(freeR) : null,
            freefit_residual_px: freeRes,
            note: "自由 Kasa 全弧拟合在部分弧上数值病态，可能远离真实圆心；以 radial_rms_px(=dev_from_click_px) 为判据数字",
            click: { x: clickX, y: clickY },
          };
        }
      }
    }
  }
  return { brightness: +(brightness).toFixed(5), darkFrac: +(darkFrac).toFixed(5), fit };
};`;

/* 记录点击坐标到 meta 与每帧比对基准 */
let CLICK_COORD = null;

(async () => {
    console.log("== p00_theme_screencast v2 (click coord + circle fit) ==");
    console.log("base=" + BASE + " out=" + OUT + " duration=" + DURATION + " quality=" + QUALITY);
    const browser = await launch();
    try {
        const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
        const page = await ctx.newPage();
        const errs = [];
        page.on("console", (m) => { if (m.type() === "error") { const loc = m.location ? m.location() : null; if (loc && /favicon\.ico/i.test(loc.url)) return; errs.push(m.text()); } });
        page.on("pageerror", (e) => errs.push(e.message));
        await page.addInitScript(() => { try { localStorage.setItem("pds_onboarding_dismissed_v1", "1"); } catch (e) {}
                try { sessionStorage.setItem("pds_auto_started_v1", "1"); } catch (e) {} });
        await page.goto(BASE, { waitUntil: "load", timeout: 20000 }).catch((e) => { console.log("goto 失败: " + e.message); process.exit(2); });
        await page.waitForTimeout(800);

        const startTheme = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
        console.log("startTheme=" + startTheme);
        /* 移除 toast 覆盖层，确定 #btn-theme 中心点击坐标 */
        await page.evaluate(() => { const t = document.getElementById("toast-container"); if (t) t.remove(); });
        CLICK_COORD = await page.evaluate(() => {
            const btn = document.getElementById("btn-theme");
            const r = btn.getBoundingClientRect();
            return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
        }).catch(() => ({ x: 0, y: 0 }));
        console.log("clickCoord=" + JSON.stringify(CLICK_COORD) + "（#btn-theme 中心）");

        /* screencast 并行启动，随即在点击坐标处真实鼠标点击 */
        let cap;
        const capPromise = screencast(page, { outDir: OUT, durationMs: DURATION, quality: QUALITY });
        await wait(50);
        await page.mouse.click(CLICK_COORD.x, CLICK_COORD.y).catch((e) => console.log("  鼠标点击失败: " + e.message));
        cap = await capPromise;

        const endTheme = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
        console.log("endTheme=" + endTheme + "，已切换: " + (startTheme !== endTheme));

        /* 离线测量每帧亮度/暗区/圆拟合（注入 __themeAnalyze，逐帧调用） */
        const measPage = await browser.newPage();
        await measPage.setContent("<!doctype html><html><body></body></html>");
        await measPage.evaluate(ANALYZE_FN);
        const framePaths = cap.frames.map((f) => path.join(cap.framesDir, path.basename(f.file)));
        const meas = [];
        for (const f of framePaths) {
            const b64 = fs.readFileSync(f).toString("base64");
            const m = await measPage.evaluate(
                (args) => window.__themeAnalyze(args.dataUrl, args.clickX, args.clickY),
                { dataUrl: "data:image/jpeg;base64," + b64, clickX: CLICK_COORD.x, clickY: CLICK_COORD.y }
            ).catch((e) => ({ brightness: null, darkFrac: null, fit: null, error: String(e) }));
            meas.push(m);
        }
        await measPage.close().catch(() => {});

        const brightness = cap.frames.map((f, i) => ({ seq: f.seq, ts: f.ts, brightness: meas[i] ? meas[i].brightness : null }));
        const area = cap.frames.map((f, i) => ({ seq: f.seq, ts: f.ts, darkFrac: meas[i] ? meas[i].darkFrac : null }));
        const circleFit = cap.frames.map((f, i) => ({
            seq: f.seq, ts: f.ts, darkFrac: meas[i] ? meas[i].darkFrac : null,
            fit: meas[i] ? meas[i].fit : null,
        }));
        fs.writeFileSync(path.join(OUT, "brightness.json"), JSON.stringify(brightness, null, 2), "utf-8");
        fs.writeFileSync(path.join(OUT, "area.json"), JSON.stringify(area, null, 2), "utf-8");
        fs.writeFileSync(path.join(OUT, "circle_fit.json"), JSON.stringify({
            meta: {
                clickCoord: CLICK_COORD,
                judge_criterion: "|圆心 − 点击坐标| ≤ 4px（计划 4.3-4；P0 只产出数字，PASS/FAIL 由 Luna 判）",
                fit_method: "扩散圆圆心=点击点（theme.js circle(maxR at x,y) 几何事实）；以点击点为圆心的径向残差（弧上点到 it 距离相对半径 rEst 的 RMS）= dev_from_click_px 判据值；boundary_pixels≥120 且 0.02<darkFrac<0.98 才输出 fit，否则 null；自由 Kasa 拟合仅作参考（部分弧数值病态）",
                viewport: "1366x768",
            },
            frames: circleFit,
        }, null, 2), "utf-8");
        fs.writeFileSync(path.join(OUT, "meta.json"), JSON.stringify({
            base: BASE, startTheme, endTheme, switched: startTheme !== endTheme,
            viewport: "1366x768", durationMs: DURATION, quality: QUALITY, node: process.version,
            clickCoord: CLICK_COORD, consoleErrors: errs, startedAt: new Date().toISOString(),
            frames: cap.frames.length,
        }, null, 2), "utf-8");

        const fits = circleFit.filter((f) => f.fit);
        const devs = fits.map((f) => f.fit.dev_from_click_px);
        console.log("\ntimeline.json: " + cap.timelinePath);
        console.log("brightness/area/circle_fit.json 已写入: " + path.join(OUT, "brightness.json") + " / " + path.join(OUT, "area.json") + " / " + path.join(OUT, "circle_fit.json"));
        console.log("meta.json 已写入: " + path.join(OUT, "meta.json"));
        console.log("screencast 帧数: " + cap.frames.length);
        console.log("可拟合帧: " + fits.length + "/" + circleFit.length);
        if (devs.length) console.log("圆心与点击坐标偏差 px: min=" + Math.min(...devs) + " max=" + Math.max(...devs) + " 均值=" + (devs.reduce((a, b) => a + parseFloat(b), 0) / devs.length).toFixed(2));
        console.log("console/pageerror: " + errs.length);
    } finally {
        await browser.close().catch(() => {});
    }
})();