import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type WheelEvent,
  } from 'react'
import {
  applyCategoryPrefs,
  displayLabel as categoryDisplayLabel,
  loadCategoryPrefs,
  makeCategoryComparator,
  moveInOrder,
  saveCategoryPrefs,
  CATEGORY_ICON_NAMES,
  CATEGORY_SORT_MODES,
  type CategoryIconName,
  type CategoryPrefs,
  type CategoryStat,
  } from '@/lib/categoryPrefs'
import { useTranslation } from 'react-i18next'
import { clearActivity,
  publishActivity } from '@/lib/continuity'
import { useTheme } from 'next-themes'
import { toast } from 'sonner'
import { useVirtualizer } from '@tanstack/react-virtual'
// codemirror 在这里只允许 `import type`：编辑器整套（约 395 KB）由 components/notes/NoteEditor 懒加
// 载，任何值引用都会把它拖回本分块让 lazy 白做且构建不报错。操作编辑器一律经
// lib/notes/editorRuntime 的reveal()。
import type { EditorView,
  ViewUpdate } from '@codemirror/view'

import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  BookOpen,
  Briefcase,
  CheckSquare,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Columns2,
  Contact2,
  CopyCheck,
  Download,
  Eye,
  EyeOff,
  FileCode,
  FileCog,
  Filter,
  Folder,
  FolderOpen,
  Globe,
  GraduationCap,
  Hash,
  Hexagon,
  History,
  Home,
  IdCard,
  ImagePlus,
  Inbox,
  Landmark,
  Layers,
  LayoutGrid,
  List,
  ListChecks,
  Locate,
  Lock,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  Palette,
  PanelLeftClose,
  PanelLeftOpen,
  PanelsTopLeft,
  Pause,
  Pin,
  PinOff,
  Play,
  Plus,
  PencilLine,
  Radio,
  Replace,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Square,
  SquareCheck,
  Tags,
  Tag,
  Star,
  Heart,
  Code,
  Camera,
  Music,
  NotebookText,
  TextCursorInput,
  Trash2,
  Type,
  Unlock,
  Upload,
  Volleyball,
  Wallet,
  Wand2,
  Wrench,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { IconToolbar } from '@/components/IconToolbar'
import { TopBar, TopBarSearch, type TopBarMenu, type TopBarNode } from '@/components/TopBar'
import { EmptyState, FeatureTitle, PageHeader } from '@/components/ui/page'
import { ActionButton } from '@/components/ActionButton'
import { LABEL_REGIONS } from '@/lib/labelMode'
import { Workbench } from '@/components/ui/workbench'
import { StatTile } from '@/components/StatTile'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { vaultApi } from '@/lib/vaultApi'
import { electronApi } from '@/lib/electronApi'
import { translateError } from '@/i18n/errors'
import {
  basenameOf,
  dirnameOf,
  getScopeMemory,
  joinPath,
  recordUsedPath,
  resolveDefaultPath,
  type PathMemoryScope,
} from '@/lib/pathMemory'
import { getHistory, getPosition, restoreFromHistory, savePosition, type NotePosition } from '@/lib/positionMemory'
import { reveal } from '@/lib/notes/editorRuntime'
// 章节扫描 / 分类树 / 列表筛选 / 正文查找这些纯逻辑放在 lib 里，以便 tests/noteFilters.test.mjs 直
// 接验证；搬迁时逻辑未改。
import {
  buildCategoryTree,
  computeFindMatches,
  extractChapters,
  filterNotes,
  filterScanFiles,
  isNoteInScope,
  nearestMatchIndex,
  sortNotes,
  type CategoryTreeNode,
  type FindMatch,
  type NoteScope,
} from '@/lib/notes/noteFilters'
import {
  computeNextBoundaryY,
  loadAutoScrollSettings,
  MAX_CUSTOM_SPEED_PX_PER_SEC,
  MIN_CUSTOM_SPEED_PX_PER_SEC,
  paragraphPauseMs,
  rampFactorFor,
  saveAutoScrollSettings,
  speedPxPerSecFor,
  type AutoScrollSettings,
  type AutoScrollSpeedPreset,
  type AutoScrollUnit,
} from '@/lib/autoScroll'
import type { ExportableNote } from '@/lib/notesExport'
import { categoryPathLabel, categoryTreeToNodes } from '@/components/notes/categoryNodes'
import { NoteCategoryPicker, NoteTagPicker } from '@/components/notes/NoteCategoryPicker'
import { NoteTimelineDialog, type NoteTimelineTarget } from '@/components/notes/NoteTimelineDialog'
import { NoteBulkEditDialog } from '@/components/notes/NoteBulkEditDialog'
import { NoteDuplicatesDialog } from '@/components/notes/NoteDuplicatesDialog'
import { DEFAULT_NOTE_SORT_MODE, sortNotesBy } from '@/components/notes/noteSort'
import type {
  Note,
  NoteCategory,
  NoteCategoryDeleteMode,
  NoteCategoryImpact,
  NoteCategoryScope,
  NoteReclassifyChange,
  NoteFormat,
  NoteTag,
  NoteImageFull,
  NoteImageMeta,
  NoteImportProgress,
  NoteListItem,
  NoteScanFile,
  NoteSortMode,
} from '@/shared/ipcTypes'

function formatScanFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// 超过此字节数的笔记进"大文件模式"：正文走分段会话逐段加载/编辑/保存；低于阈值走原逻辑。
const LARGE_NOTE_THRESHOLD_BYTES = 8 * 1024 * 1024

// 大文件模式靠滚到已加载范围边界时懒加载上/下一段并拼接（maybeLoadMoreSegments）。
// MAX_LOADED_SEGMENTS 封顶同时拼接的段数（每段最大 512KB，12 段约 6MB，CodeMirror 仍在毫秒级），超
// 出后改用"上一段/下一段"按钮或搜索定位。
const MAX_LOADED_SEGMENTS = 12
const PREFETCH_MARGIN_VIEWPORTS = 3

// 大文件模式下已拼进编辑器的一段。start/end 是它在 draftContent 的字符范围，每次编辑器内容变化都经
// ChangeSet.mapPos 重新映射（handleEditorUpdate），无需重扫全文。baseline 是该段最近加载/保存成功的
// 内容，与 draftContent.slice(start, end) 精确比较是 O(段大小)，只在真正保存时用；dirty 是
// ChangeSet.touchesRange 增量维护的廉价近似，供每次渲染的 UI 使用。handleSaveLargeNote 保存时仍做精
// 确比较，dirty 只缩小候选，不单独决定是否保存。
interface LoadedSegment {
  ordinal: number
  id: number
  revision: number
  start: number
  end: number
  baseline: string
  dirty: boolean
}

// 分块转 base64，避免大图片时 String.fromCharCode(...bytes) 展开参数超过
// JS 引擎的调用栈上限（粘贴截图走这条路径，截图动辄几百 KB~几 MB）。
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}

// 不读本机已装字体列表：Windows 下 Electron 没有稳定原生 API，读注册表要额外 npm 包，且会塞进一堆隐
// 藏字体；改用预置的粗粒度列表。
type EditorFont = 'default' | 'mono' | 'serif' | 'rounded'
const EDITOR_FONT_OPTIONS: EditorFont[] = ['default', 'mono', 'serif', 'rounded']
// mono 不设 fontFamily 覆盖——CodeMirror 的 basicSetup 本来就是等宽字体，
// 保持原生栈反而更准（不同系统装的等宽字体不一样，硬指定容易找不到）。
const EDITOR_FONT_FAMILY: Record<EditorFont, string | undefined> = {
  default: 'var(--font-sans)',
  mono: undefined,
  serif: 'Georgia, "Noto Serif SC", serif',
  rounded: '"PingFang SC", "Microsoft YaHei UI", sans-serif',
}
const EDITOR_FONT_SIZES = [12, 13, 14, 15, 16, 18, 20, 22, 24]
const EDITOR_FONT_WEIGHTS = [400, 500, 600] as const
type EditorFontWeight = (typeof EDITOR_FONT_WEIGHTS)[number]
// 16px = 小四（12pt @ 96dpi），对齐应用默认字号档位（lib/fontSize.ts）。编辑器保留独立字号选择器是
// 刻意的，长时间阅读常需与界面不同的字号；列表里的 18 约为四号。
const DEFAULT_EDITOR_FONT_SIZE = 16
const DEFAULT_EDITOR_FONT_WEIGHT: EditorFontWeight = 400

const EDITOR_FONT_STORAGE_KEY = 'ideal1-notes-editor-font'
const EDITOR_FONT_SIZE_STORAGE_KEY = 'ideal1-notes-editor-font-size'
const EDITOR_FONT_WEIGHT_STORAGE_KEY = 'ideal1-notes-editor-font-weight'
const CHAPTERS_OPEN_STORAGE_KEY = 'ideal1-notes-chapters-open'
// 笔记列表列是否折叠——折叠后详情/编辑区独占主视觉位置（"C位"），列表缩成
// 一条只剩展开按钮的窄边。默认展开，跟其它UI偏好一样持久化在localStorage。
const LIST_COLLAPSED_STORAGE_KEY = 'ideal1-notes-list-collapsed'
// 字体/自动滚动控制项默认收起（同 chaptersOpen 模式）以减少详情区顶部拥挤；展开状态持久化。
const AUTO_SCROLL_CONTROLS_OPEN_STORAGE_KEY = 'ideal1-notes-autoscroll-controls-open'
// 笔记列表的排序方式（创建 / 修改时间 / 标题）。只在前端重排，不改后端顺序。
const NOTE_SORT_MODE_STORAGE_KEY = 'ideal1-notes-sort-mode'
const LIST_NOTE_SORT_MODES: readonly NoteSortMode[] = ['created', 'updated', 'title']
// 时间线里「与当前版本对比」要把当前正文整篇读进来，超过后端存快照的上限
// （notes/storage.py 的 REVISION_CONTENT_LIMIT）时那一版本来也没有正文可比。
const REVISION_CONTENT_LIMIT_BYTES = 2 * 1024 * 1024
const DRAFT_RECOVERY_STORAGE_KEY = 'ideal1-notes-draft-recovery-v1'
const DRAFT_RECOVERY_INTERVAL_MS = 2_000

interface DraftRecoverySnapshot {
  savedAt: number
  detailId: number | null
  creatingNew: boolean
  title: string
  category: string
  content: string
  // 仅大文件模式有意义：content 是"哪一段"的正文快照。恢复时若重新打开的笔记落在另一段，绝不能覆盖到
  // 不相关的段，宁可放弃恢复。
  segmentOrdinal?: number
}

function loadStoredChaptersOpen(): boolean {
  return localStorage.getItem(CHAPTERS_OPEN_STORAGE_KEY) !== 'false'
}

function loadStoredListCollapsed(): boolean {
  return localStorage.getItem(LIST_COLLAPSED_STORAGE_KEY) === 'true'
}

function loadStoredNoteSortMode(): NoteSortMode {
  const stored = localStorage.getItem(NOTE_SORT_MODE_STORAGE_KEY) as NoteSortMode | null
  return stored && LIST_NOTE_SORT_MODES.includes(stored) ? stored : DEFAULT_NOTE_SORT_MODE
}


function loadStoredAutoScrollControlsOpen(): boolean {
  return localStorage.getItem(AUTO_SCROLL_CONTROLS_OPEN_STORAGE_KEY) === 'true'
}

function loadStoredFont(): EditorFont {
  const stored = localStorage.getItem(EDITOR_FONT_STORAGE_KEY)
  return (EDITOR_FONT_OPTIONS as string[]).includes(stored ?? '') ? (stored as EditorFont) : 'default'
}

function loadStoredFontSize(): number {
  const stored = Number(localStorage.getItem(EDITOR_FONT_SIZE_STORAGE_KEY))
  return EDITOR_FONT_SIZES.includes(stored) ? stored : DEFAULT_EDITOR_FONT_SIZE
}

function loadStoredFontWeight(): EditorFontWeight {
  const stored = Number(localStorage.getItem(EDITOR_FONT_WEIGHT_STORAGE_KEY))
  return (EDITOR_FONT_WEIGHTS as readonly number[]).includes(stored) ? (stored as EditorFontWeight) : DEFAULT_EDITOR_FONT_WEIGHT
}

// 正文查找/替换（Ctrl+F/Ctrl+H）：不用 @codemirror/search，它的高亮只在自带搜索面板打开时生效（
// searchHighlighter 判断 `!panel`），绕开需伪造隐形 panel，升级易失效。改为在 draftContent 上纯 JS
// 找区间（lib/notes/noteFilters 的computeFindMatches），用 editorViewRef dispatch 跳转/替换。

// Markdown 源码/预览/分屏三视图，仅 format==='markdown' 的笔记显示。NoteScope（active / hidden /
// all）：`all` 和 `hidden` 都会让隐藏笔记上屏，两者都必须先过`ensureFreshlyUnlocked()`；判据是"这次
// 切换会不会让隐藏内容可见"，不是名字里有没有 hidden。

type MarkdownViewMode = 'source' | 'preview' | 'split'
const MARKDOWN_VIEW_MODE_STORAGE_KEY = 'ideal1-notes-markdown-view-mode'

function loadStoredMarkdownViewMode(): MarkdownViewMode {
  const stored = localStorage.getItem(MARKDOWN_VIEW_MODE_STORAGE_KEY)
  return stored === 'preview' || stored === 'split' ? stored : 'source'
}

// 预览面板按需加载（带 markdown-it）。别改回静态 import：会把 markdown-it 钉回首屏分块，只表现为打
// 开变慢，无报错。
const MarkdownPreview = lazy(() => import('@/components/notes/MarkdownPreview'))

// 正文编辑器按需加载（@uiw/react-codemirror + basicSetup 压缩后约 395 KB，界面里最大一块）。别改回
// 静态 import，理由见 notes/NoteEditor.tsx。
const NoteEditor = lazy(() => import('@/components/notes/NoteEditor'))

function toMetaItem(note: NoteListItem): NoteListItem {
  return {
    id: note.id,
    title: note.title,
    category: note.category,
    preview: note.preview,
    content_storage_mode: note.content_storage_mode,
    format: note.format,
    tags: note.tags,
    content_length: note.content_length,
    is_pinned: note.is_pinned,
    is_hidden: note.is_hidden,
    is_deleted: note.is_deleted,
    // 手动排序位要原样带过来：漏掉任何字段，该笔记在列表里就被重置为默认值，手动摆好的位置保存一次后会
    // 悄悄跳回。
    sort_order: note.sort_order,
    created_at: note.created_at,
    updated_at: note.updated_at,
  }
}

/** 图标名 → 组件。偏好里存的是名字（好序列化），渲染时在这里查回组件。 */
const CATEGORY_ICON_COMPONENTS: Record<string, typeof Folder> = {
  Folder, Briefcase, Home, GraduationCap, IdCard, Wrench, Contact2, Volleyball,
  Palette, Globe, Hexagon, Landmark, Radio, Wallet, Lock, Star, Heart, Tag,
  BookOpen, Code, Camera, Music, MoreHorizontal,
}

