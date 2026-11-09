// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, act, within } from '@testing-library/react'

const backfillProcedureMirrors = vi.fn()

vi.mock('../../shared/crypto/keyring', () => ({ sealingEnabled: false }))
// The procedure-mirror job runs in the browser and reaches the LOTO service
// directly; it is mocked here and the page is rendered without a provider.
vi.mock('../../shared/auth/AuthContext', () => ({ useAuth: () => ({}) }))
vi.mock('../../modules/loto/services/procedures', () => ({
  backfillProcedureMirrors: (...a) => backfillProcedureMirrors(...a),
}))
vi.mock('../../shared/monitoring', () => ({ reportError: vi.fn() }))
vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}))

const { default: Maintenance } = await import('./Maintenance')

beforeEach(() => {
  vi.clearAllMocks()
  backfillProcedureMirrors.mockResolvedValue({ total: 3, present: 1, missing: 2, ids: ['p1', 'p2'], written: 0 })
})

describe('Maintenance', () => {
  it('offers only jobs that run in this browser', () => {
    render(<Maintenance />)
    expect(screen.queryByRole('heading', { name: /sign-in token/ })).toBeNull()
    expect(screen.queryByRole('heading', { name: /Stamp document visibility/ })).toBeNull()
  })
})

// The LOTO procedure QR opens a public read-only page, which only exists for
// procedures that have a published mirror. Procedures written before that
// feature have none until something changes them, so this job publishes the
// rest — and like its neighbours it must not write until someone has looked.
describe('publishing procedure QR pages', () => {
  const job = () => within(screen.getByRole('region', { name: /Publish procedure QR pages/ }))

  it('will not publish until you have checked', () => {
    render(<Maintenance />)
    expect(job().getByRole('button', { name: /Publish them/ }).disabled).toBe(true)
  })

  it('reports how many printed codes lead nowhere, without writing', async () => {
    render(<Maintenance />)
    await act(async () => fireEvent.click(job().getByRole('button', { name: /Check first/ })))

    await waitFor(() =>
      expect(backfillProcedureMirrors).toHaveBeenCalledWith({ dryRun: true }))
    expect(screen.getByText(/2 whose printed code leads nowhere/)).toBeTruthy()
    expect(job().getByRole('button', { name: /Publish them/ }).disabled).toBe(false)
  })

  it('writes only on the second, explicit click', async () => {
    render(<Maintenance />)
    await act(async () => fireEvent.click(job().getByRole('button', { name: /Check first/ })))
    backfillProcedureMirrors.mockResolvedValue({ total: 3, present: 3, missing: 0, ids: [], written: 3 })
    await act(async () => fireEvent.click(job().getByRole('button', { name: /Publish them/ })))

    expect(backfillProcedureMirrors).toHaveBeenCalledWith({ dryRun: false })
    await waitFor(() => expect(job().getByRole('button', { name: /Published/ })).toBeTruthy())
  })

  it('stays disabled when every procedure is already published', async () => {
    backfillProcedureMirrors.mockResolvedValue({ total: 3, present: 3, missing: 0, ids: [], written: 0 })
    render(<Maintenance />)
    await act(async () => fireEvent.click(job().getByRole('button', { name: /Check first/ })))
    await waitFor(() => expect(job().getByRole('button', { name: /Publish them/ }).disabled).toBe(true))
  })
})

// Equipment imported before sites were records carries a centre name and no
// site link. Matching the two up is the easy part; the part worth a test is
// what happens when the match is not certain, because filing an extinguisher
// at a site it is not at is the exact failure this job exists to fix.
