"""数据目录迁移（源码树 → %LOCALAPPDATA%）。搬坏的后果是数据没了，所以多测"不该发生什么"：
不丢数据、不删旧目录、中断后不留看似可用的半成品、用户显式指定目录时不擅自搬家。"""

import json
import sqlite3
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from modules.file_vault import data_dir


def _make_legacy(tmp_path: Path) -> Path:
    """造一个像模像样的旧数据目录：身份库 + 一个数据库 + 一个附件目录 +
    一些**不该**被搬走的开发资产。"""
    legacy = tmp_path / "legacy"
    legacy.mkdir()
    (legacy / "identity_store.json").write_text(json.dumps({"slots": ["fake"]}), encoding="utf-8")
    (legacy / "app_settings.json").write_text(json.dumps({"theme": "dark"}), encoding="utf-8")

    conn = sqlite3.connect(legacy / "clipboard.db")
    conn.execute("CREATE TABLE items (id INTEGER PRIMARY KEY, text TEXT)")
    conn.executemany("INSERT INTO items (text) VALUES (?)", [(f"entry {i}",) for i in range(50)])
    conn.commit()
    conn.close()

    images = legacy / "clipboard_images"
    images.mkdir()
    for i in range(3):
        (images / f"img{i}.png").write_bytes(b"fake png bytes")

    # 白名单之外的东西：~300MB 的 VS Code 模板（开发资产）和缓存
    template = legacy / "vscode_profile_template"
    template.mkdir()
    (template / "settings.json").write_text("{}", encoding="utf-8")
    (legacy / "some_cache.tmp").write_bytes(b"junk")
    return legacy


# --- 何时该迁移、何时不该 --------------------------------------------------


def test_explicit_env_var_disables_migration_entirely(tmp_path, monkeypatch):
    """用户显式指定了路径就绝不自动迁移：他在管理该目录（可能在同步盘或加密卷），擅自搬到
    LOCALAPPDATA 越权，且会让他的同步/备份失效。"""
    legacy = _make_legacy(tmp_path)
    explicit = tmp_path / "my-own-place"
    monkeypatch.setenv(data_dir.DATA_DIR_ENV, str(explicit))

    resolved = data_dir.resolve_data_dir(legacy)

    assert resolved == explicit
    assert (legacy / "identity_store.json").exists()  # 旧目录纹丝未动
    assert not (explicit / "identity_store.json").exists()  # 也没往新目录塞东西


def test_migrates_when_only_the_legacy_dir_has_a_vault(tmp_path, monkeypatch):
    legacy = _make_legacy(tmp_path)
    target = tmp_path / "localappdata" / "data"
    monkeypatch.delenv(data_dir.DATA_DIR_ENV, raising=False)
    monkeypatch.setattr(data_dir, "default_data_dir", lambda: target)

    resolved = data_dir.resolve_data_dir(legacy)

    assert resolved == target
    assert (target / "identity_store.json").exists()


def test_does_not_migrate_when_the_target_already_has_a_vault(tmp_path, monkeypatch):
    """新目录已经有金库就直接用——再搬一次会用旧数据覆盖掉更新的。"""
    legacy = _make_legacy(tmp_path)
    target = tmp_path / "localappdata" / "data"
    target.mkdir(parents=True)
    (target / "identity_store.json").write_text(json.dumps({"slots": ["newer"]}), encoding="utf-8")
    monkeypatch.delenv(data_dir.DATA_DIR_ENV, raising=False)
    monkeypatch.setattr(data_dir, "default_data_dir", lambda: target)

    data_dir.resolve_data_dir(legacy)

    assert json.loads((target / "identity_store.json").read_text(encoding="utf-8"))["slots"] == ["newer"]


def test_fresh_install_just_uses_the_new_dir(tmp_path, monkeypatch):
    target = tmp_path / "localappdata" / "data"
    monkeypatch.delenv(data_dir.DATA_DIR_ENV, raising=False)
    monkeypatch.setattr(data_dir, "default_data_dir", lambda: target)

    resolved = data_dir.resolve_data_dir(None)

    assert resolved == target
    assert target.is_dir()


# --- 搬了什么、没搬什么 ----------------------------------------------------