export function NotesScreen({
  ensureFreshlyUnlocked,
  pendingImportPath,
  onPendingImportHandled,
  pendingQuickCapture,
  onQuickCaptureHandled,
  isProfessional = false,
}: {
  ensureFreshlyUnlocked: () => Promise<boolean>
  // 用 txt 的"打开方式"选中本应用时待导入的文件路径；非空时面板挂载/收到新值即自动导入并打开详情。处
  // 理完（无论成败）必须调用 onPendingImportHandled 清空，否则下次切回会重复导入。
  pendingImportPath?: string | null
  onPendingImportHandled?: () => void
  // 全局速记快捷键（Ctrl+Shift+N）：AppShell 完成模块解锁校验并切到本面板后才置 true（见 AppShell.tsx
  // 的 pendingQuickCapture）。处理完必须调用 onQuickCaptureHandled 清空，否则下次挂载重复触发。
  pendingQuickCapture?: boolean
  onQuickCaptureHandled?: () => void
  isProfessional?: boolean
}) {
  const { t } = useTranslation('notes')
  const { t: tCommon } = useTranslation('common')
  const { resolvedTheme } = useTheme()
  const [viewMode, setViewMode] = useState<'active' | 'trash'>('active')
  const [notes, setNotes] = useState<NoteListItem[]>([])
  const [trash, setTrash] = useState<NoteListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  // --- 迷你指标仪表盘，纯前端计算 ----
  const noteStats = useMemo(() => {
    const activeNotes = notes.filter((n) => !n.is_hidden).length
    const hiddenNotes = notes.filter((n) => n.is_hidden).length
    const trashedCount = trash.length
    return { total: notes.length, active: activeNotes, hidden: hiddenNotes, trashed: trashedCount }
  }, [notes, trash])
  const [search, setSearch] = useState('')
  const [searchResultIds, setSearchResultIds] = useState<Set<number> | null>(null)
  const [tagFilter, setTagFilter] = useState<string>('all')
  const [categoryFilter, setCategoryFilter] = useState<string>('all')
  const [pinnedOnly, setPinnedOnly] = useState(false)
  // 列表范围是三态而非"只看隐藏"布尔：noteStats 有四个数字，两态下「总计」没有对应列表、会与「活跃」
  // 撞车。三态后每个数字严格对应一个列表：总计→all、活跃→active、已隐藏→hidden（回收站走 viewMode）。
  const [noteScope, setNoteScope] = useState<NoteScope>('active')
  // 既有消费者只需区分"隐藏池 / 普通池"（分类与标签是两个独立池），继续用此派生值；'all' 落到普通池一
  // 侧，与新增 'all' 前行为一致，只有真正需要跨池处（下面的 scoped*）才特别处理 'all'。
  const hiddenOnly = noteScope === 'hidden'
  // 笔记是否属于当前范围。收成一个函数，避免列表过滤、"有无未分类"、分类计数三处各写一遍 `hiddenOnly
  // ? ...`，加范围只改这里。
  const noteInScope = useCallback(
    (note: { is_hidden: number }) => isNoteInScope(note, noteScope),
    [noteScope],
  )
  // 回收站里有几条因为还没解锁而被扣着不显示。数字本身不敏感（跟「已隐藏 7」
  // 一样只暴露条数，不暴露内容），但必须让用户知道列表是不全的。
  const hiddenTrashedWithheld = useMemo(
    () => (noteScope === 'active' ? trash.filter((n) => n.is_hidden).length : 0),
    [trash, noteScope],
  )
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [deleteConfirm, setDeleteConfirm] = useState<{
    open: boolean; kind: 'single' | 'bulk'; id?: number; ids?: number[]
  }>({ open: false, kind: 'single' })
  const undoDeleteTimerRef = useRef<number | null>(null)
  const [recoverySnapshot, setRecoverySnapshot] = useState<DraftRecoverySnapshot | null>(null)
  // 恢复"已有笔记的未保存编辑"时，标题/正文必须等 detailId 触发的加载 effect 完成后再覆盖，同步赋值会
  // 被它随后的 setDraftTitle/setDraftContent（服务端原文）盖回。本 state 记录"有草稿等目标笔记加载完
  // "。
  const [pendingDraftOverlay, setPendingDraftOverlay] = useState<DraftRecoverySnapshot | null>(null)

  const [detailId, setDetailId] = useState<number | null>(null)
  const [detailNote, setDetailNote] = useState<Note | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)

  // 「接着刚才」：把当前笔记播报给别的设备（见 lib/continuity.ts）。只播报标题、正文一个字节不出本机—
  // —提示只为提醒"那边还有事"，搬内容是笔记同步的事，重复做只增加泄漏面。卸载时收回：否则手机上那条提
  // 示会一直挂到 90 秒过期，期间是假提示。
  useEffect(() => {
    if (detailNote) {
      publishActivity({ kind: 'note', title: detailNote.title, localId: String(detailNote.id) })
    } else {
      clearActivity()
    }
  }, [detailNote])

  useEffect(() => clearActivity, [])
  const [creatingNew, setCreatingNew] = useState(false)
  // "标题共同出现"提示：哪些其它笔记的正文提到了当前标题。完整双向 [[链接]] 已被标为架构风险推迟，这
  // 是低成本平替（见 notes/storage.py::find_notes_mentioning_title）。
  const [titleMentions, setTitleMentions] = useState<NoteListItem[]>([])
  const [draftTitle, setDraftTitle] = useState('')
  const [draftCategory, setDraftCategory] = useState('')
  const [draftContent, setDraftContent] = useState('')
  const [saving, setSaving] = useState(false)
  // 自动保存三态："编辑中"(dirty) / "保存中"(saving) / "已保存 HH:mm"(lastSavedAt)；lastSavedAt 在手
  // 动或自动保存成功后都更新。
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null)
  const [editorFont, setEditorFont] = useState<EditorFont>(loadStoredFont)
  const [editorFontSize, setEditorFontSize] = useState<number>(loadStoredFontSize)
  const [editorFontWeight, setEditorFontWeight] = useState<EditorFontWeight>(loadStoredFontWeight)
  const [chaptersOpen, setChaptersOpen] = useState<boolean>(loadStoredChaptersOpen)
  const [listCollapsed, setListCollapsed] = useState<boolean>(loadStoredListCollapsed)
  const [noteSortMode, setNoteSortMode] = useState<NoteSortMode>(loadStoredNoteSortMode)
  // 顶栏弹出的三个对话框。null = 关着。
  const [timelineTarget, setTimelineTarget] = useState<NoteTimelineTarget | null>(null)
  const [bulkEdit, setBulkEdit] = useState<{ op: 'replace' | 'prepend' | 'append'; noteIds: number[] } | null>(null)
  const [dedupeScope, setDedupeScope] = useState<NoteCategoryScope | null>(null)
  // 恢复到某一版 / 整批撤销之后，右栏要按后端的新内容重读一遍；detailId 没变，
  // 光靠它触发不了下面那个读正文的 effect，所以另给一个计数。
  const [detailReloadKey, setDetailReloadKey] = useState(0)
  const [autoScrollControlsOpen, setAutoScrollControlsOpen] = useState<boolean>(loadStoredAutoScrollControlsOpen)
  const [markdownViewMode, setMarkdownViewMode] = useState<MarkdownViewMode>(loadStoredMarkdownViewMode)
  // 预览相对 draftContent 防抖 200ms：大文件流式增长或快速敲字（尤其分屏时源码与预览同时挂载）不必每
  // 字符重跑 markdown-it。
  const [debouncedMarkdownContent, setDebouncedMarkdownContent] = useState('')
  const [findPanelOpen, setFindPanelOpen] = useState(false)
  const [findShowReplace, setFindShowReplace] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [replaceQuery, setReplaceQuery] = useState('')
  const [findCaseSensitive, setFindCaseSensitive] = useState(false)
  const [findRegexp, setFindRegexp] = useState(false)
  const [findWholeWord, setFindWholeWord] = useState(false)
  const [findAdvancedOpen, setFindAdvancedOpen] = useState(false)
  const [findMatches, setFindMatches] = useState<FindMatch[]>([])
  const [findMatchIndex, setFindMatchIndex] = useState(-1)
  const [findCapped, setFindCapped] = useState(false)
  const [findError, setFindError] = useState(false)
  const editorViewRef = useRef<EditorView | null>(null)
  const findInputRef = useRef<HTMLInputElement | null>(null)

  // 阅读/编辑位置记忆，见 lib/positionMemory.ts。切换笔记时 EditorView 复用（详情面板不卸载），用 ref
  // 记录当前笔记，供滚动监听等异步回调读取最新值而非闭包旧值。
  const currentNoteIdRef = useRef<number | null>(null)
  const positionSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const positionMarkerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scrollListenerAttachedRef = useRef(false)
  const backToPositionThrottleRef = useRef(0)
  // 分段大笔记当前在哪一段，供稳定引用的 schedulePositionSave 读取（放进依赖数组会使每次切段重建防抖
  // 定时器）；随 setSegmentOrdinal 同步更新，不用 effect 镜像。
  const segmentOrdinalRef = useRef(0)
  // 当前打开的分段会话 id——只有加载 effect 的清理函数会读它（笔记切换/
  // 组件卸载时关闭会话），不参与渲染，用 ref 足够。
  const segmentSessionIdRef = useRef<string | null>(null)

  // ---- 自动滚动（见 lib/autoScroll.ts） ----
  const [autoScrollSettings, setAutoScrollSettings] = useState<AutoScrollSettings>(() => loadAutoScrollSettings())
  const [autoScrollActive, setAutoScrollActive] = useState(false)
  const [autoScrollProgress, setAutoScrollProgress] = useState(0)
  const autoScrollSettingsRef = useRef(autoScrollSettings)
  const autoScrollRafRef = useRef<number | null>(null)
  const autoScrollRuntimeRef = useRef<{ startTime: number; lastFrameTime: number; boundaryTargetY: number | null; pausedUntil: number | null } | null>(null)
  // rAF 里派发的 scrollTop 变化也会触发 scroll 事件；此标记区分"自动滚动自己引起的"和"用户手动滚动"（
  // 后者要暂停自动滚动，PRD 的滚轮暂停方式）。
  const autoScrollDrivenRef = useRef(false)
  const [showBackToPosition, setShowBackToPosition] = useState(false)
  const [positionHistoryOpen, setPositionHistoryOpen] = useState(false)

  // "大文件模式"（见 LARGE_NOTE_THRESHOLD_BYTES）：正文走分段会话（
  // note_content_session_open/segment_get/segment_put，notes/service.py 的 open_segment_session 系
  // 列），内存只留当前段（≤512KB，segmented_content.MAX_SEGMENT_BYTES）。CodeMirror 的 value 即
  // draftContent，大小有界，无需旧版 largeContentRef 旁路。largeNoteBaseline 记进入时的标题/分类（大
  // 笔记不经 note_get，没有 detailNote 可比）。
  const [isLargeNote, setIsLargeNote] = useState(false)
  const [largeNoteBaseline, setLargeNoteBaseline] = useState<{ title: string; category: string } | null>(null)
  // 分段导航：segmentCount 为总段数；segmentOrdinal 为当前聚焦段（从 0 起），随滚动/光标更新（见
  // computeFocusedOrdinal），不再等于"唯一加载的段"。loadedSegments 是已拼进 draftContent 的各段，按
  // ordinal 升序首尾相接（向上滚加载更早的段后，第一段 start 不一定是 0）。
  const [segmentCount, setSegmentCount] = useState(0)
  const [segmentOrdinal, setSegmentOrdinal] = useState(0)
  const [loadedSegments, setLoadedSegments] = useState<LoadedSegment[]>([])
  // 供稳定回调同步读最新值，同 autoScrollSettingsRef 模式：CodeMirror 滚动监听只挂一次（
  // scrollListenerAttachedRef），闭包会锁住挂载时的状态，只有 ref 能读到最新值，所以这几个状态各配同
  // 步 ref。
  const loadedSegmentsRef = useRef<LoadedSegment[]>([])
  const segmentCountRef = useRef(0)
  const readOnlyBootstrapRef = useRef(false)
  const segmentNavigatingRef = useRef(false)
  useEffect(() => {
    loadedSegmentsRef.current = loadedSegments
  }, [loadedSegments])
  useEffect(() => {
    segmentCountRef.current = segmentCount
  }, [segmentCount])
  // 懒加载下一段/上一段的请求防重入——正在取的时候再次触发（比如滚动
  // 事件密集触发）直接跳过，避免同一段被重复拼接两次。
  const segmentFetchDirectionRef = useRef<'next' | 'prev' | null>(null)
  const [segmentNavigating, setSegmentNavigating] = useState(false)
  useEffect(() => {
    segmentNavigatingRef.current = segmentNavigating
  }, [segmentNavigating])
  // 只读引导：分段会话打开/切段的短暂过渡期，防止用户在内容将被替换时打字。打开大笔记或点上/下一段时
  // 置 true，内容到位即置回 false。
  const [readOnlyBootstrap, setReadOnlyBootstrap] = useState(false)
  useEffect(() => {
    readOnlyBootstrapRef.current = readOnlyBootstrap
  }, [readOnlyBootstrap])
  const [fullscreen, setFullscreen] = useState(false)
  const [importing, setImporting] = useState(false)
  const [exporting, setExporting] = useState(false)
  // 详情页单条导出，与 exporting（列表批量导出选中项，仅 txt）是两套独立状态。docx/pdf 只在单条支持，
  // P0 不支持批量，见 markdownToDocxParagraphs 附近。
  const [exportFormat, setExportFormat] = useState<'txt' | 'docx' | 'pdf'>('txt')
  const [exportingDetail, setExportingDetail] = useState(false)

  // "从文件夹批量导入"，与 handleImportFiles（原生多选对话框）是独立入口：先递归扫描根文件夹下所有txt
  // 一次性列出，之后的筛选/勾选是纯内存过滤（筛选要 ms 级的关键），确认后才导入。
  const [folderImportOpen, setFolderImportOpen] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [scanRootDir, setScanRootDir] = useState('')
  const [scanFiles, setScanFiles] = useState<NoteScanFile[]>([])
  const [scanSearch, setScanSearch] = useState('')
  const [scanSelectedPaths, setScanSelectedPaths] = useState<Set<string>>(new Set())
  // 整批默认的加密选择 + 逐文件可覆盖（两者都要）：一行最终状态 = scanEncryptOverrides 里该行的值，没
  // 有则回退 scanBatchEncrypt。
  const [scanBatchEncrypt, setScanBatchEncrypt] = useState(true)
  // 设置页「笔记正文默认存储方式」。每次写入前现读，不缓存进 state：用户刚改完设置就新建笔记，缓存会
  // 按旧设置写，违背"立即生效"。读几十字节本地 JSON，成本可忽略；读失败回落到"加密"（更安全）。注意此
  // 设置必须同时作用于新建笔记和单文件导入（它们要传 `encrypt`，否则后端默认 True），不能只管文件夹批
  // 量导入弹窗。
  async function resolveDefaultEncrypt(): Promise<boolean> {
    const res = await vaultApi.call('note_text_storage_mode_get', {})
    return res.ok ? res.mode === 'encrypted_db' : true
  }
  const [scanEncryptOverrides, setScanEncryptOverrides] = useState<Map<string, boolean>>(new Map())
  // "整批导入到隐藏分类"：scanImportHidden 决定落隐藏区还是普通区，scanImportCategory 是整批共同的分
  // 类前缀（可为多级如 `私密/财务/2026`）。前缀与文件所在子文件夹派生的分类是拼接而非二选一，见
  // backend_server.py 的 _join_category。每次打开对话框都重置，避免不知不觉继续导入隐藏区。
  const [scanImportHidden, setScanImportHidden] = useState(false)
  const [scanImportCategory, setScanImportCategory] = useState('')
  const [scanImporting, setScanImporting] = useState(false)
  // note_import_files 是进度汇报型 RPC（见 backend_server.py），订阅字节级进度取代笼统的 loading 态；
  // 几百 MB 大文件批量导入时才看得出差别。
  const [scanImportProgress, setScanImportProgress] = useState<{
    fileIndex: number
    totalFiles: number
    fileName: string
    done: number
    total: number
  } | null>(null)

  // 手动创建的分类目录（跟"笔记已经用过的分类"是两回事，见 note_category_*
  // 的类型注释）——普通/隐藏笔记各自一套，互相独立。
  const [normalCategories, setNormalCategories] = useState<NoteCategory[]>([])
  const [hiddenCategories, setHiddenCategories] = useState<NoteCategory[]>([])
  const [categoryManagerOpen, setCategoryManagerOpen] = useState(false)
  // 分类的显示偏好（删掉哪些预设、改的名字和图标、手动顺序）。
  // 只影响界面呈现，不碰笔记数据库——见 lib/categoryPrefs.ts。
  const [categoryPrefs, setCategoryPrefs] = useState<CategoryPrefs>(() => loadCategoryPrefs())

  const updateCategoryPrefs = useCallback((next: CategoryPrefs) => {
    setCategoryPrefs(next)
    saveCategoryPrefs(next)
  }, [])
  const [newNormalCategoryName, setNewNormalCategoryName] = useState('')
  const [newHiddenCategoryName, setNewHiddenCategoryName] = useState('')
  // 分类管理弹窗里"隐藏笔记分类"栏默认锁着（不显示真实分类名），与 changeNoteScope 同理：这也是能看到
  // 隐藏分类名的入口，必须过 ensureFreshlyUnlocked。已在 hiddenOnly 视图时视为刚验证过；弹窗关闭后重
  // 置，与"只看隐藏"每次重开都重新验证同强度。
  const [hiddenCategoriesRevealed, setHiddenCategoriesRevealed] = useState(false)
  // 删分类的确认框：非空时说明正在等用户选删除语义。存的是后端算好的影响范围
  // （子分类数/直接笔记数/子孙笔记数），确认框据此把后果说清楚。
  const [categoryDeleteTarget, setCategoryDeleteTarget] = useState<{
    scope: NoteCategoryScope
    impact: NoteCategoryImpact
  } | null>(null)
  // 正在重命名的分类。物化路径下重命名和移动是同一个操作（换一段路径前缀），
  // 所以输入框里填的是完整路径，改父级就等于移动整棵子树。
  const [renamingCategory, setRenamingCategory] = useState<{ id: number; name: string } | null>(null)
  // 回溯重分类的预览结果。null = 还没跑过预览；非 null 时展示"哪几篇会从 X
  // 改到 Y"，用户确认后才写。
  const [reclassify, setReclassify] = useState<{
    scope: NoteCategoryScope
    includeCategorized: boolean
    changes: NoteReclassifyChange[]
    truncated: boolean
    scanned: number
  } | null>(null)
  const [reclassifyLoading, setReclassifyLoading] = useState(false)
  const [normalTags, setNormalTags] = useState<NoteTag[]>([])
  const [hiddenTags, setHiddenTags] = useState<NoteTag[]>([])
  const [tagManagerOpen, setTagManagerOpen] = useState(false)
  const [newTagName, setNewTagName] = useState('')
  const [detailTagIds, setDetailTagIds] = useState<number[]>([])

  // 笔记里挂的图片——只有已经保存过的笔记（有 note_id）才能挂图片，新建
  // 中还没保存的草稿不显示图片区（见下面渲染部分的 creatingNew 分支）。
  const [noteImages, setNoteImages] = useState<NoteImageMeta[]>([])
  const [imagesLoading, setImagesLoading] = useState(false)
  const [imageImporting, setImageImporting] = useState(false)
  const [imageViewerOpen, setImageViewerOpen] = useState(false)
  const [viewingImage, setViewingImage] = useState<NoteImageFull | null>(null)
  const [viewingImageLoading, setViewingImageLoading] = useState(false)

  async function reloadCategories() {
    const [normalRes, hiddenRes] = await Promise.all([
      vaultApi.call('note_category_list', { scope: 'normal' }),
      vaultApi.call('note_category_list', { scope: 'hidden' }),
    ])
    if (normalRes.ok) setNormalCategories(normalRes.categories)
    if (hiddenRes.ok) setHiddenCategories(hiddenRes.categories)
  }

  async function reloadTags() {
    const [normalRes, hiddenRes] = await Promise.all([
      vaultApi.call('note_tag_list', { scope: 'normal' }),
      vaultApi.call('note_tag_list', { scope: 'hidden' }),
    ])
    if (normalRes.ok) setNormalTags(normalRes.tags)
    if (hiddenRes.ok) setHiddenTags(hiddenRes.tags)
  }

  async function reload() {
    // note_list 有两种失败：应用层 {ok:false}（正常 resolve），以及 _require_notes_service() 抛出的传输
    // 层错误（如会话中金库被锁），后者让 promise reject（见 pythonBridge.ts），所以除了检查 res.ok 还要
    // try/catch。
    try {
      const res = await vaultApi.call('note_list', {})
      if (!res.ok) {
        const message = translateError(res.error, res.error_params)
        toast.error(t('loadFailedToast'), { description: message })
        setLoadError(message)
        return
      }
      setNotes(sortNotes(res.notes))
      setLoadError(null)
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
    const res = await vaultApi.call('note_list_trash', {})
    if (res.ok) setTrash(res.notes)
  }

  useEffect(() => {
    reload()
    reloadCategories()
    reloadTags()
    // 文件夹批量导入弹窗里"整批加密"开关的初始值，与新建笔记/单文件导入同用一个设置（SettingsScreen.tsx
    // 的 NoteTextStorageModeSetting）。渲染时就需要初始值所以额外缓存一份；真正写入一律现读
    // resolveDefaultEncrypt()。设置只是默认值，弹窗里仍可整批改或逐行覆盖。
    vaultApi.call('note_text_storage_mode_get', {}).then((res) => {
      if (res.ok) setScanBatchEncrypt(res.mode === 'encrypted_db')
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-once
  }, [])

  useEffect(() => {
    if (viewMode === 'trash') reloadTrash()
    setSelectedIds(new Set()) // 切换视图时选择状态不该带过去，避免误删/误恢复
  }, [viewMode])

  useEffect(() => {
    try {
      const stored = localStorage.getItem(DRAFT_RECOVERY_STORAGE_KEY)
      if (!stored) return
      const snapshot = JSON.parse(stored) as DraftRecoverySnapshot
      if (snapshot && typeof snapshot.content === 'string' && typeof snapshot.savedAt === 'number') {
        setRecoverySnapshot(snapshot)
      }
    } catch {
      localStorage.removeItem(DRAFT_RECOVERY_STORAGE_KEY)
    }
  }, [])

  useEffect(() => {
    if ((!creatingNew && detailId === null) || readOnlyBootstrap) return
    const isDraftDirty = creatingNew ||
      (isLargeNote
        ? isLargeNoteContentDirty(loadedSegments) || draftTitle !== largeNoteBaseline?.title || draftCategory !== largeNoteBaseline?.category
        : detailNote !== null && (draftTitle !== detailNote.title || draftCategory !== detailNote.category || draftContent !== detailNote.content))
    if (!isDraftDirty) return
    // 大文件模式下崩溃快照只记当前聚焦段，不记整个拼接窗口：崩溃恢复只为不丢正在编辑的部分，且避免
    // localStorage 单条写入随窗口增大而膨胀。
    const focusedSegment = isLargeNote ? loadedSegments.find((seg) => seg.ordinal === segmentOrdinal) : undefined
    const handle = window.setTimeout(() => {
      const snapshot: DraftRecoverySnapshot = {
        savedAt: Date.now(),
        detailId,
        creatingNew,
        title: draftTitle,
        category: draftCategory,
        content: isLargeNote ? (focusedSegment ? draftContent.slice(focusedSegment.start, focusedSegment.end) : '') : draftContent,
        segmentOrdinal: isLargeNote ? segmentOrdinal : undefined,
      }
      localStorage.setItem(DRAFT_RECOVERY_STORAGE_KEY, JSON.stringify(snapshot))
    }, DRAFT_RECOVERY_INTERVAL_MS)
    return () => window.clearTimeout(handle)
  }, [
    creatingNew,
    detailId,
    detailNote,
    isLargeNote,
    loadedSegments,
    segmentOrdinal,
    largeNoteBaseline,
    draftTitle,
    draftCategory,
    draftContent,
    readOnlyBootstrap,
  ])

  function discardRecoverySnapshot() {
    localStorage.removeItem(DRAFT_RECOVERY_STORAGE_KEY)
    setRecoverySnapshot(null)
  }

  function restoreRecoverySnapshot() {
    if (!recoverySnapshot) return
    const snapshot = recoverySnapshot
    discardRecoverySnapshot()
    if (snapshot.creatingNew || snapshot.detailId === null) {
      setCreatingNew(true)
      setDetailId(null)
      setDetailNote(null)
      setDraftTitle(snapshot.title)
      setDraftCategory(snapshot.category)
      setDraftContent(snapshot.content)
      return
    }
    // 中断前编辑的是已有笔记，不能当新笔记打开（保存会另建重复笔记）。先走正常路径重新加载（含大文件判
    // 断），完成后由下面的 effect 覆盖恢复的标题/正文。
    setPendingDraftOverlay(snapshot)
    handleOpenExisting(snapshot.detailId)
  }

  useEffect(() => {
    if (!pendingDraftOverlay) return
    if (detailId === null) {
      // 目标笔记没能加载成功（note_get / 分段会话失败时上面的 effect 会把 detailId 重置为 null），恢复已
      // 无可覆盖的目标。
      setPendingDraftOverlay(null)
      return
    }
    if (detailId !== pendingDraftOverlay.detailId) return
    const loaded = isLargeNote ? !readOnlyBootstrap && loadedSegments.length > 0 : !detailLoading && detailNote !== null
    if (!loaded) return
    // 崩溃快照记的是当时聚焦段的正文：只在重开后仍落在同一段、且尚未懒加载拼接第二段（
    // loadedSegments.length === 1）时才应用；否则覆盖 draftContent 会弄乱不相关段，宁可放弃恢复。
    if (isLargeNote && (pendingDraftOverlay.segmentOrdinal !== segmentOrdinal || loadedSegments.length !== 1)) {
      setPendingDraftOverlay(null)
      return
    }
    setDraftTitle(pendingDraftOverlay.title)
    setDraftCategory(pendingDraftOverlay.category)
    setDraftContent(pendingDraftOverlay.content)
    if (isLargeNote) {
      // 恢复的正文长度可能与原段不同：把唯一一段的 end 同步为实际长度，维持 loadedSegments 的 start/end准
      // 确描述范围这条不变量；dirty 显式置 true（快照本就是崩溃前未保存的内容），不依赖
      // handleEditorUpdate 的 touchesRange 判定。
      setLoadedSegments((prev) =>
        prev.map((seg) => (seg.ordinal === segmentOrdinal ? { ...seg, end: pendingDraftOverlay.content.length, dirty: true } : seg)),
      )
    }
    setPendingDraftOverlay(null)
  }, [pendingDraftOverlay, detailId, isLargeNote, readOnlyBootstrap, loadedSegments, segmentOrdinal, detailLoading, detailNote])

  useEffect(() => {
    if (!pendingQuickCapture) return
    handleOpenNew()
    onQuickCaptureHandled?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the handler intentionally resets the note draft exactly like the visible New Note button
  }, [pendingQuickCapture])

  useEffect(() => {
    const query = search.trim()
    if (!query || viewMode !== 'active') {
      setSearchResultIds(null)
      return
    }
    let cancelled = false
    const timer = window.setTimeout(() => {
      vaultApi.call('note_search', { query }).then((res) => {
        if (cancelled) return
        if (!res.ok) {
          toast.error(t('searchFailedToast'), { description: translateError(res.error, res.error_params) })
          return
        }
        setSearchResultIds(new Set(res.notes.map((note) => note.id)))
      })
    }, 200)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [search, viewMode, t])

  // 普通笔记和隐藏笔记的分类是两个独立池（隐藏笔记单独一套预设）：分别统计在用的分类，隐藏池只看
  // is_hidden，普通池只看非隐藏。
  const categoriesInUseNormal = useMemo(
    () => Array.from(new Set(notes.filter((n) => !n.is_hidden).map((n) => n.category).filter((c) => c !== ''))),
    [notes],
  )
  const categoriesInUseHidden = useMemo(
    () => Array.from(new Set(notes.filter((n) => n.is_hidden).map((n) => n.category).filter((c) => c !== ''))),
    [notes],
  )
  const hasUncategorized = useMemo(
    () => notes.some((n) => noteInScope(n) && n.category === ''),
    [notes, noteInScope],
  )

  // 每个分类的笔记数和最近更新时间，供「按笔记数」「按最近使用」自动排序。计数含子分类：点父节点会筛
  // 出整棵子树（categoryMatchesFilter），数字须与之一致。
  const categoryStats = useMemo(() => {
    const stats = new Map<string, CategoryStat>()
    const bump = (path: string, updatedAt: number) => {
      const cur = stats.get(path)
      if (cur) {
        cur.count += 1
        if (updatedAt > cur.updatedAt) cur.updatedAt = updatedAt
      } else {
        stats.set(path, { count: 1, updatedAt })
      }
    }
    for (const note of notes) {
      if (!noteInScope(note)) continue
      if (!note.category) continue
      const at = Date.parse(note.updated_at) || 0
      // 逐级往上累加，"工作/项目A/需求" 同时计进 工作、工作/项目A、工作/项目A/需求
      const parts = note.category.split('/').filter((p) => p.length > 0)
      let path = ''
      for (const part of parts) {
        path = path ? `${path}/${part}` : part
        bump(path, at)
      }
    }
    return stats
  }, [notes, noteInScope])

  const categoryComparator = useMemo(
    () => makeCategoryComparator(categoryPrefs, categoryStats),
    [categoryPrefs, categoryStats],
  )

  // 每个分类池 = 预设 + 手动创建 + 已在用的分类，去重合并。预设和手动创建只是快速选项，分类本身仍是自
  // 由文本。
  const categoryOptionsNormal = useMemo(() => {
    const presets = [
      t('categoryPresetWork'),
      t('categoryPresetLife'),
      t('categoryPresetStudy'),
      t('categoryPresetAccount'),
      t('categoryPresetOther'),
      t('categoryPresetFeatureRequest'),
      t('categoryPresetResume'),
      t('categoryPresetExtracurricular'),
      t('categoryPresetSelfDesign'),
      t('categoryPresetInternet'),
      t('categoryPresetNode'),
      t('categoryPresetUniversity'),
      t('categoryPresetRadio'),
    ]
    const all = Array.from(
      new Set([...presets, ...normalCategories.map((c) => c.name), ...categoriesInUseNormal]),
    )
    // 过预设显示偏好：用户删掉的不再出现、手动排序的按其顺序。直接 .sort() 会让硬编码预设每次渲染都长回
    // 来（"删不掉"）。
    return applyCategoryPrefs(all, categoryPrefs, categoryStats)
  }, [categoriesInUseNormal, normalCategories, t, categoryPrefs, categoryStats])

  const categoryOptionsHidden = useMemo(() => {
    const presets = [
      t('categoryPresetHiddenAccount'),
      t('categoryPresetHiddenId'),
      t('categoryPresetHiddenFinance'),
      t('categoryPresetHiddenPrivate'),
      t('categoryPresetHiddenOther'),
    ]
    const all = Array.from(
      new Set([...presets, ...hiddenCategories.map((c) => c.name), ...categoriesInUseHidden]),
    )
    return applyCategoryPrefs(all, categoryPrefs, categoryStats)
  }, [categoriesInUseHidden, hiddenCategories, t, categoryPrefs, categoryStats])

  // 当前范围能筛的分类/标签。'all' 取两池并集，否则隐藏笔记的分类筛不到；并集不构成泄露，进入 'all'本
  // 身已过一次解锁验证。
  const scopedCategoryOptions = useMemo(() => {
    if (noteScope === 'hidden') return categoryOptionsHidden
    if (noteScope === 'active') return categoryOptionsNormal
    return Array.from(new Set([...categoryOptionsNormal, ...categoryOptionsHidden]))
  }, [noteScope, categoryOptionsNormal, categoryOptionsHidden])

  const scopedTags = useMemo(() => {
    if (noteScope === 'hidden') return hiddenTags
    if (noteScope === 'active') return normalTags
    const seen = new Set<number>()
    return [...normalTags, ...hiddenTags].filter((tag) => (seen.has(tag.id) ? false : (seen.add(tag.id), true)))
  }, [noteScope, normalTags, hiddenTags])

  // 分类图标按本层节点自己的名字（segment，不含上级路径）查表，覆盖内置预设和几个明确要的分类；查不到
  // 的落到通用 Folder 图标。key 用当前语言的翻译结果，随语言切换自动更新，无需维护多语言对照表。
  const categoryIconByName = useMemo(() => {
    const map = new Map<string, typeof Folder>()
    map.set(t('categoryPresetWork'), Briefcase)
    map.set(t('categoryPresetLife'), Home)
    map.set(t('categoryPresetStudy'), GraduationCap)
    map.set(t('categoryPresetAccount'), IdCard)
    map.set(t('categoryPresetOther'), MoreHorizontal)
    map.set(t('categoryPresetFeatureRequest'), Wrench)
    map.set(t('categoryPresetResume'), Contact2)
    map.set(t('categoryPresetExtracurricular'), Volleyball)
    map.set(t('categoryPresetSelfDesign'), Palette)
    map.set(t('categoryPresetInternet'), Globe)
    map.set(t('categoryPresetNode').split('/').pop() ?? 'Node', Hexagon)
    map.set(t('categoryPresetUniversity').split('/').pop() ?? 'University', Landmark)
    map.set(t('categoryPresetRadio'), Radio)
    map.set(t('categoryPresetHiddenAccount'), IdCard)
    map.set(t('categoryPresetHiddenId'), Contact2)
    map.set(t('categoryPresetHiddenFinance'), Wallet)
    map.set(t('categoryPresetHiddenPrivate'), Lock)
    map.set(t('categoryPresetHiddenOther'), MoreHorizontal)
    return map
  }, [t])

  // 用户改过的图标优先于内置查表；都没有才落到通用的 Folder。
  const categoryIconFor = useCallback(
    (segment: string) => {
      const chosen = categoryPrefs.icons[segment]
      if (chosen && CATEGORY_ICON_COMPONENTS[chosen]) return CATEGORY_ICON_COMPONENTS[chosen]
      return categoryIconByName.get(segment) ?? Folder
    },
    [categoryIconByName, categoryPrefs.icons],
  )

  /** 分类在界面上显示成什么名字。用户改过就用他改的。 */
  const categoryLabelFor = useCallback(
    (segment: string) => categoryDisplayLabel(segment, categoryPrefs),
    [categoryPrefs],
  )

  const categoryTree = useMemo(
    () => buildCategoryTree(scopedCategoryOptions, categoryComparator),
    [scopedCategoryOptions, categoryComparator],
  )

  const filtered = useMemo(() => {
    const matched = filterNotes(viewMode === 'trash' ? trash : notes, {
      scope: noteScope,
      viewMode,
      query: search.trim().toLowerCase(),
      searchResultIds,
      categoryFilter,
      tagFilter,
      pinnedOnly,
    })
    // 排序只在显示这一层做：notes 本身保持 sortNotes 的规范顺序，乐观更新那一堆
    // setNotes(sortNotes(...)) 不用跟着改。回收站按删除先后看更有用，不参与。
    return viewMode === 'trash' || noteSortMode === DEFAULT_NOTE_SORT_MODE ? matched : sortNotesBy(matched, noteSortMode)
  }, [notes, trash, viewMode, search, searchResultIds, categoryFilter, tagFilter, pinnedOnly, noteScope, noteSortMode])

  // 过滤/切换视图之后，选中集合里可能残留已经不在当前列表里的 id - 每次
  // 渲染前收紧一遍（跟 PasswordScreen/ClipboardScreen 同一套做法）。
  const filteredIds = useMemo(() => new Set(filtered.map((n) => n.id)), [filtered])
  const visibleSelectedIds = useMemo(
    () => [...selectedIds].filter((id) => filteredIds.has(id)),
    [selectedIds, filteredIds],
  )
  const allFilteredSelected = filtered.length > 0 && visibleSelectedIds.length === filtered.length

  /*
   * 右栏默认落在第一条笔记上（同密码页、剪贴板页），否则右栏是一大块空地，只有一句「点击上方一条笔记
   * 查看」。`creatingNew` 期间不抢：右栏是新建草稿，切走会丢掉正在写的内容。
   */
  useEffect(() => {
    if (loading || creatingNew) return
    if (detailId !== null && filteredIds.has(detailId)) return
    setDetailId(filtered.length > 0 ? filtered[0].id : null)
  }, [loading, creatingNew, detailId, filteredIds, filtered])

  function toggleSelected(id: number, checked: boolean) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  }

  function toggleSelectAll(checked: boolean) {
    setSelectedIds(checked ? new Set(filtered.map((n) => n.id)) : new Set())
  }

  // Ctrl+A 全选只在"笔记"视图生效；输入框/编辑器里必须保持原生"选中框内文字"，不能拦掉（同
  // ClipboardScreen/PasswordScreen 的 isEditableTarget 判断）。
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null
      const isEditableTarget =
        target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || !!target?.isContentEditable
      if (!(e.ctrlKey || e.metaKey)) return
      const key = e.key.toLowerCase()
      if (key === 'a' && viewMode === 'active' && !isEditableTarget) {
        e.preventDefault()
        setSelectedIds(new Set(filtered.map((n) => n.id)))
      } else if (key === 'f' && !isEditableTarget) {
        e.preventDefault()
        document.getElementById('note-search')?.focus()
      } else if (key === 'n' && !isEditableTarget) {
        e.preventDefault()
        handleOpenNew()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- handleOpenNew is stable in intent (resets draft state), redefining the effect on every render would be wasteful
  }, [viewMode, filtered])

  // 正文查找/替换快捷键：只有焦点在 CodeMirror 编辑器内时 Ctrl+F/H 才抢下来开查找面板；焦点在别处时上
  // 面那个效果的"聚焦列表搜索框"已覆盖，不冲突（编辑器是 contentEditable，被 isEditableTarget 排除
  // ）。F3/Shift+F3 跳匹配、Esc 关面板，面板打开后全局生效，不要求焦点在编辑器。
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const inEditor = !!editorViewRef.current?.hasFocus
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && inEditor) {
        e.preventDefault()
        openFindPanel(false)
        return
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'h' && inEditor) {
        e.preventDefault()
        openFindPanel(true)
        return
      }
      if (!findPanelOpen) return
      if (e.key === 'F3') {
        e.preventDefault()
        if (e.shiftKey) goToPrevMatch()
        else goToNextMatch()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        closeFindPanel()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- openFindPanel/goToNextMatch/goToPrevMatch/closeFindPanel are plain functions redefined every render, captured fresh whenever this effect re-attaches on the listed state changes
  }, [findPanelOpen, findMatches, findMatchIndex, readOnlyBootstrap])

  useEffect(() => {
    setIsLargeNote(false)
    setLargeNoteBaseline(null)
    setSegmentCount(0)
    setSegmentOrdinal(0)
    segmentOrdinalRef.current = 0
    setLoadedSegments([])
    segmentFetchDirectionRef.current = null
    setSegmentNavigating(false)
    setLastSavedAt(null)
    setReadOnlyBootstrap(false)
    // 切换到另一条笔记（或关闭详情页）时查找面板的状态没有意义了——上一条
    // 笔记里的匹配位置对新笔记的正文毫无关系，直接清空而不是带着旧结果。
    setFindPanelOpen(false)
    setFindShowReplace(false)
    setFindMatches([])
    setFindMatchIndex(-1)

    // 位置记忆：切笔记前先立即写入上一份位置。schedulePositionSave 有 500ms 防抖，快速切笔记时会被下面
    // 的 flush 清掉而永不写入 localStorage，所以在 currentNoteIdRef 改成新 ID 之前，同步提取光标和滚动
    // 位置写入。
    if (positionSaveTimerRef.current) {
      const flushNoteId = currentNoteIdRef.current
      const flushView = editorViewRef.current
      if (flushNoteId !== null && flushView) {
        const head = flushView.state.selection.main.head
        const segments = loadedSegmentsRef.current
        const cursorOrdinal = segmentOrdinalAtPos(head, segments) ?? segmentOrdinalRef.current
        const cursorSegment = segments.find((seg) => seg.ordinal === cursorOrdinal)
        const cursor = cursorSegment ? head - cursorSegment.start : head
        const el = flushView.scrollDOM
        const max = el.scrollHeight - el.clientHeight
        const scrollRatio = max > 0 ? el.scrollTop / max : 0
        savePosition(flushNoteId, { cursor, scrollRatio, savedAt: Date.now(), segmentOrdinal: cursorOrdinal })
      }
      clearTimeout(positionSaveTimerRef.current)
      positionSaveTimerRef.current = null
    }
    if (positionMarkerTimerRef.current) {
      clearTimeout(positionMarkerTimerRef.current)
      positionMarkerTimerRef.current = null
    }
    // 切换到新笔记
    currentNoteIdRef.current = detailId
    setShowBackToPosition(false)
    // 切笔记时正在跑的自动滚动没有意义了——目标是"这一篇"的滚动条，换了
    // 笔记之后继续滚只会滚到新笔记不相关的位置。
    stopAutoScroll()

    if (detailId === null) {
      setDetailNote(null)
      return
    }
    // 是否大文件直接从内存里的列表项（notes/trash）判断，不额外一次 RPC；真正慢的分片读取只在确认大文件
    // 后才发生。
    const listItem = notes.find((n) => n.id === detailId) ?? trash.find((n) => n.id === detailId)
    const large = (listItem?.content_length ?? 0) > LARGE_NOTE_THRESHOLD_BYTES
    let cancelled = false

    if (large && listItem) {
      setIsLargeNote(true)
      // docx/pdf 导出对分段大笔记不可用（见导出格式选择器旁的说明），
      // 提前把选择重置成 txt，避免带着上一条普通笔记选的 docx/pdf 进来。
      setExportFormat('txt')
      setLargeNoteBaseline({ title: listItem.title, category: listItem.category })
      // content 只是占位：大文件模式下正文走 draftContent（一次一段），没人读 detailNote.content；设为非
      // 空 detailNote 只是为了让置顶/隐藏/删除按钮（判断条件是 `detailNote` 非空）在大笔记详情页正常显
      // 示。
      setDetailNote({ ...listItem, content: '' })
      setDetailLoading(false)
      setDraftTitle(listItem.title)
      setDraftCategory(listItem.category)
      setDraftContent('')
      setSegmentCount(0)
      setSegmentOrdinal(0)
      setLoadedSegments([])
      setReadOnlyBootstrap(true)
      ;(async (): Promise<void> => {
        const openRes = await vaultApi.call('note_content_session_open', { id: detailId })
        if (cancelled) return
        if (!openRes.ok) {
          toast.error(t('loadNoteFailedToast'), { description: translateError(openRes.error, openRes.error_params) })
          setDetailId(null)
          return
        }
        segmentSessionIdRef.current = openRes.session_id
        setSegmentCount(openRes.segment_count)
        // 位置记忆：上次记住在哪一段就直接打开那一段，而非总从第一段开始（光标/滚动比例恢复仍由
        // restorePositionForNote 负责）。
        const savedPosition = getPosition(detailId)
        const initialOrdinal = Math.min(Math.max(savedPosition?.segmentOrdinal ?? 0, 0), Math.max(openRes.segment_count - 1, 0))
        const segRes = await vaultApi.call('note_content_segment_get', {
          session_id: openRes.session_id,
          ordinal: initialOrdinal,
        })
        if (cancelled) return
        if (!segRes.ok) {
          toast.error(t('loadNoteFailedToast'), { description: translateError(segRes.error, segRes.error_params) })
          setDetailId(null)
          return
        }
        segmentOrdinalRef.current = initialOrdinal
        setSegmentOrdinal(initialOrdinal)
        setLoadedSegments([
          {
            ordinal: initialOrdinal,
            id: segRes.segment.id,
            revision: segRes.segment.revision,
            start: 0,
            end: segRes.segment.content.length,
            baseline: segRes.segment.content,
            dirty: false,
          },
        ])
        setDraftContent(segRes.segment.content)
        // 直接派发 > 回退到受控组件轮询——分段笔记在这一步恢复位置时
        // 不传 expectedContent，因为后续内容还可能继续增长（懒加载拼接）。
        if (!loadContentDirect(detailId, segRes.segment.content, setDraftContent)) {
          setDraftContent(segRes.segment.content)
          restorePositionForNote(detailId, segRes.segment.content.length)
        }
        setReadOnlyBootstrap(false)
      })()
      return () => {
        cancelled = true
        const sessionId = segmentSessionIdRef.current
        if (sessionId) {
          segmentSessionIdRef.current = null
          vaultApi.call('note_content_session_close', { session_id: sessionId })
        }
      }
    }

    setDetailLoading(true)
    vaultApi.call('note_get', { id: detailId }).then((res) => {
      if (cancelled) return
      setDetailLoading(false)
      if (!res.ok) {
        toast.error(t('loadNoteFailedToast'), { description: translateError(res.error, res.error_params) })
        setDetailId(null)
        return
      }
      setDetailNote(res.note)
      setDraftTitle(res.note.title)
      setDraftCategory(res.note.category)
      // 直接派发 > 回退到受控组件轮询
      if (!loadContentDirect(detailId, res.note.content, setDraftContent)) {
        setDraftContent(res.note.content)
        restorePositionForNote(detailId, res.note.content.length, res.note.content)
      }
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- notes/trash are read for a one-off lookup at load time, not meant to re-trigger this effect on every list refresh
  }, [detailId, t, detailReloadKey])

  // 标题共同出现提示依赖 detailNote?.title（加载完成后落定的持久标题），而非 draftTitle（每次敲字都
  // 变），否则改标题时每个字都发一次后端查询。大笔记也有 detailNote（content 占位为空，title 真实），
  // 所以大小笔记走同一路径。
  useEffect(() => {
    if (detailId === null || creatingNew || !detailNote?.title.trim()) {
      setTitleMentions([])
      return
    }
    let cancelled = false
    vaultApi.call('note_find_title_mentions', { id: detailId, title: detailNote.title }).then((res) => {
      if (cancelled) return
      setTitleMentions(res.ok ? res.notes : [])
    })
    return () => {
      cancelled = true
    }
  }, [detailId, detailNote?.title, creatingNew])

  // ---- 大文件模式：连续滚动懒加载（见 LoadedSegment 类型定义处的说明）----

  // 每次渲染（含每次敲字）用的廉价版本：只看 dirty 标记，不做 O(段大小) 的 slice+比较；标记由
  // handleEditorUpdate 增量维护，精确比较留给真正保存时（见 LoadedSegment）。
  function isLargeNoteContentDirty(segments: LoadedSegment[]): boolean {
    return segments.some((seg) => seg.dirty)
  }

  function segmentOrdinalAtPos(pos: number, segments: LoadedSegment[]): number | null {
    for (const seg of segments) {
      if (pos >= seg.start && pos <= seg.end) return seg.ordinal
    }
    return null
  }

  // 光标移动或纯滚动都调用，决定"第 X / Y 段"的 X。用视口最顶端字符所在的段（而非光标所在段），仅滚动
  // 也会变。只读写 ref 和稳定的 setState，可安全从只挂一次的滚动监听调用；useCallback([]) 稳定引用是
  // 因为handleEditorUpdate 的依赖数组要用它（同 schedulePositionSave）。
  const updateFocusedSegmentOrdinal = useCallback(() => {
    const view = editorViewRef.current
    if (!view) return
    const segments = loadedSegmentsRef.current
    if (segments.length === 0) return
    const rect = view.scrollDOM.getBoundingClientRect()
    const pos = view.posAtCoords({ x: rect.left + 4, y: rect.top + 4 }) ?? view.state.selection.main.head
    const ordinal = segmentOrdinalAtPos(pos, segments)
    if (ordinal !== null && ordinal !== segmentOrdinalRef.current) {
      segmentOrdinalRef.current = ordinal
      setSegmentOrdinal(ordinal)
    }
  }, [])

  // 连续滚动的核心：滚到已加载内容边界附近时，往该方向再取一段，直接对 editorViewRef 派发插入事务（插
  // 到最前/最后），选区由 CodeMirror 自动映射。只读写 ref 和稳定的 setState，可从只挂一次的滚动监听调
  // 用；非大文件模式 loadedSegments 为空数组，下面直接短路返回。
  async function maybeLoadMoreSegments() {
    if (readOnlyBootstrapRef.current || segmentNavigatingRef.current) return
    if (segmentFetchDirectionRef.current !== null) return
    const view = editorViewRef.current
    const sessionId = segmentSessionIdRef.current
    if (!view || !sessionId) return
    const segments = loadedSegmentsRef.current
    if (segments.length === 0) return
    const el = view.scrollDOM
    const margin = Math.max(el.clientHeight * PREFETCH_MARGIN_VIEWPORTS, 200)
    const nearBottom = el.scrollHeight - (el.scrollTop + el.clientHeight) < margin
    const nearTop = el.scrollTop < margin
    const first = segments[0]
    const last = segments[segments.length - 1]

    let direction: 'next' | 'prev' | null = null
    if (nearBottom && last.ordinal < segmentCountRef.current - 1) direction = 'next'
    else if (nearTop && first.ordinal > 0) direction = 'prev'
    if (!direction) return

    segmentFetchDirectionRef.current = direction
    try {
      const targetOrdinal = direction === 'next' ? last.ordinal + 1 : first.ordinal - 1
      const res = await vaultApi.call('note_content_segment_get', { session_id: sessionId, ordinal: targetOrdinal })
      // 取段期间可能已切笔记/关会话（session id 变了），或做了"上一段/下一段"快进跳转（窗口已丢弃重建，取
      // 回的段不再相邻）。用"窗口首/尾是否仍与发起请求时一样"判断能否拼接，比只看 session id 更准，也覆盖
      // 另一方向懒加载先完成的情况；readOnlyBootstrap/segmentNavigating 在窗口实际改变前就已置上，能更早
      // 拦下。任一情况都放弃结果，需要时下次滚动/effect 会重取。
      if (segmentSessionIdRef.current !== sessionId || readOnlyBootstrapRef.current || segmentNavigatingRef.current) return
      const stillCurrent = loadedSegmentsRef.current
      const windowUnchanged =
        direction === 'next'
          ? stillCurrent.length > 0 && stillCurrent[stillCurrent.length - 1].ordinal === last.ordinal
          : stillCurrent.length > 0 && stillCurrent[0].ordinal === first.ordinal
      if (!windowUnchanged) return
      if (!res.ok) return // 静默失败——留给下一次滚动/effect 触发时重试，不用 toast 打断阅读
      const currentView = editorViewRef.current
      if (!currentView) return
      const content = res.segment.content
      const oldSegments = loadedSegmentsRef.current
      // 达上限时从远端淘汰无脏改动的段，用单次 dispatch 完成"淘汰+追加"：读全文、JS 拼好新内容，一次
      // `{from:0, to:oldLen, insert:newContent}` 替换整个文档。handleEditorUpdate 的 mapPos 也会重映射
      // loadedSegments，但随后立即 setLoadedSegments 覆盖最终坐标，React 18 自动批处理保证后调用者胜出。
      const doEviction = oldSegments.length >= MAX_LOADED_SEGMENTS
      if (doEviction) {
        const curText = currentView.state.doc.toString()
        if (direction === 'next') {
          // 淘汰头部：从 oldSegments[0] 开始，跳过 dirty 的段
          let dropCount = 0
          for (const seg of oldSegments) { if (!seg.dirty) dropCount++; else break }
          if (dropCount === 0) { segmentFetchDirectionRef.current = null; return }
          const dropLen = oldSegments.slice(0, dropCount).reduce((s, seg) => s + (seg.end - seg.start), 0)
          const keptText = curText.slice(dropLen)
          currentView.dispatch({ changes: { from: 0, to: curText.length, insert: keptText + content }, userEvent: 'segment.append' })
          const keptSegments = oldSegments.slice(dropCount).map((seg) => ({ ...seg, start: seg.start - dropLen, end: seg.end - dropLen }))
          const newStart = keptSegments.length > 0 ? keptSegments[keptSegments.length - 1].end : 0
          setLoadedSegments([...keptSegments, { ordinal: targetOrdinal, id: res.segment.id, revision: res.segment.revision, start: newStart, end: newStart + content.length, baseline: content, dirty: false }])
        } else {
          // 淘汰尾部
          let dropCount = 0
          for (let i = oldSegments.length - 1; i >= 0; i--) { if (!oldSegments[i].dirty) dropCount++; else break }
          if (dropCount === 0) { segmentFetchDirectionRef.current = null; return }
          const keptSegments = oldSegments.slice(0, oldSegments.length - dropCount)
          const keptEnd = keptSegments.length > 0 ? keptSegments[keptSegments.length - 1].end : 0
          const keptText = curText.slice(0, keptEnd)
          const scrollHeightBefore = el.scrollHeight
          currentView.dispatch({ changes: { from: 0, to: curText.length, insert: content + keptText }, userEvent: 'segment.prepend' })
          el.scrollTop += el.scrollHeight - scrollHeightBefore
          const newSegments: LoadedSegment[] = [{ ordinal: targetOrdinal, id: res.segment.id, revision: res.segment.revision, start: 0, end: content.length, baseline: content, dirty: false }]
          let offset = content.length
          for (const seg of keptSegments) { const len = seg.end - seg.start; newSegments.push({ ...seg, start: offset, end: offset + len }); offset += len }
          setLoadedSegments(newSegments)
        }
      } else {
        if (direction === 'next') {
          const insertAt = currentView.state.doc.length
          currentView.dispatch({ changes: { from: insertAt, to: insertAt, insert: content }, userEvent: 'segment.append' })
          setLoadedSegments((prev) => [...prev, { ordinal: targetOrdinal, id: res.segment.id, revision: res.segment.revision, start: insertAt, end: insertAt + content.length, baseline: content, dirty: false }])
        } else {
          // 往前插入会把屏幕上的内容整体推下去；记下插入前后 scrollHeight 之差，补回等量 scrollTop，让视觉原
          // 地不动（同聊天软件向上加载历史）。
          const scrollHeightBefore = el.scrollHeight
          currentView.dispatch({ changes: { from: 0, to: 0, insert: content }, userEvent: 'segment.prepend' })
          el.scrollTop += el.scrollHeight - scrollHeightBefore
          setLoadedSegments((prev) => [
            { ordinal: targetOrdinal, id: res.segment.id, revision: res.segment.revision, start: 0, end: content.length, baseline: content, dirty: false },
            ...prev.map((seg) => (seg.ordinal === first.ordinal ? { ...seg, start: content.length } : seg)),
          ])
        }
      }
    } finally {
      segmentFetchDirectionRef.current = null
    }
  }

  // loadedSegments/segmentCount 变化后（含首段种下、每次拼接完）重新检查是否还要继续加载，覆盖"首段比
  // 几屏还短"和"快速连续滚动一次不够"，无需手写递归；用户滚动触发的加载走滚动监听里直接调用的
  // maybeLoadMoreSegments。
  useEffect(() => {
    if (!isLargeNote) return
    void maybeLoadMoreSegments()
  }, [isLargeNote, loadedSegments, segmentCount, readOnlyBootstrap, segmentNavigating])

  useEffect(() => {
    if (creatingNew || detailId === null) {
      setNoteImages([])
      return
    }
    let cancelled = false
    setImagesLoading(true)
    vaultApi.call('note_image_list', { note_id: detailId }).then((res) => {
      if (cancelled) return
      setImagesLoading(false)
      if (res.ok) setNoteImages(res.images)
    })
    return () => {
      cancelled = true
    }
  }, [detailId, creatingNew])

  useEffect(() => {
    if (detailId === null || creatingNew) {
      setDetailTagIds([])
      return
    }
    let cancelled = false
    vaultApi.call('note_tags_get', { id: detailId }).then((res) => {
      if (!cancelled && res.ok) setDetailTagIds(res.tags.map((tag) => tag.id))
    })
    return () => {
      cancelled = true
    }
  }, [detailId, creatingNew])

  // "只看隐藏"开关是进入隐藏笔记的唯一入口（filtered 平时无条件排除 is_hidden），所以只在此拦一次，不
  // 必逐行/每次开详情都验证。这是硬编码要求（同 AppShell 的"设置"页），不经设置页那个可关的"进入笔记
  // 模块即验证"开关——后者关掉不代表查看隐藏笔记免验证。退出隐藏视图不需再验证。
  async function changeNoteScope(next: NoteScope) {
    // 已经在这个范围里就什么都不做：既不重复弹验证，也不把用户当前的分类
    // 筛选重置掉。（统计块会重复点到同一块，这条是必要的。）
    if (next === noteScope) return
    // 判据是"切过去后隐藏内容会不会出现在屏幕上"，不是目标范围的名字：'all' 也会列出隐藏笔记，所以和
    // 'hidden' 一样要验证（剪贴板导出曾栽在只拦名字带 hidden 的那个）。hidden 与 all 互切不必再验，隐藏
    // 内容此刻本就可见。
    const willRevealHidden = next === 'hidden' || next === 'all'
    const alreadyRevealed = noteScope === 'hidden' || noteScope === 'all'
    if (willRevealHidden && !alreadyRevealed && !(await ensureFreshlyUnlocked())) return
    setNoteScope(next)
    // 普通/隐藏笔记分类是两个独立池，切换视图时重置分类筛选为"全部"，避免带着另一池里（可能同名）的分类
    // 进来导致选中状态对不上。
    setCategoryFilter('all')
    setTagFilter('all')
  }

  // "管理分类"入口本身不需要验证（普通分类不敏感），但弹窗里的"隐藏笔记分类"
  // 一栏在没验证过之前只显示锁定提示，见 hiddenCategoriesRevealed 的注释。
  function handleOpenCategoryManager() {
    if (hiddenOnly) setHiddenCategoriesRevealed(true)
    setCategoryManagerOpen(true)
  }

  function handleCategoryManagerOpenChange(open: boolean) {
    setCategoryManagerOpen(open)
    if (!open) setHiddenCategoriesRevealed(false)
  }

  async function handleRevealHiddenCategories() {
    if (!(await ensureFreshlyUnlocked())) return
    setHiddenCategoriesRevealed(true)
  }

  function handleOpenNew() {
    setCreatingNew(true)
    setDetailId(null)
    setDetailNote(null)
    setDraftTitle('')
    setDraftCategory(categoryFilter !== 'all' && categoryFilter !== 'uncategorized' ? categoryFilter : '')
    setDraftContent('')
  }

  function handleOpenExisting(id: number) {
    setCreatingNew(false)
    setDetailId(id)
  }

  function handleCloseDetail() {
    setCreatingNew(false)
    setDetailId(null)
    setFullscreen(false)
  }

  async function handleDropFiles(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    const paths = Array.from(event.dataTransfer.files)
      .map((file) => electronApi.getPathForFile(file))
      .filter((path) => /\.(txt|md|markdown)$/i.test(path))
    if (paths.length === 0) {
      toast.error(t('dropUnsupportedToast'))
      return
    }
    setImporting(true)
    try {
      const res = await vaultApi.call('note_import_files', { paths, encrypt: await resolveDefaultEncrypt() })
      if (!res.ok) {
        toast.error(t('importFailedToast'), { description: translateError(res.error, res.error_params) })
        return
      }
      if (res.imported.length > 0) {
        setNotes((prev) => sortNotes([...res.imported.map(toMetaItem), ...prev]))
        handleOpenExisting(res.imported[0].id)
      }
      if (res.failed.length > 0) toast.error(t('importPartialToast', { success: res.imported.length, failed: res.failed.length }))
      else toast.success(t('importSuccessToast', { count: res.imported.length }))
    } finally {
      setImporting(false)
    }
  }

  // 批量导入多个 txt：只复制进加密笔记库，不删磁盘原文件。单个文件读取/解码失败不影响其余，失败文件名
  // 汇总在一条 toast 里（同 FilesPane）。
  async function handleImportFiles() {
    const { path: defaultPath, stale } = await resolveDefaultPath('import')
    if (stale) toast.info(t('pathStaleToast'))
    const paths = await electronApi.openFiles({
      title: t('importDialogTitle'),
      properties: ['openFile', 'multiSelections'],
      defaultPath: defaultPath ?? undefined,
      filters: [
        { name: 'Text / Markdown', extensions: ['txt', 'md', 'markdown'] },
        { name: t('allFilesFilter'), extensions: ['*'] },
      ],
    })
    if (!paths || paths.length === 0) return
    recordUsedPath('import', dirnameOf(paths[0]))
    setImporting(true)
    try {
      const res = await vaultApi.call('note_import_files', { paths, encrypt: await resolveDefaultEncrypt() })
      if (!res.ok) {
        toast.error(t('importFailedToast'), { description: translateError(res.error, res.error_params) })
        return
      }
      if (res.imported.length > 0) {
        setNotes((prev) => sortNotes([...res.imported.map(toMetaItem), ...prev]))
      }
      if (res.failed.length === 0) {
        toast.success(t('importSuccessToast', { count: res.imported.length }))
      } else {
        toast.error(t('importPartialToast', { success: res.imported.length, failed: res.failed.length }), {
          description: res.failed
            .map((f) => `${f.path.split(/[\\/]/).pop()}：${translateError(f.error, f.error_params)}`)
            .join('\n'),
        })
      }
    } finally {
      setImporting(false)
    }
  }

  // 用 txt 的"打开方式"选中本应用的文件：与 handleImportFiles 同一个 note_import_files RPC，路径由外
  // 部传入（见 AppShell/App.tsx 的 pendingImportPath）。成功后直接打开新笔记详情；无论成败都要调
  // onPendingImportHandled，否则面板重新挂载会再导入一遍。
  useEffect(() => {
    if (!pendingImportPath) return
    let cancelled = false
    ;(async () => {
      const res = await vaultApi.call('note_import_files', {
        paths: [pendingImportPath],
        encrypt: await resolveDefaultEncrypt(),
      })
      if (cancelled) return
      onPendingImportHandled?.()
      if (!res.ok) {
        toast.error(t('importFailedToast'), { description: translateError(res.error, res.error_params) })
        return
      }
      if (res.imported.length > 0) {
        setNotes((prev) => sortNotes([...res.imported.map(toMetaItem), ...prev]))
        toast.success(t('importSuccessToast', { count: res.imported.length }))
        handleOpenExisting(res.imported[0].id)
      }
      if (res.failed.length > 0) {
        toast.error(t('importFailedToast'), {
          description: res.failed.map((f) => translateError(f.error, f.error_params)).join('\n'),
        })
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-run when a new pending path arrives
  }, [pendingImportPath])

  // 选根文件夹，递归扫描所有 txt 并打开批量导入弹窗。只读文件系统；扫描失败（目录不存在/无权限）直接
  // 提示并关掉弹窗，不留空白死弹窗。overrideDir 有值（从 PathQuickPick 历史/收藏点选）时跳过系统对话
  // 框。
  async function handleOpenFolderImport(overrideDir?: string) {
    let dir = overrideDir
    if (!dir) {
      const { path: defaultPath, stale } = await resolveDefaultPath('import')
      if (stale) toast.info(t('pathStaleToast'))
      dir = (await electronApi.openDirectory({ title: t('folderImportDialogTitle'), defaultPath: defaultPath ?? undefined })) ?? undefined
    }
    if (!dir) return
    recordUsedPath('import', dir)
    setScanRootDir(dir)
    setScanSearch('')
    setScanEncryptOverrides(new Map())
    setScanFiles([])
    setScanSelectedPaths(new Set())
    // 每次打开都回到"导进普通区"：把上一次的隐藏选择留下来，用户下一次导入
    // 一批不相干的文件时会在毫无提示的情况下被整批藏起来。
    setScanImportHidden(false)
    setScanImportCategory('')
    setFolderImportOpen(true)
    setScanning(true)
    try {
      const res = await vaultApi.call('note_scan_txt_dir', { dir })
      if (!res.ok) {
        toast.error(t('folderScanFailedToast'), { description: translateError(res.error, res.error_params) })
        setFolderImportOpen(false)
        return
      }
      setScanFiles(res.files)
      setScanSelectedPaths(new Set(res.files.map((f) => f.path))) // 默认全选，用户可以取消勾选不想要的
    } finally {
      setScanning(false)
    }
  }

  // 扫描只发生一次（上面 handleOpenFolderImport 里那一次），这里纯粹是已经
  // 拿到手的数组在内存里过滤，不再触发新的 IPC/文件系统调用。
  const filteredScanFiles = useMemo(() => filterScanFiles(scanFiles, scanSearch), [scanFiles, scanSearch])

  const allScanFilteredSelected =
    filteredScanFiles.length > 0 && filteredScanFiles.every((f) => scanSelectedPaths.has(f.path))

  function toggleScanSelected(path: string, checked: boolean) {
    setScanSelectedPaths((prev) => {
      const next = new Set(prev)
      if (checked) next.add(path)
      else next.delete(path)
      return next
    })
  }

  function toggleScanSelectAll(checked: boolean) {
    setScanSelectedPaths(checked ? new Set(filteredScanFiles.map((f) => f.path)) : new Set())
  }

  function scanEffectiveEncrypt(path: string): boolean {
    return scanEncryptOverrides.has(path) ? scanEncryptOverrides.get(path)! : scanBatchEncrypt
  }

  function toggleScanRowEncrypt(path: string) {
    setScanEncryptOverrides((prev) => {
      const next = new Map(prev)
      next.set(path, !scanEffectiveEncrypt(path))
      return next
    })
  }

  // 确认导入：按每个文件最终的加密选择分两组，各调一次 note_import_files（RPC 只接受整批 encrypt，文
  // 件粒度由前端分组）。带 scanRootDir 作 base_dir：后端把文件相对根目录的子文件夹路径（如
  // "Internet/Node"）写成多级分类；仅"从文件夹批量导入"入口有，单选文件导入不传。
  async function handleConfirmFolderImport() {
    const selectedPaths = scanFiles.filter((f) => scanSelectedPaths.has(f.path)).map((f) => f.path)
    if (selectedPaths.length === 0) return
    const encryptGroup = selectedPaths.filter((p) => scanEffectiveEncrypt(p))
    const plainGroup = selectedPaths.filter((p) => !scanEffectiveEncrypt(p))

    setScanImporting(true)
    try {
      const imported: NoteListItem[] = []
      const failed: { path: string; error: string; error_params?: Record<string, string | number> }[] = []
      let rpcFailed = false
      for (const [paths, encrypt] of [
        [encryptGroup, true],
        [plainGroup, false],
      ] as const) {
        if (paths.length === 0) continue
        setScanImportProgress({ fileIndex: 1, totalFiles: paths.length, fileName: '', done: 0, total: 0 })
        const unsubscribe = vaultApi.onProgress((payload) => {
          if (payload.method !== 'note_import_files') return
          const p = payload as unknown as NoteImportProgress
          setScanImportProgress({ fileIndex: p.file_index + 1, totalFiles: p.total_files, fileName: p.file_name, done: p.done, total: p.total })
        })
        try {
          const res = await vaultApi.call('note_import_files', {
            paths,
            encrypt,
            base_dir: scanRootDir,
            hidden: scanImportHidden,
            target_category: scanImportCategory,
          })
          if (!res.ok) {
            toast.error(t('importFailedToast'), { description: translateError(res.error, res.error_params) })
            rpcFailed = true
            continue
          }
          imported.push(...res.imported)
          failed.push(...res.failed)
        } finally {
          unsubscribe()
        }
      }
      if (imported.length > 0) {
        setNotes((prev) => sortNotes([...imported.map(toMetaItem), ...prev]))
        // 导入会新建分类目录条目（子文件夹派生的及前缀中不存在的层级），不刷新则侧边栏看不到新分支，像没导
        // 进来。
        await reloadCategories()
      }
      if (!rpcFailed) {
        if (failed.length === 0) {
          toast.success(t('importSuccessToast', { count: imported.length }))
        } else {
          toast.error(t('importPartialToast', { success: imported.length, failed: failed.length }), {
            description: failed
              .map((f) => `${f.path.split(/[\\/]/).pop()}：${translateError(f.error, f.error_params)}`)
              .join('\n'),
          })
        }
      }
      setFolderImportOpen(false)
    } finally {
      setScanImporting(false)
      setScanImportProgress(null)
    }
  }

  // 把勾选的笔记各自导出成一个独立 txt 文件，只导出正文（不带分类/时间等
  // 元信息），文件名=标题，重名自动加序号——磁盘上已有的其他文件不受影响。
  async function handleExportSelected(overrideDir?: string) {
    const ids = visibleSelectedIds
    if (ids.length === 0) return
    let outDir = overrideDir
    if (!outDir) {
      const { path: defaultPath, stale } = await resolveDefaultPath('export')
      if (stale) toast.info(t('pathStaleToast'))
      outDir = (await electronApi.openDirectory({ title: t('exportDialogTitle'), defaultPath: defaultPath ?? undefined })) ?? undefined
    }
    if (!outDir) return
    recordUsedPath('export', outDir)
    setExporting(true)
    try {
      const res = await vaultApi.call('note_export_files', { ids, output_dir: outDir })
      if (!res.ok) {
        toast.error(t('exportFailedToast'), { description: translateError(res.error, res.error_params) })
        return
      }
      if (res.failed.length === 0) {
        toast.success(t('exportSuccessToast', { count: res.exported.length }), {
          action: { label: t('openFolderAction'), onClick: () => electronApi.showItemInFolder(outDir) },
        })
      } else {
        toast.error(t('exportPartialToast', { success: res.exported.length, failed: res.failed.length }), {
          description: res.failed.map((f) => translateError(f.error, f.error_params)).join('\n'),
        })
      }
    } finally {
      setExporting(false)
    }
  }

  // 详情页单条导出：txt 复用 note_export_files（同批量，选目标文件夹，后端整段流式导出，见
  // NotesService.export_note_text）；docx/pdf 选具体保存文件：docx 在渲染端用 docx 库生成转 base64 交
  // 主进程写盘，pdf 拼独立 HTML 交主进程 webContents.printToPDF()（见 electron/main.ts）。两者要把全
  // 文搬进渲染进程内存，分段大笔记不具备，所以 isLargeNote 只开放 txt（与 exportFormat 选择器一致）；
  // readOnlyBootstrap 期间也不许导出。
  async function handleExportDetail() {
    if (!detailNote || readOnlyBootstrap) return
    if (isLargeNote && exportFormat !== 'txt') return
    const title = draftTitle.trim() || t('untitledNoteLabel')
    const note: ExportableNote = { title, content: draftContent, format: currentFormat }

    if (exportFormat === 'txt') {
      const { path: rememberedDir, stale } = await resolveDefaultPath('export')
      if (stale) toast.info(t('pathStaleToast'))
      const outDir = await electronApi.openDirectory({ title: t('exportDialogTitle'), defaultPath: rememberedDir ?? undefined })
      if (!outDir) return
      recordUsedPath('export', outDir)
      setExportingDetail(true)
      try {
        const res = await vaultApi.call('note_export_files', { ids: [detailNote.id], output_dir: outDir })
        if (!res.ok) {
          toast.error(t('exportFailedToast'), { description: translateError(res.error, res.error_params) })
          return
        }
        if (res.failed.length === 0) {
          toast.success(t('exportSuccessToast', { count: res.exported.length }), {
            action: { label: t('openFolderAction'), onClick: () => electronApi.showItemInFolder(outDir) },
          })
        } else {
          toast.error(t('exportFailedToast'), { description: translateError(res.failed[0].error, res.failed[0].error_params) })
        }
      } finally {
        setExportingDetail(false)
      }
      return
    }

    const extension = exportFormat
    const sanitizedTitle = title.replace(/[\\/:*?"<>|]/g, '_')
    const { path: rememberedDir, stale } = await resolveDefaultPath('export')
    if (stale) toast.info(t('pathStaleToast'))
    const defaultFileName = `${sanitizedTitle}.${extension}`
    const savePath = await electronApi.saveFile({
      title: t('exportSaveFileDialogTitle'),
      defaultPath: rememberedDir ? joinPath(rememberedDir, defaultFileName) : defaultFileName,
      filters: [
        exportFormat === 'docx' ? { name: 'Word', extensions: ['docx'] } : { name: 'PDF', extensions: ['pdf'] },
      ],
    })
    if (!savePath) return
    recordUsedPath('export', dirnameOf(savePath))
    setExportingDetail(true)
    try {
      // 导出整套（docx 包 + markdown-it）按需加载，不进首屏分块；已在 await 链上，加载耗时被"选文件"步骤
      // 盖住。
      const { buildDocxBase64, buildPdfHtml } = await import('@/lib/notesExport')
      if (exportFormat === 'pdf') {
        const html = buildPdfHtml(note)
        const res = await electronApi.exportPdf(html, savePath)
        if (!res.ok) {
          toast.error(t('exportFailedToast'), { description: res.error })
          return
        }
      } else {
        const base64 = await buildDocxBase64(note)
        const res = await electronApi.writeBinaryFileBase64(savePath, base64)
        if (!res.ok) {
          toast.error(t('exportFailedToast'), { description: res.error })
          return
        }
      }
      toast.success(t('exportSuccessToast', { count: 1 }), {
        action: { label: t('openFolderAction'), onClick: () => electronApi.showItemInFolder(savePath) },
      })
    } finally {
      setExportingDetail(false)
    }
  }

  // 分类管理只操作 categories 目录表，不影响笔记已写好的 category 文本（见 NoteCategory 类型）。创建
  // 幂等，重名直接返回现有条目，前端不必先查重。
  async function handleCreateCategory(scope: NoteCategoryScope, name: string) {
    const trimmed = name.trim()
    if (!trimmed) return
    const res = await vaultApi.call('note_category_create', { name: trimmed, scope })
    if (!res.ok) {
      toast.error(t('categoryCreateFailedToast'), { description: translateError(res.error, res.error_params) })
      return
    }
    const setter = scope === 'normal' ? setNormalCategories : setHiddenCategories
    setter((prev) => (prev.some((c) => c.id === res.category.id) ? prev : [...prev, res.category].sort((a, b) => a.name.localeCompare(b.name))))
    if (scope === 'normal') setNewNormalCategoryName('')
    else setNewHiddenCategoryName('')
  }

  // 删分类分两步：先问后端影响（子分类数/笔记数），再让用户选 promote（子类提升到父级）还是 cascade（
  // 删整棵子树）。不能点叉直接删：分类是层级结构，误删可能连带几十篇笔记的归属，事后难发现更难撤销。
  async function handleRequestDeleteCategory(scope: NoteCategoryScope, id: number) {
    const res = await vaultApi.call('note_category_impact', { id })
    if (!res.ok) {
      toast.error(t('categoryDeleteFailedToast'), { description: translateError(res.error, res.error_params) })
      return
    }
    // 空分类（没有子分类也没有笔记）没有可选的语义差别，直接删掉不打扰用户。
    if (res.impact.child_count === 0 && res.impact.direct_note_count === 0) {
      await handleConfirmDeleteCategory(id, 'promote')
      return
    }
    setCategoryDeleteTarget({ scope, impact: res.impact })
  }

  // 不收 scope 形参：删除会改动别的分类的路径和一批笔记的归属，本地没法只改
  // 一行就对上，统一整体重拉两个 scope 的分类和笔记列表，所以不需要知道是哪个。
  async function handleConfirmDeleteCategory(id: number, mode: NoteCategoryDeleteMode) {
    const res = await vaultApi.call('note_category_delete', { id, mode })
    if (!res.ok) {
      toast.error(t('categoryDeleteFailedToast'), { description: translateError(res.error, res.error_params) })
      return
    }
    setCategoryDeleteTarget(null)
    // promote/cascade 都会改动别的分类的路径（子类提升、整棵子树消失）和一批笔记
    // 的归属，本地没法只改一行就对上——整体重拉分类和笔记列表。
    await reloadCategories()
    await reload()
    toast.success(t('categoryDeletedToast'))
  }

  // 重命名 = 移动：物化路径下两者都是"换一段路径前缀"。把 `工作/项目A` 改成
  // `归档/项目A` 就是把整棵子树搬到另一个父级下面，不需要单独的"移动"操作。
  async function handleRenameCategory(id: number, newName: string) {
    const trimmed = newName.trim()
    if (!trimmed) return
    const res = await vaultApi.call('note_category_rename', { id, name: trimmed })
    if (!res.ok) {
      toast.error(t('categoryRenameFailedToast'), { description: translateError(res.error, res.error_params) })
      return
    }
    setRenamingCategory(null)
    await reloadCategories()
    await reload()
    toast.success(t('categoryRenamedToast'))
  }

  // 回溯重跑自动分类：先预览"哪几篇会从 X 改到 Y"，确认后才写。不在新建分类时自动收编旧笔记——分类器不
  // 知道用户为何手工归档，静默推翻很难发现和撤销。
  async function handleReclassifyPreview(scope: NoteCategoryScope, includeCategorized: boolean) {
    setReclassifyLoading(true)
    try {
      const res = await vaultApi.call('note_reclassify_preview', { scope, include_categorized: includeCategorized })
      if (!res.ok) {
        toast.error(t('reclassifyFailedToast'), { description: translateError(res.error, res.error_params) })
        return
      }
      setReclassify({ scope, includeCategorized, changes: res.changes, truncated: res.truncated, scanned: res.scanned })
    } finally {
      setReclassifyLoading(false)
    }
  }

  async function handleReclassifyApply() {
    if (!reclassify || reclassify.changes.length === 0) return
    setReclassifyLoading(true)
    try {
      const res = await vaultApi.call('note_reclassify_apply', { changes: reclassify.changes })
      if (!res.ok) {
        toast.error(t('reclassifyFailedToast'), { description: translateError(res.error, res.error_params) })
        return
      }
      setReclassify(null)
      await reloadCategories()
      await reload()
      toast.success(t('reclassifyAppliedToast', { count: res.applied }))
    } finally {
      setReclassifyLoading(false)
    }
  }

  // 给分类填写/修改关键词——用于导入文件自动分类（见 notes/classifier.py）。
  // 选填，不填不影响这个分类正常使用，只是少一份能被匹配到的额外线索。
  async function handleSetCategoryKeywords(scope: NoteCategoryScope, id: number, keywords: string) {
    const res = await vaultApi.call('note_category_set_keywords', { id, keywords })
    if (!res.ok) {
      toast.error(t('categoryKeywordsSaveFailedToast'), { description: translateError(res.error, res.error_params) })
      return
    }
    const setter = scope === 'normal' ? setNormalCategories : setHiddenCategories
    setter((prev) => prev.map((c) => (c.id === id ? res.category : c)))
    toast.success(t('categoryKeywordsSavedToast'))
  }

  async function handleCreateTag() {
    const name = newTagName.trim()
    if (!name) return
    const scope: NoteCategoryScope = hiddenOnly ? 'hidden' : 'normal'
    const res = await vaultApi.call('note_tag_create', { name, scope })
    if (!res.ok) {
      toast.error(t('tagCreateFailedToast'), { description: translateError(res.error, res.error_params) })
      return
    }
    const setter = scope === 'normal' ? setNormalTags : setHiddenTags
    setter((prev) => (prev.some((tag) => tag.id === res.tag.id) ? prev : [...prev, res.tag].sort((a, b) => a.name.localeCompare(b.name))))
    setNewTagName('')
  }

  async function handleDeleteTag(id: number) {
    const res = await vaultApi.call('note_tag_delete', { id })
    if (!res.ok) {
      toast.error(t('tagDeleteFailedToast'), { description: translateError(res.error, res.error_params) })
      return
    }
    setNormalTags((prev) => prev.filter((tag) => tag.id !== id))
    setHiddenTags((prev) => prev.filter((tag) => tag.id !== id))
    if (tagFilter !== 'all') setTagFilter('all')
    await reload()
  }

  async function handleSetDetailTags(tagIds: number[]) {
    if (detailId === null) return
    const res = await vaultApi.call('note_tags_set', { id: detailId, tag_ids: tagIds })
    if (!res.ok) {
      toast.error(t('tagUpdateFailedToast'), { description: translateError(res.error, res.error_params) })
      return
    }
    setDetailTagIds(tagIds)
    setDetailNote(res.note)
    setNotes((prev) => sortNotes(prev.map((note) => (note.id === res.note.id ? res.note : note))))
  }

  async function handleBulkAddTag(tagId: number) {
    if (visibleSelectedIds.length === 0) return
    const res = await vaultApi.call('note_tags_add_bulk', { ids: visibleSelectedIds, tag_id: tagId })
    if (!res.ok) {
      toast.error(t('tagUpdateFailedToast'), { description: translateError(res.error, res.error_params) })
      return
    }
    await reload()
    toast.success(t('bulkTagsUpdatedToast', { count: res.updated_count }))
  }

  // 选多张图片挂到当前笔记，单个失败不影响其余（同 handleImportFiles）。只有已保存笔记（detailId 非
  // null）才能调，新建草稿没有 note_id 可挂。
  async function handleImportImages() {
    if (detailId === null) return
    const { path: defaultPath, stale } = await resolveDefaultPath('import')
    if (stale) toast.info(t('pathStaleToast'))
    const paths = await electronApi.openFiles({
      title: t('importImagesDialogTitle'),
      properties: ['openFile', 'multiSelections'],
      defaultPath: defaultPath ?? undefined,
      filters: [
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] },
        { name: t('allFilesFilter'), extensions: ['*'] },
      ],
    })
    if (!paths || paths.length === 0) return
    recordUsedPath('import', dirnameOf(paths[0]))
    setImageImporting(true)
    try {
      const res = await vaultApi.call('note_image_import_files', { note_id: detailId, paths })
      if (!res.ok) {
        toast.error(t('imageImportFailedToast'), { description: translateError(res.error, res.error_params) })
        return
      }
      if (res.imported.length > 0) {
        setNoteImages((prev) => [...prev, ...res.imported])
      }
      if (res.failed.length > 0) {
        toast.error(t('imageImportPartialToast', { success: res.imported.length, failed: res.failed.length }), {
          description: res.failed
            .map((f) => `${f.path.split(/[\\/]/).pop()}：${translateError(f.error, f.error_params)}`)
            .join('\n'),
        })
      }
    } finally {
      setImageImporting(false)
    }
  }

  // 剪贴板粘图：图片区虚线框获焦后 Ctrl+V 触发，handler 只挂在图片区容器上，不影响标题/分类输入框或
  // CodeMirror 的原生粘贴。
  async function handlePasteImage(e: ClipboardEvent<HTMLDivElement>) {
    if (detailId === null) return
    const item = Array.from(e.clipboardData.items).find((it) => it.type.startsWith('image/'))
    if (!item) return
    e.preventDefault()
    const file = item.getAsFile()
    if (!file) return
    const buffer = await file.arrayBuffer()
    const imageBase64 = arrayBufferToBase64(buffer)
    setImageImporting(true)
    try {
      const res = await vaultApi.call('note_image_paste', { note_id: detailId, image_base64: imageBase64 })
      if (!res.ok) {
        toast.error(t('imagePasteFailedToast'), { description: translateError(res.error, res.error_params) })
        return
      }
      setNoteImages((prev) => [...prev, res.image])
      toast.success(t('imagePastedToast'))
    } finally {
      setImageImporting(false)
    }
  }

  async function handleDeleteImage(id: number) {
    setNoteImages((prev) => prev.filter((img) => img.id !== id))
    const res = await vaultApi.call('note_image_delete', { id })
    if (!res.ok) {
      toast.error(t('imageDeleteFailedToast'), { description: translateError(res.error, res.error_params) })
      if (detailId !== null) {
        const refreshed = await vaultApi.call('note_image_list', { note_id: detailId })
        if (refreshed.ok) setNoteImages(refreshed.images)
      }
    }
  }

  async function handleViewImage(id: number) {
    setImageViewerOpen(true)
    setViewingImage(null)
    setViewingImageLoading(true)
    const res = await vaultApi.call('note_image_get', { id })
    setViewingImageLoading(false)
    if (!res.ok) {
      toast.error(t('imageLoadFailedToast'), { description: translateError(res.error, res.error_params) })
      setImageViewerOpen(false)
      return
    }
    setViewingImage(res.image)
  }

  function changeEditorFont(font: EditorFont) {
    setEditorFont(font)
    localStorage.setItem(EDITOR_FONT_STORAGE_KEY, font)
  }

  function changeEditorFontSize(size: number) {
    setEditorFontSize(size)
    localStorage.setItem(EDITOR_FONT_SIZE_STORAGE_KEY, String(size))
  }

  function changeEditorFontWeight(weight: EditorFontWeight) {
    setEditorFontWeight(weight)
    localStorage.setItem(EDITOR_FONT_WEIGHT_STORAGE_KEY, String(weight))
  }

  // Ctrl+滚轮缩放字号，只在鼠标停在编辑器区域内生效，不拦截页面其余位置滚动。deltaY<0 为向上滚（放
  // 大）。
  function handleEditorWheelZoom(e: WheelEvent) {
    if (!e.ctrlKey) return
    e.preventDefault()
    const idx = EDITOR_FONT_SIZES.indexOf(editorFontSize)
    const nextIdx = e.deltaY < 0 ? Math.min(EDITOR_FONT_SIZES.length - 1, idx + 1) : Math.max(0, idx - 1)
    changeEditorFontSize(EDITOR_FONT_SIZES[nextIdx])
  }

  // 自动识别的章节目录随 draftContent 重算（见 extractChapters）。分段大笔记的 draftContent 只是当前
  // 段，目录/跳转在段边界上无意义（扫不到其它段标题，偏移量也只在当前段有效），所以对 isLargeNote 关
  // 闭，免得展示被误解成"全篇目录"的片段。
  const currentFormat: NoteFormat = detailNote?.format ?? 'plain'
  const chapters = useMemo(
    () => (isLargeNote ? [] : extractChapters(draftContent, currentFormat)),
    [draftContent, currentFormat, isLargeNote],
  )

  function changeChaptersOpen(open: boolean) {
    setChaptersOpen(open)
    localStorage.setItem(CHAPTERS_OPEN_STORAGE_KEY, String(open))
  }

  function changeNoteSortMode(mode: NoteSortMode) {
    setNoteSortMode(mode)
    localStorage.setItem(NOTE_SORT_MODE_STORAGE_KEY, mode)
  }

  function changeListCollapsed(collapsed: boolean) {
    setListCollapsed(collapsed)
    localStorage.setItem(LIST_COLLAPSED_STORAGE_KEY, String(collapsed))
  }

  function changeAutoScrollControlsOpen(open: boolean) {
    setAutoScrollControlsOpen(open)
    localStorage.setItem(AUTO_SCROLL_CONTROLS_OPEN_STORAGE_KEY, String(open))
  }

  // 分段大笔记和 readOnlyBootstrap 期间强制源码视图：draftContent 只是当前段，预览/分屏只渲染片段（跨
  // 段状态对不上）会被误解为全篇；readOnlyBootstrap 时内容将被替换。两个条件结束后自然恢复存的偏好，
  // 不修改 markdownViewMode 本身。
  const effectiveMarkdownViewMode: MarkdownViewMode = readOnlyBootstrap || isLargeNote ? 'source' : markdownViewMode

  function changeMarkdownViewMode(mode: MarkdownViewMode) {
    setMarkdownViewMode(mode)
    localStorage.setItem(MARKDOWN_VIEW_MODE_STORAGE_KEY, mode)
  }

  // 预览内容防抖，见 debouncedMarkdownContent 声明处。只在真要展示预览（preview/split 且为 Markdown笔
  // 记）时才跑。
  useEffect(() => {
    if (currentFormat !== 'markdown' || markdownViewMode === 'source') return
    // 防抖时长随文档大小走。渲染已在 Worker（lib/useMarkdownHtml），主线程不冻，但排队仍存在：2MB 文档
    // 渲染要半秒多，固定 200ms 会越欠越多，预览越追越远；让间隔跟上一次渲染耗时，预览才是"慢半拍"而非"
    // 落后好几拍"。
    const delay = draftContent.length > 512 * 1024 ? 800 : draftContent.length > 64 * 1024 ? 400 : 200
    const handle = setTimeout(() => setDebouncedMarkdownContent(draftContent), delay)
    return () => clearTimeout(handle)
  }, [draftContent, currentFormat, markdownViewMode])

  // ---- 阅读/编辑位置记忆（见 lib/positionMemory.ts） ----

  function currentScrollRatio(view: EditorView): number {
    const el = view.scrollDOM
    const max = el.scrollHeight - el.clientHeight
    return max > 0 ? el.scrollTop / max : 0
  }

  // 按占比恢复滚动位置，必须走 view.requestMeasure()，不能在 dispatch 后直接读 scrollHeight：
  // CodeMirror 读写分两阶段，dispatch 后 scrollDOM.scrollHeight 仍是上一次布局的值（文档刚整篇替换时
  // 往往是空文档，算出 scrollTop 为 0），笔记越大越不灵。requestMeasure 回调在本轮布局之后的读阶段执
  // 行，高度才是真的；不要用setTimeout(0)/rAF 猜延迟。
  function applyScrollRatio(view: EditorView, ratio: number) {
    view.requestMeasure({
      read: () => {
        const el = view.scrollDOM
        return Math.max(0, el.scrollHeight - el.clientHeight)
      },
      write: (max) => {
        if (max > 0) view.scrollDOM.scrollTop = Math.round(ratio * max)
      },
    })
  }

  // 500ms 防抖后才写 localStorage，避免每次敲字/滚动都序列化落盘；读取的是触发时刻的最新状态。
  // useCallback([]) 使引用终身不变——函数体只经 ref 读状态、不闭包会变的 props/state；这也是下面
  // CodeMirror onUpdate 保持稳定、不在每次敲字后全量 reconfigure 的前提。
  const schedulePositionSave = useCallback(() => {
    const noteId = currentNoteIdRef.current
    if (noteId === null) return
    if (positionSaveTimerRef.current) clearTimeout(positionSaveTimerRef.current)
    positionSaveTimerRef.current = setTimeout(() => {
      const view = editorViewRef.current
      const id = currentNoteIdRef.current
      if (!view || id === null) return
      const head = view.state.selection.main.head
      // 大文件模式下往前拼接更早的段会改变光标在 draftContent 的绝对偏移，所以存"段内相对偏移"：下次按
      // (segmentOrdinal, 相对偏移) 重开，种子段从 0 起，含义一致。段号必须用"光标真正落在哪一段"（
      // segmentOrdinalAtPos 按 head 现查），不能用 segmentOrdinalRef.current（那是滚动停在哪一段）：两者
      // 不同时算出的相对偏移可能为负或超出目标段长度，导致定位歪掉。查不到光标所在段（兜底用
      // segmentOrdinalRef）或普通笔记（segments 为空）则退回绝对偏移。
      const segments = loadedSegmentsRef.current
      const cursorOrdinal = segmentOrdinalAtPos(head, segments) ?? segmentOrdinalRef.current
      const cursorSegment = segments.find((seg) => seg.ordinal === cursorOrdinal)
      const cursor = cursorSegment ? head - cursorSegment.start : head
      savePosition(id, {
        cursor,
        scrollRatio: currentScrollRatio(view),
        savedAt: Date.now(),
        // 普通笔记 cursorOrdinal 退回 segmentOrdinalRef.current（恒为 0），写进记录无妨：读取方只在
        // isLargeNote 时参考此字段（见加载 effect 的 initialOrdinal）。
        segmentOrdinal: cursorOrdinal,
      })
    }, 500)
  }, [])

  // onUpdate/onChange 要稳定引用（扩展数组同理，见 notes/NoteEditor.tsx）：内联箭头函数每次渲染都是新
  // 引用，会触发 @uiw/react-codemirror 内部的 reconfigure useEffect（见该库 useCodeMirror.js）。
  // handleEditorUpdate 只依赖已稳定的 schedulePositionSave。
  const handleEditorUpdate = useCallback(
    (viewUpdate: ViewUpdate) => {
      // 大文件模式下文档变化（用户敲字或 maybeLoadMoreSegments 拼接）都要重映射每段 start/end：用
      // ChangeSet.mapPos（默认 assoc=-1）而非手动加减字符数，边界上打字归到后一段，段边界始终卡在原换行
      // 处。同时用 ChangeSet.touchesRange（旧坐标系，必须在算新 start/end 之前用 seg 原值查）增量维护
      // dirty；一旦置脏只在 handleSaveLargeNote 保存成功时清除。懒加载自己拼接的事务（userEvent
      // 'segment.append'/'segment.prepend'）必须排除出 touchesRange 判定：插入点正好在相邻段边界时会误判
      // 为"碰到了"（实测 prepend 与 append 都会），而误置的 dirty 无事件能清除，会让"有未保存改动"提示永
      // 久卡住。mapPos 重映射仍照常。.every() 对空数组为 true，所以多判一次长度，不依赖"docChanged 时
      // transactions 一定非空"的未确认假设。
      const isLazyLoadSplice =
        viewUpdate.transactions.length > 0 && viewUpdate.transactions.every((tr) => tr.isUserEvent('segment'))
      if (viewUpdate.docChanged && loadedSegmentsRef.current.length > 0) {
        const changes = viewUpdate.changes
        setLoadedSegments((prev) =>
          prev.map((seg) => ({
            ...seg,
            start: changes.mapPos(seg.start),
            end: changes.mapPos(seg.end),
            dirty: seg.dirty || (!isLazyLoadSplice && !!changes.touchesRange(seg.start, seg.end)),
          })),
        )
      }
      // 光标/选区变化（含纯点击）即触发位置防抖保存；具体值由 schedulePositionSave 500ms 后自己从
      // editorViewRef 取，这里只是"有变化"的信号。updateFocusedSegmentOrdinal 同理，只更新"第 X/Y 段"显
      // 示。
      if (viewUpdate.selectionSet || viewUpdate.docChanged) {
        schedulePositionSave()
        updateFocusedSegmentOrdinal()
      }
    },
    [schedulePositionSave, updateFocusedSegmentOrdinal],
  )

  // 分段大笔记当前段有界（≤512KB，segmented_content.MAX_SEGMENT_BYTES），与普通笔记一样直接
  // setDraftContent，不再需要旧版"敲字不进 state"的旁路。替换功能（
  // handleReplaceOne/handleReplaceAll）直接对editorViewRef 派发事务，也会走到这里。
  const handleEditorChange = useCallback((value: string) => {
    setDraftContent(value)
  }, [])

  // 打开笔记后跳回上次位置：光标按字符偏移，滚动按占比换算为当前像素，二者独立恢复（用户可能只滚动没
  // 动光标）。expectedLength 是完整正文应有长度：大笔记分片加载期间 CodeMirror 文档可能还没跟上
  // setDraftContent，用 rAF 轮询，最多 10 帧（~160ms）。expectedContent（可选）：受控组件的
  // @uiw/react-codemirror 在提交后才由 useEffect 同步 doc，此刻view.state.doc 多半仍是上一条笔记。只
  // 比长度会在切到更短/等长笔记时把"未同步"误判为"已同步"，跳转随后被覆盖（表现为"没跳转"）；传入后要
  // 求文档内容完全一致才算就绪。不传则用长度下限（大笔记分片加载内容持续增长，没有确定的最终字符串
  // ）。

  // 直接派发内容并恢复位置（绕过受控组件 useEffect 往返）：先对 editorViewRef.current 派发内容、恢复
  // 光标/滚动，最后才 setDraftContent。@uiw/react-codemirror 的 useEffect 只在 value !==
  // view.state.doc.toString() 时同步，此时两者已匹配，不会覆盖刚设好的光标。返回 true 成功，false 表
  // 示 editorViewRef 未就绪（回退旧路径）。
  function loadContentDirect(noteId: number, content: string, onContentSet: (v: string) => void): boolean {
    const view = editorViewRef.current
    if (!view) return false
    // 1. 先取消任何未触发的防抖保存（防止第②步 dispatch 触发的 onUpdate
    //    启动一个 500ms 后的位置保存，覆盖掉我们后面设的正确光标位置）
    if (positionSaveTimerRef.current) {
      clearTimeout(positionSaveTimerRef.current)
      positionSaveTimerRef.current = null
    }
    // 2. 替换整个文档（原子操作）：会同步触发 onUpdate → schedulePositionSave 重设 timer，第④步再清一
    // 次。
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content } })
    // 3. 立即恢复保存的位置（此时 view.state.doc 已是最新内容）
    const saved = getPosition(noteId)
    if (saved) {
      const pos = Math.min(saved.cursor, content.length)
      reveal(view, { selection: { anchor: pos, head: pos }, marker: pos })
      applyScrollRatio(view, saved.scrollRatio)
      if (positionMarkerTimerRef.current) clearTimeout(positionMarkerTimerRef.current)
      positionMarkerTimerRef.current = setTimeout(() => {
        if (currentNoteIdRef.current === noteId) reveal(view, { marker: null })
      }, 2500)
    }
    // 4. 再清一次防抖：第②步 dispatch 可能让 schedulePositionSave 重设了 500ms timer，不取消会用旧的"光
    // 标在 0"覆盖已恢复好的位置。
    if (positionSaveTimerRef.current) {
      clearTimeout(positionSaveTimerRef.current)
      positionSaveTimerRef.current = null
    }
    // 5. 同步 React state——此时 useEffect 发现 value===doc.toString() 会跳过
    onContentSet(content)
    return true
  }

  function restorePositionForNote(noteId: number, expectedLength: number, expectedContent?: string) {
    const saved = getPosition(noteId)
    if (!saved) return

    // 辅助函数：把 saved position 应用到给定的 EditorView 上
    const applyPosition = (view: EditorView, id: number, pos: NotePosition) => {
      const cursor = Math.min(pos.cursor, view.state.doc.length)
      reveal(view, { selection: { anchor: cursor, head: cursor }, marker: cursor })
      applyScrollRatio(view, pos.scrollRatio)
      if (positionMarkerTimerRef.current) clearTimeout(positionMarkerTimerRef.current)
      positionMarkerTimerRef.current = setTimeout(() => {
        if (currentNoteIdRef.current === id) reveal(view, { marker: null })
      }, 2500)
    }

    // 快速路径：编辑器已经是最新内容 → 立即恢复
    const view = editorViewRef.current
    if (view && expectedContent !== undefined && view.state.doc.toString() === expectedContent) {
      applyPosition(view, noteId, saved)
      return
    }

    // 慢速路径：轮询等到编辑器跟上内容（最大 ~1s / 60帧）
    let resolved = false
    const attempt = (attemptsLeft: number) => {
      if (resolved) return // 已在某一帧成功，不再重复
      if (currentNoteIdRef.current !== noteId) return // 期间用户又切换了笔记，放弃
      const v = editorViewRef.current
      if (!v) {
        if (attemptsLeft > 0) { requestAnimationFrame(() => attempt(attemptsLeft - 1)); return }
        return
      }
      const ready =
        expectedContent !== undefined
          ? v.state.doc.length === expectedContent.length && v.state.doc.toString() === expectedContent
          : v.state.doc.length >= expectedLength
      if (!ready) {
        if (attemptsLeft <= 0) {
          // 最后一帧仍不满足：如果文档为空就放弃（比在旧/空文档上乱跳好）
          if (v.state.doc.length === 0) return
          // 否则按当前文档已有内容尽量恢复（聊胜于无）
        } else {
          requestAnimationFrame(() => attempt(attemptsLeft - 1))
          return
        }
      }
      resolved = true
      applyPosition(v, noteId, saved)
    }
    attempt(60) // 60帧 ≈ 1秒
  }

  // E1：手动滚动偏离记住的位置超过一屏的一半后，出现"回到上次位置"悬浮
  // 按钮；滚动监听里节流判断，避免每个 scroll 事件都算一遍。
  function updateBackToPositionVisibility() {
    const view = editorViewRef.current
    const noteId = currentNoteIdRef.current
    if (!view || noteId === null) {
      setShowBackToPosition(false)
      return
    }
    const saved = getPosition(noteId)
    if (!saved) {
      setShowBackToPosition(false)
      return
    }
    const el = view.scrollDOM
    const max = el.scrollHeight - el.clientHeight
    const savedScrollTop = saved.scrollRatio * Math.max(0, max)
    setShowBackToPosition(Math.abs(el.scrollTop - savedScrollTop) > el.clientHeight * 0.5)
  }

  async function handleBackToLastPosition() {
    const noteId = currentNoteIdRef.current
    if (noteId === null) return
    if (isLargeNote) {
      // saved.cursor 是段内相对偏移（见 schedulePositionSave），不能直接当绝对偏移：先确保
      // saved.segmentOrdinal 那段已加载（可能在当前窗口或要重拼），再换算。
      const saved = getPosition(noteId)
      if (!saved) return
      const targetOrdinal = saved.segmentOrdinal ?? 0
      const ok = await ensureSegmentLoaded(targetOrdinal)
      if (!ok) return
      applyPositionWithinSegment(targetOrdinal, saved.cursor)
    } else {
      restorePositionForNote(noteId, 0)
    }
    setShowBackToPosition(false)
  }

  // P1：历史回溯——跳到最近 3~5 次里的某一条旧位置。
  async function handleJumpToHistoryPosition(position: NotePosition) {
    const noteId = currentNoteIdRef.current
    const view = editorViewRef.current
    if (noteId === null || !view) return
    restoreFromHistory(noteId, position)
    if (isLargeNote) {
      // 同 handleBackToLastPosition：position.cursor 是段内相对偏移，要先确保对应段加载好再换算。这里跳的
      // 是历史里选中的某条，不是最新保存的，所以只借 ensureSegmentLoaded "把目标段加载好"这一步。
      const targetOrdinal = position.segmentOrdinal ?? 0
      const ok = await ensureSegmentLoaded(targetOrdinal)
      if (!ok) return
      applyPositionWithinSegment(targetOrdinal, position.cursor)
    } else {
      const pos = Math.min(position.cursor, view.state.doc.length)
      reveal(view, { selection: { anchor: pos, head: pos }, marker: pos })
      applyScrollRatio(view, position.scrollRatio)
    }
    setPositionHistoryOpen(false)
  }

  // ---- 自动滚动（见 lib/autoScroll.ts） ----

  // 设置变化时：同步进 ref（供正在跑的 rAF 循环读取最新值，不用等循环
  // 重新调度）+ 落盘（下次打开沿用这次的方向/速度/单位）。
  useEffect(() => {
    autoScrollSettingsRef.current = autoScrollSettings
    saveAutoScrollSettings(autoScrollSettings)
  }, [autoScrollSettings])

  // 组件卸载时（比如整个笔记面板被切走）确保 rAF 循环被取消，不留一个
  // 没人再看得到、还在悄悄跑的定时器。
  useEffect(() => {
    return () => {
      if (autoScrollRafRef.current !== null) cancelAnimationFrame(autoScrollRafRef.current)
    }
  }, [])

  function stopAutoScroll() {
    if (autoScrollRafRef.current !== null) {
      cancelAnimationFrame(autoScrollRafRef.current)
      autoScrollRafRef.current = null
    }
    autoScrollRuntimeRef.current = null
    setAutoScrollActive(false)
  }

  function autoScrollTick(timestamp: number) {
    const view = editorViewRef.current
    const runtime = autoScrollRuntimeRef.current
    if (!view || !runtime) return
    const settings = autoScrollSettingsRef.current
    const el = view.scrollDOM
    const dirSign = settings.direction === 'down' ? 1 : -1

    if (runtime.pausedUntil !== null) {
      if (timestamp < runtime.pausedUntil) {
        autoScrollRafRef.current = requestAnimationFrame(autoScrollTick)
        return
      }
      runtime.pausedUntil = null
      runtime.boundaryTargetY = null
    }

    if (settings.unit !== 'pixel' && runtime.boundaryTargetY === null) {
      runtime.boundaryTargetY = computeNextBoundaryY(view, dirSign, settings.unit)
    }

    const dt = runtime.lastFrameTime ? (timestamp - runtime.lastFrameTime) / 1000 : 0
    runtime.lastFrameTime = timestamp
    const speed = speedPxPerSecFor(settings)
    const deltaPx = speed * rampFactorFor(timestamp - runtime.startTime) * dt * dirSign

    autoScrollDrivenRef.current = true
    if (settings.unit !== 'pixel' && runtime.boundaryTargetY !== null) {
      const target = runtime.boundaryTargetY
      const nextTop = el.scrollTop + deltaPx
      const reached = dirSign === 1 ? nextTop >= target : nextTop <= target
      if (reached) {
        el.scrollTop = target
        if (settings.unit === 'paragraph') {
          runtime.pausedUntil = timestamp + paragraphPauseMs()
        } else {
          runtime.boundaryTargetY = null
        }
      } else {
        el.scrollTop = nextTop
      }
    } else {
      el.scrollTop += deltaPx
    }
    autoScrollDrivenRef.current = false

    const max = el.scrollHeight - el.clientHeight
    setAutoScrollProgress(max > 0 ? Math.min(100, Math.max(0, (el.scrollTop / max) * 100)) : 0)

    // 滚到头/滚到尾——自动停止，不越界、不报错。
    if ((dirSign === 1 && el.scrollTop >= max - 0.5) || (dirSign === -1 && el.scrollTop <= 0.5)) {
      stopAutoScroll()
      return
    }
    autoScrollRafRef.current = requestAnimationFrame(autoScrollTick)
  }

  function startAutoScroll() {
    const view = editorViewRef.current
    if (!view || readOnlyBootstrap) return
    autoScrollRuntimeRef.current = { startTime: performance.now(), lastFrameTime: 0, boundaryTargetY: null, pausedUntil: null }
    setAutoScrollActive(true)
    autoScrollRafRef.current = requestAnimationFrame(autoScrollTick)
  }

  function toggleAutoScroll() {
    if (autoScrollActive) stopAutoScroll()
    else startAutoScroll()
  }

  // Esc 立即停止自动滚动——跟上面查找面板的 Esc 优先级分开一个单独的
  // effect，findPanelOpen 时优先关面板（已有 handler 处理），不重复响应。
  useEffect(() => {
    if (!autoScrollActive) return
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && !findPanelOpen) {
        e.preventDefault()
        stopAutoScroll()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [autoScrollActive, findPanelOpen])

  // 点击目录标题：光标移到该标题的全文字符偏移处并滚动到可见区顶部附近，不改正文。editorViewRef 由
  // CodeMirror 的 onCreateEditor 回调填充。
  function jumpToChapter(offset: number) {
    const view = editorViewRef.current
    if (!view) return
    const pos = Math.min(offset, view.state.doc.length)
    reveal(view, {
      selection: { anchor: pos, head: pos },
      scrollTo: { pos, y: 'start', yMargin: 40 },
      focus: true,
    })
  }

  // 查找结果重算 200ms 防抖，避免大笔记每敲一个查找字符都扫全文；draftContent 变化（编辑或替换）也重
  // 算，保证对得上当前正文。面板关闭时不算。就近查找：默认选中光标之后最近的匹配（nearestMatchIndex
  // ），而非总跳回开头。
  useEffect(() => {
    if (!findPanelOpen) return
    const handle = setTimeout(() => {
      const result = computeFindMatches(draftContent, findQuery, {
        caseSensitive: findCaseSensitive,
        regexp: findRegexp,
        wholeWord: findWholeWord,
      })
      setFindMatches(result.matches)
      setFindCapped(result.capped)
      setFindError(result.error)
      const cursorPos = editorViewRef.current?.state.selection.main.from ?? 0
      setFindMatchIndex(nearestMatchIndex(result.matches, cursorPos))
    }, 200)
    return () => clearTimeout(handle)
  }, [findPanelOpen, findQuery, findCaseSensitive, findRegexp, findWholeWord, draftContent])

  function goToMatch(index: number) {
    if (index < 0 || index >= findMatches.length) return
    setFindMatchIndex(index)
    const view = editorViewRef.current
    if (!view) return
    const match = findMatches[index]
    reveal(view, {
      selection: { anchor: match.from, head: match.to },
      scrollTo: { pos: match.from, y: 'center', yMargin: 60 },
      focus: true,
    })
  }

  function goToNextMatch() {
    if (findMatches.length === 0) return
    goToMatch((findMatchIndex + 1) % findMatches.length)
  }

  function goToPrevMatch() {
    if (findMatches.length === 0) return
    goToMatch((findMatchIndex - 1 + findMatches.length) % findMatches.length)
  }

  // Ctrl+F/Ctrl+H 入口：只在焦点在编辑器内时开查找面板，焦点在别处维持"聚焦笔记列表搜索框"（见全局
  // Ctrl+F 处理），二者不能互抢。readOnlyBootstrap 引导期间不许开：draftContent 只是已加载前缀，查找
  // 会漏掉后半部分且不提示（M1 标注的高风险点），禁用比给不完整结果安全。
  function openFindPanel(withReplace: boolean) {
    if (readOnlyBootstrap) return
    setFindPanelOpen(true)
    if (withReplace) setFindShowReplace(true)
    requestAnimationFrame(() => findInputRef.current?.focus())
  }

  function closeFindPanel() {
    setFindPanelOpen(false)
    setFindMatches([])
    setFindMatchIndex(-1)
    editorViewRef.current?.focus()
  }

  // 单个替换：直接对 editorViewRef 派发 CodeMirror 事务，与用户手打同路径，照常触发 onChange（统一走
  // setDraftContent），无需另外手动同步 state。不手动挪 findMatchIndex：draftContent 变化触发重算
  // effect，按新光标位置自然定位到下一条。
  function handleReplaceOne() {
    const view = editorViewRef.current
    if (!view || findMatchIndex < 0 || findMatchIndex >= findMatches.length) return
    const match = findMatches[findMatchIndex]
    view.dispatch({ changes: { from: match.from, to: match.to, insert: replaceQuery }, userEvent: 'input.replace' })
  }

  // 全部替换：一次事务传入整批 change 数组，CodeMirror 全部按"替换前原文档"坐标应用，无需自己倒推偏
  // 移，这也是不循环调 replaceNext 的原因。
  function handleReplaceAll() {
    const view = editorViewRef.current
    if (!view || findMatches.length === 0) return
    const count = findMatches.length
    view.dispatch({
      changes: findMatches.map((m) => ({ from: m.from, to: m.to, insert: replaceQuery })),
      userEvent: 'input.replace.all',
    })
    toast.success(t('replaceAllDoneToast', { count }))
  }

  const dirty = isLargeNote
    ? isLargeNoteContentDirty(loadedSegments) ||
      (largeNoteBaseline !== null && (draftTitle !== largeNoteBaseline.title || draftCategory !== largeNoteBaseline.category))
    : creatingNew
      ? draftTitle !== '' || draftCategory !== '' || draftContent !== ''
      : detailNote !== null &&
        (draftTitle !== detailNote.title || draftCategory !== detailNote.category || draftContent !== detailNote.content)

  // 大笔记（分段）保存：标题/分类走 note_metadata_update（不带正文）；正文改动可能横跨懒加载拼进来的
  // 多段，逐段按各自 revision 做乐观并发校验（note_content_segment_put），某段冲突时保留其错误提示和
  // 未保存状态，已成功的段不撤销。返回值表示这次保存是否完全成功，供 handleGoToSegment/handleSave 判
  // 断。
  async function handleSaveLargeNote(noteId: number, opts?: { silent?: boolean }): Promise<boolean> {
    const titleRes = await vaultApi.call('note_metadata_update', { id: noteId, title: draftTitle, category: draftCategory })
    if (!titleRes.ok) {
      toast.error(t('saveFailedToast'), { description: translateError(titleRes.error, titleRes.error_params) })
      return false
    }
    setNotes((prev) => sortNotes(prev.map((n) => (n.id === noteId ? toMetaItem(titleRes.note) : n))))

    // 特意不用 seg.dirty 筛选：决定 PUT 哪些段必须绝对准确，用精确 slice+比较逐段核实，保存低频（防抖 2
    // 秒或 Ctrl+S）付得起 O(已加载总量)；dirty 的价值在每次渲染/敲字都要算的 isLargeNoteContentDirty（
    // 见 LoadedSegment）。
    const dirtySegments = loadedSegments.filter((seg) => draftContent.slice(seg.start, seg.end) !== seg.baseline)
    if (dirtySegments.length > 0) {
      const sessionId = segmentSessionIdRef.current
      if (!sessionId) {
        toast.error(t('saveFailedToast'), { description: translateError('notes.segment_session_not_found') })
        return false
      }
      const updated: LoadedSegment[] = []
      let firstFailure: { ok: false; error: string; error_params?: Record<string, string | number> } | null = null
      // 每段各自按 revision 乐观校验，某段冲突/失败不该连累后面的段：用 continue 而非 break 把其余都试一
      // 遍，只有真正冲突的段留脏标记等重试。
      for (const seg of dirtySegments) {
        const res = await vaultApi.call('note_content_segment_put', {
          session_id: sessionId,
          segment_id: seg.id,
          expected_revision: seg.revision,
          content: draftContent.slice(seg.start, seg.end),
        })
        if (!res.ok) {
          firstFailure ??= res
          continue
        }
        updated.push({ ...seg, id: res.segment.id, revision: res.segment.revision, baseline: res.segment.content, dirty: false })
      }
      if (updated.length > 0) {
        setLoadedSegments((prev) => prev.map((s) => updated.find((u) => u.ordinal === s.ordinal) ?? s))
      }
      if (firstFailure) {
        toast.error(t('saveFailedToast'), { description: translateError(firstFailure.error, firstFailure.error_params) })
        return false
      }
    }
    setLargeNoteBaseline({ title: draftTitle, category: draftCategory })
    if (!opts?.silent) toast.success(t('savedToast'))
    return true
  }

  // opts.silent 供自动保存：静默落盘、不弹成功提示（每 2 秒一次会烦人）；手动 Ctrl+S/按钮仍弹。成功后
  // 都刷新 lastSavedAt。返回值：盘上内容是否已等于编辑框内容（无改动也算 true）。时间线恢复、批量修
  // 改、去重合并之前要先存盘，靠它决定能否继续。
  async function handleSave(opts?: { silent?: boolean }): Promise<boolean> {
    if (!dirty) return true
    if (saving) return false
    setSaving(true)
    try {
      if (isLargeNote && detailId !== null) {
        // 大文件保存失败不能往下走：不看返回值会在保存失败时仍清掉崩溃恢复快照并显示"已保存"，把兜底快照也
        // 丢了（见 handleSaveLargeNote 返回值）。
        const ok = await handleSaveLargeNote(detailId, opts)
        if (!ok) return false
      } else if (creatingNew) {
        const res = await vaultApi.call('note_create', {
          title: draftTitle,
          category: draftCategory,
          content: draftContent,
          encrypt: await resolveDefaultEncrypt(),
        })
        if (!res.ok) {
          toast.error(t('saveFailedToast'), { description: translateError(res.error, res.error_params) })
          return false
        }
        if (!opts?.silent) toast.success(t('createdToast'))
        setNotes((prev) => sortNotes([toMetaItem(res.note), ...prev]))
        setCreatingNew(false)
        setDetailNote(res.note)
        setDetailId(res.note.id)
      } else if (detailId !== null) {
        const res = await vaultApi.call('note_update', {
          id: detailId,
          title: draftTitle,
          category: draftCategory,
          content: draftContent,
        })
        if (!res.ok) {
          toast.error(t('saveFailedToast'), { description: translateError(res.error, res.error_params) })
          return false
        }
        if (!opts?.silent) toast.success(t('savedToast'))
        setDetailNote(res.note)
        setNotes((prev) => sortNotes(prev.map((n) => (n.id === res.note.id ? toMetaItem(res.note) : n))))
      }
      setLastSavedAt(Date.now())
      localStorage.removeItem(DRAFT_RECOVERY_STORAGE_KEY)
      setRecoverySnapshot(null)
      return true
    } finally {
      setSaving(false)
    }
  }

  // CodeMirror 是受控组件，setDraftContent 后真实文档不一定在同一 tick 同步到新值（同
  // restorePositionForNote）。ensureSegmentLoaded 换段后用它等到文档确实等于所设内容，调用方拿到成功
  // 即可放心用绝对偏移操作editorViewRef，不必各自轮询。
  function waitForEditorContent(expected: string): Promise<void> {
    return new Promise((resolve) => {
      const attempt = (attemptsLeft: number) => {
        const view = editorViewRef.current
        const ready = !!view && view.state.doc.length === expected.length && view.state.doc.toString() === expected
        if (ready || attemptsLeft <= 0) {
          resolve()
          return
        }
        requestAnimationFrame(() => attempt(attemptsLeft - 1))
      }
      attempt(60) // 60帧 ≈ 1秒
    })
  }

  // 确保某段在当前拼接窗口里：已在（种子段、懒加载滚入或之前跳转带入）直接算成功；不在则丢弃整个窗
  // 口、以目标段重建单段窗口（"上一段/下一段"远跳、"回到上次位置"/"历史位置"跳到窗口外的段都靠它）。
  // 有脏改动先保存，保存失败就放弃导航留在原地，不能让用户无察觉地丢改动。过程中用 readOnlyBootstrap
  // 挡编辑并暂停懒加载（见 maybeLoadMoreSegments 开头 guard）。返回 true 时真实文档已落位（见
  // waitForEditorContent）；调用方不应再读闭包里的 draftContent，那在本次调用期间是冻结的旧值。
  async function ensureSegmentLoaded(targetOrdinal: number): Promise<boolean> {
    if (loadedSegmentsRef.current.some((seg) => seg.ordinal === targetOrdinal)) return true
    if (targetOrdinal < 0 || targetOrdinal >= segmentCountRef.current) return false
    // 用 ref 而非 segmentNavigating/readOnlyBootstrap state 判断能否开始：setState 要到下次渲染才进闭
    // 包，双击等几乎同时的两次调用都会读到旧的 false 而一起跑、互相打架；ref 在下一行同步写入，第二个调
    // 用能立即读到。
    if (segmentNavigatingRef.current || readOnlyBootstrapRef.current) return false
    const sessionId = segmentSessionIdRef.current
    if (!sessionId || detailId === null) return false
    segmentNavigatingRef.current = true
    setSegmentNavigating(true)
    try {
      if (dirty) {
        setSaving(true)
        let ok: boolean
        try {
          ok = await handleSaveLargeNote(detailId, { silent: true })
        } finally {
          setSaving(false)
        }
        // 保存失败就放弃导航，让用户看到错误再决定（重试保存或复制内容后重开）；不能比较闭包里冻结的旧
        // draftContent/baseline，那样成败结果都一样。
        if (!ok) return false
      }
      setReadOnlyBootstrap(true)
      const res = await vaultApi.call('note_content_segment_get', { session_id: sessionId, ordinal: targetOrdinal })
      if (segmentSessionIdRef.current !== sessionId) return false // 期间用户又切换了笔记/关闭了详情
      if (!res.ok) {
        toast.error(t('loadNoteFailedToast'), { description: translateError(res.error, res.error_params) })
        setReadOnlyBootstrap(false)
        return false
      }
      segmentOrdinalRef.current = targetOrdinal
      setSegmentOrdinal(targetOrdinal)
      setLoadedSegments([
        {
          ordinal: targetOrdinal,
          id: res.segment.id,
          revision: res.segment.revision,
          start: 0,
          end: res.segment.content.length,
          baseline: res.segment.content,
          dirty: false,
        },
      ])
      setDraftContent(res.segment.content)
      await waitForEditorContent(res.segment.content)
      // 等待期间用户可能已切到另一条笔记（session id 变了），此时不能碰 readOnlyBootstrap：新笔记的加载
      // effect 自己管理它，提前置 false 会在新笔记没准备好时放开编辑。调用方见 false 也不会再操作已无关的
      // editorViewRef/loadedSegments。
      if (segmentSessionIdRef.current !== sessionId) return false
      setReadOnlyBootstrap(false)
      return true
    } finally {
      segmentNavigatingRef.current = false
      setSegmentNavigating(false)
    }
  }

  // 分段大笔记的"上一段/下一段"：目标段已在拼接窗口里（滚动过一阵后最常见）就直接滚过去，零请求；不在
  // 窗口里（刚打开未滚动，或已走远）才降级为"快进"，交给 ensureSegmentLoaded。
  async function handleGoToSegment(targetOrdinal: number) {
    // ref 而不是 state——理由跟 ensureSegmentLoaded 开头那句一致：防止两次
    // 几乎同时的调用（比如双击）都在 state 更新生效前读到旧的 false。
    if (segmentNavigatingRef.current || readOnlyBootstrapRef.current) return
    if (targetOrdinal < 0 || targetOrdinal >= segmentCount || targetOrdinal === segmentOrdinal) return
    // 目标段已在懒加载窗口里：直接滚过去，省一次 RPC，也不丢弃窗口里其它已加载的段（不走
    // ensureSegmentLoaded 的推倒重来）。
    const alreadyLoaded = loadedSegments.find((seg) => seg.ordinal === targetOrdinal)
    if (alreadyLoaded) {
      const view = editorViewRef.current
      if (view) {
        reveal(view, { scrollTo: { pos: alreadyLoaded.start, y: 'start', yMargin: 20 } })
      }
      segmentOrdinalRef.current = targetOrdinal
      setSegmentOrdinal(targetOrdinal)
      return
    }
    const ok = await ensureSegmentLoaded(targetOrdinal)
    // ensureSegmentLoaded 成功时真实文档已落位；这里不能读 draftContent（是调用开始时闭包的旧值）。不带
    // expectedContent（expectedLength 传 0）表示不再等，直接按 view 当前内容定位。
    if (ok && detailId !== null) restorePositionForNote(detailId, 0)
  }

  // 把"段内相对光标偏移"应用到编辑器；调用方须先确保 targetOrdinal 已加载（见 ensureSegmentLoaded），
  // 这里只定位。用 EditorView.scrollIntoView 居中到光标，而非复用 scrollRatio：后者是相对旧窗口总高度
  // 的比例，换成形状不同的新窗口后无确定含义。
  function applyPositionWithinSegment(targetOrdinal: number, relativeCursor: number) {
    const view = editorViewRef.current
    if (!view) return
    const seg = loadedSegmentsRef.current.find((s) => s.ordinal === targetOrdinal)
    const pos = Math.min(seg ? seg.start + relativeCursor : relativeCursor, view.state.doc.length)
    reveal(view, {
      selection: { anchor: pos, head: pos },
      marker: pos,
      scrollTo: { pos, y: 'center' },
    })
    const noteId = currentNoteIdRef.current
    if (positionMarkerTimerRef.current) clearTimeout(positionMarkerTimerRef.current)
    positionMarkerTimerRef.current = setTimeout(() => {
      if (currentNoteIdRef.current === noteId) reveal(view, { marker: null })
    }, 2500)
  }

  // 自动保存：停止输入 2 秒后静默落盘，与手动 Ctrl+S/按钮同走 handleSave，互不冲突。大笔记 dirty 是
  // loadedSegments 各段 dirty 的汇总（isLargeNoteContentDirty，由 handleEditorUpdate 增量维护，见
  // LoadedSegment）；draftContent 在依赖数组里，每次敲字重置倒计时。readOnlyBootstrap 期间编辑器不可
  // 编辑，dirty 恒为 false，无需额外判断。
  useEffect(() => {
    if (!dirty || saving) return
    const handle = setTimeout(() => {
      handleSave({ silent: true })
    }, 2000)
    return () => clearTimeout(handle)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- handleSave closes over draft state already reflected by the listed deps (dirty summarizes draftTitle/draftCategory/draftContent/loadedSegments comparisons)
  }, [dirty, draftTitle, draftCategory, draftContent, saving])

  // Ctrl+S 全局监听：详情面板开着且有未保存改动即生效，不限于光标在编辑器内；CodeMirror 获焦时浏览器
  // 原生"保存网页"仍会触发，所以统一 preventDefault 接管。
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 's') return
      if (!creatingNew && detailId === null) return
      e.preventDefault()
      handleSave()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- handleSave closes over draft state that's already reflected in `dirty`/`creatingNew`/`detailId` below
  }, [creatingNew, detailId, dirty, draftTitle, draftCategory, draftContent])

  // 详情面板的置顶/隐藏图标读 detailNote 而非 notes 数组，所以除了乐观更新列表，当前笔记恰是详情笔记
  // 时也要同步 detailNote，否则详情里图标不动。
  async function togglePinned(note: NoteListItem) {
    const nextPinned = !note.is_pinned
    setNotes((prev) => sortNotes(prev.map((n) => (n.id === note.id ? { ...n, is_pinned: nextPinned ? 1 : 0 } : n))))
    setDetailNote((prev) => (prev && prev.id === note.id ? { ...prev, is_pinned: nextPinned ? 1 : 0 } : prev))
    const res = await vaultApi.call('note_set_pinned', { id: note.id, pinned: nextPinned })
    if (!res.ok) {
      toast.error(t('pinFailedToast'), { description: translateError(res.error, res.error_params) })
      setNotes((prev) => sortNotes(prev.map((n) => (n.id === note.id ? { ...n, is_pinned: note.is_pinned } : n))))
      setDetailNote((prev) => (prev && prev.id === note.id ? { ...prev, is_pinned: note.is_pinned } : prev))
    }
  }

  async function toggleHidden(note: NoteListItem) {
    const nextHidden = !note.is_hidden
    setNotes((prev) => prev.map((n) => (n.id === note.id ? { ...n, is_hidden: nextHidden ? 1 : 0 } : n)))
    setDetailNote((prev) => (prev && prev.id === note.id ? { ...prev, is_hidden: nextHidden ? 1 : 0 } : prev))
    const res = await vaultApi.call('note_set_hidden', { id: note.id, hidden: nextHidden })
    if (!res.ok) {
      toast.error(t('hideFailedToast'), { description: translateError(res.error, res.error_params) })
      setNotes((prev) => prev.map((n) => (n.id === note.id ? { ...n, is_hidden: note.is_hidden } : n)))
      setDetailNote((prev) => (prev && prev.id === note.id ? { ...prev, is_hidden: note.is_hidden } : prev))
    }
  }

  // 手动切换笔记 plain/markdown：导入/新建时按后缀自动打的标签可改（见 notes/storage.py 的 format列
  // ）。只对已保存笔记开放（需真实 id 才能调 note_format_set）；未保存草稿维持 plain，不为次要场景维
  // 护"草稿态 format"。
  async function handleToggleFormat(note: NoteListItem) {
    const nextFormat: NoteFormat = note.format === 'markdown' ? 'plain' : 'markdown'
    const res = await vaultApi.call('note_format_set', { id: note.id, format: nextFormat })
    if (!res.ok) {
      toast.error(t('formatChangeFailedToast'), { description: translateError(res.error, res.error_params) })
      return
    }
    setDetailNote((prev) => (prev && prev.id === note.id ? { ...prev, format: nextFormat } : prev))
    setNotes((prev) => prev.map((n) => (n.id === note.id ? { ...n, format: nextFormat } : n)))
  }

  async function handleDelete(note: NoteListItem) {
    setNotes((prev) => prev.filter((n) => n.id !== note.id))
    if (detailId === note.id) handleCloseDetail()
    const res = await vaultApi.call('note_delete', { id: note.id })
    if (!res.ok) {
      toast.error(t('deleteFailedToast'), { description: translateError(res.error, res.error_params) })
      await reload()
      return
    }
    showDeleteUndo([note.id], 1)
  }

  function showDeleteUndo(ids: number[], count: number) {
    if (undoDeleteTimerRef.current !== null) window.clearTimeout(undoDeleteTimerRef.current)
    const toastId = toast.success(t('deletedUndoToast', { count }), {
      duration: 8000,
      action: {
        label: t('undoDeleteButton'),
        onClick: async () => {
          const res = await vaultApi.call('note_restore_bulk', { ids })
          if (!res.ok) {
            toast.error(t('restoreFailedToast'), { description: translateError(res.error, res.error_params) })
            return
          }
          await reload()
          toast.success(t('undoDeleteSuccessToast', { count: res.restored_count }))
        },
      },
    })
    undoDeleteTimerRef.current = window.setTimeout(() => {
      toast.dismiss(toastId)
      undoDeleteTimerRef.current = null
    }, 8000)
  }

  async function handleBulkDelete() {
    const ids = visibleSelectedIds
    if (ids.length === 0) return
    setNotes((prev) => prev.filter((n) => !ids.includes(n.id)))
    if (detailId !== null && ids.includes(detailId)) handleCloseDetail()
    const res = await vaultApi.call('note_delete_bulk', { ids })
    if (!res.ok) {
      toast.error(t('deleteFailedToast'), { description: translateError(res.error, res.error_params) })
      await reload()
      return
    }
    showDeleteUndo(ids, res.deleted_count)
    setSelectedIds(new Set())
  }

  async function handleBulkMoveCategory(category: string) {
    const ids = visibleSelectedIds
    if (ids.length === 0) return
    const res = await vaultApi.call('note_category_move_bulk', { ids, category })
    if (!res.ok) {
      toast.error(t('categoryMoveFailedToast'), { description: translateError(res.error, res.error_params) })
      return
    }
    await reload()
    toast.success(t('bulkCategoryMovedToast', { count: res.updated_count }))
  }

  async function handleBulkSetPinned(pinned: boolean) {
    const ids = visibleSelectedIds
    if (ids.length === 0) return
    setNotes((prev) => sortNotes(prev.map((n) => (ids.includes(n.id) ? { ...n, is_pinned: pinned ? 1 : 0 } : n))))
    setDetailNote((prev) => (prev && ids.includes(prev.id) ? { ...prev, is_pinned: pinned ? 1 : 0 } : prev))
    const res = await vaultApi.call('note_set_pinned_bulk', { ids, pinned })
    if (!res.ok) {
      toast.error(t('pinFailedToast'), { description: translateError(res.error, res.error_params) })
      await reload()
      return
    }
    toast.success(t('bulkPinnedToast', { count: res.updated_count }))
  }

  async function handleBulkSetHidden(hidden: boolean) {
    const ids = visibleSelectedIds
    if (ids.length === 0) return
    setNotes((prev) => prev.map((n) => (ids.includes(n.id) ? { ...n, is_hidden: hidden ? 1 : 0 } : n)))
    setDetailNote((prev) => (prev && ids.includes(prev.id) ? { ...prev, is_hidden: hidden ? 1 : 0 } : prev))
    const res = await vaultApi.call('note_set_hidden_bulk', { ids, hidden })
    if (!res.ok) {
      toast.error(t('hideFailedToast'), { description: translateError(res.error, res.error_params) })
      await reload()
      return
    }
    toast.success(t('bulkHiddenToast', { count: res.updated_count }))
  }

  // 「多选/全选 → 一键移入隐藏分类」走单独的 note_move_to_hidden_bulk，而非前端连调
  // note_set_hidden_bulk + note_category_move_bulk：两步之间失败会留下"已隐藏但分类仍是原可见分类"的
  // 中间态，笔记凭空消失。后端落成一条 UPDATE。
  async function handleBulkMoveToHiddenCategory(category: string) {
    const ids = visibleSelectedIds
    if (ids.length === 0) return
    const res = await vaultApi.call('note_move_to_hidden_bulk', { ids, category })
    if (!res.ok) {
      toast.error(t('moveToHiddenFailedToast'), { description: translateError(res.error, res.error_params) })
      await reload()
      return
    }
    setSelectedIds(new Set())
    await reload()
    await reloadCategories()
    toast.success(
      t('bulkMovedToHiddenToast', {
        count: res.updated_count,
        category: category || t('filterUncategorized'),
      }),
    )
  }

  async function handleRestore(note: NoteListItem) {
    setTrash((prev) => prev.filter((n) => n.id !== note.id))
    const res = await vaultApi.call('note_restore', { id: note.id })
    if (!res.ok) {
      toast.error(t('restoreFailedToast'), { description: translateError(res.error, res.error_params) })
      await reloadTrash()
      return
    }
    toast.success(t('restoredToast'))
    await reload()
  }

  async function handleHardDelete(note: NoteListItem) {
    setDeleteConfirm({ open: true, kind: 'single', id: note.id })
  }

  async function executeHardDelete() {
    const id = deleteConfirm.id!
    setDeleteConfirm({ open: false, kind: 'single' })
    setTrash((prev) => prev.filter((n) => n.id !== id))
    const res = await vaultApi.call('note_hard_delete', { id })
    if (!res.ok) {
      toast.error(t('deleteFailedToast'), { description: translateError(res.error, res.error_params) })
      await reloadTrash()
      return
    }
    toast.success(t('permanentlyDeletedToast'))
  }

  async function handleBulkRestore() {
    const ids = visibleSelectedIds
    if (ids.length === 0) return
    setTrash((prev) => prev.filter((n) => !ids.includes(n.id)))
    const res = await vaultApi.call('note_restore_bulk', { ids })
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
    setTrash((prev) => prev.filter((n) => !ids.includes(n.id)))
    const res = await vaultApi.call('note_hard_delete_bulk', { ids })
    if (!res.ok) {
      toast.error(t('deleteFailedToast'), { description: translateError(res.error, res.error_params) })
      await reloadTrash()
      return
    }
    toast.success(t('bulkPermanentlyDeletedToast', { count: res.deleted_count }))
    setSelectedIds(new Set())
  }

  const scrollParentRef = useRef<HTMLDivElement>(null)
  const rowVirtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => scrollParentRef.current,
    estimateSize: () => 76,
    overscan: 8,
    // 测量缓存按笔记 id 存，不能按下标（同 ClipboardScreen，tests/clipboardVirtualRows 守着）：置顶、改
    // 筛选会让下标变动，默认 getItemKey 是下标，会把量到的行高套到别的条目上，偏移累加后相邻行叠在一起
    // 且不报错。
    getItemKey: useCallback((index: number) => filtered[index]?.id ?? index, [filtered]),
  })

  // 扫描出来的 txt 文件列表也用虚拟滚动——文件夹里 txt 文件数量可能很多
  // （几千上万个），不管多长都只渲染可见区域，不会因为列表长就卡顿。
  const scanScrollParentRef = useRef<HTMLDivElement>(null)
  const scanRowVirtualizer = useVirtualizer({
    count: filteredScanFiles.length,
    getScrollElement: () => scanScrollParentRef.current,
    estimateSize: () => 60,
    overscan: 10,
    // 同上：这份列表在搜索框里每敲一个字就整体重排，下标当键必错。路径是
    // 扫描结果里天然唯一的键。
    getItemKey: useCallback((index: number) => filteredScanFiles[index]?.path ?? index, [filteredScanFiles]),
  })

  // ---- 时间线 / 批量修改 / 去重：三个对话框共用的收尾 ----

  // 这三件事都在后端直接改笔记。编辑框里还有没存的改动时先存盘，否则后端改完、
  // 右栏再把旧草稿存回去，刚才那一步就被悄悄盖掉了。
  async function saveBeforeBatch(): Promise<boolean> {
    if (!dirty) return true
    return handleSave({ silent: true })
  }

  async function refreshAfterBatch() {
    await Promise.all([reload(), reloadTrash()])
    if (detailId !== null) setDetailReloadKey((k) => k + 1)
  }

  // 对比「与当前版本」要读当前正文。超过快照上限的那种大笔记，那一版本来就没存
  // 正文，读回几 MB 也没有东西可比，直接说不能比。
  async function loadCurrentNoteContent(noteId: number): Promise<string | null> {
    const item = notes.find((n) => n.id === noteId) ?? trash.find((n) => n.id === noteId)
    if ((item?.content_length ?? 0) > REVISION_CONTENT_LIMIT_BYTES) return null
    const res = await vaultApi.call('note_get', { id: noteId })
    return res.ok ? res.note.content : null
  }

  // 成功提示由时间线对话框自己弹（它知道恢复的是哪个时间点），这里只管刷新。
  function handleRevisionRestored(note: Note) {
    void refreshAfterBatch()
    if (detailId !== note.id) handleOpenExisting(note.id)
  }

  /** 批量类改动的提示条都带一个「撤销」：整批退回到这一批之前。 */
  function toastWithBatchUndo(message: string, batchId: string) {
    toast.success(message, {
      duration: 10_000,
      action: {
        label: t('batchUndoButton'),
        onClick: () => {
          void (async () => {
            if (!(await saveBeforeBatch())) return
            const res = await vaultApi.call('note_batch_undo', { batch_id: batchId })
            if (!res.ok) {
              toast.error(t('timelineBatchUndoFailedToast'), { description: translateError(res.error, res.error_params) })
              return
            }
            toast.success(t('timelineBatchUndoneToast', { count: res.restored_count }))
            await refreshAfterBatch()
          })()
        },
      },
    })
  }

  // 「全部笔记的时间线」只列当前范围的笔记：note_timeline 不带 id 时会连隐藏笔记标题和改动摘要一起
  // 给，在「活跃」范围直接调等于绕开解锁；已在「总计」范围（进入时过了验证）才真要全部。
  function timelineForScope(): NoteTimelineTarget {
    if (noteScope === 'all') return { kind: 'all' }
    return { kind: 'notes', noteIds: [...notes, ...trash].filter(noteInScope).map((n) => n.id) }
  }

  async function openDuplicates(scope: NoteCategoryScope) {
    // 扫隐藏笔记会把它们的标题列出来，跟切到「已隐藏」是同一道门。
    if (scope === 'hidden' && noteScope === 'active' && !(await ensureFreshlyUnlocked())) return
    setDedupeScope(scope)
  }

  // 一行顶栏：本页全部功能收在这一行（原因见 TopBar.tsx 顶部），左栏只剩笔记列表（原图标工具栏 + 分类
  // 芯片 + 全选行展开时占 780px）。
  const isTrash = viewMode === 'trash'
  const selectedCount = visibleSelectedIds.length
  const needSelection = selectedCount === 0
  const selectionHint = needSelection ? t('bulkNeedsSelectionHint') : t('bulkAppliesToSelected', { count: selectedCount })
  // 改正文的批量动作（查找替换、加开头结尾）没勾选时作用于当前列表全部笔记（最常见用法是"把这个分类里
  // 所有 A 换成 B"）；说明里写明是哪种，免得用户以为只改了一篇。
  const bulkTextIds = needSelection ? filtered.map((n) => n.id) : visibleSelectedIds
  const bulkTextHint = needSelection
    ? t('bulkAppliesToFiltered', { count: filtered.length })
    : t('bulkAppliesToSelected', { count: selectedCount })

  // 编辑区的分类选择按这篇笔记在哪个池子里给树（普通 / 隐藏两套目录互相独立）；
  // 「移入隐藏分类」也用隐藏那一棵。
  const normalCategoryTree = useMemo(
    () => buildCategoryTree(categoryOptionsNormal, categoryComparator),
    [categoryOptionsNormal, categoryComparator],
  )
  const hiddenCategoryTree = useMemo(
    () => buildCategoryTree(categoryOptionsHidden, categoryComparator),
    [categoryOptionsHidden, categoryComparator],
  )

  const categoryFilterLabel =
    categoryFilter === 'all'
      ? t('filterAllCategories')
      : categoryFilter === 'uncategorized'
        ? t('filterUncategorized')
        : categoryPathLabel(categoryFilter, categoryLabelFor)

  function moveTargetNodes(
    tree: CategoryTreeNode[],
    idPrefix: string,
    onPick: (category: string) => void,
  ): TopBarNode[] {
    return [
      { id: `${idPrefix}-none`, type: 'item', label: t('filterUncategorized'), icon: Inbox, onSelect: () => onPick('') },
      { id: `${idPrefix}-sep`, type: 'separator' },
      ...categoryTreeToNodes(tree, {
        idPrefix,
        onSelect: onPick,
        iconFor: categoryIconFor,
        labelFor: categoryLabelFor,
        selfLabel: (label) => t('categoryPickerChooseSelf', { name: label }),
      }),
    ]
  }

  /** 最近用过 / 收藏的文件夹，点一下直接用，不再弹系统对话框。 */
  function recentFolderNodes(scope: PathMemoryScope, onPick: (dir: string) => void): TopBarNode[] {
    const memory = getScopeMemory(scope)
    const dirs = [...memory.favorites, ...memory.recent.filter((dir) => !memory.favorites.includes(dir))]
    if (dirs.length === 0) return [{ id: `${scope}-dirs-empty`, type: 'label', label: t('recentFoldersEmpty') }]
    return dirs.map(
      (dir): TopBarNode => ({
        id: `${scope}-dir-${dir}`,
        type: 'item',
        label: basenameOf(dir) || dir,
        description: dir,
        icon: memory.favorites.includes(dir) ? Star : FolderOpen,
        onSelect: () => onPick(dir),
      }),
    )
  }

  const scopeValue = isTrash
    ? t('statTrashedLabel')
    : noteScope === 'all'
      ? t('statTotalLabel')
      : noteScope === 'hidden'
        ? t('statHiddenLabel')
        : t('statActiveLabel')

  function pickScope(next: NoteScope) {
    setViewMode('active')
    void changeNoteScope(next)
  }

  const filterValue = [pinnedOnly ? t('pinnedOnlyFilter') : null, tagFilter !== 'all' ? `#${tagFilter}` : null]
    .filter(Boolean)
    .join(' · ')

  const topBarMenus: TopBarMenu[] = [
    {
      // 列表范围跟左边四块数字是同一件事的两个入口：数字点一下直达，菜单里能看到
      // 全部选项和各自的条数。切到会露出隐藏笔记的范围照样走 changeNoteScope 的验证。
      id: 'view',
      label: t('toolbarGroupView'),
      icon: PanelsTopLeft,
      value: scopeValue,
      active: isTrash || noteScope !== 'active',
      onClear: () => pickScope('active'),
      items: [
        { id: 'scope-active', type: 'item', label: t('statActiveLabel'), icon: NotebookText, count: noteStats.active, selected: !isTrash && noteScope === 'active', onSelect: () => pickScope('active') },
        { id: 'scope-hidden', type: 'item', label: t('statHiddenLabel'), icon: EyeOff, count: noteStats.hidden, selected: !isTrash && noteScope === 'hidden', onSelect: () => pickScope('hidden') },
        { id: 'scope-all', type: 'item', label: t('statTotalLabel'), icon: LayoutGrid, count: noteStats.total, selected: !isTrash && noteScope === 'all', onSelect: () => pickScope('all') },
        { id: 'scope-trash', type: 'item', label: t('trashButton'), icon: Trash2, count: noteStats.trashed, selected: isTrash, onSelect: () => setViewMode('trash') },
        { id: 'view-sep', type: 'separator' },
        { id: 'list-collapsed', type: 'toggle', label: t('collapseListButton'), checked: listCollapsed, onCheckedChange: changeListCollapsed },
      ],
    },
    {
      // 分类可以一层层往下展开（Internet ▸ Node ▸ …），层数由数据决定；点父节点连
      // 子分类一起筛，见 categoryMatchesFilter。当前选中的路径直接写在触发器上。
      id: 'category',
      label: t('categoryTreeHeading'),
      icon: Layers,
      hidden: isTrash,
      value: categoryFilterLabel,
      active: categoryFilter !== 'all',
      onClear: () => setCategoryFilter('all'),
      contentClassName: 'min-w-60',
      items: [
        { id: 'cat-all', type: 'item', label: t('filterAllCategories'), icon: LayoutGrid, selected: categoryFilter === 'all', onSelect: () => setCategoryFilter('all') },
        { id: 'cat-uncategorized', type: 'item', label: t('filterUncategorized'), icon: Inbox, hidden: !hasUncategorized, selected: categoryFilter === 'uncategorized', onSelect: () => setCategoryFilter('uncategorized') },
        { id: 'cat-sep', type: 'separator' },
        ...categoryTreeToNodes(categoryTree, {
          idPrefix: 'cat',
          selected: categoryFilter,
          onSelect: setCategoryFilter,
          countFor: (path) => categoryStats.get(path)?.count ?? 0,
          iconFor: categoryIconFor,
          labelFor: categoryLabelFor,
          selfLabel: (label) => t('categoryIncludingChildren', { name: label }),
        }),
        { id: 'cat-sep2', type: 'separator' },
        {
          id: 'cat-sort',
          type: 'submenu',
          label: t('categorySortLabel'),
          icon: ArrowUpDown,
          children: CATEGORY_SORT_MODES.map(
            (mode): TopBarNode => ({
              id: `cat-sort-${mode}`,
              type: 'item',
              label: t(`categorySortMode.${mode}`),
              selected: categoryPrefs.sortMode === mode,
              onSelect: () => updateCategoryPrefs({ ...categoryPrefs, sortMode: mode }),
            }),
          ),
        },
        { id: 'cat-manage', type: 'item', label: t('manageCategoriesButton'), icon: Tags, onSelect: handleOpenCategoryManager },
      ],
    },
    {
      id: 'filter',
      label: t('toolbarGroupFilter'),
      icon: Filter,
      hidden: isTrash,
      value: filterValue || undefined,
      active: filterValue !== '',
      onClear: () => {
        setPinnedOnly(false)
        setTagFilter('all')
      },
      items: [
        { id: 'pinned-only', type: 'toggle', label: t('pinnedOnlyFilter'), checked: pinnedOnly, onCheckedChange: setPinnedOnly },
        {
          id: 'tags',
          type: 'submenu',
          label: t('tagsLabel'),
          icon: Hash,
          count: scopedTags.length,
          active: tagFilter !== 'all',
          children: [
            { id: 'tag-all', type: 'item', label: t('filterAllTags'), selected: tagFilter === 'all', onSelect: () => setTagFilter('all') },
            { id: 'tag-sep', type: 'separator' },
            ...(scopedTags.length === 0
              ? [{ id: 'tag-none', type: 'label', label: t('noTagsYet') } satisfies TopBarNode]
              : scopedTags.map(
                  (tag): TopBarNode => ({
                    id: `tag-${tag.id}`,
                    type: 'item',
                    label: tag.name,
                    icon: Hash,
                    selected: tagFilter === tag.name,
                    onSelect: () => setTagFilter(tag.name),
                  }),
                )),
          ],
        },
        { id: 'filter-sep', type: 'separator' },
        { id: 'manage-tags', type: 'item', label: t('manageTagsButton'), icon: Tags, onSelect: () => setTagManagerOpen(true) },
      ],
    },
    {
      id: 'sort',
      label: t('noteSortLabel'),
      icon: ArrowUpDown,
      hidden: isTrash,
      value: t(`noteSortMode.${noteSortMode}`),
      items: LIST_NOTE_SORT_MODES.map(
        (mode): TopBarNode => ({
          id: `sort-${mode}`,
          type: 'item',
          label: t(`noteSortMode.${mode}`),
          selected: noteSortMode === mode,
          onSelect: () => changeNoteSortMode(mode),
        }),
      ),
    },
    {
      // 批量动作作用于**看得见的**已选笔记（visibleSelectedIds）；要先勾选的项在
      // 没选时灰掉并说明原因。改正文的两项例外，见上面 bulkTextIds。
      id: 'bulk',
      label: t('menuBulk'),
      icon: ListChecks,
      value: selectedCount > 0 ? t('selectedCountLabel', { count: selectedCount }) : undefined,
      active: selectedCount > 0,
      onClear: () => setSelectedIds(new Set()),
      contentClassName: 'min-w-64',
      items: [
        { id: 'select-all', type: 'item', label: t('selectAllLabel'), icon: SquareCheck, count: filtered.length, disabled: filtered.length === 0 || allFilteredSelected, onSelect: () => toggleSelectAll(true) },
        { id: 'select-none', type: 'item', label: t('clearSelectionLabel'), icon: Square, disabled: needSelection, onSelect: () => toggleSelectAll(false) },
        { id: 'bulk-sep1', type: 'separator' },
        // ---- 回收站视图 ----
        { id: 'bulk-restore', type: 'item', label: t('restoreSelectedButton'), icon: RotateCcw, hidden: !isTrash, disabled: needSelection, onSelect: () => void handleBulkRestore() },
        { id: 'bulk-hard-delete', type: 'item', label: t('permanentlyDeleteSelectedButton'), icon: Trash2, destructive: true, hidden: !isTrash, disabled: needSelection, onSelect: () => void handleBulkHardDelete() },
        // ---- 笔记视图：改正文 ----
        { id: 'bulk-replace', type: 'item', label: t('bulkReplaceMenuItem'), icon: Replace, hidden: isTrash, description: bulkTextHint, disabled: bulkTextIds.length === 0, onSelect: () => setBulkEdit({ op: 'replace', noteIds: bulkTextIds }) },
        { id: 'bulk-affix', type: 'item', label: t('bulkAffixMenuItem'), icon: TextCursorInput, hidden: isTrash, description: bulkTextHint, disabled: bulkTextIds.length === 0, onSelect: () => setBulkEdit({ op: 'prepend', noteIds: bulkTextIds }) },
        { id: 'bulk-sep2', type: 'separator' },
        // ---- 笔记视图：改属性 ----
        { id: 'bulk-pin', type: 'item', label: t('bulkPinButton'), icon: Pin, hidden: isTrash, description: needSelection ? selectionHint : undefined, disabled: needSelection, onSelect: () => void handleBulkSetPinned(true) },
        { id: 'bulk-unpin', type: 'item', label: t('bulkUnpinButton'), icon: PinOff, hidden: isTrash, disabled: needSelection, onSelect: () => void handleBulkSetPinned(false) },
        { id: 'bulk-hide', type: 'item', label: t('bulkHideButton'), icon: EyeOff, hidden: isTrash, disabled: needSelection, onSelect: () => void handleBulkSetHidden(true) },
        { id: 'bulk-unhide', type: 'item', label: t('bulkUnhideButton'), icon: Eye, hidden: isTrash, disabled: needSelection, onSelect: () => void handleBulkSetHidden(false) },
        {
          id: 'bulk-tag',
          type: 'submenu',
          label: t('bulkTagButton'),
          icon: Hash,
          hidden: isTrash || scopedTags.length === 0,
          disabled: needSelection,
          children: scopedTags.map(
            (tag): TopBarNode => ({ id: `bulk-tag-${tag.id}`, type: 'item', label: tag.name, icon: Hash, onSelect: () => void handleBulkAddTag(tag.id) }),
          ),
        },
        {
          id: 'bulk-move',
          type: 'submenu',
          label: t('bulkMoveCategoryButton'),
          icon: FolderOpen,
          hidden: isTrash,
          disabled: needSelection,
          children: moveTargetNodes(categoryTree, 'bulk-move', (category) => void handleBulkMoveCategory(category)),
        },
        {
          // 「移入隐藏分类」：隐藏 + 归类一步到位，列的是隐藏区自己那套分类目录。
          id: 'bulk-move-hidden',
          type: 'submenu',
          label: t('bulkMoveToHiddenButton'),
          icon: Lock,
          hidden: isTrash,
          disabled: needSelection,
          children: moveTargetNodes(hiddenCategoryTree, 'bulk-move-hidden', (category) => void handleBulkMoveToHiddenCategory(category)),
        },
        { id: 'bulk-sep3', type: 'separator' },
        { id: 'bulk-export', type: 'item', label: t('exportSelectedButton'), icon: Download, hidden: isTrash, disabled: needSelection || exporting, onSelect: () => void handleExportSelected() },
        {
          id: 'bulk-export-recent',
          type: 'submenu',
          label: t('exportToRecentFolderMenuItem'),
          icon: FolderOpen,
          hidden: isTrash,
          disabled: needSelection || exporting,
          children: recentFolderNodes('export', (dir) => void handleExportSelected(dir)),
        },
        { id: 'bulk-sep4', type: 'separator' },
        { id: 'bulk-delete', type: 'item', label: t('deleteSelectedButton'), icon: Trash2, destructive: true, hidden: isTrash, disabled: needSelection, onSelect: () => void handleBulkDelete() },
      ],
    },
    {
      id: 'dedupe',
      label: t('menuDedupe'),
      icon: CopyCheck,
      hidden: isTrash,
      items: [
        { id: 'dedupe-normal', type: 'item', label: t('dedupeNormalMenuItem'), icon: CopyCheck, description: t('dedupeScanHint'), onSelect: () => void openDuplicates('normal') },
        { id: 'dedupe-hidden', type: 'item', label: t('dedupeHiddenMenuItem'), icon: Lock, onSelect: () => void openDuplicates('hidden') },
      ],
    },
    {
      id: 'timeline',
      label: t('menuTimeline'),
      icon: History,
      items: [
        {
          id: 'timeline-current',
          type: 'item',
          label: t('timelineCurrentMenuItem'),
          icon: NotebookText,
          description: detailNote?.title || undefined,
          hidden: creatingNew || !detailNote,
          onSelect: () => detailNote && setTimelineTarget({ kind: 'note', noteId: detailNote.id, title: detailNote.title }),
        },
        {
          id: 'timeline-selected',
          type: 'item',
          label: t('timelineSelectedMenuItem'),
          icon: ListChecks,
          description: selectionHint,
          disabled: needSelection,
          onSelect: () => setTimelineTarget({ kind: 'notes', noteIds: [...visibleSelectedIds] }),
        },
        { id: 'timeline-all', type: 'item', label: t('timelineAllMenuItem'), icon: History, onSelect: () => setTimelineTarget(timelineForScope()) },
      ],
    },
    {
      id: 'data',
      label: t('toolbarGroupActions'),
      icon: Upload,
      hidden: isTrash,
      items: [
        { id: 'new', type: 'item', label: t('newNoteButton'), icon: Plus, onSelect: handleOpenNew },
        { id: 'data-sep', type: 'separator' },
        { id: 'import', type: 'item', label: importing ? t('importingLabel') : t('importButton'), icon: Upload, disabled: importing, onSelect: () => void handleImportFiles() },
        { id: 'import-folder', type: 'item', label: t('folderImportButton'), icon: FolderOpen, onSelect: () => void handleOpenFolderImport() },
        {
          id: 'import-recent',
          type: 'submenu',
          label: t('pathHistoryButton'),
          icon: History,
          children: recentFolderNodes('import', (dir) => void handleOpenFolderImport(dir)),
        },
      ],
    },
  ]

  return (
    <div
      className={cn(
        // 有界 flex 列，同 PageShell 的 fill 档（本页没套 PageShell）：`<main>` 是 overflow-hidden 定高盒
        // 子，不声明高度会裁掉下半截。用 `flex-1` 而非 `h-full`：main 里还压着「接着刚才」横幅，h-full 会比
        // 容器高出横幅高度导致底部被裁；flex-1 取剩余高度。pt-4 对齐 PageShell（见 page.tsx）。
        'ds-page-wash flex min-h-0 w-full max-w-none flex-1 flex-col gap-4 px-8 pt-4 pb-7',
        fullscreen && 'p-0',
      )}
      onDragOver={(event) => event.preventDefault()}
      onDrop={handleDropFiles}
    >
      {/* 跟其它面板共用 <PageHeader>。这里原本是第四份手抄
          （items-center gap-3.5 pb-4），跟 PageHeader 的 items-start/pb-5 又差
          一档——四个面板四种写法，正是「切过去标题会跳一下」的来源。 */}
      {!fullscreen && (
        <div className="shrink-0">
          <PageHeader title={viewMode === 'trash' ? t('trashTitle') : t('pageTitle')} />
          {/* 一行顶栏。左端四块数字都是**入口**，不是摆设：点哪一块，列表就切成那一块
              数出来的那批笔记。两件事要一起做对，缺一条都还是"点了没反应"：
              ① 「总计」和「已隐藏」都会让隐藏笔记出现在屏幕上 → 都要先过一次
                 ensureFreshlyUnlocked（见 changeNoteScope）。判据是"会不会露出隐藏
                 内容"，不是名字里有没有 hidden。
              ② 回收站视图下也要渲染这一排，否则点「回收站」之后四个框整排消失，
                 再也点不回来。
              它们跟着顶栏走：列表折不折叠都在，只有全屏时才一起隐藏。 */}
          <TopBar
            className="border-b border-border/70 pb-3"
            leading={
              !loading && noteStats.total + noteStats.trashed > 0 ? (
                <>
                  <StatTile
                    compact
                    label={t('statTotalLabel')}
                    value={noteStats.total}
                    hint={t('statTotalHint')}
                    active={viewMode === 'active' && noteScope === 'all'}
                    onClick={() => {
                      setViewMode('active')
                      void changeNoteScope('all')
                    }}
                  />
                  <StatTile
                    compact
                    label={t('statActiveLabel')}
                    value={noteStats.active}
                    hint={t('statActiveHint')}
                    active={viewMode === 'active' && noteScope === 'active'}
                    onClick={() => {
                      setViewMode('active')
                      void changeNoteScope('active')
                    }}
                  />
                  <StatTile
                    compact
                    label={t('statHiddenLabel')}
                    value={noteStats.hidden}
                    hint={t('statHiddenHint')}
                    active={viewMode === 'active' && noteScope === 'hidden'}
                    onClick={() => {
                      setViewMode('active')
                      void changeNoteScope('hidden')
                    }}
                  />
                  <StatTile
                    compact
                    label={t('statTrashedLabel')}
                    value={noteStats.trashed}
                    hint={t('statTrashedHint')}
                    active={viewMode === 'trash'}
                    onClick={() => setViewMode(viewMode === 'trash' ? 'active' : 'trash')}
                  />
                </>
              ) : undefined
            }
            menus={topBarMenus}
            // 展开/收起笔记列表管的是整个左栏，是全页作用域的开关，放在顶栏最右端；
            // 放进左栏的话一收起来它自己也没了，就再也展不开。
            trailing={
              <>
                <TopBarSearch id="note-search" value={search} onChange={setSearch} placeholder={t('searchPlaceholder')} />
                {!isTrash && (
                  <Button size="sm" onClick={handleOpenNew}>
                    <Plus className="size-4" aria-hidden="true" />
                    {t('newNoteButton')}
                  </Button>
                )}
                <ActionButton
                  label={listCollapsed ? t('expandListButton') : t('collapseListButton')}
                  icon={listCollapsed ? PanelLeftOpen : PanelLeftClose}
                  region={LABEL_REGIONS.notesToolbar}
                  variant="outline"
                  active={!listCollapsed}
                  onClick={() => changeListCollapsed(!listCollapsed)}
                />
              </>
            }
          />
        </div>
      )}

      {/* 左右分栏：列表在左（可折叠）、详情/编辑区始终占据右侧主视觉位置
          （"C位"），不选中任何笔记时右侧显示占位提示而不是消失/被挤没。
          窄屏幕（lg 断点以下）退化为纵向堆叠。全屏模式下把列表和折叠按钮
          整个隐藏，编辑框占满窗口。 */}
      {/* 左选右看，走全应用共用的 <Workbench>。这里以前是就地写死的
          `lg:w-[360px]` + `lg:flex-1`，密码页写的是 45%、恢复密钥页写的是 w-80——
          同一件事三个界面三种比例、三种窄窗口表现。收起按钮留在工作台外面：
          放进左栏的话，一收起来它自己也没了，就再也展不开。 */}
        <Workbench
          className="min-w-0 flex-1"
          listWidth="wide"
          listCollapsed={listCollapsed || fullscreen}
          selected={creatingNew || detailId !== null}
          onBack={handleCloseDetail}
          backLabel={tCommon('backToList')}
          placeholder={
            <EmptyState icon={NotebookText} title={t('detailEmptyState')} className="m-6" />
          }
          list={
            <>
              {/* flex 列而不是 space-y：列表要 flex-1 吃掉剩余高度，
                  而 space-y 只管间距，给不了"谁来占满"这件事一个答案。 */}
              <div className="flex h-full min-h-0 w-full flex-col gap-3 p-3">
            {/* 搜索、筛选、分类、全选和批量动作都搬进了顶栏；已选几篇写在顶栏「批量」
                的触发器上。这一栏只剩列表本身。 */}
            {loading && <p className="text-sm text-muted-foreground">{t('loading')}</p>}
            {!loading && loadError && (
              <div className="flex flex-col items-center gap-3 py-12">
                <p className="text-sm text-destructive">{loadError}</p>
                <Button variant="outline" size="sm" onClick={() => { setLoading(true); setLoadError(null); reload() }}>
                  {t('retryButton')}
                </Button>
              </div>
            )}
            {!loading && !loadError && filtered.length === 0 && (
              <p className="text-sm text-muted-foreground">{viewMode === 'trash' ? t('trashEmpty') : t('emptyList')}</p>
            )}
            {viewMode === 'trash' && <p className="text-sm text-muted-foreground">{t('trashRetentionHint', { days: 7 })}</p>}
            {/* 回收站里有隐藏笔记被扣着不显示时必须说一声。不说的话用户看到的是
                「回收站 9」却只列出 6 条，会以为东西丢了——扣住内容是对的，
                悄悄扣住不是。这句只报数量，不泄露任何标题。 */}
            {viewMode === 'trash' && hiddenTrashedWithheld > 0 && (
              <p className="text-sm text-muted-foreground">
                {t('trashHiddenWithheldHint', { count: hiddenTrashedWithheld })}
              </p>
            )}

            {/* 这四块统计数字搬到页面标题行里去了（见本文件上方的 <PageHeader
                metrics=…>）。留在这里的话，列表一折叠它们就整排消失。 */}

            {/* 列表吃掉左栏剩下的全部高度，不再是写死的 `h-64`（256px）。
                实测左栏有 890px，列表只用 256px——下面 300 多像素是空的，
                而列表里还有 22 条笔记没地方显示。这就是"上下都为空白"在这一页
                的形态：不是留白设计得多，是一个 2023 年写下的固定高度再没跟着
                窗口变过。`min-h-0` 不能省，否则 flex 子项不肯收缩到内容以下，
                overflow-y-auto 不生效。 */}
            {!loading && filtered.length > 0 && (
              <div ref={scrollParentRef} className="min-h-0 flex-1 overflow-y-auto rounded border">
                <div style={{ height: rowVirtualizer.getTotalSize(), position: 'relative' }}>
                  {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                    const note = filtered[virtualRow.index]
                    return (
                      <div
                        key={virtualRow.key}
                        ref={rowVirtualizer.measureElement}
                        data-index={virtualRow.index}
                        style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${virtualRow.start}px)` }}
                        className="p-1"
                      >
                        {viewMode === 'trash' ? (
                          <NoteRow
                            note={note}
                            selected={selectedIds.has(note.id)}
                            onToggleSelected={(checked) => toggleSelected(note.id, checked)}
                            onRestore={() => handleRestore(note)}
                            onHardDelete={() => handleHardDelete(note)}
                          />
                        ) : (
                          <NoteRow
                            note={note}
                            isDetailActive={detailId === note.id}
                            selected={selectedIds.has(note.id)}
                            onOpenDetail={() => handleOpenExisting(note.id)}
                            onToggleSelected={(checked) => toggleSelected(note.id, checked)}
                            onTogglePinned={() => togglePinned(note)}
                            onToggleHidden={() => toggleHidden(note)}
                            onDelete={() => handleDelete(note)}
                          />
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
              </div>
            </>
          }
          detail={
            <div
              className={cn(
                'min-w-0 p-4',
                // 全屏时脱离文档流盖住整个窗口。这一层放在工作台的右栏里没有副作用：
                // fixed 之后它已经不占布局，背后的工作台画不画都看不见。
                fullscreen && 'fixed inset-0 z-50 w-full overflow-y-auto bg-background p-6',
              )}
            >
            <div className="space-y-3">
              {detailLoading ? (
                <p className="text-sm text-muted-foreground">{t('loadingNote')}</p>
              ) : (
                <>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1 space-y-2">
                      <Input
                        value={draftTitle}
                        onChange={(e) => setDraftTitle(e.target.value)}
                        placeholder={t('titlePlaceholder')}
                        className="text-sihao font-medium"
                      />
                      {/* 分类、标签收成两颗按钮，点开是跟顶栏「分类」同一棵级联树。原来这里是
                          一个输入框 + 十几颗分类芯片 + 一整行标签芯片，实测把正文往下推了 130px，
                          子分类也只能平铺成带斜杠的长名字。 */}
                      <div className="flex flex-wrap items-center gap-1.5">
                        <NoteCategoryPicker
                          value={draftCategory}
                          onChange={setDraftCategory}
                          tree={!creatingNew && detailNote?.is_hidden ? hiddenCategoryTree : normalCategoryTree}
                          iconFor={categoryIconFor}
                          labelFor={categoryLabelFor}
                        />
                        {!creatingNew && detailNote && (
                          <>
                            <NoteTagPicker
                              tags={detailNote.is_hidden ? hiddenTags : normalTags}
                              selectedIds={detailTagIds}
                              onChange={handleSetDetailTags}
                            />
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              onClick={() => setTimelineTarget({ kind: 'note', noteId: detailNote.id, title: detailNote.title })}
                            >
                              <History className="size-4" aria-hidden="true" />
                              {t('timelineButton')}
                            </Button>
                          </>
                        )}
                      </div>
                      {!creatingNew && detailNote && titleMentions.length > 0 && (
                        <div className="flex flex-wrap items-center gap-1">
                          <span className="text-sm text-muted-foreground">
                            {t('titleMentionsLabel', { count: titleMentions.length })}
                          </span>
                          {titleMentions.map((n) => (
                            <Button
                              key={n.id}
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={() => handleOpenExisting(n.id)}
                            >
                              {n.title}
                            </Button>
                          ))}
                        </div>
                      )}
                    </div>
                    <IconToolbar
                      storageKey="notes-detail"
                      labelRegion={LABEL_REGIONS.notesDetailToolbar}
                      align="end"
                      defaultOpenGroupIds={['view']}
                      className="min-w-0"
                      groups={[
                        {
                          id: 'view',
                          label: t('toolbarGroupView'),
                          icon: PanelsTopLeft,
                          items: [
                            {
                              id: 'md-source',
                              label: t('markdownSourceViewButton'),
                              icon: FileCode,
                              active: markdownViewMode === 'source',
                              hidden: !(currentFormat === 'markdown' && !readOnlyBootstrap && !isLargeNote),
                              onClick: () => changeMarkdownViewMode('source'),
                            },
                            {
                              id: 'md-preview',
                              label: t('markdownPreviewViewButton'),
                              icon: BookOpen,
                              active: markdownViewMode === 'preview',
                              hidden: !(currentFormat === 'markdown' && !readOnlyBootstrap && !isLargeNote),
                              onClick: () => changeMarkdownViewMode('preview'),
                            },
                            {
                              id: 'md-split',
                              label: t('markdownSplitViewButton'),
                              icon: Columns2,
                              active: markdownViewMode === 'split',
                              hidden: !(currentFormat === 'markdown' && !readOnlyBootstrap && !isLargeNote),
                              onClick: () => changeMarkdownViewMode('split'),
                            },
                            {
                              id: 'chapters',
                              label: chaptersOpen ? t('chaptersHideButton') : t('chaptersShowButton'),
                              icon: List,
                              active: chaptersOpen,
                              hidden: chapters.length === 0 || !isProfessional,
                              onClick: () => changeChaptersOpen(!chaptersOpen),
                            },
                            {
                              id: 'find',
                              label: t('findButtonTooltip'),
                              icon: Search,
                              active: findPanelOpen,
                              hidden: readOnlyBootstrap,
                              onClick: () => (findPanelOpen ? closeFindPanel() : openFindPanel(false)),
                            },
                            {
                              id: 'fullscreen',
                              label: fullscreen ? t('exitFullscreenButton') : t('fullscreenButton'),
                              icon: fullscreen ? Minimize2 : Maximize2,
                              active: fullscreen,
                              onClick: () => setFullscreen((v) => !v),
                            },
                          ],
                        },
                        {
                          id: 'font',
                          label: t('toolbarGroupFont'),
                          icon: Type,
                          items: [
                            {
                              id: 'font-controls',
                              label: t('toolbarGroupFont'),
                              node: (
                                <>
                                  <Select value={editorFont} onValueChange={(v) => changeEditorFont(v as EditorFont)}>
                                    <Tooltip>
                                      <TooltipTrigger asChild>
                                        <SelectTrigger className="w-[104px]">
                                          <SelectValue />
                                        </SelectTrigger>
                                      </TooltipTrigger>
                                      <TooltipContent>{t('editorFontLabel')}</TooltipContent>
                                    </Tooltip>
                                    <SelectContent>
                                      <SelectItem value="default">{t('editorFontDefault')}</SelectItem>
                                      <SelectItem value="mono">{t('editorFontMono')}</SelectItem>
                                      <SelectItem value="serif">{t('editorFontSerif')}</SelectItem>
                                      <SelectItem value="rounded">{t('editorFontRounded')}</SelectItem>
                                    </SelectContent>
                                  </Select>
                                  <div className="flex items-center gap-0.5">
                                    <Tooltip>
                                      <TooltipTrigger asChild>
                                        <Button
                                          size="sm"
                                          variant="outline"
                                          className="px-2"
                                          disabled={editorFontSize <= EDITOR_FONT_SIZES[0]}
                                          onClick={() =>
                                            changeEditorFontSize(EDITOR_FONT_SIZES[Math.max(0, EDITOR_FONT_SIZES.indexOf(editorFontSize) - 1)])
                                          }
                                        >
                                          -
                                        </Button>
                                      </TooltipTrigger>
                                      <TooltipContent>{t('editorFontSizeDecrease')}</TooltipContent>
                                    </Tooltip>
                                    <span className="w-7 text-center text-sm tabular">{editorFontSize}</span>
                                    <Tooltip>
                                      <TooltipTrigger asChild>
                                        <Button
                                          size="sm"
                                          variant="outline"
                                          className="px-2"
                                          disabled={editorFontSize >= EDITOR_FONT_SIZES[EDITOR_FONT_SIZES.length - 1]}
                                          onClick={() =>
                                            changeEditorFontSize(
                                              EDITOR_FONT_SIZES[Math.min(EDITOR_FONT_SIZES.length - 1, EDITOR_FONT_SIZES.indexOf(editorFontSize) + 1)],
                                            )
                                          }
                                        >
                                          +
                                        </Button>
                                      </TooltipTrigger>
                                      <TooltipContent>{t('editorFontSizeIncrease')}</TooltipContent>
                                    </Tooltip>
                                  </div>
                                  <Select value={String(editorFontWeight)} onValueChange={(v) => changeEditorFontWeight(Number(v) as EditorFontWeight)}>
                                    <Tooltip>
                                      <TooltipTrigger asChild>
                                        <SelectTrigger className="w-[92px]">
                                          <SelectValue />
                                        </SelectTrigger>
                                      </TooltipTrigger>
                                      <TooltipContent>{t('editorFontWeightLabel')}</TooltipContent>
                                    </Tooltip>
                                    <SelectContent>
                                      <SelectItem value="400">{t('editorFontWeightRegular')}</SelectItem>
                                      <SelectItem value="500">{t('editorFontWeightMedium')}</SelectItem>
                                      <SelectItem value="600">{t('editorFontWeightSemibold')}</SelectItem>
                                    </SelectContent>
                                  </Select>
                                </>
                              ),
                            },
                          ],
                        },
                        {
                          id: 'note',
                          label: t('toolbarGroupNote'),
                          icon: FileCog,
                          hidden: creatingNew || !detailNote,
                          items: [
                            {
                              id: 'format',
                              label:
                                detailNote?.format === 'markdown' ? t('formatUnmarkMarkdownButton') : t('formatMarkMarkdownButton'),
                              icon: Hash,
                              active: detailNote?.format === 'markdown',
                              onClick: () => detailNote && handleToggleFormat(toMetaItem(detailNote)),
                            },
                            {
                              id: 'pin',
                              label: t('pinButton'),
                              icon: detailNote?.is_pinned ? Pin : PinOff,
                              onClick: () => detailNote && togglePinned(toMetaItem(detailNote)),
                            },
                            {
                              id: 'hide',
                              label: t('hideButton'),
                              icon: detailNote?.is_hidden ? EyeOff : Eye,
                              onClick: () => detailNote && toggleHidden(toMetaItem(detailNote)),
                            },
                            {
                              id: 'delete',
                              label: t('deleteButtonTooltip'),
                              icon: Trash2,
                              destructive: true,
                              onClick: () => detailNote && handleDelete(toMetaItem(detailNote)),
                            },
                            {
                              id: 'history',
                              label: t('positionHistoryButton'),
                              node: (
                                <DropdownMenu open={positionHistoryOpen} onOpenChange={setPositionHistoryOpen}>
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <DropdownMenuTrigger asChild>
                                        <Button size="sm" variant="outline">
                                          <History className="h-4 w-4" />
                                        </Button>
                                      </DropdownMenuTrigger>
                                    </TooltipTrigger>
                                    <TooltipContent>{t('positionHistoryButton')}</TooltipContent>
                                  </Tooltip>
                                  <DropdownMenuContent align="end">
                                    {detailId !== null && getHistory(detailId).length === 0 && (
                                      <div className="px-2 py-1.5 text-sm text-muted-foreground">{t('positionHistoryEmptyHint')}</div>
                                    )}
                                    {detailId !== null &&
                                      getHistory(detailId).map((position, index) => (
                                        <DropdownMenuItem
                                          key={`${position.savedAt}-${index}`}
                                          onSelect={() => handleJumpToHistoryPosition(position)}
                                        >
                                          {t('positionHistoryEntryLabel', {
                                            time: new Date(position.savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                                          })}
                                        </DropdownMenuItem>
                                      ))}
                                  </DropdownMenuContent>
                                </DropdownMenu>
                              ),
                            },
                          ],
                        },
                      ]}
                    />
                  </div>

                  <div className="flex items-start gap-2">
                    {chaptersOpen && chapters.length > 0 && (
                      <div
                        className={cn(
                          'w-48 shrink-0 space-y-0.5 overflow-y-auto rounded border p-2',
                          fullscreen ? 'max-h-[72vh]' : 'max-h-[50vh]',
                        )}
                      >
                        <p className="px-1 pb-1 text-sm text-muted-foreground">
                          {t('chaptersCountLabel', { count: chapters.length })}
                        </p>
                        {chapters.map((chapter, i) => (
                          <button
                            key={i}
                            type="button"
                            title={chapter.title}
                            onClick={() => jumpToChapter(chapter.offset)}
                            className={cn(
                              'block w-full truncate rounded px-1.5 py-1 text-left text-sm hover:bg-accent',
                              chapter.weak && 'italic text-muted-foreground',
                            )}
                          >
                            {chapter.title}
                          </button>
                        ))}
                      </div>
                    )}
                    <div className="min-w-0 flex-1 overflow-hidden rounded border">
                      {isLargeNote && loadedSegments.length === 0 ? (
                        // 分段会话正在打开、还没有任何一段到位：用占位替代；首段一到（见加载 effect）就切到"编辑器 + 分段导
                        // 航条"。单段体积有界，通常毫秒级。
                        <div
                          className="flex flex-col items-center justify-center gap-3 p-6"
                          style={{ height: fullscreen ? '72vh' : '50vh' }}
                        >
                          <p className="text-sm text-muted-foreground">{t('largeNoteLoadingLabel')}</p>
                        </div>
                      ) : (
                        <div className="flex flex-col">
                          {isLargeNote && (
                            <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/40 p-2">
                              <div className="flex items-center gap-1">
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      className="px-2"
                                      disabled={segmentOrdinal <= 0 || segmentNavigating || readOnlyBootstrap}
                                      onClick={() => handleGoToSegment(segmentOrdinal - 1)}
                                    >
                                      <ChevronLeft className="h-4 w-4" />
                                    </Button>
                                  </TooltipTrigger>
                                  <TooltipContent>{t('segmentPrevButton')}</TooltipContent>
                                </Tooltip>
                                <span className="text-sm text-muted-foreground">
                                  {t('segmentPositionLabel', { current: segmentOrdinal + 1, total: segmentCount })}
                                </span>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      className="px-2"
                                      disabled={segmentOrdinal >= segmentCount - 1 || segmentNavigating || readOnlyBootstrap}
                                      onClick={() => handleGoToSegment(segmentOrdinal + 1)}
                                    >
                                      <ChevronRight className="h-4 w-4" />
                                    </Button>
                                  </TooltipTrigger>
                                  <TooltipContent>{t('segmentNextButton')}</TooltipContent>
                                </Tooltip>
                              </div>
                              <p className="text-sm text-muted-foreground">
                                {segmentNavigating || readOnlyBootstrap ? t('segmentTransitioningHint') : t('largeNoteScopeHint')}
                              </p>
                            </div>
                          )}
                          {/* 超大笔记只有开头一段进了全文索引——这件事必须说出来。
                              用户在搜索框里搜一段自己明明记得写过的文字却搜不到时，
                              第一反应是"搜索坏了"，而不是"这篇太大只索引了一部分"。 */}
                          {detailNote?.fts_truncated && (
                            <p className="border-b bg-muted/40 px-2 py-1 text-sm text-muted-foreground">
                              {t('ftsTruncatedHint', {
                                megabytes: Math.round((detailNote.fts_indexed_bytes ?? 0) / (1024 * 1024)),
                              })}
                            </p>
                          )}
                          {findPanelOpen && (
                            <div className="space-y-1.5 border-b bg-muted/40 p-2">
                              <div className="flex flex-wrap items-center gap-1">
                                <Input
                                  ref={findInputRef}
                                  value={findQuery}
                                  onChange={(e) => setFindQuery(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key !== 'Enter') return
                                    e.preventDefault()
                                    if (e.shiftKey) goToPrevMatch()
                                    else goToNextMatch()
                                  }}
                                  placeholder={t('findPlaceholder')}
                                  className="h-8 max-w-xs"
                                />
                                <span className="min-w-[3.5rem] text-sm text-muted-foreground">
                                  {findError
                                    ? t('findInvalidRegexHint')
                                    : findQuery
                                      ? t('findMatchCountLabel', {
                                          current: findMatches.length > 0 ? findMatchIndex + 1 : 0,
                                          total: findMatches.length,
                                          capped: findCapped ? '+' : '',
                                        })
                                      : ''}
                                </span>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <Button size="sm" variant="outline" className="px-2" onClick={goToPrevMatch} aria-label={t('findPrevButton')}>
                                      <ChevronUp className="h-4 w-4" />
                                    </Button>
                                  </TooltipTrigger>
                                  <TooltipContent>{t('findPrevButton')}</TooltipContent>
                                </Tooltip>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <Button size="sm" variant="outline" className="px-2" onClick={goToNextMatch} aria-label={t('findNextButton')}>
                                      <ChevronDown className="h-4 w-4" />
                                    </Button>
                                  </TooltipTrigger>
                                  <TooltipContent>{t('findNextButton')}</TooltipContent>
                                </Tooltip>
                                <Button
                                  size="sm"
                                  variant={findShowReplace ? 'default' : 'outline'}
                                  onClick={() => setFindShowReplace((v) => !v)}
                                >
                                  {t('findReplaceToggleButton')}
                                </Button>
                                {isProfessional && (
                                  <Button
                                    size="sm"
                                    variant={findAdvancedOpen ? 'default' : 'outline'}
                                    onClick={() => setFindAdvancedOpen((v) => !v)}
                                  >
                                    {t('findAdvancedToggleButton')}
                                  </Button>
                                )}
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <Button size="sm" variant="ghost" className="px-2" onClick={closeFindPanel} aria-label={t('findCloseButton')}>
                                      <X className="h-4 w-4" />
                                    </Button>
                                  </TooltipTrigger>
                                  <TooltipContent>{t('findCloseButton')}</TooltipContent>
                                </Tooltip>
                              </div>
                              {findShowReplace && (
                                <div className="flex flex-wrap items-center gap-1">
                                  <Input
                                    value={replaceQuery}
                                    onChange={(e) => setReplaceQuery(e.target.value)}
                                    placeholder={t('replacePlaceholder')}
                                    className="h-8 max-w-xs"
                                  />
                                  <Button size="sm" variant="outline" disabled={findMatches.length === 0} onClick={handleReplaceOne}>
                                    {t('replaceOneButton')}
                                  </Button>
                                  <Button size="sm" variant="outline" disabled={findMatches.length === 0} onClick={handleReplaceAll}>
                                    {t('replaceAllButton')}
                                  </Button>
                                </div>
                              )}
                              {findAdvancedOpen && (
                                <div className="flex flex-wrap items-center gap-3 text-sm">
                                  <label className="flex items-center gap-1">
                                    <Checkbox checked={findCaseSensitive} onCheckedChange={(v) => setFindCaseSensitive(v === true)} />
                                    {t('findCaseSensitiveLabel')}
                                  </label>
                                  <label className="flex items-center gap-1">
                                    <Checkbox checked={findWholeWord} onCheckedChange={(v) => setFindWholeWord(v === true)} />
                                    {t('findWholeWordLabel')}
                                  </label>
                                  <label className="flex items-center gap-1">
                                    <Checkbox checked={findRegexp} onCheckedChange={(v) => setFindRegexp(v === true)} />
                                    {t('findRegexpLabel')}
                                  </label>
                                </div>
                              )}
                            </div>
                          )}
                          {!readOnlyBootstrap && !isLargeNote && (
                            <div className="flex flex-wrap items-center gap-2">
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button size="sm" variant={autoScrollActive ? 'default' : 'outline'} onClick={toggleAutoScroll}>
                                    {autoScrollActive ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent>{t(autoScrollActive ? 'autoScrollPauseButton' : 'autoScrollStartButton')}</TooltipContent>
                              </Tooltip>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button
                                    size="sm"
                                    variant={autoScrollControlsOpen ? 'default' : 'outline'}
                                    onClick={() => changeAutoScrollControlsOpen(!autoScrollControlsOpen)}
                                  >
                                    <SlidersHorizontal className="h-4 w-4" />
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent>{autoScrollControlsOpen ? t('autoScrollControlsHideButton') : t('autoScrollControlsShowButton')}</TooltipContent>
                              </Tooltip>
                              {autoScrollControlsOpen && (
                                <>
                                  <div className="flex items-center gap-0.5">
                                    <Tooltip>
                                      <TooltipTrigger asChild>
                                        <Button
                                          size="sm"
                                          variant={autoScrollSettings.direction === 'up' ? 'default' : 'outline'}
                                          className="px-2"
                                          onClick={() => setAutoScrollSettings((s) => ({ ...s, direction: 'up' }))}
                                        >
                                          <ArrowUp className="h-3.5 w-3.5" />
                                        </Button>
                                      </TooltipTrigger>
                                      <TooltipContent>{t('autoScrollDirectionUp')}</TooltipContent>
                                    </Tooltip>
                                    <Tooltip>
                                      <TooltipTrigger asChild>
                                        <Button
                                          size="sm"
                                          variant={autoScrollSettings.direction === 'down' ? 'default' : 'outline'}
                                          className="px-2"
                                          onClick={() => setAutoScrollSettings((s) => ({ ...s, direction: 'down' }))}
                                        >
                                          <ArrowDown className="h-3.5 w-3.5" />
                                        </Button>
                                      </TooltipTrigger>
                                      <TooltipContent>{t('autoScrollDirectionDown')}</TooltipContent>
                                    </Tooltip>
                                  </div>
                                  <Select
                                    value={autoScrollSettings.speedPreset}
                                    onValueChange={(v) => setAutoScrollSettings((s) => ({ ...s, speedPreset: v as AutoScrollSpeedPreset }))}
                                  >
                                    <SelectTrigger className="w-[110px]" title={t('autoScrollSpeedLabel')}>
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value="slow">{t('autoScrollSpeedSlow')}</SelectItem>
                                      <SelectItem value="medium">{t('autoScrollSpeedMedium')}</SelectItem>
                                      <SelectItem value="fast">{t('autoScrollSpeedFast')}</SelectItem>
                                      <SelectItem value="custom">{t('autoScrollSpeedCustom')}</SelectItem>
                                    </SelectContent>
                                  </Select>
                                  {autoScrollSettings.speedPreset === 'custom' && (
                                    <input
                                      type="range"
                                      className="w-24 accent-primary"
                                      min={MIN_CUSTOM_SPEED_PX_PER_SEC}
                                      max={MAX_CUSTOM_SPEED_PX_PER_SEC}
                                      step={5}
                                      value={autoScrollSettings.customSpeedPxPerSec}
                                      aria-label={t('autoScrollSpeedLabel')}
                                      onChange={(e) => setAutoScrollSettings((s) => ({ ...s, customSpeedPxPerSec: Number(e.target.value) }))}
                                    />
                                  )}
                                  <Select value={autoScrollSettings.unit} onValueChange={(v) => setAutoScrollSettings((s) => ({ ...s, unit: v as AutoScrollUnit }))}>
                                    <SelectTrigger className="w-[100px]" title={t('autoScrollUnitLabel')}>
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value="pixel">{t('autoScrollUnitPixel')}</SelectItem>
                                      <SelectItem value="line">{t('autoScrollUnitLine')}</SelectItem>
                                      <SelectItem value="paragraph">{t('autoScrollUnitParagraph')}</SelectItem>
                                    </SelectContent>
                                  </Select>
                                </>
                              )}
                              {autoScrollActive && <Progress value={autoScrollProgress} className="h-1.5 w-24" />}
                            </div>
                          )}
                          <div className={cn('relative flex w-full min-w-0', effectiveMarkdownViewMode === 'split' && 'gap-0')}>
                            {showBackToPosition && (
                              <Button
                                size="sm"
                                variant="secondary"
                                className="absolute bottom-3 right-3 z-10 shadow-md"
                                onClick={handleBackToLastPosition}
                              >
                                <Locate className="h-3.5 w-3.5" />
                                {t('backToLastPositionButton')}
                              </Button>
                            )}
                            {effectiveMarkdownViewMode !== 'preview' && (
                              <div onWheel={handleEditorWheelZoom} className="min-w-0 flex-1">
                                {/* 兜底占位要**跟编辑器一样高**，否则第一次打开笔记时
                                    下面的图片区/按钮会先挤上来再被推回去，看着像跳了
                                    一下。文字而非转圈：分块是本地文件，通常一两帧就到。 */}
                                <Suspense
                                  fallback={
                                    <div
                                      className="flex items-center justify-center"
                                      style={{ height: fullscreen ? '72vh' : '50vh' }}
                                    >
                                      <p className="text-sm text-muted-foreground">{t('loading')}</p>
                                    </div>
                                  }
                                >
                                <NoteEditor
                                  value={draftContent}
                                  editable={!readOnlyBootstrap}
                                  height={fullscreen ? '72vh' : '50vh'}
                                  theme={resolvedTheme === 'dark' ? 'dark' : 'light'}
                                  fontFamily={EDITOR_FONT_FAMILY[editorFont]}
                                  fontSize={editorFontSize}
                                  fontWeight={editorFontWeight}
                                  syntaxHighlight={currentFormat === 'markdown'}
                                  onUpdate={handleEditorUpdate}
                                  onChange={handleEditorChange}
                                  onCreateEditor={(view) => {
                                    editorViewRef.current = view
                                    // 编辑器首次挂载时检测当前笔记有无保存位置（首次打开 app 点笔记时 editorViewRef 刚有值，之前的
                                    // loadContentDirect 因 view 为 null 返回了 false）。
                                    const noteId = currentNoteIdRef.current
                                    if (noteId !== null && detailId === noteId) {
                                      const saved = getPosition(noteId)
                                      if (saved && view.state.doc.length > 0) {
                                        const pos = Math.min(saved.cursor, view.state.doc.length)
                                        reveal(view, { selection: { anchor: pos, head: pos }, marker: pos })
                                        // 编辑器刚挂载，这是最不该直接读 scrollHeight 的
                                        // 时刻——首次布局还没量过，拿到的高度基本是 0。
                                        applyScrollRatio(view, saved.scrollRatio)
                                        if (positionMarkerTimerRef.current) clearTimeout(positionMarkerTimerRef.current)
                                        positionMarkerTimerRef.current = setTimeout(() => {
                                          if (currentNoteIdRef.current === noteId) reveal(view, { marker: null })
                                        }, 2500)
                                      }
                                    }
                                    // 详情面板切换笔记时不卸载，EditorView 跨笔记复用，滚动监听只需挂一次。
                                    if (scrollListenerAttachedRef.current) return
                                    scrollListenerAttachedRef.current = true
                                    view.scrollDOM.addEventListener('scroll', () => {
                                      // 自动滚动在跑且这次滚动不是它自己触发的，说明用户用滚轮/拖动介入，按 PRD 当作暂停指令。
                                      // autoScrollRafRef 非空即"有一帧已调度"，比读 state 更实时，无需再镜像 ref。
                                      if (autoScrollRafRef.current !== null && !autoScrollDrivenRef.current) stopAutoScroll()
                                      schedulePositionSave()
                                      // 大文件模式"连续滚动"的触发点，不与下面的 100ms 节流共用：懒加载判断很便宜，节流可能在快速滚动时错
                                      // 过窗口。maybeLoadMoreSegments 自带防重入（同时只发起一次请求），高频调用安全。
                                      void maybeLoadMoreSegments()
                                      updateFocusedSegmentOrdinal()
                                      const now = performance.now()
                                      if (now - backToPositionThrottleRef.current < 100) return
                                      backToPositionThrottleRef.current = now
                                      updateBackToPositionVisibility()
                                    }, { passive: true })
                                  }}
                                  placeholder={t('contentPlaceholder')}
                                />
                                </Suspense>
                              </div>
                            )}
                            {(effectiveMarkdownViewMode === 'preview' || effectiveMarkdownViewMode === 'split') && (
                              <div
                                className={cn(
                                  'min-w-0 flex-1 overflow-y-auto p-3',
                                  effectiveMarkdownViewMode === 'split' && 'border-l',
                                )}
                                style={{ height: fullscreen ? '72vh' : '50vh' }}
                              >
                                {/* 兜底是一句"渲染中"，不是转圈动画：这一步只是取一个
                                    本地分块，通常一帧就过去了，闪一下的动画比静止的
                                    文字更扎眼。 */}
                                <Suspense fallback={<p className="text-sm text-muted-foreground">{t('loading')}</p>}>
                                  <MarkdownPreview content={debouncedMarkdownContent} />
                                </Suspense>
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>

                  {!creatingNew && detailNote ? (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium">{t('imagesLabel')}</span>
                        <Button size="sm" variant="outline" disabled={imageImporting} onClick={handleImportImages}>
                          <ImagePlus className="mr-1 h-4 w-4" />
                          {t('importImagesButton')}
                        </Button>
                      </div>
                      <div
                        tabIndex={0}
                        onPaste={handlePasteImage}
                        className="rounded border border-dashed p-2 focus:outline-none focus:ring-1 focus:ring-ring"
                      >
                        {imagesLoading ? (
                          <p className="text-sm text-muted-foreground">{t('loadingImage')}</p>
                        ) : noteImages.length === 0 ? (
                          <p className="text-sm text-muted-foreground">{t('imagesEmptyHint')}</p>
                        ) : (
                          <div className="flex flex-wrap gap-2">
                            {noteImages.map((img) => (
                              <div key={img.id} className="group relative h-20 w-20 shrink-0">
                                <img
                                  src={`data:image/png;base64,${img.thumbnail_base64}`}
                                  alt=""
                                  className="h-20 w-20 cursor-pointer rounded border object-cover"
                                  onClick={() => handleViewImage(img.id)}
                                />
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <button
                                      type="button"
                                      onClick={() => handleDeleteImage(img.id)}
                                      className="absolute -right-1 -top-1 hidden rounded-full bg-destructive p-0.5 text-destructive-foreground group-hover:block"
                                    >
                                      <X className="h-3 w-3" />
                                    </button>
                                  </TooltipTrigger>
                                  <TooltipContent>{t('deleteButtonTooltip')}</TooltipContent>
                                </Tooltip>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">{t('imagesSaveFirstHint')}</p>
                  )}

                  <div className="flex items-center justify-between">
                    <p className="text-sm text-muted-foreground">
                      {saving
                        ? t('savingHint')
                        : dirty
                          ? t('unsavedChangesHint')
                          : lastSavedAt
                            ? t('savedAtHint', {
                                time: new Date(lastSavedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                              })
                            : t('savedHint')}
                    </p>
                    <div className="flex gap-2">
                      {!creatingNew && detailNote && (
                        <>
                          <Select
                            value={exportFormat}
                            onValueChange={(v) => setExportFormat(v as 'txt' | 'docx' | 'pdf')}
                          >
                            <SelectTrigger className="h-8 w-[84px]" title={t('exportFormatLabel')}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="txt">TXT</SelectItem>
                              {/* docx/pdf 导出要把正文整个搬进渲染进程内存生成文档，分段大笔记
                                  只保留当前打开的这一段，不具备这个前提，见 handleExportDetail
                                  顶部的同一处限制说明——只对普通笔记开放这两个格式。 */}
                              {!isLargeNote && <SelectItem value="docx">DOCX</SelectItem>}
                              {!isLargeNote && <SelectItem value="pdf">PDF</SelectItem>}
                            </SelectContent>
                          </Select>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={exportingDetail || readOnlyBootstrap}
                                onClick={handleExportDetail}
                              >
                                <Download className="h-4 w-4" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>{t('exportDetailButton')}</TooltipContent>
                          </Tooltip>
                        </>
                      )}
                      <Button size="sm" variant="outline" onClick={handleCloseDetail} disabled={saving}>
                        {t('closeButton')}
                      </Button>
                      <Button size="sm" onClick={() => handleSave()} disabled={!dirty || saving} title={t('saveShortcutHint')}>
                        {t('saveButton')}
                      </Button>
                    </div>
                  </div>
                </>
              )}
            </div>
            </div>
          }
        />

      {!fullscreen && recoverySnapshot && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-warning/40 bg-warning/10 p-3 text-sm">
          <span>{t('recoveryAvailableHint', { time: new Date(recoverySnapshot.savedAt).toLocaleString() })}</span>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={discardRecoverySnapshot}>{t('recoveryDiscardButton')}</Button>
            <Button size="sm" onClick={restoreRecoverySnapshot}>{t('recoveryRestoreButton')}</Button>
          </div>
        </div>
      )}

      {!fullscreen && viewMode === 'active' && (
        <Button
          className="fixed bottom-6 right-6 z-40 rounded-full shadow-lg"
          onClick={handleOpenNew}
          title={t('quickCaptureButton')}
          aria-label={t('quickCaptureButton')}
        >
          <Plus className="h-4 w-4" />
          {t('quickCaptureButton')}
        </Button>
      )}

      <Dialog open={folderImportOpen} onOpenChange={(o) => !o && setFolderImportOpen(false)}>
        <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>{t('folderImportDialogHeading')}</DialogTitle>
          </DialogHeader>
          {scanning ? (
            <p className="text-sm text-muted-foreground">{t('folderScanningLabel')}</p>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col gap-3">
              <Input
                placeholder={t('folderImportSearchPlaceholder')}
                value={scanSearch}
                onChange={(e) => setScanSearch(e.target.value)}
              />
              <div className="flex flex-wrap items-center justify-between gap-2">
                <button
                  type="button"
                  className="flex items-center gap-2 text-sm text-muted-foreground"
                  onClick={() => toggleScanSelectAll(!allScanFilteredSelected)}
                >
                  {allScanFilteredSelected ? <CheckSquare className="h-4 w-4" /> : <Square className="h-4 w-4" />}
                  {t('selectAllLabel')}
                </button>
                <span className="text-sm text-muted-foreground">
                  {t('folderImportFoundCountLabel', { count: filteredScanFiles.length })}
                </span>
                <button
                  type="button"
                  className="flex items-center gap-2 text-sm"
                  onClick={() => setScanBatchEncrypt((v) => !v)}
                  title={t('folderImportBatchEncryptHint')}
                >
                  {scanBatchEncrypt ? <Lock className="h-4 w-4" /> : <Unlock className="h-4 w-4" />}
                  {scanBatchEncrypt ? t('folderImportBatchEncryptOnLabel') : t('folderImportBatchEncryptOffLabel')}
                </button>
              </div>

              {/* 整批导入到隐藏分类。放在文件列表**上方**而不是折进"高级选项"：
                  它决定这一批文件导完之后出现在哪里，是导入前必须先看见的决定，
                  不是导完再回头调的细节。 */}
              <div className="flex flex-wrap items-center gap-3 rounded border border-dashed px-3 py-2">
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="folder-import-hidden"
                    checked={scanImportHidden}
                    onCheckedChange={(v) => setScanImportHidden(v === true)}
                  />
                  <Label htmlFor="folder-import-hidden" className="flex items-center gap-1.5 text-sm">
                    <EyeOff className="h-4 w-4" />
                    {t('folderImportHiddenLabel')}
                  </Label>
                </div>
                <Input
                  className="h-8 w-64"
                  list="folder-import-category-options"
                  placeholder={
                    scanImportHidden ? t('folderImportHiddenCategoryPlaceholder') : t('folderImportCategoryPlaceholder')
                  }
                  value={scanImportCategory}
                  onChange={(e) => setScanImportCategory(e.target.value)}
                />
                <datalist id="folder-import-category-options">
                  {(scanImportHidden ? categoryOptionsHidden : categoryOptionsNormal).map((category) => (
                    <option key={category} value={category} />
                  ))}
                </datalist>
              </div>

              {filteredScanFiles.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('folderImportEmptyHint')}</p>
              ) : (
                <div ref={scanScrollParentRef} className="min-h-[55vh] flex-1 overflow-y-auto rounded border">
                  <div style={{ height: scanRowVirtualizer.getTotalSize(), position: 'relative' }}>
                    {scanRowVirtualizer.getVirtualItems().map((virtualRow) => {
                      const file = filteredScanFiles[virtualRow.index]
                      const selected = scanSelectedPaths.has(file.path)
                      const encrypted = scanEffectiveEncrypt(file.path)
                      return (
                        <div
                          key={virtualRow.key}
                          ref={scanRowVirtualizer.measureElement}
                          data-index={virtualRow.index}
                          style={{
                            position: 'absolute',
                            top: 0,
                            left: 0,
                            width: '100%',
                            transform: `translateY(${virtualRow.start}px)`,
                          }}
                          className="flex items-center gap-2 border-b px-2 py-1.5"
                        >
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <button
                                type="button"
                                onClick={() => toggleScanSelected(file.path, !selected)}
                                aria-label={selected ? t('folderImportRowUnselectedHint') : t('folderImportRowSelectedHint')}
                                className="shrink-0 text-muted-foreground hover:text-foreground"
                              >
                                {selected ? <CheckSquare className="h-4 w-4" /> : <Square className="h-4 w-4" />}
                              </button>
                            </TooltipTrigger>
                            <TooltipContent>{selected ? t('folderImportRowUnselectedHint') : t('folderImportRowSelectedHint')}</TooltipContent>
                          </Tooltip>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm">{file.name}</p>
                            <p className="truncate text-sm text-muted-foreground">{formatScanFileSize(file.size_bytes)}</p>
                          </div>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <button
                                type="button"
                                onClick={() => toggleScanRowEncrypt(file.path)}
                                className="shrink-0 text-muted-foreground hover:text-foreground"
                              >
                                {encrypted ? <Lock className="h-4 w-4" /> : <Unlock className="h-4 w-4" />}
                              </button>
                            </TooltipTrigger>
                            <TooltipContent>{encrypted ? t('folderImportRowEncryptedHint') : t('folderImportRowPlainHint')}</TooltipContent>
                          </Tooltip>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}

              {scanImportProgress && (
                <div className="space-y-1">
                  <p className="text-sm text-muted-foreground">
                    {t('folderImportProgressLabel', {
                      current: scanImportProgress.fileIndex,
                      total: scanImportProgress.totalFiles,
                      fileName: scanImportProgress.fileName,
                    })}
                  </p>
                  <Progress
                    value={scanImportProgress.total > 0 ? (scanImportProgress.done / scanImportProgress.total) * 100 : 0}
                  />
                </div>
              )}
              <div className="flex items-center justify-between">
                <p className="text-sm text-muted-foreground">{t('selectedCountLabel', { count: scanSelectedPaths.size })}</p>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => setFolderImportOpen(false)} disabled={scanImporting}>
                    {t('closeButton')}
                  </Button>
                  <Button
                    size="sm"
                    onClick={handleConfirmFolderImport}
                    disabled={scanImporting || scanSelectedPaths.size === 0}
                  >
                    {scanImporting ? t('importingLabel') : t('folderImportConfirmButton', { count: scanSelectedPaths.size })}
                  </Button>
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={categoryManagerOpen} onOpenChange={handleCategoryManagerOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('manageCategoriesTitle')}</DialogTitle>
          </DialogHeader>
          <div className="max-h-[70vh] space-y-4 overflow-y-auto pr-1">
            {/* 顺序按「用户来这个弹窗是要干什么」排，不按实现顺序排。
                这里叫「分类管理」，来的人十有八九是要**建一个分类、改关键词、
                删掉不用的**——那是主线，必须在第一屏、不用滚动就能看到。
                「一键重新分类」紧随其后：它是这个弹窗里唯一会**批量改动已有笔记**
                的动作，价值最高，原来却压在最底下一个虚线框里。
                预设分类的图标/改名/隐藏是**外观偏好**，属于调完一次就不再碰的东西，
                挪到最后。 */}
            <CategoryManagerSection
              label={t('normalCategoriesLabel')}
              emptyLabel={t('noCustomCategoriesYet')}
              categories={normalCategories}
              newName={newNormalCategoryName}
              onNewNameChange={setNewNormalCategoryName}
              onAdd={() => handleCreateCategory('normal', newNormalCategoryName)}
              onDelete={(id) => void handleRequestDeleteCategory('normal', id)}
              onRename={(category) => setRenamingCategory({ id: category.id, name: category.name })}
              onKeywordsChange={(id, keywords) => handleSetCategoryKeywords('normal', id, keywords)}
              addPlaceholder={t('newCategoryPlaceholder')}
              keywordsPlaceholder={t('categoryKeywordsPlaceholder')}
            />
            <div className="flex flex-wrap items-center gap-2 rounded border border-dashed p-2">
              <Button
                size="sm"
                variant="outline"
                disabled={reclassifyLoading}
                onClick={() => void handleReclassifyPreview(hiddenOnly ? 'hidden' : 'normal', false)}
              >
                <Wand2 className="h-3.5 w-3.5" />
                {t('reclassifyPreviewButton')}
              </Button>
            </div>
            {hiddenCategoriesRevealed ? (
              <CategoryManagerSection
                label={t('hiddenCategoriesLabel')}
                emptyLabel={t('noCustomCategoriesYet')}
                categories={hiddenCategories}
                newName={newHiddenCategoryName}
                onNewNameChange={setNewHiddenCategoryName}
                onAdd={() => handleCreateCategory('hidden', newHiddenCategoryName)}
                onDelete={(id) => void handleRequestDeleteCategory('hidden', id)}
                onRename={(category) => setRenamingCategory({ id: category.id, name: category.name })}
                onKeywordsChange={(id, keywords) => handleSetCategoryKeywords('hidden', id, keywords)}
                addPlaceholder={t('newCategoryPlaceholder')}
                keywordsPlaceholder={t('categoryKeywordsPlaceholder')}
              />
            ) : (
              <div className="space-y-2">
                <FeatureTitle as="p">{t('hiddenCategoriesLabel')}</FeatureTitle>
                <div className="flex items-center justify-between gap-2 rounded border border-dashed p-2">
                  <Button size="sm" variant="outline" onClick={handleRevealHiddenCategories}>
                    <Lock className="h-3.5 w-3.5" />
                    {t('hiddenCategoriesUnlockButton')}
                  </Button>
                </div>
              </div>
            )}
            <PresetCategorySection
              names={categoryOptionsNormal}
              prefs={categoryPrefs}
              onChange={updateCategoryPrefs}
              iconFor={categoryIconFor}
              labelFor={categoryLabelFor}
            />
          </div>
        </DialogContent>
      </Dialog>

      {/* 删分类的确认框。核心是让两种语义的**后果**都摆在眼前再选，而不是
          给一个"确定/取消"然后偷偷走默认值——两者破坏力差一个量级。 */}
      <Dialog open={categoryDeleteTarget !== null} onOpenChange={(o) => !o && setCategoryDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('deleteCategoryDialogTitle', { name: categoryDeleteTarget?.impact.name ?? '' })}</DialogTitle>
            <DialogDescription>
              {t('deleteCategoryImpactSummary', {
                children: categoryDeleteTarget?.impact.child_count ?? 0,
                direct: categoryDeleteTarget?.impact.direct_note_count ?? 0,
                descendants: categoryDeleteTarget?.impact.descendant_note_count ?? 0,
              })}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <button
              type="button"
              className="w-full rounded border p-3 text-left transition-colors hover:bg-accent/50"
              onClick={() =>
                categoryDeleteTarget &&
                void handleConfirmDeleteCategory(categoryDeleteTarget.impact.id, 'promote')
              }
            >
              <p className="font-medium">{t('deleteCategoryPromoteTitle')}</p>
            </button>
            <button
              type="button"
              className="w-full rounded border border-destructive/40 p-3 text-left transition-colors hover:bg-destructive/10"
              onClick={() =>
                categoryDeleteTarget &&
                void handleConfirmDeleteCategory(categoryDeleteTarget.impact.id, 'cascade')
              }
            >
              <p className="font-medium text-destructive">{t('deleteCategoryCascadeTitle')}</p>
            </button>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCategoryDeleteTarget(null)}>
              {t('cancelButton')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 重命名 = 移动：输入框里填的是**完整路径**，把 `工作/项目A` 改成
          `归档/项目A` 就是把整棵子树搬到另一个父级下面。 */}
      <Dialog open={renamingCategory !== null} onOpenChange={(o) => !o && setRenamingCategory(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('renameCategoryDialogTitle')}</DialogTitle>
            <DialogDescription>{t('renameCategoryHint')}</DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            value={renamingCategory?.name ?? ''}
            onChange={(e) => setRenamingCategory((prev) => (prev ? { ...prev, name: e.target.value } : prev))}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && renamingCategory) void handleRenameCategory(renamingCategory.id, renamingCategory.name)
            }}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenamingCategory(null)}>
              {t('cancelButton')}
            </Button>
            <Button
              disabled={!renamingCategory?.name.trim()}
              onClick={() => renamingCategory && void handleRenameCategory(renamingCategory.id, renamingCategory.name)}
            >
              {t('renameCategoryConfirmButton')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 回溯重分类的预览。列出每一条"从 X 改到 Y"，用户看过之后才写。 */}
      <Dialog open={reclassify !== null} onOpenChange={(o) => !o && setReclassify(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('reclassifyDialogTitle')}</DialogTitle>
            <DialogDescription>
              {reclassify?.changes.length === 0
                ? t('reclassifyNoChanges', { scanned: reclassify?.scanned ?? 0 })
                : t('reclassifySummary', { count: reclassify?.changes.length ?? 0, scanned: reclassify?.scanned ?? 0 })}
            </DialogDescription>
          </DialogHeader>
          {reclassify && reclassify.truncated && (
            <p className="text-sm text-muted-foreground">{t('reclassifyTruncatedHint', { scanned: reclassify.scanned })}</p>
          )}
          {reclassify && reclassify.changes.length > 0 && (
            <div className="max-h-64 space-y-1 overflow-y-auto rounded border p-2">
              {reclassify.changes.map((change) => (
                <div key={change.id} className="flex items-center gap-2 text-sm">
                  <span className="min-w-0 flex-1 truncate" title={change.title}>
                    {change.title || t('untitledNote')}
                  </span>
                  <span className="shrink-0 text-muted-foreground">
                    {change.from_category || t('filterUncategorized')} → {change.to_category}
                  </span>
                </div>
              ))}
            </div>
          )}
          <div className="flex items-center gap-2">
            <Checkbox
              id="reclassify-include-categorized"
              checked={reclassify?.includeCategorized ?? false}
              disabled={reclassifyLoading}
              onCheckedChange={(v) =>
                reclassify && void handleReclassifyPreview(reclassify.scope, v === true)
              }
            />
            <Label htmlFor="reclassify-include-categorized" className="text-sm">
              {t('reclassifyIncludeCategorizedLabel')}
            </Label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReclassify(null)}>
              {t('cancelButton')}
            </Button>
            <Button
              disabled={reclassifyLoading || !reclassify || reclassify.changes.length === 0}
              onClick={() => void handleReclassifyApply()}
            >
              {t('reclassifyApplyButton')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={tagManagerOpen} onOpenChange={setTagManagerOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('manageTagsTitle')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="flex flex-wrap gap-1">
              {(hiddenOnly ? hiddenTags : normalTags).length === 0 && <p className="text-sm text-muted-foreground">{t('noTagsYet')}</p>}
              {(hiddenOnly ? hiddenTags : normalTags).map((tag) => (
                <span key={tag.id} className="flex items-center gap-1 rounded-full bg-muted px-2 py-1 text-sm">
                  {tag.name}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        className="text-muted-foreground hover:text-foreground"
                        onClick={() => handleDeleteTag(tag.id)}
                        aria-label={t('deleteTagAriaLabel', { tag: tag.name })}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>{t('deleteTagAriaLabel', { tag: tag.name })}</TooltipContent>
                  </Tooltip>
                </span>
              ))}
            </div>
            <div className="flex gap-2">
              <Input
                value={newTagName}
                onChange={(e) => setNewTagName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleCreateTag()}
                placeholder={t('newTagPlaceholder')}
              />
              <Button size="sm" onClick={handleCreateTag}>
                <Plus className="h-3.5 w-3.5" />
                {t('addTagButton')}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={imageViewerOpen} onOpenChange={setImageViewerOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{t('imageViewerTitle')}</DialogTitle>
          </DialogHeader>
          {viewingImageLoading || !viewingImage ? (
            <p className="text-sm text-muted-foreground">{t('loadingImage')}</p>
          ) : (
            <img
              src={`data:${viewingImage.mime_type};base64,${viewingImage.image_base64}`}
              alt=""
              className="mx-auto max-h-[70vh] object-contain"
            />
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

      <NoteTimelineDialog
        target={timelineTarget}
        onClose={() => setTimelineTarget(null)}
        beforeMutate={saveBeforeBatch}
        loadCurrentContent={loadCurrentNoteContent}
        onRestored={handleRevisionRestored}
        onBatchUndone={() => void refreshAfterBatch()}
        onOpenNote={(id) => {
          setTimelineTarget(null)
          setViewMode('active')
          handleOpenExisting(id)
        }}
      />
      <NoteBulkEditDialog
        open={bulkEdit !== null}
        onOpenChange={(open) => !open && setBulkEdit(null)}
        noteIds={bulkEdit?.noteIds ?? []}
        initialOp={bulkEdit?.op}
        beforeApply={saveBeforeBatch}
        onApplied={({ batchId, changedCount }) => {
          setBulkEdit(null)
          void refreshAfterBatch()
          toastWithBatchUndo(t('bulkEditDoneToast', { count: changedCount }), batchId)
        }}
      />
      <NoteDuplicatesDialog
        scope={dedupeScope}
        onClose={() => setDedupeScope(null)}
        beforeMerge={saveBeforeBatch}
        onMerged={({ batchId, removedCount, removedIds }) => {
          setDedupeScope(null)
          if (detailId !== null && removedIds.includes(detailId)) handleCloseDetail()
          setSelectedIds((prev) => new Set([...prev].filter((id) => !removedIds.includes(id))))
          void refreshAfterBatch()
          toastWithBatchUndo(t('dedupeMergedToast', { count: removedCount }), batchId)
        }}
      />
    </div>
  )
}

function CategoryManagerSection({
  label,
  emptyLabel,
  categories,
  newName,
  onNewNameChange,
  onAdd,
  onDelete,
  onRename,
  onKeywordsChange,
  addPlaceholder,
  keywordsPlaceholder,
}: {
  label: string
  emptyLabel: string
  categories: NoteCategory[]
  newName: string
  onNewNameChange: (value: string) => void
  onAdd: () => void
  onDelete: (id: number) => void
  onRename: (category: NoteCategory) => void
  onKeywordsChange: (id: number, keywords: string) => void
  addPlaceholder: string
  keywordsPlaceholder: string
}) {
  const { t } = useTranslation('notes')
  const tree = useMemo(() => buildCategoryTree(categories.map((c) => c.name)), [categories])
  const byName = useMemo(() => new Map(categories.map((c) => [c.name, c] as const)), [categories])
  return (
    <div className="space-y-2">
      <FeatureTitle as="p">{label}</FeatureTitle>
      <div className="space-y-1">
        {categories.length === 0 && <p className="text-sm text-muted-foreground">{emptyLabel}</p>}
        <CategoryManagerTreeLevel
          nodes={tree}
          byName={byName}
          onDelete={onDelete}
          onRename={onRename}
          onKeywordsChange={onKeywordsChange}
          keywordsPlaceholder={keywordsPlaceholder}
        />
      </div>
      <div className="flex gap-2">
        <Input
          value={newName}
          onChange={(e) => onNewNameChange(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && onAdd()}
          placeholder={addPlaceholder}
          className="max-w-xs"
        />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="sm" variant="outline" onClick={onAdd} aria-label={t('addCategoryButton')}>
              <Plus className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t('addCategoryButton')}</TooltipContent>
        </Tooltip>
      </div>
    </div>
  )
}

// 分类管理的树：只有真正建过的分类（有 id，可改关键词/删除）显示成完整一行；仅靠"/"推导出的父级（如
// 只存在过 "Internet/Node" 而 "Internet" 从未创建）只当不可点、不可编辑的分组标题；要单独管理该层，
// 在下面输入框创建即可（幂等，不与已有子级冲突）。
function CategoryManagerTreeLevel({
  nodes,
  byName,
  onDelete,
  onRename,
  onKeywordsChange,
  keywordsPlaceholder,
  depth = 0,
}: {
  nodes: CategoryTreeNode[]
  byName: Map<string, NoteCategory>
  onDelete: (id: number) => void
  onRename: (category: NoteCategory) => void
  onKeywordsChange: (id: number, keywords: string) => void
  keywordsPlaceholder: string
  depth?: number
}) {
  return (
    <>
      {nodes.map((node) => {
        const real = byName.get(node.fullPath)
        return (
          <div key={node.fullPath} className="space-y-1">
            {real ? (
              <CategoryManagerRow
                category={real}
                label={node.segment}
                depth={depth}
                onDelete={() => onDelete(real.id)}
                onRename={() => onRename(real)}
                onKeywordsChange={(keywords) => onKeywordsChange(real.id, keywords)}
                keywordsPlaceholder={keywordsPlaceholder}
              />
            ) : (
              <p
                className="truncate text-sm font-medium text-muted-foreground"
                style={depth > 0 ? { marginLeft: depth * 16 } : undefined}
                title={node.fullPath}
              >
                {node.segment}
              </p>
            )}
            {node.children.length > 0 && (
              <CategoryManagerTreeLevel
                nodes={node.children}
                byName={byName}
                onDelete={onDelete}
                onRename={onRename}
                onKeywordsChange={onKeywordsChange}
                keywordsPlaceholder={keywordsPlaceholder}
                depth={depth + 1}
              />
            )}
          </div>
        )
      })}
    </>
  )
}

// 一行一个分类：名称 + 可选关键词输入框 + 删除按钮，整行布局（关键词需要比圆角气泡宽得多的空间）。
// 关键词只在失焦/回车时提交（onKeywordsChange 才调 RPC），不每字发请求。label 只显示本层名字，完整
// 路径放 title 悬浮提示。
function CategoryManagerRow({
  category,
  label,
  onDelete,
  onRename,
  onKeywordsChange,
  keywordsPlaceholder,
  depth = 0,
}: {
  category: NoteCategory
  label: string
  onDelete: () => void
  onRename: () => void
  onKeywordsChange: (keywords: string) => void
  keywordsPlaceholder: string
  depth?: number
}) {
  const { t } = useTranslation('notes')
  const [draft, setDraft] = useState(category.keywords)

  useEffect(() => {
    setDraft(category.keywords)
  }, [category.id, category.keywords])

  function commit() {
    if (draft.trim() !== category.keywords.trim()) onKeywordsChange(draft)
  }

  return (
    <div
      className="flex items-center gap-2 rounded border px-2 py-1"
      style={depth > 0 ? { marginLeft: depth * 16 } : undefined}
    >
      <span className="max-w-[8rem] shrink-0 truncate text-sm font-medium" title={category.name}>
        {label}
      </span>
      <Input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
        placeholder={keywordsPlaceholder}
        className="h-7 flex-1 text-sm"
      />
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="shrink-0 text-muted-foreground hover:text-foreground"
            onClick={onRename}
            aria-label={t('renameCategoryButton')}
          >
            <PencilLine className="h-3 w-3" />
          </button>
        </TooltipTrigger>
        <TooltipContent>{t('renameCategoryTooltip')}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <button type="button" className="shrink-0 text-muted-foreground hover:text-foreground" onClick={onDelete} aria-label={t('deleteCategoryButton')}>
            <X className="h-3 w-3" />
          </button>
        </TooltipTrigger>
        <TooltipContent>{t('deleteCategoryButton')}</TooltipContent>
      </Tooltip>
    </div>
  )
}

function NoteRow({
  note,
  isDetailActive,
  selected,
  onOpenDetail,
  onToggleSelected,
  onTogglePinned,
  onToggleHidden,
  onDelete,
  onRestore,
  onHardDelete,
}: {
  note: NoteListItem
  isDetailActive?: boolean
  selected?: boolean
  onOpenDetail?: () => void
  onToggleSelected?: (checked: boolean) => void
  onTogglePinned?: () => void
  onToggleHidden?: () => void
  onDelete?: () => void
  onRestore?: () => void
  onHardDelete?: () => void
}) {
  const { t } = useTranslation('notes')
  const clickable = Boolean(onOpenDetail)
  return (
    <div
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={onOpenDetail}
      onKeyDown={(e) => clickable && e.key === 'Enter' && onOpenDetail?.()}
      className={cn(
        'flex items-start gap-2 rounded border p-2 text-left transition-colors',
        clickable && 'cursor-pointer hover:bg-accent/50',
        isDetailActive && 'border-primary ring-1 ring-primary',
      )}
    >
      {onToggleSelected && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="mt-0.5 shrink-0 text-muted-foreground hover:text-foreground"
              onClick={(e) => {
                e.stopPropagation()
                onToggleSelected(!selected)
              }}
              aria-label={t('selectNoteAriaLabel', { title: note.title })}
            >
              {selected ? <CheckSquare className="h-4 w-4" /> : <Square className="h-4 w-4" />}
            </button>
          </TooltipTrigger>
          <TooltipContent>{t('selectNoteAriaLabel', { title: note.title })}</TooltipContent>
        </Tooltip>
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{note.title || t('untitledNote')}</p>
        <p className="truncate text-sm text-muted-foreground">
          {note.category && <span className="mr-1 rounded-full bg-muted px-1.5 py-0.5">{note.category}</span>}
          {note.preview}
        </p>
        <p className="mt-0.5 text-sm text-muted-foreground">{new Date(note.updated_at).toLocaleString()}</p>
      </div>
      <div className="flex shrink-0 gap-1" onClick={(e) => e.stopPropagation()}>
        {onTogglePinned && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="sm" variant="outline" onClick={onTogglePinned} aria-label={note.is_pinned ? t('unpinNoteButton') : t('pinNoteButton')}>
                {note.is_pinned ? <Pin className="h-4 w-4" /> : <PinOff className="h-4 w-4" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{note.is_pinned ? t('unpinNoteButton') : t('pinNoteButton')}</TooltipContent>
          </Tooltip>
        )}
        {onToggleHidden && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="sm" variant="outline" onClick={onToggleHidden} aria-label={note.is_hidden ? t('unhideNoteButton') : t('hideNoteButton')}>
                {note.is_hidden ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{note.is_hidden ? t('unhideNoteButton') : t('hideNoteButton')}</TooltipContent>
          </Tooltip>
        )}
        {onDelete && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="sm" variant="outline" onClick={onDelete} aria-label={t('deleteButtonTooltip')}>
                <Trash2 className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('deleteButtonTooltip')}</TooltipContent>
          </Tooltip>
        )}
        {onRestore && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="sm" variant="outline" onClick={onRestore} aria-label={t('restoreButton')}>
                <RotateCcw className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('restoreButton')}</TooltipContent>
          </Tooltip>
        )}
        {onHardDelete && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="sm" variant="destructive" onClick={onHardDelete} aria-label={t('permanentlyDeleteButton')}>
                <Trash2 className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('permanentlyDeleteButton')}</TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  )
}

/**
 * 分类的显示管理：删掉用不上的、改显示名和图标、手动调顺序。管的是界面呈现，不同于下面的"分类管理"
 * （增删数据库里的真分类）：内置预设（工作/学习/简历…）不在数据库里，曾因硬编码合并而删不掉。删除只
 * 是从显示拿掉，不动任何笔记。
 */
function PresetCategorySection({
  names,
  prefs,
  onChange,
  iconFor,
  labelFor,
}: {
  names: string[]
  prefs: CategoryPrefs
  onChange: (next: CategoryPrefs) => void
  iconFor: (segment: string) => typeof Folder
  labelFor: (segment: string) => string
}) {
  const { t } = useTranslation('notes')
  // 只列顶层，子分类跟着父级走，避免管理列表被 `工作/项目A/需求` 撑成一团。
  const tops = useMemo(
    () => Array.from(new Set(names.map((n) => n.split('/')[0]))),
    [names],
  )

  function hide(name: string) {
    onChange({ ...prefs, hidden: [...new Set([...prefs.hidden, name])] })
  }
  function restoreAll() {
    onChange({ ...prefs, hidden: [] })
  }
  function move(name: string, delta: -1 | 1) {
    // order 里只有被拖过的项。第一次拖某项时要先把当前完整顺序固化下来，
    // 否则只记一项的话，其余项的相对位置会在下次渲染时按字母序重排。
    const base = prefs.order.length > 0 ? prefs.order : tops
    onChange({ ...prefs, order: moveInOrder(base, name, delta) })
  }
  function setIcon(name: string, icon: CategoryIconName) {
    onChange({ ...prefs, icons: { ...prefs.icons, [name]: icon } })
  }
  function setLabel(name: string, label: string) {
    const next = { ...prefs.labels }
    if (label.trim() && label.trim() !== name) next[name] = label.trim()
    else delete next[name]
    onChange({ ...prefs, labels: next })
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <FeatureTitle as="p">{t('categoryDisplayLabel')}</FeatureTitle>
        {prefs.hidden.length > 0 && (
          <Button size="sm" variant="ghost" onClick={restoreAll}>
            {t('categoryRestoreHidden', { count: prefs.hidden.length })}
          </Button>
        )}
      </div>

      <div className="space-y-1">
        {tops.map((name, idx) => {
          const Icon = iconFor(name)
          return (
            <div key={name} className="flex items-center gap-1.5 rounded border px-2 py-1.5">
              <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
              <Input
                value={labelFor(name)}
                onChange={(e) => setLabel(name, e.target.value)}
                className="h-7 flex-1 text-sm"
                aria-label={t('categoryRenameDisplay', { name })}
              />
              <select
                value={prefs.icons[name] ?? ''}
                onChange={(e) => setIcon(name, e.target.value as CategoryIconName)}
                aria-label={t('categoryChangeIcon', { name })}
                className="h-7 rounded border bg-background px-1 text-sm"
              >
                <option value="">{t('categoryIconDefault')}</option>
                {CATEGORY_ICON_NAMES.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
              <ActionButton
                label={t('categoryMoveUp')}
                icon={ChevronUp}
                region={LABEL_REGIONS.notesToolbar}
                size="xs"
                disabled={idx === 0}
                onClick={() => move(name, -1)}
              />
              <ActionButton
                label={t('categoryMoveDown')}
                icon={ChevronDown}
                region={LABEL_REGIONS.notesToolbar}
                size="xs"
                disabled={idx === tops.length - 1}
                onClick={() => move(name, 1)}
              />
              <ActionButton
                label={t('categoryHide')}
                icon={Trash2}
                region={LABEL_REGIONS.notesToolbar}
                size="xs"
                onClick={() => hide(name)}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}
