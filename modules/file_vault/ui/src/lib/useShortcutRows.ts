import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { electronApi } from '@/lib/electronApi'
import { formatBinding } from '@/lib/shortcutFormat'
import { DEFAULT_FILE_MANAGER_SHORTCUTS, DEFAULT_GLOBAL_SHORTCUTS } from '@/lib/shortcutDefaults'
import { vaultApi } from '@/lib/vaultApi'
import type { FileManagerShortcuts, GlobalShortcuts } from '@/shared/ipcTypes'

export interface ShortcutRow {
  label: string
  keys: string
}

export interface ShortcutGroups {
  /** 用户可以在设置里改键位的那几条。显示的永远是改后的真实值。 */
  customizable: ShortcutRow[]
  /** 系统/编辑器约定的固定键，不提供自定义。 */
  fixed: ShortcutRow[]
  /** 面板跳转。编号跟左侧导航栏从上到下一一对应。 */
  panes: ShortcutRow[]
}

/**
 * 全部快捷键的唯一定义，供 HelpScreen 与按 `?` 弹出的速查卡共用，避免两处各抄一份而分家。
 * 用 hook 而非常量：前七条运行时读取（五条在后端 ui_settings，两条全局键位在主进程），须显示用户改后的值。
 *
 * `enabled`：速查卡挂在 App 最外层（锁屏也能看），但 `file_manager_shortcuts_get` 在金库未解锁时
 * 必然 reject（auth.not_unlocked）。须同时做到：未打开卡片就不发请求（后端 serve 循环单线程，
 * 这一发会排在 identity_exists 前拖慢登录框）；`.catch()` 接住 rejection（`void` 不算处理，
 * 会变成 unhandledrejection 的界面级错误）；失败回落出厂键位。
 */
export function useShortcutRows(enabled: boolean = true): ShortcutGroups {
  const { t } = useTranslation('help')
  const [fmShortcuts, setFmShortcuts] = useState<FileManagerShortcuts | null>(null)
  const [globalShortcuts, setGlobalShortcuts] = useState<GlobalShortcuts | null>(null)
  // "取过了但没取到"跟"还没开始取"是两种状态，显示上必须区分开，见 fm() 的注释。
  const [fmFailed, setFmFailed] = useState(false)
  const [globalFailed, setGlobalFailed] = useState(false)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    vaultApi
      .call('file_manager_shortcuts_get', {})
      .then((res) => {
        if (cancelled) return
        if (res.ok) setFmShortcuts(res.shortcuts)
        else setFmFailed(true)
      })
      .catch(() => {
        // 锁屏时必然走到这里（auth.not_unlocked），属设计内情况：静默回落，不弹 toast、不记日志。
        if (!cancelled) setFmFailed(true)
      })
    electronApi
      .getGlobalShortcuts()
      .then((res) => {
        if (!cancelled) setGlobalShortcuts(res.shortcuts)
      })
      .catch(() => {
        // 主进程这条不需要解锁，正常不会失败；但它跟上面一样不能裸奔——
        // 主进程重启的窗口期里 invoke 会 reject。
        if (!cancelled) setGlobalFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [enabled])

  // 三态：取到 → 真实键位；取失败（锁屏时是常态）→ 出厂键位，大概率对胜过一张全是 `…` 的卡；
  // 还在路上 → `…`（空串会被读成「没有快捷键」）。
  const fm = (pick: (s: FileManagerShortcuts) => FileManagerShortcuts[keyof FileManagerShortcuts]) => {
    if (fmShortcuts) return formatBinding(pick(fmShortcuts))
    if (fmFailed) return formatBinding(pick(DEFAULT_FILE_MANAGER_SHORTCUTS))
    return '…'
  }
  const gl = (pick: (s: GlobalShortcuts) => GlobalShortcuts[keyof GlobalShortcuts]) => {
    if (globalShortcuts) return formatBinding(pick(globalShortcuts))
    if (globalFailed) return formatBinding(pick(DEFAULT_GLOBAL_SHORTCUTS))
    return '…'
  }

  return {
    customizable: [
      { label: t('actionCopy'), keys: fm((s) => s.copy) },
      { label: t('actionCut'), keys: fm((s) => s.cut) },
      { label: t('actionPaste'), keys: fm((s) => s.paste) },
      { label: t('actionDeleteRecycle'), keys: fm((s) => s.delete_recycle) },
      { label: t('actionDeletePermanent'), keys: fm((s) => s.delete_permanent) },
      { label: t('actionToggleWindow'), keys: gl((s) => s.toggleWindow) },
      { label: t('actionClipboardCapture'), keys: gl((s) => s.clipboardCapture) },
      { label: t('actionQuickNote'), keys: gl((s) => s.quickNote) },
    ],
    fixed: [
      { label: t('fixedPalette'), keys: 'Ctrl + K' },
      { label: t('fixedNoteNew'), keys: 'Ctrl + N' },
      { label: t('fixedOpenFiles'), keys: 'Ctrl + O' },
      { label: t('fixedOpenSettings'), keys: 'Ctrl + ,' },
      { label: t('fixedHelp'), keys: 'F1' },
      { label: t('fixedFind'), keys: 'Ctrl + F' },
      { label: t('fixedReplace'), keys: 'Ctrl + H' },
      { label: t('fixedFindNext'), keys: 'F3 / Shift + F3' },
      { label: t('fixedFontZoom'), keys: t('fixedFontZoomKeys') },
      { label: t('fixedZoom'), keys: 'Ctrl + = / - / 0' },
      { label: t('fixedSelectAll'), keys: 'Ctrl + A' },
      { label: t('fixedReload'), keys: 'Ctrl + R' },
      { label: t('fixedFullscreen'), keys: 'F11' },
      { label: t('fixedMinimize'), keys: 'Ctrl + M' },
      { label: t('fixedCloseWindow'), keys: 'Ctrl + W' },
      { label: t('fixedQuit'), keys: 'Ctrl + Q' },
      { label: t('fixedEsc'), keys: 'Esc' },
      { label: t('fixedCheatSheet'), keys: '?' },
    ],
    panes: [
      { label: t('navFiles'), keys: 'Ctrl + 1' },
      { label: t('navClipboard'), keys: 'Ctrl + 2' },
      { label: t('navCrossDevice'), keys: 'Ctrl + 3' },
      { label: t('navPasswords'), keys: 'Ctrl + 4' },
      { label: t('navNotes'), keys: 'Ctrl + 5' },
      { label: t('navAi'), keys: 'Ctrl + 6' },
      { label: t('navNetwork'), keys: 'Ctrl + 7' },
      { label: t('navFileManager'), keys: 'Ctrl + 8' },
      { label: t('navPcClean'), keys: 'Ctrl + 9' },
    ],
  }
}
