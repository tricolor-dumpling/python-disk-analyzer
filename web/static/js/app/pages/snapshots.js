/* ============================================================
   UI 2.0（SpaceLens Pro）· pages/snapshots.js（U2.0 模块化迁入，U3.3 快照管理页）
   - 布局（§3.3/§3.5）：页头 64px（创建快照 F15 + 撤销最近保存 F16）→
     趋势区 128px（趋势卡×2 N07）→ 会话分组列表（F17，flex:1 面板内滚）；
   - [N07] 趋势卡（较昨日/较上周）：基线=同盘符快照中时间 ≤24h（较昨日）/
     (24h,7d]（较上周）最近的一份（D7：前端就近选基线，复用 /api/compare，无新后端）；
     目标=该盘最新快照；无合适基线 → 「暂无对比基线」；点击卡 → #/compare 并预填
     （APP_STATE.compare，§6.4 跨页传递）；
   - ⚠️ 字段核对结论（执行记录）：/api/snapshots 会话数据（app.py api_snapshots /
     session.py save_session）无「逐次总量」字段（session 载荷仅
     session_id/auto/machine_guid/roots/ledger_backup/created_at，roots 条目仅
     snapshot 名/路径/skipped/skip_reason/notice）→ **sparkline（L3-5）降级为
     「两快照对比差值卡」**（无折线，保留 ▲/▼ 与百分比；不改后端，红线裁决）；
   - 列表区（F17）：会话分组渲染（renderSnapshotList 语义迁移，逐盘「对比此快照」
     = 预填 state.compare + 跳 #/compare——§6.4 跨页形态，U3.4 消费）、
     auto/manual/added/removed 标签、跳过原因 tooltip（红线 #7 SKIP_REASON_TEXT）；
   - 撤销最近保存（F16）= 复用 scan.js undoLastSave 确认弹窗流程（按 §3.6 红线 #9 栈语义）；
   - 「创建快照」（F15）= 复用保存流程（scan.js saveSnapshot）；无全量结果时置灰
     （N06：镜像扫描卡保存按钮派生，经 main.js 注入 canCreate——本模块零 scan.js 依赖
     防环：scan.js → snapshots.js 已有单向依赖）。
   ============================================================ */

import { $, api, postJson, esc, signedBytes } from "../api.js";
import { ICONS } from "../icons.js";
import { APP_STATE } from "../state.js";
import { setStatus } from "../components/statusbar.js";
import { skipReasonText } from "../labels.js";
import { confirmDialog } from "../components/modals.js"; // 阶段C（C-3）：删除确认弹窗（红线 #9 弹窗栈）
import { toast } from "../components/toast.js"; // 阶段C（C-3）：删除结果反馈
import { renderSnapshotMini } from "../components/snapshot-mini.js"; // U2.4：N06 迷你条目
import { sparklinePath, sparklineLastPoint } from "../motion-core.js"; // 阶段G（G-2）：sparkline 折线纯函数
import { sparkline as runSparkline } from "../motion.js"; // 阶段G（G-2）：L3-5 描线 800ms（--dur-sparkline）

let sessionsCache = [];

/* 模块化拆分导出的读写器（原 smoke 测试恢复点/settings wipeData 清空点的跨模块访问） */
export function getSessionsCache() { return sessionsCache; }
export function setSessionsCache(v) { sessionsCache = v; }

function formatCreatedAt(text) {
    return String(text || "").replace("T", " ");
}

/* P12·W2.4：root 归一化预检——trim + 大写 + 尾反斜杠（终审仍留后端 normcase；
   compare.js 同根直比判定沿用） */
export function normRoot(x) {
    let v = String(x || "").trim().toUpperCase();
    if (!v) return "";
    if (!v.endsWith("\\")) v += "\\";
    return v;
}

/* ================= U3.3：页头动作注入（main.js；防 scan↔snapshots 环：
   scan.js → snapshots.js 为既有单向依赖，本模块不得反向 import scan.js） ================= */

let snapActions = { create: null, undo: null, canCreate: null };

export function setSnapshotsActions(actions) {
    if (actions && typeof actions === "object") {
        snapActions = Object.assign({}, snapActions, actions);
    }
}

/* 「创建快照」可用性（镜像扫描卡保存按钮派生：完成+save_ready / 中止+部分根；
   N06「无全量数据时置灰+提示」） */
function syncCreateAvailability() {
    const btn = $("btn-create-snapshot");
    if (!btn) return;
    const enabled = snapActions.canCreate ? !!snapActions.canCreate() : false;
    btn.disabled = !enabled;
    btn.title = enabled
        ? "保存最近一次全量扫描结果为快照（创建快照）"
        : "暂无全量扫描结果，请先完成全量扫描并保存";
}

/* pds:scan 订阅（模块级一次；快照页挂载后「创建快照」可用性随扫描状态同步——
   与扫描卡保存按钮同派生，事件 detail=status 原样） */
