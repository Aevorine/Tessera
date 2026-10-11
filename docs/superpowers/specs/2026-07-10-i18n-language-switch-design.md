# 多语言切换功能设计

## 背景与范围

`modules/file_vault` 的 Electron + React 图形界面（10 个组件、约 2200 行）目前所有界面文案都是硬编码中文，后端 `backend_server.py` 及其调用的 `container.py`/`identity.py`/`fingerprint.py`/`passwords.py`/`task_store.py`/`task_engine.py` 里通过 `raise` 抛出、最终传给前端的错误文案同样是硬编码中文，逐文件核实后的 `raise` 语句数量：`container.py` 19、`identity.py` 11、`fingerprint.py` 3、`passwords.py` 7、`task_store.py` 6、`task_engine.py` 3、`backend_server.py` 2（另有 1 处 `raise RuntimeError(str(exc))` 只是转发内层异常，不含新文案，不单独计入）；`backend_server.py` 里还有约 9 处直接写成 `{"ok": False, "error": "..."}` 字面量（非 `raise`）的错误分支，以及若干把变量拼进 f-string 的错误分支（如 `f"合并失败: {result.stderr.strip()}"`）。合计约 60 处翻译点，具体清单在实施阶段逐文件核对，本设计文档不逐条列举。本次要新增语言切换功能，覆盖联合国 6 种官方语言（中文、English、Français、Español、Русский、العربية），默认跟随电脑系统语言，用户可随时手动切换并记住选择。

范围明确包含：
- 前端全部静态文案（按钮、标签、标题、提示语、Toast 成功提示）。
- 后端经由 IPC 返回给前端、最终展示给用户的错误文案。

范围明确不包含：
- 后端日志、代码注释、README 等面向开发者的文本。
- 外部系统本身产生的动态文本（例如 git 合并失败时的 `stderr` 内容）——这类内容作为参数原样拼进已翻译的消息模板，不做翻译。
- Windows 系统对话框（文件选择器等）的语言，这些由 OS 自身控制，不受本功能影响。

## 架构决策

### 1. 前端 i18n 库：react-i18next

采用 `react-i18next` + `i18next`（新增两个直接依赖，外加可选的 `i18next-browser-languagedetector` 视实现需要决定是否引入，语言检测本次改为自建逻辑——见下一节——所以不需要这个探测插件）。相比自建 Context+JSON 方案，react-i18next 的插值（`{{var}}`）、命名空间、fallback 语言等机制是现成的，规避手写这些边界情况的成本；换来的代价是多两个 npm 依赖，在个人工具的规模下可接受。

翻译资源按屏幕拆分命名空间，路径 `ui/src/i18n/locales/<lang>/<namespace>.json`，6 语言 × 8 命名空间：`common`（按钮/通用词）、`setup`（SetupWizard）、`login`（LoginScreen/UnlockDialog/UnlockTabs）、`settings`（SettingsScreen）、`files`（FilesPane/AppShell）、`tasks`（TaskListScreen/TaskDetailScreen）、`passwords`（PasswordScreen）、`errors`（后端错误码，见下）。

### 2. 语言检测与默认值

优先级：`localStorage`（用户之前手动选过）→ 系统语言 → 英语兜底。

系统语言通过 Electron 主进程的 `app.getLocale()` 获取（比渲染进程 `navigator.language` 更贴近真实系统设置），新增一条 IPC：`main.ts` 里 `ipcMain.handle('system:getLocale', () => app.getLocale())`，`preload.ts` 暴露 `getSystemLocale()`，`window.d.ts` 补充类型。渲染进程拿到形如 `zh-CN`/`fr-FR`/`ar-SA` 的字符串后取前缀（`-` 之前的部分）匹配 6 种支持语言之一；不在支持列表内（如日语、德语系统）一律回退英语。

用户在语言切换器里手动选择后写入 `localStorage`（key: `ideal1-file-vault-lang`），此后每次启动优先读取这个值，不再看系统语言，直到用户清除或改选。

### 3. 切换入口：App.tsx 里全局挂载一次

新增 `LanguageSwitcher.tsx`（shadcn `Select` 组件，选项显示各语言的本地名称：简体中文/English/Français/Español/Русский/العربية），挂载在 `App.tsx` 的最外层、位于当前 `view` 分支渲染之上（例如页面右上角固定定位），这样无论处于 `loading`/`setup`/`login`/`app` 哪个阶段都能看到并使用，不需要在 `LoginScreen`/`SetupWizard`/`AppShell` 三处各自重复插入。

### 4. RTL（阿拉伯语）

