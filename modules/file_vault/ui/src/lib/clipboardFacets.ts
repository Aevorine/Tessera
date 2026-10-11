import type { ClipboardContentType, ClipboardEntry } from '@/shared/ipcTypes'

/**
 * 剪贴板分类下的子分类（链接按域名/来源应用，代码按语言等）。
 * 全部从数据算出，不让用户手工维护（被动采集，无人会逐条打标签）；只列有条目的值。
 * 纯函数，不碰 React。
 */

export type ClipFacetDim = 'domain' | 'lang' | 'app' | 'length' | 'day'

/** 每种内容类型能往下分的维度，按常用程度排。 */
export const FACET_DIMS: Record<ClipboardContentType, ClipFacetDim[]> = {
  text: ['app', 'length', 'day'],
  url: ['domain', 'app', 'day'],
  email: ['domain', 'app', 'day'],
  phone: ['app', 'day'],
  formula: ['app', 'day'],
  code: ['lang', 'app', 'day'],
  name: ['app', 'day'],
  image: ['app', 'day'],
}

/** 当前选中的分类路径。type 为 'all' 时 dim/value 无意义。 */
export interface ClipCategoryPath {
  type: ClipboardContentType | 'all'
  dim?: ClipFacetDim
  value?: string
}

export const ALL_CATEGORIES: ClipCategoryPath = { type: 'all' }

/** 长度分档的键。值是给人看的顺序。 */
export const LENGTH_BUCKETS = ['short', 'medium', 'long'] as const
/** 时间分档的键。 */
export const DAY_BUCKETS = ['today', 'yesterday', 'week', 'month', 'older'] as const

/** 「未知」这一档的键：来源应用没记下来、链接解析不出域名、认不出的代码语言。 */
export const UNKNOWN_FACET = '__unknown__'

function hostOf(text: string): string | null {
  const trimmed = text.trim()
  // 没带协议的「github.com/foo」也常见，补一个再解析。
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    const host = new URL(candidate).hostname.toLowerCase()
    return host.startsWith('www.') ? host.slice(4) : host || null
  } catch {
    return null
  }
}

function emailDomainOf(text: string): string | null {
  const match = /@([a-z0-9.-]+\.[a-z]{2,})/i.exec(text)
  return match ? match[1].toLowerCase() : null
}

/**
 * 认代码语言：只用特征最强的规则，越具体越先（TypeScript 在 JavaScript 前，JSON 必须真能解析）。
 * 认不出归「其他」，宁缺毋错，认错会让按语言找不到。
 */
