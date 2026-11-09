import { describe, it, expect, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  found: [],
  addContact: vi.fn(async () => 'new-id'),
  updateContact: vi.fn(async () => {}),
  deleteContact: vi.fn(async () => {}),
  findNearestServices: vi.fn(async () => mocks.found),
}))

vi.mock('./firestore', () => ({
  addContact: mocks.addContact,
  updateContact: mocks.updateContact,
  deleteContact: mocks.deleteContact,
}))

vi.mock('./nearby', () => ({
  findNearestServices: mocks.findNearestServices,
}))

import {
  autofillSite,
  contactOrigin,
  isGenericHelpline,
  needsRealNumber,
  planAutofill,
  planContactWrite,
  siteNeedsRecompute,
  siteNeedsRefresh,
} from './autofill'

describe('isGenericHelpline', () => {
  it('recognises the national emergency lines', () => {
    for (const n of ['112', '100', '101', '102', '108', '999', '911']) {
      expect(isGenericHelpline(n)).toBe(true)
    }
  })

  it('ignores spacing and punctuation around them', () => {
    expect(isGenericHelpline(' 112 ')).toBe(true)
    expect(isGenericHelpline('+112')).toBe(true)
  })

  it('treats a real direct line as specific', () => {
    expect(isGenericHelpline('+44 113 254 0000')).toBe(false)
    expect(isGenericHelpline('0113 254 0000')).toBe(false)
  })

  it('is false for blanks', () => {
    expect(isGenericHelpline('')).toBe(false)
    expect(isGenericHelpline(null)).toBe(false)
    expect(isGenericHelpline(undefined)).toBe(false)
  })

  it('does not match a number that merely contains a helpline', () => {
    expect(isGenericHelpline('01126543210')).toBe(false)
  })
})

describe('needsRealNumber', () => {
  it('flags a blank number', () => {
    expect(needsRealNumber({ phone: '' })).toBe(true)
    expect(needsRealNumber({ phone: '   ' })).toBe(true)
    expect(needsRealNumber({})).toBe(true)
  })

  it('flags a helpline stored as a service line', () => {
    expect(needsRealNumber({ name: 'Nuffield Hospital', phone: '112' })).toBe(true)
  })

  it('accepts a genuine direct line', () => {
    expect(needsRealNumber({ name: 'Nuffield Hospital', phone: '0113 388 2000' })).toBe(false)
  })
})

describe('siteNeedsRefresh', () => {
  const site = { id: 's1' }

  it('is true when the site has no external contacts', () => {
    expect(siteNeedsRefresh(site, [])).toBe(true)
  })

  it('ignores internal contacts when deciding', () => {
    const contacts = [{ kind: 'internal', siteId: 's1', phone: '0113 111 2222' }]
    expect(siteNeedsRefresh(site, contacts)).toBe(true)
  })

  it('ignores contacts belonging to other sites', () => {
    const contacts = [{ kind: 'external', siteId: 's2', phone: '0113 111 2222' }]
    expect(siteNeedsRefresh(site, contacts)).toBe(true)
  })

  it('is true when any external contact carries a helpline', () => {
    const contacts = [
      { kind: 'external', siteId: 's1', phone: '0113 111 2222' },
      { kind: 'external', siteId: 's1', phone: '112' },
    ]
    expect(siteNeedsRefresh(site, contacts)).toBe(true)
  })

  it('is false once every external contact has a direct line', () => {
    const contacts = [
      { kind: 'external', siteId: 's1', phone: '0113 111 2222' },
      { kind: 'external', siteId: 's1', phone: '0117 926 1326' },
    ]
    expect(siteNeedsRefresh(site, contacts)).toBe(false)
  })
})

const site = { id: 's1', name: 'Manyata', region: 'South', entity: 'Acme' }
const legacyNote = 'Nearest hospital (~3.5 km) via OpenStreetMap'

describe('contactOrigin', () => {
  it('recognises a row the previous lookup wrote, by its note', () => {
    expect(
      contactOrigin({
        notes: `${legacyNote} · no published number within 30 km — confirm it locally`,
      })
    ).toBe('map')
  })

  it('treats a hand-written note as manual', () => {
    expect(contactOrigin({ notes: 'Ask for the duty officer', phone: '08011112222' })).toBe(
      'manual'
    )
  })

  it('lets an explicit manual origin win over a leftover lookup note', () => {
    expect(contactOrigin({ origin: 'manual', notes: legacyNote })).toBe('manual')
  })
})

