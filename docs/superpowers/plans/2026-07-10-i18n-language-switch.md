# 多语言切换功能 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 `modules/file_vault` 的 Electron+React 图形界面加上语言切换功能（联合国 6 种官方语言：中/英/法/西/俄/阿拉伯语，默认跟随系统语言），并把后端 Python 里约 60 处硬编码中文错误文案改造成错误码，由前端统一翻译展示。

**Architecture:** 后端新增 `VaultError` 异常基类（`code` + `**params`），9 个现有自定义异常类改为继承它而不是被取代，保留现有按类型捕获的逻辑；前端用 `react-i18next` 按屏幕拆分 8 个命名空间的翻译资源，语言优先级 `localStorage` → Electron 系统语言 → 英语兜底；一个 `translateError()` 辅助函数把后端错误码渲染成当前语言的文案。

**Tech Stack:** Python 3.9（后端）、React 18 + TypeScript + Vite + Electron（前端）、react-i18next + i18next（新增依赖）、pytest（后端测试）。

**规格文档：** `docs/superpowers/specs/2026-07-10-i18n-language-switch-design.md`（已过审，架构决策以此为准，本计划不重复论证，只落实到任务）。

---

## 文件结构总览

**新增（后端）：**
- `modules/file_vault/errors.py` — `VaultError` 基类

**修改（后端）：**
- `modules/file_vault/container.py`、`identity.py`、`fingerprint.py`、`passwords.py`、`task_store.py`、`task_engine.py`、`backend_server.py`
- `modules/file_vault/tests/test_backend_server.py`

**新增（前端）：**
- `ui/src/i18n/index.ts` — i18next 初始化 + 语言解析
- `ui/src/i18n/errors.ts` — `translateError()`
- `ui/src/i18n/locales/{zh,en,fr,es,ru,ar}/{common,login,setup,settings,files,passwords,tasks,errors}.json`（6 × 8 = 48 个文件）
- `ui/src/components/LanguageSwitcher.tsx`

**修改（前端）：**
- `ui/electron/main.ts`（新增 `system:getLocale` IPC；`shell:openInVSCode` 改错误码）
- `ui/electron/preload.ts`、`ui/src/shared/window.d.ts`（暴露 `getSystemLocale()`）
- `ui/src/shared/ipcTypes.ts`（新增 `error_params` 字段）
- `ui/src/main.tsx`、`ui/src/App.tsx`（挂载 i18n、`LanguageSwitcher`、`dir` 联动）
- 10 个组件文件：`AppShell.tsx`、`FilesPane.tsx`、`LoginScreen.tsx`、`PasswordScreen.tsx`、`SettingsScreen.tsx`、`SetupWizard.tsx`、`TaskDetailScreen.tsx`、`TaskListScreen.tsx`、`UnlockDialog.tsx`、`UnlockTabs.tsx`
- `ui/package.json`（新增 `react-i18next`/`i18next` 依赖）

---

## 术语表（翻译时统一使用，保证跨组件用词一致）

| 中文 | English | Français | Español | Русский | العربية |
|---|---|---|---|---|---|
| 解锁 | Unlock | Déverrouiller | Desbloquear | Разблокировать | فتح القفل |
| 密码 | Password | Mot de passe | Contraseña | Пароль | كلمة المرور |
| 验证器 | Authenticator | Authentificateur | Autenticador | Аутентификатор | تطبيق المصادقة |
| 验证码 | Code | Code | Código | Код | الرمز |
| 恢复密钥 | Recovery Key | Clé de récupération | Clave de recuperación | Ключ восстановления | مفتاح الاسترداد |
| 指纹 | Fingerprint | Empreinte digitale | Huella dactilar | Отпечаток пальца | بصمة الإصبع |
| 设置 | Settings | Paramètres | Configuración | Настройки | الإعدادات |
| 加密 | Encrypt | Chiffrer | Cifrar | Шифровать | تشفير |
| 解密 | Decrypt | Déchiffrer | Descifrar | Расшифровать | فك التشفير |
| 保存 | Save | Enregistrer | Guardar | Сохранить | حفظ |
| 取消 | Cancel | Annuler | Cancelar | Отмена | إلغاء |
| 删除 | Delete | Supprimer | Eliminar | Удалить | حذف |
| 密码管理 | Password Manager | Gestionnaire de mots de passe | Gestor de contraseñas | Менеджер паролей | مدير كلمات المرور |
| 自动任务 | Automated Tasks | Tâches automatisées | Tareas automatizadas | Автоматические задачи | المهام الآلية |
| 邮箱 | Email | E-mail | Correo | Эл. почта | البريد الإلكتروني |
| 恢复失败/解锁失败 | Unlock failed | Échec du déverrouillage | Error al desbloquear | Не удалось разблокировать | فشل فتح القفل |

翻译每个命名空间时优先套用这张表里的词，保持全应用用词统一（例如所有屏幕上的"解锁"按钮在同一语言下必须是同一个词，不要一个屏幕用 "Unlock" 另一个屏幕用 "Log in"）。

---

# Phase A — 后端错误码化

**关于测试的一个提醒：** Task 2 到 Task 7 期间，`python -X utf8 -m pytest modules/file_vault/tests/ -v` 跑全量测试**不会**全绿——每个任务只更新它自己涉及的那部分断言，其余还没轮到的文件里的中文断言会继续失败，这是预期状态，不是回归。每个任务自己的 Step（"跑相关测试确认全绿"）只要求这个任务涉及的那些用例通过。整个 Python 测试套件真正恢复全绿是在 **Task 8 完成之后**（`backend_server.py` 是最后一块拼图，很多断言的可见行为要等它落地才稳定）。不要因为中途某次跑全量测试看到几个失败就怀疑前面的任务做错了。

## Task 1: 新增 `errors.py` + 单元测试

**Files:**
- Create: `modules/file_vault/errors.py`
- Test: `modules/file_vault/tests/test_errors.py`

- [ ] **Step 1: 写失败测试**

```python
# modules/file_vault/tests/test_errors.py
from modules.file_vault.errors import VaultError


def test_vault_error_carries_code_and_params():
    exc = VaultError("auth.wrong_password")
    assert exc.code == "auth.wrong_password"
    assert exc.params == {}
    assert str(exc) == "auth.wrong_password"


def test_vault_error_carries_extra_params():
    exc = VaultError("task.merge_failed", detail="conflict in foo.py")
    assert exc.code == "task.merge_failed"
    assert exc.params == {"detail": "conflict in foo.py"}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `python -X utf8 -m pytest modules/file_vault/tests/test_errors.py -v`
Expected: FAIL，报 `ModuleNotFoundError: No module named 'modules.file_vault.errors'`

- [ ] **Step 3: 实现**

```python
# modules/file_vault/errors.py
"""Coded exceptions shared across the file_vault backend.

Every subclass carries a machine-readable `code` (dot-separated,
e.g. "auth.wrong_password") instead of user-facing prose - the
Electron frontend owns translating codes into the active UI language
via ui/src/i18n/errors.ts. `params` holds any values the frontend
message template needs to interpolate (e.g. a filename or a raw
stderr string that isn't itself translated).
"""


class VaultError(Exception):
    def __init__(self, code: str, **params):
        self.code = code
        self.params = params
        super().__init__(code)
```

- [ ] **Step 4: 跑测试确认通过**

Run: `python -X utf8 -m pytest modules/file_vault/tests/test_errors.py -v`
Expected: PASS（2 passed）

- [ ] **Step 5: 提交**

```bash
git add modules/file_vault/errors.py modules/file_vault/tests/test_errors.py
git commit -m "feat(file_vault): add VaultError base class for coded backend errors"
```

---

## Task 2: `container.py` — 3 个异常类 + 19 处 raise 改错误码

**Files:**
- Modify: `modules/file_vault/container.py:1` (imports), `:59`, `:63`, `:68`（异常类定义），以及下表列出的 19 处 raise
- Test: `modules/file_vault/tests/test_container.py`（现有测试文件，检查是否有断言中文文案，若有一并改成断言 `.code`）
- Test: `modules/file_vault/tests/test_backend_server.py:401`

- [ ] **Step 1: 在 `container.py` 顶部导入 `VaultError`，3 个异常类改为继承它**

```python
# container.py 顶部 import 区加一行
from modules.file_vault.errors import VaultError
```

```python
# line 59-70（原）
class InvalidContainerError(Exception):
    """..."""


class ContainerIntegrityError(Exception):
    """..."""


class SamePathError(Exception):
    """..."""

# 改为
class InvalidContainerError(VaultError):
    """..."""


class ContainerIntegrityError(VaultError):
    """..."""


class SamePathError(VaultError):
    """..."""
```
（保留原有 docstring 内容不变，只改基类。）

- [ ] **Step 2: 逐处把 raise 的中文文案换成错误码**

| 行号 | 原代码 | 改为 |
|---|---|---|
| 85 | `raise SamePathError("输出文件不能和源文件是同一个文件，请另选一个保存位置")` | `raise SamePathError("container.same_path")` |
| 139 | `raise InvalidContainerError(f"不支持的加密算法: {cipher!r}")` | `raise InvalidContainerError("container.unsupported_cipher", cipher=cipher)` |
| 187 | `raise InvalidContainerError("文件过大，超出单文件分块数量上限")` | `raise InvalidContainerError("container.file_too_large")` |
| 206 | `raise InvalidContainerError("所选文件不是有效的加密文件")` | `raise InvalidContainerError("container.invalid_file")` |
| 211 | `raise InvalidContainerError("所选文件不是有效的加密文件（头部不完整）")` | `raise InvalidContainerError("container.header_incomplete")` |
| 215 | `raise InvalidContainerError("所选文件不是有效的加密文件") from exc` | `raise InvalidContainerError("container.invalid_file") from exc` |
| 217-220 | `raise InvalidContainerError(f"不支持的容器格式版本: {header.get('format_version') if isinstance(header, dict) else header!r}")` | `raise InvalidContainerError("container.unsupported_format_version", version=header.get("format_version") if isinstance(header, dict) else repr(header))` |
| 229 | `raise InvalidContainerError(f"不支持的加密算法: {cipher!r}")` | `raise InvalidContainerError("container.unsupported_cipher", cipher=cipher)` |
| 238 | `raise InvalidContainerError("加密文件头部格式不正确") from exc` | `raise InvalidContainerError("container.invalid_header") from exc` |
| 242 | `raise InvalidContainerError("无法用当前密钥解开此文件（密钥不匹配）")` | `raise InvalidContainerError("container.key_mismatch")` |
| 251 | `raise InvalidContainerError("加密文件头部格式不正确") from exc` | `raise InvalidContainerError("container.invalid_header") from exc` |
| 260 | `raise ContainerIntegrityError("加密文件的元数据已损坏或被篡改") from exc` | `raise ContainerIntegrityError("container.metadata_corrupted") from exc` |
| 262 | `raise ContainerIntegrityError("加密文件的元数据已损坏或被篡改")` | `raise ContainerIntegrityError("container.metadata_corrupted")` |
| 278 | `raise InvalidContainerError("加密文件头部格式不正确") from exc` | `raise InvalidContainerError("container.invalid_header") from exc` |
| 324 | `raise InvalidContainerError("加密文件头部格式不正确") from exc` | `raise InvalidContainerError("container.invalid_header") from exc` |
| 336 | `raise ContainerIntegrityError("文件已损坏或被篡改，解密中止")` | `raise ContainerIntegrityError("container.corrupted")` |
| 340 | `raise ContainerIntegrityError("文件已损坏或被篡改，解密中止")` | `raise ContainerIntegrityError("container.corrupted")` |
| 346 | `raise ContainerIntegrityError("文件已损坏或被篡改，解密中止")` | `raise ContainerIntegrityError("container.corrupted")` |
| 355 | `raise ContainerIntegrityError("解密后内容与原始校验值不一致，文件可能已损坏")` | `raise ContainerIntegrityError("container.checksum_mismatch")` |

行号可能因前面的编辑略有偏移，逐处替换时以文本内容匹配为准，不要死认行号。

- [ ] **Step 3: 检查 `tests/test_container.py` 有没有断言这些中文文案的用例**

Run: `grep -n "文件\|错误\|不支持\|损坏\|不正确" modules/file_vault/tests/test_container.py`

如果有断言 `str(exc) == "<中文>"` 或 `pytest.raises(..., match="<中文>")` 的用例，把断言改成检查 `exc.code == "<对应错误码>"`（参照上表）。如果这个文件里的用例只是 `pytest.raises(InvalidContainerError)` 这种只检查异常类型不检查文案的，不用改。

- [ ] **Step 4: 更新 `test_backend_server.py:401`**

先跑一次现有测试确认这处触发的具体是哪个错误码（`invalid_file` 还是 `header_incomplete`，取决于测试用的假文件字节数）：

Run: `python -X utf8 -m pytest modules/file_vault/tests/test_backend_server.py::test_decrypt_of_non_container_file_reports_friendly_error -v`

把原来的
```python
assert "有效的加密文件" in result["error"]
```
改成（先用上面命令确认实际吐出的 code 是什么，再填进断言，不要凭猜测直接写死）：
```python
assert result["error"] == "container.header_incomplete"  # 如果实测结果不同，改成实测的那个 code
```

- [ ] **Step 5: 跑相关测试确认全绿**

Run: `python -X utf8 -m pytest modules/file_vault/tests/test_container.py modules/file_vault/tests/test_backend_server.py -v`
Expected: 除了还没改的部分（其他文件的中文文案断言），container 相关用例应该全部 PASS。此时 `test_backend_server.py` 里其他还没处理的中文断言（本任务不管的那些）预期仍然是失败的——这是正常的，会在后续任务里逐个修好，不要在这一步强求整个文件全绿。

- [ ] **Step 6: 提交**

```bash
git add modules/file_vault/container.py modules/file_vault/tests/test_container.py modules/file_vault/tests/test_backend_server.py
git commit -m "refactor(file_vault): convert container.py errors to VaultError codes"
```

---

## Task 3: `identity.py` — 2 个异常类 + 11 处 raise 改错误码

**Files:**
- Modify: `modules/file_vault/identity.py`
- Test: `modules/file_vault/tests/test_identity.py`
- Test: `modules/file_vault/tests/test_backend_server.py:120`

- [ ] **Step 1: 导入 `VaultError`，2 个异常类改继承**

```python
from modules.file_vault.errors import VaultError
```

```python
# line 54, 58（原）
class UnlockError(Exception):
    ...


class IdentityNotSetUpError(Exception):
    ...

# 改为
class UnlockError(VaultError):
    ...


class IdentityNotSetUpError(VaultError):
    ...
