import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { ExternalLink, History, Layers, RotateCcw, Undo2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/page'
import { cn } from '@/lib/utils'
import { vaultApi } from '@/lib/vaultApi'
import { translateError } from '@/i18n/errors'
import { collapseUnchanged, diffLines } from '@/lib/textDiff'
import type { Note, NoteRevision, NoteRevisionKind, NoteRevisionWithContent } from '@/shared/ipcTypes'

/**
 * 笔记修改时间线：左为按天分组的记录（新的在前），右为选中版本内容、与上一版/当前版的逐行对比及「
 * 恢复到此版本」。当前笔记（note_revision_list）与选中几篇/全部（note_timeline）共用；多篇时每行带
 * 笔记标题，已删除的标出。同一次批量操作的记录共用 batch_id，相邻画成一组，组头给「整批撤销」。/
 */

export type NoteTimelineTarget =
  | { kind: 'note'; noteId: number; title: string }
  | { kind: 'notes'; noteIds: number[] }
  | { kind: 'all' }

type TimelineRow = NoteRevision & { note_title?: string; note_deleted?: boolean }

type CompareMode = 'content' | 'prev' | 'current'

/** 对比时拿到的另一边：正文，或者一个说明为什么没法比的文案键。 */
type CompareSide = { text: string } | { unavailable: string }

const KIND_TONE: Record<NoteRevisionKind, string> = {
  baseline: 'bg-muted text-muted-foreground',
  create: 'bg-success/15 text-success',
  edit: 'bg-accent-soft text-primary',
  metadata: 'bg-accent-soft text-primary',
  bulk_edit: 'bg-warning/15 text-warning',
  bulk_category: 'bg-warning/15 text-warning',
  restore: 'bg-success/15 text-success',
  merge: 'bg-warning/15 text-warning',
  undo: 'bg-muted text-muted-foreground',
}

function dayKey(stamp: string): string {
  return stamp.slice(0, 10)
}

function dayLabel(key: string): string {
  const [y, m, d] = key.split('-').map(Number)
  if (!y || !m || !d) return key
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' })
}

function timeLabel(stamp: string): string {
  return stamp.slice(11, 16)
}

export function NoteTimelineDialog({
  target,
  onClose,
  beforeMutate,
  loadCurrentContent,
  onRestored,
  onBatchUndone,
  onOpenNote,
}: {
  /** null = 关闭。 */
  target: NoteTimelineTarget | null
  onClose: () => void
  // 恢复 / 撤销之前调用：正在编辑的笔记有未保存改动时先存盘。返回 false 就中止。
  beforeMutate: () => Promise<boolean>
  // 读一篇笔记现在的正文（对比用）；太大或读不到返回 null。
  loadCurrentContent: (noteId: number) => Promise<string | null>
  onRestored: (note: Note) => void
  onBatchUndone: () => void
  onOpenNote?: (noteId: number) => void
}) {
  const { t } = useTranslation('notes')
  const [rows, setRows] = useState<TimelineRow[]>([])
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [revision, setRevision] = useState<NoteRevisionWithContent | null>(null)
  const [revisionLoading, setRevisionLoading] = useState(false)
  const [mode, setMode] = useState<CompareMode>('content')
  const [compare, setCompare] = useState<CompareSide | null>(null)
  const [compareLoading, setCompareLoading] = useState(false)
  const [confirming, setConfirming] = useState<{ kind: 'restore' } | { kind: 'batch'; batchId: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const multi = target !== null && target.kind !== 'note'

  const load = useCallback(async () => {
    if (!target) return
    setLoading(true)
    setLoadError(null)
    try {
      if (target.kind === 'note') {
        const res = await vaultApi.call('note_revision_list', { note_id: target.noteId, limit: 200 })
        if (!res.ok) {
          setLoadError(translateError(res.error, res.error_params))
          setRows([])
          return
        }
        setRows(res.revisions)
      } else {
        const res = await vaultApi.call('note_timeline', {
          note_ids: target.kind === 'notes' ? target.noteIds : undefined,
          limit: 300,
        })
        setRows(res.entries)
      }
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error))
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [target])

  // 打开（或换一个目标）时重新拉一遍，并把右栏清空。
  useEffect(() => {
    setSelectedId(null)
    setRevision(null)
    setMode('content')
    setCompare(null)
    setConfirming(null)
    if (target) void load()
  }, [target, load])

  // 默认选中最新一条：打开时间线最常见的问题是"刚才改了什么"。
  useEffect(() => {
    if (selectedId === null && rows.length > 0) setSelectedId(rows[0].id)
  }, [rows, selectedId])

  const selected = useMemo(() => rows.find((r) => r.id === selectedId) ?? null, [rows, selectedId])

  useEffect(() => {
    if (selectedId === null) {
      setRevision(null)
      return
    }
    let cancelled = false
    setRevisionLoading(true)
    setConfirming(null)
    vaultApi
      .call('note_revision_get', { revision_id: selectedId })
      .then((res) => {
        if (cancelled) return
        if (!res.ok) {
          toast.error(t('timelineLoadFailed'), { description: translateError(res.error, res.error_params) })
          setRevision(null)
          return
        }
        setRevision(res.revision)
      })
      .catch(() => {
        if (!cancelled) setRevision(null)
      })
      .finally(() => {
        if (!cancelled) setRevisionLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [selectedId, t])

  /** 同一篇笔记里紧挨在这一条之前的那一版；列表里没有（多篇时间线被 limit 截断）就单独查一次。 */
  const findPrevious = useCallback(
    async (row: TimelineRow): Promise<NoteRevision | null> => {
      const index = rows.findIndex((r) => r.id === row.id)
      const inList = rows.slice(index + 1).find((r) => r.note_id === row.note_id)
      if (inList) return inList
      const res = await vaultApi.call('note_revision_list', { note_id: row.note_id, limit: 200 })
      if (!res.ok) return null
      return res.revisions.find((r) => r.id < row.id) ?? null
    },
    [rows],
  )

  useEffect(() => {
    if (mode === 'content' || !selected || !revision) {
      setCompare(null)
      return
    }
    let cancelled = false
    setCompareLoading(true)
    ;(async (): Promise<CompareSide> => {
      if (mode === 'current') {
        const text = await loadCurrentContent(selected.note_id)
        return text === null ? { unavailable: 'timelineCurrentUnavailable' } : { text }
      }
      const prev = await findPrevious(selected)
      if (!prev) return { unavailable: 'timelineNoPrevious' }
      if (!prev.has_content) return { unavailable: 'timelineNoSnapshot' }
      const res = await vaultApi.call('note_revision_get', { revision_id: prev.id })
      if (!res.ok || res.revision.content === null) return { unavailable: 'timelineNoSnapshot' }
      return { text: res.revision.content }
    })()
      .then((side) => {
        if (!cancelled) setCompare(side)
      })
      .catch(() => {
        if (!cancelled) setCompare({ unavailable: 'timelineLoadFailed' })
      })
      .finally(() => {
        if (!cancelled) setCompareLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [mode, selected, revision, findPrevious, loadCurrentContent])

  const diff = useMemo(() => {
    if (!compare || !('text' in compare) || revision?.content == null) return null
    // 两个方向都按时间先后读：上一版 → 这一版、这一版 → 现在。
    const result = mode === 'prev' ? diffLines(compare.text, revision.content) : diffLines(revision.content, compare.text)
    return { ...result, rows: collapseUnchanged(result.lines) }
  }, [compare, revision, mode])

  // 相邻、同一个 batch_id 的记录画成一组；再按天分段。
  const sections = useMemo(() => {
    type Block = { batchId: string | null; rows: TimelineRow[] }
    const days: Array<{ key: string; blocks: Block[] }> = []
    for (const row of rows) {
      const key = dayKey(row.created_at)
      let day = days[days.length - 1]
      if (!day || day.key !== key) {
        day = { key, blocks: [] }
        days.push(day)
      }
      const last = day.blocks[day.blocks.length - 1]
      if (row.batch_id && last && last.batchId === row.batch_id) last.rows.push(row)
      else day.blocks.push({ batchId: row.batch_id, rows: [row] })
    }
    return days
  }, [rows])

  async function handleRestore() {
    if (!selected) return
    setBusy(true)
    try {
      if (!(await beforeMutate())) return
      const res = await vaultApi.call('note_revision_restore', { revision_id: selected.id })
      if (!res.ok) {
        toast.error(t('timelineRestoreFailedToast'), { description: translateError(res.error, res.error_params) })
        return
      }
      toast.success(t('timelineRestoredToast', { time: `${dayLabel(dayKey(selected.created_at))} ${timeLabel(selected.created_at)}` }))
      setConfirming(null)
      onRestored(res.note)
      setSelectedId(null)
      await load()
    } finally {
      setBusy(false)
    }
  }

  async function handleBatchUndo(batchId: string) {
    setBusy(true)
    try {
      if (!(await beforeMutate())) return
      const res = await vaultApi.call('note_batch_undo', { batch_id: batchId })
      if (!res.ok) {
        toast.error(t('timelineBatchUndoFailedToast'), { description: translateError(res.error, res.error_params) })
        return
      }
      toast.success(t('timelineBatchUndoneToast', { count: res.restored_count }))
      setConfirming(null)
      onBatchUndone()
      setSelectedId(null)
      await load()
    } finally {
      setBusy(false)
    }
  }

  const title =
    target?.kind === 'note'
      ? t('timelineDialogTitleNote', { title: target.title || t('untitledNote') })
      : target?.kind === 'notes'
        ? t('timelineDialogTitleSelected', { count: target.noteIds.length })
        : t('timelineDialogTitleAll')

  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex h-[85vh] max-h-[85vh] flex-col gap-3 sm:max-w-6xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <History className="size-4 text-muted-foreground" aria-hidden="true" />
            {title}
          </DialogTitle>
          <DialogDescription>{t('timelineDialogDescription')}</DialogDescription>
        </DialogHeader>

        <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 md:grid-cols-[minmax(16rem,22rem)_1fr]">
          {/* 左：记录列表 */}
          <div className="min-h-0 overflow-y-auto rounded-lg border border-border/70">
            {loading && <p className="p-4 text-sm text-muted-foreground">{t('loading')}</p>}
            {!loading && loadError && (
              <div className="flex flex-col items-center gap-3 p-6">
                <p className="text-sm text-destructive">{t('timelineLoadFailed')}</p>
                <p className="text-sm text-muted-foreground">{loadError}</p>
                <Button size="sm" variant="outline" onClick={() => void load()}>
                  {t('retryButton')}
                </Button>
              </div>
            )}
            {!loading && !loadError && rows.length === 0 && (
              <EmptyState icon={History} title={t('timelineEmpty')} className="m-3 border-0" />
            )}
            {!loading &&
              !loadError &&
              sections.map((day) => (
                <section key={day.key} className="pb-1">
                  <h3 className="sticky top-0 z-10 border-b border-border/70 bg-popover px-3 py-1.5 text-sm font-medium text-muted-foreground">
                    {dayLabel(day.key)}
                  </h3>
                  {day.blocks.map((block) => {
                    const rowsEl = block.rows.map((row) => (
                      <TimelineRowButton
                        key={row.id}
                        row={row}
                        multi={multi}
                        selected={row.id === selectedId}
                        onSelect={() => setSelectedId(row.id)}
                      />
                    ))
                    if (!block.batchId || block.rows.length < 2) return rowsEl
                    return (
                      <div key={`batch-${block.batchId}-${block.rows[0].id}`} className="mx-2 my-1.5 rounded-lg border border-warning/40 bg-warning/5">
                        <div className="flex items-center justify-between gap-2 border-b border-warning/30 px-2 py-1">
                          <span className="flex items-center gap-1.5 text-sm text-warning">
                            <Layers className="size-3.5" aria-hidden="true" />
                            {t('timelineBatchLabel', { count: block.rows.length })}
                          </span>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2"
                            disabled={busy}
                            onClick={() => setConfirming({ kind: 'batch', batchId: block.batchId as string })}
                          >
                            <Undo2 className="size-3.5" aria-hidden="true" />
                            {t('timelineBatchUndoButton')}
                          </Button>
                        </div>
                        {rowsEl}
                      </div>
                    )
                  })}
                </section>
              ))}
          </div>

          {/* 右：选中那一版 */}
          <div className="flex min-h-0 flex-col gap-2 rounded-lg border border-border/70 p-3">
            {!selected ? (
              <p className="m-auto text-sm text-muted-foreground">{t('timelineSelectHint')}</p>
            ) : (
              <>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 space-y-1">
                    <p className="truncate font-medium">{selected.title || t('untitledNote')}</p>
                    <p className="text-sm text-muted-foreground">
                      {t('timelineCategoryLabel')}：{selected.category || t('filterUncategorized')} ·{' '}
                      {t('timelineLengthLabel', { count: selected.content_length })}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {multi && onOpenNote && !selected.note_deleted && (
                      <Button size="sm" variant="ghost" onClick={() => onOpenNote(selected.note_id)}>
                        <ExternalLink className="size-4" aria-hidden="true" />
                        {t('timelineOpenNote')}
                      </Button>
                    )}
                    {selected.batch_id && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => setConfirming({ kind: 'batch', batchId: selected.batch_id as string })}
                      >
                        <Undo2 className="size-4" aria-hidden="true" />
                        {t('timelineBatchUndoButton')}
                      </Button>
                    )}
                    <Button size="sm" disabled={busy || revisionLoading} onClick={() => setConfirming({ kind: 'restore' })}>
                      <RotateCcw className="size-4" aria-hidden="true" />
                      {t('timelineRestoreButton')}
                    </Button>
                  </div>
                </div>

                {confirming && (
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
                    <span>
                      {confirming.kind === 'restore'
                        ? revision && !revision.has_content
                          ? t('timelineRestoreConfirmNoContent')
                          : t('timelineRestoreConfirm')
                        : t('timelineBatchUndoConfirm')}
                    </span>
                    <span className="flex gap-1.5">
                      <Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirming(null)}>
                        {t('cancelButton')}
                      </Button>
                      <Button
                        size="sm"
                        disabled={busy}
                        onClick={() =>
                          confirming.kind === 'restore' ? void handleRestore() : void handleBatchUndo(confirming.batchId)
                        }
                      >
                        {t('timelineConfirmButton')}
                      </Button>
                    </span>
                  </div>
                )}

                <div role="tablist" className="inline-flex w-fit rounded-lg border border-border/70 bg-surface/70 p-0.5">
                  {(['content', 'prev', 'current'] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      role="tab"
                      aria-selected={mode === m}
                      onClick={() => setMode(m)}
                      className={cn(
                        'rounded-md px-2.5 py-1 text-sm transition-colors',
                        mode === m ? 'bg-background font-medium text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                      )}
                    >
                      {t(m === 'content' ? 'timelineViewContent' : m === 'prev' ? 'timelineViewDiffPrev' : 'timelineViewDiffCurrent')}
                    </button>
                  ))}
                </div>

                <div className="min-h-0 flex-1 overflow-auto rounded-md border border-border/60 bg-background">
                  {revisionLoading ? (
                    <p className="p-3 text-sm text-muted-foreground">{t('timelineLoadingContent')}</p>
                  ) : !revision || revision.content === null ? (
                    <p className="p-3 text-sm text-muted-foreground">{t('timelineNoSnapshot')}</p>
                  ) : mode === 'content' ? (
                    <pre className="p-3 text-sm break-words whitespace-pre-wrap">{revision.content}</pre>
                  ) : compareLoading || !compare ? (
                    <p className="p-3 text-sm text-muted-foreground">{t('timelineLoadingContent')}</p>
                  ) : 'unavailable' in compare ? (
                    <p className="p-3 text-sm text-muted-foreground">{t(compare.unavailable)}</p>
                  ) : diff && diff.added + diff.removed === 0 ? (
                    <p className="p-3 text-sm text-muted-foreground">{t('timelineDiffIdentical')}</p>
                  ) : diff ? (
                    <DiffView diff={diff} />
                  ) : null}
                </div>
              </>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function TimelineRowButton({
  row,
  multi,
  selected,
  onSelect,
}: {
  row: TimelineRow
  multi: boolean
  selected: boolean
  onSelect: () => void
}) {
  const { t } = useTranslation('notes')
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected}
      className={cn(
        'flex w-full flex-col gap-0.5 px-3 py-2 text-left text-sm transition-colors hover:bg-muted/60',
        selected && 'bg-accent-soft hover:bg-accent-soft',
      )}
    >
      <span className="flex items-center gap-2">
        <span className="tabular text-muted-foreground">{timeLabel(row.created_at)}</span>
        <span className={cn('rounded px-1.5 text-2xs font-medium', KIND_TONE[row.kind] ?? KIND_TONE.edit)}>
          {t(`timelineKind.${row.kind}`)}
        </span>
        {multi && row.note_deleted && (
          <span className="rounded bg-destructive/10 px-1.5 text-2xs text-destructive">{t('timelineNoteDeletedBadge')}</span>
        )}
      </span>
      {multi && <span className="truncate font-medium">{row.note_title || row.title || t('untitledNote')}</span>}
      {(row.summary || !multi) && (
        <span className="line-clamp-2 break-words text-muted-foreground">{row.summary || row.title || t('untitledNote')}</span>
      )}
    </button>
  )
}

function DiffView({
  diff,
}: {
  diff: { added: number; removed: number; approximate: boolean; rows: ReturnType<typeof collapseUnchanged> }
}) {
  const { t } = useTranslation('notes')
  return (
    <div className="text-sm">
      <div className="sticky top-0 flex flex-wrap items-center gap-3 border-b border-border/60 bg-background px-3 py-1.5 text-muted-foreground">
        <span>
          <span className="text-success">+{diff.added}</span> / <span className="text-destructive">−{diff.removed}</span>
        </span>
        {diff.approximate && <span>{t('timelineDiffApproximate')}</span>}
      </div>
      {diff.rows.map((row, index) =>
        row.kind === 'skip' ? (
          <p key={`skip-${index}`} className="bg-muted/40 px-3 py-0.5 text-center text-muted-foreground">
            {t('timelineDiffSkipped', { count: row.count })}
          </p>
        ) : (
          <div
            key={`${row.kind}-${row.oldNo ?? ''}-${row.newNo ?? ''}-${index}`}
            className={cn(
              'grid grid-cols-[3rem_3rem_1.25rem_1fr] gap-x-1 px-1',
              row.kind === 'add' && 'bg-success/10',
              row.kind === 'del' && 'bg-destructive/10',
            )}
          >
            <span className="tabular text-right text-muted-foreground/70 select-none">{row.oldNo ?? ''}</span>
            <span className="tabular text-right text-muted-foreground/70 select-none">{row.newNo ?? ''}</span>
            <span
              className={cn(
                'text-center select-none',
                row.kind === 'add' && 'text-success',
                row.kind === 'del' && 'text-destructive',
              )}
            >
              {row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : ''}
            </span>
            <span className="break-words whitespace-pre-wrap">{row.text || ' '}</span>
          </div>
        ),
      )}
    </div>
  )
}
