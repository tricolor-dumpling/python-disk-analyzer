"""Everything SDK 高速扫描模块（C3 拆分自 main.py）。

职责：
- 扫描常量（MAX_FILES_PER_DIR/SCAN_PROGRESS_REFRESH_INTERVAL）；
- 目录深度排序键（_dir_sort_key）、扫描根判定（_is_scan_root）；
- 惰性 contents（LazyContents/_build_lazy_contents，有界缓存、按需构建）；
- 扫描主流程（scan_via_everything_sdk）；
- D4 两级刷新：指纹探测（compute_fingerprint/FINGERPRINT_CACHE/fingerprints_equal/
  clear_fingerprint_cache）、轻刷（light_refresh，不触碰 sizes/contents）、
  深刷包装（deep_refresh/ScanCancelledError，支持取消事件）。

SDK 依赖全部通过 sdk 模块访问（sdk.load_everything_sdk/sdk.DLL_PATH/各类
EVERYTHING_* 常量）；其中 sdk.DLL_PATH 是跨模块共享的可变全局——scan 在未
回填时自行解析并写回 sdk.DLL_PATH，env 启动检查后也会回填它，双方都读写
同一份状态。依赖方向：本模块只依赖 utils/sdk；不依赖 env/tui/cli/main。
"""

import ctypes
import heapq
import os
import time
from collections import defaultdict
from pathlib import Path

from utils import log
import sdk
from exceptions import EverythingQueryError

MAX_FILES_PER_DIR = 50
# Everything 扫描进度刷新间隔（按处理的记录条数计）
SCAN_PROGRESS_REFRESH_INTERVAL = 10000

# ------------【P12·W1.1 大小未知哨兵过滤】------------
# Everything 对「大小未知」的记录返回 2^64-1 哨兵值；历史实现裸读该值并把它当
# 真实字节数聚合，导致概览出现天文数字。W1.1 起主扫描与轻刷统一经
# read_result_size/_classify_result_size 收口：BOOL 失败、哨兵、超上限一律滤除。
SIZE_UNKNOWN_SENTINEL = 0xFFFFFFFFFFFFFFFF   # 2^64-1，Everything「大小未知」哨兵
SIZE_UNKNOWN_MAX_BYTES = 16 * 1024 ** 4      # 16TB 兜底上限（取不到卷容量时使用）
# 注意：该阈值与 snapshots._LEGACY_SIZE_THRESHOLD / compare._LEGACY_SIZE_THRESHOLD
# 三处同值（依赖方向不允许互 import，tests.test_compare 强制同值防漂移）。


class SizeMap(dict):
    """sizes 聚合产物容器（plain dict 子类）。

    W1.1 零破坏传出通道：`(sizes, contents)` 二元组契约冻结，unknown 计数以
    ``sizes.unknown_size_count`` 属性附加（additive）；plain dict 不支持属性
    赋值，故用子类承载。既有按 dict 使用 sizes 的调用方不受任何影响。
    """


class ScanCancelledError(Exception):
    """深刷被用户取消（Esc 置位 cancel_event）时由扫描主循环抛出。

    定义在本模块并 re-export（import scan 后经 scan.ScanCancelledError 使用），
    调用方（tui 深刷线程）捕获后显示「已取消」——不修改 exceptions.py。
    """


# ------------【D4 指纹门：缓存与阈值常量】------------
# 指纹缓存：root 规范化路径 str -> (fingerprint dict, computed_at 时间戳)。
# 模块级可变全局；compute_fingerprint 写入，clear_fingerprint_cache() 清空，
# 测试可经 scan.FINGERPRINT_CACHE 读写（tui 读取同一份状态）。
FINGERPRINT_CACHE = {}
# 指纹 60 秒冷却：命中缓存且未过期（now - computed_at < TTL）直接返回缓存。
FINGERPRINT_CACHE_TTL = 60.0
# 目录计数遍历门：结果数 ≤ 50 万才逐条 IsFolderResult 计数（耗时可控），
# 超过则退化（dir_count=None + ok=False + FINGERPRINT_ERR_TOO_MANY）。
FINGERPRINT_MAX_COUNT = 500000
# 指纹探测失败时的内部 error_code（负数哨兵，区别于 Everything 错误码：
# 探测失败时 error_code 取 Everything_GetLastError()，此处仅本模块私有哨兵）。
FINGERPRINT_ERR_STAT_FAILED = -101   # os.stat 取根目录 mtime 失败
FINGERPRINT_ERR_QUERY_FAILED = -102  # SDK 查询/调用抛出意外异常
FINGERPRINT_ERR_TOO_MANY = -103      # 结果数超 FINGERPRINT_MAX_COUNT，dir_count 退化


