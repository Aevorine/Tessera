import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')

const PASSWORDS = read('../src/components/PasswordScreen.tsx')
const CLIPBOARD = read('../src/components/ClipboardScreen.tsx')
const CLIP_ACTIONS = read('../src/components/clipboard/ClipboardEntryActions.tsx')
const NOTES = read('../src/components/NotesScreen.tsx')
const METRICS = read('../src/lib/passwordMetrics.ts')

// 守「列表行装不下」：左栏 280–420px，行里一排 shrink-0 操作按钮不会被压缩，被压缩的是旁边 min-w-0 的内容，
// 宽度归零，表现为「显示不全」而非「按钮太多」。静态测试量不到宽度，只守成因（一行有几颗按钮、在哪）；
// 运行时「内容还在不在」由 tests/unit/passwordScreen.test.tsx 和 workbenchScreens.test.tsx 负责。
// 两层缺一不可：只有静态的，改成 flex-wrap 照样过；只有运行时的，jsdom 无布局引擎量不出宽度。

/** 取一个组件函数体（到下一个顶层 `function ` 为止）。 */
function bodyOf(source, name) {
  const start = source.indexOf(`function ${name}(`)
  assert.notEqual(start, -1, `找不到组件 ${name}`)
  const next = source.indexOf('\nfunction ', start + 1)
  return source.slice(start, next === -1 ? source.length : next)
}

test('密码列表的每一行都画出密码本身', () => {
  const row = bodyOf(PASSWORDS, 'PasswordRow')
  assert.match(
    row,
    /revealed \? entry\.password : maskOf\(entry\.password\)/,
    '这一页叫「密码管理」，列表里必须看得到密码；上一版只有名字和账号，' +
      '想看密码要先点开右栏再点一次眼睛——那就是用户报的"密码无法正常显示"',
  )
  // 打码长度写死，不跟真实长度走：长度是穷举时要猜的第一个参数，
  // 一屏几十行摊开时泄露面比详情页大得多。
  assert.match(PASSWORDS, /function maskOf/)
  assert.match(PASSWORDS, /'•'\.repeat\(10\)/)
  assert.ok(
    !/'••••••••'/.test(PASSWORDS),
    '打码字符串必须只有 maskOf 一处，写死的字面量会和它慢慢分叉',
  )
})

test('密码行里的操作按钮不超过一颗', () => {
  const row = bodyOf(PASSWORDS, 'PasswordRow')
  const actionButtons = row.match(/<ActionButton\b/g) ?? []
  assert.ok(
    actionButtons.length <= 1,
    `密码行里有 ${actionButtons.length} 颗 ActionButton。左栏最窄 280px，` +
      `每颗按钮约 32px 且不可压缩，多于一颗就开始吃名字和账号的宽度。` +
      `其余操作应当在右栏详情顶部（WorkbenchDetailHeader）。`,
  )
  assert.ok(!/<Button\b/.test(row), '密码行里不许出现裸 <Button>（它没有悬停提示）')
})

test('剪贴板行里只剩一颗「更多操作」，九个操作收进菜单', () => {
  const row = bodyOf(CLIPBOARD, 'ClipboardRow')
  assert.match(row, /<ClipboardRowMenu\b/, '行内操作必须走收拢后的菜单组件')
  assert.ok(
    !/ClipboardRowActions/.test(CLIPBOARD),
    '旧的一排按钮（ClipboardRowActions）必须整个消失，不能留着给别处再调回去',
  )
  // 行里允许的图标按钮：打开详情、更多操作。多一颗就要重新算左栏宽度。
  const inline = row.match(/<ActionButton\b/g) ?? []
  assert.ok(
    inline.length <= 1,
    `剪贴板行里有 ${inline.length} 颗直接写出来的 ActionButton；` +
      `除「打开详情」外都应当进 ClipboardRowMenu`,
  )
})

test('剪贴板的操作只描述一次，行菜单和详情栏各画一遍', () => {
  assert.match(CLIP_ACTIONS, /function clipboardActionsFor\(/)
  assert.match(CLIP_ACTIONS, /export function ClipboardRowMenu\(/)
  assert.match(CLIP_ACTIONS, /export function ClipboardDetailActions\(/)
  // 两个渲染器都必须从同一张表来。各写各的话，加一个操作会漏掉另一处。
  const uses = CLIP_ACTIONS.match(/clipboardActionsFor\(entry, t, handlers\)/g) ?? []
  assert.equal(uses.length, 2, '行菜单和详情栏必须共用同一张操作表')
})

test('剪贴板详情顶部拿得到完整的一排操作', () => {
  assert.match(CLIPBOARD, /<ClipboardDetailActions entry=\{entry\} t=\{t\}/)
  // 详情面板要真的被喂了处理函数，否则那一排永远是空的——
  // "组件挂上了但没传 props" 是这类改动最典型的静默失败。
  const call = CLIPBOARD.slice(CLIPBOARD.indexOf('<ClipboardDetailPane'))
  for (const prop of ['onTogglePinned', 'onToggleHidden', 'onDelete', 'onEdit', 'onQuickConvert', 'onPartialCopy']) {
    assert.match(call.slice(0, 2000), new RegExp(`${prop}=`), `详情面板没收到 ${prop}`)
  }
})

test('笔记的「展开/收起列表」在标题行里，不再自己占一列', () => {
  // 2026-09-27 标题行换成了一行顶栏：收起按钮跟着搬到顶栏最右端（trailing），
  // 仍是全页固定的主操作位，只是不再单独占 PageHeader 的一行。
  assert.match(
    NOTES,
    /trailing=\{[\s\S]{0,800}?<ActionButton\s+label=\{listCollapsed \? t\('expandListButton'\) : t\('collapseListButton'\)\}/,
    '收起按钮必须挂在顶栏右端（trailing）——那是全应用固定的主操作位',
  )
  assert.ok(
    !/<div className="flex items-start gap-2">\s*\{!fullscreen && \(/.test(NOTES),
    '工作台外面那个专门用来放收起按钮的 flex 容器必须删掉，' +
      '它自己占一列 + 一个 gap，列表还没开始画就先少 40px',
  )
})

test('新增的十个指标都在表里，且都配了翻译键', () => {
  const added = [
    'sequential', 'identityLeak', 'singleCase', 'sharedUsername', 'veryStale',
    'freshlyChanged', 'noUrl', 'medianEntropy', 'weakestCrackTime', 'atRiskShare',
  ]
  const en = JSON.parse(read('../src/i18n/locales/en/passwords.json'))
  for (const id of added) {
    assert.match(METRICS, new RegExp(`id: '${id}',`), `指标表里缺 ${id}`)
    const cap = id[0].toUpperCase() + id.slice(1)
    assert.ok(en[`metric${cap}Label`], `en 缺 metric${cap}Label`)
    assert.ok(en[`metric${cap}Hint`], `en 缺 metric${cap}Hint`)
  }
  const total = METRICS.match(/^\s{4}id: '/gm) ?? []
  assert.ok(total.length >= 28, `指标表现在只有 ${total.length} 条，预期至少 28`)
})

test('强度和熵是记忆化的——它们每次重渲染要被问上万次', () => {
  assert.match(METRICS, /export const computePasswordStrength = memoize1\(/)
  assert.match(METRICS, /export const passwordEntropyBits = memoize1\(/)
  // 缓存必须有上限。没有上限的 Map 在"每敲一个字符算一次熵"的编辑框里会一直涨。
  assert.match(METRICS, /const MEMO_LIMIT = \d+/)
  assert.match(METRICS, /if \(cache\.size >= MEMO_LIMIT\) cache\.clear\(\)/)
})
