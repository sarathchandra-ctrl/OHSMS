// @vitest-environment jsdom
//
// The Signage Register's edit form: the Status field, the photos control, and
// the rule that a sign cannot be saved as Deployed without at least one photo AND a
// last-checked date. The fuller count (one per floor / per extinguisher) is shown
// as "Photos: n / m" and a warning, and never blocks Save. Status alone drives
// compliance (Deployed = tick); there is no Condition field any more. deployedRequirementErrors is unit-tested in
// lib/signageLogic.test.js; these check the page actually asks it the right
// question — with the STORED record as `prev` — and shows the answer.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react'

const fleet = { value: null }
const addSignage = vi.fn(async () => 'new-id')
const updateSignage = vi.fn(async () => {})

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ orgName: 'Acme', profile: { uid: 'u1', name: 'Ravi' } }),
}))
vi.mock('../context/FleetContext', () => ({ useFleet: () => fleet.value }))
vi.mock('../lib/data', () => ({
  addSignage: (...a) => addSignage(...a),
  updateSignage: (...a) => updateSignage(...a),
  deleteSignage: vi.fn(),
  linkSignagesToSites: vi.fn(),
}))
vi.mock('../lib/exporter', () => ({ exportSignage: vi.fn() }))
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }))
vi.mock('../../../shared/org/SiteScopePicker', () => ({ default: () => null }))
vi.mock('../../../shared/storage/StoredImage', () => ({
  StoredImage: ({ pointer, alt }) => <img data-testid="stored" alt={alt} src={pointer?.path} />,
}))
const compress = vi.fn(async () => 'data:image/jpeg;base64,AAAA')
vi.mock('../../../shared/lib/image', () => ({ fileToCompressedDataUrl: (...a) => compress(...a) }))

const { default: Signages } = await import('./Signages')

const photo = { path: 'orgs/org-1/signage-photos/a.jpg' }
const rec = (over) => ({
  id: 's1', centerName: 'Alpha', region: 'North', entity: 'COCO', type: 'No Smoking',
  quantity: 1, location: 'Gate', lastChecked: '', ...over,
})

function open(records, name = /Edit No Smoking signage/) {
  fleet.value = {
    loading: false, incomplete: null, sites: ['Alpha'],
    siteInventory: [{ id: 'site-a', name: 'Alpha', region: 'North', entity: 'COCO' }],
    extinguishers: [], aeds: [], fas: [], firstAid: [], stretchers: [], mockDrills: [],
    signages: records,
  }
  render(<Signages />)
  fireEvent.click(screen.getByRole('button', { name: /List/ }))
  fireEvent.click(screen.getByRole('button', { name }))
  return screen.getByRole('dialog')
}

const save = (dlg) => within(dlg).getByRole('button', { name: /Save changes/ })
const status = (dlg) => within(dlg).getByLabelText('Status')
const addInput = (dlg) => dlg.querySelector('input[type="file"][multiple]')
const png = (n = 'p.png') => new File([new Uint8Array(10)], n, { type: 'image/png' })
let seq = 0
const pick = async (dlg, n = 1) => {
  compress.mockImplementation(async () => `data:image/jpeg;base64,IMG${seq++}`)
  const before = within(dlg).queryAllByTestId('signage-photo-item').length
  fireEvent.change(addInput(dlg), { target: { files: Array.from({ length: n }, (_, i) => png(`p${i}.png`)) } })
  await waitFor(() => expect(within(dlg).queryAllByTestId('signage-photo-item').length).toBe(before + n))
}

beforeEach(() => {
  vi.clearAllMocks()
  compress.mockResolvedValue('data:image/jpeg;base64,AAAA')
})

