import * as React from 'react'
import { ChevronDown } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import { cn } from '@/lib/utils'

// 页面骨架：全应用每个面板都由这几件拼成，使统一在结构上无法写歪，新面板只需 PageShell + PageHeader
// + PageSection。规则：1. 主操作永远在 PageHeader 右上角（actions）。2. 层级只靠背景明度和一像素边
// 框，不叠投影；边框用 border/70，满强度会把注意力拉到框上。2b. 留白一起定：页面四周 px-10 py-9、块
// 间 gap-7、卡内 p-6，单独调一个会破坏节奏。3. 正文一律 text-sm（= 16px，见 index.css）；分区标题
// text-sihao（四号），页面主标题 text-2xl，三档为止。

/** 语义色调。全应用共用这一组，不按模块分色——每个模块的颜色是统一的，
 *  变化只来自状态（成功/警告/危险/信息），这样颜色本身就有确定含义。 */
export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info'

const TONE_CHIP: Record<Tone, string> = {
  neutral: 'bg-muted border-border text-muted-foreground',
  accent: 'bg-accent-soft border-accent-line text-primary',
  success: 'bg-success/12 border-success/30 text-success',
  warning: 'bg-warning/12 border-warning/30 text-warning',
  danger: 'bg-destructive/12 border-destructive/30 text-destructive',
  info: 'bg-info/12 border-info/30 text-info',
}

const TONE_BADGE: Record<Tone, string> = {
  neutral: 'bg-muted text-muted-foreground ring-border',
  accent: 'bg-accent-soft text-primary ring-accent-line',
  success: 'bg-success/12 text-success ring-success/25',
  warning: 'bg-warning/12 text-warning ring-warning/25',
  danger: 'bg-destructive/12 text-destructive ring-destructive/25',
  info: 'bg-info/12 text-info ring-info/25',
}

/** 图标底片：所有"图标 + 文字"组合都走它，sm 行内、md 分区标题、lg 页面标题和空状态。 */
export function IconChip({
  icon: Icon,
  tone = 'accent',
  size = 'md',
  className,
}: {
  icon: LucideIcon
  tone?: Tone
  size?: 'sm' | 'md' | 'lg'
  className?: string
}) {
  const box = size === 'lg' ? 'size-11' : size === 'sm' ? 'size-7' : 'size-9'
  const glyph = size === 'lg' ? 'size-5' : size === 'sm' ? 'size-4' : 'size-4'
  return (
    <span aria-hidden="true" className={cn('ds-icon-chip', box, TONE_CHIP[tone], className)}>
      <Icon className={glyph} />
    </span>
  )
}

/**
 * 面板最外层。`width` 四档：default 表单页（限宽好读）、wide 列表/表格页、canvas 双栏工作台、
 * full 自己管理滚动的页面（笔记分栏编辑器、聊天）；限宽用 max-w 以便窄窗口自然收起。
 * canvas 必须存在：`max-w` 是为阅读行长服务的，双栏工作台没有长文本行，限宽只会减少可同时看到的条目
 * （1920 屏上 wide 档两侧白给 408px）。canvas = 不限宽 + 更薄横向留白（lg 档 px-6），竖向留白不变。
 */
