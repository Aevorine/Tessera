import type { RecoveryCodeGroup } from '@/shared/ipcTypes'

/**
 * 恢复码页「分类」菜单的数据：先按状态，再按服务 ▸ 账号，全部从数据里算。
 * 服务名去首尾空白、不分大小写后归并，避免同一服务被拆成两个分类。
 */

export type RecoveryFilter =
  | { kind: 'all' }
  | { kind: 'lowStock' }
  | { kind: 'review' }
  /** account 省略 = 这个服务下的全部账号。 */
  | { kind: 'service'; key: string; account?: string }

export const ALL_RECOVERY: RecoveryFilter = { kind: 'all' }

export interface AccountFacet {
  /** 原样的账号标签（去掉首尾空白）；没有标签是空串。 */
  label: string
  count: number
}

export interface ServiceFacet {
  /** 归并用的键：服务名去空白、转小写。 */
  key: string
  /** 显示用的写法：这个服务里最常见的那种拼法。 */
  service: string
  count: number
  accounts: AccountFacet[]
}

export function serviceKey(service: string): string {
  return service.trim().toLocaleLowerCase()
}

function accountOf(g: RecoveryCodeGroup): string {
  return g.accountLabel.trim()
}

export function buildServiceFacets(groups: RecoveryCodeGroup[]): ServiceFacet[] {
  const buckets = new Map<string, { spellings: Map<string, number>; count: number; accounts: Map<string, number> }>()
  for (const g of groups) {
    const key = serviceKey(g.service)
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = { spellings: new Map(), count: 0, accounts: new Map() }
      buckets.set(key, bucket)
    }
    bucket.count += 1
    const spelling = g.service.trim()
    bucket.spellings.set(spelling, (bucket.spellings.get(spelling) ?? 0) + 1)
    const account = accountOf(g)
    bucket.accounts.set(account, (bucket.accounts.get(account) ?? 0) + 1)
  }

  const facets: ServiceFacet[] = []
  for (const [key, bucket] of buckets) {
    const service = [...bucket.spellings.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0]
    const accounts = [...bucket.accounts.entries()]
      .map(([label, count]) => ({ label, count }))
      // 没有标签的那一档垫底：它是"没分"，不是一个真实的账号。
      .sort((a, b) => {
        if (!a.label && b.label) return 1
        if (a.label && !b.label) return -1
        return b.count - a.count || a.label.localeCompare(b.label)
      })
    facets.push({ key, service, count: bucket.count, accounts })
  }
  // 条数多的服务排前面：常用的那几个一展开就在眼前。
  facets.sort((a, b) => b.count - a.count || a.service.localeCompare(b.service))
  return facets
}

export function matchesRecoveryFilter(g: RecoveryCodeGroup, filter: RecoveryFilter): boolean {
  switch (filter.kind) {
    case 'all':
      return true
    case 'lowStock':
      return g.isLowStock
    case 'review':
      return g.needsReview
    case 'service':
      if (serviceKey(g.service) !== filter.key) return false
      return filter.account === undefined || accountOf(g) === filter.account
  }
}

export function sameRecoveryFilter(a: RecoveryFilter, b: RecoveryFilter): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'service' && b.kind === 'service') return a.key === b.key && a.account === b.account
  return true
}
