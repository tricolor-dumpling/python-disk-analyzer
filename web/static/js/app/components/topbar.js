/* ============================================================
   UI 2.0（SpaceLens Pro）· components/topbar.js（U2.0 模块化迁入；U3.1 顶栏改版）
   - 顶栏徽章与引导态（§3.6 机制 #4/#8/#10）：
     refreshHealth / showBrowseGuide / hideBrowseGuide / evaluateEnvGate 逐字保留；
   - U3.1：
     · [N13] L2-11 导航下划线（#nav-underline：translateX+scaleX 240ms ease-inout，
       仅 transform 动画——宽度差经 scaleX 补偿，等价「translateX+width」滑动；
       pds:navigate 与 resize 时同步，reduced 由全局降级规则直切）；
     · [N13] 非活动标签圆点提醒（markNavDot：扫描完成/快照保存成功/对比完成三触发，
       触发时用户不在对应页才挂点；点击对应标签消除；pds:navigate 时同步显示）；
     · [F01] 徽章三态（N11 文案）呼吸 L2-8 + 点击 popover（数据目录/驱动状态/
       重试环境检测=红线 #8 evaluateEnvGate 第二求值点：重试只重评门控，
       15s 轮询只刷徽章不重评——语义保留；视图区引导条按定稿 6.3 保留，A8 不动）。
   ============================================================ */

import { $, api } from "../api.js";
import { APP_STATE } from "../state.js";
import { openModal, closeModal } from "./modals.js";
import { getDataDir } from "./settings.js";
import { bindNavDots } from "./nav-dots.js"; // U3.1：N13 圆点（叶子模块，防环）
import { browsePath, getCurrentRoot, getStartupBrowsePath } from "../pages/workspace.js";
import { showGuide } from "./onboarding.js";
import { setStatus } from "./statusbar.js";

export async function refreshHealth() {
    const badge = $("health-badge");
    try {
        const data = await api("/api/health");
        APP_STATE.health = data;
        // P12·W2.1：busy ≠ 未就绪——busy 时保持现有徽章 class 不降级＋中性文本
        if (data.ready) {
            badge.className = "badge badge-ok";
            $("health-text").textContent = "已就绪·可开始扫描"; // U3.1：N11 文案统一
            badge.title = data.dll ? "Everything DLL：" + data.dll : "";
        } else if (data.busy) {
            /* 阶段B（B-18）：busy 文案按 lock_holder 细分——全量扫描进行中（x/y 盘）
               可跳转扫描卡；对比/浏览占用显示占用方名称。busy ≠ 未就绪（RT-02，
               ready/busy 语义零变更，仅文案细化）。 */
            const holder = data.lock_holder || "";
            const since = data.lock_since ? "（" + String(data.lock_since).replace("T", " ").replace(/:\d+$/, "") + " 起）" : "";
            let text = "扫描中…";
            let title = "扫描中：" + (data.reason || "scanning");
            if (holder === "fullscan") {
                const st = APP_STATE.scan || {};
                text = "全量扫描进行中" + (Number.isFinite(Number(st.progress_pct))
                    ? "（" + Number(st.done || 0) + "/" + (Number(st.roots && st.roots.length) || 0) + " 盘）"
                    : "");
                title = "正在全量扫描" + since + "，点击查看进度";
            } else if (holder === "compare") {
                text = "对比占用中";
                title = "对比正在后台扫描" + since;
            } else if (holder === "browse") {
                text = "浏览扫描占用中";
                title = "浏览正在直扫" + since;
            } else if (holder) {
                text = holder + " 占用中";
                title = holder + " 正在使用扫描引擎" + since;
            }
            $("health-text").textContent = text;
            badge.title = title;
            /* busy ≠ 未就绪（RT-02 / A8 红线）：busy 分支绝不降级徽章 class——
               保持既有 class 原状（ready 分支才置 ok；非 busy 未就绪才置 warn） */
        } else {
            badge.className = "badge badge-warn";
            $("health-text").textContent = data.message || "Everything 未就绪";
            badge.title = data.dll ? "Everything DLL：" + data.dll : "";
        }
        return data; // P12·W1.3：门控求值需要完整 health 载荷
    } catch (e) {
        badge.className = "badge badge-err";
        $("health-text").textContent = "健康检查失败";
        return null;
    }
}

