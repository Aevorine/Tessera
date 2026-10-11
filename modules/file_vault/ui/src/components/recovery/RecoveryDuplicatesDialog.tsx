import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { CopyCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Badge, EmptyState } from '@/components/ui/page'
import { cn } from '@/lib/utils'
import { vaultApi } from '@/lib/vaultApi'
import { translateError } from '@/i18n/errors'
import { buildMergePlan, defaultKeepId } from '@/lib/recovery/revisions'
import type { RecoveryCodeDuplicateGroup, RecoveryCodeGroup } from '@/shared/ipcTypes'

/**
 * 去重：先扫描列清单，用户逐组决定留哪个，再一次性合并。绝不静默合并：同名服务可能是不同账号，码相
 * 同的两组也可能是服务名打错，只有用户知道该留哪个，默认仅预选剩余可用最多的那个。合并不丢码：被并
 * 掉的码按码去重并入保留组，任一边标过「已用」就算已用（把用掉的码当可用是最不能犯的错）。整批带同
 * 一个 batch_id，toast「撤销」和时间线「整批撤销」都能原样退回。/
 */

export interface DuplicatesMergeResult {
  batchId: string
  mergedCount: number
  removedCodes: number
}

interface SetState {
  key: string
  reason: RecoveryCodeDuplicateGroup['reason']
  ids: string[]
  keepId: string
  include: boolean
}

export function RecoveryDuplicatesDialog({
  open,
  onClose,
  groups,
  onMerged,
}: {
  open: boolean
  onClose: () => void
  /** 当前的全部服务，给每一行显示名字和剩余数量。 */
  groups: RecoveryCodeGroup[]
  onMerged: (result: DuplicatesMergeResult) => void | Promise<void>
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-3xl">
        {open && <DuplicatesBody groups={groups} onClose={onClose} onMerged={onMerged} />}
      </DialogContent>
    </Dialog>
  )
}

function formatDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleDateString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit' })
}

