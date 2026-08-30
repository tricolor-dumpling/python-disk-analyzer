/* ============================================================
   UI 2.0（SpaceLens Pro）· state.js APP_STATE 单一来源（U2.0 建，U2.1 对齐 §3.2）
   - U2.0：迁入旧 app.js 的 { lastBrowseData, health }（行为等价优先）；
   - U2.1：按手册 §3.2 目标形状落地全场命名空间——route 为本阶段真实字段
     （router 维护 + smoke A3 断言）；其余命名空间按 §3.2 默认值预置，
     随对应功能工作项启用（view→U2.2/U2.5、selection→U2.5、scan→U3.2、
     snapshots/compare→U3.3/U3.4、treemap→U2.2、ui→U3.x）；
   - 跨页面状态保持：模块级状态（currentPath/browseView/…）随模块持久，
     路由切换不卸载模块 = 天然满足「切页不丢」；逐项迁入 state 随功能工作项。
   - localStorage 键表归属：pds_theme_v1 → theme.js；pds_onboarding_dismissed_v1 → onboarding.js；
     pds_handled_scan_version_v1 → scan.js。
   ============================================================ */

export const APP_STATE = {
    /* §3.2 目标形状（U2.1 起） */
    theme: "light",                              // U3.5 起为三态偏好 "light"|"dark"|"system"（缺 key=system）；持久化 pds_theme_v1（index.html head 解析；theme.js 维护）
    route: "/",                                  // 由 router 维护；"/"|"/compare"|"/snapshots"（未知回落 "/"）
    health: { state: "checking", detail: null }, // 语义对齐：U2.0 旧键 health 为载荷对象（见下），本命名空间 U3.1 徽章 popover 启用
    browse: { root: "D:\\", path: "D:\\", parent: null, history: [], seq: 0 }, // U2.3 面包屑联动/迷你条带启用（现由 workspace 模块级状态承载）
    view: { mode: "treemap", density: "cozy", mergeTop: 24, sort: "size-desc", kind: "all", filter: "" }, // U2.2/U2.5 启用
    selection: { keys: [], anchor: null },       // N08 多选（key=条目 path）；U2.5 启用
    scan: { running: false, startTs: 0, roots: [], done: [], current: null,
            stopAvailable: false, stopRequested: false, version: 0, finishedAt: null }, // U3.2 启用
    snapshots: { sessions: [] },                 // U3.3 启用
    compare: { baseline: "", target: "", result: null, lastSummary: null },             // U3.4 启用
    treemap: { tiles: [], prev: new Map(), focusIdx: -1, hoverKey: null },              // U2.2 启用
    ui: { fullscreen: false, paletteOpen: false, onboardingSeen: true },                // U2.3 全屏/U3.1 面板启用

    /* P12·W2.6（K6）旧键（U2.0 迁入，行为等价保留；随功能工作项并入上表命名空间后移除） */
    lastBrowseData: null, // 最近一次 /api/browse 载荷（视图切换重渲用）
    healthPayload: null,  // 最近一次 /api/health 载荷（旧键名 health，见 topbar.js）
};
