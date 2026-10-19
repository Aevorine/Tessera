import { createSearcher, useSmartSearch } from '@/lib/search'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  ClipboardPaste,
  History,
  Image as ImageIcon,
  Maximize2,
  Minimize2,
  RefreshCw,
  Search,
  Send,
  Trash2,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { PageSection } from '@/components/ui/page'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { crossDeviceApi } from '@/lib/crossDeviceApi'
import { cn } from '@/lib/utils'

/** clip_timeline 回来的一条（core/agent/agent.go 的 clipTimeline）。不含正文。 */
export interface ClipTimelineItem {
  item_id: string
  source: string
  source_name: string
  local: boolean
  /** local 本机复制 | sync 实时同步来的 | pull 连上时向对端要来的（对方断线期间复制的） */
  via: 'local' | 'sync' | 'pull'
  at: number
  preferred: string
  preview: string
  kinds: { mime: string; size: number; ready: boolean }[]
  size: number
  complete: boolean
  /** 正文不全、来源又不在线时为 false：暂时粘贴不了。 */
  available: boolean
}

const timelineSearcher = createSearcher<ClipTimelineItem>([
  { key: 'text', get: (it) => it.preview, weight: 2, aliases: ['内容', 'clip'] },
  { key: 'device', get: (it) => it.source_name, aliases: ['设备', '来源', 'from'] },
  { key: 'type', get: (it) => it.preferred, aliases: ['类型'] },
])

type Filter = 'all' | 'others' | 'mine'

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function relativeTime(at: number, locale: string): string {
  const diff = Math.round((at - Date.now()) / 1000)
  const abs = Math.abs(diff)
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  if (abs < 60) return rtf.format(diff, 'second')
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute')
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour')
  return new Date(at).toLocaleString(locale)
}

