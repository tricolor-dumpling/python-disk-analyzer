/* ============================================================
   UI 2.0（SpaceLens Pro）· labels.js 共享文案/纯映射（U2.0 模块化迁入）
   - SKIP_REASON_TEXT / skipReasonText 逐字迁自旧单体脚本「P12·W2.2」段；
   - 独立叶子模块：scan.js（保存 toast）与 snapshots.js（列表渲染）共用，
     避免 scan ↔ snapshots 模块互引成环（§U2.0 循环依赖纪律）。
   ============================================================ */

/* P12·W2.2：skip_reason 稳定枚举 → 中文（保存 toast 与快照列表共用） */
export const SKIP_REASON_TEXT = {
    already_saved_today: "该根今天已自动保存过",
    day_budget_exceeded: "今日写入量已达上限，自动保存跳过",
    predicate_rejected: "未满足自动保存条件（数据未变化等）",
};

export function skipReasonText(reason) {
    return SKIP_REASON_TEXT[reason] || reason || "已跳过";
}
