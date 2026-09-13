/* ============================================================
   UI 2.0（SpaceLens Pro）· pages/compare.js = #/compare 空间对比页（U3.4 全量填充）
   - 布局（§3.3/§3.5）：页头（标题「空间对比」+ 对比基准下拉 + 当前磁盘状态行 +
     深度选择器 + 隐藏零变化开关 + 开始对比，控件条内容水平居中）→ 面包屑（下钻时才显示）→
     摘要 3 卡等宽（总变化/最大增长/可释放，count-up L1-4）→ 表格 flex:1
     面板内滚（变化/增速/路径/操作 F19 定位+复制路径；行 stagger L1-2）。
     （原红绿发散图区已按用户实测反馈整体移除——与摘要卡+明细表信息重复）
   - 流程（定稿 6.4）：趋势卡/迷你卡/直达三入口 → APP_STATE.compare 预填
     （§6.4 跨页形态；root 为 §3.2 之外附加键 U3.3 已记）→ 自动填对比基准
     （默认=最近一份历史快照）→ 骨架屏 → 摘要/图表/表格；
   - P5（问题 7·D5-1/D5-2/D5-5）术语与控件改造（**只改表达，不改计算**）：
     · 页头两个裸词控件改词：「基线」→「对比基准（历史快照）」、「目标」→ 删除；
       新增只读文本行 #compare-current「当前：D: · 数据时间 …」（非表单控件）；
     · 对比基准由 datalist 自由文本框升级为 <select>（保留 id #compare-baseline），
       每项「时间 · 盘符 · 自动/手动」，首项（最近一份）标注「最近一份」；
     · 页头副行自解释：「对比一次磁盘状态变化：对比基准（历史快照）→ 当前磁盘状态（实时）」；
     · 页面标题「历史对比」→「空间对比」（「历史」与「当前」自相矛盾）；
   - ⚠️ 数据源口径核对（app.py api_compare 执行核对）：/api/compare 的「当前」侧
     数据 = fullscan.result(root) 缓存 or SDK 直扫（**非快照文件**）。P5 前该事实只写在
     注释与 title= 悬停里，界面上却把这一侧标成「目标=同盘符最新快照」——把一个
     "当前磁盘状态"伪装成"目标快照"，这正是问题 7「用户看不懂」的直接成因；
     D5-1 起界面如实表述为「当前磁盘状态（实时）」；
   - P4（问题 5：深度选择 + 聚合 + 下钻）：页头新增 #compare-depth
     （叶子（默认，= 修复前口径，不发 depth）/ 1..5 层）——depth 由**后端**在
     排序/截断之前聚合（D4-1，前端不做聚合：那只能处理已被 top-100 截断的叶子行，
     上层目录增量会被严重低估）；结果行点击 = 页内下钻（以该目录为新根重新对比，
     不发「跳工作台浏览」），面包屑 #compare-crumb 逐级返回（D4-6）；
   - P4（问题 6：零增量）：页头新增 #compare-hide-zero（默认开）→ 请求带
     drop_zero=true + order_by="abs"——**后端在切片前过滤**零行并按 |delta| 排序，
     使负增量（可释放空间）不再被零行/正增量挤出榜单；空态判据改用过滤后的行集合，
     文案区分「确实无变化」与「已隐藏 N 条零变化」（D4-4）；
   - 摘要口径（D4-5）：三卡取后端 additive 字段（delta_total / max_growth /
     max_release，全量聚合行口径，未按 100 条切片），旧后端/桩态无该字段时回退
     为按 rows 现算（u34 桩态断言保持）；
   - 结果缓存：APP_STATE.compare.result（{root,baseline,depth,hideZero,report,at}）
     ——路由往返从缓存回灌不重发（缓存键含 depth + 隐藏零变化开关：口径不同必须重发）；
     快照页趋势卡已完成同对比基准计算时结果共享（snapshots.js prefillAndGoCompare 写入），
     落地即渲染不回源（**P5 未改该共享语义**：snapshots.js 写入的缓存不带 depth/hideZero
     键时沿用「不重发」口径 —— u34 ⑧b / smoke A17·A18 红线）；
   - 旧工作台「历史对比」卡本项迁整页并移除（主页仅留「最近对比」迷你卡）；
     compareSnapshots 保持 DOM 无关（页面未挂载时仅记账/圆点，供 u31 等
     跨页触发路径）；
   - 既有保留：W2.13 异机确认（machine_mismatch → confirmDialog → 二次提交带
     allow_other_machine）、W2.4 扫描中 409（toast + 按钮禁用 + pollFullscan 完成
     恢复）、act-copy-cmp 复制路径、红线 #5 esc 全量转义、#11 对比行零请求。
   - 2026-09-13 第四轮（用户实测反馈）：**折线点选 = 选对比基准**——原实现在多选
     快照后，下方对比恒取「最近一份」（select.value = 首个 selected option），多选
     只影响折线，用户无法指定「以哪一份为基准」。现「点折线上的哪个点，下方对比
     就换成针对那份快照」，折线保留全部已选（≥2 份即成线，不塌缩成单选），并用
     基准环标出当前基准点；state.baselines 改义为「用户在多选下拉里的选中集」
     （picks，跨路由重挂的记忆），state.baseline = 其中的主对比基准（点选结果）。
   ============================================================ */

import { $, api, postJson, humanBytes, signedBytes, esc } from "../api.js";
import { ICONS } from "../icons.js";
import { APP_STATE } from "../state.js";
import { setStatus } from "../components/statusbar.js";
import { toast } from "../components/toast.js";
import { confirmDialog } from "../components/modals.js";
import { copyPath, openInExplorer, getCurrentRoot } from "./workspace.js";
import { getSessionsCache } from "./snapshots.js"; // P5（D5-2）：下拉选项改由本页 rebuildBaselineOptions 构建
import { splitSessions } from "../components/snapshot-view.js"; // 2026-09-13：会话可见性/夹具过滤（同快照页口径）
import { pollFullscan } from "../components/scan.js";
import { renderCompareMini } from "../components/snapshot-mini.js"; // U2.4：最近对比迷你卡
import { markNavDot } from "../components/nav-dots.js"; // U3.1：N13 圆点提醒（对比完成）
import { countUp, staggerIn, motionDur, reducedMotion } from "../motion.js";
import { renderLine, snapshotIndexOf } from "../viz/line.js"; // P6（D6-4）：多快照趋势折线（零依赖 SVG）；2026-09-13 第四轮：点选基准
import { setPref } from "../prefs.js"; // 2026-09-13：使用偏好（默认深度 / 隐藏零变化）

/* ================= 通用 ================= */

function deltaClass(v) {
    if (v > 0) return "grow";
    if (v < 0) return "shrink";
    return "flat";
}

function arrowOf(v) {
    return v > 0 ? "▲" : v < 0 ? "▼" : "±";
}

function sessionsOf() {
    /* 2026-09-13 第三轮：对比基准只认「有内容且非夹具」的会话
       （空会话/夹具会话不参与对比，也不出现在基准下拉里） */
    const all = Array.isArray(getSessionsCache()) ? getSessionsCache() : [];
    return splitSessions(all).meaningful;
}

/* ================= 对比盘范围（2026-09-13 第三轮用户实测反馈） =================
   原实现：对比基准下拉把**所有盘**的快照混在一个列表里，用户可以同时选中
   「C 盘某次」+「D 盘另一次」——两次保存时间点不同、盘也不同，折线与对比都无意义。
   用户建议：「每次保存 CD 盘的快照都是一起保存的」→ 选中的单位应该是**一次保存**。

   本实现（后端单根契约不变）：把「盘」提为显式范围（#compare-scope）——
   基准列表只列**该盘**的历史快照（每次保存一行，按会话分组显示，组头标注该次保存
   含哪些盘），多选因此**天然同盘**；跨盘选择在 change 时被强制收敛（锁同盘）。 */

function scopeRoot() {
    const sel = $("compare-scope");
    if (sel && sel.value) return String(sel.value);
    return String(APP_STATE.compare.scope || "");
}

/* 可选盘范围：来自可见会话真正保存过的盘（时间倒序首个出现的顺序 = 最近活跃优先） */
function availableScopeRoots() {
    const seen = [];
    sessionsOf().forEach((s) => {
        Object.values(s.roots || {}).forEach((r) => {
            if (r && r.snapshot_path && !r.skipped && r.root && seen.indexOf(r.root) === -1) seen.push(r.root);
        });
    });
    return seen;
}

/* 同步盘范围下拉（保留当前选择；选择已失效则回落：预填基准的盘 → APP_STATE.root → 首个） */
function syncScopeOptions(preferred) {
    const sel = $("compare-scope");
    if (!sel) return "";
    const roots = availableScopeRoots();
    const want = [preferred, scopeRoot(), APP_STATE.compare.root, roots[0]]
        .map((r) => String(r || ""))
        .find((r) => r && roots.indexOf(r) !== -1) || "";
    sel.innerHTML = roots
        .map((r) => '<option value="' + esc(r) + '">' + esc(r.replace(/\\+$/, "")) + "</option>")
        .join("");
    sel.value = want;
    sel.disabled = roots.length < 2; // 只有一个盘时无需切换（保留可见性，避免布局跳动）
    APP_STATE.compare.scope = want;
    return want;
}

/* ================= P4：深度 / 零增量 / 下钻 状态（D4-2…D4-6） ================= */

/* 深度选择器取值："" = 叶子（默认，现状口径，不发 depth）；"1".."5" = 聚合到第 N 层 */
function depthValue() {
    const sel = $("compare-depth");
    if (sel) return String(sel.value || "");
    return String(APP_STATE.compare.depth || "");
}

/* 隐藏零变化开关（默认开）：开 = 请求带 drop_zero=true（后端切片前过滤） */
function hideZeroOn() {
    const box = $("compare-hide-zero");
    if (box) return !!box.checked;
    return APP_STATE.compare.hideZero !== false;
}

/* 当前下钻根（"" = 未下钻，对比根 = 基线所属盘） */
function drillRootOf() {
    return String(APP_STATE.compare.drillRoot || "");
}

/* 路径相等（大小写不敏感 + 去尾部分隔符；Windows 盘符口径） */
function samePath(a, b) {
    return String(a || "").replace(/[\\/]+$/, "").toLowerCase() ===
        String(b || "").replace(/[\\/]+$/, "").toLowerCase();
}

/* 面包屑链：baseRoot（对比根）→ … → drill（当前下钻根）；首项 path="" 表示回到未下钻 */
function crumbsFor(baseRoot, drill) {
    const out = [{ label: String(baseRoot || "根目录"), path: "" }];
    const d = String(drill || "").replace(/[\\/]+$/, "");
    if (!d) return out;
    const base = String(baseRoot || "").replace(/[\\/]+$/, "");
    if (base && !d.toLowerCase().startsWith(base.toLowerCase() + "\\")) return out;
    const rest = base ? d.slice(base.length).replace(/^\\+/, "") : d;
    let acc = base;
    for (const part of rest.split("\\").filter(Boolean)) {
        acc = acc ? acc + "\\" + part : part;
        // R1：面包屑段只显示当前段名（与工作台面包屑同形态 D:\ › tmp › xxx），
        // 完整累积路径保留在 title（renderCrumb 已把 path 写入 title）
        out.push({ label: part, path: acc });
    }
    return out;
}

/* 空态（D4-4）：判据 = **过滤后**的行集合，文案区分「确实无变化」与「已隐藏 N 条」 */
function emptyStateHtml(r) {
    const hidden = Number(r && r.zero_total) || 0;
    const tip = (hidden > 0 && hideZeroOn())
        ? "<p>已按「隐藏零变化」过滤 " + esc(hidden) + " 条 0 增量条目；关闭该开关可查看完整列表。</p>"
        : "<p>当前结果与基线快照一致，没有找到大小变化的目录。</p>";
    return '<div class="empty-state">' + ICONS.success + "<b>无差异</b>" + tip + "</div>";
}