let scanSubscribed = false;
/* 阶段C（C-5）：最近一次扫描状态（result_ready 等；事件 detail=status 原样）。
   趋势卡在无全量结果时据此提示「先做全量扫描」而非后台直扫。 */
let lastScanStatusForTrend = null;
function ensureScanListener() {
    if (scanSubscribed) return;
    scanSubscribed = true;
    window.addEventListener("pds:scan", (ev) => {
        if (ev && ev.detail) lastScanStatusForTrend = ev.detail;
        /* 阶段C（C-5）时序修复：快照页冷启动/切页早于首拍 pds:scan 时，
           lastScanStatusForTrend 为空 → fetchTrendCompare 误判「先做全量扫描」
           并缓存 err（fullscan-first）。事件到达且 result_ready 后必须清除
           该误置缓存并重算——否则趋势卡永久停在「对比不可用」。 */
        if (ev && ev.detail && ev.detail.result_ready && !ev.detail.running) {
            let cleared = false;
            for (const [key, entry] of Array.from(trendCache.entries())) {
                if (entry && entry.status === "err" && entry.hint === "fullscan-first") {
                    trendCache.delete(key);
                    cleared = true;
                }
            }
            if (cleared) {
                trendInflight.clear(); // 在途残留标记一并清（其结果到达时按新缓存态渲染）
                renderTrendCards(sessionsCache);
            }
        }
        syncCreateAvailability();
    });
}

/* ================= 刷新与回灌（切页不丢：mount 时从缓存回灌，不重发） ================= */

export async function refreshSnapshots() {
    setStatus("snapshot-status", "busy", "正在加载历史快照…");
    try {
        const data = await api("/api/snapshots");
        sessionsCache = data.sessions || [];
        APP_STATE.snapshots.sessions = sessionsCache; // U3.3：snapshots 命名空间启用
        syncUndoState();
        renderSnapshotList(sessionsCache);
        renderSnapshotMini(sessionsCache); // U2.4：迷你卡最近一份
        rebuildBaselineSuggest(sessionsCache);
        renderTrendCards(sessionsCache);
        setStatus("snapshot-status", "", "共 " + sessionsCache.length + " 个快照会话");
        syncListCount();
    } catch (e) {
        setStatus("snapshot-status", "err", e.message);
    }
}

/* U2.1：路由返回时的视图恢复（快照列表/基线下拉/撤销灰置/状态行/趋势卡从缓存回灌） */
export function applySnapshotsView() {
    syncUndoState();
    renderSnapshotList(sessionsCache);
    renderSnapshotMini(sessionsCache); // U2.4：回挂回灌迷你条目
    rebuildBaselineSuggest(sessionsCache);
    renderTrendCards(sessionsCache);
    setStatus("snapshot-status", "", "共 " + sessionsCache.length + " 个快照会话");
    syncListCount();
    syncCreateAvailability(); // U3.3：页头「创建快照」可用性（扫描状态镜像）
}

function syncUndoState() {
    // P12·W2.5（D）：无会话时撤销入口灰置
    const undo = $("btn-undo-save");
    if (undo) undo.disabled = !sessionsCache.length;
}

function syncListCount() {
    const el = $("snapshots-list-count");
    if (el) el.textContent = "共 " + sessionsCache.length + " 个快照会话";
}

/* ================= 会话列表（F17；renderSnapshotList 语义迁移） ================= */

