/**
 * 清理套件的共用工具 + RPC 包装：只放每个面板都用的（字节格式化、选择集合增删）
 * 和必须只有一处实现的（一键体检的流式订阅，订阅/退订写错会漏分类消息，表现为该类永远"扫描中"）。
 */

import { vaultApi } from '@/lib/vaultApi'
import type {
  PcCleanCategory,
  PcCleanCategoryProgress,
  PcCleanScanPlan,
  PcCleanHealthResult,
  PcCleanItem,
  PcCleanReversibility,
  PcCleanScanResult,
} from '@/shared/pccleanTypes'

/**
 * 字节格式化。零字节返回 '—' 而非 '0 B'：自启项、右键菜单本无"大小"，显示 `0 B` 会误导。
 * 小数位随量级变（`1.2 GB`、`847 KB`）。
 */
export function formatBytes(bytes: number): string {
  const { value, unit } = formatBytesParts(bytes)
  return unit ? `${value} ${unit}` : value
}

/** 同上，但数值与单位分开返回：单位放进定宽 `<span>`，列内数值与单位各自对齐；大数字下也避免单位抢走数值的注意力。 */
export function formatBytesParts(bytes: number): { value: string; unit: string } {
  if (!Number.isFinite(bytes) || bytes <= 0) return { value: '—', unit: '' }
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const digits = value >= 100 || unit === 0 ? 0 : value >= 10 ? 1 : 2
  return { value: value.toFixed(digits), unit: units[unit] }
}

/** 整数千分位（条目数、检查位置数）：没有分隔符时要逐位数才知量级，而这些数字就是让人一眼判断量级。 */
export function formatCount(n: number): string {
  if (!Number.isFinite(n)) return '—'
  return Math.round(n).toLocaleString('en-US')
}

/**
 * 类目名，绝不把 `category.xxx` 原始键显示给用户：i18next 找不到键会回落成键本身且不报错
 * （`custom` 类目曾六种语言都没文案，只因没人调用才没暴露）。
 * 兜底成类目 id 而非空串：空白无从判断是哪类，id 至少可读可搜。
 */
export function categoryLabel(
  t: (key: string, options?: Record<string, unknown>) => string,
  category: string,
): string {
  return t(`category.${category}`, { defaultValue: category })
}

/** 类目的一句话说明，缺了返回空串，由调用方不渲染；与 `categoryLabel` 兜底方向相反：显示 `categoryHint.volumes` 比不显示更糟。 */
export function categoryHint(
  t: (key: string, options?: Record<string, unknown>) => string,
  category: string,
): string {
  return t(`categoryHint.${category}`, { defaultValue: '' })
}

/**
 * 一个类目扫完后的状态，之前下列四种在界面上都是一格空列表（后两种是 bug，却被包装成"你的电脑很干净"）：
 * `found` 扫到了；`clean` 扫过且确实干净；`blocked` 全程被权限挡住；`skipped` 压根没跑
 * （路径未解析、预算首步用光、scanner 早退）。
 */
export type CategoryOutcome = 'found' | 'clean' | 'blocked' | 'skipped' | 'pending' | 'failed'

export function categoryOutcome(
  report: PcCleanScanResult | undefined,
  opts: { pending?: boolean; failed?: boolean } = {},
): CategoryOutcome {
  if (opts.failed) return 'failed'
  if (opts.pending || !report) return 'pending'
  if ((report.items?.length ?? 0) > 0) return 'found'
  const probed = (report.scanned_dirs ?? 0) + (report.scanned_files ?? 0)
  const denied = report.denied ?? 0
  if (probed > 0) return 'clean'
  if (denied > 0) return 'blocked'
  return 'skipped'
}

export function toggleIn(set: ReadonlySet<string>, id: string, next: boolean): Set<string> {
  const out = new Set(set)
  if (next) out.add(id)
  else out.delete(id)
  return out
}

/** 把一批条目里**没锁死的**全选/全不选。锁死项永远不进选择集合。 */
export function selectAll(
  set: ReadonlySet<string>,
  items: readonly PcCleanItem[],
  next: boolean,
): Set<string> {
  const out = new Set(set)
  for (const item of items) {
    if (item.locked) continue
    if (next) out.add(item.item_id)
    else out.delete(item.item_id)
  }
  return out
}

