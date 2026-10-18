import { useEffect, useRef, useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/**
 * 全屏次功能面板：盖住整页，从点中的功能格处展开，返回键 / Esc 收起。
 * 不显示功能名称（从功能格进来的，名称已知），只给读屏一个标签。
 */
export function FeaturePanel({
  label,
  origin,
  backLabel,
  actions,
  onClose,
  bodyClassName,
  children,
}: {
  label: string
  /** 展开动画的圆心（相对页面左上角），没有就从中心展开。 */
  origin: { x: number; y: number } | null
  backLabel: string
  /** 返回键右侧的操作按钮。 */
  actions?: React.ReactNode
  onClose: () => void
  bodyClassName?: string
  children: React.ReactNode
}) {
  const [shown, setShown] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(true))
    rootRef.current?.focus({ preventScroll: true })
    return () => cancelAnimationFrame(id)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      // 面板里弹出的对话框 / 下拉菜单先处理自己的 Esc。
      if (document.querySelector('[role="dialog"][data-state="open"], [role="listbox"], [role="menu"]')) return
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      ref={rootRef}
      role="region"
      aria-label={label}
      tabIndex={-1}
      className={cn(
        'absolute inset-0 z-30 flex flex-col bg-background outline-none',
        'transition-[opacity,transform] duration-200 ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none',
        shown ? 'scale-100 opacity-100' : 'scale-[0.92] opacity-0',
      )}
      style={{ transformOrigin: origin ? `${origin.x}px ${origin.y}px` : 'center' }}
    >
      <div className="flex shrink-0 items-center justify-between gap-2 px-4 pt-3 pb-1">
        <Button variant="ghost" size="icon" className="size-10 rounded-full" onClick={onClose} aria-label={backLabel}>
          <ArrowLeft className="size-5" />
        </Button>
        {actions && <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">{actions}</div>}
      </div>
      <div className={cn('min-h-0 flex-1 overflow-y-auto px-8 pt-2 pb-8', bodyClassName)}>{children}</div>
    </div>
  )
}