```

- [ ] **Step 2: 逐处替换**

| 行号 | 原代码 | 改为 |
|---|---|---|
| 124 | `raise IdentityNotSetUpError(f"No identity store at {path}")` | `raise IdentityNotSetUpError("identity.not_set_up", path=str(path))` |
| 232 | `raise UnlockError("密码错误")` | `raise UnlockError("auth.wrong_password")` |
| 241 | `raise UnlockError("恢复密钥不正确")` | `raise UnlockError("auth.wrong_recovery_key")` |
| 247 | `raise UnlockError("验证器尚未设置")` | `raise UnlockError("auth.totp_not_set_up")` |
| 249 | `raise UnlockError("验证码错误或已过期，请查看验证器 App 最新的 6 位数字")` | `raise UnlockError("auth.totp_invalid_or_expired")` |
| 255 | `raise UnlockError("验证器解锁失败，本机存储的验证器信息可能已损坏")` | `raise UnlockError("auth.totp_unlock_failed")` |
| 295 | `raise UnlockError("尚未设置恢复邮箱")` | `raise UnlockError("auth.recovery_email_not_set")` |
| 301 | `raise UnlockError("验证码错误、已过期或已使用，请点击重新发送")` | `raise UnlockError("auth.email_code_invalid_or_expired")` |
| 304 | `raise UnlockError("邮箱解锁尚未设置")` | `raise UnlockError("auth.email_unlock_not_set_up")` |
| 311 | `raise UnlockError("邮箱解锁失败，本机存储的邮箱信息可能已损坏")` | `raise UnlockError("auth.email_unlock_failed")` |
| 353 | `raise UnlockError("指纹验证未通过，重新绑定已取消")` | `raise UnlockError("auth.fingerprint_verification_cancelled")` |

- [ ] **Step 3: 检查并更新 `test_identity.py` 里对应的断言**（同 Task 2 Step 3 的方式：只改断言中文文案/子串匹配的用例，改成断言 `.code`）

Run: `grep -n "密码错误\|恢复密钥\|验证器\|验证码\|邮箱\|指纹验证未通过" modules/file_vault/tests/test_identity.py`

逐处按上表核对改掉。

- [ ] **Step 4: 更新 `test_backend_server.py:120`**

```python
# 原
assert result == {"ok": False, "error": "密码错误"}
# 改为
assert result["ok"] is False
assert result["error"] == "auth.wrong_password"
```
（用两行分开断言而不是整体字典相等，是因为 Task 8 之后这个返回值会多出 `error_params` 键，分开断言不受影响，避免以后又要回来改一次。）

- [ ] **Step 5: 跑测试**

Run: `python -X utf8 -m pytest modules/file_vault/tests/test_identity.py modules/file_vault/tests/test_backend_server.py -v`
Expected: identity 相关和 `test_full_setup_and_password_unlock` 应 PASS；其余还未处理的用例继续保持失败，正常。

- [ ] **Step 6: 提交**

```bash
git add modules/file_vault/identity.py modules/file_vault/tests/test_identity.py modules/file_vault/tests/test_backend_server.py
git commit -m "refactor(file_vault): convert identity.py errors to VaultError codes"
```

---

## Task 4: `fingerprint.py` — 1 个异常类（改单继承）+ 3 处 raise 改错误码

**Files:**
- Modify: `modules/file_vault/fingerprint.py`
- Test: `modules/file_vault/tests/test_fingerprint.py`（如果存在；先 `ls modules/file_vault/tests/` 确认文件名）

- [ ] **Step 1: 导入 `VaultError`，异常类改单继承（去掉 `RuntimeError`）**

```python
from modules.file_vault.errors import VaultError
```

```python
# line 23（原）
class FingerprintUnavailableError(RuntimeError):
    ...

# 改为
class FingerprintUnavailableError(VaultError):
    ...
```
已核实代码库里没有任何地方按 `except RuntimeError` 专门捕获这个异常，改成单继承 `VaultError` 是安全的。

- [ ] **Step 2: 逐处替换**

```python
# line 71
raise FingerprintUnavailableError("Windows Hello 组件未安装") from exc
→ raise FingerprintUnavailableError("fingerprint.component_not_installed") from exc
```

```python
# line 80
raise FingerprintUnavailableError("指纹验证过程出错") from exc
→ raise FingerprintUnavailableError("fingerprint.verification_error") from exc
```

```python
# lines 87-94（原，dict 查表后统一 raise 一次，不是 6 个独立 raise 语句）
messages = {
    UserConsentVerificationResult.DEVICE_NOT_PRESENT: "这台电脑没有指纹传感器",
    UserConsentVerificationResult.NOT_CONFIGURED_FOR_USER: "这台电脑未配置 Windows Hello 指纹",
    UserConsentVerificationResult.DISABLED_BY_POLICY: "Windows Hello 指纹已被系统策略禁用",
    UserConsentVerificationResult.DEVICE_BUSY: "指纹传感器正忙，请稍后重试",
    UserConsentVerificationResult.RETRIES_EXHAUSTED: "指纹验证失败次数过多，请稍后重试",
}
raise FingerprintUnavailableError(messages.get(result, "指纹验证失败"))

# 改为
codes = {
    UserConsentVerificationResult.DEVICE_NOT_PRESENT: "fingerprint.device_not_present",
    UserConsentVerificationResult.NOT_CONFIGURED_FOR_USER: "fingerprint.not_configured",
    UserConsentVerificationResult.DISABLED_BY_POLICY: "fingerprint.disabled_by_policy",
    UserConsentVerificationResult.DEVICE_BUSY: "fingerprint.device_busy",
    UserConsentVerificationResult.RETRIES_EXHAUSTED: "fingerprint.retries_exhausted",
}
raise FingerprintUnavailableError(codes.get(result, "fingerprint.verification_failed"))
```

- [ ] **Step 3: 检查测试文件里是否有断言这些中文文案的用例，同 Task 2 Step 3 方式处理**

Run: `ls modules/file_vault/tests/ | grep -i finger`（确认测试文件是否存在及文件名，可能不存在独立的 `test_fingerprint.py`，指纹相关用例可能混在 `test_backend_server.py` 或 `test_identity.py` 里——本任务只需处理已确认存在的用例，不用凭空新建）

- [ ] **Step 4: 跑测试**

Run: `python -X utf8 -m pytest modules/file_vault/tests/ -k fingerprint -v`
Expected: 相关用例 PASS（真实 Windows Hello 弹窗依赖的用例本来就 mock 掉了 `request_verification()`，这次改动不影响这部分测试策略）

- [ ] **Step 5: 提交**

```bash
git add modules/file_vault/fingerprint.py modules/file_vault/tests/
git commit -m "refactor(file_vault): convert fingerprint.py errors to VaultError codes"
```

---

## Task 5: `passwords.py` — 1 个异常类 + 7 处 raise 改错误码

**Files:**
- Modify: `modules/file_vault/passwords.py`
- Test: `modules/file_vault/tests/test_backend_server.py:541`
- Test: 检查是否存在 `test_passwords.py`

- [ ] **Step 1: 导入 `VaultError`，异常类改继承**

```python
from modules.file_vault.errors import VaultError
```

```python
# line 26（原）
class PasswordVaultError(Exception):
    ...
# 改为
class PasswordVaultError(VaultError):
    ...
```

- [ ] **Step 2: 逐处替换**

| 行号 | 原代码 | 改为 |
|---|---|---|
| 83 | `raise PasswordVaultError("密码库文件格式不正确") from exc` | `raise PasswordVaultError("password.invalid_format") from exc` |
| 86 | `raise PasswordVaultError(f"不支持的密码库格式版本: {blob.get('format_version')!r}")` | `raise PasswordVaultError("password.unsupported_format_version", version=repr(blob.get("format_version")))` |
| 94 | `raise PasswordVaultError("密码库文件格式不正确") from exc` | `raise PasswordVaultError("password.invalid_format") from exc` |
| 100 | `raise PasswordVaultError("无法用当前密钥解开密码库（密钥不匹配或文件已损坏）") from exc` | `raise PasswordVaultError("password.key_mismatch") from exc` |
| 106 | `raise PasswordVaultError("密码库内容已损坏") from exc` | `raise PasswordVaultError("password.content_corrupted") from exc` |
| 168 | `raise PasswordVaultError("CSV 文件是空的或格式不正确")` | `raise PasswordVaultError("password.csv_empty_or_invalid")` |
| 177 | `raise PasswordVaultError("CSV 缺少必需的 url/username/password 列，无法识别这个文件的格式")` | `raise PasswordVaultError("password.csv_missing_columns")` |

- [ ] **Step 3: 更新 `test_backend_server.py:541`**

```python
# 原
assert "url/username/password" in result["error"]
# 改为
assert result["error"] == "password.csv_missing_columns"
```

- [ ] **Step 4: 检查是否存在独立的 `test_passwords.py`，有的话按 Task 2 Step 3 方式处理其中的中文断言**

Run: `ls modules/file_vault/tests/ | grep -i password`

- [ ] **Step 5: 跑测试**

Run: `python -X utf8 -m pytest modules/file_vault/tests/test_backend_server.py::test_password_import_csv_bad_format_reports_error -v`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add modules/file_vault/passwords.py modules/file_vault/tests/
git commit -m "refactor(file_vault): convert passwords.py errors to VaultError codes"
```

---

## Task 6: `task_store.py` — 1 个异常类 + 6 处 raise 改错误码

**Files:**
- Modify: `modules/file_vault/task_store.py`
- Test: `modules/file_vault/tests/test_task_store.py`

- [ ] **Step 1: 导入 `VaultError`，异常类改继承**

```python
from modules.file_vault.errors import VaultError
```

```python
# line 24（原）
class TaskStoreError(Exception):
    ...
# 改为
class TaskStoreError(VaultError):
    ...
```

- [ ] **Step 2: 逐处替换**

| 行号 | 原代码 | 改为 |
|---|---|---|
| 57 | `raise TaskStoreError(f"找不到任务数据：{path}")` | `raise TaskStoreError("task.data_not_found", path=str(path))` |
| 62 | `raise TaskStoreError("任务数据文件格式不正确") from exc` | `raise TaskStoreError("task.invalid_format") from exc` |
| 65 | `raise TaskStoreError(f"不支持的任务数据格式版本: {blob.get('format_version')!r}")` | `raise TaskStoreError("task.unsupported_format_version", version=repr(blob.get("format_version")))` |
| 73 | `raise TaskStoreError("任务数据文件格式不正确") from exc` | `raise TaskStoreError("task.invalid_format") from exc` |
| 79 | `raise TaskStoreError("无法用当前密钥解开任务数据（密钥不匹配或文件已损坏）") from exc` | `raise TaskStoreError("task.key_mismatch") from exc` |
| 94 | `raise TaskStoreError("任务元数据内容已损坏") from exc` | `raise TaskStoreError("task.metadata_corrupted") from exc` |

- [ ] **Step 3: 检查并更新 `test_task_store.py` 里对应的中文断言**（Task 2 Step 3 方式）

Run: `grep -n "找不到\|格式不正确\|密钥不匹配\|已损坏" modules/file_vault/tests/test_task_store.py`

- [ ] **Step 4: 跑测试**

Run: `python -X utf8 -m pytest modules/file_vault/tests/test_task_store.py -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add modules/file_vault/task_store.py modules/file_vault/tests/test_task_store.py
git commit -m "refactor(file_vault): convert task_store.py errors to VaultError codes"
```

---

## Task 7: `task_engine.py` — 1 个异常类 + 3 处 raise 改错误码

**Files:**
- Modify: `modules/file_vault/task_engine.py`
- Test: `modules/file_vault/tests/test_task_engine.py`

- [ ] **Step 1: 导入 `VaultError`，异常类改继承**

```python
from modules.file_vault.errors import VaultError
```

```python
# line 318（原）
class TaskEngineError(Exception):
    ...
# 改为
class TaskEngineError(VaultError):
    ...
```

- [ ] **Step 2: 逐处替换**

| 行号 | 原代码 | 改为 |
|---|---|---|
| 361 | `raise TaskEngineError(f"初始化 git 仓库失败: {result.stderr.strip()}")` | `raise TaskEngineError("task.git_init_failed", detail=result.stderr.strip())` |
| 378 | `raise TaskEngineError(f"创建初始提交失败: {commit.stderr.strip()}")` | `raise TaskEngineError("task.initial_commit_failed", detail=commit.stderr.strip())` |
| 392 | `raise TaskEngineError(f"创建隔离工作区失败: {result.stderr.strip()}")` | `raise TaskEngineError("task.worktree_create_failed", detail=result.stderr.strip())` |

`stderr`/`detail` 内容本身不翻译（规格文档已定的已知限制），原样作为 param 传递。

- [ ] **Step 3: 检查并更新 `test_task_engine.py` 里对应的中文断言**（Task 2 Step 3 方式）

Run: `grep -n "初始化 git\|创建初始提交\|创建隔离工作区" modules/file_vault/tests/test_task_engine.py`

- [ ] **Step 4: 跑测试**

Run: `python -X utf8 -m pytest modules/file_vault/tests/test_task_engine.py -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add modules/file_vault/task_engine.py modules/file_vault/tests/test_task_engine.py
git commit -m "refactor(file_vault): convert task_engine.py errors to VaultError codes"
```

---

## Task 8: `backend_server.py` — `_error_result` helper + 全部错误分支改造

这是后端部分工作量最大的一个任务，涉及本文件里 2 处 raise、9 处字面量错误分支、3 处带变量的 f-string 分支、15 处按具体类型捕获、6 处 `except Exception` 捕获。按下面顺序做，每完成一小块就跑一次相关测试，不要攒到最后一次性改完再测。

**Files:**
- Modify: `modules/file_vault/backend_server.py`
- Test: `modules/file_vault/tests/test_backend_server.py`

- [ ] **Step 1: 导入 `errors` 模块，新增 `_error_result` helper**

```python
# line 31 附近，现有 import 块
from modules.file_vault import container, crypto, email_otp, fingerprint, identity, passwords, remnants  # noqa: E402
from modules.file_vault import task_engine, task_store  # noqa: E402
from modules.file_vault import totp as totp_mod  # noqa: E402
from modules.file_vault import errors  # noqa: E402
```

```python
# 新增函数，放在文件里其他小工具函数附近（比如 _qr_to_base64 旁边）
def _error_result(exc: Exception) -> dict:
    if isinstance(exc, errors.VaultError):
        return {"ok": False, "error": exc.code, "error_params": exc.params}
    return {"ok": False, "error": "internal.unexpected", "error_params": {"detail": str(exc)}}
```

- [ ] **Step 2: 改 `_require_imk()`（line 65）和 `rpc_secure_delete_paths` 里的 `IsADirectoryError`（line 230）**

```python
# line 65（原）
raise RuntimeError("尚未解锁")
# 改为
raise errors.VaultError("auth.not_unlocked")
```

```python
# line 230（原，rpc_secure_delete_paths 循环体内）
raise IsADirectoryError("不支持直接删除文件夹")
# 改为
raise errors.VaultError("container.path_is_directory")
```

- [ ] **Step 3: 改 9 处字面量 `{"ok": False, "error": "<中文>"}` 分支**

| 行号 | 原代码 | 改为 |
|---|---|---|
| 160 | `return {"ok": False, "error": "尚未配置发信邮箱，请先在设置里完成邮箱配置"}` | `return {"ok": False, "error": "smtp.not_configured"}` |
| 174 | `return {"ok": False, "error": "请先点击发送验证码"}` | `return {"ok": False, "error": "auth.email_code_not_sent"}` |
| 186 | `return {"ok": False, "error": "此身份未绑定指纹解锁"}` | `return {"ok": False, "error": "auth.fingerprint_not_bound"}` |
| 193 | `return {"ok": False, "error": "该指纹绑定已失效（可能是旧版本升级后未重新绑定），请到设置里点"重新绑定指纹解锁""}`（注意原文用的是中文弯引号 "…"，不是直引号，逐字匹配替换时要复制实际文件内容，不要照抄本表格里可能被渲染成直引号的版本） | `return {"ok": False, "error": "auth.fingerprint_binding_stale"}` |
| 199 | `return {"ok": False, "error": "指纹验证未通过"}` | `return {"ok": False, "error": "auth.fingerprint_verification_failed"}` |
| 255 | `return {"ok": False, "error": "验证码不正确"}` | `return {"ok": False, "error": "auth.totp_code_invalid"}` |
| 357 | `return {"ok": False, "error": "找不到这条密码记录"}` | `return {"ok": False, "error": "password.entry_not_found"}` |
| 366 | `return {"ok": False, "error": "找不到这条密码记录"}` | `return {"ok": False, "error": "password.entry_not_found"}` |
| 584 | `return {"ok": False, "error": "直接原目录模式没有需要合并的独立分支，改动已经在你的工作区里"}` | `return {"ok": False, "error": "task.no_worktree_to_merge"}` |

