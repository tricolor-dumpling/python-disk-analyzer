// ==UserScript==
// @name        pds-u11-acc-probe
// @namespace   pds
// @version     1.0
// @description U1.1 验收探针：主题切换 VT 指标 / reduced 直切 / 控制台错误捕获（顶层 return 结果）
// @match       http://127.0.0.1/*
// @grant       none
// @run-at      document-idle
// ==/UserScript==

const R = { errs: [] };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

window.addEventListener("error", (e) => R.errs.push("onerror:" + (e.message || "")));
window.addEventListener("unhandledrejection", (e) => R.errs.push("unhandledrejection:" + String((e.reason && e.reason.message) || e.reason)));
const origErr = console.error.bind(console);
console.error = function () { R.errs.push("console.error:" + Array.prototype.map.call(arguments, String).join(" ")); origErr.apply(console, arguments); };

const root = document.documentElement;
const getTheme = () => root.getAttribute("data-theme");
const clickBtn = (el) => {
  const r = el.getBoundingClientRect();
  el.dispatchEvent(new PointerEvent("click", { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
};

const OrigVT = Document.prototype.startViewTransition;
const vtState = { called: 0, lastMs: -1 };
if (typeof OrigVT === "function") {
  Document.prototype.startViewTransition = function (cb) {
    vtState.called++;
    const t0 = performance.now();
    const vt = OrigVT.call(this, cb);
    if (vt && vt.finished) vt.finished.then(() => { vtState.lastMs = performance.now() - t0; });
    return vt;
  };
}
R.supportsVT = typeof OrigVT === "function";

let attrT = { t: -1 };
new MutationObserver(() => {
  if (attrT.t < 0 && attrT.expect && getTheme() === attrT.expect) attrT.t = performance.now();
}).observe(root, { attributes: true, attributeFilter: ["data-theme"] });

// 等待 app 初始化（#btn-theme 已绑定）
R.mediaDark = !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
let btn = null;
for (let i = 0; i < 50 && !btn; i++) { btn = document.getElementById("btn-theme"); if (!btn) await wait(100); }
R.btnFound = !!btn;
if (!btn) { R.phase = "no-btn"; return R; }

R.lsBefore = localStorage.getItem("pds_theme_v1");
R.initTheme = getTheme();
R.initFollowsSystem = R.initTheme === (R.mediaDark ? "dark" : "light");

// ① 正常路径（带坐标 → VT 圆形扩散）
vtState.called = 0; vtState.lastMs = -1; attrT.t = -1;
attrT.expect = getTheme() === "dark" ? "light" : "dark";
const t0 = performance.now();
clickBtn(btn);
await wait(750);
R.switchA = { to: getTheme(), vtCalled: vtState.called, vtMs: Math.round(vtState.lastMs * 10) / 10, clickToAttrMs: attrT.t >= 0 ? Math.round((attrT.t - t0) * 10) / 10 : -1, ls: localStorage.getItem("pds_theme_v1") };

// 切回（验证双向）
vtState.called = 0; vtState.lastMs = -1; attrT.t = -1;
attrT.expect = getTheme() === "dark" ? "light" : "dark";
const t1 = performance.now();
clickBtn(btn);
await wait(750);
R.switchBack = { to: getTheme(), vtCalled: vtState.called, vtMs: Math.round(vtState.lastMs * 10) / 10, clickToAttrMs: attrT.t >= 0 ? Math.round((attrT.t - t1) * 10) / 10 : -1, ls: localStorage.getItem("pds_theme_v1") };

// ④ reduced-motion 直切
const origMM = window.matchMedia;
window.matchMedia = function (q) {
  if (String(q).indexOf("prefers-reduced-motion") !== -1) {
    return { matches: true, media: q, addEventListener: function () {}, removeEventListener: function () {}, addListener: function () {}, removeListener: function () {} };
  }
  return origMM(q);
};
vtState.called = 0; vtState.lastMs = -1; attrT.t = -1;
attrT.expect = getTheme() === "dark" ? "light" : "dark";
const t2 = performance.now();
clickBtn(btn);
await wait(350);
R.reduced = { to: getTheme(), vtCalled: vtState.called, clickToAttrMs: attrT.t >= 0 ? Math.round((attrT.t - t2) * 10) / 10 : -1, ls: localStorage.getItem("pds_theme_v1") };
window.matchMedia = origMM;

R.phase = "done";
return R;
