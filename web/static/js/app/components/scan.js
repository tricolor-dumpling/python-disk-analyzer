/* ============================================================
   UI 2.0（SpaceLens Pro）· components/scan.js（U2.0 从 app.js 迁入）
   - 全量扫描卡全套：K7 已处理代次持久化（§3.6 机制 #2）、
     轮询单链 + _wasScanRunning 完成边沿（机制 #3）、
     SKIP_REASON_TEXT 经 labels.js（机制 #7,共享叶子避免循环依赖）；
   - U3.2 状态机扩展（停止接口/计时器/chips 升级）时本模块为落点。
   ============================================================ */

import { $, api, postJson, esc } from "../api.js";
import { ICONS } from "../icons.js";
import { toast } from "../components/toast.js";
import { setStatus } from "../components/statusbar.js";
import { skipReasonText } from "../labels.js";
import { confirmDialog } from "../components/modals.js";
import { refreshSnapshots, getSessionsCache } from "../pages/snapshots.js";
import { refreshOverview } from "../components/storage.js";
import { getCurrentRoot, browsePath } from "../pages/workspace.js"; // 扫描盘 chips 与导出根
import { markNavDot } from "../components/nav-dots.js"; // U3.1：N13 圆点提醒（叶子模块，防环）

/* ================= K7：已处理的扫描代次持久化 ================= */
export const HANDLED_SCAN_KEY = "pds_handled_scan_version_v1";

function loadHandledScanVersion() {
    try { return Number(localStorage.getItem(HANDLED_SCAN_KEY)) || 0; }
    catch (e) { return 0; } // localStorage 不可用时退化为进程内变量
}
function storeHandledScanVersion(v) {
    try { localStorage.setItem(HANDLED_SCAN_KEY, String(v)); } catch (e) { /* ignore */ }
}

/* ================= 全量扫描 ================= */

let autoSaveSetting = false;
let handledScanVersion = loadHandledScanVersion(); // K7：localStorage 持久化

/* 模块化拆分导出的赋值器（原 openSettings/init 的 autoSaveSetting= 赋值点） */
export function setAutoSaveSetting(v) { autoSaveSetting = v; }
/* 模块化拆分导出的赋值器（原 wipeData 的 handledScanVersion=0） */
export function resetHandledScanVersion() { handledScanVersion = 0; }

function renderScanRootChips(roots, rootsDone, running) {
    const box = $("scan-roots");
    if (!box) return; // U2.1：子页面时扫描卡不在 DOM（全局轮询容错：状态仍在后端/模块内）
    const hint = $("scan-progress-hint");
    if (!roots || !roots.length) {
        box.classList.add("hidden");
        hint.classList.add("hidden");
        return;
    }
    const done = Number(rootsDone) || 0;
    box.innerHTML =
        '<span class="chips-label">可浏览盘符：</span>' +
        roots
            .map((r, i) => {
                const complete = i < done || !running;
                return complete
                    ? '<button class="chip" data-root="' + esc(r) + '" title="浏览 ' + esc(r) + '">' + ICONS.drive + esc(r) + "</button>"
                    : '<span class="chip" aria-label="扫描中">' + ICONS.drive + esc(r) + " · 扫描中</span>";
            })
            .join("");
    box.classList.remove("hidden");
    if (running && done < roots.length) {
        hint.textContent = "正在扫描中：已完成盘可点击即时浏览，进行中盘完成后即可浏览。";
        hint.classList.remove("hidden");
    } else {
        hint.classList.add("hidden");
    }
    box.querySelectorAll(".chip").forEach((chip) => {
        chip.addEventListener("click", () => {
            currentRoot = chip.getAttribute("data-root");
            $("browse-root").value = currentRoot;
            browsePath(currentRoot);
        });
    });
}

export async function startFullscan() {
    const btn = $("btn-fullscan");
    if (btn) btn.disabled = true;
    const prompt = $("save-prompt");
    if (prompt) prompt.classList.add("hidden");
    setStatus("fullscan-status", "busy", "正在启动后台全量扫描…");
    try {
        const data = await postJson("/api/fullscan/start", {});
        // P12·W2.5（G）：中性文案——任务是「提交」，不在点击瞬间完成
        toast(data.message || "全量扫描任务已提交，后台执行中", "info");
        pollFullscan();
    } catch (e) {
        toast(e.message, "error");
        pollFullscan(); // 同步真实状态（如“已在运行中”）
    }
}

/* P12·W3.2（L-5/DEF-017）：轮询单链收敛——任意时刻至多一条 1 秒待触发链，
   杜绝多入口并发叠加；_wasScanRunning 支撑「扫描完成」边沿自动刷新概览。 */
let _pollTimer = null;
let _wasScanRunning = false;
let _lastScanStatus = null; // U2.1：最近一次状态（路由返回时回灌扫描卡）

export function schedulePollFullscan() {
    if (_pollTimer !== null) return;
    _pollTimer = setTimeout(async () => {
        _pollTimer = null;
        await pollFullscan();
    }, 1000);
}

export async function pollFullscan() {
    let st;
    try {
        const data = await api("/api/fullscan/status");
        st = data.status;
    } catch (e) {
        setStatus("fullscan-status", "err", "无法获取扫描状态：" + e.message);
        return;
    }
    _lastScanStatus = st;
    renderFullscanState(st);
    // U2.3：扫描状态广播（additive）——treemap 实时生长 L3-2 / 雷达扫掠 L3-3 订阅
    try { window.dispatchEvent(new CustomEvent("pds:scan", { detail: st })); } catch (e) { /* 环境差异忽略 */ }
    if (st.running) schedulePollFullscan();
}

/* U2.1：路由返回时的视图恢复（用最近状态重绘扫描卡；无状态时静默）。 */
export function applyScanView() {
    if (!_lastScanStatus) return;
    renderFullscanState(_lastScanStatus);
}