export function renderSnapshotList(sessions) {
    const list = $("snapshot-list");
    if (!list) return; // U2.1：子页面时快照卡不在 DOM；U3.3 起列表随快照页渲染
    if (!sessions.length) {
        // 定稿 6.5：快照页无快照（三处空态之一）
        list.innerHTML =
            '<li><div class="empty-state">' +
            ICONS.empty +
            "<b>还没有快照</b>" +
            "<p>全量扫描后保存一份，变化趋势从这里开始记录。</p>" +
            "</div></li>";
        return;
    }
    list.innerHTML = sessions
        .map((s) => {
            const roots = Object.values(s.roots || {});
            const rootLines = roots.length
                ? '<ul class="session-roots">' +
                  roots
                      .map((r) => {
                          if (r.skipped) {
                              const reason = esc(skipReasonText(r.skip_reason));
                              return (
                                  "<li>" + ICONS.drive +
                                  '<span>' + esc(r.root || "?") + '</span>' +
                                  // F17：跳过原因 tooltip（红线 #7 SKIP_REASON_TEXT；文案可见+悬停提示）
                                  '<span class="tag tag-skip" title="' + reason + '">跳过</span>' +
                                  '<span class="skip-reason" title="' + reason + '" aria-label="' + reason + '">' +
                                  reason + "</span></li>"
                              );
                          }
                          // P12·W2.4：每盘子行尾「对比此快照」一键入口（U3.3 迁移到
                          // 快照页：点击=预填 state.compare + 跳 #/compare——§6.4 跨页形态）
                          // 阶段C（C-3）：追加「删除」按钮（单盘删除，D1 主入口）
                          const cmpBtn = r.snapshot_path
                              ? '<button class="btn btn-sm act-cmp-snap" data-baseline="' + esc(r.snapshot_path) +
                                '" data-root="' + esc(r.root || "") + '">对比此快照</button>'
                              : "";
                          const delBtn = r.snapshot_path || r.root
                              ? '<button class="btn btn-sm btn-ghost act-del-snap" data-session="' + esc(s.session_id || "") +
                                '" data-root="' + esc(r.root || "") + '" title="删除该盘快照（其他盘保留）">删除</button>'
                              : "";
                          return (
                              "<li>" + ICONS.drive +
                              "<span>" + esc(r.root || "?") + " →</span>" +
                              "<code>" + esc(r.snapshot || "缺快照") + "</code>" +
                              cmpBtn + delBtn + "</li>"
                          );
                      })
                      .join("") +
                  "</ul>"
                : '<div class="session-sub">该会话没有快照记录</div>';
            return (
                '<li class="session-item">' +
                '<div class="session-head">' +
                '<span class="session-title">' + ICONS.clock +
                esc(formatCreatedAt(s.created_at || s.session_id)) + "</span>" +
                (s.auto ? '<span class="tag tag-auto">自动</span>' : '<span class="tag tag-manual">手动</span>') +
                '<button class="btn btn-sm btn-ghost act-del-session" data-session="' + esc(s.session_id || "") +
                '" title="删除整个会话（全部盘快照与清单）">删除整会话</button>' +
                "</div>" +
                '<div class="session-sub">' + esc(s.session_id) + "</div>" +
                rootLines +
                "</li>"
            );
        })
        .join("");
}

export function rebuildBaselineSuggest(sessions) {
    const list = $("baseline-suggest");
    if (!list) return;
    list.innerHTML = "";
    sessions.forEach((s) => {
        Object.values(s.roots || {}).forEach((r) => {
            if (r.snapshot_path) {
                const opt = document.createElement("option");
                opt.value = r.snapshot_path;
                list.appendChild(opt);
            }
        });
    });
}

/* ================= U3.3：趋势卡×2（N07；sparkline 降级为差值卡） =================
   ⚠️ 字段核对结论：/api/snapshots 会话数据无逐次总量 → 无 sparkline 数据源，
   按手册 U3.3 预案降级为「两快照对比差值卡」（无折线，保留 ▲/▼ 与百分比），
   L3-5（sparkline 800ms/终点脉冲 2s）留待后端补总量字段后启用（记偏差注记）。

   基线口径（D7/N07 展开）：
   - 较昨日（day）：同盘符快照 0 < Δt ≤ 24h 最近一份；
   - 较上周（week）：同盘符快照 24h < Δt ≤ 7d 最近一份（排除 ≤24h——否则与
     「较昨日」同基线、两卡信息重复；按「周变化」语义取窗口内最近一份）；
   - 目标＝该盘最新快照；多盘时取「最新目标且窗口内有基线」的第一个盘
     （会话时间倒序确定性扫描）；无合适基线 → 「暂无对比基线」。

   Δ 计算：/api/compare（{root, baseline}）；结果入模块级缓存（键=槽:根:基线），
   路由往返/列表刷新不回源（applySnapshotsView 只渲染缓存，不重发）。 */

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const TREND_SLOTS = [
    { key: "day", label: "较昨日", minMs: 0, windowMs: DAY_MS },
    { key: "week", label: "较上周", minMs: DAY_MS, windowMs: WEEK_MS },
];

const trendCache = new Map(); // key "slotKey:root:baseline" → {status:"ok",...}|{status:"err",error}
const trendInflight = new Set(); // 防止并发渲染双发 /api/compare（缓存未落前重复渲染）

/* 阶段C（C-3）：删除成功清 trendCache 中涉及被删基线的条目（防趋势卡缓存陈旧）。
   根可空（整会话删除时清全部）；基线路径可空（按根清）。
   ⚠️ 键含 Windows 盘符冒号，不能 split(":") 解析——按条目值元数据（root/baseline）匹配。 */
export function clearTrendCacheForDeleted({ root, baseline } = {}) {
    const normRoot = (x) => String(x || "").replace(/\\+$/, "").toUpperCase();
    const rootKey = root ? normRoot(root) : null;
    const baselineKey = baseline ? String(baseline) : null;
    for (const [key, entry] of Array.from(trendCache.entries())) {
        if (!entry) continue;
        const eRoot = normRoot(entry.root);
        const eBase = String(entry.baseline || "");
        const rootHit = !rootKey || eRoot === rootKey;
        const baselineHit = !baselineKey || eBase === baselineKey;
        if (rootHit && baselineHit) trendCache.delete(key);
    }
    for (const key of Array.from(trendInflight)) {
        trendInflight.delete(key); // 在途请求的结果到达时会重渲染；删除后整表刷新，清空在途标记防陈旧回填
    }
}

