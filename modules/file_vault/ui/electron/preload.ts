import { contextBridge, ipcRenderer, webUtils } from 'electron'
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
} from '../src/shared/ipcTypes'

// Curated API surface only: 渲染端拿不到原始 ipcRenderer/Node（main.ts 中 contextIsolation +
// nodeIntegration:false）。
contextBridge.exposeInMainWorld('vaultAPI', {
  call: <M extends VaultMethodName>(method: M, params: VaultMethods[M]['params'], progressToken?: string) =>
    ipcRenderer.invoke('vault:call', method, params, progressToken) as Promise<VaultMethods[M]['result']>,

  onProgress: (callback: (payload: ProgressPayload) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: ProgressPayload) => callback(payload)
    ipcRenderer.on('vault:progress', listener)
    return () => ipcRenderer.off('vault:progress', listener)
  },

  onEvent: (callback: (payload: VaultPushEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: VaultPushEvent) => callback(payload)
    ipcRenderer.on('vault:event', listener)
    return () => ipcRenderer.off('vault:event', listener)
  },

  // 后端进程意外崩溃、被自动重新拉起之后触发——新进程内存里没有已解锁的
  // IMK，界面必须回到登录页重新走一遍解锁，不能假装还在解锁状态。
  onBackendRestarted: (callback: () => void) => {
    const listener = () => callback()
    ipcRenderer.on('vault:backend-restarted', listener)
    return () => ipcRenderer.off('vault:backend-restarted', listener)
  },

  // 金库被锁（自动规则或手动）。必须与 onBackendRestarted 分开：锁定后后端的重启是我们自己做的，
  // 共用通道会把正常锁定报成「后端意外重启」。
  onVaultLocked: (callback: (reason: string) => void) => {
    const listener = (_e: unknown, reason: string) => callback(reason)
    ipcRenderer.on('vault:locked', listener)
    return () => ipcRenderer.off('vault:locked', listener)
  },

  // 后端连续崩溃、已经放弃自动重启。detail 是后端最后那段 stderr——
  // 界面必须把它显示出来，那是用户唯一能看到真实原因的地方。
  onBackendFatal: (callback: (detail: string) => void) => {
    const listener = (_e: unknown, detail: string) => callback(detail)
    ipcRenderer.on('vault:backend-fatal', listener)
    return () => ipcRenderer.off('vault:backend-fatal', listener)
  },
})

// 跨设备同步独立成一套 API：背后是另一个进程（Go 守护进程），有独立设备密钥，不需要金库解锁；混进
// vaultAPI 会让「是否需先解锁」从类型上看不出。
contextBridge.exposeInMainWorld('crossDeviceAPI', {
  call: <T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> =>
    ipcRenderer.invoke('crossdevice:call', method, params) as Promise<T>,

  available: (): Promise<{ available: boolean; error: string | null }> =>
    ipcRenderer.invoke('crossdevice:available'),

  // 防火墙放在这条 API 下而不是 electronAPI：它查的是跨设备守护进程那个 exe，
  // 只有「设备与同步」这一个界面会用到，跟主程序的窗口/对话框能力无关。
  firewallStatus: (): Promise<{ state: 'allowed' | 'blocked' | 'unknown'; program: string | null }> =>
    ipcRenderer.invoke('crossdevice:firewall-status'),

  firewallAllow: (): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('crossdevice:firewall-allow'),

  onEvent: (callback: (payload: { event: string; data?: Record<string, unknown> }) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, payload: { event: string; data?: Record<string, unknown> }) =>
      callback(payload)
    ipcRenderer.on('crossdevice:event', listener)
    return () => ipcRenderer.off('crossdevice:event', listener)
  },
})

