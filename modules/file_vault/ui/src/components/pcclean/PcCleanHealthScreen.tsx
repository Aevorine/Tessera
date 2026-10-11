import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  Activity,
  Brush,
  ChevronDown,
  Cpu,
  Eye,
  Gauge,
  History,
  HardDrive,
  ListChecks,
  Puzzle,
  RotateCcw,
  ScanSearch,
  ShieldAlert,
  Sparkles,
  Square,
  Trash2,
  TriangleAlert,
  Zap,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Progress } from '@/components/ui/progress'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { StatTile } from '@/components/StatTile'
import {
  Badge,
  EmptyState,
  FeatureTitle,
  IconChip,
  METRIC_VALUE_CLASS,
  NUMERIC_CLASS,
  PageHeader,
  PageSection,
  PageShell,
} from '@/components/ui/page'
import { cn } from '@/lib/utils'
import { CleanItemList } from '@/components/pcclean/CleanItemList'
import { HealthScoreRing, ScoreBreakdown } from '@/components/pcclean/HealthScore'
import { PcCleanHero, StickyCleanBar } from '@/components/pcclean/PcCleanHero'
import { useHeroOutOfView } from '@/lib/useHeroOutOfView'
import { PcCleanTuning } from '@/components/pcclean/PcCleanTuning'
import { CategoryOutcomeBadge, CategoryStateLine } from '@/components/pcclean/CategoryState'
import { PcCleanAutomationSections } from '@/components/pcclean/PcCleanAutomationSections'
import { computeHealthScore } from '@/lib/healthScore'
import { vaultApi } from '@/lib/vaultApi'
import {
  CLEAN_LEVEL_ORDER,
  DEFAULT_TUNING,
  SCAN_MODES,
  type CleanLevel,
  type ScanMode,
  type TuningState,
  blockedCount,
  categoryLabel,
  categoryOutcome,
  formatBytes,
  formatCount,
  healthCheck,
  isSpaceBackedCategory,
  nextScanId,
  pccleanErrorKey,
  recommendedSelection,
  scanOptionsFor,
  selectAll,
  selectionForLevel,
  sumSelected,
  toggleIn,
  tuningOverrides,
} from '@/lib/pcclean'
import type {
  PcCleanExecuteResult,
  PcCleanFailure,
  PcCleanItem,
  PcCleanMemoryStatus,
  PcCleanPreviewResult,
  PcCleanScanResult,
} from '@/shared/pccleanTypes'
import { ActionButton } from '@/components/ActionButton'
import { LABEL_REGIONS } from '@/lib/labelMode'

/**
 * 体检与清理：清理套件首屏。布局服从一条规则——删除动作必须在第一屏。自上而下：①主控圆环（
 * `PcCleanHero`，扫一扫 → 立即清理）；②吸顶细条（`StickyCleanBar`，圆环滚出视野时浮出）；③失败卡/
 * 授权卡（仅有问题时出现）；④分数环 + 推荐清理；⑤四块数字 → 可选指标 → 类目总览 → 类目明细 → 自动
 * 化。扫描结果逐类到达就逐类渲染（见 `lib/pcclean.ts` 的 `healthCheck`），否则最慢一类（5~9 秒）会
 * 让屏幕静止。其中 `custom` 扫描器后端已注册却从未被前端发起，现已在 `CATEGORY_ORDER` 里；四种"空"
 * 靠后端扫描计数区分，见 `CategoryState.tsx`。/
 */

const CATEGORY_ICONS: Record<string, typeof Brush> = {
  junk: Trash2,
  browserCache: Brush,
  privacy: Eye,
  plugins: Puzzle,
  diskSlimming: HardDrive,
  startup: Activity,
  registry: ScanSearch,
  popupSources: Square,
  memory: Cpu,
  custom: ListChecks,
}

const CATEGORY_ORDER = [
  'junk',
  'browserCache',
  'privacy',
  'registry',
  'plugins',
  'startup',
  'popupSources',
  'diskSlimming',
  'memory',
  // 用户自己写的规则排最后：它的条目数完全取决于用户配了什么，
  // 放在内置类目中间会让顺序在不同机器上不一样。
  'custom',
] as const

