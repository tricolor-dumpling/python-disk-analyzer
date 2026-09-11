/* ============================================================
   UI 2.0（SpaceLens Pro）· theme.js 主题体系（U2.0 模块化迁入，L0-1）
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
import { motionDur } from "./motion.js"; // 阶段E（E-3）：扩散时长读 token（禁魔法数）

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

/* L0-1 主题圆形扩散：View Transitions 扩散自点击处展开；
   reduced-motion / 不支持 VT / 无事件坐标 → 直切（≤80ms 语义达标）。
   阶段E（E-3）：连点防护——全局 only-one-VT 队列：
   ①每次新转场启动前，对仍激活的旧 VT 显式 skipTransition()（旧转场立即
     收敛终态，杜绝「旧 VT 被浏览器清理 → 整页瞬间切换」的一次性铺满帧）；
   ②clip-path 圆半径 maxR +16px 冗余（防滚动条/缩放抖动下圆未覆盖最远角），
     动画结束后移除内联 clip-path（终态不残留）；
   ③时长读 token --dur-theme-expand（tokens.css，禁 style.css/JS 魔法数）。
   P7（问题 10：D7-1/D7-2/D7-3）：
   ④**坐标空间对齐**：clip 作用在 `::view-transition-new(root)` 上，其参考盒是
     documentElement 的盒子，而 clientX/clientY 是**视口**坐标 —— 两者在滚动
     （scrollY≠0）或 html 有位移时不重合。改用 getBoundingClientRect() 换算：
     x = clientX - b.left、y = clientY - b.top、W/H = b.width/height，半径 ×1.02 + 16px；
   ⑤**消除一帧铺满**：WAAPI options 补 `fill:"forwards"` —— 否则动画结束时
     clip-path 计算值回到 `none`，未被圆覆盖的像素在**一帧内**全部变新主题
     （用户实测「底部触底后两端瞬间完成」）。伪元素随转场销毁，不残留终态；
   ⑥**伪坐标兜底**：键盘 Enter/Space 或 el.click() 产生的 click 事件
     `clientX=clientY=0` 且 `detail===0` —— 它不是「左上角」，而是「无坐标」；
     此时取触发元素（按钮/面板项/选项）矩形中心，取不到才直切。 */
let activeVT = null; // 全局 only-one-VT：当前激活转场引用（连点防护核心）
let vtTone = 0;      // 转场代次：异步回调只认最新代次（竞态兜底）

/* 事件 → 扩散原点（视口坐标）；null = 无可用坐标（直切）。
   P7（D7-3）：`detail===0 && clientX===0 && clientY===0` 视为伪坐标。 */
function resolveOrigin(ev) {
    if (!ev) return null;
    const hasNums = typeof ev.clientX === "number" && typeof ev.clientY === "number";
    const pseudo = ev.detail === 0 && ev.clientX === 0 && ev.clientY === 0;
    if (hasNums && !pseudo) return { clientX: ev.clientX, clientY: ev.clientY };
    const el = ev.currentTarget || ev.target;
    if (el && el.getBoundingClientRect && el.closest) {
        const target = el.closest("button, .palette-item, .theme-opt, [role=button]") || el;
        const r = target.getBoundingClientRect();
        if (r.width || r.height) return { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    }
    return null;
}

function applyThemeRaw(resolved, ev) {
    const root = document.documentElement;
    const apply = () => root.setAttribute("data-theme", resolved);
    const reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const origin = reduced || typeof document.startViewTransition !== "function" ? null : resolveOrigin(ev);
    if (!origin) {
        // 直切分支（reduced/不支持 VT/无坐标）——不触碰 VT 队列（直切无转场）
        apply();
        return;
    }
    // 连点防护：旧转场显式跳过（等其 ready 挂的动画一并终止），再启动新转场
    if (activeVT) {
        try { activeVT.skipTransition(); } catch (e) { /* 已结束的转场 skip 容错 */ }
        activeVT = null;
    }
    /* D7-1：clip 参考盒换算（clip 作用于 ::view-transition-new(root)，其参考盒是
       documentElement 的盒子；clientX/clientY 是视口坐标 → 滚动时必须减去盒原点）。 */
    const b = root.getBoundingClientRect();
    const x = origin.clientX - b.left;
    const y = origin.clientY - b.top;
    const W = b.width || root.clientWidth;
    const H = b.height || root.clientHeight;
    const maxR = Math.hypot(Math.max(x, W - x), Math.max(y, H - y)) * 1.02 + 16; // 2% + 16px 冗余（防滚动条/缩放抖动）
    const dur = motionDur("--dur-theme-expand") || 450; // token；缺失兜底 450ms（与旧行为等价）
    const tone = ++vtTone;
    const vt = document.startViewTransition(apply);
    activeVT = vt;
    const cleanup = () => {
        // 仅当仍是当前代次时清理（被更新的转场覆盖时由新转场接管清理）
        if (tone === vtTone) {
            document.documentElement.style.clipPath = "";
            activeVT = null;
        }
    };
    vt.ready.then(() => {
        if (tone !== vtTone) return; // 已被更新的转场打断：不挂动画（新转场负责）
        const anim = document.documentElement.animate(
            { clipPath: ["circle(0px at " + x + "px " + y + "px)", "circle(" + maxR + "px at " + x + "px " + y + "px)"] },
            { duration: dur, easing: "ease-out", fill: "forwards", pseudoElement: "::view-transition-new(root)" }
        );
        anim.finished.then(cleanup).catch(() => { /* 转场被打断时主题已生效 */ });
        /* D7-2 收尾：转场**完全结束**后取消该动画 —— 清掉 fill 填充态与动画对象
           （否则 `document.getAnimations()` 里会长期留一条已结束的 VT 动画，
           被 u62 的「无 VT 动画堆积」断言判红）。此刻伪元素已随转场销毁，
           取消不会造成任何渲染回退（铺满帧防护由动画存续期间承担）。 */
        vt.finished.then(() => { try { anim.cancel(); } catch (e) { /* 已取消 */ } })
            .catch(() => { try { anim.cancel(); } catch (e) { /* 已取消 */ } });
    }).catch(() => { /* 转场未 ready（被跳过/取消）——主题已生效，清理兜底 */ });
    // skipTransition 后的旧转场 finished 会 reject（AbortError）——统一兜底清理
    vt.finished.catch(() => { if (tone === vtTone) { document.documentElement.style.clipPath = ""; activeVT = null; } });
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
