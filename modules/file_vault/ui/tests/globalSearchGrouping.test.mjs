/**
 * 命令面板全局搜索结果分组。后端现返回全部命中（不再每模块 5 条），界面靠分组标题标真实总数并滚动渲染下一页，
 * 这建立在「分组不动顺序」上：笔记与剪贴板两段是 bm25 相关度排序，被重排则丢失相关度且不报错。
 * 跑法：`npm run test:update`
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { groupSearchResults, SEARCH_MODULE_ORDER } from '../src/lib/globalSearch.ts'

function result(module, id, label = `${module}-${id}`) {
  return { module, id, label }
}

test('分组顺序固定，不随后端返回顺序变', () => {
  // 故意把顺序打乱着喂进去：真实调用里后端是按 剪贴板→笔记→密码 拼的，但界面
  // 的分组顺序不该依赖那个巧合。
  const groups = groupSearchResults([
    result('passwords', 1),
    result('notes', 2),
    result('clipboard', 3),
  ])
  assert.deepEqual(
    groups.map((g) => g.module),
    SEARCH_MODULE_ORDER,
  )
})

test('分组内部保持后端给的原始顺序（bm25 相关度不能被重排掉）', () => {
  const groups = groupSearchResults([
    result('notes', 10),
    result('clipboard', 99),
    result('notes', 7),
    result('notes', 42),
  ])
  const notes = groups.find((g) => g.module === 'notes')
  assert.deepEqual(
    notes.items.map((item) => item.id),
    [10, 7, 42],
    '笔记结果的相对顺序变了——后端的 bm25 排序被丢掉了',
  )
})

test('空分组不返回，非空分组给出真实条数', () => {
  const many = Array.from({ length: 37 }, (_, i) => result('clipboard', i))
  const groups = groupSearchResults(many)
  assert.equal(groups.length, 1, '没有命中的模块不该占一个空壳分组')
  assert.equal(groups[0].module, 'clipboard')
  // 37 > 5：以前后端会把它截成 5 条，而界面上看不出被截过。分组给出的必须是全量。
  assert.equal(groups[0].items.length, 37)
})

test('没有结果时是空数组', () => {
  assert.deepEqual(groupSearchResults([]), [])
})
