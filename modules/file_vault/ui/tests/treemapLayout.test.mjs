import assert from 'node:assert/strict'
import test from 'node:test'

import { squarify } from '../src/lib/treemapLayout.ts'

/** 树图布局的性质守卫：面积正比、不重叠、不出画布、不丢块；不断言具体坐标，免得算法微调误报。 */

/** squarify 要求调用方先降序排好，测试里统一走这个包装避免每处都写一遍。 */
function layout(values) {
  const sorted = [...values].sort((a, b) => b - a)
  return squarify(sorted, 100, 100).map((r) => ({ ...r, value: sorted[r.index] }))
}

test('every rectangle has an area proportional to its value', () => {
  const values = [50, 25, 15, 10]
  const rects = layout(values)
  assert.equal(rects.length, values.length, '一块都不能丢')

  const total = values.reduce((a, b) => a + b, 0)
  for (const rect of rects) {
    const area = rect.w * rect.h
    const expected = (rect.value / total) * 100 * 100
    assert.ok(
      Math.abs(area - expected) / expected < 0.02,
      `面积 ${area.toFixed(1)} 与应有的 ${expected.toFixed(1)} 差太多`,
    )
  }
})

test('rectangles never overlap and never leave the canvas', () => {
  const rects = layout([40, 30, 20, 6, 3, 1])
  for (const rect of rects) {
    assert.ok(rect.x >= -0.01 && rect.y >= -0.01, '不能跑到画布外面')
    assert.ok(rect.x + rect.w <= 100.01, '不能超出右边')
    assert.ok(rect.y + rect.h <= 100.01, '不能超出下边')
    assert.ok(rect.w > 0 && rect.h > 0, '宽高必须为正——负的会渲染成看不见的线')
  }
  for (let a = 0; a < rects.length; a += 1) {
    for (let b = a + 1; b < rects.length; b += 1) {
      const p = rects[a]
      const q = rects[b]
      const disjoint =
        p.x + p.w <= q.x + 0.01 || q.x + q.w <= p.x + 0.01 ||
        p.y + p.h <= q.y + 0.01 || q.y + q.h <= p.y + 0.01
      assert.ok(disjoint, `块 ${a} 和 ${b} 叠在一起了`)
    }
  }
})

test('one dominant item does not squash the rest into slivers', () => {
  // 这正是要 squarified 而不是朴素切片的理由：朴素切片会把剩下的挤成又细又长
  // 的条，面积虽对但没法用眼睛比大小，而"一眼看出谁占得多"是树图存在的理由。
  const rects = layout([900, 40, 30, 20, 10])
  for (const rect of rects) {
    if (rect.value === 900) continue
    const ratio = Math.max(rect.w / rect.h, rect.h / rect.w)
    assert.ok(ratio < 30, `一块的宽高比 ${ratio.toFixed(1)}，细成一条线了`)
  }
})

test('a single item fills the whole canvas', () => {
  const rects = squarify([1], 100, 100)
  assert.equal(rects.length, 1)
  assert.ok(Math.abs(rects[0].w - 100) < 0.01 && Math.abs(rects[0].h - 100) < 0.01)
})

test('all-zero input returns nothing rather than NaN coordinates', () => {
  // 空目录、或所有子目录都读不到大小时会走到这里。硬算下去会得到 NaN 坐标，
  // 渲染出来是一整块空白——看起来像"这个目录没被统计到"，而不像"它是空的"。
  assert.deepEqual(squarify([0, 0], 100, 100), [])
  assert.deepEqual(squarify([], 100, 100), [])
  assert.deepEqual(squarify([5], 0, 100), [])
})

test('indices point back at the caller-supplied order', () => {
  // 调用方靠 index 把标签贴回去。错位的表现是每块标签都对应到别人的大小，
  // 而且不报错——这是最坏的一种错。
  const rects = squarify([70, 20, 10], 100, 100)
  assert.deepEqual(rects.map((r) => r.index).sort(), [0, 1, 2])
  const biggest = rects.find((r) => r.index === 0)
  const smallest = rects.find((r) => r.index === 2)
  assert.ok(biggest.w * biggest.h > smallest.w * smallest.h * 5)
})