/* 面包屑渲染（未下钻时整条隐藏，不占高度） */
function renderCrumb() {
    const host = $("compare-crumb");
    if (!host) return;
    const st = APP_STATE.compare;
    const base = ownerRootFor(String(st.baseline || ""), String(st.root || ""));
    const drill = drillRootOf();
    const items = crumbsFor(base, drill);
    host.innerHTML = items
        .map((it, i) => {
            const last = i === items.length - 1;
            return '<button type="button" class="crumb-item' + (last ? " is-current" : "") +
                '" data-crumb-path="' + esc(it.path) + '"' +
                ' title="' + esc(it.path || "未下钻（整个对比根）") + '"' +
                (last ? ' aria-current="page"' : "") + ">" + esc(it.label) + "</button>";
        })
        .join('<span class="crumb-sep" aria-hidden="true">›</span>');
    host.toggleAttribute("hidden", !drill);
}

/* 行点击下钻：以该目录为新根重新对比（后端按新根收窄基线两侧，D4-6） */
function drillInto(path) {
    const p = String(path || "").trim();
    if (!p) return;
    APP_STATE.compare.drillRoot = p;
    renderCrumb();
    renderTrend(); // P6（D6-4）：趋势口径随下钻目录切换（path=下钻目录，缓存键含 path）
    compareSnapshots();
}

/* 该盘最新快照（会话时间倒序首个未跳过且带 snapshot_path） */
function latestForRoot(root) {
    const r = String(root || "");
    if (!r) return "";
    for (const s of sessionsOf()) {
        const entry = Object.values(s.roots || {}).find(
            (x) => x && x.root === r && !x.skipped && x.snapshot_path
        );
        if (entry) return entry.snapshot_path;
    }
    return "";
}

/* 基线所属盘（会话内 snapshot_path 精确匹配 = 同盘符口径）；找不到回落 fallbackRoot */
function ownerRootFor(baseline, fallbackRoot) {
    const b = String(baseline || "").trim();
    if (!b) return fallbackRoot || "";
    for (const s of sessionsOf()) {
        for (const x of Object.values(s.roots || {})) {
            if (x && x.snapshot_path === b && x.root) return x.root;
        }
    }
    return fallbackRoot || "";
}

/* 默认基线（定稿「默认最近一份」）：优先当前盘最新快照；
   无则该盘无快照 → 回退最近会话首个可用快照（旧行为）并携带 owner 根 */
function defaultBaseline(root) {
    const latest = latestForRoot(root);
    if (latest) return latest;
    for (const s of sessionsOf()) {
        const ok = Object.values(s.roots || {}).find((x) => x && !x.skipped && x.snapshot_path);
        if (ok) return ok.snapshot_path;
    }
    return "";
}

/* ================= APP_STATE.compare 预填（三入口统一落点） ================= */

/* 该快照路径是否属于当前可见（有内容且非夹具）会话——外部预填/旧缓存可能指向
   已被隐藏的夹具或空会话，必须能识别并回落默认（2026-09-13 第三轮）。 */
function baselineIsAvailable(path) {
    const p = String(path || "").trim();
    if (!p) return false;
    return sessionsOf().some((s) =>
        Object.values(s.roots || {}).some((r) => r && !r.skipped && r.snapshot_path === p));
}

/* 从 APP_STATE 预填 + 推导默认；返回 {root,baseline,target} 或 null（无任何快照） */
function ensurePrefill() {
    const st = APP_STATE.compare;
    let root = String(st.root || getCurrentRoot() || "");
    let baseline = String(st.baseline || "").trim();
    /* 2026-09-13 第四轮：多选记忆优先于「默认最近一份」——否则任何一次预填重算
       （冷启动/会话晚到/路由回挂）都会把用户已选的多份收敛成最新一份，折线无声消失。
       记忆按时间倒序，首项即「最近一份」，与既有默认口径一致。 */
    if (!baseline) baseline = pickedFromState()[0] || "";
    if (baseline && !baselineIsAvailable(baseline)) baseline = ""; // 夹具/空会话 → 弃用
    if (!baseline) baseline = defaultBaseline(root);
    if (!baseline) {
        st.root = root;
        st.baseline = "";
        st.target = "";
        return null;
    }
    const owner = ownerRootFor(baseline, root);
    if (owner) root = owner;
    const target = String(st.target || "") || latestForRoot(root);
    st.root = root;
    st.baseline = baseline;
    st.target = target;
    st.scope = root; // 2026-09-13 第三轮：盘范围与预填基准同盘
    return { root: root, baseline: baseline, target: target };
}

/* 表单回显（对比基准下拉 / 当前磁盘状态行 / 页头副行）
   P5（D5-1/D5-2）：
   - 「对比基准（历史快照）」= <select>：选项由 rebuildBaselineOptions 重建，
     本函数在挂载/预填时把选中项对齐到 sel.baseline；
   - 「当前磁盘状态（实时）」= #compare-current 只读文本行（原只读「目标」输入框删除）；
     它显示的是**当前磁盘状态**，不是快照——「目标=同盘符最新快照」是旧标识性口径，
     已随 D5-1 删除（app.py 的 /api/compare「当前」侧 = fullscan.result(root) 或 SDK 直扫，
     与快照文件无关；旧文案把一个"当前磁盘状态"伪装成"目标快照"）。
     ⚠️ APP_STATE.compare.target 仍由三入口预填写入（snapshots.js 契约与 smoke/u34
     预填断言面），本页只把它当作「当前数据的展示标识」，不再宣称它是对比目标。 */
function syncForm(sel) {
    const p = sel || { root: String(APP_STATE.compare.root || ""), baseline: String(APP_STATE.compare.baseline || "") };
    rebuildBaselineOptions(sessionsOf());
    const b = $("compare-baseline");
    if (b) {
        const want = String(p.baseline || "");
        /* P6（D6-5）：多选语义——若 want 已在选中集里（多选中的一份）则**不得**写 value：
           对 <select multiple> 赋 value 会把其余选中项全部取消（HTML 规范），
           那会在每次对比/回灌时把用户的多选悄悄收敛成单选。 */
        const already = Array.from(b.selectedOptions || []).some((o) => o.value === want);
        if (want && !already) b.value = want;
        /* 选项集里没有该路径（外部预填/缓存共享）时补一条，避免选中态与 state 不一致。
           ⚠️ 2026-09-13 第三轮：仅当它与当前**盘范围**同盘时才补——否则会把别盘的
           快照塞回列表，破坏「多选=同盘多次保存」的不变量（该快照会被 enforceSameDrive 丢弃）。 */
        const wantRoot = ownerRootFor(want, "");
        const scope = scopeRoot();
        if (b.value !== want && want && (!scope || !wantRoot || wantRoot === scope)) {
            const opt = document.createElement("option");
            opt.value = want;
            opt.textContent = baselineOptionText(want, snapMetaFor(want));
            opt.dataset.root = wantRoot || "";
            b.appendChild(opt);
            b.value = want;
        }
        b.dataset.root = String(p.root || "");
        /* 主基准显式登记（dataset.base）：**不能**靠 sel.value 推断（多选下它是最新一份）。
           只有该路径确实在选项集里时才登记，避免把不可选/别盘的旧值写成主基准。 */
        if (want && snapIsSelectable(want)) setPrimaryBaseline(b, want);
    }
    syncCurrentRow(p.root);
    const rl = $("compare-root-line");
    if (rl) {
        const rootText = String(p.root || "").replace(/\\+$/, "");
        rl.textContent = rootText
            ? "对比一次磁盘状态变化：对比基准（历史快照）→ 当前磁盘状态（实时） · 盘 " + rootText
            : "对比一次磁盘状态变化：对比基准（历史快照）→ 当前磁盘状态（实时）";
    }
}

/* 页头「当前磁盘状态」一行（D5-1）：盘符 + 数据时间；数据时间取该盘最新快照的
   采集时刻（#compare-current 单行，因此不再单列该盘最新快照全文）。
   无信息时不编造——显示「尚未扫描」并说明原因。 */
function syncCurrentRow(root) {
    const host = $("compare-current");
    if (!host) return;
    const r = String(root || APP_STATE.compare.root || "");
    const rootText = r.replace(/\\+$/, "");
    const dataAt = snapMetaFor(latestForRoot(r)).atText;
    host.textContent = rootText
        ? "当前：" + rootText + " · " + (dataAt ? "数据时间 " + dataAt : "尚未扫描（无快照）")
        : "当前：尚未选择盘符";
    host.dataset.root = r;
    host.dataset.at = dataAt || "";
}

/* 快照标识 → {createdText, atText, auto}（下拉选项与当前状态行共用同一取值口径） */
function snapMetaFor(snapshotPath) {
    const p = String(snapshotPath || "").trim();
    if (!p) return { createdText: "", atText: "", auto: null };
    for (const s of sessionsOf()) {
        for (const x of Object.values(s.roots || {})) {
            if (x && x.snapshot_path === p) {
                const created = String(s.created_at || "");
                return {
                    createdText: created.replace("T", " "),
                    atText: created.replace("T", " "),
                    auto: s.auto === undefined ? null : !!s.auto,
                };
            }
        }
    }
    /* 会话缓存不可得（外部路径/缓存共享）：退回文件名内嵌时间戳 D_YYYYMMDD_HHMMSS_* */
    const m = /_(\d{8})_(\d{6})_/.exec(p);
    const text = m ? m[1].slice(0, 4) + "-" + m[1].slice(4, 6) + "-" + m[1].slice(6, 8) +
        " " + m[2].slice(0, 2) + ":" + m[2].slice(2, 4) + ":" + m[2].slice(4, 6) : "";
    return { createdText: text, atText: text, auto: null };
}

/* 下拉选项文案（D5-2）：每项「时间 · 盘符 · 自动/手动」；最近一份额外标注「最近一份」
   ⚠️ 时间必须与 snapshots.js formatCreatedAt 同口径（ISO 的 "T" 换成空格）——
   直接把 created_at 原文塞进选项会显示 "2026-08-24T12:00:00"，可读性差且与快照页不一致。 */
function baselineOptionText(path, meta, isLatest) {
    const parts = [];
    const created = String(meta.createdText || "").replace("T", " ");
    if (created) parts.push(created);
    const owner = ownerRootFor(path, "");
    if (owner) parts.push(owner.replace(/\\+$/, ""));
    if (meta.auto === true) parts.push("自动");
    else if (meta.auto === false) parts.push("手动");
    const head = parts.length ? parts.join(" · ") : "该盘快照";
    return (isLatest ? "最近一份 · " : "") + head;
}

/* 重建对比基准列表（D5-2 单选 → P6·D6-5 可多选 → 2026-09-13 第三轮**按盘范围过滤**）：
   时间倒序（最近在前）；最近一份 = 该盘首个可用项。
   ⚠️ 多选保持：重建前先记录当前选中集（含用户追加的），重建后逐项恢复；
   没有任何历史选中时按 keep（state 预填）恢复为单选。
   返回 = { count, scope }（count = 选项数；0 表示该盘无可用快照 → 保持空态）。 */
