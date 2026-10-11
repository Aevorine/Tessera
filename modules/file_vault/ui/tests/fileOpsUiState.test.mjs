import assert from 'node:assert/strict'
import test from 'node:test'

import {
  fileHookSettingChecked,
  normalizePastePreflight,
} from '../src/lib/fileOpsUiState.ts'


test('paste preflight trusts the live backend result instead of a stale cached false state', () => {
  const result = normalizePastePreflight({
    ok: true,
    has_files: true,
    is_cut: false,
    count: 2,
    conflicts: [],
  })

  assert.deepEqual(result.clipboard, { hasFiles: true, isCut: false, count: 2 })
  assert.equal(result.empty, false)
})


test('file hook setting stays checked when autostart is enabled but the agent needs repair', () => {
  assert.equal(fileHookSettingChecked({ running: false, autostart: true }), true)
})
