"""用户数据目录的解析与一次性迁移（源码树 → %LOCALAPPDATA%）。

搬的是身份库、密码库、笔记库，搬坏即数据丢失，所以宁可不迁移也绝不损坏：
1. 环境变量显式指定路径则完全不迁移。
2. 迁移前拿跨进程锁。
3. 数据库用 SQLite backup API，不裸拷 .db（会漏 WAL 里未 checkpoint 的事务）。
4. 先写临时目录、校验、原子改名、写完成标记。
5. 全程不删旧目录，可手工退回。
6. 迁移后做真实密钥读取预检（keyring 凭据绑 Windows 用户而非目录），失败则回滚。
"""

from __future__ import annotations

import json
import os
import shutil
import sqlite3
import sys
import time
from pathlib import Path
from typing import Optional

from core.logging import get_logger

logger = get_logger(__name__)

APP_DIR_NAME = "Tessera"

# 改名前用过的 %LOCALAPPDATA% 目录名，从新到旧。应用由「Ideal1 File Vault」改名为「Tessera」，
# 只改 APP_DIR_NAME 会让老用户打开空金库；resolve_data_dir() 在新目录无身份库时按此列表回头找并 migrate()。
# 只增不改不删：再改名就往前加，删一条等于放弃那一代用户的数据。
LEGACY_APP_DIR_NAMES = ("Ideal1 File Vault",)

DATA_DIR_ENV = "IDEAL1_FILE_VAULT_DATA_DIR"

# 迁移完成标记，是目录能否直接用的唯一判据；不能看有没有文件，中断的迁移也会留下半成品。
MIGRATION_MARKER = ".migration-complete"
MIGRATION_LOCK = ".migration.lock"
# 锁的过期时间。持锁进程崩溃时锁文件会留下，没有过期机制的话应用就永远迁移不了。
# 取 10 分钟：正常迁移（几百 MB 量级）远快于此，而一个真的还在搬的进程不会被误判。
MIGRATION_LOCK_STALE_SECONDS = 600

# 迁移内容白名单：data/ 里混有约 300MB 的 VS Code 模板配置和缓存文件，整目录拷贝既占盘又慢。
MIGRATE_FILE_NAMES = (
    "identity_store.json",
    "app_settings.json",
    "module_lock_settings.json",
    "recovery_codes_settings.json",
    "file_manager_shortcuts.json",
    "ai_skills.json",
    "default_model_cache.json",
)
MIGRATE_DB_NAMES = (
    "clipboard.db",
    "notes.db",
    "passwords.db",
    "ai_history.db",
    "activity_log.db",
    "network_speedtest_history.db",
)
MIGRATE_DIR_NAMES = (
    "clipboard_images",
    "clipboard_thumbnails",
    "notes_images",
    "notes_thumbnails",
    "notes_texts",
    "screenshots",
    "tasks",
)


class MigrationError(Exception):
    """迁移失败。调用方应当继续用旧目录，而不是让应用带着半个金库启动。"""


def _app_data_root_for(app_dir_name: str) -> Path:
    """返回应用目录名在本平台的根目录；非 Windows 退回 `~/.local/share/`，以便在 Linux 上跑测试。"""
    if os.name == "nt":
        base = os.environ.get("LOCALAPPDATA")
        if base:
            return Path(base) / app_dir_name
        return Path.home() / "AppData" / "Local" / app_dir_name
    return Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share")) / app_dir_name


def local_app_data_root() -> Path:
    """`%LOCALAPPDATA%\\Tessera`（当前应用名）。"""
    return _app_data_root_for(APP_DIR_NAME)


def legacy_app_data_roots() -> "list[Path]":
    """改名前用过的根目录，按 LEGACY_APP_DIR_NAMES 顺序，只返回真实存在的。"""
    # 从 local_app_data_root() 的父目录派生，两者必须同源：重定向它的调用方（如测试）
    # 否则会得到混合状态，旧根仍指向真实 %LOCALAPPDATA%，本机配置漏进来。
    base = local_app_data_root().parent
    roots = []
    for name in LEGACY_APP_DIR_NAMES:
        root = base / name
        try:
            if root.is_dir():
                roots.append(root)
        except OSError:
            continue
    return roots


