// 文件保险箱「加解密概览」的数据层：本会话每次加密/解密/校验的耗时、字节数及派生指标。
// 只在内存、不落盘：文件名即隐私，持久历史已有加密的 activity_log。

export type FileOpKind = 'encrypt' | 'decrypt' | 'verify'

export interface FileOpRecord {
  id: string
  kind: FileOpKind
  name: string
  /** 明文字节数；文件夹或拿不到大小时为 null（不参与吞吐计算）。 */
  bytes: number | null
  ms: number
  ok: boolean
  at: number
}

export type FileOpMetricId =
  | 'throughput'
  | 'peak'
  | 'bytes'
  | 'encrypted'
  | 'decrypted'
  | 'intact'
  | 'failed'
  | 'last'

export const FILE_OP_METRICS: readonly FileOpMetricId[] = [
  'throughput',
  'peak',
  'bytes',
  'encrypted',
  'decrypted',
  'intact',
  'failed',
  'last',
]

// 默认显示的指标：顶栏左端紧凑磁贴要与五个菜单同行，所以只放四项（三项次数 + 处理总量）；
// 吞吐、峰值等可在「记录 ▸ 顶栏显示的数字」勾选。
export const DEFAULT_FILE_OP_METRICS: readonly FileOpMetricId[] = ['encrypted', 'decrypted', 'intact', 'bytes']

export const MAX_FILE_OP_RECORDS = 200

const STORAGE_KEY = 'tessera.files.metrics'

export function loadFileOpMetrics(): FileOpMetricId[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const ids = raw ? (JSON.parse(raw) as unknown) : null
    if (Array.isArray(ids)) {
      const valid = ids.filter((id): id is FileOpMetricId => FILE_OP_METRICS.includes(id as FileOpMetricId))
      if (valid.length > 0) return valid
    }
  } catch {
    // 隐私窗口、被清掉的站点数据：回落到默认，不影响页面。
  }
  return [...DEFAULT_FILE_OP_METRICS]
}

export function saveFileOpMetrics(ids: FileOpMetricId[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ids))
  } catch {
    // 同上：只是一个显示偏好，存不下就算了。
  }
}

/** 字节/毫秒 → 字节/秒。耗时太短（< 1 ms）的量不准，不参与。 */
function rateOf(r: FileOpRecord): number | null {
  if (!r.ok || r.bytes === null || r.bytes <= 0 || r.ms < 1) return null
  return (r.bytes / r.ms) * 1000
}

export interface FileOpSummary {
  encrypted: number
  decrypted: number
  verified: number
  intact: number
  failed: number
  bytes: number
  /** 总字节 / 总耗时（只算拿得到大小的那些），字节/秒。 */
  throughput: number | null
  peak: number | null
  lastMs: number | null
}

export function summarize(records: readonly FileOpRecord[]): FileOpSummary {
  let bytes = 0
  let rateBytes = 0
  let rateMs = 0
  let peak: number | null = null
  const s: FileOpSummary = {
    encrypted: 0,
    decrypted: 0,
    verified: 0,
    intact: 0,
    failed: 0,
    bytes: 0,
    throughput: null,
    peak: null,
    lastMs: records.length > 0 ? records[0].ms : null,
  }
  for (const r of records) {
    if (!r.ok) {
      s.failed++
      if (r.kind === 'verify') s.verified++
      continue
    }
    if (r.kind === 'encrypt') s.encrypted++
    else if (r.kind === 'decrypt') s.decrypted++
    else {
      s.verified++
      s.intact++
    }
    if (r.bytes !== null) bytes += r.bytes
    const rate = rateOf(r)
    if (rate !== null && r.bytes !== null) {
      rateBytes += r.bytes
      rateMs += r.ms
      peak = peak === null ? rate : Math.max(peak, rate)
    }
  }
  s.bytes = bytes
  s.throughput = rateMs > 0 ? (rateBytes / rateMs) * 1000 : null
  s.peak = peak
  return s
}

export function recordRate(r: FileOpRecord): number | null {
  return rateOf(r)
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.round(bytes)} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`
  const minutes = Math.floor(ms / 60_000)
  return `${minutes} min ${Math.round((ms % 60_000) / 1000)} s`
}

/** 一项指标的显示值，顶栏磁贴（FilesPane）与记录面板（FileOpsDashboard）共用，两处「—」规则须一致；放这里因组件文件只能导出组件（react-refresh）。 */
export function formatFileOpMetric(id: FileOpMetricId, s: FileOpSummary): string {
  switch (id) {
    case 'throughput':
      return s.throughput === null ? '—' : `${formatBytes(s.throughput)}/s`
    case 'peak':
      return s.peak === null ? '—' : `${formatBytes(s.peak)}/s`
    case 'bytes':
      return s.bytes > 0 ? formatBytes(s.bytes) : '—'
    case 'encrypted':
      return String(s.encrypted)
    case 'decrypted':
      return String(s.decrypted)
    case 'intact':
      return s.verified === 0 ? '—' : `${s.intact}/${s.verified}`
    case 'failed':
      return String(s.failed)
    case 'last':
      return s.lastMs === null ? '—' : formatDuration(s.lastMs)
  }
}
