import { createContext, useContext, useSyncExternalStore } from 'react'

/**
 * 用户关掉的界面内容（侧边栏入口、各页面的分区）。关掉 = 不再渲染，直到在 设置 › 外观 ›「已关闭的内容」
 * 里恢复。一个存储、一套订阅：侧边栏、各页面、设置页同时读它，恢复后各处立即重新出现，不用重启。
 *
 * 键：
 * - `nav:<pane>`          侧边栏入口
 * - `section:<pane>:<id>` 页面分区；id 优先用分区自己的 storageKey / closeKey，没有才用标题文字
 * 同时记下关掉时的显示名，恢复列表里能看懂是什么。
 * localStorage 是不可信输入：读不懂就当「什么都没关」，绝不能让外壳因为它抛异常。
 */

export interface HiddenEntry {
  label: string
  /** 所在页面（侧边栏入口为空）；恢复列表按它分组显示。 */
  pane: string
  at: number
}

type HiddenMap = Record<string, HiddenEntry>

const STORAGE_KEY = 'tessera-hidden-content-v1'
const EMPTY: HiddenMap = Object.freeze({}) as HiddenMap

let cache: HiddenMap | null = null
const listeners = new Set<() => void>()

function read(): HiddenMap {
  if (cache) return cache
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    const out: HiddenMap = {}
    if (parsed && typeof parsed === 'object') {
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof k !== 'string' || !v || typeof v !== 'object') continue
        const e = v as Partial<HiddenEntry>
        out[k] = {
          label: typeof e.label === 'string' ? e.label : k,
          pane: typeof e.pane === 'string' ? e.pane : '',
          at: typeof e.at === 'number' ? e.at : 0,
        }
      }
    }
    cache = Object.keys(out).length ? out : EMPTY
  } catch {
    cache = EMPTY
  }
  return cache
}

function write(next: HiddenMap) {
  cache = Object.keys(next).length ? next : EMPTY
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cache))
  } catch {
    // 配额 / 隐私模式：本次会话内仍然生效，只是下次不记得。
  }
  listeners.forEach((l) => l())
}

export function hideContent(key: string, label: string, pane = ''): void {
  if (!key) return
  write({ ...read(), [key]: { label, pane, at: Date.now() } })
}

export function restoreContent(keys: readonly string[]): void {
  const cur = { ...read() }
  let changed = false
  for (const k of keys) {
    if (k in cur) {
      delete cur[k]
      changed = true
    }
  }
  if (changed) write(cur)
}

export function restoreAllContent(): void {
  write({})
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  // 另一个窗口（多开、开发者工具）改了也跟上。
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) {
      cache = null
      listener()
    }
  }
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', onStorage)
  }
}

/** 订阅整张表；返回值引用只在变化时更新，可直接做依赖。 */
export function useHiddenContent(): HiddenMap {
  return useSyncExternalStore(subscribe, read, () => EMPTY)
}

/** 当前页面 id，供分区拼稳定的关闭键。AppShell 在内容区外层提供。 */
export const PaneContext = createContext<string>('')

export function usePaneId(): string {
  return useContext(PaneContext)
}

export function sectionKey(pane: string, id: string): string {
  return `section:${pane}:${id}`
}

export function navKey(pane: string): string {
  return `nav:${pane}`
}
