import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { latencyStats, type LatencyPoint } from '@/lib/latencyStats'

export type { LatencyPoint }

/** 剪贴板同步耗时迷你曲线，用来看趋势而非单个数；纵轴从 0 起画，避免几毫秒抖动被放大。 */
export function LatencySparkline({
  points,
  width = 88,
  height = 20,
  className,
}: {
  points: LatencyPoint[]
  width?: number
  height?: number
  className?: string
}) {
  const { t } = useTranslation('crossdevice')
  const stats = useMemo(() => latencyStats(points), [points])
  if (!stats || points.length < 2) return null

  const pad = 2
  const top = Math.max(stats.max, 10)
  const step = (width - pad * 2) / (points.length - 1)
  const xy = points.map((p, i) => {
    const x = pad + i * step
    const y = height - pad - (p.ms / top) * (height - pad * 2)
    return [Number(x.toFixed(1)), Number(y.toFixed(1))] as const
  })
  const line = xy.map(([x, y]) => `${x},${y}`).join(' ')
  const area = `${pad},${height - pad} ${line} ${xy[xy.length - 1][0]},${height - pad}`
  const [lx, ly] = xy[xy.length - 1]
  const label = t('clipLatencyStats', { n: points.length, min: stats.min, avg: stats.avg, max: stats.max })

  return (
    <svg
      role="img"
      aria-label={label}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={cn('shrink-0 overflow-visible', stats.worse ? 'text-warning' : 'text-primary', className)}
    >
      <title>{stats.worse ? `${label} · ${t('clipLatencyWorse')}` : label}</title>
      <polygon points={area} fill="currentColor" fillOpacity={0.12} />
      <polyline points={line} fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={lx} cy={ly} r={2} fill="currentColor" />
    </svg>
  )
}
