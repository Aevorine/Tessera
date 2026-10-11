import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { tk } from '../setup/i18n'

/**
 * 四个换成双栏工作台的界面，真渲染一遍：结构对了但内容没渲染（右栏 undefined、
 * 收起态被 hidden 藏掉、占位与详情都不显示）能编译通过，用户只见空白。
 * 与读源码的守卫（pageHeaderStandfirst.test.mjs 等）互补。
 */

// 假数据字段名对着 shared/ipcTypes.ts，编错会静默走进“没有这一项”分支而测试照样绿。

const clipboardEntries = [
  {
    id: 1, content_type: 'text', content_text: '第一条剪贴板内容', content_format: 'plain',
    image_path: null, thumbnail_path: null, source_app: 'Notepad',
    is_pinned: 0, is_sensitive: 0, is_hidden: 0, is_snippet: 0, is_deleted: 0,
    is_truncated: 0, copy_count: 1, pin_order: null,
    created_at: '2026-08-19 10:00:00', updated_at: '2026-08-19 10:00:00',
  },
  {
    id: 2, content_type: 'text', content_text: '第二条剪贴板内容', content_format: 'plain',
    image_path: null, thumbnail_path: null, source_app: null,
    is_pinned: 0, is_sensitive: 0, is_hidden: 0, is_snippet: 0, is_deleted: 0,
    is_truncated: 0, copy_count: 1, pin_order: null,
    created_at: '2026-08-19 09:00:00', updated_at: '2026-08-19 09:00:00',
  },
]

vi.mock('@/lib/vaultApi', () => ({
  vaultApi: {
    call: vi.fn(async (method: string) => {
      if (method === 'clipboard_list') return { ok: true, entries: clipboardEntries }
      // 方法名必须与 ClipboardScreen 真调的一致；顶栏“视图”菜单挂载即拉条数，落到兜底 { ok: true } 会崩。
      if (method === 'clipboard_snippet_list') return { ok: true, entries: [] }
      if (method === 'clipboard_list_trash') return { ok: true, entries: [] }
      if (method === 'clipboard_settings_get') return { ok: true, settings: {} }
      return { ok: true }
    }),
    // ClipboardScreen 挂载时就订阅新条目推送。少了这一个会在 useEffect 里
    // 直接抛——而组件已经渲染过一帧，屏幕上看起来"有内容"，实际后续全断。
    onEvent: vi.fn(() => () => {}),
  },
}))

vi.mock('@/lib/electronApi', () => ({
  electronApi: {
    openFiles: vi.fn(async () => null),
    openDirectory: vi.fn(async () => null),
    saveFile: vi.fn(async () => null),
    getPathForFile: vi.fn(() => ''),
    showItemInFolder: vi.fn(),
    onClipboardChanged: vi.fn(() => () => {}),
    onNavigate: vi.fn(() => () => {}),
  },
}))

const { Workbench, WorkbenchItem } = await import('@/components/ui/workbench')
const { EmptyState } = await import('@/components/ui/page')
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