# 用户选定的数据目录记录在此。用文件而非注册表：免安装版不写注册表，两种形态须同一套逻辑，
# 且用户可自己看、改、删。不放在数据目录里，因为它记录的正是数据目录位置。
LOCATION_CONFIG_NAME = "data-location.json"


def location_config_path() -> Path:
    """`%LOCALAPPDATA%\\Ideal1 File Vault\\data-location.json`；此位置固定不可配置，作为自举起点。"""
    return local_app_data_root() / LOCATION_CONFIG_NAME


def read_configured_data_dir() -> Optional[Path]:
    """读取选定的数据目录；没有配置或配置坏了都返回 None，回落默认目录。绝不因此让应用起不来，也不尝试修复。"""
    # 依次看当前应用名的配置、改名前应用名的配置：安装程序把用户选的路径写在当时应用名的目录里，
    # 只读新目录会让把金库放在 D:\Vault 的老用户回落到默认目录而看到空金库。
    candidates = [location_config_path()]
    candidates.extend(root / LOCATION_CONFIG_NAME for root in legacy_app_data_roots())

    payload = None
    path = candidates[0]
    for candidate in candidates:
        try:
            with candidate.open("r", encoding="utf-8") as fh:
                payload = json.load(fh)
            path = candidate
            break
        except (OSError, ValueError):
            continue
    if payload is None:
        return None

    raw = payload.get("dataDir") if isinstance(payload, dict) else None
    if not isinstance(raw, str) or not raw.strip():
        return None

    try:
        return Path(raw.strip()).expanduser()
    except (OSError, ValueError):
        logger.warning("ignoring unusable dataDir in %s", path)
        return None


