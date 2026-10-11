import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// 页面顶部那条带子不写页面名也不写页面说明：导航栏已高亮该项，重复念一遍占的是整屏最贵的横带，
// 留给主操作和关键数字。敌人是一处一处加回来的「补一句」，故守卫必须机械：
//   1. 三个骨架组件不许有 description 槽位，PageHeader 不许有 icon 槽位，没有槽位就插不进去。
//   2. 标题必须留在 DOM 里且是 sr-only：删掉读屏用户就失去页面名，可见则重复又回来。
//   3. 两个槽位都空时不画那条带子，否则页面顶部剩一条空横线。

const SRC_DIR = new URL('../src/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const PAGE_TSX = join(SRC_DIR, 'components', 'ui', 'page.tsx')

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (entry.name.endsWith('.tsx')) out.push(full)
  }
  return out
}

/** 从 `<Tag` 起配平尖括号找调用结束位置；标题行里 actions 的按钮、metrics 的磁贴含大量尖括号，找下一个 `/>` 或 `>` 会中途截断。 */
function extractCalls(src, tag) {
  const calls = []
  const re = new RegExp(`<${tag}[\\s\\n]`, 'g')
  let m
  while ((m = re.exec(src)) !== null) {
    let depth = 0
    let i = m.index
    for (; i < src.length; i += 1) {
      if (src[i] === '<') depth += 1
      else if (src[i] === '>') {
        depth -= 1
        if (depth === 0) break
      }
    }
    calls.push(src.slice(m.index, i + 1))
  }
  return calls
}

test('骨架组件上不许再出现 description 槽位', () => {
  const offenders = []
  for (const file of walk(SRC_DIR)) {
    const name = file.split(/[\\/]/).pop()
    const src = stripComments(readFileSync(file, 'utf8'))
    for (const tag of ['PageHeader', 'PageSection', 'EmptyState']) {
      for (const call of extractCalls(src, tag)) {
        if (/\bdescription\s*=/.test(call)) {
          const title = /\btitle=\{?([^\n]*)/.exec(call)
          offenders.push(`${name}: <${tag} ${title ? title[1].trim() : ''}> 又带上了 description`)
        }
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    '界面上不再放讲解自己的文字。这三个组件已经没有 description 这个槽位，' +
      '再传就是把旁白一处一处加回来。\n' + offenders.join('\n'),
  )
})

test('三个骨架组件的类型里也不许留 description 槽位', () => {
  const code = stripComments(readFileSync(PAGE_TSX, 'utf8'))
  assert.ok(
    !/\bdescription\??:/.test(code),
    'page.tsx 的组件类型里出现了 description。槽位一旦回来，调用方迟早会填。',
  )
})

test('标题行上不许再出现 icon 槽位', () => {
  const offenders = []
  for (const file of walk(SRC_DIR)) {
    const name = file.split(/[\\/]/).pop()
    const src = stripComments(readFileSync(file, 'utf8'))
    for (const call of extractCalls(src, 'PageHeader')) {
      if (/\bicon\s*=/.test(call)) offenders.push(`${name}: <PageHeader> 又带上了 icon`)
    }
  }
  // 导航栏里已经有同一个图标，而且正高亮着。标题和提要都撤掉之后，
  // 标题行里再放一个图标，那条带子就只剩装饰。
  assert.deepEqual(offenders, [], offenders.join('\n'))
})

test('页面名字不画在界面上，但留给读屏软件', () => {
  const pageTsx = readFileSync(PAGE_TSX, 'utf8')
  assert.match(
    pageTsx,
    /<PageTitle className="sr-only">\{title\}<\/PageTitle>/,
    'PageHeader 必须以 sr-only 渲染 <PageTitle>：画面上不显示，读屏软件仍念得到。',
  )
})

test('两个槽位都空时不画那条空带子', () => {
  const code = stripComments(readFileSync(PAGE_TSX, 'utf8'))
  assert.match(
    code,
    /\{\(metrics \|\| actions\) && \(/,
    '那条带子必须由 (metrics || actions) 条件渲染，而标题作为它的兄弟永远在。' +
      '写成「没东西就直接 return 标题」会让根元素在 h1 和 header 之间跳，' +
      'React 会把整棵子树卸载重挂——磁贴闪一下、内部状态被清空。',
  )
})
