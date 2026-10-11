"""跨层契约的机械检查，专抓"不报错但功能无效"。只报机械可判定的事实，假阳性会让整个检查被忽略；
转成测试是因为它守的东西每轮都可能被碰坏。"""

import json
import re
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

FV = PROJECT_ROOT / "modules" / "file_vault"
UI = FV / "ui" / "src"
BACKEND_SRC = (FV / "backend_server.py").read_text(encoding="utf-8")


def _registered_rpcs() -> set:
    return set(re.findall(r'^\s*"([a-z0-9_]+)":\s*rpc_', BACKEND_SRC, re.M))


def test_every_rpc_the_ui_calls_actually_exists():
    """改名/手滑的后果是运行时 "Unknown method"，而它发生在一次异步调用里——
    很多调用点只看 res.ok，于是表现成"点了没反应"。"""
    used = set()
    for source in UI.rglob("*.ts*"):
        for m in re.finditer(r"vaultApi\.call\(\s*'([a-z0-9_]+)'", source.read_text(encoding="utf-8")):
            used.add(m.group(1))
    assert used, "一个 vaultApi.call 都没扫到，说明这条检查本身失效了"
    missing = sorted(used - _registered_rpcs())
    assert missing == [], f"界面调用了后端没注册的 RPC：{missing}"


def test_ipctypes_has_no_ghost_rpcs():
    """声明了但后端已经删掉/改名的——类型上看着能调，运行时必然失败。"""
    types = (UI / "shared" / "ipcTypes.ts").read_text(encoding="utf-8")
    block = types[types.index("VaultMethods"):]
    declared = set(re.findall(r"^  ([a-z][a-z0-9_]+):\s*\{$", block, re.M))
    ghost = sorted(declared - _registered_rpcs())
    assert ghost == [], f"ipcTypes 声明了但后端没有的 RPC：{ghost}"


def test_rpc_signature_matches_which_table_it_is_registered_in():
    """收 `request_id` 的 RPC 必须在 _METHODS_WITH_PROGRESS 里，反之亦然；弄反会在调用时抛
    TypeError，被 dispatch 包成无信息的 `internal.unexpected`。"""
    two_arg = set(re.findall(r"^def rpc_([a-z0-9_]+)\(params, request_id\)", BACKEND_SRC, re.M))
    one_arg = set(re.findall(r"^def rpc_([a-z0-9_]+)\(params\)", BACKEND_SRC, re.M))
    assert two_arg and one_arg, "两种签名都该扫得到，扫不到说明正则跟代码对不上了"

    start = BACKEND_SRC.index("_METHODS_WITH_PROGRESS: Dict[str, Callable] = {")
    block = BACKEND_SRC[start : BACKEND_SRC.index("}", start)]
    backgrounded = {fn for _, fn in re.findall(r'"([a-z0-9_]+)":\s*rpc_([a-z0-9_]+)', block)}

    assert sorted(two_arg - backgrounded) == [], "收 request_id 却没注册进 _METHODS_WITH_PROGRESS"
    assert sorted(backgrounded & one_arg) == [], "只收 params 却注册在 _METHODS_WITH_PROGRESS 里"


LOCALES = UI / "i18n" / "locales"
LANGS = sorted(d.name for d in LOCALES.iterdir() if d.is_dir())

# 代码里用模板字符串拼出来的键族。npm run lint 的静态检查看不到这些
# （它只认字面量 t('key')），而少一个的表现是界面显示原始键名、不报错。
DYNAMIC_KEY_FAMILIES = [
    ("clipboard", "type.", ["text", "url", "email", "phone", "formula", "code", "name", "image"]),
    ("notes", "categorySortMode.", ["custom", "name", "count", "recent"]),
]


@pytest.mark.parametrize("namespace,prefix,suffixes", DYNAMIC_KEY_FAMILIES)
def test_dynamic_i18n_key_families_are_complete(namespace, prefix, suffixes):
    for lang in LANGS:
        data = json.loads((LOCALES / lang / f"{namespace}.json").read_text(encoding="utf-8"))
        missing = [f"{prefix}{s}" for s in suffixes if f"{prefix}{s}" not in data]
        assert missing == [], f"{lang}/{namespace}.json 缺：{missing}"


def test_all_languages_have_the_same_namespace_files():
    """少一个整文件，那种语言的一整块界面会回落成显示键名。"""
    per_lang = {d.name: {f.stem for f in d.glob("*.json")} for d in LOCALES.iterdir() if d.is_dir()}
    every = set().union(*per_lang.values())
    for lang, files in sorted(per_lang.items()):
        assert sorted(every - files) == [], f"{lang} 缺整个 namespace 文件"
