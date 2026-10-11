import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  ArrowDownWideNarrow,
  ArrowUpNarrowWide,
  CalendarClock,
  ChevronDown,
  ChevronRight,
  Columns3,
  Lock,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  Timer,
  Trash2,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import { Checkbox } from '@/components/ui/checkbox'
import { Badge, EmptyState, type Tone } from '@/components/ui/page'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import {
  CLEAN_COLUMN_IDS,
  DEFAULT_SORT_DIRECTION,
  daysSince,
  estimatedTimeParts,
  formatBytes,
  formatBytesParts,
  loadCleanColumns,
  metricEstimatedSeconds,
  metricLastCleanedAt,
  metricRisk,
  metricReversibility,
  metricSize,
  saveCleanColumns,
  sortAndFilterItems,
  toggleCleanColumn,
  type CleanColumnId,
  type CleanColumnPreferences,
  type CleanListFilters,
  type CleanSortKey,
  type PcCleanRisk,
} from '@/lib/pcclean'
import type {
  PcCleanImpact,
  PcCleanImportance,
  PcCleanItem,
  PcCleanReversibility,
} from '@/shared/pccleanTypes'

/**
 * 清理条目列表，五个面板共用，免得徽章、锁死项等显示在各面板分家。
 * 永远虚拟化：已装软件 300~600 条、注册表扫描上限 2000 条，一次性渲染会卡主线程。
 */

const IMPORTANCE_TONE: Record<PcCleanImportance, Tone> = {
  critical: 'danger',
  driver: 'warning',
  common: 'info',
  optional: 'neutral',
  junk: 'success',
}
// junk 用 success（绿）是刻意的：在这个界面里绿色的含义不是"好"，
// 是"放心清"。用红色标垃圾会让用户以为清它有风险，正好搞反。

/**
 * 可逆性徽章：只给 `permanent` 显眼样式，其余两档保持中性，否则满屏彩标会让用户不再看最要紧的那一
 * 档。
 */
const REVERSIBILITY_TONE: Record<PcCleanReversibility, Tone> = {
  permanent: 'danger',
  restorable: 'neutral',
  recycle: 'neutral',
}

const REVERSIBILITY_ICON: Record<PcCleanReversibility, LucideIcon> = {
  permanent: Trash2,
  restorable: RotateCcw,
  recycle: RotateCcw,
}

/**
 * 风险等级的视觉编码：颜色、图标、文字三个通道同时表达，缺任何一个都会让一部分人读不到（红绿色盲、
 * 14px 盾牌难分辨、纯文字无跳出感）。色值只走语义 token（success / warning / destructive，经
 * `Badge` tone 映射），不许写 `text-amber-500` 这类调色板类：不随强调色/风格变化，深色下对比度仅
 * 2.8:1。/
 */
const RISK_TONE: Record<PcCleanRisk, Tone> = {
  low: 'success',
  medium: 'warning',
  high: 'danger',
}

const RISK_ICON: Record<PcCleanRisk, LucideIcon> = {
  low: ShieldCheck,
  medium: ShieldAlert,
  high: ShieldX,
}

/** 影响面标签的配色。`cache` 用 success（"删了没人知道"），
 *  `signin` / `userdata` 用 warning（"删了你会立刻发现"）。 */
const IMPACT_TONE: Record<PcCleanImpact, Tone> = {
  cache: 'success',
  history: 'neutral',
  config: 'info',
  signin: 'warning',
  userdata: 'warning',
  system: 'warning',
}

/** 模块级常量。**不能在渲染里写 `?? []`**——那是每次一个新数组引用，
 *  会让所有下游 useMemo 永不命中，几千条列表每帧重算一遍。 */
const EMPTY_GROUPS: { key: string; label: string; items: PcCleanItem[] }[] = []

/**
 * 排序维度。`risk` 排在 `size` 后（默认按占用排，用户多为腾地方），但风险维度须同样一眼可见。这四
 * 个始终可选；可逆性/上次清理/预计耗时只在对应列打开时才出现——按屏幕上没显示的维度排序会像"顺序乱
 * 了"。
 */
const SORT_KEYS: readonly CleanSortKey[] = ['size', 'risk', 'recent', 'name']

