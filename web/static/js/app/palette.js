/* ============================================================
   UI 2.0（SpaceLens Pro）· palette.js（U2.2）
   - Treemap 调色板（手册 §3.4，定稿 D3）：亮暗通用 10 色；
     取色 = fnv1a(名称) % 10（fnv1a 在 motion-core.js，U1.2 已备，勿重写）；
   - 「其他」合并块固定 `#64748b`（= 亮色 --muted 的语义色值；暗色主题由
     绘制层叠 8% 白提升可读性，调色本身不变）；
   - ⚠️ 注记：本文件为 JS 侧唯一 color 来源（canvas 填充需要具体色值，
     tokens.css 无法直接供 canvas 使用）；CSS 侧（style.css）色值门禁
     hex=0 不受影响——所有新颜色仍只进 tokens.css 变体或本调色板。
   ============================================================ */

import { fnv1a } from "./motion-core.js";

/* §3.4 调色板（照抄手册，勿即兴调参） */
export const PALETTE = [
    "#6366f1", "#3b82f6", "#06b6d4", "#10b981", "#84cc16",
    "#eab308", "#f59e0b", "#ef4444", "#ec4899", "#a855f7",
];

/* 「其他」合并块固定色（= 亮色 --muted #64748b） */
export const OTHER_COLOR = "#64748b";

/* 取色：fnv1a(目录名) % 10（同输入恒同色；异名高概率异色） */
export function colorFor(name) {
    return PALETTE[fnv1a(String(name)) % PALETTE.length];
}
