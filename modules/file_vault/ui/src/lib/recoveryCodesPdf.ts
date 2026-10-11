import type { RevealedRecoveryCode } from '@/shared/ipcTypes'

export interface PdfServiceSection {
  service: string
  accountLabel: string
  codes: RevealedRecoveryCode[]
}

export interface PdfStrings {
  title: string
  accountLabelPrefix: string
  generatedAtLabel: string
  warningText: string
}

// spec 第8节字体规范：中文宋体、英文数字标点 Times New Roman，PDF 打印排版
// 同样遵循，跟屏幕上列表/详情/导入导出预览用的是同一条规则。
const FONT_FAMILY = '"Times New Roman", "SimSun", serif'

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// HTML 只交给主进程隐藏 BrowserWindow 的 printToPDF()（同笔记导出的 document:exportPdf），无需新 IPC 或 PDF 库。
export function buildRecoveryCodesPdfHtml(sections: PdfServiceSection[], strings: PdfStrings): string {
  const generatedAt = new Date().toLocaleString()
  const sectionsHtml = sections
    .map((s) => {
      const codesHtml = s.codes
        .map(
          (c) =>
            `<li style="${c.used ? 'text-decoration: line-through; color: #888;' : ''}">${escapeHtml(c.code)}</li>`,
        )
        .join('')
      return `
        <section style="page-break-inside: avoid; margin-bottom: 32px;">
          <h2 style="font-size: 18px; margin-bottom: 4px;">${escapeHtml(s.service)}</h2>
          ${s.accountLabel ? `<p style="color:#555; margin: 0 0 12px;">${escapeHtml(strings.accountLabelPrefix)}${escapeHtml(s.accountLabel)}</p>` : ''}
          <ul style="font-size: 15px; line-height: 1.8; list-style: none; padding: 0; columns: 2;">${codesHtml}</ul>
        </section>`
    })
    .join('')

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  body { font-family: ${FONT_FAMILY}; padding: 32px; color: #111; }
  h1 { font-size: 22px; margin-bottom: 4px; }
  .meta { color: #666; font-size: 12px; margin-bottom: 24px; }
  .warning { border: 1px solid #d33; color: #d33; padding: 8px 12px; margin-bottom: 24px; font-size: 13px; }
</style>
</head>
<body>
  <h1>${escapeHtml(strings.title)}</h1>
  <p class="meta">${escapeHtml(strings.generatedAtLabel)}${escapeHtml(generatedAt)}</p>
  <p class="warning">${escapeHtml(strings.warningText)}</p>
  ${sectionsHtml}
</body>
</html>`
}