export function rebuildBaselineOptions(sessions) {
    const sel = $("compare-baseline");
    if (!sel || sel.tagName !== "SELECT") return { count: 0, scope: "" };
    const prevSelected = Array.from(sel.selectedOptions || []).map((o) => o.value);
    const keep = String(sel.value || APP_STATE.compare.baseline || "");
    /* 盘范围（先按预填/历史推断，再过滤列表——保证「同一盘才可比」） */
    const scope = syncScopeOptions(ownerRootFor(keep, APP_STATE.compare.root || ""));
    const entries = [];
    (sessions || []).forEach((s) => {
        Object.values(s.roots || {}).forEach((r) => {
            if (!r || !r.snapshot_path || r.skipped) return;
            if (scope && String(r.root || "") !== scope) return; // 只列当前盘范围
            entries.push({
                path: r.snapshot_path, root: r.root,
                created: String(s.created_at || ""),
                auto: s.auto === undefined ? null : !!s.auto,
                session: String(s.session_id || ""),
                peers: Object.values(s.roots || {})
                    .filter((x) => x && x.snapshot_path && !x.skipped && x.root !== r.root)
                    .map((x) => String(x.root || "").replace(/\\+$/, ""))
                    .join(" "),
            });
        });
    });
    entries.sort((a, b) => String(b.created).localeCompare(String(a.created)));
    const seen = new Set();
    const uniq = entries.filter((e) => (seen.has(e.path) ? false : (seen.add(e.path), true)));
    sel.innerHTML = "";
    uniq.forEach((e, i) => {
        const opt = document.createElement("option");
        opt.value = e.path;
        opt.textContent = baselineOptionText(e.path, { createdText: e.created, auto: e.auto }, i === 0);
        opt.title = e.path;
        opt.dataset.root = e.root || "";
        opt.dataset.created = e.created;
        opt.dataset.session = e.session;
        opt.dataset.peers = e.peers;
        if (i === 0) opt.dataset.latest = "1";
        sel.appendChild(opt);
    });
    const wanted = prevSelected.length
        ? prevSelected
        : (pickedFromState().length ? pickedFromState() : (keep ? [keep] : []));
    const present = wanted.filter((w) => uniq.some((e) => e.path === w));
    if (present.length) {
        Array.from(sel.options).forEach((o) => { o.selected = present.indexOf(o.value) !== -1; });
    }
    sel.dataset.optionCount = String(uniq.length);
    sel.dataset.scope = scope;
    /* 2026-09-13 第四轮：「会话晚到」等重建路径不得把多选悄悄收敛成单选。
       把恢复后的选择集写回记忆（ensurePrefill 先读它，否则会把用户已选的多份
       覆盖回「最近一份」，折线塌缩成 1 份而无声消失）；空选择不动记忆，
       免得把「换盘清空」的中间态写进去。 */
    const restored = Array.from(sel.selectedOptions || []).map((o) => o.value).filter(Boolean);
    if (restored.length) rememberPicks(restored);
    renderBaselinePanel(); // R1：自定义下拉面板镜像刷新（面板不在 DOM 时函数内守卫）
    return { count: uniq.length, scope: scope };
}

/* 同盘锁定（2026-09-13 第三轮）：把选中集里不属于当前盘范围的项取消选择。
   正常路径下列表已按盘过滤、不会混选；本函数是**兜底**（跨页预填/手工写 state/
   会话后来被删等），保证「多选 = 同一盘的不同时间点」这一不变量。
   返回被丢弃的盘符数组（供提示）。 */
function enforceSameDrive() {
    const sel = $("compare-baseline");
    if (!sel) return [];
    const scope = scopeRoot() || sel.dataset.scope || "";
    if (!scope) return [];
    const dropped = [];
    Array.from(sel.options || []).forEach((o) => {
        if (o.selected && o.dataset.root && o.dataset.root !== scope) {
            o.selected = false;
            dropped.push(o.dataset.root);
        }
    });
    return dropped;
}

/* 组头文案（下拉面板）：这次保存的时间 · 自动/手动 · 该次保存含哪些盘
   ——把「一次保存 = 一个时间点、CD 盘一起保存」讲明白（用户第三轮反馈的语义） */
function sessionGroupText(opt) {
    const when = String(opt.dataset.created || "").replace("T", " ").slice(0, 16);
    const self = String(opt.dataset.root || "").replace(/\\+$/, "");
    const peer = String(opt.dataset.peers || "");
    const bits = [when || "该次保存"];
    bits.push(peer ? "该次保存含 " + self + " " + peer : self);
    return bits.join(" · ");
}

/* 结果缓存命中判定（同根同基线 **同口径** → 回灌渲染不重发）
   P4：缓存键并入 depth 与「隐藏零变化」——口径不同必须重发，否则切换深度会
   渲染上一次深度的报告。
   ⚠️ 跨页共享兼容：snapshots.js 趋势卡写入的缓存（prefillAndGoCompare）不带这两个
   键（该文件不在 P4 授权面），此时沿用既有「落地渲染不重发」语义（u34 ⑧b /
   smoke A17·A18 红线）：仅在缓存**带**该键且与当前控件不一致时才判为未命中。 */
function resultCacheMatch(sel) {
    const c = APP_STATE.compare.result;
    if (!c || !c.report) return null;
    if (!sel) return null;
    const wantRoot = drillRootOf() || sel.root;
    if (!samePath(c.root, wantRoot)) return null;
    if (String(c.baseline || "").trim() !== String(sel.baseline || "").trim()) return null;
    if (c.depth !== undefined && String(c.depth == null ? "" : c.depth) !== String(depthValue())) return null;
    if (c.hideZero !== undefined && !!c.hideZero !== hideZeroOn()) return null;
    return c;
}

/* ================= P6（D6-3/D6-4/D6-5）：多快照趋势折线 =================
   - 数据源：GET /api/series（P6 新增，additive）——root + snapshots[] + path + depth；
   - 触发：对比基准选中 ≥2 份（D6-5）；否则趋势卡显示**原因**（禁止永久空白）；
   - 口径：序列每个点都取自快照自身（与趋势卡/sparkline 同源），
     path = 当前下钻目录（未下钻 = 整盘根口径），depth 与页头深度选择器同值；
   - 上限：最多取 SERIES_MAX_POINTS（12）份，与后端 SERIES_MAX_POINTS 同值（D6-6）；
   - 缓存：键 = root|path|depth|快照清单——同一选择切页往返不重发。

   2026-09-13 第四轮（用户实测反馈）：「多选快照后，折线图下方的对比依旧是和最近一份
   快照的对比」——因为修复前 主对比基准 恒 = 选中集里最新的一份（`select.value` = 首个
   selected option，选项按时间倒序），多选只影响折线、不影响对比对象，用户无法选择
   「以哪一份为基准」。本轮定稿（用户裁定）：**点折线上的某个点 = 以那份快照为对比基准**
   重算下方摘要/表格；折线**保留全部已选**（≥2 份即成线，不因点选而塌缩成单选）。
      · `state.baselines`（启用为 picks）= 用户在多选下拉里的**选中集**（跨路由往返
        不丢），`state.baseline` = 其中的 主对比基准（= 点选结果，缺省 = 最新一份）；
      · 点选只改 `baseline` + 主对比基准的 select.value，**不动** picks —— 折线原样保留；
      · 折线上用「基准环 + 实心点」标出当前对比基准（`.line-dot.is-active`
        / `#compare-trend-host[data-active]`），用户随时能看出此刻在与哪份快照比。 */

const SERIES_MAX_POINTS = 12;
const seriesCache = new Map(); // key → {status:"ok", points, reason}|{status:"err", error}
const seriesInflight = new Set();

/* 当前选择下**已缓存**的折线数据点（无缓存 → []）：页头提示 / 基准下拉文案 /
   点选下标解析共用同一份——三处都不重发请求，只读缓存。 */
function trendPoints() {
    const hit = seriesCache.get(trendSeriesKey(selectedBaselines()));
    return (hit && hit.status === "ok" && Array.isArray(hit.points)) ? hit.points : [];
}

/* 状态里记住的「已选快照」清单（多选下拉的持久记忆，详见文件头第四轮注记） */
function pickedFromState() {
    const arr = APP_STATE.compare.baselines;
    return Array.isArray(arr) ? arr.map((x) => String(x || "")).filter(Boolean) : [];
}

/* 已选对比基准（时间倒序，与原下拉同序）；超上限时只取最新 N 份。
   ⚠️ 三层兜底：DOM 多选 > state 记忆（跨路由重挂后 DOM 是新节点、已空）> 主基准单值。 */
function selectedBaselines() {
    const sel = $("compare-baseline");
    const picked = sel ? Array.from(sel.selectedOptions || []).map((o) => o.value).filter(Boolean) : [];
    if (picked.length) return picked.slice(0, SERIES_MAX_POINTS);
    const remembered = pickedFromState();
    if (remembered.length) return remembered.slice(0, SERIES_MAX_POINTS);
    const one = String((sel && sel.value) || APP_STATE.compare.baseline || "").trim();
    return one ? [one] : [];
}

/* picks 记账（多选下拉 change 与挂载回灌统一走这里） */
function rememberPicks(list) {
    APP_STATE.compare.baselines = (list || []).map((x) => String(x || "")).filter(Boolean);
}

/* 已选数量提示（页头控件副行；≥2 份时高亮）
   文案刻意保持短（与控件标题同行不换行，页头 64px 预算）
   R1：不再提「Ctrl/⌘」——自定义下拉点击即多选
   2026-09-13 第四轮：≥2 份时补出「正在与哪份快照比」（点选改基准后的可见回执） */
function syncBaselineHint() {
    const hint = $("compare-baseline-hint");
    if (!hint) return 0;
    const n = selectedBaselines().length;
    if (n < 2) {
        hint.textContent = "已选 " + n + " 份";
        hint.classList.remove("is-multi");
        return n;
    }
    const points = trendPoints();
    const i = snapshotIndexOf(points, APP_STATE.compare.baseline);
    const at = i > 0 ? String((points[i] && points[i].label) || "").replace("T", " ") : "";
    hint.textContent = at ? "已选 " + n + " 份 · 对比 " + at : "已选 " + n + " 份 · 趋势已开启";
    hint.classList.toggle("is-multi", true);
    return n;
}

/* 快照路径是否在当前基准列表里（可选性判定，与 rebuildBaselineOptions 同口径） */
function snapIsSelectable(path) {
    const sel = $("compare-baseline");
    if (!sel || !path) return false;
    return Array.from(sel.options || []).some((o) => o.value === path);
}

/* ================= 主对比基准的**单一收口**（2026-09-13 第四轮） =================
   ⚠️ 这里踩过一个真坑（smoke A22 抓到的）：`<select multiple>` 的 `value`
   **恒等于「DOM 里第一个 selected 选项」**，与「最后赋值/用户最后点的那一项」无关。
   基准列表按时间倒序 → 多选时 `sel.value` 永远是**最新一份**：折线点选把
   `sel.value = 选中项` 之后，只要再补写其余 selected（picks 不能丢），`sel.value`
   立刻又被「最新的那一项」夺回；于是 compareSnapshots 读到的仍是最近一份，
   **下方对比照旧跟最近一份比**——用户反馈的现象在"点选"接上之后仍会复现。
   因此主基准不从 `sel.value` 推断，而是显式写两处：
     · `sel.dataset.base`（表单层单一事实源，`primaryBaseline()` 优先读它）
     · `APP_STATE.compare.baseline`（应用层；跨页入口/缓存共享直接读 state） */
function setPrimaryBaseline(sel, path) {
    const el = sel || $("compare-baseline");
    const p = String(path || "").trim();
    APP_STATE.compare.baseline = p;
    if (el) el.dataset.base = p;
    return p;
}

/* 当前主基准：表单显式值优先（dataset.base），其次 state；**绝不**用 sel.value
   ——多选下那是「最新的那一项」（见上注记）。 */
function primaryBaseline() {
    const el = $("compare-baseline");
    const fromForm = el ? String(el.dataset.base || "").trim() : "";
    if (fromForm) return fromForm;
    return String(APP_STATE.compare.baseline || "").trim();
}

/* 把 state 的选择集回写到 <select multiple> 的 DOM 镜像（picks → selected）。
   ⚠️ 不能靠"设一次 selected 就完事"：`sel.value = X` 与插入选项都可能重置选中态，
   而多选下 `sel.value` 又会跳回「最新一份」。所以镜像刷新是**幂等重放**：
   以 state 为唯一事实源，重新逐项对齐（可重复调用，无副作用）。 */
function mirrorPicksToSelect(sel) {
    const el = sel || $("compare-baseline");
    if (!el || el.tagName !== "SELECT") return 0;
    const picks = pickedFromState();
    const wanted = picks.length ? picks : [primaryBaseline()].filter(Boolean);
    Array.from(el.options).forEach((o) => { o.selected = wanted.indexOf(o.value) !== -1; });
    return wanted.length;
}

/* ================= R1：基准选择器自定义下拉 =================
   原生 <select id="compare-baseline" multiple> 收为隐藏数据模型（重建/预填/缓存/
   趋势等全部既有逻辑继续读写它）；本组函数只做可视层镜像：
   面板行点击 → 翻转 option.selected + 派发 change（既有 change 链自动接管）。 */
