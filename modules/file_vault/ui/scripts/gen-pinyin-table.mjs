// 从 Unicode Unihan 生成搜索用拼音表：通用规范汉字表(kTGHZ2013) ∪ GB2312(kGB0)，
// 读音取 kTGHZ2013 + kXHC1983 + kMandarin 并集，去声调；ü 同时记 v 与 u。
// 用法：node scripts/gen-pinyin-table.mjs <解压后的 Unihan 目录>
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = process.argv[2]
if (!dir) throw new Error('usage: gen-pinyin-table.mjs <Unihan dir>')
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'lib', 'search', 'pinyinTable.ts')

function fields(file, wanted) {
  const map = new Map()
  for (const line of readFileSync(path.join(dir, file), 'utf8').split('\n')) {
    if (!line.startsWith('U+')) continue
    const [cp, key, value] = line.trimEnd().split('\t')
    if (!wanted.has(key)) continue
    const ch = String.fromCodePoint(parseInt(cp.slice(2), 16))
    if (!map.has(ch)) map.set(ch, {})
    map.get(ch)[key] = value
  }
  return map
}

const readings = fields('Unihan_Readings.txt', new Set(['kTGHZ2013', 'kXHC1983', 'kMandarin']))
const gb = fields('Unihan_OtherMappings.txt', new Set(['kGB0']))

const DIAERESIS = String.fromCharCode(0x308)
// 去掉除分音符外的组合附加符（即声调）
const strip = (s) =>
  [...s.normalize('NFD')].filter((c) => c === DIAERESIS || c.charCodeAt(0) < 0x300 || c.charCodeAt(0) > 0x36f).join('')
function toneless(raw) {
  const s = strip(raw.toLowerCase())
  // ü 在 NFD 后是 u + U+0308
  const u = 'u' + DIAERESIS
  if (s.includes(u)) return [s.split(u).join('v'), s.split(u).join('u')]
  return [s]
}

const bySyllable = new Map()
let chars = 0
for (const [ch, f] of readings) {
  if (!f.kTGHZ2013 && !gb.has(ch)) continue
  const set = new Set()
  for (const part of `${f.kTGHZ2013 ?? ''} ${f.kXHC1983 ?? ''}`.split(' ')) {
    const r = part.split(':')[1]
    if (r) for (const t of toneless(r)) set.add(t)
  }
  for (const r of (f.kMandarin ?? '').split(' ')) if (r) for (const t of toneless(r)) set.add(t)
  const clean = [...set].filter((s) => /^[a-z]+$/.test(s))
  if (!clean.length) continue
  chars++
  for (const s of clean) {
    if (!bySyllable.has(s)) bySyllable.set(s, [])
    bySyllable.get(s).push(ch)
  }
}

const table = [...bySyllable.keys()].sort().map((s) => `${s}:${bySyllable.get(s).join('')}`).join('|')
writeFileSync(
  out,
  `// 由 scripts/gen-pinyin-table.mjs 从 Unicode Unihan 生成，勿手改。${chars} 字。\nexport const PINYIN_TABLE =\n  '${table}'\n`,
)
console.log(`chars=${chars} syllables=${bySyllable.size} bytes=${Buffer.byteLength(table)}`)
