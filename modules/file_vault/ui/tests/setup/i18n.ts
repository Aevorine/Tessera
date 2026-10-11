import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

/**
 * 测试用 i18next 初始化：不走 `initI18n()`（它要 electronAPI.getSystemLocale，每个测试都得造假桥）。
 * 用真文案而非 cimode，才测得到“键缺文案”；查询名一律用 `tk()` 现算，改文案不假红，删键会红。
 */

const NAMESPACES = [
  'common',
  'errors',
  'login',
  'setup',
  'settings',
  'passwords',
  'files',
  'clipboard',
  'crossdevice',
  'ai',
  'notes',
  'network',
  'filemanager',
  'help',
  'recoveryCodes',
  'pcclean',
] as const

// eager 一次性把英文这一份全读进来。测试进程里这是几十 KB 的 JSON，
// 换来的是不用在每个用例里 await 加载。
const bundles = import.meta.glob<{ default: Record<string, string> }>(
  '../../src/i18n/locales/en/*.json',
  { eager: true },
)

function resources(): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {}
  for (const [path, mod] of Object.entries(bundles)) {
    const ns = path.split('/').pop()?.replace('.json', '')
    if (ns) out[ns] = mod.default
  }
  return out
}

export async function initTestI18n(): Promise<void> {
  if (i18n.isInitialized) return
  await i18n.use(initReactI18next).init({
    resources: { en: resources() },
    lng: 'en',
    fallbackLng: 'en',
    ns: [...NAMESPACES],
    defaultNS: 'common',
    // 跟生产同一个设置。键本身带点号（`auth.wrong_password`），
    // 默认的 '.' 分隔符会把它当成嵌套路径，于是每一个错误码都查不到。
    keySeparator: false,
    interpolation: { escapeValue: false },
  })
}

/** 按文字找元素一律走它，不要写死字符串：别人改一个词就假红，假红多了整套测试会被当噪声。 */
export function tk(key: string, options?: Record<string, unknown>): string {
  return i18n.t(key, options as never) as string
}

export default i18n
