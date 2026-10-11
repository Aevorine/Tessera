export const VISUAL_STYLES = ['native', 'oriental-tech'] as const
/** 九套强调色，顺序按色相环排（青→蓝→靛→紫→玫→赤→黏土→金→橄榄），使色板成连续光谱。
 *  index.css 里每套有浅/深两组值，淡化色（--accent-soft / --accent-line）由 color-mix 派生。
 *  默认色由 DEFAULT_APPEARANCE_PREFERENCES 决定，不靠调整排序暗示。 */
export const ACCENT_FAMILIES = [
  'forest',
  'sky',
  'indigo',
  'violet',
  'rose',
  'ember',
  'clay',
  'gold',
  'olive',
] as const
export const DECORATION_LEVELS = ['off', 'subtle', 'standard'] as const
/**
 * 阅读舒适度，第四条正交轴：`warm` 同时降对比并偏暖，不并入视觉风格/装饰强度，
 * 否则"护眼"与"东方科技风"变成二选一。
 * 实现全在 index.css 的 `html[data-reading-comfort="warm"]`，color-mix 派生，新增强调色自动适用；
 * 正文对比度实测 6.8:1 以上（WCAG AA 为 4.5:1）。
 */
export const READING_COMFORT_LEVELS = ['standard', 'warm'] as const
export const RUNTIME_METRIC_IDS = [
  'cpu',
  'workingSet',
  'privateMemory',
  'systemMemory',
  'processCount',
  'uptime',
  'rendererHeap',
  'ipcLatency',
  // 单次往返只是一个样本，遇到一次 GC 尖峰就跳一下，看不出"平时快不快"。
  // P50 是常态、P95 是"最难受的那 5%"——卡顿投诉对应的正是后者。
  'ipcLatencyP50',
  'ipcLatencyP95',
  // 渲染帧率。前面几项都是"后端忙不忙"，这一项是"界面顺不顺"，两者会分家：
  // 后端闲着而界面掉帧（大列表重排）在这个应用里是真实存在的一类问题。
  'frameRate',
] as const

export type VisualStyle = (typeof VISUAL_STYLES)[number]
export type AccentFamily = (typeof ACCENT_FAMILIES)[number]
export type DecorationLevel = (typeof DECORATION_LEVELS)[number]
export type ReadingComfort = (typeof READING_COMFORT_LEVELS)[number]
export type RuntimeMetricId = (typeof RUNTIME_METRIC_IDS)[number]

export interface AppearancePreferences {
  visualStyle: VisualStyle
  accent: AccentFamily
  decoration: DecorationLevel
  readingComfort: ReadingComfort
  selectedMetrics: RuntimeMetricId[]
}

export const DEFAULT_APPEARANCE_PREFERENCES: AppearancePreferences = {
  visualStyle: 'native',
  // 默认从 forest（青绿）改成 clay（黏土橙）。老用户不受影响：偏好一旦存过就
  // 读存的那份，这个默认值只对"从没设置过"的新安装生效。
  accent: 'clay',
  decoration: 'subtle',
  // 默认关：护眼档是**用户主动选的取舍**（少一点对比换久一点耐看），
  // 不该替所有人决定。老用户升级上来看到的界面跟昨天一模一样。
  readingComfort: 'standard',
  selectedMetrics: ['cpu', 'workingSet', 'systemMemory', 'ipcLatency'],
}

const STORAGE_KEY = 'ideal1-appearance-preferences-v1'

function isOneOf<const T extends readonly string[]>(values: T, value: unknown): value is T[number] {
  return typeof value === 'string' && values.includes(value)
}

function cloneDefaults(): AppearancePreferences {
  return {
    ...DEFAULT_APPEARANCE_PREFERENCES,
    selectedMetrics: [...DEFAULT_APPEARANCE_PREFERENCES.selectedMetrics],
  }
}

/** Turns persisted/untrusted JSON into the small set of values our CSS and UI support. */
export function normalizeAppearancePreferences(value: unknown): AppearancePreferences {
  if (typeof value !== 'object' || value === null) return cloneDefaults()
  const candidate = value as Record<string, unknown>

  const visualStyle = isOneOf(VISUAL_STYLES, candidate.visualStyle)
    ? candidate.visualStyle
    : DEFAULT_APPEARANCE_PREFERENCES.visualStyle
  const accent = isOneOf(ACCENT_FAMILIES, candidate.accent)
    ? candidate.accent
    : DEFAULT_APPEARANCE_PREFERENCES.accent
  const decoration = isOneOf(DECORATION_LEVELS, candidate.decoration)
    ? candidate.decoration
    : DEFAULT_APPEARANCE_PREFERENCES.decoration
  const readingComfort = isOneOf(READING_COMFORT_LEVELS, candidate.readingComfort)
    ? candidate.readingComfort
    : DEFAULT_APPEARANCE_PREFERENCES.readingComfort

  const selectedMetrics = Array.isArray(candidate.selectedMetrics)
    ? [...new Set(candidate.selectedMetrics.filter((metric): metric is RuntimeMetricId =>
      isOneOf(RUNTIME_METRIC_IDS, metric),
    ))]
    : []

  return {
    visualStyle,
    accent,
    decoration,
    readingComfort,
    selectedMetrics: selectedMetrics.length > 0
      ? selectedMetrics
      : [...DEFAULT_APPEARANCE_PREFERENCES.selectedMetrics],
  }
}

export function loadAppearancePreferences(
  storage: Pick<Storage, 'getItem'> = localStorage,
): AppearancePreferences {
  try {
    const raw = storage.getItem(STORAGE_KEY)
    return raw ? normalizeAppearancePreferences(JSON.parse(raw)) : cloneDefaults()
  } catch {
    return cloneDefaults()
  }
}

export function saveAppearancePreferences(
  preferences: AppearancePreferences,
  storage: Pick<Storage, 'setItem'> = localStorage,
): void {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(normalizeAppearancePreferences(preferences)))
  } catch {
    // Appearance is optional state. Quota/privacy errors must never block the application.
  }
}

interface AppearanceRoot {
  setAttribute(name: string, value: string): void
}

export function applyAppearancePreferences(
  root: AppearanceRoot,
  preferences: AppearancePreferences,
): void {
  const safe = normalizeAppearancePreferences(preferences)
  root.setAttribute('data-visual-style', safe.visualStyle)
  root.setAttribute('data-accent', safe.accent)
  root.setAttribute('data-decoration', safe.decoration)
  root.setAttribute('data-reading-comfort', safe.readingComfort)
}

export function applyStoredAppearance(root: AppearanceRoot = document.documentElement): AppearancePreferences {
  const preferences = loadAppearancePreferences()
  applyAppearancePreferences(root, preferences)
  return preferences
}
