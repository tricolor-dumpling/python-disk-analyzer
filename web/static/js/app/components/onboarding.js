/* ============================================================
   UI 2.0（SpaceLens Pro）· components/onboarding.js（U2.0 从 app.js 迁入；U3.1 弹层化）
   - 首启引导弹层（F02）：4 步内容不变；GUIDE_KEY/showGuide/dismissGuide/loadGuide
     语义逐字保留（关闭记忆沿用 pds_onboarding_dismissed_v1）；
   - U3.1：DOM 由工作台 hero 卡迁出为壳级弹层（index.html #onboarding，
     入弹窗栈——Esc/背板关闭不持久化，关闭按钮=dismiss 持久化；「使用指引」重开
     入口走 showGuide，与顶栏 btn-guide 同一函数）。
   ============================================================ */

import { $ } from "../api.js";
import { openModal, closeModal } from "./modals.js";

export const GUIDE_KEY = "pds_onboarding_dismissed_v1";

export function showGuide() {
    openModal("onboarding");
}

export function dismissGuide() {
    closeModal("onboarding");
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

/* 本组件在 init 期的绑定（顺序等价：原 bind() 引导段；壳级绑定一次） */
export function bindOnboarding() {
    $("btn-onboarding-close").addEventListener("click", dismissGuide);
}