export function detectCodeLanguage(text: string): string | null {
  const src = text.trim()
  if (!src) return null
  if (/^[[{]/.test(src)) {
    try {
      JSON.parse(src)
      return 'JSON'
    } catch {
      // 不是 JSON，继续往下认
    }
  }
  if (/^<(!doctype|html|div|span|svg|template|\?xml)/i.test(src) || /<\/[a-z][a-z0-9-]*>\s*$/i.test(src)) {
    return /^<\?xml/i.test(src) ? 'XML' : 'HTML'
  }
  if (/^\s*(SELECT|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|CREATE\s+(TABLE|INDEX|VIEW)|ALTER\s+TABLE|WITH\s+\w+\s+AS)\b/im.test(src)) {
    return 'SQL'
  }
  if (/^#include\s*[<"]|\bstd::|\bint\s+main\s*\(/m.test(src)) return 'C/C++'
  if (/^package\s+\w+\s*$|^func\s+(\(\w+\s+\*?\w+\)\s*)?\w+\(|:=\s/m.test(src) && /\bfunc\b|^package\b/m.test(src)) return 'Go'
  if (/\bfn\s+\w+\s*\(|\blet\s+mut\s|\bimpl\s+\w+|println!\(/.test(src)) return 'Rust'
  if (/^\s*(def\s+\w+\s*\(|class\s+\w+(\(.*\))?:|from\s+[\w.]+\s+import\s|import\s+\w+(\s+as\s+\w+)?\s*$|if\s+__name__\s*==)/m.test(src)) {
    return 'Python'
  }
  if (/\bpublic\s+(static\s+)?(class|void|int|String)\b|System\.out\.|using\s+System;/.test(src)) return 'Java/C#'
  // 分成两条：声明只认行首，类型标注可在任意位置。写成一条正则时 `^` 只管得到第一个分支，
  // 读的人和扫描器都分不清那是有意还是漏了。
  const declaresType = /^\s*(interface\s+\w+|type\s+\w+\s*=|enum\s+\w+\s*\{)/m.test(src)
  const annotatesType = /:\s*(string|number|boolean)\b/.test(src)
  if (declaresType || annotatesType) return 'TypeScript'
  if (/\b(const|let|var)\s+\w+\s*=|=>|\bfunction\s*\w*\s*\(|\bexport\s+(default\s+)?|\bimport\s+.*\s+from\s+['"]|console\.log\(/.test(src)) {
    return 'JavaScript'
  }
  if (/^\s*\$\w+\s*=|\b(Get|Set|New|Remove|Write)-[A-Z]\w+/m.test(src)) return 'PowerShell'
  if (/^#!\/(usr\/)?bin\/(env\s+)?(ba|z)?sh(?:\s|$)|^\s*(sudo|apt(-get)?|brew|npm|pnpm|yarn|pip|git|cd|ls|echo|export|curl|wget)\s/m.test(src)) {
    return 'Shell'
  }
  if (/[.#]?[\w-]+\s*\{[^{}]*:[^{}]*;[^{}]*\}/.test(src)) return 'CSS'
  return null
}

function lengthBucket(text: string): (typeof LENGTH_BUCKETS)[number] {
  const n = text.length
  if (n < 60) return 'short'
  if (n < 600) return 'medium'
  return 'long'
}

function startOfDay(ms: number): number {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function dayBucket(createdAt: string, now: number): (typeof DAY_BUCKETS)[number] {
  const at = Date.parse(createdAt.replace(' ', 'T'))
  if (Number.isNaN(at)) return 'older'
  const today = startOfDay(now)
  const DAY = 86_400_000
  if (at >= today) return 'today'
  if (at >= today - DAY) return 'yesterday'
  if (at >= today - 6 * DAY) return 'week'
  if (at >= today - 29 * DAY) return 'month'
  return 'older'
}

/** 某条记录在某个维度上的取值；取不到就是 UNKNOWN_FACET。 */
export function facetValue(entry: ClipboardEntry, dim: ClipFacetDim, now: number = Date.now()): string {
  const text = entry.content_text ?? ''
  switch (dim) {
    case 'domain':
      return (entry.content_type === 'email' ? emailDomainOf(text) : hostOf(text)) ?? UNKNOWN_FACET
    case 'lang':
      return detectCodeLanguage(text) ?? UNKNOWN_FACET
    case 'app': {
      const app = (entry.source_app ?? '').trim()
      // 进程名常带 .exe，同一个应用在菜单里出现成两条不同的值就是这个原因。
      return app ? app.replace(/\.exe$/i, '') : UNKNOWN_FACET
    }
    case 'length':
      return lengthBucket(text)
    case 'day':
      return dayBucket(entry.created_at, now)
  }
}

export function matchesCategory(entry: ClipboardEntry, path: ClipCategoryPath, now: number = Date.now()): boolean {
  if (path.type === 'all') return true
  if (entry.content_type !== path.type) return false
  if (!path.dim || path.value === undefined) return true
  return facetValue(entry, path.dim, now) === path.value
}

export interface FacetValueCount {
  value: string
  count: number
}

export interface TypeFacets {
  count: number
  dims: Array<{ dim: ClipFacetDim; values: FacetValueCount[] }>
}

/** 单个维度最多列多少个值。再多菜单就成了一面墙；过滤框能搜到更多。 */
const MAX_VALUES_PER_DIM = 80

/** 按「类型 → 维度 → 值」计数；长度和时间按自然顺序，其余按条数降序，「未知」垫底。 */
export function buildFacets(entries: ClipboardEntry[], now: number = Date.now()): Record<ClipboardContentType, TypeFacets> {
  const counters = new Map<ClipboardContentType, { count: number; dims: Map<ClipFacetDim, Map<string, number>> }>()
  for (const entry of entries) {
    const type = entry.content_type
    let bucket = counters.get(type)
    if (!bucket) {
      bucket = { count: 0, dims: new Map() }
      counters.set(type, bucket)
    }
    bucket.count += 1
    for (const dim of FACET_DIMS[type] ?? []) {
      let values = bucket.dims.get(dim)
      if (!values) {
        values = new Map()
        bucket.dims.set(dim, values)
      }
      const value = facetValue(entry, dim, now)
      values.set(value, (values.get(value) ?? 0) + 1)
    }
  }

  const result = {} as Record<ClipboardContentType, TypeFacets>
  for (const type of Object.keys(FACET_DIMS) as ClipboardContentType[]) {
    const bucket = counters.get(type)
    if (!bucket) {
      result[type] = { count: 0, dims: [] }
      continue
    }
    const dims: TypeFacets['dims'] = []
    for (const dim of FACET_DIMS[type]) {
      const values = bucket.dims.get(dim)
      if (!values || values.size === 0) continue
      let list = [...values.entries()].map(([value, count]) => ({ value, count }))
      if (dim === 'length' || dim === 'day') {
        const order: readonly string[] = dim === 'length' ? LENGTH_BUCKETS : DAY_BUCKETS
        list.sort((a, b) => order.indexOf(a.value) - order.indexOf(b.value))
      } else {
        list.sort((a, b) => {
          if (a.value === UNKNOWN_FACET) return 1
          if (b.value === UNKNOWN_FACET) return -1
          return b.count - a.count || a.value.localeCompare(b.value)
        })
        list = list.slice(0, MAX_VALUES_PER_DIM)
      }
      // 一个维度只有「未知」一个值时，这一层分了等于没分，不列出来。
      if (list.length === 1 && list[0].value === UNKNOWN_FACET) continue
      dims.push({ dim, values: list })
    }
    result[type] = { count: bucket.count, dims }
  }
  return result
}
