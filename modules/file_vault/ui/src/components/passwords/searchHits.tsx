import { Highlight } from '@/components/search/Highlight'
import { fold, type Range } from '@/lib/search'

/** 区间整体平移并裁到 [0, len)。 */
function shift(ranges: Range[] | undefined, by: number, len: number): Range[] | undefined {
  if (!ranges?.length) return undefined
  const out: Range[] = []
  for (const [s, e] of ranges) {
    const a = Math.max(0, s - by)
    const b = Math.min(len, e - by)
    if (b > a) out.push([a, b])
  }
  return out.length ? out : undefined
}

/** 行里只显示主机名时，把网址上的命中区间折算到主机名上。 */
export function HostHighlight({ url, host, ranges }: { url: string; host: string; ranges?: Range[] }) {
  if (!ranges?.length) return <>{host}</>
  const at = fold(url).indexOf(host)
  return <Highlight text={host} ranges={at < 0 ? undefined : shift(ranges, at, host.length)} />
}

const SNIPPET_BEFORE = 24
const SNIPPET_AFTER = 72

/** 命中落在备注里时，截命中附近一小段显示出来，否则看不出这一条为什么在结果里。 */
export function NoteSnippet({ notes, ranges }: { notes: string; ranges?: Range[] }) {
  if (!ranges?.length) return null
  const first = Math.min(...ranges.map((r) => r[0]))
  const from = Math.max(0, first - SNIPPET_BEFORE)
  const to = Math.min(notes.length, first + SNIPPET_AFTER)
  // 换行逐字换成空格，长度不变，区间下标仍对得上
  const text = notes.slice(from, to).replace(/\s/g, ' ')
  return (
    <p className="truncate text-sm text-muted-foreground">
      {from > 0 && '…'}
      <Highlight text={text} ranges={shift(ranges, from, text.length)} />
    </p>
  )
}
