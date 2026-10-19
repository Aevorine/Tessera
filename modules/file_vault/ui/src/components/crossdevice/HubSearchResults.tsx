import { forwardRef, useImperativeHandle, useMemo, useRef, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { SearchX } from 'lucide-react'
import type { SmartSearchState } from '@/lib/search'
import type { HubEntry, HubGroup } from '@/lib/search/fields/hub'
import { Highlight } from '@/components/search/Highlight'
import { EmptyState } from '@/components/ui/page'
import { shortTime } from '@/lib/timeLabel'
import { cn } from '@/lib/utils'

export interface HubSearchHandle {
  focusFirst: () => void
  openFirst: () => void
}

const PER_GROUP = 60
const TONE: Record<NonNullable<HubEntry['tone']>, string> = {
  ok: 'text-emerald-600',
  warn: 'text-warning',
  error: 'text-destructive',
}

export const HubSearchResults = forwardRef<
  HubSearchHandle,
  {
    result: SmartSearchState<HubEntry>
    groups: HubGroup[]
    onOpen: (entry: HubEntry, el: HTMLElement) => void
    onExitTop: () => void
  }
>(function HubSearchResults({ result, groups, onOpen, onExitTop }, ref) {
  const { t } = useTranslation('common')
  const rootRef = useRef<HTMLDivElement>(null)

  const byGroup = useMemo(() => {
    const m = new Map<string, HubEntry[]>()
    for (const e of result.items) {
      const list = m.get(e.group)
      if (list) list.push(e)
      else m.set(e.group, [e])
    }
    return groups.map((g) => ({ ...g, hits: m.get(g.id) ?? [] })).filter((g) => g.hits.length > 0)
  }, [result.items, groups])

  const hits = () => Array.from(rootRef.current?.querySelectorAll<HTMLButtonElement>('[data-hit]') ?? [])
  useImperativeHandle(ref, () => ({
    focusFirst: () => hits()[0]?.focus(),
    openFirst: () => hits()[0]?.click(),
  }))

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const list = hits()
    const i = list.indexOf(document.activeElement as HTMLButtonElement)
    if (i < 0) return
    e.preventDefault()
    if (e.key === 'ArrowUp' && i === 0) onExitTop()
    else list[Math.min(list.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus()
  }

  if (byGroup.length === 0) {
    return <EmptyState icon={SearchX} title={t('searchNoResults')} className="min-h-[220px] flex-1" />
  }

  return (
    <div
      ref={rootRef}
      onKeyDown={onKeyDown}
      className={cn(
        'grid min-h-[220px] flex-1 auto-rows-[minmax(0,1fr)] gap-3',
        byGroup.length > 1 && 'lg:grid-cols-2',
        byGroup.length > 2 && '2xl:grid-cols-3',
      )}
    >
      {byGroup.map((g) => {
        const GroupIcon = g.icon
        return (
          <section key={g.id} aria-label={g.label} className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-border/70 bg-card">
            <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-4 py-2.5 text-sm">
              <GroupIcon className="size-4 text-primary" aria-hidden="true" />
              <span className="font-medium">{g.label}</span>
              <span className="tabular ml-auto rounded-md bg-muted px-1.5 text-muted-foreground">{g.hits.length}</span>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
              {g.hits.slice(0, PER_GROUP).map((e) => {
                const Icon = e.icon
                return (
                  <button
                    key={e.key}
                    type="button"
                    data-hit
                    onClick={(ev) => onOpen(e, ev.currentTarget)}
                    className="ds-focus-ring flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-surface focus-visible:bg-surface"
                  >
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-primary">
                      <Icon className={cn('size-4', e.tone && TONE[e.tone])} aria-hidden="true" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">
                        <Highlight text={e.title} ranges={result.ranges(e, 'title')} />
                      </span>
                      {e.sub && (
                        <span className="block truncate text-sm text-muted-foreground">
                          <Highlight text={e.sub} ranges={result.ranges(e, 'sub')} />
                        </span>
                      )}
                    </span>
                    {e.at !== undefined && (
                      <span className="tabular shrink-0 text-sm text-muted-foreground">{shortTime(e.at)}</span>
                    )}
                  </button>
                )
              })}
            </div>
          </section>
        )
      })}
    </div>
  )
})
