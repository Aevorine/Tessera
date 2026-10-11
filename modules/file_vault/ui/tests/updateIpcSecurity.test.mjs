import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const mainSource = readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8')

function handlerSource(channel) {
  const marker = `ipcMain.handle('${channel}'`
  const start = mainSource.indexOf(marker)
  assert.notEqual(start, -1, `${channel} handler must exist`)
  const nextHandler = mainSource.indexOf('ipcMain.handle(', start + marker.length)
  return mainSource.slice(start, nextHandler === -1 ? undefined : nextHandler)
}

test('every update IPC rejects calls from an untrusted renderer', () => {
  for (const channel of [
    'update:getState',
    'update:setAutoCheck',
    'update:check',
    'update:install',
  ]) {
    assert.match(
      handlerSource(channel),
      /assertTrustedRenderer\(event\)/,
      `${channel} must call assertTrustedRenderer(event) before doing update work`,
    )
  }
})