/** 可选列 → 它对应的排序键。两者同名不是巧合：列和排序维度是同一套东西。 */
const COLUMN_SORT_KEY: Record<CleanColumnId, CleanSortKey> = {
  size: 'size',
  risk: 'risk',
  reversibility: 'reversibility',
  lastCleaned: 'lastCleaned',
  estimatedTime: 'estimatedTime',
}

const COLUMN_ICON: Record<CleanColumnId, LucideIcon> = {
  size: Columns3,
  risk: ShieldAlert,
  reversibility: RotateCcw,
  lastCleaned: CalendarClock,
  estimatedTime: Timer,
}

/**
 * 一行右侧的指标格。每列定宽（`w-*`）并右对齐，才能在同一竖线上比较大小。
 * 缺数据一律渲染 `—`：空白像没画出来，也不能伪装成 0；后端字段未到位时整列为破折号是预期表现。
 */
function MetricCells({ item, columns }: { item: PcCleanItem; columns: readonly CleanColumnId[] }) {
  const { t } = useTranslation('pcclean')
  if (columns.length === 0) return null
  return (
    <>
      {columns.map((column) => {
        if (column === 'size') {
          const bytes = metricSize(item)
          if (bytes <= 0) return <MetricSlot key={column} className="w-[8ch]">—</MetricSlot>
          const parts = formatBytesParts(bytes)
          return (
            // 数值和单位分两列各自定宽：整串右对齐时 `847 KB` 与 `1.2 GB` 的小数点会错开，不利于快速比大小。
            <span
              key={column}
              className="flex w-[8ch] shrink-0 items-baseline justify-end gap-1 text-sm text-muted-foreground"
            >
              <span className="w-[5ch] text-right tabular">{parts.value}</span>
              <span className="w-[2.5ch] text-left text-2xs">{parts.unit}</span>
            </span>
          )
        }

        if (column === 'risk') {
          const risk = metricRisk(item)
          if (!risk) return <MetricSlot key={column} className="w-[9ch]">—</MetricSlot>
          const Icon = RISK_ICON[risk]
          return (
            <span key={column} className="flex w-[9ch] shrink-0 justify-end">
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>
                    {/* 图标 + 文字 + 颜色三通道。文字不是可选的装饰——
                        它是色觉障碍用户唯一读得到的那一路。 */}
                    <Badge tone={RISK_TONE[risk]} icon={Icon}>
                      {t(`riskLevel.${risk}`)}
                    </Badge>
                  </span>
                </TooltipTrigger>
                <TooltipContent className="max-w-[46ch]">
                  {t(`riskLevelHint.${risk}`)}
                </TooltipContent>
              </Tooltip>
            </span>
          )
        }

        if (column === 'reversibility') {
          const value = metricReversibility(item)
          if (!value) return <MetricSlot key={column} className="w-[10ch]">—</MetricSlot>
          return (
            <span key={column} className="flex w-[10ch] shrink-0 justify-end">
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>
                    <Badge tone={REVERSIBILITY_TONE[value]} icon={REVERSIBILITY_ICON[value]}>
                      {t(`reversibility.${value}Short`)}
                    </Badge>
                  </span>
                </TooltipTrigger>
                <TooltipContent className="max-w-[46ch]">
                  {t(`reversibility.${value}Hint`)}
                </TooltipContent>
              </Tooltip>
            </span>
          )
        }

        if (column === 'lastCleaned') {
          const value = metricLastCleanedAt(item)
          // undefined = 后端没给这个字段；null = 后端明说"从来没清过"。
          // 两者在屏幕上必须长得不一样，否则"不知道"会被读成"没做过"。
          if (value === undefined) return <MetricSlot key={column} className="w-[11ch]">—</MetricSlot>
          if (value === null) {
            return (
              <MetricSlot key={column} className="w-[11ch] text-warning">
                {t('lastCleaned.never')}
              </MetricSlot>
            )
          }
          const days = daysSince(value)
          return (
            <MetricSlot key={column} className="w-[11ch]" title={new Date(value).toLocaleString()}>
              {days === 0 ? t('lastCleaned.today') : t('lastCleaned.daysAgo', { value: days })}
            </MetricSlot>
          )
        }

        const seconds = metricEstimatedSeconds(item)
        if (seconds === undefined) return <MetricSlot key={column} className="w-[9ch]">—</MetricSlot>
        const parts = estimatedTimeParts(seconds)
        return (
          <MetricSlot key={column} className="w-[9ch]">
            {t(`estimatedTime.${parts.unit}`, { value: parts.count })}
          </MetricSlot>
        )
      })}
    </>
  )
}