- [ ] **Step 4: 改 3 处带变量的 f-string 分支**

```python
# line 511（rpc_task_create 的 OSError 分支）和 line 549（rpc_task_continue 的 OSError 分支，同样写法）
# 原
except OSError as exc:
    return {"ok": False, "error": f"无法打开终端窗口: {exc}"}
# 改为
except OSError as exc:
    return {"ok": False, "error": "task.terminal_launch_failed", "error_params": {"detail": str(exc)}}
```

```python
# line 596（rpc_task_merge）
# 原
if result.returncode != 0:
    return {"ok": False, "error": f"合并失败: {result.stderr.strip()}"}
# 改为
if result.returncode != 0:
    return {"ok": False, "error": "task.merge_failed", "error_params": {"detail": result.stderr.strip()}}
```

- [ ] **Step 5: 改 14 处按具体类型捕获的 `return {"ok": False, "error": str(exc)}`，统一改成 `return _error_result(exc)`**

以下每一处都是同样的模式：`except <SpecificType> as exc: return {"ok": False, "error": str(exc)}` → `except <SpecificType> as exc: return _error_result(exc)`。逐个文件搜索确认后替换（捕获类型本身不变）：

- line 105（`rpc_setup_verify_fingerprint`）：`except fingerprint.FingerprintUnavailableError as exc:`
- line 131（`rpc_unlock_password`）：`except identity.UnlockError as exc:`
- line 141（`rpc_unlock_totp`）：`except identity.UnlockError as exc:`
- line 151（`rpc_unlock_recovery`）：`except identity.UnlockError as exc:`
- line 164（`rpc_unlock_email_start`，第一个 except）：`except identity.UnlockError as exc:`
- line 178（`rpc_unlock_email_finish`）：`except identity.UnlockError as exc:`
- line 196（`rpc_unlock_fingerprint`）：`except fingerprint.FingerprintUnavailableError as exc:`
- line 212（`rpc_read_header`）：`except (container.InvalidContainerError, container.ContainerIntegrityError) as exc:`
- line 279（`rpc_rebind_fingerprint`）：`except (fingerprint.FingerprintUnavailableError, identity.UnlockError) as exc:`
- line 378（`rpc_password_import_csv`）：`except passwords.PasswordVaultError as exc:`
- line 462（`rpc_task_create`，`ensure_git_repo` 调用处）：`except task_engine.TaskEngineError as exc:`
- line 489（`rpc_task_create`，`create_worktree` 调用处）：`except task_engine.TaskEngineError as exc:`
- line 630（`rpc_encrypt_file`）：`except (container.InvalidContainerError, container.ContainerIntegrityError, container.SamePathError) as exc:`
- line 657（`rpc_decrypt_file`）：`except (container.InvalidContainerError, container.ContainerIntegrityError, container.SamePathError) as exc:`

（`_require_password_entries` 里 line 316-317 的 `except passwords.PasswordVaultError as exc: raise RuntimeError(str(exc))` **不改**——这是规格文档里明确记录的已知限制，见本任务 Step 8 的说明，不要顺手"修好"它。）

- [ ] **Step 6: 改 6 处 `except Exception as exc:`，按三种情况分别处理**

**情况一（1 处，可直接套用）：** line 307，`rpc_send_test_email`
```python
# 原
except Exception as exc:
    return {"ok": False, "error": str(exc)}
# 改为
except Exception as exc:
    return _error_result(exc)
```

**情况二（1 处，需要独立错误码）：** line 166-167，`rpc_unlock_email_start`
```python
# 原
except Exception as exc:
    return {"ok": False, "error": f"发送失败：{exc}"}
# 改为
except Exception as exc:
    return {"ok": False, "error": "email.send_failed", "error_params": {"detail": str(exc)}}
```

**情况三（4 处，best-effort 清理失败，字段名不是顶层 `error`）：**

```python
# line 233-234，rpc_secure_delete_paths 循环体
# 原
except Exception as exc:
    results.append({"path": p, "ok": False, "error": str(exc)})
# 改为
except Exception as exc:
    results.append({"path": p, **_error_result(exc)})
```

```python
# line 390-392（rpc_password_import_csv）、line 641-643（rpc_encrypt_file）、line 668-670（rpc_decrypt_file），三处写法完全一样
# 原
except Exception as exc:
    result["source_deleted"] = False
    result["delete_error"] = str(exc)
# 改为
except Exception as exc:
    result["source_deleted"] = False
    err = _error_result(exc)
    result["delete_error"] = err["error"]
    result["delete_error_params"] = err["error_params"]
```

- [ ] **Step 7: `dispatch()`（line 720-733）保持不动**

不要修改这个函数。它是 23 个没有本地异常处理的 `rpc_*` 方法的兜底，规格文档已经明确决定这次不改造（详见规格文档"明确决定"一节）——`VaultError` 走到这里时 `str(exc)` 会自然返回 `code` 本身（因为 `super().__init__(code)`），所以这条路径今天是"控制台打印中文原文、界面无提示"，什么都不做也会自动变成"控制台打印错误码、界面依然无提示"，不需要额外代码改动。

- [ ] **Step 8: 更新 `test_backend_server.py` 里剩余的中文断言**

| 行号 | 原代码 | 改为 |
|---|---|---|
| 147 | `assert result == {"ok": False, "error": "此身份未绑定指纹解锁"}` | `assert result["ok"] is False`<br>`assert result["error"] == "auth.fingerprint_not_bound"` |
| 162 | `assert error == "尚未解锁"` | `assert error == "auth.not_unlocked"` |
| 249 | `assert error == "尚未解锁"` | `assert error == "auth.not_unlocked"` |
| 253 | `assert error == "尚未解锁"` | `assert error == "auth.not_unlocked"` |
| 269 | `assert error == "尚未解锁"` | `assert error == "auth.not_unlocked"` |
| 465 | `assert result == {"ok": False, "error": "找不到这条密码记录"}` | `assert result["ok"] is False`<br>`assert result["error"] == "password.entry_not_found"` |
| 496 | `assert error == "尚未解锁"` | `assert error == "auth.not_unlocked"` |

（line 275 的 `assert "Unknown method" in error` 不用改，这是 `dispatch()` 对未知方法名的英文报错，跟本次改造无关。）

- [ ] **Step 9: 跑完整测试套件**

Run: `python -X utf8 -m pytest modules/file_vault/tests/test_backend_server.py -v`
Expected: 全部 PASS。如果还有失败，逐个核对是不是漏改了某处中文断言或某个 `except` 分支。

Run: `python -X utf8 -m pytest modules/file_vault/tests/ -v`
Expected: 全部 PASS（Phase A 到此为止应该让整个 Python 测试套件保持全绿）。

- [ ] **Step 10: 提交**

```bash
git add modules/file_vault/backend_server.py modules/file_vault/tests/test_backend_server.py
git commit -m "refactor(file_vault): route all backend_server.py errors through coded VaultError"
```

---

## Task 9: `electron/main.ts` — `shell:openInVSCode` 改错误码

**Files:**
- Modify: `modules/file_vault/ui/electron/main.ts:116-130`

- [ ] **Step 1: 把硬编码中文错误文案改成错误码**

```typescript
// 原（line ~122）
ipcMain.handle('shell:openInVSCode', (_event, targetPath: string) => {
  return new Promise<{ ok: boolean; error?: string }>((resolve) => {
    exec(`code "${targetPath}"`, (error) => {
      if (error) {
        resolve({
          ok: false,
          error:
            '找不到 VS Code 命令行工具 "code"。请打开 VS Code，按 Ctrl+Shift+P 搜索 "Shell Command: Install \'code\' command in PATH" 并执行，然后重试。',
        })
      } else {
        resolve({ ok: true })
      }
    })
  })
})

// 改为
ipcMain.handle('shell:openInVSCode', (_event, targetPath: string) => {
  return new Promise<{ ok: boolean; error?: string }>((resolve) => {
    exec(`code "${targetPath}"`, (error) => {
      if (error) {
        resolve({ ok: false, error: 'shell.vscode_not_found' })
      } else {
        resolve({ ok: true })
      }
    })
  })
})
```

这个错误码会在 Task 14 建的 `errors.json` 命名空间里翻译，`TaskListScreen.tsx` 消费它的地方在 Task 22 里处理。这一步只改 `main.ts`，先跑通编译，不涉及前端 UI 改动。

- [ ] **Step 2: 确认没有 TypeScript 编译错误**

Run: `cd modules/file_vault/ui && npx tsc --noEmit -p tsconfig.json`（如果项目用的是别的 tsconfig 路径，先 `ls modules/file_vault/ui/*.json` 确认文件名）
Expected: 无新增错误（这处改动只是字符串内容变化，类型不变）

- [ ] **Step 3: 提交**

```bash
git add modules/file_vault/ui/electron/main.ts
git commit -m "refactor(file_vault-ui): route shell:openInVSCode error through error code"
```

---

# Phase B — 前端 i18n 基础设施

## Task 10: 安装依赖

**Files:**
- Modify: `modules/file_vault/ui/package.json`

- [ ] **Step 1: 安装 react-i18next + i18next**

Run: `cd modules/file_vault/ui && npm install react-i18next i18next`
Expected: `package.json` 的 `dependencies` 里新增 `i18next` 和 `react-i18next` 两行，`package-lock.json` 更新（如果这个项目用 lock 文件——先确认，之前 `ls` 过 `ui/` 目录没看到 `package-lock.json`，如果确实没有就不用管，npm 用的是默认解析）。

- [ ] **Step 2: 确认能正常 import**

Run: `cd modules/file_vault/ui && node -e "require('i18next'); require('react-i18next'); console.log('ok')"`
Expected: 输出 `ok`

- [ ] **Step 3: 提交**

```bash
cd modules/file_vault/ui
git add package.json package-lock.json 2>/dev/null; git add package.json
git commit -m "chore(file_vault-ui): add react-i18next dependency"
```

---

## Task 11: Electron IPC — 系统语言检测

**Files:**
- Modify: `modules/file_vault/ui/electron/main.ts`
- Modify: `modules/file_vault/ui/electron/preload.ts`
- Modify: `modules/file_vault/ui/src/shared/window.d.ts`

- [ ] **Step 1: `main.ts` 新增 IPC handler**

在 `createWindow()` 函数里现有的 `ipcMain.handle('dialog:openFile', ...)` 等 handler 附近新增：

```typescript
ipcMain.handle('system:getLocale', () => app.getLocale())
```

- [ ] **Step 2: `preload.ts` 暴露给渲染进程**

`preload.ts` 里已经有两个分开暴露的对象：`vaultAPI`（line 7，严格对应 Python RPC 的 `VaultMethods` 类型，`call()`/`onProgress()` 两个方法）和 `electronAPI`（line 20，原生 Electron 能力，`openFiles`/`openDirectory`/`saveFile`/`showItemInFolder`/`openInVSCode`）。系统语言检测是纯 Electron 主进程能力，跟 Python 后端无关，**加进 `electronAPI` 那个对象，不要加进 `vaultAPI`**（加进 `vaultAPI` 会破坏它「只装 Python RPC 方法」的类型约定）：

```typescript
// electronAPI 对象内新增一个方法
contextBridge.exposeInMainWorld('electronAPI', {
  // ...现有的 openFiles/openDirectory/saveFile/showItemInFolder/openInVSCode 不变...
  getSystemLocale: (): Promise<string> => ipcRenderer.invoke('system:getLocale'),
})
```

- [ ] **Step 3: `window.d.ts` 补类型**

在 `electronAPI` 对应的接口定义里新增（不是 `vaultAPI` 那个接口）：

```typescript
getSystemLocale: () => Promise<string>
```

- [ ] **Step 4: 手动验证**

Run: `cd modules/file_vault/ui && npx tsc --noEmit`
Expected: 无编译错误

- [ ] **Step 5: 提交**

```bash
git add modules/file_vault/ui/electron/main.ts modules/file_vault/ui/electron/preload.ts modules/file_vault/ui/src/shared/window.d.ts
git commit -m "feat(file_vault-ui): expose Electron system locale via IPC"
```

---

## Task 12: `ipcTypes.ts` — 新增 `error_params`

**Files:**
- Modify: `modules/file_vault/ui/src/shared/ipcTypes.ts`

- [ ] **Step 1: 给所有 `{ ok: false; error: string }` 的返回类型加上可选的 `error_params`**

在文件里搜索每一处 `error: string`（`VaultMethods` 接口内，约 20 处方法定义），统一加一行。例如：

```typescript
// 原
unlock_password: { params: { password: string }; result: { ok: true } | { ok: false; error: string } }
// 改为
unlock_password: {
  params: { password: string }
  result: { ok: true } | { ok: false; error: string; error_params?: Record<string, string | number> }
}
```

对下列方法的 `result` 类型逐一应用同样的改动（凡是含 `{ ok: false; error: string }` 的都要加）：`setup_verify_fingerprint`、`unlock_password`、`unlock_totp`、`unlock_recovery`、`unlock_email_start`、`unlock_email_finish`、`unlock_fingerprint`、`read_header`、`scan_remnants`、`secure_delete_paths`（注意这个的 `results` 数组里每一项也要加）、`encrypt_file`、`decrypt_file`、`password_add`、`password_update`、`password_delete`、`password_import_csv`、`password_export_csv`、`rebind_totp_confirm`、`rebind_fingerprint`、`send_test_email`、`task_create`、`task_continue`、`task_merge`、`task_discard`。

`secure_delete_paths` 的 `results` 数组项额外加 `error_params`：
```typescript
secure_delete_paths: {
  params: { paths: string[] }
  result:
    | {
        ok: true
        results: { path: string; ok: boolean; error?: string; error_params?: Record<string, string | number> }[]
      }
    | { ok: false; error: string; error_params?: Record<string, string | number> }
}
```

`encrypt_file`/`decrypt_file`/`password_import_csv` 三处额外加 `delete_error_params`（对应 Task 8 里 `backend_server.py` 新增的 `delete_error_params` 字段）：
```typescript
encrypt_file: {
  params: { input_path: string; output_path: string; delete_source?: boolean; cipher?: FileCipher }
  result:
    | {
        ok: true
        output_path: string
        source_deleted?: boolean
        delete_error?: string
        delete_error_params?: Record<string, string | number>
      }
    | { ok: false; error: string; error_params?: Record<string, string | number> }
}
```
（`decrypt_file`、`password_import_csv` 同理加 `delete_error_params`。）

- [ ] **Step 2: 编译确认**

Run: `cd modules/file_vault/ui && npx tsc --noEmit`
Expected: 无错误（这一步只是加宽类型，不应该产生新的类型错误；如果某处报错，通常是因为原本的联合类型分支写法不一致，对照上下文修正）

- [ ] **Step 3: 提交**

```bash
git add modules/file_vault/ui/src/shared/ipcTypes.ts
git commit -m "feat(file_vault-ui): add error_params to IPC error result types"
```

---

## Task 13: `i18n/index.ts` — 初始化 + 语言解析

**Files:**
- Create: `modules/file_vault/ui/src/i18n/index.ts`
- Create: `modules/file_vault/ui/src/i18n/locales/zh/common.json`（先建一个最小占位，验证初始化能跑通；完整内容在 Task 17）

- [ ] **Step 1: 建最小占位翻译资源，验证 i18next 能正常初始化**

```json
// modules/file_vault/ui/src/i18n/locales/zh/common.json
{
  "appName": "Ideal1 File Vault"
}
```

