/* ============================================================
   UI 2.0（SpaceLens Pro）· keyboard.js（U4.1 建 · 键盘矩阵接线，定稿 7.4）
   - 单键守卫统一（keys.js 共享守卫，与 Backspace（workspace.js）/R（modals.js）
     同口径）：/ 与 g 序列仅当 事件目标非输入框/非可编辑 且 e.isComposing 非真
     （中文输入法组词中一律忽略）且无弹窗打开时触发；
   - 窗口级一次绑定（main.js bindKeyboard；路由重挂不重复注册）；
   - 矩阵条目（本模块职责边界）：
     · `/` 聚焦筛选框 #browse-filter（仅工作台页存在；其他路由空守卫忽略——
       不切视图、不抢焦点）；⚠️ 偏差注记：手册「筛选行仅排行/表格视图可见」
       与源码不符——源码 .browse-filters 恒可见（U2.0 模板，无视图联动隐藏），
       故 / 直接聚焦即可（以源码为准；不切视图）；
     · `g c` / `g s` vim 风格连按跳页（首次 g 进 ~800ms 窗口，再按 c→#/compare、
       s→#/snapshots；超时/其他键/修饰键重置——手册「可选实现」，本项实现以
       核销 G4）；面板打开时忽略；
     · treemap 聚焦后 ↑↓←→ 最近邻移动焦点块（treemap.js moveFocus；
       仅 document.activeElement 位于 #treemap-wrap 内时消费——焦点不在
       矩形图容器时不抢，列表行/页面正常滚动不受影响）；
     · Enter 焦点块下钻（=单击语义，treemap.js activateFocus）；
   - 既有键不移入本模块：Ctrl/⌘K（palette-cmd.js）、Esc 弹窗栈/退全屏
     （modals.js / workspace.js）、Backspace 上级（workspace.js，守卫改用
     keys.js 同口径）；R 快捷刷新（modals.js）。
   ============================================================ */

import { $ } from "./api.js";
import { isTypingEvent } from "./keys.js";
import { hasOpenModal } from "./components/modals.js";
import { getTreemapView } from "./pages/workspace.js";

/* g 序列窗口（~800ms：首次 g 后窗口内再按 c/s 生效；超时重置） */
const G_SEQ_WINDOW_MS = 800;

let gActive = false;
let gAt = 0;
let gTimer = 0;

function cancelG() {
    gActive = false;
    gAt = 0;
    if (gTimer) { clearTimeout(gTimer); gTimer = 0; }
}

/* 单键/序列共同守卫：keys.js 打字态 + 弹窗栈（弹窗打开时不抢焦点/不触发跳页） */
function shortcutSafe(ev) {
    return !isTypingEvent(ev) && !hasOpenModal();
}

export function bindKeyboard() {
    document.addEventListener("keydown", (ev) => {
        const noMod = !ev.ctrlKey && !ev.metaKey && !ev.altKey;

        /* ---- g 序列（vim 风格连按；打字态/弹窗态：重置序列并忽略） ---- */
        if (noMod && ev.key === "g") {
            if (!shortcutSafe(ev)) { cancelG(); return; }
            ev.preventDefault();
            cancelG();
            gActive = true;
            gAt = performance.now();
            gTimer = setTimeout(cancelG, G_SEQ_WINDOW_MS);
            return;
        }
        if (gActive) {
            if (noMod && (ev.key === "c" || ev.key === "s")) {
                const within = performance.now() - gAt <= G_SEQ_WINDOW_MS;
                cancelG();
                if (within && shortcutSafe(ev)) {
                    ev.preventDefault();
                    location.hash = ev.key === "c" ? "#/compare" : "#/snapshots";
                }
                return;
            }
            cancelG(); // 其他键：序列重置（不消费；按键按自身语义继续）
        }

        /* ---- `/` 聚焦筛选框（仅工作台；空守卫=其他路由忽略不抢焦点） ---- */
        if (noMod && ev.key === "/") {
            if (!shortcutSafe(ev)) return;
            const input = $("browse-filter");
            if (!input) return;
            ev.preventDefault();
            input.focus();
            return;
        }

        /* ---- treemap 聚焦后：方向键最近邻移动焦点块 / Enter 单击语义下钻 ---- */
        if (ev.key === "ArrowUp" || ev.key === "ArrowDown" ||
            ev.key === "ArrowLeft" || ev.key === "ArrowRight" || ev.key === "Enter") {
            if (isTypingEvent(ev)) return; // 输入框/可编辑/isComposing：不消费
            const active = document.activeElement;
            const wrap = active && active.closest ? active.closest("#treemap-wrap") : null;
            if (!wrap) return; // treemap 未聚焦：不抢（列表行 Enter 由 list.js 处理）
            const view = getTreemapView();
            if (!view) return;
            if (ev.key === "Enter") {
                ev.preventDefault();
                view.activateFocus();
                return;
            }
            const dirs = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
            const d = dirs[ev.key];
            if (!d) return;
            ev.preventDefault();
            view.moveFocus(d[0], d[1]);
        }
    });
}