export function PageShell({
  width = 'default',
  fill = false,
  className,
  children,
  ...props
}: React.ComponentProps<'div'> & {
  width?: 'default' | 'wide' | 'canvas' | 'full'
  /**
   * 页面自己吃满窗口高度、内部分配剩余空间，整体不滚动。双栏工作台必须开，否则 `flex-1` 无确定高度的
   * 父级（原 `calc(100svh−13rem)` 会过期，实测底部空出 63px）。文档型页面（帮助、设置、关于）不要开
   * ，否则下半截够不着。/
   */
  fill?: boolean
}) {
  return (
    <div
      className={cn(
        'ds-page-wash w-full',
        // 有界模式：高度由父级 flex 列给，内部不滚。非有界模式自己滚，`min-h-0` 不能换成 `min-h-full`：
        // `min-height:100%` 会钉死在 `<main>` 整高上，而 main 里还有「接着刚才」横幅，多出的一截被
        // overflow-hidden 裁掉。flex 子项默认 `min-height:auto` 也会顶掉 overflow-y-auto，所以必须显式写 0
        // 。
        fill ? 'flex min-h-0 flex-1 flex-col overflow-hidden' : 'min-h-0 flex-1 overflow-y-auto',
        className,
      )}
      {...props}
    >
      <div
        className={cn(
          fill && 'min-h-0 flex-1',
          // 留白节奏分三档随窗口宽度变：窄 px-5 py-7 gap-6 / sm px-9 py-9 gap-7 / lg px-14 py-11 gap-8。
          // 必须分档：宽档留白在窄窗口（700px 减 184px 侧栏）会把内容挤到 404px，表格被迫横向滚动。
          // 块间距比卡内边距(p-6)大一档，不用边框或投影就能分层。
          // 上下不对称：上边只收窄（顶着屏幕边缘的纯空白），下边保留作为滚到底的呼吸位。
          'mx-auto flex w-full flex-col gap-6 pt-4 pb-7 sm:gap-7 sm:pt-5 sm:pb-9 lg:gap-8 lg:pt-6 lg:pb-11',
          // 横向留白：canvas 档单独一套（见上面长注释），其余三档共用原来那套。
          width === 'canvas'
            ? 'px-4 sm:px-5 lg:px-6'
            : 'px-5 sm:px-9 lg:px-14',
          width === 'default' && 'max-w-[1100px]',
          // 1440 -> 1600：1920 屏减侧栏约 1736px，1600 + 两侧各 56px 留白刚好铺满。
          // 保留上限是因为这几页是卡片栅格，超宽屏不限宽会让每行摊开五六张卡、文字拉成细线。
          width === 'wide' && 'max-w-[1600px]',
          width === 'canvas' && 'max-w-none',
          width === 'full' && 'max-w-none',
        )}
      >
        {children}
      </div>
    </div>
  )
}

/**
 * 页面顶部操作条，放本页最重要的操作和关键数字，不写页面名也不写说明（用户刚从高亮的导航栏点进来，
 * 重复念一遍只是浪费最贵的那条横带）。标题不删而是 `sr-only`：读屏用户没有导航高亮这条视觉线索，且
 * h1 大纲仍需成立。没有操作也没有数字时整条不画，否则只剩孤零零的图标和分隔线。
 * `tests/pageHeaderStandfirst.test.mjs` 守两头：再出现 `description=`，或标题不再 `sr-only`，都会
 * 红。/
 */
// 字号三档的唯一定义处，加新界面只能从这三个里挑：PAGE_TITLE_CLASS 页面主标题（最大）；
// FEATURE_TITLE_CLASS 功能名称/分区标题（四号）；正文 text-sm（= 16px，小四）。
// `tests/typographyScale.test.mjs` 扫全部界面，出现三档以外的标题字号或 text-[10px] 这类小于 16px
// 的任意值就失败。

/** 页面主标题的类名。需要自定义标签或额外类时用它，否则直接用 `<PageTitle>`。 */
export const PAGE_TITLE_CLASS = 'font-heading text-2xl leading-tight font-semibold tracking-tight'

/** 功能名称 / 分区标题的类名（四号，比正文大一档）。 */
export const FEATURE_TITLE_CLASS = 'font-heading text-sihao leading-snug font-medium'

/**
 * 凡是"上下要对齐或会刷新的数字"都用它（文件大小、条数、百分比、耗时、日期）。
 * 只开 `tabular-nums` 不够：--font-sans 首选 Times New Roman，数字是比例宽度，列内小数点对不齐。
 * `.tabular`（index.css）另开 `slashed-zero` 区分 0 和 O（路径、哈希里最易混）。
 * 这里是数字样式的唯一来源，别处不要再写第二份；守卫见 `tests/typographyScale.test.mjs`。
 */
export const NUMERIC_CLASS = 'tabular'

/** 数值。仪表盘磁贴、测速结果、专业指标共用——它们是**数字不是文字**，
 *  刷新时不该左右跳动。 */
export const METRIC_VALUE_CLASS = `text-2xl font-semibold ${NUMERIC_CLASS}`

