import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Image as ImageIcon, Loader2, Send } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { crossDeviceApi } from '@/lib/crossDeviceApi'
import { readClipboardText } from '@/lib/clipboard'
import { cn } from '@/lib/utils'
import type { ClipTimelineItem } from '@/components/crossdevice/ClipTimelinePanel'

/** 当前剪贴板这一行的 id（时间线条目的 id 是十六进制，撞不上）。 */
const CURRENT = 'current'

interface Row {
  id: string
  who: string
  at: number | null
  preview: string
  image: boolean
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim()

/**
 * 「发送剪贴板」：当前剪贴板 + 跨设备时间线，单选 / 多选 / 全选后发给所有在线设备。
 * 按时间从旧到新逐条发，最新一条最后到，成为对方的当前剪贴板。
 */
export function ClipSendDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t, i18n } = useTranslation('crossdevice')
  const [rows, setRows] = useState<Row[]>([])
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(false)
  const [sending, setSending] = useState(false)

  useEffect(() => {
    if (!open) return
    let alive = true
    setLoading(true)
    void Promise.all([
      readClipboardText().catch(() => null),
      crossDeviceApi
        .call<{ items: ClipTimelineItem[] }>('clip_timeline', {})
        .then((r) => r.items ?? [])
        .catch(() => [] as ClipTimelineItem[]),
    ]).then(([text, items]) => {
      if (!alive) return
      const current = text ?? ''
      const list = items.filter((it) => it.available)
      // 时间线最新一条若就是当前剪贴板，不重复列。
      const top = list[0]
      const dup =
        top?.local && current && top.preview && norm(current).startsWith(norm(top.preview).replace(/…$/, ''))
      const next: Row[] = [
        { id: CURRENT, who: t('clipSendCurrent'), at: null, preview: current, image: false },
        ...list.slice(dup ? 1 : 0).map((it) => ({
          id: it.item_id,
          who: it.local ? t('thisDevice') : it.source_name || t('unknownDevice'),
          at: it.at,
          preview: it.preview,
          image: it.preferred.startsWith('image/'),
        })),
      ]
      setRows(next)
      setPicked(new Set([CURRENT]))
      setLoading(false)
    })
    return () => {
      alive = false
    }
  }, [open, t])

  const allOn = rows.length > 0 && picked.size === rows.length
  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const fmt = useMemo(
    () => new Intl.DateTimeFormat(i18n.language, { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    [i18n.language],
  )

  async function send() {
    // rows 是新到旧，当前剪贴板最新；反过来逐条发。
    const order = rows.filter((r) => picked.has(r.id) && r.id !== CURRENT).reverse()
    const withCurrent = picked.has(CURRENT)
    setSending(true)
    let ok = 0
    let firstError = ''
    for (const r of order) {
      try {
        await crossDeviceApi.call('clip_timeline_apply', { item_id: r.id, broadcast: true, local: false })
        ok++
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        firstError ||= msg.includes('clip_source_offline') ? t('clipTimelineOffline', { device: r.who }) : msg
      }
    }
    if (withCurrent) {
      try {
        const res = await crossDeviceApi.call<{ sent?: number; skipped?: string }>('send_clip', {})
        if (res.skipped !== 'echo') ok++
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        firstError ||= msg.includes('clipboard.empty') ? t('clipboardEmpty') : msg
      }
    }
    setSending(false)
    if (firstError) toast.error(firstError)
    if (ok > 0) toast.success(t('clipSendDone', { count: ok }))
    if (!firstError) onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !sending && onOpenChange(o)}>
      <DialogContent className="flex max-h-[80%] flex-col gap-3 sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('sendClipboard')}</DialogTitle>
          <DialogDescription className="sr-only">{t('sendClipboard')}</DialogDescription>
        </DialogHeader>
        <label className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-sm hover:bg-muted/50">
          <Checkbox
            checked={allOn}
            onCheckedChange={(v) => setPicked(v === true ? new Set(rows.map((r) => r.id)) : new Set())}
            disabled={loading || rows.length === 0}
          />
          {t('clipSendAll')}
          <span className="ml-auto tabular text-muted-foreground">
            {picked.size} / {rows.length}
          </span>
        </label>
        <ul className="min-h-0 flex-1 divide-y overflow-y-auto overscroll-contain rounded-lg border">
          {loading ? (
            <li className="flex items-center justify-center py-10 text-muted-foreground">
              <Loader2 className="size-5 animate-spin" aria-hidden="true" />
            </li>
          ) : (
            rows.map((r) => (
              <li key={r.id}>
                <label
                  className={cn(
                    'flex cursor-pointer items-start gap-3 px-3 py-2.5 transition-colors hover:bg-muted/40',
                    picked.has(r.id) && 'bg-accent-soft/60',
                  )}
                >
                  <Checkbox className="mt-1" checked={picked.has(r.id)} onCheckedChange={() => toggle(r.id)} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2 text-2xs text-muted-foreground">
                      <span
                        className={cn(
                          'rounded-full px-2 py-0.5 font-medium',
                          r.id === CURRENT ? 'bg-primary/10 text-primary' : 'bg-muted',
                        )}
                      >
                        {r.who}
                      </span>
                      {r.at !== null && <span className="tabular">{fmt.format(r.at)}</span>}
                    </span>
                    <span className={cn('mt-0.5 line-clamp-2 break-words text-sm', !r.preview && 'italic text-muted-foreground')}>
                      {r.image && <ImageIcon className="mr-1 inline size-4 align-text-bottom" aria-hidden="true" />}
                      {r.preview || (r.image ? t('clipTimelineImage') : t('clipTimelineNoPreview'))}
                    </span>
                  </span>
                </label>
              </li>
            ))
          )}
        </ul>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={sending}>
            {t('cancel')}
          </Button>
          <Button onClick={() => void send()} disabled={sending || loading || picked.size === 0}>
            {sending ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Send className="mr-2 size-4" />}
            {t('clipSendN', { count: picked.size })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