语言切到 `ar` 时在文档根节点设置 `dir="rtl"`（其余语言 `dir="ltr"`），随 `i18n.language` 变化联动。仅做这一层方向切换，不逐组件做像素级 RTL 布局审查——shadcn/Tailwind 组件在 `dir="rtl"` 下的文字方向和大部分 flex 布局会自动镜像，个别图标间距细节可能不完美，作为个人工具可接受的已知限制写进设计文档，不纳入本次验收标准。

### 5. 后端错误码化：新增 `errors.py`，现有异常类改为继承而非替换

**实际现状（核实后，与最初草稿不同）**：`backend_server.py` 并不是所有错误都走同一个统一捕获点。现有 9 个自定义异常类（`container.InvalidContainerError`/`ContainerIntegrityError`/`SamePathError`、`identity.UnlockError`/`IdentityNotSetUpError`、`fingerprint.FingerprintUnavailableError`、`passwords.PasswordVaultError`、`task_engine.TaskEngineError`、`task_store.TaskStoreError`）里，有 7 个在 `backend_server.py` 的 `rpc_*` 函数里被**按具体类型**捕获（约 15 处 `except identity.UnlockError as exc:`/`except (container.InvalidContainerError, container.ContainerIntegrityError) as exc:` 这类写法），转成 `{"ok": False, "error": str(exc)}` 结果返回给前端；`IdentityNotSetUpError`/`TaskStoreError` 这两个当前没有被任何地方按类型专门捕获。另外 **39 个 `rpc_*` 函数里有 23 个完全没有本地 `try/except`**（逐函数核实：`rpc_identity_exists`、`rpc_setup_generate_totp`、`rpc_setup_verify_totp`、`rpc_setup_generate_recovery_key`、`rpc_setup_check_fingerprint_available`、`rpc_setup_complete`、`rpc_scan_remnants`、`rpc_change_password`、`rpc_rebind_totp_start`、`rpc_rebind_totp_confirm`、`rpc_update_email`、`rpc_regenerate_recovery_key`、`rpc_get_smtp_config`、`rpc_password_list`、`rpc_password_add`、`rpc_password_update`、`rpc_password_delete`、`rpc_password_export_csv`、`rpc_detect_default_model`、`rpc_task_list`、`rpc_task_review_diff`、`rpc_task_merge`、`rpc_task_discard`），这些函数内部（或它们调用的 `identity.py`/`container.py` 等）抛出的任何异常都会一路冒泡到 `dispatch()` 唯一的外层兜底：

```python
def dispatch(request: dict) -> dict:
    ...
    try:
        ...
        return {"id": request_id, "result": result}
    except Exception as exc:
        return {"id": request_id, "error": {"message": str(exc)}}
```

这个兜底返回的是**协议层错误**（`{"id":.., "error": {"message":...}}`），形状和 `rpc_*` 函数自己捕获后返回的**业务层错误**（`{"id":.., "result": {"ok": false, "error":...}}`）完全不同。前端 `pythonBridge.ts` 对这两种分别处理：业务层错误是正常 resolve 的 `result`，交给各组件自己判断 `res.ok`；协议层错误会让 `vaultApi.call(...)` 返回的 Promise **reject**，而目前所有组件调用 `vaultApi.call` 都没有 `try/catch`/`.catch(...)`，也没有全局的 `unhandledrejection` 处理——也就是说，这 23 个函数目前失败时，用户界面上**什么提示都不会出现**，只有开发者控制台能看到。这是本功能开始之前就存在的行为，不是本次改动引入的。

**方案**：新增 `modules/file_vault/errors.py`：

```python
class VaultError(Exception):
    def __init__(self, code: str, **params):
        self.code = code
        self.params = params
        super().__init__(code)
```

上述 9 个现有自定义异常类**改为继承 `VaultError`**（例如 `class UnlockError(VaultError): pass`），而不是被 `VaultError` 直接取代——这样 `backend_server.py` 里现有约 15 处按具体类型捕获的 `except identity.UnlockError as exc:` 之类的写法**不需要改动捕获逻辑本身**，只需要改捕获之后的返回语句。其中 `fingerprint.FingerprintUnavailableError` 目前继承 `RuntimeError`（其余 8 个都直接继承 `Exception`），核实过代码库里没有任何地方按 `RuntimeError` 类型专门捕获它，改成单继承 `class FingerprintUnavailableError(VaultError): pass` 即可，不需要保留 `RuntimeError` 这层（多继承 `class FingerprintUnavailableError(VaultError, RuntimeError): pass` 在 MRO 上也不会冲突，但没有必要，明确选单继承以降低认知负担）。所有 raise 调用点的中文文案参数替换为错误码（+ 可选参数），例如：

