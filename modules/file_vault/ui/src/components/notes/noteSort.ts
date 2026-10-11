/**
 * 笔记列表排序比较器，必须与后端 notes/storage.py 的 `_SORT_CLAUSES` 排出完全相同的顺序。
 * 前端本地乐观更新后要立刻重排；两边不一致的症状是"改完跳到 A，刷新又跳到 B"，不报错难查。
 * 独立成模块是为了让 node:test 直接导入（ui/tests/noteSortOrder.test.mjs）。
 */
import type { NoteListItem, NoteSortMode } from '@/shared/ipcTypes'

export const NOTE_SORT_MODES: readonly NoteSortMode[] = ['created', 'updated', 'title', 'manual']
export const DEFAULT_NOTE_SORT_MODE: NoteSortMode = 'created'

/**
 * SQLite 的 `COLLATE NOCASE` 只折叠 ASCII 的 A-Z。toLowerCase() 会连土耳其语 'I'、德语 'ß' 一起折，
 * localeCompare 又随系统语言变，都与后端排不出同序，所以手写只折 A-Z 的版本。
 */
function foldAsciiCase(value: string): string {
  let out = ''
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    // 'A'(65) 到 'Z'(90) → 加 32 变小写，其余原样
    out += code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : value[i]
  }
  return out
}

/**
 * 与后端一致：四种模式都以 is_pinned 打头、id 降序收尾。id 是必需的决胜键：
 * updated_at 只到秒、标题会重名、sort_order 默认全 0，而 sort 的稳定性只保输入顺序，会让行自己跳。
 */
export function compareNotes(a: NoteListItem, b: NoteListItem, mode: NoteSortMode): number {
  if (a.is_pinned !== b.is_pinned) return b.is_pinned - a.is_pinned

  if (mode === 'updated') {
    // ISO 8601 定长字符串，字典序即时间序，不用解析成 Date
    if (a.updated_at !== b.updated_at) return a.updated_at < b.updated_at ? 1 : -1
  } else if (mode === 'title') {
    const left = foldAsciiCase(a.title)
    const right = foldAsciiCase(b.title)
    if (left !== right) return left < right ? -1 : 1
  } else if (mode === 'manual') {
    if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order
  }

  return b.id - a.id
}

export function sortNotesBy(notes: NoteListItem[], mode: NoteSortMode): NoteListItem[] {
  return [...notes].sort((a, b) => compareNotes(a, b, mode))
}

/**
 * 把 `draggedId` 挪到 `targetId` 的位置，返回新的完整 id 顺序。必须传全部活动笔记而非筛选子集：后
 * 端 set_manual_order 发 1..N 号，子集会与未在列表里的笔记号段冲突。调用方先按当前手动序排好全集。
 * /
 */
export function moveInOrder(orderedIds: number[], draggedId: number, targetId: number): number[] {
  const from = orderedIds.indexOf(draggedId)
  const to = orderedIds.indexOf(targetId)
  if (from === -1 || to === -1 || from === to) return orderedIds
  const next = [...orderedIds]
  next.splice(from, 1)
  next.splice(to, 0, draggedId)
  return next
}
