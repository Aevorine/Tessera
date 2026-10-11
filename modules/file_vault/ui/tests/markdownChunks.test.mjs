import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

// 切块是为让 4MB 文档首屏进入 ms 级，唯一不能付的代价是改变渲染结果（切坏不报错，只在特定文档上显示不同）。
// 核心断言只有一条：分块渲染 == 整篇渲染。本文件用 --experimental-strip-types 直接加载 .ts 源（test:update 已带），不经打包。

const require = createRequire(import.meta.url)
const MarkdownIt = require('markdown-it')
// 配置必须跟 lib/markdownRenderer.ts 完全一致，否则这里测的不是线上那套。
const RENDERER_SOURCE = readFileSync(new URL('../src/lib/markdownRenderer.ts', import.meta.url), 'utf8')
const md = new MarkdownIt({ html: false, linkify: true, breaks: false })

const { splitMarkdownForStreaming, collectLinkDefinitions } = await import('../src/lib/markdownChunks.ts')

/** 按 worker 里的同一套规则把各块渲染出来再拼接。 */
function renderChunked(source, targetChars) {
  const chunks = splitMarkdownForStreaming(source, targetChars)
  const definitions = chunks.length > 1 ? collectLinkDefinitions(source) : ''
  return chunks
    .map((chunk) => md.render(definitions ? `${chunk}\n\n${definitions}` : chunk))
    .join('')
}

function assertSameAsWhole(source, targetChars, label) {
  assert.equal(renderChunked(source, targetChars), md.render(source), label)
}

test('渲染器配置与 lib/markdownRenderer.ts 一致（不一致就等于测了另一套）', () => {
  assert.match(RENDERER_SOURCE, /html:\s*false/)
  assert.match(RENDERER_SOURCE, /linkify:\s*true/)
  assert.match(RENDERER_SOURCE, /breaks:\s*false/)
})

test('各块按顺序拼回去必须等于原文，一个字符都不能丢', () => {
  const source = Array.from({ length: 400 }, (_, i) => `## 第 ${i} 节\n\n正文一段。\n`).join('\n')
  const chunks = splitMarkdownForStreaming(source, 512)
  assert.ok(chunks.length > 1, '这份样本应该被切成多块，否则这条用例没测到东西')
  assert.equal(chunks.join('\n'), source)
})

test('小文档原样返回一块（不引入任何差异）', () => {
  const source = '# 标题\n\n一段话。\n'
  assert.deepEqual(splitMarkdownForStreaming(source, 48 * 1024), [source])
})

