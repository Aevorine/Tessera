"""重要性分级引擎，软件 / 启动项 / 右键扩展 / 浏览器插件共用，免得同一厂商在不同面板判成不同结论。

判定顺序（命中即停，由保守到激进）：1. 用户白名单（永远 CRITICAL 锁死）；2. 系统关键名单；
3. 数字签名发布者（微软/硬件厂商 → DRIVER，知名厂商 → COMMON）；4. 安装位置与使用痕迹；
5. 垃圾特征（捆绑安装器、推广模块、无签名且藏在临时目录）；6. 兜底 OPTIONAL，不是 JUNK：认不出 ≠ 可以删。
"""

from __future__ import annotations

import json
import os
import re
import threading
from pathlib import Path
from typing import Dict, Iterable, Optional, Set, Tuple

from modules.file_vault.pcclean.model import Importance


# 静态知识库，全部小写、子串命中（同一组件在不同 Windows 版本名字会带版本号后缀）。
# 子串可能误命中，所以只有真正动不得的东西才放进 CRITICAL 名单。

_CRITICAL_NAME_PARTS = (
    # Windows 自身
    "windows security", "windows defender", "microsoft defender",
    "windows update", "microsoft update health",
    "visual c++", "vcredist", ".net framework", ".net runtime",
    "microsoft edge webview2", "windows subsystem",
    "microsoft store", "app installer",
    # 引导与磁盘
    "bitlocker", "boot manager", "efi", "recovery environment",
    # 安全软件（第三方的也算——把杀软清掉是最典型的灾难）
    "antivirus", "anti-virus", "endpoint protection", "endpoint security",
    "kaspersky", "bitdefender", "eset", "norton", "mcafee", "trend micro",
    "sophos", "malwarebytes", "火绒", "360安全卫士", "360杀毒",
    "腾讯电脑管家", "windows 安全中心",
)

_CRITICAL_STARTUP_COMMANDS = (
    "securityhealthsystray", "ctfmon", "explorer.exe", "sihost",
    "userinit", "taskhostw", "dwm.exe", "lsass", "winlogon",
)

# 硬件/驱动厂商。判成 DRIVER：删了通常不至于开不了机，但会掉功能（没声音、
# 触控板手势失效、显卡控制面板打不开），而用户往往不知道是自己清掉的。
_DRIVER_PUBLISHERS = (
    "intel", "nvidia", "advanced micro devices", "amd ", "realtek",
    "qualcomm", "mediatek", "broadcom", "synaptics", "elan micro",
    "logitech", "razer", "conexant", "cirrus logic", "dolby",
    "waves audio", "dts", "asmedia", "via technologies",
    "hewlett-packard", "hp inc", "dell inc", "lenovo", "asus", "asustek",
    "acer", "msi", "micro-star", "gigabyte", "samsung electronics",
    "western digital", "seagate", "kingston", "sandisk",
    "canon", "epson", "brother", "hewlett packard",
)

# 知名软件发布者 → COMMON。这份名单不追求全，只要覆盖"用户一看就知道是自己装的"
# 那一批；漏掉的会落进 OPTIONAL，那是安全的一边。
_COMMON_PUBLISHERS = (
    "microsoft corporation", "google", "mozilla", "adobe", "apple",
    "oracle", "python software foundation", "jetbrains", "docker",
    "valve", "epic games", "discord", "spotify", "zoom", "slack",
    "notion", "figma", "postman", "git for windows", "gitlab", "github",
    "nodejs", "openjs foundation", "the qt company", "autodesk",
    "blender foundation", "videolan", "audacity", "obs project",
    "7-zip", "igor pavlov", "rarlab", "piriform", "telegram",
    "tencent", "alibaba", "bytedance", "netease", "baidu",
    "kingsoft", "wps", "sogou", "youdao", "bilibili",
    "unity technologies", "steam", "ea ", "ubisoft", "blizzard",
)

# 垃圾特征。命中这些**并且没有可信签名**才判 JUNK——单看名字判会误伤
# （很多正经软件的安装目录里也有 `updater.exe`）。
_JUNK_NAME_PATTERNS = (
    r"\b(setup|install(er)?)_?\d{0,4}\b.*\.(exe|msi)$",
    r"(推广|广告|弹窗|上网导航|安全浏览器|快压|驱动人生|驱动精灵)",
    r"\b(toolbar|searchbar|webcompanion|adaware|conduit|babylon)\b",
    r"\b(coupon|shopper|savings|pricehelper)\b",
    r"\b(pcaccelerate|pcspeedup|drivereasy|driverbooster|advancedsystemcare)\b",
)
_JUNK_NAME_RE = re.compile("|".join(_JUNK_NAME_PATTERNS), re.IGNORECASE)

