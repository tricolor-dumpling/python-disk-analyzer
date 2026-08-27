/* ============================================================
   UI 2.0（SpaceLens Pro）· motion.js DOM 动效工具库（U1.2）
   - 原生 ES Module / 零依赖 / 零构建链（红线 D1）；
   - 落点对照：手册 §3.5 动效索引表（L0-2/L0-5/L1-4/L2-1/L2-4/L2-7/L3-1/L3-5）；
   - 纪律：所有时长/缓动**只经 getComputedStyle(document.documentElement)
     读 tokens.css 的 motion token（--dur-* / --ease-*），禁止魔法数；
   - reduced-motion：`reducedMotion()` 统一查询——入场类直显终值、转场类直切、
     粒子 L2-4 不播放、功能性反馈（ripple/shake）压至 --dur-1(120ms)；
   - 动画一律只动 transform/opacity（性能红线；canvas 粒子除外）。
   ============================================================ */

import { lerp, easeOutExpo, easeOutCubic, clamp01 } from "./motion-core.js";

/* ---------- motion token 读取（唯一取数口，禁止魔法数） ---------- */

function rootStyle() {
    return getComputedStyle(document.documentElement);
}

/* token 名 → 毫秒数；token 缺失/非法时返回 0（动画退化为瞬时完成，不报错）。 */
function durMs(name) {
    const v = parseFloat(rootStyle().getPropertyValue(name));
    return Number.isFinite(v) ? v : 0;
}

/* token 名 → easing 字符串（WAAPI 可直接使用）。 */
function easeCss(name) {
    const v = rootStyle().getPropertyValue(name).trim();
    return v || "linear";
}

/* ---------- 降级查询 ---------- */

/* prefers-reduced-motion（§3.5 降级总表统一查询点）。 */
export function reducedMotion() {
    return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
}

/* ---------- L1-4 count-up ---------- */

/* 元素上正在进行的 countUp rAF 句柄（WeakMap，不污染元素属性）。 */
const countUpRaf = new WeakMap();

/* countUp(el, to, {fmt, dur})
   - fmt: v => string，默认整数千分位（与《定稿》§7.2 骨架一致）；
   - dur: 毫秒，仅见 token（默认 --dur-4 = 600ms，L1-4 参数）；
   - 首帧同步写 fmt(from)：from = 元素 dataset.v 的既有记账值（首用为 0）；
     随后 easeOutExpo 滚动到 to，终点精确写 fmt(to)；
   - reduced：直显 fmt(to)（不滚动），仍写 dataset.v 记账；
   - dataset.v 记账：调用瞬间即写 String(to)——既是下一次 countUp 的 from 起点，
     也是 smoke A11 / 后续组件读取「目标值」的口径。 */
export function countUp(el, to, opts = {}) {
    if (!el) return;
    const target = Number(to);
    if (!Number.isFinite(target)) return;
    const fmt = typeof opts.fmt === "function" ? opts.fmt : (v) => Math.round(v).toLocaleString();
    const dur = typeof opts.dur === "number" && opts.dur >= 0 ? opts.dur : durMs("--dur-4");
    const from = Number(el.dataset.v) || 0;

    if (reducedMotion()) {
        el.textContent = fmt(target);
        el.dataset.v = String(target);
        return;
    }

    const prev = countUpRaf.get(el);
    if (prev) cancelAnimationFrame(prev);
    el.dataset.v = String(target); // 先记账，再动画（《定稿》§7.2 顺序）

    const start = performance.now();
    const frame = (now) => {
        const p = clamp01((now - start) / dur);
        const v = lerp(from, target, easeOutExpo(p));
        el.textContent = fmt(v);
        if (p < 1) {
            countUpRaf.set(el, requestAnimationFrame(frame));
        } else {
            countUpRaf.delete(el);
            el.textContent = fmt(target); // 终值精确落盘（避免浮点尾差）
        }
    };
    frame(start); // 首帧同步写 fmt(from)，防首帧空白
}

/* ---------- L2-1 ripple ---------- */

