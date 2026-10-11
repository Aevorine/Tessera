import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { AlertTriangle, Eye, EyeOff, History, RotateCcw, Undo2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Badge, DetailRow, EmptyState, type Tone } from '@/components/ui/page'
import { cn } from '@/lib/utils'
import { vaultApi } from '@/lib/vaultApi'
import { translateError } from '@/i18n/errors'
import { diffRevision, groupTimeline, type RevisionDiff } from '@/lib/recovery/revisions'
import type {
  RecoveryCodeGroup,
  RecoveryCodeRevisionAction,
  RecoveryCodeTimelineEntry,
  RevealedRecoveryCode,
} from '@/shared/ipcTypes'

/**
 * 恢复码的修改时间线：左按天列出改动，右看选中版本全文、与现在的差异并可一键回到该版。
 * 快照里的码是打码的，看明文走 recovery_codes_revision_reveal，过与「显示明文」同一道重新验证。
 * 明文只放在弹窗内存里，换记录、关闭或 60 秒无操作即丢弃。
 */

export interface TimelineScope {
  /** 省略 = 全部服务。 */
  ids?: string[]
  title: string
}

type ReverifyRunner = (action: () => void | Promise<void>) => void

const TIMELINE_LIMIT = 500
const REVEAL_AUTO_HIDE_MS = 60_000

const ACTION_TONE: Record<RecoveryCodeRevisionAction, Tone> = {
  baseline: 'neutral',
  import: 'info',
  update: 'accent',
  mark_used: 'warning',
  bulk_meta: 'accent',
  restore: 'success',
  merge: 'info',
  backup_restore: 'info',
  undo: 'neutral',
}

function ActionBadge({ action }: { action: RecoveryCodeRevisionAction }) {
  const { t } = useTranslation('recoveryCodes')
  return (
    <Badge tone={ACTION_TONE[action] ?? 'neutral'}>
      {t(`timelineAction_${action}` as 'timelineAction_update', { defaultValue: action })}
    </Badge>
  )
}

function formatTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

function formatDay(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'short',
  })
}

