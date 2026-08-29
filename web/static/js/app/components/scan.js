/* ============================================================
   UI 2.0（SpaceLens Pro）· components/scan.js（U2.0 从 app.js 迁入；U3.2 状态机扩展）
   - 全量扫描卡全套：K7 已处理代次持久化（§3.6 机制 #2）、
     轮询单链 + _wasScanRunning 完成边沿（机制 #3）、
     SKIP_REASON_TEXT 经 labels.js（机制 #7,共享叶子避免循环依赖）；
   - U3.2（D10）状态机四态：空闲 / 扫描中（#btn-stop-scan 红描边 L2-2 + 耗时计时 +
     chips 三态 ✓/脉冲/灰） / 完成（L2-3 绿光+对勾 drawCheck + L2-4 粒子 16 粒，
     先 toast、仅主页可见时播） / 中止（toast「已停止，已完成部分可浏览」+ 保存可用）；
   - 停止能力特性探测：OPTIONS /api/fullscan/stop（零副作用——真 POST 在运行中
     会触发实际停止，不能用于探测；⚠️ 偏差注记：手册按「POST 探测」表述，
     以 OPTIONS 实现并记录于执行记录），404/405 → 隐藏「停止」按钮；
   - APP_STATE.scan §3.2 命名空间本项启用（U3.2 起随轮询同步）。
   ============================================================ */

import { $, api, postJson, esc } from "../api.js";
import { ICONS } from "../icons.js";
import { APP_STATE } from "../state.js";
import { toast } from "../components/toast.js";
import { setStatus } from "../components/statusbar.js";
import { skipReasonText } from "../labels.js";
import { confirmDialog } from "../components/modals.js";
import { confetti, drawCheck } from "../motion.js"; // U3.2：L2-4 粒子 / L2-3 对勾描边
import { formatElapsed } from "../motion-core.js";  // U3.2：耗时计时（HH:MM:SS 口径）
import { refreshSnapshots, getSessionsCache } from "../pages/snapshots.js";
import { refreshOverview } from "../components/storage.js";
import { getCurrentRoot, browsePath, setCurrentRoot, getTreemapView } from "../pages/workspace.js"; // 扫描盘 chips 与导出根；U3.2 粒子挂点（fx 层）
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

/* U3.2（D10）：停止能力特性探测结果（启动探测一次；OPTIONS 零副作用——
   真 POST 会在扫描运行中触发实际停止，绝不能用作探测。POST 仍作兜底：
   点击停止遇 404/405 → 隐藏按钮并提示） */
let stopAvailable = false;
/* U3.2：前端耗时计时起点（ms；startFullscan 成功时记拍；页面重开恢复扫描中
   态时以首拍为近似起点——单调递增，配合 motion-core formatElapsed 口径） */
let scanStartTs = 0;

export function isStopAvailable() { return stopAvailable; }

/* 停止能力探测（smoke A16 / u32 探针可重入：先复位再探测） */
export async function probeStopSupport() {
    stopAvailable = false;
    try {
        const resp = await fetch("/api/fullscan/stop", { method: "OPTIONS" });
        stopAvailable = resp.ok; // 200（含 Allow: OPTIONS）= 接口存在；404/405 → 隐藏
    } catch (e) {
        stopAvailable = false; // 网络异常按不可用处理（静默）
    }
    return stopAvailable;
}

/* U3.2（D10）：请求停止——POST /api/fullscan/stop（可空体；空闲幂等不报错）。
   中止态 toast 由完成边沿（renderFullscanState）统一触发，此处只发请求+轮询。 */
export async function requestStopScan() {
    try {
        const data = await postJson("/api/fullscan/stop", {});
        if (data.stopped === true) {
            setStatus("fullscan-status", "busy", "正在停止…");
        }
    } catch (e) {
        toast(e.message, "error");
        // 接口不存在（404/405）→ 特性检测降级：隐藏停止按钮（下次扫描生效）
        if (/(接口不存在|404)/.test(String(e.message || ""))) stopAvailable = false;
    } finally {
        pollFullscan(); // 同步真实状态（停止边沿/回退）
    }
}

/* 模块化拆分导出的赋值器（原 openSettings/init 的 autoSaveSetting= 赋值点） */
export function setAutoSaveSetting(v) { autoSaveSetting = v; }
/* 模块化拆分导出的赋值器（原 wipeData 的 handledScanVersion=0） */
export function resetHandledScanVersion() { handledScanVersion = 0; }

