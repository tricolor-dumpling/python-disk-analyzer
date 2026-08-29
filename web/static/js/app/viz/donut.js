/* ============================================================
   UI 2.0（SpaceLens Pro）· viz/donut.js 存储环形图渲染器（U2.4）
   - SVG 双弧环：底弧 --border-strong 全环；数据弧 --grad-brand（经
     --grad-brand-from/to 逐 stop 取色，SVG 描边无法直接消费复合渐变值）；
   - L3-4（定稿）：入场 sweep 800ms（stroke-dashoffset/dasharray 插值，
     ease-inout 经 cubicBezier 读 --ease-inout token 求值，同 treemap L1-1 手法）
     + 中心数字 count-up（L1-4，motion.countUp，600ms easeOutExpo）；
   - 扫描中：不确定旋转弧 1.2s 循环（CSS transform 旋转——仅动 transform，
     token --dur-donut-indeterminate；reduced-motion 静止）；
   - hover 弧段外扩（≈2px，scale 1.035 经 fill-box 中心缩放）+ --glow-drop-sm；
   - 纪律：时长/缓动只经 getComputedStyle 读 token（禁魔法数）；
     动画仅 transform/opacity + 规格明示的 dash 插值（同 sparkline/drawCheck 先例）。
   ============================================================ */

import { clamp01, cubicBezier } from "../motion-core.js";
import { countUp, motionDur, reducedMotion } from "../motion.js";

/* 几何常量（viewBox 120×120，与组件内部渲染耦合，非动效参数） */
const CX = 60, CY = 60, R = 52;
const CIRC = 2 * Math.PI * R; // 周长 ≈ 326.73
/* 数据弧过短时 round 线帽会明显高估占比（0 长度 dash 也会渲染一个圆点），
   低于该阈值直接隐藏数据弧（图例/中心仍有精确数字） */
const MIN_ARC = 0.004;

/* --ease-inout token → cubicBezier 求值器（token 缺失时线性兜底） */
function easeInOutFromToken() {
    const raw = getComputedStyle(document.documentElement).getPropertyValue("--ease-inout").trim();
    const m = raw.match(/cubic-bezier\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)/);
    if (m) return cubicBezier(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]));
    return (p) => p;
}

/* createDonut(host, {fmt}) → {el, setValue, setScanning, destroy}
   - host: 宿主元素（组件挂载点，建议带 role="img" + aria-label 由装配层维护）；
   - fmt:  中心数字格式化（默认整数千分位；存储卡传 humanBytes）。
   单页仅一实例：渐变 id 固定 pds-donut-grad（多实例时 defs 同内容后写覆盖，无害）。 */
export function createDonut(host, opts = {}) {
    const fmt = typeof opts.fmt === "function" ? opts.fmt : (v) => Math.round(v).toLocaleString();

    const box = document.createElement("div");
    box.className = "donut-box";
    box.innerHTML =
        '<svg class="donut-svg" viewBox="0 0 120 120" aria-hidden="true" focusable="false">' +
        '<defs><linearGradient id="pds-donut-grad" x1="0" y1="0" x2="1" y2="1">' +
        '<stop offset="0" class="donut-grad-from"></stop>' +
        '<stop offset="1" class="donut-grad-to"></stop>' +
        "</linearGradient></defs>" +
        '<circle class="donut-track" cx="' + CX + '" cy="' + CY + '" r="' + R + '"></circle>' +
        '<g class="donut-arc-g"><circle class="donut-arc" cx="' + CX + '" cy="' + CY + '" r="' + R + '" transform="rotate(-90 ' + CX + " " + CY + ')"></circle></g>' +
        '<circle class="donut-indet" cx="' + CX + '" cy="' + CY + '" r="' + R + '" transform="rotate(-90 ' + CX + " " + CY + ')"></circle>' +
        "</svg>" +
        '<div class="donut-center"><strong class="donut-value"></strong><span class="donut-sub"></span></div>';
    host.appendChild(box);

    const arc = box.querySelector(".donut-arc");
    const arcG = box.querySelector(".donut-arc-g");
    const indet = box.querySelector(".donut-indet");
    const valueEl = box.querySelector(".donut-value");
    const subEl = box.querySelector(".donut-sub");

    /* 不确定弧：22% 弧段（展示形态常量），旋转交由 CSS 动画 */
    indet.style.strokeDasharray = (CIRC * 0.22) + " " + CIRC;

    let curPct = 0;   // 当前弧占比（sweep 插值起点）
    let raf = 0;      // sweep rAF 句柄
    let destroyed = false;

    function setArc(pct) {
        if (pct <= MIN_ARC) {
            arc.style.display = "none";
            arc.style.strokeDasharray = "0 " + CIRC;
        } else {
            arc.style.display = "";
            arc.style.strokeDasharray = (CIRC * pct) + " " + CIRC;
        }
    }

    /* 弧插值：from → to，时长/缓动读 token；reduced 直达终值 */
    function sweepTo(from, to) {
        cancelAnimationFrame(raf);
        if (reducedMotion()) { curPct = to; setArc(to); return; }
        const dur = motionDur("--dur-donut-sweep");
        const ease = easeInOutFromToken();
        const t0 = performance.now();
        const step = (now) => {
            if (destroyed) return;
            const p = clamp01((now - t0) / dur);
            setArc(from + (to - from) * ease(p));
            if (p < 1) raf = requestAnimationFrame(step);
            else { curPct = to; setArc(to); }
        };
        step(t0); // 首帧同步落笔，防空白
    }

    /* hover：弧段外扩 + 光晕（transform 过渡 + 静态 filter，动画只动 transform） */
    const onEnter = () => box.classList.add("is-hover");
    const onLeave = () => box.classList.remove("is-hover");
    arcG.addEventListener("mouseenter", onEnter);
    arcG.addEventListener("mouseleave", onLeave);
    indet.addEventListener("mouseenter", onEnter);
    indet.addEventListener("mouseleave", onLeave);

    return {
        el: box,

        /* 数据态：pct∈[0,1]（弧占比）；value=中心数字（count-up）；sub=中心副行 */
        setValue({ pct, value, sub }) {
            const to = clamp01(Number(pct) || 0);
            box.classList.remove("is-indet");
            sweepTo(curPct, to);
            if (value !== undefined && value !== null) countUp(valueEl, value, { fmt });
            if (sub !== undefined) subEl.textContent = sub;
        },

        /* 扫描态：on=true 不确定旋转弧（中心可带 count-up 数字，如进度 %） */
        setScanning(on, info = {}) {
            if (on) {
                box.classList.add("is-indet");
                if (info.value !== undefined && info.value !== null) {
                    countUp(valueEl, info.value, { fmt: info.fmt || ((v) => Math.round(v).toLocaleString()) });
                } else if (info.label !== undefined) {
                    valueEl.textContent = info.label;
                }
                if (info.sub !== undefined) subEl.textContent = info.sub;
            } else {
                box.classList.remove("is-indet");
            }
        },

        destroy() {
            destroyed = true;
            cancelAnimationFrame(raf);
        },
    };
}
