/**
 * 笔记分类的显示偏好（隐藏、改名、图标、排序），放渲染层用 localStorage 持久化。
 * 下拉选项由硬编码预设、用户建的、已被笔记用到的合并而来，预设每次渲染都会合并回来，
 * 所以需要这一层才能让"删除预设"生效；真分类的增删改走后端，不归这里管。
 */

/** 可选的图标名。用名字而不是组件，是为了能序列化进 localStorage。 */
export const CATEGORY_ICON_NAMES = [
  'Folder',
  'Briefcase',
  'Home',
  'GraduationCap',
  'IdCard',
  'Wrench',
  'Contact2',
  'Volleyball',
  'Palette',
  'Globe',
  'Hexagon',
  'Landmark',
  'Radio',
  'Wallet',
  'Lock',
  'Star',
  'Heart',
  'Tag',
  'BookOpen',
  'Code',
  'Camera',
  'Music',
  'MoreHorizontal',
] as const

export type CategoryIconName = (typeof CATEGORY_ICON_NAMES)[number]

/**
 * 分类排序模式。只有 `custom` 用 `order`；切到其他模式不清除它，
 * 自动排序只是临时换角度，不能毁掉用户手排的结果。
 */
export const CATEGORY_SORT_MODES = ['custom', 'name', 'count', 'recent'] as const
export type CategorySortMode = (typeof CATEGORY_SORT_MODES)[number]

/** 每个分类的统计量，由调用方从笔记列表里算出来喂进来。 */
export interface CategoryStat {
  /** 这个分类（含其所有子分类）下的笔记数。 */
  count: number
  /** 该分类下最近一次更新的时间戳（毫秒）。没有笔记就是 0。 */
  updatedAt: number
}

export interface CategoryPrefs {
  /** 用户主动从下拉里删掉的预设名。真分类不走这里，走后端删除。 */
  hidden: string[]
  /** 手动排序。只列出被拖动过的，其余按原有顺序跟在后面。 */
  order: string[]
  /** 改过的显示名：原名 → 新显示名。 */
  labels: Record<string, string>
  /** 改过的图标：分类名 → 图标名。 */
  icons: Record<string, CategoryIconName>
  /** 排序方式。老的持久化内容里没有这个字段，读出来按 custom 处理——
   *  那正是加这个功能之前的行为（有 order 就按 order，没有就按名称）。 */
  sortMode: CategorySortMode
}

const STORAGE_KEY = 'ideal1-note-category-prefs'

const EMPTY: CategoryPrefs = { hidden: [], order: [], labels: {}, icons: {}, sortMode: 'custom' }

function isSortMode(v: unknown): v is CategorySortMode {
  return typeof v === 'string' && (CATEGORY_SORT_MODES as readonly string[]).includes(v)
}

function isIconName(v: unknown): v is CategoryIconName {
  return typeof v === 'string' && (CATEGORY_ICON_NAMES as readonly string[]).includes(v)
}

/** 读偏好。损坏的持久化内容按"没设过"处理，不让一段坏 JSON 把笔记界面整个卡住。 */
export function loadCategoryPrefs(): CategoryPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...EMPTY }
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return { ...EMPTY }
    const p = parsed as Record<string, unknown>

    const strings = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []

    const labels: Record<string, string> = {}
    if (typeof p.labels === 'object' && p.labels !== null) {
      for (const [k, v] of Object.entries(p.labels as Record<string, unknown>)) {
        if (typeof v === 'string' && v.trim()) labels[k] = v.trim()
      }
    }
    const icons: Record<string, CategoryIconName> = {}
    if (typeof p.icons === 'object' && p.icons !== null) {
      for (const [k, v] of Object.entries(p.icons as Record<string, unknown>)) {
        if (isIconName(v)) icons[k] = v
      }
    }
    return {
      hidden: strings(p.hidden),
      order: strings(p.order),
      labels,
      icons,
      sortMode: isSortMode(p.sortMode) ? p.sortMode : 'custom',
    }
  } catch {
    return { ...EMPTY }
  }
}

export function saveCategoryPrefs(prefs: CategoryPrefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs))
  } catch {
    // 存储满了或被禁用。偏好丢了只是回到默认显示，不该让操作本身失败。
  }
}

/**
 * 造分类名的比较函数，分类树每一层都用它。stats 的键是分类全路径；
 * 缺项视为没有笔记（排在有内容的后面，而不是随机位置）。
 */
export function makeCategoryComparator(
  prefs: CategoryPrefs,
  stats?: Map<string, CategoryStat>,
): (a: string, b: string) => number {
  const byName = (a: string, b: string) => a.localeCompare(b)
  if (prefs.sortMode === 'name') return byName
  if (prefs.sortMode === 'count' || prefs.sortMode === 'recent') {
    const key = prefs.sortMode === 'count' ? 'count' : 'updatedAt'
    return (a, b) => {
      const va = stats?.get(a)?.[key] ?? 0
      const vb = stats?.get(b)?.[key] ?? 0
      // 都从大到小：笔记多的、最近动过的排前面。数字一样时按名称，
      // 保证顺序是确定的——否则同为 0 的一堆预设分类每次渲染都可能换位置。
      return vb - va || byName(a, b)
    }
  }
  // custom：拖过的按拖的顺序在前，没拖过的按名称跟在后面。
  const rank = new Map(prefs.order.map((n, i) => [n, i] as const))
  return (a, b) => {
    const ra = rank.get(a)
    const rb = rank.get(b)
    if (ra !== undefined && rb !== undefined) return ra - rb
    if (ra !== undefined) return -1
    if (rb !== undefined) return 1
    return byName(a, b)
  }
}

/** 把偏好应用到分类名列表：先滤掉隐藏的，再按当前排序方式排。 */
export function applyCategoryPrefs(
  names: string[],
  prefs: CategoryPrefs,
  stats?: Map<string, CategoryStat>,
): string[] {
  const hidden = new Set(prefs.hidden)
  // 只隐藏顶层名字完全匹配的。子分类（`工作/项目A`）跟着它的顶层一起消失，
  // 否则会出现"父分类没了、子分类还孤零零挂在列表里"。
  const visible = names.filter((n) => !hidden.has(n) && !hidden.has(n.split('/')[0]))
  return visible.slice().sort(makeCategoryComparator(prefs, stats))
}

/** 取显示名。没改过就用原名。 */
export function displayLabel(name: string, prefs: CategoryPrefs): string {
  return prefs.labels[name] ?? name
}

/** 在 order 里把某一项往前/往后挪一格，返回新的 order。 */
export function moveInOrder(all: string[], name: string, delta: -1 | 1): string[] {
  const list = all.slice()
  const i = list.indexOf(name)
  if (i < 0) return list
  const j = i + delta
  if (j < 0 || j >= list.length) return list
  ;[list[i], list[j]] = [list[j], list[i]]
  return list
}
