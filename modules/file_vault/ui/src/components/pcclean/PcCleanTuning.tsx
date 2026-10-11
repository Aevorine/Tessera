import { useTranslation } from 'react-i18next'
import { RotateCcw, SlidersHorizontal } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { PageSection } from '@/components/ui/page'
import { DEFAULT_TUNING, type TuningState } from '@/lib/pcclean'

/**
 * 可选指标面板。档位（极速/标准/深度）改的是扫哪几类、给多少时间（性能取舍，可替用户定）；
 * 这里改的是什么算垃圾（价值判断，不能替用户定）。
 * 收录标准：改后结果肉眼可见地不同，且用户答得上来；所以没有并发数、缓冲区大小、哈希算法。
 */

const AGE_CHOICES = [0, 1, 3, 7, 30, 90] as const
const STALE_CHOICES = [7, 30, 60, 180, 365] as const
const BIG_FILE_CHOICES = [10, 50, 100, 500, 1024] as const
const DUP_CHOICES = [64, 256, 1024, 10240] as const
const MEMORY_CHOICES = [20, 50, 100, 300] as const
const DEPTH_CHOICES = [1, 2, 3, 4] as const
const SCALE_CHOICES = [
  { value: 0.5, labelKey: 'tuning.scaleFast' },
  { value: 1, labelKey: 'tuning.scaleNormal' },
  { value: 3, labelKey: 'tuning.scalePatient' },
] as const

function Knob({
  id,
  label,
  value,
  choices,
  format,
  onChange,
}: {
  id: string
  label: string
  value: number
  choices: readonly number[]
  format: (value: number) => string
  onChange: (value: number) => void
}) {
  return (
    <div className="min-w-0 space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select value={String(value)} onValueChange={(next) => onChange(Number(next))}>
        <SelectTrigger id={id} className="w-full sm:w-52">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {choices.map((choice) => (
            <SelectItem key={choice} value={String(choice)}>
              {format(choice)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

export function PcCleanTuning({
  tuning,
  onChange,
}: {
  tuning: TuningState
  onChange: (next: TuningState) => void
}) {
  const { t } = useTranslation('pcclean')
  const set = <K extends keyof TuningState>(key: K, value: TuningState[K]) =>
    onChange({ ...tuning, [key]: value })

  const isDefault = (Object.keys(DEFAULT_TUNING) as (keyof TuningState)[])
    .every((key) => tuning[key] === DEFAULT_TUNING[key])

  return (
    <PageSection
      icon={SlidersHorizontal}
      title={t('tuning.title')}
      tone="neutral"
      actions={
        <Button
          variant="outline"
          size="sm"
          onClick={() => onChange({ ...DEFAULT_TUNING })}
          disabled={isDefault}
        >
          <RotateCcw className="size-4" aria-hidden="true" />
          {t('tuning.reset')}
        </Button>
      }
    >
      <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
        <Knob
          id="tune-junk-age"
          label={t('tuning.junkAge')}
          value={tuning.junkAgeDays}
          choices={AGE_CHOICES}
          format={(days) => (days === 0 ? t('health.ageAny') : t('tuning.days', { count: days }))}
          onChange={(value) => set('junkAgeDays', value)}
        />
        <Knob
          id="tune-downloads"
          label={t('tuning.downloadsStale')}
          value={tuning.downloadsStaleDays}
          choices={STALE_CHOICES}
          format={(days) => t('tuning.days', { count: days })}
          onChange={(value) => set('downloadsStaleDays', value)}
        />
        <Knob
          id="tune-bigfile"
          label={t('tuning.bigFileMin')}
          value={tuning.bigFileMinMb}
          choices={BIG_FILE_CHOICES}
          format={(mb) => t('tuning.megabytes', { count: mb })}
          onChange={(value) => set('bigFileMinMb', value)}
        />
        <Knob
          id="tune-dup"
          label={t('tuning.duplicateMin')}
          value={tuning.duplicateMinKb}
          choices={DUP_CHOICES}
          format={(kb) => t('tuning.megabytes', { count: Math.round((kb / 1024) * 100) / 100 })}
          onChange={(value) => set('duplicateMinKb', value)}
        />
        <Knob
          id="tune-memory"
          label={t('tuning.memoryMin')}
          value={tuning.memoryMinMb}
          choices={MEMORY_CHOICES}
          format={(mb) => t('tuning.megabytes', { count: mb })}
          onChange={(value) => set('memoryMinMb', value)}
        />
        <Knob
          id="tune-depth"
          label={t('tuning.analysisDepth')}
          value={tuning.analysisDepth}
          choices={DEPTH_CHOICES}
          format={(levels) => t('tuning.levels', { count: levels })}
          onChange={(value) => set('analysisDepth', value)}
        />
        <div className="min-w-0 space-y-1.5">
          <Label htmlFor="tune-scale">{t('tuning.budgetScale')}</Label>
          <Select
            value={String(tuning.budgetScale)}
            onValueChange={(next) => set('budgetScale', Number(next))}
          >
            <SelectTrigger id="tune-scale" className="w-full sm:w-52">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SCALE_CHOICES.map((choice) => (
                <SelectItem key={choice.value} value={String(choice.value)}>
                  {t(choice.labelKey)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-x-8 gap-y-3 border-t border-border/70 pt-5">
        <div className="flex items-center gap-2.5">
          <Checkbox
            id="tune-restore"
            checked={tuning.restorePoint}
            onCheckedChange={(next) => set('restorePoint', next === true)}
          />
          <Label htmlFor="tune-restore">{t('health.restorePoint')}</Label>
        </div>
        <div className="flex items-center gap-2.5">
          <Checkbox
            id="tune-locked"
            checked={tuning.showLocked}
            onCheckedChange={(next) => set('showLocked', next === true)}
          />
          <Label htmlFor="tune-locked">{t('tuning.showLocked')}</Label>
        </div>
        <div className="flex items-center gap-2.5">
          <Checkbox
            id="tune-junkonly"
            checked={tuning.junkOnly}
            onCheckedChange={(next) => set('junkOnly', next === true)}
          />
          <Label htmlFor="tune-junkonly">{t('tuning.junkOnly')}</Label>
        </div>
      </div>
      <p className="mt-3 max-w-[72ch] text-2xs leading-5 text-muted-foreground">
        {t('health.restorePointHint')}
      </p>
    </PageSection>
  )
}
