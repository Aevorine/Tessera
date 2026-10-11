import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  Clipboard,
  Download,
  Gauge,
  Layers,
  Link2,
  RefreshCw,
  Star,
  Tag,
  Trash2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { InfoHint } from '@/components/ui/info-hint'
import { MetricValue, PageHeader, PageShell } from '@/components/ui/page'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { vaultApi } from '@/lib/vaultApi'
import { electronApi } from '@/lib/electronApi'
import { translateError } from '@/i18n/errors'
import type {
  NetworkSpeedtestConnectionMode,
  NetworkSpeedtestHistoryEntry,
  NetworkSpeedtestProgress,
  NetworkSpeedtestRatingKey,
  NetworkSpeedtestType,
  VaultMethods,
} from '@/shared/ipcTypes'
import { copyText } from '@/lib/clipboard'

const PHASE_LABEL_KEYS: Record<NetworkSpeedtestProgress['phase'], string> = {
  dns: 'phaseDns',
  ip: 'phaseIp',
  ping: 'phasePing',
  download: 'phaseDownload',
  upload: 'phaseUpload',
}

type RunResult = Extract<VaultMethods['network_speedtest_run']['result'], { ok: true }>

// Each progress message from the backend only carries its own phase's
// fields (e.g. a "download" tick has no ping_ms) - merging into this
// accumulator (instead of just keeping the latest message) is what keeps
// the ping number on screen once the test has moved on to download/upload,
// rather than it reverting to "--" the moment a later phase's message
// arrives.
type LiveMetrics = Partial<NetworkSpeedtestProgress> & Pick<NetworkSpeedtestProgress, 'phase' | 'done' | 'total'>

const SCENARIO_LABEL_KEYS: Record<NetworkSpeedtestRatingKey, string> = {
  overall_speed: 'scenarioOverallSpeed',
  latency: 'scenarioLatency',
  stability: 'scenarioStability',
  browsing: 'scenarioBrowsing',
  streaming: 'scenarioStreaming',
  video: 'scenarioVideo',
  gaming: 'scenarioGaming',
}

const SCENARIO_ORDER: NetworkSpeedtestRatingKey[] = [
  'overall_speed',
  'latency',
  'stability',
  'browsing',
  'streaming',
  'video',
  'gaming',
]

const TIER_TEXT_CLASS: Record<string, string> = {
  good: 'text-success',
  fair: 'text-warning',
  poor: 'text-destructive',
}

function StarRow({ stars, colorClass }: { stars: number; colorClass: string }) {
  return (
    <div className="flex gap-0.5">
      {[1, 2, 3, 4, 5].map((n) => (
        <Star
          key={n}
          className={cn('h-4 w-4', n <= stars ? cn(colorClass, 'fill-current') : 'text-muted-foreground/30')}
        />
      ))}
    </div>
  )
}

// undefined = not measured yet (show the loading placeholder), null = measured
// and confirmed absent (show "none available") - these must stay distinct.
function formatIp(t: (key: string) => string, value: string | null | undefined): string {
  if (value === undefined) return '--'
  if (value === null) return t('valueNone')
  return value
}

async function exportTextContent(savePath: string, content: string): Promise<{ ok: boolean; error?: string }> {
  const base64 = btoa(unescape(encodeURIComponent(content)))
  return electronApi.writeBinaryFileBase64(savePath, base64)
}