/* 阶段C（C-2/C-3）：调用删除 API（单盘/整会话）；返回 {ok, data} 或抛错。 */
async function deleteSnapshot(sessionId, root) {
    const payload = { session_id: sessionId };
    if (root) payload.root = root;
    const data = await postJson("/api/snapshot/delete", payload);
    return data;
}

function trendCacheKey(slot, trend) {
    return slot.key + ":" + trend.root + ":" + trend.baseline;
}

function rootLabel(root) {
    return String(root || "").replace(/\\+$/, "");
}

function slotTimeText(ms) {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, "0");
    return (
        d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " +
        p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds())
    ); // 本地 YYYY-MM-DD HH:MM:SS（确定性格式，不依赖 locale）
}

/* 收集所有可对比条目（root+snapshot_path+时间），时间降序 */
function collectDriveEntries(sessions) {
    const out = [];
    for (const s of sessions) {
        const t = Date.parse(String(s.created_at || ""));
        if (!t) continue;
        for (const r of Object.values(s.roots || {})) {
            if (!r || r.skipped || !r.root || !r.snapshot_path) continue;
            out.push({ root: r.root, snapPath: r.snapshot_path, createdMs: t });
        }
    }
    out.sort((a, b) => b.createdMs - a.createdMs || (a.root < b.root ? -1 : a.root > b.root ? 1 : 0));
    return out;
}

/* 阶段G（G-2）：按根收集「逐次总量」时间序列（sparkline 数据源）。
   - 数据 = /api/snapshots 每会话 additive total_by_root（后端从快照文件派生，
     与 compare 差值卡 total_current 同口径——C-6 两地一致）；
   - 时间升序（早→晚，折线左→右）；缺失/损坏/跳过 → 该会话该根跳过；
   - 返回 [{ms, bytes}] 或空数组。 */
export function collectDriveTotals(sessions, root) {
    const out = [];
    for (const s of sessions) {
        const t = Date.parse(String(s.created_at || ""));
        if (!t) continue;
        const r = Object.values(s.roots || {}).find((x) => x && x.root === root && !x.skipped);
        if (!r) continue;
        const totals = s.total_by_root || {};
        const bytes = Number(totals[root]);
        if (!Number.isFinite(bytes)) continue;
        out.push({ ms: t, bytes });
    }
    out.sort((a, b) => a.ms - b.ms);
    return out;
}

/* 按槽窗口选（根, 基线, 目标）；无合适基线返回 null */
export function pickTrendForSlot(sessions, slot) {
    const entries = collectDriveEntries(sessions);
    if (!entries.length) return null;
    const byRoot = new Map();
    for (const e of entries) {
        if (!byRoot.has(e.root)) byRoot.set(e.root, []);
        byRoot.get(e.root).push(e);
    }
    for (const e of entries) { // 时间倒序：每盘首次出现即该盘最新目标（确定性取首个合格盘）
        const list = byRoot.get(e.root);
        const target = list[0];
        for (let i = 1; i < list.length; i++) {
            const diff = target.createdMs - list[i].createdMs;
            if (diff > slot.minMs && diff <= slot.windowMs) {
                return {
                    root: target.root,
                    baseline: list[i].snapPath,
                    target: target.snapPath,
                    baselineAtText: slotTimeText(list[i].createdMs),
                    targetAtText: slotTimeText(target.createdMs),
                };
            }
            if (diff > slot.windowMs) break; // 更早的只会更远
        }
    }
    return null;
}

/* 阶段C（C-4）：空态原因行推导（从 sessions）——
   - 无任何会话 → 「还没有快照，先做全量扫描并保存」；
   - 有会话但窗口内无同盘基线 → 「最近快照 <时间>，超出 7 天窗口，请保存新快照后查看」；
   - 全部快照损坏/跳过 → 「基线快照不可用（已删除或损坏）」。
   禁止改为误导性「无变化」（手册 2-4 注意点）。 */
