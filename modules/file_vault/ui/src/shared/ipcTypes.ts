// Shared by electron/main.ts, electron/preload.ts and the renderer; mirrors backend_server.py's RPC list exactly.

export interface RuntimeMetricsSnapshot {
  capturedAtMs: number
  cpuPercent: number
  workingSetBytes: number
  privateMemoryBytes: number
  totalMemoryBytes: number
  freeMemoryBytes: number
  processCount: number
  uptimeSeconds: number
}

export interface SmtpConfigInput {
  host: string
  port: number
  username: string
  password: string
  use_ssl: boolean
}

export interface SmtpConfigPublic {
  host: string
  port: number
  username: string
  use_ssl: boolean
}

// api_key: blank on input means keep existing; never echoed back (see AiConfigPublic), like the SMTP password.
/**
 * 可选模型的界面信息。`released`/`note` 可为 null：模型列表永远以服务端返回为准，
 * 本地说明表（ai_client.DEEPSEEK_MODEL_CATALOG）只补描述、不过滤，陌生模型名照样列出。
 */
export interface AiModelDetail {
  id: string
  /** 人看得懂的名字，例如 "DeepSeek-V4-Flash-0731"。表里没有时就是 id 本身。 */
  label: string
  /** 发布日期 YYYY-MM-DD；未知为 null。 */
  released: string | null
  /** 一句话说明（参数规模、上下文长度、是否支持思考模式）。 */
  note: string | null
  /** 官方停用日期；非 null 表示这个模型已经调不通了，界面要拦住用户选它。 */
  deprecated: string | null
}

export interface AiConfigInput {
  api_key?: string
  model?: string
  base_url?: string
}

export interface AiConfigPublic {
  model: string
  base_url: string
  configured: boolean
}

export interface AiChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

// A user-authored instruction block imported from SKILL.md (or a folder containing one), sent as the system message.
export interface AiSkill {
  id: string
  name: string
  content: string
  description: string
}

export interface AiSkillImportResult {
  path: string
  ok: boolean
  skill?: AiSkill
  truncated?: boolean
  error?: string
  error_params?: Record<string, string | number>
}

// List view (no `messages`) vs fully-loaded conversation, same split as NoteListItem/Note: history panel stays fast.
export interface AiHistoryListItem {
  id: number
  first_question: string
  message_count: number
  created_at: string
  updated_at: string
}

export interface AiHistoryConversation extends AiHistoryListItem {
  messages: AiChatMessage[]
}

// v2 containers keep original_filename/plaintext_size/sha256_plaintext encrypted; the backend decrypts with the IMK, so v1/v2 look the same.
export interface ContainerHeader {
  format_version: number
  original_filename: string
  chunk_size: number
  plaintext_size: number
  sha256_plaintext: string
  file_nonce_prefix: string
  // Not in the encrypted container: the .ivault file's filesystem mtime (Unix seconds) from rpc_read_header; absent if stat failed.
  container_mtime?: number
  fk_wrap: { nonce: string; wrapped_fk: string }
  // 'file' (default) or 'folder' (container.py KIND_FILE/KIND_FOLDER). Absent on v1 or metadata_locked; treat missing as 'file'.
  kind?: 'file' | 'folder'
  // Only present when reading without imk (pre-unlock check); v2 keeps filename/size/kind encrypted, so none are populated.
  metadata_locked?: boolean
  // 口令分享容器（fk_wrap_pw）。没给口令时同时带 metadata_locked：界面据此
  // 弹口令框，而不是把它当成读不了的文件。
  passphrase_protected?: boolean
}

// Mirrors crypto.FILE_CIPHERS; the cipher is recorded in each .ivault header.
// aes-128-gcm stays only so existing containers keep decrypting; no longer offered for new ones
// (crypto.RETIRED_FILE_CIPHERS: Grover halves symmetric strength to 64 bits).
export type FileCipher = 'aes-256-gcm' | 'aes-128-gcm' | 'chacha20-poly1305'

// Encryption profile. `post_quantum` additionally hybrid-wraps the File Key with ML-KEM-1024; bulk cipher unchanged (~0.07 ms, 1.6 KB per file).
export type EncryptionProfile = 'pq-aes-256-gcm' | 'aes-256-gcm' | 'chacha20-poly1305'

export type FileManagerShortcutAction = 'copy' | 'cut' | 'paste' | 'delete_recycle' | 'delete_permanent'

export interface ShortcutBinding {
  key: string
  ctrl: boolean
  alt: boolean
  shift: boolean
}

export type FileManagerShortcuts = Record<FileManagerShortcutAction, ShortcutBinding>

// 应用级全局快捷键（主进程注册，键位存 userData/global-shortcuts.json，不经 Python 后端）；
// 复用 ShortcutBinding 形状，设置页才能对两套快捷键统一做冲突检查。
export type GlobalShortcutAction = 'toggleWindow' | 'clipboardCapture' | 'quickNote' | 'openDevices'

export interface ClipboardNearDuplicateGroup {
  keep_id: number
  count: number
  merge_ids: number[]
  content_type: string
  preview: string
  is_pinned: boolean
  is_hidden: boolean
}

export type GlobalShortcuts = Record<GlobalShortcutAction, ShortcutBinding>

/** 自动锁定：锁定时整个换掉后端进程，而非在原进程里把密钥置空——
 *  Python 不可变 bytes 释放后缓冲区仍留副本，置 None 管不到，换进程才由 OS 保证页面不再属于我们。
 *  `idleMinutes` 为 0 不按空闲锁；`trayMinutes` 为 0 藏进托盘不计时。
 */
export interface AutoLockSettings {
  /** 键鼠多久没动就锁。0 = 关闭。 */
  idleMinutes: number
  /** 藏进托盘多久之后锁。0 = 关闭。跟 idleMinutes 独立：人可能在别的程序里
   *  忙得很（系统空闲时间一直是 0），而金库就那么开着。 */
  trayMinutes: number
  /** 按下 Win+L / 切到锁屏时锁。 */
  onScreenLock: boolean
  /** 睡眠、休眠、合盖时锁。 */
  onSuspend: boolean
}

// 剪贴板清理的四条规则互不替代，不要合并：max_entries 管总量；cleanup_days 管年龄（软删除进回收站）；
// cleanup_hours 管每日清理何时跑；sensitive_ttl_minutes 只管敏感条目，按分钟计且硬删除。
export interface ClipboardSettings {
  max_entries: number
  cleanup_days: number
  cleanup_hours: string
  sensitive_ttl_minutes: number
}

// 跨模块「最近操作」时间线（activity_log.py）。label 可为空串（如捕获图片、笔记未命名），前端按 module+action 显示翻译兜底。
export interface GlobalSearchResult {
  module: 'clipboard' | 'notes' | 'passwords'
  id: number | string
  label: string
  /** 该条是模糊补充命中（拼音首字母 / 错一个字母 / 只记得几个字母），非精确匹配；精确命中不带此字段。 */
  fuzzy?: boolean
}

export interface SecurityHealthCheck {
  id: string
  category: string
  status: 'good' | 'warn' | 'bad' | 'unknown'
  /** 这一项满分几分。全部项的 weight 加起来恒为 100。 */
  weight: number
  earned: number
  /** 翻译键，不是文案。后端返回中文串的话，切语言时这一屏会中英混排。 */
  detailKey: string
  detailArgs?: Record<string, string | number>
}

export type ActivityModule = 'files' | 'notes' | 'passwords' | 'clipboard' | 'recovery_codes'
export interface ActivityLogEntry {
  id: number
  module: ActivityModule
  action: string
  label: string
  created_at: string
}

export type RemnantCategory = 'same_dir' | 'wps_backup' | 'office_autorecover' | 'same_name_disk'

export interface RemnantItem {
  path: string
  size: number
  mtime: number
  category: RemnantCategory
  // true：文件名明显关联某个加密源；false：编辑器备份缓存里的其他近期文件（WPS 备份名常不透明），仅列出供判断，不预选删除。
  matched: boolean
}

// 'formula' = 数学/物理公式（LaTeX 片段，或符号密度够高的式子），
// 由 clipboard/classifier.py 的 _looks_like_formula 判定。
export type ClipboardContentType = 'text' | 'url' | 'email' | 'phone' | 'formula' | 'code' | 'name' | 'image'

export interface ClipboardEntry {
  id: number
  content_type: ClipboardContentType
  content_text: string | null
  content_format: 'plain' | 'rich' | null
  image_path: string | null
  thumbnail_path: string | null
  source_app: string | null
  is_pinned: number
  is_sensitive: number
  is_hidden: number
  // 用户新建的「常用片段」（手输的固定文本，非真实剪贴板事件），与历史条目同表同形，见 clipboard/storage.py 的 is_snippet。
  is_snippet: number
  is_deleted: number
  is_truncated: number
  copy_count: number
  // 置顶内容的拖拽排序位，仅 is_pinned = 1 有值，取消置顶置回 null，越小越靠前。
  // 用稀疏 REAL 分数而非连续整数，一次拖拽只写一行（见 storage.py 的 pin_order）。
  pin_order: number | null
  created_at: string
  updated_at: string
}

/** 内容完全相同的一组记录（clipboard_find_duplicates）。按内容指纹 sha256 分组：文字连同富文本载荷，图片按原始字节；算不出指纹的行不参与。 */
export interface ClipboardDuplicateGroup {
  content_hash: string
  /** 片段和历史记录各自去重，不跨着合并——它们显示在两个不同的列表里。 */
  is_snippet: boolean
  /** 这一组一共几条（保留的那条也算在内）。 */
  count: number
  /** 合并后保留哪一条。优先留已置顶的（保住手工拖出来的位置），否则留最早的。 */
  keep_id: number
  /** 会被软删进回收站的那几条。 */
  merge_ids: number[]
  content_type: ClipboardContentType
  /** 给对话框显示的一小段内容，后端已截断。 */
  preview: string
  /** 这一组里只要有一条置顶/隐藏，合并后保留的那条就会带上这个标记。 */
  is_pinned: boolean
  is_hidden: boolean
}

export interface BlacklistApp {
  id: number
  app_name: string
}

// Shared by list view (note_list/note_list_trash, no `content`) and full note (note_get/create/update);
// the list omits content (notes/storage.py _LIST_COLUMNS vs _FULL_COLUMNS) to stay fast.
// 'plain'（默认）或 'markdown'：决定是否按 Markdown 解析（章节、三视图、导出选项）。导入 .md/.markdown 自动设为
// 'markdown'，详情页可手动切换（note_format_set）。
export type NoteFormat = 'plain' | 'markdown'

export interface NoteListItem {
  id: number
  title: string
  category: string
  preview: string
  content_length: number
  content_storage_mode: NoteTextStorageMode
  format: NoteFormat
  tags: string[]
  is_pinned: number
  is_hidden: number
  is_deleted: number
  // 手动排序位。0 = 尚未摆过，手动模式下排在已摆过者前（set_manual_order 从 1 发号）；仅 sort='manual' 参与排序，其余模式原样保留。
  sort_order: number
  created_at: string
  updated_at: string
  // 关联笔记：正文就是 linked_path 处的原文件，保存写回原处。
  is_linked?: number
  linked_path?: string | null
}

// 导入方式：link 关联原文件（默认），copy 复制进笔记库。
export type NoteImportMode = 'link' | 'copy'

export interface NoteLinkedFolder {
  id: number
  path: string
  category: string
  is_hidden: boolean
  created_at: string
  note_count: number
  exists?: boolean
}

export interface NoteLinkedSyncResult {
  added: NoteListItem[]
  updated: number[]
  removed: number[]
  skipped_large: number
  missing_folders: number[]
}