describe('Signage form — status', () => {
  it('offers Not set, Planned, Deployed and Removed, and opens an old record as Not set', () => {
    const dlg = open([rec()])
    expect(status(dlg).value).toBe('')
    expect([...status(dlg).options].map((o) => o.textContent)).toEqual(['Not set', 'Planned', 'Deployed', 'Removed'])
    expect(save(dlg).disabled).toBe(false)
  })

  it('shows "Not set" in the list for a record without a status', () => {
    open([rec()])
    // (the dialog is open; the badge is in the table behind it)
    expect(screen.getAllByText('Not set').length).toBeGreaterThan(0)
  })
})

describe('Signage form — the Deployed requirement', () => {
  it('shows both errors and disables Save when an unset record is moved to Deployed', () => {
    const dlg = open([rec()])
    fireEvent.change(status(dlg), { target: { value: 'Deployed' } })
    expect(within(dlg).getByText('Add a photo before marking as deployed')).toBeTruthy()
    expect(within(dlg).getByText('Enter the last checked date')).toBeTruthy()
    expect(save(dlg).disabled).toBe(true)
  })

  it('clears the date error once a date is entered, leaving the photo one', () => {
    const dlg = open([rec()])
    fireEvent.change(status(dlg), { target: { value: 'Deployed' } })
    fireEvent.change(within(dlg).getByLabelText('Last checked'), { target: { value: '2026-09-01' } })
    expect(within(dlg).queryByText('Enter the last checked date')).toBeNull()
    expect(within(dlg).getByText('Add a photo before marking as deployed')).toBeTruthy()
    expect(save(dlg).disabled).toBe(true)
  })

  it('enables Save once a photo is picked and a date entered, and sends the draft + stored prev', async () => {
    const dlg = open([rec({ status: 'Planned' })])
    fireEvent.change(status(dlg), { target: { value: 'Deployed' } })
    fireEvent.change(within(dlg).getByLabelText('Last checked'), { target: { value: '2026-09-01' } })
    await pick(dlg, 1)
    expect(within(dlg).queryByText('Add a photo before marking as deployed')).toBeNull()
    expect(save(dlg).disabled).toBe(false)
    fireEvent.click(save(dlg))
    await waitFor(() => expect(updateSignage).toHaveBeenCalledTimes(1))
    const [id, payload, , prev] = updateSignage.mock.calls[0]
    expect(id).toBe('s1')
    expect(payload).toMatchObject({ status: 'Deployed', lastChecked: '2026-09-01', photos: [expect.stringMatching(/^data:image\/jpeg/)] })
    expect(payload.photo).toBeNull()
    expect(prev).toMatchObject({ id: 's1', status: 'Planned' })
  })

  it('does not block an existing Deployed record with no photo or date from being edited', () => {
    const dlg = open([rec({ status: 'Deployed' })])
    expect(status(dlg).value).toBe('Deployed')
    expect(within(dlg).queryByText('Add a photo before marking as deployed')).toBeNull()
    expect(save(dlg).disabled).toBe(false)
  })

  it('does not re-open that exemption by switching away and back: prev is the stored status', () => {
    const dlg = open([rec({ status: 'Deployed' })])
    fireEvent.change(status(dlg), { target: { value: 'Removed' } })
    fireEvent.change(status(dlg), { target: { value: 'Deployed' } })
    // It IS still the stored status, so nothing new is being set.
    expect(save(dlg).disabled).toBe(false)
  })

  it('needs no photo or date for Planned or Removed', () => {
    const dlg = open([rec()])
    for (const v of ['Planned', 'Removed']) {
      fireEvent.change(status(dlg), { target: { value: v } })
      expect(save(dlg).disabled).toBe(false)
    }
  })

  it('a new record starts Not set and asks for evidence only when Deployed is chosen', () => {
    fleet.value = {
      loading: false, incomplete: null, sites: ['Alpha'], siteInventory: [], extinguishers: [], aeds: [],
      fas: [], firstAid: [], stretchers: [], mockDrills: [], signages: [],
    }
    render(<Signages />)
    fireEvent.click(screen.getAllByRole('button', { name: /Add signage/ })[0])
    const dlg = screen.getByRole('dialog')
    expect(status(dlg).value).toBe('')
    fireEvent.change(status(dlg), { target: { value: 'Deployed' } })
    expect(within(dlg).getByText('Add a photo before marking as deployed')).toBeTruthy()
    expect(within(dlg).getByRole('button', { name: /Add signage/ }).disabled).toBe(true)
  })
})

