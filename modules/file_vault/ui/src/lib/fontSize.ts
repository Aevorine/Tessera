// 全应用字号档位：小四和四号两档。改根字号而非逐处改 className：UI 字号与间距都是 rem，
// 改 html 的 font-size 等比缩放文字和间距，逐处改只会放大文字、内边距不变而挤成一团。
// 字体族不在这里，见 index.css 的 --font-sans（CSS 逐字符回退，不做成可选项）。

export type FontSizeTier = 'xiaosi' | 'sihao'

// pt → px 换算按标准 96dpi：1pt = 96/72 = 4/3 px。
// 小四 = 12pt = 16px；四号 = 14pt = 18.6667px。
export const FONT_SIZE_PX: Record<FontSizeTier, number> = {
  xiaosi: 16,
  sihao: (14 * 4) / 3,
}

export const DEFAULT_FONT_SIZE_TIER: FontSizeTier = 'xiaosi'

const STORAGE_KEY = 'ideal1-font-size-tier'
const CSS_VARIABLE = '--app-font-size'

function isFontSizeTier(value: unknown): value is FontSizeTier {
  return value === 'xiaosi' || value === 'sihao'
}

export function loadFontSizeTier(): FontSizeTier {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    return isFontSizeTier(raw) ? raw : DEFAULT_FONT_SIZE_TIER
  } catch {
    return DEFAULT_FONT_SIZE_TIER
  }
}

/** 把档位写到 <html> 的 CSS 变量上。index.css 的 `html { font-size: var(--app-font-size, 16px) }` 会立即生效。 */
export function applyFontSizeTier(tier: FontSizeTier): void {
  document.documentElement.style.setProperty(CSS_VARIABLE, `${FONT_SIZE_PX[tier]}px`)
}

export function saveFontSizeTier(tier: FontSizeTier): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, tier)
  } catch {
    // localStorage 写满等极端情况——本次会话内仍然生效，只是不持久化
  }
  applyFontSizeTier(tier)
}