/** 后端标了 `default_selected` 的那些。「选中推荐项」按钮用它。 */
export function defaultSelection(items: readonly PcCleanItem[]): Set<string> {
  return new Set(items.filter((i) => i.default_selected && !i.locked).map((i) => i.item_id))
}

/**
 * 首屏「推荐清理」卡选中的条目，比 `defaultSelection` 更保守（给不想看列表的人的一键按钮），须同时满足：
 * 1. 后端已标 `default_selected`；
 * 2. 类别在白名单内，只收重新生成成本近乎为零的（临时文件、浏览器缓存、回收站、日志、崩溃转储）；
 *    注册表、插件、启动项、C 盘瘦身不进，清错会让软件打不开；
 * 3. 重要度只收 `junk` / `optional`，`common` 及以上不进（"常用"的判定可能错）。
 * 少推荐的代价是少省几百 MB，多推荐的代价是软件坏掉，不对称，所以只往保守方向错。
 */
const RECOMMENDED_CATEGORIES: ReadonlySet<string> = new Set([
  'junk',
  'browserCache',
])
/**
 * `privacy` 已从白名单拿掉：jumpLists 规则 `default_selected=True`，指向的 AutomaticDestinations
 * 目录里还有快速访问固定文件夹，且 `reversibility('privacy') === 'permanent'`（硬删），
 * 三条判据全中导致一键清理删掉固定项且拿不回来。使用痕迹的重新生成成本是无穷大，不属于该白名单。
 * 后端 `safety.py` 也会降级这类项的默认勾选，两道防线独立生效。
 */

/**
 * 这些分类的字节数不是磁盘空间。后端真相源是 service.py 的 `NON_SPACE_CATEGORIES`
 * （汇总带 `space_backed` 字段），这里留一份因为总览卡片拿到的是单类报告。
 * 目前只有 memory（各进程工作集）：压缩工作集只是换到页面文件、不释放任何东西，
 * 却会被渲染成与垃圾文件同样的「N 项 · X」而读成"还能清出 X"。
 */
const NON_SPACE_CATEGORIES: ReadonlySet<string> = new Set(['memory'])

export function isSpaceBackedCategory(category: string): boolean {
  return !NON_SPACE_CATEGORIES.has(category)
}

export function recommendedSelection(items: readonly PcCleanItem[]): Set<string> {
  return new Set(
    items
      .filter(
        (i) =>
          i.default_selected &&
          !i.locked &&
          RECOMMENDED_CATEGORIES.has(i.category) &&
          (i.importance === 'junk' || i.importance === 'optional'),
      )
      .map((i) => i.item_id),
  )
}

/* 清理力度 */

/**
 * 清理力度，与 `SCAN_MODES` 刻意不合并：
 * `SCAN_MODES`（极速/标准/深度）决定扫哪几类、给多少时间，是"愿意等多久"；
 * `CLEAN_LEVELS`（保守/标准/深度）决定默认勾选哪些，是"愿意承担多大风险"。
 * 合并会把"扫得全"悄悄翻译成"删得狠"。三档判据基于后端 `safety.py` 回填的 `rebuild_cost`，
 * 不用类别白名单（忘了更新时新分类默认不受限制）。
 */
export type CleanLevel = 'conservative' | 'standard' | 'deep'

export const CLEAN_LEVEL_ORDER: readonly CleanLevel[] = [
  'conservative',
  'standard',
  'deep',
]

/** 某力度下默认勾选的条目：以"后端建议清（`default_selected`）且没锁死"为基础，只收紧不放宽，前端无权勾上后端不建议的。 */
export function selectionForLevel(
  items: readonly PcCleanItem[],
  level: CleanLevel,
): Set<string> {
  if (level === 'conservative') {
    // 保守 = 首屏那个「一键」的判据：只碰重新生成成本为零的东西。
    // 清错了最坏结果是下次打开某个网站慢半秒。
    return recommendedSelection(items)
  }
  return new Set(
    items
      .filter((i) => {
        if (!i.default_selected || i.locked) return false
        if (level === 'deep') return true
        // 标准：放过"重建要付大代价"的那些。它们仍然列在界面上、
        // 仍然勾得动，只是不替用户预先勾上。
        return i.detail?.rebuild_cost !== 'high'
      })
      .map((i) => i.item_id),
  )
}