export function showBrowseGuide(h) {
    const box = $("browse-guide");
    if (!box) return;
    let title = "Everything 尚未就绪";
    let msg = "正在等待 Everything 就绪，正在加载索引，最长约 20 秒，请勿重复点击。";
    if (h && h.degraded === "not_installed") {
        title = "未检测到 Everything";
        msg = (h.message || "未检测到 Everything") + "；安装并启动后点击「重试环境检测」。";
    } else if (h && h.degraded === "dll") {
        title = "SDK DLL 缺失";
        msg = (h.message || "SDK DLL 缺失或配置失效") + "；请确认程序目录包含 everything-SDK\\dll 后重试。";
    } else if (h && h.degraded === "config") {
        title = "配置文件损坏";
        msg = (h.message || "配置文件损坏") + "；可在数据目录修复 config.json 后重试。";
    } else if (h && h.busy) {
        title = "扫描进行中";
        msg = h.message || "全量扫描进行中，完成后即可浏览。";
    }
    $("guide-title").textContent = title;
    $("guide-msg").textContent = msg;
    box.classList.remove("hidden");
}

export function hideBrowseGuide() {
    const box = $("browse-guide");
    if (box) box.classList.add("hidden");
}

/* 环境门控（RT-02 边界）：只在首次加载与「重试环境检测」两处求值；
   15s 轮询只刷徽章、绝不重评本门控。ready → 自动浏览首根；否则进引导态。
   阶段D（D-1）：ready 分支追加自动扫描触发派发——autoScanEligible 为
   main.js 预检的「无当日快照会话」信号（true=可评估自动扫描）；事件由
   main.js 监听（tryAutoStartFullscan 做最终幂等判定：保护键/运行态/结果态）。
   启动时序（D-1 冷启动竞态修复）：自动扫描与启动浏览必须避免在同一瞬间竞争
   SDK 锁（真机实测：并发触发产生 5×409 browse console 噪声）——当自动扫描
   可评估时，**先派发自动扫描（拿锁）**，把启动浏览延后到扫描完成后（走索引，
   零 409）；不可评估时保持既有立即浏览（u20 网络时序不变）。 */
export function evaluateEnvGate(h, autoScanEligible) {
    if (!h) {
        showBrowseGuide(null);
        return;
    }
    if (h.ready) {
        hideBrowseGuide();
        const startup = getStartupBrowsePath();
        const target = (startup && startup.path) || getCurrentRoot() || "D:\\";
        /* 阶段F（R6）回归修复：启动（首根）浏览是工作台专属行为——browsePath 会
           操作工作台 DOM（#dir-body / #browse-root 等），冷启动直达 #/compare 或
           #/snapshots 时这些容器不在 DOM，无条件 browse 触发 null 解引用
           （"Cannot set properties of null (setting 'innerHTML'/'value')" 未处理
           运行时错误，console 0 纪律）。仅在当前路由为工作台（"/"）时触发；
           非工作台路由不发起启动浏览（该页无浏览容器，恢复上次浏览位置在切回
           工作台时由既有工作台挂载路径完成——零行为变化、零额外请求）。 */
        const onWorkspace = APP_STATE.route === "/";
        if (autoScanEligible === true) {
            /* 冷启动自动扫描路径：先派发扫描（SDK 锁由扫描持有），再延后浏览。
               pds:browse-after-scan 由 scan.js 完成边沿（result_ready）触发，
               browse 命中全量索引 → 零 409、零重复 SDK 直扫（u20 纪律）。 */
            window.addEventListener("pds:browse-after-scan", function onBrowse() {
                window.removeEventListener("pds:browse-after-scan", onBrowse);
                if (APP_STATE.route === "/") browsePath(target, true);
            }, { once: true });
            try { window.dispatchEvent(new CustomEvent("pds:auto-scan-start")); } catch (e) { /* ignore */ }
        } else if (onWorkspace) {
            /* F06（U4.2 G1 核销）：启动恢复上次浏览位置——优先恢复路径，缺失回落首根/默认 D:\；
               恢复路径与旧「首根浏览」共用同一次 browse 调用（Network 时序不变，零额外请求） */
            browsePath(target, true);
        }
    } else {
        showBrowseGuide(h);
    }
}

