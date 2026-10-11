import { useEffect, useRef, useState } from 'react'

import { markdownRenderer } from './markdownRenderer'
import MarkdownRenderWorker from './markdownWorker?worker&inline'
import type { MarkdownRenderResponse } from './markdownWorker'

// 小于此长度直接在主线程整篇渲染：实测约 0.00036 ms/字符，32KB ≈ 12ms 在一帧内，走异步只会闪烁。
const SYNC_RENDER_MAX_CHARS = 32 * 1024

// 进程内共用一个 Worker：预览面板反复挂载卸载，每次新开会累积大量线程与内联的 markdown-it 副本。
let sharedWorker: Worker | null = null
// Worker 起不来（CSP、环境、抛错）后不再重试，降级为同步整篇渲染，免得失败成本乘以挂载次数。
let workerUnavailable = false

function acquireWorker(): Worker | null {
  if (workerUnavailable) return null
  if (sharedWorker) return sharedWorker
  try {
    const worker = new MarkdownRenderWorker()
    worker.addEventListener('error', () => {
      workerUnavailable = true
      sharedWorker = null
      worker.terminate()
    })
    sharedWorker = worker
    return worker
  } catch {
    workerUnavailable = true
    return null
  }
}

export interface MarkdownHtmlState {
  /** 已经渲染好的块，按文档顺序。调用方按顺序追加即可。 */
  chunks: string[]
  /** 每换一份内容 +1。调用方靠它知道"该清空重来了"，而不是去比较数组内容。 */
  generation: number
  /** 还有块没渲染完。首块到位之后它仍可能是 true——那正是流式的正常状态。 */
  rendering: boolean
}

/**
 * 把 Markdown 渲染成 HTML，大文档在后台线程逐块渲染，首块到即上屏。
 * 返回块数组而非拼好的整串：拼串交给 dangerouslySetInnerHTML 会每块全量重解析，O(N²)；
 * 调用方按 `generation` 清空、按 `chunks.length` 增量追加，总成本 O(N)。
 */
export function useMarkdownHtml(content: string): MarkdownHtmlState {
  const [state, setState] = useState<MarkdownHtmlState>(() => ({
    chunks: content.length <= SYNC_RENDER_MAX_CHARS ? [markdownRenderer.render(content)] : [],
    generation: 0,
    rendering: content.length > SYNC_RENDER_MAX_CHARS,
  }))
  // 只认最后一次请求的结果。用户还在打字时前面几次渲染都已经过时了，回来晚了
  // 的那些必须丢掉——否则预览会在新旧内容之间来回跳。
  const latestRequestRef = useRef(0)

  useEffect(() => {
    const renderInline = () => {
      const id = (latestRequestRef.current += 1)
      setState((prev) => ({
        chunks: [markdownRenderer.render(content)],
        generation: prev.generation + 1,
        rendering: false,
      }))
      return id
    }

    if (content.length <= SYNC_RENDER_MAX_CHARS) {
      renderInline()
      return
    }

    const worker = acquireWorker()
    if (!worker) {
      renderInline()
      return
    }

    const requestId = (latestRequestRef.current += 1)
    let cancelled = false
    // 开一份新的：先清空，让调用方知道要重来。清空之后到首块到位之间会有一小段
    // 空白，但那正是"首屏 ms 级"要压缩的那段——它现在是几十毫秒，不是 1.4 秒。
    setState((prev) => ({ chunks: [], generation: prev.generation + 1, rendering: true }))

    function handleMessage(event: MessageEvent<MarkdownRenderResponse>) {
      const data = event.data
      if (cancelled || data.id !== latestRequestRef.current) return
      if (data.error !== undefined) {
        // Worker 渲染失败时在主线程整篇补渲染，不让预览停在半截内容上。
        // generation 必须一起 +1：调用方靠它判断清空重来，否则会既不重置也无从追加，屏幕永久停在出错前且不报错。
        setState((prev) => ({
          chunks: [markdownRenderer.render(content)],
          generation: prev.generation + 1,
          rendering: false,
        }))
        return
      }
      if (data.done) {
        setState((prev) => ({ ...prev, rendering: false }))
        return
      }
      if (data.html === undefined || data.index === undefined) return
      const { index, html } = data
      setState((prev) => {
        const chunks = prev.chunks.slice()
        chunks[index] = html
        return { ...prev, chunks }
      })
    }

    worker.addEventListener('message', handleMessage)
    worker.postMessage({ id: requestId, content })
    return () => {
      cancelled = true
      worker.removeEventListener('message', handleMessage)
    }
  }, [content])

  return state
}
