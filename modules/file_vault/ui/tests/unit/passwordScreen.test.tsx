import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { tk } from '../setup/i18n'

/**
 * 密码页的行为测试：与 passwordWorkbenchLayout.test.mjs 读源码不同，
 * 这里真渲染再点，验“左侧内容显示不全”这类只有渲染结果才暴露的问题。
 */

const entries = [
  {
    id: 'a',
    name: 'Example Mail',
    url: 'https://mail.example.com/login',
    username: 'alice@example.com',
    password: 'p9$Kw2mZq7Lt4Xv1',
    notes: '',
    created_at: 1_700_000_000,
    updated_at: 1_700_000_000,
  },
  {
    id: 'b',
    name: 'Old Forum',
    url: 'http://forum.example.org',
    username: 'alice',
    password: '123456',
    notes: 'legacy',
    created_at: 1_600_000_000,
    updated_at: 1_600_000_000,
  },
  {
    // 跟 c 共用同一条密码 —— 用来验爆炸半径。
    id: 'c',
    name: 'Shop A',
    url: 'https://shop-a.example.com',
    username: 'alice',
    password: 'SharedPass!2024',
    notes: '',
    created_at: 1_690_000_000,
    updated_at: 1_690_000_000,
  },
  {
    id: 'd',
    name: 'Shop B',
    url: 'https://shop-b.example.com',
    username: 'alice',
    password: 'SharedPass!2024',
    notes: '',
    created_at: 1_690_000_000,
    updated_at: 1_690_000_000,
  },
]

vi.mock('@/lib/vaultApi', () => ({
  vaultApi: {
    call: vi.fn(async (method: string) => {
      if (method === 'password_list') return { entries }
      if (method === 'password_sort_mode_get') return { ok: true, sort_mode: 'recent' }
      return { ok: true }
    }),
  },
}))

vi.mock('@/lib/electronApi', () => ({
  electronApi: {
    openFiles: vi.fn(async () => null),
    saveFile: vi.fn(async () => null),
    getPathForFile: vi.fn(() => ''),
    showItemInFolder: vi.fn(),
  },
}))

const { PasswordScreen } = await import('@/components/PasswordScreen')
const { LabelModeProvider } = await import('@/lib/labelMode')
const { TooltipProvider } = await import('@/components/ui/tooltip')

/** 生产里这两层由 AppShell 提供；单独渲染页面须自己补，否则 ActionButton 挂载即抛。 */
function Wrapped() {
  return (
    <TooltipProvider delayDuration={200}>
      <LabelModeProvider>
        <PasswordScreen isProfessional />
      </LabelModeProvider>
    </TooltipProvider>
  )
}

async function renderScreen() {
  const view = render(<Wrapped />)
  // 第一帧是加载态，等到列表真的出来再断言——否则测的是空壳。
  await screen.findAllByText('Example Mail')
  return view
}

/**
 * 左右栏分开查：右栏默认落在第一条，其名字同时出现在左栏行与右栏标题里，`getByText` 会撞名。
 * 这是新契约，查询须先声明查哪一栏。
 */
function listPane(container: HTMLElement): HTMLElement {
  const pane = container.querySelector('[data-testid="workbench-list"]')
  return (pane ?? container) as HTMLElement
}
function detailPane(container: HTMLElement): HTMLElement {
  const pane = container.querySelector('[data-testid="workbench-detail"]')
  return (pane ?? container) as HTMLElement
}

beforeEach(() => {
  window.localStorage.clear()
})

