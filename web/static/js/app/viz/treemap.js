/* ============================================================
   UI 2.0（SpaceLens Pro）· viz/treemap.js（U2.2）Treemap 渲染器
   - layoutSquaried(items,x,y,w,h)：Bruls squarified 布局**纯函数**
     （零 DOM，node --test 可测；面积守恒/宽高比/单块/空输入用例见
     scripts/dev/treemap.test.mjs）；
   - createTreemap(host, opts)：双层 canvas 渲染器
     · 静态层（矩形+文字）与特效层（U2.3 扫掠/粒子预留）分离；
     · devicePixelRatio 适配；resize rAF 节流（ResizeObserver + window resize）；
     · 标签三级：块高 ≥48px 名称+大小+占比 / 24–48px 仅名称（ellipsis）/
       <24px 无；**>1500 块关闭小标签层（只留 ≥48 层）**；
     · 命中检测：坐标逆序遍历 tiles（后绘的小块在上，命中优先）；
     · tooltip：glass（--card-glass+blur）/ 偏移 (12,12) / 延迟 150ms（token
       --dur-tooltip-delay）/ 视口边界翻转；
     · L1-1 入场：prev:Map（key → 上一代终帧矩形）插值 + stagger 12ms
       （≤400ms，token）+ scale .92→1 + fade，600ms（--dur-4）ease-out
       （--ease-out 控制点经 cubicBezier 求值）；**>1500 块改为整画布
       交叉淡化 240ms（--dur-page-in）**；reduced-motion 直显终值；
     - 纪律：动画只动 canvas 内容（canvas 内例外许可）与整画布 opacity；
       will-change 不用于常驻层；颜色只引用 tokens 变量/调色板；
       ⚠️ 偏差注记：未单设 components/treemap-card.js——本渲染器自包含，
       由 pages/workspace 装配进视图区（§3.1 表 components/treemap-card
       为设计占位，实际以 viz 模块承载）。
   ============================================================ */

import { lerp, clamp01, cubicBezier } from "../motion-core.js";
import { esc, humanBytes } from "../api.js";

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
function easeOutFn() {
    const m = cssVar("--ease-out").match(/cubic-bezier\(([^)]+)\)/);
    const p = m ? m[1].split(",").map((s) => parseFloat(s)) : [];
    if (p.length === 4 && p.every((n) => isFinite(n))) {
        return cubicBezier(p[0], p[1], p[2], p[3]);
    }
    return (v) => clamp01(v);
}

export function createTreemap(host, opts = {}) {
    const onClick = typeof opts.onClick === "function" ? opts.onClick : null;
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
    const fctx = fxCanvas.getContext("2d"); // U2.3 特效层（扫掠/粒子）使用；本阶段不绘

    const tooltip = document.createElement("div");
    tooltip.className = "treemap-tooltip";
    tooltip.setAttribute("role", "tooltip");
    tooltip.hidden = true;
    document.body.appendChild(tooltip);

    /* ---- 状态 ---- */
    let tiles = [];          // 数据 tile（{key,name,size,pct,color,path,isDir,isOther}）
    let layout = [];         // 布局结果（含 x,y,w,h；顺序 = 绘制顺序 = 命中逆序基准）
    let prevFinal = new Map(); // key → 上一代终帧 rect（供 drawFrame 插值；新块缺省从 0 生长）
    let rafId = 0;
    let animating = false;
    let crossfading = false;
    let hoverKey = null;
    let tooltipTimer = 0;
    let lastCX = 0;          // 最近一次指针坐标（tooltip 显示瞬间按最新坐标定位）
    let lastCY = 0;
    let resizeRaf = 0;
    let destroyed = false;
    let cssW = 0;
    let cssH = 0;
    let dark = document.documentElement.getAttribute("data-theme") === "dark";

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
        prevFinal = new Map(layout.map((t) => [t.key, { x: t.x, y: t.y, w: t.w, h: t.h }]));
    }

    /* ---- L1-1 入场（drawFrame 插值；prev:Map = 上一代终帧） ---- */
    function drawFrame(t, e) {
        const p = prevFinal.get(t.key) || { x: t.x, y: t.y, w: 0, h: 0 }; // 新块从 0 生长
        const r = { x: lerp(p.x, t.x, e), y: lerp(p.y, t.y, e), w: lerp(p.w, t.w, e), h: lerp(p.h, t.h, e) };
        paintTile(t, r, e, lerp(0.92, 1, e), false);
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
                    drawFrame(t, ease(clamp01(p)));
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
            }, dur + 60);
        });
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
        if (t && onClick) onClick(t);
    }

    staticCanvas.addEventListener("pointermove", onPointerMove);
    staticCanvas.addEventListener("pointerleave", onPointerLeave);
    staticCanvas.addEventListener("click", onClickCanvas);

    /* ---- 对外 ---- */
    function setTiles(next, opts = {}) {
        const animate = opts.animate !== false && !reducedMotion();
        tiles = (next || []).slice();
        tiles.sort((a, b) => (Number(b.size) || 0) - (Number(a.size) || 0)); // 面积降序（stagger 排名 = 绘制顺序）
        if (!cssW || !cssH) doResize();
        if (!cssW || !cssH) { layout = []; drawFinalFrame(false); return; }
        const geo = layoutSquaried(tiles.map((t) => ({ key: t.key, value: t.size })), 0, 0, cssW, cssH);
        applyLayout(geo);
        cancelAnim();
        if (!animate || !layout.length) {
            drawFinalFrame(false);
            return;
        }
        if (layout.length > CROSSFADE_THRESHOLD) crossFadeIn();
        else startEntry();
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
        // U2.1 router 离场暂停挂点：终帧收束 + 停 rAF + 交叉淡化收尾（返回主页后重挂新宿主重建）
        pause: () => {
            cancelAnim();
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
