import { useCallback, useRef, useState } from 'react'

/** 功能格 → 全屏面板的状态：当前面板、展开圆心（相对 rootRef 元素）、开 / 关。 */
export function useFeaturePanel<T extends string>() {
  const rootRef = useRef<HTMLDivElement>(null)
  const [panel, setPanel] = useState<T | null>(null)
  const [origin, setOrigin] = useState<{ x: number; y: number } | null>(null)

  const open = useCallback((id: T, el?: HTMLElement | null) => {
    const root = rootRef.current
    if (root && el) {
      const r = el.getBoundingClientRect()
      const b = root.getBoundingClientRect()
      setOrigin({ x: r.left - b.left + r.width / 2, y: r.top - b.top + r.height / 2 })
    } else {
      setOrigin(null)
    }
    setPanel(id)
  }, [])
  const close = useCallback(() => setPanel(null), [])

  return { rootRef, panel, origin, open, close }
}