function syncBaselineTrigger() {
    const sel = $("compare-baseline");
    const txt = $("baseline-trigger-text");
    if (!sel || !txt) return;
    const picked = Array.from(sel.selectedOptions || []);
    if (!picked.length) {
        txt.textContent = "选择对比基准…";
        return;
    }
    const first = picked[0];
    const root = first.dataset.root ? " · " + first.dataset.root : "";
    const whenOf = (opt) => String((opt && opt.dataset && opt.dataset.created) || "")
        .replace("T", " ").slice(0, 16);
    /* 2026-09-13 第四轮：多选时触发钮文案带上**主对比基准**（点选结果可能不是最新一份） */
    const at = (points) => {
        const i = snapshotIndexOf(points, APP_STATE.compare.baseline);
        return i >= 0 ? String((points[i] && points[i].label) || "").replace("T", " ").slice(0, 16) : "";
    };
    const baseAt = at(trendPoints());
    if (picked.length >= 2) {
        const newest = whenOf(first) || first.textContent;
        /* 基准 = 最新一份（未点选）时保持旧口径「最新 …」，避免同义重复 */
        txt.textContent = baseAt && baseAt !== newest
            ? "已选 " + picked.length + " 份 · 对比 " + baseAt
            : "已选 " + picked.length + " 份（最新 " + newest + root + "）";
        return;
    }
    /* 单选：显示**选中项**（点选另一份会走这里，不能沿用 picked[0] 的"最新"口径） */
    const cur = picked.filter((o) => o.value === String(APP_STATE.compare.baseline || ""))[0] || first;
    txt.textContent = (whenOf(cur) || cur.textContent) + root;
}

function renderBaselinePanel() {
    const panel = $("baseline-panel");
    const sel = $("compare-baseline");
    if (!panel || !sel) return;
    const opts = Array.from(sel.options || []);
    if (!opts.length) {
        const scope = scopeRoot();
        panel.innerHTML = '<div class="baseline-empty muted">' +
            (scope
                ? "该盘（" + esc(scope.replace(/\\+$/, "")) + "）还没有快照，请先全量扫描并保存"
                : "暂无可用快照，请先全量扫描并保存") +
            "</div>";
        return;
    }
    /* 2026-09-13 第三轮：按**会话（一次保存）**分组——组头写明这次保存的时间与含哪些盘，
       组内是该盘的快照项；列表已按盘范围过滤，因此多选天然同盘。 */
    let lastSession = null;
    const html = [];
    opts.forEach((o, i) => {
        const sid = String(o.dataset.session || "");
        if (sid && sid !== lastSession) {
            lastSession = sid;
            html.push('<div class="baseline-group" role="presentation">' + esc(sessionGroupText(o)) + "</div>");
        }
        html.push(
            '<button type="button" class="baseline-opt' + (o.selected ? " is-on" : "") + '"' +
            ' role="option" aria-selected="' + (o.selected ? "true" : "false") + '" data-idx="' + i + '"' +
            ' title="' + esc(o.value) + '">' +
            '<span class="baseline-check" aria-hidden="true">' + (o.selected ? "✓" : "") + "</span>" +
            '<span class="baseline-opt-text">' + esc(o.textContent) + "</span>" +
            "</button>"
        );
    });
    panel.innerHTML = html.join("");
}

function closeBaselinePanel() {
    const panel = $("baseline-panel");
    const trigger = $("baseline-trigger");
    if (panel && !panel.hidden) panel.hidden = true;
    if (trigger) trigger.setAttribute("aria-expanded", "false");
}

function bindBaselinePicker() {
    const trigger = $("baseline-trigger");
    const panel = $("baseline-panel");
    const sel = $("compare-baseline");
    if (!trigger || !panel || !sel) return;
    trigger.addEventListener("click", () => {
        const opening = !!panel.hidden;
        if (opening) renderBaselinePanel();
        panel.hidden = !opening;
        trigger.setAttribute("aria-expanded", String(opening));
    });
    panel.addEventListener("click", (ev) => {
        const btn = ev.target && ev.target.closest ? ev.target.closest(".baseline-opt") : null;
        if (!btn) return;
        const opt = sel.options[Number(btn.dataset.idx)];
        if (!opt) return;
        opt.selected = !opt.selected;
        sel.dispatchEvent(new Event("change", { bubbles: true })); // 既有 change 链接管（syncForm/趋势/提示）
        renderBaselinePanel();
    });
    panel.addEventListener("keydown", (ev) => {
        if (ev.key === "Escape") {
            closeBaselinePanel();
            trigger.focus();
        }
    });
    sel.addEventListener("change", syncBaselineTrigger);
    // 组外点击收起（document 级只绑一次；页面重挂时旧面板已随 DOM 卸载，守卫无碍）
    if (!bindBaselinePicker.outsideBound) {
        bindBaselinePicker.outsideBound = true;
        document.addEventListener("pointerdown", (ev) => {
            const p = $("baseline-panel");
            if (!p || p.hidden) return;
            const t = ev.target;
            if (t && t.closest && t.closest("#baseline-picker")) return;
            closeBaselinePanel();
        });
    }
}

/* R1：会话数据晚于页面挂载到达时（冷启动直达 #/compare 的竞态），
   pds:snapshots 广播到达后重建基准选项；首次有选项时按既有语义预填最近一份。 */
function bindSnapshotsRefresh() {
    if (bindSnapshotsRefresh.bound) return;
    bindSnapshotsRefresh.bound = true;
    window.addEventListener("pds:snapshots", () => {
        if (!isPageMounted()) return;
        const sel = $("compare-baseline");
        if (!sel) return;
        const hadOptions = (sel.options ? sel.options.length : 0) > 0;
        rebuildBaselineOptions(sessionsOf());
        if (!hadOptions && sel.options.length) {
            const pre = ensurePrefill();
            syncForm(pre);
            syncBaselineHint();
            renderTrend();
            /* 2026-09-13 第三轮：冷启动直达 #/compare 时会话缓存尚空 → 挂载期
               ensurePrefill 落空（空态且不会自动对比）。会话晚到后这里补完预填，
               **同时补跑对比**——原实现只预填不执行，页面会一直停在
               「选择一份对比基准」空态，直到用户手动选一次（实测冷启动 90s 无结果）。 */
            if (pre) compareSnapshots();
            else showEmpty();
        }
        syncBaselineTrigger();
    });
}

function trendSeriesKey(baselines) {
    const st = APP_STATE.compare;
    return [
        String(st.root || ""),
        drillRootOf(),
        depthValue(),
        baselines.join("\u0001"),
    ].join("|");
}

/* /api/series 结果 → 折线数据点（label=快照采集时刻，value=字节数） */
function seriesPointsToChart(points) {
    return (points || []).map((p) => ({
        label: String(p.created_at || "").replace("T", " "),
        value: Number(p.bytes) || 0,
        sub: p.present === false ? "该快照无此目录" : "",
        snapshot: p.snapshot,
    }));
}

/* 序列空态原因（复用 trendEmptyReason 的「给原因不空白」口径） */
function seriesReason(data) {
    if (!data) return "趋势数据不可用";
    if (data.reason === "no_snapshots") return "还没有快照，先做全量扫描并保存";
    if (data.reason === "all_unavailable") return "所选快照不可用（已删除或损坏）";
    return "所选快照不足 2 个可用数据点，无法成线";
}

/* ================= 点选：折线数据点 → 对比基准（2026-09-13 第四轮） =================
   用户反馈：「多选快照后，折线图下方的对比依旧是和最近一份快照的对比」。
   定稿：点折线上的哪个点，下方对比就换成针对那份快照（与「当前磁盘状态」比）。
   实现要点（都在这里收口，避免散落）：
   · 只改主基准（`state.baseline` + `sel.dataset.base`），**不动** 已选清单（picks）——
     折线保留全部已选（≥2 份即成线），不会因为点一下就塌缩成单选；
   · 换基准 = 换对比对象 → 沿用既有语义：下钻根失效、结果缓存弃用、重跑 /api/compare；
   · 折线本身不重发 /api/series（选择集没变），只重画基准环（renderTrend 读缓存）。
   ⚠️ 两个已踩过的坑（改这段前必读）：
   1) `<select multiple>` 的 `value` 恒等于「DOM 里第一个 selected 项」，与"最后点的那项"
      无关 → 主基准绝不能从 `sel.value` 读（否则多选下永远是最近一份，点选形同无效）；
   2) 给多选 `select` 赋 `value` 会清掉其余选中项 → 赋值之后必须按 state **重放**镜像
      （mirrorPicksToSelect），且重放要放在重跑对比之后再做一次，避免任何后续
      重建把可见的选中集留在"只剩一份"的状态。 */
function pickBaselineFromTrend(idx, point) {
    const snap = String((point && point.snapshot) || "");
    if (!snap) {
        setStatus("compare-status", "warn", "这个数据点没有对应的快照文件，无法作为对比基准");
        return;
    }
    if (snap === String(APP_STATE.compare.baseline || "")) return; // 已是当前基准：无需重算
    /* 主基准登记（表单层 dataset.base + 应用层 state 同收口），再把 picks 回写到
       <select multiple>（多选下赋 value 会清掉其余选中项，故用幂等重放）。 */
    const sel = $("compare-baseline");
    setPrimaryBaseline(sel, snap);
    mirrorPicksToSelect(sel);
    APP_STATE.compare.result = null; // 换基准 → 弃用旧报告缓存（与下拉换基准同口径）
    if (APP_STATE.compare.drillRoot) {
        APP_STATE.compare.drillRoot = ""; // 换对比对象 → 原下钻根失效
        renderCrumb();
    }
    const at = String((point && point.label) || "").replace("T", " ");
    toast(at ? "已把对比基准换成 " + at + " 的快照" : "已把对比基准换成该快照", "info");
    renderTrend();      // 折线保留全部已选：只更新「基准环」+ 页头提示
    syncBaselineTrigger();
    compareSnapshots(); // 下方摘要/表格改按点中的这份快照对比
    /* 重跑对比会经过 syncForm（会重建选项/重放选中集），完成后按 state 再重放一次——
       幂等，保证可见的「已选 N 份」与折线口径和 state 一致。 */
    mirrorPicksToSelect($("compare-baseline"));
    syncBaselineTrigger();
}

function setTrendState(state, subText) {
    const card = $("compare-trend");
    if (card) card.dataset.state = state;
    /* P6（D6-4）：趋势成图时给结果区加 has-trend —— 分区图让出高度（style.css），
       保证 1366×768 下「趋势 + 发散图 + 表格」三件同屏。 */
    const result = $("compare-result");
    if (result) result.classList.toggle("has-trend", state === "ok");
    const sub = $("compare-trend-sub");
    if (sub) {
        sub.textContent = subText || "";
        /* 空闲/错误态只留一行原因（避免与 .line-empty 文案重复） */
        sub.toggleAttribute("hidden", !subText);
    }
}

/* 趋势卡副行文案（成图态）：份数 + 口径 + 「正在与哪份比」（2026-09-13 第四轮）。
   点选基准后这一行会给出可见回执；未点选（基准仍是最新一份）保持原口径。 */
function trendSubText(count) {
    const scope = drillRootOf()
        ? "目录 " + String(drillRootOf()).replace(/\\+$/, "")
        : "整盘 " + String(APP_STATE.compare.root || "").replace(/\\+$/, "");
    const points = trendPoints();
    const i = snapshotIndexOf(points, APP_STATE.compare.baseline);
    const at = i > 0 ? String((points[i] && points[i].label) || "").replace("T", " ") : "";
    return "共 " + count + " 个快照 · " + scope + (at ? " · 正与 " + at + " 比" : "");
}

/* 渲染趋势卡（不重发：命中 seriesCache 直接画）
   2026-09-13 第四轮：把「点选基准」的语义接进来——onPick 换对比基准、
   active 标出当前基准点（折线保留全部已选，点选不塌缩成单选）。 */
