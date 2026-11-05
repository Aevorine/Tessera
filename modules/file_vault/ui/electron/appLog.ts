import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 统一结构化日志：userData/logs/tessera-YYYY-MM-DD.jsonl，一行一个事件。
 * 供人排查，也供 Claude Code 经 `agent/cli.py logs` / MCP `tessera_logs` 按时间、组件、级别检索后自动修复。
 * 写入走内存缓冲 + 250 ms 批量追加，主线程不做同步 IO；退出时 flushSync。
 * 只记事件与错误，不写剪贴板正文、文件名、密码、密钥；所有字符串过 redact()（路径只留扩展名，
 * 用户名 / 主机名换成占位符），只存本机，14 天自动清理。
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export type LogComponent = 'main' | 'backend' | 'crossdevice' | 'filehook' | 'updater' | 'renderer'

export interface LogEntry {
  ts: string
  t: number
  level: LogLevel
  component: LogComponent
  event: string
  msg?: string
  data?: Record<string, unknown>
  v: string
}

const FLUSH_MS = 250
const MAX_FILE_BYTES = 8 * 1024 * 1024
const KEEP_DAYS = 14
const MAX_FIELD_CHARS = 4000

let dir = ''
let version = '0.0.0'
let buffer: string[] = []
let timer: ReturnType<typeof setTimeout> | null = null

export function initAppLog(logDir: string, appVersion: string): void {
  dir = logDir
  version = appVersion
  try {
    fs.mkdirSync(dir, { recursive: true })
    pruneOld()
  } catch {
    // 日志不可用不影响应用
  }
}

export function logDir(): string {
  return dir
}

function day(t: number): string {
  const d = new Date(t)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function clip(value: unknown): unknown {
  if (typeof value === 'string' && value.length > MAX_FIELD_CHARS) return value.slice(-MAX_FIELD_CHARS)
  return value
}

/** data 里的字符串逐层脱敏（数组、嵌套对象也走一遍），深度封顶防环。 */
function scrub(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return clip(redact(value))
  if (depth >= 4 || value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => scrub(v, depth + 1))
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, scrub(v, depth + 1)]))
}

// 每天的写入预算：崩溃循环一类的刷屏不能把磁盘写满。超过软上限只留 warn/error，超过硬上限当天不再写。
const DAY_SOFT_BYTES = 64 * 1024 * 1024
const DAY_HARD_BYTES = 128 * 1024 * 1024
let budgetDay = ''
let budgetBytes = -1

function dayBytesSoFar(today: string): number {
  if (budgetDay === today && budgetBytes >= 0) return budgetBytes
  budgetDay = today
  budgetBytes = 0
  try {
    for (const name of fs.readdirSync(dir)) {
      if (name.startsWith(`tessera-${today}`)) budgetBytes += fs.statSync(path.join(dir, name)).size
    }
  } catch {
    // 目录读不了就从 0 算
  }
  return budgetBytes
}

export function logEvent(
  component: LogComponent,
  level: LogLevel,
  event: string,
  msg?: string,
  data?: Record<string, unknown>,
): void {
  if (!dir) return
  const t = Date.now()
  const used = dayBytesSoFar(day(t))
  if (used > DAY_HARD_BYTES || (used > DAY_SOFT_BYTES && (level === 'debug' || level === 'info'))) return
  const entry: LogEntry = { ts: new Date(t).toISOString(), t, level, component, event, v: version }
  if (msg) entry.msg = clip(redact(msg)) as string
  if (data) entry.data = scrub(data) as Record<string, unknown>
  let line: string
  try {
    line = JSON.stringify(entry)
  } catch {
    return
  }
  buffer.push(line)
  budgetBytes += Buffer.byteLength(line) + 1
  if (!timer) timer = setTimeout(flush, FLUSH_MS)
}

