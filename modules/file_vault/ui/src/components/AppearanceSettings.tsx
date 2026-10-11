import { useTheme } from 'next-themes'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { useDisplayMode, type DisplayMode } from '@/lib/displayMode'
import { useAppearance } from '@/lib/appearanceContext'
import { electronApi } from '@/lib/electronApi'
import {
  ACCENT_FAMILIES,
  DECORATION_LEVELS,
  READING_COMFORT_LEVELS,
  RUNTIME_METRIC_IDS,
  VISUAL_STYLES,
  type AccentFamily,
  type DecorationLevel,
  type ReadingComfort,
  type VisualStyle,
} from '@/lib/appearancePreferences'

type ThemeChoice = 'system' | 'light' | 'dark'

export function AppearanceSettings() {
  const { t } = useTranslation('settings')
  const { theme = 'system', setTheme } = useTheme()
  const { mode, setMode } = useDisplayMode()
  const {
    preferences,
    setVisualStyle,
    setAccent,
    setDecoration,
    setReadingComfort,
    toggleMetric,
  } = useAppearance()

  return (
    <div className="appearance-studio relative space-y-4 overflow-hidden rounded-xl border bg-card/90 p-4 shadow-sm backdrop-blur-sm">
      <div>
        <p className="font-medium">{t('appearanceStudioTitle')}</p>
      </div>

      <ChoiceGroup<DisplayMode>
        label={t('interfaceModeTitle')}
        value={mode}
        options={['simple', 'professional']}
        labelFor={(value) => t(value === 'simple' ? 'interfaceModeSimple' : 'interfaceModeProfessional')}
        onChange={setMode}
      />

      <ChoiceGroup<ThemeChoice>
        label={t('colorModeTitle')}
        value={(theme === 'light' || theme === 'dark' ? theme : 'system')}
        options={['system', 'light', 'dark']}
        labelFor={(value) => t(`colorMode_${value}`)}
        onChange={(next) => {
          setTheme(next)
          void electronApi.setThemePreference(next)
        }}
      />

      <ChoiceGroup<VisualStyle>
        label={t('visualStyleTitle')}
        value={preferences.visualStyle}
        options={[...VISUAL_STYLES]}
        labelFor={(value) => t(`visualStyle_${value}`)}
        onChange={setVisualStyle}
      />

      <ChoiceGroup<AccentFamily>
        label={t('accentTitle')}
        value={preferences.accent}
        options={[...ACCENT_FAMILIES]}
        labelFor={(value) => t(`accent_${value}`)}
        onChange={setAccent}
        swatch
      />

      <ChoiceGroup<DecorationLevel>
        label={t('decorationTitle')}
        value={preferences.decoration}
        options={[...DECORATION_LEVELS]}
        labelFor={(value) => t(`decoration_${value}`)}
        onChange={setDecoration}
      />

      {/* 阅读舒适度排在装饰强度之后、指标选择之前：它跟上面几组一样是"整套 UI
          长什么样"，而下面那组是"面板里显示哪些数"。两类不该混在一起。
          hint 里写明这一档会降低对比度，是因为"看起来变灰了"如果没人解释，
          用户第一反应是屏幕坏了或者渲染出错。 */}
      <ChoiceGroup<ReadingComfort>
        label={t('readingComfortTitle')}
        value={preferences.readingComfort}
        options={[...READING_COMFORT_LEVELS]}
        labelFor={(value) => t(`readingComfort_${value}`)}
        onChange={setReadingComfort}
      />

      <div className="space-y-2">
        <div>
          <p className="text-sm font-medium">{t('metricsSelectionTitle')}</p>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          {RUNTIME_METRIC_IDS.map((metric) => (
            <div key={metric} className="flex min-h-10 items-center gap-2 rounded-lg border bg-background/60 px-3">
              <Checkbox
                id={`desktop-metric-${metric}`}
                checked={preferences.selectedMetrics.includes(metric)}
                onCheckedChange={() => toggleMetric(metric)}
              />
              <Label htmlFor={`desktop-metric-${metric}`} className="flex-1 cursor-pointer text-sm">
                {t(`metric_${metric}`)}
              </Label>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function ChoiceGroup<T extends string>({
  label,
  value,
  options,
  labelFor,
  onChange,
  swatch = false,
}: {
  label: string
  value: T
  options: T[]
  labelFor: (value: T) => string
  onChange: (value: T) => void
  swatch?: boolean
}) {
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">{label}</p>
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={label}>
        {options.map((option) => (
          <Button
            key={option}
            type="button"
            size="sm"
            variant={value === option ? 'default' : 'outline'}
            role="radio"
            aria-checked={value === option}
            onClick={() => onChange(option)}
          >
            {swatch && <span aria-hidden className={`accent-swatch accent-swatch-${option}`} />}
            {labelFor(option)}
          </Button>
        ))}
      </div>
    </div>
  )
}
