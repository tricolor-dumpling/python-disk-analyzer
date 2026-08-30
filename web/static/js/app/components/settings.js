/* ============================================================
   UI 2.0（SpaceLens Pro）· components/settings.js（U2.0 从 app.js 迁入）
   - 设置弹窗（自动保存/数据目录/健康状态/主题三态/危险区）+ 清空确认弹窗（wipe）；
   - U3.5：主题三态（F03/N03——与顶栏按钮同源 theme.js，选择即生效）；
     危险区 L2-10（wipe-panel 红描边脉动 2.4s + 输入匹配「确认清空」后
     3s 倒计时解锁 #btn-wipe，--dur-wipe-countdown 读 token）；
   - 跨模块状态经导出访问器读写（模块化拆分副作用：wipeData 清空多模块状态）。
   ============================================================ */

import { $, api, postJson } from "../api.js";
import { APP_STATE } from "../state.js";
import { toast } from "../components/toast.js";
import { openModal, closeModal } from "../components/modals.js";
import { setStatus } from "../components/statusbar.js";
import { GUIDE_KEY } from "../components/onboarding.js";
import { setAutoSaveSetting, resetHandledScanVersion, pollFullscan, HANDLED_SCAN_KEY } from "../components/scan.js";
import { applyLastRoots, resetBrowseHistory } from "../pages/workspace.js";
import { setSessionsCache, applySnapshotsView } from "../pages/snapshots.js";
import { resetCompareData } from "../pages/compare.js"; // U3.4：清空联动（结果/迷你摘要复位 + 对比页回空态）
import { setThemePref, resolvedTheme, syncThemeControls } from "../theme.js"; // U3.5：主题三态
import { motionDur } from "../motion.js"; // U3.5：--dur-wipe-countdown 倒计时（禁魔法数）

let dataDir = "";

export function setDataDir(v) { dataDir = v; }
/* U3.1：徽章 popover 读取数据目录（跨模块可变状态经访问器） */
export function getDataDir() { return dataDir; }

export async function openSettings() {
    openModal("settings-modal"); // P12·W2.6（K1）：统一走弹窗工具
    setStatusForSettingsHealth();
    syncThemeControls(); // U3.5：主题单选回显（同源：与顶栏按钮改一处另一处反映）
    try {
        const data = await api("/api/settings");
        setAutoSaveSetting(!!data.settings.auto_save);
        $("setting-auto-save").checked = !!data.settings.auto_save;
        dataDir = data.data_dir || "";
        if (dataDir) $("setting-data-dir").value = dataDir;
        const roots = data.settings.last_roots;
        if (Array.isArray(roots) && roots.length) {
            applyLastRoots(roots.slice(0, 5));
        }
    } catch (e) {
        toast("读取设置失败：" + e.message, "error");
    }
}

export async function setStatusForSettingsHealth() {
    $("setting-health").value = "正在检查…";
    try {
        const data = await api("/api/health");
        // P12·W2.1：扫描中显示中性「扫描中：<message>」，不误报未就绪
        if (data.busy) {
            $("setting-health").value = "扫描中：" + (data.message || "");
        } else {
            $("setting-health").value = (data.message || "") + (data.dll ? "（" + data.dll + "）" : "");
        }
    } catch (e) {
        $("setting-health").value = "健康检查失败：" + e.message;
    }
}

async function saveSettings() {
    try {
        // U3.5：theme 报生效值（light|dark 二值在后端白名单内；「跟随系统」按解析值落
        // 档——前端实际主题体系经 localStorage 三态，后端 theme 字段为兼容遗留）
        await postJson("/api/settings", {
            auto_save: $("setting-auto-save").checked,
            theme: resolvedTheme(),
        });
        setAutoSaveSetting($("setting-auto-save").checked);
        toast("设置已保存", "success");
        closeModal("settings-modal");
    } catch (e) {
        toast(e.message, "error");
    }
}

/* ===== U3.5·L2-10：清空确认 3s 倒计时解锁 =====
   输入匹配「确认清空」→ 按钮保持禁用并显示剩余秒数 → 到时解锁可点；
   中途输入失配/重开弹窗 → 取消倒计时并复位禁用。倒计时是安全语义（功能性），
   reduced-motion 不降级（只降红描边脉动装饰层）。 */
const WIPE_CONFIRM_TEXT = "确认清空";
let wipeCdTimer = null;
let wipeCdRemain = 0;

function wipeMatch() {
    return $("wipe-confirm").value.trim() === WIPE_CONFIRM_TEXT;
}

function setWipeButtonLabel(secs) {
    $("btn-wipe").textContent = secs > 0 ? WIPE_CONFIRM_TEXT + "（" + secs + "s）" : WIPE_CONFIRM_TEXT;
}

