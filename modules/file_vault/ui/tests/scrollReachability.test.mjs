import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

// 「界面滑不动」的静态守卫。真浏览器（scripts/layout-probe.mjs，1280×720）实测：导航栏溢出 504px，
// 16 个入口够不着（网络测速到帮助整段消失，无滚动条、滚轮也无反应）；设备与同步页 9 个控件够不着。
// 病根都在「谁负责滚」：`<main>` 改成 overflow-hidden（滚动职责下放各页）后，没人接住的地方变成静默裁剪，
// 编译和行为测试全绿。本文件守三条原因，探针守结果（真像素、真滚动）：静态层每次 npm test 都跑、便宜、能指到行；
// 探针抓得广但要拉浏览器、约两分钟。

const SRC = new URL('../src', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

function allSources(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) allSources(full, out)
    else if (name.endsWith('.tsx')) out.push(full)
  }
  return out
}

/** 去掉注释。不去的话，解释这个 bug 的注释本身会被当成 bug 报出来。 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/** 一个 className 字面量里出现的类名。模板串里的插值段跳过。 */
function classLists(source) {
  const out = []
  const re = /className=(?:"([^"]*)"|\{`([^`]*)`\}|\{cn\(([\s\S]*?)\)\}|'([^']*)')/g
  let m
  while ((m = re.exec(source)) !== null) {
    const raw = m[1] ?? m[2] ?? m[3] ?? m[4] ?? ''
    // cn(...) 里是逗号分隔的多段，每段单独算一个元素的类名集合是不对的
    // （`cn('a', x && 'b')` 里 a 和 b 会同时出现在同一个元素上），所以整段合起来看。
    out.push({ text: raw, index: m.index })
  }
  return out
}

function lineOf(source, index) {
  return source.slice(0, index).split('\n').length
}

const FILES = allSources(SRC)

test('扫描器自己认得出这三种真实的坏写法（守卫的自检）', () => {
  // 没见过自己亮红灯的守卫等于没有守卫。这三段是 2026-08-19 真正写坏的形状。
  const badOverflow = `<div className="flex-1 overflow-y-auto p-4">`
  assert.equal(findMissingMinH0(badOverflow).length, 1, '漏掉了 flex-1 + overflow-y-auto 少 min-h-0')
  assert.equal(
    findMissingMinH0(`<div className="min-h-0 flex-1 overflow-y-auto p-4">`).length,
    0,
    '写对了却被误报',
  )
  // `overflow-y-auto` 配的是固定高度（h-64 之类）时不需要 min-h-0，不许误报。
  assert.equal(
    findMissingMinH0(`<div className="h-64 overflow-y-auto">`).length,
    0,
    '固定高度的滚动容器被误报',
  )

  const badWrap = `<div className="flex shrink-0 flex-wrap items-center gap-2">`
  assert.equal(findShrinkZeroWrap(badWrap).length, 1, '漏掉了 shrink-0 + flex-wrap')
  assert.equal(
    findShrinkZeroWrap(`<div className="flex min-w-0 flex-wrap items-center gap-2">`).length,
    0,
    '写对了却被误报',
  )

  const badHeight = `<div className="ds-page-wash flex h-screen w-full flex-col px-8 py-7">`
  assert.equal(findViewportHeightInPane(badHeight).length, 1, '漏掉了面板里的 h-screen')
})

// 一、`flex-1` + `overflow-y-auto` 必须带 `min-h-0`：flex 子项默认 `min-height: auto` 不肯收缩到比内容矮，
// overflow-y-auto 永远等不到「放不下」，滚动条不出现，超出部分被上层 overflow-hidden 裁掉
// （恢复密钥页仪表盘和 PageShell 非 fill 档踩过）。

