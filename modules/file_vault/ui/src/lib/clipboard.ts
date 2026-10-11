/**
 * 剪贴板：界面唯一的复制/粘贴入口，不直接用 navigator.clipboard。
 * 原因有二：`main.ts` 的 `denyAllWebPermissions()` 拒绝了 clipboard 权限（防 XSS，不能放松）；
 * 且网页剪贴板要求文档有焦点，而 30 秒后自动清空密码时用户早已切走，清空每次都失败（安全问题）。
 * 所以走主进程 `electron.clipboard`（直调系统，无权限层、不看焦点）。
 * 三级兜底：主进程 IPC；navigator.clipboard（浏览器开发/测试，无 preload）；隐藏 textarea + execCommand。
 * 这里的函数永不抛异常、只返回布尔值，避免调用方漏 catch 造成无界面提示的 unhandledrejection。
 */

/** 复制失败时的原因，只用于日志排查，不直接显示给用户。 */
let lastFailureReason = ''

/** 上一次复制失败的原因（英文，来自浏览器或主进程）。成功时为空串。 */
export function lastClipboardFailure(): string {
  return lastFailureReason
}

/** 把文本写进系统剪贴板；写入成功返回 true，永不抛异常、永不返回 rejected promise。 */
export async function copyText(text: string): Promise<boolean> {
  lastFailureReason = ''

  // 1. 主进程原生剪贴板。桌面应用里这条永远走得通。
  const api = typeof window !== 'undefined' ? window.electronAPI : undefined
  if (api?.clipboardWriteText) {
    try {
      const res = await api.clipboardWriteText(text)
      if (res?.ok) return true
      lastFailureReason = res && 'error' in res ? res.error : 'main process refused'
    } catch (error) {
      lastFailureReason = describe(error)
    }
  }

  // 2. 网页剪贴板。在这个应用里会被权限层拒掉，但在浏览器里跑测试时是唯一可用的。
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch (error) {
    lastFailureReason ||= describe(error)
  }

  // 3. 最后的老办法。空串没法用这条写（选中空内容 execCommand 会返回 false），
  //    而"清空剪贴板"恰恰要写空串——所以那种情况直接认输，别谎报成功。
  if (text !== '' && legacyCopy(text)) return true

  lastFailureReason ||= 'no clipboard backend available'
  return false
}

/** 读系统剪贴板；读不到返回 null（不抛异常），空串表示剪贴板确实为空。 */
export async function readClipboardText(): Promise<string | null> {
  lastFailureReason = ''

  const api = typeof window !== 'undefined' ? window.electronAPI : undefined
  if (api?.clipboardReadText) {
    try {
      const res = await api.clipboardReadText()
      if (res?.ok) return res.text
      lastFailureReason = res && 'error' in res ? res.error : 'main process refused'
    } catch (error) {
      lastFailureReason = describe(error)
    }
  }

  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.readText) {
      return await navigator.clipboard.readText()
    }
  } catch (error) {
    lastFailureReason ||= describe(error)
  }

  // 读没有 execCommand 兜底：`execCommand('paste')` 现代浏览器一律不支持。
  lastFailureReason ||= 'no clipboard backend available'
  return null
}

/**
 * 复制敏感文本并在 N 毫秒后自动清空剪贴板。
 * 用自增计数判断期间是否有更晚的复制，而不读剪贴板比对：读需额外权限，且会误清用户中途复制的内容。
 * @returns 首次复制是否成功；后台清空的结果不影响返回值。
 */
let autoClearGeneration = 0

export async function copyTextWithAutoClear(text: string, holdMs = 30_000): Promise<boolean> {
  const ok = await copyText(text)
  if (!ok) return false
  const mine = ++autoClearGeneration
  setTimeout(() => {
    // 期间又复制过别的东西，就不是"我"该清的了。
    if (autoClearGeneration !== mine) return
    void copyText('')
  }, holdMs)
  return true
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** `document.execCommand('copy')` 兜底（基本只在非 Electron 浏览器环境用到）；textarea 须在文档内且非 `display:none`，否则选不中。 */
function legacyCopy(text: string): boolean {
  if (typeof document === 'undefined' || !document.body) return false
  const el = document.createElement('textarea')
  el.value = text
  el.setAttribute('readonly', '')
  el.setAttribute('aria-hidden', 'true')
  el.style.position = 'fixed'
  el.style.top = '-9999px'
  el.style.opacity = '0'
  document.body.appendChild(el)
  try {
    el.select()
    el.setSelectionRange(0, text.length)
    return document.execCommand('copy')
  } catch (error) {
    lastFailureReason ||= describe(error)
    return false
  } finally {
    el.remove()
  }
}
