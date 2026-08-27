/* ============================================================
   UI 2.0（SpaceLens Pro）· main.js 入口装配（U2.0）
   - 替代旧 app.js 尾部 init：装配顺序 = 旧 init() 调用顺序（行为等价）；
   - app.js 已清空为注释壳（U4.3 删除文件）；
   - 事件绑定按组件拆分（bind<组件>() = 旧 bind() 各段原样），
     注册顺序差异不影响语义（全部为独立事件注册）；
   - 本模块同时是 smoke 页的导入面：导出断言所需函数/状态
     （selectors 不变因 id 未变；§3.6 机制经各组件模块原样保留）。
   ============================================================ */

import { $, api } from "./api.js";
import { APP_STATE } from "./state.js";
import { switchTheme } from "./theme.js";
import { loadGuide, bindOnboarding } from "./components/onboarding.js";
import { refreshOverview, bindOverview } from "./components/storage.js";
import {
    bindWorkspace, renderEntries, browsePath,
    getCurrentRoot, getCurrentPath, getLastRoots, setCurrentRoot, applyLastRoots,
} from "./pages/workspace.js";
import { evaluateEnvGate, refreshHealth, bindTopbar } from "./components/topbar.js";
import { pollFullscan, setAutoSaveSetting, undoLastSave, bindScan } from "./components/scan.js";
import { refreshSnapshots, getSessionsCache, setSessionsCache } from "./pages/snapshots.js";
import { bindCompare } from "./pages/compare.js";
import { bindSettings, setDataDir, setStatusForSettingsHealth } from "./components/settings.js";
import { bindModals, openModal, closeModal } from "./components/modals.js";
import { renderApiError } from "./components/feedback.js";

/* 主题按钮（U1.1 临时入口：U3.1 顶栏改版时移正） */
function bindTheme() {
    const themeBtn = $("btn-theme");
    if (themeBtn) themeBtn.addEventListener("click", (ev) => switchTheme(undefined, ev));
}

/* 启动：顺序与旧 init() 完全一致（bind 拆分调用同序）。 */
export async function start() {
    bindOnboarding();
    bindOverview();
    bindWorkspace();
    bindTopbar();
    bindScan();
    bindCompare();
    bindTheme();
    bindSettings();
    bindModals();
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
   访问器读取/恢复状态（getSessionsCache/setSessionsCache、getCurrentPath）。 */
export {
    $, APP_STATE, switchTheme,
    renderApiError, refreshSnapshots, refreshHealth, setStatusForSettingsHealth,
    undoLastSave, renderEntries, openModal, closeModal, browsePath,
    getCurrentPath, getSessionsCache, setSessionsCache,
};
