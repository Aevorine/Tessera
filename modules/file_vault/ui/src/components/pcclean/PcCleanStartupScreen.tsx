import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  Activity,
  Ban,
  Clock,
  Crosshair,
  Loader2,
  MousePointerClick,
  Plus,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { StatTile } from '@/components/StatTile'
import { Badge, PageHeader, PageSection, PageShell } from '@/components/ui/page'
import { CleanItemList } from '@/components/pcclean/CleanItemList'
import { vaultApi } from '@/lib/vaultApi'
import { formatBytes, nextScanId, pccleanErrorKey, scan, toggleIn } from '@/lib/pcclean'
import type {
  PcCleanItem,
  PcCleanPopupStatus,
  PcCleanScanResult,
  PcCleanWindow,
} from '@/shared/pccleanTypes'
import { ActionButton } from '@/components/ActionButton'
import { LABEL_REGIONS } from '@/lib/labelMode'

/**
 * 启动与右键：开机自启 / 右键菜单 / 弹窗拦截，共同回答"我没主动开任何东西时电脑在替谁干活"。
 * 三处都只禁用不删除，界面必须让这点显而易见——用户敢不敢点开关取决于知不知道能改回来。
 */

export function PcCleanStartupScreen() {
  const { t } = useTranslation('pcclean')
  const [tab, setTab] = useState('startup')

  return (
    <PageShell width="canvas">
      <PageHeader
        title={t('startup.title')}
      />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="startup">{t('category.startup')}</TabsTrigger>
          <TabsTrigger value="menu">{t('category.contextMenu')}</TabsTrigger>
          <TabsTrigger value="popup">{t('popup.title')}</TabsTrigger>
        </TabsList>
        <TabsContent value="startup"><StartupTab /></TabsContent>
        <TabsContent value="menu"><ContextMenuTab /></TabsContent>
        <TabsContent value="popup"><PopupTab /></TabsContent>
      </Tabs>
    </PageShell>
  )
}

function useDisableList(category: 'startup' | 'contextMenu', prefix: string) {
  const { t } = useTranslation('pcclean')
  const [report, setReport] = useState<PcCleanScanResult | null>(null)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [applying, setApplying] = useState(false)

  const run = useCallback(async () => {
    setBusy(true)
    setSelected(new Set())
    try {
      const result = await scan(category, {}, nextScanId(prefix))
      if (result.ok) setReport(result)
      else toast.error(t(pccleanErrorKey(result.error)))
    } catch {
      toast.error(t('scan.failed'))
    } finally {
      setBusy(false)
    }
  }, [category, prefix, t])

  useEffect(() => {
    void run()
  }, [run])

  const apply = useCallback(async () => {
    if (selected.size === 0) return
    setApplying(true)
    try {
      const outcome = await vaultApi.call('pcclean_execute', {
        item_ids: Array.from(selected),
        options: { create_restore_point: true },
      })
      if (outcome.aborted) {
        toast.error(t(pccleanErrorKey(outcome.aborted)))
      } else if (outcome.failed > 0 || outcome.skipped > 0) {
        toast.warning(
          t('health.partial', {
            size: formatBytes(outcome.freed_bytes),
            failed: outcome.failed,
            skipped: outcome.skipped,
          }),
        )
      } else {
        toast.success(t('health.done', { size: formatBytes(outcome.freed_bytes), count: outcome.done }))
      }
      await run()
    } catch {
      toast.error(t('scan.failed'))
    } finally {
      setApplying(false)
    }
  }, [run, selected, t])

  return { report, items: report?.items ?? [], selected, setSelected, busy, applying, run, apply }
}

