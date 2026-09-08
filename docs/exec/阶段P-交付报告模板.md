# 阶段P<n> 交付报告

> 阶段：P<n>（<阶段名>）　日期：<YYYY-MM-DD>　分支：`stage-P<n>`
> 覆盖问题：<#1 #2 ...>　前置阶段：<P0 / P<n-1>>

---

## 一、范围与裁定

- **覆盖范围**：本阶段处理的用户问题、功能点、文档。
- **冻结口径（D<n>-*）**：本阶段开头冻结并写死的设计决策（若适用）。
- **用户/leader 裁定记录**：涉及用户原始材料处置、口径取舍等事项的裁定原文或摘要。
- **不在范围内的事项**：明确列出推到后续阶段的内容，避免歧义。

## 二、实现

| 变更集 | commit hash | 提交信息 | 涉及文件 |
|---|---|---|---|
| 1 | `<hash>` | `阶段P<n>变更集1：...` | `app.py` 等 |
| 2 | `<hash>` | `阶段P<n>变更集2：...` | ... |

- tag：`P<n>-<slug>` @ `<hash>`
- 生产代码改动面：`git diff main -- app.py web/ *.py` 输出（应仅含授权文件或为空）。

## 三、测试

门禁基线表（命令 / 实际数字 / 耗时 / 结论）：

| # | 命令 | 实际数字 | 耗时 | 结论 |
|---|---|---|---|---|
| 1 | `.venv\Scripts\python.exe -m unittest discover -s tests -t . -v` | `Ran N tests / OK-failed` | xs | 绿 / 既有挂账 / 回归 |
| 2 | `.venv\Scripts\python.exe -W error::ResourceWarning -m unittest discover -s tests -t .` | ... | ... | ... |
| 3 | `python -m py_compile app.py cli.py ...` | exit 0 | ... | ... |
| 4 | `node --test scripts/dev/*.test.mjs` | N pass / M fail | ... | ... |
| 5 | smoke（`http.server 8771` + `u22_smoke_probe v2`） | x/y | ... | ... |
| 6 | 验收探针 u50–u68d 全量 | ... | ... | ... |

- **断言变更理由**：任何断言面（测试/探针/夹具）被改动的，逐条说明「代码事实 + 旧断言为何不成立」；**禁止只改数字**。
- 既存挂账登记：`test_budget` 并发锁竞态复跑轮次与结果；Everything busy 口径；其它环境差异。

## 四、视觉验收

| 证据 | 绝对路径 | 视口 | 采样节奏 | 时间窗 | 量化数据 | Luna 判读结论 |
|---|---|---|---|---|---|---|
| ... | `D:/.../xxx.png` | 1366×768 | rAF ≈16.7ms/帧 | 触发前→动画+200ms | ... | PASS / FAIL / 待判读 |

- 帧序列/截图清单以 `manifest.json` 为准（每项含用途、节奏、时间窗、量化摘要）。
- 量化与 Luna 结论冲突时以量化采样为准，并记录差异原因。

## 五、遗留与挂账

| 项 | 说明 | 下一步 |
|---|---|---|
| ... | ... | ... |

## 六、回滚与进程清理

- **回滚**：`git revert` 或 `git reset --hard P<n>-<slug>`；回滚后重跑门禁最小集；数据层不随代码回滚。
- **清理前进程/端口清单**：

```text
# Get-NetTCPConnection -LocalPort 5000/8771 -State Listen
LocalPort  OwningProcess
5000       <PID>
8771       <PID>
# Get-Process python,node,chrome,chromium,Everything
Id  ProcessName  StartTime
...
```

- **清理动作**：仅停止本阶段自己启动的进程（Flask / 静态服务 / 探针）；Everything、用户 Edge 不触碰。
- **清理后进程/端口清单**：（同上命令，端口应无监听；Everything 保持原 PID）
- `%TEMP%` 自建产物清理清单。

---

*编制：<YYYY-MM-DD> · <执行代理> · 分支 `<stage-P<n>>` · tag `<P<n>-<slug>>`*