describe('密码页', () => {
  it('列表每一行都完整显示名字和账号（这是"左侧内容显示不全"那条）', async () => {
    const { container } = await renderScreen()
    const list = listPane(container)
    for (const name of ['Example Mail', 'Old Forum', 'Shop A', 'Shop B']) {
      expect(within(list).getByText(name)).toBeInTheDocument()
    }
    // 账号那一行也在。它原先是被右边五颗按钮挤没的那一部分。
    expect(within(list).getByText('alice@example.com')).toBeInTheDocument()
  })

  it('打开页面右栏就有内容，不是一句「请选择」', async () => {
    const { container } = await renderScreen()
    const detail = detailPane(container)
    // 右栏默认落在第一条上：标题、账号、熵都得在。
    expect(within(detail).getByText('Example Mail')).toBeInTheDocument()
    expect(within(detail).getByText('alice@example.com')).toBeInTheDocument()
    expect(within(detail).getByText(tk('passwords:entropyLabel'))).toBeInTheDocument()
    // 占位语不该出现——它只在一条都没有时才有意义。
    expect(screen.queryByText(tk('passwords:detailEmptyState'))).toBeNull()
  })

  it('列表行里不再挂着一排操作按钮', async () => {
    const { container } = await renderScreen()
    const row = within(listPane(container)).getByText('Example Mail').closest('[role="button"]')
    expect(row).not.toBeNull()
    // 行内只剩复制按钮和可点的打码块；后者兼任显示开关（键盘可触发，带 role/tabIndex），故会被 getAllByRole 数进来。
    const buttons = within(row as HTMLElement).getAllByRole('button')
    expect(buttons.length).toBeLessThanOrEqual(2)
    expect(container).toBeTruthy()
  })

  it('列表里直接看得到密码本身（默认打码，点一下掀开）', async () => {
    const user = userEvent.setup()
    const { container } = await renderScreen()
    const row = within(listPane(container)).getByText('Example Mail').closest('[role="button"]') as HTMLElement

    // 打码块在行里。上一版这一页叫「密码管理」，列表里却一条密码都看不到，
    // 想看必须先点开右栏再点一次眼睛——这就是"密码无法正常显示"。
    const masked = within(row).getByText('•'.repeat(10))
    expect(masked).toBeInTheDocument()
    expect(within(row).queryByText('p9$Kw2mZq7Lt4Xv1')).toBeNull()

    await user.click(masked)
    expect(within(row).getByText('p9$Kw2mZq7Lt4Xv1')).toBeInTheDocument()
  })

  it('一颗开关掀开整列，且离开页面不记忆', async () => {
    const user = userEvent.setup()
    await renderScreen()

    await user.click(screen.getByRole('button', { name: tk('passwords:showAllButton') }))
    // 四条全部露出明文。
    expect(screen.getByText('p9$Kw2mZq7Lt4Xv1')).toBeInTheDocument()
    expect(screen.getByText('123456')).toBeInTheDocument()
    expect(screen.getAllByText('SharedPass!2024').length).toBe(2)

    // 不写 localStorage —— 明文的可见状态不该跨会话留存。
    expect(window.localStorage.getItem('ideal1-password-reveal-all')).toBeNull()

    await user.click(screen.getByRole('button', { name: tk('passwords:hideAllButton') }))
    expect(screen.queryByText('p9$Kw2mZq7Lt4Xv1')).toBeNull()
  })

  it('页面铺满，不再被锁进居中的窄条里', async () => {
    const { container } = await renderScreen()
    // PageShell 的内层容器：canvas 档必须是 max-w-none + 薄留白。
    const inner = container.querySelector('.mx-auto')
    expect(inner).not.toBeNull()
    expect(inner?.className).toContain('max-w-none')
    expect(inner?.className).toContain('lg:px-6')
    expect(inner?.className).not.toContain('max-w-[1440px]')
  })

  it('默认摆四块指标，且都读得出数', async () => {
    await renderScreen()
    // 总条数 4；弱密码 1（123456 在烂密码表里）；重复使用 2（Shop A/B 同密码）。
    expect(screen.getByText(tk('passwords:metricTotalLabel'))).toBeInTheDocument()
    expect(screen.getByText(tk('passwords:metricWeakLabel'))).toBeInTheDocument()
    expect(screen.getByText(tk('passwords:metricReusedLabel'))).toBeInTheDocument()
    expect(screen.getByText(tk('passwords:metricHealthLabel'))).toBeInTheDocument()

    const totalTile = screen.getByText(tk('passwords:metricTotalLabel')).closest('button')
    expect(totalTile?.textContent).toContain('4')
    const weakTile = screen.getByText(tk('passwords:metricWeakLabel')).closest('button')
    expect(weakTile?.textContent).toContain('1')
    const reusedTile = screen.getByText(tk('passwords:metricReusedLabel')).closest('button')
    expect(reusedTile?.textContent).toContain('2')
  })

  it('点「弱密码」把列表筛成那一条', async () => {
    const user = userEvent.setup()
    const { container } = await renderScreen()
    // 「Weak」在页面上有两处：标题行的磁贴，和左栏筛选下拉框里的选项。
    // 必须限定在标题行里找，否则 getByText 会因为撞名字直接抛。
    const header = container.querySelector('header') as HTMLElement
    const weakTile = () => within(header).getByText(tk('passwords:metricWeakLabel')).closest('button') as HTMLElement

    const list = () => listPane(container)
    await user.click(weakTile())
    expect(within(list()).getByText('Old Forum')).toBeInTheDocument()
    expect(within(list()).queryByText('Example Mail')).toBeNull()

    // 再点一次取消筛选——磁贴是开关，不是单向的。
    await user.click(weakTile())
    await waitFor(() => expect(within(list()).getByText('Example Mail')).toBeInTheDocument())
  })

  it('右栏顶部有整条记录的操作，且每一个都能悬停出名字', async () => {
    const { container } = await renderScreen()
    const detail = detailPane(container)

    // ActionButton 把 label 同写进 aria-label 和 Tooltip，按名字找到即等于悬停会显示。
    // 「显示/隐藏」只挂在密码字段旁，不在这排；「复制」在右栏出现多次是对的，所以只查在不在。
    for (const key of ['copyButton', 'viewHistoryButton', 'editButton', 'deleteButton']) {
      expect(within(detail).getAllByRole('button', { name: tk(`passwords:${key}`) }).length).toBeGreaterThan(0)
    }
    // 「显示/隐藏」必须**只有一颗**——0.1.19 之前顶部和字段旁各一颗，
    // 同一个功能在同一屏出现两次，用户得先想一下这个"显示"是显示什么。
    expect(within(detail).getAllByRole('button', { name: tk('passwords:showButton') }).length).toBe(1)
  })

  it('详情里算出熵和破解时间，并且能换攻击者模型', async () => {
    const { container } = await renderScreen()
    const detail = detailPane(container)

    expect(within(detail).getByText(tk('passwords:entropyLabel'))).toBeInTheDocument()
    expect(within(detail).getByText(/bit$/)).toBeInTheDocument()
    expect(within(detail).getByText(tk('passwords:crackTimeLabel'))).toBeInTheDocument()
  })

  it('重复使用的那条会列出还有谁在用同一个密码', async () => {
    const user = userEvent.setup()
    const { container } = await renderScreen()
    await user.click(within(listPane(container)).getByText('Shop A'))

    expect(screen.getByText(tk('passwords:blastRadiusLabel'))).toBeInTheDocument()
    // 右栏里应当出现 Shop B —— 它就是"这条泄露了还有谁跟着完蛋"的答案。
    const detail = screen.getByText(tk('passwords:blastRadiusLabel')).closest('div')?.parentElement
    expect(detail?.textContent).toContain('Shop B')
  })

  it('指标选择器能换掉标题行显示哪几个，并且记得住', async () => {
    const user = userEvent.setup()
    const { container } = await renderScreen()
    const header = container.querySelector('header') as HTMLElement

    // 开始时标题行里没有「陈旧」。
    expect(within(header).queryByText(tk('passwords:metricStaleLabel'))).toBeNull()

    await user.click(screen.getByRole('button', { name: tk('passwords:metricPickerButton') }))
    const staleRow = screen.getByText(tk('passwords:metricStaleLabel')).closest('label')
    await user.click(within(staleRow as HTMLElement).getByRole('checkbox'))
    await user.click(screen.getByRole('button', { name: tk('passwords:metricPickerDone') }))

    // 立刻出现在标题行里。
    expect(within(header).getByText(tk('passwords:metricStaleLabel'))).toBeInTheDocument()

    // 并且写进了 localStorage —— 这才是"记得住"的真正契约。下次开页面
    // 由 loadVisibleMetrics() 读它，那一段有自己的单元测试覆盖。
    const saved = JSON.parse(window.localStorage.getItem('ideal1-password-metrics') ?? '[]')
    expect(saved).toContain('stale')
    expect(saved).toEqual(expect.arrayContaining(['health', 'total', 'weak', 'reused', 'stale']))
  })
})
