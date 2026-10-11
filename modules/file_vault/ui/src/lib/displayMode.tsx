import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

export type DisplayMode = 'simple' | 'professional'

const STORAGE_KEY = 'ideal1-display-mode'

function loadStoredMode(): DisplayMode {
  return localStorage.getItem(STORAGE_KEY) === 'professional' ? 'professional' : 'simple'
}

interface DisplayModeContextValue {
  mode: DisplayMode
  isProfessional: boolean
  setMode: (mode: DisplayMode) => void
  toggleMode: () => void
}

const DisplayModeContext = createContext<DisplayModeContextValue | null>(null)

// 简洁/专业模式只是前端渲染偏好（同 nav-collapsed）：读同一份数据、走同一套 RPC，
// 仅决定是否渲染某块内容，不得做成两套实现。
export function DisplayModeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<DisplayMode>(loadStoredMode)

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, mode)
  }, [mode])

  const value = useMemo<DisplayModeContextValue>(
    () => ({
      mode,
      isProfessional: mode === 'professional',
      setMode: setModeState,
      toggleMode: () => setModeState((m) => (m === 'simple' ? 'professional' : 'simple')),
    }),
    [mode],
  )

  return <DisplayModeContext.Provider value={value}>{children}</DisplayModeContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components -- this file intentionally pairs the provider with its own hook (standard React context pattern); splitting into two files for fast-refresh purity isn't worth the indirection at this app's scale
export function useDisplayMode(): DisplayModeContextValue {
  const ctx = useContext(DisplayModeContext)
  if (!ctx) throw new Error('useDisplayMode must be used within a DisplayModeProvider')
  return ctx
}
