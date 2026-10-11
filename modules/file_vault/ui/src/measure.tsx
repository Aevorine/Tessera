import React, { Suspense } from 'react'
import ReactDOM from 'react-dom/client'
import { ThemeProvider } from 'next-themes'

import './index.css'
import i18n, { initI18n } from './i18n'
import { applyFontSizeTier, loadFontSizeTier } from './lib/fontSize'
import { AppearanceProvider } from './lib/appearanceContext'
import { applyStoredAppearance } from './lib/appearancePreferences'
import { AppShell } from '@/components/AppShell'
import { PageHeader, PageSection, PageShell } from '@/components/ui/page'
import { TooltipProvider } from '@/components/ui/tooltip'
import { LabelModeProvider } from '@/lib/labelMode'
import { DisplayModeProvider } from '@/lib/displayMode'
import { PasswordScreen } from '@/components/PasswordScreen'
import { ClipboardScreen } from '@/components/ClipboardScreen'
import { NotesScreen } from '@/components/NotesScreen'
import { SettingsScreen } from '@/components/SettingsScreen'
import { FilesPane } from '@/components/FilesPane'
import { CrossDeviceScreen } from '@/components/CrossDeviceScreen'
import { RecoveryCodesScreen } from '@/components/RecoveryCodesScreen'
import { AIChatScreen } from '@/components/AIChatScreen'
import { NetworkSpeedTestScreen } from '@/components/NetworkSpeedTestScreen'
import { FileManagerScreen } from '@/components/FileManagerScreen'
import { SecurityHealthScreen } from '@/components/SecurityHealthScreen'
import { HelpScreen } from '@/components/HelpScreen'
import { DiagnosticLogScreen } from '@/components/DiagnosticLogScreen'

// 布局探针：让真浏览器排版真组件以量出真实像素（jsdom 无布局引擎，getBoundingClientRect 全零）。
// 外层类名与启动顺序（字号档位 -> 外观 -> await initI18n -> 渲染）须照抄 AppShell/main.tsx，
// 高度链上每一环都影响 `calc(100svh−13rem)`，近似就量不出问题。

const params = new URLSearchParams(location.search)
const pane = params.get('pane') ?? 'passwords'
const lang = params.get('lang') ?? 'zh'
/** `?shell=1`：渲染真的 AppShell 而不是复制品。见 Chrome 上方的注释。 */
const useRealShell = params.get('shell') === '1'
try { localStorage.setItem('ideal1-file-vault-lang', lang) } catch { /* 无所谓 */ }

/**
 * 单面板模式用的外壳，是 AppShell 的复制品，抓不到原件自己的毛病（曾有 JSX 注释漏花括号被渲染到屏幕上，
 * 探针仍全绿）。故 `?shell=1` 渲染真的 AppShell（见 Root），复制品仅用于隔离地逐面板快速测量；两种模式都要跑。
 */
function Chrome({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen overflow-hidden bg-background" data-probe="appshell-root">
      <aside
        className="flex w-[184px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar py-5"
        data-probe="sidebar"
      >
        <div className="px-4 text-sm text-muted-foreground">nav</div>
      </aside>
      <main className="flex min-h-0 flex-1 flex-col overflow-hidden" data-probe="main">
        {children}
      </main>
    </div>
  )
}

// 九个模块全给出来，不是 `{}`。设置页会逐个读 `moduleLocks.clipboardCapture`
// 这样的字段——空对象一进去就是 undefined，整页白屏，而那是探针的锅不是应用的。
const NO_LOCKS = {
  files: false, clipboard: false, passwords: false, recoverycodes: false,
  notes: false, ai: false, network: false, filemanager: false, pcclean: false,
} as unknown as React.ComponentProps<typeof SettingsScreen>['moduleLocks']

/**
 * 文档型页面的替身：`main` 改为 overflow-hidden 后滚动职责在 PageShell，
 * 工作台页（fill）不滚，文档型页面必须仍能滚。用合成内容，只验证 PageShell 这一层。
 */
function DocPane() {
  return (
    <PageShell width="wide" data-probe="doc-shell">
      <PageHeader title="Doc" actions={<span className="text-sm">actions</span>} />
      {Array.from({ length: 40 }, (_, i) => (
        <PageSection key={i} title={`第 ${i} 节`}>
          <p className="text-sm">这一段用来把页面撑到一屏装不下，好验证它还能滚。</p>
        </PageSection>
      ))}
    </PageShell>
  )
}

/** 每个面板都要被量：`main` 改为 overflow-hidden 影响全部十几个界面，不止三个双栏工作台。 */
function Pane() {
  switch (pane) {
    case 'clipboard': return <ClipboardScreen ensureFreshlyUnlocked={async () => true} isProfessional />
    case 'notes': return <NotesScreen ensureFreshlyUnlocked={async () => true} isProfessional />
    case 'settings': return <SettingsScreen moduleLocks={NO_LOCKS} onModuleLocksChange={() => {}} isProfessional />
    case 'files': return <FilesPane isProfessional />
    case 'crossdevice': return <CrossDeviceScreen />
    case 'recoverycodes': return <RecoveryCodesScreen isProfessional />
    case 'ai': return <AIChatScreen onGoToSettings={() => {}} isProfessional />
    case 'network': return <NetworkSpeedTestScreen isProfessional />
    case 'filemanager': return <FileManagerScreen isProfessional />
    case 'security': return <SecurityHealthScreen />
    case 'help': return <HelpScreen />
    case 'diagnostics': return <DiagnosticLogScreen />
    case 'doc': return <DocPane />
    default: return <PasswordScreen isProfessional />
  }
}

applyFontSizeTier(loadFontSizeTier())
applyStoredAppearance()

initI18n().then(() => {
  document.documentElement.lang = i18n.language
  document.documentElement.dir = i18n.language === 'ar' ? 'rtl' : 'ltr'
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <ThemeProvider attribute="class" defaultTheme="light" enableSystem={false}>
        <AppearanceProvider>
          {useRealShell ? (
            // 真 AppShell。它自带 DisplayModeProvider / LabelModeProvider /
            // TooltipProvider，不要在外面再套一层。
            <div data-probe="real-shell">
              <AppShell pendingImportPath={null} onPendingImportConsumed={() => {}} />
            </div>
          ) : (
            <TooltipProvider delayDuration={200}>
              <LabelModeProvider>
                <DisplayModeProvider>
                  <Chrome>
                    <Suspense fallback={<div data-probe="suspense">loading</div>}>
                      <Pane />
                    </Suspense>
                  </Chrome>
                </DisplayModeProvider>
              </LabelModeProvider>
            </TooltipProvider>
          )}
        </AppearanceProvider>
      </ThemeProvider>
    </React.StrictMode>,
  )
})
