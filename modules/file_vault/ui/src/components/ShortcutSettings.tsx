import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ListChecks, RotateCcw } from 'lucide-react'
import { vaultApi } from '@/lib/vaultApi'
import { electronApi } from '@/lib/electronApi'
import { formatBinding } from '@/lib/shortcutFormat'
import { DEFAULT_FILE_MANAGER_SHORTCUTS, DEFAULT_GLOBAL_SHORTCUTS } from '@/lib/shortcutDefaults'
import { translateError } from '@/i18n/errors'
import type {
  FileManagerShortcutAction,
  FileManagerShortcuts,
  GlobalShortcutAction,
  GlobalShortcuts,
  ShortcutBinding,
} from '@/shared/ipcTypes'

// 设置页"快捷键"分区：5 条文件操作 + 2 条应用全局快捷键（Electron 主进程注册）。
// 冲突检查三层：①本组件即时预检（含固定的 Ctrl+K）；②文件操作由后端 ui_settings 复核；
// ③全局键由主进程复核，并以 globalShortcut.register 的真实结果兜底。

// 出厂键位从 lib/shortcutDefaults 取——速查卡和帮助页要的是同一份，
// 原先写在这里的两张表没法被它们 import，只能各抄一份或者干脆不要默认值。
const FILE_MANAGER_ACTIONS: FileManagerShortcutAction[] = [
  'copy',
  'cut',
  'paste',
  'delete_recycle',
  'delete_permanent',
]
const GLOBAL_ACTIONS: GlobalShortcutAction[] = ['toggleWindow', 'clipboardCapture', 'quickNote', 'openDevices']
// 五条文件快捷键都要同步到系统级 C 钩子，确保资源管理器与应用内行为一致。
const HOOK_RELEVANT_ACTIONS: FileManagerShortcutAction[] = ['copy', 'cut', 'paste', 'delete_recycle', 'delete_permanent']
// 应用固定占用，跟 ui_settings.py 的 builtin 保留集一致：Ctrl+K 命令面板
const FIXED_RESERVED: ShortcutBinding[] = [{ key: 'k', ctrl: true, alt: false, shift: false }]

type AnyShortcutAction = FileManagerShortcutAction | GlobalShortcutAction

// 选择器候选主键必须与按键捕获（keyFromEvent）认的集合完全一致，否则列表里出现按了不认的键。
const LETTER_KEYS = 'abcdefghijklmnopqrstuvwxyz'.split('')
const DIGIT_KEYS = '0123456789'.split('')

function isDeleteAction(action: AnyShortcutAction): boolean {
  return action === 'delete_recycle' || action === 'delete_permanent'
}

/** 该动作能选哪些主键。只有两条删除动作允许用 Delete 单键。 */
function keyOptionsFor(action: AnyShortcutAction): string[] {
  const base = [...LETTER_KEYS, ...DIGIT_KEYS]
  return isDeleteAction(action) ? ['Delete', ...base] : base
}

function isGlobalAction(action: AnyShortcutAction): action is GlobalShortcutAction {
  return action === 'toggleWindow' || action === 'clipboardCapture' || action === 'quickNote' || action === 'openDevices'
}

function signatureOf(binding: ShortcutBinding): string {
  return `${binding.key.toLowerCase()}|${binding.ctrl}|${binding.alt}|${binding.shift}`
}

// 用 e.code 而不是 e.key 取主键：Shift+数字的 e.key 是符号（'!'），字母的
// e.key 随大小写变化，e.code（'KeyV'/'Digit3'/'Delete'）不受修饰键影响。
function keyFromEvent(event: React.KeyboardEvent): string | null {
  if (event.key === 'Delete') return 'Delete'
  const code = event.code
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase()
  if (/^Digit[0-9]$/.test(code)) return code.slice(5)
  return null
}

