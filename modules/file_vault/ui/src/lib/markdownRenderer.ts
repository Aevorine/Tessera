import MarkdownIt from 'markdown-it'

// html:false 是刻意的安全选择：笔记可能来自外部导入的 .md，带 <script> 等原始 HTML，
// 禁止透传即可，无需引入 DOMPurify。markdown-it 实例无状态，单例即可。
// 单独成模块：预览（lazy）和 DOCX/PDF 导出（动态 import）都按需加载，放进 NotesScreen.tsx
// 会把 markdown-it 钉进笔记首屏分块。
export const markdownRenderer = new MarkdownIt({ html: false, linkify: true, breaks: false })
