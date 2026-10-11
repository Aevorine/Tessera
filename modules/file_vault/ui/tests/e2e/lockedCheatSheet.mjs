/**
 * 真机验证：金库未解锁时按 `?` 叫出速查卡。
 *
 * 必须真拉起应用：该 bug 只存在于真实 IPC。jsdom 里 vaultApi.call 是可随意 resolve 的假 Promise；
 * 真机要穿过 contextBridge → ipcRenderer.invoke → 主进程 → Python，锁屏时后端 `_require_imk()` 必抛
 * auth.not_unlocked，且 Electron 会把消息改写成 `Error invoking remote method 'vault:call': ...`，jsdom 没有这层壳。
 *
 * 判据（全部要过）：1. 锁屏时按 ? 能弹出速查卡；2. 五条文件操作键位显示真实键位而非 `…`；
 * 3. 控制台没有 "Uncaught (in promise)"。
 * 跑法：node tests/e2e/lockedCheatSheet.mjs；前置先 `npx vite build`（读 dist-electron/main.js）；
 * 主进程有单实例锁，本机 Tessera 还开着会卡在 firstWindow 超时，先退出。
 */

import { _electron as electron } from 'playwright'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_ROOT = fileURLToPath(new URL('../..', import.meta.url))
// 退三级到仓库根。退两级只到 `modules`，那下面没有 .venv——见 buttonAudit.mjs
// 里对这个差一级错误的说明，它让那份点检长期在"后端根本没起来"的情况下报绿。
const VENV_SCRIPTS = path.join(APP_ROOT, '..', '..', '..', '.venv', 'Scripts')
if (!existsSync(path.join(VENV_SCRIPTS, 'python.exe'))) {
  throw new Error(`找不到仓库的 .venv：${VENV_SCRIPTS}（后端起不来，这次验证没有意义）`)
}
const sandboxDataDir = mkdtempSync(path.join(tmpdir(), 'tessera-locked-'))

const failures = []
const consoleErrors = []

const app = await electron.launch({
  args: [path.join(APP_ROOT, 'dist-electron', 'main.js')],
  cwd: APP_ROOT,
  env: {
    ...process.env,
    // 见 buttonAudit.mjs 里同一处的说明：PATH 在 Windows 上叫 'Path'，
    // 改错大小写是"改了但完全没生效且不报错"。所以显式指解释器。
    IDEAL1_BACKEND_PYTHON: path.join(VENV_SCRIPTS, 'python.exe'),
    IDEAL1_FILE_VAULT_DATA_DIR: sandboxDataDir,
    IDEAL1_FILE_VAULT_KEYRING_SERVICE: 'tessera-locked-throwaway',
    NODE_ENV: 'production',
  },
})

const win = await app.firstWindow({ timeout: 60_000 })
win.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text())
})
win.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message))
await win.waitForLoadState('domcontentloaded')

// 要等后端真应答过一次，不能睡固定秒数：沙箱是全新数据目录，后端要建目录、导 sqlcipher、初始化加密上下文，
// 实测数秒，且 serve 循环单线程串行，排队请求都动不了。固定睡 3 秒测出的是「后端没起来」而非被测行为。
await win.waitForSelector('button, input', { timeout: 60_000 })
console.log('[ok] 首屏渲染完成')

// 焦点得在 body 上，不能在输入框里——速查卡故意不抢输入（在笔记里写问号
// 不该弹窗），落在输入框里按 ? 是不响应的，那会让这次验证白跑。
await win.evaluate(() => document.body.focus())
await win.keyboard.press('Shift+Slash')

// --- 1. 弹出来了吗 ---
let dialog = null
try {
  dialog = win.locator('[role="dialog"]')
  await dialog.waitFor({ state: 'visible', timeout: 15_000 })
  console.log('[ok] 锁屏状态下按 ? 弹出了速查卡')
} catch {
  failures.push('按 ? 没有弹出速查卡')
}

// --- 2. 键位是真值还是省略号 ---
if (dialog) {
  // 轮询而不是睡死：等的是"那次注定失败的 RPC 有了结果"，
  // 而它要排在后端启动和 identity_exists 后面。
  let text = ''
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    text = (await dialog.innerText()).replace(/\s+/g, ' ')
    if (text.includes('Ctrl + C')) break
    await win.waitForTimeout(500)
  }
  for (const expected of ['Ctrl + C', 'Ctrl + X', 'Ctrl + V', 'Shift + Delete']) {
    if (text.includes(expected)) console.log(`[ok] 显示了真实键位 ${expected}`)
    else failures.push(`速查卡里没有 ${expected}——多半又退回成永远的 …`)
  }
  const ellipsisCount = (text.match(/…/g) || []).length
  if (ellipsisCount > 0) failures.push(`还有 ${ellipsisCount} 处显示 …（键位没兜底）`)
  else console.log('[ok] 没有任何一格停在 …')
}

// --- 3. 有没有留下未处理的拒绝 ---
const unhandled = consoleErrors.filter(
  (e) => /Uncaught \(in promise\)/i.test(e) || /auth\.not_unlocked/.test(e),
)
if (unhandled.length) {
  failures.push(`控制台留下了 ${unhandled.length} 条未处理的拒绝`)
  for (const e of [...new Set(unhandled)].slice(0, 5)) console.log('  !! ' + e)
} else {
  console.log('[ok] 控制台没有未处理的 Promise 拒绝')
}

if (consoleErrors.length) {
  console.log(`\n-- 控制台错误共 ${consoleErrors.length} 条 --`)
  for (const e of [...new Set(consoleErrors)].slice(0, 15)) console.log('  ' + e)
}

await app.close()
rmSync(sandboxDataDir, { recursive: true, force: true })

console.log('')
if (failures.length) {
  console.log('================ 失败 ================')
  for (const f of failures) console.log('  ✗ ' + f)
  process.exit(1)
}
console.log('================ 全部通过 ================')
