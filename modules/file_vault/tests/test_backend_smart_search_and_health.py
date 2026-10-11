# -*- coding: utf-8 -*-
"""离线智能搜索和安全体检的端到端用例（真实 RPC，不 mock）。

单测证明不了"接进 backend_server 后还能用"：`rpc_global_search` 曾用 hashlib 却漏了 import，
又被 `try/except Exception` 吞成一行 warning，表现为密码库模糊搜索永远 0 条，单测、类型检查
全绿，只有走一遍 RPC 才看得见。
"""

from __future__ import annotations

# `client` 是一个 pytest fixture，它起一个真实的后端子进程并按 NDJSON 跟它对话。
# 它定义在 test_backend_server.py 里而不是 conftest.py 里——直接 import 过来，
# 而不是在这里再抄一份 BackendClient：那份 harness 有子进程清理、超时、编码
# 一堆细节，抄第二份的结果是两边慢慢分家，然后某一天其中一份开始测不出东西。
#
# noqa 是给 flake8 的：被 import 进来的 fixture 在本文件里"没有被用到"（它是靠
# 参数名注入的），而那正是 pytest 的工作方式。
from modules.file_vault.tests.test_backend_server import client  # noqa: F401


def _setup_and_unlock(client):
    client.call(
        "setup_complete",
        {
            "password": "test-password-" + "123",
            "totp_seed": "JBSWY3DPEHPK3PXP",
            "email_address": None,
            "recovery_key": "AAAA-BBBB-CCCC-DDDD",
        },
    )
    client.call("unlock_password", {"password": "test-password-" + "123"})



def test_pinyin_initials_find_chinese_notes(client):
    """输 "jdcwfp" 要能搜到「季度财务复盘」：SQLite FTS 按字切词，对拼音首字母无能为力。"""
    _setup_and_unlock(client)
    _, _, error = client.call(
        "note_create", {"title": "季度财务复盘", "category": "工作", "content": "本季支出明细"}
    )
    assert error is None
    _, _, error = client.call(
        "note_create", {"title": "购物清单", "category": "生活", "content": "牛奶鸡蛋"}
    )
    assert error is None

    result, _, error = client.call("global_search", {"query": "jdcwfp"})
    assert error is None
    titles = [r["label"] for r in result["results"] if r["module"] == "notes"]
    assert titles == ["季度财务复盘"], f"拼音首字母没搜到，拿到 {titles}"


def test_fuzzy_hits_are_marked_so_the_user_knows_why(client):
    """模糊命中必须带 fuzzy 标记，否则拼音首字母命中的结果看起来像搜错了，会损害对搜索框的信任。"""
    _setup_and_unlock(client)
    client.call("note_create", {"title": "季度财务复盘", "category": "工作", "content": "x"})

    result, _, _ = client.call("global_search", {"query": "jdcwfp"})
    fuzzy = [r for r in result["results"] if r["module"] == "notes"]
    assert fuzzy and fuzzy[0].get("fuzzy") is True

    # 精确命中**不能**带这个标记，否则这个标记就没有分辨力了。
    exact, _, _ = client.call("global_search", {"query": "财务"})
    hits = [r for r in exact["results"] if r["module"] == "notes"]
    assert hits and not hits[0].get("fuzzy")


def test_typo_still_finds_the_password_entry(client):
    """密码库那段最容易被静默吞掉：它整个包在 try/except Exception 里，NameError/AttributeError
    只会变成一行日志加 0 条结果，这条用例是它唯一的活体证据。"""
    _setup_and_unlock(client)
    _, _, error = client.call(
        "password_add",
        {"name": "Password Vault", "url": "https://example.com", "username": "me", "password": "x"},
    )
    assert error is None

    # passwrod = password 的相邻字母对调，打字最常见的错。
    result, _, error = client.call("global_search", {"query": "passwrod"})
    assert error is None
    labels = [r["label"] for r in result["results"] if r["module"] == "passwords"]
    assert labels, "错一个字母就一条都搜不到——密码库那段大概率被异常吞掉了"


