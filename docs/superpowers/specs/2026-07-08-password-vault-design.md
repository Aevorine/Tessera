# 密码管理功能设计（file_vault 内部扩展）

## 背景与范围

用户希望在 `modules/file_vault/` 里增加密码管理功能：复用现有的多因素解锁体系（密码/邮箱验证码/TOTP 验证器/机器指纹），支持从 Chrome/Edge/Firefox 导入导出密码，界面和文件加密功能在同一个应用里。

原始需求还提到"网页版"（局域网/公网可访问，其他设备也能登录）。经过讨论，网页版涉及完全不同的安全模型（公网暴露面、机器指纹因子在浏览器网页里天然失效等），且用户手上的云服务器目前同时运行代理节点面板（s-ui），共用部署会互相拉高风险。**本次设计范围明确排除网页版**，用户已决定"先不使用云端，先把本地的任务干了"。网页版作为独立的后续子项目，需要单独设计（包括部署隔离、认证方案、机器指纹因子的替代方案等），不在本文档讨论范围内。

## 架构决策：为什么不新建独立模块

项目约定（`modules/README.md`）是"一个文件夹 = 一个独立场景，模块间不互相 import"。密码管理如果严格照此新建 `modules/password_vault/`，需要先把 `identity.py`/`crypto.py` 这类身份基础设施提升到 `core/`，两个模块各自维护独立的 Electron 窗口。

用户被明确告知这个权衡后，选择了"直接在现有 file_vault 里加一个密码管理页面"——这是刻意偏离模块化约定的决定，原因是用户要求"加密界面与密码管理的界面是同一个"，独立模块做不到真正意义上的"同一个应用"。这个偏离会在 `modules/file_vault/README.md` 里明确注明，避免以后被误认为是疏忏。

好处：不需要动 `core/`，密码管理直接复用 `backend_server.py` 里已经解锁的 IMK（`_require_imk()`），跟加密文件走同一套解锁闸门，解锁一次两个功能都能用。

## 数据模型

密码条目字段（有意保持精简，对齐 Chrome CSV 导出格式，不做过度设计）：

| 字段 | 说明 |
|---|---|
| `id` | 后端生成的唯一标识（如 uuid4），前端增删改都靠它定位条目 |
| `name` | 网站/应用名称 |
| `url` | 网址 |
| `username` | 账号 |
| `password` | 密码明文（仅在解密后的内存/传输中存在） |
| `notes` | 备注，可选 |
| `created_at` / `updated_at` | ISO 8601 时间戳，后端自动维护 |

不包含每站点独立的 TOTP 种子字段（用户已确认基本四项字段够用，这属于用户明确排除的范围，避免和本工具自身解锁用的 TOTP 混淆）。

## 存储与加解密方案

新增 `modules/file_vault/passwords.py`（纯逻辑层，无 UI 依赖，与 `container.py` 平级）：

- 存储文件：`modules/file_vault/data/passwords.vault`，与 `identity_store.json` 同目录（已在 `.gitignore` 排除）。
- 格式：所有密码条目序列化为一个 JSON 数组，整体用一把随机生成的文件密钥（FK）以 AES-256-GCM 加密；FK 本身用当前已解锁的 IMK 包裹一次——复用 `crypto.py` 里现成的 wrap/unwrap 原语，和 `container.py` 里单文件的信封加密思路一致，只是加密对象是一段结构化 JSON，不需要分块（预期数据量：几十到几百条密码记录，JSON 体积在数十 KB 级别，一次性 AES-GCM 加解密远低于 1 毫秒，不需要额外的性能设计）。
- 文件不存在时视为空列表（首次使用密码管理功能时的初始状态）。

### 会话内状态

`backend_server.py` 新增模块级状态 `_password_entries: Optional[List[PasswordEntry]]`，语义与现有的 `_store`/`_imk` 一致：

- 首次访问（`password_list` 等任一密码相关 RPC）时，若 `_password_entries is None`，调用 `passwords.load_password_vault(imk)` 解密加载。
- 任何增删改操作后，调用 `passwords.save_password_vault(_password_entries, imk)` 整体重写文件，并更新内存缓存。
- 与 `_imk` 一样，`_password_entries` 只存在于后端进程内存里，随窗口关闭一起消失（下次解锁重新从磁盘加载）。

## RPC 方法（`backend_server.py` 新增）

沿用现有 NDJSON 协议。**错误处理沿用现有代码的既定模式，不引入新模式**：`_require_imk()` 未解锁时抛 `RuntimeError("尚未解锁")`，不在密码相关 RPC 里额外 try/except 包裹——和现有的 `rpc_change_password`/`rpc_encrypt_file`/`rpc_decrypt_file` 等完全一致，异常由 `dispatch()` 统一捕获，转成顶层 `{"id": ..., "error": {"message": "尚未解锁"}}`，前端 `pythonBridge.ts` 会把它变成一个 rejected Promise（不是 `res.ok === false` 这种"正常返回值里带错误"的形状）。实际上这个检查在正常使用路径下不会触发：`PasswordScreen` 的入口（`MainScreen.tsx` 的"密码管理"按钮）本身已经走过 `ensureUnlocked()`，`_require_imk()` 只是防御性兜底，不需要专门的 UI 层错误展示。

