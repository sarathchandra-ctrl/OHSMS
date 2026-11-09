// @vitest-environment jsdom
//
// The bin search is a filter over rows the page already holds. These assert
// the two ways that filter can go wrong on screen: a query that should hide
// a row leaves it in the table, and Restore still sends a row the search has
// hidden. The matcher itself is covered in recycle.test.js.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const fleet = { value: null }

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    orgName: 'Acme',
    profile: { uid: 'u1', name: 'Site lead' },
    isAdmin: true,
    isManager: true,
  }),
}))
vi.mock('../context/FleetContext', () => ({ useFleet: () => fleet.value }))
vi.mock('../lib/firestore', () => ({
  restoreExtinguishers: vi.fn(() => Promise.resolve()),
  purgeExtinguisher: vi.fn(() => Promise.resolve()),
  restoreAeds: vi.fn(() => Promise.resolve()),
  purgeAed: vi.fn(() => Promise.resolve()),
  restoreFasMany: vi.fn(() => Promise.resolve()),
  purgeFas: vi.fn(() => Promise.resolve()),
}))
vi.mock('../lib/exporter', () => ({ downloadJsonBackup: vi.fn() }))
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }))

const { default: RecycleBin } = await import('./RecycleBin')
const { restoreExtinguishers, restoreAeds } = await import('../lib/firestore')

const deletedAt = new Date('2026-09-20T08:00:00Z')

beforeEach(() => {
  restoreExtinguishers.mockClear()
  restoreAeds.mockClear()
  fleet.value = {
    deletedExtinguishers: [
      {
        id: 'e1',
        serialNo: 'FE-0001',
        type: 'ABC',
        capacity: '6 Kg',
        centerName: 'Alpha',
        qrToken: 'tok-1',
        deletedAt: new Date('2026-09-18T08:00:00Z'),
        deletedBy: 'Site lead',
      },
      {
        id: 'e2',
        serialNo: 'FE-0002',
        type: 'CO2',
        capacity: '2 Kg',
        centerName: 'Beta',
        qrToken: 'tok-2',
        deletedAt,
        deletedBy: 'Night shift',
      },
    ],
    deletedAeds: [
      {
        id: 'a1',
        assetId: 'AED-9',
        brand: 'Philips',
        model: 'FRx',
        centerName: 'Gamma',
        qrToken: 'tok-a',
        deletedAt: new Date('2026-09-10T08:00:00Z'),
        deletedBy: 'Site lead',
      },
    ],
    deletedFas: [],
    extinguishers: [],
    reports: [],
    users: [],
    org: { name: 'Acme' },
  }
})

const search = () => screen.getByRole('textbox', { name: 'Search recently deleted' })

describe('Recently deleted search', () => {
  it('lists the bin, newest deletion first, with a count and no search when it is empty', () => {
    const { unmount } = render(<RecycleBin />)
    expect(screen.getByText('3 recently deleted')).toBeTruthy()
    const bodyRows = screen.getAllByRole('row').slice(1)
    expect(bodyRows[0].textContent).toMatch(/FE-0002/)
    expect(bodyRows[1].textContent).toMatch(/FE-0001/)
    expect(bodyRows[2].textContent).toMatch(/AED-9/)
    unmount()

    fleet.value = { ...fleet.value, deletedExtinguishers: [], deletedAeds: [] }
    render(<RecycleBin />)
    expect(screen.getByRole('heading', { name: 'Nothing was recently deleted' })).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: 'Search recently deleted' })).toBeNull()
  })

  it('filters as you type, keeps the existing order, and says when nothing matches', () => {
    render(<RecycleBin />)
    fireEvent.change(search(), { target: { value: 'fe-000' } })
    expect(screen.getByText('2 of 3 match')).toBeTruthy()
    expect(screen.queryByText('AED-9')).toBeNull()
    const bodyRows = screen.getAllByRole('row').slice(1)
    expect(bodyRows.map((row) => row.textContent).join(' ')).toMatch(/FE-0002.*FE-0001/)

    fireEvent.change(search(), { target: { value: 'zzzz-nope' } })
    expect(screen.getByRole('heading', { name: 'No deleted units match “zzzz-nope”' })).toBeTruthy()
    expect(screen.queryByRole('table')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }))
    expect(screen.getByText('AED-9')).toBeTruthy()
    expect(screen.getByText('3 recently deleted')).toBeTruthy()
  })

  it('does not restore a unit the search has hidden', async () => {
    render(<RecycleBin />)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Extinguisher FE-0001' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select AED AED-9' }))
    fireEvent.change(search(), { target: { value: 'FE-0002' } })

    expect(
      screen.getByText('2 selected are hidden by this search and will not be restored.')
    ).toBeTruthy()
    const blocked = screen.getByRole('button', { name: 'Restore selected' })
    expect(blocked).toHaveProperty('disabled', true)
    fireEvent.click(blocked)
    expect(restoreExtinguishers).not.toHaveBeenCalled()
    expect(restoreAeds).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Extinguisher FE-0002' }))
    fireEvent.click(screen.getByRole('button', { name: 'Restore 1 shown' }))
    await waitFor(() => expect(restoreExtinguishers).toHaveBeenCalledTimes(1))
    expect(restoreExtinguishers).toHaveBeenCalledWith('org-1', 'Acme', ['e2'], expect.anything())
    expect(restoreAeds).not.toHaveBeenCalled()
    expect(
      screen.getByText('2 selected are hidden by this search and will not be restored.')
    ).toBeTruthy()
  })
})
