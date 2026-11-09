import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, X } from 'lucide-react'
import { hideContent, useHiddenContent } from '@/lib/hiddenContent'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

/**
 * 通用「关闭任意内容」层。各页面的版式五花八门（PageSection、卡片、工作台、分栏……），逐个组件加 × 永远
 * 覆盖不全，所以在内容区（<main>）上统一做：
 * - 识别「块」：分区 / 卡片 / 圆角描边容器（设计系统里所有卡片都长这样），够大才算；
 * - 键 = 页面 + 块的标题文字（没有标题就用它在内容区里的结构路径），同页重名加序号；与界面语言相关，
 *   换语言后关掉的块会重新出现，可接受（比用易变的 DOM 路径更稳）；
 * - 关掉的块设 display:none 并打标记；内容区每次变化（切页、懒加载、列表刷新）都重新套一遍；
 * - 编辑模式：在每个可见块右上角浮一个 ×，滚动 / 缩放时跟着走。浮层本身不拦点击。
 * PageSection 自带关闭钮（键更稳，用 storageKey），这里跳过它们，免得一块出现两个 ×。
 */

const BLOCK_SELECTOR = [
  'section',
  '[data-slot="card"]',
  '.rounded-xl.border',
  '.rounded-lg.border',
  '.rounded-2xl.border',
].join(',')

const HIDDEN_ATTR = 'data-tessera-hidden'
const MIN_W = 90
const MIN_H = 30

function headingOf(el: Element): string {
  const h = el.querySelector('h1,h2,h3,h4,[data-slot="card-title"],legend,.font-heading,.font-medium,.font-semibold')
  const text = (h?.textContent ?? '').replace(/\s+/g, ' ').trim()
  return text.slice(0, 40)
}

function pathOf(el: Element, root: Element): string {
  const parts: number[] = []
  let cur: Element | null = el
  while (cur && cur !== root) {
    const parent: Element | null = cur.parentElement
    if (!parent) break
    parts.push(Array.prototype.indexOf.call(parent.children, cur))
    cur = parent
  }
  return parts.reverse().join('.')
}

interface Block {
  el: HTMLElement
  key: string
  label: string
}

function collectBlocks(root: HTMLElement, pane: string): Block[] {
  const seen = new Map<string, number>()
  const out: Block[] = []
  root.querySelectorAll<HTMLElement>(BLOCK_SELECTOR).forEach((el) => {
    if (el.closest('[data-layout-editor]')) return
    if (el.matches('section.group\\/section')) return // PageSection 自己有 ×
    if (el.closest('[role="dialog"],[data-radix-popper-content-wrapper]')) return
    const heading = headingOf(el)
    const base = heading || `#${pathOf(el, root)}`
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    const id = n === 0 ? base : `${base}~${n}`
    out.push({ el, key: `block:${pane}:${id}`, label: heading || el.innerText.replace(/\s+/g, ' ').trim().slice(0, 24) || pane })
  })
  return out
}

export function LayoutEditor({
  rootRef,
  pane,
  editing,
  onDone,
}: {
  rootRef: RefObject<HTMLElement | null>
  pane: string
  editing: boolean
  onDone: () => void
}) {
  const { t } = useTranslation('common')
  const hidden = useHiddenContent()
  const hiddenRef = useRef(hidden)
  hiddenRef.current = hidden
  const [marks, setMarks] = useState<{ key: string; label: string; x: number; y: number }[]>([])
  const frame = useRef(0)

  const apply = useCallback(() => {
    const root = rootRef.current
    if (!root) return
    const blocks = collectBlocks(root, pane)
    const h = hiddenRef.current
    for (const b of blocks) {
      const shouldHide = b.key in h
      const isHidden = b.el.hasAttribute(HIDDEN_ATTR)
      if (shouldHide && !isHidden) {
        b.el.setAttribute(HIDDEN_ATTR, '')
        b.el.style.setProperty('display', 'none', 'important')
      } else if (!shouldHide && isHidden) {
        b.el.removeAttribute(HIDDEN_ATTR)
        b.el.style.removeProperty('display')
      }
    }
    if (!editing) {
      setMarks((m) => (m.length ? [] : m))
      return
    }
    const box = root.getBoundingClientRect()
    const next: { key: string; label: string; x: number; y: number }[] = []
    const taken: { x: number; y: number }[] = []
    for (const b of blocks) {
      if (b.key in h) continue
      const r = b.el.getBoundingClientRect()
      if (r.width < MIN_W || r.height < MIN_H) continue
      if (r.bottom < box.top || r.top > box.bottom) continue
      const x = r.right - box.left - 30
      const y = Math.max(r.top - box.top + 6, 2)
      // 嵌套块的右上角常与外层重合：太近就错开一格，保证每个 × 都点得到。
      let yy = y
      while (taken.some((p) => Math.abs(p.x - x) < 26 && Math.abs(p.y - yy) < 26)) yy += 28
      taken.push({ x, y: yy })
      next.push({ key: b.key, label: b.label, x, y: yy })
    }
    setMarks(next)
  }, [rootRef, pane, editing])

  const schedule = useCallback(() => {
    cancelAnimationFrame(frame.current)
    frame.current = requestAnimationFrame(apply)
  }, [apply])

  useLayoutEffect(() => {
    apply()
  }, [apply, hidden])

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const mo = new MutationObserver((records) => {
      // 自己设 display 引起的属性变化不再触发，避免死循环。
      if (records.every((r) => r.type === 'attributes' && (r.target as Element).closest?.('[data-layout-editor]'))) return
      schedule()
    })
    mo.observe(root, { childList: true, subtree: true })
    window.addEventListener('resize', schedule)
    root.addEventListener('scroll', schedule, true)
    return () => {
      mo.disconnect()
      window.removeEventListener('resize', schedule)
      root.removeEventListener('scroll', schedule, true)
      cancelAnimationFrame(frame.current)
    }
  }, [rootRef, schedule])

  useEffect(() => {
    if (!editing) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDone()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [editing, onDone])

  if (!editing) return null
  return (
    <div data-layout-editor="" className="pointer-events-none absolute inset-0 z-40">
      <div className="pointer-events-auto absolute start-1/2 top-3 flex -translate-x-1/2 items-center gap-3 rounded-full border border-border bg-popover/95 px-4 py-1.5 text-sm shadow-md backdrop-blur">
        <span className="text-muted-foreground">{t('layoutEditHint')}</span>
        <button
          type="button"
          onClick={onDone}
          className="ds-focus-ring inline-flex items-center gap-1 rounded-full bg-primary px-3 py-1 text-primary-foreground"
        >
          <Check className="size-4" aria-hidden="true" />
          {t('layoutEditDone')}
        </button>
      </div>
      {marks.map((m) => (
        <Tooltip key={m.key}>
          <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => hideContent(m.key, m.label, pane)}
          aria-label={t('closeSectionLabel', { name: m.label })}
          style={{ left: m.x, top: m.y }}
          className="ds-focus-ring pointer-events-auto absolute flex size-6 items-center justify-center rounded-full bg-destructive text-white shadow ring-2 ring-background transition-transform hover:scale-110"
        >
          <X className="size-3.5" aria-hidden="true" />
        </button>
          </TooltipTrigger>
          <TooltipContent>{t('closeSectionLabel', { name: m.label })}</TooltipContent>
        </Tooltip>
      ))}
    </div>
  )
}
