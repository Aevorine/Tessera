// 记住上次导入/导出用的文件夹路径；路径不是笔记内容，不必过加密数据库，localStorage 即可达到毫秒级（无 IPC/网络）。
import { electronApi } from './electronApi'

export type PathMemoryScope = 'import' | 'export'

export interface PathMemoryScopeState {
  last: string | null
  recent: string[]
  favorites: string[]
}

interface PathMemoryState {
  import: PathMemoryScopeState
  export: PathMemoryScopeState
}

const STORAGE_KEY = 'ideal1-notes-path-memory-v1'
// 双缓存自愈：主记录只在一次成功写入后才更新快照；主记录损坏（如写到一半被杀进程）时回退到快照，
// 再没有才回空状态，不弹错误、不崩溃。
const SNAPSHOT_KEY = `${STORAGE_KEY}__snapshot`
const RECENT_LIMIT = 10
const FAVORITES_LIMIT = 20

function emptyScope(): PathMemoryScopeState {
  return { last: null, recent: [], favorites: [] }
}

function emptyState(): PathMemoryState {
  return { import: emptyScope(), export: emptyScope() }
}

function isValidScope(v: unknown): v is PathMemoryScopeState {
  if (!v || typeof v !== 'object') return false
  const s = v as Partial<PathMemoryScopeState>
  return Array.isArray(s.recent) && Array.isArray(s.favorites) && (s.last === null || typeof s.last === 'string')
}

function isValidState(v: unknown): v is PathMemoryState {
  if (!v || typeof v !== 'object') return false
  const s = v as Partial<PathMemoryState>
  return isValidScope(s.import) && isValidScope(s.export)
}

function readRaw(key: string): PathMemoryState | null {
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    return isValidState(parsed) ? parsed : null
  } catch {
    return null
  }
}

function load(): PathMemoryState {
  return readRaw(STORAGE_KEY) ?? readRaw(SNAPSHOT_KEY) ?? emptyState()
}

function persist(state: PathMemoryState) {
  try {
    const raw = JSON.stringify(state)
    window.localStorage.setItem(STORAGE_KEY, raw)
    window.localStorage.setItem(SNAPSHOT_KEY, raw)
  } catch {
    // localStorage 写满等极端情况——静默失败，不影响本次导入/导出本身
  }
}

function pushRecent(list: string[], value: string, limit: number): string[] {
  return [value, ...list.filter((p) => p !== value)].slice(0, limit)
}

export function getScopeMemory(scope: PathMemoryScope): PathMemoryScopeState {
  return load()[scope]
}

// 每次成功导入/导出后调用——记住这个路径，同时挤进最近使用列表（MRU）。
export function recordUsedPath(scope: PathMemoryScope, dirPath: string) {
  const state = load()
  const current = state[scope]
  state[scope] = { ...current, last: dirPath, recent: pushRecent(current.recent, dirPath, RECENT_LIMIT) }
  persist(state)
}

// 返回收藏后的新状态（true=已收藏，false=已取消）。
export function toggleFavorite(scope: PathMemoryScope, dirPath: string): boolean {
  const state = load()
  const current = state[scope]
  const isFav = current.favorites.includes(dirPath)
  const favorites = isFav ? current.favorites.filter((p) => p !== dirPath) : [dirPath, ...current.favorites].slice(0, FAVORITES_LIMIT)
  state[scope] = { ...current, favorites }
  persist(state)
  return !isFav
}

// 取"上次用过的路径"作系统对话框默认位置前先验证是否还在；不在则返回 stale=true，
// 调用方提示"记忆路径已失效"，不把不存在的路径塞给对话框。
export async function resolveDefaultPath(scope: PathMemoryScope): Promise<{ path: string | null; stale: boolean }> {
  const last = load()[scope].last
  if (!last) return { path: null, stale: false }
  const exists = await electronApi.pathExists(last)
  return exists ? { path: last, stale: false } : { path: null, stale: true }
}

export function dirnameOf(filePath: string): string {
  const idx = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  return idx >= 0 ? filePath.slice(0, idx) : filePath
}

export function joinPath(dirPath: string, fileName: string): string {
  const sep = dirPath.includes('\\') && !dirPath.includes('/') ? '\\' : '/'
  return dirPath.endsWith(sep) ? `${dirPath}${fileName}` : `${dirPath}${sep}${fileName}`
}

export function basenameOf(dirPath: string): string {
  const trimmed = dirPath.replace(/[/\\]+$/, '')
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed
}