# 藏在这些位置的自启项高度可疑：正经软件不会从临时目录或下载目录常驻启动。
_SUSPICIOUS_DIR_PARTS = (
    "\\appdata\\local\\temp\\", "\\windows\\temp\\", "\\downloads\\",
    "\\recycle.bin\\", "\\programdata\\{",
)


_REASON_KEYS = {
    "user_whitelist": "pcclean.reason.userWhitelist",
    "system_critical": "pcclean.reason.systemCritical",
    "security_software": "pcclean.reason.securitySoftware",
    "driver_publisher": "pcclean.reason.driverPublisher",
    "known_publisher": "pcclean.reason.knownPublisher",
    "signed_unknown": "pcclean.reason.signedUnknown",
    "in_program_files": "pcclean.reason.inProgramFiles",
    "recently_used": "pcclean.reason.recentlyUsed",
    "junk_signature": "pcclean.reason.junkSignature",
    "suspicious_location": "pcclean.reason.suspiciousLocation",
    "unsigned_unknown": "pcclean.reason.unsignedUnknown",
    "unknown": "pcclean.reason.unknown",
}


class Verdict:
    """一次判定的结果。`reason_key` 是 i18n 键，不是中文原文——
    这个后端要给六种语言的界面用，把中文写死在这里就只有中文用户看得懂。"""

    __slots__ = ("importance", "reason_key", "evidence", "signals")

    def __init__(self, importance: Importance, reason_key: str, evidence: str = "",
                 signals: Optional[Dict[str, object]] = None):
        self.importance = importance
        self.reason_key = reason_key
        self.evidence = evidence
        self.signals = signals or {}
        """判定时手上有哪些信号。**不是判定依据本身**（那是 reason_key +
        evidence），是"我当时看到了什么"。

        为什么要单独留这一份：用户看到一条被判成 CRITICAL 的东西时，真正的
        问题是"凭什么"。只回答"因为它是系统关键"是同义反复；把签名、发布者、
        安装位置、有没有快捷方式一起摊开，他才能拿去和自己知道的事情对照——
        这台机器上装了什么、为什么装，只有他知道。"""

    @property
    def locked(self) -> bool:
        return self.importance == Importance.CRITICAL

    def as_dict(self) -> Dict[str, object]:
        return {
            "importance": self.importance,
            "reason_key": self.reason_key,
            "evidence": self.evidence,
            "signals": self.signals,
        }


RECOMMEND_DISABLE = "disable"
RECOMMEND_DELAY = "delay"
RECOMMEND_REVIEW = "review"
RECOMMEND_KEEP = "keep"


def recommend_for_startup(importance: Importance) -> str:
    """把重要性翻成建议动作。用户面对几十条自启项，要的是该怎么办而不是徽章。

    翻译刻意保守：该禁用没建议只是开机慢几秒，不该禁用却建议会让输入法/网盘/安全软件不启动且难以察觉。
    所以只有 JUNK（无签名推广、捆绑器）建议禁用；COMMON（有桌面快捷方式、近期用过、装在 Program Files
    的知名程序）建议延迟启动。
    """
    if importance == Importance.JUNK:
        return RECOMMEND_DISABLE
    if importance == Importance.OPTIONAL:
        return RECOMMEND_REVIEW
    if importance == Importance.COMMON:
        return RECOMMEND_DELAY
    return RECOMMEND_KEEP


_WHITELIST_LOCK = threading.Lock()
_WHITELIST_CACHE: Dict[str, Set[str]] = {}


def _whitelist_path(data_dir: Path) -> Path:
    return Path(data_dir) / "pcclean_whitelist.json"


def load_whitelist(data_dir: Path) -> Set[str]:
    """读用户白名单。按 data_dir 缓存——分级要对着几百上千条跑，
    每条都去读一次文件会把扫描拖慢一个数量级。"""
    key = str(data_dir)
    with _WHITELIST_LOCK:
        cached = _WHITELIST_CACHE.get(key)
        if cached is not None:
            return cached
    entries: Set[str] = set()
    path = _whitelist_path(data_dir)
    try:
        if path.exists():
            raw = json.loads(path.read_text(encoding="utf-8"))
            entries = {str(x).strip().lower() for x in raw.get("entries", []) if str(x).strip()}
    except (OSError, ValueError, AttributeError):
        # 白名单读坏了就当空的走——**但绝不能因此把判定放宽**。
        # 空白名单只意味着少几条 CRITICAL，其余判定链照常保守。
        entries = set()
    with _WHITELIST_LOCK:
        _WHITELIST_CACHE[key] = entries
    return entries


