"""前后端 `ok` 字段的握手，对不上时没有任何东西报错。
`dispatch()` 原样塞回处理器返回值，不会补 `"ok": True`，而界面几乎处处是无 else 的
`if (res.ok)`，漏字段的表现是开关没反应、列表永远空。TypeScript 也拦不住：
ipcTypes.ts 的 `result: { ok: true; … }` 只是声明，跨语言没有编译器，
所以本测试把该声明当规格，核对 Python 处理器是否兑现。
"""

import ast
import re
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[1]
_BACKEND = _ROOT / "backend_server.py"
_IPC_TYPES = _ROOT / "ui" / "src" / "shared" / "ipcTypes.ts"


def _method_to_handler(tree: ast.Module) -> dict:
    """从 _METHODS / _METHODS_WITH_PROGRESS 里取「方法名 → 处理器函数名」。"""
    mapping = {}
    for node in ast.walk(tree):
        target_names = []
        value = None
        if isinstance(node, ast.Assign):
            target_names = [t.id for t in node.targets if isinstance(t, ast.Name)]
            value = node.value
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            target_names = [node.target.id]
            value = node.value
        if not set(target_names) & {"_METHODS", "_METHODS_WITH_PROGRESS"}:
            continue
        if isinstance(value, ast.Dict):
            for key, val in zip(value.keys, value.values):
                if isinstance(key, ast.Constant) and isinstance(val, ast.Name):
                    mapping[key.value] = val.id
    return mapping


def _methods_declaring_ok() -> set:
    """ipcTypes.ts 里 result 类型带 `ok: true` 的方法名。"""
    text = _IPC_TYPES.read_text(encoding="utf-8")
    found = set()
    pattern = r"^  (\w+):\s*\{\s*\n\s*params:[^\n]*\n\s*result:\s*([^\n]*(?:\n\s{4,}[^\n]*)*)"
    for match in re.finditer(pattern, text, re.M):
        if "ok: true" in match.group(2):
            found.add(match.group(1))
    return found


def _returns_without_ok(func: ast.FunctionDef) -> list:
    """返回字典字面量却没有 "ok" 键的 return 行号；
    `{**something}` 形式跳过，键运行时才展开，静态看不出，且 `{"ok": True, **status}` 本就是常见形态。"""
    bad = []
    for node in ast.walk(func):
        if not (isinstance(node, ast.Return) and isinstance(node.value, ast.Dict)):
            continue
        if any(key is None for key in node.value.keys):
            continue
        keys = {k.value for k in node.value.keys if isinstance(k, ast.Constant)}
        if "ok" not in keys:
            bad.append(node.lineno)
    return bad


def test_handlers_return_the_ok_field_their_ts_contract_promises():
    tree = ast.parse(_BACKEND.read_text(encoding="utf-8"))
    handlers = {n.name: n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef)}
    mapping = _method_to_handler(tree)
    declared = _methods_declaring_ok()

    # 规格本身得先是真的存在的，否则正则一改这个测试就静默变成空跑。
    assert len(declared) > 100, f"只从 ipcTypes.ts 解析出 {len(declared)} 个方法，正则大概是失配了"
    assert "diagnostic_log_status" in declared

    offenders = []
    for method in sorted(declared):
        handler_name = mapping.get(method)
        if handler_name is None or handler_name not in handlers:
            continue
        for lineno in _returns_without_ok(handlers[handler_name]):
            offenders.append(f"{method} → {handler_name}() 第 {lineno} 行的 return 没有 ok")

    assert not offenders, (
        "这些处理器的 TS 契约声明了 ok: true，但 Python 这边没返回它。"
        "界面上的 `if (res.ok)` 会静默失败——不报错，只是永远不生效：\n  "
        + "\n  ".join(offenders)
    )