export interface Note extends NoteListItem {
  content: string
  // 该笔记是否只有开头一段进了全文索引（超大笔记）。由后端算，阈值只在后端定义，前端复制会漂移，
  // 表现为「提示能搜到但搜不到」。仅 note_get 的完整笔记带此字段，列表项没有。
  fts_truncated?: boolean
  /** 索引上限，单位字节。前端用它渲染提示文案里的具体数字。 */
  fts_indexed_bytes?: number
}

export interface NoteContentSegment {
  id: number
  note_id: number
  ordinal: number
  content: string
  byte_size: number
  revision: number
}

// note_scan_txt_dir 递归扫到的一个 .txt 文件；modified_at 为 Unix 秒（os.stat().st_mtime）。
export interface NoteScanFile {
  path: string
  name: string
  size_bytes: number
  modified_at: number
}

// 手建的分类目录项（note_category_* RPC / `categories` 表），独立于笔记自带的自由文本 `category` 列；
// `scope` 使普通笔记与隐藏笔记的分类池互相独立。
export type NoteCategoryScope = 'normal' | 'hidden'

export interface NoteCategory {
  id: number
  name: string
  scope: NoteCategoryScope
  // 逗号分隔的同义词，供导入自动分类（rpc_note_import_files -> notes/classifier.py）在文件里没出现分类名时也能匹配；
  // 默认 ''，仅在分类管理里填写。
  keywords: string
  created_at: string
}

// 分类名是以 '/' 分隔的物化路径（`工作/项目A/需求`），层级全编码在字符串里、无 parent_id：
// 取子树是前缀匹配，移动/重命名是前缀替换。代价：单个分类名不能含 '/'。
export type NoteCategoryDeleteMode = 'promote' | 'cascade'

export interface NoteCategoryImpact {
  id: number
  name: string
  scope: NoteCategoryScope
  /** 这个分类下所有子孙分类的完整路径 */
  children: string[]
  child_count: number
  /** 直接挂在这个分类上的笔记数 */
  direct_note_count: number
  /** 子孙分类上的笔记数，与 direct 分开统计：promote 时子孙笔记改路径、直接笔记归父级，cascade 时全变未分类，确认框要分别说明。 */
  descendant_note_count: number
}

// 应用更新：与 electron/updateService.ts 的 UpdateCheckResult 一一对应。不从 electron/ import，
// 因为渲染端 tsconfig 不含该目录，会把 Node 类型拖进来；加字段时两边都要手动同步。
export interface UpdateCheckResult {
  status: 'up-to-date' | 'update-available' | 'error'
  currentVersion: string
  latest?: {
    version: string
    releasedAt: string
    notes: string
    assetName: string
    assetSize: number
  }
  /** 机器可读的失败原因，翻译成人话由渲染端做（errors 命名空间的 update.* 键） */
  errorCode?: string
  errorMessage?: string
  checkedAt: number
}

/** 更新源的两个内置选项，与 electron/updateService.ts 的 UPDATE_SOURCES 的键一一对应。 */
export type UpdateSourceId = 'main' | 'mirror'

/** 更新包下载进度，跟 electron/segmentedDownload.ts 的 DownloadProgress 一一对应。 */
export interface UpdateProgress {
  received: number
  total: number
  bytesPerSecond: number
  /** 此刻在下载的并行连接数。 */
  connections: number
}

export interface NoteReclassifyChange {
  id: number
  title: string
  from_category: string
  to_category: string
}

// One tag can be assigned to many notes, and one note can carry many tags.
// It uses the same visibility scope model as categories.
export interface NoteTag {
  id: number
  name: string
  scope: NoteCategoryScope
  created_at: string
}

// 与 NoteListItem/Note 同样的列表/完整分离：图库只取 thumbnail_base64，完整 image_base64 在打开大图时才单独取（note_image_get）。
export interface NoteImageMeta {
  id: number
  note_id: number
  mime_type: string
  byte_size: number
  created_at: string
  thumbnail_base64: string
}

export interface NoteImageFull {
  id: number
  note_id: number
  mime_type: string
  byte_size: number
  created_at: string
  image_base64: string
}

export interface PasswordEntry {
  id: string
  name: string
  url: string
  username: string
  password: string
  notes: string
  created_at: number
  updated_at: number
}

// Mirrors modules/file_vault/ui_settings.py's SORT_MODES exactly.
export type PasswordSortMode = 'recent' | 'alphabetical' | 'host'

// 笔记排序方式，须与 notes/storage.py 的 _SORT_CLAUSES、ui_settings.NOTE_SORT_MODES 逐字对齐；'created' 为默认，等同可选排序功能出现前的固定顺序。
export type NoteSortMode = 'created' | 'updated' | 'title' | 'manual'

// 笔记修改时间线（notes/revisions）：每条是某次改动之后的样子（标题+分类+正文）。
// 改动升级前已存在的笔记时，后端先补一条 'baseline'（改前样子）；两分钟内的连续 'edit' 在后端合并。
// 批量修改共用一个 batch_id，界面据此成组并提供「整批撤销」。
export type NoteRevisionKind =
  | 'baseline'
  | 'create'
  | 'edit'
  | 'metadata'
  | 'bulk_edit'
  | 'bulk_category'
  | 'restore'
  | 'merge'
  | 'undo'

export interface NoteRevision {
  id: number
  note_id: number
  kind: NoteRevisionKind
  /** 同一次批量操作共用；单篇修改为 null。 */
  batch_id: string | null
  title: string
  category: string
  content_length: number
  /** 正文太大（> 后端 REVISION_CONTENT_LIMIT）时只记元数据，不存全文快照。 */
  has_content: boolean
  /** 后端生成的一句话说明，例如「替换 3 处」「分类 工作 → 学习」。可为空串。 */
  summary: string
  /** 与 notes.updated_at 同格式：本地时间 'YYYY-MM-DDTHH:MM:SS'。 */
  created_at: string
}

export interface NoteRevisionWithContent extends NoteRevision {
  /** has_content 为 false 时是 null。 */
  content: string | null
}

export interface NoteTimelineEntry extends NoteRevision {
  /** 这条笔记**现在**的标题（改名之后时间线上仍然认得出是哪篇）。 */
  note_title: string
  /** 笔记已经被删进回收站或彻底删除。 */
  note_deleted: boolean
}

export type NoteBulkEditOp =
  | { kind: 'replace'; find: string; replace: string; match_case?: boolean; regex?: boolean; whole_word?: boolean }
  | { kind: 'prepend'; text: string }
  | { kind: 'append'; text: string }

export interface NoteBulkEditPreviewItem {
  note_id: number
  title: string
  /** 这篇里会改几处（prepend/append 恒为 1）。0 表示这篇不受影响。 */
  matches: number
  /** 第一处改动附近的一小段原文 / 改后文本，给预览用。 */
  sample_before: string
  sample_after: string
  /** 这篇为什么被跳过：正文太大 / 正文存在磁盘明文里 / 正则无效等。 */
  skipped?: 'too_large' | 'not_found'
}

export interface NoteDuplicateMember {
  id: number
  title: string
  category: string
  content_length: number
  is_pinned: number
  is_hidden: number
  created_at: string
  updated_at: string
}

export interface NoteDuplicateGroup {
  /** 'content'：正文相同（忽略首尾空白与换行风格）；'title_content'：标题和正文都相同。 */
  reason: 'content' | 'title_content'
  /** 按 updated_at 从新到旧。 */
  notes: NoteDuplicateMember[]
}

// 「恢复码」（recovery_codes.py）是第三方服务的 2FA/备份码，不是本应用的主恢复密钥（identity.py SLOT_RECOVERY）。
// 返回 RecoveryCodeGroup 的 RPC 一律用打码形态：`index` 稳定（导入后不重排），mark_used 按它定位；
// 仅 recovery_codes_reveal 会发明文 `code`（见 RevealedRecoveryCode）。
export interface RecoveryCodeEntry {
  index: number
  used: boolean
  usedAt: number | null
}

export interface RevealedRecoveryCode {
  index: number
  code: string
  used: boolean
  usedAt: number | null
}

export interface RecoveryCodeImportHistoryEntry {
  action: 'import' | 'update' | 'mark_used' | 'export' | 'backup_restore'
  timestamp: number
  changeSummary: string
}

export interface RecoveryCodeGroup {
  id: string
  service: string
  accountLabel: string
  sourceFileName: string
  codes: RecoveryCodeEntry[]
  firstImportedAt: number
  lastUpdatedAt: number
  lastCheckedAt: number
  lowStockThreshold: number
  reviewIntervalDays: number
  importHistory: RecoveryCodeImportHistoryEntry[]
  note: string
  remainingCount: number
  isLowStock: boolean
  needsReview: boolean
}

// 恢复码修改时间线：每条是某服务在某次改动之后的完整样子，快照存在加密的 recovery_codes.vault（同钥匙），
// 发给前端时码仍打码；看明文须走 recovery_codes_revision_reveal，与 recovery_codes_reveal 共用「最近验证过」闸门。
export type RecoveryCodeRevisionAction =
  | 'baseline'
  | 'import'
  | 'update'
  | 'mark_used'
  | 'bulk_meta'
  | 'restore'
  | 'merge'
  | 'backup_restore'
  | 'undo'

export interface RecoveryCodeRevision {
  id: string
  group_id: string
  /** epoch 秒（跟 RecoveryCodeGroup 的其它时间戳同一单位）。 */
  timestamp: number
  action: RecoveryCodeRevisionAction
  batch_id: string | null
  summary: string
  service: string
  account_label: string
  note: string
  code_count: number
  used_count: number
  /** 打码后的码：只有下标和是否用过。 */
  codes: RecoveryCodeEntry[]
}

export interface RecoveryCodeTimelineEntry extends RecoveryCodeRevision {
  /** 这组现在的服务名；组已被删除时是快照里的服务名。 */
  current_service: string
  group_exists: boolean
}

export interface RecoveryCodeDuplicateGroup {
  /** same_identity：服务名 + 账号标签相同；same_codes：码的集合完全相同。 */
  reason: 'same_identity' | 'same_codes'
  ids: string[]
}

export interface DamagedRecoveryCodeRecord {
  index: number
  service: string | null
  reason: string
}

export interface RecoveryCodeServiceRule {
  key: string
  displayName: string
  expectedCount: number | null
}

// 完整备份与本地金库比对时，一个 (service, accountLabel) 身份的分类（spec 3.5）。"identical" 无需决定，其余状态都让用户选合并方式。
export interface BackupDiffItem {
  key: string
  service: string
  accountLabel: string
  status: 'local_only' | 'backup_only' | 'identical' | 'conflict'
  localGroupId: string | null
  backupIndex: number | null
  localRemaining: number | null
  backupRemaining: number | null
}

/** 一份 JSON 导出文件的信封信息，导入预览时显示给用户。 */
export interface RecoveryCodesJsonMeta {
  /** 1 = 旧的裸数组导出（只读兼容），2 = 当前信封格式。 */
  formatVersion: number
  encrypted: boolean
  codesRedacted: boolean
  exportedAt: number | null
  appVersion: string
  /** null 与 false 不同：null = 文件没带整体校验值（v1 没有），false = 带了但对不上、文件被动过。混为一谈会对每个旧文件假警报。 */
  checksumOk: boolean | null
}

/** 跟 BackupDiffItem 同构，只是把 backup* 换成 file*：来源是一份 JSON 文件而
 *  不是加密备份，界面上的措辞也该跟着变。 */