/** 这一批里有几项删了拿不回来，用于执行确认页的红色数字；它是用户按下按钮前的最后一个事实，必须只有一处实现。 */
export function irreversibleCount(items: readonly PcCleanItem[]): number {
  return items.filter((i) => i.detail?.reversibility === 'permanent').length
}

/** 这一批里有几项正被别的进程占着。 */
export function blockedCount(items: readonly PcCleanItem[]): number {
  return items.filter((i) => Boolean(i.detail?.blocking_process)).length
}

/* 可选指标 */

/** 后端按类别给的三档风险结论，用于显示；与 `riskScore()`（前端算的连续分数，用于排序）并存：分数排得出先后说不出多危险，档位反之。 */
export type PcCleanRisk = 'low' | 'medium' | 'high'

export const PCCLEAN_RISK_LEVELS: readonly PcCleanRisk[] = ['low', 'medium', 'high']

/**
 * 后端回填进 `item.detail` 的可选指标。字段全部可选：各 scanner 分别回填，漏填或新旧版本错配都会缺字段，
 * 不能因此白屏。读取函数一律读不到就返回 undefined、由调用方渲染「—」，
 * 绝不编 0 顶替（`0 B`、`0 秒`、`1970 年` 已是修过两次的坑）。
 */
export interface PcCleanMetricDetail {
  /** 可回收字节数。缺了就回落到 `item.size_bytes`。 */
  size?: number
  risk?: PcCleanRisk
  reversibility?: PcCleanReversibility
  /** 预计清理耗时（秒）。 */
  estimatedSeconds?: number
  /** 该类别上次清理完成时间，ISO8601。`null` = 从来没清过（跟"没这个字段"
   *  是两件事：前者是已知事实，后者是未知）。 */
  lastCleanedAt?: string | null
}

/** 读可能有两种拼法的字段：契约是 camelCase，但 `detail` 里既有字段是 Python 原样吐出的 snake_case，读错会使该列永远为空且不报错，所以两个都认。 */
function readDetail(item: PcCleanItem, camel: string, snake: string): unknown {
  const detail = item.detail as Record<string, unknown> | undefined
  if (!detail) return undefined
  const primary = detail[camel]
  return primary === undefined ? detail[snake] : primary
}

/** 可回收字节数。后端没给 `detail.size` 就用 `size_bytes`。 */
export function metricSize(item: PcCleanItem): number {
  const raw = readDetail(item, 'size', 'size_bytes')
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) return raw
  return Number.isFinite(item.size_bytes) ? item.size_bytes : 0
}

export function metricRisk(item: PcCleanItem): PcCleanRisk | undefined {
  const raw = readDetail(item, 'risk', 'risk_level')
  return typeof raw === 'string' && (PCCLEAN_RISK_LEVELS as readonly string[]).includes(raw)
    ? (raw as PcCleanRisk)
    : undefined
}

export function metricReversibility(item: PcCleanItem): PcCleanReversibility | undefined {
  const raw = item.detail?.reversibility
  return raw === 'recycle' || raw === 'restorable' || raw === 'permanent' ? raw : undefined
}

/** 预计耗时（秒）。负数、NaN、字符串一律当成"没给"。 */
export function metricEstimatedSeconds(item: PcCleanItem): number | undefined {
  const raw = readDetail(item, 'estimatedSeconds', 'estimated_seconds')
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return undefined
  return raw
}

/**
 * 上次清理时间（毫秒时间戳），三种返回值必须分开处理：
 * 数字=清过；`null`=后端明说从没清过；`undefined`=后端没给（旧版本/该类不统计）。
 * 混淆后用户会把"不知道"读成"没做过"而去点清理。
 */
export function metricLastCleanedAt(item: PcCleanItem): number | null | undefined {
  const raw = readDetail(item, 'lastCleanedAt', 'last_cleaned_at')
  if (raw === null) return null
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    // 有些后端路径直接给 Unix 秒。十位数按秒解释，十三位按毫秒——
    // 猜错的表现是显示 1970 年，正好是我们最不想要的那种假数据。
    return raw > 1e11 ? raw : raw * 1000
  }
  if (typeof raw !== 'string' || raw === '') return undefined
  const parsed = Date.parse(raw)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** 预计耗时拆成「数值 + 单位」，单位是 i18n 键的后缀而不是已翻译的字符串。 */
