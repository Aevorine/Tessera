import { FileText, MonitorSmartphone, Send, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useContinuity, type ContinuityItem } from '@/lib/continuity'
import { NUMERIC_CLASS } from '@/components/ui/page'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

/**
 * 「接着刚才」提示条，置于所有面板上方（说的是别的设备上的事，与当前页无关）。必须很轻：细横带、一
 * 行字、可关闭，否则会被当噪音；关闭按 device+localId 只记内存，因为提示 90 秒就过期，持久化只会让
 * 明天的新提示被误吞。无"帮你打开"按钮，理由见lib/continuity.ts。
 */
export function ContinuityBanner() {
  const { t } = useTranslation('crossdevice')
  const items = useContinuity()
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set())

  const visible = useMemo(
    () => items.filter((item) => !dismissed.has(keyOf(item))),
    [items, dismissed],
  )

  if (visible.length === 0) return null

  return (
    <div className="flex flex-col">
      {visible.map((item) => (
        <Row
          key={keyOf(item)}
          item={item}
          label={t}
          onDismiss={() => setDismissed((prev) => new Set(prev).add(keyOf(item)))}
        />
      ))}
    </div>
  )
}

function keyOf(item: ContinuityItem): string {
  return `${item.device_id}:${item.kind}:${item.local_id}:${item.title}`
}

function Row({
  item,
  label,
  onDismiss,
}: {
  item: ContinuityItem
  label: (key: string, opts?: Record<string, unknown>) => string
  onDismiss: () => void
}) {
  const Icon = item.kind === 'transfer' ? Send : item.kind === 'note' ? FileText : MonitorSmartphone
  const showProgress = item.kind === 'transfer' && item.progress >= 0

  return (
    <div
      // role="status" 而不是 alert：alert 会打断读屏软件当前正在念的内容，
      // 而这是一条"知道就行"的信息，不是需要立刻处理的警告。
      role="status"
      className={cn(
        'flex items-center gap-3 border-b border-accent-line bg-accent-soft/60',
        'px-5 py-2 sm:px-9 lg:px-14',
      )}
    >
      <Icon aria-hidden="true" className="size-4 shrink-0 text-primary" />
      <p className="min-w-0 flex-1 truncate text-sm">
        <span className="text-muted-foreground">
          {label('continuity.prefix', { device: item.device_name })}
        </span>{' '}
        <span className="font-medium">{item.title || label('continuity.untitled')}</span>
        {showProgress && (
          <span className={cn('ml-2 text-muted-foreground', NUMERIC_CLASS)}>{item.progress}%</span>
        )}
      </p>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onDismiss}
            aria-label={label('continuity.dismiss')}
            className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent-soft hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <X className="size-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent>{label('continuity.dismiss')}</TooltipContent>
      </Tooltip>
    </div>
  )
}
