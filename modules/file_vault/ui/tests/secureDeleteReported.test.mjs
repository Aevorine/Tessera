/**
 * 「加密成功了，但勾选的安全删除没成功」必须报出来，不许报成完成。
 * 这是真实 bug 的前端那一半：后端一直回 `source_deleted: false` + `delete_error`，ipcTypes.ts 也声明了，
 * 但 FilesPane.tsx 只看 `res.ok`（加密本身成功故恒为 true），弹绿色「加密完成」，而文件夹还在、一字不报错。
 * 多一个或少一个 toast 的截图长得一样，只能在源码层钉住。跑法：`npm run test:update`
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

const FILES = read('../src/components/FilesPane.tsx')
const LOCALES = ['en', 'zh', 'fr', 'es', 'ru', 'ar']

test('批量加解密：source_deleted === false 的行算失败，不算成功', () => {
  assert.match(
    FILES,
    /res\.source_deleted === false/,
    'runBatch 必须真的读 source_deleted —— 只看 res.ok 的话删除失败永远是隐形的',
  )
  // ok 必须被 deleteFailed 拉下来，否则这一行照样进"成功"计数、照样弹绿 toast。
  assert.match(
    FILES,
    /const ok = res\.ok && !deleteFailed/,
    '删除失败必须把这一行判成失败，否则汇总里仍然显示全部成功',
  )
})

test('文件夹解密确认：删不掉 .ivault 时弹错误而不是成功', () => {
  // 按**函数定义**切，不按名字第一次出现切：这两个名字在上方的注释里都提到过。
  const start = FILES.indexOf('async function handleConfirmFolderDecrypt')
  const end = FILES.indexOf('async function handleCancelFolderDecrypt')
  assert.ok(start > 0 && end > start, '找不到 handleConfirmFolderDecrypt 的函数体')
  const block = FILES.slice(start, end)
  assert.match(
    block,
    /deleteSourceOnDecrypt && res\.source_deleted === false/,
    '文件夹解密这条路径也要看 source_deleted —— 它和 runBatch 是两套代码，修一边等于没修',
  )
  assert.match(block, /toast\.error\(\s*t\('sourceNotDeletedError'/, '必须走 toast.error，不能只在成功文案里加一句')
})

test('六种语言都有这两条文案，否则界面回落成显示原始 key', () => {
  for (const lang of LOCALES) {
    const files = JSON.parse(read(`../src/i18n/locales/${lang}/files.json`))
    assert.ok(files.sourceNotDeletedError, `${lang}/files.json 缺 sourceNotDeletedError`)
    assert.ok(files.sourceNotDeletedUnknownReason, `${lang}/files.json 缺 sourceNotDeletedUnknownReason`)
    assert.match(
      files.sourceNotDeletedError,
      /\{\{reason\}\}/,
      `${lang} 的 sourceNotDeletedError 丢了 {{reason}} 占位符，用户就只知道"失败了"不知道为什么`,
    )

    const errors = JSON.parse(read(`../src/i18n/locales/${lang}/errors.json`))
    for (const code of [
      'container.secure_delete_incomplete',
      'container.secure_delete_dir_remains',
      'container.secure_delete_not_overwritten',
    ]) {
      assert.ok(errors[code], `${lang}/errors.json 缺 ${code}`)
    }
  }
})

test('三个按钮文案不带「...」和「（可多选）」，但选择器行为不变', () => {
  for (const lang of LOCALES) {
    const files = JSON.parse(read(`../src/i18n/locales/${lang}/files.json`))
    for (const key of ['encryptButton', 'encryptFolderButton', 'decryptButton']) {
      assert.doesNotMatch(files[key], /\.\.\.|…/, `${lang}/${key} 仍带省略号`)
      assert.doesNotMatch(
        files[key],
        /[（(]/,
        `${lang}/${key} 仍带括号说明`,
      )
    }
  }
  // 功能不变的那一半：多选和选目录的能力在这里，不在文案里。
  assert.match(FILES, /properties: \['openFile', 'multiSelections'\]/, '加密/解密仍必须支持多选')
  assert.match(FILES, /openDirectory\(\{ title: t\('selectFolderToEncryptTitle'\) \}\)/, '文件夹加密仍必须选目录')
})
