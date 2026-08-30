/* ============================================================
   UI 2.0（SpaceLens Pro）· viz/treemap.js（U2.2 建，U2.3 扩展）
   - layoutSquaried(items,x,y,w,h)：Bruls squarified 布局**纯函数**
     （零 DOM，node --test 可测；面积守恒/宽高比/单块/空输入用例见
     scripts/dev/treemap.test.mjs）；
   - createTreemap(host, opts)：双层 canvas 渲染器
     · 静态层（矩形+文字）与特效层（U2.3 雷达扫掠/新块光晕）分离；
     · devicePixelRatio 适配；resize rAF 节流（ResizeObserver + window resize）；
     · 标签三级：块高 ≥48px 名称+大小+占比 / 24–48px 仅名称（ellipsis）/
       <24px 无；**>1500 块关闭小标签层（只留 ≥48 层）**；
     · 命中检测：坐标逆序遍历 tiles（后绘的小块在上，命中优先）；
     · tooltip：glass（--card-glass+blur）/ 偏移 (12,12) / 延迟 150ms（token
       --dur-tooltip-delay）/ 视口边界翻转；
     · L1-1 入场：stagger 12ms（≤400ms）+ scale .92→1 + fade，600ms（--dur-4）
       ease-out（--ease-out 控制点经 cubicBezier 求值）；>1500 块整画布
       240ms（--dur-page-in）交叉淡化；reduced-motion 直显终值；
     · U2.3：
       - 动画模式化：setTiles(tiles,{mode:"entry"|"reflow"|"none"})
         · entry = L1-1 入场（数据到达；全新生长，prev 清空）；
         · reflow = L3-2/L3-9 lerp 300ms（--dur-treemap-lerp，无 stagger）：
           旧块位置/尺寸过渡、新块从 0 生长 + fx 层一次性描边光晕；
         · none = 直绘终帧（回灌/错误恢复）。
       - 单击/双击判定（300ms，--dur-dblclick）：单击→延迟确认后 onClick；
         双击→onDblClick 且取消待发单击（用点击时间戳防抖，防误触）。
       - 下钻 FLIP（L3-1）：click 确认后 flipDrill(tile)——该矩形 450ms
         ease-inout 放大铺满画布、其余块淡出；数据在 FLIP 完成前到达时
         挂起（pending 机制），FLIP 完成后按 L1-1 入场。
       - 返回上级反向播放（L3-1）：zoomOutTo(rect)——当前层整体收缩进目标
         矩形（450ms ease-inout），完成后新数据入场（同样挂起机制）。
       - 雷达扫掠（L3-3）：仅扫描中；12% 宽光带从左上到右下，每 6s 一次
         （--dur-treemap-sweep），单次 1.2s（--dur-treemap-sweep-run），
         峰值 opacity ≤0.06，composite lighter；reduced 关闭。
     - 纪律：动画只动 canvas 内容（canvas 内例外许可）与整画布 opacity；
       will-change 不用于常驻层；颜色只引用 tokens 变量/调色板；
                   - U4.1：键盘矩阵（§7.4）——treemap 聚焦后 ↑↓←→ 最近邻移动焦点块
        （nearestFocusIndex 纯函数，按当前视口布局坐标；边界/单块/无 tiles 守卫
        =无候选不动）；焦点块指示=静态描边（drawFinalFrame 终帧绘制，不动画，
        reduced 不降级）；Enter=单击语义（activateFocus：取消待发单击后走
        opts.onClick 既有下钻链——文件/合并块 0 请求且不产生第三次请求）；
        focusIdx 经 APP_STATE.treemap.focusIdx 单一来源（-1 默认，尚未聚焦）。
      - ⚠️ 偏差注记：未单设 components/treemap-card.js——本渲染器自包含，
       由 pages/workspace 装配进视图区（§3.1 表 components/treemap-card
       为设计占位，实际以 viz 模块承载）。
   ============================================================ */

import { lerp, clamp01, cubicBezier } from "../motion-core.js";
import { esc, humanBytes } from "../api.js";
import { APP_STATE } from "../state.js"; // U4.1：焦点块索引单一来源（§3.2 treemap.focusIdx，-1 默认）

/* ================= 布局纯函数（Bruls squarified） =================

   算法（Bruls et al. 2000，与权威实现逐例核对）：
   - 归一化：value → 绝对面积 a = value/total·(w·h)，Σa = w·h；
   - 行判定：side = min(rw,rh)；worst(row,side) = max_i max(side²·a_i/s²,
     s²/(side²·a_i))（s = 行面积和）；下一项使 worst 严格变小才并入当前行；
   - 行布局（与论文算例 6×4 → 300×200/1200×7… 逐项一致）：
     · rw ≥ rh：竖条——stripW = s/rh，条内各块宽 stripW、高 a_i/stripW，沿 y 堆叠；
     · rw <  rh：横条——stripH = s/rw，条内各块高 stripH、宽 a_i/stripH，沿 x 堆叠。 */

function worstRatio(row, side) {
    let s = 0;
    for (const d of row) s += d.a;
    const s2 = s * s;
    const w2 = side * side;
    let m = 0;
    for (const d of row) {
        const q = (w2 * d.a) / s2;
        const r = q >= 1 ? q : 1 / q;
        if (r > m) m = r;
    }
    return m;
}

