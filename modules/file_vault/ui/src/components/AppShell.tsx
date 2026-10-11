import { Fragment, Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Activity, Bot, Boxes, CircleHelp, ClipboardList, FolderOpen, Gauge, GripVertical, HardDrive, KeyRound, KeySquare, Lock, MonitorSmartphone, NotebookText, PanelLeftClose, PanelLeftOpen, ScrollText, Search, Settings as SettingsIcon, ShieldCheck, Sparkles, SlidersHorizontal, Star, Wrench } from 'lucide-react'
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import { restrictToParentElement, restrictToVerticalAxis } from '@dnd-kit/modifiers'
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { DisplayModeProvider, useDisplayMode } from '@/lib/displayMode'
import { LabelModeProvider } from '@/lib/labelMode'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { CommandPalette } from '@/components/CommandPalette'
import { UnlockDialog } from '@/components/UnlockDialog'
import { LanguageSwitcher } from '@/components/LanguageSwitcher'
import { ContinuityBanner } from '@/components/ContinuityBanner'

// ---- 面板按需加载 ----
// 十个面板合计一万七千多行且各带重依赖（NotesScreen 带 CodeMirror、tesseract.js、docx、
// markdown-it、DOMPurify）；
// 静态 import 会让它们全落在入口 chunk，登录界面渲染前就要下载解析。改 React.lazy
// 后只在首次切到该面板时加载；
// 面板本就是 `pane === 'x' && <X/>` 条件挂载，与 lazy 天然吻合。
const FilesPane = lazy(() => import('@/components/FilesPane').then((m) => ({ default: m.FilesPane })))
// 清理套件的五个面板合并成一个外壳（顶部标签页），见 PcCleanSuiteScreen 的注释。
// 五个 pane 值仍然保留，命令面板和原生菜单据此深链到具体标签。
const PcCleanSuiteScreen = lazy(() => import('@/components/pcclean/PcCleanSuiteScreen').then((m) => ({ default: m.PcCleanSuiteScreen })))
const DiagnosticLogScreen = lazy(() => import('@/components/DiagnosticLogScreen').then((m) => ({ default: m.DiagnosticLogScreen })))
const SettingsScreen = lazy(() => import('@/components/SettingsScreen').then((m) => ({ default: m.SettingsScreen })))
const PasswordScreen = lazy(() => import('@/components/PasswordScreen').then((m) => ({ default: m.PasswordScreen })))
const ClipboardScreen = lazy(() => import('@/components/ClipboardScreen').then((m) => ({ default: m.ClipboardScreen })))
const CrossDeviceScreen = lazy(() => import('@/components/CrossDeviceScreen').then((m) => ({ default: m.CrossDeviceScreen })))
const SecurityHealthScreen = lazy(() => import('@/components/SecurityHealthScreen').then((m) => ({ default: m.SecurityHealthScreen })))
const AIChatScreen = lazy(() => import('@/components/AIChatScreen').then((m) => ({ default: m.AIChatScreen })))
const NotesScreen = lazy(() => import('@/components/NotesScreen').then((m) => ({ default: m.NotesScreen })))
const NetworkSpeedTestScreen = lazy(() =>
  import('@/components/NetworkSpeedTestScreen').then((m) => ({ default: m.NetworkSpeedTestScreen })),
)
const FileManagerScreen = lazy(() => import('@/components/FileManagerScreen').then((m) => ({ default: m.FileManagerScreen })))
const HelpScreen = lazy(() => import('@/components/HelpScreen').then((m) => ({ default: m.HelpScreen })))
const RecoveryCodesScreen = lazy(() => import('@/components/RecoveryCodesScreen').then((m) => ({ default: m.RecoveryCodesScreen })))

/**
 * 面板切换占位：刻意不放 spinner（chunk 在本地磁盘，几十毫秒，转圈只会闪一下更显卡），
 * 留与面板同色的空白。
 */
function PaneFallback() {
  // 用 `min-h-0 flex-1` 而非 `min-h-full`：main 上方压着横幅，100% 高度会让页面先鼓出一截再缩回，
  // 切面板时可见抖动。
  return <div className="min-h-0 w-full flex-1 bg-background" aria-busy="true" />
}
import { isPcCleanPane } from '@/lib/pccleanPanes'
import {
  addFavorite,
  loadNavPreferences,
  moveFavorite,
  removeFavorite,
  saveNavPreferences,
  type FavoritablePane,
} from '@/lib/navPrefs'
import { cn } from '@/lib/utils'
import { electronApi } from '@/lib/electronApi'
import { vaultApi } from '@/lib/vaultApi'
import type { LockableModule } from '@/shared/ipcTypes'

export type Pane = 'files' | 'clipboard' | 'crossdevice' | 'passwords' | 'recoverycodes' | 'notes' | 'ai' | 'network' | 'filemanager' | 'pcclean' | 'pccleanspace' | 'pccleanstartup' | 'pccleansoftware' | 'pccleantoolbox' | 'security' | 'settings' | 'diagnostics' | 'help'