/**
 * 紧凑数值，用于 `PageHeader` 的 metrics 槽。标题行高度由最高元素决定，text-2xl 磁贴会撑高标题行、
 * 抢掉页面主标题的主次；降到四号（text-sihao）仍比正文大一格。
 * 与 METRIC_VALUE_CLASS 一样是唯一定义处，别处只能通过 `<MetricValue size="compact">` 引用。
 */
export const METRIC_VALUE_COMPACT_CLASS = `text-sihao font-semibold ${NUMERIC_CLASS}`

/**
 * 「这一屏要回答的问题的答案」那一档字号，一屏最多一处（出现两个这么大的数则都失去意义）。为清理套
 * 件 240px 圆环里的主数字破一次三档刻度；登记在 `tests/typographyScale.test.mjs` 的 ALLOWED 里，且
 * 只允许 1 处：定义在这里，别处只能引用这个常量，不能自己写 text-4xl。/
 */
export const HERO_VALUE_CLASS = `text-4xl font-semibold leading-none ${NUMERIC_CLASS}`

/** 品牌字标。登录页和首次向导都要显示，抄成两份迟早会分家。 */
export const WORDMARK_CLASS = 'font-heading text-2xl font-semibold tracking-[0.14em] text-primary'

/** 页面主标题。整个应用的一级标题只能由它产出。 */
export function PageTitle({ className, children, ...props }: React.ComponentProps<'h1'>) {
  return (
    <h1 className={cn(PAGE_TITLE_CLASS, className)} {...props}>
      {children}
    </h1>
  )
}

/**
 * 数值展示，刻意偏大（常是面板要回答的答案）；`size="compact"` 给标题行磁贴。
 * 字号在此定死，调用方不能自写。
 */
export function MetricValue({
  size = 'default',
  className,
  children,
  ...props
}: React.ComponentProps<'p'> & { size?: 'default' | 'compact' }) {
  return (
    <p
      className={cn(size === 'compact' ? METRIC_VALUE_COMPACT_CLASS : METRIC_VALUE_CLASS, className)}
      {...props}
    >
      {children}
    </p>
  )
}

/** 产品字标。名字在六种语言里都写作 Tessera，所以不进翻译文件。 */
export function Wordmark({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span className={cn(WORDMARK_CLASS, className)} {...props}>
      TESSERA
    </span>
  )
}

/** 功能名称/分区标题（四号）。`as` 只改语义标签（h2/h3 跟文档结构走），外观必须一模一样。 */
export function FeatureTitle({
  as: Tag = 'h2',
  className,
  children,
  ...props
}: React.ComponentProps<'h2'> & { as?: 'h2' | 'h3' | 'p' }) {
  return (
    <Tag className={cn(FEATURE_TITLE_CLASS, className)} {...props}>
      {children}
    </Tag>
  )
}

export function PageHeader({
  title,
  metrics,
  actions,
  className,
}: {
  /** 只给读屏软件和文档大纲用，画面上看不见。 */
  title: React.ReactNode
  /**
   * 本页统计数字（`<StatTile compact>`）。放在标题行而非其下一排：它们回答"本页现在什么状况"，
   * 应与标题一起读，放下面会占整行高度、推下真正内容，且切视图时出现/消失造成页面跳动。
   * 排在 `actions` 左边：右上角是全应用固定的主操作位，不能被数字挤走。
   * 窄窗口 metrics + actions 整体掉到标题下一行（外层 flex-wrap），不会压没标题。
   */
  metrics?: React.ReactNode
  actions?: React.ReactNode
  className?: string
}) {
  // 标题永远在，操作带只在有内容时才画（见组件头注释）。两者必须是兄弟，不能"没东西就直接 return 标题
  // "：那样数据到达时根元素会从 <h1> 变成 <header>，React 会卸载重挂整棵子树，统计磁贴闪一下且内部状
  // 态被清空。外层永远是同一个 Fragment。
  return (
    <>
      <PageTitle className="sr-only">{title}</PageTitle>
      {(metrics || actions) && (
        <header
          className={cn(
            // `pb-6` -> `pb-3`：横线是上方数字/按钮那一组的下边界，24px 间隙像另起一段还白占列表高度；12px 足够
            // 分开又不飘。
            'flex flex-wrap items-center justify-between gap-x-6 gap-y-4 border-b border-border/70 pb-3',
            className,
          )}
        >
          <div className="flex min-w-0 flex-wrap items-center gap-2">{metrics}</div>
          {/* `shrink-0` 去掉了：它和 `flex-wrap` 互相抵消——不许比内容窄，
              就永远没有"放不下"这件事，于是按钮排成一长条捅出窗口。
              实测见 workbench.tsx 里 WorkbenchDetailHeader 同一处的注释
              （剪贴板页 1280 宽的窗口横着溢出 292px）。 */}
          <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">{actions}</div>
        </header>
      )}
    </>
  )
}

