import test from 'node:test'
import assert from 'node:assert/strict'
import { computeHealthScore } from '../src/lib/healthScore.ts'

// 分数是首屏第一个数字，用户当结论看，必须满足三条，缺一就不该显示：
// ① 确定性：同样机器状态永远同分（无随机、无时间依赖）；② 有界：始终在 0~100；
// ③ 可解释：每一分都能追到扣分项，扣分之和 = 100 − 分数。

function item(over = {}) {
  return {
    item_id: over.item_id ?? Math.random().toString(36).slice(2),
    category: 'junk',
    label: 'x',
    size_bytes: 0,
    path: '',
    importance: 'optional',
    reason: '',
    locked: false,
    default_selected: true,
    detail: {},
    ...over,
  }
}

const GB = 1024 ** 3

test('干净的机器得满分', () => {
  const r = computeHealthScore([], null)
  assert.equal(r.score, 100)
  assert.deepEqual(r.penalties, [])
  assert.equal(r.tone, 'success')
})

test('同样的输入永远得同一个分', () => {
  const items = [
    item({ item_id: 'a', size_bytes: 3 * GB }),
    item({ item_id: 'b', importance: 'junk', category: 'plugins', size_bytes: 0 }),
    item({ item_id: 'c', category: 'privacy', size_bytes: 1024 }),
  ]
  const mem = { load_percent: 88, used_bytes: 1, total_bytes: 2, cache_bytes: 0 }
  const first = computeHealthScore(items, mem)
  for (let i = 0; i < 20; i += 1) {
    const again = computeHealthScore(items, mem)
    assert.equal(again.score, first.score, '同样输入得出了不同的分数——里面有随机或时间依赖')
    assert.deepEqual(again.penalties, first.penalties)
  }
})

test('分数永远落在 0~100，再脏也不会出负数', () => {
  // 一台被塞满的机器：500 GB 可释放、200 个推广垃圾、80 个自启、内存 99%。
  const items = [
    item({ item_id: 'big', size_bytes: 500 * GB }),
    ...Array.from({ length: 200 }, (_, i) =>
      item({ item_id: `j${i}`, importance: 'junk', category: 'plugins' })),
    ...Array.from({ length: 80 }, (_, i) =>
      item({ item_id: `s${i}`, category: 'startup', default_selected: false })),
    ...Array.from({ length: 90 }, (_, i) => item({ item_id: `p${i}`, category: 'privacy' })),
  ]
  const r = computeHealthScore(items, {
    load_percent: 99, used_bytes: 1, total_bytes: 2, cache_bytes: 0,
  })
  assert.ok(r.score >= 0, `分数是 ${r.score}，跌破了 0`)
  assert.ok(r.score <= 100)
  assert.equal(r.tone, 'danger')
})

test('扣分之和正好等于 100 减去分数 —— 没有隐藏扣分项', () => {
  // 这条拦的是"分数低了但列不出原因"。用户看到 62 分却只能找到 −10，
  // 剩下的 28 分去哪了没人说得清，那个数字就不可信了。
  const items = [
    item({ item_id: 'a', size_bytes: 2 * GB }),
    item({ item_id: 'b', importance: 'junk', category: 'plugins' }),
    ...Array.from({ length: 20 }, (_, i) =>
      item({ item_id: `s${i}`, category: 'startup', default_selected: false })),
    item({ item_id: 'p1', category: 'privacy' }),
    item({ item_id: 'p2', category: 'privacy' }),
  ]
  const r = computeHealthScore(items, {
    load_percent: 90, used_bytes: 1, total_bytes: 2, cache_bytes: 0,
  })
  const sum = r.penalties.reduce((n, p) => n + p.points, 0)
  assert.equal(sum, 100 - r.score, `列出来的扣分 ${sum} 对不上实际扣掉的 ${100 - r.score}`)
  assert.ok(r.penalties.every((p) => p.points > 0), '不许出现 0 分的扣分项——那是噪声')
})

test('扣分项按严重程度降序，最该先修的排最前', () => {
  const items = [
    item({ item_id: 'a', size_bytes: 15 * GB }),
    item({ item_id: 'p1', category: 'privacy' }),
  ]
  const r = computeHealthScore(items, null)
  for (let i = 1; i < r.penalties.length; i += 1) {
    assert.ok(
      r.penalties[i - 1].points >= r.penalties[i].points,
      '扣分项没有按分数降序——用户会先看到最不重要的那条',
    )
  }
})

test('日常的内存占用不扣分', () => {
  // 现代系统会主动拿空闲内存做缓存，"用得多"本身不是病。
  // 60% 扣分的话，几乎每台机器都会平白丢十几分，分数就失去了区分度。
  const r = computeHealthScore([], {
    load_percent: 65, used_bytes: 1, total_bytes: 2, cache_bytes: 0,
  })
  assert.equal(r.score, 100)
})

test('少量开机自启不扣分', () => {
  // 输入法、显卡驱动、云盘 —— 一台正常使用的机器本来就有这么几项。
  const items = Array.from({ length: 6 }, (_, i) =>
    item({ item_id: `s${i}`, category: 'startup', default_selected: false }))
  assert.equal(computeHealthScore(items, null).score, 100)
})

test('锁死的条目不算进可释放空间', () => {
  // locked = 后端也会拒绝清理它。把它算进"可释放"等于承诺一件做不到的事。
  const items = [item({ item_id: 'l', size_bytes: 50 * GB, locked: true })]
  assert.equal(computeHealthScore(items, null).score, 100)
})
