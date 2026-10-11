/**
 * 文件管理器目录列表的排序/截断（目录在前、collator 比名字、超限截断），纯函数加可让出主线程的分批版本。
 * 不碰 React/IPC/i18n，截断只返回数字，文案由调用方翻译；目前仅 `components/FileManagerScreen.tsx` 调用。
 * 复用 `Intl.Collator`：`localeCompare` 每次调用都新建排序器，十万条排序约 1.7e6 次，开销在构造而非比较。
 * 剩余 O(n) 装饰/还原分批做，批间让出主线程（`scheduler.yield` → `scheduler.postTask` → `setTimeout(0)`）。
 * 不用 Worker：要搬十万个对象，两次结构化克隆本身在主线程上，代价与排序同量级，还多一套分块和 CSP 降级。
 */

export interface SortableDirEntry {
  name: string
  isDirectory: boolean
}

/**
 * 条目数硬上限：超过只显示前 N 条，并明确告知被截断的数量，绝不静默丢数据。
 * 截断在排序之后，丢的是排在最后的；再大一个数量级时 `getTotalSize()` 高度和滚动条精度撑不住。
 */
export const DIR_ENTRY_HARD_LIMIT = 200_000

/** 超过这个条目数才走分批异步版本；以下直接同步排完，避免白白多等一帧。 */
export const DIR_ENTRY_CHUNK_THRESHOLD = 2_000

/** 每让出一次主线程处理多少条。2 万条的装饰/还原在现代机器上是个位数毫秒。 */
const CHUNK_SIZE = 20_000

/**
 * 建排序器，每次目录加载复用同一实例，不要在比较函数里现建。
 * 选项刻意留空：默认选项与 `localeCompare` 一致，不改变排序结果；加 `numeric: true` 会改变顺序，须单独提。
 * locale 不合法时回落到运行时默认语言，不抛错，排序失败不该让目录打不开。
 */
export function createNameCollator(locale?: string): Intl.Collator {
  try {
    return new Intl.Collator(locale || undefined)
  } catch {
    return new Intl.Collator()
  }
}

/** 装饰后的条目：`group` 预先把"目录在前"算成数字，比较时一次减法即可。 */
interface Decorated<T> {
  group: number
  name: string
  entry: T
}

function decorateAt<T extends SortableDirEntry>(entries: readonly T[], out: Decorated<T>[], from: number, to: number): void {
  for (let i = from; i < to; i++) {
    const entry = entries[i]
    out[i] = { group: entry.isDirectory ? 0 : 1, name: entry.name, entry }
  }
}

function undecorateAt<T>(decorated: readonly Decorated<T>[], out: T[], from: number, to: number): void {
  for (let i = from; i < to; i++) out[i] = decorated[i].entry
}

/** 同步排序：目录在前，同组按名字比；不改原数组，返回新数组。 */
export function sortDirEntries<T extends SortableDirEntry>(entries: readonly T[], collator: Intl.Collator): T[] {
  const decorated = new Array<Decorated<T>>(entries.length)
  decorateAt(entries, decorated, 0, entries.length)
  const compare = collator.compare
  decorated.sort((a, b) => (a.group !== b.group ? a.group - b.group : compare(a.name, b.name)))
  const out = new Array<T>(entries.length)
  undecorateAt(decorated, out, 0, entries.length)
  return out
}

/** 让出主线程一次：`scheduler.yield()` → `scheduler.postTask()` → `setTimeout(0)` 三级降级，均不可用也不抛。 */
export function yieldToMainThread(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void>; postTask?: (cb: () => void, opts?: { priority?: string }) => Promise<unknown> } }).scheduler
  if (scheduler?.yield) {
    try {
      return scheduler.yield()
    } catch {
      /* 落到下面 */
    }
  }
  if (scheduler?.postTask) {
    try {
      return scheduler.postTask(() => undefined, { priority: 'user-visible' }).then(() => undefined)
    } catch {
      /* 落到下面 */
    }
  }
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0)
  })
}

export interface ChunkedSortOptions {
  /** 已经开始新一次加载时返回 true，本次立刻放弃（返回 null）。 */
  isCancelled?: () => boolean
  /** 0~1。只在真的走了分批路径时才会被调用。 */
  onProgress?: (ratio: number) => void
}

/**
 * 分批排序。条目数不到 `DIR_ENTRY_CHUNK_THRESHOLD` 时同步排完，不多一帧延迟；
 * 超过则把 O(n) 装饰/还原按 `CHUNK_SIZE` 分批并在批间让出主线程。中间的 `Array.prototype.sort`
 * 是原生不可中断调用，手写可中断归并反而更慢。被取消（用户已切目录）时返回 `null`，调用方丢弃结果。
 */
export async function sortDirEntriesChunked<T extends SortableDirEntry>(
  entries: readonly T[],
  collator: Intl.Collator,
  options: ChunkedSortOptions = {},
): Promise<T[] | null> {
  const { isCancelled, onProgress } = options
  if (entries.length < DIR_ENTRY_CHUNK_THRESHOLD) return sortDirEntries(entries, collator)

  const total = entries.length
  const decorated = new Array<Decorated<T>>(total)
  for (let i = 0; i < total; i += CHUNK_SIZE) {
    if (isCancelled?.()) return null
    const end = Math.min(i + CHUNK_SIZE, total)
    decorateAt(entries, decorated, i, end)
    onProgress?.((end / total) * 0.45)
    await yieldToMainThread()
  }

  if (isCancelled?.()) return null
  const compare = collator.compare
  decorated.sort((a, b) => (a.group !== b.group ? a.group - b.group : compare(a.name, b.name)))
  onProgress?.(0.9)
  await yieldToMainThread()

  const out = new Array<T>(total)
  for (let i = 0; i < total; i += CHUNK_SIZE) {
    if (isCancelled?.()) return null
    const end = Math.min(i + CHUNK_SIZE, total)
    undecorateAt(decorated, out, i, end)
    onProgress?.(0.9 + (end / total) * 0.1)
    if (end < total) await yieldToMainThread()
  }
  return out
}

/** 超量截断，返回保留的条目和被丢掉的条数；后者必须显示，界面要能区分"列表到此为止"和"目录就这么多"。 */
export function truncateDirEntries<T>(entries: readonly T[], limit: number = DIR_ENTRY_HARD_LIMIT): { entries: T[]; dropped: number } {
  if (entries.length <= limit) return { entries: entries as T[], dropped: 0 }
  return { entries: entries.slice(0, limit), dropped: entries.length - limit }
}
