import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  Copy,
  FolderTree,
  HardDrive,
  Layers,
  Loader2,
  Search,
  ShieldAlert,
  Trash2,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { StatTile } from '@/components/StatTile'
import { Badge, PageHeader, PageSection, PageShell } from '@/components/ui/page'
import { CleanItemList } from '@/components/pcclean/CleanItemList'
import { Treemap } from '@/components/pcclean/Treemap'
import { vaultApi } from '@/lib/vaultApi'
import { electronApi } from '@/lib/electronApi'
import {
  formatBytes,
  nextScanId,
  pccleanErrorKey,
  scan,
  selectAll,
  sumSelected,
  toggleIn,
} from '@/lib/pcclean'
import type { PcCleanItem, PcCleanScanResult } from '@/shared/pccleanTypes'

/**
 * 空间分析：C 盘瘦身 / 大文件 / 目录占用 / 重复文件 / 磁盘优化。五件事各可能跑几分钟，所以是五个标
 * 签页而非一次全扫；每个标签页自带阈值控件（多大算大文件、多小的重复不值得管因人而异）。/
 */

const MIN_SIZE_CHOICES = [10, 50, 100, 500, 1024] as const
const DUP_MIN_KB_CHOICES = [64, 256, 1024, 10240] as const

export function PcCleanSpaceScreen() {
  const { t } = useTranslation('pcclean')
  const [tab, setTab] = useState('disk')

  return (
    <PageShell width="canvas">
      <PageHeader
        title={t('disk.title')}
      />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="disk">{t('category.diskSlimming')}</TabsTrigger>
          <TabsTrigger value="drivers">{t('category.driverStore')}</TabsTrigger>
          <TabsTrigger value="big">{t('category.bigFiles')}</TabsTrigger>
          <TabsTrigger value="folders">{t('category.dirAnalysis')}</TabsTrigger>
          <TabsTrigger value="dupes">{t('category.duplicates')}</TabsTrigger>
          <TabsTrigger value="downloads">{t('category.downloads')}</TabsTrigger>
          <TabsTrigger value="browser">{t('category.browserData')}</TabsTrigger>
          <TabsTrigger value="empty">{t('category.emptyDirs')}</TabsTrigger>
          <TabsTrigger value="drives">{t('defrag.title')}</TabsTrigger>
        </TabsList>

        <TabsContent value="disk"><DiskSlimmingTab /></TabsContent>
        <TabsContent value="drivers"><DriverStoreTab /></TabsContent>
        <TabsContent value="big"><BigFilesTab /></TabsContent>
        <TabsContent value="folders"><FolderUsageTab /></TabsContent>
        <TabsContent value="dupes"><DuplicatesTab /></TabsContent>
        <TabsContent value="downloads"><DownloadsTab /></TabsContent>
        <TabsContent value="browser"><BrowserDataTab /></TabsContent>
        <TabsContent value="empty"><EmptyDirsTab /></TabsContent>
        <TabsContent value="drives"><DrivesTab /></TabsContent>
      </Tabs>
    </PageShell>
  )
}