export interface NavItem {
  pane: Pane
  label: string
  icon: typeof Lock
}

export interface NavGroup {
  label: string
  items: NavItem[]
}

// 导航栏折叠状态——折叠成一列小图标（文字隐藏，图标仍可点击跳转），跟
// 笔记模块里其它UI偏好同一套localStorage持久化模式。默认展开。
const NAV_COLLAPSED_STORAGE_KEY = 'ideal1-nav-collapsed'

function loadStoredNavCollapsed(): boolean {
  return localStorage.getItem(NAV_COLLAPSED_STORAGE_KEY) === 'true'
}

/**
 * 一个导航条目；抽出来因为它出现在常用区（拖拽把手 + 移出按钮）、全部区（加入常用按钮）、
 * 折叠态（仅图标）三种上下文，内联抄写易出现一像素高度差。
 */
function NavItemButton({
  item,
  active,
  collapsed,
  onSelect,
  className,
}: {
  item: NavItem
  active: boolean
  collapsed: boolean
  onSelect: (pane: Pane) => void
  className?: string
}) {
  const Icon = item.icon
  return (
    <button
      onClick={() => onSelect(item.pane)}
      aria-label={item.label}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'relative flex min-w-0 flex-1 items-center gap-2 py-2 text-sm transition-colors',
        collapsed ? 'justify-center px-2' : 'ps-4 pe-1 text-start',
        active
          ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
          : 'text-sidebar-foreground hover:bg-sidebar-accent/50',
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'absolute start-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-full bg-sidebar-primary transition-all duration-200',
          active ? 'scale-y-100 opacity-100' : 'scale-y-0 opacity-0',
        )}
      />
      <Icon className="h-4 w-4 shrink-0" />
      <span
        className={cn(
          'overflow-hidden whitespace-nowrap transition-all duration-200',
          collapsed ? 'w-0 opacity-0' : 'w-auto opacity-100',
        )}
      >
        {item.label}
      </span>
    </button>
  )
}

/**
 * 「加入常用 / 移出常用」：平时仅整行 hover 显形，`focus-visible:opacity-100` 保证键盘用户 Tab
 * 到时可见。
 */
function FavoriteToggleButton({
  label,
  isFavorite,
  onClick,
}: {
  label: string
  isFavorite: boolean
  onClick: () => void
}) {
  return (
    // 提示走 Radix 而不是原生 title=：原生的要等约一秒才弹、样式是系统灰底，
    // 跟应用里别处的提示对不上，观感上就是"悬停没反应"。
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          aria-label={label}
          aria-pressed={isFavorite}
          className={cn(
            'me-1 flex size-6 shrink-0 items-center justify-center rounded transition-opacity',
            'text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-foreground',
            'focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sidebar-primary',
            'opacity-0 group-hover:opacity-100',
          )}
        >
          <Star className={cn('size-4', isFavorite && 'fill-current text-sidebar-primary')} aria-hidden="true" />
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

/**
 * 常用区可拖拽排序的一行。把手是独立按钮而非整行：整行可拖会把点击判成微小拖动，
 * 最常用的入口反而难点。
 * @dnd-kit 的 KeyboardSensor 挂在把手上（Tab 到把手、空格拿起、方向键移动、空格放下），
 * 即键盘替代路径。
 */
function SortableFavoriteRow({
  item,
  active,
  onSelect,
  onRemove,
  removeLabel,
  dragLabel,
}: {
  item: NavItem
  active: boolean
  onSelect: (pane: Pane) => void
  onRemove: () => void
  removeLabel: string
  dragLabel: string
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.pane })
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn('group relative flex items-center', isDragging && 'z-10 opacity-80')}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            {...attributes}
            {...listeners}
            aria-label={dragLabel}
            className="ms-1 flex size-5 shrink-0 cursor-grab items-center justify-center rounded text-sidebar-foreground/40 opacity-0 transition-opacity hover:text-sidebar-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sidebar-primary group-hover:opacity-100"
          >
            <GripVertical className="size-4" aria-hidden="true" />
          </button>
        </TooltipTrigger>
        <TooltipContent>{dragLabel}</TooltipContent>
      </Tooltip>
      <NavItemButton item={item} active={active} collapsed={false} onSelect={onSelect} className="ps-1" />
      <FavoriteToggleButton label={removeLabel} isFavorite onClick={onRemove} />
    </div>
  )
}

export function AppShell(props: { pendingImportPath: string | null; onPendingImportConsumed: () => void }) {
  return (
    <DisplayModeProvider>
      <LabelModeProvider>
        <AppShellInner {...props} />
      </LabelModeProvider>
    </DisplayModeProvider>
  )
}

