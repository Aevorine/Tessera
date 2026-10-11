import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FileLock2, Gauge, History, ShieldCheck, Unlock, XCircle } from 'lucide-react'
import { PageSection } from '@/components/ui/page'
import { cn } from '@/lib/utils'
import {
  formatBytes,
  formatDuration,
  recordRate,
  type FileOpKind,
  type FileOpRecord,
} from '@/lib/fileOpsStats'
import type { ActivityLogEntry } from '@/shared/ipcTypes'

const KIND_ICON: Record<FileOpKind, typeof FileLock2> = {
  encrypt: FileLock2,
  decrypt: Unlock,
  verify: ShieldCheck,
}

const KIND_BAR: Record<FileOpKind, string> = {
  encrypt: 'fill-primary',
  decrypt: 'fill-info',
  verify: 'fill-success',
}


/**
 * 文件页下半屏「活动」面板：左为本次会话每次操作的吞吐柱状图和清单，右为加密存储历史。
 * 指标在顶栏左端；这里两栏以竖线分开，无数据时每栏只一行图标 + 一句话。
 * 窄窗口（xl 以下）改成标题栏右侧两个页签，不上下堆叠，免得历史被挤出一屏。
 */
export function FileOpsDashboard({ records, history }: { records: FileOpRecord[]; history: ActivityLogEntry[] }) {
  const { t } = useTranslation('files')
  const [tab, setTab] = useState<'session' | 'history'>('session')

  const tabs = (
    <div role="tablist" aria-label={t('activityTitle')} className="flex items-center gap-0.5 rounded-lg bg-muted/60 p-0.5 xl:hidden">
      {(['session', 'history'] as const).map((id) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={tab === id}
          onClick={() => setTab(id)}
          className={cn(
            'ds-focus-ring rounded-md px-2.5 py-1 text-sm transition-colors',
            tab === id ? 'bg-background text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {id === 'session' ? t('activitySessionTab') : t('opsHistoryTitle')}
        </button>
      ))}
    </div>
  )

  return (
    <PageSection icon={Gauge} title={t('activityTitle')} actions={tabs} padded={false}>
      <div className="grid xl:grid-cols-[3fr_2fr] xl:divide-x xl:divide-border/70">
        <div className={cn('min-w-0 space-y-4 p-6', tab !== 'session' && 'hidden xl:block')}>
          <ColumnHeading icon={Gauge} label={t('activitySessionTitle')} />
          {records.length === 0 ? (
            <EmptyLine icon={Gauge} text={t('opsEmpty')} />
          ) : (
            <>
              <ThroughputBars records={records} />
              <RecentOps records={records} />
            </>
          )}
        </div>
        <div className={cn('min-w-0 space-y-4 p-6', tab !== 'history' && 'hidden xl:block')}>
          <ColumnHeading icon={History} label={t('opsHistoryTitle')} />
          <HistoryList history={history} />
        </div>
      </div>
    </PageSection>
  )
}

/** 栏标题。只在两栏并排时画——页签模式下标题栏里的页签已经说明了是哪一栏。 */
function ColumnHeading({ icon: Icon, label }: { icon: typeof Gauge; label: string }) {
  return (
    <p className="hidden items-center gap-2 text-sm font-medium text-muted-foreground xl:flex">
      <Icon className="size-4" aria-hidden="true" />
      {label}
    </p>
  )
}

/** 无数据时的一行；不用 EmptyState，那是整页空的大号占位，放进一栏会撑出半屏虚线框。 */
function EmptyLine({ icon: Icon, text }: { icon: typeof Gauge; text: string }) {
  return (
    <p className="flex items-center gap-2.5 py-2 text-sm text-muted-foreground">
      <Icon className="size-4 shrink-0 opacity-60" aria-hidden="true" />
      {text}
    </p>
  )
}

/** 每次操作一根柱子，高度是吞吐。旧的在左、新的在右，一眼看出"这次是不是变慢了"。 */
function ThroughputBars({ records }: { records: FileOpRecord[] }) {
  const { t } = useTranslation('files')
  const points = records
    .slice(0, 40)
    .map((r) => ({ r, rate: recordRate(r) }))
    .filter((p): p is { r: FileOpRecord; rate: number } => p.rate !== null)
    .reverse()
  // 有记录但一条都算不出吞吐（全是文件夹，或都失败了）：不画空坐标，清单照常列。
  if (points.length === 0) return null
  const max = Math.max(...points.map((p) => p.rate))
  const width = 100
  const height = 36
  const gap = 0.8
  const barWidth = Math.max(1, (width - gap * (points.length - 1)) / points.length)
  return (
    <figure>
      <figcaption className="mb-2 flex items-center justify-between text-sm text-muted-foreground">
        <span>{t('opsChartTitle')}</span>
        <span className="tabular">{formatBytes(max)}/s</span>
      </figcaption>
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="h-24 w-full" role="img" aria-label={t('opsChartTitle')}>
        {points.map((p, i) => {
          const h = Math.max(0.8, (p.rate / max) * height)
          return (
            <rect
              key={p.r.id}
              x={i * (barWidth + gap)}
              y={height - h}
              width={barWidth}
              height={h}
              rx={0.6}
              className={cn(KIND_BAR[p.r.kind], 'opacity-80 transition-opacity hover:opacity-100')}
            >
              <title>{`${p.r.name} · ${formatBytes(p.rate)}/s`}</title>
            </rect>
          )
        })}
      </svg>
    </figure>
  )
}

function RecentOps({ records }: { records: FileOpRecord[] }) {
  const { t } = useTranslation('files')
  return (
    <ul className="max-h-64 space-y-0.5 overflow-y-auto">
      {records.slice(0, 50).map((r) => {
        const Icon = r.ok ? KIND_ICON[r.kind] : XCircle
        const rate = recordRate(r)
        return (
          <li key={r.id} className="flex items-center gap-3 rounded-md px-2 py-1.5 text-sm hover:bg-accent/40">
            <Icon
              className={cn('size-4 shrink-0', r.ok ? 'text-muted-foreground' : 'text-destructive')}
              aria-label={t(`opsKind_${r.kind}`)}
            />
            <span className="min-w-0 flex-1 truncate">{r.name}</span>
            <span className="shrink-0 tabular text-muted-foreground">
              {r.bytes !== null ? formatBytes(r.bytes) : '—'}
            </span>
            <span className="w-20 shrink-0 text-end tabular text-muted-foreground">{formatDuration(r.ms)}</span>
            <span className="w-24 shrink-0 text-end tabular">{rate !== null ? `${formatBytes(rate)}/s` : '—'}</span>
          </li>
        )
      })}
    </ul>
  )
}

/** 加密存储的活动时间线里属于文件模块的那部分：跨会话留存，不含大小。 */
function HistoryList({ history }: { history: ActivityLogEntry[] }) {
  const { t } = useTranslation('files')
  if (history.length === 0) return <EmptyLine icon={History} text={t('opsHistoryEmpty')} />
  return (
    <ul className="max-h-80 space-y-0.5 overflow-y-auto">
      {history.map((entry) => {
        const kind: FileOpKind = entry.action === 'decrypt' ? 'decrypt' : 'encrypt'
        const Icon = KIND_ICON[kind]
        return (
          <li key={entry.id} className="flex items-center gap-3 rounded-md px-2 py-1.5 text-sm">
            <Icon className="size-4 shrink-0 text-muted-foreground" aria-label={t(`opsKind_${kind}`)} />
            <span className="min-w-0 flex-1 truncate">{entry.label}</span>
            <span className="shrink-0 tabular text-muted-foreground">
              {new Date(entry.created_at).toLocaleString(undefined, {
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
              })}
            </span>
          </li>
        )
      })}
    </ul>
  )
}
