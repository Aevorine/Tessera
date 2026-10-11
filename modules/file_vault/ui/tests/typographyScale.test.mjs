import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// 字号只有三档：页面主标题 text-2xl（仅 <PageTitle>）、功能名称 text-sihao（仅 <FeatureTitle>）、
// 正文 text-sm（16px）。其余 text-lg/xl/3xl 都越界；确需超大字的在 ALLOWED 逐条列名并写理由。

const COMPONENTS_DIR = new URL('../src/components/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

/** 刻度外的字号。text-2xs 是徽章专用，已在 index.css 里定义为合法档位。 */
const OFF_SCALE = /\btext-(lg|xl|3xl|4xl|5xl)\b/g

/**
 * Tailwind 任意值字号 `text-[10px]` 等：按档位名匹配的 OFF_SCALE/BODY_SIZE_DRIFT 拦不住它，
 * 而它是实打实的小字号。只有长度单位才算字号，颜色（`text-[#fff]`）和对齐要排除。
 */
const ARBITRARY_TEXT = /\btext-\[([^\]]+)\]/g

/** 正文字号下限：16px = 1rem = 小四。见 index.css:14-23。 */
const MIN_BODY_PX = 16

/**
 * 把任意值解析成 px，认不出的（颜色、CSS 变量、百分比）返回 null 表示不归本守卫管。
 * rem/em 按 16px 折算，取较小根字号才保守（按 18.67 会让 0.9rem 蒙混过关）。
 */
function arbitraryFontSizePx(raw) {
  const value = raw.trim()
  const match = /^(-?[\d.]+)(px|rem|em|pt)$/.exec(value)
  if (!match) return null
  const n = Number(match[1])
  if (!Number.isFinite(n)) return null
  switch (match[2]) {
    case 'px': return n
    case 'pt': return (n * 4) / 3
    default: return n * 16
  }
}

/** 允许越界的地方：文件名 -> 允许次数 + 理由。次数写死，新增一处就挂，逼人来说明理由。 */
const ALLOWED = {
  // 四处都是人要逐位念/敲的数字：配对安全码（防中间人的最后一道，需肉眼比对）与 6 位配对码输入，
  // 字小了 6/8、0/O 会看混；用等宽加字距，与排版层级无关。
  'CrossDeviceScreen.tsx': 4,
  // 验证器 / 恢复密钥输入框：等宽 + 大字距，为的是让用户能一眼核对自己输对没有。
  'UnlockTabs.tsx': 2,
  // 渲染用户自己写的 Markdown。这是**内容**不是界面外壳——一篇长笔记里
  // 一级标题和二级标题必须能拉开层级，硬塞进界面那三档会让文章结构塌掉。
  'MarkdownPreview.tsx': 2,
  // HERO_VALUE_CLASS 的定义处，只此一处：清理套件首屏圆环里“可释放 6.4 GB”要最醒目。
  // 预算写死 1，别处只能引用常量，一页里不能出现两个“最重要的数字”。
  'page.tsx': 1,
}

/** 去掉注释再扫。否则连"别再写 text-lg"这句说明文字本身都会被判成违规。 */
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

test('所有界面的字号都留在三档刻度上（越界要在白名单里说明理由）', () => {
  const offenders = []
  for (const file of walk(COMPONENTS_DIR)) {
    const name = file.split(/[\\/]/).pop()
    const hits = (stripComments(readFileSync(file, 'utf8')).match(OFF_SCALE) ?? []).length
    const budget = ALLOWED[name] ?? 0
    if (hits > budget) offenders.push(`${name}: ${hits} 处越界字号，白名单只允许 ${budget} 处`)
  }
  assert.deepEqual(
    offenders,
    [],
    '出现了三档刻度以外的字号。请改用 <PageTitle>（页面主标题）或 <FeatureTitle>（功能名称，四号），' +
      '正文用 text-sm。确实必须超大字的，去 tests/typographyScale.test.mjs 的 ALLOWED 里加一条并写明理由。\n' +
      offenders.join('\n'),
  )
})

test('正文一律 text-sm（小四），界面里不许再出现 text-xs / text-base', () => {
  // 与上条方向相反：拦“名字写着小、实际被全局覆盖顶住”的字号。index.css 把 --text-xs 也顶成 1rem，
  // 所以 text-xs/text-base 今天看着同 text-sm，覆盖一旦移走会全部缩到 12px。
  // 规则：自己写的界面正文只用 text-sm。
  const BODY_SIZE_DRIFT = /\btext-(xs|base)\b/g
  const drifted = []
  for (const file of walk(COMPONENTS_DIR)) {
    const name = file.split(/[\\/]/).pop()
    const hits = (stripComments(readFileSync(file, 'utf8')).match(BODY_SIZE_DRIFT) ?? []).length
    if (hits > 0) drifted.push(`${name}: ${hits} 处 text-xs/text-base`)
  }
  assert.deepEqual(
    drifted,
    [],
    '正文字号只允许写 text-sm（= 1rem = 16px = 小四）。text-xs/text-base 现在看着一样大，' +
      '但那只是 index.css 的一条兜底覆盖顶着，覆盖一旦变动它们会集体缩水。\n' +
      '确实需要更小的装饰性文字（徽章之类）用 text-2xs。\n' +
      drifted.join('\n'),
  )
})

/**
 * 任意值字号的长期白名单：文件名 -> { 最小 px, 次数, 理由 }。次数写死是故意的。
 * 比正文小的场景用 `text-2xs`；仅留给尺寸由物理隐喻决定的键帽（kbd），并须写明 text-2xs 为何不行。
 */
const ARBITRARY_OK = {}

