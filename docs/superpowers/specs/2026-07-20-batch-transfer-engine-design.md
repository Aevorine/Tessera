# File Vault 统一批量导入/导出引擎设计

日期：2026-07-20

## 1. 范围与里程碑

目标：让 File Vault 内所有导入/导出流程——加密文件（`.ivault`）、笔记（导入、txt/md 导出、DOCX/PDF 导出）、密码 CSV（导入、导出）——具备一致的体验：

- 选择阶段支持多选、全选/取消全选、单项勾选；
- 执行前对内容是否相同做判断，相同则默认跳过，不影响批次其余项；
- 同名不同内容时，执行前给出集中的冲突清单，可逐项选择覆盖/自动改名/跳过，并支持“应用到全部”；
- 单项失败不中断整批；
- 交互和进度反馈保持流畅，不因为大批量任务卡住整个应用。

本设计覆盖完整架构和三类流程的判定规则，但实现按里程碑推进，与本仓库既有的 milestone 惯例（见 [2026-07-17-password-v4-history-model-design.md](2026-07-17-password-v4-history-model-design.md)）一致：

- **M1**：后端并发模型改造（新增批量任务工作线程）+ 加密文件（encrypt/decrypt）批量流程接入统一预检/冲突引擎。
- **M2**：笔记导入、txt/md 导出接入；新增 `content_sha256` 字段与查重索引；DOCX/PDF 导出改为仅做同名冲突处理（不做内容级跳过）。
- **M3**：密码 CSV 导入（复用现有 `plan_csv_import` 分类，接入统一冲突面板 UI）、CSV 导出新增条目多选与同名冲突处理；同时修正两处已发现的安全默认值不一致（详见 6.2 节，对应测试见 9.1/9.2 节）。

各里程碑独立可交付、独立测试，后一里程碑复用前一里程碑产出的共享组件（`BatchConflictDialog`、后端工作线程调度、`BatchPlanItem`/`BatchPreflightResult` 类型），不重复造轮子。

## 2. 现状与约束

### 2.1 后端调度模型（硬约束）

[backend_server.py](../../../modules/file_vault/backend_server.py) 的主循环逐行阻塞读取 stdin：

```python
for line in in_stream:
    request = json.loads(line)
    _write(dispatch(request))   # 完全同步——处理完当前请求才读下一行
```

没有线程或异步调度。任何长任务（哪怕只是流式哈希预检）都会阻塞同一进程内的全部其他 RPC，包括与该任务无关的 `note_list`、`password_list` 等常规读操作。这是当前架构下“流畅不卡顿”要求无法达成的根本原因，M1 必须解决。

RPC 分发已有两类注册表：`_METHODS`（同步）与 `_METHODS_WITH_PROGRESS`（额外传入 `request_id`，配合 `_throttled_progress` 节流回调，约 100ms 一次，`done == total` 时必发）。进度消息走 `{"id": request_id, "progress": {...}}`，通过 stdout 一行一条 NDJSON 回传，`_write` 已有 `_stdout_lock` 保护并发写。前端 `ProgressPayload` 目前只按 `method` 字符串过滤（不含 `id`），此前不出问题是因为后端本来就串行处理、同名方法不可能并发。M1 引入线程执行后这个假设不再成立，但本设计范围内 UI 层每次只允许打开一个 `BatchConflictDialog`/发起一个批量操作（见 4.2 节），因此同一批量方法名不会有两个并发请求同时向前端推送进度，`ProgressPayload` 现状不需要改动；如果未来允许同时并行发起多个批量操作，需要先给 `ProgressPayload` 补上 `id` 字段再放开这个限制。

### 2.2 现有批量能力与缺口

