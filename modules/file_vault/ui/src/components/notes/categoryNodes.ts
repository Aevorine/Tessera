import type { LucideIcon } from 'lucide-react'
import type { TopBarNode } from '@/components/TopBar'
import type { CategoryTreeNode } from '@/lib/notes/noteFilters'

/**
 * 分类树 → 顶栏菜单节点：有子分类的节点是子菜单，首项是「这一类（含子分类）」，层数由数据决定，叶
 * 子直接可选。同一棵树在顶栏用两次（筛选、批量移动），只在回调和"当前选中"判断上不同，故抽成纯函数
 * 。/
 */
export function categoryTreeToNodes(
  nodes: CategoryTreeNode[],
  opts: {
    idPrefix: string
    /** 当前选中的完整路径；不需要"当前选中"语义（批量移动）时传 undefined。 */
    selected?: string
    onSelect: (fullPath: string) => void
    countFor?: (fullPath: string) => number
    iconFor?: (segment: string) => LucideIcon
    labelFor?: (segment: string) => string
    /** 子菜单里第一项的文字，例如「工作（含子分类）」。 */
    selfLabel: (label: string) => string
  },
): TopBarNode[] {
  const { idPrefix, selected, onSelect, countFor, iconFor, labelFor, selfLabel } = opts
  return nodes.map((node): TopBarNode => {
    const label = labelFor ? labelFor(node.segment) : node.segment
    const icon = iconFor?.(node.segment)
    const count = countFor?.(node.fullPath)
    const isSelected = selected === node.fullPath
    const id = `${idPrefix}-${node.fullPath}`
    if (node.children.length === 0) {
      return {
        id,
        type: 'item',
        label,
        icon,
        count,
        selected: selected === undefined ? undefined : isSelected,
        onSelect: () => onSelect(node.fullPath),
      }
    }
    return {
      id,
      type: 'submenu',
      label,
      icon,
      count,
      // 选中的是这一支里的任何一层，触发器都亮一个点：展开前就知道当前筛在哪一支下面。
      active: selected !== undefined && (isSelected || selected.startsWith(`${node.fullPath}/`)),
      children: [
        {
          id: `${id}-self`,
          type: 'item',
          label: selfLabel(label),
          count,
          selected: selected === undefined ? undefined : isSelected,
          onSelect: () => onSelect(node.fullPath),
        },
        { id: `${id}-sep`, type: 'separator' },
        ...categoryTreeToNodes(node.children, opts),
      ],
    }
  })
}

/** 「工作/项目A/需求」→「工作 › 项目A › 需求」，给顶栏触发器上的当前值用。 */
export function categoryPathLabel(path: string, labelFor?: (segment: string) => string): string {
  return path
    .split('/')
    .filter((part) => part.length > 0)
    .map((part) => (labelFor ? labelFor(part) : part))
    .join(' › ')
}
