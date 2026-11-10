import { describe, it, expect } from 'vitest'
import { portalStats, scopeIds, pendingWork } from './portalStats'

const SITES = [
  { id: 's1', name: 'Cult Gym Ameerpet' },
  { id: 's2', name: 'Cult Gym Shaikpet' },
]

// Scoping is the part that can be silently wrong: a count that includes a site
// the viewer has no permission for is a leak, and one that drops a site they
// own is a wrong answer they will act on.
describe('scopeIds', () => {
  it('covers every visible site when nothing is filtered', () => {
    expect([...scopeIds(SITES, 'all')]).toEqual(['s1', 's2'])
  })

  it('narrows to one site', () => {
    expect([...scopeIds(SITES, 's2')]).toEqual(['s2'])
  })

  it('is empty when the id is not one the viewer can see', () => {
    expect(scopeIds(SITES, 'sX').size).toBe(0)
  })

  // A Region / Entity pick arrives as a list of ids. It must still be limited
  // to sites the viewer can see — a list is not a grant.
  it('narrows to a list of ids, dropping any the viewer cannot see', () => {
    expect([...scopeIds(SITES, ['s2', 'sX'])]).toEqual(['s2'])
  })
})

describe('portalStats counts', () => {
  const base = {
    sites: SITES,
    extinguishers: [
      { id: 'e1', siteId: 's1' },
      { id: 'e2', centerName: 'Cult Ameerpet' }, // resolves to s1 by normalisation
      { id: 'e3', siteId: 's2' },
      { id: 'e4', siteId: 's1', deletedAt: new Date() },
    ],
    aeds: [{ id: 'a1', siteId: 's1' }, { id: 'a2', siteId: 's2' }],
    fas: [{ id: 'f1', siteId: 's2' }],
  }

  it('counts every accessible site by default', () => {
    const s = portalStats(base)
    expect(s.counts).toMatchObject({ extinguishers: 3, aeds: 2, fas: 1 })
  })

  it('resolves an asset that only has a centre name', () => {
    expect(portalStats({ ...base, siteId: 's1' }).counts.extinguishers).toBe(2)
  })

  it('ignores soft-deleted assets', () => {
    // e4 is deleted, so s1 has e1 + e2 and not three.
    expect(portalStats({ ...base, siteId: 's1' }).counts.extinguishers).toBe(2)
  })

  it('counts nothing for a site outside the viewer’s access', () => {
    const s = portalStats({ ...base, siteId: 'sX' })
    expect(s.counts).toMatchObject({ extinguishers: 0, aeds: 0, fas: 0 })
  })
})

describe('portalStats compliance', () => {
  it('reports signage compliance as a percentage of what is recorded', () => {
    const s = portalStats({
      sites: SITES,
      signages: [
        { id: 'g1', siteId: 's1', status: 'Deployed' },
        { id: 'g2', siteId: 's1', status: 'Planned' },
        { id: 'g3', siteId: 's1', status: 'Removed' },
        { id: 'g4', siteId: 's1', status: 'deployed', condition: 'Missing' }, // case is not a finding; old condition ignored
      ],
    })
    expect(s.signageCompliance).toBe(50)
    expect(s.signageTotal).toBe(4)
  })

  it('returns null rather than zero when there is nothing to measure', () => {
    // "No signage recorded" and "all signage failing" are opposite situations
    // and must not render as the same number.
    const s = portalStats({ sites: SITES })
    expect(s.signageCompliance).toBeNull()
    expect(s.trainingCompliance).toBeNull()
  })

  it('scopes training through the employee’s own site', () => {
    const s = portalStats({
      sites: SITES,
      users: [{ uid: 'u1', siteId: 's1' }, { uid: 'u2', siteId: 's2' }],
      assignments: [
        { employeeUid: 'u1', status: 'completed' },
        { employeeUid: 'u1', status: 'assigned' },
        { employeeUid: 'u2', status: 'assigned' },
      ],
      siteId: 's1',
    })
    expect(s.trainingCompliance).toBe(50)
  })

  it('excludes cancelled assignments from the denominator', () => {
    const s = portalStats({
      sites: SITES,
      users: [{ uid: 'u1', siteId: 's1' }],
      assignments: [
        { employeeUid: 'u1', status: 'completed' },
        { employeeUid: 'u1', status: 'cancelled' },
      ],
    })
    expect(s.trainingCompliance).toBe(100)
  })

  it('reports nothing to a viewer with no sites at all', () => {
    // The "nobody has a siteId yet" fallback must not answer a question about
    // the whole org to someone entitled to none of it.
    const s = portalStats({
      sites: [],
      users: [{ uid: 'u1' }],
      assignments: [{ employeeUid: 'u1', status: 'completed' }],
    })
    expect(s.trainingCompliance).toBeNull()
    expect(s.trainingTotal).toBe(0)
  })

  it('falls back to everyone when no employee has a site yet', () => {
    // Scoping by person would otherwise report 0% for an org that simply has
    // not filled in siteId.
    const s = portalStats({
      sites: SITES,
      users: [{ uid: 'u1' }],
      assignments: [{ employeeUid: 'u1', status: 'completed' }],
    })
    expect(s.trainingCompliance).toBe(100)
  })
})

