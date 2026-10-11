import { cn } from '@/lib/utils'
import { MetricValue } from '@/components/ui/page'

/**
 * 一块统计数字。传 `onClick` 即成为可点的筛选入口；`active` 表示列表正被此块筛着，
 * 再点取消（语义由调用方定）。不传 onClick 时保持纯展示外观。
 */
/** 可点磁贴的交互外观。默认档和紧凑档共用，免得两处各写各的 hover/焦点样式。 */
const INTERACTIVE_CLASS =
  'transition-colors hover:border-primary hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'

/** 「当前正被这一块筛着」的样子。 */
const ACTIVE_CLASS = 'border-primary bg-accent-soft text-primary'

export function StatTile({
  label,
  value,
  onClick,
  active = false,
  hint,
  compact = false,
}: {
  label: string
  /** 数字或已格式化好的字符串（如 `1.2 GB`）；格式化在调用方，单位和小数位规则因面板而异。 */
  value: number | string
  /** 不传就是纯展示（跟以前完全一样）。 */
  onClick?: () => void
  active?: boolean
  /** 悬浮提示，说明点下去会发生什么。 */
  hint?: string
  /**
   * 紧凑档：数字与标签并排、内边距收窄，专为 `PageHeader` 的 metrics 槽。
   * 默认档必须一像素不变（清理套件有 21 处在用），所以只能是额外一档。
   */
  compact?: boolean
}) {
  const body = compact ? (
    // 横排：一行之内读完「12 个服务」。竖排在标题行里会把整条带子撑高两行，
    // 那正是把磁贴搬上来要避免的事。
    <div className="flex items-baseline gap-1.5 whitespace-nowrap">
      <MetricValue size="compact">{value}</MetricValue>
      <p className="text-sm text-muted-foreground">{label}</p>
    </div>
  ) : (
    <>
      <MetricValue>{value}</MetricValue>
      <p className="text-sm text-muted-foreground">{label}</p>
    </>
  )
  // 紧凑档整块提前返回：statTilesAndEncryptCard.test.mjs 逐字钉住了默认档的
  // `<div className="rounded border p-4 text-center">` 与 `<button>`，改它们等于改守卫。
  if (compact) {
    const shell = 'rounded-md border px-2.5 py-1'
    if (!onClick) return <div className={shell}>{body}</div>
    return (
      <button
        type="button"
        onClick={onClick}
        title={hint}
        aria-pressed={active}
        className={cn(shell, INTERACTIVE_CLASS, active && ACTIVE_CLASS)}
      >
        {body}
      </button>
    )
  }
  if (!onClick) {
    return <div className="rounded border p-4 text-center">{body}</div>
  }
  return (
    <button
      type="button"
      onClick={onClick}
      title={hint}
      aria-pressed={active}
      className={cn('rounded border p-4 text-center', INTERACTIVE_CLASS, active && ACTIVE_CLASS)}
    >
      {body}
    </button>
  )
}
