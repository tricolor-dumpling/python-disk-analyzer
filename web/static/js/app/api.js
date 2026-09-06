/* ============================================================
   UI 2.0（SpaceLens Pro）· api.js 基础工具（U2.0 模块化迁入）
   - $ / esc / api / postJson / humanBytes / signedBytes
   - 函数体与迁移源逐字一致（行为等价重构）；
   - ⚠️ 偏差注记：手册 §3.1 提到 getJson，但旧源码无此函数
     （GET 一律走 api(url)），以源码为准：本模块不另造 getJson。
   ============================================================ */

export const $ = (id) => document.getElementById(id);

export function esc(text) {
    return String(text)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

export async function api(url, options) {
    const resp = await fetch(url, options);
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || data.ok === false) {
        // P12·W1.3：新形态错误 {ok,error,code,detail} 把 code/detail 挂到 Error 上；
        // 旧形态 {ok,error} 无 code —— 渲染器据此降级（RT-N04 双向容忍）。
        const err = new Error(data.error || ("请求失败：" + resp.status));
        if (data && data.code !== undefined && data.code !== null) err.code = data.code;
        if (data && data.detail) err.detail = data.detail;
        throw err;
    }
    return data;
}

export function postJson(url, payload, options) {
    return api(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload || {}),
        ...(options || {}), // additive：透传 signal 等（B-2 AbortController 超时/取消）
    });
}

/* 与后端 utils.human_size 一致的格式（两位小数 + 单位） */
export function humanBytes(n) {
    if (n === null || n === undefined || isNaN(n)) return "-";
    const units = ["B", "KB", "MB", "GB", "TB", "PB"];
    let v = Number(n);
    let i = 0;
    while (Math.abs(v) >= 1024 && i < units.length - 1) {
        v /= 1024;
        i += 1;
    }
    return v.toFixed(2) + " " + units[i];
}

/* 带符号的变化量（+12.34 MB / -8.10 MB） */
export function signedBytes(n) {
    if (n === null || n === undefined) return "-";
    const v = Number(n);
    if (v === 0) return "0.00 B";
    return (v > 0 ? "+" : "") + humanBytes(v);
}
