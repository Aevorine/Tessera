import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ArrowUp,
  ClipboardPaste,
  Compass,
  File,
  Folder,
  FolderCog,
  FolderPlus,
  History,
  PencilLine,
  RefreshCw,
  RotateCcw,
  Trash2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { IconToolbar } from '@/components/IconToolbar'
import { Badge, PageHeader } from '@/components/ui/page'
import { LABEL_REGIONS } from '@/lib/labelMode'
import { Progress } from '@/components/ui/progress'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu'
import { cn } from '@/lib/utils'
import { vaultApi } from '@/lib/vaultApi'
import { electronApi } from '@/lib/electronApi'
import { normalizePastePreflight } from '@/lib/fileOpsUiState'
import { createNameCollator, sortDirEntriesChunked, truncateDirEntries, DIR_ENTRY_HARD_LIMIT } from '@/lib/dirEntrySort'
import { translateError } from '@/i18n/errors'
import type { FileClipConflictItem, FileClipHistoryEntry, FileClipProgress, FileManagerShortcutAction, FileManagerShortcuts } from '@/shared/ipcTypes'

interface DirEntry {
  name: string
  isDirectory: boolean
  size: number
  mtimeMs: number
}

interface OperationProgress {
  label: string           // "Pasting..." / "Deleting..."
  done: number
  total: number
  bytesDone: number
  bytesTotal: number
  startTime: number       // performance.now() at start
  elapsed: number         // seconds, updated by timer
  eta: number | null      // seconds remaining, or null
}

function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  const element = target instanceof HTMLElement ? target : null
  return Boolean(
    element?.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]'),
  )
}

function shortcutMatches(event: React.KeyboardEvent, binding: FileManagerShortcuts[FileManagerShortcutAction]): boolean {
  return event.key.toLowerCase() === binding.key.toLowerCase()
    && event.ctrlKey === binding.ctrl
    && event.altKey === binding.alt
    && event.shiftKey === binding.shift
    && !event.metaKey
}

const DEFAULT_FILE_MANAGER_SHORTCUTS: FileManagerShortcuts = {
  copy: { key: 'c', ctrl: true, alt: false, shift: false },
  cut: { key: 'x', ctrl: true, alt: false, shift: false },
  paste: { key: 'v', ctrl: true, alt: false, shift: false },
  delete_recycle: { key: 'Delete', ctrl: false, alt: false, shift: false },
  delete_permanent: { key: 'Delete', ctrl: false, alt: false, shift: true },
}

