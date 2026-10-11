/**
 * 守卫：纯图标控件必须有悬停提示。应用里并存三套提示：Radix `<Tooltip>`（200ms、跟主题，唯一正确）、
 * 原生 `title=`（约 1 秒延迟、像没反应）、只有 `aria-label`（悬停无任何显示，只喂屏幕阅读器）。
 * 人工 review 拦不住（写了 aria-label 就以为标注过），故机器检查。
 * 范围刻意收窄到无可见文字的纯图标控件，有文字的按钮自解释，强制只会制造豁免清单。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

const COMPONENT_DIR = new URL('../src/components/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

/** 这些文件本身就是提示机制的实现，不参与检查。 */
const INFRASTRUCTURE = new Set(['ActionButton.tsx', 'IconToolbar.tsx', 'tooltip.tsx'])

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (name.endsWith('.tsx')) out.push(full)
  }
  return out
}

/** 找出只渲染一个图标、没有可见文字的 `<Button>` / `<button>`（闭合标签之间只有一个 `<SomeIcon className="... h-4 ..." />`）。 */
/**
 * 找开标签真正的结束位置，不能直接找第一个 `>`：`onClick={() => doThing()}` 的箭头就含 `>`，
 * 朴素正则会在那儿截断，漏掉的恰是带回调的绝大多数按钮。这里按引号和花括号深度扫描，只认深度 0 的 `>`。
 */
function endOfOpenTag(source, from) {
  let depth = 0
  let quote = null
  for (let i = from; i < source.length; i++) {
    const c = source[i]
    if (quote) {
      if (c === quote && source[i - 1] !== '\\') quote = null
      continue
    }
    if (c === '"' || c === "'" || c === '`') quote = c
    else if (c === '{') depth++
    else if (c === '}') depth--
    else if (c === '>' && depth === 0) return i
  }
  return -1
}

function iconOnlyControls(source) {
  const found = []
  const open = /<(Button|button)\b/g
  let m
  while ((m = open.exec(source)) !== null) {
    const tag = m[1]
    const tagEnd = endOfOpenTag(source, open.lastIndex)
    if (tagEnd === -1) continue
    const attrs = source.slice(open.lastIndex, tagEnd)
    if (attrs.trimEnd().endsWith('/')) continue // 自闭合，没有子节点
    const closeIdx = source.indexOf(`</${tag}>`, tagEnd)
    if (closeIdx === -1) continue
    const body = source.slice(tagEnd + 1, closeIdx)

    // 嵌套了同名标签就跳过——正则配不准，交给人工。
    if (body.includes(`<${tag}`)) continue

    // 图标判定必须同时认三种写法，少一种就是静默盲区：`className="h-4 w-4"`（旧）、`className="size-4"`
    // （Tailwind v4 简写，仓库 202 处）、`className={cn('size-4',…)}`。曾只认第一种，size-N 的图标按钮从未被检查，
    // 测试全绿而用户仍看不到提示：检查器有洞比没有更危险，因为它让人不再去看。
    const hasIcon = /<[A-Z]\w*\s+[^>]*className=(?:"[^"]*|\{[^}]*)\b(?:size|h)-[0-9.]+/.test(body)
    if (!hasIcon) continue

    // 「有没有可见文字」不枚举文字写法（`{tag}`、`{cond ? a : b}`、裸文本总会漏），反过来判定：
    // 去掉自闭合图标元素和空白后只要还剩任何东西，就有可见内容，不算纯图标。
    const remainder = body
      .replace(/<[A-Z]\w*\s[^>]*\/>/g, '') // <Icon ... />
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, '') // {/* 注释 */}
      .trim()
    if (remainder !== '') continue

    found.push({
      index: m.index,
      line: source.slice(0, m.index).split('\n').length,
      attrs,
    })
  }
  return found
}

/** 该控件往上 8 行内有没有 TooltipTrigger（`asChild` 包裹的标准写法）。 */
function wrappedInTooltip(source, index) {
  const before = source.slice(Math.max(0, index - 400), index)
  return before.includes('TooltipTrigger')
}

test('每个纯图标控件都有 Radix Tooltip，而不是 title= 或只有 aria-label', () => {
  const offenders = []

  for (const file of walk(COMPONENT_DIR)) {
    const name = file.split(/[\\/]/).pop()
    if (INFRASTRUCTURE.has(name)) continue
    const source = readFileSync(file, 'utf-8')

    for (const ctrl of iconOnlyControls(source)) {
      if (wrappedInTooltip(source, ctrl.index)) continue
      const how = /title=/.test(ctrl.attrs)
        ? '用了原生 title=（约 1 秒延迟、样式不一致）'
        : /aria-label=/.test(ctrl.attrs)
          ? '只有 aria-label（鼠标悬停毫无提示）'
          : '完全没有任何提示'
      offenders.push(`${name}:${ctrl.line} ${how}`)
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `以下纯图标控件缺少 Radix Tooltip：\n  ${offenders.join('\n  ')}\n\n` +
      `修法：用 <Tooltip><TooltipTrigger asChild>…</TooltipTrigger><TooltipContent>名称</TooltipContent></Tooltip> 包起来，\n` +
      `或者直接改用 ActionButton（它天然三合一：图标 + 文字 + 悬停提示）。`,
  )
})

/**
 * 禁用的图标按钮也必须能显示提示。真因：禁用按钮不派发 pointer 事件，Radix 收不到 hover，Tooltip 永不弹；
 * 而工具栏图标常是禁用的（没选文件时复制/剪切/删除全灰），正是最需要知道用途的时刻。
 * 修法是给禁用态套一层仍收事件的包装元素，这里检查它还在。
 */
test('禁用态的图标按钮包了一层能接收 hover 的元素', () => {
  const files = ['ActionButton.tsx', 'IconToolbar.tsx']
  for (const name of files) {
    const src = readFileSync(join(COMPONENT_DIR, name), 'utf-8')

    assert.match(
      src,
      /disabled\s*\?\s*\(\s*<span[^>]*pointer-events-auto/,
      `${name}: 禁用态必须套一层 pointer-events-auto 的包装，否则 Tooltip 收不到 hover`,
    )
    // 包装层必须能拿焦点，键盘用户同样要能得到提示
    assert.match(
      src,
      /<span[^>]*pointer-events-auto[^>]*tabIndex=\{0\}/,
      `${name}: 包装层需要 tabIndex={0}，让键盘也能触发提示`,
    )
  }
})

/**
 * Button 必须 forwardRef。此前是普通函数组件，ref 被静默丢掉，Radix `<TooltipTrigger asChild>`
 * 拿不到子元素 ref 就挂不上事件也定位不了，所有基于 Button 的图标提示全部失效（导航栏用原生 <button> 所以正常）。
 * React 只在控制台留一句 "Function components cannot be given refs"，易被当无害警告。
 * 受影响不止 Tooltip：DropdownMenuTrigger / PopoverTrigger / DialogTrigger 等所有 asChild 用法。
 */
test('Button 用 forwardRef 转发 ref（否则所有 asChild 触发器都失效）', () => {
  const src = readFileSync(join(COMPONENT_DIR, 'ui', 'button.tsx'), 'utf-8')

  assert.match(
    src,
    /React\.forwardRef<[^>]*>\(/,
    'Button 必须用 React.forwardRef 包起来',
  )
  assert.match(
    src,
    /<Comp\s+ref=\{ref\}/,
    'forwardRef 拿到的 ref 必须真的透传到底层元素上，只包一层不转发等于没改',
  )
})
