import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// 守住所有长列表都走虚拟化：重构时很容易被顺手拆成 .map()，本机几十条无感，
// 症状只在真实用户（上万文件）出现，只能靠机制守。

const SCREENS = {
  'ClipboardScreen.tsx': '剪贴板历史，用久了几千条起步',
  'FileManagerScreen.tsx': '文件管理器，一个目录上万个文件是常态',
  'FilesPane.tsx': '加密/解密的文件列表',
  'NotesScreen.tsx': '笔记列表',
  'PasswordScreen.tsx': '密码条目列表',
  'RecoveryCodesScreen.tsx': '恢复密钥列表',
  'pcclean/CleanItemList.tsx': '清理项列表，一次扫描能出几万条',
}

const SRC = new URL('../src/components/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

test('七个长列表界面都必须走虚拟化', () => {
  const missing = []
  for (const [file, why] of Object.entries(SCREENS)) {
    const src = readFileSync(SRC + file, 'utf8')
    if (!/useVirtualizer/.test(src)) missing.push(`${file}（${why}）`)
  }
  // 空集合判通过是最常见的"守卫看起来全绿其实没在守"的形态，
  // 所以先确认真的扫到了东西（见 tests/README.md 的两个已知弱点）。
  assert.equal(Object.keys(SCREENS).length, 7, '清单本身被改动过，先确认是不是真的少了界面')
  assert.deepEqual(
    missing,
    [],
    '下面这些长列表退回了全量渲染。本机开发时看不出区别（数据少），' +
      '但真实用户的大目录/大历史会直接卡住：\n' + missing.join('\n'),
  )
})

test('虚拟化必须给 getItemKey，否则列表一重排就串行', () => {
  // 不传 getItemKey 时 react-virtual 用下标当键，重排后 React 会把旧行状态套到新行，选中项会跳行。
  const offenders = []
  for (const file of Object.keys(SCREENS)) {
    const src = readFileSync(SRC + file, 'utf8')
    const uses = (src.match(/useVirtualizer\s*\(/g) ?? []).length
    const keys = (src.match(/getItemKey\s*:/g) ?? []).length
    if (uses > keys) offenders.push(`${file}: ${uses} 处 useVirtualizer 只有 ${keys} 处 getItemKey`)
  }
  assert.deepEqual(offenders, [], offenders.join('\n'))
})
