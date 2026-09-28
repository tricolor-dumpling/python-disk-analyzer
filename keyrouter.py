"""键位路由（KeyRouter）模块：键位注册表与纯函数按键分发（任务 D2）。

单一事实来源：键位注册表 KEY_BINDINGS 同时驱动 tui 交互界面的按键分发与
「操作指引」文案（help_text 由注册表自动生成），键位/帮助/状态栏文案同源，
防止漂移。

内容：
- ACT_*：模块级字符串动作常量。全部动作均已注册进 KEY_BINDINGS：移动
  （w/s/↑/↓）、Enter 进入、Backspace 返回、C 换根、r 轻刷、R 深刷、/ 跳转、
  S 保存快照、H 历史对比、h 全屏帮助、Q 退出（D8 起 S/H/h 落地注册；
  help_text 由注册表自动生成，无需手改）。
  注意：S（大写）已自「下移」键位拆出为「保存快照」——小写 s 仍为下移，
  大写 S 为保存（KeyRouter 大小写同键照实分别列出，冻结表与现状在 D8 统一）；
- KEY_BINDINGS：每个条目一个 dict，字段固定为 name/action/keys/display/help，
  keys 为该动作的全部字节序列（单字节键 + 0xe0/0x00 前缀扩展键的 1-2 字节序列，
  大小写同键照实列出，如 b'w'/b'W'、b'\\xe0H'/b'\\x00H'）；
- FORBIDDEN_KEYS：禁键黑名单，按字节序列建模（精确字节序列 + (b'\\x00',)
  前缀通配 = Alt+任意；部分代码页下 Alt 组合与扩展键首字节均为 0x00）；
- key_to_action：纯函数，匹配顺序 = 注册键优先 → 黑名单 → 一律 ACT_NONE。
  0x00 前缀在部分代码页下同时是扩展方向键前缀（0x00H=上、0x00P=下），注册键
  优先保证方向键不受 Alt 通配误伤，行为与 TUI 历史实现完全一致。

已知限制：
- Ctrl+M（0x0D）与 Enter 字节完全相同、不可区分，按注册的 Enter 处理，故不
  列入黑名单（列入也无法拦截，只会破坏 Enter 进入功能）；
- 部分代码页下 Alt+字母 可能以「裸字母单字节」到达，与普通按键不可区分，
  黑名单只能拦截 0x00 前缀形式；
- F1-F12 以「0x00/0xe0 前缀 + 扫描码」两种字节序列建模（F1-F10=0x3B-0x44、
  F11/F12=0x85/0x86）。
"""

# ----------------【动作常量：模块级字符串常量】----------------
# 现有动作
ACT_MOVE_UP = "move_up"            # w/W/↑（0xe0H/0x00H）
ACT_MOVE_DOWN = "move_down"        # s/S/↓（0xe0P/0x00P）
ACT_ENTER = "enter"                # Enter（0x0D）进入目录
ACT_BACK = "back"                  # Backspace（0x08）返回上级
ACT_CHANGE_ROOT = "change_root"    # C 切换扫描路径
ACT_REFRESH_LIGHT = "refresh_light"    # r 轻刷（D4 起注册）
ACT_REFRESH_DEEP = "refresh_deep"      # R 深刷（D4 起注册）
ACT_PATH_JUMP = "path_jump"            # / 跳转（D5 起注册）
ACT_QUIT = "quit"                  # Q 退出
# 预留动作常量（D8 起 S/H/h 全部注册进 KEY_BINDINGS 落地，见注册表条目）
ACT_SAVE_SNAPSHOT = "save_snapshot"    # S 保存快照（大写 S；小写 s 保持下移）
ACT_HISTORY = "history"                # H 历史对比
ACT_HELP = "help"                      # h 全屏帮助
ACT_NONE = "none"                      # 未知/禁用键

# ----------------【键位注册表：单数据结构描述全部已注册键位】----------------
# 每个条目字段：
#   name    键位名称（供阅读/日志）
#   action  动作名（ACT_* 常量，key_to_action 的返回值）
#   keys    该动作的全部字节序列（bytes，1 或 2 字节；大小写照实分别列出）
#   display 帮助文案中的键位展示（与原始「操作指引」行风格一致）
#   help    帮助文案动作说明
KEY_BINDINGS = (
    {
        "name": "光标上移",
        "action": ACT_MOVE_UP,
        "keys": (b"w", b"W", b"\xe0H", b"\x00H"),
        "display": "W/↑",
        "help": "上移",
    },
    {
        "name": "光标下移",
        "action": ACT_MOVE_DOWN,
        "keys": (b"s", b"\xe0P", b"\x00P"),
        "display": "s/↓",
        "help": "下移",
    },
    {
        "name": "进入目录",
        "action": ACT_ENTER,
        "keys": (b"\r",),
        "display": "Enter",
        "help": "进入目录",
    },
    {
        "name": "返回上级",
        "action": ACT_BACK,
        "keys": (b"\x08",),
        "display": "Backspace",
        "help": "返回上级",
    },
    {
        "name": "切换扫描路径",
        "action": ACT_CHANGE_ROOT,
        "keys": (b"c", b"C"),
        "display": "C",
        "help": "切换扫描路径",
    },
    {
        "name": "轻量刷新",
        "action": ACT_REFRESH_LIGHT,
        "keys": (b"r",),
        "display": "r",
        "help": "轻刷",
    },
    {
        "name": "深度刷新",
        "action": ACT_REFRESH_DEEP,
        "keys": (b"R",),
        "display": "R",
        "help": "深刷",
    },
    {
        "name": "路径跳转",
        "action": ACT_PATH_JUMP,
        "keys": (b"/",),
        "display": "/",
        "help": "跳转",
    },
    {
        "name": "保存快照",
        "action": ACT_SAVE_SNAPSHOT,
        "keys": (b"S",),
        "display": "S",
        "help": "保存快照",
    },
    {
        "name": "历史对比",
        "action": ACT_HISTORY,
        "keys": (b"H",),
        "display": "H",
        "help": "历史对比",
    },
    {
        "name": "全屏帮助",
        "action": ACT_HELP,
        "keys": (b"h",),
        "display": "h",
        "help": "帮助",
    },
    {
        "name": "退出",
        "action": ACT_QUIT,
        "keys": (b"q", b"Q"),
        "display": "Q",
        "help": "退出",
    },
)

