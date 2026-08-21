"""Everything SDK 高速扫描模块（C3 拆分自 main.py）。

职责：
- 扫描常量（MAX_FILES_PER_DIR/SCAN_PROGRESS_REFRESH_INTERVAL）；
- 目录深度排序键（_dir_sort_key）、扫描根判定（_is_scan_root）；
- 惰性 contents（LazyContents/_build_lazy_contents，有界缓存、按需构建）；
- 扫描主流程（scan_via_everything_sdk）。

SDK 依赖全部通过 sdk 模块访问（sdk.load_everything_sdk/sdk.DLL_PATH/各类
EVERYTHING_* 常量）；其中 sdk.DLL_PATH 是跨模块共享的可变全局——scan 在未
回填时自行解析并写回 sdk.DLL_PATH，env 启动检查后也会回填它，双方都读写
同一份状态。依赖方向：本模块只依赖 utils/sdk；不依赖 env/tui/cli/main。
"""

import ctypes
import heapq
import os
from collections import defaultdict
from pathlib import Path

from utils import log
import sdk

MAX_FILES_PER_DIR = 50
# Everything 扫描进度刷新间隔（按处理的记录条数计）
SCAN_PROGRESS_REFRESH_INTERVAL = 10000


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


def scan_via_everything_sdk(root_path_obj):
    """使用 Everything SDK 高速扫描指定路径，返回 (sizes, contents)"""
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
        raise RuntimeError(f"Everything查询失败: {everything.Everything_GetLastError()}")

    num_results = everything.Everything_GetNumResults()
    log(f"📈 Everything 返回 {num_results:,} 条记录")

    if num_results == 0:
        return {}, {}

    root_str = str(root_path_obj).rstrip("\\")
    root_lower = root_str.lower()
    root_prefix = root_lower + "\\"

    sizes = defaultdict(int)
    folder_files = defaultdict(list)
    folder_subdirs = defaultdict(set)

    buffer = ctypes.create_unicode_buffer(sdk.FULL_PATH_BUFFER_CHARS)
    file_size = ctypes.c_ulonglong()

    processed = 0
    refresh_interval = SCAN_PROGRESS_REFRESH_INTERVAL
    last_refresh = 0

    # 第一阶段：收集文件大小，同时为每个目录保留最大的若干文件，避免 UI 占用过多内存。
    log("📥 正在读取文件结果并统计目录直接占用...")
    for i in range(num_results):
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

        everything.Everything_GetResultSize(i, file_size)
        size = file_size.value
        if size <= 0:
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
    final_sizes = {Path(k): v for k, v in sizes.items()}
    contents = _build_lazy_contents(final_sizes, folder_files, folder_subdirs)
    return final_sizes, contents