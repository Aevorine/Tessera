"""扫描结果交给界面前的最后一道闸口。

各 scanner 各自决定默认勾选，没有地方统一回答"删了还能拿回来吗"；
`actions.reversibility()` 只在用户点击之后才被用到。曾出现链路：privacy 的 jumpLists
default_selected=True → 永久删除 → 「推荐清理」自动勾选 → 快速访问固定文件夹永久丢失，全程无警告。

职责：1. 把可逆性回填进每条 `detail`；2. 不可逆且重建代价高的项永不默认勾选，凌驾于
scanner 判断；3. 长得像痕迹、实为用户手工配置的路径（快速访问固定项、Chrome 应用宿主目录）进 `
locked`。

只降级默认值、不禁止清理（用户明确想清 Cookie 等时必须能清）；受保护路径是唯一例外。
"""

from __future__ import annotations

import os
import struct
from pathlib import PurePath
from typing import Dict, List, Optional, Sequence, Tuple

from modules.file_vault.pcclean.model import CleanItem, ScanReport

# 受保护路径

# 「快速访问 → 固定的文件夹」实际存放的文件，混在 `AutomaticDestinations` 里，文件名是
# AppID 哈希，删了 Explorer 不会重建。两个哈希都收（Win10/11 的 `f01b4d95cf55d32a`、
# 部分 Win10 的 `5f7b5f1e01b83767`）：多保护一个只少清几十 KB。
# 这张表只是兜底：硬编码哈希换版本可能静默失效，第一判据是 `jumplist_pinned_count()`
# 真读文件；读不出来（非 CFBF、被占用、格式变化）才退回此表。
PINNED_JUMPLIST_FILES = frozenset({
    "f01b4d95cf55d32a.automaticdestinations-ms",
    "5f7b5f1e01b83767.automaticdestinations-ms",
})

# Chromium 已安装应用（PWA）的宿主目录，与 `Code Cache`、`GPUCache` 并排但不是缓存；
# 删掉会丢图标和启动器，进而被"失效快捷方式"扫描连带清掉，应用就彻底没了。
PROTECTED_DIR_NAMES = frozenset({
    "web applications",
})

_PROTECTED_REASONS = {
    "pinned": "pcclean.safety.protected.quickAccessPinned",
    "webapp": "pcclean.safety.protected.installedWebApp",
}


# 解析 jump list 里"用户手工钉上去"的条数。
# `*.automaticDestinations-ms` 是 OLE 复合文档 (CFBF)，其 `DestList` 流头部第 8 字节写着固定项条数。
# 固定项是纯用户输入、无副本、Explorer 不重建，原先靠两个硬编码 AppID 哈希判断，等于赌 Windows
#  不改版本。
# 解析器读用户机器上任意二进制并跑在删除循环里，三条自我约束：
#   1. 所有循环有硬上限；2. 所有偏移做边界检查，越界当"读不出来"；
#   3. 入口包 try/except，永不抛异常。
# 读不出来返回 `None`（≠ 0），调用方退回硬编码白名单；合并两者会给"不认识就随便删"开路。

_JUMPLIST_SUFFIX = ".automaticdestinations-ms"

_CFBF_SIGNATURE = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"

# 扇区号里 >= 0xFFFFFFFA 的全是特殊值（DIFAT / FAT / 链尾 / 空闲），
# 不是真实扇区。只要用这一个阈值判断，四个常量各自的含义就不必展开。
_CFBF_MAXREGSECT = 0xFFFFFFFA

_CFBF_DIR_ENTRY_SIZE = 128
_CFBF_MAX_DIR_ENTRIES = 10000
_CFBF_MAX_CHAIN_STEPS = 100000
_CFBF_MAX_BYTES = 16 * 1024 * 1024
"""超过这个大小就不看了。真实的 jump list 是几十~几百 KB；一个 16 MB 的
`.automaticDestinations-ms` 要么不是这个东西，要么就不该由一个删除循环
整个读进内存。"""

_DESTLIST_HEADER_BYTES = 12
_DESTLIST_MAX_ENTRIES = 100000


