import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { LucideIcon } from 'lucide-react'
import { Captions } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useLabelMode } from '@/lib/labelMode'
import { cn } from '@/lib/utils'

// 通用图标工具栏：组图标开关 + 每个展开组一行功能图标。组/项都是纯配置数组，加按钮只需加一项；条目
// 支持 node（任意控件原样嵌入），hidden 让条件渲染留在配置里。组展开状态按 storageKey 各自持久化；"
// 仅图标 / 图标+文字"读 lib/labelMode.tsx 的区域偏好（labelRegion），与列表行 ActionButton 共享，否
// 则切了文字模式下面的按钮不变。toggleGroup 联动：展开组强制切成图标+文字，收起强制切回纯图标；这是
// 无条件覆盖（展开时用户在找具体功能，收起时只想省地方），与"记住区域选择"用同一个状态，不会打架。

export interface IconToolbarItem {
  id: string
  label: string
  icon?: LucideIcon
  onClick?: () => void
  active?: boolean
  disabled?: boolean
  destructive?: boolean
  hidden?: boolean
  node?: React.ReactNode
}

export interface IconToolbarGroup {
  id: string
  label: string
  icon: LucideIcon
  items: IconToolbarItem[]
  hidden?: boolean
}

function storageKeyFor(storageKey: string): string {
  return `ideal1-icon-toolbar-${storageKey}`
}

function loadOpenGroups(storageKey: string, defaults: string[]): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(storageKeyFor(storageKey))
    if (raw) {
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed === 'object' && parsed !== null) {
        const result: Record<string, boolean> = {}
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof value === 'boolean') result[key] = value
        }
        return result
      }
    }
  } catch {
    // 损坏的持久化状态按首次使用处理
  }
  return Object.fromEntries(defaults.map((id) => [id, true]))
}

export interface IconToolbarProps {
  storageKey: string
  /** 这个工具栏的文字显隐跟哪个区域偏好绑定，见 lib/labelMode.tsx 的 LABEL_REGIONS */
  labelRegion: string
  groups: IconToolbarGroup[]
  defaultOpenGroupIds?: string[]
  align?: 'start' | 'end'
  className?: string
}

/**
 * 把工具栏拆成可分开摆放的两半：`controls`（组开关 + 文字标签开关，页面级，可放进 `<PageHeader
 * actions>`）和 `panels`（展开后的功能按钮），避免三颗按钮在分隔线下白占一整行（实测 40px）。用
 * hook 返回两个节点而非两个组件：状态留在调用方、同一次 render 天然同步，不必再套 Provider 而改页面
 * 最外层结构。
 */