export function estimatedTimeParts(seconds: number): { count: number; unit: 'seconds' | 'minutes' | 'hours' } {
  if (seconds < 90) return { count: Math.max(1, Math.round(seconds)), unit: 'seconds' }
  if (seconds < 5400) return { count: Math.round(seconds / 60), unit: 'minutes' }
  return { count: Math.round(seconds / 3600), unit: 'hours' }
}

/** 距今多少天（向下取整）。今天之内返回 0。 */
export function daysSince(ms: number, now: number = Date.now()): number {
  return Math.max(0, Math.floor((now - ms) / 86_400_000))
}

/* 可自定义显示列 */

/** 列表右侧可显示的指标，顺序即默认排列和设置面板勾选框顺序；只放"看了会改变决定"的，否则只会挤窄真正要看的列。 */
export const CLEAN_COLUMN_IDS = [
  'size',
  'risk',
  'reversibility',
  'lastCleaned',
  'estimatedTime',
] as const

export type CleanColumnId = (typeof CLEAN_COLUMN_IDS)[number]

export type SortDirection = 'asc' | 'desc'

export interface CleanColumnPreferences {
  /** 要显示的列，**顺序有意义**：数组顺序就是屏幕上从左到右的顺序。 */
  columns: CleanColumnId[]
  sortKey: CleanSortKey
  sortDir: SortDirection
}

/** 默认只开「可回收空间 + 风险」两列：五列全开会让每行右侧塞五个数字，默认值是多数人唯一会用的配置，应可读而非最全。 */
export const DEFAULT_CLEAN_COLUMNS: CleanColumnPreferences = {
  columns: ['size', 'risk'],
  sortKey: 'size',
  sortDir: 'desc',
}

const COLUMN_STORAGE_KEY = 'ideal1-pcclean-columns-v1'

function columnStorageKey(scope?: string): string {
  return scope ? `${COLUMN_STORAGE_KEY}:${scope}` : COLUMN_STORAGE_KEY
}

function cloneColumnDefaults(): CleanColumnPreferences {
  return { ...DEFAULT_CLEAN_COLUMNS, columns: [...DEFAULT_CLEAN_COLUMNS.columns] }
}

/**
 * 把存下来的（不可信）JSON 收敛成界面认得的值，写法同 `appearancePreferences.ts`：
 * localStorage 可被开发者工具改、也有旧格式。非法值一律静默回落默认，抛异常会在首次渲染冒到根组件白屏。
 * 1. 非对象/null/JSON 坏 → 整份默认；2. `columns` 里未知 id 丢掉、重复去重；
 * 3. 全被丢光 → 默认，不留没有任何列的列表；4. 排序键/方向不认识 → 各自回落，不牵连合法部分。
 */
export function normalizeCleanColumns(
  value: unknown,
  defaults: Partial<CleanColumnPreferences> = {},
): CleanColumnPreferences {
  const base: CleanColumnPreferences = { ...cloneColumnDefaults(), ...defaults }
  if (typeof value !== 'object' || value === null) return base
  const candidate = value as Record<string, unknown>

  const columns = Array.isArray(candidate.columns)
    ? [...new Set(candidate.columns.filter((id): id is CleanColumnId =>
      typeof id === 'string' && (CLEAN_COLUMN_IDS as readonly string[]).includes(id),
    ))]
    : []

  const sortKey = typeof candidate.sortKey === 'string'
    && (CLEAN_SORT_KEYS as readonly string[]).includes(candidate.sortKey)
    ? (candidate.sortKey as CleanSortKey)
    : base.sortKey
  const sortDir = candidate.sortDir === 'asc' || candidate.sortDir === 'desc'
    ? candidate.sortDir
    : base.sortDir

  return {
    columns: columns.length > 0 ? columns : [...base.columns],
    sortKey,
    sortDir,
  }
}

export interface CleanColumnStorageOptions {
  /** 不同面板各存一份。不给就是全局共享的那一份。 */
  scope?: string
  /** 存储里没有记录时用的初值（面板自己的 `defaultSortKey` 走这里）。 */
  defaults?: Partial<CleanColumnPreferences>
  /** 注入用。测试里传一个假的 Storage，不去碰真实的 localStorage。 */
  storage?: Pick<Storage, 'getItem' | 'setItem'>
}

