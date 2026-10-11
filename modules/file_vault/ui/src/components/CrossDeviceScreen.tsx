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
  GitFork,
  Globe,
  Image as ImageIcon,
  Info,
  Hash,
  Keyboard,
  Laptop,
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
import { Badge, EmptyState, FeatureTitle, NUMERIC_CLASS, PageHeader, PageSection, PageShell } from '@/components/ui/page'
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
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { electronApi } from '@/lib/electronApi'
import { crossDeviceApi } from '@/lib/crossDeviceApi'
import { SessionCounter, bestRttMs, currentSpeeds, measureRefreshRate } from '@/lib/crossDeviceMetrics'
import { buildPairLink, parsePairInput } from '@/lib/pairLink'
import { copyText } from '@/lib/clipboard'
import { ClipTimelinePanel } from '@/components/crossdevice/ClipTimelinePanel'
import { LatencySparkline } from '@/components/crossdevice/LatencySparkline'
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
  const online = useMemo(() => devices.filter((d) => ONLINE_STATES.has(d.state)), [devices])
  const detailDevice = devices.find((d) => d.device_id === detailDeviceId) ?? null

  /**
   * 默认选中第一台设备，避免右栏空白（与其它四个界面一致）。判据是"当前选中的还在不在列表里"，设备被
   * 撤销或掉线后也要自动落到第一台。
   */
  useEffect(() => {
    if (devices.length === 0) {
      if (detailDeviceId !== null) setDetailDeviceId(null)
      return
    }
    if (detailDeviceId !== null && devices.some((d) => d.device_id === detailDeviceId)) return
    setDetailDeviceId(devices[0].device_id)
  }, [devices, detailDeviceId])
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

  async function sendClipboard() {
    try {
      const res = await api.call<{ sent?: number; skipped?: string }>('send_clip', {})
      if (res.skipped === 'echo') toast.message(t('clipEchoSkipped'))
      // 发给 0 台不是成功：守护进程不报错（内容已登记，只是无连接可发），不能报绿色成功。
      else if (!res.sent) toast.warning(t('clipSentNowhere'))
      else toast.success(t('clipSent', { count: res.sent }))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(msg.includes('clipboard.empty') ? t('clipboardEmpty') : msg)
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

  return (
    <div
      className={cn(
        // 本页是八个分区叠起来的文档型页面（1920×1080 下总高一千三百多像素），而 `<main>` 是overflow-hidden
        // 定高盒子，滚动职责在各页面，所以根 div 必须自己滚，否则超出部分被直接裁掉。`min-h-0 flex-1
        // overflow-y-auto` 缺一不可：min-h-0 才允许 flex 子项矮于内容。
        'ds-page-wash relative min-h-0 flex-1 space-y-5 overflow-y-auto px-8 pt-4 pb-7',
        dragOver && 'outline-2 outline-dashed outline-offset-[-8px] outline-primary',
      )}
      onDragOver={(e) => {
        // 必须 preventDefault，否则浏览器按默认行为处理（打开文件），drop 根本不触发。
        e.preventDefault()
        if (!dragOver) setDragOver(true)
      }}
      onDragLeave={(e) => {
        // 只在真正离开整个面板时才收起提示。不加这个判断的话，
        // 鼠标划过任何子元素都会触发 dragleave，边框会疯狂闪。
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false)
      }}
      onDrop={handleDrop}
    >
      {dragOver && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-md bg-background/80">
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
      {/* 跟别的面板一样走 <PageHeader>。手抄这一份原本少了 justify-between、
          gap 也差一档，两个面板并排看就能看出标题起始位置对不齐。 */}
      <PageHeader title={t('pageTitle')} />

      {/* 防火墙拦截提示。
          放在最顶上是因为它是「附近的设备一直是空的」的首要原因，而且用户
          自己永远猜不到——Windows 丢掉入站包时不报错、不记日志、也不弹窗。
          只在真的没放行时出现，放行了就不占地方。 */}
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

      {/* 传输中心——这一页的主角，所以排在最前。
          这个应用存在的理由就两件事：剪贴板跨设备同步、文件跨设备互传。
          它们以前是一排浮在页面中段的按钮，而"本机指纹和监听端口"占着首屏——
          那是排查时才看一眼的参考信息，天天用的动作反倒要往下找。

          发送目标是**显式**的：原先的规则是"勾了发给勾选的、没勾发给所有在线
          设备"，规则本身没错，但它不写在界面上——用户按下"发送文件"时并不知道
          这一份东西要去一台还是五台。现在做成明摆着的二选一，选"发给多台"时
          下面的设备列表才出现勾选框。 */}
      {/* 传输中心。**不给折叠**：这是这一页天天要用的那件事，
          给它加一层点击是帮倒忙。跟安卓端「快捷操作」永远摊开是同一个判断。 */}
      <PageSection icon={Send} title={t('transferHub')} contentClassName="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-muted-foreground">{t('sendTo')}</span>
            <div className="inline-flex rounded-lg border bg-muted/40 p-0.5">
              <button
                type="button"
                onClick={() => setFanout('one')}
                className={cn(
                  'rounded-md px-3 py-1.5 text-sm transition-colors',
                  fanout === 'one' ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {t('fanoutOne')}
              </button>
              <button
                type="button"
                onClick={() => setFanout('many')}
                className={cn(
                  'rounded-md px-3 py-1.5 text-sm transition-colors',
                  fanout === 'many' ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {t('fanoutMany')}
              </button>
            </div>

            {fanout === 'one' ? (
              <Select value={soloTarget ?? ''} onValueChange={setSoloTarget}>
                <SelectTrigger className="w-52">
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
              <span className="text-sm text-muted-foreground">
                {t('fanoutTickBelow', { count: sendTargets.length })}
              </span>
            )}
          </div>

          <div className="flex flex-wrap gap-2">
            <Button onClick={sendClipboard} disabled={online.length === 0}>
              <Clipboard className="mr-2 h-4 w-4" />
              {t('sendClipboard')}
            </Button>
            <Button variant="outline" onClick={sendFiles} disabled={sendTargets.length === 0}>
              <Upload className="mr-2 h-4 w-4" />
              {sendTargets.length === 1 && fanout === 'one'
                ? t('sendFilesToOne', { name: online.find((d) => d.device_id === sendTargets[0])?.name ?? '' })
                : sendTargets.length > 0
                  ? t('sendFilesToSelected', { count: sendTargets.length })
                  : t('sendFiles')}
            </Button>
            <Button variant="ghost" onClick={refresh}>
              <RefreshCw className="mr-2 h-4 w-4" />
              {t('refresh')}
            </Button>
          </div>

          {/* 自动同步的状态必须摆在按钮旁边。
              开着的时候，"发送剪贴板"这个按钮其实很少需要按——复制完就已经
              同步过去了。不说清楚的话，用户会一直手动按，还会以为没生效。 */}
          <div className="flex items-start gap-2 rounded-lg border border-border/70 bg-muted/25 px-3 py-2">
            {status.options.clip_sync ? (
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-500" aria-hidden="true" />
            ) : (
              <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            )}
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">
                {status.options.clip_sync ? t('clipAutoOn') : t('clipAutoOff')}
              </div>
              <p className="text-sm text-muted-foreground">
                {status.options.clip_sync ? t('clipAutoOnDesc') : t('clipAutoOffDesc')}
              </p>
            </div>
            <Button
              size="sm"
              variant="ghost"
              className="shrink-0"
              onClick={() => setOption({ clip_sync: !status.options.clip_sync })}
            >
              {status.options.clip_sync ? t('clipAutoTurnOff') : t('clipAutoTurnOn')}
            </Button>
          </div>
      </PageSection>

      {/* 进行中的传输。
          排在传输中心正下方：正在发生的事永远比"接下来能做什么"更该被看到。
          每条都能暂停和取消——传错了设备、选错了文件、或者正传着 4 GB 却要
          出门，在这之前用户唯一能做的是把应用关掉，而那会把已传好的部分
          一起丢掉。 */}
      {active.size > 0 && (
        <PageSection
          icon={Loader2}
          title={t('inProgress', { count: active.size })}
          contentClassName="space-y-3.5"
        >
            {activeTransfers.map((a) => {
              const ItemIcon = ITEM_ICON[a.itemKind] ?? FileIcon
              const eta = etaSeconds(a)
              return (
                <div key={a.key} className="space-y-1.5 rounded-lg border border-border/70 bg-muted/25 px-3 py-2.5">
                  <div className="flex items-center gap-2 text-sm">
                    <ItemIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate font-medium" title={a.name}>
                      {a.name}
                    </span>
                    <span className="shrink-0 text-sm text-muted-foreground">
                      {a.direction === 'send' ? t('dirTo', { name: a.deviceName }) : t('dirFrom', { name: a.deviceName })}
                    </span>
                    <span className="shrink-0 tabular text-sm font-semibold">{a.percent}%</span>
                    {/* 控制按钮贴着进度放，不折进菜单里：要用它的时候人是着急的。 */}
                    <div className="flex shrink-0 items-center gap-0.5">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="size-7 p-0"
                            aria-label={a.state === 'paused' ? t('resumeTransfer') : t('pauseTransfer')}
                            onClick={() => controlTransfer(a.key, a.state === 'paused' ? 'resume' : 'pause')}
                          >
                            {a.state === 'paused' ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>
                          {a.state === 'paused' ? t('resumeTransfer') : t('pauseTransfer')}
                        </TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="size-7 p-0 text-muted-foreground hover:text-destructive"
                            aria-label={t('cancelTransfer')}
                            onClick={() => controlTransfer(a.key, 'cancel')}
                          >
                            <X className="size-3.5" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>{t('cancelTransfer')}</TooltipContent>
                      </Tooltip>
                    </div>
                  </div>
                  <Progress value={a.percent} className={cn('h-1.5', a.state === 'paused' && 'opacity-50')} />
                  {/* text-2xs 而不是 text-[11px]：11px 在这个项目的正文下限
                      （16px）之下，而且是个游离在字号刻度之外的硬编码值。
                      text-2xs 是 index.css 里定义好的装饰性档位。 */}
                  <div className="flex items-center justify-between text-2xs text-muted-foreground">
                    <span className="tabular">
                      {humanSize(a.done)} / {humanSize(a.total)}
                    </span>
                    <span className="tabular">
                      {a.state === 'paused'
                        ? t('transferPaused')
                        : [
                            a.speed > 0 ? t('transferSpeed', { rate: humanSize(a.speed) }) : null,
                            eta !== null ? t('transferEta', { time: humanDuration(eta) }) : null,
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                    </span>
                  </div>
                </div>
              )
            })}
        </PageSection>
      )}

      {/* 剪贴板同步状态面板。
          正在传的大表示已经在上面「进行中的传输」里了（item_kind === 'clip'，
          共用同一套进度/暂停/取消）——这里只放*已经结束*的东西：同步到没到、
          以及两端是不是在互不知情的情况下并发改了剪贴板。两者都是"信号推送、
          详情回头查"的模式，见 refreshClipSyncLog/refreshClipConflicts。
          没有任何历史时整块不出现，不占位置。 */}
      {(clipConflicts.length > 0 || clipSyncLog.length > 0) && (
        <PageSection
          icon={GitFork}
          title={t('clipSyncPanel')}
          collapsible
          storageKey="crossdevice.clipsync"
          contentClassName="space-y-4"
        >
          {clipConflicts.length > 0 && (
            <div className="space-y-2">
              <h4 className="text-sm font-medium text-muted-foreground">{t('clipConflictsTitle')}</h4>
              <div className="space-y-2">
                {clipConflicts
                  .slice()
                  .reverse()
                  .map((c, i) => (
                    <div
                      key={`${c.device_id}-${c.at}-${i}`}
                      className="space-y-1.5 rounded-lg border border-warning/30 bg-warning/5 px-3 py-2.5"
                    >
                      {/* 分叉图标 + 两个设备徽章，是"这是一次真分叉，不是先后覆盖"
                          这件事本身的可视化——不是装饰。 */}
                      <div className="flex items-center gap-2 text-sm">
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
                      <p className="text-2xs text-muted-foreground">{t('clipConflictHint')}</p>
                    </div>
                  ))}
              </div>
            </div>
          )}

          {clipSyncLog.length > 0 && (
            <div className="space-y-2">
              <h4 className="text-sm font-medium text-muted-foreground">{t('clipSyncHistory')}</h4>
              <div className="space-y-1">
                {clipSyncLog
                  .slice()
                  .reverse()
                  .map((e, i) => {
                    const kind = t(CLIP_MIME_KIND[e.mime] ?? 'clipKind.generic')
                    return (
                      <div
                        key={`${e.item_id}-${e.mime}-${e.at}-${i}`}
                        className="flex items-center gap-2 rounded-md px-1 py-0.5 text-sm"
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
                          <span className="shrink-0 max-w-[40%] truncate text-2xs text-destructive" title={e.error}>
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
        </PageSection>
      )}

      {/* 传输活动。
          记录可以逐条勾选删除，也可以一键清空——失败记录尤其需要能删掉：
          它会一直挂在列表顶端，而用户已经知道了、也重传成功了，留着只是噪音。
          可折叠：这份列表会越攒越长，而它是"回头看"用的，不是"正在做"。 */}
      {transfers.length > 0 && (
        <PageSection
          icon={Activity}
          title={t('activity')}
          collapsible
          storageKey="crossdevice.activity"
          contentClassName="space-y-1.5"
          actions={
            <>
              {/* 全选和"删除选中"是一对：只有逐条勾的话，清一份 50 行的列表
                  要点 50 次。与安卓端的已配对设备列表用同一套交互。 */}
              <label className="flex cursor-pointer items-center gap-1.5 text-sm text-muted-foreground">
                <Checkbox
                  checked={pickedRows.size > 0 && pickedRows.size === transfers.length}
                  onCheckedChange={(v) =>
                    setPickedRows(v === true ? new Set(transfers.map((r) => r.key)) : new Set())
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
          }
        >
            {transfers.map((r) => {
              const ItemIcon = ITEM_ICON[r.itemKind] ?? FileIcon
              return (
                <label
                  key={r.key}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-0.5 text-sm hover:bg-muted/50"
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
                    {r.name}
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
                  {/* 隐私账单：这次传输走了哪条路，以及那条路上的第三方能看到什么。
                      只在传输**成功完成**时显示——失败的那次没有"经过了谁"可言。

                      为什么值得占这一格：走中继时，字节确实经过了一台服务器。
                      用户有权知道这件事，而且更该知道"服务器看得到的只有密文和
                      文件大小"。不说的话，知道的人会担心，不知道的人则完全不知道
                      自己在担心什么——两种都不好。 */}
                  {r.relayed !== undefined && (r.kind === 'done' || r.kind === 'recv_done') && (
                    <span
                      className={cn(
                        'shrink-0 rounded px-1.5 py-0.5 text-2xs',
                        r.relayed
                          ? 'bg-warning/12 text-warning'
                          : 'bg-success/12 text-success',
                      )}
                      title={r.relayed ? t('receiptRelayedHint') : t('receiptDirectHint')}
                    >
                      {r.relayed ? t('receiptRelayed') : t('receiptDirect')}
                    </span>
                  )}
                </label>
              )
            })}
        </PageSection>
      )}

      {/* 设备列表。**不给折叠**：「我连着谁、谁在线」是这一页要回答的第一个问题，
          跟安卓端把已配对设备卡永远摊开是同一个判断——那张卡被藏起来正是这一轮
          修的第一个 bug。 */}
      <PageSection
        icon={MonitorSmartphone}
        title={t('pairedDevices', { count: devices.length })}
        padded={false}
      >
        {/* 左选右看，走全应用共用的 <Workbench>。
            这一段是这一页里唯一"一堆同类东西挑一个"的地方——设备的往返时延、
            走的直连还是中继、什么时候到期，一行里塞不下，塞下了也读不了。 */}
        <Workbench
          className="rounded-none border-0"
          // 这一页整页自己滚，工作台只是其中一个分区——没有人能给它一个确定的
          // 高度，`flex-1` 无处可分。embedded 档自己定高度，见 workbench.tsx。
          embedded
          selected={detailDevice !== null}
          onBack={() => setDetailDeviceId(null)}
          backLabel={tCommon('backToList')}
          placeholder={
            <EmptyState icon={MonitorSmartphone} title={t('deviceDetailEmpty')} className="m-6" />
          }
          detail={
            detailDevice && (
              <DeviceDetailPane device={detailDevice} onRevoke={() => revoke(detailDevice)} onUpdated={updateDevice} />
            )
          }
          list={
        <div className="space-y-2 p-3">
          {devices.length === 0 && <p className="text-sm text-muted-foreground">{t('noDevices')}</p>}
          {devices.map((d) => {
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
                {/* 勾选框只在「发给多台」模式下出现。发给一台时目标由上面那个
                    下拉框决定，这里再摆一排勾选框只会让人搞不清到底哪个说了算。 */}
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
                    <span className="truncate font-medium">{d.name}</span>
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
                      <span className="text-primary" title={t('clipLatencyLabel')}>
                        · {t('clipLatencyBadge', { ms: d.clip_latency_ms })}
                      </span>
                    )}
                    {d.clip_latency_hist && d.clip_latency_hist.length >= 2 && (
                      <LatencySparkline points={d.clip_latency_hist} className="ml-1" />
                    )}
                    {d.expires_at && <span>· {t('expiresIn', { minutes: Math.max(0, Math.round((d.expires_at - Date.now()) / 60000)) })}</span>}
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
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); revoke(d) }} aria-label={t('revoke')}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{t('revoke')}</TooltipContent>
                </Tooltip>
              </div>
            )
          })}
        </div>
          }
        />
      </PageSection>

      {/* 实时指标。
          默认收起，展开后每秒刷一次；收起时那个定时器根本不启动，一点 CPU 都不占。
          这一组跟安卓端「实时指标」是同一批数、同一个顺序、同一套措辞——
          同一个人在电脑和手机上看到的应该是同一份读数，而不是两套各自命名的东西。 */}
      <PageSection
        icon={Activity}
        title={t('liveMetrics')}
        collapsible
        defaultExpanded={false}
        storageKey="crossdevice.metrics"
        onExpandedChange={setMetricsOpen}
        contentClassName="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"
      >
        {metricCards.map((m) => (
          <div key={m.label} className="rounded-lg border border-border/70 bg-surface px-3 py-2">
            <p className="text-sm text-muted-foreground">{m.label}</p>
            <p className={cn('mt-1 font-mono text-sm', NUMERIC_CLASS)}>{m.value}</p>
          </div>
        ))}
      </PageSection>

      {/* 配对。
          可折叠：这块是这一页最高的一张卡（五个配对方式 + 二维码 + 大输入框），
          而配好设备之后它就是"偶尔才用一次"的东西。收起来只剩一行标题，
          下面的诊断和选项就不用每次滚半天才够得着。展开状态记住，
          还没配过设备的人第一次打开是展开的。

          安卓端「出示我的码」那张卡走的是同一套：标题右侧向下箭头、
          展开时转 180°、状态持久化——两端同一个符号表达同一件事。 */}
      <PageSection
        icon={Link2}
        title={t('addDevice')}
        collapsible
        storageKey="crossdevice.addDevice"
        defaultExpanded={devices.length === 0}
      >
          <div className="mb-4 flex flex-wrap items-end gap-3">
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

          {/* 四种配对方式并列。不用 grid-cols-4：TabsTrigger 自带 whitespace-nowrap
              且不裁剪，四等分在法语/俄语下装不下标签文字，会直接溢出压到隔壁
              标签上。改成按内容宽度排布并允许换行——宽窗口一行、窄窗口两行，
              任何语言下都不会重叠。与登录页的解锁方式标签栏是同一套做法。 */}
          <Tabs value={pairTab} onValueChange={setPairTab}>
            <TabsList className="flex h-auto w-full flex-wrap justify-start gap-1 p-1">
              {/* 数字码排第一并默认选中：其它三条路各有前提——二维码要摄像头、
                  附近设备要组播（很多家用路由器直接丢掉）、手动地址要知道 IP 和
                  端口。只有这条在哪儿都成立，所以它该是第一眼看到的那个。 */}
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
                {/* 左：本机显示码 */}
                <div className="space-y-2 rounded-lg border border-border bg-surface p-4">
                  <FeatureTitle as="p">{t('shortCodeShowTitle')}</FeatureTitle>
                  {!shortCode ? (
                    <Button onClick={showShortCode} disabled={shortBusy}>
                      {shortBusy ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Hash className="mr-2 size-4" />}
                      {t('shortCodeGenerate')}
                    </Button>
                  ) : (
                    <div className="space-y-2">
                      {/* 码本身要足够大——用户是隔着一段距离照着另一台设备的屏幕敲的。
                          等宽 + 字距拉开，避免 6 和 8、0 和 O 看混。 */}
                      <p className="font-mono text-3xl font-semibold tracking-[0.35em] tabular">
                        {shortCode.code}
                      </p>
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

                {/* 右：输入对方的码 */}
                <div className="space-y-2 rounded-lg border border-border bg-surface p-4">
                  <FeatureTitle as="p">{t('shortCodeEnterTitle')}</FeatureTitle>
                  <Input
                    value={peerShortCode}
                    onChange={(e) => setPeerShortCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    onKeyDown={(e) => e.key === 'Enter' && void pairWithShortCode()}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    placeholder="000000"
                    aria-label={t('shortCodeEnterTitle')}
                    className="text-center font-mono text-3xl font-semibold tracking-[0.35em] tabular"
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
                    <img src={qrDataUrl} alt={t('qrAlt')} className="rounded-md border bg-white p-2" width={260} height={260} />
                  )}
                  {/* 有效期从 60 秒放宽到 5 分钟之后（见 core/pairing/qr.go 里 QRTTL 的
                      说明），再显示成「300 秒后过期」就不好读了。超过一分钟按
                      「X 分 Y 秒」显示，一分钟以内保持原来的秒数写法。 */}
                  <p className="text-sm text-muted-foreground">
                    {codeLeft >= 60
                      ? t('codeExpiresInMinutes', { minutes: Math.floor(codeLeft / 60), seconds: codeLeft % 60 })
                      : t('codeExpiresIn', { seconds: codeLeft })}
                  </p>
                  <p className="font-mono text-sm">{t('fingerprint')}: {myCode.fingerprint}</p>
                  <div className="flex flex-wrap justify-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        // 只有真写进去了才报"已复制"。原来无条件 toast——复制失败时
                        // 界面照样说成功，用户去粘贴才发现是空的。
                        void copyText(myCode.code).then((ok) => ok && toast.success(t('codeCopied')))
                      }}
                    >
                      <Copy className="mr-2 h-4 w-4" />
                      {t('copyCode')}
                    </Button>
                    {/* 换一张二维码。用途不只是"扫失败了重来"：这张码带的是
                        一次性令牌，被别人拍到过、投屏时露出去过、或者只是挂太久
                        了，都应该能当场作废重发一张，而不是等它自己过期。 */}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        void copyText(buildPairLink(myCode.code)).then((ok) => ok && toast.success(t('pairLinkCopied')))
                      }}
                    >
                      <Link2 className="mr-2 h-4 w-4" />
                      {t('copyPairLink')}
                    </Button>
                    <Button variant="outline" size="sm" onClick={showCode} disabled={busy}>
                      {busy ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        <RefreshCw className="mr-2 h-4 w-4" />
                      )}
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
                <div className="flex shrink-0 gap-2">
                  <Button size="sm" variant="outline" onClick={() => void refreshNearby()} disabled={nearbyBusy || scanBusy}>
                    {nearbyBusy ? <Loader2 className="mr-2 size-4 animate-spin" /> : <RefreshCw className="mr-2 size-4" />}
                    {t('refresh')}
                  </Button>
                  {/* 主动扫描是「列表一直是空的」的正解，所以它是主按钮而不是
                      藏在某个折叠区里。被动刷新只是把已经听到的读一遍，网络
                      丢组播时刷一百次也还是空的。 */}
                  <Button size="sm" onClick={scanLan} disabled={scanBusy}>
                    {scanBusy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Radar className="mr-2 h-4 w-4" />}
                    {t('scanLan')}
                  </Button>
                </div>
              </div>

              {nearby.length === 0 ? (
                <div className="space-y-2 rounded border border-dashed p-4 text-center">
                  <p className="text-sm text-muted-foreground">{scanBusy ? t('scanning') : t('nearbyEmpty')}</p>
                  {!scanBusy && <p className="text-sm text-muted-foreground">{t('nearbyEmptyHint')}</p>}
                </div>
              ) : (
                nearby.map((d) => {
                  const Icon = DEVICE_ICON[d.type] ?? Laptop
                  return (
                    <div key={d.device_id} className="flex items-center gap-3 rounded-md border px-3 py-2">
                      <Icon className="size-5 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium">{d.name}</div>
                        {/* 名字必须标「未验证」：设备名是攻击者可以任意伪造的，
                            把自己命名成「我的手机」很容易让人点错。真正能证明
                            身份的是配对时两边核对的那组安全码。
                            已配对的设备不用标——它的身份早就在配对时核实过了。 */}
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

            {/* 手动输入地址：所有自动发现都失效时的兜底。只要两台机器 IP 能通
                就一定连得上——不依赖组播、不依赖广播、也不要求在同一网段。 */}
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
                {/* 只写 IP 也行——守护进程会去问对方的固定信标端口要 QUIC 端口。
                    以前这里硬性要求写成 IP:端口，而那个端口号只有对方界面上才
                    看得到；这条路本来就是"别的都失效了"的兜底，不该再加一道
                    用户跨不过去的门槛。 */}
              </div>
              <Button onClick={pairWithAddress} disabled={pairing || !manualAddr.trim()}>
                {pairing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Link2 className="mr-2 h-4 w-4" />}
                {t('pairNow')}
              </Button>
            </TabsContent>
          </Tabs>
      </PageSection>

      {/* 连接诊断。默认收起——它是"连不上的时候才来"的东西，
          而绝大多数打开这一页的时刻并不是那个时刻。 */}
      <PageSection
        icon={Stethoscope}
        title={t('diagTitle')}
        collapsible
        defaultExpanded={false}
        storageKey="crossdevice.diagnose"
        contentClassName="space-y-3"
      >
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="outline" size="sm" onClick={runDiagnose} disabled={diagBusy}>
              {diagBusy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Stethoscope className="mr-2 h-4 w-4" />}
              {t('diagRun')}
            </Button>
            <span className="flex items-center gap-1.5 text-sm">
              <ShieldCheck
                className={cn(
                  'h-3.5 w-3.5',
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
            </span>
            {firewall === 'blocked' && (
              <Button size="sm" variant="outline" onClick={fixFirewall} disabled={firewallBusy}>
                {firewallBusy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                {t('firewallFix')}
              </Button>
            )}
          </div>

          {diag === null ? (
            <p className="text-sm text-muted-foreground">{t('diagIdle')}</p>
          ) : (
            <div className="space-y-1.5">
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
                    {/* 诊断结论在这里翻译，不在 Go 里拼字符串：守护进程不知道
                        界面是什么语言，让它产出人话等于把六种语言写死在后端。 */}
                    <div>{t(`diag.${c.id}.${c.status}`, { ...c.values, defaultValue: c.id })}</div>
                    {/* 修复建议只给真正需要用户动手的项。info 是"一切正常，只是
                        对面不在"，给它配一句"请检查…"反而是在制造焦虑。 */}
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
      </PageSection>

      {/* 跨网络连接。默认收起：两台设备在同一个 Wi-Fi 下根本不需要它。
          两端必须填**同一个**中转点地址才能互相找到，所以桌面和手机都得有这个入口。 */}
      <PageSection
        icon={Globe}
        title={t('crossnetTitle')}
        collapsible
        defaultExpanded={false}
        storageKey="crossdevice.crossnet"
        contentClassName="space-y-3"
      >
          <p className="text-sm text-muted-foreground">{t('crossnetExplain')}</p>

          <Alert>
            <AlertDescription>
              {status.options.rendezvous_addr
                ? t('crossnetStatusOn', { addr: status.options.rendezvous_addr })
                : t('crossnetStatusOff')}
            </AlertDescription>
          </Alert>

          <div className="space-y-1">
            <Label htmlFor="rv-addr">{t('crossnetAddr')}</Label>
            <Input
              id="rv-addr"
              value={rvAddr}
              onChange={(e) => setRvAddr(e.target.value)}
              placeholder="example.com:47820"
              spellCheck={false}
            />
            <p className="text-sm text-muted-foreground">{t('crossnetAddrHelp')}</p>
          </div>

          <div className="space-y-1">
            <Label htmlFor="rv-secret">{t('crossnetSecret')}</Label>
            <Input
              id="rv-secret"
              type="password"
              value={rvSecret}
              onChange={(e) => setRvSecret(e.target.value)}
              placeholder={status.options.rendezvous_secret_set ? '••••••••' : ''}
              spellCheck={false}
            />
            <p className="text-sm text-muted-foreground">{t('crossnetSecretHelp')}</p>
          </div>

          <label className="flex items-start gap-3 text-sm">
            <Checkbox
              checked={status.options.relay_on_metered}
              onCheckedChange={(v) => setOption({ relay_on_metered: v === true })}
            />
            <span>
              <span className="font-medium">{t('crossnetMetered')}</span>
              <span className="block text-sm text-muted-foreground">{t('crossnetMeteredDesc')}</span>
            </span>
          </label>

          <div className="flex gap-2 pt-1">
            <Button size="sm" onClick={saveCrossnet} disabled={busy || !rvAddr.trim()}>
              {t('crossnetSave')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={disableCrossnet}
              disabled={busy || !status.options.rendezvous_addr}
            >
              {t('crossnetDisable')}
            </Button>
          </div>
      </PageSection>

      {/* 选项。设置类内容，默认收起。 */}
      <PageSection
        icon={SlidersHorizontal}
        title={t('options')}
        collapsible
        defaultExpanded={false}
        storageKey="crossdevice.options"
        contentClassName="space-y-3"
      >
          <label className="flex items-start gap-3 text-sm">
            <Checkbox
              checked={status.options.clip_sync}
              onCheckedChange={(v) => setOption({ clip_sync: v === true })}
            />
            <span>
              <span className="font-medium">{t('optClipSync')}</span>
              <span className="block text-sm text-muted-foreground">{t('optClipSyncDesc')}</span>
            </span>
          </label>
          <label className="flex items-start gap-3 text-sm">
            <Checkbox
              checked={status.options.clip_plain_only === true}
              onCheckedChange={(v) => setOption({ clip_plain_only: v === true })}
            />
            <span>
              <span className="font-medium">{t('optClipPlainOnly')}</span>
              <span className="block text-sm text-muted-foreground">{t('optClipPlainOnlyDesc')}</span>
            </span>
          </label>
          <label className="flex items-start gap-3 text-sm">
            <Checkbox
              checked={status.options.auto_accept}
              onCheckedChange={(v) => setOption({ auto_accept: v === true })}
            />
            <span>
              <span className="font-medium">{t('optAutoAccept')}</span>
              <span className="block text-sm text-muted-foreground">{t('optAutoAcceptDesc')}</span>
            </span>
          </label>
          <div className="flex items-start gap-2 pt-1">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">{t('downloadDir')}</div>
              <div className="truncate font-mono text-sm text-muted-foreground" title={status.options.download_dir}>
                {status.options.download_dir}
              </div>
            </div>
            <Button size="sm" variant="outline" onClick={pickDownloadDir} disabled={busy}>
              <FolderOpen className="mr-2 h-4 w-4" />
              {t('changeDownloadDir')}
            </Button>
          </div>
      </PageSection>

      {/* 本机身份。设备名、指纹、端口——排查时才看一眼的参考信息，默认收起。
          跟安卓端把「本机身份」沉到设置区是同一个判断。 */}
      <PageSection
        icon={Monitor}
        title={t('thisDevice')}
        collapsible
        defaultExpanded={false}
        storageKey="crossdevice.thisDevice"
        contentClassName="grid gap-2 text-sm sm:grid-cols-3"
      >
          <div>
            <div className="text-muted-foreground">{t('deviceName')}</div>
            {renamingDevice ? (
              <div className="flex items-center gap-1 pt-0.5">
                <Input
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void saveDeviceName()
                    if (e.key === 'Escape') setRenamingDevice(false)
                  }}
                  autoFocus
                  maxLength={64}
                  className="h-7 text-sm"
                />
                <Button size="sm" className="h-7 px-2" onClick={saveDeviceName} disabled={busy}>
                  {t('save')}
                </Button>
              </div>
            ) : (
              <div className="flex items-center gap-1">
                <span className="font-medium">{status.name}</span>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 w-6 p-0"
                      aria-label={t('renameThisDevice')}
                      onClick={() => {
                        setDraftName(status.name)
                        setRenamingDevice(true)
                      }}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{t('renameThisDevice')}</TooltipContent>
                </Tooltip>
              </div>
            )}
          </div>
          <div>
            <div className="text-muted-foreground">{t('fingerprint')}</div>
            <div className="font-mono text-sm">{status.fingerprint}</div>
          </div>
          <div>
            <div className="text-muted-foreground">{t('listeningPort')}</div>
            <div className="font-mono text-sm">{status.port}</div>
          </div>
      </PageSection>

      {/* 跨设备剪贴板时间线：任一设备最近复制过的内容，挑一条再次粘贴。
          排在「本机」之后：它是翻看历史用的固定大小窗口（可全屏），不是天天要点的动作，
          放在前面只会把传输、配对这些常用块挤到屏幕下方。 */}
      <ClipTimelinePanel available={available === true} />

      {/* 配对安全码确认。这一步不能省：设备名可以随便伪造，
          只有两端比对同一组安全码才能挡住中间人。 */}
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
              <div className="rounded-lg border bg-muted/40 p-5 text-center">
                <div className="font-mono text-3xl tracking-[0.3em]">{pairReq.sas_digits}</div>
                <div className="mt-2 text-3xl">{pairReq.sas_emoji.join(' ')}</div>
              </div>
              <Alert>
                <AlertDescription>{t('confirmPairHint')}</AlertDescription>
              </Alert>
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

      {/* 接收文件确认 */}
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
