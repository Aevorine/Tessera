import { AlertTriangle, CheckCircle2, CircleHelp, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import {
  Badge,
  EmptyState,
  HERO_VALUE_CLASS,
  NUMERIC_CLASS,
  PageColumns,
  PageHeader,
  PageSection,
  PageShell,
} from '@/components/ui/page'
import { FORMULAS, Formula } from '@/components/ui/formula'
import { vaultApi } from '@/lib/vaultApi'
import type { SecurityHealthCheck, VaultMethods } from '@/shared/ipcTypes'
import { cn } from '@/lib/utils'

/**
 * 安全体检：唯一要回答"我现在安全吗，下一步该做什么"，把原先散在六处的安全状态汇总。
 * 评分规则原样展示（每项满分、得分，相加即总分，无隐藏加权），不可检查的分数是有害的；
 * test_security_health.py 守这一点。"查不到"单独一档：灰显、不进分母，页面说明未测项数，
 * 避免没开跨设备被扣分、让分数滑向"开了多少功能"。
 */

// 这两个形状唯一定义在 shared/ipcTypes.ts，对齐后端签名；
// 在此另抄一份，后端加字段时 TypeScript 不会报错，新项会在界面上永远不显示。
type HealthCheck = SecurityHealthCheck

type HealthReport = Extract<VaultMethods['security_health']['result'], { ok: true }>

const STATUS_ICON = {
  good: CheckCircle2,
  warn: AlertTriangle,
  bad: AlertTriangle,
  unknown: CircleHelp,
} as const

const STATUS_TONE = {
  good: 'success',
  warn: 'warning',
  bad: 'danger',
  unknown: 'neutral',
} as const

export function SecurityHealthScreen() {
  const { t } = useTranslation('security')
  const [report, setReport] = useState<HealthReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      // 跨设备几项后端看不到（守护进程归 Electron 主进程），先在此采集随请求交上去；
      // 评分逻辑只在 Python 一份，避免两端各算一半得出不同分数。
      const clientFacts = await collectClientFacts()
      const res = await vaultApi.call('security_health', { clientFacts })
      if (!res?.ok) {
        setError(res?.error ?? 'unknown')
        setReport(null)
      } else {
        setReport(res)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setReport(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const actionable = report?.checks.filter((c) => c.status === 'bad' || c.status === 'warn') ?? []
  const passing = report?.checks.filter((c) => c.status === 'good') ?? []
  const unknown = report?.checks.filter((c) => c.status === 'unknown') ?? []

  return (
    <PageShell width="canvas">
      <PageHeader
        title={t('title')}
        actions={
          <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>
            <RefreshCw className={cn('mr-2 size-4', loading && 'animate-spin')} />
            {t('refresh')}
          </Button>
        }
      />

      {error && (
        <PageSection tone="danger" title={t('failedTitle')}>
          <p className="text-sm text-muted-foreground">{error}</p>
        </PageSection>
      )}

      {report && (
        <PageColumns>
          <ScoreBlock report={report} />

          <PageSection
            title={t('sections.actionable')}
            tone={actionable.length ? 'warning' : 'success'}
            padded={false}
          >
            {actionable.length === 0 ? (
              <EmptyState icon={CheckCircle2} title={t('allClear')} />
            ) : (
              <ul className="divide-y divide-border/70">
                {actionable.map((check) => (
                  <CheckRow key={check.id} check={check} />
                ))}
              </ul>
            )}
          </PageSection>

          {passing.length > 0 && (
            <PageSection
              title={t('sections.passing', { count: passing.length })}
              tone="success"
              padded={false}
              collapsible
              defaultExpanded={false}
              storageKey="security-health-passing"
            >
              <ul className="divide-y divide-border/70">
                {passing.map((check) => (
                  <CheckRow key={check.id} check={check} />
                ))}
              </ul>
            </PageSection>
          )}

          {unknown.length > 0 && (
            <PageSection
              title={t('sections.unknown', { count: unknown.length })}
              tone="neutral"
              padded={false}
              collapsible
              defaultExpanded={false}
              storageKey="security-health-unknown"
            >
              <ul className="divide-y divide-border/70">
                {unknown.map((check) => (
                  <CheckRow key={check.id} check={check} />
                ))}
              </ul>
            </PageSection>
          )}
        </PageColumns>
      )}
    </PageShell>
  )
}

function ScoreBlock({ report }: { report: HealthReport }) {
  const { t } = useTranslation('security')
  // -1 = 一项都测不到。给 0 分等于说"你很不安全"，给 100 分是撒谎。
  const unmeasurable = report.score < 0
  return (
    <PageSection tone={unmeasurable ? 'neutral' : gradeTone(report.grade)}>
      <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
        <div>
          <p className={HERO_VALUE_CLASS}>
            {unmeasurable ? '—' : report.score}
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            {unmeasurable ? t('unmeasurable') : t(`grade.${report.grade}`)}
          </p>
        </div>
        {!unmeasurable && (
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <p className="text-sm text-muted-foreground">
              {t('scoreBasis', { scored: report.scoredWeight, total: report.totalWeight })}
            </p>
            {/* 算法本身摆出来，而不是用一句话描述它——公式没有歧义，
                而"按权重加权平均"这句话有好几种读法。 */}
            <Formula tex={FORMULAS.healthScore} label={t('scoreFormulaLabel')} />
          </div>
        )}
      </div>
    </PageSection>
  )
}

function gradeTone(grade: string) {
  if (grade === 'excellent' || grade === 'good') return 'success' as const
  if (grade === 'fair') return 'warning' as const
  return 'danger' as const
}

function CheckRow({ check }: { check: HealthCheck }) {
  const { t } = useTranslation('security')
  const Icon = STATUS_ICON[check.status]
  return (
    <li className="flex items-start gap-3 px-6 py-4">
      <Icon
        aria-hidden="true"
        className={cn(
          'mt-0.5 size-4 shrink-0',
          check.status === 'good' && 'text-success',
          check.status === 'warn' && 'text-warning',
          check.status === 'bad' && 'text-destructive',
          check.status === 'unknown' && 'text-muted-foreground',
        )}
      />
      {/* 这一列是整块正文。页面铺满之后行长必须自己限住——`max-w-[85ch]`
          管的是**一行有多少字**，不是这一栏有多宽：分数徽章仍然靠右贴边，
          只是文字不再一路排到它跟前。 */}
      <div className="min-w-0 flex-1">
        <p className="max-w-[85ch] text-sm font-medium">{t(`check.${check.id}.title`)}</p>
        {/* detail 的键由后端给（比如 "kdf.legacy"），参数也由后端给。
            后端返回中文串的话，切成英文界面时这一屏会变成中英混排。 */}
        <p className="mt-1 max-w-[85ch] text-sm text-muted-foreground">
          {t(`detail.${check.detailKey}`, check.detailArgs ?? {})}
        </p>
        {check.status !== 'good' && check.status !== 'unknown' && (
          <p className="mt-1.5 max-w-[85ch] text-sm">{t(`fix.${check.id}`)}</p>
        )}
      </div>
      <Badge tone={STATUS_TONE[check.status]} className="shrink-0">
        <span className={NUMERIC_CLASS}>
          {check.status === 'unknown' ? '—' : `${check.earned}/${check.weight}`}
        </span>
      </Badge>
    </li>
  )
}

/**
 * 采集界面侧才知道的事实。拿不到时必须留 null，不能兜 false：
 * 把"跨设备没在跑所以查不到"当成"走中继"会凭空扣分，用户无从修复。
 */
async function collectClientFacts(): Promise<Record<string, unknown>> {
  const facts: Record<string, unknown> = {}

  try {
    const api = window.crossDeviceAPI
    if (api) {
      const availability = await api.available()
      facts.crossdeviceRunning = availability?.available ?? null
      if (availability?.available) {
        const devices = await api.call<{ devices?: Array<{ via?: string; relayed?: boolean }> }>(
          'list_devices',
        )
        const list = devices?.devices ?? []
        facts.crossdevicePairedDevices = list.length
        const online = list.filter((d) => d.via || d.relayed != null)
        // 只要**有一台**还在走中继就报中继。取"多数"或"最后一台"都会让提示
        // 在多设备场景下时准时不准，而用户没法判断这次显示的是哪一台。
        facts.crossdeviceLastPathDirect = online.length ? online.every((d) => !d.relayed) : null
      }
    }
  } catch {
    // 留 null。见函数头。
  }

  try {
    const info = await window.electronAPI?.getSignatureStatus?.()
    if (info && typeof info.verified === 'boolean') facts.signatureVerified = info.verified
  } catch {
    /* 留 null */
  }

  return facts
}
