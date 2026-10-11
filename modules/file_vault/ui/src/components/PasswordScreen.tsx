import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react'
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import { restrictToHorizontalAxis } from '@dnd-kit/modifiers'
import {
  arrayMove,
  horizontalListSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  ChevronDown,
  ChevronRight,
  Clock3,
  Copy,
  Dices,
  Download,
  Eye,
  EyeOff,
  KeyRound,
  Layers,
  Pencil,
  Plus,
  GripVertical,
  ShieldAlert,
  ShieldX,
  SlidersHorizontal,
  Trash2,
  Upload,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { InfoHint } from '@/components/ui/info-hint'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { vaultApi } from '@/lib/vaultApi'
import { electronApi } from '@/lib/electronApi'
import { translateError } from '@/i18n/errors'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useDebouncedValue } from '@/lib/useDebouncedValue'
import { StatTile } from '@/components/StatTile'
import { ActionButton } from '@/components/ActionButton'
import { LABEL_REGIONS } from '@/lib/labelMode'
import { Badge, EmptyState, NUMERIC_CLASS, PageHeader, PageShell } from '@/components/ui/page'
import { Workbench, WorkbenchDetailBody, WorkbenchDetailHeader } from '@/components/ui/workbench'
import { FORMULAS, Formula } from '@/components/ui/formula'
import {
  ATTACKER_MODELS,
  ATTACKER_RATES,
  DEFAULT_VISIBLE_METRICS,
  MAX_VISIBLE_METRICS,
  METRIC_BY_ID,
  PASSWORD_METRICS,
  blastRadius,
  buildMetricContext,
  computePasswordStrength,
  crackSeconds,
  crackTimeParts,
  loadVisibleMetrics,
  passwordEntropyBits,
  saveVisibleMetrics,
  type AttackerModel,
  type MetricId,
  type PasswordStrength,
} from '@/lib/passwordMetrics'
import {
  DEFAULT_GENERATOR_OPTIONS,
  GENERATOR_MAX_LENGTH,
  GENERATOR_MIN_LENGTH,
  generatePassword,
  generatorEntropyBits,
  type GeneratorOptions,
} from '@/lib/passwordGenerator'
import type { PasswordEntry, PasswordSortMode } from '@/shared/ipcTypes'
import { copyText, copyTextWithAutoClear } from '@/lib/clipboard'

// 前端展示分组用的账号识别规则，与后端 passwords.py 的 account_key() 同语义（网址取主机名、忽略大小
// 写和协议/路径；用户名去首尾空白、不折叠大小写），只用于列表折叠显示，不影响存储。
function hostnameOf(url: string): string {
  try {
    return new URL(url.includes('://') ? url : `http://${url}`).hostname.toLowerCase()
  } catch {
    return url.trim().toLowerCase()
  }
}

// 表单弹窗统一规格，与 SettingsScreen / RecoveryCodesScreen / AIChatScreen 同名同值，说明见
// SettingsScreen.tsx 顶部。CONFIRM_DIALOG 一句话确认框；FORM_DIALOG ≤3 字段表单；WIDE_FORM_DIALOG
// 字段多或带长列表（两列栅格）；REVIEW_DIALOG 逐条复核列表。
const CONFIRM_DIALOG = 'sm:max-w-lg'
const FORM_DIALOG = 'flex max-h-[85vh] flex-col sm:max-w-xl'
const WIDE_FORM_DIALOG = 'flex max-h-[85vh] flex-col sm:max-w-3xl'
const REVIEW_DIALOG = 'flex max-h-[85vh] flex-col sm:max-w-4xl'
/** 弹窗里可滚动的那一块。min-h-0 不能省，否则 flex 子项不肯收缩，overflow 失效。 */
const FORM_BODY = 'min-h-0 flex-1 space-y-5 overflow-y-auto'
/** 单个字段：标签与输入框之间的距离，全应用一个值。 */
const FIELD = 'space-y-2'
/** 详情面板里「一个只读的值」的画法。全页共用，免得三处各写各的圆角和底色。 */
const READONLY_VALUE = 'min-w-0 flex-1 break-words rounded-md border border-border bg-surface px-2.5 py-1.5 text-sm'

/**
 * 打码后的密码。长度写死 10 位，不跟真实长度走：长度是暴力破解要猜的第一个参数（穷举空间 N^L），列
 * 表页会同时摊开几十条，泄露面比详情页大得多，宁可看起来假一点。列表和详情共用，免得打码长度不一
 * 致。
 */
function maskOf(password: string): string {
  return password ? '•'.repeat(10) : ''
}

const STRENGTH_BAR_COUNT: Record<PasswordStrength, number> = { weak: 1, fair: 2, good: 3, strong: 4 }
/**
 * 强度条四档配色，用语义色 token（index.css，深浅两套）：危险 → 警告 → 成功的淡版 → 成功，与全应用"
 * 红=有问题、琥珀=要注意、绿=没问题"一致。写死的 Tailwind 色（orange/yellow/green-500）不随主题变，
 * 且 yellow-500 浅色下对比度低。
 */
const STRENGTH_BAR_COLOR: Record<PasswordStrength, string> = {
  weak: 'bg-destructive',
  fair: 'bg-warning',
  good: 'bg-success/60',
  strong: 'bg-success',
}

const STRENGTH_LABEL_KEY: Record<PasswordStrength, string> = {
  weak: 'strengthWeakLabel',
  fair: 'strengthFairLabel',
  good: 'strengthGoodLabel',
  strong: 'strengthStrongLabel',
}

const STRENGTH_TONE = {
  weak: 'danger',
  fair: 'warning',
  good: 'info',
  strong: 'success',
} as const

function PasswordStrengthMeter({ password }: { password: string }) {
  const { t } = useTranslation('passwords')
  const strength = computePasswordStrength(password)
  if (!strength) return null
  const filled = STRENGTH_BAR_COUNT[strength]
  return (
    <div className="flex items-center gap-2">
      <div className="flex gap-1">
        {[0, 1, 2, 3].map((i) => (
          <span
            key={i}
            className={cn('h-1.5 w-6 rounded-full', i < filled ? STRENGTH_BAR_COLOR[strength] : 'bg-muted')}
          />
        ))}
      </div>
      <span className="text-sm text-muted-foreground">
        {t('strengthMeterLabel', { level: t(STRENGTH_LABEL_KEY[strength]) })}
      </span>
    </div>
  )
}

function accountKey(url: string, username: string): string {
  return `${hostnameOf(url)} ${username.trim()}`
}

const CLIPBOARD_AUTO_CLEAR_MS = 30_000

// 复制密码后 30 秒自动清空剪贴板（v4 需求文档四，安全性）。实现在 src/lib/clipboard.ts，恢复密钥页
// 共用。不能走 navigator.clipboard：30 秒后窗口早已失焦，网页剪贴板会抛 NotAllowedError: Document
// is not focused，明文密码留在剪贴板里。
function copyPasswordWithAutoClear(password: string) {
  void copyTextWithAutoClear(password, CLIPBOARD_AUTO_CLEAR_MS)
}

type PasswordGroup = { key: string; head: PasswordEntry; extra: PasswordEntry[] }