- `raise UnlockError("密码错误")` → `raise UnlockError("auth.wrong_password")`
- `raise identity.IdentityNotSetUpError("...")` 之类同理传错误码
- `f"合并失败: {result.stderr.strip()}"` → `VaultError("task.merge_failed", detail=result.stderr.strip())`（这里走的是 `backend_server.py` 里直接构造 `VaultError` 的字面量分支，不是从下层模块 raise 上来的）

错误码命名约定：`<模块>.<原因>`，蛇形命名，跨文件复用同一个码（例如"未解锁"这个语义无论从哪个文件抛出都用 `auth.not_unlocked`）。

`backend_server.py` 里约 15 处按具体类型捕获的返回语句，统一改为调用一个新增的小helper（另外 6 处 `except Exception as exc:` 里只有 1 处能直接套用，其余 5 处形状不同，见下文分类说明，不在此一并处理）：

```python
def _error_result(exc: Exception) -> dict:
    if isinstance(exc, errors.VaultError):
        return {"ok": False, "error": exc.code, "error_params": exc.params}
    return {"ok": False, "error": "internal.unexpected", "error_params": {"detail": str(exc)}}
```

即 `except identity.UnlockError as exc: return _error_result(exc)`（原先是 `return {"ok": False, "error": str(exc)}`）。这样业务层错误路径统一携带 `error_params`，具体类型捕获与生成 `VaultError` 子类是否匹配无关——只要子类关系成立就能正确取出 `.code`/`.params`。

**这不是所有 `except Exception as exc:` 都能机械套用的模板**，核实过现有 6 处 `except Exception as exc:` 形状并不统一，分三类，实施阶段要分别处理：
- 直接返回 `{"ok": False, "error": str(exc)}` 的（如 `rpc_send_test_email`，line 307）：可以直接改成 `return _error_result(exc)`。
- 包了一层自定义前缀文案的（如 `rpc_unlock_email_start` 里 `except Exception as exc: return {"ok": False, "error": f"发送失败：{exc}"}`，line 166-167）：这层前缀本身也需要一个独立错误码（如 `email.send_failed`，`detail=str(exc)`），不能直接套 `_error_result`（那样会丢掉"发送失败"这层语义，退化成通用的 `internal.unexpected`）。
- 不是主错误路径、而是"主操作已成功、事后best-effort清理失败"的（如 `rpc_secure_delete_paths` 循环体内 line 234 `results.append({"path": p, "ok": False, "error": str(exc)})`（其 `except Exception as exc:` 在 line 233），以及 `rpc_password_import_csv`/`rpc_encrypt_file`/`rpc_decrypt_file` 里 `delete_source` 相关的 3 处 `result["delete_error"] = str(exc)`，line 392/643/670（对应的 `except Exception as exc:` 分别在 line 390/641/668））：这几处字段名是 `error`/`delete_error` 而不是顶层 `{"ok": false, "error":...}`，需要各自补一个平行的 `_params` 字段（如 `delete_error_params`），字段名沿用现有约定，不能整体套 `_error_result` 的返回形状。

另外，`_require_password_entries()`（line 311-318）内部把 `passwords.PasswordVaultError` 捕获后重新包成 `raise RuntimeError(str(exc))` 再抛出——这会剥离 `VaultError` 身份，导致密码相关 RPC（`rpc_password_list/add/update/delete/export_csv` 等，多数本身也在上面 23 个无本地捕获的名单里）在这条路径失败时，即使底层已经是携带错误码的 `PasswordVaultError`，也会在这里被打回成普通 `RuntimeError`，最终仍然只能走 `dispatch()` 的协议层兜底（未翻译，控制台可见）。这属于上面"23 个方法维持现状"这条已知限制的一个具体触发点，不单独处理，但实施阶段需要知道这一层转换的存在，不要误以为给 `PasswordVaultError` 加了错误码就意味着这些密码相关调用会自动拿到翻译后的错误提示。

原本直接写在 `backend_server.py` 里、不经过 raise 就直接构造 `{"ok": False, "error": "..."}"` 字面量的正常业务分支（如"尚未配置发信邮箱"），同样改成返回错误码字符串（如 `"smtp.not_configured"`），不需要经过 `_error_result`（本来就不是异常路径）。