```json
// modules/file_vault/ui/src/i18n/locales/en/common.json
{
  "appName": "Ideal1 File Vault"
}
```

（`fr`/`es`/`ru`/`ar` 四个语言目录下也各建一个内容相同的 `common.json` 占位——这个字符串是产品名，各语言保持英文原名不翻译。）

- [ ] **Step 2: 实现 `i18n/index.ts`**

```typescript
// modules/file_vault/ui/src/i18n/index.ts
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

import commonZh from './locales/zh/common.json'
import commonEn from './locales/en/common.json'
import commonFr from './locales/fr/common.json'
import commonEs from './locales/es/common.json'
import commonRu from './locales/ru/common.json'
import commonAr from './locales/ar/common.json'

export const SUPPORTED_LANGUAGES = ['zh', 'en', 'fr', 'es', 'ru', 'ar'] as const
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number]

const STORAGE_KEY = 'ideal1-file-vault-lang'

// Electron's app.getLocale() returns things like "zh-CN"/"fr-FR"/"ar-SA" -
// only the part before the first "-" is meaningful for matching against
// our 6 supported codes; anything else (ja, de, ...) falls back to English.
function resolveSupportedLanguage(rawLocale: string): SupportedLanguage {
  const prefix = rawLocale.split('-')[0].toLowerCase()
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(prefix) ? (prefix as SupportedLanguage) : 'en'
}

async function detectInitialLanguage(): Promise<SupportedLanguage> {
  const saved = localStorage.getItem(STORAGE_KEY)
  if (saved && (SUPPORTED_LANGUAGES as readonly string[]).includes(saved)) {
    return saved as SupportedLanguage
  }
  try {
    const systemLocale = await window.electronAPI.getSystemLocale()
    return resolveSupportedLanguage(systemLocale)
  } catch {
    return 'en'
  }
}

export function saveLanguagePreference(lang: SupportedLanguage): void {
  localStorage.setItem(STORAGE_KEY, lang)
}

// 每个命名空间目前只接了 common - 其余命名空间（login/setup/settings/
// files/passwords/tasks/errors）在 Phase C 各自的任务里补齐这份 resources
// 表，不是遗漏，是有意分批做，避免这一个任务的 diff 过大。
const resources = {
  zh: { common: commonZh },
  en: { common: commonEn },
  fr: { common: commonFr },
  es: { common: commonEs },
  ru: { common: commonRu },
  ar: { common: commonAr },
}

export async function initI18n(): Promise<void> {
  const lang = await detectInitialLanguage()
  await i18n.use(initReactI18next).init({
    resources,
    lng: lang,
    fallbackLng: 'en',
    ns: ['common'],
    defaultNS: 'common',
    keySeparator: false, // our keys are flat, dot-separated error codes (e.g. "auth.wrong_password") -
    // i18next's default keySeparator ('.') would otherwise try to resolve them as nested objects and
    // silently fail to find every single error-code key. This must be set before Task 14 adds errors.json.
    interpolation: { escapeValue: false }, // React already escapes
  })
}

export default i18n
```

- [ ] **Step 2: 补充说明——为什么用异步 `initI18n()` 而不是同步初始化**

系统语言检测要经过一次 IPC 往返（`window.electronAPI.getSystemLocale()`），本质是异步的，所以初始化本身也是异步函数，由 `main.tsx`（Task 15）在渲染 `<App />` 之前 `await` 它，避免出现"先用错误的默认语言渲染一帧、再跳变成正确语言"的闪烁。

**这一步的 `keySeparator: false` 是硬性要求，不是可选优化。** Task 14 会引入约 60 个错误码作为翻译 key（如 `auth.wrong_password`、`container.same_path`），这些 key 本身就含点号，是刻意的 `<模块>.<原因>` 命名约定（见规格文档）。i18next 默认会把 key 里的 `.` 当成嵌套路径分隔符去查找嵌套对象，而 `errors.json` 里这些 key 是扁平的顶层字符串键、不是嵌套对象——如果不设 `keySeparator: false`，`translateError()` 会对着所有约 60 个错误码全部查找失败，静默退化成通用兜底文案，且不会报错，很难在测试里发现。务必在这一步就设好，不要等到 Task 14 联调时才发现。

- [ ] **Step 3: 提交**

```bash
git add modules/file_vault/ui/src/i18n/
git commit -m "feat(file_vault-ui): add i18next initialization with system locale detection"
```

---

## Task 14: `i18n/errors.ts` — `translateError()` + `errors` 命名空间（含全部后端错误码）

**Files:**
- Create: `modules/file_vault/ui/src/i18n/errors.ts`
- Create: `modules/file_vault/ui/src/i18n/locales/{zh,en,fr,es,ru,ar}/errors.json`
- Modify: `modules/file_vault/ui/src/i18n/index.ts`（把 `errors` 命名空间接进 `resources`）

这是 Phase A 里定下的全部错误码第一次在前端落地。下面先给中文（`zh`）版本的完整内容（照抄 Phase A 每个任务表格里"改为"那一列的错误码，配上原来那句中文当翻译文本——这是最简单也最准确的提取方式，因为这些错误码本来就是从这些中文文案抽出来的）。

- [ ] **Step 1: 建 `zh/errors.json`（完整版，60 个 key，逐个来自 Phase A 任务表格）**

```json
{
  "container.same_path": "输出文件不能和源文件是同一个文件，请另选一个保存位置",
  "container.unsupported_cipher": "不支持的加密算法：{{cipher}}",
  "container.file_too_large": "文件过大，超出单文件分块数量上限",
  "container.invalid_file": "所选文件不是有效的加密文件",
  "container.header_incomplete": "所选文件不是有效的加密文件（头部不完整）",
  "container.unsupported_format_version": "不支持的容器格式版本：{{version}}",
  "container.invalid_header": "加密文件头部格式不正确",
  "container.key_mismatch": "无法用当前密钥解开此文件（密钥不匹配）",
  "container.metadata_corrupted": "加密文件的元数据已损坏或被篡改",
  "container.corrupted": "文件已损坏或被篡改，解密中止",
  "container.checksum_mismatch": "解密后内容与原始校验值不一致，文件可能已损坏",
  "container.path_is_directory": "不支持直接删除文件夹",
  "identity.not_set_up": "尚未完成身份设置",
  "auth.wrong_password": "密码错误",
  "auth.wrong_recovery_key": "恢复密钥不正确",
  "auth.totp_not_set_up": "验证器尚未设置",
  "auth.totp_invalid_or_expired": "验证码错误或已过期，请查看验证器 App 最新的 6 位数字",
  "auth.totp_unlock_failed": "验证器解锁失败，本机存储的验证器信息可能已损坏",
  "auth.recovery_email_not_set": "尚未设置恢复邮箱",
  "auth.email_code_invalid_or_expired": "验证码错误、已过期或已使用，请点击重新发送",
  "auth.email_unlock_not_set_up": "邮箱解锁尚未设置",
  "auth.email_unlock_failed": "邮箱解锁失败，本机存储的邮箱信息可能已损坏",
  "auth.fingerprint_verification_cancelled": "指纹验证未通过，重新绑定已取消",
  "auth.not_unlocked": "尚未解锁",
  "auth.email_code_not_sent": "请先点击发送验证码",
  "auth.fingerprint_not_bound": "此身份未绑定指纹解锁",
  "auth.fingerprint_binding_stale": "该指纹绑定已失效（可能是旧版本升级后未重新绑定），请到设置里点“重新绑定指纹解锁”",
  "auth.fingerprint_verification_failed": "指纹验证未通过",
  "auth.totp_code_invalid": "验证码不正确",
  "fingerprint.component_not_installed": "Windows Hello 组件未安装",
  "fingerprint.verification_error": "指纹验证过程出错",
  "fingerprint.device_not_present": "这台电脑没有指纹传感器",
  "fingerprint.not_configured": "这台电脑未配置 Windows Hello 指纹",
  "fingerprint.disabled_by_policy": "Windows Hello 指纹已被系统策略禁用",
  "fingerprint.device_busy": "指纹传感器正忙，请稍后重试",
  "fingerprint.retries_exhausted": "指纹验证失败次数过多，请稍后重试",
  "fingerprint.verification_failed": "指纹验证失败",
  "password.invalid_format": "密码库文件格式不正确",
  "password.unsupported_format_version": "不支持的密码库格式版本：{{version}}",
  "password.key_mismatch": "无法用当前密钥解开密码库（密钥不匹配或文件已损坏）",
  "password.content_corrupted": "密码库内容已损坏",
  "password.csv_empty_or_invalid": "CSV 文件是空的或格式不正确",
  "password.csv_missing_columns": "CSV 缺少必需的 url/username/password 列，无法识别这个文件的格式",
  "password.entry_not_found": "找不到这条密码记录",
  "task.data_not_found": "找不到任务数据：{{path}}",
  "task.invalid_format": "任务数据文件格式不正确",
  "task.unsupported_format_version": "不支持的任务数据格式版本：{{version}}",
  "task.key_mismatch": "无法用当前密钥解开任务数据（密钥不匹配或文件已损坏）",
  "task.metadata_corrupted": "任务元数据内容已损坏",
  "task.git_init_failed": "初始化 git 仓库失败：{{detail}}",
  "task.initial_commit_failed": "创建初始提交失败：{{detail}}",
  "task.worktree_create_failed": "创建隔离工作区失败：{{detail}}",
  "task.terminal_launch_failed": "无法打开终端窗口：{{detail}}",
  "task.merge_failed": "合并失败：{{detail}}",
  "task.no_worktree_to_merge": "直接原目录模式没有需要合并的独立分支，改动已经在你的工作区里",
  "email.send_failed": "发送失败：{{detail}}",
  "smtp.not_configured": "尚未配置发信邮箱，请先在设置里完成邮箱配置",
  "shell.vscode_not_found": "找不到 VS Code 命令行工具 \"code\"。请打开 VS Code，按 Ctrl+Shift+P 搜索 \"Shell Command: Install 'code' command in PATH\" 并执行，然后重试。",
  "internal.unexpected": "发生了意外错误：{{detail}}",
  "common.unknown": "发生未知错误"
}
```

- [ ] **Step 2: 翻译成其余 5 种语言**

`en/errors.json`（完整示范，其余 4 语言按同样结构和术语表翻译）：

```json
{
  "container.same_path": "The output file cannot be the same as the source file - please choose a different save location",
  "container.unsupported_cipher": "Unsupported cipher: {{cipher}}",
  "container.file_too_large": "File too large - exceeds the per-file chunk count limit",
  "container.invalid_file": "The selected file is not a valid encrypted container",
  "container.header_incomplete": "The selected file is not a valid encrypted container (incomplete header)",
  "container.unsupported_format_version": "Unsupported container format version: {{version}}",
  "container.invalid_header": "The encrypted file's header is malformed",
  "container.key_mismatch": "This file cannot be opened with the current key (key mismatch)",
  "container.metadata_corrupted": "The encrypted file's metadata is corrupted or has been tampered with",
  "container.corrupted": "The file is corrupted or has been tampered with - decryption aborted",
  "container.checksum_mismatch": "The decrypted content doesn't match the original checksum - the file may be corrupted",
  "container.path_is_directory": "Directories cannot be deleted directly",
  "identity.not_set_up": "Identity has not been set up yet",
  "auth.wrong_password": "Incorrect password",
  "auth.wrong_recovery_key": "Incorrect recovery key",
  "auth.totp_not_set_up": "Authenticator has not been set up",
  "auth.totp_invalid_or_expired": "Incorrect or expired code - check the latest 6-digit code in your authenticator app",
  "auth.totp_unlock_failed": "Authenticator unlock failed - the stored authenticator data may be corrupted",
  "auth.recovery_email_not_set": "No recovery email has been set",
  "auth.email_code_invalid_or_expired": "Incorrect, expired, or already-used code - click to resend",
  "auth.email_unlock_not_set_up": "Email unlock has not been set up",
  "auth.email_unlock_failed": "Email unlock failed - the stored email data may be corrupted",
  "auth.fingerprint_verification_cancelled": "Fingerprint verification was not completed - rebinding cancelled",
  "auth.not_unlocked": "Not unlocked yet",
  "auth.email_code_not_sent": "Please click \"Send code\" first",
  "auth.fingerprint_not_bound": "This identity has no fingerprint unlock bound",
  "auth.fingerprint_binding_stale": "This fingerprint binding is no longer valid (possibly left over from an older version) - go to Settings and click \"Rebind fingerprint unlock\"",
  "auth.fingerprint_verification_failed": "Fingerprint verification failed",
  "auth.totp_code_invalid": "Incorrect code",
  "fingerprint.component_not_installed": "The Windows Hello component is not installed",
  "fingerprint.verification_error": "An error occurred during fingerprint verification",
  "fingerprint.device_not_present": "This computer has no fingerprint sensor",
  "fingerprint.not_configured": "Windows Hello fingerprint is not configured on this computer",
  "fingerprint.disabled_by_policy": "Windows Hello fingerprint has been disabled by system policy",
  "fingerprint.device_busy": "The fingerprint sensor is busy - please try again shortly",
  "fingerprint.retries_exhausted": "Too many failed fingerprint attempts - please try again later",
  "fingerprint.verification_failed": "Fingerprint verification failed",
  "password.invalid_format": "The password vault file format is invalid",
  "password.unsupported_format_version": "Unsupported password vault format version: {{version}}",
  "password.key_mismatch": "The password vault cannot be opened with the current key (key mismatch or the file is corrupted)",
  "password.content_corrupted": "The password vault's content is corrupted",
  "password.csv_empty_or_invalid": "The CSV file is empty or malformed",
  "password.csv_missing_columns": "The CSV is missing the required url/username/password columns - couldn't recognize this file's format",
  "password.entry_not_found": "Couldn't find this password entry",
  "task.data_not_found": "Task data not found: {{path}}",
  "task.invalid_format": "The task data file format is invalid",
  "task.unsupported_format_version": "Unsupported task data format version: {{version}}",
  "task.key_mismatch": "The task data cannot be opened with the current key (key mismatch or the file is corrupted)",
  "task.metadata_corrupted": "The task metadata is corrupted",
  "task.git_init_failed": "Failed to initialize the git repository: {{detail}}",
  "task.initial_commit_failed": "Failed to create the initial commit: {{detail}}",
  "task.worktree_create_failed": "Failed to create the isolated worktree: {{detail}}",
  "task.terminal_launch_failed": "Couldn't open a terminal window: {{detail}}",
  "task.merge_failed": "Merge failed: {{detail}}",
  "task.no_worktree_to_merge": "Direct-directory mode has no separate branch to merge - your changes are already in your working copy",
  "email.send_failed": "Failed to send: {{detail}}",
  "smtp.not_configured": "No outgoing email account configured yet - please finish setting it up in Settings",
  "shell.vscode_not_found": "Couldn't find the VS Code command-line tool \"code\". Open VS Code, press Ctrl+Shift+P, search for \"Shell Command: Install 'code' command in PATH\", run it, then try again.",
  "internal.unexpected": "An unexpected error occurred: {{detail}}",
  "common.unknown": "An unknown error occurred"
}
```

`fr/errors.json`、`es/errors.json`、`ru/errors.json`、`ar/errors.json`：用同样的 60 个 key，把 `en` 版本的英文值翻译成对应语言，套用本计划开头的术语表保持用词一致。`{{cipher}}`/`{{version}}`/`{{path}}`/`{{detail}}` 这些插值占位符原样保留，不翻译占位符名字本身。阿拉伯语版本注意：这份 JSON 文件本身的书写方向不受影响（JSON 语法是 LTR 的），只有渲染到界面上时才会因为 Task 16 设置的 `dir="rtl"` 呈现从右到左，这里翻译时只管把值写成阿拉伯语文本即可，不需要做任何特殊处理。

