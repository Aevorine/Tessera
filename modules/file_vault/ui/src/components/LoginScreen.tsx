import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ShieldCheck } from 'lucide-react'
import { Tabs, TabsContent } from '@/components/ui/tabs'
import { LanguageSwitcher } from '@/components/LanguageSwitcher'
import {
  BiometricTab,
  DEFAULT_UNLOCK_FACTOR,
  EmailTab,
  PasswordTab,
  RecoveryTab,
  TotpTab,
  UnlockFactorTabsList,
} from '@/components/UnlockTabs'
import { useBiometricStatus } from '@/lib/useBiometricStatus'
import { useWindowActivation } from '@/lib/useWindowActivation'
import { PageTitle, Wordmark } from '@/components/ui/page'

export function LoginScreen({ onUnlocked }: { onUnlocked: () => void }) {
  const { t } = useTranslation('login')
  // 受控而不是 defaultValue：机器上用不了生物识别时要能从代码里切走（见下面的
  // onUnavailable）。非受控的 Tabs 挂载后就再也改不动了。
  const [factor, setFactor] = useState<string>(DEFAULT_UNLOCK_FACTOR)
  const biometric = useBiometricStatus()
  const activation = useWindowActivation()
  const usable = Boolean(biometric?.available && biometric.bound)

  // 窗口每次被重新唤出（托盘、快捷键、任务栏），都回到生物识别并立即发起。
  // 上一次自动尝试超时后切到了密码，这次用户回来时不该还停在密码框上。
  useEffect(() => {
    if (activation.generation > 0 && activation.visible && usable) setFactor(DEFAULT_UNLOCK_FACTOR)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activation.generation])

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
          <Tabs value={factor} onValueChange={setFactor}>
            <UnlockFactorTabsList modality={biometric?.preferred} />
            <TabsContent value="fingerprint">
              <BiometricTab
                autoStart
                status={biometric}
                onUnlocked={onUnlocked}
                onUnavailable={() => setFactor('password')}
                onUseAnotherFactor={() => setFactor('password')}
              />
            </TabsContent>
            <TabsContent value="password">
              <PasswordTab onUnlocked={onUnlocked} />
            </TabsContent>
            <TabsContent value="totp">
              <TotpTab onUnlocked={onUnlocked} />
            </TabsContent>
            <TabsContent value="email">
              <EmailTab onUnlocked={onUnlocked} />
            </TabsContent>
            <TabsContent value="recovery">
              <RecoveryTab onUnlocked={onUnlocked} />
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </div>
  )
}
