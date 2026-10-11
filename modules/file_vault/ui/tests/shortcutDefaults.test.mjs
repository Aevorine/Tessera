import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

/**
 * 出厂键位在三个运行时各有一份且不能互相 import：ui_settings.py::DEFAULT_FILE_MANAGER_SHORTCUTS、
 * electron/main.ts::DEFAULT_GLOBAL_SHORTCUTS、src/lib/shortcutDefaults.ts，靠本测试逐字段比对。
 * 分家时没有报错，只是速查卡写的键按下去没反应。
 */

const rendererSource = readFileSync(new URL('../src/lib/shortcutDefaults.ts', import.meta.url), 'utf8')
const mainSource = readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8')
const pySource = readFileSync(new URL('../../ui_settings.py', import.meta.url), 'utf8')

/**
 * 取 `NAME = { ... }` 的花括号段。必须锚在声明上：别的文件注释里也提到这些名字，
 * 裸 indexOf 会命中注释并取到另一个对象。
 */
function blockOf(source, name) {
  const decl = new RegExp(`(?:^|\\n)\\s*(?:export\\s+)?(?:const\\s+)?${name}\\s*(?::[^=\\n]*)?=\\s*\\{`)
  const found = decl.exec(source)
  assert.ok(found, `${name} 的声明必须存在`)
  const start = found.index
  const open = source.indexOf('{', start)
  assert.notEqual(open, -1, `${name} 后面必须跟一个对象字面量`)
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) return source.slice(open, i + 1)
    }
  }
  assert.fail(`${name} 的花括号没有配平`)
}

/** 把 TS 对象字面量和 Python dict 归一成 `{ 动作名: 'key|ctrl|alt|shift' }` 再比较。 */
const ENTRY_RE =
  /["']?(\w+)["']?\s*:\s*\{\s*["']?key["']?\s*:\s*["'](\w+)["']\s*,\s*["']?ctrl["']?\s*:\s*(True|False|true|false)\s*,\s*["']?alt["']?\s*:\s*(True|False|true|false)\s*,\s*["']?shift["']?\s*:\s*(True|False|true|false)/g

function parseBindings(block, label) {
  ENTRY_RE.lastIndex = 0
  const out = {}
  let m
  while ((m = ENTRY_RE.exec(block))) {
    const [, action, key, ctrl, alt, shift] = m
    const bool = (v) => String(v).toLowerCase()
    out[action] = `${key}|${bool(ctrl)}|${bool(alt)}|${bool(shift)}`
  }
  // 没有这一条，正则一旦过时就会在两个空对象上愉快地通过——
  // 测试全绿，实际什么都没比。
  assert.ok(Object.keys(out).length > 0, `${label} 一条都没解析出来，正则多半过时了`)
  return out
}

const rendererFm = parseBindings(
  blockOf(rendererSource, 'DEFAULT_FILE_MANAGER_SHORTCUTS'),
  'renderer/file-manager',
)
const rendererGlobal = parseBindings(blockOf(rendererSource, 'DEFAULT_GLOBAL_SHORTCUTS'), 'renderer/global')
const mainGlobal = parseBindings(blockOf(mainSource, 'DEFAULT_GLOBAL_SHORTCUTS'), 'main/global')
const pyFm = parseBindings(blockOf(pySource, 'DEFAULT_FILE_MANAGER_SHORTCUTS'), 'python/file-manager')

test('五条文件操作键位：渲染层跟 Python 后端逐字段一致', () => {
  assert.deepEqual(rendererFm, pyFm)
})

test('五条一条不少', () => {
  assert.deepEqual(Object.keys(rendererFm).sort(), [
    'copy',
    'cut',
    'delete_permanent',
    'delete_recycle',
    'paste',
  ])
})

test('三条全局键位：渲染层跟 Electron 主进程逐字段一致', () => {
  assert.deepEqual(rendererGlobal, mainGlobal)
})

test('三条一条不少', () => {
  assert.deepEqual(Object.keys(rendererGlobal).sort(), ['clipboardCapture', 'quickNote', 'toggleWindow'])
})

test('出厂键位只在 lib/shortcutDefaults.ts 里定义一次，组件不再各抄一份', () => {
  // 抄一份的成本不是重复代码，是"改了一处另一处继续显示旧值，且不报错"。
  // ShortcutSettings.tsx 曾经就抄着一份，顶着一句管不住任何事的注释。
  const settings = readFileSync(new URL('../src/components/ShortcutSettings.tsx', import.meta.url), 'utf8')
  assert.ok(
    !/const\s+DEFAULT_(FILE_MANAGER|GLOBAL)_SHORTCUTS\s*[:=]/.test(settings),
    'ShortcutSettings.tsx 又自己定义了一份出厂键位，应该从 @/lib/shortcutDefaults import',
  )
  assert.match(settings, /from\s+'@\/lib\/shortcutDefaults'/)
})

test('速查卡不在挂载时就去打需要解锁的后端接口', () => {
  // 速查卡挂在 App 最外层，登录页冷启动即调 file_manager_shortcuts_get 并收到 auth.not_unlocked；
  // `void ...then()` 没人接这个 rejection。行为测试见 shortcutCheatSheetLocked.test.tsx，这里守 enabled 参数不被摘掉。
  const sheet = readFileSync(new URL('../src/components/ShortcutCheatSheet.tsx', import.meta.url), 'utf8')
  assert.match(sheet, /useShortcutRows\(\s*open\s*\)/, '速查卡必须只在打开时才取键位')

  const hook = readFileSync(new URL('../src/lib/useShortcutRows.ts', import.meta.url), 'utf8')
  assert.match(hook, /if\s*\(\s*!enabled\s*\)\s*return/, 'enabled 为 false 时必须直接不发请求')
  // 两条链路各要一个 .catch：锁屏时用户真按了 ?，请求照样会失败。
  assert.ok(
    (hook.match(/\.catch\(/g) || []).length >= 2,
    'useShortcutRows 的两条 Promise 链都必须有 .catch',
  )
})