# ----------------【禁键黑名单：按字节序列建模】----------------
# 键 = 精确字节序列（bytes）；(b'\x00',) 为前缀通配：0x00 + 任意第二字节 =
# Alt+任意（部分代码页下 Alt 组合首字节为 0x00）。值 = 说明文案。
# 匹配顺序由 key_to_action 保证：注册键优先于黑名单，故 0x00H/0x00P 方向键
# 不受 Alt 通配误伤。
FORBIDDEN_KEYS = {
    # 精确字节序列
    b"\x03": "Ctrl+C",
    b"\x1a": "Ctrl+Z",
    b"\x16": "Ctrl+V",
    b"\t": "Tab",
    b"\x00\x00": "Ctrl+Break",
    # F1-F12：0x00/0xe0 前缀 + 扫描码（F1-F10=0x3B-0x44，F11/F12=0x85/0x86）
    b"\x00\x3b": "F1",
    b"\xe0\x3b": "F1",
    b"\x00\x3c": "F2",
    b"\xe0\x3c": "F2",
    b"\x00\x3d": "F3",
    b"\xe0\x3d": "F3",
    b"\x00\x3e": "F4",
    b"\xe0\x3e": "F4",
    b"\x00\x3f": "F5",
    b"\xe0\x3f": "F5",
    b"\x00\x40": "F6",
    b"\xe0\x40": "F6",
    b"\x00\x41": "F7",
    b"\xe0\x41": "F7",
    b"\x00\x42": "F8",
    b"\xe0\x42": "F8",
    b"\x00\x43": "F9",
    b"\xe0\x43": "F9",
    b"\x00\x44": "F10",
    b"\xe0\x44": "F10",
    b"\x00\x85": "F11",
    b"\xe0\x85": "F11",
    b"\x00\x86": "F12",
    b"\xe0\x86": "F12",
    # 前缀通配：Alt+任意（第二字节任意）
    (b"\x00",): "Alt+任意（0x00 前缀，第二字节任意）",
}


def _is_forbidden(key_bytes):
    """黑名单判定：精确序列命中，或 (b'\\x00',) 前缀通配命中（2 字节键）。"""
    if key_bytes in FORBIDDEN_KEYS:
        return True
    return len(key_bytes) == 2 and (key_bytes[:1],) in FORBIDDEN_KEYS


def key_to_action(key_bytes, state=None):
    """纯函数按键路由：原始按键字节序列 -> 动作名（ACT_* 字符串）。

    入参 key_bytes：单字节键或扩展键的 1-2 字节序列（如 b'w'、b'\\xe0H'、
    b'\\x00P'、b'\\x03'），由调用方（tui 按键读取）负责组装前缀。
    规则：
    - 注册键优先：大小写同键（b'w' 与 b'W'）映射到同一动作；
    - 已知但禁用的黑名单键返回 ACT_NONE（不被执行）；
    - 其余未知键一律返回 ACT_NONE。
    state 参数预留（未来上下文相关的键位，如状态栏模式下的按键），当前不使用。
    """
    for entry in KEY_BINDINGS:
        if key_bytes in entry["keys"]:
            return entry["action"]
    # 黑名单与未知键都归 ACT_NONE；显式两步仅为表达「已知但禁用」的语义
    if _is_forbidden(key_bytes):
        return ACT_NONE
    return ACT_NONE


def help_text():
    """由 KEY_BINDINGS 自动生成「操作指引」一行文案（键位/文案同源防漂移）。

    新增/调整键位只需改注册表，文案自动跟随，杜绝手工硬编码导致的漂移。
    """
    segments = [
        "[%s] %s" % (entry["display"], entry["help"])
        for entry in KEY_BINDINGS
    ]
    return "操作指引: " + " | ".join(segments)


__all__ = [
    "KEY_BINDINGS",
    "FORBIDDEN_KEYS",
    "key_to_action",
    "help_text",
    "ACT_MOVE_UP",
    "ACT_MOVE_DOWN",
    "ACT_ENTER",
    "ACT_BACK",
    "ACT_CHANGE_ROOT",
    "ACT_QUIT",
    "ACT_REFRESH_LIGHT",
    "ACT_REFRESH_DEEP",
    "ACT_PATH_JUMP",
    "ACT_SAVE_SNAPSHOT",
    "ACT_HISTORY",
    "ACT_HELP",
    "ACT_NONE",
]