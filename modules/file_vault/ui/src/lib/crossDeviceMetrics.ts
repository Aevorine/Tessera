/**
 * 跨设备连接指标。数据（在线设备、延迟、速度、累计量、端口、地址等）本就在跨设备页 state 里，
 * 来自守护进程事件流，只顺手记录，不加 IPC/轮询/线程，也不走 ProfessionalMetricsPanel 以免两路数不一致。
 * 安卓端 `LinkStats.kt` 算法与指标一致。
 * 累计量只算本次会话、不落盘：落盘就成了"何时传了多少"的记录，与应用不留痕的立场相悖。
 */

export interface SessionTotals {
  sentBytes: number
  recvBytes: number
}

/** 累计已传字节：必须按增量累加，不能直接加 done（它是该传输的累计值，每 250 ms 上报，会重复计数）。 */
export class SessionCounter {
  private lastDone = new Map<string, number>()
  private sent = 0
  private recv = 0

  record(key: string, direction: 'send' | 'recv', done: number): void {
    const prev = this.lastDone.get(key) ?? 0
    // 同一个 key 被复用（传完又传一个同名文件）时 done 会倒退回小值，
    // 那一次不该算成负增量，也不该把倒退当成新的一大笔。
    const delta = Math.max(0, done - prev)
    this.lastDone.set(key, done)
    if (direction === 'send') this.sent += delta
    else this.recv += delta
  }

  forget(key: string): void {
    this.lastDone.delete(key)
  }

  totals(): SessionTotals {
    return { sentBytes: this.sent, recvBytes: this.recv }
  }
}

/** 当前上下行速度，字节每秒。只统计正在跑的那些，暂停的不计。 */
export function currentSpeeds(
  active: Iterable<{ direction: 'send' | 'recv'; speed: number; state: 'running' | 'paused' }>,
): { up: number; down: number } {
  let up = 0
  let down = 0
  for (const a of active) {
    if (a.state === 'paused') continue
    if (a.direction === 'send') up += a.speed
    else down += a.speed
  }
  return { up, down }
}

/** 已配对设备中最好的链路延迟（毫秒）；取最小值而非平均，避免睡眠设备拖偏；null 表示尚无上报。 */
export function bestRttMs(devices: Iterable<{ state: string; rtt_ms?: number }>, onlineStates: Set<string>): number | null {
  let best: number | null = null
  for (const d of devices) {
    if (!onlineStates.has(d.state)) continue
    if (typeof d.rtt_ms !== 'number') continue
    if (best === null || d.rtt_ms < best) best = d.rtt_ms
  }
  return best
}

/** 屏幕刷新率（Hz）：浏览器无直接 API，采样 12 帧（约 100–200 ms）估算；取不到返回 null，不要猜 60。 */
export function measureRefreshRate(): Promise<number | null> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame !== 'function') {
      resolve(null)
      return
    }
    const stamps: number[] = []
    const tick = (now: number) => {
      stamps.push(now)
      if (stamps.length < 12) {
        requestAnimationFrame(tick)
        return
      }
      const span = stamps[stamps.length - 1] - stamps[0]
      resolve(span > 0 ? Math.round(((stamps.length - 1) / span) * 1000) : null)
    }
    requestAnimationFrame(tick)
  })
}
