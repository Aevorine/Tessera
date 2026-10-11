import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { AlignLeft, Bot, Braces, Bug, Check, ChevronDown, ChevronRight, Cpu, History, Loader2, Mail, Paperclip, Send, Settings2, Square, Table2, Trash2, Wand2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { EmptyState, IconChip, PageHeader, PageShell } from '@/components/ui/page'
import { Textarea } from '@/components/ui/textarea'
import { Checkbox } from '@/components/ui/checkbox'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { vaultApi } from '@/lib/vaultApi'
import { electronApi } from '@/lib/electronApi'
import { translateError } from '@/i18n/errors'
import { cn } from '@/lib/utils'
import { stripMarkupTags } from '@/shared/plainText'
import type { AiChatMessage, AiHistoryListItem, AiModelDetail, AiSkill } from '@/shared/ipcTypes'

const NO_SKILL_VALUE = '__none__'

function basename(fullPath: string): string {
  const idx = Math.max(fullPath.lastIndexOf('/'), fullPath.lastIndexOf('\\'))
  return idx === -1 ? fullPath : fullPath.slice(idx + 1)
}

interface DisplayMessage {
  role: 'user' | 'assistant'
  content: string
  reasoningSteps?: ReasoningStep[]
  // 'done' = 模型正常给出文本回答；'stopped' = 触达工具调用轮数上限，基于部分上下文强制回复。
  // assistant 消息上二者必居其一。
  taskStatus?: 'done' | 'stopped'
  // 仅 assistant 消息、仅自动模式（未手选 skill）：模型自己决定调用了哪些 skill；不持久化，
  // 只是实时对话的透明度提示。
  skillsUsed?: string[]
  toolsUsed?: string[]
  webFetchesUsed?: string[]
}

interface ReasoningStep {
  title: string
  detail?: string
}

interface PendingAttachment {
  name: string
  text: string
  truncated: boolean
}

function stripDsmlTags(value: string): string {
  return stripMarkupTags(value).trim()
}

function extractReasoningFromReply(reply: string, t: (key: string, options?: Record<string, string>) => string) {
  const steps: ReasoningStep[] = []
  const dsmlBlockPattern = /<｜｜DSML｜｜tool_calls>[\s\S]*?<\/｜｜DSML｜｜tool_calls>/g
  const blocks = reply.match(dsmlBlockPattern) ?? []

  for (const block of blocks) {
    const invokePattern = /<｜｜DSML｜｜invoke name="([^"]+)">([\s\S]*?)<\/｜｜DSML｜｜invoke>/g
    let invokeMatch: RegExpExecArray | null
    while ((invokeMatch = invokePattern.exec(block)) !== null) {
      const [, toolName, invokeBody] = invokeMatch
      const params: string[] = []
      const parameterPattern = /<｜｜DSML｜｜parameter name="([^"]+)"[^>]*>([\s\S]*?)<\/｜｜DSML｜｜parameter>/g
      let parameterMatch: RegExpExecArray | null
      while ((parameterMatch = parameterPattern.exec(invokeBody)) !== null) {
        params.push(`${parameterMatch[1]}=${stripDsmlTags(parameterMatch[2])}`)
      }
      steps.push({
        title: t('reasoningToolCallTitle', { tool: toolName }),
        detail: params.length > 0 ? params.join('\n') : undefined,
      })
    }
  }

  const cleaned = reply.replace(dsmlBlockPattern, '').trim()
  return {
    content: cleaned || reply,
    reasoningSteps: steps,
  }
}

/**
 * 空对话时的六个可点击起手式，点一下填进输入框；替掉原来读一次就没用的说明文字。
 * 六个在 1920 宽排两行三列、窄窗口退成一列；选的是用户手边真有的东西（改写、看不懂的代码、
 * 整理资料、长文总结、写邮件、查报错），不做演示型例子。
 */
