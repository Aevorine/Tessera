import { useDeferredValue, useMemo } from 'react'
import type { Range, Searcher } from './engine'

export interface SmartSearchState<T> {
  /** 有有效查询。 */
  active: boolean
  /** 无查询时原样返回 items。 */
  items: readonly T[]
  approximate: boolean
  /** 输入还没算完（延迟渲染中）。 */
  pending: boolean
  ranges: (item: T, field: string) => Range[] | undefined
}

const none = () => undefined

/** 输入用 useDeferredValue 让打字不卡，大列表在空闲时算。 */
export function useSmartSearch<T>(items: readonly T[], searcher: Searcher<T & object>, query: string): SmartSearchState<T> {
  const deferred = useDeferredValue(query)
  const result = useMemo(() => searcher.search(items as readonly (T & object)[], deferred), [items, searcher, deferred])
  return useMemo(
    () =>
      result
        ? {
            active: true,
            items: result.items,
            approximate: result.approximate,
            pending: query !== deferred,
            ranges: result.ranges as (item: T, field: string) => Range[] | undefined,
          }
        : { active: false, items, approximate: false, pending: query !== deferred, ranges: none },
    [result, items, query, deferred],
  )
}
