import { vaultApi, vaultMethodOf } from '@/lib/vaultApi'
import type { DiagnosticLevel } from '@/shared/ipcTypes'

/**
 * 渲染进程侧故障采集，补后端看不到的界面崩溃与未处理 Promise。硬规矩：
 * 1. 绝不带用户内容，只报错误名、消息和栈头几帧；
 * 2. 所有调用吞异常，采集不能把应用搞崩；
 * 3. 自行去重，坏掉的渲染循环会刷满 RPC 通道。
 */

const RECENT_WINDOW_MS = 5000
const recent = new Map<string, number>()

function seenRecently(key: string): boolean {
  const now = Date.now()
  // 顺手清掉过期的，免得这张表随着运行时间无限长大。
  for (const [k, at] of recent) {
    if (now - at > RECENT_WINDOW_MS) recent.delete(k)
  }
  const last = recent.get(key)
  recent.set(key, now)
  return last !== undefined && now - last < RECENT_WINDOW_MS
}

/** 从任意抛出物里取出可安全上报的部分。字符串化整个对象是不行的——
 *  被抛出的可能是一个含有响应体、表单值甚至凭据的对象。 */
function describe(error: unknown): { code: string; detail: string } {
  if (error instanceof Error) {
    const frames = (error.stack || '')
      .split('\n')
      .slice(1, 4)
      .map((line) => line.trim())
      .join(' | ')
    return { code: error.name || 'Error', detail: `${error.message} @ ${frames}` }
  }
  if (typeof error === 'string') return { code: 'string', detail: error }
  return { code: typeof error, detail: '' }
}

/** 记一条界面侧故障；后端未开日志时会直接丢弃（那边先查开关），这里不必再判，免一次 RPC 往返。 */
export function reportUiFailure(
  module: string,
  problem: string,
  error?: unknown,
  level: DiagnosticLevel = 'error',
): void {
  try {
    const { code, detail } = error === undefined ? { code: '', detail: '' } : describe(error)
    if (seenRecently(`${module}|${problem}|${code}`)) return
    void vaultApi.call('diagnostic_log_record', { module, problem, detail, code, level }).catch(() => {})
  } catch {
    /* 见文件顶部第 2 条 */
  }
}

let installed = false

/** 挂全局兜底。在 main.tsx 里第一次渲染之前调用一次即可。 */
export function installDiagnosticsCapture(): void {
  if (installed) return
  installed = true

  window.addEventListener('error', (event) => {
    reportUiFailure('ui', '界面未捕获异常', event.error ?? event.message)
  })

  window.addEventListener('unhandledrejection', (event) => {
    // 未处理的 Promise 拒绝是"点了没反应"的常见成因，必须带上 RPC 方法名（vaultApi.ts 在 reject 时挂上），
    // 否则日志只有"未处理的异步失败"，查无线索。去重键 `模块|现象|码` 对所有拒绝都相同，
    // 5 秒内不同故障会被误去重，所以把方法名并进现象。
    const method = vaultMethodOf(event.reason)
    reportUiFailure('ui', method ? `未处理的异步失败：${method}` : '未处理的异步失败', event.reason)
  })
}
