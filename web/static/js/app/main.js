/* ============================================================
   UI 2.0（SpaceLens Pro）· main.js 入口装配（U2.0 建，U2.1 路由化）
   - 装配顺序：壳级绑定（顶栏/主题/设置/弹窗族）
     → router 初始化（首渲染当前路由，默认工作台直装）
     → 工作台页挂载（页面内容绑定）
     → 原 init 异步链（偏好/快照/扫描轮询/概览/健康门控）；
   - 页面注册表在此注入 router（装配根，router 零业务依赖、模块图无环）；
   - smoke 页导入面另行导出（选择器不变因 id 未变）。
   ============================================================ */

import { $, api } from "./api.js";
import { APP_STATE } from "./state.js";
import { switchTheme } from "./theme.js";
import { createRouter } from "./router.js";
import { loadGuide, bindOnboarding } from "./components/onboarding.js";
import { refreshOverview, bindOverview } from "./components/storage.js";
import { bindSnapshotMini, renderCompareMini } from "./components/snapshot-mini.js";
import {
    bindWorkspace, renderEntries, browsePath,
    getCurrentRoot, getCurrentPath, getLastRoots, setCurrentRoot, applyLastRoots,
    renderWorkspace, unmountWorkspace, restoreWorkspaceView,
    getTreemapView, getTreemapTiles, setMergeTop, renderTreemapFromState,
} from "./pages/workspace.js";
import { evaluateEnvGate, refreshHealth, bindTopbar, bindWorkspaceGuide } from "./components/topbar.js";
import { pollFullscan, setAutoSaveSetting, undoLastSave, bindScan, applyScanView } from "./components/scan.js";
import { refreshSnapshots, getSessionsCache, setSessionsCache, applySnapshotsView } from "./pages/snapshots.js";
import { bindCompare, renderCompare, mountCompare, unmountCompare } from "./pages/compare.js";
import { renderSnapshots, mountSnapshots, unmountSnapshots } from "./pages/snapshots.js";
import { bindSettings, setDataDir, setStatusForSettingsHealth } from "./components/settings.js";
import { bindModals, openModal, closeModal } from "./components/modals.js";
import { renderApiError } from "./components/feedback.js";

/* 主题按钮（U1.1 临时入口：U3.1 顶栏改版时移正） */
function bindTheme() {
    const themeBtn = $("btn-theme");
    if (themeBtn) themeBtn.addEventListener("click", (ev) => switchTheme(undefined, ev));
}

/* 工作台页挂载（页面内容绑定集合 = 原 bind() 的页面段；组成见 U2.0 注记）
   随后从模块级状态回灌视图（切页不丢：状态与显示均保持）。
   概览刷新仅回挂路径执行——首挂仍由 start() 的 init 链按历史时序
   （settings→snapshots→status→overview→health→browse）负责，
   保证 Network 时序与重构前一致（验收①）。 */
let _workspaceMountedOnce = false;
function mountWorkspacePage() {
    bindOnboarding();
    bindOverview();
    bindWorkspace();
    bindScan();
    bindCompare();
    bindSnapshotMini();   // U2.4：管理快照/全部会话折叠/最近对比入口
    renderCompareMini();  // U2.4：最近对比迷你卡（state.compare.lastSummary 回灌）
    bindWorkspaceGuide();
    if (_workspaceMountedOnce) refreshOverview();
    applySnapshotsView();     // 快照列表/基线下拉回灌（含 N06 迷你条目）
    applyScanView();          // 扫描卡最近状态回灌
    restoreWorkspaceView();   // 浏览视图回灌（缓存渲染，不重发请求）
    _workspaceMountedOnce = true;
}

/* 页面注册表（router 由 main 装配，保持 router 零业务依赖） */
const pages = {
    "/": { name: "workspace", render: renderWorkspace, mount: mountWorkspacePage, unmount: unmountWorkspace },
    "/compare": { name: "compare", render: renderCompare, mount: mountCompare, unmount: unmountCompare },
    "/snapshots": { name: "snapshots", render: renderSnapshots, mount: mountSnapshots, unmount: unmountSnapshots },
};
const router = createRouter(pages);

export function __router() { return router; }

/* 启动：壳绑定 → 路由初始化（首渲染）→ 工作台挂载 → 原 init 链 */
export async function start() {
    bindTopbar();
    bindTheme();
    bindSettings();
    bindModals();
    router.init();
    loadGuide();

    // 读取偏好（自动保存开关 + 最近浏览）
    try {
        const data = await api("/api/settings");
        setAutoSaveSetting(!!data.settings.auto_save);
        setDataDir(data.data_dir || "");
        const roots = data.settings.last_roots;
        if (Array.isArray(roots) && roots.length) {
            applyLastRoots(roots.slice(0, 5));
        }
    } catch (e) { /* 设置读取失败不影响使用 */ }

    refreshSnapshots();
    pollFullscan(); // 页面刷新后也能恢复「扫描中」状态
    refreshOverview();

    const firstRoot = getLastRoots()[0] || "D:\\";
    setCurrentRoot(firstRoot);
    $("browse-root").value = firstRoot;

    // P12·W1.3 init 门控（RT-02 边界：仅首拍求值；替换旧的无条件浏览）：
    // ready → 自动浏览首根；未就绪 → 引导态。15s 轮询只刷徽章不重评门控。
    const h = await refreshHealth();
    evaluateEnvGate(h);

    setInterval(refreshHealth, 15000);
}

start();

/* ================= smoke 页导入面（行为等价；选择器不变因 id 未变） =================
   按需导出：旧全局写法（window.switchTheme 等）改为显式导入；smoke 断言经
   访问器读取/恢复状态（getSessionsCache/setSessionsCache、getCurrentPath）。
   U2.2：treemap 访问器（A12 命中断言 + 附录B 1000 块基准控制台桥）。 */
export {
    $, APP_STATE, switchTheme,
    renderApiError, refreshSnapshots, refreshHealth, setStatusForSettingsHealth,
    undoLastSave, renderEntries, openModal, closeModal, browsePath,
    getCurrentPath, getSessionsCache, setSessionsCache,
    getTreemapView, getTreemapTiles, setMergeTop, renderTreemapFromState,
};
