import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { PageHeader } from '@/components/ui/page'

/**
 * 标题行的行为测试。vitest 里 `css: false`，sr-only 不会生效，
 * 所以断言的是“页面名这个可访问名字还在”，并真渲染数可见文字。
 */
describe('PageHeader', () => {
  it('页面名只给读屏软件，不画在界面上', () => {
    render(<PageHeader title="文件管理器" actions={<button type="button">新建</button>} />)

    // getByRole 走的是可访问性树，跟"眼睛看不看得见"是两回事——
    // 这正是 sr-only 的定义：从视觉里拿掉，从可访问性树里留下。
    const heading = screen.getByRole('heading', { level: 1, name: '文件管理器' })
    expect(heading).toBeInTheDocument()
    expect(heading).toHaveClass('sr-only')
  })

  it('标题行里不再有讲解这一页的段落', () => {
    const { container } = render(
      <PageHeader title="文件管理器" actions={<button type="button">新建</button>} />,
    )
    // 一个 <p> 都不该有：界面上不放解释自己的文字，这条从结构上守住。
    expect(container.querySelectorAll('p')).toHaveLength(0)
  })

  it('没有操作也没有数字时，只剩读屏用的标题，不画那条带子', () => {
    const { container } = render(<PageHeader title="文件管理器" />)
    expect(screen.getByRole('heading', { level: 1, name: '文件管理器' })).toBeInTheDocument()
    // 空带子会在页面顶上留一条孤零零的分隔线，看起来像内容没加载出来。
    expect(container.querySelector('header')).toBeNull()
  })

  it('主操作固定在右上角，且点得动', async () => {
    const onClick = vi.fn()
    render(
      <PageHeader
        title="文件管理器"
        actions={<button type="button" onClick={onClick}>新建文件夹</button>}
      />,
    )

    await userEvent.click(screen.getByRole('button', { name: '新建文件夹' }))
    // 守“按钮是不是装饰”：被盖住、被 pointer-events:none 挡掉、onClick 没传下去，都会渲染正常却失灵。
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})
