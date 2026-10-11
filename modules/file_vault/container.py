"""`.ivault` 容器格式：一个输入文件 -> 一个自包含输出文件（header + 分块密文），无旁路元数据文件。

布局（format version 2）：
       [4 字节大端 header 长度][header，UTF-8 JSON][块流：重复（4 字节大端密文长度，密文 + 16 字
   节 GCM tag）]
header 含 format_version、chunk_size、file_nonce_prefix(b64)、fk_wrap（或 fk_wrap_pq / fk_wrap_p
w）、
meta(b64 AES-GCM 密文)。敏感元数据（original_filename、plaintext_size、sha256_plaintext）在用 Fi
le Key
加密的 meta 内：v1 放在明文头里，持有文件者无需密钥即可读文件名并凭 SHA-256 确认是否含某已知文件。
v1 仍可读（decrypt/read_header 两版都收），新文件一律写 v2。

块 nonce = file_nonce_prefix(8 字节) + 大端块序号(4 字节)，同一 File Key 下不会复用；
meta 用保留序号 0xFFFFFFFF（块循环上限在其下），不会与块 nonce 冲突。

批量加密用 File Key (FK) 配可选 AEAD（crypto.FILE_CIPHERS，默认 AES-256-GCM，或 ChaCha20-Poly130
5），
算法写入公开头的 "cipher" 字段以便自描述解密。IMK 每个文件只用一次来包裹/解包 FK（恒为 AES-256-G
CM）；
调用 encrypt_file/decrypt_file 前须已解锁 IMK（见 identity.py）。

FK 包裹有三种形态，头里恰好出现一种：
  "fk_wrap"     {nonce, wrapped_fk}                    - 仅 IMK
  "fk_wrap_pq"  {kem, kem_ct, salt, nonce, wrapped_fk} - 混合，密钥为 HKDF(IMK || ML-KEM-1024 共
享密钥)，
                                                         打开需 IMK 与 pq_seed
  "fk_wrap_pw"  {kdf, params, salt, nonce, wrapped_fk} - 口令（共享用），无需 IMK，另一个 Tesser
a 安装凭口令即可打开
同时写两种会使混合形同虚设（攻击者走弱的那条），故 _wrap_fk_for_header 只写其一。
口令形态的 KDF 名称和代价参数写在头里，以便日后调高默认值而不破坏已共享的文件。
"""

import base64
import hashlib
import io
import json
import os
import queue
import shutil
import stat
import struct
import tempfile
import threading
import time
import uuid
import zipfile
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path
from typing import Callable, Dict, List, Optional, Tuple

from modules.file_vault import crypto
from modules.file_vault.errors import VaultError

FORMAT_VERSION = 2
SUPPORTED_VERSIONS = (1, 2)
CHUNK_SIZE = 4 * 1024 * 1024  # 4 MiB

# 为什么不做多线程分块加密（实测后主动放弃）：原理上可行（块互相独立、OpenSSL AES-NI 释放 GIL，
# 也实现并往返验证过），但瓶颈不在加密：单核 AES-256-GCM 1136 MB/s、SHA-256 501 MB/s，磁盘写入仅
#  217 MB/s。
# 端到端 256 MiB 实测，8 线程加密每轮反而更慢（调度开销），解密差别在抖动内。
# 不值得在最要命的代码里加在途队列和异常取消逻辑（出错 = 金库解不开且报"文件损坏"）。要提速应从
# 磁盘侧入手。
NONCE_PREFIX_LEN = 8
CHUNK_COUNTER_LEN = 4
# Reserved chunk index whose nonce encrypts the metadata block - the data
# chunk loop refuses to reach it, so meta and chunks never share a nonce.
_META_CHUNK_INDEX = 0xFFFFFFFF
_META_AAD = b"ivault.meta.v2"

# meta.kind："file"（默认，加文件夹支持前唯一的取值）或 "folder"（块流是 ZIP_STORED 归档而非裸文
# 件字节，
# 见 encrypt_folder/decrypt_folder_to_temp）。读取时缺省按 KIND_FILE，旧 .ivault 照常解密。
KIND_FILE = "file"
KIND_FOLDER = "folder"
_FOLDER_TEMP_PREFIX = "ideal1-folder-preview-"

_HEADER_LEN_STRUCT = struct.Struct(">I")
_CHUNK_LEN_STRUCT = struct.Struct(">I")

ProgressCallback = Optional[Callable[[int, int], None]]  # (chunks_done, total_chunks)

# 长时间操作至少每隔这么久报一次进度：前端 pythonBridge.ts 有 20 秒静默超时，
# 后端沉默超限就判负，这是功能不坏的下限（曾因解压阶段整段沉默导致界面卡死）。
_PROGRESS_INTERVAL_S = 0.2

# 目录树删不掉时重试几次、每次退让多久（第 n 次等 n×这个值）。
# 治的是"文件都删干净了、只剩一个空壳目录被资源管理器占着"这种**瞬时**占用。
_RMTREE_RETRIES = 3
_RMTREE_RETRY_DELAY_S = 0.15


class InvalidContainerError(VaultError):
    """The file isn't a valid .ivault container (wrong file, bad header)."""


class ContainerIntegrityError(VaultError):
    """The container's header parsed fine, but the content is corrupted or
    tampered with (chunk auth tag or overall checksum mismatch)."""


class SecureDeleteIncompleteError(VaultError):
    """安全删除没能删完所有目标。
    若首个读不了的文件就中止，密文已写好而源树仍可读，UI 还会报成功；故尽量删能删的，
    再抛出仍留有明文的路径清单。"""


class SamePathError(VaultError):
    """input_path 与 output_path 指向同一文件。加解密都先写临时文件最后才替换目标，
    不拦的话（如保存对话框默认值撞上源文件）会静默用结果覆盖唯一的源数据。"""


def expected_chunk_count(plaintext_size: int, chunk_size: int = CHUNK_SIZE) -> int:
    if plaintext_size == 0:
        return 0
    return (plaintext_size + chunk_size - 1) // chunk_size


def _check_not_same_file(input_path: Path, output_path: Path) -> None:
    if input_path.resolve() == output_path.resolve():
        raise SamePathError("container.same_path")


def _create_output_temp(output_path: Path, *, prefix: Optional[str] = None) -> Tuple[Path, int]:
    """在 output_path 旁创建私有、不可预测的暂存文件。
    最终输出要等所有密文块和完整校验都通过才打开；暂存文件同目录，保证无覆盖发布留在同一文件系统。
    mkstemp 返回已打开的独占描述符，已存在的 ``.part`` 文件不会被截断或跟随。"""
    if output_path.exists():
        raise InvalidContainerError("container.destination_exists", path=str(output_path))
    if not output_path.parent.is_dir():
        raise InvalidContainerError("container.destination_parent_missing", path=str(output_path.parent))
    fd, tmp_name = tempfile.mkstemp(
        prefix=prefix or f".{output_path.name}.ivault-",
        suffix=".part",
        dir=output_path.parent,
    )
    if _SEQUENTIAL_FLAG:
        # mkstemp 不收 flags，只能事后换一个带 O_SEQUENTIAL 的描述符指向同一文件再关掉原来的，
        # 免得几个 GB 的顺序写挤爆系统缓存（见 _SEQUENTIAL_FLAG），代价接近零。
        try:
            seq_fd = os.open(tmp_name, os.O_RDWR | os.O_BINARY | _SEQUENTIAL_FLAG)
        except OSError:
            pass  # 拿不到就算了，它只是个提示，不影响正确性
        else:
            os.close(fd)
            fd = seq_fd
    return Path(tmp_name), fd


def _open_sequential_read(path: Path):
    """顺序整读大文件时用它代替裸 open()：O_SEQUENTIAL 提示让缓存管理器在身后回收页面
    （见 _SEQUENTIAL_FLAG）；拿不到则退回普通 open，它只是提示。"""
    if _SEQUENTIAL_FLAG:
        try:
            return os.fdopen(os.open(path, os.O_RDONLY | os.O_BINARY | _SEQUENTIAL_FLAG), "rb")
        except OSError:
            pass
    return open(path, "rb")


def _publish_new_file(tmp_path: Path, output_path: Path) -> None:
    """Publish a completed staging file without ever replacing an existing one."""
    if output_path.exists():
        raise InvalidContainerError("container.destination_exists", path=str(output_path))

    if os.name == "nt":
        _move_new_path(tmp_path, output_path)
        return

    # link+unlink is an atomic no-replace publish on POSIX filesystems. It is
    # intentionally not os.rename(), which would overwrite an existing file.
    try:
        os.link(tmp_path, output_path)
    except FileExistsError as exc:
        raise InvalidContainerError("container.destination_exists", path=str(output_path)) from exc
    tmp_path.unlink()


def _move_new_path(source: Path, destination: Path) -> None:
    """Move a file or directory on Windows without replacing a destination."""
    import ctypes

    move_file = ctypes.WinDLL("kernel32", use_last_error=True).MoveFileW
    move_file.argtypes = (ctypes.c_wchar_p, ctypes.c_wchar_p)
    move_file.restype = ctypes.c_bool
    if not move_file(str(source), str(destination)):
        error_code = ctypes.get_last_error()
        if error_code in (80, 183):  # ERROR_FILE_EXISTS / ERROR_ALREADY_EXISTS
            raise InvalidContainerError("container.destination_exists", path=str(destination))
        raise OSError(error_code, f"Unable to publish {destination}")


def _publish_new_directory(staging_dir: Path, output_dir: Path) -> None:
    """Publish a fully extracted staging directory without merging or overwrite."""
    if output_dir.exists():
        raise InvalidContainerError("container.destination_exists", path=str(output_dir))
    if os.name == "nt":
        _move_new_path(staging_dir, output_dir)
        return
    try:
        os.rename(staging_dir, output_dir)
    except FileExistsError as exc:
        raise InvalidContainerError("container.destination_exists", path=str(output_dir)) from exc


def _validate_original_filename(value) -> str:
    """Accept only one safe Windows filename component from container metadata."""
    if not isinstance(value, str) or not value or value in {".", ".."}:
        raise InvalidContainerError("container.invalid_original_filename")
    if any(char in value for char in '<>:"/\\|?*') or any(ord(char) < 32 for char in value):
        raise InvalidContainerError("container.invalid_original_filename")
    if value.endswith((".", " ")):
        raise InvalidContainerError("container.invalid_original_filename")
    # Windows device names are reserved even when they carry an extension.
    stem = value.split(".", 1)[0].upper()
    if stem in {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10))}:
        raise InvalidContainerError("container.invalid_original_filename")
    return value


def _chunk_nonce(nonce_prefix: bytes, index: int) -> bytes:
    return nonce_prefix + index.to_bytes(CHUNK_COUNTER_LEN, "big")


