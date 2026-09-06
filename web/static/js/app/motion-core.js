/* ============================================================
   UI 2.0（SpaceLens Pro）· motion-core 纯函数库（U1.2）
   - 零 DOM / 零依赖 / 无副作用：node --test 可测，浏览器可 tree-shake；
   - 与 `motion.js`（DOM 层）分离：所有可纯函数化的数值/哈希逻辑放本文件，
     `fnv1a` 放此处供 palette.js 取色，避免 palette↔motion 循环依赖；
   - 时长/缓动的 CSS 权威值在 tokens.css（motion.js 运行时经 getComputedStyle 读取），
     本文件只承载与 CSS 无关的数学。
   ============================================================ */

/* 线性插值：t∈[0,1] 时返回 a→b 中间值；t=0 → a，t=1 → b（精确）。 */
export function lerp(a, b, t) {
    return a + (b - a) * t;
}

/* 把 v 夹到 [0,1]（动画进度防越界）。 */
export function clamp01(v) {
    return v < 0 ? 0 : (v > 1 ? 1 : v);
}

/* easeOutExpo（§3.5 L1-4 count-up 用）：p∈[0,1]。
   端点精确：easeOutExpo(0)=0、easeOutExpo(1)=1（1 - 2^-10 仅 ≈0.999，故特判）。 */
export function easeOutExpo(p) {
    if (p <= 0) return 0;
    if (p >= 1) return 1;
    return 1 - Math.pow(2, -10 * p);
}

/* easeOutCubic：端点同样特判为精确 0/1。 */
export function easeOutCubic(p) {
    if (p <= 0) return 0;
    if (p >= 1) return 1;
    return 1 - Math.pow(1 - p, 3);
}

/* --ease-spring 的 JS 侧镜像（4 个贝塞尔控制点）。
   CSS 侧权威值仍以 tokens.css `--ease-spring` 为准（motion.js 运行时读取），
   此常量供 JS 驱动关键帧（如 L3-6 徽标 pop-in 的 scale 插值）引用。 */
export const easeSpring = [0.34, 1.56, 0.64, 1];

/* 秒 → "HH:MM:SS"（U3.2 扫描耗时计时器/摘要卡共用）。
   负数与非法输入按 0 处理；小时不取模（>24h 继续进位显示）。 */
export function formatElapsed(sec) {
    const total = Math.max(0, Math.floor(Number(sec) || 0));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n) => String(n).padStart(2, "0");
    return pad(h) + ":" + pad(m) + ":" + pad(s);
}

/* 阶段D（D-3b）：估算剩余秒数（根间平台期口径——「已完成根均耗时 × 剩余根数」）。
   - 纯函数、零 DOM：node --test 可测；浏览器侧与扫描卡 ETA 渲染共用；
   - 输入：elapsedSec（已完成根累计耗时，秒）、done（已完成根数）、total（总根数）；
   - done<=0 或 total<=done → 返回 null（无法估算）；
   - 结果取整到秒（向上），最低 1s；估算值随 elapsed 增长单调不减（均速假设下）。 */
export function estimateRemainingSec(elapsedSec, done, total) {
    const d = Number(done) || 0;
    const t = Number(total) || 0;
    if (d <= 0 || t <= d) return null;
    const elapsed = Number(elapsedSec) || 0;
    if (elapsed <= 0) return null;
    const perRoot = elapsed / d;
    return Math.max(1, Math.ceil(perRoot * (t - d)));
}

/* 阶段D（D-3b）：ETA 不闪跳判定——估算值相对上次显示值变化 >10% 才视为「应更新」。
   - 纯函数：输入 (remain, lastRemain, soon) → bool；
   - soon（剩余 ≤30s 的「即将完成」档）与 lastRemain 跨档 → 必更新；
   - 首采样（lastRemain===null）→ 必更新；变化 ≤10% → 不更新（防数字抖动）。 */
export function etaShouldUpdate(remain, lastRemain, soon) {
    if (lastRemain === null || lastRemain === undefined) return true;
    if (soon && Number(lastRemain) > 30) return true;
    if (!soon && Number(lastRemain) <= 30) return true;
    const diff = Math.abs(Number(remain) - Number(lastRemain));
    return diff > Math.max(1, Math.round(Math.abs(Number(lastRemain)) * 0.1));
}

