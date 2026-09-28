/* ============================================================
   UI 2.0（SpaceLens Pro）· components/settings.js（U2.0 模块化迁入）
   - 设置弹窗（自动保存/数据目录/健康状态/主题三态/危险区）+ 清空确认弹窗（wipe）；
   - U3.5：主题三态（F03/N03——与顶栏按钮同源 theme.js，选择即生效）；
     危险区 L2-10（wipe-panel 红描边脉动 2.4s + 输入匹配「确认清空」后
     3s 倒计时解锁 #btn-wipe，--dur-wipe-countdown 读 token）；
   - 跨模块状态经导出访问器读写（模块化拆分副作用：wipeData 清空多模块状态）。
   ============================================================ */

import { $, api, postJson, esc } from "../api.js";
import { APP_STATE } from "../state.js";
import { toast } from "../components/toast.js";
import { openModal, closeModal } from "../components/modals.js";
import { setStatus } from "../components/statusbar.js";
import { GUIDE_KEY } from "../components/onboarding.js";
import { PICK_KEY } from "../components/drives.js"; // pds_selected_drives_v1（wipe 清键）
import { setAutoSaveSetting, pollFullscan } from "../components/scan.js";
import { applyLastRoots, resetBrowseHistory, setBrowseView, setMergeTop, renderEntries } from "../pages/workspace.js";
/* 2026-09-13 新增：使用偏好（记录 + 回显 + 恢复默认；注册表见 prefs.js） */
import { PREF_REGISTRY, getPref, prefGroups, resetPrefs, setPref, storedPrefIds } from "../prefs.js";
import { setSessionsCache, applySnapshotsView } from "../pages/snapshots.js";
import { resetCompareData } from "../pages/compare.js"; // U3.4：清空联动（结果/迷你摘要复位 + 对比页回空态）
import { setThemePref, resolvedTheme, syncThemeControls } from "../theme.js"; // U3.5：主题三态
import { motionDur } from "../motion.js"; // U3.5：--dur-wipe-countdown 倒计时（禁魔法数）
import { CALIBRE_NOTE } from "../components/storage.js"; // P-5（G-1）：口径标注同源常量

let dataDir = "";

export function setDataDir(v) { dataDir = v; }
/* U3.1：徽章 popover 读取数据目录（跨模块可变状态经访问器） */
export function getDataDir() { return dataDir; }