- **加密文件**（[container.py](../../../modules/file_vault/container.py)）：`encrypt_file`/`decrypt_file` 单文件、4 MiB 分块、`(chunks_done, total_chunks)` 进度回调；加密时顺带流式计算明文 SHA-256 并写入容器加密 metadata（`ContainerHeader.sha256_plaintext`），`read_header()` 可在不解密全文件的情况下取到该值；同路径写入前有 `_check_not_same_file` 保护；输出统一走 `<name>.part` 临时文件 + `Path.replace()` 原子替换 + `except BaseException` 清理。**FilesPane 当前批量导入/导出未做输出路径去重、未做内容比对跳过，也无冲突处理**——多个同名源文件会互相覆盖批次内的输出。
- **笔记**（[NotesScreen.tsx](../../../modules/file_vault/ui/src/components/NotesScreen.tsx)、[notes/service.py](../../../modules/file_vault/notes/service.py)）：`note_import_files` 无任何查重，重复导入同一文件会创建重复笔记；`note_export_files`（txt）已有本仓库内**唯一**的冲突处理参考实现——`_sanitize_filename` + 批次内/磁盘上重名时追加 `" (2)"` 序号；DOCX/PDF 导出（`buildDocxDocument`/`buildPdfHtml` + `printToPDF`）目前是单笔记、单目标文件、无进度、无冲突处理的独立路径。笔记完全没有内容哈希字段，`notes/service.py`、`notes/storage.py` 都不含 `sha256`。
- **密码 CSV**（[passwords.py](../../../modules/file_vault/passwords.py)、[PasswordScreen.tsx](../../../modules/file_vault/ui/src/components/PasswordScreen.tsx)）：导入已经是预检+确认两阶段（`password_import_csv_preview` → `plan_csv_import` 产出 `add/update/unchanged/superseded_in_batch` 分类 → `password_import_csv_confirm`），但前端没有把这个分类接入统一冲突 UI，且**不暴露 `delete_source_csv` 开关**（后端默认 `true`，导入后总会安全删除源文件，用户无从得知或阻止）。导出（`password_export_csv`）**无条目选择、无覆盖保护**——`open(path, "w")` 直接覆盖，且总是导出全部条目。
- **FilesPane 源文件删除复选框默认值与文档矛盾**：[FilesPane.tsx](../../../modules/file_vault/ui/src/components/FilesPane.tsx) 中加密/解密的“删除源文件”复选框都默认勾选 `true`，但后端参数默认 `false`，项目文档描述的行为也是默认不删除源文件。

### 2.3 IPC 契约现状

[ipcTypes.ts](../../../modules/file_vault/ui/src/shared/ipcTypes.ts) 里进度类型只有 `ProgressEvent { done, total }` 和按方法名扩展的 `ProgressPayload`（如 `NoteImportProgress`），**没有统一的批量冲突/结果类型**，也没有请求级别的进度隔离（`ProgressPayload` 只带 `method` 字符串，不带 `id`；目前之所以不出问题是因为后端本来就单线程串行处理，同名方法不会并发）。[vaultApi.ts](../../../modules/file_vault/ui/src/lib/vaultApi.ts) 每次 RPC 调用是 `ipcRenderer.invoke('vault:call', method, params)`，底层 [pythonBridge.ts](../../../modules/file_vault/ui/electron/pythonBridge.ts) 用自增 `id` 管理未完成请求的 Promise，JS 侧本身不做请求排队——排队完全发生在 Python 单线程读取 stdin 的过程中。

## 3. 后端并发模型：新增批量任务工作线程

评估两个方案：

- **方案 A（维持单线程）**：只优化分块粒度和节流频率。改动最小，但批量任务运行期间应用其它页面仍会整体卡死，不满足“不卡顿”的明确要求。
- **方案 B（批量任务放入工作线程，推荐）**：主 stdin 读取循环保持不变；新增的批量传输类 RPC（预检 + 执行）在收到请求后，把实际的哈希计算/加解密/文件读写派发到一个独立线程执行，主循环立刻可以读取并处理下一行请求。进度和最终结果仍通过 `_write`（已有 `_stdout_lock`）回传，天然线程安全。

采纳方案 B，范围限定为“仅新增的批量传输 RPC 使用线程”，不改动其余同步 RPC 的执行模型，改动面可控。

实现要点：

- 引入一个简单的任务执行工具（例如 `core` 之外的 `modules/file_vault` 内部模块，不跨模块 import），对外暴露“提交一个批量任务，立即返回 `request_id`，通过现有 progress 通道汇报进度，最终通过一条 `{"id": request_id, "result": ...}` 消息交付结果”的语义——从协议角度看，与现有 `_METHODS_WITH_PROGRESS` 完全兼容，前端不需要感知这是线程执行还是同步执行。
- 同一批量任务读写的数据（笔记表、密码库 `entries`）需要与常规同步 RPC 互斥，避免线程执行批量导入的同时，另一个同步 RPC 修改了同一份内存数据。做法：批量任务对笔记/密码库的写入仍然复用现有单一写入路径（`storage.insert_note`、`save_password_vault` 等），并在写入这一步用一个进程级锁短暂互斥（锁粒度限定在实际写入调用，不覆盖整个批量任务的哈希/读文件阶段，以免退化回方案 A 的效果）。
- 取消/异常传播：线程内异常需要被捕获并转换成标准的 `{"id": request_id, "error": {...}}` 消息，不能让子线程未捕获异常导致进程状态不一致；本设计不实现用户主动取消批量任务（超出当前需求范围），失败或完成后线程自然结束。