export function renderTrend() {
    const host = $("compare-trend-host");
    if (!host) return 0;
    const baselines = selectedBaselines();
    const n = syncBaselineHint();
    if (baselines.length < 2) {
        setTrendState("idle", "");
        renderLine(host, {
            points: [],
            reason: n === 0
                ? "还没有可用快照：全量扫描并保存后，这里会显示逐次变化折线"
                : "再选 1 份对比基准即可成线（点击「对比基准」列表里的快照可追加选择）",
        });
        return 0;
    }
    const key = trendSeriesKey(baselines);
    const cached = seriesCache.get(key);
    if (cached && cached.status === "ok") {
        setTrendState("ok", trendSubText(cached.points.length));
        const r = renderLine(host, {
            points: cached.points,
            onPick: pickBaselineFromTrend,
            active: snapshotIndexOf(cached.points, APP_STATE.compare.baseline),
        });
        host.dataset.seriesKey = key;
        return r.count;
    }
    if (seriesInflight.has(key)) return 0;
    /* root 为空（冷启动直达对比页未选盘）时后端必 400「缺少 root 参数」——
       不发请求，直接渲染空态原因（与「无快照」同口径：给原因不空白） */
    if (!String(APP_STATE.compare.root || "").trim() && !drillRootOf()) {
        setTrendState("idle", "尚未选择盘符：先在工作台选择盘符并全量扫描，再回这里查看趋势");
        renderLine(host, {
            points: [],
            reason: "尚未选择盘符：先在工作台选择盘符并完成全量扫描，趋势折线会在这里显示",
        });
        return 0;
    }
    seriesInflight.add(key);
    setTrendState("loading", "正在读取 " + baselines.length + " 份快照的序列…");
    host.dataset.state = "loading";
    host.innerHTML = '<p class="line-loading">正在读取 ' + esc(baselines.length) + " 份快照的序列…</p>";
    const params = new URLSearchParams();
    params.set("root", String(APP_STATE.compare.root || ""));
    baselines.forEach((b) => params.append("snapshots", b));
    if (drillRootOf()) params.set("path", drillRootOf());
    const depthText = depthValue();
    if (depthText) params.set("depth", depthText);
    params.set("limit", String(SERIES_MAX_POINTS));
    let fetchError = null; // err 不入持久缓存（否则失败被永久缓存，保存新快照后也无法重试）
    api("/api/series?" + params.toString())
        .then((data) => {
            const points = seriesPointsToChart(data && data.points);
            if (points.length >= 2) {
                seriesCache.set(key, { status: "ok", points: points });
            } else {
                seriesCache.set(key, { status: "ok", points: points, reason: seriesReason(data) });
            }
        })
        .catch((e) => {
            /* 失败不写入 seriesCache（原写入 status:"err" 无失效机制，错误被永久缓存，
               保存新快照后命中缓存仍显示失败）——仅记账到局部变量供本次渲染 */
            fetchError = (e && e.message) || "趋势读取失败";
        })
        .then(() => {
            seriesInflight.delete(key);
            if (!isPageMounted()) return; // 页面已卸载：结果保留在缓存，回挂时回灌
            if (fetchError) {
                setTrendState("empty", "趋势读取失败");
                const h0 = $("compare-trend-host");
                if (h0) renderLine(h0, { points: [], reason: "趋势读取失败：" + fetchError });
                return;
            }
            const hit = seriesCache.get(key);
            const h = $("compare-trend-host");
            if (!h || !hit) return;
            if (hit.status === "err") {
                setTrendState("empty", "趋势读取失败");
                renderLine(h, { points: [], reason: "趋势读取失败：" + hit.error });
                return;
            }
            if ((hit.points || []).length < 2) {
                setTrendState("empty", "所选快照不足 2 个可用数据点");
                renderLine(h, { points: [], reason: hit.reason || "所选快照不足 2 个可用数据点，无法成线" });
                return;
            }
            setTrendState("ok", trendSubText(hit.points.length));
            renderLine(h, {
                points: hit.points,
                onPick: pickBaselineFromTrend,
                active: snapshotIndexOf(hit.points, APP_STATE.compare.baseline),
            });
            h.dataset.seriesKey = key;
        });
    return 0;
}



/* ================= 页面三态（空态/骨架/结果） ================= */

function isPageMounted() {
    return !!$("compare-result");
}

function showEmpty() {
    const empty = $("compare-empty");
    const loading = $("compare-loading");
    const result = $("compare-result");
    if (empty) empty.toggleAttribute("hidden", false);
    if (loading) loading.toggleAttribute("hidden", true);
    if (result) result.toggleAttribute("hidden", true);
}

function showLoading() {
    const empty = $("compare-empty");
    const loading = $("compare-loading");
    const result = $("compare-result");
    if (empty) empty.toggleAttribute("hidden", true);
    if (loading) loading.toggleAttribute("hidden", false);
    if (result) result.toggleAttribute("hidden", true);
    // 阶段B（B-2）：loading 骨架屏附加取消按钮与已用时
    const cancelBtn = $("btn-compare-cancel");
    if (cancelBtn) cancelBtn.classList.remove("hidden");
    const elapsed = $("compare-loading-elapsed");
    if (elapsed) {
        elapsed.hidden = false;
        elapsed.textContent = "已用时 0 秒";
    }
}

function hideLoading() {
    const loading = $("compare-loading");
    if (loading) loading.toggleAttribute("hidden", true);
    const cancelBtn = $("btn-compare-cancel");
    if (cancelBtn) cancelBtn.classList.add("hidden");
    const elapsed = $("compare-loading-elapsed");
    if (elapsed) elapsed.hidden = true;
}

function showResult() {
    const empty = $("compare-empty");
    const loading = $("compare-loading");
    const result = $("compare-result");
    if (empty) empty.toggleAttribute("hidden", true);
    if (loading) loading.toggleAttribute("hidden", true);
    if (result) result.toggleAttribute("hidden", false);
}

/* ================= 对比执行（W2.4/W2.13 语义保留；B-1/B-2 异步化+超时收敛） ================= */

let scanPending = false; // W2.4：409 时保持按钮禁用直到扫描完成（pds:scan 完成分支恢复）
let scanRetries = 0;     // U3.4：409 锁竞争自动重试上限（启动期 浏览/索引 占用为瞬态）

/* ---- 阶段B（B-1/B-2）：对比请求生命周期 ---- */
let compareAbort = null;      // AbortController（30s 超时 + 用户取消共用）
let compareNow = 0;           // 计时器句柄（已用时刷新）
let compareJobTimer = null;   // /api/compare/status 轮询句柄
let compareJobId = null;      // 202 异步任务 job_id
let compareCancelled = false; // B-2：用户/超时取消标志（catch 识别终态）
const COMPARE_TIMEOUT_MS = 30000; // B-2：30s 用户可感知阈值
const COMPARE_STATUS_POLL_MS = 1500; // 202 任务轮询间隔
let cancelEscBound = false; // B-2：Esc 取消的 document 级监听只绑一次（U1.3 纪律）
let trendResizeBound = false; // P6：趋势折线 resize 重画监听只绑一次（同上纪律）

function stopCompareTimers() {
    if (compareNow) { clearInterval(compareNow); compareNow = 0; }
    if (compareJobTimer) { clearInterval(compareJobTimer); compareJobTimer = 0; }
}

function startElapsedTick() {
    const t0 = Date.now();
    const el = $("compare-loading-elapsed");
    if (el) el.textContent = "已用时 0 秒";
    if (compareNow) clearInterval(compareNow);
    compareNow = setInterval(() => {
        const s = Math.floor((Date.now() - t0) / 1000);
        const e = $("compare-loading-elapsed");
        if (e) e.textContent = "已用时 " + s + " 秒";
    }, 1000);
}

function setCompareBusyText(text) {
    setStatus("compare-status", "busy", text);
}

/* 取消当前对比（Esc/取消按钮/超时共用）：中止 fetch + 停止轮询 + 按钮恢复 */
function cancelCompare(restoreBtn) {
    stopCompareTimers();
    if (compareAbort) {
        try { compareAbort.abort(); } catch (e) { /* ignore */ }
        compareAbort = null;
    }
    compareCancelled = true;
    compareJobId = null;
    const btn = $("btn-compare");
    if (btn && restoreBtn !== false) btn.disabled = false;
}

/* pds:scan 订阅（模块级一次——同 snapshots.js ensureScanListener 模式：
   DOM 空守卫 + 扫描中禁用/完成恢复（W2.4 语义镜像）；锁释放后自动重试一次）
   ⚠️ 重试上限 3：避免持续 409（如 SDK 锁长期被占）造成轮询风暴——超限后转手动 */
let scanSubscribed = false;
function ensureScanListener() {
    if (scanSubscribed) return;
    scanSubscribed = true;
    window.addEventListener("pds:scan", (ev) => {
        const st = ev.detail || {};
        const btn = $("btn-compare");
        if (!btn) return;
        if (st.running) {
            btn.disabled = true; // W2.4：全量扫描中对比不可用
        } else if (scanPending) {
            scanPending = false; // 409 后扫描完成 → 恢复（用户可再次点击）
            btn.disabled = false;
            if (scanRetries < 3) {
                scanRetries += 1;
                compareSnapshots({ autoretry: true }); // 锁释放瞬态 → 自动重试
            }
        }
    });
}

/* 202 → 轮询 /api/compare/status 直到 done/error；返回 report 或抛错 */
function pollCompareJob(jobId, jobRoot, jobBaseline) {
    return new Promise((resolve, reject) => {
        let polls = 0;
        const maxPolls = Math.ceil(COMPARE_TIMEOUT_MS / COMPARE_STATUS_POLL_MS);
        const tick = async () => {
            /* 取消后不再排队/处理（取消只清了已排队句柄；在途请求返回后须在这里自吞，
               避免僵尸轮询复活覆盖新一轮对比的状态）；以带标记的 reject 收尾，
               让挂起的 await 立即收敛（不悬挂到 45s 兜底） */
            if (compareCancelled || compareJobId !== jobId) {
                const err = new Error("对比已取消");
                err.cancelled = true;
                reject(err);
                return;
            }
            polls += 1;
            if (polls > maxPolls) {
                reject(new Error("对比超时，可稍后重试"));
                return;
            }
            let data;
            try {
                data = await api("/api/compare/status?job_id=" + encodeURIComponent(jobId));
            } catch (e) {
                if (compareCancelled || compareJobId !== jobId) { // 在途期间被取消
                    const err = new Error("对比已取消");
                    err.cancelled = true;
                    reject(err);
                    return;
                }
                reject(e);
                return;
            }
            if (compareCancelled || compareJobId !== jobId) { // 在途期间被取消：不 resolve、不再排队
                const err = new Error("对比已取消");
                err.cancelled = true;
                reject(err);
                return;
            }
            if (data.status === "done") {
                resolve(data.report);
                return;
            }
            if (data.status === "error") {
                const err = new Error(data.error || "对比失败");
                if (data.code) err.code = data.code;
                reject(err);
                return;
            }
            compareJobTimer = setTimeout(tick, COMPARE_STATUS_POLL_MS);
        };
        compareJobTimer = setTimeout(tick, COMPARE_STATUS_POLL_MS);
        /* 超时兜底（AbortController 45s 硬上限，防轮询僵尸）
           ⚠️ 仅当本 job 仍是当前任务时才清计时器并 reject——取消后 compareJobId=null、
           新对比启动后 compareJobId=新 id，本兜底不得误伤新一轮轮询 */
        setTimeout(() => {
            if (compareCancelled || (compareJobId && compareJobId !== jobId)) return;
            if (compareJobTimer) { clearTimeout(compareJobTimer); compareJobTimer = 0; }
            reject(new Error("对比超时，可稍后重试"));
        }, COMPARE_TIMEOUT_MS + 15000);
    });
}