/* ================= U3.1：L2-11 导航下划线（仅 transform 动画） ================= */

export function syncNavUnderline() {
    const ul = $("nav-underline");
    if (!ul) return;
    const tabs = Array.from(document.querySelectorAll(".nav-tabs .nav-tab"));
    const active = tabs.find((a) => a.classList.contains("is-active"));
    if (!active || !tabs.length) return;
    const maxW = Math.max.apply(null, tabs.map((a) => a.offsetWidth).concat([1]));
    const w = active.offsetWidth;
    ul.style.width = maxW + "px";
    ul.style.transform = "translateX(" + active.offsetLeft + "px) scaleX(" + (w / maxW) + ")";
}

/* ================= U3.1：N13 圆点提醒 =================
   （markNavDot/renderDots/bindNavDots 在独立叶子模块 nav-dots.js——
   scan.js/compare.js 直接导入该模块触发，避免 scan↔topbar↔settings 模块环） */

/* ================= U3.1：F01 徽章 popover ================= */

function renderPopover(h) {
    $("popover-data-dir").textContent = getDataDir() || "未知";
    $("popover-health").textContent = h
        ? (h.message || (h.ready ? "已就绪·可开始扫描" : "Everything 未就绪"))
        : "健康检查失败";
    $("popover-health-dll").textContent = (h && h.dll) ? h.dll : "";
}

export function openHealthPopover() {
    renderPopover(APP_STATE.health);
    openModal("health-popover");
}

function closeHealthPopover() {
    closeModal("health-popover");
}

async function retryEnvGate() {
    const btn = $("btn-popover-retry");
    if (btn) btn.disabled = true;
    setStatus("browse-status", "busy", "正在重试环境检测…");
    const h = await refreshHealth();
    renderPopover(h);
    evaluateEnvGate(h); // 红线 #8：重试=门控第二求值点（与视图区引导条重试一致）
    if (btn) btn.disabled = false;
}

/* 本组件在 init 期的绑定（顺序等价：原 bind() 的引导/徽章段；壳级） */
export function bindTopbar() {
    $("btn-guide").addEventListener("click", showGuide);
    // 健康徽章 → popover（U3.1；旧 openSettings 入口由设置按钮承担）
    $("health-badge").addEventListener("click", () => {
        if ($("health-popover").classList.contains("hidden")) openHealthPopover();
        else closeHealthPopover();
    });
    $("btn-popover-retry").addEventListener("click", retryEnvGate);
    // [N13] 圆点：点击对应标签消除 + 路由变化同步（nav-dots 叶子模块）
    bindNavDots();
    // [N13] 下划线随路由与布局变化同步
    window.addEventListener("pds:navigate", syncNavUnderline);
    window.addEventListener("resize", syncNavUnderline);
    // 首帧布局完成后同步一次（字体/布局稳定兜底；pds:navigate 先行）
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(syncNavUnderline);
}

/* 引导态重试/帮助按钮：位于工作台页（route-view 渲染内容），随页挂载 */
export function bindWorkspaceGuide() {
    // P12·W1.3 引导态：重试环境检测（门控第二求值点）与查看指引
    const guideRetry = $("btn-guide-retry");
    if (guideRetry) guideRetry.addEventListener("click", async () => {
        setStatus("browse-status", "busy", "正在重试环境检测…");
        const h = await refreshHealth();
        evaluateEnvGate(h);
    });
    const guideHelp = $("btn-guide-help");
    if (guideHelp) guideHelp.addEventListener("click", showGuide);
}

/* [N13] 导航标签（顶栏壳级）：<a href="#/compare"> 原生锚点行为即为唯一接线
   （hashchange → router 转场；激活态由 router 于 pds:navigate 维护）；
   下划线滑动动效（L2-11）已由上 段接线（syncNavUnderline）。 */
