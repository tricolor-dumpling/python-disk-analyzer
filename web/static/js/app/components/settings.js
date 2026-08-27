/* ============================================================
   UI 2.0（SpaceLens Pro）· components/settings.js（U2.0 从 app.js 迁入）
   - 设置弹窗（自动保存/数据目录/健康状态/危险区）+ 清空确认弹窗（wipe）；
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
import { setSessionsCache, renderSnapshotList } from "../pages/snapshots.js";

let dataDir = "";

export function setDataDir(v) { dataDir = v; }

export async function openSettings() {
    openModal("settings-modal"); // P12·W2.6（K1）：统一走弹窗工具
    setStatusForSettingsHealth();
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
        await postJson("/api/settings", {
            auto_save: $("setting-auto-save").checked,
            theme: "light",
        });
        setAutoSaveSetting($("setting-auto-save").checked);
        toast("设置已保存", "success");
        closeModal("settings-modal");
    } catch (e) {
        toast(e.message, "error");
    }
}

export function openWipeModal() {
    $("wipe-confirm").value = "";
    $("btn-wipe").disabled = true;
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
        $("btn-undo-save").disabled = true;
        toast(data.message || "数据目录已清空", "success");
        closeModal("wipe-modal");
        closeModal("settings-modal");
        renderSnapshotList([]);
        setStatus("snapshot-status", "", "数据目录已清空，历史快照为空");
        $("compare-result").classList.add("hidden");
        pollFullscan();
    } catch (e) {
        toast(e.message, "error");
        $("btn-wipe").disabled = $("wipe-confirm").value.trim() !== "确认清空";
    }
}

/* 本组件在 init 期的绑定（顺序等价：原 bind() 的设置/危险区段；主题按钮绑定在主题段） */
export function bindSettings() {
    // 设置
    $("btn-settings").addEventListener("click", openSettings);
    $("btn-settings-save").addEventListener("click", saveSettings);
    $("btn-wipe-open").addEventListener("click", openWipeModal);
    $("wipe-confirm").addEventListener("input", () => {
        $("btn-wipe").disabled = $("wipe-confirm").value.trim() !== "确认清空";
    });
    $("btn-wipe").addEventListener("click", wipeData);
}