- [ ] **Step 3: 实现 `translateError()`**

```typescript
// modules/file_vault/ui/src/i18n/errors.ts
import i18n from './index'

export function translateError(code: string, params?: Record<string, string | number>): string {
  const key = `errors:${code}`
  if (!i18n.exists(key)) {
    return i18n.t('errors:common.unknown')
  }
  return i18n.t(key, params)
}
```

- [ ] **Step 4: 把 `errors` 命名空间接进 `i18n/index.ts` 的 `resources`**

```typescript
// i18n/index.ts 顶部新增 import
import errorsZh from './locales/zh/errors.json'
import errorsEn from './locales/en/errors.json'
import errorsFr from './locales/fr/errors.json'
import errorsEs from './locales/es/errors.json'
import errorsRu from './locales/ru/errors.json'
import errorsAr from './locales/ar/errors.json'
```

```typescript
// resources 表和 ns 列表都要加上 errors
const resources = {
  zh: { common: commonZh, errors: errorsZh },
  en: { common: commonEn, errors: errorsEn },
  fr: { common: commonFr, errors: errorsFr },
  es: { common: commonEs, errors: errorsEs },
  ru: { common: commonRu, errors: errorsRu },
  ar: { common: commonAr, errors: errorsAr },
}
// ...
ns: ['common', 'errors'],
```

- [ ] **Step 5: 写一个一致性检查脚本（Node 脚本，一次性用，不接入 CI）**

```javascript
// modules/file_vault/ui/scripts/check-i18n-keys.mjs
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// 用 fileURLToPath 而不是 .pathname —— Windows 上 file:// URL 的 .pathname
// 会带一个多余的前导斜杠（变成 "/D:/...")，被 readdirSync 当作 "D:\D:\..." 处理会报 ENOENT。
const LOCALES_DIR = fileURLToPath(new URL('../src/i18n/locales', import.meta.url))
const languages = readdirSync(LOCALES_DIR)
let hasError = false

const namespaces = readdirSync(join(LOCALES_DIR, languages[0])).map((f) => f.replace('.json', ''))

for (const ns of namespaces) {
  const keysPerLang = {}
  for (const lang of languages) {
    const content = JSON.parse(readFileSync(join(LOCALES_DIR, lang, `${ns}.json`), 'utf-8'))
    keysPerLang[lang] = new Set(Object.keys(content))
  }
  const baseline = keysPerLang[languages[0]]
  for (const lang of languages.slice(1)) {
    const missing = [...baseline].filter((k) => !keysPerLang[lang].has(k))
    const extra = [...keysPerLang[lang]].filter((k) => !baseline.has(k))
    if (missing.length > 0 || extra.length > 0) {
      hasError = true
      console.error(`[${ns}] ${lang}: missing=${JSON.stringify(missing)} extra=${JSON.stringify(extra)}`)
    }
  }
}

if (hasError) {
  console.error('i18n key consistency check FAILED')
  process.exit(1)
} else {
  console.log('i18n key consistency check passed - all languages have matching keys per namespace')
}
```

Run: `cd modules/file_vault/ui && node scripts/check-i18n-keys.mjs`
Expected: `i18n key consistency check passed`（此时只有 `common` 和 `errors` 两个命名空间存在，检查通过就够了；`login`/`setup`/`settings`/`files`/`passwords`/`tasks` 六个命名空间的文件要到 Phase C 才会创建）

- [ ] **Step 6: 提交**

```bash
git add modules/file_vault/ui/src/i18n/ modules/file_vault/ui/scripts/check-i18n-keys.mjs
git commit -m "feat(file_vault-ui): add translateError() and errors translation namespace"
```

---

## Task 15: `main.tsx` + `App.tsx` — 挂载 i18n、语言切换器、RTL 联动

**Files:**
- Create: `modules/file_vault/ui/src/components/LanguageSwitcher.tsx`
- Modify: `modules/file_vault/ui/src/main.tsx`
- Modify: `modules/file_vault/ui/src/App.tsx`

- [ ] **Step 1: 实现 `LanguageSwitcher.tsx`**

```typescript
// modules/file_vault/ui/src/components/LanguageSwitcher.tsx
import { useTranslation } from 'react-i18next'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { SUPPORTED_LANGUAGES, saveLanguagePreference, type SupportedLanguage } from '@/i18n'

const LANGUAGE_NAMES: Record<SupportedLanguage, string> = {
  zh: '简体中文',
  en: 'English',
  fr: 'Français',
  es: 'Español',
  ru: 'Русский',
  ar: 'العربية',
}

export function LanguageSwitcher() {
  const { i18n } = useTranslation()

  function handleChange(lang: string) {
    i18n.changeLanguage(lang)
    saveLanguagePreference(lang as SupportedLanguage)
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr'
  }

  return (
    <Select value={i18n.language} onValueChange={handleChange}>
      <SelectTrigger className="w-[140px]" aria-label="Language">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {SUPPORTED_LANGUAGES.map((lang) => (
          <SelectItem key={lang} value={lang}>
            {LANGUAGE_NAMES[lang]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
```

先确认项目里已经有 shadcn 的 `Select` 组件（`ls modules/file_vault/ui/src/components/ui/select.tsx`）；如果没有，用现有 `npx shadcn add select` 的方式补装（项目已经用了 `radix-ui` 这个 shadcn 依赖包，`Select` 组件本身大概率还没单独生成过，需要确认）。

- [ ] **Step 2: `main.tsx` 改成异步等待 i18n 初始化完成再渲染**

```typescript
// 原
import React from 'react'
import ReactDOM from 'react-dom/client'
import { ThemeProvider } from 'next-themes'
import App from './App.tsx'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
      <App />
    </ThemeProvider>
  </React.StrictMode>,
)

// 改为
import React from 'react'
import ReactDOM from 'react-dom/client'
import { ThemeProvider } from 'next-themes'
import App from './App.tsx'
import './index.css'
import { initI18n } from './i18n'

initI18n().then(() => {
  document.documentElement.dir = document.documentElement.lang === 'ar' ? 'rtl' : 'ltr'
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
        <App />
      </ThemeProvider>
    </React.StrictMode>,
  )
})
```

`document.documentElement.lang` 在 i18next 初始化完成后不会自动等于当前语言（i18next 本身不改 `<html lang>`），这里改成直接读 `i18n` 实例更可靠：

```typescript
import i18n, { initI18n } from './i18n'

initI18n().then(() => {
  document.documentElement.lang = i18n.language
  document.documentElement.dir = i18n.language === 'ar' ? 'rtl' : 'ltr'
  // ...render...
})
```

- [ ] **Step 3: `App.tsx` 挂载 `LanguageSwitcher`**

```typescript
// 原
import { useEffect, useState } from 'react'
import { Toaster } from '@/components/ui/sonner'
import { SetupWizard } from '@/components/SetupWizard'
import { LoginScreen } from '@/components/LoginScreen'
import { AppShell } from '@/components/AppShell'
import { vaultApi } from '@/lib/vaultApi'

type View = 'loading' | 'setup' | 'login' | 'app'

function App() {
  const [view, setView] = useState<View>('loading')

  useEffect(() => {
    vaultApi.call('identity_exists', {}).then((res) => setView(res.exists ? 'login' : 'setup'))
  }, [])

  return (
    <>
      {view === 'loading' && <div className="flex min-h-screen items-center justify-center bg-background" />}
      {view === 'setup' && <SetupWizard onComplete={() => setView('app')} />}
      {view === 'login' && <LoginScreen onUnlocked={() => setView('app')} />}
      {view === 'app' && <AppShell />}
      <Toaster />
    </>
  )
}

export default App

// 改为
import { useEffect, useState } from 'react'
import { Toaster } from '@/components/ui/sonner'
import { SetupWizard } from '@/components/SetupWizard'
import { LoginScreen } from '@/components/LoginScreen'
import { AppShell } from '@/components/AppShell'
import { LanguageSwitcher } from '@/components/LanguageSwitcher'
import { vaultApi } from '@/lib/vaultApi'

type View = 'loading' | 'setup' | 'login' | 'app'

function App() {
  const [view, setView] = useState<View>('loading')

  useEffect(() => {
    vaultApi.call('identity_exists', {}).then((res) => setView(res.exists ? 'login' : 'setup'))
  }, [])

  return (
    <>
      <div className="fixed right-4 top-4 z-50">
        <LanguageSwitcher />
      </div>
      {view === 'loading' && <div className="flex min-h-screen items-center justify-center bg-background" />}
      {view === 'setup' && <SetupWizard onComplete={() => setView('app')} />}
      {view === 'login' && <LoginScreen onUnlocked={() => setView('app')} />}
      {view === 'app' && <AppShell />}
      <Toaster />
    </>
  )
}

export default App
```

- [ ] **Step 4: 手动验证**

Run: `python -X utf8 scripts/run.py run file_vault`（项目根目录下跑，会拉起 Vite + Electron）

在弹出的窗口右上角应该能看到语言下拉框，切换后（哪怕这时候大部分文案还是硬编码中文，因为 Phase C 还没做）下拉框本身的文字（简体中文/English/...）应该正确显示，且切到"العربية"时整个页面应该整体镜像成从右到左布局。关掉窗口结束验证。

- [ ] **Step 5: 提交**

```bash
git add modules/file_vault/ui/src/main.tsx modules/file_vault/ui/src/App.tsx modules/file_vault/ui/src/components/LanguageSwitcher.tsx
git commit -m "feat(file_vault-ui): mount language switcher and wire up i18n init"
```

---

# Phase C — 前端组件文案提取

以下每个任务的模式相同：① 建这个组件对应命名空间的 `zh` 基线 JSON（照抄组件里现有的中文，逐句提取，机械但要精确）；② 翻译成其余 5 种语言（套用开头的术语表保持用词统一）；③ 把组件里硬编码的 JSX 文本换成 `t('namespace:key')`；④ 跑一致性检查脚本；⑤ 手动跑一次 `/verify` 走一遍这个屏幕确认没有漏翻的中文和明显的插值错误；⑥ 提交。

**Task 16（`login` 命名空间）给出完整的六语言示范**，之后的任务只给 `zh` 基线 + 需要翻译的 key 列表，翻译请求参照 Task 16 的风格（正式但不生硬的语气，按钮用祈使句，错误提示简洁）和开头的术语表。

---

## Task 16: `login` 命名空间 — `LoginScreen.tsx` + `UnlockDialog.tsx` + `UnlockTabs.tsx`（完整六语言示范）

**Files:**
- Create: `modules/file_vault/ui/src/i18n/locales/{zh,en,fr,es,ru,ar}/login.json`
- Modify: `modules/file_vault/ui/src/i18n/index.ts`（接入 `login` 命名空间）
- Modify: `modules/file_vault/ui/src/components/LoginScreen.tsx`
- Modify: `modules/file_vault/ui/src/components/UnlockDialog.tsx`
- Modify: `modules/file_vault/ui/src/components/UnlockTabs.tsx`

- [ ] **Step 1: `zh/login.json`**

```json
{
  "loginTitle": "登录 - Ideal1 File Vault",
  "unlockTitle": "解锁",
  "tabPassword": "密码",
  "tabTotp": "验证器",
  "tabEmail": "邮箱",
  "tabRecovery": "恢复密钥",
  "tabFingerprint": "指纹",
  "passwordLabel": "密码",
  "unlockButton": "解锁",
  "unlockFailedFallback": "解锁失败",
  "totpLabel": "验证器 6 位验证码",
  "emailInitialStatus": "点击发送验证码到已注册邮箱",
  "emailSending": "正在发送...",
  "emailSentStatus": "验证码已发送到 {{address}}，10 分钟内有效",
  "emailSendFailedFallback": "发送失败",
  "sendCodeButton": "发送验证码",
  "emailCodeLabel": "收到的验证码",
  "emailCodeRequired": "请先点击发送验证码",
  "recoveryKeyLabel": "恢复密钥",
  "fingerprintInitialStatus": "点击开始，随后请按提示触摸指纹传感器",
  "fingerprintVerifying": "等待验证...",
  "fingerprintButton": "使用指纹解锁"
}
```

- [ ] **Step 2: `en/login.json`**

```json
{
  "loginTitle": "Log In - Ideal1 File Vault",
  "unlockTitle": "Unlock",
  "tabPassword": "Password",
  "tabTotp": "Authenticator",
  "tabEmail": "Email",
  "tabRecovery": "Recovery Key",
  "tabFingerprint": "Fingerprint",
  "passwordLabel": "Password",
  "unlockButton": "Unlock",
  "unlockFailedFallback": "Unlock failed",
  "totpLabel": "6-digit authenticator code",
  "emailInitialStatus": "Click to send a code to your registered email",
  "emailSending": "Sending...",
  "emailSentStatus": "Code sent to {{address}}, valid for 10 minutes",
  "emailSendFailedFallback": "Failed to send",
  "sendCodeButton": "Send code",
  "emailCodeLabel": "Code you received",
  "emailCodeRequired": "Please click \"Send code\" first",
  "recoveryKeyLabel": "Recovery key",
  "fingerprintInitialStatus": "Click to start, then touch the fingerprint sensor when prompted",
  "fingerprintVerifying": "Waiting for verification...",
  "fingerprintButton": "Unlock with fingerprint"
}
```

- [ ] **Step 3: `fr/login.json`**

```json
{
  "loginTitle": "Connexion - Ideal1 File Vault",
  "unlockTitle": "Déverrouiller",
  "tabPassword": "Mot de passe",
  "tabTotp": "Authentificateur",
  "tabEmail": "E-mail",
  "tabRecovery": "Clé de récupération",
  "tabFingerprint": "Empreinte digitale",
  "passwordLabel": "Mot de passe",
  "unlockButton": "Déverrouiller",
  "unlockFailedFallback": "Échec du déverrouillage",
  "totpLabel": "Code à 6 chiffres de l'authentificateur",
  "emailInitialStatus": "Cliquez pour envoyer un code à votre e-mail enregistré",
  "emailSending": "Envoi en cours...",
  "emailSentStatus": "Code envoyé à {{address}}, valable 10 minutes",
  "emailSendFailedFallback": "Échec de l'envoi",
  "sendCodeButton": "Envoyer le code",
  "emailCodeLabel": "Code reçu",
  "emailCodeRequired": "Veuillez d'abord cliquer sur « Envoyer le code »",
  "recoveryKeyLabel": "Clé de récupération",
  "fingerprintInitialStatus": "Cliquez pour commencer, puis touchez le capteur d'empreintes lorsque demandé",
  "fingerprintVerifying": "Vérification en cours...",
  "fingerprintButton": "Déverrouiller avec l'empreinte digitale"
}
```

- [ ] **Step 4: `es/login.json`**

```json
{
  "loginTitle": "Iniciar sesión - Ideal1 File Vault",
  "unlockTitle": "Desbloquear",
  "tabPassword": "Contraseña",
  "tabTotp": "Autenticador",
  "tabEmail": "Correo",
  "tabRecovery": "Clave de recuperación",
  "tabFingerprint": "Huella dactilar",
  "passwordLabel": "Contraseña",
  "unlockButton": "Desbloquear",
  "unlockFailedFallback": "Error al desbloquear",
  "totpLabel": "Código de 6 dígitos del autenticador",
  "emailInitialStatus": "Haz clic para enviar un código a tu correo registrado",
  "emailSending": "Enviando...",
  "emailSentStatus": "Código enviado a {{address}}, válido por 10 minutos",
  "emailSendFailedFallback": "Error al enviar",
  "sendCodeButton": "Enviar código",
  "emailCodeLabel": "Código recibido",
  "emailCodeRequired": "Primero haz clic en \"Enviar código\"",
  "recoveryKeyLabel": "Clave de recuperación",
  "fingerprintInitialStatus": "Haz clic para comenzar y luego toca el sensor de huellas cuando se te indique",
  "fingerprintVerifying": "Esperando verificación...",
  "fingerprintButton": "Desbloquear con huella dactilar"
}
```

