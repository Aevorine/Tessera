import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  Clock,
  Copy,
  FileText,
  Loader2,
  Lock,
  Network,
  Pin,
  PinOff,
  Play,
  Search,
  ShieldAlert,
  ShieldCheck,
  Wrench,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Badge, EmptyState, PageHeader, PageSection, PageShell } from '@/components/ui/page'
import { vaultApi } from '@/lib/vaultApi'
import { electronApi } from '@/lib/electronApi'
import { formatBytes, formatCount, pccleanErrorKey } from '@/lib/pcclean'
import { cn } from '@/lib/utils'
import type { PcCleanTool, PcCleanToolResult } from '@/shared/pccleanTypes'
import { copyText } from '@/lib/clipboard'

/**
 * 工具箱：每个工具一行（名字 + 「什么时候用得上」+ 执行按钮），说明写使用场景而非功能描述。
 * 工具增至 42 个后加了：搜索（同时搜名字和说明）、常用置顶 + 最近用过（localStorage，跨会话）、
 * 结果表格化（后端给了 `rows` 的一律画表）。「定时清理 / 自定义规则 / 清理记录」已搬到体检页。
 */

const GROUP_ICONS = {
  network: Network,
  system: Wrench,
  files: FileText,
  privacy: Lock,
} as const

const GROUP_ORDER = ['system', 'network', 'files', 'privacy'] as const

const PINNED_KEY = 'pcclean.toolbox.pinned'
const RECENT_KEY = 'pcclean.toolbox.recent'
const RECENT_LIMIT = 5

/** localStorage 读写。**任何一次失败都不该让工具箱打不开**——
 *  隐私模式、配额满、被策略禁用都会让它抛，而这只是个便利功能。 */
function readList(key: string): string[] {
  try {
    const raw = window.localStorage.getItem(key)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function writeList(key: string, value: string[]): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* 存不下就算了，下次打开回到默认顺序而已 */
  }
}