/**
 * 临时放行清单（“错的但还没轮到修”，区别于 ARBITRARY_OK）：这些文件正被并行修改，先立守卫再还债。
 * 数字是上限，修掉就改小，减到 0 删行，清单空了删常量；不断言必须等于实际处数，免得别人修好时误红。
 */
const TODO_ALLOWLIST = {
  // 聊天气泡的时间戳、模型名、token 计数、工具调用标签等一整条元信息行。
  // 这一处最多，也最该整条改成 text-2xs，而不是逐个把数字往上调。
  'AIChatScreen.tsx': 8,
  // 配对提示 + 传输速率角标。
  'CrossDeviceScreen.tsx': 2,
}

test(`任意值字号不许小于 ${MIN_BODY_PX}px（text-[10px] 这类原来完全没人拦）`, () => {
  const offenders = []
  for (const file of walk(COMPONENTS_DIR)) {
    const name = file.split(/[\\/]/).pop()
    const src = stripComments(readFileSync(file, 'utf8'))
    const tooSmall = []
    for (const match of src.matchAll(ARBITRARY_TEXT)) {
      const px = arbitraryFontSizePx(match[1])
      // null = 不是字号（颜色 / CSS 变量 / 百分比），不归这条守卫管。
      if (px === null || px >= MIN_BODY_PX) continue
      tooSmall.push(`${match[0]} ≈ ${px}px`)
    }
    if (tooSmall.length === 0) continue

    const allowed = ARBITRARY_OK[name]?.count ?? 0
    const todo = TODO_ALLOWLIST[name] ?? 0
    if (tooSmall.length <= allowed + todo) continue
    offenders.push(
      `${name}: ${tooSmall.length} 处小于 ${MIN_BODY_PX}px 的任意值字号，` +
        `白名单只允许 ${allowed + todo} 处 —— ${tooSmall.join('、')}`,
    )
  }

  assert.deepEqual(
    offenders,
    [],
    `正文字号下限是 ${MIN_BODY_PX}px（= 1rem = 小四，见 index.css:14-23）。\n` +
      'text-[10px] 这类任意值绕过了按档位名匹配的另外两条守卫，所以要单独拦。\n' +
      '改法：装饰性小字用 text-2xs（0.85rem，已在 index.css 里定义），正文用 text-sm。\n' +
      offenders.join('\n'),
  )
})

test('页面主标题只由 PageTitle 产出，不再各写各的', () => {
  // 手抄同一串类名正是上一轮「看起来统一、实则各写各的」的成因：抄错了没人
  // 看得出来，因为没有任何一处能拿来对照。
  const copied = []
  for (const file of walk(COMPONENTS_DIR)) {
    const src = stripComments(readFileSync(file, 'utf8'))
    const name = file.split(/[\\/]/).pop()
    if (name === 'page.tsx') continue // 三档的定义处本身
    if (/<h1\b/.test(src)) copied.push(`${name}: 直接写了 <h1>，应改用 <PageTitle>`)
    if (/text-2xl/.test(src)) copied.push(`${name}: 直接写了 text-2xl，应改用 <PageTitle>`)
  }
  assert.deepEqual(copied, [], copied.join('\n'))
})

test('页面标题栏只由 PageHeader 产出，不许各写各的容器', () => {
  // 这条守标题栏容器而非字号：三个面板各手抄了一份互不相同的标题栏 <div>（items/gap/pb 不同），
  // 都用 <PageTitle> 所以字号守卫全绿，表现为切面板时标题上下跳。
  const ALLOWED_PAGE_TITLE = new Set([
    'page.tsx', // 三档与 PageHeader 的定义处本身
    // 登录页是整屏居中的一张卡，没有侧栏也没有标题栏，套 PageHeader 反而怪。
    'LoginScreen.tsx',
  ])
  const rogue = []
  for (const file of walk(COMPONENTS_DIR)) {
    const name = file.split(/[\\/]/).pop()
    if (ALLOWED_PAGE_TITLE.has(name)) continue
    if (/<PageTitle\b/.test(stripComments(readFileSync(file, 'utf8')))) {
      rogue.push(`${name}: 自己拼了标题栏，应改用 <PageHeader icon title description actions>`)
    }
  }
  assert.deepEqual(rogue, [], rogue.join('\n'))
})

test('中西文字体族只在一处定义，界面里不许再各自覆盖', () => {
  // 西文 Times New Roman + 中文宋体靠 CSS 逐字符回退，顺序反了英文也变宋体；
  // 局部 font-family 覆盖会悄悄破坏它且只在单个界面显现。
  const css = readFileSync(new URL('../src/index.css', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), 'utf8')
  const stack = css.match(/--font-sans:\s*([^;]+);/)
  assert.ok(stack, 'index.css 里必须有 --font-sans')
  const value = stack[1]
  assert.ok(
    value.indexOf('Times New Roman') < value.indexOf('SimSun'),
    'Times New Roman 必须排在 SimSun 前面，否则英文也会被宋体渲染',
  )

  // 允许出现 fontFamily 的地方：日志/导出/编辑器字体选择——它们要么用的就是
  // 同一套字体栈，要么是用户自己选的。其余界面一律不许自带字体族。
  const FONT_OK = new Set(['DiagnosticLogSection.tsx', 'NoteEditor.tsx', 'NotesScreen.tsx', 'RecoveryCodesScreen.tsx'])
  const rogue = []
  for (const file of walk(COMPONENTS_DIR)) {
    const name = file.split(/[\\/]/).pop()
    if (FONT_OK.has(name)) continue
    if (/fontFamily|font-family/.test(stripComments(readFileSync(file, 'utf8')))) rogue.push(name)
  }
  assert.deepEqual(rogue, [], `这些界面自带了字体族，会破坏全局的中西文分流：${rogue.join(', ')}`)
})
