import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GlobalIconTooltip } from '@/components/GlobalIconTooltip'

function hover(el: Element) {
  el.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }))
}

function unhover(el: Element) {
  el.dispatchEvent(new MouseEvent('pointerout', { bubbles: true, relatedTarget: document.body }))
}

describe('GlobalIconTooltip', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 100, y: 100, top: 100, left: 100, bottom: 124, right: 124, width: 24, height: 24, toJSON: () => ({}),
    } as DOMRect)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('names an icon-only button that only has an aria-label', () => {
    render(
      <>
        <GlobalIconTooltip />
        <div role="button" aria-label="删除这一条">
          <svg />
        </div>
      </>,
    )
    hover(screen.getByLabelText('删除这一条'))
    act(() => vi.advanceTimersByTime(300))
    expect(screen.getByRole('tooltip').textContent).toBe('删除这一条')
  })

  it('stays quiet for buttons with visible text or an existing Radix tooltip', () => {
    render(
      <>
        <GlobalIconTooltip />
        <button aria-label="保存">保存</button>
        <button aria-label="复制" data-tooltip-trigger="">
          <svg />
        </button>
      </>,
    )
    hover(screen.getByText('保存'))
    act(() => vi.advanceTimersByTime(300))
    hover(screen.getByLabelText('复制'))
    act(() => vi.advanceTimersByTime(300))
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('uses a native title as the name and gives the title back afterwards', () => {
    render(
      <>
        <GlobalIconTooltip />
        <button title="固定到顶部">
          <svg />
        </button>
      </>,
    )
    const button = screen.getByRole('button')
    hover(button)
    expect(button.hasAttribute('title')).toBe(false)
    act(() => vi.advanceTimersByTime(300))
    expect(screen.getByRole('tooltip').textContent).toBe('固定到顶部')
    act(() => unhover(button))
    expect(screen.queryByRole('tooltip')).toBeNull()
    expect(button.getAttribute('title')).toBe('固定到顶部')
  })

  it('reads the name from screen-reader-only text', () => {
    render(
      <>
        <GlobalIconTooltip />
        <button>
          <svg />
          <span className="sr-only">导出</span>
        </button>
      </>,
    )
    hover(screen.getByRole('button'))
    act(() => vi.advanceTimersByTime(300))
    expect(screen.getByRole('tooltip').textContent).toBe('导出')
  })
})
