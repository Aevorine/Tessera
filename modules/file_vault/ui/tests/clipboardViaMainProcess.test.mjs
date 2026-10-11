import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 界面里不许出现 `navigator.clipboard`。
 * 起因：复制失败（'writeText' Write permission denied / Document is not focused）。
 * 1. main.ts 的 `denyAllWebPermissions()` 拒绝所有网页权限，含 clipboard-sanitized-write / clipboard-read。
 * 2. 网页剪贴板还要求文档有焦点；密码复制 30 秒后自动清空时用户早已切走，清空从没成功，明文一直留在剪贴板。
 * 修法是走主进程 `electron.clipboard`（不看权限和焦点）；写回 navigator.clipboard 症状会照旧且界面无提示，故用测试钉住。
 */

const SRC = new URL('../src/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const ELECTRON = new URL('../electron/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

/** 唯一允许直接碰网页剪贴板的地方：兜底链条自己就在那儿。 */
const CLIPBOARD_LIB = 'clipboard.ts'

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (/\.tsx?$/.test(entry.name)) out.push(full)
  }
  return out
}

/** 去掉注释——本文件和 clipboard.ts 的注释里都会提到这个名字。 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

test('界面代码里不再直接调用 navigator.clipboard', () => {
  const offenders = []
  for (const file of walk(SRC)) {
    const name = file.split(/[\\/]/).pop()
    if (name === CLIPBOARD_LIB) continue
    const code = stripComments(readFileSync(file, 'utf8'))
    if (/navigator\s*\.\s*clipboard/.test(code)) {
      offenders.push(name)
    }
  }
  assert.deepEqual(
    offenders,
    [],
    '这些文件绕过了 src/lib/clipboard.ts 直接用网页剪贴板，在本应用里必然失败：\n  ' +
      offenders.join('\n  ') +
      '\n改用 copyText() / readClipboardText() / copyTextWithAutoClear()。',
  )
})

test('主进程提供了原生剪贴板的读写通道', () => {
  const main = readFileSync(join(ELECTRON, 'main.ts'), 'utf8')
  for (const channel of ['system:clipboardWriteText', 'system:clipboardReadText']) {
    assert.match(main, new RegExp(`ipcMain\\.handle\\('${channel}'`), `缺少 ${channel} 处理器`)
  }
  // 这两个 IPC 能读写用户剪贴板，必须和其他 IPC 一样只认本应用页面。
  // 函数体取「从 handle 行到下一条 handle 之前」，按固定字符数截会随注释增删时对时错。
  for (const channel of ['system:clipboardWriteText', 'system:clipboardReadText']) {
    const start = main.indexOf(`ipcMain.handle('${channel}'`)
    assert.notEqual(start, -1, `找不到 ${channel} 处理器`)
    const rest = main.slice(start + 1)
    const nextHandle = rest.indexOf('ipcMain.handle(')
    const body = nextHandle === -1 ? rest : rest.slice(0, nextHandle)
    assert.match(body, /assertTrustedRenderer\(event\)/, `${channel} 必须校验调用方`)
  }
})

test('preload 把这两条通道暴露给渲染端', () => {
  const preload = readFileSync(join(ELECTRON, 'preload.ts'), 'utf8')
  assert.match(preload, /clipboardWriteText:/, 'preload 没有暴露 clipboardWriteText')
  assert.match(preload, /clipboardReadText:/, 'preload 没有暴露 clipboardReadText')
})

test('网页剪贴板权限仍然是拒绝的（修剪贴板不等于把防线拆了）', () => {
  // 守「别用错误方式修」：放开 clipboard 权限也能让复制工作，但 XSS 打进渲染进程后就能读剪贴板；走主进程零代价。
  const main = readFileSync(join(ELECTRON, 'main.ts'), 'utf8')
  const fn = /function denyAllWebPermissions\(\)[\s\S]*?\n\}/.exec(main)
  assert.ok(fn, '找不到 denyAllWebPermissions()')
  assert.match(fn[0], /setPermissionRequestHandler[\s\S]*?callback\(false\)/, '权限请求必须仍然一律拒绝')
  assert.match(fn[0], /setPermissionCheckHandler[\s\S]*?return false/, '权限查询必须仍然一律拒绝')
  assert.doesNotMatch(fn[0], /clipboard/i, '不许为了修复制功能给 clipboard 权限开后门')
})

test('自动清空剪贴板只有一份实现', () => {
  // 密码页和恢复密钥页原来各抄了一份，两份都坏了。合并之后如果有人再抄回去，
  // 坏的那一份不会有任何人发现——它的失败是静默的。
  const copies = []
  for (const file of walk(SRC)) {
    const name = file.split(/[\\/]/).pop()
    if (name === CLIPBOARD_LIB) continue
    const code = stripComments(readFileSync(file, 'utf8'))
    if (/setTimeout\([^)]*\n?[\s\S]{0,200}?writeText\(\s*''\s*\)/.test(code)) copies.push(name)
  }
  assert.deepEqual(copies, [], '这些文件又自己实现了一遍剪贴板自动清空，改用 copyTextWithAutoClear()：\n  ' + copies.join('\n  '))
})
