import { scheduleIdleWork } from '@/lib/runtimeQuality'

/**
 * 面板预取：在用户点下去之前把面板的代码块取好，切面板不再等加载。
 *
 * 三路信号，按把握从大到小：
 * - 意图：指针或键盘焦点停在入口上（掠过不算），立刻取；
 * - 预测：本次会话里「从 A 去过哪」的一阶转移计数，切到 A 后空闲时取最可能的下一站；
 * - 置顶：用户自己放进常用区的入口，空闲时取。
 *
 * 转移计数只在内存里，不落盘。取的只是代码，不碰金库数据，也不绕过模块解锁。
 */

export type PaneLoader = () => Promise<unknown>

export interface PanePrefetcher<K extends string> {
  /** 指针或焦点落到入口上时调用；离开时调用返回的函数。 */
  intent(key: K): () => void
  /** 记一次切换，并在空闲时预取预测的下一站。 */
  visited(key: K): void
  /** 空闲时依次预热。 */
  warm(keys: readonly K[]): void
}

/** 停够这么久才算想点：比一次掠过长，比按下前的瞄准时间短。 */
const INTENT_DWELL_MS = 70
const PREDICT_TOP = 2
/** 占比不到这么多的去向不取：猜错的代价是白解析一个代码块。 */
const PREDICT_MIN_SHARE = 0.2
/** 每记一次新转移，同一出发点的旧计数乘这个数：习惯会变，近的比远的可信。 */
const DECAY = 0.9

export function createPanePrefetcher<K extends string>(loaders: Partial<Record<K, PaneLoader>>): PanePrefetcher<K> {
  // 几个入口可能共用一个代码块，所以按加载函数去重。
  const started = new Set<PaneLoader>()
  const transitions = new Map<K, Map<K, number>>()
  let current: K | null = null

  const load = (key: K) => {
    const loader = loaders[key]
    if (!loader || started.has(loader)) return
    started.add(loader)
    // 失败就忘掉，真正切过去时会再取。
    loader().catch(() => started.delete(loader))
  }

  /** 一个空闲片取一个：连着取会把几个代码块的求值挤进同一帧。 */
  const loadWhenIdle = (keys: readonly K[]) => {
    const queue = keys.filter((key) => {
      const loader = loaders[key]
      return loader !== undefined && !started.has(loader)
    })
    const step = () => {
      const key = queue.shift()
      // 机器吃紧（lean 档）时不做猜测性的工作；意图预取不受此限。
      if (key === undefined || document.documentElement.dataset.quality === 'lean') return
      scheduleIdleWork(() => {
        load(key)
        step()
      })
    }
    step()
  }

  const predict = (from: K): K[] => {
    const row = transitions.get(from)
    if (!row) return []
    let total = 0
    for (const weight of row.values()) total += weight
    return [...row.entries()]
      .filter(([, weight]) => weight / total >= PREDICT_MIN_SHARE)
      .sort((a, b) => b[1] - a[1])
      .slice(0, PREDICT_TOP)
      .map(([to]) => to)
  }

  return {
    intent(key) {
      const timer = window.setTimeout(() => load(key), INTENT_DWELL_MS)
      return () => window.clearTimeout(timer)
    },
    visited(key) {
      if (current !== null && current !== key) {
        const row = transitions.get(current) ?? new Map<K, number>()
        for (const [to, weight] of row) row.set(to, weight * DECAY)
        row.set(key, (row.get(key) ?? 0) + 1)
        transitions.set(current, row)
      }
      current = key
      loadWhenIdle(predict(key))
    },
    warm(keys) {
      loadWhenIdle(keys)
    },
  }
}
