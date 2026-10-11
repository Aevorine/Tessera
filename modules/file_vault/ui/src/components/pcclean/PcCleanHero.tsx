import { useTranslation } from 'react-i18next'
import { Loader2, ShieldCheck, Square, Trash2, Zap } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { HERO_VALUE_CLASS, NUMERIC_CLASS } from '@/components/ui/page'
import { cn } from '@/lib/utils'
import { formatBytesParts } from '@/lib/pcclean'

/**
 * 清理套件首屏主控件 + 滚动后的吸顶细条。删除入口必须在页面最前面（多数人只想扫一下然后清掉）：
 * 首屏一个 240px 圆形控件，没扫过是「扫一扫」，扫完变成「立即清理」并显示可释放字节数；
 * 圆环滚出视野后顶部浮出吸顶细条，带同样的数字和按钮。两者共用同一份状态和回调，不是两套实现。
 */

export type HeroState = 'idle' | 'scanning' | 'ready' | 'cleaning'

export interface HeroProps {
  state: HeroState
  /** 后端认为可以清掉的总字节数（去掉锁死项）。 */
  reclaimableBytes: number
  /** 用户当前勾了多少项、多大。 */
  selectedCount: number
  selectedBytes: number
  /** 扫描进度 0~100，只在 scanning 时用。 */
  progress: number
  /** 正在扫的类目名，已翻译并拼好。 */
  scanningLabel?: string
  etaSeconds?: number
  onScan: () => void
  onStop: () => void
  onClean: () => void
  onSelectRecommended: () => void
  onClearSelection: () => void
  /** 推荐项的规模。为 0 时"选中推荐项"按钮不出现——一个按了没反应的按钮
   *  比没有这个按钮更让人困惑。 */
  recommendedCount: number
  lastRunLabel?: string
}

const RING_SIZE = 240
const RING_STROKE = 10