describe('Signage form — no Condition field', () => {
  it('has no Condition select or filter chips', () => {
    const dlg = open([rec({ condition: 'Faded' })])
    expect(within(dlg).queryByLabelText('Condition')).toBeNull()
    expect(screen.queryByText('Condition')).toBeNull()
    expect(screen.queryByText('Faded')).toBeNull()
  })
})

describe('Signage — compliance follows status', () => {
  const row = (name) => screen.getByRole('button', { name }).closest('tr')
  it('shows a tick for Deployed and Non-compliant with no tick for the rest', () => {
    fleet.value = {
      loading: false, incomplete: null, sites: ['Alpha'], siteInventory: [],
      extinguishers: [], aeds: [], fas: [], firstAid: [], stretchers: [], mockDrills: [],
      signages: [
        rec({ id: 'd', type: 'No Smoking', location: 'D', status: 'Deployed', condition: 'Missing' }),
        rec({ id: 'p', type: 'Fire Exit', location: 'P', status: 'Planned', condition: 'OK' }),
        rec({ id: 'r', type: 'First Aid', location: 'R', status: 'Removed' }),
        rec({ id: 'n', type: 'Assembly Point', location: 'N' }),
      ],
    }
    render(<Signages />)
    fireEvent.click(screen.getByRole('button', { name: /List/ }))
    expect(within(row(/Edit No Smoking signage/)).getByText('Compliant')).toBeTruthy()
    for (const name of [/Edit Fire Exit signage/, /Edit First Aid signage/, /Edit Assembly Point signage/]) {
      const r = row(name)
      expect(within(r).getByText('Non-compliant')).toBeTruthy()
      expect(within(r).queryByText('Compliant')).toBeNull()
    }
  })

  it('draws the matrix tick only for a Deployed record', () => {
    fleet.value = {
      loading: false, incomplete: null, sites: ['Alpha'], siteInventory: [],
      extinguishers: [], aeds: [], fas: [], firstAid: [], stretchers: [], mockDrills: [],
      signages: [
        rec({ id: 'd', type: 'No Smoking', status: 'Deployed' }),
        rec({ id: 'p', type: 'Fire Exit', status: 'Planned' }),
      ],
    }
    render(<Signages />)
    const cell = (t) => screen.getByText(t, { selector: 'th' }).cellIndex
    const tds = screen.getAllByRole('row').find((r) => r.querySelector('td') && r.textContent.includes('Alpha')).querySelectorAll('td')
    expect(within(tds[cell('No Smoking')]).getByLabelText('Compliant')).toBeTruthy()
    expect(within(tds[cell('Fire Exit')]).queryByLabelText('Compliant')).toBeNull()
    expect(tds[cell('Fire Exit')].querySelector('button').className).toContain('bg-red-50')
  })

  it('exports Status, Compliant and Required / Uploaded photos (no Condition)', async () => {
    const { exportSignage } = await import('../lib/exporter')
    fleet.value = {
      loading: false, incomplete: null, sites: ['Alpha'], siteInventory: [],
      extinguishers: [], aeds: [], fas: [], firstAid: [], stretchers: [], mockDrills: [],
      signages: [
        rec({ id: 'd', type: 'No Smoking', status: 'Deployed', photos: [photo, photo], condition: 'Faded' }),
        rec({ id: 'p', type: 'Fire Exit', status: 'Planned', photo }),
      ],
    }
    render(<Signages />)
    fireEvent.click(screen.getByRole('button', { name: /Export/ }))
    const [, detail] = exportSignage.mock.calls[0]
    expect(detail.find((r) => r.Type === 'No Smoking')).toMatchObject({ Status: 'Deployed', Compliant: 'Yes', 'Required Photos': 1, 'Uploaded Photos': 2 })
    expect(detail.find((r) => r.Type === 'Fire Exit')).toMatchObject({ Status: 'Planned', Compliant: 'No', 'Required Photos': 1, 'Uploaded Photos': 1 })
    expect(Object.keys(detail[0])).not.toContain('Condition')
    expect(Object.keys(detail[0])).not.toContain('Photo')
    expect(Object.keys(detail[0])).not.toContain('Photos')
  })
})

