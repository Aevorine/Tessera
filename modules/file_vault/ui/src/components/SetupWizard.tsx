import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { Check, Fingerprint, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { vaultApi } from '@/lib/vaultApi'
import { translateError } from '@/i18n/errors'
import type { SmtpConfigInput } from '@/shared/ipcTypes'
import { PAGE_TITLE_CLASS, Wordmark } from '@/components/ui/page'
import { CODE_INPUT_CLASS, KEY_INPUT_CLASS } from '@/components/UnlockTabs'
import { copyText } from '@/lib/clipboard'

type Step = 'password' | 'totp' | 'fingerprint' | 'email' | 'recovery'

const STEP_ORDER: Step[] = ['password', 'totp', 'fingerprint', 'email', 'recovery']

const STEP_TITLE_KEYS: Record<Step, string> = {
  password: 'stepTitlePassword',
  totp: 'stepTitleTotp',
  fingerprint: 'stepTitleFingerprint',
  email: 'stepTitleEmail',
  recovery: 'stepTitleRecovery',
}

// This machine has no usable Windows Hello: skip the fingerprint step entirely
// and don't count it toward the total.
function activeSteps(fingerprintAvailable: boolean): Step[] {
  return fingerprintAvailable ? STEP_ORDER : STEP_ORDER.filter((s) => s !== 'fingerprint')
}

function stepLabel(step: Step, fingerprintAvailable: boolean, t: TFunction<'setup'>): string {
  const steps = activeSteps(fingerprintAvailable)
  const index = steps.indexOf(step) + 1
  return t('stepLabel', { index, total: steps.length, title: t(STEP_TITLE_KEYS[step]) })
}

/**
 * 步骤指示条：走过的打勾、当前高亮、后面灰显，让新用户一眼看到还剩几步。
 * 文案复用 STEP_TITLE_KEYS，不新增翻译键，避免同名步骤抄成两份。
 */
function StepRail({ current, fingerprintAvailable }: { current: Step; fingerprintAvailable: boolean }) {
  const { t } = useTranslation('setup')
  const steps = activeSteps(fingerprintAvailable)
  const currentIndex = steps.indexOf(current)
  return (
    <ol className="mb-6 flex items-start gap-1.5">
      {steps.map((step, i) => {
        const done = i < currentIndex
        const active = i === currentIndex
        return (
          <li key={step} className="flex min-w-0 flex-1 flex-col items-center gap-2 text-center">
            <span
              aria-hidden="true"
              className={`h-1.5 w-full rounded-full transition-colors ${
                done || active ? 'bg-primary' : 'bg-border'
              }`}
            />
            <span
              className={`flex items-center gap-1 text-sm leading-snug ${
                active ? 'font-medium text-foreground' : 'text-muted-foreground'
              }`}
              aria-current={active ? 'step' : undefined}
            >
              {done && <Check className="size-4 shrink-0 text-primary" aria-hidden="true" />}
              {t(STEP_TITLE_KEYS[step])}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

/**
 * 每步底部按钮组，目的是位置固定：次要动作在左、主动作在右、上方分隔线，
 * 翻页时光标几乎不用移动（原先每步各写各的）。
 */
function WizardActions({ secondary, primary }: { secondary?: React.ReactNode; primary: React.ReactNode }) {
  return (
    <div className="flex flex-col-reverse gap-2.5 border-t border-border pt-5 sm:flex-row sm:justify-end">
      {secondary}
      {primary}
    </div>
  )
}

interface WizardState {
  password: string
  /** null = 用户跳过了验证器这一步。后端据此**根本不建**这个解锁槽，
   *  而不是拿一个占位种子去建一个谁都能推导出来的假槽。 */
  totpSeed: string | null
  emailAddress: string | null
  smtpConfig: SmtpConfigInput | null
  enableFingerprint: boolean
}

export function SetupWizard({ onComplete }: { onComplete: () => void }) {
  const { t } = useTranslation('setup')
  const [step, setStep] = useState<Step>('password')
  const [fingerprintAvailable, setFingerprintAvailable] = useState(false)
  const [state, setState] = useState<WizardState>({
    password: '',
    totpSeed: '',
    emailAddress: null,
    smtpConfig: null,
    enableFingerprint: false,
  })

  useEffect(() => {
    vaultApi.call('setup_check_fingerprint_available', {}).then((res) => setFingerprintAvailable(res.available))
  }, [])

  return (
    <div className="ds-page-wash flex min-h-screen items-center justify-center bg-background p-6">
      {/* 480 → 720。这是用户第一次接触产品的界面，而它最宽的一步（邮箱/SMTP）
          要一屏放下五个输入框：480px 只够排成一列细长条，滚一屏才填得完，还看
          不出哪几个字段是一伙的。720px 才够把字段两两排开。窄窗口下由 max-w
          收回单列，不会横向溢出。 */}
      <div className="w-[720px] max-w-[calc(100vw-3rem)]">
        {/* 跟登录页同一个品牌头：首次设置和日常登录是同一个应用的两张脸，
            不该长得像两个软件。 */}
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <div className="flex items-center gap-2.5">
            <span aria-hidden="true" className="ds-icon-chip size-11">
              <ShieldCheck className="size-6" />
            </span>
            <Wordmark />
          </div>
        </div>
      <Card className="w-full">
        <CardHeader>
          <CardTitle className={PAGE_TITLE_CLASS}>{t('wizardTitle')}</CardTitle>
          <CardDescription>{stepLabel(step, fingerprintAvailable, t)}</CardDescription>
        </CardHeader>
        <CardContent>
          <StepRail current={step} fingerprintAvailable={fingerprintAvailable} />
          {step === 'password' && (
            <PasswordStep
              onNext={(password) => {
                setState((s) => ({ ...s, password }))
                setStep('totp')
              }}
            />
          )}
          {step === 'totp' && (
            <TotpStep
              onNext={(totpSeed) => {
                setState((s) => ({ ...s, totpSeed }))
                setStep(fingerprintAvailable ? 'fingerprint' : 'email')
              }}
              onSkip={() => {
                // null 而不是空字符串：后端据此**根本不建**这个解锁槽，
                // 而不是拿一个占位种子建一个谁都能推导出来的假槽。
                setState((s) => ({ ...s, totpSeed: null }))
                setStep(fingerprintAvailable ? 'fingerprint' : 'email')
              }}
            />
          )}
          {step === 'fingerprint' && (
            <FingerprintStep
              onNext={() => {
                setState((s) => ({ ...s, enableFingerprint: true }))
                setStep('email')
              }}
              onSkip={() => {
                setState((s) => ({ ...s, enableFingerprint: false }))
                setStep('email')
              }}
            />
          )}
          {step === 'email' && (
            <EmailStep
              onNext={(emailAddress, smtpConfig) => {
                setState((s) => ({ ...s, emailAddress, smtpConfig }))
                setStep('recovery')
              }}
              onSkip={() => {
                setState((s) => ({ ...s, emailAddress: null, smtpConfig: null }))
                setStep('recovery')
              }}
            />
          )}
          {step === 'recovery' && (
            <RecoveryStep
              onFinish={async (recoveryKey) => {
                await vaultApi.call('setup_complete', {
                  password: state.password,
                  totp_seed: state.totpSeed,
                  email_address: state.emailAddress,
                  recovery_key: recoveryKey,
                  smtp_config: state.smtpConfig ?? undefined,
                  enable_fingerprint: state.enableFingerprint,
                })
                // setup_complete only creates the identity; it never sets the backend's in-memory unlock key.
                // Without this unlock, every RPC needing an unlocked vault fails with auth.not_unlocked
                // until the user locks and logs back in.
                await vaultApi.call('unlock_password', { password: state.password })
                onComplete()
              }}
            />
          )}
        </CardContent>
      </Card>
      </div>
    </div>
  )
}

function PasswordStep({ onNext }: { onNext: (password: string) => void }) {
  const { t } = useTranslation('setup')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')

  function handleNext() {
    if (password.length < 8) {
      setError(t('passwordTooShort'))
      return
    }
    if (password !== confirm) {
      setError(t('passwordMismatch'))
      return
    }
    onNext(password)
  }

  return (
    <div className="space-y-6">
      {/* 两个字段互为一组（设一次、再确认一次），并排放比上下排更容易一眼看出
          它们要填成一样的。 */}
      <div className="grid gap-x-5 gap-y-5 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="setup-password">{t('passwordLabel')}</Label>
          <Input id="setup-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="setup-password-confirm">{t('passwordConfirmLabel')}</Label>
          <Input
            id="setup-password-confirm"
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleNext()}
          />
        </div>
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <WizardActions primary={<Button onClick={handleNext}>{t('nextButton')}</Button>} />
    </div>
  )
}

function TotpStep({ onNext, onSkip }: { onNext: (seed: string) => void; onSkip: () => void }) {
  const { t } = useTranslation('setup')
  const [seed, setSeed] = useState('')
  const [qr, setQr] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    vaultApi.call('setup_generate_totp', {}).then((res) => {
      setSeed(res.seed)
      setQr(res.qr_png_base64)
      setLoading(false)
    })
  }, [])

  async function handleNext() {
    const res = await vaultApi.call('setup_verify_totp', { seed, code })
    if (!res.ok) {
      setError(t('totpCodeInvalid'))
      return
    }
    onNext(seed)
  }

  if (loading) return <p className="text-sm text-muted-foreground">{t('loading')}</p>

  return (
    <div className="space-y-6">
      {/* 卡片宽了之后二维码和"扫它 / 或者手抄这串种子 / 然后把码填回来"这三件事
          可以并排：左边是要看的，右边是要做的，眼睛不用在一条长长的竖列上来回。 */}
      <div className="grid gap-x-6 gap-y-5 sm:grid-cols-[auto_1fr]">
        <div className="flex justify-center rounded-xl border border-border bg-surface p-5">
          <img src={`data:image/png;base64,${qr}`} alt={t('totpQrAlt')} className="h-52 w-52" />
        </div>
        <div className="min-w-0 space-y-5">
          <p className="text-sm leading-relaxed text-muted-foreground">{t('totpScanInstruction')}</p>
          <p className="rounded-lg border border-border bg-surface px-3.5 py-2.5 font-mono text-sm leading-relaxed break-all text-muted-foreground">
            {t('totpManualEntry', { seed })}
          </p>
          <div className="space-y-2">
            <Label htmlFor="totp-code">{t('totpCodeLabel')}</Label>
            <Input
              id="totp-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              className={CODE_INPUT_CLASS}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleNext()}
            />
          </div>
        </div>
      </div>
      {/* 验证器是可选的：手上没有验证器 App 的人不该被卡在这一页出不去。
          密码和恢复密钥这两条**始终**会建，所以跳过它不会让金库变成打不开的。 */}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <WizardActions
        secondary={
          <Button variant="outline" onClick={onSkip}>
            {t('skipTotpButton')}
          </Button>
        }
        primary={<Button onClick={handleNext}>{t('nextButton')}</Button>}
      />
    </div>
  )
}

function FingerprintStep({ onNext, onSkip }: { onNext: () => void; onSkip: () => void }) {
  const { t } = useTranslation('setup')
  const [status, setStatus] = useState('')
  const [verifying, setVerifying] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => setStatus(t('fingerprintInitialStatus')), [t])

  async function handleVerify() {
    setVerifying(true)
    setStatus(t('fingerprintVerifying'))
    setError('')
    const res = await vaultApi.call('setup_verify_fingerprint', {})
    setVerifying(false)
    if (res.ok) {
      onNext()
    } else {
      setStatus(t('fingerprintInitialStatus'))
      setError(res.error ? translateError(res.error, res.error_params) : t('fingerprintVerifyFailedFallback'))
    }
  }

  return (
    <div className="space-y-6">
      {/* 跟登录页的生物识别面板同一个样式：一块强调色底片 + 一个大图标 + 一句
          状态。同一件事在两处长得一样，用户不用重新认。 */}
      <div className="flex flex-col items-center gap-3 rounded-xl border border-accent-line bg-accent-soft px-6 py-8 text-center">
        <span
          aria-hidden="true"
          className={`ds-icon-chip size-16 border-accent-line bg-card text-primary ${verifying ? 'animate-pulse' : ''}`}
        >
          <Fingerprint className="size-8" />
        </span>
        <p className="max-w-[42ch] text-sm leading-relaxed text-muted-foreground">{status}</p>
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {/* 同理可跳过。这一页本来就只在探测到可用传感器时才出现，但"有传感器"
          不等于"想用它"——共用电脑上的人可能就是不想把自己的指纹绑上去。 */}
      <WizardActions
        secondary={
          <Button variant="outline" onClick={onSkip} disabled={verifying}>
            {t('skipFingerprintButton')}
          </Button>
        }
        primary={
          <Button onClick={handleVerify} disabled={verifying}>
            {t('fingerprintStartButton')}
          </Button>
        }
      />
    </div>
  )
}

function EmailStep({
  onNext,
  onSkip,
}: {
  onNext: (email: string, smtp: SmtpConfigInput) => void
  onSkip: () => void
}) {
  const { t } = useTranslation('setup')
  const [email, setEmail] = useState('')
  const [host, setHost] = useState('')
  const [port, setPort] = useState('587')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [useSsl, setUseSsl] = useState(false)
  const [status, setStatus] = useState('')
  const [sending, setSending] = useState(false)

  function buildConfig(): SmtpConfigInput {
    return { host, port: Number(port) || 587, username, password, use_ssl: useSsl }
  }

  async function handleTestSend() {
    setSending(true)
    setStatus(t('sendingTestEmail'))
    const res = await vaultApi.call('send_test_email', { smtp_config: buildConfig(), to_addr: email })
    setSending(false)
    setStatus(
      res.ok
        ? t('testEmailSuccess')
        : t('testEmailFailed', { error: res.error ? translateError(res.error, res.error_params) : '' }),
    )
  }

  const canProceed = email.trim() !== '' && host.trim() !== ''

  return (
    <div className="space-y-6">
      {/* 这一步是整个向导里字段最多的一屏，也是 720px 卡片宽度的直接理由。
          分组跟设置里的 SMTP 弹窗完全一致：收件地址自己一行（它跟发信服务器
          不是一回事），服务器/端口一对，账号/密码一对。 */}
      <div className="space-y-2">
        <Label htmlFor="email-address">{t('emailAddressLabel')}</Label>
        <Input id="email-address" value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>
      <div className="grid gap-x-5 gap-y-5 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="smtp-host">{t('smtpHostLabel')}</Label>
          <Input id="smtp-host" value={host} onChange={(e) => setHost(e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="smtp-port">{t('smtpPortLabel')}</Label>
          <Input id="smtp-port" inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="smtp-username">{t('smtpUsernameLabel')}</Label>
          <Input id="smtp-username" value={username} onChange={(e) => setUsername(e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="smtp-password">{t('smtpPasswordLabel')}</Label>
          <Input id="smtp-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
      </div>
      <div className="flex items-center gap-2.5 rounded-lg border border-border bg-surface px-3.5 py-3">
        <Checkbox id="use-ssl" checked={useSsl} onCheckedChange={(v) => setUseSsl(v === true)} />
        <Label htmlFor="use-ssl" className="cursor-pointer font-normal">{t('smtpSslLabel')}</Label>
      </div>
      {status && <p className="text-sm leading-relaxed text-muted-foreground">{status}</p>}
      <WizardActions
        secondary={
          <>
            <Button variant="outline" onClick={onSkip}>
              {t('skipEmailButton')}
            </Button>
            <Button variant="secondary" onClick={handleTestSend} disabled={sending || !canProceed}>
              {t('sendTestEmailButton')}
            </Button>
          </>
        }
        primary={
          <Button onClick={() => onNext(email, buildConfig())} disabled={!canProceed}>
            {t('nextButton')}
          </Button>
        }
      />
    </div>
  )
}

function RecoveryStep({ onFinish }: { onFinish: (key: string) => Promise<void> }) {
  const { t } = useTranslation('setup')
  const [key, setKey] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [finishing, setFinishing] = useState(false)

  useEffect(() => {
    vaultApi.call('setup_generate_recovery_key', {}).then((res) => {
      setKey(res.recovery_key)
      setLoading(false)
    })
  }, [])

  async function handleFinish() {
    if (!confirmed) {
      setError(t('recoveryConfirmRequired'))
      return
    }
    setFinishing(true)
    await onFinish(key)
  }

  if (loading) return <p className="text-sm text-muted-foreground">{t('loading')}</p>

  return (
    <div className="space-y-6">
      <Alert variant="destructive">
        <AlertDescription>{t('recoveryWarning')}</AlertDescription>
      </Alert>
      {/* 这串是要被逐字抄到纸上的，所以用跟登录页恢复密钥输入框同一套等宽写法
          （KEY_INPUT_CLASS）：0/O、1/l 在哪儿都得长成一个样。 */}
      <Input readOnly value={key} className={KEY_INPUT_CLASS} />
      <div className="flex items-center gap-2.5 rounded-lg border border-border bg-surface px-3.5 py-3">
        <Checkbox id="confirm-saved" checked={confirmed} onCheckedChange={(v) => setConfirmed(v === true)} />
        <Label htmlFor="confirm-saved" className="cursor-pointer font-normal">{t('recoveryConfirmLabel')}</Label>
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <WizardActions
        secondary={
          <Button variant="outline" onClick={() => void copyText(key)}>
            {t('copyToClipboard')}
          </Button>
        }
        primary={
          <Button onClick={handleFinish} disabled={finishing}>
            {t('finishButton')}
          </Button>
        }
      />
    </div>
  )
}
