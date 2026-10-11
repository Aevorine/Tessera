import { describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

import { FORMULAS, Formula } from '@/components/ui/formula'

/** 公式渲染底线：KaTeX 延迟加载，未加载完或加载失败时也必须有可读内容，不能渲染成空白。 */
describe('Formula', () => {
  it('还没加载完 KaTeX 时显示的是可读的 TeX 源码，不是空白', () => {
    render(<Formula tex="H = L \cdot \log_2 N" />)
    // 首帧一定走这条路径：动态 import 至少要一个微任务。
    expect(screen.getByText('H = L \\cdot \\log_2 N')).toBeInTheDocument()
  })

  it('加载完之后换成渲染好的公式', async () => {
    const { container } = render(<Formula tex="a^2 + b^2 = c^2" label="勾股定理" />)
    await waitFor(
      () => {
        expect(container.querySelector('.katex')).not.toBeNull()
      },
      { timeout: 5000 },
    )
    // 公式的 DOM 是一堆定位过的碎片，读屏软件必须念 label 而不是念碎片。
    expect(screen.getByRole('math')).toHaveAttribute('aria-label', '勾股定理')
  })

  it('写错的公式不会把整块界面炸掉', async () => {
    const { container } = render(<Formula tex="\frac{1}{" />)
    await waitFor(
      () => {
        expect(container.textContent).not.toBe('')
      },
      { timeout: 5000 },
    )
  })

  it('公式集中定义，各界面引用同一份', () => {
    // 同一个量在两个界面写成两个样子，是最难发现的那种不统一——
    // 两个界面不会同时出现在屏幕上，谁都不会注意到。
    expect(FORMULAS.passwordEntropy).toContain('\\log_2')
    expect(new Set(Object.values(FORMULAS)).size).toBe(Object.keys(FORMULAS).length)
  })
})
