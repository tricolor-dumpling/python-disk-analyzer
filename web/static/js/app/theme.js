/* ============================================================
   UI 2.0（SpaceLens Pro）· theme.js 主题体系（U2.0 从 app.js 迁入，L0-1）
   - U3.5：三态偏好（亮/暗/跟随系统）——设置弹窗 F03/N03 语义；
     偏好持久化 pds_theme_v1（"light"|"dark"|"system"；缺失/非法 = system）；
     生效主题（data-theme）由偏好解析：system → matchMedia(prefers-color-scheme)，
     与 index.html head 防闪烁脚本三态解析一致（该脚本对非 light/dark 值一律
     matchMedia 解析 = 显式 "system" 与缺失 key 同路径）；
   - 红线语义不变（A1 断言语义）：data-theme 切换 / localStorage 写入 /
     reduced-motion 直切；switchTheme(next, ev) 签名与键值语义保持
     （next ∈ light|dark，非法入参=翻转当前生效主题）；
   - 同源联动：顶栏按钮（显式翻转）与设置弹窗三态单选共用本模块单一来源；
     设置弹窗开关、系统偏好变化均经 syncThemeControls 反映。
   ============================================================ */

import { APP_STATE } from "./state.js";

/* 主题持久化键（§3.2 localStorage 键表）；初始解析在 index.html head 内联脚本
   （防闪烁：localStorage → prefers-color-scheme → light），本模块只负责切换。 */
export const THEME_KEY = "pds_theme_v1";

export const THEME_PREFS = ["light", "dark", "system"];

function systemDark() {
    try {
        return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
    } catch (e) { /* 隐私/受限环境 */ }
    return false;
}

/* 偏好读取：localStorage → 缺失/非法回落 "system"（跟随系统=D4 首访口径）。 */
export function themePref() {
    let v = null;
    try { v = localStorage.getItem(THEME_KEY); } catch (e) { /* 隐私模式 */ }
    return THEME_PREFS.includes(v) ? v : "system";
}

/* 偏好 → 生效主题（"light"|"dark"；system 经 matchMedia 解析）。 */
export function resolvedTheme() {
    const p = themePref();
    return p === "system" ? (systemDark() ? "dark" : "light") : p;
}

/* 当前生效主题（data-theme 属性；旧语义保留——顶栏翻转/A1 依赖）。 */
export function currentTheme() {
    const t = document.documentElement.getAttribute("data-theme");
    return t === "dark" ? "dark" : "light";
}

/* 系统主题变化监听（仅偏好=system 时激活；跟随系统生效时实时切换）。 */
let sysListener = null;
function syncSystemListener(pref) {
    const mq = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)");
    if (!mq) return;
    if (pref === "system") {
        if (!sysListener) {
            sysListener = () => {
                if (themePref() !== "system") return;
                document.documentElement.setAttribute("data-theme", systemDark() ? "dark" : "light");
                syncThemeControls();
            };
            try { mq.addEventListener("change", sysListener); }
            catch (e) { try { mq.addListener(sysListener); } catch (e2) { /* ignore */ } }
        }
    } else if (sysListener) {
        try { mq.removeEventListener("change", sysListener); } catch (e) { /* ignore */ }
        sysListener = null;
    }
}

/* 设置弹窗三态单选回显（同源联动：改一处另一处反映；DOM 缺失容忍——壳级守卫）。 */
export function syncThemeControls() {
    const p = themePref();
    (["light", "dark", "system"]).forEach((v) => {
        const radio = typeof document !== "undefined" ? document.getElementById("setting-theme-" + v) : null;
        if (radio) radio.checked = p === v;
    });
}

/* L0-1 主题圆形扩散：View Transitions 450ms ease-out 自点击处扩散；
   reduced-motion / 不支持 VT / 无事件坐标 → 直切（≤80ms 语义达标）。 */
function applyThemeRaw(resolved, ev) {
    const root = document.documentElement;
    const apply = () => root.setAttribute("data-theme", resolved);
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

/* 三态设置入口（设置弹窗/顶栏/palette 共用单一来源）：
   pref ∈ light|dark|system；持久化 pds_theme_v1；生效主题=解析值；
   system 时激活 matchMedia 监听。 */
export function setThemePref(pref, ev) {
    const next = THEME_PREFS.includes(pref) ? pref : "system";
    APP_STATE.theme = next;
    try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* 隐私模式仅本次生效 */ }
    syncSystemListener(next);
    applyThemeRaw(resolvedTheme(), ev);
    syncThemeControls();
}

/* 兼容既有调用面（A1/palette/顶栏均不改签名）：next ∈ light|dark 显式写入；
   非法入参=翻转当前生效主题（旧语义）。 */
export function switchTheme(next, ev) {
    const target = next === "dark" || next === "light" ? next : (currentTheme() === "dark" ? "light" : "dark");
    setThemePref(target, ev);
}

/* 模块加载即同步 state.theme 与偏好（§3.2 契约；防闪烁头脚本已先行定 data-theme）；
   偏好=system 时立即挂 matchMedia 监听（页面重开/刷新后 OS 偏好变化仍实时跟随）。 */
APP_STATE.theme = themePref();
syncSystemListener(themePref());