// This answers "what is about to slip, and whose is it" — deliberately not
// filtered to the signed-in person, which "My actions" already covers.
describe('pendingWork', () => {
  const TODAY = '2026-07-30'
  const users = [
    { uid: 'u1', name: 'Ravi Kumar', siteId: 's1' },
    { uid: 'u2', name: 'Priya Menon', siteId: 's2' },
  ]
  const actions = [
    { key: 'a1', title: 'Re-mark dock lines', owner: 'Ravi Kumar', due: '2026-06-01', norm: 'open', siteId: 's1', sourceLabel: 'Incident' },
    { key: 'a2', title: 'Toolbox talk', owner: { name: 'Priya Menon' }, due: '2026-09-01', norm: 'in_progress', siteId: 's2', sourceLabel: 'Inspection' },
    { key: 'a3', title: 'Already done', owner: 'Ravi Kumar', due: '2026-08-01', norm: 'done', siteId: 's1', sourceLabel: 'Incident' },
    { key: 'a4', title: 'No date', owner: '', due: '', norm: 'open', siteId: 's1', sourceLabel: 'Audit' },
  ]

  it('leaves out site-less work when the view is narrowed to a list of sites', () => {
    const loose = [...actions, { key: 'a5', title: 'Nowhere', owner: '', due: '', norm: 'open', sourceLabel: 'Audit' }]
    expect(pendingWork({ sites: SITES, actions: loose, users, today: TODAY }).actions.map((a) => a.key)).toContain('a5')
    const narrowed = pendingWork({ sites: SITES, siteId: ['s1', 's2'], actions: loose, users, today: TODAY })
    expect(narrowed.actions.map((a) => a.key)).not.toContain('a5')
  })

  it('excludes finished work', () => {
    const r = pendingWork({ sites: SITES, actions, users, today: TODAY })
    expect(r.actions.map((a) => a.key)).not.toContain('a3')
  })

  it('puts overdue first, then soonest due, then undated', () => {
    // An empty due date sorts ahead of every real one as a string, so the naive
    // comparison would bury the genuinely urgent items.
    const r = pendingWork({ sites: SITES, actions, users, today: TODAY })
    expect(r.actions.map((a) => a.key)).toEqual(['a1', 'a2', 'a4'])
    expect(r.actions[0].overdue).toBe(true)
  })

  it('names the owner whether it is a string or an object', () => {
    const r = pendingWork({ sites: SITES, actions, users, today: TODAY })
    expect(r.actions[0].owner).toBe('Ravi Kumar')
    expect(r.actions[1].owner).toBe('Priya Menon')
  })

  it('labels unowned work rather than leaving it blank', () => {
    const r = pendingWork({ sites: SITES, actions, users, today: TODAY })
    expect(r.actions.find((a) => a.key === 'a4').owner).toBe('Unassigned')
  })

  it('caps the list at the limit', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      key: `k${i}`, title: `t${i}`, owner: 'Ravi Kumar', due: `2026-08-0${i + 1}`, norm: 'open', siteId: 's1',
    }))
    expect(pendingWork({ sites: SITES, actions: many, users, today: TODAY }).actions).toHaveLength(5)
  })

  it('narrows to the filtered site', () => {
    const r = pendingWork({ sites: SITES, siteId: 's2', actions, users, today: TODAY })
    expect(r.actions.map((a) => a.key)).toEqual(['a2'])
  })

  it('hides site-less actions once a site is chosen', () => {
    // Without a site of its own it might belong anywhere, so a site filter must
    // not imply it belongs to the chosen one.
    const loose = [{ key: 'x', title: 'Loose', owner: 'Ravi Kumar', due: '2026-08-01', norm: 'open' }]
    expect(pendingWork({ sites: SITES, actions: loose, users, today: TODAY }).actions).toHaveLength(1)
    expect(pendingWork({ sites: SITES, siteId: 's1', actions: loose, users, today: TODAY }).actions).toHaveLength(0)
  })

  it('lists pending training with the person it is assigned to', () => {
    const assignments = [
      { id: 'as1', courseName: 'Working at Height', employeeUid: 'u1', employeeName: 'Ravi Kumar', dueDate: '2026-06-15', status: 'assigned' },
      { id: 'as2', courseName: 'Manual Handling', employeeUid: 'u2', employeeName: 'Priya Menon', dueDate: '2026-09-20', status: 'assigned' },
      { id: 'as3', courseName: 'Done one', employeeUid: 'u1', status: 'completed' },
      { id: 'as4', courseName: 'Dropped', employeeUid: 'u1', status: 'cancelled' },
    ]
    const r = pendingWork({ sites: SITES, actions: [], assignments, users, today: TODAY })
    expect(r.training.map((t) => t.key)).toEqual(['as1', 'as2'])
    expect(r.training[0]).toMatchObject({ owner: 'Ravi Kumar', overdue: true })
  })

  it('scopes training through the employee’s site', () => {
    const assignments = [
      { id: 'as1', courseName: 'A', employeeUid: 'u1', dueDate: '2026-08-01', status: 'assigned' },
      { id: 'as2', courseName: 'B', employeeUid: 'u2', dueDate: '2026-08-01', status: 'assigned' },
    ]
    const r = pendingWork({ sites: SITES, siteId: 's1', actions: [], assignments, users, today: TODAY })
    expect(r.training.map((t) => t.key)).toEqual(['as1'])
  })

  it('shows nothing to a viewer with no sites', () => {
    const r = pendingWork({
      sites: [], actions, users,
      assignments: [{ id: 'as1', employeeUid: 'u1', status: 'assigned' }],
      today: TODAY,
    })
    expect(r.actions).toEqual([])
    expect(r.training).toEqual([])
  })
})

