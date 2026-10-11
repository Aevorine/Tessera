import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// 守用户直接点名的三件事，都可能被重构悄悄改回：① 文件管理器在导航栏里位于工具箱与设置之间；
// ② 清理套件只占一个导航项（五个视角走顶部标签）；③ 「这次扫描没跑完」那句无用文案不许回来当兜底。

const SHELL = readFileSync(new URL('../src/components/AppShell.tsx', import.meta.url), 'utf8')
const SUITE = readFileSync(
  new URL('../src/components/pcclean/PcCleanSuiteScreen.tsx', import.meta.url),
  'utf8',
)
const HEALTH = readFileSync(
  new URL('../src/components/pcclean/PcCleanHealthScreen.tsx', import.meta.url),
  'utf8',
)

/** 按顺序抽出 NAV_GROUPS 里的 pane 值。不要求 `= [` 紧挨着：数组曾被包进 `useMemo(() => [...], [t])`，
 *  写死 `= \[` 的正则就从「顺序变了」变成「定义方式变了」才报错；守的是顺序，所以从声明处吃到第一个顶格两空格的 `]`。 */
function navPaneOrder() {
  const block = SHELL.match(/const NAV_GROUPS: NavGroup\[\] =[\s\S]*?\n {2}\]/)
  assert.ok(block, 'AppShell 必须有 NAV_GROUPS 数组')
  return [...block[0].matchAll(/pane: '([a-z]+)'/g)].map((m) => m[1])
}

test('文件管理器排在清理套件之后、设置之前', () => {
  const order = navPaneOrder()
  const clean = order.indexOf('pcclean')
  const fm = order.indexOf('filemanager')
  const settings = order.indexOf('settings')
  assert.ok(clean >= 0 && fm >= 0 && settings >= 0, `导航里缺项：${order.join(', ')}`)
  assert.ok(
    clean < fm,
    `文件管理器（第 ${fm} 项）必须排在清理套件（第 ${clean} 项）之后 —— 用户要的是"工具箱与设置之间"`,
  )
  assert.ok(
    fm < settings,
    `文件管理器（第 ${fm} 项）必须排在设置（第 ${settings} 项）之前`,
  )
})

test('清理套件在侧边栏只占一项，五个视角走顶部标签', () => {
  const order = navPaneOrder()
  const cleanPanes = order.filter((p) => p.startsWith('pcclean'))
  assert.deepEqual(
    cleanPanes,
    ['pcclean'],
    `侧边栏出现了 ${cleanPanes.length} 个清理项（${cleanPanes.join(', ')}）——` +
      '摊开五项会让一个模块淹掉整条侧边栏，它们该是顶部标签',
  )
  // 但五个 pane 值必须都还在标签条里，否则命令面板的深链会落空。
  for (const pane of ['pcclean', 'pccleanspace', 'pccleanstartup', 'pccleansoftware', 'pccleantoolbox']) {
    assert.match(SUITE, new RegExp(`pane: '${pane}'`), `标签条缺少 ${pane}，深链会落到错误的页面`)
  }
})

test('工具箱是清理套件的最后一个标签', () => {
  // "文件管理器放在工具箱与设置之间"这句话只有在工具箱排最后时才成立。
  const tabs = [...SUITE.matchAll(/pane: '(pcclean[a-z]*)'/g)].map((m) => m[1])
  assert.equal(
    tabs[tabs.length - 1],
    'pccleantoolbox',
    `标签顺序是 ${tabs.join(' → ')}，工具箱不在最后`,
  )
})

test('扫描失败不再用一句笼统的「没跑完」兜底', () => {
  // 根因（桥接层超时）修在别处，但这条盯的是**表达**：失败必须落到
  // failures[] 那张卡上，说清哪一类、什么原因、能不能只重扫这一类。
  assert.match(
    HEALTH,
    /setFailures\(/,
    '扫描失败必须写进 failures 状态，而不是弹一句通用 toast 就完事',
  )
  assert.match(HEALTH, /health\.failuresTitle/, '必须有失败卡的标题')
  assert.match(HEALTH, /rescanOne/, '必须提供"只重扫这一类"，整轮重来是纯浪费——其余类是好的')
  assert.doesNotMatch(
    HEALTH,
    /toast\.error\(t\('scan\.failed'\)\)/,
    "「这次扫描没跑完」这句话既不说哪一类也不说为什么，不许再拿它当兜底",
  )
})

test('执行清理默认不提权，需要授权的项走单独一张卡', () => {
  assert.match(
    HEALTH,
    /allow_elevation: allowElevation/,
    'pcclean_execute 必须显式传 allow_elevation —— 默认弹 UAC 是在用户没预期时抢他的注意力',
  )
  assert.match(HEALTH, /runClean\(\[\.\.\.selected\], false\)/, '第一次清理必须以 allow_elevation=false 发起')
  assert.match(HEALTH, /elevate\.authorize/, '必须有一个明确的"授权并清理"按钮')
  assert.match(
    HEALTH,
    /runClean\(pendingAuth\.item_ids, true\)/,
    '授权按钮必须只对需要权限的那批重跑，不是整批重来',
  )
})

test('进度显示同时给出：在扫什么 / 扫了几类 / 还剩多久', () => {
  // 少任何一样，用户都还得自己猜"它是不是死了"——那正是这一轮要修的观感问题。
  assert.match(HEALTH, /health\.scanningNow/, '要显示当前正在扫哪几类')
  assert.match(HEALTH, /scannedCount/, '要显示已完成几类')
  assert.match(HEALTH, /health\.eta/, '要显示预计剩余时间')
  // 分母必须跟着档位变。写死 9 的话，极速档（只扫 4 类）永远停在 44%。
  assert.match(
    HEALTH,
    /activeCategories\.length/,
    '进度分母必须是本档实际要扫的类数，不能写死',
  )
})