/* 执行对比（opts={baseline,root,autoretry}；页内按钮直读表单，跨页调用默认取 state 缓存） */
export async function compareSnapshots(opts, allowOtherMachine) {
    cancelCompare(false); // 上一次对比仍在途则先取消（幂等）
    if (!(opts && opts.autoretry)) scanRetries = 0; // 用户/挂载发起 → 重试计数复位
    const btn = $("btn-compare");
    const st = APP_STATE.compare;
    const drill = drillRootOf();
    let root = (opts && opts.root) || drill || String(st.root || getCurrentRoot() || "");
    let baseline = (opts && opts.baseline)
        ? String(opts.baseline).trim()
        : (primaryBaseline() || String(st.baseline || "").trim());
    if (!baseline) baseline = defaultBaseline(root);
    if (!baseline) {
        setStatus("compare-status", "warn", "没有可用的历史快照，请先完成全量扫描并保存");
        showEmpty();
        return;
    }
    /* P4：下钻时对比根 = 下钻目录（不再回落基线所属盘）；未下钻时保持既有归属推导 */
    if (!drill) {
        const owner = ownerRootFor(baseline, root);
        if (owner) root = owner;
    }
    const target = latestForRoot(root) || String(st.target || "");
    st.baseline = baseline;
    st.root = root;
    st.target = target;
    syncForm({ root: root, baseline: baseline, target: target });
    renderCrumb();

    if (btn) btn.disabled = true;
    setStatus("compare-status", "busy", "正在对比，请稍候…");
    showLoading();
    startElapsedTick();
    scanPending = false;
    compareCancelled = false; // 新请求复位（取消标志只属于上一次对比）
    const controller = new AbortController(); // 本次对比的局部引用（超时闭包只 abort 它，不读模块级变量）
    compareAbort = controller;
    /* B-2：30s 超时（AbortController）——超时 →「对比超时，可稍后重试/Esc 取消」+ 按钮恢复
       ⚠️ 闭包捕获 controller（非模块级 compareAbort）：上一次对比成功后残留的定时器
       不得 abort 掉下一次新对比的 AbortController */
    const timeoutHandle = setTimeout(() => {
        try { controller.abort(); } catch (e) { /* ignore */ }
    }, COMPARE_TIMEOUT_MS);
    try {
        /* P4：drop_zero / order_by 由本页固定下发（问题 6 的后端切片前过滤与
           |delta| 排序），depth 仅在选了具体层数时下发（缺省 = 修复前逐字节口径） */
        const depthText = depthValue();
        const payload = {
            root: root,
            baseline: baseline,
            allow_other_machine: !!allowOtherMachine, // P12·W2.13 二次提交放行
            drop_zero: hideZeroOn(),
            order_by: "abs",
        };
        if (depthText) payload.depth = Number(depthText);
        const data = await postJson("/api/compare", payload, { signal: controller.signal });
        /* B-1：202 + {job_id, status:"scanning"} → 轮询 /api/compare/status */
        if (data && data.job_id && (data.status === "scanning" || data.status === "queued")) {
            compareJobId = data.job_id;
            setCompareBusyText("后台对比扫描进行中（可稍候自动完成，Esc 取消）…");
            const report = await pollCompareJob(data.job_id, root, baseline);
            if (compareCancelled || controller.signal.aborted) return; // 已被取消/超时
            clearTimeout(timeoutHandle); // 成功路径：清除 30s 超时定时器（否则误 abort 后续新对比）
            scanRetries = 0;
            renderReport(report, root, baseline);
            if (btn) btn.disabled = false;
            stopCompareTimers();
            hideLoading();
            return;
        }
        /* 同步 report（缓存命中或后端未启用异步）：既有路径 */
        clearTimeout(timeoutHandle); // 成功路径：清除 30s 超时定时器（否则误 abort 后续新对比）
        scanRetries = 0; // 成功 = 锁竞争已解除（重试计数复位）
        renderReport(data.report, root, baseline);
        if (btn) btn.disabled = false;
        stopCompareTimers();
        hideLoading();
    } catch (e) {
        clearTimeout(timeoutHandle);
        if (e && e.cancelled) return; // 已取消轮询的迟到回收：不触碰共享计时器/UI（新一轮可能已接管）
        if (controller.signal.aborted && compareAbort !== controller && !compareCancelled) {
            return; // 本 controller 已被 cancelCompare 废止且新一轮已接管：静默退出
        }
        stopCompareTimers();
        hideLoading(); // 保证 loading 收敛（B-2：骨架屏不永久存在）
        if (compareCancelled) {
            // 用户主动取消（取消按钮/Esc）
            setStatus("compare-status", "warn", "对比已取消");
            if (btn) btn.disabled = false;
            return;
        }
        if (controller.signal.aborted) {
            // 30s 超时：AbortError（本对比自身的 controller，不读模块级变量）
            setStatus("compare-status", "warn", "对比超时，可稍后重试（Esc 取消）");
            if (btn) btn.disabled = false;
            return;
        }
        // P12·W2.13：异机基线 → 红字确认后二次提交携带 allow 字段
        if (e && e.code === "machine_mismatch") {
            const ok = await confirmDialog({
                title: "跨机器基线确认",
                text: "该基线来自其他机器，对比数字可能误导，仍要继续吗？",
                okLabel: "仍要对比",
                okClass: "btn-danger",
            });
            if (ok) return compareSnapshots({ baseline: baseline, root: root }, true);
            setStatus("compare-status", "warn", "已取消跨机器对比");
            if (btn) btn.disabled = false;
            return;
        }
        // P12·W2.4：扫描中/锁占用 409 → 中性提示＋按钮禁用，pds:scan 完成分支自动重试
        if ((e.message || "").indexOf("全量扫描进行中") !== -1) {
            toast("扫描完成后可对比", "warn");
            if (btn) btn.disabled = true;
            scanPending = true;
            pollFullscan();
            showEmpty();
            setStatus("compare-status", "warn", "对比暂不可用：扫描或索引占用中，完成后将自动重试（或稍后手动点击）");
        } else {
            /* B-2：500/超时/网络错误终态文案区分 */
            const msg = (e.message || "") + "";
            if (msg.indexOf("对比超时") !== -1) {
                setStatus("compare-status", "err", "对比超时，可稍后重试（Esc 取消）");
            } else if (msg.indexOf("500") !== -1 || /基线快照加载失败/.test(msg)) {
                setStatus("compare-status", "err", "对比失败（服务器错误）：" + msg);
            } else {
                setStatus("compare-status", "err", msg);
            }
            showEmpty(); // 结果区隐藏（保持旧卡行为：错误态不残留旧结果）
            if (btn) btn.disabled = false;
        }
    }
}

/* ================= 结果渲染（摘要 3 卡 / 发散图 L3-6 / 表格 F19） ================= */

function renderSummary(r) {
    const box = $("compare-summary");
    if (!box) return; // 页面未挂载（跨页触发只记账不回 UI）
    const delta = Number(r.delta_total) || 0;
    const rows = r.rows || [];
    /* D4-5：优先取后端 additive 字段（全量聚合行口径，未按 100 条切片）；
       旧后端 / 桩态无该字段时回退为按 rows 现算（u34 桩态断言不变） */
    const hasAdditive = r.max_growth !== undefined && r.max_growth !== null &&
        r.max_release !== undefined && r.max_release !== null;
    let maxGrowth = Number(r.max_growth) || 0;
    let release = Number(r.max_release) || 0;
    if (!hasAdditive) {
        maxGrowth = 0;
        release = 0;
        rows.forEach((row) => {
            const d = Number(row.delta) || 0;
            if (d > 0) maxGrowth = Math.max(maxGrowth, d);
            if (d < 0) release += -d;
        });
    }
    const scope = hasAdditive ? (Number(r.rows_total) || rows.length) : rows.length;
    const hiddenZeros = Number(r.zero_total) || 0;
    const hiddenText = (hasAdditive && hiddenZeros > 0 && hideZeroOn())
        ? "已隐藏 " + esc(hiddenZeros) + " 条零变化" : "相较基线";
    // P12·W1.2：基线含「已知异常大小」行时前置 warn 提示（additive 字段 legacy_count）
    const legacyNotice = Number(r.legacy_count) > 0
        ? '<div class="notice notice-warn compare-legacy" role="status">基线含 ' +
          esc(Number(r.legacy_count)) +
          ' 条已知异常大小数据，对比数字可能失真，建议重扫重建基线。</div>'
        : "";
    box.innerHTML =
        legacyNotice +
        '<div class="compare-stat" title="全部条目增删净额（后端 delta_total 口径）">' +
        '<span class="compare-stat-label">总变化</span>' +
        '<strong class="compare-stat-value ' + deltaClass(delta) + '">' +
        '<span class="compare-stat-arrow">' + arrowOf(delta) + "</span>" +
        '<span class="compare-stat-num" data-v="0" data-target="' + delta + '" data-fmt="signed">' +
        esc(signedBytes(delta)) + "</span></strong>" +
        '<span class="compare-stat-sub">' + esc(humanBytes(r.total_baseline)) + " → " + esc(humanBytes(r.total_current)) + "</span></div>" +
        '<div class="compare-stat" title="全量 ' + scope + ' 条聚合条目中增长最多者">' +
        '<span class="compare-stat-label">最大增长</span>' +
        '<strong class="compare-stat-value ' + (maxGrowth > 0 ? "grow" : "flat") + '">' +
        '<span class="compare-stat-arrow">' + (maxGrowth > 0 ? "▲" : "±") + "</span>" +
        '<span class="compare-stat-num" data-v="0" data-target="' + maxGrowth + '" data-fmt="signed">' +
        esc(signedBytes(maxGrowth)) + "</span></strong>" +
        '<span class="compare-stat-sub">全量 ' + esc(scope) + " 条 · " + hiddenText + "</span></div>" +
        '<div class="compare-stat" title="全量 ' + scope + ' 条聚合条目中缩减合计（可回收空间）">' +
        '<span class="compare-stat-label">可释放</span>' +
        '<strong class="compare-stat-value ' + (release > 0 ? "shrink" : "flat") + '">' +
        '<span class="compare-stat-arrow">' + (release > 0 ? "▼" : "±") + "</span>" +
        '<span class="compare-stat-num" data-v="0" data-target="' + release + '" data-fmt="plain">' +
        esc(humanBytes(release)) + "</span></strong>" +
        '<span class="compare-stat-sub">缩减合计</span></div>';
    // L1-4 count-up（600ms --dur-4；reduced 直显终值；dataset.v 记账）
    box.querySelectorAll(".compare-stat-num").forEach((el) => {
        const v = Number(el.getAttribute("data-target")) || 0;
        const fmt = el.getAttribute("data-fmt") === "signed" ? signedBytes : humanBytes;
        countUp(el, v, { fmt: fmt });
    });
}

/* 原红绿发散图区及其渲染/动画函数已按用户实测反馈整体移除：
   内容稀疏、与摘要卡+明细表信息重复；页内下钻由明细表整行点击承担。 */

function renderTable(r) {
    const body = $("compare-body");
    if (!body) return;
    const rows = r.rows || [];
    if (!rows.length) {
        body.innerHTML =
            '<tr><td colspan="4">' + emptyStateHtml(r) + "</td></tr>";
    } else {
        body.innerHTML = rows
            .map((row) => {
                const d = Number(row.delta) || 0;
                const growth = row.growth_pct == null
                    ? "-"
                    : (Number(row.growth_pct) >= 0 ? "+" : "") + Number(row.growth_pct).toFixed(2) + "%";
                const tags = [];
                if (row.added) tags.push('<span class="tag tag-added">新增</span>');
                if (row.removed) tags.push('<span class="tag tag-removed">已删除</span>');
                return (
                    // P4（D4-6）：整行可点 = 页内下钻（以该目录为新根重新对比）
                    '<tr class="compare-row" data-drill-path="' + esc(row.path) +
                    '" title="点击下钻到该目录（以它为对比根）">' +
                    '<td class="delta-cell ' + deltaClass(d) + '">' + arrowOf(d) + " " + esc(signedBytes(d)) + "</td>" +
                    "<td>" + esc(growth) + "</td>" +
                    '<td><span class="cell-name"><span class="name" title="' + esc(row.path) + '">' + esc(row.path) + "</span>" +
                    tags.join("") + "</span></td>" +
                    // F19：对比表格行操作 = 定位（open-path）+ 复制路径（act-copy-cmp 行为保留）
                    '<td class="cmp-ops"><button class="icon-btn act-open-cmp" data-act-path="' + esc(row.path) +
                    '" title="在资源管理器中定位" aria-label="在资源管理器中定位">' + ICONS.folder + "</button>" +
                    '<button class="icon-btn act-copy-cmp" data-act-path="' + esc(row.path) +
                    '" title="复制路径" aria-label="复制路径">' + ICONS.copy + "</button></td>" +
                    "</tr>"
                );
            })
            .join("");
    }
    // L1-2：可视区前 12 行 stagger（fadeSlide8，间隔 --dur-stagger-row；reduced 直显）
    const rowEls = Array.from(body.querySelectorAll("tr")).slice(0, 12);
    if (rowEls.length && !reducedMotion()) {
        staggerIn(rowEls, { y: 8, delay: motionDur("--dur-stagger-row") });
    }
}

