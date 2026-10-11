# File Vault 后端耗时 RPC 异步调度设计

日期：2026-07-20

## 1. 范围与里程碑

目标：把 [batch_engine.py](../../../modules/file_vault/batch_engine.py) 里已经实现并测试过的"提交即返回、后台线程执行"机制（`ASYNC_DEFERRED` 哨兵 + `submit_batch_task`），从"仅供新增的批量传输 RPC 使用"正式扩展成"覆盖目前已知的全部耗时 RPC"，让这些操作运行期间不再卡住应用里其它无关的页面。

本设计**不是**另起一套并行机制，而是延续 [2026-07-20-batch-transfer-engine-design.md](2026-07-20-batch-transfer-engine-design.md)（下称"批量传输设计"）§3 已经选定的"方案 B"（批量任务放入工作线程），把它当时为了控制改动面而明确限定的适用范围——"仅新增的批量传输 RPC 使用线程，不改动其余同步 RPC 的执行模型"——正式放开，并同时补上它自己在 §2.1/§4.2 标注的前置条件（`ProgressPayload` 缺少 `id` 字段）。

按用户反馈确认的真实痛点排序：

- **M1（最高优先级，用户点名的真实卡顿场景）**：指纹相关三个 RPC（`unlock_fingerprint`/`rebind_fingerprint`/`setup_verify_fingerprint`，最长可卡 120 秒）+ 本设计所需的 `ProgressPayload.id` 前端改造 + 指纹单飞锁。
- **M2**：单文件 `encrypt_file`/`decrypt_file`（已经是 progress-aware，但仍在 dispatch 线程内同步执行）+ `ai_chat`。
- **M3**：网络测速 `network_speedtest_detect`/`run`/`compare_nodes`；以及实现时逐一核实后追加的 AI 其它方法（`ai_summarize_text_file` 等）与笔记侧耗时路径。

不纳入本次范围：scrypt 密码/恢复密钥解锁的 100-300ms 刻意延迟——这是防暴力破解的设计行为，量级远低于人能感知的"卡顿"，异步化对体验没有可感知的提升，反而增加复杂度。

## 2. 现状与约束

### 2.1 已有机制回顾（结论性引用，推导过程见批量传输设计 §2.1/§3，不重复）

- [backend_server.py](../../../modules/file_vault/backend_server.py) 的 `serve()`/`dispatch()` 主循环逐行同步处理 stdin；批量传输设计的 Task 5（让 `dispatch()`/`serve()` 识别 `ASYNC_DEFERRED` 哨兵）**已经落地**——`dispatch()`（backend_server.py:2480-2497）在调用完 handler 后检查 `result is batch_engine.ASYNC_DEFERRED` 并原样透传（2491-2492），`serve()`（backend_server.py:2500-2516）只在响应不是该哨兵时才调用 `_write()`（2515-2516），commit `efcc60f`（早于本设计文档自己的提交）已经带这个改动一起进来。批量传输计划里 Task 5 的复选框还显示未勾选，但对照代码这只是复选框没同步更新，不代表功能没做——本设计直接建立在这个已落地的机制上，第 4 节不再需要"谁先实现"的协调。
- `_write()` 已确认由 `_stdout_lock`（`threading.Lock`）保护（backend_server.py:81-88），多线程并发调用 `_write` 天然安全，本设计不需要再新增写回锁。
- 确认 `backend_server.py` 里**没有任何 `rpc_lock` 或清空 `_imk` 的动作**——`_imk` 一旦被 `rpc_unlock_password`/`rpc_unlock_totp`/`rpc_unlock_recovery`/`rpc_unlock_email_finish`/`rpc_unlock_fingerprint` 任一设置，在进程生命周期内不会被清空；`rpc_module_lock_settings_get/set` 只是前端"进入某个模块前要不要弹二次校验对话框"的设置项，不影响后端 `_imk` 状态。因此**不存在"后台线程还在用解锁前的旧状态、但主线程已经切换到锁定状态"的竞态**，本设计不需要为"异步操作执行期间应用被锁定"设计任何取消/回滚逻辑。

