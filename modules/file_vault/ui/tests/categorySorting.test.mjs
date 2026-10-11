/**
 * 笔记分类排序：四种模式 + 手动顺序不许被悄悄重排。
 * 曾有真 bug：applyCategoryPrefs 按用户拖的顺序返回，buildCategoryTree 却用 localeCompare 按字母重排，
 * 表现为「上移/下移没反应」且不报错。跑法：`npm run test:update`
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  applyCategoryPrefs,
  makeCategoryComparator,
  loadCategoryPrefs,
  CATEGORY_SORT_MODES,
} from '../src/lib/categoryPrefs.ts'

const NOTES_SOURCE = readFileSync(
  fileURLToPath(new URL('../src/components/NotesScreen.tsx', import.meta.url)),
  'utf8',
)

// buildCategoryTree 已搬到 lib/notes/noteFilters 以便直接单测，守卫要跟着代码走。
const NOTE_FILTERS_SOURCE = readFileSync(
  fileURLToPath(new URL('../src/lib/notes/noteFilters.ts', import.meta.url)),
  'utf8',
)

const BASE = { hidden: [], order: [], labels: {}, icons: {}, sortMode: 'custom' }

function stats(entries) {
  return new Map(Object.entries(entries).map(([k, v]) => [k, v]))
}

test('按名称：纯字母序', () => {
  const out = applyCategoryPrefs(['生活', '简历', '课外活动'], { ...BASE, sortMode: 'name' })
  assert.deepEqual(out, ['生活', '简历', '课外活动'].sort((a, b) => a.localeCompare(b)))
})

test('按笔记数：多的在前，数字相同按名称，缺统计的当 0', () => {
  const out = applyCategoryPrefs(
    ['简历', '生活', '账号资料', '其他'],
    { ...BASE, sortMode: 'count' },
    stats({ 简历: { count: 12, updatedAt: 1 }, 生活: { count: 3, updatedAt: 9 }, 账号资料: { count: 3, updatedAt: 2 } }),
  )
  // 12 > 3 = 3 > 0（"其他"没有统计）；两个 3 之间按名称定序，结果必须是确定的
  assert.equal(out[0], '简历')
  assert.equal(out[3], '其他')
  assert.deepEqual(out.slice(1, 3), ['生活', '账号资料'].sort((a, b) => a.localeCompare(b)))
})

test('按最近使用：时间戳大的在前', () => {
  const out = applyCategoryPrefs(
    ['简历', '生活', '其他'],
    { ...BASE, sortMode: 'recent' },
    stats({ 简历: { count: 1, updatedAt: 100 }, 生活: { count: 99, updatedAt: 500 }, 其他: { count: 5, updatedAt: 300 } }),
  )
  assert.deepEqual(out, ['生活', '其他', '简历'])
})

test('自定义：拖过的按拖的顺序在前，没拖过的按名称跟在后面', () => {
  const out = applyCategoryPrefs(
    ['其他', '生活', '简历', '课外活动'],
    { ...BASE, sortMode: 'custom', order: ['简历', '课外活动'] },
  )
  assert.deepEqual(out.slice(0, 2), ['简历', '课外活动'])
  assert.deepEqual(out.slice(2), ['其他', '生活'].sort((a, b) => a.localeCompare(b)))
})

test('切到自动排序不会清掉自定义顺序——切回来还在', () => {
  // 这是刻意的：自动排序是"临时换个角度看"，不该毁掉手工排过的结果。
  const prefs = { ...BASE, sortMode: 'name', order: ['简历', '课外活动'] }
  const byName = applyCategoryPrefs(['其他', '简历', '课外活动'], prefs)
  assert.deepEqual(byName, ['其他', '简历', '课外活动'].sort((a, b) => a.localeCompare(b)))
  const backToCustom = applyCategoryPrefs(['其他', '简历', '课外活动'], { ...prefs, sortMode: 'custom' })
  assert.deepEqual(backToCustom.slice(0, 2), ['简历', '课外活动'])
})

test('比较函数按全路径比，所以子分类之间用的是同一套规则', () => {
  const cmp = makeCategoryComparator(
    { ...BASE, sortMode: 'count' },
    stats({ '工作/甲': { count: 1, updatedAt: 0 }, '工作/乙': { count: 9, updatedAt: 0 } }),
  )
  assert.ok(cmp('工作/乙', '工作/甲') < 0, '笔记多的子分类应当排前面')
})

test('分类树不许自己按字母重排——那会把手动顺序悄悄吃掉', () => {
  // 修好前这里是 `nodes.sort((a, b) => a.segment.localeCompare(b.segment))`，
  // 于是上一条用例里排好的顺序在树里完全不生效。
  assert.match(
    NOTE_FILTERS_SOURCE,
    /nodes\.sort\(\(a, b\) => compare\(a\.fullPath, b\.fullPath\)\)/,
    'buildCategoryTree 必须用调用方给的 compare，不能自己 localeCompare',
  )
  // 只钉「comparator 有没有被传下去」，不钉第一个参数的写法，否则无关重构（如改成 scopedCategoryOptions）就误报；
  // 要守的性质是别把用户拖出的顺序按字母重排。
  assert.match(
    NOTES_SOURCE,
    /buildCategoryTree\([^)]*,\s*categoryComparator/,
    '筛选栏的树必须把 categoryComparator 传下去',
  )
})

test('旧的持久化内容没有 sortMode 字段时按 custom 读出来', () => {
  // 加这个功能之前存下来的偏好里没有 sortMode。落到 custom 正好等于旧行为
  // （有 order 就按 order，没有就按名称），升级上来的用户看不出任何变化。
  const store = new Map()
  globalThis.localStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, v),
  }
  store.set('ideal1-note-category-prefs', JSON.stringify({ hidden: [], order: ['简历'], labels: {}, icons: {} }))
  const prefs = loadCategoryPrefs()
  assert.equal(prefs.sortMode, 'custom')
  assert.deepEqual(prefs.order, ['简历'])
  delete globalThis.localStorage
})

test('四种模式都有名字可显示', () => {
  const zh = JSON.parse(
    readFileSync(fileURLToPath(new URL('../src/i18n/locales/zh/notes.json', import.meta.url)), 'utf8'),
  )
  for (const mode of CATEGORY_SORT_MODES) {
    assert.ok(zh[`categorySortMode.${mode}`], `缺文案 categorySortMode.${mode}`)
  }
})
