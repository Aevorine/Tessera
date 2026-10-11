/**
 * 守卫：密码页两个布局病灶不许回来，根因不同故分两条守。
 *   「左右都是空白」：页面用 `width="wide"` 把双栏工作台锁进 1440px 居中（1920 屏减侧栏约 1736px，
 *   两侧各空 148px 再吃 56px 留白）。限宽服务于阅读行长，工作台无长文本行，限的是同时可见条目数。
 *   「左侧内容显示不全」：每行右侧塞五颗操作按钮（显示/复制/历史/编辑/删除），左栏最宽 420px 装不下，
 *   名字列被挤到零宽。这是布局本就装不下，改 overflow/truncate 无效，只能把按钮搬到右栏顶部（工作台规定操作在那里）。
 * 肉眼看不出「要坏了」（加第六颗按钮的人只觉得再加一个而已），故机器检查。
 */

import { readFileSync } from 'node:fs'
import test from 'node:test'
import assert from 'node:assert/strict'

const SCREEN = new URL('../src/components/PasswordScreen.tsx', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const PAGE = new URL('../src/components/ui/page.tsx', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const METRICS = new URL('../src/lib/passwordMetrics.ts', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

const screen = readFileSync(SCREEN, 'utf8')
const page = readFileSync(PAGE, 'utf8')
const metrics = readFileSync(METRICS, 'utf8')

test('密码页用 canvas 档铺满，不再锁进 1440px 居中', () => {
  assert.match(
    screen,
    /<PageShell\s+width="canvas"/,
    '密码页必须是 width="canvas"。换回 wide 会让左右各空出一百多像素，那正是用户报的第一个问题。',
  )
})

test('canvas 档确实是不限宽 + 更薄的横向留白', () => {
  assert.match(page, /width === 'canvas' && 'max-w-none'/, 'canvas 档必须不限宽')
  assert.match(
    page,
    /width === 'canvas'\s*\?\s*'px-4 sm:px-5 lg:px-6'/,
    'canvas 档的横向留白必须比其它档薄——不然限宽去掉了，留白还在照吃。',
  )
})

test('wide 档也不许再退回 1440px', () => {
  assert.match(page, /width === 'wide' && 'max-w-\[1600px\]'/)
  assert.doesNotMatch(page, /max-w-\[1440px\]/, '1440px 在 1920 屏上两侧各留 148px 空白')
})

test('列表行里最多只剩一颗操作按钮', () => {
  // 只看 PasswordRow 那个函数体。整文件数会把右栏详情面板的五颗一起算进来，
  // 而那五颗**正是搬过去的目的地**，不是问题。
  const start = screen.indexOf('function PasswordRow(')
  assert.notEqual(start, -1, '找不到 PasswordRow —— 这条守卫的锚点没了，先修守卫')
  const end = screen.indexOf('\nfunction ', start + 1)
  const body = screen.slice(start, end === -1 ? undefined : end)

  const actionButtons = body.match(/<ActionButton\b/g) ?? []
  assert.ok(
    actionButtons.length <= 1,
    `列表行里有 ${actionButtons.length} 颗操作按钮。左栏最宽 420px，超过一颗就会把名字那一列挤没——` +
      '这正是"左侧内容显示不全"的成因。新按钮请加到右栏 WorkbenchDetailHeader 的 actions 里。',
  )
  assert.doesNotMatch(
    body,
    /<Button\b/,
    '列表行里不许出现裸的 <Button>：它比 ActionButton 更宽（默认带文字），而且没有悬停提示。',
  )
})

test('右栏顶部保留完整的五个操作，且都带悬停提示', () => {
  const start = screen.indexOf('function PasswordDetailPanel(')
  assert.notEqual(start, -1)
  const end = screen.indexOf('\nfunction ', start + 1)
  const body = screen.slice(start, end === -1 ? undefined : end)

  for (const key of ['hideButton', 'copyButton', 'viewHistoryButton', 'editButton', 'deleteButton']) {
    assert.ok(body.includes(key), `右栏少了 ${key}——从列表行搬过来的操作不能在半路丢掉`)
  }
  // ActionButton 的 label 是必填的，Tooltip 无条件挂着（见 ActionButton.tsx），
  // 所以只要走的是它，"悬停显示功能名称"就是结构上保证的。
  assert.doesNotMatch(
    body.slice(0, body.indexOf('<WorkbenchDetailBody')),
    /<Button\b/,
    '右栏顶部的操作必须走 ActionButton，裸 <Button> 没有悬停提示。',
  )
})

test('指标是一张可扩展的表，不是写死在组件里的三个 filter', () => {
  const ids = metrics.match(/^\s{4}id: '([a-zA-Z]+)',$/gm) ?? []
  assert.ok(
    ids.length >= 12,
    `指标表里只有 ${ids.length} 条。用户要的是"更多可选择的指标"，退回三四个就是把这件事做没了。`,
  )
  // 组件不许再自己算指标——一旦有第二处算法，界面上就会出现"数字说 3 条、
  // 筛出来 2 条"，而且没人查得出来是哪一处对。
  assert.doesNotMatch(
    screen,
    /const healthStats = /,
    '密码页不许再有自己的一套统计，全部走 lib/passwordMetrics.ts',
  )
})

test('生成器用的是密码学随机数，不是 Math.random', () => {
  const gen = readFileSync(
    new URL('../src/lib/passwordGenerator.ts', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
    'utf8',
  )
  assert.match(gen, /crypto\.getRandomValues/)
  // 先剥注释再查：该文件头注释专门解释了为什么不用 Math.random，对全文 doesNotMatch 会被自己的解释判死；
  // 守卫误报比漏报更糟，下一个人会直接删掉它。
  const code = gen.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  assert.doesNotMatch(
    code,
    /Math\.random/,
    'Math.random 是可预测的伪随机数，用它生成密码会让界面上显示的那个熵值变成假的。',
  )
})
