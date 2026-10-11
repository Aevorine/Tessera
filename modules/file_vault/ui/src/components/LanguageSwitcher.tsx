import { useTranslation } from 'react-i18next'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { SUPPORTED_LANGUAGES, ensureLanguageLoaded, saveLanguagePreference, type SupportedLanguage } from '@/i18n'
import { electronApi } from '@/lib/electronApi'

const LANGUAGE_NAMES: Record<SupportedLanguage, string> = {
  zh: '简体中文',
  en: 'English',
  fr: 'Français',
  es: 'Español',
  ru: 'Русский',
  ar: 'العربية',
}

export function LanguageSwitcher({ className }: { className?: string }) {
  const { i18n } = useTranslation()

  async function handleChange(lang: string) {
    // 先装入该语言资源再切：启动只加载用户语言 + en（见 i18n/index.ts），其余首次切换才取；不 await 会
    // 闪一帧"全是 key"。
    await ensureLanguageLoaded(lang as SupportedLanguage)
    await i18n.changeLanguage(lang)
    saveLanguagePreference(lang as SupportedLanguage)
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr'
    // 原生菜单栏（File/Edit/View/Window/Help）不会跟着i18next的语言切换自动
    // 变化——两边是独立的系统（菜单由主进程管理），需要显式转发一次。
    electronApi.setAppLanguage(lang)
  }

  return (
    <Select value={i18n.language} onValueChange={handleChange}>
      <SelectTrigger className={className ?? 'w-[140px]'} aria-label="Language">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {SUPPORTED_LANGUAGES.map((lang) => (
          <SelectItem key={lang} value={lang}>
            {LANGUAGE_NAMES[lang]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