- [ ] **Step 5: `ru/login.json`**

```json
{
  "loginTitle": "Вход - Ideal1 File Vault",
  "unlockTitle": "Разблокировать",
  "tabPassword": "Пароль",
  "tabTotp": "Аутентификатор",
  "tabEmail": "Эл. почта",
  "tabRecovery": "Ключ восстановления",
  "tabFingerprint": "Отпечаток пальца",
  "passwordLabel": "Пароль",
  "unlockButton": "Разблокировать",
  "unlockFailedFallback": "Не удалось разблокировать",
  "totpLabel": "6-значный код аутентификатора",
  "emailInitialStatus": "Нажмите, чтобы отправить код на вашу зарегистрированную почту",
  "emailSending": "Отправка...",
  "emailSentStatus": "Код отправлен на {{address}}, действителен 10 минут",
  "emailSendFailedFallback": "Не удалось отправить",
  "sendCodeButton": "Отправить код",
  "emailCodeLabel": "Полученный код",
  "emailCodeRequired": "Сначала нажмите «Отправить код»",
  "recoveryKeyLabel": "Ключ восстановления",
  "fingerprintInitialStatus": "Нажмите, чтобы начать, затем прикоснитесь к датчику отпечатка пальца",
  "fingerprintVerifying": "Ожидание подтверждения...",
  "fingerprintButton": "Разблокировать по отпечатку пальца"
}
```

- [ ] **Step 6: `ar/login.json`**

```json
{
  "loginTitle": "تسجيل الدخول - Ideal1 File Vault",
  "unlockTitle": "فتح القفل",
  "tabPassword": "كلمة المرور",
  "tabTotp": "تطبيق المصادقة",
  "tabEmail": "البريد الإلكتروني",
  "tabRecovery": "مفتاح الاسترداد",
  "tabFingerprint": "بصمة الإصبع",
  "passwordLabel": "كلمة المرور",
  "unlockButton": "فتح القفل",
  "unlockFailedFallback": "فشل فتح القفل",
  "totpLabel": "رمز مكوّن من 6 أرقام من تطبيق المصادقة",
  "emailInitialStatus": "انقر لإرسال رمز إلى بريدك الإلكتروني المسجل",
  "emailSending": "جارٍ الإرسال...",
  "emailSentStatus": "تم إرسال الرمز إلى {{address}}، صالح لمدة 10 دقائق",
  "emailSendFailedFallback": "فشل الإرسال",
  "sendCodeButton": "إرسال الرمز",
  "emailCodeLabel": "الرمز الذي استلمته",
  "emailCodeRequired": "يرجى النقر على \"إرسال الرمز\" أولاً",
  "recoveryKeyLabel": "مفتاح الاسترداد",
  "fingerprintInitialStatus": "انقر للبدء، ثم المس مستشعر البصمة عند الطلب",
  "fingerprintVerifying": "في انتظار التحقق...",
  "fingerprintButton": "فتح القفل بالبصمة"
}
```

- [ ] **Step 7: 把 `login` 命名空间接进 `i18n/index.ts`**（照 Task 14 Step 4 同样的方式，加 6 个 import + `resources` 表每个语言加 `login: loginXx` + `ns` 数组加 `'login'`）

- [ ] **Step 8: 改 `LoginScreen.tsx`**

```typescript
// 原
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { EmailTab, FingerprintTab, PasswordTab, RecoveryTab, TotpTab } from '@/components/UnlockTabs'

export function LoginScreen({ onUnlocked }: { onUnlocked: () => void }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-10">
      <Card className="w-[460px]">
        <CardHeader>
          <CardTitle className="text-2xl">登录 - Ideal1 File Vault</CardTitle>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="fingerprint">
            <TabsList className="grid w-full grid-cols-5">
              <TabsTrigger value="password">密码</TabsTrigger>
              <TabsTrigger value="totp">验证器</TabsTrigger>
              <TabsTrigger value="email">邮箱</TabsTrigger>
              <TabsTrigger value="recovery">恢复密钥</TabsTrigger>
              <TabsTrigger value="fingerprint">指纹</TabsTrigger>
            </TabsList>
            {/* ...TabsContent 不变... */}
          </Tabs>
        </CardContent>
      </Card>
    </div>
  )
}

// 改为
import { useTranslation } from 'react-i18next'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { EmailTab, FingerprintTab, PasswordTab, RecoveryTab, TotpTab } from '@/components/UnlockTabs'

export function LoginScreen({ onUnlocked }: { onUnlocked: () => void }) {
  const { t } = useTranslation('login')
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-10">
      <Card className="w-[460px]">
        <CardHeader>
          <CardTitle className="text-2xl">{t('loginTitle')}</CardTitle>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="fingerprint">
            <TabsList className="grid w-full grid-cols-5">
              <TabsTrigger value="password">{t('tabPassword')}</TabsTrigger>
              <TabsTrigger value="totp">{t('tabTotp')}</TabsTrigger>
              <TabsTrigger value="email">{t('tabEmail')}</TabsTrigger>
              <TabsTrigger value="recovery">{t('tabRecovery')}</TabsTrigger>
              <TabsTrigger value="fingerprint">{t('tabFingerprint')}</TabsTrigger>
            </TabsList>
            {/* ...TabsContent 不变... */}
          </Tabs>
        </CardContent>
      </Card>
    </div>
  )
}
```

- [ ] **Step 9: 改 `UnlockDialog.tsx`**（同样的 5 个 tab 标签 + `解锁` 标题，用法和 Step 8 一样，`useTranslation('login')` + 替换对应文本）

- [ ] **Step 10: 改 `UnlockTabs.tsx`**（5 个导出的 Tab 组件，每个都要加 `useTranslation('login')`；重点是 3 处带插值的文案和所有 `res.error ?? '<中文兜底>'` 的地方）

```typescript
// PasswordTab 原
async function handleUnlock() {
  const res = await vaultApi.call('unlock_password', { password })
  if (res.ok) onUnlocked()
  else setError(res.error ?? '解锁失败')
}
// 改为（这里先只处理兜底文案的翻译；res.error 本身指向后端错误码，接入 translateError() 留到 Task 14 已经做好的基础设施上——注意 res.error 已经是错误码了，要用 translateError 而不是直接 t()）
import { translateError } from '@/i18n/errors'
// ...
async function handleUnlock() {
  const res = await vaultApi.call('unlock_password', { password })
  if (res.ok) onUnlocked()
  else setError(res.error ? translateError(res.error, res.error_params) : t('unlockFailedFallback'))
}
```

同样的模式应用到 `TotpTab`、`RecoveryTab`、`FingerprintTab` 的 `res.error ?? '解锁失败'`。

`EmailTab` 额外要处理插值状态文案：
```typescript
// 原
const [status, setStatus] = useState('点击发送验证码到已注册邮箱')
// ...
setStatus(`验证码已发送到 ${res.email_address}，10 分钟内有效`)
// ...
setStatus(res.error ?? '发送失败')
// ...
if (!sent) {
  setError('请先点击发送验证码')
  return
}

// 改为
const [status, setStatus] = useState('')
useEffect(() => setStatus(t('emailInitialStatus')), [t])
// ...
setStatus(t('emailSentStatus', { address: res.email_address }))
// ...
setStatus(res.error ? translateError(res.error, res.error_params) : t('emailSendFailedFallback'))
// ...
if (!sent) {
  setError(t('emailCodeRequired'))
  return
}
```

`FingerprintTab` 的初始状态文案同理，用 `useEffect` + `t('fingerprintInitialStatus')` 替代直接把中文字符串塞进 `useState` 初始值（因为组件挂载时 `t` 函数已经可用，但更安全的写法是用 `useEffect` 在语言切换时也能重新设置一次；如果测试后发现语言切换时这个初始态文案没有跟着变，检查是不是这里漏了 `useEffect` 依赖）。

- [ ] **Step 11: 跑一致性检查 + 编译检查**

Run: `cd modules/file_vault/ui && node scripts/check-i18n-keys.mjs && npx tsc --noEmit`
Expected: 都通过

- [ ] **Step 12: 手动验证**

Run: `python -X utf8 scripts/run.py run file_vault`

在登录页切换语言下拉框到每一种语言，确认 5 个 Tab 标签和"解锁"按钮文字都跟着变化；故意输错一次密码，确认错误提示是当前选中语言（不是中文）。切到阿拉伯语确认整个卡片跟着镜像、文字本身是阿拉伯语。

- [ ] **Step 13: 提交**

```bash
git add modules/file_vault/ui/src/i18n/ modules/file_vault/ui/src/components/LoginScreen.tsx modules/file_vault/ui/src/components/UnlockDialog.tsx modules/file_vault/ui/src/components/UnlockTabs.tsx
git commit -m "feat(file_vault-ui): translate login/unlock screens into 6 languages"
```

---

## Task 17: `common` 命名空间补全 — `AppShell.tsx`

**Files:**
- Modify: `modules/file_vault/ui/src/i18n/locales/{zh,en,fr,es,ru,ar}/common.json`（在 Task 13 建的占位基础上补全）
- Modify: `modules/file_vault/ui/src/components/AppShell.tsx`

- [ ] **Step 1: 补全 `zh/common.json`**（在已有的 `appName` 基础上新增以下 key）

```json
{
  "appName": "Ideal1 File Vault",
  "navFiles": "文件",
  "navFilesItem": "加密 / 解密",
  "navAccount": "账户",
  "navPasswords": "密码管理",
  "navAutomation": "自动化",
  "navTasks": "自动任务",
  "navOther": "其它",
  "navSettings": "设置"
}
```

- [ ] **Step 2: 按术语表翻译成其余 5 语言**（`navFilesItem`="加密 / 解密" 对应术语表的"加密"/"解密"组合，`navPasswords`="密码管理"、`navTasks`="自动任务"、`navSettings`="设置" 直接用术语表现成的词）

- [ ] **Step 3: 改 `AppShell.tsx`**

```typescript
// 原
const NAV_GROUPS: NavGroup[] = [
  { label: '文件', items: [{ pane: 'files', label: '加密 / 解密', icon: Lock }] },
  { label: '账户', items: [{ pane: 'passwords', label: '密码管理', icon: KeyRound }] },
  { label: '自动化', items: [{ pane: 'tasks', label: '自动任务', icon: Bot }] },
  { label: '其它', items: [{ pane: 'settings', label: '设置', icon: SettingsIcon }] },
]

export function AppShell() {
  // ...
}

// 改为：NAV_GROUPS 不能再是模块级常量（用不了 hook），挪进组件内部用 useMemo，
// 或者干脆每次渲染都重新构建（这个数组很小，没有性能问题）
import { useTranslation } from 'react-i18next'

export function AppShell() {
  const { t } = useTranslation('common')
  const NAV_GROUPS: NavGroup[] = [
    { label: t('navFiles'), items: [{ pane: 'files', label: t('navFilesItem'), icon: Lock }] },
    { label: t('navAccount'), items: [{ pane: 'passwords', label: t('navPasswords'), icon: KeyRound }] },
    { label: t('navAutomation'), items: [{ pane: 'tasks', label: t('navTasks'), icon: Bot }] },
    { label: t('navOther'), items: [{ pane: 'settings', label: t('navSettings'), icon: SettingsIcon }] },
  ]
  // ...其余不变，NAV_GROUPS 现在是函数内部变量
}
```

面包屑里的"自动任务"（line 108）也要替换：`<button className="hover:text-foreground" onClick={() => setActiveTask(null)}>自动任务</button>` → `{t('navTasks')}`。

- [ ] **Step 4: 一致性检查 + 编译 + 手动验证**（同 Task 16 Step 11-12 的方式，这次检查左侧导航栏 4 组标签）

- [ ] **Step 5: 提交**

```bash
git add modules/file_vault/ui/src/i18n/locales/*/common.json modules/file_vault/ui/src/components/AppShell.tsx
git commit -m "feat(file_vault-ui): translate app shell navigation into 6 languages"
```

---

## Task 18: `setup` 命名空间 — `SetupWizard.tsx`

**Files:**
- Create: `modules/file_vault/ui/src/i18n/locales/{zh,en,fr,es,ru,ar}/setup.json`
- Modify: `modules/file_vault/ui/src/i18n/index.ts`
- Modify: `modules/file_vault/ui/src/components/SetupWizard.tsx`

- [ ] **Step 1: `zh/setup.json`（zh 基线，逐句照抄 `SetupWizard.tsx` 现有中文）**

```json
{
  "wizardTitle": "首次设置 - Ideal1 File Vault",
  "stepLabel": "第 {{index}} 步 / {{total}}：{{title}}",
  "stepTitlePassword": "设置密码",
  "stepTitleTotp": "绑定验证器 App",
  "stepTitleFingerprint": "绑定指纹解锁",
  "stepTitleEmail": "邮箱与发信配置",
  "stepTitleRecovery": "离线恢复密钥",
  "passwordLabel": "密码",
  "passwordConfirmLabel": "确认密码",
  "passwordTooShort": "密码至少需要 8 个字符",
  "passwordMismatch": "两次输入的密码不一致",
  "nextButton": "下一步",
  "totpScanInstruction": "用 Google Authenticator / Microsoft Authenticator 等 App 扫描下面的二维码：",
  "totpQrAlt": "验证器二维码",
  "totpManualEntry": "或手动输入密钥：{{seed}}",
  "totpCodeLabel": "输入 App 当前显示的 6 位验证码确认",
  "totpCodeInvalid": "验证码不正确，请检查 App 里显示的最新验证码",
  "loading": "生成中...",
  "fingerprintInitialStatus": "点击开始绑定，随后请按提示触摸指纹传感器完成一次验证",
  "fingerprintVerifying": "等待验证...",
  "fingerprintVerifyFailedFallback": "验证失败",
  "fingerprintStartButton": "开始指纹验证",
  "emailAddressLabel": "恢复邮箱地址",
  "smtpHostLabel": "SMTP 服务器",
  "smtpPortLabel": "SMTP 端口",
  "smtpUsernameLabel": "发信账号",
  "smtpPasswordLabel": "应用专用密码",
  "smtpSslLabel": "使用 SSL（端口 465，不勾选则用 STARTTLS）",
  "sendingTestEmail": "正在发送测试邮件...",
  "testEmailSuccess": "测试邮件发送成功，请检查收件箱",
  "testEmailFailed": "发送失败：{{error}}",
  "sendTestEmailButton": "发送测试邮件",
  "skipEmailButton": "跳过（以后可在设置中补充）",
  "recoveryWarning": "这是唯一一次显示这把恢复密钥，之后不会再保存。请把它抄写或保存到一个安全的地方（不要和加密文件放在一起）。",
  "copyToClipboard": "复制到剪贴板",
  "recoveryConfirmLabel": "我已经把这把恢复密钥抄写/保存到安全的地方",
  "recoveryConfirmRequired": "请先确认已经保存恢复密钥",
  "finishButton": "完成"
}
```

- [ ] **Step 2: 翻译成其余 5 语言**（`{{index}}`/`{{total}}`/`{{title}}`/`{{seed}}`/`{{error}}` 占位符保留；`stepLabel` 的英文版例如 `"Step {{index}} of {{total}}: {{title}}"`，法语 `"Étape {{index}} sur {{total}} : {{title}}"`，其余语言按各自语法习惯翻译同样的结构）