describe('Signage form — the photos control', () => {
  it('shows the stored photo as a thumbnail with Replace and Remove, counted "1 of 1"', () => {
    const dlg = open([rec({ status: 'Planned', photo })])
    expect(within(dlg).getByTestId('stored').getAttribute('src')).toBe(photo.path)
    expect(within(dlg).getByText('Replace')).toBeTruthy()
    expect(within(dlg).getByText('Remove')).toBeTruthy()
    expect(within(dlg).getByTestId('photo-counter').textContent).toContain('1 of 1 photo added')
  })

  it('Remove clears that photo, so a Deployed-bound record loses its evidence again', () => {
    const dlg = open([rec({ status: 'Planned', photo, lastChecked: '2026-09-01' })])
    fireEvent.change(status(dlg), { target: { value: 'Deployed' } })
    expect(save(dlg).disabled).toBe(false)
    fireEvent.click(within(dlg).getByLabelText('Remove photo 1'))
    expect(within(dlg).getByText('Add a photo before marking as deployed')).toBeTruthy()
    expect(within(dlg).getByText('Add photos')).toBeTruthy()
    expect(save(dlg).disabled).toBe(true)
  })

  it('Replace swaps one photo for a new one', async () => {
    const dlg = open([rec({ status: 'Planned', photos: [photo, { path: 'orgs/org-1/signage-photos/b.jpg' }] })])
    compress.mockResolvedValue('data:image/jpeg;base64,NEW')
    const input = within(dlg).getByLabelText('Replace photo 1').querySelector('input')
    fireEvent.change(input, { target: { files: [png()] } })
    await waitFor(() => expect(within(dlg).getAllByAltText(/^Signage \d/).some((i) => i.getAttribute('src') === 'data:image/jpeg;base64,NEW')).toBe(true))
    expect(within(dlg).getAllByTestId('signage-photo-item')).toHaveLength(2)
  })

  it('refuses a non-image file', async () => {
    const dlg = open([rec()])
    fireEvent.change(addInput(dlg), { target: { files: [new File(['x'], 'a.pdf', { type: 'application/pdf' })] } })
    await waitFor(() => expect(addInput(dlg).disabled).toBe(false))
    expect(compress).not.toHaveBeenCalled()
  })
})

describe('Signage form — one photo per floor (FERP): counted, not enforced', () => {
  const ferp = (over) => rec({ type: 'FERP Signage', totalFloors: 3, allFloors: true, status: 'Planned', lastChecked: '2026-09-01', ...over })
  const openFerp = (over) => open([ferp(over)], /Edit FERP Signage signage/)

  it('needs one photo to be Deployed; more only change the counter and a soft warning', async () => {
    const dlg = openFerp()
    fireEvent.change(status(dlg), { target: { value: 'Deployed' } })
    expect(within(dlg).getByText('Add a photo before marking as deployed')).toBeTruthy()
    expect(within(dlg).getByTestId('photo-counter').textContent).toContain('0 of 3 photos added')
    expect(save(dlg).disabled).toBe(true)
    await pick(dlg, 1)
    expect(within(dlg).getByTestId('photo-counter').textContent).toContain('1 of 3 photos added')
    expect(within(dlg).queryByRole('alert')).toBeNull()
    expect(within(dlg).getByTestId('photo-warning').textContent).toContain('one per floor')
    expect(save(dlg).disabled).toBe(false)
    await pick(dlg, 2)
    expect(within(dlg).queryByTestId('photo-warning')).toBeNull()
    expect(save(dlg).disabled).toBe(false)
  })

  it('still needs the last-checked date', async () => {
    const dlg = openFerp({ lastChecked: '' })
    fireEvent.change(status(dlg), { target: { value: 'Deployed' } })
    await pick(dlg, 1)
    expect(within(dlg).getByText('Enter the last checked date')).toBeTruthy()
    expect(save(dlg).disabled).toBe(true)
  })

  it('needs fewer expected photos when only some floors are covered', () => {
    const dlg = openFerp({ allFloors: false, floorsCovered: 2 })
    expect(within(dlg).getByTestId('photo-counter').textContent).toContain('0 of 2 photos added')
  })

  it('asks for nothing while the status is not Deployed', () => {
    const dlg = openFerp()
    expect(within(dlg).queryByRole('alert')).toBeNull()
    expect(save(dlg).disabled).toBe(false)
  })
})

