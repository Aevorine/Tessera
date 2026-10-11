import {
  useTranslation } from 'react-i18next'
import { BookOpen,
  Keyboard,
} from 'lucide-react'
import { PageHeader, PageSection, PageShell } from '@/components/ui/page'
import { useShortcutRows } from '@/lib/useShortcutRows'

// 应用内"操作指南"：各模块用法 + 全部快捷键。快捷键实时读当前设置（5 条来自后端 ui_settings、2 条来
// 自主进程），切到本面板时重新挂载拉取，无需事件同步。

export function HelpScreen() {
  const { t } = useTranslation('help')
  // 三组快捷键全来自 useShortcutRows()，与按 ? 弹出的速查卡同源；各抄一份必然分家且不报错。
  const { customizable: customizableRows, fixed: fixedRows, panes: paneRows } = useShortcutRows()

  const sections: { title: string; items: string[] }[] = [
    { title: t('sectionMenus'), items: [t('menu1'), t('menu2'), t('menu3'), t('menu4'), t('menu5')] },
    { title: t('sectionFiles'), items: [t('files1'), t('files2'), t('files3'), t('files4'), t('files5')] },
    { title: t('sectionFileManager'), items: [t('fm1'), t('fm2'), t('fm3'), t('fm4')] },
    { title: t('sectionClipboard'), items: [t('clip1'), t('clip2'), t('clip3'), t('clip4'), t('clip5'), t('clip6'), t('clip7')] },
    {
      title: t('sectionCrossDevice'),
      items: [t('cd1'), t('cd2'), t('cd3'), t('cd4'), t('cd5'), t('cd6'), t('cd7'), t('cd8')],
    },
    {
      title: t('sectionAndroid'),
      items: [t('and1'), t('and2'), t('and3'), t('and4'), t('and5'), t('and6'), t('and7'), t('and8')],
    },
    { title: t('sectionNotes'), items: [t('notes1'), t('notes2'), t('notes3'), t('notes4'), t('notes5'), t('notes6')] },
    { title: t('sectionPasswords'), items: [t('pw1'), t('pw2'), t('pw3'), t('pw4')] },
    // 恢复码和电脑清理两章：侧边栏有而指南里缺整个模块，会让用户以为不值得写或自己漏看。
    { title: t('sectionRecoveryCodes'), items: [t('rc1'), t('rc2'), t('rc3'), t('rc4')] },
    {
      title: t('sectionPcClean'),
      items: [t('clean1'), t('clean2'), t('clean3'), t('clean4'), t('clean5'), t('clean6'), t('clean7')],
    },
    { title: t('sectionAi'), items: [t('ai1'), t('ai2'), t('ai3')] },
    { title: t('sectionNetwork'), items: [t('net1'), t('net2'), t('net3')] },
    // 安全体检 / 智能搜索 / 接着刚才合成一章（都是"应用替你留意的事"），分三章只会让目录变长更难找。
    {
      title: t('sectionSecurityCheck'),
      items: [t('sec1'), t('sec2'), t('sec3'), t('sec4'), t('sec5'), t('sec6'), t('sec7'), t('sec8')],
    },
    { title: t('sectionSettings'), items: [t('set1'), t('set2'), t('set3'), t('set4'), t('set5'), t('set6')] },
    // 工作界面不放讲解文字，但"哪些数据会离开这台电脑"必须说明（公开发布的应用，用户有权知道），原文从
    // AI 对话页撤下后完整落在这里。
    { title: t('sectionPrivacy'), items: [t('privacy1'), t('privacy2'), t('privacy3')] },
  ]

  function renderShortcutRows(rows: { label: string; keys: string }[]) {
    return rows.map((row) => (
      <div key={row.label} className="flex items-center justify-between gap-4 py-1">
        <span className="text-sm">{row.label}</span>
        <kbd className="shrink-0 rounded border bg-muted px-2 py-0.5 font-mono text-sm text-muted-foreground">
          {row.keys}
        </kbd>
      </div>
    ))
  }

  return (
    <PageShell width="canvas">
      <PageHeader title={t('pageTitle')} />

      <PageSection icon={Keyboard} title={t('sectionShortcuts')}>
        {/* 三组快捷键并排，而不是竖着堆。
            每一行是「名称 …… 按键」的两端对齐，横跨 1700 像素时名称在最左、
            按键在最右，眼睛要横穿整块屏幕才能把两者对上——那不是"填满"，
            是把一份表格拉断。分成三列之后每一行只有三四百像素宽，一眼扫得完。 */}
        <div className="grid gap-x-10 gap-y-2 lg:grid-cols-3 lg:items-start">
          <div className="space-y-2">
            <p className="text-2xs font-medium tracking-wider text-muted-foreground uppercase">
              {t('shortcutsCustomizable')}
            </p>
            <div className="divide-y divide-border/70">{renderShortcutRows(customizableRows)}</div>
          </div>
          <div className="space-y-2">
            <p className="text-2xs font-medium tracking-wider text-muted-foreground uppercase">
              {t('shortcutsPanes')}
            </p>
            <div className="divide-y divide-border/70">{renderShortcutRows(paneRows)}</div>
          </div>
          <div className="space-y-2">
            <p className="text-2xs font-medium tracking-wider text-muted-foreground uppercase">
              {t('shortcutsFixed')}
            </p>
            <div className="divide-y divide-border/70">{renderShortcutRows(fixedRows)}</div>
          </div>
        </div>
      </PageSection>

      {/* 铺满宽度之后这些章节排成多列。**不能让它们一章一行横跨整屏**：
          正文一行超过约 90 个字符，眼睛从行尾回到下一行行首就会找错行，
          读一页要反复重新定位——这正是"看久了累"的主要来源之一，跟字号无关。
          排成多列之后宽度用满了，每一列的行长还是原来那样。 */}
      <div className="grid gap-6 lg:grid-cols-2 2xl:grid-cols-3 lg:items-start">
        {sections.map((section) => (
          <PageSection key={section.title} icon={BookOpen} title={section.title}>
            <ul className="list-disc space-y-1.5 ps-5 text-sm text-muted-foreground">
              {section.items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </PageSection>
        ))}
      </div>
    </PageShell>
  )
}
