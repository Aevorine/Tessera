// 把 Markdown 切成可分别渲染、按序拼回的块：渲染耗时随篇幅增长（4MB 约 1402ms），先渲首块可让首屏到毫秒级。
// 难点在切哪里：围栏代码块内空行、松散列表项间空行、引用块都跨行，在其中切开会静默渲染错误。
// 所以宁可不切，只在确认安全处切，最坏退化成整篇一块（即改动前行为）。

/** 一块的目标大小。48KB 按实测的 ~0.00036 ms/字符算约 17ms，一块的渲染不会卡住后续块。 */
const DEFAULT_TARGET_CHARS = 48 * 1024

/** 链接引用定义总量超过这个就不再往每块里补（正常文档远到不了）。 */
const MAX_LINK_DEFINITION_CHARS = 8 * 1024

/** ```` ``` ```` 或 `~~~` 围栏。捕获缩进与围栏本身，用来判断配对。 */
const FENCE_PATTERN = /^(\s{0,3})(`{3,}|~{3,})(.*)$/

/** 是否为"上一个块的续行"：空行后跟列表标记、引用标记或缩进，空行多半在块内部（松散列表、引用、缩进代码），不可切。 */
function continuesPreviousBlock(line: string): boolean {
  if (/^(\s{2,}|\t)/.test(line)) return true // 缩进续行 / 缩进代码块
  if (/^\s*([-*+]|\d+[.)])(\s|$)/.test(line)) return true // 列表项
  if (/^\s*>/.test(line)) return true // 引用块
  if (/^\s*(\||:?-{3,}:?\s*\|)/.test(line)) return true // 表格行
  if (/^\s*(=+|-{2,})\s*$/.test(line)) return true // setext 下划线
  return false
}

/**
 * 收集全篇链接引用定义（`[label]: url "title"`）。定义可在任意位置，分块后第 9 块的定义
 * 对第 1 块的引用会静默变成纯文本；所以每块渲染时把全篇定义补在末尾（本身不产出 HTML，重复取第一个）。
 */
export function collectLinkDefinitions(source: string): string {
  const found: string[] = []
  let total = 0
  for (const line of source.split('\n')) {
    if (!/^\s{0,3}\[[^\]]+\]:\s*\S/.test(line)) continue
    total += line.length + 1
    if (total > MAX_LINK_DEFINITION_CHARS) break
    found.push(line)
  }
  return found.join('\n')
}

/**
 * 切块，各块按序拼回等于原文（守卫测试钉住）。只在同时满足下列条件的空行处切：
 * 不在围栏代码块内；当前块已够 targetChars；下一个非空行不是续行（continuesPreviousBlock）。
 * 切不出来时返回 `[source]`，即退回整篇渲染，功能不变只是不提速。
 */
export function splitMarkdownForStreaming(
  source: string,
  targetChars: number = DEFAULT_TARGET_CHARS,
): string[] {
  if (source.length <= targetChars) return [source]

  const lines = source.split('\n')
  const chunks: string[] = []
  let current: string[] = []
  let currentChars = 0
  let fence: string | null = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    current.push(line)
    currentChars += line.length + 1

    const fenceMatch = FENCE_PATTERN.exec(line)
    if (fenceMatch) {
      const marker = fenceMatch[2]
      if (fence === null) {
        fence = marker[0] // 记住是反引号还是波浪线
      } else if (marker[0] === fence && fenceMatch[3].trim() === '') {
        // 收尾围栏不能带信息串，否则那是另一个开围栏
        fence = null
      }
      continue
    }
    if (fence !== null) continue // 围栏内部，任何空行都不是边界
    if (line.trim() !== '') continue // 只在空行处考虑切
    if (currentChars < targetChars) continue

    // 往后找第一个非空行，看它是不是续行
    let next = i + 1
    while (next < lines.length && lines[next].trim() === '') next++
    if (next >= lines.length) continue // 后面只剩空行，没必要单独成块
    if (continuesPreviousBlock(lines[next])) continue

    chunks.push(current.join('\n'))
    current = []
    currentChars = 0
  }

  if (current.length > 0) chunks.push(current.join('\n'))
  return chunks.length > 0 ? chunks : [source]
}
