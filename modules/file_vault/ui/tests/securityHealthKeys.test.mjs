import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// 体检页文案键全是拼出来的，check-i18n-keys.mjs 只认静态字面量查不到；漏键只会在界面
// 显示原始键名，tsc/eslint 都是绿的。这里从 security_health.py 抠键，逐语言核对。

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const PY = ROOT + '../security_health.py'
const LANGS = ['zh', 'en', 'fr', 'es', 'ru', 'ar']

function locale(lang) {
  return JSON.parse(readFileSync(`${ROOT}src/i18n/locales/${lang}/security.json`, 'utf8'))
}

const py = readFileSync(PY, 'utf8')

/** CHECKS 表里的 id，例如 Check("kdf", "vault", 12, _c_kdf) 里的 "kdf"。 */
function checkIds() {
  const table = /^CHECKS: List\[Check\] = \[([\s\S]*?)^\]/m.exec(py)
  assert.ok(table, 'security_health.py 里找不到 CHECKS 表')
  return [...table[1].matchAll(/Check\("([A-Za-z0-9]+)"/g)].map((m) => m[1])
}

/** 每个 _c_* 函数返回的 detail_key 字面量，例如 "kdf.legacy"。 */
function detailKeys() {
  return [...py.matchAll(/STATUS_\w+,\s*[\d.]+,\s*"([A-Za-z0-9.]+)"/g)].map((m) => m[1])
}

/** GRADE_BANDS 里的等级名，加上 evaluate() 里那个特判的 "unknown"。 */
function gradeNames() {
  const bands = /GRADE_BANDS = \[([\s\S]*?)\]/.exec(py)
  assert.ok(bands, '找不到 GRADE_BANDS')
  return [...bands[1].matchAll(/"([a-z]+)"/g)].map((m) => m[1]).concat('unknown')
}

test('CHECKS 表能被解析出来（否则下面几条都是空跑）', () => {
  const ids = checkIds()
  assert.ok(ids.length >= 10, `只解析出 ${ids.length} 个检查项，正则大概率跟代码漂移了`)
  assert.ok(ids.includes('recoveryKey'))
})

test('每个检查项在六种语言里都有标题和修复建议', () => {
  const ids = checkIds()
  for (const lang of LANGS) {
    const dict = locale(lang)
    for (const id of ids) {
      assert.ok(dict[`check.${id}.title`], `${lang}: 缺 check.${id}.title`)
      assert.ok(dict[`fix.${id}`], `${lang}: 缺 fix.${id}`)
    }
  }
})

test('每个检查项都有「查不到」时的说明', () => {
  // evaluate() 在检查函数返回 None 时发的 detail_key 是 `<id>.unknown`。
  // 这一档很容易被忘：本机上大部分项都测得到，开发时根本看不见它。
  const ids = checkIds()
  for (const lang of LANGS) {
    const dict = locale(lang)
    for (const id of ids) {
      assert.ok(dict[`detail.${id}.unknown`], `${lang}: 缺 detail.${id}.unknown`)
    }
  }
})

test('每个 detail_key 字面量在六种语言里都有文案', () => {
  const keys = detailKeys()
  assert.ok(keys.length >= 20, `只解析出 ${keys.length} 个 detail_key，正则大概率漂移了`)
  for (const lang of LANGS) {
    const dict = locale(lang)
    for (const key of keys) {
      assert.ok(dict[`detail.${key}`], `${lang}: 缺 detail.${key}`)
    }
  }
})

test('每个等级在六种语言里都有名字', () => {
  for (const lang of LANGS) {
    const dict = locale(lang)
    for (const grade of gradeNames()) {
      assert.ok(dict[`grade.${grade}`], `${lang}: 缺 grade.${grade}`)
    }
  }
})

test('权重表总和是 100——界面上写着「各项相加就是总分」', () => {
  const weights = [...py.matchAll(/Check\("[A-Za-z0-9]+",\s*"[a-z]+",\s*(\d+),/g)].map((m) =>
    Number(m[1]),
  )
  assert.ok(weights.length >= 10)
  assert.equal(
    weights.reduce((a, b) => a + b, 0),
    100,
    '权重和不是 100，界面上那句「把每一项的分加起来就是总分」就成了假话',
  )
})

test('文案键在六种语言之间完全一致', () => {
  // scripts/check-i18n-keys.mjs 已经做过一次，这里再做一次是因为**这个命名空间
  // 全是动态键**：某种语言少一个键时，用户看到的是原始 key 字符串而不是缺省文案。
  const reference = Object.keys(locale('en')).sort()
  for (const lang of LANGS) {
    assert.deepEqual(Object.keys(locale(lang)).sort(), reference, `${lang} 的键跟 en 对不上`)
  }
})
