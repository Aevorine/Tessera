"""解锁之前那半个应用，不许对着需要解锁的接口裸奔。

背景：每次冷启动日志固定多出 `file_manager_shortcuts_get 返回错误 (auth.not_unlocked)`
和「未处理的异步失败」。速查卡（ShortcutCheatSheet）挂在 App 最外层，登录页上也挂着（故意），
挂载即调该 RPC，其首行 `_require_imk()` 在未解锁时抛错，pythonBridge reject，
而调用处 `void ...then(...)` 没人接住。

后端与前端各自看都正常，只有拼起来才是 bug，所以守卫必须能同时读两边。
判据：解锁前可达的组件里，调用「需要解锁」RPC 的 Promise 链上必须有 `.catch`
（或被 `await` 交给调用方的 try）；允许调用，但必须优雅降级。
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

MODULE_ROOT = Path(__file__).resolve().parent.parent
BACKEND = MODULE_ROOT / "backend_server.py"
UI_SRC = MODULE_ROOT / "ui" / "src"


# 一、后端：哪些 RPC 必须先解锁


def _unlock_required_methods() -> set[str]:
    src = BACKEND.read_text(encoding="utf-8")

    starts = [(m.start(), m.group(1)) for m in re.finditer(r"^def (rpc_\w+)\(", src, re.M)]
    assert starts, "一个 rpc_ 函数都没找到，正则多半过时了"

    bodies: dict[str, str] = {}
    for i, (pos, name) in enumerate(starts):
        end = starts[i + 1][0] if i + 1 < len(starts) else len(src)
        bodies[name] = src[pos:end]

    # `_require_imk()` 直接要 IMK；`_require_xxx_service()` 那一族的函数体
    # 第一行也是同一个 `auth.not_unlocked`，对调用方是同一件事。
    needs = {
        name
        for name, body in bodies.items()
        if "_require_imk" in body or re.search(r"_require_\w+_service", body)
    }

    pairs: dict[str, str] = {}
    for table_name in ("_METHODS", "_METHODS_WITH_PROGRESS"):
        table = re.search(rf"{table_name}(?::[^=]*)?\s*=\s*\{{(.*?)\n\}}", src, re.S)
        if table:
            pairs.update(dict(re.findall(r'"([\w]+)":\s*(rpc_\w+)', table.group(1))))
    assert pairs, "方法表一条都没解析出来，正则多半过时了"

    return {method for method, fn in pairs.items() if fn in needs}


# 二、前端：解锁前哪些文件是可达的

# `lazy(() => import('...'))` 是解锁那道门。AppShell 及其身后的十个面板全在
# 门后面，只有 view === 'app' 时才加载，不算解锁前可达。
_LAZY_IMPORT_RE = re.compile(r"lazy\(\s*\(\)\s*=>\s*import\(")
_STATIC_IMPORT_RE = re.compile(r"""^\s*import\s+(?:[\w{}*,\s]+\s+from\s+)?['"](@/[^'"]+)['"]""", re.M)


def _resolve(spec: str) -> Path | None:
    """把 `@/lib/foo` 解析成真实文件。"""
    base = UI_SRC / spec[2:]
    for candidate in (
        base.with_suffix(".ts"),
        base.with_suffix(".tsx"),
        base / "index.ts",
        base / "index.tsx",
    ):
        if candidate.exists():
            return candidate
    return None


def _strip_lazy_imports(text: str) -> str:
    """把 lazy(() => import('X')) 里的路径抹掉，免得被当成静态依赖跟进去。"""
    return _LAZY_IMPORT_RE.sub("lazy(() => LAZY_BOUNDARY(", text)


def _pre_unlock_files() -> dict[Path, str]:
    """从 App.tsx / main.tsx 出发，沿**静态** import 走，遇 lazy 边界停。"""
    roots = [UI_SRC / "App.tsx", UI_SRC / "main.tsx"]
    for root in roots:
        assert root.exists(), f"入口文件不见了：{root}"

    seen: dict[Path, str] = {}
    queue = list(roots)
    while queue:
        path = queue.pop()
        if path in seen:
            continue
        text = path.read_text(encoding="utf-8")
        seen[path] = text
        for spec in _STATIC_IMPORT_RE.findall(_strip_lazy_imports(text)):
            resolved = _resolve(spec)
            if resolved is not None and resolved not in seen:
                queue.append(resolved)
    return seen


# 三、把一次调用的整条 Promise 链取出来


def _chain_from(text: str, open_paren: int) -> str:
    """从 `.call(` 的左括号起，配平括号，并把后面链着的 .then/.catch/.finally 一起吃掉。"""
    i, depth = open_paren, 0
    in_str: str | None = None
    while i < len(text):
        ch = text[i]
        if in_str:
            if ch == "\\":
                i += 2
                continue
            if ch == in_str:
                in_str = None
            i += 1
            continue
        if ch in "\"'`":
            in_str = ch
        elif ch in "([{":
            depth += 1
        elif ch in ")]}":
            depth -= 1
            if depth == 0:
                rest = text[i + 1 :]
                cont = re.match(r"^\s*\.\s*(?:then|catch|finally)\s*\(", rest)
                if cont:
                    i += cont.end()
                    depth = 1
                    continue
                return text[open_paren : i + 1]
        i += 1
    return text[open_paren:]


def _call_sites(text: str) -> list[tuple[str, int, str, str]]:
    """返回 (方法名, 行号, 整条链, 调用前那一行的前缀)。"""
    out = []
    for m in re.finditer(r"""\.call\(\s*['"](\w+)['"]""", text):
        method = m.group(1)
        open_paren = text.index("(", m.start())
        chain = _chain_from(text, open_paren)
        line_no = text.count("\n", 0, m.start()) + 1
        line_start = text.rfind("\n", 0, m.start()) + 1
        out.append((method, line_no, chain, text[line_start : m.start()]))
    return out


# 用例


@pytest.fixture(scope="module")
def unlock_required() -> set[str]:
    return _unlock_required_methods()


@pytest.fixture(scope="module")
def pre_unlock() -> dict[Path, str]:
    return _pre_unlock_files()


def test_backend_classification_is_not_vacuous(unlock_required):
    # 没有这一条，上面的正则一旦过时就会返回空集合，下面每一条断言都会在
    # "没有任何接口需要解锁"的前提下愉快通过——全绿，实际什么都没检查。
    assert len(unlock_required) > 50, f"只认出 {len(unlock_required)} 个需解锁接口，正则多半过时了"
    assert "file_manager_shortcuts_get" in unlock_required
    assert "note_get" in unlock_required
    # 反面：解锁本身和诊断日志绝不能需要解锁，否则用户根本进不去、也留不下记录。
    assert "unlock_password" not in unlock_required
    assert "identity_exists" not in unlock_required
    assert "diagnostic_log_record" not in unlock_required


def test_pre_unlock_reachability_is_not_vacuous(pre_unlock):
    names = {p.name for p in pre_unlock}
    assert "App.tsx" in names
    assert "LoginScreen.tsx" in names, "登录页必须算解锁前可达"
    assert "ShortcutCheatSheet.tsx" in names, "速查卡挂在 App 最外层，登录页上也在"
    # lazy 边界要真的挡住：AppShell 及其身后的面板不该被算进来。
    assert "AppShell.tsx" not in names, "AppShell 是 lazy 加载的，不该被当成解锁前可达"
    assert "NotesScreen.tsx" not in names


def test_pre_unlock_calls_to_locked_rpcs_must_be_caught(pre_unlock, unlock_required):
    """锁屏时必然失败的调用，必须有人接住。"""
    offenders = []
    for path, text in sorted(pre_unlock.items()):
        for method, line_no, chain, prefix in _call_sites(text):
            if method not in unlock_required:
                continue
            awaited = "await" in prefix  # 交给调用方的 try/catch
            if ".catch(" in chain or awaited:
                continue
            rel = path.relative_to(MODULE_ROOT.parent.parent)
            offenders.append(f"{rel}:{line_no} 调用了需解锁的 {method}，但整条链上没有 .catch")

    assert not offenders, (
        "解锁前可达的代码里有对「需要解锁」接口的裸调用。锁屏时它必然 reject，"
        "而没人接住的 rejection 会变成一条信息量为零的 [ui] 未处理的异步失败：\n  "
        + "\n  ".join(offenders)
    )


def test_the_known_offender_stays_fixed(pre_unlock):
    """点名守住 2026-08-19 那一处，防止哪天被"顺手简化"回去。"""
    hook = UI_SRC / "lib" / "useShortcutRows.ts"
    assert hook in pre_unlock, "useShortcutRows 必须仍是解锁前可达的（速查卡在用）"
    text = pre_unlock[hook]
    sites = [s for s in _call_sites(text) if s[0] == "file_manager_shortcuts_get"]
    assert len(sites) == 1, "useShortcutRows 里应该正好一处调用"
    assert ".catch(" in sites[0][2], "那条链上的 .catch 被删了——锁屏时又会变成未处理拒绝"
    # `void x.then(...)` 是当初骗过 linter 的写法，别再回去。
    assert "void vaultApi" not in text, "别再用 void 掩盖没有 .catch 的 Promise"
