/**
 * 笔记界面的纯逻辑：章节扫描、分类树、列表筛选、正文查找。
 * 只有输入→输出，无 React/IPC/i18n/localStorage；目前仅 `components/NotesScreen.tsx` 调用，
 * 由 `tests/noteFilters.test.mjs` 直接验证。
 */
import type { NoteFormat, NoteListItem, NoteScanFile } from '@/shared/ipcTypes'

// 章节目录

export interface ChapterEntry {
  title: string
  offset: number
  // 弱候选：由"空行包夹的短行"启发式命中（见 isWeakChapterCandidate），目录侧栏用斜体/浅色区分，让用户自行判断。
  weak?: boolean
}

// 常见的中/英文章节标志行——只匹配"整行基本上就是标题本身"的情况（见下面
// isChapterLine 的长度限制），不去猜正文中间偶然提到"第二章"字样的长句。
const CHAPTER_LINE_PATTERNS = [
  /^第[0-9〇一二三四五六七八九十百千万两零]+[章节回卷篇集部]/,
  /^(序章|楔子|引子|尾声|后记|番外(?:篇)?|附录)(?:[:：\s]|$)/,
  /^chapter\s+\d+/i,
  /^#{1,6}\s+/,
]

const MARKDOWN_HEADING_PATTERN = /^#{1,6}\s+/

// 独立成段的对白（"不。"）也满足前后空行且行短，用句末标点排除，与 isWeakChapterCandidate 其余条件联合判定。
const SENTENCE_END_PUNCTUATION = /[。！？，、；,.!?;]$/

// "空行包夹的短行"启发式：识别无"第X章"关键词、非 Markdown 标题却版式独立的标题。
// 多条件联合以免误判对白/清单：trim 后 ≤40 字符、前后均为空行（或文档边界）、不以句末标点收尾；命中算弱候选。
export function isWeakChapterCandidate(prev: string | undefined, trimmed: string, next: string | undefined): boolean {
  if (!trimmed || trimmed.length > 40) return false
  const prevBlank = prev === undefined || prev.trim() === ''
  const nextBlank = next === undefined || next.trim() === ''
  if (!prevBlank || !nextBlank) return false
  return !SENTENCE_END_PUNCTUATION.test(trimmed)
}

export function isChapterLine(trimmed: string): boolean {
  if (!trimmed || trimmed.length > 40) return false
  return CHAPTER_LINE_PATTERNS.some((re) => re.test(trimmed))
}

// 按行扫描，找出"第X章"、"Chapter N"、"序章/尾声"或 Markdown 标题，记下字符偏移供跳转。纯内存扫描。
// 按 format 分流：'markdown' 只信任标题语法（避免正文偶现"第二章"误判）；'plain' 用关键词强匹配，
// 外加空行短行弱候选。按下标遍历是为了同时看前后行。
export function extractChapters(content: string, format: NoteFormat): ChapterEntry[] {
  const chapters: ChapterEntry[] = []
  const lines = content.split('\n')
  let offset = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()
    if (format === 'markdown') {
      if (MARKDOWN_HEADING_PATTERN.test(trimmed)) {
        chapters.push({ title: trimmed.replace(MARKDOWN_HEADING_PATTERN, ''), offset })
      }
    } else if (isChapterLine(trimmed)) {
      chapters.push({ title: trimmed.replace(MARKDOWN_HEADING_PATTERN, ''), offset })
    } else if (isWeakChapterCandidate(lines[i - 1], trimmed, lines[i + 1])) {
      chapters.push({ title: trimmed, offset, weak: true })
    }
    offset += line.length + 1
  }
  return chapters
}

// 分类树

// 分类仍是自由文本（存储不变，见 ipcTypes.ts 的 NoteCategory），"/" 只是多级写法
// （文件夹批量导入时后端自动产生，见 backend_server.py::_folder_category_for）。
// 这里纯前端把平铺分类名解析成树，只影响显示。segment 是本层名字，fullPath 是根到本层的完整分类文本
// （即笔记 category 字段实际存的值）。
export interface CategoryTreeNode {
  segment: string
  fullPath: string
  children: CategoryTreeNode[]
}

/**
 * compare 按全路径比较兄弟节点（`makeCategoryComparator` 的形状），子分类与顶层同一规则。
 * 以前写死 `a.segment.localeCompare(b.segment)`，把 `applyCategoryPrefs` 的手动顺序又按字母重排，
 * 表现为"上移/下移没反应"且不报错。
 */
export function buildCategoryTree(
  flatCategories: string[],
  compare: (a: string, b: string) => number = (a, b) => a.localeCompare(b),
): CategoryTreeNode[] {
  const roots: CategoryTreeNode[] = []
  const nodeByPath = new Map<string, CategoryTreeNode>()
  for (const full of flatCategories) {
    let path = ''
    let siblings = roots
    for (const part of full.split('/').filter((p) => p.length > 0)) {
      path = path ? `${path}/${part}` : part
      let node = nodeByPath.get(path)
      if (!node) {
        node = { segment: part, fullPath: path, children: [] }
        nodeByPath.set(path, node)
        siblings.push(node)
      }
      siblings = node.children
    }
  }
  const sortRecursive = (nodes: CategoryTreeNode[]) => {
    nodes.sort((a, b) => compare(a.fullPath, b.fullPath))
    nodes.forEach((n) => sortRecursive(n.children))
  }
  sortRecursive(roots)
  return roots
}

