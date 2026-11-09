import { useTranslation } from 'react-i18next'
import { ShieldCheck } from 'lucide-react'
import { LanguageSwitcher } from '@/components/LanguageSwitcher'
import { UnlockFactorTabs } from '@/components/UnlockTabs'
import { PageTitle, Wordmark } from '@/components/ui/page'

export function LoginScreen({ onUnlocked }: { onUnlocked: () => void }) {
  const { t } = useTranslation('login')
  return (
    <div className="ds-page-wash relative flex min-h-screen items-center justify-center bg-background p-6">
      {/* 语言选择放在登录页而不是只放在主界面里：看不懂界面的人本来就过不了
          登录这一关，把它锁在解锁之后等于没有。 */}
      <div className="absolute end-6 top-6">
        <LanguageSwitcher className="w-[150px]" />
      </div>

      {/* 宽度按最长的那种语言给足（西语/俄语的"恢复密钥"最长）。680 → 760 是跟着
          两件事一起调的：标签栏改成五等分一行（不再折行，每格要放得下最长的
          译名），以及输入框整体加高之后，卡片再窄就会显得头重脚轻。窄窗口下由
          max-w 收回去，标签栏的文字自己折行，仍然五个都在。 */}
      <div className="w-[760px] max-w-[calc(100vw-3rem)]">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <div className="flex items-center gap-2.5">
            <span aria-hidden="true" className="ds-icon-chip size-11">
              <ShieldCheck className="size-6" />
            </span>
            {/* 产品名不进翻译文件：它在六种语言里都写作 Tessera。 */}
            <Wordmark />
          </div>
          <PageTitle>{t('loginTitle')}</PageTitle>
        </div>

        <div className="rounded-2xl border border-border bg-card p-8 shadow-sm">
          <UnlockFactorTabs onUnlocked={onUnlocked} />
        </div>
      </div>
    </div>
  )
}
