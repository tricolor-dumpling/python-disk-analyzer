/* ============================================================
   UI 2.0（SpaceLens Pro）· components/snapshot-mini.js（U2.4 新建，U3.3 简化）
   - [N06] 快照迷你卡内容（右栏「快照」卡）：最近一份条目 +「管理快照」入口
     + 空态（「还没有快照」+「打开快照管理」单按钮，定稿 6.5/N06）；
     条目点击 = 与上一份对比（基线预填 APP_STATE.compare.baseline，
     跳 #/compare——基线消费方为 U3.4 对比工作台，本阶段先落状态与跳转）；
   - U3.3：撤销/刷新/「全部会话」折叠区随子页面接线迁至 #/snapshots 页头与
     列表（F16/F17）——本组件不再持有会话列表与工具行；
   - 「最近对比」迷你卡（§3.3 右栏末位入口）：state.compare.lastSummary
     （compare.js 对比成功后写入，U3.4 子页面接管后为唯一入口）+ 空态引导文案；
   - 纪律：暂藏元素一律 toggleAttribute("hidden") + 显式 [hidden] 规则
     （U2.3 教训：class/属性双控冲突）。
   ============================================================ */

import { $, esc, humanBytes, signedBytes } from "../api.js";
import { ICONS } from "../icons.js";
import { APP_STATE } from "../state.js";

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

/* N06 迷你条目渲染（refreshSnapshots / applySnapshotsView 调用） */
export function renderSnapshotMini(sessions) {
    const entry = $("snapshot-mini-entry");
    if (!entry) return;
    const list = Array.isArray(sessions) ? sessions : [];
    if (!list.length) {
        // N06：空态=文案 +「打开快照管理」单按钮（不留无操作价值的死卡）
        entry.innerHTML =
            '<div class="snapshot-mini-empty"><b>还没有快照</b>' +
            '<span>全量扫描后保存一份，变化趋势从这里开始记录。</span>' +
            '<button class="btn btn-sm snapshot-mini-open-btn" id="btn-snapshot-mini-open">打开快照管理</button></div>';
        const open = $("btn-snapshot-mini-open");
        if (open) open.addEventListener("click", () => { location.hash = "#/snapshots"; });
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
}