function targetFile(): string | null {
  const base = path.join(dir, `tessera-${day(Date.now())}.jsonl`)
  try {
    if (fs.statSync(base).size > MAX_FILE_BYTES) {
      for (let i = 1; i < 100; i++) {
        const alt = base.replace(/\.jsonl$/, `.${i}.jsonl`)
        if (!fs.existsSync(alt) || fs.statSync(alt).size <= MAX_FILE_BYTES) return alt
      }
      return null // 当天分片用尽：丢弃，不回头无限追加
    }
  } catch {
    // 文件还不存在
  }
  return base
}

function flush(): void {
  timer = null
  if (buffer.length === 0 || !dir) return
  const lines = buffer.join('\n') + '\n'
  buffer = []
  const file = targetFile()
  if (file) fs.appendFile(file, lines, 'utf-8', () => undefined)
}

export function flushAppLogSync(): void {
  if (timer) clearTimeout(timer)
  timer = null
  if (buffer.length === 0 || !dir) return
  try {
    const file = targetFile()
    if (file) fs.appendFileSync(file, buffer.join('\n') + '\n', 'utf-8')
  } catch {
    // 退出途中写失败就算了
  }
  buffer = []
}

/** 无法解析的子进程输出行：管道里走的是 RPC 结果（可能含解密后的密码、笔记）和剪贴板，只记长度与指纹，绝不记内容。 */
export function fingerprintLine(line: string): Record<string, unknown> {
  return { length: line.length, sha256_8: createHash('sha256').update(line).digest('hex').slice(0, 8) }
}

function pruneOld(): void {
  const cutoff = Date.now() - KEEP_DAYS * 86_400_000
  for (const name of fs.readdirSync(dir)) {
    if (!/^tessera-\d{4}-\d{2}-\d{2}(\.\d+)?\.jsonl$/.test(name)) continue
    const full = path.join(dir, name)
    try {
      if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full)
    } catch {
      // 被占用就下次再删
    }
  }
}

/** 解析子进程 stderr 一行的级别（Python logging 的 [INFO]/[WARNING]/[ERROR]，Traceback 记 error）。 */
export function stderrLevel(line: string): LogLevel {
  if (/\[(ERROR|CRITICAL)\]|Traceback|Fatal Python error|panic:|fatal error:/.test(line)) return 'error'
  if (/\[WARNING\]|WARN/.test(line)) return 'warn'
  if (/\[DEBUG\]/.test(line)) return 'debug'
  return 'info'
}

// ---- 脱敏：与 diagnostic_log.py 同一条底线——不落完整路径、文件名、用户名、主机名、设备名、邮箱、公网地址 ----
// 宁可多删不可漏：Windows / UNC 路径从盘符一直吃到引号、尖括号或行尾（文件名常带空格、括号、分号，按"末段"
// 截断会漏出后半截），只在整段以扩展名结尾时留扩展名。
// 路径体停在「: 」（Go 的 `路径: 原因`）、「 -> 」和下一个路径起点之前，否则会吞掉原因或漏出第二个路径的后半截。
const PATH_BODY = String.raw`(?:(?!: |\s+->|\s+[A-Za-z]:[\\/]|\s+\/(?:[a-zA-Z]|home|Users|storage|data)\/)[^\r\n"'<>|*?])*`
const WIN_PATH_RE = new RegExp(String.raw`(?:(?<![A-Za-z])[A-Za-z]:[\\/]|\\\\[^\\/\s"'<>|*?]+[\\/])` + PATH_BODY, 'g')
// MSYS / POSIX / 安卓路径（以盘符字母、home、storage 等根目录开头）与没有盘符、以 Users 目录加用户名开头的片段。
const POSIX_PATH_RE = new RegExp(
  String.raw`(?<![\w.:/])\/(?:[a-zA-Z]|home|Users|mnt|tmp|var|data|storage|sdcard|media|run|opt|root|private|Volumes)\/` +
    PATH_BODY,
  'g',
)
const REL_USER_PATH_RE = new RegExp(String.raw`(?<![\w<])(?:Users|Documents and Settings)[\\/]` + PATH_BODY, 'gi')
const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g
const IPV4_RE = /(?<![\d.])(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}(?::\d{1,5})?(?![\d.])/g
const IPV6_RE = /(?<![\w:])(?:[0-9A-Fa-f]{0,4}:){3,7}[0-9A-Fa-f]{0,4}(?![\w:])/g

