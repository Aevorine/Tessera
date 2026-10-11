import { useCallback, useEffect, useState, type Ref } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { CalendarClock, FolderCog, History, Plus, RotateCcw, Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Badge, EmptyState, PageSection } from '@/components/ui/page'
import { vaultApi } from '@/lib/vaultApi'
import { formatBytes, pccleanErrorKey } from '@/lib/pcclean'
import type {
  PcCleanAuditEntry,
  PcCleanScheduleConfig,
  PcCleanUserRule,
} from '@/shared/pccleanTypes'
import { ActionButton } from '@/components/ActionButton'
import { LABEL_REGIONS } from '@/lib/labelMode'

/**
 * 定时计划 / 自定义规则 / 清理记录：设置一次后很少再开，所以合在工具箱面板底部，不各占导航项。默认
 * 都取最保守：计划默认关、只扫不删；规则默认不勾选匹配文件；记录只读——这里是唯一能"不看着时动手"的
 * 地方。/
 */

const INTERVALS = ['daily', 'weekly', 'monthly'] as const

function formatWhen(seconds: number, locale: string): string {
  if (!seconds) return '—'
  return new Date(seconds * 1000).toLocaleString(locale)
}

export function PcCleanAutomationSections({
  auditSectionRef,
}: {
  /**
   * 「清理记录」块的锚点：页面上方三个历史读数由这份记录算出，点它们要落到这里。
   * 用 ref 传入而非让上面 querySelector，免得结构一改就静默失效。
   */
  auditSectionRef?: Ref<HTMLDivElement>
} = {}) {
  const { t, i18n } = useTranslation('pcclean')

  const [schedule, setSchedule] = useState<PcCleanScheduleConfig | null>(null)
  const [dueAt, setDueAt] = useState(0)
  const [rules, setRules] = useState<PcCleanUserRule[]>([])
  const [audit, setAudit] = useState<PcCleanAuditEntry[]>([])

  const [draftRoot, setDraftRoot] = useState('')
  const [draftPatterns, setDraftPatterns] = useState('')
  const [draftAge, setDraftAge] = useState('7')
  const [draftRecursive, setDraftRecursive] = useState(false)
  const [saving, setSaving] = useState(false)

  const reload = useCallback(async () => {
    try {
      const [scheduleResult, rulesResult, auditResult] = await Promise.all([
        vaultApi.call('pcclean_schedule_get', {}),
        vaultApi.call('pcclean_rules_get', {}),
        vaultApi.call('pcclean_audit_log', { limit: 50 }),
      ])
      setSchedule(scheduleResult.config)
      setDueAt(scheduleResult.due_at)
      setRules(rulesResult.rules)
      setAudit(auditResult.entries)
    } catch {
      /* 这三块都是附加信息，读不到不该弹错误打断用户在工具箱里做的事 */
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const saveSchedule = useCallback(
    async (patch: Partial<PcCleanScheduleConfig>) => {
      if (!schedule) return
      try {
        const next = await vaultApi.call('pcclean_schedule_set', {
          config: { ...schedule, ...patch },
        })
        // 用后端回来的值而不是本地拼的：类别白名单是在后端**无条件**裁剪的，
        // 直接信本地的话，界面会显示一个后端根本不会执行的配置。
        setSchedule(next.config)
        setDueAt(next.due_at)
      } catch {
        toast.error(t('scan.failed'))
      }
    },
    [schedule, t],
  )

  const addRule = useCallback(async () => {
    if (saving) return
    setSaving(true)
    try {
      const result = await vaultApi.call('pcclean_rules_upsert', {
        rule: {
          root: draftRoot,
          patterns: draftPatterns.split(',').map((p) => p.trim()).filter(Boolean),
          min_age_days: Number(draftAge) || 0,
          recursive: draftRecursive,
        },
      })
      if (!result.ok) {
        // 后端回的是具体原因的 i18n 键（「这是系统目录」），不是笼统的
        // 「规则不合法」——后者帮不了用户改对它。
        toast.error(t(pccleanErrorKey(result.error)))
        return
      }
      setRules(result.rules)
      setDraftRoot('')
      setDraftPatterns('')
    } catch {
      toast.error(t('scan.failed'))
    } finally {
      setSaving(false)
    }
  }, [draftAge, draftPatterns, draftRecursive, draftRoot, saving, t])

  const removeRule = useCallback(async (ruleId: string) => {
    try {
      const result = await vaultApi.call('pcclean_rules_remove', { rule_id: ruleId })
      setRules(result.rules)
    } catch {
      toast.error(t('scan.failed'))
    }
  }, [t])

  const undoSession = useCallback(async (sessionId: string) => {
    try {
      await vaultApi.call('pcclean_undo', { session_id: sessionId })
      toast.success(t('undo.run'))
      void reload()
    } catch {
      toast.error(t('undo.notUndoable'))
    }
  }, [reload, t])

  // 勾选状态存 session_id 而非下标：删完列表会重排，存下标会让剩下的勾挪到别的记录上、删错且事后难查
  // 。
  const [selectedSessions, setSelectedSessions] = useState<Set<string>>(new Set())
  const [deleting, setDeleting] = useState(false)

  // 列表变了就把已经不存在的 id 从选中集合里摘掉，否则「已选 3 条」会一直
  // 显示着几条早就没了的记录。
  useEffect(() => {
    setSelectedSessions((prev) => {
      if (prev.size === 0) return prev
      const alive = new Set(audit.map((entry) => entry.session_id))
      const next = new Set<string>()
      for (const id of prev) if (alive.has(id)) next.add(id)
      return next.size === prev.size ? prev : next
    })
  }, [audit])

  const allAuditSelected = audit.length > 0 && selectedSessions.size === audit.length

  const toggleAllAudit = useCallback((checked: boolean) => {
    setSelectedSessions(checked ? new Set(audit.map((entry) => entry.session_id)) : new Set())
  }, [audit])

  const toggleOneAudit = useCallback((sessionId: string) => {
    setSelectedSessions((prev) => {
      const next = new Set(prev)
      if (next.has(sessionId)) next.delete(sessionId)
      else next.add(sessionId)
      return next
    })
  }, [])

  /** 删一条或删一批走同一个接口；全选后删除 = 把当前所有 id 传进去。 */
  const deleteSessions = useCallback(async (sessionIds: string[]) => {
    if (sessionIds.length === 0 || deleting) return
    setDeleting(true)
    try {
      // 用后端回来的列表整体替换，而不是本地 filter：万一某条因为文件被占用
      // 没删掉，本地 filter 会让它"看起来删掉了"，下次进页面又冒出来。
      const result = await vaultApi.call('pcclean_audit_delete', { session_ids: sessionIds })
      setAudit(result.entries)
      setSelectedSessions(new Set())
      toast.success(t('audit.deletedToast', { count: result.removed }))
    } catch {
      toast.error(t('scan.failed'))
    } finally {
      setDeleting(false)
    }
  }, [deleting, t])

  return (
    <>
      <PageSection
        icon={CalendarClock}
        title={t('schedule.title')}
        tone="neutral"
      >
        <div className="space-y-4">
          <Alert>
            <AlertDescription className="text-2xs leading-5">
              {t('schedule.appMustBeOpen')}
            </AlertDescription>
          </Alert>

          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2.5">
              <Checkbox
                id="schedule-enabled"
                checked={schedule?.enabled ?? false}
                onCheckedChange={(next) => void saveSchedule({ enabled: next === true })}
              />
              <Label htmlFor="schedule-enabled" className="text-sm">
                {t('schedule.title')}
              </Label>
            </div>

            <Select
              value={schedule?.interval ?? 'weekly'}
              onValueChange={(value) =>
                void saveSchedule({ interval: value as PcCleanScheduleConfig['interval'] })
              }
            >
              <SelectTrigger className="w-40">
                <SelectValue placeholder={t('schedule.interval')} />
              </SelectTrigger>
              <SelectContent>
                {INTERVALS.map((interval) => (
                  <SelectItem key={interval} value={interval}>
                    {t(`schedule.${interval}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select
              value={schedule?.mode ?? 'scan'}
              onValueChange={(value) =>
                void saveSchedule({ mode: value as PcCleanScheduleConfig['mode'] })
              }
            >
              <SelectTrigger className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="scan">{t('schedule.modeScan')}</SelectItem>
                <SelectItem value="clean">{t('schedule.modeClean')}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {schedule?.mode === 'clean' && (
            <p className="max-w-[70ch] text-2xs leading-5 text-muted-foreground">
              {t('schedule.modeHint')}
            </p>
          )}

          <div className="flex flex-wrap gap-x-6 gap-y-1 text-2xs text-muted-foreground">
            <span>
              {t('schedule.lastRun')}{' '}
              <span className="tabular">
                {formatWhen(schedule?.last_run ?? 0, i18n.language)}
              </span>
            </span>
            <span>
              {t('schedule.nextRun')}{' '}
              <span className="tabular">
                {schedule?.enabled ? formatWhen(dueAt, i18n.language) : '—'}
              </span>
            </span>
          </div>
        </div>
      </PageSection>

      <PageSection
        icon={FolderCog}
        title={t('rules.title')}
        tone="neutral"
      >
        <div className="space-y-4">
          <p className="max-w-[70ch] text-2xs leading-5 text-muted-foreground">
            {t('rules.safetyNote')}
          </p>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="space-y-1.5 lg:col-span-2">
              <Label htmlFor="rule-root" className="text-sm">{t('rules.root')}</Label>
              <Input
                id="rule-root"
                value={draftRoot}
                onChange={(event) => setDraftRoot(event.target.value)}
                placeholder="D:\Render\cache"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rule-patterns" className="text-sm">{t('rules.patterns')}</Label>
              <Input
                id="rule-patterns"
                value={draftPatterns}
                onChange={(event) => setDraftPatterns(event.target.value)}
                placeholder="*.log, *.tmp"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rule-age" className="text-sm">{t('rules.minAge')}</Label>
              <Input
                id="rule-age"
                className="tabular"
                value={draftAge}
                onChange={(event) => setDraftAge(event.target.value)}
                inputMode="numeric"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2.5">
              <Checkbox
                id="rule-recursive"
                checked={draftRecursive}
                onCheckedChange={(next) => setDraftRecursive(next === true)}
              />
              <Label htmlFor="rule-recursive" className="text-sm">
                {t('rules.recursive')}
              </Label>
            </div>
            <Button
              className="ml-auto"
              onClick={addRule}
              disabled={saving || !draftRoot || !draftPatterns}
            >
              <Plus className="size-4" aria-hidden="true" />
              {t('rules.add')}
            </Button>
          </div>

          {rules.length === 0 ? (
            <EmptyState icon={FolderCog} title={t('rules.title')} />
          ) : (
            <ul className="divide-y divide-border/50 rounded-lg border border-border/70">
              {rules.map((rule) => (
                <li key={rule.rule_id} className="flex items-start gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-medium">{rule.label}</span>
                      {rule.recursive && <Badge tone="neutral">{t('rules.recursive')}</Badge>}
                    </div>
                    <p className="truncate text-2xs text-muted-foreground" title={rule.root}>
                      {rule.root}
                    </p>
                    <p className="text-2xs text-muted-foreground">
                      {rule.patterns.join(', ')} ·{' '}
                      <span className="tabular">{rule.min_age_days}</span>
                      <span className="tabular-unit">{t('rules.minAge')}</span>
                    </p>
                  </div>
                  <ActionButton
                    label={t('rules.remove')}
                    icon={Trash2}
                    region={LABEL_REGIONS.pcCleanSection}
                    onClick={() => removeRule(rule.rule_id)}
                    stopPropagation
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      </PageSection>

      {/* 这层 div 只是给上面那三个历史读数当落点用的锚（scrollIntoView），
          不带任何样式：它是 PageShell 那列 flex 的一个子项，跟原来的 PageSection
          占的是同一格，间距一格不变。 */}
      <div ref={auditSectionRef}>
      <PageSection
        icon={History}
        title={t('audit.title')}
        tone="neutral"
        padded={false}
      >
        {audit.length === 0 ? (
          <div className="p-6">
            <EmptyState icon={History} title={t('audit.empty')} />
          </div>
        ) : (
          <>
            {/* 全选 + 批量删除条。跟笔记、密码那几处的多选条同一套结构和措辞，
                同一个动作在不同面板长得不一样是这套界面最容易被吐槽的地方。 */}
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/50 px-4 py-2.5">
              <label className="flex cursor-pointer items-center gap-2.5 text-sm">
                <Checkbox
                  checked={allAuditSelected}
                  onCheckedChange={(next) => toggleAllAudit(next === true)}
                  aria-label={t('audit.selectAll')}
                />
                <span>{t('audit.selectAll')}</span>
                <span className="text-2xs text-muted-foreground">
                  {t('audit.selectedCount', { count: selectedSessions.size, total: audit.length })}
                </span>
              </label>
              <Button
                variant="destructive"
                size="sm"
                disabled={deleting || selectedSessions.size === 0}
                onClick={() => void deleteSessions([...selectedSessions])}
                title={t('audit.deleteHint')}
              >
                <Trash2 className="size-4" aria-hidden="true" />
                {t('audit.deleteSelected')}
              </Button>
            </div>
            <ul className="divide-y divide-border/50">
              {audit.map((entry) => (
                <li key={entry.session_id} className="flex items-center gap-3 px-4 py-3">
                  <Checkbox
                    checked={selectedSessions.has(entry.session_id)}
                    onCheckedChange={() => toggleOneAudit(entry.session_id)}
                    aria-label={formatWhen(entry.ts, i18n.language)}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm">
                      <span className="tabular">{formatWhen(entry.ts, i18n.language)}</span>
                    </p>
                    <p className="text-2xs text-muted-foreground">
                      {t('audit.freed')}{' '}
                      <span className="tabular">{formatBytes(entry.freed_bytes)}</span>
                      {' · '}
                      {Object.entries(entry.by_category)
                        .map(([category, count]) => `${t(`category.${category}`)} ${count}`)
                        .join(' · ')}
                    </p>
                  </div>
                  {/* 只有含可撤销改动的那些批次才给按钮。永久删除的批次给一个点了
                      没反应的"撤销"，比不给按钮更让人恼火。 */}
                  {(entry.by_reversibility?.restorable ?? 0) > 0 && (
                    <Button variant="ghost" size="sm" onClick={() => undoSession(entry.session_id)}>
                      <RotateCcw className="size-4" aria-hidden="true" />
                      {t('undo.run')}
                    </Button>
                  )}
                  {/* 单条删除。删记录不等于删数据：撤销日志照旧留着，
                      这条记录还原得回来的东西一样还原得回来。 */}
                  {/* 这颗在批量删除进行中是禁用的，而禁用的按钮不派发 pointer
                      事件——原生 title= 在那一刻同样弹不出来。ActionButton 给禁用态
                      套了一层还能收 hover 的包装，所以走它。 */}
                  <ActionButton
                    label={t('audit.deleteOne')}
                    icon={Trash2}
                    region={LABEL_REGIONS.pcCleanSection}
                    disabled={deleting}
                    onClick={() => void deleteSessions([entry.session_id])}
                    stopPropagation
                  />
                </li>
              ))}
            </ul>
          </>
        )}
      </PageSection>
      </div>
    </>
  )
}
