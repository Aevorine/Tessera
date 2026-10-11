import { useTranslation } from 'react-i18next'
import { DiagnosticLogSection } from '@/components/DiagnosticLogSection'
import { PageHeader, PageShell } from '@/components/ui/page'

/**
 * 故障日志独立页面，导航栏直达，列表高度随窗口。与设置页卡片是同一组件（`variant` 只换外壳），状态
 * 天然一致。
 */
export function DiagnosticLogScreen() {
  const { t } = useTranslation('settings')

  return (
    <PageShell width="canvas">
      <PageHeader title={t('diagLogTitle')} />
      <DiagnosticLogSection variant="page" />
    </PageShell>
  )
}
