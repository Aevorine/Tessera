// 翻译键两道检查：① 六种语言键集合必须一致；② 代码里 t('...') 用到的键必须存在。
// 第一道不够：`errors:common.unknown` 六种语言都缺，仍算「一致」，translateError
// 兜底会把键本身显示给用户，
// 不报错不崩溃，只有截图看得见。

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const LOCALES_DIR = join(ROOT, 'src/i18n/locales')
const languages = readdirSync(LOCALES_DIR)
let hasError = false

const namespaces = readdirSync(join(LOCALES_DIR, languages[0])).map((f) => f.replace('.json', ''))

/** 把嵌套 JSON 压成 `a.b.c`。errors.json 本身是扁平的带点号键，两种都要认。 */
function flatten(obj, prefix = '', out = new Set()) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix + k
    out.add(key)
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key + '.', out)
  }
  return out
}

/**
 * i18next 复数后缀：`t('x', { count })` 运行时解析成 `x_one`/`_other` 等（俄语四种、阿拉伯语六种）
 * ，文件里没有裸键，需认这套写法以免误报。
 */
const PLURAL_SUFFIXES = ['_zero', '_one', '_two', '_few', '_many', '_other']

function stripPlural(key) {
  for (const suffix of PLURAL_SUFFIXES) {
    if (key.endsWith(suffix)) return key.slice(0, -suffix.length)
  }
  return key
}

/** 键集里出现过的基名（复数键归到同一个基名下）。 */
function baseKeySet(keys) {
  return new Set([...keys].map(stripPlural))
}

/** ns -> lang -> Set<flattened key> */
const bundles = {}

for (const ns of namespaces) {
  const keysPerLang = {}
  for (const lang of languages) {
    const content = JSON.parse(readFileSync(join(LOCALES_DIR, lang, `${ns}.json`), 'utf-8'))
    keysPerLang[lang] = new Set(Object.keys(content))
    ;(bundles[ns] ??= {})[lang] = flatten(content)
  }
  // 按**基名**比对：各语言的复数词形数量本来就不一样（中文 1 种、
  // 英语 2 种、俄语 4 种、阿拉伯语 6 种），按完整键名比等于禁止正确的复数。
  const baseline = baseKeySet(keysPerLang[languages[0]])
  for (const lang of languages.slice(1)) {
    const actual = baseKeySet(keysPerLang[lang])
    const missing = [...baseline].filter((k) => !actual.has(k))
    const extra = [...actual].filter((k) => !baseline.has(k))
    if (missing.length > 0 || extra.length > 0) {
      hasError = true
      console.error(`[${ns}] ${lang}: missing=${JSON.stringify(missing)} extra=${JSON.stringify(extra)}`)
    }
  }
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) {
      if (entry !== 'node_modules' && entry !== 'locales') walk(p, out)
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(p)
    }
  }
  return out
}

const used = []
let dynamicCount = 0

/**
 * 找出「把 t 当参数收进来」的辅助函数正文范围，返回 [start, end) 区间，区间内的调用跳过。
 * 其体内的 t(...) 是调用方传入的（命名空间静态推不出），按文件的 useTranslation 查只会产生假阳性。
 */
function spansOfTAsParameter(text) {
  const spans = []
  for (const m of text.matchAll(/function\s+\w+\s*\(([^)]*)\)/g)) {
    if (!/(^|,)\s*t\s*[:,)]|(^|,)\s*t\s*$/.test(m[1])) continue
    const open = text.indexOf('{', m.index + m[0].length)
    if (open < 0) continue
    let depth = 0
    for (let i = open; i < text.length; i++) {
      if (text[i] === '{') depth++
      else if (text[i] === '}') {
        depth--
        if (depth === 0) {
          spans.push([open, i])
          break
        }
      }
    }
  }
  return spans
}