def test_deleted_notes_never_come_back_from_the_index(client):
    """索引落后半拍时也绝不能交出已删除的记录；索引只给候选 id，最终结果必须回权威数据源核对。"""
    _setup_and_unlock(client)
    created, _, error = client.call(
        "note_create", {"title": "季度财务复盘", "category": "工作", "content": "x"}
    )
    assert error is None
    note_id = created["note"]["id"] if "note" in created else created["id"]

    # 先搜一次，把这条喂进索引
    first, _, _ = client.call("global_search", {"query": "jdcwfp"})
    assert any(r["module"] == "notes" for r in first["results"])

    _, _, error = client.call("note_delete", {"id": note_id})
    assert error is None

    after, _, _ = client.call("global_search", {"query": "jdcwfp"})
    assert not any(r["module"] == "notes" for r in after["results"]), "删掉的笔记又被搜出来了"


def test_limit_is_the_total_per_module_not_per_source(client):
    """`limit` 的契约是每个模块最多这么多条；模糊补充若在精确命中之外再补满一个 limit，
    实际会悄悄变成两倍且不报错。"""
    _setup_and_unlock(client)
    for i in range(7):
        client.call("note_create", {"title": f"预算复核 {i}", "category": "工作", "content": "预算"})

    capped, _, error = client.call("global_search", {"query": "预算", "limit": 3})
    assert error is None
    notes = [r for r in capped["results"] if r["module"] == "notes"]
    assert len(notes) <= 3, f"limit=3 却给了 {len(notes)} 条"


def test_repeated_searches_do_not_reread_the_whole_store(client):
    """连打四个字 = 四次 global_search，但整表只该读一遍。

    每次按键都要取"此刻全部内容"喂索引并核对候选，照直写会把整个剪贴板历史（上限十万条）从
    SQLite 读四遍，不报错，只是库大后搜索框变卡且难归因。
    """
    from modules.file_vault import backend_server as bs

    _setup_and_unlock(client)
    client.call("note_create", {"title": "季度财务复盘", "category": "工作", "content": "x"})

    # 直接验后端进程内的缓存函数：走 RPC 的话数不到读了几次。
    calls = []

    def loader():
        calls.append(1)
        return [{"id": 1, "title": "季度财务复盘"}]

    bs._invalidate_search_snapshots()
    for _ in range(4):
        bs._cached_rows("notes", loader)
    assert len(calls) == 1, f"四次查询读了 {len(calls)} 遍整表"


def test_any_write_drops_the_cached_snapshot(client):
    """缓存有效期是"到下一次非只读调用为止"而非一段时间：按秒过期会让删除后一秒内仍能搜到。
    走真实 RPC，新建笔记后搜索必须立刻看见。"""
    _setup_and_unlock(client)
    client.call("note_create", {"title": "季度财务复盘", "category": "工作", "content": "x"})
    first, _, _ = client.call("global_search", {"query": "jdcwfp"})
    assert len([r for r in first["results"] if r["module"] == "notes"]) == 1

    client.call("note_create", {"title": "季度成本分析", "category": "工作", "content": "x"})
    second, _, _ = client.call("global_search", {"query": "jdcbfx"})
    assert [r["label"] for r in second["results"] if r["module"] == "notes"] == ["季度成本分析"], (
        "刚建的笔记搜不到——快照没有在写操作之后作废"
    )


def test_readonly_whitelist_never_contains_a_writer(client):
    """白名单里混进会写的方法，表现为搜索返回已删除记录；此条钉死白名单，改动时迫使人想"它真的
    只读吗"。"""
    from modules.file_vault import backend_server as bs

    assert bs._SEARCH_SNAPSHOT_SAFE_METHODS == frozenset({
        "global_search",
        "clipboard_list",
        "note_list",
        "password_list",
        "activity_log_list",
        "security_health",
    })
    # 每一条都必须是真实存在的方法，否则白名单里躺着的是一个笔误。
    for name in bs._SEARCH_SNAPSHOT_SAFE_METHODS:
        assert name in bs._METHODS or name in bs._METHODS_WITH_PROGRESS, f"{name} 不是真实的 RPC"