## 4. 统一批量传输流程

```
选择来源（多选/全选/单选）
        ↓
预检 RPC（各流程各自实现，返回统一形状）
        ↓
冲突面板（相同则跳过 / 同名不同内容 → 覆盖·改名·跳过 / 应用到全部）
        ↓
执行 RPC（工作线程执行，逐项流式处理，节流进度回调）
        ↓
批次汇总（成功 / 跳过-内容相同 / 跳过-用户选择 / 改名 / 覆盖 / 失败列表）
```

### 4.1 共享类型（新增到 ipcTypes.ts）

```ts
export interface BatchPlanItem {
  key: string                 // 批次内稳定 id
  sourceLabel: string         // 展示名（文件名 / 笔记标题 / CSV 行摘要）
  status: 'new' | 'unchanged' | 'conflict' | 'error'
  conflictReason?: 'name_exists_diff_content' | 'duplicate_in_batch'
  errorCode?: string          // status === 'error' 时的错误码
}

export interface BatchPreflightResult {
  items: BatchPlanItem[]
  // 便捷投影，不是独立数据源：恒等于 items 中 conflictReason === 'duplicate_in_batch' 的 key 集合，
  // 只是让前端不用每次都重新过滤 items。实现和测试都必须保证两者不会不一致。
  duplicateOutputsInBatch: string[]
}

export type BatchResolution = 'overwrite' | 'rename' | 'skip'

export interface BatchExecuteSummary {
  success: number
  skippedUnchanged: number
  skippedByUser: number
  renamed: number
  overwritten: number
  failed: Array<{ key: string; error: string; error_params?: Record<string, unknown> }>
}
```

两种 `conflictReason` 的处理方式不同，`BatchConflictDialog` 需要区分对待：

- **`name_exists_diff_content`**（磁盘上已存在同名不同内容的目标）：必须交给用户决策（覆盖/改名/跳过），因为覆盖会破坏磁盘上已有的数据，不能自动决定。
- **`duplicate_in_batch`**（批次内部两个不同来源规划到同一个尚不存在的目标路径，即 §2.2 描述的 M1 要修复的那个 bug）：不涉及破坏已有数据，因此**默认自动解决**——复用笔记导出已有的 `_sanitize_filename` + `" (2)"` 序号追加算法，对冲突的第二个及之后的项自动改名，不需要用户逐项确认。`BatchConflictDialog` 仍然把这些项在“批次内重名（已自动改名）”分组里展示，让用户能看到实际生效的输出文件名，但不要求交互；用户也可以手动改成 overwrite/skip（例如确认只需要其中一份）。批次内重名与目标磁盘冲突可能叠加（自动改名后的新名字恰好也在磁盘上已存在）——预检需要按“先批内去重、再和磁盘比对”的顺序迭代解决，直到规划出的最终目标路径集合内部不重复、且每个仍与磁盘冲突的路径都转为 `name_exists_diff_content` 交给用户处理。

三类流程各自实现预检/执行 RPC（方法名各自命名，如 `files_batch_preflight`/`files_batch_execute`，`note_import_preflight`/`note_import_execute`，`note_export_preflight`/`note_export_execute`），但输入输出都收敛到上面的共享类型上，前端只需要一个通用的 `BatchConflictDialog` 组件消费 `BatchPreflightResult` 并产出 `Map<key, BatchResolution>`。

### 4.2 前端组件

新增 `BatchConflictDialog`（放在文件/笔记/密码三个 screen 共用的位置，遵循现有跨组件复用惯例），职责：

- 展示 `new`（将正常执行）、`unchanged`（默认跳过，可勾选强制执行）、`conflict`（细分两个子分组：需要用户决策的“同名不同内容” conflictReason `name_exists_diff_content`，以及已自动改名、仅供确认的“批次内重名” conflictReason `duplicate_in_batch`）、`error`（只读展示，不可执行）四类分组；
- 顶部“应用到全部”下拉，仅作用于 `conflictReason === 'name_exists_diff_content'` 的项（`duplicate_in_batch` 已自动解决，不需要批量指定）；
- 确认后调用对应执行 RPC，展示执行进度（复用 `NoteImportProgress` 的 `fileIndex/totalFiles/fileName` 模式，扩展到三类流程共用），完成后展示 `BatchExecuteSummary`；
- 全应用同一时刻只允许一个 `BatchConflictDialog` 处于打开/执行状态（发起新批量操作前必须等当前对话框关闭），这也是 2.3 节里 `ProgressPayload` 不需要补充请求 id 就能安全按方法名过滤的前提。

