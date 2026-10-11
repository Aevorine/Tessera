import { Suspense, lazy, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useTheme } from 'next-themes'
import { toast } from 'sonner'
import { Toaster } from '@/components/ui/sonner'
import { LoginScreen } from '@/components/LoginScreen'
import { LanguageSwitcher } from '@/components/LanguageSwitcher'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { ShortcutCheatSheet } from '@/components/ShortcutCheatSheet'
import { GlobalIconTooltip } from '@/components/GlobalIconTooltip'
import { extractBackendReason } from '@/lib/backendError'
import { vaultApi } from '@/lib/vaultApi'
import { electronApi } from '@/lib/electronApi'
import { scheduleIdleWork } from '@/lib/runtimeQuality'

// 冷启动路径只保留登录页需要的东西：AppShell（十个面板、CodeMirror、OCR、docx）和
// SetupWizard（仅首次装机）都改 lazy；面板级 lazy 见 AppShell.tsx。
const AppShell = lazy(() => import('@/components/AppShell').then((m) => ({ default: m.AppShell })))
const SetupWizard = lazy(() => import('@/components/SetupWizard').then((m) => ({ default: m.SetupWizard })))

/**
 * 登录页显示之后再预取 AppShell chunk：用户输入密码的几秒空闲足够加载，解锁后直接出界面。
 * lazy 省启动时间，prefetch 防止等待挪到解锁后；失败静默，真正需要时 React.lazy 会再取。
 */
function prefetchAppShell() {
  void import('@/components/AppShell').catch(() => {})
}

type View = 'loading' | 'setup' | 'login' | 'app'

// 缓存上次的「是否有身份库」路由结果（仅一个枚举值，无金库内容）：首屏原要硬等 identity_exists
// 往返（后端冷启动实测 625 ms 纯空白），
// 该答案几乎不变，先按上次画界面，真答案回来再纠正；仅首次运行必须等。
const LAST_VIEW_KEY = 'tessera.lastKnownEntryView'

function readLastKnownView(): View {
  try {
    const v = window.localStorage.getItem(LAST_VIEW_KEY)
    return v === 'login' || v === 'setup' ? v : 'loading'
  } catch {
    // 隐私模式/存储被禁用时读不到。退回原来的行为即可，不能因此起不来。
    return 'loading'
  }
}

function rememberEntryView(view: 'login' | 'setup') {
  try {
    window.localStorage.setItem(LAST_VIEW_KEY, view)
  } catch {
    /* 记不住只是下次再慢一次，不值得打扰用户 */
  }
}

