import { useEffect, useMemo, useRef, useState, type UIEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useTheme } from 'next-themes'
import { ClipboardList, FileLock2, Keyboard, KeyRound, Moon, NotebookText, PanelLeftClose, PanelLeftOpen, Sparkles, SlidersHorizontal, Sun } from 'lucide-react'
import { CHEAT_SHEET_EVENT } from '@/components/ShortcutCheatSheet'
import { useDisplayMode } from '@/lib/displayMode'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command'
import type { NavGroup, NavItem, Pane } from '@/components/AppShell'
import { vaultApi } from '@/lib/vaultApi'
import { groupSearchResults } from '@/lib/globalSearch'
import type { GlobalSearchResult } from '@/shared/ipcTypes'

const MODULE_ICONS: Record<GlobalSearchResult['module'], typeof FileLock2> = {
  clipboard: ClipboardList,
  notes: NotebookText,
  passwords: KeyRound,
}

const MODULE_PANE: Record<GlobalSearchResult['module'], Pane> = {
  clipboard: 'clipboard',
  notes: 'notes',
  passwords: 'passwords',
}

// 分组标题复用侧边栏的模块名，不另造一套叫法。分组本身（含顺序保证）在
// lib/globalSearch.ts，那边有独立用例。
const MODULE_HEADING_KEY: Record<GlobalSearchResult['module'], string> = {
  clipboard: 'navClipboard',
  notes: 'navNotes',
  passwords: 'navPasswords',
}

// 每个模块首屏渲染多少条，滚到接近底部再加一页。后端返回全部命中项，而 cmdk 把每个 CommandItem
// 都渲染成真实 DOM（筛选只加 hidden），
// 几千条一次铺出会每敲一字重排而卡。只影响渲染节奏，标题上是真实总数；后端截断做不到这点，
// 被截掉的永远滚不出来。
const RESULTS_PAGE_SIZE = 40
const SCROLL_EXTEND_THRESHOLD_PX = 160

