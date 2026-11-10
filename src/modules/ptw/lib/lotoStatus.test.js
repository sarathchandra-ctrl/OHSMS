import { describe, expect, it } from 'vitest'
import { STATUS, dashboardBuckets, derivePermitStatus, statusMeta } from './permitStatus'

const NOW = Date.parse('2026-11-10T10:00:00.000Z')
const ok = { status: 'approved' }
const approved = (extra = {}) => ({
  engineering: ok,
  operations: ok,
  validFrom: '2026-11-10T08:00:00.000Z',
  validTo: '2026-11-10T16:00:00.000Z',
  lotoProcedureId: 'proc-1',
  ...extra,
})
const closed = (extra = {}) => approved({ closure: { engineering: ok, operations: ok }, ...extra })

describe('an electrical permit waits on its LOTO procedure', () => {
  it('is Approved — LOTO pending until every isolation point is locked', () => {
    for (const lotoLockStatus of [undefined, 'unlocked', 'partial']) {
      expect(derivePermitStatus(approved({ lotoLockStatus }), NOW), String(lotoLockStatus)).toBe(STATUS.APPROVED_LOTO_PENDING)
    }
    expect(derivePermitStatus(approved({ lotoLockStatus: 'locked' }), NOW)).toBe(STATUS.IN_PROGRESS)
    expect(statusMeta(STATUS.APPROVED_LOTO_PENDING).label).toBe('Approved — LOTO pending')
  })

  it('is Closed — LOTO pending until every lock has come off', () => {
    for (const lotoLockStatus of [undefined, 'locked', 'partial']) {
      expect(derivePermitStatus(closed({ lotoLockStatus }), NOW), String(lotoLockStatus)).toBe(STATUS.CLOSED_LOTO_PENDING)
    }
    expect(derivePermitStatus(closed({ lotoLockStatus: 'unlocked' }), NOW)).toBe(STATUS.CLOSED)
  })

  it('still expires, still needs both approvals, and leaves other permits alone', () => {
    expect(derivePermitStatus(approved(), Date.parse('2026-11-11T00:00:00.000Z'))).toBe(STATUS.NOT_CLOSED)
    expect(derivePermitStatus({ ...approved(), operations: { status: 'pending' } }, NOW)).toBe(STATUS.DRAFT)
    const plain = approved({ lotoProcedureId: undefined })
    expect(derivePermitStatus(plain, NOW)).toBe(STATUS.IN_PROGRESS)
    expect(derivePermitStatus({ ...plain, closure: { engineering: ok, operations: ok } }, NOW)).toBe(STATUS.CLOSED)
  })

  it('counts LOTO pending on its own on the dashboard', () => {
    const c = dashboardBuckets([approved(), closed(), approved({ lotoLockStatus: 'locked' })], NOW)
    expect(c.lotoPending).toBe(2)
    expect(c.inProgress).toBe(1)
    expect(c.closed).toBe(0)
  })
})
