import { useEffect, useState } from 'react'

export interface WindowActivation {
  /** 窗口此刻对用户可见（没藏进托盘、没最小化、没被完全挡住）。 */
  visible: boolean
  /** 每从"看不见"变成"看得见"一次就加一。用它当"用户又回来了"的信号。 */
  generation: number
}

function isVisibleNow(): boolean {
  return typeof document === 'undefined' || document.visibilityState === 'visible'
}

/**
 * 主窗口藏进托盘、最小化或静默启动时 Electron 报 visibilityState 为 hidden。
 * 「只在用户看得见时做」（如弹 Windows Hello）靠它判断，「每次回来都重做」靠 generation。
 */
export function useWindowActivation(): WindowActivation {
  const [state, setState] = useState<WindowActivation>(() => ({ visible: isVisibleNow(), generation: 0 }))

  useEffect(() => {
    const sync = () => {
      const visible = isVisibleNow()
      setState((prev) => {
        if (prev.visible === visible) return prev
        return { visible, generation: visible ? prev.generation + 1 : prev.generation }
      })
    }
    document.addEventListener('visibilitychange', sync)
    window.addEventListener('focus', sync)
    sync()
    return () => {
      document.removeEventListener('visibilitychange', sync)
      window.removeEventListener('focus', sync)
    }
  }, [])

  return state
}
