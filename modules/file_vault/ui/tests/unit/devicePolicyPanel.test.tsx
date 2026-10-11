import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { tk } from '../setup/i18n'
import { TooltipProvider } from '@/components/ui/tooltip'

const call = vi.fn()
vi.mock('@/lib/crossDeviceApi', () => ({ crossDeviceApi: { call: (...args: unknown[]) => call(...args) } }))

const { DevicePolicyPanel } = await import('@/components/crossdevice/DevicePolicyPanel')

describe('DevicePolicyPanel', () => {
  it('sends only the changed policy and hands the updated device back', async () => {
    const user = userEvent.setup()
    const device = { device_id: 'phone', clip_policy: 'all' as const, file_policy: 'inherit' as const }
    call.mockResolvedValueOnce({ ...device, clip_policy: 'text' })
    const onUpdated = vi.fn()
    render(
      <TooltipProvider>
        <DevicePolicyPanel device={device} onUpdated={onUpdated} />
      </TooltipProvider>,
    )

    const all = screen.getByRole('radio', { name: tk('crossdevice:policyClip.all') })
    expect(all).toHaveAttribute('aria-checked', 'true')
    await user.click(all)
    expect(call).not.toHaveBeenCalled()

    await user.click(screen.getByRole('radio', { name: tk('crossdevice:policyClip.text') }))
    expect(call).toHaveBeenCalledWith('set_device_policy', { device_id: 'phone', clip_policy: 'text' })
    await waitFor(() => expect(onUpdated).toHaveBeenCalledWith(expect.objectContaining({ clip_policy: 'text' })))
  })

  it('treats a device without policy fields as the defaults', () => {
    render(
      <TooltipProvider>
        <DevicePolicyPanel device={{ device_id: 'old' }} onUpdated={() => {}} />
      </TooltipProvider>,
    )
    expect(screen.getByRole('radio', { name: tk('crossdevice:policyClip.all') })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: tk('crossdevice:policyFile.inherit') })).toHaveAttribute('aria-checked', 'true')
  })
})