export function NetworkSpeedTestScreen({ isProfessional = false }: { isProfessional?: boolean } = {}) {
  const { t } = useTranslation('network')
  // 代理 / VPN 测速已整体移除，测的永远是本机直连这条路径。
  //
  // 一并去掉的还有启动时那次 `network_speedtest_detect` 探测——它唯一的用途就是
  // 判断"要不要显示代理按钮"。没有代理这个选项之后，那次探测既拖慢首屏（要等它
  // 返回才渲染出测速界面），又没有任何能影响界面的结果。
  const networkType: NetworkSpeedtestType = 'local'
  // 默认多连接——更接近专业测速工具报的"真实带宽"，用户仍可切回单连接
  // （跟旧结果比较、或单纯想看看两者差多少）。
  const [connectionMode, setConnectionMode] = useState<NetworkSpeedtestConnectionMode>('multi')
  const [running, setRunning] = useState(false)
  const [live, setLive] = useState<LiveMetrics | null>(null)
  const [result, setResult] = useState<RunResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tagDraft, setTagDraft] = useState('')
  const [tagSaving, setTagSaving] = useState(false)
  const [historyRefreshKey, setHistoryRefreshKey] = useState(0)


  useEffect(() => {
    return vaultApi.onProgress((payload) => {
      if (payload.method === 'network_speedtest_run') {
        const data = payload as unknown as NetworkSpeedtestProgress
        setLive((prev) => ({ ...prev, ...data }))
      }
    })
  }, [])

  async function runTest() {
    setRunning(true)
    setLive(null)
    setResult(null)
    setError(null)
    setTagDraft('')
    try {
      const res = await vaultApi.call('network_speedtest_run', { network_type: networkType, connection_mode: connectionMode })
      if (res.ok) {
        setResult(res)
        // 异常/变差提醒——只在真的比历史差时提醒一次，不阻断任何后续操作。
        if (res.anomaly) {
          toast.warning(t('anomalyToastTitle'), {
            description: t('anomalyToastDescription', {
              baselineDownload: res.anomaly.baseline_download_mbps.toFixed(1),
              baselinePing: res.anomaly.baseline_ping_ms.toFixed(0),
            }),
          })
        }
        if (res.history_id !== null) setHistoryRefreshKey((v) => v + 1)
      } else {
        setError(translateError(res.error, res.error_params))
      }
    } catch {
      // The IPC call itself rejected (e.g. an unhandled backend exception) -
      // surface that the same way as a normal ok:false result rather than
      // silently resetting to the idle state with no feedback.
      setError(translateError('internal.unexpected', { detail: '' }))
    } finally {
      setRunning(false)
    }
  }

  async function saveTag() {
    if (!result || result.history_id === null) return
    setTagSaving(true)
    try {
      const res = await vaultApi.call('network_speedtest_history_set_tag', {
        id: result.history_id,
        tag: tagDraft.trim() || null,
      })
      if (res.ok) {
        toast.success(t('tagSavedToast'))
        setHistoryRefreshKey((v) => v + 1)
      } else {
        toast.error(t('tagSaveFailedToast'))
      }
    } catch {
      toast.error(t('tagSaveFailedToast'))
    } finally {
      setTagSaving(false)
    }
  }

  async function copyResultToClipboard() {
    if (!result) return
    if (await copyText(buildResultSummaryText(t, result))) {
      toast.success(t('copiedToast'))
    } else {
      toast.error(translateError('internal.unexpected', { detail: '' }))
    }
  }

  async function exportResult() {
    if (!result) return
    try {
      const savePath = await electronApi.saveFile({
        title: t('exportSaveFileDialogTitle'),
        defaultPath: `speedtest-${Date.now()}.txt`,
        filters: [{ name: 'Text', extensions: ['txt'] }],
      })
      if (!savePath) return
      const res = await exportTextContent(savePath, buildResultSummaryText(t, result))
      if (res.ok) {
        toast.success(t('exportSuccessToast'), {
          action: { label: t('openFolderAction'), onClick: () => electronApi.showItemInFolder(savePath) },
        })
      } else {
        toast.error(t('exportFailedToast'))
      }
    } catch {
      toast.error(t('exportFailedToast'))
    }
  }

  const phaseLabel = live ? t(PHASE_LABEL_KEYS[live.phase]) : null

  return (
    <PageShell width="canvas">
      <PageHeader title={t('title')} />

      <Tabs defaultValue="test">
        <TabsList>
          <TabsTrigger value="test">{t('tabTest')}</TabsTrigger>
          {isProfessional && (
            <TabsTrigger value="history">{t('tabHistory')}</TabsTrigger>
          )}
        </TabsList>

        <TabsContent value="test" className="space-y-4">
          {(
            <Card>
              <CardContent className="space-y-3 pt-4">
                {isProfessional && (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant={connectionMode === 'single' ? 'default' : 'outline'}
                      size="sm"
                      disabled={running}
                      onClick={() => setConnectionMode('single')}
                    >
                      <Link2 /> {t('connectionModeSingle')}
                    </Button>
                    <Button
                      variant={connectionMode === 'multi' ? 'default' : 'outline'}
                      size="sm"
                      disabled={running}
                      onClick={() => setConnectionMode('multi')}
                    >
                      <Layers /> {t('connectionModeMulti')}
                    </Button>
                    <InfoHint text={t('connectionModeHint')} />
                  </div>
                )}

                <Button onClick={runTest} disabled={running}>
                  {running ? <RefreshCw className="animate-spin" /> : <Gauge />}
                  {running ? t('testingLabel') : result ? t('rerunButton') : t('runButton')}
                </Button>

                {running && (
                  <div className="space-y-1.5">
                    <Progress value={live ? (live.done / live.total) * 100 : 5} />
                    <p className="text-sm text-muted-foreground">{phaseLabel}</p>
                  </div>
                )}

                {error && (
                  <Alert variant="destructive">
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                )}
              </CardContent>
            </Card>
          )}

          {(result || (running && live)) && (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">
                  {t('metricNode')}: {result?.node_label ?? ''}
                </CardTitle>
                {/* 「这个数字怎么来的」。同一条线路，1 条流测 4 秒和 12 条流测 8 秒
                    结果能差一倍——不写出来，用户没法把它跟 speedtest.net 的数字对上，
                    也没法判断"今天比昨天慢"是线路问题还是落到了别的机房。 */}
                <p className="text-sm text-muted-foreground">
                  {t('measurementSummary', {
                    node: result?.edge_node ?? live?.edge_node ?? '--',
                    streams: result?.stream_count ?? (connectionMode === 'multi' ? '--' : 1),
                    seconds: result?.measured_seconds ?? '--',
                  })}
                </p>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-3 gap-4 text-center">
                  <div>
                    <p className="text-sm text-muted-foreground">{t('metricPing')}</p>
                    <MetricValue>
                      {(result?.ping_ms ?? live?.ping_ms)?.toFixed(0) ?? '--'} ms
                    </MetricValue>
                    {(() => {
                      const pingMin = result?.ping_min_ms ?? live?.ping_min_ms
                      const pingMax = result?.ping_max_ms ?? live?.ping_max_ms
                      return pingMin != null && pingMax != null ? (
                        <p className="text-sm text-muted-foreground">
                          {pingMin.toFixed(0)}–{pingMax.toFixed(0)} ms
                        </p>
                      ) : null
                    })()}
                  </div>
                  <div>
                    <p className="flex items-center justify-center gap-1 text-sm text-muted-foreground">
                      <ArrowDownToLine className="h-3 w-3" /> {t('metricDownload')}
                    </p>
                    <MetricValue>
                      {(result?.download_mbps ?? live?.download_mbps)?.toFixed(1) ?? '--'} Mbps
                    </MetricValue>
                  </div>
                  <div>
                    <p className="flex items-center justify-center gap-1 text-sm text-muted-foreground">
                      <ArrowUpFromLine className="h-3 w-3" /> {t('metricUpload')}
                    </p>
                    <MetricValue>
                      {(result?.upload_mbps ?? live?.upload_mbps)?.toFixed(1) ?? '--'} Mbps
                    </MetricValue>
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-4 border-t pt-3 text-center">
                  <div>
                    <p className="text-sm text-muted-foreground">{t('metricJitter')}</p>
                    <p className="text-sm font-medium">
                      {(result?.jitter_ms ?? live?.jitter_ms)?.toFixed(1) ?? '--'} ms
                    </p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">{t('metricLoss')}</p>
                    <p className="text-sm font-medium">
                      {result || live?.loss_ratio !== undefined
                        ? `${(((result?.loss_ratio ?? live?.loss_ratio) as number) * 100).toFixed(0)}%`
                        : '--'}
                    </p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">{t('metricDns')}</p>
                    <p className="text-sm font-medium">
                      {(result?.dns_ms ?? live?.dns_ms) != null ? `${(result?.dns_ms ?? live?.dns_ms)!.toFixed(1)} ms` : '--'}
                    </p>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4 border-t pt-3 text-center">
                  <div>
                    <p className="text-sm text-muted-foreground">{t('metricIpv4')}</p>
                    <p className="text-sm font-medium">{formatIp(t, result ? result.ipv4 : live?.ipv4)}</p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">{t('metricIpv6')}</p>
                    <p className="text-sm font-medium">{formatIp(t, result ? result.ipv6 : live?.ipv6)}</p>
                  </div>
                </div>

                {(() => {
                  const downloadLoadedPing = result?.download_loaded_ping_ms ?? live?.download_loaded_ping_ms
                  const uploadLoadedPing = result?.upload_loaded_ping_ms ?? live?.upload_loaded_ping_ms
                  if (downloadLoadedPing == null && uploadLoadedPing == null) return null
                  return (
                    <div className="space-y-1 border-t pt-3">
                      <div className="grid grid-cols-2 gap-4 text-center">
                        <div>
                          <p className="text-sm text-muted-foreground">{t('metricLoadedPingDownload')}</p>
                          <p className="text-sm font-medium">{downloadLoadedPing != null ? `${downloadLoadedPing.toFixed(0)} ms` : '--'}</p>
                        </div>
                        <div>
                          <p className="text-sm text-muted-foreground">{t('metricLoadedPingUpload')}</p>
                          <p className="text-sm font-medium">{uploadLoadedPing != null ? `${uploadLoadedPing.toFixed(0)} ms` : '--'}</p>
                        </div>
                      </div>
                    </div>
                  )
                })()}

                {/* 线路稳定度。放在结果里而不是折进"详情"：它回答的是用户看到
                    两次不同数字之后必然会问的那句「到底哪个是真的」——两个都是，
                    这条线本来就在这个范围里晃。没有它，用户只会得出"测得不准"。 */}
                {(() => {
                  const downloadStability = result?.download_stability ?? live?.download_stability
                  const uploadStability = result?.upload_stability ?? live?.upload_stability
                  if (downloadStability == null && uploadStability == null) return null
                  return (
                    <div className="space-y-1 border-t pt-3">
                      <div className="grid grid-cols-2 gap-4 text-center">
                        <div>
                          <p className="text-sm text-muted-foreground">{t('metricStabilityDownload')}</p>
                          <p className="text-sm font-medium">
                            {downloadStability != null ? `${downloadStability.toFixed(1)}×` : '--'}
                          </p>
                        </div>
                        <div>
                          <p className="text-sm text-muted-foreground">{t('metricStabilityUpload')}</p>
                          <p className="text-sm font-medium">
                            {uploadStability != null ? `${uploadStability.toFixed(1)}×` : '--'}
                          </p>
                        </div>
                      </div>
                    </div>
                  )
                })()}

                {result && (
                  <div className="flex flex-wrap items-center gap-2 border-t pt-3">
                    <Tag className="h-3.5 w-3.5 text-muted-foreground" />
                    <Input
                      value={tagDraft}
                      onChange={(e) => setTagDraft(e.target.value)}
                      placeholder={t('environmentTagPlaceholder')}
                      className="h-8 max-w-[200px]"
                      disabled={result.history_id === null}
                    />
                    <Button size="sm" variant="outline" onClick={saveTag} disabled={result.history_id === null || tagSaving}>
                      {t('saveTagButton')}
                    </Button>
                    {result.history_id === null && <p className="text-sm text-muted-foreground">{t('historyRequiresUnlockHint')}</p>}
                    <div className="ml-auto flex gap-1">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button size="sm" variant="outline" onClick={copyResultToClipboard} aria-label={t('copyResultButton')}>
                            <Clipboard className="h-3.5 w-3.5" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>{t('copyResultButton')}</TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button size="sm" variant="outline" onClick={exportResult} aria-label={t('exportResultButton')}>
                            <Download className="h-3.5 w-3.5" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>{t('exportResultButton')}</TooltipContent>
                      </Tooltip>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {result && (
            <Card>
              <CardContent className="divide-y pt-4">
                {SCENARIO_ORDER.map((key) => {
                  const rating = result.ratings[key]
                  return (
                    <div key={key} className="flex items-center justify-between py-2 first:pt-0 last:pb-0">
                      <span className="text-sm">{t(SCENARIO_LABEL_KEYS[key])}</span>
                      <StarRow stars={rating.stars} colorClass={TIER_TEXT_CLASS[rating.tier]} />
                    </div>
                  )
                })}
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {isProfessional && (
          <TabsContent value="history">
            <HistoryTab refreshKey={historyRefreshKey} />
          </TabsContent>
        )}
      </Tabs>
    </PageShell>
  )
}

function buildResultSummaryText(t: (key: string, opts?: Record<string, unknown>) => string, result: RunResult): string {
  const lines = [
    `${t('metricNode')}: ${result.node_label}`,
    `${t('connectionModeLabel')}: ${result.connection_mode === 'multi' ? t('connectionModeMulti') : t('connectionModeSingle')}`,
    `${t('metricPing')}: ${result.ping_ms} ms${result.ping_min_ms != null && result.ping_max_ms != null ? ` (${result.ping_min_ms}–${result.ping_max_ms})` : ''}`,
    `${t('metricJitter')}: ${result.jitter_ms} ms`,
    `${t('metricLoss')}: ${(result.loss_ratio * 100).toFixed(0)}%`,
    `${t('metricDns')}: ${result.dns_ms ?? '--'} ms`,
    `${t('metricDownload')}: ${result.download_mbps} Mbps`,
    `${t('metricUpload')}: ${result.upload_mbps} Mbps`,
    `${t('metricLoadedPingDownload')}: ${result.download_loaded_ping_ms ?? '--'} ms`,
    `${t('metricLoadedPingUpload')}: ${result.upload_loaded_ping_ms ?? '--'} ms`,
    `${t('metricIpv4')}: ${formatIp(t, result.ipv4)}`,
    `${t('metricIpv6')}: ${formatIp(t, result.ipv6)}`,
  ]
  return lines.join('\n')
}

// ---- 历史记录 + 趋势图表 ----

const HISTORY_NETWORK_FILTERS: (NetworkSpeedtestType | 'all')[] = ['all', 'local']

function buildSparklinePoints(values: number[], width: number, height: number, padding: number): string {
  if (values.length === 0) return ''
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min || 1
  const usableWidth = width - padding * 2
  const usableHeight = height - padding * 2
  return values
    .map((v, i) => {
      const x = padding + (values.length === 1 ? usableWidth / 2 : (i / (values.length - 1)) * usableWidth)
      const y = padding + usableHeight - ((v - min) / range) * usableHeight
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
}

// 纯手绘 SVG 折线图——项目里没有现成的图表库，一条简单的时间序列折线用
// polyline 几十行就能画完，比引入一个几百KB的图表库更符合"不卡顿"要求，
// 加载还更快（见方案里"技术路线"关于图表选型的说明）。
function TrendChart({ label, values, colorClass }: { label: string; values: number[]; colorClass: string }) {
  const width = 320
  const height = 80
  const padding = 8
  const points = useMemo(() => buildSparklinePoints(values, width, height, padding), [values])
  if (values.length < 2) return null
  return (
    <div className="space-y-1">
      <p className="text-sm text-muted-foreground">{label}</p>
      <svg viewBox={`0 0 ${width} ${height}`} className="h-20 w-full">
        <polyline points={points} fill="none" strokeWidth={2} className={colorClass} stroke="currentColor" />
      </svg>
    </div>
  )
}

function HistoryTab({ refreshKey }: { refreshKey: number }) {
  const { t } = useTranslation('network')
  // 代理/VPN 这一维已整体移除，筛选项固定就这两个。
  const networkFilters = HISTORY_NETWORK_FILTERS
  const [entries, setEntries] = useState<NetworkSpeedtestHistoryEntry[]>([])
  const [tags, setTags] = useState<string[]>([])
  const [networkFilter, setNetworkFilter] = useState<NetworkSpeedtestType | 'all'>('all')
  const [tagFilter, setTagFilter] = useState<string | 'all'>('all')
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [tagEdits, setTagEdits] = useState<Record<number, string>>({})

  function historyErrorMessage(error: string, errorParams?: Record<string, string | number>) {
    return error === 'auth.not_unlocked' ? t('historyRequiresUnlockHint') : translateError(error, errorParams)
  }

  async function load() {
    setLoading(true)
    setLoadError(null)
    try {
      const res = await vaultApi.call('network_speedtest_history_list', {
        network_type: networkFilter === 'all' ? undefined : networkFilter,
        environment_tag: tagFilter === 'all' ? undefined : tagFilter,
      })
      if (res.ok) {
        setEntries(res.results)
        setTags(res.tags)
      } else {
        setEntries([])
        setTags([])
        setLoadError(historyErrorMessage(res.error, res.error_params))
      }
    } catch {
      setEntries([])
      setTags([])
      setLoadError(translateError('internal.unexpected', { detail: '' }))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load() closes over networkFilter/tagFilter/refreshKey, re-running the effect on any of them is exactly the intent
  }, [networkFilter, tagFilter, refreshKey])

  async function saveEntryTag(id: number) {
    const tag = tagEdits[id]?.trim() || null
    try {
      const res = await vaultApi.call('network_speedtest_history_set_tag', { id, tag })
      if (res.ok) {
        toast.success(t('tagSavedToast'))
        load()
      } else {
        toast.error(t('tagSaveFailedToast'))
      }
    } catch {
      toast.error(t('tagSaveFailedToast'))
    }
  }

  async function clearAll() {
    try {
      const res = await vaultApi.call('network_speedtest_history_clear', {})
      if (res.ok) {
        toast.success(t('historyClearedToast', { count: res.cleared_count }))
        load()
      } else {
        toast.error(historyErrorMessage(res.error, res.error_params))
      }
    } catch {
      toast.error(translateError('internal.unexpected', { detail: '' }))
    }
  }

  async function copyHistoryToClipboard() {
    if (await copyText(buildHistoryCsv(entries))) {
      toast.success(t('copiedToast'))
    } else {
      toast.error(translateError('internal.unexpected', { detail: '' }))
    }
  }

  async function exportHistoryCsv() {
    try {
      const savePath = await electronApi.saveFile({
        title: t('exportSaveFileDialogTitle'),
        defaultPath: `speedtest-history-${Date.now()}.csv`,
        filters: [{ name: 'CSV', extensions: ['csv'] }],
      })
      if (!savePath) return
      const res = await exportTextContent(savePath, buildHistoryCsv(entries))
      if (res.ok) {
        toast.success(t('exportSuccessToast'), {
          action: { label: t('openFolderAction'), onClick: () => electronApi.showItemInFolder(savePath) },
        })
      } else {
        toast.error(t('exportFailedToast'))
      }
    } catch {
      toast.error(t('exportFailedToast'))
    }
  }

  // 图表按时间正序（历史记录列表本身是新到旧，图表看趋势要反过来）。
  const chronological = useMemo(() => [...entries].reverse(), [entries])
  const downloadSeries = useMemo(() => chronological.map((e) => e.download_mbps).filter((v): v is number => v !== null), [chronological])
  const pingSeries = useMemo(() => chronological.map((e) => e.ping_ms).filter((v): v is number => v !== null), [chronological])

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-3 pt-4">
          <div className="flex flex-wrap items-center gap-2">
            {networkFilters.map((f) => (
              <Button key={f} size="sm" variant={networkFilter === f ? 'default' : 'outline'} onClick={() => setNetworkFilter(f)}>
                {f === 'all' ? t('filterAllNetworks') : t('optionLocal')}
              </Button>
            ))}
            <Button size="sm" variant={tagFilter === 'all' ? 'default' : 'outline'} onClick={() => setTagFilter('all')}>
              {t('filterAllTags')}
            </Button>
            {tags.map((tag) => (
              <Button key={tag} size="sm" variant={tagFilter === tag ? 'default' : 'outline'} onClick={() => setTagFilter(tag)}>
                <Tag className="h-3 w-3" /> {tag}
              </Button>
            ))}
            <div className="ml-auto flex gap-1">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button size="sm" variant="outline" onClick={copyHistoryToClipboard} disabled={entries.length === 0} aria-label={t('copyResultButton')}>
                    <Clipboard className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('copyResultButton')}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button size="sm" variant="outline" onClick={exportHistoryCsv} disabled={entries.length === 0} aria-label={t('exportResultButton')}>
                    <Download className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('exportResultButton')}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button size="sm" variant="destructive" onClick={clearAll} disabled={entries.length === 0} aria-label={t('clearHistoryButton')}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('clearHistoryButton')}</TooltipContent>
              </Tooltip>
            </div>
          </div>

          {(downloadSeries.length >= 2 || pingSeries.length >= 2) && (
            <div className="grid grid-cols-1 gap-3 border-t pt-3 sm:grid-cols-2">
              <TrendChart label={t('chartDownloadTrend')} values={downloadSeries} colorClass="text-primary" />
              <TrendChart label={t('chartPingTrend')} values={pingSeries} colorClass="text-yellow-600 dark:text-yellow-500" />
            </div>
          )}
        </CardContent>
      </Card>

      {loading ? (
        <p className="text-sm text-muted-foreground">{t('loadingLabel')}</p>
      ) : loadError ? (
        <Alert variant="destructive">
          <AlertDescription>{loadError}</AlertDescription>
        </Alert>
      ) : entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('historyEmptyHint')}</p>
      ) : (
        <div className="space-y-2">
          {entries.map((entry) => (
            <Card key={entry.id}>
              <CardContent className="flex flex-wrap items-center gap-3 py-3 text-sm">
                <span className="text-sm text-muted-foreground">{new Date(entry.created_at).toLocaleString()}</span>
                {entry.connection_mode && (
                  <span className="text-sm text-muted-foreground">
                    {entry.connection_mode === 'multi' ? t('connectionModeMulti') : t('connectionModeSingle')}
                  </span>
                )}
                <span>{entry.ping_ms ?? '--'} ms</span>
                <span className="flex items-center gap-1">
                  <ArrowDownToLine className="h-3 w-3" /> {entry.download_mbps ?? '--'} Mbps
                </span>
                <span className="flex items-center gap-1">
                  <ArrowUpFromLine className="h-3 w-3" /> {entry.upload_mbps ?? '--'} Mbps
                </span>
                <div className="ml-auto flex items-center gap-1">
                  <Input
                    value={tagEdits[entry.id] ?? entry.environment_tag ?? ''}
                    onChange={(e) => setTagEdits((prev) => ({ ...prev, [entry.id]: e.target.value }))}
                    placeholder={t('environmentTagPlaceholder')}
                    className="h-7 w-32 text-sm"
                  />
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button size="sm" variant="ghost" onClick={() => saveEntryTag(entry.id)} aria-label={t('saveTagButton')}>
                        <Check className="h-3.5 w-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{t('saveTagButton')}</TooltipContent>
                  </Tooltip>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}

function csvCell(value: unknown): string {
  const text = String(value ?? '')
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function buildHistoryCsv(entries: NetworkSpeedtestHistoryEntry[]): string {
  const header = [
    'created_at', 'network_type', 'connection_mode', 'environment_tag', 'ping_ms', 'ping_min_ms', 'ping_max_ms',
    'jitter_ms', 'loss_ratio', 'dns_ms', 'download_mbps', 'upload_mbps', 'download_loaded_ping_ms',
    'upload_loaded_ping_ms', 'ipv4', 'ipv6',
  ]
  const rows = entries.map((e) =>
    [
      e.created_at, e.network_type, e.connection_mode ?? '', e.environment_tag ?? '', e.ping_ms, e.ping_min_ms,
      e.ping_max_ms, e.jitter_ms, e.loss_ratio, e.dns_ms, e.download_mbps, e.upload_mbps, e.download_loaded_ping_ms,
      e.upload_loaded_ping_ms, e.ipv4 ?? '', e.ipv6 ?? '',
    ]
      .map(csvCell)
      .join(','),
  )
  return [header.map(csvCell).join(','), ...rows].join('\n')
}
