import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { copyText, copyTextWithAutoClear, lastClipboardFailure, readClipboardText } from '@/lib/clipboard'

/**
 * 剪贴板行为测试：静态守卫只证明没人再写 navigator.clipboard，证明不了替代路径可用；
 * 每条 reject 路径都必须被接住，逃出去的 promise 会被 vitest 记为未处理拒绝。
 */

type ElectronClipboard = {
  clipboardWriteText: ReturnType<typeof vi.fn>
  clipboardReadText: ReturnType<typeof vi.fn>
}

function installElectronApi(overrides: Partial<ElectronClipboard> = {}): ElectronClipboard {
  const api: ElectronClipboard = {
    clipboardWriteText: vi.fn(async () => ({ ok: true as const })),
    clipboardReadText: vi.fn(async () => ({ ok: true as const, text: '' })),
    ...overrides,
  }
  ;(window as unknown as { electronAPI: unknown }).electronAPI = api
  return api
}

function removeElectronApi() {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
}

/** 装一个会像真浏览器那样拒绝的 navigator.clipboard。 */
function installWebClipboard(behaviour: 'ok' | 'denied' | 'unfocused' | 'absent', sink?: string[]) {
  if (behaviour === 'absent') {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
    return
  }
  const reject = (msg: string) => () => Promise.reject(new DOMException(msg, 'NotAllowedError'))
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText:
        behaviour === 'ok'
          ? vi.fn(async (t: string) => {
              sink?.push(t)
            })
          : vi.fn(
              reject(
                behaviour === 'denied'
                  ? "Failed to execute 'writeText' on 'Clipboard': Write permission denied"
                  : "Failed to execute 'writeText' on 'Clipboard': Document is not focused",
              ),
            ),
      readText:
        behaviour === 'ok'
          ? vi.fn(async () => 'from web clipboard')
          : vi.fn(reject('Read permission denied')),
    },
  })
}

/**
 * jsdom 没有 `document.execCommand`，`vi.spyOn` 会报不存在，只能自己挂一个。
 * 兜底 `legacyCopy()` 在无该 API 时抛 TypeError，被内部接住返回 false。
 */
function stubExecCommand(result: boolean) {
  const fn = vi.fn(() => result)
  ;(document as unknown as { execCommand: unknown }).execCommand = fn
  return fn
}

function removeExecCommand() {
  delete (document as unknown as { execCommand?: unknown }).execCommand
}

afterEach(() => {
  removeElectronApi()
  removeExecCommand()
  vi.useRealTimers()
})

describe('copyText', () => {
  it('优先走主进程，拿到的就是原文', async () => {
    const api = installElectronApi()
    installWebClipboard('denied') // 网页那条即使坏着也不该被用到

    await expect(copyText('hello 世界')).resolves.toBe(true)
    expect(api.clipboardWriteText).toHaveBeenCalledExactlyOnceWith('hello 世界')
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled()
  })

  it('没有 preload 时（浏览器里跑）退回网页剪贴板', async () => {
    removeElectronApi()
    const written: string[] = []
    installWebClipboard('ok', written)

    await expect(copyText('fallback')).resolves.toBe(true)
    expect(written).toEqual(['fallback'])
  })

  it('主进程返回失败时会继续往下兜底，而不是直接认输', async () => {
    installElectronApi({
      clipboardWriteText: vi.fn(async () => ({ ok: false as const, error: 'boom' })),
    })
    const written: string[] = []
    installWebClipboard('ok', written)

    await expect(copyText('second chance')).resolves.toBe(true)
    expect(written).toEqual(['second chance'])
  })

  it('主进程通道抛异常也不会漏出未处理的拒绝', async () => {
    installElectronApi({
      clipboardWriteText: vi.fn(async () => {
        throw new Error('Blocked IPC from untrusted renderer')
      }),
    })
    installWebClipboard('absent')

    // 关键在于它 resolve 成 false，而不是 reject。原来的代码就是在这里
    // reject 出去、没人接、变成故障日志里的「未处理的异步失败」。
    await expect(copyText('x')).resolves.toBe(false)
    expect(lastClipboardFailure()).toContain('untrusted renderer')
  })

  it('用户报的那两个 NotAllowedError 都不会再冒出来', async () => {
    for (const mode of ['denied', 'unfocused'] as const) {
      removeElectronApi()
      installWebClipboard(mode)
      // 没有 Electron、网页被拒、execCommand 也不可用 -> 老老实实返回 false。
      stubExecCommand(false)
      await expect(copyText('report text')).resolves.toBe(false)
      removeExecCommand()
    }
  })

  it('前两条都不行时用 execCommand 兜底', async () => {
    removeElectronApi()
    installWebClipboard('denied')
    const spy = stubExecCommand(true)

    await expect(copyText('legacy')).resolves.toBe(true)
    expect(spy).toHaveBeenCalledWith('copy')
    // 兜底用的 textarea 必须清理掉，否则每复制一次页面里就多一个残留节点。
    expect(document.querySelectorAll('textarea[aria-hidden="true"]')).toHaveLength(0)
    removeExecCommand()
  })

  it('清空剪贴板（写空串）不会被 execCommand 谎报成功', async () => {
    // execCommand 对空选区返回 false，但有些实现会返回 true。清空是安全动作，
    // 谎报成功意味着明文密码还在剪贴板里而我们以为已经擦掉了。
    removeElectronApi()
    installWebClipboard('denied')
    const spy = stubExecCommand(true)

    await expect(copyText('')).resolves.toBe(false)
    expect(spy).not.toHaveBeenCalled()
    removeExecCommand()
  })
})

