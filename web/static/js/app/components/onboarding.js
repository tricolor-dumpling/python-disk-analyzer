/* ============================================================
   UI 2.0（SpaceLens Pro）· components/onboarding.js（U2.0 模块化迁入；U3.1 弹层化）
   - 首启引导弹层（F02）：GUIDE_KEY/showGuide/dismissGuide/loadGuide
     语义逐字保留（关闭记忆沿用 pds_onboarding_dismissed_v1）；
   - U3.1：DOM 由工作台 hero 卡迁出为壳级弹层（index.html #onboarding，
     入弹窗栈——Esc/背板关闭不持久化，关闭按钮=dismiss 持久化；「使用指引」重开
     入口走 showGuide，与顶栏 btn-guide 同一函数）；
   - P5（D5-3）首开选盘：新增「选择要分析的盘」步骤。盘符选项**不在本文件硬编码**，
     由 components/drives.js 从后端 GET /api/roots 真枚举拉取后动态渲染（D5-4）；
     选中项 → saveSelectedRoots() 经 /api/settings 写入 last_roots，并立即回灌工作台
     浏览根输入框（用户点「开始全量扫描」时扫的就是它）。
     ⚠️ 本步骤**可跳过**：跳过路径不写设置、不改任何状态 —— 与既有默认逻辑
     （上次浏览 → 枚举首项 → 「请选择盘符」）完全等价（红线：首开不得阻塞）。
   ============================================================ */

import { $ } from "../api.js";
import { openModal, closeModal } from "./modals.js";
import { loadDrives, saveSelectedRoots, lastPickedRoots, driveLabel } from "./drives.js";

export const GUIDE_KEY = "pds_onboarding_dismissed_v1";

export function showGuide() {
    openModal("onboarding");
    renderRootPicker(); // 每次打开都刷新盘符（可能刚插了 U 盘）
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

/* ================= P5（D5-3）：选盘步骤渲染与接线 ================= */

let picked = [];        // 本次引导已选中的盘（多选）
let pickBound = false;  // 事件委托只绑一次（每次 showGuide 重渲内容，不重绑）

/* 选中变化 → 立即落盘 last_roots + 回灌工作台浏览根（选项 `#browse-root` 可能不在 DOM） */
async function commitPicked() {
    const res = await saveSelectedRoots(picked);
    if (!picked.length) return res;
    const first = picked[0];
    const input = $("browse-root");
    if (input) input.value = first;
    /* 工作台已挂载：同步模块级 root（工作台从 #browse-root 读值，空守卫即可） */
    try {
        const mod = await import("../pages/workspace.js");
        if (mod && typeof mod.setCurrentRoot === "function") mod.setCurrentRoot(first);
    } catch (e) { /* 工作台模块加载失败不影响选盘落盘 */ }
    return res;
}

function pickerHtml(drives) {
    if (!drives || !drives.length) {
        return '<span class="onboarding-roots-hint">未检测到可用盘符（可跳过，稍后在工具栏手动输入路径）</span>';
    }
    return drives
        .map((d) => {
            const label = driveLabel(d.root);
            const on = picked.some((p) => driveLabel(p) === label);
            const dis = d.ready === false;
            return (
                '<button type="button" class="onboarding-root' + (on ? " is-on" : "") + '"' +
                ' data-root="' + String(d.root).replace(/"/g, "&quot;") + '"' +
                (dis ? ' data-not-ready="1" aria-disabled="true"' : "") +
                ' aria-pressed="' + (on ? "true" : "false") + '"' +
                ' title="' + String(d.label || d.root).replace(/"/g, "&quot;") + '">' +
                "<b>" + label + "</b>" +
                '<span class="onboarding-root-state">' + (dis ? "未就绪" : "可用") + "</span>" +
                "</button>"
            );
        })
        .join("");
}

export async function renderRootPicker() {
    const host = $("onboarding-roots");
    if (!host) return 0;
    if (!pickBound) {
        pickBound = true;
        host.addEventListener("click", async (ev) => {
            const btn = ev.target.closest(".onboarding-root[data-root]");
            if (!btn) return;
            const root = btn.getAttribute("data-root");
            const label = driveLabel(root);
            if (picked.some((p) => driveLabel(p) === label)) {
                picked = picked.filter((p) => driveLabel(p) !== label); // 再点 = 取消选择
            } else {
                picked = picked.concat([root]);
            }
            const drives = await loadDrives();
            host.innerHTML = pickerHtml(drives);
            await commitPicked();
        });
        const skip = $("btn-onboarding-skip-root");
        if (skip) skip.addEventListener("click", () => onSkipRoot());
    }
    /* 已选记忆回显（上次选过 → 打开引导时直接勾上） */
    if (!picked.length) {
        const remembered = lastPickedRoots();
        if (remembered.length) picked = remembered.slice();
    }
    const drives = await loadDrives();
    host.innerHTML = pickerHtml(drives);
    return drives.length;
}

/* 「跳过选盘」：清空本次选择、不写设置；与既有默认逻辑等价（首开不阻塞）。
   仅切换本步骤的提示态——引导弹层**不关闭**（用户还要看后续步骤）。 */
export function onSkipRoot() {
    picked = [];
    const host = $("onboarding-roots");
    if (host) {
        host.innerHTML = '<span class="onboarding-roots-hint">已跳过：将按上次浏览的位置或第一个可用盘分析。' +
            '可在工作台工具栏随时改盘。</span>';
    }
}

/* 本组件在 init 期的绑定（顺序等价：原 bind() 引导段；壳级绑定一次） */
export function bindOnboarding() {
    $("btn-onboarding-close").addEventListener("click", dismissGuide);
    /* P5（D5-3）：盘符清单在弹层显示时**必然**去取一次（无论用户是否点选），
       以便首扫按钮与工作台默认根有真枚举可用（D5-4 的去魔法值前提）。 */
    loadDrives().then((drives) => {
        const host = $("onboarding-roots");
        if (host && !host.querySelector(".onboarding-root")) host.innerHTML = pickerHtml(drives);
    });
}

/* smoke/探针读取面：当前已选盘（只读副本） */
export function getPickedRoots() { return picked.slice(); }
