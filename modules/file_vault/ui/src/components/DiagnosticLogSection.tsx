import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  AlertTriangle,
  ClipboardCopy,
  Info,
  RefreshCw,
  Search,
  Trash2,
  XCircle,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Badge, type Tone } from '@/components/ui/page'
import type { LucideIcon } from 'lucide-react'
import { vaultApi } from '@/lib/vaultApi'
import type { DiagnosticLevel, DiagnosticLogEntry, DiagnosticLogStats } from '@/shared/ipcTypes'
import { copyText } from '@/lib/clipboard'

/**
 * 故障诊断日志。只记「功能没能正常工作」，不记正常操作；与「活动记录」不同，它必须在金库锁着时也能
 * 写，所以是明文的，也因此默认关闭。筛选放后端（diagnostic_log_query），避免每改条件就序列化整份日
 * 志；按 uid 删除（diagnostic_log_delete）。空列表要说清楚为什么空；后端由 RPC 分发层统一采集，见
 * backend_server.py::_record_rpc_failure。字体固定：Times New Roman 放在宋体前，CSS 逐字符回退，拉
 * 丁与标点用前者，汉字落到宋体；顺序反了就全是宋体。
 */
/** `variant` 只影响外壳（设置页小卡片 / 导航整页），共用一份实现以保证开关状态和内容处处一致。 */

const LOG_FONT = '"Times New Roman", 宋体, SimSun, serif'

const LEVELS: DiagnosticLevel[] = ['error', 'warn', 'info']

const LEVEL_META: Record<DiagnosticLevel, { tone: Tone; icon: LucideIcon }> = {
  error: { tone: 'danger', icon: XCircle },
  warn: { tone: 'warning', icon: AlertTriangle },
  info: { tone: 'info', icon: Info },
}

/** 时间范围选项，值是"往前多少秒"。0 = 不限。 */
const RANGES: { id: string; seconds: number }[] = [
  { id: 'all', seconds: 0 },
  { id: 'hour', seconds: 3600 },
  { id: 'day', seconds: 86400 },
  { id: 'week', seconds: 604800 },
]

const EMPTY_STATS: DiagnosticLogStats = {
  lines: 0,
  occurrences: 0,
  by_level: { error: 0, warn: 0, info: 0 },
  by_module: [],
  top_problems: [],
  first_ts: 0,
  last_ts: 0,
}

