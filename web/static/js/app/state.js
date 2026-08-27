/* ============================================================
   UI 2.0（SpaceLens Pro）· state.js APP_STATE 单一来源（U2.0 从 app.js 迁入）
   - 旧 app.js 的 APP_STATE = { lastBrowseData, health }（P12·W2.6 K6），逐字迁入；
   - §3.2 目标形状的其余命名空间（route/view/selection/scan/snapshots/compare/
     treemap/ui）待 U2.1 路由落地时按形状对齐填充（本阶段无消费方，不预置，
     避免「无消费字段」误导——见手册执行记录 U2.0 偏差注记）；
   - localStorage 键表归属（搬家不改行为，不集中搬动）：
     pds_theme_v1 → theme.js；pds_onboarding_dismissed_v1 → onboarding.js；
     pds_handled_scan_version_v1 → scan.js。
   ============================================================ */

/* P12·W2.6（K6）：页面级可变状态收敛到单一对象（不再挂 window 全局散落） */
export const APP_STATE = {
    lastBrowseData: null, // 最近一次 /api/browse 载荷（视图切换重渲用）
    health: null,         // 最近一次 /api/health 载荷
};