def _dir_sort_key(p):
    """目录深度排序键：返回严格单调的深度度量（路径组件越多 ⇒ 深度越深）。

    不能只用反斜杠数量排序：盘符根 C:\\ 与一级子目录 C:\\Users 的反斜杠数
    相同（都是 1），无法保证父目录严格排在子目录之前；而 len(Path(p).parts)
    按路径组件计数，C:\\ 深度为 1、C:\\Users 深度为 2、C:\\Users\\a 深度为 3，
    UNC 根 \\\\server\\share 计为 1 个组件，其子目录同样逐层 +1。
    对任意合法目录 d，os.path.dirname(d) 恰好剥掉最后一个组件，父目录的
    parts 数严格少 1，因此本键严格单调：按它从深到浅（reverse=True）排序即
    严格拓扑序——任何目录 d 被处理时，其全部后代（parts 数更大）均已先处理
    并累加进 sizes[d]。
    """
    return len(Path(p).parts)


def _is_scan_root(d, root_path_obj):
    """判断路径 d（str，Everything 原样返回或 os.path.dirname 的产物）是否为扫描根本身。

    用 Path 相等比较（本程序仅运行于 Windows，Path 即 WindowsPath）：
    - 大小写不敏感：Path('C:/Users') == Path('c:/users') 成立；
    - 自动折叠尾随分隔符：Path('//srv/share/') 与 Path('//srv/share') 相等且 hash 相同，
      可同时覆盖 Everything 返回路径带/不带尾随反斜杠与 dirname 产物相反的两种形态；
    - 盘符根 C:/ 的 dirname 自映射为自身，也能被正确识别；
    - 普通子目录不会误判：根为 C:/Users 时，C:/Users/a 与之不相等。
    注意：d 只能是 Everything 返回的完整绝对路径（本函数仅接收该类路径）。
    """
    return Path(d) == root_path_obj


class LazyContents(dict):
    """按需构建的惰性 contents 映射（键为 Path，值为目录条目列表）。

    与旧的全量预构建字典对外行为完全一致：interactive_ui 通过
    contents.get(path, []) 访问，命中目录时按需构建并返回条目列表，未知目录
    返回 []（与旧实现缺失键返回默认值 [] 一致），绝不抛 KeyError。
    区别在于：条目列表只在被访问时才构建，且只缓存最近访问过的少量目录
    （有界缓存，超出上限时整体清空），任意时刻驻留的条目列表数量有上限，
    大磁盘扫描的内存峰值因此大幅下降。
    """

    def __init__(self, builder, max_cached=128):
        super().__init__()
        self._builder = builder
        self._max_cached = max_cached

    def __missing__(self, key):
        items = self._builder(key)
        if len(self) >= self._max_cached:
            self.clear()  # 有界缓存：超出上限即整体清空，保证驻留条目数有界
        self[key] = items
        return items

    def get(self, key, default=None):
        try:
            return self[key]
        except KeyError:
            return default

    @property
    def cache_size(self):
        """当前缓存的目录条目数量（只读，供测试与内存观测）。"""
        return len(self)


def _build_lazy_contents(dir_sizes, folder_files, folder_subdirs):
    """构建惰性 contents：目录条目按需生成并缓存，取代旧的全量预构建。

    与旧算法对单个目录执行的步骤逐字一致：先追加子目录 (subdir, True, size)
    （size 取自 dir_sizes，缺失为 0），再按大小倒序追加文件 (filename, False,
    size)，最后整体 items.sort(key=lambda x: x[2], reverse=True) 稳定排序——
    稳定排序保证同 size 时后加入的记录不越过先加入的，因此同 size 的子目录
    （先加入）必然排在文件（后加入）之前，与旧 contents 完全一致。

    关键点：folder_files/folder_subdirs/sizes 的键是 Everything 原样返回的
    str 路径，大小写可能与用户输入不同，直接按 str 键查找会大小写失配；
    这里统一把键转换为 Path（Path 相等大小写不敏感、折叠尾随分隔符）后再用，
    子目录 child 以 folder / subdir 构造后查 dir_sizes。
    不在任何结构里的未知目录返回 []，与旧实现缺失键 .get() 返回 [] 一致。
    """

    path_files = {Path(k): v for k, v in folder_files.items()}
    path_subdirs = {Path(k): v for k, v in folder_subdirs.items()}

    def builder(folder):
        items = []
        for subdir in path_subdirs.get(folder, ()):
            child = folder / subdir
            items.append((subdir, True, dir_sizes.get(child, 0)))
        for size, filename in sorted(path_files.get(folder, ()), reverse=True):
            items.append((filename, False, size))
        items.sort(key=lambda x: x[2], reverse=True)
        return items

    return LazyContents(builder)


