"""递归分类的路径工具，纯字符串逻辑，不碰数据库和 RPC。

多级分类用物化路径：`notes.category` 和 `categories.name` 都存 `工作/项目A/需求` 这样以 `/` 分隔的整条路径。
这把「无孤儿节点、无环」的完整性保证从数据库（邻接表有外键级联）挪到应用层，本模块就是那层保证。
好处是取子树是一次 `LIKE '工作/项目A/%'` 前缀扫，移动/重命名是一条前缀替换 UPDATE，无需递归 CTE。
硬性代价：单个分类名不能含 `/`。
"""

from __future__ import annotations

from typing import Optional

SEPARATOR = "/"

# 单段（一级分类名本身）的字符数上限。够长到能放下一句描述性的分类名，又不至于
# 让侧边栏的树完全没法读。
MAX_SEGMENT_CHARS = 60
# 层级深度上限，挡住路径字符串无限增长（每层重复存完整前缀）和 UI 按 depth * 16px 缩进后子分类被挤出可视区；16 层远超真实需求。
MAX_DEPTH = 16
# 整条路径的字符数上限。不是 MAX_SEGMENT_CHARS * MAX_DEPTH（那会允许一条近千
# 字符的路径），单独给一个更紧的值。
MAX_PATH_CHARS = 255


class CategoryPathError(Exception):
    """路径不合法。`code` 是前端翻译用的错误码（i18n errors 命名空间），`params` 补占位符值。
    不直接抛 errors.VaultError，是为让本模块（被 storage、service、classifier 调用）零内部依赖；调用方负责转成 VaultError。"""

    def __init__(self, code: str, **params):
        super().__init__(code)
        self.code = code
        self.params = params


def split_path(path: str) -> list[str]:
    """把路径拆成各级分类名，丢掉空段和两侧空白。宽松解析，不校验，供读取路径用（渲染树、分类器打分），
    遇到 `工作//项目A ` 这类脏数据也要给出合理结果而不是抛异常；写入前的严格校验走 validate_path。"""
    if not path:
        return []
    return [segment.strip() for segment in path.split(SEPARATOR) if segment.strip()]


def normalize_path(path: str) -> str:
    """把路径规整成规范形式（去空段、去每段两侧空白），如 `' 工作 //项目A/'` → `'工作/项目A'`；空路径规整为空字符串。"""
    return SEPARATOR.join(split_path(path))


def validate_path(path: str) -> str:
    """严格校验并返回规范化路径，不合法抛 CategoryPathError。所有写入路径的地方（新建分类、重命名、批量移动笔记目标）
    都必须过这一关，读取用宽松的 split_path/normalize_path。空字符串合法，代表未分类，强制分类会逼用户建垃圾桶分类。"""
    if path is None:
        raise CategoryPathError("notes.category_name_required")
    stripped = path.strip()
    if not stripped:
        return ""

    if len(stripped) > MAX_PATH_CHARS:
        raise CategoryPathError("notes.category_path_too_long", limit=MAX_PATH_CHARS, actual=len(stripped))

    # 刻意不用 split_path 的宽松解析：写入时 `工作//项目A` 是输入错误，应当面指出，静默修好会让用户下次继续这么输。
    raw_segments = stripped.split(SEPARATOR)
    if len(raw_segments) > MAX_DEPTH:
        raise CategoryPathError("notes.category_too_deep", limit=MAX_DEPTH, actual=len(raw_segments))

    segments: list[str] = []
    for raw in raw_segments:
        segment = raw.strip()
        if not segment:
            raise CategoryPathError("notes.category_empty_segment")
        if len(segment) > MAX_SEGMENT_CHARS:
            raise CategoryPathError(
                "notes.category_segment_too_long", limit=MAX_SEGMENT_CHARS, actual=len(segment), segment=segment
            )
        segments.append(segment)

    return SEPARATOR.join(segments)


def parent_paths(path: str) -> list[str]:
    """路径的所有祖先路径，从浅到深，不含自己，如 `'工作/项目A/需求'` → `['工作', '工作/项目A']`。
    创建分类时用它幂等补建每级父分类，否则会出现只被前端从路径推断出的幽灵节点（categories 表没有这一行），对其操作行为怪异。"""
    segments = split_path(path)
    return [SEPARATOR.join(segments[: i + 1]) for i in range(len(segments) - 1)]


def parent_of(path: str) -> str:
    """直接父路径；顶级分类返回空字符串（代表"未分类"）。"""
    segments = split_path(path)
    return SEPARATOR.join(segments[:-1]) if len(segments) > 1 else ""


def leaf_of(path: str) -> str:
    """最后一段（叶子名），如 `'工作/项目A'` → `'项目A'`。分类器分段打分用它，文件名里出现的几乎总是叶子名而非完整路径。"""
    segments = split_path(path)
    return segments[-1] if segments else ""


def is_descendant_of(path: str, ancestor: str) -> bool:
    """path 是否 ancestor 的严格子孙（等于自己不算）。必须比 `path.startswith(ancestor)` 严格，
    后者会把 `工作台` 误判为 `工作` 的子孙；加分隔符再比才有层级语义。"""
    if not ancestor:
        return bool(path)
    return path.startswith(ancestor + SEPARATOR)


def is_self_or_descendant_of(path: str, ancestor: str) -> bool:
    return path == ancestor or is_descendant_of(path, ancestor)


def rebase(path: str, old_prefix: str, new_prefix: str) -> Optional[str]:
    """把 path 从 old_prefix 下搬到 new_prefix 下，不在 old_prefix 里返回 None，
    如 `rebase('工作/项目A/需求', '工作/项目A', '归档/项目A')` → `'归档/项目A/需求'`。
    返回 None 而非原样返回，让批量 UPDATE 能区分需要改与不用动的行。"""
    if path == old_prefix:
        return new_prefix
    if is_descendant_of(path, old_prefix):
        return new_prefix + path[len(old_prefix) :]
    return None


def validate_move(source: str, destination: str) -> str:
    """校验子树移动/重命名，返回规范化目标路径。除目标路径合法外，还要挡住：
    1. 把子树移进自己的子孙（`工作/项目A` → `工作/项目A/子集`），前缀替换会产生无限自嵌套且无法回滚，必须动手前拦住。
    2. 移动后深度超限：整体下移时最深叶子变深，只查目标路径深度不够；由知道子树深度的调用方补校验，这里只管 source/destination 的关系。
    """
    normalized_source = validate_path(source)
    normalized_destination = validate_path(destination)
    if not normalized_source:
        raise CategoryPathError("notes.category_name_required")
    if not normalized_destination:
        raise CategoryPathError("notes.category_name_required")
    if is_self_or_descendant_of(normalized_destination, normalized_source):
        raise CategoryPathError("notes.category_move_into_self")
    return normalized_destination


def depth_of(path: str) -> int:
    return len(split_path(path))


def check_resulting_depth(deepest_existing: str, old_prefix: str, new_prefix: str) -> None:
    """子树整体移动后最深路径是否超过 MAX_DEPTH。调用方先查出子树最深的现存路径传入；
    独立于 validate_move 是因为需要数据库结果，而本模块刻意不碰数据库。"""
    moved = rebase(deepest_existing, old_prefix, new_prefix)
    if moved is None:
        return
    depth = depth_of(moved)
    if depth > MAX_DEPTH:
        raise CategoryPathError("notes.category_too_deep", limit=MAX_DEPTH, actual=depth)
