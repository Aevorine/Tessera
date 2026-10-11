import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// 规则：`<StatTile>` 渲染就必须带 onClick——数字答“有多少”，点击答“是哪些”。
// 曾有界面（笔记）漏加而长期纯展示，这个文件是拦截器。

const COMPONENTS_DIR = new URL('../src/components/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

/** StatTile 在这个项目里全是自闭合标签，一路扫到 `/>` 就是一次完整用法。 */
const STAT_TILE_USAGE = /<StatTile\b[\s\S]*?\/>/g

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (entry.name.endsWith('.tsx')) out.push(full)
  }
  return out
}

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

test('每一块统计数字都是可点的入口，不存在只显示不能点的', () => {
  const dead = []
  let checked = 0
  for (const file of walk(COMPONENTS_DIR)) {
    const name = file.split(/[\\/]/).pop()
    if (name === 'StatTile.tsx') continue // 组件定义处，onClick 在那里是可选参数
    const src = stripComments(readFileSync(file, 'utf8'))
    for (const usage of src.match(STAT_TILE_USAGE) ?? []) {
      checked += 1
      if (!/\bonClick\b/.test(usage)) {
        const label = usage.match(/label=\{?t\('([^']+)'\)/)?.[1] ?? usage.slice(0, 60).replace(/\s+/g, ' ')
        dead.push(`${name}: <StatTile label=${label}> 没有 onClick——数字点不动，等于只做了一半`)
      }
    }
  }
  // 一个都没扫到，多半是 StatTile 改名或换了写法而这个守卫悄悄失效了。
  // 空输入判通过是最常见的"守卫看起来全绿其实没在守"的形态，这里显式拦掉。
  assert.ok(checked > 0, '没有扫到任何 <StatTile> 用法，这个守卫可能已经失效')
  assert.deepEqual(dead, [], dead.join('\n'))
})

test('笔记界面的四块统计都在，而且都能点', () => {
  // 单独钉住笔记这一处：它就是被漏掉三次的那个界面。上面那条是通用规则，
  // 这条防的是"整块被删掉了所以通用规则扫不到，测试照样全绿"。
  const src = stripComments(readFileSync(join(COMPONENTS_DIR, 'NotesScreen.tsx'), 'utf8'))
  for (const key of ['statTotalLabel', 'statActiveLabel', 'statHiddenLabel', 'statTrashedLabel']) {
    const usage = (src.match(STAT_TILE_USAGE) ?? []).find((u) => u.includes(`t('${key}')`))
    assert.ok(usage, `笔记界面少了 ${key} 这一块统计`)
    assert.ok(/\bonClick\b/.test(usage), `笔记界面的 ${key} 不能点`)
  }
})

test('会露出隐藏笔记的那两块，必须过一次身份验证', () => {
  // 判据是这次切换会不会让隐藏内容出现在屏幕上，而不是范围名带不带 hidden：
  // 「总计」同样含隐藏笔记，漏掉就是免验证后门。
  const src = stripComments(readFileSync(join(COMPONENTS_DIR, 'NotesScreen.tsx'), 'utf8'))
  const gate = src.match(/async function changeNoteScope[\s\S]*?\n  \}/)
  assert.ok(gate, '找不到 changeNoteScope——切换范围的入口改名了，这条守卫要跟着更新')
  assert.match(
    gate[0],
    /ensureFreshlyUnlocked\(\)/,
    'changeNoteScope 里没有解锁验证：切到"已隐藏"或"总计"会直接露出隐藏笔记',
  )
  assert.match(
    gate[0],
    /next === 'hidden' \|\| next === 'all'/,
    '解锁判据必须同时覆盖 hidden 和 all（"总计"里也有隐藏笔记）',
  )
})

test('回收站里的隐藏笔记同样要过验证才列出来', () => {
  // 隐藏笔记进回收站后仍是隐藏的，范围判断必须在 viewMode 分支之外，否则删除成了绕过验证的后门。
  // 该筛选已搬到 lib/notes/filterNotes，守卫跟着走。
  const src = stripComments(
    readFileSync(new URL('../src/lib/notes/noteFilters.ts', import.meta.url), 'utf8'),
  )
  const filtered = src.match(/export function filterNotes\([\s\S]*?\n\}/)
  assert.ok(filtered, '找不到 filterNotes 的定义，这条守卫要跟着更新')
  const body = filtered[0]
  const scopeCheck = body.indexOf('isNoteInScope(n, scope)')
  const activeBranch = body.indexOf("viewMode === 'active'")
  assert.ok(scopeCheck !== -1, 'filtered 里没有范围判断')
  assert.ok(
    scopeCheck < activeBranch,
    '范围判断必须在 viewMode 分支**之外**，否则回收站视图会整个跳过它',
  )
})