### 2.2 本次纳入范围的 RPC 清单（已核实的注册名与函数位置）

| RPC 注册名 | 处理函数 | 当前注册表 | 阻塞原因 | 里程碑 |
|---|---|---|---|---|
| `unlock_fingerprint` | `rpc_unlock_fingerprint`（backend_server.py:334） | `_METHODS` | Windows Hello 硬件验证，最长 120 秒（`fingerprint.py` 超时设定） | M1 |
| `rebind_fingerprint` | `rpc_rebind_fingerprint`（backend_server.py:440，调用 `identity.rewrap_fingerprint`） | `_METHODS` | 同上 | M1 |
| `setup_verify_fingerprint` | `rpc_setup_verify_fingerprint`（backend_server.py:211） | `_METHODS` | 同上，初次绑定时的验证 | M1 |
| `encrypt_file` | `rpc_encrypt_file`（backend_server.py:2279） | `_METHODS_WITH_PROGRESS` | 大文件磁盘 I/O + 加密，已有 `on_progress` 回调，但仍在 dispatch 线程内同步跑完才返回 | M2 |
| `decrypt_file` | `rpc_decrypt_file`（backend_server.py:2307） | `_METHODS_WITH_PROGRESS` | 同上 | M2 |
| `ai_chat` | `rpc_ai_chat`（backend_server.py:781） | `_METHODS` | 网络请求，耗时不可控 | M2 |
| `network_speedtest_detect` | `rpc_network_speedtest_detect`（backend_server.py:2006） | `_METHODS` | 需要探测代理等网络环境 | M3 |
| `network_speedtest_run` | `rpc_network_speedtest_run`（backend_server.py:2016） | `_METHODS_WITH_PROGRESS` | 设计上就是 5-10 秒（DNS 解析 + 多节点探测） | M3 |
| `network_speedtest_compare_nodes` | `rpc_network_speedtest_compare_nodes`（backend_server.py:2138） | `_METHODS_WITH_PROGRESS` | 依次探测多个公共节点（Hetzner 法兰克福/赫尔辛基/阿什本）的 ping/下载，与 `run` 测单一路径不同，节点数量越多耗时越长 | M3 |

上表所有行的函数位置与注册表归属均已直接对照当前 `backend_server.py` 核实（非估计值）。其余 AI 相关方法（`ai_summarize_text_file`/`ai_read_text_file`/`ai_skill_*`）与笔记侧可能存在的耗时路径（FTS 重建等），本设计确认第 3 节的机制本身适用，但具体注册名、是否已经 progress-aware，留到对应里程碑实施前用同一方式（grep `_METHODS`/`_METHODS_WITH_PROGRESS` 字面量）逐一核实，不在本文档里假设未核实的签名——延续批量传输设计的实施计划里对 `setup_complete` 参数形状的同类提醒（"先核实真实签名，不要照抄占位"）。这份清单本身也不是一次性冻结的快照：这个分支目前有并发的其它会话/自动化任务在持续提交（本设计撰写期间 `backend_server.py` 就已经被后续提交改动过一次），实施前应重新跑一遍上面的 grep 核对行号，不要直接信任本表的行号长期有效。

### 2.3 IPC 契约缺口：`ProgressPayload` 需要补充 `id`

批量传输设计 §2.1/§4.2 已经指出：前端进度事件目前只按 `method` 字符串过滤，不含 `id`；协议层的 NDJSON 消息本身是带 `id` 的（`{"id": request_id, "progress": {...}}`）。批量传输设计把自己的适用范围限定成"同一时刻只允许一个 `BatchConflictDialog`/一个批量操作"，所以同一方法名不会有两个并发请求同时推进度，暂时不需要修这个。

**本设计的范围突破了这个前提**：指纹验证、AI 对话、单文件加解密、网络测速分属完全不同的界面/场景，用户很可能真的会连续触发同一个方法两次（例如第一个文件还在加密时就对第二个文件发起加密）。逐层追踪实际的过滤逻辑落在哪里（不是最初设想的 `ipcTypes.ts`/`vaultApi.ts`——`vaultApi.ts` 只是 `export const vaultApi = window.vaultAPI` 三行的重导出，本身不含任何过滤逻辑）：

