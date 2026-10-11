import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')

const APPSHELL = read('../src/components/AppShell.tsx')
const PAGE = read('../src/components/ui/page.tsx')
const WORKBENCH = read('../src/components/ui/workbench.tsx')
const LABELMODE = read('../src/lib/labelMode.tsx')
const CHECKBOX = read('../src/components/ui/checkbox.tsx')
const TOOLTIP = read('../src/components/ui/tooltip.tsx')
const DROPDOWN = read('../src/components/ui/dropdown-menu.tsx')
const PASSWORDS = read('../src/components/PasswordScreen.tsx')
const CLIPBOARD = read('../src/components/ClipboardScreen.tsx')
const NOTES = read('../src/components/NotesScreen.tsx')

// 守卫「上下也是空白」类故障。真浏览器量出的四个成因：
//   1. 高度链断了：工作台自己减视口高度 `calc(100svh - 13rem)`，13rem 代表标题行+留白，
//      标题行改 sr-only、图标槽拆除后，密码页底部空 63px，剪贴板页反而溢出出滚动条。
//   2. 右栏默认只有一句「选择左侧一条记录」。
//   3. 笔记列表写死 h-64（256px），左栏有 890px。
//   4. 剪贴板行内带文字的按钮吃掉 304px，411px 的行只剩 5px 给内容。
// 静态测试量不到像素，只守成因（减法在不在、fill 有没有传、写死高度是否回来、行区域只准图标）；
// 像素由 measure.html + Playwright 探针负责（见 src/measure.tsx）。

test('高度链是真的：根是定高，main 是有界 flex 列', () => {
  assert.match(
    APPSHELL,
    /className="flex h-screen overflow-hidden bg-background"/,
    '根必须 h-screen（定高）而不是 min-h-screen（只有下限）——' +
      '否则里面任何 flex-1 都没有可分的高度，只能自己去减视口',
  )
  assert.match(
    APPSHELL,
    /<main className="flex min-h-0 flex-1 flex-col overflow-hidden">/,
    'main 必须是有界的 flex 列；滚动职责下放给 PageShell',
  )
})

