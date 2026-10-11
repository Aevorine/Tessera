import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  LOGIN_LAUNCH_ARG,
  effectiveOpenAtLogin,
  parseRegQueryApproved,
  parseRegQueryString,
  parseStartupPreferences,
  planLoginItemOnLaunch,
  shouldStartHidden,
} from '../electron/startupMode.ts'

const mainSource = await readFile(new URL('../electron/main.ts', import.meta.url), 'utf8')

/**
 * 开机自启动的不变量：读写必须用同一个名字、路径和参数。
 * 曾只断言「写」的一半：setLoginItemSettings 写 com.ideal1.filevault，而 Windows 上
 * getLoginItemSettings 不接受自定义值名、只按 AppUserModelId 读，应用又没调用 setAppUserModelId，
 * 结果注册表写对了但回读永远 false，设置页把开关弹回去。
 */

test('注册表值名与 AppUserModelId 是同一个常量（读写才对得上）', () => {
  const declared = mainSource.match(/const AUTOSTART_REGISTRY_NAME = '([^']+)'/)
  assert.ok(declared, '应当有一个 AUTOSTART_REGISTRY_NAME 常量')

  // 必须真的设进 AppUserModelId——getLoginItemSettings 只认这个。
  assert.match(
    mainSource,
    /app\.setAppUserModelId\(AUTOSTART_REGISTRY_NAME\)/,
    'AppUserModelId 必须设成同一个常量，否则回读会落到 Chromium 算出来的默认 ID 上',
  )
})

test('登录项路径在 portable 模式下指向稳定 exe，且读写用同一个路径和参数', () => {
  assert.match(mainSource, /const LOGIN_ITEM_EXE_PATH = process\.env\.PORTABLE_EXECUTABLE_FILE \?\? process\.execPath/)
  assert.match(mainSource, /const LOGIN_ITEM_ARGS = \[LOGIN_LAUNCH_ARG\]/)

  assert.match(
    mainSource,
    /setLoginItemSettings\(\{\s*openAtLogin,\s*path: LOGIN_ITEM_EXE_PATH,\s*args: LOGIN_ITEM_ARGS,\s*name: AUTOSTART_REGISTRY_NAME,\s*enabled,\s*\}\)/,
  )

  // 回读必须传同一个 path 和 args。传默认值的话，portable 模式下每次运行的
  // process.execPath 都不同；少了 args，Electron 比较的命令行也永远对不上。
  assert.match(
    mainSource,
    /getLoginItemSettings\(\{\s*path: LOGIN_ITEM_EXE_PATH,\s*args: LOGIN_ITEM_ARGS\s*\}\)/,
    '回读要传与写入相同的 path 和 args',
  )
})

test('只有开机自启拉起、且静默启动开着时才藏窗口', () => {
  const exe = 'C:\\Apps\\Tessera\\Tessera.exe'
  assert.equal(shouldStartHidden([exe, LOGIN_LAUNCH_ARG], { silent: true }), true)
  assert.equal(shouldStartHidden([exe, LOGIN_LAUNCH_ARG], { silent: false }), false)
  // 用户自己双击、装完立即运行、更新后被安装器拉起：都不带参数，必须露面
  assert.equal(shouldStartHidden([exe], { silent: true }), false)
  assert.equal(shouldStartHidden([exe, '--updated'], { silent: true }), false)
  // argv[0] 本身不算参数
  assert.equal(shouldStartHidden([LOGIN_LAUNCH_ARG], { silent: true }), false)
})

test('偏好文件只接受形状正确的内容', () => {
  assert.deepEqual(parseStartupPreferences({ silent: false }), { silent: false })
  assert.equal(parseStartupPreferences({ silent: 'yes' }), null)
  assert.equal(parseStartupPreferences(null), null)
})

test('第一次默认登记；之后只修过期的旧登记，不重新打开用户关掉的自启', () => {
  const none = { exactMatch: false, staleCommand: false, approved: null }
  assert.deepEqual(planLoginItemOnLaunch(true, none), { kind: 'register', enabled: true })
  assert.deepEqual(planLoginItemOnLaunch(false, none), { kind: 'none' })

  // 旧版本登记时没带参数：补上，并保留任务管理器里的禁用状态
  const staleDisabled = { exactMatch: false, staleCommand: true, approved: false }
  assert.deepEqual(planLoginItemOnLaunch(false, staleDisabled), { kind: 'register', enabled: false })

  const exact = { exactMatch: true, staleCommand: false, approved: true }
  assert.deepEqual(planLoginItemOnLaunch(true, exact), { kind: 'none' })
  assert.deepEqual(planLoginItemOnLaunch(false, exact), { kind: 'none' })
})

test('勾选状态等于"下次登录真的会启动"', () => {
  assert.equal(effectiveOpenAtLogin({ exactMatch: true, staleCommand: false, approved: null }), true)
  assert.equal(effectiveOpenAtLogin({ exactMatch: true, staleCommand: false, approved: false }), false)
  assert.equal(effectiveOpenAtLogin({ exactMatch: false, staleCommand: true, approved: true }), false)
})

test('reg.exe 输出解析', () => {
  const run = [
    '',
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
    '    com.ideal1.filevault    REG_SZ    "C:\\Apps\\Tessera\\Tessera.exe" --autostart',
    '',
  ].join('\r\n')
  assert.equal(parseRegQueryString(run, 'com.ideal1.filevault'), '"C:\\Apps\\Tessera\\Tessera.exe" --autostart')
  assert.equal(parseRegQueryString('', 'com.ideal1.filevault'), null)

  const approved = '    com.ideal1.filevault    REG_BINARY    020000000000000000000000'
  const disabled = '    com.ideal1.filevault    REG_BINARY    03000000A1B2C3D4E5F60708'
  assert.equal(parseRegQueryApproved(approved, 'com.ideal1.filevault'), true)
  assert.equal(parseRegQueryApproved(disabled, 'com.ideal1.filevault'), false)
  assert.equal(parseRegQueryApproved('', 'com.ideal1.filevault'), null)
})