export function findMissingMinH0(source) {
  const hits = []
  for (const { text, index } of classLists(source)) {
    if (!/\boverflow-y-auto\b/.test(text)) continue
    // 高度是自己定死的（h-64 / h-full / max-h-[…] / min-h-full）就不需要 min-h-0，
    // 那种情况下盒子的高度跟 flex 分配无关。
    if (/\b(h-\d|h-full|h-screen|h-\[|max-h-|min-h-full)/.test(text)) continue
    // 高度也可能写在 `style={{ height: … }}` 里（如笔记 Markdown 预览栏的 50vh / 72vh）；style 紧跟 className 是本仓库一致写法，往后看一小段即可。
    if (/style=\{\{[^}]*height/.test(source.slice(index, index + 400))) continue
    if (!/\bflex-1\b/.test(text)) continue
    if (/\bmin-h-0\b/.test(text)) continue
    hits.push({ line: lineOf(source, index), text: text.replace(/\s+/g, ' ').slice(0, 70) })
  }
  return hits
}

test('flex-1 的滚动容器都带了 min-h-0', () => {
  const bad = []
  for (const file of FILES) {
    const src = stripComments(readFileSync(file, 'utf8'))
    for (const hit of findMissingMinH0(src)) {
      bad.push(`${file.split(/[\\/]/).slice(-2).join('/')}:${hit.line}  ${hit.text}`)
    }
  }
  assert.deepEqual(
    bad,
    [],
    'flex-1 + overflow-y-auto 少了 min-h-0——flex 子项默认 min-height:auto 不肯收缩，' +
      'overflow-y-auto 就永远不生效，内容会被静默裁掉：\n  ' + bad.join('\n  '),
  )
})

// 二、`shrink-0` 和 `flex-wrap` 不能写在同一个元素：flex-wrap 的换行取决于盒子自身宽度，shrink-0 却不许它比内容窄，
// 于是按内容排成一长条捅出父容器（剪贴板页 1280 宽窗口，右栏按钮组 919px，横向溢出 292px）。

export function findShrinkZeroWrap(source) {
  const hits = []
  for (const { text, index } of classLists(source)) {
    if (!/\bflex-wrap\b/.test(text)) continue
    if (!/\bshrink-0\b/.test(text)) continue
    hits.push({ line: lineOf(source, index), text: text.replace(/\s+/g, ' ').slice(0, 70) })
  }
  return hits
}

test('没有元素同时写了 shrink-0 和 flex-wrap', () => {
  const bad = []
  for (const file of FILES) {
    const src = stripComments(readFileSync(file, 'utf8'))
    for (const hit of findShrinkZeroWrap(src)) {
      bad.push(`${file.split(/[\\/]/).slice(-2).join('/')}:${hit.line}  ${hit.text}`)
    }
  }
  assert.deepEqual(
    bad,
    [],
    'shrink-0 和 flex-wrap 互相抵消：不许比内容窄，就永远没有"放不下"这件事，' +
      'flex-wrap 永远不生效，按钮排成一长条捅出窗口。要换行就去掉 shrink-0：\n  ' + bad.join('\n  '),
  )
})

// 三、面板不许自己声明视口高度：面板在 `<main>` 里，main 已吃满视口且压着「接着刚才」横幅，
// 面板再声明 `h-screen`（或 `h-full`）就比容器高出横幅那么多，底下被裁掉；要「剩下的高度」应写 `flex-1`。

export function findViewportHeightInPane(source) {
  const hits = []
  for (const { text, index } of classLists(source)) {
    if (!/\b(h-screen|min-h-screen)\b/.test(text)) continue
    hits.push({ line: lineOf(source, index), text: text.replace(/\s+/g, ' ').slice(0, 70) })
  }
  return hits
}

/**
 * 允许声明视口高度的地方，判据是它渲染在 `<main>` 外面（h-screen 的问题只出现在已有定高祖先时），不是特例豁免。
 *   App.tsx / AppShell.tsx 应用根与外壳，视口高度从此定下；ErrorBoundary.tsx 接管整个窗口；
 *   LoginScreen.tsx / SetupWizard.tsx 解锁或向导前外壳未挂载；measure.tsx 探针入口，复刻外壳外层类名。
 */
const VIEWPORT_HEIGHT_ALLOWED = new Set([
  'App.tsx',
  'AppShell.tsx',
  'ErrorBoundary.tsx',
  'LoginScreen.tsx',
  'SetupWizard.tsx',
  'measure.tsx',
])

test('只有外壳能声明视口高度，面板一律用 flex-1', () => {
  const bad = []
  for (const file of FILES) {
    const base = file.split(/[\\/]/).pop()
    if (VIEWPORT_HEIGHT_ALLOWED.has(base)) continue
    const src = stripComments(readFileSync(file, 'utf8'))
    for (const hit of findViewportHeightInPane(src)) {
      bad.push(`${file.split(/[\\/]/).slice(-2).join('/')}:${hit.line}  ${hit.text}`)
    }
  }
  assert.deepEqual(
    bad,
    [],
    '面板里出现了 h-screen / min-h-screen。面板在 <main> 里面，main 已经占满视口、' +
      '上面还压着一条横幅，再声明一次视口高度就会比容器高出一截、底下被裁掉。' +
      '要"剩下的高度"请用 min-h-0 flex-1：\n  ' + bad.join('\n  '),
  )
})

// 四、导航栏必须有一段能滚：十三个入口 + 常用区，长度取决于用户置顶数。侧栏自己的 overflow 是默认 visible，
// 裁它的是外面的 `h-screen overflow-hidden`，所以没写 overflow-hidden 不代表没问题。

test('导航栏中间那段能滚，上下两段常驻', () => {
  const shell = readFileSync(join(SRC, 'components/AppShell.tsx'), 'utf8')
  const code = stripComments(shell)

  const aside = code.slice(code.indexOf('<aside'), code.indexOf('</aside>'))
  assert.ok(aside.length > 500, '没找到 <aside>，这条守卫的定位方式该更新了')

  assert.match(
    aside,
    /min-h-0 flex-1 overflow-y-auto/,
    '导航栏里没有"能滚的那一段"（min-h-0 flex-1 overflow-y-auto）。' +
      '少了它，矮窗口下最底下的入口够不着，而且不会有任何报错——' +
      '1280×720 实测溢出 504px、16 个入口消失。',
  )

  // 折叠按钮被滚走的话，窄窗口下用户连"把侧栏收起来腾地方"这条自救路都没有。
  const afterScroller = aside.slice(aside.indexOf('min-h-0 flex-1 overflow-y-auto'))
  assert.match(
    afterScroller,
    /shrink-0/,
    '滚动区后面没有常驻段（shrink-0）——折叠按钮和显示模式开关会被一起滚走',
  )
})

// 五、PageShell 的 fill 档只给有界版面用：fill = 本页不滚、把高度分给内部各块，给长列表分区的页面开 fill 等于丢掉多出来的部分
// （设备与同步页的错误分支就是）。判据：开了 fill 的文件里必须出现 <Workbench，那是唯一需要有界父级的东西。

test('开了 PageShell fill 的页面，里面必须有双栏工作台', () => {
  const bad = []
  for (const file of FILES) {
    const src = stripComments(readFileSync(file, 'utf8'))
    if (!/<PageShell[^>]*\sfill\b/.test(src)) continue
    if (/<Workbench\b/.test(src)) continue
    bad.push(file.split(/[\\/]/).slice(-2).join('/'))
  }
  assert.deepEqual(
    bad,
    [],
    'PageShell 开了 fill（页面自己不滚），可这个文件里没有 <Workbench>——' +
      '也就是没有"需要有界父级"的东西，多出一屏的内容会被直接裁掉、滚不到：\n  ' +
      bad.join('\n  '),
  )
})
