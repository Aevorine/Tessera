import type {
  AutoLockSettings,
  GlobalShortcutAction,
  GlobalShortcuts,
  ProgressPayload,
  RuntimeMetricsSnapshot,
  UpdateCheckResult,
  UpdateProgress,
  UpdateSourceId,
  VaultMethodName,
  VaultMethods,
  VaultPushEvent,
} from './ipcTypes'

declare global {
  interface Window {
    vaultAPI: {
      // progressToken：调用方自拟的不透明 id，在本次调用的每条 vault:progress 广播里回显，
      // 用来区分同一方法的并发调用（见 FilesPane.tsx 的并行 runBatch）；省略则按旧方式只按 method 过滤。
      call<M extends VaultMethodName>(
        method: M,
        params: VaultMethods[M]['params'],
        progressToken?: string,
      ): Promise<VaultMethods[M]['result']>
      onProgress(callback: (payload: ProgressPayload) => void): () => void
      onEvent(callback: (payload: VaultPushEvent) => void): () => void
      onBackendRestarted(callback: () => void): () => void
      onVaultLocked(callback: (reason: string) => void): () => void
      /** 后端连续崩溃、已放弃自动重启；detail 是后端最后那段 stderr。 */
      onBackendFatal(callback: (detail: string) => void): () => void
    }
    /** 跨设备同步。背后是独立的 Go 守护进程，不需要金库解锁即可调用。
     *  方法名与返回结构见 crossdevice/cmd/tessera-crossdevice/main.go 的 dispatch()。 */
    crossDeviceAPI: {
      call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>
      available(): Promise<{ available: boolean; error: string | null }>
      onEvent(callback: (payload: { event: string; data?: Record<string, unknown> }) => void): () => void
      /** 查守护进程有没有防火墙入站放行。不需要权限，随时可调。 */
      firewallStatus(): Promise<{ state: 'allowed' | 'blocked' | 'unknown'; program: string | null }>
      /** 加放行规则。**会弹 UAC**，只能由用户点按钮触发。 */
      firewallAllow(): Promise<{ ok: boolean; error?: string }>
    }
    electronAPI: {
      openFiles(options?: Electron.OpenDialogOptions): Promise<string[] | null>
      openDirectory(options?: Electron.OpenDialogOptions): Promise<string | null>
      saveFile(options?: Electron.SaveDialogOptions): Promise<string | null>
      showItemInFolder(targetPath: string): Promise<void>
      getSystemLocale(): Promise<string>
      /** 这个应用自己是不是官方签名的。**null = 查不到**（开发模式），
       *  跟 false（验签失败）是两回事——安全体检面板据此区分"扣分"和"不计入"。 */
      getSignatureStatus(): Promise<{ verified: boolean; publisher: string | null; reason?: string } | null>
      /** openAtLogin = 下次登录真的会启动（任务管理器里禁用了算 false）；
       *  silent = 开机自启拉起时不显示主窗口，只留托盘。 */
      getStartupSettings(): Promise<{ openAtLogin: boolean; silent: boolean }>
      setAutoStart(enabled: boolean): Promise<boolean>
      setSilentStart(enabled: boolean): Promise<boolean>
      getTxtAssociation(): Promise<boolean>
      setTxtAssociation(enabled: boolean): Promise<void>
      getMdAssociation(): Promise<boolean>
      setMdAssociation(enabled: boolean): Promise<void>
      getGlobalShortcuts(): Promise<{
        shortcuts: GlobalShortcuts
        registered: Record<GlobalShortcutAction, boolean>
      }>
      setGlobalShortcuts(
        shortcuts: GlobalShortcuts,
      ): Promise<
        | { ok: true; shortcuts: GlobalShortcuts; registered: Record<GlobalShortcutAction, boolean> }
        | { ok: false; error: string }
      >
      getAutoLock(): Promise<AutoLockSettings>
      setAutoLock(settings: AutoLockSettings): Promise<AutoLockSettings>
      lockNow(): Promise<{ ok: true }>
      setAppLanguage(lang: string): void
      exportPdf(html: string, savePath: string): Promise<{ ok: true } | { ok: false; error: string }>
      writeBinaryFileBase64(targetPath: string, base64: string): Promise<{ ok: true } | { ok: false; error: string }>
      pathExists(targetPath: string): Promise<boolean>
      onNavigate(callback: (pane: string) => void): () => void
      onQuickCapture(callback: () => void): () => void
      onOpenCommandPalette(callback: () => void): () => void
      getThemePreference(): Promise<'system' | 'light' | 'dark'>
      setThemePreference(pref: 'system' | 'light' | 'dark'): Promise<void>
      getRuntimeMetrics(): Promise<RuntimeMetricsSnapshot>
      onThemeSync(callback: (pref: 'system' | 'light' | 'dark') => void): () => void
      getPathForFile(file: File): string

      // 应用更新：渲染端完全不碰网络和文件系统，没有任何方法接受 URL 或路径参数。见 preload.ts。
      getUpdateState(): Promise<{
        currentVersion: string
        autoCheck: boolean
        canSelfUpdate: boolean
        source: UpdateSourceId
      }>
      setUpdateSource(source: UpdateSourceId): Promise<UpdateSourceId>
      setUpdateAutoCheck(enabled: boolean): Promise<boolean>
      checkForUpdate(force: boolean): Promise<UpdateCheckResult>
      installUpdate(): Promise<{ ok: true } | { ok: false; errorCode: string; errorMessage?: string }>
      onUpdateProgress(callback: (payload: UpdateProgress) => void): () => void
      onUpdateAvailable(callback: (result: UpdateCheckResult) => void): () => void
      copyDiagnostics(): Promise<{ ok: true } | { ok: false; error: string }>
      clipboardWriteText(text: string): Promise<{ ok: true } | { ok: false; error: string }>
      clipboardReadText(): Promise<{ ok: true; text: string } | { ok: false; error: string }>
      resetAppPreferences(): Promise<{ ok: true } | { ok: false; error: string }>
      takePendingOpenPath(): Promise<string | null>
      onOpenTextFile(callback: (path: string) => void): () => void
      listDirectory(targetPath: string): Promise<
        | { ok: true; path: string; entries: { name: string; isDirectory: boolean; size: number; mtimeMs: number }[] }
        | { ok: false; error: string }
      >
      listDrives(): Promise<string[]>
      openPath(targetPath: string): Promise<{ ok: true } | { ok: false; error: string }>
      makeDirectory(targetPath: string): Promise<{ ok: true } | { ok: false; error: string }>
      renameEntry(oldPath: string, newPath: string): Promise<{ ok: true } | { ok: false; error: string }>
      setFileManagerActive(active: boolean): void
      onFileManagerMenuAction(
        callback: (action: 'copy' | 'cut' | 'paste' | 'delete-recycle' | 'delete-permanent') => void,
      ): () => void
      getFileHookEnabled(): Promise<boolean>
      setFileHookEnabled(enabled: boolean): void
      onFileHookToggle(callback: (enabled: boolean) => void): () => void
      /** 「关于」页的版本号。不联网——checkForUpdate 才联网。 */
      getAppVersion(): Promise<string>
      /** 打开外部链接。主进程按域名白名单校验，被拒返回 `{ ok: false }` 而不抛错，调用方可安静提示「链接被拦截」。 */
      openExternalLink(url: string): Promise<{ ok: boolean }>
    }
  }
}

export {}
