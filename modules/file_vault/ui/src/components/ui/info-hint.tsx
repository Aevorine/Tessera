import { Info } from 'lucide-react'

import { cn } from '@/lib/utils'

/** 说明文字的收纳处：界面上只留小图标，悬停才显示原文（由 GlobalIconTooltip 统一渲染）。 */
export function InfoHint({ text, className }: { text: string; className?: string }) {
  return (
    <span
      data-hint={text}
      aria-label={text}
      role="note"
      tabIndex={0}
      className={cn('inline-flex shrink-0 cursor-help items-center text-muted-foreground hover:text-foreground', className)}
    >
      <Info className="size-4" aria-hidden="true" />
    </span>
  )
}