def test_migration_copies_the_whitelisted_payload(tmp_path):
    legacy = _make_legacy(tmp_path)
    target = tmp_path / "target"

    data_dir.migrate(legacy, target)

    assert (target / "identity_store.json").exists()
    assert (target / "app_settings.json").exists()
    assert (target / "clipboard.db").exists()
    assert len(list((target / "clipboard_images").iterdir())) == 3


def test_migration_skips_dev_assets_not_on_the_whitelist(tmp_path):
    """白名单存在的理由：data/ 里混着 ~300MB 的 VS Code 模板配置和各种缓存，
    它们是开发资产不是用户数据，搬过去只是白占磁盘还让迁移慢好几倍。"""
    legacy = _make_legacy(tmp_path)
    target = tmp_path / "target"

    data_dir.migrate(legacy, target)

    assert not (target / "vscode_profile_template").exists()
    assert not (target / "some_cache.tmp").exists()


def test_migration_preserves_database_contents(tmp_path):
    """用 SQLite backup API 而不是裸拷文件——裸拷会漏掉 WAL 里还没 checkpoint
    的事务，得到一个缺数据甚至损坏的副本。"""
    legacy = _make_legacy(tmp_path)
    target = tmp_path / "target"

    data_dir.migrate(legacy, target)

    conn = sqlite3.connect(target / "clipboard.db")
    rows = conn.execute("SELECT COUNT(*) FROM items").fetchone()[0]
    conn.close()
    assert rows == 50


def test_migration_copies_data_committed_only_to_the_wal(tmp_path):
    """WAL 模式下已提交的事务可能还只在 -wal 文件里，主 .db 尚未包含它们。
    这正是必须用 backup API 的原因——这个测试就是那个理由的可执行版本。"""
    legacy = tmp_path / "legacy"
    legacy.mkdir()
    (legacy / "identity_store.json").write_text("{}", encoding="utf-8")
    conn = sqlite3.connect(legacy / "notes.db")
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("CREATE TABLE n (id INTEGER PRIMARY KEY, body TEXT)")
    conn.commit()
    conn.executemany("INSERT INTO n (body) VALUES (?)", [(f"note {i}",) for i in range(100)])
    conn.commit()
    # 刻意**不** checkpoint、**不**关闭连接——模拟"应用还开着"的状态
    target = tmp_path / "target"

    data_dir.migrate(legacy, target)
    conn.close()

    copied = sqlite3.connect(target / "notes.db")
    assert copied.execute("SELECT COUNT(*) FROM n").fetchone()[0] == 100
    copied.close()


def test_migration_never_deletes_the_source(tmp_path):
    """迁移成功后旧数据原样留着——对一个装着身份库和密码库的目录来说，
    这点磁盘占用换来的可回退性非常划算。"""
    legacy = _make_legacy(tmp_path)
    target = tmp_path / "target"

    data_dir.migrate(legacy, target)

    assert (legacy / "identity_store.json").exists()
    assert (legacy / "clipboard.db").exists()
    assert (legacy / "clipboard_images" / "img0.png").exists()


# --- 完成标记与幂等 --------------------------------------------------------


def test_migration_writes_a_completion_marker(tmp_path):
    """标记的存在与否是"这个目录能不能直接用"的唯一判据。不能靠"目录里有没有
    文件"判断——一次中断的迁移也会留下一堆文件。"""
    legacy = _make_legacy(tmp_path)
    target = tmp_path / "target"

    data_dir.migrate(legacy, target)

    assert data_dir.migration_completed(target)


def test_migration_is_idempotent(tmp_path):
    legacy = _make_legacy(tmp_path)
    target = tmp_path / "target"
    data_dir.migrate(legacy, target)
    # 迁移后在新目录改点东西，再迁一次不该覆盖它
    (target / "app_settings.json").write_text(json.dumps({"theme": "light"}), encoding="utf-8")

    data_dir.migrate(legacy, target)

    assert json.loads((target / "app_settings.json").read_text(encoding="utf-8"))["theme"] == "light"


