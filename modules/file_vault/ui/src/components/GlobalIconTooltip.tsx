import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

/**
 * 图标悬停提示兜底。纯图标控件应包 Radix `<Tooltip>`（静态守卫 icon-tooltip-coverage 只认
 * `<Button>`），漏网的（role="button" 的 div、菜单触发器、变量决定的图标、第三方组件）在运行时补：
 * 可点击、无可见文字但有名字的元素悬停都显示同款提示。带 data-tooltip-trigger 的已有正式提示则跳
 * 过。原生 title 会再弹系统灰框，悬停期间暂时收起、离开时还原。
 */

const CANDIDATE =
  '[data-hint], button, a[href], summary, [role="button"], [role="tab"], [role="menuitem"], [role="switch"], [role="checkbox"], [role="radio"], [role="link"]'
const SHOW_DELAY_MS = 220
const GAP = 6
const EDGE = 8

function visibleTextOf(el: HTMLElement): string {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  let text = ''
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement
    if (parent?.closest('.sr-only')) continue
    text += node.textContent ?? ''
  }
  return text.trim()
}

function srOnlyTextOf(el: HTMLElement): string {
  return Array.from(el.querySelectorAll<HTMLElement>('.sr-only'))
    .map((node) => node.textContent?.trim() ?? '')
    .filter(Boolean)
    .join(' ')
}

function labelFor(el: HTMLElement): string | null {
  if (el.closest('[data-tooltip-trigger]')) return null
  // data-hint：把原来常驻在界面上的说明文字收进悬停，有没有可见文字都显示。
  const hint = el.getAttribute('data-hint')?.trim()
  if (hint) return hint
  if (visibleTextOf(el)) return null
  const label =
    el.getAttribute('aria-label')?.trim() ||
    el.getAttribute('data-tooltip')?.trim() ||
    el.getAttribute('title')?.trim() ||
    el.getAttribute('data-native-title')?.trim() ||
    srOnlyTextOf(el)
  return label || null
}

interface Tip {
  label: string
  top: number
  left: number
  placement: 'top' | 'bottom'
}

export function GlobalIconTooltip() {
  const [tip, setTip] = useState<Tip | null>(null)
  const tipRef = useRef<HTMLDivElement | null>(null)
  const current = useRef<HTMLElement | null>(null)
  const timer = useRef<number | null>(null)

  useEffect(() => {
    const clearTimer = () => {
      if (timer.current !== null) {
        window.clearTimeout(timer.current)
        timer.current = null
      }
    }

    const restoreTitle = (el: HTMLElement | null) => {
      if (!el) return
      const saved = el.getAttribute('data-native-title')
      if (saved !== null) {
        if (!el.hasAttribute('title')) el.setAttribute('title', saved)
        el.removeAttribute('data-native-title')
      }
    }

    const hide = () => {
      clearTimer()
      restoreTitle(current.current)
      current.current = null
      setTip(null)
    }

    const show = (el: HTMLElement, label: string) => {
      const rect = el.getBoundingClientRect()
      if (rect.width === 0 && rect.height === 0) return
      const below = rect.bottom + GAP + 32 < window.innerHeight
      setTip({
        label,
        placement: below ? 'bottom' : 'top',
        top: below ? rect.bottom + GAP : rect.top - GAP,
        left: rect.left + rect.width / 2,
      })
    }

    const onOver = (event: Event) => {
      if ((event as PointerEvent).pointerType === 'touch') return
      const target = event.target instanceof Element ? event.target : null
      const el = target?.closest<HTMLElement>(CANDIDATE) ?? null
      if (el === current.current) return
      hide()
      if (!el) return
      const label = labelFor(el)
      if (!label) return
      current.current = el
      const title = el.getAttribute('title')
      if (title !== null) {
        el.setAttribute('data-native-title', title)
        el.removeAttribute('title')
      }
      timer.current = window.setTimeout(() => {
        timer.current = null
        if (current.current === el && el.isConnected) show(el, label)
      }, SHOW_DELAY_MS)
    }

    const onOut = (event: Event) => {
      const el = current.current
      if (!el) return
      const related = (event as MouseEvent).relatedTarget
      const next = related instanceof Node ? related : null
      if (next && el.contains(next)) return
      hide()
    }

    document.addEventListener('pointerover', onOver, true)
    document.addEventListener('pointerout', onOut, true)
    document.addEventListener('pointerdown', hide, true)
    document.addEventListener('keydown', hide, true)
    document.addEventListener('scroll', hide, true)
    window.addEventListener('blur', hide)
    return () => {
      document.removeEventListener('pointerover', onOver, true)
      document.removeEventListener('pointerout', onOut, true)
      document.removeEventListener('pointerdown', hide, true)
      document.removeEventListener('keydown', hide, true)
      document.removeEventListener('scroll', hide, true)
      window.removeEventListener('blur', hide)
      hide()
    }
  }, [])

  // 量出真实宽度后再夹进窗口：靠边的图标（侧栏、右上角）提示不能被裁掉一半。
  useEffect(() => {
    const node = tipRef.current
    if (!tip || !node) return
    const width = node.offsetWidth
    const left = Math.min(Math.max(tip.left - width / 2, EDGE), window.innerWidth - width - EDGE)
    node.style.left = `${left}px`
    node.style.visibility = 'visible'
  }, [tip])

  if (!tip) return null
  return createPortal(
    <div
      ref={tipRef}
      role="tooltip"
      data-side={tip.placement}
      className="pointer-events-none fixed z-[100] max-w-xs animate-in rounded-md bg-foreground px-3 py-1.5 text-sm text-background fade-in-0 zoom-in-95"
      style={{
        top: tip.top,
        left: tip.left,
        visibility: 'hidden',
        transform: tip.placement === 'top' ? 'translateY(-100%)' : undefined,
      }}
    >
      {tip.label}
    </div>,
    document.body,
  )
}