def _cfbf_sector(data: bytes, sector_id: int, sector_size: int) -> Optional[bytes]:
    """第 `sector_id` 号扇区的原始字节；越界/特殊扇区号返回 None。偏移为 `(id + 1) * sector_size`
    （头部占满第一个扇区）。"""
    if sector_id >= _CFBF_MAXREGSECT:
        return None
    start = (sector_id + 1) * sector_size
    end = start + sector_size
    if start < sector_size or end > len(data):
        return None
    return data[start:end]


def _cfbf_fat(data: bytes, sector_size: int) -> Optional[List[int]]:
    """整张 FAT（扇区号 → 下一扇区号）；前 109 项 DIFAT 在头部 0x4C，更多的沿 DIFAT 扇区链找。"""
    per_sector = sector_size // 4
    if per_sector < 2:
        return None
    # 文件里根本装不下这么多扇区的话，DIFAT 是坏的。这个上界同时兼作
    # 循环上限——比 _CFBF_MAX_CHAIN_STEPS 紧得多。
    max_sectors = len(data) // sector_size + 1

    fat_ids: List[int] = []
    for index in range(109):
        sector_id = struct.unpack_from("<I", data, 0x4C + 4 * index)[0]
        if sector_id < _CFBF_MAXREGSECT:
            fat_ids.append(sector_id)

    sector_id = struct.unpack_from("<I", data, 0x44)[0]
    steps = 0
    while sector_id < _CFBF_MAXREGSECT:
        steps += 1
        if steps > _CFBF_MAX_CHAIN_STEPS or len(fat_ids) > max_sectors:
            return None
        block = _cfbf_sector(data, sector_id, sector_size)
        if block is None:
            return None
        for index in range(per_sector - 1):
            value = struct.unpack_from("<I", block, 4 * index)[0]
            if value < _CFBF_MAXREGSECT:
                fat_ids.append(value)
        sector_id = struct.unpack_from("<I", block, 4 * (per_sector - 1))[0]

    if not fat_ids or len(fat_ids) > max_sectors:
        return None

    fat: List[int] = []
    for fat_sector in fat_ids:
        block = _cfbf_sector(data, fat_sector, sector_size)
        if block is None:
            return None
        fat.extend(struct.unpack_from("<%dI" % per_sector, block, 0))
    return fat


def _cfbf_stream(data: bytes, fat: Sequence[int], start: int, sector_size: int,
                 want: int) -> Optional[bytes]:
    """沿 FAT 链读流的前 `want` 字节（`DestList` 头 12 字节足够，不必读全流）。

    链长受 `len(fat)` 和硬上限约束，环形链（坏文件或恶意构造）会被判死。
    """
    out = bytearray()
    sector_id = start
    steps = 0
    while len(out) < want and sector_id < _CFBF_MAXREGSECT:
        steps += 1
        if steps > _CFBF_MAX_CHAIN_STEPS or steps > len(fat):
            return None
        if sector_id >= len(fat):
            return None
        block = _cfbf_sector(data, sector_id, sector_size)
        if block is None:
            return None
        out.extend(block)
        sector_id = fat[sector_id]
    return bytes(out[:want])


def _cfbf_mini_stream(container: bytes, mini_fat: Sequence[int], start: int,
                      want: int, mini_size: int) -> Optional[bytes]:
    """同上，走 mini FAT（小于 cutoff、通常 4096 的流）。`DestList` 记录少时会落在这里，不实现则小
    跳转列表全"读不出来"。"""
    out = bytearray()
    sector_id = start
    steps = 0
    while len(out) < want and sector_id < _CFBF_MAXREGSECT:
        steps += 1
        if steps > _CFBF_MAX_CHAIN_STEPS or steps > len(mini_fat):
            return None
        if sector_id >= len(mini_fat):
            return None
        offset = sector_id * mini_size
        if offset < 0 or offset + mini_size > len(container):
            return None
        out.extend(container[offset:offset + mini_size])
        sector_id = mini_fat[sector_id]
    return bytes(out[:want])


