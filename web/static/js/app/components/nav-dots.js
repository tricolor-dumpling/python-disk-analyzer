/* ============================================================
   UI 2.0（SpaceLens Pro）· components/nav-dots.js（U3.1 · N13 圆点提醒）
   - 独立叶子模块（零业务依赖、零环）：非活动导航标签的小圆点提醒；
   - markNavDot(route)：扫描完成/快照保存成功/对比完成三触发点直调
     （scan.js / compare.js 导入本模块——避免 scan↔topbar↔settings 环）；
   - 触发时若用户已停留在对应页则不挂点（提醒语义：停留在其他页时发生）；
   - 点击对应标签消除（bindNavDots）；pds:navigate 时同步显示（仅非活动标签可见）。
   ============================================================ */

import { $ } from "../api.js";
import { APP_STATE } from "../state.js";

const pendingDots = { "/": false, "/compare": false, "/snapshots": false };

function navRouteOf(tab) {
    const h = String(tab.getAttribute("href") || "").replace(/^#/, "");
    return h || "/";
}

export function markNavDot(route) {
    const r = String(route || "").replace(/^#/, "");
    if (!Object.prototype.hasOwnProperty.call(pendingDots, r)) return;
    if (APP_STATE.route === r) return; // 用户已在该页（触发条件：停留在其他页时发生）
    pendingDots[r] = true;
    renderDots();
}

function renderDots() {
    document.querySelectorAll(".nav-tabs .nav-tab").forEach((a) => {
        const r = navRouteOf(a);
        const dot = a.querySelector(".nav-dot");
        if (dot) dot.hidden = !(pendingDots[r] && APP_STATE.route !== r);
    });
}

/* 壳级绑定（bindTopbar 内调用一次）：点击标签消除 + 路由变化同步 */
export function bindNavDots() {
    document.querySelectorAll(".nav-tabs .nav-tab").forEach((a) => {
        a.addEventListener("click", () => {
            const r = navRouteOf(a);
            if (Object.prototype.hasOwnProperty.call(pendingDots, r)) {
                pendingDots[r] = false;
                renderDots();
            }
        });
    });
    window.addEventListener("pds:navigate", renderDots);
    renderDots();
}