function AppShellInner({
  pendingImportPath,
  onPendingImportConsumed,
}: {
  pendingImportPath: string | null
  onPendingImportConsumed: () => void
}) {
  const { t } = useTranslation('common')
  // 清理套件的导航文案在自己的命名空间里。挤进 common.json 会让那个每次
  // 冷启动都要加载的文件多背五个只在一个模块里用得到的键。
  const { t: tClean } = useTranslation('pcclean')
  const { isProfessional, toggleMode, setMode: setDisplayMode } = useDisplayMode()
  // 这里的 useMemo 修的是真失效的缓存：两个数组原先每次 render 新建，传给 <CommandPalette/> 后其
  // useMemo 依赖（这两个引用）
  // 每次父组件重渲都变，从未生效。依赖只有翻译函数 t（切语言才重建），其余时候引用必须稳定。
  const NAV_GROUPS: NavGroup[] = useMemo(() => [
    { label: t('navFiles'), items: [{ pane: 'files', label: t('navFilesItem'), icon: Lock }] },
    { label: t('navClipboard'), items: [{ pane: 'clipboard', label: t('navClipboardItem'), icon: ClipboardList }] },
    { label: t('navCrossDevice'), items: [{ pane: 'crossdevice', label: t('navCrossDeviceItem'), icon: MonitorSmartphone }] },
    {
      label: t('navAccount'),
      items: [
        { pane: 'passwords', label: t('navPasswords'), icon: KeyRound },
        { pane: 'recoverycodes', label: t('navRecoveryCodes'), icon: KeySquare },
      ],
    },
    { label: t('navNotes'), items: [{ pane: 'notes', label: t('navNotesItem'), icon: NotebookText }] },
    { label: t('navAi'), items: [{ pane: 'ai', label: t('navAiChatItem'), icon: Bot }] },
    { label: t('navNetwork'), items: [{ pane: 'network', label: t('navNetworkItem'), icon: Gauge }] },
    // 清理套件在侧边栏只占一项：体检/空间/自启/软件/工具箱是同一件事的五个视角，
    // 做成内容区顶部标签（PcCleanSuiteScreen），平铺会淹掉侧边栏。
    {
      label: tClean('nav.group'),
      items: [{ pane: 'pcclean', label: tClean('nav.group'), icon: Sparkles }],
    },
    // 文件管理器紧跟在清理套件（末尾是「工具箱」标签）之后、「设置」之前。
    // 位置是用户指定的：它是"整理文件"这条线的收尾，挨着清理、挨着设置。
    { label: t('navFileManager'), items: [{ pane: 'filemanager', label: t('navFileManagerItem'), icon: FolderOpen }] },
    {
      label: t('navOther'),
      items: [
        { pane: 'security', label: t('navSecurity'), icon: ShieldCheck },
        { pane: 'settings', label: t('navSettings'), icon: SettingsIcon },
        { pane: 'diagnostics', label: t('navDiagnostics'), icon: ScrollText },
        { pane: 'help', label: t('navHelp'), icon: CircleHelp },
      ],
    },
  ], [t, tClean])
  /**
   * 清理套件四个子标签的深链：侧边栏只显示「电脑清理」，但命令面板必须能直接跳到某个标签（Ctrl+K
   * 搜「工具箱」）。
   * 此前 pccleanPanes.ts 与 PcCleanSuiteScreen.tsx 的注释声称有此深链，实际全仓库只有 Pane
   * 类型联合引用了这四个值。
   */
  const PCCLEAN_DEEP_LINKS: NavItem[] = useMemo(() => [
    { pane: 'pccleanspace', label: tClean('nav.space'), icon: HardDrive },
    { pane: 'pccleanstartup', label: tClean('nav.startup'), icon: Activity },
    { pane: 'pccleansoftware', label: tClean('nav.software'), icon: Boxes },
    { pane: 'pccleantoolbox', label: tClean('nav.toolbox'), icon: Wrench },
  ], [tClean])

  // 首屏就是文件加解密面板——这个应用的主功能，不需要用户先点一下才到得了。
  const [pane, setPane] = useState<Pane>('files')
  const [navCollapsed, setNavCollapsed] = useState<boolean>(loadStoredNavCollapsed)
  const [paletteOpen, setPaletteOpen] = useState(false)

  /**
   * 窗口窄到一定程度时自动收起侧栏。侧栏展开固定 184px，窗口 700px 时内容区放不下一张表格；
   * 阈值 900px ≈ 184(侧栏) + 640(两列表格) + 留白。
   * 只在跨过阈值的那一刻改一次，不每次渲染按宽度强制，以免覆盖用户的手动选择。
   */
  const wasNarrowRef = useRef<boolean | null>(null)
  useEffect(() => {
    const NARROW_PX = 900
    const apply = () => {
      const narrow = window.innerWidth < NARROW_PX
      if (wasNarrowRef.current === narrow) return // 没跨过门槛，什么都不做
      const first = wasNarrowRef.current === null
      wasNarrowRef.current = narrow
      // 首次挂载时只在"窄"的情况下收起：宽窗口下要尊重上次存下来的偏好。
      if (first && !narrow) return
      setNavCollapsed(narrow)
    }
    apply()
    window.addEventListener('resize', apply)
    return () => window.removeEventListener('resize', apply)
  }, [])

  function changeNavCollapsed(collapsed: boolean) {
    setNavCollapsed(collapsed)
    localStorage.setItem(NAV_COLLAPSED_STORAGE_KEY, String(collapsed))
  }

  // ---- 常用区 ----
  // 用户自己决定置顶哪些入口和顺序；读写与净化在 lib/navPrefs.ts（localStorage 是不可信输入，
  // 存脏必须安全退回默认，不能让侧边栏抛异常拖垮外壳）。
  const [favorites, setFavorites] = useState<FavoritablePane[]>(() => loadNavPreferences().favorites)
  const favoriteSet = useMemo(() => new Set<Pane>(favorites), [favorites])
  const changeFavorites = useCallback((next: FavoritablePane[]) => {
    setFavorites(next)
    saveNavPreferences({ favorites: next })
  }, [])
  const toggleFavorite = useCallback(
    (target: FavoritablePane, makeFavorite: boolean) => {
      setFavorites((current) => {
        const next = makeFavorite ? addFavorite(current, target) : removeFavorite(current, target)
        if (next !== current) saveNavPreferences({ favorites: next })
        return next
      })
    },
    [],
  )

  // 拖拽要 4px 的位移才算数：把手很小，点它的时候手指/鼠标难免抖一两像素，
  // 没有这个阈值的话"按一下把手"会被判成一次零距离拖拽，把焦点吃掉。
  const dndSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  const handleFavoriteDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active: dragged, over } = event
      if (!over || dragged.id === over.id) return
      changeFavorites(moveFavorite(favorites, dragged.id as FavoritablePane, over.id as FavoritablePane))
    },
    [changeFavorites, favorites],
  )

  /** 常用区显示的条目。顺序完全由 favorites 决定，不跟着 NAV_GROUPS 的排布走。 */
  const favoriteItems = useMemo(() => {
    const byPane = new Map<Pane, NavItem>()
    for (const group of NAV_GROUPS) {
      for (const item of group.items) byPane.set(item.pane, item)
    }
    return favorites
      .map((favorite) => byPane.get(favorite))
      .filter((item): item is NavItem => item !== undefined)
  }, [NAV_GROUPS, favorites])

  // 各模块是否「每次点击都要求重新验证一个解锁因子」由设置页配置，持久化在
  // module_lock_settings.json（见 ui_settings.py）；
  // 'settings' 面板的强制验证是硬编码行为（见 handleNavClick），不经过这份 map。
  const [moduleLocks, setModuleLocks] = useState<Record<LockableModule, boolean>>({
    files: false,
    clipboard: false,
    passwords: false,
    recoverycodes: false,
    notes: false,
    ai: false,
    network: false,
    filemanager: false,
    pcclean: false,
  })

  useEffect(() => {
    vaultApi.call('module_lock_settings_get', {}).then((res) => {
      if (res.ok) setModuleLocks(res.settings)
    })
  }, [])

  // 从原 MainScreen 搬来：ensureFreshlyUnlocked 依赖这份 state + UnlockDialog，
  // 点「设置」要求重新验证是刻意的安全行为，不能只搬函数不搬弹窗。
  // 弹窗自动发起生物识别不等于自动通过，用户仍须真的验证一次。
  const [unlockDialogOpen, setUnlockDialogOpen] = useState(false)
  const unlockResolverRef = useRef<((ok: boolean) => void) | null>(null)

  // useCallback：它既是 handleNavClick 的依赖又是传给剪贴板/笔记面板的 prop，
  // 不稳定会让两个大面板每次外壳重渲都收到新回调；只碰 ref 和 setState，空依赖正确。
  const ensureFreshlyUnlocked = useCallback(async (): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      unlockResolverRef.current = resolve
      setUnlockDialogOpen(true)
    })
  }, [])

  function handleUnlockDialogOpenChange(open: boolean) {
    setUnlockDialogOpen(open)
    if (!open && unlockResolverRef.current) {
      unlockResolverRef.current(false)
      unlockResolverRef.current = null
    }
  }

  function handleUnlocked() {
    unlockResolverRef.current?.(true)
    unlockResolverRef.current = null
  }

  // 清理套件 5 个标签共用一个锁（LockableModule 里只有 'pcclean'）；把 pane 折算成锁 key，直接拿
  // pane 名查表会让 'pccleanspace' 等查不到而锁形同虚设。
  const lockKeyFor = useCallback(
    (target: Pane): LockableModule | null => {
      if (isPcCleanPane(target)) return 'pcclean'
      return target in moduleLocks ? (target as LockableModule) : null
    },
    [moduleLocks],
  )

  // 命令面板拿它当 prop。以前它是个函数声明，每次 render 都是新引用——配合上面
  // 那两个每次新建的数组，命令面板那边的记忆化等于全线失效。
  const handleNavClick = useCallback(async (target: Pane): Promise<boolean> => {
    const key = lockKeyFor(target)
    // 套件内部换标签页不再验证：`onPaneChange` 走的也是这个函数，不排除的话
    // 用户每点一次标签就弹一次解锁框，等于把功能锁死。判据是"从套件外面进来"。
    const enteringFromOutside = !(isPcCleanPane(target) && isPcCleanPane(pane))
    const needsUnlock =
      target === 'settings' || (key !== null && moduleLocks[key] && enteringFromOutside)
    if (needsUnlock && !(await ensureFreshlyUnlocked())) return false
    setPane(target)
    return true
  }, [ensureFreshlyUnlocked, lockKeyFor, moduleLocks, pane])

  /** 侧边栏的点击入口。返回值只有原生菜单那几条路用得上，这里不需要。 */
  const handleNavSelect = useCallback((target: Pane) => {
    void handleNavClick(target)
  }, [handleNavClick])

  // Ctrl+K 快速切换：仅 Windows 应用，无需 Cmd/metaKey 分支；文本框有焦点时忽略，以免劫持正常输入。
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!e.ctrlKey || e.key.toLowerCase() !== 'k') return
      const target = e.target as HTMLElement | null
      const isEditable =
        target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable
      if (isEditable) return
      e.preventDefault()
      setPaletteOpen((open) => !open)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  useEffect(() => {
    return electronApi.onNavigate((target) => {
      if (target === 'notes') void handleNavClick('notes')
      else if (target === 'files') void handleNavClick('files')
      else if (target === 'clipboard') void handleNavClick('clipboard')
      else if (target === 'passwords') void handleNavClick('passwords')
      else if (target === 'recoverycodes') void handleNavClick('recoverycodes')
      else if (target === 'ai') void handleNavClick('ai')
      else if (target === 'network') void handleNavClick('network')
      else if (target === 'filemanager') void handleNavClick('filemanager')
      // 「查看 → 清理套件」曾是死链：菜单发 sendNav('pcclean') 而这里无对应分支，
      // 静默无事发生（tests/menuAccelerators 的守卫早已报红）。
      else if (target === 'pcclean') void handleNavClick('pcclean')
      else if (target === 'settings') void handleNavClick('settings')
      else if (target === 'help') void handleNavClick('help')
      else if (target === 'crossdevice') void handleNavClick('crossdevice')
      else if (target === 'diagnostics') void handleNavClick('diagnostics')
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one native navigation subscription; handleNavClick is intentionally current enough for the mounted shell's lock state
  }, [])

  // 「编辑 → 命令面板」。菜单和 Ctrl+K 走同一个 setPaletteOpen，两条入口
  // 行为完全一致——菜单项存在的意义是让这个快捷键**被看见**，不是另开一套。
  useEffect(() => {
    return electronApi.onOpenCommandPalette(() => setPaletteOpen(true))
  }, [])

  // 全局速记快捷键（Ctrl+Shift+N，见 main.ts QUICK_NOTE_SHORTCUT）：监听必须挂在这里而非
  // NotesScreen（仅 pane==='notes' 才挂载，
  // 笔记模块开了强制解锁时事件会在解锁弹窗完成前丢失）；先走带解锁校验的 handleNavClick，
  // 确认切到笔记面板后经 pendingQuickCapture 转交。
  const [pendingQuickCapture, setPendingQuickCapture] = useState(false)
  useEffect(() => {
    return electronApi.onQuickCapture(() => {
      handleNavClick('notes').then((navigated) => {
        if (navigated) setPendingQuickCapture(true)
      })
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one native subscription; handleNavClick is intentionally current enough for the mounted shell's lock state
  }, [])

  // 「打开方式」打开的文件：跳到笔记面板并同样走 handleNavClick
  // 的模块进入验证（不能因为走文件打开路径就绕过）；
  // 验证被取消就丢弃这次待导入，不留到下次。真正导入由传给 NotesScreen 的 pendingImportPath 处理。
  useEffect(() => {
    if (!pendingImportPath) return
    handleNavClick('notes').then((navigated) => {
      if (!navigated) onPendingImportConsumed()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-run when a new path arrives
  }, [pendingImportPath])

  return (
    <TooltipProvider delayDuration={200}>
      {/* h-screen + overflow-hidden，不是 min-h-screen：前者给整棵树一个确定的
          高度，flex-1 才有东西可分；后者只保证下限，于是里面任何想吃满剩余高度
          的东西都只能自己去减视口高度。
          **花括号不能省。** JSX 的子节点位置上，裸的斜杠星号不是注释而是文本，
          会被原样渲染到界面上——2026-08-19 就是这么把这段话印到用户屏幕上的。 */}
      <div className="flex h-screen overflow-hidden bg-background">
      {/* ---- 侧边栏：**三段式**，中间那段自己滚 -----------------------------
          原先它是一整条 `flex flex-col`，十三个入口一路排到底，谁都没管
          "排不下怎么办"。它自己的 overflow 是默认的 `visible`，所以裁它的是
          外面那个 `h-screen overflow-hidden` —— 没有滚动条、滚轮也没反应，
          底下的入口就是**够不着**。

          2026-08-19 真浏览器实测（scripts/layout-probe.mjs）：
              1920×1080   侧栏内容溢出 144px，「帮助」「简洁/专业模式」够不着
              1280×720    溢出 504px，**16 个控件够不着**——网络测速、电脑清理、
                          文件管理器、设置、诊断、帮助整段消失

          这也是探针原来的 `clipped` 检测抓不到它的原因：那条只认
          `overflow-y: hidden` 的盒子，而这里裁人的是祖先。判据因此改成用户能
          感知的那一条——"在视口外，且从它到根没有任何一层能滚到它"。

          三段的分法不是随手切的，按"够不着的代价"排：
            上（不滚）语言 + 命令面板。命令面板是够不着任何入口时的**兜底路径**，
                       它自己绝不能被滚走。
            中（滚）  常用区 + 全部功能。长度不可控，只有它该滚。
            下（不滚）简洁/专业模式 + 折叠按钮。折叠按钮被滚走的话，窄窗口下
                       用户连"把侧栏收起来腾地方"这条自救路都没有。 */}
      <aside
        className={cn(
          'flex min-h-0 shrink-0 flex-col border-r border-sidebar-border bg-sidebar py-5 transition-[width] duration-200 ease-in-out',
          // 展开态从 160px 放宽到 184px：常用区每行要多容下一个拖拽把手和一颗
          // 星，160px 下功能名会被截断——一个读不全的入口等于没置顶。
          navCollapsed ? 'w-12' : 'w-[184px]',
        )}
      >
        {!navCollapsed && (
          <div className="mb-1 shrink-0 px-4 pb-2">
            <LanguageSwitcher className="w-full" />
          </div>
        )}
        <div className="mb-2 shrink-0 px-2">
          {(() => {
            const trigger = (
              <button
                type="button"
                onClick={() => setPaletteOpen(true)}
                aria-label={t('commandPaletteTrigger')}
                className={cn(
                  'flex w-full items-center gap-2 rounded-md border border-sidebar-border bg-sidebar-accent/40 py-1.5 text-sm text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent',
                  navCollapsed ? 'justify-center px-0' : 'px-2.5',
                )}
              >
                <Search className="h-3.5 w-3.5 shrink-0" />
                {!navCollapsed && <span className="flex-1 text-left">{t('commandPaletteTrigger')}</span>}
                {!navCollapsed && <kbd className="rounded border border-sidebar-border px-1 text-2xs text-sidebar-foreground/60">Ctrl K</kbd>}
              </button>
            )
            return navCollapsed ? (
              <Tooltip>
                <TooltipTrigger asChild>{trigger}</TooltipTrigger>
                <TooltipContent side="right">{t('commandPaletteTrigger')} (Ctrl K)</TooltipContent>
              </Tooltip>
            ) : (
              trigger
            )
          })()}
        </div>
        {/* 中段：唯一会滚的一段。`min-h-0` 不能省——flex 子项默认
            `min-height:auto`，会一直撑到内容高度而拒绝收缩，`overflow-y-auto`
            就永远不生效（这正是这个 bug 的成因）。
            `overscroll-contain` 挡住滚动链：列表滚到底之后滚轮不再往外冒泡，
            否则会连带把右边的内容区也带着跳一下。 */}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {/* ---- 常用区 ----------------------------------------------------
            置顶，而且**折叠态照样在**：把常用做成"只有展开才有"，等于对所有
            把侧边栏收起来的人不存在，而那正是最在意屏幕空间、也最需要快捷入口
            的一群人。折叠态下它是一列图标 + 一条分隔线，跟展开态同序。 */}
        {favoriteItems.length > 0 && (
          <div className="mb-1">
            {!navCollapsed && (
              <p className="px-4 pb-1 pt-2 text-2xs font-medium uppercase tracking-wider text-muted-foreground">
                {t('navFavoritesHeading')}
              </p>
            )}
            {navCollapsed
              ? favoriteItems.map((item) => (
                  <Tooltip key={item.pane}>
                    <TooltipTrigger asChild>
                      <div className="flex items-center">
                        <NavItemButton
                          item={item}
                          active={pane === item.pane}
                          collapsed
                          onSelect={handleNavSelect}
                        />
                      </div>
                    </TooltipTrigger>
                    <TooltipContent side="right">{item.label}</TooltipContent>
                  </Tooltip>
                ))
              : (
                <DndContext
                  sensors={dndSensors}
                  collisionDetection={closestCenter}
                  modifiers={[restrictToVerticalAxis, restrictToParentElement]}
                  onDragEnd={handleFavoriteDragEnd}
                >
                  <SortableContext items={favorites} strategy={verticalListSortingStrategy}>
                    {favoriteItems.map((item) => (
                      <SortableFavoriteRow
                        key={item.pane}
                        item={item}
                        active={pane === item.pane}
                        onSelect={handleNavSelect}
                        onRemove={() => toggleFavorite(item.pane as FavoritablePane, false)}
                        removeLabel={t('navRemoveFavorite', { name: item.label })}
                        dragLabel={t('navReorderFavorite', { name: item.label })}
                      />
                    ))}
                  </SortableContext>
                </DndContext>
              )}
            <div className="mx-2 mt-2 border-t border-sidebar-border" aria-hidden="true" />
          </div>
        )}

        {/* ---- 全部功能 --------------------------------------------------
            常用区是它的一个视图，不是它的替代品：每一项在这里都还在原位，
            置顶只改变"第二份拷贝出现在哪"。没有这条保证的话，用户会因为
            "我怕它从列表里消失"而不敢用置顶。 */}
        {!navCollapsed && favoriteItems.length > 0 && (
          <p className="px-4 pb-1 pt-2 text-2xs font-medium uppercase tracking-wider text-muted-foreground">
            {t('navAllHeading')}
          </p>
        )}
        {NAV_GROUPS.map((group) => (
          <div key={group.label} className="mb-1">
            {!navCollapsed && (
              <p className="px-4 pb-1 pt-2 text-2xs font-medium uppercase tracking-wider text-muted-foreground">
                {group.label}
              </p>
            )}
            {group.items.map((item) => {
              const active = pane === item.pane
              const isFavorite = favoriteSet.has(item.pane)
              const navRow = (
                <div className="group flex items-center">
                  <NavItemButton
                    item={item}
                    active={active}
                    collapsed={navCollapsed}
                    onSelect={handleNavSelect}
                  />
                  {!navCollapsed && (
                    <FavoriteToggleButton
                      label={
                        isFavorite
                          ? t('navRemoveFavorite', { name: item.label })
                          : t('navAddFavorite', { name: item.label })
                      }
                      isFavorite={isFavorite}
                      onClick={() => toggleFavorite(item.pane as FavoritablePane, !isFavorite)}
                    />
                  )}
                </div>
              )
              return navCollapsed ? (
                <Tooltip key={item.pane}>
                  <TooltipTrigger asChild>{navRow}</TooltipTrigger>
                  <TooltipContent side="right">{item.label}</TooltipContent>
                </Tooltip>
              ) : (
                <Fragment key={item.pane}>{navRow}</Fragment>
              )
            })}
          </div>
        ))}
        </div>
        {/* 下段：常驻。`shrink-0` 保证它不会被上面那段挤扁——没有它的话，
            flex 会先压缩这两颗按钮再考虑让中段滚。 */}
        <div className="shrink-0 border-t border-sidebar-border pt-1">
        {(() => {
          const modeToggleHint = isProfessional ? t('displayModeSwitchToSimpleHint') : t('displayModeSwitchToProfessionalHint')
          if (navCollapsed) {
            const collapsedButton = (
              <button
                type="button"
                onClick={toggleMode}
                aria-label={modeToggleHint}
                className="flex w-full items-center justify-center px-2 py-2 text-sidebar-foreground transition-colors hover:bg-sidebar-accent/50"
              >
                {isProfessional ? <SlidersHorizontal className="h-4 w-4 shrink-0" /> : <Sparkles className="h-4 w-4 shrink-0" />}
              </button>
            )
            return (
              <Tooltip>
                <TooltipTrigger asChild>{collapsedButton}</TooltipTrigger>
                <TooltipContent side="right">{modeToggleHint}</TooltipContent>
              </Tooltip>
            )
          }
          return (
            <div className="px-2 pb-1">
              <div className="flex rounded-md border border-sidebar-border bg-sidebar-accent/20 p-0.5 text-sm" role="radiogroup" aria-label={t('displayModeGroupLabel')}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={!isProfessional}
                  onClick={() => setDisplayMode('simple')}
                  className={cn(
                    'flex flex-1 items-center justify-center gap-1 rounded py-1 transition-colors',
                    !isProfessional ? 'bg-sidebar text-sidebar-primary font-medium shadow-sm' : 'text-sidebar-foreground/70 hover:text-sidebar-foreground',
                  )}
                >
                  <Sparkles className="h-3 w-3 shrink-0" />
                  {t('displayModeSimple')}
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={isProfessional}
                  onClick={() => setDisplayMode('professional')}
                  className={cn(
                    'flex flex-1 items-center justify-center gap-1 rounded py-1 transition-colors',
                    isProfessional ? 'bg-sidebar text-sidebar-primary font-medium shadow-sm' : 'text-sidebar-foreground/70 hover:text-sidebar-foreground',
                  )}
                >
                  <SlidersHorizontal className="h-3 w-3 shrink-0" />
                  {t('displayModeProfessional')}
                </button>
              </div>
            </div>
          )
        })()}
        {(() => {
          const collapseLabel = navCollapsed ? t('navExpandButton') : t('navCollapseButton')
          const collapseButton = (
            <button
              type="button"
              onClick={() => changeNavCollapsed(!navCollapsed)}
              aria-label={collapseLabel}
              className={cn(
                'flex w-full items-center gap-2 py-2 text-sm text-sidebar-foreground transition-colors hover:bg-sidebar-accent/50',
                navCollapsed ? 'justify-center px-2' : 'px-4',
              )}
            >
              {navCollapsed ? <PanelLeftOpen className="h-4 w-4 shrink-0" /> : <PanelLeftClose className="h-4 w-4 shrink-0" />}
              <span
                className={cn(
                  'overflow-hidden whitespace-nowrap transition-all duration-200',
                  navCollapsed ? 'w-0 opacity-0' : 'w-auto opacity-100',
                )}
              >
                {t('navCollapseButton')}
              </span>
            </button>
          )
          return navCollapsed ? (
            <Tooltip>
              <TooltipTrigger asChild>{collapseButton}</TooltipTrigger>
              <TooltipContent side="right">{collapseLabel}</TooltipContent>
            </Tooltip>
          ) : (
            collapseButton
          )
        })()}
        </div>
      </aside>

      {/* 有界的 flex 列。`overflow-y-auto` 从这里挪进了 PageShell：
          文档型页面（帮助/设置）由 PageShell 自己滚，工作台页面（PageShell fill）
          则一格都不滚、把高度分给左右两栏。滚动条留在 main 上的话，两种页面
          只能二选一——而它们的需求正好相反。 */}
      <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {/* 「接着刚才」：别的设备上还有没做完的事。放在面板之上、Suspense 之外——
            它说的不是"这一页有什么"，而是"别的设备上有什么"，跟当前面板无关；
            放进 Suspense 里会在每次切面板时跟着 fallback 闪一下。 */}
        <ContinuityBanner />
        {/* 一个 Suspense 包住全部面板就够：同一时刻只有一个面板挂载，
            切换时旧的先卸载、新的再加载，边界不会被两个面板同时触发。 */}
        <Suspense fallback={<PaneFallback />}>
          {pane === 'files' && <FilesPane isProfessional={isProfessional} />}
          {pane === 'clipboard' && <ClipboardScreen ensureFreshlyUnlocked={ensureFreshlyUnlocked} isProfessional={isProfessional} />}
          {pane === 'crossdevice' && <CrossDeviceScreen />}
          {pane === 'passwords' && <PasswordScreen isProfessional={isProfessional} />}
          {pane === 'recoverycodes' && <RecoveryCodesScreen isProfessional={isProfessional} />}
          {pane === 'notes' && (
            <NotesScreen
              ensureFreshlyUnlocked={ensureFreshlyUnlocked}
              pendingImportPath={pendingImportPath}
              onPendingImportHandled={onPendingImportConsumed}
              pendingQuickCapture={pendingQuickCapture}
              onQuickCaptureHandled={() => setPendingQuickCapture(false)}
              isProfessional={isProfessional}
            />
          )}
          {pane === 'ai' && <AIChatScreen onGoToSettings={() => handleNavClick('settings')} isProfessional={isProfessional} />}
          {pane === 'network' && <NetworkSpeedTestScreen isProfessional={isProfessional} />}
          {pane === 'filemanager' && <FileManagerScreen isProfessional={isProfessional} />}
          {isPcCleanPane(pane) && (
            <PcCleanSuiteScreen pane={pane} onPaneChange={(next) => void handleNavClick(next)} />
          )}
          {pane === 'settings' && <SettingsScreen moduleLocks={moduleLocks} onModuleLocksChange={setModuleLocks} isProfessional={isProfessional} />}
          {pane === 'security' && <SecurityHealthScreen />}
          {pane === 'diagnostics' && <DiagnosticLogScreen />}
          {pane === 'help' && <HelpScreen />}
        </Suspense>
      </main>

      <UnlockDialog open={unlockDialogOpen} onOpenChange={handleUnlockDialogOpenChange} onUnlocked={handleUnlocked} />
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        navGroups={NAV_GROUPS}
        deepLinks={PCCLEAN_DEEP_LINKS}
        onNavigate={handleNavClick}
        navCollapsed={navCollapsed}
        onToggleNavCollapsed={() => changeNavCollapsed(!navCollapsed)}
      />
    </div>
    </TooltipProvider>
  )
}