/** 内容分区卡片，每块功能一张。`tone` 只改标题栏图标和左侧竖线的颜色，整卡上色一屏三四张会很吵。 */
export function PageSection({
  icon,
  title,
  actions,
  tone = 'accent',
  padded = true,
  collapsible = false,
  defaultExpanded = true,
  storageKey,
  onExpandedChange,
  className,
  contentClassName,
  children,
}: {
  icon?: LucideIcon
  title?: React.ReactNode
  actions?: React.ReactNode
  tone?: Tone
  /** 表格/列表这类自带内边距的内容传 false，避免出现双层留白 */
  padded?: boolean
  /** 标题栏可点，整块内容能收起来。见下方长注释。 */
  collapsible?: boolean
  defaultExpanded?: boolean
  /** 传了就把展开状态记进 localStorage，下次打开还是上次的样子。 */
  storageKey?: string
  /**
   * 展开状态变化时通知宿主（含挂载时报一次当前值），让宿主在收起时停掉这块内容的开销
   * （如每秒刷新的实时指标的定时器）。
   */
  onExpandedChange?: (expanded: boolean) => void
  className?: string
  contentClassName?: string
  children?: React.ReactNode
}) {
  const hasHeader = Boolean(title || actions)
  const [expanded, setExpanded] = useSectionExpanded(storageKey, defaultExpanded)
  // collapsible 关掉时永远当展开处理——否则给一个不可折叠的分区传了
  // defaultExpanded={false} 会得到一块永远打不开的内容。
  const open = !collapsible || expanded

  // 挂载时也报一次：宿主要靠它决定初始状态下要不要启动定时器，
  // 只在切换时通知的话，"打开页面时本来就是收起的"这一档会被漏掉。
  React.useEffect(() => {
    onExpandedChange?.(open)
  }, [open, onExpandedChange])

  return (
    <section className={cn('overflow-hidden rounded-xl border border-border/70 bg-card', className)}>
      {hasHeader && (
        <header
          className={cn(
            'flex flex-wrap items-center justify-between gap-x-4 gap-y-2 bg-surface/60 px-6 py-4',
            // 收起时不画那条分隔线：线下面什么都没有，留着会像是内容加载失败了。
            open && 'border-b border-border/70',
          )}
        >
          <div className="flex min-w-0 flex-1 items-center gap-2.5">
            {icon && <IconChip icon={icon} tone={tone} size="sm" />}
            <div className="min-w-0">
              {title && <h2 className="font-heading text-sihao leading-snug font-medium">{title}</h2>}
            </div>
          </div>
          {/* 同上：`shrink-0` + `flex-wrap` 是互相抵消的一对，见 PageHeader。 */}
          {actions && <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">{actions}</div>}
          {collapsible && (
            // 折叠开关是独立按钮而非整条标题栏可点：标题栏里常有刷新、切换等按钮，整条可点会连带把分区收起来。
            <button
              type="button"
              onClick={() => setExpanded(!expanded)}
              aria-expanded={open}
              className="ds-focus-ring shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <ChevronDown
                className={cn('size-4 transition-transform duration-150', open && 'rotate-180')}
                aria-hidden="true"
              />
              <span className="sr-only">{title}</span>
            </button>
          )}
        </header>
      )}
      {open && <div className={cn(padded && 'p-6', contentClassName)}>{children}</div>}
    </section>
  )
}

/**
 * 分区展开状态，可选记进 localStorage。折叠做在共享组件里（任何页面加 `collapsible` 即得一致行为）
 * ，避免各页箭头方向、动画、是否记状态不一。安卓端（`Sections.kt`）同一约定：右侧向下箭头、展开转
 * 180°、状态持久化。localStorage 读写都包 try：隐私模式或存储被禁时会抛，记不住折叠状态不能演变成
 * 整页白屏。/
 */
function useSectionExpanded(
  storageKey: string | undefined,
  defaultExpanded: boolean,
): [boolean, (value: boolean) => void] {
  const [expanded, setExpandedState] = React.useState<boolean>(() => {
    if (!storageKey) return defaultExpanded
    try {
      const raw = window.localStorage.getItem(`section:${storageKey}`)
      return raw === null ? defaultExpanded : raw === '1'
    } catch {
      return defaultExpanded
    }
  })

  const setExpanded = React.useCallback(
    (value: boolean) => {
      setExpandedState(value)
      if (!storageKey) return
      try {
        window.localStorage.setItem(`section:${storageKey}`, value ? '1' : '0')
      } catch {
        // 记不住就算了，不影响这一次的折叠行为。
      }
    },
    [storageKey],
  )

  return [expanded, setExpanded]
}

/**
 * 主栏 + 侧栏两栏（杂志版式）：主栏放这页要干的事，侧栏放背景信息（状态、上次结果、注意事项），
 * 免得背景切断阅读线。比例 3:1，等宽则没有主次。
 * lg 以下堆成一列，侧栏在主栏之后（DOM 顺序即如此），先看要干的事。
 */
export function PageColumns({
  aside,
  className,
  children,
}: {
  /** 侧栏内容。不传就是普通单栏，调用方不需要写条件分支。 */
  aside?: React.ReactNode
  className?: string
  children: React.ReactNode
}) {
  if (!aside) return <div className={cn('flex flex-col gap-8', className)}>{children}</div>
  return (
    <div className={cn('grid gap-8 lg:grid-cols-[3fr_1fr] lg:items-start', className)}>
      <div className="flex min-w-0 flex-col gap-8">{children}</div>
      <aside className="flex min-w-0 flex-col gap-5">{aside}</aside>
    </div>
  )
}

/** 统一工具栏，比 PageSection 轻一档，用在列表上方放筛选/批量操作。 */
export function Toolbar({ className, children, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2',
        className,
      )}
      {...props}
    >
      {children}
    </div>
  )
}

