import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { tk } from '../setup/i18n'

/** 剪贴板时间线：固定大小窗口，可全屏，Esc 退出。需真渲染真按键才能验证全屏后 Esc 能否回来。 */

const items = Array.from({ length: 40 }, (_, i) => ({
  item_id: `item-${i}`,
  source: i % 2 ? 'dev-honor' : 'dev-self',
  source_name: i % 2 ? 'HONOR' : '本机',
  local: i % 2 === 0,
  via: 'sync' as const,
  at: Date.now() - i * 60_000,
  preferred: i === 0 ? 'image/png' : 'text/plain',
  preview: i === 0 ? '' : `第 ${i} 条剪贴板内容`,
  kinds: [{ mime: 'text/plain', size: 10, ready: true }],
  size: 1024 + i,
  complete: true,
  available: true,
}))

vi.mock('@/lib/crossDeviceApi', () => ({
  crossDeviceApi: {
    call: vi.fn(async (method: string) => {
      if (method === 'clip_timeline') return { items, clip_sync: true }
      return {}
    }),
    onEvent: vi.fn(() => () => {}),
  },
}))

const { ClipTimelinePanel } = await import('@/components/crossdevice/ClipTimelinePanel')
const { TooltipProvider } = await import('@/components/ui/tooltip')
const { LabelModeProvider } = await import('@/lib/labelMode')

function Wrap({ children }: { children: React.ReactNode }) {
  return (
    <TooltipProvider delayDuration={200}>
      <LabelModeProvider>{children}</LabelModeProvider>
    </TooltipProvider>
  )
}

beforeEach(() => {
  window.localStorage.clear()
})

describe('剪贴板时间线窗口', () => {
  it('页内是一个固定窗口，所有记录都在窗口自己的滚动列表里', async () => {
    render(
      <Wrap>
        <ClipTimelinePanel available />
      </Wrap>,
    )
    const win = await screen.findByTestId('clip-timeline-window')
    // 40 条全在窗口里（不再只留 20 条），而不是把整页撑长。
    const rows = await within(win).findAllByRole('listitem')
    expect(rows).toHaveLength(40)
    // 滚动发生在窗口内部：窗口里的列表自己 overflow，窗口本身不随条数增高。
    expect(within(win).getByRole('list').className).toMatch(/overflow-y-auto/)
    expect(win.className).toMatch(/overflow-hidden/)
  })

  it('没有记录时窗口仍在、大小不变，里面写着空状态', async () => {
    const api = await import('@/lib/crossDeviceApi')
    vi.mocked(api.crossDeviceApi.call).mockImplementation((async (method: string) =>
      method === 'clip_timeline' ? { items: [], clip_sync: true } : {}) as never)
    render(
      <Wrap>
        <ClipTimelinePanel available />
      </Wrap>,
    )
    const win = await screen.findByTestId('clip-timeline-window')
    await waitFor(() => expect(within(win).getByText(tk('crossdevice:clipTimelineEmpty'))).toBeVisible())
    // 窗口的高度是写死的类，不依赖里面有没有内容——空的时候和满的时候是同一个类。
    expect(win.className).toMatch(/h-\[min\(32rem,65vh\)\]/)
    expect(within(win).queryByRole('list')).toBeNull()
  })

  it('点全屏按钮铺满窗口，按 Esc 退回页内', async () => {
    const user = userEvent.setup()
    render(
      <Wrap>
        <ClipTimelinePanel available />
      </Wrap>,
    )
    await screen.findByTestId('clip-timeline-window')
    expect(screen.queryByTestId('clip-timeline-fullscreen')).toBeNull()

    const trigger = screen.getByRole('button', { name: tk('crossdevice:clipTimelineFullscreen') })
    await user.click(trigger)
    const full = await screen.findByTestId('clip-timeline-fullscreen')
    expect(full).toBeVisible()
    // 全屏里同样是整份记录，可以滑动查看。
    expect(await within(full).findAllByRole('listitem')).toHaveLength(40)
    expect(within(full).getByRole('button', { name: tk('crossdevice:clipTimelineExitFullscreen') })).toBeVisible()

    // 只按一下。初始焦点在搜索框而不是顶栏按钮：按钮一获得焦点就会弹出提示气泡，
    // 气泡是最上层的浮层，会吃掉第一下 Esc——用户得按两下才退得出全屏。
    expect(document.activeElement).toBe(within(full).getByRole('textbox'))
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByTestId('clip-timeline-fullscreen')).toBeNull())
    // 回到页内，窗口还在。
    expect(screen.getByTestId('clip-timeline-window')).toBeVisible()
  })

  it('全屏里点「退出全屏」按钮同样能回来', async () => {
    const user = userEvent.setup()
    render(
      <Wrap>
        <ClipTimelinePanel available />
      </Wrap>,
    )
    await screen.findByTestId('clip-timeline-window')
    await user.click(screen.getByRole('button', { name: tk('crossdevice:clipTimelineFullscreen') }))
    const full = await screen.findByTestId('clip-timeline-fullscreen')
    await user.click(within(full).getByRole('button', { name: tk('crossdevice:clipTimelineExitFullscreen') }))
    await waitFor(() => expect(screen.queryByTestId('clip-timeline-fullscreen')).toBeNull())
  })

  it('全屏里的搜索词带回页内（同一份状态，不是两份）', async () => {
    const user = userEvent.setup()
    render(
      <Wrap>
        <ClipTimelinePanel available />
      </Wrap>,
    )
    await screen.findByTestId('clip-timeline-window')
    await user.click(screen.getByRole('button', { name: tk('crossdevice:clipTimelineFullscreen') }))
    const full = await screen.findByTestId('clip-timeline-fullscreen')
    await user.type(within(full).getByRole('textbox'), '第 7 条')
    expect(within(full).getAllByRole('listitem')).toHaveLength(1)
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByTestId('clip-timeline-fullscreen')).toBeNull())
    expect(within(screen.getByTestId('clip-timeline-window')).getAllByRole('listitem')).toHaveLength(1)
  })
})