function trendEmptyReason(sessions, slot) {
    const entries = collectDriveEntries(sessions);
    if (!entries.length) {
        return "还没有快照，先做全量扫描并保存";
    }
    const anyUsable = entries.some((e) => e.snapPath);
    if (!anyUsable) {
        return "基线快照不可用（已删除或损坏）";
    }
    // 与 pickTrendForSlot 同口径：每盘最新为「目标」，其同盘更早条目若有落在
    // (minMs, windowMs] 的则非空；全部盘都没有 → 窗口外（给最近快照时间提示）。
    const byRoot = new Map();
    for (const e of entries) {
        if (!byRoot.has(e.root)) byRoot.set(e.root, []);
        byRoot.get(e.root).push(e);
    }
    let anyInWindow = false;
    let latestMs = 0;
    for (const list of byRoot.values()) {
        const target = list[0];
        if (target.createdMs > latestMs) latestMs = target.createdMs;
        for (let i = 1; i < list.length; i++) {
            const diff = target.createdMs - list[i].createdMs;
            if (diff > slot.minMs && diff <= slot.windowMs) { anyInWindow = true; break; }
            if (diff > slot.windowMs) break;
        }
    }
    if (anyInWindow) return ""; // 有窗口内基线——空态不会出现（防御）
    return "最近快照 " + slotTimeText(latestMs) +
        "，超出 " + (slot.windowMs / DAY_MS).toFixed(0) + " 天窗口，请保存新快照后查看";
}

/* 窗口口径 tooltip（阶段C C-4：两卡分别注明窗口口径） */
function trendSlotTooltip(slot) {
    const label = slot.key === "day" ? "较昨日" : "较上周";
    const caliber = slot.key === "day"
        ? "同盘 0&lt;Δt≤24h 最近一份"
        : "同盘 24h&lt;Δt≤7d 最近一份";
    return label + "＝" + caliber + "；目标＝该盘最新快照";
}

function trendCardEmpty(slot, sessions) {
    const reason = trendEmptyReason(sessions, slot);
    return (
        '<div class="trend-card is-empty" data-slot="' + slot.key + '"' +
        ' title="' + esc(trendSlotTooltip(slot)) + '" aria-label="' + esc(slot.label + "：" + (reason || "暂无对比基线")) + '">' +
        '<span class="trend-label-line"><span class="trend-label">' + esc(slot.label) + "</span></span>" +
        '<span class="trend-empty">暂无对比基线</span>' +
        (reason ? '<span class="trend-reason">' + esc(reason) + "</span>" : "") +
        "</div>"
    );
}

function trendCardPending(slot, trend) {
    return (
        '<button class="trend-card" type="button" data-slot="' + slot.key + '"' +
        ' data-root="' + esc(trend.root) + '" data-baseline="' + esc(trend.baseline) + '"' +
        ' data-target="' + esc(trend.target) + '" title="' + esc(trendSlotTooltip(slot)) + '（点击跳转对比页，基线已预填）">' +
        '<span class="trend-label-line"><span class="trend-label">' + esc(slot.label) + "</span>" +
        '<span class="trend-root">' + esc(rootLabel(trend.root)) + "</span></span>" +
        '<span class="trend-pending">正在计算对比…</span>' +
        '<span class="trend-sub">基线 ' + esc(trend.baselineAtText) + " → 最新 " + esc(trend.targetAtText) + "</span>" +
        "</button>"
    );
}

/* 阶段G（G-2）：sparkline（L3-5）内联 SVG——该根 ≥2 个逐次总量点才画折线；
   与差值卡 total_current 同口径（collectDriveTotals 取自 total_by_root）。
   返回 {html, draw}：html 为 SVG 片段；draw(svgEl, pathEl) 触发 800ms 描线
   （motion.sparkline，--dur-sparkline；reduced 直显终值）。 */
function trendSparkline(sessions, root) {
    const totals = collectDriveTotals(sessions, root);
    if (totals.length < 2) return null;
    const W = 120, H = 28;
    const values = totals.map((t) => t.bytes);
    const d = sparklinePath(values, W, H);
    const last = sparklineLastPoint(values, W, H);
    if (!d || !last) return null;
    const html =
        '<span class="trend-spark">' +
        '<svg class="trend-spark-svg" viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="none" aria-hidden="true">' +
        '<path class="trend-spark-line" d="' + esc(d) + '" fill="none"/>' +
        (last ? '<circle class="trend-spark-dot" cx="' + last.x + '" cy="' + last.y + '" r="2"/>' : "") +
        "</svg></span>";
    const draw = (svgEl) => {
        const path = svgEl && svgEl.querySelector(".trend-spark-line");
        if (path) runSparkline(svgEl, path);
    };
    return { html, draw };
}

