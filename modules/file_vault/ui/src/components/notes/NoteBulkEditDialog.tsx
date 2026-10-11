import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Eye, Replace, TextCursorInput } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { vaultApi } from '@/lib/vaultApi'
import { translateError } from '@/i18n/errors'
import type { NoteBulkEditOp, NoteBulkEditPreviewItem } from '@/shared/ipcTypes'

/**
 * 批量修改笔记正文：查找替换，或在开头/结尾统一加文字。先预览再应用，且预览必须对应当前条件，条件
 * 一变预览作废、「应用」回灰。应用后整批共用一个 batch_id，供「撤销」提示（note_batch_undo）和时间
 * 线整批撤销。/
 */

type OpKind = NoteBulkEditOp['kind']

export function NoteBulkEditDialog({
  open,
  onOpenChange,
  noteIds,
  initialOp = 'replace',
  beforeApply,
  onApplied,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  noteIds: number[]
  initialOp?: OpKind
  /** 应用之前调用：正在编辑的笔记有未保存改动时先存盘。返回 false 就中止。 */
  beforeApply: () => Promise<boolean>
  onApplied: (result: { batchId: string; changedCount: number; totalMatches: number }) => void
}) {
  const { t } = useTranslation('notes')
  const [kind, setKind] = useState<OpKind>(initialOp)
  const [find, setFind] = useState('')
  const [replace, setReplace] = useState('')
  const [text, setText] = useState('')
  const [matchCase, setMatchCase] = useState(false)
  const [wholeWord, setWholeWord] = useState(false)
  const [regex, setRegex] = useState(false)
  const [preview, setPreview] = useState<{ items: NoteBulkEditPreviewItem[]; total: number } | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [applying, setApplying] = useState(false)

  useEffect(() => {
    if (open) setKind(initialOp)
  }, [open, initialOp])

  const op = useMemo<NoteBulkEditOp>(() => {
    if (kind === 'replace') return { kind, find, replace, match_case: matchCase, whole_word: wholeWord, regex }
    return { kind, text }
  }, [kind, find, replace, text, matchCase, wholeWord, regex])

  // 条件（或目标笔记）一变，手里的预览就不再对应，作废。
  useEffect(() => {
    setPreview(null)
    setPreviewError(null)
  }, [op, noteIds])

  const ready = kind === 'replace' ? find.length > 0 : text.length > 0
  const affected = preview ? preview.items.filter((item) => item.matches > 0 && !item.skipped) : []

  async function handlePreview() {
    if (!ready) return
    setPreviewing(true)
    setPreviewError(null)
    try {
      const res = await vaultApi.call('note_bulk_edit_preview', { note_ids: noteIds, op })
      if (!res.ok) {
        setPreviewError(translateError(res.error, res.error_params))
        return
      }
      setPreview({ items: res.items, total: res.total_matches })
    } catch (error) {
      setPreviewError(error instanceof Error ? error.message : String(error))
    } finally {
      setPreviewing(false)
    }
  }

  async function handleApply() {
    if (!preview || affected.length === 0) return
    setApplying(true)
    try {
      if (!(await beforeApply())) return
      const res = await vaultApi.call('note_bulk_edit_apply', { note_ids: affected.map((item) => item.note_id), op })
      if (!res.ok) {
        toast.error(t('bulkEditFailedToast'), { description: translateError(res.error, res.error_params) })
        return
      }
      onApplied({ batchId: res.batch_id, changedCount: res.changed_count, totalMatches: res.total_matches })
      onOpenChange(false)
    } finally {
      setApplying(false)
    }
  }

  const OPS: Array<{ id: OpKind; label: string; icon: typeof Replace }> = [
    { id: 'replace', label: t('bulkEditOpReplace'), icon: Replace },
    { id: 'prepend', label: t('bulkEditOpPrepend'), icon: TextCursorInput },
    { id: 'append', label: t('bulkEditOpAppend'), icon: TextCursorInput },
  ]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>{t('bulkEditDialogTitle')}</DialogTitle>
          <DialogDescription>{t('bulkEditTargetHint', { count: noteIds.length })}</DialogDescription>
        </DialogHeader>

        <div role="tablist" className="inline-flex w-fit rounded-lg border border-border/70 bg-surface/70 p-0.5">
          {OPS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={kind === id}
              onClick={() => setKind(id)}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-sm transition-colors',
                kind === id ? 'bg-background font-medium text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <Icon className="size-4" aria-hidden="true" />
              {label}
            </button>
          ))}
        </div>

        {kind === 'replace' ? (
          <div className="space-y-2">
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="space-y-1 text-sm">
                <span className="text-muted-foreground">{t('bulkEditFindLabel')}</span>
                <Input value={find} onChange={(e) => setFind(e.target.value)} autoFocus />
              </label>
              <label className="space-y-1 text-sm">
                <span className="text-muted-foreground">{t('bulkEditReplaceLabel')}</span>
                <Input value={replace} onChange={(e) => setReplace(e.target.value)} />
              </label>
            </div>
            <div className="flex flex-wrap items-center gap-4 text-sm">
              <label className="flex items-center gap-1.5">
                <Checkbox checked={matchCase} onCheckedChange={(v) => setMatchCase(v === true)} />
                {t('findCaseSensitiveLabel')}
              </label>
              <label className="flex items-center gap-1.5">
                <Checkbox checked={wholeWord} onCheckedChange={(v) => setWholeWord(v === true)} />
                {t('findWholeWordLabel')}
              </label>
              <label className="flex items-center gap-1.5">
                <Checkbox checked={regex} onCheckedChange={(v) => setRegex(v === true)} />
                {t('findRegexpLabel')}
              </label>
              {regex && <span className="text-muted-foreground">{t('bulkEditRegexHint')}</span>}
            </div>
          </div>
        ) : (
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">{t('bulkEditTextLabel')}</span>
            <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} autoFocus />
          </label>
        )}

        <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-border/70">
          {previewError ? (
            <p className="p-3 text-sm text-destructive">{previewError}</p>
          ) : !preview ? (
            <p className="p-3 text-sm text-muted-foreground">{t('bulkEditPreviewPrompt')}</p>
          ) : affected.length > 0 ? (
            <table className="w-full text-sm">
              <caption className="border-b border-border/70 px-3 py-2 text-left text-muted-foreground">
                {t('bulkEditPreviewSummary', { notes: affected.length, matches: preview.total })}
              </caption>
              <thead className="sticky top-0 bg-popover text-left text-muted-foreground">
                <tr>
                  <th className="px-3 py-1.5 font-medium">{t('bulkEditColTitle')}</th>
                  <th className="px-2 py-1.5 font-medium">{t('bulkEditColMatches')}</th>
                  <th className="px-2 py-1.5 font-medium">{t('bulkEditColBefore')}</th>
                  <th className="px-2 py-1.5 font-medium">{t('bulkEditColAfter')}</th>
                </tr>
              </thead>
              <tbody>
                {preview.items.map((item) => (
                  <tr key={item.note_id} className={cn('border-t border-border/50 align-top', item.matches === 0 && 'opacity-60')}>
                    <td className="max-w-48 truncate px-3 py-1.5">{item.title || t('untitledNote')}</td>
                    <td className="tabular px-2 py-1.5">
                      {item.skipped ? t(`bulkEditSkipped.${item.skipped}`) : item.matches}
                    </td>
                    <td className="px-2 py-1.5 break-words whitespace-pre-wrap text-destructive">{item.sample_before}</td>
                    <td className="px-2 py-1.5 break-words whitespace-pre-wrap text-success">{item.sample_after}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="p-3 text-sm text-muted-foreground">{t('bulkEditPreviewNone')}</p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('cancelButton')}
          </Button>
          <Button variant="outline" disabled={!ready || previewing || noteIds.length === 0} onClick={() => void handlePreview()}>
            <Eye className="size-4" aria-hidden="true" />
            {previewing ? t('loading') : t('bulkEditPreviewButton')}
          </Button>
          <Button disabled={applying || affected.length === 0} onClick={() => void handleApply()}>
            {t('bulkEditApplyButton', { count: affected.length })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
