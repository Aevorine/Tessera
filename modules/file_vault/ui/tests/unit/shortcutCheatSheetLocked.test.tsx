import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

/**
 * 锁屏状态下的速查卡。冷启动时它挂在 App 最外层即调 file_manager_shortcuts_get，
 * 后端 `_require_imk()` 抛 auth.not_unlocked，pythonBridge reject，调用处只有 `void ...then()` 没有 `.catch`，
 * 冒成 unhandledrejection。老测试把桩写成 resolve `{ok:false}`，走了不出事的分支；
 * 桩必须复刻真实契约的失败形态，这里一律 reject。
 */

const RECORDED_CALLS: string[] = []

vi.mock('@/lib/vaultApi', () => ({
  vaultApi: {
    call: (method: string) => {
      RECORDED_CALLS.push(method)
      // 后端锁屏时的真实形态：抛，不是返回 ok:false。
      return Promise.reject(new Error('auth.not_unlocked'))
    },
  },
}))
vi.mock('@/lib/electronApi', () => ({
  electronApi: {
    getGlobalShortcuts: () =>
      Promise.resolve({
        shortcuts: {
          toggleWindow: { key: 't', ctrl: true, alt: true, shift: false },
          clipboardCapture: { key: 'v', ctrl: true, alt: false, shift: true },
          quickNote: { key: 'n', ctrl: true, alt: false, shift: true },
        },
        registered: { toggleWindow: true, clipboardCapture: true, quickNote: true },
      }),
  },
}))

import { ShortcutCheatSheet } from '@/components/ShortcutCheatSheet'

/** 让 Node 有机会判定"这个 rejection 没人接"——它是在微任务队列排空之后
 *  的下一个宏任务里才下结论的，同步断言必然抓不到。 */
function settle(ms = 60) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

let unhandled: unknown[] = []
function onUnhandled(reason: unknown) {
  unhandled.push(reason)
}

beforeEach(() => {
  RECORDED_CALLS.length = 0
  unhandled = []
  process.on('unhandledRejection', onUnhandled)
})

afterEach(() => {
  process.off('unhandledRejection', onUnhandled)
})

describe('速查卡在金库未解锁时', () => {
  it('没打开就不该去打后端——那次请求注定失败，还排在登录要等的 identity_exists 前面', async () => {
    render(<ShortcutCheatSheet />)
    await settle()
    // 后端 serve 循环是单线程串行的（backend_server.py::serve），冷启动时
    // 多发一次必失败的 RPC 就是让登录框晚出来一点。
    expect(RECORDED_CALLS).toEqual([])
  })

  it('打开时后端拒绝（auth.not_unlocked），不能变成未处理的异步失败', async () => {
    render(<ShortcutCheatSheet />)
    await userEvent.keyboard('?')
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    await settle()

    expect(RECORDED_CALLS).toContain('file_manager_shortcuts_get')
    // 这一条就是那个 bug 本身。没有 .catch 时它必然非空。
    expect(unhandled).toEqual([])
  })

  it('取不到键位时显示出厂值，而不是永远五行省略号', async () => {
    render(<ShortcutCheatSheet />)
    await userEvent.keyboard('?')
    const dialog = await screen.findByRole('dialog')
    await settle()

    // 一张五行都写着 `…` 的速查卡等于没有——用户按 ? 就是为了看键位。
    // 出厂值有极小概率跟用户改过的不一致，但"大概率对"完胜"肯定没用"。
    expect(dialog).toHaveTextContent('Ctrl + C')
    expect(dialog).toHaveTextContent('Ctrl + X')
    expect(dialog).toHaveTextContent('Ctrl + V')
    expect(dialog).toHaveTextContent('Delete')
    expect(dialog).toHaveTextContent('Shift + Delete')
  })

  it('主进程那两条正常拿得到，显示真实值', async () => {
    render(<ShortcutCheatSheet />)
    await userEvent.keyboard('?')
    const dialog = await screen.findByRole('dialog')
    await settle()
    expect(dialog).toHaveTextContent('Ctrl + Shift + V')
    expect(dialog).toHaveTextContent('Ctrl + Shift + N')
  })
})
