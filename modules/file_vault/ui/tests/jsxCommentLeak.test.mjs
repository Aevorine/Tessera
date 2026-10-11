import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

// JSX 子节点位置上的裸 `/* … */` 会被当作文本渲染到界面（应写 `{/* … */}`）。曾在 AppShell 漏花括号并发了版，
// 因为：tsc 与 eslint 都视为合法文本节点；没有行为测试渲染 AppShell；布局探针量的是复制品且几何全绿。
// 故补两层：这里静态扫源码（便宜，每次 npm test 都跑），探针那边扫渲染出的文字（scripts/layout-probe.mjs 的 junk 检测，
// `?shell=1` 渲染真 AppShell，覆盖更广）。

/**
 * 找可能落在 JSX 子节点位置的裸块注释：某行以 `/*` 开头，且上一行非空代码以 `>` 结尾（刚开完 JSX 标签）。
 * 判据刻意保守，文件头、函数上方、对象字面量里的注释不会误报；以 `=>` 结尾的是箭头函数，要排除。
 */
export function findBareJsxComments(source) {
  const hits = []
  const lines = source.split('\n')
  let inBlock = false
  let prevCode = ''
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '')
    const trimmed = line.trim()
    if (inBlock) {
      if (trimmed.includes('*/')) inBlock = false
      continue
    }
    if (trimmed.startsWith('/*')) {
      if (prevCode.endsWith('>') && !prevCode.endsWith('=>')) {
        hits.push({ line: i + 1, text: trimmed.slice(0, 70) })
      }
      if (!trimmed.includes('*/')) inBlock = true
    }
    if (trimmed) prevCode = trimmed
  }
  return hits
}

function allTsx(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...allTsx(full))
    else if (name.endsWith('.tsx')) out.push(full)
  }
  return out
}

test('扫描器自己要认得出那个真实的写法（守卫的自检）', () => {
  // 一个没见过自己亮红灯的守卫等于没有守卫。这里用当时真正写坏的那段形状。
  const bad = [
    '  return (',
    '    <TooltipProvider delayDuration={200}>',
    '    /* h-screen + overflow-hidden，不是 min-h-screen。',
    '       前者给整棵树一个确定的高度。 */',
    '    <div className="flex h-screen">',
  ].join('\n')
  assert.equal(findBareJsxComments(bad).length, 1, '扫描器漏掉了真实的坏写法')

  // 正确写法不许误报。
  const good = [
    '    <TooltipProvider delayDuration={200}>',
    '      {/* 这是正经的 JSX 注释 */}',
    '      <div className="flex h-screen">',
  ].join('\n')
  assert.equal(findBareJsxComments(good).length, 0, '正确写法被误报了')

  // 函数上方的普通块注释不许误报——那是最常见的形状，误报一次这守卫就会被删。
  const ordinary = [
    'const x = 1',
    '/**',
    ' * 一段正常的文档注释。',
    ' */',
    'function f() {}',
  ].join('\n')
  assert.equal(findBareJsxComments(ordinary).length, 0, '普通块注释被误报了')
})

test('src 下所有 tsx 都没有会被渲染出来的裸注释', () => {
  const files = allTsx(new URL('../src', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
  assert.ok(files.length > 50, `只扫到 ${files.length} 个 tsx，路径大概解析错了`)
  const bad = []
  for (const file of files) {
    for (const hit of findBareJsxComments(readFileSync(file, 'utf8'))) {
      bad.push(`${file.split(/[\\/]/).slice(-2).join('/')}:${hit.line}  ${hit.text}`)
    }
  }
  assert.deepEqual(
    bad,
    [],
    'JSX 子节点位置上出现了裸的块注释，它会被原样画到界面上。' +
      '正确写法是 {/* … */}：\n  ' + bad.join('\n  '),
  )
})
