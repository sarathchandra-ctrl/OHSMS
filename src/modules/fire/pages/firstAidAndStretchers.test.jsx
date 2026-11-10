// @vitest-environment jsdom
//
// Render tests for the two registers added to the Equipment module and their
// dashboards. They exist because the arithmetic these pages show is tested one
// layer down, in firstAidLogic and assetLogic, and passing there proves nothing
// about whether the page asks the right question of it: a matrix that renders
// its columns from one list and scores them from another, or a dashboard that
// reads `s.compliance` where the summary returns `s.readiness`, is green in the
// logic tests and blank on screen.
//
// So these assert the NUMBERS ON THE PAGE, against fixtures whose answers are
// worked out by hand below.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { FIRST_AID_ITEM_NAMES, FIRST_AID_ITEM_BY_NAME, STRETCHER_STATUS } from '../lib/constants'

const fleet = { value: null }

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ orgName: 'Acme', profile: { uid: 'u1', name: 'Ravi' }, isAdmin: true, isManager: true }),
}))
vi.mock('../context/FleetContext', () => ({ useFleet: () => fleet.value }))
// Named one by one rather than through a catch-all Proxy: a Proxy whose get
// trap answers every key also answers `then`, which makes the mocked module
// look like a thenable, and `await import()` of the page under test never
// settles. The run hangs with no output rather than failing.
vi.mock('../lib/data', () => ({
  addFirstAid: vi.fn(), updateFirstAid: vi.fn(), deleteFirstAid: vi.fn(),
  saveFirstAidBox: vi.fn(), linkFirstAidToSites: vi.fn(),
  addStretcher: vi.fn(), updateStretcher: vi.fn(), deleteStretcher: vi.fn(),
  serviceStretcher: vi.fn(), generateStretcherQr: vi.fn(), bulkDeleteStretchers: vi.fn(),
  linkStretchersToSites: vi.fn(), decideAssetReport: vi.fn(),
}))
vi.mock('../lib/exporter', () => ({ exportFirstAid: vi.fn(), exportRows: vi.fn() }))
vi.mock('react-router-dom', () => ({ Link: ({ children }) => <span>{children}</span> }))
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }))
vi.mock('../../../shared/org/SiteScopePicker', () => ({ default: () => null }))
vi.mock('qrcode.react', () => ({ QRCodeSVG: () => null }))

const { default: FirstAid } = await import('./FirstAid')
const { default: FirstAidDashboard } = await import('./FirstAidDashboard')
const { default: Stretchers } = await import('./Stretchers')
const { default: StretcherDashboard } = await import('./StretcherDashboard')

const BANDAGES = FIRST_AID_ITEM_NAMES[0]
const SCISSORS = 'Scissors'

const future = new Date(Date.now() + 400 * 86400000).toISOString().slice(0, 10)
const past = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10)

/**
 * Alpha holds a full count of bandages and scissors and one expired burn
 * dressing; Beta has never been checked at all.
 *
 * So of the 2 sites × 16 items = 32 cells: 2 are stocked, 1 is expired-only
 * (none usable), and the remaining 29 have never been recorded.
 */
const firstAid = [
  { id: 'f1', centerName: 'Alpha', item: BANDAGES, quantity: FIRST_AID_ITEM_BY_NAME[BANDAGES].minQty, condition: 'Available', boxLocation: 'Reception' },
  { id: 'f2', centerName: 'Alpha', item: SCISSORS, quantity: 1, condition: 'Available', boxLocation: 'Reception' },
  { id: 'f3', centerName: 'Alpha', item: 'Burn Dressing', quantity: 4, condition: 'Available', expiryDate: past, boxLocation: 'Reception' },
]

const stretchers = [
  { id: 's1', assetId: 'STR-0001', type: 'Foldable', centerName: 'Alpha', region: 'North', status: STRETCHER_STATUS.READY, nextInspection: future },
  { id: 's2', assetId: 'STR-0002', type: 'Scoop', centerName: 'Alpha', region: 'North', status: STRETCHER_STATUS.OUT_OF_SERVICE, nextInspection: future },
]

beforeEach(() => {
  fleet.value = {
    loading: false,
    incomplete: null,
    sites: ['Alpha', 'Beta'],
    siteInventory: [{ id: 'site-a', name: 'Alpha', region: 'North', entity: 'COCO' }],
    extinguishers: [], signages: [], aeds: [], fas: [], mockDrills: [],
    firstAid, stretchers,
    pendingReports: [],
  }
})

