// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { updateSite, assignSiteType, toast } = vi.hoisted(() => ({
  updateSite: vi.fn(),
  assignSiteType: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}))

const auth = vi.hoisted(() => ({
  value: {
    actor: { uid: 'admin-1' },
    role: 'admin',
    org: { activityTypes: ['Cold store'], siteTypeByEntity: {} },
  },
}))

const SITES = [
  {
    id: 'n',
    name: 'North',
    entity: 'COCO',
    region: 'West',
    facility: 'Indoor gym',
    address: '1 Lane',
    code: '201',
  },
  { id: 's', name: 'South', entity: 'EBO', region: 'South', facility: '', address: '', code: '' },
]

vi.mock('react-hot-toast', () => ({ default: toast }))
vi.mock('../../shared/lib/toastCaught', () => ({ toastCaught: vi.fn() }))
vi.mock('../../shared/auth/AuthContext', () => ({ useAuth: () => auth.value }))
vi.mock('../../shared/org/orgData', () => ({
  subscribeSites: (cb) => {
    cb(SITES)
    return () => {}
  },
  subscribeOrgUsers: (cb) => {
    cb([])
    return () => {}
  },
  subscribeCollections: () => () => {},
  emptyCollections: (names = []) => ({
    data: Object.fromEntries(names.map((name) => [name, []])),
    incomplete: null,
    status: {},
  }),
  cleanAttributes: (value) => value || {},
  logAudit: vi.fn(),
  createSite: vi.fn(),
  updateSite,
  deleteSite: vi.fn(),
  deleteSites: vi.fn(),
  bulkUpsertSites: vi.fn(),
  updateOrgSettings: vi.fn(),
  backfillEmptySiteTypes: vi.fn(),
  assignSiteType,
}))

const { default: Sites } = await import('./Sites')

const adminAuth = () => ({
  actor: { uid: 'admin-1' },
  role: 'admin',
  org: { activityTypes: ['Cold store'], siteTypeByEntity: {} },
})

beforeEach(() => {
  auth.value = adminAuth()
  updateSite.mockReset()
  updateSite.mockResolvedValue()
  assignSiteType.mockReset()
  assignSiteType.mockResolvedValue(2)
  toast.success.mockClear()
  toast.error.mockClear()
})

afterEach(cleanup)

describe('Sites site type', () => {
  it('shows a Site type column and saves a type from the edit form', async () => {
    render(<Sites />)
    expect(screen.getByRole('columnheader', { name: 'Site type' })).toBeTruthy()
    expect(screen.getByText('Indoor gym')).toBeTruthy()
    expect(screen.getByText('Not set')).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Site types' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Edit North' }))
    const select = screen.getByLabelText('Site type')
    expect(select.value).toBe('Indoor gym')
    fireEvent.change(select, { target: { value: 'Warehouse' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(updateSite).toHaveBeenCalled())
    expect(updateSite.mock.calls[0][0]).toBe('org-1')
    expect(updateSite.mock.calls[0][1]).toBe('n')
    expect(updateSite.mock.calls[0][2].facility).toBe('Warehouse')
  })

  it('sets one site type on the sites that were selected', async () => {
    render(<Sites />)
    fireEvent.click(screen.getByRole('button', { name: 'Select sites' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select North' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select South' }))
    fireEvent.click(screen.getByRole('button', { name: 'Set site type' }))
    fireEvent.change(screen.getByLabelText('Site type'), { target: { value: 'Warehouse' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply site type' }))
    await waitFor(() => expect(assignSiteType).toHaveBeenCalled())
    expect(assignSiteType).toHaveBeenCalledWith(
      'org-1',
      [
        { id: 'n', name: 'North', facility: 'Warehouse' },
        { id: 's', name: 'South', facility: 'Warehouse' },
      ],
      auth.value.actor
    )
  })

  it('keeps the entity map on the Sites page for an admin', () => {
    render(<Sites />)
    fireEvent.click(screen.getByRole('tab', { name: 'Site types' }))
    expect(screen.getByRole('button', { name: 'Load ownership-model default' })).toBeTruthy()
    expect(screen.getByText(/Apply stores this list on the organisation/)).toBeTruthy()
  })

  it('lets a manager edit site types and keeps the entity map with the admin', () => {
    auth.value = { ...adminAuth(), role: 'manager' }
    render(<Sites />)
    expect(screen.queryByRole('tab', { name: 'Site types' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Select sites' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Edit North' })).toBeTruthy()
    expect(screen.getByRole('columnheader', { name: 'Site type' })).toBeTruthy()
  })

  it('shows the column to a member and does not offer an edit', () => {
    auth.value = { ...adminAuth(), role: 'member' }
    render(<Sites />)
    expect(screen.getByRole('columnheader', { name: 'Site type' })).toBeTruthy()
    expect(screen.getByText('Not set')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Select sites' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Edit North' })).toBeNull()
    expect(screen.queryByRole('tab', { name: 'Site types' })).toBeNull()
  })
})
