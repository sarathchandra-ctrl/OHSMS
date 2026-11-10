import { describe, it, expect } from 'vitest'
import { LOTO_PERMIT_RETENTION_DAYS, isPurgeable } from './lotoPermitSweep.js'

const DAY = 24 * 60 * 60 * 1000
const T = (iso) => Date.parse(iso)

describe('isPurgeable', () => {
  const now = T('2027-10-10T00:00:00Z')
  const closed = (status, closedAt) => ({ status, closedAt })

  it('purges a closed permit once it is a year old, whichever way it closed', () => {
    for (const status of ['returned', 'rejected', 'withdrawn', 'emergency_removed']) {
      expect(isPurgeable(closed(status, now - LOTO_PERMIT_RETENTION_DAYS * DAY), now)).toBe(true)
    }
  })

  it('keeps one closed less than a year ago', () => {
    expect(isPurgeable(closed('returned', now - (LOTO_PERMIT_RETENTION_DAYS - 1) * DAY), now)).toBe(
      false
    )
  })

  it('NEVER purges an open permit, however old', () => {
    for (const status of ['requested', 'approved', 'active']) {
      expect(isPurgeable({ status, closedAt: now - 5 * 365 * DAY, windowEnd: 1 }, now)).toBe(false)
    }
  })

  it('keeps a closed permit it cannot date', () => {
    expect(isPurgeable({ status: 'returned' }, now)).toBe(false)
    expect(isPurgeable(null, now)).toBe(false)
  })

  it('reads a Firestore Timestamp', () => {
    expect(
      isPurgeable({ status: 'returned', closedAt: { toMillis: () => now - 400 * DAY } }, now)
    ).toBe(true)
  })
})
