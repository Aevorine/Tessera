import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  } from '@dnd-kit/core'
import { restrictToParentElement,
  restrictToVerticalAxis } from '@dnd-kit/modifiers'
import { arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import DOMPurify from 'dompurify'
import {
  ClipboardList,
  Code,
  CopyCheck,
  Layers,
  SquarePen,
  Download,
  EyeOff,
  FileText,
  Filter,
  GripVertical,
  ListFilter,
  PanelRight,
  PanelsTopLeft,
  Image as ImageIcon,
  Sigma,
  Link as LinkIcon,
  Mail,
  Phone,
  Pin,
  PinOff,
  Plus,
  RotateCcw,
  Square,
  SquareCheck,
  Trash2,
  Type,
  Upload,
  User,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ActionButton } from '@/components/ActionButton'
import { TopBar, TopBarSearch, type TopBarMenu, type TopBarNode } from '@/components/TopBar'
import { StatTile } from '@/components/StatTile'
import { ClipboardImageViewer, type ViewerImage } from '@/components/ClipboardImageViewer'
// 保存动作在查看器自己那边做（它的工具栏上有切换按钮），这里只负责读初值。
import { loadClipboardImageViewMode, type ClipboardImageViewMode } from '@/lib/clipboardImagePrefs'
import { EmptyState, NUMERIC_CLASS, PageHeader, PageShell } from '@/components/ui/page'
import { Workbench, WorkbenchDetailBody, WorkbenchDetailHeader } from '@/components/ui/workbench'
import {
  ClipboardDetailActions,
  ClipboardRowMenu,
  type AiClipboardAction as ClipboardAiAction,
  type ClipboardActionHandlers,
} from '@/components/clipboard/ClipboardEntryActions'
import { applyQuickConvert, type QuickConvertKind } from '@/lib/clipboardConvert'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { vaultApi } from '@/lib/vaultApi'
import { electronApi } from '@/lib/electronApi'
import { useDebouncedValue } from '@/lib/useDebouncedValue'
import { LABEL_REGIONS } from '@/lib/labelMode'
import { translateError } from '@/i18n/errors'
import type {
  ClipboardContentType,
  ClipboardDuplicateGroup,
  ClipboardEntry,
  ClipboardNearDuplicateGroup,
} from '@/shared/ipcTypes'
import { copyText } from '@/lib/clipboard'
import {
  ALL_CATEGORIES,
  buildFacets,
  matchesCategory,
  UNKNOWN_FACET,
  type ClipCategoryPath,
  type ClipFacetDim,
} from '@/lib/clipboardFacets'
import { composeRecipeDraft, extractPlaceholders, fillRecipe } from '@/lib/recipe'

// Used to phrase the translate prompt in natural language ("Translate to
// Chinese") since the AI model itself doesn't understand our i18n codes.
const AI_TARGET_LANGUAGE_NAMES: Record<string, string> = {
  zh: 'Chinese',
  en: 'English',
  fr: 'French',
  es: 'Spanish',
  ru: 'Russian',
  ar: 'Arabic',
}

const IMPORT_DELETE_SOURCE_KEY = 'ideal1-clipboard-import-delete-source'

type AiClipboardAction = ClipboardAiAction
type DedupeScope = 'all' | 'pinned' | 'hidden'

// 重复组的 is_pinned / is_hidden 是组内所有记录的 OR 结果；合并以整组为单位，不能拆开只删一半，
// 否则下次扫描仍是同一组重复项。
function groupsForDedupeScope(groups: ClipboardDuplicateGroup[], scope: DedupeScope): ClipboardDuplicateGroup[] {
  if (scope === 'pinned') return groups.filter((group) => group.is_pinned)
  if (scope === 'hidden') return groups.filter((group) => group.is_hidden)
  return groups
}

const TYPE_ICONS: Record<ClipboardContentType, typeof Type> = {
  text: Type,
  url: LinkIcon,
  email: Mail,
  phone: Phone,
  code: Code,
  name: User,
  image: ImageIcon,
  formula: Sigma,
}

// 公式排在代码前面，跟 classifier.py 的判定顺序一致，也符合"先看是不是式子
// 再看是不是代码"的直觉。'all' 分类天然包含公式，不需要额外处理。
const FILTERABLE_TYPES: ClipboardContentType[] = ['text', 'url', 'email', 'phone', 'formula', 'code', 'name', 'image']

// 富文本条目存的是来源应用的原始 HTML，不可信，直接 dangerouslySetInnerHTML 有 XSS 风险，
// 必须先清洗。
// 保留 style 属性（行内格式靠它），禁掉能引入外部/全局样式或可执行内容的标签；DOMPurify 默认已禁
// script，显式列出是防升级后默认值悄悄变化。
const RICH_TEXT_FORBID_TAGS = ['script', 'style', 'iframe', 'object', 'embed', 'form', 'link', 'meta']

function sanitizeRichText(html: string): string {
  return DOMPurify.sanitize(html, { FORBID_TAGS: RICH_TEXT_FORBID_TAGS })
}

// 单纯按最新在前排序，不因置顶提前，与后端 storage.fetch_recent 一致；
// 置顶优先只在「只看置顶」视图成立，
// 靠 filtered 的过滤条件而非排序权重。新记录经推送插入后本地重排，不必重拉列表。
function sortEntries(entries: ClipboardEntry[]): ClipboardEntry[] {
  return [...entries].sort((a, b) => b.id - a.id)
}

export function ClipboardScreen({
  ensureFreshlyUnlocked,
  isProfessional = false,
}: {
  ensureFreshlyUnlocked: () => Promise<boolean>
  isProfessional?: boolean
}) {
  const { t, i18n } = useTranslation('clipboard')
  const { t: tCommon } = useTranslation('common')
  const [viewMode, setViewMode] = useState<'active' | 'trash' | 'snippets'>('active')
  const [entries, setEntries] = useState<ClipboardEntry[]>([])
  const [trash, setTrash] = useState<ClipboardEntry[]>([])
  const [snippets, setSnippets] = useState<ClipboardEntry[]>([])
  const [snippetDialogOpen, setSnippetDialogOpen] = useState(false)
  const [snippetDraftText, setSnippetDraftText] = useState('')
  // （这里原本有一个 showRowLabels 状态，从工具栏的 localStorage 键里读"行内
  // 按钮要不要显示文字"，但从来没有真正被行渲染用到——它带着一条
  // eslint-disable 和一句 `if (x === null) void 0` 的空语句只为压掉未使用告警。
  // 现在行内按钮走 ActionButton 直接读 lib/labelMode.tsx 的区域偏好，这份影子
  // 状态没有存在的理由了。）
  // null = 新建；否则是正在编辑的片段 id（跟密码管理页 detailId 只存 id
  // 不存整个对象是同一个理由，保存后不用额外同步一份"当前编辑对象"）。
  // 正在填的那条配方，以及每个空位当前填了什么。见 lib/recipe.ts。
  const [recipeEntry, setRecipeEntry] = useState<ClipboardEntry | null>(null)
  const [recipeValues, setRecipeValues] = useState<Record<string, string>>({})
  const [editingSnippetId, setEditingSnippetId] = useState<number | null>(null)
  const [savingSnippet, setSavingSnippet] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  // 分类路径：类型 ▸ 维度 ▸ 值（链接 ▸ 按域名 ▸ github.com）。子分类全部从
  // 数据里算出来，见 lib/clipboardFacets.ts。typeFilter 是它的第一层，拖拽排序
  // 等只关心"有没有按类型筛"的地方继续读它。
  const [category, setCategory] = useState<ClipCategoryPath>(ALL_CATEGORIES)
  const typeFilter = category.type
  // 跟 typeFilter 是独立的两个维度（是否置顶 vs 内容类型），不是互斥单选，
  // 这样"只看置顶的图片"这种组合也能用同一套筛选表达出来。
  const [pinnedOnly, setPinnedOnly] = useState(false)
  // 「只看非置顶」是「只看置顶」的镜像开关，两者互斥；配合已有的全选/Ctrl+A/删除选中项即两条完整批量
  // 路径，无需另起一套选择/删除逻辑。
  const [unpinnedOnly, setUnpinnedOnly] = useState(false)
  // 「只看隐藏」是进入隐藏条目的唯一入口（filtered 平时无条件排除隐藏项），所以只在打开时验证一次，
  // 退出无需验证；设计同 NotesScreen.tsx handleToggleHiddenOnly。
  const [hiddenOnly, setHiddenOnly] = useState(false)
  // 选段复制放进独立对话框：行本体是「点击即粘贴」的可点击区域，行内选字会与点击语义打架。
  const [partialCopyEntry, setPartialCopyEntry] = useState<ClipboardEntry | null>(null)
  const partialCopyTextareaRef = useRef<HTMLTextAreaElement>(null)
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  // 右栏正在显示哪一条。存 id 不存整条：编辑/刷新之后详情自动跟着新数据走，
  // 条目被删掉后 find() 返回 undefined，右栏自动回到占位，不用额外清理。
  const [detailId, setDetailId] = useState<number | null>(null)
  // 导入后是否安全删除原文件，默认开：导出文件是明文剪贴板历史，留在下载目录就是不设防的副本；
  // 用户关掉后按其选择（存 localStorage）。
  const [deleteSourceOnImport, setDeleteSourceOnImport] = useState<boolean>(() => {
    try {
      return localStorage.getItem(IMPORT_DELETE_SOURCE_KEY) !== 'false'
    } catch {
      return true
    }
  })
  // 清理重复项：先扫出重复组，用户勾选确认后才合并；默认全选但不自动执行，
  // 因为一次点击就让一批内容消失，必须让用户先看见。
  const [dupDialogOpen, setDupDialogOpen] = useState(false)
  const [dupScope, setDupScope] = useState<DedupeScope>('all')
  const [dupGroups, setDupGroups] = useState<ClipboardDuplicateGroup[]>([])
  // 近似重复走**另一份清单、另一个对话框**：它的组没有内容哈希（组里每条的哈希
  // 都不一样），跟精确去重那套按 content_hash 索引的状态凑在一起只会互相打架。
  const [nearOpen, setNearOpen] = useState(false)
  const [nearScanning, setNearScanning] = useState(false)
  const [nearGroups, setNearGroups] = useState<ClipboardNearDuplicateGroup[]>([])
  const [nearSelected, setNearSelected] = useState<Set<number>>(new Set())
  const [dupScanning, setDupScanning] = useState(false)
  const [dupMerging, setDupMerging] = useState(false)
  const [dupSelected, setDupSelected] = useState<Set<string>>(new Set())
  // 查看器存条目 id 不存下标：新复制的内容插到顶上会让列表整体移位，存下标会跳到另一张图。
  const [viewerImageId, setViewerImageId] = useState<number | null>(null)
  const [imageViewMode, setImageViewMode] = useState<ClipboardImageViewMode>(() => loadClipboardImageViewMode())
  const [deleteConfirm, setDeleteConfirm] = useState<{
    open: boolean; kind: 'single' | 'bulk'; id?: number; ids?: number[]
  }>({ open: false, kind: 'single' })
  const [aiDialog, setAiDialog] = useState<{ open: boolean; loading: boolean; result: string }>({
    open: false,
    loading: false,
    result: '',
  })

  async function reload() {
    // 5000 条上限见 backend_server.py rpc_clipboard_list；虚拟滚动只解决渲染性能，
    // 保留条数上限+自动清理属里程碑五，这里先拉全量不做后端分页。
    // 两条失败路径都要接：_require_clipboard_service() 抛出的是 transport 级 error（promise reject，
    // 如金库中途被锁定，见 pythonBridge.ts）；res.ok 分支接应用级软失败，目前无触发路径但类型允许。
    try {
      const res = await vaultApi.call('clipboard_list', { limit: 5000 })
      if (!res.ok) {
        const message = translateError(res.error, res.error_params)
        toast.error(t('loadFailedToast'), { description: message })
        setLoadError(message)
        return
      }
      setLoadError(null)
      setEntries(sortEntries(res.entries))
    } catch (err) {
      const code = err instanceof Error ? err.message : String(err)
      const message = translateError(code, { detail: code })
      toast.error(t('loadFailedToast'), { description: message })
      setLoadError(message)
    } finally {
      setLoading(false)
    }
  }

  async function reloadTrash() {
    const res = await vaultApi.call('clipboard_list_trash', {})
    if (res.ok) setTrash(res.entries)
  }

  async function reloadSnippets() {
    const res = await vaultApi.call('clipboard_snippet_list', {})
    if (res.ok) setSnippets(res.entries)
  }

  useEffect(() => {
    reload()
    // 顶栏「视图」菜单里要写着回收站和常用片段各有几条——不预先拉一次的话，
    // 没点进去之前那两个数永远是 0，看起来像是空的。
    void reloadTrash()
    void reloadSnippets()
    const unsubscribe = vaultApi.onEvent((payload) => {
      if (payload.event !== 'clipboard_new_entry') return
      setEntries((prev) => sortEntries([payload.entry, ...prev.filter((e) => e.id !== payload.entry.id)]))
    })
    return unsubscribe
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-once: reload is a fresh function each render but always does the same thing, re-running it on every render would just be redundant fetches
  }, [])

  useEffect(() => {
    if (viewMode === 'trash') reloadTrash()
    else if (viewMode === 'snippets') reloadSnippets()
    setSelectedIds(new Set()) // 切换视图时选择状态不该带过去，避免误删
  }, [viewMode])

  const activeList = entries
  // 右栏显示的那一条。跨三种视图（活动/回收站/片段）都在这里找，
  // 因为切视图时右栏不该凭空清空——用户切回来还想看同一条。
  const detailEntry =
    [...entries, ...trash, ...snippets].find((e) => e.id === detailId) ?? null
  const clipStats = useMemo(() => {
    const active = activeList.filter((e) => !e.is_hidden).length
    const hidden = activeList.filter((e) => e.is_hidden).length
    const pinned = activeList.filter((e) => e.is_pinned).length
    return { total: activeList.length, active, hidden, pinned, snippets: snippets.length, trashed: trash.length }
  }, [activeList, snippets, trash])
  // 输入框绑定原始 search（打字即时响应），只有过滤计算用防抖值，避免每个字符对最多 5000
  // 条做同步全量扫描（同 PasswordScreen debouncedSearch）。
  const debouncedSearch = useDebouncedValue(search, 200)
  // 分类菜单里的数字须与点击后列表条数一致，所以子分类在过完隐藏/置顶两道门之后、
  // 分类和搜索之前的那批上计数。
  const scopeList = useMemo(() => {
    const source = viewMode === 'trash' ? trash : viewMode === 'snippets' ? snippets : activeList
    // 片段视图跳过隐藏/置顶/分类筛选：片段恒为 content_type='text'、不置顶不隐藏，
    // 对应菜单在该视图也不出现。
    if (viewMode === 'snippets') return source
    return source.filter((e) => {
      // 隐藏条目平时完全不出现，打开「只看隐藏」后只显示隐藏条目，二者互斥，与 NotesScreen.tsx 的
      // hiddenOnly 一致。
      if (hiddenOnly && !e.is_hidden) return false
      if (!hiddenOnly && e.is_hidden) return false
      if (pinnedOnly && !e.is_pinned) return false
      if (unpinnedOnly && e.is_pinned) return false
      return true
    })
  }, [activeList, trash, snippets, viewMode, pinnedOnly, unpinnedOnly, hiddenOnly])
  const facets = useMemo(() => buildFacets(scopeList), [scopeList])
  const filtered = useMemo(() => {
    const q = debouncedSearch.trim().toLowerCase()
    const now = Date.now()
    const result = scopeList.filter((e) => {
      if (viewMode !== 'snippets' && !matchesCategory(e, category, now)) return false
      if (!q) return true
      return (e.content_text ?? '').toLowerCase().includes(q) || (e.source_app ?? '').toLowerCase().includes(q)
    })
    // 只有「只看置顶」视图按手工序排（pin_order 升序）；其它视图仍最新在前（sortEntries 的 id DESC）。
    // pin_order 为 null 的排最后，与后端 fetch_pinned_ordered 的 `pin_order IS NULL` 规则一致。
    if (pinnedOnly && viewMode === 'active') {
      return [...result].sort((a, b) => {
        if (a.pin_order === null && b.pin_order === null) return b.id - a.id
        if (a.pin_order === null) return 1
        if (b.pin_order === null) return -1
        return a.pin_order - b.pin_order
      })
    }
    return result
  }, [scopeList, viewMode, debouncedSearch, category, pinnedOnly])

  // 默认预览首条；自动选中不改动剪贴板。
  useEffect(() => {
    if (loading) return
    if (detailId !== null && filtered.some((e) => e.id === detailId)) return
    setDetailId(filtered.length > 0 ? filtered[0].id : null)
  }, [loading, detailId, filtered])

  // 拖拽排序只在未经其它筛选的置顶视图开放：后端按数据库现查的真实相邻项落位（storage._pin_order_bou
  // nds），
  // 列表被搜索/类型筛选后，视觉上相邻的两条在真实序列里可能夹着被筛掉的项，落点会不一致。
  const dragSortEnabled =
    viewMode === 'active' && pinnedOnly && !hiddenOnly && typeFilter === 'all' && debouncedSearch.trim() === ''

  // 过滤/切换视图后选中集合可能残留已不在列表里的 id，每次渲染前收紧，全选框和「已选 N
  // 项」才不显示假数据（同 PasswordScreen visibleSelectedIds）。
  const filteredIds = useMemo(() => new Set(filtered.map((e) => e.id)), [filtered])
  const visibleSelectedIds = useMemo(
    () => [...selectedIds].filter((id) => filteredIds.has(id)),
    [selectedIds, filteredIds],
  )
  const allFilteredSelected = filtered.length > 0 && visibleSelectedIds.length === filtered.length

  function toggleSelected(id: number, checked: boolean) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  }

  function toggleSelectAll(checked: boolean) {
    setSelectedIds(checked ? new Set(filtered.map((e) => e.id)) : new Set())
  }

  // Ctrl+A 全选只在「历史记录」视图生效；回收站不开键盘全选是有意的安全边界（其全选用于不可撤销的批
  // 量彻底删除，风险更高）。
  // 输入框里的 Ctrl+A 必须保持浏览器原生，故与 isEditableTarget 一起用（同下面搜索/新增快捷键，参考
  // PasswordScreen）。
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'a') return
      if (viewMode !== 'active') return
      const target = e.target as HTMLElement | null
      const isEditableTarget =
        target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || !!target?.isContentEditable
      if (isEditableTarget) return
      e.preventDefault()
      setSelectedIds(new Set(filtered.map((e2) => e2.id)))
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [viewMode, filtered])

  async function handleBulkDelete() {
    const ids = visibleSelectedIds
    if (ids.length === 0) return
    setEntries((prev) => prev.filter((e) => !ids.includes(e.id)))
    const res = await vaultApi.call('clipboard_delete_bulk', { ids })
    if (!res.ok) {
      toast.error(t('deleteFailedToast'), { description: translateError(res.error, res.error_params) })
      await reload()
      return
    }
    toast.success(t('bulkDeletedToast', { count: res.deleted_count }))
    setSelectedIds(new Set())
  }

  async function togglePinned(entry: ClipboardEntry) {
    const nextPinned = !entry.is_pinned
    // 乐观更新——置顶只是排序权重，操作失败概率很低，先翻转界面再等接口
    // 确认，比等一圈往返再变更手感好；失败了再翻回去 + 提示。
    setEntries((prev) => sortEntries(prev.map((e) => (e.id === entry.id ? { ...e, is_pinned: nextPinned ? 1 : 0 } : e))))
    const res = await vaultApi.call('clipboard_set_pinned', { id: entry.id, pinned: nextPinned })
    if (!res.ok) {
      toast.error(t('pinFailedToast'), { description: translateError(res.error, res.error_params) })
      setEntries((prev) => sortEntries(prev.map((e) => (e.id === entry.id ? { ...e, is_pinned: entry.is_pinned } : e))))
    }
  }

  async function toggleHidden(entry: ClipboardEntry) {
    const nextHidden = !entry.is_hidden
    // 乐观更新，失败回滚 - 跟 togglePinned 同一套写法。标记/取消隐藏本身
    // 不需要验证，只有"打开只看隐藏视图"（见 handleToggleHiddenOnly）才要。
    setEntries((prev) => prev.map((e) => (e.id === entry.id ? { ...e, is_hidden: nextHidden ? 1 : 0 } : e)))
    const res = await vaultApi.call('clipboard_set_hidden', { id: entry.id, hidden: nextHidden })
    if (!res.ok) {
      toast.error(t('hideFailedToast'), { description: translateError(res.error, res.error_params) })
      setEntries((prev) => prev.map((e) => (e.id === entry.id ? { ...e, is_hidden: entry.is_hidden } : e)))
    }
  }

  async function handleToggleHiddenOnly() {
    if (hiddenOnly) {
      setHiddenOnly(false)
      return
    }
    if (!(await ensureFreshlyUnlocked())) return
    setHiddenOnly(true)
  }

  async function handleAiAction(entry: ClipboardEntry, action: AiClipboardAction) {
    const text = entry.content_text ?? ''
    if (!text.trim()) return
    const targetLang = AI_TARGET_LANGUAGE_NAMES[i18n.language] ?? 'English'
    const prompts: Record<AiClipboardAction, string> = {
      translate: `Translate the following text to ${targetLang}. Only output the translation, nothing else.\n\n${text}`,
      summarize: `Summarize the following text concisely, in the same language as the text.\n\n${text}`,
      polish: `Improve the wording and grammar of the following text while preserving its meaning and original language. Only output the improved text, nothing else.\n\n${text}`,
    }
    setAiDialog({ open: true, loading: true, result: '' })
    const res = await vaultApi.call('ai_chat', { messages: [{ role: 'user', content: prompts[action] }], no_desktop_tools: true })
    if (!res.ok) {
      setAiDialog({ open: false, loading: false, result: '' })
      if (res.error === 'ai.not_configured' || res.error === 'ai.api_key_required') {
        toast.error(t('aiNotConfiguredToast'))
      } else {
        toast.error(t('aiResultFailedToast'), { description: translateError(res.error, res.error_params) })
      }
      return
    }
    setAiDialog({ open: true, loading: false, result: res.reply })
  }

  // 转换结果直接写回系统剪贴板并 toast，不弹「转换预览」对话框：
  // 「一键」就是要比手动开在线转换站少几步。
  function handleQuickConvert(entry: ClipboardEntry, kind: QuickConvertKind) {
    const result = applyQuickConvert(kind, entry.content_text ?? '')
    if (result === null) {
      toast.error(t('quickConvertFailedToast'))
      return
    }
    void copyText(result).then((ok) => ok && toast.success(t('quickConvertCopiedToast')))
  }

  function activateHistoryEntry(entry: ClipboardEntry) {
    setDetailId(entry.id)
    void handlePasteClick(entry, false)
  }

  async function handlePasteClick(entry: ClipboardEntry, autoPaste = true) {
    try {
      const res = await vaultApi.call('clipboard_paste', { id: entry.id, auto_paste: autoPaste })
      if (!res.ok) {
        toast.error(t('pasteFailedToast'), { description: translateError(res.error, res.error_params) })
        return
      }
      // pasted=false 不是失败：Windows 阻止了自动粘贴（或没有先前聚焦的窗口），内容仍在剪贴板上。
      toast.success(res.pasted ? t('pastedToast') : t('copiedToast'), { id: 'clipboard-copy' })
    } catch {
      toast.error(t('pasteFailedToast'))
    }
  }

  async function handleDelete(entry: ClipboardEntry) {
    setEntries((prev) => prev.filter((e) => e.id !== entry.id))
    const res = await vaultApi.call('clipboard_delete', { id: entry.id })
    if (!res.ok) {
      toast.error(t('deleteFailedToast'), { description: translateError(res.error, res.error_params) })
      await reload()
      return
    }
    toast.success(t('deletedToast'))
  }

  async function handleRestore(entry: ClipboardEntry) {
    setTrash((prev) => prev.filter((e) => e.id !== entry.id))
    const res = await vaultApi.call('clipboard_restore', { id: entry.id })
    if (!res.ok) {
      toast.error(t('restoreFailedToast'), { description: translateError(res.error, res.error_params) })
      await reloadTrash()
      return
    }
    toast.success(t('restoredToast'))
    await reload()
  }

  async function handleHardDelete(entry: ClipboardEntry) {
    setDeleteConfirm({ open: true, kind: 'single', id: entry.id })
  }

  async function executeHardDelete() {
    const id = deleteConfirm.id!
    setDeleteConfirm({ open: false, kind: 'single' })
    setTrash((prev) => prev.filter((e) => e.id !== id))
    const res = await vaultApi.call('clipboard_hard_delete', { id })
    if (!res.ok) {
      toast.error(t('deleteFailedToast'), { description: translateError(res.error, res.error_params) })
      await reloadTrash()
      return
    }
    toast.success(t('permanentlyDeletedToast'))
  }

  // --- 常用片段（用户从空白直接新建的固定文本，区别于"历史记录里置顶"）---

  function openRecipeDialog(entry: ClipboardEntry) {
    setRecipeEntry(entry)
    // 每次从空白开始，不记上次填的值：配方用途是「和上次只差几个字」，预填会让人以为已改好而原样发出，
    // 发给别人收不回来。
    setRecipeValues({})
  }

  async function handleFillAndCopy() {
    if (!recipeEntry) return
    const filled = fillRecipe(recipeEntry.content_text ?? '', recipeValues)
    const ok = await copyText(filled)
    if (ok) {
      toast.success(t('fillRecipeCopiedToast'))
      setRecipeEntry(null)
    }
  }

  function composeSelectedIntoRecipe() {
    const chosen = activeList.filter((e) => selectedIds.has(e.id))
    const draft = composeRecipeDraft(chosen.map((e) => e.content_text))
    if (!draft) {
      toast.info(t('composeRecipeNothingToast'))
      return
    }
    setEditingSnippetId(null)
    setSnippetDraftText(draft)
    setSnippetDialogOpen(true)
  }

  function openNewSnippetDialog() {
    setEditingSnippetId(null)
    setSnippetDraftText('')
    setSnippetDialogOpen(true)
  }

  function openEditSnippetDialog(entry: ClipboardEntry) {
    setEditingSnippetId(entry.id)
    setSnippetDraftText(entry.content_text ?? '')
    setSnippetDialogOpen(true)
  }

  async function handleSaveSnippet() {
    const text = snippetDraftText.trim()
    if (!text) return
    setSavingSnippet(true)
    try {
      if (editingSnippetId === null) {
        const res = await vaultApi.call('clipboard_snippet_create', { content_text: text })
        if (!res.ok) {
          toast.error(t('snippetSaveFailedToast'), { description: translateError(res.error, res.error_params) })
          return
        }
        setSnippets((prev) => [res.entry, ...prev])
        toast.success(t('snippetCreatedToast'))
      } else {
        const res = await vaultApi.call('clipboard_snippet_update', { id: editingSnippetId, content_text: text })
        if (!res.ok) {
          toast.error(t('snippetSaveFailedToast'), { description: translateError(res.error, res.error_params) })
          return
        }
        setSnippets((prev) => prev.map((e) => (e.id === editingSnippetId ? { ...e, content_text: text } : e)))
        toast.success(t('snippetUpdatedToast'))
      }
      setSnippetDialogOpen(false)
    } finally {
      setSavingSnippet(false)
    }
  }

  // 片段删除复用历史记录的软删除/回收站 RPC（is_snippet 只是同表标记位，见 clipboard/storage.py），
  // 只是更新 snippets 这份本地 state。
  async function handleDeleteSnippet(entry: ClipboardEntry) {
    setSnippets((prev) => prev.filter((e) => e.id !== entry.id))
    const res = await vaultApi.call('clipboard_delete', { id: entry.id })
    if (!res.ok) {
      toast.error(t('deleteFailedToast'), { description: translateError(res.error, res.error_params) })
      await reloadSnippets()
      return
    }
    toast.success(t('deletedToast'))
  }

  async function handleBulkRestore() {
    const ids = visibleSelectedIds
    if (ids.length === 0) return
    setTrash((prev) => prev.filter((e) => !ids.includes(e.id)))
    const res = await vaultApi.call('clipboard_restore_bulk', { ids })
    if (!res.ok) {
      toast.error(t('restoreFailedToast'), { description: translateError(res.error, res.error_params) })
      await reloadTrash()
      return
    }
    toast.success(t('bulkRestoredToast', { count: res.restored_count }))
    setSelectedIds(new Set())
    await reload()
  }

  async function handleBulkHardDelete() {
    const ids = visibleSelectedIds
    if (ids.length === 0) return
    setDeleteConfirm({ open: true, kind: 'bulk', ids })
  }

  async function executeBulkHardDelete() {
    const ids = deleteConfirm.ids!
    setDeleteConfirm({ open: false, kind: 'single' })
    setTrash((prev) => prev.filter((e) => !ids.includes(e.id)))
    const res = await vaultApi.call('clipboard_hard_delete_bulk', { ids })
    if (!res.ok) {
      toast.error(t('deleteFailedToast'), { description: translateError(res.error, res.error_params) })
      await reloadTrash()
      return
    }
    toast.success(t('bulkPermanentlyDeletedToast', { count: res.deleted_count }))
    setSelectedIds(new Set())
  }

  /**
   * 导出，scope：all 全部、pinned 只导已置顶、hidden 只导已隐藏、selected 只导当前勾选。
   * selected 一条都没勾时直接拦下不发请求（后端会当成导 0 条，不如当场告诉用户还没勾）。
   */
  async function handleExportScope(scope: 'all' | 'pinned' | 'hidden' | 'selected') {
    if (scope === 'selected' && selectedIds.size === 0) {
      toast.info(t('exportNothingSelectedToast'))
      return
    }
    // 隐藏内容需验证才能看，导出等于落成明文文件，同样要过验证，否则成为绕开验证的旁路。
    // 判据是这次导出会不会把隐藏条目写进文件，而非 scope 是否等于 'hidden'：
    // 「全部记录」「只导已置顶」「只导已勾选」混有隐藏条目时同理。
    const willExportHidden =
      scope === 'hidden' ||
      (scope === 'all' && activeList.some((e) => e.is_hidden)) ||
      (scope === 'pinned' && activeList.some((e) => e.is_hidden && e.is_pinned)) ||
      (scope === 'selected' && activeList.some((e) => e.is_hidden && selectedIds.has(e.id)))
    if (willExportHidden && !(await ensureFreshlyUnlocked())) return

    const defaultName =
      scope === 'all' ? 'clipboard-history.json' : `clipboard-history-${scope}.json`
    const outputPath = await electronApi.saveFile({ title: t('exportDialogTitle'), defaultPath: defaultName })
    if (!outputPath) return
    const res = await vaultApi.call('clipboard_export', {
      output_path: outputPath,
      only_pinned: scope === 'pinned',
      only_hidden: scope === 'hidden',
      ids: scope === 'selected' ? [...selectedIds] : undefined,
    })
    if (!res.ok) {
      toast.error(t('exportFailedToast'), { description: translateError(res.error, res.error_params) })
      return
    }
    toast.success(t('exportedToast', { count: res.exported_count }), {
      action: { label: t('openFolderAction'), onClick: () => electronApi.showItemInFolder(res.output_path) },
    })
  }

  /**
   * 导入，可多选文件（multiSelections），导完默认安全删除原文件：
   * 导出文件是明文剪贴板历史，留在下载目录就是不设防的副本；开关记在 localStorage。
   */
  async function handleImport() {
    const paths = await electronApi.openFiles({
      title: t('importDialogTitle'),
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    if (!paths || paths.length === 0) return
    const res = await vaultApi.call('clipboard_import', {
      input_paths: paths,
      delete_source: deleteSourceOnImport,
    })
    if (!res.ok) {
      toast.error(t('importFailedToast'), { description: translateError(res.error, res.error_params) })
      return
    }
    // 部分成功要说清楚：三个文件里坏了一个时，"已导入 N 条"会让用户以为全成了。
    if (res.failed && res.failed.length > 0) {
      toast.warning(t('importPartialToast', { imported: res.imported_count, failed: res.failed.length }))
    } else if (res.skipped_count > 0) {
      // 必须报出跳过条数：同一份备份导第二次 imported_count 为 0，只说「已导入 0 条」与文件为空、
      // 导入失败无法区分。
      toast.success(t('importedWithSkippedToast', { count: res.imported_count, skipped: res.skipped_count }))
    } else {
      toast.success(t('importedToast', { count: res.imported_count }))
    }
    // 删原文件失败也得说——用户是冲着"别留明文副本"才开这个开关的，
    // 默默失败等于让他以为副本已经没了。
    if (res.delete_failures && res.delete_failures.length > 0) {
      toast.warning(t('importDeleteSourceFailedToast', { count: res.delete_failures.length }))
    } else if (res.deleted_sources && res.deleted_sources.length > 0) {
      toast.info(t('importDeletedSourcesToast', { count: res.deleted_sources.length }))
    }
    await reload()
  }

  /**
   * 扫描库里已有的重复项，只扫不合并（合并要用户看过清单再点一次）。
   * 导入去重管以后不再多出重复，这条管现有的重复：一个自动悄悄，一个手动可见。
   */
  async function handleScanNearDuplicates() {
    setNearGroups([])
    setNearSelected(new Set())
    setNearOpen(true)
    setNearScanning(true)
    try {
      const res = await vaultApi.call('clipboard_find_near_duplicates', {})
      if (!res.ok) {
        toast.error(t('findDuplicatesFailedToast'), { description: translateError(res.error, res.error_params) })
        setNearOpen(false)
        return
      }
      setNearGroups(res.groups)
      setNearSelected(new Set(res.groups.map((g) => g.keep_id)))
    } finally {
      // 跟精确去重那边同一条：复位放 finally。写在 await 后面的话，调用一抛
      // 按钮就永久卡在"扫描中"，而屏幕上一个字都不会出现。
      setNearScanning(false)
    }
  }

  async function handleMergeNearDuplicates() {
    const res = await vaultApi.call('clipboard_merge_near_duplicates', {
      keep_ids: [...nearSelected],
    })
    if (!res.ok) {
      toast.error(t('mergeDuplicatesFailedToast'), { description: translateError(res.error, res.error_params) })
      return
    }
    setNearOpen(false)
    toast.success(t('mergedDuplicatesToast', { count: res.merged_count }))
    await reload()
  }

  async function handleScanDuplicates(scope: DedupeScope = 'all') {
    setDupScope(scope)
    setDupGroups([])
    setDupSelected(new Set())
    setDupDialogOpen(true)
    setDupScanning(true)
    try {
      const res = await vaultApi.call('clipboard_find_duplicates', {})
      if (!res.ok) {
        toast.error(t('findDuplicatesFailedToast'), { description: translateError(res.error, res.error_params) })
        setDupDialogOpen(false)
        return
      }
      const scopedGroups = groupsForDedupeScope(res.groups, scope)
      setDupGroups(res.groups)
      setDupSelected(new Set(scopedGroups.map((g) => g.content_hash)))
    } finally {
      // 复位必须放 finally：vaultApi.call 会抛（后端 error 信封在 pythonBridge 层 reject），放 await
      // 后按钮会永久卡在「扫描中」且无任何提示。
      setDupScanning(false)
    }
  }

  async function handleMergeDuplicates() {
    const hashes = [...dupSelected]
    if (hashes.length === 0) return
    setDupMerging(true)
    try {
      const res = await vaultApi.call('clipboard_merge_duplicates', { content_hashes: hashes })
      if (!res.ok) {
        toast.error(t('mergeDuplicatesFailedToast'), { description: translateError(res.error, res.error_params) })
        return
      }
      setDupDialogOpen(false)
      toast.success(t('mergedDuplicatesToast', { count: res.merged_count }))
      await reload()
      await reloadSnippets()
    } finally {
      setDupMerging(false)
    }
  }

  // 当前范围决定对话框的初始勾选，三种范围都展示完整清单，用户可见哪些组未选中并可额外勾选；
  // 「只清理置顶/隐藏」是安全缩小范围，而非悄悄藏起其它重复。
  const dupScopeHashes = useMemo(
    () => new Set(groupsForDedupeScope(dupGroups, dupScope).map((group) => group.content_hash)),
    [dupGroups, dupScope],
  )

  function selectDedupeScope(scope: DedupeScope) {
    setDupScope(scope)
    setDupSelected(new Set(groupsForDedupeScope(dupGroups, scope).map((group) => group.content_hash)))
  }

  // 合并会动的总条数（保留的那条不算），用来给按钮写一个具体的数字：
  // 「合并这 11 条」比「确认」更能让人知道自己按下去会发生什么。
  const dupSelectedCount = useMemo(
    () =>
      dupGroups
        .filter((g) => dupSelected.has(g.content_hash))
        .reduce((sum, g) => sum + g.merge_ids.length, 0),
    [dupGroups, dupSelected],
  )

  // --- 置顶项拖拽排序 ---
  // 用 PointerSensor 的 activationConstraint（distance: 6）而非整行可拖：
  // 行本体是「点击即粘贴」区域，纯点击不应被判成零距离拖动。
  // KeyboardSensor 是 @dnd-kit 相对原生 DnD 的主要收益：聚焦把手后空格拾起、方向键移动、空格放下。
  const dndSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const activeId = Number(active.id)
    const overId = Number(over.id)
    const oldIndex = filtered.findIndex((e) => e.id === activeId)
    const newIndex = filtered.findIndex((e) => e.id === overId)
    if (oldIndex < 0 || newIndex < 0) return

    // 先在本地把顺序改到位（乐观更新），失败再整体重拉——拖拽是高频交互，等
    // 一次 RPC 往返才动位置会明显发涩。
    const reordered = arrayMove(filtered, oldIndex, newIndex)
    const before = reordered[newIndex - 1] ?? null
    const after = reordered[newIndex + 1] ?? null
    const previousEntries = entries
    setEntries((prev) => {
      // 只重写被拖动那一项的 pin_order（后端一次拖拽只 UPDATE 一行）；
      // 本地算的中点可能与后端最终值有差（后端可能整段重编号），拿到响应后用后端序列覆盖。
      const localOrder =
        before && after && before.pin_order !== null && after.pin_order !== null
          ? (before.pin_order + after.pin_order) / 2
          : after && after.pin_order !== null
            ? after.pin_order - 1
            : before && before.pin_order !== null
              ? before.pin_order + 1
              : 0
      return prev.map((e) => (e.id === activeId ? { ...e, pin_order: localOrder } : e))
    })

    const res = await vaultApi.call('clipboard_move_pinned', {
      id: activeId,
      before_id: before?.id ?? null,
      after_id: after?.id ?? null,
    })
    if (!res.ok) {
      toast.error(t('reorderPinnedFailedToast'), { description: translateError(res.error, res.error_params) })
      setEntries(previousEntries)
      return
    }
    // 用后端回传的权威序列覆盖乐观值：间隙耗尽触发整段重编号时所有置顶项的 pin_order 都变了，
    // 只信本地中点会让下次拖拽算错落点。
    const authoritative = new Map(res.pinned.map((e) => [e.id, e.pin_order]))
    setEntries((prev) =>
      prev.map((e) => (authoritative.has(e.id) ? { ...e, pin_order: authoritative.get(e.id) ?? null } : e)),
    )
  }

  // 查看器翻的是当前筛选结果里的图片，顺序同列表；没有 image_path 的（缩略图在、原图被清理）排除，
  // 否则会翻到空白。
  const viewerImages: ViewerImage[] = useMemo(
    () =>
      filtered
        .filter((e) => e.content_type === 'image' && e.image_path)
        .map((e) => ({ id: e.id, imagePath: e.image_path as string, createdAt: e.created_at })),
    [filtered],
  )
  const viewerIndex = viewerImages.findIndex((img) => img.id === viewerImageId)

  /** 把原图放回系统剪贴板，但**不**触发粘贴——用户只是想"拿到这张图"。 */
  async function copyImageToClipboard(image: ViewerImage) {
    const res = await vaultApi.call('clipboard_paste', { id: image.id, auto_paste: false })
    if (!res.ok) {
      toast.error(t('pasteFailedToast'), { description: translateError(res.error, res.error_params) })
      return
    }
    toast.success(t('imageCopiedToast'))
  }

  const scrollParentRef = useRef<HTMLDivElement>(null)
  const rowVirtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => scrollParentRef.current,
    // 大多数行是一两行文字，图片行更高——给个粗略估计，measureElement 会
    // 在每行真实渲染出来后自动纠正，不需要估得多准。
    estimateSize: () => 92,
    overscan: 8,
    // 测量缓存必须按条目 id 存而非下标：measureElement 把高度记在 getItemKey(index) 上，
    // 而新复制的内容会插到顶部使下标移位，
    // 高度被套到别的条目上，后续各行偏移全错，表现为相邻行叠在一起（图片行最明显）。
    getItemKey: useCallback((index: number) => filtered[index]?.id ?? index, [filtered]),
  })

  // ---- 一行顶栏 ----
  // 分类等功能做成顶栏上的菜单，当前状态直接写在触发器上（「分类 · 链接 › github.com」「选择 · 已选
  // 3」），不展开就知道筛选与选择状态。
  // 行为不变：导出仍先过隐藏内容验证（handleExportScope），「只看隐藏」仍走 handleToggleHiddenOnly
  // 解锁，去重仍先列清单再合并。
  const categoryLabel = (path: ClipCategoryPath): string | undefined => {
    if (path.type === 'all') return undefined
    const typeName = t(`type.${path.type}`)
    if (!path.dim || path.value === undefined) return typeName
    return `${typeName} › ${facetValueLabel(path.dim, path.value)}`
  }

  function facetValueLabel(dim: ClipFacetDim, value: string): string {
    if (value === UNKNOWN_FACET) return t('facetUnknown')
    if (dim === 'length') return t(`facetLength.${value}`)
    if (dim === 'day') return t(`facetDay.${value}`)
    return value
  }

  const categoryMenuItems: TopBarNode[] = [
    {
      id: 'cat-all',
      type: 'item',
      label: t('filterAll'),
      icon: ListFilter,
      selected: category.type === 'all',
      count: scopeList.length,
      onSelect: () => setCategory(ALL_CATEGORIES),
    },
    { id: 'cat-sep', type: 'separator' },
    ...FILTERABLE_TYPES.map((type): TopBarNode => {
      const typeFacets = facets[type]
      const selectedHere = category.type === type
      // 一条都没有的类型不列：空分类只会让菜单变长。正选着的那一类例外——
      // 条目被删光之后它得留在菜单里，用户才看得见自己筛的是什么。
      const hidden = typeFacets.count === 0 && !selectedHere
      if (typeFacets.dims.length === 0) {
        return {
          id: `cat-${type}`,
          type: 'item',
          label: t(`type.${type}`),
          icon: TYPE_ICONS[type],
          selected: selectedHere,
          count: typeFacets.count,
          hidden,
          onSelect: () => setCategory({ type }),
        }
      }
      return {
        id: `cat-${type}`,
        type: 'submenu',
        label: t(`type.${type}`),
        icon: TYPE_ICONS[type],
        count: typeFacets.count,
        active: selectedHere,
        hidden,
        children: [
          {
            id: `cat-${type}-all`,
            type: 'item',
            label: t('facetAllOfType', { type: t(`type.${type}`) }),
            selected: selectedHere && !category.dim,
            count: typeFacets.count,
            onSelect: () => setCategory({ type }),
          },
          { id: `cat-${type}-sep`, type: 'separator' },
          ...typeFacets.dims.map(
            ({ dim, values }): TopBarNode => ({
              id: `cat-${type}-${dim}`,
              type: 'submenu',
              label: t(`facetDim.${dim}`),
              active: selectedHere && category.dim === dim,
              children: values.map(
                ({ value, count }): TopBarNode => ({
                  id: `cat-${type}-${dim}-${value}`,
                  type: 'item',
                  label: facetValueLabel(dim, value),
                  selected: selectedHere && category.dim === dim && category.value === value,
                  count,
                  onSelect: () => setCategory({ type, dim, value }),
                }),
              ),
            }),
          ),
        ],
      }
    }),
  ]

  const filterValue = [
    pinnedOnly && t('pinnedOnlyFilter'),
    unpinnedOnly && t('unpinnedOnlyFilter'),
    hiddenOnly && t('hiddenOnlyFilter'),
  ]
    .filter(Boolean)
    .join('、')

  const selectedCount = visibleSelectedIds.length

  const topBarMenus: TopBarMenu[] = [
    {
      id: 'view',
      label: t('menuView'),
      icon: PanelsTopLeft,
      value: viewMode === 'trash' ? t('trashTitle') : viewMode === 'snippets' ? t('snippetsTitle') : t('viewHistory'),
      active: viewMode !== 'active',
      onClear: () => setViewMode('active'),
      items: [
        {
          id: 'view-active',
          type: 'item',
          label: t('viewHistory'),
          icon: ClipboardList,
          selected: viewMode === 'active',
          count: clipStats.total,
          onSelect: () => setViewMode('active'),
        },
        {
          id: 'view-snippets',
          type: 'item',
          label: t('snippetsTitle'),
          icon: FileText,
          selected: viewMode === 'snippets',
          count: clipStats.snippets,
          onSelect: () => setViewMode('snippets'),
        },
        {
          id: 'view-trash',
          type: 'item',
          label: t('trashTitle'),
          icon: Trash2,
          selected: viewMode === 'trash',
          count: clipStats.trashed,
          description: t('trashRetentionHint', { days: 7 }),
          onSelect: () => setViewMode('trash'),
        },
      ],
    },
    {
      id: 'category',
      label: t('menuCategory'),
      icon: Layers,
      hidden: viewMode === 'snippets',
      value: categoryLabel(category),
      active: category.type !== 'all',
      onClear: () => setCategory(ALL_CATEGORIES),
      contentClassName: 'min-w-60',
      items: categoryMenuItems,
    },
    {
      // 置顶与内容类型是两个独立维度，不放进分类单选；置顶/非置顶互斥开关配合「选择」菜单的全选/删除选中
      // 项即两条镜像批量路径。
      // 「只看隐藏」要先过验证（handleToggleHiddenOnly），所以不设 keepOpen：解锁框要弹出，菜单得先让开。
      id: 'filter',
      label: t('toolbarGroupFilter'),
      icon: Filter,
      hidden: viewMode === 'snippets',
      value: filterValue || undefined,
      active: pinnedOnly || unpinnedOnly || hiddenOnly,
      onClear: () => {
        setPinnedOnly(false)
        setUnpinnedOnly(false)
        setHiddenOnly(false)
      },
      items: [
        {
          id: 'pinned-only',
          type: 'item',
          label: t('pinnedOnlyFilter'),
          icon: Pin,
          selected: pinnedOnly,
          count: clipStats.pinned,
          hidden: viewMode !== 'active',
          keepOpen: true,
          onSelect: () => {
            setPinnedOnly((v) => !v)
            setUnpinnedOnly(false)
          },
        },
        {
          id: 'unpinned-only',
          type: 'item',
          label: t('unpinnedOnlyFilter'),
          icon: PinOff,
          selected: unpinnedOnly,
          hidden: viewMode !== 'active',
          keepOpen: true,
          onSelect: () => {
            setUnpinnedOnly((v) => !v)
            setPinnedOnly(false)
          },
        },
        { id: 'filter-sep', type: 'separator' },
        {
          id: 'hidden-only',
          type: 'item',
          label: t('hiddenOnlyFilter'),
          icon: EyeOff,
          selected: hiddenOnly,
          count: viewMode === 'active' ? clipStats.hidden : undefined,
          description: t('statHiddenHint'),
          onSelect: () => void handleToggleHiddenOnly(),
        },
      ],
    },
    {
      id: 'dedupe',
      label: t('menuDedupe'),
      icon: CopyCheck,
      hidden: viewMode === 'trash',
      items: [
        {
          id: 'dedupe-exact',
          type: 'submenu',
          label: t('dedupeButton'),
          icon: CopyCheck,
          children: [
            { id: 'dedupe-all', type: 'item', label: t('dedupeScopeAll'), onSelect: () => void handleScanDuplicates('all') },
            { id: 'dedupe-pinned', type: 'item', label: t('dedupeScopePinned'), onSelect: () => void handleScanDuplicates('pinned') },
            { id: 'dedupe-hidden', type: 'item', label: t('dedupeScopeHidden'), onSelect: () => void handleScanDuplicates('hidden') },
          ],
        },
        {
          // 紧挨着精确去重。两个是两份互不重叠的清单，摆在一起用户才看得出
          // "还有一批只是差一点点的"也能清。
          id: 'near-dedupe',
          type: 'item',
          label: t('nearDedupeButton'),
          icon: Layers,
          description: t('nearDedupeMenuHint'),
          hidden: viewMode !== 'active',
          onSelect: () => void handleScanNearDuplicates(),
        },
      ],
    },
    {
      id: 'data',
      label: t('menuData'),
      icon: Upload,
      hidden: viewMode === 'trash',
      items: [
        { id: 'import', type: 'item', label: t('importButton'), icon: Upload, onSelect: () => void handleImport() },
        {
          id: 'import-delete-source',
          type: 'toggle',
          label: t('importDeleteSourceShort'),
          description: t('importDeleteSourceLabel'),
          checked: deleteSourceOnImport,
          onCheckedChange: (next) => {
            setDeleteSourceOnImport(next)
            try {
              localStorage.setItem(IMPORT_DELETE_SOURCE_KEY, String(next))
            } catch {
              // 存不下就只影响"下次还记不记得"，不该让这次勾选失败
            }
          },
        },
        { id: 'data-sep', type: 'separator' },
        {
          id: 'export',
          type: 'submenu',
          label: t('exportButton'),
          icon: Download,
          children: [
            { id: 'export-all', type: 'item', label: t('exportScopeAll'), count: clipStats.total, onSelect: () => void handleExportScope('all') },
            { id: 'export-pinned', type: 'item', label: t('exportScopePinned'), count: clipStats.pinned, onSelect: () => void handleExportScope('pinned') },
            { id: 'export-hidden', type: 'item', label: t('exportScopeHidden'), count: clipStats.hidden, onSelect: () => void handleExportScope('hidden') },
            {
              id: 'export-selected',
              type: 'item',
              label: t('exportScopeSelected'),
              count: selectedIds.size,
              disabled: selectedIds.size === 0,
              onSelect: () => void handleExportScope('selected'),
            },
          ],
        },
      ],
    },
    {
      id: 'selection',
      label: t('menuSelection'),
      icon: SquareCheck,
      hidden: viewMode === 'snippets',
      value: selectedCount > 0 ? t('selectedCountLabel', { count: selectedCount }) : undefined,
      active: selectedCount > 0,
      onClear: () => setSelectedIds(new Set()),
      items: [
        {
          id: 'select-all',
          type: 'item',
          label: t('selectAllLabel'),
          icon: SquareCheck,
          count: filtered.length,
          shortcut: viewMode === 'active' ? 'Ctrl+A' : undefined,
          disabled: filtered.length === 0 || allFilteredSelected,
          onSelect: () => toggleSelectAll(true),
        },
        {
          id: 'select-none',
          type: 'item',
          label: t('clearSelectionLabel'),
          icon: Square,
          disabled: selectedCount === 0,
          onSelect: () => setSelectedIds(new Set()),
        },
        { id: 'select-sep', type: 'separator' },
        {
          // 只在真的选中了东西时能点。一个"选 0 条也点得动、点了弹一句没东西"
          // 的按钮，是在让用户替代码做判断。
          id: 'compose-recipe',
          type: 'item',
          label: t('composeRecipeButton'),
          icon: SquarePen,
          hidden: viewMode !== 'active',
          disabled: selectedIds.size === 0,
          onSelect: composeSelectedIntoRecipe,
        },
        {
          id: 'delete-selected',
          type: 'item',
          label: t('deleteSelectedButton'),
          icon: Trash2,
          destructive: true,
          hidden: viewMode !== 'active',
          disabled: selectedCount === 0,
          onSelect: () => void handleBulkDelete(),
        },
        {
          id: 'restore-selected',
          type: 'item',
          label: t('restoreSelectedButton'),
          icon: RotateCcw,
          hidden: viewMode !== 'trash',
          disabled: selectedCount === 0,
          onSelect: () => void handleBulkRestore(),
        },
        {
          id: 'purge-selected',
          type: 'item',
          label: t('permanentlyDeleteSelectedButton'),
          icon: Trash2,
          destructive: true,
          hidden: viewMode !== 'trash',
          disabled: selectedCount === 0,
          onSelect: () => void handleBulkHardDelete(),
        },
      ],
    },
  ]

  return (
    <PageShell width="canvas" fill>
      <PageHeader
        title={viewMode === 'trash' ? t('trashTitle') : viewMode === 'snippets' ? t('snippetsTitle') : t('pageTitle')}
      />
      {/* 三块数字仍然是**筛选入口**，不只是显示：点「已置顶 5」直接把列表筛成
          那 5 条；「已隐藏」复用 handleToggleHiddenOnly，所以它照样要先过一次
          解锁验证（生物识别 → 密码，跟从「筛选」菜单进去是同一条路，不能因为
          换了个入口就绕开）。回收站/片段视图下不显示：那两个视图的列表跟这三个
          数根本不是同一批内容，留着会指向一份此刻看不见的列表。 */}
      <TopBar
        className="border-b border-border/70 pb-3"
        leading={
          !loading && viewMode === 'active' && clipStats.total > 0 ? (
            <>
              <StatTile
                compact
                label={t('statTotalLabel')}
                value={clipStats.total}
                hint={t('statTotalHint')}
                active={category.type === 'all' && !pinnedOnly && !unpinnedOnly && !hiddenOnly}
                onClick={() => {
                  setCategory(ALL_CATEGORIES)
                  setPinnedOnly(false)
                  setUnpinnedOnly(false)
                  setHiddenOnly(false)
                }}
              />
              <StatTile
                compact
                label={t('statPinnedLabel')}
                value={clipStats.pinned}
                hint={t('statPinnedHint')}
                active={pinnedOnly}
                onClick={() => {
                  setPinnedOnly((v) => !v)
                  setUnpinnedOnly(false)
                }}
              />
              <StatTile
                compact
                label={t('statHiddenLabel')}
                value={clipStats.hidden}
                hint={t('statHiddenHint')}
                active={hiddenOnly}
                onClick={() => void handleToggleHiddenOnly()}
              />
            </>
          ) : undefined
        }
        menus={topBarMenus}
        trailing={
          <>
            <TopBarSearch value={search} onChange={setSearch} placeholder={t('searchPlaceholder')} />
            {viewMode === 'snippets' && (
              <Button size="sm" onClick={openNewSnippetDialog}>
                <Plus className="size-4" aria-hidden="true" />
                {t('newSnippetButton')}
              </Button>
            )}
          </>
        }
      />

      {!loading && loadError && (
        <div className="flex flex-col items-center gap-3 py-12">
          <p className="text-sm text-destructive">{loadError}</p>
          <Button variant="outline" size="sm" onClick={() => { setLoading(true); setLoadError(null); reload() }}>
            {t('retryButton')}
          </Button>
        </div>
      )}
      {!loading && !loadError && filtered.length === 0 && (
        <p className="text-sm text-muted-foreground">
          {viewMode === 'trash' ? t('trashEmpty') : viewMode === 'snippets' ? t('snippetsEmpty') : t('emptyList')}
        </p>
      )}
      {viewMode === 'trash' && <p className="text-sm text-muted-foreground">{t('trashRetentionHint', { days: 7 })}</p>}

      {/* 置顶视图走「不虚拟滚动 + 可拖拽」这条独立路径。
          为什么不让拖拽和虚拟滚动共存：@dnd-kit 的 SortableContext 只认识已经
          挂载的 DOM 节点，视口外没渲染的行它一无所知——拖到列表边缘想继续往下
          放会直接失效。而置顶项天然是少量（用户手动挑出来的几条到几十条），虚拟
          滚动在这个规模上省不下任何可感知的开销，用它换来的复杂度不划算。
          非置顶视图（可能有几千条）继续用虚拟滚动，两条路径互不干扰。 */}
      {/* 历史记录单击复制并预览；显式粘贴仍在详情工具栏。 */}
      <Workbench
        listWidth="wide"
        listRef={scrollParentRef}
        selected={detailEntry !== null}
        onBack={() => setDetailId(null)}
        backLabel={tCommon('backToList')}
        placeholder={<EmptyState icon={ClipboardList} title={t('detailEmptyState')} className="m-6" />}
        detail={
          detailEntry && (
            <ClipboardDetailPane
              entry={detailEntry}
              onPaste={() => handlePasteClick(detailEntry)}
              onOpenImage={() => setViewerImageId(detailEntry.id)}
              // 回收站里的条目只有还原/彻底删除两件事可做，那两个在列表行里
              // （它们不共用这套操作），所以详情这排在回收站视图下自然为空。
              onTogglePinned={viewMode === 'active' ? () => togglePinned(detailEntry) : undefined}
              onToggleHidden={viewMode === 'active' ? () => toggleHidden(detailEntry) : undefined}
              onDelete={
                viewMode === 'active'
                  ? () => handleDelete(detailEntry)
                  : viewMode === 'snippets'
                    ? () => handleDeleteSnippet(detailEntry)
                    : undefined
              }
              onEdit={viewMode === 'snippets' ? () => openEditSnippetDialog(detailEntry) : undefined}
              onFillRecipe={viewMode !== 'trash' ? () => openRecipeDialog(detailEntry) : undefined}
              onAiAction={
                isProfessional && viewMode !== 'trash' ? (action) => handleAiAction(detailEntry, action) : undefined
              }
              onQuickConvert={viewMode !== 'trash' ? (kind) => handleQuickConvert(detailEntry, kind) : undefined}
              onPartialCopy={viewMode !== 'trash' ? () => setPartialCopyEntry(detailEntry) : undefined}
            />
          )
        }
        list={
        <>
      {dragSortEnabled && !loading && filtered.length > 0 && (
        <div>
          <DndContext
            sensors={dndSensors}
            collisionDetection={closestCenter}
            // 限制成只能纵向拖、且不能拖出列表容器——横向自由拖动对一个纵向列表
            // 没有意义，还会让放置目标的判定变模糊。
            modifiers={[restrictToVerticalAxis, restrictToParentElement]}
            onDragEnd={(event) => void handleDragEnd(event)}
          >
            <SortableContext items={filtered.map((e) => e.id)} strategy={verticalListSortingStrategy}>
              {filtered.map((entry) => (
                <SortablePinnedRow key={entry.id} id={entry.id}>
                  <ClipboardRow
                    entry={entry}
                    selected={selectedIds.has(entry.id)}
                    onToggleSelected={(checked) => toggleSelected(entry.id, checked)}
                onOpenImage={(e) => setViewerImageId(e.id)}
                    onOpenDetail={() => setDetailId(entry.id)}
                    active={detailId === entry.id}
                    onPaste={() => handlePasteClick(entry)}
                    onActivate={() => activateHistoryEntry(entry)}
                    onTogglePinned={() => togglePinned(entry)}
                    onToggleHidden={() => toggleHidden(entry)}
                    onDelete={() => handleDelete(entry)}
                    onAiAction={isProfessional ? (action) => handleAiAction(entry, action) : undefined}
                    onQuickConvert={(kind) => handleQuickConvert(entry, kind)}
                    onPartialCopy={() => setPartialCopyEntry(entry)}
                  />
                </SortablePinnedRow>
              ))}
            </SortableContext>
          </DndContext>
        </div>
      )}

      {!dragSortEnabled && !loading && filtered.length > 0 && (
        <div>
          <div style={{ height: rowVirtualizer.getTotalSize(), position: 'relative' }}>
            {rowVirtualizer.getVirtualItems().map((virtualRow) => {
              const entry = filtered[virtualRow.index]
              return (
                <div
                  key={virtualRow.key}
                  ref={rowVirtualizer.measureElement}
                  data-index={virtualRow.index}
                  style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${virtualRow.start}px)` }}
                  className="p-1"
                >
                  {viewMode === 'trash' ? (
                    <ClipboardRow
                      entry={entry}
                      selected={selectedIds.has(entry.id)}
                      onToggleSelected={(checked) => toggleSelected(entry.id, checked)}
                onOpenImage={(e) => setViewerImageId(e.id)}
                    onOpenDetail={() => setDetailId(entry.id)}
                    active={detailId === entry.id}
                      onRestore={() => handleRestore(entry)}
                      onHardDelete={() => handleHardDelete(entry)}
                    />
                  ) : viewMode === 'snippets' ? (
                    <ClipboardRow
                      entry={entry}
                      selected={selectedIds.has(entry.id)}
                      onToggleSelected={(checked) => toggleSelected(entry.id, checked)}
                onOpenImage={(e) => setViewerImageId(e.id)}
                    onOpenDetail={() => setDetailId(entry.id)}
                    active={detailId === entry.id}
                      onPaste={() => handlePasteClick(entry)}
                      onEdit={() => openEditSnippetDialog(entry)}
                      onFillRecipe={() => openRecipeDialog(entry)}
                      onDelete={() => handleDeleteSnippet(entry)}
                      onPartialCopy={() => setPartialCopyEntry(entry)}
                    />
                  ) : (
                    <ClipboardRow
                      entry={entry}
                      selected={selectedIds.has(entry.id)}
                      onToggleSelected={(checked) => toggleSelected(entry.id, checked)}
                onOpenImage={(e) => setViewerImageId(e.id)}
                    onOpenDetail={() => setDetailId(entry.id)}
                    active={detailId === entry.id}
                      onPaste={() => handlePasteClick(entry)}
                      onActivate={() => activateHistoryEntry(entry)}
                      onTogglePinned={() => togglePinned(entry)}
                      onToggleHidden={() => toggleHidden(entry)}
                      onDelete={() => handleDelete(entry)}
                      onAiAction={isProfessional ? (action) => handleAiAction(entry, action) : undefined}
                      onQuickConvert={(kind) => handleQuickConvert(entry, kind)}
                      onPartialCopy={() => setPartialCopyEntry(entry)}
                    />
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}
        </>
        }
      />

      {/* 近似重复。故意跟精确去重分成两个对话框：这边的组没有内容哈希，
          按钮文案和判定口径也不一样，硬塞进同一个对话框只会让两边都变含糊。 */}
      <Dialog open={nearOpen} onOpenChange={setNearOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{t('nearDedupeDialogTitle')}</DialogTitle>
            <DialogDescription>{t('nearDedupeDialogHint')}</DialogDescription>
          </DialogHeader>
          {nearScanning ? (
            <p className="py-6 text-center text-sm text-muted-foreground">{t('dedupeScanning')}</p>
          ) : nearGroups.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">{t('nearDedupeNone')}</p>
          ) : (
            <div className="max-h-80 space-y-2 overflow-auto">
              {nearGroups.map((group) => (
                <label
                  key={group.keep_id}
                  className="flex cursor-pointer items-start gap-3 rounded-lg border border-border bg-surface p-3"
                >
                  <Checkbox
                    checked={nearSelected.has(group.keep_id)}
                    onCheckedChange={(v) =>
                      setNearSelected((prev) => {
                        const next = new Set(prev)
                        if (v === true) next.add(group.keep_id)
                        else next.delete(group.keep_id)
                        return next
                      })
                    }
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{group.preview}</span>
                    <span className="block text-sm text-muted-foreground">
                      {t('nearDedupeGroupSummary', { count: group.count, merged: group.merge_ids.length })}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setNearOpen(false)}>
              {t('cancelButton')}
            </Button>
            <Button
              disabled={nearScanning || nearSelected.size === 0}
              onClick={() => void handleMergeNearDuplicates()}
            >
              {t('nearDedupeMergeButton', { n: nearSelected.size })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 填配方。每个空位一行输入框，右边实时预览填出来是什么样——
          填完不预览就直接复制的话，少填一个空位要等粘出去才发现。 */}
      <Dialog open={recipeEntry !== null} onOpenChange={(o) => !o && setRecipeEntry(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('fillRecipeTitle')}</DialogTitle>
          </DialogHeader>
          {recipeEntry && (
            <div className="space-y-4">
              <div className="space-y-3">
                {extractPlaceholders(recipeEntry.content_text ?? '').map((name) => (
                  <div key={name} className="flex items-center gap-3">
                    <Label className="w-32 shrink-0 truncate text-sm" title={name}>
                      {name}
                    </Label>
                    <Input
                      value={recipeValues[name] ?? ''}
                      onChange={(e) => setRecipeValues((v) => ({ ...v, [name]: e.target.value }))}
                    />
                  </div>
                ))}
              </div>
              <div className="max-h-64 overflow-auto rounded border border-border/70 bg-muted/40 p-3">
                <pre className="whitespace-pre-wrap break-words text-sm">
                  {fillRecipe(recipeEntry.content_text ?? '', recipeValues)}
                </pre>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setRecipeEntry(null)}>
              {t('cancelButton')}
            </Button>
            <Button onClick={() => void handleFillAndCopy()}>{t('fillRecipeCopyButton')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={snippetDialogOpen} onOpenChange={(o) => !savingSnippet && setSnippetDialogOpen(o)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingSnippetId === null ? t('newSnippetDialogTitle') : t('editSnippetDialogTitle')}</DialogTitle>
          </DialogHeader>
          <Textarea
            autoFocus
            rows={6}
            placeholder={t('snippetTextPlaceholder')}
            value={snippetDraftText}
            onChange={(e) => setSnippetDraftText(e.target.value)}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setSnippetDialogOpen(false)} disabled={savingSnippet}>
              {t('cancelSnippetButton')}
            </Button>
            <Button onClick={() => void handleSaveSnippet()} disabled={savingSnippet || !snippetDraftText.trim()}>
              {t('saveSnippetButton')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 导出范围。用户明确要求"只导置顶 / 只导隐藏 / 多选或全选指定内容"——
          做成四个并排的选项而不是一堆勾选框：这四种是**互斥**的，勾选框会让人
          以为可以叠加（"只导置顶 + 只导隐藏"其实是空集）。 */}
      {viewerIndex >= 0 && (
        <ClipboardImageViewer
          images={viewerImages}
          index={viewerIndex}
          mode={imageViewMode}
          onIndexChange={(next) => setViewerImageId(viewerImages[next]?.id ?? null)}
          onModeChange={setImageViewMode}
          onCopy={(img) => void copyImageToClipboard(img)}
          onClose={() => setViewerImageId(null)}
        />
      )}

      {/* 清理重复项。先列清单再动手——这是一次点击让一批内容从列表里消失的
          操作，不能默默做完再告诉用户。每组都写清楚"留一条、合并掉几条"。 */}
      <Dialog open={dupDialogOpen} onOpenChange={setDupDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('dedupeDialogTitle')}</DialogTitle>
            <DialogDescription>{t('dedupeDialogHint')}</DialogDescription>
          </DialogHeader>

          {dupScanning ? (
            <p className="py-6 text-center text-sm text-muted-foreground">{t('dedupeScanning')}</p>
          ) : dupGroups.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">{t('dedupeNoneFound')}</p>
          ) : (
            <>
              {/* 范围按钮改的是**勾选**，不是隐藏清单：三种范围下都仍然列出全部
                  重复组，只是把勾打在其中一批上，不在本次范围里的那些会淡显。
                  这样「只清理置顶/隐藏的重复」是一次看得见的缩小，而不是把其余
                  重复项悄悄藏起来让人以为已经没有了。 */}
              <div className="flex items-center gap-1.5">
                <span className="text-sm text-muted-foreground">{t('dedupeScopeLabel')}</span>
                {(['all', 'pinned', 'hidden'] as const).map((scope) => (
                  <Button
                    key={scope}
                    type="button"
                    size="sm"
                    variant={dupScope === scope ? 'default' : 'outline'}
                    className="h-7 px-2 text-sm"
                    onClick={() => selectDedupeScope(scope)}
                  >
                    {t(
                      scope === 'all'
                        ? 'dedupeScopeAll'
                        : scope === 'pinned'
                          ? 'dedupeScopePinned'
                          : 'dedupeScopeHidden',
                    )}
                    <span className="ml-1 tabular">{groupsForDedupeScope(dupGroups, scope).length}</span>
                  </Button>
                ))}
              </div>
              <div className="flex items-center gap-2 border-b border-border/70 pb-2">
                <Checkbox
                  id="dedupe-select-all"
                  checked={dupSelected.size === dupGroups.length && dupGroups.length > 0}
                  onCheckedChange={(v) =>
                    setDupSelected(v === true ? new Set(dupGroups.map((g) => g.content_hash)) : new Set())
                  }
                />
                <Label htmlFor="dedupe-select-all" className="text-sm text-muted-foreground">
                  {t('selectAllLabel')}
                </Label>
                <span className="ml-auto text-sm text-muted-foreground tabular">
                  {t('dedupeGroupsFound', { groups: dupGroups.length, count: dupSelectedCount })}
                </span>
              </div>
              <div className="max-h-72 space-y-1 overflow-y-auto pr-1">
                {dupGroups.map((group) => (
                  <label
                    key={group.content_hash}
                    className={cn(
                      'flex cursor-pointer items-start gap-2 rounded px-1 py-1.5 transition-colors hover:bg-surface',
                      // 不在当前范围里的组淡显——仍然看得见、仍然能手动勾，
                      // 只是明确告诉用户"这次的范围没圈到它"。
                      !dupScopeHashes.has(group.content_hash) && 'opacity-60',
                    )}
                  >
                    <Checkbox
                      checked={dupSelected.has(group.content_hash)}
                      onCheckedChange={(v) =>
                        setDupSelected((prev) => {
                          const next = new Set(prev)
                          if (v === true) next.add(group.content_hash)
                          else next.delete(group.content_hash)
                          return next
                        })
                      }
                      className="mt-0.5 shrink-0"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">
                        {/* 隐藏内容的正文在这里**不显示**。"只看隐藏"要过一次验证
                            才能进，如果重复清单直接把隐藏条目的原文摆出来，这个
                            对话框就成了绕开那道验证看隐藏内容的旁路。 */}
                        {group.is_hidden
                          ? t('dedupeHiddenPreview')
                          : group.preview || t(`type.${group.content_type}`)}
                      </span>
                      <span className="mt-0.5 flex items-center gap-2 text-sm text-muted-foreground">
                        <span className="tabular">{t('dedupeGroupCount', { count: group.count })}</span>
                        {group.is_pinned && (
                          <span className="inline-flex items-center gap-1">
                            <Pin className="size-3" />
                            {t('pinnedOnlyFilter')}
                          </span>
                        )}
                        {group.is_hidden && (
                          <span className="inline-flex items-center gap-1">
                            <EyeOff className="size-3" />
                            {t('hiddenOnlyFilter')}
                          </span>
                        )}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setDupDialogOpen(false)}>
              {t('cancelButton')}
            </Button>
            <Button
              onClick={() => void handleMergeDuplicates()}
              disabled={dupScanning || dupMerging || dupSelectedCount === 0}
            >
              {t('dedupeMergeButton', { count: dupSelectedCount })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={partialCopyEntry !== null} onOpenChange={(o) => !o && setPartialCopyEntry(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('partialCopyDialogTitle')}</DialogTitle>
          </DialogHeader>
          <Textarea
            ref={partialCopyTextareaRef}
            readOnly
            rows={10}
            className="font-mono text-sm"
            value={partialCopyEntry?.content_text ?? ''}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setPartialCopyEntry(null)}>
              {t('partialCopyCloseButton')}
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                const text = partialCopyEntry?.content_text ?? ''
                void copyText(text).then((ok) => ok && toast.success(t('partialCopyAllCopiedToast')))
              }}
            >
              {t('partialCopyCopyAllButton')}
            </Button>
            <Button
              onClick={() => {
                const textarea = partialCopyTextareaRef.current
                if (!textarea) return
                const start = textarea.selectionStart
                const end = textarea.selectionEnd
                if (start === end) {
                  toast.error(t('partialCopyNoSelectionToast'))
                  return
                }
                void copyText(textarea.value.slice(start, end)).then(
                  (ok) => ok && toast.success(t('partialCopySelectionCopiedToast')),
                )
              }}
            >
              {t('partialCopyCopySelectionButton')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={aiDialog.open} onOpenChange={(o) => !o && setAiDialog({ open: false, loading: false, result: '' })}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('aiResultDialogTitle')}</DialogTitle>
          </DialogHeader>
          {aiDialog.loading ? (
            <p className="text-sm text-muted-foreground">{t('aiProcessingToast')}</p>
          ) : (
            <div className="space-y-3">
              <p className="max-h-96 overflow-y-auto whitespace-pre-wrap break-words text-sm">{aiDialog.result}</p>
              <Button variant="outline" className="w-full" onClick={() => void copyText(aiDialog.result)}>
                {t('aiCopyResultButton')}
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Permanent delete confirmation dialog */}
      <Dialog open={deleteConfirm.open} onOpenChange={(o) => !o && setDeleteConfirm({ open: false, kind: 'single' })}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('permanentDeleteConfirmTitle')}</DialogTitle>
            <DialogDescription>
              {deleteConfirm.kind === 'bulk'
                ? t('permanentDeleteConfirmBulkDescription', { count: deleteConfirm.ids?.length ?? 0 })
                : t('permanentDeleteConfirmSingleDescription')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteConfirm({ open: false, kind: 'single' })}>
              {t('cancelButton')}
            </Button>
            <Button
              variant="destructive"
              onClick={deleteConfirm.kind === 'bulk' ? executeBulkHardDelete : executeHardDelete}
            >
              {t('permanentlyDeleteSelectedButton')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageShell>
  )
}

// 可拖拽置顶行：左侧专用把手，右侧原样嵌入 ClipboardRow。把手独立而非整行可拖：
// 行本体是「点击即粘贴」区域，
// 绑在整行即使有 distance 阈值，手抖也会变成拖拽。把手同时是键盘拖动焦点（tabIndex 由 @dnd-kit
// listeners 提供）。
function SortablePinnedRow({ id, children }: { id: number; children: React.ReactNode }) {
  const { t } = useTranslation('clipboard')
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn('flex items-stretch gap-1 p-1', isDragging && 'z-10 opacity-80 shadow-lg')}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={t('reorderPinnedHandleLabel')}
            className="flex shrink-0 cursor-grab items-center rounded px-1 text-muted-foreground hover:bg-muted active:cursor-grabbing"
            {...attributes}
            {...listeners}
          >
            <GripVertical className="h-4 w-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent>{t('reorderPinnedHandleLabel')}</TooltipContent>
      </Tooltip>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

/**
 * 右栏：这一条的完整内容。
 * 列表行被压成两三行高（长文本截断、富文本仅纯文字、图片仅 64px 缩略图），找的过程需要看全；
 * 右栏只摊开这一条，
 * 不重复列表已有的操作按钮，只放「粘贴」（看完后最可能的下一步）。
 */
function ClipboardDetailPane({
  entry,
  onPaste,
  onOpenImage,
  ...handlers
}: {
  entry: ClipboardEntry
  onPaste: () => void
  onOpenImage: () => void
} & ClipboardActionHandlers) {
  const { t } = useTranslation('clipboard')
  const Icon = TYPE_ICONS[entry.content_type]
  const sanitizedHtml = useMemo(
    () => (entry.content_format === 'rich' && entry.content_text ? sanitizeRichText(entry.content_text) : null),
    [entry.content_format, entry.content_text],
  )
  return (
    <>
      {/* 「粘贴」是主操作，实心按钮，永远排在最右；其余操作跟着它一排排开，
          换一条记录位置不变——跟密码页、笔记页同一条规则。 */}
      <WorkbenchDetailHeader
        icon={Icon}
        title={t(`type.${entry.content_type}`)}
        actions={
          <>
            <ClipboardDetailActions entry={entry} t={t} {...handlers} />
            <Button size="sm" onClick={onPaste}>
              <CopyCheck className="mr-2 size-4" aria-hidden="true" />
              {t('pasteButton')}
            </Button>
          </>
        }
      />
      <WorkbenchDetailBody>
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
          <dt className="text-muted-foreground">{t('detailTimeLabel')}</dt>
          <dd className={cn('min-w-0 break-words', NUMERIC_CLASS)}>{entry.created_at}</dd>
          {entry.content_text != null && (
            <>
              <dt className="text-muted-foreground">{t('detailLengthLabel')}</dt>
              <dd className={NUMERIC_CLASS}>{entry.content_text.length}</dd>
            </>
          )}
          {entry.source_app && (
            <>
              <dt className="text-muted-foreground">{t('sourceAppLabel')}</dt>
              <dd className="min-w-0 break-words">{entry.source_app}</dd>
            </>
          )}
        </dl>

        {entry.content_type === 'image' && entry.thumbnail_path ? (
          <button
            type="button"
            onClick={onOpenImage}
            className="ds-focus-ring self-start rounded border border-border/70 p-1"
          >
            <img
              src={`file://${entry.thumbnail_path}`}
              alt=""
              className="max-h-64 w-auto rounded"
            />
          </button>
        ) : sanitizedHtml ? (
          // 富文本走跟列表行同一个消毒函数——两处各消毒一次的话，迟早有一处漏掉。
          <div
            className="prose-clipboard min-w-0 overflow-x-auto text-sm"
            dangerouslySetInnerHTML={{ __html: sanitizedHtml }}
          />
        ) : (
          <p className="min-w-0 whitespace-pre-wrap break-words text-sm">
            {entry.content_text || t('imageNoPreview')}
          </p>
        )}
      </WorkbenchDetailBody>
    </>
  )
}

function ClipboardRow({
  entry,
  selected,
  onToggleSelected,
  onPaste,
  onActivate,
  onTogglePinned,
  onToggleHidden,
  onEdit,
  onFillRecipe,
  onDelete,
  onRestore,
  onHardDelete,
  onAiAction,
  onQuickConvert,
  onPartialCopy,
  onOpenImage,
  onOpenDetail,
  active = false,
}: {
  entry: ClipboardEntry
  selected?: boolean
  onToggleSelected?: (checked: boolean) => void
  onPaste?: () => void
  onActivate?: () => void
  onTogglePinned?: () => void
  onToggleHidden?: () => void
  onEdit?: () => void
  onFillRecipe?: () => void
  onDelete?: () => void
  onRestore?: () => void
  onHardDelete?: () => void
  onAiAction?: (action: AiClipboardAction) => void
  onQuickConvert?: (kind: QuickConvertKind) => void
  onPartialCopy?: () => void
  /** 点缩略图时打开原图查看器。不传就退回原来的静态缩略图。 */
  onOpenImage?: (entry: ClipboardEntry) => void
  /** 仅查看详情，不改动剪贴板。 */
  onOpenDetail?: () => void
  /** 这一条是不是正显示在右栏里。 */
  active?: boolean
}) {
  const { t } = useTranslation('clipboard')
  const Icon = TYPE_ICONS[entry.content_type]
  const activate = onActivate ?? onPaste
  const clickable = Boolean(activate)
  const sanitizedHtml = useMemo(
    () => (entry.content_format === 'rich' && entry.content_text ? sanitizeRichText(entry.content_text) : null),
    [entry.content_format, entry.content_text],
  )
  return (
    <div
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={activate}
      title={onActivate ? t('copyAndPreview') : undefined}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget || !activate || (e.key !== 'Enter' && e.key !== ' ')) return
        e.preventDefault()
        activate()
      }}
      className={cn(
        'flex items-start gap-3 rounded border p-3 text-left transition-colors',
        clickable && 'cursor-pointer hover:bg-accent/50',
        // 正在右栏显示的那一条：左边一条强调色竖线，跟工作台里别处同一个记号。
        active && 'bg-accent-soft shadow-[inset_2px_0_0_var(--primary)]',
      )}
    >
      {onOpenDetail && (
        <ActionButton
          region={LABEL_REGIONS.clipboardRow}
          stopPropagation
          icon={PanelRight}
          label={t('openDetailButton')}
          active={active}
          onClick={onOpenDetail}
          className="mt-0.5 shrink-0"
        />
      )}
      {onToggleSelected && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Checkbox
              className="mt-0.5 shrink-0"
              checked={!!selected}
              onClick={(e) => e.stopPropagation()}
              onCheckedChange={(v) => onToggleSelected(v === true)}
              aria-label={t('selectEntryAriaLabel')}
            />
          </TooltipTrigger>
          <TooltipContent>{t('selectEntryAriaLabel')}</TooltipContent>
        </Tooltip>
      )}
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            {entry.content_type === 'image' && entry.thumbnail_path ? (
              // 缩略图必须装在尺寸写死的框里：裸 <img> 只写 max-h 时解码前高度为 0，虚拟列表量到错误行高，
              // 加载后变高，连续几张图会互相压住。
              // 缩略图统一压到 256×256 内（clipboard/service.py THUMBNAIL_MAX_SIZE），固定 8rem
              // 见方的框不裁内容且行高从第一帧确定。
              // 历史图片与整行同样复制并预览；其他视图保留原图查看器。
              <button
                type="button"
                className="flex size-32 items-center justify-center overflow-hidden rounded border bg-surface transition-colors hover:border-primary"
                title={onActivate ? t('copyAndPreview') : onOpenImage ? t('imageViewerOpenHint') : undefined}
                onClick={(e) => {
                  e.stopPropagation()
                  if (onActivate) onActivate()
                  else onOpenImage?.(entry)
                }}
              >
                <img
                  src={`file://${entry.thumbnail_path}`}
                  alt={t('imageAlt')}
                  loading="lazy"
                  decoding="async"
                  className="max-h-full max-w-full object-contain"
                />
              </button>
            ) : sanitizedHtml !== null ? (
              // 列表行只给三行预览，不用 max-h-48 滚动块：实测每行 306px，872px 左栏装不下三条，
              // 而列表的意义是一眼看到尽可能多的条目；完整内容在右栏。
              // 行内再套滚动条也错：滚到底后事件冒泡给左栏，整列会跳一下。
              <div className="line-clamp-3 break-words text-sm [&_*]:inline [&_br]:hidden" dangerouslySetInnerHTML={{ __html: sanitizedHtml }} />
            ) : (
              <p className="line-clamp-3 whitespace-pre-wrap break-words text-sm">{entry.content_text || t('imageNoPreview')}</p>
            )}
          </div>
          {/*
            这里原先是一排最多九颗 `shrink-0` 的按钮（约 300px），而左栏总宽
            280–420px —— 内容预览分到的宽度在最窄处直接归零，看到的就是
            "每条历史记录没有正常显示"。现在收成一颗「更多」，宽度回到内容。
            完整的一排在右栏详情顶部（那里空间够），见 ClipboardDetailActions。
          */}
          {!onRestore && !onHardDelete && (
            <div className="flex shrink-0 gap-1">
              <ClipboardRowMenu
                entry={entry}
                t={t}
                onAiAction={onAiAction}
                onPartialCopy={onPartialCopy}
                onQuickConvert={onQuickConvert}
                onTogglePinned={onTogglePinned}
                onToggleHidden={onToggleHidden}
                onEdit={onEdit}
                onFillRecipe={onFillRecipe}
                onDelete={onDelete}
              />
            </div>
          )}
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('typeLabel', { type: t(`type.${entry.content_type}`) })}
          {entry.source_app ? ` · ${entry.source_app}` : ''}
          {' · '}
          {entry.created_at}
          {entry.is_truncated ? ` · ${t('truncatedBadge')}` : ''}
        </p>
      </div>
    </div>
  )
}
