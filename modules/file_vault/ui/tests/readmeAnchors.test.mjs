import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// README 目录是访客第一个会点的东西，标题改名而目录没改则点了不跳，不报错不留痕。
// 曾一次查出 10 条断链（"指纹解锁"改叫"生物识别解锁"等），六种语言全中；六份 README 共 200 多个标题，无法人工对锚点。

const REPO_ROOT = new URL('../../../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

/** GitHub 生成锚点的规则：小写、去掉标点、空格转连字符（连字符与下划线保留）。 */
function slug(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N} \-_]/gu, '')
    .replace(/ /g, '-')
}

function readmeFiles() {
  return readdirSync(REPO_ROOT).filter((f) => /^README(\.[\w-]+)?\.md$/.test(f))
}

test('六份 README 的站内锚点都指得到真实标题', () => {
  const files = readmeFiles()
  // 一份都没扫到多半是路径算错了。空输入判通过是"守卫看起来全绿其实没在守"
  // 最常见的形态，这里显式拦掉。
  assert.ok(files.length >= 6, `只找到 ${files.length} 份 README，路径可能算错了：${REPO_ROOT}`)

  const broken = []
  for (const name of files) {
    const src = readFileSync(join(REPO_ROOT, name), 'utf8')
    const anchors = new Set()
    for (const m of src.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)) anchors.add(slug(m[1]))
    assert.ok(anchors.size > 0, `${name} 里一个标题都没扫到`)
    for (const m of src.matchAll(/\[[^\]]*\]\(#([^)]+)\)/g)) {
      if (!anchors.has(m[1])) broken.push(`${name}: #${m[1]}`)
    }
  }
  assert.deepEqual(broken, [], '这些目录链接指向不存在的标题：\n' + broken.join('\n'))
})

test('六种语言的 README 都在，且互相链得到', () => {
  const files = readmeFiles()
  const expected = ['README.md', 'README.zh-CN.md', 'README.fr.md', 'README.es.md', 'README.ru.md', 'README.ar.md']
  for (const name of expected) {
    assert.ok(files.includes(name), `少了 ${name}`)
  }
  // 每一份的语言切换行都要能到达其余五份——少一条链接，那种语言的读者就走丢了。
  for (const name of expected) {
    const src = readFileSync(join(REPO_ROOT, name), 'utf8')
    for (const other of expected.filter((f) => f !== name)) {
      assert.ok(src.includes(`(${other})`), `${name} 里没有指向 ${other} 的链接`)
    }
  }
})
