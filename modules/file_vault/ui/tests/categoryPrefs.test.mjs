/**
 * 分类显示偏好的行为约束。起因：笔记默认分类（学习/工作/简历…）删不掉，预设硬编码在组件里每次渲染都合并回选项。
 * applyCategoryPrefs 是唯一决定「哪些分类出现、按什么顺序」的地方，这里直接断言该纯函数。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

// 直接 import .ts：测试脚本带 --experimental-strip-types（package.json 的 test:update），Node 自己剥类型；手写正则剥类型很脆弱。
import {
  applyCategoryPrefs,
  displayLabel,
  moveInOrder,
} from '../src/lib/categoryPrefs.ts'

const NAMES = ['工作', '学习', '生活', '简历', '课外活动', '工作/项目A']

test('删掉的预设不再出现（这正是用户报的"删不掉"）', () => {
  const out = applyCategoryPrefs(NAMES, { hidden: ['学习', '简历'], order: [], labels: {}, icons: {} })
  assert.ok(!out.includes('学习'), '学习 应当被隐藏')
  assert.ok(!out.includes('简历'), '简历 应当被隐藏')
  assert.ok(out.includes('工作'), '没被删的分类要保留')
})

test('隐藏顶层分类时，它的子分类跟着消失', () => {
  const out = applyCategoryPrefs(NAMES, { hidden: ['工作'], order: [], labels: {}, icons: {} })
  assert.ok(!out.includes('工作'), '工作 应当被隐藏')
  assert.ok(
    !out.includes('工作/项目A'),
    '父分类被隐藏后，子分类不该孤零零留在列表里',
  )
})

test('手动排序生效，没拖过的保持原有相对顺序并排在后面', () => {
  const out = applyCategoryPrefs(NAMES, {
    hidden: [],
    order: ['课外活动', '生活'],
    labels: {},
    icons: {},
  })
  assert.equal(out[0], '课外活动')
  assert.equal(out[1], '生活')
  // 其余按名称排序跟在后面，不会因为拖了两项就整体乱掉
  const rest = out.slice(2)
  assert.deepEqual(rest, rest.slice().sort((a, b) => a.localeCompare(b)))
})

test('改过的显示名生效，没改过的用原名', () => {
  const prefs = { hidden: [], order: [], labels: { 工作: '正职' }, icons: {} }
  assert.equal(displayLabel('工作', prefs), '正职')
  assert.equal(displayLabel('生活', prefs), '生活')
})

test('上移下移在边界处不越界', () => {
  const list = ['a', 'b', 'c']
  assert.deepEqual(moveInOrder(list, 'a', -1), ['a', 'b', 'c'], '第一项上移应当无变化')
  assert.deepEqual(moveInOrder(list, 'c', 1), ['a', 'b', 'c'], '最后一项下移应当无变化')
  assert.deepEqual(moveInOrder(list, 'b', -1), ['b', 'a', 'c'])
  assert.deepEqual(moveInOrder(list, 'b', 1), ['a', 'c', 'b'])
  assert.deepEqual(moveInOrder(list, '不存在', 1), ['a', 'b', 'c'], '未知项不该改动列表')
})
