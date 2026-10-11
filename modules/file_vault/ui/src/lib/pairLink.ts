/**
 * 配对链接：把 400 多字符的 base64 配对码包成 URL，聊天软件会整条识别为链接、不折行，对方也看得出用途。
 * 内容与二维码完全一致（一次性令牌 + 公钥，无私钥材料），安全边界相同：对方仍要点同意、两边仍要核对 SAS；
 * 链接本身不是凭据，泄露最多多一次配对请求弹窗。
 */
const PAIR_LINK_SCHEME = 'tessera://pair?c='
const LINK_MARKER = 'pair?c='

// 要剥掉的外壳：半角引号、中文弯引号（U+201C/U+201D）、全角空格（U+3000）和空白；
// 全部写成转义，源码里的全角空格肉眼分不出且 lint 会报错。
const WRAPPER_CHARS = '["\'\\u201C\\u201D\\u3000\\s]+'
const TRIM_CHARS = new RegExp(`^${WRAPPER_CHARS}|${WRAPPER_CHARS}$`, 'g')

export function buildPairLink(code: string): string {
  return PAIR_LINK_SCHEME + encodeURIComponent(code)
}

/**
 * 从用户粘贴的内容取出配对码，接受四种真实形态：裸码、完整链接、带说明文字的链接、两端带引号或全角空格。
 * 取不出就原样返回，让后端判断有效性，这里不自作主张判「格式不对」。
 */
export function parsePairInput(raw: string): string {
  const text = raw.replace(TRIM_CHARS, '')
  if (!text) return ''
  const marker = text.indexOf(LINK_MARKER)
  if (marker === -1) return text
  const tail = text.slice(marker + LINK_MARKER.length).split(/[\s&#]/)[0]
  try {
    return decodeURIComponent(tail)
  } catch {
    // 用户手工改过链接、或者百分号落单。原样交给后端报错，不在这里吞掉。
    return tail
  }
}
