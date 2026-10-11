// 每篇笔记独立记住阅读/编辑位置（光标字符偏移 + 滚动占比），同步读 localStorage，无后端往返。
// 光标用字符偏移，不受字体/窗口宽度影响；滚动用占比而非像素，像素会因字号缩放（Ctrl+滚轮）跨会话对不上。

export interface NotePosition {
  cursor: number
  scrollRatio: number
  savedAt: number
  // Only for segmented (very large) notes: the segment `cursor`/`scrollRatio` are relative to,
  // so reopening jumps into that segment first. Absent for regular notes.
  segmentOrdinal?: number
}

interface NoteEntry {
  current: NotePosition
  history: NotePosition[] // 最近几条旧位置（不含 current），用于"历史回溯"
}

interface PositionMemoryState {
  notes: Record<string, NoteEntry>
}

const STORAGE_KEY = 'ideal1-notes-position-v1'
// 双缓存自愈：主记录只在一次成功写入后才更新快照，主记录损坏时自动回退到
// 最近一次确认有效的快照，快照也没有才回空状态——不弹错误、不崩溃。
const SNAPSHOT_KEY = `${STORAGE_KEY}__snapshot`
const HISTORY_LIMIT = 5
const MAX_TRACKED_NOTES = 300 // 超过后按最后保存时间淘汰最旧的，避免无限增长
// 两次保存的光标位置相差不到这么多字符时不算"实质性移动"，不挤入历史，
// 避免原地小范围调整就把 history 占满同一个位置附近的若干条重复记录。
const HISTORY_DEDUPE_CHARS = 200

function emptyState(): PositionMemoryState {
  return { notes: {} }
}

function isValidPosition(v: unknown): v is NotePosition {
  if (!v || typeof v !== 'object') return false
  const p = v as Partial<NotePosition>
  if (typeof p.cursor !== 'number' || typeof p.scrollRatio !== 'number' || typeof p.savedAt !== 'number') return false
  return p.segmentOrdinal === undefined || typeof p.segmentOrdinal === 'number'
}

function isValidEntry(v: unknown): v is NoteEntry {
  if (!v || typeof v !== 'object') return false
  const e = v as Partial<NoteEntry>
  return isValidPosition(e.current) && Array.isArray(e.history) && e.history.every(isValidPosition)
}

function isValidState(v: unknown): v is PositionMemoryState {
  if (!v || typeof v !== 'object') return false
  const s = v as Partial<PositionMemoryState>
  return !!s.notes && typeof s.notes === 'object' && Object.values(s.notes).every(isValidEntry)
}

function readRaw(key: string): PositionMemoryState | null {
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    return isValidState(parsed) ? parsed : null
  } catch {
    return null
  }
}

// 进程内缓存整份状态（上限 300 篇的 JSON），避免每次 get/save 都重新 JSON.parse。
// 前提：这两个 localStorage key 只由本模块写；多窗口间不同步是有意的（各记各的阅读位置）。
let cachedState: PositionMemoryState | null = null

function load(): PositionMemoryState {
  if (cachedState === null) {
    cachedState = readRaw(STORAGE_KEY) ?? readRaw(SNAPSHOT_KEY) ?? emptyState()
  }
  return cachedState
}

function evictOldest(state: PositionMemoryState) {
  const keys = Object.keys(state.notes)
  if (keys.length <= MAX_TRACKED_NOTES) return
  const sorted = keys.sort((a, b) => state.notes[a].current.savedAt - state.notes[b].current.savedAt)
  for (const k of sorted.slice(0, keys.length - MAX_TRACKED_NOTES)) delete state.notes[k]
}

function persist(state: PositionMemoryState) {
  // 先更新缓存再落盘：即便落盘失败（配额满），本次会话内的位置记忆仍然正常工作，
  // 这跟"静默失败不影响当前这次阅读/编辑"是同一个取向。
  cachedState = state
  try {
    evictOldest(state)
    const raw = JSON.stringify(state)
    window.localStorage.setItem(STORAGE_KEY, raw)
    window.localStorage.setItem(SNAPSHOT_KEY, raw)
  } catch {
    // localStorage 写满等极端情况——静默失败，不影响当前这次阅读/编辑本身
  }
}

/** 丢掉进程内缓存，下次读取重新从 localStorage 解析。测试用；生产代码不需要
 * 调用它——本模块是这两个 key 的唯一写入方，缓存不会失效。 */
export function __resetCacheForTests() {
  cachedState = null
}

export function getPosition(noteId: number): NotePosition | null {
  return load().notes[String(noteId)]?.current ?? null
}

export function getHistory(noteId: number): NotePosition[] {
  return load().notes[String(noteId)]?.history ?? []
}

export function savePosition(noteId: number, position: NotePosition) {
  const state = load()
  const key = String(noteId)
  const existing = state.notes[key]
  const prevCurrent = existing?.current
  const history =
    prevCurrent && Math.abs(prevCurrent.cursor - position.cursor) > HISTORY_DEDUPE_CHARS
      ? [prevCurrent, ...(existing?.history ?? [])].slice(0, HISTORY_LIMIT)
      : (existing?.history ?? [])
  state.notes[key] = { current: position, history }
  persist(state)
}

// 从历史回溯里跳去某一条旧位置——把它提回 current，但不清空 history（用户
// 可能还想继续在历史列表里跳来跳去）。
export function restoreFromHistory(noteId: number, position: NotePosition) {
  const state = load()
  const key = String(noteId)
  const existing = state.notes[key]
  state.notes[key] = { current: position, history: existing?.history ?? [] }
  persist(state)
}
