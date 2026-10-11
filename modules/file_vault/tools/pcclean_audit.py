"""清理套件四表对账 —— 专抓「不报错、但功能是死的」这一类 bug。

## 为什么需要它

这个套件由四张互相独立的表拼起来：

    ① 后端扫描类目   `pcclean/service.py::_scanners()`
    ② 前端调用点     `ui/src/**` 里的 `scan('x')` / `SCAN_MODES` / `CATEGORY_ORDER`
    ③ 文案键         `ui/src/i18n/locales/<lang>/pcclean.json`
    ④ IPC 通道       `ipcTypes.ts` ↔ `pythonBridge.ts` ↔ `backend_server.py`

四张表**没有任何一处强制它们一致**。少一行的后果不是崩溃，是安静地什么都
不发生：注册了 scanner 却没人调用 = 那个功能永远不跑；有类目没文案 =
界面显示 `category.custom` 这串原始键；有 IPC 类型没有后端方法 = 点了没反应。

这三种在屏幕上都不长得像错误。真实发生过的一条：**自定义清理规则**能新建、
能保存、`scan_custom` 也写好了，但整个前端从来没有发起过 `scan('custom')`
——这个功能上线之后一次都没有执行过，而没有任何测试会失败。

## 用法

    python -X utf8 modules/file_vault/tools/pcclean_audit.py

只读，不改任何文件。发现 ERROR 级问题时退出码 1，可以直接挂进 CI。
`--json` 输出机器可读格式。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Dict, List, Set, Tuple

ROOT = Path(__file__).resolve().parents[1]          # modules/file_vault
UI = ROOT / "ui" / "src"
LOCALES = UI / "i18n" / "locales"
LANGS = ("zh", "en", "es", "fr", "ru", "ar")

# i18next 的复数后缀。zh 只有 `_other`，ru/ar 有 `_few`/`_many`/`_two`——
# 各语言不一样是**正确的**，拿它当"缺翻译"报出来只会制造噪声。
_PLURAL_SUFFIX = re.compile(r"_(zero|one|two|few|many|other)$")


class Findings:
    def __init__(self) -> None:
        self.rows: List[Tuple[str, str, str]] = []

    def error(self, area: str, msg: str) -> None:
        self.rows.append(("ERROR", area, msg))

    def warn(self, area: str, msg: str) -> None:
        self.rows.append(("WARN", area, msg))

    def info(self, area: str, msg: str) -> None:
        self.rows.append(("INFO", area, msg))

    @property
    def errors(self) -> int:
        return sum(1 for level, _, _ in self.rows if level == "ERROR")


def _read(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except OSError:
        return ""


def _flatten(obj: Dict, prefix: str = "") -> Set[str]:
    out: Set[str] = set()
    for key, value in obj.items():
        name = f"{prefix}.{key}" if prefix else key
        if isinstance(value, dict):
            out |= _flatten(value, name)
        else:
            out.add(name)
    return out


def _base_keys(keys: Set[str]) -> Set[str]:
    """去掉复数后缀之后的键名集合。跨语言比对只能在这一层做。"""
    return {_PLURAL_SUFFIX.sub("", k) for k in keys}


# ① 后端类目

def backend_categories() -> Set[str]:
    """从 `_scanners()` 的字典字面量里抠出类目名。

    用正则而不是 import：import 会把整个后端连同 winreg / ctypes 一起拉起来，
    在 CI 的 Linux 容器里根本跑不了，而这个检查恰恰最该在 CI 里跑。
    """
    src = _read(ROOT / "pcclean" / "service.py")
    block = re.search(r"def _scanners\(self\).*?\n        \}", src, re.S)
    if not block:
        return set()
    return set(re.findall(r'^\s{12}"([A-Za-z]+)":', block.group(0), re.M))


def health_categories() -> Set[str]:
    src = _read(ROOT / "pcclean" / "service.py")
    block = re.search(r"HEALTH_CATEGORIES = \((.*?)\)", src, re.S)
    if not block:
        return set()
    return set(re.findall(r'"([A-Za-z]+)"', block.group(1)))


def toolbox_ids() -> Set[str]:
    src = _read(ROOT / "pcclean" / "toolbox.py")
    declared = set(re.findall(r'Tool\("([A-Za-z]+)"', src))
    handlers = re.search(r"HANDLERS: Dict.*?\n\}", src, re.S)
    handled = set(re.findall(r'"([A-Za-z]+)":', handlers.group(0))) if handlers else set()
    return declared | handled


def toolbox_split() -> Tuple[Set[str], Set[str]]:
    src = _read(ROOT / "pcclean" / "toolbox.py")
    declared = set(re.findall(r'Tool\("([A-Za-z]+)"', src))
    handlers = re.search(r"HANDLERS: Dict.*?\n\}", src, re.S)
    handled = set(re.findall(r'"([A-Za-z]+)":', handlers.group(0))) if handlers else set()
    return declared, handled


# ② 前端调用点

def ui_sources() -> List[Path]:
    return [p for p in UI.rglob("*.ts*") if p.is_file()]


def ui_referenced_categories() -> Set[str]:
    """前端**真的会去扫**的类目。

    三个来源缺一不可：
      · `scan('x')` —— 各面板自己发起的单类扫描
      · `SCAN_MODES` 里的 categories —— 一键体检会扫的
      · `CATEGORY_ORDER` —— 体检页会渲染出来的
    只看其中一个会漏判：某一类可能进了体检但没有独立面板，反之亦然。
    """
    found: Set[str] = set()
    for path in ui_sources():
        text = _read(path)
        found |= set(re.findall(r"scan\(\s*'([A-Za-z]+)'", text))
        found |= set(re.findall(r"category:\s*'([A-Za-z]+)'", text))
        # 面板里的类目多经自有 hook 调用（`useScanTab('bigFiles', 'big')`、`useDisableList('contextMenu', 'menu')`），
        # 不认这一层会把正常功能误报成"死功能"；总误报的守卫等于没有。
        found |= set(re.findall(r"use[A-Za-z]*\(\s*'([A-Za-z]+)'\s*,", text))
    lib = _read(UI / "lib" / "pcclean.ts")
    for block in re.findall(r"categories:\s*\[(.*?)\]", lib, re.S):
        found |= set(re.findall(r"'([A-Za-z]+)'", block))
    for name in ("CATEGORY_ORDER", "SPACE_CATEGORIES", "SOFTWARE_CATEGORIES"):
        for path in ui_sources():
            block = re.search(rf"{name}\s*=\s*\[(.*?)\]", _read(path), re.S)
            if block:
                found |= set(re.findall(r"'([A-Za-z]+)'", block.group(1)))
    return found


def ui_referenced_keys() -> Set[str]:
    """代码里静态写死的 `t('a.b')`。模板串（`t(\\`x.${y}\\`)`）抓不到，
    那部分由下面的类目/工具对账兜住。"""
    keys: Set[str] = set()
    for path in ui_sources():
        text = _read(path)
        keys |= set(re.findall(r"\bt(?:Clean)?\(\s*'([a-zA-Z0-9_.]+)'", text))
    return {k for k in keys if "." in k}


# ④ IPC 三方对账

def ipc_declared() -> Set[str]:
    text = _read(UI / "shared" / "ipcTypes.ts")
    return set(re.findall(r"^\s{2}(pcclean_[a-z_]+)\s*[:?]", text, re.M))


def ipc_backend() -> Set[str]:
    text = _read(ROOT / "backend_server.py")
    return set(re.findall(r'"(pcclean_[a-z_]+)":', text))


def ipc_timeout_overrides() -> Set[str]:
    text = _read(ROOT / "ui" / "electron" / "pythonBridge.ts")
    return set(re.findall(r"^\s+(pcclean_[a-z_]+):\s*[\d_]+", text, re.M))


# 主流程

def audit() -> Findings:
    f = Findings()

    locale_keys: Dict[str, Set[str]] = {}
    for lang in LANGS:
        path = LOCALES / lang / "pcclean.json"
        try:
            locale_keys[lang] = _flatten(json.loads(_read(path)))
        except (ValueError, OSError):
            f.error("i18n", f"{lang}/pcclean.json 读不出来或不是合法 JSON")
            locale_keys[lang] = set()

    # --- ① ↔ ② 后端类目有没有人调 -----------------------------------------
    backend = backend_categories()
    referenced = ui_referenced_categories()
    health = health_categories()
    if not backend:
        f.error("scanner", "没能从 service.py 解析出任何扫描类目——正则该更新了")
    for category in sorted(backend - referenced):
        f.error(
            "dead-feature",
            f"类目 `{category}` 在后端注册了 scanner，但前端从来不调用它。"
            f"这个功能不会报错，只是永远不执行。",
        )
    for category in sorted(referenced - backend):
        f.error(
            "ghost-call",
            f"前端会扫 `{category}`，但后端 `_scanners()` 里没有它 → 必然拿到 "
            f"`pcclean.scan.unknownCategory`。",
        )
    for category in sorted(health - backend):
        f.error("health", f"HEALTH_CATEGORIES 里的 `{category}` 不是已注册的 scanner")

    # --- ① ↔ ③ 每个类目都得有文案 ------------------------------------------
    for category in sorted(backend):
        for lang in LANGS:
            if f"category.{category}" not in locale_keys[lang]:
                f.error(
                    "i18n-missing",
                    f"{lang}: 缺 `category.{category}` → 界面会原样显示这串键，"
                    f"而且不报错。",
                )

    # --- 工具箱：声明表 ↔ 执行表 ↔ 文案 ------------------------------------
    declared, handled = toolbox_split()
    for tool in sorted(declared - handled):
        f.error("toolbox", f"工具 `{tool}` 在 TOOLS 里声明了但 HANDLERS 里没有实现 → 点了报 unknownTool")
    for tool in sorted(handled - declared):
        f.warn("toolbox", f"工具 `{tool}` 有实现但没进 TOOLS → 界面上根本看不到它")
    for tool in sorted(declared):
        for lang in LANGS:
            for suffix in ("label", "description"):
                if f"toolbox.{tool}.{suffix}" not in locale_keys[lang]:
                    f.error("i18n-missing", f"{lang}: 缺 `toolbox.{tool}.{suffix}`")

    # --- ④ IPC 三方 ---------------------------------------------------------
    declared_ipc = ipc_declared()
    backend_ipc = ipc_backend()
    if not declared_ipc:
        f.warn("ipc", "没从 ipcTypes.ts 解析出 pcclean 通道——正则可能过期了")
    for channel in sorted(declared_ipc - backend_ipc):
        f.error("ipc", f"`{channel}` 在 ipcTypes 里有类型，但 backend_server 没有这个方法 → 调用必然失败")
    for channel in sorted(backend_ipc - declared_ipc):
        f.warn("ipc", f"`{channel}` 后端实现了但前端没有类型声明 → 前端够不着它")

    # 长任务必须在静默超时白名单里。**这是本项目栽过的坑**：
    # 桥接层默认 20 秒不出声就判负，而体检/清理动辄跑几分钟。
    slow = {"pcclean_scan", "pcclean_health_check", "pcclean_execute",
            "pcclean_preview", "pcclean_run_tool", "pcclean_optimize_volume",
            "pcclean_uninstall", "pcclean_undo", "pcclean_memory_purge_standby"}
    overrides = ipc_timeout_overrides()
    for channel in sorted(slow & backend_ipc - overrides):
        f.error(
            "timeout",
            f"`{channel}` 是长任务但不在 pythonBridge 的静默超时白名单里 → "
            f"跑过 20 秒会被误判成后端没响应。",
        )

    # --- ③ 跨语言一致性 -----------------------------------------------------
    union = set()
    for lang in LANGS:
        union |= _base_keys(locale_keys[lang])
    for lang in LANGS:
        missing = sorted(union - _base_keys(locale_keys[lang]))
        for key in missing[:40]:
            f.error("i18n-parity", f"{lang}: 缺 `{key}`（别的语言有）")
        if len(missing) > 40:
            f.error("i18n-parity", f"{lang}: 另有 {len(missing) - 40} 个键未列出")

    # --- ③ 代码引用的键是否存在 ---------------------------------------------
    zh = _base_keys(locale_keys["zh"])
    for key in sorted(ui_referenced_keys()):
        # 只查 pcclean 命名空间下的。别的命名空间不归这份对账管。
        head = key.split(".")[0]
        if head not in {k.split(".")[0] for k in zh}:
            continue
        if key not in zh:
            f.error("i18n-missing", f"代码里用了 `{key}`，zh/pcclean.json 里没有")

    if f.errors == 0:
        f.info("ok", "四表一致：没有发现「注册了但没人调」「有键没文案」「有类型没后端」")
    return f


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", action="store_true", help="输出 JSON")
    args = parser.parse_args()

    f = audit()
    if args.json:
        print(json.dumps(
            [{"level": lv, "area": ar, "message": ms} for lv, ar, ms in f.rows],
            ensure_ascii=False, indent=2,
        ))
    else:
        width = max((len(a) for _, a, _ in f.rows), default=4)
        for level, area, message in f.rows:
            print(f"[{level:5}] {area:<{width}}  {message}")
        print(f"\n共 {len(f.rows)} 条，其中 ERROR {f.errors} 条")
    return 1 if f.errors else 0


if __name__ == "__main__":
    sys.exit(main())