/* layoutSquaried(items, x, y, w, h) → [{key,x,y,w,h}]
   - items: [{key, value}]；value 非正/非法项被过滤，全空返回 []；
   - 内部按 value 降序（手册 §设计 要求输入已降序，此处对调用方免疫）；
   - 输出：与输入同键，Σ(面积) = w·h（浮点内守恒）；相邻块共享边不重叠；
   - 全部矩形包含于 [x,x+w]×[y,y+h]。 */
export function layoutSquaried(items, x, y, w, h) {
    if (!Array.isArray(items) || !items.length || !(w > 0) || !(h > 0)) return [];
    const vals = [];
    for (const it of items) {
        const v = Number(it ? it.value : 0);
        if (isFinite(v) && v > 0) vals.push({ key: it.key, value: v });
    }
    if (!vals.length) return [];
    vals.sort((a, b) => b.value - a.value);
    const total = vals.reduce((s, d) => s + d.value, 0);
    if (!(total > 0)) return [];
    const area = (w * h) / total;
    const arr = vals.map((d) => ({ key: d.key, a: d.value * area }));

    const out = [];
    let rx = x, ry = y, rw = w, rh = h;

    const layRow = (row) => {
        let s = 0;
        for (const d of row) s += d.a;
        if (rw >= rh) {
            const stripW = Math.min(rw, s / rh);
            let cy = ry;
            for (const d of row) {
                const th = stripW > 0 ? d.a / stripW : 0;
                out.push({ key: d.key, x: rx, y: cy, w: stripW, h: th });
                cy += th;
            }
            rx += stripW;
            rw -= stripW;
        } else {
            const stripH = Math.min(rh, s / rw);
            let cx = rx;
            for (const d of row) {
                const tw = stripH > 0 ? d.a / stripH : 0;
                out.push({ key: d.key, x: cx, y: ry, w: tw, h: stripH });
                cx += tw;
            }
            ry += stripH;
            rh -= stripH;
        }
    };

    let row = [];
    let i = 0;
    while (i < arr.length) {
        if (!row.length) {
            row.push(arr[i]);
            i += 1;
            continue;
        }
        if (rw <= 1e-9 || rh <= 1e-9) break; // 浮点防护：无剩余空间（数学上不可达）
        const side = Math.min(rw, rh);
        const cur = worstRatio(row, side);
        const next = worstRatio(row.concat([arr[i]]), side);
        if (next < cur) {
            row.push(arr[i]);
            i += 1;
        } else {
            layRow(row);
            row = [];
        }
    }
    if (row.length) layRow(row);
    return out;
}

/* ================= Canvas 渲染器 ================= */

/* U4.1：方向键最近邻焦点数学（纯函数，node --test 可测；实现落点见 §U4.1）。
   rects: [{key,x,y,w,h}]（当前视口布局坐标）；from: 当前焦点下标（-1=无焦点）。
   规则：目标块中心必须在方向上**严格前进**（允许另一轴任意），候选取与当前
   中心欧氏距离最近者；无候选（边界）/无布局 → -1（焦点不动——边界守卫）；
   无焦点时首按 → 0（最大块=布局首位，按面积降序）。
   参考既有 hitTest 的几何口径（中心坐标来自同一布局数据）。 */
export function nearestFocusIndex(rects, from, dx, dy) {
    const ddx = Math.sign(dx || 0);
    const ddy = Math.sign(dy || 0);
    if (!ddx && !ddy) return from;
    if (!Array.isArray(rects) || !rects.length) return -1;
    const valid = Number.isInteger(from) && from >= 0 && from < rects.length;
    if (!valid) return 0;
    const cur = rects[from];
    const cx = cur.x + cur.w / 2;
    const cy = cur.y + cur.h / 2;
    const EPS = 1e-6; // 浮点屏障（中心点重合邻近判定）
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < rects.length; i++) {
        if (i === from) continue;
        const r = rects[i];
        const mx = r.x + r.w / 2;
        const my = r.y + r.h / 2;
        const dxOK = ddx === 0 || (ddx > 0 ? mx > cx + EPS : mx < cx - EPS);
        const dyOK = ddy === 0 || (ddy > 0 ? my > cy + EPS : my < cy - EPS);
        if (!dxOK || !dyOK) continue;
        const d = Math.hypot(mx - cx, my - cy);
        if (d < bestD - EPS) { bestD = d; best = i; }
    }
    return best;
}

const GAP = 1;               // 块间隙（几何常量，非动画参数）
const LABEL_H1 = 48;         // 三级标签：≥48px 全量标签
const LABEL_H2 = 24;         // 24–48px 仅名称；<24 无
const CROSSFADE_THRESHOLD = 1500; // >1500 块：关小标签层 + 整画布 240ms 交叉淡化
const TOOLTIP_OFFSET = 12;   // tooltip 跟随偏移 (12,12)
const TOOLTIP_MARGIN = 8;    // 视口边界留白

function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
function durMs(name) {
    const v = parseFloat(cssVar(name));
    return Number.isFinite(v) ? v : 0;
}
function reducedMotion() {
    return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
}
function bezierFromToken(token, fallback) {
    const m = cssVar(token).match(/cubic-bezier\(([^)]+)\)/);
    const p = m ? m[1].split(",").map((s) => parseFloat(s)) : [];
    if (p.length === 4 && p.every((n) => isFinite(n))) {
        return cubicBezier(p[0], p[1], p[2], p[3]);
    }
    return fallback;
}
function easeOutFn() {
    return bezierFromToken("--ease-out", (v) => clamp01(v));
}
function easeInOutFn() {
    return bezierFromToken("--ease-inout", (v) => clamp01(v));
}

