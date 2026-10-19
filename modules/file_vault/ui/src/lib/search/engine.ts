import { hasHan, matchPinyin, PINYIN_SCAN } from './pinyin'
import { fold, parseQuery, type QueryTerm } from './query'

export type Range = [number, number]

export interface SearchField<T> {
  key: string
  get: (item: T) => string | null | undefined
  /** 命中分乘数，默认 1。 */
  weight?: number
  /** 字段前缀别名（如 site、网站），用于 `别名:值`。 */
  aliases?: string[]
}

export interface SearchResult<T> {
  /** 按命中质量排序后的条目。 */
  items: T[]
  /** 结果全来自错字/跳字容忍。 */
  approximate: boolean
  ranges: (item: T, field: string) => Range[] | undefined
  score: (item: T) => number
}

export interface Searcher<T> {
  fields: readonly SearchField<T>[]
  aliases: ReadonlyMap<string, string>
  /** 空查询返回 null（调用方保持原顺序原列表）。 */
  search: (items: readonly T[], query: string) => SearchResult<T> | null
}

// 命中等级分
const S_EXACT = 100
const S_PREFIX = 80
const S_WORD = 70
const S_SUB = 50
const S_PINYIN = 40
const S_TYPO = 25
const S_SEQ = 15
/** 错字 / 跳字只看字段前这么多字符。 */
const FUZZY_SCAN = 300

interface Match {
  score: number
  ranges: Range[]
}

const isWordChar = (c: string | undefined) => !!c && /[\p{L}\p{N}]/u.test(c) && !/[㐀-鿿]/.test(c)

function strictMatch(f: string, t: string, exact: boolean): Match | null {
  if (f === t) return { score: S_EXACT, ranges: [[0, f.length]] }
  if (f.startsWith(t)) return { score: S_PREFIX, ranges: [[0, t.length]] }
  let idx = f.indexOf(t)
  if (idx >= 0) {
    const first = idx
    while (idx >= 0) {
      if (!isWordChar(f[idx - 1])) return { score: S_WORD, ranges: [[idx, idx + t.length]] }
      idx = f.indexOf(t, idx + 1)
    }
    return { score: S_SUB, ranges: [[first, first + t.length]] }
  }
  if (!exact && /^[a-z]+$/.test(t) && hasHan(f.slice(0, PINYIN_SCAN))) {
    const r = matchPinyin(f, t)
    if (r) return { score: S_PINYIN, ranges: [r] }
  }
  return null
}

/** Damerau-Levenshtein ≤ 1。 */
function withinOneEdit(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  if (i === a.length && i === b.length) return true
  const ra = a.slice(i + 1)
  const rb = b.slice(i + 1)
  if (a.length === b.length) return ra === rb || (a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2))
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1)
}

function fuzzyMatch(f: string, t: string): Match | null {
  const head = f.slice(0, FUZZY_SCAN)
  if (t.length >= 5) {
    const words = /[\p{L}\p{N}]+/gu
    let w: RegExpExecArray | null
    while ((w = words.exec(head))) {
      if (withinOneEdit(w[0], t)) return { score: S_TYPO, ranges: [[w.index, w.index + w[0].length]] }
    }
  }
  if (t.length >= 3) {
    const span = t.length * 3
    let start = head.indexOf(t[0])
    let tries = 0
    while (start >= 0 && tries++ < 50) {
      const ranges: Range[] = []
      let k = 0
      let i = start
      for (; i < head.length && i - start < span && k < t.length; i++) {
        if (head[i] !== t[k]) continue
        const last = ranges[ranges.length - 1]
        if (last && last[1] === i) last[1] = i + 1
        else ranges.push([i, i + 1])
        k++
      }
      if (k === t.length) return { score: S_SEQ, ranges }
      start = head.indexOf(t[0], start + 1)
    }
  }
  return null
}

/** 每个条目的字段 fold 结果按对象缓存；条目是不可变 state，换对象即失效。 */
type Folded = (string | null)[]

export function createSearcher<T extends object>(fields: SearchField<T>[]): Searcher<T> {
  const aliases = new Map<string, string>()
  for (const f of fields) {
    aliases.set(fold(f.key), f.key)
    for (const a of f.aliases ?? []) aliases.set(fold(a), f.key)
  }
  const cache = new WeakMap<T, Folded>()
  const folded = (item: T): Folded => {
    let v = cache.get(item)
    if (!v) {
      v = fields.map((f) => {
        const s = f.get(item)
        return s ? fold(s) : null
      })
      cache.set(item, v)
    }
    return v
  }

  const run = (items: readonly T[], terms: QueryTerm[], fuzzy: boolean) => {
    const out: { item: T; score: number; index: number; ranges: Map<string, Range[]> }[] = []
    items.forEach((item, index) => {
      const vals = folded(item)
      let total = 0
      const ranges = new Map<string, Range[]>()
      for (const term of terms) {
        let best = 0
        for (let fi = 0; fi < fields.length; fi++) {
          const field = fields[fi]
          if (term.field && term.field !== field.key) continue
          const v = vals[fi]
          if (!v) continue
          const m = strictMatch(v, term.text, term.exact) ?? (fuzzy && !term.exact && !term.negate ? fuzzyMatch(v, term.text) : null)
          if (!m) continue
          if (term.negate) return
          best = Math.max(best, m.score * (field.weight ?? 1))
          const list = ranges.get(field.key)
          if (list) list.push(...m.ranges)
          else ranges.set(field.key, [...m.ranges])
        }
        if (!term.negate && best === 0) return
        total += best
      }
      out.push({ item, score: total, index, ranges })
    })
    out.sort((a, b) => b.score - a.score || a.index - b.index)
    return out
  }

  return {
    fields,
    aliases,
    search(items, query) {
      const terms = parseQuery(query, aliases)
      if (!terms.length) return null
      let rows = run(items, terms, false)
      let approximate = false
      // 精确层一个都没有，再放开错字 / 跳字
      if (!rows.length && terms.some((t) => !t.negate && !t.exact)) {
        rows = run(items, terms, true)
        approximate = rows.length > 0
      }
      const byItem = new Map(rows.map((r) => [r.item, r]))
      return {
        items: rows.map((r) => r.item),
        approximate,
        ranges: (item, field) => byItem.get(item)?.ranges.get(field),
        score: (item) => byItem.get(item)?.score ?? 0,
      }
    },
  }
}
