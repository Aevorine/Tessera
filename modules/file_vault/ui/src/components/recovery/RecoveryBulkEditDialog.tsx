import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { vaultApi } from '@/lib/vaultApi'
import { translateError } from '@/i18n/errors'
import type { RecoveryCodeGroup } from '@/shared/ipcTypes'

/**
 * 一次改好几个服务。每个字段前有「修改此项」的勾：没勾的字段原样保留各自的值，只有勾了的才统一改，
 * 免得"只加备注"顺带把库存阈值改成默认数。初值取所选服务在该字段上是否一致：一致则预填，不一致留空
 * 。/
 */

function commonValue<T>(values: T[]): T | undefined {
  if (values.length === 0) return undefined
  return values.every((v) => v === values[0]) ? values[0] : undefined
}

export interface BulkEditResult {
  batchId: string
  changedCount: number
}

export function RecoveryBulkEditDialog({
  targets,
  onClose,
  onApplied,
}: {
  /** null = 关闭。 */
  targets: RecoveryCodeGroup[] | null
  onClose: () => void
  onApplied: (result: BulkEditResult) => void | Promise<void>
}) {
  return (
    <Dialog open={targets !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-2xl">
        {targets && <BulkEditBody targets={targets} onClose={onClose} onApplied={onApplied} />}
      </DialogContent>
    </Dialog>
  )
}

function FieldRow({
  id,
  label,
  enabled,
  onEnabledChange,
  children,
  hint,
}: {
  id: string
  label: string
  enabled: boolean
  onEnabledChange: (v: boolean) => void
  children: React.ReactNode
  hint?: string
}) {
  const { t } = useTranslation('recoveryCodes')
  return (
    <div
      className={cn(
        'space-y-2 rounded-lg border px-3.5 py-3 transition-colors',
        enabled ? 'border-accent-line bg-accent-soft/30' : 'border-border/70',
      )}
    >
      <div className="flex items-center gap-2.5">
        <Checkbox
          id={`${id}-apply`}
          checked={enabled}
          onCheckedChange={(v) => onEnabledChange(v === true)}
          aria-label={t('bulkEditApplyFieldAria', { field: label })}
        />
        <Label htmlFor={`${id}-apply`} className="cursor-pointer">
          {label}
        </Label>
        {!enabled && <span className="ms-auto text-sm text-muted-foreground">{t('bulkEditKeepHint')}</span>}
      </div>
      {/* 没勾时照样显示输入框（只是灰掉）：用户能先看到"改成什么"，再决定勾不勾。 */}
      <div className={cn(!enabled && 'pointer-events-none opacity-50')} aria-disabled={!enabled}>
        {children}
      </div>
      {hint && <p className="text-sm leading-relaxed text-muted-foreground">{hint}</p>}
    </div>
  )
}

function BulkEditBody({
  targets,
  onClose,
  onApplied,
}: {
  targets: RecoveryCodeGroup[]
  onClose: () => void
  onApplied: (result: BulkEditResult) => void | Promise<void>
}) {
  const { t } = useTranslation('recoveryCodes')
  const [useService, setUseService] = useState(false)
  const [service, setService] = useState(() => commonValue(targets.map((g) => g.service)) ?? '')
  const [useAccount, setUseAccount] = useState(false)
  const [account, setAccount] = useState(() => commonValue(targets.map((g) => g.accountLabel)) ?? '')
  const [useNote, setUseNote] = useState(false)
  const [note, setNote] = useState('')
  const [noteMode, setNoteMode] = useState<'replace' | 'append'>('append')
  const [useLowStock, setUseLowStock] = useState(false)
  const [lowStock, setLowStock] = useState(() => String(commonValue(targets.map((g) => g.lowStockThreshold)) ?? ''))
  const [useReview, setUseReview] = useState(false)
  const [reviewDays, setReviewDays] = useState(() => String(commonValue(targets.map((g) => g.reviewIntervalDays)) ?? ''))
  const [markChecked, setMarkChecked] = useState(false)
  const [busy, setBusy] = useState(false)

  const nothingPicked = !useService && !useAccount && !useNote && !useLowStock && !useReview && !markChecked

  async function handleApply() {
    if (useService && !service.trim()) {
      toast.error(t('serviceRequiredHint'))
      return
    }
    const lowStockValue = Number.parseInt(lowStock, 10)
    const reviewValue = Number.parseInt(reviewDays, 10)
    if (useLowStock && !(Number.isFinite(lowStockValue) && lowStockValue >= 0)) {
      toast.error(t('bulkEditNumberInvalid', { field: t('lowStockThresholdLabel') }))
      return
    }
    if (useReview && !(Number.isFinite(reviewValue) && reviewValue >= 1)) {
      toast.error(t('bulkEditNumberInvalid', { field: t('reviewIntervalDaysLabel') }))
      return
    }
    setBusy(true)
    try {
      const res = await vaultApi.call('recovery_codes_update_meta_bulk', {
        ids: targets.map((g) => g.id),
        ...(useService ? { service: service.trim() } : {}),
        ...(useAccount ? { account_label: account.trim() } : {}),
        ...(useNote ? { note, note_mode: noteMode } : {}),
        ...(useLowStock ? { low_stock_threshold: lowStockValue } : {}),
        ...(useReview ? { review_interval_days: reviewValue } : {}),
        ...(markChecked ? { mark_checked: true } : {}),
      })
      if (!res.ok) {
        toast.error(t('bulkEditFailedToast'), { description: translateError(res.error, res.error_params) })
        return
      }
      await onApplied({ batchId: res.batch_id, changedCount: res.changed_count })
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t('bulkEditDialogTitle', { count: targets.length })}</DialogTitle>
        <DialogDescription>{t('bulkEditIntro')}</DialogDescription>
      </DialogHeader>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
        <p className="line-clamp-2 text-sm text-muted-foreground">
          {targets.map((g) => (g.accountLabel ? `${g.service} · ${g.accountLabel}` : g.service)).join('、')}
        </p>

        <FieldRow
          id="rc-bulk-service"
          label={t('serviceLabel')}
          enabled={useService}
          onEnabledChange={setUseService}
          hint={t('bulkEditServiceHint')}
        >
          <Input id="rc-bulk-service" value={service} onChange={(e) => setService(e.target.value)} />
        </FieldRow>

        <FieldRow id="rc-bulk-account" label={t('accountLabelLabel')} enabled={useAccount} onEnabledChange={setUseAccount}>
          <Input
            id="rc-bulk-account"
            value={account}
            placeholder={t('accountLabelPlaceholder')}
            onChange={(e) => setAccount(e.target.value)}
          />
        </FieldRow>

        <FieldRow id="rc-bulk-note" label={t('noteLabel')} enabled={useNote} onEnabledChange={setUseNote}>
          <div className="space-y-2">
            <Textarea
              id="rc-bulk-note"
              rows={2}
              value={note}
              placeholder={t('notePlaceholder')}
              onChange={(e) => setNote(e.target.value)}
            />
            <div className="flex flex-wrap gap-x-5 gap-y-1.5 text-sm" role="radiogroup" aria-label={t('noteLabel')}>
              {(['append', 'replace'] as const).map((mode) => (
                <label key={mode} className="flex cursor-pointer items-center gap-2">
                  <input
                    type="radio"
                    name="rc-bulk-note-mode"
                    className="accent-primary"
                    checked={noteMode === mode}
                    onChange={() => setNoteMode(mode)}
                  />
                  {mode === 'append' ? t('bulkEditNoteModeAppend') : t('bulkEditNoteModeReplace')}
                </label>
              ))}
            </div>
          </div>
        </FieldRow>

        <div className="grid gap-3 sm:grid-cols-2">
          <FieldRow id="rc-bulk-lowstock" label={t('lowStockThresholdLabel')} enabled={useLowStock} onEnabledChange={setUseLowStock}>
            <Input
              id="rc-bulk-lowstock"
              type="number"
              min={0}
              value={lowStock}
              onChange={(e) => setLowStock(e.target.value)}
            />
          </FieldRow>
          <FieldRow id="rc-bulk-review" label={t('reviewIntervalDaysLabel')} enabled={useReview} onEnabledChange={setUseReview}>
            <Input
              id="rc-bulk-review"
              type="number"
              min={1}
              value={reviewDays}
              onChange={(e) => setReviewDays(e.target.value)}
            />
          </FieldRow>
        </div>

        <label className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-border/70 px-3.5 py-3 text-sm">
          <Checkbox checked={markChecked} onCheckedChange={(v) => setMarkChecked(v === true)} />
          {t('bulkEditMarkCheckedLabel')}
        </label>
      </div>
      <div className="flex shrink-0 flex-col-reverse gap-2.5 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-end">
        {nothingPicked && <span className="me-auto text-sm text-muted-foreground">{t('bulkEditNothingHint')}</span>}
        <Button variant="outline" onClick={onClose}>
          {t('importPreviewCancelButton')}
        </Button>
        <Button onClick={() => void handleApply()} disabled={nothingPicked || busy}>
          {t('bulkEditApplyButton')}
        </Button>
      </div>
    </>
  )
}