export function loadCleanColumns(options: CleanColumnStorageOptions = {}): CleanColumnPreferences {
  const { scope, defaults, storage = safeStorage() } = options
  const fallback: CleanColumnPreferences = { ...cloneColumnDefaults(), ...defaults }
  try {
    const raw = storage?.getItem(columnStorageKey(scope))
    return raw ? normalizeCleanColumns(JSON.parse(raw), defaults) : fallback
  } catch {
    // 坏 JSON、被禁用的 localStorage、隐私模式的 SecurityError 都走这条。
    return fallback
  }
}

export function saveCleanColumns(
  preferences: CleanColumnPreferences,
  options: CleanColumnStorageOptions = {},
): void {
  const { scope, defaults, storage = safeStorage() } = options
  try {
    storage?.setItem(
      columnStorageKey(scope),
      JSON.stringify(normalizeCleanColumns(preferences, defaults)),
    )
  } catch {
    // 显示哪几列是纯偏好。配额满、隐私模式一律不许影响主流程。
  }
}

/** `localStorage` 在某些 Electron 上下文里访问本身就抛（不是读的时候抛）。 */
function safeStorage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage
  } catch {
    return undefined
  }
}

/** 切换一列的显隐，保持 `CLEAN_COLUMN_IDS` 的固定顺序；按点击先后排会使列位置不一致，列位置是肌肉记忆。 */
export function toggleCleanColumn(
  preferences: CleanColumnPreferences,
  column: CleanColumnId,
): CleanColumnPreferences {
  const has = preferences.columns.includes(column)
  const next = has
    ? preferences.columns.filter((id) => id !== column)
    : CLEAN_COLUMN_IDS.filter((id) => id === column || preferences.columns.includes(id))
  // 一列都不剩是允许的：那是"我只想看名字"，是个合理的诉求，
  // 跟"存储被写脏了"（那种走 normalize 的回落）不是一回事。
  return { ...preferences, columns: [...next] }
}

/* 排序与筛选 */

export type CleanSortKey =
  | 'size'
  | 'risk'
  | 'recent'
  | 'name'
  | 'reversibility'
  | 'lastCleaned'
  | 'estimatedTime'

export const CLEAN_SORT_KEYS: readonly CleanSortKey[] = [
  'size',
  'risk',
  'recent',
  'name',
  'reversibility',
  'lastCleaned',
  'estimatedTime',
]

/** 每个维度默认的排序方向（占用大的在前、名字 A 在前）；集中于此让 `sortAndFilterItems` 不传方向时行为与改动前逐字节一致，已有四个面板在用。 */
export const DEFAULT_SORT_DIRECTION: Record<CleanSortKey, SortDirection> = {
  size: 'desc',
  risk: 'desc',
  recent: 'desc',
  name: 'asc',
  reversibility: 'desc',
  lastCleaned: 'desc',
  estimatedTime: 'desc',
}

/** 可逆性的排序权重：越大 = 越该让用户先看见。 */
const REVERSIBILITY_WEIGHT: Record<PcCleanReversibility, number> = {
  recycle: 0,
  restorable: 1,
  permanent: 2,
}

/** 风险排序权重，数字越大越该先让用户看见；按"删了会注意到什么"排而非字节：4 GB 浏览器缓存删了无感，2 KB 登录态删了所有网站掉线。 */
const IMPACT_WEIGHT: Record<string, number> = {
  cache: 0,
  history: 1,
  config: 2,
  signin: 3,
  system: 4,
  userdata: 5,
}

const COST_WEIGHT: Record<string, number> = { none: 0, low: 1, high: 3 }

export function riskScore(item: PcCleanItem): number {
  const impacts = item.detail?.impact ?? []
  const worst = impacts.reduce((max, tag) => Math.max(max, IMPACT_WEIGHT[tag] ?? 0), 0)
  const cost = COST_WEIGHT[item.detail?.rebuild_cost ?? 'high'] ?? 3
  const irreversible = item.detail?.reversibility === 'permanent' ? 2 : 0
  return worst * 4 + cost + irreversible
}

export interface CleanListFilters {
  /** 只看纯缓存、重建成本为零的那些 —— "闭着眼睛勾"的集合。 */
  zeroRiskOnly?: boolean
  /** 只看撤得回来的。 */
  reversibleOnly?: boolean
  /** 藏起正被进程占着的（现在删也删不掉）。 */
  hideBlocked?: boolean
}

export function isZeroRisk(item: PcCleanItem): boolean {
  const impacts = item.detail?.impact ?? []
  return (
    item.detail?.rebuild_cost === 'none' &&
    impacts.length > 0 &&
    impacts.every((tag) => tag === 'cache')
  )
}

