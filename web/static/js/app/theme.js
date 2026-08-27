/* ============================================================
   UI 2.0（SpaceLens Pro）· theme.js 主题体系（U2.0 从 app.js 迁入，L0-1）
   - 逐字迁自旧 app.js「U1.1 主题体系」段（THEME_KEY/currentTheme/switchTheme）；
   - 后续归并到 motion.js 实现落点的动作属于 U2.x 各组件接线（§3.5 落点注释）。
   ============================================================ */

/* 主题持久化键（§3.2 localStorage 键表）；初始解析在 index.html head 内联脚本
   （防闪烁：localStorage → prefers-color-scheme → light），本函数只负责切换。 */
export const THEME_KEY = "pds_theme_v1";

export function currentTheme() {
    const t = document.documentElement.getAttribute("data-theme");
    return t === "dark" ? "dark" : "light";
}

/* L0-1 主题圆形扩散：View Transitions 450ms ease-out 自点击处扩散；
   reduced-motion / 不支持 VT / 无事件坐标 → 直切（≤80ms 语义达标）。 */
export function switchTheme(next, ev) {
    const target = next === "dark" || next === "light" ? next : (currentTheme() === "dark" ? "light" : "dark");
    const root = document.documentElement;
    const apply = () => {
        root.setAttribute("data-theme", target);
        try { localStorage.setItem(THEME_KEY, target); } catch (e) { /* 隐私模式仅本次生效 */ }
    };
    const reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced || typeof document.startViewTransition !== "function" || !ev || typeof ev.clientX !== "number") {
        apply();
        return;
    }
    const x = ev.clientX;
    const y = ev.clientY;
    const maxR = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
    const vt = document.startViewTransition(apply);
    vt.ready.then(() => {
        document.documentElement.animate(
            { clipPath: ["circle(0px at " + x + "px " + y + "px)", "circle(" + maxR + "px at " + x + "px " + y + "px)"] },
            { duration: 450, easing: "ease-out", pseudoElement: "::view-transition-new(root)" }
        );
    }).catch(() => { /* 转场被打断时主题已生效 */ });
}
