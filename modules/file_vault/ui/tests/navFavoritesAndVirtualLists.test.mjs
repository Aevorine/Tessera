/**
 * C2（常用区置顶 + 可自定义）与 D1（性能三连）的不变量。坏掉时界面照样渲染：
 * 虚拟化退回全量 `.map()` 外观一样，只是批量加密一千个文件会卡；进度更新退回 `qs.map(...)` 全量重建同理。
 * 除 navPrefs 的净化用例能真跑外，其余只能在源码层盯住。跑法：`npm run test:update`
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_FAVORITE_PANES,
  addFavorite,
  moveFavorite,
  normalizeNavPreferences,
  removeFavorite,
} from '../src/lib/navPrefs.ts'

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

const APP_SHELL = read('../src/components/AppShell.tsx')
const FILES = read('../src/components/FilesPane.tsx')
const CROSS_DEVICE = read('../src/components/CrossDeviceScreen.tsx')

// navPrefs：localStorage 是不可信输入

test('读不懂的导航偏好安全退回默认，不会把侧边栏（进而整个外壳）带崩', () => {
  assert.deepEqual(normalizeNavPreferences(null).favorites, DEFAULT_FAVORITE_PANES)
  assert.deepEqual(normalizeNavPreferences('files').favorites, DEFAULT_FAVORITE_PANES)
  assert.deepEqual(normalizeNavPreferences({}).favorites, DEFAULT_FAVORITE_PANES)
  // favorites 不是数组 —— 旧格式或者被手改坏了
  assert.deepEqual(normalizeNavPreferences({ favorites: 'files' }).favorites, DEFAULT_FAVORITE_PANES)
})

test('认不出的面板名被丢掉，重复项只留第一次出现的', () => {
  assert.deepEqual(
    normalizeNavPreferences({ favorites: ['notes', 'not-a-pane', 'notes', 'files', 42] }).favorites,
    ['notes', 'files'],
  )
})

test('侧边栏里不存在的 pane 不能进常用（否则会造出点了不高亮的幽灵条目）', () => {
  // 清理套件的四个子标签在侧边栏被合并成了 'pcclean' 一项。
  assert.deepEqual(
    normalizeNavPreferences({ favorites: ['pccleanspace', 'pccleantoolbox', 'pcclean'] }).favorites,
    ['pcclean'],
  )
})

test('空的常用区是合法选择，不许被"好心"地填回默认值', () => {
  // 与 appearancePreferences 刻意相反（理由见 navPrefs.ts）：那边空集合表示「没选过」，这边空集合是真实用户意图；
  // 填回默认的话，用户移出最后一项会看到四个默认项重新长出来。
  assert.deepEqual(normalizeNavPreferences({ favorites: [] }).favorites, [])
})

test('增删改都不改动入参，没变化时原样返回同一个引用', () => {
  const base = ['files', 'notes']
  assert.deepEqual(addFavorite(base, 'passwords'), ['files', 'notes', 'passwords'])
  assert.deepEqual(base, ['files', 'notes'], '不许原地改调用方的数组')
  assert.equal(addFavorite(base, 'files'), base, '已经在里面就返回同一个引用')
  assert.equal(removeFavorite(base, 'ai'), base, '不在里面就返回同一个引用')
  assert.deepEqual(removeFavorite(base, 'files'), ['notes'])
})

test('拖拽排序把条目插到目标位置，越界的一端原样返回', () => {
  const base = ['files', 'notes', 'passwords', 'ai']
  assert.deepEqual(moveFavorite(base, 'ai', 'notes'), ['files', 'ai', 'notes', 'passwords'])
  assert.deepEqual(moveFavorite(base, 'files', 'ai'), ['notes', 'passwords', 'ai', 'files'])
  assert.equal(moveFavorite(base, 'files', 'files'), base)
  assert.equal(moveFavorite(base, 'files', 'network'), base, '目标不在列表里就别动')
})

// C2：常用区在界面上真的接上了

test('折叠态下常用区仍然渲染——不能做成"只有展开才有"', () => {
  // 把常用做成展开专属，等于对所有把侧边栏收起来的人不存在，而那正是最在意
  // 屏幕空间、也最需要快捷入口的一群人。
  const block = APP_SHELL.slice(
    APP_SHELL.indexOf("{favoriteItems.length > 0 && ("),
    APP_SHELL.indexOf("t('navAllHeading')"),
  )
  assert.ok(block.length > 0, '没找到常用区那一段渲染代码')
  assert.match(block, /navCollapsed\s*\?[\s\S]*?favoriteItems\.map/, '折叠态必须也铺一遍常用项')
  assert.match(block, /<SortableFavoriteRow/, '展开态走可拖拽的行')
})

test('常用区置顶：它排在 NAV_GROUPS 的渲染之前', () => {
  const favoritesAt = APP_SHELL.indexOf('{favoriteItems.length > 0 && (')
  const allGroupsAt = APP_SHELL.indexOf('{NAV_GROUPS.map((group) => (')
  assert.ok(favoritesAt > 0 && allGroupsAt > 0, '两段渲染代码都要在')
  assert.ok(favoritesAt < allGroupsAt, '常用区必须渲染在「全部功能」之前')
})

test('拖拽把手和加/移出按钮都有 aria-label，键盘能到达', () => {
  assert.match(APP_SHELL, /aria-label=\{dragLabel\}/, '拖拽把手要有 aria-label')
  assert.match(APP_SHELL, /navReorderFavorite/, '把手的说明文案要讲清键盘怎么用')
  assert.match(APP_SHELL, /aria-label=\{label\}[\s\S]{0,120}?aria-pressed=\{isFavorite\}/)
  // KeyboardSensor 就是拖拽的键盘替代路径（空格拿起、方向键移动、空格放下）。
  // 少了它，排序就变成一个纯鼠标功能。
  assert.match(APP_SHELL, /useSensor\(KeyboardSensor, \{ coordinateGetter: sortableKeyboardCoordinates \}\)/)
})

test('首屏是文件加解密面板', () => {
  assert.match(APP_SHELL, /useState<Pane>\('files'\)/, '进 app 的第一屏必须是主功能')
})

// D1-c：传给命令面板的 props 必须引用稳定

test('NAV_GROUPS / 深链 / handleNavClick 都记忆化了，命令面板的 useMemo 才有意义', () => {
  // CommandPalette.tsx 里 `useMemo(..., [deepLinks, navGroups])` 的依赖就是这两个
  // 引用。它们每次 render 都新建的话，那个 useMemo 从来没有生效过。
  assert.match(APP_SHELL, /const NAV_GROUPS: NavGroup\[\] = useMemo\(/)
  assert.match(APP_SHELL, /\], \[t, tClean\]\)/, 'NAV_GROUPS 的依赖是两个翻译函数')
  assert.match(APP_SHELL, /const PCCLEAN_DEEP_LINKS: NavItem\[\] = useMemo\(/)
  assert.match(APP_SHELL, /const handleNavClick = useCallback\(/)
})

// D1-a：两张长列表虚拟化，按稳定 key 记测量缓存

test('批量队列与残留清单都走虚拟化，getItemKey 按 id/path 而不是下标', () => {
  // 按下标记测量缓存的坑见 tests/clipboardVirtualRows.test.mjs：列表一重排，
  // 行高就记到别人身上，偏移全错，表现是行叠在一起。
  assert.match(
    FILES,
    /getItemKey: useCallback\(\(index: number\) => queueRows\[index\]\?\.key \?\? index, \[queueRows\]\)/,
    '队列虚拟列表要按 QueueItemState.key 取键',
  )
  assert.match(
    FILES,
    /getItemKey: useCallback\(\(index: number\) => remnantRows\[index\]\?\.path \?\? index, \[remnantRows\]\)/,
    '残留清单要按 path 取键',
  )
  // 空列表喂常量数组：`?? []` 每次渲染都是新数组，会让上面两个 useCallback
  // 每次失效，虚拟化器的测量缓存被反复丢弃。
  assert.match(FILES, /const EMPTY_QUEUE: QueueItemState\[\] = \[\]/)
  assert.match(FILES, /const EMPTY_REMNANTS: RemnantItem\[\] = \[\]/)
})

test('两个行组件都是 memo 的——否则虚拟化只解决了一半', () => {
  assert.match(FILES, /const QueueRow = memo\(function QueueRow\(/)
  assert.match(FILES, /const RemnantRow = memo\(function RemnantRow\(/)
})

test('进度事件只替换命中那一项，不再全量重建队列数组', () => {
  // 旧写法 `qs.map(...)` 让每来一条进度事件就给队列里**每一项**换一个新对象，
  // 于是整表重渲。一千个文件的批量加密里进度事件是每秒几十条的量级。
  const handler = FILES.slice(
    FILES.indexOf('const unsubscribe = vaultApi.onProgress((payload) => {'),
    FILES.indexOf('function patchQueueItem'),
  )
  assert.ok(handler.length > 0, '没找到进度订阅那一段')
  assert.match(handler, /const next = qs\.slice\(\)/, '只换命中那一项，其余保持原引用')
  // 去掉注释再判——那段注释本身就在讲"以前这里是 qs.map(...)"。
  const handlerCode = handler.replace(/^\s*\/\/.*$/gm, '')
  assert.doesNotMatch(handlerCode, /qs\.map\(/, '不许退回全量 map 重建')
  // 值没变就别更新：后端在同一个块上会重复报同一个百分比。
  assert.match(handler, /current\.chunkDone === payload\.done/)
})

test('残留清单的选中态是 Set，不是每勾一次就重建的对象', () => {
  assert.match(FILES, /useState<ReadonlySet<string>>\(\(\) => new Set\(\)\)/)
  assert.doesNotMatch(
    FILES,
    /setRemnantSelected\(\(s\) => \(\{ \.\.\.s,/,
    '不许退回 `{...s, [path]: v}` —— 那会让每勾一条都重渲整张清单',
  )
})

// D1-b：串行 IPC 改有上限的并发

test('读容器头部一律走带上限的并发，不再顺序 await', () => {
  assert.match(FILES, /const HEADER_READ_CONCURRENCY = 16/)
  // 五处调用点：残留扫描、多文件解密预检、文件夹解密的 kind 判定、完整性校验的首轮和补口令后的第二轮。
  // 定义处 `mapWithConcurrency<T, R>(` 带泛型参数，不会被这个模式数进来。
  assert.match(FILES, /async function mapWithConcurrency<T, R>\(/, '并发助手本体要在')
  const calls = FILES.match(/mapWithConcurrency\(/g) ?? []
  assert.equal(calls.length, 5, `批量读头部 / 校验的调用点都要走并发助手，实际 ${calls.length}`)
  assert.match(FILES, /mapWithConcurrency\([\s\S]{0,120}?VERIFY_CONCURRENCY/, '校验有自己的并发上限')
  assert.doesNotMatch(
    FILES,
    /for \(const p of ivaultPaths\) \{[\s\S]{0,120}?await vaultApi\.call\('read_header'/,
    '残留扫描不许退回顺序 await',
  )
  // 上限存在的意义：裸 Promise.all 等于"选多少个就同时发多少个 RPC"。
  assert.match(FILES, /Math\.min\(limit, items\.length\)/)
})

test('并发读结果按输入顺序消费——否则文件名会串', () => {
  // mapWithConcurrency 保证返回顺序 = 输入顺序，调用方靠下标把结果对回原路径。
  assert.match(FILES, /const out = new Array<R>\(items\.length\)/)
  assert.match(FILES, /out\[i\] = await fn\(items\[i\], i\)/)
})

test('残留扫描读头部时有进度反馈，不再是一段说不清多久的静默', () => {
  const scan = FILES.slice(FILES.indexOf('async function handleScanRemnants'), FILES.indexOf('const showProgress ='))
  assert.ok(scan.length > 0, '没找到 handleScanRemnants')
  assert.match(scan, /setQueueItems\(/, '要复用批量队列面板显示进度')
  assert.match(scan, /setBusyLabel\(/)
})

// D1-c：跨设备面板的定时器

test('两段秒级倒计时与延迟轮询合成一个定时器，并且切到后台就不刷', () => {
  // 各挂一个 setInterval 等于让这个两千多行的组件每秒重渲三次，而且三次的
  // 时刻还是错开的。
  const timers = CROSS_DEVICE.match(/setInterval\(/g) ?? []
  assert.ok(timers.length <= 4, `跨设备面板的定时器不该超过 4 个，实际 ${timers.length}`)
  const countdown = CROSS_DEVICE.slice(
    CROSS_DEVICE.indexOf('if (!shortCode && !myCode) {'),
    CROSS_DEVICE.indexOf('}, [shortCode, myCode, available, refresh])'),
  )
  assert.ok(countdown.length > 0, '没找到合并后的倒计时 effect')
  assert.match(countdown, /document\.visibilityState !== 'visible'/, '不可见就不 setState')
  assert.match(countdown, /addEventListener\('visibilitychange'/, '回到前台要立刻补一次 tick')
  assert.match(countdown, /void refresh\(\)/, '链路延迟轮询要并入这同一个定时器，不能另起一个')
})

test('附近设备的两条轮询都带可见性防护', () => {
  const nearby = CROSS_DEVICE.slice(
    CROSS_DEVICE.indexOf("if (pairTab !== 'nearby' || !available) return"),
    CROSS_DEVICE.indexOf('}, [pairTab, available, refreshNearby])'),
  )
  assert.ok(nearby.length > 0, '没找到附近设备的轮询 effect')
  assert.equal(
    (nearby.match(/document\.visibilityState === 'visible'/g) ?? []).length,
    2,
    '被动刷新和主动扫描都要看可见性——最小化之后不该继续往全网段打单播包',
  )
})