// 点分类节点要连同所有子分类一起筛出，否则父节点与叶子节点无区别。
export function categoryMatchesFilter(category: string, filter: string): boolean {
  return category === filter || category.startsWith(`${filter}/`)
}

// 列表筛选

/** 列表显示哪一批笔记，对应顶部四块统计：`all`=活跃+隐藏、`active`=非隐藏、`hidden`=已隐藏；回收站是另一维度（`viewMode`）。 */
export type NoteScope = 'active' | 'hidden' | 'all'

/** 笔记是否属于当前范围；收成一个函数，加范围只改这里，免得列表过滤、未分类判断、分类计数三处漏改。 */
export function isNoteInScope(note: { is_hidden: number }, scope: NoteScope): boolean {
  if (scope === 'all') return true
  return scope === 'hidden' ? !!note.is_hidden : !note.is_hidden
}

export interface NoteFilterOptions {
  scope: NoteScope
  viewMode: 'active' | 'trash'
  /** 已经 trim + toLowerCase 过的查询串。空串表示没在搜。 */
  query: string
  /** 后端全文搜索命中的 id 集合；null = 这次搜索没有后端结果可用。 */
  searchResultIds: Set<number> | null
  categoryFilter: string
  tagFilter: string
  pinnedOnly: boolean
}

/** 列表筛选，与原 `filtered` useMemo 逻辑一致；顺序敏感（范围判断必须最先，回收站视图跳过活跃视图那几条）。 */
export function filterNotes(source: readonly NoteListItem[], options: NoteFilterOptions): NoteListItem[] {
  const { scope, viewMode, query: q, searchResultIds, categoryFilter, tagFilter, pinnedOnly } = options
  return source.filter((n) => {
    // 范围判断对两种视图都生效：否则隐藏笔记进回收站后标题和摘要免解锁可见，成了绕过验证的后门。
    if (!isNoteInScope(n, scope)) return false
    if (viewMode === 'active') {
      if (pinnedOnly && !n.is_pinned) return false
      if (categoryFilter === 'uncategorized' && n.category !== '') return false
      else if (categoryFilter !== 'all' && categoryFilter !== 'uncategorized' && !categoryMatchesFilter(n.category, categoryFilter)) return false
      if (tagFilter !== 'all' && !n.tags.includes(tagFilter)) return false
      if (q && searchResultIds !== null && !searchResultIds.has(n.id)) return false
    }
    if (!q || viewMode === 'active') return true
    return (
      n.title.toLowerCase().includes(q) ||
      n.category.toLowerCase().includes(q) ||
      n.preview.toLowerCase().includes(q) ||
      n.tags.some((tag) => tag.toLowerCase().includes(q))
    )
  })
}

/** 文件夹批量导入弹窗里扫描结果的筛选：扫描只发生一次，这里只在内存里过滤，不触发 IPC/文件系统。 */
export function filterScanFiles(files: readonly NoteScanFile[], rawQuery: string): NoteScanFile[] {
  const q = rawQuery.trim().toLowerCase()
  if (!q) return files as NoteScanFile[]
  return files.filter((f) => f.name.toLowerCase().includes(q))
}

/** 置顶在前、组内最新在前，与后端 storage.fetch_list 一致；乐观更新后本地重排，免重新拉取。 */
export function sortNotes(notes: readonly NoteListItem[]): NoteListItem[] {
  return [...notes].sort((a, b) => {
    if (a.is_pinned !== b.is_pinned) return b.is_pinned - a.is_pinned
    return b.id - a.id
  })
}

// 正文查找 / 替换

export interface FindMatch {
  from: number
  to: number
}

export const FIND_MATCH_CAP = 5000

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// 已知局限：超大笔记（数百 MB）上是同步正则扫描，可能超出 "Ctrl+F ms 级"标准，
// 根治需搬进 Web Worker 分片（后续 P1）。FIND_MATCH_CAP 只封顶匹配数，不封顶耗时，
// 防不住用户写出的灾难性回溯正则。
export function computeFindMatches(
  content: string,
  query: string,
  opts: { caseSensitive: boolean; regexp: boolean; wholeWord: boolean },
): { matches: FindMatch[]; capped: boolean; error: boolean } {
  if (!query) return { matches: [], capped: false, error: false }
  let source = opts.regexp ? query : escapeRegExp(query)
  if (opts.wholeWord) source = `\\b(?:${source})\\b`
  let re: RegExp
  try {
    re = new RegExp(source, opts.caseSensitive ? 'g' : 'gi')
  } catch {
    return { matches: [], capped: false, error: true }
  }
  const matches: FindMatch[] = []
  let match: RegExpExecArray | null
  while ((match = re.exec(content)) !== null) {
    matches.push({ from: match.index, to: match.index + match[0].length })
    if (match[0].length === 0) re.lastIndex += 1 // 避免空匹配（如正则"a*"）原地死循环
    if (matches.length >= FIND_MATCH_CAP) return { matches, capped: true, error: false }
  }
  return { matches, capped: false, error: false }
}

// 就近查找——默认选中离当前光标最近的、光标之后的匹配项，而不是每次都从
// 文档开头找起；光标之后没有命中则回绕到第一个。
export function nearestMatchIndex(matches: FindMatch[], cursorPos: number): number {
  if (matches.length === 0) return -1
  const idx = matches.findIndex((m) => m.from >= cursorPos)
  return idx === -1 ? 0 : idx
}