export function createTreemap(host, opts = {}) {
    const onClick = typeof opts.onClick === "function" ? opts.onClick : null;
    const onDblClick = typeof opts.onDblClick === "function" ? opts.onDblClick : null;
    const onHover = typeof opts.onHover === "function" ? opts.onHover : null;

    /* ---- 双层 canvas + tooltip（tooltip 挂 body：fixed 定位，逃逸宿主裁剪/透明度） ---- */
    const staticCanvas = document.createElement("canvas");
    staticCanvas.className = "treemap-canvas";
    staticCanvas.setAttribute("aria-label", "目录空间矩形图");
    const fxCanvas = document.createElement("canvas");
    fxCanvas.className = "treemap-canvas treemap-fx";
    host.appendChild(staticCanvas);
    host.appendChild(fxCanvas);
    const sctx = staticCanvas.getContext("2d");
    const fctx = fxCanvas.getContext("2d"); // U2.3 特效层（扫掠/新块光晕）

    const tooltip = document.createElement("div");
    tooltip.className = "treemap-tooltip";
    tooltip.setAttribute("role", "tooltip");
    tooltip.hidden = true;
    document.body.appendChild(tooltip);

    /* ---- 状态 ---- */
    let tiles = [];            // 数据 tile（{key,name,size,pct,color,path,isDir,isOther}）
    let layout = [];           // 布局结果（含 x,y,w,h；顺序 = 绘制顺序 = 命中逆序基准）
    let prevFinal = new Map(); // key → 上一代终帧 rect（reflow 插值用；新块缺省从 0 生长）
    let rafId = 0;
    let animating = false;     // 任何动画进行中（入场/重排/FLIP/收缩）
    let crossfading = false;
    let hoverKey = null;
    let tooltipTimer = 0;
    let lastCX = 0;            // 最近一次指针坐标（tooltip 显示瞬间按最新坐标定位）
    let lastCY = 0;
    let resizeRaf = 0;
    let destroyed = false;
    let cssW = 0;
    let cssH = 0;
    let dark = document.documentElement.getAttribute("data-theme") === "dark";

    /* U4.1：键盘焦点块（键盘矩阵 §7.4：treemap 聚焦后 ↑↓←→ 最近邻移动焦点块）。
       focusIdx 经 APP_STATE.treemap.focusIdx 单一来源（-1 = 无焦点）；
       焦点块指示=静态描边（drawFinalFrame 终帧绘制，不动画——reduced 不降级）。 */
    let focusIdx = typeof APP_STATE.treemap.focusIdx === "number" && APP_STATE.treemap.focusIdx >= -1
        ? APP_STATE.treemap.focusIdx : -1;

    /* U2.3：单击/双击防抖 + 下钻/收缩转场 + 扫描扫掠 */
    let lastClickT = 0;
    let clickTimer = 0;
    let transition = null;     // {type:"drill"|"zoomout"} 转场动画进行中（数据挂起等待）
    let pending = null;        // {tiles, mode}：转场完成后再应用的新数据
    let sweepOn = false;
    let sweepTimer = 0;
    let sweepRaf = 0;
    let sweepState = null;

    const themeObs = new MutationObserver(() => {
        dark = document.documentElement.getAttribute("data-theme") === "dark";
        drawFinalFrame(hoverKey !== null);
    });
    themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(scheduleResize) : null;
    if (ro) ro.observe(host);
    window.addEventListener("resize", scheduleResize);

    /* ---- 尺寸/DPR（resize rAF 节流） ---- */
    function doResize() {
        if (destroyed) return;
        const w = host.clientWidth;
        const h = host.clientHeight;
        if (!w || !h || (w === cssW && h === cssH)) return;
        cssW = w;
        cssH = h;
        const dpr = window.devicePixelRatio || 1;
        for (const c of [staticCanvas, fxCanvas]) {
            c.width = Math.max(1, Math.round(w * dpr));
            c.height = Math.max(1, Math.round(h * dpr));
        }
        sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        fctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        if (layout.length) {
            // 重排（同数据新容器尺寸），直接终帧呈现
            const geo = layoutSquaried(tiles.map((t) => ({ key: t.key, value: t.size })), 0, 0, cssW, cssH);
            applyLayout(geo);
            drawFinalFrame(hoverKey !== null);
        } else {
            drawFinalFrame(false);
        }
    }
    function scheduleResize() {
        if (destroyed || resizeRaf) return;
        resizeRaf = requestAnimationFrame(() => {
            resizeRaf = 0;
            doResize();
        });
    }

    function applyLayout(geo) {
        const byKey = new Map(geo.map((g) => [g.key, g]));
        layout = [];
        for (const t of tiles) {
            const g = byKey.get(t.key);
            if (g) layout.push(Object.assign({}, t, g));
        }
    }

    /* ---- 绘制 ---- */
    function paintTile(t, r, alpha, scale, hover) {
        if (alpha <= 0) return;
        const g = GAP;
        const x = r.x + g / 2;
        const y = r.y + g / 2;
        const w = Math.max(0, r.w - g);
        const h = Math.max(0, r.h - g);
        if (!(w > 0) || !(h > 0)) return;
        sctx.save();
        sctx.globalAlpha = alpha;
        if (scale !== 1) {
            const cx = r.x + r.w / 2;
            const cy = r.y + r.h / 2;
            sctx.translate(cx, cy);
            sctx.scale(scale, scale);
            sctx.translate(-cx, -cy);
        }
        sctx.fillStyle = t.color;
        sctx.fillRect(x, y, w, h);
        if (dark) {
            sctx.fillStyle = "rgba(255,255,255,0.08)"; // §3.4：暗色整块叠 8% 白
            sctx.fillRect(x, y, w, h);
        }
        if (hover) {
            sctx.strokeStyle = cssVar("--primary") || "#2563eb";
            sctx.lineWidth = 2;
            sctx.strokeRect(x + 1, y + 1, Math.max(0, w - 2), Math.max(0, h - 2));
        }
        sctx.restore();
    }

    function labelFont(bold) {
        const fs = parseFloat(cssVar("--fs-xs")) || 12;
        return (bold ? "600 " : "") + fs + "px " + fontFamily();
    }
    function fontFamily() {
        const fam = getComputedStyle(document.body).fontFamily;
        return fam || "Segoe UI, Microsoft YaHei, sans-serif";
    }
    function ellipsize(text, maxW) {
        if (sctx.measureText(text).width <= maxW) return text;
        let lo = 0, hi = text.length;
        while (lo < hi) {
            const mid = Math.ceil((lo + hi) / 2);
            if (sctx.measureText(text.slice(0, mid) + "…").width <= maxW) lo = mid;
            else hi = mid - 1;
        }
        return lo ? text.slice(0, lo) + "…" : "";
    }
    function drawLabels() {
        const bigOnly = layout.length > CROSSFADE_THRESHOLD; // >1500 块：关小标签层
        const ink = cssVar("--on-primary") || "#ffffff";
        for (const t of layout) {
            if (t.h < LABEL_H1) {
                if (bigOnly || t.h < LABEL_H2) continue; // 24–48 仅名称；<24 无；>1500 只留 ≥48
                const pad = 4;
                sctx.font = labelFont(false);
                sctx.textBaseline = "top";
                const w = t.w - pad * 2;
                if (w < 16) continue;
                const txt = ellipsize(t.name, w);
                if (!txt) continue;
                sctx.fillStyle = ink;
                sctx.fillText(txt, t.x + pad, Math.max(t.y + 4, t.y + (t.h - 12) / 2));
                continue;
            }
            const pad = 5;
            const innerW = t.w - pad * 2;
            if (innerW < 20) continue;
            sctx.font = labelFont(true);
            sctx.textBaseline = "top";
            sctx.fillStyle = ink;
            const name = ellipsize(t.name, innerW);
            if (!name) continue;
            sctx.fillText(name, t.x + pad, t.y + pad);
            if (t.h >= LABEL_H1 + 14) {
                if (innerW < 40) continue;
                sctx.font = labelFont(false);
                const sub = humanBytes(t.size) + " · " + (t.pct * 100).toFixed(1) + "%";
                const txt2 = ellipsize(sub, innerW);
                if (txt2) sctx.fillText(txt2, t.x + pad, t.y + pad + 15);
            }
        }
    }

    function drawEmpty() {
        sctx.clearRect(0, 0, cssW, cssH);
        sctx.font = labelFont(false);
        sctx.fillStyle = cssVar("--muted") || "#64748b";
        sctx.textAlign = "center";
        sctx.textBaseline = "middle";
        sctx.fillText("这个目录是空的。", cssW / 2, cssH / 2);
        sctx.textAlign = "start";
    }

    function drawFinalFrame(hover) {
        sctx.clearRect(0, 0, cssW, cssH);
        if (!layout.length) {
            drawEmpty();
            prevFinal = new Map();
            return;
        }
        for (const t of layout) paintTile(t, t, 1, 1, hover && t.key === hoverKey);
        drawLabels();
        drawFocusRing(); // U4.1：焦点块静态描边（终帧绘制；不动画/仅静态——reduced 不降级）
        prevFinal = new Map(layout.map((t) => [t.key, { x: t.x, y: t.y, w: t.w, h: t.h }]));
    }

    /* ---- U4.1：键盘焦点块指示（静态描边 2px primary，几何与 hover 高亮同口径） ---- */
    function drawFocusRing() {
        if (focusIdx < 0 || focusIdx >= layout.length) return;
        const t = layout[focusIdx];
        const x = t.x + GAP / 2;
        const y = t.y + GAP / 2;
        const w = Math.max(0, t.w - GAP);
        const h = Math.max(0, t.h - GAP);
        if (!(w > 0) || !(h > 0)) return;
        sctx.save();
        sctx.strokeStyle = cssVar("--primary") || "#2563eb";
        sctx.lineWidth = 2;
        sctx.strokeRect(x + 1, y + 1, Math.max(0, w - 2), Math.max(0, h - 2));
        sctx.restore();
    }

    /* ---- L1-1 入场（drawFrame 插值；全新生长：prev 已清空） ---- */
    function entryRect(t, e) {
        return { x: t.x, y: t.y, w: lerp(0, t.w, e), h: lerp(0, t.h, e) };
    }

    function startEntry() {
        animating = true;
        const t0 = performance.now();
        const grow = durMs("--dur-4");                 // 600ms；token 缺失 → 0（瞬时，smoke 脚手架无 tokens.css）
        const stagger = durMs("--dur-treemap-stagger"); // 12ms
        const cap = durMs("--dur-treemap-stagger-cap"); // 400ms
        const ease = easeOutFn();
        const frame = (now) => {
            if (destroyed) { animating = false; return; }
            sctx.clearRect(0, 0, cssW, cssH);
            let done = true;
            for (let i = 0; i < layout.length; i++) {
                const t = layout[i];
                const delay = Math.min(i * stagger, cap); // 按面积排名 stagger（布局已降序）
                const p = (now - t0 - delay) / grow;
                if (p >= 1) {
                    paintTile(t, t, 1, 1, false);
                } else {
                    const e = ease(clamp01(p));
                    paintTile(t, entryRect(t, e), e, lerp(0.92, 1, e), false);
                    done = false;
                }
            }
            if (done) {
                animating = false;
                drawFinalFrame(hoverKey !== null); // 收束时恢复命中高亮（动画期间暂停过重绘）
            } else {
                rafId = requestAnimationFrame(frame);
            }
        };
        rafId = requestAnimationFrame(frame);
    }

    /* ---- L3-2/L3-9 重排（lerp 300ms；新块从 0 生长 + fx 一次性描边光晕） ---- */
    function startReflow() {
        animating = true;
        const t0 = performance.now();
        const dur = durMs("--dur-treemap-lerp"); // 300ms；缺失 → 瞬时
        const ease = easeOutFn();
        const newKeys = [];
        for (const t of layout) if (!prevFinal.has(t.key)) newKeys.push(t.key);
        const frame = (now) => {
            if (destroyed) { animating = false; return; }
            const p = clamp01((now - t0) / dur);
            const e = ease(p);
            sctx.clearRect(0, 0, cssW, cssH);
            let done = p >= 1;
            for (const t of layout) {
                const pre = prevFinal.get(t.key);
                const r = pre
                    ? { x: lerp(pre.x, t.x, e), y: lerp(pre.y, t.y, e), w: lerp(pre.w, t.w, e), h: lerp(pre.h, t.h, e) }
                    : { x: t.x, y: t.y, w: lerp(0, t.w, e), h: lerp(0, t.h, e) };
                paintTile(t, r, 1, 1, false);
            }
            // 新块一次性描边光晕（fx 层，随进度衰减，lighter）
            fctx.clearRect(0, 0, cssW, cssH);
            if (newKeys.length && !done) {
                fctx.save();
                fctx.globalCompositeOperation = "lighter";
                fctx.strokeStyle = cssVar("--primary") || "#2563eb";
                fctx.globalAlpha = (1 - e) * 0.5;
                fctx.lineWidth = 2;
                fctx.beginPath();
                for (const t of layout) {
                    if (newKeys.indexOf(t.key) === -1) continue;
                    fctx.rect(t.x + GAP / 2 + 1, t.y + GAP / 2 + 1, Math.max(0, t.w - GAP - 2), Math.max(0, t.h - GAP - 2));
                }
                fctx.stroke();
                fctx.restore();
            } else {
                fctx.clearRect(0, 0, cssW, cssH);
            }
            if (done) {
                animating = false;
                drawFinalFrame(hoverKey !== null);
            } else {
                rafId = requestAnimationFrame(frame);
            }
        };
        rafId = requestAnimationFrame(frame);
    }

    function crossFadeIn() {
        animating = true;
        crossfading = true;
        drawFinalFrame(false);
        const dur = durMs("--dur-page-in"); // 240ms；token 缺失 → 瞬时
        staticCanvas.style.transition = "";
        staticCanvas.style.opacity = "0";   // 先复位（无过渡），强制 flush 后再挂过渡
        void staticCanvas.offsetWidth;
        staticCanvas.style.transition = "opacity " + dur + "ms ease-out";
        requestAnimationFrame(() => {
            if (destroyed) return;
            staticCanvas.style.opacity = "1";
            setTimeout(() => {
                if (destroyed) return;
                staticCanvas.style.transition = "";
                staticCanvas.style.opacity = "";
                crossfading = false;
                animating = false;
                dispatchPending();
            }, dur + 60);
        });
    }

    /* ---- U2.3：下钻 FLIP / 返回收缩（450ms ease-inout；数据挂起等转场完成） ---- */
    function holdDrillTile(tile) {
        // reduced-motion：直画放大铺满终态（转场直切口径）
        sctx.clearRect(0, 0, cssW, cssH);
        paintTile(tile, { x: 0, y: 0, w: cssW, h: cssH }, 1, 1, false);
    }

    function flipDrill(tile) {
        if (destroyed || !layout.length) return;
        const t = layout.find((x) => x.key === tile.key) || tile;
        if (!t) return;
        if (reducedMotion()) { holdDrillTile(t); dispatchPending(); return; }
        transition = { type: "drill" };
        animating = true;
        const t0 = performance.now();
        const dur = durMs("--dur-flip"); // 450ms；缺失 → 瞬时
        const ease = easeInOutFn();
        const frame = (now) => {
            if (destroyed) { transition = null; animating = false; return; }
            const p = clamp01((now - t0) / dur);
            const e = ease(p);
            sctx.clearRect(0, 0, cssW, cssH);
            const tar = { x: 0, y: 0, w: cssW, h: cssH };
            paintTile(t, { x: lerp(t.x, tar.x, e), y: lerp(t.y, tar.y, e), w: lerp(t.w, tar.w, e), h: lerp(t.h, tar.h, e) }, 1, 1, false);
            for (const o of layout) {
                if (o.key === t.key) continue;
                paintTile(o, o, 1 - e, 1, false);
            }
            if (p < 1) rafId = requestAnimationFrame(frame);
            else { transition = null; animating = false; dispatchPending(); }
        };
        rafId = requestAnimationFrame(frame);
    }

    function zoomOutTo(rect) {
        if (destroyed || !layout.length) return;
        if (reducedMotion()) { dispatchPending(); return; }
        transition = { type: "zoomout" };
        animating = true;
        const t0 = performance.now();
        const dur = durMs("--dur-flip");
        const ease = easeInOutFn();
        const k0 = 1;
        const k1 = rect.w / cssW;
        const ox1 = rect.x + rect.w / 2 - (cssW / 2) * k1;
        const oy1 = rect.y + rect.h / 2 - (cssH / 2) * k1;
        const frame = (now) => {
            if (destroyed) { transition = null; animating = false; return; }
            const p = clamp01((now - t0) / dur);
            const e = ease(p);
            const k = lerp(k0, k1, e);
            const ox = e * ox1; // 初始偏移 0（恒等缩放），终点对齐目标矩形
            const oy = e * oy1;
            sctx.clearRect(0, 0, cssW, cssH);
            sctx.save();
            sctx.translate(ox, oy);
            sctx.scale(k, k);
            for (const t of layout) paintTile(t, t, 1, 1, false);
            sctx.restore();
            if (p < 1) rafId = requestAnimationFrame(frame);
            else { transition = null; animating = false; dispatchPending(); }
        };
        rafId = requestAnimationFrame(frame);
    }

    function cancelTransition() {
        if (transition) {
            transition = null;
            cancelAnim();
            drawFinalFrame(hoverKey !== null); // 恢复旧层终帧（浏览失败路径）
        }
        pending = null;
    }

    function isTransitioning() { return transition !== null; }

    /* ---- L3-3 雷达扫掠（特效层；仅扫描中；reduced 关） ---- */
    function setSweep(on) {
        const want = !!on && !reducedMotion();
        if (want === sweepOn) return;
        sweepOn = want;
        clearTimeout(sweepTimer);
        sweepTimer = 0;
        if (!sweepOn) {
            cancelAnimationFrame(sweepRaf);
            sweepRaf = 0;
            sweepState = null;
            fctx.clearRect(0, 0, cssW, cssH);
            return;
        }
        sweepSchedule();
    }
    function sweepSchedule() {
        clearTimeout(sweepTimer);
        sweepTimer = setTimeout(() => {
            sweepTimer = 0;
            sweepRun();
        }, durMs("--dur-treemap-sweep")); // 6s 周期；缺失 → 0（立即首轮）
    }
    function sweepRun() {
        if (!sweepOn || destroyed) return;
        sweepState = { t0: performance.now(), dur: durMs("--dur-treemap-sweep-run") || 1200 };
        const frame = (now) => {
            if (!sweepOn || destroyed || sweepState === null) return;
            const p = clamp01((now - sweepState.t0) / sweepState.dur);
            drawSweep(p);
            if (p < 1) sweepRaf = requestAnimationFrame(frame);
            else {
                sweepState = null;
                fctx.clearRect(0, 0, cssW, cssH);
                sweepSchedule();
            }
        };
        sweepRaf = requestAnimationFrame(frame);
    }
    function drawSweep(p) {
        fctx.clearRect(0, 0, cssW, cssH);
        // 12% 宽光带沿主对角线从左上到右下；峰值 opacity 0.06；lighter
        const diag = Math.hypot(cssW, cssH);
        const bandW = diag * 0.12;
        const t = -bandW + p * (diag + 2 * bandW);
        const ang = Math.atan2(cssH, cssW);
        fctx.save();
        fctx.globalCompositeOperation = "lighter";
        fctx.translate(Math.cos(ang) * t, Math.sin(ang) * t);
        fctx.rotate(ang);
        const grad = fctx.createLinearGradient(0, -bandW / 2, 0, bandW / 2);
        grad.addColorStop(0, "rgba(255,255,255,0)");
        grad.addColorStop(0.5, "rgba(255,255,255,0.06)");
        grad.addColorStop(1, "rgba(255,255,255,0)");
        fctx.fillStyle = grad;
        fctx.fillRect(-diag, -bandW / 2, diag * 2, bandW);
        fctx.restore();
    }

    function cancelAnim() {
        if (rafId) cancelAnimationFrame(rafId);
        rafId = 0;
        animating = false;
    }

    /* ---- 命中检测（坐标逆序遍历：后绘小块优先） ---- */
    function hitTest(x, y) {
        for (let i = layout.length - 1; i >= 0; i--) {
            const t = layout[i];
            if (x >= t.x && x <= t.x + t.w && y >= t.y && y <= t.y + t.h) return t;
        }
        return null;
    }
    function toLocal(ev) {
        const r = staticCanvas.getBoundingClientRect();
        return { x: ev.clientX - r.left, y: ev.clientY - r.top };
    }

    /* ---- tooltip（glass / (12,12) / 150ms 延迟 / 边界翻转） ---- */
    function tooltipText(t) {
        const hint = t.isOther ? "合并项（不可下钻）" : t.isDir ? "点击下钻" : "文件";
        return (
            '<b class="tt-name">' + esc(t.name) + "</b>" +
            '<div class="tt-line">' + esc(humanBytes(t.size)) + "</div>" +
            '<div class="tt-line">' + (t.pct * 100).toFixed(1) + "%</div>" +
            '<div class="tt-hint">' + hint + "</div>"
        );
    }
    function positionTooltip(ev) {
        let x = ev.clientX + TOOLTIP_OFFSET;
        let y = ev.clientY + TOOLTIP_OFFSET;
        const w = tooltip.offsetWidth;
        const h = tooltip.offsetHeight;
        if (x + w > window.innerWidth - TOOLTIP_MARGIN) x = ev.clientX - TOOLTIP_OFFSET - w;   // 边界翻转
        if (y + h > window.innerHeight - TOOLTIP_MARGIN) y = ev.clientY - TOOLTIP_OFFSET - h;
        tooltip.style.left = Math.max(TOOLTIP_MARGIN, x) + "px";
        tooltip.style.top = Math.max(TOOLTIP_MARGIN, y) + "px";
    }
    function hideTooltip() {
        clearTimeout(tooltipTimer);
        tooltipTimer = 0;
        tooltip.hidden = true;
    }
    function scheduleTooltip(t, ev) {
        tooltip.innerHTML = tooltipText(t);
        positionTooltip(ev);
        clearTimeout(tooltipTimer);
        tooltipTimer = setTimeout(() => {
            tooltipTimer = 0;
            if (hoverKey === t.key) {
                positionTooltip({ clientX: lastCX, clientY: lastCY }); // 显示瞬间按最新坐标定位
                tooltip.hidden = false;
            }
        }, durMs("--dur-tooltip-delay")); // 150ms；token 缺失 → 瞬时
    }

    /* ---- 交互 ---- */
    function onPointerMove(ev) {
        lastCX = ev.clientX;
        lastCY = ev.clientY;
        const pos = toLocal(ev);
        const t = hitTest(pos.x, pos.y);
        const key = t ? t.key : null;
        if (key !== hoverKey) {
            hoverKey = key;
            if (onHover) onHover(t || null);
            if (!animating) drawFinalFrame(key !== null); // 命中高亮（动画期间不重绘）
            if (t) scheduleTooltip(t, ev);
            else hideTooltip();
        } else if (t) {
            positionTooltip(ev); // 同块移动：仅跟随
        }
    }
    function onPointerLeave() {
        hoverKey = null;
        if (onHover) onHover(null);
        if (!animating) drawFinalFrame(false);
        hideTooltip();
    }
    function onClickCanvas(ev) {
        hideTooltip();
        const t = hitTest(toLocal(ev).x, toLocal(ev).y);
        if (!t) return;
        // 单击/双击判定：300ms 窗口（--dur-dblclick；token 缺失时按 §3.5 参数回落 300——
        // 防抖窗口为行为语义，0 会退化为无防抖，与动画「瞬时=直切」的 0 回落不同），
        // 二次点击取消待发单击（防误触）
        const win = durMs("--dur-dblclick") || 300;
        const now = ev.timeStamp || performance.now();
        if (lastClickT && now - lastClickT <= win) {
            clearTimeout(clickTimer);
            clickTimer = 0;
            lastClickT = 0;
            if (onDblClick) onDblClick(t);
            return;
        }
        lastClickT = now;
        clearTimeout(clickTimer);
        clickTimer = setTimeout(() => {
            clickTimer = 0;
            lastClickT = 0;
            if (onClick) onClick(t);
        }, win);
    }

    staticCanvas.addEventListener("pointermove", onPointerMove);
    staticCanvas.addEventListener("pointerleave", onPointerLeave);
    staticCanvas.addEventListener("click", onClickCanvas);
    // U4.1：容器获得焦点（Tab/点击进入）且无焦点块时 → 从最大块起（焦点始可见）
    host.addEventListener("focusin", () => {
        if (focusIdx < 0 && layout.length) {
            setFocusIdxRaw(0);
            if (!animating && !transition) drawFinalFrame(hoverKey !== null);
        }
    });

    /* ---- 数据流入（模式化：entry / reflow / none） ---- */
    function dispatchPending() {
        if (!pending) return;
        const p = pending;
        pending = null;
        setTiles(p.tiles, { mode: p.mode });
    }

    /* ---- U4.1：焦点块状态（APP_STATE.treemap.focusIdx 单一来源） ---- */
    function setFocusIdxRaw(i) {
        focusIdx = Number.isInteger(i) && i >= -1 ? i : -1;
        APP_STATE.treemap.focusIdx = focusIdx;
    }

    /* 方向键移动：最近邻数学（nearestFocusIndex 纯函数）→ 静态终帧重绘。
       动画进行中（入场/重排/转场）只改索引，终帧收束时焦点描边随 drawFinalFrame 显示。 */
    function moveFocus(dx, dy) {
        const next = nearestFocusIndex(layout, focusIdx, dx, dy);
        if (next >= 0 && next !== focusIdx) {
            setFocusIdxRaw(next);
            if (!animating && !transition) drawFinalFrame(hoverKey !== null);
        }
        return focusIdx;
    }

    /* Enter 下钻 = 单击语义：走 opts.onClick 既有下钻链（含目录/文件/合并块守卫——
       文件与合并块 0 请求）；300ms 双击窗防抖语义：取消待发单击后再激活（同双击
       路径，不产生第三次请求）。 */
    function activateFocus() {
        if (focusIdx < 0 || focusIdx >= layout.length) return;
        clearTimeout(clickTimer);
        clickTimer = 0;
        lastClickT = 0;
        const t = layout[focusIdx];
        if (onClick) onClick(t);
    }

    function getFocusedTile() {
        return focusIdx >= 0 && focusIdx < layout.length ? layout[focusIdx] : null;
    }

    function setTiles(next, opts = {}) {
        const mode = opts.mode || (opts.animate === false ? "none" : "entry");
        if (transition) {
            // 转场（下钻 FLIP/收缩）进行中：数据挂起（不动转场 rAF），完成后再按其模式入场
            pending = { tiles: (next || []).slice(), mode: mode };
            return;
        }
        tiles = (next || []).slice();
        tiles.sort((a, b) => (Number(b.size) || 0) - (Number(a.size) || 0)); // 面积降序（stagger 排名 = 绘制顺序）
        if (!cssW || !cssH) doResize();
        if (!cssW || !cssH) { layout = []; setFocusIdxRaw(-1); drawFinalFrame(false); return; }
        const geo = layoutSquaried(tiles.map((t) => ({ key: t.key, value: t.size })), 0, 0, cssW, cssH);
        applyLayout(geo);
        // U4.1：焦点块随数据换代同步——key 仍在→跟随新下标；越界/失效→无焦点
        if (focusIdx >= 0) {
            if (focusIdx >= layout.length) setFocusIdxRaw(-1);
            else {
                const k = layout[focusIdx].key;
                const ni = layout.findIndex((t) => t.key === k);
                if (ni < 0) setFocusIdxRaw(-1);
                else if (ni !== focusIdx) setFocusIdxRaw(ni);
            }
        }
        cancelAnim();
        if (mode !== "reflow") prevFinal = new Map(); // entry/none：全新生长（数据到达直入场）
        const animate = mode !== "none" && !reducedMotion();
        if (!animate || !layout.length) {
            drawFinalFrame(false);
            return;
        }
        if (mode === "reflow") {
            startReflow();
            return;
        }
        if (layout.length > CROSSFADE_THRESHOLD) crossFadeIn();
        else startEntry();
    }

    /* 无副作用布局计算（U2.3 条带/反向转场定位用；返回 [{key,x,y,w,h}]） */
    function computeLayout(items) {
        if (!cssW || !cssH) return [];
        return layoutSquaried(items.map((t) => ({ key: t.key, value: t.size })), 0, 0, cssW, cssH);
    }

    const api = {
        host: host,
        canvas: () => staticCanvas,
        fx: () => fxCanvas,
        setTiles: setTiles,
        clear: () => { tiles = []; layout = []; cancelAnim(); hideTooltip(); drawFinalFrame(false); },
        hitTest: hitTest,
        getLayout: () => layout,
        getTiles: () => tiles,
        computeLayout: computeLayout,
        /* U2.3：转场与扫掠 */
        flipDrill: flipDrill,
        zoomOutTo: zoomOutTo,
        cancelTransition: cancelTransition,
        isTransitioning: isTransitioning,
        setSweep: setSweep,
        /* U4.1：键盘矩阵（方向键最近邻移动 / Enter 单击语义 / 焦点块访问器） */
        moveFocus: moveFocus,
        activateFocus: activateFocus,
        getFocusIdx: () => focusIdx,
        getFocusedTile: getFocusedTile,
        setFocusIdx: (i) => {
            setFocusIdxRaw(Number.isInteger(i) && i >= 0 && i < layout.length ? i : -1);
            if (!animating && !transition) drawFinalFrame(hoverKey !== null);
        },
        /* L2-5 联动方向②（外部行 hover → 本视图高亮对应块；120ms 立即态） */
        highlightKey: (key) => {
            hoverKey = key || null;
            if (!animating) drawFinalFrame(hoverKey !== null);
        },
        /* U2.1 router 离场暂停挂点：终帧收束 + 停 rAF + 扫掠/交叉淡化收尾（返回主页后重挂新宿主重建） */
        pause: () => {
            cancelAnim();
            transition = null;
            pending = null;
            setSweep(false);
            if (crossfading) {
                crossfading = false;
                staticCanvas.style.transition = "";
                staticCanvas.style.opacity = "";
            }
        },
        isAnimating: () => animating,
        destroy: () => {
            destroyed = true;
            cancelAnim();
            clearTimeout(clickTimer);
            clearTimeout(sweepTimer);
            cancelAnimationFrame(sweepRaf);
            hideTooltip();
            if (ro) ro.disconnect();
            window.removeEventListener("resize", scheduleResize);
            themeObs.disconnect();
            staticCanvas.style.transition = "";
            staticCanvas.style.opacity = "";
            tooltip.remove();
            staticCanvas.remove();
            fxCanvas.remove();
        },
    };
    // 初始尺寸（host 可能刚插入 DOM）
    doResize();
    drawFinalFrame(false);
    return api;
}
