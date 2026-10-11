/**
 * 矩形树图布局数学，独立成文件以便测试直接 import 真实实现（不要去抠 .tsx 源码文本）。
 * 用 squarified 而非朴素切片：沿短边铺行并控制宽高比，块才不会又细又长。
 * 参考：Bruls, Huizing & van Wijk, "Squarified Treemaps" (2000)。
 */

export interface LaidOutRect {
  /** 在**传入数组**里的下标。调用方按它把标签贴回去。 */
  index: number
  x: number
  y: number
  w: number
  h: number
}

/** 一行里最差的宽高比。越接近 1 越方正。 */
function worstRatio(areas: number[], side: number): number {
  if (areas.length === 0 || side <= 0) return Infinity
  const sum = areas.reduce((a, b) => a + b, 0)
  if (sum <= 0) return Infinity
  const max = Math.max(...areas)
  const min = Math.min(...areas)
  const side2 = side * side
  const sum2 = sum * sum
  return Math.max((side2 * max) / sum2, sum2 / (side2 * min))
}

/** 把数值铺进 `w × h`。调用方必须先按降序排好；不排序不报错，只是布局变丑。 */
export function squarify(values: number[], w: number, h: number): LaidOutRect[] {
  const total = values.reduce((a, b) => a + b, 0)
  // 全零输入必须返回空数组，硬算会得到 NaN 坐标，渲染成空白而非「空目录」。
  if (total <= 0 || w <= 0 || h <= 0) return []

  const out: LaidOutRect[] = []
  let remaining = values.map((value, index) => ({ value, index }))
  let x = 0
  let y = 0
  let cw = w
  let ch = h

  while (remaining.length > 0) {
    // 逐行按剩余面积重算比例尺：与全局比例尺在数学上等价、精度无差别，
    // 保留只因对「剩余量为 0」的退化情况天然安全。
    const remainingTotal = remaining.reduce((a, r) => a + r.value, 0)
    if (remainingTotal <= 0) break
    const scale = (cw * ch) / remainingTotal
    const side = Math.min(cw, ch)

    const row: { value: number; index: number }[] = []
    let best = Infinity
    while (remaining.length > 0) {
      const candidate = [...row, remaining[0]].map((r) => r.value * scale)
      const ratio = worstRatio(candidate, side)
      if (row.length > 0 && ratio > best) break
      best = ratio
      row.push(remaining[0])
      remaining = remaining.slice(1)
    }

    const rowArea = row.reduce((a, r) => a + r.value * scale, 0)
    const thickness = side > 0 ? rowArea / side : 0
    let offset = 0
    for (const entry of row) {
      const length = thickness > 0 ? (entry.value * scale) / thickness : 0
      out.push(
        cw >= ch
          ? { index: entry.index, x, y: y + offset, w: thickness, h: length }
          : { index: entry.index, x: x + offset, y, w: length, h: thickness },
      )
      offset += length
    }

    if (cw >= ch) {
      x += thickness
      cw -= thickness
    } else {
      y += thickness
      ch -= thickness
    }
    if (cw <= 0.001 || ch <= 0.001) break
  }

  return out
}
