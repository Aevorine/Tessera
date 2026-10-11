/**
 * 恢复码 JSON 导入/导出的界面不变量，都是错了会静默丢数据或泄密、类型和 lint 看不出的地方：
 *   · 加密与脱敏互斥，界面不能让两者同时勾上（后端也会拒，但先勾满再报错体验差）
 *   · 明文导出必须有明确警告，那份文件等于绕过两步验证的后门
 *   · 「校验值缺失」与「校验没过」必须分开，否则每打开旧文件都弹假警报
 *   · 预览步骤绝不能调 confirm
 * 跑法：`npm run test:update`
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const SOURCE = readFileSync(
  fileURLToPath(new URL('../src/components/RecoveryCodesScreen.tsx', import.meta.url)),
  'utf8',
)

/** 取出 `function <name>(` 或 `async function <name>(` 到下一个函数声明之间的那一段。 */
function functionBody(name) {
  const start = SOURCE.search(new RegExp(`(async )?function ${name}\\(`))
  assert.notEqual(start, -1, `找不到函数 ${name}`)
  const next = SOURCE.slice(start + 1).search(/\n {2}(async )?function /)
  return next === -1 ? SOURCE.slice(start) : SOURCE.slice(start, start + 1 + next)
}

test('选 JSON 时先进选项对话框，而不是直接开始导出', () => {
  const body = functionBody('handleExportWithFormat')
  const branch = body.slice(body.indexOf("if (fmt === 'json')"))
  assert.match(branch, /setJsonExportOpen\(true\)/)
  // return 必须在里面——漏了的话会既弹对话框又立刻用默认选项导出一次。
  assert.match(branch, /requireReverify\([\s\S]{0,80}?\)\s*\n\s*return/)
})

test('打开 JSON 导出前要求重新验证身份', () => {
  // 跟"导出完整备份"同一道门槛：两个动作都会把整套恢复码带离这台机器。
  const body = functionBody('handleExportWithFormat')
  assert.match(body, /requireReverify\(\(\) => setJsonExportOpen\(true\)\)/)
})

test('默认加密', () => {
  // 把"明文落盘"设成默认值，等于让最不安全的结果成为不做选择时的结果。
  assert.match(SOURCE, /useState\(true\)\s*\n[\s\S]{0,120}?jsonExportPassword/)
  assert.match(SOURCE, /const \[jsonExportEncrypt, setJsonExportEncrypt\] = useState\(true\)/)
})

test('明文导出必须再勾一次确认才能点导出', () => {
  // 一句红字可以被无视，一个必须点的勾不能。
  assert.match(
    SOURCE,
    /disabled=\{!jsonExportEncrypt && !jsonExportRedact && !jsonExportPlaintextAck\}/,
  )
  // 每次打开对话框都要重置，不能让上一次的确认延续到下一次。
  assert.match(functionBody('handleExportWithFormat'), /setJsonExportPlaintextAck\(false\)/)
})

test('有勾选时 JSON 导出只导勾选的那几个', () => {
  const body = functionBody('handleExportWithFormat')
  assert.match(body, /setJsonExportIds\(visibleSelectedIds\.length > 0 \? visibleSelectedIds : undefined\)/)
})

test('加密和脱敏在界面上互斥', () => {
  // 两个勾选框各自都要在被勾上时把对方关掉。后端会拒绝同时给两者，
  // 但让用户勾满了再挨一句报错，等于把一个能提前避免的错误留到最后。
  const encryptBlock = SOURCE.slice(SOURCE.indexOf('checked={jsonExportEncrypt}'))
  assert.match(encryptBlock.slice(0, 500), /setJsonExportRedact\(false\)/)
  const redactBlock = SOURCE.slice(SOURCE.indexOf('checked={jsonExportRedact}'))
  assert.match(redactBlock.slice(0, 500), /setJsonExportEncrypt\(false\)/)
})

test('既不加密也不脱敏时，明文警告必须出现', () => {
  assert.match(
    SOURCE,
    /\{!jsonExportEncrypt && !jsonExportRedact && \([\s\S]{0,600}?jsonExportPlaintextWarning/,
  )
})

test('导入先不问密码，后端说需要才问', () => {
  const body = functionBody('handleJsonImportPickFile')
  // 绝大多数导出是明文的，让每个人都先过一道密码框纯属添堵。
  assert.match(body, /runJsonImportPreview\(paths\[0\], ''\)/)
  const preview = functionBody('runJsonImportPreview')
  assert.match(preview, /res\.error === 'recovery_codes\.json_password_required'[\s\S]{0,120}?setJsonImportStep\('password'\)/)
})

test('预览步骤不写任何东西——它绝不能调 confirm', () => {
  const preview = functionBody('runJsonImportPreview')
  assert.doesNotMatch(preview, /json_import_confirm/)
  assert.match(preview, /vaultApi\.call\('recovery_codes_json_import_preview'/)
})

test('冲突默认保留本地，仅文件有的默认导入', () => {
  const preview = functionBody('runJsonImportPreview')
  // 覆盖和合并都得用户主动选：默认值不该替人做出会丢数据的决定。
  assert.match(preview, /status === 'backup_only'\) defaults\[item\.key\] = 'use_file'/)
  assert.match(preview, /status === 'conflict'\) defaults\[item\.key\] = 'keep_local'/)
})

test('校验值「没带」和「没过」是两回事，只有后者报警', () => {
  // checksumOk === false 才弹红框。写成 !jsonImportMeta?.checksumOk 的话，
  // 每打开一份没有校验值的旧导出都会来一次假警报，真警报也就没人看了。
  assert.match(SOURCE, /jsonImportMeta\?\.checksumOk === false &&/)
  assert.doesNotMatch(SOURCE, /!jsonImportMeta\?\.checksumOk &&/)
})

test('导入完成后用后端回的 groups 刷新界面', () => {
  const body = functionBody('handleJsonImportConfirm')
  assert.match(body, /setGroups\(res\.groups\)/)
})
