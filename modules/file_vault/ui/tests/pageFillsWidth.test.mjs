import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 每一页都要把宽度用满。1920px 屏减侧栏 184px 剩 1736px，`width="default"` 把内容锁在 1100px 居中，
 * 两边各空 318px 再被 `lg:px-14` 各吃 56px，内容起点离窗口边缘 374px；`wide`（1440px）也仍有 408px。
 * `max-w` 是为阅读行长服务的，列表页/表格页/双栏工作台没有长文本行，限宽限的是「同时能看到多少条目」，纯损失。
 * 行长应管在正文那一块上（见 HelpScreen 的多列、AIChatScreen 的 `max-w-[90ch]`、SecurityHealthScreen 的 `max-w-[85ch]`）。
 * 本守卫只查一件事：`<PageShell>` 不许再用窄档。
 */

const COMPONENTS_DIR = new URL('../src/components/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

/** 允许用别的档位的地方，每一条都要写明理由。 */
const ALLOWED = new Map([
  // 目前没有例外。将来真有（比如一个纯阅读的长文页），在这里登记理由，
  // 而不是把这条测试改松。
])

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

test('每个界面的 <PageShell> 都用铺满档', () => {
  const offenders = []
  for (const file of walk(COMPONENTS_DIR)) {
    const name = file.split(/[\\/]/).pop()
    if (name === 'page.tsx') continue // 组件定义处，那里出现的是类型不是调用
    if (ALLOWED.has(name)) continue
    const src = stripComments(readFileSync(file, 'utf8'))
    for (const m of src.matchAll(/<PageShell(\s[^>]*)?>/g)) {
      const attrs = m[1] ?? ''
      const width = /width="([a-z]+)"/.exec(attrs)?.[1] ?? 'default'
      if (width !== 'canvas' && width !== 'full') {
        offenders.push(`${name}: <PageShell width="${width}"> —— 左右会空掉几百像素`)
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    '这些界面还锁在居中的窄条里，左右各空掉一大块：\n  ' + offenders.join('\n  '),
  )
})

test('铺满档的横向留白确实比窄档薄', () => {
  const page = readFileSync(join(COMPONENTS_DIR, 'ui', 'page.tsx'), 'utf8')
  // 只把 max-w 去掉是不够的：`lg:px-14` 是两侧各 56px，那一层留白还在。
  assert.match(
    page,
    /width === 'canvas'[\s\S]{0,120}?px-4 sm:px-5 lg:px-6/,
    'canvas 档必须自己一套更薄的横向留白，否则"铺满"只铺掉了 max-w 那一半',
  )
  assert.match(page, /width === 'canvas' && 'max-w-none'/, 'canvas 档不能有 max-w')
})

test('正文块自己限住行长，不跟着页面一起横穿屏幕', () => {
  // 页面铺满后行长必须由正文块自己管，否则一行 200 个字符，眼睛回行首易找错行，是看久了累的主因之一，调字号治不了。
  const checks = [
    ['AIChatScreen.tsx', /max-w-\[90ch\]/, '模型回复是整段正文，必须限行长'],
    ['SecurityHealthScreen.tsx', /max-w-\[85ch\]/, '体检项的说明是整段正文，必须限行长'],
    ['HelpScreen.tsx', /lg:grid-cols-2 2xl:grid-cols-3/, '指南章节要排成多列，不能一章横跨整屏'],
  ]
  for (const [name, pattern, why] of checks) {
    const src = readFileSync(join(COMPONENTS_DIR, name), 'utf8')
    assert.match(src, pattern, `${name}: ${why}`)
  }
})
