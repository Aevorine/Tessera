import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

export const SUPPORTED_LANGUAGES = ['zh', 'en', 'fr', 'es', 'ru', 'ar'] as const
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number]

export const NAMESPACES = [
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
  'security',
] as const

const STORAGE_KEY = 'ideal1-file-vault-lang'

/**
 * 6 语言 × 16 命名空间的 JSON 用 `import.meta.glob` 拆成独立 chunk 按需加载，避免冷启动全量下载。
 * 启动只加载用户语言和 'en'（fallbackLng，缺了会直接显示 key），其余语言见 ensureLanguageLoaded()。
 */
const localeModules = import.meta.glob<{ default: Record<string, string> }>('./locales/*/*.json')

const loaded = new Set<SupportedLanguage>()

async function loadLanguage(lang: SupportedLanguage): Promise<Record<string, Record<string, string>>> {
  const entries = await Promise.all(
    NAMESPACES.map(async (ns) => {
      const key = `./locales/${lang}/${ns}.json`
      const importer = localeModules[key]
      if (!importer) {
        // 缺文件不该让整个应用起不来。少一个命名空间的表现是那部分界面显示 key，
        // 难看但可用；这里抛错的话是白屏。
        console.warn(`[i18n] missing locale bundle: ${key}`)
        return [ns, {}] as const
      }
      const mod = await importer()
      return [ns, mod.default] as const
    }),
  )
  return Object.fromEntries(entries)
}

/** 保证某语言资源已装载；切换语言前必须 await，否则会闪一帧全是 key 的界面。 */
export async function ensureLanguageLoaded(lang: SupportedLanguage): Promise<void> {
  if (loaded.has(lang)) return
  const bundles = await loadLanguage(lang)
  for (const ns of NAMESPACES) {
    i18n.addResourceBundle(lang, ns, bundles[ns] ?? {}, true, true)
  }
  loaded.add(lang)
}

// app.getLocale() 形如 "zh-CN"；只取 "-" 前部分匹配 6 种支持语言，其余回退英文。
function resolveSupportedLanguage(rawLocale: string): SupportedLanguage {
  const prefix = rawLocale.split('-')[0].toLowerCase()
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(prefix) ? (prefix as SupportedLanguage) : 'en'
}

async function detectInitialLanguage(): Promise<SupportedLanguage> {
  const saved = localStorage.getItem(STORAGE_KEY)
  if (saved && (SUPPORTED_LANGUAGES as readonly string[]).includes(saved)) {
    return saved as SupportedLanguage
  }
  try {
    const systemLocale = await window.electronAPI.getSystemLocale()
    return resolveSupportedLanguage(systemLocale)
  } catch {
    return 'en'
  }
}

export function saveLanguagePreference(lang: SupportedLanguage): void {
  localStorage.setItem(STORAGE_KEY, lang)
}

export async function initI18n(): Promise<void> {
  const lang = await detectInitialLanguage()

  // 用户语言和 en 并行取。en 在 lang === 'en' 时是同一份，Set 会去重。
  const needed: SupportedLanguage[] = lang === 'en' ? ['en'] : [lang, 'en']
  const bundles = await Promise.all(needed.map(loadLanguage))

  const resources: Record<string, Record<string, Record<string, string>>> = {}
  needed.forEach((code, i) => {
    resources[code] = bundles[i]
    loaded.add(code)
  })

  await i18n.use(initReactI18next).init({
    resources,
    lng: lang,
    fallbackLng: 'en',
    ns: [...NAMESPACES],
    defaultNS: 'common',
    keySeparator: false, // our keys are flat, dot-separated error codes (e.g. "auth.wrong_password") -
    // i18next's default keySeparator ('.') would otherwise try to resolve them as nested objects and
    // silently fail to find every single error-code key. This must be set before Task 14 adds errors.json.
    interpolation: { escapeValue: false }, // React already escapes
  })
}

export default i18n
