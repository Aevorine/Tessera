import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import test from 'node:test'

// 缺翻译键时界面直接显示键名（"crossdevice.scanLan"），且只在切到该语言时才看得到（日常用中文永远碰不到）；
// 六种语言乘几十个命名空间无法人眼比对，交给这几条。

const LOCALES_DIR = fileURLToPath(new URL('../src/i18n/locales', import.meta.url))
const REFERENCE = 'zh' // 中文是原文，其余五种照它翻
const langs = readdirSync(LOCALES_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)

/** 把嵌套对象拍平成 "a.b.c" 形式的键集合。有些命名空间是有嵌套的
 *  （crossdevice 的 state.*、diag.*），只比顶层键会漏掉里面缺的那些。 */
function flatKeys(obj, prefix = '') {
  const out = []
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object' && !Array.isArray(v)) out.push(...flatKeys(v, key))
    else out.push(key)
  }
  return out
}

/**
 * i18next 复数后缀。原规则要求六种语言键集完全相等是错的：各语言复数形式数量不同（英语 2、俄语 4、阿拉伯语 6、中文 1），
 * 严格相等等于禁止正确的复数。归一化后守卫不减：基名缺失照样报（那才是显示键名的成因）；
 * 另加一条：每个复数键在每种语言都必须有 `_other`，那是找不到具体词形时的回落，缺了照样露出键名。
 */
const PLURAL_SUFFIXES = ['_zero', '_one', '_two', '_few', '_many', '_other']

function stripPlural(key) {
  for (const suffix of PLURAL_SUFFIXES) {
    if (key.endsWith(suffix)) return key.slice(0, -suffix.length)
  }
  return key
}

function baseKeys(obj) {
  return [...new Set(flatKeys(obj).map(stripPlural))]
}

/** 用到了复数的基名（任一语言里出现过带后缀的写法）。 */
function pluralBases(obj) {
  return new Set(
    flatKeys(obj)
      .filter((k) => k !== stripPlural(k))
      .map(stripPlural),
  )
}

function load(lang, ns) {
  return JSON.parse(readFileSync(path.join(LOCALES_DIR, lang, ns), 'utf8'))
}

const namespaces = readdirSync(path.join(LOCALES_DIR, REFERENCE)).filter((f) => f.endsWith('.json'))

test('六种语言都在', () => {
  for (const lang of ['zh', 'en', 'fr', 'es', 'ru', 'ar']) {
    assert.ok(langs.includes(lang), `缺少语言目录 ${lang}`)
  }
})

test('每种语言的命名空间文件齐全', () => {
  for (const lang of langs) {
    const files = readdirSync(path.join(LOCALES_DIR, lang)).filter((f) => f.endsWith('.json'))
    assert.deepEqual(files.sort(), namespaces.slice().sort(), `${lang} 的命名空间文件跟 ${REFERENCE} 对不上`)
  }
})

test('每个命名空间在六种语言里的键完全一致（复数形式按语言各自的词形算）', () => {
  for (const ns of namespaces) {
    const reference = baseKeys(load(REFERENCE, ns)).sort()
    for (const lang of langs) {
      if (lang === REFERENCE) continue
      const actual = baseKeys(load(lang, ns)).sort()
      const missing = reference.filter((k) => !actual.includes(k))
      const extra = actual.filter((k) => !reference.includes(k))
      assert.equal(
        missing.length,
        0,
        `${lang}/${ns} 缺少键：${missing.slice(0, 8).join(', ')}${missing.length > 8 ? ` …共 ${missing.length} 个` : ''}`,
      )
      assert.equal(
        extra.length,
        0,
        `${lang}/${ns} 多出键：${extra.slice(0, 8).join(', ')}${extra.length > 8 ? ` …共 ${extra.length} 个` : ''}`,
      )
    }
  }
})

test('没有空文案', () => {
  // 空字符串比缺键更隐蔽：i18next 不会回落到默认值，界面上就是一片空白，
  // 看起来像"这里本来就没内容"。
  for (const ns of namespaces) {
    for (const lang of langs) {
      const flat = load(lang, ns)
      const walk = (obj, prefix = '') => {
        for (const [k, v] of Object.entries(obj)) {
          const key = prefix ? `${prefix}.${k}` : k
          if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, key)
          else {
            assert.equal(typeof v, 'string', `${lang}/${ns} 的 ${key} 不是字符串`)
            assert.ok(v.trim().length > 0, `${lang}/${ns} 的 ${key} 是空的`)
          }
        }
      }
      walk(flat)
    }
  }
})

test('插值占位符在各语言之间一致', () => {
  // {{count}} 在某种语言里被写成 {{cout}} 时，界面上会直接显示出那对花括号，
  // 而不是数字。翻译时最容易出的就是这一类错。
  const placeholders = (s) => [...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort()
  for (const ns of namespaces) {
    const ref = load(REFERENCE, ns)
    for (const lang of langs) {
      if (lang === REFERENCE) continue
      const other = load(lang, ns)
      const walk = (a, b, prefix = '') => {
        for (const [k, v] of Object.entries(a)) {
          const key = prefix ? `${prefix}.${k}` : k
          const bv = b?.[k]
          if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, bv, key)
          else if (typeof v === 'string' && typeof bv === 'string') {
            assert.deepEqual(
              placeholders(bv),
              placeholders(v),
              `${lang}/${ns} 的 ${key} 占位符跟原文对不上：原文 ${JSON.stringify(placeholders(v))}，译文 ${JSON.stringify(placeholders(bv))}`,
            )
          }
        }
      }
      walk(ref, other)
    }
  }
})

test('用了复数的键，每种语言都必须有 _other 那一份', () => {
  // i18next 找不到当前数量对应的词形时会回落到 `_other`。缺了它的表现跟
  // 缺整个键一样——界面上直接显示 `common.items_other` 这串原文，而且不报错。
  for (const ns of namespaces) {
    const bases = new Set()
    for (const lang of langs) {
      for (const base of pluralBases(load(lang, ns))) bases.add(base)
    }
    if (bases.size === 0) continue
    for (const lang of langs) {
      const keys = new Set(flatKeys(load(lang, ns)))
      for (const base of bases) {
        assert.ok(
          keys.has(`${base}_other`),
          `${lang}/${ns} 的复数键 ${base} 缺少 ${base}_other——界面会显示出键名本身`,
        )
      }
    }
  }
})
