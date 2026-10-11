// 导入/导出文件夹的"最近使用+收藏"快速选择——点这个按钮直接用某个记住的
// 文件夹，不用每次都重新弹系统对话框去找。数据来自 lib/pathMemory.ts。
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, Star, StarOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { basenameOf, getScopeMemory, toggleFavorite, type PathMemoryScope } from '@/lib/pathMemory'

interface PathQuickPickProps {
  scope: PathMemoryScope
  ariaLabel: string
  onSelect: (dirPath: string) => void
  disabled?: boolean
}

export function PathQuickPick({ scope, ariaLabel, onSelect, disabled }: PathQuickPickProps) {
  const { t } = useTranslation('notes')
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const [, setVersion] = useState(0) // 收藏状态变化后强制重新渲染，重新读取一次 localStorage

  // localStorage 读取是微秒级的同步操作，不值得为它加 memo——直接每次渲染都
  // 读，天然保证下拉框打开、收藏状态变化后看到的都是最新数据。
  const memory = getScopeMemory(scope)
  const query = filter.trim().toLowerCase()
  const favorites = memory.favorites.filter((p) => !query || p.toLowerCase().includes(query))
  const recent = memory.recent.filter((p) => !memory.favorites.includes(p) && (!query || p.toLowerCase().includes(query)))
  const isEmpty = favorites.length === 0 && recent.length === 0

  function renderRow(p: string) {
    const isFav = memory.favorites.includes(p)
    return (
      <DropdownMenuItem
        key={p}
        className="justify-between gap-2"
        onSelect={(e) => {
          if ((e.target as HTMLElement).closest('[data-role="favorite-toggle"]')) {
            e.preventDefault()
            return
          }
          onSelect(p)
        }}
      >
        <span className="truncate" title={p}>{basenameOf(p) || p}</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              data-role="favorite-toggle"
              className="shrink-0 text-muted-foreground hover:text-foreground"
              aria-label={t(isFav ? 'pathFavoriteRemoveAriaLabel' : 'pathFavoriteAddAriaLabel')}
              onClick={(e) => {
                e.stopPropagation()
                toggleFavorite(scope, p)
                setVersion((v) => v + 1)
              }}
            >
              {isFav ? <Star className="h-3.5 w-3.5 fill-current" /> : <StarOff className="h-3.5 w-3.5" />}
            </button>
          </TooltipTrigger>
          <TooltipContent>{t(isFav ? 'pathFavoriteRemoveAriaLabel' : 'pathFavoriteAddAriaLabel')}</TooltipContent>
        </Tooltip>
      </DropdownMenuItem>
    )
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="outline" aria-label={ariaLabel} disabled={disabled}>
              <ChevronDown className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>{ariaLabel}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start">
        <div className="px-1 pb-1">
          <Input
            autoFocus
            placeholder={t('pathSearchPlaceholder')}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
            className="h-7 text-sm"
          />
        </div>
        {isEmpty && <div className="px-2 py-1.5 text-sm text-muted-foreground">{t('pathNoHistoryHint')}</div>}
        {favorites.length > 0 && (
          <>
            <DropdownMenuLabel>{t('pathFavoritesLabel')}</DropdownMenuLabel>
            {favorites.map(renderRow)}
          </>
        )}
        {favorites.length > 0 && recent.length > 0 && <DropdownMenuSeparator />}
        {recent.length > 0 && (
          <>
            <DropdownMenuLabel>{t('pathRecentLabel')}</DropdownMenuLabel>
            {recent.map(renderRow)}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
