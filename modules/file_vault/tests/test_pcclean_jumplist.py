"""跳转列表（jump list）保护的守卫，覆盖同一事故的第二、三条路径（第一条见 test_pcclean_safety.py）：

1. 工具箱「清空最近使用」直接 `entry.unlink()`，不经 `safety`、不进回收站、不写撤销日志、未标 dangerous。
2. 判据是两个硬编码 AppID 哈希，Win11 换版本即静默失效。

最重要的是 `test_parses_real_cfbf_*`：用真实字节流喂解析器，打桩测不出它能否认出真机的 `.automaticDestinations-ms`。
"""

from __future__ import annotations

import os
import struct
from pathlib import Path

import pytest

from modules.file_vault.pcclean import actions, privacy, safety, toolbox

# 手写的最小合法 CFBF（OLE 复合文档）夹具，
# 布局：头部(512) | 扇区0 FAT | 扇区1 目录 | 扇区2 miniFAT | 扇区3.. 数据。
# DestList 小（32 字节）走 mini stream，撑到 5000 字节走普通扇区链，两条路径都要有真实样本。

_SECTOR = 512
_MINI = 64
_ENDOFCHAIN = 0xFFFFFFFE
_FREESECT = 0xFFFFFFFF
_FATSECT = 0xFFFFFFFD
_SIGNATURE = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"


def _dir_entry(name: str, obj_type: int, start: int, size: int) -> bytes:
    entry = bytearray(128)
    encoded = name.encode("utf-16-le") + b"\x00\x00"
    entry[0:len(encoded)] = encoded
    struct.pack_into("<H", entry, 0x40, len(encoded))
    entry[0x42] = obj_type          # 1=存储 2=流 5=根
    entry[0x43] = 1                 # color
    struct.pack_into("<iii", entry, 0x44, -1, -1, -1)   # 左/右/子 = NOSTREAM
    struct.pack_into("<I", entry, 0x74, start)
    struct.pack_into("<Q", entry, 0x78, size)
    return bytes(entry)


def _destlist_payload(pinned: int, entries: int, version: int = 3) -> bytes:
    """DestList 流头部：0x00 版本，0x04 条目总数，**0x08 固定项数**。"""
    return struct.pack("<8I", version, entries, pinned, 0, entries, 0, 1, 0)