test('不在围栏代码块中间切开', () => {
  // 代码块里有大量空行，而且内容看起来像标题——切进去会把它渲染成真标题。
  const fenced = '```js\n' + Array.from({ length: 300 }, (_, i) => (i % 3 === 0 ? '' : `# 这不是标题 ${i}`)).join('\n') + '\n```\n'
  const source = `开头一段。\n\n${fenced}\n结尾一段。\n`
  for (const chunk of splitMarkdownForStreaming(source, 256)) {
    const fences = (chunk.match(/^```/gm) ?? []).length
    assert.ok(fences % 2 === 0, `块里的围栏必须成对，实际 ${fences} 个:\n${chunk.slice(0, 200)}`)
  }
  assertSameAsWhole(source, 256, '围栏代码块被切坏了')
})

test('不把松散列表切成两个列表', () => {
  // 松散列表的项之间就是空行——在那里切开，一个 <ul> 会变成两个，编号也会重来。
  const source = '开头。\n\n' + Array.from({ length: 200 }, (_, i) => `- 第 ${i} 项`).join('\n\n') + '\n'
  assertSameAsWhole(source, 256, '松散列表被切成了两个')
})

test('不把有序列表的编号切断重来', () => {
  const source = '开头。\n\n' + Array.from({ length: 150 }, (_, i) => `${i + 1}. 第 ${i + 1} 项`).join('\n\n') + '\n'
  assertSameAsWhole(source, 256, '有序列表的编号被切断了')
})

// 曾有三条「不切断引用块/表格/setext 标题」的用例，拿拆掉保护的版本喂过仍全绿：
// 这三种构造内部没有空行（空行会终止引用块和表格），而切点只在空行处，根本切不进去。无意义的绿用例比没有更糟，已删，换成下面两条真能红的。

test('切点只出现在空行处，且不在围栏内部', () => {
  // 这是"为什么引用块/表格/setext 不会被切坏"的**根据**：那些构造内部没有空行。
  // 与其对每种构造各写一条测不到东西的用例，不如把这条根据本身钉住。
  const source = [
    '开头段落。',
    '',
    '> 引用一行',
    '> 引用二行',
    '',
    '| 列一 | 列二 |',
    '| --- | --- |',
    '| 甲 | 乙 |',
    '',
    '标题',
    '====',
    '',
    'x'.repeat(300),
    '',
    '```js',
    'const a = 1',
    '',
    'const b = 2',
    '```',
    '',
    '结尾。',
    '',
  ].join('\n')
  const chunks = splitMarkdownForStreaming(source, 64)
  let consumed = 0
  for (let i = 0; i < chunks.length - 1; i++) {
    consumed += chunks[i].length
    // chunks.join('\n') === source，所以第 i 块的最后一行就是原文里 consumed 处
    // 之前那一行。切点合法 ⇔ 该块以空行结尾。
    assert.ok(
      /\n\s*$/.test(chunks[i]) || chunks[i].trim() === '',
      `第 ${i} 块不是以空行结尾，说明切在了段落中间:\n${JSON.stringify(chunks[i].slice(-80))}`,
    )
    consumed += 1 // 被 join 吃掉的那个 '\n'
    const fences = (chunks[i].match(/^(\s{0,3})(`{3,}|~{3,})/gm) ?? []).length
    assert.ok(fences % 2 === 0, `第 ${i} 块里的围栏不成对`)
  }
  assert.equal(chunks.join('\n'), source)
})

test('混合构造的文档，任何切块粒度下渲染结果都和整篇一致', () => {
  // 对一份混合各种构造的文档在多个粒度上跑等价性：粒度一变切点落到不同位置，任何构造被切坏都会在某个粒度暴露。
  const source = Array.from({ length: 60 }, (_, i) =>
    [
      `## 第 ${i} 节`,
      '',
      `正文一段，带 [链接][site] 和 \`行内代码\`。`,
      '',
      `- 列表甲 ${i}`,
      '',
      `- 列表乙 ${i}`,
      '',
      `1. 编号一 ${i}`,
      '',
      `2. 编号二 ${i}`,
      '',
      '> 引用第一行',
      '> 引用第二行',
      '',
      '| 列一 | 列二 |',
      '| --- | --- |',
      `| 甲${i} | 乙${i} |`,
      '',
      `小标题 ${i}`,
      '--------',
      '',
      '```js',
      'const x = 1',
      '',
      '// 空行在围栏里',
      'const y = 2',
      '```',
      '',
      '    缩进代码块',
      '',
      `末段 ${i}。`,
      '',
    ].join('\n'),
  ).join('\n') + '\n[site]: https://example.com\n'

  for (const target of [64, 128, 256, 512, 1024, 4096]) {
    assertSameAsWhole(source, target, `粒度 ${target} 下分块渲染与整篇不一致`)
  }
})

test('写在文档末尾的链接引用定义，前面的块也要能用上', () => {
  // 这是切块最容易悄悄弄坏的一处：定义在最后、引用在最前，分块之后前面那块
  // 渲染出来就是纯文本 `[官网]`——不报错，只是链接没了。
  const body = Array.from({ length: 300 }, (_, i) => `第 ${i} 段，见 [官网][site]。\n`).join('\n')
  const source = `${body}\n[site]: https://example.com "示例"\n`
  const chunked = renderChunked(source, 512)
  assert.ok(splitMarkdownForStreaming(source, 512).length > 1, '样本应该被切成多块')
  assert.ok(chunked.includes('href="https://example.com"'), '前面的块没解析到写在末尾的链接定义')
  assertSameAsWhole(source, 512, '补链接定义之后渲染结果仍应与整篇一致')
})

test('切不出安全边界时退回整篇一块，而不是硬切', () => {
  // 整篇就是一个巨大的围栏代码块：没有任何安全边界，只能整篇一块。
  const source = '```\n' + 'x'.repeat(200 * 1024) + '\n```\n'
  assert.deepEqual(splitMarkdownForStreaming(source, 1024), [source])
})

test('中文长文档（无空格）同样不被切坏', () => {
  // 编码/分词类问题只在非 ASCII 上暴露，纯英文样本永远测不出来。
  const source = Array.from({ length: 300 }, (_, i) => `### 第${i}章\n\n这是一段没有任何空格的中文正文，用来确认切块不依赖空白字符。\n`).join('\n')
  assertSameAsWhole(source, 512, '中文文档被切坏了')
})