def secure_delete_file(path: Path, on_progress: ProgressCallback = None) -> None:
    """unlink 前用随机字节覆写文件，免得明文源文件留在 .ivault 旁边使加密失去意义。
    尽力而为：SSD / 日志 / 写时复制文件系统上物理块仍可能留存，只防普通文件系统层面的随手读取，不防
    取证恢复。
    `on_progress` 供大文件用：覆写 10 GB 容器期间必须有进度，否则前端静默超时会判负（见 _PROGRESS_IN
    TERVAL_S）。"""
    path = Path(path)
    size = path.stat().st_size
    try:
        _overwrite_then_unlink(path, size, on_progress)
    except PermissionError:
        # Windows 对带 FILE_ATTRIBUTE_READONLY 的文件既拒绝 open("r+b") 也拒绝 unlink()，
        # 而 desktop.ini、光盘/压缩包还原的文件、手机拷出的文件常带此属性。它是元数据而非权限，
        # 清除后重试才是正确处理，而不是判定文件删不掉。
        _clear_readonly(path)
        _overwrite_then_unlink(path, size, on_progress)


def _clear_readonly(path: Path) -> None:
    """尽力清除只读位，永不抛异常：调用方已在失败路径，chmod 失败不能掩盖随后重试的真实错误。"""
    try:
        os.chmod(path, stat.S_IWRITE | stat.S_IREAD)
    except OSError:
        pass


def _overwrite_then_unlink(path: Path, size: int, on_progress: ProgressCallback = None) -> None:
    total = max(1, size)
    last_report = 0.0
    with open(path, "r+b") as f:
        remaining = size
        while remaining > 0:
            chunk_size = min(remaining, CHUNK_SIZE)
            f.write(os.urandom(chunk_size))
            remaining -= chunk_size
            if on_progress:
                now = time.monotonic()
                if now - last_report >= _PROGRESS_INTERVAL_S:
                    last_report = now
                    on_progress(size - remaining, total)
        f.flush()
        os.fsync(f.fileno())
    path.unlink()
    if on_progress:
        on_progress(total, total)


# SHA-256 hexdigest 恒为 64 个十六进制字符：用来在哈希未知前预留正确大小的头部空间，
# 而不必在文件唯一的 meta nonce 下加密一个临时值（见 encrypt_file）。
_PLACEHOLDER_SHA256 = "0" * 64
_META_TAG_LEN = 16  # GCM/ChaCha20-Poly1305 both append a fixed 16-byte tag


# 性能基准结论（本机实测，别再重复这些弯路）：
# 1 GiB 各阶段：顺序读 1631、AEAD 解密 2195、sha256 1028、顺序写 509 MB/s；端到端 250~470 MB/s，
#   天花板是磁盘写入，不是密码学。
# 试过未采用：
#   · 分块并行加解密：线程池不快反慢，AES-GCM 本就 2 GB/s 以上，线程只带来调度开销。
#   · 读/算/写三段流水线：A/B 三轮效应量（+31% ~ -15%）小于测量噪声，不值得为此引入线程、队列和
# 跨线程异常搬运。
#   · fout.truncate 预分配输出：慢一半（NTFS 要把撑出的部分先填零，数据写了两遍）。
# 小文件批量（2000 个 32 KB，每个 4.4 ms，99.8% 是每文件固定开销）：
#   采用"短读即 EOF"，省掉多余的 read 系统调用，1.793 → 0.979 ms/文件，见 encrypt_file。
#   未采用：小文件去 O_SEQUENTIAL（仅约 1%）；动 _check_not_same_file 里的 resolve()（仅 5%，却
# 挡着覆盖源文件的不可逆事故）。
# 基准只可信同一进程内交替臂 A/B，跨轮次数字不可信（背景负载可让同一代码差 1.6x）。
# 整文件 sha256 占约 25% 但已决定保留：它是唯一跨块且与实现无关的校验（块级 AEAD、nonce 绑块号、
# plaintext_size 防不了
# "每块单独验过、整体必然失败"这类问题）。


# 顺序访问提示：加解密总是从头读到尾，告诉缓存管理器就会在身后回收页面。
# 否则解密 5 GB 会累积 5 GB 脏页 + 5 GB 读缓存，越过 Windows 脏页阈值后所有进程的 I/O 被节流，整
# 机变卡。
# 不用定期 fsync：它在 Windows 是 FlushFileBuffers，连 SSD 缓存也刷，实测加密 358 → 104 MB/s。
# O_SEQUENTIAL 即 FILE_FLAG_SEQUENTIAL_SCAN，只是提示、代价近零，别换回 fsync。
_SEQUENTIAL_FLAG = getattr(os, "O_SEQUENTIAL", 0)


def encrypt_file(
    input_path,
    output_path,
    imk: bytes,
    on_progress: ProgressCallback = None,
    cipher: str = crypto.DEFAULT_FILE_CIPHER,
    pq_public_key: Optional[bytes] = None,
    passphrase=None,
) -> None:
    """`passphrase` (str or crypto.PassphraseKeyring) seals the File Key for
    sharing instead of under the IMK - see the module docstring."""
    input_path = Path(input_path)
    output_path = Path(output_path)
    _check_not_same_file(input_path, output_path)
    _reject_retired_cipher(cipher)

    plaintext_size = input_path.stat().st_size
    total_chunks = expected_chunk_count(plaintext_size, CHUNK_SIZE)

    fk = crypto.generate_file_key(cipher)
    fk_wrap_json = _wrap_fk_for_header(imk, fk, pq_public_key, passphrase)
    nonce_prefix = os.urandom(NONCE_PREFIX_LEN)

    def _serialize_header(meta_ciphertext: bytes) -> bytes:
        header = {
            "format_version": FORMAT_VERSION,
            "chunk_size": CHUNK_SIZE,
            "cipher": cipher,
            "file_nonce_prefix": base64.b64encode(nonce_prefix).decode(),
            **fk_wrap_json,
            "meta": base64.b64encode(meta_ciphertext).decode(),
        }
        return json.dumps(header).encode("utf-8")

    def _meta_json(sha256_hex: str) -> bytes:
        return json.dumps({
            "original_filename": input_path.name,
            "plaintext_size": plaintext_size,
            "sha256_plaintext": sha256_hex,
            "kind": KIND_FILE,
        }).encode("utf-8")

    # sha256_plaintext 要读完所有块才知道，单独预扫一遍会把输入读两次。
    # 改为先预留等长头部空间（等长假密文，从不真正加密，见 _PLACEHOLDER_SHA256/_META_TAG_LEN），
    # 加密同一遍里增量哈希，最后 seek 回去用真实哈希覆盖头部：输入只读一次。
    placeholder_meta_ciphertext = bytes(len(_meta_json(_PLACEHOLDER_SHA256)) + _META_TAG_LEN)
    placeholder_header_bytes = _serialize_header(placeholder_meta_ciphertext)

    tmp_path, tmp_fd = _create_output_temp(output_path)
    try:
        with os.fdopen(tmp_fd, "wb") as fout, _open_sequential_read(input_path) as fin:
            fout.write(_HEADER_LEN_STRUCT.pack(len(placeholder_header_bytes)))
            fout.write(placeholder_header_bytes)

            sha256 = hashlib.sha256()
            index = 0
            while True:
                plaintext_chunk = fin.read(CHUNK_SIZE)
                if not plaintext_chunk:
                    break
                if index >= _META_CHUNK_INDEX:
                    raise InvalidContainerError("container.file_too_large")
                sha256.update(plaintext_chunk)
                nonce = _chunk_nonce(nonce_prefix, index)
                ciphertext = crypto.file_aead_encrypt(cipher, fk, nonce, plaintext_chunk)
                fout.write(_CHUNK_LEN_STRUCT.pack(len(ciphertext)))
                fout.write(ciphertext)
                index += 1
                if on_progress:
                    on_progress(index, total_chunks)
                # 短读即 EOF：BufferedReader.read(n) 只在流耗尽时少于 n 字节，再循环读一次 b"" 是白花的系统调用，
                # 对大文件不显眼，对小文件批量占主导（500x32 KB 实测 1.79 → 0.98 ms/文件）。
                # 非常规文件（可能提前短读）到不了这里：上面的 input_path.stat() 已要求常规文件。
                if len(plaintext_chunk) < CHUNK_SIZE:
                    break

            real_meta_ciphertext = crypto.file_aead_encrypt(
                cipher, fk, _chunk_nonce(nonce_prefix, _META_CHUNK_INDEX),
                _meta_json(sha256.hexdigest()), _META_AAD,
            )
            real_header_bytes = _serialize_header(real_meta_ciphertext)
            # Guaranteed by construction (see _PLACEHOLDER_SHA256) - overwriting
            # the reserved region in place is only safe if this never resizes it.
            assert len(real_header_bytes) == len(placeholder_header_bytes)

            fout.seek(0)
            fout.write(_HEADER_LEN_STRUCT.pack(len(real_header_bytes)))
            fout.write(real_header_bytes)
        _publish_new_file(tmp_path, output_path)
    except BaseException:
        tmp_path.unlink(missing_ok=True)
        raise


