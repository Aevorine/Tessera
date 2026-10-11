/**
 * 从后端 Python traceback 里挑出给人看的那一行（最后一行 `异常类型: 说明`）；调用栈留在日志里。
 * 认不出时（非 Python 异常、被截断、原生崩溃）退回最后一条非空且不全是符号的行；
 * 绝不返回空字符串，否则又把原因吞了。
 */

/** 结论行如 `ModuleNotFoundError: No module named 'x'`；类型名须大写开头、以 Error/Exception/Warning 等结尾，
 *  否则 `File "...": line 22` 会被误判。 */
const PY_EXCEPTION_RE = /^([A-Z][A-Za-z0-9_.]*(?:Error|Exception|Interrupt|Exit|Warning))\b\s*:?(.*)$/

/** 只由符号组成的行（`^^^^^`、`~~~~`、`-----`）。Python 3.11+ 用它们
 *  在源码行下面标出错位置，对用户毫无意义。 */
const SYMBOLS_ONLY_RE = /^[\s^~\-=*_]+$/

export function extractBackendReason(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !SYMBOLS_ONLY_RE.test(l))

  if (lines.length === 0) return '后端没有留下任何错误输出'

  // 从后往前找结论行：一段 stderr 里可能有多个 traceback（崩溃-重启-再崩溃），
  // 最后那个才是这一次的。
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (PY_EXCEPTION_RE.test(lines[i])) return lines[i]
  }

  return lines[lines.length - 1]
}