function formatFull(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

interface RevealState {
  revisionId: string
  then: RevealedRecoveryCode[]
  /** 现在这一组的明文；组已被删除、或者读不到时为 null（对比退回按序号比）。 */
  now: RevealedRecoveryCode[] | null
}

export function RecoveryTimelineDialog({
  scope,
  onClose,
  groups,
  requireReverify,
  forceReverify,
  onChanged,
}: {
  scope: TimelineScope | null
  onClose: () => void
  /** 当前的全部服务，给「与当前对比」用。 */
  groups: RecoveryCodeGroup[]
  /** 按设置决定要不要先验证（跟「显示明文」同一个入口）。 */
  requireReverify: ReverifyRunner
  /** 无论设置如何都先验证一次——后端回了 verify_required 时用。 */
  forceReverify: ReverifyRunner
  /** 恢复 / 整批撤销之后让页面重新拉列表。 */
  onChanged: () => void | Promise<void>
}) {
  return (
    <Dialog open={scope !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex h-[85vh] max-h-[85vh] flex-col gap-3 sm:max-w-6xl">
        {scope && (
          <TimelineBody
            scope={scope}
            groups={groups}
            requireReverify={requireReverify}
            forceReverify={forceReverify}
            onChanged={onChanged}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function TimelineBody({
  scope,
  groups,
  requireReverify,
  forceReverify,
  onChanged,
}: {
  scope: TimelineScope
  groups: RecoveryCodeGroup[]
  requireReverify: ReverifyRunner
  forceReverify: ReverifyRunner
  onChanged: () => void | Promise<void>
}) {
  const { t } = useTranslation('recoveryCodes')
  const [entries, setEntries] = useState<RecoveryCodeTimelineEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [revealed, setRevealed] = useState<RevealState | null>(null)
  const [confirmRestore, setConfirmRestore] = useState(false)
  const [busy, setBusy] = useState(false)
  const [tab, setTab] = useState<'content' | 'compare'>('content')
  // 明文请求是异步的，回来时用户可能已经点到别的记录上了——那时这份明文不该
  // 再挂到新选中的那一条上，直接扔掉。
  const selectedRef = useRef<string | null>(null)
  useEffect(() => {
    selectedRef.current = selectedId
  }, [selectedId])

  const ids = scope.ids
  const load = useCallback(
    async (prefer?: string | null) => {
      setLoading(true)
      setLoadError(null)
      try {
        const res = await vaultApi.call('recovery_codes_timeline', { ...(ids ? { ids } : {}), limit: TIMELINE_LIMIT })
        const list = res.entries ?? []
        setEntries(list)
        setSelectedId((prev) => {
          const want = prefer !== undefined ? prefer : prev
          return want && list.some((e) => e.id === want) ? want : (list[0]?.id ?? null)
        })
      } catch (error) {
        setLoadError(error instanceof Error ? error.message : String(error))
      } finally {
        setLoading(false)
      }
    },
    [ids],
  )

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!revealed) return
    const timer = setTimeout(() => setRevealed(null), REVEAL_AUTO_HIDE_MS)
    return () => clearTimeout(timer)
  }, [revealed])

  const days = useMemo(() => groupTimeline(entries), [entries])
  const selected = entries.find((e) => e.id === selectedId) ?? null
  const shownReveal = revealed && selected && revealed.revisionId === selected.id ? revealed : null
  const current = selected ? (groups.find((g) => g.id === selected.group_id) ?? null) : null

  function select(id: string) {
    if (id === selectedId) return
    setSelectedId(id)
    setRevealed(null)
    setConfirmRestore(false)
  }

  function handleReveal(entry: RecoveryCodeTimelineEntry) {
    const attempt = async (mayRetry: boolean) => {
      const res = await vaultApi.call('recovery_codes_revision_reveal', { id: entry.group_id, revision_id: entry.id })
      if (!res.ok) {
        // 设置里关掉了「显示明文需要验证」时 requireReverify 会直接放行，但后端
        // 那边的验证窗口可能早就过了——那就补一次验证再试，只试这一次。
        if (res.error === 'recovery_codes.verify_required' && mayRetry) {
          forceReverify(() => attempt(false))
          return
        }
        toast.error(t('revealFailedToast'), { description: translateError(res.error, res.error_params) })
        return
      }
      let now: RevealedRecoveryCode[] | null = null
      if (entry.group_exists) {
        const cur = await vaultApi.call('recovery_codes_reveal', { id: entry.group_id, verified: true })
        if (cur.ok) now = cur.codes
      }
      if (selectedRef.current !== entry.id) return
      setRevealed({ revisionId: entry.id, then: res.codes, now })
    }
    requireReverify(() => attempt(true))
  }

  async function handleRestore(entry: RecoveryCodeTimelineEntry) {
    setBusy(true)
    try {
      const res = await vaultApi.call('recovery_codes_revision_restore', { id: entry.group_id, revision_id: entry.id })
      if (!res.ok) {
        toast.error(t('timelineRestoreFailedToast'), { description: translateError(res.error, res.error_params) })
        return
      }
      setConfirmRestore(false)
      setRevealed(null)
      toast.success(t('timelineRestoredToast', { service: res.group.service }))
      await onChanged()
      // 恢复本身会在时间线最上面落一条 'restore'，选中它：用户刚做的事就在眼前。
      await load(null)
    } finally {
      setBusy(false)
    }
  }

  async function handleUndoBatch(batchId: string) {
    setBusy(true)
    try {
      const res = await vaultApi.call('recovery_codes_batch_undo', { batch_id: batchId })
      if (!res.ok) {
        toast.error(t('timelineBatchUndoFailedToast'), { description: translateError(res.error, res.error_params) })
        return
      }
      setRevealed(null)
      toast.success(t('timelineBatchUndoneToast', { count: res.restored_count }))
      await onChanged()
      await load(null)
    } finally {
      setBusy(false)
    }
  }

  const diff: RevisionDiff | null =
    selected && current
      ? diffRevision(
          {
            service: selected.service,
            account_label: selected.account_label,
            note: selected.note,
            codes: selected.codes,
            revealed: shownReveal?.then ?? null,
          },
          {
            service: current.service,
            account_label: current.accountLabel,
            note: current.note,
            codes: current.codes,
            revealed: shownReveal?.now ?? null,
          },
        )
      : null

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <History className="size-4 text-muted-foreground" aria-hidden="true" />
          {scope.title}
        </DialogTitle>
        <DialogDescription>{t('timelineDialogDescription')}</DialogDescription>
      </DialogHeader>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 md:grid-cols-[22rem_minmax(0,1fr)]">
        {/* 左：按天分组的记录 */}
        <div className="min-h-0 overflow-y-auto rounded-lg border border-border/70 bg-surface/60 p-2">
          {loading && !loadError && entries.length === 0 && <p className="p-4 text-sm text-muted-foreground">{t('timelineLoading')}</p>}
          {!loading && loadError && (
            <div className="flex flex-col items-center gap-3 p-6 text-center">
              <p className="text-sm text-destructive">{t('timelineLoadFailed', { reason: loadError })}</p>
              <Button size="sm" variant="outline" onClick={() => void load()}>
                {t('retryButton')}
              </Button>
            </div>
          )}
          {!loading && !loadError && entries.length === 0 && (
            <p className="p-4 text-sm leading-relaxed text-muted-foreground">{t('timelineEmpty')}</p>
          )}
          {days.map((day) => (
            <section key={day.day} className="mb-3 last:mb-0">
              <h3 className="sticky top-0 z-10 bg-surface/95 px-2 py-1.5 text-sm font-medium text-muted-foreground backdrop-blur">
                {formatDay(day.timestamp)}
              </h3>
              <ul className="space-y-1">
                {day.items.map((item) =>
                  item.kind === 'single' ? (
                    <li key={item.entry.id}>
                      <EntryRow
                        entry={item.entry}
                        selected={item.entry.id === selectedId}
                        showService={scope.ids?.length !== 1}
                        onSelect={() => select(item.entry.id)}
                      />
                    </li>
                  ) : (
                    <li key={item.batchId} className="rounded-lg border border-accent-line/60 bg-accent-soft/40 p-1.5">
                      <div className="flex items-center justify-between gap-2 px-1.5 pb-1.5">
                        <span className="flex min-w-0 items-center gap-2">
                          <ActionBadge action={item.entries[0].action} />
                          <span className="truncate text-sm text-muted-foreground">
                            {t('timelineBatchLabel', { count: item.entries.length })}
                          </span>
                        </span>
                        <Button
                          size="xs"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => void handleUndoBatch(item.batchId)}
                        >
                          <Undo2 className="size-3.5" aria-hidden="true" />
                          {t('timelineUndoBatchButton')}
                        </Button>
                      </div>
                      <ul className="space-y-1">
                        {item.entries.map((entry) => (
                          <li key={entry.id}>
                            <EntryRow
                              entry={entry}
                              selected={entry.id === selectedId}
                              showService
                              hideBadge
                              onSelect={() => select(entry.id)}
                            />
                          </li>
                        ))}
                      </ul>
                    </li>
                  ),
                )}
              </ul>
            </section>
          ))}
        </div>

        {/* 右：选中那一版 */}
        <div className="min-h-0 overflow-y-auto rounded-lg border border-border/70 p-4">
          {!selected ? (
            <EmptyState icon={History} title={t('timelineSelectHint')} className="h-full" />
          ) : (
            <div className="space-y-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-heading text-sihao font-medium break-all">{selected.service || '—'}</span>
                    <ActionBadge action={selected.action} />
                    {!selected.group_exists && <Badge tone="danger">{t('timelineDeletedBadge')}</Badge>}
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {formatFull(selected.timestamp)}
                    {selected.summary && <> · {selected.summary}</>}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {shownReveal ? (
                    <Button size="sm" variant="outline" onClick={() => setRevealed(null)}>
                      <EyeOff className="size-4" aria-hidden="true" />
                      {t('hideButton')}
                    </Button>
                  ) : (
                    <Button size="sm" variant="outline" onClick={() => handleReveal(selected)}>
                      <Eye className="size-4" aria-hidden="true" />
                      {t('revealButton')}
                    </Button>
                  )}
                  <Button size="sm" disabled={busy} onClick={() => setConfirmRestore(true)}>
                    <RotateCcw className="size-4" aria-hidden="true" />
                    {t('timelineRestoreButton')}
                  </Button>
                </div>
              </div>

              {confirmRestore && (
                <div className="space-y-3 rounded-lg border border-warning/40 bg-warning/10 p-3.5">
                  <p className="flex items-start gap-2 text-sm font-medium">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
                    {t('timelineRestoreConfirmTitle', { service: selected.service })}
                  </p>
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    {selected.group_exists ? t('timelineRestoreConfirmBody') : t('timelineRestoreDeletedBody')}
                  </p>
                  <div className="flex justify-end gap-2">
                    <Button size="sm" variant="outline" onClick={() => setConfirmRestore(false)}>
                      {t('importPreviewCancelButton')}
                    </Button>
                    <Button size="sm" disabled={busy} onClick={() => void handleRestore(selected)}>
                      {t('timelineRestoreConfirmButton')}
                    </Button>
                  </div>
                </div>
              )}

              <Tabs value={tab} onValueChange={(v) => setTab(v as 'content' | 'compare')}>
                <TabsList>
                  <TabsTrigger value="content">{t('timelineTabContent')}</TabsTrigger>
                  <TabsTrigger value="compare">{t('timelineTabCompare')}</TabsTrigger>
                </TabsList>

                <TabsContent value="content" className="space-y-4 pt-3">
                  <div className="divide-y divide-border/70">
                    <DetailRow label={t('serviceLabel')}>{selected.service || '—'}</DetailRow>
                    <DetailRow label={t('accountLabelLabel')}>{selected.account_label || '—'}</DetailRow>
                    <DetailRow label={t('noteLabel')}>
                      <span className="whitespace-pre-wrap">{selected.note || '—'}</span>
                    </DetailRow>
                    <DetailRow label={t('codesLabel')}>
                      {t('timelineCodesSummary', { count: selected.code_count, used: selected.used_count })}
                    </DetailRow>
                  </div>
                  <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
                    {selected.codes.map((c) => {
                      const plain = shownReveal?.then.find((r) => r.index === c.index)
                      return (
                        <li
                          key={c.index}
                          className={cn(
                            'flex items-center justify-between gap-2 rounded-md border border-border/70 bg-surface px-2.5 py-1.5',
                            c.used && 'opacity-60',
                          )}
                        >
                          <span className="flex min-w-0 items-center gap-2">
                            <span className="text-2xs tabular text-muted-foreground">#{c.index + 1}</span>
                            <span className={cn('truncate font-mono text-sm', c.used && 'line-through')}>
                              {plain ? plain.code : '•••••-•••••'}
                            </span>
                          </span>
                          {c.used && <span className="shrink-0 text-2xs text-muted-foreground">{t('usedBadge')}</span>}
                        </li>
                      )
                    })}
                  </ul>
                </TabsContent>

                <TabsContent value="compare" className="pt-3">
                  {!current || !diff ? (
                    <p className="text-sm text-muted-foreground">{t('compareGroupGone')}</p>
                  ) : (
                    <CompareView diff={diff} />
                  )}
                </TabsContent>
              </Tabs>
            </div>
          )}
        </div>
      </div>
    </>
  )
}

function EntryRow({
  entry,
  selected,
  showService,
  hideBadge = false,
  onSelect,
}: {
  entry: RecoveryCodeTimelineEntry
  selected: boolean
  showService: boolean
  hideBadge?: boolean
  onSelect: () => void
}) {
  const { t } = useTranslation('recoveryCodes')
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        'flex w-full flex-col gap-1 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-muted/70',
        selected && 'bg-muted ring-1 ring-border',
      )}
    >
      <span className="flex w-full items-center gap-2">
        <span className="shrink-0 text-sm tabular text-muted-foreground">{formatTime(entry.timestamp)}</span>
        {!hideBadge && <ActionBadge action={entry.action} />}
        {showService && (
          <span className="min-w-0 truncate text-sm font-medium">{entry.current_service || entry.service || '—'}</span>
        )}
        {!entry.group_exists && (
          <Badge tone="danger" className="ms-auto shrink-0">
            {t('timelineDeletedBadge')}
          </Badge>
        )}
      </span>
      {entry.summary && <span className="line-clamp-2 text-sm text-muted-foreground">{entry.summary}</span>}
    </button>
  )
}

