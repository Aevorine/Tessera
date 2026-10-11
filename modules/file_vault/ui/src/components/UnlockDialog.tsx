import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Tabs, TabsContent } from '@/components/ui/tabs'
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

// The unwrapped IMK never leaves the Python backend; this dialog only reports "unlock succeeded".
export function UnlockDialog({
  open,
  onOpenChange,
  onUnlocked,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onUnlocked: () => void
}) {
  const { t } = useTranslation('login')
  const biometric = useBiometricStatus()
  // 受控，理由和登录页一样：生物识别用不了时要能从代码里把标签切到密码。
  const [factor, setFactor] = useState<string>(DEFAULT_UNLOCK_FACTOR)

  // 每次打开都从生物识别档重来：本弹窗整个会话只挂载一次，不重置的话上次因不可用而切到的密码档会一直
  // 留着。
  useEffect(() => {
    if (open) setFactor(DEFAULT_UNLOCK_FACTOR)
  }, [open])

  function handleUnlocked() {
    // Order matters: call onUnlocked() before closing, so a caller keyed off onOpenChange
    // sees success before the close event.
    onUnlocked()
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* 跟登录页那张 760px 的卡同一个量级：同样的五等分标签栏、同样的输入框，
          在弹窗里突然窄一档的话，同一件事在两处看起来就是两个界面。 */}
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t('unlockTitle')}</DialogTitle>
        </DialogHeader>
        {/* 因子顺序和登录页完全一致（生物识别在最前），而且**同样自动发起**。
            这里以前刻意不自动弹，理由是"强制复验就该让用户主动做一次验证动作"。
            产品决定反过来：要密码的地方一律先自动弹生物识别，复验也不例外——
            按传感器/刷脸同样是一次主动的、不可代劳的身体动作，安全强度没降低，
            但省掉了"先点一次按钮才开始验证"的空转。

            key={String(open)} 是必需的：BiometricTab 用一个 ref 保证自动验证
            只发起一次，而这个弹窗关掉再打开时并不会卸载，那个 ref 会一直是
            true，第二次复验就再也不自动弹了。用 open 当 key 强制重新挂载。 */}
        <Tabs key={String(open)} value={factor} onValueChange={setFactor}>
          <UnlockFactorTabsList modality={biometric?.preferred} />
          <TabsContent value="fingerprint">
            <BiometricTab
              autoStart={open}
              status={biometric}
              onUnlocked={handleUnlocked}
              onUnavailable={() => setFactor('password')}
              onUseAnotherFactor={() => setFactor('password')}
            />
          </TabsContent>
          <TabsContent value="password">
            <PasswordTab onUnlocked={handleUnlocked} />
          </TabsContent>
          <TabsContent value="totp">
            <TotpTab onUnlocked={handleUnlocked} />
          </TabsContent>
          <TabsContent value="email">
            <EmailTab onUnlocked={handleUnlocked} />
          </TabsContent>
          <TabsContent value="recovery">
            <RecoveryTab onUnlocked={handleUnlocked} />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