**明确决定：`dispatch()` 的协议层兜底不改造，23 个无本地捕获的方法维持现状**。给这 23 个方法补齐本地异常处理、把协议层错误也统一成 `{"ok": false, "error", "error_params"}"` 形状、并给对应的前端调用点补 `if (!res.ok)` 判断，属于修复一个和本功能无关的既有静默失败缺陷，工作量不小且超出"加语言切换"的范围，本次不做。维持现状不会造成回归：`VaultError.__init__` 用 `super().__init__(code)`，`str(exc)` 默认返回 `code` 本身，所以这条路径今天是"控制台打印中文原文、界面无提示"，改造后是"控制台打印错误码、界面依然无提示"——用户可见行为没有变化，只是从今天起也不会再退化（比如误把某个具体异常类型改没了导致某个原本走业务层错误的路径意外冒泡成协议层错误、体验变差）。这条兜底路径写入下方"已知限制"。

### 6. IPC 类型：复用 `error` 字段语义，新增 `error_params`

`ipcTypes.ts` 里 `VaultMethods` 中所有 `{ ok: false; error: string }` 的 `error` 字段不改名，但语义从"中文错误文案"变为"错误码"；新增可选字段 `error_params?: Record<string, string | number>`。这样只需要在类型定义里补一个可选字段，不需要把 `error` 到 `errorCode` 这种改名传播到每个消费点的类型标注。

前端新增 `translateError(code: string, params?: Record<string, string | number>): string` 辅助函数（`ui/src/i18n/errors.ts`），内部用 `t(\`errors.${code}\`, params)`，找不到对应 key 时 i18next 的 missing-key 行为会退化显示 code 本身——这里额外包一层，找不到就返回一条通用兜底文案（`errors.common.unknown`），避免用户看到裸的 `auth.wrong_password` 这种 key 字符串。

前端消费 `res.error` 的现有写法并不统一，逐处核实过，实际有四种形状，改造时分别处理：
- `toast.error('<中文标题>', { description: res.error })`（共 7 处：`PasswordScreen.tsx` 3 处、`SettingsScreen.tsx` 1 处、`TaskDetailScreen.tsx` 3 处）：标题本身也是硬编码中文，需要 `t('...')`；`description` 改为 `translateError(res.error, res.error_params)`。
- `toast.error(\`<中文前缀>：${res.error}\`)` / `setStatus(... \`<中文前缀>：${res.error}\`)`（共 3 处：`FilesPane.tsx` line 86/121 走 `toast.error`，`SetupWizard.tsx` line 281 走 `setStatus`）：前缀和错误文本拼在同一个模板字符串里，需要拆成 `` `${t('files.scanFailed')}：${translateError(res.error, res.error_params)}` `` 这种形式，或改用 i18next 插值让整句成为一个翻译 key。
- `setError(res.error)` / `setError(res.error ?? '<中文兜底>')` / `setStatus(res.error ?? '<中文兜底>')`（共 10 处：`PasswordScreen.tsx`/`SettingsScreen.tsx`/`SetupWizard.tsx`（line 237）/`TaskListScreen.tsx`（line 167）各 1 处，`UnlockTabs.tsx` 6 处）：这些组件把 `res.error` 直接存进 state 渲染在页面上（不经过 toast），改为 `setError(translateError(res.error, res.error_params))`，`??` 后面的中文兜底文案本身也需要 `t(...)`。
- `TaskListScreen.tsx` line 147 `setError(openRes.error ?? '打开 VS Code 失败')`——**这一处的 `error` 不是 Python 后端 `res.error`**，而是 Electron 主进程 `electron/main.ts` 里 `shell:openInVSCode` IPC handler 返回的、硬编码中文的错误字符串（"找不到 VS Code 命令行工具..."，见 `main.ts` line ~122）。这条错误路径完全在 Electron 主进程内产生，不经过 `errors.py`/`VaultError`，本设计原本的"错误码 + 前端翻译"机制覆盖不到。为了不留下一条永久不翻译的错误提示，`main.ts` 这个 handler 同样改为返回错误码（如 `{ok: false, error: 'shell.vscode_not_found'}`），错误码复用同一份 `errors` 翻译命名空间，`TaskListScreen.tsx` 里改成 `setError(translateError(openRes.error))`（这条没有 `error_params`）。

四类合计 21 处直接展示给用户的消费点；另有 `FilesPane.tsx` 3 处（line 172/254/316）把 `res.error` 先塞进内部结果数组、稍后才批量渲染，不在这 21 处里单独枚举，随各自结果列表渲染逻辑一起处理。

## 前端改动清单