# ==============【P12·W1.1 大小未知过滤：统一读取收口】==============

# 单条结果大小分类状态（_classify_result_size 返回值第一元素）
_SIZE_OK = "ok"                # 可信正整数大小
_SIZE_BOOL_FALSE = "bool_false"  # Everything_GetResultSize 返回 BOOL FALSE
_SIZE_SENTINEL = "sentinel"    # sz == SIZE_UNKNOWN_SENTINEL（「大小未知」哨兵）
_SIZE_OVER_CAP = "over_cap"    # sz > 卷容量/兜底上限（疑似脏索引数据）
_SIZE_ZERO = "zero"            # sz <= 0（沿用既有过滤口径，不计入 unknown）


def _volume_capacity_bytes(root):
    """返回 root 所在卷的总容量字节数；失败或非 Windows 返回 None。

    经 GetDiskFreeSpaceExW 取 lpTotalNumberOfBytes；任何异常一律收敛为 None，
    由调用方回退 SIZE_UNKNOWN_MAX_BYTES 兜底上限，绝不影响扫描主流程。
    """
    if os.name != "nt":
        return None
    try:
        kernel32 = ctypes.windll.kernel32
        total_bytes = ctypes.c_ulonglong(0)
        free_bytes = ctypes.c_ulonglong(0)
        ok = kernel32.GetDiskFreeSpaceExW(
            str(root), None, ctypes.byref(total_bytes), ctypes.byref(free_bytes)
        )
        if not ok:
            return None
        return int(total_bytes.value)
    except Exception:
        return None


def _classify_result_size(everything, index, volume_cap=None):
    """单条结果大小的可信性分类（W1.1 收口核心）。

    返回 (status, size)：status ∈ {_SIZE_OK/_SIZE_BOOL_FALSE/_SIZE_SENTINEL/
    _SIZE_OVER_CAP/_SIZE_ZERO}；仅 _SIZE_OK 时 size 为可信正整数，其余为 None。
    判定顺序：
    ① GetResultSize 先取 BOOL 返回值（历史实现忽略它）→ FALSE 记 bool_false；
    ② sz == SIZE_UNKNOWN_SENTINEL 恒滤（防脏索引）记 sentinel；
    ③ sz > cap 记 over_cap；cap = volume_cap（取到卷容量时），否则
       SIZE_UNKNOWN_MAX_BYTES（16TB）兜底；
    ④ sz <= 0 记 zero（沿用现行过滤）;
    ⑤ 其余为 ok。
    """
    sz = ctypes.c_ulonglong()
    ok = everything.Everything_GetResultSize(index, sz)
    if not ok:
        return _SIZE_BOOL_FALSE, None
    value = int(sz.value)
    if value == SIZE_UNKNOWN_SENTINEL:
        return _SIZE_SENTINEL, None
    cap = volume_cap if volume_cap is not None else SIZE_UNKNOWN_MAX_BYTES
    if value > cap:
        return _SIZE_OVER_CAP, None
    if value <= 0:
        return _SIZE_ZERO, None
    return _SIZE_OK, value


def read_result_size(everything, index, volume_cap=None):
    """读取第 index 条结果的可信大小；一切「不可信」形态返回 None（W1.1 契约）。

    - ① GetResultSize BOOL FALSE → None；
    - ② sz == SIZE_UNKNOWN_SENTINEL → None；
    - ③ sz > cap → None（cap 取卷容量，取不到用 SIZE_UNKNOWN_MAX_BYTES 兜底）；
    - ④ sz <= 0 → None（沿用现行过滤）；
    - ⑤ 其余返回 sz。
    主扫描与轻刷共用本收口，杜绝裸读哨兵值进入聚合。
    """
    status, size = _classify_result_size(everything, index, volume_cap)
    return size if status == _SIZE_OK else None