def jumplist_pinned_count(path) -> Optional[int]:
    """jump list 里用户手工固定的项数；读不出来返回 `None`（与 `0` 的区别见文件上方说明）。"""
    try:
        return _jumplist_pinned_count(str(path))
    except Exception:
        # 兜到任何异常都当成"读不出来"。这个函数的调用点在删除循环里，
        # 一个 struct 解包越界不能演变成一次清理整个崩掉。
        return None


def _jumplist_pinned_count(path: str) -> Optional[int]:
    try:
        with open(path, "rb") as handle:
            data = handle.read(_CFBF_MAX_BYTES + 1)
    except OSError:
        return None
    if len(data) < 512 or len(data) > _CFBF_MAX_BYTES:
        return None
    if not data.startswith(_CFBF_SIGNATURE):
        return None

    sector_shift = struct.unpack_from("<H", data, 0x1E)[0]
    mini_shift = struct.unpack_from("<H", data, 0x20)[0]
    # v3 = 512 字节扇区，v4 = 4096。别的值不是这个格式。
    if sector_shift not in (9, 12) or not (2 <= mini_shift < sector_shift):
        return None
    sector_size = 1 << sector_shift
    mini_size = 1 << mini_shift
    if len(data) < sector_size * 2:
        return None

    first_dir = struct.unpack_from("<I", data, 0x30)[0]
    mini_cutoff = struct.unpack_from("<I", data, 0x38)[0]
    first_mini_fat = struct.unpack_from("<I", data, 0x3C)[0]

    fat = _cfbf_fat(data, sector_size)
    if not fat:
        return None

    directory = _cfbf_stream(data, fat, first_dir, sector_size,
                             _CFBF_MAX_DIR_ENTRIES * _CFBF_DIR_ENTRY_SIZE)
    if not directory or len(directory) < _CFBF_DIR_ENTRY_SIZE:
        return None

    # 0 号目录项永远是根，mini stream 的容器挂在它身上。
    root_start = struct.unpack_from("<I", directory, 0x74)[0]
    root_size = struct.unpack_from("<Q", directory, 0x78)[0]

    found: Optional[Tuple[int, int]] = None
    entry_count = min(len(directory) // _CFBF_DIR_ENTRY_SIZE, _CFBF_MAX_DIR_ENTRIES)
    for index in range(entry_count):
        base = index * _CFBF_DIR_ENTRY_SIZE
        if directory[base + 0x42] != 2:  # 2 = 流；1 是存储，5 是根
            continue
        name_bytes = struct.unpack_from("<H", directory, base + 0x40)[0]
        # 名字是 UTF-16LE 且长度含结尾的 NUL，所以至少 4 字节、最多 64。
        if name_bytes < 4 or name_bytes > 64:
            continue
        try:
            name = directory[base:base + name_bytes - 2].decode("utf-16-le")
        except (UnicodeDecodeError, ValueError):
            continue
        if name.lower() != "destlist":
            continue
        found = (struct.unpack_from("<I", directory, base + 0x74)[0],
                 struct.unpack_from("<Q", directory, base + 0x78)[0])
        break

    if found is None:
        return None
    stream_start, stream_size = found
    if stream_size == 0:
        # 空的 `DestList`（流长 0、起始扇区为链尾）在真机很常见，返回 0；
        # 返回 `None` 会让这批本该清掉的文件永远清不掉。
        return 0
    if stream_size < _DESTLIST_HEADER_BYTES:
        return None

    if stream_size < mini_cutoff:
        container = _cfbf_stream(data, fat, root_start, sector_size,
                                 min(int(root_size), len(data)))
        if not container:
            return None
        raw_mini_fat = _cfbf_stream(data, fat, first_mini_fat, sector_size, len(data))
        if not raw_mini_fat:
            return None
        mini_fat = list(struct.unpack_from("<%dI" % (len(raw_mini_fat) // 4),
                                           raw_mini_fat, 0))
        head = _cfbf_mini_stream(container, mini_fat, stream_start,
                                 _DESTLIST_HEADER_BYTES, mini_size)
    else:
        head = _cfbf_stream(data, fat, stream_start, sector_size,
                            _DESTLIST_HEADER_BYTES)
    if not head or len(head) < _DESTLIST_HEADER_BYTES:
        return None

    version, total, pinned = struct.unpack_from("<III", head, 0)
    # 不按版本号白名单放行：公开资料是 1/3/4，而 Windows 11 实际写的是 6，
    # 白名单会让所有跳转列表"读不出来"，保护静默退化回硬编码哈希。
    # 这里只判"像不像版本号"，真正把关交给后面的一致性检查 `pinned <= total <= 十万`。
    if version < 1 or version > 16:
        return None
    # 固定项比总条目还多、或者条目数大到离谱 —— 说明我们读的不是这个字段。
    # 这种时候必须说"读不出来"，而不是把一个乱数当成"0 条固定项"报出去。
    if pinned > total or total > _DESTLIST_MAX_ENTRIES:
        return None
    return int(pinned)


def _jumplist_is_protected(path: str, lowered_name: str) -> bool:
    """该不该拦下这个 jump list 文件。

    解析成功就按结果走（有固定项才保护）；解析失败退回硬编码白名单，保护不能因解析器不认识而失效。
    """
    pinned = jumplist_pinned_count(path)
    if pinned is None:
        return lowered_name in PINNED_JUMPLIST_FILES
    return pinned > 0


def protection_reason(path: str) -> str:
    """路径是否受保护，返回 i18n 键，空串=不受保护。

    按名字/内容而非完整路径判断（用户名、盘符、Profile 名因机器而异）；
    跳转列表的 AppID 哈希也会变，所以先 `jumplist_pinned_count` 读文件，读不出才退回名字白名单。
    """
    if not path:
        return ""
    pure = PurePath(path)
    lowered = pure.name.lower()
    if lowered.endswith(_JUMPLIST_SUFFIX) and _jumplist_is_protected(path, lowered):
        return _PROTECTED_REASONS["pinned"]
    for part in pure.parts:
        if part.lower() in PROTECTED_DIR_NAMES:
            return _PROTECTED_REASONS["webapp"]
    return ""


def filter_protected(names: Sequence[str]) -> List[str]:
    """从一批相对路径/文件名里剔掉受保护的。给执行侧逐文件删的分支用。"""
    return [n for n in names if not protection_reason(str(n))]


class PathGuard:
    """按父目录记忆判定结果的受保护路径检查器，为性能而设。

    `protection_reason()` 每次构造 PurePath 并遍历各段，删除循环对 `%TEMP%` 十万级文件逐个调用会卡
    住进度条。
    目录结果对其下所有文件相同，故按目录缓存；文件名层只有 `.automaticDestinations-ms` 才会被打开，
    最多几十个。
    """

    __slots__ = ("_dirs",)

    def __init__(self) -> None:
        self._dirs: Dict[str, str] = {}

    def check(self, path) -> str:
        """返回 i18n 键，空串 = 可以删。"""
        text = str(path)
        if not text:
            return ""
        parent, _, name = text.replace("/", "\\").rpartition("\\")
        lowered = name.lower()
        # 只有真的叫 `.automaticDestinations-ms` 的才去读文件。这一层判断
        # 就是为了让删除循环里那十万次调用**一次都不碰磁盘**。
        if lowered.endswith(_JUMPLIST_SUFFIX) and _jumplist_is_protected(text, lowered):
            return _PROTECTED_REASONS["pinned"]
        verdict = self._dirs.get(parent)
        if verdict is None:
            verdict = ""
            for part in parent.split("\\"):
                if part.lower() in PROTECTED_DIR_NAMES:
                    verdict = _PROTECTED_REASONS["webapp"]
                    break
            self._dirs[parent] = verdict
        return verdict


# 决策指标：影响面 + 重建成本

# 影响面标签：回答"删了之后我会注意到什么"，而非占多少字节（`size_bytes` 排不出"哪个删了会疼"）。
#   cache 纯缓存自动重建；history 使用记录；signin 登录态；
#   config 用户手工设置（固定项、扩展配置、自启项）；userdata 用户文件；system 系统组件、驱动
IMPACT_CACHE = "cache"
IMPACT_HISTORY = "history"
IMPACT_SIGNIN = "signin"
IMPACT_CONFIG = "config"
IMPACT_USERDATA = "userdata"
IMPACT_SYSTEM = "system"

# 重建成本（恢复原样要付出什么）：none 系统自会补；low 重新点几下；high 重装/手工重建或回不来。
COST_NONE = "none"
COST_LOW = "low"
COST_HIGH = "high"

_CATEGORY_METRICS: Dict[str, Tuple[Tuple[str, ...], str]] = {
    "junk": ((IMPACT_CACHE,), COST_NONE),
    "browserCache": ((IMPACT_CACHE,), COST_LOW),
    "memory": ((IMPACT_CACHE,), COST_NONE),
    "privacy": ((IMPACT_HISTORY,), COST_LOW),
    "browserData": ((IMPACT_HISTORY,), COST_LOW),
    "registry": ((IMPACT_CONFIG,), COST_LOW),
    "startup": ((IMPACT_CONFIG,), COST_LOW),
    "popupSources": ((IMPACT_CONFIG,), COST_LOW),
    "contextMenu": ((IMPACT_CONFIG,), COST_LOW),
    "plugins": ((IMPACT_CONFIG,), COST_HIGH),
    "software": ((IMPACT_USERDATA, IMPACT_CONFIG), COST_HIGH),
    "diskSlimming": ((IMPACT_SYSTEM,), COST_HIGH),
    "driverStore": ((IMPACT_SYSTEM,), COST_HIGH),
    "bigFiles": ((IMPACT_USERDATA,), COST_HIGH),
    "duplicates": ((IMPACT_USERDATA,), COST_HIGH),
    "downloads": ((IMPACT_USERDATA,), COST_HIGH),
    "leftovers": ((IMPACT_USERDATA,), COST_HIGH),
    "emptyDirs": ((IMPACT_USERDATA,), COST_LOW),
    "custom": ((IMPACT_USERDATA,), COST_HIGH),
}

# 比类别更细：`browserData` 里既有无感的 GPU 缓存也有让网站掉线的 Cookie，不能共用一个标签。
# 键取自 `deepclean._CHROMIUM_KINDS` / `_FIREFOX_KINDS` 的 `key`。
_BROWSER_DATA_METRICS: Dict[str, Tuple[Tuple[str, ...], str]] = {
    "cookies": ((IMPACT_SIGNIN,), COST_LOW),
    "history": ((IMPACT_HISTORY,), COST_HIGH),
    "downloadRecords": ((IMPACT_HISTORY,), COST_HIGH),
    "formData": ((IMPACT_CONFIG,), COST_HIGH),
    "sessions": ((IMPACT_CONFIG,), COST_LOW),
    # 已安装的 PWA 把自己的全部数据放在这里。对普通网站它只是"站点数据"，
    # 对已安装应用它就是应用本身的存档。
    "siteData": ((IMPACT_SIGNIN, IMPACT_USERDATA), COST_HIGH),
    # Service Worker 是 PWA 的离线外壳。对普通网站删了确实无损（下次访问重装），
    # 对已安装应用删了就是"点开是白屏"。所以它不能算纯缓存。
    "serviceWorker": ((IMPACT_CACHE,), COST_LOW),
    "gpuCache": ((IMPACT_CACHE,), COST_NONE),
    "codeCache": ((IMPACT_CACHE,), COST_NONE),
    "favicons": ((IMPACT_CACHE,), COST_NONE),
}

# `privacy` 里按规则 key 细分。规则 key 是 `item_id` 的第二段（`privacy:jumpLists`）。
_PRIVACY_METRICS: Dict[str, Tuple[Tuple[str, ...], str]] = {
    # 同时装着最近打开记录（痕迹）和快速访问固定项（配置），标成 config 以便在界面上与"最近文档"分开。
    "jumpLists": ((IMPACT_HISTORY, IMPACT_CONFIG), COST_HIGH),
    # `CustomDestinations` 非 CFBF，无法逐条判 pin，且应用不重新注册就不会恢复；
    # 所以整条默认不勾选（见 privacy.PRIVACY_RULES），代价标 high。
    "jumpListsCustom": ((IMPACT_HISTORY, IMPACT_CONFIG), COST_HIGH),
    "recentDocuments": ((IMPACT_HISTORY,), COST_LOW),
    "typedPaths": ((IMPACT_HISTORY,), COST_LOW),
    "runMru": ((IMPACT_HISTORY,), COST_LOW),
    "recentDocsRegistry": ((IMPACT_HISTORY,), COST_LOW),
    "wordWheelQuery": ((IMPACT_HISTORY,), COST_LOW),
    "userAssist": ((IMPACT_HISTORY,), COST_LOW),
    "networkShareMru": ((IMPACT_CONFIG,), COST_LOW),
    "openSaveMru": ((IMPACT_HISTORY,), COST_LOW),
    "lastVisitedMru": ((IMPACT_HISTORY,), COST_LOW),
}


def metrics_for(item: CleanItem) -> Tuple[List[str], str]:
    """(影响面标签, 重建成本)；查不到落到最保守的 `userdata` + `high`，忘了登记的新类别不会被标成"
    放心清"。"""
    detail = item.detail or {}
    if item.category == "browserData":
        hit = _BROWSER_DATA_METRICS.get(str(detail.get("kind") or ""))
        if hit:
            return list(hit[0]), hit[1]
    if item.category == "privacy":
        # `privacy:jumpLists` → `jumpLists`；`privacy:browser:Chrome:Default` → `browser`
        parts = item.item_id.split(":")
        hit = _PRIVACY_METRICS.get(parts[1] if len(parts) > 1 else "")
        if hit:
            return list(hit[0]), hit[1]
        if len(parts) > 1 and parts[1] == "browser":
            return [IMPACT_HISTORY], COST_HIGH
    hit = _CATEGORY_METRICS.get(item.category)
    if hit:
        return list(hit[0]), hit[1]
    return [IMPACT_USERDATA], COST_HIGH


# 界面三个可选指标：risk / estimatedSeconds / lastCleanedAt

RISK_LOW = "low"
RISK_MEDIUM = "medium"
RISK_HIGH = "high"


def risk_for(item: CleanItem, level: str, cost: str) -> str:
    """单条风险档，由 `locked`、`level`、`cost` 三者派生，不是独立判断，避免与"不可逆 · 重建代价高
    "自相矛盾。"""
    if item.locked:
        # 锁死的都是"看起来像痕迹、其实是用户配置"的东西。它清不掉，
        # 但界面上必须显示成高风险——那正是它被锁的原因。
        return RISK_HIGH
    if level == "recycle":
        # 进回收站的都是用户自己的文件，但**用户自己就能拉回来**。
        # 重建代价再高也封顶在 medium：删错了不是"没了"，是"多两下鼠标"。
        return RISK_MEDIUM if cost == COST_HIGH else RISK_LOW
    if level == "restorable":
        # 改注册表/自启项，有备份和撤销日志，但要在本应用里操作才撤得回来。
        return RISK_MEDIUM
    # 剩下的是真删且拿不回来，风险全看重建代价：临时文件 low，Cookie 重新登录 medium，快速访问固定
    # 项 high。
    if cost == COST_HIGH:
        return RISK_HIGH
    return RISK_LOW if cost == COST_NONE else RISK_MEDIUM


# 估算耗时用的三个常数。都是量级估计，**不假装精确**：界面上它只用来
# 回答"这一下是一秒钟还是五分钟"，而那个量级判断用户确实需要。
_EST_BASE_SECONDS = 0.3
_EST_FILES_PER_SECOND = 350.0
_EST_BYTES_PER_SECOND = 120.0 * 1024 * 1024
_EST_RECYCLE_FACTOR = 2.5
"""进回收站比 unlink 慢得多：每个文件要写一条 `$I` 元数据、要挪进
`$Recycle.Bin`，跨卷时还要真的拷。同样一万个文件，两条路径差的不是零头。"""


def estimated_seconds(item: CleanItem, level: str = "") -> float:
    """清掉这一条大概要几秒；条目数优先取 `detail` 里扫描时已数好的字段，取不到按一条算。"""
    detail = item.detail if isinstance(item.detail, dict) else {}
    files = 0
    for key in ("file_count", "entry_count", "count", "removed"):
        try:
            files = max(files, int(detail.get(key) or 0))
        except (TypeError, ValueError):
            continue
    if files <= 0:
        files = 1
    seconds = _EST_BASE_SECONDS + files / _EST_FILES_PER_SECOND
    seconds += max(0, int(item.size_bytes or 0)) / _EST_BYTES_PER_SECOND
    if level == "recycle":
        seconds *= _EST_RECYCLE_FACTOR
    return round(max(0.1, seconds), 1)


# 闸口

# 超过这个条目数就不再逐条 stat 取时间戳：重复文件扫全盘可达上万条，会拖慢"第一块内容"到达时间。
# 超限时该栏留空，界面按"未知"渲染。
_STAT_BUDGET_ITEMS = 800


def _last_change_ts(path: str) -> Optional[float]:
    """路径的最后改动时间；用 mtime 不用 atime，因为 Windows 10 1803 起 `NtfsDisableLastAccessUpda
    te` 默认开，atime 不更新。"""
    if not path or not os.path.isabs(path):
        return None
    try:
        return os.stat(path).st_mtime
    except (OSError, ValueError):
        return None


def apply_safety_policy(report: ScanReport, data_dir=None) -> ScanReport:
    """就地给扫描报告补齐安全字段并返回同一对象；必须幂等，因为落盘缓存回放的条目要再过一次闸口防篡改。

    `data_dir` 仅用于读 `lastCleanedAt`，可选，缺省为 `None`，单测和离线回放无需造数据目录。
    """
    from modules.file_vault.pcclean import actions

    stat_budget = _STAT_BUDGET_ITEMS if len(report.items) <= _STAT_BUDGET_ITEMS else 0
    # 整份报告只读一次这个 JSON。放进循环里就是每条一次磁盘 I/O，
    # 而一次重复文件扫描能出上万条。
    last_cleaned = actions.read_last_cleaned(data_dir) if data_dir else {}

    for item in report.items:
        detail = item.detail if isinstance(item.detail, dict) else {}
        item.detail = detail

        level = actions.reversibility(item)
        detail["reversibility"] = level

        impact, cost = metrics_for(item)
        detail["impact"] = impact
        detail["rebuild_cost"] = cost

        # 清理面板可选指标的键名是与前端约好的驼峰契约，与 detail 里其它蛇形键不一致也不能改，否则那一
        # 栏永远空。
        detail["size"] = int(item.size_bytes or 0)
        detail["estimatedSeconds"] = estimated_seconds(item, level)
        # 没清过就是 None，不是 0 也不是空串：界面要能把"从没清过"
        # 和"刚清过"分开说，而 0 会被格式化成 1970 年。
        detail["lastCleanedAt"] = last_cleaned.get(item.category)

        guard = protection_reason(item.path)
        if guard:
            item.locked = True
            item.default_selected = False
            detail["protected"] = guard
            detail["risk"] = risk_for(item, level, cost)
            continue

        detail["risk"] = risk_for(item, level, cost)

        # 硬规则：撤不回来且重建代价高才不默认勾选。只看不可逆的话临时文件、浏览器缓存也会被排除，一键
        # 清理就废了。
        # 实际命中的是 `privacy` 的 jumpLists / jumpListsCustom（装着快速访问固定文件夹），
        # 它们以前默认勾选，又被「推荐清理」收入。
        if level == "permanent" and cost == COST_HIGH and item.default_selected:
            item.default_selected = False
            detail["demoted"] = "pcclean.safety.demoted.irreversible"

        if stat_budget:
            ts = _last_change_ts(item.path)
            if ts is not None:
                detail["last_change_ts"] = ts
            stat_budget -= 1

    return report