/** 排序 + 筛选，返回新数组，绝不就地改：传入的多半是上游 `useMemo` 的结果，就地排序会改掉缓存，症状是难复现的"列表偶尔自己变序"。 */
/** 条目在某维度的排序值；`undefined` 表示该维度没有数据（不是 0），无论升降序都排最后，避免被当成 1970 年的老文件。 */
function sortValue(item: PcCleanItem, key: CleanSortKey): number | string | undefined {
  switch (key) {
    case 'size':
      return metricSize(item)
    case 'risk':
      return riskScore(item)
    case 'recent':
      return typeof item.detail?.last_change_ts === 'number' ? item.detail.last_change_ts : undefined
    case 'name':
      return item.label
    case 'reversibility': {
      const value = metricReversibility(item)
      return value ? REVERSIBILITY_WEIGHT[value] : undefined
    }
    case 'lastCleaned': {
      const value = metricLastCleanedAt(item)
      if (value === undefined) return undefined
      // `null` 是后端明说"从没清过"，属已知事实，参与排序并落在时间轴最远端（升序最前=最该清），不与"不知道"一起排末尾。
      return value === null ? -Infinity : value
    }
    case 'estimatedTime':
      return metricEstimatedSeconds(item)
    default:
      return undefined
  }
}

export function sortAndFilterItems(
  items: readonly PcCleanItem[],
  sortKey: CleanSortKey,
  filters: CleanListFilters = {},
  sortDir: SortDirection = DEFAULT_SORT_DIRECTION[sortKey] ?? 'desc',
): PcCleanItem[] {
  let out = items as readonly PcCleanItem[]
  if (filters.zeroRiskOnly) out = out.filter(isZeroRisk)
  if (filters.reversibleOnly) out = out.filter((i) => i.detail?.reversibility !== 'permanent')
  if (filters.hideBlocked) out = out.filter((i) => !i.detail?.blocking_process)

  const sign = sortDir === 'asc' ? 1 : -1
  // 先算好排序值再排（decorate-sort-undecorate）：列表可达上万条，比较函数被调用十几万次，
  // 而 `metricLastCleanedAt` 内有 `Date.parse`，现算会解析十几万次日期字符串。
  const known: { item: PcCleanItem; value: number | string; size: number }[] = []
  const unknown: PcCleanItem[] = []
  for (const item of out) {
    const value = sortValue(item, sortKey)
    if (value === undefined) unknown.push(item)
    else known.push({ item, value, size: metricSize(item) })
  }

  known.sort((a, b) => {
    if (typeof a.value === 'string' || typeof b.value === 'string') {
      const primary = sign * String(a.value).localeCompare(String(b.value))
      if (primary !== 0) return primary
    } else if (a.value !== b.value) {
      // 用比较而不是相减：两个 -Infinity（都没清过）相减得 NaN，返回 NaN 的比较函数会使 sort 结果未定义。
      return a.value < b.value ? -sign : sign
    }
    // 同分时按占用倒序再按名字，必须有确定次序：随机次序在每次重扫都重排的列表里刺眼，也使"上次它在这儿"的记忆失效。
    return b.size - a.size || a.item.label.localeCompare(b.item.label)
  })
  // 无数据的那一批保持原有相对顺序，整体挂在最后。
  return known.map((entry) => entry.item).concat(unknown)
}

/**
 * 扫描档位：一键体检要同时服务想立刻看结果和想扫干净的人，最慢的一类（计划任务，`schtasks` 实测 5~9 秒）
 * 放哪边都有人受损，故分三档，默认标准档。档位只改扫哪几类和每类时间预算，
 * 不改"什么能清"的判断（放宽即不安全）。
 */
export interface ScanModeSpec {
  categories: readonly string[]
  /** 每类的时间预算（秒）。后端 `_budget_for` 读它。 */
  budgets: Readonly<Record<string, number>>
  /** 传给具体 scanner 的额外参数。 */
  extra?: Readonly<Record<string, Record<string, unknown>>>
}

