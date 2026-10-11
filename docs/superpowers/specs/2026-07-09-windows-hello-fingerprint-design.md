# 真实指纹解锁（Windows Hello）+ 登录页重构设计

## 背景与范围

现有 file_vault 的"机器指纹"因子并非生物指纹识别，而是读取本机主板序列号/CPU ID 等硬件标识（`fingerprint.py` 通过 WMI 计算），全自动、不需要用户操作、不区分"谁"在用这台电脑。用户在使用过程中把这个理解成了生物指纹识别，产生了误解。经过澄清，用户明确要的是**真正的生物指纹认证**——通过 Windows Hello 调用本机已有的指纹传感器，需要用户实际按手指验证。

技术可行性已在当前开发机上验证：
- 硬件层面存在指纹传感器（`Petaic Touch Fingerprint Sensor`，设备状态 OK）。
- `C:\Windows\System32\WinBioDatabase\` 下已有登记的生物特征模板文件，说明 Windows Hello 指纹很可能已配置。
- 用 Python 的 `winrt` 包（`pip install winrt-Windows.Security.Credentials.UI winrt-Windows.Foundation`，与项目 Python 3.9 环境兼容）直接调用 `UserConsentVerifier.check_availability_async()`，实测返回 `UserConsentVerifierAvailability.AVAILABLE`，确认这台机器上 Windows Hello 真实可用。不需要写 C#/PowerShell 中间层，Python 能直接调 WinRT API。

本次改动同时解决用户提出的另外两个关联需求：
1. **软件启动应先显示登录页**，而不是现在这种"主界面先出现、点功能按钮才检查解锁"的模式。
2. **设置页改动需要重新验证**（已在上一轮改动中实现，本次设计不重复，但会因为登录页重构而更新其上下文说明）。

## 架构决策

### 1. Windows Hello 接入方式：UserConsentVerifier + keyring 密钥

Windows Hello 提供两种接入深度：
- **UserConsentVerifier**（本次采用）：只返回"验证通过/不通过"的布尔结果，不产出可直接用于密钥派生的稳定密钥材料。需要搭配一个存在 Windows 凭据管理器（`keyring`）里的随机密钥——Windows Hello 验证通过后才允许读取这个密钥，再用它像 TOTP/邮箱因子一样走 HKDF 包裹/解包流程。实现量小，和现有四个因子的代码风格完全一致。
- KeyCredentialManager（放弃）：真正的 TPM 硬件级非对称密钥对，安全性更高，但需要设计非对称挑战-响应签名流程（ECDSA 签名默认带随机数，不能直接当稳定密钥使用，需要额外方案），对个人工具而言复杂度收益不成比例。

**安全模型说明**：`bio_secret` 本身由 Windows 凭据管理器保护（需要当前 Windows 账户已登录才能读取），我们自己的代码在读取它之前先要求 Windows Hello 验证通过。这不是硬件级隔离，但对个人使用场景强度足够，且和现有 TOTP/邮箱因子的信任模型一致（值得注意：现有身份体系整体都建立在"这台电脑、这个 Windows 账户是可信的"这个前提上，`bio_secret` 并不比 TOTP seed/邮箱密钥更脆弱）。

### 2. 现有"机器指纹"因子：直接替换，不并存

`SLOT_FINGERPRINT` 这个槽位名称保留，但内部实现完全替换：
- `fingerprint.py` 不再读硬件标识，改为封装 Windows Hello 调用（`is_available()` 检测可用性、`request_verification()` 弹出原生提示框阻塞等待用户验证、`generate_bio_secret()` 生成新密钥）。
- 对外接口（`identity.py`/`backend_server.py` 里引用 `fingerprint` 模块的地方）尽量保持调用方式不变，降低改动面。
- **已有身份数据的指纹槽位在此次更新后失效**（底层密钥来源变了，旧槽位解不开）。不影响密码/邮箱/验证器/恢复密钥这四个独立因子，用户可以照常用其中任意一个解锁，然后在设置页手动"重新绑定指纹解锁"。这是用户已确认接受的迁移方式。

### 3. 启动流程重构：登录页作为硬性关卡

- `App.tsx`：身份已设置时不再直接进主界面，而是先进新增的 `LoginScreen`（整页组件，不是弹窗）。内容是现有解锁弹窗的四个标签（密码/验证器/邮箱/恢复密钥）加一个新增的"指纹"标签。五选一，任意一种验证通过才放行进主界面。
- "指纹"标签**始终显示**，不因为某个身份没绑定指纹就隐藏——和现有"邮箱未配置时仍显示邮箱标签，点了报友好错误"的既有模式一致，不必额外做一个"查询有没有绑定"的接口。
- 主界面（`MainScreen.tsx`）里加密/解密/密码管理按钮点击时"先静默试一次指纹解锁、失败才弹窗"的 `ensureUnlocked()` 逻辑整体移除——用户已经在主界面，说明已经通过登录页验证过了，不需要每个按钮再检查一次。"设置"按钮维持现有的"每次都强制重新走登录页/弹窗验证"不变（这是上一轮已实现的功能，本次只是更新其实现路径：从弹窗改为复用/触发登录页组件）。
- **随之删除**：`require_manual_unlock` 这个设置开关（及其后端 `get_app_settings`/`update_app_settings` RPC、`identity.py` 里的 `AppSettings`/`load_app_settings`/`save_app_settings`）——这个开关原本用来控制"要不要允许静默自动解锁"，但登录页重构后不再存在"静默自动解锁"这回事（登录页本身就要求主动完成一次验证，无论选哪个因子），这个开关因此失去意义。用户已确认删除而非保留死代码。

## 后端改动

- `identity.py`：
  - `SLOT_FINGERPRINT` 从"必然存在"变为可选（不绑定就不在 `store.slots` 里，处理方式和 `email_address` 为 `None` 时一致）。
  - `setup_identity()` 新增可选参数，传入时调用 `fingerprint.generate_bio_secret()` 生成 `bio_secret` 存入 keyring（新增 `KEYRING_BIO_SECRET` 常量）并创建 `SLOT_FINGERPRINT`；不传则跳过，身份只有四个因子。
  - `try_unlock_via_fingerprint(store)` 内部改为：槽位不存在直接返回 `None`（无此因子）；槽位存在则调用 `fingerprint.request_verification()`（阻塞、弹出真实系统提示框）——验证不通过或用户取消返回 `None`，验证通过则从 keyring 读 `bio_secret`、HKDF 解包 IMK。语义从"静默自动检测"变为"阻塞式主动验证"，函数名保留以降低改动面，但文档字符串需要更新说明。
  - **迁移场景的空密钥防护**：老身份数据的 `SLOT_FINGERPRINT` 槽位在磁盘上依然存在（只是底层密钥来源是旧的机器硬件标识），所以"槽位不存在"这条早退路径不会触发——会一路走到真实验证通过、再去 keyring 读 `bio_secret`，而老身份从没写过这个 keyring 条目，读到的是 `None`。这里必须像 `unlock_via_totp` 里 `if not seed: raise UnlockError(...)` 那样加一道判空防护（读到 `None` 时直接返回 `None`，不能把 `None` 传进 `crypto.derive_key_hkdf()` 引发未处理异常）。这是老身份指纹槽位失效的实际生效路径，不是理论边界情况，必须处理。
  - 新增 `rewrap_fingerprint(data_dir, store, imk)`：要求已解锁，触发一次真实 Windows Hello 验证确认用户同意，生成新 `bio_secret`（调用 `fingerprint.generate_bio_secret()`，不在 `identity.py` 里重复写 `secrets.token_bytes` 逻辑）、重新包裹、保存——镜像 `rewrap_totp()` 的模式。

- `backend_server.py`：
  - 删除：`unlock_auto`/`rpc_unlock_auto`、`get_app_settings`/`rpc_get_app_settings`、`update_app_settings`/`rpc_update_app_settings`。
  - 新增：`unlock_fingerprint`（登录页"指纹"标签调用，阻塞直到用户完成/取消系统提示框）、`setup_check_fingerprint_available`（向导用于判断要不要显示指纹绑定步骤）、`rebind_fingerprint`（设置页"重新绑定指纹"用）。
  - `setup_complete` 新增可选参数，决定这次设置要不要生成指纹槽位。

## 前端改动

- 新增 `LoginScreen.tsx`：整页组件，内容基于现有 `UnlockDialog.tsx` 的四个标签（去掉 Dialog 外壳，改成整页布局），新增"指纹"标签——点击后调用 `unlock_fingerprint`，按钮显示"等待验证..."状态直到 RPC 返回（因为这个调用会阻塞到系统提示框关闭）。
- `App.tsx`：身份存在时的默认视图从 `main` 改为 `login`（新增 view 状态），`LoginScreen` 验证成功后才切到 `main`。首次设置完成（`SetupWizard` 的 `onComplete`）后**直接进 `main`，不再经过 `LoginScreen`**——用户在设置向导最后一步（生成/确认恢复密钥）已经等同于证明了身份，不需要再走一次登录页；这和现状（`onComplete` 直接进主界面）保持一致，只是登录页只在"之后重新打开软件"时才会作为关卡出现。
- `MainScreen.tsx`：移除 `ensureUnlocked()` 及其在加密/解密/密码管理按钮里的调用；`handleSettings()` 保留强制重新验证，但改为导航到 `LoginScreen`（或复用其组件以一次性验证）而不是弹窗（具体是复用整页组件还是保留弹窗形式，交给实施计划阶段根据代码复用情况决定，不在本设计文档中锁死）。
- `SetupWizard.tsx`：验证器步骤之后新增"绑定指纹解锁"步骤——先调用 `setup_check_fingerprint_available`，不可用则自动跳过此步骤（不显示，不需要用户点跳过）；可用则弹出真实验证一次作为确认，通过后带着"启用指纹"这个标志进入 `setup_complete`。
- `SettingsScreen.tsx`：新增"重新绑定指纹解锁"按钮，调用 `rebind_fingerprint`（会触发真实的 Windows Hello 验证）。
- 删除：`require_manual_unlock` 相关的 UI（`SettingsScreen.tsx` 里的对应勾选框）。

## 错误处理

Windows Hello 相关异常（用户取消、超时、系统级不支持、设备被占用等）统一在 `fingerprint.py` 层转换为友好的中文错误信息（例如"指纹验证已取消""这台电脑未配置 Windows Hello 指纹"），不让原始 WinRT 异常堆栈泄漏到前端。RPC 层遵循现有约定：未解锁时 `_require_imk()` 抛异常走 `dispatch()` 统一捕获（沿用之前确认过的既定模式），验证失败但不是系统错误的情况（如"未绑定此因子""验证未通过"）返回 `{"ok": false, "error": ...}`。

`identity.try_unlock_via_fingerprint()` 本身对"槽位不存在""验证失败/取消""解包失败"这几种情况统一返回 `None`，不区分原因（和现有 `try_unlock_via_fingerprint` 的既有设计一致）。如果 `unlock_fingerprint` 这个 RPC 想给出"未绑定此因子"和"验证未通过"这两种不同的错误提示，需要在 `backend_server.py` 里自己先检查 `store.slots.get(SLOT_FINGERPRINT) is None`，再决定要不要调用 `identity.try_unlock_via_fingerprint()`——这跟 `rpc_unlock_email_start` 现有的"先单独检查 `smtp_config is None`，再进 try/except 包裹的 `UnlockError`"是同一个模式，实施计划直接照抄这个既有写法即可。

## 测试策略

- **无法自动化**的部分：真实 Windows Hello 弹窗验证需要人物理触摸传感器，这部分和"扫码绑定验证器 App""收邮件验证码"一样写进 README 的手动验证清单，不强求自动化覆盖。
- **可自动化**的部分（对 `fingerprint.request_verification()` 做 monkeypatch，让测试环境不需要真实弹窗）：
  - `fingerprint.is_available()` 的检测逻辑本身（真实调用一次 `check_availability_async()`，这个不需要用户交互，可以在 CI/测试环境里真实跑，前提是测试机也要有可用的 Windows Hello——如果没有，测试需要能优雅地判定"不可用"分支而不是报错）。
  - `bio_secret` 生成与 HKDF 包裹/解包的往返正确性（mock `request_verification()` 直接返回 `True`，测试其余的密钥管理逻辑）。
  - `setup_identity()` 在不传指纹参数时确实不创建 `SLOT_FINGERPRINT` 槽位。
  - `rewrap_fingerprint()` 正确替换槽位、旧密钥失效、新密钥生效。
  - `try_unlock_via_fingerprint()` 在"槽位存在但 keyring 里没有 `bio_secret`"（老身份迁移场景）时返回 `None` 而不是抛异常。
  - `backend_server.py` 的 NDJSON 契约测试：`unlock_fingerprint`/`rebind_fingerprint`/`setup_check_fingerprint_available` 走通（同样 mock 掉真实验证弹窗）。

**现有测试需要同步更新，不是全部保留**：`tests/test_identity.py` 里以下用例是针对被本次设计替换/删除的旧行为写的，实施计划需要明确修改或删除它们，不能放着不管：
- `test_setup_identity_creates_all_five_slots`、`test_setup_identity_persists_and_reloads`：断言 `set(store.slots.keys()) == set(identity.ALL_SLOTS)`。测试用的 `store` fixture 如果不传新的指纹参数给 `setup_identity()`，现在只会产生四个槽位，这两个断言需要改成断言四个槽位（或者让 fixture 传参数、mock 掉真实验证以产生第五个槽位——具体选哪种留给实施计划决定）。
- `test_unlock_via_fingerprint_matches_current_machine`、`test_unlock_via_fingerprint_returns_none_on_different_machine`（内部 `monkeypatch.setattr(fingerprint, "compute_fingerprint", ...)`）、`test_all_five_paths_unlock_to_the_same_imk`：都直接依赖被整个删除的 `fingerprint.compute_fingerprint`，需要重写成针对新的 `request_verification()`/`is_available()` 接口的等价测试。
- `test_load_app_settings_defaults_to_auto_unlock_allowed`、`test_save_and_load_app_settings_round_trip`：直接测试本次要删除的 `AppSettings`/`load_app_settings`/`save_app_settings`，应随该功能一起删除，不是保留成死测试。

`tests/test_backend_server.py` 里同理需要删除依赖 `unlock_auto`/`get_app_settings`/`update_app_settings` 的既有用例（`test_get_app_settings_defaults_to_auto_unlock_allowed`、`test_update_app_settings_requires_unlock`、`test_require_manual_unlock_disables_fingerprint_auto_unlock_on_next_launch` 等），替换成新 RPC 方法的等价测试。

`tests/test_fingerprint.py` **整个文件**需要重写，不只是改个别用例——它直接 `from modules.file_vault.fingerprint import compute_fingerprint` 并对其输出断言（`test_fingerprint_is_32_bytes`、`test_fingerprint_stable_across_calls`）。`compute_fingerprint` 是本次要整个删除的函数，这个文件现在会在 pytest **收集阶段**就因为 `ImportError` 直接失败（比其他几个"断言不通过"的测试更严重），必须针对新的 `is_available()`/`request_verification()`/`generate_bio_secret()` 接口重写。

## 已知限制（有意排除的范围）

- 不做 KeyCredentialManager 硬件级密钥保护（见"架构决策"第 1 点）。
- 不支持"多个指纹/多用户"场景——Windows Hello 本身是按 Windows 账户配置的，这个软件的信任边界和"这个 Windows 账户已登录"绑定在一起，和现有其余四个因子的信任模型一致，不额外区分"具体是哪根手指"。
- 没有 Windows Hello 硬件/未配置的电脑上，指纹解锁这条路径始终不可用（安装向导自动跳过绑定步骤，登录页点"指纹"标签会报错），这是预期行为，不是缺陷。