def build_jumplist(pinned: int = 0, entries: int = 4, *, big: bool = False,
                   stream_name: str = "DestList", version: int = 6,
                   empty: bool = False) -> bytes:
    """`version` 默认 6（真机 Windows 11 写的值，公开资料只提 1/3/4），免得夹具比真实文件乐观。
    `empty=True` 造长度为 0 的 DestList（起始扇区是链尾）：软件注册过但用户从没用过。"""
    payload = _destlist_payload(pinned, entries, version)
    if big:
        payload = payload + b"\x00" * (5000 - len(payload))
    use_mini = len(payload) < 4096

    sectors = {}
    fat = [_FREESECT] * 128
    fat[0] = _FATSECT
    fat[1] = _ENDOFCHAIN        # 目录链
    fat[2] = _ENDOFCHAIN        # miniFAT 链
    mini_fat = [_FREESECT] * 128

    if use_mini:
        n_mini = max(1, -(-len(payload) // _MINI))
        for i in range(n_mini):
            mini_fat[i] = _ENDOFCHAIN if i == n_mini - 1 else i + 1
        container = payload + b"\x00" * (n_mini * _MINI - len(payload))
        root_size = len(container)
        n_sect = max(1, -(-len(container) // _SECTOR))
        container += b"\x00" * (n_sect * _SECTOR - len(container))
        for i in range(n_sect):
            sid = 3 + i
            sectors[sid] = container[i * _SECTOR:(i + 1) * _SECTOR]
            fat[sid] = _ENDOFCHAIN if i == n_sect - 1 else sid + 1
        root_start, stream_start = 3, 0
    else:
        n_sect = max(1, -(-len(payload) // _SECTOR))
        blob = payload + b"\x00" * (n_sect * _SECTOR - len(payload))
        for i in range(n_sect):
            sid = 3 + i
            sectors[sid] = blob[i * _SECTOR:(i + 1) * _SECTOR]
            fat[sid] = _ENDOFCHAIN if i == n_sect - 1 else sid + 1
        root_start, root_size, stream_start = _ENDOFCHAIN, 0, 3

    if empty:
        stream_start, stream_len = _ENDOFCHAIN, 0
    else:
        stream_len = len(payload)
    directory = (_dir_entry("Root Entry", 5, root_start, root_size)
                 + _dir_entry(stream_name, 2, stream_start, stream_len)
                 + bytes(128) * 2)

    sectors[0] = struct.pack("<128I", *fat)
    sectors[1] = directory
    sectors[2] = struct.pack("<128I", *mini_fat)

    header = bytearray(512)
    header[0:8] = _SIGNATURE
    struct.pack_into("<H", header, 0x18, 0x003E)   # minor version
    struct.pack_into("<H", header, 0x1A, 3)        # major version = v3
    struct.pack_into("<H", header, 0x1C, 0xFFFE)   # 小端标记
    struct.pack_into("<H", header, 0x1E, 9)        # 扇区 512 字节
    struct.pack_into("<H", header, 0x20, 6)        # mini 扇区 64 字节
    struct.pack_into("<I", header, 0x2C, 1)        # FAT 扇区数
    struct.pack_into("<I", header, 0x30, 1)        # 第一个目录扇区
    struct.pack_into("<I", header, 0x38, 4096)     # mini stream cutoff
    struct.pack_into("<I", header, 0x3C, 2)        # 第一个 miniFAT 扇区
    struct.pack_into("<I", header, 0x40, 1)        # miniFAT 扇区数
    struct.pack_into("<I", header, 0x44, _ENDOFCHAIN)   # 第一个 DIFAT 扇区
    struct.pack_into("<I", header, 0x48, 0)        # DIFAT 扇区数
    for i in range(109):
        struct.pack_into("<I", header, 0x4C + 4 * i, 0 if i == 0 else _FREESECT)

    body = b"".join(sectors[i] for i in range(max(sectors) + 1))
    return bytes(header) + body


def _write(tmp_path: Path, name: str, blob: bytes) -> Path:
    target = tmp_path / name
    target.write_bytes(blob)
    return target


# 解析器：真实字节流


@pytest.mark.parametrize("pinned", [0, 2, 7])
def test_parses_real_cfbf_mini_stream(tmp_path: Path, pinned: int):
    """DestList 落在 mini stream 里（真机上的常态）时读得出固定项数。"""
    path = _write(tmp_path, "a.automaticDestinations-ms",
                  build_jumplist(pinned=pinned, entries=9))
    assert safety.jumplist_pinned_count(path) == pinned


@pytest.mark.parametrize("pinned", [0, 2])
def test_parses_real_cfbf_regular_stream(tmp_path: Path, pinned: int):
    """流超过 cutoff（4096）时走普通扇区链，结论必须一样。"""
    path = _write(tmp_path, "b.automaticDestinations-ms",
                  build_jumplist(pinned=pinned, entries=9, big=True))
    assert safety.jumplist_pinned_count(path) == pinned


@pytest.mark.parametrize("version", [1, 3, 4, 6, 9])
def test_does_not_whitelist_destlist_version_numbers(tmp_path: Path, version: int):
    """版本号不许写死：DestList 公开版本是 1/3/4，真机 Windows 11 是 6。
    `version not in (1, 3, 4)` 会让所有跳转列表读不出来，保护静默退化回硬编码哈希；
    所以连没见过的 9 也要读得出来，把关交给一致性检查。"""
    path = _write(tmp_path, "c.automaticDestinations-ms",
                  build_jumplist(pinned=3, entries=5, version=version))
    assert safety.jumplist_pinned_count(path) == 3


def test_empty_destlist_counts_as_zero_not_unreadable(tmp_path: Path):
    """长度为 0 的 DestList 是"没有固定项"，不是"读不出来"；
    判成读不出来会让这批最该清的文件永远清不掉。"""
    path = _write(tmp_path, "empty.automaticDestinations-ms",
                  build_jumplist(empty=True))
    assert safety.jumplist_pinned_count(path) == 0
    assert safety.protection_reason(str(path)) == ""


@pytest.mark.skipif(os.name != "nt", reason="跳转列表是 Windows 独有的")
def test_parses_the_jump_lists_on_this_very_machine():
    """拿本机真实的 `AutomaticDestinations` 跑一遍：夹具只能证明解析器与我对规范的理解一致，
    真机文件才能证明 Windows 实际写出的内容读得出来。只断言解析成功率，不断言具体数字。"""
    root = Path(os.environ.get("APPDATA", "")) / "Microsoft" / "Windows" / "Recent" \
        / "AutomaticDestinations"
    if not root.is_dir():
        pytest.skip("本机没有 AutomaticDestinations 目录")
    files = sorted(root.glob("*.automaticDestinations-ms"))
    if not files:
        pytest.skip("本机没有任何跳转列表")

    verdicts = {f: safety.jumplist_pinned_count(f) for f in files}
    unreadable = [f.name for f, n in verdicts.items() if n is None]
    # 允许个别文件被 Explorer 独占而读不到，但不允许成片读不出来：
    # 那说明解析器在真机上没工作，而表现与"没有固定项"一模一样。
    assert len(unreadable) <= len(files) // 4, "读不出来的太多了：%s" % unreadable
    assert all(n >= 0 for n in verdicts.values() if n is not None)


# 解析器：读不出来的一律 None，且永不抛异常


def test_broken_inputs_return_none_and_never_raise(tmp_path: Path):
    """任何读不出来的情况都返回 None。`None` ≠ `0`：0 表示"读了，没有固定项，可以删"，
    把"读不懂"也说成 0 就等于"不认识就随便删"。"""
    good = build_jumplist(pinned=2)
    cases = {
        "empty": b"",
        "tiny": b"\x00" * 16,
        "not-cfbf": b"MZ" + b"\x00" * 4096,
        "header-only": good[:400],
        # 签名对、后面全是垃圾
        "garbage-body": good[:512] + b"\xa5" * 4096,
        # 扇区号指向文件外
        "bad-dir-pointer": (good[:0x30] + struct.pack("<I", 0x0000FF00)
                            + good[0x34:]),
        # 扇区大小字段不是 9/12
        "bad-sector-shift": good[:0x1E] + struct.pack("<H", 7) + good[0x20:],
        # 固定项比条目总数还多 —— 说明读到的不是这个字段
        "inconsistent-counts": build_jumplist(pinned=9, entries=2),
    }
    for name, blob in cases.items():
        path = _write(tmp_path, "%s.automaticDestinations-ms" % name, blob)
        assert safety.jumplist_pinned_count(path) is None, name

    # 目录里根本没有 DestList 流
    other = _write(tmp_path, "no-destlist.automaticDestinations-ms",
                   build_jumplist(pinned=2, stream_name="SomethingElse"))
    assert safety.jumplist_pinned_count(other) is None

    # 路径不存在 / 是个目录，同样只能返回 None
    assert safety.jumplist_pinned_count(tmp_path / "nope.bin") is None
    assert safety.jumplist_pinned_count(tmp_path) is None


# 判据接进 protection_reason


def test_pinned_file_is_protected_regardless_of_its_appid(tmp_path: Path):
    """有固定项就拦，不管 AppID 哈希在不在白名单；以前只认两个写死的哈希，换版本或别的软件的钉选就失去保护。"""
    unknown = _write(tmp_path, "deadbeefcafe1234.automaticDestinations-ms",
                     build_jumplist(pinned=2, entries=8))
    assert safety.protection_reason(str(unknown)) == \
        "pcclean.safety.protected.quickAccessPinned"


def test_file_without_pinned_entries_stays_deletable(tmp_path: Path):
    """反向守卫：没有固定项的跳转列表必须还能清掉，否则隐私清理这一项什么都清不了。"""
    plain = _write(tmp_path, "deadbeefcafe1234.automaticDestinations-ms",
                   build_jumplist(pinned=0, entries=12))
    assert safety.protection_reason(str(plain)) == ""


def test_hardcoded_whitelist_still_covers_unparseable_files(tmp_path: Path):
    """解析失败时退回硬编码白名单，**保护不能因为读不懂而消失**。"""
    for name in sorted(safety.PINNED_JUMPLIST_FILES):
        broken = _write(tmp_path, name, b"not a compound file at all")
        assert safety.protection_reason(str(broken)) == \
            "pcclean.safety.protected.quickAccessPinned", name

    # 白名单外的、同样读不懂的文件仍然是可清的痕迹
    stranger = _write(tmp_path, "1b4dd67f29cb1962.automaticDestinations-ms",
                      b"not a compound file at all")
    assert safety.protection_reason(str(stranger)) == ""


def test_path_guard_agrees_with_protection_reason_on_real_files(tmp_path: Path):
    """带缓存的 PathGuard 不能因为快而给出不同答案。"""
    pinned = _write(tmp_path, "aaaa1111bbbb2222.automaticDestinations-ms",
                    build_jumplist(pinned=1))
    plain = _write(tmp_path, "cccc3333dddd4444.automaticDestinations-ms",
                   build_jumplist(pinned=0))
    guard = safety.PathGuard()
    for _ in range(2):   # 第二遍走缓存
        for path in (pinned, plain):
            assert guard.check(path) == safety.protection_reason(str(path)), path


def test_delete_path_skips_pinned_jumplist_end_to_end(tmp_path: Path):
    """端到端：真的删一遍目录，带固定项的必须还在；保护逻辑没接进删除路径是这类 bug 最常见的复发方式。"""
    root = tmp_path / "AutomaticDestinations"
    root.mkdir()
    pinned = _write(root, "aaaa1111bbbb2222.automaticDestinations-ms",
                    build_jumplist(pinned=3))
    trace = _write(root, "cccc3333dddd4444.automaticDestinations-ms",
                   build_jumplist(pinned=0))

    freed, removed, _ = actions._delete_tree_contents(
        root, patterns=(), min_age_days=0, include_dirs=False)

    assert pinned.exists(), "带固定项的跳转列表被删了 —— 用户的快速访问没了"
    assert not trace.exists(), "没有固定项的痕迹没清掉，隐私清理等于失效"
    assert removed == 1 and freed > 0


def test_scan_side_counts_the_same_protected_files(tmp_path: Path):
    """扫描侧报的"受保护 N 项"必须与执行侧真正跳过的对得上，否则界面承诺的可释放空间永远对不上账。"""
    root = tmp_path / "AutomaticDestinations"
    root.mkdir()
    _write(root, "aaaa1111bbbb2222.automaticDestinations-ms", build_jumplist(pinned=3))
    _write(root, "cccc3333dddd4444.automaticDestinations-ms", build_jumplist(pinned=0))

    guarded_bytes, guarded_count = privacy._protected_within(root)
    assert guarded_count == 1
    assert guarded_bytes > 0


# 工具箱那条后门


def test_clear_recent_docs_is_marked_dangerous():
    """没有 dangerous=True，界面连二次确认都不弹（见 PcCleanToolboxScreen）。"""
    tool = next(t for t in toolbox.TOOLS if t.tool_id == "clearRecentDocs")
    assert tool.dangerous is True


class _FakeRecycler:
    """记下每次"进回收站"的路径，并真的把文件挪走（模拟删除效果）。"""

    def __init__(self, bin_dir: Path):
        self.bin_dir = bin_dir
        self.calls = []

    def __call__(self, path):
        target = Path(path)
        self.calls.append(target)
        try:
            target.replace(self.bin_dir / target.name)
        except OSError:
            return False, "failed"
        return True, ""


@pytest.fixture
def recent_tree(tmp_path: Path, monkeypatch):
    recent = tmp_path / "Recent"
    auto = recent / "AutomaticDestinations"
    custom = recent / "CustomDestinations"
    for folder in (recent, auto, custom):
        folder.mkdir(parents=True)

    pinned = _write(auto, "aaaa1111bbbb2222.automaticDestinations-ms",
                    build_jumplist(pinned=2))
    trace = _write(auto, "cccc3333dddd4444.automaticDestinations-ms",
                   build_jumplist(pinned=0))
    lnk = _write(recent, "report.lnk", b"a recent-file shortcut")
    custom_dest = _write(custom, "eeee5555.customDestinations-ms", b"app jump list")

    monkeypatch.setattr(toolbox.paths, "known",
                        lambda name: recent if name == "Recent" else None)
    bin_dir = tmp_path / "RecycleBin"
    bin_dir.mkdir()
    recycler = _FakeRecycler(bin_dir)
    monkeypatch.setattr(actions, "recycle", recycler)

    def _no_unlink(self, *_a, **_kw):
        raise AssertionError("clearRecentDocs 又在直接 unlink：%s" % self)

    monkeypatch.setattr(Path, "unlink", _no_unlink)
    return {"recent": recent, "pinned": pinned, "trace": trace,
            "lnk": lnk, "custom": custom_dest, "recycler": recycler}


def test_clear_recent_docs_protects_pinned_and_uses_recycle_bin(recent_tree):
    """此工具曾是整套保护的后门（直接 unlink，不进回收站，不写日志）；
    现在必须与执行侧一致：受保护的跳过，其余进回收站。`Path.unlink` 已被换成会炸的版本。"""
    result = toolbox.tool_clear_recent_docs({})

    assert result["ok"] is True
    assert recent_tree["pinned"].exists(), "带固定项的跳转列表被清掉了"
    assert not recent_tree["trace"].exists()
    assert not recent_tree["lnk"].exists()
    assert not recent_tree["custom"].exists()

    assert result["removed"] == 3
    assert result["skipped"] == 1
    assert result["skippedReasons"] == ["pcclean.safety.protected.quickAccessPinned"]
    assert result["freed_bytes"] > 0

    recycled = {p.name for p in recent_tree["recycler"].calls}
    assert recycled == {recent_tree["trace"].name, recent_tree["lnk"].name,
                        recent_tree["custom"].name}


def test_clear_recent_docs_writes_an_undo_journal(recent_tree, tmp_path: Path):
    """删过的东西要能在「清理记录」里找到。"""
    data_dir = tmp_path / "data"
    result = toolbox.tool_clear_recent_docs({"data_dir": str(data_dir)})

    assert result["session_id"]
    sessions = actions.list_sessions(data_dir)
    assert len(sessions) == 1
    assert sessions[0]["session_id"] == result["session_id"]
    assert sessions[0]["entry_count"] == 3
    assert sessions[0]["reversible_count"] == 3


def test_run_tool_never_lets_the_caller_pick_the_data_dir(recent_tree, tmp_path: Path):
    """`data_dir` 只能由后端注入。前端传上来的同名字段一律丢掉——
    "往哪个目录写日志"不是渲染层能决定的事。"""
    forged = tmp_path / "forged"
    result = toolbox.run_tool("clearRecentDocs", {"data_dir": str(forged)})
    assert result["ok"] is True
    assert result["session_id"] == ""
    assert not forged.exists()


# CustomDestinations 单独成规则


def test_custom_destinations_is_its_own_rule_and_off_by_default():
    """`CustomDestinations` 不是 CFBF，无法逐条判 pin，且应用不主动重新注册就永不恢复，只能由用户自己勾。
    规则 id 是前后端契约（i18n 键由它派生），改名会让界面显示原始 key。"""
    rules = {r.key: r for r in privacy.PRIVACY_RULES}
    assert "jumpListsCustom" in rules
    assert rules["jumpListsCustom"].default_selected is False
    assert rules["jumpListsCustom"].target == "CustomDestinations"

    # `AutomaticDestinations` 那一条留在默认勾选：固定项已经被逐个文件拦住了，
    # 把整条规则也关掉等于用"什么都不清"换安全。
    assert rules["jumpLists"].default_selected is True
    assert rules["jumpLists"].target == "AutomaticDestinations"

    # 两条规则指向的目录必须不一样，否则拆分等于没拆。
    assert rules["jumpLists"].resolve is not rules["jumpListsCustom"].resolve