/* ripple(btn, ev)：主按钮点击注入扩散圆（450ms ease-out，token --dur-ripple）；
   reduced-motion 保留为 ≤--dur-1(120ms) 的功能反馈；无事件坐标时圆心取按钮中心。 */
export function ripple(btn, ev) {
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const x = ev && typeof ev.clientX === "number" ? ev.clientX - rect.left : rect.width / 2;
    const y = ev && typeof ev.clientY === "number" ? ev.clientY - rect.top : rect.height / 2;
    const d = Math.max(rect.width, rect.height) * 2;

    /* 按钮自身 position 为 static 时把圆锚到按钮内（不覆盖调用方已有定位）。 */
    const pos = getComputedStyle(btn).position;
    if (pos === "static") btn.style.position = "relative";

    const span = document.createElement("span");
    span.className = "pds-ripple";
    span.style.position = "absolute";
    span.style.left = (x - d / 2) + "px";
    span.style.top = (y - d / 2) + "px";
    span.style.width = span.style.height = d + "px";
    span.style.borderRadius = "50%";
    span.style.background = "currentColor";
    span.style.pointerEvents = "none";
    span.style.willChange = "transform, opacity";
    btn.appendChild(span);

    const anim = span.animate(
        [
            { transform: "scale(0)", opacity: 0.35 },
            { transform: "scale(1)", opacity: 0 },
        ],
        {
            duration: reducedMotion() ? durMs("--dur-1") : durMs("--dur-ripple"),
            easing: easeCss("--ease-out"),
            fill: "forwards",
        }
    );
    anim.finished.finally(() => span.remove());
}

/* ---------- L0-2 首屏入场 / L1-2 列表行 stagger ---------- */

/* staggerIn(els, {y, delay})：逐步 fadeUp(y px) 入场。
   单级 320ms（--dur-3）+ 级差 delay（默认 40ms，--dur-stagger-step；L1-2 列表行
   由调用方传 {y:8, delay:24}）；easing = --ease-out；reduced → 直显终值（不播）。
   返回全部完成后的 Promise（供 router 等编排方 await）。 */
export function staggerIn(els, opts = {}) {
    const list = Array.from(els || []);
    if (!list.length || reducedMotion()) return Promise.resolve();
    const y = typeof opts.y === "number" ? opts.y : 16;
    const step = typeof opts.delay === "number" && opts.delay >= 0 ? opts.delay : durMs("--dur-stagger-step");
    const anims = list.map((el, i) =>
        el.animate(
            [
                { opacity: 0, transform: "translateY(" + y + "px)" },
                { opacity: 1, transform: "translateY(0px)" },
            ],
            {
                duration: durMs("--dur-3"),
                easing: easeCss("--ease-out"),
                delay: i * step,
                fill: "backwards",
            }
        )
    );
    return Promise.all(anims.map((a) => a.finished.catch(() => {}))).then(() => undefined);
}

/* ---------- L0-5 页面转场 ---------- */

/* pageOut(el)：fadeSlide(-8px) 120ms（--dur-1）退场；结束时经 fill:forwards 保持隐藏，
   由后续 pageIn 接管；reduced → 直切（0ms ≤80ms 口径）。 */
export function pageOut(el) {
    if (!el) return Promise.resolve();
    if (reducedMotion()) return Promise.resolve();
    el.getAnimations().forEach((a) => a.cancel()); // 清掉被打断的旧转场
    const anim = el.animate(
        [
            { opacity: 1, transform: "translateY(0px)" },
            { opacity: 0, transform: "translateY(-8px)" },
        ],
        {
            duration: durMs("--dur-1"),
            easing: easeCss("--ease-out"),
            fill: "forwards",
        }
    );
    return anim.finished.catch(() => {});
}

/* pageIn(el)：fadeSlide(8px) 240ms（--dur-page-in）入场；reduced → 直显终值。
   首帧以内联 opacity:0 兜底（防换装后闪一帧），完成后清理内联样式。 */
