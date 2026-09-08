# 作废证据（INVALID）

> 本目录内文件是 P0 首版本帧记录器 `p00_frame_recorder.mjs`（v1）产出的**无效/误导性关键帧 PNG**，由 leader 复核发现并勒令返工。

## 作废原因

v1 在**整个序列采样结束后**才调用 `page.screenshot()` 拍照（≈130ms/张），拍到的是**终态画面**（relate 视图），与 `frames.json` 中的违规帧毫无对应关系。四个文件名声称的 ts=188/228/295/1145 与实际画面内容不符：

| 文件 | 字节数 | SHA-256(前12) | 声明 ts | 实际内容 |
|---|---|---|---|---|
| key-frame-0009-ts188-shown.png | 112092 | 486DAD2E1C82 | 188 | 终态（relate） |
| key-frame-0013-ts228-shown.png | 112092 | 486DAD2E1C82 | 228 | 终态（relate，字节相同） |
| key-frame-0017-ts295-shown.png | 112092 | 486DAD2E1C82 | 295 | 终态（relate，字节相同） |
| key-frame-0068-ts1145-hidden.png | 112092 | 486DAD2E1C82 | 1145 | 终态（relate，字节相同） |

四张**字节完全相同**（同一终态），构成 P0 纪律所不容的「看起来有证据、实际是误导」——P0 的全部价值是可信证据，此类文件不得保留在有效证据路径。

## 处置

- 4 个违规 PNG 移入本 `_invalid/` 目录，**不再被 `manifest.json` 引用**，不得作为任何阶段判读依据。
- 有效性证据改用 CDP `Page.startScreencast` 逐帧像素（见上级 `screencast/` 与 `violation-window/`，时间戳真实且与帧序列对齐）。

## 版本说明

- v1 关键帧逻辑：在采样结束后 `shot(page)` → 无效。
- v2 关键帧逻辑：同一轮序列内同步 CDP screencast → 像素帧相对触发点时间戳真实、违规窗口标记明确（恰当前返工交付）。

编制：2026-09-08 · P0 变更集7