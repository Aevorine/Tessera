/**
 * 剪贴板历史虚拟列表的两条不变量（「相邻图片显示重叠」的两个根因各一条）。
 * 只能在源码层守：DOM 里一切正常，仅 transform 的 Y 值算错，症状是画面行叠行。跑法：`npm run test:update`
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const SOURCE = readFileSync(
  fileURLToPath(new URL('../src/components/ClipboardScreen.tsx', import.meta.url)),
  'utf8',
)

test('虚拟列表按条目 id 记测量高度，不按下标', () => {
  // 根因一：measureElement 把行高存在 getItemKey(index) 上，默认 key 就是下标，而列表下标随时在动（复制新内容插到顶部），
  // 行高会套到别的条目上；start 是前面行高累加，一行记错后面全错。图片行与文字行高度差最大，最易暴露。
  assert.match(
    SOURCE,
    /getItemKey:\s*useCallback\(\s*\(index: number\)\s*=>\s*filtered\[index\]\?\.id/,
    'useVirtualizer 必须传 getItemKey，按 filtered[index].id 取键',
  )
  assert.match(
    SOURCE,
    /key=\{virtualRow\.key\}/,
    '行的 React key 要用 virtualRow.key，跟测量缓存的键同源',
  )
})

test('缩略图装在尺寸写死的框里，行高从第一帧起就是确定的', () => {
  // 根因二：裸 <img> 只写 max-h 时，解码完成前高度为 0，虚拟列表量到偏小的行高，加载后突然变高而前面偏移已按错值算过。
  // 缩略图统一压在 256×256 内，size-32 的框不会裁掉内容。
  const imgBlock = SOURCE.slice(
    SOURCE.indexOf("entry.content_type === 'image' && entry.thumbnail_path"),
    SOURCE.indexOf('sanitizedHtml !== null ?'),
  )
  assert.ok(imgBlock.length > 0, '没找到缩略图那一段渲染代码')
  assert.match(imgBlock, /className="[^"]*\bsize-32\b/, '缩略图外面要有一个尺寸写死的框')
  assert.doesNotMatch(
    imgBlock,
    /<img[^>]*className="max-h-48/,
    '不能退回"裸 img 只写 max-h"的写法——那正是加载前高度为 0 的来源',
  )
})
