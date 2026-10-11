"""数据目录的位置配置（安装程序写的 data-location.json）与应用内「更改位置」请求的搬家。

与 test_data_dir_migration.py 分工：那边测源码树 → LOCALAPPDATA 的一次性迁移，这边测用户自定
金库位置的链路（配置读取、损坏处理、搬家何时拒绝、为何必须推迟到下次启动）。位置配置出错的
后果是应用安静地打开空金库，用户以为数据没了，所以多是"不该发生什么"的测试。
"""

import json
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from modules.file_vault import data_dir


@pytest.fixture
def app_root(tmp_path, monkeypatch):
    """把 local_app_data_root() 指到 tmp，免得测试写到真实的 %LOCALAPPDATA%。"""
    root = tmp_path / "approot"
    root.mkdir()
    monkeypatch.setattr(data_dir, "local_app_data_root", lambda: root)
    monkeypatch.delenv(data_dir.DATA_DIR_ENV, raising=False)
    return root


def _make_vault(directory: Path) -> Path:
    """一个"有身份库"的目录——_has_identity() 认这个文件。"""
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "identity_store.json").write_text(json.dumps({"slots": ["fake"]}), encoding="utf-8")
    return directory


# --- 配置文件的读写 --------------------------------------------------------


def test_no_config_falls_back_to_default_location(app_root):
    assert data_dir.default_data_dir() == app_root / "data"


def test_configured_dir_is_used(app_root, tmp_path):
    custom = tmp_path / "D_drive" / "MyVault"
    data_dir.write_configured_data_dir(custom)
    assert data_dir.default_data_dir() == custom


def test_write_then_read_roundtrip(app_root, tmp_path):
    custom = tmp_path / "vault with spaces"
    data_dir.write_configured_data_dir(custom)
    assert data_dir.read_configured_data_dir() == custom


@pytest.mark.parametrize(
    "bad_content",
    [
        "not json at all",
        "{",                      # 被截断的写入
        "[]",                     # 合法 JSON 但不是对象
        '{"dataDir": ""}',        # 空字符串
        '{"dataDir": "   "}',     # 只有空白
        '{"dataDir": 42}',        # 类型不对
        "{}",                     # 没有这个键
    ],
)
def test_broken_config_falls_back_instead_of_crashing(app_root, bad_content):
    """坏配置一律当作"没有配置"：它只是偏好，绝不能因读不出而让应用起不来；安装程序写 JSON 时
    反斜杠未转义就会产生这些形态。"""
    data_dir.location_config_path().write_text(bad_content, encoding="utf-8")
    assert data_dir.read_configured_data_dir() is None
    assert data_dir.default_data_dir() == app_root / "data"


def test_config_write_is_atomic_no_partial_file_left(app_root, tmp_path):
    """写完之后不该留下 .tmp 残留——那说明原子改名没发生。"""
    data_dir.write_configured_data_dir(tmp_path / "vault")
    leftovers = list(app_root.glob("*.tmp"))
    assert leftovers == []


# --- 搬家请求的校验 --------------------------------------------------------


def test_move_to_same_location_is_rejected(app_root):
    current = data_dir.default_data_dir()
    with pytest.raises(data_dir.DataDirMoveError):
        data_dir.request_data_dir_move(current)


def test_move_into_own_subdirectory_is_rejected(app_root):
    """源和目标重叠，复制会自我嵌套。"""
    current = data_dir.default_data_dir()
    current.mkdir(parents=True, exist_ok=True)
    with pytest.raises(data_dir.DataDirMoveError):
        data_dir.request_data_dir_move(current / "inner")


def test_move_into_existing_vault_is_rejected(app_root, tmp_path):
    """目标里已经有一个金库：合并两个身份库没有正确答案，静默覆盖会毁掉一个。"""
    other = _make_vault(tmp_path / "someone_elses_vault")
    with pytest.raises(data_dir.DataDirMoveError):
        data_dir.request_data_dir_move(other)


def test_move_request_does_not_touch_any_data(app_root, tmp_path):
    """请求搬家不搬任何东西：运行时 SQLCipher 对 notes/clipboard/activity_log 开着连接且 WAL 未
    checkpoint，此时复制会得到缺数据的副本，所以 request 只写意图，搬运留到下次启动（无连接时）。"""
    source = _make_vault(app_root / "data")
    (source / "clipboard.db").write_bytes(b"pretend database")
    target = tmp_path / "new_place"

    data_dir.request_data_dir_move(target)

    # 旧目录原封不动
    assert (source / "identity_store.json").exists()
    assert (source / "clipboard.db").read_bytes() == b"pretend database"
    # 新目录只是被建出来了，是空的
    assert target.exists()
    assert not (target / "identity_store.json").exists()


