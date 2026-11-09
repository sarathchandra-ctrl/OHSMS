// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within, fireEvent, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const h = vi.hoisted(() => ({ create: vi.fn(async () => 'LP-2026-0001'), role: 'member' }))

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({
    profile: { id: 'u1', displayName: 'Req Uester' },
    can: () => true,
    platformRole: h.role,
  }),
}))
vi.mock('../../hooks/useOrgProcedures', () => ({
  useOrgProcedures: () => ({
    loading: false,
    procedures: [
      { id: 'p1', procedureCode: 'PUMP-1', status: 'approved', revision: 2, equipment: 'Pump A', site: 'S1', siteId: 's1',
        isolationPoints: [
          { key: 'k1', energySource: 'electrical', devices: ['safety_padlock'] },
          { key: 'k2', energySource: 'hydraulic', devices: ['ball_valve_lock'] },
        ] },
      { id: 'p2', procedureCode: 'PUMP-DRAFT', status: 'draft', revision: 0, equipment: 'Pump A', site: 'S1', siteId: 's1', isolationPoints: [] },
      { id: 'p3', procedureCode: 'PUMP-PENDING', status: 'pending_approval', revision: 0, equipment: 'Pump A', site: 'S1', siteId: 's1', isolationPoints: [] },
      { id: 'p4', procedureCode: 'PRESS-DRAFT', status: 'draft', revision: 0, equipment: 'Press 4', site: 'S1', siteId: 's1', isolationPoints: [] },
      { id: 'p5', procedureCode: 'FAN-1', status: 'approved', revision: 1, equipment: 'Fan 9', site: 'S1', siteId: 's1',
        isolationPoints: [{ key: 'k1', energySource: 'electrical', devices: ['safety_padlock'] }],
        lockSummary: { status: 'locked', lockedCount: 1, total: 1 } },
    ],
  }),
}))
vi.mock('../../hooks/useTechnicians', () => ({ useTechnicians: () => ({ technicians: [] }) }))
vi.mock('../../hooks/useLocks', () => ({
  useLocks: () => ({ locks: [{ id: 'l1', lockNo: 'D-1', type: 'department', active: true }, { id: 'l2', lockNo: 'D-2', type: 'department', active: true }] }),
}))
vi.mock('../../../../shared/org/orgData', () => ({
  subscribeOrgUsers: (_o, cb) => { cb([{ uid: 'u2', name: 'Asha', status: 'approved' }]); return () => {} },
}))
vi.mock('../../services/permits', () => ({ createPermit: h.create }))
vi.mock('../../services/shiftSettings', () => ({
  subscribeShiftSettings: (_org, cb) => { cb(null); return () => {} },
}))
vi.mock('react-hot-toast', () => ({ default: { error: vi.fn(), success: vi.fn() } }))
vi.mock('../../../../shared/lib/toastCaught', () => ({ toastCaught: vi.fn() }))

const { default: NewPermit } = await import('./NewPermit')

const mount = () => render(<MemoryRouter><NewPermit /></MemoryRouter>)
beforeEach(() => { cleanup(); h.create.mockClear(); h.role = 'member' })

describe('the permit request form', () => {
  it('asks for equipment and an approved procedure for every work type', () => {
    mount()
    expect(screen.queryByLabelText('Equipment')).toBeNull()
    expect(screen.queryByRole('option', { name: /tag-only/i })).toBeNull()
    fireEvent.change(screen.getByLabelText('Work type'), { target: { value: 'machine_maintenance' } })
    expect(screen.getByLabelText('Equipment')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Work type'), { target: { value: 'electrical_work' } })
    expect(screen.getByLabelText('Approved procedure')).toBeTruthy()
    expect(screen.queryByLabelText('Start')).toBeNull()
    expect(screen.queryByLabelText('End')).toBeNull()
    expect(screen.queryByRole('option', { name: /custom window/i })).toBeNull()
  })

  it('warns when the chosen equipment is already locked out', () => {
    mount()
    fireEvent.change(screen.getByLabelText('Work type'), { target: { value: 'electrical_work' } })
    fireEvent.change(screen.getByLabelText('Equipment'), { target: { value: 's1::fan 9' } })
    expect(screen.getByText(/already locked out/)).toBeTruthy()
  })

  it('lists ONLY that equipment’s APPROVED procedures, and disables equipment with none', () => {
    mount()
    fireEvent.change(screen.getByLabelText('Work type'), { target: { value: 'machine_maintenance' } })
    const equipment = screen.getByLabelText('Equipment')
    expect(within(equipment).getByText(/Press 4/).closest('option').disabled).toBe(true)
    fireEvent.change(equipment, { target: { value: 's1::pump a' } })
    const options = [...screen.getByLabelText('Approved procedure').querySelectorAll('option')].map((o) => o.textContent)
    expect(options.some((t) => t.includes('PUMP-1'))).toBe(true)
    expect(options.some((t) => t.includes('DRAFT') || t.includes('PENDING'))).toBe(false)
  })

  it('auto-fills the devices and the isolation point count from the chosen procedure', () => {
    mount()
    fireEvent.change(screen.getByLabelText('Work type'), { target: { value: 'machine_maintenance' } })
    fireEvent.change(screen.getByLabelText('Equipment'), { target: { value: 's1::pump a' } })
    fireEvent.change(screen.getByLabelText('Approved procedure'), { target: { value: 'p1' } })
    expect(screen.getByText('2 isolation points')).toBeTruthy()
    expect(screen.getByText(/Lock-out devices:/).textContent).toMatch(/Padlock/i)
    // One lock chooser per point.
    expect(screen.getByLabelText('Lock for E-1')).toBeTruthy()
    expect(screen.getByLabelText('Lock for H-1')).toBeTruthy()
  })

  it('does not submit an incomplete request', () => {
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'Request permit' }))
    expect(h.create).not.toHaveBeenCalled()
    expect(screen.getByText('Choose the type of work.')).toBeTruthy()
  })

  it('turns an auditor away', () => {
    h.role = 'auditor'
    mount()
    expect(screen.getByText(/can read permits but not raise them/)).toBeTruthy()
  })
})
