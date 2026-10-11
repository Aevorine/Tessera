/**
 * 剪贴板历史点开图片时的查看方式。缩略图仅 8rem 且原图被压到 256×256 内存，看不清截图，
 * 需打开 `image_path` 指向的磁盘原图。只影响呈现，放 localStorage。
 */

export const CLIPBOARD_IMAGE_VIEW_MODES = ['fullscreen', 'window'] as const
export type ClipboardImageViewMode = (typeof CLIPBOARD_IMAGE_VIEW_MODES)[number]

const STORAGE_KEY = 'ideal1-clipboard-image-view-mode'

/** 默认全屏——看不清正是要解决的问题，一上来就给最大的画布。 */
export const DEFAULT_CLIPBOARD_IMAGE_VIEW_MODE: ClipboardImageViewMode = 'fullscreen'

export function isClipboardImageViewMode(v: unknown): v is ClipboardImageViewMode {
  return typeof v === 'string' && (CLIPBOARD_IMAGE_VIEW_MODES as readonly string[]).includes(v)
}

export function loadClipboardImageViewMode(): ClipboardImageViewMode {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return isClipboardImageViewMode(raw) ? raw : DEFAULT_CLIPBOARD_IMAGE_VIEW_MODE
  } catch {
    // 存储被禁用（隐私模式之类）。读不到就用默认值，不能让它把整个面板卡住。
    return DEFAULT_CLIPBOARD_IMAGE_VIEW_MODE
  }
}

export function saveClipboardImageViewMode(mode: ClipboardImageViewMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode)
  } catch {
    // 存不下只影响"下次还记不记得"，不该让这次切换失败
  }
}

/** 缩放范围。下限 0.1 是为了让超大截图能整张看到；上限 8 够看清 1 像素的锯齿。 */
export const MIN_IMAGE_ZOOM = 0.1
export const MAX_IMAGE_ZOOM = 8

export function clampZoom(zoom: number): number {
  return Math.min(MAX_IMAGE_ZOOM, Math.max(MIN_IMAGE_ZOOM, zoom))
}

/** 滚轮一格换算成缩放倍率；用乘法而非加法，加法放大时步子太小、缩小时会冲过头变负数。 */
export function zoomByWheel(current: number, deltaY: number): number {
  return clampZoom(current * (deltaY < 0 ? 1.15 : 1 / 1.15))
}
