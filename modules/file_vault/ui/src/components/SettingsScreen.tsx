import {
  useCallback,
  useEffect,
  useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { InfoHint } from '@/components/ui/info-hint'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { Tooltip,
  TooltipContent,
  TooltipTrigger } from '@/components/ui/tooltip'
import { Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle } from '@/components/ui/dialog'
import { Alert,
  AlertDescription } from '@/components/ui/alert'
import { Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue } from '@/components/ui/select'
import {
  ClipboardCopy,
  FileText,
  Fingerprint,
  Info,
  Keyboard,
  KeyRound,
  KeySquare,
  Loader2,
  Lock,
  Mail,
  ShieldAlert,
  Palette,
  Puzzle,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Trash2,
  Wrench,
} from 'lucide-react'
import { PageHeader, PageSection, PageShell } from '@/components/ui/page'
import { CODE_INPUT_CLASS, KEY_INPUT_CLASS } from '@/components/UnlockTabs'
import { ShortcutSettings } from '@/components/ShortcutSettings'
import { AboutSection } from '@/components/AboutSection'
import { UpdateDownloadProgress } from '@/components/UpdateDownloadProgress'
import { DiagnosticLogSection } from '@/components/DiagnosticLogSection'
import { AppearanceSettings } from '@/components/AppearanceSettings'
import { ProfessionalMetricsPanel } from '@/components/ProfessionalMetricsPanel'
import { vaultApi } from '@/lib/vaultApi'
import {
  loadClipboardImageViewMode,
  saveClipboardImageViewMode,
  type ClipboardImageViewMode,
} from '@/lib/clipboardImagePrefs'
import { electronApi } from '@/lib/electronApi'
import { fileHookSettingChecked } from '@/lib/fileOpsUiState'
import { loadFontSizeTier, saveFontSizeTier, type FontSizeTier } from '@/lib/fontSize'
import { useLabelModeContext, type LabelMode } from '@/lib/labelMode'
import { translateError } from '@/i18n/errors'
import type {
  AiConfigInput,
  AutoLockSettings,
  AiModelDetail,
  BlacklistApp,
  LockableModule,
  NoteImageStorageMode,
  NoteTextStorageMode,
  RecoveryCodesSettings,
  SmtpConfigInput,
  TaskCardPreferences,
  TaskCardPosition,
  UpdateCheckResult,
  UpdateProgress,
  UpdateSourceId,
} from '@/shared/ipcTypes'
import { copyText } from '@/lib/clipboard'

// ---------------------------------------------------------------------------
// 表单弹窗的统一规格
//
// 「输入内容很多的界面要大、要好操作」这条以前落不了地的原因很具体：每个
// <DialogContent> 都不带 className，于是全部沿用 primitives 里那一个默认宽度，
// 一个两字段的确认框和一个五字段的 SMTP 配置一样宽——后者被压成一列细长条，
// 用户要在一个跟内容毫无关系的宽度里上下滚。
//
// 现在只有两档，选择依据是**字段数**而不是"感觉"：
//   FORM_DIALOG       ≤3 个字段的单列表单
//   WIDE_FORM_DIALOG  ≥4 个字段，配 FORM_GRID 排成两列
// 两档都带 `flex max-h-[85vh] flex-col`：内容比窗口高时，滚的是里面那块
// （FORM_BODY 的 overflow-y-auto），标题和主按钮永远留在屏幕上。
//
// 同一组常量在 RecoveryCodesScreen / PasswordScreen / AIChatScreen 里同名同值。
// 它们本该住在 components/ui/page.tsx（设计系统的家），这次没放进去只是因为
// 那个文件不在本次改动范围内。
// ---------------------------------------------------------------------------
const FORM_DIALOG = 'flex max-h-[85vh] flex-col sm:max-w-xl'
const WIDE_FORM_DIALOG = 'flex max-h-[85vh] flex-col sm:max-w-3xl'
/** 弹窗里可滚动的那一块。min-h-0 不能省，否则 flex 子项不肯收缩，overflow 失效。 */
const FORM_BODY = 'min-h-0 flex-1 space-y-5 overflow-y-auto'
/** 两列字段栅格。窄窗口下自动落回单列。 */
const FORM_GRID = 'grid gap-x-5 gap-y-5 sm:grid-cols-2'
/** 单个字段：标签与输入框之间的距离，全应用一个值。 */
const FIELD = 'space-y-2'

// Opened only after AppShell has already unlocked the IMK (server-side
// in backend_server.py) - these calls don't re-prompt for a factor.
type ActiveDialog = 'password' | 'totp' | 'email' | 'recovery' | 'ai' | null

export function SettingsScreen({
  moduleLocks,
  onModuleLocksChange,
  isProfessional = false,
}: {
  moduleLocks: Record<LockableModule, boolean>
  onModuleLocksChange: (settings: Record<LockableModule, boolean>) => void
  isProfessional?: boolean
}) {
  const { t } = useTranslation('settings')
  const [activeDialog, setActiveDialog] = useState<ActiveDialog>(null)

  async function handleRebindFingerprint() {
    const res = await vaultApi.call('rebind_fingerprint', {})
    if (!res.ok) {
      toast.error(t('rebindFingerprintFailedToast'), { description: translateError(res.error, res.error_params) })
      return
    }
    toast.success(t('rebindFingerprintSuccessToast'))
  }

  async function handleCopyDiagnostics() {
    const res = await electronApi.copyDiagnostics()
    if (res.ok) toast.success(t('diagnosticsCopiedToast'))
    else toast.error(t('diagnosticsCopyFailedToast'), { description: res.error })
  }

  async function handleResetPreferences() {
    const res = await electronApi.resetAppPreferences()
    if (res.ok) toast.success(t('preferencesResetToast'))
    else toast.error(t('preferencesResetFailedToast'), { description: res.error })
  }

  return (
    <PageShell width="canvas">
      <PageHeader title={t('pageTitle')} />

      {/* 铺满宽度之后，**设置项不能跟着摊成一行 1700 像素**：标签在最左、开关在
          最右，眼睛要横穿整块屏幕才能把"这一项叫什么"和"它现在是开还是关"对上。
          所以宽屏下把分区排成两列——宽度用满了，每一列的阅读长度还是原来那样。
          `items-start` 是必须的：不写的话同一行的两张卡会被拉成一样高，矮的那张
          底下多出一大块空白。 */}
      <div className="grid gap-6 lg:grid-cols-2 lg:items-start">
      {/* 账户安全排第一，而且五个入口从"竖着排的五个等宽大按钮"改成两列网格：
          原先每个按钮都跟"加密文件"那种主操作一样宽一样重，一屏里挤着十几个
          同等份量的蓝条，谁也不比谁显眼，等于没有主次。 */}
      <PageSection icon={ShieldCheck} title={t('settingsSectionAccount')}>
        <div className="space-y-4">
          <div className="grid gap-2 sm:grid-cols-2">
            <Button variant="outline" className="justify-start" onClick={() => setActiveDialog('password')}>
              <KeyRound className="size-4" />
              {t('changePasswordButton')}
            </Button>
            <Button variant="outline" className="justify-start" onClick={() => setActiveDialog('totp')}>
              <ShieldCheck className="size-4" />
              {t('rebindTotpButton')}
            </Button>
            <Button variant="outline" className="justify-start" onClick={() => setActiveDialog('email')}>
              <Mail className="size-4" />
              {t('updateEmailButton')}
            </Button>
            <Button variant="outline" className="justify-start" onClick={() => setActiveDialog('recovery')}>
              <KeySquare className="size-4" />
              {t('regenRecoveryButton')}
            </Button>
            <Button variant="outline" className="justify-start" onClick={handleRebindFingerprint}>
              <Fingerprint className="size-4" />
              {t('rebindFingerprintButton')}
            </Button>
          </div>
          <ModuleLockSettings moduleLocks={moduleLocks} onModuleLocksChange={onModuleLocksChange} />
          <AutoLockSetting />
          <DuressPasswordSetting />
        </div>
      </PageSection>

      {/* 「更新」不再单独占一节，并进「关于」——两者说的是同一件事：**这个软件
          本身**（我装的是哪一版 / 有没有更新的版本 / 归属与许可是什么）。拆成
          相邻的两节只是让用户为同一个问题上下扫两遍。更新卡片排在最前，因为
          这一节里只有它是"可以动手做的事"，其余都是只读信息。 */}
      <PageSection icon={Info} title={t('settingsSectionAbout')}>
        <div className="space-y-3">
          <UpdateSetting />
          <DiagnosticLogSection />
          <AboutSection />
        </div>
      </PageSection>

      <PageSection icon={Palette} title={t('settingsSectionAppearance')}>
        <div className="space-y-3">
          <AppearanceSettings />
          {isProfessional && <ProfessionalMetricsPanel />}
          <FontSizeSetting />
          <LabelModeSetting />
        </div>
      </PageSection>

      <PageSection icon={Puzzle} title={t('settingsSectionIntegration')}>
        <div className="space-y-3">
          <AutoStartSetting />
          <FileHookAutoStartSetting />
          <TaskCardPreferencesSetting />
          <TxtAssociationSetting />
          <MdAssociationSetting />
        </div>
      </PageSection>

      {isProfessional && (
        <PageSection icon={Keyboard} title={t('settingsSectionShortcuts')}>
          <ShortcutSettings />
        </PageSection>
      )}

      <PageSection icon={FileText} title={t('settingsSectionContent')}>
        <div className="space-y-3">
          <Button variant="outline" className="justify-start" onClick={() => setActiveDialog('ai')}>
            <Sparkles className="size-4" />
            {t('aiSettingsButton')}
          </Button>
          <ClipboardImageViewModeSetting />
          <ClipboardBlacklistSetting />
          {isProfessional && <ClipboardCleanupSetting />}
          <NoteImageStorageModeSetting />
          <NoteTextStorageModeSetting />
          {isProfessional && <RecoveryCodesSettingsToggle />}
        </div>
      </PageSection>

      {isProfessional && (
        <PageSection icon={Wrench} title={t('settingsSectionOther')}>
          <div className="grid gap-2 sm:grid-cols-2">
            <Button variant="outline" className="justify-start" onClick={handleCopyDiagnostics}>
              <ClipboardCopy className="size-4" />
              {t('copyDiagnosticsButton')}
            </Button>
            <Button variant="outline" className="justify-start" onClick={handleResetPreferences}>
              <RotateCcw className="size-4" />
              {t('resetPreferencesButton')}
            </Button>
          </div>
        </PageSection>
      )}
      </div>

      <ChangePasswordDialog open={activeDialog === 'password'} onOpenChange={(o) => !o && setActiveDialog(null)} />
      <RebindTotpDialog open={activeDialog === 'totp'} onOpenChange={(o) => !o && setActiveDialog(null)} />
      <UpdateEmailDialog open={activeDialog === 'email'} onOpenChange={(o) => !o && setActiveDialog(null)} />
      <RegenRecoveryDialog open={activeDialog === 'recovery'} onOpenChange={(o) => !o && setActiveDialog(null)} />
      <AiSettingsDialog open={activeDialog === 'ai'} onOpenChange={(o) => !o && setActiveDialog(null)} />
    </PageShell>
  )
}

// 应用更新。
//
// 两条不能妥协的产品约束，都直接反映在这个组件的行为里：
// 1. **自动检查只查元数据**，绝不静默下载或替换。下载必须由用户点"立即更新"触发。
// 2. **验不了签就不更新**，不降级、不"这次先算了"。失败原因如实显示出来。
//
// 渲染端在这里不碰网络也不碰文件系统——四个 IPC 方法都不接受 URL 或路径参数，
// 说不出"下载哪个链接"。见 electron/preload.ts 里对这个信任边界的说明。
function UpdateSetting() {
  const { t } = useTranslation('settings')
  const [state, setState] = useState<{
    currentVersion: string
    autoCheck: boolean
    canSelfUpdate: boolean
    source: UpdateSourceId
  } | null>(null)
  const [result, setResult] = useState<UpdateCheckResult | null>(null)
  const [checking, setChecking] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [progress, setProgress] = useState<UpdateProgress | null>(null)
  // 本次检查完成的时刻。**没检查过就是 null，绝不预填一个假的"刚刚"**——
  // "上次检查：从未"和"上次检查：3 秒前"是两个完全不同的事实，糊成一个会让
  // 用户以为查过了。存 epoch 毫秒而不是格式化好的字符串，切语言时能跟着变。
  const [checkedAt, setCheckedAt] = useState<number | null>(null)

  useEffect(() => {
    void electronApi.getUpdateState().then(setState)
    // 主进程自动检查发现新版本时会推过来——用户可能一直停在设置页，不该等他
    // 手动点一次才看到。这条也算一次"检查发生了"，所以同样打时间戳。
    return electronApi.onUpdateAvailable((res) => {
      setResult(res)
      setCheckedAt(Date.now())
    })
  }, [])

  useEffect(() => electronApi.onUpdateProgress(setProgress), [])

  async function handleCheck() {
    setChecking(true)
    try {
      // force=true 绕过 24 小时节流——用户主动点的时候他要的就是"现在去查"。
      setResult(await electronApi.checkForUpdate(true))
    } finally {
      setChecking(false)
      // 放在 finally：查失败（断网、404、限流）**也是一次检查**，时间戳照打。
      // 只在成功时打的话，用户连点五次都没反应，界面上却什么都没变，分不清
      // 是"按钮坏了"还是"查了但没查到"。
      setCheckedAt(Date.now())
    }
  }

  async function handleInstall() {
    setInstalling(true)
    setProgress(null)
    const res = await electronApi.installUpdate()
    if (!res.ok) {
      setInstalling(false)
      setProgress(null)
      toast.error(t('updateInstallFailedToast'), {
        description: res.errorMessage ?? translateError(`update.${res.errorCode}`),
      })
      return
    }
    // 成功时主进程会立刻退出让 runner 接手，所以这里不用复位 installing——
    // 界面很快就不存在了。
  }

  if (!state) return null

  const latest = result?.status === 'update-available' ? result.latest : undefined

  return (
    <div className="space-y-3 rounded border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="font-medium">{t('updateTitle')}</p>
          <p className="text-sm text-muted-foreground">{t('updateCurrentVersion', { version: state.currentVersion })}</p>
          {/* 完整的年月日时分秒，不用"3 分钟前"这种相对时间：用户点这一行想
              确认的是"我刚才那一下到底生效了没有"，而相对时间在刚点完的那几秒
              里恒显示"刚刚"，正好在最需要它的时刻不提供任何信息。 */}
          <p className="text-sm text-muted-foreground">
            {checkedAt === null
              ? t('updateLastCheckedNever')
              : t('updateLastCheckedAt', { time: new Date(checkedAt).toLocaleString() })}
          </p>
        </div>
        <Button size="sm" variant="outline" disabled={checking || installing} onClick={() => void handleCheck()}>
          {checking ? t('updateChecking') : t('updateCheckButton')}
        </Button>
      </div>

      <div className="flex items-center gap-2">
        <Checkbox
          id="update-auto-check"
          checked={state.autoCheck}
          onCheckedChange={(v) => {
            const next = v === true
            void electronApi.setUpdateAutoCheck(next).then((applied) => setState({ ...state, autoCheck: applied }))
          }}
        />
        <Label htmlFor="update-auto-check" className="text-sm">
          {t('updateAutoCheckLabel')}
        </Label>
        <InfoHint text={t('updateAutoCheckHint')} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Label htmlFor="update-source" className="text-sm">
          {t('updateSourceLabel')}
        </Label>
        <Select
          value={state.source}
          disabled={checking || installing}
          onValueChange={(value) => {
            // 换源后上一个仓库的检查结果不再算数，一并清掉。
            void electronApi.setUpdateSource(value as UpdateSourceId).then((applied) => {
              setState({ ...state, source: applied })
              setResult(null)
              setCheckedAt(null)
            })
          }}
        >
          <SelectTrigger id="update-source" className="w-72 max-w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="main">{t('updateSourceMain')}</SelectItem>
            <SelectItem value="mirror">{t('updateSourceMirror')}</SelectItem>
          </SelectContent>
        </Select>
        <InfoHint text={t('updateSourceHint')} />
      </div>

      {result?.status === 'up-to-date' && <p className="text-sm text-muted-foreground">{t('updateUpToDate')}</p>}

      {result?.status === 'error' && (
        <Alert>
          <AlertDescription className="text-sm">
            {translateError(`update.${result.errorCode ?? 'unknown'}`)}
            {result.errorMessage && <span className="block opacity-70">{result.errorMessage}</span>}
          </AlertDescription>
        </Alert>
      )}

      {latest && (
        <div className="space-y-2 rounded border bg-muted/30 p-2">
          <p className="text-sm font-medium">
            {t('updateAvailableTitle', { version: latest.version })}
            <span className="ml-2 text-sm font-normal text-muted-foreground">
              {new Date(latest.releasedAt).toLocaleDateString()}
            </span>
          </p>
          {latest.notes && <p className="whitespace-pre-wrap text-sm text-muted-foreground">{latest.notes}</p>}

          {/* portable 之外的构建拿不到稳定 exe 路径，自替换会替换错文件——
              此时只提示手动下载，绝不去猜一个路径。 */}
          {!state.canSelfUpdate ? (
            <p className="text-sm text-muted-foreground">{t('updateManualOnlyHint')}</p>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" disabled={installing} onClick={() => void handleInstall()}>
                {installing ? t('updateInstalling') : t('updateInstallButton')}
              </Button>
              <Button size="sm" variant="outline" disabled={installing} onClick={() => setResult(null)}>
                {t('updateLaterButton')}
              </Button>
              {installing && <InfoHint text={t('updateRestartHint')} />}
            </div>
          )}
          {installing && progress && progress.total > 0 && <UpdateDownloadProgress progress={progress} />}
        </div>
      )}
    </div>
  )
}

// 字号档位：小四（12pt = 16px，默认）/ 四号（14pt ≈ 18.67px）。
// 只有这两档，因为需求本身就是这两个中文排版字号，不是一个"随便调大调小"的
// 滑块。改的是 <html> 根字号，整套 rem 尺寸等比缩放，所以间距会跟着一起变大，
// 不会出现"字变大但按钮内边距没变"的挤压。
function FontSizeSetting() {
  const { t } = useTranslation('settings')
  const [tier, setTier] = useState<FontSizeTier>(loadFontSizeTier)

  function handleChange(next: FontSizeTier) {
    setTier(next)
    saveFontSizeTier(next)
  }

  const tiers: { value: FontSizeTier; labelKey: string }[] = [
    { value: 'xiaosi', labelKey: 'fontSizeTierXiaosi' },
    { value: 'sihao', labelKey: 'fontSizeTierSihao' },
  ]

  return (
    <div className="space-y-2 rounded border p-3">
      <div>
        <p className="font-medium">{t('fontSizeTitle')}</p>
      </div>
      <div className="flex gap-2" role="radiogroup" aria-label={t('fontSizeTitle')}>
        {tiers.map((option) => (
          <Button
            key={option.value}
            role="radio"
            aria-checked={tier === option.value}
            variant={tier === option.value ? 'default' : 'outline'}
            onClick={() => handleChange(option.value)}
          >
            {t(option.labelKey)}
          </Button>
        ))}
      </div>
    </div>
  )
}

// 「纯图标+悬停提示」还是「始终显示图标+文字」的**全局默认值**。
// 单个区域（剪贴板行、笔记工具栏……）可以各自覆盖它——覆盖既可以由用户在那个
// 区域直接切，也会被"显示/隐藏行列"的图标强制写入（见 IconToolbar.tsx）。这里
// 顺带提供一个"清除全部区域覆盖"的按钮，否则用户想让全局设置重新生效就得回到
// 每个区域挨个改回去。
function LabelModeSetting() {
  const { t } = useTranslation('settings')
  const { globalMode, setGlobalMode, clearAllRegionOverrides, overrideCount } = useLabelModeContext()

  const modes: { value: LabelMode; labelKey: string }[] = [
    { value: 'labels', labelKey: 'labelModeLabels' },
    { value: 'icons', labelKey: 'labelModeIcons' },
  ]

  return (
    <div className="space-y-2 rounded border p-3">
      <div>
        <p className="font-medium">{t('labelModeTitle')}</p>
      </div>
      <div className="flex gap-2" role="radiogroup" aria-label={t('labelModeTitle')}>
        {modes.map((option) => (
          <Button
            key={option.value}
            role="radio"
            aria-checked={globalMode === option.value}
            variant={globalMode === option.value ? 'default' : 'outline'}
            onClick={() => setGlobalMode(option.value)}
          >
            {t(option.labelKey)}
          </Button>
        ))}
      </div>
      {overrideCount > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm text-muted-foreground">{t('labelModeOverrideCount', { count: overrideCount })}</p>
          <Button size="sm" variant="outline" onClick={clearAllRegionOverrides}>
            {t('labelModeClearOverrides')}
          </Button>
        </div>
      )}
    </div>
  )
}

