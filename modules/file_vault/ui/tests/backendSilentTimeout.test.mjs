import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// 回归守卫：RPC 发出后若后端线程被占住或吞掉该请求，调用方会永远 await（按钮转圈、整页空白）。
// 不启动真 Electron，只钉三件事：① 默认空闲超时存在且不过长；② 收到 progress 会重新计时，否则长任务被误杀；
// ③ 需长时间沉默的操作有豁免，且豁免是白名单而非黑名单。

const SRC = readFileSync(new URL('../electron/pythonBridge.ts', import.meta.url), 'utf8')

test('每个请求都有静默超时兜底，且长度合理', () => {
  const m = SRC.match(/const DEFAULT_SILENT_TIMEOUT_MS = ([\d_]+)/)
  assert.ok(m, 'pythonBridge 必须定义 DEFAULT_SILENT_TIMEOUT_MS')
  const ms = Number(m[1].replace(/_/g, ''))
  assert.ok(ms >= 10_000, `默认超时 ${ms}ms 太短，正常的冷启动就会被误杀`)
  assert.ok(ms <= 60_000, `默认超时 ${ms}ms 太长，用户早就以为卡死了`)
})

test('收到 progress 会重新计时，长任务不会被误杀', () => {
  // 这条是整个设计成立的前提：超时盯的是"没声音"，不是"没跑完"。
  // 少了这一句，加密一个大文件跑到第 21 秒就会被自己的超时打断。
  assert.match(
    SRC,
    /if \(msg\.progress\) \{[\s\S]{0,200}?entry\.rearmTimer\?\.\(\)/,
    'handleLine 收到 progress 时必须调用 entry.rearmTimer()',
  )
})

test('答案到达和进程退出都要清掉计时器', () => {
  // 不清的话，一个已经 resolve 的请求会在几十秒后再触发一次定时器；
  // 更实际的后果是 Electron 主进程被这些空转定时器拖着不肯退出。
  const clears = SRC.match(/clearTimeout\(entry\.timer\)/g) ?? []
  assert.ok(clears.length >= 2, `clearTimeout(entry.timer) 只出现 ${clears.length} 次，收尾路径没盖全`)
})

test('长时间沉默的操作走白名单豁免，新 RPC 默认受保护', () => {
  const table = SRC.match(/const SILENT_TIMEOUT_OVERRIDES[^{]*\{([\s\S]*?)\n\}/)
  assert.ok(table, '必须有 SILENT_TIMEOUT_OVERRIDES 表')
  const body = table[1]
  // 这三类确实要等一件不由我们控制的事：等人碰传感器、等 SMTP、等测速跑完。
  for (const method of ['unlock_fingerprint', 'unlock_email_start', 'network_speedtest_run']) {
    assert.match(body, new RegExp(`\\b${method}\\b`), `${method} 必须在豁免表里，否则正常使用会被判成故障`)
  }
  // 取值方式必须是"表里没有就用默认"，不能反过来——反过来意味着新加的 RPC
  // 默认不受保护，而卡死恰恰总是出现在最新加的那个上。
  assert.match(
    SRC,
    /SILENT_TIMEOUT_OVERRIDES\[[^\]]+\]\s*\?\?\s*DEFAULT_SILENT_TIMEOUT_MS/,
    '必须是 overrides[method] ?? DEFAULT，保证默认受保护',
  )
})

// 回归守卫：清理套件的长跑 RPC 若不在豁免表里，任一类沉默超 20 秒就被桥接层判负（后端实际正常，本机九类 6.4 秒全绿）。
// 以后新增清理相关长跑 RPC 忘配预算就会红。
test('清理套件的长跑 RPC 都有放宽的静默预算', () => {
  const table = SRC.match(/const SILENT_TIMEOUT_OVERRIDES[^{]*\{([\s\S]*?)\n\}/)
  assert.ok(table, '必须有 SILENT_TIMEOUT_OVERRIDES 表')
  const body = table[1]
  // 判据是「该方法是否可能长时间不出声」，而非重要性：体检的 schtasks（5~9 秒起）、全盘哈希扫描、
  // 回收站 API 执行、工具箱 sfc/碎片整理（按分钟计）、提权类中间隔着 UAC 弹窗。
  const LONG_RUNNING = [
    'pcclean_health_check',
    'pcclean_scan',
    'pcclean_execute',
    'pcclean_preview',
    'pcclean_uninstall',
    'pcclean_undo',
    'pcclean_run_tool',
    'pcclean_optimize_volume',
    'pcclean_memory_purge_standby',
  ]
  for (const method of LONG_RUNNING) {
    const m = body.match(new RegExp(`\\b${method}\\s*:\\s*([\\d_]+)`))
    assert.ok(m, `${method} 不在豁免表里 —— 它一旦沉默超过默认预算就会被误判成"扫描没跑完"`)
    const ms = Number(m[1].replace(/_/g, ''))
    assert.ok(
      ms >= 60_000,
      `${method} 的预算只有 ${ms}ms，比它自己最坏情况还短，等于没配`,
    )
  }
})

test('超时抛出的错误码在六种语言里都有文案', () => {
  assert.match(SRC, /backend\.no_response/, '超时必须抛可翻译的错误码')
  for (const lang of ['en', 'zh', 'fr', 'es', 'ru', 'ar']) {
    const dict = JSON.parse(readFileSync(new URL(`../src/i18n/locales/${lang}/errors.json`, import.meta.url), 'utf8'))
    assert.ok(dict['backend.no_response'], `${lang} 缺少 backend.no_response —— 界面会回落成显示原始 key`)
  }
})
