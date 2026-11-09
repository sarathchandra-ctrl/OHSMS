// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const { markReceivedFromVendor, toast } = vi.hoisted(() => ({
  markReceivedFromVendor: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}))

vi.mock('../lib/firestore', () => ({
  markReceivedFromVendor,
  markRefilledAndClosed: vi.fn(),
}))
vi.mock('react-hot-toast', () => ({ default: toast }))
vi.mock('../../../shared/lib/toastCaught', () => ({ toastCaught: vi.fn() }))
vi.mock('../context/FleetContext', () => ({
  useFleet: () => ({
    loading: false,
    inProcess: [
      {
        id: 'e1',
        serialNo: 'FE-9',
        type: 'ABC',
        capacity: '6 Kg',
        status: 'in_process_refilling',
        qrToken: 'tok',
      },
    ],
  }),
}))
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ orgName: 'Depot Org', profile: { name: 'Ada' } }),
}))

const { default: InProcess } = await import('./InProcess')

beforeEach(() => {
  markReceivedFromVendor.mockReset()
  markReceivedFromVendor.mockResolvedValue()
  toast.success.mockClear()
  toast.error.mockClear()
})

describe('In Process — received back from the vendor', () => {
  it('records the received date and the next refill date', async () => {
    render(<InProcess />)
    fireEvent.click(screen.getByRole('button', { name: 'Received' }))
    fireEvent.change(screen.getByLabelText('Received on'), { target: { value: '2026-10-15' } })
    fireEvent.change(screen.getByLabelText('Next refill date'), { target: { value: '2027-10-15' } })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm received' }))
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    expect(markReceivedFromVendor).toHaveBeenCalledWith('Depot Org',
      'e1',
      { receivedOn: '2026-10-15', dateOfNextRefill: '2027-10-15' },
      'Ada'
    )
  })

  it('does not close a refill on a due date that is today or earlier', async () => {
    const { markRefilledAndClosed } = await import('../lib/firestore')
    render(<InProcess />)
    fireEvent.click(screen.getByRole('button', { name: 'Refilled & closed' }))
    fireEvent.change(screen.getByLabelText('New Next Refill date'), {
      target: { value: '2020-01-01' },
    })
    fireEvent.change(screen.getByLabelText('New Next HPT date'), {
      target: { value: '2031-01-01' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm & close' }))
    expect(toast.error).toHaveBeenCalled()
    expect(markRefilledAndClosed).not.toHaveBeenCalled()
  })

  it('does not record a new hydrostatic date without its certificate', async () => {
    const { markRefilledAndClosed } = await import('../lib/firestore')
    render(<InProcess />)
    fireEvent.click(screen.getByRole('button', { name: 'Refilled & closed' }))
    fireEvent.change(screen.getByLabelText('New Next Refill date'), {
      target: { value: '2027-01-01' },
    })
    fireEvent.change(screen.getByLabelText('New Next HPT date'), {
      target: { value: '2031-01-01' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm & close' }))
    expect(toast.error).toHaveBeenCalled()
    expect(markRefilledAndClosed).not.toHaveBeenCalled()
  })
})
