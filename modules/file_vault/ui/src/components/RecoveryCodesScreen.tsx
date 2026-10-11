import {
  useEffect,
  useMemo,
  useRef,
  useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  AlertTriangle,
  ArrowDownToLine,
  ArrowUpDown,
  ArrowUpFromLine,
  CalendarCheck,
  CalendarClock,
  Clipboard,
  Copy,
  CopyCheck,
  Eye,
  EyeOff,
  FileJson,
  FileText,
  FolderArchive,
  FolderInput,
  History,
  KeyRound,
  Layers,
  LayoutDashboard,
  List,
  ListChecks,
  PencilLine,
  Printer,
  ScanText,
  ScrollText,
  Square,
  SquareCheck,
  Trash2,
  Upload,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { StatTile } from '@/components/StatTile'
import { TopBar, TopBarSearch, type TopBarMenu, type TopBarNode } from '@/components/TopBar'
import { EmptyState, FeatureTitle, PageHeader } from '@/components/ui/page'
import { Workbench } from '@/components/ui/workbench'
import { RecoveryTimelineDialog, type TimelineScope } from '@/components/recovery/RecoveryTimelineDialog'
import { RecoveryBulkEditDialog } from '@/components/recovery/RecoveryBulkEditDialog'
import { RecoveryDuplicatesDialog } from '@/components/recovery/RecoveryDuplicatesDialog'
import {
  ALL_RECOVERY,
  buildServiceFacets,
  matchesRecoveryFilter,
  type RecoveryFilter,
} from '@/lib/recovery/serviceFacets'
import { UnlockDialog } from '@/components/UnlockDialog'
import { cn } from '@/lib/utils'
import { vaultApi } from '@/lib/vaultApi'
import { electronApi } from '@/lib/electronApi'
import { translateError } from '@/i18n/errors'
import { recognizeText, filePathToFileUrl, terminateOcrWorker } from '@/lib/ocr'
import { buildRecoveryCodesPdfHtml } from '@/lib/recoveryCodesPdf'
import type {
  ActivityLogEntry,
  BackupDiffItem,
  DamagedRecoveryCodeRecord,
  JsonImportDiffItem,
  RecoveryCodeGroup,
  RecoveryCodesJsonMeta,
  RevealedRecoveryCode,
} from '@/shared/ipcTypes'
import { copyTextWithAutoClear, readClipboardText } from '@/lib/clipboard'

type SortMode = 'name' | 'remaining' | 'recent'

// 表单弹窗统一规格，与 SettingsScreen / PasswordScreen / AIChatScreen 同名同值。
// CONFIRM 确认框；FORM ≤3 字段；WIDE_FORM 字段多或带长列表；REVIEW 逐条复核列表。
// 除确认框外都带 flex max-h-[85vh] flex-col：内容过高时滚内部，标题和按钮常驻。
const CONFIRM_DIALOG = 'sm:max-w-lg'
const FORM_DIALOG = 'flex max-h-[85vh] flex-col sm:max-w-xl'
const WIDE_FORM_DIALOG = 'flex max-h-[85vh] flex-col sm:max-w-3xl'
const REVIEW_DIALOG = 'flex max-h-[85vh] flex-col sm:max-w-4xl'
/** 弹窗里可滚动的那一块。min-h-0 不能省，否则 flex 子项不肯收缩，overflow 失效。 */
const FORM_BODY = 'min-h-0 flex-1 space-y-5 overflow-y-auto'
/** 底部按钮组。永远贴在弹窗底部、不参与滚动、主动作在最右。 */
const DIALOG_ACTIONS = 'flex shrink-0 flex-col-reverse gap-2.5 border-t border-border pt-5 sm:flex-row sm:justify-end'
/** 单个字段：标签与输入框之间的距离，全应用一个值。 */
const FIELD = 'space-y-2'

// 300ms 防抖搜索（spec 3.7）：恢复码总览后续要在同批数据上跑较重的派生计算，先加防抖。
function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(timer)
  }, [value, delayMs])
  return debounced
}

const CLIPBOARD_AUTO_CLEAR_MS = 30_000

// 30 秒后自动清空剪贴板（spec 9）。实现在 src/lib/clipboard.ts，密码页用的是
// 同一份——原先两处各抄一遍，且两遍都因为窗口没焦点而从来没清空成功过。
function copyWithAutoClear(text: string) {
  void copyTextWithAutoClear(text, CLIPBOARD_AUTO_CLEAR_MS)
}

function formatDateTime(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000)
  return d.toLocaleString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

interface ImportPreviewGroupState {
  service: string
  accountLabel: string
  matchedGroupId: string | null
  action: 'new' | 'unchanged' | 'changed'
  codes: string[]
  invalidLines: Array<{ lineNumber: number; raw: string }>
  suspectCodes: string[]
}

// 一份文件可能解析出多个分组，统一自动分类展示、一次确认写入；单分组时 groups 长度为 1。
interface ImportPreviewState {
  inputPath?: string
  text?: string
  sourceFileName: string
  groups: ImportPreviewGroupState[]
}

const DASHBOARD_LIST_PREVIEW_LIMIT = 8

// 相对时间，复用 common 命名空间键；两处各十来行，不值得抽公共模块。
function formatRelativeTime(isoLike: string, now: number, t: (key: string, opts?: Record<string, unknown>) => string): string {
  const then = new Date(isoLike).getTime()
  if (Number.isNaN(then)) return isoLike
  const diffSeconds = Math.max(0, Math.round((now - then) / 1000))
  if (diffSeconds < 60) return t('activityJustNow')
  const diffMinutes = Math.round(diffSeconds / 60)
  if (diffMinutes < 60) return t('activityMinutesAgo', { count: diffMinutes })
  const diffHours = Math.round(diffMinutes / 60)
  if (diffHours < 24) return t('activityHoursAgo', { count: diffHours })
  const diffDays = Math.round(diffHours / 24)
  return t('activityDaysAgo', { count: diffDays })
}