function AutoStartSetting() {
  const { t } = useTranslation('settings')
  const [enabled, setEnabled] = useState(false)
  const [silent, setSilent] = useState(true)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    electronApi.getStartupSettings().then((settings) => {
      setEnabled(settings.openAtLogin)
      setSilent(settings.silent)
      setLoaded(true)
    }).catch(() => setLoaded(true))
  }, [])

  async function handleToggle(checked: boolean) {
    const previous = enabled
    setEnabled(checked)
    try {
      const actual = await electronApi.setAutoStart(checked)
      if (actual !== checked) throw new Error(t('autoStartStateMismatch'))
      setEnabled(actual)
      toast.success(checked ? t('autoStartEnabledToast') : t('autoStartDisabledToast'))
    } catch (error) {
      setEnabled(previous)
      toast.error(t('autoStartUpdateFailedToast'), {
        description: error instanceof Error ? error.message : String(error),
      })
    }
  }

  async function handleSilentToggle(checked: boolean) {
    const previous = silent
    setSilent(checked)
    try {
      setSilent(await electronApi.setSilentStart(checked))
      toast.success(checked ? t('silentStartEnabledToast') : t('silentStartDisabledToast'))
    } catch (error) {
      setSilent(previous)
      toast.error(t('autoStartUpdateFailedToast'), {
        description: error instanceof Error ? error.message : String(error),
      })
    }
  }

  if (!loaded) return null

  return (
    <div className="space-y-2 rounded border p-3">
      <div className="flex items-center gap-2">
        <Checkbox id="auto-start" checked={enabled} onCheckedChange={(v) => handleToggle(v === true)} />
        <Label htmlFor="auto-start">{t('autoStartLabel')}</Label>
      </div>
      {/* 静默启动只在开机自启拉起时生效，所以自启关着的时候它是灰的——值保留，
          重新打开自启时用户之前的选择还在。 */}
      <div className="flex items-center gap-2 ps-6">
        <Checkbox
          id="silent-start"
          checked={silent}
          disabled={!enabled}
          onCheckedChange={(v) => handleSilentToggle(v === true)}
        />
        <Label htmlFor="silent-start" className={enabled ? undefined : 'text-muted-foreground'}>
          {t('silentStartLabel')}
        </Label>
      </div>
    </div>
  )
}

