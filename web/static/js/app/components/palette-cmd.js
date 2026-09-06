/* ============================================================
   UI 2.0（SpaceLens Pro）· components/palette-cmd.js（U3.1 · N02 命令面板）
   - 数据源/执行器：由 main.js 注入（setPaletteBuilder——同 router 注册表模式，
     本模块零业务依赖、零模块环；Item = {group,label,hint,keywords,exec}）；
   - 本地模糊匹配：子序列命中 + 首字母加权（fuzzyScore，纯函数）；
   - 键盘：↑↓ 选择（循环）、Enter 执行、Esc 关闭（经弹窗栈逆序——红线 #9 扩展：
     面板视作浮层入栈，Tab 循环/R 守卫由 modals.js 栈机制覆盖）；
   - 全局快捷键：Ctrl/⌘K 开合面板（其他弹窗打开时忽略，语义与旧 Ctrl+K 一致）；
     ⚠️ U4.1：`/` 快捷键移交 keyboard.js（定稿 7.4/semantics=聚焦筛选框
     #browse-filter——旧「聚焦顶栏搜索框」语义废止；守卫同 keys.js 共享口径）。
   ============================================================ */

import { $, esc } from "../api.js";
import { APP_STATE } from "../state.js";
import { openModal, closeModal, hasOpenModal, isTopModal } from "./modals.js";

let builder = null;            // () => Item[]（main.js 注入）
let items = [];                // 原始条目快照
let filtered = [];             // 过滤后扁平条目（渲染顺序）
let selected = 0;              // filtered 下标（键盘循环）

export function setPaletteBuilder(fn) { builder = fn; }

export function isPaletteOpen() {
    const el = $("palette");
    return !!el && !el.classList.contains("hidden");
}

export function openPalette() {
    if (isPaletteOpen()) return;
    items = (typeof builder === "function" ? builder() : []).slice();
    const input = $("palette-input");
    if (input) input.value = "";
    render("");
    openModal("palette");
    APP_STATE.ui.paletteOpen = true;
    if (input) {
        input.focus();
        try { input.select(); } catch (e) { /* 非文本态忽略 */ }
    }
}

export function closePalette() {
    if (!isPaletteOpen()) return;
    closeModal("palette");
    APP_STATE.ui.paletteOpen = false;
}

/* ================= 模糊匹配（子序列 + 首字母加权；纯函数可测） ================= */

/* 贪心子序列：query 能否在 text 中按序命中；返回首个命中字符下标（未命中 -1） */
function subsequenceIdx(query, text) {
    let ti = 0;
    let first = -1;
    for (let qi = 0; qi < query.length; qi++) {
        const ch = query[qi];
        if (ch === " ") continue; // 查询中的空格不参与匹配
        while (ti < text.length && text[ti] !== ch) ti++;
        if (ti >= text.length) return -1;
        if (first < 0) first = ti;
        ti++;
    }
    return first;
}

function isWordStart(text, idx) {
    return idx === 0 || /[\s/\\:：、,，.。\-()（）]/.test(text.charAt(idx - 1) || " ");
}

export function fuzzyScore(query, label, keywords) {
    const q = String(query || "").trim().toLowerCase();
    const lb = String(label || "").toLowerCase();
    if (!q || !lb) return 0;
    if (lb === q) return 1000;                    // 精确
    if (lb.startsWith(q)) return 900;              // 前缀
    const sub = lb.indexOf(q);
    if (sub >= 0) return 600 - Math.min(sub, 40) * 2; // 子串（位置越靠前越好）
    let best = 0;
    const evalText = (t) => {
        const idx = subsequenceIdx(q, t);
        if (idx < 0) return 0;
        let s = 300 - idx * 3 + q.length * 5;
        if (isWordStart(t, idx)) s += 80;         // 首字母加权：命中词首加分
        return s;
    };
    best = Math.max(best, evalText(lb));
    (Array.isArray(keywords) ? keywords : []).forEach((k) => {
        const kw = String(k || "").toLowerCase();
        if (kw === q) { best = Math.max(best, 700); return; }
        if (kw.startsWith(q)) { best = Math.max(best, 650); return; }
        best = Math.max(best, evalText(kw));
    });
    return best;
}

/* ================= 渲染 ================= */