- [ ] **Step 3: 接入 `i18n/index.ts`**（同 Task 16 Step 7 方式）

- [ ] **Step 4: 改 `SetupWizard.tsx`**

关键点：`STEP_TITLES` 这个 `Record<Step, string>` 常量目前是模块级的，改成组件内部函数（因为需要 `t()`）：

```typescript
// 原（模块级）
const STEP_TITLES: Record<Step, string> = {
  password: '设置密码',
  totp: '绑定验证器 App',
  fingerprint: '绑定指纹解锁',
  email: '邮箱与发信配置',
  recovery: '离线恢复密钥',
}

function stepLabel(step: Step, fingerprintAvailable: boolean): string {
  const activeSteps = fingerprintAvailable ? STEP_ORDER : STEP_ORDER.filter((s) => s !== 'fingerprint')
  const index = activeSteps.indexOf(step) + 1
  return `第 ${index} 步 / ${activeSteps.length}：${STEP_TITLES[step]}`
}

// 改为：把 t 当参数传进去（这个函数本来就是纯函数，不用变成 hook）
function stepLabel(step: Step, fingerprintAvailable: boolean, t: TFunction<'setup'>): string {
  const stepTitleKeys: Record<Step, string> = {
    password: 'stepTitlePassword',
    totp: 'stepTitleTotp',
    fingerprint: 'stepTitleFingerprint',
    email: 'stepTitleEmail',
    recovery: 'stepTitleRecovery',
  }
  const activeSteps = fingerprintAvailable ? STEP_ORDER : STEP_ORDER.filter((s) => s !== 'fingerprint')
  const index = activeSteps.indexOf(step) + 1
  return t('stepLabel', { index, total: activeSteps.length, title: t(stepTitleKeys[step]) })
}
```

`TFunction` 类型从 `i18next` 包导入：`import type { TFunction } from 'i18next'`。

`SetupWizard` 主组件：
```typescript
export function SetupWizard({ onComplete }: { onComplete: () => void }) {
  const { t } = useTranslation('setup')
  // ...
  <CardTitle className="text-2xl">{t('wizardTitle')}</CardTitle>
  <CardDescription>{stepLabel(step, fingerprintAvailable, t)}</CardDescription>
  // ...
}
```

其余 5 个子组件（`PasswordStep`、`TotpStep`、`FingerprintStep`、`EmailStep`、`RecoveryStep`）各自加 `const { t } = useTranslation('setup')`，把每处硬编码中文换成对应 key，包括：
- `PasswordStep` 的两处校验错误（`密码至少需要 8 个字符`/`两次输入的密码不一致`）
- `TotpStep` 的扫码说明、`或手动输入密钥：{seed}`（改成 `t('totpManualEntry', { seed })`）、验证码错误提示
- `FingerprintStep` 的 `res.error ?? '验证失败'` → 参照 Task 16 的模式用 `translateError(res.error, res.error_params) ?? t('fingerprintVerifyFailedFallback')`（注意这里 `res.error` 类型是 `string | undefined`，先判断存在性）：
  ```typescript
  setError(res.error ? translateError(res.error, res.error_params) : t('fingerprintVerifyFailedFallback'))
  ```
- `EmailStep` 的 `发送失败：${res.error}` → `t('testEmailFailed', { error: res.error ? translateError(res.error, res.error_params) : '' })`（这里 `res.error` 是后端错误码，套一层 `translateError` 再插进 `testEmailFailed` 模板）
- `RecoveryStep` 的确认勾选提示、"请先确认已经保存恢复密钥"

- [ ] **Step 5: 一致性检查 + 编译 + 手动验证**（走一遍完整设置向导的 5 个步骤，切换语言观察每一步）

- [ ] **Step 6: 提交**

```bash
git add modules/file_vault/ui/src/i18n/ modules/file_vault/ui/src/components/SetupWizard.tsx
git commit -m "feat(file_vault-ui): translate setup wizard into 6 languages"
```

---

## Task 19: `settings` 命名空间 — `SettingsScreen.tsx`

**Files:**
- Create: `modules/file_vault/ui/src/i18n/locales/{zh,en,fr,es,ru,ar}/settings.json`
- Modify: `modules/file_vault/ui/src/i18n/index.ts`
- Modify: `modules/file_vault/ui/src/components/SettingsScreen.tsx`

- [ ] **Step 1: `zh/settings.json`**

```json
{
  "pageTitle": "设置",
  "changePasswordButton": "修改密码",
  "rebindTotpButton": "重新绑定验证器",
  "updateEmailButton": "修改邮箱与发信配置",
  "regenRecoveryButton": "重新生成恢复密钥",
  "rebindFingerprintButton": "重新绑定指纹解锁",
  "rebindFingerprintFailedToast": "重新绑定失败",
  "rebindFingerprintSuccessToast": "指纹解锁已重新绑定",
  "changePasswordDialogTitle": "修改密码",
  "newPasswordLabel": "新密码",
  "newPasswordConfirmLabel": "确认新密码",
  "passwordTooShort": "密码至少需要 8 个字符",
  "passwordMismatch": "两次输入的密码不一致",
  "saveButton": "保存",
  "passwordUpdatedToast": "密码已更新",
  "rebindTotpDialogTitle": "重新绑定验证器",
  "totpScanInstruction": "用验证器 App 扫描新的二维码：",
  "totpQrAlt": "新验证器二维码",
  "totpConfirmCodeLabel": "输入新验证码确认",
  "confirmBindButton": "确认绑定",
  "loading": "生成中...",
  "totpRebindSuccessToast": "验证器已重新绑定",
  "updateEmailDialogTitle": "修改邮箱与发信配置",
  "recoveryEmailLabel": "恢复邮箱地址",
  "smtpHostLabel": "SMTP 服务器",
  "smtpPortLabel": "SMTP 端口",
  "smtpUsernameLabel": "发信账号",
  "smtpPasswordLabel": "应用专用密码（留空则沿用原密码）",
  "smtpSslLabel": "使用 SSL（端口 465）",
  "emailUpdatedToast": "邮箱与发信配置已更新",
  "regenRecoveryDialogTitle": "新的恢复密钥",
  "oldKeyInvalidWarning": "旧的恢复密钥已失效。这是唯一一次显示新密钥：",
  "copyToClipboard": "复制到剪贴板",
  "closeButton": "关闭"
}
```

- [ ] **Step 2: 翻译成其余 5 语言**

- [ ] **Step 3: 接入 `i18n/index.ts`**

- [ ] **Step 4: 改 `SettingsScreen.tsx`**

顶层 `SettingsScreen` 组件和 4 个 Dialog 子组件（`ChangePasswordDialog`、`RebindTotpDialog`、`UpdateEmailDialog`、`RegenRecoveryDialog`）各自加 `const { t } = useTranslation('settings')`，逐个替换。这个文件里所有 `toast.error(...)`/`toast.success(...)` 和 `setError(...)` 调用都要过一遍：

```typescript
// 例：handleRebindFingerprint（顶层组件内）
async function handleRebindFingerprint() {
  const res = await vaultApi.call('rebind_fingerprint', {})
  if (!res.ok) {
    toast.error(t('rebindFingerprintFailedToast'), { description: translateError(res.error, res.error_params) })
    return
  }
  toast.success(t('rebindFingerprintSuccessToast'))
}
```

`ChangePasswordDialog.handleSave` 的两处本地校验（密码长度、两次输入是否一致）直接用 `t('passwordTooShort')`/`t('passwordMismatch')`，这两处不涉及后端错误码（纯前端校验）。

- [ ] **Step 5: 一致性检查 + 编译 + 手动验证**（走一遍设置页 5 个按钮/弹窗）

- [ ] **Step 6: 提交**

```bash
git add modules/file_vault/ui/src/i18n/ modules/file_vault/ui/src/components/SettingsScreen.tsx
git commit -m "feat(file_vault-ui): translate settings screen into 6 languages"
```

---

## Task 20: `passwords` 命名空间 — `PasswordScreen.tsx`

**Files:**
- Create: `modules/file_vault/ui/src/i18n/locales/{zh,en,fr,es,ru,ar}/passwords.json`
- Modify: `modules/file_vault/ui/src/i18n/index.ts`
- Modify: `modules/file_vault/ui/src/components/PasswordScreen.tsx`

- [ ] **Step 1: `zh/passwords.json`**

```json
{
  "pageTitle": "密码管理",
  "searchPlaceholder": "搜索名称/网址/用户名",
  "addButton": "新增",
  "importCsvButton": "导入 CSV",
  "exportCsvButton": "导出 CSV",
  "emptyList": "还没有密码记录",
  "hideButton": "隐藏",
  "showButton": "显示",
  "copyButton": "复制",
  "editButton": "编辑",
  "deleteButton": "删除",
  "deleteFailedToast": "删除失败",
  "deletedToast": "已删除",
  "importDialogTitle": "选择浏览器导出的密码 CSV",
  "importFailedToast": "导入失败",
  "importedToast": "导入了 {{count}} 条密码",
  "importedAndSourceDeletedSuffix": "，已安全删除原 CSV 文件",
  "exportDialogTitle": "导出密码为 CSV",
  "exportFailedToast": "导出失败",
  "exportCompleteToast": "导出完成",
  "openFolderAction": "打开所在文件夹",
  "editDialogTitleEdit": "编辑密码",
  "editDialogTitleNew": "新增密码",
  "nameLabel": "名称",
  "urlLabel": "网址",
  "usernameLabel": "用户名",
  "passwordLabel": "密码",
  "notesLabel": "备注",
  "nameUrlRequired": "名称和网址不能为空",
  "saveButton": "保存"
}
```

- [ ] **Step 2: 翻译成其余 5 语言**

- [ ] **Step 3: 接入 `i18n/index.ts`**

- [ ] **Step 4: 改 `PasswordScreen.tsx`**

```typescript
// handleImport 里带插值的例子
toast.success(`导入了 ${res.imported_count} 条密码${res.source_deleted ? '，已安全删除原 CSV 文件' : ''}`)
// 改为
toast.success(
  t('importedToast', { count: res.imported_count }) + (res.source_deleted ? t('importedAndSourceDeletedSuffix') : ''),
)
```

`PasswordEditDialog` 里 `setError(res.error)`（line 176）注意这个 `res.error` 是后端错误码，要用 `translateError`：
```typescript
if (!res.ok) {
  setError(translateError(res.error, res.error_params))
  return
}
```

`handleSave` 的本地校验 `setError('名称和网址不能为空')` → `setError(t('nameUrlRequired'))`（纯前端校验，不经过 `translateError`）。

- [ ] **Step 5: 一致性检查 + 编译 + 手动验证**（新增/编辑/删除/导入/导出各走一遍）

- [ ] **Step 6: 提交**

```bash
git add modules/file_vault/ui/src/i18n/ modules/file_vault/ui/src/components/PasswordScreen.tsx
git commit -m "feat(file_vault-ui): translate password manager into 6 languages"
```

---

## Task 21: `files` 命名空间 — `FilesPane.tsx`

这是文案量最大的一个组件（446 行，8 处插值文案），单独一个任务，翻译时格外注意插值占位符名字要和 zh 版本完全一致（一致性检查脚本只查 key 是否对齐，不查占位符是否对齐，占位符名字打错不会被脚本发现，只会在运行时 i18next 找不到值、原样显示 `{{xxx}}`）。

**Files:**
- Create: `modules/file_vault/ui/src/i18n/locales/{zh,en,fr,es,ru,ar}/files.json`
- Modify: `modules/file_vault/ui/src/i18n/index.ts`
- Modify: `modules/file_vault/ui/src/components/FilesPane.tsx`

- [ ] **Step 1: `zh/files.json`**

```json
{
  "pageTitle": "加密 / 解密",
  "cipherLabel": "加密算法（解密自动识别，无需选择）",
  "cipherHintAes256": "默认，256 位密钥，硬件加速",
  "cipherHintAes128": "128 位密钥，速度略快",
  "cipherHintChacha20": "256 位密钥，无 AES 硬件加速的机器上最快",
  "encryptButton": "加密文件...（可多选）",
  "deleteSourceOnEncryptLabel": "加密后安全删除原始文件（覆写后删除，不进回收站，无法恢复）",
  "decryptButton": "解密文件...（可多选）",
  "deleteSourceOnDecryptLabel": "解密后删除加密文件（覆写后删除，不进回收站，无法恢复）",
  "scanRemnantsButton": "扫描明文残留...（检查 WPS/Office 自动备份等）",
  "remnantScanFailedToast": "残留扫描失败：{{error}}",
  "remnantCleanToast": "未发现明文残留（同目录备份 / WPS 自动备份 / Office 自动恢复均无匹配）",
  "remnantFoundWarningToast": "发现 {{count}} 个与源文件相关的明文残留，请在下方确认清理",
  "noRemnantSelectedInfo": "没有勾选任何文件",
  "cleaningRemnantsLabel": "清理残留",
  "remnantCleanupFailedToast": "清理失败：{{error}}",
  "remnantCleanupSuccessToast": "已安全删除 {{count}} 个残留文件（覆写后删除）",
  "remnantCleanupPartialToast": "已删除 {{deleted}} 个，{{failed}} 个失败",
  "selectFilesToEncryptTitle": "选择要加密的文件（可多选）",
  "saveEncryptedAsTitle": "保存加密文件为",
  "selectEncryptOutputDirTitle": "选择加密文件的保存目录",
  "selectFilesToDecryptTitle": "选择要解密的文件（可多选）",
  "allFilesFilter": "所有文件",
  "decryptFailedNoValidFilesToast": "解密失败：选中的 {{count}} 个文件都不是有效的加密文件",
  "saveDecryptedAsTitle": "解密后保存为",
  "selectDecryptOutputDirTitle": "选择解密后的保存目录",
  "selectFilesToScanTitle": "选择要检查残留的加密文件（可多选）",
  "filesUnreadableToast": "{{count}} 个文件无法读取",
  "batchCompleteToast": "{{label}}完成：{{count}} 个文件",
  "batchPartialCompleteToast": "{{label}}完成 {{success}}/{{total}}，{{failed}} 个失败",
  "openFolderAction": "打开所在文件夹",
  "encryptLabel": "加密",
  "decryptLabel": "解密",
  "batchProgressLabel": "{{label}}中...（{{current}}/{{total}}）{{fileName}}",
  "batchProgressChunks": " — {{done}}/{{total}} 分块",
  "remnantsFoundTitle": "发现可能的明文残留（{{count}} 个）",
  "remnantsExplanation": "这些文件可能是明文副本——即使原文件已加密并安全删除，通过它们仍能恢复出内容（WPS 的“文档修复/深度检索”实际做的就是在全盘找同名副本和自动备份，而不是解析加密文件本身）。源文件目录/编辑器备份里与源文件相关的项已默认勾选；",
  "remnantsSameNameWarning": "“磁盘同名副本”不会默认勾选",
  "remnantsExplanationTail": "——其中可能有你想保留的正式原件，删除前请逐一确认；确认要保护的内容不留明文，就把它们也勾上。",
  "remnantCategorySameDir": "源文件目录残留",
  "remnantCategoryWpsBackup": "WPS 自动备份",
  "remnantCategoryOfficeAutorecover": "Office 自动恢复",
  "remnantCategorySameNameDisk": "磁盘同名副本",
  "remnantMatchedSuffix": "，与源文件相关",
  "secureDeleteSelectedButton": "安全删除所选（{{count}} 个）",
  "ignoreButton": "忽略"
}
```

- [ ] **Step 2: 翻译成其余 5 语言**（占位符：`{{error}}`/`{{count}}`/`{{deleted}}`/`{{failed}}`/`{{label}}`/`{{success}}`/`{{total}}`/`{{current}}`/`{{fileName}}`/`{{done}}`，翻译时保持每个 key 里出现的占位符名字和 zh 版本完全一致）

