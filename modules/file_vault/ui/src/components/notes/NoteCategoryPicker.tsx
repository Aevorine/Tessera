import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { LucideIcon } from 'lucide-react'
import { Check, ChevronDown, ChevronRight, FolderPlus, Hash, Inbox } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import type { CategoryTreeNode } from '@/lib/notes/noteFilters'
import type { NoteTag } from '@/shared/ipcTypes'
import { categoryPathLabel } from './categoryNodes'

/**
 * 编辑区的分类选择：按钮显示当前分类，点开是与顶栏同一棵树的级联菜单，底部可直接敲新分类（用 / 分
 * 级）。
 */
export function NoteCategoryPicker({
  value,
  onChange,
  tree,
  iconFor,
  labelFor,
  disabled,
}: {
  value: string
  onChange: (category: string) => void
  tree: CategoryTreeNode[]
  iconFor: (segment: string) => LucideIcon
  labelFor: (segment: string) => string
  disabled?: boolean
}) {
  const { t } = useTranslation('notes')
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const leaf = value.split('/').filter(Boolean).pop() ?? ''
  const TriggerIcon = value ? iconFor(leaf) : Inbox

  function commitDraft() {
    const next = draft
      .split('/')
      .map((part) => part.trim())
      .filter(Boolean)
      .join('/')
    if (!next) return
    onChange(next)
    setDraft('')
    setOpen(false)
  }

  function renderNodes(nodes: CategoryTreeNode[]): ReactNode {
    return nodes.map((node) => {
      const Icon = iconFor(node.segment)
      const label = labelFor(node.segment)
      const selected = value === node.fullPath
      if (node.children.length === 0) {
        return (
          <DropdownMenuItem key={node.fullPath} onSelect={() => onChange(node.fullPath)}>
            <Check className={cn('text-primary', selected ? 'opacity-100' : 'opacity-0')} aria-hidden="true" />
            <Icon className="text-muted-foreground" aria-hidden="true" />
            <span className="truncate">{label}</span>
          </DropdownMenuItem>
        )
      }
      const inBranch = selected || value.startsWith(`${node.fullPath}/`)
      return (
        <DropdownMenuSub key={node.fullPath}>
          <DropdownMenuSubTrigger>
            <Check className={cn('text-primary', inBranch ? 'opacity-100' : 'opacity-0')} aria-hidden="true" />
            <Icon className="text-muted-foreground" aria-hidden="true" />
            <span className="truncate">{label}</span>
            <ChevronRight className="ml-auto text-muted-foreground" aria-hidden="true" />
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="max-h-[min(28rem,var(--radix-dropdown-menu-content-available-height))] overflow-y-auto">
            <DropdownMenuItem onSelect={() => onChange(node.fullPath)}>
              <Check className={cn('text-primary', selected ? 'opacity-100' : 'opacity-0')} aria-hidden="true" />
              <span className="truncate">{t('categoryPickerChooseSelf', { name: label })}</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {renderNodes(node.children)}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      )
    })
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled}
          className="max-w-72 min-w-0 justify-start"
          title={t('categoryPickerLabel')}
          aria-label={t('categoryPickerLabel')}
        >
          <TriggerIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className={cn('truncate', !value && 'text-muted-foreground')}>
            {value ? categoryPathLabel(value, labelFor) : t('filterUncategorized')}
          </span>
          <ChevronDown className="size-3.5 shrink-0 opacity-60" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuItem onSelect={() => onChange('')}>
          <Check className={cn('text-primary', value === '' ? 'opacity-100' : 'opacity-0')} aria-hidden="true" />
          <Inbox className="text-muted-foreground" aria-hidden="true" />
          {t('filterUncategorized')}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {renderNodes(tree)}
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="flex items-center gap-1.5">
          <FolderPlus className="size-4" aria-hidden="true" />
          {t('categoryPickerNewLabel')}
        </DropdownMenuLabel>
        <div className="flex items-center gap-1.5 px-2 pb-1.5">
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            // 菜单会拦下按键做「按首字母跳到某一项」和方向键导航，输入框里打字不能被它吃掉。
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                commitDraft()
              }
              if (e.key !== 'Escape') e.stopPropagation()
            }}
            placeholder={t('categoryPickerNewPlaceholder')}
            aria-label={t('categoryPickerNewLabel')}
            className="h-8"
          />
          <Button type="button" size="sm" disabled={!draft.trim()} onClick={commitDraft}>
            {t('categoryPickerApply')}
          </Button>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** 编辑区的标签多选：点一下切换一个，菜单不关，方便连续勾选。 */
export function NoteTagPicker({
  tags,
  selectedIds,
  onChange,
}: {
  tags: NoteTag[]
  selectedIds: number[]
  onChange: (next: number[]) => void
}) {
  const { t } = useTranslation('notes')
  const chosen = tags.filter((tag) => selectedIds.includes(tag.id))
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" size="sm" variant="outline" className="max-w-72 min-w-0 justify-start" aria-label={t('tagsLabel')}>
          <Hash className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className={cn('truncate', chosen.length > 0 ? undefined : 'text-muted-foreground')}>
            {chosen.length > 0 ? chosen.map((tag) => tag.name).join('、') : t('tagsLabel')}
          </span>
          <ChevronDown className="size-3.5 shrink-0 opacity-60" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 w-56">
        {tags.length > 0 ? (
          tags.map((tag) => {
            const checked = selectedIds.includes(tag.id)
            return (
              <DropdownMenuItem
                key={tag.id}
                onSelect={(e) => {
                  e.preventDefault()
                  onChange(checked ? selectedIds.filter((id) => id !== tag.id) : [...selectedIds, tag.id])
                }}
              >
                <Check className={cn('text-primary', checked ? 'opacity-100' : 'opacity-0')} aria-hidden="true" />
                <span className="truncate">{tag.name}</span>
              </DropdownMenuItem>
            )
          })
        ) : (
          <p className="px-2 py-1.5 text-sm text-muted-foreground">{t('noTagsYet')}</p>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
