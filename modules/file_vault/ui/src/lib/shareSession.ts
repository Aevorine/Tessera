/** 与后端 crypto.PASSPHRASE_MIN_CHARS 一致；后端也会再判一次。 */
export const SHARE_PASSPHRASE_MIN = 8

/** 同一批分享操作共用的口令与批次 id（后端据此每批只跑一次 Argon2id）。 */
export interface ShareContext {
  passphrase: string
  session: string
}

export function newShareSession(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** 分享类 RPC 要带的两个参数；没有口令批次时什么都不带。 */
export function shareParams(share: ShareContext | null): { passphrase?: string; share_session?: string } {
  return share ? { passphrase: share.passphrase, share_session: share.session } : {}
}