def test_a_half_finished_target_is_not_treated_as_migrated(tmp_path):
    """没有完成标记的目录哪怕已经有一堆文件，也必须重跑整个迁移——
    否则用户会拿到一个数据残缺的金库。"""
    legacy = _make_legacy(tmp_path)
    target = tmp_path / "target"
    target.mkdir()
    (target / "app_settings.json").write_text("{}", encoding="utf-8")  # 半成品残留

    assert not data_dir.migration_completed(target)
    data_dir.migrate(legacy, target)

    assert data_dir.migration_completed(target)
    assert (target / "identity_store.json").exists()


# --- 失败与并发 ------------------------------------------------------------


def test_migration_fails_loudly_when_the_identity_store_is_unreadable(tmp_path):
    """身份库是"能不能解锁"的根。它坏了必须抛异常让调用方继续用旧目录，
    绝不能让用户面对一个打不开的金库。"""
    legacy = tmp_path / "legacy"
    legacy.mkdir()
    (legacy / "identity_store.json").write_text("这不是合法的 JSON {{{", encoding="utf-8")
    target = tmp_path / "target"

    with pytest.raises(data_dir.MigrationError):
        data_dir.migrate(legacy, target)

    assert not data_dir.migration_completed(target)


def test_a_failed_migration_leaves_no_completion_marker(tmp_path):
    legacy = tmp_path / "legacy"
    legacy.mkdir()
    (legacy / "identity_store.json").write_text("坏的 {{{", encoding="utf-8")
    target = tmp_path / "target"

    with pytest.raises(data_dir.MigrationError):
        data_dir.migrate(legacy, target)

    # 下次启动会重试——不会因为一次失败就永远卡住
    (legacy / "identity_store.json").write_text("{}", encoding="utf-8")
    data_dir.migrate(legacy, target)
    assert data_dir.migration_completed(target)


def test_a_held_lock_blocks_a_concurrent_migration(tmp_path):
    """两个实例同时搬会互相覆盖。锁用 O_CREAT|O_EXCL（文件系统层面原子的
    "不存在才创建"），比"先 exists() 再 create"可靠——后者两次调用之间有窗口。"""
    legacy = _make_legacy(tmp_path)
    target = tmp_path / "target"
    target.mkdir(parents=True)
    (target / data_dir.MIGRATION_LOCK).write_text(json.dumps({"pid": 1, "at": 0}), encoding="utf-8")

    with pytest.raises(data_dir.MigrationError):
        data_dir.migrate(legacy, target)


def test_a_stale_lock_is_cleared_so_a_crash_does_not_block_forever(tmp_path):
    """持锁进程崩溃时锁文件会留下。没有过期机制的话，一次崩溃会让应用永远
    迁移不了——每次启动都失败，而且原因完全不可见。"""
    import os
    import time

    legacy = _make_legacy(tmp_path)
    target = tmp_path / "target"
    target.mkdir(parents=True)
    lock = target / data_dir.MIGRATION_LOCK
    lock.write_text("{}", encoding="utf-8")
    stale = time.time() - data_dir.MIGRATION_LOCK_STALE_SECONDS - 60
    os.utime(lock, (stale, stale))

    data_dir.migrate(legacy, target)

    assert data_dir.migration_completed(target)


def test_resolve_falls_back_to_the_legacy_dir_when_migration_fails(tmp_path, monkeypatch):
    """迁移失败时应用照常可用——用户不该因为一次搬家失败就打不开自己的金库。"""
    legacy = _make_legacy(tmp_path)
    target = tmp_path / "target"
    monkeypatch.delenv(data_dir.DATA_DIR_ENV, raising=False)
    monkeypatch.setattr(data_dir, "default_data_dir", lambda: target)

    def boom(*_args, **_kwargs):
        raise data_dir.MigrationError("simulated failure")

    monkeypatch.setattr(data_dir, "migrate", boom)

    assert data_dir.resolve_data_dir(legacy) == legacy


def test_no_staging_directory_is_left_behind(tmp_path):
    """暂存目录必须清理干净——留下来的话下次迁移会在一堆 .staging-* 里面找不着北，
    而且它们装的是用户数据的完整副本，白白占一份磁盘。"""
    legacy = _make_legacy(tmp_path)
    target = tmp_path / "nested" / "target"

    data_dir.migrate(legacy, target)

    leftovers = [p for p in target.parent.iterdir() if p.name.startswith(".staging-")]
    assert leftovers == []
