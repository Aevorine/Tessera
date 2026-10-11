import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// 守卫分类管理弹窗的顺序：用户真正要做的（建分类、改关键词、删分类、一键重新分类）须在前，
// 预设分类的图标/改名/隐藏（调一次就不碰的外观偏好）在后。顺序极易被往末尾追加破坏，且功能与测试全绿，只能钉在这里。

const SRC = readFileSync(new URL('../src/components/NotesScreen.tsx', import.meta.url), 'utf8')

/** 取分类管理弹窗那一段，避免匹配到文件里别处的同名组件调用。 */
function categoryDialogBody() {
  const start = SRC.indexOf('<Dialog open={categoryManagerOpen}')
  assert.ok(start > 0, '找不到分类管理弹窗')
  const end = SRC.indexOf('</Dialog>', start)
  assert.ok(end > start, '分类管理弹窗没有闭合')
  return SRC.slice(start, end)
}

test('分类管理弹窗把「管理分类」放在第一屏，外观偏好放最后', () => {
  const body = categoryDialogBody()
  const manage = body.indexOf('<CategoryManagerSection')
  const reclassify = body.indexOf('reclassifyPreviewButton')
  const preset = body.indexOf('<PresetCategorySection')

  assert.ok(manage > 0 && reclassify > 0 && preset > 0, '三个区块都得在')
  assert.ok(
    manage < preset,
    '「管理分类」必须排在「预设分类外观」前面——用户点开「分类管理」是来建/改/删分类的，' +
      '不是来换图标的',
  )
  assert.ok(
    reclassify < preset,
    '「一键重新分类」是这个弹窗里唯一会批量改动已有笔记的动作，价值最高，' +
      '不能又被压到外观偏好后面',
  )
})

test('分类管理里的分区标题走四号刻度，不跟正文同一档', () => {
  // 原来三个分区标题都是 text-sm font-medium ——跟正文一模一样大，分区之间
  // 完全没有层级，一眼看过去是一整片灰字。
  for (const key of ['{label}', "t('categoryDisplayLabel')", "t('hiddenCategoriesLabel')"]) {
    const pattern = new RegExp(`<FeatureTitle as="p">\\{?${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\}?</FeatureTitle>`)
    assert.match(SRC, pattern, `分区标题 ${key} 应该用 <FeatureTitle>（四号），而不是 text-sm`)
  }
})
