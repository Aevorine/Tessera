// Markdown → HTML 在 Web Worker 里逐块回传：markdown-it 渲染超线性（0.5MB 186ms … 8MB 3683ms），
// 远大于后端读取和 JSON.parse；逐块让首块几十毫秒上屏（切法见 markdownChunks.ts，宁可不切）。
// 复用 markdownRenderer 单例，不另 new：预览与 DOCX/PDF 导出必须同一套配置。
import { collectLinkDefinitions, splitMarkdownForStreaming } from './markdownChunks'
import { markdownRenderer } from './markdownRenderer'

export interface MarkdownRenderRequest {
  id: number
  content: string
}

/** 一次请求回多条：先 `total` 报块数，再每块 `index`+`html`，最后 `done`；出错回 `error`。都带同一 `id`，调用方据此丢弃过期结果。 */
export interface MarkdownRenderResponse {
  id: number
  total?: number
  index?: number
  html?: string
  done?: true
  error?: string
}

// 不改 tsconfig 的 lib 就拿到 worker 上下文的类型：只用到 onmessage 和
// postMessage 两个成员，按需断言比全局引入 webworker lib 影响面小得多。
const ctx = self as unknown as {
  onmessage: ((event: MessageEvent<MarkdownRenderRequest>) => void) | null
  postMessage(message: MarkdownRenderResponse): void
}

ctx.onmessage = (event) => {
  const { id, content } = event.data
  try {
    const chunks = splitMarkdownForStreaming(content)
    const definitions = chunks.length > 1 ? collectLinkDefinitions(content) : ''
    ctx.postMessage({ id, total: chunks.length })
    for (let index = 0; index < chunks.length; index++) {
      // 链接引用定义可以写在文档任何位置、被任何位置引用。切块之后"定义在后面、
      // 引用在前面"就会渲染成纯文本——不报错，只是链接没了。所以每块都补一份。
      const source = definitions ? `${chunks[index]}\n\n${definitions}` : chunks[index]
      ctx.postMessage({ id, index, html: markdownRenderer.render(source) })
    }
    ctx.postMessage({ id, done: true })
  } catch (error) {
    // 渲染失败也必须回一条**带同一个 id** 的消息，否则调用方会永远停在
    // "渲染中"——静默挂起比报错难查得多。
    ctx.postMessage({ id, error: error instanceof Error ? error.message : String(error) })
  }
}
