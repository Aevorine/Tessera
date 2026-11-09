import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { restoreAllContent, restoreContent, useHiddenContent } from '@/lib/hiddenContent'
import { NAV_ORDER_RESET_EVENT, loadNavPreferences, saveNavPreferences } from '@/lib/navPrefs'

/** 页面 id → 侧边栏上的名字（与 AppShell 的 NAV_GROUPS 同一批翻译键）。 */
const PANE_LABEL_KEYS: Record<string, string> = {
  files: 'navFilesItem',
  clipboard: 'navClipboardItem',
  crossdevice: 'navCrossDeviceItem',
  passwords: 'navPasswords',
  recoverycodes: 'navRecoveryCodes',
  notes: 'navNotesItem',
  ai: 'navAiChatItem',
  network: 'navNetworkItem',
  filemanager: 'navFileManagerItem',
  security: 'navSecurity',
  settings: 'navSettings',
  diagnostics: 'navDiagnostics',
  help: 'navHelp',
}

/**
 * 设置 › 外观 ›「已关闭的内容」：列出关掉的侧边栏入口与页面分区，逐个或全部恢复；另有「侧边栏恢复
 * 默认顺序」。恢复是即时的：各处订阅同一个存储，不用重启。
 */
export function HiddenContentSettings() {
  const { t } = useTranslation('settings')
  const { t: tCommon } = useTranslation('common')
  const { t: tClean } = useTranslation('pcclean')
  const paneLabel = (pane: string) =>
    pane.startsWith('pcclean') ? tClean('nav.group') : PANE_LABEL_KEYS[pane] ? tCommon(PANE_LABEL_KEYS[pane]) : pane
  const hidden = useHiddenContent()
  const entries = useMemo(
    () =>
      Object.entries(hidden)
        .map(([key, e]) => ({ key, ...e, isNav: key.startsWith('nav:') }))
        // 侧边栏入口排前面，其余按关闭时间新到旧——最近关的最可能想找回来。
        .sort((a, b) => Number(b.isNav) - Number(a.isNav) || b.at - a.at),
    [hidden],
  )

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">{t('hiddenContentTitle')}</p>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              saveNavPreferences({ ...loadNavPreferences(), order: [] })
              window.dispatchEvent(new Event(NAV_ORDER_RESET_EVENT))
            }}
          >
            {t('navResetOrder')}
          </Button>
          {entries.length > 0 && (
            <Button type="button" size="sm" variant="outline" onClick={restoreAllContent}>
              <RotateCcw className="size-4" aria-hidden="true" />
              {t('hiddenContentRestoreAll', { count: entries.length })}
            </Button>
          )}
        </div>
      </div>
      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('hiddenContentEmpty')}</p>
      ) : (
        <ul className="divide-y divide-border/70 rounded-lg border border-border/70">
          {entries.map((e) => (
            <li key={e.key} className="flex items-center justify-between gap-3 px-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm">{e.label}</p>
                <p className="truncate text-sm text-muted-foreground">
                  {e.isNav ? t('hiddenContentKindNav') : t('hiddenContentKindSection', { pane: paneLabel(e.pane) })}
                </p>
              </div>
              <Button type="button" size="sm" variant="ghost" onClick={() => restoreContent([e.key])}>
                {t('hiddenContentRestore')}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
