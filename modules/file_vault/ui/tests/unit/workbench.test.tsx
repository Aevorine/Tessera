import { createRef } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { Workbench, WorkbenchItem } from '@/components/ui/workbench'

/**
 * 双栏工作台行为测试，覆盖两处看不出的坏法：窄窗口靠 hidden 类让位，写反则宽屏正常窄屏出错；
 * listRef 是虚拟列表滚动容器，没传下去则千条时一次渲染全部而卡死。
 */
describe('Workbench', () => {
  it('没选中时右栏显示占位，左栏在', () => {
    render(
      <Workbench
        list={<div>列表内容</div>}
        detail={<div>详情内容</div>}
        placeholder={<div>还没选中</div>}
        selected={false}
      />,
    )
    expect(screen.getByText('列表内容')).toBeInTheDocument()
    expect(screen.getByText('还没选中')).toBeInTheDocument()
    expect(screen.queryByText('详情内容')).not.toBeInTheDocument()
  })

  it('选中之后右栏换成详情，左栏在窄窗口下让位', () => {
    const { container } = render(
      <Workbench
        list={<div>列表内容</div>}
        detail={<div>详情内容</div>}
        placeholder={<div>还没选中</div>}
        selected
      />,
    )
    expect(screen.getByText('详情内容')).toBeInTheDocument()
    expect(screen.queryByText('还没选中')).not.toBeInTheDocument()
    // 左栏仍然挂载着（滚动位置要保住），只是窄屏下用 hidden 藏起来。
    expect(screen.getByText('列表内容')).toBeInTheDocument()
    const listPane = screen.getByText('列表内容').closest('div[class*="lg:flex"]')
    expect(listPane?.className).toContain('hidden')
    expect(container.querySelectorAll('div[class*="hidden"]').length).toBeGreaterThan(0)
  })

  it('listRef 真的挂在滚动容器上', () => {
    const ref = createRef<HTMLDivElement>()
    render(<Workbench list={<div>行</div>} listRef={ref} />)
    expect(ref.current).not.toBeNull()
    // 这就是虚拟列表要拿去测量的那个元素：它必须自己会滚。
    expect(ref.current?.className).toContain('overflow-y-auto')
  })

  it('窄屏返回按钮点得动', async () => {
    const onBack = vi.fn()
    render(
      <Workbench
        list={<div>列表</div>}
        detail={<div>详情</div>}
        selected
        onBack={onBack}
        backLabel="返回列表"
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: '返回列表' }))
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  it('不传 onBack 就不画返回按钮', () => {
    render(<Workbench list={<div>列表</div>} detail={<div>详情</div>} selected />)
    expect(screen.queryByRole('button')).toBeNull()
  })
})

describe('WorkbenchItem', () => {
  it('选中的那一条对读屏软件也是"当前项"', () => {
    render(
      <>
        <WorkbenchItem title="第一条" active />
        <WorkbenchItem title="第二条" />
      </>,
    )
    expect(screen.getByRole('button', { name: /第一条/ })).toHaveAttribute('aria-current', 'true')
    expect(screen.getByRole('button', { name: /第二条/ })).not.toHaveAttribute('aria-current')
  })

  it('点一条会通知外面', async () => {
    const onClick = vi.fn()
    render(<WorkbenchItem title="一条记录" meta="2.1 MB" onClick={onClick} />)
    await userEvent.click(screen.getByRole('button', { name: /一条记录/ }))
    expect(onClick).toHaveBeenCalledTimes(1)
    expect(screen.getByText('2.1 MB')).toBeInTheDocument()
  })
})
