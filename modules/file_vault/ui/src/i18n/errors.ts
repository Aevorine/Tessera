import i18n from './index'

/**
 * 把后端错误码翻成当前界面语言；兜底文案带上原始码，便于排查后端新增而前端未收录的码。
 * `keySeparator: false`：错误码含点号（`auth.wrong_password`），是扁平键，`common.unknown` 同理。
 */
export function translateError(code: string, params?: Record<string, string | number>): string {
  const key = `errors:${code}`
  if (!code || !i18n.exists(key)) {
    // 把原始码带进文案里。只说一句"发生了未知错误"的话，用户来问的时候
    // 双方都没有任何可查的线索。
    return i18n.t('errors:common.unknown', { code: code || '—' })
  }
  return i18n.t(key, params)
}