/** 五个标签页共用的「扫描 → 选择 → 清理」状态机。 */
function useScanTab(category: Parameters<typeof scan>[0], prefix: string) {
  const { t } = useTranslation('pcclean')
  const [report, setReport] = useState<PcCleanScanResult | null>(null)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [cleaning, setCleaning] = useState(false)

  const run = useCallback(
    async (options?: Record<string, unknown>) => {
      setBusy(true)
      setSelected(new Set())
      try {
        const result = await scan(category, options, nextScanId(prefix))
        if (result.ok) setReport(result)
        else toast.error(t(pccleanErrorKey(result.error)))
      } catch {
        toast.error(t('scan.failed'))
      } finally {
        setBusy(false)
      }
    },
    [category, prefix, t],
  )

  /**
   * 还等着授权的那一批。休眠文件、WinSxS、还原点都需管理员权限；此前被 `pcclean_execute` 悄悄跳过，
   * 界面却提示"释放 0 B"。
   */
  const [pendingAuth, setPendingAuth] = useState<{ count: number; item_ids: string[] } | null>(null)

  const clean = useCallback(
    async (ids?: string[], allowElevation = false) => {
      const targets = ids ?? Array.from(selected)
      if (targets.length === 0) return
      setCleaning(true)
      try {
        const outcome = await vaultApi.call('pcclean_execute', {
          item_ids: targets,
          options: { create_restore_point: false, allow_elevation: allowElevation },
        })
        const stillNeedsAuth = outcome.needs_elevation?.count ?? 0
        setPendingAuth(
          stillNeedsAuth > 0 && !allowElevation
            ? { count: stillNeedsAuth, item_ids: outcome.needs_elevation?.item_ids ?? [] }
            : null,
        )
        if (outcome.aborted) toast.error(t(pccleanErrorKey(outcome.aborted)))
        else if (stillNeedsAuth > 0 && !allowElevation)
          toast.warning(
            t('health.doneNeedsAuth', {
              size: formatBytes(outcome.freed_bytes),
              count: stillNeedsAuth,
            }),
          )
        else
          toast.success(
            t('health.done', { size: formatBytes(outcome.freed_bytes), count: outcome.done }),
          )
        // 还等着授权的项要留在选择集合里，否则那张卡上的按钮点下去没东西可清。
        setSelected(new Set(outcome.needs_elevation?.item_ids ?? []))
        // 清完立刻重扫：不重扫的话列表里还挂着已经不存在的条目，
        // 用户再点一次会得到一堆「已经不在了」。
        await run()
      } catch {
        toast.error(t('execute.failed'))
      } finally {
        setCleaning(false)
      }
    },
    [run, selected, t],
  )

  // 同 PcCleanSoftwareScreen：`?? []` 每次都是新数组，会让下面的 useMemo 永不命中。
  const items = useMemo(() => report?.items ?? [], [report])
  const selectedBytes = useMemo(() => sumSelected(items, selected), [items, selected])

  return {
    report, items, selected, setSelected, busy, cleaning, run, clean, selectedBytes,
    pendingAuth,
    authorize: () => clean(pendingAuth?.item_ids ?? [], true),
  }
}

function CleanBar({
  count,
  bytes,
  onClean,
  cleaning,
  disabled,
}: {
  count: number
  bytes: number
  onClean: () => void
  cleaning: boolean
  disabled?: boolean
}) {
  const { t } = useTranslation('pcclean')
  if (count === 0) return null
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface px-4 py-3">
      <span className="text-sm">
        {t('health.selectedCount', { count, size: formatBytes(bytes) })}
      </span>
      <Button onClick={onClean} disabled={cleaning || disabled}>
        <Trash2 className="size-4" aria-hidden="true" />
        {cleaning ? t('health.cleaning') : t('health.cleanSelected')}
      </Button>
    </div>
  )
}

