import { describe, expect, it } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { tk } from '../setup/i18n'
import { TooltipProvider } from '@/components/ui/tooltip'
import { usePassphrasePrompt } from '@/lib/usePassphrasePrompt'
import { VerifyResultsDialog, type VerifyRow } from '@/components/files/VerifyResultsDialog'

let ask: ReturnType<typeof usePassphrasePrompt>['ask']

function Host() {
  const prompt = usePassphrasePrompt()
  ask = prompt.ask
  return <TooltipProvider>{prompt.element}</TooltipProvider>
}

describe('usePassphrasePrompt', () => {
  it('setting a passphrase needs the minimum length and a matching second entry', async () => {
    const user = userEvent.setup()
    render(<Host />)
    let result: Promise<string | null> = Promise.resolve(null)
    act(() => {
      result = ask('set', 3)
    })
    const ok = await screen.findByRole('button', { name: tk('files:sharePassConfirmButton') })
    const [first, second] = [
      screen.getByLabelText(tk('files:sharePassLabel')),
      screen.getByLabelText(tk('files:sharePassConfirmLabel')),
    ]

    await user.type(first, 'short')
    expect(ok).toBeDisabled()
    expect(screen.getByRole('alert').textContent).toBe(tk('files:sharePassTooShort', { min: 8 }))

    await user.clear(first)
    await user.type(first, 'long enough phrase')
    await user.type(second, 'long enough phrasE')
    expect(ok).toBeDisabled()
    expect(screen.getByRole('alert').textContent).toBe(tk('files:sharePassMismatch'))

    await user.clear(second)
    await user.type(second, 'long enough phrase')
    expect(ok).toBeEnabled()
    await user.click(ok)
    await expect(result).resolves.toBe('long enough phrase')
  })

  it('the generator fills both fields with a strong random passphrase', async () => {
    const user = userEvent.setup()
    render(<Host />)
    let result: Promise<string | null> = Promise.resolve(null)
    act(() => {
      result = ask('set', 1)
    })
    await user.click(await screen.findByRole('button', { name: tk('files:sharePassGenerate') }))
    const first = screen.getByLabelText(tk('files:sharePassLabel')) as HTMLInputElement
    const second = screen.getByLabelText(tk('files:sharePassConfirmLabel')) as HTMLInputElement
    expect(first.value).toHaveLength(24)
    expect(second.value).toBe(first.value)
    expect(screen.getByText(new RegExp(tk('files:sharePassStrength_strong')))).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: tk('files:sharePassConfirmButton') }))
    await expect(result).resolves.toBe(first.value)
  })

  it('entering shows the previous error and cancel resolves null', async () => {
    const user = userEvent.setup()
    render(<Host />)
    let result: Promise<string | null> = Promise.resolve('x')
    act(() => {
      result = ask('enter', 2, '口令不对')
    })
    expect(await screen.findByRole('alert')).toHaveTextContent('口令不对')
    expect(screen.queryByLabelText(tk('files:sharePassConfirmLabel'))).toBeNull()
    await user.click(screen.getByRole('button', { name: tk('files:sharePassCancelButton') }))
    await expect(result).resolves.toBeNull()
  })
})

describe('usePassphrasePrompt overlap', () => {
  it('a second question cancels the first instead of leaving it hanging', async () => {
    render(<Host />)
    let first: Promise<string | null> = Promise.resolve('x')
    act(() => {
      first = ask('enter', 1)
    })
    act(() => {
      void ask('enter', 2)
    })
    await expect(first).resolves.toBeNull()
    expect(await screen.findByText(tk('files:sharePassEnterTitle', { count: 2 }))).toBeInTheDocument()
  })
})

describe('VerifyResultsDialog', () => {
  const base = {
    ok: true as const,
    input_path: 'a.ivault',
    failed_chunk: null,
    chunks_checked: 3,
    chunks_expected: 3,
    bytes_checked: 3_000_000,
    plaintext_size: 3_000_000,
    container_size: 3_001_000,
    kind: 'file' as const,
    original_filename: 'report.pdf',
    sha256_plaintext: 'ab',
    cipher: 'aes-256-gcm',
    wrap: 'passphrase' as const,
    format_version: 2,
    elapsed_s: 0.5,
  }

  it('names the tampered chunk counting from one and totals the intact ones', () => {
    const rows: VerifyRow[] = [
      { path: 'a.ivault', name: 'a.ivault', result: { ...base, intact: true, failure: null } },
      {
        path: 'b.ivault',
        name: 'b.ivault',
        result: { ...base, original_filename: 'b.bin', intact: false, failure: 'chunk', failed_chunk: 1 },
      },
      { path: 'c.ivault', name: 'c.ivault', error: '不是容器' },
    ]
    render(
      <TooltipProvider>
        <VerifyResultsDialog rows={rows} onClose={() => {}} />
      </TooltipProvider>,
    )
    expect(screen.getByText(tk('files:verifyDialogTitle', { ok: 1, total: 3 }))).toBeInTheDocument()
    expect(screen.getByText(tk('files:verifyFailure_chunk', { chunk: 2 }))).toBeInTheDocument()
    expect(screen.getByText('不是容器')).toBeInTheDocument()
    expect(screen.getAllByText(tk('files:verifyWrap_passphrase')).length).toBe(2)
  })
})