function IconAction({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  children: React.ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* 置灰的按钮收不到指针事件，外面包一层 span，提示仍然能出来说明为什么不能点。 */}
        <span className="inline-flex">
          <Button size="icon" variant="ghost" className="size-8" onClick={onClick} disabled={disabled} aria-label={label}>
            {children}
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

/**
 * 跨设备剪贴板时间线：翻看任一设备最近复制的内容，再次粘贴到本机或重新发给所有设备。页内是固定高度
 * 窗口（`WINDOW_HEIGHT`），有无内容大小一致；全屏用应用自己的 Dialog 而非 Fullscreen API（主进程拒
 * 绝渲染进程的所有权限请求，见 electron/main.ts setPermissionRequestHandler）。列表只有预览；「粘
 * 贴到本机」由主进程取回正文直接写系统剪贴板（clip_timeline_apply），正文不经渲染进程。/
 */
const WINDOW_HEIGHT = 'h-[min(32rem,65vh)]'

export function ClipTimelinePanel({
  available,
  variant = 'section',
}: {
  available: boolean
  /** fill：放进全屏面板，铺满高度，不带分区标题与说明。 */
  variant?: 'section' | 'fill'
}) {
  const { t, i18n } = useTranslation('crossdevice')
  const [items, setItems] = useState<ClipTimelineItem[]>([])
  const [clipSync, setClipSync] = useState(true)
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [fullscreen, setFullscreen] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fullSearchRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async (refresh = false) => {
    try {
      const res = await crossDeviceApi.call<{ items: ClipTimelineItem[]; clip_sync?: boolean }>('clip_timeline', { refresh })
      setItems(res.items ?? [])
      if (typeof res.clip_sync === 'boolean') setClipSync(res.clip_sync)
    } catch {
      /* 守护进程重启中：保留上一次的列表 */
    }
  }, [])

  useEffect(() => {
    if (!available) return
    void load(true)
    // 连续复制时事件一串一串地来，攒 150 ms 再查一次。
    const off = crossDeviceApi.onEvent((e) => {
      if (e.event !== 'clip_timeline' && e.event !== 'state') return
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => void load(false), 150)
    })
    return () => {
      off()
      if (timer.current) clearTimeout(timer.current)
    }
  }, [available, load])

  const searchState = useSmartSearch(items, timelineSearcher, query)
  const shown = useMemo(() => {
    return searchState.items.filter((it) => {
      if (filter === 'mine' && !it.local) return false
      if (filter === 'others' && it.local) return false
      return true
    })
  }, [searchState.items, filter])

  const apply = useCallback(
    async (it: ClipTimelineItem, broadcast: boolean) => {
      setBusy(it.item_id)
      try {
        const res = await crossDeviceApi.call<{ errors?: string[] }>('clip_timeline_apply', { item_id: it.item_id, broadcast })
        if (broadcast) {
          const failed = res.errors?.length ?? 0
          if (failed > 0) toast.warning(t('clipTimelineSentPartial', { n: failed }))
          else toast.success(t('clipTimelineSent'))
        } else {
          toast.success(t('clipTimelinePasted', { device: it.local ? t('thisDevice') : it.source_name }))
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        toast.error(msg.includes('clip_source_offline') ? t('clipTimelineOffline', { device: it.source_name }) : msg)
      } finally {
        setBusy(null)
      }
    },
    [t],
  )

  const remove = useCallback(
    async (it: ClipTimelineItem) => {
      setItems((xs) => xs.filter((x) => x.item_id !== it.item_id))
      try {
        await crossDeviceApi.call('clip_timeline_remove', { item_id: it.item_id })
      } catch {
        void load(false)
      }
    },
    [load],
  )

  const clear = useCallback(async () => {
    try {
      await crossDeviceApi.call('clip_timeline_clear')
      setItems([])
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }, [])

  if (!available) return null

  const filters: { id: Filter; label: string }[] = [
    { id: 'all', label: t('clipTimelineAll') },
    { id: 'others', label: t('clipTimelineOthers') },
    { id: 'mine', label: t('thisDevice') },
  ]

  const refreshAndClear = (
    <>
      <IconAction label={t('clipTimelineRefresh')} onClick={() => void load(true)}>
        <RefreshCw className="size-4" />
      </IconAction>
      <IconAction label={t('clipTimelineClear')} onClick={() => void clear()} disabled={items.length === 0}>
        <Trash2 className="size-4" />
      </IconAction>
    </>
  )

  const filterBar = (searchRef?: React.Ref<HTMLInputElement>) => (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex rounded-md border p-0.5" role="tablist" aria-label={t('clipTimelineTitle')}>
        {filters.map((f) => (
          <button
            key={f.id}
            type="button"
            role="tab"
            aria-selected={filter === f.id}
            onClick={() => setFilter(f.id)}
            className={cn(
              'rounded px-2.5 py-1 text-sm transition-colors',
              filter === f.id ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted',
            )}
          >
            {f.label}
          </button>
        ))}
      </div>
      <div className="relative min-w-[12rem] flex-1">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <Input
          ref={searchRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('clipTimelineSearch')}
          aria-label={t('clipTimelineSearch')}
          className="h-8 pl-8"
        />
      </div>
    </div>
  )

  /** 列表本体。`previewLines` 页内 2 行够认出是哪条，全屏时放宽到 6 行。 */
  const list = (previewLines: 'line-clamp-2' | 'line-clamp-6') =>
    shown.length === 0 ? (
      <p className="flex h-full items-center justify-center px-4 text-center text-sm text-muted-foreground">
        {t('clipTimelineEmpty')}
      </p>
    ) : (
      <ul className="h-full divide-y overflow-y-auto overscroll-contain">
        {shown.map((it) => {
          const isImage = it.preferred.startsWith('image/')
          return (
            <li key={it.item_id} className="flex items-start gap-3 px-3 py-2">
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs text-muted-foreground">
                  <span
                    className={cn(
                      'rounded-full px-2 py-0.5 font-medium',
                      it.local ? 'bg-muted' : 'bg-primary/10 text-primary',
                    )}
                  >
                    {it.local ? t('thisDevice') : it.source_name || t('unknownDevice')}
                  </span>
                  <span className="tabular" title={new Date(it.at).toLocaleString(i18n.language)}>
                    {relativeTime(it.at, i18n.language)}
                  </span>
                  <span className="tabular">· {humanBytes(it.size)}</span>
                  {it.via === 'pull' && <span>· {t('clipTimelinePulled')}</span>}
                </div>
                <p className={cn(previewLines, 'break-words text-sm', !it.preview && 'italic text-muted-foreground')}>
                  {isImage && <ImageIcon className="mr-1 inline size-4 align-text-bottom" aria-hidden="true" />}
                  {it.preview || (isImage ? t('clipTimelineImage') : t('clipTimelineNoPreview'))}
                </p>
              </div>
              <div className="flex shrink-0 items-center">
                <IconAction
                  label={it.available ? t('clipTimelinePasteHere') : t('clipTimelineOffline', { device: it.source_name })}
                  onClick={() => void apply(it, false)}
                  disabled={!it.available || busy === it.item_id}
                >
                  <ClipboardPaste className="size-4" />
                </IconAction>
                <IconAction
                  label={t('clipTimelineSendAll')}
                  onClick={() => void apply(it, true)}
                  disabled={!it.available || busy === it.item_id}
                >
                  <Send className="size-4" />
                </IconAction>
                <IconAction label={t('clipTimelineRemove')} onClick={() => void remove(it)}>
                  <X className="size-4" />
                </IconAction>
              </div>
            </li>
          )
        })}
      </ul>
    )

  if (variant === 'fill') {
    return (
      <div className="flex h-full min-h-0 flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-0 flex-1">{filterBar()}</div>
          <div className="flex items-center gap-1">{refreshAndClear}</div>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden rounded-xl border bg-card">{list('line-clamp-6')}</div>
      </div>
    )
  }

  return (
    <>
      <PageSection
        icon={History}
        title={t('clipTimelineTitle')}
        collapsible
        storageKey="crossdevice.cliptimeline"
        contentClassName="space-y-3"
        actions={
          <div className="flex items-center gap-1">
            {refreshAndClear}
            <IconAction label={t('clipTimelineFullscreen')} onClick={() => setFullscreen(true)}>
              <Maximize2 className="size-4" />
            </IconAction>
          </div>
        }
      >
        {filterBar()}
        {!clipSync && <p className="text-sm text-muted-foreground">{t('clipTimelineSyncOff')}</p>}
        {/* 固定大小的窗口：高度写死，条数多少都不变；里面自己滑。 */}
        <div className={cn(WINDOW_HEIGHT, 'overflow-hidden rounded-md border')} data-testid="clip-timeline-window">
          {list('line-clamp-2')}
        </div>
        <p className="text-2xs text-muted-foreground">{t('clipTimelineHint')}</p>
      </PageSection>

      {/* 全屏：铺满整个应用窗口。Esc 由 Dialog 处理（onOpenChange(false)）。
          showCloseButton 关掉，用自己标题栏里的「退出全屏」——Dialog 自带的那颗
          会压在我们的按钮上。 */}
      <Dialog open={fullscreen} onOpenChange={setFullscreen}>
        <DialogContent
          showCloseButton={false}
          data-testid="clip-timeline-fullscreen"
          // 初始焦点给搜索框：默认焦点落在刷新按钮会弹出提示气泡，气泡吃掉第一下 Esc，全屏要按两下才退出。
          onOpenAutoFocus={(e) => {
            e.preventDefault()
            fullSearchRef.current?.focus()
          }}
          // fixed + inset-0 + 宽高 auto：四边贴住视口，不用 h-screen/w-screen
          // （面板里禁用视口单位的写法，见 tests/scrollReachability.test.mjs）。
          className="inset-0 top-0 left-0 flex h-auto max-h-none w-auto max-w-none translate-x-0 translate-y-0 flex-col gap-3 overflow-hidden rounded-none p-6 sm:max-w-none"
        >
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2.5">
              <History className="size-5 shrink-0 text-primary" aria-hidden="true" />
              <DialogTitle className="truncate">{t('clipTimelineTitle')}</DialogTitle>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {refreshAndClear}
              <IconAction label={t('clipTimelineExitFullscreen')} onClick={() => setFullscreen(false)}>
                <Minimize2 className="size-4" />
              </IconAction>
            </div>
          </div>
          <DialogDescription className="sr-only">{t('clipTimelineHint')}</DialogDescription>
          {filterBar(fullSearchRef)}
          {!clipSync && <p className="text-sm text-muted-foreground">{t('clipTimelineSyncOff')}</p>}
          <div className="min-h-0 flex-1 overflow-hidden rounded-md border">{list('line-clamp-6')}</div>
          <p className="text-2xs text-muted-foreground">{t('clipTimelineHint')}</p>
        </DialogContent>
      </Dialog>
    </>
  )
}
