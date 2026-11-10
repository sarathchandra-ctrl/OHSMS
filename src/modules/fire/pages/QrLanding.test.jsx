// @vitest-environment jsdom
//
// The scan page is the thing a printed sticker opens. A deleted unit used to
// look like a code this app had never minted ("Code not recognised"), because
// the public mirror was removed in the same write. These assert the two
// sentences stay distinct, and that restore is offered only to someone whose
// grant reaches the asset — the mirror itself does not carry siteId.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'

const auth = {
  value: { orgName: '', profile: null, isAdmin: false, isManager: false },
}
const docs = { value: {} }

vi.mock('../../../shared/data/client.js', () => ({
  doc: (_db, ...parts) => ({ path: parts.join('/') }),
  getDoc: (ref) => {
    const data = docs.value[ref.path]
    if (!data) {
      return Promise.resolve({
        exists: () => false,
        id: ref.path.split('/').pop(),
        data: () => ({}),
      })
    }
    return Promise.resolve({
      exists: () => true,
      id: data.id || ref.path.split('/').pop(),
      data: () => data,
    })
  },
}))
vi.mock('../../../shared/db', () => ({ db: {} }))
vi.mock('../context/AuthContext', () => ({ useAuth: () => auth.value }))
vi.mock('../lib/data', () => ({
  restoreExtinguisher: vi.fn(() => Promise.resolve()),
  restoreAed: vi.fn(() => Promise.resolve()),
  restoreFas: vi.fn(() => Promise.resolve()),
}))
vi.mock('../components/ReportDefectModal', () => ({ default: () => null }))
vi.mock('../components/ReportAssetDefectModal', () => ({ default: () => null }))
vi.mock('react-router-dom', () => ({ useParams: () => ({ token: 'tok-1' }) }))
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }))

const { default: QrLanding } = await import('./QrLanding')
const { restoreExtinguisher } = await import('../lib/data')

const deletedMirror = {
  orgName: 'Acme',
  extId: 'e1',
  serialNo: 'FE-0007',
  deletedAt: new Date(),
  token: 'tok-1',
}

beforeEach(() => {
  docs.value = {}
  restoreExtinguisher.mockClear()
  auth.value = { orgName: '', profile: null, isAdmin: false, isManager: false }
})

describe('scanning a QR', () => {
  it('says the code is not recognised when nothing is on record', async () => {
    render(<QrLanding />)
    expect(await screen.findByRole('heading', { name: /code not recognised/i })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /report a defect/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /^restore$/i })).toBeNull()
  })

  it('opens a fire-alarm control panel on its own page', async () => {
    docs.value['qr/tok-1'] = {
      assetKind: 'fas',
      orgName: 'Acme',
      assetRefId: 'p1',
      token: 'tok-1',
      label: 'FAS-0007',
      deviceType: 'Control Panel',
      zone: 'Zone 1',
      centerName: 'North Plant',
      location: 'Reception',
      status: 'operational',
      deletedAt: null,
    }
    render(<QrLanding />)
    expect(await screen.findByRole('heading', { name: 'Control Panel' })).toBeTruthy()
    expect(screen.getByText(/Fire alarm system/i)).toBeTruthy()
    expect(screen.getByText(/Device FAS-0007/)).toBeTruthy()
    expect(screen.getByText(/North Plant/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /report a defect/i })).toBeTruthy()
  })

  it('still offers a defect report for a unit that is in service', async () => {
    docs.value['qr/tok-1'] = {
      extId: 'e1',
      serialNo: 'FE-0001',
      type: 'ABC',
      capacity: '5 Kg',
      deletedAt: null,
    }
    render(<QrLanding />)
    expect(await screen.findByRole('button', { name: /report a defect/i })).toBeTruthy()
    expect(screen.queryByText(/was deleted/i)).toBeNull()
  })

  it('says the extinguisher was deleted, and does not open a defect report', async () => {
    docs.value['qr/tok-1'] = deletedMirror
    render(<QrLanding />)
    expect(
      await screen.findByRole('heading', { name: /this fire extinguisher was deleted/i })
    ).toBeTruthy()
    expect(screen.getByText(/FE-0007/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /report a defect/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /^restore$/i })).toBeNull()
  })

  it('offers restore to a manager whose site holds the unit', async () => {
    docs.value['qr/tok-1'] = deletedMirror
    docs.value['extinguishers/e1'] = {
      id: 'e1',
      serialNo: 'FE-0007',
      siteId: 'site-a',
      region: 'South',
      entity: 'COCO',
      deletedAt: new Date(),
      qrToken: 'tok-1',
    }
    auth.value = {
      orgName: 'Acme',
      isAdmin: false,
      isManager: true,
      profile: {
        uid: 'm1',
        name: 'Site lead',
        siteId: 'site-a',
        access: { sites: ['site-a'] },
      },
    }
    render(<QrLanding />)
    const button = await screen.findByRole('button', { name: /^restore$/i })
    fireEvent.click(button)
    await waitFor(() =>
      expect(restoreExtinguisher).toHaveBeenCalledWith('Acme', 'e1', {
        uid: 'm1',
        name: 'Site lead',
      })
    )
  })

  it('does not offer restore to a manager of a different site', async () => {
    docs.value['qr/tok-1'] = deletedMirror
    docs.value['extinguishers/e1'] = {
      id: 'e1',
      siteId: 'site-a',
      region: 'South',
      entity: 'COCO',
      deletedAt: new Date(),
    }
    auth.value = {
      orgName: 'Acme',
      isAdmin: false,
      isManager: true,
      profile: { uid: 'm2', name: 'Other lead', siteId: 'site-z', access: { sites: ['site-z'] } },
    }
    render(<QrLanding />)
    expect(
      await screen.findByRole('heading', { name: /this fire extinguisher was deleted/i })
    ).toBeTruthy()
    // findBy rejects once the asset document has had time to load. A query
    // that returns null immediately would pass before that fetch finished.
    await expect(
      screen.findByRole('button', { name: /^restore$/i }, { timeout: 400 })
    ).rejects.toThrow()
  })
})