describe('First Aid register', () => {
  it('draws a column for every item on the contents list', () => {
    render(<FirstAid />)
    for (const item of FIRST_AID_ITEM_NAMES) {
      expect(screen.getAllByText(item).length, `${item} has no column`).toBeGreaterThan(0)
    }
  })

  it('shows each cell as held over required, and the site’s availability', () => {
    render(<FirstAid />)
    const alpha = screen.getByText('Alpha').closest('tr')
    // 20 of 20 bandages and 1 of 1 scissors are stocked; the expired burn
    // dressing counts as none held, which is the whole point of the column.
    expect(within(alpha).getByText(`${FIRST_AID_ITEM_BY_NAME[BANDAGES].minQty}/${FIRST_AID_ITEM_BY_NAME[BANDAGES].minQty}`)).toBeTruthy()
    expect(within(alpha).getByText('0/2')).toBeTruthy()
    expect(within(alpha).getByText(`2/${FIRST_AID_ITEM_NAMES.length}`)).toBeTruthy()
  })

  // The site nobody has visited is the finding, so it has to be a row. A
  // register that only listed sites with records would report an unsurveyed
  // estate as fully compliant.
  it('lists a site with no first aid records at all', () => {
    render(<FirstAid />)
    const beta = screen.getByText('Beta').closest('tr')
    expect(within(beta).getByText(`0/${FIRST_AID_ITEM_NAMES.length}`)).toBeTruthy()
  })
})

describe('First Aid dashboard', () => {
  it('reports readiness over every site × item cell, unchecked sites included', () => {
    render(<FirstAidDashboard />)
    const cells = 2 * FIRST_AID_ITEM_NAMES.length
    expect(screen.getByText('Sites in scope').closest('div').parentElement.textContent).toContain('2')
    // 2 of 32 cells stocked → 6 %.
    expect(screen.getByText(`${Math.round((2 / cells) * 100)}%`)).toBeTruthy()
    expect(screen.getByText(`Contents status — ${cells} checks (2 sites × ${FIRST_AID_ITEM_NAMES.length} items)`)).toBeTruthy()
  })

  it('counts expired stock on its own, not as a condition anybody recorded', () => {
    render(<FirstAidDashboard />)
    const tile = screen.getByText('Expired items').closest('div').parentElement
    expect(tile.textContent).toContain('1')
  })

  it('names the sites with gaps rather than only the total', () => {
    render(<FirstAidDashboard />)
    const bySite = screen.getByText('By site — most gaps first').closest('div')
    expect(within(bySite).getByText('Alpha')).toBeTruthy()
    expect(within(bySite).getByText('Beta')).toBeTruthy()
  })
})

describe('Stretcher repository', () => {
  it('lists each unit with its status', () => {
    render(<Stretchers />)
    expect(screen.getByText('STR-0001')).toBeTruthy()
    expect(screen.getByText('STR-0002')).toBeTruthy()
    expect(screen.getByText('Out of Service')).toBeTruthy()
  })

  // The only date on the record: without it the unit can never fall due, so a
  // record missing it is flagged rather than left looking permanently healthy.
  it('flags a record whose key details are still blank', () => {
    fleet.value = { ...fleet.value, stretchers: [{ ...stretchers[0], nextInspection: '' }] }
    render(<Stretchers />)
    expect(screen.getByText('Data N/A')).toBeTruthy()
  })
})

describe('Stretcher dashboard', () => {
  it('buckets the fleet by readiness', () => {
    render(<StretcherDashboard />)
    expect(screen.getByText('Total stretchers').closest('div').parentElement.textContent).toContain('2')
    // "Out of service" is both a stat tile and a segment of the readiness bar,
    // so this asks the tile specifically rather than whichever came first.
    const tile = screen.getAllByText('Out of service').map((n) => n.closest('.card')).find(Boolean)
    expect(tile.textContent).toContain('1')
  })

  // Every other figure on that page is drawn from the register, so a site with
  // no stretcher at all contributes to none of them — invisible precisely
  // because it is the largest gap.
  it('names the sites that have no stretcher on the register', () => {
    render(<StretcherDashboard />)
    expect(screen.getByText(/1 site has no stretcher on the register/)).toBeTruthy()
    expect(screen.getByText(/Beta/)).toBeTruthy()
  })
})