export async function openSettings() {
    openModal("settings-modal"); // P12·W2.6（K1）：统一走弹窗工具
    setSettingsTab(activeSettingsTab); // 2026-09-13：回显上次分页（默认「常规」）
    setStatusForSettingsHealth();
    syncThemeControls(); // U3.5：主题单选回显（同源：与顶栏按钮改一处另一处反映）
    renderPrefs();       // 2026-09-13：使用偏好回显（每次打开重建，值可能被页面控件改过）
    try {
        const data = await api("/api/settings");
        // 阶段D（D-2）：「扫描完成自动保存」默认开启——未显式存储（缺键）视为 ON；
        // 显式 false 保持 OFF（与 main.js 启动读取同口径）
        const autoSaveOn = data.settings.auto_save !== false;
        setAutoSaveSetting(autoSaveOn);
        $("setting-auto-save").checked = autoSaveOn;
        dataDir = data.data_dir || "";
        if (dataDir) $("setting-data-dir").value = dataDir;
        // P-5（G-1）：口径标注（D5 裁定——设置弹窗数据目录区标注；幂等注入，不重复）
        const dataDirField = $("setting-data-dir");
        if (dataDirField && !dataDirField.parentElement.querySelector(".calibre-note")) {
            const note = document.createElement("div");
            note.className = "calibre-note";
            note.textContent = CALIBRE_NOTE;
            dataDirField.parentElement.appendChild(note);
        }
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
            localStorage.removeItem(PICK_KEY);           // 已选盘符偏好（pds_selected_drives_v1）
            localStorage.removeItem("pds_last_browse_v1"); // 上次浏览位置（F06；无常量定义，字面量与 workspace.js 同键）
            // pds_theme_v1 属用户偏好，恢复出厂保留
        } catch (e) { /* ignore */ }
        // P1（D1-1）：K7「已处理扫描代次」闸门（pds_handled_scan_version_v1）已移除，
        // 自动保存由后端归口，前端不再有跨进程持久化代次键可清。
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

/* U3.5：设置弹窗主题三态接线——单选即生效（theme.js 单一来源）。
   阶段E（E-4）：真实鼠标坐标链路——问题 2-15 根因：change 事件无坐标，旧实现用
   pointFrom(input) 取选项控件矩形中心模拟坐标 → 用户在选项内任意位置点击，扩散中心
   永远在控件中心。现改为：
   ① pointerdown 记录 ev.clientX/clientY（label 捕获，input 为 opacity:0 +
      pointer-events:none 的隐藏单选——点击实际落在 label 上，冒泡到 group）；
   ② change（由点击或键盘/无障碍触发）优先用**上一次未消费的**指针坐标 →
      setThemePref(pref, {clientX, clientY})；
   ③ 无坐标（键盘/触摸屏无指针事件/屏幕阅读器/程序化 change）→ 回退控件中心
      （pointFrom，与旧语义一致，A19 断言面兼容）；
   ④ 消费即清 + **组外 pointerdown 清空**（D7-4）。

   P7（问题 10：D7-4）——原实现的 `POINTER_TTL_MS = 300` 时间闸门有两个实测问题：
     · 慢点击（按下与抬起相隔 >300ms，如长按/系统卡顿/触控板轻点）→ 坐标被判过期 →
       圆心退回**控件中心**（用户看到「不从鼠标位置扩散」）；
     · 点在外边距（label 内 padding/相邻空白）时 change 与 pointerdown 的 value 不匹配
       → 同样退回中心。
   现口径：坐标**不再按时间过期**，只按「下一次 change 消费」清空；任何发生在
   `#setting-theme` 组之外的 pointerdown 视为「用户已改点别处」→ 立即清空，
   防止陈旧坐标被后续键盘/程序化 change 复用（安全性不降级）。 */
let lastThemePointer = null; // {clientX, clientY, value}（无时间 TTL：仅由 change 消费或组外 pointerdown 清空）

function bindThemeGroup() {
    const group = $("setting-theme");
    if (!group) return;
    const pointFrom = (input) => {
        const r = (input.parentElement || input).getBoundingClientRect();
        return { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    };
    // ① pointerdown 记录真实指针坐标（label 捕获；input pointer-events:none 时
    //    target 是 label/span，向上找 .theme-opt 内的 input）
    group.addEventListener("pointerdown", (ev) => {
        const opt = ev.target && ev.target.closest ? ev.target.closest(".theme-opt") : null;
        if (!opt) return;
        const input = opt.querySelector('input[name="setting-theme"]');
        if (!input) return;
        lastThemePointer = {
            clientX: typeof ev.clientX === "number" ? ev.clientX : null,
            clientY: typeof ev.clientY === "number" ? ev.clientY : null,
            value: input.value,
        };
    });
    // ④ 组外按下 → 清空（防陈旧坐标复用；捕获阶段，先于其它处理器）
    if (!bindThemeGroup.outsideBound) {
        bindThemeGroup.outsideBound = true;
        document.addEventListener("pointerdown", (ev) => {
            const t = ev.target;
            if (t && t.closest && t.closest("#setting-theme")) return;
            lastThemePointer = null;
        }, true);
    }
    // ② change：优先未消费的真实坐标；无坐标（键盘/程序化）→ 控件中心兜底
    group.addEventListener("change", (ev) => {
        const input = ev.target;
        if (!input || !input.matches('input[name="setting-theme"]')) return;
        let pt = null;
        if (lastThemePointer &&
            lastThemePointer.value === input.value &&
            typeof lastThemePointer.clientX === "number") {
            pt = { clientX: lastThemePointer.clientX, clientY: lastThemePointer.clientY };
        }
        lastThemePointer = null; // ④ 消费后清（防旧坐标复用）
        setThemePref(input.value, pt || pointFrom(input));
    });
}

/* ============================================================
   2026-09-13 第二轮：设置弹窗分页（常规 / 使用偏好 / 危险区）
   背景：原单页内容 1045px 高，1366×768 下 `.modal-panel{max-height:90vh;overflow:auto}`
   让**整个弹窗**滚动（标题与底部按钮一起滚走）——用户实测「设置界面太长了」。
   分页后每页都短、弹窗高度稳定；活动分页在本次会话内记忆（重开回到上次分页）。
   ============================================================ */

const SETTINGS_TABS = ["general", "prefs", "danger"];
let activeSettingsTab = "general";

export function setSettingsTab(name) {
    const tab = SETTINGS_TABS.indexOf(name) === -1 ? "general" : name;
    activeSettingsTab = tab;
    SETTINGS_TABS.forEach((t) => {
        const btn = $("tab-" + t);
        const pane = $("pane-" + t);
        const on = t === tab;
        if (btn) {
            btn.classList.toggle("is-active", on);
            btn.setAttribute("aria-selected", String(on));
            btn.tabIndex = on ? 0 : -1;
        }
        if (pane) {
            pane.classList.toggle("is-active", on);
            pane.toggleAttribute("hidden", !on);
        }
    });
}

function bindSettingsTabs() {
    const bar = document.querySelector(".settings-tabs");
    if (!bar) return;
    bar.addEventListener("click", (ev) => {
        const btn = ev.target && ev.target.closest ? ev.target.closest("[data-tab]") : null;
        if (btn) setSettingsTab(btn.getAttribute("data-tab"));
    });
    // ←/→ 在分页间移动（radiogroup/tablist 键盘惯例）
    bar.addEventListener("keydown", (ev) => {
        if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return;
        const cur = SETTINGS_TABS.indexOf(activeSettingsTab);
        const next = (cur + (ev.key === "ArrowRight" ? 1 : -1) + SETTINGS_TABS.length) % SETTINGS_TABS.length;
        setSettingsTab(SETTINGS_TABS[next]);
        const btn = $("tab-" + SETTINGS_TABS[next]);
        if (btn) btn.focus();
        ev.preventDefault();
    });
}

/* ============================================================
   2026-09-13 新增：使用偏好区（记录 / 回显 / 恢复默认）
   - 数据源 = prefs.js 的 PREF_REGISTRY（单一事实源）——本文件不硬编码任何偏好项；
   - 控件形态按注册表定义派生：options → <select>；def 为布尔 → 开关；数值 → number；
   - 改动立即写存储并**当场应用**（同一收口：视图切换走 workspace.setBrowseView、
     列表筛选与对比口径走各自既有 change 事件，零重复实现）。
   ============================================================ */

function prefInputId(id) {
    return "pref-" + String(id).replace(/[.]/g, "-");
}

function prefControlHtml(it) {
    const id = prefInputId(it.id);
    const label = esc(it.label);
    if (Array.isArray(it.options)) {
        const opts = it.options
            .map((v) => {
                const text = it.optionText && it.optionText[v] !== undefined ? it.optionText[v] : v;
                return '<option value="' + esc(v) + '"' +
                    (String(v) === String(it.value) ? " selected" : "") + ">" + esc(text) + "</option>";
            })
            .join("");
        return '<select id="' + id + '" class="pref-input" data-pref="' + esc(it.id) +
            '" aria-label="' + label + '">' + opts + "</select>";
    }
    if (typeof it.def === "boolean") {
        return '<input id="' + id + '" class="pref-input switch" type="checkbox" data-pref="' + esc(it.id) +
            '"' + (it.value ? " checked" : "") + ' aria-label="' + label + '">';
    }
    const min = typeof it.min === "number" ? ' min="' + it.min + '"' : "";
    const max = typeof it.max === "number" ? ' max="' + it.max + '"' : "";
    return '<input id="' + id + '" class="pref-input pref-number" type="number" data-pref="' + esc(it.id) +
        '"' + min + max + ' step="1" value="' + esc(it.value) + '" aria-label="' + label + '">';
}

/* 设置弹窗打开时渲染（每次打开都重建：值可能被页面内控件改过） */
export function renderPrefs() {
    const host = $("settings-prefs");
    if (!host) return;
    host.innerHTML = prefGroups()
        .map((g) => {
            const rows = g.items
                .map((it) =>
                    '<label class="pref-row" for="' + prefInputId(it.id) + '" title="' + esc(it.hint) + '">' +
                    '<span class="pref-label"><b>' + esc(it.label) + "</b>" +
                    '<span class="pref-hint">' + esc(it.hint) + "</span></span>" +
                    '<span class="pref-control">' + prefControlHtml(it) + "</span></label>")
                .join("");
            return '<div class="pref-group"><div class="pref-group-title">' + esc(g.group) + "</div>" + rows + "</div>";
        })
        .join("");
    syncPrefsNote();
}

function syncPrefsNote() {
    const note = $("settings-prefs-note");
    if (!note) return;
    const n = storedPrefIds().length;
    note.textContent = n ? "已记住 " + n + " 项自定义偏好" : "当前全部为默认值";
}

/* 偏好 → 现场应用（各页面既有收口；控件不在 DOM 时只改 APP_STATE，等挂载时渲染） */
export function applyPrefNow(id, value) {
    switch (id) {
        case "view.mode":
            APP_STATE.view.mode = value;
            if ($("btn-view-treemap")) setBrowseView(value);
            break;
        case "view.mergeTop":
            if ($("merge-top-label")) setMergeTop(value);
            else APP_STATE.view.mergeTop = value;
            break;
        case "list.kind":
        case "list.sort": {
            const el = $(id === "list.kind" ? "browse-kind" : "browse-sort");
            if (el) {
                el.value = String(value);
                if (APP_STATE.lastBrowseData) renderEntries(APP_STATE.lastBrowseData);
            }
            break;
        }
        case "compare.depth": {
            APP_STATE.compare.depth = String(value || "");
            const sel = $("compare-depth");
            // 派发既有 change：页面自身负责「口径变更 → 弃缓存 → 重发对比」
            if (sel) { sel.value = String(value || ""); sel.dispatchEvent(new Event("change")); }
            break;
        }
        case "compare.hideZero": {
            APP_STATE.compare.hideZero = !!value;
            const box = $("compare-hide-zero");
            if (box) { box.checked = !!value; box.dispatchEvent(new Event("change")); }
            break;
        }
        default:
            break;
    }
}

function onPrefsChange(ev) {
    const el = ev.target && ev.target.closest ? ev.target.closest("[data-pref]") : null;
    if (!el) return;
    const id = el.getAttribute("data-pref");
    let value;
    if (el.type === "checkbox") value = !!el.checked;
    else if (el.tagName === "SELECT") value = el.value;
    else value = Math.floor(Number(el.value));
    setPref(id, value);                       // 越界/非法值在 prefs 内清洗
    applyPrefNow(id, getPref(id));            // 应用清洗后的权威值
    if (el.type === "number") el.value = String(getPref(id)); // 越界回显
    syncPrefsNote();
}

function onResetPrefs() {
    resetPrefs();
    PREF_REGISTRY.forEach((def) => applyPrefNow(def.id, def.def));
    renderPrefs();
    toast("使用偏好已恢复默认", "success");
}

/* 本组件在 init 期的绑定（顺序等价：原 bind() 的设置/危险区段；主题按钮绑定在主题段） */
export function bindSettings() {
    // 设置
    $("btn-settings").addEventListener("click", openSettings);
    $("btn-settings-save").addEventListener("click", saveSettings);
    bindSettingsTabs(); // 2026-09-13：设置分页（常规 / 使用偏好 / 危险区）
    bindThemeGroup(); // U3.5：主题三态单选
    const prefsBox = $("settings-prefs");
    if (prefsBox) prefsBox.addEventListener("change", onPrefsChange);
    const resetPrefsBtn = $("btn-reset-prefs");
    if (resetPrefsBtn) resetPrefsBtn.addEventListener("click", onResetPrefs);
    $("btn-wipe-open").addEventListener("click", openWipeModal);
    $("wipe-confirm").addEventListener("input", () => {
        // U3.5·L2-10：匹配 → 3s 倒计时解锁；失配 → 取消武装并复位
        if (wipeMatch()) startWipeCountdown();
        else cancelWipeArm();
    });
    $("btn-wipe").addEventListener("click", wipeData);
}
