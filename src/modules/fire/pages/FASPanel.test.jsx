// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

const auth = { value: { orgName: 'Acme', profile: { uid: 'a', name: 'Ada' }, isAdmin: true } }
const fleet = { value: { loading: false, fas: [] } }
const getFas = vi.fn()
const generateFasQr = vi.fn()
const exportQrLabelPdf = vi.fn()
const printed = []

vi.mock('../context/AuthContext', () => ({ useAuth: () => auth.value }))
vi.mock('../context/FleetContext', () => ({ useFleet: () => fleet.value }))
vi.mock('../lib/data', () => ({
  getFas: (...args) => getFas(...args),
  generateFasQr: (...args) => generateFasQr(...args),
}))
vi.mock('../lib/qrLabelSheet', () => ({
  exportQrLabelPdf: (...args) => exportQrLabelPdf(...args),
}))
vi.mock('qrcode.react', () => ({
  QRCodeSVG: ({ value }) => <svg data-testid="qr" data-value={value} />,
}))
vi.mock('react-to-print', () => ({
  useReactToPrint: () => () => printed.push('print'),
}))
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }))

const { default: FASPanel } = await import('./FASPanel')

const panel = {
  id: 'p1',
  deviceId: 'FAS-0007',
  deviceType: 'Control Panel',
  centerName: 'North Plant',
  zone: 'Zone 1',
  location: 'Reception',
  status: 'operational',
  qrToken: 'panel-tok',
}

function renderAt(id = 'p1') {
  return render(
    <MemoryRouter initialEntries={[`/equipment/fas/${id}`]}>
      <Routes>
        <Route path="/equipment/fas/:id" element={<FASPanel />} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  printed.length = 0
  getFas.mockReset()
  generateFasQr.mockReset()
  exportQrLabelPdf.mockReset()
  exportQrLabelPdf.mockResolvedValue({ exported: 1, skipped: 0 })
  auth.value = { orgName: 'Acme', profile: { uid: 'a', name: 'Ada' }, isAdmin: true }
  fleet.value = { loading: false, fas: [panel] }
})

describe('FAS panel page', () => {
  it('shows the panel and a QR code that points at its public page', () => {
    renderAt()
    expect(screen.getByRole('heading', { name: 'FAS-0007' })).toBeTruthy()
    expect(screen.getAllByText(/North Plant/).length).toBeGreaterThan(0)
    expect(screen.getByText('Operational')).toBeTruthy()
    const qr = screen.getByTestId('qr')
    expect(qr.getAttribute('data-value')).toMatch(/\/qr\/panel-tok$/)
    expect(screen.getByRole('link', { name: /open the page a scan opens/i }).getAttribute('href')).toMatch(/\/qr\/panel-tok$/)
  })

  it('downloads and prints the label for this panel', async () => {
    renderAt()
    fireEvent.click(screen.getByRole('button', { name: /download qr label for FAS-0007/i }))
    await waitFor(() => expect(exportQrLabelPdf).toHaveBeenCalledWith('fas', [expect.objectContaining({ id: 'p1', qrToken: 'panel-tok' })]))
    fireEvent.click(screen.getByRole('button', { name: /print qr label for FAS-0007/i }))
    expect(printed).toEqual(['print'])
  })

  it('does not offer a QR code for a device that is not a control panel', () => {
    fleet.value = {
      loading: false,
      fas: [{ ...panel, id: 'd1', deviceId: 'FAS-0008', deviceType: 'Smoke Detector', qrToken: '' }],
    }
    renderAt('d1')
    expect(screen.queryByTestId('qr')).toBeNull()
    expect(screen.getByText(/covered by the panel at its site/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /download qr label/i })).toBeNull()
  })

  it('lets an admin generate a code for a panel that has none', async () => {
    fleet.value = { loading: false, fas: [{ ...panel, qrToken: '' }] }
    generateFasQr.mockResolvedValue('fresh-tok')
    renderAt()
    expect(screen.queryByTestId('qr')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /generate qr code for FAS-0007/i }))
    await waitFor(() => expect(generateFasQr).toHaveBeenCalled())
    expect(screen.getByTestId('qr').getAttribute('data-value')).toMatch(/\/qr\/fresh-tok$/)
  })

  it('says the panel was not found when the register and the record both miss it', async () => {
    fleet.value = { loading: false, fas: [] }
    getFas.mockResolvedValue(null)
    renderAt('missing')
    expect(await screen.findByRole('heading', { name: /panel not found/i })).toBeTruthy()
    expect(getFas).toHaveBeenCalledWith('missing')
  })
})
