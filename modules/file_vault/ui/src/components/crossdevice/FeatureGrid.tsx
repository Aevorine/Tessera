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

/** 功能格：铺满分到的空间，末行不满时拉宽补齐，不留空洞。 */
export function FeatureGrid({
  tiles,
  onOpen,
  className,
}: {
  tiles: FeatureTileSpec[]
  onOpen: (id: string, origin: HTMLElement) => void
  className?: string
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
    const cols = pickColumns(tiles.length, size.w, size.h)
    const out: FeatureTileSpec[][] = []
    for (let i = 0; i < tiles.length; i += cols) out.push(tiles.slice(i, i + cols))
    return out
  }, [tiles, size])

  return (
    <div ref={ref} className={cn('flex min-h-0 flex-col', className)} style={{ gap: GAP }}>
      {rows.map((row, i) => (
        <div key={i} className="flex min-h-[96px] flex-1" style={{ gap: GAP }}>
          {row.map((t) => (
            <FeatureTile key={t.id} tile={t} onOpen={onOpen} />
          ))}
        </div>
      ))}
    </div>
  )
}

function FeatureTile({ tile, onOpen }: { tile: FeatureTileSpec; onOpen: (id: string, origin: HTMLElement) => void }) {
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
      )}
    >
      <Icon
        aria-hidden="true"
        className="pointer-events-none absolute -right-4 -bottom-5 size-28 text-primary opacity-[0.06] transition-transform duration-300 ease-out group-hover:-translate-y-1 group-hover:scale-105"
      />
      <span className="ds-icon-chip size-11 rounded-xl">
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