function renderFullscanState(st) {
    const wasRunning = _wasScanRunning;
    const runningNow = !!st.running;
    _wasScanRunning = runningNow;
    /* U3.1：完成边沿的圆点提醒先于 DOM 守卫——子页面时也应挂点（N13 触发条件=
       「用户停留在其他页时发生」；refeshOverview 仍按 U2.x 仅主页路径执行，
       保持既有行为：概览自动刷新仅在主页完成）。 */
    if (wasRunning && !runningNow && st.result_ready && !st.error) markNavDot("/");
    if (!$("progress-fill")) return; // U2.1：子页面时扫描卡不在 DOM（状态已记账，回主页即恢复渲染）
    const pct = Number(st.progress_pct) || 0;
    $("progress-fill").style.width = pct + "%";
    $("progress-pct").textContent = pct + "%";
    $("progress").classList.toggle("running", runningNow);
    $("btn-fullscan").disabled = runningNow;
    $("btn-compare").disabled = runningNow; // W2.4：扫描中对比按钮保持禁用
    renderScanRootChips(st.roots, st.roots_done, runningNow);

    // P12·W3.2：完成边沿——运行中→完成且结果就绪且无错误，概览自动刷新一次
    if (wasRunning && !runningNow && st.result_ready && !st.error) {
        refreshOverview();
    }

    if (st.running) {
        $("btn-save").disabled = true;
        setStatus(
            "fullscan-status",
            "busy",
            "正在扫描 " + st.roots_done + "/" + st.roots_total + "：" + (st.current_root || "准备中…")
        );
        return;
    }

    if (st.error) {
        $("btn-save").disabled = true;
        setStatus("fullscan-status", "err", "全量扫描失败：" + st.error);
        return;
    }

    if (st.result_ready) {
        $("btn-save").disabled = !st.save_ready;
        setStatus("fullscan-status", "ok", "全量扫描已完成，结果就绪" + (st.save_ready ? "，可保存快照" : ""));
        maybePromptSave(st);
        return;
    }

    $("btn-save").disabled = true;
    if (!st.roots || !st.roots.length) {
        setStatus("fullscan-status", "", "尚未开始全量扫描");
    }
    // 其他未覆盖状态保留当前文案
}

function maybePromptSave(st) {
    if (!st.save_ready) return;
    const version = Number(st.scan_version) || 0;
    if (handledScanVersion >= version) return;
    handledScanVersion = version;
    storeHandledScanVersion(version);
    if (autoSaveSetting) {
        saveSnapshot(true);
    } else {
        $("save-prompt").classList.remove("hidden");
    }
}

export async function saveSnapshot(auto) {
    const prompt = $("save-prompt");
    if (prompt) prompt.classList.add("hidden");
    const saveBtn = $("btn-save");
    if (saveBtn) saveBtn.disabled = true;
    try {
        const data = await postJson("/api/save", { auto: !!auto });
        // P12·W2.2：notice 通道 → warn toast；跳过 → info toast
        const roots = Object.values(((data.session || {}).roots) || {});
        roots.forEach((r) => {
            if (r && r.notice) {
                toast(r.notice.message || "保存提示", "warn");
            } else if (r && r.skipped) {
                toast(skipReasonText(r.skip_reason), "info");
            }
        });
        // P12·W2.11（B-1 缓解）：逐盘失败清单 → warn toast（不一损俱损）
        (data.failed || []).forEach((f) => toast(f.error || ("保存失败：" + f.root), "warn"));
        toast(data.message || "保存完成", "success");
        if (auto) toast("已自动保存快照；如需回退可点「撤销最近保存」", "info");
        refreshSnapshots();
        markNavDot("/snapshots"); // U3.1：N13 圆点提醒（快照保存成功；点击快照标签消除）
    } catch (e) {
        toast(e.message, "error");
    } finally {
        pollFullscan();
    }
}

export async function undoLastSave() {
    // P12·W2.5（D）：入口保险——空会话直接 info 提示，不弹危险确认
    if (!getSessionsCache().length) {
        toast("当前没有可撤销的保存", "info");
        return;
    }
    const ok = await confirmDialog({
        title: "撤销最近一次保存",
        text: "将删除最近一次保存生成的快照文件与保存清单。此操作不可恢复，确定继续吗？",
        okLabel: "撤销",
    });
    if (!ok) return;
    try {
        const data = await postJson("/api/save/undo", {});
        toast(data.message || "已撤销最近一次保存", "success");
        refreshSnapshots();
        pollFullscan();
    } catch (e) {
        toast(e.message, "error");
    }
}

/* 本组件在 init 期的绑定（顺序等价：原 bind() 的全量扫描/导出/历史段） */
export function bindScan() {
    // 全量扫描
    $("btn-fullscan").addEventListener("click", startFullscan);
    $("btn-save").addEventListener("click", () => saveSnapshot(false));
    $("btn-save-now").addEventListener("click", () => saveSnapshot(false));
    $("btn-save-later").addEventListener("click", () => $("save-prompt").classList.add("hidden"));

    // P12·W2.7：Web 导出（CSV/JSON，经 Content-Disposition 触发下载）
    const exportUrl = (fmt) => {
        const root = encodeURIComponent(getCurrentRoot() || "");
        return `/api/export?format=${fmt}&root=${root}`;
    };
    $("btn-export-csv").addEventListener("click", () => window.open(exportUrl("csv"), "_blank"));
    $("btn-export-json").addEventListener("click", () => window.open(exportUrl("json"), "_blank"));

    // 历史
    $("btn-refresh-snapshots").addEventListener("click", refreshSnapshots);
    $("btn-undo-save").addEventListener("click", undoLastSave);
}