/* FNV-1a 32 位哈希（§3.4 treemap 调色板取色：fnv1a(目录名) % 10）。
   hash 状态按 int32 中间量运算（XOR/`Math.imul`），最终 `>>> 0` 归一到
   uint32 ∈ [0, 2^32-1]；同输入恒同输出、异名高概率异色。 */
export function fnv1a(str) {
    let h = 0x811c9dc5;
    const s = String(str);
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

/* CSS cubic-bezier(x1,y1,x2,y2) 的 JS 求值器（U2.2，treemap L1-1 入场缓动用）。
   - 纯函数、零 DOM：node --test 可测；浏览器侧与 CSS 的 `--ease-*` token 同源
     （treemap.js 运行时读出 token 控制点字符串传入本函数）；
   - 返回 f(p)：p∈[0,1] 时间进度 → 输出进度；端点精确 0/1；
   - 求解 t 使 x(t)=p：8 轮 Newton + 二分兜底（x 非单调控制点时仍收敛）。 */
export function cubicBezier(x1, y1, x2, y2) {
    const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
    const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
    const sampleX = (t) => ((ax * t + bx) * t + cx) * t;
    const sampleY = (t) => ((ay * t + by) * t + cy) * t;
    const sampleDX = (t) => (3 * ax * t + 2 * bx) * t + cx;
    const solveX = (x) => {
        if (x <= 0) return 0;
        if (x >= 1) return 1;
        let t = x;
        for (let i = 0; i < 8; i++) {
            const err = sampleX(t) - x;
            if (Math.abs(err) < 1e-6) return t;
            const d = sampleDX(t);
            if (Math.abs(d) < 1e-6) break;
            t -= err / d;
        }
        let lo = 0, hi = 1;
        t = x;
        while (hi - lo > 1e-6) {
            const err = sampleX(t) - x;
            if (Math.abs(err) < 1e-6) break;
            if (err > 0) hi = t; else lo = t;
            t = (lo + hi) / 2;
        }
        return t;
    };
    return (p) => sampleY(solveX(clamp01(p)));
}

/* P-4（阶段G G-2）：sparkline 折线纯函数（零 DOM，node 可测）。
   - sparklinePath(values, w, h)：把时间序列 values（数字数组，升序时间）归一化到
     [0,w]×[0,h] 的折线 path d 字符串；<2 点返回空串（无折线）；全等值 → 水平中线；
   - sparklineLastPoint(values, w, h)：终点坐标 {x,y}（终点脉冲锚点；空序列 → null）；
   - 语义与 snapshots.js 趋势卡 sparkline 共用（数据源 = /api/snapshots total_by_root
     按会话时间升序派生；与差值卡 total_current 同口径——C-6 两地一致）。 */
export function sparklinePath(values, w, h) {
    const v = (values || []).map(Number).filter((n) => Number.isFinite(n));
    if (v.length < 2) return "";
    const W = Number(w) || 0;
    const H = Number(h) || 0;
    if (W <= 0 || H <= 0) return ""; // 非法视口 → 无折线
    const min = Math.min.apply(null, v);
    const max = Math.max.apply(null, v);
    const span = max - min;
    const step = W / (v.length - 1);
    const y = (val) => (span > 0 ? H - ((val - min) / span) * H : H / 2);
    return v.map((val, i) => {
        const x = i * step;
        return (i === 0 ? "M" : "L") + x.toFixed(2) + " " + y(val).toFixed(2);
    }).join(" ");
}
export function sparklineLastPoint(values, w, h) {
    const v = (values || []).map(Number).filter((n) => Number.isFinite(n));
    if (!v.length) return null;
    const W = Number(w) || 0;
    const H = Number(h) || 0;
    if (W <= 0 || H <= 0) return null;
    const min = Math.min.apply(null, v);
    const max = Math.max.apply(null, v);
    const span = max - min;
    const x = v.length > 1 ? W : 0;
    const y = span > 0 ? H - ((v[v.length - 1] - min) / span) * H : H / 2;
    return { x: Number(x.toFixed(2)), y: Number(y.toFixed(2)) };
}
