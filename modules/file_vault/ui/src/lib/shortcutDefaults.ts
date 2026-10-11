import type { FileManagerShortcuts, GlobalShortcuts } from '@/shared/ipcTypes'

/**
 * 出厂键位，渲染层唯一一份。
 *
 * 同一组默认值跨三个运行时各存一份且不能互相 import：ui_settings.py::DEFAULT_FILE_MANAGER_SHORTCUTS、
 * electron/main.ts::DEFAULT_GLOBAL_SHORTCUTS、本文件；由 tests/shortcutDefaults.test.mjs 逐字段比对。
 */
export const DEFAULT_FILE_MANAGER_SHORTCUTS: FileManagerShortcuts = {
  copy: { key: 'c', ctrl: true, alt: false, shift: false },
  cut: { key: 'x', ctrl: true, alt: false, shift: false },
  paste: { key: 'v', ctrl: true, alt: false, shift: false },
  delete_recycle: { key: 'Delete', ctrl: false, alt: false, shift: false },
  delete_permanent: { key: 'Delete', ctrl: false, alt: false, shift: true },
}

export const DEFAULT_GLOBAL_SHORTCUTS: GlobalShortcuts = {
  toggleWindow: { key: 't', ctrl: true, alt: true, shift: false },
  clipboardCapture: { key: 'v', ctrl: true, alt: false, shift: true },
  quickNote: { key: 'n', ctrl: true, alt: false, shift: true },
}