- [ ] **Step 3: 接入 `i18n/index.ts`**

- [ ] **Step 4: 改 `FilesPane.tsx`**

`REMNANT_CATEGORY_LABELS` 这个模块级常量同 Task 18 的 `STEP_TITLES` 一样，要挪进组件内部（依赖 `t()`）：

```typescript
// 原（模块级）
const REMNANT_CATEGORY_LABELS: Record<RemnantCategory, string> = {
  same_dir: '源文件目录残留',
  wps_backup: 'WPS 自动备份',
  office_autorecover: 'Office 自动恢复',
  same_name_disk: '磁盘同名副本',
}

// 改为：组件内部
const { t } = useTranslation('files')
const REMNANT_CATEGORY_LABELS: Record<RemnantCategory, string> = {
  same_dir: t('remnantCategorySameDir'),
  wps_backup: t('remnantCategoryWpsBackup'),
  office_autorecover: t('remnantCategoryOfficeAutorecover'),
  same_name_disk: t('remnantCategorySameNameDisk'),
}
```

`CIPHER_OPTIONS` 常量同理挪进组件内部，`hint` 字段换成 `t('cipherHintAes256')` 等。

逐个函数替换要点：
- `scanRemnants`：`toast.error(\`残留扫描失败：${res.error}\`)` → `toast.error(t('remnantScanFailedToast', { error: translateError(res.error, res.error_params) }))`；`toast.success('未发现...')` → `toast.success(t('remnantCleanToast'))`；`toast.warning(\`发现 ${matchedCount} 个...\`)` → `toast.warning(t('remnantFoundWarningToast', { count: matchedCount }))`
- `handleSecureDeleteRemnants`：`toast.info('没有勾选任何文件')` → `t('noRemnantSelectedInfo')`；`setBusyLabel('清理残留')` → `setBusyLabel(t('cleaningRemnantsLabel'))`；清理失败/成功/部分失败三处 toast 同上模式，注意 `description: failed.map((f) => \`${basename(f.path)}：${f.error}\`).join('\n')` 这行里的 `f.error` 也是后端错误码（`secure_delete_paths` 的 `results[].error`），要过一次 `translateError(f.error, f.error_params)`（记得 `RemnantItem`/`results` 类型要能取到 `error_params`，Task 12 已经在 `ipcTypes.ts` 里加过）
- `runBatch`：`label` 参数目前传的是中文字面量 `'加密'`/`'解密'`（调用处 `handleEncrypt`/`handleDecrypt` 传入），改成传 `t('encryptLabel')`/`t('decryptLabel')`；两处 `toast.success`/`toast.error` 用 `batchCompleteToast`/`batchPartialCompleteToast`，`description` 里 `failed.map((f) => \`${f.fileName}：${f.error}\`)` 同样要过 `translateError`
- `handleEncrypt`/`handleDecrypt`/`handleScanRemnants`：`electronApi.openFiles({ title: '选择...' })` 等 Electron 原生对话框的 `title`/`filters` 字段也要翻译（这些是 OS 对话框标题，虽然对话框本身其他部分跟随系统语言，但 `title` 字符串是应用自己传的，能翻译）；`filters` 里的 `{ name: '所有文件', extensions: ['*'] }` 用 `t('allFilesFilter')`
- 顶层 JSX 里所有按钮文字、`Label`、进度提示、残留列表说明文字逐一替换

- [ ] **Step 5: 一致性检查 + 编译**

Run: `cd modules/file_vault/ui && node scripts/check-i18n-keys.mjs && npx tsc --noEmit`

- [ ] **Step 6: 手动验证（这个组件功能最多，验证也最花时间，但不能跳过）**

Run: `python -X utf8 scripts/run.py run file_vault`

依次做：加密单个文件、加密多个文件、解密、扫描残留、故意选一个非法文件触发"不是有效的加密文件"错误提示——每一步切换到至少 2 种非中文语言观察文案和插值是否正确（重点看有没有出现 `{{xxx}}` 字面量，那说明占位符名字打错了）。

- [ ] **Step 7: 提交**

```bash
git add modules/file_vault/ui/src/i18n/ modules/file_vault/ui/src/components/FilesPane.tsx
git commit -m "feat(file_vault-ui): translate encrypt/decrypt screen into 6 languages"
```

---

## Task 22: `tasks` 命名空间 — `TaskListScreen.tsx` + `TaskDetailScreen.tsx`

**Files:**
- Create: `modules/file_vault/ui/src/i18n/locales/{zh,en,fr,es,ru,ar}/tasks.json`
- Modify: `modules/file_vault/ui/src/i18n/index.ts`
- Modify: `modules/file_vault/ui/src/components/TaskListScreen.tsx`
- Modify: `modules/file_vault/ui/src/components/TaskDetailScreen.tsx`

- [ ] **Step 1: `zh/tasks.json`**

```json
{
  "listPageTitle": "自动任务",
  "createButton": "新建任务",
  "emptyList": "还没有任务",
  "statusLaunched": "已在终端启动",
  "statusPendingReview": "待审阅",
  "statusMerged": "已合并",
  "statusDiscarded": "已丢弃",
  "createDialogTitle": "新建任务",
  "targetDirLabel": "目标目录",
  "selectDirPlaceholder": "点击右侧选择",
  "selectButton": "选择...",
  "selectTargetDirTitle": "选择目标项目目录",
  "descriptionLabel": "任务描述",
  "autonomyModeLabel": "自主执行边界",
  "autonomyIsolated": "隔离全自动",
  "autonomyDirect": "原目录全自动",
  "autonomyGraded": "分级自动",
  "engineLabel": "执行引擎",
  "engineCli": "CLI（弹出终端）",
  "engineVscode": "VS Code（手动接管）",
  "modelLabel": "模型",
  "modelAuto": "自动（由 Claude Code 判断）",
  "effortLabel": "推理强度",
  "effortAuto": "自动（由 Claude Code 判断）",
  "detectedModelPrefix": "本机当前默认：{{model}}",
  "targetDirAndDescRequired": "目标目录和任务描述不能为空",
  "vscodeOpenFailedFallback": "打开 VS Code 失败",
  "vscodeOpenedToast": "已打开 VS Code，任务描述已复制到剪贴板，可以直接粘贴给 Claude Code",
  "gitInitializedToast": "目标目录还不是 git 仓库，已自动初始化并创建了一个初始提交",
  "taskCreatedToast": "已弹出终端窗口运行 Claude Code，请在该窗口中查看进度，可随时手动 Ctrl+C 停止",
  "createDialogSubmit": "创建",
  "vscodeWorkingDirNote": "你现在的工作目录是：{{targetDir}}。开始之前请先确认这就是你应该操作的目录，再执行下面的任务。",
  "vscodeQuotaNote": "如果在执行过程中发现 Claude 使用额度即将耗尽或已经耗尽：不要直接报错退出。优先使用 /schedule（云端 Routine，不依赖本地进程/这个 VS Code 窗口存活）为自己安排一次性的定时任务，在额度重置的时间点自动继续；安排时请写清楚当前工作目录（{{targetDir}}）和已完成的进度，确保恢复时先确认工作目录再继续未完成的工作。/loop 只在这个会话和 VS Code 窗口一直不关的前提下才可能生效，不如 /schedule 稳妥。",
  "detailStatusLine": "状态：{{status}}",
  "detailLaunchedExplanation": "已在弹出的终端窗口中启动。Claude 自己判断任务完成后会自动标记，这里每隔几秒会自动检查一次；你也可以随时手动 Ctrl+C 停止，或者不等自动检测，直接点下面按钮查看差异并合并/丢弃。",
  "checkDiffButton": "查看当前差异",
  "mergeButton": "合并到主分支",
  "discardButton": "丢弃",
  "doneSummaryPrefix": "Claude 的完成总结：{{summary}}",
  "continueExplanation": "不满足要求？填写后点\"继续\"，会带着之前的对话上下文在同一个目录里弹出新的终端窗口继续执行，不用你自己去终端里重新说明背景。默认接着最近一次对话；如果这个目录里有多次对话（比如你自己也直接用过 claude），点\"选择会话\"可以在弹出的终端里自己挑——但这种情况下上面填的内容不会自动发送，选完会话后要自己在终端里说想要什么。",
  "feedbackPlaceholder": "比如：颜色不对，改成蓝色",
  "continueButton": "继续",
  "pickSessionButton": "选择会话...",
  "mergeFailedToast": "合并失败",
  "mergedToast": "已合并",
  "discardFailedToast": "丢弃失败",
  "discardedToast": "已丢弃",
  "continueFailedToast": "继续失败",
  "continuedPickSessionToast": "已弹出终端窗口，选好会话后请直接在那个窗口里输入你的要求",
  "continuedToast": "已弹出终端窗口继续执行，Claude 会带着之前的上下文接着做"
}
```

- [ ] **Step 2: 翻译成其余 5 语言**

`vscodeQuotaNote` 这段很长，注意里面提到的 `/schedule`、`/loop` 是产品内的斜杠命令名，翻译时保留原样不翻译（专有名词）；`Ctrl+C` 同理不翻译。

- [ ] **Step 3: 接入 `i18n/index.ts`**

- [ ] **Step 4: 改 `TaskListScreen.tsx`**

`STATUS_LABEL` 常量挪进组件内部（同 Task 21 `REMNANT_CATEGORY_LABELS` 的模式）。

`CreateTaskDialog` 里注意几处：
- `openRes.error ?? '打开 VS Code 失败'`（line 147）——**这个 `openRes.error` 来自 Electron `main.ts` 的 `shell:openInVSCode`（Task 9 已经改成错误码 `shell.vscode_not_found`），不是 Python 后端**，同样要用 `translateError`：
  ```typescript
  const openRes = await electronApi.openInVSCode(targetDir)
  if (!openRes.ok) {
    setError(openRes.error ? translateError(openRes.error) : t('vscodeOpenFailedFallback'))
    return
  }
  ```
  （`shell.vscode_not_found` 这个 code 存在于 `errors.json` 命名空间里，Task 14 已经建好，这里直接复用 `translateError`，不需要额外传 `error_params`，因为 `main.ts` 那边没有携带 params。）
- `handleCreate` 里 `augmentedDescription` 拼接的长字符串（line 132-139）用 `t('vscodeWorkingDirNote', { targetDir })` + `t('vscodeQuotaNote', { targetDir })` 拼起来
- `res.error`（line 167，来自 `task_create`）用 `translateError(res.error, res.error_params)`
- 其余按钮/标签逐一替换

- [ ] **Step 5: 改 `TaskDetailScreen.tsx`**

`merge`/`discard`/`continueTask` 三个函数里的 `toast.error('合并失败', { description: res.error })` 等，`description` 部分要用 `translateError(res.error, res.error_params)`。

- [ ] **Step 6: 一致性检查 + 编译**

Run: `cd modules/file_vault/ui && node scripts/check-i18n-keys.mjs && npx tsc --noEmit`

- [ ] **Step 7: 手动验证**

新建一个任务（CLI 引擎和 VS Code 引擎各试一次，VS Code 引擎需要本机确实装了 `code` 命令，如果没装也没关系，正好可以验证 `shell.vscode_not_found` 这条错误路径的翻译）、切换语言观察状态标签和弹窗文案。

- [ ] **Step 8: 提交**

```bash
git add modules/file_vault/ui/src/i18n/ modules/file_vault/ui/src/components/TaskListScreen.tsx modules/file_vault/ui/src/components/TaskDetailScreen.tsx
git commit -m "feat(file_vault-ui): translate automated tasks screens into 6 languages"
```

---

## Task 23: 收尾——全量验证 + README 已知限制说明

**Files:**
- Modify: `modules/file_vault/README.md`

- [ ] **Step 1: 全量一致性检查**

Run: `cd modules/file_vault/ui && node scripts/check-i18n-keys.mjs`
Expected: 通过，此时应该是全部 8 个命名空间、6 种语言

- [ ] **Step 2: 全量 grep 检查有没有漏翻的硬编码中文**

Run: `cd modules/file_vault/ui/src/components && grep -lP '[\x{4e00}-\x{9fff}]' *.tsx`

Expected: 理想情况下这条命令应该没有输出（所有组件里的中文都已经提到 JSON 里）。如果有输出，逐个文件检查是不是漏改的 UI 文案（有些是代码注释里的中文，那种不用改，用 `grep -n` 加行号确认具体是注释还是 JSX 文本）。

- [ ] **Step 3: 完整 TypeScript 编译检查**

Run: `cd modules/file_vault/ui && npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 4: 完整 Python 测试套件**

Run: `python -X utf8 -m pytest modules/file_vault/tests/ -v`
Expected: 全部 PASS

- [ ] **Step 5: 手动走一遍 `/verify`，覆盖设计文档"测试策略"一节列的场景**

Run: `python -X utf8 scripts/run.py run file_vault`

依次验证：
- 首次启动（没有身份数据时）默认语言是不是等于当前操作系统语言（如果测试机是中文 Windows，默认应该是简体中文；可以临时改一下 Windows 语言设置或者直接手动验证 `app.getLocale()` 的返回值来交叉核对，不强求真的切系统语言这么重）
- 切换到 6 种语言各看一遍主要屏幕（登录、设置向导、文件加密解密、密码管理、自动任务、设置页），确认没有残留中文、没有裸露的错误码字符串（例如看到 `auth.wrong_password` 这种没被翻译的原始 code，说明 `translateError` 某处没接上）
- 阿拉伯语下确认整体布局镜像正常，没有明显错位
- 关闭应用重开，确认上次选的语言被记住（localStorage 生效）
- 故意触发几种错误场景（错误密码、断网发邮箱验证码、选一个非加密文件解密）确认错误提示是翻译后的文本，不是中文也不是裸 code

- [ ] **Step 6: `README.md` 补充已知限制说明**

在 `modules/file_vault/README.md` 合适位置（现有条目风格，看当前文件用的 `##`/`###` 结构，加一节）新增：

```markdown
### 多语言支持

界面支持切换语言（联合国 6 种官方语言：中文/英语/法语/西班牙语/俄语/阿拉伯语），默认跟随操作系统语言，可在任意屏幕右上角手动切换，选择会记住。已知限制：

- git 相关错误信息（如合并冲突时的 `stderr` 原文）、未预期的内部错误详情不翻译，原样展示英文/原始文本。
- 阿拉伯语只做整体从右到左的方向切换，没有逐组件做像素级的 RTL 布局微调。
- 有一部分不常触发的后端调用（详见规格文档 `docs/superpowers/specs/2026-07-10-i18n-language-switch-design.md` 的"已知限制"一节）在失败时界面不会有任何提示，只有开发者控制台可见——这是改动之前就存在的行为，这次多语言支持没有修复它。
```

- [ ] **Step 7: 提交**

```bash
git add modules/file_vault/README.md
git commit -m "docs(file_vault): document multi-language support and known limitations"
```

---

## 完成标准

- [ ] `python -X utf8 -m pytest modules/file_vault/tests/ -v` 全绿
- [ ] `cd modules/file_vault/ui && npx tsc --noEmit` 无错误
- [ ] `node scripts/check-i18n-keys.mjs` 通过
- [ ] `grep -lP '[\x{4e00}-\x{9fff}]' modules/file_vault/ui/src/components/*.tsx` 无 UI 文案残留（注释除外）
- [ ] 手动跑通 6 种语言下的登录、设置向导、加密解密、密码管理、自动任务、设置页，无裸错误码、无残留中文、阿拉伯语 RTL 镜像正常
- [ ] 语言选择重启后保持