- [electron/main.ts](../../../modules/file_vault/ui/electron/main.ts)（约 339-340 行）把 progress 消息广播给渲染进程时用的是 `event.sender.send('vault:progress', { method, ...progress })`——广播payload 在这一步就已经把 `id` 丢弃了，是真正需要补 `id` 的地方；
- [electron/pythonBridge.ts](../../../modules/file_vault/ui/electron/pythonBridge.ts) 内部其实已经有一个按 `id` 索引的 `pending` map 用来关联请求和响应，但从未把这个 `id` 暴露给调用方——`window.vaultAPI.call()` 目前只返回 `Promise<Result>`，调用方今天没有任何办法拿到"这是我这次调用的 id"，这是真正的架构缺口：需要让 `call()`（或等价入口）把分配到的 `request_id` 交回给调用方（例如改造成返回 `{id, promise}`，或者让 `onProgress` 回调本身带上 `id`），而不只是简单地"改过滤条件"；
- 拿到 `id` 之后，`ipcTypes.ts` 的 `ProgressPayload` 类型增加 `id: number` 字段，`main.ts` 的广播 payload 带上它，各消费方组件——已确认 [NotesScreen.tsx](../../../modules/file_vault/ui/src/components/NotesScreen.tsx)（约 1789-1790 行）、[FilesPane.tsx](../../../modules/file_vault/ui/src/components/FilesPane.tsx)（约 180-182 行）目前都用 `payload.method !== 'x'` 过滤，本设计新增 RPC 里会推进度的（`encrypt_file`/`decrypt_file` 已经在上面两个文件里；`network_speedtest_run`/`network_speedtest_compare_nodes` 对应 [NetworkSpeedTestScreen.tsx](../../../modules/file_vault/ui/src/components/NetworkSpeedTestScreen.tsx)，约148/708行）同理——都改成按 `method` + `id` 过滤（`FileManagerScreen.tsx` 与本设计无关，它的进度消费者是 `file_clip_paste`/`file_clip_delete`，属于 fileops 模块，不在本设计范围内，不要误改）；
- 完成后，批量传输设计自己也可以借此解除"同一时刻只允许一个批量操作"的限制，但那是它的范围，不在本设计里展开实现。

## 3. 核心机制

### 3.1 沿用 `submit_batch_task`，不新建并行机制

- 每个纳入范围的 `rpc_*` handler，把函数体包进 `batch_engine.submit_batch_task(request_id, fn, _write)`，立即返回 `ASYNC_DEFERRED`。
- 目前注册在 `_METHODS`（签名只有 `(params)`，没有 `request_id`）的——`rpc_unlock_fingerprint`/`rpc_rebind_fingerprint`/`rpc_setup_verify_fingerprint`/`rpc_ai_chat`/`rpc_network_speedtest_detect`——需要迁移到 `_METHODS_WITH_PROGRESS` 注册表（签名改成 `(params, request_id)`），即使不主动调用 `_throttled_progress` 汇报中间进度，也需要这个签名才能拿到 `request_id` 传给 `submit_batch_task`。这是纯签名/注册表迁移，不改变这些 RPC 本身的业务逻辑。
- 已经在 `_METHODS_WITH_PROGRESS` 里的（`rpc_encrypt_file`/`rpc_decrypt_file`/`rpc_network_speedtest_run`/`rpc_network_speedtest_compare_nodes`——后者容易被漏掉，务必确认它和 `run` 一起转换，它依次探测多个节点、是这几个 RPC 里最慢的一个），签名不用变，只需要把函数体包进 `submit_batch_task` 的 `fn` 闭包，原有的 `_throttled_progress` 调用挪到闭包内部。

### 3.2 指纹类 RPC 的单飞锁