function StartupTab() {
  const { t } = useTranslation('pcclean')
  const list = useDisableList('startup', 'startup')
  // 三块数字各自是一个筛选入口——数字回答"有多少"，点击回答"是哪些"。
  const [filter, setFilter] = useState<'all' | 'enabled' | 'junk'>('all')
  /** 正在设延迟的那一项。按 item_id 存而不是一个布尔：一行在转圈的时候
   *  其余行照样能点，用布尔会把整张表一起锁住。 */
  const [delaying, setDelaying] = useState<string | null>(null)

  async function handleDelay(itemId: string) {
    setDelaying(itemId)
    try {
      // 3 分钟：够让登录那一波磁盘和 CPU 尖峰过掉，又短到用户不会觉得
      // "这程序没起来"。后端把它夹在 1~30 之间。
      const res = await vaultApi.call('pcclean_startup_delay', { item_id: itemId, minutes: 3 })
      if (res.ok) {
        toast.success(t('startup.delayDone', { minutes: res.minutes }))
        void list.run()
      } else {
        toast.error(t('startup.delayFailed'), { description: t(res.error) })
      }
    } catch {
      toast.error(t('startup.delayFailed'))
    } finally {
      // 复位放 finally：`vaultApi.call` 会抛，写在 await 之后的话这一行会
      // 永久卡在转圈，而屏幕上一个字的错误提示都没有。
      setDelaying(null)
    }
  }

  /** 后端建议禁用的批次（`recommended_action === "disable"`），规则保守：仅无签名推广/捆绑器。 */
  const suggestedDisable = useMemo(
    () => (list.items ?? [])
      .filter((i) => !i.locked && i.detail?.recommended_action === 'disable')
      .map((i) => i.item_id),
    [list.items],
  )

  const shown = useMemo(() => {
    if (filter === 'enabled') return list.items.filter((i) => i.detail?.enabled !== false)
    if (filter === 'junk') return list.items.filter((i) => i.importance === 'junk')
    return list.items
  }, [filter, list.items])

  const counts = useMemo(() => {
    const enabled = list.items.filter((i) => i.detail?.enabled !== false).length
    const junk = list.items.filter((i) => i.importance === 'junk').length
    return { enabled, junk, total: list.items.length }
  }, [list.items])

  return (
    <div className="space-y-5 pt-5">
      <div className="grid gap-4 sm:grid-cols-3">
        <StatTile
          label={t('startup.enabled')}
          value={counts.enabled}
          active={filter === 'enabled'}
          onClick={() => setFilter(filter === 'enabled' ? 'all' : 'enabled')}
        />
        <StatTile
          label={t('health.needsAttention')}
          value={counts.junk}
          active={filter === 'junk'}
          onClick={() => setFilter(filter === 'junk' ? 'all' : 'junk')}
        />
        <StatTile
          label={t('health.itemsFound')}
          value={counts.total}
          active={filter === 'all'}
          onClick={() => setFilter('all')}
        />
      </div>

      <Alert>
        <AlertDescription>
          {t('startup.disableHint')} {t('startup.serviceHint')}
        </AlertDescription>
      </Alert>

      <PageSection
        icon={Activity}
        title={t('category.startup')}
        actions={
          <>
            <Button variant="outline" onClick={list.run} disabled={list.busy}>
              {list.busy ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
              {t('health.rescan')}
            </Button>
            {/* 一键应用建议：把所有「建议禁用」的项一次勾上。
                数量写在按钮上，是 0 就禁用——点了没反应比按钮不可点更糟。 */}
            <Button
              variant="outline"
              disabled={suggestedDisable.length === 0}
              onClick={() => list.setSelected(new Set(suggestedDisable))}
            >
              <Sparkles className="size-4" aria-hidden="true" />
              {t('startup.applySuggestion')} ({suggestedDisable.length})
            </Button>
            <Button onClick={list.apply} disabled={list.applying || list.selected.size === 0}>
              <Ban className="size-4" aria-hidden="true" />
              {t('startup.disable')} ({list.selected.size})
            </Button>
          </>
        }
        padded={false}
      >
        <CleanItemList
          items={shown}
          selected={list.selected}
          emptyIcon={Activity}
          showSize={false}
          height={560}
          onToggle={(id, next) => list.setSelected((prev) => toggleIn(prev, id, next))}
          renderMeta={(item) => (
            <>
              {t(`startup.source.${String(item.detail?.source ?? 'registry')}`)} · {t(item.reason)}
              {/* 建议动作单独一句白话。重要度徽章只回答"这有多重要"，
                  而用户打开这个面板恰恰是因为**他不知道该拿它怎么办**——
                  二十五条自启项，每一条都要他自己把「OPTIONAL」换算成一个动作。 */}
              {typeof item.detail?.recommended_action === 'string' && (
                <>
                  {' · '}
                  <span className="font-medium">
                    {t(`startup.suggest.${item.detail.recommended_action as string}`)}
                  </span>
                </>
              )}
            </>
          )}
          renderTrailing={(item) => (
            <div className="flex items-center gap-2">
              {/* 延迟启动：禁用和留着之间那个一直缺失的中间选项。绝大多数拖慢
                  开机的东西恰恰是用户**真的要用**的（网盘、输入法），对它们
                  "禁用"的代价太大，于是他什么都不做，面板等于没起作用。
                  只对 Run 键项给：启动文件夹和计划任务走的是别的机制；
                  已经禁用的也不给——它本来就不启动了。 */}
              {item.detail?.source === 'registry' && item.detail?.enabled !== false && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={delaying === item.item_id}
                  onClick={(e) => {
                    e.stopPropagation()
                    void handleDelay(item.item_id)
                  }}
                >
                  {delaying === item.item_id ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Clock className="size-4" />
                  )}
                  {t('startup.delay')}
                </Button>
              )}
              <Badge tone={item.detail?.enabled === false ? 'neutral' : 'success'}>
                {t(item.detail?.enabled === false ? 'startup.disabled' : 'startup.enabled')}
              </Badge>
            </div>
          )}
        />
      </PageSection>
    </div>
  )
}

