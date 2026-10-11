import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// 菜单加速键失败时不报错：冲突方只是安静地不再触发，用户按下去得到另一个功能或什么也没有。
// 所以这几条锁的是「按下去会得到什么」，而非代码长什么样。

const mainSource = readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8')

const menuLangs = ['zh', 'en', 'fr', 'es', 'ru', 'ar']
const locales = Object.fromEntries(
  menuLangs.map((lang) => [
    lang,
    JSON.parse(readFileSync(new URL(`../electron/locales/${lang}.json`, import.meta.url), 'utf8')),
  ]),
)

/** buildTemplate 的函数体。别的地方也会出现 accelerator 字样（全局快捷键那套），
 *  混进来会让下面的统计失真。 */
const templateBody = (() => {
  const start = mainSource.indexOf('function buildTemplate(')
  assert.notEqual(start, -1, 'buildTemplate 必须存在')
  const end = mainSource.indexOf('\nconst menuTemplateCache', start)
  return mainSource.slice(start, end === -1 ? undefined : end)
})()

const accelerators = [...templateBody.matchAll(/accelerator: '([^']+)'/g)].map((m) => m[1])

test('确实解析到了加速键', () => {
  // 没有这一条的话，正则一旦失配，下面每一条"不许冲突"的断言都会在一个空
  // 数组上愉快地通过——测试全绿，实际什么都没检查。
  assert.ok(accelerators.length >= 12, `只解析出 ${accelerators.length} 个加速键，正则多半过时了`)
})

test('菜单里没有两项抢同一个加速键', () => {
  // 重复时 Electron 不报错，只是后注册的那个永远不响应——而"永远不响应"
  // 看起来跟"这个功能坏了"一模一样。
  const seen = new Map()
  for (const acc of accelerators) {
    assert.ok(!seen.has(acc), `加速键 ${acc} 被用了不止一次`)
    seen.set(acc, true)
  }
})

test('不占用全局快捷键已经用掉的组合', () => {
  // 全局快捷键是 OS 级注册，一定赢过菜单加速键；菜单上印一个按下去会跳到别处的快捷键比不印更糟。
  // 默认值在 DEFAULT_GLOBAL_SHORTCUTS：Ctrl+Shift+V（剪贴板记录）、Ctrl+Shift+N（速记）。
  const globalCombos = [...mainSource.matchAll(
    /(\w+): \{ key: '(\w)', ctrl: (true|false), alt: (true|false), shift: (true|false) \}/g,
  )].map(([, , key, ctrl, alt, shift]) => {
    const parts = []
    if (ctrl === 'true') parts.push('CmdOrCtrl')
    if (alt === 'true') parts.push('Alt')
    if (shift === 'true') parts.push('Shift')
    parts.push(key.toUpperCase())
    return parts.join('+')
  })
  assert.ok(globalCombos.length >= 2, '应当解析出全局快捷键默认值，实际没有——正则可能过时了')

  for (const combo of globalCombos) {
    assert.ok(
      !accelerators.includes(combo),
      `${combo} 已经是全局快捷键，菜单不能再用它`,
    )
  }
})

test('不占用渲染端自己绑着的编辑键', () => {
  // 菜单加速键在渲染端拿到 keydown **之前**就截胡。占了这些键等于把笔记
  // 编辑器里的查找/替换、文件管理器里的隐藏文件切换直接废掉。
  const rendererOwned = ['CmdOrCtrl+F', 'CmdOrCtrl+H', 'CmdOrCtrl+Shift+H']
  for (const combo of rendererOwned) {
    assert.ok(
      !accelerators.includes(combo),
      `${combo} 归渲染端（笔记编辑器 / 文件管理器）用，菜单不能抢`,
    )
  }
})

test('删除动作没有加速键', () => {
  // 菜单加速键全应用生效：给「删除到回收站」加 Delete，就等于任何输入框里按 Delete 都会删文件。
  // 这两个动作的按键归文件管理面板管，只有它知道焦点是否在文件列表上。
  const deleteBlock = templateBody.slice(
    templateBody.indexOf('fileManagerDeleteRecycle'),
    templateBody.indexOf('selectAll'),
  )
  assert.doesNotMatch(deleteBlock, /accelerator/, '删除类菜单项不许带加速键')
})

test('六种语言的菜单文案键完全一致', () => {
  // 缺键在运行时表现为菜单上出现一个 undefined，或者整个菜单构建失败——
  // 而这只会在切到那种语言时才发生，日常开发根本碰不到。
  const reference = Object.keys(locales.zh).sort()
  for (const lang of menuLangs) {
    assert.deepEqual(Object.keys(locales[lang]).sort(), reference, `${lang}.json 的键跟 zh.json 对不上`)
  }
})

test('六种语言都没有空文案', () => {
  for (const lang of menuLangs) {
    for (const [key, value] of Object.entries(locales[lang])) {
      assert.equal(typeof value, 'string', `${lang}.${key} 必须是字符串`)
      assert.ok(value.trim().length > 0, `${lang}.${key} 是空的`)
    }
  }
})

test('查看菜单能到达的面板都在渲染端接得住', () => {
  // sendNav 只是原样转发字符串；渲染端 AppShell 的 onNavigate 里没有对应
  // 分支的话，点了菜单**什么都不会发生**，而且没有任何报错。
  const shell = readFileSync(new URL('../src/components/AppShell.tsx', import.meta.url), 'utf8')
  const navTargets = [...templateBody.matchAll(/sendNav\('([a-z]+)'\)/g)].map((m) => m[1])
  assert.ok(navTargets.length > 0, '应当解析出 sendNav 的目标')
  for (const target of new Set(navTargets)) {
    assert.match(
      shell,
      new RegExp(`target === '${target}'`),
      `菜单会跳到 '${target}'，但 AppShell 的 onNavigate 没接住它`,
    )
  }
})