export interface JsonImportDiffItem {
  key: string
  service: string
  accountLabel: string
  status: 'local_only' | 'backup_only' | 'identical' | 'conflict'
  localGroupId: string | null
  fileIndex: number | null
  localRemaining: number | null
  fileRemaining: number | null
}

export interface RecoveryCodesSettings {
  scan_downloads_enabled: boolean
  reveal_requires_verify: boolean
}

// 'pcclean' 是整个清理套件一项，而非 5 个标签页各一项：标签页间切换算同一次使用，每次验证会让人弃用。
// 进入判定在 AppShell.handleNavClick，只有从套件外部进入才验证。
export type LockableModule = 'files' | 'clipboard' | 'passwords' | 'recoverycodes' | 'notes' | 'ai' | 'network' | 'filemanager' | 'pcclean'

// Mirrors modules/file_vault/ui_settings.py's NOTE_IMAGE_STORAGE_MODES exactly.
export type NoteImageStorageMode = 'encrypted_db' | 'disk_plain'

// Mirrors ui_settings.py NOTE_TEXT_STORAGE_MODES: where a note's text (not images, see NoteImageStorageMode) was stored; fixed at creation.
export type NoteTextStorageMode = 'encrypted_db' | 'disk_plain'

/** 故障日志的一条。detail 只放错误码/异常类名，绝不放用户内容。 */
export type DiagnosticLevel = 'error' | 'warn' | 'info'

export interface DiagnosticLogEntry {
  /** 稳定标识。删除按它来——按下标删会在列表重排后删错条目。 */
  uid: string
  /** unix 秒。排序和按时间筛都用它，`at` 只负责给人看。 */
  ts: number
  at: string
  level: DiagnosticLevel
  module: string
  problem: string
  code?: string
  detail?: string
  /** 连续出现的同一条会折叠并累加次数，不刷屏。 */
  count: number
}

/** 按级别 / 模块聚合出来的概览。几百行滚动条谁也读不完，
 *  「跨设备模块报了 214 次超时」一句话才指得出问题在哪。 */
export interface DiagnosticLogStats {
  lines: number
  occurrences: number
  by_level: Record<DiagnosticLevel, number>
  by_module: { module: string; count: number }[]
  top_problems: { module: string; problem: string; count: number }[]
  first_ts: number
  last_ts: number
}

/** 排查报告里的环境部分。**刻意不含路径、用户名、机器名**——报告是拿去发给
 *  别人看的，那几样跟"哪个功能坏了"无关。 */
export interface DiagnosticEnvironment {
  os: string
  os_release: string
  os_version: string
  arch: string
  python: string
}

/** 生物识别的三种模态，按解锁时的优先级排列：人脸 > 指纹 > 虹膜。
 *  排序权威在后端 `fingerprint.BIOMETRIC_PRIORITY`，这里的顺序只是文档。 */
export type BiometricModality = 'face' | 'fingerprint' | 'iris'

import type {
  PcCleanCategory,
  PcCleanAuditEntry,
  PcCleanExecuteResult,
  PcCleanPreviewResult,
  PcCleanScheduleConfig,
  PcCleanUserRule,
  PcCleanHealthResult,
  PcCleanMemoryStatus,
  PcCleanPopupHit,
  PcCleanPopupRule,
  PcCleanPopupStatus,
  PcCleanScanResult,
  PcCleanSession,
  PcCleanTool,
  PcCleanToolResult,
  PcCleanUndoResult,
  PcCleanWindow,
} from './pccleanTypes'

// 清理套件的数据形状全部住在 pccleanTypes.ts。这里只 re-export，
// 让 `import type { PcCleanItem } from '@/shared/ipcTypes'` 这种写法照样成立。
export type * from './pccleanTypes'

