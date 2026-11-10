import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface FeatureTileSpec {
  id: string
  icon: LucideIcon
  title: string
  /** 实时小结，一行。 */
  badge: string
  /** 需要用户留意时小结用警示色。 */
  attention?: boolean
}

/** 列数：格子宽高比最接近 TARGET_RATIO 的那个；格子不得小于最小尺寸。 */
const TARGET_RATIO = 1.5
const MIN_W = 150
const MIN_H = 96
const GAP = 12

function pickColumns(n: number, w: number, h: number): number {
  if (n === 0 || w === 0) return 1
  let best = 1
  let score = Number.POSITIVE_INFINITY
  for (let c = 1; c <= n; c++) {
    const r = Math.ceil(n / c)
    const cw = (w - GAP * (c - 1)) / c
    const ch = (h - GAP * (r - 1)) / r
    if (cw < MIN_W) break
    if (ch < MIN_H) continue
    const s = Math.abs(Math.log(cw / ch / TARGET_RATIO))
    if (s < score) {
      score = s
      best = c
    }
  }
  return best
}

/** 一行放得下就一行；放不下时用最少的行数，并把各行摊匀（4 个放不下一行就 2 + 2，不是 3 + 1）。 */
function bandColumns(n: number, w: number): number {
  if (n === 0 || w === 0) return Math.max(n, 1)
  const fit = Math.max(1, Math.min(n, Math.floor((w + GAP) / (MIN_W + GAP))))
  return Math.ceil(n / Math.ceil(n / fit))
}

/** 功能格：铺满分到的空间，末行不满时拉宽补齐，不留空洞。band = 按宽度排成尽量少的行（分组用）。 */
export function FeatureGrid({
  tiles,
  onOpen,
  className,
  band = false,
}: {
  tiles: FeatureTileSpec[]
  onOpen: (id: string, origin: HTMLElement) => void
  className?: string
  band?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => {
      const { width, height } = e.contentRect
      setSize((s) => (Math.abs(s.w - width) < 1 && Math.abs(s.h - height) < 1 ? s : { w: width, h: height }))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const rows = useMemo(() => {
    const cols = band ? bandColumns(tiles.length, size.w) : pickColumns(tiles.length, size.w, size.h)
    const out: FeatureTileSpec[][] = []
    for (let i = 0; i < tiles.length; i += cols) out.push(tiles.slice(i, i + cols))
    return out
  }, [tiles, size, band])

  return (
    <div ref={ref} className={cn('flex min-h-0 flex-col', className)} style={{ gap: GAP }}>
      {rows.map((row, i) => (
        <div key={i} className={cn('flex min-h-[96px] flex-1', band && 'short:min-h-[68px]')} style={{ gap: GAP }}>
          {row.map((t) => (
            <FeatureTile key={t.id} tile={t} onOpen={onOpen} band={band} />
          ))}
        </div>
      ))}
    </div>
  )
}

export interface FeatureGroupSpec {
  id: string
  label: string
  tiles: FeatureTileSpec[]
}

/** 分组功能格：每类一行（标题 + 该类的格子），各行等分高度；每行内仍按 FeatureGrid 的规则铺满不留洞。 */
export function FeatureGroupGrid({
  groups,
  onOpen,
  className,
}: {
  groups: FeatureGroupSpec[]
  onOpen: (id: string, origin: HTMLElement) => void
  className?: string
}) {
  return (
    <div className={cn('flex flex-col', className)} style={{ gap: GAP }}>
      {groups.map((g) => (
        <section key={g.id} aria-label={g.label} className="flex flex-1 flex-col gap-1.5">
          <h3 className="flex shrink-0 items-center gap-2 px-1 text-sm font-medium text-muted-foreground">
            <span className="shrink-0">{g.label}</span>
            <span aria-hidden="true" className="h-px flex-1 bg-border/70" />
          </h3>
          <FeatureGrid tiles={g.tiles} onOpen={onOpen} band className="min-h-fit flex-1" />
        </section>
      ))}
    </div>
  )
}

function FeatureTile({
  tile,
  onOpen,
  band = false,
}: {
  tile: FeatureTileSpec
  onOpen: (id: string, origin: HTMLElement) => void
  band?: boolean
}) {
  const Icon = tile.icon
  return (
    <button
      type="button"
      onClick={(e) => onOpen(tile.id, e.currentTarget)}
      aria-label={`${tile.title}，${tile.badge}`}
      data-hint={tile.title}
      className={cn(
        'ds-focus-ring group relative flex min-w-0 flex-1 flex-col justify-between overflow-hidden rounded-2xl border border-border/70 bg-card p-5 text-left',
        'transition-[border-color,background-color,transform] duration-200 ease-out hover:border-[var(--accent-line)] hover:bg-surface active:scale-[0.985]',
        band && 'short:flex-row short:items-center short:justify-start short:gap-3 short:px-4 short:py-3',
      )}
    >
      <Icon
        aria-hidden="true"
        className="pointer-events-none absolute -right-4 -bottom-5 size-28 text-primary opacity-[0.06] transition-transform duration-300 ease-out group-hover:-translate-y-1 group-hover:scale-105"
      />
      <span className={cn('ds-icon-chip size-11 shrink-0 rounded-xl', band && 'short:size-10')}>
        <Icon className="size-5" aria-hidden="true" />
      </span>
      <span className="relative min-w-0">
        <span className="block truncate font-heading text-sihao font-medium leading-snug">{tile.title}</span>
        <span className={cn('block truncate text-sm', tile.attention ? 'text-warning' : 'text-muted-foreground')}>
          {tile.badge}
        </span>
      </span>
    </button>
  )
}
