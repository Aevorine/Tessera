import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Boxes, FolderX, Loader2, PackageX, ScanSearch, Search, ShieldCheck } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { StatTile } from '@/components/StatTile'
import { PageHeader, PageSection, PageShell } from '@/components/ui/page'
import { CleanItemList } from '@/components/pcclean/CleanItemList'
import { vaultApi } from '@/lib/vaultApi'
import {
  PCCLEAN_IMPORTANCE_ORDER,
  type PcCleanImportance,
  type PcCleanItem,
  type PcCleanScanResult,
} from '@/shared/pccleanTypes'
import { formatBytes, nextScanId, pccleanErrorKey, scan, toggleIn } from '@/lib/pcclean'
import { ActionButton } from '@/components/ActionButton'
import { LABEL_REGIONS } from '@/lib/labelMode'

/**
 * 软件管理：已装软件 / 卸载残留 / 注册表引用。必须全部列出（含 CRITICAL 锁定的系统组件），
 * 每条带五级标签和一句人话解释；筛选器可按级别查看，但默认"全部"，不能悄悄过滤。
 */

export function PcCleanSoftwareScreen() {
  const { t } = useTranslation('pcclean')
  const [tab, setTab] = useState('installed')

  return (
    <PageShell width="canvas">
      <PageHeader
        title={t('software.title')}
      />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="installed">{t('category.software')}</TabsTrigger>
          <TabsTrigger value="leftovers">{t('category.leftovers')}</TabsTrigger>
          <TabsTrigger value="registry">{t('category.registry')}</TabsTrigger>
        </TabsList>
        <TabsContent value="installed"><InstalledTab /></TabsContent>
        <TabsContent value="leftovers"><LeftoversTab /></TabsContent>
        <TabsContent value="registry"><RegistryTab /></TabsContent>
      </Tabs>
    </PageShell>
  )
}

