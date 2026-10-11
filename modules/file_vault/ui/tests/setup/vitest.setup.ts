import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, beforeEach } from 'vitest'

import { initTestI18n } from './i18n'

/** jsdom 下跑真实组件必须补的几样；每条都对应会让测试假绿或假红的缺口。 */

/**
 * jsdom 的 offsetHeight / getBoundingClientRect 恒为 0，虚拟列表要么一行不渲染要么全渲染，断言形同虚设。
 * 故给确定的假尺寸：有行内 height 取行内值，其余取 64（等于 CleanItemList 的 estimateSize），行偏移可预期。
 */
const DEFAULT_ELEMENT_HEIGHT = 64
const DEFAULT_ELEMENT_WIDTH = 800

function inlineSize(element: HTMLElement, axis: 'height' | 'width'): number | null {
  const raw = element.style?.[axis]
  if (!raw) return null
  const value = Number.parseFloat(raw)
  return Number.isFinite(value) ? value : null
}

beforeEach(() => {
  HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect(this: HTMLElement) {
    const height = inlineSize(this, 'height') ?? DEFAULT_ELEMENT_HEIGHT
    const width = inlineSize(this, 'width') ?? DEFAULT_ELEMENT_WIDTH
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: width,
      bottom: height,
      width,
      height,
      toJSON: () => ({}),
    } as DOMRect
  }
})

Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
  configurable: true,
  get(this: HTMLElement) {
    return inlineSize(this, 'height') ?? DEFAULT_ELEMENT_HEIGHT
  },
})

Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
  configurable: true,
  get(this: HTMLElement) {
    return inlineSize(this, 'width') ?? DEFAULT_ELEMENT_WIDTH
  },
})

/** jsdom 无 ResizeObserver；react-virtual 缺它会静默跳过监听，桩只需存在即可。 */
class ResizeObserverStub implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver

/** Radix 的若干组件（Tooltip / Dialog / Tabs）在挂载时会读它。 */
globalThis.DOMRect ??= class DOMRectStub {
  constructor(
    public x = 0,
    public y = 0,
    public width = 0,
    public height = 0,
  ) {}
  get top() { return this.y }
  get left() { return this.x }
  get right() { return this.x + this.width }
  get bottom() { return this.y + this.height }
  static fromRect() { return new DOMRectStub() }
  toJSON() { return {} }
} as unknown as typeof DOMRect

if (!window.matchMedia) {
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }) as MediaQueryList
}

/** jsdom 的 Element 没有这两个，Radix 的 Tabs / Dialog 会调。
 *  不打桩的话是一个 "not a function" 的红字，而根因跟被测行为毫无关系。 */
Element.prototype.scrollIntoView ??= function scrollIntoView() {}
Element.prototype.hasPointerCapture ??= function hasPointerCapture() { return false }
Element.prototype.setPointerCapture ??= function setPointerCapture() {}
Element.prototype.releasePointerCapture ??= function releasePointerCapture() {}

// 用真英文文案而非 cimode；断言里不写死字符串，查询名用 `tk()`（见 ./i18n）。
await initTestI18n()

afterEach(() => {
  cleanup()
  localStorage.clear()
})
