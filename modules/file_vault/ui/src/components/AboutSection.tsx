import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { ExternalLink, FolderOpen } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { InfoHint } from '@/components/ui/info-hint'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { vaultApi } from '@/lib/vaultApi'
import { electronApi } from '@/lib/electronApi'
import { translateError } from '@/i18n/errors'
import thirdParty from '@/generated/third-party.json'
import { FeatureTitle } from '@/components/ui/page'

const REPO_URL = 'https://github.com/Aevorine/Tessera'

/**
 * 「关于」页：版本号、许可证、数据位置、第三方组件。
 * 兑现三个承诺：LICENSING.md 说第三方组件清单在应用内可见；社区版须在此明确写着 AGPL-3.0，
 * 用户才知道拿的是哪一份授权；
 * 数据目录必须可见（用户会问「我的密码存在哪」）。
 */
export function AboutSection() {
  const { t } = useTranslation('settings')
  const [version, setVersion] = useState<string>('')
  const [dataDir, setDataDir] = useState<{
    path: string
    source: 'env' | 'configured' | 'default'
    pending_move_from: string | null
    can_change: boolean
  } | null>(null)
  const [moving, setMoving] = useState(false)
  const [showComponents, setShowComponents] = useState(false)

  useEffect(() => {
    electronApi.getAppVersion().then(setVersion).catch(() => setVersion(''))
    vaultApi.call('data_dir_info', {}).then(setDataDir).catch(() => setDataDir(null))
  }, [])

  const components = useMemo(
    () => [...thirdParty.components].sort((a, b) => a.name.localeCompare(b.name)),
    [],
  )

  async function openLink(url: string) {
    const res = await electronApi.openExternalLink(url)
    if (!res.ok) toast.error(t('aboutLinkBlockedToast'))
  }

  async function handleChangeDataDir() {
    const picked = await electronApi.openDirectory({ title: t('aboutDataDirPickTitle') })
    if (!picked) return
    setMoving(true)
    try {
      const res = await vaultApi.call('data_dir_move', { path: picked })
      // 刻意用 toast.info 而不是 success：搬家**还没发生**。说"成功"会让用户
      // 以为可以直接去新目录找文件，而那里现在还是空的。
      toast.info(t('aboutDataDirMoveQueuedToast'), {
        description: t('aboutDataDirMoveQueuedHint', { from: res.from, to: res.to }),
        duration: 12000,
      })
      setDataDir((prev) => (prev ? { ...prev, pending_move_from: res.from } : prev))
    } catch (err) {
      const code = err instanceof Error ? err.message : String(err)
      toast.error(t('aboutDataDirMoveFailedToast'), { description: translateError(code) })
    } finally {
      setMoving(false)
    }
  }

  return (
    <div className="space-y-3 rounded-lg border border-border bg-surface p-4">
      <div>
        {/* 分区标题走四号，跟全应用其它「功能名称」同一档。原来只写了
            font-heading 没给字号，于是它跟正文一样大——一个分区的标题跟它
            自己的正文分不出层级，正是「界面不统一」最典型的样子。 */}
        <FeatureTitle as="p">{t('aboutTitle')}</FeatureTitle>
        <p className="text-sm text-muted-foreground">
          {version ? t('aboutVersion', { version }) : t('aboutVersionUnknown')}
        </p>
      </div>

      {/* ---- 许可证 ---- */}
      <div className="space-y-1.5 rounded-lg border border-border bg-card p-3">
        <p className="flex items-center gap-1.5 text-sm font-medium">
          {t('aboutLicenseTitle')}
          <InfoHint text={t('aboutLicenseBody')} />
        </p>
        <div className="flex flex-wrap gap-2 pt-1">
          <Button variant="outline" size="sm" onClick={() => openLink(`${REPO_URL}/blob/main/LICENSE`)}>
            <ExternalLink className="size-4" />
            {t('aboutLicenseAgplButton')}
          </Button>
          <Button variant="outline" size="sm" onClick={() => openLink(`${REPO_URL}/blob/main/LICENSE-COMMERCIAL.md`)}>
            <ExternalLink className="size-4" />
            {t('aboutLicenseCommercialButton')}
          </Button>
          <Button variant="outline" size="sm" onClick={() => openLink(REPO_URL)}>
            <ExternalLink className="size-4" />
            {t('aboutProjectHomeButton')}
          </Button>
          {/* 连接指南放在这里而不是跨设备面板里：连不上的时候用户往往先来「关于」
              找版本号和项目页，顺手就能看到排查入口。 */}
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              openLink(`${REPO_URL}/blob/main/modules/file_vault/crossdevice/docs/06-连接指南.md`)
            }
          >
            <ExternalLink className="size-4" />
            {t('aboutConnectionGuideButton')}
          </Button>
        </div>
      </div>

      {/* ---- 数据位置 ---- */}
      <div className="space-y-1.5 rounded-lg border border-border bg-card p-3">
        <p className="text-sm font-medium">{t('aboutDataDirTitle')}</p>
        <p className="break-all font-mono text-sm text-muted-foreground">{dataDir?.path ?? '…'}</p>
        {dataDir && (
          <p className="text-sm text-muted-foreground">
            {dataDir.source === 'env'
              ? t('aboutDataDirSourceEnv')
              : dataDir.source === 'configured'
                ? t('aboutDataDirSourceConfigured')
                : t('aboutDataDirSourceDefault')}
          </p>
        )}
        {dataDir?.pending_move_from && (
          <Alert>
            <AlertDescription className="text-sm">
              {t('aboutDataDirPendingMove', { from: dataDir.pending_move_from, to: dataDir.path })}
            </AlertDescription>
          </Alert>
        )}
        <div className="flex flex-wrap gap-2 pt-1">
          <Button
            variant="outline"
            size="sm"
            disabled={!dataDir}
            onClick={() => dataDir && electronApi.openPath(dataDir.path)}
          >
            <FolderOpen className="size-4" />
            {t('aboutDataDirOpenButton')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!dataDir?.can_change || moving}
            onClick={handleChangeDataDir}
          >
            {moving ? t('aboutDataDirMoving') : t('aboutDataDirChangeButton')}
          </Button>
        </div>
      </div>

      {/* ---- 第三方组件 ----
          默认折叠：六十多条对绝大多数人是噪音，但对做合规审查的人是必需品。
          折叠而不是"想看去 GitHub 看"——归属声明必须在软件本身里能看到。
          条数走 components.length，不写死——写死过一次（"46 条"），随后清单
          从 45 补到 64，注释就成了假的。 */}
      <div className="space-y-1.5 rounded-lg border border-border bg-card p-3">
        <button
          type="button"
          className="w-full text-left text-sm font-medium hover:underline"
          onClick={() => setShowComponents((v) => !v)}
          aria-expanded={showComponents}
        >
          {t('aboutThirdPartyTitle', { count: components.length })}
        </button>
        {showComponents && (
          <div className="max-h-64 space-y-1 overflow-y-auto pt-1">
            {components.map((c) => (
              <div key={`${c.name}-${c.license}`} className="flex justify-between gap-3 text-sm">
                <span className="truncate">{c.name}</span>
                <span className="shrink-0 text-muted-foreground">{c.license}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
