import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  applyAppearancePreferences,
  loadAppearancePreferences,
  normalizeAppearancePreferences,
  saveAppearancePreferences,
  type AccentFamily,
  type AppearancePreferences,
  type DecorationLevel,
  type ReadingComfort,
  type RuntimeMetricId,
  type VisualStyle,
} from '@/lib/appearancePreferences'

interface AppearanceContextValue {
  preferences: AppearancePreferences
  setVisualStyle(value: VisualStyle): void
  setAccent(value: AccentFamily): void
  setDecoration(value: DecorationLevel): void
  setReadingComfort(value: ReadingComfort): void
  toggleMetric(value: RuntimeMetricId): void
}

const AppearanceContext = createContext<AppearanceContextValue | null>(null)

export function AppearanceProvider({ children }: { children: ReactNode }) {
  const [preferences, setPreferences] = useState<AppearancePreferences>(loadAppearancePreferences)

  useEffect(() => {
    applyAppearancePreferences(document.documentElement, preferences)
    saveAppearancePreferences(preferences)
  }, [preferences])

  const value = useMemo<AppearanceContextValue>(() => {
    const patch = (next: Partial<AppearancePreferences>) => {
      setPreferences((current) => normalizeAppearancePreferences({ ...current, ...next }))
    }

    return {
      preferences,
      setVisualStyle: (visualStyle) => patch({ visualStyle }),
      setAccent: (accent) => patch({ accent }),
      setDecoration: (decoration) => patch({ decoration }),
      setReadingComfort: (readingComfort) => patch({ readingComfort }),
      toggleMetric: (metric) => setPreferences((current) => {
        const selected = current.selectedMetrics.includes(metric)
          ? current.selectedMetrics.filter((item) => item !== metric)
          : [...current.selectedMetrics, metric]
        return normalizeAppearancePreferences({ ...current, selectedMetrics: selected })
      }),
    }
  }, [preferences])

  return <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components -- provider and hook form one cohesive preference API
export function useAppearance(): AppearanceContextValue {
  const context = useContext(AppearanceContext)
  if (!context) throw new Error('useAppearance must be used within AppearanceProvider')
  return context
}
