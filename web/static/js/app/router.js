/* ============================================================
   UI 2.0（SpaceLens Pro）· router.js hash 路由（U2.1，§3.3/定稿§7.2 骨架）
   - 表驱动："/"|"/compare"|"/snapshots"；未知路由回落 "/"；
   - 转场 L0-5：pageOut(120ms) → 换装 → pageIn(240ms)，总时长 360ms（token 读取）；
     首渲染无转场（直装，避免首屏闪烁）；
   - 页面模块契约：render(state)→Node、mount()、unmount()（unmount 停自身 rAF/轮询；
     本阶段未启用）；转场期间 router 置 paused（U2.3 treemap 离场暂停的挂点）；
   - 事件：pds:navigate（detail {route,name}）；聚焦管理：切页后焦点移至页头标题
     （[data-page-title] 元素 tabindex=-1 + focus()）；
   - 页面注册表由 main.js（装配根）注入，本模块零业务依赖、零环。
   ============================================================ */

import { $ } from "./api.js";
import { APP_STATE } from "./state.js";
import { pageOut, pageIn } from "./motion.js";

export function createRouter(pages) {
    let active = null;    // { route, name, unmount }
    let busy = false;     // 转场互斥（快速连点导航串行化）
    let queued = null;    // 转场期间的最新目标
    let paused = false;

    function normalize(route) {
        const h = String(route || "").replace(/^#/, "");
        return Object.prototype.hasOwnProperty.call(pages, h) ? h : "/";
    }

    function currentRoute() {
        return normalize(location.hash);
    }

    function syncNavTabs(route) {
        document.querySelectorAll(".nav-tabs .nav-tab").forEach((a) => {
            const r = normalize(a.getAttribute("href"));
            const on = r === route;
            a.classList.toggle("is-active", on);
            if (on) a.setAttribute("aria-current", "page");
            else a.removeAttribute("aria-current");
        });
    }

    async function doTransition(route, first) {
        const view = $("route-view");
        const page = pages[route];
        const prev = active;
        if (prev && prev.unmount) {
            try { prev.unmount(); } catch (e) { /* 页面卸载失败不阻塞导航 */ }
        }
        paused = true;
        if (!first) await pageOut(view);   // L0-5 退场 120ms
        view.replaceChildren(page.render(APP_STATE));
        if (page.mount) page.mount();
        APP_STATE.route = route;
        syncNavTabs(route);
        if (!first) await pageIn(view);    // L0-5 入场 240ms
        paused = false;
        active = { route: route, name: page.name, unmount: page.unmount };
        // 焦点管理：页头标题（sr-only 亦可聚焦）
        const title = view.querySelector("[data-page-title]");
        if (title) {
            title.setAttribute("tabindex", "-1");
            try { title.focus(); } catch (e) { /* 不可聚焦时忽略 */ }
        }
        window.dispatchEvent(new CustomEvent("pds:navigate", { detail: { route: route, name: page.name } }));
    }

    async function transitionTo(raw) {
        const route = normalize(raw);
        if (busy) {
            queued = route; // 转场中只记最新目标，结束后补切
            return;
        }
        if (active && active.route === route) return; // 同路由忽略
        busy = true;
        try {
            await doTransition(route, false);
        } finally {
            busy = false;
            if (queued && queued !== APP_STATE.route) {
                const q = queued;
                queued = null;
                transitionTo(q);
            } else {
                queued = null;
            }
        }
    }

    function init() {
        const route = currentRoute();
        APP_STATE.route = route;
        syncNavTabs(route);
        // 首渲染：直装（无转场），页面挂载完成后由 start() 继续 init 链
        doTransition(route, true);
        window.addEventListener("hashchange", () => transitionTo(currentRoute()));
    }

    return {
        init: init,
        currentRoute: currentRoute,
        normalize: normalize,
        pause: () => { paused = true; },
        resume: () => { paused = false; },
        isPaused: () => paused,
    };
}

/* 便捷读档（A3/探针用）：当前 route 字符串 */
export function routeOf() {
    return APP_STATE.route;
}
