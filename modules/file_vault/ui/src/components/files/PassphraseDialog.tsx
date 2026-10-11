import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Eye, EyeOff, KeyRound, Wand2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { InfoHint } from '@/components/ui/info-hint'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import { hasSequentialRun, passwordEntropyBits } from '@/lib/passwordMetrics'
import { DEFAULT_GENERATOR_OPTIONS, generatePassword } from '@/lib/passwordGenerator'
import { SHARE_PASSPHRASE_MIN } from '@/lib/shareSession'

export type PassphraseMode = 'set' | 'enter'

export interface PassphraseRequest {
  id: number
  mode: PassphraseMode
  count: number
  error?: string
  resolve: (value: string | null) => void
}

type Level = 'weak' | 'fair' | 'good' | 'strong'
const LEVELS: Level[] = ['weak', 'fair', 'good', 'strong']
const LEVEL_BAR: Record<Level, string> = {
  weak: 'bg-destructive',
  fair: 'bg-warning',
  good: 'bg-info',
  strong: 'bg-success',
}

function strengthOf(value: string): { level: Level; bits: number } {
  const bits = passwordEntropyBits(value) ?? 0
  let level: Level = bits < 40 ? 'weak' : bits < 60 ? 'fair' : bits < 80 ? 'good' : 'strong'
  // 顺序键盘串的熵是假的（见 hasSequentialRun），最多算"一般"。
  if (hasSequentialRun(value) && level !== 'weak') level = 'fair'
  return { level, bits: Math.round(bits) }
}

/** 受控的口令对话框；Promise 式的调用见 lib/usePassphrasePrompt。 */
export function PassphraseDialog({
  request,
  onDone,
}: {
  request: PassphraseRequest | null
  onDone: (value: string | null) => void
}) {
  return (
    <Dialog open={request !== null} onOpenChange={(open) => !open && onDone(null)}>
      <DialogContent className="sm:max-w-md">
        {request && <PassphraseForm key={request.id} request={request} onDone={onDone} />}
      </DialogContent>
    </Dialog>
  )
}

function PassphraseForm({ request, onDone }: { request: PassphraseRequest; onDone: (value: string | null) => void }) {
  const { t } = useTranslation('files')
  const [value, setValue] = useState('')
  const [confirm, setConfirm] = useState('')
  const [visible, setVisible] = useState(false)
  const [touched, setTouched] = useState(false)
  const setting = request.mode === 'set'

  const tooShort = setting && value.length < SHARE_PASSPHRASE_MIN
  const mismatch = setting && confirm !== value
  const problem = !value
    ? null
    : tooShort
      ? t('sharePassTooShort', { min: SHARE_PASSPHRASE_MIN })
      : mismatch && (touched || confirm.length >= value.length)
        ? t('sharePassMismatch')
        : null
  const canSubmit = setting ? !tooShort && !mismatch : value.length > 0
  const strength = setting && value ? strengthOf(value) : null

  function submit(event: FormEvent) {
    event.preventDefault()
    setTouched(true)
    if (canSubmit) onDone(value)
  }

  function generate() {
    const generated = generatePassword({ ...DEFAULT_GENERATOR_OPTIONS, length: 24 })
    setValue(generated)
    setConfirm(generated)
    setVisible(true)
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <KeyRound className="size-5 text-primary" aria-hidden="true" />
          {setting ? t('sharePassSetTitle') : t('sharePassEnterTitle', { count: request.count })}
          {setting && <InfoHint text={t('sharePassSetHint')} />}
        </DialogTitle>
      </DialogHeader>

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor="share-passphrase" className="text-sm font-normal">
            {t('sharePassLabel')}
          </Label>
          {setting && (
            <Button type="button" variant="ghost" size="sm" onClick={generate}>
              <Wand2 className="size-4" aria-hidden="true" />
              {t('sharePassGenerate')}
            </Button>
          )}
        </div>
        <div className="relative">
          <Input
            id="share-passphrase"
            type={visible ? 'text' : 'password'}
            autoFocus
            autoComplete="off"
            spellCheck={false}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            aria-invalid={Boolean(request.error) || undefined}
            className="pr-11 font-mono"
          />
          <button
            type="button"
            onClick={() => setVisible((v) => !v)}
            aria-label={visible ? t('sharePassHide') : t('sharePassShow')}
            className="absolute inset-y-0 right-0 flex w-11 items-center justify-center text-muted-foreground hover:text-foreground"
          >
            {visible ? <EyeOff className="size-4" aria-hidden="true" /> : <Eye className="size-4" aria-hidden="true" />}
          </button>
        </div>
        {strength && (
          <div className="flex items-center gap-3" aria-live="polite">
            <div className="flex flex-1 gap-1">
              {LEVELS.map((level, index) => (
                <span
                  key={level}
                  className={cn(
                    'h-1.5 flex-1 rounded-full transition-colors duration-300',
                    index <= LEVELS.indexOf(strength.level) ? LEVEL_BAR[strength.level] : 'bg-muted',
                  )}
                />
              ))}
            </div>
            <span className="shrink-0 text-2xs tabular text-muted-foreground">
              {t(`sharePassStrength_${strength.level}`)} · {strength.bits} bit
            </span>
          </div>
        )}
      </div>

      {setting && (
        <div className="space-y-2">
          <Label htmlFor="share-passphrase-confirm" className="text-sm font-normal">
            {t('sharePassConfirmLabel')}
          </Label>
          <Input
            id="share-passphrase-confirm"
            type={visible ? 'text' : 'password'}
            autoComplete="off"
            spellCheck={false}
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            onBlur={() => setTouched(true)}
            className="font-mono"
          />
        </div>
      )}

      {(request.error || problem) && (
        <p role="alert" className="text-sm text-destructive">
          {request.error ?? problem}
        </p>
      )}

      <div className="flex gap-2 pt-1">
        <Button type="submit" className="flex-1" disabled={!canSubmit}>
          {t('sharePassConfirmButton')}
        </Button>
        <Button type="button" variant="outline" className="flex-1" onClick={() => onDone(null)}>
          {t('sharePassCancelButton')}
        </Button>
      </div>
    </form>
  )
}
