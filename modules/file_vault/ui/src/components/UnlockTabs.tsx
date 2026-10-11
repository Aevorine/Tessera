import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Eye,
  Fingerprint,
  KeyRound,
  KeySquare,
  Loader2,
  Mail,
  RotateCcw,
  ScanFace,
  ShieldCheck,
  X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { TabsList, TabsTrigger } from '@/components/ui/tabs'
import { vaultApi } from '@/lib/vaultApi'
import { translateError } from '@/i18n/errors'
import type { BiometricStatus } from '@/lib/useBiometricStatus'
import { useWindowActivation } from '@/lib/useWindowActivation'
import type { BiometricModality } from '@/shared/ipcTypes'

// Shared by UnlockDialog.tsx (popup) and LoginScreen.tsx (full page): same five factor tabs.

/** 启动时默认选中的解锁方式：生物识别排第一并自动发起 Windows Hello，不可用时 `BiometricTab`
 *  经 onUnavailable 切到密码。值仍叫 'fingerprint'：它同时是 Tabs value、后端槽位名
 *  SLOT_FINGERPRINT 和测试断言对象；界面显示名由 MODALITY_PRESENTATION 决定。 */
export const DEFAULT_UNLOCK_FACTOR = 'fingerprint'

// 「用户照着别处敲进来的一串码」的统一样式，全应用只这两档，按码长是否固定区分：
// CODE_INPUT_CLASS 定长码（TOTP/邮箱验证码/配对码 6 位）：居中 + 宽字距，便于数位数。
// KEY_INPUT_CLASS 变长密钥（恢复密钥）：同样等宽字号但不居中、字距收窄，避免光标左移和撑出输入框。
// 不写死高度（由 components/ui/input.tsx 决定）；text-lg 在 typographyScale.test.mjs 白名单内。
// 别处需要同样输入框请引用这两个常量，不要抄类名。
export const CODE_INPUT_CLASS = 'text-center font-mono text-lg tracking-[0.35em]'
export const KEY_INPUT_CLASS = 'font-mono text-lg tracking-[0.08em]'

/** 这两个错误表示「这台机器/身份根本用不了生物识别」而非「这次没验过」：
 *  自动尝试遇到必须静默换路，不能弹红框。 */
const FINGERPRINT_UNUSABLE_ERRORS = new Set([
  'auth.fingerprint_not_bound',
  'auth.fingerprint_binding_stale',
])

/**
 * 自动验证最多锁住窗口多久，即登录页最长多久点不动。
 * Windows Hello 验证框对应用窗口是模态的（验证期间 IsWindowEnabled 为 False），连"取消"也点不了；
 * 提示框若没浮到最前（多显示器、远程桌面），自动发起会让登录页彻底卡住，故 25 秒后放行并落到密码。
 */
const AUTO_ATTEMPT_TIMEOUT_SECONDS = 25

/** 每种模态显示成什么。图标和文案都跟着真实硬件走——在一台只有指纹的机器上
 *  画一张人脸，用户会一直等一个永远不会出现的摄像头提示。 */
const MODALITY_PRESENTATION: Record<BiometricModality, { icon: LucideIcon; tabKey: string; buttonKey: string; hintKey: string }> = {
  face: { icon: ScanFace, tabKey: 'tabFace', buttonKey: 'faceButton', hintKey: 'faceInitialStatus' },
  fingerprint: {
    icon: Fingerprint,
    tabKey: 'tabFingerprint',
    buttonKey: 'fingerprintButton',
    hintKey: 'fingerprintInitialStatus',
  },
  iris: { icon: Eye, tabKey: 'tabIris', buttonKey: 'irisButton', hintKey: 'irisInitialStatus' },
}

/** 探测不到生物识别硬件（或探测未返回）时的呈现。用产品名「Windows Hello」而非"指纹"，
 *  不猜传感器类型；仍显示该标签，因为金库可能建于另一台机器，用户需知道这个因子存在。 */
const NEUTRAL_PRESENTATION = {
  icon: Fingerprint,
  tabKey: 'tabBiometric',
  buttonKey: 'biometricButton',
  hintKey: 'biometricInitialStatus',
}

function presentationFor(modality: BiometricModality | null | undefined) {
  return modality ? MODALITY_PRESENTATION[modality] : NEUTRAL_PRESENTATION
}

