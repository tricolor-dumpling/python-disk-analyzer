# API 契约参考

**权威声明**：本文件是给人读的摘要。**机器可执行的契约事实源是
`tests/test_api_contract.py`**（`app.test_client()` 直连，逐键比对）——两者冲突时**以测试为准**，
并应立即修正本文件。

> 分工：**路由与端点清单**（有哪些接口、各自作用）在 [`docs/代码地图.md`](代码地图.md) 第 2 节；
> 本文件只讲**响应形状、错误码与状态约定**，不复述端点表。

---

## 1. 三条不可违反的契约红线

1. **`additive` 只增不改**：新增字段必须**追加**，不得改动或删除既有键。既有响应键集合被测试逐个冻结，
   漂移即红（例：`/api/health` 就绪形态恒为 `{ok, ready, dll, message}`）。
2. **错误响应一律 JSON**，绝不返回 HTML：404/405 由 `@app.errorhandler` 统一 JSON 化
   （沿用旧形态 `{ok:false, error}`），未知接口也是 JSON。
3. **写入类接口必须过白名单**：`/api/settings` 只接受 `auto_save` / `last_roots` / `theme`，
   投毒键与类型不符一律 400 且**不落盘**（`everything_*` 等后端键被显式剔除）。

---

## 2. 错误体形态（三种，前端双向容忍）

| 形态 | 键集合 | 出现场景 |
|---|---|---|
| 旧形态 | `{ok, error}` | 缺参 400、404 接口不存在、405 方法不允许、compare 参数错误 |
| 扩展形态 | `{ok, error, code?, detail?, ...extra}` | 类型化错误（如 Everything IPC 失败 → `502` + 码表文案） |
| 降级形态 | `{ok:true, ...}` + `launched:false` 之类 | 「失败但不报错」的可降级动作（如定位文件时 Popen 失败） |

- `code` 既可为数字（Everything 错误码），也可为稳定字符串标识（如 `machine_mismatch`）。
- **不出裸错误码**：面向用户的文案一律经 `messages.render_everything_error()` 渲染。

## 3. Everything 错误码 → 文案（`messages.EVERYTHING_ERROR_TEXT`）

| 码 | 类别 | 用户文案 |
|---|---|---|
| 0 | ok | 查询成功 |
| 1 | memory | Everything 内存不足，请重启 Everything |
| 2 | ipc | 无法连接 Everything（未运行或权限不足） |
| 3 | register | Everything 内部注册失败，请重装/重启 Everything |
| 4 | window | Everything 内部窗口创建失败，请重启 Everything |
| 5 | thread | Everything 内部线程创建失败，请重启 Everything |
| 6 | index | Everything 索引无效，请重建索引 |
| 7 | call | Everything 调用顺序错误，请重启 Everything |

未知码回退为「Everything 查询出错（错误码 N），请重启 Everything 后重试」，**不暴露裸码**。
其中**码 2（IPC 未连接）是健康探测与前台浏览的核心分支**，见 `docs/排查手册.md`。

## 4. HTTP 状态约定

| 状态 | 含义与典型场景 |
|---|---|
| 200 | 成功；含「成功但降级」的情形（如 `launched:false`） |
| 202 | 已受理异步作业：`/api/compare` 无缓存时返回 `{job_id, status:"scanning"}`，改用 `/api/compare/status` 轮询 |
| 400 | 参数/载荷非法：缺参、`root` 指向文件而非目录、设置键不在白名单、类型不符 |
| 403 | Host 白名单拒绝（防 DNS rebinding，见 `docs/排查手册.md`） |
| 404 | 接口不存在，或基线快照/资源不存在 |
| 405 | 方法不允许（如对只读接口用 POST） |
| 409 | 资源忙/状态冲突：SDK 锁被占用、扫描中禁止删除快照、扫描中导出无结果 |
| 502 | 类型化上游错误：Everything 查询失败（IPC 等） |

## 5. 字段归属速查（`components/snapshot-view.js` 等前端断言面共用）

| 端点 | 冻结键集合（**测试逐键比对**） |
|---|---|
| `GET /api/health`（就绪） | `{ok, ready, dll, message}` |
| `GET /api/roots` | `{ok, roots, count, drives_source}`；每项另有固定形状 |
| `GET /api/settings` | `{ok, settings, data_dir, snapshots_dir}` |
| `POST /api/fullscan/stop` | `{ok, stopped, ...}`（空闲时幂等，同样 200） |
| `GET /api/series` | `{ok, root, path, depth, limit, count, truncated, dropped, rows_total, elapsed_ms, reason, points, skipped}` |
| `GET /api/series` → `points[]` | `{snapshot, name, created_at, auto, machine_guid, bytes, present, rows, cached}` |
| `POST /api/compare` → `report` | 键集合冻结（含 additive `legacy_count`） |
| `GET /api/snapshots` | 会话含 additive `total_by_root`（**前端据此判「会话是否有内容」，缺失即被判空隐藏**） |

**`total_by_root` 是跨端命门**：`session.py` 清单字段 + additive `total_by_root` 共同决定
快照页列表 / 日历 / 对比基准是否显示；夹具照抄时漏掉它会造成 A15/A17/A18/A20 连锁红
（详见 `AGENTS.md` 第 7 节第 6 条）。

## 6. 契约变更流程

1. 改路由或响应字段 → 先改 `tests/test_api_contract.py`（键集合显式列出，不要用「包含」弱断言）；
2. 跑 `.venv\Scripts\python.exe -m pytest tests/test_api_contract.py -q` 确认新契约成立、旧契约不破；
3. 同步本文件第 5 节与 [`docs/代码地图.md`](代码地图.md) 第 2 节「接口与命令」；
4. 若改动影响前端断言面 → 同步 `tests/web/smoke.html` 对应断言（见 `AGENTS.md` 第 7 节）。