describe('Signage form — one photo per extinguisher: counted, not enforced', () => {
  it('follows the quantity in the counter, and saves with a single photo', async () => {
    const dlg = open([rec({ type: 'Fire Extinguisher Sign', quantity: 3, status: 'Planned', lastChecked: '2026-09-01' })], /Edit Fire Extinguisher Sign signage/)
    fireEvent.change(status(dlg), { target: { value: 'Deployed' } })
    expect(within(dlg).getByTestId('photo-counter').textContent).toContain('0 of 3 photos added (one per extinguisher)')
    expect(save(dlg).disabled).toBe(true)
    await pick(dlg, 1)
    expect(save(dlg).disabled).toBe(false)
    expect(within(dlg).getByTestId('photo-warning').textContent).toContain('1 of 3')
    fireEvent.change(within(dlg).getByLabelText('Quantity'), { target: { value: '4' } })
    expect(within(dlg).getByTestId('photo-counter').textContent).toContain('1 of 4 photos added')
    expect(save(dlg).disabled).toBe(false)
  })

  it('other types expect just one photo whatever the quantity', async () => {
    const dlg = open([rec({ quantity: 6, status: 'Planned', lastChecked: '2026-09-01' })])
    fireEvent.change(status(dlg), { target: { value: 'Deployed' } })
    expect(within(dlg).getByText('Add a photo before marking as deployed')).toBeTruthy()
    await pick(dlg, 1)
    expect(save(dlg).disabled).toBe(false)
    expect(within(dlg).queryByTestId('photo-warning')).toBeNull()
  })

  it('an already-Deployed record is not blocked', () => {
    const dlg = open([rec({ type: 'Fire Extinguisher Sign', quantity: 5, status: 'Deployed' })], /Edit Fire Extinguisher Sign signage/)
    expect(within(dlg).queryByRole('alert')).toBeNull()
    expect(save(dlg).disabled).toBe(false)
  })
})

describe('Signage list — Photos: uploaded / required', () => {
  it('shows the count per record, in the list', () => {
    fleet.value = {
      loading: false, incomplete: null, sites: ['Alpha'], siteInventory: [],
      extinguishers: [], aeds: [], fas: [], firstAid: [], stretchers: [], mockDrills: [],
      signages: [
        rec({ id: 'e', type: 'Fire Extinguisher Sign', location: 'E', quantity: 5, status: 'Deployed', photos: [photo, photo] }),
        rec({ id: 'n', type: 'No Smoking', location: 'N', status: 'Deployed', photo }),
      ],
    }
    render(<Signages />)
    fireEvent.click(screen.getByRole('button', { name: /List/ }))
    const r = (name) => screen.getByRole('button', { name }).closest('tr')
    expect(within(r(/Edit Fire Extinguisher Sign signage/)).getByTestId('photo-count').textContent).toContain('Photos: 2 / 5')
    expect(within(r(/Edit No Smoking signage/)).getByTestId('photo-count').textContent).toContain('Photos: 1 / 1')
  })
})
