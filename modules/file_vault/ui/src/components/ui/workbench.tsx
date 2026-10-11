import * as React from 'react'
import { ChevronLeft } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import { cn } from '@/lib/utils'
import { FEATURE_TITLE_CLASS, IconChip, NUMERIC_CLASS, type Tone } from '@/components/ui/page'

// 双栏工作台：左边永远是清单，右边永远是这一条的详情（文件、笔记、密码、恢复密钥、已配对设备、剪贴
// 板历史共用）。左选右看，选中项不消失，操作按钮永远在右栏顶部同一位置。三条约束：1. 不认识自己装的
// 是什么：左右栏内容都由调用方传入，新增"一堆里挑一个"的功能无需改这里。2. 左栏自己滚，不随页面滚；
// 两栏各自 overflow-y-auto，避免滚到第 200 行时右栏只剩底部。3. 窄窗口（lg 以下）一次只显示一栏（无
// 选中显示清单，选中显示详情 + 返回）；切换是纯 CSS，不重新挂载，列表滚动位置保留。

/**
 * 两栏高度跟着父容器长，不自己算。原先 `lg:h-[calc(100svh−13rem)]` 减的是别的组件的高度，必然过期
 * （实测 1920×1080 密码页底部空出 63px，剪贴板页则捅出视口、页面与左栏滚动条同时出现）。换成
 * `min-h-0 flex-1`，`min-h-0` 不能省：flex 子项默认 `min-height:auto` 会让 `overflow-y-auto` 永远
 * 不生效。窄屏（lg 以下）两栏上下叠放，仍给高度上限，否则左栏会把右栏推出屏幕。/
 */
const PANE_HEIGHT = 'min-h-0 lg:flex-1'

/**
 * 嵌在会滚动的长页面里时用的高度。上面的 `flex-1` 要求父级高度确定，设备与同步页是整页自己滚的文档
 * 型页面，无处可分，两栏会按内容撑开。这一档给自己说了算的高度：占窗口六成但不超过 620px，不引用别
 * 处尺寸，所以不会像被删掉的 calc 那样过期。/
 */
const EMBEDDED_HEIGHT = 'lg:h-[min(60svh,620px)]'

export function Workbench({
  /** 左栏顶部不跟着滚的那一条：搜索、筛选、"新建"。 */
  listHeader,
  list,
  /**
   * 左栏滚动容器的 ref。虚拟列表（@tanstack/react-virtual）需知道谁在滚；交给调用方而不再套一层滚动
   * 容器，避免嵌套滚动：滚轮到底后事件冒泡会让页面整体跳一下。
   */
  listRef,
  /**
   * 直接摊到左栏滚动容器上的属性（拖放回调、data-* 等）。不为每种用途加具名 prop，否则组件会变成所有
   * 调用方需求的并集，失去"不认识自己装的是什么"的价值。
   */
  listProps,
  detail,
  /** 右栏在"还没选中任何一条"时显示什么。传 `<EmptyState>` 最自然。 */
  placeholder,
  /** 有没有选中项。它同时决定窄屏下显示哪一栏。 */
  selected = false,
  /** 窄屏详情页左上角那颗返回按钮。不传就不画——宽屏本来也不需要它。 */
  onBack,
  backLabel,
  /** 左栏宽度。列表项是长文件名时用 wide。 */
  listWidth = 'default',
  /** 用户主动收起左栏、右栏铺满；与窄屏自动让位（`selected`）共用 DOM，展开后列表滚动位置保留。 */
  listCollapsed = false,
  /** true 为长页面里的一个分区（自定高度，见 EMBEDDED_HEIGHT）；false 为整页主体，跟随 PageShell `fill` 的有界 flex 高度。 */
  embedded = false,
  className,
}: {
  listHeader?: React.ReactNode
  list: React.ReactNode
  listRef?: React.Ref<HTMLDivElement>
  listProps?: Omit<React.ComponentProps<'div'>, 'ref' | 'children'>
  detail?: React.ReactNode
  placeholder?: React.ReactNode
  selected?: boolean
  onBack?: () => void
  backLabel?: string
  listWidth?: 'default' | 'wide'
  listCollapsed?: boolean
  embedded?: boolean
  className?: string
}) {
  return (
    <div
      className={cn(
        'grid min-h-0 overflow-hidden rounded-xl border border-border/70 bg-card',
        // `flex-1` 要求父级高度有界（PageShell 的 fill 档），两者缺一不可。
        embedded ? EMBEDDED_HEIGHT : 'lg:min-h-0 lg:flex-1',
        listCollapsed
          ? 'lg:grid-cols-1'
          : listWidth === 'wide'
            ? 'lg:grid-cols-[minmax(280px,420px)_minmax(0,1fr)]'
            : 'lg:grid-cols-[minmax(240px,320px)_minmax(0,1fr)]',
        className,
      )}
    >
      <div
        // 两栏各挂 testid，测试才能指明哪一栏（同名会同时出现在左栏行和右栏标题里）。
        data-testid="workbench-list"
        className={cn(
          'flex min-h-0 min-w-0 flex-col border-border/70 bg-surface/50',
          'max-h-[62svh] border-b lg:max-h-none lg:border-b-0 lg:border-e',
          PANE_HEIGHT,
          // 窄屏且已选中：让位给详情。用 hidden 而不是卸载，滚动位置才保得住。
          selected && 'hidden lg:flex',
          // 主动收起：所有宽度下都藏起来，同样不卸载。
          listCollapsed && 'hidden lg:hidden',
        )}
      >
        {listHeader && (
          <div className="flex shrink-0 flex-col gap-2 border-b border-border/70 px-4 py-3">
            {listHeader}
          </div>
        )}
        <div
          {...listProps}
          ref={listRef}
          className={cn('min-h-0 flex-1 overflow-y-auto', listProps?.className)}
        >
          {list}
        </div>
      </div>
      <div
        data-testid="workbench-detail"
        className={cn(
          'flex min-h-0 min-w-0 flex-col overflow-y-auto',
          PANE_HEIGHT,
          // 左栏收起时右栏必须在所有宽度下都显示——否则窄屏 + 没选中 = 整块空白。
          !selected && !listCollapsed && 'hidden lg:flex',
        )}
      >
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            className="ds-focus-ring flex shrink-0 items-center gap-1.5 border-b border-border/70 px-5 py-3 text-sm text-muted-foreground transition-colors hover:text-foreground lg:hidden"
          >
            <ChevronLeft className="size-4" aria-hidden="true" />
            {backLabel}
          </button>
        )}
        {selected ? detail : placeholder}
      </div>
    </div>
  )
}

