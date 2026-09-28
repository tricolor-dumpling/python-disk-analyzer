/* ============================================================
   UI 2.0（SpaceLens Pro）· keys.js（U4.1 建 · 单键快捷键共享守卫）
   - 叶子模块（零依赖、零环）：凡「单键/键盘序列」守卫一律复用本模块，
     与既有 Backspace（U2.3）/R（modals.js）同口径：
       · 事件目标为输入框/可编辑元素 → 忽略（不抢打字焦点）；
       · e.isComposing === true（中文输入法组词中）→ 一律忽略；
     workspace.js（Backspace）、palette-cmd.js（Ctrl+K 之外的序列由
     keyboard.js 接管）、keyboard.js（/ 与 g 序列）共用本守卫。
   ============================================================ */

/* 目标是否为输入框/可编辑元素（含 SELECT——打字弹出候选时不抢焦点） */
export function isEditableTarget(t) {
    if (!t) return false;
    const tag = t.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t.isContentEditable === true;
}

/* 完整打字态守卫：目标可编辑 或 输入法组词中（isComposing） */
export function isTypingEvent(ev) {
    if (!ev) return true; // 缺事件按打字态处理（守卫从严）
    return isEditableTarget(ev.target) || ev.isComposing === true;
}
