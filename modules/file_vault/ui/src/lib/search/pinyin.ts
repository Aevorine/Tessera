import { PINYIN_TABLE } from './pinyinTable'

// 汉字 → 去声调读音（多音字全收）。首次用到时才展开表。
let table: Map<string, string[]> | null = null

export function readingsOf(ch: string): string[] | undefined {
  if (!table) {
    table = new Map()
    for (const group of PINYIN_TABLE.split('|')) {
      const i = group.indexOf(':')
      const syllable = group.slice(0, i)
      for (const c of group.slice(i + 1)) {
        const list = table.get(c)
        if (list) list.push(syllable)
        else table.set(c, [syllable])
      }
    }
  }
  return table.get(ch)
}

const HAN = /[㐀-䶿一-鿿]/

export function hasHan(s: string): boolean {
  return HAN.test(s)
}

/** 拼音匹配上限：只看字段前 200 个字符。 */
export const PINYIN_SCAN = 200

/**
 * 每个汉字可匹配任一读音的全拼或其前缀（首字母、半拼、全拼混用都行），其余字符逐字相等。
 * 匹配须是连续一段；返回 [start, end)，没有则 null。text、q 均已 fold。
 */
export function matchPinyin(text: string, q: string): [number, number] | null {
  const n = Math.min(text.length, PINYIN_SCAN)
  const m = q.length
  const dead = new Set<number>()

  const walk = (i: number, k: number): number => {
    if (k === m) return i
    if (i >= n) return -1
    const key = i * (m + 1) + k
    if (dead.has(key)) return -1
    const ch = text[i]
    const rs = readingsOf(ch)
    if (rs) {
      for (const syl of rs) {
        for (let len = Math.min(syl.length, m - k); len >= 1; len--) {
          if (q.startsWith(syl.slice(0, len), k)) {
            const end = walk(i + 1, k + len)
            if (end >= 0) return end
          }
        }
      }
    } else if (ch === q[k]) {
      const end = walk(i + 1, k + 1)
      if (end >= 0) return end
    }
    dead.add(key)
    return -1
  }

  for (let start = 0; start < n; start++) {
    if (!readingsOf(text[start])) continue
    const end = walk(start, 0)
    if (end >= 0) return [start, end]
  }
  return null
}
