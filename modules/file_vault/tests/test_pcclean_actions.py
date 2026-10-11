"""清理套件执行链路的守卫。

scanner 都是只读的，单测碰不到删除路径；而首版回收站删除每次都抛异常：
`ctypes.c_wchar_p` 拒绝嵌入 NUL，`SHFileOperationW` 入参却必须双 NUL 结尾，
异常被外层 `except Exception` 吞掉后像"文件被占用"。只测函数不跑真实链路等于没测。
"""

import os
import time
from pathlib import Path

import pytest

from modules.file_vault.pcclean import actions
from modules.file_vault.pcclean.model import CleanItem, Importance
from modules.file_vault.pcclean.service import PcCleanService

WINDOWS_ONLY = pytest.mark.skipif(os.name != "nt", reason="清理套件只在 Windows 上有意义")


def _remember(svc: PcCleanService, items):
    """把条目塞进 service 扫描缓存；execute 只认缓存对象、不认前端传入（安全设计），
    测试须走同一路径。"""
    svc._remember(type("Report", (), {"items": items})())


@WINDOWS_ONLY
def test_回收站删除不能因为嵌入NUL而失败(tmp_path):
    """就是那条 bug 的最小复现：能删掉，且返回的不是异常名。"""
    target = tmp_path / "到回收站去.txt"
    target.write_text("内容", encoding="utf-8")

    ok, err = actions.recycle(target)

    assert ok, f"recycle() 失败了：{err}"
    assert err == "", f"不该有错误，却拿到 {err!r}"
    assert not target.exists(), "文件还在，说明根本没删"
    # 特别拦这一个：它是原来的失败形态，报成 status=failed 时看起来像文件被占用
    assert err != "ValueError", "又回到了 c_wchar_p 拒绝嵌入 NUL 那个坑"


@WINDOWS_ONLY
def test_锁死项后端一定拒绝哪怕前端传上来(tmp_path):
    """`locked` 是不可信输入的最后一道闸：前端禁用勾选框只是给人看的。"""
    svc = PcCleanService(tmp_path)
    victim = tmp_path / "系统关键.dat"
    victim.write_text("x", encoding="utf-8")

    item = CleanItem(
        item_id="t:locked", category="junk", label="系统关键",
        path=str(victim), importance=Importance.CRITICAL, locked=True,
    )
    _remember(svc, [item])

    result = svc.execute(["t:locked"])

    assert result["outcomes"][0]["status"] == "skipped"
    assert result["outcomes"][0]["error"] == "pcclean.execute.lockedItem"
    assert victim.exists(), "锁死项竟然被删了"


@WINDOWS_ONLY
def test_CRITICAL级别就算没打locked也拒绝(tmp_path):
    """两道判据是**或**的关系。只看 `locked` 的话，一个漏打标记的
    CRITICAL 项就会被执行——而 CRITICAL 的含义正是"删了 Windows 会出事"。"""
    svc = PcCleanService(tmp_path)
    victim = tmp_path / "忘了打标记.dat"
    victim.write_text("x", encoding="utf-8")

    item = CleanItem(
        item_id="t:critical", category="junk", label="忘了打标记",
        path=str(victim), importance=Importance.CRITICAL, locked=False,
    )
    _remember(svc, [item])

    result = svc.execute(["t:critical"])

    assert result["outcomes"][0]["status"] == "skipped"
    assert victim.exists()


@WINDOWS_ONLY
def test_硬删报出来的字节数必须和实际删掉的相符(tmp_path):
    """虚报"释放了 X GB"是这类工具最常见的谎。"""
    svc = PcCleanService(tmp_path)
    junk = tmp_path / "cache"
    junk.mkdir()
    old = time.time() - 3 * 86400
    expected = 0
    for i in range(5):
        f = junk / f"b{i}.tmp"
        f.write_bytes(b"x" * 40_000)
        os.utime(f, (old, old))
        expected += 40_000

    item = CleanItem(
        item_id="t:junk", category="junk", label="cache",
        size_bytes=expected, path=str(junk), importance=Importance.JUNK,
        detail={"min_age_days": 1.0, "include_dirs": True, "patterns": []},
    )
    _remember(svc, [item])

    result = svc.execute(["t:junk"], {"create_restore_point": False})

    assert result["freed_bytes"] == expected, "报出来的释放量跟实际删掉的对不上"
    assert not list(junk.iterdir()), "还有文件没删掉"


@WINDOWS_ONLY
def test_用户自己的文件走回收站而不是永久删除(tmp_path):
    """分类决定删除方式。走错的代价是用户的文件真的没了。"""
    svc = PcCleanService(tmp_path)
    mine = tmp_path / "我的文件.txt"
    mine.write_text("重要", encoding="utf-8")

    for category in ("bigFiles", "duplicates", "downloads", "leftovers"):
        mine.write_text("重要", encoding="utf-8")
        item = CleanItem(
            item_id=f"t:{category}", category=category, label=mine.name,
            size_bytes=mine.stat().st_size, path=str(mine),
            importance=Importance.COMMON,
        )
        _remember(svc, [item])
        result = svc.execute([f"t:{category}"], {"create_restore_point": False})
        outcome = result["outcomes"][0]
        assert outcome["status"] == "done", f"{category}: {outcome['error']}"
        assert outcome["undo_token"] == "recycle_bin", (
            f"{category} 没走回收站——用户的文件会被永久删除"
        )


@WINDOWS_ONLY
def test_撤销要如实报告哪些恢复不了(tmp_path):
    """把不可逆的部分说成"已全部还原"是骗人。"""
    svc = PcCleanService(tmp_path)
    junk = tmp_path / "cache"
    junk.mkdir()
    old = time.time() - 3 * 86400
    f = junk / "a.tmp"
    f.write_bytes(b"x" * 1000)
    os.utime(f, (old, old))

    item = CleanItem(
        item_id="t:hard", category="junk", label="cache",
        size_bytes=1000, path=str(junk), importance=Importance.JUNK,
        detail={"min_age_days": 1.0, "include_dirs": True, "patterns": []},
    )
    _remember(svc, [item])
    result = svc.execute(["t:hard"], {"create_restore_point": False})

    undo = svc.undo(result["session_id"])
    assert undo["irreversible"] >= 1, "删掉的缓存回不来，但撤销没说"


@WINDOWS_ONLY
def test_扫描结果过期就不许拿来动手(tmp_path):
    """拿十五分钟前的路径去删文件，那个路径上现在是什么谁也不知道。"""
    svc = PcCleanService(tmp_path)
    result = svc.execute(["从来没扫到过的东西"])
    assert result["ok"] is False
    assert result["error"] == "pcclean.execute.staleSelection"