/** 空状态。虚线边框是刻意的：读起来是"这里以后会有东西"，实线则是"就这样了"。 */
export function EmptyState({
  icon,
  title,
  action,
  className,
}: {
  icon?: LucideIcon
  title: React.ReactNode
  action?: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border bg-surface px-6 py-12 text-center',
        className,
      )}
    >
      {icon && <IconChip icon={icon} size="lg" />}
      <div className="space-y-1">
        <p className="font-heading text-sihao font-medium">{title}</p>
      </div>
      {action && <div className="pt-1">{action}</div>}
    </div>
  )
}

/** 状态徽章。用 ring 而非 border，盒模型尺寸不受边框影响，混在文字行里更稳。 */
export function Badge({
  tone = 'neutral',
  icon: Icon,
  className,
  children,
  ...props
}: React.ComponentProps<'span'> & { tone?: Tone; icon?: LucideIcon }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-2xs leading-5 font-medium ring-1 ring-inset',
        TONE_BADGE[tone],
        className,
      )}
      {...props}
    >
      {Icon && <Icon className="size-3.5 shrink-0" aria-hidden="true" />}
      {children}
    </span>
  )
}

/** 键值行，设置页/关于页/详情面板的统一写法；窄屏自动从两栏折成上下两行。 */
export function DetailRow({
  label,
  children,
  className,
}: {
  label: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'flex flex-col gap-1 py-2.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-6',
        className,
      )}
    >
      <span className="shrink-0 text-sm text-muted-foreground">{label}</span>
      <span className="min-w-0 text-sm sm:text-right">{children}</span>
    </div>
  )
}