/** 定宽、右对齐、单行的指标格。所有纯文本指标都走它，宽度由调用方给。 */
function MetricSlot({
  className,
  title,
  children,
}: {
  className?: string
  title?: string
  children: React.ReactNode
}) {
  return (
    <span
      title={title}
      className={cn('shrink-0 truncate text-right text-2xs text-muted-foreground', className)}
    >
      {children}
    </span>
  )
}

const FILTER_KEYS: readonly (keyof CleanListFilters)[] = [
  'zeroRiskOnly',
  'reversibleOnly',
  'hideBlocked',
]

export interface CleanItemListProps {
  /** `readonly` 是有意的：调用方常常传的是 `useMemo` 里过滤出来的派生数组，
   *  声明成可变的会诱使人在这里就地排序，而那会当场改掉上游的 memo 结果。 */
  items: readonly PcCleanItem[]
  selected: ReadonlySet<string>
  onToggle: (itemId: string, next: boolean) => void
  /** 不传就没有全选框（大文件、重复文件那种「必须逐条看」的列表用）。 */
  onToggleAll?: (next: boolean) => void
  emptyIcon?: LucideIcon
  emptyTitle?: string
  /** 每行右侧的额外内容（软件面板的「卸载」按钮、启动项的「开/关」）。 */
  renderTrailing?: (item: PcCleanItem) => React.ReactNode
  /** 覆盖行标题。软件面板要显示版本号，垃圾清理要把 key 翻译成人话。 */
  renderLabel?: (item: PcCleanItem) => React.ReactNode
  /** 覆盖第二行说明。默认翻译 `item.reason`。 */
  renderMeta?: (item: PcCleanItem) => React.ReactNode
  showSize?: boolean
  height?: number
  className?: string
  /**
   * 分组：给了就把列表切成可折叠的组，并在顶部给跳转锚点（重复文件扫全盘可达上万条）。
   * 返回 `null` 的条目落入"其他"组，不能静默丢条目。
   */
  groupBy?: (item: PcCleanItem) => { key: string; label: string } | null
  /** 默认折叠所有分组。条目特别多（重复文件）时开着更好用。 */
  defaultCollapsed?: boolean
  /** 显示排序/筛选工具条，默认关，只在条目多的面板打开；十几条的列表里它的选择成本大于收益。 */
  showControls?: boolean
  defaultSortKey?: CleanSortKey
  /**
   * 显示列偏好在 localStorage 的槽位。不给则全局共享；给了（如 `'software'`）则面板专属，因为各面板
   * 想看的指标不同。
   */
  columnScope?: string
}

/** 拍平后的一行：要么是组头，要么是条目。 */
type Row =
  | { kind: 'header'; key: string; label: string; count: number; bytes: number }
  | { kind: 'item'; key: string; item: PcCleanItem }

interface CleanRowProps {
  item: PcCleanItem
  isSelected: boolean
  zebra: boolean
  offset: number
  index: number
  onToggle: (itemId: string, next: boolean) => void
  measureRef: (node: Element | null) => void
  renderTrailing?: (item: PcCleanItem) => React.ReactNode
  renderLabel?: (item: PcCleanItem) => React.ReactNode
  renderMeta?: (item: PcCleanItem) => React.ReactNode
  /** 右侧要显示哪几个指标列。**引用必须稳定**（上游 useMemo 里算好），
   *  否则 `memo` 每次浅比较都失败，这一层就白加了。 */
  columns: readonly CleanColumnId[]
}

/**
 * 单独抽出并 `memo`：勾选任一条都会换掉 `selected` Set 的引用，内联写法会让每个可见行重建 JSX，
 * 而行内有五六个徽章和三个 Tooltip，勾选又是最高频操作。
 * `isSelected` 传布尔值而非整个 Set，是 memo 生效的前提（Set 会让浅比较每次失败）。
 */
