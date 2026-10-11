/**
 * 剪贴板去重界面的四条不变量。同 clipboardVirtualRows.test.mjs 在源码层守：
 * 它们都不报错，症状是「多写了一份明文」或「按钮永远转圈」。跑法：`npm run test:update`
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const SOURCE = readFileSync(
  fileURLToPath(new URL('../src/components/ClipboardScreen.tsx', import.meta.url)),
  'utf8',
)

test('导出的验证门按"会不会写出隐藏内容"判，不按 scope 名字判', () => {
  // 旁路修复：原先只有 `scope === 'hidden'` 要求重新验证，但「全部记录」也会导出隐藏条目，
  // 用户不用验证就拿到含隐藏内容的明文文件。
  const gate = SOURCE.slice(
    SOURCE.indexOf('const willExportHidden'),
    SOURCE.indexOf('const defaultName'),
  )
  assert.ok(gate.length > 0, '找不到 willExportHidden 这道门')

  for (const scope of ['all', 'pinned', 'selected']) {
    assert.match(
      gate,
      new RegExp(`scope === '${scope}'[\\s\\S]{0,120}is_hidden`),
      `scope '${scope}' 也可能导出隐藏条目，必须纳入验证判据`,
    )
  }
  assert.match(
    SOURCE,
    /if \(willExportHidden && !\(await ensureFreshlyUnlocked\(\)\)\) return/,
    '判定为会导出隐藏内容时必须真的挡住，验证不过就直接 return',
  )
})

test('重复项清单不显示隐藏条目的正文', () => {
  // 「只看隐藏」要过一次验证才能进。如果这个对话框把隐藏条目的原文直接摆出来，
  // 它就成了绕开那道验证看隐藏内容的旁路——而且是个看起来完全无害的清单界面。
  const dialog = SOURCE.slice(
    SOURCE.indexOf('dedupeDialogTitle'),
    SOURCE.indexOf('dedupeUndoHint'),
  )
  assert.ok(dialog.length > 0, '找不到清理重复项对话框')
  assert.match(
    dialog,
    /group\.is_hidden\s*\?\s*t\('dedupeHiddenPreview'\)\s*:\s*group\.preview/,
    '隐藏组必须显示占位文案而不是 group.preview',
  )
})

test('导入结果把跳过的重复条数一起报出来', () => {
  // 同一份备份第二次导入 imported_count 为 0，只报它会与「文件是空的」「导入失败」无法区分，须一并显示 skipped_count。
  assert.match(
    SOURCE,
    /res\.skipped_count > 0[\s\S]{0,240}importedWithSkippedToast/,
    'skipped_count 大于 0 时要走带跳过条数的那句文案',
  )
})

test('扫描/合并的忙碌状态复位放在 finally 里', () => {
  // vaultApi.call 会抛（后端 error 信封在 pythonBridge 层是 reject）；复位写在 await 之后的话，
  // 抛出那次会让按钮永久卡在「扫描中/合并中」且屏幕无提示。
  for (const [fn, setter] of [
    ['handleScanDuplicates', 'setDupScanning'],
    ['handleMergeDuplicates', 'setDupMerging'],
  ]) {
    const body = SOURCE.slice(
      SOURCE.indexOf(`async function ${fn}(`),
      SOURCE.indexOf(`async function ${fn}(`) + 1600,
    )
    assert.match(
      body,
      new RegExp(`finally\\s*\\{[\\s\\S]{0,400}${setter}\\(false\\)`),
      `${fn} 的 ${setter}(false) 必须在 finally 里`,
    )
  }
})
