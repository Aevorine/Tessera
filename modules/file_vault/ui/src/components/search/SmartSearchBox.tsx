import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { History, ListFilter, Search, X } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

export interface SearchFieldChip {
  key: string
  label: string
  /** 插入框里的前缀（不含冒号），如「网站」。 */
  token: string
}

const RECENT_MAX = 8

// Ctrl+F 与 / 聚焦当前看得见、没被面板盖住的那个搜索框；后挂载的优先。
const boxes: HTMLInputElement[] = []
function onTop(el: HTMLInputElement): boolean {
  const r = el.getBoundingClientRect()
  if (r.width === 0 || r.height === 0) return false
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
  return !!hit && (el === hit || el.parentElement?.contains(hit) === true)
}
function onHotkey(e: globalThis.KeyboardEvent) {
  if (e.defaultPrevented || e.altKey) return
  const t = e.target as HTMLElement | null
  const editing = t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || !!t?.isContentEditable
  const ctrlF = (e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'f'
  const slash = e.key === '/' && !e.ctrlKey && !e.metaKey && !editing
  if (!ctrlF && !slash) return
  if (document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]')) return
  for (let i = boxes.length - 1; i >= 0; i--) {
    if (!onTop(boxes[i])) continue
    e.preventDefault()
    boxes[i].focus()
    boxes[i].select()
    return
  }
}
function register(el: HTMLInputElement) {
  if (boxes.length === 0) window.addEventListener('keydown', onHotkey)
  boxes.push(el)
  return () => {
    const i = boxes.indexOf(el)
    if (i >= 0) boxes.splice(i, 1)
    if (boxes.length === 0) window.removeEventListener('keydown', onHotkey)
  }
}
/**
 * 页内搜索框：字段前缀 / 排除 / 整句 / 拼音都在引擎里；这里管结果数、最近搜索、字段快捷片。
 * 聚焦且框空（或末尾是空格）时弹出最近搜索与字段片。
 */
export const SmartSearchBox = forwardRef<
  HTMLInputElement,
  {
    id?: string
    value: string
    onChange: (value: string) => void
    placeholder: string
    /** 最近搜索按此分开存。 */
    scope: string
    fields?: SearchFieldChip[]
    /** 有查询时的结果数。 */
    count?: number
    approximate?: boolean
    onSubmit?: () => void
    onArrowDown?: () => void
    onArrowUp?: () => void
    className?: string
  }
>(function SmartSearchBox(
  { id, value, onChange, placeholder, scope, fields = [], count, approximate, onSubmit, onArrowDown, onArrowUp, className },
  ref,
) {
  const { t } = useTranslation('common')
  const inputRef = useRef<HTMLInputElement>(null)
  useImperativeHandle(ref, () => inputRef.current as HTMLInputElement)
  const [focused, setFocused] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const [recent, setRecent] = useState<string[]>([])

  useEffect(() => (inputRef.current ? register(inputRef.current) : undefined), [])
  useEffect(() => setRecent([]), [scope])
  useEffect(() => setDismissed(false), [value])

  const commit = useCallback(
    (q: string) => {
      const v = q.trim()
      if (v.length < 2) return
      setRecent((prev) => {
        const next = [v, ...prev.filter((r) => r !== v)].slice(0, RECENT_MAX)
        return next
      })
    },
    [],
  )

  const remove = (r: string) =>
    setRecent((prev) => {
      const next = prev.filter((x) => x !== r)
      return next
    })

  const insertField = (token: string) => {
    const base = value && !value.endsWith(' ') ? `${value} ` : value
    onChange(`${base}${token}:`)
    inputRef.current?.focus()
  }

  const idle = !value.trim() || value.endsWith(' ')
  const open = focused && !dismissed && idle && (recent.length > 0 || fields.length > 0)
  const active = !!value.trim()

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      commit(value)
      onSubmit?.()
    } else if (e.key === 'Escape') {
      e.stopPropagation()
      if (open) setDismissed(true)
      else if (value) onChange('')
      else inputRef.current?.blur()
    } else if (e.key === 'ArrowDown' && onArrowDown) {
      e.preventDefault()
      setDismissed(true)
      onArrowDown()
    } else if (e.key === 'ArrowUp' && onArrowUp) {
      e.preventDefault()
      onArrowUp()
    }
  }

  return (
    <div className={cn('relative min-w-0 w-full sm:w-72', className)}>
      <label className="flex h-9 w-full items-center gap-2 rounded-lg border border-border/70 bg-background px-2.5 transition-colors focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30">
        <span className="shrink-0 text-muted-foreground" data-hint={t('searchHotkey')}>
          <Search className="size-4" aria-hidden="true" />
        </span>
        <input
          ref={inputRef}
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false)
            if (count !== 0) commit(value)
          }}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          aria-label={placeholder}
          aria-keyshortcuts="Control+F /"
          autoComplete="off"
          spellCheck={false}
          className="w-full min-w-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
        {active && count !== undefined && (
          <span
            className={cn(
              'tabular shrink-0 rounded-md px-1.5 text-sm leading-6',
              count === 0 ? 'text-destructive' : approximate ? 'bg-warning/10 text-warning' : 'bg-muted text-muted-foreground',
            )}
            data-hint={approximate ? t('searchApproximate') : t('searchResultCount', { count })}
          >
            {approximate ? `≈${count}` : count}
          </span>
        )}
        {value && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => {
                  onChange('')
                  inputRef.current?.focus()
                }}
                className="text-muted-foreground hover:text-foreground"
                aria-label={t('topbarClearSearch')}
              >
                <X className="size-3.5" aria-hidden="true" />
              </button>
            </TooltipTrigger>
            <TooltipContent>{t('topbarClearSearch')}</TooltipContent>
          </Tooltip>
        )}
      </label>

      {open && (
        <div
          className="absolute top-full left-0 z-50 mt-1.5 w-full min-w-0 space-y-2 rounded-xl border border-border/70 bg-popover p-2.5 shadow-lg"
          onMouseDown={(e) => e.preventDefault()}
        >
          {recent.length > 0 && (
            <div className="flex items-start gap-2">
              <span className="mt-1 shrink-0 text-muted-foreground" data-hint={t('searchRecent')}>
                <History className="size-4" aria-hidden="true" />
              </span>
              <div className="flex min-w-0 flex-wrap gap-1.5">
                {recent.map((r) => (
                  <span key={r} className="group inline-flex max-w-full items-center rounded-md border border-border/70 bg-card">
                    <button
                      type="button"
                      onClick={() => onChange(r)}
                      className="max-w-[14rem] truncate px-2 py-0.5 text-sm hover:text-primary"
                    >
                      {r}
                    </button>
                    <button
                      type="button"
                      onClick={() => remove(r)}
                      aria-label={t('searchRemoveRecent')}
                      className="pr-1.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-destructive focus-visible:opacity-100"
                    >
                      <X className="size-3" aria-hidden="true" />
                    </button>
                  </span>
                ))}
              </div>
            </div>
          )}
          {fields.length > 0 && (
            <div className="flex items-start gap-2">
              <span className="mt-1 shrink-0 text-muted-foreground" data-hint={t('searchFieldChips')}>
                <ListFilter className="size-4" aria-hidden="true" />
              </span>
              <div className="flex min-w-0 flex-wrap gap-1.5">
                {fields.map((f) => (
                  <button
                    key={f.key}
                    type="button"
                    onClick={() => insertField(f.token)}
                    className="rounded-md bg-muted px-2 py-0.5 text-sm text-muted-foreground transition-colors hover:bg-accent-soft hover:text-foreground"
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
})