/** 圆形主控件，用 `<button>` 包 SVG 而非 div + onClick，以免丢键盘 Tab/回车和读屏支持。 */
function HeroDial({
  state,
  reclaimableBytes,
  progress,
  onScan,
  onStop,
  onClean,
  disabled,
}: {
  state: HeroState
  reclaimableBytes: number
  progress: number
  onScan: () => void
  onStop: () => void
  onClean: () => void
  disabled: boolean
}) {
  const { t } = useTranslation('pcclean')
  const radius = (RING_SIZE - RING_STROKE) / 2
  const circumference = 2 * Math.PI * radius
  // 扫描时按真实进度走；已就绪时画满一圈（那是"这一轮扫完了"的意思）；
  // 没扫过时画空——空圆环本身就是"还没开始"最直观的表达。
  const ratio = state === 'scanning' ? progress / 100 : state === 'idle' ? 0 : 1
  const dash = Math.max(0, Math.min(1, ratio)) * circumference

  const { value, unit } = formatBytesParts(reclaimableBytes)
  const busy = state === 'scanning' || state === 'cleaning'

  const handleClick = () => {
    if (state === 'scanning') onStop()
    else if (state === 'ready') onClean()
    else if (state === 'idle') onScan()
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={disabled || state === 'cleaning'}
      aria-label={
        state === 'ready' ? t('hero.cleanNow')
          : state === 'scanning' ? t('hero.stop')
            : t('hero.scanNow')
      }
      className={cn(
        'group relative shrink-0 rounded-full transition-transform',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4',
        'focus-visible:ring-offset-background',
        !busy && 'hover:scale-[1.02] active:scale-[0.99]',
        disabled && 'cursor-not-allowed opacity-70',
      )}
      style={{ width: RING_SIZE, height: RING_SIZE }}
    >
      <svg width={RING_SIZE} height={RING_SIZE} viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`} aria-hidden="true">
        <circle
          cx={RING_SIZE / 2}
          cy={RING_SIZE / 2}
          r={radius}
          fill="none"
          strokeWidth={RING_STROKE}
          className="stroke-border/50"
        />
        <circle
          cx={RING_SIZE / 2}
          cy={RING_SIZE / 2}
          r={radius}
          fill="none"
          strokeWidth={RING_STROKE}
          strokeLinecap="round"
          strokeDasharray={`${dash} ${circumference - dash}`}
          transform={`rotate(-90 ${RING_SIZE / 2} ${RING_SIZE / 2})`}
          className={cn(
            'transition-[stroke-dasharray] duration-500 ease-out',
            // 颜色只走语义档：就绪 success，扫描中 primary，不给环单独分配色相。
            state === 'ready' ? 'text-success' : 'text-primary',
          )}
          style={{ stroke: 'currentColor' }}
        />
      </svg>

      <span className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 px-8">
        {state === 'idle' && (
          <>
            <Zap className="size-7 text-primary" aria-hidden="true" />
            <span className="font-heading text-sihao leading-snug font-medium">
              {t('hero.scanNow')}
            </span>
          </>
        )}
        {state === 'scanning' && (
          <>
            <Loader2 className="size-6 animate-spin text-primary" aria-hidden="true" />
            <span className={cn(HERO_VALUE_CLASS, 'text-primary')}>{Math.round(progress)}</span>
            <span className="text-2xs text-muted-foreground">%</span>
          </>
        )}
        {(state === 'ready' || state === 'cleaning') && (
          <>
            <span className="flex items-baseline gap-1.5">
              <span className={cn(HERO_VALUE_CLASS, reclaimableBytes > 0 ? 'text-success' : 'text-muted-foreground')}>
                {value}
              </span>
              {unit && <span className="text-sm font-medium text-muted-foreground">{unit}</span>}
            </span>
            <span className="text-2xs text-muted-foreground">{t('hero.reclaimable')}</span>
            <span
              className={cn(
                'mt-1 inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-medium',
                reclaimableBytes > 0
                  ? 'bg-destructive/12 text-destructive ring-1 ring-inset ring-destructive/25'
                  : 'bg-muted text-muted-foreground ring-1 ring-inset ring-border',
              )}
            >
              {state === 'cleaning' ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <Trash2 className="size-4" aria-hidden="true" />
              )}
              {state === 'cleaning' ? t('health.cleaning') : t('hero.cleanNow')}
            </span>
          </>
        )}
      </span>
    </button>
  )
}

export function PcCleanHero(props: HeroProps) {
  const { t } = useTranslation('pcclean')
  const {
    state, reclaimableBytes, selectedCount, selectedBytes, progress,
    scanningLabel, etaSeconds, onScan, onStop, onClean,
    onSelectRecommended, onClearSelection, recommendedCount, lastRunLabel,
  } = props

  return (
    <section className="flex flex-col items-center gap-6 rounded-xl border border-border/70 bg-card px-6 py-8 sm:flex-row sm:items-center sm:justify-center sm:gap-10 sm:px-10">
      <HeroDial
        state={state}
        reclaimableBytes={reclaimableBytes}
        progress={progress}
        onScan={onScan}
        onStop={onStop}
        onClean={onClean}
        disabled={false}
      />

      <div className="flex min-w-0 max-w-[46ch] flex-col items-center gap-3 text-center sm:items-start sm:text-left">
        {state === 'idle' && (
          <>
            <p className="font-heading text-sihao leading-snug font-medium">{t('hero.idleTitle')}</p>
          </>
        )}

        {state === 'scanning' && (
          <>
            <p className="font-heading text-sihao leading-snug font-medium">{t('hero.scanning')}</p>
            <p className="text-sm text-muted-foreground">
              {scanningLabel || t('health.scanning')}
              {etaSeconds && etaSeconds > 0 ? (
                <> · {t('health.eta', { seconds: etaSeconds })}</>
              ) : null}
            </p>
            <Button variant="outline" onClick={onStop}>
              <Square className="size-4" aria-hidden="true" />
              {t('hero.stop')}
            </Button>
          </>
        )}

        {(state === 'ready' || state === 'cleaning') && (
          <>
            <p className="font-heading text-sihao leading-snug font-medium">
              {selectedCount > 0
                ? t('hero.selected', { count: selectedCount, size: formatBytesLabel(selectedBytes) })
                : t('hero.nothingSelected')}
            </p>
            <p className="flex items-start gap-2 text-sm leading-relaxed text-muted-foreground">
              <ShieldCheck className="mt-0.5 size-4 shrink-0 text-success" aria-hidden="true" />
              {t('hero.deleteHint')}
            </p>
            <div className="flex flex-wrap items-center justify-center gap-2 sm:justify-start">
              {recommendedCount > 0 && (
                <Button variant="outline" size="sm" onClick={onSelectRecommended}>
                  {t('hero.selectRecommended')}
                </Button>
              )}
              {selectedCount > 0 && (
                <Button variant="outline" size="sm" onClick={onClearSelection}>
                  {t('hero.clearSelection')}
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={onScan}>
                <Zap className="size-4" aria-hidden="true" />
                {t('hero.rescan')}
              </Button>
            </div>
            {lastRunLabel && (
              <p className={cn('text-2xs text-muted-foreground', NUMERIC_CLASS)}>{lastRunLabel}</p>
            )}
          </>
        )}
      </div>
    </section>
  )
}

/** 只在本文件内用的极小包装，避免把 `formatBytes` 也导进来。 */
function formatBytesLabel(bytes: number): string {
  const { value, unit } = formatBytesParts(bytes)
  return unit ? `${value} ${unit}` : value
}

/**
 * 吸顶细条，圆环滚出视野时才出现。用 IntersectionObserver 而非 scroll 事件：
 * 长列表上 scroll 每秒触发上百次且每次强制同步重排，IO 只在跨阈值时响一次。
 * `top` 的 3.25rem 必须与清理套件顶部标签条同源，否则会错开一两像素露出缝。
 */
export function StickyCleanBar({
  visible,
  selectedCount,
  selectedBytes,
  cleaning,
  canClean,
  onClean,
  onClearSelection,
  score,
  scoreTone,
}: {
  visible: boolean
  selectedCount: number
  selectedBytes: number
  cleaning: boolean
  /**
   * 「点下去有事可做吗」。不能简单用 `selectedCount > 0`：首屏圆环在没勾选时会自动采纳推荐项再清，
   * 只看已勾选数会让同一动作在两处行为不一致（上面能点、滚下来变灰）。
   */
  canClean: boolean
  onClean: () => void
  onClearSelection: () => void
  score?: number
  scoreTone?: 'success' | 'warning' | 'danger'
}) {
  const { t } = useTranslation('pcclean')
  if (!visible) return null

  const toneClass =
    scoreTone === 'success' ? 'text-success'
      : scoreTone === 'warning' ? 'text-warning'
        : 'text-destructive'

  return (
    <div className="sticky top-[3.25rem] z-30 -mx-1 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/70 bg-card/95 px-5 py-3 shadow-sm backdrop-blur">
      <div className="flex min-w-0 items-center gap-3">
        {typeof score === 'number' && (
          <span className={cn('shrink-0 font-medium', toneClass, NUMERIC_CLASS)}>
            {score}
            <span className="ml-0.5 text-2xs text-muted-foreground">{t('score.unit')}</span>
          </span>
        )}
        <span className="min-w-0 truncate text-sm">
          {selectedCount > 0
            ? t('hero.selected', { count: selectedCount, size: formatBytesLabel(selectedBytes) })
            : t('hero.nothingSelected')}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {selectedCount > 0 && (
          <Button variant="ghost" size="sm" onClick={onClearSelection} disabled={cleaning}>
            {t('hero.clearSelection')}
          </Button>
        )}
        <Button size="sm" onClick={onClean} disabled={cleaning || !canClean}>
          {cleaning ? (
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          ) : (
            <Trash2 className="size-4" aria-hidden="true" />
          )}
          {cleaning ? t('health.cleaning') : t('hero.cleanNow')}
        </Button>
      </div>
    </div>
  )
}

// `useHeroOutOfView` 住在 `@/lib/useHeroOutOfView` —— 这个文件只导出组件。
