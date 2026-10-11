import { createElement, lazy, useRef, type FunctionComponent, type ReactNode } from 'react'

type PaneComponent<P> = (props: P) => ReactNode

export interface PreloadablePane<P> {
  Pane: PaneComponent<P>
  /** 提前取代码块。可重复调用，只取一次；失败后下次再取。 */
  preload: () => Promise<unknown>
}

/**
 * React.lazy 外加「取好了就同步渲染」。lazy 组件即便代码已在内存里，首次渲染也要先提交一次
 * Suspense 占位再换回来；预取完成后直接渲染真组件，切面板只有一次提交。
 * 用哪个在挂载时定死：中途从 lazy 换成真组件是两种组件类型，React 会卸载重挂、清掉面板状态。
 */
export function preloadablePane<M, P>(
  load: () => Promise<M>,
  pick: (module: M) => PaneComponent<P>,
): PreloadablePane<P> {
  // 导入和取组件分成两个参数：合在一个 `.then` 里时，属性类型会从返回值的上下文反推成 never。
  const factory = () => load().then((module) => ({ default: pick(module) as unknown as FunctionComponent<object> }))
  const Lazy: FunctionComponent<object> = lazy(factory)
  let resolved: FunctionComponent<object> | null = null
  let pending: Promise<unknown> | null = null

  function Pane(props: P) {
    const chosen = useRef(resolved ?? Lazy)
    return createElement(chosen.current, props as object)
  }

  const preload = () => {
    pending ??= factory().then(
      (module) => {
        resolved = module.default
      },
      (error: unknown) => {
        pending = null
        throw error
      },
    )
    return pending
  }

  return { Pane, preload }
}