function trendCardBody(slot, trend, cached) {
    if (cached.status === "err") {
        const isHint = cached.hint === "fullscan-first";
        const errText = isHint ? "对比不可用" : "对比失败";
        const errDetail = isHint
            ? "请先完成全量扫描，保存快照后再查看趋势"
            : (cached.error || "对比失败");
        return (
            '<button class="trend-card" type="button" data-slot="' + slot.key + '"' +
            ' data-root="' + esc(trend.root) + '" data-baseline="' + esc(trend.baseline) + '"' +
            ' data-target="' + esc(trend.target) + '" title="' + esc(trendSlotTooltip(slot)) + '（点击跳转对比页，基线已预填）">' +
            '<span class="trend-label-line"><span class="trend-label">' + esc(slot.label) + "</span>" +
            '<span class="trend-root">' + esc(rootLabel(trend.root)) + "</span></span>" +
            '<span class="trend-err" title="' + esc(errDetail) + '">' + esc(errText) + "：" +
            esc(errDetail) + "</span></button>"
        );
    }
    const d = Number(cached.delta) || 0;
    const cls = d > 0 ? "grow" : d < 0 ? "shrink" : "flat";
    const arrow = d > 0 ? "▲" : d < 0 ? "▼" : "±"; // §3.4：不得仅靠颜色（色盲冗余）
    const pctText = (Number(cached.pct) > 0 ? "+" : "") + Number(cached.pct).toFixed(2) + "%";
    // 阶段G（G-2）：sparkline（L3-5）——该根多会话逐次总量折线（数据源 total_by_root）
    const spark = trendSparkline(sessionsCache, trend.root);
    return (
        '<button class="trend-card" type="button" data-slot="' + slot.key + '"' +
        ' data-root="' + esc(trend.root) + '" data-baseline="' + esc(trend.baseline) + '"' +
        ' data-target="' + esc(trend.target) + '" title="' + esc(trendSlotTooltip(slot)) + '（点击跳转对比页，基线已预填）">' +
        '<span class="trend-label-line"><span class="trend-label">' + esc(slot.label) + "</span>" +
        '<span class="trend-root">' + esc(rootLabel(trend.root)) + "</span></span>" +
        '<span class="trend-main">' +
        '<span class="trend-delta ' + cls + '">' + arrow + " " + esc(signedBytes(d)) + "</span>" +
        '<span class="trend-pct">' + esc(pctText) + "</span>" +
        (spark ? spark.html : "") + "</span>" +
        '<span class="trend-sub">基线 ' + esc(trend.baselineAtText) + " → 最新 " + esc(trend.targetAtText) + "</span>" +
        "</button>"
    );
}

/* 阶段C（C-5）：Δ 计算复用 B-1（/api/compare 异步化）——
   - 响应 200+report → 直接入库（缓存命中同步路径）；
   - 响应 202+job_id → 轮询 /api/compare/status（≤30s 超时；B-2 同款节奏）；
   - 无全量结果（result_ready=false 且非扫描中）→ 提示先做全量扫描，不静默
     触发后台 SDK 直扫（分钟级，G8）。
   三态文案：计算中（pending）/ 失败（err）/ 无基线（empty 原因行）。
   禁止把「暂无对比基线」改为误导性「无变化」（手册 2-4 注意点）。 */
const TREND_COMPARE_TIMEOUT_MS = 30000;

async function pollCompareJob(jobId) {
    const deadline = Date.now() + TREND_COMPARE_TIMEOUT_MS;
    while (Date.now() < deadline) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 5000);
        try {
            const data = await api("/api/compare/status?job_id=" + encodeURIComponent(jobId), { signal: ctrl.signal });
            if (data && data.status === "done" && data.report) return { ok: true, report: data.report };
            if (data && data.status === "error") {
                return { ok: false, error: data.error || "对比失败" };
            }
        } catch (e) {
            if (e && e.name === "AbortError") return { ok: false, error: "对比超时（30s），可稍后重试" };
            // 轮询瞬时网络错误：继续（短暂抖动可容忍）
        } finally {
            clearTimeout(timer);
        }
        await new Promise((resolve) => setTimeout(resolve, 2000)); // 2s 轮询节奏（B-17 同频）
    }
    return { ok: false, error: "对比超时（30s），可稍后重试" };
}

async function fetchTrendCompare(slot, trend, key) {
    // 阶段C（C-5）：无全量结果（result_ready=false 且非扫描中）→ 提示先做全量扫描，
    // 不静默触发后台直扫（B-1 异步任务仅在全量索引存在时秒级；否则 SDK 直扫分钟级）。
    const scanSt = lastScanStatusForTrend || {};
    if (!scanSt.result_ready && !scanSt.running) {
        trendCache.set(key, {
            status: "err",
            error: "暂无全量扫描结果，请先完成全量扫描后再查看趋势",
            hint: "fullscan-first",
        });
        applySnapshotsView();
        return;
    }
    try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), TREND_COMPARE_TIMEOUT_MS);
        let data;
        try {
            data = await postJson("/api/compare", { root: trend.root, baseline: trend.baseline }, { signal: ctrl.signal });
        } finally {
            clearTimeout(timer);
        }
        if (data && data.status === "scanning" && data.job_id) {
            // B-1 异步任务：轮询 status 直到 done/error（复用 /api/compare/status）
            const polled = await pollCompareJob(data.job_id);
            if (!polled.ok) {
                trendCache.set(key, { status: "err", error: polled.error });
                return;
            }
            data = { report: polled.report };
        }
        const r = (data && data.report) || {};
        const totalBaseline = Number(r.total_baseline) || 0;
        const delta = Number(r.delta_total) || 0;
        trendCache.set(key, {
            status: "ok",
            root: trend.root,
            baseline: trend.baseline,
            target: trend.target,
            totalBaseline: totalBaseline,
            totalCurrent: Number(r.total_current) || 0,
            delta: delta,
            pct: totalBaseline ? (delta / totalBaseline) * 100 : 0,
            report: r, // U3.4：整份 report 入库——趋势卡点击预填时与对比页结果缓存共享（落地即渲染不回源）
        });
    } catch (e) {
        trendCache.set(key, { status: "err", error: (e && e.message) || "对比失败" });
    } finally {
        trendInflight.delete(key);
    }
    applySnapshotsView(); // 结果到达后重渲染（列表/趋势卡均从缓存回灌，不重发）
}