function renderReport(r, root, baseline, opts) {
    const fromCache = !!(opts && opts.fromCache);
    const depthText = depthValue();
    const hideZero = hideZeroOn();
    const drill = drillRootOf();
    /* P4：缓存键含口径（depth / 隐藏零变化），否则切深度会回灌上一次的报告 */
    APP_STATE.compare.result = {
        root: root, baseline: baseline, report: r, at: Date.now(),
        depth: r && r.depth !== undefined ? r.depth : (depthText ? Number(depthText) : null),
        hideZero: hideZero,
    };
    APP_STATE.compare.depth = depthText;
    APP_STATE.compare.hideZero = hideZero;
    // U2.4：最近对比迷你卡数据源（主页右栏；本页填写，主页渲染）
    APP_STATE.compare.lastSummary = {
        baseline: baseline,
        root: root,
        totalBaseline: Number(r.total_baseline) || 0,
        totalCurrent: Number(r.total_current) || 0,
        delta: Number(r.delta_total) || 0,
        at: Date.now(),
        atText: new Date().toLocaleString(),
    };
    renderCompareMini();
    // U3.1：N13 圆点提醒——仅真实对比完成挂点；缓存回灌（路由往返/趋势卡共享）
    // 不挂点（提醒语义=在别处发生的新事件；回灌会误挂并跨路由残留）
    if (!fromCache) markNavDot("/compare");
    if (!isPageMounted()) return; // 跨页触发：只记账+圆点，UI 由页面挂载时回灌
    showResult();
    renderSummary(r);
    renderTable(r);
    // P12·W3.3：truncated 如实化——真实语义是 compare 行数超 50 万上限截断；
    // 「100 条」只是 top_growth 的固定切片（表格行 = 该切片全量）
    const delta = Number(r.delta_total) || 0;
    const extra = r.truncated
        ? "（注意：数据集超过快照 50 万行上限已截断，结果可能不完整；下表展示变化最大的 " + (r.rows || []).length + " 条）"
        : "（展示变化最大的 " + (r.rows || []).length + " 条差异）";
    // P4：深度 / 下钻 / 零变化过滤如实透出（口径可见，不伪装）
    const depthInfo = (r.depth !== undefined && r.depth !== null)
        ? "；" + Number(r.depth) + " 层聚合（全量 " + (Number(r.rows_total) || (r.rows || []).length) + " 条聚合行）"
        : "";
    const drillInfo = drill ? "；已下钻 " + String(drill).replace(/\\+$/, "") : "";
    const hiddenInfo = (hideZero && Number(r.zero_total) > 0)
        ? "；已隐藏 " + Number(r.zero_total) + " 条零变化" : "";
    // P12·W2.11（B-3）：状态行透出当前数据时间，过期缓存不再伪装实时
    const dataTime = r.current_completed_at
        ? "；当前数据时间 " + String(r.current_completed_at).replace("T", " ")
        : "";
    setStatus(
        "compare-status",
        "ok",
        "对比完成：" + humanBytes(r.total_baseline) + " → " + humanBytes(r.total_current) +
        "，变化 " + signedBytes(delta) + extra + depthInfo + drillInfo + hiddenInfo + dataTime
    );
}

/* ================= 页面接线（每次挂载新 DOM 重绑） ================= */

function bindComparePage() {
    // 对比（按钮 + 对比基准下拉变更即重算）
    $("btn-compare").addEventListener("click", () => compareSnapshots());
    // P5（D5-2）→ P6（D6-5）：对比基准列表可多选——change 即换对比基准并重算；
    // 选中 ≥2 份时同时刷新多快照趋势折线（/api/series）。
    // 主对比基准 = 选中集里**最新**的一份（选项按时间倒序，selectedOptions[0] 即最新）；
    // 空选择（取消最后一份）→ 回落默认最近一份，避免空基准。
    // 2026-09-13 第四轮：用户在这里勾选 = 改「折线看哪几次」；点折线上的点 = 改「与哪份比」。
    // 两者共用同一份 picks（state.baselines 记账），点选不改 picks（折线不塌缩成单选）。
    const baselineSel = $("compare-baseline");
    if (baselineSel) {
        baselineSel.addEventListener("change", () => {
            /* 同盘兜底（2026-09-13 第三轮）：把不属于当前盘范围的选中项取消，
               保证多选 = 同一盘的多个时间点 */
            const dropped = enforceSameDrive();
            if (dropped.length) {
                toast("已忽略 " + dropped.map((r) => r.replace(/\\+$/, "")).join("、") +
                    " 的同批快照：多选只支持同一盘的不同时间点", "warn");
                renderBaselinePanel();
            }
            const picked = selectedBaselines();
            if (!picked.length) {
                const fallback = defaultBaseline(String(APP_STATE.compare.root || getCurrentRoot() || ""));
                if (fallback) baselineSel.value = fallback;
            }
            APP_STATE.compare.baseline = String(baselineSel.value || APP_STATE.compare.baseline || "").trim();
            /* 主基准始终落在**选中集里的一份**：用户取消勾选掉当前主基准时，
               回落到选中集里最新的那一份（= 修复前的既有口径，不会指向未选中的快照）。
               折线点选设的主基准若仍在选中集里，这里原样保留（点选结果不被勾选动作打回）。
               选中集为空（取消最后一份）→ 回落对该盘重取默认最近一份。 */
            const afterPicks = selectedBaselines();
            if (afterPicks.length) {
                setPrimaryBaseline(baselineSel,
                    afterPicks.indexOf(APP_STATE.compare.baseline) === -1
                        ? afterPicks[0]
                        : APP_STATE.compare.baseline);
            } else {
                setPrimaryBaseline(baselineSel,
                    defaultBaseline(String(APP_STATE.compare.root || getCurrentRoot() || "")));
            }
            rememberPicks(afterPicks); // P6 additive：多选清单（跨路由重挂不丢）
            /* P4：换对比基准 = 换对比对象 → 下钻根失效（避免把 A 盘的子目录当成 B 盘的新根） */
            if (APP_STATE.compare.drillRoot) {
                APP_STATE.compare.drillRoot = "";
                renderCrumb();
            }
            const root = ownerRootFor(APP_STATE.compare.baseline, APP_STATE.compare.root || getCurrentRoot()) || "";
            if (root) {
                APP_STATE.compare.root = root;
                const latest = latestForRoot(root);
                if (latest) APP_STATE.compare.target = latest; // 展示标识（见 syncForm 注记）
            }
            syncForm();
            syncBaselineHint(); // R1：选择变化即刷新「已选 N 份」（原只在挂载/复位时刷新，提示滞留）
            syncBaselineTrigger(); // 2026-09-13 第四轮：触发钮文案含主对比基准
            APP_STATE.compare.result = null; // 换基准 → 弃用旧报告缓存
            renderTrend();                   // 多选变化 → 趋势折线（≥2 份时请求 /api/series）
            compareSnapshots();
        });
    }
    bindBaselinePicker(); // R1：自定义下拉可视层（触发钮/复选面板/组外收起）
    bindSnapshotsRefresh(); // R1：会话晚到竞态——pds:snapshots 到达后重建基准选项
    /* 2026-09-13 第三轮：切换对比盘 → 重新只列该盘基准（选最新一份）+ 弃用旧结果 + 重跑 */
    const scopeSel = $("compare-scope");
    if (scopeSel) {
        scopeSel.addEventListener("change", () => {
            const root = String(scopeSel.value || "");
            APP_STATE.compare.scope = root;
            APP_STATE.compare.root = root;
            APP_STATE.compare.drillRoot = ""; // 换盘 → 下钻根失效
            const latest = latestForRoot(root);
            APP_STATE.compare.baseline = latest || "";
            setPrimaryBaseline(null, latest || ""); // 换盘 = 换主基准（表单层同收口）
            rememberPicks(latest ? [latest] : []); // 换盘 = 换选择集（旧盘的 picks 无意义）
            APP_STATE.compare.result = null;
            renderCrumb();
            rebuildBaselineOptions(sessionsOf());
            syncForm({ root: root, baseline: latest });
            syncBaselineHint();
            syncBaselineTrigger();
            renderTrend();
            if (latest) compareSnapshots();
            else showEmpty();
        });
    }
    // P4（D4-2/D4-6）：深度切换 → 记状态并重发（口径变了不能吃缓存）；下钻中换深度
    // 以「当前下钻根」为新根重新聚合，不回到整盘。
    const depthSel = $("compare-depth");
    if (depthSel) {
        depthSel.addEventListener("change", () => {
            APP_STATE.compare.depth = depthValue();
            setPref("compare.depth", APP_STATE.compare.depth); // 2026-09-13：记住默认深度
            APP_STATE.compare.result = null; // 口径变更 → 弃用旧报告缓存
            compareSnapshots();
        });
    }
    // P4（D4-3/D4-4）：隐藏零变化开关（后端切片前过滤；关 = 请求 drop_zero=false）
    const zeroBox = $("compare-hide-zero");
    if (zeroBox) {
        zeroBox.addEventListener("change", () => {
            APP_STATE.compare.hideZero = !!zeroBox.checked;
            setPref("compare.hideZero", APP_STATE.compare.hideZero); // 2026-09-13：记住默认口径
            APP_STATE.compare.result = null;
            compareSnapshots();
        });
    }
    // P4（D4-6）：面包屑逐级返回（首项 path="" = 回到未下钻的整盘口径）
    const crumb = $("compare-crumb");
    if (crumb) {
        crumb.addEventListener("click", (ev) => {
            const btn = ev.target.closest(".crumb-item[data-crumb-path]");
            if (!btn) return;
            const path = btn.getAttribute("data-crumb-path") || "";
            APP_STATE.compare.drillRoot = path;
            APP_STATE.compare.result = null;
            renderCrumb();
            compareSnapshots();
        });
    }
    // 阶段B（B-2）：loading 骨架屏取消按钮——中止在途对比并恢复按钮
    const cancelBtn = $("btn-compare-cancel");
    if (cancelBtn) cancelBtn.addEventListener("click", () => {
        cancelCompare();
        setStatus("compare-status", "warn", "对比已取消");
        showEmpty();
        hideLoading();
    });
    // 阶段B（B-2）：Esc 取消在途对比（弹窗栈优先——红线 #9；document 级只绑一次）
    if (!cancelEscBound) {
        cancelEscBound = true;
        document.addEventListener("keydown", (ev) => {
            if (ev.key !== "Escape") return;
            if (document.querySelector(".modal:not(.hidden)")) return;
            if (compareAbort || compareJobId) {
                cancelCompare();
                setStatus("compare-status", "warn", "对比已取消（Esc）");
                showEmpty();
                hideLoading();
            }
        });
    }
    // P12·W1.4：对比明细行尾操作（定位 F19 / 复制路径）——行为保留，委托渲染内容更新
    // P4（D4-6）：整行点击 = 页内下钻（行尾操作按钮优先，命中则不下钻）
    $("compare-body").addEventListener("click", (ev) => {
        const openBtn = ev.target.closest(".act-open-cmp");
        if (openBtn) { openInExplorer(openBtn.getAttribute("data-act-path")); return; }
        const copyBtn = ev.target.closest(".act-copy-cmp");
        if (copyBtn) { copyPath(copyBtn.getAttribute("data-act-path")); return; }
        const tr = ev.target.closest("tr[data-drill-path]");
        if (tr) drillInto(tr.getAttribute("data-drill-path"));
    });
    // （原发散图行点击下钻已随发散图区一并移除；下钻入口 = 明细表整行点击）
    // P6（D6-4）：趋势折线随窗口尺寸变化重画（viewBox 依赖实测像素；避免拉伸失真）
    if (!trendResizeBound) {
        trendResizeBound = true;
        let timer = 0;
        window.addEventListener("resize", () => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => { if (isPageMounted()) renderTrend(); }, 180);
        });
    }
    ensureScanListener();
}

/* ============================================================
   U2.1/U3.4：页面契约（render/mount/unmount；§3.3 布局，§6.5 空态）
   ============================================================ */

