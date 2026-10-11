import { describe, expect, it } from 'vitest'

import { unwrapIpcError, unwrapIpcMessage } from '@/lib/ipcError'

/**
 * Electron 套在 IPC 异常外的壳。样本抄自真实 diagnostic.log.jsonl；
 * 渲染层测试都桩在 IPC 之上，桩返回普通 rejected Promise 没有壳，测到的字符串与线上不同。
 */

const REAL_SAMPLE = "Error invoking remote method 'vault:call': Error: auth.not_unlocked"

describe('unwrapIpcMessage', () => {
  it('剥出用户日志里那条的真实错误码', () => {
    expect(unwrapIpcMessage(REAL_SAMPLE)).toBe('auth.not_unlocked')
  })

  it('跨设备那条通道同样剥干净——里面是给人看的中文', () => {
    // 壳不剥的话 toast 会在中文提示前挂一串英文报错，像应用崩了。
    expect(unwrapIpcMessage("Error invoking remote method 'crossdevice:call': Error: 配对超时")).toBe('配对超时')
  })

  it('嵌在里面的异常类名不限于 Error', () => {
    expect(unwrapIpcMessage("Error invoking remote method 'x': TypeError: boom")).toBe('boom')
  })

  it('本来就没有壳的消息一个字都不动', () => {
    expect(unwrapIpcMessage('auth.wrong_password')).toBe('auth.wrong_password')
    expect(unwrapIpcMessage('跨设备服务未运行')).toBe('跨设备服务未运行')
  })

  it('不许误伤本来就以类名开头的正常消息', () => {
    // 这条是防回归：只有确认存在 IPC 外壳时才继续剥类名前缀。
    // 无条件剥的话，这句话会被削成 "cannot read x"，丢掉"是个类型错误"这个信息。
    expect(unwrapIpcMessage('TypeError: cannot read x')).toBe('TypeError: cannot read x')
  })

  it('壳里是空的就把原文留着，绝不剥出一个空字符串', () => {
    // 剥出空字符串等于把错误彻底吞掉——比显示一串难看的前缀糟得多。
    expect(unwrapIpcMessage("Error invoking remote method 'vault:call': ")).toBe(
      "Error invoking remote method 'vault:call': ",
    )
  })
})

describe('unwrapIpcError', () => {
  it('就地改 message，保住同一个对象和它的 stack', () => {
    const error = new Error(REAL_SAMPLE)
    const stack = error.stack
    const returned = unwrapIpcError(error)

    // 上层有 `err instanceof Error` 这类判断，新建一个异常会丢掉 stack。
    expect(returned).toBe(error)
    expect(error.message).toBe('auth.not_unlocked')
    expect(error.stack).toBe(stack)
  })

  it('不是 Error 的抛出物原样返回', () => {
    expect(unwrapIpcError('plain string')).toBe('plain string')
    expect(unwrapIpcError(null)).toBe(null)
    const obj = { message: REAL_SAMPLE }
    expect(unwrapIpcError(obj)).toBe(obj)
    expect(obj.message).toBe(REAL_SAMPLE)
  })

  it('message 不可写时不抛——诊断设施绝不能自己变成故障源', () => {
    const error = new Error(REAL_SAMPLE)
    Object.defineProperty(error, 'message', { value: REAL_SAMPLE, writable: false, configurable: false })
    expect(() => unwrapIpcError(error)).not.toThrow()
  })
})
