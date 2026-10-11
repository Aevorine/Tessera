import type {
  RecoveryCodeEntry,
  RecoveryCodeGroup,
  RecoveryCodeTimelineEntry,
  RevealedRecoveryCode,
} from '@/shared/ipcTypes'

/** 恢复码修改时间线的纯函数：按天分组、同批合并、与当前版本对比、生成合并计划；不碰 React。 */

// ---- 按天分组 + 同批合并 -----------------------------------------------------

export type TimelineItem =
  | { kind: 'single'; entry: RecoveryCodeTimelineEntry }
  /** 同一次批量操作（批量修改 / 合并重复项）落下的几条，画成一块，给一颗「整批撤销」。 */
  | { kind: 'batch'; batchId: string; entries: RecoveryCodeTimelineEntry[] }

export interface TimelineDay {
  /** 本地日期 YYYY-MM-DD，当 React key 用。 */
  day: string
  /** 这一天第一条的时间戳（秒），给标题格式化用。 */
  timestamp: number
  items: TimelineItem[]
}

function localDay(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd}`
}

/** entries 新的在前；同一 batch_id 只在首次出现处画一块，即使被别的改动夹开也不重复。 */
export function groupTimeline(entries: RecoveryCodeTimelineEntry[]): TimelineDay[] {
  const days: TimelineDay[] = []
  const batchBlocks = new Map<string, Extract<TimelineItem, { kind: 'batch' }>>()
  const batchSizes = new Map<string, number>()
  for (const e of entries) {
    if (e.batch_id) batchSizes.set(e.batch_id, (batchSizes.get(e.batch_id) ?? 0) + 1)
  }
  for (const e of entries) {
    const day = localDay(e.timestamp)
    let bucket = days[days.length - 1]
    if (!bucket || bucket.day !== day) {
      bucket = { day, timestamp: e.timestamp, items: [] }
      days.push(bucket)
    }
    // 一批只有一条的（比如批量修改里只改动了一个服务）按单条画，
    // 为一条记录套一个"整批"的框只会让人以为还有别的东西藏着。
    if (e.batch_id && (batchSizes.get(e.batch_id) ?? 0) > 1) {
      const existing = batchBlocks.get(e.batch_id)
      if (existing) {
        existing.entries.push(e)
        continue
      }
      const block = { kind: 'batch' as const, batchId: e.batch_id, entries: [e] }
      batchBlocks.set(e.batch_id, block)
      bucket.items.push(block)
      continue
    }
    bucket.items.push({ kind: 'single', entry: e })
  }
  return days
}

// ---- 与当前对比 --------------------------------------------------------------

export type MetaField = 'service' | 'account_label' | 'note'

export interface RevisionDiff {
  meta: Array<{ field: MetaField; then: string; now: string }>
  countThen: number
  countNow: number
  usedThen: number
  usedNow: number
  /**
   * true：两边都有明文，按码比对，added/removed 精确。
   * false：只有打码后的序号与是否用过，按位置比，数量差为近似值，界面须说明。
   */
  byCode: boolean
  added: string[] | number
  removed: string[] | number
  /** 那时还没用、现在用掉了的码（明文模式下是码本身，打码模式下是序号）。 */
  newlyUsed: Array<string | number>
  /** 那时标了已用、现在又改回未用的。 */
  newlyUnused: Array<string | number>
  /** 什么都没变。 */
  identical: boolean
}

interface Side {
  service: string
  account_label: string
  note: string
  codes: RecoveryCodeEntry[]
  revealed: RevealedRecoveryCode[] | null
}

export function diffRevision(then: Side, now: Side): RevisionDiff {
  const meta: RevisionDiff['meta'] = []
  for (const field of ['service', 'account_label', 'note'] as const) {
    if (then[field] !== now[field]) meta.push({ field, then: then[field], now: now[field] })
  }
  const usedThen = then.codes.filter((c) => c.used).length
  const usedNow = now.codes.filter((c) => c.used).length

  let byCode = false
  let added: RevisionDiff['added'] = Math.max(0, now.codes.length - then.codes.length)
  let removed: RevisionDiff['removed'] = Math.max(0, then.codes.length - now.codes.length)
  const newlyUsed: Array<string | number> = []
  const newlyUnused: Array<string | number> = []

  if (then.revealed && now.revealed) {
    byCode = true
    const thenByCode = new Map(then.revealed.map((c) => [c.code, c]))
    const nowByCode = new Map(now.revealed.map((c) => [c.code, c]))
    added = now.revealed.filter((c) => !thenByCode.has(c.code)).map((c) => c.code)
    removed = then.revealed.filter((c) => !nowByCode.has(c.code)).map((c) => c.code)
    for (const c of now.revealed) {
      const before = thenByCode.get(c.code)
      if (!before) continue
      if (!before.used && c.used) newlyUsed.push(c.code)
      if (before.used && !c.used) newlyUnused.push(c.code)
    }
  } else {
    const thenByIndex = new Map(then.codes.map((c) => [c.index, c]))
    for (const c of now.codes) {
      const before = thenByIndex.get(c.index)
      if (!before) continue
      // 界面上的序号从 1 开始数，跟详情页那一列对得上。
      if (!before.used && c.used) newlyUsed.push(c.index + 1)
      if (before.used && !c.used) newlyUnused.push(c.index + 1)
    }
  }

  const addedCount = typeof added === 'number' ? added : added.length
  const removedCount = typeof removed === 'number' ? removed : removed.length
  const identical =
    meta.length === 0 &&
    addedCount === 0 &&
    removedCount === 0 &&
    newlyUsed.length === 0 &&
    newlyUnused.length === 0 &&
    then.codes.length === now.codes.length

  return {
    meta,
    countThen: then.codes.length,
    countNow: now.codes.length,
    usedThen,
    usedNow,
    byCode,
    added,
    removed,
    newlyUsed,
    newlyUnused,
    identical,
  }
}

// ---- 去重：合并计划 ----------------------------------------------------------

/** 一组重复项里默认留哪一个：剩余可用最多的；一样多就留最近改过的。 */
export function defaultKeepId(ids: string[], groups: Map<string, RecoveryCodeGroup>): string {
  let best = ids[0]
  for (const id of ids.slice(1)) {
    const a = groups.get(id)
    const b = groups.get(best)
    if (!a) continue
    if (!b) {
      best = id
      continue
    }
    if (a.remainingCount > b.remainingCount || (a.remainingCount === b.remainingCount && a.lastUpdatedAt > b.lastUpdatedAt)) {
      best = id
    }
  }
  return best
}

/**
 * 把勾选的重复组拼成合并计划。「同名同账号」与「码相同」两种判据会产生重叠组，
 * 直接各发各的会让后端处理第二组时成员已被并掉；故先按共享成员连成连通块，每块只发一条。
 */
export function buildMergePlan(sets: Array<{ ids: string[]; keepId: string }>): Array<{ keep_id: string; merge_ids: string[] }> {
  const parent = new Map<string, string>()
  const find = (x: string): string => {
    let root = x
    while (parent.get(root) !== root) root = parent.get(root)!
    // 路径压缩：连通块大了以后下一次查找不用再一路爬。
    let cur = x
    while (parent.get(cur) !== root) {
      const next = parent.get(cur)!
      parent.set(cur, root)
      cur = next
    }
    return root
  }
  for (const set of sets) {
    for (const id of set.ids) if (!parent.has(id)) parent.set(id, id)
    for (const id of set.ids.slice(1)) {
      const a = find(set.ids[0])
      const b = find(id)
      if (a !== b) parent.set(b, a)
    }
  }
  const keepByRoot = new Map<string, string>()
  for (const set of sets) {
    const root = find(set.ids[0])
    if (!keepByRoot.has(root)) keepByRoot.set(root, set.keepId)
  }
  const membersByRoot = new Map<string, string[]>()
  for (const id of parent.keys()) {
    const root = find(id)
    const list = membersByRoot.get(root) ?? []
    list.push(id)
    membersByRoot.set(root, list)
  }
  const plan: Array<{ keep_id: string; merge_ids: string[] }> = []
  for (const [root, members] of membersByRoot) {
    const keep = keepByRoot.get(root) ?? members[0]
    const merge = members.filter((id) => id !== keep)
    if (merge.length > 0) plan.push({ keep_id: keep, merge_ids: merge })
  }
  return plan
}
