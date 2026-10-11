import { useEffect, useRef } from 'react'

import { cn } from '@/lib/utils'
import { useMarkdownHtml } from '@/lib/useMarkdownHtml'

// 预览用 markdown-it 而非 @codemirror/lang-markdown（后者只给源码视图做语法高亮，不产出 HTML）；选
// 它而非 marked/remark：GFM 扩展官方支持、纯 JS 无原生依赖、量级合适。项目没装
// @tailwindcss/typography，改用 Tailwind 任意值后代选择器手写排版，配色走 CSS 变量以跟随亮暗主题。
const MARKDOWN_PREVIEW_CLASS = cn(
  'max-w-none text-sm leading-relaxed text-foreground',
  '[&_h1]:mt-4 [&_h1]:mb-2 [&_h1]:text-xl [&_h1]:font-bold [&_h1]:first:mt-0',
  '[&_h2]:mt-4 [&_h2]:mb-2 [&_h2]:text-lg [&_h2]:font-bold [&_h2]:first:mt-0',
  '[&_h3]:mt-3 [&_h3]:mb-1.5 [&_h3]:text-sm [&_h3]:font-semibold',
  '[&_h4]:mt-3 [&_h4]:mb-1.5 [&_h4]:text-sm [&_h4]:font-semibold',
  '[&_p]:my-2',
  '[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5',
  '[&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5',
  '[&_li]:my-0.5',
  '[&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2',
  '[&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground',
  '[&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-sm',
  '[&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-muted [&_pre]:p-3',
  '[&_pre_code]:bg-transparent [&_pre_code]:p-0',
  '[&_hr]:my-4 [&_hr]:border-border',
  '[&_table]:my-2 [&_table]:w-full [&_table]:border-collapse',
  '[&_th]:border [&_th]:border-border [&_th]:px-2 [&_th]:py-1 [&_th]:text-left',
  '[&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1',
  '[&_img]:max-w-full',
)

// dangerouslySetInnerHTML 安全：markdownRenderer 设了 html:false，不透传原始 HTML，渲染的是
// markdown-it 转义后的输出。
export function MarkdownPreview({ content, className }: { content: string; className?: string }) {
  // 大文档在 Worker 里逐块渲染，这里按序贴进 DOM。用 insertAdjacentHTML 手动追加而非
  // dangerouslySetInnerHTML：整串重设每块都要重新解析全部 HTML（O(N²)）；每块包 <div> 会让
  // `[&_h1]:first:mt-0` 命中每块开头，块边界间距与整篇渲染不同。
  const { chunks, generation, rendering } = useMarkdownHtml(content)
  const hostRef = useRef<HTMLDivElement>(null)
  const appliedRef = useRef({ generation: -1, count: 0 })

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    if (appliedRef.current.generation !== generation) {
      // **新一版的首块没到之前，屏幕上继续留着旧内容。** 一换内容就清空的话，
      // 分屏编辑时每次防抖到期预览都会闪一下白——比慢半拍难受得多。
      if (chunks[0] === undefined) return
      host.innerHTML = chunks[0]
      appliedRef.current = { generation, count: 1 }
    }
    let next = appliedRef.current.count
    // 只追加"连续已到位"的块。Worker 是按顺序回的，正常情况下不会有空洞；
    // 真出现空洞就停在那里等，绝不跳过——跳过会让内容错位且看不出来。
    while (next < chunks.length && chunks[next] !== undefined) {
      host.insertAdjacentHTML('beforeend', chunks[next])
      next += 1
    }
    appliedRef.current.count = next
  }, [chunks, generation])

  return (
    <div className={cn('relative', className)}>
      <div ref={hostRef} className={MARKDOWN_PREVIEW_CLASS} />
      {/* 还在补后面的块时给一条底部提示。**不给整块降透明度**——流式渲染下
          大文档大部分时间都处在"还在补"的状态，整块发灰会一直发灰。 */}
      {rendering && (
        <div
          aria-hidden="true"
          className="pointer-events-none sticky bottom-0 h-6 bg-gradient-to-t from-background to-transparent"
        />
      )}
    </div>
  )
}

// React.lazy 只认默认导出；具名导出留着给可能的直接引用/用例。
export default MarkdownPreview