def save_whitelist(data_dir: Path, entries: Iterable[str]) -> Set[str]:
    normalised = {str(x).strip().lower() for x in entries if str(x).strip()}
    path = _whitelist_path(data_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(
        json.dumps({"entries": sorted(normalised)}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    os.replace(tmp, path)
    with _WHITELIST_LOCK:
        _WHITELIST_CACHE[str(data_dir)] = normalised
    return normalised


def invalidate_whitelist_cache(data_dir: Optional[Path] = None) -> None:
    with _WHITELIST_LOCK:
        if data_dir is None:
            _WHITELIST_CACHE.clear()
        else:
            _WHITELIST_CACHE.pop(str(data_dir), None)


def _in_whitelist(whitelist: Set[str], *candidates: str) -> bool:
    for candidate in candidates:
        if not candidate:
            continue
        needle = candidate.strip().lower()
        if not needle:
            continue
        if needle in whitelist:
            return True
        # 路径类白名单按前缀匹配：把一个安装目录加进白名单，
        # 目录下所有东西都应该跟着受保护。
        for entry in whitelist:
            if entry.endswith("\\") and needle.startswith(entry):
                return True
    return False



def _contains_any(haystack: str, needles: Iterable[str]) -> Optional[str]:
    low = haystack.lower()
    for needle in needles:
        if needle in low:
            return needle
    return None


def classify(
    *,
    name: str,
    publisher: str = "",
    path: str = "",
    signed: Optional[bool] = None,
    whitelist: Optional[Set[str]] = None,
    recently_used: bool = False,
    has_shortcut: bool = False,
) -> Verdict:
    """核心判定，四类对象共用，只是喂入字段不同。本层把判定信号原样附在结果上，判定链在
    `_classify_inner`；分两层是免得十几个 return 点各抄一遍 signals，漏一个就会无声地解释不出来。"""
    verdict = _classify_inner(
        name=name, publisher=publisher, path=path, signed=signed,
        whitelist=whitelist, recently_used=recently_used,
        has_shortcut=has_shortcut,
    )
    verdict.signals = {
        "name": (name or "").strip(),
        "publisher": (publisher or "").strip(),
        "path": (path or "").strip(),
        # 三态照实传：None = 没查过。前端必须把"没查"和"没签名"显示成两回事，
        # 否则一大批正经软件在用户眼里都成了"未签名"。
        "signed": signed,
        "recently_used": bool(recently_used),
        "has_shortcut": bool(has_shortcut),
        "in_program_files": (path or "").strip().lower().startswith(
            ("c:\\program files", "c:\\program files (x86)")),
        "whitelisted": _in_whitelist(whitelist or set(), name, path, publisher),
    }
    return verdict


def _classify_inner(
    *,
    name: str,
    publisher: str = "",
    path: str = "",
    signed: Optional[bool] = None,
    whitelist: Optional[Set[str]] = None,
    recently_used: bool = False,
    has_shortcut: bool = False,
) -> Verdict:
    """判定链本体。`signed=None` 表示没查签名（查签名要起 PowerShell，只对可疑项按需查）；
    None 不等于 False，否则一大批正经软件会被判成垃圾。"""
    whitelist = whitelist or set()
    name = (name or "").strip()
    publisher = (publisher or "").strip()
    path = (path or "").strip()
    low_path = path.lower()

    # 1. 用户白名单最高优先级
    if _in_whitelist(whitelist, name, path, publisher):
        return Verdict(Importance.CRITICAL, _REASON_KEYS["user_whitelist"], name)

    # 2. 系统关键
    hit = _contains_any(name, _CRITICAL_NAME_PARTS)
    if hit:
        key = "security_software" if hit in (
            "antivirus", "anti-virus", "endpoint protection", "endpoint security",
            "kaspersky", "bitdefender", "eset", "norton", "mcafee", "trend micro",
            "sophos", "malwarebytes", "火绒", "360安全卫士", "360杀毒",
            "腾讯电脑管家",
        ) else "system_critical"
        return Verdict(Importance.CRITICAL, _REASON_KEYS[key], hit)

    if low_path:
        base = os.path.basename(low_path)
        if any(base.startswith(c) for c in _CRITICAL_STARTUP_COMMANDS):
            return Verdict(Importance.CRITICAL, _REASON_KEYS["system_critical"], base)

    # Windows 目录下的东西一律 CRITICAL。这条放在发布者判断之前是刻意的：
    # System32 里一个没有签名信息的 dll 仍然动不得。
    if low_path.startswith(("c:\\windows\\", "%systemroot%", "%windir%")):
        if "\\temp\\" not in low_path and "\\softwaredistribution\\" not in low_path:
            return Verdict(Importance.CRITICAL, _REASON_KEYS["system_critical"], "windows")

    # 3. 发布者
    if publisher:
        hit = _contains_any(publisher, _DRIVER_PUBLISHERS)
        if hit:
            return Verdict(Importance.DRIVER, _REASON_KEYS["driver_publisher"], publisher)
        hit = _contains_any(publisher, _COMMON_PUBLISHERS)
        if hit:
            return Verdict(Importance.COMMON, _REASON_KEYS["known_publisher"], publisher)

    # 5'. 垃圾特征先于"装在 Program Files 就算常用"判——推广软件也会好好装进
    #     Program Files，位置本身骗不了人，名字特征才骗不了人。
    junk_hit = _JUNK_NAME_RE.search(name) or (path and _JUNK_NAME_RE.search(os.path.basename(path)))
    suspicious_dir = any(part in low_path for part in _SUSPICIOUS_DIR_PARTS)

    if junk_hit and signed is not True:
        return Verdict(Importance.JUNK, _REASON_KEYS["junk_signature"],
                       junk_hit.group(0) if hasattr(junk_hit, "group") else "")
    if suspicious_dir and signed is not True:
        return Verdict(Importance.JUNK, _REASON_KEYS["suspicious_location"], path)

    # 4. 使用痕迹与安装位置
    if recently_used or has_shortcut:
        return Verdict(Importance.COMMON, _REASON_KEYS["recently_used"], name)
    if low_path.startswith(("c:\\program files", "c:\\program files (x86)")):
        return Verdict(Importance.COMMON, _REASON_KEYS["in_program_files"], path)

    if signed is True:
        return Verdict(Importance.OPTIONAL, _REASON_KEYS["signed_unknown"], publisher or name)
    if signed is False:
        return Verdict(Importance.OPTIONAL, _REASON_KEYS["unsigned_unknown"], name)

    # 6. 兜底：**OPTIONAL，不是 JUNK**
    return Verdict(Importance.OPTIONAL, _REASON_KEYS["unknown"], name)


def classify_startup(
    *,
    name: str,
    command: str,
    publisher: str = "",
    whitelist: Optional[Set[str]] = None,
    signed: Optional[bool] = None,
) -> Verdict:
    """自启项。跟通用判定的差别只有一处：命令行里可能带引号和参数，
    要先剥出真正的可执行文件路径再判位置。"""
    exe = _executable_from_command(command)
    return classify(
        name=name,
        publisher=publisher,
        path=exe,
        signed=signed,
        whitelist=whitelist,
    )


def _executable_from_command(command: str) -> str:
    """从注册表 Run 值里剥出可执行文件路径。

    要处理带引号路径、不带引号但路径含空格的 exe、以及 rundll32 加 dll 三种写法。不带引号的不能按空格切，
    得从左往右试到第一个真实存在的 .exe；切错会把 `C:\\Program` 当路径，所有带空格路径的软件都掉进 OPTIONAL。"""
    command = (command or "").strip()
    if not command:
        return ""
    if command.startswith('"'):
        end = command.find('"', 1)
        return command[1:end] if end > 0 else command[1:]

    parts = command.split(" ")
    for i in range(1, len(parts) + 1):
        candidate = " ".join(parts[:i])
        if candidate.lower().endswith((".exe", ".dll", ".bat", ".cmd", ".vbs")):
            return candidate
        try:
            if os.path.exists(os.path.expandvars(candidate)):
                return candidate
        except (OSError, ValueError):
            pass
    return parts[0]


def reason_keys() -> Tuple[str, ...]:
    """给 i18n 守卫用：所有可能返回的 reason 键。
    界面必须为每一个都提供六语文案，漏一个就会在真实机器上显示原始键。"""
    return tuple(sorted(set(_REASON_KEYS.values())))
