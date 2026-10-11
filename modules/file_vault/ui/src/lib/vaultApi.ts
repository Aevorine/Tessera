import { unwrapIpcError } from '@/lib/ipcError'
import type { VaultMethodName, VaultMethods } from '@/shared/ipcTypes'

/**
 * 渲染层访问 Python 后端的唯一入口；组件从这里 import `vaultApi`，不直接用 `window.vaultAPI`。
 *
 * 给每个 rejection 打上方法名，否则 unhandledrejection 日志只剩错误码、无从知道是哪个调用。
 * 不换异常对象、不改 message（translateError / extractBackendReason 认的是 message 里的错误码），
 * 只挂不可枚举属性（不进 JSON.stringify，仅 diagnostics.ts 读取）；已有方法名不覆盖，保留最内层。
 * 这只保证兜底日志可读，不能替代调用处的 `.catch`。
 */

/** 挂在 rejection 上的方法名字段。diagnostics.ts 读它。 */
export const VAULT_METHOD_PROP = 'vaultMethod'

/** 从任意抛出物里取出它是哪个 RPC 失败的；取不到返回 null。 */
export function vaultMethodOf(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null
  const value = (error as Record<string, unknown>)[VAULT_METHOD_PROP]
  return typeof value === 'string' ? value : null
}

const raw = window.vaultAPI

function tagRejection(method: string, error: unknown): never {
  // 先剥掉 Electron IPC 外壳，还原后端给的裸错误码；translateError 与各处 `err.message === '某个码'` 都依赖它，见 ipcError.ts。
  unwrapIpcError(error)
  // 只给对象挂属性。被 reject 的可能是字符串/数字，那种情况下没地方挂，
  // 也不值得为此包一层新异常（包了反而丢掉原始类型）。
  if (typeof error === 'object' && error !== null && vaultMethodOf(error) === null) {
    try {
      Object.defineProperty(error, VAULT_METHOD_PROP, {
        value: method,
        enumerable: false,
        writable: false,
        configurable: true,
      })
    } catch {
      // 冻结过的异常对象挂不上。挂不上就算了——诊断设施绝不能自己抛。
    }
  }
  throw error
}

/**
 * 逐个方法显式转发，不用 `{ ...window.vaultAPI }`：contextBridge 交出的是受限代理，展开可能拷不全，
 * 表现为真机全哑而 jsdom 正常；显式写配合 `: VaultApi` 标注，preload 新增方法漏转发时 tsc 会报错。
 */
type VaultApi = Window['vaultAPI']

export const vaultApi: VaultApi = {
  call<M extends VaultMethodName>(
    method: M,
    params: VaultMethods[M]['params'],
    progressToken?: string,
  ): Promise<VaultMethods[M]['result']> {
    return raw.call(method, params, progressToken).catch((error: unknown) => tagRejection(method, error))
  },
  onProgress: (callback) => raw.onProgress(callback),
  onEvent: (callback) => raw.onEvent(callback),
  onVaultLocked: (callback) => raw.onVaultLocked(callback),
  onBackendRestarted: (callback) => raw.onBackendRestarted(callback),
  onBackendFatal: (callback) => raw.onBackendFatal(callback),
}
