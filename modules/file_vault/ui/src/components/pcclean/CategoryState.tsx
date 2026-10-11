import { useTranslation } from 'react-i18next'

import { Badge } from '@/components/ui/page'
import { cn } from '@/lib/utils'
import { categoryHint, formatCount, type CategoryOutcome } from '@/lib/pcclean'
import type { PcCleanScanResult } from '@/shared/pccleanTypes'

/**
 * 统一显示「这一类扫完之后到底怎么样」。此前这四种情形都是同一格空列表：真的干净、全程被权限挡住、
 * 根本没跑起来、扫失败且错误被吞。后三种是 bug，混成空白会把"功能坏了"伪装成"电脑很干净"。
 * 靠后端三个计数区分（`scanned_dirs` / `scanned_files` / `denied`，见 pcclean/paths.py）：
 * 0 项 + 检查 12,431 处是好消息，0 项 + 检查 0 处是要修的。
 */

/**
 * 类目详情卡顶部一行，固定三段：这一类是什么 → 这一轮的结论 → 证据。证据永远最后且始终显示，供核对
 * 检查了多少地方。
 */
export function CategoryStateLine({
  category,
  report,
  outcome,
  className,
}: {
  category: string
  report?: PcCleanScanResult
  outcome: CategoryOutcome
  className?: string
}) {
  const { t } = useTranslation('pcclean')
  const hint = categoryHint(t, category)
  const dirs = report?.scanned_dirs ?? 0
  const files = report?.scanned_files ?? 0
  const denied = report?.denied ?? 0

  return (
    <div className={cn('border-b border-border/70 px-4 py-2.5', className)}>
      {/* 类目说明。缺文案时整行不渲染 —— 显示一行 `categoryHint.volumes`
          比不显示更糟，它既没信息又占地方还让人以为界面坏了。 */}
      {hint && <p className="text-2xs leading-5 text-muted-foreground">{hint}</p>}

      {outcome === 'clean' && (
        <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs leading-5">
          <span className="font-medium text-success">{t('outcome.clean')}</span>
          <span className="text-muted-foreground">
            {t('outcome.cleanHint', { count: dirs + files })}
          </span>
        </p>
      )}

      {outcome === 'blocked' && (
        <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs leading-5">
          <span className="font-medium text-warning">{t('outcome.blocked')}</span>
          <span className="text-muted-foreground">{t('outcome.blockedHint', { count: denied })}</span>
        </p>
      )}

      {outcome === 'skipped' && (
        <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs leading-5">
          <span className="font-medium text-warning">{t('outcome.skipped')}</span>
          <span className="text-muted-foreground">{t('outcome.skippedHint')}</span>
        </p>
      )}

      {/* 证据行。**扫到东西的时候也显示** —— 它回答的是"你查了多少地方"，
          跟"你找到了多少"是两个问题，后者永远替代不了前者。 */}
      {(dirs > 0 || files > 0) && (
        <p className="mt-1 text-2xs leading-5 text-muted-foreground">
          {t('outcome.evidence', { dirs: formatCount(dirs), files: formatCount(files) })}
          {denied > 0 && outcome !== 'blocked' && (
            <> · {t('outcome.deniedSome', { count: denied })}</>
          )}
        </p>
      )}
    </div>
  )
}

/** 总览格里那一小段状态文字。空间只够一行，所以只给结论不给证据。 */
export function CategoryOutcomeBadge({ outcome }: { outcome: CategoryOutcome }) {
  const { t } = useTranslation('pcclean')
  if (outcome === 'clean') return <Badge tone="success">{t('outcome.clean')}</Badge>
  if (outcome === 'blocked') return <Badge tone="warning">{t('outcome.blocked')}</Badge>
  if (outcome === 'skipped') return <Badge tone="warning">{t('outcome.skipped')}</Badge>
  return null
}