describe('portalStats charts', () => {
  it('counts incidents by type, commonest first', () => {
    const s = portalStats({
      sites: SITES,
      incidents: [
        { siteId: 's1', type: 'near_miss' },
        { siteId: 's1', type: 'near_miss' },
        { siteId: 's2', type: 'first_aid' },
      ],
    })
    expect(s.incidentsByType[0]).toEqual({ key: 'near_miss', value: 2 })
    expect(s.counts.incidents).toBe(3)
  })

  it('matches a legacy incident by site name when it has no siteId', () => {
    const s = portalStats({
      sites: SITES,
      incidents: [{ location: 'Near the gate, Cult Gym Shaikpet', type: 'near_miss' }],
      siteId: 's2',
    })
    expect(s.counts.incidents).toBe(1)
  })

  it('ranks sites by equipment and drops the empty ones', () => {
    const s = portalStats({
      sites: SITES,
      extinguishers: [{ id: 'e1', siteId: 's2' }, { id: 'e2', siteId: 's2' }],
      aeds: [{ id: 'a1', siteId: 's2' }],
    })
    expect(s.equipmentBySite).toHaveLength(1)
    expect(s.equipmentBySite[0]).toMatchObject({ name: 'Cult Gym Shaikpet', total: 3 })
  })
})
