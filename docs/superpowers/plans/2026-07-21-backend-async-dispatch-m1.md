# Backend 异步调度 M1：指纹类 RPC 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `unlock_fingerprint`/`rebind_fingerprint`/`setup_verify_fingerprint` 三个 RPC 在真实 Windows Hello 硬件验证期间（最长可达 120 秒）不再阻塞后端进程处理其它任何请求，并保证同一时刻只允许一次硬件交互。

**Architecture:** 复用已经落地的 `batch_engine.submit_batch_task`/`ASYNC_DEFERRED` 机制（`dispatch()`/`serve()` 的哨兵识别已经在 commit `efcc60f` 完成，本计划不需要重新实现）：三个 handler 的签名从 `(params)` 改成 `(params, request_id)`，注册表从 `_METHODS` 挪到 `_METHODS_WITH_PROGRESS`，只把真正触碰硬件的那一小段包进 `submit_batch_task` 的线程闭包；已有的同步早退检查（"未绑定"/"需要先解锁"等）保持同步不变。新增一把 `fingerprint.py` 内的 `threading.Lock`，同一时刻只允许一次硬件验证在途，第二次尝试立即收到明确错误，不排队等待。

**Tech Stack:** Python 3.9 stdlib（`threading`），沿用现有 NDJSON stdin/stdout RPC 协议、现有 `_error_result`/`errors.VaultError` 错误约定。

**Spec 依据：** [docs/superpowers/specs/2026-07-20-backend-async-dispatch-design.md](../specs/2026-07-20-backend-async-dispatch-design.md) 第 2.2（M1 三个 RPC）、3.1、3.2、3.4 节。

**与 spec 的一处范围调整（在规划阶段发现，未回头改 spec，直接记在这里）：** spec 把 `ProgressPayload.id` 的前端改造也划进了 M1。实际规划后发现这块对指纹场景并不成立——三个指纹 RPC 本身不会调用 `_throttled_progress` 上报中间进度（硬件验证是"等结果"而不是"有百分比"），而且本计划新增的单飞锁从根上就不允许同一方法出现两个并发的在途请求。`ProgressPayload.id` 真正需要的场景是 M2 的 `encrypt_file`（用户确实可能连续对两个不同文件发起加密，两者都会上报真实的分块进度）——那里才是这块改造真正必要、也真正能被验证的地方。本计划因此只做指纹三个 RPC + 锁，`ProgressPayload.id` 移到 M2 的计划里处理。

---

## Task 1: 指纹验证单飞锁原语

**Files:**
- Modify: `modules/file_vault/fingerprint.py`（顶部 import 区 + 新增两个函数）
- Test: `modules/file_vault/tests/test_fingerprint.py`

`fingerprint.py` 目前没有 `threading` import（已核实：只有 `asyncio`/`os`/`secrets`/`subprocess`）。`test_fingerprint.py` 是纯进程内单元测试（直接 `import fingerprint`，不像 `test_backend_server.py` 那样起子进程），本任务的锁是纯 Python 逻辑，不涉及真实硬件，适合放在这里、用真正的 `threading.Lock`（不需要 mock）直接测试。

- [x] **Step 1: 写失败测试**

在 `modules/file_vault/tests/test_fingerprint.py` 末尾追加：

```python
def test_acquire_verification_slot_rejects_concurrent_second_attempt():
    assert fingerprint.acquire_verification_slot() is True
    try:
        assert fingerprint.acquire_verification_slot() is False
    finally:
        fingerprint.release_verification_slot()


def test_acquire_verification_slot_available_again_after_release():
    assert fingerprint.acquire_verification_slot() is True
    fingerprint.release_verification_slot()
    try:
        assert fingerprint.acquire_verification_slot() is True
    finally:
        fingerprint.release_verification_slot()
```

- [x] **Step 2: 运行测试确认失败**

Run: `python -X utf8 -m pytest modules/file_vault/tests/test_fingerprint.py -v -k acquire_verification_slot`
Expected: FAIL（`AttributeError: module 'modules.file_vault.fingerprint' has no attribute 'acquire_verification_slot'`）

- [x] **Step 3: 实现**

在 `fingerprint.py` 顶部 import 区加入 `import threading`（与现有 `import asyncio`/`import os` 等并列）。在文件里模块级别（建议紧挨着 `FingerprintUnavailableError` 类定义之后）新增：