/* U3.2：盘符 chips 三态（定稿 6.2 N05：✓已完成可点击 / 脉冲进行中 / 灰待办）。
   契约 id 不变（#scan-roots）；aborted 时未完成盘一律灰（不伪称完成）。 */
function renderScanRootChips(roots, rootsDone, running, aborted) {
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
                const complete = i < done || (!running && !aborted);
                const current = running && i === done;
                if (complete) {
                    return '<button class="chip chip-done" data-root="' + esc(r) + '" title="浏览 ' + esc(r) + '">' + ICONS.check + esc(r) + "</button>";
                }
                if (current) {
                    return '<span class="chip chip-current" aria-label="扫描中">' + ICONS.drive + esc(r) + "</span>";
                }
                return '<span class="chip chip-pending" aria-label="待扫描">' + ICONS.drive + esc(r) + "</span>";
            })
            .join("");
    box.classList.remove("hidden");
    if (running && done < roots.length) {
        hint.textContent = "正在扫描中：已完成盘可点击即时浏览，进行中盘完成后即可浏览。";
        hint.classList.remove("hidden");
    } else if (aborted) {
        hint.textContent = "已停止：已完成盘可点击浏览，未完成盘可在重新扫描后继续。";
        hint.classList.remove("hidden");
    } else {
        hint.classList.add("hidden");
    }
    box.querySelectorAll(".chip[data-root]").forEach((chip) => {
        chip.addEventListener("click", () => {
            // ⚠️ 修复（U3.2 顺手）：U2.0 迁移遗留的未声明 currentRoot 赋值
            //（module 严格模式即 ReferenceError，chips 点击从未生效）——改走访问器
            setCurrentRoot(chip.getAttribute("data-root"));
            $("browse-root").value = getCurrentRoot();
            browsePath(getCurrentRoot());
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
        scanStartTs = Date.now(); // U3.2：耗时计时起点（新扫描记拍）
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
    /* U3.2：APP_STATE.scan（§3.2 命名空间）随轮询同步（stopAvailable/startTs 为本
       前端态，非后端字段） */
    Object.assign(APP_STATE.scan, {
        running: !!st.running,
        startTs: scanStartTs,
        roots: st.roots || [],
        done: Number(st.roots_done) || 0,
        current: st.current_root || null,
        stopAvailable: stopAvailable,
        stopRequested: !!st.stop_requested,
        version: Number(st.scan_version) || 0,
    });
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

/* U3.3 访问器：最近一次 /api/fullscan/status 载荷（快照页「创建快照」可用性派生） */
export function getLastScanStatus() { return _lastScanStatus; }

/* U3.3：快照页「创建快照」可用性（镜像扫描卡保存按钮派生：
   完成+save_ready / 中止+部分根；N06「无全量数据时置灰+提示」） */
export function isSaveAvailable() {
    const st = _lastScanStatus;
    if (!st || st.running || st.error) return false;
    if (st.result_ready && st.save_ready) return true;
    if (st.stop_requested && (Number(st.roots_done) || 0) > 0) return true;
    return false;
}

/* U3.2（L2-4）：完成庆祝粒子——先 toast（调用方）后粒子；仅主页可见时播：
   fx 层画布必须仍在文档中（isConnected）；reduced-motion 由 motion.confetti 直跳过。 */
function playCompletionConfetti() {
    if (APP_STATE.route !== "/") return;
    const view = getTreemapView();
    const fx = view && view.fx ? view.fx() : null;
    if (!fx || !fx.isConnected) return;
    confetti(fx, { count: 16 }); // 定稿 L2-4：16 粒 / 600ms（--dur-4）/ 单次
}

/* U3.2：扫描卡状态机渲染（四态：空闲/扫描中/完成/中止；保存提示属完成态子分支）。
   ⚠️ 边沿顺序保留 U3.1 纪律：markNavDot("/")（圆点三触发之扫描完成）先于
   DOM 守卫——子页面完成也挂点；概览自动刷新（refreshOverview）仍仅主页路径
   （守卫之后的既有行为不变）；U3.2 中止（用户停止）同属扫描完成边沿。 */
function renderFullscanState(st) {
    const wasRunning = _wasScanRunning;
    const runningNow = !!st.running;
    _wasScanRunning = runningNow;
    /* 状态派生（persistent，非仅边沿——applyScanView 回挂/路由返回时保持终态） */
    const completed = !runningNow && !!st.result_ready && !st.error;
    const aborted = !runningNow && !!st.stop_requested && !st.error && !completed;
    const finishedEdge = wasRunning && !runningNow && !st.error; // 完成/中止边沿（一次）
    const partialRoots = (Number(st.roots_done) || 0) > 0;
    if (finishedEdge && (completed || aborted)) markNavDot("/");
    if (!$("progress-fill")) return; // U2.1：子页面时扫描卡不在 DOM（状态已记账，回主页即恢复渲染）
    const pct = Number(st.progress_pct) || 0;
    $("progress-fill").style.width = pct + "%";
    $("progress-pct").textContent = pct + "%";
    $("progress").classList.toggle("running", runningNow);
    $("progress").classList.toggle("complete", completed);
    const cmpBtn = $("btn-compare");
    if (cmpBtn) cmpBtn.disabled = runningNow; // W2.4：扫描中对比按钮保持禁用（既有行为；U3.4 起对比页按钮由页面自身管理——此处仅余工作台路径的兼容守卫）
    /* L2-3：条尾对勾（完成态显示；drawCheck 仅边沿描边 400ms——--dur-draw-check） */
    const checkEl = $("scan-check");
    if (checkEl) {
        if (completed && checkEl.hidden) { checkEl.hidden = false; checkEl.classList.remove("hidden"); }
        if (completed && finishedEdge) {
            const path = checkEl.querySelector("path");
            if (path) drawCheck(path);
        }
        if (!completed) { checkEl.hidden = true; checkEl.classList.add("hidden"); }
    }
    /* 停止按钮（U3.2：扫描中变「停止」，红描边 L2-2；404 特性检测 → 永久隐藏） */
    const startBtn = $("btn-fullscan");
    const stopBtn = $("btn-stop-scan");
    const showStop = runningNow && stopAvailable;
    if (startBtn) {
        startBtn.disabled = runningNow;
        startBtn.hidden = showStop; // 扫描中且支持停止 → 按钮变「停止」（同一 row 位次）
    }
    if (stopBtn) {
        stopBtn.hidden = !showStop;
        stopBtn.classList.toggle("active", showStop);
    }
    /* 耗时计时器（前端 startTs + motion formatElapsed；节拍=轮询 1s 单链，无独立定时器） */
    const elapsedEl = $("scan-elapsed");
    if (elapsedEl) {
        if (runningNow) {
            if (!scanStartTs) scanStartTs = Date.now(); // 页面重开恢复：首拍近似起点
            elapsedEl.textContent =
                " · 已用时 " + formatElapsed(Math.floor((Date.now() - scanStartTs) / 1000));
            elapsedEl.hidden = false;
        } else {
            elapsedEl.hidden = true;
        }
    }
    /* U3.2：完成边沿庆祝——先 toast（任何路由）后粒子（仅主页）；中止 toast 同点 */
    if (finishedEdge) {
        if (completed) {
            toast("全量扫描已完成，结果就绪" + (st.save_ready ? "，可保存快照" : ""), "success");
            playCompletionConfetti();
        } else if (aborted) {
            toast("已停止，已完成部分可浏览", "info");
        }
    }
    renderScanRootChips(st.roots, st.roots_done, runningNow, aborted);
    /* P12·W3.2：完成边沿——运行中→完成且结果就绪且无错误，概览自动刷新一次；
       U3.2：中止（用户停止）同属边沿——已完成根已变化，概览一并刷新（仅主页路径） */
    if (finishedEdge && !st.error && (completed || (aborted && partialRoots))) {
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

    if (completed) {
        $("btn-save").disabled = !st.save_ready;
        setStatus("fullscan-status", "ok", "全量扫描已完成，结果就绪" + (st.save_ready ? "，可保存快照" : ""));
        maybePromptSave(st);
        return;
    }

    if (aborted) {
        /* 定稿 6.2 中止态：已完成部分可浏览 + 保存可用（部分根存在时） */
        $("btn-save").disabled = !partialRoots;
        setStatus(
            "fullscan-status",
            "ok",
            "已停止：已完成部分可浏览" + (partialRoots ? "，可保存快照" : "")
        );
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
    $("btn-stop-scan").addEventListener("click", requestStopScan); // U3.2：停止（D10）
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

    // 历史（U3.3：刷新/撤销迁至 #/snapshots 页头——迷你卡不再持有；绑定时空守卫）
    const refreshBtn = $("btn-refresh-snapshots");
    if (refreshBtn) refreshBtn.addEventListener("click", refreshSnapshots);
    const undoBtn = $("btn-undo-save");
    if (undoBtn) undoBtn.addEventListener("click", undoLastSave);
}
