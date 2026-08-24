"""横幅文案模板资产。

模板 ID 是错误/状态文案的稳定标识；界面层只应通过 :func:`render_message`
获取最终展示文本，避免文案散落在业务代码中。
"""

# 横幅级别是故意使用不同字符串值的稳定数据标识。
BANNER_ERROR = "error"
BANNER_WARN = "warn"
BANNER_INFO = "info"


BANNER_TEMPLATES = {
    "E_NO_EVERYTHING_RUNNING": (
        BANNER_ERROR,
        "Everything 未运行，请先启动(按 r/R 重试)",
    ),
    "E_DB_NOT_READY": (
        BANNER_WARN,
        "索引未就绪，请稍后重试",
    ),
    "E_OUT_OF_ROOT": (
        BANNER_ERROR,
        "✗ 路径超出扫描根，按 C 换根后重试",
    ),
    "E_PATH_NOT_FOUND": (
        BANNER_ERROR,
        "✗ 路径不存在",
    ),
    "E_SCAN_FAILED": (
        BANNER_ERROR,
        "✗ 扫描失败: {reason}",
    ),
    "E_SNAPSHOT_INCOMPLETE": (
        BANNER_WARN,
        "已丢弃不完整快照，按 R 深扫可重建基线",
    ),
    "E_SCAN_IN_PROGRESS": (
        BANNER_WARN,
        "深扫进行中",
    ),
    "E_BUSY": (
        BANNER_WARN,
        "S 已在途：请稍后",
    ),
    "E_TERM_TOO_SMALL": (
        BANNER_WARN,
        "终端过小",
    ),
    "INFO_FINGERPRINT_SAME": (
        BANNER_INFO,
        "数据未变(计数未变)",
    ),
    "INFO_SNAPSHOT_SAVED": (
        BANNER_INFO,
        "快照已保存",
    ),
    "INFO_SNAPSHOT_AUTO": (
        BANNER_INFO,
        "已自动保存(今日 {count}/{limit})",
    ),
}


def render_message(template_id, **kwargs):
    """按模板 ID 渲染横幅文案。

    ``dict`` 下标访问会让未知 ID 自然抛出 ``KeyError``；字符串的
    ``format`` 会保留缺失占位符参数的标准异常行为。
    """
    _level, template = BANNER_TEMPLATES[template_id]
    return template.format(**kwargs)


def list_template_ids():
    """返回全部横幅模板 ID（按资产声明顺序）。"""
    return list(BANNER_TEMPLATES)
