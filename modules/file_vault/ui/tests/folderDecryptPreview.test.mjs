/**
 * 文件夹解密预览「确认到一半不许被丢弃」。症状：选好目标文件夹后报「文件夹解密预览已失效」。
 * 根因在前端：handleConfirmFolderDecrypt 先 await 原生选择文件夹对话框，期间 Radix Dialog 仍开着，
 * 原生窗口抢焦点被 DismissableLayer 当成点到外面 → onOpenChange(false) → handleCancelFolderDecrypt →
 * decrypt_folder_discard 注销了预览，全程不报错。跑法：`npm run test:update`
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const SOURCE = readFileSync(
  fileURLToPath(new URL('../src/components/FilesPane.tsx', import.meta.url)),
  'utf8',
)

// 先去掉注释再用正则比对：守卫按源码文本匹配，解释「以前不做 setFolderPreview(null) 会怎样」的注释
// 会让 `doesNotMatch(/setFolderPreview\(null\)/)` 误报，守卫应只看代码。
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

function functionBody(name) {
  const start = SOURCE.indexOf(`async function ${name}(`)
  assert.notEqual(start, -1, `找不到 ${name}`)
  const next = SOURCE.indexOf('\n  async function ', start + 1)
  const alt = SOURCE.indexOf('\n  function ', start + 1)
  const end = Math.min(...[next, alt].filter((i) => i !== -1))
  return stripComments(SOURCE.slice(start, Number.isFinite(end) ? end : undefined))
}

test('确认流程在跑的时候，丢弃这条路被挡住', () => {
  const cancel = functionBody('handleCancelFolderDecrypt')
  assert.match(
    cancel,
    /if \(!folderPreview \|\| folderConfirmInFlight\.current\) return/,
    'handleCancelFolderDecrypt 必须在确认进行中直接返回，否则原生对话框抢焦点就会丢掉预览',
  )
})

test('确认自己也要防重入，并且无论走哪条路都把标志复位', () => {
  const confirm = functionBody('handleConfirmFolderDecrypt')
  assert.match(confirm, /if \(!folderPreview \|\| folderConfirmInFlight\.current\) return/)
  assert.match(confirm, /folderConfirmInFlight\.current = true/)
  assert.ok(
    /finally\s*\{[\s\S]{0,300}?folderConfirmInFlight\.current = false/.test(confirm),
    '复位必须在 finally 里——中途 return（用户取消了选目录）也要复位，否则这个对话框从此再也关不掉',
  )
})

test('确认失败时预览留着，让用户换个目录再点一次', () => {
  const confirm = functionBody('handleConfirmFolderDecrypt')
  // 成功路径才关对话框并走下一步，失败只弹 toast、不 setFolderPreview(null)。
  // 分界用只属于失败路径的文案键 `decryptFailedToast`，不用「第一个 toast.error」：
  // 成功路径也会弹错误提示（解密成功但安全删除失败，见 sourceNotDeletedError）。
  const failureMarker = confirm.indexOf("t('decryptFailedToast')")
  assert.ok(failureMarker > 0, '找不到失败分支的标志文案')
  const successBranch = confirm.slice(confirm.indexOf('if (res.ok)'), failureMarker)
  assert.match(successBranch, /setFolderPreview\(null\)/, '成功后要关掉预览并处理队列里的下一个')
  const failureBranch = confirm.slice(failureMarker)
  assert.doesNotMatch(
    failureBranch,
    /setFolderPreview\(null\)/,
    '失败时不能关掉预览——清单是免费拿到的，换个目录重试就能成，不必整包重解',
  )
})

// ---- 下面三条守的是 2026-08-02 那次「点确认后卡住、还关不掉」----

test('确认里的 RPC 必须被 catch 住', () => {
  const confirm = functionBody('handleConfirmFolderDecrypt')
  assert.match(
    confirm,
    /\}\s*catch\s*\(/,
    'vaultApi.call 会抛（后端 error 信封走 reject、桥接层静默超时也走 reject）。' +
      '没有 catch 的话异常会变成一条没人处理的 rejection：屏幕上一个字都没有，' +
      'setFolderPreview(null) 也永远执行不到，对话框就那么挂着关不掉',
  )
})

test('取消必须先关对话框，不能等任何后端往返', () => {
  const cancel = functionBody('handleCancelFolderDecrypt')
  const close = cancel.indexOf('setFolderPreview(null)')
  assert.ok(close > 0, 'handleCancelFolderDecrypt 必须真的关掉预览')
  const beforeClose = cancel.slice(0, close)
  assert.doesNotMatch(
    beforeClose,
    /await\s+vaultApi\.call/,
    '关闭对话框是纯前端状态，不该排在任何 RPC 后面。' +
      '排在后面就意味着后端崩溃/重启/超时的时候，这个对话框永远关不掉',
  )
})

test('文件夹解密要有进度界面', () => {
  const confirm = functionBody('handleConfirmFolderDecrypt')
  assert.match(
    confirm,
    /setQueueItems\(\[/,
    '进度浮层的渲染条件是 `showProgress && queueItems`。只 setBusyLabel 而不给 ' +
      'queueItems，解大文件夹时屏幕上一个字都没有，看起来就是整个应用卡死了',
  )
  assert.match(confirm, /vaultApi\.onProgress\(/, '要订阅进度，否则那条进度条永远停在 0%')
})