/** 工作台契约用最小宿主验一次：四个界面共用同一组件，不变量同时成立或失效。 */
describe('双栏工作台的契约', () => {
  it('没选中时右栏是占位，不是空白', () => {
    render(
      <Wrap>
        <Workbench
          list={<WorkbenchItem title="第一条" />}
          detail={<div>详情内容</div>}
          placeholder={<EmptyState title="还没选中" />}
          selected={false}
        />
      </Wrap>,
    )
    // 空白和占位的区别不是美观问题：一片空白读起来是"坏了"，
    // 占位读起来是"等你挑一个"。
    expect(screen.getByText('还没选中')).toBeVisible()
    expect(screen.queryByText('详情内容')).toBeNull()
  })

  it('选中之后右栏换成详情，左栏仍然挂载着（滚动位置要保住）', () => {
    render(
      <Wrap>
        <Workbench
          list={<WorkbenchItem title="第一条" />}
          detail={<div>详情内容</div>}
          placeholder={<EmptyState title="还没选中" />}
          selected
        />
      </Wrap>,
    )
    expect(screen.getByText('详情内容')).toBeVisible()
    expect(screen.queryByText('还没选中')).toBeNull()
    // 左栏用 hidden 藏，不卸载——卸载的话返回时滚动位置就回到顶了。
    expect(screen.getByRole('button', { name: /第一条/ })).toBeInTheDocument()
  })

  it('左栏收起时右栏必须仍然显示，不能两栏都没了', () => {
    render(
      <Wrap>
        <Workbench
          list={<WorkbenchItem title="第一条" />}
          placeholder={<EmptyState title="还没选中" />}
          selected={false}
          listCollapsed
        />
      </Wrap>,
    )
    // 这一条守的是一个真实的组合：收起左栏 + 还没选中。两个条件各自都会让
    // 某一栏隐藏，写不好就是整块空白——而这两个条件同时成立并不罕见。
    expect(screen.getByText('还没选中')).toBeVisible()
  })

  it('窄屏返回按钮把选中态交回给调用方', async () => {
    const user = userEvent.setup()
    const onBack = vi.fn()
    render(
      <Wrap>
        <Workbench
          list={<WorkbenchItem title="第一条" />}
          detail={<div>详情内容</div>}
          selected
          onBack={onBack}
          backLabel="返回列表"
        />
      </Wrap>,
    )
    await user.click(screen.getByRole('button', { name: '返回列表' }))
    expect(onBack).toHaveBeenCalledTimes(1)
  })
})

describe('剪贴板页（真渲染）', () => {
  async function renderClipboard() {
    const { ClipboardScreen } = await import('@/components/ClipboardScreen')
    const view = render(
      <Wrap>
        <ClipboardScreen isProfessional />
      </Wrap>,
    )
    await screen.findAllByText('第一条剪贴板内容')
    return view
  }

  const listOf = (c: HTMLElement) => c.querySelector('[data-testid="workbench-list"]') as HTMLElement
  const detailOf = (c: HTMLElement) => c.querySelector('[data-testid="workbench-detail"]') as HTMLElement

  /** 左栏当前第一行的正文；断言“右栏跟着第一行”时用它，不写死条目，免得排序改动误红。 */
  function firstRowText(container: HTMLElement): string {
    const row = listOf(container).querySelector('[role="button"]') as HTMLElement
    const p = row.querySelector('p.line-clamp-3') as HTMLElement
    return p.textContent ?? ''
  }

  it('列表渲染出来了，右栏默认落在第一条上', async () => {
    const { container } = await renderClipboard()
    const list = listOf(container)
    expect(within(list).getByText('第一条剪贴板内容')).toBeVisible()
    expect(within(list).getByText('第二条剪贴板内容')).toBeVisible()

    // 0.1.19 起右栏不再是一句占位语。此前这里是 1266×590 的空地，中间写着
    // 「从左边挑一条」——用户报的"上下都为空白"就是它。
    const detail = detailOf(container)
    expect(within(detail).getByText(tk('clipboard:detailTimeLabel'))).toBeVisible()
    expect(detail.textContent).toContain(firstRowText(container))
    expect(screen.queryByText(tk('clipboard:detailEmptyState'))).toBeNull()
  })

  it('点行仍然是粘贴，不是选中——详情只能从那颗独立按钮进', async () => {
    const user = userEvent.setup()
    const view = await renderClipboard()

    // 规矩不变：点整行 = 立刻粘贴，不是选中。右栏默认落在第一条，故判据改为：点第二行，右栏不许换成第二条。
    const { container } = view
    const detail = () => detailOf(container)
    const shownAtStart = firstRowText(container)
    expect(detail().textContent).toContain(shownAtStart)

    // 另外那一条：点它整行，右栏**不许**跟着换过去。
    const other = shownAtStart.includes('第一条') ? '第二条剪贴板内容' : '第一条剪贴板内容'
    await user.click(within(listOf(container)).getByText(other))
    expect(detail().textContent).toContain(shownAtStart)
    expect(detail().textContent).not.toContain(other)

    // 那颗独立的「查看」按钮才把内容送进右栏。
    // 按**所在行**定位，不按下标。
    const row = within(listOf(container)).getByText(other).closest('[role="button"]') as HTMLElement
    await user.click(within(row).getByRole('button', { name: tk('clipboard:openDetailButton') }))

    expect(within(detail()).getByText(tk('clipboard:detailTimeLabel'))).toBeVisible()
    expect(detail().textContent).toContain(other)
  })
})

