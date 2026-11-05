/**
 * 真机冒烟（Electron 45）：独立 userData + 临时金库 + 一次性 keyring，与本机正在运行的 Tessera 互不干扰。
 * 判据：运行时是 45.x；首屏渲染且 preload/IPC/后端打通；异步剪贴板 IPC 往返；打开可执行文件先确认（取消不运行）；
 * AI 桌面动作确认框能弹出、显示要点、点「拒绝」后关闭；控制台没有未捕获错误。
 * 跑法：npx vite build 后 node tests/e2e/electron45Smoke.mjs <截图目录>
 */
import { _electron as electron } from 'playwright'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const VENV_PY = path.join(APP_ROOT, '..', '..', '..', '.venv', 'Scripts', 'python.exe')
if (!existsSync(VENV_PY)) throw new Error(`找不到 .venv 解释器：${VENV_PY}`)
const shotDir = process.argv[2] || tmpdir()
const userData = mkdtempSync(path.join(tmpdir(), 'tessera-e45-ud-'))
const dataDir = mkdtempSync(path.join(tmpdir(), 'tessera-e45-data-'))
const results = {}
const consoleErrors = []

const app = await electron.launch({
  args: [`--user-data-dir=${userData}`, path.join(APP_ROOT, 'dist-electron', 'main.js')],
  cwd: APP_ROOT,
  env: {
    ...process.env,
    IDEAL1_BACKEND_PYTHON: VENV_PY,
    IDEAL1_FILE_VAULT_DATA_DIR: dataDir,
    IDEAL1_FILE_VAULT_KEYRING_SERVICE: 'tessera-e45-throwaway',
    NODE_ENV: 'production',
  },
})
try {
  const win = await app.firstWindow({ timeout: 60_000 })
  win.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()))
  win.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message))
  await win.waitForSelector('button, input', { timeout: 60_000 })

  const main = await app.evaluate(({ app: a }) => ({ electron: process.versions.electron, chrome: process.versions.chrome, userData: a.getPath('userData') }))
  results.runtime_is_45 = main.electron.startsWith('45.')
  results.isolated_user_data = main.userData === userData
  results.versions = main

  // 异步剪贴板 IPC（system:clipboardWriteText / ReadText）
  results.clipboard_ipc = await win.evaluate(async () => {
    const original = await window.electronAPI.clipboardReadText()
    const w = await window.electronAPI.clipboardWriteText('Tessera-E2E ipc 45')
    const r = await window.electronAPI.clipboardReadText()
    if (original.ok && original.text) await window.electronAPI.clipboardWriteText(original.text)
    return w.ok && r.ok && r.text === 'Tessera-E2E ipc 45'
  })

  // 可执行文件：主进程确认框用桩替身（原生对话框 Playwright 点不到），选「取消」
  await app.evaluate(({ dialog }) => {
    globalThis.__dlg = []
    dialog.showMessageBox = async (...args) => {
      const opts = args.length > 1 ? args[1] : args[0]
      globalThis.__dlg.push({ message: opts.message, buttons: opts.buttons, cancelId: opts.cancelId })
      return { response: 1, checkboxChecked: false }
    }
  })
  const openRes = await win.evaluate(() => window.electronAPI.openPath('C:\\Windows\\System32\\whoami.exe'))
  const dlg = await app.evaluate(() => globalThis.__dlg)
  results.exe_confirm_asked = dlg.length === 1 && String(dlg[0].message).includes('whoami.exe')
  results.exe_cancel_not_opened = openRes.ok === false && openRes.error === 'canceled'
  results.exe_dialog_buttons = dlg[0]?.buttons

  // 建临时金库并解锁，进入主界面
  const unlocked = await win.evaluate(async () => {
    const pw = 'E2e-Temp-Pass-45!x'
    const rk = await window.vaultAPI.call('setup_generate_recovery_key', {})
    await window.vaultAPI.call('setup_complete', { password: pw, recovery_key: rk.recovery_key })
    const u = await window.vaultAPI.call('unlock_password', { password: pw })
    return !!u && u.ok !== false
  })
  results.temp_vault_unlocked = unlocked
  await win.reload()
  await win.waitForSelector('button', { timeout: 60_000 })
  // 解锁态重载后可能停在登录页：用同一口令登录
  const pwInput = await win.$('input[type="password"]')
  if (pwInput) {
    await pwInput.fill('E2e-Temp-Pass-45!x')
    await win.keyboard.press('Enter')
  }
  await win.waitForTimeout(2500)
  await win.screenshot({ path: path.join(shotDir, 'e45-main.png') })

  // AI 桌面动作确认框：主进程模拟后端推来的事件
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send('vault:event', {
      event: 'ai_desktop_confirm', id: 'e2e-fake', tool: 'desktop_type_text', timeout_s: 120,
      summary: { process: 'notepad.exe', text: '你好，这是 AI 想输入的文字', element: 3 },
    })
  })
  const dialog = await win.waitForSelector('[role="dialog"]', { timeout: 10_000 }).catch(() => null)
  results.ai_confirm_dialog_shown = !!dialog
  if (dialog) {
    const txt = await dialog.innerText()
    results.ai_confirm_shows_details = txt.includes('notepad.exe') && txt.includes('AI 想输入的文字')
    await win.waitForTimeout(400) // 等进场动画结束
    await win.screenshot({ path: path.join(shotDir, 'e45-ai-confirm.png') })
    const focused = await win.evaluate(() => document.activeElement?.textContent ?? '')
    results.ai_confirm_default_focus = focused
    await dialog.$('button:has-text("拒绝"), button:has-text("Deny")').then((b) => b?.click())
    await win.waitForTimeout(500)
    results.ai_confirm_closed_after_deny = (await win.$('[role="dialog"]')) === null
  }
  results.console_errors = consoleErrors.filter((e) => !/Autofill|DevTools|favicon/i.test(e))
  results.all_pass =
    Object.entries(results).every(([k, v]) => typeof v !== 'boolean' || v) && results.console_errors.length === 0
} catch (e) {
  results.error = String(e?.stack || e)
} finally {
  await app.close().catch(() => {})
  for (const d of [userData, dataDir]) rmSync(d, { recursive: true, force: true, maxRetries: 5 })
  console.log(JSON.stringify(results, null, 1))
}
