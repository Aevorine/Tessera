/**
 * 电脑清理套件的数据类型，独立于已两千多行的 `ipcTypes.ts`（那里只留 `VaultMethods` 签名并从这里 re-export）。
 * 字段名保持 snake_case，即 Python 后端原样输出的 JSON：边界转 camelCase 要多改一处，转换函数还会成为静默 undefined 的来源。
 */

/** 五级重要性。后端用整数枚举，过 JSON 时转成这几个字符串。 */
export type PcCleanImportance = 'critical' | 'driver' | 'common' | 'optional' | 'junk'

export const PCCLEAN_IMPORTANCE_ORDER: readonly PcCleanImportance[] = [
  'junk',
  'optional',
  'common',
  'driver',
  'critical',
] as const

export type PcCleanCategory =
  | 'junk'
  | 'browserCache'
  | 'privacy'
  | 'plugins'
  | 'downloads'
  | 'diskSlimming'
  | 'bigFiles'
  | 'dirAnalysis'
  | 'duplicates'
  | 'volumes'
  | 'memory'
  | 'startup'
  | 'contextMenu'
  | 'software'
  | 'leftovers'
  | 'registry'
  | 'popupSources'
  /** 用户自写的清理规则（`pcclean/userrules.py`）。曾经前端从未发起过 `scan('custom')`，
   *  规则能配置、存进 `user-rules.json` 却永不执行，且不报错不报空。 */
  | 'custom'
  /** 浏览器分项数据：Cookie / 历史 / 表单 / 站点存储。跟 `browserCache`
   *  是两件事——缓存删了下次访问重建，这些删了要重新登录。 */
  | 'browserData'
  /** 被新版本顶替的旧驱动包（`pnputil /enum-drivers`）。 */
  | 'driverStore'
  /** 空文件夹 / 失效快捷方式 / 零字节文件。 */
  | 'emptyDirs'

/** 删除后能否取回，后端 `actions.reversibility()` 三档，由 `pcclean/safety.py` 回填进 `detail`：
 *  `recycle` 进回收站，用户可自行拉回；`restorable` 改注册表/自启项，有备份和撤销日志，本应用内可撤销；
 *  `permanent` 真删，拿不回来。 */
export type PcCleanReversibility = 'recycle' | 'restorable' | 'permanent'

/** 影响面：删了之后会注意到什么（而非占多少地方）。`size_bytes` 排得出谁占地方，排不出谁删了会疼，后者才是用户要判断的。 */
export type PcCleanImpact =
  | 'cache'
  | 'history'
  | 'signin'
  | 'config'
  | 'userdata'
  | 'system'

/** 重建成本：恢复到原样要付出什么。`none` = 系统自己会补。 */
export type PcCleanRebuildCost = 'none' | 'low' | 'high'

/** `detail` 里由 `safety.py` 统一回填、每条都有的字段；与各分类自己的附加字段（`Record<string, unknown>`）不同，故单列接口。 */
export interface PcCleanSafetyDetail {
  reversibility?: PcCleanReversibility
  impact?: PcCleanImpact[]
  rebuild_cost?: PcCleanRebuildCost
  /** 受保护路径的 i18n 键。有值 = 这一项后端拒绝清理（同时 `locked` 为 true）。 */
  protected?: string
  /** 后端把 scanner 建议的默认勾选降级了，值是原因的 i18n 键。 */
  demoted?: string
  /** 最后改动时间（Unix 秒）。**是 mtime 不是 atime**：Win10 1803 起
   *  `NtfsDisableLastAccessUpdate` 默认开着，atime 根本不更新。 */
  last_change_ts?: number
  /** 占着这一项的进程名（`chrome.exe`）。空串/缺失 = 没被占用。 */
  blocking_process?: string
  browser_running?: boolean
}

export interface PcCleanItem {
  item_id: string
  category: string
  label: string
  size_bytes: number
  path: string
  importance: PcCleanImportance
  /** i18n 键，不是已翻译的文案——后端要给六种语言用。 */
  reason: string
  /** 后端也会拒绝对它执行清理。界面禁用勾选框只是给人看的。 */
  locked: boolean
  default_selected: boolean
  detail: Record<string, unknown> & PcCleanSafetyDetail
}

