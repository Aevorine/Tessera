/**
 * 启动耗时埋点：把「启动慢」换成可量化的账单。
 * 四个点：process（进程创建）、appReady（Electron 开销，改不动）、windowShown（ready-to-show，
 * 用户眼里的启动完成）、
 * backendReady（后端首次应答，之前界面是空壳）。windowShown 与 backendReady 是独立两条线，
 * 不能合成一个数。
 * 刻意只用四次 Date.now()，不用 performance.mark/measure（会在主进程维护条目表）。
 */

export type StartupPhase =
  | 'appReady'
  | 'crossDeviceStarted'
  | 'windowCreated'
  | 'trayCreated'
  | 'menuBuilt'
  | 'shortcutsRegistered'
  | 'ipcRegistered'
  | 'windowShown'
  | 'backendReady'

/**
 * 进程真正开始的时刻：用 performance.timeOrigin 而非模块顶部 Date.now()，后者会漏掉 Electron/V8
 * 启动这块最大的冷启动开销。
 */
const PROCESS_START_MS = performance.timeOrigin

const marks = new Map<StartupPhase, number>()

/** 记一个点。同一个点重复记只认第一次——重启后端会再次触发 backendReady，
 *  而我们要的是"启动时的那一次"，不是运行期的每一次。 */
export function markStartup(phase: StartupPhase): void {
  if (marks.has(phase)) return
  marks.set(phase, Date.now() - PROCESS_START_MS)
}

/** 各阶段相对进程启动的毫秒数。没记到的点不出现在结果里（而不是填 0——
 *  0 会被当成"瞬间完成"，那是假数据）。 */
export function startupTimings(): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [phase, ms] of marks) out[phase] = Math.round(ms)
  return out
}

/** 一行可读的启动账单，固定前缀 `[startup]`，便于 grep 收集多次运行取中位数。 */
export function formatStartupReport(): string {
  const t = startupTimings()
  const parts: string[] = []
  let prev = 0
  const ORDER: StartupPhase[] = [
    'appReady',
    'crossDeviceStarted',
    'windowCreated',
    'trayCreated',
    'menuBuilt',
    'shortcutsRegistered',
    'ipcRegistered',
    'windowShown',
    'backendReady',
  ]
  for (const phase of ORDER) {
    const ms = t[phase]
    if (ms === undefined) continue
    // 同时给绝对值和"这一段自己花了多少"——只有绝对值的话，
    // 看不出四段里哪一段是大头，而那正是这张账要回答的问题。
    parts.push(`${phase}=${ms}ms(+${ms - prev})`)
    prev = ms
  }
  return `[startup] ${parts.join(' ')}`
}
