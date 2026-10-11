/**
 * 开机自启 + 静默启动的纯逻辑（不 import electron）。
 * 开机自启的真相在注册表 HKCU\...\Run（用户在任务管理器等处关掉应被尊重，不另存偏好）；
 * 静默启动的真相在 userData/startup-preferences.json，只决定被自启拉起的那一次是否藏窗口。
 * 登录项带 LOGIN_LAUNCH_ARG，只有带它且静默启动开着才藏窗口，用户手动启动一律显示窗口。
 * 两者默认都开；偏好文件不存在才视为首次，写一次登录项并落盘，之后不再擅自打开用户关掉的自启。
 */

export const LOGIN_LAUNCH_ARG = '--autostart'

export interface StartupPreferences {
  /** 开机自启拉起时不显示主窗口，只留托盘图标。 */
  silent: boolean
}

export const DEFAULT_STARTUP_PREFERENCES: StartupPreferences = { silent: true }

/** 默认开机自启。只在偏好文件第一次生成时用一次。 */
export const DEFAULT_OPEN_AT_LOGIN = true

export function parseStartupPreferences(raw: unknown): StartupPreferences | null {
  if (typeof raw !== 'object' || raw === null) return null
  const silent = (raw as { silent?: unknown }).silent
  if (typeof silent !== 'boolean') return null
  return { silent }
}

export function isLoginLaunch(argv: readonly string[]): boolean {
  return argv.slice(1).some((arg) => arg === LOGIN_LAUNCH_ARG)
}

export function shouldStartHidden(argv: readonly string[], preferences: StartupPreferences): boolean {
  return preferences.silent && isLoginLaunch(argv)
}

export interface LoginItemSnapshot {
  /** 注册表里以本应用值名登记、且命令行跟期望完全一致。 */
  exactMatch: boolean
  /** 本应用值名下有登记，但命令行不对（旧版本没带参数、免安装版被挪了位置）。 */
  staleCommand: boolean
  /** StartupApproved 里的启用状态；没有这条记录时为 null（等同启用）。 */
  approved: boolean | null
}

/** 设置页上那个勾：真的会在下次登录时启动才算勾上。 */
export function effectiveOpenAtLogin(snapshot: LoginItemSnapshot): boolean {
  return snapshot.exactMatch && snapshot.approved !== false
}

export type LoginItemAction =
  | { kind: 'none' }
  | { kind: 'register'; enabled: boolean }

/**
 * 启动时要不要动登录项：首次（无偏好文件）按默认登记；本应用值名已登记但命令行过期（旧版没带
 * LOGIN_LAUNCH_ARG）则原样修好并保留用户在任务管理器设的启用/禁用；其余一律不碰。
 */
export function planLoginItemOnLaunch(firstRun: boolean, snapshot: LoginItemSnapshot): LoginItemAction {
  if (firstRun) {
    if (!DEFAULT_OPEN_AT_LOGIN || snapshot.exactMatch) return { kind: 'none' }
    return { kind: 'register', enabled: snapshot.approved !== false }
  }
  if (snapshot.staleCommand) return { kind: 'register', enabled: snapshot.approved !== false }
  return { kind: 'none' }
}

/** 解析 `reg query <key> /v <name>` 的输出，取出 REG_SZ 的值；没有返回 null。 */
export function parseRegQueryString(output: string, valueName: string): string | null {
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s+(.+?)\s+REG_(?:SZ|EXPAND_SZ)\s+(.*)$/.exec(line)
    if (match && match[1].toLowerCase() === valueName.toLowerCase()) return match[2].trim()
  }
  return null
}

/**
 * 解析 StartupApproved 的 REG_BINARY。第一个字节是偶数（02/06）= 启用，
 * 奇数（03/07）= 在任务管理器里被禁用。读不出来返回 null。
 */
export function parseRegQueryApproved(output: string, valueName: string): boolean | null {
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s+(.+?)\s+REG_BINARY\s+([0-9A-Fa-f]{2})/.exec(line)
    if (match && match[1].toLowerCase() === valueName.toLowerCase()) {
      return (Number.parseInt(match[2], 16) & 1) === 0
    }
  }
  return null
}
