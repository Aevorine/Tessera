import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { cn } from '@/lib/utils'
import { METRIC_VALUE_CLASS, NUMERIC_CLASS } from '@/components/ui/page'
import type { ScorePenalty } from '@/lib/healthScore'

/**
 * 分数环本体，用 SVG 而非图表库（只需两段圆弧，避免多下载几十 KB）。
 * 颜色只走语义三档（好/一般/差），不给分数段另配色相，颜色的含义永远是"状态"。
 */
export function HealthScoreRing({
  score,
  tone,
  size = 168,
  label,
  sublabel,
}: {
  score: number
  tone: 'success' | 'warning' | 'danger'
  size?: number
  label: string
  sublabel?: string
}) {
  const stroke = Math.round(size / 14)
  const radius = (size - stroke) / 2
  const circumference = 2 * Math.PI * radius
  const dash = useMemo(
    () => (Math.max(0, Math.min(100, score)) / 100) * circumference,
    [score, circumference],
  )
  const color =
    tone === 'success' ? 'text-success' : tone === 'warning' ? 'text-warning' : 'text-destructive'

  return (
    <div className="flex flex-col items-center gap-2">
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            strokeWidth={stroke}
            className="stroke-border/60"
          />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${dash} ${circumference - dash}`}
            // 从 12 点方向开始顺时针，符合"仪表盘"的直觉。
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
            className={cn('transition-[stroke-dasharray] duration-700 ease-out', color)}
            style={{ stroke: 'currentColor' }}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          {/* 分数走 `METRIC_VALUE_CLASS`（全应用数值的唯一来源），
              **不另起一档更大的字号**。为了"看起来气派"新开一档，正是
              `typographyScale.test.mjs` 拦的那种不统一——那个守卫刚刚
              当场把这里的 text-4xl 打回来了。 */}
          <span className={cn(METRIC_VALUE_CLASS, color)}>{score}</span>
          <span className="text-2xs text-muted-foreground">{label}</span>
        </div>
      </div>
      {sublabel && <p className="text-2xs text-muted-foreground">{sublabel}</p>}
    </div>
  )
}

/** 分数拆解列表。分数环旁边那一列"因为什么扣了多少"。 */
export function ScoreBreakdown({
  penalties,
  onJump,
}: {
  penalties: readonly ScorePenalty[]
  onJump?: (category: string) => void
}) {
  const { t } = useTranslation('pcclean')
  if (penalties.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('score.perfect')}</p>
  }
  return (
    <ul className="flex w-full flex-col gap-1.5">
      {penalties.map((p) => {
        const row = (
          <>
            <span className="min-w-0 flex-1 truncate text-sm">{t(p.labelKey)}</span>
            <span className={cn('text-2xs text-muted-foreground', NUMERIC_CLASS)}>{p.detail}</span>
            <span className={cn('w-12 text-right text-sm font-medium text-warning', NUMERIC_CLASS)}>
              −{p.points}
            </span>
          </>
        )
        return (
          <li key={p.labelKey}>
            {p.category && onJump ? (
              <button
                type="button"
                onClick={() => onJump(p.category as string)}
                className="flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {row}
              </button>
            ) : (
              <div className="flex w-full items-center gap-3 px-2 py-1.5">{row}</div>
            )}
          </li>
        )
      })}
    </ul>
  )
}
