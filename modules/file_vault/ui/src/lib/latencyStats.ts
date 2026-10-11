/** 一次剪贴板同步的端到端耗时（守护进程 peerJSON 的 clip_latency_hist）。 */
export interface LatencyPoint {
  ms: number
  at: number
}

export interface LatencyStats {
  min: number
  avg: number
  max: number
  last: number
  /** 最近一次比这段时间的中位数慢一倍以上：网络变差了。 */
  worse: boolean
}

export function latencyStats(points: LatencyPoint[]): LatencyStats | null {
  if (points.length === 0) return null
  const values = points.map((p) => p.ms)
  const sorted = [...values].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]
  const last = values[values.length - 1]
  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    avg: Math.round(values.reduce((s, v) => s + v, 0) / values.length),
    last,
    // 样本太少时不下结论；中位数很小时（本机回环 0~2 ms）翻倍毫无意义，给个下限。
    worse: points.length >= 4 && last > Math.max(median * 2, median + 50),
  }
}
