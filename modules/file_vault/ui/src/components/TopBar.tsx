import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { LucideIcon } from 'lucide-react'
import { Check, ChevronDown, Search, X } from 'lucide-react'
import {
  Menubar,
  MenubarCheckboxItem,
  MenubarContent,
  MenubarItem,
  MenubarLabel,
  MenubarMenu,
  MenubarSeparator,
  MenubarSub,
  MenubarSubContent,
  MenubarSubTrigger,
  MenubarTrigger,
} from '@/components/ui/menubar'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

/**
 * 一行顶栏：页面全部功能和当前状态都在这一行。每组功能是一个菜单，可逐级展开（层数由数据决定），
 * 当前选中项写在触发器上（「分类 · 链接 › github.com」）。
 * 菜单和条目是纯数组配置，条件显隐用 `hidden`；剪贴板、笔记、恢复码、加解密四页共用。
 */

interface NodeBase {
  id: string
  hidden?: boolean
}

export interface TopBarItemNode extends NodeBase {
  type: 'item'
  label: string
  icon?: LucideIcon
  onSelect: () => void
  /** 单选语义里的「当前选中」：左边画一个勾。 */
  selected?: boolean
  /** 右侧灰色小数字（这一类有几条）。 */
  count?: number
  /** 第二行灰色说明。 */
  description?: string
  shortcut?: string
  disabled?: boolean
  destructive?: boolean
  /** 选完菜单不关（连续切换多个开关时用）。 */
  keepOpen?: boolean
}

export interface TopBarToggleNode extends NodeBase {
  type: 'toggle'
  label: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  description?: string
  disabled?: boolean
}

export interface TopBarSubmenuNode extends NodeBase {
  type: 'submenu'
  label: string
  icon?: LucideIcon
  count?: number
  /** 这一支里有东西正被选着：触发器加一个小圆点，展开前就看得出来。 */
  active?: boolean
  disabled?: boolean
  children: TopBarNode[]
  /** 子项多于这个数时，顶上出现一个过滤框。默认 12。 */
  searchThreshold?: number
}

export interface TopBarSeparatorNode extends NodeBase {
  type: 'separator'
}

export interface TopBarLabelNode extends NodeBase {
  type: 'label'
  label: string
}

export interface TopBarCustomNode extends NodeBase {
  type: 'custom'
  node: ReactNode
}

export type TopBarNode =
  | TopBarItemNode
  | TopBarToggleNode
  | TopBarSubmenuNode
  | TopBarSeparatorNode
  | TopBarLabelNode
  | TopBarCustomNode

export interface TopBarMenu {
  id: string
  label: string
  icon: LucideIcon
  /** 当前状态，直接写在触发器上（「链接 › github.com」）。 */
  value?: string
  /** 这个菜单管的维度正处于非默认状态（正在筛选等）：触发器换成强调色。 */
  active?: boolean
  /** 给了就在触发器右边出一颗 ×，一键回到默认。只在 active 时出现。 */
  onClear?: () => void
  items: TopBarNode[]
  hidden?: boolean
  disabled?: boolean
  /** 菜单面板的最小宽度类名，默认 min-w-52。 */
  contentClassName?: string
}

function visible<T extends NodeBase>(nodes: T[]): T[] {
  return nodes.filter((node) => !node.hidden)
}

/** 去掉首尾和连续的分隔线——条件隐藏掉一段之后，最容易留下两条挨着的线。 */
function tidySeparators(nodes: TopBarNode[]): TopBarNode[] {
  const out: TopBarNode[] = []
  for (const node of nodes) {
    if (node.type === 'separator') {
      if (out.length === 0 || out[out.length - 1].type === 'separator') continue
    }
    out.push(node)
  }
  while (out.length > 0 && out[out.length - 1].type === 'separator') out.pop()
  return out
}

function CountBadge({ count }: { count?: number }) {
  if (count === undefined) return null
  return <span className="ml-auto pl-3 text-2xs tabular text-muted-foreground">{count}</span>
}

function ItemBody({ node }: { node: TopBarItemNode }) {
  const Icon = node.icon
  return (
    <>
      {node.selected !== undefined && (
        <Check className={cn('size-4 text-primary', node.selected ? 'opacity-100' : 'opacity-0')} aria-hidden="true" />
      )}
      {Icon && <Icon className="text-muted-foreground" aria-hidden="true" />}
      <span className="flex min-w-0 flex-col">
        <span className="truncate">{node.label}</span>
        {node.description && (
          <span className="max-w-72 text-sm leading-snug whitespace-normal text-muted-foreground">{node.description}</span>
        )}
      </span>
      {node.shortcut ? (
        <span className="ml-auto pl-4 text-2xs tracking-widest text-muted-foreground">{node.shortcut}</span>
      ) : (
        <CountBadge count={node.count} />
      )}
    </>
  )
}

