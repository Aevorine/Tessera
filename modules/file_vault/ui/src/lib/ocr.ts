import { createWorker, type Worker } from 'tesseract.js'

// 全部指向 public/tesseract/ 打包的本地资源，不经 CDN：恢复码截图敏感，识别必须 100% 离线（spec 3.1 OCR 导入）。
// 恢复码固定是拉丁字母数字，语言固定用英文包，与界面语言无关。
// 路径相对 index.html、不带开头斜杠，交给 tesseract.js 前必须经 assetUrl 解析成完整 URL。
const WORKER_PATH = 'tesseract/worker.min.js'
const CORE_PATH = 'tesseract/core'
const LANG_PATH = 'tesseract/lang-data'
const OEM_LSTM_ONLY = 1

/**
 * 把 public/ 下的资源路径解析成完整绝对 URL。
 * 打包后页面是 file:// 加载（main.ts 的 `win.loadFile`），`/tesseract/...` 会解析到盘根而非应用目录；
 * 且 tesseract.js 默认用 blob Web Worker，worker 内的 importScripts 与语言包 fetch 相对 `blob:` 基址，
 * 相对路径同样落空，所以必须在渲染端先解析成绝对 URL。
 */
function assetUrl(relativePath: string): string {
  return new URL(relativePath, document.baseURI).href
}

let workerPromise: Promise<Worker> | null = null

function getWorker(): Promise<Worker> {
  if (!workerPromise) {
    workerPromise = createWorker('eng', OEM_LSTM_ONLY, {
      workerPath: assetUrl(WORKER_PATH),
      corePath: assetUrl(CORE_PATH),
      langPath: assetUrl(LANG_PATH),
      cacheMethod: 'none', // 识别用的语言数据不留存浏览器缓存
      gzip: true, // 本地打包的是 eng.traineddata.gz
    })
    // 失败就清缓存：留着已 reject 的 promise 会让本会话之后每次识别都立刻拿到同一个旧错误，一次偶发失败就永久关掉 OCR。
    workerPromise.catch(() => {
      workerPromise = null
    })
  }
  return workerPromise
}

export async function recognizeText(image: File | Blob | string): Promise<string> {
  const worker = await getWorker()
  const { data } = await worker.recognize(image)
  return data.text
}

// 应用退出/长时间不用时释放 worker；下次识别会透明地重新创建一个。
export async function terminateOcrWorker(): Promise<void> {
  if (!workerPromise) return
  const worker = await workerPromise
  workerPromise = null
  await worker.terminate()
}

/**
 * 本地文件路径 → file:// URL，逐段百分号编码。直接拼接时 `#`/`?` 会被当片段/查询串而指向另一个文件，
 * `%41` 这类序列会被解回别的字符，表现为识别失败却看不出是文件名问题。
 * 盘符（`D:`）不编码：URL 规范在解析时识别盘符，编码成 `D%3A` 就不再被当作盘符。
 */
export function filePathToFileUrl(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/')
  const withRoot = normalized.startsWith('/') ? normalized.slice(1) : normalized
  const encoded = withRoot
    .split('/')
    .map((segment, index) => (index === 0 && /^[A-Za-z]:$/.test(segment) ? segment : encodeURIComponent(segment)))
    .join('/')
  return `file:///${encoded}`
}