function AiStarters({ onPick }: { onPick: (text: string) => void }) {
  const { t } = useTranslation('ai')
  const starters = [
    { id: 'rewrite', icon: Wand2 },
    { id: 'explainCode', icon: Braces },
    { id: 'toTable', icon: Table2 },
    { id: 'summarize', icon: AlignLeft },
    { id: 'draftEmail', icon: Mail },
    { id: 'debug', icon: Bug },
  ] as const
  return (
    // 竖直居中：空对话面板有八百多像素高，贴顶会留下说不清的大片空白。
    <div className="flex min-h-full flex-col justify-center">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {starters.map(({ id, icon: Icon }) => {
        const text = t(`starter.${id}`)
        return (
          <button
            key={id}
            type="button"
            onClick={() => onPick(text)}
            className="ds-focus-ring flex items-start gap-3 rounded-lg border border-border/70 bg-card p-4 text-start transition-colors hover:border-accent-line hover:bg-accent-soft/50"
          >
            <IconChip icon={Icon} size="sm" className="shrink-0" />
            <span className="min-w-0 text-sm leading-relaxed">{text}</span>
          </button>
        )
      })}
      </div>
    </div>
  )
}

// 对话每轮落盘到加密 ai_history.db（见 handleSend）；historyId 标记就地更新的行，handleClear
// 重置为 null 以免覆盖刚清掉的那行。
export function AIChatScreen({ onGoToSettings, isProfessional = false }: { onGoToSettings: () => void; isProfessional?: boolean }) {
  const { t } = useTranslation('ai')
  const [configured, setConfigured] = useState<boolean | null>(null)
  // 当前模型 + 服务端提供的可选模型。换模型会写回全局配置（见 handleModelChange）。
  const [model, setModel] = useState('')
  const [models, setModels] = useState<string[]>([])
  // 带发布日期的同一批模型；后端旧版没有这个字段时退回只用 models（少日期，不失能）。
  const [modelDetails, setModelDetails] = useState<AiModelDetail[]>([])
  const [loadingModels, setLoadingModels] = useState(false)
  const [messages, setMessages] = useState<DisplayMessage[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [skills, setSkills] = useState<AiSkill[]>([])
  const [selectedSkillId, setSelectedSkillId] = useState(NO_SKILL_VALUE)
  const [attachment, setAttachment] = useState<PendingAttachment | null>(null)
  const [manageOpen, setManageOpen] = useState(false)
  const [importing, setImporting] = useState(false)
  const [selectedForDelete, setSelectedForDelete] = useState<Set<string>>(new Set())
  const [historyId, setHistoryId] = useState<number | null>(null)
  const [history, setHistory] = useState<AiHistoryListItem[]>([])
  const [historyOpen, setHistoryOpen] = useState(false)
  const [selectedHistoryForDelete, setSelectedHistoryForDelete] = useState<Set<number>>(new Set())
  const [confirmDeleteAllOpen, setConfirmDeleteAllOpen] = useState(false)
  const [collapsedReasoning, setCollapsedReasoning] = useState<Set<number>>(new Set())
  const listEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    vaultApi.call('get_ai_config', {}).then((res) => {
      setConfigured(res.config?.configured ?? false)
      setModel(res.config?.model ?? '')
    })
    refreshSkills()
    refreshHistory()
  }, [])

  /** 拉一次服务端模型列表；不在挂载时自动拉（真实网络请求，多数时候用户只是来聊天），点了才拉。 */
  async function loadModels() {
    if (models.length > 0 || loadingModels) return
    setLoadingModels(true)
    try {
      const res = await vaultApi.call('list_ai_models', {})
      if (res.ok) {
        setModels(res.models)
        setModelDetails(
          res.model_details ?? res.models.map((id) => ({ id, label: id, released: null, note: null, deprecated: null })),
        )
      }
    } finally {
      setLoadingModels(false)
    }
  }

  /**
   * 换模型是改全局配置而非本次对话：剪贴板翻译/总结、解密摘要用同一份配置，
   * 只改局部状态会让它们继续用旧模型而界面看不出。
   */
  // 触发器显示：后端给了友好名就用，否则用原始 id（自建端点和手输名不在目录里）；有意不含发布日期，
  // 那属于展开列表。
  const selectedModelLabel = model
    ? (modelDetails.find((d) => d.id === model)?.label ?? model)
    : ''

  async function handleModelChange(next: string) {
    if (!next || next === model) return
    const previous = model
    setModel(next)
    const res = await vaultApi.call('update_ai_config', { api_key: '', model: next, base_url: '' })
    if (!res.ok) {
      setModel(previous)  // 没存进去就别让界面显示成已经换了
      toast.error(t('modelSwitchFailedToast'), { description: translateError(res.error, res.error_params) })
      return
    }
    toast.success(t('modelSwitchedToast', { model: next }))
  }

  useEffect(() => {
    listEndRef.current?.scrollIntoView({ block: 'end' })
  }, [messages, sending])

  // Ctrl+A inside the history dialog selects every saved conversation for
  // deletion, instead of the browser's default select-all-text behavior.
  useEffect(() => {
    if (!historyOpen) return
    function onKeyDown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault()
        setSelectedHistoryForDelete(new Set(history.map((h) => h.id)))
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [historyOpen, history])

  function refreshSkills() {
    vaultApi.call('ai_skill_list', {}).then((res) => setSkills(res.skills))
  }

  function refreshHistory() {
    vaultApi.call('ai_history_list', {}).then((res) => setHistory(res.conversations))
  }

  // Skill 来源是 SKILL.md 文件或含它的文件夹。Windows
  // 单个原生对话框无法同时选文件和文件夹（会静默退化为只选文件夹），所以分开两个入口，
  // 都支持多选并汇入同一批量导入调用。
  async function handleImportSkills(mode: 'file' | 'folder') {
    const paths = await electronApi.openFiles(
      mode === 'file'
        ? {
            title: t('importSkillFilesButton'),
            properties: ['openFile', 'multiSelections'],
            filters: [
              { name: 'SKILL.md', extensions: ['md', 'txt'] },
              { name: 'All Files', extensions: ['*'] },
            ],
          }
        : {
            title: t('importSkillFoldersButton'),
            properties: ['openDirectory', 'multiSelections'],
          },
    )
    if (!paths || paths.length === 0) return

    setImporting(true)
    const res = await vaultApi.call('ai_skill_import', { paths })
    setImporting(false)
    if (!res.ok) {
      toast.error(t('skillImportFailedToast'), { description: translateError(res.error, res.error_params) })
      return
    }

    const imported = res.results.filter((r) => r.ok && r.skill).map((r) => r.skill as AiSkill)
    const failed = res.results.filter((r) => !r.ok)
    if (imported.length > 0) {
      setSkills((prev) => [...prev, ...imported])
      setSelectedSkillId(imported[imported.length - 1].id)
    }
    if (failed.length === 0) {
      toast.success(t('skillsImportedToast', { count: imported.length }))
    } else if (imported.length > 0) {
      toast.warning(t('skillsImportPartialToast', { success: imported.length, failed: failed.length }))
    } else {
      const first = failed[0]
      toast.error(t('skillImportFailedToast'), { description: translateError(first.error ?? '', first.error_params) })
    }
  }

  function toggleDeleteSelection(id: string, checked: boolean) {
    setSelectedForDelete((prev) => {
      const next = new Set(prev)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  }

  function toggleSelectAllForDelete(checked: boolean) {
    setSelectedForDelete(checked ? new Set(skills.map((s) => s.id)) : new Set())
  }

  async function handleDeleteSelectedSkills() {
    if (selectedForDelete.size === 0) return
    const ids = Array.from(selectedForDelete)
    setSkills((prev) => prev.filter((s) => !selectedForDelete.has(s.id)))
    if (selectedForDelete.has(selectedSkillId)) setSelectedSkillId(NO_SKILL_VALUE)
    setSelectedForDelete(new Set())
    await vaultApi.call('ai_skill_delete', { ids })
    toast.success(t('skillsDeletedToast', { count: ids.length }))
  }

  async function handleAttach() {
    const paths = await electronApi.openFiles({
      title: t('attachButton'),
      properties: ['openFile'],
    })
    if (!paths || paths.length === 0) return
    const res = await vaultApi.call('ai_read_text_file', { path: paths[0] })
    if (!res.ok) {
      toast.error(t('attachFailedToast'), { description: translateError(res.error, res.error_params) })
      return
    }
    setAttachment({ name: basename(paths[0]), text: res.text, truncated: res.truncated })
  }

  async function handleSend() {
    const text = input.trim()
    if ((!text && !attachment) || sending) return

    const attachmentBlock = attachment
      ? `[${t('attachedFileLabel', { name: attachment.name })}]\n\`\`\`\n${attachment.text}\n\`\`\`\n\n`
      : ''
    const content = attachmentBlock + text
    const nextMessages: DisplayMessage[] = [...messages, { role: 'user', content }]
    setMessages(nextMessages)
    setCollapsedReasoning(new Set())
    setInput('')
    setAttachment(null)
    setSending(true)

    const skill = skills.find((s) => s.id === selectedSkillId)
    const apiMessages: AiChatMessage[] = [
      ...(skill ? [{ role: 'system' as const, content: skill.content }] : []),
      ...nextMessages.map((m) => ({ role: m.role, content: m.content })),
    ]
    const res = await vaultApi.call('ai_chat', { messages: apiMessages })
    setSending(false)
    if (!res.ok) {
      toast.error(t('sendFailedToast'), { description: translateError(res.error, res.error_params) })
      return
    }
    const parsedReply = extractReasoningFromReply(res.reply, t)
    const assistantMessage: DisplayMessage = {
      role: 'assistant',
      content: parsedReply.content,
      reasoningSteps: parsedReply.reasoningSteps,
      taskStatus: res.stopped ? 'stopped' : 'done',
    }
    if (res.skills_used.length > 0) assistantMessage.skillsUsed = res.skills_used
    if (res.tools_used.length > 0) assistantMessage.toolsUsed = res.tools_used
    if (res.web_fetches.length > 0) assistantMessage.webFetchesUsed = res.web_fetches
    const finalMessages: DisplayMessage[] = [...nextMessages, assistantMessage]
    setMessages(finalMessages)

    // 自动保存：用 historyId upsert，一轮长对话只更新一行；保存失败不应打断聊天。
    // skillsUsed 有意丢弃（实时提示，不属于存档；ai_history_save 本也拒绝非 user/assistant 的
    // role/key）。
    const saveRes = await vaultApi.call('ai_history_save', {
      id: historyId ?? undefined,
      messages: finalMessages.map((m) => ({ role: m.role, content: m.content })),
    })
    if (saveRes.ok) {
      setHistoryId(saveRes.conversation.id)
      refreshHistory()
    }
  }

  function handleClear() {
    setMessages([])
    setCollapsedReasoning(new Set())
    setHistoryId(null)
  }

  function toggleReasoning(index: number) {
    setCollapsedReasoning((prev) => {
      const next = new Set(prev)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }

  function toggleHistorySelection(id: number, checked: boolean) {
    setSelectedHistoryForDelete((prev) => {
      const next = new Set(prev)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  }

  function toggleSelectAllHistory(checked: boolean) {
    setSelectedHistoryForDelete(checked ? new Set(history.map((h) => h.id)) : new Set())
  }

  async function handleOpenHistoryEntry(id: number) {
    const res = await vaultApi.call('ai_history_get', { id })
    if (!res.ok) {
      toast.error(t('historyLoadFailedToast'), { description: translateError(res.error, res.error_params) })
      return
    }
    setMessages(res.conversation.messages.filter((m): m is DisplayMessage => m.role !== 'system'))
    setCollapsedReasoning(new Set())
    setHistoryId(res.conversation.id)
    setHistoryOpen(false)
  }

  async function handleDeleteSelectedHistory() {
    if (selectedHistoryForDelete.size === 0) return
    const ids = Array.from(selectedHistoryForDelete)
    setHistory((prev) => prev.filter((h) => !selectedHistoryForDelete.has(h.id)))
    if (historyId !== null && selectedHistoryForDelete.has(historyId)) setHistoryId(null)
    setSelectedHistoryForDelete(new Set())
    await vaultApi.call('ai_history_delete', { ids })
    toast.success(t('historyDeletedToast', { count: ids.length }))
  }

  async function handleDeleteAllHistory() {
    setConfirmDeleteAllOpen(false)
    setHistory([])
    setSelectedHistoryForDelete(new Set())
    setHistoryId(null)
    await vaultApi.call('ai_history_delete_all', {})
    toast.success(t('historyAllDeletedToast'))
  }

  if (configured === false) {
    return (
      <PageShell width="canvas">
        <PageHeader title={t('pageTitle')} />
        <EmptyState
          icon={Bot}
          title={t('pageTitle')}
          action={<Button onClick={onGoToSettings}>{t('goToSettingsButton')}</Button>}
        />
      </PageShell>
    )
  }

  const allSelectedForDelete = skills.length > 0 && selectedForDelete.size === skills.length
  const allHistorySelected = history.length > 0 && selectedHistoryForDelete.size === history.length

  return (
    // `h-screen` 改 `min-h-0 flex-1`：本页在已占满视口的 <main> 里且上方有「接着刚才」横幅，
    // 再声明整个视口高会超出，底部输入框被 overflow-hidden 裁掉。
    // 上边距 py-7 改 pt-4，与 PageShell 的 pt 档对齐（见 page.tsx）。
    <div className="ds-page-wash flex min-h-0 w-full max-w-none flex-1 flex-col px-8 pt-4 pb-7">
      {/* 标题栏走 <PageHeader>，不自己拼——手抄的那一份是 items-center/gap-3/pb-4，
          跟 PageHeader 的 items-start/gap-x-6/pb-5 差一档，切面板时标题会跳。 */}
      <PageHeader
        className="mb-4"
        
        title={t('pageTitle')}
        actions={
          <>
            {/* 模型就摆在标题栏上：它决定了这次对话的质量和花费，是使用过程中
                真正会想改的东西，不该藏进设置页。改了立刻对全应用的 AI 功能生效。 */}
          <Select value={model} onValueChange={handleModelChange} onOpenChange={(o) => o && void loadModels()}>
            {/* The trigger renders its OWN label rather than letting SelectValue
                clone the selected item's children. Those children are two lines
                (name over release date) and the trigger clamps to one
                (`line-clamp-1` in select.tsx), so cloning them cut the model
                name off mid-word - the taller the item, the less of the name
                survived. Width grows with the text up to a cap instead of being
                pinned at w-52, and whatever still doesn't fit truncates with an
                ellipsis and stays readable via the tooltip. */}
            <SelectTrigger
              className="h-8 min-w-52 max-w-[24rem]"
              aria-label={t('modelSelectLabel')}
              title={selectedModelLabel || undefined}
            >
              {loadingModels ? <Loader2 className="size-3.5 shrink-0 animate-spin" /> : <Cpu className="size-3.5 shrink-0 text-muted-foreground" />}
              <SelectValue placeholder={t('modelSelectLabel')}>
                <span className="truncate">{selectedModelLabel}</span>
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {/* 当前模型永远在列表里：服务端可能没列出它（自建端点、或者用户
                  手填了个更新的名字），少了它下拉会显示成空选中态。 */}
              {(() => {
                // 按后端排好的顺序（发布日期新→旧）走 modelDetails；还没拉到列表时
                // 至少要有当前这一项，否则下拉是空选中态。
                const byId = new Map(modelDetails.map((d) => [d.id, d]))
                const ids = [...new Set([...modelDetails.map((d) => d.id), model, ...models])].filter(Boolean)
                return ids.map((id) => {
                  const d = byId.get(id)
                  return (
                    // textValue keeps type-ahead working now that the visible
                    // children are a two-line block rather than plain text.
                    <SelectItem key={id} value={id} textValue={d?.label ?? id}>
                      <span className="flex flex-col items-start">
                        <span>{d?.label ?? id}</span>
                        {d?.released && (
                          <span className="text-sm text-muted-foreground tabular">
                            {t('modelReleasedLabel', { date: d.released })}
                          </span>
                        )}
                      </span>
                    </SelectItem>
                  )
                })
              })()}
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={() => setHistoryOpen(true)}>
            <History className="mr-1 h-4 w-4" />
            {t('historyButton')}
          </Button>
            <Button variant="ghost" size="sm" onClick={handleClear} disabled={messages.length === 0}>
              <Trash2 className="mr-1 h-4 w-4" />
              {t('clearButton')}
            </Button>
          </>
        }
      />

      <div className="mb-3 flex items-center gap-2">
        <Select value={selectedSkillId} onValueChange={setSelectedSkillId}>
          <SelectTrigger className="w-48">
            <SelectValue placeholder={t('skillLabel')} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_SKILL_VALUE}>{t('noSkillOption')}</SelectItem>
            {skills.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {isProfessional && (
          <Button variant="outline" size="sm" onClick={() => setManageOpen(true)}>
            <Settings2 className="mr-1 h-4 w-4" />
            {t('manageSkillsButton')}
          </Button>
        )}
      </div>

      {/* text-[15px] 是一处逃逸：这是全应用**读得最多**的一块正文（一整段一整段
          的模型回复），却比别处小一档。正文下限是 16px（text-sm），没有例外。

          `max-w-[90ch]` 是页面铺满宽度之后必须加的一道闸：这一块是纯正文，
          一行超过约 90 个字符，眼睛从行尾回到下一行行首就会找错行，一整段读下来
          要反复重新定位。**铺满指的是页面用满屏幕，不是让每一行文字横穿屏幕**——
          后者是实打实的可读性倒退。所以外框限行长、居中，而下面的输入框不限
          （那是控件不是正文，宽一点只有好处）。 */}
      {/* ---- 为什么外框不再限宽 ---------------------------------------------
          这里原先是 `mx-auto max-w-[90ch]`。90ch 在这套字体下约 900px——1920 的
          屏幕上左右各空掉将近 400px，而用户反复报的正是"左右都为空白"。

          可限行长这件事本身没错：一行超过约 90 个字符，眼睛从行尾回到下一行
          行首就会找错行。错的是**限错了层**——把闸门放在外框上，等于连带把
          "你说的"和"它说的"那两条气泡的排布、以及整块面板的背景一起锁死了。

          现在闸门下移到气泡自己身上（下面那个 `max-w-[76ch]`）：外框铺满，
          气泡按对话的左右分列，正文行长仍然受控。铺满指的是**页面用满屏幕**，
          不是让每一行文字横穿屏幕——两者不冲突，只是要放在不同的层上。 */}
      <div className="w-full min-h-0 flex-1 space-y-5 overflow-y-auto rounded-xl border border-border bg-surface p-6 text-sm">
        {messages.length === 0 && <AiStarters onPick={setInput} />}
        {messages.map((m, i) => {
          const reasoningCollapsed = collapsedReasoning.has(i)
          const hasReasoning = m.role === 'assistant' && m.reasoningSteps && m.reasoningSteps.length > 0
          return (
          <div key={i} className={cn('flex flex-col', m.role === 'user' ? 'items-end' : 'items-start')}>
            <span className="mb-1 text-sm font-medium text-muted-foreground">
              {m.role === 'user' ? t('youLabel') : t('assistantLabel')}
            </span>
            {/* 行长的闸门在这一层：外框铺满屏幕，正文仍然不超过约 76 个字符。
                助手的回复是整段整段的散文，最需要这道闸；用户自己打的那条通常
                很短，给它 `w-fit` 让气泡贴着字长走，同样不许超过这个上限。 */}
            <div className={cn('group max-w-[76ch]', m.role === 'user' ? 'w-fit' : 'w-full')}>
              <button
                type="button"
                onClick={() => hasReasoning && toggleReasoning(i)}
                className={cn(
                  'w-full whitespace-pre-wrap rounded-lg px-3.5 py-2.5 text-left leading-relaxed',
                  m.role === 'user' ? 'bg-primary text-primary-foreground' : 'bg-muted',
                  hasReasoning && 'cursor-pointer',
                )}
                aria-expanded={hasReasoning ? !reasoningCollapsed : undefined}
              >
                {hasReasoning && (
                  <span className="mb-2 flex items-center gap-1.5 border-b border-border/60 pb-2 text-sm text-muted-foreground">
                    {reasoningCollapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                    {t('reasoningHeader')}
                  </span>
                )}
                {hasReasoning && !reasoningCollapsed && (
                  <span className="mb-2 block space-y-1.5 border-b border-border/60 pb-2 text-sm text-muted-foreground">
                    {m.reasoningSteps?.map((step, stepIndex) => (
                      <span key={stepIndex} className="block">
                        <span className="font-medium text-foreground/80">{step.title}</span>
                        {step.detail && <span className="mt-0.5 block whitespace-pre-wrap">{step.detail}</span>}
                      </span>
                    ))}
                  </span>
                )}
                <span>{m.content}</span>
              </button>
              {m.taskStatus === 'stopped' && (
                <span className="mt-1.5 flex items-center gap-1.5 text-sm text-muted-foreground">
                  <Square className="h-3 w-3 fill-current" />
                  {t('taskStoppedLabel')}
                </span>
              )}
              {m.taskStatus === 'done' && (
                <span className="mt-1.5 flex items-center gap-1.5 text-sm text-muted-foreground">
                  <Check className="h-3 w-3" />
                  {t('taskDoneLabel')}
                </span>
              )}
            </div>
            {m.skillsUsed && m.skillsUsed.length > 0 && (
              <span className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                {t('skillsUsedHint', { names: m.skillsUsed.join(', ') })}
              </span>
            )}
            {m.toolsUsed && m.toolsUsed.length > 0 && (
              <span className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                {t('desktopToolsUsedHint', { names: m.toolsUsed.join(', ') })}
              </span>
            )}
            {m.webFetchesUsed && m.webFetchesUsed.length > 0 && (
              <span className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                {t('webFetchUsedHint', { urls: m.webFetchesUsed.join(', ') })}
              </span>
            )}
          </div>
          )
        })}
        {sending && (
          <div className="flex flex-col items-start">
            <span className="mb-1 text-sm font-medium text-muted-foreground">{t('assistantLabel')}</span>
            <div className="flex w-full items-center gap-2 rounded-lg bg-muted px-3.5 py-2.5 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('taskRunningLabel')}
            </div>
          </div>
        )}
        <div ref={listEndRef} />
      </div>

      {attachment && (
        <div className="mt-2 flex items-center gap-2 rounded border px-2 py-1 text-sm">
          <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">
            {t('attachedFileLabel', { name: attachment.name })}
            {attachment.truncated ? ` · ${t('attachTruncatedHint')}` : ''}
          </span>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={t('removeAttachmentAriaLabel')}
                onClick={() => setAttachment(null)}
                className="shrink-0 text-muted-foreground hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent>{t('removeAttachmentAriaLabel')}</TooltipContent>
          </Tooltip>
        </div>
      )}

      {/* 输入区 —— 这一页最主要的输入场所，按"输入内容多就要给足面积"来做。
          原先它是一个单行 <Input>：写一段稍长的提示词，前面的内容立刻滚出视野，
          既看不到自己写了什么，也没法回头改。而 onKeyDown 里已经写着
          `!e.shiftKey`——也就是说"Shift+Enter 换行"这个意图一直都在，只是单行
          输入框根本换不了行。

          现在是一块多行文本域：默认就有四五行高，右下角可以拖着加高（resize-y），
          Enter 发送、Shift+Enter 换行（e.preventDefault() 不能省，否则 Enter 会
          在发送的同时留下一个换行）。焦点环画在外层容器上，让文本域、附件按钮、
          发送按钮看起来是一件东西而不是三件。 */}
      <div className="mt-3 rounded-xl border border-border bg-card p-3 transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50">
        <Textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              handleSend()
            }
          }}
          placeholder={t('inputPlaceholder')}
          disabled={sending}
          aria-label={t('inputPlaceholder')}
          className="min-h-32 resize-y border-0 bg-transparent px-1.5 py-1 leading-relaxed shadow-none focus-visible:border-0 focus-visible:ring-0"
        />
        <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 border-t border-border/70 pt-2.5">
          <div className="flex min-w-0 items-center gap-2.5">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="outline" size="icon" onClick={handleAttach} disabled={sending} aria-label={t('attachButton')}>
                  <Paperclip className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('attachButton')}</TooltipContent>
            </Tooltip>
          </div>
          <Button onClick={handleSend} disabled={sending || (!input.trim() && !attachment)}>
            <Send className="mr-1 h-4 w-4" />
            {sending ? t('sendingButton') : t('sendButton')}
          </Button>
        </div>
      </div>

      <Dialog open={manageOpen} onOpenChange={setManageOpen}>
        <DialogContent className="max-w-lg" aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>{t('manageSkillsDialogTitle')}</DialogTitle>
          </DialogHeader>

          <div className="flex items-center justify-between">
            <div className="flex gap-2">
              <Button size="sm" onClick={() => handleImportSkills('file')} disabled={importing}>
                {importing ? t('sendingButton') : t('importSkillFilesButton')}
              </Button>
              <Button size="sm" variant="outline" onClick={() => handleImportSkills('folder')} disabled={importing}>
                {t('importSkillFoldersButton')}
              </Button>
            </div>
            {skills.length > 0 && (
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={allSelectedForDelete} onCheckedChange={(v) => toggleSelectAllForDelete(v === true)} />
                {t('selectAllLabel')}
              </label>
            )}
          </div>

          <div className="max-h-72 space-y-1 overflow-y-auto">
            {skills.length === 0 && <p className="text-sm text-muted-foreground">{t('noSkillsYetHint')}</p>}
            {skills.map((s) => (
              <label key={s.id} className="flex items-start gap-2 rounded border p-2">
                <Checkbox
                  className="mt-0.5"
                  checked={selectedForDelete.has(s.id)}
                  onCheckedChange={(v) => toggleDeleteSelection(s.id, v === true)}
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{s.name}</div>
                  <div className="truncate text-sm text-muted-foreground">
                    {s.description || t('skillNoDescriptionHint')}
                  </div>
                </div>
              </label>
            ))}
          </div>

          <DialogFooter>
            <Button
              variant="destructive"
              size="sm"
              disabled={selectedForDelete.size === 0}
              onClick={handleDeleteSelectedSkills}
              aria-label={t('deleteSkillAriaLabel')}
            >
              <Trash2 className="mr-1 h-4 w-4" />
              {t('deleteSelectedSkillsButton')}
            </Button>
            <Button variant="outline" size="sm" onClick={() => setManageOpen(false)}>
              {t('closeButton')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
        <DialogContent className="max-w-lg" aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>{t('historyDialogTitle')}</DialogTitle>
          </DialogHeader>

          {history.length > 0 && (
            <div className="flex items-center justify-between">
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={allHistorySelected} onCheckedChange={(v) => toggleSelectAllHistory(v === true)} />
                {t('selectAllLabel')}
              </label>
            </div>
          )}

          <div className="max-h-80 space-y-1 overflow-y-auto">
            {history.length === 0 && <p className="text-sm text-muted-foreground">{t('noHistoryYetHint')}</p>}
            {history.map((h) => (
              <div key={h.id} className="flex items-start gap-2 rounded border p-2">
                <Checkbox
                  className="mt-0.5"
                  checked={selectedHistoryForDelete.has(h.id)}
                  onCheckedChange={(v) => toggleHistorySelection(h.id, v === true)}
                />
                <button type="button" onClick={() => handleOpenHistoryEntry(h.id)} className="min-w-0 flex-1 text-left">
                  {/* The user's own opening question is the entry's title, bolded, so it stands
                      out at a glance when scanning past conversations - see 特别标出我提出的问题要求. */}
                  <div className="truncate text-sm font-semibold">{h.first_question || t('untitledHistoryHint')}</div>
                  <div className="truncate text-sm text-muted-foreground">
                    {t('historyMetaLabel', { count: h.message_count, date: h.updated_at.replace('T', ' ') })}
                  </div>
                </button>
              </div>
            ))}
          </div>

          <DialogFooter>
            <Button
              variant="destructive"
              size="sm"
              disabled={selectedHistoryForDelete.size === 0}
              onClick={handleDeleteSelectedHistory}
            >
              <Trash2 className="mr-1 h-4 w-4" />
              {t('deleteSelectedHistoryButton')}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={history.length === 0}
              onClick={() => setConfirmDeleteAllOpen(true)}
            >
              {t('deleteAllHistoryButton')}
            </Button>
            <Button variant="outline" size="sm" onClick={() => setHistoryOpen(false)}>
              {t('closeButton')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmDeleteAllOpen} onOpenChange={setConfirmDeleteAllOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('confirmDeleteAllHistoryTitle')}</DialogTitle>
            <DialogDescription>{t('confirmDeleteAllHistoryBody')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="destructive" size="sm" onClick={handleDeleteAllHistory}>
              {t('deleteAllHistoryButton')}
            </Button>
            <Button variant="outline" size="sm" onClick={() => setConfirmDeleteAllOpen(false)}>
              {t('closeButton')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
