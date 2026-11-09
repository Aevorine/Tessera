import { createContext, useContext, useEffect, type ReactNode } from 'react'

/**
 * 界面模式。0.1.57 起取消「简洁模式」：界面始终完整（原「专业模式」），不再有切换开关与图标。
 * 想少看一些内容，用每块右上角的 × 关闭，在 设置 › 外观 ›「已关闭的内容」恢复（见 lib/hiddenContent.ts）。
 * 保留这个 Provider / hook 只是为了不改动各页面读 isProfessional 的接口。
 */
export type DisplayMode = 'professional'

/** 旧版本记过的模式偏好键；读到就清掉，免得留着一个已经没有含义的值。 */
const LEGACY_STORAGE_KEY = 'ideal1-display-mode'

interface DisplayModeContextValue {
  mode: DisplayMode
  isProfessional: true
}

const VALUE: DisplayModeContextValue = { mode: 'professional', isProfessional: true }

const DisplayModeContext = createContext<DisplayModeContextValue>(VALUE)

export function DisplayModeProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    try {
      localStorage.removeItem(LEGACY_STORAGE_KEY)
    } catch {
      // 存储不可用无所谓，这个键本来就不再被读取。
    }
  }, [])
  return <DisplayModeContext.Provider value={VALUE}>{children}</DisplayModeContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components -- this file intentionally pairs the provider with its own hook (standard React context pattern)
export function useDisplayMode(): DisplayModeContextValue {
  return useContext(DisplayModeContext)
}