const COMPARE_PAGE_HTML =
    '<section class="page page-compare" data-page="compare">' +
    '<header class="page-head page-head-row page-head-compare">' +
    '<div class="page-head-titles">' +
    '<h1 class="page-title" data-page-title>空间对比</h1>' +
    '<p class="page-sub" id="compare-root-line">对比一次磁盘状态变化：对比基准（历史快照）→ 当前磁盘状态（实时）</p>' +
    "</div>" +
    '<div class="compare-controls" role="group" aria-label="对比参数">' +
    // R1：原生 <select multiple> 收为隐藏数据模型（smoke/预填/趋势等既有逻辑零改动），
    // 可视层换为自定义下拉（触发钮 + 复选面板；点击即切换，无需 Ctrl/⌘）
    '<div class="compare-ctl compare-ctl-baseline">' +
    '<span class="compare-ctl-line">' +
    '<span class="compare-ctl-caption">对比基准（历史快照）</span>' +
    '<span class="compare-baseline-hint" id="compare-baseline-hint" role="status">已选 1 份</span>' +
    "</span>" +
    '<span class="baseline-picker" id="baseline-picker">' +
    '<button id="baseline-trigger" class="baseline-trigger" type="button" aria-haspopup="listbox" aria-expanded="false">' +
    '<span id="baseline-trigger-text">选择对比基准…</span>' +
    '<svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>' +
    "</button>" +
    '<span id="baseline-panel" class="baseline-panel" role="listbox" aria-multiselectable="true" aria-label="可选快照（点击切换选中）" hidden></span>' +
    "</span>" +
    '<select id="compare-baseline" class="compare-baseline-list sr-only" multiple size="3" ' +
    'aria-label="对比基准（历史快照，可多选）" title="对比基准 = 一份历史快照；可多选（选中 ≥2 份显示多快照趋势折线）">' +
    "</select>" +
    "</div>" +
    // P5（D5-1）：删除只读「目标」输入框；改为一行只读文本「当前：…」（非表单控件）
    '<span id="compare-current" class="compare-current" role="status" ' +
    'title="当前磁盘状态 = 本机此刻的实际占用（由全量扫描结果或实时索引得出，不是快照文件）">' +
    "当前：尚未选择盘符</span>" +
    // 2026-09-13 第三轮：对比盘范围——基准列表只列该盘的历史快照，
    // 多选因此天然同盘（原实现可把 C 盘某次与 D 盘另一次混在一起选中）
    '<label class="compare-ctl compare-ctl-scope" for="compare-scope" ' +
    'title="对比盘范围：每次保存会把各盘快照一起写入，但对比与趋势以**盘**为单位；选一个盘后基准列表只列该盘的各次保存，多次保存之间才成折线">' +
    "对比盘" +
    '<select id="compare-scope" aria-label="对比盘范围（基准只列该盘，多选=同一盘的多次保存）"></select>' +
    "</label>" +
    // P4（D4-2）：深度选择器——缺省「叶子（默认）」= 修复前口径（不发 depth）
    '<label class="compare-ctl compare-ctl-depth" for="compare-depth" title="深度：按相对对比根的第 N 层聚合目录增量（后端在排序/截断之前聚合，不由前端近似）">' +
    "深度" +
    '<select id="compare-depth" aria-label="对比深度（叶子 / 第 N 层聚合）" title="深度聚合：叶子（默认，修复前口径）/ 第 1..5 层">' +
    '<option value="">叶子（默认）</option>' +
    '<option value="1">1 层</option>' +
    '<option value="2">2 层</option>' +
    '<option value="3">3 层</option>' +
    '<option value="4">4 层</option>' +
    '<option value="5">5 层</option>' +
    "</select></label>" +
    // P4（D4-3/D4-4）：隐藏零变化（默认开）——后端切片前过滤 delta==0
    '<label class="compare-ctl compare-ctl-zero" for="compare-hide-zero" title="隐藏零变化：后端在排序与 Top-100 截断之前过滤 delta=0 的条目（避免零行补位、避免负增量被挤出榜单）">' +
    '<input id="compare-hide-zero" type="checkbox" checked aria-label="隐藏零变化条目">' +
    "隐藏零变化</label>" +
    '<button id="btn-compare" class="btn btn-primary">' +
    '<svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v18"/><path d="M16 3v18"/><path d="M3 8h5"/><path d="M16 16h5"/></svg>' +
    "开始对比</button>" +
    "</div></header>" +
    '<div class="page-body page-compare-body">' +
    '<div id="compare-status" class="status-line" role="status"><span class="dot"></span>' +
    '<span id="compare-status-text">选择一份对比基准（历史快照），开始对比它的采集时刻与本机当前磁盘状态的差异。</span></div>' +
    // P4（D4-6）：下钻面包屑（未下钻时 hidden，不占高度）
    '<nav id="compare-crumb" class="compare-crumb" aria-label="下钻路径（点击返回上级）" hidden></nav>' +
    // P6（D6-4/D6-5）：多快照趋势卡（选中 ≥2 份对比基准时成线；否则单行原因条）
    '<div id="compare-trend" class="compare-trend-card card" data-state="idle" role="group" aria-label="多快照趋势">' +
    '<div class="compare-trend-head">' +
    '<h2 class="compare-trend-title">多快照趋势</h2>' +
    '<span class="compare-trend-sub" id="compare-trend-sub">选中 ≥2 份对比基准后显示折线</span>' +
    "</div>" +
    '<div id="compare-trend-host" class="line-host" role="img" aria-label="多快照趋势折线" ' +
    'title="点击任一数据点 = 以那份快照为对比基准重算下方对比（折线保留全部已选）"></div>' +
    "</div>" +
    '<div id="compare-empty" class="page-compare-empty">' +
    '<div class="empty-state">' +
    '<b>选择一份对比基准（历史快照）</b>' +
    "<p>开始对比两个时间点的空间变化。</p>" +
    "</div></div>" +
    '<div id="compare-loading" class="compare-loading" hidden>' +
    '<div class="skel-list" aria-hidden="true">' +
    '<div class="skel-row"><span class="skel-block skel-name"></span><span class="skel-bar skel-block"></span><span class="skel-block skel-size"></span></div>' +
    '<div class="skel-row"><span class="skel-block skel-name"></span><span class="skel-bar skel-block"></span><span class="skel-block skel-size"></span></div>' +
    '<div class="skel-row"><span class="skel-block skel-name"></span><span class="skel-bar skel-block"></span><span class="skel-block skel-size"></span></div>' +
    '<div class="skel-row"><span class="skel-block skel-name"></span><span class="skel-bar skel-block"></span><span class="skel-block skel-size"></span></div>' +
    '<div class="skel-row"><span class="skel-block skel-name"></span><span class="skel-bar skel-block"></span><span class="skel-block skel-size"></span></div>' +
    "</div>" +
    '<span class="muted">正在对比，请稍候…</span>' +
    ' <span id="compare-loading-elapsed" class="muted scan-elapsed" hidden></span>' +
    ' <button id="btn-compare-cancel" class="btn btn-sm hidden" type="button">取消</button></div>' +
    '<div id="compare-result" class="compare-result" hidden>' +
    '<div id="compare-summary" class="compare-summary-row" role="group" aria-label="对比摘要（总变化/最大增长/可释放）"></div>' +
    '<div class="table-wrap compare-table-wrap">' +
    '<table class="dir-table compare-table" aria-label="对比明细">' +
    // P6（D6-1/变更集2）：原内联 style="width:120px/90px/80px" 收口为列类（.col-*）
    '<thead><tr><th class="col-delta">变化</th><th class="col-growth">增速</th><th>路径</th><th class="col-ops">操作</th></tr></thead>' +
    '<tbody id="compare-body"></tbody></table></div></div>' +
    "</div></section>";

export function renderCompare() {
    const el = document.createElement("div");
    el.innerHTML = COMPARE_PAGE_HTML;
    return el.firstElementChild;
}

export function mountCompare() {
    bindComparePage();
    /* 2026-09-13 第四轮：多选记忆回灌——选择集在 state.baselines（DOM 是每次挂载新建的
       节点，切页往返后 selectedOptions 必空）。记忆为空时（首挂/预填前）用主基准播种 1 份；
       之后 rebuildBaselineOptions 会按记忆恢复选中集，折线跨路由不丢。 */
    if (!pickedFromState().length && String(APP_STATE.compare.baseline || "").trim()) {
        rememberPicks([String(APP_STATE.compare.baseline).trim()]);
    }
    rebuildBaselineOptions(sessionsOf()); // P5（D5-2）：对比基准下拉全量快照选项（回灌填充）
    /* P4：回灌口径控件（切页不丢：深度选择器 + 隐藏零变化开关），再渲面包屑 */
    const depthSel = $("compare-depth");
    if (depthSel) depthSel.value = String(APP_STATE.compare.depth || "");
    const zeroBox = $("compare-hide-zero");
    if (zeroBox) zeroBox.checked = APP_STATE.compare.hideZero !== false;
    const sel = ensurePrefill(); // 三入口预填（趋势卡/迷你卡/直达默认最近一份）
    renderCrumb();
    syncForm(sel);
    /* 预填可能把基准落定到「最近一份」——记忆为空时把它补进 picks（否则首挂时
       selectedOptions/记忆皆空 → 折线永远只有 1 份，用户看不到趋势入口） */
    if (!pickedFromState().length && String(APP_STATE.compare.baseline || "").trim()) {
        rememberPicks([String(APP_STATE.compare.baseline).trim()]);
    }
    syncBaselineHint(); // P6（D6-5）：已选份数提示（回灌）
    syncBaselineTrigger(); // R1：自定义下拉触发钮文案（回灌）
    renderTrend();      // P6（D6-4）：趋势卡回灌（多选命中缓存不重发；<2 份给原因）
    if (!sel) {
        showEmpty();
        return;
    }
    const cached = resultCacheMatch(sel);
    if (cached) {
        // 路由往返回灌：同根同基线**同口径** → 从缓存渲染不重发（含趋势卡共享结果；不挂圆点）
        renderReport(cached.report, cached.root, cached.baseline, { fromCache: true });
        return;
    }
    compareSnapshots(); // 自动执行（定稿 6.4：预填即骨架屏→摘要→表格）
}

/* 数据清空（settings.wipeData）联动：结果/迷你摘要/趋势序列复位；对比页在位则回空态 */
export function resetCompareData() {
    APP_STATE.compare.result = null;
    APP_STATE.compare.lastSummary = null;
    APP_STATE.compare.drillRoot = "";   // P4：下钻根一并复位
    APP_STATE.compare.scope = "";       // 2026-09-13 第三轮：对比盘范围复位
    APP_STATE.compare.depth = "";
    APP_STATE.compare.hideZero = true;
    /* 2026-09-13：口径复位同时复位**使用偏好**——否则下次打开对比页会从偏好读回
       已被「清空」的旧口径，出现「界面说复位了、重开又变回来」的错位 */
    setPref("compare.depth", "");
    setPref("compare.hideZero", true);
    APP_STATE.compare.baselines = [];   // P6（D6-5）：多选清单复位（2026-09-13 第四轮：点选记忆同源）
    seriesCache.clear();                // P6（D6-4）：趋势序列缓存复位（快照可能已被删）
    seriesInflight.clear();
    renderCompareMini();
    if (isPageMounted()) {
        const baselineSel = $("compare-baseline");
        if (baselineSel) {
            baselineSel.innerHTML = "";
            baselineSel.dataset.optionCount = "0";
            setPrimaryBaseline(baselineSel, ""); // 主基准表单值一并复位（dataset.base）
        }
        const depthSel = $("compare-depth");
        if (depthSel) depthSel.value = "";
        const zeroBox = $("compare-hide-zero");
        if (zeroBox) zeroBox.checked = true;
        APP_STATE.compare.baseline = "";
        APP_STATE.compare.root = "";
        APP_STATE.compare.target = "";
        syncCurrentRow("");
        syncBaselineHint();
        renderTrend();
        renderCrumb();
        setStatus("compare-status", "", "选择一份对比基准（历史快照），开始对比它的采集时刻与本机当前磁盘状态的差异。");
        showEmpty();
    }
}

export function unmountCompare() {
    /* 无 rAF/轮询归本页；pending 的 compare 回包经 DOM 空守卫自吞 */
}