function DiskSlimmingTab() {
  const { t } = useTranslation('pcclean')
  const tab = useScanTab('diskSlimming', 'disk')
  const [deep, setDeep] = useState(false)

  return (
    <div className="space-y-5 pt-5">
      <PageSection
        icon={HardDrive}
        title={t('category.diskSlimming')}
        actions={
          <>
            <Button variant="outline" onClick={() => tab.run({ deep: false })} disabled={tab.busy}>
              {tab.busy && !deep ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
              {t('health.run')}
            </Button>
            <Button
              onClick={() => {
                setDeep(true)
                void tab.run({ deep: true })
              }}
              disabled={tab.busy}
            >
              {tab.busy && deep ? <Loader2 className="size-4 animate-spin" /> : null}
              {t('disk.analyse')}
              <span className="ml-1 text-2xs opacity-80">
                ({t('disk.analyseHint', { seconds: 120 })})
              </span>
            </Button>
          </>
        }
        padded={false}
      >
        <CleanItemList
          items={tab.items}
          selected={tab.selected}
          emptyIcon={HardDrive}
          onToggle={(id, next) => tab.setSelected((prev) => toggleIn(prev, id, next))}
          renderLabel={(item) => labelOf(item, t)}
          renderTrailing={(item) =>
            item.detail?.analysed === false ? (
              <Badge tone="neutral">{t('disk.notAnalysed')}</Badge>
            ) : null
          }
        />
      </PageSection>
      {/*
        授权卡。**这一页最值得清的东西全都需要管理员权限**（休眠文件、
        WinSxS、还原点），所以这张卡放在这里比放在别处都要紧。

        它只在真的有待授权项时出现——没有的时候多一张卡只是噪声。
      */}
      {tab.pendingAuth ? (
        <PageSection icon={ShieldAlert} title={t('elevate.title')} tone="warning">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <p className="min-w-0 text-sm">
              {t('elevate.bodyShort', { count: tab.pendingAuth.count })}
            </p>
            <Button onClick={tab.authorize} disabled={tab.cleaning}>
              <ShieldAlert className="size-4" aria-hidden="true" />
              {tab.cleaning ? t('health.cleaning') : t('elevate.authorize')}
            </Button>
          </div>
        </PageSection>
      ) : (
        <Alert>
          <AlertDescription>{t('elevate.neededHint')}</AlertDescription>
        </Alert>
      )}
      <CleanBar
        count={tab.selected.size}
        bytes={tab.selectedBytes}
        onClean={() => tab.clean()}
        cleaning={tab.cleaning}
      />
    </div>
  )
}

/**
 * 旧版驱动包。回答本屏的"C 盘空间去哪了"：被顶替的显卡驱动能攒十几代、每代几百 MB，系统自带磁盘清
 * 理不碰它们。
 */
function DriverStoreTab() {
  const { t } = useTranslation('pcclean')
  const tab = useScanTab('driverStore', 'drv')

  const total = useMemo(
    () => tab.items.reduce((sum, item) => sum + item.size_bytes, 0),
    [tab.items],
  )

  return (
    <div className="space-y-5 pt-5">
      <PageSection
        icon={HardDrive}
        title={t('driverStore.title')}
        actions={
          <Button onClick={() => void tab.run()} disabled={tab.busy}>
            {tab.busy ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <Search className="size-4" aria-hidden="true" />
            )}
            {t('health.run')}
          </Button>
        }
        padded={false}
      >
        <CleanItemList
          items={tab.items}
          selected={tab.selected}
          emptyIcon={HardDrive}
          onToggle={(id, next) => tab.setSelected((prev) => toggleIn(prev, id, next))}
          onToggleAll={(next) => tab.setSelected((prev) => selectAll(prev, tab.items, next))}
          renderLabel={(item) => labelOf(item, t)}
          renderTrailing={(item) => (
            <div className="flex items-center gap-1.5">
              <Badge tone="neutral">
                {t('driverStore.generation', { count: Number(item.detail?.generation ?? 1) })}
              </Badge>
              {item.detail?.size_estimated ? (
                <Badge tone="warning">{t('driverStore.sizeEstimated')}</Badge>
              ) : null}
            </div>
          )}
        />
      </PageSection>

      {/* 授权说明常驻，不等到失败之后才出现：删驱动一定要提权，
          提前说清楚比让用户点完发现"清理了 0 项"要好。 */}
      <Alert>
        <AlertDescription>{t('driverStore.elevationNote')}</AlertDescription>
      </Alert>

      {tab.pendingAuth ? (
        <PageSection icon={ShieldAlert} title={t('elevate.title')} tone="warning">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <p className="min-w-0 text-sm">
              {t('elevate.bodyShort', { count: tab.pendingAuth.count })}
            </p>
            <Button onClick={tab.authorize} disabled={tab.cleaning}>
              <ShieldAlert className="size-4" aria-hidden="true" />
              {tab.cleaning ? t('health.cleaning') : t('elevate.authorize')}
            </Button>
          </div>
        </PageSection>
      ) : null}

      {tab.items.length > 0 && (
        <StatTile
          label={t('hero.reclaimable')}
          value={formatBytes(total)}
          hint={t('common.selectAll')}
          active={tab.selected.size === tab.items.length && tab.items.length > 0}
          onClick={() => tab.setSelected((prev) => selectAll(prev, tab.items, tab.selected.size !== tab.items.length))}
        />
      )}

      <CleanBar
        count={tab.selected.size}
        bytes={tab.selectedBytes}
        onClean={() => tab.clean()}
        cleaning={tab.cleaning}
      />
    </div>
  )
}

/**
 * 浏览器分项数据。与「浏览器缓存」分开两个入口：缓存删了会重建，这里删了要重新登录，不能并成一个按
 * 钮。
 */
