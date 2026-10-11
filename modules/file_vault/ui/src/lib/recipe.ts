/**
 * 剪贴板「配方」：带 `{{名称}}` 填空位的片段，用时逐个填、填完再复制。
 *
 * 用双花括号是因为单花括号在 JSON/CSS/模板字符串里太常见，会凭空多出空位。
 * 刻意不做转义：要存字面 `{{x}}` 就当普通片段存（配方与片段是同一张表的同类记录）。
 */

/** `{{名称}}`。名称里不允许出现花括号，其余字符（含空格、中文）都行。 */
const PLACEHOLDER_RE = /\{\{([^{}]+)\}\}/g

/** 按出现顺序列出空位名并去重（同名只填一次）。 */
export function extractPlaceholders(text: string): string[] {
  const seen = new Set<string>()
  const names: string[] = []
  for (const match of text.matchAll(PLACEHOLDER_RE)) {
    const name = match[1].trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    names.push(name)
  }
  return names
}

export function isRecipe(text: string | null | undefined): boolean {
  return !!text && extractPlaceholders(text).length > 0
}

/** 把空位换成填好的值；没填的空位原样保留，避免悄悄少一段话而不被发现。 */
export function fillRecipe(text: string, values: Record<string, string>): string {
  return text.replace(PLACEHOLDER_RE, (whole, rawName: string) => {
    const name = rawName.trim()
    const value = values[name]
    return value === undefined || value === '' ? whole : value
  })
}

/** 把几条剪贴板记录用空行拼成配方草稿（单换行会让各段糊在一起）。 */
export function composeRecipeDraft(texts: Array<string | null | undefined>): string {
  return texts
    .map((t) => (t ?? '').trim())
    .filter((t) => t.length > 0)
    .join('\n\n')
}