function renderTrendCards(sessions) {
    const row = $("trend-row");
    if (!row) return; // 快照页未挂载
    const slots = TREND_SLOTS.map((slot) => ({ slot, trend: pickTrendForSlot(sessions, slot) }));
    row.innerHTML = slots
        .map(({ slot, trend }) => {
            if (!trend) return trendCardEmpty(slot, sessions);
            const cached = trendCache.get(trendCacheKey(slot, trend));
            if (cached) return trendCardBody(slot, trend, cached);
            return trendCardPending(slot, trend);
        })
        .join("");
    // 阶段G（G-2）：sparkline 描线（L3-5，--dur-sparkline 800ms；reduced 直显）
    slots.forEach(({ trend }) => {
        if (!trend) return;
        const spark = trendSparkline(sessions, trend.root);
        if (!spark) return;
        const card = row.querySelector('.trend-card[data-root="' + CSS.escape(trend.root) + '"] .trend-spark-svg');
        if (card && spark.draw) spark.draw(card);
    });
    slots.forEach(({ slot, trend }) => {
        if (!trend) return;
        const key = trendCacheKey(slot, trend);
        if (trendCache.has(key) || trendInflight.has(key)) return;
        trendInflight.add(key);
        fetchTrendCompare(slot, trend, key); // 未缓存且在途无 → 各卡恰一次
    });
}

/* ================= 页面接线（每次挂载新 DOM 重绑） ================= */

function prefillAndGoCompare(baseline, root, target) {
    APP_STATE.compare.baseline = baseline || "";
    // ⚠️ 注记：§3.2 compare 形状之外附加 root 键（U3.4 消费「目标=同盘符最新快照」需要根）
    APP_STATE.compare.root = root || "";
    APP_STATE.compare.target = target || findLatestForRoot(sessionsCache, root || "");
    // U3.4：趋势卡已算过该基线 Δ → 结果缓存共享——#/compare 挂载时缓存命中
    // 直接渲染（不重发 /api/compare；路由往返回灌不重发语义与趋势卡一致）
    const cached = findTrendCachedResult(root || "", baseline || "");
    APP_STATE.compare.result = cached
        ? { root: root || "", baseline: baseline || "", report: cached.report, at: Date.now() }
        : null;
    location.hash = "#/compare";
}

/* trendCache 按 根+基线 找已算结果（趋势卡点击预填的缓存共享入口） */
function findTrendCachedResult(root, baseline) {
    for (const v of trendCache.values()) {
        if (v && v.status === "ok" && v.report &&
            String(v.root || "").replace(/\\+$/, "") === String(root || "").replace(/\\+$/, "") &&
            String(v.baseline || "") === String(baseline || "")) {
            return v;
        }
    }
    return null;
}

export function findLatestForRoot(sessions, root) {
    for (const s of sessions) { // 时间倒序：首个命中即该盘最新
        const entry = Object.values(s.roots || {}).find((r) => r && r.root === root && !r.skipped && r.snapshot_path);
        if (entry) return entry.snapshot_path;
    }
    return "";
}

/* 阶段C（C-3）：删除确认 → API → 刷新 + 清趋势缓存。root 空 = 整会话。 */
async function doDeleteSnapshot(sessionId, root) {
    if (!sessionId) return;
    const isWhole = !root;
    const ok = await confirmDialog({
        title: isWhole ? "删除整个会话？" : "删除该盘快照？",
        text: isWhole
            ? "将删除该会话全部盘的快照文件与清单。此操作不可撤销，确认继续？"
            : "将删除该盘快照文件并从会话清单移除（其他盘保留）。此操作不可撤销，确认继续？",
        okLabel: "删除",
        okClass: "btn-danger",
    });
    if (!ok) return;
    try {
        const data = await deleteSnapshot(sessionId, root);
        // 清 trendCache 中涉及被删基线的条目（阶段C 纪律#15：防趋势卡缓存陈旧）
        clearTrendCacheForDeleted({ root: root || undefined, baseline: undefined });
        if (data && (data.deleted || []).length) {
            toast("已删除 " + data.deleted.length + " 份快照" + (data.already && data.already.length ? "（" + data.already.length + " 份已不存在）" : ""), "success");
        } else if (data && (data.already || []).length) {
            toast("快照已不存在（幂等），已清理清单", "warn");
        } else if (data && (data.failed || []).length) {
            toast("删除部分失败：" + data.failed.map((f) => f.error).join("；"), "error");
        }
        await refreshSnapshots(); // 删除成功后刷新列表（已删项不再出现）
    } catch (e) {
        toast((e && e.message) || "删除失败", "error");
    }
}