function BrowserDataTab() {
  const { t } = useTranslation('pcclean')
  const tab = useScanTab('browserData', 'bdata')

  /** 按浏览器分组。同一个浏览器的十项混在一张长列表里没法读。 */
  const groups = useMemo(() => {
    const map = new Map<string, PcCleanItem[]>()
    for (const item of tab.items) {
      const key = String(item.detail?.browser ?? t('common.otherGroup'))
      const bucket = map.get(key)
      if (bucket) bucket.push(item)
      else map.set(key, [item])
    }
    return [...map.entries()]
  }, [tab.items, t])

  return (
    <div className="space-y-5 pt-5">
      <PageSection
        icon={Layers}
        title={t('browserData.title')}
        actions={
          <Button onClick={() => void tab.run()} disabled={tab.busy}>
            {tab.busy ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <Search className="size-4" aria-hidden="true" />
            )}
            {t('health.run')}
          </Button>
        }
      >
        <p className="max-w-[72ch] text-2xs leading-5 text-muted-foreground">
          {t('categoryHint.browserData')}
        </p>
      </PageSection>

      {groups.map(([browser, items]) => (
        <PageSection key={browser} title={browser} icon={Layers} padded={false}>
          <CleanItemList
            items={items}
            selected={tab.selected}
            emptyIcon={Layers}
            height={Math.min(420, Math.max(140, items.length * 64))}
            onToggle={(id, next) => tab.setSelected((prev) => toggleIn(prev, id, next))}
            onToggleAll={(next) => tab.setSelected((prev) => selectAll(prev, items, next))}
            renderLabel={(item) => labelOf(item, t)}
            renderTrailing={(item) =>
              item.detail?.profile ? (
                <Badge tone="neutral">{String(item.detail.profile)}</Badge>
              ) : null
            }
          />
        </PageSection>
      ))}

      <CleanBar
        count={tab.selected.size}
        bytes={tab.selectedBytes}
        onClean={() => tab.clean()}
        cleaning={tab.cleaning}
      />
    </div>
  )
}

/** 空文件夹 / 失效快捷方式 / 零字节文件。全部进回收站，所以敢做批量。 */
function EmptyDirsTab() {
  const { t } = useTranslation('pcclean')
  const tab = useScanTab('emptyDirs', 'empty')

  const byKind = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const item of tab.items) {
      const kind = String(item.detail?.kind ?? 'other')
      counts[kind] = (counts[kind] ?? 0) + 1
    }
    return counts
  }, [tab.items])

  return (
    <div className="space-y-5 pt-5">
      <PageSection
        icon={FolderTree}
        title={t('emptyDirs.title')}
        actions={
          <Button onClick={() => void tab.run()} disabled={tab.busy}>
            {tab.busy ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <Search className="size-4" aria-hidden="true" />
            )}
            {t('health.run')}
          </Button>
        }
        padded={false}
      >
        <CleanItemList
          items={tab.items}
          selected={tab.selected}
          emptyIcon={FolderTree}
          onToggle={(id, next) => tab.setSelected((prev) => toggleIn(prev, id, next))}
          onToggleAll={(next) => tab.setSelected((prev) => selectAll(prev, tab.items, next))}
          renderLabel={(item) => labelOf(item, t)}
          renderTrailing={(item) => (
            <Badge tone="neutral">
              {t(`emptyDirs.${String(item.detail?.kind ?? 'emptyFolder')}.label`, {
                defaultValue: String(item.detail?.kind ?? ''),
              })}
            </Badge>
          )}
        />
      </PageSection>

      {tab.items.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-3">
          {(['emptyFolder', 'brokenShortcut', 'zeroByte'] as const).map((kind) => (
            <StatTile
              key={kind}
              label={t(`emptyDirs.${kind}.label`)}
              value={byKind[kind] ?? 0}
              hint={t('common.selectAll')}
              onClick={() =>
                tab.setSelected((prev) =>
                  selectAll(prev, tab.items.filter((i) => i.detail?.kind === kind), true),
                )
              }
            />
          ))}
        </div>
      )}

      <CleanBar
        count={tab.selected.size}
        bytes={tab.selectedBytes}
        onClean={() => tab.clean()}
        cleaning={tab.cleaning}
      />
    </div>
  )
}

/**
 * 下载文件夹整理，对应后端早已写好的 `downloads` 扫描器。
 * 阈值默认 60 天：既保守又能筛掉一大批，可调，因为各人下载习惯差异大。
 */
const STALE_DAY_CHOICES = [7, 30, 60, 180, 365] as const