```python
_verification_lock = threading.Lock()


def acquire_verification_slot() -> bool:
    """非阻塞：True 表示调用方现在可以发起一次真实的硬件验证；False 表示
    已经有另一次验证在途。Windows Hello 底层（以及 winrt 回退路径的
    COM/STA 限制）不适合真正并发跑两次验证，所以这里不排队等待，直接
    让第二个请求立刻知道"现在不行"。调用方必须保证无论验证成功、失败
    还是抛异常，都会在 finally 块里调用 release_verification_slot()。
    """
    return _verification_lock.acquire(blocking=False)


def release_verification_slot() -> None:
    _verification_lock.release()
```

- [x] **Step 4: 运行测试确认通过**

Run: `python -X utf8 -m pytest modules/file_vault/tests/test_fingerprint.py -v`
Expected: 全部 PASS（含新增的 2 项，以及本文件其它已有测试不受影响）

- [x] **Step 5: 提交**

```bash
git add modules/file_vault/fingerprint.py modules/file_vault/tests/test_fingerprint.py
git commit -m "feat(file_vault): add fingerprint verification single-flight lock"
```

---

## Task 2: 新增 i18n 错误文案（6 语言）

**Files:**
- Modify: `modules/file_vault/ui/src/i18n/locales/{en,zh,ar,es,fr,ru}/errors.json`

六个文件里 `auth.fingerprint_verification_failed` 都在第 29 行（已核实）。在它后面加一行新 key `auth.fingerprint_verification_in_progress`，与相邻 fingerprint 系列 key 保持同样的分组位置。

- [x] **Step 1: 依次编辑六个文件**

`en/errors.json`（第 29 行后）：
```json
  "auth.fingerprint_verification_failed": "Fingerprint verification failed",
  "auth.fingerprint_verification_in_progress": "A fingerprint verification is already in progress",
```

`zh/errors.json`：
```json
  "auth.fingerprint_verification_failed": "指纹验证未通过",
  "auth.fingerprint_verification_in_progress": "指纹验证正在进行中，请稍候",
```

`fr/errors.json`：
```json
  "auth.fingerprint_verification_failed": "Échec de la vérification de l'empreinte digitale",
  "auth.fingerprint_verification_in_progress": "Une vérification de l'empreinte digitale est déjà en cours",
```

`ar/errors.json`：
```json
  "auth.fingerprint_verification_failed": "فشل التحقق من البصمة",
  "auth.fingerprint_verification_in_progress": "التحقق من البصمة قيد التنفيذ بالفعل",
```

`ru/errors.json`：
```json
  "auth.fingerprint_verification_failed": "Проверка отпечатка пальца не пройдена",
  "auth.fingerprint_verification_in_progress": "Проверка отпечатка пальца уже выполняется",
```

`es/errors.json`：
```json
  "auth.fingerprint_verification_failed": "Error en la verificación de huella dactilar",
  "auth.fingerprint_verification_in_progress": "Ya hay una verificación de huella dactilar en curso",
```

- [x] **Step 2: 校验 JSON 合法性 + i18n key 一致性检查**

Run: `node modules/file_vault/ui/scripts/check-i18n-keys.mjs`
Expected: 退出码 0，不出现关于 `errors` namespace 缺失/多余 key 的报告（项目已知的 `ai` namespace 历史遗留问题不算新增回归，忽略即可，任务进度文档里已经反复确认过这一点）

- [x] **Step 3: 提交**

```bash
git add modules/file_vault/ui/src/i18n/locales/en/errors.json modules/file_vault/ui/src/i18n/locales/zh/errors.json modules/file_vault/ui/src/i18n/locales/fr/errors.json modules/file_vault/ui/src/i18n/locales/ar/errors.json modules/file_vault/ui/src/i18n/locales/ru/errors.json modules/file_vault/ui/src/i18n/locales/es/errors.json
git commit -m "i18n(file_vault): add fingerprint_verification_in_progress error string"
```

---

## Task 3: 迁移 `rpc_unlock_fingerprint` 为异步 + 单飞锁

**Files:**
- Modify: `modules/file_vault/backend_server.py`（handler 本体约在 334-358 行，`_METHODS`/`_METHODS_WITH_PROGRESS` 注册表约在 2334/2468 行——这个分支有并发提交在陆续落地，行号仅供参考，实施前先用 `grep -n "def rpc_unlock_fingerprint"` 和 `grep -n "unlock_fingerprint"` 核对当前真实行号）

当前完整实现（已核实）：

