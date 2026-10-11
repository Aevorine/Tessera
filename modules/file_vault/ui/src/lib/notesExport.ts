/**
 * 单条笔记导出 .docx / .pdf，拆出来是为了被动态 import（`docx` minify 后数百 KB，仅点"导出为 Word"才用）。
 * 调用方一律 `await import('@/lib/notesExport')`，不要改成静态 import，否则整块回到笔记首屏分块且不报错。
 * 批量导出不走这里，走后端 note_export_files 的 .txt 路径。
 */
import {
  BorderStyle,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx'

import { markdownRenderer } from '@/lib/markdownRenderer'
import type { NoteFormat } from '@/shared/ipcTypes'

export interface ExportableNote {
  title: string
  content: string
  format: NoteFormat
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// 导出用的独立 HTML 样式：由 main.ts 隐藏窗口 loadFile 加载，用不到应用的 Tailwind 产物，只能手写 CSS。
// printToPDF 走 Chromium 原生渲染，但仍须显式指定字体，否则可能选到没有中文字形的西文字体。
// 字体栈与界面（index.css 的 --font-sans）和 DOCX 一致：西文 Times New Roman、中文宋体；字号对齐小四（16px）。
const PDF_DOCUMENT_STYLE = `
  body { font-family: "Times New Roman", "SimSun", "宋体", serif; font-size: 16px; line-height: 1.7; color: #1a1a1a; padding: 40px; }
  h1, h2, h3, h4, h5, h6 { font-weight: 600; margin: 1.2em 0 0.5em; }
  h1 { font-size: 24px; } h2 { font-size: 21px; } h3 { font-size: 19px; } h4, h5, h6 { font-size: 16px; }
  p { margin: 0.6em 0; }
  ul, ol { padding-left: 1.5em; margin: 0.6em 0; }
  li { margin: 0.2em 0; }
  code { background: #f0f0f0; padding: 0.1em 0.3em; border-radius: 3px; font-family: Consolas, "Courier New", monospace; }
  pre { background: #f0f0f0; padding: 0.8em; border-radius: 4px; overflow-x: auto; }
  pre code { background: none; padding: 0; }
  blockquote { border-left: 3px solid #ccc; margin: 0.6em 0; padding-left: 1em; color: #555; }
  table { border-collapse: collapse; width: 100%; margin: 0.6em 0; }
  th, td { border: 1px solid #ccc; padding: 4px 8px; text-align: left; }
  hr { border: none; border-top: 1px solid #ccc; margin: 1.5em 0; }
  .plain-text { white-space: pre-wrap; word-break: break-word; font-family: inherit; font-size: inherit; background: none; padding: 0; margin: 0; }
`

export function buildPdfHtml(note: ExportableNote): string {
  const bodyHtml =
    note.format === 'markdown' ? markdownRenderer.render(note.content) : `<pre class="plain-text">${escapeHtml(note.content)}</pre>`
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(note.title)}</title><style>${PDF_DOCUMENT_STYLE}</style></head><body>${bodyHtml}</body></html>`
}

// markdown-it 的 Token 类型经 `export =` 加命名空间合并暴露，与 ES 默认导入搭配时
// `MarkdownIt.Token` 在类型位置解析不出；这里按实际用到的字段自定义最小类型，结构兼容。
interface MarkdownItToken {
  type: string
  tag: string
  content: string
  children: MarkdownItToken[] | null
}

const DOCX_CODE_FONT = 'Consolas'
// docx 正文字体，对齐 index.css 的 --font-sans：西文和半角标点 Times New Roman，中文宋体。
// docx 字号单位是半磅（小四 12pt = 24，四号 = 28）；导出固定小四，不随界面字号档位变，保持稳定标准字号。
const DOCX_LATIN_FONT = 'Times New Roman'
const DOCX_CJK_FONT = 'SimSun'
const DOCX_BODY_HALF_POINTS = 24
const DOCX_HEADING_BY_LEVEL: Record<number, (typeof HeadingLevel)[keyof typeof HeadingLevel]> = {
  1: HeadingLevel.HEADING_1,
  2: HeadingLevel.HEADING_2,
  3: HeadingLevel.HEADING_3,
  4: HeadingLevel.HEADING_4,
  5: HeadingLevel.HEADING_5,
  6: HeadingLevel.HEADING_6,
}

// 内联 token 转 TextRun[]：只处理加粗/斜体/行内代码/换行，链接按纯文本处理（文字仍输出，
// 只是不生成超链接），是 P0 的刻意简化。
function inlineTokensToRuns(children: MarkdownItToken[] | null, forceBold = false): TextRun[] {
  if (!children || children.length === 0) return [new TextRun('')]
  const runs: TextRun[] = []
  // forceBold 给表头单元格用：表头整格加粗，格子里再出现 **粗体** 也不冲突。
  let bold = forceBold
  let italics = false
  for (const child of children) {
    switch (child.type) {
      case 'strong_open':
        bold = true
        break
      case 'strong_close':
        bold = forceBold
        break
      case 'em_open':
        italics = true
        break
      case 'em_close':
        italics = false
        break
      case 'code_inline':
        runs.push(new TextRun({ text: child.content, font: DOCX_CODE_FONT, bold, italics }))
        break
      case 'softbreak':
      case 'hardbreak':
        runs.push(new TextRun({ text: '', break: 1 }))
        break
      case 'text':
        if (child.content) runs.push(new TextRun({ text: child.content, bold, italics }))
        break
      default:
        // link_open/link_close、image 等标记 token 不产出文字，其中的 text 子 token 仍正常输出，纯文本内容不丢。
        break
    }
  }
  return runs.length > 0 ? runs : [new TextRun('')]
}

// 直接消费 markdown-it 的 token 流，不先转 HTML 再逆向解析。有序/无序列表统一用 docx 的 `bullet`
// （导出后都是项目符号）：真正的有序编号要额外注册 numbering 配置，P0 不值。blockquote 只按缩进近似。
function markdownToDocxParagraphs(content: string): (Paragraph | Table)[] {
  const tokens = markdownRenderer.parse(content, {})
  const paragraphs: (Paragraph | Table)[] = []
  let listLevel = -1
  let blockquoteDepth = 0

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    switch (token.type) {
      case 'heading_open': {
        const level = Number(token.tag.slice(1))
        const inline = tokens[i + 1]
        paragraphs.push(new Paragraph({ heading: DOCX_HEADING_BY_LEVEL[level] ?? HeadingLevel.HEADING_6, children: inlineTokensToRuns(inline?.children ?? null) }))
        i += 2
        break
      }
      case 'paragraph_open': {
        const inline = tokens[i + 1]
        paragraphs.push(
          new Paragraph({
            children: inlineTokensToRuns(inline?.children ?? null),
            ...(listLevel >= 0 ? { bullet: { level: listLevel } } : {}),
            ...(blockquoteDepth > 0 ? { indent: { left: 480 * blockquoteDepth } } : {}),
          }),
        )
        i += 2
        break
      }
      case 'bullet_list_open':
      case 'ordered_list_open':
        listLevel++
        break
      case 'bullet_list_close':
      case 'ordered_list_close':
        listLevel--
        break
      case 'blockquote_open':
        blockquoteDepth++
        break
      case 'blockquote_close':
        blockquoteDepth--
        break
      case 'fence':
      case 'code_block': {
        const lines = token.content.replace(/\n$/, '').split('\n')
        for (const line of lines) {
          paragraphs.push(new Paragraph({ children: [new TextRun({ text: line || ' ', font: DOCX_CODE_FONT })], shading: { fill: 'F0F0F0' } }))
        }
        break
      }
      case 'hr':
        paragraphs.push(new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'CCCCCC' } } }))
        break
      // 表格。没有这个分支时整张表在 docx 里静默消失（预览和 PDF 都有）：
      // table_open 之后的 thead/tbody/tr/th/td 标记 token 全落到 default 被丢掉，连单元格内容一起。
      case 'table_open': {
        const { table, nextIndex } = tableFromTokens(tokens, i)
        if (table) paragraphs.push(table)
        i = nextIndex
        break
      }
      default:
        break
    }
  }
  return paragraphs.length > 0 ? paragraphs : [new Paragraph('')]
}

// 从 table_open 起把一张表的 token 收成 docx Table，nextIndex 指向 table_close（外层 i++ 继续）。
// markdown-it 的 token 流是扁平的，所以靠深度计数走到配对的 table_close，而非递归。
function tableFromTokens(tokens: MarkdownItToken[], startIndex: number): { table: Table | null; nextIndex: number } {
  const rows: TableRow[] = []
  let cells: TableCell[] = []
  let inHeader = false
  let depth = 0
  let i = startIndex

  for (; i < tokens.length; i++) {
    const type = tokens[i].type
    if (type === 'table_open') {
      depth++
      continue
    }
    if (type === 'table_close') {
      depth--
      if (depth === 0) break
      continue
    }
    switch (type) {
      case 'thead_open':
        inHeader = true
        break
      case 'thead_close':
        inHeader = false
        break
      case 'tr_open':
        cells = []
        break
      case 'tr_close':
        if (cells.length > 0) rows.push(new TableRow({ children: cells, tableHeader: inHeader }))
        break
      case 'th_open':
      case 'td_open': {
        // 单元格内容就是紧跟着的那个 inline token；th_open/td_open 自己不带文字。
        const inline = tokens[i + 1]?.type === 'inline' ? tokens[i + 1] : null
        cells.push(
          new TableCell({
            children: [new Paragraph({ children: inlineTokensToRuns(inline?.children ?? null, type === 'th_open') })],
          }),
        )
        break
      }
      default:
        break
    }
  }

  // 空表（一行都没收到）不生成 Table：docx 会为它写出一段没有任何行的表格
  // XML，Word 打开时会报文档已损坏——为了一张空表毁掉整份导出不值得。
  if (rows.length === 0) return { table: null, nextIndex: i }
  return {
    table: new Table({
      rows,
      width: { size: 100, type: WidthType.PERCENTAGE },
    }),
    nextIndex: i,
  }
}

function buildDocxDocument(note: ExportableNote): Document {
  const bodyParagraphs =
    note.format === 'markdown'
      ? markdownToDocxParagraphs(note.content)
      : note.content.split('\n').map((line) => new Paragraph({ children: [new TextRun(line)] }))
  return new Document({
    // 导出的 docx 与界面同一套字体：西文 Times New Roman、中文宋体、正文小四（size 单位半磅，12pt = 24）。
    // 必须显式声明：docx 库不继承 CSS，不设会落到 Word 默认的 Calibri / 等线。
    // `font` 用对象形式分别指定西文与东亚（OOXML 的 w:ascii / w:eastAsia），单个字符串会让中文落到不确定的字体。
    styles: {
      default: {
        document: {
          run: { font: { ascii: DOCX_LATIN_FONT, eastAsia: DOCX_CJK_FONT }, size: DOCX_BODY_HALF_POINTS },
        },
      },
    },
    sections: [
      {
        children: [new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(note.title)] }), ...bodyParagraphs],
      },
    ],
  })
}

/** 直接给出 .docx 的 base64，调用方无需接触 `docx` 包（连 `Packer` 都不用 import），免得有人把它静态引回去。 */
export async function buildDocxBase64(note: ExportableNote): Promise<string> {
  return Packer.toBase64String(buildDocxDocument(note))
}
