import { describe, it, expect, vi } from 'vitest'

// ─────────────────────────────────────────────────────────────────────────────
// The keys a public QR mirror may carry, pinned against the code that writes
// them.
//
// stack/policy.mjs constrains /qr, /permitQr and /procedureQr to a list of
// keys (MIRROR_FIELDS), which is the right control on a world-readable
// document and the wrong thing to maintain by hand: add a field to a mirror
// builder and the policy silently starts refusing the write — the symptom
// being a printed QR code that stops updating, found by whoever scans it.
//
// So this test calls the REAL builders against the policy's own lists and
// fails with the missing key named.
//
// WHEN THIS FAILS: add the key to MIRROR_FIELDS in stack/policy.mjs — but only
// if it is safe to show to anyone holding the QR code, without an account.
// ─────────────────────────────────────────────────────────────────────────────

vi.mock('../../../shared/data/client.js', () => ({
  collection: () => ({}), doc: () => ({}), getDoc: vi.fn(), getDocs: vi.fn(),
  setDoc: vi.fn(), addDoc: vi.fn(), updateDoc: vi.fn(), deleteDoc: vi.fn(),
  query: () => ({}), orderBy: () => ({}), onSnapshot: () => () => {},
  serverTimestamp: () => 'TS', writeBatch: () => ({}), runTransaction: vi.fn(),
  limit: () => ({}), increment: (n) => n, where: () => ({}),
}))
vi.mock('../../../shared/db', () => ({ db: {} }))

const { liveFields, withdrawnFields } = await import('../../ptw/lib/publicPermit')
const { MIRROR_FIELDS } = await import('../../../../stack/policy.mjs')

const EQUIPMENT_MIRROR_FIELDS = MIRROR_FIELDS.qr
const PERMIT_MIRROR_FIELDS = MIRROR_FIELDS.permitQr

/** The keys a builder produces, minus the ones the rule list already names. */
const unlisted = (produced, allowed) => produced.filter((k) => !allowed.includes(k))

describe('the permit mirror carries only keys the policy admits', () => {
  const permit = {
    typeOfWork: 'Hot work', jobLocation: 'Bay 3', jobDescription: 'Weld a bracket',
    issuingDepartment: 'Maintenance', issuedToName: 'R. Nair',
    hazards: ['sparks'], ppe: ['visor'], precautions: ['screens'],
    jsa: [{ step: 'set up' }],
    participants: [{ name: 'A' }, { name: 'B' }],
    fireWatchers: [{ name: 'C' }],
    confinedWatcher: { name: 'D' },
  }

  it('lists every field a LIVE permit publishes', () => {
    const missing = unlisted(Object.keys(liveFields(permit)), PERMIT_MIRROR_FIELDS)
    expect(missing, `add to MIRROR_FIELDS.permitQr in stack/policy.mjs: ${missing.join(', ')}`).toEqual([])
  })

  it('lists every field a WITHDRAWN permit publishes', () => {
    const missing = unlisted(Object.keys(withdrawnFields()), PERMIT_MIRROR_FIELDS)
    expect(missing, `add to MIRROR_FIELDS.permitQr in stack/policy.mjs: ${missing.join(', ')}`).toEqual([])
  })

  it('publishes crew as COUNTS, never as names', () => {
    // The S-07 fix, pinned from the policy side too: `participants` and
    // `fireWatchers` are exactly the retired keys that legacy mirrors still
    // carry, which is why an update may keep keys a mirror already has.
    const keys = Object.keys(liveFields(permit))
    expect(keys).toContain('participantCount')
    expect(keys).not.toContain('participants')
    expect(keys).not.toContain('fireWatchers')
    expect(PERMIT_MIRROR_FIELDS).not.toContain('participants')
  })
})

describe('the rule lists are internally sound', () => {
  it('name no key twice', () => {
    expect(new Set(EQUIPMENT_MIRROR_FIELDS).size).toBe(EQUIPMENT_MIRROR_FIELDS.length)
    expect(new Set(PERMIT_MIRROR_FIELDS).size).toBe(PERMIT_MIRROR_FIELDS.length)
  })

  it('carry the four keys every mirror needs to be findable at all', () => {
    // orgId gates the write, token identifies the sticker, updatedAt is written
    // by every builder. Losing any of them from the list bricks every mirror.
    for (const k of ['orgId', 'token', 'updatedAt']) {
      expect(EQUIPMENT_MIRROR_FIELDS).toContain(k)
      expect(PERMIT_MIRROR_FIELDS).toContain(k)
    }
    expect(PERMIT_MIRROR_FIELDS).toContain('permitId')
  })

  it('keep the two id fields the equipment binding reads', () => {
    // mirrorsItsAsset() looks these up to find the asset. Dropping either from
    // the allow-list would refuse every create with a message about shape.
    expect(EQUIPMENT_MIRROR_FIELDS).toContain('extId')
    expect(EQUIPMENT_MIRROR_FIELDS).toContain('assetRefId')
    expect(EQUIPMENT_MIRROR_FIELDS).toContain('assetKind')
  })
})
