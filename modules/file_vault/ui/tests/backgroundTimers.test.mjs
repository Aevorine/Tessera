import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// 常驻定时器必须判窗口可见性，否则应用最小化后仍每 2 秒唤醒 Python 后端采样，笔记本无端掉电且界面毫无迹象。
// CrossDeviceScreen 的四个定时器都写了 `if (document.visibilityState !== 'visible') return`，
// 但这只是约定（ProfessionalMetricsPanel 就漏了）；本文件把约定变成机制。

const COMPONENTS_DIR = new URL('../src/components/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

/** setInterval(..., N) 里 N >= 这个值的算"低频轮询"，不强制判可见性——
 *  几分钟一次的心跳在后台跑一次的代价可以忽略，强制它反而是噪音。 */
const LOW_FREQUENCY_MS = 60_000

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (entry.name.endsWith('.tsx')) out.push(full)
  }
  return out
}

/** 从 setInterval( 起按括号深度配平取出整段调用；找下一个 `)` 会在回调体中途截断，误判成没判可见性。 */
function extractIntervals(src) {
  const out = []
  const re = /\bsetInterval\s*\(/g
  let m
  while ((m = re.exec(src)) !== null) {
    let depth = 0
    let i = m.index + m[0].length - 1
    for (; i < src.length; i += 1) {
      if (src[i] === '(') depth += 1
      else if (src[i] === ')') {
        depth -= 1
        if (depth === 0) break
      }
    }
    out.push({ text: src.slice(m.index, i + 1), index: m.index })
  }
  return out
}

test('常驻定时器必须判窗口可见性，否则最小化之后还在偷偷跑', () => {
  const offenders = []
  let checked = 0

  for (const file of walk(COMPONENTS_DIR)) {
    const name = file.split(/[\\/]/).pop()
    const src = stripComments(readFileSync(file, 'utf8'))
    for (const { text, index } of extractIntervals(src)) {
      // 末尾的间隔参数：`}, 2000)` 里的 2000。取不到就当成高频，宁可误报也不放过。
      const period = /,\s*(\d[\d_]*)\s*\)\s*$/.exec(text)
      const ms = period ? Number(period[1].replace(/_/g, '')) : 0
      if (ms >= LOW_FREQUENCY_MS) continue

      checked += 1
      if (/visibilityState/.test(text)) continue

      // 进度条这类只在操作进行中存在的定时器不算常驻——它们的生命周期就是
      // 那次操作，操作一结束就被 clearInterval 了。用变量名认出来。
      if (/progress/i.test(text)) continue

      const line = src.slice(0, index).split('\n').length
      offenders.push(`${name}:${line}  setInterval(..., ${ms || '?'})`)
    }
  }

  assert.ok(checked > 0, '一个定时器都没扫到，正则多半已经和代码脱节了')
  assert.deepEqual(
    offenders,
    [],
    '下面这些定时器没判 document.visibilityState。应用最小化/切到后台之后它们' +
      '仍然在跑，用户看不见但电在掉：\n' + offenders.join('\n'),
  )
})