function DuplicatesBody({
  groups,
  onClose,
  onMerged,
}: {
  groups: RecoveryCodeGroup[]
  onClose: () => void
  onMerged: (result: DuplicatesMergeResult) => void | Promise<void>
}) {
  const { t } = useTranslation('recoveryCodes')
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [sets, setSets] = useState<SetState[]>([])
  const [within, setWithin] = useState<Array<{ id: string; duplicate_count: number }>>([])
  const [dedupeWithin, setDedupeWithin] = useState(true)
  const [busy, setBusy] = useState(false)

  const byId = useMemo(() => new Map(groups.map((g) => [g.id, g])), [groups])

  const scan = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const res = await vaultApi.call('recovery_codes_duplicates_scan', {})
      // 扫描结果里的 id 以后端为准，但显示要靠当前列表：列表里找不到的（刚被
      // 别处删掉）直接剔掉，剔完不足两个的组也就不算重复了。
      const known = new Map(groups.map((g) => [g.id, g]))
      const next: SetState[] = []
      for (const [i, set] of (res.groups ?? []).entries()) {
        const ids = set.ids.filter((id) => known.has(id))
        if (ids.length < 2) continue
        next.push({ key: `${set.reason}-${i}`, reason: set.reason, ids, keepId: defaultKeepId(ids, known), include: true })
      }
      setSets(next)
      setWithin((res.within ?? []).filter((w) => known.has(w.id)))
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
    // 只在打开时扫一次：扫描期间列表刷新不该让已经勾好的选择被重置。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    void scan()
  }, [scan])

  const plan = useMemo(() => {
    const merges = buildMergePlan(sets.filter((s) => s.include).map((s) => ({ ids: s.ids, keepId: s.keepId })))
    if (!dedupeWithin) return merges
    // 只勾了「清掉组内重复」、没参与任何合并的服务，也要作为"保留组"发过去，
    // merge_ids 为空——后端对每个保留组做组内去重。
    const touched = new Set(merges.flatMap((m) => [m.keep_id, ...m.merge_ids]))
    const extra = within.filter((w) => !touched.has(w.id)).map((w) => ({ keep_id: w.id, merge_ids: [] as string[] }))
    return [...merges, ...extra]
  }, [sets, within, dedupeWithin])

  const includedSets = sets.filter((s) => s.include).length
  const canMerge = plan.length > 0 && !busy

  function updateSet(key: string, patch: Partial<SetState>) {
    setSets((prev) => prev.map((s) => (s.key === key ? { ...s, ...patch } : s)))
  }

  async function handleMerge() {
    setBusy(true)
    try {
      const res = await vaultApi.call('recovery_codes_duplicates_merge', { groups: plan, dedupe_within: dedupeWithin })
      if (!res.ok) {
        toast.error(t('dedupeMergeFailedToast'), { description: translateError(res.error, res.error_params) })
        return
      }
      await onMerged({ batchId: res.batch_id, mergedCount: res.merged_count, removedCodes: res.removed_codes })
      onClose()
    } finally {
      setBusy(false)
    }
  }

  const nothingFound = !loading && !loadError && sets.length === 0 && within.length === 0

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <CopyCheck className="size-4 text-muted-foreground" aria-hidden="true" />
          {t('dedupeDialogTitle')}
        </DialogTitle>
        <DialogDescription>{t('dedupeMergeHint')}</DialogDescription>
      </DialogHeader>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto">
        {loading && <p className="text-sm text-muted-foreground">{t('dedupeScanning')}</p>}
        {!loading && loadError && (
          <div className="flex flex-col items-center gap-3 py-6 text-center">
            <p className="text-sm text-destructive">{t('dedupeScanFailed', { reason: loadError })}</p>
            <Button size="sm" variant="outline" onClick={() => void scan()}>
              {t('retryButton')}
            </Button>
          </div>
        )}
        {nothingFound && <EmptyState icon={CopyCheck} title={t('dedupeNone')} />}

        {sets.map((set) => (
          <section
            key={set.key}
            className={cn(
              'space-y-2 rounded-lg border p-3 transition-colors',
              set.include ? 'border-border bg-surface' : 'border-border/60 opacity-60',
            )}
          >
            <div className="flex items-center gap-2.5">
              <Checkbox
                id={`rc-dup-${set.key}`}
                checked={set.include}
                onCheckedChange={(v) => updateSet(set.key, { include: v === true })}
              />
              <label htmlFor={`rc-dup-${set.key}`} className="cursor-pointer text-sm font-medium">
                {t('dedupeIncludeSet', { count: set.ids.length })}
              </label>
              <Badge tone={set.reason === 'same_identity' ? 'accent' : 'warning'} className="ms-auto">
                {t(`dedupeReason_${set.reason}` as 'dedupeReason_same_identity')}
              </Badge>
            </div>
            <ul className="space-y-1" role="radiogroup" aria-label={t('dedupeKeepLabel')}>
              {set.ids.map((id) => {
                const g = byId.get(id)
                if (!g) return null
                const keep = set.keepId === id
                return (
                  <li key={id}>
                    <label
                      className={cn(
                        'flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors hover:bg-muted/60',
                        keep && 'bg-accent-soft/50',
                      )}
                    >
                      <input
                        type="radio"
                        name={`rc-dup-keep-${set.key}`}
                        className="accent-primary"
                        checked={keep}
                        disabled={!set.include}
                        onChange={() => updateSet(set.key, { keepId: id })}
                      />
                      <span className="min-w-0 flex-1 truncate">
                        <span className="font-medium">{g.service}</span>
                        {g.accountLabel && <span className="text-muted-foreground"> · {g.accountLabel}</span>}
                      </span>
                      <span className="shrink-0 text-muted-foreground tabular">
                        {t('remainingCountLabel', { remaining: g.remainingCount, total: g.codes.length })}
                      </span>
                      <span className="hidden shrink-0 text-muted-foreground tabular sm:inline">
                        {t('dedupeUpdatedAt', { time: formatDate(g.lastUpdatedAt) })}
                      </span>
                      {keep ? (
                        <Badge tone="success" className="shrink-0">
                          {t('dedupeKeepLabel')}
                        </Badge>
                      ) : (
                        <Badge tone="neutral" className="shrink-0">
                          {t('dedupeMergeInto')}
                        </Badge>
                      )}
                    </label>
                  </li>
                )
              })}
            </ul>
          </section>
        ))}

        {within.length > 0 && (
          <section className="space-y-2 rounded-lg border border-border p-3">
            <h3 className="text-sm font-medium">{t('dedupeWithinTitle')}</h3>
            <ul className="space-y-1 text-sm text-muted-foreground">
              {within.map((w) => {
                const g = byId.get(w.id)
                return (
                  <li key={w.id}>
                    {t('dedupeWithinItem', {
                      service: g ? (g.accountLabel ? `${g.service} · ${g.accountLabel}` : g.service) : w.id,
                      count: w.duplicate_count,
                    })}
                  </li>
                )
              })}
            </ul>
            <label className="flex cursor-pointer items-center gap-2.5 pt-1 text-sm">
              <Checkbox checked={dedupeWithin} onCheckedChange={(v) => setDedupeWithin(v === true)} />
              {t('dedupeWithinCheckbox')}
            </label>
          </section>
        )}
      </div>

      <div className="flex shrink-0 flex-col-reverse gap-2.5 border-t border-border pt-4 sm:flex-row sm:justify-end">
        <Button variant="outline" onClick={onClose}>
          {t('importPreviewCancelButton')}
        </Button>
        <Button onClick={() => void handleMerge()} disabled={!canMerge}>
          {t('dedupeMergeButton', { count: includedSets })}
        </Button>
      </div>
    </>
  )
}