// Native file dialogs / shell integration, separate from the Python RPC
// surface above - these just proxy to Electron's own `dialog`/`shell`.
contextBridge.exposeInMainWorld('electronAPI', {
  // Always returns the full selection (possibly multiple paths) or null if
  // cancelled - single-file callers just read [0].
  openFiles: (options?: Electron.OpenDialogOptions): Promise<string[] | null> =>
    ipcRenderer.invoke('dialog:openFile', options),
  openDirectory: (options?: Electron.OpenDialogOptions): Promise<string | null> =>
    ipcRenderer.invoke('dialog:openDirectory', options),
  saveFile: (options?: Electron.SaveDialogOptions): Promise<string | null> =>
    ipcRenderer.invoke('dialog:saveFile', options),
  showItemInFolder: (targetPath: string): Promise<void> => ipcRenderer.invoke('shell:showItemInFolder', targetPath),
  getSystemLocale: (): Promise<string> => ipcRenderer.invoke('system:getLocale'),
  // null = 查不到（开发模式）。**不能兜成 false**：把"不知道"报成"未签名"
  // 会让安全体检面板凭空扣分，而用户无从修复。
  getSignatureStatus: (): Promise<{ verified: boolean; publisher: string | null; reason?: string } | null> =>
    ipcRenderer.invoke('system:getSignatureStatus'),
  getStartupSettings: (): Promise<{ openAtLogin: boolean; silent: boolean }> =>
    ipcRenderer.invoke('system:getStartupSettings'),
  // 返回写完之后回读到的真实状态，调用方拿它跟自己想要的比。
  setAutoStart: (enabled: boolean): Promise<boolean> => ipcRenderer.invoke('system:setAutoStart', enabled),
  setSilentStart: (enabled: boolean): Promise<boolean> => ipcRenderer.invoke('system:setSilentStart', enabled),
  getTxtAssociation: (): Promise<boolean> => ipcRenderer.invoke('system:getTxtAssociation'),
  setTxtAssociation: (enabled: boolean): Promise<void> => ipcRenderer.invoke('system:setTxtAssociation', enabled),
  getMdAssociation: (): Promise<boolean> => ipcRenderer.invoke('system:getMdAssociation'),
  setMdAssociation: (enabled: boolean): Promise<void> => ipcRenderer.invoke('system:setMdAssociation', enabled),

  // 全局快捷键自定义（剪贴板面板/全局速记）：键位存主进程 userData，改动即时重新注册；
  // registered 为 false 表示组合键被其他软件占用。见 main.ts 的 system:get/setGlobalShortcuts。
  getGlobalShortcuts: (): Promise<{
    shortcuts: GlobalShortcuts
    registered: Record<GlobalShortcutAction, boolean>
  }> => ipcRenderer.invoke('system:getGlobalShortcuts'),
  setGlobalShortcuts: (
    shortcuts: GlobalShortcuts
  ): Promise<
    | { ok: true; shortcuts: GlobalShortcuts; registered: Record<GlobalShortcutAction, boolean> }
    | { ok: false; error: string }
  > => ipcRenderer.invoke('system:setGlobalShortcuts', shortcuts),

  // 自动锁定。见 main.ts 的 DEFAULT_AUTO_LOCK 一段。
  getAutoLock: (): Promise<AutoLockSettings> => ipcRenderer.invoke('system:getAutoLock'),
  setAutoLock: (settings: AutoLockSettings): Promise<AutoLockSettings> =>
    ipcRenderer.invoke('system:setAutoLock', settings),
  lockNow: (): Promise<{ ok: true }> => ipcRenderer.invoke('system:lockNow'),

  // 菜单栏语言同步——渲染端切换语言时调用，主进程收到后（防抖300ms）重建
  // 原生菜单文案；不等待/不需要返回值，见 main.ts 的 system:setLanguage。
  setAppLanguage: (lang: string): void => {
    ipcRenderer.invoke('system:setLanguage', lang)
  },

  // 笔记导出 docx/pdf：返回 {ok:true} 或 {ok:false, error}，不抛异常，风格同 vaultAPI 的 RPC 结果。
  exportPdf: (html: string, savePath: string): Promise<{ ok: true } | { ok: false; error: string }> =>
    ipcRenderer.invoke('document:exportPdf', html, savePath),
  writeBinaryFileBase64: (targetPath: string, base64: string): Promise<{ ok: true } | { ok: false; error: string }> =>
    ipcRenderer.invoke('fs:writeBinaryFileBase64', targetPath, base64),

  // 记住的"上次导入/导出文件夹"路径可能已被删除/改名/移动——弹系统对话框
  // 前先查一下还在不在，不在就提示用户重选（见 pathMemory.ts）。
  pathExists: (targetPath: string): Promise<boolean> => ipcRenderer.invoke('fs:pathExists', targetPath),

  // 全局快捷键和「查看」菜单靠此事件切到指定面板（pane 取值同渲染端 AppShell 的 Pane 联合类型）。
  onNavigate: (callback: (pane: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, pane: string) => callback(pane)
    ipcRenderer.on('nav:show-pane', listener)
    return () => ipcRenderer.off('nav:show-pane', listener)
  },

  onQuickCapture: (callback: () => void) => {
    const listener = () => callback()
    ipcRenderer.on('notes:quick-capture', listener)
    return () => ipcRenderer.off('notes:quick-capture', listener)
  },

  // 「编辑 → 命令面板」：让 Ctrl+K 有被发现的入口。单向推送、无参数，
  // 菜单项无权指定打开哪个面板的哪一项。
  onOpenCommandPalette: (callback: () => void) => {
    const listener = () => callback()
    ipcRenderer.on('app:open-command-palette', listener)
    return () => ipcRenderer.off('app:open-command-palette', listener)
  },

  // App.tsx 挂载时主动查一次当前主题偏好——见 main.ts 里 system:getThemePreference
  // 的注释，theme:sync 只推送"挂载之后发生的变化"，补不上这一次。
  getThemePreference: (): Promise<'system' | 'light' | 'dark'> => ipcRenderer.invoke('system:getThemePreference'),
  setThemePreference: (pref: 'system' | 'light' | 'dark'): Promise<void> =>
    ipcRenderer.invoke('system:setThemePreference', pref),
  getRuntimeMetrics: (): Promise<RuntimeMetricsSnapshot> =>
    ipcRenderer.invoke('system:getRuntimeMetrics'),

  // 「查看→外观」切换后主进程显式推给渲染端；不能只靠 nativeTheme.themeSource 隐式联动
  // next-themes（实测不成立，见 main.ts applyThemePreference）。
  onThemeSync: (callback: (pref: 'system' | 'light' | 'dark') => void) => {
    const listener = (_event: Electron.IpcRendererEvent, pref: 'system' | 'light' | 'dark') => callback(pref)
    ipcRenderer.on('theme:sync', listener)
    return () => ipcRenderer.off('theme:sync', listener)
  },

  // ---- 应用更新 ----
  // 渲染端完全不碰网络和文件系统：检查、下载、验签、安装都在主进程，因为渲染端可能跑着被注入的内容。
  // 这里暴露的动作都不带路径/URL 参数，渲染端无法指定下载哪个 URL 或写到哪个文件；
  // 更新源也只能在两个内置仓库的代号之间选。
  getUpdateState: (): Promise<{
    currentVersion: string
    autoCheck: boolean
    canSelfUpdate: boolean
    source: UpdateSourceId
  }> => ipcRenderer.invoke('update:getState'),

  setUpdateSource: (source: UpdateSourceId): Promise<UpdateSourceId> => ipcRenderer.invoke('update:setSource', source),

  setUpdateAutoCheck: (enabled: boolean): Promise<boolean> => ipcRenderer.invoke('update:setAutoCheck', enabled),

  checkForUpdate: (force: boolean): Promise<UpdateCheckResult> => ipcRenderer.invoke('update:check', force),

  installUpdate: (): Promise<{ ok: true } | { ok: false; errorCode: string; errorMessage?: string }> =>
    ipcRenderer.invoke('update:install'),

  onUpdateProgress: (callback: (payload: UpdateProgress) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: UpdateProgress) => callback(payload)
    ipcRenderer.on('update:progress', listener)
    return () => ipcRenderer.off('update:progress', listener)
  },

  onUpdateAvailable: (callback: (result: UpdateCheckResult) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, result: UpdateCheckResult) => callback(result)
    ipcRenderer.on('update:available', listener)
    return () => ipcRenderer.off('update:available', listener)
  },

  getPathForFile: (file: File): string => webUtils.getPathForFile(file),

  copyDiagnostics: (): Promise<{ ok: true } | { ok: false; error: string }> => ipcRenderer.invoke('system:copyDiagnostics'),

  // 剪贴板走主进程的原生模块，不走 navigator.clipboard——后者在本应用里
  // 必然失败（权限被全局拒绝 + 要求文档有焦点），原因写在 main.ts 那两个
  // handler 的头注释里。渲染端不要直接调这两条，调 src/lib/clipboard.ts。
  clipboardWriteText: (text: string): Promise<{ ok: true } | { ok: false; error: string }> =>
    ipcRenderer.invoke('system:clipboardWriteText', text),
  clipboardReadText: (): Promise<{ ok: true; text: string } | { ok: false; error: string }> =>
    ipcRenderer.invoke('system:clipboardReadText'),
  resetAppPreferences: (): Promise<{ ok: true } | { ok: false; error: string }> => ipcRenderer.invoke('system:resetAppPreferences'),

  // 冷启动时（应用本没在跑，被 txt 文件"打开方式"直接拉起）取走一次待打开
  // 的文件路径，取完主进程那边就清空了——只在挂载后调一次即可。
  takePendingOpenPath: (): Promise<string | null> => ipcRenderer.invoke('vault:takePendingOpenPath'),

  // 应用已在跑（托盘常驻）时用户又用「打开方式」打开 txt：主进程 'second-instance'
  // 把文件路径转发到此事件，无需重启渲染端。
  onOpenTextFile: (callback: (path: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, path: string) => callback(path)
    ipcRenderer.on('vault:open-text-file', listener)
    return () => ipcRenderer.off('vault:open-text-file', listener)
  },

  // 文件管理面板：目录浏览走主进程 Node fs（见 main.ts 'fs:listDirectory'），
  // 真正的复制/剪切/粘贴/删除走 vaultAPI 的 file_clip_* RPC。
  listDirectory: (
    targetPath: string
  ): Promise<
    | { ok: true; path: string; entries: { name: string; isDirectory: boolean; size: number; mtimeMs: number }[] }
    | { ok: false; error: string }
  > => ipcRenderer.invoke('fs:listDirectory', targetPath),
  listDrives: (): Promise<string[]> => ipcRenderer.invoke('fs:listDrives'),
  openPath: (targetPath: string): Promise<{ ok: true } | { ok: false; error: string }> =>
    ipcRenderer.invoke('fs:openPath', targetPath),
  makeDirectory: (targetPath: string): Promise<{ ok: true } | { ok: false; error: string }> =>
    ipcRenderer.invoke('fs:makeDirectory', targetPath),
  renameEntry: (oldPath: string, newPath: string): Promise<{ ok: true } | { ok: false; error: string }> =>
    ipcRenderer.invoke('fs:renameEntry', oldPath, newPath),

  // 面板挂载/卸载各调一次——驱动主进程 Edit 菜单的"复制/剪切/粘贴/删除"在
  // 文件操作和普通文字编辑之间切换上下文（见 main.ts 的 fileManagerActive）。
  setFileManagerActive: (active: boolean): void => {
    ipcRenderer.send('filemanager:setActive', active)
  },
  onFileManagerMenuAction: (
    callback: (action: 'copy' | 'cut' | 'paste' | 'delete-recycle' | 'delete-permanent') => void
  ) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      action: 'copy' | 'cut' | 'paste' | 'delete-recycle' | 'delete-permanent'
    ) => callback(action)
    ipcRenderer.on('filemanager:menu-action', listener)
    return () => ipcRenderer.off('filemanager:menu-action', listener)
  },
  // 「关于」页：版本号单独一个通道，不复用 checkForUpdate()，以免每次打开都打 GitHub API，
  // 离线时还显示不出版本。
  getAppVersion: (): Promise<string> => ipcRenderer.invoke('app:getVersion'),
  // 打开外部链接。**主进程按白名单校验，渲染端传什么都不能绕过**——
  // 见 main.ts 里 'shell:openExternal' 的处理。
  openExternalLink: (url: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('shell:openExternal', url),
  // 第三方组件清单（scripts/gen-third-party-notices.mjs 生成的那份）。
  getFileHookEnabled: (): Promise<boolean> => ipcRenderer.invoke('filemanager:getHookEnabled'),
  setFileHookEnabled: (enabled: boolean): void => {
    ipcRenderer.send('filemanager:setHookEnabled', enabled)
  },
  onFileHookToggle: (callback: (enabled: boolean) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, enabled: boolean) => callback(enabled)
    ipcRenderer.on('filemanager:hook-toggle', listener)
    return () => ipcRenderer.off('filemanager:hook-toggle', listener)
  },
})