type UnlockOutcome = { ok: true } | { ok: false; error?: string; error_params?: Record<string, string | number> }

/**
 * 把解锁 RPC 包成"无论如何都有结果"。`vaultApi.call` 会抛：error 信封在 pythonBridge 里是 reject，
 * 若不包，`setBusy(false)` 执行不到，按钮永远转圈禁用。抛出的 Error.message 被还原成
 * `{ok:false, error:<码>}`，下游 translateError 不必区分返回还是抛出。
 * "message 就是错误码"由 lib/vaultApi.ts 保证（ipcRenderer.invoke 在渲染端会加
 * `Error invoking remote method ...` 前缀，已在 IPC 边界剥掉，见 lib/ipcError.ts）。
 */
async function attemptUnlock(call: () => Promise<UnlockOutcome>): Promise<UnlockOutcome> {
  try {
    return await call()
  } catch (err) {
    const code = err instanceof Error ? err.message.trim() : ''
    return { ok: false, error: code || undefined }
  }
}

/**
 * 五个解锁方式的标签栏，登录页和强制重新验证对话框共用。
 * 布局永远五等分一行，文字自己折行：`grid-cols-5` 单用会因基础样式 whitespace-nowrap 重叠，
 * flex-wrap 则行数随语言变化。故加 `whitespace-normal`、图标摞在文字上方（`flex-col`），
 * 并用 `min-h-16` 定高，保证任何语言和窗口宽度下五个因子都可见。
 */
export function UnlockFactorTabsList({ modality }: { modality?: BiometricModality | null } = {}) {
  const { t } = useTranslation('login')
  // 第一个标签随本机真实模态变化（人脸/指纹）；探测未回（modality 为空）时用中性指纹呈现，避免图标闪
  // 烁。
  const bio = presentationFor(modality)
  const factors = [
    { value: 'fingerprint', label: t(bio.tabKey), icon: bio.icon },
    { value: 'password', label: t('tabPassword'), icon: KeyRound },
    { value: 'totp', label: t('tabTotp'), icon: ShieldCheck },
    { value: 'email', label: t('tabEmail'), icon: Mail },
    { value: 'recovery', label: t('tabRecovery'), icon: KeySquare },
  ]
  return (
    <TabsList className="grid h-auto w-full grid-cols-5 gap-1.5 bg-surface-strong p-1.5 group-data-[orientation=horizontal]/tabs:h-auto">
      {factors.map((factor) => {
        const Icon = factor.icon
        return (
          <TabsTrigger
            key={factor.value}
            className="h-auto min-h-16 flex-col gap-1.5 whitespace-normal px-2 py-2.5 text-center leading-snug data-[state=active]:bg-card data-[state=active]:text-primary"
            value={factor.value}
          >
            <Icon className="size-5 shrink-0" aria-hidden="true" />
            {factor.label}
          </TabsTrigger>
        )
      })}
    </TabsList>
  )
}

/** 每个解锁方式面板的统一外壳：一样的上下留白、一样的错误位置、一样的主按钮
 *  在最底下且撑满宽度。五个面板之间来回切换时不会有任何元素跳位。 */
function FactorPanel({ children }: { children: React.ReactNode }) {
  return <div className="space-y-5 pt-5">{children}</div>
}

function FactorError({ message }: { message: string }) {
  if (!message) return null
  return (
    <Alert variant="destructive">
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  )
}

