import { useMemo } from 'react'

/** 搜索框里按 ↑↓ 在结果间移动当前项，Enter 落到第一条；焦点留在框里，可以边打字边挑。 */
export function useResultCursor<K extends string | number>(
  ids: readonly K[],
  current: K | null,
  select: (id: K, index: number) => void,
) {
  return useMemo(() => {
    const step = (d: 1 | -1) => {
      if (ids.length === 0) return
      const i = current === null ? -1 : ids.indexOf(current)
      const n = i < 0 ? (d > 0 ? 0 : ids.length - 1) : Math.min(ids.length - 1, Math.max(0, i + d))
      if (n !== i) select(ids[n], n)
    }
    return {
      onArrowDown: () => step(1),
      onArrowUp: () => step(-1),
      onSubmit: () => {
        if (ids.length > 0 && (current === null || !ids.includes(current))) select(ids[0], 0)
      },
    }
  }, [ids, current, select])
}
