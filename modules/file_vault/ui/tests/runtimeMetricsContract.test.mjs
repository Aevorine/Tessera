import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const read = (relative) => fs.readFileSync(path.join(here, '..', relative), 'utf8')

test('运行指标使用固定、无参数的受信 IPC 通道', () => {
  const main = read('electron/main.ts')
  const preload = read('electron/preload.ts')
  const declarations = read('src/shared/window.d.ts')

  assert.match(main, /ipcMain\.handle\('system:getRuntimeMetrics', \(event\) =>/)
  assert.match(preload, /getRuntimeMetrics: \(\): Promise<RuntimeMetricsSnapshot> =>\s*ipcRenderer\.invoke\('system:getRuntimeMetrics'\)/)
  assert.match(declarations, /getRuntimeMetrics\(\): Promise<RuntimeMetricsSnapshot>/)

  const bridgeLine = preload.split(/\r?\n/).find((line) => line.includes("invoke('system:getRuntimeMetrics'"))
  assert.ok(bridgeLine)
  assert.doesNotMatch(bridgeLine, /targetPath|command|url|options|params/i)
})

test('主题设置也只接受枚举偏好，不接受 CSS 或文件路径', () => {
  const preload = read('electron/preload.ts')
  assert.match(
    preload,
    /setThemePreference: \(pref: 'system' \| 'light' \| 'dark'\): Promise<void> =>\s*ipcRenderer\.invoke\('system:setThemePreference', pref\)/,
  )
})
