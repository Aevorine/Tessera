import { memo, useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useVirtualizer } from '@tanstack/react-virtual'
import { toast } from 'sonner'
import {
  CheckCircle2,
  Eraser,
  FileCheck2,
  FileLock2,
  FileSearch,
  FolderInput,
  FolderSync,
  History,
  KeyRound,
  Loader2,
  ScanSearch,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Unlock,
  Upload,
  Wrench,
  XCircle,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import { usePassphrasePrompt } from '@/lib/usePassphrasePrompt'
import { VerifyResultsDialog, type VerifyRow } from '@/components/files/VerifyResultsDialog'
import { FileOpsDashboard } from '@/components/files/FileOpsDashboard'
import { ActionTile, TileStatus } from '@/components/files/ActionTile'
import { TopBar, type TopBarMenu, type TopBarNode } from '@/components/TopBar'
import { StatTile } from '@/components/StatTile'
import {
  FILE_OP_METRICS,
  formatFileOpMetric,
  loadFileOpMetrics,
  MAX_FILE_OP_RECORDS,
  saveFileOpMetrics,
  summarize,
  type FileOpKind,
  type FileOpMetricId,
  type FileOpRecord,
} from '@/lib/fileOpsStats'
import { Badge, PageHeader, PageSection, PageShell } from '@/components/ui/page'
import { newShareSession, shareParams, type ShareContext } from '@/lib/shareSession'
import { vaultApi } from '@/lib/vaultApi'
import { electronApi } from '@/lib/electronApi'
import { cn } from '@/lib/utils'
import { translateError } from '@/i18n/errors'
import type {
  ActivityLogEntry,
  EncryptionProfile,
  FileCipher,
  RemnantCategory,
  RemnantItem,
  VaultMethods,
} from '@/shared/ipcTypes'

// share_*：口令分享容器（fk_wrap_pw）。解密那一个也吃身份容器（口令被忽略），
// 所以一批里混着两种容器时整批走它即可。
type FileMethod = 'encrypt_file' | 'decrypt_file' | 'share_encrypt_file' | 'share_decrypt_file'

// 渲染进程没有 Node `path`（nodeIntegration: false），这里用最小手写路径工具，让默认保存路径落在源
// 文件旁（避免同文件冲突）并生成批量模式的逐文件输出路径。
function dirnameWithSeparator(fullPath: string): string {
  const idx = Math.max(fullPath.lastIndexOf('/'), fullPath.lastIndexOf('\\'))
  return idx === -1 ? '' : fullPath.slice(0, idx + 1)
}

function basename(fullPath: string): string {
  const idx = Math.max(fullPath.lastIndexOf('/'), fullPath.lastIndexOf('\\'))
  return idx === -1 ? fullPath : fullPath.slice(idx + 1)
}

function joinPath(dir: string, name: string): string {
  const sep = dir.includes('\\') ? '\\' : '/'
  return dir.endsWith(sep) ? `${dir}${name}` : `${dir}${sep}${name}`
}

function splitExt(name: string): [string, string] {
  const idx = name.lastIndexOf('.')
  return idx > 0 ? [name.slice(0, idx), name.slice(idx)] : [name, '']
}

function resolveUniqueOutputPaths(inputPaths: string[], outDir: string, suffix = ''): string[] {
  const used = new Set<string>()
  return inputPaths.map((inputPath) => {
    const preferredName = `${basename(inputPath)}${suffix}`
    const [base, ext] = splitExt(preferredName)
    let outputName = preferredName
    let number = 2
    while (used.has(outputName)) {
      outputName = `${base} (${number})${ext}`
      number++
    }
    used.add(outputName)
    return joinPath(outDir, outputName)
  })
}

interface BatchItem {
  input_path: string
  output_path: string
  cipher?: FileCipher
  post_quantum?: boolean
  passphrase?: string
  share_session?: string
}

/** 头部读到了、但元数据被口令锁着（口令分享容器，还没给口令）。 */
function isPassphraseLocked(header: { passphrase_protected?: boolean; metadata_locked?: boolean }): boolean {
  return Boolean(header.passphrase_protected && header.metadata_locked)
}

// 校验是整份读一遍、CPU 做 AEAD：两路并行就能吃满一块 SSD，再多只是抢磁盘。
const VERIFY_CONCURRENCY = 2

// 新容器可选的加密档，强者在前。把对称算法和 File Key 封装合成一个选择，避免出现"弱封装配强算法"这
// 种没人要的组合。AES-128-GCM 已移除：Grover 把 128 位密钥搜索减半到 64 位，是全应用唯一让量子对手
// 获益之处；已用它加密的文件仍可解密，见 crypto.RETIRED_FILE_CIPHERS。
const ENCRYPTION_PROFILES: {
  value: EncryptionProfile
  cipher: FileCipher
  postQuantum: boolean
}[] = [
  { value: 'pq-aes-256-gcm', cipher: 'aes-256-gcm', postQuantum: true },
  { value: 'aes-256-gcm', cipher: 'aes-256-gcm', postQuantum: false },
  { value: 'chacha20-poly1305', cipher: 'chacha20-poly1305', postQuantum: false },
]

// runBatch() 的每项一条。后端已并发处理批量，多项可同时 'running'；key 作为 vaultApi.call 的
// progressToken，让进度事件路由回对应行（见 backend_server.py 的 rpc_encrypt_file/rpc_decrypt_file
// 与batch_engine.submit_batch_task）。
interface QueueItemState {
  key: string
  fileName: string
  status: 'pending' | 'running' | 'done' | 'error'
  chunkDone: number
  chunkTotal: number
  errorMessage?: string
  // 见 ProgressEvent.phase：加解密跑完之后还有"安全删除原文件"那一段，
  // 它是独立的一条 0→100%。不标出来的话进度条会莫名其妙倒回去。
  phase?: string
}

// 后端在覆写删除原文件那一段带的 phase 值（见 backend_server.py 里
// `extra={"phase": "secure_delete"}`）。两边是靠这个字符串对上的，改一边就断。
const SECURE_DELETE_PHASE = 'secure_delete'

// runBatch 并发数，固定不随 CPU 数缩放：加解密受磁盘限制（见 container.py 模块说明）。8 而非 4 是实
// 测（600x32 KB，min-of-5）：1 线程 246 files/s，4 -> 412，8 -> 458，16 -> 428，故 8是真实最优。这
// 是跨文件并行，与 container.py 否决的单块并行不同：此处是 open/read/write/rename，CPython 会释放
// GIL。
const BATCH_CONCURRENCY = 8

// read_header 并发上限：纯 IPC 往返，顺序 await 是浪费（200 个 .ivault 扫描曾串行 200 次）。不设全
// 并发：后端是单进程 RPC 服务，灌入上千请求会让队列过长、无法取消，而收益十几路就到顶。
const HEADER_READ_CONCURRENCY = 16

/**
 * 按并发上限跑异步任务，保持输入顺序返回：调用方按下标对回路径，用完成顺序会对错头部（解密文件名串
 * 了）。
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length)
  let nextIndex = 0
  async function worker() {
    for (;;) {
      const i = nextIndex++
      if (i >= items.length) return
      out[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
  return out
}

// 虚拟列表的行距。队列行是定高的（一行文件名，不换行），所以不需要
// measureElement——省掉每行一次 ResizeObserver。
const QUEUE_ROW_HEIGHT = 36
const QUEUE_VIEWPORT_HEIGHT = 224 // 原来的 max-h-56，滚动行为保持不变
// 残留清单每行是可换行的完整路径，高度不定，交给 measureElement 量。
const REMNANT_ROW_ESTIMATE = 56
const REMNANT_VIEWPORT_HEIGHT = 256 // 原来的 max-h-64

// 列表为空时给虚拟化器的常量数组。不能写 `?? []`：每次渲染新数组会让 getItemKey 的 useCallback 失
// 效、测量缓存被丢弃（同 pcclean/CleanItemList.tsx 的 EMPTY_GROUPS）。
const EMPTY_QUEUE: QueueItemState[] = []
const EMPTY_REMNANTS: RemnantItem[] = []

// 顶栏统计磁贴的排列顺序：先"做了几次"，再"做了多少"，最后才是速度。跟菜单里
// 勾选的先后无关——否则取消一项再勾回来，磁贴就换了位置。
const METRIC_DISPLAY_ORDER: readonly FileOpMetricId[] = [
  'encrypted',
  'decrypted',
  'intact',
  'failed',
  'bytes',
  'throughput',
  'peak',
  'last',
]

// 「活动」面板显示与否（顶栏「记录」菜单里的开关）。只是个人显示偏好，存不下就
// 当作显示，不影响任何功能。
const ACTIVITY_VISIBLE_KEY = 'tessera.files.activityVisible'

function loadActivityVisible(): boolean {
  try {
    return localStorage.getItem(ACTIVITY_VISIBLE_KEY) !== '0'
  } catch {
    return true
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatMtime(mtime: number): string {
  return new Date(mtime * 1000).toLocaleString()
}

/**
 * 批量队列行。进度事件每秒几十条会换 `queueItems` 引用，memo 配合上游"只替换命中项"才能跳过其余行重
 * 渲。
 */
const QueueRow = memo(function QueueRow({
  item,
  offset,
  zebra,
  secureDeletingLabel,
  errorLabel,
}: {
  item: QueueItemState
  offset: number
  zebra: boolean
  secureDeletingLabel: string
  errorLabel: string
}) {
  return (
    <div
      className={cn(
        'absolute inset-x-0 top-0 flex h-8 items-center gap-2 rounded-md px-2 text-sm',
        zebra && 'bg-surface',
      )}
      style={{ transform: `translateY(${offset}px)` }}
    >
      {item.status === 'pending' && <span className="size-4 shrink-0 rounded-full border border-muted-foreground/40" aria-hidden="true" />}
      {item.status === 'running' && <Loader2 className="size-4 shrink-0 animate-spin text-primary" aria-hidden="true" />}
      {item.status === 'done' && <CheckCircle2 className="size-4 shrink-0 text-success" aria-hidden="true" />}
      {item.status === 'error' && <XCircle className="size-4 shrink-0 text-destructive" aria-hidden="true" />}
      <span className="min-w-0 flex-1 truncate">{item.fileName}</span>
      {/* 加解密跑完还有"安全删除原文件"那一段，它是独立的一条 0→100%。
          不说清楚的话用户会看到进度条走满又从头开始，而这一段恰恰是最不该
          让人以为出错了的一段——它在**不可逆地覆写**他的原文件。 */}
      {item.status === 'running' && item.phase === SECURE_DELETE_PHASE && (
        <span className="shrink-0 text-2xs text-muted-foreground">{secureDeletingLabel}</span>
      )}
      <span className="shrink-0 text-2xs text-muted-foreground tabular">
        {item.status === 'running' && item.chunkTotal > 0
          ? `${Math.round((item.chunkDone / item.chunkTotal) * 100)}%`
          : item.status === 'error'
            ? errorLabel
            : ''}
      </span>
    </div>
  )
})

/** 残留清单行。选中态用 `Set`，每行只关心自己的布尔值，勾一条只重渲一条。 */
const RemnantRow = memo(function RemnantRow({
  item,
  checked,
  disabled,
  onToggle,
  categoryLabel,
  matchedSuffix,
  offset,
  index,
  measureRef,
}: {
  item: RemnantItem
  checked: boolean
  disabled: boolean
  onToggle: (path: string, checked: boolean) => void
  categoryLabel: string
  matchedSuffix: string
  offset: number
  index: number
  measureRef: (node: HTMLElement | null) => void
}) {
  return (
    <div
      ref={measureRef}
      data-index={index}
      className={cn('absolute inset-x-0 top-0 flex items-start gap-2 rounded-md px-2 py-1', index % 2 === 0 && 'bg-surface')}
      style={{ transform: `translateY(${offset}px)` }}
    >
      <Checkbox
        id={`remnant-${item.path}`}
        checked={checked}
        onCheckedChange={(v) => onToggle(item.path, v === true)}
        disabled={disabled}
        className="mt-0.5"
      />
      <Label htmlFor={`remnant-${item.path}`} className="text-sm leading-snug font-normal break-all">
        <span className={item.matched ? 'font-medium' : ''}>{item.path}</span>
        <span className="text-muted-foreground">
          {' '}
          — {categoryLabel}，{formatSize(item.size)}，{formatMtime(item.mtime)}
          {item.matched ? matchedSuffix : ''}
        </span>
      </Label>
    </div>
  )
})

export function FilesPane({ isProfessional = false }: { isProfessional?: boolean }) {
  const { t } = useTranslation('files')
  const [busyLabel, setBusyLabel] = useState<string | null>(null)
  const [queueItems, setQueueItems] = useState<QueueItemState[] | null>(null)
  const [deleteSourceOnEncrypt, setDeleteSourceOnEncrypt] = useState(true)
  const [deleteSourceOnDecrypt, setDeleteSourceOnDecrypt] = useState(true)
  const [remnantItems, setRemnantItems] = useState<RemnantItem[] | null>(null)
  // 选中态用 Set 而非 `Record<string, boolean>`：后者每勾一条重建整个对象，几百条残留时整表重渲。
  const [remnantSelected, setRemnantSelected] = useState<ReadonlySet<string>>(() => new Set())
  // 后量子默认开启：每文件仅约 0.07 ms、1.6 KB（实测），不到 1%，没有让用户手动开启的速度理由。
  const [profileId, setProfileId] = useState<EncryptionProfile>('pq-aes-256-gcm')
  // 设置都在顶栏菜单里；安全删除开着时，顶栏触发器和磁贴底部摘要行常驻显示（不可逆操作不能藏起来），
  // 见 topBarMenus 与 ActionTile。口令分享：FK 只用口令封装，另一台 Tessera 凭口令即可打开。与后量子
  // 封装互斥（后端同时出现会报错），分享模式下后量子档退化为同一对称算法。
  const [shareMode, setShareMode] = useState(false)
  const profile = ENCRYPTION_PROFILES.find((p) => p.value === profileId) ?? ENCRYPTION_PROFILES[0]
  const cipher = profile.cipher
  const postQuantum = profile.postQuantum && !shareMode
  const passPrompt = usePassphrasePrompt()
  // 这一轮解密里用户给过的口令。一次解密流程会跨好几个对话框（批量预览、
  // 文件夹逐个预览），口令只问一次，流程走完（文件夹队列清空）就丢掉。
  const shareRef = useRef<ShareContext | null>(null)
  const [verifyRows, setVerifyRows] = useState<VerifyRow[] | null>(null)
  // 「加解密概览」：本次会话每次操作的耗时与大小（只在内存里），加上加密存储的历史。
  const [opRecords, setOpRecords] = useState<FileOpRecord[]>([])
  const [fileHistory, setFileHistory] = useState<ActivityLogEntry[]>([])
  const opSummary = useMemo(() => summarize(opRecords), [opRecords])
  // 顶栏左端显示哪几项统计，在「记录 ▸ 顶栏显示的数字」里挑；沿用旧存储键，以前的选择仍有效。
  const [metrics, setMetrics] = useState<FileOpMetricId[]>(loadFileOpMetrics)
  const [showActivity, setShowActivity] = useState(loadActivityVisible)

  function toggleMetric(id: FileOpMetricId) {
    setMetrics((current) => {
      const next = current.includes(id)
        ? current.filter((m) => m !== id)
        : FILE_OP_METRICS.filter((m) => m === id || current.includes(m))
      // 至少留一项：一项都不剩时顶栏左端整块消失，用户找不到"刚才那排数字去哪了"。
      if (next.length === 0) return current
      saveFileOpMetrics(next)
      return next
    })
  }

  function toggleActivity(next: boolean) {
    setShowActivity(next)
    try {
      localStorage.setItem(ACTIVITY_VISIBLE_KEY, next ? '1' : '0')
    } catch {
      // 记不住就只影响下次打开时的样子。
    }
  }

  // 拖放：整页"拖入中"按进出计数判定，因为 dragenter/dragleave 在子元素间移动时也成对触发，一次
  // dragleave 不等于真的拖出。
  const dragDepth = useRef(0)
  const activityRef = useRef<HTMLDivElement>(null)
  const [dragActive, setDragActive] = useState(false)
  const [dropTarget, setDropTarget] = useState<'encrypt' | 'decrypt' | null>(null)

  function resetDrag() {
    dragDepth.current = 0
    setDragActive(false)
    setDropTarget(null)
  }

  const refreshFileHistory = useCallback(async () => {
    try {
      const res = await vaultApi.call('activity_log_list', { limit: 300 })
      if (res.ok) setFileHistory(res.entries.filter((e) => e.module === 'files').slice(0, 60))
    } catch {
      // 历史只是附加信息，读不到就留空，不打扰用户。
    }
  }, [])

  useEffect(() => {
    void refreshFileHistory()
  }, [refreshFileHistory])

  // 离开文件页时，这一轮解密里给过的口令不能留到下一次：直接让后端丢掉这批。
  useEffect(
    () => () => {
      const share = shareRef.current
      shareRef.current = null
      if (share) vaultApi.call('share_session_end', { share_session: share.session }).catch(() => {})
    },
    [],
  )

  function addOpRecords(next: FileOpRecord[]) {
    if (next.length === 0) return
    setOpRecords((prev) => [...next.reverse(), ...prev].slice(0, MAX_FILE_OP_RECORDS))
  }

  /** 一批加解密跑完后记进概览：耗时是每一项的实测，大小向后端要（文件夹回 null）。 */
  async function recordBatch(method: FileMethod, items: BatchItem[], timings: ({ ms: number; ok: boolean } | undefined)[]) {
    const kind: FileOpKind = method === 'encrypt_file' || method === 'share_encrypt_file' ? 'encrypt' : 'decrypt'
    let sizes: Record<string, number | null> = {}
    try {
      const paths = items.flatMap((it) => [it.input_path, it.output_path])
      const res = await vaultApi.call('files_path_sizes', { paths })
      if (res.ok) sizes = res.sizes
    } catch {
      // 拿不到大小就只记耗时。
    }
    const now = Date.now()
    addOpRecords(
      items.flatMap((it, i) => {
        const timing = timings[i]
        if (!timing) return []
        // 加密：明文大小（源文件被安全删除时退而用容器大小）；解密：解出来的明文大小。
        const bytes = kind === 'encrypt' ? (sizes[it.input_path] ?? sizes[it.output_path] ?? null) : (sizes[it.output_path] ?? null)
        return [{ id: `${now}-${i}-${it.output_path}`, kind, name: basename(it.input_path), bytes, ms: timing.ms, ok: timing.ok, at: now }]
      }),
    )
    void refreshFileHistory()
  }
  // 只在单文件解密路径跟踪（批量不跟踪）：AI 摘要按钮针对这一个已解密的明文文件。
  const [lastDecryptedFile, setLastDecryptedFile] = useState<{ path: string; name: string } | null>(null)
  const [aiConfirmOpen, setAiConfirmOpen] = useState(false)
  const [aiSummary, setAiSummary] = useState<{ open: boolean; loading: boolean; text: string; truncated: boolean }>({
    open: false,
    loading: false,
    text: '',
    truncated: false,
  })
  // 一次解密多个文件时先填此预览而不是直接弹输出目录对话框，让用户看到 .ivault 头里的原文件名/大小/日
  // 期。
  const [decryptPreview, setDecryptPreview] = useState<{
    items: { path: string; name: string; size: number; mtime: number | null }[]
    headerFailures: { fileName: string; error: string }[]
    folderPaths: string[]
  } | null>(null)

  // 文件夹容器逐个走自己的 预览→提取 流程（decryptPaths/showNextFolderPreview），不同于多文件的
  // decryptPreview；queue 存同一次选择里还在排队的其余文件夹容器。
  const [folderDecryptQueue, setFolderDecryptQueue] = useState<string[]>([])
  const [folderPreview, setFolderPreview] = useState<{
    inputPath: string
    originalName: string
    entries: { name: string; size: number; is_dir: boolean }[]
  } | null>(null)
  // 「确认解密」运行期间，对话框不许走"关闭即丢弃"：handleConfirmFolderDecrypt 先 await 原生选目录对
  // 话框，期间 Radix Dialog 仍开着，原生窗口抢走焦点会被 DismissableLayer 当成点到外面，触发
  // decrypt_folder_discard 注销预览句柄，之后确认就报"预览已失效"，全程无其它错误。用 ref 不用
  // state：onOpenChange 回调需要读到此刻的值，而非闭包里的旧值。
  const folderConfirmInFlight = useRef(false)

  // 增量文件夹重加密：对比源文件夹与已加密容器并展示差异后再整体重加密。因为单 zip 流容器格式无法只改
  // 写变化的字节，所以是 diff 后全量重加密，见 container.diff_folder_against_container。
  const [reencryptSourceFolder, setReencryptSourceFolder] = useState<string | null>(null)
  const [reencryptContainerPath, setReencryptContainerPath] = useState<string | null>(null)
  const [reencryptDiff, setReencryptDiff] = useState<{
    original_name: string
    added: string[]
    removed: string[]
    modified: string[]
    unchanged_count: number
    empty_dirs_added: string[]
    empty_dirs_removed: string[]
  } | null>(null)
  const [reencryptBusy, setReencryptBusy] = useState(false)

  const PROFILE_TEXT: Record<EncryptionProfile, { label: string; algorithm: string; hint: string }> = {
    'pq-aes-256-gcm': {
      label: t('profileLabelPostQuantum'),
      algorithm: 'AES-256-GCM + ML-KEM-1024',
      hint: t('profileHintPostQuantum'),
    },
    'aes-256-gcm': { label: t('profileLabelClassic'), algorithm: 'AES-256-GCM', hint: t('profileHintClassic') },
    'chacha20-poly1305': {
      label: t('profileLabelChacha'),
      algorithm: 'ChaCha20-Poly1305',
      hint: t('profileHintChacha'),
    },
  }

  const algorithmSummary = shareMode
    ? `${cipher === 'chacha20-poly1305' ? 'ChaCha20-Poly1305' : 'AES-256-GCM'} + Argon2id`
    : PROFILE_TEXT[profileId].algorithm

  const REMNANT_CATEGORY_LABELS: Record<RemnantCategory, string> = {
    same_dir: t('remnantCategorySameDir'),
    wps_backup: t('remnantCategoryWpsBackup'),
    office_autorecover: t('remnantCategoryOfficeAutorecover'),
    same_name_disk: t('remnantCategorySameNameDisk'),
  }

  // 扫描源文件的明文残留副本（编辑器自动备份、~$ 属主文件等）：WPS 备份中心留着明文快照，加密就白做
  // 了。
  async function scanRemnants(sourcePaths: string[], announceWhenClean: boolean) {
    const res = await vaultApi.call('scan_remnants', { source_paths: sourcePaths })
    if (!res.ok) {
      toast.error(t('remnantScanFailedToast', { error: translateError(res.error, res.error_params) }))
      return
    }
    if (res.items.length === 0) {
      setRemnantItems(null)
      if (announceWhenClean) toast.success(t('remnantCleanToast'))
      return
    }
    setRemnantItems(res.items)
    // 只预选与刚加密文件明确相关的项。别处的同名副本只列出不预选：可能是用户自己的原件，一键粉碎不可恢
    // 复，必须手动勾选。不透明的备份缓存条目同样不预选。
    setRemnantSelected(
      new Set(
        res.items
          .filter((it) => it.matched && it.category !== 'same_name_disk')
          .map((it) => it.path),
      ),
    )
    const matchedCount = res.items.filter((it) => it.matched).length
    if (matchedCount > 0) {
      toast.warning(t('remnantFoundWarningToast', { count: matchedCount }))
    }
  }

  // 「安全删除原文件」失败后的重试入口：加密成功但原文件还在，用户以为明文已没了；失败多半是暂时的（
  // 文件夹在资源管理器中打开、被编辑器占用），应让用户一键重试而不必重新加密。
  async function retrySecureDelete(paths: string[]) {
    setBusyLabel(t('cleaningRemnantsLabel'))
    try {
      // allow_directories：此处删的可能是整个文件夹，而该 RPC 默认拒绝目录（见 ipcTypes）。这是用户已授权
      // 的"加密后安全删除"的重试，不是新的破坏性动作。
      const res = await vaultApi.call('secure_delete_paths', { paths, allow_directories: true })
      if (!res.ok) {
        toast.error(t('remnantCleanupFailedToast', { error: translateError(res.error, res.error_params) }))
        return
      }
      const failed = res.results.filter((r) => !r.ok)
      if (failed.length === 0) {
        toast.success(t('remnantCleanupSuccessToast', { count: res.results.length }))
      } else {
        toast.error(t('remnantCleanupPartialToast', { deleted: res.results.length - failed.length, failed: failed.length }), {
          description: failed
            .map((f) => `${basename(f.path)}：${translateError(f.error!, f.error_params)}`)
            .join('\n'),
        })
      }
    } catch (err) {
      toast.error(t('remnantCleanupFailedToast', {
        error: err instanceof Error ? err.message : String(err),
      }))
    } finally {
      setBusyLabel(null)
    }
  }

  async function handleSecureDeleteRemnants() {
    if (!remnantItems) return
    const paths = remnantItems.filter((it) => remnantSelected.has(it.path)).map((it) => it.path)
    if (paths.length === 0) {
      toast.info(t('noRemnantSelectedInfo'))
      return
    }
    setBusyLabel(t('cleaningRemnantsLabel'))
    try {
      const res = await vaultApi.call('secure_delete_paths', { paths })
      if (!res.ok) {
        toast.error(t('remnantCleanupFailedToast', { error: translateError(res.error, res.error_params) }))
        return
      }
      const failed = res.results.filter((r) => !r.ok)
      const deleted = new Set(res.results.filter((r) => r.ok).map((r) => r.path))
      const rest = remnantItems.filter((it) => !deleted.has(it.path))
      setRemnantItems(rest.length > 0 ? rest : null)
      if (failed.length === 0) {
        toast.success(t('remnantCleanupSuccessToast', { count: deleted.size }))
      } else {
        toast.error(t('remnantCleanupPartialToast', { deleted: deleted.size, failed: failed.length }), {
          description: failed
            .map((f) => `${basename(f.path)}：${translateError(f.error!, f.error_params)}`)
            .join('\n'),
        })
      }
    } finally {
      setBusyLabel(null)
    }
  }

  async function runBatch(
    method: FileMethod,
    items: BatchItem[],
    label: string,
    withDeleteSource: boolean,
    // 批量开始前就已知的失败（如 handleDecrypt 里预检 read_header 失败的文件），并入同一汇总，不让一个
    // 坏文件中止其余。
    preFailures: { fileName: string; error: string }[] = [],
  ) {
    setBusyLabel(label)
    const queue: QueueItemState[] = items.map((item, i) => ({
      key: `q${i}`,
      fileName: basename(item.input_path),
      status: 'pending',
      chunkDone: 0,
      chunkTotal: 0,
    }))
    setQueueItems(queue)

    // undeletedSource：这一项加解密成功了、但用户勾的"安全删除原文件"没做成，
    // 记下那个还躺在磁盘上的路径，好在最后给一个「重试删除」的入口。
    type BatchResult = { fileName: string; ok: boolean; error?: string; undeletedSource?: string }
    const results: BatchResult[] = preFailures.map((f) => ({
      fileName: f.fileName,
      ok: false,
      error: f.error,
    }))
    const itemResults: BatchResult[] = new Array(items.length)
    const timings: ({ ms: number; ok: boolean } | undefined)[] = new Array(items.length)

    // 整个批次共用一个订阅，所有并发项的进度事件都走这条通道，按 progressToken 路由到对应行（见
    // ipcTypes.ts 的 ProgressPayload.progressToken）。
    const unsubscribe = vaultApi.onProgress((payload) => {
      if (payload.method !== method || !payload.progressToken) return
      const token = payload.progressToken
      // 只替换命中项，其余保持原引用：用 `qs.map` 会让每个进度事件重建所有项并整表重渲（千文件批量时每秒
      // 几十条），这是批量加密界面卡顿的来源。同时挡掉值没变的更新：后端会在同一块上重复报同一个百分比。
      setQueueItems((qs) => {
        if (!qs) return qs
        const index = qs.findIndex((q) => q.key === token)
        if (index === -1) return qs
        const current = qs[index]
        if (
          current.chunkDone === payload.done &&
          current.chunkTotal === payload.total &&
          current.phase === payload.phase
        ) {
          return qs
        }
        const next = qs.slice()
        next[index] = { ...current, chunkDone: payload.done, chunkTotal: payload.total, phase: payload.phase }
        return next
      })
    })

    /** 只改一项的状态，同样保持其余项的引用不变。 */
    function patchQueueItem(key: string, patch: Partial<QueueItemState>) {
      setQueueItems((qs) => {
        if (!qs) return qs
        const index = qs.findIndex((q) => q.key === key)
        if (index === -1) return qs
        const next = qs.slice()
        next[index] = { ...qs[index], ...patch }
        return next
      })
    }

    let nextIndex = 0
    async function worker() {
      for (;;) {
        const i = nextIndex++
        if (i >= items.length) return
        const item = items[i]
        const key = queue[i].key
        patchQueueItem(key, { status: 'running' })

        const params: VaultMethods[FileMethod]['params'] = withDeleteSource ? { ...item, delete_source: true } : item
        const started = performance.now()
        const res = await vaultApi.call(method, params as never, key)
        timings[i] = { ms: performance.now() - started, ok: res.ok }
        // RPC 自身 ok 仍为 true（.ivault 确实写了），批量曾因此报成功，而用户要粉碎的明文文件夹其实没动。安
        // 全删除是该复选框存在的意义，没做到就是失败。
        const deleteFailed = res.ok && withDeleteSource && res.source_deleted === false
        const ok = res.ok && !deleteFailed
        const errorMessage = res.ok
          ? deleteFailed
            ? t('sourceNotDeletedError', {
                reason: res.delete_error
                  ? translateError(res.delete_error, res.delete_error_params)
                  : t('sourceNotDeletedUnknownReason'),
              })
            : undefined
          : translateError(res.error, res.error_params)
        itemResults[i] = {
          fileName: queue[i].fileName,
          ok,
          error: errorMessage,
          undeletedSource: deleteFailed ? item.input_path : undefined,
        }
        patchQueueItem(key, { status: ok ? 'done' : 'error', errorMessage })
      }
    }

    try {
      const workerCount = Math.min(BATCH_CONCURRENCY, items.length)
      await Promise.all(Array.from({ length: workerCount }, () => worker()))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      results.push(
        ...queue.map((item, index) => itemResults[index] ?? {
          fileName: item.fileName,
          ok: false,
          error: message,
        }),
      )
      toast.error(t('batchPartialCompleteToast', {
        label,
        success: results.filter((result) => result.ok).length,
        total: results.length,
        failed: results.filter((result) => !result.ok).length,
      }), { description: message })
      return results
    } finally {
      unsubscribe()
      setBusyLabel(null)
      setQueueItems(null)
    }

    results.push(...itemResults)
    void recordBatch(method, items, timings)

    const failed = results.filter((r) => !r.ok)
    const openFolderTarget = items.length === 1 ? items[0].output_path : dirnameWithSeparator(items[0].output_path)
    if (failed.length === 0) {
      toast.success(t('batchCompleteToast', { label, count: results.length }), {
        action: { label: t('openFolderAction'), onClick: () => electronApi.showItemInFolder(openFolderTarget) },
      })
    } else {
      // 「加密好了但原文件没删掉」不同于其它失败：只差最后的覆写删除，原因通常是暂时的（文件被占用），给
      // 重试按钮好过重新加密整个文件夹。
      const undeleted = failed.map((f) => f.undeletedSource).filter((p): p is string => Boolean(p))
      toast.error(
        t('batchPartialCompleteToast', { label, success: results.length - failed.length, total: results.length, failed: failed.length }),
        {
          description: failed.map((f) => `${f.fileName}：${f.error}`).join('\n'),
          ...(undeleted.length > 0
            ? { action: { label: t('retrySecureDeleteAction'), onClick: () => void retrySecureDelete(undeleted) } }
            : {}),
        },
      )
    }
    return results
  }

  async function handleEncrypt() {
    const inputPaths = await electronApi.openFiles({
      title: t('selectFilesToEncryptTitle'),
      properties: ['openFile', 'multiSelections'],
    })
    if (!inputPaths || inputPaths.length === 0) return
    await encryptPaths(inputPaths)
  }

  // Windows 原生选择器不能在一个对话框里同时选文件和文件夹，所以文件夹加密单独一个按钮，之后仍走同一
  // 个 encryptPaths()；后端靠 rpc_encrypt_file 的 is_folder 区分目录与文件。
  async function handleEncryptFolder() {
    const folderPath = await electronApi.openDirectory({ title: t('selectFolderToEncryptTitle') })
    if (!folderPath) return
    await encryptPaths([folderPath])
  }

  // 增量文件夹重加密第 1 步：选源文件夹和已加密的 .ivault，让后端 diff（逐文件 CRC-32，同大小的修改也
  // 能检出）。
  async function handleStartFolderReencrypt() {
    const folderPath = await electronApi.openDirectory({ title: t('reencryptSelectFolderTitle') })
    if (!folderPath) return
    const containerPaths = await electronApi.openFiles({
      title: t('reencryptSelectContainerTitle'),
      properties: ['openFile'],
      filters: [{ name: 'Tessera', extensions: ['ivault'] }],
    })
    if (!containerPaths || containerPaths.length === 0) return
    const containerPath = containerPaths[0]

    setReencryptSourceFolder(folderPath)
    setReencryptContainerPath(containerPath)
    setReencryptBusy(true)
    try {
      const res = await vaultApi.call('folder_container_diff', {
        source_folder: folderPath,
        container_path: containerPath,
      })
      if (!res.ok) {
        toast.error(t('reencryptDiffFailedToast'), { description: translateError(res.error, res.error_params) })
        setReencryptSourceFolder(null)
        setReencryptContainerPath(null)
        return
      }
      setReencryptDiff(res)
    } finally {
      setReencryptBusy(false)
    }
  }

  function handleCancelFolderReencrypt() {
    setReencryptDiff(null)
    setReencryptSourceFolder(null)
    setReencryptContainerPath(null)
  }

  // 第 2 步：用户确认差异后整体重加密，并安全替换原容器路径（崩溃安全性见
  // container.reencrypt_folder_container）。
  async function handleConfirmFolderReencrypt() {
    if (!reencryptSourceFolder || !reencryptContainerPath) return
    setReencryptBusy(true)
    try {
      const res = await vaultApi.call('folder_container_reencrypt', {
        source_folder: reencryptSourceFolder,
        container_path: reencryptContainerPath,
      })
      if (!res.ok) {
        toast.error(t('reencryptFailedToast'), { description: translateError(res.error, res.error_params) })
        return
      }
      toast.success(t('reencryptSuccessToast', { name: basename(reencryptContainerPath) }))
      handleCancelFolderReencrypt()
    } finally {
      setReencryptBusy(false)
    }
  }

  // 文件选择按钮（handleEncrypt）和拖放（handleDropFiles）共用，二者最终都是同一份输入路径列表。
  async function encryptPaths(inputPaths: string[]) {
    let share: ShareContext | null = null
    if (shareMode) {
      const passphrase = await passPrompt.ask('set', inputPaths.length)
      if (!passphrase) return
      share = { passphrase, session: newShareSession() }
    }
    try {
      await encryptPathsWith(inputPaths, share)
    } finally {
      if (share) endShareSession(share)
    }
    // Encryption (even with secure source deletion) doesn't touch the
    // plaintext copies editors keep elsewhere - surface them right away.
    await scanRemnants(inputPaths, false)
  }

  function endShareSession(share: ShareContext) {
    vaultApi.call('share_session_end', { share_session: share.session }).catch(() => {})
  }

  /** 结束这一轮解密里的口令批次（没有就什么都不做）。 */
  function endDecryptShare() {
    const share = shareRef.current
    shareRef.current = null
    if (share) endShareSession(share)
  }

  async function encryptPathsWith(inputPaths: string[], share: ShareContext | null) {
    const method: FileMethod = share ? 'share_encrypt_file' : 'encrypt_file'
    const extra = share ? shareParams(share) : { post_quantum: postQuantum }
    if (inputPaths.length === 1) {
      const inputPath = inputPaths[0]
      const fileName = basename(inputPath)
      const outputPath = await electronApi.saveFile({
        title: t('saveEncryptedAsTitle'),
        // 默认放在源文件旁，名字总带 ".ivault"，保证保存对话框的默认值不会落回源文件自身路径。
        defaultPath: `${dirnameWithSeparator(inputPath)}${fileName}.ivault`,
      })
      if (!outputPath) return
      await runBatch(
        method,
        [{ input_path: inputPath, output_path: outputPath, cipher, ...extra }],
        t('encryptLabel'),
        deleteSourceOnEncrypt,
      )
    } else {
      const outDir = await electronApi.openDirectory({ title: t('selectEncryptOutputDirTitle') })
      if (!outDir) return
      const outputPaths = resolveUniqueOutputPaths(inputPaths, outDir, '.ivault')
      const items = inputPaths.map((p, index) => ({
        input_path: p,
        output_path: outputPaths[index],
        cipher,
        ...extra,
      }))
      await runBatch(method, items, t('encryptLabel'), deleteSourceOnEncrypt)
    }
  }

  /**
   * 用口令解开一批口令容器的头部。整批口令都不对则留在对话框重输；部分不对记为失败，其余照常；取消返
   * 回 null。
   */
  async function unlockSealedHeaders(paths: string[]) {
    let error: string | undefined
    for (;;) {
      const passphrase = await passPrompt.ask('enter', paths.length, error)
      if (!passphrase) return null
      const share = { passphrase, session: newShareSession() }
      let res: VaultMethods['share_read_headers']['result']
      try {
        res = await vaultApi.call('share_read_headers', { paths, passphrase, share_session: share.session })
      } catch (err) {
        // 后端超时 / 重启：口令批次作废，留在对话框里让用户重试或取消。
        endShareSession(share)
        error = err instanceof Error ? err.message : String(err)
        continue
      }
      if (!res.ok) {
        endShareSession(share)
        error = translateError(res.error, res.error_params)
        continue
      }
      if (res.results.every((r) => !r.ok && r.error === 'container.wrong_passphrase')) {
        endShareSession(share)
        error = translateError('container.wrong_passphrase')
        continue
      }
      return { share, results: res.results }
    }
  }

  async function handleDecrypt() {
    const inputPaths = await electronApi.openFiles({
      title: t('selectFilesToDecryptTitle'),
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Ideal1 Vault', extensions: ['ivault'] },
        { name: t('allFilesFilter'), extensions: ['*'] },
      ],
    })
    if (!inputPaths || inputPaths.length === 0) return
    await decryptPaths(inputPaths)
  }

  // 「解密文件夹」按钮与加密侧「加密整个文件夹」对称：功能上与 handleDecrypt 同路（decryptPaths 按头
  // 部 kind 分流），但只有一个按钮会让用户以为解密不支持文件夹。差别是：从这里选进普通文件容器会明确
  // 提示"请用『解密文件』"，而不是默默解开。
  async function handleDecryptFolder() {
    const inputPaths = await electronApi.openFiles({
      title: t('selectFolderContainerToDecryptTitle'),
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Ideal1 Vault', extensions: ['ivault'] },
        { name: t('allFilesFilter'), extensions: ['*'] },
      ],
    })
    if (!inputPaths || inputPaths.length === 0) return

    // 并发但**有上限**：裸 Promise.all 在这里等于"选多少个就同时发多少个 RPC"，
    // 多选上千个 .ivault 会一次性把后端的请求队列灌满。
    const kinds = await mapWithConcurrency(inputPaths, HEADER_READ_CONCURRENCY, async (path) => {
      const res = await vaultApi.call('read_header', { input_path: path })
      if (!res.ok) return { path, kind: null }
      // 口令容器在给口令之前看不到 kind，交给 decryptPaths 解开后再分流。
      return { path, kind: isPassphraseLocked(res.header) ? 'locked' : (res.header.kind ?? 'file') }
    })
    const fileKind = kinds.filter((k) => k.kind === 'file').map((k) => basename(k.path))
    if (fileKind.length > 0) {
      toast.error(t('pickedFileNotFolderToast', { count: fileKind.length }), {
        description: fileKind.join('\n'),
      })
    }
    const folders = kinds.filter((k) => k.kind === 'folder' || k.kind === 'locked').map((k) => k.path)
    if (folders.length === 0) return
    await decryptPaths(folders)
  }

  // 只校验、不解密落盘：逐块认证 + 整体 sha256，明文只在内存里过一遍。
  // 口令容器第一轮会回 passphrase_required，攒齐之后只问一次口令再补跑。
  async function handleVerify() {
    const inputPaths = await electronApi.openFiles({
      title: t('verifySelectTitle'),
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Ideal1 Vault', extensions: ['ivault'] },
        { name: t('allFilesFilter'), extensions: ['*'] },
      ],
    })
    if (!inputPaths || inputPaths.length === 0) return
    const rows = await verifyPaths(inputPaths)
    setVerifyRows(rows)
    const now = Date.now()
    addOpRecords(
      rows.flatMap((row, i) =>
        row.result
          ? [{
              id: `${now}-v${i}-${row.path}`,
              kind: 'verify' as const,
              name: row.result.original_filename ?? row.name,
              bytes: row.result.bytes_checked,
              ms: row.result.elapsed_s * 1000,
              ok: row.result.intact,
              at: now,
            }]
          : [],
      ),
    )
  }

  async function verifyPaths(inputPaths: string[]): Promise<VerifyRow[]> {
    const rows: VerifyRow[] = inputPaths.map((p) => ({ path: p, name: basename(p) }))
    const keys = inputPaths.map((_, i) => `v${i}`)
    setBusyLabel(t('verifyLabel'))
    setQueueItems(
      inputPaths.map((p, i) => ({ key: keys[i], fileName: basename(p), status: 'pending', chunkDone: 0, chunkTotal: 0 })),
    )
    const patch = (key: string, next: Partial<QueueItemState>) =>
      setQueueItems((qs) => {
        if (!qs) return qs
        const at = qs.findIndex((q) => q.key === key)
        if (at === -1) return qs
        const copy = qs.slice()
        copy[at] = { ...qs[at], ...next }
        return copy
      })
    const unsubscribe = vaultApi.onProgress((payload) => {
      if (payload.method !== 'verify_container' || !payload.progressToken) return
      patch(payload.progressToken, { chunkDone: payload.done, chunkTotal: payload.total })
    })
    let share: ShareContext | null = null
    const needsPassphrase = new Set<number>()

    async function verifyOne(index: number) {
      const key = keys[index]
      patch(key, { status: 'running' })
      try {
        const res = await vaultApi.call(
          'verify_container',
          { input_path: inputPaths[index], ...shareParams(share) },
          key,
        )
        if (res.ok) {
          rows[index] = { ...rows[index], result: res, error: undefined }
          needsPassphrase.delete(index)
          patch(key, { status: res.intact ? 'done' : 'error' })
          return
        }
        if (res.error === 'container.passphrase_required' && !share) needsPassphrase.add(index)
        rows[index] = { ...rows[index], error: translateError(res.error, res.error_params) }
      } catch (err) {
        rows[index] = { ...rows[index], error: err instanceof Error ? err.message : String(err) }
      }
      patch(key, { status: 'error' })
    }

    try {
      await mapWithConcurrency(
        inputPaths.map((_, i) => i),
        VERIFY_CONCURRENCY,
        verifyOne,
      )
      let pending = [...needsPassphrase]
      let promptError: string | undefined
      while (pending.length > 0) {
        const passphrase = await passPrompt.ask('enter', pending.length, promptError)
        if (!passphrase) break
        if (share) endShareSession(share)
        share = { passphrase, session: newShareSession() }
        await mapWithConcurrency(pending, VERIFY_CONCURRENCY, verifyOne)
        const wrong = pending.filter((i) => !rows[i].result)
        if (wrong.length < pending.length) break
        promptError = translateError('container.wrong_passphrase')
        pending = wrong
      }
    } finally {
      unsubscribe()
      setQueueItems(null)
      setBusyLabel(null)
      if (share) endShareSession(share)
    }
    return rows
  }

  // Shared by the file-picker button (handleDecrypt) and drag-and-drop
  // (handleDropFiles).
  async function decryptPaths(inputPaths: string[]) {
    endDecryptShare()
    // 提示口令之前先读全部头部（沿用旧 gui.py 顺序）。检查失败的文件（非有效容器、选错等）记为已知失
    // 败，不中止整批。
    const originalNames: Record<string, string> = {}
    const headerSizes: Record<string, number> = {}
    const headerMtimes: Record<string, number | null> = {}
    const headerKinds: Record<string, 'file' | 'folder'> = {}
    const headerFailures: { fileName: string; error: string }[] = []
    // 并发读，但按输入顺序消费结果：headerFailures 和 validPaths 的顺序要与用户在选择框里看到的一致。
    const headers = await mapWithConcurrency(inputPaths, HEADER_READ_CONCURRENCY, (p) =>
      vaultApi.call('read_header', { input_path: p }),
    )
    // 口令分享容器：身份密钥读不出它的元数据，问一次口令，整批一起解开头部。
    const sealedPaths = inputPaths.filter((_, index) => {
      const res = headers[index]
      return res.ok && isPassphraseLocked(res.header)
    })
    if (sealedPaths.length > 0) {
      const unlocked = await unlockSealedHeaders(sealedPaths)
      sealedPaths.forEach((p, sealedIndex) => {
        const index = inputPaths.indexOf(p)
        if (!unlocked) {
          headers[index] = { ok: false, error: 'container.passphrase_required' }
          return
        }
        const r = unlocked.results[sealedIndex]
        headers[index] = r.ok
          ? { ok: true, header: r.header }
          : { ok: false, error: r.error, error_params: r.error_params }
      })
      if (unlocked) shareRef.current = unlocked.share
    }
    inputPaths.forEach((p, index) => {
      const res = headers[index]
      if (!res.ok) {
        headerFailures.push({ fileName: basename(p), error: translateError(res.error, res.error_params) })
      } else {
        originalNames[p] = res.header.original_filename
        headerSizes[p] = res.header.plaintext_size
        headerMtimes[p] = res.header.container_mtime ?? null
        headerKinds[p] = res.header.kind ?? 'file'
      }
    })

    const validPaths = inputPaths.filter((p) => p in originalNames)
    if (validPaths.length === 0) {
      endDecryptShare()
      toast.error(t('decryptFailedNoValidFilesToast', { count: headerFailures.length }), {
        description: headerFailures.map((f) => `${f.fileName}：${f.error}`).join('\n'),
      })
      return
    }

    // 文件夹容器不能走下面的文件解密流程（需要 预览→选目标文件夹，而非单个输出路径，见 container.py 模
    // 块说明），拆出来进自己的队列逐个处理。
    const fileKindPaths = validPaths.filter((p) => headerKinds[p] === 'file')
    const folderKindPaths = validPaths.filter((p) => headerKinds[p] === 'folder')

    // 两个流程保持串行：文件夹预览会解密到明文临时 ZIP 并持有模态框，与文件保存对话框同时出现会互相争
    // 抢、清理取消更难。文件容器先走批量预览，结束后才开始文件夹队列。空队列也要走一遍：
    // showNextFolderPreview 在队列清空时收尾这轮口令批次。
    const startFolderQueue = () => {
      void showNextFolderPreview(folderKindPaths)
    }

    // headerFailures 只通过文件类流程汇报；若有效选择全是文件夹类就没有地方挂靠，直接在这里提示，别静默
    // 丢弃。
    if (fileKindPaths.length === 0) {
      if (headerFailures.length > 0) {
        toast.error(t('decryptFailedNoValidFilesToast', { count: headerFailures.length }), {
          description: headerFailures.map((f) => `${f.fileName}：${f.error}`).join('\n'),
        })
      }
      startFolderQueue()
      return
    }

    if (fileKindPaths.length === 1) {
      const inputPath = fileKindPaths[0]
      const outputPath = await electronApi.saveFile({
        title: t('saveDecryptedAsTitle'),
        // 默认放在 .ivault 旁、用记录的原文件名：可能与残留原文件冲突（走正常"替换？"提示），但不会与
        //  .ivault 自身冲突；backend_server.py 也会硬性拒绝同路径加解密作为兜底。
        defaultPath: `${dirnameWithSeparator(inputPath)}${originalNames[inputPath]}`,
      })
      if (!outputPath) {
        startFolderQueue()
        return
      }
      setLastDecryptedFile(null)
      const share = shareRef.current
      const results = await runBatch(
        share ? 'share_decrypt_file' : 'decrypt_file',
        [{ input_path: inputPath, output_path: outputPath, ...shareParams(share) }],
        t('decryptLabel'),
        deleteSourceOnDecrypt,
        headerFailures,
      )
      // 解密确实在 outputPath 产出明文后才提供 AI 摘要按钮；runBatch 最后一个结果对应本项（headerFailures
      // 排在它前面）。
      if (results[results.length - 1]?.ok) {
        setLastDecryptedFile({ path: outputPath, name: basename(outputPath) })
      }
      startFolderQueue()
    } else {
      setDecryptPreview({
        items: fileKindPaths.map((p) => ({
          path: p,
          name: originalNames[p],
          size: headerSizes[p],
          mtime: headerMtimes[p],
        })),
        headerFailures,
        folderPaths: folderKindPaths,
      })
    }
  }

  async function handleConfirmDecryptBatch() {
    if (!decryptPreview) return
    const { items, headerFailures, folderPaths } = decryptPreview
    setDecryptPreview(null)
    const outDir = await electronApi.openDirectory({ title: t('selectDecryptOutputDirTitle') })
    if (!outDir) {
      await showNextFolderPreview(folderPaths)
      return
    }
    const outputPaths = resolveUniqueOutputPaths(items.map((it) => it.path), outDir)
    const share = shareRef.current
    const batchItems = items.map((it, index) => ({
      input_path: it.path,
      output_path: outputPaths[index],
      ...shareParams(share),
    }))
    await runBatch(
      share ? 'share_decrypt_file' : 'decrypt_file',
      batchItems,
      t('decryptLabel'),
      deleteSourceOnDecrypt,
      headerFailures,
    )
    await showNextFolderPreview(folderPaths)
  }

  function handleCancelDecryptBatch() {
    const folderPaths = decryptPreview?.folderPaths ?? []
    setDecryptPreview(null)
    void showNextFolderPreview(folderPaths)
  }

  // 文件夹解密：预览 → 选目标 → 提取。一次一个容器（见 decryptPaths），确认或取消后再处理队列里下一
  // 个。
  async function showNextFolderPreview(queue: string[]) {
    if (queue.length === 0) {
      setFolderDecryptQueue([])
      endDecryptShare()
      return
    }
    const [next, ...rest] = queue
    setFolderDecryptQueue(rest)
    const share = shareRef.current
    let res: VaultMethods['decrypt_folder_preview']['result']
    try {
      res = share
        ? await vaultApi.call('share_decrypt_folder_preview', {
            input_path: next,
            passphrase: share.passphrase,
            share_session: share.session,
          })
        : await vaultApi.call('decrypt_folder_preview', { input_path: next })
    } catch (err) {
      // 这一个没预览成，队列里后面的照样处理（空队列时顺带收掉口令批次）。
      toast.error(t('decryptFailedToast'), { description: err instanceof Error ? err.message : String(err) })
      await showNextFolderPreview(rest)
      return
    }
    if (!res.ok) {
      toast.error(t('decryptFailedToast'), { description: translateError(res.error, res.error_params) })
      await showNextFolderPreview(rest)
      return
    }
    setFolderPreview({
      inputPath: next,
      originalName: res.original_name,
      entries: res.entries,
    })
  }

  async function handleConfirmFolderDecrypt() {
    if (!folderPreview || folderConfirmInFlight.current) return
    folderConfirmInFlight.current = true
    // 进度订阅在 finally 里退订，所以它必须在 try 外面声明。
    let unsubscribe: (() => void) | null = null
    try {
      const parentDir = await electronApi.openDirectory({ title: t('selectFolderDecryptOutputDirTitle') })
      if (!parentDir) return // leave the preview open - user can still pick a destination or cancel
      const destination = joinPath(parentDir, folderPreview.originalName)

      // 走与批量加解密同一套进度界面（队列行 + 进度条）。只 setBusyLabel 而不 setQueueItems 的话，进度浮
      // 层（条件 `showProgress && queueItems`）不渲染，大文件夹解密时屏幕上什么都没有，且对话框被
      // in-flight锁焊死，像整个应用卡住。
      const progressKey = 'folder-decrypt'
      setBusyLabel(t('decryptLabel'))
      setQueueItems([{
        key: progressKey,
        fileName: folderPreview.originalName,
        status: 'running',
        chunkDone: 0,
        chunkTotal: 0,
      }])
      const share = shareRef.current
      const confirmMethod = share ? 'share_decrypt_folder_confirm' : 'decrypt_folder_confirm'
      unsubscribe = vaultApi.onProgress((payload) => {
        if (payload.method !== confirmMethod) return
        setQueueItems((qs) =>
          qs
            ? qs.map((q) =>
                q.key === progressKey
                  ? { ...q, chunkDone: payload.done, chunkTotal: payload.total, phase: payload.phase }
                  : q,
              )
            : qs,
        )
      })

      const confirmParams = {
        input_path: folderPreview.inputPath,
        output_dir: destination,
        delete_source: deleteSourceOnDecrypt,
      }
      const res = share
        ? await vaultApi.call('share_decrypt_folder_confirm', {
            ...confirmParams,
            passphrase: share.passphrase,
            share_session: share.session,
          })
        : await vaultApi.call('decrypt_folder_confirm', confirmParams)
      if (res.ok) {
        // Same rule as runBatch: the extraction succeeding does not mean the
        // ".ivault the user ticked to shred" is gone. Say which one happened.
        if (deleteSourceOnDecrypt && res.source_deleted === false) {
          const undeleted = folderPreview.inputPath
          toast.error(
            t('sourceNotDeletedError', {
              reason: res.delete_error
                ? translateError(res.delete_error, res.delete_error_params)
                : t('sourceNotDeletedUnknownReason'),
            }),
            // 解出来的内容是好的，没删掉的是那个 .ivault。给重试删除，
            // 而不是"打开文件夹"——后者对"我勾了删除但它还在"毫无帮助。
            { action: { label: t('retrySecureDeleteAction'), onClick: () => void retrySecureDelete([undeleted]) } },
          )
        } else {
          toast.success(t('batchCompleteToast', { label: t('decryptLabel'), count: 1 }), {
            action: { label: t('openFolderAction'), onClick: () => electronApi.showItemInFolder(destination) },
          })
        }
        const remaining = folderDecryptQueue
        setFolderPreview(null)
        await showNextFolderPreview(remaining)
        return
      }
      // 失败时保留预览，让"换个目标目录再点确认"直接可行：清单是免费拿到的，重试不需要前置状态；最常见的
      // 失败是"目标目录已存在"，关掉对话框等于逼用户重选加密文件。
      toast.error(t('decryptFailedToast'), { description: translateError(res.error, res.error_params) })
    } catch (err) {
      // 必须有这个 catch：`vaultApi.call` 会抛（后端 error 信封、桥接层静默超时都走 reject），否则异常成
      // 为无人处理的rejection，`setFolderPreview(null)` 永远执行不到，对话框挂着关不掉。现在提示原因，
      // in-flight 锁在 finally 释放，预览保留供重试。
      toast.error(t('decryptFailedToast'), {
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      unsubscribe?.()
      setQueueItems(null)
      setBusyLabel(null)
      folderConfirmInFlight.current = false
    }
  }

  async function handleCancelFolderDecrypt() {
    // 确认流程进行中不许丢弃：原生选目录窗口抢焦点会被 Radix 当成点到对话框外，见
    // folderConfirmInFlight。
    if (!folderPreview || folderConfirmInFlight.current) return
    // 先关对话框，再做别的。decrypt_folder_discard 如今是纯空操作但仍可能抛（后端崩溃重启、静默超时、进
    // 程退出），关闭是纯前端状态，不该依赖后端往返，也不能因它失败而走不到。
    const remaining = folderDecryptQueue
    setFolderPreview(null)
    await showNextFolderPreview(remaining)
  }

  // 拖入文件按扩展名自动分流：.ivault 解密，其余加密；混合拖入直接拒绝，不拆成两个并发的保存位置提
  // 示。
  async function handleDropFiles(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    if (showProgress) return
    const paths = Array.from(event.dataTransfer.files).map((file) => electronApi.getPathForFile(file))
    if (paths.length === 0) return
    const ivaultPaths = paths.filter((p) => /\.ivault$/i.test(p))
    const otherPaths = paths.filter((p) => !/\.ivault$/i.test(p))
    if (ivaultPaths.length > 0 && otherPaths.length > 0) {
      toast.error(t('dropMixedTypesToast'))
      return
    }
    if (ivaultPaths.length > 0) {
      await decryptPaths(ivaultPaths)
    } else {
      await encryptPaths(otherPaths)
    }
  }

  // 拖到某块磁贴上就按该磁贴的动作做，不再按扩展名猜；只拦明显拖错（.ivault 拖到加密、普通文件拖到解
  // 密）并提示，不替用户改成另一个动作。
  async function handleTileDrop(kind: 'encrypt' | 'decrypt', event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    resetDrag()
    if (showProgress) return
    const paths = Array.from(event.dataTransfer.files).map((file) => electronApi.getPathForFile(file))
    if (paths.length === 0) return
    const ivaultCount = paths.filter((p) => /\.ivault$/i.test(p)).length
    if (kind === 'encrypt') {
      if (ivaultCount > 0) {
        toast.error(t('dropIvaultOnEncryptToast'))
        return
      }
      await encryptPaths(paths)
    } else {
      if (ivaultCount !== paths.length) {
        toast.error(t('dropPlainOnDecryptToast'))
        return
      }
      await decryptPaths(paths)
    }
  }

  async function handleAiSummarizeConfirmed() {
    if (!lastDecryptedFile) return
    setAiConfirmOpen(false)
    setAiSummary({ open: true, loading: true, text: '', truncated: false })
    const res = await vaultApi.call('ai_summarize_text_file', { path: lastDecryptedFile.path })
    if (!res.ok) {
      setAiSummary({ open: false, loading: false, text: '', truncated: false })
      if (res.error === 'ai.file_not_text') {
        toast.error(t('aiNotTextFileToast'))
      } else {
        toast.error(t('aiSummaryFailedToast'), { description: translateError(res.error, res.error_params) })
      }
      return
    }
    setAiSummary({ open: true, loading: false, text: res.summary, truncated: res.truncated })
  }

  // 独立扫描：选 .ivault，从头部还原原文件名，按原文件当作源来扫描；原文件被安全删除后也可用。
  async function handleScanRemnants() {
    const ivaultPaths = await electronApi.openFiles({
      title: t('selectFilesToScanTitle'),
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Ideal1 Vault', extensions: ['ivault'] },
        { name: t('allFilesFilter'), extensions: ['*'] },
      ],
    })
    if (!ivaultPaths || ivaultPaths.length === 0) return

    // 读头部并发（上限 HEADER_READ_CONCURRENCY）并走批量同一套队列面板显示进度；该面板已虚拟化，千行不
    // 卡。
    const sourcePaths: string[] = []
    const failures: string[] = []
    setBusyLabel(t('scanRemnantsButton'))
    setQueueItems(
      ivaultPaths.map((p, i) => ({
        key: `h${i}`,
        fileName: basename(p),
        status: 'pending' as const,
        chunkDone: 0,
        chunkTotal: 0,
      })),
    )
    try {
      const headers = await mapWithConcurrency(ivaultPaths, HEADER_READ_CONCURRENCY, async (p, index) => {
        const key = `h${index}`
        setQueueItems((qs) => {
          if (!qs) return qs
          const at = qs.findIndex((q) => q.key === key)
          if (at === -1) return qs
          const next = qs.slice()
          next[at] = { ...qs[at], status: 'running' }
          return next
        })
        const res = await vaultApi.call('read_header', { input_path: p })
        setQueueItems((qs) => {
          if (!qs) return qs
          const at = qs.findIndex((q) => q.key === key)
          if (at === -1) return qs
          const next = qs.slice()
          next[at] = { ...qs[at], status: res.ok ? 'done' : 'error' }
          return next
        })
        return res
      })
      // 结果按输入顺序消费，报错列表的顺序才跟用户选文件的顺序对得上。
      ivaultPaths.forEach((p, index) => {
        const res = headers[index]
        if (res.ok && isPassphraseLocked(res.header)) {
          failures.push(`${basename(p)}：${translateError('container.passphrase_required')}`)
        } else if (res.ok) {
          sourcePaths.push(`${dirnameWithSeparator(p)}${res.header.original_filename}`)
        } else {
          failures.push(`${basename(p)}：${translateError(res.error, res.error_params)}`)
        }
      })
    } finally {
      setQueueItems(null)
      setBusyLabel(null)
    }
    if (failures.length > 0) {
      toast.error(t('filesUnreadableToast', { count: failures.length }), { description: failures.join('\n') })
    }
    if (sourcePaths.length > 0) {
      await scanRemnants(sourcePaths, true)
    }
  }

  const showProgress = busyLabel !== null
  const selectedCount = remnantItems ? remnantItems.filter((it) => remnantSelected.has(it.path)).length : 0
  const queueDoneCount = queueItems ? queueItems.filter((q) => q.status === 'done' || q.status === 'error').length : 0

  // 两张长列表的虚拟化：批量千文件时队列面板曾真实铺出千个 DOM 行（框里最多看见七行），残留清单同理。
  // 虚拟化器必须无条件调用（Hook 规则），列表为空时 count 为 0。
  const queueScrollRef = useRef<HTMLDivElement>(null)
  const queueRows = queueItems ?? EMPTY_QUEUE
  const queueVirtualizer = useVirtualizer({
    count: queueRows.length,
    getScrollElement: () => queueScrollRef.current,
    // 队列行定高：一行文件名，truncate 不换行。定高就不需要 measureElement，
    // 省掉每行一个 ResizeObserver——而进度事件正是高频的那一类更新。
    estimateSize: () => QUEUE_ROW_HEIGHT,
    overscan: 8,
    // 按队列项自己的 key（runBatch 分配的 progressToken）记，不按下标：按下标缓存在列表重排后会记到别人
    // 身上（见 tests/clipboardVirtualRows.test.mjs）。
    getItemKey: useCallback((index: number) => queueRows[index]?.key ?? index, [queueRows]),
  })

  const remnantScrollRef = useRef<HTMLDivElement>(null)
  const remnantRows = remnantItems ?? EMPTY_REMNANTS
  const remnantVirtualizer = useVirtualizer({
    count: remnantRows.length,
    getScrollElement: () => remnantScrollRef.current,
    // 残留行是完整路径 + break-all，会换行，高度不定 → 交给 measureElement 量。
    estimateSize: () => REMNANT_ROW_ESTIMATE,
    overscan: 8,
    getItemKey: useCallback((index: number) => remnantRows[index]?.path ?? index, [remnantRows]),
  })

  /** 勾选一条残留。引用稳定，行组件的 memo 才拦得住。 */
  const toggleRemnant = useCallback((path: string, checked: boolean) => {
    setRemnantSelected((prev) => {
      if (prev.has(path) === checked) return prev
      const next = new Set(prev)
      if (checked) next.add(path)
      else next.delete(path)
      return next
    })
  }, [])

  // 行组件收到的是**字符串**而不是 t 函数：字符串按值比较，memo 才不会因为
  // 每次渲染拿到一个新的 t 引用而全线失效。
  const queueSecureDeletingLabel = t('queueItemSecureDeletingLabel')
  const queueErrorLabel = t('queueItemErrorLabel')
  const remnantMatchedSuffix = t('remnantMatchedSuffix')

  // 顶栏一行化：每类设置是顶栏一个菜单，当前值直接写在触发器上，不展开也知道点下去的效果。行为不变：
  // 加解密进行中全部禁用（showProgress），两个安全删除仍默认打开；开着时触发器用强调色，因为是不可逆
  // 动作，即使是默认值也要提醒。
  const encryptOptionValue = [shareMode && t('shareModeLabel'), deleteSourceOnEncrypt && t('valueSecureDelete')]
    .filter(Boolean)
    .join(' · ')

  const topBarMenus: TopBarMenu[] = [
    {
      // 算法只对"这次新建的加密"有意义（写进容器头部，解密时自己读回来），
      // 所以解密那一侧没有任何算法选择——选错的唯一结果是解不开。
      id: 'algorithm',
      label: t('menuAlgorithm'),
      icon: ShieldCheck,
      value: PROFILE_TEXT[profileId].label,
      // 只有离开默认的抗量子档才算"非默认"：触发器变色，并出现一键回默认的 ×。
      active: profileId !== ENCRYPTION_PROFILES[0].value,
      onClear: () => setProfileId(ENCRYPTION_PROFILES[0].value),
      contentClassName: 'min-w-72',
      items: [
        { id: 'algorithm-label', type: 'label', label: t('cipherLabel') },
        ...ENCRYPTION_PROFILES.map(
          (opt): TopBarNode => ({
            id: `algorithm-${opt.value}`,
            type: 'item',
            label: PROFILE_TEXT[opt.value].label,
            // 算法全名写在每一项下面，不只放在悬浮提示里：这是用户唯一能核对
            // "我的文件到底是用什么加密的"的地方。
            description: PROFILE_TEXT[opt.value].algorithm,
            selected: profileId === opt.value,
            disabled: showProgress,
            onSelect: () => setProfileId(opt.value),
          }),
        ),
        { id: 'algorithm-sep', type: 'separator' },
        {
          // 原来是算法名后面那颗 InfoHint 的内容。口令分享开着时换成另一句：
          // 那时后量子封装不生效（后端对两者同时出现直接报错），得说清楚。
          id: 'algorithm-hint',
          type: 'custom',
          node: (
            <p className="max-w-80 px-2 py-1.5 text-sm leading-snug text-muted-foreground">
              {shareMode ? t('algorithmShareNote', { algorithm: algorithmSummary }) : PROFILE_TEXT[profileId].hint}
            </p>
          ),
        },
      ],
    },
    {
      id: 'encrypt-options',
      label: t('encryptOptionsLabel'),
      icon: FileLock2,
      value: encryptOptionValue || undefined,
      active: shareMode || deleteSourceOnEncrypt,
      contentClassName: 'min-w-72',
      items: [
        {
          id: 'share-mode',
          type: 'toggle',
          label: t('shareModeLabel'),
          description: t('shareModeHint'),
          checked: shareMode,
          disabled: showProgress,
          onCheckedChange: setShareMode,
        },
        { id: 'encrypt-options-sep', type: 'separator' },
        {
          id: 'delete-source-encrypt',
          type: 'toggle',
          label: t('deleteSourceOnEncryptShort'),
          description: `${t('secureDeleteIrreversible')} ${t('deleteSourceOnEncryptHint')}`,
          checked: deleteSourceOnEncrypt,
          disabled: showProgress,
          onCheckedChange: setDeleteSourceOnEncrypt,
        },
      ],
    },
    {
      id: 'decrypt-options',
      label: t('decryptOptionsLabel'),
      icon: Unlock,
      value: deleteSourceOnDecrypt ? t('valueSecureDelete') : undefined,
      active: deleteSourceOnDecrypt,
      contentClassName: 'min-w-72',
      items: [
        {
          id: 'delete-source-decrypt',
          type: 'toggle',
          label: t('deleteSourceOnDecryptShort'),
          description: `${t('secureDeleteIrreversible')} ${t('deleteSourceOnDecryptHint')}`,
          checked: deleteSourceOnDecrypt,
          disabled: showProgress,
          onCheckedChange: setDeleteSourceOnDecrypt,
        },
      ],
    },
    {
      // 加密/解密之外的三件事。重新加密和残留扫描仍然只在专业模式下出现——
      // 算法是每次加密都要面对的，这两个不是，默认模式没必要为它们付位置。
      id: 'tools',
      label: t('menuTools'),
      icon: Wrench,
      contentClassName: 'min-w-72',
      items: [
        {
          id: 'verify',
          type: 'item',
          label: t('verifyMenuLabel'),
          icon: ShieldCheck,
          description: t('verifyNoPlaintextHint'),
          disabled: showProgress,
          onSelect: () => void handleVerify(),
        },
        { id: 'tools-sep', type: 'separator' },
        {
          id: 'reencrypt',
          type: 'item',
          label: t('reencryptMenuLabel'),
          icon: FolderSync,
          description: t('reencryptButtonHint'),
          hidden: !isProfessional,
          disabled: showProgress || reencryptBusy,
          onSelect: () => void handleStartFolderReencrypt(),
        },
        {
          id: 'scan-remnants',
          type: 'item',
          label: t('scanRemnantsShort'),
          icon: ScanSearch,
          description: t('scanRemnantsDescription'),
          hidden: !isProfessional,
          disabled: showProgress,
          onSelect: () => void handleScanRemnants(),
        },
      ],
    },
    {
      id: 'records',
      label: t('menuRecords'),
      icon: History,
      value: showActivity ? undefined : t('activityHiddenValue'),
      items: [
        {
          id: 'show-activity',
          type: 'toggle',
          label: t('showActivityPanel'),
          checked: showActivity,
          onCheckedChange: toggleActivity,
        },
        {
          // 原来概览卡右上角那颗「选择指标」按钮。选中的几项显示在顶栏左端。
          id: 'topbar-metrics',
          type: 'submenu',
          label: t('topbarMetricsMenu'),
          icon: SlidersHorizontal,
          children: FILE_OP_METRICS.map(
            (id): TopBarNode => ({
              id: `metric-${id}`,
              type: 'toggle',
              label: t(`opsMetric_${id}`),
              checked: metrics.includes(id),
              // 最后一项勾不掉（见 toggleMetric），直接画成不可点，免得点了没反应。
              disabled: metrics.length === 1 && metrics.includes(id),
              onCheckedChange: () => toggleMetric(id),
            }),
          ),
        },
        { id: 'records-sep', type: 'separator' },
        {
          id: 'clear-session',
          type: 'item',
          label: t('clearSessionStats'),
          icon: Eraser,
          description: t('clearSessionStatsHint'),
          disabled: opRecords.length === 0,
          onSelect: () => setOpRecords([]),
        },
      ],
    },
  ]

  const shownMetrics = METRIC_DISPLAY_ORDER.filter((id) => metrics.includes(id))

  return (
    <PageShell
      width="canvas"
      onDragEnter={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return
        dragDepth.current += 1
        setDragActive(true)
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1)
        if (dragDepth.current === 0) {
          setDragActive(false)
          setDropTarget(null)
        }
      }}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        resetDrag()
        void handleDropFiles(event)
      }}
    >
      <PageHeader title={t('pageTitle')} />

      <TopBar
        className="border-b border-border/70 pb-3"
        leading={shownMetrics.map((id) => (
          <StatTile
            key={id}
            compact
            label={t(`opsMetric_${id}`)}
            value={formatFileOpMetric(id, opSummary)}
            hint={t('opsMetricJumpHint')}
            // 数字是入口：点一下打开下面的加解密记录（关着就先打开），并滚到那里——
            // 「本次加密 12」之后用户要看的就是这 12 条是哪些。
            onClick={() => {
              toggleActivity(true)
              requestAnimationFrame(() => activityRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
            }}
          />
        ))}
        menus={topBarMenus}
        trailing={
          // 整页都能拖放（按扩展名自动分流），但以前界面上一个字都没提。宽窗口
          // 下在顶栏右端说一句；窄了就让位给菜单。
          <span className="hidden items-center gap-1.5 text-sm text-muted-foreground @7xl:flex">
            <Upload className="size-4" aria-hidden="true" />
            {t('dropHint')}
          </span>
        }
      />

      {/* 加密和解密是这个页面仅有的两件要紧事，所以它们并排占据顶栏下面最宽的
          位置。两块结构完全对称（图标 + 名称 + 一句话 + 两颗按钮 + 设置摘要），
          高度天然一致——旧版解密卡下半截空着一大块，就是因为设置只塞在了加密卡里。
          设置本身在顶栏；这里底部那行摘要是"这次点下去实际会怎么做"，安全删除
          开着时用警示色。 */}
      <div className="grid gap-6 lg:grid-cols-2">
        <ActionTile
          icon={FileLock2}
          title={t('encryptCardTitle')}
          summary={t('encryptTileSummary')}
          dropLabel={t('dropToEncrypt')}
          dragActive={dragActive}
          dropHover={dropTarget === 'encrypt'}
          disabled={showProgress}
          onDragHover={() => setDropTarget('encrypt')}
          onDragLeave={() => setDropTarget((current) => (current === 'encrypt' ? null : current))}
          onDrop={(event) => void handleTileDrop('encrypt', event)}
          status={
            <>
              <TileStatus icon={ShieldCheck} title={PROFILE_TEXT[profileId].label}>
                <span className="tabular">{algorithmSummary}</span>
              </TileStatus>
              {shareMode && (
                <TileStatus icon={KeyRound} tone="accent" title={t('shareModeHint')}>
                  {t('shareModeLabel')}
                </TileStatus>
              )}
              {deleteSourceOnEncrypt ? (
                <TileStatus icon={Trash2} tone="danger" title={t('deleteSourceOnEncryptHint')}>
                  {t('statusDeleteAfterEncrypt')}
                </TileStatus>
              ) : (
                <TileStatus icon={FileCheck2}>{t('statusKeepAfterEncrypt')}</TileStatus>
              )}
            </>
          }
        >
          <Button size="lg" className="h-12" onClick={handleEncrypt} disabled={showProgress}>
            <FileLock2 className="size-5" aria-hidden="true" /> {t('encryptButton')}
          </Button>
          {/* 「加密整个文件夹」跟"加密文件"是同一件事的两种输入，并排摆在一起。 */}
          <Button size="lg" variant="outline" className="h-12" onClick={handleEncryptFolder} disabled={showProgress}>
            <FolderInput className="size-5" aria-hidden="true" /> {t('encryptFolderButton')}
          </Button>
        </ActionTile>

        <ActionTile
          icon={Unlock}
          title={t('decryptCardTitle')}
          summary={t('decryptTileSummary')}
          dropLabel={t('dropToDecrypt')}
          dragActive={dragActive}
          dropHover={dropTarget === 'decrypt'}
          disabled={showProgress}
          onDragHover={() => setDropTarget('decrypt')}
          onDragLeave={() => setDropTarget((current) => (current === 'decrypt' ? null : current))}
          onDrop={(event) => void handleTileDrop('decrypt', event)}
          status={
            <>
              <TileStatus icon={FileSearch}>{t('statusAutoDetect')}</TileStatus>
              {deleteSourceOnDecrypt ? (
                <TileStatus icon={Trash2} tone="danger" title={t('deleteSourceOnDecryptHint')}>
                  {t('statusDeleteAfterDecrypt')}
                </TileStatus>
              ) : (
                <TileStatus icon={FileCheck2}>{t('statusKeepAfterDecrypt')}</TileStatus>
              )}
            </>
          }
        >
          <Button size="lg" className="h-12" onClick={handleDecrypt} disabled={showProgress}>
            <Unlock className="size-5" aria-hidden="true" /> {t('decryptButton')}
          </Button>
          <Button size="lg" variant="outline" className="h-12" onClick={handleDecryptFolder} disabled={showProgress}>
            <FolderInput className="size-5" aria-hidden="true" /> {t('decryptFolderButton')}
          </Button>
        </ActionTile>
      </div>

      {/* 进行中的队列和残留清单紧跟在两块磁贴下面：刚点完按钮，视线就在这儿。
          原来它们排在概览卡之后，批量加密一开始进度要往下滚才看得见。 */}
      {showProgress && queueItems && (
        <PageSection
          icon={Loader2}
          title={t('queueSectionTitle')}
          actions={
            <Badge tone="accent">
              {t('queueOverallLabel', { label: busyLabel, done: queueDoneCount, total: queueItems.length })}
            </Badge>
          }
        >
          <div className="space-y-3">
            {queueItems.length > 1 && (
              <Progress className="h-2" value={(queueDoneCount / queueItems.length) * 100} />
            )}
            {/* Several items run at once (BATCH_CONCURRENCY) instead of one
                at a time - this list is the "队列面板" showing each item's own
                state rather than a single "current file" tracker. */}
            <div
              ref={queueScrollRef}
              className="overflow-y-auto"
              style={{ maxHeight: QUEUE_VIEWPORT_HEIGHT }}
            >
              <div className="relative w-full" style={{ height: queueVirtualizer.getTotalSize() }}>
                {queueVirtualizer.getVirtualItems().map((virtualRow) => {
                  const item = queueRows[virtualRow.index]
                  if (!item) return null
                  return (
                    <QueueRow
                      key={virtualRow.key}
                      item={item}
                      offset={virtualRow.start}
                      // 虚拟化后孩子只剩可见的几个，CSS odd: 会跳；斑马纹必须按真实下标算。
                      zebra={virtualRow.index % 2 === 0}
                      secureDeletingLabel={queueSecureDeletingLabel}
                      errorLabel={queueErrorLabel}
                    />
                  )
                })}
              </div>
            </div>
          </div>
        </PageSection>
      )}

      {remnantItems && (
        <PageSection
          icon={ScanSearch}
          tone="warning"
          title={t('remnantsFoundTitle', { count: remnantItems.length })}
          actions={
            <>
              <Button size="sm" onClick={handleSecureDeleteRemnants} disabled={showProgress || selectedCount === 0}>
                <Trash2 className="size-4" />
                {t('secureDeleteSelectedButton', { count: selectedCount })}
              </Button>
              <Button size="sm" variant="outline" onClick={() => setRemnantItems(null)} disabled={showProgress}>
                {t('ignoreButton')}
              </Button>
            </>
          }
        >
          <div className="space-y-3">
            <p className="text-sm leading-snug text-muted-foreground">
              {t('remnantsExplanation')}
              <span className="font-medium text-warning">{t('remnantsSameNameWarning')}</span>
              {t('remnantsExplanationTail')}
            </p>
            <div
              ref={remnantScrollRef}
              className="overflow-y-auto"
              style={{ maxHeight: REMNANT_VIEWPORT_HEIGHT }}
            >
              <div className="relative w-full" style={{ height: remnantVirtualizer.getTotalSize() }}>
                {remnantVirtualizer.getVirtualItems().map((virtualRow) => {
                  const it = remnantRows[virtualRow.index]
                  if (!it) return null
                  return (
                    <RemnantRow
                      key={virtualRow.key}
                      item={it}
                      checked={remnantSelected.has(it.path)}
                      disabled={showProgress}
                      onToggle={toggleRemnant}
                      categoryLabel={REMNANT_CATEGORY_LABELS[it.category]}
                      matchedSuffix={remnantMatchedSuffix}
                      offset={virtualRow.start}
                      index={virtualRow.index}
                      measureRef={remnantVirtualizer.measureElement}
                    />
                  )
                })}
              </div>
            </div>
          </div>
        </PageSection>
      )}

      {lastDecryptedFile && (
        <PageSection icon={Sparkles} title={t('aiSectionTitle')} tone="info">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="min-w-0 flex-1 truncate text-sm">{lastDecryptedFile.name}</span>
            <Button size="sm" variant="outline" onClick={() => setAiConfirmOpen(true)} disabled={showProgress}>
              <Sparkles className="size-4" />
              {t('aiSummarizeButton')}
            </Button>
          </div>
        </PageSection>
      )}

      {showActivity && (
        <div ref={activityRef}>
          <FileOpsDashboard records={opRecords} history={fileHistory} />
        </div>
      )}

      {/* 原来这里还有一张「高级操作」卡（算法选择 / 加密整个文件夹 / 增量重新加密 /
          明文残留扫描），早已拆散：算法现在在顶栏「算法」菜单，文件夹加密在加密
          磁贴上，另外两件收尾动作在顶栏「工具」菜单。一个叫"高级操作"的抽屉不告诉
          用户里面是什么，而里面每一样其实都有自己更确切的归处。 */}

      {passPrompt.element}
      <VerifyResultsDialog rows={verifyRows} onClose={() => setVerifyRows(null)} />

      <Dialog open={aiConfirmOpen} onOpenChange={setAiConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('aiConfirmSendTitle')}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">{t('aiConfirmSendBody')}</p>
          <div className="flex gap-2 pt-1">
            <Button className="flex-1" onClick={handleAiSummarizeConfirmed}>
              {t('aiConfirmSendButton')}
            </Button>
            <Button className="flex-1" variant="outline" onClick={() => setAiConfirmOpen(false)}>
              {t('aiCancelButton')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={aiSummary.open} onOpenChange={(o) => !o && setAiSummary((s) => ({ ...s, open: false }))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('aiSummaryDialogTitle')}</DialogTitle>
          </DialogHeader>
          {aiSummary.loading ? (
            <p className="text-sm text-muted-foreground">{t('aiSummarizingButton')}</p>
          ) : (
            <div className="space-y-2">
              {aiSummary.truncated && <p className="text-sm text-muted-foreground">{t('aiSummaryTruncatedHint')}</p>}
              <p className="max-h-96 overflow-y-auto whitespace-pre-wrap break-words text-sm">{aiSummary.text}</p>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={decryptPreview !== null} onOpenChange={(o) => !o && handleCancelDecryptBatch()}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('decryptPreviewTitle', { count: decryptPreview?.items.length ?? 0 })}</DialogTitle>
          </DialogHeader>
          {decryptPreview && (
            <div className="space-y-2">
              <div className="max-h-64 space-y-1 overflow-y-auto">
                {decryptPreview.items.map((it) => (
                  <div key={it.path} className="text-sm leading-snug break-all">
                    <span className="font-medium">{it.name}</span>
                    <span className="text-muted-foreground">
                      {' '}
                      — {formatSize(it.size)}
                      {it.mtime !== null ? `，${formatMtime(it.mtime)}` : ''}
                    </span>
                  </div>
                ))}
              </div>
              {decryptPreview.headerFailures.length > 0 && (
                <p className="text-sm text-muted-foreground">
                  {t('decryptPreviewSkippedHint', { count: decryptPreview.headerFailures.length })}
                </p>
              )}
              <div className="flex gap-2 pt-1">
                <Button className="flex-1" onClick={handleConfirmDecryptBatch}>
                  {t('decryptPreviewConfirmButton')}
                </Button>
                <Button className="flex-1" variant="outline" onClick={handleCancelDecryptBatch}>
                  {t('decryptPreviewCancelButton')}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Folder containers can't reuse decryptPreview above (that dialog
          picks one shared output DIRECTORY for several plain files; a
          folder container needs its own destination-folder step per
          container) - see decryptPaths/showNextFolderPreview. Closing this
          dialog any way (button, Escape, click-outside) discards the
          already-decrypted temp file via handleCancelFolderDecrypt, not
          just the explicit Cancel button - it's a real temp file on disk
          that needs cleaning up regardless of how the user closes this. */}
      <Dialog open={folderPreview !== null} onOpenChange={(o) => !o && void handleCancelFolderDecrypt()}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('folderDecryptPreviewTitle', { name: folderPreview?.originalName ?? '' })}</DialogTitle>
          </DialogHeader>
          {folderPreview && (
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">
                {t('folderDecryptPreviewHint', { count: folderPreview.entries.filter((e) => !e.is_dir).length })}
              </p>
              <div className="max-h-64 space-y-1 overflow-y-auto">
                {folderPreview.entries.map((e) => (
                  <div key={e.name} className="text-sm leading-snug break-all">
                    <span className={e.is_dir ? 'text-muted-foreground' : 'font-medium'}>{e.name}</span>
                    {!e.is_dir && <span className="text-muted-foreground"> — {formatSize(e.size)}</span>}
                  </div>
                ))}
                {folderPreview.entries.length === 0 && (
                  <p className="text-sm text-muted-foreground">{t('folderDecryptPreviewEmptyHint')}</p>
                )}
              </div>
              <div className="flex gap-2 pt-1">
                <Button className="flex-1" onClick={handleConfirmFolderDecrypt}>
                  {t('decryptPreviewConfirmButton')}
                </Button>
                <Button className="flex-1" variant="outline" onClick={handleCancelFolderDecrypt}>
                  {t('decryptPreviewCancelButton')}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={reencryptDiff !== null || reencryptBusy}
        onOpenChange={(o) => !o && !reencryptBusy && handleCancelFolderReencrypt()}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('reencryptDialogTitle', { name: reencryptDiff?.original_name ?? '' })}</DialogTitle>
          </DialogHeader>
          {reencryptDiff === null ? (
            <p className="text-sm text-muted-foreground">{t('reencryptDiffingLabel')}</p>
          ) : (
            (() => {
              const diff = reencryptDiff
              const totalChanges =
                diff.added.length + diff.removed.length + diff.modified.length + diff.empty_dirs_added.length + diff.empty_dirs_removed.length
              return (
                <div className="space-y-2">
                  <p className="text-sm text-muted-foreground">
                    {totalChanges === 0
                      ? t('reencryptNoChangesHint', { count: diff.unchanged_count })
                      : t('reencryptChangesSummary', {
                          added: diff.added.length,
                          removed: diff.removed.length,
                          modified: diff.modified.length,
                          unchanged: diff.unchanged_count,
                        })}
                  </p>
                  {totalChanges > 0 && (
                    <div className="max-h-64 space-y-1 overflow-y-auto text-sm leading-snug">
                      {diff.added.map((name) => (
                        <p key={`add-${name}`} className="break-all text-success">
                          + {name}
                        </p>
                      ))}
                      {diff.empty_dirs_added.map((name) => (
                        <p key={`add-dir-${name}`} className="break-all text-success">
                          + {name}
                        </p>
                      ))}
                      {diff.removed.map((name) => (
                        <p key={`rm-${name}`} className="break-all text-destructive">
                          − {name}
                        </p>
                      ))}
                      {diff.empty_dirs_removed.map((name) => (
                        <p key={`rm-dir-${name}`} className="break-all text-destructive">
                          − {name}
                        </p>
                      ))}
                      {diff.modified.map((name) => (
                        <p key={`mod-${name}`} className="break-all text-warning">
                          ~ {name}
                        </p>
                      ))}
                    </div>
                  )}
                  <div className="flex gap-2 pt-1">
                    {totalChanges > 0 && (
                      <Button className="flex-1" onClick={() => void handleConfirmFolderReencrypt()} disabled={reencryptBusy}>
                        {reencryptBusy ? t('reencryptInProgressLabel') : t('reencryptConfirmButton')}
                      </Button>
                    )}
                    <Button className="flex-1" variant="outline" onClick={handleCancelFolderReencrypt} disabled={reencryptBusy}>
                      {t('decryptPreviewCancelButton')}
                    </Button>
                  </div>
                </div>
              )
            })()
          )}
        </DialogContent>
      </Dialog>
    </PageShell>
  )
}