function clearWipeCountdown() {
    if (wipeCdTimer) { clearInterval(wipeCdTimer); wipeCdTimer = null; }
    wipeCdRemain = 0;
}

function cancelWipeArm() {
    clearWipeCountdown();
    $("btn-wipe").disabled = true;
    setWipeButtonLabel(0);
}

function startWipeCountdown() {
    clearWipeCountdown();
    const totalMs = motionDur("--dur-wipe-countdown");
    const total = Math.max(1, Math.round((totalMs > 0 ? totalMs : 3000) / 1000));
    wipeCdRemain = total;
    $("btn-wipe").disabled = true; // 倒计时期间禁用（解锁后才可点）
    setWipeButtonLabel(wipeCdRemain);
    wipeCdTimer = setInterval(() => {
        wipeCdRemain -= 1;
        if (wipeCdRemain <= 0) {
            clearWipeCountdown();
            // 输入仍匹配才解锁（用户编辑失配时 input 处理器已取消武装）
            if (wipeMatch()) {
                $("btn-wipe").disabled = false;
                setWipeButtonLabel(0);
            }
        } else {
            setWipeButtonLabel(wipeCdRemain);
        }
    }, 1000);
}

export function openWipeModal() {
    cancelWipeArm(); // 重开弹窗 = 重新武装（输入清空 + 禁用 + 倒计时复位）
    $("wipe-confirm").value = "";
    $("wipe-data-dir").textContent = dataDir || "数据目录";
    openModal("wipe-modal"); // P12·W2.6（K1/K2）
}

async function wipeData() {
    $("btn-wipe").disabled = true;
    try {
        const data = await postJson("/api/admin/wipe", { confirm: $("wipe-confirm").value.trim() });
        // P12·W2.6（RT-N06）：清键集合——成功响应后、关弹窗前执行（失败不清理）
        try {
            localStorage.removeItem(GUIDE_KEY);          // 恢复出厂：引导页重现
            localStorage.removeItem(HANDLED_SCAN_KEY);   // 已处理扫描代次
        } catch (e) { /* ignore */ }
        resetHandledScanVersion();
        APP_STATE.lastBrowseData = null;
        resetBrowseHistory();
        applyLastRoots([]);
        setSessionsCache([]);
        const undoBtn = $("btn-undo-save");
        if (undoBtn) undoBtn.disabled = true;
        toast(data.message || "数据目录已清空", "success");
        closeModal("wipe-modal");
        closeModal("settings-modal");
        // U3.3：清空 = 列表/迷你卡/基线建议/趋势卡全量复位（applySnapshotsView 从空缓存回灌）
        applySnapshotsView();
        setStatus("snapshot-status", "", "数据目录已清空，历史快照为空");
        // U3.4：清空 = 对比结果/最近对比迷你摘要复位（对比页在位则回空态；旧
        // #compare-result 隐藏迁移至 resetCompareData——原直取 DOM 守卫移除）
        resetCompareData();
        pollFullscan();
    } catch (e) {
        toast(e.message, "error");
        // 失败复位（与原语义一致）：输入仍匹配 → 立即可重试；否则保持禁用
        if (wipeMatch()) {
            clearWipeCountdown();
            $("btn-wipe").disabled = false;
            setWipeButtonLabel(0);
        } else {
            cancelWipeArm();
        }
    }
}

/* U3.5：设置弹窗主题三态接线——单选即生效（theme.js 单一来源）；
   VT 扩散原点取所选选项中心（change 事件无坐标，还原 L0-1 点击扩散语义）。 */
function bindThemeGroup() {
    const group = $("setting-theme");
    if (!group) return;
    const pointFrom = (input) => {
        const r = (input.parentElement || input).getBoundingClientRect();
        return { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    };
    group.addEventListener("change", (ev) => {
        const input = ev.target;
        if (!input || !input.matches('input[name="setting-theme"]')) return;
        setThemePref(input.value, pointFrom(input));
    });
}

/* 本组件在 init 期的绑定（顺序等价：原 bind() 的设置/危险区段；主题按钮绑定在主题段） */
export function bindSettings() {
    // 设置
    $("btn-settings").addEventListener("click", openSettings);
    $("btn-settings-save").addEventListener("click", saveSettings);
    bindThemeGroup(); // U3.5：主题三态单选
    $("btn-wipe-open").addEventListener("click", openWipeModal);
    $("wipe-confirm").addEventListener("input", () => {
        // U3.5·L2-10：匹配 → 3s 倒计时解锁；失配 → 取消武装并复位
        if (wipeMatch()) startWipeCountdown();
        else cancelWipeArm();
    });
    $("btn-wipe").addEventListener("click", wipeData);
}
