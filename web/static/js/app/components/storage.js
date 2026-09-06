/* ============================================================
   UI 2.0（SpaceLens Pro）· components/storage.js（U2.0 建，U2.4 环形图卡重写）
   - 存储概览卡（N04）：viz/donut.js 环形图 + 盘符 chips（D15：只切环形数据，
     不切浏览目录）+ 图例两行 + 「浏览此盘」按钮（跳转浏览的唯一入口）；
   - 四态：空（未扫描，定稿 6.5 文案）/ 加载（首拍占位）/ 数据（sweep 入场 +
     中心 count-up）/ 扫描中（不确定旋转弧 + 自动跟随当前盘，N04）；
   - 自动跟随与锁定：全量扫描中跟随 pds:scan 当前盘，用户手选 chip 后本扫描期
     锁定（扫描完成边沿复位）；
   - ⚠️ 偏差注记（/api/overview 字段核对，2026-08-28）：实际字段 =
     roots[].{root,total,total_human,index_ready,index_valid,directories(前10),
     files(前10),directory_count,file_count,record_count,completed_at} +
     顶层 {ready,scanning,empty_reason,progress_pct,current_root,roots_done,
     roots_total,completed_at}；**无「总容量/可用空间」字段**（理想形态的
     已用/容量比不可实现）→ 环形降级为「已使用之环比」：弧 = 选中盘已用 /
     全部盘已用累计（单盘时恒 100%）；图例「已使用/可用」降级为
     「已使用（本盘）/全部盘累计」；后端零改动（红线）。
   - F05 裁决：旧「目录占用排行」条形列表被环形图+chips 取代（信息等价：
     目录构成经「浏览此盘」进入视图区查看）。
   ============================================================ */

import { $, api, esc, humanBytes } from "../api.js";
import { ICONS } from "../icons.js";
import { browsePath, setCurrentRoot, getCurrentRoot } from "../pages/workspace.js";
import { createDonut } from "../viz/donut.js";

/* P-5（阶段G G-1）：口径标注——D5 裁定「逻辑尺寸为主 + UI 全处标注口径」；
   显示值为已占用逻辑字节（与 Everything SDK 直读/资源管理器「已使用」一致），
   未计硬链接重叠（WinSxS 等硬链接重复计数属逻辑尺寸固有差异，非缺陷）。 */
export const CALIBRE_NOTE = "逻辑尺寸，未计硬链接重叠";

/* ================= 卡片状态（模块级，路由切换不丢） ================= */

let overviewData = null;   // 最近一次 /api/overview 成功载荷（数据态渲染源）
let donutView = null;      // createDonut 实例（随卡片 innerHTML 重建）
let selectedRoot = null;   // 当前选中盘（数据态/chips）
let userLocked = false;    // N04：扫描期用户手选后锁定（本扫描期内不再自动跟随）
let scanMode = false;      // 扫描中（不确定弧态；pds:scan 驱动）
let lastScanSt = null;     // 最近一次 pds:scan 状态（扫描态守卫/回挂恢复）
let _scanFollowBound = false;

/* ================= 工具 ================= */

/* "D:\" → "D:"（chip 展示用；data-root/title 保留完整根） */
function rootLabel(root) {
    return String(root || "").replace(/\\+$/, "");
}

function clamp01(v) {
    return v < 0 ? 0 : (v > 1 ? 1 : v);
}

function disposeDonut() {
    if (donutView) { donutView.destroy(); donutView = null; }
}

/* 卡片骨架（数据态与扫描态共用；空态/错误态整体替换） */
function storageBodyHtml() {
    return (
        '<div class="storage-body">' +
        '<div class="storage-row">' +
        '<div id="overview-donut" class="donut-host" role="img" aria-label="存储环形图"></div>' +
        '<div id="overview-legend" class="donut-legend"></div>' +
        "</div>" +
        '<div id="overview-chips" class="chips-row overview-chips"></div>' +
        '<button id="btn-overview-browse" class="btn btn-primary btn-sm overview-open" title="跳转浏览所选盘符">浏览此盘</button>' +
        "</div>"
    );
}

/* ================= 数据态 ================= */

