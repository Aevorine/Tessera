import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Keyboard } from 'lucide-react'

import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { TooltipProvider } from '@/components/ui/tooltip'
import { FeatureTitle, IconChip } from '@/components/ui/page'
import { useShortcutRows, type ShortcutRow } from '@/lib/useShortcutRows'

/**
 * 按 `?` 随处叫出的快捷键速查卡：就地弹出，手不离键盘，Esc 返回，比去帮助页查成本低得多。
 * `?` 是同类软件的通用约定且需按 Shift，不易误触。
 * 光标在输入框/文本域/contenteditable 时不响应，否则写带问号的句子会不停弹窗。
 */
/** 让别处（命令面板）叫出速查卡的事件名。定义在这里而不是各写各的字符串——
 *  拼错一个字母的表现是"点了没反应"，而且不会有任何报错。 */
export const CHEAT_SHEET_EVENT = 'tessera:open-cheat-sheet'

export function ShortcutCheatSheet() {
  const { t } = useTranslation('help')
  const [open, setOpen] = useState(false)
  // 只在真正打开后才取键位：本组件挂在 App 最外层（含登录页），挂载即取会在每次冷启动
  // 请求一个必然失败的接口（见 useShortcutRows 的 enabled 参数）。
  const groups = useShortcutRows(open)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '?') return
      // 已经有别的修饰键时不接管：Ctrl+? / Alt+? 可能是别处的组合键。
      if (e.ctrlKey || e.altKey || e.metaKey) return
      const el = document.activeElement as HTMLElement | null
      if (el) {
        const tag = el.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable) return
        // CodeMirror 的编辑区不是 textarea，靠 role 认出来。
        if (el.closest('[role="textbox"], .cm-editor')) return
      }
      e.preventDefault()
      setOpen((v) => !v)
    }
    // 除 ? 键外再接一个自定义事件，供命令面板（Ctrl+K）叫出本卡。用事件而不提升状态：
    // 本卡在 App 最外层，命令面板在 AppShell 内，隔着 lazy/Suspense，打通链路代价大于收益。
    const onOpen = () => setOpen(true)
    window.addEventListener('keydown', onKey)
    window.addEventListener(CHEAT_SHEET_EVENT, onOpen)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener(CHEAT_SHEET_EVENT, onOpen)
    }
  }, [])

  return (
    // 自带 TooltipProvider：DialogContent 的关闭按钮用 Radix Tooltip，缺 provider 会抛错整块渲染失败。
    // AppShell 里的 provider 解锁后才挂载，而本卡在登录页/向导上按 ? 也会弹。
    // 该 bug 只有真渲染的行为测试能发现。
    <TooltipProvider delayDuration={200}>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[85vh] max-w-[900px] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2.5">
            <IconChip icon={Keyboard} size="sm" />
            {t('cheatSheetTitle')}
          </DialogTitle>
        </DialogHeader>

        {/* 三栏并排而不是一列到底：速查卡的价值在于**一眼扫完**，
            需要滚动的速查卡跟去帮助页翻是一回事。窄窗口下自然收成一列。 */}
        <div className="grid gap-7 md:grid-cols-3">
          <Group title={t('shortcutsCustomizable')} rows={groups.customizable} />
          <Group title={t('shortcutsPanes')} rows={groups.panes} />
          <Group title={t('shortcutsFixed')} rows={groups.fixed} />
        </div>
      </DialogContent>
    </Dialog>
    </TooltipProvider>
  )
}

function Group({ title, rows }: { title: string; rows: ShortcutRow[] }) {
  return (
    <div className="min-w-0">
      <FeatureTitle as="h3" className="mb-2.5">
        {title}
      </FeatureTitle>
      <dl className="flex flex-col">
        {rows.map((row) => (
          <div
            key={row.label}
            className="flex items-baseline justify-between gap-4 border-b border-border/60 py-1.5 last:border-b-0"
          >
            <dt className="min-w-0 text-sm text-muted-foreground">{row.label}</dt>
            {/* 键位用等宽数字：Ctrl + 1 / Ctrl + 11 这类混在一列时，
                比例宽度的数字会让整列的加号左右错开，读起来是乱的。 */}
            <dd className="tabular shrink-0 text-sm">{row.keys}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}
