// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'

const h = vi.hoisted(() => ({
  start: vi.fn(async () => {}),
  ret: vi.fn(async () => {}),
  decide: vi.fn(async () => {}),
  toastError: vi.fn(),
}))

vi.mock('../../services/permitActions', () => ({
  startIsolation: h.start,
  returnPermit: h.ret,
  decidePermit: h.decide,
  withdrawPermit: vi.fn(),
  extendPermit: vi.fn(),
  emergencyRemovePermit: vi.fn(),
}))
vi.mock('react-hot-toast', () => ({ default: { error: h.toastError, success: vi.fn() } }))
vi.mock('../../../../shared/lib/toastCaught', () => ({ toastCaught: vi.fn() }))

const { default: PermitActions } = await import('./PermitActions')

const permit = (over = {}) => ({
  id: 'LP-2026-0001', status: 'approved', requestedBy: 'u1', procedureId: 'p1',
  isolationPoints: [{ key: 'k1', pointId: 'E-1' }, { key: 'k2', pointId: 'H-1' }],
  locks: [{ pointKey: 'k1', lockNo: 'D-1' }, { pointKey: 'k2', lockNo: 'D-2' }],
  ...over,
})
const base = { user: { id: 'u1', displayName: 'Req' }, isAdmin: false, isParty: true, otherAdmin: true, canWrite: true }
const mount = (props) => render(<PermitActions {...base} {...props} />)

beforeEach(() => { cleanup(); vi.clearAllMocks() })

const scan = (code) => {
  fireEvent.change(screen.getByLabelText(/Tag code/), { target: { value: code } })
  fireEvent.click(screen.getByRole('button', { name: 'Record scan' }))
}

describe('starting isolation', () => {
  it('cannot start until the tag on EVERY point is scanned', async () => {
    mount({ permit: permit() })
    const start = screen.getByRole('button', { name: /Lock all 2 and start work/ })
    expect(start.disabled).toBe(true)
    scan('E-1')
    expect(start.disabled).toBe(true)
    expect(screen.getByText(/1 tag still to scan: H-1/)).toBeTruthy()
    scan('h-1')
    expect(start.disabled).toBe(true)
    fireEvent.click(screen.getByLabelText('Yes, zero energy'))
    expect(start.disabled).toBe(true)
    expect(screen.getByText(/Gallery upload is not accepted/)).toBeTruthy()
  })

  it('does not count a tag from other equipment', () => {
    mount({ permit: permit() })
    scan('https://app.example/t/another-proc/k1')
    expect(h.toastError).toHaveBeenCalledWith(expect.stringMatching(/different equipment/))
    expect(screen.getAllByText('Not scanned')).toHaveLength(2)
  })

  it('offers the start only to the people on the permit', () => {
    mount({ permit: permit(), isParty: false })
    expect(screen.queryByRole('button', { name: /start work/ })).toBeNull()
  })

  it('shows nothing to an auditor', () => {
    const { container } = mount({ permit: permit(), canWrite: false })
    expect(container.textContent).toBe('')
  })
})

describe('returning', () => {
  const active = permit({ status: 'active' })

  it('needs the whole checklist AND each lock confirmed before it enables', () => {
    mount({ permit: active })
    const go = screen.getByRole('button', { name: 'Unlock all and return' })
    expect(go.disabled).toBe(true)
    for (const box of screen.getAllByRole('checkbox')) fireEvent.click(box)
    expect(go.disabled).toBe(false)
    fireEvent.click(screen.getByLabelText(/removed lock #D-2/))
    expect(go.disabled).toBe(true)
  })

  it('keeps extension and emergency removal for administrators', () => {
    mount({ permit: active })
    expect(screen.queryByText(/Emergency removal/)).toBeNull()
    expect(screen.queryByText(/Extend the window/)).toBeNull()
    cleanup()
    mount({ permit: active, isAdmin: true })
    expect(screen.getByText(/Emergency removal \(Admin\)/)).toBeTruthy()
    expect(screen.getByText(/Extend the window/)).toBeTruthy()
  })

  it('keeps emergency removal disabled until every attestation is ticked', () => {
    mount({ permit: active, isAdmin: true })
    const go = screen.getByRole('button', { name: 'Remove all locks' })
    expect(go.disabled).toBe(true)
    const attest = screen.getByText('I attest that').closest('fieldset')
    for (const box of attest.querySelectorAll('input[type=checkbox]')) fireEvent.click(box)
    expect(go.disabled).toBe(false)
  })
})

describe('deciding', () => {
  const requested = permit({ status: 'requested' })

  it('lets an administrator approve somebody else’s request', async () => {
    mount({ permit: requested, isAdmin: true, user: { id: 'adm', displayName: 'Ad' } })
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(h.decide).toHaveBeenCalledWith(expect.objectContaining({ approve: true })))
  })

  it('sends an administrator’s own request to another administrator when one exists', () => {
    mount({ permit: permit({ status: 'requested', requestedBy: 'adm' }), isAdmin: true, otherAdmin: true, user: { id: 'adm', displayName: 'Ad' } })
    expect(screen.getByText(/Another administrator has to approve it/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
  })

  it('offers self-approval, with a reason, only when nobody else could', () => {
    mount({ permit: permit({ status: 'requested', requestedBy: 'adm' }), isAdmin: true, otherAdmin: false, user: { id: 'adm', displayName: 'Ad' } })
    expect(screen.getByLabelText(/only administrator/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy()
  })

  it('shows no decision to a non-administrator', () => {
    mount({ permit: requested })
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Withdraw permit' })).toBeTruthy()
  })
})
