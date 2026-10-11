import type { ClipboardContentType } from '@/shared/ipcTypes'

// 剪贴板「快速转换」纯函数，从 ClipboardScreen.tsx 搬出以便脱离界面单独测试。
// 入参只收用到的两个字段而非整个 `ClipboardEntry`，方便别处复用。

export type QuickConvertKind =
  | 'jsonFormat'
  | 'urlEncode'
  | 'urlDecode'
  | 'base64Encode'
  | 'base64Decode'
  | 'upperCase'
  | 'lowerCase'

export function isValidJson(text: string): boolean {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

// UTF-8 安全的 Base64：原生 btoa/atob 只认 Latin1，故先过 TextEncoder/TextDecoder。
// 分块 fromCharCode，不用 `String.fromCharCode(...bytes)`：展开会撞调用栈参数上限（V8 约 12 万）抛 RangeError。
const B64_CHUNK = 0x8000

export function base64EncodeUtf8(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (let i = 0; i < bytes.length; i += B64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + B64_CHUNK))
  }
  return btoa(binary)
}

export function base64DecodeUtf8(text: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(text), (c) => c.charCodeAt(0)))
}

// 转换失败（不是合法 JSON/Base64/URL 编码）返回 null，调用方转成失败提示，
// 不是让原始异常冒泡把界面弄崩。
export function applyQuickConvert(kind: QuickConvertKind, text: string): string | null {
  try {
    switch (kind) {
      case 'jsonFormat':
        return JSON.stringify(JSON.parse(text), null, 2)
      case 'urlEncode':
        return encodeURIComponent(text)
      case 'urlDecode':
        return decodeURIComponent(text)
      case 'base64Encode':
        return base64EncodeUtf8(text)
      case 'base64Decode':
        return base64DecodeUtf8(text)
      case 'upperCase':
        return text.toUpperCase()
      case 'lowerCase':
        return text.toLowerCase()
    }
  } catch {
    return null
  }
}

// 只对 code/url 显示，复用 classifier 的分类；各类给哪些选项是产品判断，不穷举（如 url 不给大小写转换）。
export function quickConvertOptionsFor(entry: {
  content_type: ClipboardContentType
  content_text?: string | null
}): QuickConvertKind[] {
  if (entry.content_type === 'url') {
    return ['urlEncode', 'urlDecode']
  }
  if (entry.content_type === 'code') {
    const options: QuickConvertKind[] = []
    if (entry.content_text && isValidJson(entry.content_text)) options.push('jsonFormat')
    options.push('base64Encode', 'base64Decode', 'upperCase', 'lowerCase')
    return options
  }
  return []
}
