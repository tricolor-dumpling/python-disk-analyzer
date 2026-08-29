/* ============================================================
   UI 2.0（SpaceLens Pro）· components/snapshot-mini.js（U2.4 新建）
   - [N06] 快照迷你卡内容（右栏「快照」卡）：最近一份条目 +「管理快照」入口
     + 空态（「还没有快照」+ 引导文案，定稿 6.5）；
     条目点击 = 与上一份对比（基线预填 APP_STATE.compare.baseline，
     跳 #/compare——基线消费方为 U3.4 对比工作台，本阶段先落状态与跳转）；
   - 「最近对比」迷你卡（§3.3 右栏末位入口）：state.compare.lastSummary
     （compare.js 对比成功后写入，U3.4 子页面接管后为唯一入口）+ 空态引导文案；
   - ⚠️ 过渡期偏差注记：legacy 门禁（U2.5 退役）依赖 #btn-undo-save 存在、
     U3.3 前 #/snapshots 为占位页 → 迷你卡内保留「刷新/撤销最近保存」紧凑行
     （ids 与行为不变）与「全部会话」折叠区（完整会话列表在 U3.3 子页面接管前
     的唯一入口，默认收起）；U3.3 时随子页面接线移除折叠区并把撤销迁至页头。
   - 纪律：暂藏元素一律 toggleAttribute("hidden") + 显式 [hidden] 规则
     （U2.3 教训：class/属性双控冲突）。
   ============================================================ */

import { $, esc, humanBytes, signedBytes } from "../api.js";
import { ICONS } from "../icons.js";
import { APP_STATE } from "../state.js";

/* 折叠态（模块级：路由重挂后保持） */
let _expanded = false;

function formatCreatedAt(text) {
    return String(text || "").replace("T", " ");
}

function rootLabel(root) {
    return String(root || "").replace(/\\+$/, "");
}

/* 会话中第一个可用快照文件路径（基线候选） */
function pickBaseline(session) {
    if (!session) return "";
    const ok = Object.values(session.roots || {}).find((r) => r && !r.skipped && r.snapshot_path);
    return ok ? ok.snapshot_path : "";
}

/* 工具行/折叠区显隐（空态按 N06 隐藏工具行——ids 保留在 DOM，legacy 断言仍可读） */
function toggleTools(hasSessions) {
    const tools = $("snapshot-mini-tools");
    if (tools) tools.toggleAttribute("hidden", !hasSessions);
    const region = $("snapshot-mini-list");
    if (region && !hasSessions) region.toggleAttribute("hidden", true);
}

/* 折叠区/按钮按 _expanded 复位（路由重挂与数据刷新共用） */
function applyExpanded() {
    const region = $("snapshot-mini-list");
    if (region) region.toggleAttribute("hidden", !_expanded);
    const btn = $("btn-snapshot-expand");
    if (btn) {
        btn.setAttribute("aria-expanded", String(_expanded));
        btn.textContent = _expanded ? "收起会话" : "全部会话";
    }
}

/* N06 迷你条目渲染（refreshSnapshots / applySnapshotsView 调用） */
export function renderSnapshotMini(sessions) {
    const entry = $("snapshot-mini-entry");
    if (!entry) return;
    const list = Array.isArray(sessions) ? sessions : [];
    if (!list.length) {
        entry.innerHTML =
            '<div class="snapshot-mini-empty"><b>还没有快照</b>' +
            "<span>全量扫描后保存一份，变化趋势从这里开始记录。</span></div>";
        toggleTools(false);
        return;
    }
    const latest = list[0];
    const okRoots = Object.values(latest.roots || {}).filter((r) => r && !r.skipped && r.snapshot_path);
    const rootText = okRoots.length ? okRoots.map((r) => rootLabel(r.root)).join(" / ") : "无快照文件";
    entry.innerHTML =
        '<button class="snapshot-mini-item" id="snapshot-mini-latest" title="与上一份对比（跳转对比页）">' +
        '<span class="snapshot-mini-icon">' + ICONS.clock + "</span>" +
        '<span class="snapshot-mini-info"><strong>' + esc(formatCreatedAt(latest.created_at || latest.session_id)) + "</strong>" +
        '<span class="snapshot-mini-sub">' + (latest.auto ? "自动保存" : "手动保存") + " · " + esc(rootText) + "</span></span>" +
        '<span class="tag ' + (latest.auto ? "tag-auto" : "tag-manual") + '">' + (latest.auto ? "自动" : "手动") + "</span>" +
        "</button>";
    toggleTools(true);
    applyExpanded();
    $("snapshot-mini-latest").addEventListener("click", () => {
        // N06：与上一份对比——基线取上一会话同序可用快照；仅一份时以该份为基线
        const baseline = pickBaseline(list[1]) || pickBaseline(latest);
        if (baseline) APP_STATE.compare.baseline = baseline;
        location.hash = "#/compare";
    });
}

/* 「最近对比」迷你卡渲染（空态引导 / 最近摘要 + ▲▼ 色盲冗余符号） */
export function renderCompareMini() {
    const body = $("compare-mini-body");
    if (!body) return;
    const s = APP_STATE.compare.lastSummary;
    if (!s) {
        body.innerHTML =
            '<button class="compare-mini-empty" id="btn-compare-mini-open">' +
            "<b>还没有对比记录</b><span>保存快照后在「历史对比」发起对比，最近结果会显示在这里。</span></button>";
    } else {
        const d = Number(s.delta) || 0;
        const cls = d === 0 ? "flat" : d > 0 ? "grow" : "shrink";
        const arrow = d === 0 ? "±" : d > 0 ? "▲" : "▼";
        body.innerHTML =
            '<button class="compare-mini-item" id="btn-compare-mini-open">' +
            '<span class="compare-mini-line"><span class="compare-mini-label">用量变化</span>' +
            '<strong class="compare-mini-delta ' + cls + '">' + arrow + " " + esc(signedBytes(d)) + "</strong></span>" +
            '<span class="compare-mini-line"><span class="compare-mini-label">' +
            esc(humanBytes(s.totalBaseline)) + " → " + esc(humanBytes(s.totalCurrent)) + "</span>" +
            '<span class="compare-mini-at">' + esc(String(s.atText || "")) + "</span></span>" +
            "</button>";
    }
    const open = $("btn-compare-mini-open");
    if (open) open.addEventListener("click", () => { location.hash = "#/compare"; });
}

/* 页面挂载绑定（每次工作台挂载在新 DOM 上调用，天然不重复） */
export function bindSnapshotMini() {
    const manage = $("btn-manage-snapshots");
    if (manage) manage.addEventListener("click", () => { location.hash = "#/snapshots"; });
    const go = $("btn-compare-mini-go");
    if (go) go.addEventListener("click", () => { location.hash = "#/compare"; });
    const expand = $("btn-snapshot-expand");
    if (expand) expand.addEventListener("click", () => {
        _expanded = !_expanded;
        applyExpanded();
    });
    applyExpanded();
}