| 方法 | 参数 | 说明 |
|---|---|---|
| `password_list` | 无 | 返回全部条目，包含明文密码（见"安全权衡"一节） |
| `password_add` | `name, url, username, password, notes` | 新增一条，返回新条目（含生成的 `id`） |
| `password_update` | `id, name, url, username, password, notes` | 按 `id` 整条覆盖更新 |
| `password_delete` | `id` | 按 `id` 删除 |
| `password_import_csv` | `input_path, delete_source_csv(默认 true)` | 解析 CSV，追加为新条目（不做去重合并，见"已知限制"）。**顺序保证**：先把新条目整体写入并加密保存到 `passwords.vault` 成功之后，才会按 `delete_source_csv` 决定是否调用 `container.secure_delete_file` 清理明文 CSV——不能反过来先删源文件再保存，否则中途失败会导致数据两头都丢 |
| `password_export_csv` | `output_path` | 按 Chrome/Edge 兼容格式导出全部条目 |

## CSV 导入导出

**导入**：用户在浏览器里手动导出密码 CSV（Chrome/Edge：设置→密码管理器→导出密码；Firefox：登录信息→...→导出），本工具解析时按列名自动识别（不区分大小写，兼容常见变体）：

- 名称列：`name` / `title`
- 网址列：`url` / `login_uri`
- 用户名列：`username` / `login`
- 密码列：`password`

Firefox 导出的 CSV 没有"名称"列，此时名称栏用 `url` 解析出的域名兜底（如 `github.com`）。

**导出**：统一导出为 Chrome/Edge 兼容的 CSV 格式（`name,url,username,password` 表头），可以被 Chrome/Edge 的"导入密码"功能直接读取。**不做 Firefox 专用导出格式**（Firefox 导入要求额外的 `guid`/`timeCreated` 等字段）——这是一个刻意的 YAGNI 决定，等实际有 Firefox 导入需求时再补，不在这次范围内实现。

**导入后的明文清理**：CSV 导入成功后，默认自动调用 `secure_delete_file` 安全删除那份明文 CSV（`delete_source_csv` 默认 `true`，可通过参数关闭）。理由：一份包含全部明文密码的 CSV 文件如果导入后留在磁盘上，等于把"密码管理器"的意义架空——这和之前文件加密功能里"加密后源文件还在"的问题是同一个道理，这次直接默认做对，不留隐患。

## 界面（`PasswordScreen.tsx`）

从 `MainScreen.tsx` 新增"密码管理"按钮进入（复用现有的 `ensureUnlocked()` 模式，和"设置"入口一致）。`App.tsx` 增加对应的 view 状态。

- 顶部：搜索框（按名称/网址/用户名做纯前端过滤，不需要额外 RPC）、"新增密码"、"导入 CSV"、"导出 CSV" 三个按钮。
- 列表：展示名称/网址/用户名；**密码列默认掩码显示（`••••••`）**，每行提供"显示/隐藏"切换和"复制到剪贴板"（复制不需要先切换成明文显示）——对齐主流密码管理器的默认交互,避免明文密码大片摊在界面上。
- 新增/编辑：复用 `SettingsScreen.tsx` 里已经验证过的 Dialog + Input 表单风格。
- 导入：`electronApi.openFiles` 选单个 CSV 文件 → 调 `password_import_csv` → toast 汇报导入了几条。
- 导出：`electronApi.saveFile` → 调 `password_export_csv`。

## 已知限制（有意排除的范围）

- **网页版/远程访问**：见"背景与范围"，作为独立子项目后续单独设计。
- **导入去重**：多次导入同一份 CSV，或导入内容与已有条目重复（同名同网址）时，当前设计是直接追加为新条目，不做合并/覆盖判断。避免"自动覆盖"误删用户已经在工具里维护的数据；去重是可以后加的功能，等用户实际用起来发现是刚需再做。
- **每站点独立 TOTP**：不在本次范围内（用户已确认）。
- **Firefox 专用导出格式**：不在本次范围内。

## 测试计划

- `modules/file_vault/tests/test_passwords.py`（纯 Python 单测，无需 Electron）：
  - 加解密往返（写入 `passwords.vault`，重新加载，条目一致）。
  - CSV 导入解析（Chrome 格式、Firefox 格式各一个用例，含"无名称列走域名兜底"的场景）。
  - CSV 导出格式正确性（列头、转义特殊字符如逗号/引号）。
- `modules/file_vault/tests/test_backend_server.py` 追加密码相关 RPC 的端到端用例（沿用现有 `BackendClient` 子进程 NDJSON 测试模式）：未解锁报错、增删改查往返、导入 CSV 后源文件被安全删除、导出 CSV 内容正确。
- UI 部分沿用项目现有的老限制：`tsc --noEmit` + eslint 保证类型和静态检查通过，真人点击走查（新增/编辑/导入/导出的原生文件对话框）需要用户自己确认，与之前 file_vault GUI 部分的验证方式一致。

## 安全权衡（明确记录，非遗漏）

- `password_list` 会把全部明文密码通过 NDJSON/IPC 传给渲染进程用于展示——这是密码管理器 UI 的固有特性（要显示/编辑密码就得让渲染进程拿到明文），和文件加密功能"内容完全不经过渲染进程"的模型不同。风险由 Electron 现有的 `contextIsolation: true` + `nodeIntegration: false` 边界收敛，但明文确实会短暂存在于渲染进程内存里，这是所有桌面密码管理器共有的权衡，不是本设计特有的缺陷。