function FileHookAutoStartSetting() {
  const { t } = useTranslation('settings')
  const [enabled, setEnabled] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [working, setWorking] = useState(false)
  const [agentError, setAgentError] = useState<string | null>(null)

  useEffect(() => {
    vaultApi.call('file_clip_hook_status', {}).then((res) => {
      if (res.ok && 'running' in res) {
        setEnabled(fileHookSettingChecked(res))
        setAgentError(res.last_error)
      }
      setLoaded(true)
    }).catch(() => setLoaded(true))
  }, [])

  async function handleToggle(checked: boolean) {
    setWorking(true)
    setEnabled(checked)
    try {
      const res = await vaultApi.call('file_clip_hook_set_enabled', { enabled: checked })
      if (!res.ok || !('running' in res)) {
        setEnabled(!checked) // rollback on error
        toast.error(t('fileHookUpdateFailedToast'), {
          description: 'error' in res ? translateError(res.error, res.error_params) : undefined,
        })
        return
      }
      const actual = fileHookSettingChecked(res)
      setAgentError(res.last_error)
      if (actual !== checked || (checked && !res.running)) {
        setEnabled(actual)
        toast.error(t('fileHookUpdateFailedToast'), {
          description: checked && !res.running
            ? res.last_error ? t('fileHookAgentError', { detail: res.last_error }) : t('fileHookAgentNotRunning')
            : undefined,
        })
        return
      }
      setEnabled(actual)
      toast.success(checked ? t('fileHookEnabledToast') : t('fileHookDisabledToast'))
    } catch (error) {
      setEnabled(!checked)
      toast.error(t('fileHookUpdateFailedToast'), {
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setWorking(false)
    }
  }

  if (!loaded) return null

  return (
    <div className="rounded border p-3">
      <div className="flex items-center gap-2">
        <Checkbox id="file-hook-auto-start" checked={enabled} disabled={working}
                  onCheckedChange={(v) => handleToggle(v === true)} />
        <Label htmlFor="file-hook-auto-start">{t('fileHookAutoStartLabel')}</Label>
      </div>
      {agentError && <p className="mt-2 text-sm text-destructive">{t('fileHookAgentError', { detail: agentError })}</p>}
    </div>
  )
}

const TASK_CARD_POSITIONS: { value: TaskCardPosition; label: string }[] = [
  { value: 'top-left', label: 'taskCardPositionTopLeft' },
  { value: 'top-center', label: 'taskCardPositionTopCenter' },
  { value: 'top-right', label: 'taskCardPositionTopRight' },
  { value: 'middle-left', label: 'taskCardPositionMiddleLeft' },
  { value: 'center', label: 'taskCardPositionCenter' },
  { value: 'middle-right', label: 'taskCardPositionMiddleRight' },
  { value: 'bottom-left', label: 'taskCardPositionBottomLeft' },
  { value: 'bottom-center', label: 'taskCardPositionBottomCenter' },
  { value: 'bottom-right', label: 'taskCardPositionBottomRight' },
]

function TaskCardPreferencesSetting() {
  const { t } = useTranslation('settings')
  const [preferences, setPreferences] = useState<TaskCardPreferences | null>(null)
  const [working, setWorking] = useState(false)

  useEffect(() => {
    vaultApi.call('file_clip_progress_preferences_get', {}).then((res) => {
      if (res.ok && 'preferences' in res) setPreferences(res.preferences)
    }).catch(() => undefined)
  }, [])

  async function save(next: TaskCardPreferences) {
    const previous = preferences
    setPreferences(next)
    setWorking(true)
    try {
      const res = await vaultApi.call('file_clip_progress_preferences_set', next)
      if (!res.ok || !('preferences' in res)) {
        setPreferences(previous)
        toast.error(t('taskCardSaveFailedToast'), {
          description: 'error' in res ? translateError(res.error, res.error_params) : undefined,
        })
        return
      }
      setPreferences(res.preferences)
      toast.success(t('taskCardSavedToast'))
    } catch (error) {
      setPreferences(previous)
      toast.error(t('taskCardSaveFailedToast'), {
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setWorking(false)
    }
  }

  if (!preferences) return null

  return (
    <div className="space-y-3 rounded border p-3">
      <div>
        <p className="font-medium">{t('taskCardPreferencesTitle')}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-[1fr_160px]">
        <div>
          <Label>{t('taskCardPositionLabel')}</Label>
          <div className="mt-2 grid grid-cols-3 gap-1" role="radiogroup" aria-label={t('taskCardPositionLabel')}>
            {TASK_CARD_POSITIONS.map((position) => (
              <button
                key={position.value}
                type="button"
                role="radio"
                aria-checked={preferences.position === position.value}
                aria-label={t(position.label)}
                disabled={working}
                onClick={() => void save({ ...preferences, position: position.value })}
                className={`min-h-11 rounded-lg border px-2 py-1.5 text-sm leading-snug transition-colors ${preferences.position === position.value ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-accent'}`}
              >
                {t(position.label)}
              </button>
            ))}
          </div>
        </div>
        <div className="relative min-h-32 rounded border bg-muted/40 p-2" aria-label={t('taskCardPreviewTitle')}>
          <span className="text-sm text-muted-foreground">{t('taskCardPreviewTitle')}</span>
          <div className={`absolute rounded border bg-background p-2 text-sm shadow-sm ${previewClassFor(preferences.position)} ${preferences.compact ? 'w-24' : 'w-32'}`}>
            <p className="font-medium">{t('taskCardPreviewTitle')}</p>
            {!preferences.compact && <p className="mt-1 text-muted-foreground">{t('taskCardPreviewDetail')}</p>}
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Label htmlFor="task-card-auto-hide">{t('taskCardAutoHideLabel')}</Label>
        <Select
          value={String(preferences.auto_hide_seconds)}
          disabled={working}
          onValueChange={(value) => void save({ ...preferences, auto_hide_seconds: Number(value) as TaskCardPreferences['auto_hide_seconds'] })}
        >
          <SelectTrigger id="task-card-auto-hide" className="w-28"><SelectValue /></SelectTrigger>
          <SelectContent>
            {[3, 5, 10].map((seconds) => <SelectItem key={seconds} value={String(seconds)}>{t('taskCardAutoHideSeconds', { seconds })}</SelectItem>)}
          </SelectContent>
        </Select>
        <div className="ml-auto flex items-center gap-2">
          <Checkbox
            id="task-card-compact"
            checked={preferences.compact}
            disabled={working}
            onCheckedChange={(checked) => void save({ ...preferences, compact: checked === true })}
          />
          <Label htmlFor="task-card-compact">{t('taskCardCompactLabel')}</Label>
        </div>
      </div>
    </div>
  )
}

function previewClassFor(position: TaskCardPosition) {
  const [vertical, horizontal] = position.split('-') as [string, string | undefined]
  const verticalClass = vertical === 'top' ? 'top-2' : vertical === 'bottom' ? 'bottom-2' : 'top-1/2 -translate-y-1/2'
  const horizontalClass = horizontal === 'left' ? 'left-2' : horizontal === 'right' ? 'right-2' : 'left-1/2 -translate-x-1/2'
  return `${verticalClass} ${horizontalClass}`
}

// 只把本应用加进 txt 文件右键"打开方式"的候选列表（HKCU\...\Applications\
// <key>），不改 .txt 本身的系统默认关联——不会抢记事本的默认程序位置，
// 选中的文件会作为一条新笔记导入进笔记库（见 NotesScreen 的
// pendingImportPath）。仅 Windows 生效，main.ts 那边非 Windows 平台会让
// setTxtAssociation 直接抛错，这里兜住并回滚勾选状态。
function TxtAssociationSetting() {
  const { t } = useTranslation('settings')
  const [enabled, setEnabled] = useState(false)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    electronApi.getTxtAssociation().then((v) => {
      setEnabled(v)
      setLoaded(true)
    })
  }, [])

  async function handleToggle(checked: boolean) {
    setEnabled(checked)
    try {
      await electronApi.setTxtAssociation(checked)
      toast.success(checked ? t('txtAssociationEnabledToast') : t('txtAssociationDisabledToast'))
    } catch {
      setEnabled(!checked)
      toast.error(t('txtAssociationFailedToast'))
    }
  }

  if (!loaded) return null

  return (
    <div className="flex items-start gap-2 rounded border p-3">
      <Checkbox
        id="txt-association"
        checked={enabled}
        onCheckedChange={(v) => handleToggle(v === true)}
        className="mt-0.5"
      />
      <div>
        <Label htmlFor="txt-association">{t('txtAssociationLabel')}</Label>
      </div>
    </div>
  )
}

// 跟 TxtAssociationSetting 同一套逻辑，换成 .md/.markdown（main.ts 里
// setMdAssociation 内部会同时注册这两个扩展名，这里只需要一个开关）。
// 选中的.md文件同样按"导入进笔记库"处理，落库时按扩展名自动打上
// format='markdown'标签（见 notes/service.py 的 _detect_format_from_path）。
function MdAssociationSetting() {
  const { t } = useTranslation('settings')
  const [enabled, setEnabled] = useState(false)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    electronApi.getMdAssociation().then((v) => {
      setEnabled(v)
      setLoaded(true)
    })
  }, [])

  async function handleToggle(checked: boolean) {
    setEnabled(checked)
    try {
      await electronApi.setMdAssociation(checked)
      toast.success(checked ? t('mdAssociationEnabledToast') : t('mdAssociationDisabledToast'))
    } catch {
      setEnabled(!checked)
      toast.error(t('mdAssociationFailedToast'))
    }
  }

  if (!loaded) return null

  return (
    <div className="flex items-start gap-2 rounded border p-3">
      <Checkbox id="md-association" checked={enabled} onCheckedChange={(v) => handleToggle(v === true)} className="mt-0.5" />
      <div>
        <Label htmlFor="md-association">{t('mdAssociationLabel')}</Label>
      </div>
    </div>
  )
}