describe('planAutofill', () => {
  const found = [
    {
      role: 'Hospital',
      name: 'J M J Hospital',
      phone: '',
      address: 'Hebbal Road, Bengaluru',
      distanceKm: 0.7,
      source: 'overpass',
    },
  ]

  it('does not overwrite a contact a person entered', () => {
    const existing = [
      {
        id: 'hand',
        kind: 'external',
        siteId: 's1',
        role: 'Hospital',
        name: 'Our Hospital',
        phone: '08011112222',
        notes: 'gate 2',
      },
    ]
    const plan = planAutofill(site, existing, found)
    expect(plan.skipped).toBe(1)
    expect(plan.actions[0].action).toBe('skip')
    expect(plan.actions[0].payload).toBeNull()
  })

  it('replaces a legacy mapped row with the nearest facility, phone blank when none is published', () => {
    const existing = [
      {
        id: 'old',
        role: 'Hospital',
        name: 'Baptist Hospital',
        phone: '08022024700',
        notes: legacyNote,
      },
    ]
    const plan = planAutofill(site, existing, found)
    expect(plan.actions[0]).toMatchObject({ action: 'update', id: 'old' })
    expect(plan.actions[0].payload).toMatchObject({
      name: 'J M J Hospital',
      phone: '',
      address: 'Hebbal Road, Bengaluru',
      distanceKm: 0.7,
      origin: 'map',
      siteId: 's1',
    })
    expect(plan.actions[0].payload.notes).toContain('0.7 km')
    expect(plan.actions[0].payload.notes).not.toContain('closest is')
  })

  it('retires a mapped duplicate when a manual contact already owns the role', () => {
    expect(
      planContactWrite([
        { id: 'hand', origin: 'manual' },
        { id: 'old', notes: 'Nearest police (~6.1 km) via OpenStreetMap' },
      ])
    ).toEqual({ action: 'skip', id: null, retireIds: ['old'] })
  })

  it('overwrites a manual contact only when asked', () => {
    const decision = planContactWrite([{ id: 'hand', origin: 'manual' }], { replaceManual: true })
    expect(decision).toEqual({ action: 'update', id: 'hand', retireIds: [] })
  })
})

describe('siteNeedsRecompute', () => {
  it('is false when hospital, police and fire were all entered by hand', () => {
    const contacts = ['Hospital', 'Police', 'Fire Brigade'].map((role, i) => ({
      id: String(i),
      kind: 'external',
      siteId: 's1',
      role,
      phone: '08011112222',
      notes: 'local',
    }))
    expect(siteNeedsRecompute(site, contacts)).toBe(false)
  })

  it('is true when a previous lookup still owns the hospital', () => {
    const contacts = [
      {
        id: 'h',
        kind: 'external',
        siteId: 's1',
        role: 'Hospital',
        notes: legacyNote,
        phone: '08022024700',
      },
      {
        id: 'p',
        kind: 'external',
        siteId: 's1',
        role: 'Police',
        origin: 'manual',
        phone: '08011112222',
      },
      {
        id: 'f',
        kind: 'external',
        siteId: 's1',
        role: 'Fire Brigade',
        origin: 'manual',
        phone: '08011113333',
      },
    ]
    expect(siteNeedsRecompute(site, contacts)).toBe(true)
  })
})

describe('autofillSite', () => {
  it('writes the nearest mapped hospital and deletes the stale mapped duplicate, leaving a manual police row', async () => {
    mocks.addContact.mockClear()
    mocks.updateContact.mockClear()
    mocks.deleteContact.mockClear()
    mocks.found = [
      {
        role: 'Hospital',
        name: 'J M J Hospital',
        phone: '',
        address: 'Hebbal',
        distanceKm: 0.7,
        source: 'overpass',
      },
      {
        role: 'Police',
        name: 'Amrutahalli Police Station',
        phone: '',
        address: '',
        distanceKm: 2.7,
        source: 'overpass',
      },
    ]
    const contacts = [
      {
        id: 'old',
        kind: 'external',
        siteId: 's1',
        role: 'Hospital',
        name: 'Baptist Hospital',
        notes: legacyNote,
        phone: '08022024700',
      },
      {
        id: 'dup',
        kind: 'external',
        siteId: 's1',
        role: 'Hospital',
        name: 'Other Hospital',
        notes: legacyNote,
        phone: '',
      },
      {
        id: 'hand',
        kind: 'external',
        siteId: 's1',
        role: 'Police',
        name: 'Our Station',
        origin: 'manual',
        phone: '08099998888',
        notes: 'gate',
      },
    ]
    const result = await autofillSite(site, contacts, { uid: 'u' })
    expect(result.updated).toBe(1)
    expect(result.skipped).toBe(1)
    expect(result.added).toBe(0)
    expect(mocks.updateContact).toHaveBeenCalledTimes(1)
    expect(mocks.updateContact.mock.calls[0][1]).toBe('old')
    expect(mocks.updateContact.mock.calls[0][2].name).toBe('J M J Hospital')
    expect(mocks.deleteContact).toHaveBeenCalledWith(
      'org',
      'dup',
      { uid: 'u' },
      expect.stringContaining('Hospital')
    )
    expect(mocks.updateContact.mock.calls.some((c) => c[1] === 'hand')).toBe(false)
  })
})
