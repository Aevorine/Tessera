import { useTranslation } from 'react-i18next'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { UnlockFactorTabs } from '@/components/UnlockTabs'

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
        {/* key：弹窗关掉不卸载，重新打开要从第一个因子重来并再次自动发起 */}
        <UnlockFactorTabs key={String(open)} active={open} onUnlocked={handleUnlocked} />
      </DialogContent>
    </Dialog>
  )
}
