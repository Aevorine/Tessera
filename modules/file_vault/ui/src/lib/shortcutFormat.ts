import type { ShortcutBinding } from '@/shared/ipcTypes'

// 快捷键可读格式，设置页与帮助页共用；放 lib/ 以免破坏 react-refresh「组件文件只导出组件」。
export function formatBinding(binding: ShortcutBinding): string {
  const parts: string[] = []
  if (binding.ctrl) parts.push('Ctrl')
  if (binding.alt) parts.push('Alt')
  if (binding.shift) parts.push('Shift')
  parts.push(binding.key === 'Delete' ? 'Delete' : binding.key.toUpperCase())
  return parts.join(' + ')
}