```python
def rpc_unlock_fingerprint(params):
    global _imk
    store = _require_store()
    if store.slots.get(identity.SLOT_FINGERPRINT) is None:
        return {"ok": False, "error": "auth.fingerprint_not_bound"}
    # Checked before ever prompting: a stale slot from before this feature
    # existed (bio_secret never written to keyring) would otherwise send
    # the user through a real Windows Hello touch only to find out
    # afterward it was never going to work - catch that case up front with
    # a message that tells them what to actually do about it.
    if not identity.fingerprint_binding_is_usable(store):
        return {"ok": False, "error": "auth.fingerprint_binding_stale"}
    hwnd = params.get("hwnd", 0) or 0
    try:
        imk = identity.try_unlock_via_fingerprint(store, hwnd)
    except fingerprint.FingerprintUnavailableError as exc:
        return _error_result(exc)
    if imk is None:
        return {"ok": False, "error": "auth.fingerprint_verification_failed"}
    _imk = imk
    _start_clipboard_service()
    _start_notes_service()
    _start_ai_history_service()
    _start_network_speedtest_history_service()
    return {"ok": True}
```

现有回归测试（不能破坏）：`test_unlock_fingerprint_reports_not_bound_when_no_fingerprint_slot`（`modules/file_vault/tests/test_backend_server.py:225`）。

- [x] **Step 1: 确认现有回归测试当前通过（改动前的基线）**

Run: `python -X utf8 -m pytest modules/file_vault/tests/test_backend_server.py -v -k unlock_fingerprint`
Expected: PASS（改动前的基线，确认没有已存在的失败掩盖了后续判断）

- [x] **Step 2: 修改 handler——早退检查保持同步，硬件调用包进 submit_batch_task**

把上面的实现替换为：

```python
def rpc_unlock_fingerprint(params, request_id):
    store = _require_store()
    if store.slots.get(identity.SLOT_FINGERPRINT) is None:
        return {"ok": False, "error": "auth.fingerprint_not_bound"}
    # Checked before ever prompting: a stale slot from before this feature
    # existed (bio_secret never written to keyring) would otherwise send
    # the user through a real Windows Hello touch only to find out
    # afterward it was never going to work - catch that case up front with
    # a message that tells them what to actually do about it.
    if not identity.fingerprint_binding_is_usable(store):
        return {"ok": False, "error": "auth.fingerprint_binding_stale"}
    if not fingerprint.acquire_verification_slot():
        return {"ok": False, "error": "auth.fingerprint_verification_in_progress"}
    hwnd = params.get("hwnd", 0) or 0

    def fn():
        global _imk
        try:
            imk = identity.try_unlock_via_fingerprint(store, hwnd)
        except fingerprint.FingerprintUnavailableError as exc:
            return _error_result(exc)
        finally:
            fingerprint.release_verification_slot()
        if imk is None:
            return {"ok": False, "error": "auth.fingerprint_verification_failed"}
        _imk = imk
        _start_clipboard_service()
        _start_notes_service()
        _start_ai_history_service()
        _start_network_speedtest_history_service()
        return {"ok": True}

    return batch_engine.submit_batch_task(request_id, fn, _write)
```

要点：`_require_store()`、slot 绑定检查、binding-usable 检查都是快速的内存/磁盘读取，不触碰硬件，保持在 `submit_batch_task` 之外同步执行——这样"未绑定"这类场景的返回速度和错误语义完全不变。只有 `identity.try_unlock_via_fingerprint(...)`（真正调起 Windows Hello）被移进后台线程；`finally` 保证无论成功/失败/异常，锁都会被释放，不会永久卡死后续尝试。

- [x] **Step 3: 把注册表条目从 `_METHODS` 挪到 `_METHODS_WITH_PROGRESS`**

在 `_METHODS = {...}` 字典字面量里删掉这一行：
```python
    "unlock_fingerprint": rpc_unlock_fingerprint,
```
在 `_METHODS_WITH_PROGRESS = {...}` 字典字面量里加入同样的一行（`_METHODS_WITH_PROGRESS` 里其它条目都是这个写法，风格保持一致）：
```python
    "unlock_fingerprint": rpc_unlock_fingerprint,
```

- [x] **Step 4: 运行回归测试确认没有破坏**

Run: `python -X utf8 -m pytest modules/file_vault/tests/test_backend_server.py -v -k unlock_fingerprint`
Expected: PASS（`test_unlock_fingerprint_reports_not_bound_when_no_fingerprint_slot` 依然通过——这个场景在早退检查阶段就返回，从未进入 `submit_batch_task`，所以行为应该跟改动前完全一致）

