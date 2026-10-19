import { useDeferredValue, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Bot,
  ClipboardList,
  EyeOff,
  FolderOpen,
  Gauge,
  KeyRound,
  KeySquare,
  Keyboard,
  LayoutGrid,
  Lock,
  MonitorSmartphone,
  NotebookText,
  Settings,
  ShieldCheck,
  Smartphone,
  Sparkles,
  type LucideIcon,
} from 'lucide-react'
import { PageHeader } from '@/components/ui/page'
import { TopBarSearch } from '@/components/TopBar'
import { FeatureGrid, type FeatureTileSpec } from '@/components/feature/FeatureGrid'
import { FeaturePanel } from '@/components/feature/FeaturePanel'
import { useFeaturePanel } from '@/components/feature/useFeaturePanel'
import { useShortcutRows } from '@/lib/useShortcutRows'
import { cn } from '@/lib/utils'

// 操作指南：每章一个功能格，点开全屏阅读；顶部搜索按正文筛章节。快捷键实时读当前设置。

interface Chapter {
  id: string
  icon: LucideIcon
  title: string
  items: string[]
}

const SHORTCUTS_ID = 'shortcuts'

export function HelpScreen() {
  const { t } = useTranslation('help')
  // 三组快捷键全来自 useShortcutRows()，与按 ? 弹出的速查卡同源。
  const { customizable: customizableRows, fixed: fixedRows, panes: paneRows } = useShortcutRows()
  const { rootRef, panel, origin, open, close } = useFeaturePanel<string>()
  const [query, setQuery] = useState('')
  const q = useDeferredValue(query.trim().toLowerCase())

  const chapters: Chapter[] = useMemo(
    () => [
      { id: 'menus', icon: LayoutGrid, title: t('sectionMenus'), items: [t('menu1'), t('menu2'), t('menu3'), t('menu4'), t('menu5')] },
      { id: 'files', icon: Lock, title: t('sectionFiles'), items: [t('files1'), t('files2'), t('files3'), t('files4'), t('files5')] },
      { id: 'filemanager', icon: FolderOpen, title: t('sectionFileManager'), items: [t('fm1'), t('fm2'), t('fm3'), t('fm4')] },
      {
        id: 'clipboard',
        icon: ClipboardList,
        title: t('sectionClipboard'),
        items: [t('clip1'), t('clip2'), t('clip3'), t('clip4'), t('clip5'), t('clip6'), t('clip7')],
      },
      {
        id: 'crossdevice',
        icon: MonitorSmartphone,
        title: t('sectionCrossDevice'),
        items: [t('cd1'), t('cd2'), t('cd3'), t('cd4'), t('cd5'), t('cd6'), t('cd7'), t('cd8')],
      },
      {
        id: 'android',
        icon: Smartphone,
        title: t('sectionAndroid'),
        items: [t('and1'), t('and2'), t('and3'), t('and4'), t('and5'), t('and6'), t('and7'), t('and8')],
      },
      {
        id: 'notes',
        icon: NotebookText,
        title: t('sectionNotes'),
        items: [t('notes1'), t('notes2'), t('notes3'), t('notes4'), t('notes5'), t('notes6')],
      },
      { id: 'passwords', icon: KeyRound, title: t('sectionPasswords'), items: [t('pw1'), t('pw2'), t('pw3'), t('pw4')] },
      { id: 'recoverycodes', icon: KeySquare, title: t('sectionRecoveryCodes'), items: [t('rc1'), t('rc2'), t('rc3'), t('rc4')] },
      {
        id: 'pcclean',
        icon: Sparkles,
        title: t('sectionPcClean'),
        items: [t('clean1'), t('clean2'), t('clean3'), t('clean4'), t('clean5'), t('clean6'), t('clean7')],
      },
      { id: 'ai', icon: Bot, title: t('sectionAi'), items: [t('ai1'), t('ai2'), t('ai3')] },
      { id: 'network', icon: Gauge, title: t('sectionNetwork'), items: [t('net1'), t('net2'), t('net3')] },
      {
        id: 'security',
        icon: ShieldCheck,
        title: t('sectionSecurityCheck'),
        items: [t('sec1'), t('sec2'), t('sec3'), t('sec4'), t('sec5'), t('sec6'), t('sec7'), t('sec8')],
      },
      {
        id: 'settings',
        icon: Settings,
        title: t('sectionSettings'),
        items: [t('set1'), t('set2'), t('set3'), t('set4'), t('set5'), t('set6')],
      },
      // 哪些数据会离开这台电脑必须写明，原文从 AI 对话页撤下后落在这里。
      { id: 'privacy', icon: EyeOff, title: t('sectionPrivacy'), items: [t('privacy1'), t('privacy2'), t('privacy3')] },
    ],
    [t],
  )

  const shortcutGroups = useMemo(
    () => [
      { title: t('shortcutsCustomizable'), rows: customizableRows },
      { title: t('shortcutsPanes'), rows: paneRows },
      { title: t('shortcutsFixed'), rows: fixedRows },
    ],
    [t, customizableRows, paneRows, fixedRows],
  )
  const shortcutCount = customizableRows.length + paneRows.length + fixedRows.length

  const matches = useMemo(() => {
    const hits = new Map<string, number>()
    if (!q) return hits
    for (const c of chapters) {
      const n = c.items.filter((item) => item.toLowerCase().includes(q)).length
      if (n > 0 || c.title.toLowerCase().includes(q)) hits.set(c.id, n)
    }
    const shortcutHits = shortcutGroups.flatMap((g) => g.rows).filter(
      (r) => r.label.toLowerCase().includes(q) || r.keys.toLowerCase().includes(q),
    ).length
    if (shortcutHits > 0 || t('sectionShortcuts').toLowerCase().includes(q)) hits.set(SHORTCUTS_ID, shortcutHits)
    return hits
  }, [q, chapters, shortcutGroups, t])

  const tiles: FeatureTileSpec[] = [
    {
      id: SHORTCUTS_ID,
      icon: Keyboard,
      title: t('sectionShortcuts'),
      badge: q ? t('tileMatches', { count: matches.get(SHORTCUTS_ID) ?? 0 }) : t('tileShortcuts', { count: shortcutCount }),
    },
    ...chapters.map((c) => ({
      id: c.id,
      icon: c.icon,
      title: c.title,
      badge: q ? t('tileMatches', { count: matches.get(c.id) ?? 0 }) : t('tilePoints', { count: c.items.length }),
    })),
  ].filter((tile) => !q || matches.has(tile.id))

  const current = panel ? chapters.find((c) => c.id === panel) : undefined
  const panelTitle = panel === SHORTCUTS_ID ? t('sectionShortcuts') : (current?.title ?? '')

  return (
    <div ref={rootRef} className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      <div
        className="ds-page-wash flex min-h-0 flex-1 flex-col gap-4 px-6 pt-5 pb-6"
        aria-hidden={panel ? true : undefined}
      >
        <PageHeader title={t('pageTitle')} />
        <div className="flex shrink-0 justify-end">
          <TopBarSearch value={query} onChange={setQuery} placeholder={t('searchPlaceholder')} className="w-72" />
        </div>
        {tiles.length > 0 ? (
          <FeatureGrid tiles={tiles} onOpen={(id, el) => open(id, el)} className="min-h-0 flex-1" />
        ) : (
          <p className="flex flex-1 items-center justify-center text-muted-foreground">{t('noMatches')}</p>
        )}
      </div>

      {panel && (
        <FeaturePanel key={panel} label={panelTitle} origin={origin} backLabel={t('panelBack')} onClose={close}>
          {panel === SHORTCUTS_ID ? (
            <div className="grid gap-x-10 gap-y-6 lg:grid-cols-3 lg:items-start">
              {shortcutGroups.map((group) => (
                <section key={group.title} className="space-y-2">
                  <h2 className="font-heading font-medium text-muted-foreground">{group.title}</h2>
                  <div className="divide-y divide-border/70">
                    {group.rows.map((row) => {
                      const hit = q && (row.label.toLowerCase().includes(q) || row.keys.toLowerCase().includes(q))
                      return (
                        <div
                          key={row.label}
                          className={cn('flex items-center justify-between gap-4 rounded px-2 py-2', hit && 'bg-accent-soft')}
                        >
                          <span>{row.label}</span>
                          <kbd className="shrink-0 rounded border bg-muted px-2 py-0.5 font-mono text-sm text-muted-foreground">
                            {row.keys}
                          </kbd>
                        </div>
                      )
                    })}
                  </div>
                </section>
              ))}
            </div>
          ) : current ? (
            <ol className="grid gap-3 lg:grid-cols-2">
              {current.items.map((item, index) => {
                const hit = q && item.toLowerCase().includes(q)
                return (
                  <li
                    key={item}
                    className={cn(
                      'flex gap-3 rounded-xl border border-border/70 bg-card p-4 leading-relaxed',
                      hit && 'border-[var(--accent-line)] bg-accent-soft',
                    )}
                  >
                    <span className="ds-icon-chip size-8 shrink-0 rounded-lg font-medium tabular">{index + 1}</span>
                    <span className="min-w-0 flex-1">{item}</span>
                  </li>
                )
              })}
            </ol>
          ) : null}
        </FeaturePanel>
      )}
    </div>
  )
}
