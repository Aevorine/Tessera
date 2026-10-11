/**
 * 内容安全策略，目的是挡住已解锁的金库内容被 fetch 外发；独立于 vite 以便 tests/csp.test.mjs
 * 直接加载。
 * contextIsolation 只挡住注入脚本拿 Node 能力，挡不住渲染进程里脚本 fetch 到攻击者服务器；
 * 应用渲染的 Markdown、富文本、OCR 都是不可信输入，CSP 让净化器被绕过时降级为脚本跑了但送不出去。
 * 关键是打包版 connect-src 里没有 http:/https:（后端走 preload IPC，OCR wasm 和语言包在本地
 * public/tesseract/）。
 * file: 必须保留：打包后页面是 file:// 加载，tesseract.js 用 fetch 取 wasm；Chromium 对 file://
 * 跨文件读取另有限制。
 */

/** index.html 里的占位注释。vite 在 transformIndexHtml 阶段把它换成 meta 标签。 */
export const CSP_PLACEHOLDER = '<!--#IDEAL1_CSP#-->'

/** 两套策略共用的部分。 */
const SHARED = [
  "default-src 'none'",
  // 样式必须放行 inline：Tailwind、组件库和 React style 属性都会插入；inline 样式危害远小于脚本，
  // 禁掉需逐处加 nonce。
  "style-src 'self' 'unsafe-inline' file:",
  "img-src 'self' data: blob: file:",
  "font-src 'self' data: file:",
  "media-src 'self' blob: file:",
  // tesseract.js 用 blob 起 Web Worker
  "worker-src 'self' blob:",
  "object-src 'none'",
  // 没有 <base> 就没人能改写相对路径的解析基准
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
]

/** 生成策略字符串；dev 与打包必须分开：写死严格会让 Vite HMR 失效，写死宽松等于没加。 */
export function buildCsp({ dev }) {
  if (dev) {
    return [
      ...SHARED,
      // Vite 的 HMR 客户端是 inline 注入的，并且用 eval 做模块热替换
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      // HMR 走 WebSocket 回开发服务器
      "connect-src 'self' ws: wss: http://127.0.0.1:* http://localhost:*",
    ].join('; ')
  }
  return [
    ...SHARED,
    "script-src 'self' file:",
    // **整条策略里最要紧的一行**：没有 http:/https:/ws:，于是渲染进程里的任何
    // 代码都无法把金库内容发到外面去。
    "connect-src 'self' data: blob: file:",
  ].join('; ')
}

/** 把 index.html 里的占位符换成真正的 meta 标签。 */
export function injectCsp(html, { dev }) {
  return html.replace(
    CSP_PLACEHOLDER,
    `<meta http-equiv="Content-Security-Policy" content="${buildCsp({ dev })}" />`,
  )
}