## 5. 内容一致性判定（按流程）

| 流程 | 判定依据 | 备注 |
|---|---|---|
| 加密文件 → `.ivault` | 目标 `.ivault` 已存在时，读取其 header 的 `sha256_plaintext`；源文件流式计算 SHA-256 比较 | 源文件必须读一遍，无法避免；目标只需读 header，不需解密全文 |
| 解密 `.ivault` → 明文 | 源容器 header 自带 `sha256_plaintext`；目标文件已存在时流式计算其 SHA-256 比较 | 只需完整读一遍目标文件 |
| 笔记导入 | 新增 `content_sha256`（`notes/storage.py` 加列 + 建索引），只对正文内容计算哈希（不含标题），对已存在笔记按哈希查重 | 命中则整条跳过，不创建新笔记；新老笔记迁移时批量补算哈希（见 6.1）。因为导入笔记的标题来自 `path.stem`（源文件名），只按正文查重意味着两个正文完全相同、文件名不同的源会被判定为同一内容而跳过——这是有意选择（去重目的是避免重复正文），需要在冲突面板的展示文案里说明“已跳过：与笔记《X》内容相同”，避免用户误以为是文件名重复。**同一批次内部**若有多个源文件正文哈希相同，预检阶段就要按与 4.1 节 `duplicate_in_batch` 相同的原则处理：预检时一次性对整批源文件算完哈希、在提交给用户前就把批内重复项标记出来（只保留第一个为 `new`，其余标记为 `unchanged` 并注明“与本批次内《X》内容相同”），而不是让执行阶段按顺序插入、依赖“第一项写入 DB 后第二项才查得到”这种时序副作用——否则预检展示的数量与实际执行结果会对不上 |
| 笔记导出 txt/md | 目标文件存在时，流式计算其内容 SHA-256，与待导出正文哈希比较 | 复用现有 `_sanitize_filename` + 序号规则处理同名不同内容 |
| 笔记导出 DOCX/PDF | 不做内容级别判断，只做同名冲突处理 | 生成字节流本身不稳定（内嵌时间戳等元数据），字节比较没有意义 |
| 密码 CSV 导入 | 复用现有 `plan_csv_import` 的 `add/update/unchanged/superseded_in_batch` | 已是预检模型，只需要把分类结果映射进 `BatchPlanItem`，不新增判定逻辑 |
| 密码 CSV 导出 | 仅做目标文件名冲突判定（覆盖/改名/跳过） | 导出内容是所选条目的实时状态，与“目标文件已有内容”比较意义不大 |

## 6. 分里程碑实现细节

### 6.1 M2：笔记内容哈希迁移

`notes/storage.py` 新增 `content_sha256` 列。已有笔记在首次被批量导入/导出流程引用之前不含该值：

- 新建/更新笔记时（无论是否走批量流程）同步计算并写入 `content_sha256`；
- 索引查重（`WHERE content_sha256 = ?`）本身找不到 `content_sha256` 为 NULL 的历史笔记，因此不能仅依赖索引查找。批量导入预检需要在索引查重之外，额外对当前仍为 NULL 的笔记做一次有界回退扫描：逐条读取这些笔记的正文、现算哈希用于比较，并顺手把算出的哈希回写到该笔记（无论这次是否命中重复），从而让 NULL 集合随着每次导入操作递减，直至全部迁移完成、回退扫描自然收敛为空扫描。这不是启动时的一次性全库扫描，而是分摊在每次批量导入预检里的增量迁移，扫描代价随未迁移笔记数量递减；若未迁移笔记基数很大导致单次预检明显变慢，可作为后续里程碑的性能加固项，不阻塞 M2 完成。

### 6.2 M3：安全默认值修正

- `FilesPane.tsx` 加密/解密的“删除源文件”复选框默认值由 `true` 改为 `false`，与后端参数默认值和现有文档保持一致。
- `PasswordScreen.tsx` CSV 导入新增“导入后删除源 CSV 文件”复选框，默认保持现状（`true`，因为这是既有生产行为，静默改变默认值本身是另一种风险），用户此前看不到、无法取消勾选的问题得到修正；行为默认值不变，只新增可见性和可关闭性。

## 7. 错误处理与部分失败语义