function renderNodes(nodes: TopBarNode[]): ReactNode {
  return tidySeparators(visible(nodes)).map((node) => {
    switch (node.type) {
      case 'separator':
        return <MenubarSeparator key={node.id} />
      case 'label':
        return <MenubarLabel key={node.id}>{node.label}</MenubarLabel>
      case 'custom':
        return <div key={node.id}>{node.node}</div>
      case 'toggle':
        return (
          <MenubarCheckboxItem
            key={node.id}
            checked={node.checked}
            disabled={node.disabled}
            onCheckedChange={(v) => node.onCheckedChange(v === true)}
            // 开关类的连着点好几个很常见，每点一个就关一次菜单太烦。
            onSelect={(event) => event.preventDefault()}
          >
            <span className="flex min-w-0 flex-col">
              <span>{node.label}</span>
              {node.description && (
                <span className="max-w-72 text-sm leading-snug whitespace-normal text-muted-foreground">
                  {node.description}
                </span>
              )}
            </span>
          </MenubarCheckboxItem>
        )
      case 'submenu':
        return <SubmenuNode key={node.id} node={node} />
      case 'item':
        return (
          <MenubarItem
            key={node.id}
            disabled={node.disabled}
            destructive={node.destructive}
            aria-checked={node.selected}
            onSelect={(event) => {
              if (node.keepOpen) event.preventDefault()
              node.onSelect()
            }}
          >
            <ItemBody node={node} />
          </MenubarItem>
        )
    }
  })
}

function nodeMatches(node: TopBarNode, query: string): boolean {
  if (node.type === 'item' || node.type === 'submenu' || node.type === 'toggle') {
    return node.label.toLowerCase().includes(query)
  }
  return false
}

function SubmenuNode({ node }: { node: TopBarSubmenuNode }) {
  const { t } = useTranslation('common')
  const [query, setQuery] = useState('')
  const Icon = node.icon
  const children = visible(node.children)
  const searchable = children.length > (node.searchThreshold ?? 12)
  const q = query.trim().toLowerCase()
  const shown = useMemo(
    () => (searchable && q ? children.filter((child) => nodeMatches(child, q)) : children),
    [children, searchable, q],
  )
  return (
    <MenubarSub onOpenChange={(open) => !open && setQuery('')}>
      <MenubarSubTrigger disabled={node.disabled}>
        {Icon && <Icon className="text-muted-foreground" aria-hidden="true" />}
        <span className="truncate">{node.label}</span>
        {node.active && <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-hidden="true" />}
        <CountBadge count={node.count} />
      </MenubarSubTrigger>
      <MenubarSubContent>
        {searchable && (
          <div className="sticky -top-1 z-10 -mx-1 -mt-1 mb-1 border-b border-border/70 bg-popover px-2 py-1.5">
            <label className="flex items-center gap-2 rounded-md bg-muted/60 px-2 py-1">
              <Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                // 菜单会拦下按键做「按首字母跳到某一项」，输入框里打字不能被它吃掉。
                onKeyDown={(e) => {
                  if (e.key !== 'Escape') e.stopPropagation()
                }}
                placeholder={t('topbarFilterPlaceholder')}
                aria-label={t('topbarFilterPlaceholder')}
                className="w-full min-w-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
            </label>
          </div>
        )}
        {shown.length === 0 ? (
          <p className="px-2 py-3 text-center text-sm text-muted-foreground">{t('topbarNoMatches')}</p>
        ) : (
          renderNodes(shown)
        )}
      </MenubarSubContent>
    </MenubarSub>
  )
}

