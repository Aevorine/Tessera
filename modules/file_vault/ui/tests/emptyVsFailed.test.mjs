import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// 「没有数据」与「没拿到数据」必须分开：`{list.length === 0 && <p>还没有内容</p>}` 在请求失败时也成立，
// 用户会看到一句错话，且不报错、测试全绿。正确写法是空状态条件带上 `!loading && !loadError`，
// 另有 `{loadError && <出错了 + 重试/>}`。本文件守「空状态渲染条件必须带错误标志」。

const COMPONENTS_DIR = new URL('../src/components/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

/** 「这个列表是空的」这种渲染条件。只看 JSX 里 `{...length === 0 &&` 这种形态。 */
const EMPTY_RENDER = /\{[^{}\n]*\.length === 0 &&/g

/** 条件里出现任意一个"出错了吗"的标志就算过关。各界面命名不完全一致，
 *  所以按词根匹配而不是钉死某个变量名——钉太死会在无关重构时误报。 */
const ERROR_FLAG = /(loadError|error|failed|Err\b)/i

/** 白名单：这些 `.length === 0` 不是列表空状态。每条必须写明理由，否则白名单会变成随手绕过的口子。 */
const ALLOWED_SNIPPETS = [
  // 提前返回/早退：`if (paths.length === 0) return` 这类根本不渲染东西。
  /^\{?\s*if\s*\(/,
]

/**
 * 已知欠账（棘轮）：全仓有 14 处「列表空了就说没有内容、不区分加载失败」，其中一半组件根本没有错误状态
 * （AIChatScreen / PcCleanSpaceScreen 无一处 catch），一次性补全等于重做数据层。
 * 故现有 14 处钉在这里：修好一处要来删一行，新增一处直接红。
 * 修法：给组件加 loadError 状态，渲染条件带 `!loadError` 并加出错重试，再删本表对应行。
 */
const KNOWN_DEBT = new Set([
  // AIChatScreen 一处 catch 都没有 —— messages 是本地对话（空就是真的空，
  // 可以永久豁免），但 skills / history 是真的走 RPC 的，欠着。
  'AIChatScreen.tsx:messages',
  'AIChatScreen.tsx:skills',
  'AIChatScreen.tsx:history',
  // 设备列表来自 Go 守护进程，连不上时会显示成“附近没有设备”。
  'CrossDeviceScreen.tsx:devices',
  'FilesPane.tsx:folderPreview.entries',
  'NotesScreen.tsx:detailId !== null && getHistory(detailId)',
  'NotesScreen.tsx:(hiddenOnly ? hiddenTags : normalTags)',
  'NotesScreen.tsx:categories',
  'PasswordScreen.tsx:rows',
  'PasswordScreen.tsx:history',
  // PcCleanSpaceScreen 同样一处 catch 都没有；两处用的是同一个表达式。
  'PcCleanSpaceScreen.tsx:roots',
  'RecoveryCodesScreen.tsx:filtered',
  'RecoveryCodesScreen.tsx:historyTarget?.importHistory',
])

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

test('空列表的提示必须和"加载失败"分开判，不能共用一条渲染条件', () => {
  const offenders = []
  let checked = 0
  const stillOwed = new Set()

  for (const file of walk(COMPONENTS_DIR)) {
    const name = file.split(/[\\/]/).pop()
    const src = stripComments(readFileSync(file, 'utf8'))
    for (const m of src.matchAll(EMPTY_RENDER)) {
      const cond = m[0]
      if (ALLOWED_SNIPPETS.some((re) => re.test(cond))) continue
      checked += 1
      if (ERROR_FLAG.test(cond)) continue
      // 按「文件 + 被判空的那个表达式」认身份，不按行号——行号一改就误报，
      // 而这条守卫要守的性质跟行号无关。
      const expr = /\{?\s*(?:!loading && )?(.+?)\.length === 0/.exec(cond)
      const key = `${name}:${expr ? expr[1].trim() : cond.trim()}`
      if (KNOWN_DEBT.has(key)) {
        stillOwed.add(key)
        continue
      }
      const line = src.slice(0, m.index).split('\n').length
      offenders.push(`${name}:${line}  ${cond.trim()}`)
    }
  }

  // 空输入判通过是最常见的"守卫看起来全绿其实没在守"的形态。
  assert.ok(checked > 0, '一处空状态渲染都没扫到，正则多半已经和代码脱节了')

  assert.deepEqual(
    offenders,
    [],
    '新出现了不区分"空"和"加载失败"的空状态。请求失败时它会显示成"还没有内容"——' +
      '那是一句错的话，用户会以为自己的数据没了。渲染条件里要带上错误标志：\n' +
      offenders.join('\n'),
  )

  // 棘轮的另一半：修好了的要从 KNOWN_DEBT 里删掉，否则这张表会慢慢变成
  // 一堆早就不存在的条目，下一个人根本不知道哪些还欠着。
  const fixed = [...KNOWN_DEBT].filter((k) => !stillOwed.has(k))
  assert.deepEqual(
    fixed,
    [],
    '这些已经修好了，请把它们从 tests/emptyVsFailed.test.mjs 的 KNOWN_DEBT 里删掉：\n' +
      fixed.join('\n'),
  )
})