function pathToken(m: string): string {
  const ext = /\.([A-Za-z0-9]{1,8})\s*$/.exec(m)
  return ext ? `<path:.${ext[1].toLowerCase()}>` : '<path>'
}

/** 回环、局域网、链路本地地址保留（判断"直连还是中继"要靠它），公网地址抹掉。 */
function isPrivateV4(a: number, b: number): boolean {
  return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254) || a === 0
}

const fixedTokens = new Set<string>()
const dynamicTokens = new Set<string>()
let identityTokens: RegExp | null = null

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ASCII 名字至少 3 个字符才替换（太短会误伤普通单词）；含非 ASCII 的（如「手机」）2 个字符即可。
function usableToken(t: string): boolean {
  if (!t) return false
  return /^[\x20-\x7e]+$/.test(t) ? t.trim().length >= 3 : t.trim().length >= 2
}

function rebuildTokens(): void {
  const all = [...new Set([...fixedTokens, ...dynamicTokens])].filter(usableToken).sort((a, b) => b.length - a.length)
  identityTokens = all.length
    ? new RegExp(`(?<![A-Za-z0-9])(?:${all.map(escapeRe).join('|')})(?![A-Za-z0-9])`, 'gi')
    : null
}

/** 本机用户名、主机名替换成占位符；守护进程日志前缀就是本机设备名（= 主机名）。 */
export function setIdentityTokens(tokens: string[]): void {
  fixedTokens.clear()
  for (const t of tokens) if (t) fixedTokens.add(t)
  rebuildTokens()
}

/** 已配对设备的名字（守护进程日志里会出现），随设备列表更新追加；封顶 200 个。 */
export function addIdentityTokens(tokens: unknown[]): void {
  let changed = false
  for (const t of tokens) {
    if (typeof t !== 'string' || !usableToken(t) || dynamicTokens.has(t) || dynamicTokens.size >= 200) continue
    dynamicTokens.add(t)
    changed = true
  }
  if (changed) rebuildTokens()
}

export function redact(text: string): string {
  let out = text
    .replace(WIN_PATH_RE, pathToken)
    .replace(POSIX_PATH_RE, pathToken)
    .replace(REL_USER_PATH_RE, pathToken)
    .replace(EMAIL_RE, '<email>')
    .replace(IPV4_RE, (m, a: string, b: string) => (isPrivateV4(Number(a), Number(b)) ? m : '<ip>'))
    .replace(IPV6_RE, (m) => (m.includes('::') || /[A-Fa-f]/.test(m) ? (/^(?:::1|fe80:)/i.test(m) ? m : '<ip6>') : m))
  if (identityTokens) out = out.replace(identityTokens, '<id>')
  return out
}

/**
 * 子进程 stderr 一块 → 若干条日志记录。以时间戳开头的行开启新记录（Python `2026-11-05 12:00:00,123`、
 * Go `2026/11/05 12:00:00`，可带 `[crossdevice] ` 前缀），其余行（Traceback、faulthandler 栈）并入上一条。
 */
export function splitRecords(text: string): string[] {
  const out: string[] = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    if (out.length === 0 || /^(\[[\w-]+\] )?\d{4}[-/]\d{2}[-/]\d{2}[ T]\d{2}:\d{2}/.test(line)) out.push(line)
    else out[out.length - 1] += '\n' + line
  }
  return out
}

/** 子进程 stderr 统一入口：拆记录、判级别、脱敏后入库。 */
export function logStderr(component: LogComponent, text: string): void {
  for (const rec of splitRecords(text)) logEvent(component, stderrLevel(rec), 'stderr', redact(rec))
}
