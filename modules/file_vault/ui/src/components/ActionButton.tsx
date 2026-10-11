import { forwardRef, type ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useLabelMode } from '@/lib/labelMode'
import { cn } from '@/lib/utils'

// 图标 + 文字 + 悬停提示三合一的操作按钮（此前裸 aria-label 对鼠标用户无提示，
// 一排七个相近图标难以分辨）。
// 不变量：1) label 必填，不存在只给图标不给名字的路径；2) Tooltip 永远挂着，
// 图标模式下它是唯一可辨认途径；
// 3) aria-label 永远写死为 label，不随文字显隐变化（显式 aria-label 取代而非叠加可见文本，
// 两种模式无障碍行为一致）。
// 用 forwardRef 因为会被放进 DropdownMenuTrigger / dnd-kit 的 asChild，要往下传 ref 和事件处理器。

export interface ActionButtonProps {
  /** 功能名字。同时用于可见文字、Tooltip 内容和 aria-label —— 一处定义，三处一致。 */
  label: string
  icon?: LucideIcon
  /** 用哪个区域的标签偏好，见 lib/labelMode.tsx 的 LABEL_REGIONS */
  region: string
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void
  variant?: 'ghost' | 'outline' | 'default' | 'destructive' | 'secondary'
  size?: 'sm' | 'xs' | 'default' | 'lg'
  disabled?: boolean
  className?: string
  /** 按下态（筛选类按钮用），会同时反映到 aria-pressed */
  active?: boolean
  /** 覆盖 Tooltip 文案（比如需要额外补一句解释时）；不传就用 label */
  tooltip?: ReactNode
  /** 阻止事件冒泡——列表行里的按钮几乎都需要，避免点按钮顺带触发整行的点击 */
  stopPropagation?: boolean
}

export const ActionButton = forwardRef<HTMLButtonElement, ActionButtonProps>(function ActionButton(
  {
    label,
    icon: Icon,
    region,
    onClick,
    variant = 'ghost',
    size = 'sm',
    disabled,
    className,
    active,
    tooltip,
    stopPropagation = false,
    ...rest
  },
  ref,
) {
  const { showLabels } = useLabelMode(region)

  const button = (
    <Button
      ref={ref}
      size={size}
      variant={variant}
      disabled={disabled}
      aria-label={label}
      aria-pressed={active === undefined ? undefined : active}
      className={cn(className)}
      onClick={(event) => {
        if (stopPropagation) event.stopPropagation()
        onClick?.(event)
      }}
      {...rest}
    >
      {Icon && <Icon className="h-4 w-4" />}
      {showLabels && <span className="text-sm">{label}</span>}
    </Button>
  )

  return (
    <Tooltip>
      {/*
        禁用的按钮**不派发 pointer 事件**，于是 Radix 永远收不到 hover，
        Tooltip 也就永远不弹。而工具栏里的图标默认多半是禁用的（没选中文件时
        复制/剪切/删除全灰），那恰恰是用户最需要知道"这个图标是干嘛的"的时刻——
        表现就是"界面里的图标悬停没有任何提示"。

        标准解法是套一层还能收事件的包装元素：按钮自己保持 disabled（点不动、
        无障碍语义正确），hover 由外面这层 span 接住。
        pointer-events-auto 是必需的——Button 在 disabled 时会带上
        pointer-events-none，不显式恢复的话这层 span 也一起哑掉。
      */}
      <TooltipTrigger asChild>
        {disabled ? (
          <span className="pointer-events-auto inline-flex" tabIndex={0} aria-label={label}>
            {button}
          </span>
        ) : (
          button
        )}
      </TooltipTrigger>
      <TooltipContent>{tooltip ?? label}</TooltipContent>
    </Tooltip>
  )
})