def scan_via_everything_sdk(root_path_obj, cancel_event=None, everything=None):
    """使用 Everything SDK 高速扫描指定路径，返回 (sizes, contents)。

    新增可选参数（默认 None 时行为与旧签名完全一致，不破坏既有调用方）：
    - everything：注入的 SDK 实例（测试/嵌入场景直传，跳过 DLL 加载）；
    - cancel_event：threading.Event，扫描主循环每 SCAN_PROGRESS_REFRESH_INTERVAL
      （10000）条检查一次，置位即抛 ScanCancelledError（深刷取消）。
    """
    if everything is None:
        if sdk.DLL_PATH is None:
            sdk.DLL_PATH = sdk.resolve_everything_dll()
        everything = sdk.load_everything_sdk(sdk.DLL_PATH, include_result_functions=True)
    log(f"🧩 正在加载 Everything SDK: {sdk.DLL_PATH}")

    raw_path = str(root_path_obj)
    if not raw_path.endswith("\\"):
        raw_path += "\\"

    log(f"📝 正在设置 Everything 查询条件: path:\"{raw_path}\"")
    everything.Everything_SetSearchW(f'path:"{raw_path}"')
    everything.Everything_SetRequestFlags(
        sdk.EVERYTHING_REQUEST_FULL_PATH_AND_FILE_NAME |
        sdk.EVERYTHING_REQUEST_SIZE
    )

    log("⏳ 正在等待 Everything 返回查询结果...")
    if not everything.Everything_QueryW(True):
        # P12·W1.3：换抛类型化异常（继承 RuntimeError，文案不变，兼容既有捕获）
        raise EverythingQueryError(everything.Everything_GetLastError())

    num_results = everything.Everything_GetNumResults()
    log(f"📈 Everything 返回 {num_results:,} 条记录")

    if num_results == 0:
        empty_sizes = SizeMap()
        empty_sizes.unknown_size_count = 0
        return empty_sizes, {}

    root_str = str(root_path_obj).rstrip("\\")
    root_lower = root_str.lower()
    root_prefix = root_lower + "\\"

    sizes = defaultdict(int)
    folder_files = defaultdict(list)
    folder_subdirs = defaultdict(set)

    buffer = ctypes.create_unicode_buffer(sdk.FULL_PATH_BUFFER_CHARS)

    processed = 0
    refresh_interval = SCAN_PROGRESS_REFRESH_INTERVAL
    last_refresh = 0

    # P12·W1.1：大小未知过滤计数与卷容量上限（每根取一次卷容量）
    unknown = 0
    volume_cap = _volume_capacity_bytes(root_path_obj)
    warned_over_cap_fallback = False  # 兜底分支警告只记一行，避免脏索引刷屏

    # 第一阶段：收集文件大小，同时为每个目录保留最大的若干文件，避免 UI 占用过多内存。
    log("📥 正在读取文件结果并统计目录直接占用...")
    for i in range(num_results):
        # D4 深刷取消：每 10000 条检查一次 cancel_event（i=0 处首先检查，
        # 已预置的取消信号立即生效，无需处理任何已有记录）。
        if cancel_event is not None and i % SCAN_PROGRESS_REFRESH_INTERVAL == 0 \
                and cancel_event.is_set():
            raise ScanCancelledError("深刷已由用户取消(Esc)")

        if i - last_refresh >= refresh_interval:
            percent = i * 100 // num_results
            log(f"\r处理中 {percent:3d}% ({i:,}/{num_results:,})", end="", flush=True)
            last_refresh = i

        if everything.Everything_IsFolderResult(i) or everything.Everything_IsVolumeResult(i):
            continue

        if not everything.Everything_GetResultFullPathNameW(i, buffer, sdk.FULL_PATH_BUFFER_CHARS):
            continue

        full_path = buffer.value
        if not full_path:
            continue

        full_path_lower = full_path.lower()
        if full_path_lower != root_lower and not full_path_lower.startswith(root_prefix):
            continue

        # W1.1 收口：BOOL FALSE / 哨兵 / 超上限 / ≤0 一律不进聚合；
        # 除已知 0 字节外均计入 unknown（「N 条大小未知」）。
        status, size = _classify_result_size(everything, i, volume_cap)
        if status != _SIZE_OK:
            if status != _SIZE_ZERO:
                unknown += 1
                if status == _SIZE_OVER_CAP and volume_cap is None and not warned_over_cap_fallback:
                    warned_over_cap_fallback = True
                    log(
                        "⚠️ 无法取得卷容量，按 16TB 兜底上限过滤超限大小值"
                        "（疑似 Everything 脏索引，建议重建索引后重扫）"
                    )
            continue

        parent_dir = os.path.dirname(full_path)
        sizes[parent_dir] += size

        heap = folder_files[parent_dir]
        item = (size, os.path.basename(full_path))
        if len(heap) < MAX_FILES_PER_DIR:
            heapq.heappush(heap, item)
        elif size > heap[0][0]:
            heapq.heapreplace(heap, item)

        processed += 1

    log(f"\r处理中 100% ({num_results:,}/{num_results:,})")

    # 第二阶段：根据文件所在目录补全父子目录关系。
    log("🌲 正在构建目录树...")
    all_dirs = set(sizes.keys())
    for d in list(all_dirs):
        current = d
        while True:
            parent = os.path.dirname(current)
            if parent == current or current.lower() == root_lower:
                break
            folder_subdirs[parent].add(os.path.basename(current))
            all_dirs.add(parent)
            current = parent

    # 第三阶段：自底向上汇总，使父目录大小包含全部子目录。
    log("🧮 正在汇总父目录占用...")
    sorted_dirs = sorted(all_dirs, key=_dir_sort_key, reverse=True)
    for d in sorted_dirs:
        # 扫描根不向其之上传播：若 d 即根本身则跳过向上累加，避免在 sizes 中
        # 凭空创建扫描根之上的祖先键（如根为 C:\Users 时不再出现 C:\ 键）。
        # 根目录自身仍保留在 sizes/contents 中，仅禁止向更上层汇总。
        if _is_scan_root(d, root_path_obj):
            continue
        parent = os.path.dirname(d)
        if parent != d:
            sizes[parent] += sizes[d]

    cached_files = sum(len(v) for v in folder_files.values())
    log(f"📦 UI缓存文件数: {cached_files:,}")

    # 惰性 contents：不再为所有目录预构建条目列表（条目元组与 folder_files/
    # folder_subdirs 数据重复驻留是大磁盘扫描后的内存大头），改为按需构建 +
    # 有界缓存：交互界面逐级浏览时只按需构建并缓存当前目录的条目。
    log("🧱 正在准备交互界面数据（惰性模式：按需构建）...")
    final_sizes = SizeMap({Path(k): v for k, v in sizes.items()})
    # P12·W1.1 零破坏传出通道（RT-04 固化）：(sizes, contents) 二元组契约冻结，
    # unknown 计数以 dict 属性附加（additive），六处解包调用方不受影响。
    final_sizes.unknown_size_count = unknown
    contents = _build_lazy_contents(final_sizes, folder_files, folder_subdirs)
    return final_sizes, contents