function App() {
  const { t, i18n } = useTranslation('common')
  const { setTheme } = useTheme()
  const [view, setView] = useState<View>(readLastKnownView)
  // 「这次后端重启是我们自己为了锁定金库而做的」。用 ref 不用 state：它只在两个
  // 事件回调之间传一个瞬时标记，不参与渲染，用 state 会白白多一次重绘。
  const lockedOnPurposeRef = useRef(false)
  // "打开方式"选中的 txt 路径：冷启动或未解锁时先存这里，view 变成 'app' 后再交给
  // AppShell/NotesScreen，锁屏时不碰笔记库。
  const [pendingImportPath, setPendingImportPath] = useState<string | null>(null)

  useEffect(() => {
    // 真答案回来后纠正乐观猜测并记住给下次用；猜错只发生在刚删掉身份库等罕见情况，代价仅换一次界面。
    let cancelled = false
    vaultApi
      .call('identity_exists', {})
      .then((res) => {
        if (cancelled) return
        const next: 'login' | 'setup' = res.exists ? 'login' : 'setup'
        rememberEntryView(next)
        // 已经解锁进主界面之后才回来的答案不能把人踢回登录页。
        setView((current) => (current === 'app' ? current : next))
      })
      .catch(() => {
        // 后端起不来时**绝不能停在空白屏**。至少要给出一个能操作的界面，
        // 让用户看得到"重试"和错误提示，而不是对着一片黑等下去。
        if (!cancelled) setView((current) => (current === 'loading' ? 'login' : current))
      })
    return () => {
      cancelled = true
    }
  }, [])

  // 用户输入期间只在主线程和窗口都空闲时预取主界面。
  useEffect(() => {
    if (view !== 'login' && view !== 'setup') return
    return scheduleIdleWork(prefetchAppShell)
  }, [view])

  // 冷启动时主进程只能靠 app.getLocale() 猜语言建菜单；这里用 i18n 已解析好的真实语言纠正一次（见
  // electron/main.ts currentMenuLang）。
  useEffect(() => {
    electronApi.setAppLanguage(i18n.language)
  }, [i18n.language])

  useEffect(() => {
    electronApi.takePendingOpenPath().then((p) => {
      if (p) setPendingImportPath(p)
    })
    return electronApi.onOpenTextFile((p) => setPendingImportPath(p))
  }, [])

  useEffect(() => {
    // 金库被锁（自动规则或手动）：锁定即重启后端，紧接着必有 onBackendRestarted，
    // 先立旗子避免把正常锁定报成「后端进程意外重启」。
    return vaultApi.onVaultLocked(() => {
      lockedOnPurposeRef.current = true
      toast.info(t('vaultLockedToast'), { id: 'vault-locked' })
      setView('login')
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-once subscription
  }, [])

  useEffect(() => {
    // 后端进程崩溃后被自动拉起（见 pythonBridge.ts）：新进程没有旧进程内存
    // 里已解锁的 IMK，不能假装还停在原来的界面上，强制回登录页重新解锁。
    return vaultApi.onBackendRestarted(() => {
      if (lockedOnPurposeRef.current) {
        // 这次重启是"锁定金库"引起的，上面那条已经报过了。
        lockedOnPurposeRef.current = false
        return
      }
      // toast 必须带固定 id：后端连崩几次就调用几次，无 id 会叠出多条相同提示；同 id 则就地更新。
      toast.error(t('backendRestartedToast'), { id: 'backend-restarted' })
      setView('login')
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-once subscription
  }, [])

  useEffect(() => {
    // 后端连续崩溃放弃自动重启（「起不来了」）：必须把 stderr 原样显示到界面，
    // 否则用户只见「后端进程意外重启」而不知原因。
    return vaultApi.onBackendFatal?.((detail) => {
      toast.error(t('backendFatalToast'), {
        id: 'backend-fatal',
        // 只给结论那一行，不给整段调用栈——见 extractBackendReason 的说明。
        description: extractBackendReason(detail),
        // 不自动消失：这是个需要用户去处理的状态，不是一条路过的通知。
        duration: Infinity,
      })
      setView('login')
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-once subscription
  }, [])

  // 主题偏好同步必须挂在这一级而非 AppShell：原生菜单「查看→外观」在登录/初始化页也能点，而
  // AppShell 解锁后才挂载，锁屏时切的主题会丢。
  // 挂载时先主动拉取当前偏好补上错过的切换，之后靠事件同步（见 electron/main.ts
  // applyThemePreference）。
  useEffect(() => {
    electronApi.getThemePreference().then(setTheme)
    return electronApi.onThemeSync((pref) => setTheme(pref))
  }, [setTheme])

  return (
    <ErrorBoundary>
      {/* 只有初始化向导用这个浮动的语言选择器。
          登录页**自己带了一个**（LoginScreen 里 absolute end-6 top-6 那个），
          原来的条件是 view !== 'app'，于是登录页上同时挂着两个选择器，
          两个都写着当前语言、叠在右上角——用户看到的就是"两个简体中文"。
          留下登录页自己那个：它用的是 end-6（跟随书写方向），阿拉伯语界面下
          会正确地跑到左上角，而这里写死的 right-4 不会。 */}
      {view === 'setup' && (
        <div className="fixed end-4 top-4 z-50">
          <LanguageSwitcher />
        </div>
      )}
      {view === 'loading' && <div className="flex min-h-screen items-center justify-center bg-background" />}
      {/* fallback 用和 loading 态一模一样的空白：从"正在问后端有没有身份库"到
          "SetupWizard 的 chunk 正在加载"之间不该出现任何视觉跳变——那两件事对
          用户来说是同一段等待。 */}
      <Suspense fallback={<div className="flex min-h-screen items-center justify-center bg-background" />}>
        {view === 'setup' && <SetupWizard onComplete={() => setView('app')} />}
        {view === 'app' && (
          <AppShell pendingImportPath={pendingImportPath} onPendingImportConsumed={() => setPendingImportPath(null)} />
        )}
      </Suspense>
      {view === 'login' && <LoginScreen onUnlocked={() => setView('app')} />}
      {/* 速查卡挂在最外层：按 ? 在任何界面（含登录页、初始化向导）都能叫出来。
          挂在 AppShell 里的话锁屏状态下按 ? 没反应，而那时用户往往最需要看一眼。 */}
      <ShortcutCheatSheet />
      <GlobalIconTooltip />
      <Toaster />
    </ErrorBoundary>
  )
}

export default App