export function PcCleanHealthScreen() {
  const { t } = useTranslation('pcclean')

  const [mode, setMode] = useState<ScanMode>('standard')
  /** 清理力度，默认「标准」：往激进设默认值等于替从不改设置的人做决定。 */
  const [cleanLevel, setCleanLevel] = useState<CleanLevel>('standard')
  const [scanning, setScanning] = useState(false)
  const [reports, setReports] = useState<Record<string, PcCleanScanResult>>({})
  const [memory, setMemory] = useState<PcCleanMemoryStatus | null>(null)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set(['junk']))
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set())
  const [lastRun, setLastRun] = useState<{ at: number; ms: number } | null>(null)
  const [failures, setFailures] = useState<PcCleanFailure[]>([])
  /** 不属于任何单一类别的问题（目前只有"数量对账不上"那一条）。 */
  const [scanErrors, setScanErrors] = useState<string[]>([])
  /** 每一类自己内部的进度；总进度条在最慢的那类上一动不动，会像卡死。 */
  const [ticks, setTicks] = useState<Record<string, { done: number; total: number }>>({})
  /** 全部可调指标。以前是散在各处的三个 useState，现在收成一个对象——
   *  它要整份传给 `tuningOverrides`，散着的话每加一条指标都要改三个地方。 */
  const [tuning, setTuning] = useState<TuningState>({ ...DEFAULT_TUNING })
  const [cleaning, setCleaning] = useState(false)
  const [result, setResult] = useState<PcCleanExecuteResult | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  /** 后端算的剩余时间（毫秒）。0 = 还没有历史样本，界面显示"计算中"而不是
   *  编一个数字——编出来的剩余时间一开始就是错的，比不给更糟。 */
  const [etaMs, setEtaMs] = useState(0)
  const [preview, setPreview] = useState<PcCleanPreviewResult | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const scanIdRef = useRef<string | null>(null)
  /**
   * 清理力度的当前值，给流式扫描回调用：回调捕获的是扫描开始时的快照，
   * 而体检要跑十几秒，用户中途调低力度时后到的类别仍会按旧力度勾选。
   */
  const cleanLevelRef = useRef<CleanLevel>(cleanLevel)
  cleanLevelRef.current = cleanLevel
  const sectionRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const [heroSentinel, heroOutOfView] = useHeroOutOfView()

  /** 本轮实际要扫的类。极速档只扫快的那几类，所以进度分母跟着变小——
   *  分母写死的话，极速档扫完四类进度条会永远停在 40%。 */
  const activeCategories = useMemo(() => {
    const wanted = new Set<string>(SCAN_MODES[mode].categories)
    return CATEGORY_ORDER.filter((c) => wanted.has(c))
  }, [mode])

  const allItems = useMemo(
    () => CATEGORY_ORDER.flatMap((c) => reports[c]?.items ?? []),
    [reports],
  )

  /** 列表里实际要画的条目。锁定项和"只看推广垃圾"两个开关在这里统一生效，
   *  各个列表自己 filter 的话迟早会漏掉一个。 */
  const visibleOf = useCallback(
    (items: readonly PcCleanItem[]) => {
      let out = items
      if (!tuning.showLocked) out = out.filter((i) => !i.locked)
      if (tuning.junkOnly) out = out.filter((i) => i.importance === 'junk')
      return out
    },
    [tuning.showLocked, tuning.junkOnly],
  )

  const selectedItems = useMemo(
    () => allItems.filter((i) => selected.has(i.item_id)),
    [allItems, selected],
  )
  const selectedBytes = useMemo(() => sumSelected(allItems, selected), [allItems, selected])

  const reclaimable = useMemo(
    () => allItems.filter((i) => i.default_selected && !i.locked).reduce((n, i) => n + i.size_bytes, 0),
    [allItems],
  )
  const attention = useMemo(() => allItems.filter((i) => i.importance === 'junk').length, [allItems])

  /** 推荐清理项：只挑**高置信度、可撤销**的那一批，见 lib/pcclean.ts。 */
  const recommended = useMemo(() => recommendedSelection(allItems), [allItems])
  const recommendedBytes = useMemo(
    () => sumSelected(allItems, recommended),
    [allItems, recommended],
  )
  const recommendedAdopted = useMemo(
    () => recommended.size > 0 && [...recommended].every((id) => selected.has(id)),
    [recommended, selected],
  )

  const health = useMemo(
    () => computeHealthScore(allItems, memory),
    [allItems, memory],
  )

  // 「清理记录」块（PcCleanAutomationSections）的落点；上面三个历史读数由这份记录算出，点它们要能跳到
  // 这里。
  const auditLogRef = useRef<HTMLDivElement | null>(null)
  const jumpToAuditLog = useCallback(() => {
    auditLogRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [])

  const jumpTo = useCallback((category: string) => {
    setExpanded((prev) => new Set(prev).add(category))
    // 展开是同步的 setState，滚动要等这一帧画完，否则量到的是旧高度。
    requestAnimationFrame(() => {
      sectionRefs.current[category]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  }, [])

  const runPreview = useCallback(async () => {
    if (previewing) return
    setPreviewing(true)
    try {
      const result = await vaultApi.call('pcclean_preview', {
        item_ids: [...selected],
      }) as PcCleanPreviewResult
      if (!result.ok) {
        toast.error(t(pccleanErrorKey(result.error)))
        return
      }
      setPreview(result)
    } catch {
      toast.error(t('preview.failed'))
    } finally {
      // 复位一律放 finally：`vaultApi.call` 会抛，写在 await 之后的话
      // 按钮会永久卡在"执行中"，而屏幕上一个字的错误提示都没有。
      setPreviewing(false)
    }
  }, [previewing, selected, t])

  // 清理历史（上次时间、累计释放、可用空间真实变化）全部从既有的 `pcclean_audit_log` 算出。
  const [history, setHistory] = useState<{
    lastTs: number
    totalFreed: number
    sessions: number
    lastDelta: number | null
  } | null>(null)

  const refreshHistory = useCallback(async () => {
    try {
      const res = await vaultApi.call('pcclean_audit_log', { limit: 200 })
      // 干跑不写审计（见 actions.py），所以读到的每一条都是真做过的。
      const done = (res.entries ?? []).filter((e) => e.done > 0)
      if (done.length === 0) {
        setHistory(null)
        return
      }
      const latest = done[0]
      // free_before/free_after 是这一轮才加的字段，老日志里没有——那时给 null
      // 而不是 0，否则界面会显示一个 `+0 B`，读起来像「清了个寂寞」。
      const hasFree = latest.free_before > 0 && latest.free_after > 0
      setHistory({
        lastTs: latest.ts,
        totalFreed: done.reduce((sum, e) => sum + (e.freed_bytes || 0), 0),
        sessions: done.length,
        lastDelta: hasFree ? latest.free_after - latest.free_before : null,
      })
    } catch {
      /* 历史读不到不该打断任何事 */
    }
  }, [])

  const refreshMemory = useCallback(async () => {
    try {
      const status = await vaultApi.call('pcclean_memory_status', {})
      setMemory(status)
    } catch {
      /* 内存读数拿不到不该打断任何事——它只是个磁贴 */
    }
  }, [])

  useEffect(() => {
    void refreshMemory()
    void refreshHistory()
  }, [refreshMemory, refreshHistory])

  const runScan = useCallback(async () => {
    if (scanning) return
    const scanId = nextScanId('health')
    scanIdRef.current = scanId
    setScanning(true)
    setReports({})
    setSelected(new Set())
    setPending(new Set(activeCategories))
    setResult(null)
    setFailures([])
    setScanErrors([])
    setTicks({})
    setEtaMs(0)

    try {
      const health = await healthCheck(
        scanId,
        (category, payload) => {
          // 每一类到了就立刻画出来，并把它的推荐项并进选择集合。
          setReports((prev) => ({ ...prev, [category]: payload }))
          if (typeof payload.eta_ms === 'number') setEtaMs(payload.eta_ms)
          // 从缓存回放来的那一批**不消 pending**：那一格要继续显示"扫描中"，
          // 因为真正的扫描确实还没跑完。消掉的话进度条会先跳到满再退回去。
          if (!payload.from_cache) {
            setPending((prev) => {
              const next = new Set(prev)
              next.delete(category)
              return next
            })
            setSelected((prev) => {
              const next = new Set(prev)
              // 按当前清理力度勾选，不是无条件按后端 `default_selected`：后者是"后端认为可清"，
              // 力度才是用户愿意承担的风险，否则扫描结果一到就覆盖了下拉框的选择。
              for (const id of selectionForLevel(payload.items, cleanLevelRef.current)) {
                next.add(id)
              }
              return next
            })
          }
        },
        scanOptionsFor(mode, tuningOverrides(tuning), tuning.budgetScale),
        (plan) => {
          setEtaMs(plan.eta_ms)
          // 从缓存铺上来的那几类不算"待扫"——它们屏幕上已经有内容了。
          // 但真正的扫描仍在跑，所以 pending 里保留它们，进度条才不会先满后退。
          if (plan.categories.length > 0) setPending(new Set(plan.categories))
        },
        (category, done, total) => {
          setTicks((prev) => ({ ...prev, [category]: { done, total } }))
        },
      )
      setReports(health.categories)
      setMemory(health.memory)
      setLastRun({ at: Date.now(), ms: health.elapsed_ms })
      setFailures(health.failures ?? [])
      // `errors[]` 里还有"数量对账不上"那条（派出 10 个只收回 9 个），不属于任何一类、failures[] 接不住，
      // 却是"看起来很干净"假象的来源，必须单独显示。
      setScanErrors(
        (health.errors ?? []).filter((e) => !(health.failures ?? []).some((f) => e.startsWith(f.category))),
      )
      setPending(new Set())
    } catch (error) {
      // 走到这里说明**整轮**都没回来（桥接层判负、后端崩了），
      // 而不是某一类失败——所以文案要说"整轮"，并把原因原文带上。
      setFailures([
        {
          category: '*',
          code: error instanceof Error ? error.message : 'unknown',
          detail: '',
        },
      ])
      setPending(new Set())
    } finally {
      setScanning(false)
      scanIdRef.current = null
    }
  }, [activeCategories, mode, scanning, tuning])

  /** 只重扫失败的那一类。整轮重来对用户是纯粹的浪费——九类是好的。 */
  const rescanOne = useCallback(async (category: string) => {
    if (category === '*') {
      void runScan()
      return
    }
    const scanId = nextScanId(`re-${category}`)
    setPending((prev) => new Set(prev).add(category))
    setFailures((prev) => prev.filter((f) => f.category !== category))
    try {
      const options = scanOptionsFor(mode, tuningOverrides(tuning), tuning.budgetScale)
      const payload = await vaultApi.call(
        'pcclean_scan',
        {
          category: category as never,
          options: (options[category] as Record<string, unknown> | undefined) ?? {},
          scan_id: scanId,
        },
        scanId,
      ) as PcCleanScanResult
      if (payload.ok) {
        setReports((prev) => ({ ...prev, [category]: payload }))
        setSelected((prev) => {
          const next = new Set(prev)
          for (const id of selectionForLevel(payload.items, cleanLevelRef.current)) {
            next.add(id)
          }
          return next
        })
      } else {
        setFailures((prev) => [
          ...prev,
          { category, code: pccleanErrorKey(payload.error), detail: '' },
        ])
      }
    } catch (error) {
      setFailures((prev) => [
        ...prev,
        {
          category,
          code: error instanceof Error ? error.message : 'unknown',
          detail: '',
        },
      ])
    } finally {
      setPending((prev) => {
        const next = new Set(prev)
        next.delete(category)
        return next
      })
    }
  }, [mode, runScan, tuning])

  const stopScan = useCallback(async () => {
    const scanId = scanIdRef.current
    if (!scanId) return
    try {
      await vaultApi.call('pcclean_cancel', { scan_id: scanId })
    } catch {
      /* 取消失败就让它自己跑完 */
    }
  }, [])

  /**
   * 选中项里撤不回来的那些。判据走 `reversibility` 的同一套语义：
   * 硬删除类（垃圾、浏览器缓存）、隐私痕迹、磁盘瘦身、浏览器数据、驱动包删了就没了；
   * 进回收站的（大文件、重复、下载、自定义规则、空目录）撤得回来。
   */
  /**
   * 这一批里删了拿不回来的那些，供确认对话框警告用，直接读后端 `safety.py` 回填的
   * `detail.reversibility`。读不到（落盘缓存里旧版本条目）回落 `permanent`：误说"撤得回来"比误说"撤
   * 不回来"危险得多。不要再硬编码类别名单（那是 `actions.reversibility()` 的第三份副本，没有守卫测试
   * 钉着）。/
   */
  const irreversibleSelected = useMemo(
    () => selectedItems.filter((i) => (i.detail?.reversibility ?? 'permanent') === 'permanent'),
    [selectedItems],
  )
  const reversibleCount = selectedItems.length - irreversibleSelected.length

  /** 选中项里有几条正被别的进程占着 —— 现在点清理，它们会原样返回。
   *  在确认页上先说，比在结果页上解释"为什么这几项没清掉"有用得多。 */
  const blockedSelected = useMemo(() => blockedCount(selectedItems), [selectedItems])

  /** 当前选择是否正好等于这个力度的默认集合。用来给那块数字点亮"已采纳"。 */
  const levelSelectionAdopted = useMemo(() => {
    const wanted = selectionForLevel(allItems, cleanLevel)
    return wanted.size > 0 && wanted.size === selected.size
      && [...wanted].every((id) => selected.has(id))
  }, [allItems, cleanLevel, selected])

  /**
   * 执行清理。`allowElevation` 默认 false，第一遍绝不弹 UAC；需管理员权限的项以 `needs_elevation` 原
   * 样返回，用户点了才带 true 重来。
   */
  const runClean = useCallback(async (ids: string[], allowElevation: boolean) => {
    setConfirmOpen(false)
    if (ids.length === 0) return
    setCleaning(true)
    try {
      const outcome = await vaultApi.call('pcclean_execute', {
        item_ids: ids,
        options: { create_restore_point: tuning.restorePoint, allow_elevation: allowElevation },
      })
      setResult(outcome)
      const stillNeedsAuth = outcome.needs_elevation?.count ?? 0
      if (outcome.aborted) {
        toast.error(t(pccleanErrorKey(outcome.aborted)))
      } else if (stillNeedsAuth > 0 && !allowElevation) {
        // 不是错误，是"还差一步"。用警告色而不是红色——红色会让人以为搞砸了。
        toast.warning(
          t('health.doneNeedsAuth', {
            size: formatBytes(outcome.freed_bytes),
            count: stillNeedsAuth,
          }),
        )
      } else if (outcome.failed === 0 && outcome.skipped === 0) {
        toast.success(
          t('health.done', { size: formatBytes(outcome.freed_bytes), count: outcome.done }),
        )
      } else {
        toast.warning(
          t('health.partial', {
            size: formatBytes(outcome.freed_bytes),
            failed: outcome.failed,
            skipped: outcome.skipped,
          }),
        )
      }
      // 清掉的从选择集合里移走；还需要授权的**留着**，否则那张卡上的
      // "授权并继续"点下去就没有条目可清了。
      const keep = new Set(outcome.needs_elevation?.item_ids ?? [])
      setSelected((prev) => new Set([...prev].filter((id) => keep.has(id))))
      void refreshMemory()
    } catch {
      toast.error(t('execute.failed'))
    } finally {
      setCleaning(false)
    }
  }, [refreshMemory, t, tuning.restorePoint])

  const undoLast = useCallback(async () => {
    if (!result?.session_id) return
    try {
      const undo = await vaultApi.call('pcclean_undo', { session_id: result.session_id })
      if (undo.ok) {
        toast.success(t('health.undoRestored', { count: undo.restored ?? 0 }))
        if (undo.irreversible) {
          toast.info(t('health.undoIrreversible', { count: undo.irreversible }))
        }
      } else {
        toast.error(t(pccleanErrorKey(undo.error)))
      }
    } catch {
      toast.error(t('undo.failed'))
    }
  }, [result, t])

  const scannedCount = activeCategories.filter((c) => !pending.has(c)).length
  const progressValue = scanning
    ? Math.round((scannedCount / Math.max(1, activeCategories.length)) * 100)
    : 100
  /** 正在扫的那几类的名字。用户问的"它到底在不在跑"，答案就是这一行。 */
  const nowScanning = activeCategories
    .filter((c) => pending.has(c))
    .slice(0, 3)
    .map((c) => categoryLabel(t, c))
    .join(' · ')

  const pendingAuth = result?.needs_elevation
  const hasScanned = Object.keys(reports).length > 0
  const heroState = cleaning ? 'cleaning' : scanning ? 'scanning' : hasScanned ? 'ready' : 'idle'
  const lastRunLabel = lastRun
    ? t('hero.lastRun', {
        time: new Date(lastRun.at).toLocaleTimeString(),
        seconds: (lastRun.ms / 1000).toFixed(1),
      })
    : undefined

  /** 主清理入口。选了东西就清选中的，没选就清推荐的——一个"清理"按钮
   *  在用户什么都没勾的时候弹一句"你还没选"是纯粹的空转。 */
  const startClean = useCallback(() => {
    if (selected.size === 0 && recommended.size > 0) setSelected(new Set(recommended))
    if (selected.size === 0 && recommended.size === 0) return
    setConfirmOpen(true)
  }, [recommended, selected.size])

  return (
    <PageShell width="canvas">
      <PageHeader
        title={t('health.title')}
        actions={
          <>
            {/* 扫描档位放在主按钮**左边**：它决定那个按钮会干什么，
                读的顺序就该是"用哪一档 → 开始扫"。 */}
            <Select
              value={mode}
              onValueChange={(value) => setMode(value as ScanMode)}
              disabled={scanning}
            >
              <SelectTrigger className="w-44" aria-label={t('health.mode')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(SCAN_MODES) as ScanMode[]).map((m) => (
                  <SelectItem key={m} value={m}>
                    {t(`health.mode_${m}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {/*
              清理力度。**和扫描档位是两个独立的选择，所以是两个独立的控件。**

              合成一个下拉框看起来更简洁，代价是"我想扫得全一点"会被无声地
              翻译成"我想删得狠一点"——而用户选深度扫描是想**看见**更多东西，
              不是想删更多东西。这两件事混在一起过一次，结果就是隐私痕迹
              跟着扫描档位一起被自动勾上。
            */}
            <Select
              value={cleanLevel}
              onValueChange={(value) => setCleanLevel(value as CleanLevel)}
              disabled={cleaning}
            >
              <SelectTrigger className="w-44" aria-label={t('cleanLevel.label')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CLEAN_LEVEL_ORDER.map((level) => (
                  <SelectItem key={level} value={level}>
                    {t(`cleanLevel.${level}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {scanning ? (
              <Button variant="outline" onClick={stopScan}>
                <Square className="size-4" aria-hidden="true" />
                {t('health.stop')}
              </Button>
            ) : (
              <Button variant="outline" onClick={runScan} disabled={scanning}>
                {mode === 'fast' ? (
                  <Zap className="size-4" aria-hidden="true" />
                ) : (
                  <ScanSearch className="size-4" aria-hidden="true" />
                )}
                {lastRun ? t('hero.rescan') : t('hero.scanNow')}
              </Button>
            )}
          </>
        }
      />

      {/* ①主控圆环。**整个套件里唯一的巨型控件，位置固定在第一屏。** */}
      <PcCleanHero
        state={heroState}
        reclaimableBytes={hasScanned ? reclaimable : 0}
        selectedCount={selected.size}
        selectedBytes={selectedBytes}
        progress={progressValue}
        scanningLabel={nowScanning ? t('health.scanningNow', { names: nowScanning }) : undefined}
        etaSeconds={etaMs > 0 ? Math.ceil(etaMs / 1000) : undefined}
        onScan={runScan}
        onStop={stopScan}
        onClean={startClean}
        onSelectRecommended={() => setSelected(new Set(recommended))}
        onClearSelection={() => setSelected(new Set())}
        recommendedCount={recommended.size}
        lastRunLabel={lastRunLabel}
      />
      {/* 哨兵：1px 高，圆环底部。它离开视野 = 该浮出吸顶条了。 */}
      <div ref={heroSentinel} aria-hidden="true" className="-mt-7 h-px w-full" />

      {/* ②吸顶细条。和圆环共用同一份状态、同一个回调。 */}
      <StickyCleanBar
        visible={heroOutOfView && hasScanned}
        selectedCount={selected.size}
        selectedBytes={selectedBytes}
        cleaning={cleaning}
        canClean={selected.size > 0 || recommended.size > 0}
        onClean={startClean}
        onClearSelection={() => setSelected(new Set())}
        score={health.score}
        scoreTone={health.tone}
      />

      {scanning && (
        <div className="space-y-2">
          <Progress value={progressValue} />
          <p className="text-2xs text-muted-foreground">
            {/* 四样一起给：在扫什么、扫了几类、检查了多少地方、还剩多久。
                缺任何一样，用户都还得自己猜"它是不是死了"。 */}
            {nowScanning ? t('health.scanningNow', { names: nowScanning }) : t('health.scanning')}
            {' · '}
            <span className={NUMERIC_CLASS}>{scannedCount}</span>/
            <span className={NUMERIC_CLASS}>{activeCategories.length}</span>
            {etaMs > 0 && <> · {t('health.eta', { seconds: Math.ceil(etaMs / 1000) })}</>}
            {etaMs === 0 && pending.size > 0 && <> · {t('health.etaCalculating')}</>}
          </p>
        </div>
      )}

      {/*
        失败卡。**这是「这次扫描没跑完」的替代品。**
        三样缺一不可：哪一类、什么原因、下一步能做什么。
      */}
      {failures.length > 0 && (
        <PageSection icon={TriangleAlert} title={t('health.failuresTitle')} tone="warning">
          <ul className="flex flex-col gap-2">
            {failures.map((f) => (
              <li
                key={`${f.category}-${f.code}`}
                className="flex flex-wrap items-center justify-between gap-3"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    {f.category === '*' ? t('health.failureWholeRun') : categoryLabel(t, f.category)}
                  </p>
                  <p className="break-all text-2xs text-muted-foreground">
                    {t(`failure.${f.code}`, { defaultValue: f.detail || f.code })}
                  </p>
                </div>
                <Button variant="outline" size="sm" onClick={() => void rescanOne(f.category)}>
                  <RotateCcw className="size-4" aria-hidden="true" />
                  {f.category === '*' ? t('health.retryAll') : t('health.retryOne')}
                </Button>
              </li>
            ))}
          </ul>
        </PageSection>
      )}

      {scanErrors.length > 0 && (
        <Alert>
          <AlertDescription>
            {t('common.errorsDuringScan', { detail: scanErrors.slice(0, 3).join('; ') })}
          </AlertDescription>
        </Alert>
      )}

      {/*
        需要管理员权限的那一批。**这张卡是"清理功能无法实际使用"的正解。**
        以前这些项被算进笼统的"没能清掉的 N 项"，界面上没有任何按钮
        能让人去授权，于是注册表、系统目录、C 盘瘦身永远清不掉。
      */}
      {pendingAuth && pendingAuth.count > 0 && (
        <PageSection icon={ShieldAlert} title={t('elevate.title')} tone="warning">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-sm">
                {t('elevate.body', {
                  count: pendingAuth.count,
                  size: formatBytes(pendingAuth.bytes),
                })}
              </p>
              <p className="mt-1 max-w-[68ch] text-2xs leading-5 text-muted-foreground">
                {t('elevate.why')}
              </p>
            </div>
            <Button
              onClick={() => void runClean(pendingAuth.item_ids, true)}
              disabled={cleaning}
            >
              <ShieldAlert className="size-4" aria-hidden="true" />
              {cleaning ? t('health.cleaning') : t('elevate.authorize')}
            </Button>
          </div>
        </PageSection>
      )}

      {/* 还没扫过时给一张明确的空状态，而不是一片什么都没有的留白。
          「没有内容」和「加载失败」在一片空白上长得一模一样。 */}
      {!hasScanned && !scanning && (
        <EmptyState
          icon={ScanSearch}
          title={t('state.noScanTitle')}
        />
      )}

      {/*
        分数环 + 推荐清理。回答"这台机器行不行"和"那我该干什么"。
        排在主控圆环之后：那个圆已经把最重要的动作办了，这两块是给
        想多了解一点的人看的。
      */}
      {hasScanned && (
        <div className="grid gap-4 lg:grid-cols-[minmax(280px,340px)_1fr]">
          <PageSection icon={Gauge} title={t('score.title')} tone="neutral">
            <div className="flex flex-col items-center gap-4">
              <HealthScoreRing
                score={health.score}
                tone={health.tone}
                label={t('score.unit')}
                sublabel={t(`score.verdict_${health.tone}`)}
              />
              <ScoreBreakdown penalties={health.penalties} onJump={jumpTo} />
            </div>
          </PageSection>

          <PageSection
            icon={Sparkles}
            title={t('recommend.title')}
            tone="accent"
          >
            {recommended.size === 0 ? (
              <p className="text-sm text-muted-foreground">{t('recommend.nothing')}</p>
            ) : (
              <div className="flex flex-col gap-4">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  {/* 和分数环、统计磁贴共用同一个数值样式——这一屏上的大数字
                      必须是同一档，否则"界面统一"就只是句话。 */}
                  <span className={cn(METRIC_VALUE_CLASS, 'text-success')}>
                    {formatBytes(recommendedBytes)}
                  </span>
                  <span className="text-sm text-muted-foreground">
                    {t('recommend.summary', { count: recommended.size })}
                  </span>
                </div>
                <p className="max-w-[64ch] text-2xs leading-5 text-muted-foreground">
                  {t('recommend.safetyNote')}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    onClick={() => {
                      setSelected(new Set(recommended))
                      setConfirmOpen(true)
                    }}
                    disabled={cleaning}
                  >
                    <Trash2 className="size-4" aria-hidden="true" />
                    {t('recommend.cleanNow')}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => setSelected(new Set(recommended))}
                    disabled={cleaning || recommendedAdopted}
                  >
                    {t('recommend.selectOnly')}
                  </Button>
                </div>
              </div>
            )}
          </PageSection>
        </div>
      )}

      {hasScanned && (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {/* 每块数字都是入口，不是装饰：数字回答"有多少"，点击回答"是哪些"。
              这条是全应用规则，`tests/statTilesClickable.test.mjs` 会拦。 */}
          <StatTile
            label={t('health.reclaimable')}
            value={formatBytes(reclaimable)}
            hint={t(`cleanLevel.${cleanLevel}Hint`)}
            active={levelSelectionAdopted}
            onClick={() => setSelected(selectionForLevel(allItems, cleanLevel))}
          />
          <StatTile
            label={t('health.itemsFound')}
            value={formatCount(allItems.length)}
            hint={t('health.expandAll')}
            active={expanded.size === CATEGORY_ORDER.length}
            onClick={() =>
              setExpanded((prev) =>
                prev.size === CATEGORY_ORDER.length ? new Set() : new Set(CATEGORY_ORDER),
              )
            }
          />
          <StatTile
            label={t('health.needsAttention')}
            value={formatCount(attention)}
            hint={t('importance.junk')}
            active={tuning.junkOnly}
            onClick={() => setTuning((prev) => ({ ...prev, junkOnly: !prev.junkOnly }))}
          />
          <StatTile
            label={t('health.memoryInUse')}
            value={memory ? `${memory.load_percent}%` : '—'}
            hint={
              memory
                ? `${formatBytes(memory.used_bytes)} / ${formatBytes(memory.total_bytes)}`
                : undefined
            }
            active={expanded.has('memory')}
            onClick={() => jumpTo('memory')}
          />
        </div>
      )}

      {memory && memory.cache_bytes > 0 && (
        <Alert>
          <AlertDescription>
            <span className="font-medium">{t('memory.cached')}: {formatBytes(memory.cache_bytes)}</span>
            {' — '}
            {t('memory.cachedHint')}
          </AlertDescription>
        </Alert>
      )}

      {/*
        清理有没有留下痕迹。

        在这之前，一次清理做完就什么都不剩了：下次打开这个面板，界面对
        "你上周清过一次、释放了 3 GB"一无所知。一个每次都从零开始的工具，
        用户没有任何理由相信它上次真的做了什么。

        三个数字，前两个来自审计日志（本来就在记，只是没人读），第三个是
        这轮新加的：**清理前后系统盘可用空间的真实变化**。
        它和「累计释放」几乎必然对不上——我们报的是各项 size_bytes 的加总，
        而硬链接、稀疏文件、删不掉的占用文件、进回收站只是挪了位置的东西
        都会让两者分叉。**把两个数摆在一起而不是只留一个**，用户一眼就知道
        该信哪个；只报我们自己算的那个，才是真的在糊弄人。
      */}
      {history && (
        <PageSection icon={History} title={t('history.title')} tone="neutral">
          <div className="grid gap-3 sm:grid-cols-3">
            {/* 三块都能点，点了滚到本页最下面那份「清理记录」清单——它们本来就是
                从那份清单（pcclean_audit_log）算出来的，所以"是哪几次"有实实在在
                的去处，不是为了让守卫变绿硬安上去的空动作。 */}
            <StatTile
              label={t('history.lastRun')}
              value={new Date(history.lastTs * 1000).toLocaleDateString()}
              hint={new Date(history.lastTs * 1000).toLocaleTimeString()}
              onClick={jumpToAuditLog}
            />
            <StatTile
              label={t('history.totalFreed')}
              value={formatBytes(history.totalFreed)}
              hint={t('history.sessions', { count: history.sessions })}
              onClick={jumpToAuditLog}
            />
            {history.lastDelta !== null && (
              <StatTile
                label={t('history.lastDelta')}
                value={
                  // 负数照实显示。清理期间别的程序在写盘是常态，编一个非负数
                  // 等于告诉用户这个数字是我们捏的。
                  (history.lastDelta >= 0 ? '+' : '−') + formatBytes(Math.abs(history.lastDelta))
                }
                hint={t('history.lastDeltaHint')}
                onClick={jumpToAuditLog}
              />
            )}
          </div>
        </PageSection>
      )}

      {/* 可选指标。档位管"扫哪几类"，这里管"什么算垃圾"。 */}
      <PcCleanTuning tuning={tuning} onChange={setTuning} />

      {/*
        总览格。回答的是"具体是哪几类、各有多少"。

        六格共用一套语义色（success/warning/neutral），**不给每一类分配各自
        的色相**——颜色在这里的含义必须是"状态"而不是"哪一类"，否则一屏十种
        颜色只是好看，读不出任何信息。
      */}
      {(scanning || hasScanned) && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {activeCategories.map((category) => {
            const report = reports[category]
            const isPending = pending.has(category)
            const failed = failures.some((f) => f.category === category)
            const outcome = categoryOutcome(report, { pending: isPending, failed })
            const Icon = CATEGORY_ICONS[category] ?? ListChecks
            const count = report?.items.length ?? 0
            const bytes = report?.selectable_bytes ?? 0
            const spaceBacked = isSpaceBackedCategory(category)
            const tone: 'success' | 'warning' | 'danger' | 'neutral' =
              failed ? 'danger'
                : report?.timed_out ? 'warning'
                  : outcome === 'blocked' || outcome === 'skipped' ? 'warning'
                    : count > 0 ? 'success' : 'neutral'

            return (
              <button
                key={`ov-${category}`}
                type="button"
                onClick={() => jumpTo(category)}
                disabled={isPending || count === 0}
                className={cn(
                  'flex items-start gap-3 rounded-lg border border-border/70 bg-card px-4 py-3 text-left transition-colors',
                  'enabled:hover:border-accent-line enabled:hover:bg-accent-soft/30',
                  'disabled:cursor-default disabled:opacity-70',
                  expanded.has(category) && 'border-accent-line bg-accent-soft/40',
                )}
              >
                <IconChip icon={Icon} tone={tone} size="sm" className="mt-0.5" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{categoryLabel(t, category)}</p>
                  <p className="text-2xs text-muted-foreground">
                    {isPending ? (
                      // 这一类自己的进度；总进度条给不出，它在最慢的那类上不动。
                      ticks[category] && ticks[category].total > 0 ? (
                        <>
                          {t('health.scanning')}{' '}
                          <span className={NUMERIC_CLASS}>
                            {formatCount(ticks[category].done)}
                          </span>
                          /
                          <span className={NUMERIC_CLASS}>
                            {formatCount(ticks[category].total)}
                          </span>
                        </>
                      ) : reports[category]?.current_path ? (
                        // 慢扫描里数字动得极慢仍像卡住；路径在滚动才让人相信它在干活（用户报过"无进度显示"）。
                        <span className="block truncate" title={reports[category]!.current_path}>
                          {reports[category]!.current_path}
                        </span>
                      ) : (
                        t('health.scanning')
                      )
                    ) : failed ? (
                      t('health.failedShort')
                    ) : (
                      <>
                        <span className={NUMERIC_CLASS}>{formatCount(count)}</span>
                        {bytes > 0 && (
                          // 非磁盘类（目前只有内存）必须带前缀说明这不是可释放空间：
                          // 裸「7.9 GB」放在「垃圾文件 20 GB」旁会被读成还能再清 7.9 GB，而压缩工作集并不释放任何东西。
                          <span className={cn('tabular-unit', NUMERIC_CLASS)}>
                            {spaceBacked
                              ? formatBytes(bytes)
                              : t('health.residentPrefix', { bytes: formatBytes(bytes) })}
                          </span>
                        )}
                      </>
                    )}
                  </p>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {/* 「0 项」到底是哪一种 0，这里当场说清楚。 */}
                    {!isPending && !failed && <CategoryOutcomeBadge outcome={outcome} />}
                    {report?.from_cache && <Badge tone="neutral">{t('health.fromCache')}</Badge>}
                    {report?.timed_out && <Badge tone="warning">{t('health.timedOut')}</Badge>}
                  </div>
                </div>
              </button>
            )
          })}
        </div>
      )}

      {CATEGORY_ORDER.map((category) => {
        const report = reports[category]
        const isPending = pending.has(category)
        if (!report && !isPending) return null
        const items = report?.items ?? []
        const shown = visibleOf(items)
        const isOpen = expanded.has(category)
        const chosen = items.filter((i) => selected.has(i.item_id)).length
        const failed = failures.some((f) => f.category === category)
        const outcome = categoryOutcome(report, { pending: isPending, failed })

        return (
          <div
            key={category}
            ref={(el) => {
              sectionRefs.current[category] = el
            }}
          >
            <PageSection
              icon={CATEGORY_ICONS[category] ?? ListChecks}
              title={categoryLabel(t, category)}
              actions={
                <>
                  {chosen > 0 && <Badge tone="accent">{chosen}</Badge>}
                  {/* 纯图标，名字只能靠悬停提示。这颗常常是禁用的（这一类为空时），
                      而禁用的按钮不派发 pointer 事件——所以必须走 ActionButton，
                      它给禁用态套了一层还能收 hover 的包装。 */}
                  <ActionButton
                    label={t('health.toggleCategory')}
                    icon={ChevronDown}
                    region={LABEL_REGIONS.pcCleanSection}
                    onClick={() =>
                      setExpanded((prev) => {
                        const next = new Set(prev)
                        if (next.has(category)) next.delete(category)
                        else next.add(category)
                        return next
                      })
                    }
                    disabled={isPending || items.length === 0}
                    active={isOpen}
                    className={isOpen ? '[&_svg]:rotate-180 [&_svg]:transition-transform' : '[&_svg]:transition-transform'}
                  />
                </>
              }
              padded={false}
            >
              {/* 这一类是干什么的 + 这一轮的结论 + 证据。三段固定顺序，
                  见 CategoryState.tsx 里那段说明。 */}
              <CategoryStateLine category={category} report={report} outcome={outcome} />
              {report?.truncated && (
                <div className="border-b border-border/70 px-4 py-2">
                  <p className="text-2xs text-warning">
                    {t('common.truncated', { count: items.length })}
                  </p>
                </div>
              )}
              {isOpen && !isPending && (
                <CleanItemList
                  items={shown}
                  selected={selected}
                  height={Math.min(420, Math.max(140, shown.length * 64))}
                  // 工具条只在条目 ≥20 时出现：少于二十条一屏看完，排序筛选省下的时间不及读那排按钮。
                  showControls={shown.length >= 20}
                  onToggle={(id, next) => setSelected((prev) => toggleIn(prev, id, next))}
                  onToggleAll={(next) => setSelected((prev) => selectAll(prev, shown, next))}
                  renderLabel={(item) => renderItemLabel(item, t)}
                />
              )}
            </PageSection>
          </div>
        )
      })}

      {/* 撤销条。**只剩撤销**——清理动作已经搬到首屏和吸顶条了，
          这里留一个"刚才那一下我后悔了"的入口，而它天然属于页面底部：
          用户是在清理**之后**才需要它的。 */}
      {result?.undoable && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/70 bg-card px-6 py-4">
          <div className="min-w-0">
            <FeatureTitle as="p">{t('health.undoTitle')}</FeatureTitle>
            <p className="text-2xs text-muted-foreground">
              {t('health.done', {
                size: formatBytes(result.freed_bytes),
                count: result.done,
              })}
            </p>
          </div>
          <Button variant="outline" onClick={undoLast}>
            <RotateCcw className="size-4" aria-hidden="true" />
            {t('health.undoLast')}
          </Button>
        </div>
      )}

      {/*
        定时清理 / 自定义规则 / 审计日志。

        **它们以前埋在工具箱页最底部**，而工具箱是"知道自己要什么的人才会去"
        的地方。这三件事说的都是"怎么清理这台机器"，属于这一页。
        自定义规则尤其重要：它建完之后终于真的会跑了（见文件头第 1 条）。
      */}
      <PcCleanAutomationSections auditSectionRef={auditLogRef} />

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('confirm.title', { count: selected.size })}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <p className="font-medium">{t('confirm.summary', { size: formatBytes(selectedBytes) })}</p>

            {/* 可撤销 / 不可撤销分两行说，而不是笼统一句"有些不可撤销"。
                用户要判断的是"值不值得点下去"，而那取决于**具体几项**撤不回来。 */}
            {reversibleCount > 0 && (
              <p className="flex items-center gap-2 text-muted-foreground">
                <span className="inline-block size-2 shrink-0 rounded-full bg-success" aria-hidden="true" />
                {t('confirm.reversibleLine', { count: reversibleCount })}
              </p>
            )}
            {irreversibleSelected.length > 0 && (
              <Alert>
                <AlertDescription className="flex items-start gap-2">
                  <span className="mt-1.5 inline-block size-2 shrink-0 rounded-full bg-warning" aria-hidden="true" />
                  <span>
                    <span className="font-medium">
                      {t('confirm.permanentLine', { count: irreversibleSelected.length })}
                    </span>{' '}
                    {t('execute.confirmHard')}
                  </span>
                </AlertDescription>
              </Alert>
            )}

            {/*
              「这几项现在删不掉，因为它们正被别的程序开着」。

              **必须出现在这里，而不是在结果页上。** 放到结果页就变成了事后
              解释：用户已经点了清理、等完了进度条，然后被告知有几项没成功。
              放在按钮前面，他多一个选择——去把浏览器关掉再回来。
            */}
            {blockedSelected > 0 && (
              <Alert>
                <AlertDescription className="flex items-start gap-2">
                  <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
                  <span>{t('confirm.blockedLine', { count: blockedSelected })}</span>
                </AlertDescription>
              </Alert>
            )}

            {/*
              预演结果。放在确认对话框里而不是单开一个面板，是因为用户唯一会想
              预演的时刻就是**手指悬在"确认清理"上面的那一刻**——放远一点等于
              没人会用。
            */}
            {preview && (
              <div className="space-y-2 rounded-lg border border-border/70 bg-muted/30 p-3">
                <p className="text-2xs text-muted-foreground">{t('preview.unchanged')}</p>
                {preview.drives.map((drive) => (
                  <div key={drive.drive} className="flex items-center gap-2 text-2xs">
                    <span className="font-medium">{drive.drive}:</span>
                    <span className={NUMERIC_CLASS}>{formatBytes(drive.free_before)}</span>
                    <span aria-hidden="true">→</span>
                    <span className={cn('font-medium text-success', NUMERIC_CLASS)}>
                      {formatBytes(drive.free_after_max)}
                    </span>
                    <span className="text-muted-foreground">{t('preview.freeAfter')}</span>
                  </div>
                ))}
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {(['recycle', 'restorable', 'permanent'] as const).map((level) => {
                    const bucket = preview.by_reversibility[level]
                    if (!bucket || bucket.count === 0) return null
                    return (
                      <Badge
                        key={level}
                        tone={level === 'permanent' ? 'warning' : 'neutral'}
                      >
                        {t(`reversibility.${level}`)}
                        <span className={cn('tabular-unit', NUMERIC_CLASS)}>{bucket.count}</span>
                      </Badge>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
          <div className="flex flex-wrap justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              {t('confirm.back')}
            </Button>
            <Button variant="outline" onClick={runPreview} disabled={previewing}>
              {previewing ? t('health.running') : t('preview.run')}
            </Button>
            <Button onClick={() => void runClean([...selected], false)}>
              <Trash2 className="size-4" aria-hidden="true" />
              {t('confirm.proceed')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </PageShell>
  )
}

/**
 * 行标题。垃圾/隐私/磁盘三类的 `label` 是规则键（`userTemp`），需翻译；其余是真实名字，原样显示。
 * 规则键由后端放在 `detail.label_key`，不在这里拼：拼错时 i18next 回落成键本身，界面出现原文且不报
 * 错。/
 */
function renderItemLabel(item: PcCleanItem, t: (key: string) => string): React.ReactNode {
  const labelKey = item.detail?.label_key
  if (typeof labelKey === 'string' && labelKey) {
    const stripped = labelKey.startsWith('pcclean.') ? labelKey.slice('pcclean.'.length) : labelKey
    return t(stripped)
  }
  return item.label
}