describe('readClipboardText', () => {
  it('走主进程读回原文', async () => {
    installElectronApi({
      clipboardReadText: vi.fn(async () => ({ ok: true as const, text: 'pasted' })),
    })
    await expect(readClipboardText()).resolves.toBe('pasted')
  })

  it('读不到返回 null，不抛异常', async () => {
    installElectronApi({
      clipboardReadText: vi.fn(async () => {
        throw new Error('nope')
      }),
    })
    installWebClipboard('denied')
    await expect(readClipboardText()).resolves.toBeNull()
  })

  it('空剪贴板返回空串而不是 null', async () => {
    // 这两者调用方要区别对待：null 是"读不到"，空串是"确实是空的"。
    installElectronApi({ clipboardReadText: vi.fn(async () => ({ ok: true as const, text: '' })) })
    await expect(readClipboardText()).resolves.toBe('')
  })
})

describe('copyTextWithAutoClear', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('30 秒后真的把剪贴板清空了', async () => {
    const api = installElectronApi()
    installWebClipboard('absent')

    await expect(copyTextWithAutoClear('S3cret!', 30_000)).resolves.toBe(true)
    expect(api.clipboardWriteText).toHaveBeenCalledExactlyOnceWith('S3cret!')

    await vi.advanceTimersByTimeAsync(30_000)

    // 这就是原来一次都没成功过的那一步：窗口此时没有焦点，网页剪贴板必抛，
    // 而主进程这条不看焦点。
    expect(api.clipboardWriteText).toHaveBeenCalledTimes(2)
    expect(api.clipboardWriteText).toHaveBeenLastCalledWith('')
  })

  it('期间又复制了别的东西，就不再清空（否则会擦掉用户刚复制的内容）', async () => {
    const api = installElectronApi()
    installWebClipboard('absent')

    await copyTextWithAutoClear('first', 30_000)
    await vi.advanceTimersByTimeAsync(10_000)
    await copyTextWithAutoClear('second', 30_000)

    await vi.advanceTimersByTimeAsync(20_000) // 第一次的 30 秒到了
    const cleared = api.clipboardWriteText.mock.calls.filter((c) => c[0] === '')
    expect(cleared).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(10_000) // 第二次的 30 秒到了
    expect(api.clipboardWriteText).toHaveBeenLastCalledWith('')
  })

  it('第一步复制就失败时不返回成功，也不安排清空', async () => {
    removeElectronApi()
    installWebClipboard('denied')
    stubExecCommand(false)

    await expect(copyTextWithAutoClear('nope', 30_000)).resolves.toBe(false)
    await vi.advanceTimersByTimeAsync(60_000)
    removeExecCommand()
  })
})
