import type { PcCleanItem, PcCleanMemoryStatus } from '@/shared/pccleanTypes'

/**
 * 体检分数：首屏环上的数字。每项扣分都要列出（扣多少、因为什么、跳到哪），分数只是入口。
 * 权重按清掉它对用户的实际收益定，上限合计 100：可释放空间 -30（按占系统盘比例扣，
 * 拿不到盘容量时按绝对值分档）、推广垃圾 -25、开机自启 -20、内存占用 -15（仅 >80% 才扣）、隐私痕迹 -10。
 * 无隐藏项、无随机数，同样状态永远同分；守卫见 `ui/tests/healthScore.test.mjs`。
 */

export interface ScorePenalty {
  /** i18n 键（pcclean 命名空间，不带前缀）。 */
  labelKey: string
  points: number
  /** 一句话说清这一项在扣什么。 */
  detail: string
  /** 点这条跳到哪一类。 */
  category?: string
}

export interface HealthScoreResult {
  score: number
  penalties: ScorePenalty[]
  tone: 'success' | 'warning' | 'danger'
}

const MAX = {
  space: 30,
  junkware: 25,
  startup: 20,
  memory: 15,
  privacy: 10,
} as const

const GB = 1024 ** 3

export function computeHealthScore(
  items: readonly PcCleanItem[],
  memory: PcCleanMemoryStatus | null,
  systemDriveTotalBytes?: number,
): HealthScoreResult {
  const penalties: ScorePenalty[] = []

  // -- 可释放空间 ---------------------------------------------------------
  const reclaimable = items
    .filter((i) => i.default_selected && !i.locked)
    .reduce((n, i) => n + i.size_bytes, 0)
  if (reclaimable > 0) {
    // 有盘容量就按比例（10% 可释放 = 扣满），没有就按绝对值（20 GB = 扣满）。
    const ratio = systemDriveTotalBytes && systemDriveTotalBytes > 0
      ? reclaimable / (systemDriveTotalBytes * 0.1)
      : reclaimable / (20 * GB)
    const points = Math.min(MAX.space, Math.round(ratio * MAX.space))
    if (points > 0) {
      penalties.push({
        labelKey: 'score.space',
        points,
        detail: formatGb(reclaimable),
        category: 'junk',
      })
    }
  }

  // -- 推广垃圾 -----------------------------------------------------------
  const junkware = items.filter((i) => i.importance === 'junk').length
  if (junkware > 0) {
    // 每一项扣 2 分，8 项就扣满。**不是线性到 100 项**——20 个推广垃圾和
    // 100 个之间的差别，对"这台机器行不行"这个判断没有意义，都是"很脏"。
    const points = Math.min(MAX.junkware, junkware * 2)
    penalties.push({
      labelKey: 'score.junkware',
      points,
      detail: String(junkware),
      category: 'plugins',
    })
  }

  // -- 开机自启 -----------------------------------------------------------
  const startup = items.filter((i) => i.category === 'startup' && !i.locked).length
  if (startup > 8) {
    // 8 项以内不扣：一台正常使用的机器本来就有输入法、显卡驱动、云盘。
    // 超出的部分每项扣 1.5 分。
    const points = Math.min(MAX.startup, Math.round((startup - 8) * 1.5))
    if (points > 0) {
      penalties.push({
        labelKey: 'score.startup',
        points,
        detail: String(startup),
        category: 'startup',
      })
    }
  }

  // -- 内存 ---------------------------------------------------------------
  if (memory && memory.load_percent > 80) {
    // 80% 以下不扣。现代系统会主动把空闲内存拿去做缓存，
    // "内存用得多"本身不是病——90% 才是。
    const points = Math.min(MAX.memory, Math.round((memory.load_percent - 80) * 1.5))
    if (points > 0) {
      penalties.push({
        labelKey: 'score.memory',
        points,
        detail: `${memory.load_percent}%`,
        category: 'memory',
      })
    }
  }

  // -- 隐私痕迹 -----------------------------------------------------------
  const privacy = items.filter((i) => i.category === 'privacy').length
  if (privacy > 0) {
    const points = Math.min(MAX.privacy, Math.ceil(privacy / 3))
    penalties.push({
      labelKey: 'score.privacy',
      points,
      detail: String(privacy),
      category: 'privacy',
    })
  }

  const total = penalties.reduce((n, p) => n + p.points, 0)
  const score = Math.max(0, Math.min(100, 100 - total))
  return {
    score,
    penalties: penalties.sort((a, b) => b.points - a.points),
    tone: score >= 85 ? 'success' : score >= 60 ? 'warning' : 'danger',
  }
}

function formatGb(bytes: number): string {
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)} GB`
  return `${Math.round(bytes / 1024 / 1024)} MB`
}

