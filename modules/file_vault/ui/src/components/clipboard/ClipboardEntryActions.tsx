import {
  AlignLeft,
  ArrowLeftRight,
  Eye,
  EyeOff,
  Languages,
  MoreHorizontal,
  PencilLine,
  Pin,
  PinOff,
  SquarePen,
  TextSelect,
  Trash2,
  Wand2,
  type LucideIcon,
} from 'lucide-react'

import { ActionButton } from '@/components/ActionButton'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { LABEL_REGIONS } from '@/lib/labelMode'
import { quickConvertOptionsFor, type QuickConvertKind } from '@/lib/clipboardConvert'
import { isRecipe } from '@/lib/recipe'
import type { ClipboardEntry } from '@/shared/ipcTypes'

// 一条剪贴板记录能做的事，描述一次、画两遍：
// 原先九颗按钮铺在列表行里（约 300px），而左栏只有 280–420px，预览宽度会变负数而不显示。
// 现在行里只留一颗「更多」菜单，右栏详情里摊成带悬停提示的图标按钮；
// 两种画法共用同一张描述表，免得加操作时漏改一处。

export type AiClipboardAction = 'translate' | 'summarize' | 'polish'

export type ClipboardActionHandlers = {
  onAiAction?: (action: AiClipboardAction) => void
  /** 这条片段带 `{{空位}}`——填完再复制。见 lib/recipe.ts。 */
  onFillRecipe?: () => void
  onPartialCopy?: () => void
  onQuickConvert?: (kind: QuickConvertKind) => void
  onTogglePinned?: () => void
  onToggleHidden?: () => void
  onEdit?: () => void
  onDelete?: () => void
}

type ActionDef = {
  id: string
  icon: LucideIcon
  label: string
  destructive?: boolean
  run: () => void
}

/**
 * 把处理函数与条目内容算成操作清单：AI 三件套和「复制片段」只对有文字的非图片条目出现，转换仅在
 * classifier 认为可转时出现。
 */
function clipboardActionsFor(
  entry: ClipboardEntry,
  t: (key: string) => string,
  h: ClipboardActionHandlers,
): { actions: ActionDef[]; convertKinds: QuickConvertKind[]; onQuickConvert?: (k: QuickConvertKind) => void } {
  const actions: ActionDef[] = []
  const textual = entry.content_type !== 'image' && Boolean(entry.content_text)

  if (h.onAiAction && textual) {
    actions.push({ id: 'translate', icon: Languages, label: t('aiTranslateAction'), run: () => h.onAiAction?.('translate') })
    actions.push({ id: 'summarize', icon: AlignLeft, label: t('aiSummarizeAction'), run: () => h.onAiAction?.('summarize') })
    actions.push({ id: 'polish', icon: Wand2, label: t('aiPolishAction'), run: () => h.onAiAction?.('polish') })
  }
  // 排最前：配方的主要用法就是填它；只在真有空位时出现，点了没反应的菜单项比没有更糟。
  if (h.onFillRecipe && textual && isRecipe(entry.content_text)) {
    actions.push({ id: 'fillRecipe', icon: SquarePen, label: t('fillRecipeAction'), run: () => h.onFillRecipe?.() })
  }
  if (h.onPartialCopy && textual) {
    actions.push({ id: 'partialCopy', icon: TextSelect, label: t('partialCopyButton'), run: () => h.onPartialCopy?.() })
  }
  if (h.onTogglePinned) {
    actions.push({
      id: 'pin',
      icon: entry.is_pinned ? PinOff : Pin,
      label: entry.is_pinned ? t('unpinEntryAction') : t('pinEntryAction'),
      run: () => h.onTogglePinned?.(),
    })
  }
  if (h.onToggleHidden) {
    actions.push({
      id: 'hide',
      icon: entry.is_hidden ? EyeOff : Eye,
      label: entry.is_hidden ? t('unhideEntryAction') : t('hideEntryAction'),
      run: () => h.onToggleHidden?.(),
    })
  }
  if (h.onEdit) {
    actions.push({ id: 'edit', icon: PencilLine, label: t('editSnippetAction'), run: () => h.onEdit?.() })
  }
  if (h.onDelete) {
    actions.push({ id: 'delete', icon: Trash2, label: t('deleteEntryAction'), destructive: true, run: () => h.onDelete?.() })
  }

  const convertKinds = h.onQuickConvert ? quickConvertOptionsFor(entry) : []
  return { actions, convertKinds, onQuickConvert: h.onQuickConvert }
}

/**
 * 列表行里的那一颗。`stopPropagation` 不能省：整行点击是「立刻粘贴」，不拦会误把内容粘到别的程序。
 */
export function ClipboardRowMenu({
  entry,
  t,
  ...handlers
}: { entry: ClipboardEntry; t: (key: string) => string } & ClipboardActionHandlers) {
  const { actions, convertKinds, onQuickConvert } = clipboardActionsFor(entry, t, handlers)
  if (actions.length === 0 && convertKinds.length === 0) return null
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <ActionButton
          region={LABEL_REGIONS.clipboardRow}
          stopPropagation
          icon={MoreHorizontal}
          label={t('rowMenuButton')}
          className="shrink-0"
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
        {actions.map((a) => (
          <DropdownMenuItem key={a.id} onSelect={a.run} className={a.destructive ? 'text-destructive' : undefined}>
            <a.icon className="me-2 size-4" aria-hidden="true" />
            {a.label}
          </DropdownMenuItem>
        ))}
        {convertKinds.length > 0 && (
          <>
            {actions.length > 0 && <DropdownMenuSeparator />}
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <ArrowLeftRight className="me-2 size-4" aria-hidden="true" />
                {t('quickConvertButton')}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {convertKinds.map((kind) => (
                  <DropdownMenuItem key={kind} onSelect={() => onQuickConvert?.(kind)}>
                    {t(`quickConvert.${kind}`)}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * 右栏详情顶部的一排：对选中条目的操作固定在同一位置（同密码页、笔记页），摊开成带悬停提示的图标按
 * 钮（ActionButton 强制 label）。
 */
export function ClipboardDetailActions({
  entry,
  t,
  ...handlers
}: { entry: ClipboardEntry; t: (key: string) => string } & ClipboardActionHandlers) {
  const { actions, convertKinds, onQuickConvert } = clipboardActionsFor(entry, t, handlers)
  if (actions.length === 0 && convertKinds.length === 0) return null
  return (
    <>
      {actions.map((a) => (
        <ActionButton
          key={a.id}
          region={LABEL_REGIONS.clipboardDetailToolbar}
          icon={a.icon}
          label={a.label}
          variant={a.destructive ? 'destructive' : 'outline'}
          onClick={a.run}
        />
      ))}
      {convertKinds.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <ActionButton
              region={LABEL_REGIONS.clipboardDetailToolbar}
              icon={ArrowLeftRight}
              label={t('quickConvertButton')}
              variant="outline"
            />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {convertKinds.map((kind) => (
              <DropdownMenuItem key={kind} onSelect={() => onQuickConvert?.(kind)}>
                {t(`quickConvert.${kind}`)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </>
  )
}
