import React from 'react'
import ReactDOM from 'react-dom/client'
import { ThemeProvider } from 'next-themes'
import App from './App.tsx'
import './index.css'
import i18n, { initI18n } from './i18n'
import { applyFontSizeTier, loadFontSizeTier } from './lib/fontSize'
import { AppearanceProvider } from './lib/appearanceContext'
import { applyStoredAppearance } from './lib/appearancePreferences'
import { installDiagnosticsCapture } from './lib/diagnostics'
import { primeBiometricStatus } from './lib/useBiometricStatus'
import { installRuntimeQualityController } from './lib/runtimeQuality'

// 跟 i18n 加载并行：登录页一挂载就要用这个答案决定弹不弹生物识别。
primeBiometricStatus()

// 首次渲染前就应用字号档位，放进 useEffect 会先以 16px 画一帧再跳变；localStorage 同步读取不拖慢启动。
applyFontSizeTier(loadFontSizeTier())
applyStoredAppearance()
installRuntimeQualityController()

// 全局兜底要在渲染之前挂：initI18n 或首帧渲染自己抛异常时，界面是白的，
// 那正是最需要日志的时刻。挂在 App 的 useEffect 里就晚了。
installDiagnosticsCapture()

initI18n().then(() => {
  document.documentElement.lang = i18n.language
  document.documentElement.dir = i18n.language === 'ar' ? 'rtl' : 'ltr'
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
        <AppearanceProvider>
          <App />
        </AppearanceProvider>
      </ThemeProvider>
    </React.StrictMode>,
  )
})
