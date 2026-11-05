/**
 * 系统剪贴板读写（Electron 44+ 的异步 W3C 剪贴板模型）。
 * 只用固定白名单 MIME 构造 ClipboardItem：MIME 键是能力面（text/uri-list 会放真实文件引用、osclipboard 写原始数据）。
 */
import { clipboard, ClipboardItem, nativeImage } from 'electron'
import { createHash } from 'node:crypto'
import { stripMarkupTags } from '../src/shared/plainText'

export interface IncomingClip {
  reps?: Array<{ mime: string; data?: string }>
  preferred?: string
}

export type LocalClip = {
  preferred: string
  reps: Array<{ mime: string; data: string }>
}

const MIME_TEXT = 'text/plain'
const MIME_HTML = 'text/html'
const MIME_RTF = 'text/rtf'
const MIME_PNG = 'image/png'
// 密码管理器复制口令时放的空标记格式：存在即「别记录、别同步」
const SENSITIVE_FORMAT = 'electron application/osclipboard;format="ExcludeClipboardContentFromMonitorProcessing"'

/** 采样摘要每段字节数；文本超过它改存哈希。 */
export const SAMPLE_SPAN = 32 * 1024

/** 首/中/尾各 SAMPLE_SPAN 字节加总长度的摘要，只判断「是否同一份内容」。 */
export function sampledDigest(buf: Uint8Array): string {
  const h = createHash('sha256')
  h.update(String(buf.length))
  if (buf.length <= SAMPLE_SPAN * 3) {
    h.update(buf)
  } else {
    const mid = (buf.length >> 1) - (SAMPLE_SPAN >> 1)
    h.update(buf.subarray(0, SAMPLE_SPAN))
    h.update(buf.subarray(mid, mid + SAMPLE_SPAN))
    h.update(buf.subarray(buf.length - SAMPLE_SPAN))
  }
  return h.digest('hex')
}

async function currentItem(): Promise<Electron.ClipboardItem | null> {
  const items = await clipboard.read()
  return items[0] ?? null
}

async function readBytes(item: Electron.ClipboardItem, mime: string): Promise<Buffer | null> {
  if (!item.types.includes(mime)) return null
  try {
    const blob = (await item.getType(mime)) as Blob
    const buf = Buffer.from(await blob.arrayBuffer())
    return buf.length > 0 ? buf : null
  } catch {
    return null
  }
}

export function readText(): Promise<string> {
  return clipboard.readText()
}

export function writeText(text: string): Promise<void> {
  return clipboard.writeText(text)
}

export async function isClipboardSensitive(): Promise<boolean> {
  try {
    return await clipboard.has(SENSITIVE_FORMAT)
  } catch {
    return false // 枚举失败按普通内容处理，否则同步整体静默失效
  }
}

/** 写入对端发来的剪贴板：一次原子写入全部表示，目标应用自选；图片与文本互斥。 */
export async function writeIncomingClip(clip: IncomingClip): Promise<void> {
  const reps = clip.reps ?? []
  const decode = (mime: string): Buffer | null => {
    const rep = reps.find((r) => r.mime === mime || r.mime.startsWith(mime))
    if (!rep?.data) return null
    try {
      const buf = Buffer.from(rep.data, 'base64')
      return buf.length > 0 ? buf : null
    } catch {
      return null
    }
  }

  const png = decode(MIME_PNG)
  if (png && !nativeImage.createFromBuffer(png).isEmpty()) {
    await clipboard.write([new ClipboardItem({ [MIME_PNG]: new Blob([new Uint8Array(png)], { type: MIME_PNG }) })])
    return
  }

  const record: Record<string, string> = {}
  const text = decode(MIME_TEXT)
  const html = decode(MIME_HTML)
  const rtf = decode('application/rtf') ?? decode(MIME_RTF)
  if (text) record[MIME_TEXT] = text.toString('utf-8')
  if (html) record[MIME_HTML] = html.toString('utf-8')
  if (rtf) record[MIME_RTF] = rtf.toString('utf-8')
  // 纯文本兜底：只认 CF_UNICODETEXT 的老程序也要粘得出
  if (!record[MIME_TEXT] && record[MIME_HTML]) record[MIME_TEXT] = stripMarkupTags(record[MIME_HTML])
  if (Object.keys(record).length === 0) return
  try {
    await clipboard.write([new ClipboardItem(record)])
  } catch {
    // 富格式写失败（被占用、RTF 不合法）至少放纯文本
    if (record[MIME_TEXT]) await clipboard.writeText(record[MIME_TEXT]).catch(() => {})
  }
}

/** 读当前剪贴板为多表示结构。图片与文本互斥：截图时常附带无用的文件名文本。 */
export async function readLocalClipboard(): Promise<LocalClip | null> {
  const item = await currentItem()
  if (!item) return null
  const reps: LocalClip['reps'] = []
  const push = (mime: string, buf: Buffer) => reps.push({ mime, data: buf.toString('base64') })

  const png = await readBytes(item, MIME_PNG)
  if (png) {
    push(MIME_PNG, png)
    const alt = await clipboard.readText()
    if (alt) push('text/plain;charset=utf-8', Buffer.from(alt, 'utf-8'))
    return { preferred: MIME_PNG, reps }
  }

  const text = await clipboard.readText()
  if (!text) return null
  push('text/plain;charset=utf-8', Buffer.from(text, 'utf-8'))
  const html = await readBytes(item, MIME_HTML)
  if (html && html.toString('utf-8') !== text) push(MIME_HTML, html)
  const rtf = await readBytes(item, MIME_RTF)
  if (rtf) push('application/rtf', rtf)
  return { preferred: 'text/plain;charset=utf-8', reps }
}

/**
 * 廉价指纹：先看类型列表；有图时 PNG 编码有成本，按 imageProbeMs 节流（0 = 必读）。
 * 文本短则内容本身、长则采样摘要。'empty' 表示没读到可同步的内容。
 */
export class ClipFingerprinter {
  private lastImage = ''
  private lastImageProbeAt = 0

  resetImageCache(): void {
    this.lastImage = ''
    this.lastImageProbeAt = 0
  }

  async fingerprint(now: number, imageProbeMs: number): Promise<string> {
    const item = await currentItem()
    if (item?.types.includes(MIME_PNG)) {
      if (this.lastImage && now - this.lastImageProbeAt < imageProbeMs) return this.lastImage
      this.lastImageProbeAt = now
      const png = await readBytes(item, MIME_PNG)
      if (png) {
        this.lastImage = `img:${png.length}:${sampledDigest(png)}`
        return this.lastImage
      }
    }
    // 不是图片就清缓存，否则下次真换成图片时会先命中过期指纹而漏发
    this.lastImage = ''
    const text = await clipboard.readText()
    if (!text) return 'empty'
    return text.length <= SAMPLE_SPAN
      ? `txt:${text.length}:${text}`
      : `txh:${text.length}:${sampledDigest(Buffer.from(text, 'utf8'))}`
  }
}
