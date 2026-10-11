// 笔记详情页自动滚动的设置持久化与纯逻辑（速度换算、找段落边界）；
// rAF 循环在 NotesScreen.tsx，因其依赖 React state/ref。
import type { EditorView } from '@codemirror/view'

export type AutoScrollDirection = 'down' | 'up'
export type AutoScrollSpeedPreset = 'slow' | 'medium' | 'fast' | 'custom'
export type AutoScrollUnit = 'pixel' | 'line' | 'paragraph'

export interface AutoScrollSettings {
  direction: AutoScrollDirection
  speedPreset: AutoScrollSpeedPreset
  customSpeedPxPerSec: number
  unit: AutoScrollUnit
}

const STORAGE_KEY = 'ideal1-notes-autoscroll-v1'
const SNAPSHOT_KEY = `${STORAGE_KEY}__snapshot`

export const SPEED_PRESET_PX_PER_SEC: Record<'slow' | 'medium' | 'fast', number> = { slow: 20, medium: 50, fast: 100 }
export const MIN_CUSTOM_SPEED_PX_PER_SEC = 10
export const MAX_CUSTOM_SPEED_PX_PER_SEC = 300
// 按段落滚动时在每个段落分隔（空行）停顿此时长；按行滚动保持连续、不停顿。
const PARAGRAPH_PAUSE_MS = 300
// 启动时速度从 0 线性升到目标，避免突兀；暂停直接取消计时器、零延迟（要求响应 <=50ms），不做渐出。
const RAMP_UP_MS = 250

const DEFAULT_SETTINGS: AutoScrollSettings = {
  direction: 'down',
  speedPreset: 'medium',
  customSpeedPxPerSec: SPEED_PRESET_PX_PER_SEC.medium,
  unit: 'pixel',
}

function isValidSettings(v: unknown): v is AutoScrollSettings {
  if (!v || typeof v !== 'object') return false
  const s = v as Partial<AutoScrollSettings>
  return (
    (s.direction === 'down' || s.direction === 'up') &&
    (s.speedPreset === 'slow' || s.speedPreset === 'medium' || s.speedPreset === 'fast' || s.speedPreset === 'custom') &&
    typeof s.customSpeedPxPerSec === 'number' &&
    (s.unit === 'pixel' || s.unit === 'line' || s.unit === 'paragraph')
  )
}

function readRaw(key: string): AutoScrollSettings | null {
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    return isValidSettings(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function loadAutoScrollSettings(): AutoScrollSettings {
  return readRaw(STORAGE_KEY) ?? readRaw(SNAPSHOT_KEY) ?? DEFAULT_SETTINGS
}

export function saveAutoScrollSettings(settings: AutoScrollSettings) {
  try {
    const raw = JSON.stringify(settings)
    window.localStorage.setItem(STORAGE_KEY, raw)
    window.localStorage.setItem(SNAPSHOT_KEY, raw)
  } catch {
    // localStorage 写满等极端情况——静默失败，不影响这一次的滚动本身
  }
}

export function speedPxPerSecFor(settings: AutoScrollSettings): number {
  return settings.speedPreset === 'custom' ? settings.customSpeedPxPerSec : SPEED_PRESET_PX_PER_SEC[settings.speedPreset]
}

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
}

export function rampFactorFor(elapsedMs: number): number {
  return prefersReducedMotion() ? 1 : Math.min(1, elapsedMs / RAMP_UP_MS)
}

export function paragraphPauseMs(): number {
  return PARAGRAPH_PAUSE_MS
}

// 从 fromPos 沿 direction(1 向下 / -1 向上) 找下一个空行分隔的段落边界，落在空行后（下）或前（上）
// 紧邻行的行首；找不到则到文档头/尾。
export function findNextParagraphPos(view: EditorView, fromPos: number, direction: 1 | -1): number {
  const doc = view.state.doc
  let lineNo = doc.lineAt(fromPos).number
  while (lineNo + direction >= 1 && lineNo + direction <= doc.lines) {
    lineNo += direction
    const line = doc.line(lineNo)
    if (line.text.trim() === '') {
      const boundaryLineNo = lineNo + direction
      if (boundaryLineNo >= 1 && boundaryLineNo <= doc.lines) return doc.line(boundaryLineNo).from
      return line.from
    }
  }
  return direction === 1 ? doc.length : 0
}

export function findNextLinePos(view: EditorView, fromPos: number, direction: 1 | -1): number {
  const doc = view.state.doc
  const lineNo = doc.lineAt(fromPos).number
  const target = Math.min(Math.max(lineNo + direction, 1), doc.lines)
  return doc.line(target).from
}

// 按当前方向计算下一个"该停在哪个 Y 坐标"的边界（像素单位不需要边界，
// 返回 null，调用方据此走连续滚动分支）。
export function computeNextBoundaryY(view: EditorView, direction: 1 | -1, unit: AutoScrollUnit): number | null {
  if (unit === 'pixel') return null
  const el = view.scrollDOM
  const referenceY = direction === 1 ? el.scrollTop + el.clientHeight - 1 : el.scrollTop
  const clampedY = Math.min(Math.max(referenceY, 0), Math.max(0, el.scrollHeight - 1))
  const referencePos = view.lineBlockAtHeight(clampedY).from
  const targetPos = unit === 'paragraph' ? findNextParagraphPos(view, referencePos, direction) : findNextLinePos(view, referencePos, direction)
  return view.lineBlockAt(targetPos).top
}
