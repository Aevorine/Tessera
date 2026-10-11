import { useTranslation } from 'react-i18next'
import { AlertTriangle, CheckCircle2, KeyRound, ShieldCheck, XCircle } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { InfoHint } from '@/components/ui/info-hint'
import { Badge } from '@/components/ui/page'
import { cn } from '@/lib/utils'
import type { VaultMethods } from '@/shared/ipcTypes'

type VerifyOk = Extract<VaultMethods['verify_container']['result'], { ok: true }>

export interface VerifyRow {
  path: string
  name: string
  result?: VerifyOk
  error?: string
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`
}

export function VerifyResultsDialog({ rows, onClose }: { rows: VerifyRow[] | null; onClose: () => void }) {
  const { t } = useTranslation('files')
  const intact = rows?.filter((r) => r.result?.intact).length ?? 0
  const total = rows?.length ?? 0

  return (
    <Dialog open={rows !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className={cn('size-5', intact === total ? 'text-success' : 'text-warning')} aria-hidden="true" />
            {t('verifyDialogTitle', { ok: intact, total })}
            <InfoHint text={t('verifyNoPlaintextHint')} />
          </DialogTitle>
        </DialogHeader>
        {rows && (
          <div className="grid gap-4 sm:grid-cols-[8rem_1fr]">
            <IntactRing intact={intact} total={total} />
            <ul className="max-h-80 space-y-2 overflow-y-auto pr-1">
              {rows.map((row) => (
                <VerifyRowView key={row.path} row={row} />
              ))}
            </ul>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

/** 完好占比的环。一眼看出"全好 / 有坏的"，不用去数列表。 */
function IntactRing({ intact, total }: { intact: number; total: number }) {
  const ratio = total === 0 ? 0 : intact / total
  const radius = 44
  const circumference = 2 * Math.PI * radius
  return (
    <div className="relative mx-auto size-32">
      <svg viewBox="0 0 100 100" className="size-full -rotate-90" aria-hidden="true">
        <circle cx="50" cy="50" r={radius} fill="none" strokeWidth="8" className="stroke-muted" />
        <circle
          cx="50"
          cy="50"
          r={radius}
          fill="none"
          strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - ratio)}
          className={cn(
            'transition-[stroke-dashoffset] duration-700 ease-out',
            ratio === 1 ? 'stroke-success' : ratio === 0 ? 'stroke-destructive' : 'stroke-warning',
          )}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-sihao font-semibold tabular">{intact}</span>
        <span className="text-2xs tabular text-muted-foreground">/ {total}</span>
      </div>
    </div>
  )
}

function VerifyRowView({ row }: { row: VerifyRow }) {
  const { t } = useTranslation('files')
  const r = row.result
  let tone: 'success' | 'danger' | 'warning' = 'warning'
  let status: string
  if (!r) {
    status = row.error ?? t('verifyUnknownError')
  } else if (r.intact) {
    tone = 'success'
    status = t('verifyIntact')
  } else {
    tone = 'danger'
    status = t(`verifyFailure_${r.failure ?? 'chunk'}`, { chunk: (r.failed_chunk ?? 0) + 1 })
  }
  const Icon = tone === 'success' ? CheckCircle2 : tone === 'danger' ? XCircle : AlertTriangle
  const speed = r && r.elapsed_s > 0 ? r.bytes_checked / r.elapsed_s : null
  return (
    <li className="rounded-lg border border-border/70 bg-surface/60 px-3 py-2">
      <div className="flex items-center gap-2">
        <Icon
          className={cn(
            'size-4 shrink-0',
            tone === 'success' ? 'text-success' : tone === 'danger' ? 'text-destructive' : 'text-warning',
          )}
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1 truncate text-sm font-medium" title={row.path}>
          {r?.original_filename ?? row.name}
        </span>
        <Badge tone={tone}>{status}</Badge>
      </div>
      {r && (
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 pl-6 text-2xs tabular text-muted-foreground">
          <span>{r.cipher.toUpperCase()}</span>
          <span className="inline-flex items-center gap-1">
            {r.wrap === 'passphrase' && <KeyRound className="size-3" aria-hidden="true" />}
            {t(`verifyWrap_${r.wrap}`)}
          </span>
          {r.plaintext_size !== null && <span>{formatBytes(r.plaintext_size)}</span>}
          <span>
            {r.chunks_checked}/{r.chunks_expected} {t('verifyChunksUnit')}
          </span>
          {r.kind === 'folder' && r.file_count !== undefined && (
            <span>{t('verifyFolderFiles', { count: r.file_count })}</span>
          )}
          {speed !== null && <span>{formatBytes(speed)}/s</span>}
        </div>
      )}
    </li>
  )
}
