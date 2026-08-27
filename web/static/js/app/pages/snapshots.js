/* ============================================================
   UI 2.0（SpaceLens Pro）· pages/snapshots.js（U2.0 从 app.js 迁入）
   - 历史快照卡（会话分组渲染/基线建议 datalist）随映射表落户本页模块；
   - U3.3 升级为 #/snapshots 子页面（趋势卡/工具行）时本模块为落点；
   - 主页右栏迷你卡（N06）接入亦归本模块。
   ============================================================ */

import { $, api, esc } from "../api.js";
import { ICONS } from "../icons.js";
import { setStatus } from "../components/statusbar.js";
import { skipReasonText } from "../labels.js";

let sessionsCache = [];

/* 模块化拆分导出的读写器（原 smoke 测试恢复点/settings wipeData 清空点的跨模块访问） */
export function getSessionsCache() { return sessionsCache; }
export function setSessionsCache(v) { sessionsCache = v; }

function formatCreatedAt(text) {
    return String(text || "").replace("T", " ");
}

export async function refreshSnapshots() {
    setStatus("snapshot-status", "busy", "正在加载历史快照…");
    try {
        const data = await api("/api/snapshots");
        sessionsCache = data.sessions || [];
        // P12·W2.5（D）：无会话时撤销入口灰置
        $("btn-undo-save").disabled = !sessionsCache.length;
        renderSnapshotList(sessionsCache);
        rebuildBaselineSuggest(sessionsCache);
        setStatus("snapshot-status", "", "共 " + sessionsCache.length + " 个快照会话");
    } catch (e) {
        setStatus("snapshot-status", "err", e.message);
    }
}

/* P12·W2.4：root 归一化预检——trim + 大写 + 尾反斜杠（终审仍留后端 normcase） */
export function normRoot(x) {
    let v = String(x || "").trim().toUpperCase();
    if (!v) return "";
    if (!v.endsWith("\\")) v += "\\";
    return v;
}

export function renderSnapshotList(sessions) {
    const list = $("snapshot-list");
    if (!sessions.length) {
        list.innerHTML =
            '<li><div class="empty-state">' +
            ICONS.empty +
            "<b>暂无快照会话</b>" +
            "<p>完成一次「全量扫描」并点击「保存快照」，这里就会按保存会话列出 C、D 两份快照。</p>" +
            "</div></li>";
        return;
    }
    list.innerHTML = sessions
        .map((s) => {
            const roots = Object.values(s.roots || {});
            const rootLines = roots.length
                ? '<ul class="session-roots">' +
                  roots
                      .map((r) => {
                          if (r.skipped) {
                              return (
                                  "<li>" + ICONS.drive +
                                  '<span>' + esc(r.root || "?") + '</span>' +
                                  '<span class="tag tag-skip">跳过</span>' +
                                  '<span>' + esc(skipReasonText(r.skip_reason)) + "</span></li>"
                              );
                          }
                          // P12·W2.4：每盘子行尾「对比此快照」一键入口
                          const cmpBtn = r.snapshot_path
                              ? '<button class="btn btn-sm act-cmp-snap" data-baseline="' + esc(r.snapshot_path) +
                                '" data-root="' + esc(r.root || "") + '">对比此快照</button>'
                              : "";
                          return (
                              "<li>" + ICONS.drive +
                              "<span>" + esc(r.root || "?") + " →</span>" +
                              "<code>" + esc(r.snapshot || "缺快照") + "</code>" +
                              cmpBtn + "</li>"
                          );
                      })
                      .join("") +
                  "</ul>"
                : '<div class="session-sub">该会话没有快照记录</div>';
            return (
                '<li class="session-item">' +
                '<div class="session-head">' +
                '<span class="session-title">' + ICONS.clock +
                esc(formatCreatedAt(s.created_at || s.session_id)) + "</span>" +
                (s.auto ? '<span class="tag tag-auto">自动</span>' : '<span class="tag tag-manual">手动</span>') +
                "</div>" +
                '<div class="session-sub">' + esc(s.session_id) + "</div>" +
                rootLines +
                "</li>"
            );
        })
        .join("");
}

export function rebuildBaselineSuggest(sessions) {
    const list = $("baseline-suggest");
    list.innerHTML = "";
    sessions.forEach((s) => {
        Object.values(s.roots || {}).forEach((r) => {
            if (r.snapshot_path) {
                const opt = document.createElement("option");
                opt.value = r.snapshot_path;
                list.appendChild(opt);
            }
        });
    });
}
