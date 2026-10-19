import type { FeatureTileSpec } from '@/components/feature/FeatureGrid'
import { cn } from '@/lib/utils'

/** 功能条：列表 + 详情类页面用的单行功能格，等分宽度，放不下时自动换行。 */
export function FeatureStrip({
  tiles,
  onOpen,
  className,
}: {
  tiles: FeatureTileSpec[]
  onOpen: (id: string, origin: HTMLElement) => void
  className?: string
}) {
  return (
    <div
      className={cn('grid shrink-0 gap-3', className)}
      style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(176px, 1fr))' }}
    >
      {tiles.map((tile) => {
        const Icon = tile.icon
        return (
          <button
            key={tile.id}
            type="button"
            onClick={(e) => onOpen(tile.id, e.currentTarget)}
            aria-label={`${tile.title}，${tile.badge}`}
            data-hint={tile.title}
            className={cn(
              'ds-focus-ring group relative flex h-16 min-w-0 items-center gap-3 overflow-hidden rounded-xl border border-border/70 bg-card px-3 text-left',
              'transition-[border-color,background-color,transform] duration-200 ease-out hover:border-[var(--accent-line)] hover:bg-surface active:scale-[0.985]',
            )}
          >
            <span className="ds-icon-chip size-9 shrink-0 rounded-lg">
              <Icon className="size-4" aria-hidden="true" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-heading font-medium leading-snug">{tile.title}</span>
              <span className={cn('block truncate text-sm', tile.attention ? 'text-warning' : 'text-muted-foreground')}>
                {tile.badge}
              </span>
            </span>
          </button>
        )
      })}
    </div>
  )
}
