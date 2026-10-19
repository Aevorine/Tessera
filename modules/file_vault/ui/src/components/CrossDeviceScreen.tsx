import { useSmartSearch } from '@/lib/search'
import { createDeviceSearcher, createTransferSearcher } from '@/lib/search/fields/devices'
import { SmartSearchBox } from '@/components/search/SmartSearchBox'
import { Highlight } from '@/components/search/Highlight'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import QRCode from 'qrcode'
import {
  Activity,
  AlertTriangle,
  Ban,
  CheckCircle2,
  Clipboard,
  Copy,
  File as FileIcon,
  Folder,
  FolderOpen,
  Gauge,
  GitFork,
  Globe,
  History,
  Image as ImageIcon,
  Info,
  Hash,
  Keyboard,
  Laptop,
  LayoutGrid,
  Link2,
  Loader2,
  Monitor,
  MonitorSmartphone,
  Package,
  Pause,
  Pencil,
  Play,
  QrCode,
  Radar,
  RefreshCw,
  Send,
  ShieldCheck,
  SlidersHorizontal,
  Smartphone,
  Stethoscope,
  Tablet,
  Trash2,
  Type,
  Upload,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge, EmptyState, FeatureTitle, NUMERIC_CLASS, PageHeader, PageShell } from '@/components/ui/page'
import { InfoHint } from '@/components/ui/info-hint'
import { Workbench, WorkbenchDetailBody, WorkbenchDetailHeader } from '@/components/ui/workbench'
// 这一页不再直接用 Card：所有分区统一走 PageSection（页头、留白、折叠行为
// 都由它定死），这样以后加新分区也不可能长歪。见 ui/page.tsx 顶部的说明。
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { Progress } from '@/components/ui/progress'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { electronApi } from '@/lib/electronApi'
import { crossDeviceApi } from '@/lib/crossDeviceApi'
import { SessionCounter, bestRttMs, currentSpeeds, measureRefreshRate } from '@/lib/crossDeviceMetrics'
import { buildPairLink, parsePairInput } from '@/lib/pairLink'
import { copyText } from '@/lib/clipboard'
import { ClipTimelinePanel } from '@/components/crossdevice/ClipTimelinePanel'
import { LatencySparkline } from '@/components/crossdevice/LatencySparkline'
import { FeatureGrid, type FeatureTileSpec } from '@/components/feature/FeatureGrid'
import { FeaturePanel } from '@/components/feature/FeaturePanel'
import { HubSearchResults, type HubSearchHandle } from '@/components/crossdevice/HubSearchResults'
import { hubSearcher, type HubEntry, type HubGroup } from '@/lib/search/fields/hub'
import { ClipSendDialog } from '@/components/crossdevice/ClipSendDialog'
import { DevicePolicyPanel, type ClipPolicy, type FilePolicy } from '@/components/crossdevice/DevicePolicyPanel'
import { latencyStats, type LatencyPoint } from '@/lib/latencyStats'

// ---------- 守护进程返回的结构 ----------

interface Device {
  device_id: string
  name: string
  type: string
  trust: 'long' | 'temp'
  state: string
  paired_at: number
  expires_at?: number
  last_seen?: number
  rtt_ms?: number
  method?: string
  /** 这条连接实际走的哪条路（守护进程算的，见 agent.go 的 m["via"]）。
   *  后端一直在发，前端类型里原先没有这两个字段，于是数据到了就被丢掉。 */
  via?: string
  relayed?: boolean
  /** 最近一次剪贴板同步的端到端耗时：本机发出 → 对端写入剪贴板并确认。 */
  clip_latency_ms?: number
  clip_acked_at?: number
  /** 最近若干次剪贴板同步耗时，旧的在前，画成迷你曲线。断线后仍保留。 */
  clip_latency_hist?: LatencyPoint[]
  /** via 的机器可读版：direct / holepunch / relay。via 本身是中文短语，只能进日志。 */
  route?: 'direct' | 'holepunch' | 'relay'
  /** 这一台设备单独的同步范围（见 DevicePolicyPanel）。 */
  clip_policy?: ClipPolicy
  file_policy?: FilePolicy
  /** 最近一次自动重连失败的原因；连上即清。 */
  offline_reason?: { code: string; at: number }
}

interface Options {
  clip_sync: boolean
  /** 只同步纯文本与图片，不带 HTML/RTF 富格式。 */
  clip_plain_only?: boolean
  auto_accept: boolean
  download_dir: string
  /** 跨网络的中转点地址。空串 = 不启用，只走局域网（默认）。 */
  rendezvous_addr: string
  /** 口令**只回传"设没设过"**，永远不回传明文——明文回传只会多出一份
   *  可能被日志、截图、剪贴板带走的副本。 */
  rendezvous_secret_set: boolean
  /** 按流量计费的网络下允不允许走中转。桌面端一般是 false（有线/Wi-Fi）。 */
  relay_on_metered: boolean
  /** 当前这张网是不是按流量计费。 */
  metered: boolean
}

interface Status {
  device_id: string
  name: string
  fingerprint: string
  port: number
  devices: Device[]
  options: Options
}

/**
 * 局域网发现到的未配对设备。`via` 只记发现方式（mDNS 组播 / scan 主动扫描），两路合并展示，不给用户
 * 看。
 */
interface NearbyDevice {
  device_id: string
  name: string
  type: string
  addrs: string[]
  via?: 'mdns' | 'scan'
  /**
   * 已配对。已配对和已撤销的设备都照常出现在列表里（后者视为陌生设备），否则用户分不清是没扫到还是被
   * 藏了。
   */
  paired?: boolean
}

/** 守护进程的连接自检结果。每条 check 只给机器可读的 id 和键值对，
 *  人话在这边翻译——诊断结论也要跟着界面语言走。 */
interface DiagCheck {
  id: string
  /**
   * info = 只是观测结果，无好坏。"0 台设备"多半是对面没开机，不是本机故障，不能用 warn 误导用户去改防
   * 火墙。
   */
  status: 'ok' | 'info' | 'warn' | 'fail'
  values?: Record<string, string>
}

interface DiagReport {
  checks: DiagCheck[]
  endpoints: string[]
}

/** send_files 的返回。files 是**展开后**的真实文件数（选文件夹时远大于选中项数），
 *  skipped 是空文件夹和读不了的路径。 */
interface QueueResult {
  queued?: number
  files?: number
  devices?: number
  skipped?: string[]
}

/** active_transfers 回来的一条。字段名跟守护进程一一对应。 */
interface RemoteTransfer {
  transfer_id: string
  device_id: string
  device_name: string
  direction: 'send' | 'recv'
  name: string
  item_kind?: string
  total?: number
  state: string
}

/** clip_sync_log 的一条：剪贴板正文同步结果，永远是接收方视角（见 clipxfer.go）。 */
interface ClipSyncLogEntry {
  device_id: string
  device_name: string
  mime: string
  item_id: string
  ok: boolean
  error?: string
  at: number
}

/** clip_conflicts 回来的一条："对方复制这条内容时，还没见过本机当前的内容"——
 *  单指针因果链判出来的真并发，不是时间戳靠后就判定的覆盖。 */
interface ClipConflictEntryRemote {
  device_id: string
  device_name: string
  incoming_hlc: string
  local_hlc: string
  at: number
}

type FirewallState = 'allowed' | 'blocked' | 'unknown'

interface PairRequest {
  request_id: string
  device_id: string
  name: string
  type: string
  fingerprint: string
  sas_digits: string
  sas_emoji: string[]
  incoming: boolean
}

interface TransferRequest {
  request_id: string
  device_id: string
  device_name: string
  name: string
  size: number
  files: number
}

/** 传输的东西是什么。图标和措辞跟着它走——"收到一张图片"和"收到一个文件"
 *  在界面上本来就该长得不一样。 */
type ItemKind = 'file' | 'folder' | 'image' | 'app' | 'clip'

/**
 * 一条进行中的传输，结束后移入历史。key 必须是守护进程给的 transfer_id，不能用"设备+文件名"：接收端
 * 重名改成 `报告 (1).pdf` 后 key 对不上，进度条会永远停在 99%。
 */
interface ActiveTransfer {
  key: string
  direction: 'send' | 'recv'
  deviceName: string
  name: string
  itemKind: ItemKind
  done: number
  total: number
  percent: number
  /** 字节/秒，取自守护进程最近一个上报窗口。 */
  speed: number
  state: 'running' | 'paused'
}

interface TransferRow {
  key: string
  direction: 'send' | 'recv'
  deviceName: string
  name: string
  itemKind: ItemKind
  kind: string
  size?: number
  elapsedMs?: number
  error?: string
  /** 秒传：对方已有一份内容相同的文件，0 字节完成。
   *  不单独标出来的话，一次 44 MB 的传输"瞬间就完成了"会让人怀疑它到底传没传。 */
  skipped?: boolean
  at: number
  /** 直连还是中继。必须在传输完成那一刻定格，事后查到的是当前链路而非那次传输的。 */
  relayed?: boolean
}

const deviceSearcher = createDeviceSearcher<Device>()
const transferSearcher = createTransferSearcher<TransferRow>()

// 走 @/lib/crossDeviceApi 而非直接用 window.crossDeviceAPI：它会剥掉 Electron 给 IPC 错误套的英文
// 壳，让 toast.error(err.message) 显示守护进程的中文提示。见 lib/ipcError.ts。
const api = crossDeviceApi

const DEVICE_ICON: Record<string, typeof Laptop> = {
  phone: Smartphone,
  tablet: Tablet,
  pc: Monitor,
}

/** 只有这三个状态算"能收东西"。DEGRADED 也算——链路差但还通。 */
const ONLINE_STATES = new Set(['CONNECTED', 'DEGRADED'])

/** 传输项的图标。用户扫一眼就知道在传的是文件、图片、文件夹还是一个安装包。 */
const ITEM_ICON: Record<ItemKind, typeof FileIcon> = {
  file: FileIcon,
  folder: Folder,
  image: ImageIcon,
  app: Package,
  clip: Clipboard,
}

/** 剪贴板同步历史 mime → 标签翻译 key（对应 core/clipboard/clip.go），未知落 clipKind.generic。 */
const CLIP_MIME_KIND: Record<string, string> = {
  'image/png': 'clipKind.image',
  'image/jpeg': 'clipKind.image',
  'text/html': 'clipKind.richtext',
  'application/rtf': 'clipKind.rtf',
  'text/plain;charset=utf-8': 'clipKind.text',
}

/**
 * 右栏：本设备连接实况。要显示走的是直连还是中继——中继意味着流量经第三方服务器（内容仍端到端加密，
 * 但连接存在和大小对方可见），必须有固定位置可查。
 */
function DeviceDetailPane({
  device,
  onRevoke,
  onUpdated,
}: {
  device: Device
  onRevoke: () => void
  onUpdated: (device: Device) => void
}) {
  const { t } = useTranslation('crossdevice')
  const Icon = DEVICE_ICON[device.type] ?? Laptop
  const online = ONLINE_STATES.has(device.state)
  // 每行带自己的 id，不用标签当 key：method（当初怎么配对）和 via（此刻走哪条路）曾共用「连接方式」标
  // 签，造成重复 key 和并排两行同名行。
  const rows: { id: string; label: string; value: React.ReactNode }[] = [
    { id: 'device-id', label: t('deviceIdLabel'), value: device.device_id },
    { id: 'paired-at', label: t('pairedAtLabel'), value: new Date(device.paired_at).toLocaleString() },
  ]
  if (device.last_seen) {
    rows.push({ id: 'last-seen', label: t('lastSeenLabel'), value: new Date(device.last_seen).toLocaleString() })
  }
  if (device.rtt_ms !== undefined) {
    rows.push({ id: 'rtt', label: t('rttLabel'), value: `${device.rtt_ms} ms` })
  }
  if (device.clip_latency_ms !== undefined) {
    rows.push({ id: 'clip-latency', label: t('clipLatencyLabel'), value: `${device.clip_latency_ms} ms` })
  }
  const hist = device.clip_latency_hist ?? []
  const stats = latencyStats(hist)
  if (stats && hist.length >= 2) {
    rows.push({
      id: 'clip-latency-trend',
      label: t('clipLatencyTrend'),
      value: (
        <span className="flex flex-wrap items-center gap-2">
          <LatencySparkline points={hist} width={160} height={32} />
          <span className="text-muted-foreground">
            {t('clipLatencyStats', { n: hist.length, min: stats.min, avg: stats.avg, max: stats.max })}
          </span>
          {stats.worse && <Badge tone="warning">{t('clipLatencyWorse')}</Badge>}
        </span>
      ),
    })
  }
  if (device.method) rows.push({ id: 'method', label: t('methodLabel'), value: device.method })
  if (device.route || device.via) {
    // 用 route（direct / holepunch / relay）查翻译表。via 是守护进程日志里的中文
    // 短语，拿它当键的话另外五种语言全都会显示成中文。
    const route = device.route ?? (device.relayed ? 'relay' : 'direct')
    rows.push({ id: 'via', label: t('viaLabel'), value: t(`via.${route}`) })
  }
  if (!online && device.offline_reason) {
    const minutes = Math.max(0, Math.round((Date.now() - device.offline_reason.at) / 60000))
    rows.push({
      id: 'offline-reason',
      label: t('offlineReasonLabel'),
      value: (
        <span className="flex flex-wrap items-center gap-2">
          <span>{t(`offline.${device.offline_reason.code}`, { defaultValue: t('offline.other') })}</span>
          <span className="text-muted-foreground">{t('offlineReasonAgo', { minutes })}</span>
        </span>
      ),
    })
  }

  return (
    <>
      <WorkbenchDetailHeader
        icon={Icon}
        tone={online ? 'success' : 'neutral'}
        title={device.name}
        actions={
          <Button size="sm" variant="destructive" onClick={onRevoke}>
            <Trash2 className="mr-2 size-4" aria-hidden="true" />
            {t('revoke')}
          </Button>
        }
      />
      <WorkbenchDetailBody>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={online ? 'success' : 'neutral'} icon={online ? Wifi : WifiOff}>
            {t(`state.${device.state}`, { defaultValue: device.state })}
          </Badge>
          <Badge tone={device.trust === 'temp' ? 'warning' : 'neutral'}>
            {device.trust === 'temp' ? t('trustTemp') : t('trustLong')}
          </Badge>
          {online &&
            (device.relayed ? (
              <Badge tone="warning">{t('receiptRelayed')}</Badge>
            ) : (
              <Badge tone="success">{t('receiptDirect')}</Badge>
            ))}
        </div>
        <DevicePolicyPanel device={device} onUpdated={onUpdated} />
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
          {rows.map((r) => (
            <div key={r.id} className="contents">
              <dt className="text-muted-foreground">{r.label}</dt>
              <dd className={cn('min-w-0 break-words', NUMERIC_CLASS)}>{r.value}</dd>
            </div>
          ))}
        </dl>
      </WorkbenchDetailBody>
    </>
  )
}

