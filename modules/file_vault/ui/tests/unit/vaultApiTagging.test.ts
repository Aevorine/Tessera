import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `vaultApi` 给失败 RPC 打方法名：1. 必须打上，否则兜底日志只剩“未处理的异步失败 (Error)”；
 * 2. 除此之外不能动异常对象和 message，translateError/extractBackendReason 等都认 message 里的错误码，
 *    动了会让提示变成原文，类型检查发现不了。
 */

const REAL_ERROR = () => new Error('auth.not_unlocked')

function stubBridge(impl: () => Promise<unknown>) {
  const host = window as unknown as { vaultAPI: unknown }
  host.vaultAPI = {
    call: impl,
    onProgress: () => () => {},
    onEvent: () => () => {},
    onBackendRestarted: () => () => {},
    onBackendFatal: () => () => {},
  }
}

beforeEach(() => {
  vi.resetModules()
})

afterEach(() => {
  delete (window as unknown as { vaultAPI?: unknown }).vaultAPI
})

describe('vaultApi 的失败标注', () => {
  it('把方法名挂到 rejection 上', async () => {
    stubBridge(() => Promise.reject(REAL_ERROR()))
    const { vaultApi, vaultMethodOf } = await import('@/lib/vaultApi')

    const error = await vaultApi
      .call('file_manager_shortcuts_get', {})
      .then(() => null)
      .catch((e: unknown) => e)

    expect(vaultMethodOf(error)).toBe('file_manager_shortcuts_get')
  })

  it('不换异常对象，也不动 message', async () => {
    const original = REAL_ERROR()
    stubBridge(() => Promise.reject(original))
    const { vaultApi } = await import('@/lib/vaultApi')

    const error = await vaultApi
      .call('file_manager_shortcuts_get', {})
      .then(() => null)
      .catch((e: unknown) => e)

    // 同一个对象，同一条 message。下游靠这两样活着。
    expect(error).toBe(original)
    expect((error as Error).message).toBe('auth.not_unlocked')
    expect(error).toBeInstanceOf(Error)
  })

  it('挂的属性不可枚举——不能泄进 JSON.stringify 或别处的日志', async () => {
    stubBridge(() => Promise.reject(REAL_ERROR()))
    const { vaultApi } = await import('@/lib/vaultApi')

    const error = await vaultApi
      .call('file_manager_shortcuts_get', {})
      .then(() => null)
      .catch((e: unknown) => e)

    expect(Object.keys(error as object)).not.toContain('vaultMethod')
    expect(JSON.stringify(error)).not.toContain('file_manager_shortcuts_get')
  })

  it('成功的调用原样返回，包装层不碰返回值', async () => {
    const payload = { ok: true as const, shortcuts: {} as never }
    stubBridge(() => Promise.resolve(payload))
    const { vaultApi } = await import('@/lib/vaultApi')

    await expect(vaultApi.call('file_manager_shortcuts_get', {})).resolves.toBe(payload)
  })

  it('被 reject 的不是对象（字符串）时不炸', async () => {
    stubBridge(() => Promise.reject('plain string'))
    const { vaultApi, vaultMethodOf } = await import('@/lib/vaultApi')

    const error = await vaultApi
      .call('file_manager_shortcuts_get', {})
      .then(() => null)
      .catch((e: unknown) => e)

    expect(error).toBe('plain string')
    expect(vaultMethodOf(error)).toBeNull()
  })

  it('已经带了方法名就不覆盖——最内层那个才是真凶', async () => {
    const error = REAL_ERROR()
    Object.defineProperty(error, 'vaultMethod', { value: 'inner_method', configurable: true })
    stubBridge(() => Promise.reject(error))
    const { vaultApi, vaultMethodOf } = await import('@/lib/vaultApi')

    const caught = await vaultApi
      .call('file_manager_shortcuts_get', {})
      .then(() => null)
      .catch((e: unknown) => e)

    expect(vaultMethodOf(caught)).toBe('inner_method')
  })
})

describe('兜底日志', () => {
  it('未处理的拒绝要写清是哪个接口', async () => {
    const recorded: Record<string, unknown>[] = []
    vi.doMock('@/lib/vaultApi', () => ({
      vaultApi: {
        call: (_method: string, params: Record<string, unknown>) => {
          recorded.push(params)
          return Promise.resolve({})
        },
      },
      vaultMethodOf: (error: unknown) =>
        typeof error === 'object' && error !== null
          ? ((error as Record<string, unknown>).vaultMethod as string) ?? null
          : null,
    }))

    const { installDiagnosticsCapture } = await import('@/lib/diagnostics')
    installDiagnosticsCapture()

    const failure = REAL_ERROR()
    Object.defineProperty(failure, 'vaultMethod', { value: 'file_manager_shortcuts_get', configurable: true })
    const event = new Event('unhandledrejection') as Event & { reason: unknown }
    event.reason = failure
    window.dispatchEvent(event)

    expect(recorded).toHaveLength(1)
    // 「未处理的异步失败 (Error)」这种匿名日志等于没报——必须点名。
    expect(recorded[0].problem).toBe('未处理的异步失败：file_manager_shortcuts_get')
    expect(recorded[0].module).toBe('ui')
  })

  it('同一个 5 秒窗口内两个不同接口的失败都要留下记录', async () => {
    const recorded: Record<string, unknown>[] = []
    vi.doMock('@/lib/vaultApi', () => ({
      vaultApi: {
        call: (_method: string, params: Record<string, unknown>) => {
          recorded.push(params)
          return Promise.resolve({})
        },
      },
      vaultMethodOf: (error: unknown) =>
        typeof error === 'object' && error !== null
          ? ((error as Record<string, unknown>).vaultMethod as string) ?? null
          : null,
    }))

    const { installDiagnosticsCapture } = await import('@/lib/diagnostics')
    installDiagnosticsCapture()

    for (const method of ['note_get', 'password_list']) {
      const failure = new Error('backend.no_response')
      Object.defineProperty(failure, 'vaultMethod', { value: method, configurable: true })
      const event = new Event('unhandledrejection') as Event & { reason: unknown }
      event.reason = failure
      window.dispatchEvent(event)
    }

    // 去重键原先是 `模块|现象|码`，而未处理拒绝这三样恒定相同 —— 于是第二条
    // 会被当成重复丢掉，另一个功能坏了却查无实据。方法名并进现象之后才分得开。
    expect(recorded.map((r) => r.problem)).toEqual([
      '未处理的异步失败：note_get',
      '未处理的异步失败：password_list',
    ])
  })
})