export function CommandPalette({
  open,
  onOpenChange,
  navGroups,
  deepLinks,
  onNavigate,
  navCollapsed,
  onToggleNavCollapsed,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  navGroups: NavGroup[]
  /**
   * 侧边栏里没有但应能直接跳转的目标，目前只有清理套件的四个子标签（空间/自启/软件/工具箱）。
   * 它们在侧边栏合并成一项，命令面板也随之消失；此前注释声称保留 pane 值就是为命令面板深链，
   * 实际全仓库只有类型联合引用。
   */
  deepLinks?: NavItem[]
  onNavigate: (pane: Pane) => void
  navCollapsed: boolean
  onToggleNavCollapsed: () => void
}) {
  const { t } = useTranslation('common')
  const { theme, setTheme } = useTheme()
  const { isProfessional, toggleMode } = useDisplayMode()
  const navItems = useMemo(
    () => [...navGroups.flatMap((group) => group.items), ...(deepLinks ?? [])],
    [deepLinks, navGroups],
  )

  const [query, setQuery] = useState('')
  const [searchResults, setSearchResults] = useState<GlobalSearchResult[]>([])
  const [renderLimit, setRenderLimit] = useState(RESULTS_PAGE_SIZE)
  const debounceRef = useRef(0)

  useEffect(() => {
    const q = query.trim()
    setRenderLimit(RESULTS_PAGE_SIZE) // 换了查询词就从第一页重新数
    if (!q) {
      setSearchResults([])
      return
    }
    const token = ++debounceRef.current
    const timer = window.setTimeout(() => {
      void vaultApi.call('global_search', { query: q }).then((res) => {
        if (token !== debounceRef.current) return
        if (res.ok) setSearchResults(res.results)
      })
    }, 200)
    return () => window.clearTimeout(timer)
  }, [query])

  // Reset query when dialog opens/closes
  useEffect(() => {
    if (!open) {
      setQuery('')
      setSearchResults([])
      setRenderLimit(RESULTS_PAGE_SIZE)
    }
  }, [open])

  function runAndClose(action: () => void) {
    action()
    onOpenChange(false)
  }

  const groupedResults = useMemo(() => groupSearchResults(searchResults), [searchResults])

  const hasResults = groupedResults.length > 0
  // 只要还有哪个分组没铺完就继续接受"再来一页"。用最大的那个分组判断，别用
  // 总数——总数还剩很多但都在已经铺完的分组里时，再加页是白加。
  const largestGroupSize = useMemo(
    () => groupedResults.reduce((max, group) => Math.max(max, group.items.length), 0),
    [groupedResults],
  )

  function handleListScroll(event: UIEvent<HTMLDivElement>) {
    if (renderLimit >= largestGroupSize) return
    const list = event.currentTarget
    if (list.scrollHeight - list.scrollTop - list.clientHeight > SCROLL_EXTEND_THRESHOLD_PX) return
    setRenderLimit((current) => current + RESULTS_PAGE_SIZE)
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('commandPaletteTitle')}
      description={t('commandPaletteDescription')}
    >
      <CommandInput
        placeholder={t('commandPalettePlaceholder')}
        value={query}
        onValueChange={setQuery}
      />
      <CommandList onScroll={handleListScroll}>
        {/* 两个分支曾经写着同一个 key，看着像在区分两种情况、实际上没有。
            只有一句文案，就直接给一句。 */}
        <CommandEmpty>{t('commandPaletteEmpty')}</CommandEmpty>

        {groupedResults.map((group) => {
          const Icon = MODULE_ICONS[group.module]
          return (
            <CommandGroup
              key={`search-group-${group.module}`}
              // 标题写真实总数而非这一屏渲染的条数（以前后端把每个模块截到 5 条，界面上看不出还有没有）。
              // 条数用 `total` 而非 i18next 的 `count`：count 触发复数机制找 key_one/key_other，而 i18n
              // 检查要求六种语言键集合一致（俄语 4 档、阿语 6 档凑不出）。
              heading={`${t(MODULE_HEADING_KEY[group.module])} · ${t('commandPaletteResultCount', { total: group.items.length })}`}
            >
              {group.items.slice(0, renderLimit).map((result) => (
                <CommandItem
                  key={`search-${group.module}-${result.id}`}
                  // value 只放 module+id，不放 label：cmdk 按 value 打分重排，放 label
                  // 会让模糊打分覆盖后端相关度排序（笔记和剪贴板是 bm25）。
                  // module+id 也保证唯一：重复复制同一段文字会产生前 80 字相同的结果，用 label 会被 cmdk 当成同一项。
                  value={`search/${group.module}/${result.id}`}
                  // 后端已按查询词筛过，不能再让 cmdk 用模糊打分筛第二遍：命中位置常不在 label 里（正文词、
                  // 密码条目网址、第 80 字之后的剪贴板内容），打分为 0 会被直接不渲染，
                  // 表现为后端查到了面板却一条不显示。把查询词补进 keywords 让服务端结果一定留下；
                  // 本地导航/动作项照常筛。
                  keywords={[query.trim()]}
                  onSelect={() => runAndClose(() => onNavigate(MODULE_PANE[group.module]))}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  <span className="min-w-0 truncate">{result.label}</span>
                  {/* 模糊命中要标出来。用户输 "cwfp" 搜到「财务复盘」时，如果不说
                      明这是拼音首字母匹配的，那条结果看起来就像是搜错了——
                      而"看起来搜错了"会让人停止信任整个搜索框。
                      精确命中不带这个标，所以它同时也是"这几条是猜的"的分界线。 */}
                  {result.fuzzy && (
                    <span className="ml-auto shrink-0 rounded border border-border/70 px-1.5 py-0.5 text-sm text-muted-foreground">
                      {t('commandPaletteFuzzy')}
                    </span>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          )
        })}

        {hasResults && <CommandSeparator />}

        <CommandGroup heading={t('commandPaletteGroupNavigate')}>
          {navItems.map((item) => {
            const Icon = item.icon
            return (
              <CommandItem
                key={item.pane}
                value={item.label}
                onSelect={() => runAndClose(() => onNavigate(item.pane))}
              >
                <Icon />
                {item.label}
              </CommandItem>
            )
          })}
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading={t('commandPaletteGroupActions')}>
          {theme !== 'light' && (
            <CommandItem value={t('commandPaletteActionThemeLight')} onSelect={() => runAndClose(() => setTheme('light'))}>
              <Sun />
              {t('commandPaletteActionThemeLight')}
            </CommandItem>
          )}
          {theme !== 'dark' && (
            <CommandItem value={t('commandPaletteActionThemeDark')} onSelect={() => runAndClose(() => setTheme('dark'))}>
              <Moon />
              {t('commandPaletteActionThemeDark')}
            </CommandItem>
          )}
          <CommandItem
            value={navCollapsed ? t('commandPaletteActionExpandNav') : t('commandPaletteActionCollapseNav')}
            onSelect={() => runAndClose(() => onToggleNavCollapsed())}
          >
            {navCollapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
            {navCollapsed ? t('commandPaletteActionExpandNav') : t('commandPaletteActionCollapseNav')}
          </CommandItem>
          <CommandItem
            value={t('commandPaletteActionCheatSheet')}
            onSelect={() => runAndClose(() => window.dispatchEvent(new Event(CHEAT_SHEET_EVENT)))}
          >
            <Keyboard />
            {t('commandPaletteActionCheatSheet')}
          </CommandItem>
          <CommandItem
            value={isProfessional ? t('displayModeSwitchToSimpleHint') : t('displayModeSwitchToProfessionalHint')}
            onSelect={() => runAndClose(() => toggleMode())}
          >
            {isProfessional ? <Sparkles /> : <SlidersHorizontal />}
            {isProfessional ? t('displayModeSwitchToSimpleHint') : t('displayModeSwitchToProfessionalHint')}
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  )
}
