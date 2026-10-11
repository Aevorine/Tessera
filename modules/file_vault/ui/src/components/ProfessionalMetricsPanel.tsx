import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Activity, Pause, Play } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { electronApi } from '@/lib/electronApi'
import { useAppearance } from '@/lib/appearanceContext'
import type { RuntimeMetricId } from '@/lib/appearancePreferences'
import type { RuntimeMetricsSnapshot } from '@/shared/ipcTypes'
import { MetricValue } from '@/components/ui/page'

interface LiveMetrics {
  native: RuntimeMetricsSnapshot
  ipcLatencyMs: number
  ipcLatencyP50Ms: number | null
  ipcLatencyP95Ms: number | null
  rendererHeapBytes: number | null
}

/**
 * IPC 往返耗时环形缓冲，只留最近 N 次，算 P50 / P95。
 * 只量本面板每 2 秒的 getRuntimeMetrics()：同通道同载荷，分位数才是纯 IPC 开销；
 * 全应用口径需把缓冲提升到 vaultApi 层。N=60 ≈ 2 分钟，样本再少 P95 会退化成 max。
 */
const LATENCY_WINDOW = 60

/** 最近邻插值分位数。样本量这么小的时候，线性插值那点精度提升没有意义。 */
function percentile(sorted: number[], fraction: number): number | null {
  if (sorted.length === 0) return null
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))
  return sorted[index]
}

export function ProfessionalMetricsPanel() {
  const { t } = useTranslation('settings')
  const { preferences } = useAppearance()
  const [metrics, setMetrics] = useState<LiveMetrics | null>(null)
  const [fps, setFps] = useState<number | null>(null)
  const [paused, setPaused] = useState(false)
  const [failed, setFailed] = useState(false)
  const latencies = useRef<number[]>([])

  const recordLatency = useCallback((sample: number) => {
    const buffer = latencies.current
    buffer.push(sample)
    if (buffer.length > LATENCY_WINDOW) buffer.splice(0, buffer.length - LATENCY_WINDOW)
    const sorted = [...buffer].sort((a, b) => a - b)
    return { p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95) }
  }, [])

  useEffect(() => {
    if (paused) return
    let active = true

    const refresh = async () => {
      if (document.visibilityState !== 'visible') return
      const started = performance.now()
      try {
        const native = await electronApi.getRuntimeMetrics()
        if (!active) return
        const perf = performance as Performance & {
          memory?: { usedJSHeapSize?: number }
        }
        const ipcLatencyMs = performance.now() - started
        const { p50, p95 } = recordLatency(ipcLatencyMs)
        setMetrics({
          native,
          ipcLatencyMs,
          ipcLatencyP50Ms: p50,
          ipcLatencyP95Ms: p95,
          rendererHeapBytes: perf.memory?.usedJSHeapSize ?? null,
        })
        setFailed(false)
      } catch {
        if (active) setFailed(true)
      }
    }

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void refresh()
    }
    void refresh()
    const timer = window.setInterval(() => {
      // 窗口不可见时不刷：否则设置页开着时最小化也会每 2 秒唤醒后端采样，持续耗电。
      // 其他常驻定时器都已这样判断。
      if (document.visibilityState !== 'visible') return
      void refresh()
    }, 2000)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      active = false
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [paused, recordLatency])

  // 帧率：rAF 回调次数即帧率。暂停时不注册 rAF（注册了再忽略会让浏览器保持渲染）；
  // 页面不可见时 rAF 自动停发，回前台第一秒的数偏低，所以丢弃不足一秒的那段。
  useEffect(() => {
    if (paused) {
      setFps(null)
      return
    }
    let handle = 0
    let frames = 0
    let windowStart = performance.now()

    const tick = (now: number) => {
      frames += 1
      const elapsed = now - windowStart
      if (elapsed >= 1000) {
        setFps((frames * 1000) / elapsed)
        frames = 0
        windowStart = now
      }
      handle = window.requestAnimationFrame(tick)
    }
    handle = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(handle)
  }, [paused])

  return (
    <div className="space-y-3 rounded-xl border bg-card/90 p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex gap-2">
          <Activity className="mt-0.5 size-4 text-primary" aria-hidden />
          <div>
            <p className="font-medium">{t('metricsPanelTitle')}</p>
          </div>
        </div>
        <Button size="sm" variant="outline" onClick={() => setPaused((value) => !value)}>
          {paused ? <Play className="size-3.5" aria-hidden /> : <Pause className="size-3.5" aria-hidden />}
          {t(paused ? 'metricsResume' : 'metricsPause')}
        </Button>
      </div>

      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4" aria-live="polite">
        {preferences.selectedMetrics.map((metric) => (
          <MetricCard
            key={metric}
            label={t(`metric_${metric}`)}
            value={formatMetric(metric, metrics, fps, t('metricsUnavailable'))}
          />
        ))}
      </div>

      <p className="text-2xs text-muted-foreground">
        {failed
          ? t('metricsReadFailed')
          : paused
            ? t('metricsPausedState')
            : metrics
              ? t('metricsUpdatedAt', { time: new Date(metrics.native.capturedAtMs).toLocaleTimeString() })
              : t('metricsLoading')}
      </p>
    </div>
  )
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-background/70 px-3 py-2">
      <p className="text-2xs text-muted-foreground">{label}</p>
      <MetricValue className="mt-1 font-mono text-foreground">{value}</MetricValue>
    </div>
  )
}

/**
 * 每一档固定小数位，避免每 2 秒重绘时数字宽度抖动（配合 `.tabular`）。
 * 帧率不来自 IPC 快照，单独传入，数据未取到时也能显示。
 */
function formatMetric(
  metric: RuntimeMetricId,
  values: LiveMetrics | null,
  fps: number | null,
  unavailable: string,
): string {
  // 帧率为空只有两种情况：刚挂载还没满一秒、或者被用户暂停了。两者都是
  // "暂时没有"，不是 metricsUnavailable 想表达的"这台机器拿不到这个数"。
  if (metric === 'frameRate') return fps === null ? '—' : `${fps.toFixed(0)} FPS`
  if (values === null) return '—'
  const snapshot = values.native
  switch (metric) {
    case 'cpu':
      return `${snapshot.cpuPercent.toFixed(1)}%`
    case 'workingSet':
      return formatBytes(snapshot.workingSetBytes)
    case 'privateMemory':
      return formatBytes(snapshot.privateMemoryBytes)
    case 'systemMemory': {
      const used = Math.max(0, snapshot.totalMemoryBytes - snapshot.freeMemoryBytes)
      const ratio = snapshot.totalMemoryBytes > 0 ? (used / snapshot.totalMemoryBytes) * 100 : 0
      return `${ratio.toFixed(1)}%`
    }
    case 'processCount':
      return String(snapshot.processCount)
    case 'uptime':
      return formatDuration(snapshot.uptimeSeconds)
    case 'rendererHeap':
      return values.rendererHeapBytes === null ? unavailable : formatBytes(values.rendererHeapBytes)
    case 'ipcLatency':
      return `${values.ipcLatencyMs.toFixed(1)} ms`
    case 'ipcLatencyP50':
      return values.ipcLatencyP50Ms === null ? unavailable : `${values.ipcLatencyP50Ms.toFixed(1)} ms`
    case 'ipcLatencyP95':
      return values.ipcLatencyP95Ms === null ? unavailable : `${values.ipcLatencyP95Ms.toFixed(1)} ms`
  }
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB'
  const mb = bytes / (1024 * 1024)
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(1)} MB`
}

function formatDuration(seconds: number): string {
  const totalMinutes = Math.max(0, Math.floor(seconds / 60))
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`
}
