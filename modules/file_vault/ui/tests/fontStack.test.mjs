import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// 「西文 Times New Roman、中文宋体」靠 CSS 逐字符字形回退：字符由字体栈里第一个含该字形的字体渲染。
// 所以顺序是前提而非风格：Times New Roman 在前，拉丁字母/数字/半角标点由它渲染，汉字落到宋体；
// 宋体在前则连英文数字也变成宋体自带的难看拉丁字形，界面只是「字有点怪」，无报错。

const CSS_PATH = new URL('../src/index.css', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

const CJK_FAMILIES = ['SimSun', '宋体', 'Songti SC', 'Noto Serif CJK SC']

function fontSansStack() {
  const css = readFileSync(CSS_PATH, 'utf8')
  const decl = /--font-sans:\s*([^;]+);/.exec(css)
  assert.ok(decl, 'index.css 里找不到 --font-sans 声明')
  return decl[1].trim()
}

test('Times New Roman 必须排在中文字体之前', () => {
  const stack = fontSansStack()
  const latin = stack.indexOf('Times New Roman')
  assert.notEqual(latin, -1, '字体栈里必须有 Times New Roman')

  const cjkPositions = CJK_FAMILIES.map((f) => stack.indexOf(f)).filter((i) => i !== -1)
  assert.ok(cjkPositions.length > 0, '字体栈里必须有中文字体')
  const firstCjk = Math.min(...cjkPositions)

  assert.ok(
    latin < firstCjk,
    '顺序反了。宋体排在前面会接管拉丁字形，英文和数字全变宋体，' +
      '而界面上只表现为"字有点怪"，不会有任何报错。\n当前栈：' + stack,
  )
})

test('兜底字族是 serif，不是 sans-serif', () => {
  // 两种字体都缺的机器（Linux、精简版 Windows）靠兜底字族：写 sans-serif 会得到与整个应用不搭的无衬线界面。
  assert.match(fontSansStack(), /\bserif\s*$/, '字体栈末尾必须是 serif')
})

test('标题字族跟随正文字族，不另起一套', () => {
  const css = readFileSync(CSS_PATH, 'utf8')
  // --font-heading 一旦被写成独立的字体列表，标题和正文就会在缺字体的机器上
  // 分别回退到不同的字体，于是同一屏出现两种衬线——"界面统一"从这里开始破。
  assert.match(
    css,
    /--font-heading:\s*var\(--font-sans\)/,
    '--font-heading 必须直接引用 --font-sans，不能另写一套字体列表',
  )
})