export function PcCleanToolboxScreen() {
  const { t } = useTranslation('pcclean')
  const [tools, setTools] = useState<PcCleanTool[]>([])
  const [elevated, setElevated] = useState(false)
  const [running, setRunning] = useState<string | null>(null)
  const [result, setResult] = useState<{ tool: PcCleanTool; data: PcCleanToolResult } | null>(null)
  const [confirming, setConfirming] = useState<PcCleanTool | null>(null)
  const [query, setQuery] = useState('')
  const [pinned, setPinned] = useState<string[]>(() => readList(PINNED_KEY))
  const [recent, setRecent] = useState<string[]>(() => readList(RECENT_KEY))

  // 各工具要的参数。收在一处而不是每个工具一个 state——加一个带参数的工具时
  // 只要往 params_schema 里写一行，界面不用改。
  const [pathInput, setPathInput] = useState('')
  const [renamePattern, setRenamePattern] = useState('')
  const [renameReplacement, setRenameReplacement] = useState('')
  const [hostInput, setHostInput] = useState('')
  const [portInput, setPortInput] = useState('')
  const [minMbInput, setMinMbInput] = useState('50')

  useEffect(() => {
    void (async () => {
      try {
        const response = await vaultApi.call('pcclean_tools', {})
        setTools(response.tools)
        setElevated(response.elevated)
      } catch {
        toast.error(t('scan.failed'))
      }
    })()
  }, [t])

  const labelOf = useCallback(
    (tool: PcCleanTool) => t(`toolbox.${tool.tool_id}.label`, { defaultValue: tool.tool_id }),
    [t],
  )
  const descOf = useCallback(
    (tool: PcCleanTool) => t(`toolbox.${tool.tool_id}.description`, { defaultValue: '' }),
    [t],
  )

  /** 搜索同时命中**名字和说明**。用户往往记得住场景（"端口被占用"）
   *  而记不住工具名（"killPort"），只搜名字等于把搜索做了个样子。 */
  const matched = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return tools
    return tools.filter((tool) =>
      `${tool.tool_id} ${labelOf(tool)} ${descOf(tool)}`.toLowerCase().includes(needle),
    )
  }, [descOf, labelOf, query, tools])

  const byId = useMemo(() => new Map(tools.map((tool) => [tool.tool_id, tool])), [tools])
  const pinnedTools = useMemo(
    () => pinned.map((id) => byId.get(id)).filter((x): x is PcCleanTool => Boolean(x)),
    [byId, pinned],
  )
  const recentTools = useMemo(
    () => recent
      .filter((id) => !pinned.includes(id))
      .map((id) => byId.get(id))
      .filter((x): x is PcCleanTool => Boolean(x)),
    [byId, pinned, recent],
  )

  const grouped = useMemo(() => {
    const out: Record<string, PcCleanTool[]> = {}
    for (const tool of matched) {
      (out[tool.group] ??= []).push(tool)
    }
    return out
  }, [matched])

  const togglePin = useCallback((toolId: string) => {
    setPinned((prev) => {
      const next = prev.includes(toolId) ? prev.filter((id) => id !== toolId) : [toolId, ...prev]
      writeList(PINNED_KEY, next)
      return next
    })
  }, [])

  const execute = useCallback(
    async (tool: PcCleanTool, params: Record<string, unknown> = {}) => {
      setConfirming(null)
      setRunning(tool.tool_id)
      setRecent((prev) => {
        const next = [tool.tool_id, ...prev.filter((id) => id !== tool.tool_id)].slice(0, RECENT_LIMIT)
        writeList(RECENT_KEY, next)
        return next
      })
      try {
        const data = await vaultApi.call('pcclean_run_tool', { tool_id: tool.tool_id, params })
        setResult({ tool, data })
        if (!data.ok && data.error) toast.error(t(pccleanErrorKey(data.error)))
      } catch {
        toast.error(t('scan.failed'))
      } finally {
        setRunning(null)
      }
    },
    [t],
  )

  /** 需要参数的工具先收参数再跑。收不齐就不跑——把空参数传下去，
   *  后端只会回一个「先选一个文件夹」，等于白跑一趟。 */
  const launch = useCallback(
    async (tool: PcCleanTool) => {
      if (tool.dangerous) {
        setConfirming(tool)
        return
      }
      const schema = tool.params_schema
      if (schema.includes('root')) {
        const dir = await electronApi.openDirectory({ title: labelOf(tool) })
        if (!dir) return
        if (tool.tool_id === 'batchRename') {
          if (!renamePattern) {
            toast.error(t('toolbox.renameArgsRequired'))
            return
          }
          await execute(tool, {
            root: dir,
            pattern: renamePattern,
            replacement: renameReplacement,
            apply: false,
          })
          return
        }
        await execute(tool, { root: dir, apply: false, min_mb: Number(minMbInput) || 50 })
        return
      }
      if (schema.includes('path')) {
        if (!pathInput) {
          toast.error(t('toolbox.pathRequired'))
          return
        }
        await execute(tool, { path: pathInput, apply: false })
        return
      }
      if (schema.includes('host')) {
        await execute(tool, { host: hostInput })
        return
      }
      if (schema.includes('port')) {
        const port = Number(portInput)
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          toast.error(t('toolbox.badPort'))
          return
        }
        await execute(tool, { port, apply: false })
        return
      }
      if (tool.tool_id === 'toggleHibernation') {
        const status = await vaultApi.call('pcclean_run_tool', {
          tool_id: 'hibernationStatus',
          params: {},
        })
        await execute(tool, { enable: !status.enabled })
        return
      }
      await execute(tool)
    },
    [execute, hostInput, labelOf, minMbInput, pathInput, portInput, renamePattern, renameReplacement, t],
  )

  const renderRow = (tool: PcCleanTool) => (
    <li key={tool.tool_id} className="flex flex-wrap items-start gap-4 px-6 py-4">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{labelOf(tool)}</span>
          {tool.needs_elevation && <Badge tone="warning">{t('toolbox.needsElevation')}</Badge>}
          {tool.dangerous && (
            <Badge tone="danger" icon={ShieldAlert}>
              {t('toolbox.dangerous')}
            </Badge>
          )}
        </div>
        <p className="max-w-[76ch] text-2xs leading-5 text-muted-foreground">{descOf(tool)}</p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <Button
          variant="ghost"
          size="sm"
          aria-label={pinned.includes(tool.tool_id) ? t('toolbox.unpin') : t('toolbox.pin')}
          onClick={() => togglePin(tool.tool_id)}
        >
          {pinned.includes(tool.tool_id) ? (
            <PinOff className="size-4" aria-hidden="true" />
          ) : (
            <Pin className="size-4" aria-hidden="true" />
          )}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => launch(tool)}
          disabled={running !== null}
        >
          {running === tool.tool_id ? (
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          ) : (
            <Play className="size-4" aria-hidden="true" />
          )}
          {running === tool.tool_id ? t('toolbox.running') : t('toolbox.run')}
        </Button>
      </div>
    </li>
  )

  return (
    <PageShell width="canvas">
      <PageHeader
        title={t('toolbox.title')}
        actions={
          <>
            <div className="relative">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                className="w-72 pl-9"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('toolbox.searchPlaceholder')}
                aria-label={t('toolbox.search')}
              />
            </div>
            {elevated && <Badge tone="warning">{t('elevate.needed')}</Badge>}
          </>
        }
      />

      <Alert>
        <AlertDescription>{t('elevate.neededHint')}</AlertDescription>
      </Alert>

      {/* 参数区。**只显示当前搜索结果里真的用得上的那几个输入框** ——
          42 个工具里只有 7 个要参数，全部常驻会让这一屏一进来就很吵。 */}
      <ToolParams
        tools={matched}
        pathInput={pathInput}
        setPathInput={setPathInput}
        renamePattern={renamePattern}
        setRenamePattern={setRenamePattern}
        renameReplacement={renameReplacement}
        setRenameReplacement={setRenameReplacement}
        hostInput={hostInput}
        setHostInput={setHostInput}
        portInput={portInput}
        setPortInput={setPortInput}
        minMbInput={minMbInput}
        setMinMbInput={setMinMbInput}
      />

      {/* 常用 / 最近。搜索时不显示——搜索本身就是"我知道我要什么"，
          这时再插两块推荐只会把结果挤下去。 */}
      {!query && pinnedTools.length > 0 && (
        <PageSection icon={Pin} title={t('toolbox.pinned')} padded={false}>
          <ul className="divide-y divide-border/50">{pinnedTools.map(renderRow)}</ul>
        </PageSection>
      )}
      {!query && recentTools.length > 0 && (
        <PageSection icon={Clock} title={t('toolbox.recent')} tone="neutral" padded={false}>
          <ul className="divide-y divide-border/50">{recentTools.map(renderRow)}</ul>
        </PageSection>
      )}

      {matched.length === 0 ? (
        <EmptyState icon={Search} title={t('toolbox.noMatch')} />
      ) : (
        GROUP_ORDER.filter((group) => (grouped[group] ?? []).length > 0).map((group) => (
          <PageSection
            key={group}
            icon={GROUP_ICONS[group]}
            title={t(`toolbox.group.${group}`)}
            padded={false}
          >
            <ul className="divide-y divide-border/50">{(grouped[group] ?? []).map(renderRow)}</ul>
          </PageSection>
        ))
      )}

      <Dialog open={confirming !== null} onOpenChange={(open) => !open && setConfirming(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{confirming ? labelOf(confirming) : ''}</DialogTitle>
          </DialogHeader>
          <p className="text-sm">{confirming ? descOf(confirming) : ''}</p>
          {/* 粉碎机的固态硬盘说明必须在**按下去之前**出现。
              事后再说"其实 SSD 上不保证"没有任何意义。 */}
          {confirming?.tool_id === 'fileShredder' && (
            <Alert>
              <AlertDescription>{t('toolbox.shredderSsdNote')}</AlertDescription>
            </Alert>
          )}
          {/* 「清空最近使用」同理，只是方向相反：这一条说的是**不会**发生什么。
              用户按这个按钮之前唯一的顾虑就是"钉在快速访问上的文件夹会不会
              一起没"，把答案放在他按下去之前，比事后在结果里补一句有用得多。 */}
          {confirming?.tool_id === 'clearRecentDocs' && (
            <Alert>
              <AlertDescription>{t('toolbox.recentDocsPinnedNote')}</AlertDescription>
            </Alert>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setConfirming(null)}>
              {t('execute.cancel')}
            </Button>
            <Button
              onClick={() => {
                if (!confirming) return
                const schema = confirming.params_schema
                const params: Record<string, unknown> = { apply: true }
                if (schema.includes('path')) params.path = pathInput
                if (schema.includes('port')) params.port = Number(portInput)
                void execute(confirming, params)
              }}
            >
              {t('toolbox.run')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={result !== null} onOpenChange={(open) => !open && setResult(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{result ? labelOf(result.tool) : ''}</DialogTitle>
          </DialogHeader>
          {result && <ToolResultView data={result.data} />}
        </DialogContent>
      </Dialog>
    </PageShell>
  )
}

/** 参数输入区。按当前列表里出现过的 `params_schema` 决定显示哪几个框。 */
function ToolParams(props: {
  tools: readonly PcCleanTool[]
  pathInput: string
  setPathInput: (v: string) => void
  renamePattern: string
  setRenamePattern: (v: string) => void
  renameReplacement: string
  setRenameReplacement: (v: string) => void
  hostInput: string
  setHostInput: (v: string) => void
  portInput: string
  setPortInput: (v: string) => void
  minMbInput: string
  setMinMbInput: (v: string) => void
}) {
  const { t } = useTranslation('pcclean')
  const needs = useMemo(() => {
    const set = new Set<string>()
    for (const tool of props.tools) for (const key of tool.params_schema) set.add(key)
    return set
  }, [props.tools])

  if (needs.size === 0) return null

  return (
    <PageSection icon={FileText} title={t('common.details')} tone="neutral">
      <div className="flex flex-wrap items-end gap-4">
        {needs.has('path') && (
          <div className="space-y-1.5">
            <Label htmlFor="toolbox-path">{t('common.path')}</Label>
            <Input
              id="toolbox-path"
              className="w-80"
              value={props.pathInput}
              onChange={(e) => props.setPathInput(e.target.value)}
              placeholder="C:\\..."
            />
          </div>
        )}
        {needs.has('pattern') && (
          <>
            <div className="space-y-1.5">
              <Label htmlFor="toolbox-pattern">{t('popup.titlePattern')}</Label>
              <Input
                id="toolbox-pattern"
                className="w-44"
                value={props.renamePattern}
                onChange={(e) => props.setRenamePattern(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="toolbox-replacement">{t('toolbox.apply')}</Label>
              <Input
                id="toolbox-replacement"
                className="w-44"
                value={props.renameReplacement}
                onChange={(e) => props.setRenameReplacement(e.target.value)}
              />
            </div>
          </>
        )}
        {needs.has('host') && (
          <div className="space-y-1.5">
            <Label htmlFor="toolbox-host">{t('toolbox.pingTest.label')}</Label>
            <Input
              id="toolbox-host"
              className="w-56"
              value={props.hostInput}
              onChange={(e) => props.setHostInput(e.target.value)}
              placeholder="223.5.5.5"
            />
          </div>
        )}
        {needs.has('port') && (
          <div className="space-y-1.5">
            <Label htmlFor="toolbox-port">{t('toolbox.killPort.label')}</Label>
            <Input
              id="toolbox-port"
              className="w-32"
              inputMode="numeric"
              value={props.portInput}
              onChange={(e) => props.setPortInput(e.target.value)}
              placeholder="3000"
            />
          </div>
        )}
        {needs.has('min_mb') && (
          <div className="space-y-1.5">
            <Label htmlFor="toolbox-minmb">{t('tuning.bigFileMin')}</Label>
            <Input
              id="toolbox-minmb"
              className="w-32"
              inputMode="numeric"
              value={props.minMbInput}
              onChange={(e) => props.setMinMbInput(e.target.value)}
            />
          </div>
        )}
      </div>
    </PageSection>
  )
}

/**
 * 结果渲染：后端约定能给结构化数据的工具一律返回 `rows`（键名固定的对象数组），
 * 通用表格分支按第一行键名自动出表头，新工具不必改渲染代码。
 * 回落格式化 JSON 的分支必须保留（哈希值、回收站占用等非列表结果），空对话框会像"工具坏了"。
 */
function ToolResultView({ data }: { data: PcCleanToolResult }) {
  const { t } = useTranslation('pcclean')
  const [copied, setCopied] = useState(false)

  const copy = useCallback(() => {
    // 不用 try/catch：被 void 掉的 promise 拒绝不走同步 catch，会冒到 unhandledrejection。
    // 按返回值判断，"已复制"也只在真的成功时才亮。
    void copyText(JSON.stringify(data, null, 2)).then((ok) => {
      if (!ok) return
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    })
  }, [data])

  const rows = Array.isArray(data.rows) ? (data.rows as Record<string, unknown>[]) : null

  /**
   * 提示"这次没动的几项是因被保护"，是「清空最近使用」这个危险工具最重要的反馈
   * （用户最担心钉在快速访问的文件夹会不会没了）；沉默地保护等于不让用户知道差点丢了什么。
   * 后端契约是 `skippedReasons`（camelCase），但 `pcclean/` 既有字段是 snake_case，两个都认，
   * 认少了这一块会永远不显示且不报错。
   */
  const skipped = typeof data.skipped === 'number' && data.skipped > 0 ? data.skipped : 0
  const rawReasons = data.skippedReasons ?? data.skipped_reasons
  const skippedReasons = Array.isArray(rawReasons)
    ? rawReasons.filter((r): r is string => typeof r === 'string' && r !== '')
    : []

  const body = (() => {
    if (rows && rows.length > 0) {
      // 表头取所有行键名的并集：不同行可能缺字段（读不到温度的磁盘），
      // 只看第一行会把后面行的列整列丢掉。
      const columns: string[] = []
      for (const row of rows) {
        for (const key of Object.keys(row)) {
          if (!columns.includes(key)) columns.push(key)
        }
      }
      return (
        <div className="max-h-[460px] overflow-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-card">
              <tr className="border-b border-border text-left">
                {columns.map((column) => (
                  <th key={column} className="whitespace-nowrap py-2 pr-4 font-medium">
                    {column.replace(/_/g, ' ')}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={index} className="border-b border-border/40">
                  {columns.map((column) => (
                    <td
                      key={column}
                      className={cn(
                        'max-w-[28ch] truncate py-1.5 pr-4',
                        typeof row[column] === 'number' && 'tabular',
                        row[column] === undefined && 'text-muted-foreground',
                      )}
                      title={row[column] === undefined ? '' : String(row[column])}
                    >
                      {formatCell(column, row[column])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    }

    if (rows && rows.length === 0) {
      return <p className="text-sm text-muted-foreground">{t('health.categoryEmpty')}</p>
    }

    if (Array.isArray(data.holders)) {
      const holders = data.holders as { pid: number; name: string; service: string }[]
      return holders.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('health.categoryEmpty')}</p>
      ) : (
        <ul className="space-y-1.5">
          {holders.map((holder) => (
            <li key={holder.pid} className="flex items-baseline justify-between gap-4 text-sm">
              <span>{holder.name || holder.service}</span>
              <span className="text-2xs tabular text-muted-foreground">PID {holder.pid}</span>
            </li>
          ))}
        </ul>
      )
    }

    if (Array.isArray(data.plan)) {
      const plan = data.plan as { from: string; to: string; status: string }[]
      return (
        <div className="max-h-[460px] overflow-y-auto">
          <p className="mb-3 text-sm text-muted-foreground">
            {t('toolbox.found', { count: plan.length })}
          </p>
          <ul className="space-y-1 text-sm">
            {plan.map((row) => (
              <li key={row.from} className="flex items-baseline gap-2">
                <span className="min-w-0 flex-1 truncate">{row.from}</span>
                <span className="text-muted-foreground">→</span>
                <span className="min-w-0 flex-1 truncate">{row.to}</span>
                {row.status === 'conflict' && <Badge tone="danger">{t('toolbox.conflict')}</Badge>}
              </li>
            ))}
          </ul>
        </div>
      )
    }

    if (data.memory && typeof data.memory === 'object') {
      const memory = data.memory as Record<string, number>
      const volumes = (data.volumes ?? []) as { drive: string; total_bytes: number; free_bytes: number }[]
      const platform = (data.platform ?? {}) as Record<string, string>
      return (
        <div className="space-y-4 text-sm">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5">
            {Object.entries(platform).map(([key, value]) => (
              <div key={key} className="contents">
                <dt className="text-muted-foreground">{key}</dt>
                <dd className="truncate">{String(value)}</dd>
              </div>
            ))}
            <dt className="text-muted-foreground">{t('memory.total')}</dt>
            <dd>{formatBytes(memory.total_bytes ?? 0)}</dd>
            <dt className="text-muted-foreground">{t('memory.available')}</dt>
            <dd>{formatBytes(memory.available_bytes ?? 0)}</dd>
          </dl>
          <ul className="space-y-1">
            {volumes.map((vol) => (
              <li key={vol.drive} className="flex items-baseline justify-between gap-4">
                <span>{vol.drive}</span>
                <span className="text-2xs text-muted-foreground">
                  {t('defrag.free')} {formatBytes(vol.free_bytes)} / {formatBytes(vol.total_bytes)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )
    }

    if (typeof data.content === 'string') {
      return (
        <pre className="max-h-[460px] overflow-auto whitespace-pre-wrap rounded bg-muted p-4 text-2xs">
          {data.content}
        </pre>
      )
    }

    return (
      <pre className="max-h-[460px] overflow-auto whitespace-pre-wrap rounded bg-muted p-4 text-2xs">
        {JSON.stringify(data, null, 2)}
      </pre>
    )
  })()

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-2xs text-muted-foreground">
          {rows ? t('toolbox.resultRows', { count: rows.length }) : ''}
        </span>
        <Button variant="outline" size="sm" onClick={copy}>
          <Copy className="size-4" aria-hidden="true" />
          {copied ? t('toolbox.copied') : t('toolbox.copyResult')}
        </Button>
      </div>
      {skipped > 0 && (
        <Alert>
          <AlertDescription>
            <span className="flex items-center gap-1.5 font-medium text-success">
              <ShieldCheck className="size-4 shrink-0" aria-hidden="true" />
              {t('toolbox.protectedSkipped', { count: skipped })}
            </span>
            {skippedReasons.length > 0 && (
              <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-muted-foreground">
                {/* 原因是后端给的 i18n 键。翻不出来就原样显示那串键——
                    比显示空白强：至少能搜、能报给我们。 */}
                {skippedReasons.map((reason) => (
                  <li key={reason}>{t(pccleanErrorKey(reason), { defaultValue: reason })}</li>
                ))}
              </ul>
            )}
          </AlertDescription>
        </Alert>
      )}
      {body}
    </div>
  )
}

/** 表格单元格的显示值。只做三件事：字节列转人类可读、空值显示破折号、其余原样。 */
function formatCell(column: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  if (typeof value === 'boolean') return value ? '✓' : '—'
  if (typeof value === 'number') {
    if (column.endsWith('_bytes')) return formatBytes(value)
    if (Number.isInteger(value) && Math.abs(value) >= 10_000) return formatCount(value)
    return String(value)
  }
  return String(value)
}