const MODULE_LOCK_ITEMS: {
  module: LockableModule
  labelKey:
    | 'moduleLockFilesLabel'
    | 'moduleLockClipboardLabel'
    | 'moduleLockPasswordsLabel'
    | 'moduleLockRecoveryCodesLabel'
    | 'moduleLockNotesLabel'
    | 'moduleLockAiLabel'
    | 'moduleLockNetworkLabel'
    | 'moduleLockFileManagerLabel'
    | 'moduleLockPcCleanLabel'
}[] = [
  { module: 'files', labelKey: 'moduleLockFilesLabel' },
  { module: 'clipboard', labelKey: 'moduleLockClipboardLabel' },
  { module: 'passwords', labelKey: 'moduleLockPasswordsLabel' },
  { module: 'recoverycodes', labelKey: 'moduleLockRecoveryCodesLabel' },
  { module: 'notes', labelKey: 'moduleLockNotesLabel' },
  { module: 'ai', labelKey: 'moduleLockAiLabel' },
  { module: 'network', labelKey: 'moduleLockNetworkLabel' },
  { module: 'filemanager', labelKey: 'moduleLockFileManagerLabel' },
  // 整个清理套件一项。它能卸载软件、删注册表项、动启动项——按"删了撤不回来"
  // 的标准衡量，风险不比密码库低，所以它该在这张表里，而不该是唯一一个
  // 谁都能直接点进去的重模块。
  { module: 'pcclean', labelKey: 'moduleLockPcCleanLabel' },
]