function sumTotal(roots) {
    return roots.reduce((s, r) => s + (Number(r.total) || 0), 0);
}

function legendHtml(roots, sel) {
    const total = sumTotal(roots);
    const pct = total > 0 ? clamp01((Number(sel.total) || 0) / total) : 0;
    const used = sel.total_human || humanBytes(sel.total);
    return (
        '<div class="donut-legend-row">' +
        '<span class="donut-legend-label"><i class="donut-dot donut-dot-used"></i>已使用</span>' +
        '<strong class="donut-legend-value">' + esc(used) +
        (total > 0 ? '<em>' + (pct * 100).toFixed(1) + "%</em>" : "") +
        "</strong></div>" +
        '<div class="donut-legend-row">' +
        '<span class="donut-legend-label"><i class="donut-dot donut-dot-all"></i>全部盘累计</span>' +
        '<strong class="donut-legend-value">' + esc(humanBytes(total)) + "</strong></div>" +
        // P-5（G-1）：口径标注（D5 裁定全处标注；图例行尾追加，不改既有 ID/断言面）
        '<div class="donut-legend-calibre" title="' + esc(CALIBRE_NOTE) + '">' + esc(CALIBRE_NOTE) + "</div>"
    );
}

/* chips 渲染 + D15 绑定（只切环形数据，不切目录） */
function bindChips(box, roots, { onChip }) {
    const chips = $("overview-chips");
    if (!chips) return;
    chips.innerHTML = roots
        .map((r) => {
            const active = r.root === selectedRoot;
            const size = r.total_human || humanBytes(r.total);
            return (
                '<button class="chip' + (active ? " is-active" : "") + '" data-root="' + esc(r.root) +
                '" title="' + esc(r.root + " · " + size + " · " + CALIBRE_NOTE) + '" aria-pressed="' + active + '">' +
                ICONS.drive + esc(rootLabel(r.root)) + "</button>"
            );
        })
        .join("");
    chips.querySelectorAll(".chip").forEach((chip) => {
        chip.addEventListener("click", () => onChip(chip.getAttribute("data-root")));
    });
}

/* 选中盘 → 环形/图例/chips 激活态同步（不重建 DOM，sweep 从当前值插值到新值） */
function applySelectedRoot(roots) {
    const sel = roots.find((r) => r.root === selectedRoot) || roots[0];
    if (!sel) return;
    selectedRoot = sel.root;
    const total = sumTotal(roots);
    const pct = total > 0 ? clamp01((Number(sel.total) || 0) / total) : 0;
    if (donutView) {
        donutView.setValue({ pct, value: Number(sel.total) || 0, sub: sel.root });
    }
    const legend = $("overview-legend");
    if (legend) legend.innerHTML = legendHtml(roots, sel);
    document.querySelectorAll("#overview-chips .chip").forEach((chip) => {
        const active = chip.getAttribute("data-root") === selectedRoot;
        chip.classList.toggle("is-active", active);
        chip.setAttribute("aria-pressed", String(active));
    });
    const host = $("overview-donut");
    if (host) {
        host.setAttribute("aria-label", "存储环形图：" + sel.root + " 已使用 " + (sel.total_human || humanBytes(sel.total)) +
            (total > 0 ? "，占全部盘 " + (pct * 100).toFixed(1) + "%" : "") + "，" + CALIBRE_NOTE);
    }
    const btn = $("btn-overview-browse");
    if (btn) btn.title = "跳转浏览 " + sel.root;
}

/* 数据态整卡渲染（新数据到达：sweep 从 0 入场 + 中心 count-up） */
function renderDataState(roots) {
    const box = $("overview-roots");
    if (!box) { donutView = null; return; }
    disposeDonut();
    if (!roots.find((r) => r.root === selectedRoot)) selectedRoot = roots[0] && roots[0].root;
    box.innerHTML = storageBodyHtml();
    donutView = createDonut($("overview-donut"), { fmt: humanBytes });
    bindChips(box, roots, {
        onChip: (root) => {
            selectedRoot = root;
            if (scanMode) userLocked = true; // N04：扫描期手选 → 本扫描期锁定
            applySelectedRoot(roots);        // D15：只切环形数据，不触发 browse
        },
    });
    $("btn-overview-browse").addEventListener("click", () => {
        const root = selectedRoot || getCurrentRoot();
        setCurrentRoot(root);
        const input = $("browse-root");
        if (input) input.value = root;
        browsePath(root);
    });
    applySelectedRoot(roots);
    $("overview-meta").textContent = overviewData && overviewData.completed_at
        ? "最近扫描：" + String(overviewData.completed_at).replace("T", " ")
        : "索引已就绪";
}

