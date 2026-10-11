import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

// 「纯图标 + 悬停提示」或「图标 + 文字」：全局一个默认值，区域（剪贴板行、笔记行、工具栏）可显式覆盖，
// 未覆盖的跟随全局。纯渲染层偏好，不得做成两套实现。
// 显隐图标联动是改写这条区域覆盖（见 setRegionMode 调用方 IconToolbar）：「显示」覆盖为 'labels'，
// 「隐藏」覆盖为 'icons'，与"记住区域选择"共用同一状态；手动设过的值会被下次显隐覆盖，这是要求的行为。

export type LabelMode = 'icons' | 'labels'

const GLOBAL_STORAGE_KEY = 'ideal1-label-mode'
const REGIONS_STORAGE_KEY = 'ideal1-label-mode-regions'

/** 已知的区域 id——集中列在这里，避免各处手写字符串拼错导致「设置了但没生效」
 * 这种只能靠肉眼排查的 bug。新增区域时在这里加一项。 */
export const LABEL_REGIONS = {
  /** 剪贴板每条历史记录行内的操作按钮 */
  clipboardRow: 'clipboard-row',
  /** 剪贴板顶部的筛选/操作工具栏 */
  clipboardToolbar: 'clipboard-toolbar',
  /** 剪贴板详情面板（右栏顶部）的操作按钮 */
  clipboardDetailToolbar: 'clipboard-detail-toolbar',
  /** 笔记列表每行的操作按钮 */
  notesRow: 'notes-row',
  /** 笔记列表页顶部工具栏 */
  notesToolbar: 'notes-toolbar',
  /** 笔记详情页（编辑器上方）工具栏 */
  notesDetailToolbar: 'notes-detail-toolbar',
  fileManagerToolbar: 'filemanager-toolbar',
  /** 密码列表每行的操作按钮 */
  passwordRow: 'password-row',
  /** 密码页标题行的整页操作（指标选择、导入导出、去重） */
  passwordToolbar: 'password-toolbar',
  /** 密码详情面板（右栏顶部）的操作按钮 */
  passwordDetailToolbar: 'password-detail-toolbar',
  recoveryCodesToolbar: 'recovery-codes-toolbar',
  /** 电脑清理各分区标题栏和列表行里的操作按钮 */
  pcCleanSection: 'pcclean-section',
} as const

export type LabelRegion = (typeof LABEL_REGIONS)[keyof typeof LABEL_REGIONS]

/**
 * 宽度受限的区域永远只显示图标，不受全局偏好影响（约束，不是默认值）。
 * 列表行宽固定（双栏左栏 `minmax(280px, 420px)`）：剪贴板行里两颗带文字按钮占 304px，
 * 把 411px 的行掏空，内容列被压到 5px 竖排；吃宽度的是按钮文字而非数量。
 * 按钮名称由 Tooltip 负责（ActionButton 无条件挂 Tooltip，见其不变量 2）。
 */
const ICON_ONLY_REGIONS: ReadonlySet<string> = new Set<string>([
  LABEL_REGIONS.clipboardRow,
  LABEL_REGIONS.notesRow,
  LABEL_REGIONS.passwordRow,
])

/** 这个区域是不是「只准图标」。设置页据此把开关置灰并说明原因。 */
// eslint-disable-next-line react-refresh/only-export-components -- 同本文件其它导出：这是 provider + 配套常量/hook 的组合文件，为 fast-refresh 纯度拆出去不值得
export function isIconOnlyRegion(region: string): boolean {
  return ICON_ONLY_REGIONS.has(region)
}

function isLabelMode(v: unknown): v is LabelMode {
  return v === 'icons' || v === 'labels'
}

function loadGlobal(): LabelMode {
  try {
    const raw = window.localStorage.getItem(GLOBAL_STORAGE_KEY)
    return isLabelMode(raw) ? raw : 'labels'
  } catch {
    return 'labels'
  }
}

function loadRegions(): Record<string, LabelMode> {
  try {
    const raw = window.localStorage.getItem(REGIONS_STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return {}
    const result: Record<string, LabelMode> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (isLabelMode(value)) result[key] = value
    }
    return result
  } catch {
    // 损坏的持久化状态按「没有任何区域覆盖」处理，不弹错误、不崩溃——跟
    // positionMemory.ts 的自愈策略同一个取向。
    return {}
  }
}

