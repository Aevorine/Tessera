import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { CopyCheck, Pin, EyeOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/page'
import { cn } from '@/lib/utils'
import { vaultApi } from '@/lib/vaultApi'
import { translateError } from '@/i18n/errors'
import type { NoteCategoryScope, NoteDuplicateGroup } from '@/shared/ipcTypes'

/**
 * 笔记去重：列出正文相同的笔记，每组选一篇保留，其余移进回收站。默认保留最近修改的一篇（后端按
 * updated_at 倒序给）；移走的进回收站而非彻底删除，标签并到保留的那篇。/
 */
export function NoteDuplicatesDialog({
  scope,
  onClose,
  beforeMerge,
  onMerged,
}: {
  /** null = 关闭。 */
  scope: NoteCategoryScope | null
  onClose: () => void
  /** 合并之前调用：正在编辑的笔记有未保存改动时先存盘。返回 false 就中止。 */
  beforeMerge: () => Promise<boolean>
  onMerged: (result: { batchId: string; removedCount: number; removedIds: number[] }) => void
}) {
  const { t } = useTranslation('notes')
  const [groups, setGroups] = useState<NoteDuplicateGroup[]>([])
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  /** 组下标 → 保留哪一篇。 */
  const [keep, setKeep] = useState<Map<number, number>>(new Map())
  /** 用户取消勾选、这次不合并的组。 */
  const [skipped, setSkipped] = useState<Set<number>>(new Set())
  const [merging, setMerging] = useState(false)

  const scan = useCallback(async () => {
    if (!scope) return
    setLoading(true)
    setLoadError(null)
    try {
      const res = await vaultApi.call('note_duplicates_scan', { scope })
      setGroups(res.groups)
      setKeep(new Map(res.groups.map((group, index) => [index, group.notes[0]?.id ?? -1])))
      setSkipped(new Set())
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error))
      setGroups([])
    } finally {
      setLoading(false)
    }
  }, [scope])

  useEffect(() => {
    if (scope) void scan()
  }, [scope, scan])

  const plan = useMemo(
    () =>
      groups
        .map((group, index) => {
          const keepId = keep.get(index) ?? group.notes[0]?.id
          return { index, keep_id: keepId, remove_ids: group.notes.map((n) => n.id).filter((id) => id !== keepId) }
        })
        .filter((entry) => !skipped.has(entry.index) && entry.keep_id !== undefined && entry.remove_ids.length > 0),
    [groups, keep, skipped],
  )
  const removeCount = plan.reduce((sum, entry) => sum + entry.remove_ids.length, 0)

  async function handleMerge() {
    if (plan.length === 0) return
    setMerging(true)
    try {
      if (!(await beforeMerge())) return
      const res = await vaultApi.call('note_duplicates_merge', {
        groups: plan.map(({ keep_id, remove_ids }) => ({ keep_id: keep_id as number, remove_ids })),
      })
      if (!res.ok) {
        toast.error(t('dedupeMergeFailedToast'), { description: translateError(res.error, res.error_params) })
        return
      }
      onMerged({ batchId: res.batch_id, removedCount: res.removed_count, removedIds: plan.flatMap((entry) => entry.remove_ids) })
      onClose()
    } finally {
      setMerging(false)
    }
  }

  return (
    <Dialog open={scope !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CopyCheck className="size-4 text-muted-foreground" aria-hidden="true" />
            {t('dedupeDialogTitle')}
          </DialogTitle>
          <DialogDescription>{t('dedupeDialogDescription')}</DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
          {loading && <p className="text-sm text-muted-foreground">{t('dedupeScanning')}</p>}
          {!loading && loadError && (
            <div className="flex flex-col items-center gap-3 py-6">
              <p className="text-sm text-destructive">{t('dedupeScanFailed')}</p>
              <p className="text-sm text-muted-foreground">{loadError}</p>
              <Button size="sm" variant="outline" onClick={() => void scan()}>
                {t('retryButton')}
              </Button>
            </div>
          )}
          {!loading && !loadError && groups.length === 0 && <EmptyState icon={CopyCheck} title={t('dedupeNone')} />}
          {!loading &&
            !loadError &&
            groups.map((group, index) => {
              const included = !skipped.has(index)
              const keepId = keep.get(index)
              return (
                <section key={group.notes.map((n) => n.id).join('-')} className={cn('rounded-lg border border-border/70', !included && 'opacity-60')}>
                  <header className="flex items-center justify-between gap-2 border-b border-border/70 px-3 py-2">
                    <label className="flex items-center gap-2 text-sm font-medium">
                      <Checkbox
                        checked={included}
                        onCheckedChange={(v) =>
                          setSkipped((prev) => {
                            const next = new Set(prev)
                            if (v === true) next.delete(index)
                            else next.add(index)
                            return next
                          })
                        }
                      />
                      {t('dedupeGroupLabel', { index: index + 1, count: group.notes.length })}
                    </label>
                    <span className="rounded bg-muted px-1.5 text-2xs text-muted-foreground">{t(`dedupeReason.${group.reason}`)}</span>
                  </header>
                  <ul role="radiogroup" aria-label={t('dedupeKeepLabel')}>
                    {group.notes.map((note) => {
                      const kept = keepId === note.id
                      return (
                        <li key={note.id}>
                          <label
                            className={cn(
                              'flex cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-muted/50',
                              kept && 'bg-accent-soft/60',
                            )}
                          >
                            <input
                              type="radio"
                              name={`dedupe-keep-${index}`}
                              checked={kept}
                              disabled={!included}
                              onChange={() => setKeep((prev) => new Map(prev).set(index, note.id))}
                              className="size-4 accent-primary"
                            />
                            <span className="min-w-0 flex-1">
                              <span className="flex items-center gap-1.5">
                                <span className="truncate font-medium">{note.title || t('untitledNote')}</span>
                                {note.is_pinned ? <Pin className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" /> : null}
                                {note.is_hidden ? <EyeOff className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" /> : null}
                              </span>
                              <span className="block truncate text-muted-foreground">
                                {note.category || t('filterUncategorized')} · {t('timelineLengthLabel', { count: note.content_length })} ·{' '}
                                {t('dedupeUpdatedAt', { time: note.updated_at.replace('T', ' ').slice(0, 16) })}
                              </span>
                            </span>
                            <span
                              className={cn(
                                'shrink-0 rounded px-1.5 text-2xs',
                                kept ? 'bg-success/15 text-success' : 'bg-muted text-muted-foreground',
                              )}
                            >
                              {kept ? t('dedupeKeepLabel') : t('dedupeRemoveLabel')}
                            </span>
                          </label>
                        </li>
                      )
                    })}
                  </ul>
                </section>
              )
            })}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('cancelButton')}
          </Button>
          <Button disabled={merging || plan.length === 0} onClick={() => void handleMerge()}>
            {t('dedupeMergeButton', { groups: plan.length, count: removeCount })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