function CompareView({ diff }: { diff: RevisionDiff }) {
  const { t } = useTranslation('recoveryCodes')
  if (diff.identical) return <p className="text-sm text-muted-foreground">{t('compareIdentical')}</p>

  const fieldLabel = (field: 'service' | 'account_label' | 'note') =>
    field === 'service' ? t('serviceLabel') : field === 'account_label' ? t('accountLabelLabel') : t('noteLabel')
  const showCodes = (list: string[] | number, byCode: boolean) => {
    if (typeof list === 'number') return t('compareCountValue', { count: list })
    if (list.length === 0) return t('compareCountValue', { count: 0 })
    return byCode ? list.join('  ') : list.join(', ')
  }
  const showPositions = (list: Array<string | number>) =>
    list.length === 0
      ? t('compareCountValue', { count: 0 })
      : list.map((v) => (typeof v === 'number' ? t('compareCodeIndex', { index: v }) : v)).join(diff.byCode ? '  ' : ', ')

  return (
    <div className="space-y-4">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border/70 text-left text-muted-foreground">
            <th className="py-1.5 pe-3 font-medium" />
            <th className="py-1.5 pe-3 font-medium">{t('compareThenLabel')}</th>
            <th className="py-1.5 font-medium">{t('compareNowLabel')}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/60">
          {diff.meta.map((m) => (
            <tr key={m.field}>
              <td className="py-1.5 pe-3 text-muted-foreground">{fieldLabel(m.field)}</td>
              <td className="py-1.5 pe-3 break-all text-destructive line-through decoration-destructive/40">
                {m.then || t('emptyValue')}
              </td>
              <td className="py-1.5 break-all text-success">{m.now || t('emptyValue')}</td>
            </tr>
          ))}
          <tr>
            <td className="py-1.5 pe-3 text-muted-foreground">{t('compareCodeCount')}</td>
            <td className="py-1.5 pe-3 tabular">{diff.countThen}</td>
            <td className={cn('py-1.5 tabular', diff.countNow !== diff.countThen && 'font-medium text-primary')}>
              {diff.countNow}
            </td>
          </tr>
          <tr>
            <td className="py-1.5 pe-3 text-muted-foreground">{t('compareUsedCount')}</td>
            <td className="py-1.5 pe-3 tabular">{diff.usedThen}</td>
            <td className={cn('py-1.5 tabular', diff.usedNow !== diff.usedThen && 'font-medium text-primary')}>
              {diff.usedNow}
            </td>
          </tr>
        </tbody>
      </table>

      <div className="grid gap-2 sm:grid-cols-2">
        <DiffBlock tone="success" label={t('compareAdded')} value={showCodes(diff.added, diff.byCode)} mono={diff.byCode} />
        <DiffBlock tone="danger" label={t('compareRemoved')} value={showCodes(diff.removed, diff.byCode)} mono={diff.byCode} />
        <DiffBlock tone="warning" label={t('compareNewlyUsed')} value={showPositions(diff.newlyUsed)} mono={diff.byCode} />
        <DiffBlock tone="info" label={t('compareNewlyUnused')} value={showPositions(diff.newlyUnused)} mono={diff.byCode} />
      </div>

      {!diff.byCode && <p className="text-sm leading-relaxed text-muted-foreground">{t('compareApproxHint')}</p>}
    </div>
  )
}

const DIFF_TONE: Record<'success' | 'danger' | 'warning' | 'info', string> = {
  success: 'border-success/30 bg-success/8',
  danger: 'border-destructive/30 bg-destructive/8',
  warning: 'border-warning/30 bg-warning/8',
  info: 'border-info/30 bg-info/8',
}

function DiffBlock({
  tone,
  label,
  value,
  mono,
}: {
  tone: keyof typeof DIFF_TONE
  label: string
  value: string
  mono: boolean
}) {
  return (
    <div className={cn('space-y-1 rounded-lg border px-3 py-2', DIFF_TONE[tone])}>
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className={cn('text-sm break-all', mono && 'font-mono')}>{value}</p>
    </div>
  )
}