export function pageIn(el) {
    if (!el) return Promise.resolve();
    if (reducedMotion()) return Promise.resolve();
    el.getAnimations().forEach((a) => a.cancel());
    el.style.opacity = "0";
    const anim = el.animate(
        [
            { opacity: 0, transform: "translateY(8px)" },
            { opacity: 1, transform: "translateY(0px)" },
        ],
        {
            duration: durMs("--dur-page-in"),
            easing: easeCss("--ease-out"),
            fill: "none",
        }
    );
    return anim.finished
        .catch(() => {})
        .then(() => {
            el.style.opacity = "";
        });
}

/* ---------- L3-1 下钻 FLIP / L3-8 全屏 FLIP ---------- */

/* flip(fromRect, el, {dur})：元素布局已变，从其旧包围盒（调用方先记录）飞回新位置。
   450ms ease-inout（--dur-flip / --ease-inout；L3-8 全屏可由调用方传 dur 覆盖）；
   实现为「内联逆向 transform + WAAPI 单关键帧回正」，完成后清理内联 transform；
   reduced → 直切。返回完成 Promise。 */
export function flip(fromRect, el, opts = {}) {
    if (!fromRect || !el) return Promise.resolve();
    if (reducedMotion()) return Promise.resolve();
    const to = el.getBoundingClientRect();
    if (!to.width && !to.height) return Promise.resolve();
    const dx = fromRect.left - to.left;
    const dy = fromRect.top - to.top;
    const sx = to.width ? fromRect.width / to.width : 1;
    const sy = to.height ? fromRect.height / to.height : 1;
    el.style.transform = "translate(" + dx + "px, " + dy + "px) scale(" + sx + ", " + sy + ")";
    const anim = el.animate(
        [{ transform: "translate(0px, 0px) scale(1, 1)" }],
        {
            duration: typeof opts.dur === "number" ? opts.dur : durMs("--dur-flip"),
            easing: easeCss("--ease-inout"),
            fill: "none",
        }
    );
    return anim.finished
        .catch(() => {})
        .then(() => {
            el.style.transform = "";
        });
}

/* ---------- L3-5 sparkline 趋势描线 ---------- */

/* sparkline(svg, path, {dur})：stroke-dashoffset 绘制 800ms（--dur-sparkline，ease-out）。
   重跑前取消旧动画；结束后内联样式清理（落回 CSS 规则）。reduced → 直接终态。
   终点脉冲为循环类动画，按 D5 属 CSS keyframes 职责，不在本函数内。 */
export function sparkline(svg, path, opts = {}) {
    if (!svg || !path) return;
    if (reducedMotion()) {
        path.style.strokeDashoffset = "0";
        path.style.strokeDasharray = "";
        return;
    }
    const length = path.getTotalLength();
    if (!length) return;
    path.getAnimations().forEach((a) => a.cancel());
    path.style.strokeDasharray = length + " " + length;
    path.style.strokeDashoffset = String(length);
    const anim = path.animate(
        [
            { strokeDashoffset: length },
            { strokeDashoffset: 0 },
        ],
        {
            duration: typeof opts.dur === "number" ? opts.dur : durMs("--dur-sparkline"),
            easing: easeCss("--ease-out"),
            fill: "none",
        }
    );
    anim.finished
        .then(() => {
            path.style.strokeDashoffset = "0";
            path.style.strokeDasharray = "";
        })
        .catch(() => {});
}

/* ---------- L2-4 完成庆祝粒子（treemap 特效层） ---------- */

/* confetti(canvas, {x, y, count})：单次 16 粒（--dur-4 600ms）迸发，结束后清空画布。
   颜色取 tokens 的 --primary/--accent/--success/--warning（随主题解析，无 hex 字面量）；
   reduced → 不播放（L2-4 降级）。返回完成 Promise。
   （「先 toast / 仅主页可见时播」为调用方编排职责，见 U3.2。） */