for (const file of walk(join(ROOT, 'src'))) {
  const raw = readFileSync(file, 'utf-8')
  // 注释里的 t('...') 往往是在讲一个**已经被删掉**的 bug，不该再报一遍。
  const text = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const skipSpans = spansOfTAsParameter(text)
  const inSkipped = (i) => skipSpans.some(([a, b]) => i >= a && i <= b)

  // 一个文件可能拿多个命名空间（t / t: tCommon），按变量名分别记账，否则会拿 tCommon
  // 的键去别的命名空间找而误报。
  const byVar = new Map()
  for (const m of text.matchAll(/useTranslation\(\s*'([^']+)'\s*\)/g)) {
    const before = text.slice(Math.max(0, m.index - 120), m.index)
    const alias = before.match(/\{\s*t\s*:\s*(\w+)\s*\}\s*=\s*$/)
    byVar.set(alias ? alias[1] : 't', m[1])
  }
  // i18n.t('errors:xxx') 这种直接用实例的写法也要认——translateError 就是它。
  byVar.set('__explicit__', null)

  for (const call of text.matchAll(/\b(\w+)\.?t?\(\s*'([a-zA-Z][\w.]*:[\w.]+)'/g)) {
    used.push({ file, key: call[2], explicit: true })
  }
  for (const call of text.matchAll(/\b(\w+)\(\s*'([^']+)'/g)) {
    const [, fn, key] = call
    if (!byVar.has(fn) || fn === '__explicit__') continue
    if (key.includes(':')) continue // 上面那一轮已经收过了
    if (fn === 't' && inSkipped(call.index)) continue // t 是形参，namespace 推不出来
    used.push({ file, ns: byVar.get(fn), key })
  }
  dynamicCount += [...text.matchAll(/\b(\w+)\(\s*`/g)].filter(([, fn]) => byVar.has(fn) && fn !== '__explicit__').length
}

const undefinedKeys = []
for (const u of used) {
  let ns = u.ns
  let bare = u.key
  const colon = bare.indexOf(':')
  if (colon > 0) {
    ns = bare.slice(0, colon)
    bare = bare.slice(colon + 1)
  }
  if (!ns || !bundles[ns]) continue // 不是翻译调用，或者命名空间不认识
  for (const lang of languages) {
    const has =
      bundles[ns][lang]?.has(bare) ||
      // 复数：代码写 `common.items`，文件是 `common.items_other`；该语言有任一词形即算有文案，缺
      // `_other` 由 tests/localeParity.test.mjs 守着。
      PLURAL_SUFFIXES.some((suffix) => bundles[ns][lang]?.has(bare + suffix))
    if (!has) {
      undefinedKeys.push(`${relative(ROOT, u.file)}  [${ns}/${lang}]  ${bare}`)
    }
  }
}

if (undefinedKeys.length > 0) {
  hasError = true
  console.error('代码里用到但没有文案的键（界面上会直接显示 key 本身）：')
  for (const line of undefinedKeys) console.error('  ' + line)
}

// 第三道：文案文件里不许有嵌套对象。i18n/index.ts 设了 keySeparator:false（错误码本身带点号），
// 嵌套文案运行时取不到，会回落到 defaultValue，把 `mdns_peers` 这样的原始 id
// 显示给用户（crossdevice.json 曾坏 18 个键）。
// 前两道看不出：第一道压平后六种语言一致；第二道管不到模板字符串拼出的键。
const nestedOffenders = []
for (const ns of namespaces) {
  for (const lang of languages) {
    const content = JSON.parse(readFileSync(join(LOCALES_DIR, lang, `${ns}.json`), 'utf-8'))
    for (const [k, v] of Object.entries(content)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        nestedOffenders.push(`${lang}/${ns}.json  ${k}  (含 ${Object.keys(v).length} 个取不到的子键)`)
      }
    }
  }
}

if (nestedOffenders.length > 0) {
  hasError = true
  console.error('文案文件里有嵌套对象，而 keySeparator:false 取不到它们（界面会显示原始 key）：')
  for (const line of nestedOffenders) console.error('  ' + line)
  console.error('  改法：压成带点号的扁平键，例如 "diag.lan_scan.info": "…"')
}

if (hasError) {
  console.error('i18n key consistency check FAILED')
  process.exit(1)
} else {
  console.log('i18n key consistency check passed - all languages have matching keys per namespace')
  console.log(`并且代码里所有静态 t('key') 都有文案（模板字符串形式 ${dynamicCount} 处，需人工确认）`)
}