/** 去掉注释再做否定断言：解释「为什么删掉了 X」的注释会让「X 不许出现」当场红，会误报的守卫迟早被人删掉。 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

test('工作台不再自己算高度，那个会过期的减法必须消失', () => {
  assert.ok(
    !/calc\(100svh\s*-\s*\d+rem\)/.test(stripComments(WORKBENCH)),
    'workbench.tsx 里不许再出现 calc(100svh - Nrem)：' +
      '它减的是别的组件的高度，那些组件一改它就错，而且错了不报任何错',
  )
  assert.match(WORKBENCH, /const PANE_HEIGHT = 'min-h-0 lg:flex-1'/)
  assert.match(WORKBENCH, /'lg:min-h-0 lg:flex-1'/, '工作台自己也要 flex-1 才吃得满剩余高度')
})

test('PageShell 两档各司其职：fill 有界不滚，非 fill 自己能滚', () => {
  assert.match(PAGE, /fill\?: boolean/)

  // 不抄那一行的原文（含 `min-h-full`）：原文守卫只守「没人动过这行」而非「这行还对不对」。
  // `min-height:100%` 会把该层钉死在 <main> 整个高度上，下面压着横幅，多出的一截被裁掉，故改 `min-h-0`。
  // 所以按语义拆两档看。
  const shellClasses = /fill \?\s*'([^']+)'\s*:\s*'([^']+)'/.exec(PAGE)
  assert.ok(shellClasses, 'PageShell 里找不到 fill 的两档类名，这条守卫的定位方式该更新了')
  const [, fillMode, scrollMode] = shellClasses

  // fill 档：有界的 flex 列，自己一格都不滚（高度全分给内部各块）。
  assert.match(fillMode, /\bmin-h-0\b/, 'fill 档必须 min-h-0，否则 flex-1 收不下去')
  assert.match(fillMode, /\bflex-1\b/, 'fill 档必须 flex-1，否则拿不到 main 分的高度')
  assert.match(fillMode, /\boverflow-hidden\b/, 'fill 档是"自己不滚"，必须 overflow-hidden')

  // 非 fill 档：文档型页面，**自己负责滚**（<main> 已经是 overflow-hidden 了）。
  assert.match(scrollMode, /\boverflow-y-auto\b/, '非 fill 档必须自己能滚')
  assert.match(scrollMode, /\bflex-1\b/, '非 fill 档也要 flex-1 才拿得到高度')
  assert.match(
    scrollMode,
    /\bmin-h-0\b/,
    '非 fill 档必须 min-h-0：flex 子项默认 min-height:auto 不肯收缩，' +
      'overflow-y-auto 就永远不生效；写成 min-h-full 更糟，那是"跟 main 一样高"，' +
      '而 main 里还压着一条横幅，页面会比容器高出一截被裁掉',
  )
  assert.ok(
    !/\bmin-h-full\b/.test(scrollMode),
    '非 fill 档不许用 min-h-full——它把高度钉死在 main 上，横幅那一截就滚不到了',
  )

  for (const [name, src] of [['密码页', PASSWORDS], ['剪贴板页', CLIPBOARD]]) {
    assert.match(src, /<PageShell width="canvas" fill/, `${name}没开 fill，工作台就没有确定高度可分`)
  }
})

test('列表行只准显示图标——文字标签会把内容列压成零宽', () => {
  assert.match(LABELMODE, /const ICON_ONLY_REGIONS/)
  for (const region of ['clipboardRow', 'notesRow', 'passwordRow']) {
    assert.match(
      LABELMODE,
      new RegExp(`ICON_ONLY_REGIONS[\\s\\S]{0,300}LABEL_REGIONS\\.${region}`),
      `${region} 必须在 ICON_ONLY_REGIONS 里`,
    )
  }
  // 顺序要紧：约束必须**先于**区域覆盖和全局偏好判断，否则用户一改偏好
  // 又回到"行里塞文字"的老样子。
  assert.match(
    LABELMODE,
    /isIconOnlyRegion\(region\) \? 'icons' : regions\[region\] \?\? globalMode/,
    'modeFor 里 icon-only 的判断必须排在最前面',
  )
})

test('右栏默认落在第一条上，不是一句「请选择」', () => {
  for (const [name, src] of [['密码页', PASSWORDS], ['剪贴板页', CLIPBOARD], ['笔记页', NOTES]]) {
    assert.match(
      src,
      /setDetailId\((?:filtered\.length > 0 \? filtered\[0\]\.id : null)\)/,
      `${name}缺少"右栏默认落在第一条"的兜底——那块地方在 1920×1080 下有一百万像素`,
    )
  }
  // 笔记页新建草稿时不许抢：那会把用户正在写的东西换掉。
  assert.match(NOTES, /if \(loading \|\| creatingNew\) return/)
})

test('笔记列表吃满左栏，不再是写死的 h-64', () => {
  assert.ok(
    !/ref=\{scrollParentRef\} className="h-64 /.test(stripComments(NOTES)),
    '笔记列表不许再写死 h-64（256px）——左栏实测有 890px，下面 300 多像素是空的',
  )
  assert.match(NOTES, /ref=\{scrollParentRef\} className="min-h-0 flex-1 overflow-y-auto/)
})

test('会被 asChild 串起来的薄封装必须 forwardRef', () => {
  // 断了的表现只有控制台一句警告，界面上是"提示不弹 / 菜单弹错位置"——
  // 只在控制台说话的失败最难查。
  assert.match(CHECKBOX, /const Checkbox = React\.forwardRef</)
  assert.match(CHECKBOX, /<CheckboxPrimitive\.Root\s+ref=\{ref\}/)
  for (const name of ['TooltipTrigger', 'TooltipContent']) {
    assert.match(TOOLTIP, new RegExp(`const ${name} = React\\.forwardRef<`), `${name} 不是 forwardRef`)
  }
  for (const name of ['DropdownMenuTrigger', 'DropdownMenuContent', 'DropdownMenuItem', 'DropdownMenuSubTrigger']) {
    assert.match(DROPDOWN, new RegExp(`const ${name} = React\\.forwardRef<`), `${name} 不是 forwardRef`)
  }
  // ref 光声明不挂上等于没做。
  assert.equal((TOOLTIP.match(/ref=\{ref\}/g) ?? []).length, 2)
  assert.ok((DROPDOWN.match(/ref=\{ref\}/g) ?? []).length >= 7)
})

test('工作台两栏各有 testid —— 右栏有内容之后，测试必须说得清在问哪一栏', () => {
  assert.match(WORKBENCH, /data-testid="workbench-list"/)
  assert.match(WORKBENCH, /data-testid="workbench-detail"/)
})

test('剪贴板行的正文预览限行，不是一个 192px 高的滚动块', () => {
  assert.ok(
    !/max-h-48 overflow-auto/.test(stripComments(CLIPBOARD)),
    '行内预览不许用 max-h-48 + 自己滚：实测行高 306px，872px 的左栏装不下三条，' +
      '而且行内滚动条滚到底会把整列带着跳一下',
  )
  assert.match(CLIPBOARD, /line-clamp-3 whitespace-pre-wrap break-words text-sm/)
})

test('低频工具栏默认收起，别把列表挤出屏幕', () => {
  // 剪贴板展开占 336px，笔记展开（含分类芯片）占 780px。判据要同时认 JSX 属性 `defaultOpenGroupIds={[]}`
  // 和对象字段 `defaultOpenGroupIds: []`（剪贴板已改成 `useIconToolbar({…})`）；守的是默认值，不是写法。
  const defaultsClosed = (src, key, span) =>
    new RegExp(`storageKey[:=]\\s*["']${key}["'][\\s\\S]{0,${span}}?defaultOpenGroupIds[:=]\\s*\\{?\\[\\]`).test(src)
  //
  // 剪贴板和笔记两页已把低频入口收进一行顶栏（<TopBar>，每组一个下拉），不再有组开关的默认收起问题；
  // 守的仍是：低频按钮不许常驻、不许把列表往下挤。
  for (const [name, src, key] of [['剪贴板', CLIPBOARD, 'clipboard-actions'], ['笔记列表', NOTES, 'notes-list']]) {
    if (/<TopBar\b/.test(src)) {
      assert.ok(!new RegExp(`storageKey[:=]\\s*["']${key}["']`).test(src), `${name}已经用了一行顶栏，不许再挂一条会展开的工具栏`)
    } else {
      assert.ok(defaultsClosed(src, key, 900), `${name}工具栏必须默认全部收起`)
    }
  }
})
