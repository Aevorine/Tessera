import type { LucideIcon } from 'lucide-react'
import { InfoHint } from '@/components/ui/info-hint'
import { cn } from '@/lib/utils'

/** 面板里的大按钮：图标 + 名称，原说明收进 InfoHint；toggle 用 role="switch"。 */
export function RecoveryActionCard({
  icon: Icon,
  label,
  hint,
  badge,
  disabled,
  destructive,
  toggle,
  onRun,
}: {
  icon: LucideIcon
  label: string
  hint?: string
  /** 右侧小字，例如已选数量。 */
  badge?: string
  disabled?: boolean
  destructive?: boolean
  /** 有值即为开关：true = 开。 */
  toggle?: { checked: boolean; onLabel: string; offLabel: string }
  onRun: () => void
}) {
  const isToggle = toggle !== undefined
  return (
    <div className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={onRun}
        role={isToggle ? 'switch' : undefined}
        aria-checked={isToggle ? toggle.checked : undefined}
        className={cn(
          'ds-focus-ring flex h-24 w-full min-w-0 items-center gap-3 rounded-xl border border-border/70 bg-card px-4 text-left',
          'transition-[border-color,background-color,transform] duration-200 ease-out',
          'hover:border-[var(--accent-line)] hover:bg-surface active:scale-[0.985]',
          'disabled:pointer-events-none disabled:opacity-50',
          isToggle && toggle.checked && 'border-[var(--accent-line)] bg-surface',
        )}
      >
        <span className="ds-icon-chip size-11 shrink-0 rounded-lg">
          <Icon className={cn('size-5', destructive && 'text-destructive')} aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className={cn('block font-heading font-medium leading-snug', destructive && 'text-destructive')}>{label}</span>
          {isToggle ? (
            <span className="block truncate text-sm text-muted-foreground">{toggle.checked ? toggle.onLabel : toggle.offLabel}</span>
          ) : (
            badge && <span className="block truncate text-sm text-muted-foreground">{badge}</span>
          )}
        </span>
      </button>
      {hint && <InfoHint text={hint} className="absolute top-2 right-2" />}
    </div>
  )
}

/** 一组卡片：自适应列数。 */
export function RecoveryActionGrid({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))' }}>
      {children}
    </div>
  )
}