# =================【D4 指纹门：compute_fingerprint 系列】================


def fingerprint_key(root_path_obj):
    """规范化根路径作为 FINGERPRINT_CACHE 键。

    大小写折叠（normcase）+ 绝对化 + 分隔符/尾斜杠折叠（Path 归一化），保证
    tui 读缓存与 scan 写缓存使用完全一致的键（盘符根 C:\\ 自带尾斜杠，不被
    剥离，键仍唯一）。
    """
    return os.path.normcase(os.path.abspath(str(Path(root_path_obj))))


def _compute_fingerprint_uncached(root_path_obj, everything=None):
    """单次指纹探测（不经缓存），返回指纹 dict。

    返回字段：file_count（int，默认查询结果数）、dir_count（int，目录计数；
    结果超 FINGERPRINT_MAX_COUNT 时退化为 None）、root_mtime（float|None，
    os.stat 取根目录 mtime）、ok（bool，整体探测是否成功）、error_code
    （int|None；Everything 错误码或本模块私有负哨兵）。
    口径说明：指纹用于「数据未变」门控比较，只要求口径跨调用一致且对根内容
    变化敏感——file_count 取 path:"<root>" 查询结果数（按 SDK 默认口径，其中
    是否含目录由 Everything 决定），dir_count 在结果集 ≤50 万时逐条
    IsFolderResult 计数，root_mtime 覆盖「同名替换/原地改目录条目」等计数
    不变但内容变化的场景。任何一步失败 → ok=False，由调用方（tui）友好降级，
    绝不崩溃；本函数不触发强制重建索引（只走 IPC 查询）。
    """
    result = {
        "file_count": 0,
        "dir_count": 0,
        "root_mtime": None,
        "ok": True,
        "error_code": None,
    }
    try:
        result["root_mtime"] = os.stat(root_path_obj).st_mtime
    except OSError:
        result["root_mtime"] = None
        result["ok"] = False
        result["error_code"] = FINGERPRINT_ERR_STAT_FAILED
        return result
    if everything is None:
        if sdk.DLL_PATH is None:
            sdk.DLL_PATH = sdk.resolve_everything_dll()
        everything = sdk.load_everything_sdk(sdk.DLL_PATH, include_result_functions=True)
    try:
        raw_path = str(root_path_obj)
        if not raw_path.endswith("\\"):
            raw_path += "\\"
        everything.Everything_SetSearchW('path:"%s"' % raw_path)
        everything.Everything_SetRequestFlags(sdk.EVERYTHING_REQUEST_FULL_PATH_AND_FILE_NAME)
        if not everything.Everything_QueryW(True):
            result["ok"] = False
            result["error_code"] = everything.Everything_GetLastError()
            return result
        num_results = everything.Everything_GetNumResults()
        result["file_count"] = num_results
        if num_results <= FINGERPRINT_MAX_COUNT:
            dir_count = 0
            for i in range(num_results):
                if everything.Everything_IsFolderResult(i):
                    dir_count += 1
            result["dir_count"] = dir_count
        else:
            # 结果超 50 万：全量遍历 IsFolderResult 计数不可行，退化不崩溃
            result["dir_count"] = None
            result["ok"] = False
            result["error_code"] = FINGERPRINT_ERR_TOO_MANY
        return result
    except Exception:
        # 任何 SDK 层意外（换 DLL/缺函数/异常返回）都收敛为 ok=False，调用方降级
        result["ok"] = False
        result["error_code"] = FINGERPRINT_ERR_QUERY_FAILED
        return result


