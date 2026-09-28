# legacy 快照迁移指引

> **一句话职责**：回答「历史快照里那些 **≥ 16 TiB** 的『已知异常大小』数据是什么、要不要处理、怎么重建基线」。
> 不回答「快照文件格式怎么解析」（那是代码与 `README.md` 的事）。

| 属性 | 值 |
|---|---|
| 权威性 | 处理建议的**权威**（用户操作层面）；涉及阈值与字段名时以代码与测试为准 |
| 权威来源 | `scan.SIZE_UNKNOWN_SENTINEL` / `scan.SIZE_UNKNOWN_MAX_BYTES` / `snapshots._LEGACY_SIZE_THRESHOLD` / `compare._LEGACY_SIZE_THRESHOLD`；回归护栏 `tests/test_scan.py`、`tests/test_compare.py`、`tests/test_snapshot_golden.py` |
| 更新触发 | 阈值（16 TiB）变更、`legacy_*` / `unknown_size_count` 字段改名、重建方式（CLI 参数 / 环境变量）变更 |
| 唯一性声明 | 本文独占「legacy 数据的判定与处置流程」；**不重复**登记文件职责（见 `README.md`），**不重复**写字段响应形状（见 `docs/API 契约.md`） |

---

## 1. 这是什么问题

早期版本的扫描代码**裸读** Everything SDK 返回的大小值，而 Everything 对「大小未知」的记录返回
**哨兵值 `2^64-1`**（即 `18446744073709551615` 字节）。历史实现把这个天文数字当成真实字节数写进了快照，
于是在界面上表现为**某一行占用异常巨大（万亿 GB 级）**，并让**合计严重偏大**。

- 现行扫描已修：读取统一收口到 `scan._classify_result_size`，三类情况一律滤除——
  ① `GetResultSize` 返回 BOOL FALSE；② 等于哨兵 `2^64-1`；③ 超过上限
  （取得到卷容量时用卷容量，取不到时回退 `scan.SIZE_UNKNOWN_MAX_BYTES = 16 TiB`）。
- **但历史快照文件不会自动改写**：老快照里已经写进去的脏行仍在，读取时按
  `>= 16 TiB` 标记为「已知异常大小」（`snapshots._LEGACY_SIZE_THRESHOLD`，
  与 `compare._LEGACY_SIZE_THRESHOLD`、`scan.SIZE_UNKNOWN_MAX_BYTES` **三处同值**，由测试强制）。

> 阈值为什么是 16 TiB：它是「体积上限兜底」——单块盘不可能有这么巨大的单目录占用，
> 因而不可能是真实数据。所以**不要再往上调这个阈值**来「消掉提示」。

---

## 2. 两分钟自查：我的数据受影响吗

| 你想知道 | 看什么 | 出现什么说明受影响 |
|---|---|---|
| **本次扫描**有没有被滤掉的行 | 扫描结束后的摘要行「N 条大小未知」 | N > 0（本次扫描已安全滤除，只是提示你有多少条读不到大小） |
| **某份快照文件**有没有脏行 | `snapshots.read_snapshot()` 返回体的 `legacy_unknown_rows` | > 0 |
| **对比结果**是否可能失真 | 对比报告的 `legacy_count` | > 0 |

界面上的对应位置：

- **Web · 对比页**：基线含脏行时会前置一条 warn 横幅——
  「基线含 N 条已知异常大小数据，对比数字可能失真，建议重扫重建基线。」
- **Web · 扫描卡**：扫描过程与结束时透出「大小未知」计数。
- **TUI**：对比报告前会打印同一句提示（`tui.py` 读 `diff_result["legacy_count"]`）。

三者同源：都是同一批被滤除的行计数，只是层级不同（扫描过程 / 单份快照 / 对比两侧）。

---

## 3. 要不要处理：判断口径

| 情况 | 建议 |
|---|---|
| 旧快照的 `legacy_unknown_rows == 0` | **不用管**，数据是干净的 |
| 有脏行，但你只用它看「相对变化」 | 仍建议重建——脏行会同时进两侧合计，失真方向不可控 |
| 有脏行，且你用它的**绝对数值**做判断（清理决策、容量规划） | **必须重建**，否则数字没有参考价值 |
| 只有「已知异常大小」提示、但你从不对比历史 | 可以不管，等下次全盘扫描自然生成干净快照 |

**核心口径**：脏行不会被自动剔除，它只是被**标记**。标记的意义是让你知道
「这份基线的绝对数值不能信」，而不是让程序替你改数。

---

## 4. 怎么重建基线

重建 = **重新扫一次、存一份干净快照**，然后用新快照当基线。旧快照不必删（留着追溯）。

```powershell
# ① 重扫并保存快照（Web 形态：扫描卡 → 保存；TUI：按 S；或直接跑全量扫描）
python app.py                     # Web：扫描 → 保存快照

# ② 用新快照当基线做对比（CLI 非交互）
python main.py C:\ --baseline <新的 .snap.gz 路径>

# ③ 若基线来自另一台机器，还会被 machine_guid 拦下，需显式放行（数字仅供参考）
python main.py C:\ --baseline <路径> --allow-other-machine
```

要点：

- **新扫描结果本身是干净的**（哨兵在扫描阶段就被滤除），所以「重扫一次」就足以得到干净数据；
- 快照目录默认 `%LOCALAPPDATA%\PythonDiskScanner\snapshots\`，可用 `--snapshot-dir` /
  `DSA_SNAPSHOT_DIR` 覆盖；`DSA_NO_SNAPSHOT=1` 可整体禁用快照落盘（此时自动保存一并失效）；
- 删除历史快照**不是**必需步骤；确实要清理时走 Web 快照页的删除功能（扫描中会 409 拒绝）。

---

## 5. 常见误区

| 误区 | 事实 |
|---|---|
| 「16 TiB 是某个目录的真实占用」 | 不是。那是「大小读不到」被历史实现误当成真实字节数，或哨兵值的残留 |
| 「把阈值调大就不会有提示了」 | 提示消失 ≠ 数据变准。阈值是三处同值并被测试锁定，改动同时要过 `tests/test_compare.py` 的常量一致性护栏 |
| 「重扫会自动修正旧快照」 | 不会。旧快照是只读历史文件，新数据写进新快照 |
| 「脏行被滤除后合计依然含它」 | 现行扫描的合计不含被滤除行；受影响的是**历史快照**的合计 |
| 「`unknown_size_count` 和 `legacy_unknown_rows` 是一回事」 | 不是。前者是**本次扫描过程**被滤除的条数，后者是**某份快照文件**里的脏行数，后者只在读旧数据时 > 0 |

---

## 6. 相关文档与护栏

- 阈值与字段的代码事实源：`scan.py`（`SIZE_UNKNOWN_SENTINEL` / `SIZE_UNKNOWN_MAX_BYTES` / 分类收口）、
  `snapshots.py`（`_LEGACY_SIZE_THRESHOLD` / `read_snapshot`）、`compare.py`（`_LEGACY_SIZE_THRESHOLD` / `_count_legacy_rows`）。
- 回归护栏：`tests/test_scan.py`（哨兵、BOOL FALSE、超上限三类滤除）、`tests/test_compare.py`
  （三处阈值同值 + 两侧 legacy 计数）、`tests/test_snapshot_golden.py`（`legacy_unknown_rows` 读回）。
- 对比页横幅与 TUI 提示的契约位置见 [`docs/API 契约.md`](API%20契约.md) 与 [`docs/界面契约.md`](界面契约.md)。