export function PasswordTab({ onUnlocked }: { onUnlocked: () => void }) {
  const { t } = useTranslation('login')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function handleUnlock() {
    setBusy(true)
    try {
      const res = await attemptUnlock(() => vaultApi.call('unlock_password', { password }))
      if (res.ok) onUnlocked()
      else setError(res.error ? translateError(res.error, res.error_params) : t('unlockFailedFallback'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <FactorPanel>
      <div className="space-y-2">
        <Label htmlFor="unlock-password">{t('passwordLabel')}</Label>
        <Input
          id="unlock-password"
          type="password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleUnlock()}
        />
      </div>
      <FactorError message={error} />
      <Button className="w-full" onClick={handleUnlock} disabled={busy}>
        {busy && <Loader2 className="size-4 animate-spin" />}
        {t('unlockButton')}
      </Button>
    </FactorPanel>
  )
}

export function TotpTab({ onUnlocked }: { onUnlocked: () => void }) {
  const { t } = useTranslation('login')
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function handleUnlock() {
    setBusy(true)
    try {
      const res = await attemptUnlock(() => vaultApi.call('unlock_totp', { code }))
      if (res.ok) onUnlocked()
      else setError(res.error ? translateError(res.error, res.error_params) : t('unlockFailedFallback'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <FactorPanel>
      <div className="space-y-2">
        <Label htmlFor="unlock-totp">{t('totpLabel')}</Label>
        <Input
          id="unlock-totp"
          inputMode="numeric"
          autoComplete="one-time-code"
          className={CODE_INPUT_CLASS}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleUnlock()}
        />
      </div>
      <FactorError message={error} />
      <Button className="w-full" onClick={handleUnlock} disabled={busy}>
        {busy && <Loader2 className="size-4 animate-spin" />}
        {t('unlockButton')}
      </Button>
    </FactorPanel>
  )
}

export function EmailTab({ onUnlocked }: { onUnlocked: () => void }) {
  const { t } = useTranslation('login')
  const [status, setStatus] = useState('')
  const [sent, setSent] = useState(false)
  const [sending, setSending] = useState(false)
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => setStatus(t('emailInitialStatus')), [t])

  async function handleSend() {
    setSending(true)
    setStatus(t('emailSending'))
    try {
      const res = await attemptUnlock(() => vaultApi.call('unlock_email_start', {}))
      if (res.ok) {
        setSent(true)
        setStatus(t('emailSentStatus', { address: (res as { email_address?: string }).email_address }))
      } else {
        setStatus(res.error ? translateError(res.error, res.error_params) : t('emailSendFailedFallback'))
      }
    } finally {
      setSending(false)
    }
  }

  async function handleUnlock() {
    if (!sent) {
      setError(t('emailCodeRequired'))
      return
    }
    setBusy(true)
    try {
      const res = await attemptUnlock(() => vaultApi.call('unlock_email_finish', { code }))
      if (res.ok) onUnlocked()
      else setError(res.error ? translateError(res.error, res.error_params) : t('unlockFailedFallback'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <FactorPanel>
      <p className="rounded-lg border border-border bg-surface px-3 py-2.5 text-sm text-muted-foreground">
        {status}
      </p>
      <Button variant="secondary" className="w-full" onClick={handleSend} disabled={sending}>
        {sending ? <Loader2 className="size-4 animate-spin" /> : <Mail className="size-4" />}
        {t('sendCodeButton')}
      </Button>
      <div className="space-y-2">
        <Label htmlFor="unlock-email-code">{t('emailCodeLabel')}</Label>
        <Input
          id="unlock-email-code"
          inputMode="numeric"
          autoComplete="one-time-code"
          className={CODE_INPUT_CLASS}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleUnlock()}
        />
      </div>
      <FactorError message={error} />
      <Button className="w-full" onClick={handleUnlock} disabled={busy}>
        {busy && <Loader2 className="size-4 animate-spin" />}
        {t('unlockButton')}
      </Button>
    </FactorPanel>
  )
}

export function RecoveryTab({ onUnlocked }: { onUnlocked: () => void }) {
  const { t } = useTranslation('login')
  const [key, setKey] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function handleUnlock() {
    setBusy(true)
    try {
      const res = await attemptUnlock(() => vaultApi.call('unlock_recovery', { recovery_key: key }))
      if (res.ok) onUnlocked()
      else setError(res.error ? translateError(res.error, res.error_params) : t('unlockFailedFallback'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <FactorPanel>
      <div className="space-y-2">
        <Label htmlFor="unlock-recovery">{t('recoveryKeyLabel')}</Label>
        <Input
          id="unlock-recovery"
          autoComplete="off"
          spellCheck={false}
          className={KEY_INPUT_CLASS}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleUnlock()}
        />
      </div>
      <FactorError message={error} />
      <Button className="w-full" onClick={handleUnlock} disabled={busy}>
        {busy && <Loader2 className="size-4 animate-spin" />}
        {t('unlockButton')}
      </Button>
    </FactorPanel>
  )
}

export function BiometricTab({
  onUnlocked,
  onUnavailable,
  onUseAnotherFactor,
  autoStart = false,
  status: bio,
}: {
  onUnlocked: () => void
  /** 这台机器用不了生物识别时回调，调用方据此切到别的解锁方式。不传就原地
   *  留着，用户仍可手动切标签。 */
  onUnavailable?: () => void
  /** 用户主动要求换一种方式。跟 onUnavailable 分开：那个是"机器不行"，这个是
   *  "我不想等了"，后者必须先把在途的系统提示框撤掉再切走（见 handleCancel）。 */
  onUseAnotherFactor?: () => void
  /** 挂载即自动发起一次验证。登录页和设置里的强制复验**都开**这个——「要密码
   *  的地方一律先自动弹生物识别」是明确的产品要求，复验弹窗不再例外。 */
  autoStart?: boolean
  /** `useBiometricStatus()` 的结果。null 表示还在探测。 */
  status: BiometricStatus | null
}) {
  const { t } = useTranslation('login')
  const [statusText, setStatusText] = useState('')
  const [verifying, setVerifying] = useState(false)
  const [error, setError] = useState('')
  // 上一次是"超时"而不是"验错了"——超时后按钮改成「重新验证」，见 handleVerify。
  const [timedOut, setTimedOut] = useState(false)
  // 用户点了取消：后端会如实报"验证失败"（Windows 里撤销与按错手指同结果），用它压掉红字。
  // 用 ref 而非 state：handleVerify 闭包需读到最新值。
  const canceledRef = useRef(false)
  // 已经为哪一次"窗口可见"自动发起过。-1 = 还没有。
  const autoGeneration = useRef(-1)
  const verifyingRef = useRef(false)
  const activation = useWindowActivation()
  // onUnavailable 放进 ref：自动触发的 effect 必须只跑一次，又要调到最新回调。
  const onUnavailableRef = useRef(onUnavailable)
  onUnavailableRef.current = onUnavailable

  const presentation = presentationFor(bio?.preferred)
  const Icon = presentation.icon
  // 链条上除了首选之外的其它模态。有人脸也有指纹时，用户该知道"按传感器也行"，
  // 而不是对着一个只写了人脸的界面等摄像头。
  const alternatives = (bio?.chain ?? []).filter((m) => m !== bio?.preferred)

  useEffect(() => setStatusText(t(presentation.hintKey)), [t, presentation.hintKey])

  async function handleVerify(isAutoAttempt = false) {
    if (verifyingRef.current) return
    verifyingRef.current = true
    canceledRef.current = false
    setVerifying(true)
    setStatusText(t('fingerprintVerifying'))
    setError('')
    setTimedOut(false)
    let res: UnlockOutcome
    try {
      res = await attemptUnlock(() =>
        vaultApi.call(
          'unlock_fingerprint',
          isAutoAttempt ? { timeout_seconds: AUTO_ATTEMPT_TIMEOUT_SECONDS } : {},
        ),
      )
    } finally {
      // finally 而不是"await 后面那一行"：见 attemptUnlock 的说明。这个按钮
      // 卡在禁用态就等于用户再也验不了指纹，只能重启应用。
      verifyingRef.current = false
      setVerifying(false)
    }
    if (res.ok) {
      onUnlocked()
      return
    }
    setStatusText(t(presentation.hintKey))
    if (canceledRef.current) {
      // 用户自己撤的。不报错、不改按钮文案，让面板干净地回到初始态。
      return
    }
    if (res.error && FINGERPRINT_UNUSABLE_ERRORS.has(res.error)) {
      // 这台机器/这个金库压根用不了生物识别。自动尝试时静默降到下一层（密码）；
      // 手动点按钮时才把原因显示出来——那种情况下用户是主动问"为什么不行"。
      if (isAutoAttempt) {
        onUnavailableRef.current?.()
        return
      }
      setError(translateError(res.error, res.error_params))
      return
    }
    // 超时只是"这次没验成"，不降级为"本机不可用"，而是把按钮换成"重新验证"。
    const isTimeout = res.error === 'fingerprint.verification_timeout'
    setTimedOut(isTimeout)
    setError(res.error ? translateError(res.error, res.error_params) : t('unlockFailedFallback'))

    // 自动那次超时就替用户切到密码：验证框很可能没浮到前面，期间窗口被系统禁用，用户自己切不了。
    // 手动重试不切。
    if (isAutoAttempt && isTimeout) onUseAnotherFactor?.()
  }

  /** 撤销在途的验证，是验证框没弹到最前时用户唯一的出路。走协商路径（后端往辅助程序 stdin
   *  写 CANCEL，由它调 IAsyncInfo::Cancel），提示框正常收场主窗口才会被重新启用。失败不弹错。 */
  async function handleCancel() {
    canceledRef.current = true
    try {
      await vaultApi.call('unlock_fingerprint_cancel', {})
    } catch {
      // 后端没应答/没有在途验证。两种情况用户都不需要知道。
    }
  }

  async function handleUseAnotherFactor() {
    // 顺序要紧：先撤掉提示框再切标签。反过来的话用户会看到密码框，却因为
    // 那个看不见的模态框还在而一个字都打不进去。
    if (verifying) await handleCancel()
    onUseAnotherFactor?.()
  }

  // 自动发起一次验证，必须等 `bio` 探测回来：
  //   · 无可用生物识别（或金库没绑）→ 不弹 Hello，直接降到密码。
  //   · 有可用 → 发起；具体模态由系统按用户注册项决定，应用不应指定（否则能把用户引向最弱模态）。
  //   · 返回"不可用"类错误 → onUnavailable 降下一层。
  // 只在窗口可见时发起，每次重新可见（visibilitychange）再发起；托盘/锁屏/睡眠/静默启动时不能弹框。
  // 用缓存状态（useBiometricStatus）；generation 同时挡住 StrictMode 的双重挂载。
  useEffect(() => {
    if (!autoStart || bio === null || !activation.visible) return
    if (autoGeneration.current === activation.generation || verifyingRef.current) return
    autoGeneration.current = activation.generation
    if (!bio.available || !bio.bound) {
      onUnavailableRef.current?.()
      return
    }
    handleVerify(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart, bio, activation.visible, activation.generation])

  return (
    <FactorPanel>
      {/* 生物识别是默认方式，所以它的面板要一眼看出"正在等你验证"。用一个会
          呼吸的大图标 + 一句状态，比一行灰字清楚得多。 */}
      <div className="flex flex-col items-center gap-3 rounded-xl border border-accent-line bg-accent-soft px-6 py-7 text-center">
        <span
          aria-hidden="true"
          className={`ds-icon-chip size-16 border-accent-line bg-card text-primary ${verifying ? 'animate-pulse' : ''}`}
        >
          <Icon className="size-8" />
        </span>
        <p className="max-w-[42ch] text-sm leading-relaxed text-muted-foreground">{statusText}</p>
        {alternatives.length > 0 && (
          <p className="text-sm text-muted-foreground">
            {t('alsoAvailable', {
              methods: alternatives.map((m) => t(MODALITY_PRESENTATION[m].tabKey)).join(t('methodSeparator')),
            })}
          </p>
        )}
      </div>
      <FactorError message={error} />
      <Button className="w-full" onClick={() => handleVerify(false)} disabled={verifying}>
        {verifying ? (
          <Loader2 className="size-4 animate-spin" />
        ) : timedOut ? (
          <RotateCcw className="size-4" />
        ) : (
          <Icon className="size-4" />
        )}
        {timedOut ? t('biometricRetryButton') : t(presentation.buttonKey)}
      </Button>
      {/* 出路。刻意不跟着 verifying 变灰。

          要说清楚它们**什么时候真的能点**：验证框一旦弹出来，系统会禁用整个应用
          窗口，那时候这两个按钮和页面上其它任何东西一样收不到点击。所以它们不是
          模态期间的逃生门——那一层由 AUTO_ATTEMPT_TIMEOUT_SECONDS 兜（到点自动
          放行并切到密码）。

          它们能派上用场的是另外几种情况：验证框还没起来或已经关掉、辅助程序压根
          没拉起来、以及走无父窗口的回退路径（那条路不产生模态，窗口全程可点）。
          这几种情况下用户在屏幕上就是干等，没有这两个按钮就只能重启应用。 */}
      {verifying && (
        <Button variant="secondary" className="w-full" onClick={handleCancel}>
          <X className="size-4" />
          {t('biometricCancelButton')}
        </Button>
      )}
      {onUseAnotherFactor && (
        <button
          type="button"
          className="w-full text-center text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          onClick={handleUseAnotherFactor}
        >
          {t('biometricUseAnotherFactor')}
        </button>
      )}
    </FactorPanel>
  )
}