const CleanRow = memo(function CleanRow({
  item,
  isSelected,
  zebra,
  offset,
  index,
  onToggle,
  measureRef,
  renderTrailing,
  renderLabel,
  renderMeta,
  columns,
}: CleanRowProps) {
  const { t } = useTranslation('pcclean')
  const detail = item.detail ?? {}
  // 可逆性要么在标签旁的徽章里，要么（用户开成"列"后）只在右侧指标带里出现，不重复画。
  const reversibility = columns.includes('reversibility') ? undefined : detail.reversibility
  const impacts = detail.impact ?? []
  const blocker = detail.blocking_process || ''

  return (
    <div
      ref={measureRef}
      data-index={index}
      className={cn(
        'absolute inset-x-0 top-0 flex items-start gap-3 border-b border-border/50 px-4 py-3',
        // 斑马纹极淡（surface 比 card 只亮一档），只为几百行里不串行；用分层表面使其随主题走，深色模式自动
        // 反向。
        zebra && 'bg-surface/60',
        isSelected && 'bg-accent-soft/40',
        item.locked && 'opacity-70',
      )}
      style={{ transform: `translateY(${offset}px)` }}
    >
      {item.locked ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
              <Lock className="size-3.5 text-muted-foreground" aria-hidden="true" />
              <span className="sr-only">{t('common.locked')}</span>
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-[42ch]">
            {detail.protected ? t(detail.protected) : t('importance.lockedHint')}
          </TooltipContent>
        </Tooltip>
      ) : (
        <Checkbox
          className="mt-0.5 shrink-0"
          checked={isSelected}
          onCheckedChange={(next) => onToggle(item.item_id, next === true)}
          aria-label={item.label}
        />
      )}

      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="truncate text-sm font-medium">
            {renderLabel ? renderLabel(item) : item.label}
          </span>
          {/*
            重要度徽章可悬停查看**判定依据**。

            光有一个「可清理」的色块，用户只能选择信或不信 ——
            而"这个软件重不重要"恰恰是他最不敢替自己拍板的事。
            悬停给出这一级的含义加上后端给的具体理由，
            判断权才真的回到了他手里。
          */}
          <Tooltip>
            <TooltipTrigger asChild>
              <span>
                <Badge tone={IMPORTANCE_TONE[item.importance]}>
                  {t(`importance.${item.importance}Short`)}
                </Badge>
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-[46ch]">
              <span className="font-medium">{t(`importance.${item.importance}`)}</span>
              {' — '}
              {t(`importanceHint.${item.importance}`)}
            </TooltipContent>
          </Tooltip>

          {/*
            「删了还能不能拿回来」。

            这是用户在按下按钮之前唯一真正想知道的事，而它以前只出现在
            预演屏的汇总数字里——也就是他**已经决定要清**之后。放到每一行上，
            判断才发生在做决定的那一刻。
          */}
          {reversibility && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <Badge
                    tone={REVERSIBILITY_TONE[reversibility]}
                    icon={REVERSIBILITY_ICON[reversibility]}
                  >
                    {t(`reversibility.${reversibility}Short`)}
                  </Badge>
                </span>
              </TooltipTrigger>
              <TooltipContent className="max-w-[46ch]">
                {t(`reversibility.${reversibility}Hint`)}
              </TooltipContent>
            </Tooltip>
          )}

          {/* 影响面：删了之后会**注意到**什么。跟占多少地方是两件事。 */}
          {impacts.map((tag) => (
            <Tooltip key={tag}>
              <TooltipTrigger asChild>
                <span>
                  <Badge tone={IMPACT_TONE[tag] ?? 'neutral'}>{t(`impact.${tag}`)}</Badge>
                </span>
              </TooltipTrigger>
              <TooltipContent className="max-w-[46ch]">
                {t(`impactHint.${tag}`)}
              </TooltipContent>
            </Tooltip>
          ))}

          {item.default_selected && !item.locked && (
            <Badge tone="accent" icon={ShieldCheck}>
              {t('common.recommended')}
            </Badge>
          )}
        </div>

        <p className="text-2xs leading-5 text-muted-foreground">
          {renderMeta ? renderMeta(item) : t(item.reason)}
        </p>

        {/*
          「后端把这一项的默认勾选降级了」。

          静悄悄地不勾上等于什么都没说。说出来，用户才知道这里有个判断
          发生过，以及为什么——而这一条正是"快速访问被清空"事故的补丁，
          沉默地修好它，下一个人会把它当成疏漏再改回去。
        */}
        {detail.demoted && (
          <p className="text-2xs leading-5 text-warning">{t(detail.demoted)}</p>
        )}

        {/*
          浏览器开着的时候，Chromium 系会独占相当一部分文件，删除直接失败。
          原来遇到这种情况只是少删几个文件，界面上一个字都不说——用户点了
          清理，看到释放的空间远小于列出的数字，而没有任何线索指向"因为
          浏览器开着"。不报错、退出码正常、结果不对，是最难查的那一类。

          **说出具体进程名**而不是一句"有程序占用"：后者帮不上任何忙，
          用户不知道该关哪个。
        */}
        {blocker && (
          <p className="flex items-center gap-1 text-2xs leading-5 text-warning">
            <ShieldAlert className="size-3 shrink-0" aria-hidden="true" />
            {t('browser.closeFirst', { process: blocker })}
          </p>
        )}

        {detail.analysed === false && (
          <p className="text-2xs leading-5 text-muted-foreground/80">
            {t('health.needsSeparateAnalysis', {
              minutes: Math.max(
                1,
                Math.round(Number(detail.analysis_seconds_estimate ?? 60) / 60),
              ),
            })}
          </p>
        )}

        {/*
          「这里还堆着多少、但这次不会清」。

          后端按"至少 N 天没改过"过滤，而日志和缓存是持续追加写的，
          实测这台机器 `C:\Windows\Temp` 里 1.3 GB 全部被过滤掉。以前这些量
          连同"这里有东西"这个事实一起被丢掉，用户看到的就是一个报着几十兆
          的清理工具。现在把差额摆出来，并且说清是被哪条规则挡住的。
        */}
        {typeof detail.filtered_bytes === 'number' && detail.filtered_bytes > 0 && (
          <p className="text-2xs leading-5 text-muted-foreground/80">
            {t('junk.filteredHint', {
              bytes: formatBytes(detail.filtered_bytes as number),
              count: detail.filtered_file_count as number,
              days: detail.min_age_days as number,
            })}
          </p>
        )}

        {/* 「这里面有几项是你自己钉上去的，不会被清」。沉默地保护等于
            用户永远不知道自己差点丢了什么。 */}
        {typeof detail.protected_count === 'number' && detail.protected_count > 0 && (
          <p className="text-2xs leading-5 text-success">
            {t('privacy.protectedHint', { count: detail.protected_count as number })}
          </p>
        )}

        {item.path && (
          <p className="truncate text-2xs text-muted-foreground/80" title={item.path}>
            {item.path}
          </p>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-3">
        <MetricCells item={item} columns={columns} />
        {renderTrailing?.(item)}
      </div>
    </div>
  )
})

