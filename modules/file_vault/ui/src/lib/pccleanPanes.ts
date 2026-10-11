/**
 * 清理套件占用的 pane 值，单独成文件：`PcCleanSuiteScreen.tsx` 只导出组件，混入常量会使 Vite 快速刷新失效
 * （eslint `react-refresh/only-export-components` 拦截）。
 * 五个值保留：侧边栏只显示一项，但命令面板（Ctrl+K）和原生菜单需要深链到具体标签页。
 */
export const PCCLEAN_PANES = [
  'pcclean',
  'pccleanspace',
  'pccleanstartup',
  'pccleansoftware',
  'pccleantoolbox',
] as const

export type PcCleanPane = (typeof PCCLEAN_PANES)[number]

export function isPcCleanPane(pane: string): pane is PcCleanPane {
  return (PCCLEAN_PANES as readonly string[]).includes(pane)
}