/* ================= 扫描态（N04：自动跟随 + 用户锁定） ================= */

/* 完成序约定（与扫描卡 renderScanRootChips 一致）：roots 前 roots_done 个为已完成 */
function scanChipDone(st, root) {
    const idx = (st.roots || []).indexOf(root);
    return idx < 0 || idx < (Number(st.roots_done) || 0) || !st.running;
}

function renderScanChips(st) {
    const chips = $("overview-chips");
    if (!chips) return;
    const roots = st.roots || [];
    if (!roots.length) { chips.innerHTML = ""; return; }
    const follow = userLocked ? selectedRoot : (st.current_root || selectedRoot);
    chips.innerHTML = roots
        .map((r) => {
            const active = r === follow;
            const done = scanChipDone(st, r);
            return (
                '<button class="chip' + (active ? " is-active" : "") + '" data-root="' + esc(r) +
                '" title="' + esc(r + (done ? " · 已完成" : " · 扫描中")) + '" aria-pressed="' + active + '">' +
                ICONS.drive + esc(rootLabel(r)) + "</button>"
            );
        })
        .join("");
    chips.querySelectorAll(".chip").forEach((chip) => {
        chip.addEventListener("click", () => {
            selectedRoot = chip.getAttribute("data-root");
            userLocked = true; // N04：手选后本扫描期不再自动跟随
            const activeRoot = selectedRoot;
            chips.querySelectorAll(".chip").forEach((c) => {
                const on = c.getAttribute("data-root") === activeRoot;
                c.classList.toggle("is-active", on);
                c.setAttribute("aria-pressed", String(on));
            });
            syncScanBrowse(st);
        });
    });
}

/* 扫描态「浏览此盘」可用性：仅已完成盘可即时浏览（与扫描卡口径一致） */
function syncScanBrowse(st) {
    const btn = $("btn-overview-browse");
    if (!btn) return;
    const done = st && scanChipDone(st, selectedRoot);
    btn.disabled = !done;
    btn.title = done ? "跳转浏览 " + selectedRoot : "该盘扫描完成后可浏览";
}

/* 扫描态整卡渲染（不确定弧 + 跟随 chips） */
function renderScanState(st) {
    const box = $("overview-roots");
    if (!box) { donutView = null; return; }
    disposeDonut();
    box.innerHTML = storageBodyHtml();
    donutView = createDonut($("overview-donut"), { fmt: humanBytes });
    donutView.setScanning(true, {
        value: Number(st.progress_pct) || 0,
        sub: st.current_root || "准备中",
        fmt: (v) => Math.round(v) + "%",
    });
    const legend = $("overview-legend");
    if (legend) legend.innerHTML = '<div class="donut-legend-scan">扫描完成后展示各盘已用占比</div>';
    renderScanChips(st);
    $("btn-overview-browse").addEventListener("click", () => {
        const root = selectedRoot || getCurrentRoot();
        setCurrentRoot(root);
        const input = $("browse-root");
        if (input) input.value = root;
        browsePath(root);
    });
    syncScanBrowse(st);
    $("overview-meta").textContent = "扫描中 " + (Number(st.progress_pct) || 0) + "% · 已完成 " +
        (Number(st.roots_done) || 0) + "/" + (Number(st.roots_total) || 0) + " 个盘";
    const host = $("overview-donut");
    if (host) host.setAttribute("aria-label", "存储环形图：正在扫描 " + (st.current_root || "…"));
}

/* 扫描中轻量更新（不重建 DOM：中心 count-up + 跟随高亮 + meta；
   N04：用户手选锁定后副行/高亮均不再跟随，仅进度数字继续走） */