Windows Hello 底层、以及 `fingerprint.py` 里 `winrt` 回退路径的 COM/STA 限制，都不适合真正并发跑两次验证。`unlock_fingerprint`/`rebind_fingerprint`/`setup_verify_fingerprint` 三个 RPC 共享同一把 `threading.Lock`（建议放在 `fingerprint.py`，与被调用的底层验证函数放在一起，而不是分散在 `backend_server.py` 的三处 handler 里各自维护状态）。用 `acquire(blocking=False)`：拿不到锁立即返回 `{"ok": False, "error": "auth.fingerprint_verification_in_progress"}`——注意这个形状必须和这三个 handler 自己现有的早退错误路径保持一致（如 backend_server.py:338/345/352 的 `{"ok": False, "error": "<code>"}`，一个内层是普通字符串的正常返回值），**不能**写成 `{"error": {"message": ...}}`——后者是 `dispatch()` 异常处理分支（backend_server.py:2496-2497）和 `submit_batch_task` 捕获异常时专用的协议顶层错误信封，从 handler 内部直接返回这个形状会让 `translateError` 期望的字符串错误码变成一个对象，而如果改用 raise 的方式抛出又会让 `pythonBridge.ts` 走 reject 分支，`UnlockTabs.tsx` 现在是不加 catch 的 `await vaultApi.call(...)`，会直接抛出未处理的 rejection——恰好是本设计想保护的"用户连续点两次验证"场景被这个不匹配的错误形状搞砸。不排队等待——同一时刻只允许一次硬件交互，这是合理的产品限制，不是权宜之计，需要新增一条 i18n 错误文案（6 语言）。

### 3.3 子系统写锁：复用批量传输设计 §3 已经定好的规则，不另立一套

批量传输设计 §3 已经为"批量任务的线程写入 vs 常规同步 RPC 的写入"定了规则：写入仍然复用现有的单一写入路径（`storage.insert_note`、`save_password_vault` 等），并在**实际写入调用这一步**用一个进程级锁短暂互斥（锁粒度限定在写入本身，不覆盖整个任务的哈希/读取阶段）。本设计延续同一条规则：

- 若某个新纳入的异步 RPC 会写入某个已有 SQLite 连接（例如 `rpc_ai_chat` 如果把对话历史写入 `ai_history` 存储，而其它同步的 `ai_history_*` RPC 也读写同一个连接），复用批量传输设计定义的那把子系统写锁，不新增第二套锁机制。
- `clipboard` 子系统不需要新增锁——它已经是"单一后台监听线程写、其它线程只读"的既有模式，[clipboard/storage.py](../../../modules/file_vault/clipboard/storage.py) 的注释已经把这个假设写清楚（`check_same_thread=False` 是因为只有监听线程写）。本设计新增的 RPC 都不会往 clipboard 的连接写数据，不改变它的假设，不需要改动。
- 指纹/AI/网络测速三类如果本身不涉及与其它同步 RPC 共享的可写状态（例如 `unlock_fingerprint` 只是设置进程内存里的 `_imk` 全局变量，`network_speedtest_detect` 只读探测环境不写库），则不需要额外的写锁，只需要 3.1/3.2 描述的哨兵化 + （指纹的）单飞锁。
- **`network_speedtest_run` 是例外，需要写锁**：它成功后会调用 `history.record_result(...)`（`network_speedtest/storage.py` 的 `NetworkSpeedtestHistoryService.record_result`），写入的是同一个 `check_same_thread=False` 的 SQLite 连接（`network_speedtest/storage.py:65`）；这个连接目前也被仍保持同步、本设计范围外的 `network_speedtest_history_set_tag`/`network_speedtest_history_clear` 读写。今天单线程串行调度天然保证两者不会同时写；`run` 改成后台线程执行后，这个连接第一次出现真正的并发写者（用户在一次测速还没跑完时去给历史记录改标签/清空历史）。按本节的既有原则处理：`record_result` 这一步写入复用一把该子系统专属的 `threading.Lock`（不需要覆盖到测速本身的网络请求阶段），`history_set_tag`/`history_clear` 的写入也要用同一把锁——这两个 RPC 本身不需要异步化（它们不慢），只是需要在写入这一步跟 `record_result` 互斥。

### 3.4 结果传递与错误语义

