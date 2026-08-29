/* ============================================================
   UI 2.0（SpaceLens Pro）· components/modals.js（U2.0 从 app.js 迁入）
   - 弹窗管理（§3.6 机制 #9：Esc 逆序关栈顶 + Tab 循环 + R 守卫）与
     通用确认弹窗（confirmDialog，映射表「通用 confirm」落点）逐字保留；
   - ⚠️ 偏差注记：映射表「components/settings + 通用 confirm」——
     confirm 与弹窗栈耦合（closeModal 冻结 resolve(false)），
     迁移期与弹窗管理同放本模块；U3.5 弹窗族收尾时可再拆。
   ============================================================ */

import { $ } from "../api.js";
import { browsePath, getCurrentPath } from "../pages/workspace.js"; // R 快捷刷新（弹窗关闭时回接浏览）

export let confirmResolver = null;

let modalStack = []; // 栈顶 = 最新打开的弹窗
const _MODAL_FOCUS_RESTORE = {}; // id -> 打开前的活动元素（关闭时归还）

const FOCUSABLE_SELECTOR =
    'button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],[tabindex="0"]';

export function openModal(id) {
    const el = $(id);
    if (!el) return;
    if (!modalStack.includes(id)) {
        modalStack.push(id);
        try { _MODAL_FOCUS_RESTORE[id] = document.activeElement; } catch (e) { /* ignore */ }
        el.classList.remove("hidden");
        const panel = el.querySelector(".modal-panel");
        if (panel) {
            const first = panel.querySelector(FOCUSABLE_SELECTOR);
            if (first) first.focus();
        }
    }
}

export function closeModal(id) {
    const el = $(id);
    if (el) el.classList.add("hidden");
    modalStack = modalStack.filter((x) => x !== id);
    const restore = _MODAL_FOCUS_RESTORE[id];
    delete _MODAL_FOCUS_RESTORE[id];
    try { if (restore && typeof restore.focus === "function") restore.focus(); } catch (e) { /* ignore */ }
    // confirmResolver Promise 语义冻结：confirm-modal 关闭即 resolve(false)
    if (id === "confirm-modal" && confirmResolver) {
        const resolve = confirmResolver;
        confirmResolver = null;
        resolve(false);
    }
    // U3.1：面板等浮层状态标志联动（palette-cmd 订阅；additive，不改变栈语义）
    try { window.dispatchEvent(new CustomEvent("pds:overlay-close", { detail: { id: id } })); } catch (e) { /* ignore */ }
}

export function hasOpenModal() {
    return modalStack.length > 0;
}

/* U3.1：面板/浮层判断自身是否为栈顶（Ctrl+K 关面板仅当面板在栈顶；其他弹窗上层时忽略） */
export function isTopModal(id) {
    return modalStack.length > 0 && modalStack[modalStack.length - 1] === id;
}

/* K1 焦点陷阱：Tab/Shift+Tab 在栈顶弹窗面板内循环，焦点不外逸 */
export function trapModalFocus(ev) {
    if (ev.key !== "Tab" || !modalStack.length) return;
    const topId = modalStack[modalStack.length - 1];
    const topEl = $(topId);
    const panel = topEl && topEl.querySelector(".modal-panel");
    if (!panel) return;
    const focusables = Array.from(panel.querySelectorAll(FOCUSABLE_SELECTOR))
        .filter((el) => el.offsetParent !== null || el === document.activeElement);
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    ev.preventDefault(); // 统一接管 Tab 行为
    if (!panel.contains(active)) {
        first.focus();
    } else if (ev.shiftKey && active === first) {
        last.focus();
    } else if (!ev.shiftKey && active === last) {
        first.focus();
    } else {
        // 面板内正常移动：交给默认行为已被 preventDefault 接管，手动推进
        const idx = focusables.indexOf(active);
        const next = ev.shiftKey ? (idx - 1 + focusables.length) % focusables.length
                                 : (idx + 1) % focusables.length;
        focusables[next].focus();
    }
}

export function bindModalClose() {
    document.querySelectorAll("[data-close]").forEach((btn) => {
        btn.addEventListener("click", () => closeModal(btn.getAttribute("data-close")));
    });
    // 点击遮罩关闭
    document.querySelectorAll(".modal").forEach((modal) => {
        modal.addEventListener("mousedown", (ev) => {
            if (ev.target === modal) closeModal(modal.id);
        });
    });
    // K2/K3：快捷键守卫与 Esc 关栈顶（废除写死数组顺序）
    document.addEventListener("keydown", (ev) => {
        // U3.1：Ctrl/⌘K 语义移交命令面板（palette-cmd.js 接管——定稿 N02），
        // 本处理器不再消费；原「弹窗开着时忽略」守卫由 palette-cmd.hasOpenModal 保持。
        trapModalFocus(ev); // Tab 循环（仅在弹窗开启时接管）
        if (ev.key.toLowerCase() === "r" && !/input|textarea|select/i.test(document.activeElement.tagName)) {
            if (modalStack.length) return; // 弹窗开着时忽略 R 快捷刷新
            ev.preventDefault();
            browsePathForRefresh();
            return;
        }
        if (ev.key !== "Escape") return;
        if (modalStack.length) {
            ev.preventDefault();
            closeModal(modalStack[modalStack.length - 1]); // 关栈顶（逆序）
        }
    });
}

/* R 快捷刷新（弹窗关闭时）：经访问器隔离跨模块状态（原为 browsePath(currentPath)）。 */
function browsePathForRefresh() {
    browsePath(getCurrentPath());
}

export function confirmDialog(options) {
    const opts = options || {};
    $("confirm-title").textContent = opts.title || "确认操作";
    $("confirm-text").textContent = opts.text || "确定继续吗？";
    const okBtn = $("btn-confirm-ok");
    okBtn.textContent = opts.okLabel || "确定";
    okBtn.className = "btn " + (opts.okClass || "btn-danger");
    openModal("confirm-modal"); // P12·W2.6（K1/K2）：入栈管理
    return new Promise((resolve) => {
        confirmResolver = resolve;
    });
}

export function resolveConfirm(value) {
    if (confirmResolver) {
        const resolve = confirmResolver;
        confirmResolver = null;
        closeModal("confirm-modal");
        resolve(value);
    }
}

/* 本组件在 init 期的绑定（顺序等价：原 bind() 的确认弹窗段 + bindModalClose） */
export function bindModals() {
    // 确认弹窗
    $("btn-confirm-ok").addEventListener("click", () => resolveConfirm(true));
    $("btn-confirm-cancel").addEventListener("click", () => resolveConfirm(false));
    bindModalClose();
}
