import { describe, expect, it } from 'vitest'

import { extractBackendReason } from '@/lib/backendError'

/** extractBackendReason 决定用户看到哪一行：挑错行会显示 `^^^^^`，返回空等于又吞了错误，二者都不报错。 */
describe('extractBackendReason', () => {
  const REAL_TRACEBACK = [
    'Traceback (most recent call last):',
    '  File "D:\\Tessera\\modules\\file_vault\\backend_server.py", line 44, in <module>',
    '    from modules.file_vault import activity_log, ai_client',
    '    ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^',
    '  File "D:\\Tessera\\modules\\file_vault\\activity_log.py", line 22, in <module>',
    '    from sqlcipher3 import dbapi2 as sqlcipher',
    "ModuleNotFoundError: No module named 'sqlcipher3'",
  ].join('\n')

  it('从真实 traceback 里挑出结论那一行', () => {
    // 这段是实测抓到的原文（tests/e2e/recon.mjs 跑出来的）。
    expect(extractBackendReason(REAL_TRACEBACK)).toBe(
      "ModuleNotFoundError: No module named 'sqlcipher3'",
    )
  })

  it('把 Python 3.11 那种 ^^^^ 标记行整个滤掉', () => {
    expect(extractBackendReason(REAL_TRACEBACK)).not.toMatch(/\^/)
  })

  it('一段里有多个 traceback 时，取最后那个（那才是这一次崩的原因）', () => {
    const twice = `PermissionError: [Errno 13] denied\n${REAL_TRACEBACK}`
    expect(extractBackendReason(twice)).toBe("ModuleNotFoundError: No module named 'sqlcipher3'")
  })

  it('不是 Python 异常时退回最后一条有内容的行，而不是返回空', () => {
    expect(extractBackendReason('some native crash\nsegmentation fault\n\n   \n')).toBe(
      'segmentation fault',
    )
  })

  it('完全没有输出时也给一句话，绝不返回空字符串', () => {
    // 空详情 = 又把原因吞了一次，而这个函数存在的意义就是不再吞。
    expect(extractBackendReason('')).not.toBe('')
    expect(extractBackendReason('\n\n  ^^^^  \n')).not.toBe('')
  })

  it('不会把 File "..." 那种行误判成异常行', () => {
    const onlyFrames = [
      'Traceback (most recent call last):',
      '  File "x.py", line 1, in <module>',
    ].join('\n')
    expect(extractBackendReason(onlyFrames)).toBe('File "x.py", line 1, in <module>')
  })
})