- [x] **Step 5: 运行完整后端测试套件确认无回归**

Run: `python -X utf8 -m pytest modules/file_vault/tests/ -q`
Expected: 全部 PASS，不比改动前少任何一项

- [x] **Step 6: 提交**

```bash
git add modules/file_vault/backend_server.py
git commit -m "feat(file_vault): make unlock_fingerprint async with single-flight lock"
```

---

## Task 4: 迁移 `rpc_rebind_fingerprint` 为异步 + 单飞锁

**Files:**
- Modify: `modules/file_vault/backend_server.py`（handler 本体约在 440-448 行，实施前同 Task 3 先核对真实行号）

当前完整实现（已核实）：

```python
def rpc_rebind_fingerprint(params):
    store = _require_store()
    imk = _require_imk()
    hwnd = params.get("hwnd", 0) or 0
    try:
        identity.rewrap_fingerprint(_data_dir, store, imk, hwnd)
    except (fingerprint.FingerprintUnavailableError, identity.UnlockError) as exc:
        return _error_result(exc)
    return {"ok": True}
```

现有回归测试（不能破坏）：`test_rebind_fingerprint_requires_unlock`（`modules/file_vault/tests/test_backend_server.py:244`）。

- [x] **Step 1: 确认现有回归测试当前通过**

Run: `python -X utf8 -m pytest modules/file_vault/tests/test_backend_server.py -v -k rebind_fingerprint`
Expected: PASS

- [x] **Step 2: 修改 handler**

```python
def rpc_rebind_fingerprint(params, request_id):
    store = _require_store()
    imk = _require_imk()
    if not fingerprint.acquire_verification_slot():
        return {"ok": False, "error": "auth.fingerprint_verification_in_progress"}
    hwnd = params.get("hwnd", 0) or 0

    def fn():
        try:
            identity.rewrap_fingerprint(_data_dir, store, imk, hwnd)
        except (fingerprint.FingerprintUnavailableError, identity.UnlockError) as exc:
            return _error_result(exc)
        finally:
            fingerprint.release_verification_slot()
        return {"ok": True}

    return batch_engine.submit_batch_task(request_id, fn, _write)
```

`_require_store()`/`_require_imk()`（"没有身份"/"没解锁"）保持同步——`test_rebind_fingerprint_requires_unlock` 验证的正是 `_require_imk()` 抛出 `VaultError` 这条路径，这条路径完全没进入 `submit_batch_task`，行为不变。

- [x] **Step 3: 注册表迁移**

`_METHODS` 里删除：
```python
    "rebind_fingerprint": rpc_rebind_fingerprint,
```
`_METHODS_WITH_PROGRESS` 里加入同样一行。

- [x] **Step 4: 运行回归测试确认没有破坏**

Run: `python -X utf8 -m pytest modules/file_vault/tests/test_backend_server.py -v -k rebind_fingerprint`
Expected: PASS

- [x] **Step 5: 运行完整后端测试套件确认无回归**

Run: `python -X utf8 -m pytest modules/file_vault/tests/ -q`
Expected: 全部 PASS

- [x] **Step 6: 提交**

```bash
git add modules/file_vault/backend_server.py
git commit -m "feat(file_vault): make rebind_fingerprint async with single-flight lock"
```

---

## Task 5: 迁移 `rpc_setup_verify_fingerprint` 为异步 + 单飞锁

**Files:**
- Modify: `modules/file_vault/backend_server.py`（handler 本体约在 211-222 行，实施前同前面两个任务先核对真实行号）

当前完整实现（已核实）：

```python
def rpc_setup_verify_fingerprint(params):
    """Local check during the setup wizard, mirrors rpc_setup_verify_totp's
    'confirm it works, don't persist anything yet' semantics - the actual
    bio_secret only gets generated inside setup_identity() when
    setup_complete is called with enable_fingerprint=True."""
    hwnd = params.get("hwnd", 0) or 0
    try:
        if hwnd:
            return {"ok": fingerprint.request_verification_for_window(hwnd)}
        return {"ok": fingerprint.request_verification()}
    except fingerprint.FingerprintUnavailableError as exc:
        return _error_result(exc)
```

这个 RPC 没有专门的现有自动化测试（它的两条真实分支都需要真实硬件），本任务不需要在 Step 1 先跑一个"改动前基线"——直接确认完整测试套件当前是绿的即可，作为改动前后对比的基准。