function InstalledTab() {
  const { t } = useTranslation('pcclean')
  const [report, setReport] = useState<PcCleanScanResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<'all' | PcCleanImportance>('all')
  const [whitelist, setWhitelist] = useState<string[]>([])
  /**
   * 排序。默认按体积，但体积不足以决定是否卸载，需要"占 4 GB 且一年没打开"，故加"闲置时间"档和「又大
   * 又久没用」筛选。
   */
  const [sort, setSort] = useState<'size' | 'idle' | 'name'>('size')
  /** 只看「超过 500 MB 且 90 天没动过」的那一批。 */
  const [rarelyOnly, setRarelyOnly] = useState(false)

  const run = useCallback(async () => {
    setBusy(true)
    try {
      const result = await scan('software', {}, nextScanId('sw'))
      if (result.ok) setReport(result)
      else toast.error(t(pccleanErrorKey(result.error)))
    } catch {
      toast.error(t('scan.failed'))
    } finally {
      setBusy(false)
    }
  }, [t])

  useEffect(() => {
    void run()
    void (async () => {
      try {
        const result = await vaultApi.call('pcclean_whitelist_get', {})
        setWhitelist(result.entries)
      } catch {
        /* 白名单读不到不影响列表本身 */
      }
    })()
  }, [run])

  // 不能写 `report?.items ?? []`：`[]` 每次渲染都是新数组，下面三个 useMemo 的缓存永远失效，几百条每
  // 帧重筛重分组。
  const all = useMemo(() => report?.items ?? [], [report])

  /** 「又大又久没用」的判据。两条同时成立才算——只大不算（可能天天在用），
   *  只久也不算（一个 30 MB 的小工具放着不占地方）。 */
  const isRarelyUsed = useCallback((item: PcCleanItem) => {
    const idle = item.detail?.idle_days
    return (
      item.size_bytes >= 500 * 1024 * 1024 &&
      typeof idle === 'number' &&
      idle >= 90 &&
      !item.locked
    )
  }, [])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const rows = all.filter((item) => {
      if (filter !== 'all' && item.importance !== filter) return false
      if (rarelyOnly && !isRarelyUsed(item)) return false
      if (!needle) return true
      return (
        item.label.toLowerCase().includes(needle) ||
        String(item.detail?.publisher ?? '').toLowerCase().includes(needle)
      )
    })
    // 复制一份再排：`all` 是上游 useMemo 的结果，就地 sort 会改掉它，
    // 于是"按名称排"之后再切回"按体积排"拿到的是已经被打乱的数组。
    const sorted = [...rows]
    if (sort === 'size') sorted.sort((a, b) => b.size_bytes - a.size_bytes)
    else if (sort === 'name') sorted.sort((a, b) => a.label.localeCompare(b.label))
    else {
      // 闲置时间未知的排最后，**不当成 0 天也不当成很久** —— 把"不知道"
      // 排到"从没用过"那一头，会让人卸掉一个其实天天在用的东西。
      sorted.sort((a, b) => {
        const ai = typeof a.detail?.idle_days === 'number' ? (a.detail.idle_days as number) : -1
        const bi = typeof b.detail?.idle_days === 'number' ? (b.detail.idle_days as number) : -1
        return bi - ai
      })
    }
    return sorted
  }, [all, filter, isRarelyUsed, query, rarelyOnly, sort])

  const rarelyUsed = useMemo(() => all.filter(isRarelyUsed), [all, isRarelyUsed])
  const rarelyUsedBytes = useMemo(
    () => rarelyUsed.reduce((n, i) => n + i.size_bytes, 0),
    [rarelyUsed],
  )

  const totalSize = useMemo(() => all.reduce((n, i) => n + i.size_bytes, 0), [all])
  const byLevel = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const item of all) counts[item.importance] = (counts[item.importance] ?? 0) + 1
    return counts
  }, [all])

  const uninstall = useCallback(
    async (item: PcCleanItem, silent: boolean) => {
      const uninstallString = item.detail?.uninstall_string
      if (!uninstallString) {
        toast.error(t('software.noUninstaller'))
        return
      }
      // 卸载走软件自己的卸载器（用户可见的外部窗口），这里只负责拉起。传 item_id 而非命令行：
      // 让渲染进程指定要执行的命令等于开放任意命令执行。
      try {
        const result = await vaultApi.call('pcclean_uninstall', {
          item_id: item.item_id,
          silent,
        })
        if (result.ok) toast.info(t('software.uninstallHint'))
        else toast.error(t(pccleanErrorKey(result.error)))
      } catch {
        toast.error(t('scan.failed'))
      }
    },
    [t],
  )

  const keepAlways = useCallback(
    async (item: PcCleanItem) => {
      const next = Array.from(new Set([...whitelist, item.label]))
      try {
        const result = await vaultApi.call('pcclean_whitelist_set', { entries: next })
        setWhitelist(result.entries)
        toast.success(t('software.keepThis'))
        await run()
      } catch {
        toast.error(t('scan.failed'))
      }
    },
    [run, t, whitelist],
  )

  return (
    <div className="space-y-5 pt-5">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label={t('software.filterAll')}
          value={all.length}
          active={filter === 'all' && query === ''}
          onClick={() => {
            setFilter('all')
            setQuery('')
          }}
        />
        <StatTile
          label={t('software.size')}
          value={formatBytes(totalSize)}
          hint={t('software.sizeMeasured')}
          active={filter === 'common'}
          onClick={() => setFilter(filter === 'common' ? 'all' : 'common')}
        />
        {/* 「又大又久没用」放在第三格，而不是塞进筛选下拉里：这是这一屏
            唯一一条**能直接得出行动**的信息（其余几格只是分类计数）。 */}
        <StatTile
          label={t('software.rarelyUsed')}
          value={formatBytes(rarelyUsedBytes)}
          hint={t('common.items', { count: rarelyUsed.length })}
          active={rarelyOnly}
          onClick={() => setRarelyOnly((prev) => !prev)}
        />
        <StatTile
          label={t('importance.junk')}
          value={byLevel.junk ?? 0}
          active={filter === 'junk'}
          onClick={() => setFilter(filter === 'junk' ? 'all' : 'junk')}
        />
      </div>

      {rarelyOnly && (
        <Alert>
          <AlertDescription>{t('software.rarelyUsedHint')}</AlertDescription>
        </Alert>
      )}

      <PageSection
        icon={Boxes}
        title={t('category.software')}
        actions={
          <Button variant="outline" onClick={run} disabled={busy}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
            {t('health.rescan')}
          </Button>
        }
        padded={false}
      >
        <div className="flex flex-wrap items-center gap-3 border-b border-border/70 px-4 py-3">
          <Input
            className="w-64"
            placeholder={t('software.search')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <Select value={filter} onValueChange={(v) => setFilter(v as typeof filter)}>
            <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('software.filterAll')}</SelectItem>
              {PCCLEAN_IMPORTANCE_ORDER.map((level) => (
                <SelectItem key={level} value={level}>
                  {t(`importance.${level}`)} ({byLevel[level] ?? 0})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={sort} onValueChange={(v) => setSort(v as typeof sort)}>
            <SelectTrigger className="w-44" aria-label={t('software.sortSize')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="size">{t('software.sortSize')}</SelectItem>
              <SelectItem value="idle">{t('software.sortIdle')}</SelectItem>
              <SelectItem value="name">{t('software.sortName')}</SelectItem>
            </SelectContent>
          </Select>
          <span className="text-2xs text-muted-foreground">
            {t('common.items', { count: filtered.length })}
          </span>
        </div>

        <CleanItemList
          items={filtered}
          selected={new Set()}
          height={600}
          onToggle={() => undefined}
          renderLabel={(item) => (
            <>
              {item.label}
              {item.detail?.version ? (
                <span className="ml-2 text-2xs font-normal text-muted-foreground">
                  {String(item.detail.version)}
                </span>
              ) : null}
            </>
          )}
          renderMeta={(item) => (
            <>
              {item.detail?.publisher ? `${item.detail.publisher} · ` : ''}
              {t(item.reason)}
              {item.detail?.size_source === 'measured' ? ` · ${t('software.sizeMeasured')}` : ''}
              {/* 闲置时间。**「不知道」和「很久没用」必须分开说** ——
                  把量不出来的显示成"从没用过"会让人卸掉一个天天在用的东西。 */}
              {' · '}
              {typeof item.detail?.idle_days === 'number'
                ? t('software.idleDays', { count: item.detail.idle_days as number })
                : t('software.idleUnknown')}
            </>
          )}
          renderTrailing={(item) => (
            <div className="flex items-center gap-1.5">
              {!item.locked && (
                // 纯图标按钮的名字只能靠悬停提示。ActionButton 三合一：
                // 图标 + 可选文字 + 永远挂着的 Tooltip。
                <ActionButton
                  label={t('software.keepAlways')}
                  icon={ShieldCheck}
                  region={LABEL_REGIONS.pcCleanSection}
                  onClick={() => keepAlways(item)}
                  stopPropagation
                />
              )}
              <Button
                variant="outline"
                size="sm"
                disabled={!item.detail?.uninstall_string}
                onClick={() => uninstall(item, false)}
              >
                <PackageX className="size-4" aria-hidden="true" />
                {t('software.uninstall')}
              </Button>
            </div>
          )}
        />
      </PageSection>

      <Alert>
        <AlertDescription>{t('software.uninstallHint')}</AlertDescription>
      </Alert>
    </div>
  )
}

function LeftoversTab() {
  const { t } = useTranslation('pcclean')
  const [report, setReport] = useState<PcCleanScanResult | null>(null)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState(false)

  const run = useCallback(async () => {
    setBusy(true)
    setSelected(new Set())
    try {
      // 残留判定要拿"已装软件的名字集合"去比对，所以先扫一次软件列表。
      // 不传的话后端只能靠目录名硬猜，误报率高得多。
      const installed = await scan('software', {}, nextScanId('sw-for-leftovers'))
      const names = installed.ok ? installed.items.map((i) => i.label) : []
      const result = await scan('leftovers', { installed_names: names }, nextScanId('left'))
      if (result.ok) setReport(result)
      else toast.error(t(pccleanErrorKey(result.error)))
    } catch {
      toast.error(t('scan.failed'))
    } finally {
      setBusy(false)
    }
  }, [t])

  const clean = useCallback(async () => {
    if (selected.size === 0) return
    try {
      const outcome = await vaultApi.call('pcclean_execute', {
        item_ids: Array.from(selected),
        options: { create_restore_point: false },
      })
      toast.success(t('health.done', { size: formatBytes(outcome.freed_bytes), count: outcome.done }))
      await run()
    } catch {
      toast.error(t('scan.failed'))
    }
  }, [run, selected, t])

  const items = report?.items ?? []

  return (
    <div className="space-y-5 pt-5">
      <Alert>
        <AlertDescription>{t('leftovers.description')}</AlertDescription>
      </Alert>
      <PageSection
        icon={FolderX}
        title={t('leftovers.title')}
        actions={
          <>
            <Button variant="outline" onClick={run} disabled={busy}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
              {t('health.run')}
            </Button>
            <Button onClick={clean} disabled={selected.size === 0}>
              {t('health.cleanSelected')} ({selected.size})
            </Button>
          </>
        }
        padded={false}
      >
        <CleanItemList
          items={items}
          selected={selected}
          emptyIcon={FolderX}
          height={520}
          onToggle={(id, next) => setSelected((prev) => toggleIn(prev, id, next))}
          renderMeta={(item) => (
            <>
              {t(item.reason)} · {t('leftovers.lastModified')}{' '}
              {String(item.detail?.last_modified ?? '')}
            </>
          )}
        />
      </PageSection>
      <Alert>
        <AlertDescription>{t('execute.confirmRecycle')}</AlertDescription>
      </Alert>
    </div>
  )
}

function RegistryTab() {
  const { t } = useTranslation('pcclean')
  const [report, setReport] = useState<PcCleanScanResult | null>(null)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState(false)

  const run = useCallback(async () => {
    setBusy(true)
    setSelected(new Set())
    try {
      const result = await scan('registry', {}, nextScanId('reg'))
      if (result.ok) setReport(result)
      else toast.error(t(pccleanErrorKey(result.error)))
    } catch {
      toast.error(t('scan.failed'))
    } finally {
      setBusy(false)
    }
  }, [t])

  const clean = useCallback(async () => {
    if (selected.size === 0) return
    try {
      const outcome = await vaultApi.call('pcclean_execute', {
        item_ids: Array.from(selected),
        options: { create_restore_point: true },
      })
      if (outcome.aborted) {
        toast.error(t(pccleanErrorKey(outcome.aborted)))
        return
      }
      const backupPath = (outcome.registry_backup as { path?: string })?.path
      if (backupPath) toast.success(t('registry.backupSaved', { path: backupPath }))
      else toast.success(t('health.done', { size: '—', count: outcome.done }))
      await run()
    } catch {
      toast.error(t('scan.failed'))
    }
  }, [run, selected, t])

  const items = report?.items ?? []

  return (
    <div className="space-y-5 pt-5">
      {/* 这一段是刻意写的：告诉用户「这个功能收益很小」比让他以为清了几千项
          电脑就快了要诚实。市面上的同类工具靠这个数字卖钱，我们不。 */}
      <Alert>
        <AlertDescription>{t('registry.honest')}</AlertDescription>
      </Alert>
      <Alert>
        <AlertDescription>{t('registry.backupFirst')}</AlertDescription>
      </Alert>

      <PageSection
        icon={ScanSearch}
        title={t('registry.title')}
        actions={
          <>
            <Button variant="outline" onClick={run} disabled={busy}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
              {t('health.run')}
            </Button>
            <Button onClick={clean} disabled={selected.size === 0}>
              {t('health.cleanSelected')} ({selected.size})
            </Button>
          </>
        }
        padded={false}
      >
        {report?.truncated && (
          <div className="border-b border-border/70 px-4 py-2">
            <p className="text-2xs text-warning">{t('common.truncated', { count: items.length })}</p>
          </div>
        )}
        <CleanItemList
          items={items}
          selected={selected}
          emptyIcon={ScanSearch}
          showSize={false}
          height={520}
          onToggle={(id, next) => setSelected((prev) => toggleIn(prev, id, next))}
          onToggleAll={(next) =>
            setSelected((prev) => {
              const out = new Set(prev)
              for (const item of items) {
                if (item.locked) continue
                if (next) out.add(item.item_id)
                else out.delete(item.item_id)
              }
              return out
            })
          }
          renderLabel={(item) => {
            const key = item.detail?.label_key
            const prefix =
              typeof key === 'string' && key
                ? t(key.startsWith('pcclean.') ? key.slice('pcclean.'.length) : key)
                : ''
            return prefix ? `${prefix} · ${item.label}` : item.label
          }}
          renderMeta={(item) => (
            <>
              {t(item.reason)}
              {item.detail?.value ? ` → ${String(item.detail.value)}` : ''}
            </>
          )}
        />
      </PageSection>
    </div>
  )
}
