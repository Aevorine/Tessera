import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { StatTile } from '@/components/StatTile'

/**
 * 统计磁贴。静态守卫只查调用方写没写 onClick，管不到 StatTile 内部有没有接上；
 * 这里补后一半。
 */
describe('StatTile', () => {
  it('传了 onClick 就是一颗真按钮，点得动', async () => {
    const onClick = vi.fn()
    render(<StatTile label="隐藏的笔记" value={7} onClick={onClick} />)

    await userEvent.click(screen.getByRole('button', { name: /7/ }))
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('紧凑模式下同样点得动（两条渲染分支各写各的，最容易只接一半）', async () => {
    const onClick = vi.fn()
    render(<StatTile label="隐藏的笔记" value={7} onClick={onClick} compact />)

    await userEvent.click(screen.getByRole('button', { name: /7/ }))
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('没传 onClick 时不装成按钮——不可点的东西不该长得像可点的', () => {
    render(<StatTile label="总数" value={12} />)
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByText('12')).toBeInTheDocument()
  })

  it('active 通过 aria-pressed 表达，读屏软件能听出"当前正筛着这一类"', () => {
    render(<StatTile label="隐藏的笔记" value={7} onClick={() => {}} active />)
    expect(screen.getByRole('button', { name: /7/ })).toHaveAttribute('aria-pressed', 'true')
  })

  it('数字是 0 时磁贴照样渲染，不会被当成"没有值"而消失', () => {
    render(<StatTile label="回收站" value={0} onClick={() => {}} />)
    // 0 是最经典的假值 bug：`{value && <X/>}` 会让 0 静默消失，
    // 而"回收站里有 0 条"和"回收站这个数字没了"对用户是两件完全不同的事。
    expect(screen.getByText('0')).toBeInTheDocument()
  })
})