export function confetti(canvas, opts = {}) {
    if (!canvas) return Promise.resolve();
    if (reducedMotion()) return Promise.resolve();
    const ctx = canvas.getContext("2d");
    if (!ctx) return Promise.resolve();
    const css = rootStyle();
    const colors = ["--primary", "--accent", "--success", "--warning"]
        .map((n) => css.getPropertyValue(n).trim())
        .filter(Boolean);
    if (!colors.length) return Promise.resolve();
    const dur = durMs("--dur-4");
    const count = Math.floor(opts.count ?? 16);
    if (!count || !dur) return Promise.resolve();

    const w = canvas.width;
    const h = canvas.height;
    const cx = typeof opts.x === "number" ? opts.x : w / 2;
    const cy = typeof opts.y === "number" ? opts.y : h / 2;
    const parts = [];
    for (let i = 0; i < count; i++) {
        /* 上半扇形迸发 + 随机抖动（速度单位 px/s） */
        const base = Math.PI * (0.2 + 0.6 * (i / Math.max(1, count - 1)));
        const ang = base + (Math.random() - 0.5) * 0.5;
        const speed = 110 + Math.random() * 160;
        parts.push({
            vx: Math.cos(ang) * speed,
            vy: -Math.sin(ang) * speed,
            size: 3 + Math.random() * 4,
            rot: Math.random() * Math.PI,
            vr: (Math.random() - 0.5) * 12,
            color: colors[i % colors.length],
        });
    }

    const t0 = performance.now();
    return new Promise((resolve) => {
        const frame = (now) => {
            const p = clamp01((now - t0) / dur);
            const t = p * (dur / 1000);
            ctx.clearRect(0, 0, w, h);
            for (const pt of parts) {
                const x = cx + pt.vx * t;
                const y = cy + pt.vy * t + 250 * t * t; // 0.5*g*t²，g≈500px/s²
                ctx.save();
                ctx.translate(x, y);
                ctx.rotate(pt.rot + pt.vr * t);
                ctx.globalAlpha = 1 - p;
                ctx.fillStyle = pt.color;
                ctx.fillRect(-pt.size / 2, -pt.size / 2, pt.size, pt.size * 0.7);
                ctx.restore();
            }
            if (p < 1) {
                requestAnimationFrame(frame);
            } else {
                ctx.clearRect(0, 0, w, h);
                resolve();
            }
        };
        requestAnimationFrame(frame);
    });
}

/* ---------- L2-7 错误抖动 ---------- */

/* shake(el)：±4px × 3 次，320ms（--dur-3）；reduced 保留为 120ms（--dur-1）功能反馈。
   返回完成 Promise。 */
export function shake(el) {
    if (!el) return Promise.resolve();
    const anim = el.animate(
        [
            { transform: "translateX(0px)" },
            { transform: "translateX(-4px)" },
            { transform: "translateX(4px)" },
            { transform: "translateX(-4px)" },
            { transform: "translateX(4px)" },
            { transform: "translateX(-4px)" },
            { transform: "translateX(4px)" },
            { transform: "translateX(0px)" },
        ],
        {
            duration: reducedMotion() ? durMs("--dur-1") : durMs("--dur-3"),
            easing: easeCss("--ease-inout"),
        }
    );
    return anim.finished.catch(() => {});
}

/* ---------- L2-3 完成对勾描边 ---------- */

/* drawCheck(svgPath)：stroke-dashoffset 描边 400ms（--dur-draw-check，ease-out）；
   reduced → 直接终态；结束后内联样式清理。返回完成 Promise。 */
export function drawCheck(svgPath) {
    if (!svgPath) return Promise.resolve();
    if (reducedMotion()) {
        svgPath.style.strokeDashoffset = "0";
        svgPath.style.strokeDasharray = "";
        return Promise.resolve();
    }
    const length = svgPath.getTotalLength();
    if (!length) return Promise.resolve();
    svgPath.getAnimations().forEach((a) => a.cancel());
    svgPath.style.strokeDasharray = length + " " + length;
    svgPath.style.strokeDashoffset = String(length);
    const anim = svgPath.animate(
        [
            { strokeDashoffset: length },
            { strokeDashoffset: 0 },
        ],
        {
            duration: durMs("--dur-draw-check"),
            easing: easeCss("--ease-out"),
            fill: "none",
        }
    );
    return anim.finished
        .then(() => {
            svgPath.style.strokeDashoffset = "0";
            svgPath.style.strokeDasharray = "";
        })
        .catch(() => {});
}
