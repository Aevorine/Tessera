/**
 * 按行 LCS 对比，供「修改时间线」的「与当前版本对比」使用；自写是为避免引 diff 包的供应链审计与体积。
 * LCS 表为 旧行数×新行数，先剥掉首尾相同行；剩余格数超过 MAX_LCS_CELLS 则退化为整段删+整段加，
 * 并以 approximate 标出。
 */

export type DiffLineKind = 'same' | 'add' | 'del'

export interface DiffLine {
  kind: DiffLineKind
  text: string
  /** 在旧文本里是第几行（从 1 起）；新增的行没有。 */
  oldNo: number | null
  /** 在新文本里是第几行（从 1 起）；删除的行没有。 */
  newNo: number | null
}

export interface DiffResult {
  lines: DiffLine[]
  added: number
  removed: number
  /** 中间那段太大没做逐行对比，整段按删除 + 新增处理。 */
  approximate: boolean
}

/** 4M 格 × 4 字节 = 16 MiB 的表，是渲染进程里一次性分配还不至于卡顿的上限。 */
const MAX_LCS_CELLS = 4_000_000

function splitLines(text: string): string[] {
  // 换行风格不同（\r\n 与 \n）不算改动：同一篇笔记从 Windows 记事本导入、
  // 又在编辑器里保存过一次，逐行对比出来整篇都变红，那不是用户做的修改。
  return text.replace(/\r\n?/g, '\n').split('\n')
}

export function diffLines(oldText: string, newText: string): DiffResult {
  const a = splitLines(oldText)
  const b = splitLines(newText)

  let prefix = 0
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1
  let suffix = 0
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix += 1
  }

  const lines: DiffLine[] = []
  for (let i = 0; i < prefix; i += 1) lines.push({ kind: 'same', text: a[i], oldNo: i + 1, newNo: i + 1 })

  const midA = a.slice(prefix, a.length - suffix)
  const midB = b.slice(prefix, b.length - suffix)
  let approximate = false
  let added = 0
  let removed = 0

  const pushDel = (i: number) => {
    lines.push({ kind: 'del', text: midA[i], oldNo: prefix + i + 1, newNo: null })
    removed += 1
  }
  const pushAdd = (j: number) => {
    lines.push({ kind: 'add', text: midB[j], oldNo: null, newNo: prefix + j + 1 })
    added += 1
  }

  const n = midA.length
  const m = midB.length
  if (n > 0 && m > 0 && (n + 1) * (m + 1) <= MAX_LCS_CELLS) {
    // dp[i][j] = midA[i..] 与 midB[j..] 的 LCS 长度，从右下往左上填。
    const width = m + 1
    const dp = new Uint32Array((n + 1) * width)
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        dp[i * width + j] =
          midA[i] === midB[j]
            ? dp[(i + 1) * width + j + 1] + 1
            : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1])
      }
    }
    let i = 0
    let j = 0
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        lines.push({ kind: 'same', text: midA[i], oldNo: prefix + i + 1, newNo: prefix + j + 1 })
        i += 1
        j += 1
      } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
        pushDel(i)
        i += 1
      } else {
        pushAdd(j)
        j += 1
      }
    }
    while (i < n) pushDel(i++)
    while (j < m) pushAdd(j++)
  } else {
    approximate = n > 0 && m > 0
    for (let i = 0; i < n; i += 1) pushDel(i)
    for (let j = 0; j < m; j += 1) pushAdd(j)
  }

  for (let k = 0; k < suffix; k += 1) {
    const oi = a.length - suffix + k
    const ni = b.length - suffix + k
    lines.push({ kind: 'same', text: a[oi], oldNo: oi + 1, newNo: ni + 1 })
  }
  return { lines, added, removed, approximate }
}

export type DiffDisplayRow = DiffLine | { kind: 'skip'; count: number }

/** 只保留改动附近 context 行，其余相同行折成「省略 N 行」。 */
export function collapseUnchanged(lines: DiffLine[], context = 3): DiffDisplayRow[] {
  const keep = new Array<boolean>(lines.length).fill(false)
  lines.forEach((line, index) => {
    if (line.kind === 'same') return
    for (let k = Math.max(0, index - context); k <= Math.min(lines.length - 1, index + context); k += 1) keep[k] = true
  })
  const rows: DiffDisplayRow[] = []
  let skipped = 0
  lines.forEach((line, index) => {
    if (keep[index]) {
      if (skipped > 0) rows.push({ kind: 'skip', count: skipped })
      skipped = 0
      rows.push(line)
    } else {
      skipped += 1
    }
  })
  if (skipped > 0) rows.push({ kind: 'skip', count: skipped })
  return rows
}