export const SCAN_MODES: Readonly<Record<'fast' | 'standard' | 'deep', ScanModeSpec>> = {
  /**
   * 极速：只扫已知高收益且天生快的四类，每类 2 秒封顶，刻意排除 startup/popupSources（各占整轮约 90% 时间）。
   * 2 秒是实测：四类并行总时长约 2.05~2.16 秒；5 秒档与 2 秒档扫出的可清理空间同为 1.30 GB，大头在头几百毫秒找到。
   * 预算能生效是修出来的：各 scanner 曾向 `paths.iter_files` 传只含取消、不含时间预算的 `task.should_cancel`，
   * 给 0.8 秒也会跑 5.26 秒。
   */
  fast: {
    categories: ['junk', 'browserCache', 'privacy', 'memory'],
    budgets: { junk: 2, browserCache: 2, privacy: 2, memory: 2 },
  },
  /**
   * 标准（默认档）：十类全扫，用后端默认预算。`custom`（用户规则）从这一档才有意义：
   * 规则可指向任意目录并递归，放进极速档会让"三秒内出结果"的承诺落空；无规则时开销为零。
   */
  standard: {
    categories: [
      'junk', 'browserCache', 'privacy', 'registry', 'plugins',
      'startup', 'popupSources', 'diskSlimming', 'memory', 'custom',
    ],
    budgets: {},
  },
  /** 深度：十类全扫 + 磁盘瘦身走深度分支（问 DISM/WinSxS，慢但准），预算放宽到三倍。 */
  deep: {
    categories: [
      'junk', 'browserCache', 'privacy', 'registry', 'plugins',
      'startup', 'popupSources', 'diskSlimming', 'memory', 'custom',
    ],
    budgets: { startup: 120, registry: 90, diskSlimming: 180, plugins: 90, custom: 180 },
    extra: { diskSlimming: { deep: true } },
  },
}

/**
 * 可调指标：档位是粗调（扫哪几类、多少时间），这里细调"什么算垃圾"，是价值判断，只能由用户定。
 * 每条须满足：改后结果肉眼可见不同；用户答得上来（问"多久没动算旧"可以，问"哈希块大小"没意义）。
 */
export interface TuningState {
  /** 垃圾文件：多久没改过才算可清。0 = 不看年龄。 */
  junkAgeDays: number
  /** 下载目录：多少天没动过的安装包算陈旧。 */
  downloadsStaleDays: number
  /** 大文件：多大才进列表（MB）。 */
  bigFileMinMb: number
  /** 重复文件：多小的文件直接跳过（KB）。小文件重复得多且没价值。 */
  duplicateMinKb: number
  /** 内存：工作集超过多少 MB 的进程才列出来。 */
  memoryMinMb: number
  /** 目录分析的下钻层数。 */
  analysisDepth: number
  /** 单类目时间预算的整体倍率。1 = 按档位默认。 */
  budgetScale: number
  /** 清理前建还原点。 */
  restorePoint: boolean
  /** 只显示「推广垃圾」这一级。 */
  junkOnly: boolean
  /** 列表里显示锁死项（系统关键项）。关掉能让列表短一大截。 */
  showLocked: boolean
}

export const DEFAULT_TUNING: TuningState = {
  junkAgeDays: 1,
  downloadsStaleDays: 60,
  bigFileMinMb: 100,
  duplicateMinKb: 1024,
  memoryMinMb: 50,
  analysisDepth: 2,
  budgetScale: 1,
  restorePoint: true,
  junkOnly: false,
  showLocked: true,
}

/** 把可调指标翻成 `health_check` 的 per-category options。 */
export function tuningOverrides(tuning: TuningState): Record<string, Record<string, unknown>> {
  return {
    junk: { min_age_days: tuning.junkAgeDays },
    downloads: { stale_days: tuning.downloadsStaleDays },
    bigFiles: { min_size_mb: tuning.bigFileMinMb },
    duplicates: { min_size_kb: tuning.duplicateMinKb },
    memory: { min_working_set_mb: tuning.memoryMinMb },
    dirAnalysis: { depth: tuning.analysisDepth },
  }
}

export type ScanMode = keyof typeof SCAN_MODES