function DownloadsTab() {
  const { t } = useTranslation('pcclean')
  const tab = useScanTab('downloads', 'dl')
  const [staleDays, setStaleDays] = useState(60)

  return (
    <div className="space-y-5 pt-5">
      <PageSection
        icon={Layers}
        title={t('category.downloads')}
        actions={
          <>
            <Select value={String(staleDays)} onValueChange={(v) => setStaleDays(Number(v))}>
              <SelectTrigger className="w-44" aria-label={t('downloads.staleDays')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STALE_DAY_CHOICES.map((days) => (
                  <SelectItem key={days} value={String(days)}>
                    {t('health.days', { count: days })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button onClick={() => tab.run({ stale_days: staleDays })} disabled={tab.busy}>
              {tab.busy ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
              {t('health.run')}
            </Button>
          </>
        }
        padded={false}
      >
        <CleanItemList
          items={tab.items}
          selected={tab.selected}
          emptyIcon={Layers}
          height={520}
          onToggle={(id, next) => tab.setSelected((prev) => toggleIn(prev, id, next))}
          onToggleAll={(next) => tab.setSelected((prev) => selectAll(prev, tab.items, next))}
          renderMeta={(item) => (
            <>
              {t(`downloads.kind.${String(item.detail?.kind ?? 'other')}`)}
              {item.detail?.parent ? ` · ${String(item.detail.parent)}` : null}
            </>
          )}
        />
      </PageSection>
      <Alert>
        <AlertDescription>{t('execute.confirmRecycle')}</AlertDescription>
      </Alert>
      <CleanBar
        count={tab.selected.size}
        bytes={tab.selectedBytes}
        onClean={() => tab.clean()}
        cleaning={tab.cleaning}
      />
    </div>
  )
}

function BigFilesTab() {
  const { t } = useTranslation('pcclean')
  const tab = useScanTab('bigFiles', 'big')
  const [minSizeMb, setMinSizeMb] = useState(100)
  const [limit, setLimit] = useState(500)
  const [roots, setRoots] = useState<string[]>([])

  const addFolder = useCallback(async () => {
    const dir = await electronApi.openDirectory({ title: t('bigFiles.addFolder') })
    if (dir) setRoots((prev) => (prev.includes(dir) ? prev : [...prev, dir]))
  }, [t])

  return (
    <div className="space-y-5 pt-5">
      <PageSection icon={Layers} title={t('bigFiles.title')}>
        <div className="flex flex-wrap items-end gap-5">
          <div className="space-y-1.5">
            <Label>{t('bigFiles.minSize')}</Label>
            <Select value={String(minSizeMb)} onValueChange={(v) => setMinSizeMb(Number(v))}>
              <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
              <SelectContent>
                {MIN_SIZE_CHOICES.map((mb) => (
                  <SelectItem key={mb} value={String(mb)}>
                    {mb >= 1024 ? `${mb / 1024} GB` : `${mb} MB`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="bigfiles-limit">{t('bigFiles.limit')}</Label>
            <Input
              id="bigfiles-limit"
              type="number"
              className="w-32"
              value={limit}
              min={50}
              max={5000}
              onChange={(e) => setLimit(Number(e.target.value) || 500)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t('bigFiles.roots')}</Label>
            <div className="flex flex-wrap items-center gap-2">
              {roots.length === 0 && (
                <Badge tone="neutral">{t('bigFiles.defaultRoot')}</Badge>
              )}
              {roots.map((root) => (
                <Badge key={root} tone="accent">{root}</Badge>
              ))}
              <Button variant="outline" size="sm" onClick={addFolder}>
                {t('bigFiles.addFolder')}
              </Button>
            </div>
          </div>
          <Button
            onClick={() => tab.run({ min_size_mb: minSizeMb, limit, roots: roots.length ? roots : undefined })}
            disabled={tab.busy}
          >
            {tab.busy ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
            {t('health.run')}
          </Button>
        </div>
      </PageSection>

      {tab.report?.truncated && (
        <Alert>
          <AlertDescription>{t('bigFiles.truncated', { count: tab.items.length })}</AlertDescription>
        </Alert>
      )}

      <PageSection padded={false}>
        <CleanItemList
          items={tab.items}
          selected={tab.selected}
          emptyIcon={Layers}
          height={520}
          onToggle={(id, next) => tab.setSelected((prev) => toggleIn(prev, id, next))}
          onToggleAll={(next) => tab.setSelected((prev) => selectAll(prev, tab.items, next))}
          renderMeta={(item) => (
            <>
              {t(`downloads.kind.${String(item.detail?.kind ?? 'other')}`)} · {String(item.detail?.parent ?? '')}
            </>
          )}
        />
      </PageSection>
      <Alert>
        <AlertDescription>{t('execute.confirmRecycle')}</AlertDescription>
      </Alert>
      <CleanBar
        count={tab.selected.size}
        bytes={tab.selectedBytes}
        onClean={() => tab.clean()}
        cleaning={tab.cleaning}
      />
    </div>
  )
}

function FolderUsageTab() {
  const { t } = useTranslation('pcclean')
  const [root, setRoot] = useState('')
  const [report, setReport] = useState<PcCleanScanResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [stack, setStack] = useState<string[]>([])

  const analyse = useCallback(
    async (target: string) => {
      if (!target) return
      setBusy(true)
      try {
        const result = await scan('dirAnalysis', { root: target, depth: 2, top_n: 40 },
          nextScanId('dir'))
        if (result.ok) {
          setReport(result)
          setRoot(target)
        } else toast.error(t(pccleanErrorKey(result.error)))
      } catch {
        toast.error(t('scan.failed'))
      } finally {
        setBusy(false)
      }
    },
    [t],
  )

  const pickFolder = useCallback(async () => {
    const dir = await electronApi.openDirectory({ title: t('dirAnalysis.title') })
    if (dir) {
      setStack([])
      await analyse(dir)
    }
  }, [analyse, t])

  // 同上：`?? []` 每次渲染都是新数组，会让 topLevel 的 useMemo 永不命中。
  const topLevel = useMemo(
    () => (report?.items ?? []).filter((i) => i.detail?.level === 1),
    [report],
  )

  const treemapNodes = useMemo(
    () => topLevel.map((item) => ({
      key: item.path,
      label: item.label,
      value: item.size_bytes,
    })),
    [topLevel],
  )

  return (
    <div className="space-y-5 pt-5">
      <PageSection
        icon={FolderTree}
        title={t('dirAnalysis.title')}
        actions={
          <>
            {stack.length > 0 && (
              <Button
                variant="outline"
                onClick={() => {
                  const parent = stack[stack.length - 1]
                  setStack((prev) => prev.slice(0, -1))
                  void analyse(parent)
                }}
                disabled={busy}
              >
                {t('dirAnalysis.upOneLevel')}
              </Button>
            )}
            <Button onClick={pickFolder} disabled={busy}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : <FolderTree className="size-4" />}
              {t('bigFiles.addFolder')}
            </Button>
          </>
        }
      >
        {root && <p className="mb-3 truncate text-sm text-muted-foreground">{root}</p>}
        {topLevel.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('health.categoryEmpty')}</p>
        ) : (
          <div className="space-y-4">
            {/* 面积即占比。放在列表**上面**是因为它回答的是"谁吃了这块盘"，
                而下面那份列表回答的是"具体多少"——先看形状再看数字。 */}
            <Treemap
              nodes={treemapNodes}
              formatValue={formatBytes}
              onSelect={(path) => {
                setStack((prev) => [...prev, root])
                void analyse(path)
              }}
            />
            <ul className="space-y-2">
            {topLevel.map((item) => {
              const share = Number(item.detail?.share ?? 0) * 100
              return (
                <li key={item.item_id} className="space-y-1">
                  <div className="flex items-baseline justify-between gap-4">
                    <button
                      type="button"
                      className="min-w-0 truncate text-left text-sm font-medium hover:underline"
                      onClick={() => {
                        setStack((prev) => [...prev, root])
                        void analyse(item.path)
                      }}
                    >
                      {item.label}
                    </button>
                    <span className="shrink-0 text-sm tabular text-muted-foreground">
                      {formatBytes(item.size_bytes)}
                    </span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-primary"
                      style={{ width: `${Math.min(100, share)}%` }}
                    />
                  </div>
                  <p className="text-2xs text-muted-foreground">
                    {t('dirAnalysis.share', { percent: share.toFixed(1) })} ·{' '}
                    {t('common.files', { count: Number(item.detail?.file_count ?? 0) })}
                  </p>
                </li>
              )
            })}
            </ul>
          </div>
        )}
      </PageSection>
    </div>
  )
}

/**
 * 重复文件的分组键。定义在组件外是有意的：`CleanItemList` 把 `groupBy` 放进 useMemo 依赖，
 * 内联箭头函数每次渲染新引用，几万条会每帧重算分组。组名用保留那份的文件名而非组号。
 */
function groupDuplicates(item: PcCleanItem) {
  const key = String(item.detail?.group ?? '')
  if (!key) return null
  return { key, label: item.detail?.is_keeper ? item.label : key.split(':')[0] }
}

function DuplicatesTab() {
  const { t } = useTranslation('pcclean')
  const tab = useScanTab('duplicates', 'dup')
  const [minKb, setMinKb] = useState(1024)
  const [roots, setRoots] = useState<string[]>([])
  /** 保留哪一份。默认 `smart`：带「副本」「(1)」后缀、在下载/临时/桌面里的往后排。
   *  每组恰好保留一份，且同组顺序在两次扫描间稳定，否则重扫后保留项换人、之前的勾选全错位。 */
  const [keepStrategy, setKeepStrategy] = useState('smart')

  const wasted = useMemo(
    () =>
      tab.items
        .filter((i) => i.detail?.is_keeper)
        .reduce((n, i) => n + Number(i.detail?.wasted_bytes ?? 0), 0),
    [tab.items],
  )

  const addFolder = useCallback(async () => {
    const dir = await electronApi.openDirectory({ title: t('bigFiles.addFolder') })
    if (dir) setRoots((prev) => (prev.includes(dir) ? prev : [...prev, dir]))
  }, [t])

  return (
    <div className="space-y-5 pt-5">
      <PageSection icon={Copy} title={t('duplicates.title')}>
        <div className="flex flex-wrap items-end gap-5">
          <div className="space-y-1.5">
            <Label>{t('duplicates.minSize')}</Label>
            <Select value={String(minKb)} onValueChange={(v) => setMinKb(Number(v))}>
              <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
              <SelectContent>
                {DUP_MIN_KB_CHOICES.map((kb) => (
                  <SelectItem key={kb} value={String(kb)}>
                    {kb >= 1024 ? `${kb / 1024} MB` : `${kb} KB`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>{t('bigFiles.roots')}</Label>
            <div className="flex flex-wrap items-center gap-2">
              {roots.length === 0 && <Badge tone="neutral">{t('bigFiles.defaultRoot')}</Badge>}
              {roots.map((root) => <Badge key={root} tone="accent">{root}</Badge>)}
              <Button variant="outline" size="sm" onClick={addFolder}>{t('bigFiles.addFolder')}</Button>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>{t('duplicates.keepStrategy')}</Label>
            <Select value={keepStrategy} onValueChange={setKeepStrategy}>
              <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="smart">{t('duplicates.keepSmart')}</SelectItem>
                <SelectItem value="shortestPath">{t('duplicates.keepShortest')}</SelectItem>
                <SelectItem value="newest">{t('duplicates.keepNewest')}</SelectItem>
                <SelectItem value="oldest">{t('duplicates.keepOldest')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button
            onClick={() =>
              tab.run({
                min_size_kb: minKb,
                roots: roots.length ? roots : undefined,
                keep_strategy: keepStrategy,
              })
            }
            disabled={tab.busy}
          >
            {tab.busy ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
            {t('health.run')}
          </Button>
        </div>
        <p className="mt-3 max-w-[72ch] text-2xs leading-5 text-muted-foreground">
          {t('duplicates.method')}
        </p>
      </PageSection>

      {tab.items.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2">
          <StatTile
            label={t('duplicates.wasted')}
            value={formatBytes(wasted)}
            hint={t('health.selectDefaults')}
            active={tab.selected.size > 0}
            onClick={() =>
              // 点这块数字 = 「把每组多余的副本都选上」，也就是把这个数字
              // 真正变成可释放的空间。每组第一份（路径最短的）永远不选。
              tab.setSelected(
                new Set(tab.items.filter((i) => !i.detail?.is_keeper).map((i) => i.item_id)),
              )
            }
          />
          <StatTile
            label={t('duplicates.groups')}
            value={new Set(tab.items.map((i) => String(i.detail?.group ?? ''))).size}
            hint={t('health.selectNone')}
            onClick={() => tab.setSelected(new Set())}
          />
        </div>
      )}

      <PageSection padded={false}>
        <CleanItemList
          items={tab.items}
          selected={tab.selected}
          emptyIcon={Copy}
          height={520}
          onToggle={(id, next) => tab.setSelected((prev) => toggleIn(prev, id, next))}
          /* 按组折叠。全盘扫能出上万条，一路滚下去找某一组比列表本身慢的是
             人的眼睛。默认折叠，因为这个列表天然是"每组只看一眼"的读法。 */
          groupBy={groupDuplicates}
          defaultCollapsed
          renderMeta={(item) =>
            item.detail?.is_keeper
              ? t('duplicates.keepFirst')
              : t('duplicates.copy')
          }
          renderTrailing={(item) => (
            <Badge tone={item.detail?.is_keeper ? 'success' : 'neutral'}>
              #{String(item.detail?.group_index ?? '')}
            </Badge>
          )}
        />
      </PageSection>
      <CleanBar
        count={tab.selected.size}
        bytes={tab.selectedBytes}
        onClean={() => tab.clean()}
        cleaning={tab.cleaning}
      />
    </div>
  )
}

function DrivesTab() {
  const { t } = useTranslation('pcclean')
  const [report, setReport] = useState<PcCleanScanResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [working, setWorking] = useState<string | null>(null)

  const load = useCallback(async () => {
    setBusy(true)
    try {
      const result = await scan('volumes', {}, nextScanId('vol'))
      if (result.ok) setReport(result)
    } catch {
      toast.error(t('scan.failed'))
    } finally {
      setBusy(false)
    }
  }, [t])

  const optimise = useCallback(
    async (drive: string, isSsd: boolean) => {
      setWorking(drive)
      try {
        const result = await vaultApi.call('pcclean_optimize_volume', { drive, mode: 'auto' })
        if (result.ok) toast.success(t(isSsd ? 'defrag.retrim' : 'defrag.optimise'))
        else toast.error(t(pccleanErrorKey(result.error)))
      } catch {
        toast.error(t('scan.failed'))
      } finally {
        setWorking(null)
      }
    },
    [t],
  )

  return (
    <div className="space-y-5 pt-5">
      <PageSection
        icon={HardDrive}
        title={t('defrag.title')}
        actions={
          <Button onClick={load} disabled={busy}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
            {t('health.run')}
          </Button>
        }
      >
        {(report?.items ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('health.categoryEmpty')}</p>
        ) : (
          <ul className="space-y-4">
            {(report?.items ?? []).map((item) => {
              const isSsd = Boolean(item.detail?.is_ssd)
              const total = Number(item.detail?.total_bytes ?? 0)
              const free = Number(item.detail?.free_bytes ?? 0)
              const usedPct = Number(item.detail?.used_percent ?? 0)
              return (
                <li key={item.item_id} className="space-y-2 rounded-lg border border-border/70 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-2.5">
                      <span className="text-sihao font-heading font-medium">{item.label}</span>
                      <Badge tone={isSsd ? 'info' : 'warning'}>
                        {String(item.detail?.media_type ?? '')}
                      </Badge>
                    </div>
                    <Button
                      variant="outline"
                      onClick={() => optimise(item.label, isSsd)}
                      disabled={working === item.label}
                    >
                      {working === item.label ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : null}
                      {isSsd ? t('defrag.retrim') : t('defrag.optimise')}
                    </Button>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-muted">
                    <div className="h-full rounded-full bg-primary" style={{ width: `${usedPct}%` }} />
                  </div>
                  <p className="text-2xs text-muted-foreground">
                    {t('defrag.used')} {formatBytes(total - free)} · {t('defrag.free')}{' '}
                    {formatBytes(free)} · {t(isSsd ? 'defrag.ssdTrim' : 'defrag.hddDefrag')}
                  </p>
                </li>
              )
            })}
          </ul>
        )}
      </PageSection>
    </div>
  )
}

function labelOf(item: PcCleanItem, t: (key: string) => string): React.ReactNode {
  const labelKey = item.detail?.label_key
  if (typeof labelKey === 'string' && labelKey) {
    return t(labelKey.startsWith('pcclean.') ? labelKey.slice('pcclean.'.length) : labelKey)
  }
  return item.label
}