function ModuleLockSettings({
  moduleLocks,
  onModuleLocksChange,
}: {
  moduleLocks: Record<LockableModule, boolean>
  onModuleLocksChange: (settings: Record<LockableModule, boolean>) => void
}) {
  const { t } = useTranslation('settings')

  // moduleLocks 的唯一数据源是 AppShell（它同时也是 handleNavClick 校验用的
  // 那份 state）——这里不再自己独立 fetch/持有一份副本。之前的版本各自维护
  // 一份状态，导致在设置页取消勾选后，AppShell 那份判断"是否要求解锁"的
  // 状态并不知道变化，直到应用重启才会同步，看起来就像"取消了还是要验证"。
  async function handleToggle(module: LockableModule, checked: boolean) {
    const previous = moduleLocks
    onModuleLocksChange({ ...moduleLocks, [module]: checked })
    const res = await vaultApi.call('module_lock_settings_set', { module, enabled: checked })
    if (!res.ok) {
      toast.error(t('moduleLockUpdateFailedToast'), { description: translateError(res.error, res.error_params) })
      onModuleLocksChange(previous)
      return
    }
    toast.success(t('moduleLockUpdatedToast'))
  }

  return (
    <div className="space-y-2 rounded border p-3">
      <p className="text-sm font-medium">{t('moduleLockTitle')}</p>
      {MODULE_LOCK_ITEMS.map(({ module, labelKey }) => (
        <div key={module} className="flex items-center gap-2">
          <Checkbox
            id={`module-lock-${module}`}
            checked={moduleLocks[module]}
            onCheckedChange={(v) => handleToggle(module, v === true)}
          />
          <Label htmlFor={`module-lock-${module}`}>{t(labelKey)}</Label>
        </div>
      ))}
    </div>
  )
}

function ClipboardImageViewModeSetting() {
  const { t } = useTranslation('settings')
  const [mode, setMode] = useState<ClipboardImageViewMode>(() => loadClipboardImageViewMode())

  return (
    <div className="space-y-2">
      <Label htmlFor="clipboard-image-view-mode">{t('imageViewModeLabel')}</Label>
      <Select
        value={mode}
        onValueChange={(v) => {
          const next = v as ClipboardImageViewMode
          setMode(next)
          // 只落 localStorage，不走后端：这纯粹是"界面怎么呈现"，跟金库数据无关。
          // 剪贴板面板在挂载时读一次，所以改完切过去就是新的。
          saveClipboardImageViewMode(next)
        }}
      >
        <SelectTrigger id="clipboard-image-view-mode" className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="fullscreen">{t('imageViewModeFullscreen')}</SelectItem>
          <SelectItem value="window">{t('imageViewModeWindow')}</SelectItem>
        </SelectContent>
      </Select>
    </div>
  )
}


