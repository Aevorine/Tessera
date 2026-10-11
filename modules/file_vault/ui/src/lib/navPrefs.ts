import type { Pane } from '@/components/AppShell'

/**
 * 侧边栏「常用」区偏好：哪些功能置顶、什么顺序（13 个入口平铺，位置记不住）。
 * 净化规则同 appearancePreferences.ts：localStorage 是不可信输入（可被 DevTools、扩展、旧格式污染），
 * 读不懂必须安全退回默认，侧边栏抛异常会让整个应用起不来。
 */

/** 可放进「常用」的面板，只列侧边栏真实存在的入口；清理套件子标签在侧边栏合并成 'pcclean'，放进来会造出高亮不到行的幽灵条目。 */
export const FAVORITABLE_PANES = [
  'files',
  'clipboard',
  'crossdevice',
  'passwords',
  'recoverycodes',
  'notes',
  'ai',
  'network',
  'pcclean',
  'filemanager',
  'settings',
  'diagnostics',
  'help',
] as const

export type FavoritablePane = (typeof FAVORITABLE_PANES)[number]

/** 编译期护栏：上面每个字符串都必须是真实 `Pane`；`import type` 会被擦除，不造成 AppShell ↔ navPrefs 运行时循环依赖。 */
const _PANES_MUST_EXIST: readonly Pane[] = FAVORITABLE_PANES
void _PANES_MUST_EXIST

/**
 * 默认常用集合为空：「常用」的价值在于用户自己挑，预置猜测只会占顶部位置制造噪音。
 * 一条都没收藏时整块不渲染（见 AppShell.tsx）；FAVORITABLE_PANES 的四项仍可手动收藏。
 */
export const DEFAULT_FAVORITE_PANES: FavoritablePane[] = []

export interface NavPreferences {
  /** 有序。顺序就是「常用」区里从上到下的显示顺序。 */
  favorites: FavoritablePane[]
}

const STORAGE_KEY = 'ideal1-nav-preferences-v1'

function isFavoritablePane(value: unknown): value is FavoritablePane {
  return typeof value === 'string' && (FAVORITABLE_PANES as readonly string[]).includes(value)
}

function cloneDefaults(): NavPreferences {
  return { favorites: [...DEFAULT_FAVORITE_PANES] }
}

/**
 * 把持久化的（不可信）JSON 收敛成可渲染形状：丢掉未知面板名、重复项只留首个、
 * 整体非对象或 favorites 非数组则退回默认。
 * 空数组合法、不退回默认（"一个都不置顶"是真实选择，否则移出最后一项会长出四个默认项）；
 * 以 favorites 键在不在来区分。
 */
export function normalizeNavPreferences(value: unknown): NavPreferences {
  if (typeof value !== 'object' || value === null) return cloneDefaults()
  const candidate = value as Record<string, unknown>
  if (!Array.isArray(candidate.favorites)) return cloneDefaults()
  const seen = new Set<FavoritablePane>()
  const favorites: FavoritablePane[] = []
  for (const entry of candidate.favorites) {
    if (!isFavoritablePane(entry) || seen.has(entry)) continue
    seen.add(entry)
    favorites.push(entry)
  }
  return { favorites }
}

export function loadNavPreferences(
  storage: Pick<Storage, 'getItem'> = localStorage,
): NavPreferences {
  try {
    const raw = storage.getItem(STORAGE_KEY)
    return raw ? normalizeNavPreferences(JSON.parse(raw)) : cloneDefaults()
  } catch {
    // 存脏了（JSON 解析失败、隐私模式下 getItem 直接抛）一样只是"没有偏好"。
    return cloneDefaults()
  }
}

export function saveNavPreferences(
  preferences: NavPreferences,
  storage: Pick<Storage, 'setItem'> = localStorage,
): void {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(normalizeNavPreferences(preferences)))
  } catch {
    // 导航偏好是可选状态。配额/隐私模式的报错绝不能挡住应用本身。
  }
}

/** 把某一项移到常用区末尾（已经在里面就原样返回同一个数组引用）。 */
export function addFavorite(favorites: FavoritablePane[], pane: FavoritablePane): FavoritablePane[] {
  return favorites.includes(pane) ? favorites : [...favorites, pane]
}

/** 从常用区移出（不在里面就原样返回同一个数组引用）。 */
export function removeFavorite(favorites: FavoritablePane[], pane: FavoritablePane): FavoritablePane[] {
  return favorites.includes(pane) ? favorites.filter((p) => p !== pane) : favorites
}

/** 把 `pane` 挪到 `target` 现在的位置，拖拽与键盘排序共用；任一端找不到则原样返回。 */
export function moveFavorite(
  favorites: FavoritablePane[],
  pane: FavoritablePane,
  target: FavoritablePane,
): FavoritablePane[] {
  const from = favorites.indexOf(pane)
  const to = favorites.indexOf(target)
  if (from === -1 || to === -1 || from === to) return favorites
  const next = [...favorites]
  next.splice(from, 1)
  next.splice(to, 0, pane)
  return next
}