- 新增：`ui/src/i18n/index.ts`（i18next 初始化 + 系统语言检测）、`ui/src/i18n/errors.ts`（`translateError`）、`ui/src/i18n/locales/**`（6×8 JSON）、`ui/src/components/LanguageSwitcher.tsx`。
- `main.tsx`：引入 `./i18n`（触发初始化，需在 `App` 渲染前完成语言解析，避免闪一下默认语言再切换的问题——用一个顶层 `Suspense` 或者在 `i18n.init` 完成前渲染空白，具体机制留给实施阶段选型，react-i18next 官方有现成的 `Suspense` 集成方式）。
- `App.tsx`：挂载 `LanguageSwitcher`；`dir` 属性联动。
- `electron/main.ts`：新增 `system:getLocale` IPC handler；`shell:openInVSCode` handler 里硬编码的中文错误文案（"找不到 VS Code 命令行工具..."）改为返回错误码 `shell.vscode_not_found`，纳入 `errors` 翻译命名空间（见上文"IPC 类型"一节）。
- `electron/preload.ts` + `shared/window.d.ts`：暴露 `getSystemLocale()`。
- 其余 10 个组件文件：把硬编码中文替换为 `useTranslation()` 的 `t(...)` 调用，按上述命名空间归类；含插值的文案（如 `` `找不到 VS Code 命令行工具...` `` 这类目前在 `main.ts` 里、不在渲染进程，不受影响；渲染进程内已确认的插值文案共 15 处分布在 6 个组件文件，改写成 i18next 的 `{{var}}` 插值语法）。

## 后端改动清单

- 新增 `modules/file_vault/errors.py`（`VaultError` 基类）。
- 9 个现有自定义异常类（`container.py` 3 个、`identity.py` 2 个、`fingerprint.py` 1 个、`passwords.py` 1 个、`task_engine.py` 1 个、`task_store.py` 1 个）改为继承 `VaultError`，类名和抛出点不变，只把构造参数从中文文案改成错误码。
- 各 raise 调用点文案改错误码：`container.py`（19 处）、`identity.py`（11 处）、`fingerprint.py`（3 处）、`passwords.py`（7 处）、`task_store.py`（6 处）、`task_engine.py`（3 处）、`backend_server.py`（raise 2 处 + 字面量错误分支约 9 处 + 含变量的 f-string 错误分支数处）。
- `backend_server.py` 新增 `_error_result(exc)` helper；约 15 处按具体异常类型捕获的返回语句改为调用它。6 处 `except Exception as exc:` 里只有 1 处（`rpc_send_test_email`）能直接套用，其余 5 处（1 处带自定义前缀文案、3 处是 `delete_error` 类型的 best-effort 清理失败、1 处是循环体内的逐项结果）需要按上文"这不是所有 `except Exception` 都能机械套用"一节列出的三种模式分别处理。`dispatch()` 的协议层兜底（服务 23 个无本地异常处理的 `rpc_*` 方法）保持原有 `{"error": {"message": str(exc)}}` 形状不变，见上文"明确决定"一节。

## 测试策略

- `tests/test_backend_server.py` 中断言字面量中文错误文本的用例（如 `assert result == {"ok": False, "error": "密码错误"}`）改为断言错误码（如 `assert result == {"ok": False, "error": "auth.wrong_password"}`）；用 `in` 做子串匹配的用例（如 `assert "有效的加密文件" in result["error"]`）同样改为对错误码或 `error_params` 里内容的断言。
- 新增一个轻量一致性检查（作为实施阶段的一次性脚本运行验证即可，不需要引入前端测试框架）：确认 6 种语言的每个命名空间 JSON 文件 key 集合完全一致，避免漏翻译导致某语言下出现 fallback 英文/裸 key。
- 语言切换的实际视觉验证（切换后文案变化、RTL 镜像、系统语言检测）通过 `/verify` 技能手动跑一遍 Electron 应用确认，不强求自动化覆盖 UI 渲染结果。

## 已知限制（写入 README，不阻塞验收）

- git 相关错误（合并失败等）里的 `stderr` 原文、未预期异常的 `str(exc)` 详情不翻译，原样展示。
- 阿拉伯语仅做 `dir` 级别的方向切换，不做逐组件 RTL 像素级调整。
- Windows 原生文件对话框语言跟随系统，不随应用内切换联动。
- **23 个没有本地异常处理的 `rpc_*` 方法失败时，界面依然不会显示任何提示**（这是本功能开始之前就存在的行为：`dispatch()` 的协议层兜底会让对应的 Promise reject，但没有任何组件对 `vaultApi.call` 做 `try/catch`，也没有全局 `unhandledrejection` 处理，只有开发者控制台能看到）。本次改动后这条路径的控制台文本从中文原文变成错误码字符串，用户可见行为不变、不构成回归，但也不在本次修复范围内——这是独立于"多语言"的既有 UX 缺陷，留给后续单独处理。