/**
 * 直接验“图标悬停要显示功能名称”：静态检查只证明源码写了 Tooltip，
 * Radix 拿不到子元素 ref、被 `pointer-events-none` 挡掉、portal 没挂上都会让它静默失效，所以真移鼠标。
 */
describe('界面内的图标，鼠标停上去要报出功能名称', () => {
  it('剪贴板行内那颗纯图标按钮，悬停后弹出它的名字', async () => {
    const user = userEvent.setup()
    const { ClipboardScreen } = await import('@/components/ClipboardScreen')
    render(
      <Wrap>
        <ClipboardScreen isProfessional />
      </Wrap>,
    )
    await screen.findByText('第一条剪贴板内容')

    const row = screen.getByText('第一条剪贴板内容').closest('[role="button"]') as HTMLElement
    // 行内只剩「查看」和「更多操作」两颗图标按钮（其余操作收进菜单）；守的是行内纯图标按钮悬停必须报名字。
    const iconButton = within(row).getByRole('button', { name: tk('clipboard:rowMenuButton') })

    await user.hover(iconButton)
    // Radix 把提示渲染进 portal，所以在整个 document 里找，不是在 row 里找。
    const tip = await screen.findAllByText(tk('clipboard:rowMenuButton'), {}, { timeout: 3000 })
    // 至少两处：按钮自己的可访问名字 + 弹出来的那块提示。
    expect(tip.length).toBeGreaterThan(1)
  })

  it('行里不再铺着一排操作按钮，内容才有宽度可用', async () => {
    const { ClipboardScreen } = await import('@/components/ClipboardScreen')
    render(
      <Wrap>
        <ClipboardScreen isProfessional />
      </Wrap>,
    )
    await screen.findByText('第一条剪贴板内容')

    const row = screen.getByText('第一条剪贴板内容').closest('[role="button"]') as HTMLElement
    // 「查看」+「更多操作」+ 勾选框。九颗操作按钮全部离开了这一行。
    expect(within(row).getAllByRole('button').length).toBeLessThanOrEqual(2)
    // 而内容本身还在——这条才是用户报的那个故障（"每条历史记录没有正常显示"）。
    expect(within(row).getByText('第一条剪贴板内容')).toBeInTheDocument()
  })
})

/**
 * 功能收进顶栏后菜单要真弹得出来：TopBar 的 menus 是纯配置，
 * Menubar 的 Trigger/Content 缺一边 Radix 上下文就点了没反应、不报错，所以真点。
 */
describe('剪贴板：功能收进一行顶栏之后仍然管用', () => {
  const nameLike = (text: string) => new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))

  it('顶栏是一条菜单条，各组功能都是上面的一个菜单', async () => {
    const { ClipboardScreen } = await import('@/components/ClipboardScreen')
    render(
      <Wrap>
        <ClipboardScreen isProfessional />
      </Wrap>,
    )
    await screen.findByText('第一条剪贴板内容')

    const bar = screen.getByRole('menubar')
    for (const key of ['clipboard:menuView', 'clipboard:menuCategory', 'clipboard:menuData']) {
      expect(within(bar).getByRole('menuitem', { name: nameLike(tk(key)) })).toBeInTheDocument()
    }
  })

  it('点某个菜单能弹出那一组的具体功能', async () => {
    const user = userEvent.setup()
    const { ClipboardScreen } = await import('@/components/ClipboardScreen')
    render(
      <Wrap>
        <ClipboardScreen isProfessional />
      </Wrap>,
    )
    await screen.findByText('第一条剪贴板内容')

    // 没点开之前没有弹出的菜单——「导入」这类功能不再常驻占一整行。
    expect(screen.queryByRole('menu')).toBeNull()

    const bar = screen.getByRole('menubar')
    await user.click(within(bar).getByRole('menuitem', { name: nameLike(tk('clipboard:menuData')) }))

    // 在弹出来的那一块里找：顶栏上「导入导出」这个触发器本身的名字也含「导入」。
    const menu = await screen.findByRole('menu')
    expect(within(menu).getByRole('menuitem', { name: nameLike(tk('clipboard:importButton')) })).toBeVisible()
  })
})