export function CleanItemList({
  items,
  selected,
  onToggle,
  onToggleAll,
  emptyIcon,
  emptyTitle,
  renderTrailing,
  renderLabel,
  renderMeta,
  showSize = true,
  height = 420,
  className,
  groupBy,
  defaultCollapsed = false,
  showControls = false,
  defaultSortKey = 'size',
  columnScope,
}: CleanItemListProps) {
  const { t } = useTranslation('pcclean')
  const parentRef = useRef<HTMLDivElement>(null)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const [filters, setFilters] = useState<CleanListFilters>({})

  /**
   * 显示哪几列、按哪列排、升降序。惰性初始化（`useState(() => ...)`）避免每次渲染同步读 localStorage
   * ；读失败回落默认值（见 `loadCleanColumns`），偏好不能让界面白屏。/
   */
  const [prefs, setPrefs] = useState<CleanColumnPreferences>(() =>
    loadCleanColumns({ scope: columnScope, defaults: { sortKey: defaultSortKey } }),
  )

  /** 改一次就存一次。**存进去的是净化过的值**（saveCleanColumns 内部会
   *  再跑一遍 normalize），所以下一次读出来一定是合法的。 */
  const updatePrefs = useCallback(
    (next: CleanColumnPreferences) => {
      setPrefs(next)
      saveCleanColumns(next, { scope: columnScope, defaults: { sortKey: defaultSortKey } })
    },
    [columnScope, defaultSortKey],
  )

  /**
   * `columnScope` 变化时重新读取：清理套件五个视角是同一棵组件树换 props，不会重新挂载，惰性初值会粘
   * 在首个 scope。
   */
  useEffect(() => {
    setPrefs(loadCleanColumns({ scope: columnScope, defaults: { sortKey: defaultSortKey } }))
    // defaultSortKey 只在"存储里什么都没有"时起作用，不该因为它变了就重读。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columnScope])

  /**
   * 实际渲染的列。`showControls` 关闭的面板（如右键菜单）保持只有「占用」一格：
   * 这些面板没有调整列的入口，不应被别处存的偏好改动排版。
   */
  const columns = useMemo<readonly CleanColumnId[]>(() => {
    if (!showControls) return showSize ? (['size'] as const) : ([] as const)
    return showSize ? prefs.columns : prefs.columns.filter((id) => id !== 'size')
  }, [showControls, showSize, prefs.columns])

  /** 工具条里能点的排序维度 = 四个基础维度 + 已经打开的那几列。 */
  const sortKeys = useMemo<readonly CleanSortKey[]>(() => {
    const extra = prefs.columns
      .map((id) => COLUMN_SORT_KEY[id])
      .filter((key) => !SORT_KEYS.includes(key))
    return [...SORT_KEYS, ...new Set(extra)]
  }, [prefs.columns])

  const sortKey = prefs.sortKey

  /**
   * 排序 + 筛选后真正渲染的批次，必须 memo：列表可达上万条，裸跑 O(n log n) 排序会在每次勾选、滚动、
   * 父组件重渲染时重排，抵消虚拟化。依赖放 `filters` 的三个字段而非对象本身，因 `setFilters` 每次产
   * 生新对象。/
   */
  const visible = useMemo(
    () => (showControls
      ? sortAndFilterItems(items, sortKey, filters, prefs.sortDir)
      : (items as PcCleanItem[])),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, showControls, sortKey, prefs.sortDir,
      filters.zeroRiskOnly, filters.reversibleOnly, filters.hideBlocked],
  )

  const selectable = useMemo(() => visible.filter((i) => !i.locked), [visible])
  const selectedCount = useMemo(
    () => selectable.filter((i) => selected.has(i.item_id)).length,
    [selectable, selected],
  )
  const allSelected = selectable.length > 0 && selectedCount === selectable.length

  /**
   * 分好组的条目。`groupBy` 没给时用空数组常量，不能写 `?? []`：每次渲染新数组会让下游 useMemo 永久
   * 失效。
   */
  const groups = useMemo(() => {
    if (!groupBy) return EMPTY_GROUPS
    const order: string[] = []
    const map = new Map<string, { key: string; label: string; items: PcCleanItem[] }>()
    for (const item of visible) {
      const hit = groupBy(item)
      const key = hit?.key ?? '__ungrouped__'
      const label = hit?.label ?? t('common.otherGroup')
      let bucket = map.get(key)
      if (!bucket) {
        bucket = { key, label, items: [] }
        map.set(key, bucket)
        order.push(key)
      }
      bucket.items.push(item)
    }
    return order.map((key) => map.get(key)!)
  }, [visible, groupBy, t])

  /** 组头 + 展开组的条目，拍成一个平列表交给**同一个**虚拟化器。
   *  两个虚拟化器嵌套会让外层量不准内层高度，滚动位置整个错位。 */
  const rows = useMemo<Row[]>(() => {
    if (!groupBy) return visible.map((item) => ({ kind: 'item', key: item.item_id, item }))
    const out: Row[] = []
    for (const group of groups) {
      const isCollapsed = collapsed.has(group.key)
        || (defaultCollapsed && !collapsed.has(`__open__${group.key}`))
      out.push({
        kind: 'header',
        key: group.key,
        label: group.label,
        count: group.items.length,
        bytes: group.items.reduce((sum, i) => sum + i.size_bytes, 0),
      })
      if (!isCollapsed) {
        for (const item of group.items) out.push({ kind: 'item', key: item.item_id, item })
      }
    }
    return out
  }, [groupBy, groups, visible, collapsed, defaultCollapsed])

  const toggleGroup = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      // 折叠状态要能表达"默认折叠时被手动打开"，所以用两个记号而非一个布尔，否则点开再点回去回不到折叠态
      // 。
      const openMark = `__open__${key}`
      if (defaultCollapsed) {
        if (next.has(openMark)) next.delete(openMark)
        else next.add(openMark)
      } else if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [defaultCollapsed])

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) => (rows[index]?.kind === 'header' ? 44 : 64),
    overscan: 8,
    // 按稳定 key 记测量缓存，不按下标。按下标记的话，折叠/勾选导致列表重排
    // 之后行高会记到别人身上，偏移全错——项目简报第 5 区那条虚拟列表的坑。
    getItemKey: (index) => rows[index]?.key ?? index,
  })

  // 所有 Hook 必须在下面那个"空列表就早退"的 return **之前**调用完 ——
  // 早退之后再调，条目从 0 变成非 0 的那一次渲染里 Hook 数量会变，React 直接报错。
  const toggleFilter = useCallback((key: keyof CleanListFilters) => {
    setFilters((prev) => ({ ...prev, [key]: !prev[key] }))
  }, [])

  const jumpTo = useCallback((groupKey: string) => {
    const index = rows.findIndex((r) => r.kind === 'header' && r.key === groupKey)
    if (index >= 0) virtualizer.scrollToIndex(index, { align: 'start' })
  }, [rows, virtualizer])

  if (items.length === 0) {
    return (
      <EmptyState
        icon={emptyIcon}
        title={emptyTitle ?? t('health.categoryEmpty')}
      />
    )
  }

  return (
    <div className={cn('flex flex-col', className)}>
      {showControls && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border/70 px-4 py-2.5">
          {/*
            指标列的开关。

            用一排 `aria-pressed` 的按钮而不是一个下拉菜单：这些开关是**互不
            排斥**的，下拉里的勾选项要点开才看得见当前状态，而这一排在关着的
            时候就已经把"有哪些指标可看、现在开了哪几个"两件事同时说完了。
            额外的好处是它天生可键盘遍历，也天生能被读屏软件念出按下与否。
          */}
          <div className="flex items-center gap-1.5">
            <Columns3 className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="text-2xs text-muted-foreground">{t('columns.title')}</span>
            {CLEAN_COLUMN_IDS.map((id) => {
              const on = prefs.columns.includes(id)
              const Icon = COLUMN_ICON[id]
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => updatePrefs(toggleCleanColumn(prefs, id))}
                  aria-pressed={on}
                  className={cn(
                    'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-2xs transition-colors',
                    on
                      ? 'border-accent-line bg-accent-soft/50 text-primary'
                      : 'border-border/70 bg-muted/40 text-muted-foreground hover:text-primary',
                  )}
                >
                  <Icon className="size-3.5 shrink-0" aria-hidden="true" />
                  {t(`column.${id}`)}
                </button>
              )
            })}
          </div>

          <div className="flex items-center gap-1.5">
            <span className="text-2xs text-muted-foreground">{t('controls.sortBy')}</span>
            {sortKeys.map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => updatePrefs({
                  ...prefs,
                  sortKey: key,
                  // 换维度时方向回到该维度的自然端（占用大的在前、名字 A 在前），不沿用上一维度的方向。
                  sortDir: DEFAULT_SORT_DIRECTION[key],
                })}
                aria-pressed={sortKey === key}
                className={cn(
                  'rounded-md border px-2 py-1 text-2xs transition-colors',
                  sortKey === key
                    ? 'border-accent-line bg-accent-soft/50 text-primary'
                    : 'border-border/70 bg-muted/40 text-muted-foreground hover:text-primary',
                )}
              >
                {t(`controls.sort_${key}`)}
              </button>
            ))}
            {/* 升/降序。图标 + 可读的名字（`aria-label`），不靠箭头方向单传信息。 */}
            <button
              type="button"
              onClick={() => updatePrefs({
                ...prefs,
                sortDir: prefs.sortDir === 'asc' ? 'desc' : 'asc',
              })}
              aria-label={t(prefs.sortDir === 'asc' ? 'controls.sortAsc' : 'controls.sortDesc')}
              title={t(prefs.sortDir === 'asc' ? 'controls.sortAsc' : 'controls.sortDesc')}
              className="inline-flex items-center gap-1 rounded-md border border-border/70 bg-muted/40 px-2 py-1 text-2xs text-muted-foreground transition-colors hover:text-primary"
            >
              {prefs.sortDir === 'asc' ? (
                <ArrowUpNarrowWide className="size-3.5" aria-hidden="true" />
              ) : (
                <ArrowDownWideNarrow className="size-3.5" aria-hidden="true" />
              )}
            </button>
          </div>

          <div className="flex items-center gap-1.5">
            {FILTER_KEYS.map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => toggleFilter(key)}
                aria-pressed={Boolean(filters[key])}
                className={cn(
                  'rounded-md border px-2 py-1 text-2xs transition-colors',
                  filters[key]
                    ? 'border-accent-line bg-accent-soft/50 text-primary'
                    : 'border-border/70 bg-muted/40 text-muted-foreground hover:text-primary',
                )}
              >
                {t(`controls.filter_${key}`)}
              </button>
            ))}
          </div>

          {/*
            **筛掉了多少必须说出来。**「12 项」和「12 项（另有 340 项被筛掉）」
            在屏幕上长得一模一样，而前者会被读成"这台机器很干净"。
            这跟后端 `truncated` 必须显示是同一条理由。
          */}
          {visible.length !== items.length && (
            <span className="ml-auto text-2xs text-muted-foreground">
              {t('controls.filteredOut', { count: items.length - visible.length })}
            </span>
          )}
        </div>
      )}

      {onToggleAll && selectable.length > 0 && (
        <div className="flex items-center gap-2.5 border-b border-border/70 px-4 py-2.5">
          <Checkbox
            checked={allSelected}
            onCheckedChange={(next) => onToggleAll(next === true)}
            aria-label={t('common.selectAll')}
          />
          <span className="text-sm text-muted-foreground">
            {t('common.selectAll')} · {t('common.items', { count: items.length })}
          </span>
        </div>
      )}

      {groups.length > 1 && (
        <div className="flex flex-wrap gap-1.5 border-b border-border/70 px-4 py-2.5">
          {groups.map((group) => (
            <button
              key={group.key}
              type="button"
              onClick={() => jumpTo(group.key)}
              className="rounded-md border border-border/70 bg-muted/40 px-2 py-1 text-2xs text-muted-foreground transition-colors hover:border-accent-line hover:text-primary"
            >
              <span className="truncate">{group.label}</span>
              <span className="tabular-unit tabular">{group.items.length}</span>
            </button>
          ))}
        </div>
      )}

      <div
        ref={parentRef}
        className="overflow-y-auto"
        style={{ height }}
      >
        <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const row = rows[virtualRow.index]
            if (!row) return null

            if (row.kind === 'header') {
              const isCollapsed = defaultCollapsed
                ? !collapsed.has(`__open__${row.key}`)
                : collapsed.has(row.key)
              const Chevron = isCollapsed ? ChevronRight : ChevronDown
              return (
                <button
                  key={row.key}
                  type="button"
                  ref={virtualizer.measureElement}
                  data-index={virtualRow.index}
                  onClick={() => toggleGroup(row.key)}
                  className="absolute inset-x-0 top-0 flex items-center gap-2 border-b border-border/70 bg-muted/40 px-4 py-2.5 text-left"
                  style={{ transform: `translateY(${virtualRow.start}px)` }}
                >
                  <Chevron className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="truncate text-sm font-medium">{row.label}</span>
                  <span className="ml-auto shrink-0 text-2xs text-muted-foreground">
                    <span className="tabular">{row.count}</span>
                    {row.bytes > 0 && (
                      <span className="tabular-unit tabular">{formatBytes(row.bytes)}</span>
                    )}
                  </span>
                </button>
              )
            }

            const item = row.item
            return (
              <CleanRow
                key={item.item_id}
                item={item}
                isSelected={selected.has(item.item_id)}
                zebra={virtualRow.index % 2 === 1}
                offset={virtualRow.start}
                index={virtualRow.index}
                onToggle={onToggle}
                measureRef={virtualizer.measureElement}
                renderTrailing={renderTrailing}
                renderLabel={renderLabel}
                renderMeta={renderMeta}
                columns={columns}
              />
            )
          })}
        </div>
      </div>
    </div>
  )
}