def compute_fingerprint(root_path_obj, everything=None, force=False):
    """探测 root_path_obj 的指纹 dict（含 60 秒冷却缓存）。

    - 命中 FINGERPRINT_CACHE 且未过期（now - computed_at < FINGERPRINT_CACHE_TTL）
      时直接返回缓存（r@根「毫秒级返回」的依据），不重新查询；
    - force=True 跳过缓存强制重新探测（并刷新缓存）；
    - 结果统一写入 FINGERPRINT_CACHE（含 ok=False 的退化结果，语义见
      fingerprints_equal：探测失败恒判「不等」，由调用方升级深扫）。
    """
    key = fingerprint_key(root_path_obj)
    now = time.time()
    if not force:
        cached = FINGERPRINT_CACHE.get(key)
        if cached is not None:
            fingerprint, computed_at = cached
            if now - computed_at < FINGERPRINT_CACHE_TTL:
                return fingerprint
    fingerprint = _compute_fingerprint_uncached(root_path_obj, everything)
    FINGERPRINT_CACHE[key] = (fingerprint, now)
    return fingerprint


def fingerprints_equal(a, b):
    """两个指纹是否判定为「数据未变」。

    仅在双方均 ok=True 且 file_count/dir_count/root_mtime 三项一致时为 True；
    任一探测失败（ok=False）或缺失基线一律判 False —— 安全方向：指纹门
    探测失败时升级为深扫而非误报数据未变。
    """
    if a is None or b is None:
        return False
    if not a.get("ok") or not b.get("ok"):
        return False
    return (
        a.get("file_count") == b.get("file_count")
        and a.get("dir_count") == b.get("dir_count")
        and a.get("root_mtime") == b.get("root_mtime")
    )


def clear_fingerprint_cache():
    """清空全部根路径指纹缓存（换根/测试重置用）。"""
    FINGERPRINT_CACHE.clear()


# =================【D4 轻刷／深刷】================