def write_configured_data_dir(directory: Path, move_from: Optional[Path] = None) -> None:
    """记下选定的数据目录（安装程序和设置页共用）。`move_from` 非空表示下次启动从这里搬到 directory，搬家不在这里发生（见 request_data_dir_move）。"""
    path = location_config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {"dataDir": str(directory)}
    if move_from is not None:
        payload["moveFrom"] = str(move_from)
    # 先写临时文件再原子改名：直接覆写遇断电会留下半截 JSON，导致用户设的路径丢失、数据看似没了。
    tmp = path.with_suffix(".json.tmp")
    with tmp.open("w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)
    tmp.replace(path)


def _read_pending_move_source() -> Optional[Path]:
    """读取"下次启动要从哪里搬过来"。"""
    path = location_config_path()
    try:
        with path.open("r", encoding="utf-8") as fh:
            payload = json.load(fh)
    except (OSError, ValueError):
        return None
    raw = payload.get("moveFrom") if isinstance(payload, dict) else None
    if not isinstance(raw, str) or not raw.strip():
        return None
    return Path(raw.strip())


def _clear_pending_move() -> None:
    """搬完之后把 moveFrom 去掉，避免下次启动又搬一遍。"""
    configured = read_configured_data_dir()
    if configured is not None:
        write_configured_data_dir(configured)


class DataDirMoveError(Exception):
    """请求搬家的参数不合法。数据没有被动过。"""


def request_data_dir_move(new_dir: Path) -> Path:
    """请求把金库搬到 `new_dir`，只记下意图，不搬任何东西，返回搬家前的目录。

    真正的搬运在下次启动、任何数据库连接打开之前由 resolve_data_dir() 执行：运行期 SQLCipher 持有
    连接和 WAL/SHM，此时复制会丢未 checkpoint 的事务；且 migrate() 已为无连接前提做过审计。
    调用方应提示「重启后生效」。
    """
    current = default_data_dir()
    try:
        target = Path(new_dir).expanduser().resolve()
    except (OSError, ValueError) as exc:
        raise DataDirMoveError(f"unusable path: {new_dir}") from exc

    # current 可能还不存在（全新安装、用户没打开过金库），resolve() 在
    # 不存在的路径上也能用（strict=False 是默认），所以不需要先判存在。
    current_resolved = current.expanduser().resolve()
    if target == current_resolved:
        raise DataDirMoveError("the new location is the same as the current one")

    # 不允许搬进当前目录的子目录：源和目标重叠，复制会自我嵌套。
    # relative_to 不抛 ValueError 就说明 target 在 current 底下。
    try:
        is_inside = True
        target.relative_to(current_resolved)
    except ValueError:
        is_inside = False
    if is_inside:
        raise DataDirMoveError("the new location cannot be inside the current one")

    try:
        target.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise DataDirMoveError(f"cannot create {target}: {exc}") from exc

    # 目标目录里已经有一个金库：拒绝。合并两个身份库是没有正确答案的，
    # 而静默覆盖会毁掉其中一个。
    if _has_identity(target):
        raise DataDirMoveError("that folder already contains a vault")

    write_configured_data_dir(target, move_from=current)
    logger.info("data dir move requested: %s -> %s (applies on next start)", current, target)
    return current


def default_data_dir() -> Path:
    """这次启动用哪个目录（不含迁移判断）：配置过用配置的，否则用 `%LOCALAPPDATA%` 下的默认位置。"""
    configured = read_configured_data_dir()
    if configured is not None:
        return configured
    return local_app_data_root() / "data"


def file_hook_runtime_root() -> Path:
    """全局快捷键运行时的稳定部署位置。portable EXE 的 `resourcesPath` 每次启动都是新的临时目录，
    写进注册表 Run 项后开机就失效，所以 hook agent 须按内容哈希部署到这里，Run 项只指向这里。"""
    return local_app_data_root() / "FileHook"


def updates_root() -> Path:
    """更新 runner 和下载暂存的位置。须在稳定目录：runner 要在主 EXE 退出、临时 resources 被清理后继续存活。"""
    return local_app_data_root() / "updates"


def resolve_data_dir(legacy_dir: Optional[Path] = None) -> Path:
    """决定本次启动用哪个数据目录，必要时一次性迁移。

    优先级：
    1. `IDEAL1_FILE_VAULT_DATA_DIR` 环境变量：显式指定绝不自动迁移（用户在自行管理该目录）。
    2. `data-location.json` 配置的目录，否则默认 `%LOCALAPPDATA%\\...\\data`（由 default_data_dir() 解析）。
    3. 目标目录已有身份库则直接用。
    4. 旧目录（调用方给的 data/ 及改名前的目录，见 LEGACY_APP_DIR_NAMES）有身份库而目标没有则迁移。
    5. 都没有则用目标目录（全新安装）。
    """
    explicit = os.environ.get(DATA_DIR_ENV)
    if explicit:
        path = Path(explicit)
        path.mkdir(parents=True, exist_ok=True)
        return path

    target = default_data_dir()

    # 用户在设置页请求过搬家（request_data_dir_move）。现在是执行它唯一安全的
    # 时机：进程刚起来，还没有任何 SQLCipher 连接打开。
    pending = _read_pending_move_source()
    if pending is not None:
        if _has_identity(target):
            # 目标已经有金库了——多半是上一次搬完但标记没清掉（清标记那一步之前
            # 崩了）。当作已完成处理，清掉标记就行。绝不能再搬一次覆盖它。
            logger.info("pending move already satisfied, clearing the marker")
            _clear_pending_move()
            return target
        if _has_identity(pending):
            try:
                migrate(pending, target)
                _clear_pending_move()
                logger.info("data dir moved: %s -> %s", pending, target)
                return target
            except MigrationError:
                # 搬失败：继续用旧目录并保留标记下次再试；绝不回落到空的新目录，否则用户会以为数据没了。
                logger.exception("data dir move failed, staying on the old directory")
                return pending
        # 源目录里没有身份库：没什么可搬的（用户还没建过金库就改了位置）。
        _clear_pending_move()

    if _has_identity(target):
        return target

    # 候选旧目录按优先级：1) 调用方给的源码树内老 data/（冻结产物下为 None）；
    # 2) 改名前的 %LOCALAPPDATA% 目录，没有它老用户改名后会打开空金库。
    legacy_candidates = []
    if legacy_dir is not None:
        legacy_candidates.append(legacy_dir)
    legacy_candidates.extend(root / "data" for root in legacy_app_data_roots())

    for candidate in legacy_candidates:
        # resolve 一下再比：改名前后的目录在极端情况下可能指向同一个地方
        # （比如用户自己做了个目录联接），自己搬给自己必然出问题。
        try:
            if candidate.resolve() == target.resolve():
                continue
        except OSError:
            pass
        if not _has_identity(candidate):
            continue
        try:
            migrate(candidate, target)
            logger.info("migrated vault from a previous app-name directory: %s -> %s", candidate, target)
            return target
        except MigrationError:
            # 迁移失败时继续用旧目录：应用照常可用，用户不会因为一次搬家失败就
            # 打不开自己的金库。日志里已经记了原因，下次启动会自动重试。
            logger.exception("data dir migration failed, continuing with the legacy directory")
            return candidate

    target.mkdir(parents=True, exist_ok=True)
    return target


def _has_identity(directory: Path) -> bool:
    """目录里有没有可用金库：只看 identity_store.json 存在且非空，判据与 identity.identity_exists 一致；
    不 import identity，因为 data_dir 先于它被用到，反向会成环。"""
    try:
        store = directory / "identity_store.json"
        return store.is_file() and store.stat().st_size > 0
    except OSError:
        return False


def migration_completed(directory: Path) -> bool:
    return (directory / MIGRATION_MARKER).is_file()


def migrate(source: Path, target: Path) -> None:
    """把 source 里白名单内的用户数据搬到 target，失败抛 MigrationError。绝不删除 source，以便手工退回。"""
    target.mkdir(parents=True, exist_ok=True)
    if migration_completed(target):
        return

    lock = _acquire_migration_lock(target)
    try:
        # 拿到锁之后再查一次：可能刚才另一个进程正好迁移完了。
        if migration_completed(target):
            return

        # 写临时目录而不是直接往 target 里写：中途失败时 target 保持干净（要么
        # 什么都没有，要么是上一次成功的结果），不会留下一个半成品被误当成可用。
        staging = target.parent / f".staging-{os.getpid()}-{int(time.time())}"
        if staging.exists():
            shutil.rmtree(staging, ignore_errors=True)
        staging.mkdir(parents=True)

        try:
            copied = _copy_payload(source, staging)
            _verify_payload(source, staging, copied)
            _publish(staging, target)
        finally:
            shutil.rmtree(staging, ignore_errors=True)

        (target / MIGRATION_MARKER).write_text(
            json.dumps({"migrated_at": time.strftime("%Y-%m-%dT%H:%M:%S"), "source": str(source)}),
            encoding="utf-8",
        )
        logger.info("data dir migrated from %s to %s", source, target)
    finally:
        _release_migration_lock(lock)


def _copy_payload(source: Path, staging: Path) -> list[str]:
    """把白名单内容复制到暂存目录，返回实际复制了哪些条目（供校验）。"""
    copied: list[str] = []

    for name in MIGRATE_FILE_NAMES:
        src = source / name
        if src.is_file():
            shutil.copy2(src, staging / name)
            copied.append(name)

    for name in MIGRATE_DB_NAMES:
        src = source / name
        if src.is_file():
            _copy_sqlite(src, staging / name)
            copied.append(name)

    for name in MIGRATE_DIR_NAMES:
        src = source / name
        if src.is_dir():
            shutil.copytree(src, staging / name)
            copied.append(name)

    return copied


def _copy_sqlite(src: Path, dest: Path) -> None:
    """用 SQLite backup API 取一致的数据库副本。

    不能用 shutil.copy2：库跑在 WAL 模式，已提交事务可能只在 `-wal` 里，裸拷 .db 会回到旧时点，
    分拷 db/wal/shm 则可能不一致而损坏。backup API 保证快照一致。
    刻意用标准库 sqlite3 而非 sqlcipher：它按页搬运密文，不解密，迁移时无需持有密钥、不碰明文。
    """
    src_conn = sqlite3.connect(f"file:{src}?mode=ro", uri=True)
    try:
        dest_conn = sqlite3.connect(str(dest))
        try:
            src_conn.backup(dest_conn)
        finally:
            dest_conn.close()
    finally:
        src_conn.close()


def _verify_payload(source: Path, staging: Path, copied: list[str]) -> None:
    """搬完后校验，不合格就抛异常（调用方丢弃暂存目录）。只查该有的都在且非空，不逐字节比对，
    因为 backup 重整了页布局，副本本来就不会逐字节相同。"""
    for name in copied:
        src = source / name
        dst = staging / name
        if not dst.exists():
            raise MigrationError(f"missing after copy: {name}")
        if src.is_file():
            if dst.stat().st_size == 0 and src.stat().st_size > 0:
                raise MigrationError(f"empty after copy: {name}")
        elif src.is_dir():
            src_count = sum(1 for _ in src.rglob("*"))
            dst_count = sum(1 for _ in dst.rglob("*"))
            if dst_count < src_count:
                raise MigrationError(f"incomplete directory copy: {name} ({dst_count} < {src_count})")

    # 身份库是能否解锁的根，必须搬过来且能解析为 JSON；它是迁移中唯一绝不能出错的文件，单独再查。
    identity_file = staging / "identity_store.json"
    if not identity_file.is_file():
        raise MigrationError("identity_store.json did not make it into the staging directory")
    try:
        json.loads(identity_file.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise MigrationError(f"identity_store.json is unreadable after copy: {exc}") from exc


def _publish(staging: Path, target: Path) -> None:
    """把暂存目录内容挪进 target。逐项 `os.replace`（同卷原子），因为 target 可能已存在（上次中断
    的残留或空目录）。目录类条目无原子替换，只能先删后挪；可接受，因为附件失败不影响打开金库，
    且下次启动会重跑迁移。"""
    target.mkdir(parents=True, exist_ok=True)
    for item in staging.iterdir():
        destination = target / item.name
        if item.is_dir():
            if destination.exists():
                shutil.rmtree(destination, ignore_errors=True)
            shutil.move(str(item), str(destination))
        else:
            os.replace(str(item), str(destination))


def _acquire_migration_lock(target: Path) -> Path:
    """跨进程迁移锁：用 `O_CREAT | O_EXCL` 原子地「不存在才创建」，两进程抢锁只有一个成功；
    先 exists() 再 create 之间有窗口，不可靠。"""
    target.mkdir(parents=True, exist_ok=True)
    lock_path = target / MIGRATION_LOCK
    _clear_stale_lock(lock_path)
    try:
        fd = os.open(str(lock_path), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError as exc:
        raise MigrationError("another instance is already migrating the data directory") from exc
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(json.dumps({"pid": os.getpid(), "at": time.time()}))
    return lock_path


def _clear_stale_lock(lock_path: Path) -> None:
    """清掉持锁进程崩溃后残留的锁。没有这一步的话一次崩溃会让应用永远迁移不了。"""
    try:
        age = time.time() - lock_path.stat().st_mtime
    except OSError:
        return
    if age > MIGRATION_LOCK_STALE_SECONDS:
        logger.warning("clearing a stale migration lock (%.0fs old)", age)
        try:
            lock_path.unlink()
        except OSError:
            pass


def _release_migration_lock(lock_path: Path) -> None:
    try:
        lock_path.unlink()
    except OSError:
        pass


def keyring_precheck(service_name: str, probe_key: str) -> bool:
    """迁移后确认 keyring 仍可读。凭据管理器条目绑 Windows 用户账户而非数据目录，
    从别的机器或账户拷来的 data 会表现为「密码怎么输都不对」，提前探测并明确提示凭据不在本机。
    返回 True 表示 keyring 可访问（读到条目，或确认条目不存在但后端正常）。"""
    try:
        import keyring
    except ImportError:
        logger.warning("keyring is unavailable; skipping the post-migration precheck")
        return False
    try:
        keyring.get_password(service_name, probe_key)
        return True
    except Exception:
        logger.exception("keyring precheck failed after migration")
        return False


def legacy_repo_data_dir() -> Optional[Path]:
    """旧的源码树内数据目录，仅在真实存在时返回。冻结模式下不猜该路径，打包应用不应依赖开发机的绝对路径。"""
    from modules.file_vault import runtime_resources

    if runtime_resources.is_frozen():
        return None
    candidate = Path(__file__).resolve().parent / "data"
    return candidate if candidate.is_dir() else None