export interface VaultMethods {
  identity_exists: { params: Record<string, never>; result: { exists: boolean } }
  /**
   * 金库数据目录位置及来源 `source`：
   *   - 'env'        IDEAL1_FILE_VAULT_DATA_DIR 指定，改配置无效，can_change 为 false，界面须禁用「更改位置」。
   *   - 'configured' 安装程序选的或设置页改的。
   *   - 'default'    未指定，用 %LOCALAPPDATA% 默认值。
   */
  data_dir_info: {
    params: Record<string, never>
    result: {
      path: string
      source: 'env' | 'configured' | 'default'
      pending_move_from: string | null
      can_change: boolean
    }
  }
  /**
   * 请求搬迁金库，只记录意图、重启后才真正搬：SQLCipher 连接开着时复制数据库会漏掉 WAL 里未 checkpoint 的事务。
   * 成功后须提示「重启生效」，不能显示「已完成」。
   */
  data_dir_move: {
    params: { path: string }
    result: { ok: true; from: string; to: string; restart_required: true }
  }
  setup_generate_totp: {
    params: Record<string, never>
    result: { seed: string; qr_png_base64: string; provisioning_uri: string }
  }
  setup_verify_totp: { params: { seed: string; code: string }; result: { ok: boolean } }
  setup_generate_recovery_key: { params: Record<string, never>; result: { recovery_key: string } }
  setup_check_fingerprint_available: { params: Record<string, never>; result: { available: boolean } }
  /** 解锁前可调：返回本机生物识别及金库是否已绑定，登录页与强制复验弹窗据此选人脸/指纹。
   *  `chain` 已按 人脸 → 指纹 → 虹膜 排好序，前端不再重排。 */
  biometric_status: {
    params: { refresh?: boolean }
    result: {
      ok: true
      available: boolean
      modalities: Record<BiometricModality, boolean>
      chain: BiometricModality[]
      preferred: BiometricModality | null
      bound: boolean
    }
  }
  setup_verify_fingerprint: { params: Record<string, never>; result: { ok: true } | { ok: false; error: string; error_params?: Record<string, string | number> } }
  setup_complete: {
    params: {
      password: string
      /** null = 向导里跳过了验证器；后端据此不建该解锁槽（而非建一个可被推导的占位假槽）。密码与恢复密钥始终会建，跳过不会让金库打不开。 */
      totp_seed: string | null
      email_address: string | null
      recovery_key: string
      smtp_config?: SmtpConfigInput
      enable_fingerprint?: boolean
    }
    result: { ok: true }
  }
  unlock_password: { params: { password: string }; result: { ok: true } | { ok: false; error: string; error_params?: Record<string, string | number> } }
  unlock_totp: { params: { code: string }; result: { ok: true } | { ok: false; error: string; error_params?: Record<string, string | number> } }
  unlock_recovery: { params: { recovery_key: string }; result: { ok: true } | { ok: false; error: string; error_params?: Record<string, string | number> } }
  unlock_email_start: {
    params: Record<string, never>
    result: { ok: true; email_address: string | null } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  unlock_email_finish: { params: { code: string }; result: { ok: true } | { ok: false; error: string; error_params?: Record<string, string | number> } }
  unlock_fingerprint: {
    /** `timeout_seconds`：本次验证最多锁住应用窗口多久。Windows Hello 验证框对窗口模态，期间整个界面点不动，
     *  故登录页自动发起的那次传短预算（UnlockTabs 的 AUTO_ATTEMPT_TIMEOUT_SECONDS），用户点按钮才用后端默认值；
     *  后端会夹进合法区间。 */
    params: { timeout_seconds?: number }
    result: { ok: true } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  /** 撤销正在进行的生物识别验证。`canceled` 为 false 表示当时压根没有在途的
   *  验证——那不是错误，调用方（登录页的「取消」按钮）照常往下走就行。 */
  unlock_fingerprint_cancel: { params: Record<string, never>; result: { ok: true; canceled: boolean } }
  read_header: {
    params: { input_path: string }
    result: { ok: true; header: ContainerHeader } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  scan_remnants: {
    params: { source_paths: string[] }
    result: { ok: true; items: RemnantItem[] } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  secure_delete_paths: {
    // allow_directories 默认 false，目录会被拒绝（"container.path_is_directory"）。
    // 残留明文扫描永远不该传；仅「安全删除失败 → 重试删除」传，因为该文件夹是用户刚勾选的。
    params: { paths: string[]; allow_directories?: boolean }
    result:
      | {
          ok: true
          results: { path: string; ok: boolean; error?: string; error_params?: Record<string, string | number> }[]
        }
      | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  encrypt_file: {
    params: { input_path: string; output_path: string; delete_source?: boolean; cipher?: FileCipher; post_quantum?: boolean }
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
  decrypt_file: {
    params: { input_path: string; output_path: string; delete_source?: boolean }
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
  // 文件夹容器分两步解密：文件列表只能从完整解密后的 zip 中央目录读出，没有 read_header 那样的廉价预览
  // （见 container.py 模块注释）。预览只读 ZIP 中央目录所在的末尾几百 KB，不整包解密，10 GB 与 10 MB 一样快，
  // 因此没有 temp_zip_path，也无需 confirm/discard 清理，取消即什么都不做。
  decrypt_folder_preview: {
    params: { input_path: string }
    result:
      | {
          ok: true
          input_path: string
          original_name: string
          entries: { name: string; size: number; is_dir: boolean }[]
        }
      | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  // 直接从容器流式解到目标目录：目标文件只写一遍（原来是"先解成临时 ZIP 再解压"，
  // 整份数据完整写两遍）。先做一遍只读的整体 sha256 校验，不过就一个字节都不落盘。
  decrypt_folder_confirm: {
    params: { input_path: string; output_dir: string; delete_source?: boolean }
    result:
      | {
          ok: true
          output_dir: string
          source_deleted?: boolean
          delete_error?: string
          delete_error_params?: Record<string, string | number>
        }
      | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  // 预览不再产生临时文件，取消已经没有东西要清理。保留这个方法只是让前端不必
  // 分版本判断该不该调它。
  decrypt_folder_discard: {
    params: Record<string, never>
    result: { ok: true }
  }
  folder_container_diff: {
    params: { source_folder: string; container_path: string }
    result:
      | {
          ok: true
          original_name: string
          added: string[]
          removed: string[]
          modified: string[]
          unchanged_count: number
          empty_dirs_added: string[]
          empty_dirs_removed: string[]
        }
      | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  folder_container_reencrypt: {
    params: { source_folder: string; container_path: string }
    result: { ok: true; container_path: string } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  // 口令分享容器（fk_wrap_pw）：passphrase 只出现在这几个方法的 params 里，后端不记日志。
  // share_session 是界面为一批操作起的随机 id，同批共用一次 Argon2id 派生。
  share_encrypt_file: {
    params: {
      input_path: string
      output_path: string
      passphrase: string
      share_session?: string
      cipher?: FileCipher
      delete_source?: boolean
    }
    result:
      | {
          ok: true
          output_path: string
          elapsed_ms: number
          container_size?: number
          source_deleted?: boolean
          delete_error?: string
          delete_error_params?: Record<string, string | number>
        }
      | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  share_read_headers: {
    params: { paths: string[]; passphrase: string; share_session?: string }
    result:
      | {
          ok: true
          results: (
            | { path: string; ok: true; header: ContainerHeader & { passphrase_protected?: boolean; post_quantum?: boolean; cipher?: string } }
            | { path: string; ok: false; error: string; error_params?: Record<string, string | number> }
          )[]
        }
      | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  share_decrypt_file: {
    params: { input_path: string; output_path: string; passphrase: string; share_session?: string; delete_source?: boolean }
    result:
      | {
          ok: true
          output_path: string
          elapsed_ms: number
          source_deleted?: boolean
          delete_error?: string
          delete_error_params?: Record<string, string | number>
        }
      | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  share_decrypt_folder_preview: {
    params: { input_path: string; passphrase: string; share_session?: string }
    result:
      | {
          ok: true
          input_path: string
          original_name: string
          entries: { name: string; size: number; is_dir: boolean }[]
        }
      | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  share_decrypt_folder_confirm: {
    params: { input_path: string; output_dir: string; passphrase: string; share_session?: string; delete_source?: boolean }
    result:
      | {
          ok: true
          output_dir: string
          source_deleted?: boolean
          delete_error?: string
          delete_error_params?: Record<string, string | number>
        }
      | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  share_session_end: {
    params: { share_session: string }
    result: { ok: true }
  }
  // 只校验不落盘。「被篡改」是正常结果（ok: true, intact: false），不是错误；
  // failed_chunk 从 0 数。只有根本没法校验（不是容器 / 密钥不对 / 要口令）才 ok: false。
  verify_container: {
    params: { input_path: string; passphrase?: string; share_session?: string }
    result:
      | {
          ok: true
          input_path: string
          intact: boolean
          failure: null | 'metadata' | 'chunk' | 'truncated' | 'trailing_data' | 'checksum' | 'archive'
          failed_chunk: number | null
          chunks_checked: number
          chunks_expected: number
          bytes_checked: number
          plaintext_size: number | null
          container_size: number
          kind: 'file' | 'folder' | null
          original_filename: string | null
          sha256_plaintext: string | null
          cipher: string
          wrap: 'identity' | 'post_quantum' | 'passphrase'
          format_version: number
          elapsed_s: number
          entry_count?: number
          file_count?: number
        }
      | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  /** 「最近操作」面板算吞吐用。目录不递归，回 null。 */
  files_path_sizes: {
    params: { paths: string[] }
    result: { ok: true; sizes: Record<string, number | null> } | { ok: false; error: string }
  }
  global_search: {
    // limit 不传就是**不限条数**，三个模块各返回全部命中项。渲染量由命令面板
    // 自己分页控制，不靠后端少给（后端截掉的界面上看不出来，也滚不出来）。
    params: { query: string; limit?: number }
    result: { ok: true; results: GlobalSearchResult[] } | { ok: false; error: string }
  }
  /** 安全体检。评分只在后端 security_health.py 一份实现；跨设备与签名事实由界面采集后传上去（守护进程归 Electron 主进程管，Python 看不到）。 */
  security_health: {
    params: { clientFacts?: Record<string, unknown> }
    result:
      | {
          ok: true
          /** 0-100；**-1 表示一项都测不到**，界面要显示"暂时测不出来"而不是一个数字。 */
          score: number
          grade: 'excellent' | 'good' | 'fair' | 'attention' | 'unknown'
          checks: SecurityHealthCheck[]
          /** 实际进入分母的权重（查不到的项不计入）。 */
          scoredWeight: number
          totalWeight: number
          unknownCount: number
          /** 依赖扫描快照的时间（Unix 秒）。null = 没有快照。 */
          dependencyAuditScannedAt: number | null
        }
      | { ok: false; error: string }
  }
  activity_log_list: {
    params: { limit?: number }
    result:
      | { ok: true; entries: ActivityLogEntry[] }
      | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  activity_log_clear: {
    params: Record<string, never>
    result: { ok: true } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }

  // 故障诊断日志，与 activity_log（记用户做了什么，存加密库）无关：这里记什么坏了，
  // 金库锁着或解锁失败时也要能写，所以是明文，也因此默认关闭。绝不记录用户内容。
  diagnostic_log_status: {
    params: Record<string, never>
    result: { ok: true; enabled: boolean } | { ok: false; error: string }
  }
  diagnostic_log_set_enabled: {
    params: { enabled: boolean }
    result: { ok: true; enabled: boolean } | { ok: false; error: string }
  }
  diagnostic_log_list: {
    params: Record<string, never>
    result: { ok: true; entries: DiagnosticLogEntry[] } | { ok: false; error: string }
  }
  /** 带筛选地读。`modules`/`levels` 是**筛选前**全量数据算出来的可选值，
   *  否则筛完之后下拉框里只剩当前那一项，切不回去。 */
  diagnostic_log_query: {
    params: {
      levels?: DiagnosticLevel[]
      modules?: string[]
      search?: string
      /** unix 秒，只看这个时间点之后的。0 = 不限。 */
      since?: number
      limit?: number
    }
    result:
      | {
          ok: true
          entries: DiagnosticLogEntry[]
          /** 筛选前的总条数 */
          total: number
          /** 命中条数（可能大于返回的条数，见 truncated） */
          matched: number
          modules: string[]
          levels: DiagnosticLevel[]
          truncated: boolean
        }
      | { ok: false; error: string }
  }
  diagnostic_log_stats: {
    params: Record<string, never>
    result:
      | { ok: true; stats: DiagnosticLogStats; environment: DiagnosticEnvironment }
      | { ok: false; error: string }
  }
  /** 按 uid 删选中的那几条。空数组什么都不删——把空选择当全选是删除接口的经典翻车。 */
  diagnostic_log_delete: {
    params: { uids: string[] }
    result: { ok: true; removed: number } | { ok: false; error: string }
  }
  /** 纯文本排查报告，直接回内容不落盘：它的用途就是复制粘贴发给别人。 */
  diagnostic_log_export: {
    params: { limit?: number }
    result: { ok: true; report: string } | { ok: false; error: string }
  }
  diagnostic_log_clear: {
    params: Record<string, never>
    result: { ok: true; removed: number } | { ok: false; error: string }
  }
  diagnostic_log_record: {
    params: {
      module: string
      problem: string
      detail?: string
      code?: string
      level?: DiagnosticLevel
    }
    result: { ok: true } | { ok: false; error: string }
  }

  // 电脑清理套件。`pcclean_execute` 只收 item_id 列表，不收条目对象：后端按 id 查自己的扫描缓存，
  // 因为渲染进程传来的 `locked`/`importance` 不可信，不能把「能不能删」的判断交给它。
  pcclean_scan: {
    params: { category: PcCleanCategory; options?: Record<string, unknown>; scan_id?: string }
    result: PcCleanScanResult
  }
  pcclean_health_check: {
    params: { options?: Record<string, unknown>; scan_id?: string }
    result: PcCleanHealthResult
  }
  pcclean_cancel: {
    params: { scan_id: string }
    result: { ok: boolean; scan_id?: string; error?: string }
  }
  /**
   * 读回上次落盘的单类扫描结果（重复文件实测 180 秒、大文件 120 秒，不缓存等于不可用）。
   * 结果带 `from_cache` / `cache_age_s` / `stale`，界面必须显示岁数；`stale` 时清理前要先重扫。
   */
  pcclean_cached_scan: {
    params: { category: string }
    result: (PcCleanScanResult & { from_cache: true }) | { ok: false; error: string }
  }
  /** 把自启项改为「登录后延迟 N 分钟启动」（计划任务 + 禁用 Run 项）。不走 `pcclean_execute`，因为那条语义是清理删除；撤销仍走同一份 journal。 */
  pcclean_startup_delay: {
    params: { item_id: string; minutes: number }
    result:
      | { ok: true; session_id: string; item_id: string; minutes: number; task_name: string }
      | { ok: false; error: string }
  }
  pcclean_execute: {
    params: {
      item_ids: string[]
      options?: {
        create_restore_point?: boolean
        /** 允许为需要管理员权限的项弹一次 UAC，默认 false（点清理不等于预期看到 UAC）。
         *  第一遍先清不需要权限的并如实报告剩余项，用户点界面按钮后才带 true 再来一次。 */
        allow_elevation?: boolean
      }
    }
    result: PcCleanExecuteResult
  }
  /** 干跑：同一条代码路径，一个字节都不动。参数和 `pcclean_execute` 一致，
   *  因为它就是那个调用的 dry-run 分支——参数不同的话两边迟早会分叉。 */
  pcclean_preview: {
    params: { item_ids: string[] }
    result: PcCleanPreviewResult
  }
  pcclean_audit_log: {
    params: { limit?: number }
    result: { ok: true; entries: PcCleanAuditEntry[] }
  }
  /** 删除选中的清理记录。返回删干净之后的整份列表，前端直接替换，不用再拉一次。 */
  pcclean_audit_delete: {
    params: { session_ids: string[] }
    result: { ok: true; removed: number; entries: PcCleanAuditEntry[] }
  }
  pcclean_audit_clear: {
    params: Record<string, never>
    result: { ok: true; removed: number; entries: PcCleanAuditEntry[] }
  }
  pcclean_rules_get: {
    params: Record<string, never>
    result: { ok: true; rules: PcCleanUserRule[]; max_rules: number }
  }
  pcclean_rules_upsert: {
    params: { rule: Partial<PcCleanUserRule> }
    result: { ok: true; rules: PcCleanUserRule[] } | { ok: false; error: string }
  }
  pcclean_rules_remove: {
    params: { rule_id: string }
    result: { ok: true; rules: PcCleanUserRule[] }
  }
  pcclean_schedule_get: {
    params: Record<string, never>
    result: {
      ok: true
      config: PcCleanScheduleConfig
      due_at: number
      safe_categories: string[]
      intervals: string[]
    }
  }
  pcclean_schedule_set: {
    params: { config: Partial<PcCleanScheduleConfig> }
    result: { ok: true; config: PcCleanScheduleConfig; due_at: number }
  }
  pcclean_undo: { params: { session_id: string }; result: PcCleanUndoResult }
  pcclean_sessions: {
    params: { limit?: number }
    result: { ok: true; sessions: PcCleanSession[] }
  }
  pcclean_memory_status: { params: Record<string, never>; result: PcCleanMemoryStatus }
  pcclean_memory_trim: {
    params: { item_ids: string[] }
    result:
      | { ok: true; before: PcCleanMemoryStatus; after: PcCleanMemoryStatus; attempted: number; succeeded: number; freed_bytes: number }
      | { ok: false; error: string; missing?: string[] }
  }
  pcclean_memory_purge_standby: {
    params: Record<string, never>
    result: { ok: boolean; error?: string; before?: PcCleanMemoryStatus; after?: PcCleanMemoryStatus }
  }
  pcclean_popup_status: { params: Record<string, never>; result: PcCleanPopupStatus }
  pcclean_popup_set_enabled: { params: { enabled: boolean }; result: PcCleanPopupStatus }
  pcclean_popup_test: { params: Record<string, never>; result: { ok: true; hits: PcCleanPopupHit[] } }
  pcclean_popup_capture: { params: Record<string, never>; result: { ok: true; windows: PcCleanWindow[] } }
  pcclean_popup_add_rule: { params: { rule: PcCleanPopupRule }; result: PcCleanPopupStatus | { ok: false; error: string } }
  pcclean_popup_remove_rule: { params: { rule_id: string }; result: PcCleanPopupStatus }
  pcclean_popup_whitelist: { params: { entries: string[] }; result: PcCleanPopupStatus }
  pcclean_popup_clear_log: { params: Record<string, never>; result: PcCleanPopupStatus }
  pcclean_whitelist_get: { params: Record<string, never>; result: { ok: true; entries: string[] } }
  pcclean_whitelist_set: { params: { entries: string[] }; result: { ok: true; entries: string[] } }
  pcclean_tools: { params: Record<string, never>; result: { ok: true; tools: PcCleanTool[]; elevated: boolean } }
  pcclean_run_tool: {
    params: { tool_id: string; params?: Record<string, unknown> }
    result: PcCleanToolResult
  }
  pcclean_optimize_volume: {
    params: { drive: string; mode?: 'auto' | 'defrag' | 'retrim' }
    result: { ok: boolean; error?: string; media_type?: string; is_ssd?: boolean; mode?: string; output?: string }
  }
  pcclean_uninstall: {
    params: { item_id: string; silent?: boolean }
    result: { ok: boolean; error?: string; pid?: number; silent?: boolean; command?: string }
  }
  pcclean_elevation_status: { params: Record<string, never>; result: { ok: true; elevated: boolean } }
  file_manager_shortcuts_get: {
    params: Record<string, never>
    result: { ok: true; shortcuts: FileManagerShortcuts } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  file_manager_shortcuts_set: {
    params: { shortcuts: FileManagerShortcuts; reserved?: ShortcutBinding[] }
    result: { ok: true; shortcuts: FileManagerShortcuts } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  password_list: { params: Record<string, never>; result: { entries: PasswordEntry[] } }
  password_add: {
    params: { name: string; url: string; username: string; password: string; notes?: string }
    result:
      // deduped: true 表示 name/url/username/password/notes 全部与已有条目一致，`entry` 即该已有条目，未写入新数据（rpc_password_add）。
      | { ok: true; entry: PasswordEntry; deduped: boolean }
      | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  password_update: {
    params: { id: string; name: string; url: string; username: string; password: string; notes?: string }
    result: { ok: true; entry: PasswordEntry } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  password_delete: { params: { id: string }; result: { ok: true } | { ok: false; error: string; error_params?: Record<string, string | number> } }
  password_delete_bulk: {
    params: { ids: string[] }
    result: { ok: true; deleted_count: number } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  password_dedupe: {
    params: Record<string, never>
    result: { ok: true; deleted_count: number } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  password_dedupe_preview: {
    params: Record<string, never>
    result: { ok: true; duplicate_ids: string[] } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  password_undo_delete: {
    params: { entries: PasswordEntry[] }
    result: { ok: true; restored_count: number } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  // 每行的分类判定（rpc_password_import_csv_preview / passwords.py plan_csv_import）："add" 新账号；
  // "update" 已有网址+用户名但字段有变；"unchanged" 完全一致；"superseded_in_batch" 被同一 CSV 后面同账号的行覆盖，
  // superseded_by 指向其 row_index。
  password_import_csv_preview: {
    params: { input_path: string }
    result:
      | {
          ok: true
          rows: Array<{
            row_index: number
            name: string
            url: string
            username: string
            password: string
            notes: string
            action: 'add' | 'update' | 'unchanged' | 'superseded_in_batch'
            match_id: string | null
            superseded_by: number | null
          }>
          total_rows: number
          add_count: number
          update_count: number
        }
      | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  password_import_csv_confirm: {
    params: { input_path: string; selected_row_indices: number[]; delete_source_csv?: boolean }
    result:
      | {
          ok: true
          added_count: number
          updated_count: number
          skipped_count: number
          source_deleted?: boolean
          delete_error?: string
          delete_error_params?: Record<string, string | number>
        }
      | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  password_export_csv: {
    params: { output_path: string }
    result: { ok: true; output_path: string } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  password_get_history: {
    params: { id: string }
    result:
      | { ok: true; history: Array<{ name: string; url: string; username: string; password: string; notes: string; updated_at: number }> }
      | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  password_sort_mode_get: {
    params: Record<string, never>
    result: { ok: true; sort_mode: PasswordSortMode } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  password_sort_mode_set: {
    params: { sort_mode: PasswordSortMode }
    result: { ok: true; sort_mode: PasswordSortMode } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  recovery_codes_list: {
    params: Record<string, never>
    result: { ok: true; groups: RecoveryCodeGroup[]; damaged: DamagedRecoveryCodeRecord[] }
  }
  recovery_codes_reveal: {
    params: { id: string; verified?: boolean }
    result: { ok: true; id: string; codes: RevealedRecoveryCode[] } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  recovery_codes_detect_service: {
    params: { filename: string }
    result: { ok: true; rule: RecoveryCodeServiceRule | null }
  }
  recovery_codes_import_preview: {
    // input_path（文件选择/拖放，后端自己读）与 text（剪贴板/OCR 确认行）必须二选一。
    // 始终返回 `groups`（单服务导入长度为 1，多服务 TXT/CSV/JSON 导出重新导入为 N），前端只需渲染一种形状。
    params: { input_path?: string; text?: string; source_file_name?: string; service?: string; account_label?: string }
    result:
      | {
          ok: true
          sourceFileName: string
          detectedRule: string | null
          expectedCount: number | null
          groups: Array<{
            service: string
            accountLabel: string
            matchedGroupId: string | null
            action: 'new' | 'unchanged' | 'changed'
            codes: string[]
            invalidLines: Array<{ lineNumber: number; raw: string }>
            suspectCodes: string[]
          }>
        }
      | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  recovery_codes_import_confirm: {
    params: {
      source_file_name: string
      groups: Array<{ service: string; account_label: string; codes: string[]; group_id?: string }>
      // 导入完成后安全删除源文件：它是明文恢复码（绕过两步验证的后门），留在下载目录则导入等于没保护。
      // 界面默认勾选；剪贴板导入没有源文件，两个字段都不传。
      input_path?: string
      delete_source?: boolean
    }
    result:
      | {
          ok: true
          groups: RecoveryCodeGroup[]
          // 删除是独立于导入的另一个结果：导入成功但源文件还在时必须说出来，
          // 不能因为 ok:true 就当作全部办妥（这正是文件加密那边踩过的坑）。
          source_deleted?: boolean
          delete_error?: string
          delete_error_params?: Record<string, string | number>
        }
      | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  recovery_codes_update_meta: {
    params: { id: string; service?: string; account_label?: string; note?: string; low_stock_threshold?: number; review_interval_days?: number }
    result: { ok: true; group: RecoveryCodeGroup } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  recovery_codes_mark_used: {
    params: { id: string; code_index: number; used: boolean }
    result: { ok: true; group: RecoveryCodeGroup } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  recovery_codes_mark_checked: {
    params: { id: string }
    result: { ok: true; group: RecoveryCodeGroup } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  recovery_codes_delete: {
    params: { id: string }
    result: { ok: true } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  recovery_codes_delete_bulk: {
    params: { ids: string[] }
    result: { ok: true; deleted_count: number }
  }
  recovery_codes_export_text: {
    params: { output_path: string; ids?: string[]; format?: 'txt' | 'csv' | 'json' }
    result: { ok: true; output_path: string } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  recovery_codes_log_pdf_export: {
    params: { label: string }
    result: { ok: true }
  }
  recovery_codes_backup_export: {
    params: { output_path: string; backup_password: string }
    result: { ok: true; output_path: string } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  recovery_codes_backup_import_preview: {
    params: { input_path: string; backup_password: string }
    result:
      | { ok: true; items: BackupDiffItem[]; damaged: DamagedRecoveryCodeRecord[] }
      | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  recovery_codes_backup_import_confirm: {
    params: { input_path: string; backup_password: string; decisions: Record<string, 'keep_local' | 'use_backup' | 'merge'> }
    result:
      | { ok: true; groups: RecoveryCodeGroup[]; applied_count: number }
      | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  /** JSON 导出（v2 信封）。与 recovery_codes_export_text 的 format:'json' 分开：那个是三种文本格式的简单入口，
   *  这个承载加密/脱敏/只导未用/分片，每项都会改变输出文件数量或安全属性。 */
  recovery_codes_export_json: {
    params: {
      output_path: string
      ids?: string[]
      /** 只导还没用过的码。本地数据不受影响。 */
      only_unused?: boolean
      /** false = 脱敏导出：只有元数据和"用过没有"，没有码本身。 */
      include_codes?: boolean
      /** 给了就加密。与 include_codes:false 互斥。 */
      password?: string
      /** 每份最多几组；省略或 <=0 = 不分片。 */
      split_size?: number
      app_version?: string
    }
    result:
      | {
          ok: true
          /** 分片时不止一个。单份导出仍然用用户选的那个文件名。 */
          output_paths: string[]
          group_count: number
          code_count: number
          encrypted: boolean
          codes_redacted: boolean
        }
      | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  /** JSON 导入的试运行：解析并逐组比对本地，不写任何东西。与按文本的 recovery_codes_import_preview 不同，这条无损
   *  （used/备注/阈值/历史都从文件读出），才能算出真实差异。 */
  recovery_codes_json_import_preview: {
    params: { input_path: string; password?: string }
    result:
      | {
          ok: true
          meta: RecoveryCodesJsonMeta
          items: JsonImportDiffItem[]
          damaged: DamagedRecoveryCodeRecord[]
          summary: {
            fileGroupCount: number
            fileCodeCount: number
            damagedCount: number
            newCount: number
            conflictCount: number
            identicalCount: number
            localOnlyCount: number
          }
        }
      | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  recovery_codes_json_import_confirm: {
    params: {
      input_path: string
      password?: string
      decisions: Record<string, 'keep_local' | 'use_file' | 'merge'>
    }
    result:
      | { ok: true; groups: RecoveryCodeGroup[]; applied_count: number }
      | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  recovery_codes_undo: {
    params: Record<string, never>
    result: { ok: true; groups: RecoveryCodeGroup[] } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  recovery_codes_dashboard_summary: {
    params: Record<string, never>
    result: {
      ok: true
      serviceCount: number
      codeCount: number
      remainingCount: number
      lowStockGroupIds: string[]
      needsReviewGroupIds: string[]
    }
  }
  recovery_codes_emergency_next: {
    params: { id: string }
    result: { ok: true; code: string | null; remainingCount: number; hasNext: boolean } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  recovery_codes_gap_scan: {
    params: Record<string, never>
    result: { ok: true; gaps: Array<{ passwordId: string; name: string; domain: string }> }
  }
  recovery_codes_scan_downloads: {
    params: Record<string, never>
    result: { ok: true; files: Array<{ path: string; name: string; service: string }>; disabled?: boolean }
  }
  recovery_codes_settings_get: {
    params: Record<string, never>
    result: { ok: true; settings: RecoveryCodesSettings }
  }
  recovery_codes_settings_set: {
    params: { scan_downloads_enabled?: boolean; reveal_requires_verify?: boolean }
    result: { ok: true; settings: RecoveryCodesSettings } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  // ---- 恢复码：修改时间线 / 批量修改 / 去重 ----
  recovery_codes_revision_list: {
    params: { id: string }
    // 新的在前。
    result: { ok: true; revisions: RecoveryCodeRevision[] } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  recovery_codes_revision_reveal: {
    params: { id: string; revision_id: string }
    // 跟 recovery_codes_reveal 同一道「最近验证过」闸门；没过返回 recovery_codes.verify_required。
    result: { ok: true; codes: RevealedRecoveryCode[] } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  recovery_codes_revision_restore: {
    params: { id: string; revision_id: string }
    // 恢复本身也会在时间线上留一条 'restore'。组已被删除时会按快照重新建回来。
    result: { ok: true; group: RecoveryCodeGroup } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  recovery_codes_timeline: {
    // ids 省略 = 全部服务。新的在前。
    params: { ids?: string[]; limit?: number }
    result: { ok: true; entries: RecoveryCodeTimelineEntry[] }
  }
  recovery_codes_update_meta_bulk: {
    params: {
      ids: string[]
      service?: string
      account_label?: string
      note?: string
      /** 'replace'（默认）整段替换备注；'append' 追加到原备注末尾（换行分隔）。 */
      note_mode?: 'replace' | 'append'
      low_stock_threshold?: number
      review_interval_days?: number
      /** true = 顺带标记为「已核对」。 */
      mark_checked?: boolean
    }
    result:
      | { ok: true; groups: RecoveryCodeGroup[]; batch_id: string; changed_count: number }
      | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  recovery_codes_batch_undo: {
    params: { batch_id: string }
    result: { ok: true; groups: RecoveryCodeGroup[]; restored_count: number } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  recovery_codes_duplicates_scan: {
    params: Record<string, never>
    result: {
      ok: true
      groups: RecoveryCodeDuplicateGroup[]
      /** 组内有重复码的服务，以及重复了几个。 */
      within: Array<{ id: string; duplicate_count: number }>
    }
  }
  recovery_codes_duplicates_merge: {
    // keep_id 保留；merge_ids 的码并进来（按码去重，任一边标记过「已用」就算已用），
    // 然后删除 merge_ids。dedupe_within 顺带清掉每个保留组内部的重复码。
    params: { groups: Array<{ keep_id: string; merge_ids: string[] }>; dedupe_within?: boolean }
    result:
      | { ok: true; groups: RecoveryCodeGroup[]; merged_count: number; removed_codes: number; batch_id: string }
      | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  // ---- 笔记：修改时间线 / 批量修改 / 去重 ----
  note_revision_list: {
    params: { note_id: number; limit?: number }
    // 新的在前。
    result: { ok: true; revisions: NoteRevision[] } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  note_revision_get: {
    params: { revision_id: number }
    result: { ok: true; revision: NoteRevisionWithContent } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  note_revision_restore: {
    params: { revision_id: number }
    // 回到那一版的标题 + 分类 + 正文（has_content 为 false 的版本只恢复标题和分类）。
    result: { ok: true; note: Note } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  note_timeline: {
    // note_ids 省略 = 全部笔记。新的在前。
    params: { note_ids?: number[]; limit?: number }
    result: { ok: true; entries: NoteTimelineEntry[] }
  }
  note_bulk_edit_preview: {
    params: { note_ids: number[]; op: NoteBulkEditOp }
    result:
      | { ok: true; items: NoteBulkEditPreviewItem[]; total_matches: number }
      | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  note_bulk_edit_apply: {
    params: { note_ids: number[]; op: NoteBulkEditOp }
    result:
      | { ok: true; batch_id: string; changed_count: number; total_matches: number }
      | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  note_batch_undo: {
    // 把这一批里每篇笔记恢复到这批改动之前的那一版。
    params: { batch_id: string }
    result: { ok: true; restored_count: number } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  note_duplicates_scan: {
    params: { scope?: NoteCategoryScope }
    result: { ok: true; groups: NoteDuplicateGroup[] }
  }
  note_duplicates_merge: {
    // remove_ids 进回收站（7 天内可还原），它们的标签并到 keep_id 上。
    params: { groups: Array<{ keep_id: number; remove_ids: number[] }> }
    result: { ok: true; removed_count: number; batch_id: string } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  module_lock_settings_get: {
    params: Record<string, never>
    result: { ok: true; settings: Record<LockableModule, boolean> } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  module_lock_settings_set: {
    params: { module: LockableModule; enabled: boolean }
    result: { ok: true; module: LockableModule; enabled: boolean } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  note_image_storage_mode_get: {
    params: Record<string, never>
    result: { ok: true; mode: NoteImageStorageMode } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  note_image_storage_mode_set: {
    params: { mode: NoteImageStorageMode }
    result: { ok: true; mode: NoteImageStorageMode } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  note_text_storage_mode_get: {
    params: Record<string, never>
    result: { ok: true; mode: NoteTextStorageMode } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  note_text_storage_mode_set: {
    params: { mode: NoteTextStorageMode }
    result: { ok: true; mode: NoteTextStorageMode } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  change_password: { params: { new_password: string }; result: { ok: true } }
  rebind_totp_start: { params: Record<string, never>; result: { seed: string; qr_png_base64: string } }
  rebind_totp_confirm: {
    params: { seed: string; code: string }
    result: { ok: true } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  update_email: {
    params: { new_email: string; smtp_config: SmtpConfigInput }
    result: { ok: true }
  }
  regenerate_recovery_key: { params: Record<string, never>; result: { recovery_key: string } }
  rebind_fingerprint: { params: Record<string, never>; result: { ok: true } | { ok: false; error: string; error_params?: Record<string, string | number> } }
  get_smtp_config: { params: Record<string, never>; result: { config: SmtpConfigPublic | null } }
  send_test_email: {
    params: { smtp_config: SmtpConfigInput; to_addr: string }
    result: { ok: true } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  get_ai_config: { params: Record<string, never>; result: { config: AiConfigPublic | null } }
  update_ai_config: {
    params: AiConfigInput
    result: { ok: true } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  test_ai_connection: {
    params: AiConfigInput
    result: { ok: true; latency_ms: number } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  list_ai_models: {
    params: AiConfigInput
    result:
      | {
          ok: true
          /** 服务端提供的模型 id，已去重排序。**空数组是正常结果**——有些兼容
           *  端点没实现 /models，那时界面退回手动填模型名，不是报错。 */
          models: string[]
          /** 同一批模型配上可读名字与发布日期，按发布日期从新到旧，无日期的（自建端点、中转）排最后。
           *  保留纯 id 的 `models`，后端更新而渲染端还是旧版时下拉框仍可用，只是没日期。 */
          model_details?: AiModelDetail[]
          /** 当前配置里选的那个，一定在 models 里（后端会并进去）。 */
          current: string
        }
      | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  ai_chat: {
    params: { messages: AiChatMessage[]; no_desktop_tools?: boolean }
    // skills_used 仅 auto 模式非空。tools_used 为模型本次调用的受限全局桌面工具。
    // web_fetches 列出 web_fetch 抓取的 URL，单列是因为它是网络动作而非桌面动作，界面要单独标注透明度。
    // stopped 仅当触达工具调用轮数上限、回复被强制结束时为 true。
    result:
      | { ok: true; reply: string; skills_used: string[]; tools_used: string[]; web_fetches: string[]; stopped: boolean }
      | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  ai_summarize_text_file: {
    params: { path: string }
    result: { ok: true; summary: string; truncated: boolean } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  ai_read_text_file: {
    params: { path: string }
    result: { ok: true; text: string; truncated: boolean } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  ai_skill_list: { params: Record<string, never>; result: { skills: AiSkill[] } }
  // Batch: the picker allows multiple files/folders at once, so each path
  // gets its own ok/error result rather than the whole call failing.
  ai_skill_import: {
    params: { paths: string[]; name?: string }
    result: { ok: true; results: AiSkillImportResult[] } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  ai_skill_delete: {
    params: { ids: string[] }
    result: { ok: true; deleted: string[] } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  ai_history_list: { params: Record<string, never>; result: { ok: true; conversations: AiHistoryListItem[] } }
  ai_history_get: {
    params: { id: number }
    result: { ok: true; conversation: AiHistoryConversation } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  // Upsert: pass the id returned by a previous save to update that same
  // conversation in place, or omit it to start a new one.
  ai_history_save: {
    params: { id?: number; messages: AiChatMessage[] }
    result: { ok: true; conversation: AiHistoryConversation } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  ai_history_delete: {
    params: { ids: number[] }
    result: { ok: true; deleted_count: number } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  ai_history_delete_all: { params: Record<string, never>; result: { ok: true; deleted_count: number } }
  clipboard_list: {
    params: { limit?: number }
    result: { ok: true; entries: ClipboardEntry[] } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  clipboard_set_pinned: {
    params: { id: number; pinned: boolean }
    result: { ok: true } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  // 拖拽置顶项后写入新的手工排序位。位置用相邻项 id 表达（before_id 为移动后紧邻上方、after_id 为紧邻下方，
  // null 表示头/尾），不用下标：并发（别的窗口取消置顶、监听器插入新记录）会使下标失效。
  // 回传完整置顶序列：触发整段重编号时所有 pin_order 都会变，单个值对不上。
  clipboard_move_pinned: {
    params: { id: number; before_id: number | null; after_id: number | null }
    result:
      | { ok: true; pin_order: number; pinned: ClipboardEntry[] }
      | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  clipboard_list_pinned: {
    params: Record<string, never>
    result: { ok: true; entries: ClipboardEntry[] } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  clipboard_set_hidden: {
    params: { id: number; hidden: boolean }
    result: { ok: true } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  clipboard_snippet_create: {
    params: { content_text: string }
    result: { ok: true; entry: ClipboardEntry } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  clipboard_snippet_list: {
    params: { limit?: number }
    result: { ok: true; entries: ClipboardEntry[] } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  clipboard_snippet_update: {
    params: { id: number; content_text: string }
    result: { ok: true } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  clipboard_paste: {
    params: { id: number; auto_paste?: boolean }
    // pasted: true 表示已向先前焦点窗口模拟 Ctrl+V；false 表示内容已在剪贴板，但被 Windows 前台锁限制
    // （或无外部窗口）未能自动粘贴，不是错误，需用户自己粘贴。
    result: { ok: true; pasted: boolean } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  clipboard_set_paused: {
    params: { paused: boolean }
    result: { ok: true }
  }
  clipboard_delete: {
    params: { id: number }
    result: { ok: true } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  clipboard_delete_bulk: {
    params: { ids: number[] }
    result: { ok: true; deleted_count: number } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  clipboard_restore: {
    params: { id: number }
    result: { ok: true } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  clipboard_restore_bulk: {
    params: { ids: number[] }
    result: { ok: true; restored_count: number } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  clipboard_list_trash: {
    params: { limit?: number }
    result: { ok: true; entries: ClipboardEntry[] } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  clipboard_hard_delete: {
    params: { id: number }
    result: { ok: true } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  clipboard_hard_delete_bulk: {
    params: { ids: number[] }
    result: { ok: true; deleted_count: number } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  clipboard_blacklist_list: {
    params: Record<string, never>
    result: { ok: true; apps: BlacklistApp[] } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  clipboard_blacklist_add: {
    params: { app_name: string }
    result: { ok: true; entry: BlacklistApp } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  clipboard_blacklist_remove: {
    params: { id: number }
    result: { ok: true } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  clipboard_export: {
    // 三个筛选是**与**的关系，都不传 = 导出全部。
    // `ids: []`（空数组）和不传 ids 是两回事：空数组 = 用户一条都没勾，导 0 条。
    params: { output_path: string; only_pinned?: boolean; only_hidden?: boolean; ids?: number[] }
    result: { ok: true; exported_count: number; output_path: string } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  clipboard_import: {
    // input_paths 支持一次导多个文件；input_path 是老写法，后端仍然认。
    // delete_source：导入成功后安全删除原文件（导出文件是明文，界面上默认开）。
    params: { input_paths?: string[]; input_path?: string; delete_source?: boolean }
    result:
      | {
          ok: true
          imported_count: number
          /** 因内容已在库里而跳过的条数，必须与 imported_count 一起显示：同一份备份导第二次时 imported_count 为 0，
           *  只报它会与「文件是空的」「导入坏了」无法区分。 */
          skipped_count: number
          /** 逐个文件独立判断——三个文件里坏了一个，另外两个照常导入。 */
          failed: { path: string; detail: string }[]
          deleted_sources: string[]
          delete_failures: { path: string; detail: string }[]
        }
      | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  // 近似重复，与精确去重是两份互不重叠的清单（精确组已排除）。组的键是 keep_id 而非内容哈希
  // （近似组每条哈希都不同）。判定见 clipboard/near_dup.py。
  clipboard_find_near_duplicates: {
    params: Record<string, never>
    result:
      | { ok: true; groups: ClipboardNearDuplicateGroup[] }
      | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  clipboard_merge_near_duplicates: {
    // 不传 = 合并全部；传数组 = 只合并这几组；**空数组 = 一组都没选，合并 0 条**。
    params: { keep_ids?: number[] }
    result:
      | { ok: true; merged_groups: number; merged_count: number }
      | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  clipboard_find_duplicates: {
    // 只读预览。合并是另一个调用——批量让内容消失的操作要用户先看见再点头。
    params: Record<string, never>
    result:
      | { ok: true; groups: ClipboardDuplicateGroup[] }
      | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  clipboard_merge_duplicates: {
    // 不传 content_hashes = 合并全部；传数组 = 只合并选中的那几组。
    // 跟 clipboard_export 的 ids 一样，空数组 ≠ 不传：空数组是"一组都没选"。
    params: { content_hashes?: string[] }
    result:
      | { ok: true; merged_groups: number; merged_count: number }
      | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  clipboard_search: {
    params: { query: string; limit?: number }
    result: { ok: true; entries: ClipboardEntry[] } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  // 密码泄露核查只回 id -> 次数，不回条目：前端已有整份列表，无需再经此通道传密码明文；结果也不落盘。
  // 胁迫密码：诱饵模式下 duress_status 一律回 configured:false，这是功能本意，被胁迫者打开设置页必须看到「没设过」。
  duress_status: {
    params: Record<string, never>
    result: { ok: true; configured: boolean } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  duress_set: {
    params: { current_password: string; duress_password: string }
    result: { ok: true } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  duress_clear: {
    params: Record<string, never>
    result: { ok: true } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  password_breach_check: {
    params: Record<string, never>
    result: { ok: true; breached: Record<string, number>; checked: number } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  clipboard_settings_get: {
    params: Record<string, never>
    result: { ok: true; settings: ClipboardSettings } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  clipboard_settings_set: {
    params: { settings: Partial<ClipboardSettings> }
    result: { ok: true; settings: ClipboardSettings } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  note_list: {
    // sort 不传则用后端存的偏好（backend_server._note_sort_mode）：列表有多个刷新入口，逐个带参数迟早漏一个，
    // 漏的那次会静默改用另一种顺序。
    params: { sort?: NoteSortMode }
    result:
      | { ok: true; notes: NoteListItem[]; sort: NoteSortMode }
      | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  note_reorder: {
    params: { ids: number[] }
    result:
      | { ok: true; moved: number; sort: NoteSortMode }
      | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  note_sort_mode_get: {
    params: Record<string, never>
    result: { ok: true; sort_mode: NoteSortMode } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  note_sort_mode_set: {
    params: { sort_mode: NoteSortMode }
    result: { ok: true; sort_mode: NoteSortMode } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  note_get: {
    params: { id: number }
    result: { ok: true; note: Note } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  note_create: {
    params: { title: string; category: string; content: string; encrypt?: boolean; format?: NoteFormat; linked?: boolean }
    result: { ok: true; note: Note } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  note_update: {
    params: { id: number; title?: string; category?: string; content?: string }
    result: { ok: true; note: Note } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  note_metadata_update: {
    params: { id: number; title?: string; category?: string }
    result: { ok: true; note: NoteListItem } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  note_format_set: {
    params: { id: number; format: NoteFormat }
    result: { ok: true; note: Note } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  note_set_pinned: {
    params: { id: number; pinned: boolean }
    result: { ok: true } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  note_set_pinned_bulk: {
    params: { ids: number[]; pinned: boolean }
    result: { ok: true; updated_count: number } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  note_set_hidden: {
    params: { id: number; hidden: boolean }
    result: { ok: true } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  note_set_hidden_bulk: {
    params: { ids: number[]; hidden: boolean }
    result: { ok: true; updated_count: number } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  note_delete: {
    params: { id: number }
    result: { ok: true } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  note_delete_bulk: {
    params: { ids: number[] }
    result: { ok: true; deleted_count: number } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  note_restore: {
    params: { id: number }
    result: { ok: true } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  note_restore_bulk: {
    params: { ids: number[] }
    result: { ok: true; restored_count: number } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  note_category_move_bulk: {
    params: { ids: number[]; category: string }
    result: { ok: true; updated_count: number } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  // 一次调用完成「隐藏并归入隐藏分类」，而非 note_set_hidden_bulk + note_category_move_bulk 两步：
  // 两步中途失败会留下已隐藏却仍带旧可见分类的笔记，既不在列表也不在所选隐藏分类里。
  // `category` 可为 ""（隐藏区未分类）或多级路径如 "Private/Finance/2026"。
  note_move_to_hidden_bulk: {
    params: { ids: number[]; category?: string }
    result: { ok: true; updated_count: number } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  note_list_trash: {
    params: Record<string, never>
    result: { ok: true; notes: NoteListItem[] } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  note_hard_delete: {
    params: { id: number }
    result: { ok: true } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  note_hard_delete_bulk: {
    params: { ids: number[] }
    result: { ok: true; deleted_count: number } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  note_import_files: {
    // base_dir：调用方递归扫描的根目录，后端据此用子文件夹相对路径推导分类（如 "Internet/Node"，沿用 "/" 多级约定）；
    // 无共同根的导入（多选文件）不传，回落到关键词/名称分类器。
    // hidden 使整批进入隐藏区（并在隐藏作用域建分类，与普通目录独立）。target_category 是整批共用前缀，
    // 与子文件夹路径拼接而非替换："Finance/2026/x.txt" 加前缀 "Private" 得 "Private/Finance/2026"。两者默认保持旧行为。
    params: { paths: string[]; encrypt?: boolean; base_dir?: string; hidden?: boolean; target_category?: string; mode?: NoteImportMode }
    // imported 是 NoteListItem[] 而非 Note[]：刻意不回传刚导入笔记的完整 `content`，
    // 否则数百 MB 内容会重现大笔记要避免的「单条巨大 IPC 消息」。进度事件带 NoteImportProgress 的额外字段。
    result: {
      ok: true
      imported: NoteListItem[]
      failed: { path: string; error: string; error_params?: Record<string, string | number> }[]
      copied?: number
    } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  note_content_session_open: {
    params: { id: number }
    result: { ok: true; session_id: string; segment_count: number; note: NoteListItem } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  note_content_segment_get: {
    params: { session_id: string; ordinal: number }
    result: { ok: true; segment: NoteContentSegment; segment_count: number } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  note_content_segment_put: {
    params: { session_id: string; segment_id: number; expected_revision: number; content: string }
    result: { ok: true; segment: NoteContentSegment } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  note_content_session_close: {
    params: { session_id: string }
    result: { ok: true }
  }
  note_content_chunk_get: {
    // cursor is null on the first call for a note; pass back next_cursor
    // until eof is true. See notes/service.py's get_content_chunk.
    params: { id: number; cursor: number | null; max_chars: number }
    result:
      | { ok: true; chunk: string; next_cursor: number; eof: boolean }
      | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  note_content_write_chunk: {
    // is_first 开启该笔记的新保存会话（中止其他进行中的）；is_last 收尾。`note` 仅在 done 为 true 时才有，见 notes/service.py write_content_chunk。
    params: { id: number; chunk: string; is_first: boolean; is_last: boolean }
    result:
      | { ok: true; done: false }
      | { ok: true; done: true; note: NoteListItem }
      | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  note_linked_folder_add: {
    params: { dir: string; category?: string; hidden?: boolean }
    result:
      | ({ ok: true; folder: NoteLinkedFolder; sync: NoteLinkedSyncResult })
      | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  note_linked_folder_list: {
    params: Record<string, never>
    result: { ok: true; folders: NoteLinkedFolder[] } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  note_linked_folder_remove: {
    params: { id: number }
    result: { ok: true } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  note_linked_sync: {
    params: { folder_id?: number }
    result: ({ ok: true } & NoteLinkedSyncResult) | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  note_import_mode_get: {
    params: Record<string, never>
    result: { ok: true; mode: NoteImportMode } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  note_import_mode_set: {
    params: { mode: NoteImportMode }
    result: { ok: true; mode: NoteImportMode } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  note_scan_txt_dir: {
    params: { dir: string }
    result:
      | { ok: true; files: NoteScanFile[] }
      | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  note_export_files: {
    params: { ids: number[]; output_dir: string }
    result: {
      ok: true
      exported: { id: number; title: string; path: string }[]
      failed: { id: number; error: string; error_params?: Record<string, string | number> }[]
    } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  note_category_list: {
    params: { scope: NoteCategoryScope }
    result: { ok: true; categories: NoteCategory[] } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  note_category_create: {
    params: { name: string; scope: NoteCategoryScope; keywords?: string }
    result: { ok: true; category: NoteCategory } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  note_category_set_keywords: {
    params: { id: number; keywords: string }
    result: { ok: true; category: NoteCategory } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  // 删除分类，mode 必须显式给出：'promote' 只删这一级、子分类升到父级、笔记不丢；
  // 'cascade' 删整棵子树、其下笔记全变未分类（笔记不删）。破坏力差一个量级，前端须先调 note_category_impact
  // 摆出影响范围，让用户在确认框里当场选，不走默认值。
  note_category_delete: {
    params: { id: number; mode: NoteCategoryDeleteMode }
    result:
      | { ok: true; impact: NoteCategoryImpact }
      | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  // 删除/重命名前的影响范围预览。分类树是层级结构，一次误删可能连带影响几十篇
  // 笔记的归属——不该在看不见后果的情况下点下去。
  note_category_impact: {
    params: { id: number }
    result:
      | { ok: true; impact: NoteCategoryImpact }
      | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  // 重命名 / 移动一个分类连同它整棵子树。物化路径下两者是同一个操作（换一段
  // 路径前缀），所以没有单独的 move RPC。
  note_category_rename: {
    params: { id: number; name: string }
    result: { ok: true; category: NoteCategory } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  // 回溯重跑自动分类的预览，只算不写。必须先预览再应用：分类器不知道用户为何手工归档，静默推翻既难发现又难撤销。
  note_reclassify_preview: {
    params: { scope: NoteCategoryScope; include_categorized?: boolean }
    result:
      | { ok: true; changes: NoteReclassifyChange[]; scanned: number; truncated: boolean }
      | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  // 写入用户确认过的改动列表（前端可剔除行）。传列表而不让后端重跑：期间新建分类可能使重跑结果不同，用户确认的就不是实际发生的。
  note_reclassify_apply: {
    params: { changes: NoteReclassifyChange[] }
    result: { ok: true; applied: number } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  note_search: {
    params: { query?: string; category?: string; tag?: string; date_from?: string; date_to?: string; sort?: NoteSortMode }
    result: { ok: true; notes: NoteListItem[] } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  note_find_title_mentions: {
    params: { id: number; title: string }
    result: { ok: true; notes: NoteListItem[] } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  note_tag_list: {
    params: { scope: NoteCategoryScope }
    result: { ok: true; tags: NoteTag[] } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  note_tag_create: {
    params: { name: string; scope: NoteCategoryScope }
    result: { ok: true; tag: NoteTag } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  note_tag_delete: {
    params: { id: number }
    result: { ok: true } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  note_tags_get: {
    params: { id: number }
    result: { ok: true; tags: Pick<NoteTag, 'id' | 'name'>[] } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  note_tags_set: {
    params: { id: number; tag_ids: number[] }
    result: { ok: true; note: Note } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  note_tags_add_bulk: {
    params: { ids: number[]; tag_id: number }
    result: { ok: true; updated_count: number } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  note_image_list: {
    params: { note_id: number }
    result: { ok: true; images: NoteImageMeta[] } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  note_image_get: {
    params: { id: number }
    result: { ok: true; image: NoteImageFull } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  note_image_import_files: {
    params: { note_id: number; paths: string[] }
    result: {
      ok: true
      imported: NoteImageMeta[]
      failed: { path: string; error: string; error_params?: Record<string, string | number> }[]
    } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  note_image_paste: {
    params: { note_id: number; image_base64: string }
    result: { ok: true; image: NoteImageMeta } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  note_image_delete: {
    params: { id: number }
    result: { ok: true } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  network_speedtest_run: {
    params: { network_type: NetworkSpeedtestType; connection_mode?: NetworkSpeedtestConnectionMode; environment_tag?: string | null }
    result:
      | {
          ok: true
          network_type: NetworkSpeedtestType
          proxy_label: string | null
          ipv4: string | null
          ipv6: string | null
          ping_ms: number
          jitter_ms: number
          loss_ratio: number
          dns_ms: number | null
          download_mbps: number
          upload_mbps: number
          node_label: string
          /** 这次实际落到的 Cloudflare 边缘机房（IATA 码，如 HKG）。anycast 决定
           *  去哪儿，而去哪儿直接决定能测到多少。探测失败时为 null。 */
          edge_node: string | null
          /** 这次开了几条并发流。单流模式恒为 1。 */
          stream_count: number
          /** 真正计入统计的秒数——不含被丢掉的 TCP 慢启动预热段。 */
          measured_seconds: number
          connection_mode: NetworkSpeedtestConnectionMode
          ping_min_ms: number | null
          ping_max_ms: number | null
          download_loaded_ping_ms: number | null
          upload_loaded_ping_ms: number | null
          /** 稳态段吞吐的 p90/p10。1.0 = 纹丝不动，越大说明线路本身波动越宽，复测数不同是线路性质而非误差。
           *  桶数不够（线路极慢/测试中断）时为 null，按「没测到」渲染。 */
          download_stability: number | null
          upload_stability: number | null
          ratings: Record<NetworkSpeedtestRatingKey, NetworkSpeedtestRating>
          history_id: number | null
          anomaly: { baseline_download_mbps: number; baseline_ping_ms: number } | null
        }
      | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  network_speedtest_history_list: {
    params: { network_type?: NetworkSpeedtestType; environment_tag?: string; limit?: number }
    result:
      | { ok: true; results: NetworkSpeedtestHistoryEntry[]; tags: string[] }
      | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  network_speedtest_history_set_tag: {
    params: { id: number; tag: string | null }
    result: { ok: true } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  network_speedtest_history_clear: {
    params: Record<string, never>
    result: { ok: true; cleared_count: number } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  file_clip_copy: {
    params: { paths: string[] }
    result: { ok: true; count: number } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  file_clip_cut: {
    params: { paths: string[] }
    result: { ok: true; count: number } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  file_clip_clipboard_status: {
    params: Record<string, never>
    result:
      | { ok: true; has_files: boolean; paths: string[]; is_cut: boolean }
      | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  // 结果不是简单的 ok:true/false：report.ok 表示传输本身是否全部成功（无文件错误、未取消），与 RPC 是否抛异常无关。
  // 前置校验失败（剪贴板/路径为空）没有 report，走 error/error_params；report 已生成但有文件级错误时字段仍齐全、ok 为 false。
  // renderer 用 'files_total' in result 判断走哪一支（FileManagerScreen.tsx）。
  file_clip_paste: {
    params: { dest_dir: string; on_conflict?: 'rename' | 'skip' | 'overwrite' }
    result:
      | ({ ok: boolean } & FileClipTransferReport)
      | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  file_clip_delete: {
    params: { paths: string[]; recycle: boolean }
    result:
      | ({ ok: boolean } & FileClipTransferReport)
      | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  file_clip_hook_set_enabled: {
    params: { enabled: boolean }
    result:
      | ({ ok: boolean } & FileClipHookStatus)
      | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  file_clip_hook_status: {
    params: Record<string, never>
    result:
      | ({ ok: boolean } & FileClipHookStatus)
      | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  file_clip_progress_preferences_get: {
    params: Record<string, never>
    result:
      | { ok: true; preferences: TaskCardPreferences }
      | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  file_clip_progress_preferences_set: {
    params: TaskCardPreferences
    result:
      | { ok: true; preferences: TaskCardPreferences }
      | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  file_clip_hook_sync_shortcuts: {
    params: Record<string, never>
    result:
      | { ok: true; config_path: string; agent_restarted: boolean }
      | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  file_clip_clear_clipboard: {
    params: Record<string, never>
    result: { ok: true } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  file_clip_check_conflicts: {
    params: { dest_dir: string; mode?: 'existing' | 'all' }
    result:
      | { ok: true; conflicts: FileClipConflictItem[]; has_files: boolean; is_cut?: boolean; count?: number }
      | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  file_clip_secure_erase: {
    params: { paths: string[] }
    result:
      | ({ ok: boolean; items_total: number; items_done: number; errors: { path: string; message: string }[]; elapsed: number; cancelled: boolean })
      | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  file_clip_detect_duplicates: {
    params: { dest_dir: string }
    result:
      | { ok: true; duplicates: { name: string; source_path: string; size: number }[]; count: number; total_bytes: number }
      | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  file_clip_undo: {
    params: Record<string, never>
    result:
      | { ok: true; undo_action: string; description: string; count: number }
      | { ok: false; error: string; error_params?: Record<string, string | number>; description?: string }
  }
  file_clip_undo_info: {
    params: Record<string, never>
    result: { ok: true; has_undo: boolean } & (
      | { has_undo: false }
      | { has_undo: true; operation: string; files_total: number; reversible: boolean; timestamp: string; description: string }
    )
  }
  file_clip_history: {
    params: { limit?: number }
    result: { ok: true; entries: FileClipHistoryEntry[] } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
  file_clip_history_clear: {
    params: Record<string, never>
    result: { ok: true } | { ok: false; error: string; error_params?: Record<string, string | number> }
  }
}

export interface FileClipHookStatus {
  compiled: boolean
  running: boolean
  autostart: boolean
  exe_path: string
  source_path: string
  cli_script: string
  state: 'running' | 'stopped' | 'failed' | 'unknown'
  last_error: string | null
}

export type TaskCardPosition =
  | 'top-left'
  | 'top-center'
  | 'top-right'
  | 'middle-left'
  | 'center'
  | 'middle-right'
  | 'bottom-left'
  | 'bottom-center'
  | 'bottom-right'

export interface TaskCardPreferences {
  position: TaskCardPosition
  auto_hide_seconds: 3 | 5 | 10
  compact: boolean
}

export interface FileClipTransferReport {
  operation: string
  files_total: number
  bytes_total: number
  files_done: number
  bytes_done: number
  fast_moved_count: number
  renamed: { from: string; to: string }[]
  skipped: string[]
  errors: { path: string; message: string }[]
  elapsed: number
  cancelled: boolean
}

export interface FileClipConflictItem {
  name: string
  source_path: string
  dest_exists: boolean
  source_size: number
  dest_size: number
}

export interface FileClipHistoryEntry {
  operation: string
  timestamp: string
  files_total: number
  bytes_total: number
  fast_moved_count: number
  elapsed: number
  errors_count: number
  path_count: number
}

// file_clip_paste/file_clip_delete 的进度：done/total 与任务卡同口径（拷贝按字节，删除/同盘改名按条目），见 fileops/service.py::_emit。
export interface FileClipProgress extends ProgressEvent {
  scan_complete?: boolean  // false = 边扫边拷，总量仍在增长
  unit?: 'bytes' | 'items'
  files_done?: number
  files_total?: number
  bytes_done?: number
  bytes_total?: number
  speed?: number  // unit 每秒，最近 2 秒滑动平均
  eta?: number | null
  current?: string
}

export interface NetworkSpeedtestHistoryEntry {
  id: number
  created_at: string
  network_type: NetworkSpeedtestType
  node: string
  environment_tag: string | null
  ping_ms: number | null
  jitter_ms: number | null
  loss_ratio: number | null
  dns_ms: number | null
  download_mbps: number | null
  upload_mbps: number | null
  ipv4: string | null
  ipv6: string | null
  connection_mode: NetworkSpeedtestConnectionMode | null
  ping_min_ms: number | null
  ping_max_ms: number | null
  download_loaded_ping_ms: number | null
  upload_loaded_ping_ms: number | null
}

// 只剩本机直连。'proxy' 刻意保留：历史库里有过去用代理测的真实记录，从类型删掉会使这些行读出时类型对不上。新测量只会是 'local'。
export type NetworkSpeedtestType = 'local' | 'proxy'

// "single" = 单条 TCP 流（可与旧结果比较）；"multi" = 多条并发流之和，更接近专业工具，因为单流常填不满高速/高延迟线路。
export type NetworkSpeedtestConnectionMode = 'single' | 'multi'

export type NetworkSpeedtestRatingKey =
  | 'browsing'
  | 'streaming'
  | 'video'
  | 'gaming'
  | 'overall_speed'
  | 'latency'
  | 'stability'

export interface NetworkSpeedtestRating {
  stars: 1 | 2 | 3 | 4 | 5
  tier: 'poor' | 'fair' | 'good'
  color: 'red' | 'yellow' | 'green'
}

// network_speedtest_run 的进度负载（rpc_network_speedtest_run）：done/total 遵循通用 ProgressEvent 契约，其余为本方法各阶段专有数字。
export interface NetworkSpeedtestProgress extends ProgressEvent {
  phase: 'dns' | 'ip' | 'ping' | 'download' | 'upload'
  dns_ms?: number | null
  ipv4?: string | null
  ipv6?: string | null
  /** 随 "ip" 阶段一起到达——这样测速还在跑的时候界面就能显示落到了哪个机房。 */
  edge_node?: string | null
  ping_ms?: number
  jitter_ms?: number
  loss_ratio?: number
  ping_min_ms?: number
  ping_max_ms?: number
  download_mbps?: number
  upload_mbps?: number
  // 只在下载/上传阶段各自的最后一条消息里出现（该阶段测量结束、加压延迟
  // 采样线程已停止并汇总完成之后），实时tick的中间消息不带这个字段。
  download_loaded_ping_ms?: number | null
  upload_loaded_ping_ms?: number | null
  download_stability?: number | null
  upload_stability?: number | null
}

// note_import_files 的进度负载：该 RPC 一次处理整批路径，故除通用 done/total 字节计数外，还标明当前处理的文件。
export interface NoteImportProgress extends ProgressEvent {
  file_index: number
  total_files: number
  file_name: string
}

export type VaultMethodName = keyof VaultMethods

export interface ProgressEvent {
  done: number
  total: number
  // 一次调用可能含多段各自 0→100% 的工作，此字段说明当前是哪段；不带即主体段，缺了它进度条走满又归零会像出错。
  // 类型取宽 `string`：各 RPC 阶段名互不相干，并成联合会让每个新增阶段都回来改这里；需要精确类型的子类型自行收窄（见 NetworkSpeedtestProgress）。
  phase?: string
}

export interface ProgressPayload extends ProgressEvent {
  method: string
  // 回显调用方传给 vaultApi.call 的第 3 个参数。广播通道 vault:progress 会把进度发给所有 onProgress 订阅者，
  // 只靠 `method` 无法区分同一方法的并发调用（如 FilesPane.tsx 并行 runBatch 的多个 encrypt_file/decrypt_file）。
  // 未传 token 时缺省，只按 `method` 过滤的单调用订阅者不受影响。
  progressToken?: string
}

// Python 后端主动推送的消息（无 `id`，不是任何请求的应答），走独立的 'vault:event' 通道而非 vault:call。
// 目前仅剪贴板历史使用（后台监听线程随时可能产生新条目）。
export interface ClipboardNewEntryEvent {
  event: 'clipboard_new_entry'
  entry: ClipboardEntry
}

export type VaultPushEvent = ClipboardNewEntryEvent
