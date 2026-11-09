import { describe, it, expect } from 'vitest'
import { publicProcedure, PUBLIC_COL } from './publicProcedure'

// Distinctive sentinels: every place the procedure records a PERSON gets one, so
// a single search of the serialised mirror can prove none of them travelled.
const NAMES = {
  createdByName: 'ZZCREATOR',
  approvedByName: 'ZZAPPROVER',
  revisedByName: 'ZZREVISER',
  primaryTech: 'ZZPRIMARY',
  lockTech: 'ZZLOCKER',
  groupMember: 'ZZMEMBER',
}

const procedure = {
  id: 'proc-1',
  procedureCode: 'ACME-PLANT-2-PRESS',
  title: 'Hydraulic press isolation',
  equipment: 'Hydraulic Press #4',
  site: 'Plant 2 — Bay C',
  status: 'approved',
  revision: 3,
  lockSummary: { status: 'partial', lockedCount: 1, total: 2 },

  // None of the following may reach the public mirror.
  createdBy: 'uid-1',
  createdByName: NAMES.createdByName,
  approvedBy: 'uid-2',
  approvedByName: NAMES.approvedByName,
  approvedAt: '2026-01-02T00:00:00.000Z',
  revisedBy: 'uid-3',
  revisedByName: NAMES.revisedByName,
  primaryTech: { techId: 't1', name: NAMES.primaryTech, lockNo: '112' },
  groupLock: {
    active: true,
    method: 'box',
    members: [{ techId: 't2', name: NAMES.groupMember, boxLock: '9', locks: { p1: '9' } }],
  },

  isolationPoints: [
    {
      key: 'p1',
      energySource: 'electrical',
      rating: '480V 3PH',
      isolationDetails: 'Open disconnect DS-04 on the north wall.',
      hazard: 'Arc flash — PPE category 2 required.',
      verification: 'Test dead with a rated meter.',
      device: 'breaker_lockout',
      hasPhoto: true,
      lockState: {
        locked: true,
        lockType: 'personal',
        techLockNo: '112',
        techName: NAMES.lockTech,
        lockedBy: 'uid-9',
        lockedAt: '2026-01-20T08:15:00.000Z',
      },
    },
    {
      key: 'p2',
      energySource: 'hydraulic',
      isolationDetails: 'Close valve HV-11 and bleed the accumulator.',
      verification: 'Gauge reads zero.',
      devices: ['valve_lockout', 'hasp'],
      lockState: { locked: false, unlockedAt: '2026-01-20T16:40:00.000Z' },
    },
  ],
}

describe('the public mirror of a procedure', () => {
  it('is its own collection, keyed so the printed codes keep working', () => {
    expect(PUBLIC_COL).toBe('procedureQr')
  })

  it('carries what someone standing at the machine needs', () => {
    const pub = publicProcedure(procedure)
    expect(pub).toMatchObject({
      procedureCode: 'ACME-PLANT-2-PRESS',
      equipment: 'Hydraulic Press #4',
      site: 'Plant 2 — Bay C',
      status: 'approved',
      revision: 3,
      lockStatus: 'partial',
      lockedCount: 1,
      pointCount: 2,
    })
    expect(pub.points[0]).toMatchObject({
      key: 'p1',
      energySource: 'electrical',
      rating: '480V 3PH',
      isolationDetails: 'Open disconnect DS-04 on the north wall.',
      hazard: 'Arc flash — PPE category 2 required.',
      verification: 'Test dead with a rated meter.',
      device: 'breaker_lockout',
    })
  })

  it('says WHETHER a point is locked, never who locked it', () => {
    const pub = publicProcedure(procedure)
    expect(pub.points.map((p) => p.locked)).toEqual([true, false])
    expect(pub.points[0]).not.toHaveProperty('lockState')
    expect(pub.points[0]).not.toHaveProperty('techName')
    expect(pub.points[0]).not.toHaveProperty('lockedBy')
    expect(pub.points[0]).not.toHaveProperty('lockedAt')
  })

  // The test this file exists for. Anything that names a person is a privacy
  // incident on an unauthenticated URL, and one added field is all it takes.
  it('leaks no person, anywhere in the serialised document', () => {
    const wire = JSON.stringify(publicProcedure(procedure))
    for (const [field, sentinel] of Object.entries(NAMES)) {
      expect(wire, `${field} reached the public mirror`).not.toContain(sentinel)
    }
    expect(wire).not.toContain('uid-')
    expect(wire).not.toMatch(/primaryTech|groupLock|approvedBy|createdBy|revisedBy/)
  })

  // A whitelist means a field invented next month is private by default. If this
  // ever fails, someone turned the builder into a spread and the next new field
  // ships public with nothing to notice.
  it('drops fields it was never told to publish', () => {
    const pub = publicProcedure({
      ...procedure,
      secretNewField: 'ZZSECRET',
      isolationPoints: [{ ...procedure.isolationPoints[0], operatorNotes: 'ZZNOTE' }],
    })
    const wire = JSON.stringify(pub)
    expect(wire).not.toContain('ZZSECRET')
    expect(wire).not.toContain('ZZNOTE')
    expect(wire).not.toContain('secretNewField')
  })

  it('has no timestamp of its own — the caller stamps it inside the write', () => {
    expect(publicProcedure(procedure)).not.toHaveProperty('updatedAt')
  })

  it('survives an empty or malformed procedure rather than throwing', () => {
    expect(() => publicProcedure()).not.toThrow()
    expect(publicProcedure()).toMatchObject({ points: [], pointCount: 0, revision: 0, lockedCount: 0 })
    expect(publicProcedure({ isolationPoints: 'nonsense' }).points).toEqual([])
    expect(publicProcedure({ isolationPoints: [null] }).points[0].locked).toBe(false)
  })
})

// One builder, used by every writer. A second partial variant would be a second
// definition of what is public, and the leak test above would only cover one.
describe('there is exactly one definition of what is public', () => {
  it('exports no other builder', async () => {
    const mod = await import('./publicProcedure')
    expect(Object.keys(mod).sort()).toEqual(['PUBLIC_COL', 'publicProcedure'])
  })

  // The lock path rewrites the mirror from the merged procedure, so a lock
  // going on or off is enough to give a pre-mirror procedure a complete one.
  it('builds a complete mirror from a procedure merged mid-transaction', () => {
    const merged = {
      ...procedure,
      isolationPoints: procedure.isolationPoints.map((p) => ({ ...p, lockState: { locked: true, techName: NAMES.lockTech } })),
      lockSummary: { status: 'locked', lockedCount: 2, total: 2 },
    }
    const pub = publicProcedure(merged)
    expect(pub.points.every((p) => p.locked)).toBe(true)
    expect(pub.lockStatus).toBe('locked')
    expect(pub.equipment).toBe('Hydraulic Press #4')
    expect(JSON.stringify(pub)).not.toContain(NAMES.lockTech)
  })
})