def test_security_health_returns_a_checkable_score(client):
    """总分必须能由逐项明细复算出来——界面上原样写着这句话。"""
    _setup_and_unlock(client)
    result, _, error = client.call("security_health", {})
    assert error is None
    assert result["ok"] is True

    scored = [c for c in result["checks"] if c["status"] != "unknown"]
    assert scored, "一项都没测到，这次调用什么都没证明"
    earned = sum(c["earned"] for c in scored)
    weight = sum(c["weight"] for c in scored)
    assert weight == result["scoredWeight"]
    assert abs(result["score"] - round(earned / weight * 100)) <= 1


def test_security_health_sees_the_vault_it_just_created(client):
    """体检必须读到这个金库的真实状态而非一堆 unknown；全 unknown 的报告看起来像后端挂了，却不报错。"""
    _setup_and_unlock(client)
    result, _, _ = client.call("security_health", {})
    by_id = {c["id"]: c for c in result["checks"]}

    # _setup_and_unlock 建的金库有口令 + TOTP + 恢复密钥，所以这三项都该测得到
    assert by_id["kdf"]["status"] != "unknown"
    assert by_id["unlockMethods"]["status"] != "unknown"
    assert by_id["recoveryKey"]["status"] == "good", "刚设了恢复密钥却报没有"


def test_client_facts_are_merged_not_ignored(client):
    """跨设备那几项由界面采集后传上来。传了却不生效的话，那一屏会永远显示
    "跨设备服务没在运行"——而用户明明看着它在跑。"""
    _setup_and_unlock(client)
    without, _, _ = client.call("security_health", {})
    with_facts, _, _ = client.call(
        "security_health",
        {
            "clientFacts": {
                "crossdeviceRunning": True,
                "crossdevicePairedDevices": 2,
                "crossdeviceLastPathDirect": False,
            }
        },
    )

    a = {c["id"]: c for c in without["checks"]}["crossdevicePath"]
    b = {c["id"]: c for c in with_facts["checks"]}["crossdevicePath"]
    assert a["status"] == "unknown"
    assert b["status"] == "warn", "走中继该是提醒而不是失败，也不该还是 unknown"


def test_unknown_checks_stay_out_of_the_denominator(client):
    """没开的功能不该拉低分数——那会让分数从"你做得怎么样"滑向"你开了多少功能"。"""
    _setup_and_unlock(client)
    result, _, _ = client.call("security_health", {})
    unknown = [c for c in result["checks"] if c["status"] == "unknown"]
    assert result["unknownCount"] == len(unknown)
    assert result["scoredWeight"] == result["totalWeight"] - sum(c["weight"] for c in unknown)


def test_dependency_snapshot_is_actually_found(client):
    """依赖两项必须真的读到快照，不能永远显示"查不到"。

    快照在 `modules/file_vault/` 下，而 `runtime_resources.resource_path()` 相对仓库根；曾写成
    裸文件名，静默退回空 dict，与"没有快照"的正常表现无法区分。
    """
    from pathlib import Path

    snapshot = Path(__file__).resolve().parents[3] / "modules" / "file_vault" / "security-audit-snapshot.json"
    if not snapshot.is_file():
        # 快照是构建时生成的，不在仓库里也算正常（开发者刚 clone）。
        # 但**不能静默跳过**——静默跳过等于这条用例在 CI 上永远是空跑的。
        import pytest

        pytest.skip("仓库里没有 security-audit-snapshot.json，先跑 scripts/make_security_snapshot.py")

    _setup_and_unlock(client)
    result, _, _ = client.call("security_health", {})
    by_id = {c["id"]: c for c in result["checks"]}
    assert by_id["dependencies"]["status"] != "unknown", "快照在仓库里却读不到——路径又写错了"
    assert by_id["dependencyFreshness"]["status"] != "unknown"
    assert result["dependencyAuditScannedAt"] is not None


def test_security_health_requires_an_unlocked_vault(client):
    """体检读的是金库内部状态，锁着的时候必须拒绝，不能返回一份假的满分报告。"""
    result, _, error = client.call("security_health", {})
    assert error is not None or result.get("ok") is False
