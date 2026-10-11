import { useTranslation } from 'react-i18next'
import { Progress } from '@/components/ui/progress'
import { formatBytes } from '@/lib/fileOpsStats'
import { cn } from '@/lib/utils'
import type { UpdateProgress } from '@/shared/ipcTypes'

/**
 * 更新包下载进度。视线顺序：进度条和百分比 → 速度 → 剩余时间、已下/总量、并行连接数。
 * 字节到齐后还要验签（可能几十秒），那段时间显示"校验中"而不是停在 100%。
 */
export function UpdateDownloadProgress({ progress }: { progress: UpdateProgress }) {
  const { t } = useTranslation('settings')
  const { received, total, bytesPerSecond, connections } = progress
  const percent = Math.min(100, (received / total) * 100)
  const verifying = received >= total
  const secondsLeft = bytesPerSecond > 0 ? Math.ceil((total - received) / bytesPerSecond) : null

  return (
    <div className="space-y-1.5" role="status">
      <div className="flex items-center gap-3">
        <Progress
          value={percent}
          aria-label={t('updateInstalling')}
          className={cn('h-1.5 flex-1', verifying && 'animate-pulse')}
        />
        <span className="w-12 shrink-0 text-right text-sm font-medium tabular-nums">{Math.floor(percent)}%</span>
      </div>
      <p className="flex flex-wrap gap-x-3 text-sm text-muted-foreground tabular-nums">
        {verifying ? (
          <span>{t('updateVerifying')}</span>
        ) : (
          <>
            <span className="font-medium text-foreground">{formatBytes(bytesPerSecond)}/s</span>
            {secondsLeft !== null && (
              <span>
                {secondsLeft < 60
                  ? t('updateEtaSeconds', { s: Math.max(1, secondsLeft) })
                  : t('updateEtaMinutes', { m: Math.floor(secondsLeft / 60), s: secondsLeft % 60 })}
              </span>
            )}
            <span>
              {formatBytes(received)} / {formatBytes(total)}
            </span>
            <span>{t('updateConnections', { count: connections })}</span>
          </>
        )}
      </p>
    </div>
  )
}
