import { memo } from 'react'
import type { Range } from '@/lib/search'

/** 按命中区间给文字加底色；没有区间就是原文。 */
export const Highlight = memo(function Highlight({ text, ranges }: { text: string; ranges?: Range[] }) {
  if (!ranges?.length || !text) return <>{text}</>
  const sorted = [...ranges].sort((a, b) => a[0] - b[0])
  const parts: React.ReactNode[] = []
  let at = 0
  for (const [s0, e0] of sorted) {
    const s = Math.max(s0, at)
    const e = Math.min(e0, text.length)
    if (e <= s) continue
    if (s > at) parts.push(text.slice(at, s))
    parts.push(
      <mark key={s} className="rounded-[3px] bg-accent-soft text-current shadow-[inset_0_-1px_0_var(--accent-line)]">
        {text.slice(s, e)}
      </mark>,
    )
    at = e
  }
  if (at < text.length) parts.push(text.slice(at))
  return <>{parts}</>
})