interface LabelModeContextValue {
  /** 全局默认值 */
  globalMode: LabelMode
  setGlobalMode: (mode: LabelMode) => void
  /** 该区域的生效值（有覆盖用覆盖，否则用全局默认） */
  modeFor: (region: string) => LabelMode
  /** 该区域是否有显式覆盖（设置页要据此显示「跟随全局 / 已固定」） */
  hasOverride: (region: string) => boolean
  /** 写入区域覆盖。显隐联动就是调这个。 */
  setRegionMode: (region: string, mode: LabelMode) => void
  /** 清掉区域覆盖，回到跟随全局 */
  clearRegionMode: (region: string) => void
  /** 当前有多少个区域设了覆盖——设置页据此决定要不要显示"清除全部覆盖" */
  overrideCount: number
  /** 一次清掉所有区域覆盖，让全局默认重新生效；否则覆盖会挡住全局改动，无法恢复。 */
  clearAllRegionOverrides: () => void
}

const LabelModeContext = createContext<LabelModeContextValue | null>(null)

export function LabelModeProvider({ children }: { children: ReactNode }) {
  const [globalMode, setGlobalModeState] = useState<LabelMode>(loadGlobal)
  const [regions, setRegions] = useState<Record<string, LabelMode>>(loadRegions)

  useEffect(() => {
    try {
      window.localStorage.setItem(GLOBAL_STORAGE_KEY, globalMode)
    } catch {
      // localStorage 写满等极端情况——本次会话内的偏好仍然生效，只是不持久化
    }
  }, [globalMode])

  useEffect(() => {
    try {
      window.localStorage.setItem(REGIONS_STORAGE_KEY, JSON.stringify(regions))
    } catch {
      // 同上
    }
  }, [regions])

  const modeFor = useCallback(
    // 宽度受限的区域先于一切：偏好和区域覆盖都不能把文字塞回列表行里去，
    // 那会把内容列压成零宽（见 ICON_ONLY_REGIONS 上面的实测数字）。
    (region: string): LabelMode => (isIconOnlyRegion(region) ? 'icons' : regions[region] ?? globalMode),
    [regions, globalMode],
  )

  const hasOverride = useCallback((region: string): boolean => region in regions, [regions])

  const setRegionMode = useCallback((region: string, mode: LabelMode) => {
    setRegions((prev) => (prev[region] === mode ? prev : { ...prev, [region]: mode }))
  }, [])

  const clearRegionMode = useCallback((region: string) => {
    setRegions((prev) => {
      if (!(region in prev)) return prev
      const next = { ...prev }
      delete next[region]
      return next
    })
  }, [])

  const clearAllRegionOverrides = useCallback(() => setRegions({}), [])

  const value = useMemo<LabelModeContextValue>(
    () => ({
      globalMode,
      setGlobalMode: setGlobalModeState,
      modeFor,
      hasOverride,
      setRegionMode,
      clearRegionMode,
      overrideCount: Object.keys(regions).length,
      clearAllRegionOverrides,
    }),
    [globalMode, modeFor, hasOverride, setRegionMode, clearRegionMode, regions, clearAllRegionOverrides],
  )

  return <LabelModeContext.Provider value={value}>{children}</LabelModeContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components -- 同 displayMode.tsx：provider 与其 hook 成对放在一个文件里是标准 React context 写法，为了 fast-refresh 纯度拆两个文件不值得这层间接
export function useLabelModeContext(): LabelModeContextValue {
  const ctx = useContext(LabelModeContext)
  if (!ctx) throw new Error('useLabelMode must be used within a LabelModeProvider')
  return ctx
}

/** 组件里最常用的形态：拿到某区域的生效值 + 一个改它的函数。 */
// eslint-disable-next-line react-refresh/only-export-components -- 同上：这个文件本来就是 provider + 配套 hook 的组合，两个 hook 一视同仁
export function useLabelMode(region: string): {
  mode: LabelMode
  showLabels: boolean
  setMode: (mode: LabelMode) => void
} {
  const ctx = useLabelModeContext()
  const mode = ctx.modeFor(region)
  const setRegionMode = ctx.setRegionMode
  const setMode = useCallback((next: LabelMode) => setRegionMode(region, next), [setRegionMode, region])
  return { mode, showLabels: mode === 'labels', setMode }
}
