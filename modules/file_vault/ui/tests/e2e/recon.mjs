/** 侦察：这一屏到底是什么，以及启动账单长什么样。只读，不点任何东西。 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const VENV_SCRIPTS = path.join(APP_ROOT, '..', '..', '.venv', 'Scripts')
const dataDir = mkdtempSync(path.join(tmpdir(), 'tessera-recon-'))

const app = await electron.launch({
  args: [path.join(APP_ROOT, 'dist-electron', 'main.js')],
  cwd: APP_ROOT,
  env: {
    ...process.env,
    // 后端解释器显式指到仓库 .venv（只有那里装了 sqlcipher3 等依赖；PATH 上的 python 没有，后端必崩）。
    // 不改 PATH：Windows 变量名是 'Path' 而 Node 的 env 对象大小写敏感，加错键则无效且不报错。
    IDEAL1_BACKEND_PYTHON: process.env.PROBE_PY || path.join(VENV_SCRIPTS, 'python.exe'),
    IDEAL1_FILE_VAULT_DATA_DIR: dataDir,
    IDEAL1_FILE_VAULT_KEYRING_SERVICE: 'tessera-recon-throwaway',
    NODE_ENV: 'production',
    IDEAL1_LOOP_HEARTBEAT: '1',
  },
})

// 主进程的 stdout 才有 [startup] 那一行（console.log 在 main.ts 里）。
app.process().stdout.on('data', (d) => {
  const s = d.toString()
  for (const line of s.split('\n')) if (line.includes('[startup]') || line.includes('[loop]')) console.log('MAIN ' + line.trim())
})
app.process().stderr.on('data', (d) => {
  const s = d.toString().trim()
  if (s) console.log('MAIN-ERR ' + s.split('\n').slice(0, 4).join(' | ').slice(0, 400))
})

const win = await app.firstWindow({ timeout: 60_000 })
win.on('console', (m) => {
  const t = m.text()
  if (t.includes('[startup]') || t.includes('[security]')) console.log('RENDERER ' + t)
})
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(20000)   // 等够 3 秒的启动账单

console.log('--- 标题 ---', await win.title())
const text = await win.evaluate(() => document.body.innerText)
console.log('--- 屏幕上的文字 ---')
console.log(text.split('\n').filter(Boolean).slice(0, 40).join('\n'))
console.log('--- 可见按钮 ---')
console.log(await win.evaluate(() =>
  Array.from(document.querySelectorAll('button')).map((b) => (b.getAttribute('aria-label') || b.innerText || '').replace(/\s+/g, ' ').trim()).filter(Boolean),
))
await win.screenshot({ path: path.join(APP_ROOT, 'recon.png') })
console.log('截图 ->', path.join(APP_ROOT, 'recon.png'))

await app.close()
rmSync(dataDir, { recursive: true, force: true })