function bindSnapshotsPage() {
    const createBtn = $("btn-create-snapshot");
    if (createBtn) createBtn.addEventListener("click", () => { if (snapActions.create) snapActions.create(false); });
    const undoBtn = $("btn-undo-save");
    if (undoBtn) undoBtn.addEventListener("click", () => { if (snapActions.undo) snapActions.undo(); });
    // 逐盘「对比此快照」→ 预填 + 跳转（§6.4 跨页形态；U3.4 消费自动对比）
    const list = $("snapshot-list");
    if (list) list.addEventListener("click", (ev) => {
        const cmpBtn = ev.target.closest(".act-cmp-snap");
        if (cmpBtn) {
            prefillAndGoCompare(
                cmpBtn.getAttribute("data-baseline") || "",
                cmpBtn.getAttribute("data-root") || "",
                ""
            );
            return;
        }
        // 阶段C（C-3）：单盘删除（确认弹窗 → API → 刷新 + 清趋势缓存）
        const delBtn = ev.target.closest(".act-del-snap");
        if (delBtn) {
            doDeleteSnapshot(
                delBtn.getAttribute("data-session") || "",
                delBtn.getAttribute("data-root") || ""
            );
            return;
        }
        // 阶段C（C-3）：整会话删除
        const delSessionBtn = ev.target.closest(".act-del-session");
        if (delSessionBtn) {
            doDeleteSnapshot(delSessionBtn.getAttribute("data-session") || "", "");
        }
    });
    // 趋势卡点击 → 预填 + 跳转（N07：点击卡片跳 #/compare 并自动填基线）
    const row = $("trend-row");
    if (row) row.addEventListener("click", (ev) => {
        const card = ev.target.closest(".trend-card[data-baseline]");
        if (!card) return;
        prefillAndGoCompare(
            card.getAttribute("data-baseline") || "",
            card.getAttribute("data-root") || "",
            card.getAttribute("data-target") || ""
        );
    });
}

/* ============================================================
   U2.1：页面契约（U3.3 填充；详见文件头注记）
   ============================================================ */

const SNAPSHOTS_PAGE_HTML =
    '<section class="page page-snapshots" data-page="snapshots">' +
    '<header class="page-head page-head-row">' +
    '<div class="page-head-titles">' +
    '<h1 class="page-title" data-page-title>快照管理</h1>' +
    '<p class="page-sub">创建快照 · 撤销最近保存 · 较昨日/较上周变化趋势与全部会话</p>' +
    "</div>" +
    '<div class="page-head-actions">' +
    '<button id="btn-create-snapshot" class="btn btn-success" disabled title="暂无全量扫描结果，请先完成全量扫描并保存">' +
    '<svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z"/><path d="M17 21v-8H7v8"/><path d="M7 3v5h8"/></svg>' +
    "创建快照</button>" +
    '<button id="btn-undo-save" class="btn btn-sm" disabled title="删除最近一次保存的快照文件与清单（无快照时不可用）">' +
    '<svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7v6h6"/><path d="M3.5 13a9 9 0 1 0 2-9.3L3 7"/></svg>' +
    "撤销最近保存</button>" +
    "</div></header>" +
    '<div class="trend-row" id="trend-row" role="group" aria-label="变化趋势（较昨日/较上周）"></div>' +
    '<div class="snapshots-list-wrap">' +
    '<div class="snapshots-list-head"><span id="snapshots-list-count">共 0 个快照会话</span></div>' +
    '<div class="snapshots-list-scroll"><ul id="snapshot-list" class="snapshot-list" aria-label="快照会话列表"></ul></div>' +
    "</div>" +
    "</section>";

export function renderSnapshots() {
    const el = document.createElement("div");
    el.innerHTML = SNAPSHOTS_PAGE_HTML;
    return el.firstElementChild;
}

export function mountSnapshots() {
    applySnapshotsView();   // 回灌（列表/趋势卡/撤销灰置；缓存优先，不重发 compare）
    bindSnapshotsPage();    // 页头/列表/趋势卡接线（新 DOM 重绑）
    ensureScanListener();   // pds:scan → 创建快照可用性（模块级一次）
}

export function unmountSnapshots() {
    /* 无 rAF/轮询；pending 的 compare 回包由 DOM 空守卫自吞 */
}
