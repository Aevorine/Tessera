#!/usr/bin/env node
// 布局探针：用真浏览器量真像素。vitest 跑在 jsdom 里没有布局引擎（getBoundingClientRect 全零），
// 只能证明元素渲染了，证明不了空白或内容列被挤成几像素。
// 用法：npm run probe（量四个面板）；-- --shots 存截图到 .probe-shots/；-- --pane=clipboard。
// 自己拉起 vite（vite.measure.config.ts，不挂 electron 插件，不抢焦点）并关闭；
// 入口 measure.html + src/measure.tsx 原样复刻 AppShell 外层类名和 main.tsx 启动顺序，
// 近似会量不出高度链问题。

import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const args = process.argv.slice(2)
const wantShots = args.includes('--shots')
const paneArg = args.find((a) => a.startsWith('--pane='))
const ALL_PANES = [
  'passwords', 'clipboard', 'notes', 'files', 'crossdevice', 'recoverycodes',
  'ai', 'network', 'filemanager', 'security', 'settings', 'help', 'diagnostics', 'doc',
]
// `shell` 走的是**真的 AppShell**，其余是单面板 + 复制外壳。
// 复制品抓不到原件的毛病，所以这一项必须在，而且排最前面先跑。
const PANES = paneArg ? [paneArg.slice('--pane='.length)] : ['shell', ...ALL_PANES]
const PORT = 5199
const SHOT_DIR = '.probe-shots'
/** 侧栏宽度。左边距要减掉它才是"内容离侧栏多远"。 */
const SIDEBAR = 184

/**
 * 量两遍，因为够不够得着取决于窗口高度：1920×1080 台式机、1280×720 笔记本；
 * 侧边栏十三个入口九百多像素，720 高时设置/诊断/帮助掉出屏幕且滚不到。
 */
const VIEWPORTS = [
  { w: 1920, h: 1080, name: '1920x1080' },
  { w: 1280, h: 720, name: '1280x720' },
]

// 直接用当前 node 跑 vite 入口，不走 npx：Windows 无 shell spawn npx（.cmd）会 EINVAL，加
// shell:true 又每次刷 DEP0190 警告。
const VITE_BIN = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url))
const vite = spawn(process.execPath, [VITE_BIN, '--config', 'vite.measure.config.ts'], {
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  stdio: 'ignore',
})
const stopVite = () => { try { vite.kill() } catch { /* 已经没了 */ } }
process.on('exit', stopVite)
process.on('SIGINT', () => { stopVite(); process.exit(130) })