function render(query) {
    const box = $("palette-results");
    if (!box) return;
    const q = String(query || "").trim();
    // 分组过滤：组顺序 = 条目出现顺序（builder 已按组有序），组内按分数排序
    const groups = [];
    const byGroup = new Map();
    items.forEach((it) => {
        const g = it.group || "其他";
        if (!byGroup.has(g)) { byGroup.set(g, []); groups.push(g); }
        byGroup.get(g).push(it);
    });
    filtered = [];
    groups.forEach((g) => {
        let arr = byGroup.get(g);
        if (q) {
            arr = arr
                .map((it) => [fuzzyScore(q, it.label, it.keywords), it])
                .filter((x) => x[0] > 0)
                .sort((a, b) => b[0] - a[0])
                .map((x) => x[1]);
        }
        arr.forEach((it) => filtered.push(it));
    });
    let html = "";
    let lastGroup = null;
    filtered.forEach((it, i) => {
        if (it.group !== lastGroup) {
            html += '<div class="palette-group-label">' + esc(it.group) + "</div>";
            lastGroup = it.group;
        }
        html +=
            '<div class="palette-item" role="option" data-idx="' + i + '">' +
            '<span class="palette-item-label">' + esc(it.label) + "</span>" +
            '<span class="palette-item-hint">' + esc(it.hint || "") + "</span>" +
            "</div>";
    });
    if (!filtered.length) {
        html =
            '<div class="palette-empty">' +
            (q ? "没有匹配「" + esc(q) + "」的条目，试试更短的关键词。" : "输入以搜索页面、盘符、历史与命令") +
            "</div>";
    }
    box.innerHTML = html;
    selected = filtered.length ? 0 : -1;
    syncActive();
}

function syncActive() {
    document.querySelectorAll("#palette-results .palette-item").forEach((el) => {
        const on = Number(el.getAttribute("data-idx")) === selected;
        el.classList.toggle("is-active", on);
        if (on) {
            el.setAttribute("aria-selected", "true");
            try { el.scrollIntoView({ block: "nearest" }); } catch (e) { /* ignore */ }
        } else {
            el.removeAttribute("aria-selected");
        }
    });
}

function move(d) {
    if (!filtered.length) return;
    selected = (selected + d + filtered.length) % filtered.length;
    syncActive();
}

function run(item) {
    if (!item) return;
    closePalette();
    try { item.exec(); } catch (e) { console.error("palette exec:", e); }
}

/* ================= 绑定（init 期一次） ================= */

export function bindPalette() {
    // [N02] 搜索框点击打开（顶栏按钮；Ctrl/⌘K 快捷键见下方全局监听）
    const searchBtn = $("btn-palette");
    if (searchBtn) searchBtn.addEventListener("click", () => openPalette());
    const input = $("palette-input");
    const box = $("palette-results");
    if (input) {
        input.addEventListener("input", () => render(input.value));
        input.addEventListener("keydown", (ev) => {
            if (ev.key === "ArrowDown") { ev.preventDefault(); move(1); }
            else if (ev.key === "ArrowUp") { ev.preventDefault(); move(-1); }
            else if (ev.key === "Enter") { ev.preventDefault(); run(filtered[selected]); }
            // Esc：不在此处理——弹窗栈（modals.js）按逆序关栈顶（红线 #9 扩展）
        });
    }
    if (box) {
        box.addEventListener("click", (ev) => {
            const el = ev.target.closest ? ev.target.closest(".palette-item") : null;
            if (el) {
                const idx = Number(el.getAttribute("data-idx"));
                run(filtered[idx]);
            }
        });
    }
    // 全局快捷键（U3.1；旧 Ctrl+K 聚焦 browse-root 语义由命令面板接管——定稿 N02）
    document.addEventListener("keydown", (ev) => {
        if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "k") {
            if (isPaletteOpen()) {
                if (isTopModal("palette")) { ev.preventDefault(); closePalette(); }
                return; // 面板非栈顶（其他弹窗在上层）时忽略——红线 #9 语义
            }
            if (hasOpenModal()) return; // 其他弹窗打开时忽略（红线 #9 语义保持）
            ev.preventDefault();
            openPalette();
            return;
        }
        // U4.1：`/`（聚焦筛选框）与 g 序列已移交 keyboard.js（keys.js 共享守卫同口径）
    });
    // Esc/背板等经 modals.js closeModal 关闭（栈机制）→ 面板状态标志联动
    window.addEventListener("pds:overlay-close", (ev) => {
        if (ev.detail && ev.detail.id === "palette") APP_STATE.ui.paletteOpen = false;
    });
}
