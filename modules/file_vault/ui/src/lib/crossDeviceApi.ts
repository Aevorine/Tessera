import { unwrapIpcError } from '@/lib/ipcError'

/**
 * 跨设备同步（Go 守护进程）的渲染层唯一入口，与 `vaultApi` 分开：另一个进程，且不需要金库解锁（见 preload.ts）。
 * 集中在此是为了在 IPC 边界剥掉 Electron 套的 `Error invoking remote method 'crossdevice:call': Error: ` 外壳，
 * 让 `toast.error(err.message)` 直接显示给人看的中文；该外壳只在真实 IPC 才有，jsdom 测不到。
 */
type CrossDeviceApi = Window['crossDeviceAPI']

const raw = window.crossDeviceAPI

/** 逐个转发而不是展开对象——理由见 vaultApi.ts 里同一处的说明。 */
export const crossDeviceApi: CrossDeviceApi = {
  call: <T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> =>
    raw.call<T>(method, params).catch((error: unknown) => {
      throw unwrapIpcError(error)
    }),
  available: () =>
    raw.available().catch((error: unknown) => {
      throw unwrapIpcError(error)
    }),
  firewallStatus: () =>
    raw.firewallStatus().catch((error: unknown) => {
      throw unwrapIpcError(error)
    }),
  firewallAllow: () =>
    raw.firewallAllow().catch((error: unknown) => {
      throw unwrapIpcError(error)
    }),
  openDownloadDir: () =>
    raw.openDownloadDir().catch((error: unknown) => {
      throw unwrapIpcError(error)
    }),
  onEvent: (callback) => raw.onEvent(callback),
}