export interface PcCleanScanResult {
  ok: boolean
  error?: string
  category: string
  items: PcCleanItem[]
  count: number
  total_bytes: number
  /** 去掉锁死项之后真正能清出来的字节数。首屏那个大数字用的是它。 */
  selectable_bytes: number
  elapsed_ms: number
  /** true = 命中条目上限，列表不完整。**界面必须显示出来**——
   *  「只有 500 条」和「确实只有 500 条」长得一模一样。 */
  truncated: boolean
  /** true = 这一类用光时间预算提前收工，列表不完整。与 `truncated` 分开：truncated 是东西太多，重扫仍一样；
   *  timed_out 是这次太慢，界面应给「重扫这一类」。 */
  timed_out?: boolean
  /** true = 只扫了一部分范围（预算中途用完），换空闲时间重扫会更多。与 `truncated`（东西太多只显示前 N 个，扫描本身完整）不同。
   *  合并过一次，直接令大文件扫描的落盘缓存失效（它天生按 limit 截断）。 */
  partial?: boolean
  /** 正在扫的目录，纯展示。慢扫描里数字动得极慢，真正让人相信"还在干活"
   *  的是**路径在往前滚**——用户认得出自己的目录名。 */
  current_path?: string
  errors: string[]
  /** 本轮实际检查的位置数（目录 / 注册表键 / 进程），用来区分两种「0 项」：
   *  「检查了 12,431 处」是真干净，「检查了 0 处」是这一类根本没跑起来。 */
  scanned_dirs?: number
  scanned_files?: number
  /** 因为权限/占用被拒绝的次数。大于 0 时界面要说明"这一块没扫到"。 */
  denied?: number
  cancelled?: boolean
  /** true = 这一格画的是上次落盘的结果，真正的扫描还在跑。 */
  from_cache?: boolean
  /** 缓存的岁数（秒）。用来在界面上说清"这是多久以前的数字"。 */
  cache_age_s?: number
  /** true = 缓存已经旧到不能直接拿去执行，点清理前前端要先重扫。 */
  stale?: boolean
  /** 后端估的剩余时间（毫秒）。0 = 没有历史样本，显示"计算中"。 */
  eta_ms?: number
}

export interface PcCleanSummary {
  reclaimable_bytes: number
  total_items: number
  needs_attention: number
  by_category: Record<
    string,
    {
      count: number
      default_selected: number
      junk_count: number
      selectable_bytes: number
      /** false = 这一类的字节数不是磁盘空间（service.py 的 NON_SPACE_CATEGORIES）。目前只有 memory：统计的是进程工作集，清了硬盘不会多出空间。 */
      space_backed: boolean
      truncated: boolean
    }
  >
}

export interface PcCleanMemoryStatus {
  ok?: boolean
  total_bytes: number
  available_bytes: number
  used_bytes: number
  load_percent: number
  /** 「看起来被占用、其实随时能还回来」的那一块。单独报出来是这个面板
   *  最有价值的一个数字——它解释了为什么「已用内存」看着那么高。 */
  cache_bytes: number
  commit_total_bytes: number
  commit_limit_bytes: number
  process_count: number
  thread_count: number
  handle_count: number
}

/**
 * 一类扫描失败的结构化原因。`errors: string[]` 只给日志看；界面要说「注册表这一类因拒绝访问没跑完，
 * 点此只重扫这一类」，必须知道是哪一类、什么错。
 */
export interface PcCleanFailure {
  category: string
  /** 异常类型名，如 `PermissionError`。 */
  code: string
  /** 压成一行的原因原文。可能为空——那时只显示 code。 */
  detail: string
}

export interface PcCleanHealthResult {
  ok: boolean
  cancelled: boolean
  elapsed_ms: number
  categories: Record<string, PcCleanScanResult>
  errors: string[]
  /** 空数组 = 全部跑完了，界面一个字的错误都不该显示。 */
  failures?: PcCleanFailure[]
  summary: PcCleanSummary
  memory: PcCleanMemoryStatus
  /** 用光了时间预算、只交回半截结果的类。 */
  timed_out?: string[]
}

/** 一键体检的流式分类消息。每扫完一类推一条，界面据此逐块渲染。 */
export interface PcCleanCategoryProgress {
  kind: 'category'
  category: string
  payload: PcCleanScanResult
}

/** 扫描开始前发的一条：本轮扫哪几类、每类历史耗时、预计剩余、并发数、哪几类直接取自落盘缓存。 */
export interface PcCleanScanPlan {
  categories: string[]
  estimates_ms: Record<string, number>
  /** 0 = 没有历史样本。界面显示"计算中"，**不要编一个数字**。 */
  eta_ms: number
  workers: number
  from_cache: string[]
}

/** 清理预演的结果。跑的是和真实清理**同一条**代码路径的 dry-run 分支。 */
export interface PcCleanPreviewResult {
  ok: boolean
  error?: string
  dry_run: boolean
  /** 会被处理的条目数。真实清理里这个位置是 `done`。 */
  preview: number
  freed_bytes: number
  by_reversibility: Record<string, { count: number; bytes: number }>
  by_category: Record<string, { count: number; bytes: number }>
  drives: {
    drive: string
    total_bytes: number
    free_before: number
    /** **上界，不是承诺**：文件可能已经不在了，进回收站的也不立刻还空间。
     *  界面上必须写成"最多"。 */
    free_after_max: number
    freed_bytes: number
  }[]
  rejected: { item_id: string; reason: string }[]
}

