// 查询语法：空格分词全部满足；"整句"；-排除；字段:值（也认全角冒号）。未知字段前缀按普通文本。

export interface QueryTerm {
  text: string
  /** 规范化后的字段 key；无则全字段。 */
  field?: string
  negate: boolean
  exact: boolean
}

/** 逐码点 NFKC + 小写，长度变化的字符保持原样，保证下标与原文一一对应（高亮要用）。 */
export function fold(s: string): string {
  // eslint-disable-next-line no-control-regex -- ASCII fast path.
  if (/^[\x00-\x7f]*$/.test(s)) return s.toLowerCase()
  let out = ''
  for (const c of s) {
    const n = c.normalize('NFKC').toLowerCase()
    if (n.length === c.length) out += n
    else {
      const l = c.toLowerCase()
      out += l.length === c.length ? l : c
    }
  }
  return out
}

const TOKEN = /(-?)(?:([^\s:："]+)[:：])?(?:"([^"]*)"?|(\S+))?/g

export function parseQuery(raw: string, aliases: ReadonlyMap<string, string>): QueryTerm[] {
  const terms: QueryTerm[] = []
  const src = fold(raw)
  TOKEN.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = TOKEN.exec(src))) {
    if (m[0] === '') {
      TOKEN.lastIndex++
      if (TOKEN.lastIndex > src.length) break
      continue
    }
    const [, neg, prefix, quoted, bare] = m
    const field = prefix ? aliases.get(prefix) : undefined
    let text = quoted ?? bare ?? ''
    // 未知前缀（如 http://）还原成普通文本
    if (prefix && !field) text = `${prefix}:${text}`
    text = text.trim()
    if (!text) continue
    terms.push({ text, field, negate: neg === '-', exact: quoted !== undefined })
  }
  return terms
}
