import { Suspense, lazy } from 'react'
import { useTranslation } from 'react-i18next'
import { Activity, Boxes, HardDrive, Sparkles, Wrench } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import { cn } from '@/lib/utils'
import type { PcCleanPane } from '@/lib/pccleanPanes'

/**
 * 清理套件外壳：体检/空间/自启/软件/工具箱五个面板合成一个导航项 + 顶部标签页，
 * 避免五个平级导航项淹没侧边栏、切换时视线要横跨整个窗口。
 * 仍保留五个 pane 值：标签状态不存在本组件里而用 `AppShell` 的 `pane`，
 * 这样命令面板（Ctrl+K）、原生菜单和深链还能直接跳到某个标签页，而不是总落在第一个。
 */

const PcCleanHealthScreen = lazy(() =>
  import('@/components/pcclean/PcCleanHealthScreen').then((m) => ({ default: m.PcCleanHealthScreen })),
)
const PcCleanSpaceScreen = lazy(() =>
  import('@/components/pcclean/PcCleanSpaceScreen').then((m) => ({ default: m.PcCleanSpaceScreen })),
)
const PcCleanStartupScreen = lazy(() =>
  import('@/components/pcclean/PcCleanStartupScreen').then((m) => ({ default: m.PcCleanStartupScreen })),
)
const PcCleanSoftwareScreen = lazy(() =>
  import('@/components/pcclean/PcCleanSoftwareScreen').then((m) => ({ default: m.PcCleanSoftwareScreen })),
)
const PcCleanToolboxScreen = lazy(() =>
  import('@/components/pcclean/PcCleanToolboxScreen').then((m) => ({ default: m.PcCleanToolboxScreen })),
)

/**
 * 标签顺序按使用频率降序：体检第一（多数人只做这件事），工具箱最后，中间按"清理完下一步想干什么"排
 * ：空间 → 自启 → 软件。
 */
const TABS: readonly { pane: PcCleanPane; labelKey: string; icon: LucideIcon }[] = [
  { pane: 'pcclean', labelKey: 'nav.health', icon: Sparkles },
  { pane: 'pccleanspace', labelKey: 'nav.space', icon: HardDrive },
  { pane: 'pccleanstartup', labelKey: 'nav.startup', icon: Activity },
  { pane: 'pccleansoftware', labelKey: 'nav.software', icon: Boxes },
  { pane: 'pccleantoolbox', labelKey: 'nav.toolbox', icon: Wrench },
]

export function PcCleanSuiteScreen({
  pane,
  onPaneChange,
}: {
  pane: PcCleanPane
  onPaneChange: (pane: PcCleanPane) => void
}) {
  const { t } = useTranslation('pcclean')

  return (
    // 不加 `ds-page-wash`：每个标签页的 `PageShell` 已铺一层，再铺会叠出比别的模块深一档的底色。
    <div className="flex min-h-full w-full flex-col">
      {/*
        标签条固定在顶部（sticky）。清理面板的列表动辄几百行，滚到一半想换个
        视角时，如果标签条已经滚出屏幕，用户就得先滚回顶部——那一下往返
        正是"操作不简便"的具体形态。
      */}
      <div
        role="tablist"
        aria-label={t('nav.group')}
        className="sticky top-0 z-20 flex w-full flex-wrap items-center gap-1 border-b border-border/70 bg-background/92 px-10 py-2 backdrop-blur"
      >
        {TABS.map(({ pane: target, labelKey, icon: Icon }) => {
          const active = pane === target
          return (
            <button
              key={target}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => onPaneChange(target)}
              className={cn(
                'flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                active
                  ? 'bg-accent-soft text-primary'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              <Icon className="size-4" aria-hidden="true" />
              {t(labelKey)}
            </button>
          )
        })}
      </div>

      <div className="min-h-0 flex-1">
        {/* 一个 Suspense 就够：同一时刻只挂一个标签页。 */}
        <Suspense fallback={<div className="min-h-full w-full" aria-busy="true" />}>
          {pane === 'pcclean' && <PcCleanHealthScreen />}
          {pane === 'pccleanspace' && <PcCleanSpaceScreen />}
          {pane === 'pccleanstartup' && <PcCleanStartupScreen />}
          {pane === 'pccleansoftware' && <PcCleanSoftwareScreen />}
          {pane === 'pccleantoolbox' && <PcCleanToolboxScreen />}
        </Suspense>
      </div>
    </div>
  )
}