def test_move_request_records_both_ends(app_root, tmp_path):
    _make_vault(app_root / "data")
    target = tmp_path / "new_place"
    previous = data_dir.request_data_dir_move(target)

    assert previous == app_root / "data"
    payload = json.loads(data_dir.location_config_path().read_text(encoding="utf-8"))
    assert Path(payload["dataDir"]) == target.resolve()
    assert Path(payload["moveFrom"]) == app_root / "data"


# --- 下次启动时执行搬家 ----------------------------------------------------


def test_pending_move_is_executed_on_next_resolve(app_root, tmp_path):
    source = _make_vault(app_root / "data")
    (source / "app_settings.json").write_text(json.dumps({"theme": "dark"}), encoding="utf-8")
    target = tmp_path / "new_place"

    data_dir.request_data_dir_move(target)
    resolved = data_dir.resolve_data_dir()

    assert resolved == target.resolve()
    assert (resolved / "identity_store.json").exists()
    assert json.loads((resolved / "app_settings.json").read_text(encoding="utf-8")) == {"theme": "dark"}


def test_old_directory_survives_the_move(app_root, tmp_path):
    """搬完不删源。误操作的人要能退回去。"""
    source = _make_vault(app_root / "data")
    target = tmp_path / "new_place"

    data_dir.request_data_dir_move(target)
    data_dir.resolve_data_dir()

    assert (source / "identity_store.json").exists()


def test_pending_marker_is_cleared_so_it_does_not_repeat(app_root, tmp_path):
    _make_vault(app_root / "data")
    target = tmp_path / "new_place"

    data_dir.request_data_dir_move(target)
    data_dir.resolve_data_dir()

    payload = json.loads(data_dir.location_config_path().read_text(encoding="utf-8"))
    assert "moveFrom" not in payload
    # 再解析一次也不该出事
    assert data_dir.resolve_data_dir() == target.resolve()


def test_failed_move_keeps_using_the_old_directory(app_root, tmp_path, monkeypatch):
    """搬失败时继续用旧目录，绝不回落到空的新目录（migrate 全程不删源，数据仍在旧目录）。"""
    source = _make_vault(app_root / "data")
    target = tmp_path / "new_place"
    data_dir.request_data_dir_move(target)

    def boom(*args, **kwargs):
        raise data_dir.MigrationError("disk full")

    monkeypatch.setattr(data_dir, "migrate", boom)
    assert data_dir.resolve_data_dir() == source


def test_failed_move_keeps_the_marker_for_a_retry(app_root, tmp_path, monkeypatch):
    _make_vault(app_root / "data")
    target = tmp_path / "new_place"
    data_dir.request_data_dir_move(target)

    monkeypatch.setattr(data_dir, "migrate", lambda *a, **k: (_ for _ in ()).throw(data_dir.MigrationError("nope")))
    data_dir.resolve_data_dir()

    payload = json.loads(data_dir.location_config_path().read_text(encoding="utf-8"))
    assert "moveFrom" in payload, "失败后必须保留标记，否则用户再也搬不过去了"


def test_move_marker_left_over_from_a_completed_move_is_not_replayed(app_root, tmp_path):
    """标记还在但目标已有金库（上次搬完、清标记前崩了）：绝不能再搬，否则旧数据会覆盖搬过来之后
    新写的内容。"""
    _make_vault(app_root / "data")
    target = _make_vault(tmp_path / "already_moved")
    (target / "notes.db").write_bytes(b"data written after the move")
    data_dir.write_configured_data_dir(target, move_from=app_root / "data")

    assert data_dir.resolve_data_dir() == target
    assert (target / "notes.db").read_bytes() == b"data written after the move"


# --- 环境变量的优先级 ------------------------------------------------------


def test_env_var_wins_over_configured_location(app_root, tmp_path, monkeypatch):
    """环境变量是"这一次运行用这个路径"，比配置文件更具体，所以优先。"""
    configured = tmp_path / "configured"
    override = tmp_path / "override"
    data_dir.write_configured_data_dir(configured)
    monkeypatch.setenv(data_dir.DATA_DIR_ENV, str(override))

    assert data_dir.resolve_data_dir() == override


def test_env_var_suppresses_a_pending_move(app_root, tmp_path, monkeypatch):
    """显式指定路径就绝不自动搬家——用户自己在管这个目录。"""
    source = _make_vault(app_root / "data")
    target = tmp_path / "new_place"
    data_dir.request_data_dir_move(target)

    override = tmp_path / "override"
    monkeypatch.setenv(data_dir.DATA_DIR_ENV, str(override))

    assert data_dir.resolve_data_dir() == override
    assert (source / "identity_store.json").exists()
    assert not (target / "identity_store.json").exists()