export function DiagnosticLogSection({ variant = 'section' }: { variant?: 'section' | 'page' } = {}) {
  const { t } = useTranslation('settings')
  const [enabled, setEnabled] = useState(false)
  const [entries, setEntries] = useState<DiagnosticLogEntry[]>([])
  const [stats, setStats] = useState<DiagnosticLogStats>(EMPTY_STATS)
  const [modules, setModules] = useState<string[]>([])
  const [matched, setMatched] = useState(0)
  const [truncated, setTruncated] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)

  // 筛选条件。level 是多选（排查时常要"错误 + 警告"一起看），module 单选就够。
  const [levelFilter, setLevelFilter] = useState<Set<DiagnosticLevel>>(new Set())
  const [moduleFilter, setModuleFilter] = useState<string>('all')
  const [range, setRange] = useState<string>('all')
  const [search, setSearch] = useState('')
  // 输入框每敲一个字就发一次 RPC 会让正在出问题的机器更卡，防抖 250ms。
  const [debouncedSearch, setDebouncedSearch] = useState('')

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search), 250)
    return () => window.clearTimeout(timer)
  }, [search])

  // 竞态守卫：筛选条件连着改几次时，先发的请求可能后回来，把新结果盖回旧的。
  // 这类 bug 的表现是"筛选偶尔不生效"，最难复现也最难查。
  const requestSeq = useRef(0)

  const refresh = useCallback(async () => {
    const seq = ++requestSeq.current
    const status = await vaultApi.call('diagnostic_log_status', {})
    if (status.ok && seq === requestSeq.current) setEnabled(status.enabled)

    const seconds = RANGES.find((r) => r.id === range)?.seconds ?? 0
    const result = await vaultApi.call('diagnostic_log_query', {
      levels: [...levelFilter],
      modules: moduleFilter === 'all' ? [] : [moduleFilter],
      search: debouncedSearch,
      since: seconds ? Math.floor(Date.now() / 1000) - seconds : 0,
    })
    if (seq !== requestSeq.current) return
    if (result.ok) {
      setEntries(result.entries)
      setModules(result.modules)
      setMatched(result.matched)
      setTruncated(result.truncated)
      // 勾选状态按 uid 存，所以刷新后还在；但已经消失的条目要摘掉，
      // 否则"已选 3 条"里会一直算着几条早就没了的记录。
      setSelected((prev) => {
        if (prev.size === 0) return prev
        const alive = new Set(result.entries.map((e) => e.uid))
        const next = new Set<string>()
        for (const uid of prev) if (alive.has(uid)) next.add(uid)
        return next.size === prev.size ? prev : next
      })
    }

    const summary = await vaultApi.call('diagnostic_log_stats', {})
    if (summary.ok && seq === requestSeq.current) setStats(summary.stats)
  }, [debouncedSearch, levelFilter, moduleFilter, range])

  useEffect(() => {
    void refresh()
  }, [refresh])

  async function toggle(next: boolean) {
    setBusy(true)
    try {
      const res = await vaultApi.call('diagnostic_log_set_enabled', { enabled: next })
      if (res.ok) {
        setEnabled(res.enabled)
        toast.success(next ? t('diagLogOnToast') : t('diagLogOffToast'))
      }
    } finally {
      setBusy(false)
    }
  }

  const allSelected = entries.length > 0 && selected.size === entries.length

  function toggleAll(checked: boolean) {
    setSelected(checked ? new Set(entries.map((e) => e.uid)) : new Set())
  }

  function toggleOne(uid: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(uid)) next.delete(uid)
      else next.add(uid)
      return next
    })
  }

  function toggleExpanded(uid: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(uid)) next.delete(uid)
      else next.add(uid)
      return next
    })
  }

  function toggleLevel(level: DiagnosticLevel) {
    setLevelFilter((prev) => {
      const next = new Set(prev)
      if (next.has(level)) next.delete(level)
      else next.add(level)
      return next
    })
  }

  /** 按 uid 删除选中的日志条目。 */
  async function deleteSelected() {
    if (selected.size === 0) return
    setBusy(true)
    try {
      const res = await vaultApi.call('diagnostic_log_delete', { uids: [...selected] })
      if (res.ok) {
        toast.success(t('diagLogDeletedToast', { count: res.removed }))
        setSelected(new Set())
        await refresh()
      }
    } finally {
      setBusy(false)
    }
  }

  async function clearAll() {
    setBusy(true)
    try {
      const res = await vaultApi.call('diagnostic_log_clear', {})
      if (res.ok) {
        setEntries([])
        setSelected(new Set())
        setStats(EMPTY_STATS)
        toast.success(t('diagLogClearedToast', { count: res.removed }))
      }
    } finally {
      setBusy(false)
    }
  }

  /** 生成排查报告并复制到剪贴板。不落盘：这份东西的用途就是贴给别人看，
   *  存成文件还得告诉用户去哪儿找它，中间每一步都会劝退。 */
  async function copyReport() {
    setBusy(true)
    try {
      const res = await vaultApi.call('diagnostic_log_export', {})
      if (!res.ok) return
      // 「复制报告无效」卡在写剪贴板：copyText 走主进程原生剪贴板，不受网页权限和焦点限制；仍按返回值判
      // 断，失败要提示。
      if (!(await copyText(res.report))) {
        toast.error(t('diagLogReportFailedToast'))
        return
      }
      toast.success(t('diagLogReportCopiedToast'))
    } catch {
      toast.error(t('diagLogReportFailedToast'))
    } finally {
      setBusy(false)
    }
  }

  const filtersActive =
    levelFilter.size > 0 || moduleFilter !== 'all' || range !== 'all' || debouncedSearch.length > 0

  const isPage = variant === 'page'

  const lastSeen = useMemo(() => {
    if (!stats.last_ts) return ''
    return new Date(stats.last_ts * 1000).toLocaleString()
  }, [stats.last_ts])

  return (
    <div className={isPage ? 'space-y-3' : 'space-y-3 rounded border p-3'}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">{t('diagLogTitle')}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                aria-label={t('diagLogRefresh')}
                onClick={() => void refresh()}
              >
                <RefreshCw className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('diagLogRefresh')}</TooltipContent>
          </Tooltip>
          <Checkbox
            checked={enabled}
            onCheckedChange={(v) => toggle(v === true)}
            disabled={busy}
            aria-label={t('diagLogTitle')}
          />
        </div>
      </div>

      {/* 概览。一屏几百行谁也读不完，"跨设备模块报了 214 次超时"才指得出问题在哪。
          级别徽章同时是筛选开关——看到"错误 12"的第一反应就是想点它。 */}
      <div className="flex flex-wrap items-center gap-2">
        {LEVELS.map((level) => {
          const LevelIcon = LEVEL_META[level].icon
          const on = levelFilter.has(level)
          return (
            <Button
              key={level}
              size="sm"
              variant={on ? 'default' : 'outline'}
              aria-pressed={on}
              onClick={() => toggleLevel(level)}
            >
              <LevelIcon className="mr-1.5 h-3.5 w-3.5" />
              {t(`diagLogLevel_${level}`)}
              <span className="ml-1.5 tabular">{stats.by_level[level] ?? 0}</span>
            </Button>
          )
        })}
        {stats.lines > 0 && (
          <span className="text-sm text-muted-foreground">
            {t('diagLogLastSeen', { at: lastSeen })}
          </span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[12rem] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('diagLogSearchPlaceholder')}
            aria-label={t('diagLogSearchPlaceholder')}
            className="pl-8"
          />
        </div>
        <Select value={moduleFilter} onValueChange={setModuleFilter}>
          <SelectTrigger className="w-40" aria-label={t('diagLogModuleLabel')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="max-h-64">
            <SelectItem value="all">{t('diagLogModuleAll')}</SelectItem>
            {modules.map((m) => (
              <SelectItem key={m} value={m}>
                {m}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={range} onValueChange={setRange}>
          <SelectTrigger className="w-32" aria-label={t('diagLogRangeLabel')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {RANGES.map((r) => (
              <SelectItem key={r.id} value={r.id}>
                {t(`diagLogRange_${r.id}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="sm" variant="outline" disabled={busy || stats.lines === 0} onClick={copyReport}>
              <ClipboardCopy className="mr-1.5 h-4 w-4" />
              {t('diagLogCopyReport')}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t('diagLogCopyReportHint')}</TooltipContent>
        </Tooltip>
      </div>

      {/* 最常出现的几条。哪怕一条条日志都读不下去，这一块也能给出方向。 */}
      {stats.top_problems.length > 1 && (
        <div className="space-y-1 rounded border bg-muted/30 p-2.5">
          <p className="text-sm font-medium">{t('diagLogTopProblems')}</p>
          {stats.top_problems.slice(0, 4).map((row) => (
            <button
              key={`${row.module}-${row.problem}`}
              type="button"
              className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-sm hover:bg-muted"
              onClick={() => {
                // 点一下直接筛成这个模块——"有 214 次超时"却不告诉你是哪些，
                // 等于这个数字只做完了一半的事。
                setModuleFilter(row.module)
                setRange('all')
              }}
            >
              <span className="tabular w-12 shrink-0 text-muted-foreground">×{row.count}</span>
              <span className="shrink-0 font-medium">[{row.module}]</span>
              <span className="min-w-0 flex-1 truncate">{row.problem}</span>
            </button>
          ))}
        </div>
      )}

      {entries.length === 0 ? (
        <div className="space-y-1 rounded border border-dashed p-4 text-sm text-muted-foreground">
          {/* 空列表分三种，原因完全不同，糊成一句"暂无记录"用户就只能猜。 */}
          {!enabled ? (
            <p>{t('diagLogEmptyOff')}</p>
          ) : filtersActive ? (
            <>
              <p>{t('diagLogEmptyFiltered')}</p>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setLevelFilter(new Set())
                  setModuleFilter('all')
                  setRange('all')
                  setSearch('')
                }}
              >
                {t('diagLogClearFilters')}
              </Button>
            </>
          ) : (
            <p>{t('diagLogEmptyOn')}</p>
          )}
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <Checkbox
                checked={allSelected}
                onCheckedChange={(v) => toggleAll(v === true)}
                aria-label={t('diagLogSelectAll')}
              />
              <span>{t('diagLogSelectAll')}</span>
              <span className="text-muted-foreground">
                {t('diagLogSelectedCount', { count: selected.size, total: entries.length })}
              </span>
              {truncated && (
                <span className="text-muted-foreground">
                  {t('diagLogTruncated', { shown: entries.length, matched })}
                </span>
              )}
            </label>
            <div className="flex items-center gap-2">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={deleteSelected}
                    disabled={busy || selected.size === 0}
                    aria-label={t('diagLogDeleteSelected')}
                  >
                    <Trash2 className="mr-1.5 h-4 w-4" />
                    {t('diagLogDeleteSelected')}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('diagLogDeleteSelectedHint')}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={clearAll}
                    disabled={busy || stats.lines === 0}
                    aria-label={t('diagLogClear')}
                  >
                    {t('diagLogClear')}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('diagLogClearHint')}</TooltipContent>
              </Tooltip>
            </div>
          </div>

          <div
            className={`${isPage ? 'h-[calc(100vh-28rem)] min-h-[20rem]' : 'h-72'} space-y-1 overflow-y-auto rounded border bg-muted/30 p-2 text-sm`}
            style={{ fontFamily: LOG_FONT }}
          >
            {entries.map((entry) => {
              const meta = LEVEL_META[entry.level] ?? LEVEL_META.error
              const isOpen = expanded.has(entry.uid)
              return (
                <div key={entry.uid} className="rounded px-1 py-0.5 hover:bg-muted">
                  <div className="flex items-start gap-2">
                    <Checkbox
                      checked={selected.has(entry.uid)}
                      onCheckedChange={() => toggleOne(entry.uid)}
                      aria-label={entry.problem}
                      className="mt-0.5"
                    />
                    <button
                      type="button"
                      className="min-w-0 flex-1 text-left"
                      onClick={() => toggleExpanded(entry.uid)}
                      aria-expanded={isOpen}
                    >
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <Badge tone={meta.tone} icon={meta.icon}>
                          {t(`diagLogLevel_${entry.level}`)}
                        </Badge>
                        <span className="tabular text-muted-foreground">{entry.at}</span>
                        <span className="font-medium">[{entry.module}]</span>
                        <span className="min-w-0 break-words">{entry.problem}</span>
                        {entry.code ? (
                          <span className="text-muted-foreground">({entry.code})</span>
                        ) : null}
                        {/* 折叠计数。同一条连着刷屏时不占几十行，但"发生了多少次"
                            恰恰是判断严重程度最直接的信号，不能丢。 */}
                        {entry.count > 1 && (
                          <Badge tone="warning">
                            <span className="tabular">×{entry.count}</span>
                          </Badge>
                        )}
                      </span>
                      {entry.detail && isOpen && (
                        <span className="mt-1 block break-all rounded bg-background/60 p-1.5 text-muted-foreground">
                          {entry.detail}
                        </span>
                      )}
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