// eslint-disable-next-line react-refresh/only-export-components -- 这个 hook 就是 <IconToolbar> 的实现本身（组件只是"两半连着摆"的那个写法），拆到另一个文件只会让改一处要跳两个文件
export function useIconToolbar(props: IconToolbarProps): {
  controls: React.ReactNode
  panels: React.ReactNode
} {
  const {
    storageKey,
    labelRegion,
    groups,
    defaultOpenGroupIds = [],
    align = 'start',
    className,
  } = props
  const { t } = useTranslation('common')
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(() =>
    loadOpenGroups(storageKey, defaultOpenGroupIds)
  )
  const { showLabels, setMode } = useLabelMode(labelRegion)

  // 不再对外抛 onShowLabelsChange：文字显隐是 labelMode context 的共享状态，需要的组件自己
  // useLabelMode 读同一区域。
  function setShowLabels(next: boolean) {
    setMode(next ? 'labels' : 'icons')
  }

  function toggleGroup(groupId: string) {
    // 目标值从当前 openGroups 直接算，不在 setState updater 里给外层变量赋值：并发渲染下 updater 可能延
    // 后或重复调用（StrictMode 跑两遍即此坑）。
    const opened = !openGroups[groupId]
    const next = { ...openGroups, [groupId]: opened }
    setOpenGroups(next)
    localStorage.setItem(storageKeyFor(storageKey), JSON.stringify(next))
    // 强制联动：展开一组 → 图标+文字；收起 → 纯图标+悬停提示。无条件覆盖，
    // 见文件顶部注释里对"为什么盖掉用户手动设置"的说明。
    setShowLabels(opened)
  }

  function toggleLabels() {
    setShowLabels(!showLabels)
  }

  const visibleGroups = groups.filter((group) => !group.hidden)
  const rowAlign = align === 'end' ? 'justify-end' : 'justify-start'

  const controls = (
    <TooltipProvider delayDuration={300}>
        <div className={cn('flex flex-wrap items-center gap-1', rowAlign)}>
          {visibleGroups.map((group) => {
            const GroupIcon = group.icon
            const open = !!openGroups[group.id]
            return (
              <Tooltip key={group.id}>
                <TooltipTrigger asChild>
                  <Button
                    size="sm"
                    variant={open ? 'default' : 'outline'}
                    aria-pressed={open}
                    aria-label={group.label}
                    onClick={() => toggleGroup(group.id)}
                  >
                    <GroupIcon className="h-4 w-4" />
                    {showLabels && <span className="text-sm">{group.label}</span>}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{open ? t('toolbarHideGroupTooltip', { group: group.label }) : t('toolbarShowGroupTooltip', { group: group.label })}</TooltipContent>
              </Tooltip>
            )
          })}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="sm"
                variant="ghost"
                aria-pressed={showLabels}
                aria-label={showLabels ? t('toolbarIconsOnly') : t('toolbarShowLabels')}
                onClick={toggleLabels}
              >
                <Captions className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{showLabels ? t('toolbarIconsOnly') : t('toolbarShowLabels')}</TooltipContent>
          </Tooltip>
        </div>
    </TooltipProvider>
  )

  // 一组都没展开时**整块不画**。留一个空的 div 会在标题行和列表之间多出一段
  // 说不清来历的间隙（外层是 flex + gap，空节点照样吃一份 gap）。
  const openVisible = visibleGroups.filter(
    (group) => openGroups[group.id] && group.items.some((item) => !item.hidden),
  )
  const panels = openVisible.length === 0 ? null : (
    <TooltipProvider delayDuration={300}>
      <div className={cn('space-y-1.5', className)}>
        {visibleGroups.map((group) => {
          if (!openGroups[group.id]) return null
          const items = group.items.filter((item) => !item.hidden)
          if (items.length === 0) return null
          return (
            <div key={group.id} className={cn('flex flex-wrap items-center gap-1 rounded-md border bg-muted/30 p-1.5', rowAlign)}>
              {items.map((item) => {
                if (item.node !== undefined) {
                  // 自定义控件（Select、下拉菜单等）补 Tooltip；asChild 套在控件根元素上，不插 DOM 节点以免打乱 flex
                  // 布局。
                  return (
                    <Tooltip key={item.id}>
                      <TooltipTrigger asChild>
                        <span className="inline-flex">{item.node}</span>
                      </TooltipTrigger>
                      <TooltipContent>{item.label}</TooltipContent>
                    </Tooltip>
                  )
                }
                const ItemIcon = item.icon
                const itemButton = (
                  <Button
                    size="sm"
                    variant={item.destructive ? 'destructive' : item.active ? 'default' : 'outline'}
                    disabled={item.disabled}
                    aria-label={item.label}
                    onClick={item.onClick}
                  >
                    {ItemIcon && <ItemIcon className="h-4 w-4" />}
                    {showLabels && <span className="text-sm">{item.label}</span>}
                  </Button>
                )
                return (
                  <Tooltip key={item.id}>
                    {/*
                      禁用的按钮不派发 pointer 事件，Radix 收不到 hover，Tooltip 就永远
                      不弹。这一排图标默认多半是禁用的（没选中文件时复制/剪切/删除全灰），
                      而那正是最需要看到名字的时候。套一层还能收事件的 span 接住 hover，
                      按钮本身保持 disabled 不变。见 ActionButton 里同样的处理。
                    */}
                    <TooltipTrigger asChild>
                      {item.disabled ? (
                        <span className="pointer-events-auto inline-flex" tabIndex={0} aria-label={item.label}>
                          {itemButton}
                        </span>
                      ) : (
                        itemButton
                      )}
                    </TooltipTrigger>
                    <TooltipContent>{item.label}</TooltipContent>
                  </Tooltip>
                )
              })}
            </div>
          )
        })}
      </div>
    </TooltipProvider>
  )

  return { controls, panels }
}

/**
 * 两半连在一起的原样写法，用于文件管理器和笔记列表栏：那里的工具栏是列表栏级开关，应紧挨着它管的内
 * 容。
 */
export function IconToolbar(props: IconToolbarProps) {
  const { controls, panels } = useIconToolbar(props)
  return (
    <div className="space-y-1.5">
      {controls}
      {panels}
    </div>
  )
}