export function PasswordScreen({ isProfessional = false }: { isProfessional?: boolean } = {}) {
  const { t } = useTranslation('passwords')
  const { t: tCommon } = useTranslation('common')
  const [entries, setEntries] = useState<PasswordEntry[]>([])
  const [search, setSearch] = useState('')
  const [revealed, setRevealed] = useState<Record<string, boolean>>({})
  /** 一次掀开整列。不落盘——换个页面回来一律恢复成打码。 */
  const [revealAll, setRevealAll] = useState(false)
  const [editing, setEditing] = useState<PasswordEntry | 'new' | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [importPath, setImportPath] = useState<string | null>(null)
  const [sortMode, setSortMode] = useState<PasswordSortMode>('recent')
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())
  const [historyEntry, setHistoryEntry] = useState<PasswordEntry | null>(null)
  // 详情面板存选中的 id 而非整个对象：编辑/刷新后自动跟着 entries 新数据走；条目被删后 find() 返回
  // undefined，面板自动回到未选中，无需额外清理。
  const [detailId, setDetailId] = useState<string | null>(null)
  const detailEntry = entries.find((e) => e.id === detailId) ?? null
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  // 用户挑了哪几个指标摆在标题行。存 localStorage，换页回来还是这几个。
  const [visibleMetrics, setVisibleMetrics] = useState<MetricId[]>(() => loadVisibleMetrics())
  const [metricPickerOpen, setMetricPickerOpen] = useState(false)
  // 当前正被哪个指标筛着。null = 不筛。它同时是磁贴的按下态和筛选下拉框的值——
  // 一个状态两个入口，不会出现"下拉框写着弱密码、磁贴却没高亮"这种自相矛盾。
  const [metricFilter, setMetricFilter] = useState<MetricId | null>(null)

  // Delete confirmation dialog state
  const [breached, setBreached] = useState<Record<string, number>>({})
  const [breachChecking, setBreachChecking] = useState(false)
  const [breachConfirmOpen, setBreachConfirmOpen] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState<{
    open: boolean; kind: 'single' | 'bulk' | 'dedupe'; id?: string; ids?: string[]; count: number
  }>({ open: false, kind: 'single', count: 0 })
  // Undo stash: stores deleted entries for up to 30s, keyed by entry id
  const undoStashRef = useRef<PasswordEntry[]>([])

  async function reload() {
    // password_list 没有自己的 {ok:false} 分支：失败（金库被锁、文件损坏）表现为 REJECTED promise（见
    // pythonBridge.ts：传输层 `error` 才 reject，RPC 层 {ok:false} 是 resolve），所以需要 try/catch 而
    // 非 `if (!res.ok)`。
    try {
      const res = await vaultApi.call('password_list', {})
      setEntries(res.entries)
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

  useEffect(() => {
    reload()
    vaultApi.call('password_sort_mode_get', {}).then((res) => {
      if (res.ok) setSortMode(res.sort_mode)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-once: reload is a fresh function each render but always does the same thing, re-running it on every render would just be redundant fetches
  }, [])

  async function handleSortModeChange(mode: PasswordSortMode) {
    setSortMode(mode) // 立即生效，不等后端确认
    const res = await vaultApi.call('password_sort_mode_set', { sort_mode: mode })
    if (!res.ok) {
      toast.error(t('sortModeFailedToast'), { description: translateError(res.error, res.error_params) })
    }
  }

  const debouncedSearch = useDebouncedValue(search, 150)

  // 指标算一次，全页共用。时间只在 entries 变化时取一次，不是每次渲染：否则「陈旧」判定会在两次渲染间
  // 漂移，同一条一会儿陈旧一会儿不。页面时间尺度是"天"，会话内不必重取。
  const metricContext = useMemo(
    () => buildMetricContext(entries, Math.floor(Date.now() / 1000)),
    [entries],
  )

  const filtered = useMemo(() => {
    const q = debouncedSearch.toLowerCase()
    const filterDef = metricFilter ? METRIC_BY_ID[metricFilter] : null
    return entries.filter((e) => {
      if (q && !(e.name.toLowerCase().includes(q) || e.url.toLowerCase().includes(q) || e.username.toLowerCase().includes(q))) return false
      if (filterDef?.match && !filterDef.match(e, metricContext)) return false
      return true
    })
  }, [entries, debouncedSearch, metricFilter, metricContext])

  // 同网址+同用户名的多条独立记录（老数据）在主列表只显示最新一条（组头），其余折叠进"展开"；纯展示分
  // 组，不改底层数据。真正的密码修改历史（记录的 history 字段）走历史版本弹窗，与此无关。
  const groups: PasswordGroup[] = useMemo(() => {
    const byKey = new Map<string, PasswordEntry[]>()
    for (const e of filtered) {
      const key = accountKey(e.url, e.username)
      const arr = byKey.get(key)
      if (arr) arr.push(e)
      else byKey.set(key, [e])
    }
    const result = [...byKey.entries()].map(([key, members]) => {
      const sorted = [...members].sort((a, b) => b.updated_at - a.updated_at)
      return { key, head: sorted[0], extra: sorted.slice(1) }
    })
    switch (sortMode) {
      case 'alphabetical':
        result.sort((a, b) => a.head.name.localeCompare(b.head.name))
        break
      case 'host':
        result.sort((a, b) => hostnameOf(a.head.url).localeCompare(hostnameOf(b.head.url)))
        break
      default:
        result.sort((a, b) => b.head.updated_at - a.head.updated_at)
    }
    return result
  }, [filtered, sortMode])

  // Flatten groups into rows for the virtualizer. Each group head is a row;
  // if the group is expanded, its extra entries follow immediately after.
  const flatRows = useMemo(() => {
    const rows: { entry: PasswordEntry; groupKey: string; isExtra: boolean; extraCount: number }[] = []
    for (const g of groups) {
      rows.push({ entry: g.head, groupKey: g.key, isExtra: false, extraCount: g.extra.length })
      if (expandedGroups.has(g.key)) {
        for (const e of g.extra) rows.push({ entry: e, groupKey: g.key, isExtra: true, extraCount: 0 })
      }
    }
    return rows
  }, [groups, expandedGroups])

  const listRef = useRef<HTMLDivElement>(null)
  const rowVirtualizer = useVirtualizer({
    count: flatRows.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => 60,
    overscan: 10,
    // 按行的身份给键，不能用默认下标：react-virtual 的测量缓存也按此键存，列表常重排（搜索、排序、展开/
    // 收起、删除），缓存会套到别的记录上，表现为行高忽大忽小、滚动位置乱跳，只在重排后出现（见
    // tests/clipboardVirtualRows.test.mjs）。键里必须带 isExtra：同一条记录可同时作为分组头和展开子项出
    // 现，只用 id 会撞键。
    getItemKey: (index) => {
      const row = flatRows[index]
      return row ? `${row.groupKey}:${row.entry.id}:${row.isExtra ? 'x' : 'h'}` : index
    },
    measureElement:
      typeof window !== 'undefined' && 'ResizeObserver' in window
        ? (el) => el.getBoundingClientRect().height
        : undefined,
  })

  function toggleGroupExpanded(key: string) {
    setExpandedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  // 过滤/刷新后选中集合可能残留已不在当前列表的 id（换搜索词、删除/去重），每次渲染前收紧一遍，全选框
  // 和"已选 N 项"才不显示假数据。
  const filteredIds = useMemo(() => new Set(filtered.map((e) => e.id)), [filtered])
  const visibleSelectedIds = useMemo(
    () => [...selectedIds].filter((id) => filteredIds.has(id)),
    [selectedIds, filteredIds],
  )
  const allFilteredSelected = filtered.length > 0 && visibleSelectedIds.length === filtered.length

  /*
   * 右栏默认落在第一条上，而不是一句「选择左侧一条记录查看详情」（1920×1080 下右栏 1266×872，原先只有
   * 一行字）。进密码页几乎总要看某一条，先落第一条成本为零。只在"当前没有选中"时补，不覆盖已选的；筛
   * 选后第一条变了也跟着走，否则右栏记录不在左栏列表里。
   */
  useEffect(() => {
    if (loading) return
    if (detailId !== null && filteredIds.has(detailId)) return
    setDetailId(filtered.length > 0 ? filtered[0].id : null)
  }, [loading, detailId, filteredIds, filtered])

  // 应用内快捷键：只在密码页挂载期间生效（不注册系统级全局热键，避免与其它软件冲突）。任何弹窗打开或
  // 焦点在输入框时不拦截。Ctrl+C 复制密码需恰好选中一条，用列表已有的勾选框，不另造"当前聚焦行"概念。
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (!(e.ctrlKey || e.metaKey)) return
      const target = e.target as HTMLElement | null
      const isEditableTarget =
        target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || !!target?.isContentEditable
      if (isEditableTarget || editing !== null || importPath !== null || historyEntry !== null) return

      const key = e.key.toLowerCase()
      if (key === 'f') {
        e.preventDefault()
        document.getElementById('pw-search')?.focus()
      } else if (key === 'n') {
        e.preventDefault()
        setEditing('new')
      } else if (key === 'c' && visibleSelectedIds.length === 1) {
        const targetEntry = filtered.find((x) => x.id === visibleSelectedIds[0])
        if (targetEntry) {
          e.preventDefault()
          copyPasswordWithAutoClear(targetEntry.password)
          toast.success(t('copyShortcutToast'))
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [editing, importPath, historyEntry, visibleSelectedIds, filtered, t])

  function toggleSelected(id: string, checked: boolean) {
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

  const applyVisibleMetrics = useCallback((ids: MetricId[]) => {
    setVisibleMetrics(ids)
    saveVisibleMetrics(ids)
  }, [])

  async function handleDelete(id: string) {
    setDeleteConfirm({ open: true, kind: 'single', id, count: 1 })
  }

  async function executeDeleteSingle() {
    const id = deleteConfirm.id!
    const entry = entries.find((e) => e.id === id)
    setDeleteConfirm({ open: false, kind: 'single', count: 0 })
    setEntries((prev) => prev.filter((e) => e.id !== id))
    setSelectedIds((prev) => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
    if (detailId === id) setDetailId(null)
    const res = await vaultApi.call('password_delete', { id })
    if (!res.ok) {
      toast.error(t('deleteFailedToast'), { description: translateError(res.error, res.error_params) })
      await reload()
      return
    }
    if (entry) undoStashRef.current = [entry]
    toast.success(t('deletedToast'), {
      action: { label: t('undoButton'), onClick: handleUndo },
    })
  }

  // toast 里内联 `<Button>` JSX 啰嗦，sonner 的 toast options.action 只接受 {label, onClick}，这也是
  // vrbo plugin 里的标准模式。
  function handleUndo() {
    const stashed = undoStashRef.current
    undoStashRef.current = []
    if (stashed.length === 0) return
    vaultApi.call('password_undo_delete', { entries: stashed.map((e) => ({...e})) })
    setEntries((prev) => [...stashed, ...prev])
  }

  // 要求可多选且删除要快：一次 RPC 删完所有选中条目（后端只解密/重新加密写入一次），不对每个 id 循环
  // 调单条删除。
  async function handleBulkDelete() {
    const ids = visibleSelectedIds
    if (ids.length === 0) return
    setDeleteConfirm({ open: true, kind: 'bulk', ids, count: ids.length })
  }

  async function executeBulkDelete() {
    const ids = deleteConfirm.ids!
    setDeleteConfirm({ open: false, kind: 'single', count: 0 })
    setEntries((prev) => prev.filter((e) => !ids.includes(e.id)))
    if (ids.includes(detailId ?? '')) setDetailId(null)
    setSelectedIds(new Set())
    if (undoStashRef.current.length === 0) {
      // stash the matching entries so undo can restore them
      undoStashRef.current = entries.filter((e) => ids.includes(e.id))
    }
    const res = await vaultApi.call('password_delete_bulk', { ids })
    if (!res.ok) {
      toast.error(t('deleteFailedToast'), { description: translateError(res.error, res.error_params) })
      await reload()
      return
    }
    toast.success(t('bulkDeletedToast', { count: res.deleted_count }), {
      action: { label: t('undoButton'), onClick: handleUndo },
    })
  }

  // 备注/密码/用户名/网址/名称五项全一致才算重复，每组保留最早一条。泄露核查结果只活在本次会话里，不
  // 落盘、不跟条目走：它只是"此刻这条密码在公开泄露库出现过"的结论，存下来只会多一份要保护且会过期的
  // 东西。
  async function handleBreachCheck() {
    setBreachChecking(true)
    try {
      const res = await vaultApi.call('password_breach_check', {})
      if (!res.ok) {
        toast.error(t('breachFailedToast'), { description: translateError(res.error, res.error_params) })
        return
      }
      setBreached(res.breached)
      const hits = Object.keys(res.breached).length
      if (hits === 0) {
        toast.success(t('breachNoneToast', { checked: res.checked }))
      } else {
        toast.warning(t('breachFoundToast', { count: hits, checked: res.checked }))
      }
    } finally {
      setBreachChecking(false)
    }
  }

  async function handleDedupe() {
    const res = await vaultApi.call('password_dedupe_preview', {})
    if (!res.ok) {
      toast.error(t('dedupeFailedToast'), { description: translateError(res.error, res.error_params) })
      return
    }
    if (res.duplicate_ids.length === 0) {
      toast.info(t('dedupeNoneFoundToast'))
      return
    }
    setDeleteConfirm({ open: true, kind: 'dedupe', ids: res.duplicate_ids, count: res.duplicate_ids.length })
  }

  async function executeDedupe() {
    setDeleteConfirm({ open: false, kind: 'single', count: 0 })
    if (undoStashRef.current.length === 0) {
      // stash before deleting
      const ids = deleteConfirm.ids!
      undoStashRef.current = entries.filter((e) => ids!.includes(e.id))
    }
    const res = await vaultApi.call('password_dedupe', {})
    if (!res.ok) {
      toast.error(t('dedupeFailedToast'), { description: translateError(res.error, res.error_params) })
      return
    }
    toast.success(t('dedupeDeletedToast', { count: res.deleted_count }), {
      action: { label: t('undoButton'), onClick: handleUndo },
    })
    setSelectedIds(new Set())
    await reload()
  }

  // 选文件后不直接写入：先弹 ImportPreviewDialog，用户确认勾选后才调 password_import_csv_confirm（v4
  // 需求文档要求写入前可预览"新增/更新"并可取消勾选）。
  async function handleImport() {
    const paths = await electronApi.openFiles({
      title: t('importDialogTitle'),
      properties: ['openFile'],
      filters: [
        { name: 'CSV', extensions: ['csv'] },
        { name: t('allFilesFilter'), extensions: ['*'] },
      ],
    })
    if (!paths || paths.length === 0) return
    setImportPath(paths[0])
  }

  // 与 NotesScreen/RecoveryCodesScreen 同款整屏拖放导入；拖放只是给 importPath 换了来源，复用同一条
  // ImportPreviewDialog 流程。
  function handleDropCsv(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    const paths = Array.from(event.dataTransfer.files)
      .map((file) => electronApi.getPathForFile(file))
      .filter((path) => /\.csv$/i.test(path))
    if (paths.length === 0) {
      toast.error(t('dropUnsupportedToast'))
      return
    }
    setImportPath(paths[0])
  }

  async function handleExport() {
    const outputPath = await electronApi.saveFile({
      title: t('exportDialogTitle'),
      defaultPath: 'passwords.csv',
    })
    if (!outputPath) return
    const res = await vaultApi.call('password_export_csv', { output_path: outputPath })
    if (!res.ok) {
      toast.error(t('exportFailedToast'), { description: translateError(res.error, res.error_params) })
      return
    }
    toast.success(t('exportCompleteToast'), {
      action: { label: t('openFolderAction'), onClick: () => electronApi.showItemInFolder(res.output_path) },
    })
  }

  /** 能拿去筛列表的那些指标（汇总型的点了没意义，不进筛选框）。 */
  const filterableMetrics = useMemo(() => PASSWORD_METRICS.filter((m) => m.match && m.id !== 'total'), [])

  return (
    // width="canvas" 而非 "wide"：工作台是双栏，锁在 1440px 居中会留大片空白并让左栏装不下内容，见
    // page.tsx 的 PageShell 注释。
    <PageShell width="canvas" fill onDragOver={(event) => event.preventDefault()} onDrop={handleDropCsv}>
      {/*
        指标长在标题行里，**永远占着那一格**——哪怕还在加载、哪怕一条密码都没有。
        以前这里带条件渲染：进页面时它不存在，数据回来后凭空插进来一整行，下面的
        搜索框、列表、编辑区**整体往下跳一截**。那就是"密码管理界面会自己移动"的
        来源。占位（加载时显示 —，空库时显示 0）之后，首帧到数据到齐期间页面高度
        不变，视觉上完全静止。

        计数型指标都能点：「弱密码 3」告诉你有 3 条有问题，但不告诉你是哪 3 条——
        点一下直接把列表筛成那 3 条。没有数据可筛时（加载中 / 读失败 / 空库）
        不挂 onClick，避免点了没反应。
      */}
      <PageHeader
        title={t('pageTitle')}
        metrics={
          <MetricStrip
            ids={visibleMetrics}
            entries={entries}
            ctx={metricContext}
            ready={!loading && !loadError}
            activeFilter={metricFilter}
            onToggleFilter={(id) => setMetricFilter((v) => (v === id ? null : id))}
          />
        }
        actions={
          <>
            <ActionButton
              label={t('metricPickerButton')}
              icon={SlidersHorizontal}
              region={LABEL_REGIONS.passwordToolbar}
              variant="outline"
              onClick={() => setMetricPickerOpen(true)}
            />
            <ActionButton
              label={t('importCsvButton')}
              icon={Upload}
              region={LABEL_REGIONS.passwordToolbar}
              variant="outline"
              onClick={handleImport}
            />
            <ActionButton
              label={t('exportCsvButton')}
              icon={Download}
              region={LABEL_REGIONS.passwordToolbar}
              variant="outline"
              onClick={handleExport}
            />
            {/* 这是金库里唯一一个会联网的按钮，所以先弹一次说明再跑，
                不做成点了就走。 */}
            <ActionButton
              label={t('breachCheckButton')}
              icon={ShieldX}
              region={LABEL_REGIONS.passwordToolbar}
              variant="outline"
              disabled={breachChecking || entries.length === 0}
              onClick={() => setBreachConfirmOpen(true)}
            />
            {isProfessional && (
              <ActionButton
                label={t('dedupeButton')}
                icon={Layers}
                region={LABEL_REGIONS.passwordToolbar}
                variant="outline"
                onClick={handleDedupe}
              />
            )}
            {/* 这一页最重要的动作，固定在标题行最右——全应用同一个位置。 */}
            <Button onClick={() => setEditing('new')} title={t('addShortcutHint')}>
              <Plus className="size-4" aria-hidden="true" />
              {t('addButton')}
            </Button>
          </>
        }
      />

      {/*
        左选右看，走全应用共用的 <Workbench>。这里以前是就地写死的
        `flex gap-4` + `lg:max-w-[45%]` + `h-[420px]`——三个数只在这一页成立，
        别的列表页各写各的，于是同样一件事在每一页的比例、滚动范围、窄窗口
        表现都不一样。换成共用组件之后，改一次全家跟着变。
      */}
      <Workbench
        listWidth="wide"
        listRef={listRef}
        selected={detailEntry !== null}
        onBack={() => setDetailId(null)}
        backLabel={tCommon('backToList')}
        listHeader={
          <>
            {/*
              左栏顶部只留**搜索 + 两个下拉**。
              以前这里堆着搜索、新建、导入、导出、去重、排序、强度筛选、全选
              八件东西，竖着排掉小半个左栏高度——而左栏的全部价值是"一眼看到
              尽可能多的条目"。导入/导出/去重/新建都搬去了标题行（它们作用于
              整个页面，本来就不属于列表的局部工具），这里只留跟"找到那一条"
              直接相关的三件。
            */}
            <Input
              id="pw-search"
              placeholder={t('searchPlaceholder')}
              title={t('searchShortcutHint')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <div className="flex gap-2">
              <Select value={sortMode} onValueChange={(v) => handleSortModeChange(v as PasswordSortMode)}>
                <SelectTrigger id="pw-sort-mode" className="min-w-0 flex-1" title={t('sortModeLabel')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="recent">{t('sortModeRecent')}</SelectItem>
                  <SelectItem value="alphabetical">{t('sortModeAlphabetical')}</SelectItem>
                  <SelectItem value="host">{t('sortModeHost')}</SelectItem>
                </SelectContent>
              </Select>
              {/*
                筛选框列的是**指标表里所有计数型指标**，不再是写死的四档强度。
                加一个新指标，这个下拉框自动多一项——"可后续植入新功能"在这里
                是字面意义上的零成本。
              */}
              <Select
                value={metricFilter ?? 'all'}
                onValueChange={(v) => setMetricFilter(v === 'all' ? null : (v as MetricId))}
              >
                <SelectTrigger id="pw-metric-filter" className="min-w-0 flex-1" title={t('metricFilterLabel')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t('metricFilterAll')}</SelectItem>
                  {filterableMetrics.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {t(m.labelKey)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {filtered.length > 0 && (
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="pw-select-all"
                    checked={allFilteredSelected}
                    onCheckedChange={(v) => toggleSelectAll(v === true)}
                  />
                  <Label htmlFor="pw-select-all" className="text-sm text-muted-foreground">
                    {t('selectAllLabel')}
                  </Label>
                  {/*
                    一颗开关掀开**整列**密码，而不是每行各挂一颗眼睛按钮。
                    每行一颗是这一页上一版把左栏内容挤没的直接原因（五颗 shrink-0
                    的按钮 × 32px，420px 的列剩不下多少给名字）；而"看密码"这个
                    动作在实际使用里几乎总是连着看好几条——对账、改重复密码、
                    核对导入结果，一条条点等于把一个批量动作拆成 N 次。
                    默认关，且不写进 localStorage：离开这一页就恢复成打码。
                  */}
                  <ActionButton
                    label={revealAll ? t('hideAllButton') : t('showAllButton')}
                    icon={revealAll ? EyeOff : Eye}
                    region={LABEL_REGIONS.passwordToolbar}
                    variant="outline"
                    active={revealAll}
                    onClick={() => { setRevealAll((v) => !v); setRevealed({}) }}
                  />
                </div>
                {visibleSelectedIds.length > 0 && (
                  <div className="flex items-center gap-2">
                    <span className={cn('text-sm text-muted-foreground', NUMERIC_CLASS)}>
                      {t('selectedCountLabel', { count: visibleSelectedIds.length })}
                    </span>
                    <ActionButton
                      label={t('deleteSelectedButton')}
                      icon={Trash2}
                      region={LABEL_REGIONS.passwordRow}
                      variant="destructive"
                      onClick={handleBulkDelete}
                    />
                  </div>
                )}
              </div>
            )}
          </>
        }
        list={
          <>
            {loading && <p className="p-4 text-sm text-muted-foreground">{t('loading')}</p>}
            {!loading && loadError && (
              <div className="flex flex-col items-center gap-3 py-12">
                <p className="text-sm text-destructive">{loadError}</p>
                <Button variant="outline" size="sm" onClick={() => { setLoading(true); reload() }}>
                  {t('retryButton')}
                </Button>
              </div>
            )}
            {!loading && !loadError && filtered.length === 0 && (
              <p className="p-4 text-sm text-muted-foreground">{t('emptyList')}</p>
            )}
            <div style={{ height: rowVirtualizer.getTotalSize(), position: 'relative' }}>
              {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                const row = flatRows[virtualRow.index]
                if (!row) return null
                return (
                  <div
                    key={`${row.groupKey}:${row.entry.id}:${row.isExtra ? 'x' : 'h'}`}
                    ref={rowVirtualizer.measureElement}
                    data-index={virtualRow.index}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      transform: `translateY(${virtualRow.start}px)`,
                    }}
                  >
                    <PasswordRow
                      entry={row.entry}
                      indented={row.isExtra}
                      selected={selectedIds.has(row.entry.id)}
                      isDetailActive={detailId === row.entry.id}
                      reused={Boolean(row.entry.password) && metricContext.reusedPasswords.has(row.entry.password)}
                      breachCount={breached[row.entry.id]}
                      revealed={revealAll || !!revealed[row.entry.id]}
                      onToggleRevealed={() =>
                        setRevealed((r) => ({ ...r, [row.entry.id]: !(revealAll || r[row.entry.id]) }))
                      }
                      onOpenDetail={() => setDetailId(row.entry.id)}
                      onToggleSelected={(checked) => toggleSelected(row.entry.id, checked)}
                    />
                    {!row.isExtra && row.extraCount > 0 && (
                      <button
                        type="button"
                        className="ds-focus-ring flex w-full items-center gap-1 border-b border-border/50 py-1.5 ps-12 text-sm text-muted-foreground hover:text-foreground"
                        onClick={() => toggleGroupExpanded(row.groupKey)}
                      >
                        {expandedGroups.has(row.groupKey) ? (
                          <>
                            <ChevronDown className="size-3.5" aria-hidden="true" />
                            {t('collapseGroupLabel')}
                          </>
                        ) : (
                          <>
                            <ChevronRight className="size-3.5" aria-hidden="true" />
                            {t('expandGroupLabel', { count: row.extraCount })}
                          </>
                        )}
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          </>
        }
        detail={
          detailEntry && (
            <PasswordDetailPanel
              entry={detailEntry}
              allEntries={entries}
              revealed={!!revealed[detailEntry.id]}
              onToggleRevealed={() => setRevealed((r) => ({ ...r, [detailEntry.id]: !r[detailEntry.id] }))}
              onEdit={() => setEditing(detailEntry)}
              onDelete={() => handleDelete(detailEntry.id)}
              onViewHistory={() => setHistoryEntry(detailEntry)}
              onOpenEntry={(id) => setDetailId(id)}
            />
          )
        }
        placeholder={<EmptyState icon={KeyRound} title={t('detailEmptyState')} className="m-6" />}
      />

      <MetricPickerDialog
        open={metricPickerOpen}
        onOpenChange={setMetricPickerOpen}
        selected={visibleMetrics}
        onChange={applyVisibleMetrics}
      />

      {/* Delete Confirmation Dialog */}
      <Dialog open={breachConfirmOpen} onOpenChange={setBreachConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('breachConfirmTitle')}</DialogTitle>
            <DialogDescription>{t('breachConfirmBody')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBreachConfirmOpen(false)}>
              {t('cancelButton')}
            </Button>
            <Button
              onClick={() => {
                setBreachConfirmOpen(false)
                void handleBreachCheck()
              }}
            >
              {t('breachConfirmAction')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteConfirm.open} onOpenChange={(o) => !o && setDeleteConfirm({ ...deleteConfirm, open: false })}>
        <DialogContent className={CONFIRM_DIALOG}>
          <DialogHeader>
            <DialogTitle>
              {deleteConfirm.kind === 'dedupe' ? t('dedupeConfirmTitle') : t('deleteConfirmTitle')}
            </DialogTitle>
            <DialogDescription>
              {deleteConfirm.kind === 'dedupe'
                ? t('dedupeConfirmDescription', { count: deleteConfirm.count })
                : deleteConfirm.kind === 'bulk'
                  ? t('deleteConfirmBulkDescription', { count: deleteConfirm.count })
                  : t('deleteConfirmSingleDescription')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteConfirm({ open: false, kind: 'single', count: 0 })}>
              {t('cancelButton')}
            </Button>
            <Button
              variant="destructive"
              onClick={deleteConfirm.kind === 'bulk' ? executeBulkDelete : deleteConfirm.kind === 'dedupe' ? executeDedupe : executeDeleteSingle}
            >
              {t('deletePermanentConfirmButton')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <PasswordHistoryDialog
        entry={historyEntry}
        open={historyEntry !== null}
        onOpenChange={(o) => !o && setHistoryEntry(null)}
      />

      <PasswordEditDialog
        entry={editing === 'new' ? null : editing}
        open={editing !== null}
        onOpenChange={(o) => !o && setEditing(null)}
        onSaved={async () => {
          setEditing(null)
          await reload()
        }}
      />

      <ImportPreviewDialog
        inputPath={importPath}
        open={importPath !== null}
        onOpenChange={(o) => !o && setImportPath(null)}
        onImported={async () => {
          setImportPath(null)
          await reload()
        }}
      />
    </PageShell>
  )
}

/**
 * 标题行的指标条。只认指标 id 列表，指标定义和算法全在 lib/passwordMetrics.ts，加维度不用改这里。
 */
function MetricStrip({
  ids,
  entries,
  ctx,
  ready,
  activeFilter,
  onToggleFilter,
}: {
  ids: MetricId[]
  entries: PasswordEntry[]
  ctx: ReturnType<typeof buildMetricContext>
  ready: boolean
  activeFilter: MetricId | null
  onToggleFilter: (id: MetricId) => void
}) {
  const { t } = useTranslation('passwords')
  return (
    <>
      {ids.map((id) => {
        const def = METRIC_BY_ID[id]
        if (!def) return null
        const value = !ready
          ? '—'
          : def.summary
            ? def.summary(entries, ctx)
            : entries.filter((e) => def.match!(e, ctx)).length
        const clickable = ready && Boolean(def.match) && entries.length > 0
        return (
          <StatTile
            key={id}
            compact
            label={t(def.labelKey)}
            value={value}
            hint={t(def.hintKey)}
            active={activeFilter === id}
            onClick={clickable ? () => onToggleFilter(id) : undefined}
          />
        )
      })}
    </>
  )
}

/**
 * 指标选择器。十八个数字并排等于一个都读不到，而"哪几个重要"因人而异，所以让用户自己挑并记住。上限
 * MAX_VISIBLE_METRICS 是硬的：超出会让标题行折行、把列表往下推（"界面会自己移动"）。
 */
/** 可拖动的指标小标签。一颗一颗横着排，拖到哪儿就是第几个。 */
function SortableMetricChip({ id, label }: { id: MetricId; label: string }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
  return (
    <span
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      {...attributes}
      {...listeners}
      className={cn(
        'ds-focus-ring flex cursor-grab items-center gap-1.5 rounded-full border border-accent-line bg-accent-soft px-3 py-1 text-sm',
        isDragging && 'opacity-60',
      )}
    >
      <GripVertical className="size-3.5 text-muted-foreground" aria-hidden="true" />
      {label}
    </span>
  )
}

function MetricPickerDialog({
  open,
  onOpenChange,
  selected,
  onChange,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  selected: MetricId[]
  onChange: (ids: MetricId[]) => void
}) {
  const { t } = useTranslation('passwords')
  const full = selected.length >= MAX_VISIBLE_METRICS
  // 键盘也能拖：@dnd-kit 相对原生 HTML5 拖放的主要收益之一，跟剪贴板页那处
  // 置顶排序用的是同一套（见 ClipboardScreen.tsx）。
  const reorderSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  function handleReorder(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const from = selected.indexOf(active.id as MetricId)
    const to = selected.indexOf(over.id as MetricId)
    if (from < 0 || to < 0) return
    onChange(arrayMove(selected, from, to))
  }

  function toggle(id: MetricId, checked: boolean) {
    if (checked) {
      if (selected.includes(id) || full) return
      onChange([...selected, id])
    } else {
      onChange(selected.filter((x) => x !== id))
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={WIDE_FORM_DIALOG}>
        <DialogHeader>
          <DialogTitle>{t('metricPickerTitle')}</DialogTitle>
          <DialogDescription>
            {t('metricPickerCount', { n: selected.length, max: MAX_VISIBLE_METRICS })}
          </DialogDescription>
        </DialogHeader>
        <div className={FORM_BODY}>
          {/* 已选的那几个单独排一行，可以拖着换顺序。
              勾选决定"显示哪几个"，拖动决定"从左到右是什么次序"——两件事分开，
              因为它们的答案不一样：用户可能想看四个指标，但最关心的那个必须
              在最左边。以前只能靠"取消勾选再重新按顺序勾一遍"来间接排序，
              那是一种没人猜得到的操作。 */}
          {selected.length > 1 && (
            <div className="space-y-2">
              <InfoHint text={t('metricPickerReorderHint')} />
              <DndContext
                sensors={reorderSensors}
                collisionDetection={closestCenter}
                modifiers={[restrictToHorizontalAxis]}
                onDragEnd={handleReorder}
              >
                <SortableContext items={selected} strategy={horizontalListSortingStrategy}>
                  <div className="flex flex-wrap gap-2">
                    {selected.map((id) => (
                      <SortableMetricChip key={id} id={id} label={t(METRIC_BY_ID[id].labelKey)} />
                    ))}
                  </div>
                </SortableContext>
              </DndContext>
            </div>
          )}
          <div className="grid gap-2.5 sm:grid-cols-2">
            {PASSWORD_METRICS.map((m) => {
              const checked = selected.includes(m.id)
              return (
                <label
                  key={m.id}
                  className={cn(
                    'flex cursor-pointer items-start gap-2.5 rounded-lg border border-border bg-surface p-3 transition-colors',
                    checked && 'border-accent-line bg-accent-soft',
                    !checked && full && 'cursor-not-allowed opacity-55',
                  )}
                >
                  <Checkbox
                    className="mt-0.5 shrink-0"
                    checked={checked}
                    disabled={!checked && full}
                    onCheckedChange={(v) => toggle(m.id, v === true)}
                  />
                  <span className="min-w-0 flex-1 space-y-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{t(m.labelKey)}</span>
                      <Badge tone={m.tone}>{t(m.summary ? 'metricKindSummary' : 'metricKindFilter')}</Badge>
                    </span>
                    <span className="block text-sm text-muted-foreground">{t(m.hintKey)}</span>
                    {m.formula && <Formula tex={m.formula} label={t(m.labelKey)} className="block" />}
                  </span>
                </label>
              )
            })}
          </div>
        </div>
        <div className="flex shrink-0 flex-col-reverse gap-2.5 border-t border-border pt-5 sm:flex-row sm:justify-end">
          <Button variant="outline" onClick={() => onChange([...DEFAULT_VISIBLE_METRICS])}>
            {t('metricPickerReset')}
          </Button>
          <Button onClick={() => onOpenChange(false)}>{t('metricPickerDone')}</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/**
 * 左栏一条记录，不放操作按钮：原先五颗按钮加勾选框在最宽 420px 的左栏放不下，文字列被挤到零宽（"显
 * 示不全"的根因）；且工作台约定是操作固定在右栏顶部，左栏只负责挑哪一条。左栏一行只留名字、账号、强
 * 度、是否被重复使用。
 */
function PasswordRow({
  entry,
  indented,
  selected,
  isDetailActive,
  reused,
  breachCount,
  revealed,
  onToggleRevealed,
  onOpenDetail,
  onToggleSelected,
}: {
  entry: PasswordEntry
  /** 分组展开后的子条目，缩进一档以示从属。 */
  indented: boolean
  selected: boolean
  isDetailActive: boolean
  reused: boolean
  /** 这条密码在公开泄露库里出现过多少次。没查过或没查到时是 undefined。 */
  breachCount?: number
  revealed: boolean
  onToggleRevealed: () => void
  onOpenDetail: () => void
  onToggleSelected: (checked: boolean) => void
}) {
  const { t } = useTranslation('passwords')
  const strength = computePasswordStrength(entry.password)
  return (
    <div
      role="button"
      tabIndex={0}
      aria-current={isDetailActive ? 'true' : undefined}
      onClick={onOpenDetail}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpenDetail() } }}
      className={cn(
        'ds-focus-ring flex w-full cursor-pointer items-center gap-2.5 border-b border-border/50 px-4 py-2.5 text-start transition-colors',
        'hover:bg-accent-soft/60',
        indented && 'ps-9',
        // 选中态是左边一条 2px 的强调色竖线加一层浅底，不是整行反白——
        // 整行反白在浅色主题下会把这一行的文字对比度打翻。跟 WorkbenchItem 同款。
        isDetailActive ? 'bg-accent-soft shadow-[inset_2px_0_0_var(--primary)]' : 'bg-transparent',
      )}
    >
      {/* stopPropagation - 勾选框是批量删除用的独立选择机制，跟"点这一行
          打开右侧详情"是两回事，点勾选框不该顺带把详情面板切换掉。 */}
      <div onClick={(e) => e.stopPropagation()} className="shrink-0">
        <Checkbox
          checked={selected}
          onCheckedChange={(v) => onToggleSelected(v === true)}
          aria-label={t('selectEntryAriaLabel', { name: entry.name })}
        />
      </div>
      {/* 强度是一根竖条而不是一个词：它要在一列几十行里被**扫**出来，
          不是被读出来。颜色 + 高度双编码，色觉障碍用户靠高度也能分辨。 */}
      <span
        aria-hidden="true"
        title={strength ? t(STRENGTH_LABEL_KEY[strength]) : undefined}
        className="flex h-7 w-1 shrink-0 flex-col-reverse overflow-hidden rounded-full bg-muted"
      >
        {strength && (
          <span
            className={cn('w-full rounded-full', STRENGTH_BAR_COLOR[strength])}
            style={{ height: `${(STRENGTH_BAR_COUNT[strength] / 4) * 100}%` }}
          />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{entry.name}</p>
        {/*
          第二行左边是账号、右边是密码本身。
          这一页叫「密码管理」，而上一版的列表里**一条密码都看不到**——名字、
          账号、强度条都有，唯独没有这一页存在的理由那一样东西。想看必须点开
          右栏再点一次眼睛，两次点击换一个本该一直在屏幕上的值。
          放在第二行右侧而不是单开一列：单开一列要写死宽度，420px 的左栏里
          切走 144px 之后名字就没地方了；跟账号并排则是**共享**同一行的剩余
          宽度，谁长谁多占，两边都不会被压到零。
        */}
        <p className="flex items-baseline gap-2 text-sm text-muted-foreground">
          <span className="min-w-0 flex-1 truncate">{entry.username || hostnameOf(entry.url)}</span>
          <span
            role="button"
            tabIndex={0}
            title={revealed ? t('hideButton') : t('showButton')}
            aria-label={`${t('passwordLabel')}: ${revealed ? t('hideButton') : t('showButton')}`}
            onClick={(e) => { e.stopPropagation(); onToggleRevealed() }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onToggleRevealed() }
            }}
            className={cn(
              'ds-focus-ring max-w-[55%] shrink-0 cursor-pointer truncate rounded font-mono text-foreground/75 hover:text-foreground',
              NUMERIC_CLASS,
            )}
          >
            {revealed ? entry.password : maskOf(entry.password)}
          </span>
        </p>
      </div>
      {reused && (
        <span className="shrink-0" title={t('metricReusedLabel')}>
          <ShieldAlert className="size-4 text-warning" aria-label={t('metricReusedLabel')} />
        </span>
      )}
      {/* 泄露用危险色而不是警告色，且排在"重复使用"右边：一条密码可以既重复
          又泄露，两个标记要能同时看见。 */}
      {breachCount !== undefined && breachCount > 0 && (
        <span className="shrink-0" title={t('breachRowHint', { count: breachCount })}>
          <ShieldX className="size-4 text-destructive" aria-label={t('breachRowHint', { count: breachCount })} />
        </span>
      )}
      <div onClick={(e) => e.stopPropagation()} className="shrink-0">
        <ActionButton
          label={t('copyButton')}
          icon={Copy}
          region={LABEL_REGIONS.passwordRow}
          onClick={() => copyPasswordWithAutoClear(entry.password)}
        />
      </div>
    </div>
  )
}

function PasswordDetailPanel({
  entry,
  allEntries,
  revealed,
  onToggleRevealed,
  onEdit,
  onDelete,
  onViewHistory,
  onOpenEntry,
}: {
  entry: PasswordEntry
  allEntries: PasswordEntry[]
  revealed: boolean
  onToggleRevealed: () => void
  onEdit: () => void
  onDelete: () => void
  onViewHistory: () => void
  onOpenEntry: (id: string) => void
}) {
  const { t } = useTranslation('passwords')
  const entropyBits = useMemo(() => passwordEntropyBits(entry.password), [entry.password])
  const strength = computePasswordStrength(entry.password)
  const shared = useMemo(() => blastRadius(entry, allEntries), [entry, allEntries])
  const [attacker, setAttacker] = useState<AttackerModel>('offlineFastHash')

  return (
    <>
      {/* 操作按钮固定在右栏顶部——全应用同一条规则：主操作永远在同一个位置。
          五颗都带悬停提示（ActionButton 强制要求 label，Tooltip 无条件挂着）。 */}
      <WorkbenchDetailHeader
        icon={KeyRound}
        tone={strength ? STRENGTH_TONE[strength] : 'accent'}
        title={entry.name}
        actions={
          <>
            {/* 「显示/隐藏」不在这一排。它只作用于下面那一个字段，而这一排
                是**对整条记录**的操作（复制、历史、编辑、删除）——两种作用域
                混在一起，用户就得先想一下"这个显示是显示什么"。
                它挂在密码字段自己的右边（见下面 DetailField 的 extra），
                原先两处各有一颗，同一个功能在同一屏出现两次。 */}
            <ActionButton
              label={t('copyButton')}
              icon={Copy}
              region={LABEL_REGIONS.passwordDetailToolbar}
              variant="outline"
              onClick={() => copyPasswordWithAutoClear(entry.password)}
            />
            <ActionButton
              label={t('viewHistoryButton')}
              icon={Clock3}
              region={LABEL_REGIONS.passwordDetailToolbar}
              variant="outline"
              onClick={onViewHistory}
            />
            <ActionButton
              label={t('editButton')}
              icon={Pencil}
              region={LABEL_REGIONS.passwordDetailToolbar}
              variant="outline"
              onClick={onEdit}
            />
            <ActionButton
              label={t('deleteButton')}
              icon={Trash2}
              region={LABEL_REGIONS.passwordDetailToolbar}
              variant="destructive"
              onClick={onDelete}
            />
          </>
        }
      />
      <WorkbenchDetailBody>
        <div className="flex flex-wrap items-center gap-2">
          {strength && <Badge tone={STRENGTH_TONE[strength]}>{t(STRENGTH_LABEL_KEY[strength])}</Badge>}
          {shared.length > 0 && (
            <Badge tone="warning" icon={ShieldAlert}>
              {t('blastRadiusBadge', { count: shared.length })}
            </Badge>
          )}
          <span className={cn('text-sm text-muted-foreground', NUMERIC_CLASS)}>
            {t('updatedAtLabel')}: {new Date(entry.updated_at * 1000).toLocaleString()}
          </span>
        </div>

        {/* 两列：短字段并排，宽屏下右栏不再是一条细长的单列。窄屏自动堆叠。 */}
        <div className="grid gap-x-6 gap-y-4 xl:grid-cols-2">
          <DetailField label={t('urlLabel')} onCopy={() => void copyText(entry.url)}>
            {entry.url}
          </DetailField>
          <DetailField label={t('usernameLabel')} onCopy={() => void copyText(entry.username)}>
            {entry.username}
          </DetailField>
          <DetailField
            label={t('passwordLabel')}
            mono
            onCopy={() => copyPasswordWithAutoClear(entry.password)}
            extra={
              <ActionButton
                label={revealed ? t('hideButton') : t('showButton')}
                icon={revealed ? EyeOff : Eye}
                region={LABEL_REGIONS.passwordDetailToolbar}
                variant="outline"
                onClick={onToggleRevealed}
              />
            }
          >
            {revealed ? entry.password : maskOf(entry.password)}
          </DetailField>
          {entropyBits !== null && (
            <div className={FIELD}>
              <Label className="text-sm text-muted-foreground">{t('entropyLabel')}</Label>
              <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 rounded-md border border-border bg-surface px-2.5 py-1.5">
                <span className={cn('text-sm', NUMERIC_CLASS)}>{entropyBits.toFixed(1)} bit</span>
                <Formula tex={FORMULAS.passwordEntropy} label={t('entropyFormulaLabel')} />
              </div>
            </div>
          )}
        </div>

        {/*
          破解时间。
          「62.4 bit」对绝大多数人不构成任何判断依据——它需要先换算成"多久能被
          试出来"，而那个换算取决于攻击者是谁。所以这里把攻击者模型做成一个能
          换的下拉框：同一条密码，在有限速的网站上是几万年，在拖库+快哈希的
          场景下可能是几分钟。**能换的那一下正是这块内容的意义**，写死任何一档
          都是在替用户假设他面对的是哪种威胁。
        */}
        {entropyBits !== null && (
          <div className={FIELD}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Label className="text-sm text-muted-foreground">{t('crackTimeLabel')}</Label>
              <Select value={attacker} onValueChange={(v) => setAttacker(v as AttackerModel)}>
                <SelectTrigger className="w-[15rem]" title={t('attackerModelLabel')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ATTACKER_MODELS.map((m) => (
                    <SelectItem key={m} value={m}>
                      {t(`attacker_${m}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 rounded-md border border-border bg-surface px-2.5 py-1.5">
              <span className={cn('text-sm', NUMERIC_CLASS)}>
                <CrackTimeText seconds={crackSeconds(entropyBits, ATTACKER_RATES[attacker])} />
              </span>
              <Formula tex={FORMULAS.crackTime} label={t('crackTimeFormulaLabel')} />
            </div>
          </div>
        )}

        {/*
          爆炸半径。「重复使用 5」告诉你有问题，这里告诉你**一旦这条泄露，
          还有谁跟着完蛋**——那才是拿来做决定的信息：先改哪一条。
          每一条都能点，直接跳过去改。
        */}
        {shared.length > 0 && (
          <div className={FIELD}>
            <Label className="text-sm text-muted-foreground">{t('blastRadiusLabel')}</Label>
            <ul className="divide-y divide-border overflow-hidden rounded-md border border-border bg-surface">
              {shared.map((other) => (
                <li key={other.id}>
                  <button
                    type="button"
                    onClick={() => onOpenEntry(other.id)}
                    className="ds-focus-ring flex w-full items-center gap-2 px-2.5 py-1.5 text-start transition-colors hover:bg-accent-soft/60"
                  >
                    <span className="min-w-0 flex-1 truncate text-sm">{other.name}</span>
                    <span className="min-w-0 shrink-0 truncate text-sm text-muted-foreground">
                      {other.username || hostnameOf(other.url)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {entry.notes && (
          <div className={FIELD}>
            <Label className="text-sm text-muted-foreground">{t('notesLabel')}</Label>
            <p className="whitespace-pre-wrap break-words rounded-md border border-border bg-surface px-2.5 py-1.5 text-sm">
              {entry.notes}
            </p>
          </div>
        )}
      </WorkbenchDetailBody>
    </>
  )
}

/** 详情面板里的「标签 + 只读值 + 复制」。三处一样的结构，抽出来免得各写各的。 */
function DetailField({
  label,
  children,
  mono = false,
  onCopy,
  extra,
}: {
  label: string
  children: ReactNode
  mono?: boolean
  onCopy: () => void
  extra?: ReactNode
}) {
  const { t } = useTranslation('passwords')
  return (
    <div className={FIELD}>
      <Label className="text-sm text-muted-foreground">{label}</Label>
      <div className="flex items-center gap-2">
        <p className={cn(READONLY_VALUE, mono && 'font-mono')}>{children}</p>
        {extra}
        <ActionButton
          label={t('copyButton')}
          icon={Copy}
          region={LABEL_REGIONS.passwordDetailToolbar}
          variant="outline"
          onClick={onCopy}
        />
      </div>
    </div>
  )
}

function CrackTimeText({ seconds }: { seconds: number }) {
  const { t } = useTranslation('passwords')
  const { n, unit } = crackTimeParts(seconds)
  if (unit === 'instant') return <>{t('crackTimeInstant')}</>
  if (unit === 'eons') return <>{t('crackTimeEons')}</>
  // 用 `{{n}}` 而非 i18next 的 `count` 复数机制：单位键是动态拼出的，再叠复数后缀会让俄语和阿拉伯语各
  // 写六份，而"3 分钟 / 1 分钟"的区别对读数无价值。
  return <>{t(`crackTime_${unit}`, { n })}</>
}

function PasswordEditDialog({
  entry,
  open,
  onOpenChange,
  onSaved,
}: {
  entry: PasswordEntry | null
  open: boolean
  onOpenChange: (o: boolean) => void
  onSaved: () => void
}) {
  const { t } = useTranslation('passwords')
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [notes, setNotes] = useState('')
  const [error, setError] = useState('')
  const [generatorOpen, setGeneratorOpen] = useState(false)
  const [generator, setGenerator] = useState<GeneratorOptions>(DEFAULT_GENERATOR_OPTIONS)

  useEffect(() => {
    if (open) {
      setName(entry?.name ?? '')
      setUrl(entry?.url ?? '')
      setUsername(entry?.username ?? '')
      setPassword(entry?.password ?? '')
      setNotes(entry?.notes ?? '')
      setError('')
      setGeneratorOpen(false)
    }
  }, [open, entry])

  async function handleSave() {
    if (!name.trim() || !url.trim()) {
      setError(t('nameUrlRequired'))
      return
    }
    const params = { name, url, username, password, notes }
    if (entry) {
      const res = await vaultApi.call('password_update', { id: entry.id, ...params })
      if (!res.ok) {
        setError(translateError(res.error, res.error_params))
        return
      }
    } else {
      const res = await vaultApi.call('password_add', params)
      if (!res.ok) {
        setError(translateError(res.error, res.error_params))
        return
      }
      if (res.deduped) {
        toast.info(t('addSkippedDuplicateToast'))
      }
    }
    onSaved()
  }

  const generatorBits = generatorEntropyBits(generator)
  const generatorEmpty = !generator.lower && !generator.upper && !generator.digits && !generator.symbols

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* 五个字段 → 宽档 + 两列。分组按"这几件事在现实里是一伙的"来定：
          名称/网址是"这是哪个账号"，用户名/密码是"拿什么登进去"，备注最长、
          自己独占一行。 */}
      <DialogContent className={WIDE_FORM_DIALOG}>
        <DialogHeader>
          <DialogTitle>{entry ? t('editDialogTitleEdit') : t('editDialogTitleNew')}</DialogTitle>
        </DialogHeader>
        <div className={FORM_BODY}>
          <div className="grid gap-x-5 gap-y-5 sm:grid-cols-2">
            <div className={FIELD}>
              <Label htmlFor="pw-name">{t('nameLabel')}</Label>
              <Input id="pw-name" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className={FIELD}>
              <Label htmlFor="pw-url">{t('urlLabel')}</Label>
              <Input id="pw-url" value={url} onChange={(e) => setUrl(e.target.value)} />
            </div>
            <div className={FIELD}>
              <Label htmlFor="pw-username">{t('usernameLabel')}</Label>
              <Input id="pw-username" value={username} onChange={(e) => setUsername(e.target.value)} />
            </div>
            <div className={FIELD}>
              <Label htmlFor="pw-password">{t('passwordLabel')}</Label>
              <div className="flex items-center gap-2">
                <Input
                  id="pw-password"
                  className="min-w-0 flex-1"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <ActionButton
                  label={t('generatorButton')}
                  icon={Dices}
                  region={LABEL_REGIONS.passwordDetailToolbar}
                  variant="outline"
                  active={generatorOpen}
                  onClick={() => setGeneratorOpen((v) => !v)}
                />
              </div>
              <PasswordStrengthMeter password={password} />
            </div>
          </div>

          {/*
            生成器。指出"这条密码很弱"却不给替代品，用户只能去外面的在线生成器
            找一条——密码明文因此经过一个陌生网站，而这个应用的全部卖点是
            "密钥不出设备"。所以生成器必须内置，且必须用 crypto.getRandomValues
            （理由见 lib/passwordGenerator.ts）。
          */}
          {generatorOpen && (
            <div className="space-y-4 rounded-lg border border-accent-line bg-accent-soft/40 p-4">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <Label htmlFor="pw-gen-length" className="text-sm text-muted-foreground">
                  {t('generatorLengthLabel')}
                </Label>
                <input
                  id="pw-gen-length"
                  type="range"
                  min={GENERATOR_MIN_LENGTH}
                  max={GENERATOR_MAX_LENGTH}
                  value={generator.length}
                  onChange={(e) => setGenerator((g) => ({ ...g, length: Number(e.target.value) }))}
                  className="ds-focus-ring h-1.5 min-w-[10rem] flex-1 cursor-pointer appearance-none rounded-full bg-muted accent-[var(--primary)]"
                />
                <span className={cn('w-8 shrink-0 text-sm', NUMERIC_CLASS)}>{generator.length}</span>
              </div>
              <div className="flex flex-wrap gap-x-5 gap-y-2.5">
                {([
                  ['lower', 'generatorLower'],
                  ['upper', 'generatorUpper'],
                  ['digits', 'generatorDigits'],
                  ['symbols', 'generatorSymbols'],
                  ['excludeAmbiguous', 'generatorExcludeAmbiguous'],
                ] as const).map(([key, labelKey]) => (
                  <label key={key} className="flex cursor-pointer items-center gap-2 text-sm">
                    <Checkbox
                      checked={generator[key]}
                      onCheckedChange={(v) => setGenerator((g) => ({ ...g, [key]: v === true }))}
                    />
                    {t(labelKey)}
                  </label>
                ))}
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className={cn('text-sm text-muted-foreground', NUMERIC_CLASS)}>
                  {t('generatorEntropyLabel', { bits: generatorBits.toFixed(1) })}
                </span>
                <Button
                  variant="secondary"
                  disabled={generatorEmpty}
                  onClick={() => setPassword(generatePassword(generator))}
                >
                  <Dices className="size-4" aria-hidden="true" />
                  {t('generatorApplyButton')}
                </Button>
              </div>
            </div>
          )}

          <div className={FIELD}>
            <Label htmlFor="pw-notes">{t('notesLabel')}</Label>
            <Input id="pw-notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>
        <div className="flex shrink-0 flex-col-reverse gap-2.5 border-t border-border pt-5 sm:flex-row sm:justify-end">
          <Button onClick={handleSave}>{t('saveButton')}</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

type ImportPreviewRow = {
  row_index: number
  name: string
  url: string
  username: string
  password: string
  notes: string
  action: 'add' | 'update' | 'unchanged' | 'superseded_in_batch'
  match_id: string | null
  superseded_by: number | null
}

function ImportPreviewDialog({
  inputPath,
  open,
  onOpenChange,
  onImported,
}: {
  inputPath: string | null
  open: boolean
  onOpenChange: (o: boolean) => void
  onImported: () => void
}) {
  const { t } = useTranslation('passwords')
  const [rows, setRows] = useState<ImportPreviewRow[]>([])
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [loading, setLoading] = useState(false)
  const [confirming, setConfirming] = useState(false)

  useEffect(() => {
    if (!open || !inputPath) return
    let cancelled = false
    setRows([])
    setSelected(new Set())
    setLoading(true)
    vaultApi.call('password_import_csv_preview', { input_path: inputPath }).then((res) => {
      if (cancelled) return
      setLoading(false)
      if (!res.ok) {
        toast.error(t('importPreviewFailedToast'), { description: translateError(res.error, res.error_params) })
        onOpenChange(false)
        return
      }
      setRows(res.rows)
      // 新增/更新的行默认全部勾选 - 无变化/被同批次后面行覆盖的行不可选。
      setSelected(new Set(res.rows.filter((r) => r.action === 'add' || r.action === 'update').map((r) => r.row_index)))
    }).catch((err: unknown) => {
      // vaultApi.call 在后端抛出非 PasswordVaultError 时会 reject（而非 resolve 成 {ok:false}）；没有这个
      // catch，上面的 setLoading(false) 永远跑不到，弹窗卡在空白加载态。
      if (cancelled) return
      setLoading(false)
      toast.error(t('importPreviewFailedToast'), {
        description: translateError(err instanceof Error ? err.message : 'internal.unexpected'),
      })
      onOpenChange(false)
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, inputPath])

  function toggleSelected(rowIndex: number, checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (checked) next.add(rowIndex)
      else next.delete(rowIndex)
      return next
    })
  }

  const selectableRows = rows.filter((r) => r.action === 'add' || r.action === 'update')
  const allSelected = selectableRows.length > 0 && selectableRows.every((r) => selected.has(r.row_index))

  function toggleSelectAll(checked: boolean) {
    setSelected(checked ? new Set(selectableRows.map((r) => r.row_index)) : new Set())
  }

  async function handleConfirm() {
    if (!inputPath) return
    setConfirming(true)
    const res = await vaultApi.call('password_import_csv_confirm', {
      input_path: inputPath,
      selected_row_indices: [...selected],
    })
    setConfirming(false)
    if (!res.ok) {
      toast.error(t('importConfirmFailedToast'), { description: translateError(res.error, res.error_params) })
      return
    }
    toast.success(
      t('importConfirmedToast', { added: res.added_count, updated: res.updated_count }) +
        (res.source_deleted ? t('importConfirmedAndSourceDeletedSuffix') : ''),
    )
    onImported()
  }

  function actionLabel(action: ImportPreviewRow['action']) {
    return {
      add: t('importPreviewActionAdd'),
      update: t('importPreviewActionUpdate'),
      unchanged: t('importPreviewActionUnchanged'),
      superseded_in_batch: t('importPreviewActionSuperseded'),
    }[action]
  }

  function actionTone(action: ImportPreviewRow['action']) {
    if (action === 'add') return 'success' as const
    if (action === 'update') return 'warning' as const
    return 'neutral' as const
  }

  const addCount = rows.filter((r) => r.action === 'add').length
  const updateCount = rows.filter((r) => r.action === 'update').length

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* flex flex-col + max-h-[85vh] on DialogContent itself (not just the row
          list below) - the base DialogContent has no height cap at all, so on
          a full CSV with many rows the dialog could grow taller than the
          window and push its own header/Confirm button off-screen with no way
          to reach them. Capping the whole dialog and only letting the row
          list's flex-1 section scroll internally keeps the header/summary/
          buttons always pinned and visible regardless of row count. */}
      <DialogContent className={REVIEW_DIALOG}>
        <DialogHeader>
          <DialogTitle>{t('importPreviewDialogTitle')}</DialogTitle>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-3">
          {!loading && rows.length > 0 && (
            <p className={cn('text-sm text-muted-foreground', NUMERIC_CLASS)}>
              {t('importPreviewSummary', { total: rows.length, add: addCount, update: updateCount })}
            </p>
          )}
          {!loading && rows.length === 0 && (
            <p className="text-sm text-muted-foreground">{t('importPreviewEmptyState')}</p>
          )}

          {selectableRows.length > 0 && (
            <div className="flex items-center gap-2 px-1">
              <Checkbox
                id="import-select-all"
                checked={allSelected}
                onCheckedChange={(v) => toggleSelectAll(v === true)}
              />
              <Label htmlFor="import-select-all" className="text-sm text-muted-foreground">
                {t('selectAllLabel')}
              </Label>
            </div>
          )}

          {/* min-h-0 is required alongside flex-1 here - without it a flex
              child won't shrink below its content size, so this list would
              just keep growing (and re-trigger the whole-dialog overflow
              above) instead of stopping at the space actually left over and
              scrolling internally. */}
          <div className="min-h-0 flex-1 space-y-1 overflow-y-auto">
            {rows.map((row) => (
              <div key={row.row_index} className="flex items-center gap-2 rounded-lg border border-border p-2">
                <Checkbox
                  className="shrink-0"
                  checked={selected.has(row.row_index)}
                  disabled={row.action !== 'add' && row.action !== 'update'}
                  onCheckedChange={(v) => toggleSelected(row.row_index, v === true)}
                  aria-label={t('selectEntryAriaLabel', { name: row.name })}
                />
                <div className="min-w-0 flex-1">
                  <p className="break-words text-sm font-medium">{row.name}</p>
                  <p className="break-words text-sm text-muted-foreground">
                    {row.url} · {row.username}
                  </p>
                </div>
                <Badge tone={actionTone(row.action)} className="shrink-0">
                  {actionLabel(row.action)}
                </Badge>
              </div>
            ))}
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t('importPreviewCancelButton')}
            </Button>
            <Button onClick={handleConfirm} disabled={loading || confirming || selected.size === 0}>
              {t('importPreviewConfirmButton')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

type PasswordHistorySnapshot = {
  name: string
  url: string
  username: string
  password: string
  notes: string
  updated_at: number
}

function PasswordHistoryDialog({
  entry,
  open,
  onOpenChange,
}: {
  entry: PasswordEntry | null
  open: boolean
  onOpenChange: (o: boolean) => void
}) {
  const { t } = useTranslation('passwords')
  const [history, setHistory] = useState<PasswordHistorySnapshot[]>([])
  const [loading, setLoading] = useState(false)
  const [revealed, setRevealed] = useState<Record<number, boolean>>({})

  useEffect(() => {
    if (!open || !entry) return
    let cancelled = false
    setHistory([])
    setRevealed({})
    setLoading(true)
    vaultApi.call('password_get_history', { id: entry.id }).then((res) => {
      if (cancelled) return
      setLoading(false)
      if (!res.ok) {
        toast.error(t('historyLoadFailedToast'), { description: translateError(res.error, res.error_params) })
        onOpenChange(false)
        return
      }
      setHistory(res.history)
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, entry])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* 跟本页其它弹窗同一套骨架：整体限高 85vh、只让里面这块滚。原先是
          `max-w-lg` + 内层写死 max-h-[400px]，于是在一块 1440p 的屏幕上，
          弹窗只用到中间一小条，历史记录却还是四百像素一小格地滚。 */}
      <DialogContent className={FORM_DIALOG}>
        <DialogHeader>
          <DialogTitle>{entry ? t('historyDialogTitle', { name: entry.name }) : ''}</DialogTitle>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto">
          {!loading && history.length === 0 && (
            <p className="text-sm text-muted-foreground">{t('historyEmptyState')}</p>
          )}
          {history.map((snapshot, i) => (
            <div key={i} className="rounded-lg border border-border bg-surface p-3.5">
              <p className={cn('text-sm text-muted-foreground', NUMERIC_CLASS)}>
                {new Date(snapshot.updated_at * 1000).toLocaleString()}
              </p>
              <p className="truncate text-sm text-muted-foreground">{snapshot.username}</p>
              <div className="flex items-center justify-between gap-2">
                <p className="min-w-0 flex-1 truncate font-mono text-sm">
                  {revealed[i] ? snapshot.password : maskOf(snapshot.password)}
                </p>
                <div className="flex shrink-0 gap-1">
                  <ActionButton
                    label={revealed[i] ? t('hideButton') : t('showButton')}
                    icon={revealed[i] ? EyeOff : Eye}
                    region={LABEL_REGIONS.passwordDetailToolbar}
                    variant="outline"
                    onClick={() => setRevealed((r) => ({ ...r, [i]: !r[i] }))}
                  />
                  <ActionButton
                    label={t('copyButton')}
                    icon={Copy}
                    region={LABEL_REGIONS.passwordDetailToolbar}
                    variant="outline"
                    onClick={() => copyPasswordWithAutoClear(snapshot.password)}
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