function ClipboardBlacklistSetting() {
  const { t } = useTranslation('settings')
  const [apps, setApps] = useState<BlacklistApp[]>([])
  const [newApp, setNewApp] = useState('')

  async function reload() {
    const res = await vaultApi.call('clipboard_blacklist_list', {})
    if (res.ok) setApps(res.apps)
  }

  useEffect(() => {
    reload()
  }, [])

  async function handleAdd() {
    const name = newApp.trim()
    if (!name) return
    const res = await vaultApi.call('clipboard_blacklist_add', { app_name: name })
    if (!res.ok) {
      toast.error(t('blacklistAddFailedToast'), { description: translateError(res.error, res.error_params) })
      return
    }
    setNewApp('')
    await reload()
  }

  async function handleRemove(id: number) {
    const res = await vaultApi.call('clipboard_blacklist_remove', { id })
    if (!res.ok) {
      toast.error(t('blacklistRemoveFailedToast'), { description: translateError(res.error, res.error_params) })
      return
    }
    await reload()
  }

  return (
    <div className="space-y-2 rounded border p-3">
      <p className="text-sm font-medium">{t('blacklistTitle')}</p>
      <div className="flex gap-2">
        <Input
          placeholder={t('blacklistInputPlaceholder')}
          value={newApp}
          onChange={(e) => setNewApp(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
        />
        <Button onClick={handleAdd}>{t('blacklistAddButton')}</Button>
      </div>
      {apps.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('blacklistEmpty')}</p>
      ) : (
        <div className="space-y-1">
          {apps.map((app) => (
            <div key={app.id} className="flex items-center justify-between rounded border px-2 py-1">
              <span className="font-mono text-sm">{app.app_name}</span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => handleRemove(app.id)}
                    aria-label={t('blacklistRemoveAriaLabel', { name: app.app_name })}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('blacklistRemoveAriaLabel', { name: app.app_name })}</TooltipContent>
              </Tooltip>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * 自动锁定。
 *
 * 在这个组件出现之前，**金库一旦解锁就一直是解锁的**，直到应用退出：人离开
 * 座位、合上盖子、按 Win+L 锁屏，金库全都还开着。
 *
 * 锁定的做法是把后端进程整个换掉（见 electron/pythonBridge.ts 的
 * restartForLock），不是在原进程里把密钥置空——那样清不干净。
 */
/**
 * 胁迫密码。
 *
 * 设一个第二密码，输它进去会打开一个**看起来完全正常、但内容毫无关系**的诱饵
 * 金库。真金库的内容在那种状态下完全接触不到，改密码 / 重绑验证器 / 搬家这几件
 * 会写身份库的事也一律被拒。
 *
 * 界面上有一处刻意的"撒谎"：**用胁迫密码进来之后，这一栏会显示"没设过"。**
 * 那不是 bug，那就是这个功能存在的理由——被逼着打开设置页给人看的时候，看到的
 * 必须是"这台机器没有这种东西"。
 */
function DuressPasswordSetting() {
  const { t } = useTranslation('settings')
  const [configured, setConfigured] = useState<boolean | null>(null)
  const [open, setOpen] = useState(false)
  const [currentPassword, setCurrentPassword] = useState('')
  const [duressPassword, setDuressPassword] = useState('')
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(() => {
    void vaultApi.call('duress_status', {}).then((res) => {
      if (res.ok) setConfigured(res.configured)
    })
  }, [])
  useEffect(refresh, [refresh])

  async function save() {
    setBusy(true)
    try {
      const res = await vaultApi.call('duress_set', {
        current_password: currentPassword,
        duress_password: duressPassword,
      })
      if (!res.ok) {
        toast.error(translateError(res.error, res.error_params))
        return
      }
      toast.success(t('duressSavedToast'))
      setOpen(false)
      setCurrentPassword('')
      setDuressPassword('')
      refresh()
    } finally {
      setBusy(false)
    }
  }

  async function clear() {
    const res = await vaultApi.call('duress_clear', {})
    if (res.ok) {
      toast.success(t('duressClearedToast'))
      refresh()
    }
  }

  if (configured === null) return null

  return (
    <div className="space-y-2 rounded border p-3">
      <p className="text-sm font-medium">{t('duressTitle')}</p>
      <p className="text-sm text-muted-foreground">
        {configured ? t('duressStateOn') : t('duressStateOff')}
      </p>
      <div className="flex flex-wrap gap-2 pt-1">
        <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
          <ShieldAlert className="size-4" />
          {configured ? t('duressChangeButton') : t('duressSetButton')}
        </Button>
        {configured && (
          <Button variant="outline" size="sm" onClick={() => void clear()}>
            <Trash2 className="size-4" />
            {t('duressClearButton')}
          </Button>
        )}
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('duressDialogTitle')}</DialogTitle>
            <DialogDescription>{t('duressDialogBody')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label className="text-sm">{t('duressCurrentPasswordLabel')}</Label>
              <Input
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                autoComplete="current-password"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-sm">{t('duressNewPasswordLabel')}</Label>
              <Input
                type="password"
                value={duressPassword}
                onChange={(e) => setDuressPassword(e.target.value)}
                autoComplete="new-password"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              {t('duressCancelButton')}
            </Button>
            <Button disabled={busy || !currentPassword || duressPassword.length < 8} onClick={() => void save()}>
              {t('duressConfirmButton')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function AutoLockSetting() {
  const { t } = useTranslation('settings')
  const [settings, setSettings] = useState<AutoLockSettings | null>(null)

  useEffect(() => {
    void electronApi.getAutoLock().then(setSettings)
  }, [])

  async function update(patchValue: Partial<AutoLockSettings>) {
    if (!settings) return
    const next = { ...settings, ...patchValue }
    setSettings(next)
    setSettings(await electronApi.setAutoLock(next))
  }

  if (!settings) return null

  return (
    <div className="space-y-3 rounded border p-3">
      <p className="text-sm font-medium">{t('autoLockTitle')}</p>
      <div className="flex flex-col gap-3 pt-1">
        <div className="flex items-center justify-between gap-4">
          <Label className="text-sm">{t('autoLockIdleLabel')}</Label>
          <Select
            value={String(settings.idleMinutes)}
            onValueChange={(v) => void update({ idleMinutes: Number(v) })}
          >
            <SelectTrigger className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="0">{t('autoLockNever')}</SelectItem>
              {[1, 5, 15, 30, 60, 120].map((m) => (
                <SelectItem key={m} value={String(m)}>
                  {m} {t('autoLockMinutes')}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center justify-between gap-4">
          <Label className="text-sm">{t('autoLockTrayLabel')}</Label>
          <Select
            value={String(settings.trayMinutes)}
            onValueChange={(v) => void update({ trayMinutes: Number(v) })}
          >
            <SelectTrigger className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="0">{t('autoLockNever')}</SelectItem>
              {[1, 5, 15, 30, 60].map((m) => (
                <SelectItem key={m} value={String(m)}>
                  {m} {t('autoLockMinutes')}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <label className="flex items-center justify-between gap-4 text-sm">
          {t('autoLockOnScreenLockLabel')}
          <Checkbox
            checked={settings.onScreenLock}
            onCheckedChange={(v) => void update({ onScreenLock: v === true })}
          />
        </label>
        <label className="flex items-center justify-between gap-4 text-sm">
          {t('autoLockOnSuspendLabel')}
          <Checkbox
            checked={settings.onSuspend}
            onCheckedChange={(v) => void update({ onSuspend: v === true })}
          />
        </label>
        <Button variant="outline" size="sm" className="justify-start" onClick={() => void electronApi.lockNow()}>
          <Lock className="size-4" />
          {t('autoLockNowButton')}
        </Button>
      </div>
    </div>
  )
}

function ClipboardCleanupSetting() {
  const { t } = useTranslation('settings')
  const [maxEntries, setMaxEntries] = useState(500)
  const [cleanupDays, setCleanupDays] = useState(0)
  const [sensitiveTtl, setSensitiveTtl] = useState(0)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    vaultApi.call('clipboard_settings_get', {}).then((res) => {
      if (res.ok) {
        setMaxEntries(res.settings.max_entries)
        setCleanupDays(res.settings.cleanup_days)
        setSensitiveTtl(res.settings.sensitive_ttl_minutes)
        setLoaded(true)
      }
    })
  }, [])

  async function handleSave() {
    const res = await vaultApi.call('clipboard_settings_set', {
      settings: { max_entries: maxEntries, cleanup_days: cleanupDays, sensitive_ttl_minutes: sensitiveTtl },
    })
    if (res.ok) {
      toast.success(t('clipboardCleanupSavedToast'))
    } else {
      toast.error(t('clipboardCleanupSaveFailedToast'))
    }
  }

  if (!loaded) return null

  return (
    <div className="space-y-2 rounded border p-3">
      <p className="text-sm font-medium">{t('clipboardCleanupTitle')}</p>
      <div className="flex flex-col gap-3 pt-1">
        <div className="flex items-center justify-between gap-4">
          <Label className="text-sm">{t('clipboardCleanupMaxEntriesLabel')}</Label>
          <Select value={String(maxEntries)} onValueChange={(v) => setMaxEntries(Number(v))}>
            <SelectTrigger className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="100">100</SelectItem>
              <SelectItem value="200">200</SelectItem>
              <SelectItem value="500">500</SelectItem>
              <SelectItem value="1000">1000</SelectItem>
              <SelectItem value="2000">2000</SelectItem>
              <SelectItem value="5000">5000</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center justify-between gap-4">
          <Label className="text-sm">{t('clipboardCleanupDaysLabel')}</Label>
          <Select value={String(cleanupDays)} onValueChange={(v) => setCleanupDays(Number(v))}>
            <SelectTrigger className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="0">{t('clipboardCleanupDaysNever')}</SelectItem>
              <SelectItem value="1">1 {t('clipboardCleanupDaysUnit')}</SelectItem>
              <SelectItem value="3">3 {t('clipboardCleanupDaysUnit')}</SelectItem>
              <SelectItem value="7">7 {t('clipboardCleanupDaysUnit')}</SelectItem>
              <SelectItem value="14">14 {t('clipboardCleanupDaysUnit')}</SelectItem>
              <SelectItem value="30">30 {t('clipboardCleanupDaysUnit')}</SelectItem>
              <SelectItem value="90">90 {t('clipboardCleanupDaysUnit')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center justify-between gap-4">
          <Label className="text-sm">{t('clipboardSensitiveTtlLabel')}</Label>
          <Select value={String(sensitiveTtl)} onValueChange={(v) => setSensitiveTtl(Number(v))}>
            <SelectTrigger className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="0">{t('clipboardCleanupDaysNever')}</SelectItem>
              <SelectItem value="1">1 {t('clipboardSensitiveTtlUnit')}</SelectItem>
              <SelectItem value="5">5 {t('clipboardSensitiveTtlUnit')}</SelectItem>
              <SelectItem value="15">15 {t('clipboardSensitiveTtlUnit')}</SelectItem>
              <SelectItem value="30">30 {t('clipboardSensitiveTtlUnit')}</SelectItem>
              <SelectItem value="60">60 {t('clipboardSensitiveTtlUnit')}</SelectItem>
              <SelectItem value="240">240 {t('clipboardSensitiveTtlUnit')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Button size="sm" onClick={handleSave}>{t('clipboardCleanupSaveButton')}</Button>
        <InfoHint text={t('clipboardCleanupNote')} />
      </div>
    </div>
  )
}

function NoteImageStorageModeSetting() {
  const { t } = useTranslation('settings')
  const [mode, setMode] = useState<NoteImageStorageMode>('encrypted_db')
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    vaultApi.call('note_image_storage_mode_get', {}).then((res) => {
      if (res.ok) setMode(res.mode)
      setLoaded(true)
    })
  }, [])

  // 只影响这次修改之后新增的图片——已经存好的图片各自记着自己是用哪种
  // 方式写的，不会被这次切换回头转换（见 notes/storage.py note_images 表
  // 的 storage_mode 列注释），所以这里切换不需要任何迁移确认弹窗。
  async function handleChange(next: NoteImageStorageMode) {
    const previous = mode
    setMode(next)
    const res = await vaultApi.call('note_image_storage_mode_set', { mode: next })
    if (!res.ok) {
      toast.error(t('noteImageStorageModeUpdateFailedToast'), { description: translateError(res.error, res.error_params) })
      setMode(previous)
      return
    }
    toast.success(t('noteImageStorageModeUpdatedToast'))
  }

  if (!loaded) return null

  return (
    <div className="space-y-2 rounded border p-3">
      <p className="text-sm font-medium">{t('noteImageStorageModeTitle')}</p>
      <Select value={mode} onValueChange={(v) => handleChange(v as NoteImageStorageMode)}>
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="encrypted_db">{t('noteImageStorageModeEncryptedDb')}</SelectItem>
          <SelectItem value="disk_plain">{t('noteImageStorageModeDiskPlain')}</SelectItem>
        </SelectContent>
      </Select>
      <p className="text-sm text-muted-foreground">
        {mode === 'encrypted_db' ? t('noteImageStorageModeEncryptedDbDesc') : t('noteImageStorageModeDiskPlainDesc')}
      </p>
    </div>
  )
}

// 只是"新建/导入笔记"弹窗里加密开关的默认起始状态 - 跟笔记图片的存储方式
// 设置是两个独立开关（笔记正文 vs 笔记里挂的图片），互不影响。修改这里
// 不会影响任何已经存在的笔记，每条笔记的存储方式在创建那一刻就固定了
// （见 notes/storage.py 的 content_storage_mode 列注释）。
function NoteTextStorageModeSetting() {
  const { t } = useTranslation('settings')
  const [mode, setMode] = useState<NoteTextStorageMode>('encrypted_db')
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    vaultApi.call('note_text_storage_mode_get', {}).then((res) => {
      if (res.ok) setMode(res.mode)
      setLoaded(true)
    })
  }, [])

  async function handleChange(next: NoteTextStorageMode) {
    const previous = mode
    setMode(next)
    const res = await vaultApi.call('note_text_storage_mode_set', { mode: next })
    if (!res.ok) {
      toast.error(t('noteTextStorageModeUpdateFailedToast'), { description: translateError(res.error, res.error_params) })
      setMode(previous)
      return
    }
    toast.success(t('noteTextStorageModeUpdatedToast'))
  }

  if (!loaded) return null

  return (
    <div className="space-y-2 rounded border p-3">
      <p className="text-sm font-medium">{t('noteTextStorageModeTitle')}</p>
      <Select value={mode} onValueChange={(v) => handleChange(v as NoteTextStorageMode)}>
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="encrypted_db">{t('noteTextStorageModeEncryptedDb')}</SelectItem>
          <SelectItem value="disk_plain">{t('noteTextStorageModeDiskPlain')}</SelectItem>
        </SelectContent>
      </Select>
      <p className="text-sm text-muted-foreground">
        {mode === 'encrypted_db' ? t('noteTextStorageModeEncryptedDbDesc') : t('noteTextStorageModeDiskPlainDesc')}
      </p>
    </div>
  )
}

function ChangePasswordDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useTranslation('settings')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')

  async function handleSave() {
    if (password.length < 8) {
      setError(t('passwordTooShort'))
      return
    }
    if (password !== confirm) {
      setError(t('passwordMismatch'))
      return
    }
    await vaultApi.call('change_password', { new_password: password })
    toast.success(t('passwordUpdatedToast'))
    setPassword('')
    setConfirm('')
    setError('')
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* 宽度档位见本文件顶部 FORM_DIALOG / WIDE_FORM_DIALOG 的说明：
          两个字段的单列表单走窄档。 */}
      <DialogContent className={FORM_DIALOG}>
        <DialogHeader>
          <DialogTitle>{t('changePasswordDialogTitle')}</DialogTitle>
        </DialogHeader>
        <div className={FORM_BODY}>
          <div className={FIELD}>
            <Label htmlFor="new-password">{t('newPasswordLabel')}</Label>
            <Input id="new-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          <div className={FIELD}>
            <Label htmlFor="new-password-confirm">{t('newPasswordConfirmLabel')}</Label>
            <Input
              id="new-password-confirm"
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </div>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <Button className="w-full" onClick={handleSave}>
            {t('saveButton')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function RebindTotpDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useTranslation('settings')
  const [seed, setSeed] = useState('')
  const [qr, setQr] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    if (open && !loaded) {
      vaultApi.call('rebind_totp_start', {}).then((res) => {
        setSeed(res.seed)
        setQr(res.qr_png_base64)
        setLoaded(true)
      })
    }
    if (!open) {
      setLoaded(false)
      setCode('')
      setError('')
    }
  }, [open, loaded])

  async function handleSave() {
    const res = await vaultApi.call('rebind_totp_confirm', { seed, code })
    if (!res.ok) {
      setError(translateError(res.error, res.error_params))
      return
    }
    toast.success(t('totpRebindSuccessToast'))
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={FORM_DIALOG}>
        <DialogHeader>
          <DialogTitle>{t('rebindTotpDialogTitle')}</DialogTitle>
        </DialogHeader>
        {loaded ? (
          <div className={FORM_BODY}>
            <p className="text-sm leading-relaxed text-muted-foreground">{t('totpScanInstruction')}</p>
            <div className="flex justify-center rounded-xl border border-border bg-surface p-5">
              <img src={`data:image/png;base64,${qr}`} alt={t('totpQrAlt')} className="h-56 w-56" />
            </div>
            <div className={FIELD}>
              <Label htmlFor="rebind-code">{t('totpConfirmCodeLabel')}</Label>
              {/* 验证器的六位码跟登录页那个输入框是同一件东西，所以**引用同一个
                  常量**而不是抄一遍类名——抄的那一份迟早会跟本尊分家，而且分了
                  也没人看得出来。 */}
              <Input
                id="rebind-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                className={CODE_INPUT_CLASS}
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
            </div>
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <Button className="w-full" onClick={handleSave}>
              {t('confirmBindButton')}
            </Button>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t('loading')}</p>
        )}
      </DialogContent>
    </Dialog>
  )
}

function UpdateEmailDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useTranslation('settings')
  const [email, setEmail] = useState('')
  const [host, setHost] = useState('')
  const [port, setPort] = useState('587')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [useSsl, setUseSsl] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [testing, setTesting] = useState(false)

  useEffect(() => {
    if (open && !loaded) {
      vaultApi.call('get_smtp_config', {}).then((res) => {
        if (res.config) {
          setHost(res.config.host)
          setPort(String(res.config.port))
          setUsername(res.config.username)
          setUseSsl(res.config.use_ssl)
        }
        setLoaded(true)
      })
    }
    if (!open) setLoaded(false)
  }, [open, loaded])

  async function handleSave() {
    const smtp_config: SmtpConfigInput = { host, port: Number(port) || 587, username, password, use_ssl: useSsl }
    await vaultApi.call('update_email', { new_email: email, smtp_config })
    toast.success(t('emailUpdatedToast'))
    onOpenChange(false)
  }

  // 保存前先验证发信配置能不能用 - 不用等真正改成这份配置、下次邮箱解锁失败
  // 才发现填错了。用的是当前表单里的值，不需要先点保存。
  async function handleSendTestEmail() {
    if (!email.trim() || !host.trim() || !username.trim() || !password.trim()) {
      toast.error(t('testEmailMissingFieldsToast'))
      return
    }
    const smtp_config: SmtpConfigInput = { host, port: Number(port) || 587, username, password, use_ssl: useSsl }
    setTesting(true)
    const res = await vaultApi.call('send_test_email', { smtp_config, to_addr: email })
    setTesting(false)
    if (!res.ok) {
      toast.error(t('testEmailFailedToast'), { description: translateError(res.error, res.error_params) })
      return
    }
    toast.success(t('testEmailSentToast'))
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* 五个字段：走宽档 + 两列。字段的分组不是"两两塞满"，而是按它们在现实里
          属于同一件事来配对——服务器地址和端口是一对，账号和密码是一对，收件
          地址自己独占一行因为它跟 SMTP 服务器根本不是一回事。 */}
      <DialogContent className={WIDE_FORM_DIALOG}>
        <DialogHeader>
          <DialogTitle>{t('updateEmailDialogTitle')}</DialogTitle>
        </DialogHeader>
        <div className={FORM_BODY}>
          <div className={FIELD}>
            <Label htmlFor="settings-email">{t('recoveryEmailLabel')}</Label>
            <Input id="settings-email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div className={FORM_GRID}>
            <div className={FIELD}>
              <Label htmlFor="settings-host">{t('smtpHostLabel')}</Label>
              <Input id="settings-host" value={host} onChange={(e) => setHost(e.target.value)} />
            </div>
            <div className={FIELD}>
              <Label htmlFor="settings-port">{t('smtpPortLabel')}</Label>
              <Input id="settings-port" inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value)} />
            </div>
            <div className={FIELD}>
              <Label htmlFor="settings-username">{t('smtpUsernameLabel')}</Label>
              <Input id="settings-username" value={username} onChange={(e) => setUsername(e.target.value)} />
            </div>
            <div className={FIELD}>
              <Label htmlFor="settings-password">{t('smtpPasswordLabel')}</Label>
              <Input
                id="settings-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
          </div>
          <div className="flex items-center gap-2.5 rounded-lg border border-border bg-surface px-3.5 py-3">
            <Checkbox id="settings-ssl" checked={useSsl} onCheckedChange={(v) => setUseSsl(v === true)} />
            <Label htmlFor="settings-ssl" className="cursor-pointer font-normal">{t('smtpSslLabel')}</Label>
          </div>
        </div>
        {/* 按钮组固定在底部、不参与滚动：字段一多，"保存"就会被滚出屏幕。 */}
        <div className="flex shrink-0 flex-col gap-2.5 border-t border-border pt-5 sm:flex-row sm:justify-end">
          <Button variant="outline" onClick={handleSendTestEmail} disabled={testing}>
            {testing ? t('sendingTestEmailButton') : t('sendTestEmailButton')}
          </Button>
          <Button onClick={handleSave}>{t('saveButton')}</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function AiSettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useTranslation('settings')
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState('deepseek-v4-pro')
  const [baseUrl, setBaseUrl] = useState('https://api.deepseek.com')
  const [configured, setConfigured] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: true; latencyMs: number } | { ok: false } | null>(null)
  // 服务端现在提供哪些模型。空数组有两种含义（还没拉过 / 拉了但端点没有这个接口），
  // 两种都该让用户能继续手填模型名，所以下面的输入框永远保留，下拉只是个补充。
  const [models, setModels] = useState<string[]>([])
  // 带发布日期的同一批模型。后端旧版拿不到这个字段时退回只用 models，
  // 下拉照常能用，只是不显示日期——不能因为少一个装饰字段就整块功能不可用。
  const [modelDetails, setModelDetails] = useState<AiModelDetail[]>([])
  const [loadingModels, setLoadingModels] = useState(false)

  async function handleRefreshModels() {
    setLoadingModels(true)
    try {
      const res = await vaultApi.call('list_ai_models', currentInput())
      if (!res.ok) {
        toast.error(t('aiModelsFailedToast'), { description: translateError(res.error, res.error_params) })
        return
      }
      setModels(res.models)
      setModelDetails(res.model_details ?? res.models.map((id) => ({ id, label: id, released: null, note: null, deprecated: null })))
      // 拿到空列表不是失败——有些兼容端点没实现 /models。明说一句，
      // 免得用户对着一个没反应的按钮反复点。
      if (res.models.length === 0) toast.info(t('aiModelsEmptyToast'))
    } finally {
      setLoadingModels(false)
    }
  }

  useEffect(() => {
    if (open && !loaded) {
      vaultApi.call('get_ai_config', {}).then((res) => {
        if (res.config) {
          setModel(res.config.model)
          setBaseUrl(res.config.base_url)
          setConfigured(res.config.configured)
        }
        setLoaded(true)
      })
    }
    if (!open) {
      setLoaded(false)
      setApiKey('')
      setTestResult(null)
    }
  }, [open, loaded])

  function currentInput(): AiConfigInput {
    return { api_key: apiKey, model, base_url: baseUrl }
  }

  // A stale "connected" result shouldn't linger once the form no longer
  // matches what was actually tested (e.g. the user starts typing a new key).
  function updateField<T>(setter: (v: T) => void) {
    return (value: T) => {
      setter(value)
      setTestResult(null)
    }
  }

  async function handleSave() {
    const res = await vaultApi.call('update_ai_config', currentInput())
    if (!res.ok) {
      toast.error(t('aiConnectionFailedToast'), { description: translateError(res.error, res.error_params) })
      return
    }
    toast.success(t('aiConfigUpdatedToast'))
    onOpenChange(false)
  }

  // 跟发测试邮件一样的思路：用表单里当前的值先探一下这份配置能不能用，不用
  // 等保存之后才发现 Key 填错了。
  async function handleTestConnection() {
    if (!apiKey.trim() && !configured) {
      toast.error(t('aiApiKeyMissingToast'))
      return
    }
    setTesting(true)
    setTestResult(null)
    const res = await vaultApi.call('test_ai_connection', currentInput())
    setTesting(false)
    if (!res.ok) {
      setTestResult({ ok: false })
      toast.error(t('aiConnectionFailedToast'), { description: translateError(res.error, res.error_params) })
      return
    }
    setTestResult({ ok: true, latencyMs: res.latency_ms })
    toast.success(t('aiConnectionOkToast', { latency: res.latency_ms }))
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* 凭据（Key / 地址）一行、模型选择自己一整块：模型列表是这个弹窗里唯一
          会长到很高的东西，把它压在两列栅格的一格里会既窄又长。 */}
      <DialogContent className={WIDE_FORM_DIALOG}>
        <DialogHeader>
          <DialogTitle>{t('aiSettingsDialogTitle')}</DialogTitle>
        </DialogHeader>
        <div className={FORM_BODY}>
          <div className={FORM_GRID}>
            <div className={FIELD}>
              <Label htmlFor="ai-api-key">{t('aiApiKeyLabel')}</Label>
              <Input
                id="ai-api-key"
                type="password"
                value={apiKey}
                onChange={(e) => updateField(setApiKey)(e.target.value)}
                placeholder={configured ? '••••••••••••' : ''}
              />
              <p className="text-sm text-muted-foreground">
                {configured ? t('aiConfiguredHint') : t('aiNotConfiguredHint')}
              </p>
            </div>
            <div className={FIELD}>
              <Label htmlFor="ai-base-url">{t('aiBaseUrlLabel')}</Label>
              <Input id="ai-base-url" value={baseUrl} onChange={(e) => updateField(setBaseUrl)(e.target.value)} />
            </div>
          </div>
          <div className={FIELD}>
            <Label htmlFor="ai-model">{t('aiModelLabel')}</Label>
            {/* 下拉 + 输入框并存，不是二选一：拉到列表就从列表里挑，拉不到
                （端点没实现 /models）或者想用一个更新的模型名，直接填。
                只留下拉会让"服务端没列出来的模型"永远选不了。 */}
            <div className="flex gap-2">
              <Input
                id="ai-model"
                className="flex-1"
                list="ai-model-options"
                value={model}
                onChange={(e) => updateField(setModel)(e.target.value)}
              />
              <datalist id="ai-model-options">
                {models.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
              <Button
                type="button"
                variant="outline"
                onClick={handleRefreshModels}
                disabled={loadingModels}
                title={t('aiModelsRefreshHint')}
              >
                {loadingModels ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                {t('aiModelsRefreshButton')}
              </Button>
            </div>
            {modelDetails.length > 0 && (
              <div className="space-y-2 pt-1">
                <p className="text-sm text-muted-foreground">{t('aiModelsLoadedHint', { count: models.length })}</p>
                {/* 列表按发布日期从新到旧（后端排好的）。用户找"最新那个"是最常见的
                    诉求，让它永远在第一行，比按字母序把已停用的旧名字排在最前有用。
                    每一项都写清发布日期和规模——不然一串 id 之间根本无从选择。 */}
                <ul className="grid gap-2 sm:grid-cols-2">
                  {modelDetails.map((m) => {
                    const selected = m.id === model
                    return (
                      <li key={m.id}>
                        <button
                          type="button"
                          onClick={() => updateField(setModel)(m.id)}
                          aria-pressed={selected}
                          className={`h-full w-full rounded-lg border px-3.5 py-2.5 text-start leading-relaxed transition-colors ${
                            selected
                              ? 'border-accent-line bg-accent-soft'
                              : 'border-border bg-surface hover:bg-surface-strong'
                          }`}
                        >
                          <span className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                            <span className="font-medium">{m.label}</span>
                            {m.released && (
                              <span className="text-sm text-muted-foreground tabular">
                                {t('aiModelReleasedLabel', { date: m.released })}
                              </span>
                            )}
                          </span>
                          <span className="mt-0.5 block font-mono text-sm text-muted-foreground">{m.id}</span>
                          {m.note && <span className="mt-1 block text-sm text-muted-foreground">{m.note}</span>}
                          {m.deprecated && (
                            <span className="mt-1 block text-sm text-warning">
                              {t('aiModelDeprecatedWarning', { date: m.deprecated })}
                            </span>
                          )}
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </div>
            )}
          </div>
        </div>
        <div className="shrink-0 space-y-2 border-t border-border pt-5">
          {testResult && (
            <p className={`text-sm ${testResult.ok ? 'text-success' : 'text-destructive'}`}>
              {testResult.ok ? t('aiConnectionOkHint', { latency: testResult.latencyMs }) : t('aiConnectionFailedHint')}
            </p>
          )}
          <div className="flex flex-col gap-2.5 sm:flex-row sm:justify-end">
            <Button variant="outline" onClick={handleTestConnection} disabled={testing}>
              {testing ? t('testingAiConnectionButton') : t('testAiConnectionButton')}
            </Button>
            <Button onClick={handleSave}>{t('saveButton')}</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function RecoveryCodesSettingsToggle() {
  const { t } = useTranslation('settings')
  const [settings, setSettings] = useState<RecoveryCodesSettings | null>(null)

  useEffect(() => {
    vaultApi.call('recovery_codes_settings_get', {}).then((res) => {
      if (res.ok) setSettings(res.settings)
    })
  }, [])

  async function toggleVerify(checked: boolean) {
    setSettings((prev) => prev ? { ...prev, reveal_requires_verify: checked } : null)
    const res = await vaultApi.call('recovery_codes_settings_set', { reveal_requires_verify: checked })
    if (!res.ok) {
      setSettings((prev) => prev ? { ...prev, reveal_requires_verify: !checked } : null)
      toast.error(t('moduleLockUpdateFailedToast'), { description: translateError(res.error, res.error_params) })
    }
  }

  if (!settings) return null

  return (
    <Button
      className="w-full"
      variant="outline"
      onClick={() => toggleVerify(!settings.reveal_requires_verify)}
    >
      {t(settings.reveal_requires_verify ? 'recoveryCodesVerifyOnButton' : 'recoveryCodesVerifyOffButton')}
    </Button>
  )
}

function RegenRecoveryDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useTranslation('settings')
  const [key, setKey] = useState('')
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    if (open && !loaded) {
      vaultApi.call('regenerate_recovery_key', {}).then((res) => {
        setKey(res.recovery_key)
        setLoaded(true)
      })
    }
    if (!open) setLoaded(false)
  }, [open, loaded])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={FORM_DIALOG}>
        <DialogHeader>
          <DialogTitle>{t('regenRecoveryDialogTitle')}</DialogTitle>
        </DialogHeader>
        {loaded ? (
          <div className={FORM_BODY}>
            <Alert variant="destructive">
              <AlertDescription>{t('oldKeyInvalidWarning')}</AlertDescription>
            </Alert>
            {/* 这串是要被人逐字抄到纸上的，所以跟登录页的恢复密钥输入框用同一套
                等宽写法：换一处就会有一处的 0/O、1/l 看起来不一样。 */}
            <Input readOnly value={key} className={KEY_INPUT_CLASS} />
            <div className="flex flex-col gap-2.5 sm:flex-row sm:justify-end">
              <Button variant="outline" onClick={() => void copyText(key)}>
                {t('copyToClipboard')}
              </Button>
              <Button onClick={() => onOpenChange(false)}>{t('closeButton')}</Button>
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t('loading')}</p>
        )}
      </DialogContent>
    </Dialog>
  )
}
