export interface FileClipboardStatus {
  hasFiles: boolean
  isCut: boolean
  count: number
}

interface PastePreflightResult {
  ok: boolean
  has_files?: boolean
  is_cut?: boolean
  count?: number
  conflicts?: unknown[]
}

export function normalizePastePreflight(result: PastePreflightResult): {
  clipboard: FileClipboardStatus
  empty: boolean
  conflicts: unknown[]
} {
  const hasFiles = result.ok && result.has_files === true
  return {
    clipboard: {
      hasFiles,
      isCut: hasFiles && result.is_cut === true,
      count: hasFiles ? Math.max(0, result.count ?? 0) : 0,
    },
    empty: !hasFiles,
    conflicts: result.conflicts ?? [],
  }
}

export function fileHookSettingChecked(status: { autostart: boolean }): boolean {
  return status.autostart
}