/** 一条审计记录。**刻意不含任何文件路径**——一份完整的路径清单比它要保护的
 *  东西还敏感。要追具体记录用 session_id 去查撤销日志。 */
export interface PcCleanAuditEntry {
  ts: number
  session_id: string
  done: number
  failed: number
  skipped: number
  freed_bytes: number
  /**
   * 系统盘可用空间，清理前后各量一次（0 = 没量到，界面整块隐藏）。
   * 这是唯一用户能自己核对的数字：`freed_bytes` 是 size_bytes 加总，偏乐观（硬链接、稀疏文件、被占用文件）。
   * 差额可能为负（清理期间别的程序在写盘），照实显示，不要编造非负数。
   */
  free_before: number
  free_after: number
  by_category: Record<string, number>
  by_reversibility: Record<string, number>
  restore_point: boolean
  aborted: string
}

/** 用户自定义清理规则。校验在后端做，前端只负责把错误码翻成人话。 */
export interface PcCleanUserRule {
  rule_id: string
  label: string
  root: string
  patterns: string[]
  min_age_days: number
  recursive: boolean
  enabled: boolean
}

export interface PcCleanScheduleConfig {
  enabled: boolean
  interval: 'daily' | 'weekly' | 'monthly'
  /** `scan` = 只扫不删（默认）。`clean` 也只会碰后端白名单里那几类。 */
  mode: 'scan' | 'clean'
  categories: string[]
  last_run: number
  last_result: Record<string, unknown>
}

export interface PcCleanOutcome {
  item_id: string
  status: 'done' | 'skipped' | 'failed'
  freed_bytes: number
  error: string
  undo_token: string
}

export interface PcCleanExecuteResult {
  ok: boolean
  session_id: string
  outcomes: PcCleanOutcome[]
  freed_bytes: number
  done: number
  failed: number
  skipped: number
  restore_point: Record<string, unknown>
  registry_backup: Record<string, unknown>
  /** 见 PcCleanAuditEntry 上同名字段的说明。0 = 没量到。 */
  free_before: number
  free_after: number
  /** 非空 = 整批中止，字符串是原因的 i18n 键。 */
  aborted: string
  undoable: boolean
  missing?: string[]
  elevated?: { ok: boolean; error?: string; freed_bytes?: number }
  /**
   * 本批因缺管理员权限而没动的项数。后端默认不提权（`allow_elevation: false`），不在用户没预期时弹 UAC，
   * 故第一遍执行后此值非零，界面据此显示「还有 N 项需要管理员权限 · 授权并继续」，用户点了才带
   * `allow_elevation: true` 重来，整批只弹一次 UAC。否则注册表、系统目录等最值得清的项永远清不掉。
   */
  needs_elevation?: { count: number; item_ids: string[]; bytes: number }
}

export interface PcCleanUndoResult {
  ok: boolean
  error?: string
  session_id?: string
  restored?: number
  failed?: { item_id: string; error: string }[]
  /** 恢复不了的条数。**必须显示**——把不可逆的部分说成「已全部还原」是骗人。 */
  irreversible?: number
  registry_backup_path?: string
}

export interface PcCleanSession {
  session_id: string
  created_at: number
  entry_count: number
  reversible_count: number
  meta: Record<string, unknown>
}

export interface PcCleanPopupRule {
  rule_id: string
  label: string
  title_pattern: string
  class_pattern: string
  process_pattern: string
  enabled: boolean
  builtin?: boolean
  source?: string
}

export interface PcCleanPopupHit {
  timestamp: number
  rule_id: string
  rule_label: string
  title: string
  class_name: string
  process: string
  pid: number
  blocked: boolean
}

export interface PcCleanWindow {
  hwnd: number
  title: string
  class_name: string
  pid: number
  process: string
}

export interface PcCleanPopupStatus {
  ok: boolean
  error?: string
  running: boolean
  enabled_in_config: boolean
  blocked_count: number
  started_at: number | null
  rules: PcCleanPopupRule[]
  builtin_rules: PcCleanPopupRule[]
  whitelist: string[]
  recent: PcCleanPopupHit[]
  poll_interval_s: number
}

export interface PcCleanTool {
  tool_id: string
  group: 'network' | 'system' | 'files' | 'privacy'
  needs_elevation: boolean
  dangerous: boolean
  params_schema: string[]
}

export interface PcCleanToolResult {
  ok: boolean
  tool_id?: string
  error?: string
  [key: string]: unknown
}