async function waitForServer(timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/measure.html`)
      if (res.ok) return
    } catch { /* 还没起来 */ }
    await sleep(400)
  }
  throw new Error(`vite 没能在 ${timeoutMs}ms 内起来`)
}

await waitForServer()
if (wantShots) mkdirSync(SHOT_DIR, { recursive: true })

const browser = await chromium.launch(process.env.PROBE_CHROMIUM ? { executablePath: process.env.PROBE_CHROMIUM } : {})
let problems = 0

for (const { w: VW, h: VH, name: VNAME } of VIEWPORTS) {
console.log(`\n--- ${VNAME} ---`)
for (const pane of PANES) {
  const page = await browser.newPage({ viewport: { width: VW, height: VH }, deviceScaleFactor: 1 })
  const refWarns = new Set()
  const errors = new Set()
  // React「画出来的内容是错的」类警告都走 console.error，界面照常不崩溃（如 key
  // 重复会让两行内容互串，
  // 曾导致设备详情两行都叫「连接方式」），tsc / eslint / 行为测试 / 几何测量都不会响。
  const reactBugs = new Set()
  const REACT_BUG_PATTERNS = [
    'same key',                      // 键重复 -> 节点复用错乱
    'unique "key"',                  // 列表缺 key
    'validateDOMNesting',            // <div> 塞进 <p> 之类，浏览器会自己改结构
    'cannot appear as a descendant', // 同上
    'Each child in a list',
  ]
  page.on('pageerror', (e) => errors.add(e.message.slice(0, 140)))
  page.on('console', (m) => {
    const text = m.text()
    if (text.includes('Function components cannot be given refs')) {
      // ref 断在哪一层，只有组件栈说得清；node_modules 那几行是噪音。
      const at = text.split('\n').find((l) => l.trim().startsWith('at ') && !l.includes('node_modules'))
      refWarns.add((at ?? text).trim().slice(0, 110))
    } else if (REACT_BUG_PATTERNS.some((p) => text.includes(p))) {
      const head = text.split('\n')[0].replace(/\s+/g, ' ')
      const at = text.split('\n').find((l) => l.trim().startsWith('at ') && !l.includes('node_modules'))
      reactBugs.add(`${head.slice(0, 90)}${at ? ` (${at.trim()})` : ''}`)
    } else if (m.type() === 'error') {
      errors.add(text.slice(0, 140))
    }
  })

  const query = pane === 'shell' ? 'shell=1' : `pane=${pane}`
  await page.goto(`http://127.0.0.1:${PORT}/measure.html?${query}`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(2500)

  const report = await page.evaluate((sidebar) => {
    // 单面板模式挂的是自己的标记；`?shell=1` 渲染的是真 AppShell，它有自己的
    // <main>。两种都要认，否则真外壳那一格永远报"没渲染出来"。
    const main = document.querySelector('[data-probe="main"]') ?? document.querySelector('main')
    if (!main) return { fatal: '页面没渲染出来（看下面的 ERR）' }
    const vw = window.innerWidth
    const vh = window.innerHeight
    const round = (n) => Math.round(n)

    // 可见内容的四至。用它算"四周还剩多少空白"。
    let maxBottom = 0
    let minLeft = vw
    let maxRight = 0
    for (const el of main.querySelectorAll('*')) {
      const r = el.getBoundingClientRect()
      if (r.width < 2 || r.height < 2 || r.top > vh || r.bottom < 0) continue
      const cs = getComputedStyle(el)
      if (cs.visibility === 'hidden' || cs.opacity === '0') continue
      maxBottom = Math.max(maxBottom, Math.min(r.bottom, vh))
      minLeft = Math.min(minLeft, r.left)
      maxRight = Math.max(maxRight, r.right)
    }

    const list = main.querySelector('[data-testid="workbench-list"]')
    const detail = main.querySelector('[data-testid="workbench-detail"]')
    const box = (el) => {
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: round(r.x), y: round(r.y), w: round(r.width), h: round(r.height) }
    }

    // 内容比自己高、又不给滚 = 被裁掉了。sr-only 的标题是有意为之，排除。
    const clipped = []
    for (const el of main.querySelectorAll('*')) {
      const cs = getComputedStyle(el)
      if (cs.overflowY !== 'hidden') continue
      if (el.scrollHeight - el.clientHeight <= 4) continue
      const cls = (el.className || '').toString()
      if (cls.includes('sr-only') || cls.includes('line-clamp')) continue
      clipped.push({ tag: el.tagName, cls: cls.slice(0, 60) })
    }

    // 够不够得着：判据是元素在视口外且从它到根没有任何一层能滚到它，不管谁裁的、用什么属性。
    // 上面的 clipped 只认 overflow-y:hidden 的盒子，漏掉两种形状：侧边栏 aside 自身 visible 但被祖先
    // h-screen overflow-hidden 裁掉；
    // 设备与同步页开了 PageShell fill（不滚）而内容是一长串分区。
    const canScrollTo = (el) => {
      for (let p = el.parentElement; p; p = p.parentElement) {
        const cs = getComputedStyle(p)
        if (!/(auto|scroll)/.test(cs.overflowY)) continue
        if (p.scrollHeight - p.clientHeight > 4) return true
      }
      // 页面本身能滚也算够得着。
      const de = document.documentElement
      return de.scrollHeight - de.clientHeight > 4
    }
    const unreachable = []
    const seenText = new Set()
    // 只看**能被点或被读**的东西：按钮、链接、输入框，以及叶子文本节点。
    // 拿容器来判会把"容器很高但内容都在视口里"误报成够不着。
    for (const el of document.body.querySelectorAll('button,a,input,textarea,select,[role="button"]')) {
      const r = el.getBoundingClientRect()
      if (r.width < 2 || r.height < 2) continue
      if (r.top < vh - 4 && r.bottom > 4) continue // 至少露了一部分在视口里
      if (canScrollTo(el)) continue
      const label =
        (el.getAttribute('aria-label') || el.textContent || el.getAttribute('placeholder') || el.tagName)
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 28)
      if (seenText.has(label)) continue
      seenText.add(label)
      unreachable.push({ y: round(r.top), what: label })
    }

    // 侧边栏单独报一格：它是全应用唯一的导航入口，够不着 = 那个功能整个消失。
    const aside = document.querySelector('[data-probe="sidebar"]') ?? document.querySelector('aside')
    let navOverflow = 0
    if (aside) {
      const r = aside.getBoundingClientRect()
      // 侧栏内容的真实高度：最后一个可见子元素的底边。aside 自己 overflow 是
      // visible，scrollHeight 反映不出溢出，只能自己量。
      let bottom = r.top
      for (const el of aside.querySelectorAll('*')) {
        const cr = el.getBoundingClientRect()
        if (cr.width < 2 || cr.height < 2) continue
        bottom = Math.max(bottom, cr.bottom)
      }
      const overflowPx = round(bottom - Math.min(r.bottom, vh))
      const scrollable = [...aside.querySelectorAll('*')].some((el) => {
        const cs = getComputedStyle(el)
        return /(auto|scroll)/.test(cs.overflowY) && el.scrollHeight - el.clientHeight > 4
      })
      if (overflowPx > 4 && !scrollable) navOverflow = overflowPx
    }

    // 正文里混进源码痕迹 = 本该是注释/代码的东西被当文本画了出来（曾有 JSX 注释漏花括号，
    // 中文说明印在用户屏幕上，tsc/eslint/几何测量都全绿）。
    // 检测器要覆盖整个 body（该文字曾是 <main> 的兄弟节点）且长度上限不能太小（真实注释有两百多字）；
    // 没见过它亮红灯的守卫等于没有守卫。
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        // 内联 <script>/<style> 的内容天然含 /* */，扫它们只会造出假警报。
        const tag = node.parentElement?.tagName
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return NodeFilter.FILTER_REJECT
        return NodeFilter.FILTER_ACCEPT
      },
    })
    let visibleText = ''
    for (let n = walker.nextNode(); n; n = walker.nextNode()) visibleText += n.nodeValue + String.fromCharCode(10)

    const junk = []
    for (const [name, re] of [
      ['JSX 注释漏花括号', /\/\*[\s\S]{0,4000}?\*\//],
      ['className 泄漏', /className=/],
      ['模板字面量泄漏', /\$\{[a-zA-Z_]/],
    ]) {
      const m = visibleText.match(re)
      if (m) junk.push(`${name}: ${m[0].slice(0, 60).replace(/\s+/g, ' ')}`)
    }

    // 详情栏是不是空的（只剩一句占位）。这是"上下都为空白"的主要形态。
    const detailText = (detail?.textContent ?? '').replace(/\s+/g, '')
    return {
      bottomGap: round(vh - maxBottom),
      leftGap: round(minLeft - sidebar),
      rightGap: round(vw - maxRight),
      list: box(list),
      detail: box(detail),
      detailChars: detailText.length,
      clipped: clipped.slice(0, 3),
      unreachable: unreachable.slice(0, 4),
      nUnreachable: unreachable.length,
      navOverflow,
      junk,
    }
  }, SIDEBAR)

  const flag = []
  if (report.fatal) {
    flag.push(report.fatal)
  } else {
    // 44px 是 PageShell 在 lg 档的 py-11，属于有意留白，不算"空掉"。
    if (report.bottomGap > 80) flag.push(`底部空 ${report.bottomGap}px`)
    if (report.rightGap > 80) flag.push(`右边空 ${report.rightGap}px`)
    if (report.leftGap > 80) flag.push(`左边空 ${report.leftGap}px`)
    if (report.detail && report.detailChars < 40) flag.push(`右栏几乎是空的（${report.detailChars} 字）`)
    if (report.clipped?.length) flag.push(`${report.clipped.length} 处内容被裁掉`)
    // 够不着比排版难看严重一档：那个功能对用户等于不存在。
    if (report.nUnreachable > 0) {
      flag.push(
        `${report.nUnreachable} 个控件滚不到（${report.unreachable.map((u) => `${u.what}@y=${u.y}`).join(', ')}）`,
      )
    }
    if (report.navOverflow > 0) flag.push(`导航栏溢出 ${report.navOverflow}px 且不能滚`)
    // 画错东西比排错版严重：排版错了用户觉得难看，画错了用户觉得程序坏了。
    if (report.junk?.length) flag.push(`界面上出现了源码：${report.junk.join('；')}`)
  }
  if (refWarns.size) flag.push(`${refWarns.size} 处 ref 断了`)
  if (reactBugs.size) flag.push(`${reactBugs.size} 处 React 结构问题`)

  const status = flag.length ? 'BAD ' : 'OK  '
  console.log(`${status}${pane.padEnd(10)} ${JSON.stringify(report)}`)
  if (refWarns.size) console.log(`       ref: ${[...refWarns].join(' | ')}`)
  if (reactBugs.size) console.log(`       react: ${[...reactBugs].join(' | ')}`)
  if (errors.size) console.log(`       err: ${[...errors].slice(0, 2).join(' | ')}`)
  if (flag.length) {
    console.log(`       >> ${flag.join('；')}`)
    problems += 1
  }

  if (wantShots) await page.screenshot({ path: `${SHOT_DIR}/${pane}-${VNAME}.png` })
  await page.close()
}
}

await browser.close()
stopVite()

if (problems > 0) {
  console.log(`\n${problems} 个面板有问题。截图看 \`npm run probe -- --shots\`。`)
  process.exit(1)
}
console.log('\n四周都填满了，没有被裁掉/够不着的内容，导航栏能滚，ref 也都接上了。')