function formatSize(bytes: number, isDirectory: boolean): string {
  if (isDirectory) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function formatSizeCompact(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  return `${m}m ${s}s`
}

function formatDate(mtimeMs: number): string {
  if (!mtimeMs) return ''
  return new Date(mtimeMs).toLocaleString()
}

function parentPath(p: string): string | null {
  const trimmed = p.replace(/[\\/]+$/, '')
  const idx = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'))
  if (idx < 0) return null
  const parent = trimmed.slice(0, idx)
  if (/^[A-Za-z]:$/.test(parent)) return `${parent}\\`
  return parent || null
}

function joinPath(dir: string, name: string): string {
  return dir.endsWith('\\') || dir.endsWith('/') ? `${dir}${name}` : `${dir}\\${name}`
}

function splitExt(name: string, isDirectory: boolean): [string, string] {
  if (isDirectory) return [name, '']
  const idx = name.lastIndexOf('.')
  if (idx <= 0) return [name, '']
  return [name.slice(0, idx), name.slice(idx)]
}

function conflictFreeName(baseName: string, taken: Set<string>): string {
  if (!taken.has(baseName)) return baseName
  const [base, ext] = splitExt(baseName, false)
  let n = 2
  let candidate = `${base} (${n})${ext}`
  while (taken.has(candidate)) {
    n++
    candidate = `${base} (${n})${ext}`
  }
  return candidate
}

const GRID_COLUMNS = 'grid-cols-[1fr_110px_180px]'

// 行高 44px（py-2.5），与输入框 h-11 的整体密度对齐；34px 时 16px 正文几百行连片易串行。
const ROW_HEIGHT = 44

/**
 * 列表行，抽出并 `memo`：选中会换掉 `selected` Set 的引用，内联写法会重建所有可见行。传
 * `isSelected` 布尔值而非 Set，回调必须是稳定引用（父组件用 `liveHandlersRef` + 一次性`useMemo`），
 * 否则浅比较全部失败。
 */
const FileRow = memo(function FileRow({
  entry,
  index,
  isSelected,
  isActive,
  dimmed,
  offset,
  measureRef,
  onRowClick,
  onRowDoubleClick,
  onEncryptToVault,
  onSecureErase,
  onDecryptHere,
}: {
  entry: DirEntry
  index: number
  isSelected: boolean
  isActive: boolean
  dimmed: boolean
  offset: number
  measureRef: (node: Element | null) => void
  onRowClick: (entry: DirEntry, index: number, event: React.MouseEvent) => void
  onRowDoubleClick: (entry: DirEntry) => void
  onEncryptToVault: (entry: DirEntry) => void
  onSecureErase: (entry: DirEntry) => void
  onDecryptHere: (entry: DirEntry) => void
}) {
  const { t } = useTranslation('filemanager')
  const row = (
    <div
      onClick={(e) => onRowClick(entry, index, e)}
      onDoubleClick={() => onRowDoubleClick(entry)}
      className={cn(
        'grid cursor-default select-none items-center gap-2 border-t px-3 py-2.5 text-sm',
        GRID_COLUMNS,
        isSelected ? 'bg-accent' : 'hover:bg-muted/40',
        isActive && 'ring-1 ring-inset ring-ring',
        dimmed && 'opacity-50',
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        {entry.isDirectory ? (
          <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <File className="h-4 w-4 shrink-0 text-muted-foreground" />
        )}
        <span className="truncate">{entry.name}</span>
      </span>
      <span className="text-muted-foreground">{formatSize(entry.size, entry.isDirectory)}</span>
      <span className="text-muted-foreground">{formatDate(entry.mtimeMs)}</span>
    </div>
  )
  const isIvault = !entry.isDirectory && /\.ivault$/i.test(entry.name)
  const content = entry.isDirectory ? (
    row
  ) : (
    <ContextMenu>
      <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
      <ContextMenuContent>
        {isIvault ? (
          <ContextMenuItem onSelect={() => onDecryptHere(entry)}>
            {t('decryptHereMenuItem')}
          </ContextMenuItem>
        ) : (
          <>
            <ContextMenuItem onSelect={() => onEncryptToVault(entry)}>
              {t('encryptToVaultMenuItem')}
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => onSecureErase(entry)}>
              {t('secureEraseMenuItem')}
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  )
  return (
    <div
      id={`fm-row-${index}`}
      role="option"
      aria-selected={isSelected}
      ref={measureRef}
      data-index={index}
      style={{ position: 'absolute', top: 0, insetInlineStart: 0, width: '100%', transform: `translateY(${offset}px)` }}
    >
      {content}
    </div>
  )
})

export function FileManagerScreen({ isProfessional = false }: { isProfessional?: boolean } = {}) {
  const { t, i18n } = useTranslation('filemanager')
  const containerRef = useRef<HTMLDivElement>(null)
  const [drives, setDrives] = useState<string[]>([])
  const [currentPath, setCurrentPath] = useState('')
  const [entries, setEntries] = useState<DirEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [lastSelectedIndex, setLastSelectedIndex] = useState<number | null>(null)
  // 键盘焦点行（跟"选中"是两回事：焦点只有一个，选中可以有很多个）。
  const [activeIndex, setActiveIndex] = useState<number | null>(null)
  // 这个目录里有多少条**没有显示出来**。>0 时界面上必须有一句明确的提示——
  // 静默丢数据是这里绝对不允许的。
  const [truncatedCount, setTruncatedCount] = useState(0)
  // 分批排序的进度（0~100），null = 没在排。只有超大目录才会出现。
  const [sortProgress, setSortProgress] = useState<number | null>(null)
  const [shortcuts, setShortcuts] = useState<FileManagerShortcuts>(DEFAULT_FILE_MANAGER_SHORTCUTS)
  const [clipboardStatus, setClipboardStatus] = useState<{ hasFiles: boolean; isCut: boolean; count: number }>({
    hasFiles: false, isCut: false, count: 0,
  })

  // ---- Operation progress dialog (Shows file names, total size, ETA, elapsed) ----
  const [operationProgress, setOperationProgress] = useState<OperationProgress | null>(null)
  const [operationFiles, setOperationFiles] = useState<string[]>([]) // file names being processed
  const progressIntervalRef = useRef<number | null>(null)

  // ---- Delete confirmation dialog ----
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  const [deleteConfirmInfo, setDeleteConfirmInfo] = useState<{ count: number; totalBytes: number; fileNames: string[] }>({
    count: 0, totalBytes: 0, fileNames: [],
  })

  // ---- Conflict dialog (E8) ----
  const [conflictDialogOpen, setConflictDialogOpen] = useState(false)
  const [conflictItems, setConflictItems] = useState<FileClipConflictItem[]>([])
  const [conflictResolveMode, setConflictResolveMode] = useState<'rename' | 'skip' | 'overwrite'>('rename')

  // ---- History panel (E7 - Ctrl+Shift+H) ----
  const [historyDialogOpen, setHistoryDialogOpen] = useState(false)
  const [historyEntries, setHistoryEntries] = useState<FileClipHistoryEntry[]>([])

  const [newFolderDialogOpen, setNewFolderDialogOpen] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')

  // ---- Batch rename ----
  const [renameDialogOpen, setRenameDialogOpen] = useState(false)
  const [renameMode, setRenameMode] = useState<'sequence' | 'findReplace'>('sequence')
  const [renamePrefix, setRenamePrefix] = useState('')
  const [renameStart, setRenameStart] = useState(1)
  const [renamePadding, setRenamePadding] = useState(2)
  const [renameFind, setRenameFind] = useState('')
  const [renameReplace, setRenameReplace] = useState('')
  const [renaming, setRenaming] = useState(false)

  // ---- Hook engine status ----
  const [hookStatus, setHookStatus] = useState<{ compiled: boolean; running: boolean; autostart: boolean; lastError: string | null }>({ compiled: false, running: false, autostart: false, lastError: null })
  const [hookWorking, setHookWorking] = useState(false)

  // ---- Undo info (E6) ----
  const [undoInfo, setUndoInfo] = useState<{ hasUndo: boolean; description?: string }>({ hasUndo: false })

  // ---- Derived helpers ----
  const transferring = operationProgress !== null
  const selectedPathsOnly = useCallback((): string[] => {
    return Array.from(selected).map((name) => joinPath(currentPath, name))
  }, [selected, currentPath])

  // Poll ETA every 1s while transferring
  useEffect(() => {
    if (!operationProgress) {
      if (progressIntervalRef.current) {
        clearInterval(progressIntervalRef.current)
        progressIntervalRef.current = null
      }
      return
    }
    progressIntervalRef.current = window.setInterval(() => {
      setOperationProgress((prev) => {
        if (!prev || prev.total === 0) return prev
        const elapsed = (performance.now() - prev.startTime) / 1000
        const currentDone = prev.bytesDone || prev.done
        const speed = currentDone / elapsed
        const remaining = prev.bytesTotal - currentDone
        const eta = speed > 0 ? remaining / speed : null
        return { ...prev, elapsed, eta }
      })
    }, 1000)
    return () => {
      if (progressIntervalRef.current) clearInterval(progressIntervalRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only start/stop the interval on the true/false transition, not on every progress tick (setOperationProgress above uses the updater form, so it never reads operationProgress from this closure)
  }, [transferring])

  const refreshHookStatus = useCallback(async () => {
    const res = await vaultApi.call('file_clip_hook_status', {})
    if (res.ok && 'running' in res) {
      setHookStatus({ compiled: res.compiled, running: res.running, autostart: res.autostart, lastError: res.last_error })
    }
  }, [])

  const toggleHook = useCallback(async () => {
    setHookWorking(true)
    const next = !hookStatus.running
    try {
      const res = await vaultApi.call('file_clip_hook_set_enabled', { enabled: next })
      if (res.ok && 'running' in res) {
        setHookStatus({ compiled: res.compiled, running: res.running, autostart: res.autostart, lastError: res.last_error })
        toast.success(next ? t('hookEnabledToast') : t('hookDisabledToast'))
      } else {
        toast.error(t('hookToggleFailedToast'), { description: 'error' in res ? res.error : undefined })
      }
    } catch (err) {
      toast.error(t('hookToggleFailedToast'), { description: err instanceof Error ? err.message : String(err) })
    }
    finally { setHookWorking(false) }
  }, [hookStatus.running, t])

  const refreshClipboardStatus = useCallback(async () => {
    const res = await vaultApi.call('file_clip_clipboard_status', {})
    if (res.ok) setClipboardStatus({ hasFiles: res.has_files, isCut: res.is_cut, count: res.paths.length })
  }, [])

  const refreshUndoInfo = useCallback(async () => {
    const res = await vaultApi.call('file_clip_undo_info', {})
    if (res.ok) setUndoInfo({ hasUndo: res.has_undo, description: 'description' in res ? res.description : undefined })
  }, [])

  // 排序器复用同一实例，语言变了才重建。别退回 `a.name.localeCompare`：每次比较都重建排序器，十万条目
  // 录要比一百七十万次，会把主线程钉死数秒，见 lib/dirEntrySort.ts。
  const collator = useMemo(() => createNameCollator(i18n.language), [i18n.language])
  // 每次加载 +1。异步排序跑到一半时用户已经切走了的话，凭它丢掉过期结果——
  // 不然后到的旧目录会把新目录的内容盖回去。
  const loadGenerationRef = useRef(0)

  const loadDirectory = useCallback(async (path: string) => {
    const generation = (loadGenerationRef.current += 1)
    const isStale = () => loadGenerationRef.current !== generation
    setLoading(true)
    setLoadError(null)
    setSortProgress(null)
    const res = await electronApi.listDirectory(path)
    if (isStale()) return
    if (!res.ok) {
      setLoadError(res.error)
      setLoading(false)
      return
    }
    const sorted = await sortDirEntriesChunked(res.entries, collator, {
      isCancelled: isStale,
      onProgress: (ratio) => setSortProgress(Math.round(ratio * 100)),
    })
    if (sorted === null || isStale()) return
    const { entries: visible, dropped } = truncateDirEntries(sorted)
    setEntries(visible)
    setTruncatedCount(dropped)
    setCurrentPath(path)
    setSelected(new Set())
    setLastSelectedIndex(null)
    setActiveIndex(null)
    setSortProgress(null)
    setLoading(false)
  }, [collator])

  useEffect(() => {
    electronApi.setFileManagerActive(true)
    electronApi.listDrives().then((d) => {
      setDrives(d)
      const start = d.includes('C:\\') ? 'C:\\' : d[0]
      if (start) void loadDirectory(start)
      else setLoading(false)
    })
    void refreshClipboardStatus()
    void refreshHookStatus()
    void refreshUndoInfo()
    void vaultApi.call('file_manager_shortcuts_get', {}).then((res) => {
      if (res.ok) setShortcuts(res.shortcuts)
    })
    const onShortcutsChanged = () => {
      void vaultApi.call('file_manager_shortcuts_get', {}).then((res) => {
        if (res.ok) setShortcuts(res.shortcuts)
      })
    }
    const onWindowFocus = () => void refreshClipboardStatus()
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void refreshClipboardStatus()
    }
    window.addEventListener('file-manager-shortcuts-changed', onShortcutsChanged)
    window.addEventListener('focus', onWindowFocus)
    document.addEventListener('visibilitychange', onVisibilityChange)
    const unsubHookToggle = electronApi.onFileHookToggle(async (enabled) => {
      const res = await vaultApi.call('file_clip_hook_set_enabled', { enabled })
      if (res.ok && 'running' in res) {
        setHookStatus({ compiled: res.compiled, running: res.running, autostart: res.autostart, lastError: res.last_error })
      }
    })
    return () => {
      electronApi.setFileManagerActive(false)
      window.removeEventListener('file-manager-shortcuts-changed', onShortcutsChanged)
      window.removeEventListener('focus', onWindowFocus)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      unsubHookToggle()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    return vaultApi.onProgress((payload) => {
      if (payload.method === 'file_clip_paste' || payload.method === 'file_clip_delete' || payload.method === 'file_clip_secure_erase') {
        const data = payload as unknown as FileClipProgress
        setOperationProgress((prev) => {
          if (!prev) return prev
          const newDone = data.done
          const newTotal = data.total
          // For delete/secure_erase, bytes aren't tracked - use file counts directly
          const bytesDone = prev.bytesTotal > 0 ? (prev.bytesTotal * newDone / newTotal) : newDone
          return { ...prev, done: newDone, total: newTotal, bytesDone }
        })
      }
    })
  }, [])

  function handleRowClick(name: string, index: number, event: React.MouseEvent) {
    containerRef.current?.focus()
    if (event.shiftKey && lastSelectedIndex !== null) {
      const from = Math.min(lastSelectedIndex, index)
      const to = Math.max(lastSelectedIndex, index)
      setSelected((prev) => {
        const next = new Set(prev)
        for (let i = from; i <= to; i++) next.add(entries[i].name)
        return next
      })
      return
    }
    if (event.ctrlKey || event.metaKey) {
      setSelected((prev) => {
        const next = new Set(prev)
        if (next.has(name)) next.delete(name)
        else next.add(name)
        return next
      })
    } else {
      setSelected(new Set([name]))
    }
    setLastSelectedIndex(index)
  }

  function handleRowDoubleClick(entry: DirEntry) {
    const full = joinPath(currentPath, entry.name)
    if (entry.isDirectory) {
      void loadDirectory(full)
    } else {
      void electronApi.openPath(full).then((res) => {
        if (!res.ok) toast.error(t('openFailedToast'))
      })
    }
  }

  async function doCopy() {
    const paths = selectedPathsOnly()
    if (paths.length === 0) return
    const res = await vaultApi.call('file_clip_copy', { paths })
    if (res.ok) {
      toast.success(t('copySuccessToast', { count: res.count }))
      void refreshClipboardStatus()
    } else {
      toast.error(translateError(res.error, res.error_params))
    }
  }

  async function doCut() {
    const paths = selectedPathsOnly()
    if (paths.length === 0) return
    const res = await vaultApi.call('file_clip_cut', { paths })
    if (res.ok) {
      toast.success(t('cutSuccessToast', { count: res.count }))
      void refreshClipboardStatus()
    } else {
      toast.error(translateError(res.error, res.error_params))
    }
  }

  async function doPaste() {
    if (transferring) return
    // Always query the live Windows clipboard. The cached state may be stale when
    // files were copied in Explorer while this window was in the background.
    const checkRes = await vaultApi.call('file_clip_check_conflicts', { dest_dir: currentPath, mode: 'existing' })
    if (!checkRes.ok) {
      toast.error(translateError(checkRes.error, checkRes.error_params))
      return
    }
    const preflight = normalizePastePreflight(checkRes)
    setClipboardStatus(preflight.clipboard)
    if (preflight.empty) {
      toast.error(translateError('file_clip.clipboard_empty'))
      return
    }
    if (checkRes.conflicts.length > 0) {
      setConflictItems(checkRes.conflicts)
      setConflictResolveMode('rename')
      setConflictDialogOpen(true)
      return
    }
    await executePaste('rename')
  }

  async function executePaste(onConflict: 'rename' | 'skip' | 'overwrite') {
    if (transferring) return
    setOperationProgress({ label: t('pasteProgressLabel'), done: 0, total: 1, bytesDone: 0, bytesTotal: 0, startTime: performance.now(), elapsed: 0, eta: null })
    setOperationFiles(clipboardStatus.isCut ? [] : [])
    try {
      const res = await vaultApi.call('file_clip_paste', { dest_dir: currentPath, on_conflict: onConflict })
      if ('files_total' in res) {
        if (res.ok) toast.success(t('pasteSuccessToast', { count: res.files_done }))
        else if (res.errors.length > 0) toast.error(t('partialErrorsToast', { count: res.errors.length }))
        else toast.error(t('pasteFailedToast'))
      } else {
        toast.error(translateError(res.error, res.error_params))
      }
      await loadDirectory(currentPath)
      await refreshClipboardStatus()
      await refreshUndoInfo()
    } finally {
      setOperationProgress(null)
      setOperationFiles([])
    }
  }

  async function runDelete(paths: string[], recycle: boolean) {
    if (paths.length === 0 || transferring) return
    const opLabel = recycle ? t('deleteProgressLabel') : t('permanentDeleteProgressLabel')
    setOperationProgress({ label: opLabel, done: 0, total: paths.length, bytesDone: 0, bytesTotal: 0, startTime: performance.now(), elapsed: 0, eta: null })
    setOperationFiles(paths.map((p) => p.split('\\').pop() || p.split('/').pop() || p))
    try {
      const res = await vaultApi.call('file_clip_delete', { paths, recycle })
      if ('files_total' in res) {
        if (res.ok) toast.success(recycle ? t('deleteRecycleSuccessToast') : t('deletePermanentSuccessToast'))
        else toast.error(t('partialErrorsToast', { count: res.errors.length }))
      } else {
        toast.error(translateError(res.error, res.error_params))
      }
      await loadDirectory(currentPath)
      await refreshUndoInfo()
    } finally {
      setOperationProgress(null)
      setOperationFiles([])
    }
  }

  function doDeleteRecycle() {
    void runDelete(selectedPathsOnly(), true)
  }

  function requestDeletePermanent() {
    if (selected.size === 0) return
    const fileNames: string[] = []
    let totalBytes = 0
    entries.forEach((e) => {
      if (selected.has(e.name)) {
        fileNames.push(e.name)
        if (!e.isDirectory) totalBytes += e.size
      }
    })
    setDeleteConfirmInfo({ count: selected.size, totalBytes, fileNames })
    setDeleteConfirmOpen(true)
  }

  function confirmDeletePermanent() {
    const paths = selectedPathsOnly()
    setDeleteConfirmOpen(false)
    void runDelete(paths, false)
  }

  async function handleSecureErase(entry: DirEntry) {
    const targets = selected.has(entry.name)
      ? entries.filter((e) => selected.has(e.name))
      : [entry]
    if (targets.length === 0 || transferring) return
    const paths = targets.map((e) => joinPath(currentPath, e.name))
    setOperationProgress({ label: t('secureEraseProgressLabel'), done: 0, total: paths.length, bytesDone: 0, bytesTotal: 0, startTime: performance.now(), elapsed: 0, eta: null })
    setOperationFiles(paths.map((p) => p.split('\\').pop() || p.split('/').pop() || p))
    try {
      const res = await vaultApi.call('file_clip_secure_erase', { paths })
      if ('items_total' in res) {
        if (res.ok) toast.success(t('secureEraseSuccessToast', { count: res.items_done }))
        else toast.error(t('partialErrorsToast', { count: res.errors.length }))
      } else {
        toast.error(translateError(res.error, res.error_params))
      }
      await loadDirectory(currentPath)
      await refreshUndoInfo()
    } finally {
      setOperationProgress(null)
      setOperationFiles([])
    }
  }

  async function doUndo() {
    if (transferring) return
    const res = await vaultApi.call('file_clip_undo', {})
    if (res.ok) {
      toast.success(res.description || t('undoSuccessToast'))
      await loadDirectory(currentPath)
      await refreshClipboardStatus()
      await refreshUndoInfo()
    } else {
      toast.error(res.description || t('undoNothingToast'))
    }
  }

  async function openHistoryPanel() {
    const res = await vaultApi.call('file_clip_history', { limit: 50 })
    if (res.ok) {
      setHistoryEntries(res.entries)
      setHistoryDialogOpen(true)
    } else {
      toast.error(t('historyFailedToast'))
    }
  }

  async function clearHistory() {
    await vaultApi.call('file_clip_history_clear', {})
    setHistoryEntries([])
    toast.success(t('historyClearedToast'))
  }

  async function handleEncryptToVault(entry: DirEntry) {
    const targets = selected.has(entry.name)
      ? entries.filter((e) => selected.has(e.name) && !e.isDirectory)
      : [entry]
    if (targets.length === 0 || transferring) return
    setOperationProgress({ label: t('encryptProgressLabel'), done: 0, total: targets.length, bytesDone: 0, bytesTotal: 0, startTime: performance.now(), elapsed: 0, eta: null })
    setOperationFiles(targets.map((e) => e.name))
    try {
      const taken = new Set(entries.map((e) => e.name))
      let successCount = 0
      let failedCount = 0
      for (const target of targets) {
        const inputPath = joinPath(currentPath, target.name)
        const outName = conflictFreeName(`${target.name}.ivault`, taken)
        taken.add(outName)
        const res = await vaultApi.call('encrypt_file', { input_path: inputPath, output_path: joinPath(currentPath, outName) })
        if (res.ok) successCount++
        else failedCount++
        setOperationProgress((prev) => prev ? { ...prev, done: (prev.done || 0) + 1 } : prev)
      }
      if (failedCount === 0) toast.success(t('encryptToVaultSuccessToast', { count: successCount }))
      else toast.error(t('encryptToVaultPartialToast', { success: successCount, failed: failedCount }))
      await loadDirectory(currentPath)
    } finally {
      setOperationProgress(null)
      setOperationFiles([])
    }
  }

  async function handleDecryptHere(entry: DirEntry) {
    const targets = selected.has(entry.name)
      ? entries.filter((e) => selected.has(e.name) && !e.isDirectory && /\.ivault$/i.test(e.name))
      : [entry]
    if (targets.length === 0 || transferring) return
    setOperationProgress({ label: t('decryptProgressLabel'), done: 0, total: targets.length, bytesDone: 0, bytesTotal: 0, startTime: performance.now(), elapsed: 0, eta: null })
    setOperationFiles(targets.map((e) => e.name))
    try {
      const taken = new Set(entries.map((e) => e.name))
      let successCount = 0
      let failedCount = 0
      for (const target of targets) {
        const inputPath = joinPath(currentPath, target.name)
        const headerRes = await vaultApi.call('read_header', { input_path: inputPath })
        if (!headerRes.ok) {
          failedCount++
          continue
        }
        const outName = conflictFreeName(headerRes.header.original_filename, taken)
        taken.add(outName)
        const res = await vaultApi.call('decrypt_file', { input_path: inputPath, output_path: joinPath(currentPath, outName) })
        if (res.ok) successCount++
        else failedCount++
        setOperationProgress((prev) => prev ? { ...prev, done: (prev.done || 0) + 1 } : prev)
      }
      if (failedCount === 0) toast.success(t('decryptHereSuccessToast', { count: successCount }))
      else toast.error(t('decryptHerePartialToast', { success: successCount, failed: failedCount }))
      await loadDirectory(currentPath)
    } finally {
      setOperationProgress(null)
      setOperationFiles([])
    }
  }

  async function createFolder() {
    const name = newFolderName.trim() || t('newFolderDefaultName')
    const res = await electronApi.makeDirectory(joinPath(currentPath, name))
    setNewFolderDialogOpen(false)
    setNewFolderName('')
    if (res.ok) await loadDirectory(currentPath)
    else toast.error(t('newFolderFailedToast'))
  }

  function computeRenamePlan(): { entry: DirEntry; newName: string }[] {
    const targets = entries.filter((e) => selected.has(e.name))
    const takenNames = new Set(entries.filter((e) => !selected.has(e.name)).map((e) => e.name))
    const plan: { entry: DirEntry; newName: string }[] = []
    targets.forEach((entry, i) => {
      let base: string
      if (renameMode === 'sequence') {
        const [, ext] = splitExt(entry.name, entry.isDirectory)
        const num = String(renameStart + i).padStart(renamePadding, '0')
        base = `${renamePrefix}${num}${ext}`
      } else {
        base = renameFind ? entry.name.split(renameFind).join(renameReplace) : entry.name
      }
      let finalName = base
      if (finalName !== entry.name) {
        const [candBase, candExt] = splitExt(base, entry.isDirectory)
        let suffix = 2
        while (takenNames.has(finalName)) {
          finalName = `${candBase} (${suffix})${candExt}`
          suffix++
        }
      }
      takenNames.add(finalName)
      plan.push({ entry, newName: finalName })
    })
    return plan
  }

  async function handleConfirmRename() {
    const changes = computeRenamePlan().filter((p) => p.newName !== p.entry.name)
    if (changes.length === 0) {
      setRenameDialogOpen(false)
      return
    }
    setRenaming(true)
    try {
      let successCount = 0
      let failedCount = 0
      for (const { entry, newName } of changes) {
        const res = await electronApi.renameEntry(joinPath(currentPath, entry.name), joinPath(currentPath, newName))
        if (res.ok) successCount++
        else failedCount++
      }
      if (failedCount === 0) toast.success(t('renameSuccessToast', { count: successCount }))
      else toast.error(t('renamePartialToast', { success: successCount, failed: failedCount }))
      setRenameDialogOpen(false)
      await loadDirectory(currentPath)
    } finally {
      setRenaming(false)
    }
  }

  useEffect(() => {
    return electronApi.onFileManagerMenuAction((action) => {
      if (action === 'copy') void doCopy()
      else if (action === 'cut') void doCut()
      else if (action === 'paste') void doPaste()
      else if (action === 'delete-recycle') doDeleteRecycle()
      else if (action === 'delete-permanent') requestDeletePermanent()
    })
  })

  const scrollParentRef = useRef<HTMLDivElement>(null)
  const rowVirtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollParentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
    // 测量缓存必须按条目完整路径存，不能按下标（与 ClipboardScreen 同规矩，tests/clipboardVirtualRows守
    // 着）。换目录或粘贴/删除重载后下标整体位移，按下标会把行高套到别的条目上，相邻行叠在一起且不报错。
    // 用完整路径而非文件名：同名文件在不同目录是不同条目。
    getItemKey: useCallback(
      (index: number) => (entries[index] ? joinPath(currentPath, entries[index].name) : index),
      [entries, currentPath],
    ),
  })

  // 行回调必须稳定引用，FileRow 的 memo 才有效；但 handler 闭包带着当次渲染的 state，不能冻住。做法：
  // 提交后把最新 handler 放进 ref（用 useEffect 而非渲染期赋值，避免被丢弃的并发渲染污染），包装函数
  // 只建一次，调用时读 ref。
  const liveHandlersRef = useRef({ handleRowClick, handleRowDoubleClick, handleEncryptToVault, handleSecureErase, handleDecryptHere })
  useEffect(() => {
    liveHandlersRef.current = { handleRowClick, handleRowDoubleClick, handleEncryptToVault, handleSecureErase, handleDecryptHere }
  })
  const rowCallbacks = useMemo(
    () => ({
      onRowClick: (entry: DirEntry, index: number, event: React.MouseEvent) =>
        liveHandlersRef.current.handleRowClick(entry.name, index, event),
      onRowDoubleClick: (entry: DirEntry) => liveHandlersRef.current.handleRowDoubleClick(entry),
      onEncryptToVault: (entry: DirEntry) => void liveHandlersRef.current.handleEncryptToVault(entry),
      onSecureErase: (entry: DirEntry) => void liveHandlersRef.current.handleSecureErase(entry),
      onDecryptHere: (entry: DirEntry) => void liveHandlersRef.current.handleDecryptHere(entry),
    }),
    [],
  )

  // 虚拟列表中看不见的行没有 DOM，不能靠 DOM focus() 走 Tab：用 aria-activedescendant 加容器持焦点，
  // 再 scrollToIndex。
  function moveActive(delta: number | 'first' | 'last', extendSelection: boolean) {
    if (entries.length === 0) return
    const current = activeIndex ?? lastSelectedIndex ?? -1
    let next: number
    if (delta === 'first') next = 0
    else if (delta === 'last') next = entries.length - 1
    else next = Math.min(entries.length - 1, Math.max(0, current < 0 ? (delta > 0 ? 0 : entries.length - 1) : current + delta))
    setActiveIndex(next)
    rowVirtualizer.scrollToIndex(next, { align: 'auto' })
    if (extendSelection && lastSelectedIndex !== null) {
      const from = Math.min(lastSelectedIndex, next)
      const to = Math.max(lastSelectedIndex, next)
      setSelected(() => {
        const set = new Set<string>()
        for (let i = from; i <= to; i++) set.add(entries[i].name)
        return set
      })
      return
    }
    setSelected(new Set([entries[next].name]))
    setLastSelectedIndex(next)
  }

  function handleKeyDown(event: React.KeyboardEvent) {
    if (isEditableKeyboardTarget(event.target)) return
    // 方向键导航先于快捷键判断——它们跟下面那些带 Ctrl/Delete 的绑定不会冲突。
    if (!event.ctrlKey && !event.altKey && !event.metaKey
      && (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End')) {
      event.preventDefault()
      if (event.key === 'ArrowDown') moveActive(1, event.shiftKey)
      else if (event.key === 'ArrowUp') moveActive(-1, event.shiftKey)
      else if (event.key === 'Home') moveActive('first', event.shiftKey)
      else moveActive('last', event.shiftKey)
      return
    }
    if (event.key === 'Enter' && activeIndex !== null && entries[activeIndex]) {
      event.preventDefault()
      handleRowDoubleClick(entries[activeIndex])
      return
    }
    if (shortcutMatches(event, shortcuts.copy)) {
      event.preventDefault()
      void doCopy()
    } else if (shortcutMatches(event, shortcuts.cut)) {
      event.preventDefault()
      void doCut()
    } else if (shortcutMatches(event, shortcuts.paste)) {
      event.preventDefault()
      void doPaste()
    } else if (shortcutMatches(event, shortcuts.delete_permanent)) {
      event.preventDefault()
      requestDeletePermanent()
    } else if (shortcutMatches(event, shortcuts.delete_recycle)) {
      event.preventDefault()
      doDeleteRecycle()
    } else if (event.key === 'Escape' && clipboardStatus.hasFiles && clipboardStatus.isCut) {
      event.preventDefault()
      void vaultApi.call('file_clip_clear_clipboard', {}).then(() => refreshClipboardStatus())
    } else if (event.ctrlKey && event.key === 'z' && !event.shiftKey && !event.altKey) {
      event.preventDefault()
      void doUndo()
    } else if (event.ctrlKey && event.shiftKey && event.key === 'h' && !event.altKey) {
      event.preventDefault()
      void openHistoryPanel()
    }
  }

  const parent = parentPath(currentPath)

  useEffect(() => {
    rowVirtualizer.scrollToOffset(0)
  }, [currentPath, rowVirtualizer])

  // Progress dialog percentage and bar value
  const progressPct = operationProgress && operationProgress.total > 0
    ? Math.min(100, Math.round((operationProgress.done / operationProgress.total) * 100))
    : 0

  return (
    <div ref={containerRef} className="ds-page-wash ds-pane-enter flex h-full flex-col px-6 py-5" tabIndex={0} onKeyDown={handleKeyDown}>
      {/* 标题在最上面，右边跟着挂钩状态徽章——原先标题被夹在状态条下面，
          进这一页第一眼看到的是"挂钩没启动"而不是"这是文件管理器"。

          用 <PageHeader> 而不是自己拼这一行：以前这里手抄的是
          `items-center gap-3 pb-4`，而 PageHeader 是 `items-start gap-x-6 pb-5`，
          于是从别的面板切到文件管理器时，标题会上下跳一下、图标和标题的间距也
          变一档。四个界面各抄一份、每份还都抄得不一样，正是「界面不统一」最典型
          的来源——看起来都对，放在一起才看得出来。 */}
      <PageHeader
        className="mb-4"
        
        title={t('title')}
        actions={
          isProfessional ? (
            <>
              <Badge
                tone={hookStatus.running ? 'success' : 'neutral'}
                
              >
                {hookStatus.running ? t('hookStatusRunning') : hookStatus.compiled ? t('hookStatusStopped') : t('hookStatusNotBuilt')}
              </Badge>
              <Button variant="outline" size="sm" disabled={hookWorking || !hookStatus.compiled} onClick={toggleHook}>
                {hookStatus.running ? t('hookDisableButton') : t('hookEnableButton')}
              </Button>
            </>
          ) : undefined
        }
      />
      {isProfessional && (
        <>
          {hookStatus.lastError && !hookStatus.running && (
            <p className="mb-2 text-sm text-destructive">{t('hookStatusError', { detail: hookStatus.lastError })}</p>
          )}
        </>
      )}

      <div className="mb-3 space-y-1.5">
        <IconToolbar
          storageKey="filemanager-actions"
          labelRegion={LABEL_REGIONS.fileManagerToolbar}
          defaultOpenGroupIds={['nav', 'fileops']}
          groups={[
            {
              id: 'nav',
              label: t('toolbarGroupNav'),
              icon: Compass,
              items: [
                {
                  id: 'drives',
                  label: t('driveThisPc'),
                  node: (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="outline" size="sm">
                          {t('driveThisPc')}
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent>
                        {drives.map((d) => (
                          <DropdownMenuItem key={d} onSelect={() => void loadDirectory(d)}>
                            {d}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ),
                },
                {
                  id: 'up',
                  label: t('upButton'),
                  icon: ArrowUp,
                  disabled: !parent,
                  onClick: () => { if (parent) void loadDirectory(parent) },
                },
                { id: 'refresh', label: t('refreshButton'), icon: RefreshCw, onClick: () => void loadDirectory(currentPath) },
              ],
            },
            {
              id: 'fileops',
              label: t('toolbarGroupFileOps'),
              icon: FolderCog,
              items: [
                { id: 'new-folder', label: t('newFolderButton'), icon: FolderPlus, onClick: () => setNewFolderDialogOpen(true) },
                {
                  id: 'paste',
                  label: t('pasteButton'),
                  icon: ClipboardPaste,
                  disabled: !clipboardStatus.hasFiles || transferring,
                  onClick: () => void doPaste(),
                },
                {
                  id: 'delete',
                  label: t('deleteButton'),
                  icon: Trash2,
                  destructive: true,
                  disabled: selected.size === 0 || transferring,
                  onClick: doDeleteRecycle,
                },
                {
                  id: 'rename',
                  label: t('batchRenameButton'),
                  icon: PencilLine,
                  disabled: selected.size === 0 || transferring,
                  onClick: () => setRenameDialogOpen(true),
                },
                {
                  id: 'undo',
                  label: t('undoButton'),
                  icon: RotateCcw,
                  disabled: !undoInfo.hasUndo || transferring,
                  onClick: () => void doUndo(),
                },
                {
                  id: 'history',
                  label: t('historyButton'),
                  icon: History,
                  hidden: !isProfessional,
                  onClick: () => void openHistoryPanel(),
                },
              ],
            },
          ]}
        />
        <p className="truncate text-sm text-muted-foreground" title={currentPath}>
          {currentPath}
        </p>
      </div>

      <div className="mb-2 flex items-center gap-3 text-sm text-muted-foreground">
        {selected.size > 0 && <span>{t('selectedCountLabel', { count: selected.size })}</span>}
        {clipboardStatus.hasFiles && (
          <span>
            {clipboardStatus.isCut
              ? t('clipboardCutLabel', { count: clipboardStatus.count })
              : t('clipboardCopiedLabel', { count: clipboardStatus.count })}
          </span>
        )}
        {undoInfo.hasUndo && (
          <Button variant="ghost" size="sm" className="h-auto px-1 py-0 text-sm" onClick={() => void doUndo()}>
            {undoInfo.description || t('undoButton')}
          </Button>
        )}
      </div>

      {truncatedCount > 0 && (
        <p className="mb-2 text-sm text-warning">
          {t('entriesTruncatedNotice', { shown: DIR_ENTRY_HARD_LIMIT, dropped: truncatedCount })}
        </p>
      )}

      <div ref={scrollParentRef} className="flex-1 overflow-auto rounded border">
        <div className={cn('sticky top-0 z-10 grid gap-2 border-b bg-muted/50 px-3 py-2.5 text-start text-sm font-medium', GRID_COLUMNS)}>
          <span>{t('columnName')}</span>
          <span>{t('columnSize')}</span>
          <span>{t('columnModified')}</span>
        </div>
        <div
          role="listbox"
          aria-multiselectable="true"
          aria-label={t('listAriaLabel')}
          aria-activedescendant={activeIndex !== null ? `fm-row-${activeIndex}` : undefined}
          style={{ height: rowVirtualizer.getTotalSize(), position: 'relative' }}
        >
          {rowVirtualizer.getVirtualItems().map((virtualRow) => {
            const index = virtualRow.index
            const entry = entries[index]
            if (!entry) return null
            const isSelected = selected.has(entry.name)
            return (
              <FileRow
                key={virtualRow.key}
                entry={entry}
                index={index}
                isSelected={isSelected}
                isActive={activeIndex === index}
                dimmed={clipboardStatus.isCut && clipboardStatus.count > 0 && isSelected}
                offset={virtualRow.start}
                measureRef={rowVirtualizer.measureElement}
                {...rowCallbacks}
              />
            )
          })}
        </div>
        {!loading && !loadError && entries.length === 0 && <p className="p-4 text-sm text-muted-foreground">{t('emptyFolderHint')}</p>}
        {loading && (
          <p className="p-4 text-sm text-muted-foreground">
            {sortProgress !== null ? t('sortingLabel', { percent: sortProgress }) : t('loadingLabel')}
          </p>
        )}
        {loadError && (
          <div className="flex flex-col items-start gap-2 p-4">
            <p className="text-sm text-destructive">
              {t('loadErrorPrefix')}
              {loadError}
            </p>
            <Button variant="outline" size="sm" onClick={() => loadDirectory(currentPath)}>
              {t('retryButton')}
            </Button>
          </div>
        )}
      </div>

      {/******** Operation Progress Dialog ********/}
      <Dialog open={transferring} onOpenChange={() => {}}>
        <DialogContent className="sm:max-w-lg" onPointerDownOutside={(e) => e.preventDefault()}>
          <DialogHeader>
            <DialogTitle>{operationProgress?.label || t('transferringLabel')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Progress value={progressPct} />
            {operationProgress && (
              <div className="grid grid-cols-3 gap-2 text-sm text-muted-foreground">
                <div>
                  <span className="font-medium text-foreground">{t('progressLabel')}</span>
                  <br />{operationProgress.done} / {operationProgress.total} {operationProgress.total > 1 ? t('progressItems') : t('progressItem')}
                </div>
                <div>
                  <span className="font-medium text-foreground">{t('progressElapsedLabel')}</span>
                  <br />{formatDuration(operationProgress.elapsed)}
                </div>
                <div>
                  <span className="font-medium text-foreground">{t('progressEtaLabel')}</span>
                  <br />{operationProgress.eta !== null ? formatDuration(operationProgress.eta) : t('progressCalculating')}
                </div>
              </div>
            )}
            <Progress value={progressPct} className="h-2" />
            {operationFiles.length > 0 && (
              <div className="max-h-24 space-y-0.5 overflow-y-auto rounded border p-2">
                {operationFiles.map((name) => (
                  <p key={name} className="truncate text-sm">{name}</p>
                ))}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/******** Delete Confirmation Dialog ********/}
      <Dialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('deletePermanentConfirmTitle')}</DialogTitle>
            <DialogDescription>{t('deletePermanentConfirmDescription', { count: deleteConfirmInfo.count })}</DialogDescription>
          </DialogHeader>
          {deleteConfirmInfo.totalBytes > 0 && (
            <p className="text-sm text-muted-foreground">
              {t('deletePermanentSizeHint', { size: formatSize(deleteConfirmInfo.totalBytes, false) })}
            </p>
          )}
          {deleteConfirmInfo.fileNames.length > 0 && (
            <div className="max-h-32 overflow-y-auto rounded border p-2 text-sm text-muted-foreground">
              {deleteConfirmInfo.fileNames.map((name) => (
                <p key={name} className="truncate">{name}</p>
              ))}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteConfirmOpen(false)}>
              {t('cancelButton')}
            </Button>
            <Button variant="destructive" onClick={confirmDeletePermanent}>
              {t('deletePermanentConfirmButton')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/******** Conflict Dialog (E8) ********/}
      <Dialog open={conflictDialogOpen} onOpenChange={(o) => !o && setConflictDialogOpen(false)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('conflictDialogTitle')}</DialogTitle>
            <DialogDescription>
              {t('conflictDialogDescription', { count: conflictItems.length })}
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-48 space-y-1 overflow-y-auto">
            {conflictItems.map((item) => (
              <div key={item.name} className="flex items-center justify-between text-sm">
                <span className="truncate">{item.name}</span>
                <span className="shrink-0 text-sm text-muted-foreground">
                  {formatSize(item.source_size, false)} → {formatSize(item.dest_size, false)}
                </span>
              </div>
            ))}
          </div>
          <div className="flex items-center gap-3 rounded border p-2">
            <span className="text-sm font-medium">{t('conflictResolveLabel')}</span>
            <div className="flex flex-1 flex-wrap gap-2">
              <Button size="sm" variant={conflictResolveMode === 'rename' ? 'default' : 'outline'} onClick={() => setConflictResolveMode('rename')}>
                {t('conflictResolveRename')}
              </Button>
              <Button size="sm" variant={conflictResolveMode === 'skip' ? 'default' : 'outline'} onClick={() => setConflictResolveMode('skip')}>
                {t('conflictResolveSkip')}
              </Button>
              <Button size="sm" variant={conflictResolveMode === 'overwrite' ? 'default' : 'outline'} onClick={() => setConflictResolveMode('overwrite')}>
                {t('conflictResolveOverwrite')}
              </Button>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConflictDialogOpen(false)}>
              {t('cancelButton')}
            </Button>
            <Button onClick={() => { setConflictDialogOpen(false); void executePaste(conflictResolveMode) }}>
              {t('conflictConfirmButton')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/******** History Dialog (E7) ********/}
      <Dialog open={historyDialogOpen} onOpenChange={setHistoryDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('historyDialogTitle')}</DialogTitle>
            <DialogDescription>{t('historyDialogDescription', { count: historyEntries.length })}</DialogDescription>
          </DialogHeader>
          {historyEntries.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('historyEmptyHint')}</p>
          ) : (
            <div className="max-h-64 space-y-1 overflow-y-auto">
              {historyEntries.map((entry, i) => (
                <div key={i} className="flex items-center justify-between rounded border p-2 text-sm">
                  <div className="min-w-0 flex-1">
                    <span className="font-medium">{entry.operation}</span>
                    <span className="ml-2 text-sm text-muted-foreground">{entry.timestamp}</span>
                  </div>
                  <span className="shrink-0 text-sm text-muted-foreground">
                    {entry.files_total} {t('historyFilesLabel')}
                    {entry.bytes_total > 0 && ` · ${formatSizeCompact(entry.bytes_total)}`}
                    {entry.elapsed > 0 && ` · ${formatDuration(entry.elapsed)}`}
                    {entry.errors_count > 0 && ` · ⚠${entry.errors_count}`}
                  </span>
                </div>
              ))}
            </div>
          )}
          <DialogFooter>
            {historyEntries.length > 0 && (
              <Button variant="outline" onClick={clearHistory}>
                {t('historyClearButton')}
              </Button>
            )}
            <Button variant="outline" onClick={() => setHistoryDialogOpen(false)}>
              {t('cancelButton')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/******** New Folder Dialog ********/}
      <Dialog open={newFolderDialogOpen} onOpenChange={setNewFolderDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('newFolderButton')}</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            value={newFolderName}
            placeholder={t('newFolderDefaultName')}
            onChange={(e) => setNewFolderName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void createFolder() }}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewFolderDialogOpen(false)}>{t('cancelButton')}</Button>
            <Button onClick={() => void createFolder()}>{t('newFolderButton')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/******** Rename Dialog ********/}
      <Dialog open={renameDialogOpen} onOpenChange={(o) => !renaming && setRenameDialogOpen(o)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('batchRenameDialogTitle', { count: selected.size })}</DialogTitle>
          </DialogHeader>
          <div className="flex gap-2">
            <Button size="sm" variant={renameMode === 'sequence' ? 'default' : 'outline'} onClick={() => setRenameMode('sequence')}>
              {t('renameModeSequenceLabel')}
            </Button>
            <Button size="sm" variant={renameMode === 'findReplace' ? 'default' : 'outline'} onClick={() => setRenameMode('findReplace')}>
              {t('renameModeFindReplaceLabel')}
            </Button>
          </div>
          {renameMode === 'sequence' ? (
            <div className="grid grid-cols-3 gap-2">
              <div className="space-y-1">
                <label className="text-sm text-muted-foreground">{t('renamePrefixLabel')}</label>
                <Input value={renamePrefix} onChange={(e) => setRenamePrefix(e.target.value)} />
              </div>
              <div className="space-y-1">
                <label className="text-sm text-muted-foreground">{t('renameStartLabel')}</label>
                <Input type="number" value={renameStart} onChange={(e) => setRenameStart(Math.max(0, Number(e.target.value) || 0))} />
              </div>
              <div className="space-y-1">
                <label className="text-sm text-muted-foreground">{t('renamePaddingLabel')}</label>
                <Input type="number" value={renamePadding} onChange={(e) => setRenamePadding(Math.min(10, Math.max(1, Number(e.target.value) || 1)))} />
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <label className="text-sm text-muted-foreground">{t('renameFindLabel')}</label>
                <Input value={renameFind} onChange={(e) => setRenameFind(e.target.value)} />
              </div>
              <div className="space-y-1">
                <label className="text-sm text-muted-foreground">{t('renameReplaceLabel')}</label>
                <Input value={renameReplace} onChange={(e) => setRenameReplace(e.target.value)} />
              </div>
            </div>
          )}
          <div className="space-y-1">
            <p className="text-sm text-muted-foreground">{t('renamePreviewLabel')}</p>
            <div className="max-h-48 space-y-0.5 overflow-y-auto rounded border p-2 text-sm">
              {computeRenamePlan().map(({ entry, newName }) => (
                <div key={entry.name} className={cn('truncate', newName === entry.name && 'text-muted-foreground')}>
                  {entry.name} → {newName}
                </div>
              ))}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameDialogOpen(false)} disabled={renaming}>
              {t('cancelButton')}
            </Button>
            <Button onClick={() => void handleConfirmRename()} disabled={renaming}>
              {t('renameConfirmButton')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
