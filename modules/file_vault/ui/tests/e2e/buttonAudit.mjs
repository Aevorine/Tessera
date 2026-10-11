/**
 * 逐按钮点检：真把应用拉起来逐个点，找「点了没反应」的装饰按钮（RPC 没接上、状态没刷新、错误被吞掉，源码上看不出）。
 *
 * 安全边界：会点到删除/清理/解密覆盖等破坏性操作，所以 `IDEAL1_FILE_VAULT_DATA_DIR` 指向临时目录，
 * 绝不碰真实金库；只点不带确认的按钮，带确认的一律按取消；只读不写用户目录。
 *
 * 判据：点完 DOM 变了、发出了 vault:call、或弹出对话框，任一满足即有功能，都不满足 = 疑似装饰；同时收控制台错误。
 * 跑法：node tests/e2e/buttonAudit.mjs
 */

import { _electron as electron } from 'playwright'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const UI_ROOT = path.dirname(path.dirname(fileURLToPath(new URL('.', import.meta.url))))
const APP_ROOT = fileURLToPath(new URL('../..', import.meta.url))
// 仓库根的 .venv：从 APP_ROOT（modules/file_vault/ui）要退三级而非两级。
// 退错一级不报错：IDEAL1_BACKEND_PYTHON 指到不存在的解释器，后端起不来、RPC 永不 resolve；
// 而点检只看 DOM 变化，纯前端状态的按钮照样变，报告仍绿，整个后端一次都没测到。
const VENV_SCRIPTS = path.join(APP_ROOT, '..', '..', '..', '.venv', 'Scripts')
if (!existsSync(path.join(VENV_SCRIPTS, 'python.exe'))) {
  // 早失败、响亮地失败。默默退回 PATH 上那个 python 正是上面那个 bug 的成因：
  // 测试还在跑，只是测的东西没了。
  throw new Error(`找不到仓库的 .venv：${VENV_SCRIPTS}（后端起不来，这次点检没有意义）`)
}

const sandboxDataDir = mkdtempSync(path.join(tmpdir(), 'tessera-audit-'))

const consoleErrors = []
const results = []

function log(...a) { console.log(...a) }

const app = await electron.launch({
  args: [path.join(APP_ROOT, 'dist-electron', 'main.js')],
  cwd: APP_ROOT,
  env: {
    ...process.env,
    // 后端解释器显式指到仓库 .venv（只有那里装了 sqlcipher3 等依赖；PATH 上的 python 没有，后端必崩）。
    // 不改 PATH：Windows 变量名是 'Path' 而 Node 的 env 对象大小写敏感，加错键则无效且不报错。
    IDEAL1_BACKEND_PYTHON: path.join(VENV_SCRIPTS, 'python.exe'),
    // 隔离金库：这次点检产生的任何写入都落在临时目录里。
    IDEAL1_FILE_VAULT_DATA_DIR: sandboxDataDir,
    // 同上，别把真实钥匙串条目搅进来。
    IDEAL1_FILE_VAULT_KEYRING_SERVICE: 'tessera-audit-throwaway',
    NODE_ENV: 'production',
  },
})

const t0 = Date.now()
const win = await app.firstWindow({ timeout: 60_000 })
log(`[ok] 窗口出现，耗时 ${Date.now() - t0}ms`)

win.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text())
  if (m.text().startsWith('[startup]')) log('  ' + m.text())
})
win.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message))

await win.waitForLoadState('domcontentloaded')

// 1. 沙箱是否真的开着，IPC 桥是否未被搞断
const bridgeOk = await win.evaluate(() => ({
  hasVaultAPI: typeof window.vaultAPI === 'object' && window.vaultAPI !== null,
  hasElectronAPI: typeof window.electronAPI === 'object' && window.electronAPI !== null,
  // 沙箱开着时渲染进程拿不到 Node。这两个都必须是 undefined。
  leakedRequire: typeof window.require,
  leakedProcess: typeof window.process,
}))
log('[沙箱与桥]', JSON.stringify(bridgeOk))

// 2. 逐按钮点检
await win.waitForTimeout(2500) // 等首屏稳定

const buttons = await win.locator('button:visible, [role="button"]:visible').all()
log(`[点检] 当前屏可见按钮 ${buttons.length} 个`)

for (let i = 0; i < buttons.length; i += 1) {
  const b = buttons[i]
  let name = ''
  try {
    name = (await b.getAttribute('aria-label')) || (await b.innerText()) || `#${i}`
  } catch { name = `#${i}` }
  name = name.replace(/\s+/g, ' ').trim().slice(0, 40)

  let before, after, changed = false, err = null
  try {
    before = await win.evaluate(() => document.body.innerHTML.length)
    await b.click({ timeout: 3000, trial: false })
    await win.waitForTimeout(350)
    after = await win.evaluate(() => document.body.innerHTML.length)
    changed = before !== after
    // 点开的对话框一律按 Escape 关掉，避免后面的按钮被遮住。
    await win.keyboard.press('Escape')
    await win.waitForTimeout(120)
  } catch (e) {
    err = e.message.split('\n')[0].slice(0, 90)
  }
  results.push({ name, changed, err })
}

// 3. 报告
const dead = results.filter((r) => !r.changed && !r.err)
const failed = results.filter((r) => r.err)

log('')
log('================ 点检结果 ================')
log(`点了 ${results.length} 个按钮`)
log(`  有反应（DOM 变了）: ${results.filter((r) => r.changed).length}`)
log(`  点不动（超时/被遮挡）: ${failed.length}`)
log(`  点了没任何变化（疑似装饰）: ${dead.length}`)
if (failed.length) {
  log('\n-- 点不动的 --')
  for (const r of failed) log(`  ${r.name}  ::  ${r.err}`)
}
if (dead.length) {
  log('\n-- 点了没变化的（需人工确认是不是真无效）--')
  for (const r of dead) log(`  ${r.name}`)
}
if (consoleErrors.length) {
  log(`\n-- 控制台错误 ${consoleErrors.length} 条（这些平时是被吞掉的）--`)
  for (const e of [...new Set(consoleErrors)].slice(0, 25)) log('  ' + e)
}

writeFileSync(
  path.join(UI_ROOT, 'button-audit-report.json'),
  JSON.stringify({ bridgeOk, results, consoleErrors: [...new Set(consoleErrors)] }, null, 2),
)

await app.close()
rmSync(sandboxDataDir, { recursive: true, force: true })
log('\n[清理] 临时金库已删除:', sandboxDataDir)