/** 把档位翻成后端 `health_check` 的 options；`overrides` 最后合并，用户单独调的"多久没用算垃圾"压过档位默认值。 */
export function scanOptionsFor(
  mode: ScanMode,
  overrides?: Record<string, Record<string, unknown>>,
  budgetScale = 1,
): Record<string, unknown> {
  const spec = SCAN_MODES[mode]
  const budgets: Record<string, number> = {}
  // 倍率只放大**已经写死的**预算。没写的那几类走后端默认值，
  // 在这里凭空造一个数出来会把后端那张按类精调过的表整个盖掉。
  for (const [category, seconds] of Object.entries(spec.budgets)) {
    budgets[category] = Math.max(1, Math.round(seconds * budgetScale))
  }
  const options: Record<string, unknown> = {
    categories: [...spec.categories],
    budgets,
    budget_scale: budgetScale,
  }
  for (const [category, params] of Object.entries(spec.extra ?? {})) {
    options[category] = { ...params }
  }
  for (const [category, params] of Object.entries(overrides ?? {})) {
    options[category] = { ...(options[category] as object | undefined), ...params }
  }
  return options
}

export function sumSelected(items: readonly PcCleanItem[], selected: ReadonlySet<string>): number {
  let total = 0
  for (const item of items) {
    if (selected.has(item.item_id)) total += item.size_bytes
  }
  return total
}

let scanCounter = 0
export function nextScanId(prefix: string): string {
  scanCounter += 1
  return `${prefix}-${scanCounter}-${Math.random().toString(36).slice(2, 8)}`
}

export function scan(
  category: PcCleanCategory,
  options?: Record<string, unknown>,
  scanId?: string,
): Promise<PcCleanScanResult> {
  return vaultApi.call('pcclean_scan', { category, options, scan_id: scanId }, scanId)
}

/**
 * 一键体检，带分类流式回调。订阅必须在发起调用之前装好：后端第一条分类消息可能 60 毫秒内就到
 * （隐私扫描 203ms、内存 62ms），先调用后订阅会丢掉最早几条，表现为那几类永远"扫描中"。
 * 退订放 finally：抛异常也要退，否则残留监听器让下次扫描的消息被回调多遍。
 */
export async function healthCheck(
  scanId: string,
  onCategory: (category: string, payload: PcCleanScanResult) => void,
  options?: Record<string, unknown>,
  onPlan?: (plan: PcCleanScanPlan) => void,
  onTick?: (category: string, done: number, total: number) => void,
): Promise<PcCleanHealthResult> {
  const unsubscribe = vaultApi.onProgress((payload) => {
    if (payload.progressToken !== scanId) return
    // 写成联合类型而不是交叉类型：交叉会把 kind 收窄成字面量 'category'，
    // 于是 `kind === 'plan'` 被编译器判成"永远不成立"而报错——而它当然会成立。
    const progress = payload as unknown as
      | PcCleanCategoryProgress
      | { kind: 'plan'; plan?: PcCleanScanPlan }
      | { kind: 'categoryTick'; category: string; done: number; total: number }
    // `plan` 在所有扫描开始前发一条（类目、历史耗时、剩余时间估算），必须显式放行：
    // 早先只认 'category'，其他 kind 被静默丢弃，剩余时间永远显示"计算中"且不报错。
    if (progress.kind === 'plan') {
      if (progress.plan) onPlan?.(progress.plan)
      return
    }
    // 单类内部的进度。**同样必须显式放行** —— 上面那条注释描述的坑
    // （新 kind 被静默丢掉）在加第三种消息时会原样重演一次。
    if (progress.kind === 'categoryTick') {
      onTick?.(progress.category, progress.done, progress.total)
      return
    }
    if (progress.kind !== 'category') return
    onCategory(progress.category, progress.payload)
  })
  try {
    return await vaultApi.call('pcclean_health_check', { options, scan_id: scanId }, scanId)
  } finally {
    unsubscribe()
  }
}

/** 把后端错误码翻成人话：后端返回完整 i18n 键 `pcclean.execute.lockedItem`，而 `pcclean` 命名空间里的键不带前缀，须剥掉前缀再查，否则每条错误都原样显示键且不报错。 */
export function pccleanErrorKey(raw: string | undefined): string {
  if (!raw) return ''
  const stripped = raw.startsWith('pcclean.') ? raw.slice('pcclean.'.length) : raw
  // 后端有些错误码带 `:细节` 后缀（`pcclean.scan.failed:OSError`），
  // 查键时要去掉，细节另行显示。
  const colon = stripped.indexOf(':')
  return colon > 0 ? stripped.slice(0, colon) : stripped
}

export function pccleanErrorDetail(raw: string | undefined): string {
  if (!raw) return ''
  const colon = raw.indexOf(':')
  return colon > 0 ? raw.slice(colon + 1) : ''
}
