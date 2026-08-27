/* ============================================================
   UI 2.0（SpaceLens Pro）· components/toast.js（U2.0 从 app.js 迁入）
   - toast 函数体逐字保留；动效升级 L2-6 属 U3.5，此处不预动。
   ============================================================ */

import { $ } from "../api.js";
import { ICONS } from "../icons.js";

export function toast(message, type, timeoutMs) {
    const kind = ["success", "warn", "error", "info"].includes(type) ? type : "info";
    const icons = { success: ICONS.success, warn: ICONS.warn, error: ICONS.error, info: ICONS.info };
    const el = document.createElement("div");
    el.className = "toast toast-" + kind;
    el.innerHTML =
        '<span class="toast-icon">' + icons[kind] + "</span>" +
        '<span class="toast-text"></span>' +
        '<button class="toast-close" title="关闭">' + ICONS.close + "</button>";
    el.querySelector(".toast-text").textContent = message;
    const remove = () => {
        if (!el.parentNode) return;
        el.classList.add("leaving");
        setTimeout(() => el.remove(), 200);
    };
    el.querySelector(".toast-close").addEventListener("click", remove);
    $("toast-container").appendChild(el);
    const ttl = timeoutMs || (kind === "error" ? 6500 : 4000);
    setTimeout(remove, ttl);
}
