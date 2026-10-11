import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_APPEARANCE_PREFERENCES,
  applyAppearancePreferences,
  normalizeAppearancePreferences,
} from '../src/lib/appearancePreferences.ts'

test('损坏或越界的外观偏好安全回退，不会阻断首屏', () => {
  assert.deepEqual(normalizeAppearancePreferences(null), DEFAULT_APPEARANCE_PREFERENCES)
  assert.deepEqual(
    normalizeAppearancePreferences({
      visualStyle: 'unknown',
      accent: 'purple',
      decoration: 99,
      selectedMetrics: 'cpu',
    }),
    DEFAULT_APPEARANCE_PREFERENCES,
  )
})

test('合法选项被保留，指标会去重并过滤未知值', () => {
  assert.deepEqual(
    normalizeAppearancePreferences({
      visualStyle: 'oriental-tech',
      accent: 'gold',
      decoration: 'standard',
      selectedMetrics: ['cpu', 'cpu', 'uptime', 'not-a-metric'],
    }),
    {
      visualStyle: 'oriental-tech',
      accent: 'gold',
      decoration: 'standard',
      // 输入缺 readingComfort（旧版本存下的偏好）时必须补默认值，否则 applyAppearancePreferences 会写出
      // `data-reading-comfort="undefined"`，CSS 选择器全不匹配。
      readingComfort: 'standard',
      selectedMetrics: ['cpu', 'uptime'],
    },
  )
})

test('至少保留一个指标，避免专业面板变成无提示空白', () => {
  const preferences = normalizeAppearancePreferences({
    visualStyle: 'native',
    accent: 'sky',
    decoration: 'off',
    selectedMetrics: [],
  })
  assert.deepEqual(preferences.selectedMetrics, DEFAULT_APPEARANCE_PREFERENCES.selectedMetrics)
})

test('外观应用只写受控 data 属性', () => {
  const attributes = new Map()
  const root = {
    dataset: {},
    setAttribute(name, value) {
      attributes.set(name, value)
    },
  }

  applyAppearancePreferences(root, {
    visualStyle: 'oriental-tech',
    accent: 'olive',
    decoration: 'subtle',
    readingComfort: 'warm',
    selectedMetrics: ['workingSet'],
  })

  assert.equal(attributes.get('data-visual-style'), 'oriental-tech')
  assert.equal(attributes.get('data-accent'), 'olive')
  assert.equal(attributes.get('data-decoration'), 'subtle')
  assert.equal(attributes.get('data-reading-comfort'), 'warm')
  assert.equal(attributes.has('style'), false)
})