def light_refresh(root_path_obj, current_dir, everything=None, top=50, stats=None):
    """轻刷 current_dir：path:"..." 单查询，返回至多 top 个直接子项（按大小倒序）。

    返回条目列表，结构与 contents 目录条目一致：[(name, is_dir, size), ...]；
    查询失败返回 None。不触碰 sizes/contents 全局结构（深刷才重建）。
    - root_path_obj 保持与深刷一致的签名（调用方透传），current_dir 决定查询范围；
    - path: 查询返回全部后代，这里按 dirname == current_dir 过滤只取直接子项；
    - 盘符根（C:\\）经 os.path.abspath 保留尾反斜杠，避免 rstrip 后与子项
      dirname（C:\\）失配；卷条目（驱动根自身）不进入结果，与深刷口径一致；
    - 已知限制：超大目录（后代极多）的客户端过滤不是毫秒级，巨目录请用深刷。
    - P12·W1.1：大小读取统一走 _classify_result_size 收口（BOOL FALSE/哨兵/
      超上限/≤0 不进入结果）；stats 传 dict 时写入 stats["unknown_size_count"]
      （被滤除的「大小未知」条数），返回值仍为 list，不破坏唯一调用方
      （tui._do_light_refresh）。
    """
    if everything is None:
        if sdk.DLL_PATH is None:
            sdk.DLL_PATH = sdk.resolve_everything_dll()
        everything = sdk.load_everything_sdk(sdk.DLL_PATH, include_result_functions=True)
    try:
        raw_path = str(current_dir)
        if not raw_path.endswith("\\"):
            raw_path += "\\"
        everything.Everything_SetSearchW('path:"%s"' % raw_path)
        everything.Everything_SetRequestFlags(
            sdk.EVERYTHING_REQUEST_FULL_PATH_AND_FILE_NAME | sdk.EVERYTHING_REQUEST_SIZE
        )
        if not everything.Everything_QueryW(True):
            return None
        num_results = everything.Everything_GetNumResults()
        # abspath 保留盘符根的尾反斜杠（C:\\ 的 dirname 是自身），普通目录形态不变
        parent_lower = os.path.normcase(os.path.abspath(str(current_dir)))
        buffer = ctypes.create_unicode_buffer(sdk.FULL_PATH_BUFFER_CHARS)
        entries = []
        unknown = 0
        volume_cap = _volume_capacity_bytes(current_dir)
        warned_over_cap_fallback = False
        for i in range(num_results):
            if everything.Everything_IsVolumeResult(i):
                continue  # 卷条目是驱动根自身，不是直接子项（与深刷 IsVolumeResult 跳过一致）
            is_dir = bool(everything.Everything_IsFolderResult(i))
            if not everything.Everything_GetResultFullPathNameW(i, buffer, sdk.FULL_PATH_BUFFER_CHARS):
                continue
            full_path = buffer.value
            if not full_path:
                continue
            if os.path.normcase(os.path.dirname(full_path)) != parent_lower:
                continue  # 只取直接子项：path: 查询会把后代目录里的文件也带回
            # W1.1 收口：与主扫描同口径过滤不可信大小
            status, size = _classify_result_size(everything, i, volume_cap)
            if status != _SIZE_OK:
                if status != _SIZE_ZERO:
                    unknown += 1
                    if status == _SIZE_OVER_CAP and volume_cap is None and not warned_over_cap_fallback:
                        warned_over_cap_fallback = True
                        log(
                            "⚠️ 无法取得卷容量，按 16TB 兜底上限过滤超限大小值"
                            "（疑似 Everything 脏索引，建议重建索引后重扫）"
                        )
                continue
            entries.append((size, (os.path.basename(full_path), is_dir, size)))
        entries.sort(key=lambda x: x[0], reverse=True)
        if stats is not None:
            stats["unknown_size_count"] = unknown
        return [item for _, item in entries[:top]]
    except Exception:
        return None


def deep_refresh(root_path_obj, cancel_event=None, everything=None):
    """深刷 = 重新执行全量扫描（等价 scan_via_everything_sdk），支持取消。

    - cancel_event（threading.Event）置位时，扫描主循环每 10000 条检查一次，
      置位即抛 ScanCancelledError（ScanCancelledError 从本模块 re-export）；
    - everything 可注入 SDK 实例（测试用），透传给 scan_via_everything_sdk；
    - 返回 (sizes, contents)，语义与 scan_via_everything_sdk 完全一致。
    """
    return scan_via_everything_sdk(root_path_obj, cancel_event=cancel_event, everything=everything)