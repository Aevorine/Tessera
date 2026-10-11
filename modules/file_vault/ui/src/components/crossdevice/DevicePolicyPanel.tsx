import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Ban, ClipboardCopy, FileDown, FileQuestion, Files, Type, type LucideIcon } from 'lucide-react'
import { InfoHint } from '@/components/ui/info-hint'
import { crossDeviceApi } from '@/lib/crossDeviceApi'
import { cn } from '@/lib/utils'

export type ClipPolicy = 'all' | 'text' | 'off'
export type FilePolicy = 'inherit' | 'ask' | 'auto'

interface Option<T extends string> {
  value: T
  icon: LucideIcon
}

const CLIP_OPTIONS: Option<ClipPolicy>[] = [
  { value: 'all', icon: ClipboardCopy },
  { value: 'text', icon: Type },
  { value: 'off', icon: Ban },
]

const FILE_OPTIONS: Option<FilePolicy>[] = [
  { value: 'inherit', icon: Files },
  { value: 'ask', icon: FileQuestion },
  { value: 'auto', icon: FileDown },
]

/** 本设备单独的同步范围，两个方向都按本机设置执行（Go 侧 clippolicy.go），不改线协议。 */
export function DevicePolicyPanel<D extends { device_id: string; clip_policy?: ClipPolicy; file_policy?: FilePolicy }>({
  device,
  onUpdated,
}: {
  device: D
  onUpdated: (device: D) => void
}) {
  const { t } = useTranslation('crossdevice')
  const [busy, setBusy] = useState(false)
  const clip = device.clip_policy ?? 'all'
  const file = device.file_policy ?? 'inherit'

  async function update(patch: { clip_policy?: ClipPolicy; file_policy?: FilePolicy }) {
    setBusy(true)
    try {
      const next = await crossDeviceApi.call<D>('set_device_policy', { device_id: device.device_id, ...patch })
      onUpdated(next)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3 rounded-lg border border-border/70 bg-surface/60 p-3">
      <PolicyRow
        label={t('policyClipLabel')}
        hint={t('policyClipHint')}
        options={CLIP_OPTIONS}
        value={clip}
        busy={busy}
        labelFor={(v) => t(`policyClip.${v}`)}
        onChange={(v) => void update({ clip_policy: v })}
      />
      <PolicyRow
        label={t('policyFileLabel')}
        hint={t('policyFileHint')}
        options={FILE_OPTIONS}
        value={file}
        busy={busy}
        labelFor={(v) => t(`policyFile.${v}`)}
        onChange={(v) => void update({ file_policy: v })}
      />
    </div>
  )
}

function PolicyRow<T extends string>({
  label,
  hint,
  options,
  value,
  busy,
  labelFor,
  onChange,
}: {
  label: string
  hint: string
  options: Option<T>[]
  value: T
  busy: boolean
  labelFor: (value: T) => string
  onChange: (value: T) => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <span className="flex w-24 shrink-0 items-center gap-1.5 text-sm text-muted-foreground">
        {label}
        <InfoHint text={hint} />
      </span>
      <div role="radiogroup" aria-label={label} className="inline-flex flex-wrap gap-1 rounded-lg bg-muted/60 p-1">
        {options.map((opt) => {
          const active = opt.value === value
          const Icon = opt.icon
          return (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={busy}
              onClick={() => !active && onChange(opt.value)}
              className={cn(
                'ds-focus-ring inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-all duration-200',
                active ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                busy && 'opacity-60',
              )}
            >
              <Icon className="size-4" aria-hidden="true" />
              {labelFor(opt.value)}
            </button>
          )
        })}
      </div>
    </div>
  )
}