function updateScanTick(st) {
    if (!$("overview-donut")) { donutView = null; return; }
    if (!donutView) donutView = createDonut($("overview-donut"), { fmt: humanBytes });
    /* 竞态修复：首次扫描态由 /api/overview 扫描载荷渲染（roots=[]），此时
       pds:scan 带 roots 的事件先于/后于它到达都可能让 chips 缺失——
       tick 时若 chips 为空且 st.roots 可用则补渲染（renderScanChips 内部内联重建）。 */
    if (!document.querySelector("#overview-chips .chip") && (st.roots || []).length) {
        renderScanChips(st);
    }
    const shown = userLocked ? (selectedRoot || st.current_root) : (st.current_root || "准备中");
    donutView.setScanning(true, {
        value: Number(st.progress_pct) || 0,
        sub: shown,
        fmt: (v) => Math.round(v) + "%",
    });
    if (!userLocked) {
        const follow = st.current_root;
        document.querySelectorAll("#overview-chips .chip").forEach((c) => {
            const on = c.getAttribute("data-root") === follow;
            c.classList.toggle("is-active", on);
            c.setAttribute("aria-pressed", String(on));
        });
        if (follow) selectedRoot = follow;
    }
    syncScanBrowse(st);
    $("overview-meta").textContent = "扫描中 " + (Number(st.progress_pct) || 0) + "% · 已完成 " +
        (Number(st.roots_done) || 0) + "/" + (Number(st.roots_total) || 0) + " 个盘";
}

/* pds:scan 事件（scan.js pollFullscan 每 1s 派发，additive）：
   - running=true：进入/维持扫描态；
   - running=false（完成/中止/错误边沿）：复位锁定并刷新概览——scan.js 的
     result_ready 边沿已先行调用 refreshOverview（时序：renderFullscanState
     先于 pds:scan 派发），此处兜底其渲染被本事件超越的场景（最坏双 GET，幂等读）。 */
function onScanEvent(ev) {
    const st = ev && ev.detail;
    if (!st) return;
    lastScanSt = st;
    if (st.running) {
        if (!scanMode) {
            scanMode = true;
            userLocked = false;
            renderScanState(st);
        } else {
            updateScanTick(st);
        }
    } else if (scanMode) {
        scanMode = false;
        userLocked = false;
        if ($("overview-roots")) refreshOverview();
    }
}

/* ================= 空态 / 错误态（定稿 6.5） ================= */

function renderEmptyState() {
    disposeDonut();
    const box = $("overview-roots");
    if (!box) return;
    $("overview-meta").textContent = "完成全量扫描后显示索引空间分布";
    box.innerHTML =
        '<div class="overview-empty"><b>还没有空间索引</b>' +
        "<span>先做一次全量扫描，几分钟后这里会长出你的磁盘地图。</span></div>";
}

/* ================= 概览刷新（数据源与启动时序不变） ================= */

export async function refreshOverview() {
    const box = $("overview-roots");
    if (!box) return;
    try {
        const data = await api("/api/overview");
        overviewData = data;
        if (data.scanning) {
            renderScanState(data); // 无既有结果的首扫：API 直接给扫描进度
            return;
        }
        if (!data.ready || !data.roots || !data.roots.length) {
            renderEmptyState();
            return;
        }
        // 后台仍在扫描（有既有结果时 API 返回旧数据）：保持扫描态，等完成边沿刷新
        if (lastScanSt && lastScanSt.running) {
            renderScanState(lastScanSt);
            return;
        }
        renderDataState(data.roots);
    } catch (e) {
        $("overview-meta").textContent = "概览暂不可用";
        disposeDonut();
        box.innerHTML = '<div class="overview-empty"><b>概览暂不可用</b><span>' + esc(e.message) + "</span></div>";
    }
}

/* 本组件在 init 期的绑定（刷新按钮 + 扫描跟随事件一次绑定） */
export function bindOverview() {
    $("btn-overview-refresh").addEventListener("click", refreshOverview);
    if (!_scanFollowBound) {
        _scanFollowBound = true;
        window.addEventListener("pds:scan", onScanEvent);
    }
}
