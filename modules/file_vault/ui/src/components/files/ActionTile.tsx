import type { DragEvent, ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { FeatureTitle, IconChip } from '@/components/ui/page'
import { cn } from '@/lib/utils'

/**
 * 加密/解密页的动作磁贴：图标 + 名称 + 一句话 + 两颗按钮 + 一行设置摘要，两块结构对称、高度一致。
 * 设置搬进顶栏后，摘要行常驻显示这次点击实际会怎么做，破坏性项（默认开启且不可逆的"完成后安全删除
 * 原文件"）用警示色。磁贴本身是拖放目标（拖到哪个就做哪件事）；落在磁贴外仍走整页自动分流（
 * FilesPane handleDropFiles）。/
 */
export function ActionTile({
  icon,
  title,
  summary,
  status,
  dropLabel,
  dragActive,
  dropHover,
  disabled,
  onDragHover,
  onDragLeave,
  onDrop,
  children,
}: {
  icon: LucideIcon
  /** 由调用方传进 t('...') 的结果——静态测试按调用处的 t('encryptCardTitle') 定位这块磁贴。 */
  title: ReactNode
  /** 一句话说明这块做什么。 */
  summary: ReactNode
  /** 底部的设置摘要（若干 <TileStatus>）。 */
  status: ReactNode
  /** 拖着文件悬停在这块上时，盖在磁贴上的那句"松开以加密"。 */
  dropLabel: string
  /** 页面上正有文件被拖着：两块磁贴一起亮出虚线框，告诉用户"可以往这里放"。 */
  dragActive: boolean
  /** 正悬停在这一块上。 */
  dropHover: boolean
  /** 正在跑加解密：不接受新的拖放。 */
  disabled: boolean
  onDragHover: () => void
  onDragLeave: () => void
  onDrop: (event: DragEvent<HTMLDivElement>) => void
  /** 两颗按钮（主操作 + 文件夹）。以 children 传入，按钮的 onClick 留在调用处。 */
  children: ReactNode
}) {
  const acceptsDrop = dragActive && !disabled
  return (
    <div
      // 悬停用 dragover（持续触发）判定、离开时核对 relatedTarget：dragenter/
      // dragleave 在磁贴内部的子元素之间移动时也会成对触发，只靠它们高亮会一闪一闪。
      onDragOver={(event) => {
        event.preventDefault()
        if (acceptsDrop && !dropHover) onDragHover()
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onDragLeave()
      }}
      onDrop={(event) => {
        // 磁贴自己处理，不让事件冒到整页的自动分流上再处理一遍。
        event.stopPropagation()
        onDrop(event)
      }}
      className={cn(
        'relative flex h-full flex-col gap-5 rounded-xl border bg-card p-6 transition-[border-color,box-shadow,background-color] duration-150',
        acceptsDrop ? 'border-dashed border-primary/50' : 'border-border',
        acceptsDrop && dropHover && 'border-solid border-primary bg-accent-soft/40 ring-4 ring-primary/15',
      )}
    >
      {/* 说明不常驻画面，收进悬停提示。 */}
      <div className="flex items-center gap-4" data-hint={typeof summary === 'string' ? summary : undefined}>
        <IconChip icon={icon} size="lg" />
        <div className="min-w-0 flex-1">
          <FeatureTitle>{title}</FeatureTitle>
          <span className="sr-only">{summary}</span>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">{children}</div>
      <div className="mt-auto flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-border/70 pt-4">{status}</div>
      {acceptsDrop && dropHover && (
        // pointer-events-none：盖层不能抢走 dragleave/drop，事件要落在磁贴本身上。
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-xl bg-background/70 backdrop-blur-[1px]">
          <span className="rounded-full bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground shadow-sm">
            {dropLabel}
          </span>
        </div>
      )}
    </div>
  )
}

/** 设置摘要里的一项。tone="danger" 给不可逆的那一项（安全删除）。 */
export function TileStatus({
  icon: Icon,
  tone = 'muted',
  title,
  children,
}: {
  icon: LucideIcon
  tone?: 'muted' | 'accent' | 'danger'
  title?: string
  children: ReactNode
}) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex min-w-0 items-center gap-1.5 text-sm',
        tone === 'muted' && 'text-muted-foreground',
        tone === 'accent' && 'text-primary',
        tone === 'danger' && 'font-medium text-destructive',
      )}
    >
      <Icon className="size-4 shrink-0" aria-hidden="true" />
      <span className="truncate">{children}</span>
    </span>
  )
}