沿用 `submit_batch_task` 已经验证过的转换规则：`errors.VaultError` → `{"error": {"message": exc.code}}`，其它未预期异常 → `{"error": {"message": "internal.unexpected"}}`。指纹类 RPC 已有的具体错误码（`device_not_present`/`not_configured`/`disabled_by_policy`/`device_busy`/`retries_exhausted`/`helper_not_found`，`fingerprint.py` 已实现）异步化后原样透传，不改动错误分类逻辑本身。

## 4. 与批量传输引擎的关系

两份设计依赖同一个哨兵机制（`dispatch()`/`serve()` 识别 `ASYNC_DEFERRED`）。该机制（批量传输设计的 Task 5）**已经落地**（见 2.1 节），本设计不需要再协调"谁先实现"，直接在此基础上开工即可。

批量传输设计自己的计划里仍然待完成的部分——Task 6（"批量任务运行期间其它 RPC 不被卡住"的并发回归测试，`test_async_rpc_does_not_block_unrelated_synchronous_rpc`，本文档核实过目前尚不存在）、Task 7-9（`files_batch_preflight`/`files_batch_execute` 两个批量专用 RPC）——都是本设计范围之外的、专属于批量传输场景的具体 RPC 和测试，与本设计新纳入的 RPC（指纹/单文件加解密/AI/测速）没有交集，两边可以并行推进，不互相阻塞。

2.3 节的 `ProgressPayload.id` 改造由本设计的 M1 负责实现（批量传输设计明确把这个前提标注为"未来如果需要才做"，本设计正是那个"未来"）；完成后批量传输设计可以按需选择是否解除自己"同一时刻一个批量操作"的限制，不属于本设计的实现范围。

## 5. 测试矩阵

复用已落地的 Task 5 测试所用的 `send()`/`read_one()` 底层技术（`test_backend_server.py` 的 `BackendClient`），按批量传输设计 Task 6 *计划描述*的并发回归模式（`send()` 一个已知耗时的异步请求，紧接着 `send()` 一个无关同步请求，断言后者先返回；该模式本身截至本文档撰写时还只是计划、尚未实现为测试）逐一补测试，对每个纳入范围的 RPC 各补一条：

- **M1**：`unlock_fingerprint`/`rebind_fingerprint`/`setup_verify_fingerprint` 运行期间，无关 RPC（如 `note_list`）不被阻塞；连续发起两次指纹验证，第二次立即收到 `auth.fingerprint_verification_in_progress`，不排队、不阻塞发起方；`ProgressPayload.id` 改造后，两个并发的同名方法调用（构造测试场景）各自的进度事件能被正确区分，不串号。
- **M2**：连续对两个不同文件发起 `encrypt_file`，两者并发执行、互不阻塞、结果不串（用返回的 `sha256_plaintext`/输出路径互相校验没有张冠李戴）；`ai_chat` 执行期间其它 RPC 不被阻塞。
- **M3**：`network_speedtest_run`、`network_speedtest_compare_nodes`（容易被漏测，务必和 `run` 各补一条）执行期间前端仍能正常操作笔记/剪贴板等无关页面；测速运行期间调用 `network_speedtest_history_set_tag`/`network_speedtest_history_clear` 不出现写冲突/数据丢失（验证 3.3 节新增的写锁）。

前端目前无自动化测试框架，`ProgressPayload.id` 相关的前端改造采用手动走查：连续对两个文件发起加密，确认两条进度条分别推进、不互相覆盖。

## 6. 完成标准

每个里程碑独立满足以下条件才算完成：

- 该里程碑范围内的后端测试全部通过，且不引入既有测试回归（`python -X utf8 -m pytest modules/file_vault/tests/ -q`）；
- `tsc --noEmit`、`npm run lint` 通过；
- 该里程碑覆盖的场景完成一次手动 GUI 走查（尤其是 M1：真实触发一次指纹验证，期间切到笔记/剪贴板页面确认不卡顿）；
- 桌面快捷方式/注册表指向的可执行文件确认已更新为最新构建。

M1 完成、`ProgressPayload.id` 落地后，建议同时通知批量传输引擎那条线的实现者/后续会话，确认是否要顺带解除它自己的"同一时刻一个批量操作"限制——这是一个可选的后续收益，不阻塞本设计任何一个里程碑的完成。
