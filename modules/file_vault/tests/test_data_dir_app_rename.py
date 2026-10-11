"""应用改名（Ideal1 File Vault → Tessera）后的数据迁移：老用户打开的必须是自己的金库而非空库。

此类 bug 不报错（应用正常提示"请先创建金库"，旧数据留在旧目录），所以断言身份库文件真的出现在
新目录里，而不只看返回路径。
"""

import json
import os
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from modules.file_vault import data_dir  # noqa: E402


@pytest.fixture
def app_data(tmp_path, monkeypatch):
    """把 %LOCALAPPDATA%（非 Windows 为 XDG_DATA_HOME）指到 tmp_path；两个都设，以便在 Linux CI 上跑，
    _app_data_root_for() 在两个平台读的环境变量不同。"""
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path))
    # 环境变量指定的数据目录会**完全跳过迁移**（那是用户自己管的目录），
    # 留着它会让下面每一条都测不到想测的东西。
    monkeypatch.delenv(data_dir.DATA_DIR_ENV, raising=False)
    return tmp_path


def _plant_vault(root: Path, marker: str = "old-vault") -> Path:
    """在 <root>/data 下造一个"看起来像真金库"的目录，返回它。"""
    d = root / "data"
    d.mkdir(parents=True, exist_ok=True)
    (d / "identity_store.json").write_text(json.dumps({"marker": marker}), encoding="utf-8")
    return d


def test_vault_from_the_old_app_name_is_migrated(app_data):
    legacy_root = app_data / "Ideal1 File Vault"
    legacy_data = _plant_vault(legacy_root)

    resolved = data_dir.resolve_data_dir()

    assert resolved == app_data / "Tessera" / "data"
    # 关键断言：身份库真的到了新目录，而不只是"函数返回了新路径"。
    payload = json.loads((resolved / "identity_store.json").read_text(encoding="utf-8"))
    assert payload["marker"] == "old-vault"
    # 旧目录必须原样保留——迁移出任何问题都要能手工退回去。
    assert (legacy_data / "identity_store.json").is_file()


def test_existing_new_vault_is_never_overwritten_by_the_old_one(app_data):
    """新目录已有金库时绝不能被旧目录覆盖：用户改名后先建了新金库并存了东西，再次迁移把旧的盖回去
    就是真正的数据损失。"""
    _plant_vault(app_data / "Ideal1 File Vault", marker="old-vault")
    _plant_vault(app_data / "Tessera", marker="current-vault")

    resolved = data_dir.resolve_data_dir()

    payload = json.loads((resolved / "identity_store.json").read_text(encoding="utf-8"))
    assert payload["marker"] == "current-vault"


def test_custom_location_configured_under_the_old_app_name_still_applies(app_data):
    """安装程序把"数据保存位置"写进的是当时应用名的目录；改名后只读新目录配置，会让把金库放在
    D:\\Vault 的老用户回落到默认目录、看到空金库。"""
    custom = app_data / "elsewhere" / "my-vault"
    custom.mkdir(parents=True)
    legacy_root = app_data / "Ideal1 File Vault"
    legacy_root.mkdir(parents=True)
    (legacy_root / data_dir.LOCATION_CONFIG_NAME).write_text(
        json.dumps({"dataDir": str(custom)}), encoding="utf-8"
    )

    assert data_dir.read_configured_data_dir() == custom
    assert data_dir.default_data_dir() == custom


def test_config_under_the_current_app_name_wins_over_the_legacy_one(app_data):
    """两边都有配置时，当前应用名的那份说了算——它是用户后来改过的。"""
    new_root = app_data / "Tessera"
    new_root.mkdir(parents=True)
    (new_root / data_dir.LOCATION_CONFIG_NAME).write_text(
        json.dumps({"dataDir": str(app_data / "new-choice")}), encoding="utf-8"
    )
    legacy_root = app_data / "Ideal1 File Vault"
    legacy_root.mkdir(parents=True)
    (legacy_root / data_dir.LOCATION_CONFIG_NAME).write_text(
        json.dumps({"dataDir": str(app_data / "old-choice")}), encoding="utf-8"
    )

    assert data_dir.read_configured_data_dir() == app_data / "new-choice"


def test_fresh_install_with_no_legacy_directory_just_uses_the_new_one(app_data):
    resolved = data_dir.resolve_data_dir()
    assert resolved == app_data / "Tessera" / "data"
    assert not (resolved / "identity_store.json").exists()


def test_legacy_directory_without_a_vault_is_not_migrated(app_data):
    """旧目录存在但里面没有身份库（比如只剩日志）——没什么可搬的，别瞎搬。"""
    legacy_root = app_data / "Ideal1 File Vault"
    (legacy_root / "data").mkdir(parents=True)
    (legacy_root / "data" / "some-leftover.log").write_text("x", encoding="utf-8")

    resolved = data_dir.resolve_data_dir()

    assert resolved == app_data / "Tessera" / "data"
    assert not (resolved / "some-leftover.log").exists()


def test_legacy_app_dir_names_never_loses_an_entry():
    """守着 LEGACY_APP_DIR_NAMES 表本身：删掉一条等于放弃那一代用户的数据，且所有测试照样绿
    （迁移逻辑没坏，只是找不到那批目录）。"""
    assert "Ideal1 File Vault" in data_dir.LEGACY_APP_DIR_NAMES
    assert data_dir.APP_DIR_NAME == "Tessera"
    assert data_dir.APP_DIR_NAME not in data_dir.LEGACY_APP_DIR_NAMES