function humanSize(n?: number): string {
  if (!n || n < 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}

/** 剩余时间。速度是 0（刚开始、或者正暂停着）时不猜，返回 null 让界面留白——
 *  显示一个"还需 ∞ 秒"比什么都不显示更糟。 */
function etaSeconds(a: ActiveTransfer): number | null {
  if (a.state === 'paused' || a.speed <= 0 || a.total <= 0) return null
  const left = a.total - a.done
  if (left <= 0) return null
  return Math.round(left / a.speed)
}

function humanDuration(sec: number): string {
  if (sec < 60) return `${sec}s`
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`
}

export function CrossDeviceScreen() {
  const { t } = useTranslation('crossdevice')
  const { t: tCommon } = useTranslation('common')

  const [available, setAvailable] = useState<boolean | null>(null)
  const [daemonError, setDaemonError] = useState<string | null>(null)
  const [status, setStatus] = useState<Status | null>(null)

  /**
   * 设备列表的 ref 镜像：mount-once 订阅回调里闭包捕获的是首次渲染的 status，直接读会永远是空数组（账
   * 单全显示"直连"）。
   */
  const devicesRef = useRef<Device[]>([])
  useEffect(() => {
    devicesRef.current = status?.devices ?? []
  }, [status?.devices])
  const [busy, setBusy] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [nearby, setNearby] = useState<NearbyDevice[]>([])
  const [nearbyBusy, setNearbyBusy] = useState(false)
  const [renamingDevice, setRenamingDevice] = useState(false)
  const [draftName, setDraftName] = useState('')

  // 中转点输入框的草稿。地址跟着 status 回填（见下面的 useEffect），
  // 口令则**永远不回填**——Go 侧只告诉我们"设没设过"，不发明文。
  const [rvAddr, setRvAddr] = useState('')
  const [rvSecret, setRvSecret] = useState('')

  // 连通性：防火墙状态 + 自检报告 + 本机地址。这三样回答的是同一个问题
  // ——「为什么我看不到另一台设备」，所以放在同一张卡片里。
  const [firewall, setFirewall] = useState<FirewallState | null>(null)
  const [firewallBusy, setFirewallBusy] = useState(false)
  const [diag, setDiag] = useState<DiagReport | null>(null)
  const [diagBusy, setDiagBusy] = useState(false)
  const [endpoints, setEndpoints] = useState<string[]>([])
  const [scanBusy, setScanBusy] = useState(false)
  const [scanInfo, setScanInfo] = useState<{ probed: number; subnets: string[] } | null>(null)
  const [manualAddr, setManualAddr] = useState('')

  // 配对
  const [pairMode, setPairMode] = useState<'long' | 'temp'>('long')
  const [tempTtl, setTempTtl] = useState('1800')
  const [myCode, setMyCode] = useState<{ code: string; fingerprint: string; expires_at: number } | null>(null)
  // 短数字配对码。跟上面那个 416 字符的载荷是两回事：这个是 6 位数字，
  // 给"对着另一台设备的屏幕敲进去"用的。
  const [shortCode, setShortCode] = useState<{ code: string; expires_at: number } | null>(null)
  const [shortCodeLeft, setShortCodeLeft] = useState(0)
  const [peerShortCode, setPeerShortCode] = useState('')
  const [shortBusy, setShortBusy] = useState(false)
  const [qrDataUrl, setQrDataUrl] = useState<string>('')
  const [codeLeft, setCodeLeft] = useState(0)
  const [peerCode, setPeerCode] = useState('')
  const [pairing, setPairing] = useState(false)
  // Controlled so a successful pair can put the panel back to its resting
  // state instead of leaving the user on whichever tab they happened to use.
  const [pairTab, setPairTab] = useState('digits')

  // 待确认
  const [pairReq, setPairReq] = useState<PairRequest | null>(null)
  const [xferReq, setXferReq] = useState<TransferRequest | null>(null)

  // 传输记录（内存里保留最近 50 条，重启即清——这是活动指示器，不是历史库）
  const [transfers, setTransfers] = useState<TransferRow[]>([])
  // 剪贴板同步状态：同步历史与冲突。是已结束/已检出的记录，与 active 分开（在跑的 clip 已由 item_kind
  // === 'clip' 带出）。
  const [clipSyncLog, setClipSyncLog] = useState<ClipSyncLogEntry[]>([])
  const [clipConflicts, setClipConflicts] = useState<ClipConflictEntryRemote[]>([])

  /** 进行中的传输。用 Map：进度事件每 250ms 一条，数组查找替换是 O(n) 且易出现同文件两行。 */
  const [active, setActive] = useState<Map<string, ActiveTransfer>>(new Map())
  /** 本次会话的累计收发量。用 ref 不用 state：它每 250 ms 变一次，
   *  放进 state 会让整页跟着重渲染，而它只在指标区显示。 */
  const sessionCounter = useRef(new SessionCounter())
  /** 屏幕刷新率。测一次就够——它在一次会话里不会变。 */
  const [refreshHz, setRefreshHz] = useState<number | null>(null)
  /** 指标每秒刷一次。只有指标区展开时才跑，收起来就不再占任何 CPU。 */
  const [metricsTick, setMetricsTick] = useState(0)
  const [metricsOpen, setMetricsOpen] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  /** 右栏正在显示哪一台。存 id 不存整个对象——设备状态每秒都在刷，
   *  存对象的话右栏会一直显示一份过期的快照。 */
  const [detailDeviceId, setDetailDeviceId] = useState<string | null>(null)

  /** 发送目标模式：'one' 发一台，'many' 发勾选的多台。默认 'one'，群发应是明确动作。 */
  const [fanout, setFanout] = useState<'one' | 'many'>('one')
  const [soloTarget, setSoloTarget] = useState<string | null>(null)

  /** 当前打开的全屏次功能面板，以及展开动画的圆心。 */
  const [panel, setPanel] = useState<string | null>(null)
  const [panelOrigin, setPanelOrigin] = useState<{ x: number; y: number } | null>(null)
  const [clipPickOpen, setClipPickOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const closePanel = useCallback(() => setPanel(null), [])
  // 指标只在其面板打开时每秒刷新。
  useEffect(() => setMetricsOpen(panel === 'metrics'), [panel])

  /** 传输记录里被勾中的行。与上面的 selected（设备勾选）是两回事，别复用。 */
  const [pickedRows, setPickedRows] = useState<Set<string>>(new Set())

  const toggleRow = useCallback((key: string) => {
    setPickedRows((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const deletePickedRows = useCallback(() => {
    setTransfers((rows) => rows.filter((r) => !pickedRows.has(r.key)))
    setPickedRows(new Set())
  }, [pickedRows])

  const clearAllRows = useCallback(() => {
    setTransfers([])
    setPickedRows(new Set())
  }, [])

  const seq = useRef(0)

  const refresh = useCallback(async () => {
    try {
      const s = await api.call<Status>('status')
      setStatus(s)
      setAvailable(true)
      setDaemonError(null)
    } catch (err) {
      setAvailable(false)
      setDaemonError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  /**
   * 补齐进行中的传输：进度是事件推送，组件每次挂载是白纸，不补则切面板回来后进度和暂停/取消按钮都会消
   * 失。
   */
  const refreshActive = useCallback(async () => {
    try {
      const res = await api.call<{ transfers: RemoteTransfer[] }>('active_transfers')
      setActive(() => {
        const next = new Map<string, ActiveTransfer>()
        for (const x of res.transfers ?? []) {
          next.set(x.transfer_id, {
            key: x.transfer_id,
            direction: x.direction,
            deviceName: x.device_name,
            name: x.name,
            itemKind: (x.item_kind ?? 'file') as ItemKind,
            done: 0,
            total: x.total ?? 0,
            percent: 0,
            speed: 0,
            state: x.state === 'paused' ? 'paused' : 'running',
          })
        }
        return next
      })
    } catch {
      /* 拿不到就等下一条进度事件把列表重新填起来，不该让整个面板报错 */
    }
  }, [])

  /** 补齐剪贴板同步历史。事件只推一个信号（clip_sync），完整列表永远靠回头
   *  查这一次——见 agent.go 里 recordClipSyncResult 的注释。 */
  const refreshClipSyncLog = useCallback(async () => {
    try {
      const res = await api.call<{ items: ClipSyncLogEntry[] }>('clip_sync_log')
      setClipSyncLog(res.items ?? [])
    } catch {
      /* 拿不到就保留上一次的历史，不该让整个面板报错 */
    }
  }, [])

  /** 补齐因果冲突历史，跟 refreshClipSyncLog 是同一个理由。 */
  const refreshClipConflicts = useCallback(async () => {
    try {
      const res = await api.call<{ items: ClipConflictEntryRemote[] }>('clip_conflicts')
      setClipConflicts(res.items ?? [])
    } catch {
      /* 同上 */
    }
  }, [])

  /** 暂停 / 继续 / 取消。三个动作走同一条路，状态由守护进程回推的
   *  xfer_state 事件决定——本地先改一次的话，请求失败时界面就说了谎。 */
  const controlTransfer = useCallback(
    async (transferId: string, action: 'pause' | 'resume' | 'cancel') => {
      try {
        await api.call(`${action}_transfer`, { transfer_id: transferId })
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err))
      }
    },
    [],
  )

  useEffect(() => {
    let cancelled = false
    api.available().then((a) => {
      if (cancelled) return
      setAvailable(a.available)
      setDaemonError(a.error)
      if (a.available) {
        refresh()
        refreshActive()
        refreshClipSyncLog()
        refreshClipConflicts()
      }
    })
    return () => {
      cancelled = true
    }
  }, [refresh, refreshActive, refreshClipSyncLog, refreshClipConflicts])

  // 进页面和窗口重新获得焦点时各查一次防火墙状态：查询无需权限、不弹窗；添加规则才弹 UAC，只在用户点
  // 按钮时做。复查是因为用户可能自行放行或把网络改成「专用」，否则横幅会一直显示过期的错误。
  const syncFirewall = useCallback(() => {
    void api
      .firewallStatus()
      .then((st) => setFirewall(st.state))
      .catch(() => setFirewall('unknown'))
  }, [])

  useEffect(() => {
    if (available !== true) return
    let cancelled = false
    void api.firewallStatus().then((st) => {
      if (!cancelled) setFirewall(st.state)
    }).catch(() => {
      if (!cancelled) setFirewall('unknown')
    })
    void api.call<{ endpoints: string[] }>('local_endpoints').then((res) => {
      if (!cancelled) setEndpoints(res.endpoints ?? [])
    }).catch(() => {
      /* 拿不到地址只是少一个手动配对的便利，不该让整个页面报错 */
    })
    return () => {
      cancelled = true
    }
  }, [available])

  useEffect(() => {
    if (available !== true) return
    const onFocus = () => syncFirewall()
    const onVisible = () => {
      if (document.visibilityState === 'visible') syncFirewall()
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [available, syncFirewall])

  // 守护进程的事件流：状态变化、配对请求、传输进度都从这里来。
  useEffect(() => {
    return api.onEvent(({ event, data }) => {
      switch (event) {
        case 'ready':
          setAvailable(true)
          setDaemonError(null)
          refresh()
          refreshActive()
          refreshClipSyncLog()
          refreshClipConflicts()
          break
        case 'state':
          if (data?.devices) setStatus((s) => (s ? { ...s, devices: data.devices as Device[] } : s))
          else refresh()
          break
        case 'paired':
          if (data?.devices) setStatus((s) => (s ? { ...s, devices: data.devices as Device[] } : s))
          else refresh()
          // 每条配对路径在两台设备上都在此收尾；从事件收起（而非各 handler）才能让只显示码的一端也清掉，否则
          // 已用掉的码仍像有效，下一个输入的人会无故失败。
          collapsePairingUiRef.current()
          break
        case 'pair_request':
          setPairReq(data as unknown as PairRequest)
          break
        case 'pair_request_timeout':
          setPairReq(null)
          break
        case 'transfer_request':
          setXferReq(data as unknown as TransferRequest)
          break
        case 'transfer_request_timeout':
          setXferReq(null)
          break
        case 'progress': {
          const d = data ?? {}
          const key = (d.transfer_id as string) || `${d.device_id as string}|${d.name as string}`
          setActive((prev) => {
            const next = new Map(prev)
            const before = prev.get(key)
            next.set(key, {
              key,
              direction: (d.direction as 'send' | 'recv') ?? 'send',
              deviceName: (d.device_name as string) ?? '',
              name: (d.name as string) ?? '',
              itemKind: ((d.item_kind as ItemKind) ?? 'file') as ItemKind,
              done: (d.done as number) ?? 0,
              total: (d.total as number) ?? 0,
              percent: (d.percent as number) ?? 0,
              speed: (d.speed as number) ?? 0,
              // 进度事件不带状态：暂停期间不会有新进度，沿用已知状态，否则在途的最后一条进度会把"暂停"按钮改回运
              // 行态。
              state: before?.state ?? 'running',
            })
            return next
          })
          // 累计传输量：按增量记，理由见 SessionCounter 的说明。
          sessionCounter.current.record(
            key,
            (d.direction as 'send' | 'recv') ?? 'send',
            (d.done as number) ?? 0,
          )
          break
        }
        // 暂停 / 继续 / 取消。**对端按的也会走到这里**——本机界面上那条进度
        // 必须跟着变成"已暂停"，否则用户看到的是一条不动的进度条，和卡死一样。
        case 'xfer_state': {
          const d = data ?? {}
          const key = d.transfer_id as string
          if (!key) break
          const state = d.state as string
          setActive((prev) => {
            const cur = prev.get(key)
            const next = new Map(prev)
            // ended = 传输离开了守护进程注册表。兜底：出错时 error 事件拿不到 transfer_id（在发送函数内部生成
            // ），否则进度行删不掉。
            if (state === 'canceled' || state === 'ended') {
              next.delete(key)
              return next
            }
            if (!cur) return prev
            next.set(key, { ...cur, state: state === 'paused' ? 'paused' : 'running' })
            return next
          })
          if (state === 'canceled') {
            setTransfers((rows) =>
              [
                {
                  key: `t${++seq.current}`,
                  direction: (d.direction as 'send' | 'recv') ?? 'send',
                  deviceName: (d.device_name as string) ?? '',
                  name: (d.name as string) ?? '',
                  itemKind: ((d.item_kind as ItemKind) ?? 'file') as ItemKind,
                  kind: 'canceled',
                  at: Date.now(),
                },
                ...rows,
              ].slice(0, 50),
            )
          }
          break
        }
        case 'transfer': {
          const d = data ?? {}
          const kind = (d.kind as string) ?? 'update'
          // 传输结束就移出"进行中"。recv_done 必须算在内，漏掉会让每收一个文件都留下永不消失的记录。
          if (kind === 'done' || kind === 'error' || kind === 'recv_done' || kind === 'canceled') {
            const key = (d.transfer_id as string) || `${d.device_id as string}|${d.name as string}`
            setActive((prev) => {
              if (!prev.has(key)) return prev
              const next = new Map(prev)
              next.delete(key)
              return next
            })
          }
          // start 只是用来让进度条立刻出现，本身没有信息量，不进历史列表。
          if (kind === 'start') break
          // 秒传那条通知的正文是守护进程拼的中文日志，不能直接显示。
          // code 是机器可读的，翻译在这边做。
          const code = d.code as string | undefined
          const row: TransferRow = {
            key: `t${++seq.current}`,
            direction: (d.direction as 'send' | 'recv') ?? 'recv',
            deviceName: (d.device_name as string) ?? '',
            name: (d.name as string) ?? '',
            itemKind: ((d.item_kind as ItemKind) ?? 'file') as ItemKind,
            kind,
            size: d.size as number | undefined,
            elapsedMs: d.elapsed_ms as number | undefined,
            error: d.error as string | undefined,
            skipped: d.skipped === true || code === 'instant_skip',
            at: Date.now(),
            // 从当前设备列表里取这条连接的路由，就地定格进这一行。
            relayed: devicesRef.current.find((x) => x.device_id === d.device_id)?.relayed,
          }
          // 一条既没有名字又没有错误的 recv_update 对用户毫无意义，
          // 只会在列表里堆一行空白。
          if (!row.name && !row.error) break
          if (kind === 'recv_done' && row.itemKind !== 'clip' && row.name) {
            // 同一条提示原地更新，连续收一整个文件夹也只占一条。
            toast.success(t('recvDoneToast', { name: row.name }), {
              id: 'xdev-recv',
              action: { label: t('openDownloadDir'), onClick: () => void openRecvFolder(t('openDownloadDirFailed')) },
            })
          }
          setTransfers((rows) => [row, ...rows].slice(0, 50))
          break
        }
        case 'clip': {
          const from = (data?.source_name as string) ?? t('unknownDevice')
          toast.success(t('clipReceived', { device: from }))
          break
        }
        // 只是信号——完整历史永远回头查一次，见 refreshClipSyncLog/
        // refreshClipConflicts 顶上的注释。
        case 'clip_sync':
          refreshClipSyncLog()
          break
        case 'clip_conflict':
          refreshClipConflicts()
          break
        case 'clip_ack':
          refresh()
          break
        case 'daemon_restarting':
          setAvailable(false)
          setDaemonError(t('daemonRestarting'))
          break
        case 'notice':
          if (data?.message) toast.message(String(data.message))
          break
      }
    })
  }, [refresh, refreshActive, refreshClipSyncLog, refreshClipConflicts, t])

  /**
   * 短码/配对码倒计时和链路延迟轮询共用一个每秒定时器：Go 侧只在连接状态变化时推 rtt_ms，稳定连接下延
   * 迟会停在旧值；三个独立 interval 会让该组件每秒重渲三次。窗口在后台时不 setState/发请求，回前台补
   * 一次 tick；这只是不刷新显示，码的有效期由守护进程判定。到点自动清码，避免对面输入已失效的码。
   * `available === true` 就建，与是否显示码无关。
   */
  useEffect(() => {
    if (!shortCode && !myCode) {
      setShortCodeLeft(0)
      setCodeLeft(0)
    }
    if (available !== true) return
    const tick = () => {
      if (shortCode) {
        const left = Math.max(0, Math.round((shortCode.expires_at - Date.now()) / 1000))
        setShortCodeLeft(left)
        if (left === 0) setShortCode(null)
      }
      if (myCode) {
        const left = Math.max(0, Math.round((myCode.expires_at - Date.now()) / 1000))
        setCodeLeft(left)
        if (left === 0) {
          setMyCode(null)
          setQrDataUrl('')
        }
      }
      void refresh()
    }
    tick()
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return
      tick()
    }, 1000)
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') tick()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [shortCode, myCode, available, refresh])

  // `?? []` 每次渲染都会造一个新数组，直接喂给下面的 useMemo 会让它每次都重算。
  // 设备列表变动很频繁（每条状态事件都会刷），所以这里也一并记忆化。
  const devices = useMemo(() => status?.devices ?? [], [status])
  const [deviceQuery, setDeviceQuery] = useState('')
  const [deviceState, setDeviceState] = useState('all')
  const [deviceType, setDeviceType] = useState('all')
  const [deviceSort, setDeviceSort] = useState('name')
  const [transferQuery, setTransferQuery] = useState('')
  const deviceSearch = useSmartSearch(devices, deviceSearcher, deviceQuery)
  const transferSearch = useSmartSearch(transfers, transferSearcher, transferQuery)

  // 主页一处搜全部：设备、传输、同步记录（功能格在下面渲染时并入）。
  const [hubQuery, setHubQuery] = useState('')
  const hubBoxRef = useRef<HTMLInputElement>(null)
  const hubResultsRef = useRef<HubSearchHandle>(null)
  const hubEntries = useMemo<HubEntry[]>(() => {
    const out: HubEntry[] = []
    for (const d of devices) {
      const on = ONLINE_STATES.has(d.state)
      out.push({
        key: `dev:${d.device_id}`,
        group: 'devices',
        title: d.name,
        sub: [t(`state.${d.state}`), d.rtt_ms !== undefined ? `${d.rtt_ms} ms` : ''].filter(Boolean).join(' · '),
        extra: `${d.state} ${d.type} ${tCommon(`searchType_${d.type}`)} ${tCommon(on ? 'search_online' : 'search_offline')} ${d.route ?? ''}`,
        tone: on ? 'ok' : undefined,
        icon: DEVICE_ICON[d.type] ?? Laptop,
      })
    }
    for (const r of transfers) {
      out.push({
        key: `xfer:${r.key}`,
        group: 'transfers',
        title: r.name,
        sub: r.direction === 'send' ? t('dirTo', { name: r.deviceName }) : t('dirFrom', { name: r.deviceName }),
        extra: `${r.kind} ${r.itemKind} ${r.error ?? ''}`,
        at: r.at,
        tone: r.kind === 'error' ? 'error' : undefined,
        icon: ITEM_ICON[r.itemKind] ?? FileIcon,
      })
    }
    clipSyncLog.forEach((e, i) => {
      const kind = t(CLIP_MIME_KIND[e.mime] ?? 'clipKind.generic')
      out.push({
        key: `sync:${i}`,
        group: 'synclog',
        title: e.ok ? t('clipSyncFrom', { device: e.device_name, kind }) : t('clipSyncFailedFrom', { device: e.device_name, kind }),
        sub: e.error,
        extra: e.mime,
        at: e.at,
        tone: e.ok ? 'ok' : 'error',
        icon: e.ok ? CheckCircle2 : Ban,
      })
    })
    return out
  }, [devices, transfers, clipSyncLog, t, tCommon])
  const hubSearch = useSmartSearch(hubEntries, hubSearcher, hubQuery)
  const deviceTypes = useMemo(() => [...new Set(devices.map((d) => d.type))].sort(), [devices])
  const visibleDevices = useMemo(() => {
    const rows = deviceSearch.items.filter((d) =>
      (deviceState === 'all' || (deviceState === 'online' ? ONLINE_STATES.has(d.state) : !ONLINE_STATES.has(d.state))) &&
      (deviceType === 'all' || d.type === deviceType))
    if (deviceSearch.active) return rows
    return rows.sort((a, b) => deviceSort === 'latency'
      ? (a.rtt_ms ?? Infinity) - (b.rtt_ms ?? Infinity) || a.name.localeCompare(b.name)
      : deviceSort === 'recent' ? b.paired_at - a.paired_at : a.name.localeCompare(b.name))
  }, [deviceSearch.items, deviceSearch.active, deviceState, deviceType, deviceSort])
  const online = useMemo(() => devices.filter((d) => ONLINE_STATES.has(d.state)), [devices])
  const detailDevice = visibleDevices.find((d) => d.device_id === detailDeviceId) ?? null

  /**
   * 默认选中第一台设备，避免右栏空白（与其它四个界面一致）。判据是"当前选中的还在不在列表里"，设备被
   * 撤销或掉线后也要自动落到第一台。
   */
  useEffect(() => {
    if (visibleDevices.length === 0) {
      if (detailDeviceId !== null) setDetailDeviceId(null)
      return
    }
    if (detailDeviceId !== null && visibleDevices.some((d) => d.device_id === detailDeviceId)) return
    setDetailDeviceId(visibleDevices[0].device_id)
  }, [visibleDevices, detailDeviceId])
  /** 传输中的条目。`[...active.values()]` 写在 JSX 里的话，倒计时每跳一秒
   *  都会重建一次这个数组——而它跟倒计时毫无关系。 */
  const activeTransfers = useMemo(() => [...active.values()], [active])

  /**
   * 本次发送的目标，唯一真相源：按钮文案、拖放、发送函数都读它。'one' 模式没选人就是空数组、发送按钮
   * 禁用，不兜底发给第一台——发错设备收不回来。
   */
  const sendTargets = useMemo(() => {
    if (fanout === 'one') {
      return soloTarget && online.some((d) => d.device_id === soloTarget) ? [soloTarget] : []
    }
    return [...selected].filter((id) => online.some((d) => d.device_id === id))
  }, [fanout, soloTarget, selected, online])

  // 只有一台在线设备时替用户把它选上——这时候"选哪台"根本不是个问题，
  // 让用户为唯一的选项点一下纯属多余。多于一台就不猜，必须他自己选。
  useEffect(() => {
    if (fanout !== 'one') return
    if (soloTarget && online.some((d) => d.device_id === soloTarget)) return
    setSoloTarget(online.length === 1 ? online[0].device_id : null)
  }, [fanout, online, soloTarget])

  /**
   * 配对成功后恢复配对面板。五条路径统一由 `paired` 事件触发：显示码的一端不调用任何配对函数，只能靠
   * 事件收起。还要 clear_short_code 作废码，否则信标仍在应答，留下看不见的入口。
   */
  /** 指标区秒级刷新。收起时不建定时器（不卡顿的硬指标），页面不可见时也不刷。 */
  useEffect(() => {
    if (!metricsOpen) return
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return
      setMetricsTick((n) => n + 1)
    }, 1000)
    return () => window.clearInterval(timer)
  }, [metricsOpen])

  /** 刷新率只在第一次展开指标区时测一次——没人看的时候没必要占着 rAF。 */
  useEffect(() => {
    if (!metricsOpen || refreshHz !== null) return
    let alive = true
    void measureRefreshRate().then((hz) => {
      if (alive) setRefreshHz(hz)
    })
    return () => {
      alive = false
    }
  }, [metricsOpen, refreshHz])

  const collapsePairingUi = useCallback(async () => {
    if (shortCodeRef.current) {
      try {
        await api.call('clear_short_code')
      } catch {
        /* 码本身也会到期，撤销失败不值得打断刚刚成功的配对 */
      }
    }
    setShortCode(null)
    setShortCodeLeft(0)
    setMyCode(null)
    setQrDataUrl('')
    setCodeLeft(0)
    setPeerShortCode('')
    setPeerCode('')
    setManualAddr('')
    setPairTab('digits')
  }, [])

  // 事件处理函数只在挂载时建立一次，直接闭包捕获 collapsePairingUi 会永远
  // 拿到第一版。用 ref 递最新的实现进去。
  const collapsePairingUiRef = useRef(collapsePairingUi)
  useEffect(() => {
    collapsePairingUiRef.current = collapsePairingUi
  }, [collapsePairingUi])

  // 同理：collapsePairingUi 要知道"现在到底有没有在显示短码"，但把 shortCode
  // 放进它的依赖里会让它每秒重建一次（倒计时每秒改 state）。
  const shortCodeRef = useRef(shortCode)
  useEffect(() => {
    shortCodeRef.current = shortCode
  }, [shortCode])

  /**
   * 生成 6 位短配对码，补二维码（需摄像头）、附近设备（需组播）、手动地址（需知道 IP）都不通时的空
   * 档。与「附近设备」同一套握手：短码只负责挑出设备，对方仍要点同意、两边核对安全码；短码不是凭据，
   * 不含密钥材料。
   */
  async function showShortCode() {
    setShortBusy(true)
    try {
      const res = await api.call<{ code: string; expires_at: number }>('show_short_code')
      setShortCode(res)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setShortBusy(false)
    }
  }

  async function stopShortCode() {
    try {
      await api.call('clear_short_code')
    } catch {
      /* 撤销失败不值得打扰用户：码本身也会到期自动失效 */
    }
    setShortCode(null)
  }

  async function pairWithShortCode() {
    const code = peerShortCode.replace(/\D/g, '')
    if (code.length !== 6) return
    setPairing(true)
    try {
      const peer = await api.call<Device>('pair_with_short_code', { code })
      toast.success(t('pairedWith', { name: peer.name }))
      setPeerShortCode('')
      await refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setPairing(false)
    }
  }

  async function showCode() {
    setBusy(true)
    try {
      const res = await api.call<{ code: string; fingerprint: string; expires_at: number }>('show_pairing_code', {
        mode: pairMode,
        ttl_sec: pairMode === 'temp' ? Number(tempTtl) : 0,
      })
      setMyCode(res)
      // 二维码直接在渲染进程生成：配对码里只有公钥和一次性令牌，
      // 不含任何私钥，不需要绕到主进程去。
      setQrDataUrl(await QRCode.toDataURL(res.code, { width: 260, margin: 1, errorCorrectionLevel: 'M' }))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  /**
   * 合并 mDNS 与扫描两路结果并按 device_id 去重；后来者覆盖旧的，因为地址更新（地址过期是"看得到连不
   * 上"的主因）。
   */
  const mergeNearby = useCallback((found: NearbyDevice[], via: 'mdns' | 'scan') => {
    setNearby((prev) => {
      const byId = new Map(prev.map((d) => [d.device_id, d]))
      for (const d of found) byId.set(d.device_id, { ...d, via })
      return [...byId.values()]
    })
  }, [])

  /**
   * 刷新附近设备；拿到空列表时自动接着扫描。mDNS 组播最易被丢（AP 隔离、企业 Wi-Fi、Windows 默认拒收
   * 入站 UDP），这类网络里被动列表永远为空，而主动扫描能绕开。
   */
  const refreshNearby = useCallback(
    async (autoScan = true) => {
      setNearbyBusy(true)
      let empty = false
      try {
        const res = await api.call<{ nearby: NearbyDevice[] }>('list_nearby')
        // 被动列表是权威的"当前还在广播的设备"，所以整份替换而不是合并——
        // 合并的话已经关机的设备会永远留在列表上。扫描结果随后再并进来。
        const found = (res.nearby ?? []).map((d) => ({ ...d, via: 'mdns' as const }))
        setNearby(found)
        empty = found.length === 0
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err))
      } finally {
        setNearbyBusy(false)
      }
      if (empty && autoScan) await scanLanRef.current()
    },
    [],
  )

  /**
   * 主动扫描局域网，给组播被丢的网络用：发定向广播加逐台单播，不依赖组播。耗时几秒，所以由按钮触发。
   */
  const scanLan = useCallback(async () => {
    setScanBusy(true)
    try {
      const res = await api.call<{ nearby: NearbyDevice[]; probed: number; subnets: string[] }>('lan_scan')
      mergeNearby(res.nearby ?? [], 'scan')
      setScanInfo({ probed: res.probed ?? 0, subnets: res.subnets ?? [] })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setScanBusy(false)
    }
  }, [mergeNearby])

  // refreshNearby 与 scanLan 互相引用会成依赖环，用 ref 传最新实现，免得合并两个函数。
  const scanLanRef = useRef(scanLan)
  useEffect(() => {
    scanLanRef.current = scanLan
  }, [scanLan])

  /**
   * 「附近设备」标签页开着时持续刷新，否则先打开的一端看到空列表后永远不会再查。被动列表（mDNS 缓存）
   * 便宜，3 秒一次；主动扫描要几秒、发几百个单播包，20 秒一次。切走标签即停。
   */
  useEffect(() => {
    if (pairTab !== 'nearby' || !available) return
    let stopped = false
    // 两条都加可见性防护：窗口在后台或最小化时不刷 mDNS 缓存，也不往全网段发扫描包。
    const passive = window.setInterval(() => {
      if (!stopped && document.visibilityState === 'visible') void refreshNearby(false)
    }, 3000)
    const active = window.setInterval(() => {
      if (!stopped && document.visibilityState === 'visible') void scanLanRef.current()
    }, 20000)
    return () => {
      stopped = true
      window.clearInterval(passive)
      window.clearInterval(active)
    }
  }, [pairTab, available, refreshNearby])

  /**
   * 与附近设备配对。无一次性令牌，安全靠对方点同意加两边核对安全码，所以列表里的名字必须标"未验证"（
   * 设备名可伪造）。地址一并传：扫描发现的设备不在守护进程 mDNS 缓存里，只给 device_id 会回"设备已不
   * 在附近"。
   */
  async function pairNearby(dev: NearbyDevice) {
    setPairing(true)
    try {
      const peer = await api.call<Device>('pair_nearby', {
        device_id: dev.device_id,
        address: dev.addrs?.[0] ?? '',
      })
      toast.success(t('pairedWith', { name: peer.name }))
      refresh()
      refreshNearby()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setPairing(false)
    }
  }

  /**
   * 手动输入地址配对：所有自动发现都失效时的最后一条路，只要 IP 能通即可，不依赖组播/广播/同网段。
   */
  async function pairWithAddress() {
    const address = manualAddr.trim()
    if (!address) return
    setPairing(true)
    try {
      const peer = await api.call<Device>('pair_with_address', { address })
      toast.success(t('pairedWith', { name: peer.name }))
      setManualAddr('')
      refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setPairing(false)
    }
  }

  /** 跑一遍连接自检。结论落在下面的诊断卡片里，同时把本机地址刷新一次。 */
  const runDiagnose = useCallback(async () => {
    setDiagBusy(true)
    try {
      const rep = await api.call<DiagReport>('net_diagnose')
      setDiag(rep)
      setEndpoints(rep.endpoints ?? [])
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setDiagBusy(false)
    }
  }, [])

  /** 请求给守护进程加防火墙入站放行。**会弹 UAC**，所以只在用户点按钮时调。 */
  async function fixFirewall() {
    setFirewallBusy(true)
    try {
      const res = await api.firewallAllow()
      if (res.ok) {
        toast.success(t('firewallFixed'))
        setFirewall('allowed')
        void runDiagnose()
      } else {
        // 最常见的"失败"是用户在 UAC 上点了否。他刚亲手拒绝的事情不该再被
        // 报一次错，所以这里只是安静地把状态刷回去。
        const st = await api.firewallStatus()
        setFirewall(st.state)
        if (st.state !== 'allowed') toast.message(t('firewallNotGranted'))
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setFirewallBusy(false)
    }
  }

  async function pairWithCode() {
    const code = parsePairInput(peerCode)
    if (!code) return
    setPairing(true)
    try {
      const peer = await api.call<Device>('pair_with_code', { code })
      toast.success(t('pairedWith', { name: peer.name }))
      setPeerCode('')
      refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setPairing(false)
    }
  }

  async function respondPair(accept: boolean) {
    if (!pairReq) return
    const req = pairReq
    setPairReq(null)
    try {
      await api.call('pair_respond', {
        request_id: req.request_id,
        accept,
        mode: pairMode,
        ttl_sec: pairMode === 'temp' ? Number(tempTtl) : 0,
      })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  async function respondTransfer(accept: boolean) {
    if (!xferReq) return
    const req = xferReq
    setXferReq(null)
    try {
      await api.call('transfer_respond', { request_id: req.request_id, accept })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  /**
   * 队列结果回话：报守护进程展开后的真实文件数而非用户选的项数（选文件夹时差很大）；skipped 是空文件
   * 夹和读不了的路径，必须说明，否则用户不知道哪步出了岔子。
   */
  function reportQueued(res: QueueResult, devices: number) {
    if (res.files) toast.success(t('filesQueued', { files: res.files, devices }))
    if (res.skipped?.length) {
      toast.warning(t('filesSkipped', { names: res.skipped.join('、'), count: res.skipped.length }))
    }
  }

  async function sendFiles() {
    // 允许选文件夹：协议一次只发一个文件，展开由守护进程做，这里只交路径。
    const paths = await electronApi.openFiles({
      properties: ['openFile', 'openDirectory', 'multiSelections'],
    })
    if (!paths?.length) return
    const targets = sendTargets
    if (targets.length === 0) {
      toast.error(online.length === 0 ? t('noOnlineDevices') : t('pickTargetFirst'))
      return
    }
    try {
      const res = await api.call<QueueResult>('send_files', { paths, device_ids: targets })
      reportQueued(res, targets.length)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  /**
   * 把拖入的文件直接发出。路径必须用 electronApi.getPathForFile：Electron 32 起 File.path 被移除，读
   * 到 undefined 就是"拖进去没反应"。目标读 sendTargets，与「发送文件」按钮同源，避免按钮发给 A、拖放
   * 发给所有人。
   */
  async function handleDrop(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault()
    setDragOver(false)
    const paths = Array.from(event.dataTransfer.files).map((f) => electronApi.getPathForFile(f))
    if (paths.length === 0) return

    const targets = sendTargets
    if (targets.length === 0) {
      toast.error(online.length === 0 ? t('noOnlineDevices') : t('pickTargetFirst'))
      return
    }
    try {
      const res = await api.call<QueueResult>('send_files', { paths, device_ids: targets })
      reportQueued(res, targets.length)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  /** 某台设备的信息在别处被改了（同步范围），把它换进列表，不必整页重拉。 */
  function updateDevice(next: Device) {
    setStatus((s) =>
      s ? { ...s, devices: s.devices.map((d) => (d.device_id === next.device_id ? { ...d, ...next } : d)) } : s,
    )
  }

  async function revoke(d: Device) {
    try {
      await api.call('revoke_device', { device_id: d.device_id })
      toast.success(t('deviceRevoked', { name: d.name }))
      refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  /** 改本机设备名。无需重连：名字随下一个心跳（≤10 秒）带给已连接设备；重连会打断进行中的传输。 */
  async function saveDeviceName() {
    const name = draftName.trim()
    if (!name || name === status?.name) {
      setRenamingDevice(false)
      return
    }
    setBusy(true)
    try {
      const res = await api.call<{ name: string }>('set_device_name', { name })
      setStatus((s) => (s ? { ...s, name: res.name } : s))
      setRenamingDevice(false)
      toast.success(t('deviceRenamed', { name: res.name }))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function openRecvFolder(failureMessage: string) {
    try {
      const result = await api.openDownloadDir()
      if (!result.ok) toast.error(failureMessage)
    } catch {
      toast.error(failureMessage)
    }
  }

  /** 挑接收目录；Go 侧先试写探针文件，只读盘/已拔出的 U 盘当场报错，免得传完才失败。 */
  async function pickDownloadDir() {
    const picked = await electronApi.openDirectory({ title: t('changeDownloadDirTitle') })
    if (!picked) return
    setBusy(true)
    try {
      const opts = await api.call<Options>('set_options', { download_dir: picked })
      setStatus((s) => (s ? { ...s, options: opts } : s))
      toast.success(t('downloadDirChanged', { path: picked }))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  // 存档里的中转点地址回填到输入框。只在用户没在编辑时回填，
  // 否则每次 status 刷新（几秒一次）都会把他正打的字冲掉。
  const savedRvAddr = status?.options.rendezvous_addr ?? ''
  useEffect(() => {
    if (document.activeElement?.id !== 'rv-addr') setRvAddr(savedRvAddr)
  }, [savedRvAddr])

  async function setOption(patch: Record<string, unknown>) {
    try {
      const opts = await api.call<Options>('set_options', patch)
      setStatus((s) => (s ? { ...s, options: opts } : s))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  /** 保存中转点设置。地址校验在 Go 侧做，填错会当场报错——
   *  好过让用户以为配好了、然后对着一个永远连不上的跨网干着急。 */
  async function saveCrossnet() {
    const addr = rvAddr.trim()
    if (!addr) return
    const patch: Record<string, unknown> = { rendezvous_addr: addr }
    // 口令框空着时**不提交这个键**，这样"只想改地址"不会把已经存好的口令抹掉。
    if (rvSecret) patch.rendezvous_secret = rvSecret
    setBusy(true)
    try {
      const opts = await api.call<Options>('set_options', patch)
      setStatus((s) => (s ? { ...s, options: opts } : s))
      setRvSecret('')
      toast.success(t('crossnetSaved', { addr }))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function disableCrossnet() {
    setBusy(true)
    try {
      const opts = await api.call<Options>('set_options', {
        rendezvous_addr: '',
        rendezvous_secret: '',
      })
      setStatus((s) => (s ? { ...s, options: opts } : s))
      setRvAddr('')
      setRvSecret('')
      toast.success(t('crossnetDisabled'))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  function toggleSelected(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  if (available === false) {
    return (
      // 不开 fill：fill 表示本页不滚、高度分给内部各块，只适用于双栏工作台；这里开了会钉死在一屏里裁掉内
      // 容。此处在 `return (` 之后，只能用 `//`，`{/* */}` 会被当成对象字面量而语法错误。
      <PageShell width="canvas">
        <PageHeader title={t('pageTitle')} />
        <Alert variant="destructive">
          <AlertDescription>
            {t('unavailable')}
            {daemonError ? ` (${daemonError})` : ''}
          </AlertDescription>
        </Alert>
        <div>
          <Button variant="outline" onClick={refresh}>
            <RefreshCw className="size-4" />
            {t('retry')}
          </Button>
        </div>
      </PageShell>
    )
  }

  if (available === null || !status) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" />
        {t('starting')}
      </div>
    )
  }

  // 实时指标的当前读数。metricsTick 每秒 +1 触发重算；指标区收起时那个定时器
  // 压根不启动，所以这一段在绝大多数时候一秒都不会跑。
  void metricsTick
  const { up: upSpeed, down: downSpeed } = currentSpeeds(active.values())
  const totals = sessionCounter.current.totals()
  const rtt = bestRttMs(devices, ONLINE_STATES)
  const metricCards: { label: string; value: string }[] = [
    { label: t('metricOnlineDevices'), value: `${online.length} / ${devices.length}` },
    { label: t('metricLinkRtt'), value: rtt === null ? t('metricUnavailable') : `${rtt} ms` },
    { label: t('metricThroughput'), value: `↑ ${humanSize(upSpeed)}/s  ↓ ${humanSize(downSpeed)}/s` },
    { label: t('metricSessionTotal'), value: `↑ ${humanSize(totals.sentBytes)}  ↓ ${humanSize(totals.recvBytes)}` },
    { label: t('metricListenPort'), value: status?.port ? String(status.port) : t('metricUnavailable') },
    { label: t('metricLocalAddresses'), value: `${endpoints.length}${endpoints[0] ? ` · ${endpoints[0]}` : ''}` },
    { label: t('metricDiscovered'), value: String(nearby.length) },
    { label: t('metricCpuCores'), value: String(navigator.hardwareConcurrency || 0) },
    {
      label: t('metricDisplayRefresh'),
      value: refreshHz === null ? t('metricUnavailable') : `${refreshHz} Hz`,
    },
  ]

  const errorRows = transfers.filter((r) => r.kind === 'error').length
  const tiles: FeatureTileSpec[] = [
    {
      id: 'devices',
      icon: MonitorSmartphone,
      title: t('tileDevices'),
      badge: t('badgeOnline', { online: online.length, total: devices.length }),
    },
    {
      id: 'pair',
      icon: QrCode,
      title: t('tilePair'),
      badge: nearby.length > 0 ? t('badgeNearby', { count: nearby.length }) : t('badgeNearbyNone'),
    },
    {
      id: 'clipboard',
      icon: History,
      title: t('tileClipboard'),
      badge: status.options.clip_sync ? t('badgeAutoOn') : t('badgeAutoOff'),
      attention: !status.options.clip_sync,
    },
    {
      id: 'activity',
      icon: Activity,
      title: t('tileActivity'),
      badge:
        errorRows > 0
          ? t('badgeFailed', { count: errorRows })
          : transfers.length > 0
            ? t('badgeCount', { count: transfers.length })
            : t('badgeEmpty'),
      attention: errorRows > 0,
    },
    {
      id: 'synclog',
      icon: GitFork,
      title: t('tileSyncLog'),
      badge:
        clipConflicts.length > 0
          ? t('badgeConflicts', { count: clipConflicts.length })
          : clipSyncLog.length > 0
            ? t('badgeCount', { count: clipSyncLog.length })
            : t('badgeEmpty'),
      attention: clipConflicts.length > 0,
    },
    {
      id: 'metrics',
      icon: Gauge,
      title: t('tileMetrics'),
      badge: rtt === null ? t('metricUnavailable') : `${rtt} ms`,
    },
    {
      id: 'diag',
      icon: Stethoscope,
      title: t('tileDiag'),
      badge:
        firewall === 'blocked'
          ? t('badgeFirewallBlocked')
          : firewall === 'allowed'
            ? t('badgeFirewallOk')
            : t('firewallState.unknown'),
      attention: firewall === 'blocked',
    },
    {
      id: 'crossnet',
      icon: Globe,
      title: t('tileCrossnet'),
      badge: status.options.rendezvous_addr ? t('badgeOn') : t('badgeOff'),
    },
    {
      id: 'options',
      icon: SlidersHorizontal,
      title: t('tileOptions'),
      badge: status.options.auto_accept ? t('badgeAutoAccept') : t('badgeAskAccept'),
    },
    {
      id: 'self',
      icon: Monitor,
      title: t('thisDevice'),
      badge: status.port ? `${t('listeningPort')} ${status.port}` : status.name,
    },
  ]
  const panelTile = tiles.find((x) => x.id === panel) ?? null

  const tileHits = hubSearch.active
    ? hubSearcher.search(tiles.map((x) => ({ key: `tile:${x.id}`, group: 'features', title: x.title, sub: x.badge, icon: x.icon })), hubQuery)
    : null
  const hubResult = tileHits
    ? {
        ...hubSearch,
        items: [...hubSearch.items, ...tileHits.items],
        approximate: hubSearch.approximate && tileHits.approximate,
        ranges: (e: HubEntry, f: string) => hubSearch.ranges(e, f) ?? tileHits.ranges(e, f),
      }
    : hubSearch
  const hubGroups: HubGroup[] = [
    { id: 'devices', label: t('tileDevices'), icon: MonitorSmartphone },
    { id: 'transfers', label: t('tileActivity'), icon: Activity },
    { id: 'synclog', label: t('tileSyncLog'), icon: GitFork },
    { id: 'features', label: tCommon('searchGroupFeatures'), icon: LayoutGrid },
  ]

  function openHubEntry(e: HubEntry, el: HTMLElement) {
    const at = e.key.indexOf(':')
    const kind = e.key.slice(0, at)
    const id = e.key.slice(at + 1)
    if (kind === 'tile') return openPanel(id, el)
    if (kind === 'dev') {
      setDeviceQuery('')
      setDeviceState('all')
      setDeviceType('all')
      setDetailDeviceId(id)
      return openPanel('devices', el)
    }
    if (kind === 'xfer') {
      setTransferQuery(`"${e.title}"`)
      return openPanel('activity', el)
    }
    openPanel('synclog', el)
  }

  function openPanel(id: string, el: HTMLElement) {
    const root = rootRef.current
    if (root) {
      const r = el.getBoundingClientRect()
      const b = root.getBoundingClientRect()
      setPanelOrigin({ x: r.left - b.left + r.width / 2, y: r.top - b.top + r.height / 2 })
    } else {
      setPanelOrigin(null)
    }
    if (id === 'pair') void refreshNearby()
    setPanel(id)
  }

  const transferRows = activeTransfers.map((a) => {
    const ItemIcon = ITEM_ICON[a.itemKind] ?? FileIcon
    const eta = etaSeconds(a)
    return (
      <div key={a.key} className="space-y-1.5">
        <div className="flex items-center gap-2 text-sm">
          <ItemIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate font-medium" title={a.name}>
            {a.name}
          </span>
          <span className="shrink-0 text-sm text-muted-foreground">
            {a.direction === 'send' ? t('dirTo', { name: a.deviceName }) : t('dirFrom', { name: a.deviceName })}
          </span>
          <span className="shrink-0 tabular text-sm text-muted-foreground">
            {a.state === 'paused'
              ? t('transferPaused')
              : [
                  a.speed > 0 ? t('transferSpeed', { rate: humanSize(a.speed) }) : null,
                  eta !== null ? t('transferEta', { time: humanDuration(eta) }) : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
          </span>
          <span className="w-12 shrink-0 text-right tabular text-sm font-semibold">{a.percent}%</span>
          <div className="flex shrink-0 items-center gap-0.5">
            <Button
              size="sm"
              variant="ghost"
              className="size-7 p-0"
              aria-label={a.state === 'paused' ? t('resumeTransfer') : t('pauseTransfer')}
              onClick={() => controlTransfer(a.key, a.state === 'paused' ? 'resume' : 'pause')}
            >
              {a.state === 'paused' ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="size-7 p-0 text-muted-foreground hover:text-destructive"
              aria-label={t('cancelTransfer')}
              onClick={() => controlTransfer(a.key, 'cancel')}
            >
              <X className="size-3.5" />
            </Button>
          </div>
        </div>
        <Progress value={a.percent} className={cn('h-1.5', a.state === 'paused' && 'opacity-50')} />
      </div>
    )
  })

  const renderPanel = (id: string): { body: React.ReactNode; actions?: React.ReactNode; fill?: boolean } => {
    switch (id) {
      case 'devices':
        return {
          fill: true,
          body: (
            <Workbench
              className="min-h-0 flex-1"
              selected={detailDevice !== null}
              onBack={() => setDetailDeviceId(null)}
              backLabel={tCommon('backToList')}
              placeholder={<EmptyState icon={MonitorSmartphone} title={t('deviceDetailEmpty')} className="m-6" />}
              detail={
                detailDevice && (
                  <DeviceDetailPane
                    device={detailDevice}
                    onRevoke={() => revoke(detailDevice)}
                    onUpdated={updateDevice}
                  />
                )
              }
              list={
                <div className="space-y-2 p-3">
                  <div className="sticky top-0 z-10 space-y-2 bg-background pb-2">
                    <SmartSearchBox scope="devices" value={deviceQuery} onChange={setDeviceQuery} placeholder={tCommon('searchDevices')} count={visibleDevices.length} approximate={deviceSearch.approximate}
                      fields={deviceSearcher.fields.map((f) => ({ key: f.key, token: f.key, label: tCommon(`searchField_${f.key}`) }))} />
                    <div className="grid grid-cols-3 gap-2">
                      <Select value={deviceState} onValueChange={setDeviceState}>
                        <SelectTrigger aria-label={tCommon('searchField_state')}><SelectValue /></SelectTrigger>
                        <SelectContent>{['all', 'online', 'offline'].map((v) => <SelectItem key={v} value={v}>{tCommon(`search_${v}`)}</SelectItem>)}</SelectContent>
                      </Select>
                      <Select value={deviceType} onValueChange={setDeviceType}>
                        <SelectTrigger aria-label={tCommon('searchField_type')}><SelectValue /></SelectTrigger>
                        <SelectContent><SelectItem value="all">{tCommon('search_all')}</SelectItem>{deviceTypes.map((v) => <SelectItem key={v} value={v}>{tCommon(`searchType_${v}`, { defaultValue: v })}</SelectItem>)}</SelectContent>
                      </Select>
                      <Select value={deviceSort} onValueChange={setDeviceSort}>
                        <SelectTrigger aria-label={tCommon('searchSort')}><SelectValue /></SelectTrigger>
                        <SelectContent>{['name', 'latency', 'recent'].map((v) => <SelectItem key={v} value={v}>{tCommon(`searchSort_${v}`)}</SelectItem>)}</SelectContent>
                      </Select>
                    </div>
                  </div>
                  {visibleDevices.length === 0 && <p className="text-sm text-muted-foreground">{t('noDevices')}</p>}
                  {visibleDevices.map((d) => {
                    const Icon = DEVICE_ICON[d.type] ?? Laptop
                    const isOnline = ONLINE_STATES.has(d.state)
                    return (
                      <div
                        key={d.device_id}
                        role="button"
                        tabIndex={0}
                        onClick={() => setDetailDeviceId(d.device_id)}
                        onKeyDown={(e) => e.key === 'Enter' && setDetailDeviceId(d.device_id)}
                        className={cn(
                          'ds-focus-ring flex cursor-pointer items-center gap-3 rounded-md border px-3 py-2 transition-colors',
                          isOnline ? 'border-border' : 'border-dashed opacity-70',
                          detailDeviceId === d.device_id && 'bg-accent-soft shadow-[inset_2px_0_0_var(--primary)]',
                        )}
                      >
                        {fanout === 'many' && (
                          <Checkbox
                            checked={selected.has(d.device_id)}
                            onClick={(e) => e.stopPropagation()}
                            onCheckedChange={() => toggleSelected(d.device_id)}
                            disabled={!isOnline}
                            aria-label={t('selectDevice', { name: d.name })}
                          />
                        )}
                        <Icon className="h-5 w-5 shrink-0 text-muted-foreground" />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="truncate font-medium"><Highlight text={d.name} ranges={deviceSearch.ranges(d, 'name')} /></span>
                            <span
                              className={cn(
                                'rounded px-1.5 py-0.5 text-2xs',
                                d.trust === 'temp' ? 'bg-amber-500/15 text-amber-600' : 'bg-muted text-muted-foreground',
                              )}
                            >
                              {d.trust === 'temp' ? t('trustTemp') : t('trustLong')}
                            </span>
                          </div>
                          <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                            {isOnline ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
                            <span>{t(`state.${d.state}`, { defaultValue: d.state })}</span>
                            {d.rtt_ms !== undefined && <span>· {d.rtt_ms} ms</span>}
                            {d.clip_latency_ms !== undefined && (
                              <span className="text-primary" data-hint={t('clipLatencyLabel')}>
                                · {t('clipLatencyBadge', { ms: d.clip_latency_ms })}
                              </span>
                            )}
                            {d.clip_latency_hist && d.clip_latency_hist.length >= 2 && (
                              <LatencySparkline points={d.clip_latency_hist} className="ml-1" />
                            )}
                            {d.expires_at && (
                              <span>
                                ·{' '}
                                {t('expiresIn', {
                                  minutes: Math.max(0, Math.round((d.expires_at - Date.now()) / 60000)),
                                })}
                              </span>
                            )}
                            {d.clip_policy && d.clip_policy !== 'all' && (
                              <span
                                className="inline-flex items-center"
                                aria-label={t(`policyClip.${d.clip_policy}`)}
                                data-hint={t(`policyClip.${d.clip_policy}`)}
                              >
                                {d.clip_policy === 'off' ? <Ban className="h-3 w-3" /> : <Type className="h-3 w-3" />}
                              </span>
                            )}
                          </div>
                        </div>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={(e) => {
                            e.stopPropagation()
                            revoke(d)
                          }}
                          aria-label={t('revoke')}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    )
                  })}
                </div>
              }
            />
          ),
        }

      case 'pair':
        return {
          body: (
            <div className="space-y-5">
              <div className="flex flex-wrap items-end gap-3">
                <div className="space-y-1">
                  <Label>{t('trustLevel')}</Label>
                  <Select value={pairMode} onValueChange={(v) => setPairMode(v as 'long' | 'temp')}>
                    <SelectTrigger className="w-[190px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="long">{t('trustLongDesc')}</SelectItem>
                      <SelectItem value="temp">{t('trustTempDesc')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {pairMode === 'temp' && (
                  <div className="space-y-1">
                    <Label>{t('validFor')}</Label>
                    <Select value={tempTtl} onValueChange={setTempTtl}>
                      <SelectTrigger className="w-[150px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="600">{t('ttl10m')}</SelectItem>
                        <SelectItem value="1800">{t('ttl30m')}</SelectItem>
                        <SelectItem value="3600">{t('ttl1h')}</SelectItem>
                        <SelectItem value="86400">{t('ttl1d')}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </div>

              <Tabs value={pairTab} onValueChange={setPairTab}>
                <TabsList className="flex h-auto w-full flex-wrap justify-start gap-1 p-1">
                  <TabsTrigger className="flex-none gap-1.5 px-3 py-1.5" value="digits">
                    <Hash className="size-4 shrink-0" aria-hidden="true" />
                    {t('tabShortCode')}
                  </TabsTrigger>
                  <TabsTrigger className="flex-none gap-1.5 px-3 py-1.5" value="show">
                    <QrCode className="size-4 shrink-0" aria-hidden="true" />
                    {t('tabShowCode')}
                  </TabsTrigger>
                  <TabsTrigger className="flex-none gap-1.5 px-3 py-1.5" value="enter">
                    <Keyboard className="size-4 shrink-0" aria-hidden="true" />
                    {t('tabEnterCode')}
                  </TabsTrigger>
                  <TabsTrigger className="flex-none gap-1.5 px-3 py-1.5" value="nearby" onClick={() => void refreshNearby()}>
                    <Radar className="size-4 shrink-0" aria-hidden="true" />
                    {t('tabNearby')}
                  </TabsTrigger>
                  <TabsTrigger className="flex-none gap-1.5 px-3 py-1.5" value="manual">
                    <Link2 className="size-4 shrink-0" aria-hidden="true" />
                    {t('tabManual')}
                  </TabsTrigger>
                </TabsList>

                <TabsContent value="digits" className="space-y-4 pt-3">
                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="space-y-3 rounded-xl border border-border bg-surface p-5">
                      <FeatureTitle as="p">{t('shortCodeShowTitle')}</FeatureTitle>
                      {!shortCode ? (
                        <Button onClick={showShortCode} disabled={shortBusy}>
                          {shortBusy ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Hash className="mr-2 size-4" />}
                          {t('shortCodeGenerate')}
                        </Button>
                      ) : (
                        <div className="space-y-2">
                          <p className="font-mono text-3xl font-semibold tracking-[0.35em] tabular">{shortCode.code}</p>
                          <p className="text-sm text-muted-foreground tabular">
                            {shortCodeLeft >= 60
                              ? t('codeExpiresInMinutes', {
                                  minutes: Math.floor(shortCodeLeft / 60),
                                  seconds: shortCodeLeft % 60,
                                })
                              : t('codeExpiresIn', { seconds: shortCodeLeft })}
                          </p>
                          <Button size="sm" variant="outline" onClick={stopShortCode}>
                            {t('shortCodeStop')}
                          </Button>
                        </div>
                      )}
                    </div>
                    <div className="space-y-3 rounded-xl border border-border bg-surface p-5">
                      <FeatureTitle as="p">{t('shortCodeEnterTitle')}</FeatureTitle>
                      <Input
                        value={peerShortCode}
                        onChange={(e) => setPeerShortCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                        onKeyDown={(e) => e.key === 'Enter' && void pairWithShortCode()}
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        placeholder="000000"
                        aria-label={t('shortCodeEnterTitle')}
                        className="h-14 text-center font-mono text-3xl font-semibold tracking-[0.35em] tabular"
                      />
                      <Button
                        className="w-full"
                        onClick={() => void pairWithShortCode()}
                        disabled={pairing || peerShortCode.length !== 6}
                      >
                        {pairing ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Link2 className="mr-2 size-4" />}
                        {t('pairNow')}
                      </Button>
                    </div>
                  </div>
                </TabsContent>

                <TabsContent value="show" className="space-y-3 pt-3">
                  {!myCode ? (
                    <Button onClick={showCode} disabled={busy}>
                      {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                      {t('generateCode')}
                    </Button>
                  ) : (
                    <div className="flex flex-col items-center gap-3">
                      {qrDataUrl && (
                        <img
                          src={qrDataUrl}
                          alt={t('qrAlt')}
                          className="rounded-md border bg-white p-2"
                          width={260}
                          height={260}
                        />
                      )}
                      <p className="text-sm text-muted-foreground">
                        {codeLeft >= 60
                          ? t('codeExpiresInMinutes', { minutes: Math.floor(codeLeft / 60), seconds: codeLeft % 60 })
                          : t('codeExpiresIn', { seconds: codeLeft })}
                      </p>
                      <p className="font-mono text-sm">
                        {t('fingerprint')}: {myCode.fingerprint}
                      </p>
                      <div className="flex flex-wrap justify-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            void copyText(myCode.code).then((ok) => ok && toast.success(t('codeCopied')))
                          }}
                        >
                          <Copy className="mr-2 h-4 w-4" />
                          {t('copyCode')}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            void copyText(buildPairLink(myCode.code)).then(
                              (ok) => ok && toast.success(t('pairLinkCopied')),
                            )
                          }}
                        >
                          <Link2 className="mr-2 h-4 w-4" />
                          {t('copyPairLink')}
                        </Button>
                        <Button variant="outline" size="sm" onClick={showCode} disabled={busy}>
                          {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                          {t('refreshCode')}
                        </Button>
                      </div>
                    </div>
                  )}
                </TabsContent>

                <TabsContent value="enter" className="space-y-3 pt-3">
                  <Label htmlFor="peer-code">{t('peerCodeLabel')}</Label>
                  <Input
                    id="peer-code"
                    value={peerCode}
                    onChange={(e) => setPeerCode(e.target.value)}
                    placeholder="CB1:...  /  tessera://pair?c=..."
                    className="font-mono text-sm"
                  />
                  <Button onClick={pairWithCode} disabled={pairing || !peerCode.trim()}>
                    {pairing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Link2 className="mr-2 h-4 w-4" />}
                    {t('pairNow')}
                  </Button>
                </TabsContent>

                <TabsContent value="nearby" className="space-y-2 pt-3">
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void refreshNearby()}
                      disabled={nearbyBusy || scanBusy}
                    >
                      {nearbyBusy ? <Loader2 className="mr-2 size-4 animate-spin" /> : <RefreshCw className="mr-2 size-4" />}
                      {t('refresh')}
                    </Button>
                    <Button size="sm" onClick={scanLan} disabled={scanBusy}>
                      {scanBusy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Radar className="mr-2 h-4 w-4" />}
                      {t('scanLan')}
                    </Button>
                  </div>
                  {nearby.length === 0 ? (
                    <div className="flex items-center justify-center gap-2 rounded-xl border border-dashed p-8 text-sm text-muted-foreground">
                      {scanBusy ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <Radar className="size-4" aria-hidden="true" />}
                      {scanBusy ? t('scanning') : t('nearbyEmpty')}
                      {!scanBusy && <InfoHint text={t('nearbyEmptyHint')} />}
                    </div>
                  ) : (
                    nearby.map((d) => {
                      const Icon = DEVICE_ICON[d.type] ?? Laptop
                      return (
                        <div key={d.device_id} className="flex items-center gap-3 rounded-md border px-3 py-2">
                          <Icon className="size-5 shrink-0 text-muted-foreground" />
                          <div className="min-w-0 flex-1">
                            <div className="truncate font-medium">{d.name}</div>
                            <div className="flex flex-wrap items-center gap-x-2 text-sm">
                              {!d.paired && (
                                <span className="text-amber-600 dark:text-amber-500">{t('nearbyUnverified')}</span>
                              )}
                              {d.addrs?.[0] && <span className="font-mono text-muted-foreground">{d.addrs[0]}</span>}
                            </div>
                          </div>
                          {d.paired ? (
                            <span className="flex shrink-0 items-center gap-1.5 rounded-md bg-emerald-500/10 px-2.5 py-1.5 text-sm font-medium text-emerald-600 dark:text-emerald-400">
                              <CheckCircle2 className="size-3.5" />
                              {t('nearbyAlreadyPaired')}
                            </span>
                          ) : (
                            <Button size="sm" onClick={() => pairNearby(d)} disabled={pairing}>
                              {pairing ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Link2 className="mr-2 size-4" />}
                              {t('pairNow')}
                            </Button>
                          )}
                        </div>
                      )
                    })
                  )}
                  {scanInfo && (
                    <p className="text-sm text-muted-foreground">
                      {t('scanSummary', { probed: scanInfo.probed, subnets: scanInfo.subnets.join('、') || '—' })}
                    </p>
                  )}
                </TabsContent>

                <TabsContent value="manual" className="space-y-3 pt-3">
                  <div className="space-y-1.5">
                    <Label>{t('myAddressLabel')}</Label>
                    {endpoints.length === 0 ? (
                      <p className="text-sm text-muted-foreground">{t('myAddressUnknown')}</p>
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        {endpoints.map((addr) => (
                          <Button
                            key={addr}
                            size="sm"
                            variant="outline"
                            className="font-mono text-sm"
                            onClick={() => {
                              void copyText(addr).then((ok) => ok && toast.success(t('addressCopied')))
                            }}
                          >
                            <Copy className="mr-2 h-3.5 w-3.5" />
                            {addr}
                          </Button>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="manual-addr">{t('peerAddressLabel')}</Label>
                    <Input
                      id="manual-addr"
                      value={manualAddr}
                      onChange={(e) => setManualAddr(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && pairWithAddress()}
                      placeholder="192.168.1.23"
                      className="font-mono text-sm"
                    />
                  </div>
                  <Button onClick={pairWithAddress} disabled={pairing || !manualAddr.trim()}>
                    {pairing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Link2 className="mr-2 h-4 w-4" />}
                    {t('pairNow')}
                  </Button>
                </TabsContent>
              </Tabs>
            </div>
          ),
        }

      case 'clipboard':
        return { fill: true, body: <ClipTimelinePanel available={available === true} variant="fill" /> }

      case 'activity':
        return {
          actions: <>
            <SmartSearchBox scope="transfers" value={transferQuery} onChange={setTransferQuery} placeholder={tCommon('searchTransfers')} count={transferSearch.items.length} approximate={transferSearch.approximate}
              fields={transferSearcher.fields.map((f) => ({ key: f.key, token: f.key, label: tCommon(`searchField_${f.key}`) }))} />
            {transfers.length > 0 ? (
              <>
                <label className="flex cursor-pointer items-center gap-1.5 text-sm text-muted-foreground">
                  <Checkbox
                    checked={transferSearch.items.length > 0 && transferSearch.items.every((r) => pickedRows.has(r.key))}
                    onCheckedChange={(v) =>
                      setPickedRows(v === true ? new Set(transferSearch.items.map((r) => r.key)) : new Set())
                    }
                    aria-label={t('activitySelectAll')}
                  />
                  {t('activitySelectAll')}
                </label>
                {pickedRows.size > 0 && (
                  <Button size="sm" variant="outline" onClick={deletePickedRows}>
                    <Trash2 className="mr-2 size-4" />
                    {t('activityDeleteSelected', { count: pickedRows.size })}
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={clearAllRows}>
                  {t('activityClearAll')}
                </Button>
              </>
            ) : null}</>,
          body:
            transferSearch.items.length === 0 ? (
              <EmptyState icon={Activity} title={t('badgeEmpty')} className="h-full" />
            ) : (
              <div className="space-y-1 rounded-xl border bg-card p-2">
                {transferSearch.items.map((r) => {
                  const ItemIcon = ITEM_ICON[r.itemKind] ?? FileIcon
                  return (
                    <label
                      key={r.key}
                      className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted/50"
                    >
                      <Checkbox
                        checked={pickedRows.has(r.key)}
                        onCheckedChange={() => toggleRow(r.key)}
                        aria-label={t('activitySelectRow', { name: r.name })}
                      />
                      {r.kind === 'error' ? (
                        <Ban className="size-4 shrink-0 text-destructive" />
                      ) : r.kind === 'canceled' ? (
                        <X className="size-4 shrink-0 text-muted-foreground" />
                      ) : r.kind === 'done' || r.kind === 'recv_done' ? (
                        <CheckCircle2 className="size-4 shrink-0 text-emerald-500" />
                      ) : (
                        <ItemIcon className="size-4 shrink-0 text-muted-foreground" />
                      )}
                      <span className="truncate" title={r.name}>
                        <Highlight text={r.name} ranges={transferSearch.ranges(r, 'file')} />
                      </span>
                      <span className="shrink-0 text-sm text-muted-foreground">
                        {r.direction === 'send' ? t('dirTo', { name: r.deviceName }) : t('dirFrom', { name: r.deviceName })}
                        {r.size ? ` · ${humanSize(r.size)}` : ''}
                        {r.elapsedMs ? ` · ${r.elapsedMs} ms` : ''}
                      </span>
                      {r.kind === 'canceled' && (
                        <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-2xs text-muted-foreground">
                          {t('transferCanceled')}
                        </span>
                      )}
                      {r.skipped && (
                        <span className="shrink-0 rounded bg-emerald-500/10 px-1.5 py-0.5 text-2xs text-emerald-600 dark:text-emerald-400">
                          {t('instantSkip')}
                        </span>
                      )}
                      {r.error && <span className="truncate text-sm text-destructive">{r.error}</span>}
                      {r.relayed !== undefined && (r.kind === 'done' || r.kind === 'recv_done') && (
                        <span
                          className={cn(
                            'shrink-0 rounded px-1.5 py-0.5 text-2xs',
                            r.relayed ? 'bg-warning/12 text-warning' : 'bg-success/12 text-success',
                          )}
                          data-hint={r.relayed ? t('receiptRelayedHint') : t('receiptDirectHint')}
                        >
                          {r.relayed ? t('receiptRelayed') : t('receiptDirect')}
                        </span>
                      )}
                    </label>
                  )
                })}
              </div>
            ),
        }

      case 'synclog':
        return {
          body:
            clipConflicts.length === 0 && clipSyncLog.length === 0 ? (
              <EmptyState icon={GitFork} title={t('badgeEmpty')} className="h-full" />
            ) : (
              <div className="grid gap-5 xl:grid-cols-2">
                {clipConflicts.length > 0 && (
                  <div className="space-y-2">
                    <h4 className="text-sm font-medium text-muted-foreground">{t('clipConflictsTitle')}</h4>
                    {clipConflicts
                      .slice()
                      .reverse()
                      .map((c, i) => (
                        <div
                          key={`${c.device_id}-${c.at}-${i}`}
                          data-hint={t('clipConflictHint')}
                          className="flex items-center gap-2 rounded-lg border border-warning/30 bg-warning/5 px-3 py-2.5 text-sm"
                        >
                          <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-2xs font-medium">
                            {t('thisDevice')}
                          </span>
                          <GitFork className="size-4 shrink-0 rotate-180 text-warning" aria-hidden="true" />
                          <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-2xs font-medium">
                            {c.device_name}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-muted-foreground">
                            {t('clipConflictLine', { device: c.device_name })}
                          </span>
                          <span className="shrink-0 text-2xs text-muted-foreground tabular">
                            {new Date(c.at).toLocaleTimeString()}
                          </span>
                        </div>
                      ))}
                  </div>
                )}
                {clipSyncLog.length > 0 && (
                  <div className="space-y-2">
                    <h4 className="text-sm font-medium text-muted-foreground">{t('clipSyncHistory')}</h4>
                    <div className="space-y-1 rounded-xl border bg-card p-2">
                      {clipSyncLog
                        .slice()
                        .reverse()
                        .map((e, i) => {
                          const kind = t(CLIP_MIME_KIND[e.mime] ?? 'clipKind.generic')
                          return (
                            <div
                              key={`${e.item_id}-${e.mime}-${e.at}-${i}`}
                              className="flex items-center gap-2 rounded-md px-2 py-1 text-sm"
                            >
                              {e.ok ? (
                                <CheckCircle2 className="size-4 shrink-0 text-emerald-500" aria-hidden="true" />
                              ) : (
                                <Ban className="size-4 shrink-0 text-destructive" aria-hidden="true" />
                              )}
                              <span className="min-w-0 flex-1 truncate">
                                {e.ok
                                  ? t('clipSyncFrom', { device: e.device_name, kind })
                                  : t('clipSyncFailedFrom', { device: e.device_name, kind })}
                              </span>
                              {e.error && (
                                <span className="max-w-[40%] shrink-0 truncate text-2xs text-destructive" title={e.error}>
                                  {e.error}
                                </span>
                              )}
                              <span className="shrink-0 text-2xs text-muted-foreground tabular">
                                {new Date(e.at).toLocaleTimeString()}
                              </span>
                            </div>
                          )
                        })}
                    </div>
                  </div>
                )}
              </div>
            ),
        }

      case 'metrics':
        return {
          body: (
            <div className="grid auto-rows-fr gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {metricCards.map((m) => (
                <div key={m.label} className="flex flex-col justify-between rounded-xl border border-border/70 bg-card px-5 py-4">
                  <p className="text-sm text-muted-foreground">{m.label}</p>
                  <p className={cn('mt-2 font-mono text-sihao', NUMERIC_CLASS)}>{m.value}</p>
                </div>
              ))}
            </div>
          ),
        }

      case 'diag':
        return {
          actions: (
            <>
              {firewall === 'blocked' && (
                <Button size="sm" variant="outline" onClick={fixFirewall} disabled={firewallBusy}>
                  {firewallBusy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ShieldCheck className="mr-2 h-4 w-4" />}
                  {t('firewallFix')}
                </Button>
              )}
              <Button size="sm" onClick={runDiagnose} disabled={diagBusy}>
                {diagBusy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Stethoscope className="mr-2 h-4 w-4" />}
                {t('diagRun')}
              </Button>
            </>
          ),
          body: (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm">
                <ShieldCheck
                  className={cn(
                    'size-4',
                    firewall === 'allowed'
                      ? 'text-emerald-500'
                      : firewall === 'blocked'
                        ? 'text-amber-500'
                        : 'text-muted-foreground',
                  )}
                />
                <span className="text-muted-foreground">
                  {t(`firewallState.${firewall ?? 'unknown'}`, { defaultValue: t('firewallState.unknown') })}
                </span>
              </div>
              {diag && (
                <div className="space-y-1.5 rounded-xl border bg-card p-4">
                  {diag.checks.map((c) => (
                    <div key={c.id} className="flex items-start gap-2 text-sm">
                      {c.status === 'ok' ? (
                        <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-500" />
                      ) : c.status === 'info' ? (
                        <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                      ) : c.status === 'warn' ? (
                        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" />
                      ) : (
                        <Ban className="mt-0.5 size-4 shrink-0 text-destructive" />
                      )}
                      <div className="min-w-0">
                        <div>{t(`diag.${c.id}.${c.status}`, { ...c.values, defaultValue: c.id })}</div>
                        {(c.status === 'warn' || c.status === 'fail') && (
                          <div className="text-sm text-muted-foreground">
                            {t(`diag.${c.id}.fix`, { ...c.values, defaultValue: '' })}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ),
        }

      case 'crossnet':
        return {
          body: (
            <div className="max-w-3xl space-y-4">
              <div className="flex items-center gap-2 rounded-xl border bg-card px-4 py-3 text-sm">
                <Globe
                  className={cn('size-4 shrink-0', status.options.rendezvous_addr ? 'text-emerald-500' : 'text-muted-foreground')}
                  aria-hidden="true"
                />
                <span className="min-w-0 flex-1">
                  {status.options.rendezvous_addr
                    ? t('crossnetStatusOn', { addr: status.options.rendezvous_addr })
                    : t('crossnetStatusOff')}
                </span>
                <InfoHint text={t('crossnetExplain')} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="rv-addr" className="flex items-center gap-1.5">
                  {t('crossnetAddr')}
                  <InfoHint text={t('crossnetAddrHelp')} />
                </Label>
                <Input
                  id="rv-addr"
                  value={rvAddr}
                  onChange={(e) => setRvAddr(e.target.value)}
                  placeholder="example.com:47820"
                  spellCheck={false}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="rv-secret" className="flex items-center gap-1.5">
                  {t('crossnetSecret')}
                  <InfoHint text={t('crossnetSecretHelp')} />
                </Label>
                <Input
                  id="rv-secret"
                  type="password"
                  value={rvSecret}
                  onChange={(e) => setRvSecret(e.target.value)}
                  placeholder={status.options.rendezvous_secret_set ? '••••••••' : ''}
                  spellCheck={false}
                />
              </div>
              <label className="flex items-center gap-3 text-sm">
                <Checkbox
                  checked={status.options.relay_on_metered}
                  onCheckedChange={(v) => setOption({ relay_on_metered: v === true })}
                />
                <span className="font-medium">{t('crossnetMetered')}</span>
                <InfoHint text={t('crossnetMeteredDesc')} />
              </label>
              <div className="flex gap-2 pt-1">
                <Button onClick={saveCrossnet} disabled={busy || !rvAddr.trim()}>
                  {t('crossnetSave')}
                </Button>
                <Button variant="outline" onClick={disableCrossnet} disabled={busy || !status.options.rendezvous_addr}>
                  {t('crossnetDisable')}
                </Button>
              </div>
            </div>
          ),
        }

      case 'options':
        return {
          body: (
            <div className="max-w-3xl space-y-2">
              {(
                [
                  ['clip_sync', status.options.clip_sync, t('optClipSync'), t('optClipSyncDesc')],
                  ['clip_plain_only', status.options.clip_plain_only === true, t('optClipPlainOnly'), t('optClipPlainOnlyDesc')],
                  ['auto_accept', status.options.auto_accept, t('optAutoAccept'), t('optAutoAcceptDesc')],
                ] as const
              ).map(([key, on, label, desc]) => (
                <label
                  key={key}
                  className="flex cursor-pointer items-center gap-3 rounded-xl border bg-card px-4 py-3 text-sm hover:bg-surface"
                >
                  <Checkbox checked={on} onCheckedChange={(v) => setOption({ [key]: v === true })} />
                  <span className="min-w-0 flex-1 font-medium">{label}</span>
                  <InfoHint text={desc} />
                </label>
              ))}
              <div className="flex flex-wrap items-center gap-3 rounded-xl border bg-card px-4 py-3">
                <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <div className="min-w-[10rem] flex-1">
                  <div className="text-sm font-medium">{t('downloadDir')}</div>
                  <div className="truncate font-mono text-sm text-muted-foreground" title={status.options.download_dir}>
                    {status.options.download_dir}
                  </div>
                </div>
                <Button size="sm" onClick={() => void openRecvFolder(t('openDownloadDirFailed'))}>
                  <FolderOpen className="mr-2 size-4" />
                  {t('openDownloadDir')}
                </Button>
                <Button size="sm" variant="outline" onClick={pickDownloadDir} disabled={busy}>
                  {t('changeDownloadDir')}
                </Button>
              </div>
            </div>
          ),
        }

      case 'self':
        return {
          body: (
            <div className="grid max-w-4xl gap-3 text-sm sm:grid-cols-3">
              <div className="rounded-xl border bg-card px-5 py-4">
                <div className="text-muted-foreground">{t('deviceName')}</div>
                {renamingDevice ? (
                  <div className="flex items-center gap-1 pt-1">
                    <Input
                      value={draftName}
                      onChange={(e) => setDraftName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void saveDeviceName()
                        if (e.key === 'Escape') setRenamingDevice(false)
                      }}
                      autoFocus
                      maxLength={64}
                      className="h-8 text-sm"
                    />
                    <Button size="sm" className="h-8 px-2" onClick={saveDeviceName} disabled={busy}>
                      {t('save')}
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-center gap-1 pt-1">
                    <span className="truncate font-medium text-sihao">{status.name}</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="size-7 p-0"
                      aria-label={t('renameThisDevice')}
                      onClick={() => {
                        setDraftName(status.name)
                        setRenamingDevice(true)
                      }}
                    >
                      <Pencil className="size-3.5" />
                    </Button>
                  </div>
                )}
              </div>
              <div className="rounded-xl border bg-card px-5 py-4">
                <div className="text-muted-foreground">{t('fingerprint')}</div>
                <div className="break-all pt-1 font-mono text-sm">{status.fingerprint}</div>
              </div>
              <div className="rounded-xl border bg-card px-5 py-4">
                <div className="text-muted-foreground">{t('listeningPort')}</div>
                <div className="pt-1 font-mono text-sihao">{status.port}</div>
              </div>
            </div>
          ),
        }
    }
    return { body: null }
  }

  const current = panel ? renderPanel(panel) : null

  return (
    <div
      ref={rootRef}
      className="relative flex min-h-0 flex-1 flex-col overflow-hidden"
      onDragOver={(e) => {
        // 必须 preventDefault，否则浏览器按默认行为处理（打开文件），drop 根本不触发。
        e.preventDefault()
        if (!dragOver) setDragOver(true)
      }}
      onDragLeave={(e) => {
        // 只在真正离开整页时才收起，否则划过子元素边框会闪。
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false)
      }}
      onDrop={handleDrop}
    >
      <div className="ds-page-wash flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 pt-5 pb-6" aria-hidden={panel ? true : undefined}>
        {firewall === 'blocked' && (
          <Alert className="border-amber-500/40 bg-amber-500/10">
            <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-500" />
            <AlertDescription className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <span className="min-w-0 flex-1 text-sm">{t('firewallBlocked')}</span>
              <Button size="sm" onClick={fixFirewall} disabled={firewallBusy}>
                {firewallBusy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ShieldCheck className="mr-2 h-4 w-4" />}
                {t('firewallFix')}
              </Button>
            </AlertDescription>
          </Alert>
        )}

        <section className="relative shrink-0 overflow-hidden rounded-2xl border border-border/70 bg-card">
          <Send
            aria-hidden="true"
            className="pointer-events-none absolute -top-6 -right-6 size-40 -rotate-12 text-primary opacity-[0.05]"
          />
          <div className="relative grid gap-5 p-5 xl:grid-cols-[minmax(0,1fr)_auto] xl:items-center">
            <div className="flex min-w-0 items-center gap-4">
              <span className="ds-icon-chip relative size-14 rounded-2xl">
                <Monitor className="size-7" aria-hidden="true" />
                <span
                  className={cn(
                    'absolute -right-1 -bottom-1 size-3.5 rounded-full border-2 border-card',
                    online.length > 0 ? 'bg-emerald-500' : 'bg-muted-foreground/40',
                  )}
                />
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate font-heading text-sihao font-medium">{status.name}</div>
                <div className="mt-1 flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
                  {online.length === 0 ? (
                    <span>{t('heroNoDevice')}</span>
                  ) : (
                    online.map((d) => {
                      const Icon = DEVICE_ICON[d.type] ?? Laptop
                      return (
                        <span
                          key={d.device_id}
                          className="inline-flex max-w-[14rem] items-center gap-1.5 rounded-full border border-border/70 bg-surface px-2.5 py-0.5"
                          data-hint={d.rtt_ms !== undefined ? `${d.name} · ${d.rtt_ms} ms` : d.name}
                        >
                          <Icon className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
                          <span className="truncate">{d.name}</span>
                        </span>
                      )
                    })
                  )}
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2.5">
              <Button size="lg" variant="outline" onClick={() => void openRecvFolder(t('openDownloadDirFailed'))}>
                <FolderOpen className="size-5" aria-hidden="true" />
                {t('openDownloadDir')}
              </Button>
              <Button size="lg" className="h-12 rounded-xl px-5" onClick={() => setClipPickOpen(true)} disabled={online.length === 0}>
                <Clipboard className="mr-2 size-5" />
                {t('sendClipboard')}
              </Button>
              <Button
                size="lg"
                variant="outline"
                className="h-12 rounded-xl px-5"
                onClick={sendFiles}
                disabled={sendTargets.length === 0}
              >
                <Upload className="mr-2 size-5" />
                {sendTargets.length === 1 && fanout === 'one'
                  ? t('sendFilesToOne', { name: online.find((d) => d.device_id === sendTargets[0])?.name ?? '' })
                  : sendTargets.length > 0
                    ? t('sendFilesToSelected', { count: sendTargets.length })
                    : t('sendFiles')}
              </Button>
              <button
                type="button"
                role="switch"
                aria-checked={status.options.clip_sync}
                aria-label={t('autoSync')}
                data-hint={status.options.clip_sync ? t('clipAutoOnDesc') : t('clipAutoOffDesc')}
                onClick={() => setOption({ clip_sync: !status.options.clip_sync })}
                className="ds-focus-ring inline-flex h-12 items-center gap-2.5 rounded-xl border border-border/70 px-4 text-sm transition-colors hover:bg-surface"
              >
                <span
                  className={cn(
                    'relative h-5 w-9 rounded-full transition-colors',
                    status.options.clip_sync ? 'bg-primary' : 'bg-muted-foreground/30',
                  )}
                >
                  <span
                    className={cn(
                      'absolute top-0.5 size-4 rounded-full bg-background shadow transition-[left]',
                      status.options.clip_sync ? 'left-[1.125rem]' : 'left-0.5',
                    )}
                  />
                </span>
                {t('autoSync')}
              </button>
              <Button variant="ghost" size="icon" className="size-12 rounded-xl" onClick={refresh} aria-label={t('refresh')}>
                <RefreshCw className="size-5" />
              </Button>
            </div>
          </div>

          <div className="relative flex flex-wrap items-center gap-2 border-t border-border/60 bg-surface/50 px-5 py-2.5">
            <SmartSearchBox
              ref={hubBoxRef}
              scope="crossdevice-hub"
              value={hubQuery}
              onChange={setHubQuery}
              placeholder={tCommon('searchHub')}
              count={hubResult.items.length}
              approximate={hubResult.approximate}
              onArrowDown={() => hubResultsRef.current?.focusFirst()}
              onSubmit={() => hubResultsRef.current?.openFirst()}
              className="order-last ml-auto sm:w-80 xl:w-[28rem]"
            />
            <span className="text-sm text-muted-foreground">{t('sendTo')}</span>
            <div className="inline-flex rounded-lg border bg-muted/40 p-0.5">
              {(['one', 'many'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setFanout(m)}
                  className={cn(
                    'rounded-md px-3 py-1 text-sm transition-colors',
                    fanout === m ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {m === 'one' ? t('fanoutOne') : t('fanoutMany')}
                </button>
              ))}
            </div>
            {fanout === 'one' ? (
              <Select value={soloTarget ?? ''} onValueChange={setSoloTarget}>
                <SelectTrigger className="h-8 w-52">
                  <SelectValue placeholder={t('fanoutPickOne')} />
                </SelectTrigger>
                <SelectContent>
                  {online.map((d) => (
                    <SelectItem key={d.device_id} value={d.device_id}>
                      {d.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              online.map((d) => (
                <button
                  key={d.device_id}
                  type="button"
                  role="checkbox"
                  aria-checked={selected.has(d.device_id)}
                  onClick={() => toggleSelected(d.device_id)}
                  className={cn(
                    'ds-focus-ring rounded-full border px-3 py-1 text-sm transition-colors',
                    selected.has(d.device_id)
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border/70 text-muted-foreground hover:text-foreground',
                  )}
                >
                  {d.name}
                </button>
              ))
            )}
          </div>

          {activeTransfers.length > 0 && (
            <div className="relative space-y-3 border-t border-border/60 px-5 py-3">{transferRows}</div>
          )}
        </section>

        {hubResult.active ? (
          <HubSearchResults
            ref={hubResultsRef}
            result={hubResult}
            groups={hubGroups}
            onOpen={openHubEntry}
            onExitTop={() => hubBoxRef.current?.focus()}
          />
        ) : (
          <FeatureGrid tiles={tiles} onOpen={openPanel} className="min-h-[220px] flex-1" />
        )}
      </div>

      {panel && current && (
        <FeaturePanel
          key={panel}
          label={panelTile?.title ?? ''}
          origin={panelOrigin}
          backLabel={t('back')}
          actions={current.actions}
          onClose={closePanel}
          bodyClassName={current.fill ? 'flex flex-col overflow-hidden' : undefined}
        >
          {current.body}
        </FeaturePanel>
      )}

      {dragOver && (
        <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center bg-background/80 outline-2 outline-dashed outline-offset-[-8px] outline-primary">
          <div className="flex flex-col items-center gap-2 text-primary">
            <Upload className="h-8 w-8" />
            <p className="text-sm font-medium">
              {sendTargets.length === 0
                ? t('pickTargetFirst')
                : sendTargets.length === 1 && fanout === 'one'
                  ? t('dropToSendOne', {
                      name: online.find((d) => d.device_id === sendTargets[0])?.name ?? '',
                    })
                  : t('dropToSendSelected', { count: sendTargets.length })}
            </p>
          </div>
        </div>
      )}

      <ClipSendDialog open={clipPickOpen} onOpenChange={setClipPickOpen} />

      {/* 配对安全码确认：设备名可伪造，只有两端比对同一组安全码才能挡住中间人。 */}
      <Dialog open={!!pairReq} onOpenChange={(o) => !o && respondPair(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('confirmPairTitle')}</DialogTitle>
          </DialogHeader>
          {pairReq && (
            <div className="space-y-4">
              <div className="text-sm">
                <div className="font-medium">{pairReq.name}</div>
                <div className="font-mono text-sm text-muted-foreground">{pairReq.fingerprint}</div>
              </div>
              <div className="rounded-lg border bg-muted/40 p-5 text-center" data-hint={t('confirmPairHint')}>
                <div className="font-mono text-3xl tracking-[0.3em]">{pairReq.sas_digits}</div>
                <div className="mt-2 text-3xl">{pairReq.sas_emoji.join(' ')}</div>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => respondPair(false)}>
              {t('mismatch')}
            </Button>
            <Button onClick={() => respondPair(true)}>{t('matches')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!xferReq} onOpenChange={(o) => !o && respondTransfer(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('confirmTransferTitle')}</DialogTitle>
          </DialogHeader>
          {xferReq && (
            <div className="space-y-2 text-sm">
              <div>{t('transferFrom', { device: xferReq.device_name })}</div>
              <div className="font-medium">{xferReq.name}</div>
              <div className="text-muted-foreground">
                {t('transferSize', { size: humanSize(xferReq.size), files: xferReq.files })}
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => respondTransfer(false)}>
              {t('reject')}
            </Button>
            <Button onClick={() => respondTransfer(true)}>{t('accept')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
