/* ============================================================
   UI 2.0（SpaceLens Pro）· components/toast.js（U2.0 模块化迁入）
   - U3.5·L2-6 全参数升级（驱动在 JS/WAAPI，样式在 style.css——同 compare.js
     L3-6 模式，参数可经 getAnimations 在 smoke 断言）：
     滑入 320ms spring（--dur-3/--ease-spring）+ 时间线（自动消失进度，
     transform scaleX，时长=TTL 动态）+ 成功描边 300ms（--dur-toast-stroke）
     + 错误脉动 2 次（--dur-toast-pulse=2×300ms，延迟至滑入结束）+ hover 暂停
     （计时器与时间线同步 pause/play）+ aria-live；
   - reduced 降级：滑入 ≤120ms（--dur-1）、装饰性脉动/描边跳过、
     功能保留（toast 仍出现/自动消失、时间线元素 DOM 一致）；
   - 既有调用方签名不变：toast(message, kind[, timeoutMs])；
   - 动画仅 transform/opacity；时长/缓动仅经 token 读取（禁魔法数；TTL=既有
     4000/6500ms 语义保留，为动态时长非动效 token）。
   ============================================================ */

import { $ } from "../api.js";
import { ICONS } from "../icons.js";
import { reducedMotion, motionDur, motionEase } from "../motion.js";

export function toast(message, type, timeoutMs) {
    const kind = ["success", "warn", "error", "info"].includes(type) ? type : "info";
    const icons = { success: ICONS.success, warn: ICONS.warn, error: ICONS.error, info: ICONS.info };
    const reduced = reducedMotion();
    const el = document.createElement("div");
    el.className = "toast toast-" + kind;
    el.innerHTML =
        '<span class="toast-icon">' + icons[kind] + "</span>" +
        '<span class="toast-text"></span>' +
        '<span class="toast-timeline" aria-hidden="true"></span>' +
        '<button class="toast-close" title="关闭">' + ICONS.close + "</button>";
    el.querySelector(".toast-text").textContent = message;
    const container = $("toast-container");
    if (container && !container.getAttribute("aria-live")) container.setAttribute("aria-live", "polite");
    if (!container || typeof container.appendChild !== "function") return;
    container.appendChild(el);

    // L2-6 滑入 320ms spring（--dur-3 + --ease-spring；reduced → --dur-1 ≤120ms 直切）
    const slideDur = motionDur(reduced ? "--dur-1" : "--dur-3") || (reduced ? 120 : 320);
    el.animate(
        [{ opacity: 0, transform: "translateX(24px)" }, { opacity: 1, transform: "none" }],
        { duration: slideDur, easing: reduced ? "ease-out" : motionEase("--ease-spring"), fill: "backwards" }
    );

    // 自动消失 TTL（既有语义：error 6500ms，其余 4000ms；显式传参优先）
    const ttl = timeoutMs || (kind === "error" ? 6500 : 4000);
    // 成功描边 300ms（--dur-toast-stroke；装饰性——reduced 跳过，DOM 一致保留）
    if (kind === "success") {
        const stroke = document.createElement("span");
        stroke.className = "toast-stroke";
        stroke.setAttribute("aria-hidden", "true");
        el.insertBefore(stroke, el.firstChild);
        if (!reduced) {
            stroke.animate(
                [{ opacity: 0 }, { opacity: 1 }],
                { duration: motionDur("--dur-toast-stroke") || 300, easing: "ease-out", fill: "forwards" }
            );
        }
    }
    // 错误脉动 2 次（--dur-toast-pulse=2×300ms；延迟至滑入结束避免与滑入抢
    // transform/opacity；装饰性——reduced 跳过）
    if (kind === "error" && !reduced) {
        el.animate(
            [
                { transform: "scale(1)", opacity: 1, offset: 0 },
                { transform: "scale(1.02)", opacity: 0.8, offset: 0.1 },
                { transform: "scale(1)", opacity: 1, offset: 0.2 },
                { transform: "scale(1.02)", opacity: 0.8, offset: 0.35 },
                { transform: "scale(1)", opacity: 1, offset: 0.5 }
            ],
            { duration: motionDur("--dur-toast-pulse") || 600, easing: "ease-out", delay: slideDur, fill: "none" }
        );
    }
    // 时间线（自动消失进度；transform scaleX 1→0；reduced 下样式层隐藏——功能保留）
    const timelineEl = el.querySelector(".toast-timeline");
    const tlAnim = timelineEl.animate(
        [{ transform: "scaleX(1)" }, { transform: "scaleX(0)" }],
        { duration: ttl, easing: "linear", fill: "forwards" }
    );
    if (reduced) tlAnim.pause(); // reduced：时间线无动画（CSS 层隐藏），计时仍走 JS

    let timer = null;
    const remove = () => {
        if (!el.parentNode || el.dataset.leaving) return;
        el.dataset.leaving = "1";
        el.classList.add("leaving"); // 兼容旧类名（外部断言/样式可引用）
        if (timer) { clearTimeout(timer); timer = null; }
        try { tlAnim.cancel(); } catch (e) { /* ignore */ }
        el.animate(
            [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateX(16px)" }],
            { duration: motionDur(reduced ? "--dur-1" : "--dur-2") || (reduced ? 120 : 200),
              easing: "ease-out", fill: "forwards" }
        ).onfinish = () => el.remove();
        setTimeout(() => el.remove(), 400); // 兜底（动画被中断/环境异常时防残留）
    };
    el.querySelector(".toast-close").addEventListener("click", remove);

    // 自动消失 + hover 暂停（计时器与时间线同步 pause/play）
    const deadline = Date.now() + ttl;
    timer = setTimeout(remove, ttl);
    el.addEventListener("mouseenter", () => {
        if (timer) { clearTimeout(timer); timer = null; }
        try { tlAnim.pause(); } catch (e) { /* ignore */ }
    });
    el.addEventListener("mouseleave", () => {
        if (!reduced) { try { tlAnim.play(); } catch (e) { /* ignore */ } }
        if (timer) return;
        timer = setTimeout(remove, Math.max(0, deadline - Date.now()));
    });
}
