import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// 必须走 vi.mock：vaultApi.ts 在模块加载时就捕获 window.vaultAPI，beforeEach 塞桩来不及。
// 桩用普通函数而非 vi.fn().mockResolvedValue()：vitest.config.ts 的 `restoreMocks: true` 会抹掉实现，
// 导致 `.then` 读 undefined 报错，看起来像组件 bug。
vi.mock('@/lib/vaultApi', () => ({
  vaultApi: { call: () => Promise.resolve({ ok: false }) },
}))
vi.mock('@/lib/electronApi', () => ({
  electronApi: {
    getGlobalShortcuts: () =>
      Promise.resolve({
        shortcuts: {
          toggleWindow: { key: 't', ctrl: true, alt: true, shift: false },
          clipboardCapture: { key: 'v', ctrl: true, alt: false, shift: true },
          quickNote: { key: 'n', ctrl: true, alt: false, shift: true },
          openDevices: { key: 'd', ctrl: true, alt: true, shift: false },
        },
      }),
  },
}))

import { ShortcutCheatSheet } from '@/components/ShortcutCheatSheet'

/** 速查卡两条性质（错了不报错）：按 ? 要弹出；在输入框里打问号绝不能弹。 */

describe('ShortcutCheatSheet', () => {
  it('默认不显示', () => {
    render(<ShortcutCheatSheet />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('按 ? 弹出来', async () => {
    render(<ShortcutCheatSheet />)
    await userEvent.keyboard('?')
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
  })

  it('再按一次 ? 收回去', async () => {
    render(<ShortcutCheatSheet />)
    await userEvent.keyboard('?')
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    await userEvent.keyboard('?')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('光标在输入框里时打问号不弹窗', async () => {
    render(
      <>
        <input aria-label="搜索" />
        <ShortcutCheatSheet />
      </>,
    )
    const input = screen.getByLabelText('搜索')
    await userEvent.click(input)
    await userEvent.keyboard('这是问号？?')
    // 这一条守的是"用户正在打字"这个上下文。漏了它，在笔记里写一句带问号的话
    // 就会不停弹窗——那种 bug 一旦出现，用户不会来报告，会直接卸载。
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('光标在文本域里时同样不弹窗', async () => {
    render(
      <>
        <textarea aria-label="正文" />
        <ShortcutCheatSheet />
      </>,
    )
    await userEvent.click(screen.getByLabelText('正文'))
    await userEvent.keyboard('?')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('contenteditable 里也不弹窗（笔记编辑器不是 textarea）', async () => {
    render(
      <>
        <div contentEditable aria-label="笔记" role="textbox" tabIndex={0} />
        <ShortcutCheatSheet />
      </>,
    )
    await userEvent.click(screen.getByLabelText('笔记'))
    await userEvent.keyboard('?')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('带修饰键的 ? 不接管（可能是别处的组合键）', async () => {
    render(<ShortcutCheatSheet />)
    await userEvent.keyboard('{Control>}?{/Control}')
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