- [x] **Step 1: 确认完整测试套件当前是绿的（改动前基线）**

Run: `python -X utf8 -m pytest modules/file_vault/tests/ -q`
Expected: 全部 PASS

- [x] **Step 2: 修改 handler**

```python
def rpc_setup_verify_fingerprint(params, request_id):
    """Local check during the setup wizard, mirrors rpc_setup_verify_totp's
    'confirm it works, don't persist anything yet' semantics - the actual
    bio_secret only gets generated inside setup_identity() when
    setup_complete is called with enable_fingerprint=True."""
    if not fingerprint.acquire_verification_slot():
        return {"ok": False, "error": "auth.fingerprint_verification_in_progress"}
    hwnd = params.get("hwnd", 0) or 0

    def fn():
        try:
            if hwnd:
                result = {"ok": fingerprint.request_verification_for_window(hwnd)}
            else:
                result = {"ok": fingerprint.request_verification()}
        except fingerprint.FingerprintUnavailableError as exc:
            return _error_result(exc)
        finally:
            fingerprint.release_verification_slot()
        return result

    return batch_engine.submit_batch_task(request_id, fn, _write)
```

- [x] **Step 3: 注册表迁移**

`_METHODS` 里删除：
```python
    "setup_verify_fingerprint": rpc_setup_verify_fingerprint,
```
`_METHODS_WITH_PROGRESS` 里加入同样一行。

- [x] **Step 4: 运行完整测试套件确认无回归**

Run: `python -X utf8 -m pytest modules/file_vault/tests/ -q`
Expected: 全部 PASS，数量与 Step 1 的基线一致

- [x] **Step 5: 提交**

```bash
git add modules/file_vault/backend_server.py
git commit -m "feat(file_vault): make setup_verify_fingerprint async with single-flight lock"
```

---

## Task 6: 整体验证与人工验收

**Files:** 无代码改动，仅验证。

三个 handler 的"硬件验证期间不阻塞其它请求"和"连续两次验证第二次立即拒绝"这两条核心行为，都依赖真实 Windows Hello 硬件——这台开发机上此前反复确认过没有交互式桌面会话/真实硬件可用（`task-progress-clipboard.md` 等文档已多次如实说明这个限制），无法自动化验证，必须由你在真实机器上手动确认。

- [x] **Step 1: 自动化回归**

Run: `python -X utf8 -m pytest modules/file_vault/tests/ -q`
Expected: 全部 PASS

Run: `cd modules/file_vault/ui && npx tsc --noEmit && npm run lint`
Expected: 两条都是 0 错误退出码 0（本次改动不涉及前端文件，这一步主要是确认没有意外触碰到什么）

- [x] **Step 2: 重新构建，确认快捷方式/注册表指向的可执行文件已更新**

Run: `cd modules/file_vault/ui && npm run build`
Expected: 退出码 0；构建产物时间戳晚于本计划开始的时间，且开始菜单快捷方式/`HKCU\...\Run\electron.app.Electron` 指向的 exe 与新构建的产物一致（参照本仓库其它任务进度文档里"确认可执行文件已更新"的验收方式）

- [ ] **Step 3: 人工验收清单（需要你亲自在真实机器上确认）**

1. 正常触发一次指纹解锁：验证过程中（Windows Hello 提示框出现、手指按下之前的这几秒到十几秒）切换到笔记/剪贴板等其它页面，确认可以正常操作、不卡顿、不需要等验证结束。
2. 触发一次指纹解锁后，在验证提示框还开着的时候，想办法快速再触发一次（比如再点一下"用指纹解锁"按钮，如果按钮此时还可点的话）：确认第二次立即（不是等到第一次结束才）收到"指纹验证正在进行中"的提示，界面不卡死、不崩溃。
3. 正常完成一次指纹验证（无论成功还是取消/失败），之后再次尝试指纹验证：确认锁被正确释放，不会永久卡在"验证进行中"的状态。
4. 指纹重新绑定（Settings 页）、以及设置向导里的指纹验证步骤，分别重复上面 1-3 的验证。

- [ ] **Step 4: 记录验收结果**

如果全部通过，视为 M1 完成；如果发现任何一条不符合预期，记录具体现象（触发步骤、实际行为 vs 预期行为），作为下一轮修复的输入，不要在没有实际验证过的情况下声称"已完成"。