def _read_raw_header(fin) -> dict:
    """Read the plaintext JSON header off an open stream, leaving the stream
    positioned at the start of the chunk data. Raises InvalidContainerError."""
    len_bytes = fin.read(_HEADER_LEN_STRUCT.size)
    if len(len_bytes) != _HEADER_LEN_STRUCT.size:
        raise InvalidContainerError("container.invalid_file")
    (header_len,) = _HEADER_LEN_STRUCT.unpack(len_bytes)

    header_bytes = fin.read(header_len)
    if len(header_bytes) != header_len:
        raise InvalidContainerError("container.header_incomplete")
    try:
        header = json.loads(header_bytes.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise InvalidContainerError("container.invalid_file") from exc

    if not isinstance(header, dict) or header.get("format_version") not in SUPPORTED_VERSIONS:
        raise InvalidContainerError(
            "container.unsupported_format_version",
            version=header.get("format_version") if isinstance(header, dict) else repr(header),
        )
    return header


def _header_cipher(header: dict) -> str:
    """The file cipher recorded in the header. v1 predates the field and
    early v2 files omitted it - both were always AES-256-GCM."""
    cipher = header.get("cipher", "aes-256-gcm")
    if cipher not in crypto.FILE_CIPHERS:
        raise InvalidContainerError("container.unsupported_cipher", cipher=cipher)
    return cipher


def _reject_retired_cipher(cipher: str) -> None:
    """Guard the write path only. Retired ciphers keep decrypting forever
    (see crypto.RETIRED_FILE_CIPHERS); they just can't be chosen again."""
    if cipher not in crypto.FILE_CIPHERS:
        raise InvalidContainerError("container.unsupported_cipher", cipher=cipher)
    if cipher in crypto.RETIRED_FILE_CIPHERS:
        raise InvalidContainerError("container.retired_cipher", cipher=cipher)


def _wrap_fk_for_header(imk: bytes, fk: bytes, pq_public_key: Optional[bytes], passphrase=None) -> dict:
    """把 File Key 包裹后写入头部。
    无公钥时是原有的 IMK 下 AES-256-GCM 包裹；有公钥时包裹密钥来自 HKDF(IMK || ML-KEM 共享密钥)，
    且不能同时写经典 `fk_wrap`：两条都给会让攻击者走较弱那条，混合形同虚设。
    传口令（str 或 crypto.PassphraseKeyring）则 FK 仅由口令封装；同时给口令和 PQ 公钥是调用方 bug。"""
    if passphrase is not None:
        if pq_public_key is not None:
            raise ValueError("passphrase sealing and the post-quantum wrap are mutually exclusive")
        try:
            return {"fk_wrap_pw": crypto.as_passphrase_keyring(passphrase).seal_key(fk)}
        except crypto.PassphraseKeyringClosed as exc:
            # 这一批的口令已经被丢掉（界面那头超时收尾了）。绝不能拿空口令去封：
            # 那样文件会被锁在一个谁都能派生出来的密钥下，而源文件接着就被安全删除。
            raise InvalidContainerError("container.passphrase_required") from exc

    if pq_public_key is None:
        fk_nonce, wrapped_fk = crypto.wrap_key(imk, fk)
        return {
            "fk_wrap": {
                "nonce": base64.b64encode(fk_nonce).decode(),
                "wrapped_fk": base64.b64encode(wrapped_fk).decode(),
            }
        }

    if len(pq_public_key) != crypto.PQ_PUBLIC_LEN:
        raise InvalidContainerError("container.invalid_pq_key")
    shared_secret, kem_ciphertext = crypto.pq_encapsulate(pq_public_key)
    salt = crypto.random_salt()
    kek = crypto.hybrid_kek(imk, shared_secret, salt)
    fk_nonce, wrapped_fk = crypto.wrap_key(kek, fk)
    return {
        "fk_wrap_pq": {
            "kem": crypto.PQ_KEM,
            "kem_ct": base64.b64encode(kem_ciphertext).decode(),
            "salt": base64.b64encode(salt).decode(),
            "nonce": base64.b64encode(fk_nonce).decode(),
            "wrapped_fk": base64.b64encode(wrapped_fk).decode(),
        }
    }


def header_is_post_quantum(header: dict) -> bool:
    return isinstance(header.get("fk_wrap_pq"), dict)


def header_is_passphrase_sealed(header: dict) -> bool:
    return "fk_wrap_pw" in header


def _unwrap_fk_with_passphrase(header: dict, passphrase) -> bytes:
    # 口令封装必须是头部里**唯一**的封装。一个同时带 fk_wrap 的"口令容器"只可能
    # 是被改过的——照单全收就等于让篡改者决定走哪条路。
    if "fk_wrap" in header or "fk_wrap_pq" in header:
        raise InvalidContainerError("container.invalid_header")
    if passphrase is None:
        # 跟 key_mismatch 分开：界面据此弹口令框，而不是报"密钥不匹配"。
        raise InvalidContainerError("container.passphrase_required")
    try:
        return crypto.as_passphrase_keyring(passphrase).open_key(header["fk_wrap_pw"])
    except crypto.PassphraseKdfError as exc:
        code = "container.unsupported_kdf" if exc.reason == "unsupported" else "container.invalid_kdf_params"
        raise InvalidContainerError(code) from exc
    except crypto.PassphraseKeyringClosed as exc:
        raise InvalidContainerError("container.passphrase_required") from exc
    except crypto.InvalidTag:
        # 口令错和封装被改在密码学上不可区分；前者远比后者常见，按前者报。
        raise InvalidContainerError("container.wrong_passphrase")
    except ValueError as exc:
        raise InvalidContainerError("container.invalid_header") from exc


def _unwrap_fk(header: dict, imk: bytes, pq_seed: Optional[bytes] = None, passphrase=None) -> bytes:
    if header_is_passphrase_sealed(header):
        return _unwrap_fk_with_passphrase(header, passphrase)
    if header_is_post_quantum(header):
        pq = header["fk_wrap_pq"]
        if pq.get("kem") != crypto.PQ_KEM:
            raise InvalidContainerError("container.unsupported_kem", kem=pq.get("kem"))
        if pq_seed is None:
            # 写入容器的身份有后量子密钥对而打开者没有：与 key_mismatch 区分，UI 才能说出缺的是什么。
            raise InvalidContainerError("container.pq_key_missing")
        try:
            kem_ciphertext = base64.b64decode(pq["kem_ct"])
            salt = base64.b64decode(pq["salt"])
            fk_nonce = base64.b64decode(pq["nonce"])
            wrapped_fk = base64.b64decode(pq["wrapped_fk"])
        except (KeyError, TypeError, ValueError) as exc:
            raise InvalidContainerError("container.invalid_header") from exc
        try:
            shared_secret = crypto.pq_decapsulate(pq_seed, kem_ciphertext)
        except ValueError as exc:
            raise InvalidContainerError("container.key_mismatch") from exc
        try:
            return crypto.unwrap_key(crypto.hybrid_kek(imk, shared_secret, salt), fk_nonce, wrapped_fk)
        except crypto.InvalidTag:
            # ML-KEM 解封装遇错密钥不会报错（按设计返回隐式拒绝密钥），所以 PQ seed 不匹配
            # 在这里表现为解包失败，与 IMK 错误一样。
            raise InvalidContainerError("container.key_mismatch")

    try:
        fk_nonce = base64.b64decode(header["fk_wrap"]["nonce"])
        wrapped_fk = base64.b64decode(header["fk_wrap"]["wrapped_fk"])
    except (KeyError, TypeError, ValueError) as exc:
        raise InvalidContainerError("container.invalid_header") from exc
    try:
        return crypto.unwrap_key(imk, fk_nonce, wrapped_fk)
    except crypto.InvalidTag:
        raise InvalidContainerError("container.key_mismatch")


def _decrypt_meta(header: dict, fk: bytes) -> dict:
    cipher = _header_cipher(header)
    try:
        nonce_prefix = base64.b64decode(header["file_nonce_prefix"])
        meta_ciphertext = base64.b64decode(header["meta"])
    except (KeyError, TypeError, ValueError) as exc:
        raise InvalidContainerError("container.invalid_header") from exc
    try:
        # ValueError covers a tampered cipher field whose key size no longer
        # matches the wrapped FK - same verdict as a failed auth tag.
        meta_bytes = crypto.file_aead_decrypt(
            cipher, fk, _chunk_nonce(nonce_prefix, _META_CHUNK_INDEX), meta_ciphertext, _META_AAD
        )
        meta = json.loads(meta_bytes.decode("utf-8"))
    except (crypto.InvalidTag, ValueError, UnicodeDecodeError) as exc:
        raise ContainerIntegrityError("container.metadata_corrupted") from exc
    if not isinstance(meta, dict):
        raise ContainerIntegrityError("container.metadata_corrupted")
    return meta


def _coerce_plaintext_size(value) -> int:
    """plaintext_size 在 kind=file 时是 JSON 整数（大小已知，见 encrypt_file），
    kind=folder 时是零填充十进制字符串（zip 最终大小写完才知道，需定宽占位以便原地覆盖，
    见 _ChunkingEncryptWriter）。读取时两者都接受，调用方无需关心。"""
    return int(value)


def _normalize_meta(meta: dict) -> dict:
    """为文件夹支持之前没有的字段（kind）补默认值，并把 plaintext_size 的两种落盘表示
    （见 _coerce_plaintext_size）统一成 int，使 _resolve_metadata 下游看到一致形状。"""
    meta = dict(meta)
    meta.setdefault("kind", KIND_FILE)
    try:
        meta["original_filename"] = _validate_original_filename(meta["original_filename"])
    except KeyError as exc:
        raise InvalidContainerError("container.invalid_header") from exc
    if "plaintext_size" in meta:
        meta["plaintext_size"] = _coerce_plaintext_size(meta["plaintext_size"])
    return meta


def _v1_metadata(header: dict) -> dict:
    try:
        return _normalize_meta({
            "original_filename": header["original_filename"],
            "plaintext_size": header["plaintext_size"],
            "sha256_plaintext": header["sha256_plaintext"],
        })
    except KeyError as exc:
        raise InvalidContainerError("container.invalid_header") from exc


def _metadata_with_fk(header: dict, fk: bytes) -> dict:
    """与 _resolve_metadata 结果相同，供已持有解包后 FK 的调用方用。
    读取路径以前会解包两次，对口令包裹意味着每文件付两次故意很慢的 KDF。"""
    if header["format_version"] == 1:
        return _v1_metadata(header)
    return _normalize_meta(_decrypt_meta(header, fk))


def _resolve_metadata(header: dict, imk: bytes, pq_seed: Optional[bytes] = None, passphrase=None) -> dict:
    """返回已解析 header 的 {original_filename, plaintext_size, sha256_plaintext, kind}：
    v2 解密 meta 块（需 imk），v1 直接取明文头字段。kind 总是 "file" 或 "folder"，
    文件夹支持前写的容器一律视为 "file"。"""
    if header["format_version"] == 1:
        return _v1_metadata(header)
    fk = _unwrap_fk(header, imk, pq_seed, passphrase)
    return _normalize_meta(_decrypt_meta(header, fk))


def read_header(input_path, imk: bytes = None, pq_seed: Optional[bytes] = None, passphrase=None) -> dict:
    """解析并返回 header，供 GUI 预检（如解密前显示原文件名/大小）。
    v2 的敏感字段已加密，需 imk 才包含；无 imk 只返回公开字段并附 "metadata_locked": True。
    文件不是合法容器或 imk 不匹配则抛 InvalidContainerError。

    口令封装的容器缺 `passphrase` 不算错误：返回同无 imk 的结果并附 "passphrase_protected": True，
    让调用方去问口令，而不是报文件不可读。
    """
    input_path = Path(input_path)
    with _open_sequential_read(input_path) as fin:
        header = _read_raw_header(fin)

    if header["format_version"] == 1:
        result = dict(header)
        result.update(_resolve_metadata(header, imk, pq_seed))
        return result
    sealed = header_is_passphrase_sealed(header)
    if imk is None and not (sealed and passphrase is not None):
        result = dict(header)
        result["metadata_locked"] = True
        if sealed:
            result["passphrase_protected"] = True
        return result
    if sealed and passphrase is None:
        result = dict(header)
        result.pop("meta", None)
        result["metadata_locked"] = True
        result["passphrase_protected"] = True
        return result
    result = dict(header)
    result.pop("meta", None)
    result["post_quantum"] = header_is_post_quantum(header)
    result["passphrase_protected"] = sealed
    result.update(_resolve_metadata(header, imk, pq_seed, passphrase))
    return result


def _decrypt_chunks_to_file(
    input_path, output_path, imk: bytes, on_progress: ProgressCallback, expected_kind: Optional[str] = None,
    pq_seed: Optional[bytes] = None, passphrase=None,
) -> dict:
    """核心分块解密循环：input_path 的密文块 -> output_path 的明文字节。
    decrypt_file（expected_kind=KIND_FILE）与 decrypt_folder_to_temp（expected_kind=KIND_FOLDER，
    输出是待解压的明文 zip 临时文件）共用；返回规范化 meta，免得再读一次 header。
    expected_kind 在读完 header/meta 后、动任何块或 output_path 之前检查，容器种类不对时快速失败。"""
    input_path = Path(input_path)
    output_path = Path(output_path)
    _check_not_same_file(input_path, output_path)

    with _open_sequential_read(input_path) as fin:
        header = _read_raw_header(fin)
        cipher = _header_cipher(header)
        fk = _unwrap_fk(header, imk, pq_seed, passphrase)
        meta = _metadata_with_fk(header, fk)
        if expected_kind is not None and meta["kind"] != expected_kind:
            raise InvalidContainerError(
                "container.is_folder_container" if expected_kind == KIND_FILE else "container.not_a_folder_container"
            )

        try:
            sha256_expected = meta["sha256_plaintext"]
            nonce_prefix = base64.b64decode(header["file_nonce_prefix"])
            total_chunks = expected_chunk_count(meta["plaintext_size"], header["chunk_size"])
        except (KeyError, TypeError, ValueError) as exc:
            raise InvalidContainerError("container.invalid_header") from exc

        tmp_path, tmp_fd = _create_output_temp(output_path)
        sha256 = hashlib.sha256()
        try:
            with os.fdopen(tmp_fd, "wb") as fout:
                index = 0
                while True:
                    len_bytes = fin.read(_CHUNK_LEN_STRUCT.size)
                    if not len_bytes:
                        break
                    if len(len_bytes) != _CHUNK_LEN_STRUCT.size:
                        raise ContainerIntegrityError("container.corrupted")
                    (chunk_len,) = _CHUNK_LEN_STRUCT.unpack(len_bytes)
                    ciphertext = fin.read(chunk_len)
                    if len(ciphertext) != chunk_len:
                        raise ContainerIntegrityError("container.corrupted")

                    nonce = _chunk_nonce(nonce_prefix, index)
                    try:
                        plaintext_chunk = crypto.file_aead_decrypt(cipher, fk, nonce, ciphertext)
                    except (crypto.InvalidTag, ValueError):
                        raise ContainerIntegrityError("container.corrupted")

                    fout.write(plaintext_chunk)
                    sha256.update(plaintext_chunk)
                    index += 1
                    if on_progress:
                        on_progress(index, total_chunks)

            if sha256.hexdigest() != sha256_expected:
                raise ContainerIntegrityError("container.checksum_mismatch")

            _publish_new_file(tmp_path, output_path)
        except BaseException:
            tmp_path.unlink(missing_ok=True)
            raise
    return meta


def decrypt_file(input_path, output_path, imk: bytes, on_progress: ProgressCallback = None,
                 pq_seed: Optional[bytes] = None, passphrase=None) -> None:
    """解密 kind=file 的容器。若 input_path 其实是文件夹容器则抛 InvalidContainerError
    "container.is_folder_container"，调用方应先看 read_header() 的 "kind" 并改走 decrypt_folder_to_t
    emp
    （文件夹有单独的先预览再解压流程）。`passphrase` 仅对口令封装的容器生效，身份容器忽略。"""
    _decrypt_chunks_to_file(input_path, output_path, imk, on_progress, expected_kind=KIND_FILE, pq_seed=pq_seed,
                            passphrase=passphrase)


# 只校验、不解密落盘：用与解密完全相同的认证（每块 AEAD 标签、块序号绑 nonce、块数对上
# plaintext_size、整体 sha256），解出的字节进哈希即丢，不写盘也不让明文落地。
# 篡改是结论而非异常：返回 intact=False 并指出第几块；只有无法校验（非容器、密钥不对、要口令）才
# 抛 InvalidContainerError。

# 头部里的 chunk_size 在解开 FK 之前没有认证。校验要按它分配缓冲区，所以设个上限，
# 免得一个被改过的头部让我们去申请几个 GB。写入端恒为 CHUNK_SIZE（4 MiB）。
_MAX_VERIFY_CHUNK_SIZE = 64 * 1024 * 1024


def _wrap_kind(header: dict) -> str:
    if header_is_passphrase_sealed(header):
        return "passphrase"
    if header_is_post_quantum(header):
        return "post_quantum"
    return "identity"


def verify_container(input_path, imk: bytes, on_progress: ProgressCallback = None,
                     pq_seed: Optional[bytes] = None, passphrase=None) -> dict:
    """不写任何明文，认证文件/文件夹容器的每个块和整体明文 SHA-256。
    返回含 intact、failure、failed_chunk、chunks_checked/expected、bytes_checked、plaintext_size、
    container_size、kind、original_filename、sha256_plaintext、cipher、wrap、format_version、elapsed
    _s 的 dict，
    完好的文件夹容器另有 entry_count/file_count。`failure` 为 None 或
    "metadata"/"chunk"/"truncated"/"trailing_data"/"checksum"/"archive" 之一。"""
    started = time.monotonic()
    input_path = Path(input_path)
    keyring = crypto.as_passphrase_keyring(passphrase)
    container_size = input_path.stat().st_size

    with _open_sequential_read(input_path) as fin:
        header = _read_raw_header(fin)
        data_start = fin.tell()
        cipher = _header_cipher(header)
        fk = _unwrap_fk(header, imk, pq_seed, keyring)
        result = {
            "intact": False,
            "failure": None,
            "failed_chunk": None,
            "chunks_checked": 0,
            "chunks_expected": 0,
            "bytes_checked": 0,
            "plaintext_size": None,
            "container_size": container_size,
            "kind": None,
            "original_filename": None,
            "sha256_plaintext": None,
            "cipher": cipher,
            "wrap": _wrap_kind(header),
            "format_version": header["format_version"],
            "elapsed_s": 0.0,
        }

        def _done(failure: Optional[str] = None, chunk: Optional[int] = None) -> dict:
            result["failure"] = failure
            result["failed_chunk"] = chunk
            result["intact"] = failure is None
            result["elapsed_s"] = round(time.monotonic() - started, 4)
            return result

        try:
            meta = _metadata_with_fk(header, fk)
        except ContainerIntegrityError:
            return _done("metadata")
        try:
            nonce_prefix = base64.b64decode(header["file_nonce_prefix"])
            chunk_size = int(header["chunk_size"])
            plaintext_size = int(meta["plaintext_size"])
            sha256_expected = meta["sha256_plaintext"]
        except (KeyError, TypeError, ValueError) as exc:
            raise InvalidContainerError("container.invalid_header") from exc
        if not 0 < chunk_size <= _MAX_VERIFY_CHUNK_SIZE or plaintext_size < 0:
            raise InvalidContainerError("container.invalid_header")

        expected = expected_chunk_count(plaintext_size, chunk_size)
        result.update({
            "chunks_expected": expected,
            "plaintext_size": plaintext_size,
            "kind": meta["kind"],
            "original_filename": meta["original_filename"],
            "sha256_plaintext": sha256_expected,
        })

        # 预分配并就地解密（decrypt_into）：此路径没有写盘掩盖 CPU 开销，每块少一次 4 MiB 分配和拷贝很明显
        # （见 _decrypt_chunks_to_file 上方的实测说明）。
        aead = crypto.FILE_CIPHERS[cipher][0](fk)
        len_buf = bytearray(_CHUNK_LEN_STRUCT.size)
        ct_buf = bytearray(chunk_size + _AEAD_TAG_LEN)
        ct_view = memoryview(ct_buf)
        pt_buf = bytearray(chunk_size)
        pt_view = memoryview(pt_buf)
        sha256 = hashlib.sha256()
        index = 0
        while True:
            got = fin.readinto(len_buf)
            if got == 0:
                break
            if got != len(len_buf):
                return _done("truncated", index)
            if index >= expected:
                return _done("trailing_data", index)
            (chunk_len,) = _CHUNK_LEN_STRUCT.unpack(len_buf)
            if not _AEAD_TAG_LEN < chunk_len <= len(ct_buf):
                return _done("chunk", index)
            if fin.readinto(ct_view[:chunk_len]) != chunk_len:
                return _done("truncated", index)
            plain_len = chunk_len - _AEAD_TAG_LEN
            try:
                aead.decrypt_into(_chunk_nonce(nonce_prefix, index), ct_view[:chunk_len], None,
                                  pt_view[:plain_len])
            except (crypto.InvalidTag, ValueError):
                return _done("chunk", index)
            sha256.update(pt_view[:plain_len])
            index += 1
            result["chunks_checked"] = index
            result["bytes_checked"] += plain_len
            if on_progress:
                on_progress(index, expected)

    if index < expected or result["bytes_checked"] != plaintext_size:
        return _done("truncated", index)
    if sha256.hexdigest() != sha256_expected:
        return _done("checksum")

    if meta["kind"] == KIND_FOLDER:
        # 整体哈希已经对上，说明这就是当初封进去的那个 ZIP；再读一下中央目录
        # 给出条目数（只解末尾几块，毫秒级）。
        reader = _ContainerPlaintextReader(
            input_path, cipher, fk, nonce_prefix, data_start, chunk_size, plaintext_size,
        )
        try:
            with zipfile.ZipFile(reader) as zf:
                infos = zf.infolist()
            result["entry_count"] = len(infos)
            result["file_count"] = sum(1 for zi in infos if not zi.filename.endswith("/"))
        except (zipfile.BadZipFile, ContainerIntegrityError):
            return _done("archive")
        finally:
            reader.close()
    if on_progress:
        on_progress(max(expected, 1), max(expected, 1))
    return _done()


# 文件夹容器：文件夹打成不压缩（ZIP_STORED）的 zip，再对 zip 字节分块加密，
# 容器格式不新增块流种类，仍是同样的 header+chunks，只由 meta.kind 标明明文是 zip。
# 加密真正单遍：zipfile 写入 _ChunkingEncryptWriter，每满 CHUNK_SIZE 即加密成帧，明文 zip 从不完
# 整落地。
# 解密做不到：zip 中央目录在末尾，列文件需随机访问，所以 decrypt_folder_to_temp 先解到真实临时文
# 件再列出；
# extract_folder_temp / discard_folder_temp 是该临时文件生命周期的两种结束方式（提交到目标，或预
# 览后取消丢弃）。


def _collect_folder_entries(folder_path: Path) -> List[Tuple[str, Optional[Path]]]:
    """遍历 folder_path，返回 [(arcname, abs_path_or_None), ...]；abs_path 为 None 表示空目录占位
    （zip 无其它表示方式）。arcname 恒用 '/' 且相对 folder_path，解压后在任意目标目录重建同一棵树，
    不含绝对路径。"""
    entries: List[Tuple[str, Optional[Path]]] = []
    for dirpath, dirnames, filenames in os.walk(folder_path):
        rel_dir = os.path.relpath(dirpath, folder_path)
        for name in filenames:
            rel = name if rel_dir == "." else f"{rel_dir}{os.sep}{name}"
            entries.append((rel.replace(os.sep, "/"), Path(dirpath) / name))
        if not dirnames and not filenames and rel_dir != ".":
            entries.append((rel_dir.replace(os.sep, "/") + "/", None))
    return entries


# 加密流水线同时存在的缓冲区数：3 块 = 主线程填一块、密封线程处理一块、队列压一块，
# 足以让"读源文件 + CRC32"与"sha256 + AEAD + 写盘"完全重叠；再多只占内存。
_SEAL_BUFFERS = 3

# 从源文件搬进 zip 成员时单次搬运的上限。CPython 的 ZipFile.write() 写死 copyfileobj(..., 8192)，
# 512 MB 文件要调 write() 65536 次，纯 Python 调用开销是加密大文件时最大的一块成本；4 MiB 后只需
#  128 次。
_COPY_BLOCK = 4 * 1024 * 1024

# 但不能无脑用上限（实测踩坑）：BufferedReader.read(n) 会先按 n 分配 bytes 再缩回，
# 每个 134 KB 小文件都分配 4 MiB，2000 个小文件从 89 降到 38 MB/s。所以按文件自身大小定，小文件
# 一次搬完。
_MIN_COPY_BLOCK = 64 * 1024


def _zip_write_file(zf: zipfile.ZipFile, abs_path: Path, arcname: str) -> None:
    """把文件写进 zip，语义等价于 `zf.write(abs_path, arcname)`，区别仅在搬运缓冲按文件大小自适应
    （见 _COPY_BLOCK / _MIN_COPY_BLOCK）。其余照抄 CPython 的 ZipFile.write() 非目录分支
    （ZipInfo.from_file、归档默认压缩、zf.open(zinfo, "w")）；刻意不自拼 ZipInfo，写错的表现是解压时
    才发现容器坏了。"""
    info = zipfile.ZipInfo.from_file(
        abs_path, arcname, strict_timestamps=getattr(zf, "_strict_timestamps", True)
    )
    info.compress_type = zf.compression
    info._compresslevel = zf.compresslevel
    block = min(_COPY_BLOCK, max(info.file_size, _MIN_COPY_BLOCK))
    with open(abs_path, "rb") as src, zf.open(info, "w") as dest:
        shutil.copyfileobj(src, dest, block)


class _ChunkingEncryptWriter:
    """只写的类文件适配器：zipfile 遍历源文件夹时把归档字节 write() 进来，这里缓冲后按 encrypt_file
    相同的落盘布局分块加密成帧直接写 `fout`，文件夹的 zip 从不完整落在内存或磁盘，只占约一个 CHUNK_S
    IZE 缓冲。
    刻意只暴露 write()、不提供 tell()/seek()：zipfile 探测不到时会在每个条目后写 data descriptor，
    而不回头原地修补本地头，这是 zip 对流式输出的标准做法，也是单遍流式成立的前提。"""

    def __init__(
        self,
        fout,
        cipher: str,
        fk: bytes,
        nonce_prefix: bytes,
        sha256,
        on_progress: ProgressCallback,
        total_chunks_estimate: int,
    ) -> None:
        self._fout = fout
        self._cipher = cipher
        self._fk = fk
        self._nonce_prefix = nonce_prefix
        self._sha256 = sha256
        self._on_progress = on_progress
        self._total_estimate = total_chunks_estimate
        self.chunk_index = 0
        self.total_bytes_written = 0

        # 预分配一小组定长缓冲循环使用。原先 bytearray += data 再 bytes(buf[:CHUNK_SIZE]) / del buf[:CHU
        # NK_SIZE]，
        # 512 MB 文件夹在此耗 2.66 秒（占整次加密 48%），全是反复扩容和头部删除的 memmove；
        # 改成定长缓冲 + memoryview 按偏移填充后不再多搬一个字节。
        self._free: "queue.Queue[bytearray]" = queue.Queue()
        for _ in range(_SEAL_BUFFERS):
            self._free.put(bytearray(CHUNK_SIZE))
        self._jobs: "queue.Queue" = queue.Queue()
        self._error: Optional[BaseException] = None
        self._buf = self._free.get()
        self._view = memoryview(self._buf)
        self._fill = 0
        # 密封（sha256 + AEAD + 写盘）放后台线程，与主线程的"读源文件 + zipfile CRC32"完全重叠；
        # 两边都会释放 GIL（OpenSSL 绑定 / 文件 I/O），是真并行。
        self._sealer = threading.Thread(target=self._seal_loop, name="ivault-seal", daemon=True)
        self._sealer.start()

    def write(self, data) -> int:
        # 后台密封线程出错后，继续往里塞数据没有任何意义——立刻把错误抛回
        # 调用方（zipfile），让 encrypt_folder 的失败路径去删临时文件。
        if self._error is not None:
            raise self._error
        src = data if isinstance(data, memoryview) else memoryview(data)
        total = len(src)
        self.total_bytes_written += total
        offset = 0
        while offset < total:
            take = min(CHUNK_SIZE - self._fill, total - offset)
            self._view[self._fill:self._fill + take] = src[offset:offset + take]
            self._fill += take
            offset += take
            if self._fill == CHUNK_SIZE:
                self._submit(CHUNK_SIZE)
        return total

    def _submit(self, length: int) -> None:
        """把当前缓冲交给密封线程并换一块空闲缓冲继续填。`_free` 总数固定，这里的 get() 天然是背压：
        密封跟不上时主线程在此等待，内存恒为 `_SEAL_BUFFERS × CHUNK_SIZE`。"""
        self._jobs.put((self._buf, length))
        self._buf = self._free.get()
        self._view = memoryview(self._buf)
        self._fill = 0

    def _seal_loop(self) -> None:
        while True:
            job = self._jobs.get()
            if job is None:
                return
            buf, length = job
            # 出错后仍要把队列里的缓冲收回 `_free`，否则主线程会永远卡在 `_free.get()`，后台线程一死就挂住整
            # 个进程。
            if self._error is None:
                try:
                    self._seal_chunk(memoryview(buf)[:length])
                except BaseException as exc:  # noqa: BLE001 - 原样转交给主线程
                    self._error = exc
            self._free.put(buf)

    def flush(self) -> None:
        # ZipFile.close() 无条件调 fp.flush()；这里写入本就逐块直达 `fout`，flush 只为防 close() 抛 Attr
        # ibuteError。
        # 缓冲里剩余的字节由调用方随后显式调用的 finalize() 处理，所以不在此提前刷出不足一块的数据。
        pass

    def _seal_chunk(self, plaintext_chunk) -> None:
        """只在密封线程里跑。队列单消费者，`chunk_index`（绑进每块 nonce）严格按提交顺序分配，
        乱序会使容器再也解不开。"""
        if self.chunk_index >= _META_CHUNK_INDEX:
            raise InvalidContainerError("container.file_too_large")
        self._sha256.update(plaintext_chunk)
        nonce = _chunk_nonce(self._nonce_prefix, self.chunk_index)
        ciphertext = crypto.file_aead_encrypt(self._cipher, self._fk, nonce, plaintext_chunk)
        self._fout.write(_CHUNK_LEN_STRUCT.pack(len(ciphertext)))
        self._fout.write(ciphertext)
        self.chunk_index += 1
        if self._on_progress:
            self._on_progress(self.chunk_index, self._total_estimate)

    def finalize(self) -> None:
        """把缓冲里剩余数据（通常不足 CHUNK_SIZE）作为末块冲出；解密本就支持短末块。
        阻塞到密封线程排空队列：返回后 `fout` 里是完整密文流，调用方可安全回头改写头部。"""
        if self._fill:
            self._submit(self._fill)
        self.shutdown()
        if self._error is not None:
            raise self._error

    def shutdown(self) -> None:
        """停掉密封线程，不冲刷缓冲剩余内容；失败路径专用（半成品容器马上删除），可重复调用。
        否则 `with zipfile.ZipFile(writer)` 抛异常时 finalize() 不会被调用，线程挂在 `_jobs.get()`，
        每次失败泄漏一个线程和 `_SEAL_BUFFERS × 4 MiB` 内存。"""
        if self._sealer.is_alive():
            self._jobs.put(None)
            self._sealer.join()


# folder 容器 meta JSON 里 plaintext_size 的零填充宽度：20 位可表示约 9.5*10^19 字节，
# 保证"先占位再覆盖"时真实值不会比占位更宽。
_FOLDER_SIZE_WIDTH = 20


def encrypt_folder(
    folder_path,
    output_path,
    imk: bytes,
    on_progress: ProgressCallback = None,
    cipher: str = crypto.DEFAULT_FILE_CIPHER,
    pq_public_key: Optional[bytes] = None,
    passphrase=None,
) -> None:
    """把整个文件夹（含空子目录）加密成一个 .ivault：打成 ZIP_STORED（不压缩，密文本就不可压缩，
    先压只白费 CPU），由 _ChunkingEncryptWriter 单遍分块加密，明文 zip 从不完整落盘。
    读取路径是 decrypt_folder_to_temp。"""
    folder_path = Path(folder_path)
    output_path = Path(output_path)
    _check_not_same_file(folder_path, output_path)
    _reject_retired_cipher(cipher)
    if not folder_path.is_dir():
        raise InvalidContainerError("container.not_a_directory")

    entries = _collect_folder_entries(folder_path)
    # 仅估算，用作进度条分母：zipfile 产出前真实大小未知（每条目 zip 开销不定长）。
    # 头里真实的 plaintext_size 另走下面的定宽零填充。
    estimated_total_bytes = sum(p.stat().st_size for _, p in entries if p is not None)
    total_chunks_estimate = max(1, expected_chunk_count(estimated_total_bytes, CHUNK_SIZE))

    fk = crypto.generate_file_key(cipher)
    fk_wrap_json = _wrap_fk_for_header(imk, fk, pq_public_key, passphrase)
    nonce_prefix = os.urandom(NONCE_PREFIX_LEN)

    def _serialize_header(meta_ciphertext: bytes) -> bytes:
        header = {
            "format_version": FORMAT_VERSION,
            "chunk_size": CHUNK_SIZE,
            "cipher": cipher,
            "file_nonce_prefix": base64.b64encode(nonce_prefix).decode(),
            **fk_wrap_json,
            "meta": base64.b64encode(meta_ciphertext).decode(),
        }
        return json.dumps(header).encode("utf-8")

    def _meta_json(sha256_hex: str, plaintext_size: int) -> bytes:
        # plaintext_size 零填充到定宽（_FOLDER_SIZE_WIDTH），使占位调用与真实调用的 JSON 字节长度一致：
        # 这里不像 encrypt_file 能预知大小，"预留空间、边加密边哈希、回头覆盖"需要宽度不变的表示。
        return json.dumps({
            "original_filename": folder_path.name,
            "plaintext_size": str(plaintext_size).zfill(_FOLDER_SIZE_WIDTH),
            "sha256_plaintext": sha256_hex,
            "kind": KIND_FOLDER,
        }).encode("utf-8")

    placeholder_meta_ciphertext = bytes(len(_meta_json(_PLACEHOLDER_SHA256, 0)) + _META_TAG_LEN)
    placeholder_header_bytes = _serialize_header(placeholder_meta_ciphertext)

    tmp_path, tmp_fd = _create_output_temp(output_path)
    try:
        with os.fdopen(tmp_fd, "wb") as fout:
            fout.write(_HEADER_LEN_STRUCT.pack(len(placeholder_header_bytes)))
            fout.write(placeholder_header_bytes)

            sha256 = hashlib.sha256()
            writer = _ChunkingEncryptWriter(
                fout, cipher, fk, nonce_prefix, sha256, on_progress, total_chunks_estimate
            )
            try:
                with zipfile.ZipFile(writer, mode="w", compression=zipfile.ZIP_STORED) as zf:
                    for arcname, abs_path in entries:
                        if abs_path is None:
                            zf.writestr(zipfile.ZipInfo(arcname), b"")
                        else:
                            _zip_write_file(zf, abs_path, arcname)
                writer.finalize()
            finally:
                # finalize() 正常返回时线程已经停了，这里是幂等的空操作；
                # 上面任何一步抛异常时它才真正起作用——见 shutdown() 的说明。
                writer.shutdown()

            real_meta_ciphertext = crypto.file_aead_encrypt(
                cipher, fk, _chunk_nonce(nonce_prefix, _META_CHUNK_INDEX),
                _meta_json(sha256.hexdigest(), writer.total_bytes_written), _META_AAD,
            )
            real_header_bytes = _serialize_header(real_meta_ciphertext)
            # 由构造保证（定宽零填充大小、恒 64 字符的 sha256 hex）；原地覆盖预留区仅在不改变长度时才安全。
            assert len(real_header_bytes) == len(placeholder_header_bytes)

            fout.seek(0)
            fout.write(_HEADER_LEN_STRUCT.pack(len(real_header_bytes)))
            fout.write(real_header_bytes)
        _publish_new_file(tmp_path, output_path)
    except BaseException:
        tmp_path.unlink(missing_ok=True)
        raise


_AEAD_TAG_LEN = 16  # GCM / ChaCha20-Poly1305 都是固定 16 字节 tag

# "每块都有自己的认证标签"是格式的硬保证。显式导出常量，让安全体检面板（security_health.py）读到
# 真实事实：
# 若有人改成只在文件末尾放一个总标签，这里须改 False，面板当场变红；getattr 兜默认值做不到。
PER_CHUNK_AUTH_TAGS = _AEAD_TAG_LEN > 0

# 解密侧预取线程数。AEAD 解密走 OpenSSL 绑定会释放 GIL，与主线程的 zipfile CRC32 校验和写盘真并
# 行；
# 窗口 3 块（12 MiB）足以填满两边，再大只占内存。
_PREFETCH_WORKERS = 2
_PREFETCH_CHUNKS = 3


class _ContainerPlaintextReader(io.RawIOBase):
    """只读、可 seek 的容器明文视图：按需解密，不落临时文件。

    以前查看加密文件夹内容要先把整个容器解成临时明文 ZIP（中央目录在文件尾），确认后再解压，
    10 GB 文件夹写 20 GB，且完整解密发生在用户点确认之前，对话框无进度。
    现在靠格式本身：每块是 `[4 字节密文长度][密文]`，非末块明文长度恒等于 header 的 chunk_size，
    密文多 16 字节 tag，第 i 块偏移可直接算出，所以列清单只解末尾几百 KB，解压每个文件只写一遍。

    完整性不变：每块独立 AEAD 密封且 nonce 带块序号，调换、替换、伪造都当场失败，
    截断由已认证元数据的 plaintext_size 兜住；交给调用方的每个字节都先通过了自己那块的校验。
    """

    def __init__(self, path: Path, cipher: str, fk: bytes, nonce_prefix: bytes,
                 data_start: int, chunk_size: int, plaintext_size: int,
                 prefetch: int = 0):
        super().__init__()
        self._fin = open(path, "rb")
        self._cipher = cipher
        self._fk = fk
        self._nonce_prefix = nonce_prefix
        self._data_start = data_start
        self.chunk_size = chunk_size
        self._size = plaintext_size
        self._pos = 0
        # 单块缓存就够：zipfile 在一个成员内部是顺序读的，跨成员才跳。
        self._cached_index = -1
        self._cached_plain = b""
        self._last_index = (plaintext_size - 1) // chunk_size if plaintext_size else -1

        # 预取窗口：解压是顺序读，后台线程提前解后几块，AEAD 解密与主线程的 zipfile CRC32 / 写盘
        # （都释放 GIL）重叠。只列清单时只读末尾几百 KB 用不着，默认关闭。
        self._prefetch = max(0, prefetch)
        self._pool: Optional[ThreadPoolExecutor] = None
        self._futures: "Dict[int, Future]" = {}
        if self._prefetch:
            self._pool = ThreadPoolExecutor(
                max_workers=_PREFETCH_WORKERS, thread_name_prefix="ivault-prefetch"
            )

        # 累计已交出的明文字节数，解压进度条读它：按 zip 成员数报的话，只装一个大文件的文件夹全程只报一
        # 次，
        # 沉默会耗尽前端 20 秒静默超时。进度必须在读的过程中报，zf.extract() 解 10 GB 成员时不会返回。
        self.bytes_served = 0
        self.on_bytes: Optional[Callable[[int], None]] = None
        self._last_report = 0.0

    def readable(self) -> bool:
        return True

    def seekable(self) -> bool:
        return True

    def writable(self) -> bool:
        return False

    def tell(self) -> int:
        return self._pos

    def seek(self, offset: int, whence: int = os.SEEK_SET) -> int:
        if whence == os.SEEK_SET:
            target = offset
        elif whence == os.SEEK_CUR:
            target = self._pos + offset
        elif whence == os.SEEK_END:
            target = self._size + offset
        else:
            raise ValueError(f"invalid whence: {whence}")
        self._pos = max(0, min(target, self._size))
        return self._pos

    def close(self) -> None:
        try:
            if self._pool is not None:
                for fut in self._futures.values():
                    fut.cancel()
                self._futures.clear()
                self._pool.shutdown(wait=True)
            self._fin.close()
        finally:
            self._cached_plain = b""
            super().close()

    def readall(self) -> bytes:
        return self.read(self._size - self._pos)

    def read(self, size: int = -1) -> bytes:
        if size is None or size < 0:
            size = self._size - self._pos
        size = min(size, self._size - self._pos)
        if size <= 0:
            return b""

        index = self._pos // self.chunk_size
        start = self._pos - index * self.chunk_size
        plain = self._chunk(index)

        # 快路：整次请求落在一块之内。块 4 MiB 而 zipfile 一次最多读 1 MiB，解压时几乎每次读都走这里，
        # 直接切片返回；原通路的"切片 + bytearray 累加 + bytes() 再拷贝"占解压总耗时 30%。
        if start + size <= len(plain):
            self._pos += size
            self.bytes_served += size
            self._report()
            return plain[start:start + size]

        out = bytearray(size)
        view = memoryview(out)
        filled = 0
        while filled < size:
            take = min(size - filled, len(plain) - start)
            if take <= 0:
                break
            view[filled:filled + take] = plain[start:start + take]
            filled += take
            self._pos += take
            if filled < size:
                index += 1
                start = 0
                plain = self._chunk(index)
        self.bytes_served += filled
        self._report()
        return bytes(out[:filled]) if filled != size else bytes(out)

    def _report(self) -> None:
        if self.on_bytes is None:
            return
        now = time.monotonic()
        if now - self._last_report < _PROGRESS_INTERVAL_S:
            return
        self._last_report = now
        self.on_bytes(self.bytes_served)

    def readinto(self, buffer) -> int:
        data = self.read(len(buffer))
        buffer[: len(data)] = data
        return len(data)

    def _chunk(self, index: int) -> bytes:
        if index == self._cached_index:
            return self._cached_plain
        if self._pool is not None:
            plain = self._chunk_prefetched(index)
        else:
            plain = self._decrypt_chunk(index, self._read_ciphertext(index))
        self._cached_index = index
        self._cached_plain = plain
        return plain

    def _chunk_prefetched(self, index: int) -> bytes:
        future = self._futures.pop(index, None)
        if future is None:
            # 跳读了（或者这是第一次读）。已排队的那些预取全部作废——留着只会
            # 占着线程去解一批马上就要被丢掉的块。
            for stale in self._futures.values():
                stale.cancel()
            self._futures.clear()
            future = self._pool.submit(self._decrypt_chunk, index, self._read_ciphertext(index))
        # 先把后面几块的密文读出来排进池子，**再**去等当前这块。顺序是有意的：
        # 等的这段时间后台正好在解后面几块。
        self._queue_ahead(index + 1)
        return future.result()

    def _queue_ahead(self, start_index: int) -> None:
        stop = min(start_index + self._prefetch, self._last_index + 1)
        for i in range(start_index, stop):
            if i not in self._futures:
                self._futures[i] = self._pool.submit(self._decrypt_chunk, i, self._read_ciphertext(i))

    def _read_ciphertext(self, index: int) -> bytes:
        """读出第 index 块的密文。只能在主线程调用：`self._fin` 是共享句柄，多线程各自 seek 会互踩读位置；
        后台线程只做 AEAD 解密（不碰文件），不影响并行度。"""
        stored_full = _CHUNK_LEN_STRUCT.size + self.chunk_size + _AEAD_TAG_LEN
        self._fin.seek(self._data_start + index * stored_full)
        len_bytes = self._fin.read(_CHUNK_LEN_STRUCT.size)
        if len(len_bytes) != _CHUNK_LEN_STRUCT.size:
            raise ContainerIntegrityError("container.corrupted")
        (chunk_len,) = _CHUNK_LEN_STRUCT.unpack(len_bytes)
        # 算出的偏移必须正好落在真实块头上；长度对不上说明容器不是"等长块"布局（换过格式或被改过），
        # 要当场停，继续读只会得到看似合理的垃圾。
        expected_plain = min(self.chunk_size, self._size - index * self.chunk_size)
        if expected_plain <= 0 or chunk_len != expected_plain + _AEAD_TAG_LEN:
            raise ContainerIntegrityError("container.corrupted")
        ciphertext = self._fin.read(chunk_len)
        if len(ciphertext) != chunk_len:
            raise ContainerIntegrityError("container.corrupted")
        return ciphertext

    def _decrypt_chunk(self, index: int, ciphertext: bytes) -> bytes:
        try:
            return crypto.file_aead_decrypt(
                self._cipher, self._fk, _chunk_nonce(self._nonce_prefix, index), ciphertext
            )
        except (crypto.InvalidTag, ValueError):
            raise ContainerIntegrityError("container.corrupted")


def _open_container_plaintext(input_path, imk: bytes, pq_seed: Optional[bytes] = None,
                              prefetch: int = 0, passphrase=None):
    """打开 folder-kind 容器的明文视图，返回 (reader, meta)。
    `prefetch` 只对顺序读（解压）有意义；列清单只读末尾几百 KB，开预取白起线程，默认 0。"""
    input_path = Path(input_path)
    with open(input_path, "rb") as fin:
        header = _read_raw_header(fin)
        data_start = fin.tell()
    cipher = _header_cipher(header)
    fk = _unwrap_fk(header, imk, pq_seed, passphrase)
    meta = _metadata_with_fk(header, fk)
    if meta["kind"] != KIND_FOLDER:
        raise InvalidContainerError("container.not_a_folder_container")
    try:
        nonce_prefix = base64.b64decode(header["file_nonce_prefix"])
        chunk_size = int(header["chunk_size"])
        plaintext_size = int(_coerce_plaintext_size(meta["plaintext_size"]))
    except (KeyError, TypeError, ValueError) as exc:
        raise InvalidContainerError("container.invalid_header") from exc
    reader = _ContainerPlaintextReader(
        input_path, cipher, fk, nonce_prefix, data_start, chunk_size, plaintext_size,
        prefetch=prefetch,
    )
    return reader, meta


def list_folder_container(input_path, imk: bytes, pq_seed: Optional[bytes] = None, passphrase=None) -> dict:
    """列出加密文件夹的内容：不产生临时文件、不整包解密，只解 ZIP 中央目录所在的末尾几块。"""
    reader, meta = _open_container_plaintext(input_path, imk, pq_seed, passphrase=passphrase)
    try:
        with zipfile.ZipFile(reader) as zf:
            entries = [
                {"name": zi.filename, "size": zi.file_size, "is_dir": zi.filename.endswith("/")}
                for zi in zf.infolist()
            ]
    except zipfile.BadZipFile as exc:
        raise ContainerIntegrityError("container.corrupted") from exc
    finally:
        reader.close()
    return {"original_name": meta.get("original_filename", ""), "entries": entries}


def extract_folder_container(input_path, output_dir, imk: bytes,
                             on_progress: ProgressCallback = None,
                             pq_seed: Optional[bytes] = None, passphrase=None) -> None:
    """把加密文件夹直接解到 output_dir，整份数据只过一遍。

    不单独先校验一遍 sha256：本格式解密即验证。每块独立 AEAD 密封且 nonce 绑块序号（见 _chunk_nonce
    ），
    改字节则该块 tag 对不上，`_decrypt_chunk` 当场抛错；调换或跨容器替换则块序号/文件密钥对不上；
    尾部截断由已认证元数据的 plaintext_size 兜住。多读一遍 sha256 发现不了更多，
    却使 512 MB 文件夹多花 2.09 秒（占解压 40%）。
    "校验不过就一个字节都不落到目标目录"靠 staging 目录 + 整体改名保证：中途任一块失败即删 staging，
    output_dir 从未被创建。

    进度按已解出的字节数报，不按 zip 成员数：只装一个大文件时按成员只会报一次，会耗尽前端静默超时。
    """
    output_dir = Path(output_dir)
    if output_dir.exists():
        raise InvalidContainerError("container.destination_exists", path=str(output_dir))
    if not output_dir.parent.is_dir():
        raise InvalidContainerError("container.destination_parent_missing", path=str(output_dir.parent))

    reader, meta = _open_container_plaintext(input_path, imk, pq_seed, prefetch=_PREFETCH_CHUNKS,
                                             passphrase=passphrase)
    staging_dir: Optional[Path] = None
    try:
        total = max(1, int(_coerce_plaintext_size(meta["plaintext_size"])))
        if on_progress:
            reader.on_bytes = lambda served: on_progress(min(served, total), total)
        staging_dir = _folder_staging_dir(output_dir)
        staging_dir.mkdir()
        resolved_root = staging_dir.resolve()
        with zipfile.ZipFile(reader) as zf:
            infos = zf.infolist()
            for info in infos:
                target = (staging_dir / info.filename).resolve()
                if target != resolved_root and resolved_root not in target.parents:
                    raise ContainerIntegrityError("container.corrupted")
                # encrypt_folder 从不产出符号链接；解压一个就等于让恶意档案把后续
                # 写入重定向到 staging 之外。
                if (info.external_attr >> 16) & 0o170000 == 0o120000:
                    raise ContainerIntegrityError("container.corrupted")
            for info in infos:
                # 进度由 reader 自己报（见 on_bytes），不在此循环：zf.extract() 解 10 GB 成员要几分钟，循环体拿
                # 不到机会。
                zf.extract(info, staging_dir)
        if on_progress:
            on_progress(total, total)
        _publish_new_directory(staging_dir, output_dir)
        staging_dir = None
    finally:
        reader.close()
        if staging_dir is not None:
            shutil.rmtree(staging_dir, ignore_errors=True)


def decrypt_folder_to_temp(input_path, imk: bytes, on_progress: ProgressCallback = None,
                           pq_seed: Optional[bytes] = None, passphrase=None) -> dict:
    """把 folder-kind .ivault 解到临时明文 zip 但不解压，供调用方从 zip 中央目录显示文件列表，
    并在任何内容落到真实目标目录前让用户确认。返回 {"temp_zip_path", "original_name",
    "entries": [{"name", "size", "is_dir"}, ...]}。调用方最终必须对 temp_zip_path 调
    extract_folder_temp() 或 discard_folder_temp()，本函数只在自身失败时删它。
    input_path 是 kind=file 容器则抛 InvalidContainerError("container.not_a_folder_container")。"""
    tmp_path = Path(tempfile.gettempdir()) / f"{_FOLDER_TEMP_PREFIX}{uuid.uuid4().hex}.zip"
    try:
        meta = _decrypt_chunks_to_file(input_path, tmp_path, imk, on_progress, expected_kind=KIND_FOLDER,
                                       pq_seed=pq_seed, passphrase=passphrase)
        with zipfile.ZipFile(tmp_path) as zf:
            entries = [
                {"name": zi.filename, "size": zi.file_size, "is_dir": zi.filename.endswith("/")}
                for zi in zf.infolist()
            ]
    except BaseException:
        tmp_path.unlink(missing_ok=True)
        raise
    return {
        "temp_zip_path": str(tmp_path),
        "original_name": meta.get("original_filename", ""),
        "entries": entries,
    }


def cleanup_stale_folder_temps(temp_dir: Optional[Path] = None) -> None:
    """尽力清理后端崩溃遗留的预览 ZIP。预览 zip 含明文（ZIP 需随机访问），正常确认/取消都会立即删，
    这次启动扫描覆盖唯一的缺口：预览对话框打开时应用或后端崩溃。文件名前缀仅本模块使用，不碰无关临时
    文件。"""
    root = Path(temp_dir) if temp_dir is not None else Path(tempfile.gettempdir())
    for path in root.glob(f"{_FOLDER_TEMP_PREFIX}*.zip"):
        try:
            if path.is_file():
                path.unlink()
        except OSError:
            # 并发的预览可能抢先一步，或别的进程占着孤儿文件；这是尽力清理，不能让启动因此失败。
            pass


def _folder_staging_dir(output_dir: Path) -> Path:
    """返回事务式解压用的同级唯一 staging 目录：放同级（而非 output_dir 内）才能一次改名发布完整目录
    树；
    随机后缀避免与上次中断遗留的 staging 目录冲突。"""
    return output_dir.parent / f".{output_dir.name}.ivault-part-{uuid.uuid4().hex}"


def extract_folder_temp(temp_zip_path, output_dir) -> None:
    """事务式解压已解密的文件夹预览。目标目录必须不存在；成员先校验并解到私有的同级 staging 目录，
    全部写成功后才改名到位，因此失败不会留下半成品目标，也不会与已有用户文件夹合并或覆盖。

    预览 ZIP 在尝试解压之后无论成败都删除（明文可能已落盘）。下面两个目标目录检查故意排除在外：
    它们在碰临时文件前就运行，都意味着用户选错了文件夹，换一个即可；此时删预览会让输错目标
    付出整包重新解密的代价，重试时还只得到无用的"预览已过期"。

    拒绝任何解析后跑出 staging 根的条目名，仅作纵深防御：本代码库的 arcname 来自 relpath，
    不会含 ".." 或绝对路径，且容器经 AEAD 认证，被篡改的条目名早在解密时失败。
    """
    temp_zip_path = Path(temp_zip_path)
    output_dir = Path(output_dir)

    # 这两条在 try 外面，所以它们不会删掉预览——见上面 docstring 的说明。
    if output_dir.exists():
        raise InvalidContainerError("container.destination_exists", path=str(output_dir))
    if not output_dir.parent.is_dir():
        raise InvalidContainerError("container.destination_parent_missing", path=str(output_dir.parent))

    staging_dir: Optional[Path] = None
    try:
        staging_dir = _folder_staging_dir(output_dir)
        staging_dir.mkdir()
        resolved_root = staging_dir.resolve()
        with zipfile.ZipFile(temp_zip_path) as zf:
            for info in zf.infolist():
                target = (staging_dir / info.filename).resolve()
                if target != resolved_root and resolved_root not in target.parents:
                    raise ContainerIntegrityError("container.corrupted")
                # encrypt_folder 从不产出符号链接；解压它会让恶意归档在支持链接的平台上把后续写入重定向到 stagin
                # g 根之外。
                if (info.external_attr >> 16) & 0o170000 == 0o120000:
                    raise ContainerIntegrityError("container.corrupted")
            zf.extractall(staging_dir)
        _publish_new_directory(staging_dir, output_dir)
        staging_dir = None
    finally:
        if staging_dir is not None:
            shutil.rmtree(staging_dir, ignore_errors=True)
        temp_zip_path.unlink(missing_ok=True)


def discard_folder_temp(temp_zip_path) -> None:
    """Delete a temp zip from decrypt_folder_to_temp without extracting it -
    the user cancelled after seeing the preview list."""
    Path(temp_zip_path).unlink(missing_ok=True)


def _folder_crc_manifest(folder_path: Path) -> Tuple[dict, set]:
    """遍历 folder_path，返回 ({arcname: (size, crc32)}, {空目录 arcname})。
    用 zipfile.crc32 基于内容判断"已修改"，同大小的编辑也能发现；arcname 与 _collect_folder_entries
    的 '/' 相对路径约定一致，两份清单逐项对齐。"""
    files: dict = {}
    empty_dirs: set = set()
    for dirpath, dirnames, filenames in os.walk(folder_path):
        rel_dir = os.path.relpath(dirpath, folder_path)
        for name in filenames:
            rel = name if rel_dir == "." else f"{rel_dir}{os.sep}{name}"
            arcname = rel.replace(os.sep, "/")
            path = Path(dirpath) / name
            crc = 0
            size = 0
            with open(path, "rb") as fh:
                while True:
                    block = fh.read(CHUNK_SIZE)
                    if not block:
                        break
                    crc = zipfile.crc32(block, crc)
                    size += len(block)
            files[arcname] = (size, crc & 0xFFFFFFFF)
        if not dirnames and not filenames and rel_dir != ".":
            empty_dirs.add(rel_dir.replace(os.sep, "/") + "/")
    return files, empty_dirs


def diff_folder_against_container(source_folder, container_path, imk: bytes, on_progress: ProgressCallback = None,
                                  pq_seed: Optional[bytes] = None) -> dict:
    """对比现有源文件夹与已有 folder-kind .ivault，精确报告自上次加密以来新增/删除/修改/未变的文件
    （重新加密前的"看清改了什么"一步；单 zip 流格式无法只改变化字节，重加密是整体的）。
    修改判断基于内容：zip 条目中央目录已有 CRC-32，对现有文件重算同一 CRC，同大小编辑也能捕获。
    容器仅为读清单解到临时 zip（复用 decrypt_folder_to_temp），返回前一定丢弃。

    返回 {"original_name", "added", "removed", "modified", "unchanged_count", "empty_dirs_added",
    "empty_dirs_removed"}，列表按名排序；文件容器则抛 InvalidContainerError("container.not_a_folder_
    container")。"""
    source_folder = Path(source_folder)
    if not source_folder.is_dir():
        raise InvalidContainerError("container.not_a_directory")

    preview = decrypt_folder_to_temp(container_path, imk, on_progress, pq_seed=pq_seed)
    temp_zip = Path(preview["temp_zip_path"])
    try:
        container_files: dict = {}
        container_empty_dirs: set = set()
        with zipfile.ZipFile(temp_zip) as zf:
            for zi in zf.infolist():
                if zi.filename.endswith("/"):
                    container_empty_dirs.add(zi.filename)
                else:
                    container_files[zi.filename] = (zi.file_size, zi.CRC & 0xFFFFFFFF)
    finally:
        discard_folder_temp(temp_zip)

    live_files, live_empty_dirs = _folder_crc_manifest(source_folder)

    added = sorted(name for name in live_files if name not in container_files)
    removed = sorted(name for name in container_files if name not in live_files)
    modified = sorted(
        name for name in live_files if name in container_files and live_files[name] != container_files[name]
    )
    unchanged_count = sum(
        1 for name in live_files if name in container_files and live_files[name] == container_files[name]
    )
    return {
        "original_name": preview.get("original_name", ""),
        "added": added,
        "removed": removed,
        "modified": modified,
        "unchanged_count": unchanged_count,
        "empty_dirs_added": sorted(live_empty_dirs - container_empty_dirs),
        "empty_dirs_removed": sorted(container_empty_dirs - live_empty_dirs),
    }


def reencrypt_folder_container(
    source_folder,
    container_path,
    imk: bytes,
    on_progress: ProgressCallback = None,
    cipher: str = crypto.DEFAULT_FILE_CIPHER,
    pq_public_key: Optional[bytes] = None,
) -> None:
    """把 source_folder 重新加密成新容器，再换到 container_path 的位置，是 diff_folder_against_conta
    iner
    之后的后续步骤。仍是整体重加密（单 zip 流格式不能只改变化字节），"增量"只在于省去用户手动
    解密、对比、重加密、替换的往返。

    安全：任何中断点（崩溃、断电、杀软锁定）下磁盘上都存在完整且已验证的容器，要么是原 container_path
    （交换未开始），要么是可恢复的 "pre-reencrypt" 同级文件（交换中途中断且自动恢复也失败时保留，不
    静默删除）。
    container_path 从不出现半写入字节：两次改名都是整文件移动，不做字节级原地编辑。"""
    container_path = Path(container_path)
    if not container_path.is_file():
        raise InvalidContainerError("container.invalid_file")

    new_path = container_path.with_name(f".{container_path.name}.reencrypt-{uuid.uuid4().hex}.part")
    # encrypt_folder has its own internal atomicity (temp file, publish only
    # on full success) - if this raises, container_path was never touched.
    encrypt_folder(source_folder, new_path, imk, on_progress=on_progress, cipher=cipher,
                   pq_public_key=pq_public_key)

    aside_path = container_path.with_name(f".{container_path.name}.pre-reencrypt-{uuid.uuid4().hex}.part")
    try:
        _move_new_path(container_path, aside_path)
    except BaseException:
        new_path.unlink(missing_ok=True)
        raise
    try:
        _move_new_path(new_path, container_path)
    except BaseException:
        try:
            _move_new_path(aside_path, container_path)
        except BaseException:
            # 恢复本身失败：两份幸存者都不能删。aside_path（旧的）和 new_path（新的）都仍完好地留在磁盘上，
            # 抛出让调用方呈现，用户可手动恢复，不会静默丢掉两份好副本之一。
            raise
        new_path.unlink(missing_ok=True)
        raise
    aside_path.unlink(missing_ok=True)


def secure_delete_folder(folder_path, on_progress: ProgressCallback = None) -> None:
    """安全删除 folder_path 下的常规文件再删除其目录树。
    从不跟随链接：经符号链接覆写会改到源树之外的数据；链接本身不含明文，直接 unlink 才安全。

    单个不可读文件不中止遍历：以前首个 PermissionError 上抛，一个 desktop.ini 就让整棵源树明文全留；
    现在逐个尝试，真删不掉的由 SecureDeleteIncompleteError 按名上报，用户能知道哪些路径仍有明文。
    `on_progress` 必需：覆写 10 GB 文件夹要几十秒到几分钟，无进度会耗尽前端 20 秒静默超时，
    看起来像删除功能没跑。"""
    folder_path = Path(folder_path)
    failures: List[Tuple[Path, Exception]] = []
    files: List[Path] = []
    link_dirs: List[Path] = []
    for dirpath, dirnames, filenames in os.walk(folder_path, followlinks=False):
        for name in filenames:
            files.append(Path(dirpath) / name)
        # shutil.rmtree 的链接处理因平台而异：先单独删除每个链接目录，保证不遍历其目标。
        for name in list(dirnames):
            path = Path(dirpath) / name
            if path.is_symlink():
                dirnames.remove(name)
                link_dirs.append(path)

    # 分母用字节数不用文件个数：一个 8 GB 的视频和一个 1 KB 的 desktop.ini
    # 按个数算是一样的一格，进度条会在最后一格上停几分钟。
    sizes = []
    for path in files:
        try:
            sizes.append(0 if path.is_symlink() else path.stat().st_size)
        except OSError:
            sizes.append(0)
    total = max(1, sum(sizes))
    done = 0
    last_report = 0.0

    for path, size in zip(files, sizes):
        try:
            if path.is_symlink():
                path.unlink()
            else:
                secure_delete_file(path)
        except OSError as exc:
            failures.append((path, exc))
        done += size
        if on_progress:
            now = time.monotonic()
            if now - last_report >= _PROGRESS_INTERVAL_S:
                last_report = now
                on_progress(min(done, total), total)

    for path in link_dirs:
        try:
            path.unlink()
        except OSError:
            # A directory symlink/junction on Windows unlinks as a
            # directory, not as a file.
            try:
                os.rmdir(path)
            except OSError as exc:
                failures.append((path, exc))
    if on_progress:
        on_progress(total, total)

    shutil.rmtree(folder_path, onerror=_rmtree_clear_readonly)

    # 空目录被占住是最常见的残留原因（资源管理器打开着、某进程的工作目录），且占用往往瞬时，
    # 所以先退让重试几次，实在不行再报，免得用户对着空文件夹发问。
    for attempt in range(_RMTREE_RETRIES):
        if not folder_path.exists():
            break
        time.sleep(_RMTREE_RETRY_DELAY_S * (attempt + 1))
        shutil.rmtree(folder_path, onerror=_rmtree_clear_readonly)

    # rmtree's error handler swallows what it cannot fix, so "did it work" is
    # answered by looking at the filesystem, not by whether rmtree raised.
    if folder_path.exists():
        survivors = sorted(
            str(p) for p in folder_path.rglob("*") if p.is_file() or p.is_symlink()
        )
        if not survivors:
            # 文件都已删除，只剩空目录被占住：明文已销毁（安全相关的部分），属警告级而非失败，
            # 但用户要求删掉的文件夹仍在，需如实报告。
            raise SecureDeleteIncompleteError(
                "container.secure_delete_dir_remains",
                path=str(folder_path),
            )
        raise SecureDeleteIncompleteError(
            "container.secure_delete_incomplete",
            path=str(folder_path),
            count=len(survivors),
            sample="\n".join(survivors[:10]),
        )

    if failures:
        # 目录树已删，但有文件在删除前没能覆写（如被锁定后释放，再由 rmtree 删掉）：
        # 已删未覆写弱于承诺，要如实说明。
        raise SecureDeleteIncompleteError(
            "container.secure_delete_not_overwritten",
            path=str(folder_path),
            count=len(failures),
            sample="\n".join(str(p) for p, _ in failures[:10]),
        )


def _rmtree_clear_readonly(func, path, _exc_info):
    """shutil.rmtree 错误处理器：清除只读位后重试一次。用旧的 3 参数 `onerror` 而非 3.12 的 `onexc`，
    因为项目目标是 Python 3.9。"""
    _clear_readonly(Path(path))
    try:
        func(path)
    except OSError:
        # 确实卡住（句柄未释放、正在使用）：有意吞掉，调用方随后会重查文件系统并精确报告残留项，
        # 比第一个失败条目的原始 OSError 好得多。
        pass