export function ShortcutSettings() {
  const { t } = useTranslation('settings')
  const [fmShortcuts, setFmShortcuts] = useState<FileManagerShortcuts>(DEFAULT_FILE_MANAGER_SHORTCUTS)
  const [globalShortcuts, setGlobalShortcuts] = useState<GlobalShortcuts>(DEFAULT_GLOBAL_SHORTCUTS)
  const [registered, setRegistered] = useState<Record<GlobalShortcutAction, boolean>>({
    toggleWindow: true,
    clipboardCapture: true,
    quickNote: true,
    openDevices: true,
  })
  const [loaded, setLoaded] = useState(false)
  const [capturing, setCapturing] = useState<AnyShortcutAction | null>(null)
  // 「挑选」这条路：展开哪一行、这一行正在拼的组合。跟捕获态互斥——同时开着
  // 两种输入方式，按下的键到底算捕获还是算普通输入就说不清了。
  const [picking, setPicking] = useState<AnyShortcutAction | null>(null)
  const [draft, setDraft] = useState<ShortcutBinding>({ key: 'a', ctrl: true, alt: false, shift: false })

  function openPicker(action: AnyShortcutAction, current: ShortcutBinding) {
    setCapturing(null)
    if (picking === action) {
      setPicking(null)
      return
    }
    // 从当前生效的键位起步，而不是从空白起步：多数改键只是想动一个修饰键。
    setDraft({ ...current })
    setPicking(action)
  }

  useEffect(() => {
    let cancelled = false
    Promise.all([vaultApi.call('file_manager_shortcuts_get', {}), electronApi.getGlobalShortcuts()])
      .then(([fmRes, globalRes]) => {
        if (cancelled) return
        if (fmRes.ok) setFmShortcuts(fmRes.shortcuts)
        setGlobalShortcuts(globalRes.shortcuts)
        setRegistered(globalRes.registered)
        setLoaded(true)
      })
      .catch(() => {
        // 取不到就停在出厂键位，且照样置 loaded，否则分区永远卡在骨架屏。
        // 后端崩溃窗口期打开设置页时，必须 catch 以免出现未处理的异步失败。
        if (!cancelled) setLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // 本地预检：形状合法性 + 与其余 6 条以及固定保留键（Ctrl+K）的互撞。
  // 返回 errors.json 里的错误码，没问题返回 null。
  function validateLocally(action: AnyShortcutAction, binding: ShortcutBinding): string | null {
    const isDeleteAction = action === 'delete_recycle' || action === 'delete_permanent'
    if (binding.key === 'Delete') {
      if (!isDeleteAction || binding.ctrl || binding.alt) return 'settings.shortcut_invalid'
    } else if (!binding.ctrl && !binding.alt) {
      return 'settings.shortcut_invalid'
    }
    const candidate = signatureOf(binding)
    for (const other of FILE_MANAGER_ACTIONS) {
      if (other !== action && signatureOf(fmShortcuts[other]) === candidate) return 'settings.shortcut_conflict'
    }
    for (const other of GLOBAL_ACTIONS) {
      if (other !== action && signatureOf(globalShortcuts[other]) === candidate) return 'settings.shortcut_conflict'
    }
    if (FIXED_RESERVED.some((reserved) => signatureOf(reserved) === candidate)) return 'settings.shortcut_reserved'
    return null
  }

  async function syncHookAgent() {
    const res = await vaultApi.call('file_clip_hook_sync_shortcuts', {})
    if (!res.ok) {
      toast.error(t('shortcutHookSyncFailedToast'), { description: translateError(res.error, res.error_params) })
      return
    }
    if (res.agent_restarted) toast.success(t('shortcutSyncedToast'))
  }

  async function applyFileManagerBinding(action: FileManagerShortcutAction, binding: ShortcutBinding) {
    const next = { ...fmShortcuts, [action]: binding }
    const reserved = GLOBAL_ACTIONS.map((globalAction) => globalShortcuts[globalAction])
    const res = await vaultApi.call('file_manager_shortcuts_set', { shortcuts: next, reserved })
    if (!res.ok) {
      toast.error(t('shortcutSaveFailedToast'), { description: translateError(res.error, res.error_params) })
      return
    }
    setFmShortcuts(res.shortcuts)
    // 文件管理器面板（若已挂载）据此刷新它内存里的键位，不用重开应用
    window.dispatchEvent(new CustomEvent('file-manager-shortcuts-changed'))
    toast.success(t('shortcutSavedToast'))
    if (HOOK_RELEVANT_ACTIONS.includes(action)) await syncHookAgent()
  }

  async function applyGlobalBinding(action: GlobalShortcutAction, binding: ShortcutBinding) {
    const next = { ...globalShortcuts, [action]: binding }
    const res = await electronApi.setGlobalShortcuts(next)
    if (!res.ok) {
      toast.error(t('shortcutSaveFailedToast'), { description: translateError(res.error) })
      return
    }
    setGlobalShortcuts(res.shortcuts)
    setRegistered(res.registered)
    toast.success(t('shortcutSavedToast'))
    if (!res.registered[action]) toast.warning(t('shortcutNotRegisteredWarning'))
  }

  function handleCaptureKeyDown(action: AnyShortcutAction, event: React.KeyboardEvent) {
    event.preventDefault()
    event.stopPropagation()
    if (event.key === 'Escape') {
      setCapturing(null)
      return
    }
    if (event.key === 'Control' || event.key === 'Shift' || event.key === 'Alt' || event.key === 'Meta') {
      return // 还没按主键，继续等
    }
    const key = keyFromEvent(event)
    const binding: ShortcutBinding | null =
      key === null ? null : { key, ctrl: event.ctrlKey, alt: event.altKey, shift: event.shiftKey }
    const errorCode =
      binding === null
        ? 'settings.shortcut_invalid'
        : isGlobalAction(action) && binding.key === 'Delete'
          ? 'settings.shortcut_invalid'
          : validateLocally(action, binding)
    setCapturing(null)
    if (errorCode !== null || binding === null) {
      toast.error(t('shortcutSaveFailedToast'), { description: translateError(errorCode ?? 'settings.shortcut_invalid') })
      return
    }
    if (isGlobalAction(action)) void applyGlobalBinding(action, binding)
    else void applyFileManagerBinding(action, binding)
  }

  async function handleResetAll() {
    setCapturing(null)
    setPicking(null)
    // 先恢复全局键（它是文件操作那 5 条保存时的保留键来源），再恢复文件操作
    const globalRes = await electronApi.setGlobalShortcuts(DEFAULT_GLOBAL_SHORTCUTS)
    if (globalRes.ok) {
      setGlobalShortcuts(globalRes.shortcuts)
      setRegistered(globalRes.registered)
    }
    const reserved = GLOBAL_ACTIONS.map((globalAction) => DEFAULT_GLOBAL_SHORTCUTS[globalAction])
    const fmRes = await vaultApi.call('file_manager_shortcuts_set', {
      shortcuts: DEFAULT_FILE_MANAGER_SHORTCUTS,
      reserved,
    })
    if (!fmRes.ok) {
      toast.error(t('shortcutSaveFailedToast'), { description: translateError(fmRes.error, fmRes.error_params) })
      return
    }
    setFmShortcuts(fmRes.shortcuts)
    window.dispatchEvent(new CustomEvent('file-manager-shortcuts-changed'))
    toast.success(t('shortcutSavedToast'))
    await syncHookAgent()
  }

  /** 从选择器保存。走的是跟捕获完全相同的校验和写入路径，不另开一条。 */
  async function applyDraft(action: AnyShortcutAction) {
    const errorCode = draftError(action)
    if (errorCode !== null) {
      toast.error(t('shortcutSaveFailedToast'), { description: translateError(errorCode) })
      return
    }
    setPicking(null)
    if (isGlobalAction(action)) await applyGlobalBinding(action, draft)
    else await applyFileManagerBinding(action, draft)
  }

  /** 选择器里当前这组组合的问题码，没问题返回 null。用来**边选边提示**，
   * 而不是等到点保存才告诉用户"这个不行"。 */
  function draftError(action: AnyShortcutAction): string | null {
    if (isGlobalAction(action) && draft.key === 'Delete') return 'settings.shortcut_invalid'
    return validateLocally(action, draft)
  }

  function renderPicker(action: AnyShortcutAction) {
    const options = keyOptionsFor(action)
    const errorCode = draftError(action)
    const mods: { id: 'ctrl' | 'alt' | 'shift'; label: string }[] = [
      { id: 'ctrl', label: 'Ctrl' },
      { id: 'alt', label: 'Alt' },
      { id: 'shift', label: 'Shift' },
    ]
    return (
      <div className="space-y-2 rounded border bg-muted/30 p-2.5">
        <div className="flex flex-wrap items-center gap-2">
          {mods.map((mod) => (
            <Button
              key={mod.id}
              size="sm"
              role="switch"
              aria-checked={draft[mod.id]}
              variant={draft[mod.id] ? 'default' : 'outline'}
              className="font-mono"
              onClick={() => setDraft((prev) => ({ ...prev, [mod.id]: !prev[mod.id] }))}
            >
              {mod.label}
            </Button>
          ))}
          <Select value={draft.key} onValueChange={(value) => setDraft((prev) => ({ ...prev, key: value }))}>
            <SelectTrigger className="w-28 font-mono" aria-label={t('shortcutPickerKeyLabel')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="max-h-64">
              {options.map((option) => (
                <SelectItem key={option} value={option} className="font-mono">
                  {option === 'Delete' ? 'Delete' : option.toUpperCase()}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="font-mono text-sm">{formatBinding(draft)}</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={errorCode !== null} onClick={() => void applyDraft(action)}>
            {t('shortcutPickerApply')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setPicking(null)}>
            {t('shortcutPickerCancel')}
          </Button>
          {/* 冲突/非法当场显示。禁用保存按钮却不说为什么，是最让人恼火的一种禁用。 */}
          {errorCode !== null && (
            <span className="text-sm text-destructive">{translateError(errorCode)}</span>
          )}
        </div>
      </div>
    )
  }

  function renderRow(action: AnyShortcutAction, label: string, binding: ShortcutBinding, defaultBinding: ShortcutBinding) {
    const isCapturing = capturing === action
    const notRegistered = isGlobalAction(action) && loaded && !registered[action]
    return (
      <div key={action} className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm">
          {label}
          {notRegistered && (
            <span className="ml-2 text-sm text-amber-600 dark:text-amber-500" title={t('shortcutNotRegisteredWarning')}>
              {t('shortcutNotRegisteredBadge')}
            </span>
          )}
        </span>
        <div className="flex items-center gap-1">
          <Button
            variant={isCapturing ? 'default' : 'outline'}
            size="sm"
            className="min-w-[150px] font-mono text-sm"
            disabled={!loaded}
            title={t('shortcutChangeHint')}
            onClick={() => {
              setPicking(null)
              setCapturing(isCapturing ? null : action)
            }}
            onKeyDown={isCapturing ? (event) => handleCaptureKeyDown(action, event) : undefined}
            onBlur={isCapturing ? () => setCapturing(null) : undefined}
          >
            {isCapturing ? t('shortcutCaptureHint') : formatBinding(binding)}
          </Button>
          {/* 第二条改键路径：从列表里挑。
              只有"按一下想要的组合"这一条路时，用户得先知道该按什么，而且键盘
              上没有的组合（或者被系统先截走的组合）根本按不出来——按 Ctrl+Alt+Del
              就是个现成的例子。挑选式把可选范围直接摆出来，还能边选边看冲突提示。
              两条路写同一份数据、共用同一套校验，不是两套实现。 */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={picking === action ? 'default' : 'ghost'}
                size="sm"
                disabled={!loaded}
                aria-expanded={picking === action}
                aria-label={t('shortcutPickerOpen')}
                onClick={() => openPicker(action, binding)}
              >
                <ListChecks className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('shortcutPickerOpen')}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                disabled={!loaded}
                aria-label={t('shortcutResetOneTitle')}
                onClick={() => {
                  setCapturing(null)
                  if (isGlobalAction(action)) void applyGlobalBinding(action, defaultBinding)
                  else void applyFileManagerBinding(action as FileManagerShortcutAction, defaultBinding)
                }}
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('shortcutResetOneTitle')}</TooltipContent>
          </Tooltip>
        </div>
      </div>
      {picking === action && renderPicker(action)}
      </div>
    )
  }

  const fmLabels: Record<FileManagerShortcutAction, string> = {
    copy: t('shortcutActionCopy'),
    cut: t('shortcutActionCut'),
    paste: t('shortcutActionPaste'),
    delete_recycle: t('shortcutActionDeleteRecycle'),
    delete_permanent: t('shortcutActionDeletePermanent'),
  }
  const globalLabels: Record<GlobalShortcutAction, string> = {
    toggleWindow: t('shortcutActionToggleWindow'),
    clipboardCapture: t('shortcutActionClipboardCapture'),
    quickNote: t('shortcutActionQuickNote'),
    openDevices: t('shortcutActionOpenDevices'),
  }

  return (
    <div className="space-y-3 rounded border p-3">
      <div className="space-y-2">
        <p className="text-sm font-medium text-muted-foreground">{t('shortcutGroupFileManager')}</p>
        {FILE_MANAGER_ACTIONS.map((action) =>
          renderRow(action, fmLabels[action], fmShortcuts[action], DEFAULT_FILE_MANAGER_SHORTCUTS[action])
        )}
      </div>
      <div className="space-y-2">
        <p className="text-sm font-medium text-muted-foreground">{t('shortcutGroupGlobal')}</p>
        {GLOBAL_ACTIONS.map((action) =>
          renderRow(action, globalLabels[action], globalShortcuts[action], DEFAULT_GLOBAL_SHORTCUTS[action])
        )}
      </div>
      <Button variant="outline" size="sm" className="w-full" disabled={!loaded} onClick={() => void handleResetAll()}>
        {t('shortcutResetAllButton')}
      </Button>
    </div>
  )
}
