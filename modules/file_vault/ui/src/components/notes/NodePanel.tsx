import { useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import type { TopBarNode } from '@/components/TopBar'
import { InfoHint } from '@/components/ui/info-hint'
import { cn } from '@/lib/utils'

/**
 * 把顶栏菜单的节点数组原样画成全屏面板里的按钮列表：hidden / disabled / destructive 规则沿用节点本身，
 * 子菜单变成就地展开的列表。`onPicked` 在点中任何条目后触发（面板先收起再弹对话框用）。
 */
export function NodePanel({
  nodes,
  onPicked,
  depth = 0,
}: {
  nodes: TopBarNode[]
  onPicked: () => void
  depth?: number
}) {
  const shown: TopBarNode[] = []
  for (const node of nodes) {
    if (node.hidden) continue
    if (node.type === 'separator' && (shown.length === 0 || shown[shown.length - 1].type === 'separator')) continue
    shown.push(node)
  }
  while (shown.length > 0 && shown[shown.length - 1].type === 'separator') shown.pop()

  return (
    <div className={cn('flex flex-col gap-1.5', depth > 0 && 'border-l border-border/70 pl-3')}>
      {shown.map((node) => {
        switch (node.type) {
          case 'separator':
            return <div key={node.id} className="my-1 h-px bg-border/70" />
          case 'label':
            return (
              <div key={node.id} className="px-1 text-sm text-muted-foreground">
                {node.label}
              </div>
            )
          case 'custom':
            return <div key={node.id}>{node.node}</div>
          case 'toggle':
            return (
              <button
                key={node.id}
                type="button"
                role="switch"
                aria-checked={node.checked}
                disabled={node.disabled}
                onClick={() => node.onCheckedChange(!node.checked)}
                className={rowClass(false)}
              >
                <Check className={cn('size-4 text-primary', node.checked ? 'opacity-100' : 'opacity-0')} aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">{node.label}</span>
                {node.description && <InfoHint text={node.description} />}
              </button>
            )
          case 'submenu':
            return <SubSection key={node.id} node={node} onPicked={onPicked} depth={depth} />
          case 'item': {
            const Icon = node.icon
            return (
              <button
                key={node.id}
                type="button"
                disabled={node.disabled}
                aria-checked={node.selected}
                onClick={() => {
                  if (!node.keepOpen) onPicked()
                  node.onSelect()
                }}
                className={rowClass(Boolean(node.destructive))}
              >
                {node.selected !== undefined && (
                  <Check className={cn('size-4 text-primary', node.selected ? 'opacity-100' : 'opacity-0')} aria-hidden="true" />
                )}
                {Icon && <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
                <span className="min-w-0 flex-1 truncate">{node.label}</span>
                {node.description && <InfoHint text={node.description} />}
                {node.count !== undefined && <span className="text-2xs tabular text-muted-foreground">{node.count}</span>}
              </button>
            )
          }
        }
      })}
    </div>
  )
}

function rowClass(destructive: boolean) {
  return cn(
    'ds-focus-ring flex min-h-10 w-full items-center gap-2.5 rounded-lg border border-border/70 bg-card px-3 text-left transition-colors',
    'hover:border-[var(--accent-line)] hover:bg-surface disabled:pointer-events-none disabled:opacity-50',
    destructive && 'text-destructive',
  )
}

function SubSection({
  node,
  onPicked,
  depth,
}: {
  node: Extract<TopBarNode, { type: 'submenu' }>
  onPicked: () => void
  depth: number
}) {
  const [open, setOpen] = useState(false)
  const Icon = node.icon
  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        disabled={node.disabled}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={rowClass(false)}
      >
        {Icon && <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
        <span className="min-w-0 flex-1 truncate">{node.label}</span>
        {node.count !== undefined && <span className="text-2xs tabular text-muted-foreground">{node.count}</span>}
        <ChevronDown className={cn('size-4 text-muted-foreground transition-transform', open && 'rotate-180')} aria-hidden="true" />
      </button>
      {open && <NodePanel nodes={node.children} onPicked={onPicked} depth={depth + 1} />}
    </div>
  )
}
