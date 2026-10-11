import { useMemo } from 'react'

import { squarify } from '@/lib/treemapLayout'

/**
 * 矩形树图，面积即占比。自己写而不拉图表库（通用库几百 KB，渲染端已为懒加载重库费过力气）；
 * squarify 约四十行无依赖：沿短边一行行铺，每加一块看最差宽高比是否变糟，变糟就收行，
 * 朴素切片会产出又细又长的条。参考 Bruls, Huizing & van Wijk, "Squarified Treemaps" (2000)。
 */

export interface TreemapNode {
  key: string
  label: string
  value: number
  /** 0–1，用来决定这块的着色深浅。不给就按 value 在同批里的排名算。 */
  intensity?: number
}

export function Treemap({
  nodes,
  onSelect,
  formatValue,
  height = 320,
}: {
  nodes: TreemapNode[]
  onSelect?: (key: string) => void
  formatValue: (value: number) => string
  height?: number
}) {
  const rects = useMemo(() => {
    const usable = nodes.filter((n) => n.value > 0)
    if (usable.length === 0) return []
    // squarify 要求先按降序排好——不排不会报错，只是布局变难看。
    const sorted = [...usable].sort((a, b) => b.value - a.value)
    const laid = squarify(sorted.map((n) => n.value), 100, 100)
    const biggest = sorted[0].value
    return laid.map((r) => {
      const node = sorted[r.index]
      return {
        key: node.key,
        label: node.label,
        value: node.value,
        intensity: node.intensity ?? (biggest > 0 ? node.value / biggest : 0),
        x: r.x,
        y: r.y,
        w: r.w,
        h: r.h,
      }
    })
  }, [nodes])

  if (rects.length === 0) return null

  return (
    <div className="relative w-full overflow-hidden rounded-lg border border-border/70"
         style={{ height }}>
      {rects.map((rect) => {
        // 太小的块放不下任何文字。**仍然渲染它们**——留白会让人以为那部分
        // 空间没被统计到，而实际上是几百个小目录加起来的。
        const roomForLabel = rect.w > 12 && rect.h > 9
        return (
          <button
            key={rect.key}
            type="button"
            onClick={() => onSelect?.(rect.key)}
            title={`${rect.label} · ${formatValue(rect.value)}`}
            className="absolute overflow-hidden border border-background/60 px-2 py-1.5 text-left transition-opacity hover:opacity-80"
            style={{
              left: `${rect.x}%`,
              top: `${rect.y}%`,
              width: `${rect.w}%`,
              height: `${rect.h}%`,
              // 同一强调色的不同浓度，不给每块分配色相：这里颜色只表达一件事——这块有多大。
              backgroundColor: `color-mix(in oklab, var(--primary) ${Math.round(
                12 + rect.intensity * 55,
              )}%, var(--card))`,
            }}
          >
            {roomForLabel && (
              <>
                <span className="block truncate text-2xs font-medium leading-4">
                  {rect.label}
                </span>
                <span className="block truncate text-2xs leading-4 opacity-75 tabular">
                  {formatValue(rect.value)}
                </span>
              </>
            )}
          </button>
        )
      })}
    </div>
  )
}
