/**
 * 剥掉 Electron 套在 IPC 异常外的壳：`Error invoking remote method 'vault:call': Error: <真正内容>`。
 * 它会让 `translateError(code)` 查不到表而全落到「未知错误」，也会让跨设备面板的中文提示前挂一串英文；
 * 单元测试桩的是渲染端假 Promise，没有 IPC，测不出来。
 * 在跨 IPC 边界这一层统一剥一次，不在各 catch 里分别处理。
 */

/** `Error invoking remote method 'vault:call': ` 这一段。 */
const IPC_WRAPPER_RE = /^Error invoking remote method '[^']*':\s*/

/** 壳内常嵌一层类名（`Error: ` / `TypeError: `）；前缀须允许为空，最常见的就是光秃秃的 `Error: `。 */
const ERROR_CLASS_PREFIX_RE = /^\w*Error:\s*/

/** 剥壳；没有壳原样返回，确认有壳才继续剥类名，免得误削本就以 "TypeError: ..." 开头的正常消息。 */
export function unwrapIpcMessage(message: string): string {
  if (!IPC_WRAPPER_RE.test(message)) return message
  const inner = message.replace(IPC_WRAPPER_RE, '').replace(ERROR_CLASS_PREFIX_RE, '').trim()
  // 壳里面是空的（理论上不该发生）就把原文留着——剥出一个空字符串等于把
  // 错误彻底吞掉，那比显示一串难看的前缀糟得多。
  return inner || message
}

/** 就地替换异常的 message，不新建异常：新建会丢 stack 和 `instanceof` 关系。 */
export function unwrapIpcError<T>(error: T): T {
  if (error instanceof Error) {
    try {
      const unwrapped = unwrapIpcMessage(error.message)
      if (unwrapped !== error.message) error.message = unwrapped
    } catch {
      // 冻结过的异常改不动。改不动就算了——这是个锦上添花的清理，
      // 绝不能让它自己变成新的故障源。
    }
  }
  return error
}