/** 左栏的一行：选中态用左侧 2px 强调色竖线加浅底，不整行反白（浅色主题下会毁掉文字对比度）。 */
export function WorkbenchItem({
  icon,
  tone = 'accent',
  title,
  meta,
  active = false,
  className,
  ...props
}: Omit<React.ComponentProps<'button'>, 'title'> & {
  icon?: LucideIcon
  tone?: Tone
  title: React.ReactNode
  /** 右侧那一小段：大小、条数、时间。数字走 .tabular，上下才对得齐。 */
  meta?: React.ReactNode
  active?: boolean
}) {
  return (
    <button
      type="button"
      aria-current={active ? 'true' : undefined}
      className={cn(
        'ds-focus-ring flex w-full items-center gap-3 border-b border-border/50 px-4 py-3 text-start transition-colors',
        'hover:bg-accent-soft/60',
        active ? 'bg-accent-soft shadow-[inset_2px_0_0_var(--primary)]' : 'bg-transparent',
        className,
      )}
      {...props}
    >
      {icon && <IconChip icon={icon} tone={tone} size="sm" className="shrink-0" />}
      <span className="min-w-0 flex-1 truncate text-sm">{title}</span>
      {meta != null && (
        <span className={cn('shrink-0 text-2xs text-muted-foreground', NUMERIC_CLASS)}>{meta}</span>
      )}
    </button>
  )
}

/** 右栏顶部：所选条目的名称与操作按钮；与 `PageHeader` 右上角同规则，只是作用域为选中项。 */
export function WorkbenchDetailHeader({
  icon,
  tone = 'accent',
  title,
  actions,
  className,
}: {
  icon?: LucideIcon
  tone?: Tone
  title: React.ReactNode
  actions?: React.ReactNode
  className?: string
}) {
  return (
    <header
      className={cn(
        // 不加 `shrink-0`：父级是 flex 列，它管的是纵向，与 flex-wrap 的横向换行无关，
        // 抄到横向容器上会废掉 flex-wrap（曾横向溢出 292px）；默认 min-height:auto 已够用。
        'flex flex-wrap items-center justify-between gap-x-4 gap-y-3 border-b border-border/70 px-6 py-4',
        className,
      )}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        {icon && <IconChip icon={icon} tone={tone} size="md" className="shrink-0" />}
        <h2 className={cn(FEATURE_TITLE_CLASS, 'min-w-0 truncate')}>{title}</h2>
      </div>
      {/* ---- `shrink-0` 和 `flex-wrap` 不能一起写 -------------------------
          这里原先是 `flex shrink-0 flex-wrap`。两条互相抵消：`flex-wrap` 说
          "放不下就换行"，可换不换行取决于**这个盒子自己有多宽**，而 `shrink-0`
          恰恰不许它比内容窄。于是它按内容排成一长条，然后整条捅出父容器。

          2026-08-19 真浏览器实测（1280×720，剪贴板页）：
              右栏可用宽 626px，这一组按钮排出来 919px，右边界 1572
              而窗口只有 1280 —— **横着溢出 292px**，最右边那颗「删除」
              有一半在屏幕外，页面还多出一条横向滚动条。

          去掉 `shrink-0` 之后 flex 会先把它压到可用宽度，`flex-wrap` 这才有
          机会生效——按钮排不下就折到第二行，一颗都不会跑到屏幕外。
          `min-w-0` 是配套的：没有它，flex 子项的 `min-width:auto` 会把"不能
          比内容窄"这条从另一个门再放进来一次。 */}
      {actions && <div className="flex min-w-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  )
}

/** 右栏正文。内边距和 `PageSection` 对齐，两种容器换着用时留白不跳。 */
export function WorkbenchDetailBody({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn('flex min-h-0 flex-1 flex-col gap-6 p-6', className)}>{children}</div>
}
