/* ============================================================
   UI 2.0（SpaceLens Pro）· components/onboarding.js（U2.0 从 app.js 迁入）
   - 首启引导折叠条（hero）：GUIDE_KEY/showGuide/dismissGuide/loadGuide 逐字保留；
   - U3.1 升级为弹层时仅换壳，行为不变。
   ============================================================ */

import { $ } from "../api.js";

export const GUIDE_KEY = "pds_onboarding_dismissed_v1";

export function showGuide() {
    $("onboarding").classList.remove("hidden");
}

export function dismissGuide() {
    $("onboarding").classList.add("hidden");
    try {
        localStorage.setItem(GUIDE_KEY, "1");
    } catch (e) { /* localStorage 不可用时仅本次隐藏 */ }
}

export function loadGuide() {
    let dismissed = false;
    try {
        dismissed = !!localStorage.getItem(GUIDE_KEY);
    } catch (e) { /* ignore */ }
    if (!dismissed) showGuide();
}

/* 本组件在 init 期的绑定（顺序等价：原 bind() 引导段） */
export function bindOnboarding() {
    $("btn-onboarding-close").addEventListener("click", dismissGuide);
}