function DashboardGroupList({
  title,
  emptyText,
  groups,
  onOpenGroup,
  badge,
}: {
  title: string
  emptyText: string
  groups: RecoveryCodeGroup[]
  onOpenGroup: (groupId: string) => void
  badge: (g: RecoveryCodeGroup) => string
}) {
  const { t } = useTranslation('recoveryCodes')
  const shown = groups.slice(0, DASHBOARD_LIST_PREVIEW_LIMIT)
  return (
    <div>
      <h3 className="mb-2 text-sm font-semibold">{title}</h3>
      {groups.length === 0 ? (
        <p className="text-sm text-muted-foreground">{emptyText}</p>
      ) : (
        <div className="space-y-1">
          {shown.map((g) => (
            <button
              key={g.id}
              onClick={() => onOpenGroup(g.id)}
              className="flex w-full items-center justify-between rounded border px-2 py-1.5 text-left text-sm hover:bg-muted/50"
            >
              <span>
                {g.service}
                {g.accountLabel && <span className="text-sm text-muted-foreground"> · {g.accountLabel}</span>}
              </span>
              <span className="text-sm text-muted-foreground">{badge(g)}</span>
            </button>
          ))}
          {groups.length > DASHBOARD_LIST_PREVIEW_LIMIT && (
            <p className="pt-1 text-sm text-muted-foreground">
              {t('dashboardMoreLabel', { count: groups.length - DASHBOARD_LIST_PREVIEW_LIMIT })}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

// 仪表盘列表只预览前 DASHBOARD_LIST_PREVIEW_LIMIT 项，完整清单在"列表"视图（虚拟滚动）。
function RecoveryCodesDashboard({
  groups,
  recentActivity,
  onOpenGroup,
}: {
  groups: RecoveryCodeGroup[]
  recentActivity: ActivityLogEntry[]
  onOpenGroup: (groupId: string) => void
}) {
  const { t } = useTranslation('recoveryCodes')
  const { t: tCommon } = useTranslation('common')
  const [now] = useState(() => Date.now())
  const lowStockGroups = groups.filter((g) => g.isLowStock)
  const needsReviewGroups = groups.filter((g) => g.needsReview)

  return (
    // `min-h-0` 不能省：flex 子项默认 `min-height:auto`，会一直撑到内容高度而
    // 拒绝收缩，`overflow-y-auto` 于是永远不生效——仪表盘卡片多了就直接被裁掉。
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      {/* 「已保存服务 / 密钥总数 / 剩余可用」三块数字搬到了页面标题行
          （见下方 RecoveryCodesScreen 的 <PageHeader metrics=…>）。留在这里的话，
          切到"列表"视图它们就整排消失，而那三个数跟看的是哪个视图无关。 */}

      <div className="grid gap-6 md:grid-cols-2">
        <DashboardGroupList
          title={t('dashboardLowStockTitle')}
          emptyText={t('dashboardLowStockEmpty')}
          groups={lowStockGroups}
          onOpenGroup={onOpenGroup}
          badge={(g) => t('remainingCountLabel', { remaining: g.remainingCount, total: g.codes.length })}
        />
        <DashboardGroupList
          title={t('dashboardReviewDueTitle')}
          emptyText={t('dashboardReviewDueEmpty')}
          groups={needsReviewGroups}
          onOpenGroup={onOpenGroup}
          badge={(g) => formatRelativeTime(new Date(g.lastCheckedAt * 1000).toISOString(), now, tCommon)}
        />
      </div>

      <div className="mt-6">
        <h3 className="mb-2 text-sm font-semibold">{t('dashboardRecentActivityTitle')}</h3>
        {recentActivity.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('dashboardRecentActivityEmpty')}</p>
        ) : (
          <div className="space-y-1">
            {recentActivity.map((entry) => (
              <div key={entry.id} className="flex items-center justify-between text-sm">
                <span>
                  {t(`historyAction_${entry.action}` as 'historyAction_import', { defaultValue: entry.action })}
                  {entry.label && <span className="text-muted-foreground"> — {entry.label}</span>}
                </span>
                <span className="text-sm text-muted-foreground">{formatRelativeTime(entry.created_at, now, tCommon)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export function RecoveryCodesScreen({ isProfessional = false }: { isProfessional?: boolean } = {}) {
  const { t } = useTranslation('recoveryCodes')
  const { t: tCommon } = useTranslation('common')
  const [groups, setGroups] = useState<RecoveryCodeGroup[]>([])
  const [damaged, setDamaged] = useState<DamagedRecoveryCodeRecord[]>([])
  const [search, setSearch] = useState('')
  const debouncedSearch = useDebouncedValue(search, 300)
  const [sortMode, setSortMode] = useState<SortMode>('recent')
  const [detailId, setDetailId] = useState<string | null>(null)
  const [revealedByGroup, setRevealedByGroup] = useState<Record<string, RevealedRecoveryCode[]>>({})
  const [selectMode, setSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [preview, setPreview] = useState<ImportPreviewState | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<RecoveryCodeGroup | null>(null)
  const [editTarget, setEditTarget] = useState<RecoveryCodeGroup | null>(null)
  const [editNote, setEditNote] = useState('')
  const [editLowStock, setEditLowStock] = useState('3')
  const [editReviewDays, setEditReviewDays] = useState('180')
  const [importQueue, setImportQueue] = useState<string[]>([])
  // 导入后安全删除源文件，默认开：明文恢复码留在下载目录等于没保护。剪贴板导入无源文件，不显示。
  const [deleteSourceOnImport, setDeleteSourceOnImport] = useState(true)
  const [dragActive, setDragActive] = useState(false)
  const [ocrDialogOpen, setOcrDialogOpen] = useState(false)
  const [ocrBusy, setOcrBusy] = useState(false)
  const [ocrChecklist, setOcrChecklist] = useState<{ code: string; checked: boolean; isSuspect: boolean }[] | null>(null)
  const [historyTarget, setHistoryTarget] = useState<RecoveryCodeGroup | null>(null)
  const [reverifyOpen, setReverifyOpen] = useState(false)
  // 通用"重新验证后执行"回调：揭示明文/生成PDF/导出备份共用同一个 UnlockDialog 与触发机制。
  const pendingUnlockActionRef = useRef<(() => void | Promise<void>) | null>(null)
  const revealHideTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  const ocrPasteRef = useRef<HTMLDivElement>(null)
  const [view, setView] = useState<'dashboard' | 'list'>('dashboard')
  const [recentActivity, setRecentActivity] = useState<ActivityLogEntry[]>([])
  const scrollParentRef = useRef<HTMLDivElement>(null)
  const [backupExportOpen, setBackupExportOpen] = useState(false)
  const [backupExportPassword, setBackupExportPassword] = useState('')
  const [backupImportStep, setBackupImportStep] = useState<'password' | 'review' | null>(null)
  const [backupImportPath, setBackupImportPath] = useState('')
  const [backupImportPassword, setBackupImportPassword] = useState('')
  const [backupImportItems, setBackupImportItems] = useState<BackupDiffItem[]>([])
  const [backupImportDamaged, setBackupImportDamaged] = useState<DamagedRecoveryCodeRecord[]>([])
  const [backupImportDecisions, setBackupImportDecisions] = useState<Record<string, 'keep_local' | 'use_backup' | 'merge'>>({})
  const [exportFormatMenuOpen, setExportFormatMenuOpen] = useState(false)
  const [revealRequiresVerify, setRevealRequiresVerify] = useState(true)
  const pendingExportFormatRef = useRef<'txt' | 'csv' | 'json'>('txt')

  // JSON 导出的可选项。TXT/CSV 没有这些——只有 JSON 是"结构化到能当备份用"的
  // 那一种格式，加密/脱敏/只导未用/分片都只对它有意义。
  const [jsonExportOpen, setJsonExportOpen] = useState(false)
  const [jsonExportIds, setJsonExportIds] = useState<string[] | undefined>(undefined)
  // **默认加密。** 这份文件里是一整套绕过两步验证的后门；把"明文落盘"设成
  // 默认值，等于让最不安全的那个结果成为不做选择时的结果。
  const [jsonExportEncrypt, setJsonExportEncrypt] = useState(true)
  const [jsonExportPassword, setJsonExportPassword] = useState('')
  const [jsonExportRedact, setJsonExportRedact] = useState(false)
  // 取消加密之后，还要再明确认一次才放行——警告能被无视，勾选不能。
  const [jsonExportPlaintextAck, setJsonExportPlaintextAck] = useState(false)
  const [jsonExportOnlyUnused, setJsonExportOnlyUnused] = useState(false)
  const [jsonExportSplitSize, setJsonExportSplitSize] = useState('')

  // JSON 导入。步骤和备份导入一致（选文件 → 必要时要密码 → 逐组决策 → 写入），
  // 用户不需要为"另一种文件"再学一遍流程。
  const [jsonImportStep, setJsonImportStep] = useState<'password' | 'review' | null>(null)
  const [jsonImportPath, setJsonImportPath] = useState('')
  const [jsonImportPassword, setJsonImportPassword] = useState('')
  const [jsonImportMeta, setJsonImportMeta] = useState<RecoveryCodesJsonMeta | null>(null)
  const [jsonImportItems, setJsonImportItems] = useState<JsonImportDiffItem[]>([])
  const [jsonImportDamaged, setJsonImportDamaged] = useState<DamagedRecoveryCodeRecord[]>([])
  const [jsonImportDecisions, setJsonImportDecisions] = useState<Record<string, 'keep_local' | 'use_file' | 'merge'>>({})

  // 顶栏「服务」菜单选中的那一类：状态（库存不足 / 建议核对）或 服务 ▸ 账号。
  // 跟搜索框叠加生效。子分类全部从数据里算，见 lib/recovery/serviceFacets.ts。
  const [filter, setFilter] = useState<RecoveryFilter>(ALL_RECOVERY)
  const [timelineScope, setTimelineScope] = useState<TimelineScope | null>(null)
  const [bulkEditTargets, setBulkEditTargets] = useState<RecoveryCodeGroup[] | null>(null)
  const [dedupeOpen, setDedupeOpen] = useState(false)

  const detailGroup = groups.find((g) => g.id === detailId) ?? null

  async function reload() {
    const res = await vaultApi.call('recovery_codes_list', {})
    setGroups(res.groups)
    setDamaged(res.damaged)
  }

  async function reloadRecentActivity() {
    const res = await vaultApi.call('activity_log_list', { limit: 50 })
    if (res.ok) setRecentActivity(res.entries.filter((e) => e.module === 'recovery_codes').slice(0, 5))
  }

  function openGroupInList(groupId: string) {
    setView('list')
    setDetailId(groupId)
  }

  useEffect(() => {
    reload()
    reloadRecentActivity()
    // Load the reveal-require-verify setting
    vaultApi.call('recovery_codes_settings_get', {}).then((res) => {
      if (res.ok) setRevealRequiresVerify(res.settings.reveal_requires_verify !== false)
    })
  }, [])

  useEffect(() => {
    if (ocrDialogOpen) ocrPasteRef.current?.focus()
  }, [ocrDialogOpen])

  // OCR worker 常驻约 13 MB（wasm + 语言包），lib/ocr.ts 的释放函数此前无人调用。
  // 恢复码页是唯一用 OCR 的地方：留页时保持热，离开即释放，下次 getWorker() 会重建。
  useEffect(() => {
    return () => {
      void terminateOcrWorker()
    }
  }, [])

  const filtered = useMemo(() => {
    const q = debouncedSearch.trim().toLowerCase()
    const result = groups.filter(
      (g) =>
        matchesRecoveryFilter(g, filter) &&
        (!q || g.service.toLowerCase().includes(q) || g.accountLabel.toLowerCase().includes(q)),
    )
    const sorted = [...result]
    switch (sortMode) {
      case 'name':
        sorted.sort((a, b) => a.service.localeCompare(b.service))
        break
      case 'remaining':
        sorted.sort((a, b) => a.remainingCount - b.remainingCount)
        break
      default:
        sorted.sort((a, b) => b.lastUpdatedAt - a.lastUpdatedAt)
    }
    return sorted
  }, [groups, debouncedSearch, sortMode, filter])

  const facets = useMemo(() => buildServiceFacets(groups), [groups])

  // 三个总量数字放在页面标题行，不绑定仪表盘/列表视图，切到列表也不消失。
  const totals = useMemo(
    () => ({
      services: groups.length,
      codes: groups.reduce((sum, g) => sum + g.codes.length, 0),
      remaining: groups.reduce((sum, g) => sum + g.remainingCount, 0),
    }),
    [groups],
  )

  const filteredIds = useMemo(() => new Set(filtered.map((g) => g.id)), [filtered])
  const visibleSelectedIds = useMemo(() => [...selectedIds].filter((id) => filteredIds.has(id)), [selectedIds, filteredIds])
  const allFilteredSelected = filtered.length > 0 && visibleSelectedIds.length === filtered.length

  // 服务数量较多时列表依然流畅（spec 3.7/10）——跟 ClipboardScreen/NotesScreen
  // 同一套 @tanstack/react-virtual 用法，只渲染视口内可见的卡片。
  const rowVirtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => scrollParentRef.current,
    estimateSize: () => 84,
    overscan: 8,
    // 按条目 id 作键而非下标，否则搜索/删除重排后行高测量缓存会套到别的记录（同 PasswordScreen）。
    getItemKey: (index) => filtered[index]?.id ?? index,
  })

  function toggleSelected(id: string, checked: boolean) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  }

  const REVEAL_AUTO_HIDE_MS = 60_000

  // 揭示明文前先检查设置：如果用户关闭了"揭示需要验证"，直接调 reveal，否则
  // 弹出 UnlockDialog。复用既有 UnlockDialog 和 identity.py 的锁定计数/冷却。
  function requireReverify(action: () => void | Promise<void>) {
    if (!revealRequiresVerify) {
      void action()
      return
    }
    forceReverify(action)
  }

  // 不看设置、一定先弹验证框。时间线里看旧版明文时，后端若回 verify_required
  // （设置关了验证、但后端的验证窗口早过了），就走这里补一次再重试。
  function forceReverify(action: () => void | Promise<void>) {
    pendingUnlockActionRef.current = action
    setReverifyOpen(true)
  }

  function handleReverifySuccess() {
    const action = pendingUnlockActionRef.current
    pendingUnlockActionRef.current = null
    if (action) void action()
  }

  function handleReveal(group: RecoveryCodeGroup) {
    requireReverify(async () => {
      const res = await vaultApi.call('recovery_codes_reveal', { id: group.id, verified: true })
      if (!res.ok) {
        toast.error(t('revealFailedToast'), { description: translateError(res.error, res.error_params) })
        return
      }
      setRevealedByGroup((prev) => ({ ...prev, [group.id]: res.codes }))
      clearTimeout(revealHideTimersRef.current[group.id])
      revealHideTimersRef.current[group.id] = setTimeout(() => handleHide(group.id), REVEAL_AUTO_HIDE_MS)
    })
  }

  // PDF 导出（spec 3.4）：先重新验证，再逐组 reveal 取明文（不复用屏幕上的 revealedByGroup，
  // 保证是验证时刻的最新数据），拼 HTML 交给已有的 electronAPI.exportPdf，无需新 IPC 或 PDF 库。
  function handleExportPdf(targetGroups: RecoveryCodeGroup[]) {
    if (targetGroups.length === 0) return
    requireReverify(async () => {
      const sections = []
      for (const g of targetGroups) {
        const res = await vaultApi.call('recovery_codes_reveal', { id: g.id, verified: true })
        if (!res.ok) {
          toast.error(t('pdfExportFailedToast'), { description: translateError(res.error, res.error_params) })
          return
        }
        sections.push({ service: g.service, accountLabel: g.accountLabel, codes: res.codes })
      }
      const savePath = await electronApi.saveFile({
        defaultPath: 'recovery-codes.pdf',
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
      })
      if (!savePath) return
      const html = buildRecoveryCodesPdfHtml(sections, {
        title: t('pdfTitle'),
        accountLabelPrefix: t('pdfAccountLabelPrefix'),
        generatedAtLabel: t('pdfGeneratedAtLabel'),
        warningText: t('pdfWarningText'),
      })
      const res = await electronApi.exportPdf(html, savePath)
      if (!res.ok) {
        toast.error(t('pdfExportFailedToast'), { description: res.error })
        return
      }
      const label = sections.map((s) => s.service).join(', ')
      await vaultApi.call('recovery_codes_log_pdf_export', { label })
      toast.success(t('pdfExportCompleteToast'), {
        action: { label: t('openFolderAction'), onClick: () => electronApi.showItemInFolder(savePath) },
      })
      void reloadRecentActivity()
    })
  }

  // 完整备份导出（spec 3.5）：先重新验证；备份密码是当场新设、独立于主密码/IMK，泄露不连带金库。
  // 导入备份不重新验证：过程不展示任何明文（差异比对只给数量）。
  const BACKUP_PASSWORD_MIN_LENGTH = 8

  function handleBackupExportOpen() {
    requireReverify(() => setBackupExportOpen(true))
  }

  async function handleBackupExportConfirm() {
    if (backupExportPassword.length < BACKUP_PASSWORD_MIN_LENGTH) {
      toast.error(t('backupPasswordTooShortHint'))
      return
    }
    const savePath = await electronApi.saveFile({
      defaultPath: 'recovery-codes-backup.ideal1rc',
      filters: [{ name: 'Ideal1 Recovery Codes Backup', extensions: ['ideal1rc'] }],
    })
    if (!savePath) return
    const res = await vaultApi.call('recovery_codes_backup_export', {
      output_path: savePath,
      backup_password: backupExportPassword,
    })
    setBackupExportOpen(false)
    setBackupExportPassword('')
    if (!res.ok) {
      toast.error(t('backupExportFailedToast'), { description: translateError(res.error, res.error_params) })
      return
    }
    toast.success(t('backupExportCompleteToast'), {
      action: { label: t('openFolderAction'), onClick: () => electronApi.showItemInFolder(res.output_path) },
    })
    void reloadRecentActivity()
  }

  async function handleBackupImportPickFile() {
    const paths = await electronApi.openFiles({
      filters: [{ name: 'Ideal1 Recovery Codes Backup', extensions: ['ideal1rc'] }],
    })
    if (!paths || paths.length === 0) return
    setBackupImportPath(paths[0])
    setBackupImportStep('password')
  }

  async function handleBackupImportPreview() {
    const res = await vaultApi.call('recovery_codes_backup_import_preview', {
      input_path: backupImportPath,
      backup_password: backupImportPassword,
    })
    if (!res.ok) {
      toast.error(t('backupImportFailedToast'), { description: translateError(res.error, res.error_params) })
      return
    }
    // 预选默认值：仅本地有→保留本地（无需决策）；仅备份有→默认使用备份；
    // 冲突→默认保留本地（更保守，用户需主动选择覆盖或合并）。
    const defaults: Record<string, 'keep_local' | 'use_backup' | 'merge'> = {}
    for (const item of res.items) {
      if (item.status === 'backup_only') defaults[item.key] = 'use_backup'
      else if (item.status === 'conflict') defaults[item.key] = 'keep_local'
    }
    setBackupImportItems(res.items)
    setBackupImportDamaged(res.damaged)
    setBackupImportDecisions(defaults)
    setBackupImportStep('review')
  }

  async function handleBackupImportConfirm() {
    const res = await vaultApi.call('recovery_codes_backup_import_confirm', {
      input_path: backupImportPath,
      backup_password: backupImportPassword,
      decisions: backupImportDecisions,
    })
    if (!res.ok) {
      toast.error(t('backupImportFailedToast'), { description: translateError(res.error, res.error_params) })
      return
    }
    setGroups(res.groups)
    setBackupImportStep(null)
    setBackupImportPath('')
    setBackupImportPassword('')
    toast.success(t('backupImportCompleteToast', { count: res.applied_count }))
    void reloadRecentActivity()
  }

  function handleHide(groupId: string) {
    clearTimeout(revealHideTimersRef.current[groupId])
    delete revealHideTimersRef.current[groupId]
    setRevealedByGroup((prev) => {
      const next = { ...prev }
      delete next[groupId]
      return next
    })
  }

  // 卸载时清掉所有待触发的自动隐藏计时器，避免明文滞留内存。timers 只做属性级 mutate、
  // 从不重新赋值，所以捕获的引用能看到卸载时的全部计时器。
  useEffect(() => {
    const timers = revealHideTimersRef.current
    return () => {
      Object.values(timers).forEach(clearTimeout)
    }
  }, [])

  async function handleMarkUsed(group: RecoveryCodeGroup, codeIndex: number, used: boolean) {
    const res = await vaultApi.call('recovery_codes_mark_used', { id: group.id, code_index: codeIndex, used })
    if (!res.ok) {
      toast.error(t('markUsedFailedToast'), { description: translateError(res.error, res.error_params) })
      return
    }
    setGroups((prev) => prev.map((g) => (g.id === group.id ? res.group : g)))
  }

  async function handleMarkChecked(group: RecoveryCodeGroup) {
    const res = await vaultApi.call('recovery_codes_mark_checked', { id: group.id })
    if (res.ok) {
      setGroups((prev) => prev.map((g) => (g.id === group.id ? res.group : g)))
      toast.success(t('markCheckedToast'))
    }
  }

  // 批量导入：openFiles 支持多选，逐份走同一套预览/确认流程，确认/跳过后自动弹出队列下一份。
  async function handleImportFiles() {
    const paths = await electronApi.openFiles({ filters: [{ name: t('allFilesFilter'), extensions: ['*'] }] })
    if (!paths || paths.length === 0) return
    await startImportQueue(paths)
  }

  async function startImportQueue(paths: string[]) {
    setImportQueue(paths.slice(1))
    await runImportPreview({ input_path: paths[0] })
  }

  async function advanceImportQueue() {
    setPreview(null)
    const [next, ...rest] = importQueue
    if (!next) return
    setImportQueue(rest)
    await runImportPreview({ input_path: next })
  }

  async function handleClipboardImport() {
    // 读剪贴板同样不能走 navigator.clipboard：clipboard-read 权限也被全局
    // 拒掉了，原来这一句必然抛异常，"从剪贴板导入"从来就没成功过。
    const text = (await readClipboardText()) ?? ''
    if (!text.trim()) {
      toast.error(t('importPreviewFailedToast'))
      return
    }
    await runImportPreview({ text, source_file_name: '' })
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault()
    setDragActive(true)
  }

  function handleDragLeave(e: React.DragEvent) {
    e.preventDefault()
    setDragActive(false)
  }

  async function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragActive(false)
    const paths = Array.from(e.dataTransfer.files)
      .map((f) => electronApi.getPathForFile(f))
      .filter((p): p is string => !!p)
    if (paths.length === 0) return
    await startImportQueue(paths)
  }

  async function runImportPreview(params: { input_path?: string; text?: string; source_file_name?: string }) {
    const res = await vaultApi.call('recovery_codes_import_preview', params)
    if (!res.ok) {
      toast.error(t('importPreviewFailedToast'), { description: translateError(res.error, res.error_params) })
      // 批量队列里的一份坏文件不该卡住其余的，直接跳过继续下一份。
      if (importQueue.length > 0) await advanceImportQueue()
      return
    }
    setPreview({
      inputPath: params.input_path,
      text: params.text,
      sourceFileName: res.sourceFileName,
      groups: res.groups.map((g) => ({
        service: g.service,
        accountLabel: g.accountLabel,
        matchedGroupId: g.matchedGroupId,
        action: g.action,
        codes: g.codes,
        invalidLines: g.invalidLines,
        suspectCodes: g.suspectCodes ?? [],
      })),
    })
  }

  // 只有真要写入的分组才要求非空服务名/才发去确认；"无变化"或无有效密钥的分组不拦，免得批量逐个点。
  function importableGroups(state: ImportPreviewState): ImportPreviewGroupState[] {
    return state.groups.filter((g) => g.action !== 'unchanged' && g.codes.length > 0)
  }

  function updatePreviewGroup(index: number, patch: Partial<ImportPreviewGroupState>) {
    setPreview((prev) => (prev ? { ...prev, groups: prev.groups.map((g, i) => (i === index ? { ...g, ...patch } : g)) } : prev))
  }

  async function handleConfirmImport() {
    if (!preview) return
    const toImport = importableGroups(preview)
    if (toImport.some((g) => !g.service.trim())) {
      toast.error(t('serviceRequiredHint'))
      return
    }
    const res = await vaultApi.call('recovery_codes_import_confirm', {
      source_file_name: preview.sourceFileName,
      groups: toImport.map((g) => ({
        service: g.service,
        account_label: g.accountLabel,
        codes: g.codes,
        ...(g.matchedGroupId ? { group_id: g.matchedGroupId } : {}),
      })),
      // 剪贴板导入没有 inputPath，这两个字段一起省掉——只传 delete_source
      // 而没有路径，后端也删不了任何东西。
      ...(preview.inputPath && deleteSourceOnImport
        ? { input_path: preview.inputPath, delete_source: true }
        : {}),
    })
    if (!res.ok) {
      toast.error(t('importConfirmFailedToast'), { description: translateError(res.error, res.error_params) })
      return
    }
    setGroups((prev) => {
      let next = prev
      for (const g of res.groups) {
        const exists = next.some((x) => x.id === g.id)
        next = exists ? next.map((x) => (x.id === g.id ? g : x)) : [...next, g]
      }
      return next
    })
    if (res.groups.length === 1) {
      toast.success(t('importConfirmedToast', { service: res.groups[0].service, count: res.groups[0].codes.length }), {
        action: { label: t('undoButton'), onClick: handleUndo },
      })
    } else {
      toast.success(t('importConfirmedMultiToast', { count: res.groups.length }), {
        action: { label: t('undoButton'), onClick: handleUndo },
      })
    }
    // 导入成了、但勾选的"删除源文件"没成——明文恢复码还躺在原地，必须说。
    // 这跟文件加密那边踩过的坑是同一个：ok:true 只代表主操作成功。
    if (res.source_deleted === false) {
      toast.error(
        t('importSourceNotDeletedError', {
          reason: res.delete_error
            ? translateError(res.delete_error, res.delete_error_params)
            : t('importSourceNotDeletedUnknownReason'),
        }),
      )
    }
    void reloadRecentActivity()
    if (importQueue.length > 0) {
      await advanceImportQueue()
    } else {
      setPreview(null)
    }
  }

  function handleSkipImport() {
    if (importQueue.length > 0) {
      void advanceImportQueue()
    } else {
      setPreview(null)
    }
  }

  // OCR：粘贴或选择一张截图，本地识别后逐条勾选确认，避免识别错误的字符
  // 被直接当作真实密钥写入（spec 3.1 OCR 导入）。
  async function runOcr(image: File | Blob | string) {
    setOcrBusy(true)
    try {
      const text = await recognizeText(image)
      const res = await vaultApi.call('recovery_codes_import_preview', { text, source_file_name: '' })
      if (!res.ok) {
        toast.error(t('importPreviewFailedToast'), { description: translateError(res.error, res.error_params) })
        return
      }
      // OCR 文本永远不含 '#' 分组头，parse_grouped_text 必然只回一个分组。
      const scanned = res.groups[0]
      if (!scanned || scanned.codes.length === 0) {
        toast.error(t('importPreviewFailedToast'))
        return
      }
      setOcrDialogOpen(false)
      setOcrChecklist(scanned.codes.map((code) => ({ code, checked: true, isSuspect: scanned.suspectCodes?.includes(code) ?? false })))
    } catch (error) {
      // 识别抛错（worker/wasm 加载失败、图片解不开）必须 catch 并提示，否则静默 reject 只剩转圈停下。
      // 识别在渲染端本地跑，错误信息不含保险库数据，可直接展示。
      toast.error(t('importOcrFailedToast'), {
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setOcrBusy(false)
    }
  }

  function handleOcrPaste(e: React.ClipboardEvent) {
    const item = Array.from(e.clipboardData.items).find((i) => i.type.startsWith('image/'))
    const file = item?.getAsFile()
    if (file) void runOcr(file)
  }

  async function handleOcrPickFile() {
    const paths = await electronApi.openFiles({
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'bmp', 'gif'] }],
    })
    if (!paths || paths.length === 0) return
    await runOcr(filePathToFileUrl(paths[0]))
  }

  async function handleOcrChecklistConfirm() {
    if (!ocrChecklist) return
    const confirmed = ocrChecklist.filter((c) => c.checked).map((c) => c.code)
    setOcrChecklist(null)
    if (confirmed.length === 0) return
    await runImportPreview({ text: confirmed.join('\n'), source_file_name: '' })
  }

  async function handleDelete(group: RecoveryCodeGroup) {
    const res = await vaultApi.call('recovery_codes_delete', { id: group.id })
    setDeleteTarget(null)
    if (!res.ok) {
      toast.error(t('deleteFailedToast'), { description: translateError(res.error, res.error_params) })
      return
    }
    setGroups((prev) => prev.filter((g) => g.id !== group.id))
    if (detailId === group.id) setDetailId(null)
    toast.success(t('deletedToast'), {
      action: { label: t('undoButton'), onClick: handleUndo },
    })
    void reloadRecentActivity()
  }

  async function handleBulkDelete() {
    // 只删**看得见的**已选项。换了筛选之后，被筛掉的那几条还留在 selectedIds 里，
    // 顺手一起删掉就是删了用户此刻根本看不到的东西。
    const ids = [...visibleSelectedIds]
    if (ids.length === 0) return
    const res = await vaultApi.call('recovery_codes_delete_bulk', { ids })
    setGroups((prev) => prev.filter((g) => !ids.includes(g.id)))
    setSelectedIds(new Set())
    toast.success(t('bulkDeletedToast', { count: res.deleted_count }), {
      action: { label: t('undoButton'), onClick: handleUndo },
    })
    void reloadRecentActivity()
  }

  async function handleUndo() {
    const res = await vaultApi.call('recovery_codes_undo', {})
    if (!res.ok) {
      toast.error(res.error === 'recovery_codes.undo_window_expired' ? t('undoFailedExpiredToast') : t('undoFailedToast'))
      return
    }
    setGroups(res.groups)
    toast.success(t('undoToast'))
    void reloadRecentActivity()
  }

  // 批量修改 / 合并重复项 / 时间线恢复都带 batch_id，撤销走这里：每个服务回到
  // 这一批之前的那一版。跟上面 10 秒的 handleUndo 不同，它不受时间窗限制。
  async function handleBatchUndo(batchId: string) {
    const res = await vaultApi.call('recovery_codes_batch_undo', { batch_id: batchId })
    if (!res.ok) {
      toast.error(t('timelineBatchUndoFailedToast'), { description: translateError(res.error, res.error_params) })
      return
    }
    await reload()
    toast.success(t('timelineBatchUndoneToast', { count: res.restored_count }))
    void reloadRecentActivity()
  }

  async function handleBulkMarkChecked() {
    const ids = [...visibleSelectedIds]
    if (ids.length === 0) return
    const res = await vaultApi.call('recovery_codes_update_meta_bulk', { ids, mark_checked: true })
    if (!res.ok) {
      toast.error(t('bulkEditFailedToast'), { description: translateError(res.error, res.error_params) })
      return
    }
    await reload()
    toast.success(t('bulkMarkCheckedToast', { count: ids.length }))
  }

  async function handleSaveMeta() {
    if (!editTarget) return
    const res = await vaultApi.call('recovery_codes_update_meta', {
      id: editTarget.id,
      note: editNote,
      low_stock_threshold: Number(editLowStock) || 0,
      review_interval_days: Number(editReviewDays) || 0,
    })
    if (!res.ok) {
      toast.error(t('editMetaFailedToast'), { description: translateError(res.error, res.error_params) })
      return
    }
    setGroups((prev) => prev.map((g) => (g.id === res.group.id ? res.group : g)))
    setEditTarget(null)
  }

  async function handleExport(ids?: string[], exportFormat: 'txt' | 'csv' | 'json' = 'txt') {
    const ext = exportFormat
    const savePath = await electronApi.saveFile({ defaultPath: `recovery-codes.${ext}` })
    if (!savePath) return
    const res = await vaultApi.call('recovery_codes_export_text', { output_path: savePath, ...(ids ? { ids } : {}), format: exportFormat })
    if (!res.ok) {
      toast.error(t('exportFailedToast'), { description: translateError(res.error, res.error_params) })
      return
    }
    toast.success(t('exportCompleteToast'), {
      action: { label: t('openFolderAction'), onClick: () => electronApi.showItemInFolder(res.output_path) },
    })
    void reloadRecentActivity()
  }

//   handleEmergencySearch - placeholder for v5 emergency mode
  // handleQrGenerate - placeholder for v5 QR code generation
  // handleQrDismiss - placeholder for v5 QR dismiss

  function setExportMenuOpen(open: boolean) { setExportFormatMenuOpen(open) }

  function handleExportWithFormat(fmt: 'txt' | 'csv' | 'json') {
    pendingExportFormatRef.current = fmt
    setExportFormatMenuOpen(false)
    // JSON 多走一步选项对话框：它是唯一能加密/脱敏/分片的格式，而这几个开关
    // 各自都会改变导出文件的**安全属性**，不能靠默认值替用户决定。
    if (fmt === 'json') {
      // 有勾选就只导勾选的那几个。跟旁边"导出所选"按钮的行为对齐——
      // 勾了东西却导出全部，是那种事后才发现的意外。
      setJsonExportIds(visibleSelectedIds.length > 0 ? visibleSelectedIds : undefined)
      setJsonExportPlaintextAck(false)
      // 跟"导出完整备份"同一道门槛：这两个动作都会把整套恢复码带离这台机器，
      // 所以都要先证明现在坐在电脑前的还是本人。
      requireReverify(() => setJsonExportOpen(true))
      return
    }
    handleExport(undefined, fmt)
  }

  const JSON_EXPORT_PASSWORD_MIN_LENGTH = 8

  async function handleJsonExportConfirm() {
    if (jsonExportEncrypt && jsonExportPassword.length < JSON_EXPORT_PASSWORD_MIN_LENGTH) {
      toast.error(t('backupPasswordTooShortHint'))
      return
    }
    const splitSize = Number.parseInt(jsonExportSplitSize, 10)
    const savePath = await electronApi.saveFile({
      defaultPath: 'recovery-codes.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    if (!savePath) return

    const res = await vaultApi.call('recovery_codes_export_json', {
      output_path: savePath,
      ...(jsonExportIds ? { ids: jsonExportIds } : {}),
      only_unused: jsonExportOnlyUnused,
      include_codes: !jsonExportRedact,
      ...(jsonExportEncrypt ? { password: jsonExportPassword } : {}),
      ...(Number.isFinite(splitSize) && splitSize > 0 ? { split_size: splitSize } : {}),
    })
    setJsonExportOpen(false)
    setJsonExportPassword('')
    if (!res.ok) {
      toast.error(t('exportFailedToast'), { description: translateError(res.error, res.error_params) })
      return
    }
    toast.success(t('jsonExportCompleteToast', { files: res.output_paths.length, groups: res.group_count }), {
      action: { label: t('openFolderAction'), onClick: () => electronApi.showItemInFolder(res.output_paths[0]) },
    })
    void reloadRecentActivity()
  }

  async function handleJsonImportPickFile() {
    const paths = await electronApi.openFiles({ filters: [{ name: 'JSON', extensions: ['json'] }] })
    if (!paths || paths.length === 0) return
    setJsonImportPath(paths[0])
    setJsonImportPassword('')
    // 先按"没有密码"试一次。绝大多数导出是明文的，让每个人都先过一道密码框
    // 纯属添堵；真是加密的，后端会回 json_password_required，那时再问。
    void runJsonImportPreview(paths[0], '')
  }

  async function runJsonImportPreview(path: string, password: string) {
    const res = await vaultApi.call('recovery_codes_json_import_preview', {
      input_path: path,
      ...(password ? { password } : {}),
    })
    if (!res.ok) {
      if (res.error === 'recovery_codes.json_password_required') {
        setJsonImportStep('password')
        return
      }
      toast.error(t('jsonImportFailedToast'), { description: translateError(res.error, res.error_params) })
      return
    }
    // 默认值的取法跟备份导入一致：只有文件里有的→默认导入；冲突→默认保留本地
    // （更保守，覆盖和合并都得用户主动选）。
    const defaults: Record<string, 'keep_local' | 'use_file' | 'merge'> = {}
    for (const item of res.items) {
      if (item.status === 'backup_only') defaults[item.key] = 'use_file'
      else if (item.status === 'conflict') defaults[item.key] = 'keep_local'
    }
    setJsonImportMeta(res.meta)
    setJsonImportItems(res.items)
    setJsonImportDamaged(res.damaged)
    setJsonImportDecisions(defaults)
    setJsonImportStep('review')
  }

  async function handleJsonImportConfirm() {
    const res = await vaultApi.call('recovery_codes_json_import_confirm', {
      input_path: jsonImportPath,
      ...(jsonImportPassword ? { password: jsonImportPassword } : {}),
      decisions: jsonImportDecisions,
    })
    if (!res.ok) {
      toast.error(t('jsonImportFailedToast'), { description: translateError(res.error, res.error_params) })
      return
    }
    setGroups(res.groups)
    setJsonImportStep(null)
    setJsonImportPath('')
    setJsonImportPassword('')
    toast.success(t('jsonImportCompleteToast', { count: res.applied_count }))
    void reloadRecentActivity()
  }

  function openGroupTimeline(group: RecoveryCodeGroup) {
    setTimelineScope({ ids: [group.id], title: t('timelineDialogTitleOne', { service: group.service }) })
  }

  // 一行顶栏：每组功能是一个菜单，当前状态写在触发器上。
  // 行为不变：导出先重新验证，导入先预览再写入，删除保留 10 秒撤销。
  const lowStockCount = groups.filter((g) => g.isLowStock).length
  const reviewCount = groups.filter((g) => g.needsReview).length
  const selectedCount = visibleSelectedIds.length
  const selectedGroups = filtered.filter((g) => selectedIds.has(g.id))

  // 选了某一类就切到列表：总览页只画「库存不足 / 建议核对 / 最近操作」三块，
  // 在那里选「GitHub」什么都不会变，用户会以为没点上。
  function chooseFilter(next: RecoveryFilter) {
    setFilter(next)
    if (next.kind !== 'all') setView('list')
  }

  function filterLabel(f: RecoveryFilter): string | undefined {
    switch (f.kind) {
      case 'all':
        return undefined
      case 'lowStock':
        return t('lowStockBadge')
      case 'review':
        return t('reviewDueBadge')
      case 'service': {
        const name = facets.find((x) => x.key === f.key)?.service ?? f.key
        if (f.account === undefined) return name
        return `${name} › ${f.account || t('noAccountLabel')}`
      }
    }
  }

  function selectAllFiltered() {
    setSelectMode(true)
    setView('list')
    setSelectedIds(new Set(filtered.map((g) => g.id)))
  }

  const serviceMenuItems: TopBarNode[] = [
    {
      id: 'filter-all',
      type: 'item',
      label: t('filterAll'),
      icon: KeyRound,
      selected: filter.kind === 'all',
      count: groups.length,
      onSelect: () => chooseFilter(ALL_RECOVERY),
    },
    {
      id: 'filter-low',
      type: 'item',
      label: t('lowStockBadge'),
      icon: AlertTriangle,
      selected: filter.kind === 'lowStock',
      count: lowStockCount,
      onSelect: () => chooseFilter({ kind: 'lowStock' }),
    },
    {
      id: 'filter-review',
      type: 'item',
      label: t('reviewDueBadge'),
      icon: CalendarClock,
      selected: filter.kind === 'review',
      count: reviewCount,
      onSelect: () => chooseFilter({ kind: 'review' }),
    },
    { id: 'filter-sep', type: 'separator' },
    {
      // 服务 ▸ 账号两层。只有一个账号的服务不再往下套一层——点开一个只有
      // 「全部」一项的子菜单，是在让人多点一下什么也没得到。
      id: 'filter-by-service',
      type: 'submenu',
      label: t('filterByService'),
      icon: Layers,
      count: facets.length,
      active: filter.kind === 'service',
      disabled: facets.length === 0,
      children: facets.map((facet): TopBarNode => {
        const here = filter.kind === 'service' && filter.key === facet.key
        const account = filter.kind === 'service' ? filter.account : undefined
        if (facet.accounts.length <= 1) {
          return {
            id: `svc-${facet.key}`,
            type: 'item',
            label: facet.service,
            selected: here,
            count: facet.count,
            onSelect: () => chooseFilter({ kind: 'service', key: facet.key }),
          }
        }
        return {
          id: `svc-${facet.key}`,
          type: 'submenu',
          label: facet.service,
          count: facet.count,
          active: here,
          children: [
            {
              id: `svc-${facet.key}-all`,
              type: 'item',
              label: t('filterAllAccounts', { service: facet.service }),
              selected: here && account === undefined,
              count: facet.count,
              onSelect: () => chooseFilter({ kind: 'service', key: facet.key }),
            },
            { id: `svc-${facet.key}-sep`, type: 'separator' },
            ...facet.accounts.map(
              (a): TopBarNode => ({
                id: `svc-${facet.key}-acct-${a.label}`,
                type: 'item',
                label: a.label || t('noAccountLabel'),
                selected: here && account === a.label,
                count: a.count,
                onSelect: () => chooseFilter({ kind: 'service', key: facet.key, account: a.label }),
              }),
            ),
          ],
        }
      }),
    },
  ]

  const sortOptions: Array<{ mode: SortMode; label: string }> = [
    { mode: 'recent', label: t('sortModeRecent') },
    { mode: 'name', label: t('sortModeName') },
    { mode: 'remaining', label: t('sortModeRemaining') },
  ]

  const needSelection = selectedCount === 0
  const selectionHint = needSelection ? t('bulkNeedsSelectionHint') : t('bulkAppliesToSelected', { count: selectedCount })

  const topBarMenus: TopBarMenu[] = [
    {
      id: 'view',
      label: t('menuView'),
      icon: LayoutDashboard,
      value: view === 'dashboard' ? t('dashboardViewButton') : t('listViewButton'),
      items: [
        {
          id: 'view-dashboard',
          type: 'item',
          label: t('dashboardViewButton'),
          icon: LayoutDashboard,
          selected: view === 'dashboard',
          onSelect: () => setView('dashboard'),
        },
        {
          id: 'view-list',
          type: 'item',
          label: t('listViewButton'),
          icon: List,
          selected: view === 'list',
          count: groups.length,
          onSelect: () => setView('list'),
        },
      ],
    },
    {
      id: 'services',
      label: t('menuServices'),
      icon: Layers,
      value: filterLabel(filter),
      active: filter.kind !== 'all',
      onClear: () => setFilter(ALL_RECOVERY),
      contentClassName: 'min-w-60',
      items: serviceMenuItems,
    },
    {
      id: 'sort',
      label: t('sortModeLabel'),
      icon: ArrowUpDown,
      value: sortOptions.find((o) => o.mode === sortMode)?.label,
      items: sortOptions.map(
        (o): TopBarNode => ({
          id: `sort-${o.mode}`,
          type: 'item',
          label: o.label,
          selected: sortMode === o.mode,
          onSelect: () => setSortMode(o.mode),
        }),
      ),
    },
    {
      // 批量动作只作用于看得见的已选项（visibleSelectedIds）；未选时置灰并说明，不做"点了没东西"的按钮。
      id: 'bulk',
      label: t('menuBulk'),
      icon: ListChecks,
      value: selectedCount > 0 ? t('selectedCountLabel', { count: selectedCount }) : undefined,
      active: selectedCount > 0,
      onClear: () => setSelectedIds(new Set()),
      contentClassName: 'min-w-64',
      items: [
        {
          id: 'select-mode',
          type: 'toggle',
          label: t('selectModeToggle'),
          description: t('selectModeHint'),
          checked: selectMode,
          onCheckedChange: (next) => {
            setSelectMode(next)
            if (next) setView('list')
            else setSelectedIds(new Set())
          },
        },
        {
          id: 'select-all',
          type: 'item',
          label: t('selectAllLabel'),
          icon: SquareCheck,
          count: filtered.length,
          disabled: filtered.length === 0 || allFilteredSelected,
          onSelect: selectAllFiltered,
        },
        {
          id: 'select-none',
          type: 'item',
          label: t('clearSelectionLabel'),
          icon: Square,
          disabled: needSelection,
          onSelect: () => setSelectedIds(new Set()),
        },
        { id: 'bulk-sep', type: 'separator' },
        {
          id: 'bulk-edit',
          type: 'item',
          label: t('bulkEditMenuItem'),
          icon: PencilLine,
          description: selectionHint,
          disabled: needSelection,
          onSelect: () => setBulkEditTargets(selectedGroups),
        },
        {
          id: 'bulk-checked',
          type: 'item',
          label: t('markCheckedButton'),
          icon: CalendarCheck,
          disabled: needSelection,
          onSelect: () => void handleBulkMarkChecked(),
        },
        {
          id: 'bulk-export',
          type: 'item',
          label: t('exportSelectedButton'),
          icon: ArrowUpFromLine,
          disabled: needSelection,
          onSelect: () => void handleExport(visibleSelectedIds),
        },
        {
          id: 'bulk-pdf',
          type: 'item',
          label: t('pdfExportSelectedButton'),
          icon: Printer,
          hidden: !isProfessional,
          disabled: needSelection,
          onSelect: () => handleExportPdf(selectedGroups),
        },
        {
          id: 'bulk-delete',
          type: 'item',
          label: t('deleteSelectedButton'),
          icon: Trash2,
          destructive: true,
          disabled: needSelection,
          onSelect: () => void handleBulkDelete(),
        },
      ],
    },
    {
      id: 'dedupe',
      label: t('menuDedupe'),
      icon: CopyCheck,
      items: [
        {
          id: 'dedupe-scan',
          type: 'item',
          label: t('dedupeScanMenuItem'),
          icon: CopyCheck,
          description: t('dedupeScanHint'),
          disabled: groups.length === 0,
          onSelect: () => setDedupeOpen(true),
        },
      ],
    },
    {
      id: 'timeline',
      label: t('menuTimeline'),
      icon: History,
      items: [
        {
          id: 'timeline-all',
          type: 'item',
          label: t('timelineAllMenuItem'),
          icon: History,
          onSelect: () => setTimelineScope({ title: t('timelineDialogTitleAll') }),
        },
        {
          id: 'timeline-selected',
          type: 'item',
          label: t('timelineSelectedMenuItem'),
          icon: ListChecks,
          description: selectionHint,
          disabled: needSelection,
          onSelect: () =>
            setTimelineScope({ ids: [...visibleSelectedIds], title: t('timelineDialogTitleSome', { count: selectedCount }) }),
        },
        {
          id: 'timeline-current',
          type: 'item',
          label: t('timelineCurrentMenuItem', { service: detailGroup?.service ?? '' }),
          icon: KeyRound,
          hidden: !detailGroup || view !== 'list',
          onSelect: () => detailGroup && openGroupTimeline(detailGroup),
        },
      ],
    },
    {
      // 导入与导出图标成对区分（箭头指向线 = 进，离开线 = 出），纯图标模式下才不会一模一样。
      id: 'data',
      label: t('menuData'),
      icon: Upload,
      items: [
        {
          id: 'import-sub',
          type: 'submenu',
          label: t('importButton'),
          icon: ArrowDownToLine,
          children: [
            { id: 'import', type: 'item', label: t('importFromFileMenuItem'), icon: ArrowDownToLine, onSelect: () => void handleImportFiles() },
            { id: 'import-clipboard', type: 'item', label: t('importClipboardButton'), icon: Clipboard, onSelect: () => void handleClipboardImport() },
            { id: 'import-ocr', type: 'item', label: t('importOcrButton'), icon: ScanText, onSelect: () => setOcrDialogOpen(true) },
            // JSON 导入独立于上面那条"从文件导入"：那条走文本解析，只认得出码；
            // 这条是无损的，会把 used/备注/阈值/历史一起带回来，并给出逐组差异。
            { id: 'json-import', type: 'item', label: t('jsonImportButton'), icon: FileJson, onSelect: () => void handleJsonImportPickFile() },
            { id: 'backup-import', type: 'item', label: t('backupImportButton'), icon: FolderInput, hidden: !isProfessional, onSelect: () => void handleBackupImportPickFile() },
          ],
        },
        {
          id: 'export-sub',
          type: 'submenu',
          label: t('exportButton'),
          icon: ArrowUpFromLine,
          children: [
            { id: 'export', type: 'item', label: t('exportFormatsMenuItem'), icon: ArrowUpFromLine, onSelect: () => setExportMenuOpen(true) },
            { id: 'export-pdf-all', type: 'item', label: t('pdfExportAllButton'), icon: Printer, hidden: !isProfessional, onSelect: () => handleExportPdf(groups) },
            { id: 'backup-export', type: 'item', label: t('backupExportButton'), icon: FolderArchive, hidden: !isProfessional, onSelect: handleBackupExportOpen },
          ],
        },
      ],
    },
  ]

  return (
    // h-full 改 min-h-0 flex-1：height:100% 与 main 等高，但 main 里还有「接着刚才」横幅，
    // 多出的一截会被 overflow-hidden 裁掉；flex-1 取剩余高度。
    <div className="ds-page-wash flex min-h-0 flex-1 flex-col">
      {/* px-6 是这一页自己的左右留白（它整页自管滚动，不套 PageShell）。
          `shrink-0`：下面那块要滚，它自己绝不能被压扁。 */}
      <div className="shrink-0 px-6 pt-4 pb-3">
        <PageHeader title={t('pageTitle')} />
        {/* 三块数字都能点，点了直接进完整列表。原来它们只是三个不能碰的方块，
            告诉你"有 12 个服务"却不给任何看到那 12 个的入口。放在顶栏最左边、
            跟视图脱钩：切到"列表"视图也一直在。 */}
        <TopBar
          className="border-b border-border/70 pb-3"
          leading={
            <>
              <StatTile
                compact
                label={t('dashboardServiceCountLabel')}
                value={totals.services}
                hint={t('dashboardOpenListHint')}
                onClick={() => setView('list')}
              />
              <StatTile
                compact
                label={t('dashboardCodeCountLabel')}
                value={totals.codes}
                hint={t('dashboardOpenListHint')}
                onClick={() => setView('list')}
              />
              <StatTile
                compact
                label={t('dashboardRemainingCountLabel')}
                value={totals.remaining}
                hint={t('dashboardOpenListHint')}
                onClick={() => setView('list')}
              />
            </>
          }
          menus={topBarMenus}
          trailing={
            <>
              <TopBarSearch value={search} onChange={setSearch} placeholder={t('searchPlaceholder')} />
              <Button size="sm" onClick={() => void handleImportFiles()}>
                <ArrowDownToLine className="size-4" aria-hidden="true" />
                {t('importButton')}
              </Button>
            </>
          }
        />
      </div>

      {view === 'dashboard' && (
        <RecoveryCodesDashboard
          groups={groups}
          recentActivity={recentActivity}
          onOpenGroup={openGroupInList}
        />
      )}

      {view === 'list' && (
      // 左选右看用全应用共用的 <Workbench>，不再各页手写宽度比例。
      <Workbench
        listRef={scrollParentRef}
        listProps={{
          onDragOver: handleDragOver,
          onDragLeave: handleDragLeave,
          onDrop: handleDrop,
          className: cn(dragActive && 'bg-muted/50 ring-2 ring-inset ring-primary'),
        }}
        selected={Boolean(detailGroup)}
        onBack={() => setDetailId(null)}
        backLabel={tCommon('backToList')}
        placeholder={<EmptyState icon={KeyRound} title={t('detailEmptyState')} className="m-6" />}
        list={
          <>
          {damaged.length > 0 && (
            <Alert variant="destructive" className="m-2">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>
                {damaged.map((d, i) => (
                  <div key={i}>
                    {d.service ?? '?'} — {t('damagedRecordHint')}
                  </div>
                ))}
              </AlertDescription>
            </Alert>
          )}
          {filtered.length === 0 && damaged.length === 0 && (
            // 库里有东西、只是被「服务」筛选或搜索筛空了，就不能再说"还没有保存
            // 任何恢复码"——那是一句错的话，用户会以为自己的码没了。
            <div className="p-6 text-center text-sm text-muted-foreground">
              {groups.length > 0 ? (
                <>
                  <p className="font-medium">{t('filterNoMatch')}</p>
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-3"
                    onClick={() => {
                      setFilter(ALL_RECOVERY)
                      setSearch('')
                    }}
                  >
                    {t('filterClearButton')}
                  </Button>
                </>
              ) : (
                <>
                  <p className="font-medium">{t('emptyStateTitle')}</p>
                  <p className="mt-1">{t('emptyStateHint')}</p>
                </>
              )}
            </div>
          )}
          {filtered.length > 0 && (
            <div style={{ height: rowVirtualizer.getTotalSize(), position: 'relative' }}>
              {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                const g = filtered[virtualRow.index]
                return (
                  <div
                    key={g.id}
                    ref={rowVirtualizer.measureElement}
                    data-index={virtualRow.index}
                    style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${virtualRow.start}px)` }}
                  >
                    <button
                      onClick={() => setDetailId(g.id)}
                      className={cn(
                        'flex w-full flex-col items-start gap-1 border-b p-3 text-left hover:bg-muted/50',
                        detailId === g.id && 'bg-muted',
                      )}
                    >
                      <div className="flex w-full items-center gap-2">
                        {selectMode && (
                          <Checkbox
                            checked={selectedIds.has(g.id)}
                            onCheckedChange={(c) => toggleSelected(g.id, !!c)}
                            onClick={(e) => e.stopPropagation()}
                            aria-label={t('selectServiceAriaLabel', { service: g.service })}
                          />
                        )}
                        <span className="font-medium">{g.service}</span>
                        {g.accountLabel && <span className="text-sm text-muted-foreground">{g.accountLabel}</span>}
                      </div>
                      <div className="flex flex-wrap gap-1 text-sm">
                        <span className="rounded bg-muted px-1.5 py-0.5">{t('remainingCountLabel', { remaining: g.remainingCount, total: g.codes.length })}</span>
                        {g.isLowStock && <span className="rounded bg-destructive/10 px-1.5 py-0.5 text-destructive">{t('lowStockBadge')}</span>}
                        {g.needsReview && <span className="rounded bg-warning/10 px-1.5 py-0.5 text-warning">{t('reviewDueBadge')}</span>}
                      </div>
                    </button>
                  </div>
                )
              })}
            </div>
          )}
          </>
        }
        detail={
          detailGroup && (
            <div className="space-y-4 p-6">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <FeatureTitle>{detailGroup.service}</FeatureTitle>
                  {detailGroup.accountLabel && <p className="text-sm text-muted-foreground">{detailGroup.accountLabel}</p>}
                </div>
                <div className="flex flex-wrap justify-end gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setEditTarget(detailGroup)
                      setEditNote(detailGroup.note)
                      setEditLowStock(String(detailGroup.lowStockThreshold))
                      setEditReviewDays(String(detailGroup.reviewIntervalDays))
                    }}
                  >
                    {t('editMetaButton')}
                  </Button>
                  {/* 修改记录 = 每一版的完整内容，能看、能比、能恢复；导入历史只是
                      一行行"哪天导入了什么"的流水，两者都留着。 */}
                  <Button size="sm" variant="outline" onClick={() => openGroupTimeline(detailGroup)}>
                    <History className="mr-1 h-3.5 w-3.5" />
                    {t('timelineButton')}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setHistoryTarget(detailGroup)}>
                    <ScrollText className="mr-1 h-3.5 w-3.5" />
                    {t('viewHistoryButton')}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => handleExportPdf([detailGroup])}>
                    <FileText className="mr-1 h-3.5 w-3.5" />
                    {t('pdfExportButton')}
                  </Button>
                  <Button size="sm" variant="destructive" onClick={() => setDeleteTarget(detailGroup)}>
                    <Trash2 className="mr-1 h-3.5 w-3.5" />
                    {t('deleteButton')}
                  </Button>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2 text-sm text-muted-foreground">
                <div>{t('sourceFileLabel')}: {detailGroup.sourceFileName || '—'}</div>
                <div>{t('firstImportedAtLabel')}: {formatDateTime(detailGroup.firstImportedAt)}</div>
                <div>{t('lastUpdatedAtLabel')}: {formatDateTime(detailGroup.lastUpdatedAt)}</div>
                <div>{t('lastCheckedAtLabel')}: {formatDateTime(detailGroup.lastCheckedAt)}</div>
              </div>

              <div>
                <div className="mb-2 flex items-center justify-between">
                  <Label>{t('codesLabel')}</Label>
                  {revealedByGroup[detailGroup.id] ? (
                    <Button size="sm" variant="ghost" onClick={() => handleHide(detailGroup.id)}>
                      <EyeOff className="mr-1 h-3.5 w-3.5" />
                      {t('hideButton')}
                    </Button>
                  ) : (
                    <Button size="sm" variant="ghost" onClick={() => handleReveal(detailGroup)}>
                      <Eye className="mr-1 h-3.5 w-3.5" />
                      {t('revealButton')}
                    </Button>
                  )}
                </div>
                <div className="space-y-1 rounded border p-2">
                  {detailGroup.codes.map((c) => {
                    const revealed = revealedByGroup[detailGroup.id]?.find((r) => r.index === c.index)
                    return (
                      <div key={c.index} className={cn('flex items-center justify-between rounded px-2 py-1', c.used && 'opacity-50')}>
                        <span className="font-mono text-sm">{revealed ? revealed.code : '•••••-•••••'}</span>
                        <div className="flex items-center gap-2">
                          {c.used && <span className="text-sm text-muted-foreground">{t('usedBadge')}</span>}
                          {revealed && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  aria-label={t('copyButton')}
                                  onClick={() => copyWithAutoClear(revealed.code)}
                                >
                                  <Copy className="h-3.5 w-3.5" />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>{t('copyButton')}</TooltipContent>
                            </Tooltip>
                          )}
                          <Checkbox
                            checked={c.used}
                            onCheckedChange={(checked) => handleMarkUsed(detailGroup, c.index, !!checked)}
                          />
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>

              {detailGroup.needsReview && (
                <Button size="sm" variant="outline" onClick={() => handleMarkChecked(detailGroup)}>
                  {t('markCheckedButton')}
                </Button>
              )}

              {detailGroup.note && (
                <div>
                  <Label>{t('noteLabel')}</Label>
                  <p className="text-sm">{detailGroup.note}</p>
                </div>
              )}
            </div>
          )
        }
      />
      )}

      <Dialog open={preview !== null} onOpenChange={(open) => !open && setPreview(null)}>
        <DialogContent className={REVIEW_DIALOG}>
          <DialogHeader>
            <DialogTitle>{t('importPreviewDialogTitle')}</DialogTitle>
          </DialogHeader>
          {preview && (
            <>
            <div className={FORM_BODY}>
              {preview.groups.length > 1 && (
                <p className="text-sm text-muted-foreground">{t('importPreviewGroupCountLabel', { count: preview.groups.length })}</p>
              )}
              <div className="space-y-3">
                {preview.groups.map((g, i) => (
                  <div
                    key={i}
                    className={
                      preview.groups.length > 1
                        ? 'space-y-4 rounded-xl border border-border bg-surface p-5'
                        : 'space-y-4'
                    }
                  >
                    <div className="text-sm">
                      {g.action === 'new' && <span className="text-success">{t('importPreviewActionNew')}</span>}
                      {g.action === 'unchanged' && <span className="text-muted-foreground">{t('importPreviewActionUnchanged')}</span>}
                      {g.action === 'changed' && <span className="text-warning">{t('importPreviewActionChanged')}</span>}
                      {g.action === 'unchanged' && <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{t('importPreviewUnchangedHint')}</p>}
                    </div>
                    <div className="grid gap-x-5 gap-y-5 sm:grid-cols-2">
                      <div className={FIELD}>
                        <Label>{t('serviceLabel')}</Label>
                        <Input value={g.service} onChange={(e) => updatePreviewGroup(i, { service: e.target.value })} />
                      </div>
                      <div className={FIELD}>
                        <Label>{t('accountLabelLabel')}</Label>
                        <Input
                          value={g.accountLabel}
                          placeholder={t('accountLabelPlaceholder')}
                          onChange={(e) => updatePreviewGroup(i, { accountLabel: e.target.value })}
                        />
                      </div>
                    </div>
                    <p className="text-sm">{t('importPreviewCodesCountLabel', { count: g.codes.length })}</p>
                    {g.invalidLines.length > 0 && (
                      <Alert variant="destructive">
                        <AlertDescription>
                          <p>{t('importPreviewInvalidLinesHint', { count: g.invalidLines.length })}</p>
                          {g.invalidLines.map((l) => (
                            <p key={l.lineNumber} className="font-mono text-sm">
                              {t('invalidLineLabel', { line: l.lineNumber, raw: l.raw })}
                            </p>
                          ))}
                        </AlertDescription>
                      </Alert>
                    )}
                  </div>
                ))}
              </div>
              {importQueue.length > 0 && (
                <p className="text-sm text-muted-foreground">{t('importQueueRemainingLabel', { count: importQueue.length })}</p>
              )}
              {preview.inputPath && (
                <div className="flex items-start gap-2 rounded border border-dashed border-warning/40 bg-warning/5 px-3 py-2">
                  <Checkbox
                    id="rc-import-delete-source"
                    className="mt-0.5"
                    checked={deleteSourceOnImport}
                    onCheckedChange={(v) => setDeleteSourceOnImport(v === true)}
                  />
                  <Label htmlFor="rc-import-delete-source" className="cursor-pointer text-sm leading-relaxed font-normal">
                    {t('importDeleteSourceLabel')}
                    <span className="mt-0.5 block text-sm text-muted-foreground">{t('importDeleteSourceHint')}</span>
                  </Label>
                </div>
              )}
            </div>
            {/* 按钮组在滚动区**外面**：一份导入文件可能有十几个分组，按钮跟着
                内容滚的话，用户要一路滚到底才找得到"确认导入"。 */}
            <div className={DIALOG_ACTIONS}>
              <Button variant="outline" onClick={handleSkipImport}>
                {importQueue.length > 0 ? t('importSkipButton') : t('importPreviewCancelButton')}
              </Button>
              <Button onClick={handleConfirmImport} disabled={importableGroups(preview).length === 0}>
                {t('importPreviewConfirmButton')}
              </Button>
            </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={ocrDialogOpen} onOpenChange={(open) => !ocrBusy && setOcrDialogOpen(open)}>
        <DialogContent className={FORM_DIALOG}>
          <DialogHeader>
            <DialogTitle>{t('importOcrDialogTitle')}</DialogTitle>
          </DialogHeader>
          <div className={FORM_BODY}>
            {/* 这块是「把整张恢复码截图粘进来」的落点，是这个弹窗唯一的主操作，
                所以给足面积（h-40 → min-h-56）：太小的粘贴区看起来像个装饰性的
                提示条，用户不会想到往里面 Ctrl+V。

                无障碍：它是一个 <div> 而不是 <input>，屏幕阅读器默认只会念出里面
                那句提示文字，既不知道这里能接收输入、也不知道自己聚焦在什么上——
                虽然它有 tabIndex={0}、Tab 键真的会停在这儿。补 role="textbox"
                （它确实是"接收一份内容"的控件）+ aria-label（说明这是什么、要
                往里做什么），aria-busy 让识别中的状态也能被读出来。 */}
            <div
              ref={ocrPasteRef}
              tabIndex={0}
              role="textbox"
              aria-label={t('importOcrPasteAriaLabel')}
              aria-busy={ocrBusy}
              onPaste={handleOcrPaste}
              className="flex min-h-56 flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed border-border bg-surface p-6 text-center text-sm leading-relaxed text-muted-foreground outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <span aria-hidden="true" className="ds-icon-chip size-12 border-accent-line bg-accent-soft text-primary">
                <ScanText className="size-6" />
              </span>
              <p className="max-w-[46ch]">{ocrBusy ? t('importOcrRecognizingLabel') : t('importOcrPasteHint')}</p>
            </div>
          </div>
          <div className={DIALOG_ACTIONS}>
            <Button variant="outline" onClick={handleOcrPickFile} disabled={ocrBusy}>
              {t('importOcrPickFileButton')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={ocrChecklist !== null} onOpenChange={(open) => !open && setOcrChecklist(null)}>
        <DialogContent className={WIDE_FORM_DIALOG}>
          <DialogHeader>
            <DialogTitle>{t('importOcrChecklistTitle')}</DialogTitle>
          </DialogHeader>
          <div className={FORM_BODY}>
            {/* 识别出来的码可能有几十条，而这一步要求用户**逐条看一眼**。
                原先 max-h-64 只露得出四五行，等于逼着人在一个小窗口里滚很久。
                改成两列 + 跟着弹窗一起长高，一屏能看完的条数翻了好几倍。 */}
            <ul className="grid gap-1.5 sm:grid-cols-2">
              {ocrChecklist?.map((item, i) => (
                <li
                  key={i}
                  className={cn(
                    'flex items-center gap-2.5 rounded-lg border border-transparent px-2.5 py-2',
                    // 可疑码高亮用 warning 语义 token：原来写死的浅色 border-yellow-500 bg-yellow-50
                    // 在深色主题下白底配浅字读不出来，且不随强调色/风格变化。
                    item.isSuspect && 'border-warning/30 bg-warning/12',
                  )}
                >
                  <Checkbox
                    checked={item.checked}
                    onCheckedChange={(checked) =>
                      setOcrChecklist((prev) => prev!.map((c, ci) => (ci === i ? { ...c, checked: !!checked } : c)))
                    }
                  />
                  <span className="min-w-0 flex-1 font-mono text-sm break-all">{item.code}</span>
                  {item.isSuspect && (
                    <span className="shrink-0 text-sm text-warning">{t('suspectCodeBadge')}</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
          <div className={DIALOG_ACTIONS}>
            <Button variant="outline" onClick={() => setOcrChecklist(null)}>
              {t('importPreviewCancelButton')}
            </Button>
            <Button onClick={handleOcrChecklistConfirm} disabled={!ocrChecklist?.some((c) => c.checked)}>
              {t('importOcrChecklistConfirmButton', { count: ocrChecklist?.filter((c) => c.checked).length ?? 0 })}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={historyTarget !== null} onOpenChange={(open) => !open && setHistoryTarget(null)}>
        <DialogContent className={FORM_DIALOG}>
          <DialogHeader>
            <DialogTitle>{t('historyDialogTitle', { service: historyTarget?.service })}</DialogTitle>
          </DialogHeader>
          <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto">
            {historyTarget?.importHistory.length === 0 && (
              <p className="text-sm text-muted-foreground">{t('historyEmptyState')}</p>
            )}
            {[...(historyTarget?.importHistory ?? [])].reverse().map((h, i) => (
              <div key={i} className="border-b pb-1 text-sm">
                <div className="flex justify-between text-sm text-muted-foreground">
                  <span>{t(`historyAction_${h.action}` as const, { defaultValue: h.action })}</span>
                  <span>{formatDateTime(h.timestamp)}</span>
                </div>
                <p>{h.changeSummary}</p>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={editTarget !== null} onOpenChange={(open) => !open && setEditTarget(null)}>
        <DialogContent className={FORM_DIALOG}>
          {editTarget && (
            <>
              <DialogHeader>
                <DialogTitle>{t('editMetaDialogTitle', { service: editTarget.service })}</DialogTitle>
              </DialogHeader>
              <div className={FORM_BODY}>
                <div className={FIELD}>
                  <Label htmlFor="rc-edit-note">{t('noteLabel')}</Label>
                  <Input
                    id="rc-edit-note"
                    value={editNote}
                    placeholder={t('notePlaceholder')}
                    onChange={(e) => setEditNote(e.target.value)}
                  />
                </div>
                {/* 两个都是"多少"，而且都是窄输入——并排放比上下摞更省一屏，
                    也让"这两条是一类设置"这件事不用靠读标签才知道。 */}
                <div className="grid gap-x-5 gap-y-5 sm:grid-cols-2">
                  <div className={FIELD}>
                    <Label htmlFor="rc-edit-lowstock">{t('lowStockThresholdLabel')}</Label>
                    <Input
                      id="rc-edit-lowstock"
                      type="number"
                      min={0}
                      value={editLowStock}
                      onChange={(e) => setEditLowStock(e.target.value)}
                    />
                  </div>
                  <div className={FIELD}>
                    <Label htmlFor="rc-edit-reviewdays">{t('reviewIntervalDaysLabel')}</Label>
                    <Input
                      id="rc-edit-reviewdays"
                      type="number"
                      min={1}
                      value={editReviewDays}
                      onChange={(e) => setEditReviewDays(e.target.value)}
                    />
                  </div>
                </div>
              </div>
              <div className={DIALOG_ACTIONS}>
                <Button variant="outline" onClick={() => setEditTarget(null)}>
                  {t('importPreviewCancelButton')}
                </Button>
                <Button onClick={handleSaveMeta}>{t('saveButton')}</Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent className={CONFIRM_DIALOG}>
          {deleteTarget && (
            <>
              <DialogHeader>
                <DialogTitle>{t('deleteConfirmTitle', { service: deleteTarget.service })}</DialogTitle>
              </DialogHeader>
              <p className="text-sm leading-relaxed text-muted-foreground">{t('deleteConfirmBody')}</p>
              <div className={DIALOG_ACTIONS}>
                <Button variant="outline" onClick={() => setDeleteTarget(null)}>
                  {t('importPreviewCancelButton')}
                </Button>
                <Button variant="destructive" onClick={() => handleDelete(deleteTarget)}>
                  {t('deleteButton')}
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={backupExportOpen} onOpenChange={(open) => !open && setBackupExportOpen(false)}>
        <DialogContent className={FORM_DIALOG}>
          <DialogHeader>
            <DialogTitle>{t('backupExportDialogTitle')}</DialogTitle>
          </DialogHeader>
          <div className={FORM_BODY}>
            <Input
              type="password"
              value={backupExportPassword}
              onChange={(e) => setBackupExportPassword(e.target.value)}
              placeholder={t('backupPasswordPlaceholder')}
            />
          </div>
          <div className={DIALOG_ACTIONS}>
            <Button variant="outline" onClick={() => setBackupExportOpen(false)}>
              {t('importPreviewCancelButton')}
            </Button>
            <Button onClick={handleBackupExportConfirm}>{t('backupExportButton')}</Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={backupImportStep === 'password'} onOpenChange={(open) => !open && setBackupImportStep(null)}>
        <DialogContent className={FORM_DIALOG}>
          <DialogHeader>
            <DialogTitle>{t('backupImportDialogTitle')}</DialogTitle>
          </DialogHeader>
          <div className={FORM_BODY}>
            <Input
              type="password"
              value={backupImportPassword}
              onChange={(e) => setBackupImportPassword(e.target.value)}
              placeholder={t('backupPasswordPlaceholder')}
            />
          </div>
          <div className={DIALOG_ACTIONS}>
            <Button variant="outline" onClick={() => setBackupImportStep(null)}>
              {t('importPreviewCancelButton')}
            </Button>
            <Button onClick={handleBackupImportPreview}>{t('backupImportPreviewButton')}</Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={backupImportStep === 'review'} onOpenChange={(open) => !open && setBackupImportStep(null)}>
        <DialogContent className={REVIEW_DIALOG}>
          <DialogHeader>
            <DialogTitle>{t('backupImportReviewTitle')}</DialogTitle>
          </DialogHeader>
          <div className={FORM_BODY}>
          {backupImportDamaged.length > 0 && (
            <Alert variant="destructive">
              <AlertDescription>{t('damagedRecordHint')}</AlertDescription>
            </Alert>
          )}
          <div className="space-y-2.5">
            {backupImportItems.map((item) => (
              <div key={item.key} className="rounded-lg border border-border bg-surface p-3.5">
                <div className="flex items-center justify-between text-sm">
                  <span className="font-medium">
                    {item.service}
                    {item.accountLabel && <span className="text-sm text-muted-foreground"> · {item.accountLabel}</span>}
                  </span>
                  <span className="text-sm text-muted-foreground">{t(`backupStatus_${item.status}` as 'backupStatus_conflict')}</span>
                </div>
                {(item.status === 'conflict' || item.status === 'backup_only') && (
                  <Select
                    value={backupImportDecisions[item.key] ?? 'keep_local'}
                    onValueChange={(v) =>
                      setBackupImportDecisions((prev) => ({ ...prev, [item.key]: v as 'keep_local' | 'use_backup' | 'merge' }))
                    }
                  >
                    <SelectTrigger className="mt-2 w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {item.status === 'conflict' && <SelectItem value="keep_local">{t('backupDecisionKeepLocal')}</SelectItem>}
                      <SelectItem value="use_backup">{t('backupDecisionUseBackup')}</SelectItem>
                      {item.status === 'conflict' && <SelectItem value="merge">{t('backupDecisionMerge')}</SelectItem>}
                    </SelectContent>
                  </Select>
                )}
              </div>
            ))}
          </div>
          </div>
          <div className={DIALOG_ACTIONS}>
            <Button variant="outline" onClick={() => setBackupImportStep(null)}>
              {t('importPreviewCancelButton')}
            </Button>
            <Button onClick={handleBackupImportConfirm}>{t('backupImportConfirmButton')}</Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={exportFormatMenuOpen} onOpenChange={(open) => !open && setExportFormatMenuOpen(false)}>
        <DialogContent className={CONFIRM_DIALOG}>
          <DialogHeader>
            <DialogTitle>{t('exportFormatDialogTitle')}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-2.5">
            <Button variant="outline" onClick={() => handleExportWithFormat('txt')}>
              TXT {t('exportFormatTxtDesc')}
            </Button>
            <Button variant="outline" onClick={() => handleExportWithFormat('csv')}>
              CSV {t('exportFormatCsvDesc')}
            </Button>
            <Button variant="outline" onClick={() => handleExportWithFormat('json')}>
              JSON {t('exportFormatJsonDesc')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={jsonExportOpen} onOpenChange={(open) => !open && setJsonExportOpen(false)}>
        <DialogContent className={WIDE_FORM_DIALOG}>
          <DialogHeader>
            <DialogTitle>{t('jsonExportDialogTitle')}</DialogTitle>
          </DialogHeader>
          <div className={FORM_BODY}>

          {/* 三个开关各自装进一张卡：它们的说明文字都不短，原先只用 gap-2 挤在
              一起时，"标题—说明—下一个标题"的节奏靠肉眼分不出层次。 */}
          <div className="space-y-3">
            <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border bg-surface px-3.5 py-3 text-sm leading-relaxed">
              <input
                type="checkbox"
                className="mt-1"
                checked={jsonExportEncrypt}
                onChange={(e) => {
                  setJsonExportEncrypt(e.target.checked)
                  // 加密和脱敏互斥：一个是"存起来"，一个是"给人看"。后端也会
                  // 拒绝同时给两者，这里先一步把界面上的矛盾消掉。
                  if (e.target.checked) setJsonExportRedact(false)
                }}
              />
              <span>
                {t('jsonExportEncryptLabel')}
                <span className="block text-sm text-muted-foreground">{t('jsonExportEncryptHint')}</span>
              </span>
            </label>
            {jsonExportEncrypt && (
              <Input
                type="password"
                value={jsonExportPassword}
                onChange={(e) => setJsonExportPassword(e.target.value)}
                placeholder={t('backupPasswordPlaceholder')}
              />
            )}

            <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border bg-surface px-3.5 py-3 text-sm leading-relaxed">
              <input
                type="checkbox"
                className="mt-1"
                checked={jsonExportRedact}
                onChange={(e) => {
                  setJsonExportRedact(e.target.checked)
                  if (e.target.checked) setJsonExportEncrypt(false)
                }}
              />
              <span>
                {t('jsonExportRedactLabel')}
                <span className="block text-sm text-muted-foreground">{t('jsonExportRedactHint')}</span>
              </span>
            </label>

            <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border bg-surface px-3.5 py-3 text-sm leading-relaxed">
              <input
                type="checkbox"
                className="mt-1"
                checked={jsonExportOnlyUnused}
                onChange={(e) => setJsonExportOnlyUnused(e.target.checked)}
              />
              <span>
                {t('jsonExportOnlyUnusedLabel')}
                <span className="block text-sm text-muted-foreground">{t('jsonExportOnlyUnusedHint')}</span>
              </span>
            </label>

            <div className={FIELD}>
              <Label htmlFor="rc-json-split">{t('jsonExportSplitLabel')}</Label>
              <Input
                id="rc-json-split"
                inputMode="numeric"
                value={jsonExportSplitSize}
                onChange={(e) => setJsonExportSplitSize(e.target.value)}
                placeholder={t('jsonExportSplitPlaceholder')}
              />
            </div>
          </div>

          {!jsonExportEncrypt && !jsonExportRedact && (
            // 明文导出的是一整套绕过两步验证的后门。不禁止，但要求明确认一次：
            // 一句红字是可以被无视的，一个必须点的勾不能。
            <Alert variant="destructive">
              <AlertDescription>
                {t('jsonExportPlaintextWarning')}
                <label className="mt-2.5 flex cursor-pointer items-start gap-2.5 leading-relaxed">
                  <input
                    type="checkbox"
                    className="mt-1.5"
                    checked={jsonExportPlaintextAck}
                    onChange={(e) => setJsonExportPlaintextAck(e.target.checked)}
                  />
                  <span>{t('jsonExportPlaintextAckLabel')}</span>
                </label>
              </AlertDescription>
            </Alert>
          )}
          </div>

          <div className={DIALOG_ACTIONS}>
            <Button variant="outline" onClick={() => setJsonExportOpen(false)}>
              {t('importPreviewCancelButton')}
            </Button>
            <Button
              onClick={handleJsonExportConfirm}
              disabled={!jsonExportEncrypt && !jsonExportRedact && !jsonExportPlaintextAck}
            >
              {t('jsonExportButton')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={jsonImportStep === 'password'} onOpenChange={(open) => !open && setJsonImportStep(null)}>
        <DialogContent className={FORM_DIALOG}>
          <DialogHeader>
            <DialogTitle>{t('jsonImportPasswordDialogTitle')}</DialogTitle>
          </DialogHeader>
          <div className={FORM_BODY}>
            <Input
              type="password"
              value={jsonImportPassword}
              onChange={(e) => setJsonImportPassword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && runJsonImportPreview(jsonImportPath, jsonImportPassword)}
              placeholder={t('backupPasswordPlaceholder')}
            />
          </div>
          <div className={DIALOG_ACTIONS}>
            <Button variant="outline" onClick={() => setJsonImportStep(null)}>
              {t('importPreviewCancelButton')}
            </Button>
            <Button onClick={() => runJsonImportPreview(jsonImportPath, jsonImportPassword)}>
              {t('backupImportPreviewButton')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={jsonImportStep === 'review'} onOpenChange={(open) => !open && setJsonImportStep(null)}>
        <DialogContent className={REVIEW_DIALOG}>
          <DialogHeader>
            <DialogTitle>{t('jsonImportReviewTitle')}</DialogTitle>
          </DialogHeader>
          <div className={FORM_BODY}>

          {/* 校验结果。checksumOk 为 null 的旧文件**不弹任何提示**——"没带校验值"
              和"校验没过"混为一谈的话，每打开一份旧导出都会来一次假警报，
              真警报也就没人看了。 */}
          {jsonImportMeta?.checksumOk === false && (
            <Alert variant="destructive">
              <AlertDescription>{t('jsonImportChecksumMismatchWarning')}</AlertDescription>
            </Alert>
          )}
          {jsonImportMeta?.formatVersion === 1 && (
            <p className="text-sm text-muted-foreground">{t('jsonImportLegacyFormatHint')}</p>
          )}
          {jsonImportDamaged.length > 0 && (
            <Alert variant="destructive">
              <AlertDescription>{t('damagedRecordHint')}</AlertDescription>
            </Alert>
          )}

          <div className="space-y-2.5">
            {jsonImportItems.map((item) => (
              <div key={item.key} className="rounded-lg border border-border bg-surface p-3.5">
                <div className="flex items-center justify-between text-sm">
                  <span className="font-medium">
                    {item.service}
                    {item.accountLabel && <span className="text-sm text-muted-foreground"> · {item.accountLabel}</span>}
                  </span>
                  <span className="text-sm text-muted-foreground">
                    {t(`backupStatus_${item.status}` as 'backupStatus_conflict')}
                  </span>
                </div>
                {(item.status === 'conflict' || item.status === 'backup_only') && (
                  <Select
                    value={jsonImportDecisions[item.key] ?? 'keep_local'}
                    onValueChange={(v) =>
                      setJsonImportDecisions((prev) => ({ ...prev, [item.key]: v as 'keep_local' | 'use_file' | 'merge' }))
                    }
                  >
                    <SelectTrigger className="mt-2 w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {item.status === 'conflict' && <SelectItem value="keep_local">{t('backupDecisionKeepLocal')}</SelectItem>}
                      <SelectItem value="use_file">{t('jsonDecisionUseFile')}</SelectItem>
                      {item.status === 'conflict' && <SelectItem value="merge">{t('backupDecisionMerge')}</SelectItem>}
                    </SelectContent>
                  </Select>
                )}
              </div>
            ))}
          </div>
          </div>

          <div className={DIALOG_ACTIONS}>
            <Button variant="outline" onClick={() => setJsonImportStep(null)}>
              {t('importPreviewCancelButton')}
            </Button>
            <Button onClick={handleJsonImportConfirm}>{t('backupImportConfirmButton')}</Button>
          </div>
        </DialogContent>
      </Dialog>

      <RecoveryTimelineDialog
        scope={timelineScope}
        onClose={() => setTimelineScope(null)}
        groups={groups}
        requireReverify={requireReverify}
        forceReverify={forceReverify}
        onChanged={async () => {
          await reload()
          void reloadRecentActivity()
        }}
      />

      <RecoveryBulkEditDialog
        targets={bulkEditTargets}
        onClose={() => setBulkEditTargets(null)}
        onApplied={async ({ batchId, changedCount }) => {
          await reload()
          toast.success(t('bulkEditDoneToast', { count: changedCount }), {
            action: { label: t('undoButton'), onClick: () => void handleBatchUndo(batchId) },
          })
          void reloadRecentActivity()
        }}
      />

      <RecoveryDuplicatesDialog
        open={dedupeOpen}
        onClose={() => setDedupeOpen(false)}
        groups={groups}
        onMerged={async ({ batchId, mergedCount, removedCodes }) => {
          await reload()
          toast.success(t('dedupeMergedToast', { merged: mergedCount, removed: removedCodes }), {
            action: { label: t('undoButton'), onClick: () => void handleBatchUndo(batchId) },
          })
          void reloadRecentActivity()
        }}
      />

      <UnlockDialog
        open={reverifyOpen}
        onOpenChange={(open) => {
          setReverifyOpen(open)
          if (!open) pendingUnlockActionRef.current = null
        }}
        onUnlocked={handleReverifySuccess}
      />
    </div>
  )
}
