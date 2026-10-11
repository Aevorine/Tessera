import { useEffect, useRef, useState } from 'react'
import type { Ref } from 'react'

/**
 * 首屏元素是否还在视野里，返回 ref 与布尔值。ref 应挂在 hero 底部 1px 的空哨兵 div 上，
 * 而非 hero 本身，否则吸顶条要等整块滚出才出现。
 * 用 IntersectionObserver 而非 scroll 事件，避免高频强制同步重排；单独成文件以免破坏 Vite 快速刷新
 * （react-refresh/only-export-components）。
 */
export function useHeroOutOfView(): [Ref<HTMLDivElement>, boolean] {
  const ref = useRef<HTMLDivElement | null>(null)
  const [out, setOut] = useState(false)

  useEffect(() => {
    const node = ref.current
    if (!node || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      ([entry]) => setOut(!entry.isIntersecting),
      // rootMargin 顶部留出清理套件标签条的高度，否则哨兵被标签条盖住时
      // 仍然算"可见"，吸顶条就永远不出现。
      { rootMargin: '-56px 0px 0px 0px', threshold: 0 },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  return [ref, out]
}
