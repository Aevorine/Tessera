"""清理套件的共用数据类型，只放跨模块共用的；某个 scanner 自用的中间结构留在它自己文件里。"""

from __future__ import annotations

import time
from dataclasses import dataclass, field, asdict
from enum import IntEnum
from typing import Any, Callable, Dict, List, Optional


class Importance(IntEnum):
    """五级重要性，数字越小越动不得，可直接比大小。

    分五级是因为用户的问题是「我认不认识它」而非「能不能删」。UNKNOWN 不单设一级：认不出的落进 OPTIONAL
    （默认不勾选、由用户决定），动作与 OPTIONAL 相同。"""

    CRITICAL = 0
    """系统关键。Windows 组件、引导相关、安全软件。**永远 locked，不可勾选。**"""

    DRIVER = 1
    """驱动与硬件支撑。显卡/声卡/触控板/打印机厂商组件。删了通常不蓝屏但会掉功能。"""

    COMMON = 2
    """你常用的软件。有桌面快捷方式、最近用过、或装在 Program Files 里的知名程序。"""

    OPTIONAL = 3
    """可选。认不出来的、很久没用的、纯附带的组件。默认不勾选。"""

    JUNK = 4
    """推广垃圾。捆绑安装器、弹窗推广模块、无签名的自启项。默认勾选。"""


IMPORTANCE_KEYS = {
    Importance.CRITICAL: "critical",
    Importance.DRIVER: "driver",
    Importance.COMMON: "common",
    Importance.OPTIONAL: "optional",
    Importance.JUNK: "junk",
}


@dataclass
class CleanItem:
    """一条可清理项。`item_id` 须在同次扫描内唯一且稳定（前端用它回传选择、重扫后要对得上），
    由 category + 真实路径/键名派生，不用自增序号，否则两次扫描间界面勾选会指向别的东西。"""

    item_id: str
    category: str
    label: str
    size_bytes: int = 0
    path: str = ""
    importance: Importance = Importance.OPTIONAL
    reason: str = ""
    """给人看的一句话：删了会怎样 / 为什么判成这一级。"""

    locked: bool = False
    """True = 后端拒绝对它执行任何清理，前端也应禁用勾选框。"""

    default_selected: bool = False
    detail: Dict[str, Any] = field(default_factory=dict)
    """分类特有的附加字段（软件的发布者、启动项的命令行、重复文件的组号…）。"""

    def to_dict(self) -> Dict[str, Any]:
        data = asdict(self)
        data["importance"] = IMPORTANCE_KEYS[self.importance]
        return data

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "CleanItem":
        """`to_dict()` 的逆操作，只给落盘缓存读回用。

        不接受前端传来的字典，否则渲染层能自己编出要删的路径；执行路径上的条目只能来自后端自己扫出或存下的数据。
        重要性反查不到落到 OPTIONAL 而不抛异常：缓存可能是旧版本写的，OPTIONAL 恰是最保守的一档。"""
        raw = str(data.get("importance") or "")
        importance = next(
            (level for level, key in IMPORTANCE_KEYS.items() if key == raw),
            Importance.OPTIONAL,
        )
        detail = data.get("detail")
        return cls(
            item_id=str(data.get("item_id") or ""),
            category=str(data.get("category") or ""),
            label=str(data.get("label") or ""),
            size_bytes=int(data.get("size_bytes") or 0),
            path=str(data.get("path") or ""),
            importance=importance,
            reason=str(data.get("reason") or ""),
            locked=bool(data.get("locked")),
            default_selected=bool(data.get("default_selected")),
            detail=detail if isinstance(detail, dict) else {},
        )


@dataclass
class ScanReport:
    """一个类别的扫描结果。"""

    category: str
    items: List[CleanItem] = field(default_factory=list)
    elapsed_ms: int = 0
    truncated: bool = False
    """True = 命中了条目上限，列表不完整。**必须让界面显示出来**——
    "只有 500 条"和"确实只有 500 条"在界面上长得一模一样，
    悄悄截断等于骗用户说已经清干净了。"""

    timed_out: bool = False
    """True = 这一类用光了自己的时间预算，提前收工，列表不完整。

    和 `truncated` 分开是因为**用户的下一步动作不同**：truncated 是"东西太多"，
    再扫一遍还是这么多；timed_out 是"这次太慢"，多半是磁盘忙或者机器在干别的，
    界面上应该给一个"重扫这一类"的入口而不是"提高上限"。"""

    errors: List[str] = field(default_factory=list)
    """扫不动的地方（权限不足、路径被占用）。不抛异常中断整次扫描，
    但也绝不静默吞掉——用户有权知道哪一块没扫到。"""

    current_path: str = ""
    partial: bool = False
    """只扫了一部分**范围**（预算在中途用完，见 space.scan_duplicates 的软截止）。

    跟 `truncated` 分开是因为用户的下一步动作不同：`truncated` 是"东西太多、
    只显示前 N 个"，扫描本身是完整的，再扫一遍还是这么多；`partial` 是
    "这次只看了一部分"，换个空闲时间重扫会更多。混成一个字段的代价是真实
    发生过的：落盘缓存按 `truncated` 拒收结果，于是天生就按 limit 截断的
    大文件扫描永远进不了缓存。"""
    scanned_dirs: int = 0
    scanned_files: int = 0
    denied: int = 0
    """**这一次到底检查了多少地方、被拒了多少次。**

    存在的唯一理由是让界面能把两种"0 项"分开说：
    `0 项 / 检查了 12,431 个位置` = 确实干净；
    `0 项 / 检查了 0 个位置` = 这一类根本没跑起来（权限、路径没解析出来、
    被时间预算掐断在第一步）。

    这两种情况以前在屏幕上一模一样，而后者正是"看着很干净"这种假象的来源。
    计数由 `paths.iter_files` 自动打点，不走它的 scanner 用
    `paths.bump_scan_stat` 手工打。"""

    @property
    def total_bytes(self) -> int:
        return sum(i.size_bytes for i in self.items)

    @property
    def selectable_bytes(self) -> int:
        """去掉锁死项之后真正能清出来的字节数。首屏那个大数字用的是它，
        不是 total_bytes——把删不掉的也算进"可释放空间"就是虚报。"""
        return sum(i.size_bytes for i in self.items if not i.locked)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "category": self.category,
            "items": [i.to_dict() for i in self.items],
            "count": len(self.items),
            "total_bytes": self.total_bytes,
            "selectable_bytes": self.selectable_bytes,
            "elapsed_ms": self.elapsed_ms,
            "truncated": self.truncated,
            "timed_out": self.timed_out,
            "errors": self.errors,
            "current_path": self.current_path,
            "partial": self.partial,
            "scanned_dirs": self.scanned_dirs,
            "scanned_files": self.scanned_files,
            "denied": self.denied,
        }