export function TopBar({
  menus,
  leading,
  trailing,
  className,
  'aria-label': ariaLabel,
}: {
  menus: TopBarMenu[]
  /** 左端：统计数字等「这一页现在什么状况」。 */
  leading?: ReactNode
  /** 右端：搜索框、主操作。 */
  trailing?: ReactNode
  className?: string
  'aria-label'?: string
}) {
  const { t } = useTranslation('common')
  const shownMenus = visible(menus)
  // 放不下时逐级收：0 全显示 → 1 去掉当前值 → 2 只留图标（悬停显示名称与当前值）。
  const barRef = useRef<HTMLDivElement>(null)
  const [level, setLevel] = useState(0)
  const lastWidth = useRef(0)
  const signature = shownMenus.map((m) => `${m.id}:${m.value ?? ''}`).join('|')
  useLayoutEffect(() => setLevel(0), [signature])
  useLayoutEffect(() => {
    const el = barRef.current
    if (el && level < 2 && el.scrollWidth > el.clientWidth + 1) setLevel(level + 1)
  }, [level, signature])
  useLayoutEffect(() => {
    const el = barRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth
      if (w > lastWidth.current + 1) setLevel(0)
      lastWidth.current = w
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return (
    // 一行，绝不折行：折成两行就又回到「功能铺满好几行」的老样子了。
    // 放不下时菜单区自己横向滚动，两端的统计和搜索框保持可见。
    <div className={cn('@container flex w-full min-w-0 flex-nowrap items-center gap-2', className)}>
      {leading && <div className="flex shrink-0 items-center gap-1.5">{leading}</div>}
      <Menubar
        ref={barRef}
        aria-label={ariaLabel ?? t('topbarMenuLabel')}
        className="scrollbar-none min-w-0 flex-1 overflow-x-auto rounded-lg border border-border/70 bg-surface/70 p-0.5"
      >
        {shownMenus.map((menu) => {
          const Icon = menu.icon
          return (
            <div key={menu.id} className="flex shrink-0 items-center">
              <MenubarMenu>
                <MenubarTrigger
                  disabled={menu.disabled}
                  aria-label={level === 2 ? (menu.value ? `${menu.label} · ${menu.value}` : menu.label) : undefined}
                  className={cn(menu.active && 'bg-accent-soft text-primary hover:bg-accent-soft hover:text-primary')}
                >
                  <Icon aria-hidden="true" />
                  {level < 2 && <span>{menu.label}</span>}
                  {menu.value && level === 0 && (
                    <span
                      className={cn(
                        // 窄窗口先让「当前值」让位，菜单名本身保留。
                        'max-w-44 truncate font-normal @max-4xl:hidden',
                        menu.active ? 'text-primary' : 'text-muted-foreground',
                      )}
                    >
                      · {menu.value}
                    </span>
                  )}
                  <ChevronDown className="size-3.5 opacity-60" aria-hidden="true" />
                </MenubarTrigger>
                <MenubarContent className={menu.contentClassName}>{renderNodes(menu.items)}</MenubarContent>
              </MenubarMenu>
              {menu.active && menu.onClear && <ClearButton label={menu.label} onClear={menu.onClear} />}
            </div>
          )
        })}
      </Menubar>
      {trailing && <div className="flex shrink-0 items-center gap-2">{trailing}</div>}
    </div>
  )
}

function ClearButton({ label, onClear }: { label: string; onClear: () => void }) {
  const { t } = useTranslation('common')
  const text = t('topbarClear', { name: label })
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClear}
          aria-label={text}
          className="-ml-1 mr-0.5 inline-flex size-6 items-center justify-center rounded-md text-primary/70 transition-colors hover:bg-accent-soft hover:text-primary"
        >
          <X className="size-3.5" aria-hidden="true" />
        </button>
      </TooltipTrigger>
      <TooltipContent>{text}</TooltipContent>
    </Tooltip>
  )
}

/** 顶栏右端用的紧凑搜索框。 */
export function TopBarSearch({
  id,
  value,
  onChange,
  placeholder,
  className,
}: {
  /** 给快捷键聚焦用（笔记页的 Ctrl+F 找的是 #note-search）。 */
  id?: string
  value: string
  onChange: (value: string) => void
  placeholder: string
  className?: string
}) {
  const { t } = useTranslation('common')
  return (
    <label
      className={cn(
        'flex h-9 w-56 items-center gap-2 rounded-lg border border-border/70 bg-background px-2.5 transition-colors focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30 @max-3xl:w-40',
        className,
      )}
    >
      <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className="w-full min-w-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
      />
      {value && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => onChange('')}
              className="text-muted-foreground hover:text-foreground"
              aria-label={t('topbarClearSearch')}
            >
              <X className="size-3.5" aria-hidden="true" />
            </button>
          </TooltipTrigger>
          <TooltipContent>{t('topbarClearSearch')}</TooltipContent>
        </Tooltip>
      )}
    </label>
  )
}
