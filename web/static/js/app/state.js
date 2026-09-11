/* ============================================================
   UI 2.0（SpaceLens Pro）· state.js APP_STATE 单一来源（U2.0 建，U2.1 对齐 §3.2）
   - U2.0：迁入旧单体脚本的 { lastBrowseData, health }（行为等价优先）；
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
    /* P5（D5-4）：默认根去魔法值——原为写死的 "D:\\"。现由 main.js 启动链
       applyDefaultRoot() 落定「上次浏览 → 后端枚举盘首项 → ""（UI 显示「请选择盘符」）」；
       盘符清单一律来自 /api/roots（components/drives.js），本文件不再持有盘符字面量。
       onboarding：引导选盘状态（pickedRoots=用户已选盘，跳过后保持空）。 */
    browse: { root: "", path: "", parent: null, history: [], seq: 0 }, // U2.3 面包屑联动/迷你条带启用（现由 workspace 模块级状态承载）
    view: { mode: "treemap", mergeTop: 24, sort: "size-desc", kind: "all", filter: "" }, // U2.2/U2.5 启用（P3/D3-6：density 字段已删除，行高固定 36px）
    selection: { keys: [], anchor: null },       // N08 多选（key=条目 path）；U2.5 启用
    scan: { running: false, startTs: 0, roots: [], done: [], current: null,
            stopAvailable: false, stopRequested: false, version: 0, finishedAt: null }, // U3.2 启用
    snapshots: { sessions: [] },                 // U3.3 启用
    /* P5（D5-3）：首开选盘状态。pickedRoots = 用户在引导弹层「选择要分析的盘」里选中的盘
       （多选，原始 "X:\\" 形式）；跳过后保持空数组（= 走既有默认逻辑）。
       归属 components/onboarding.js 维护；持久化另走 localStorage
       pds_selected_drives_v1 + /api/settings 的 last_roots（见 components/drives.js）。 */
    onboarding: { pickedRoots: [] },             // P5 启用
    /* P4（问题 5/6）：depth=""（叶子口径，缺省）/ "1".."5"（聚合到第 N 层）；
       hideZero=true（请求带 drop_zero）；drillRoot=""（未下钻）或下钻目录全路径。
       三者由 pages/compare.js 维护（切页不丢），resetCompareData 复位。
       P6（D6-5）：baselines = 对比基准**多选**清单（快照路径数组，时间倒序）——
       baseline 仍是主对比基准（= 清单最新一份，既有契约不变），baselines 供
       /api/series 多快照趋势折线使用；同由 pages/compare.js 维护。 */
    compare: { baseline: "", target: "", result: null, lastSummary: null,
               depth: "", hideZero: true, drillRoot: "", baselines: [] },             // U3.4 启用；P4 增 depth/hideZero/drillRoot；P6 增 baselines
    treemap: { tiles: [], prev: new Map(), focusIdx: -1, hoverKey: null },              // U2.2 启用
    ui: { fullscreen: false, paletteOpen: false, onboardingSeen: true },                // U2.3 全屏/U3.1 面板启用

    /* P12·W2.6（K6）旧键（U2.0 迁入，行为等价保留；随功能工作项并入上表命名空间后移除） */
    lastBrowseData: null, // 最近一次 /api/browse 载荷（视图切换重渲用）
    healthPayload: null,  // 最近一次 /api/health 载荷（旧键名 health，见 topbar.js）
};
