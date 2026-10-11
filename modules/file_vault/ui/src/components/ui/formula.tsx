import * as React from 'react'

import { cn } from '@/lib/utils'

// 数学/物理公式的唯一渲染口，避免同一个式子在两个界面写法不一（如 `log2` 与 `log₂`）。KaTeX 加字体
// 近 300 KB 而只出现在次要界面，故动态 import：不开带公式的界面就不下载，之后模块缓存、同步渲染。加
// 载完成前显示原始 TeX 源码（可读，且不让行高跳变）；渲染失败时保持该状态，不能让整页白屏。

type KatexModule = typeof import('katex')

let katexPromise: Promise<KatexModule['default']> | null = null

function loadKatex(): Promise<KatexModule['default']> {
  if (!katexPromise) {
    katexPromise = Promise.all([
      import('katex'),
      // 样式跟着同一个动态 import 走，Vite 才会把它切进同一个 chunk。
      // 放到文件顶端 import 的话它会被并进主样式表，延迟加载就白做了。
      import('katex/dist/katex.min.css'),
    ]).then(([mod]) => mod.default)
  }
  return katexPromise
}

/**
 * 一条公式。`display` 为 true 是独占一行居中的行间公式，false 嵌在句中的行内公式（分数会自动压扁）
 * ，这是 TeX 的两种标准排法。
 */
export function Formula({
  tex,
  display = false,
  /** 读屏软件念什么。公式的 DOM 是一堆定位过的碎片，直接念出来是噪音。 */
  label,
  className,
}: {
  tex: string
  display?: boolean
  label?: string
  className?: string
}) {
  const [html, setHtml] = React.useState<string | null>(null)

  React.useEffect(() => {
    let alive = true
    loadKatex()
      .then((katex) => {
        if (!alive) return
        setHtml(
          katex.renderToString(tex, {
            displayMode: display,
            // 写错的公式不许把整个界面炸掉：KaTeX 默认会抛，
            // 在 React 渲染树里抛出去就是一整块白屏。
            throwOnError: false,
            output: 'html',
            strict: false,
          }),
        )
      })
      .catch(() => {
        // 留在 TeX 源码状态。这条路径在断网、模块加载失败时会走到。
      })
    return () => {
      alive = false
    }
  }, [tex, display])

  const common = cn(display && 'my-2 block text-center', className)

  if (html === null) {
    return (
      <span className={cn(common, 'font-mono text-sm text-muted-foreground')} aria-label={label}>
        {tex}
      </span>
    )
  }
  return (
    <span
      className={common}
      role="math"
      aria-label={label}
      // 内容来自 KaTeX 自己的渲染结果，输入是本文件调用方写死的 TeX 常量，
      // 不含任何用户数据——不存在把用户输入当 HTML 执行的路径。
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

/** 应用里用到的公式集中定义：各界面引用同一个字符串常量，同一个量不会在两处写成两个样子。 */
export const FORMULAS = {
  /** 口令熵：字符集大小 N、长度 L。这是"这条密码有多难猜"的标准度量。 */
  passwordEntropy: 'H = L \\cdot \\log_2 N',
  /** 暴力破解期望时间：熵 H 比特、每秒尝试 R 次。 */
  crackTime: 't = \\frac{2^{H}}{2R}',
  /** 安全评分：每项检查的权重 w、得分 s。 */
  healthScore: '\\mathrm{Score} = 100 \\times \\frac{\\sum_i w_i s_i}{\\sum_i w_i}',
  /** 网络抖动：相邻两次往返时延之差的平均。 */
  jitter: 'J = \\frac{1}{n-1}\\sum_{i=2}^{n} \\left| t_i - t_{i-1} \\right|',
} as const