ProgressFn = Callable[[int, int], None]
CancelFn = Callable[[], bool]


@dataclass
class ScanTask:
    """一次扫描的运行上下文：打包进度回调与取消检查；拿了 ScanTask 却不调 `cancelled()` 的循环就是
    漏了。"""

    category: str
    on_progress: Optional[ProgressFn] = None
    should_cancel: Optional[CancelFn] = None
    started_at: float = field(default_factory=time.perf_counter)
    """用 `perf_counter` 不用 `monotonic`：Windows 上 `time.monotonic()` 的实现是
    `GetTickCount64()`，**分辨率 15.625 毫秒**，而 `perf_counter` 是
    QueryPerformanceCounter，0.0001 毫秒。差十五万倍。

    这不是吹毛求疵——本套件里已经有真实耗时 46 毫秒的调用（非提权进程里的
    `dism /AnalyzeComponentStore`），用 monotonic 量它得到的是 31 或 47，
    也就是**时钟刻度而不是被测对象**。验收线里的「首块内容 ≤200ms」也只有
    在这个精度下才量得准。"""

    budget_s: Optional[float] = None
    """这一类扫描的时间预算（秒）。`None` = 不限。

    实现成**协作式**而不是杀线程：超预算后 `cancelled()` 开始返回 True，
    所有已经在循环里检查取消的 scanner 会自然收工并交回**已经扫到的部分**。
    强杀线程既做不到（Python 没有安全的线程终止）也不该做——扫到一半的结果
    仍然是有用的结果，丢掉它才是浪费。"""

    def cancelled(self) -> bool:
        """用户取消，或该类用光时间预算；scanner 只需停下，原因由报告层的 `timed_out()` 区分。"""
        if self.should_cancel and self.should_cancel():
            return True
        return self.timed_out()

    def timed_out(self) -> bool:
        if self.budget_s is None:
            return False
        return (time.perf_counter() - self.started_at) >= self.budget_s

    current_path: str = ""
    """正在扫的那个目录/文件。**只是给人看的，不参与任何判断。**

    用户报过"一键体检没有进度显示"。加了心跳和逐类进度之后，屏幕确实一直在
    动，但动的是一对数字——而慢的那几类（重复文件、大文件走遍整块盘）里，
    数字变得极慢，看上去仍然像卡住了。真正让人相信"它还在干活"的是**路径在
    往前滚**：用户认得出自己的目录名。

    存在 ScanTask 上而不是从 progress 回调多传一个参数：回调签名 `(done, total)`
    有十几处调用点和两处 monkeypatch 测试，为一个纯展示字段改签名不划算，
    而且那样每个 scanner 都得记得传，漏一个就是空白。
    """

    def progress(self, done: int, total: int, path: str = "") -> None:
        if path:
            self.current_path = path
        if self.on_progress:
            self.on_progress(done, total)

    def elapsed_ms(self) -> int:
        return int((time.perf_counter() - self.started_at) * 1000)

    def __post_init__(self) -> None:
        # 计数器归零必须在 worker 线程里发生（ScanTask 在 `service.py::_one` 构造处）；
        # 在派工线程 reset，thread-local 会永远读到 0。
        from modules.file_vault.pcclean import paths as _paths
        _paths.reset_scan_stats()

    def report(self, items: List[CleanItem], *, truncated: bool = False,
               partial: bool = False,
               errors: Optional[List[str]] = None,
               probes: int = 0, denied: int = 0) -> ScanReport:
        """`probes` / `denied` 供不走文件系统的 scanner 手工补证据。

        注册表、计划任务、WMI、进程列表不经过 `paths.iter_files`，自动打点够不着，且无权限时
        会静默返回空；`startup` 自己开线程池，thread-local 计数也传不回来。
        """
        from modules.file_vault.pcclean import paths as _paths
        stats = _paths.scan_stats()
        return ScanReport(
            category=self.category,
            items=items,
            elapsed_ms=self.elapsed_ms(),
            truncated=truncated,
            partial=partial,
            current_path=self.current_path,
            timed_out=self.timed_out(),
            errors=errors or [],
            scanned_dirs=stats["dirs"] + max(0, probes),
            scanned_files=stats["files"],
            denied=stats["denied"] + max(0, denied),
        )


class CleanCancelled(Exception):
    """扫描被用户取消。不是错误，调用方捕获后按"已取消"处理即可。"""