function ContextMenuTab() {
  const { t } = useTranslation('pcclean')
  const list = useDisableList('contextMenu', 'menu')

  return (
    <div className="space-y-5 pt-5">
      <Alert>
        <AlertDescription>{t('contextMenu.description')}</AlertDescription>
      </Alert>
      <PageSection
        icon={MousePointerClick}
        title={t('contextMenu.title')}
        actions={
          <>
            <Button variant="outline" onClick={list.run} disabled={list.busy}>
              {list.busy ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
              {t('health.rescan')}
            </Button>
            <Button onClick={list.apply} disabled={list.applying || list.selected.size === 0}>
              <Ban className="size-4" aria-hidden="true" />
              {t('startup.disable')} ({list.selected.size})
            </Button>
          </>
        }
        padded={false}
      >
        <CleanItemList
          items={list.items}
          selected={list.selected}
          emptyIcon={MousePointerClick}
          showSize={false}
          height={560}
          onToggle={(id, next) => list.setSelected((prev) => toggleIn(prev, id, next))}
          renderMeta={(item) => (
            <>
              {t(`contextMenu.scope.${String(item.detail?.scope ?? 'allFiles')}`)}
              {item.detail?.publisher ? ` · ${t('contextMenu.publisher')} ${item.detail.publisher}` : ''}
              {' · '}
              {t(item.reason)}
            </>
          )}
          renderTrailing={(item) => (
            <Badge tone={item.detail?.enabled === false ? 'neutral' : 'success'}>
              {t(item.detail?.enabled === false ? 'startup.disabled' : 'startup.enabled')}
            </Badge>
          )}
        />
      </PageSection>
    </div>
  )
}

function PopupTab() {
  const { t } = useTranslation('pcclean')
  const [status, setStatus] = useState<PcCleanPopupStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [captureOpen, setCaptureOpen] = useState(false)
  const [windows, setWindows] = useState<PcCleanWindow[]>([])
  const [sources, setSources] = useState<PcCleanItem[]>([])
  const [sourceSelected, setSourceSelected] = useState<ReadonlySet<string>>(new Set())
  const [newRule, setNewRule] = useState({ label: '', title_pattern: '', process_pattern: '' })
  /** 「累计拦截」那块数字点下去就展开/收起拦截日志。 */
  const [showLog, setShowLog] = useState(true)

  const refresh = useCallback(async () => {
    try {
      setStatus(await vaultApi.call('pcclean_popup_status', {}))
    } catch {
      /* 状态拿不到不该弹错误——面板会显示成"未启用" */
    }
  }, [])

  useEffect(() => {
    void refresh()
    void (async () => {
      try {
        const result = await scan('popupSources', {}, nextScanId('popupsrc'))
        if (result.ok) setSources(result.items)
      } catch {
        /* 源头扫描失败不影响窗口监视那半边 */
      }
    })()
  }, [refresh])

  const toggleBlocker = useCallback(
    async (enabled: boolean) => {
      setBusy(true)
      try {
        setStatus(await vaultApi.call('pcclean_popup_set_enabled', { enabled }))
      } catch {
        toast.error(t('scan.failed'))
      } finally {
        setBusy(false)
      }
    },
    [t],
  )

  const test = useCallback(async () => {
    try {
      const result = await vaultApi.call('pcclean_popup_test', {})
      const n = result.hits.length
      if (n === 0) toast.info(t('popup.testNone'))
      else toast.warning(t('popup.testResult', { count: n }))
    } catch {
      toast.error(t('scan.failed'))
    }
  }, [t])

  const openCapture = useCallback(async () => {
    try {
      const result = await vaultApi.call('pcclean_popup_capture', {})
      setWindows(result.windows)
      setCaptureOpen(true)
    } catch {
      toast.error(t('scan.failed'))
    }
  }, [t])

  const addFromWindow = useCallback(
    async (win: PcCleanWindow) => {
      try {
        const result = await vaultApi.call('pcclean_popup_add_rule', {
          rule: {
            rule_id: '',
            label: win.title || win.process,
            // 标题用**精确字符串**转义后匹配，不用用户看不见的模糊规则——
            // 捕获模式的价值就是"你指哪个我拦哪个"，规则宽了会误伤。
            title_pattern: win.title ? escapeRegex(win.title) : '',
            class_pattern: win.title ? '' : escapeRegex(win.class_name),
            process_pattern: '',
            enabled: true,
          },
        })
        if ('running' in result) setStatus(result)
        else toast.error(t(pccleanErrorKey(result.error)))
        setCaptureOpen(false)
      } catch {
        toast.error(t('scan.failed'))
      }
    },
    [t],
  )

  const addManualRule = useCallback(async () => {
    if (!newRule.title_pattern && !newRule.process_pattern) {
      toast.error(t('popup.emptyRule'))
      return
    }
    try {
      const result = await vaultApi.call('pcclean_popup_add_rule', {
        rule: {
          rule_id: '',
          label: newRule.label || newRule.title_pattern || newRule.process_pattern,
          title_pattern: newRule.title_pattern,
          class_pattern: '',
          process_pattern: newRule.process_pattern,
          enabled: true,
        },
      })
      if ('running' in result) {
        setStatus(result)
        setNewRule({ label: '', title_pattern: '', process_pattern: '' })
      } else toast.error(t(pccleanErrorKey(result.error)))
    } catch {
      toast.error(t('scan.failed'))
    }
  }, [newRule, t])

  const disableSources = useCallback(async () => {
    if (sourceSelected.size === 0) return
    try {
      const outcome = await vaultApi.call('pcclean_execute', {
        item_ids: Array.from(sourceSelected),
        options: { create_restore_point: true },
      })
      if (outcome.aborted) toast.error(t(pccleanErrorKey(outcome.aborted)))
      else toast.success(t('health.done', { size: '—', count: outcome.done }))
      setSourceSelected(new Set())
      const result = await scan('popupSources', {}, nextScanId('popupsrc'))
      if (result.ok) setSources(result.items)
    } catch {
      toast.error(t('scan.failed'))
    }
  }, [sourceSelected, t])

  return (
    <div className="space-y-5 pt-5">
      <div className="grid gap-4 sm:grid-cols-3">
        <StatTile
          label={t('popup.enable')}
          value={t(status?.running ? 'popup.enabled' : 'popup.disabled')}
          active={Boolean(status?.running)}
          onClick={() => toggleBlocker(!status?.running)}
        />
        <StatTile
          label={t('popup.blockedCount')}
          value={status?.blocked_count ?? 0}
          hint={t('popup.log')}
          active={showLog}
          onClick={() => setShowLog((prev) => !prev)}
        />
        <StatTile
          label={t('popup.rules')}
          value={status?.rules.length ?? 0}
          hint={t('popup.test')}
          onClick={test}
        />
      </div>

      <PageSection
        icon={ShieldCheck}
        title={t('popup.title')}
        actions={
          <>
            <Button variant="outline" onClick={test}>{t('popup.test')}</Button>
            <Button
              variant={status?.running ? 'outline' : 'default'}
              onClick={() => toggleBlocker(!status?.running)}
              disabled={busy}
            >
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              {t(status?.running ? 'startup.disable' : 'popup.enable')}
            </Button>
          </>
        }
      >
        <Alert>
          <AlertDescription>{t('popup.foregroundSafe')}</AlertDescription>
        </Alert>
      </PageSection>

      <PageSection icon={Ban} title={t('category.popupSources')} padded={false}
        actions={
          <Button onClick={disableSources} disabled={sourceSelected.size === 0}>
            <Ban className="size-4" aria-hidden="true" />
            {t('startup.disable')} ({sourceSelected.size})
          </Button>
        }
      >
        <CleanItemList
          items={sources}
          selected={sourceSelected}
          emptyIcon={ShieldCheck}
          showSize={false}
          height={Math.min(320, Math.max(140, sources.length * 64))}
          onToggle={(id, next) => setSourceSelected((prev) => toggleIn(prev, id, next))}
        />
      </PageSection>

      <PageSection
        icon={Crosshair}
        title={t('popup.rules')}
        actions={
          <Button variant="outline" onClick={openCapture}>
            <Crosshair className="size-4" aria-hidden="true" />
            {t('popup.capture')}
          </Button>
        }
      >
        <p className="mb-4 max-w-[72ch] text-2xs leading-5 text-muted-foreground">
          {t('popup.captureHint')}
        </p>
        <ul className="mb-5 space-y-2">
          {(status?.rules ?? []).map((rule) => (
            <li
              key={rule.rule_id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/70 px-3 py-2"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">
                    {rule.builtin ? t(rule.label) : rule.label}
                  </span>
                  <Badge tone={rule.builtin ? 'neutral' : 'accent'}>
                    {t(rule.builtin ? 'popup.builtinRules' : 'popup.customRules')}
                  </Badge>
                </div>
                <p className="truncate text-2xs text-muted-foreground">
                  {[rule.title_pattern, rule.class_pattern, rule.process_pattern]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              </div>
              <ActionButton
                label={t('popup.removeRule')}
                icon={Trash2}
                region={LABEL_REGIONS.pcCleanSection}
                onClick={async () => {
                  setStatus(await vaultApi.call('pcclean_popup_remove_rule', { rule_id: rule.rule_id }))
                }}
                stopPropagation
              />
            </li>
          ))}
        </ul>

        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="popup-title">{t('popup.titlePattern')}</Label>
            <Input
              id="popup-title"
              className="w-56"
              value={newRule.title_pattern}
              onChange={(e) => setNewRule((prev) => ({ ...prev, title_pattern: e.target.value }))}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="popup-process">{t('popup.processPattern')}</Label>
            <Input
              id="popup-process"
              className="w-48"
              value={newRule.process_pattern}
              onChange={(e) => setNewRule((prev) => ({ ...prev, process_pattern: e.target.value }))}
            />
          </div>
          <Button variant="outline" onClick={addManualRule}>
            <Plus className="size-4" aria-hidden="true" />
            {t('popup.addRule')}
          </Button>
        </div>
      </PageSection>

      {showLog && (
      <PageSection icon={Activity} title={t('popup.log')}
        actions={
          <Button
            variant="ghost"
            size="sm"
            onClick={async () => setStatus(await vaultApi.call('pcclean_popup_clear_log', {}))}
          >
            {t('popup.clearLog')}
          </Button>
        }
      >
        {(status?.recent ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('popup.logEmpty')}</p>
        ) : (
          <ul className="space-y-1.5">
            {(status?.recent ?? []).slice(-30).reverse().map((hit, index) => (
              <li key={`${hit.timestamp}-${index}`} className="flex items-baseline justify-between gap-4 text-sm">
                <span className="min-w-0 truncate">{hit.title || hit.class_name}</span>
                <span className="shrink-0 text-2xs text-muted-foreground">
                  {hit.process} · {new Date(hit.timestamp * 1000).toLocaleTimeString()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </PageSection>
      )}

      <Dialog open={captureOpen} onOpenChange={setCaptureOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('popup.capture')}</DialogTitle>
          </DialogHeader>
          <ul className="max-h-[420px] space-y-1 overflow-y-auto">
            {windows
              .filter((w) => w.title)
              .map((win) => (
                <li key={win.hwnd}>
                  <button
                    type="button"
                    className="flex w-full items-baseline justify-between gap-4 rounded px-3 py-2 text-left hover:bg-accent/50"
                    onClick={() => addFromWindow(win)}
                  >
                    <span className="min-w-0 truncate text-sm">{win.title}</span>
                    <span className="shrink-0 text-2xs text-muted-foreground">{win.process}</span>
                  </button>
                </li>
              ))}
          </ul>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/** 把真实窗口标题转成只匹配自己的正则。不转义时标题里一个 `(` 会使正则语法错误，
 *  而后端对坏正则按"不匹配"处理，规则会静默地什么都拦不住。 */
function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