- 预检阶段的读取失败（源文件不存在、笔记已被删除等）标记为 `BatchPlanItem.status === 'error'`，不进入可执行清单。
- 执行阶段任意一项失败只记入 `BatchExecuteSummary.failed`，批次其余项继续执行，不中断。
- 覆盖/改名写入沿用容器已有的 `.part` 临时文件 + 原子替换 + `except BaseException` 清理模式，写入失败不会留下半截文件、不会破坏原目标文件。
- 执行完成后的汇总（成功/跳过-内容相同/跳过-用户选择/改名/覆盖/失败）通过一个批次级 toast/面板呈现，失败项可展开查看具体错误码（复用现有 i18n 错误翻译）。

## 8. i18n

需要在 `files.json`、`notes.json`、`passwords.json` 的六个语言目录（en/zh/fr/es/ru/ar）新增的文案类别：

- 预检状态：内容相同（将跳过）、新增、冲突、错误；
- 冲突解决动作：覆盖、自动改名、跳过、应用到全部；
- 批次执行进度：当前文件/总数、已用时；
- 批次汇总：成功数、跳过数（内容相同/用户选择）、改名数、覆盖数、失败数；
- CSV 导入删除源文件复选框文案（新增可见性）。

## 9. 测试矩阵

### 9.1 后端

- 内容哈希判定：文件与笔记场景下“内容相同→跳过”“内容不同→冲突”分类正确性。
- 批次内部重名目标检测（两个不同源规划到同一目标路径）。
- 自动改名算法的唯一性：不与磁盘现有文件冲突，也不与同批次其它规划输出冲突。
- 覆盖场景原子性：模拟写入中断，断言原目标文件不受损、`.part` 临时文件被清理。
- 单项失败不影响其余项：构造混合 成功/跳过/冲突/失败 的批次，断言其余项正常完成、汇总计数准确。
- 笔记 `content_sha256`：新建/更新时正确写入；查重命中/不命中的准确性；同一批次内两个源文件正文内容相同时，预检阶段就标记后者为批内重复（而非依赖执行阶段的插入顺序），且预检展示的“将导入”数量与执行后实际新建的笔记数量一致；**回退扫描正确性**——构造一条 `content_sha256` 为 NULL 的历史笔记，导入一个与其正文相同的文件，断言预检能通过回退扫描命中该笔记（不是被索引查重漏掉）并标记为跳过，且该笔记的 `content_sha256` 在预检后被正确回写；多次导入后 NULL 笔记集合单调递减。
- 密码 CSV：沿用现有 `plan_csv_import` 测试基础，新增导出侧的同名冲突分支（覆盖/改名/跳过）。
- 后端并发模型：批量任务运行期间，主循环仍能及时响应无关的其它 RPC（如 `note_list`）不被阻塞——用一个模拟的长批量任务 + 并发发起的普通 RPC 请求断言后者不被卡住。
- M3 安全默认值修正（对应 6.2 节）：`rpc_password_import_csv_confirm` 未显式传入 `delete_source_csv` 时仍保持默认 `True`（确认默认行为不因新增可见性而静默改变）；显式传入 `delete_source_csv: False` 时源文件不被删除（确认新增的开关参数确实生效，不只是前端展示）。

### 9.2 前端

当前 UI 层无自动化测试框架，采用手动 GUI 走查验收，覆盖：

- 三类流程分别验证多选/全选/取消全选；
- 预检冲突面板展示是否准确（相同内容分组、批次内重名分组、需用户决策的冲突分组、错误分组）；
- 逐项选择与“应用到全部”是否生效（且确认“应用到全部”不影响已自动改名的批次内重名项）；
- 批量执行进度条与最终汇总是否准确；
- 大文件与大量小文件两种场景下应用整体响应是否流畅（切换到其它页面不卡顿）；
- M3 安全默认值修正的 GUI 验证（对应 6.2 节）：FilesPane 加密/解密对话框打开时“删除源文件”复选框默认处于未勾选状态；PasswordScreen CSV 导入预览对话框中新增的“导入后删除源 CSV 文件”复选框可见、默认勾选，且取消勾选后源文件确实被保留。

## 10. 完成标准

每个里程碑独立满足以下条件才算完成：

- 该里程碑范围内的后端测试全部通过，且不引入既有测试回归；
- `npm run lint`、`npm run build` 通过；
- 桌面快捷方式/注册表指向的可执行文件确认已更新为最新构建；
- 该里程碑覆盖的流程完成一次手动 GUI 走查（含冲突面板、跳过、改名、覆盖、批量失败场景）。

M1 完成后再评估是否需要针对方案 B 的线程模型做额外的压力测试（大量并发 RPC + 批量任务同时运行），作为进入 M2 前的可选加固项，不作为 M1 硬性完成条件。
