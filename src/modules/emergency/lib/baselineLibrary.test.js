import { describe, it, expect } from 'vitest'
import { BASELINE_LIBRARY, BASELINE_SCENARIO_COUNT } from './baselineLibrary'
import { baselinePlanFrom, planLibraryDiff } from './data'
import { RESCUE_SCENARIOS } from './data'
import { ERP_ROLE_KEYS, ALL_EMPLOYEES } from '../../../shared/org/erpRoles'

describe('BASELINE_LIBRARY', () => {
  it('ships a usable set of procedures', () => {
    expect(BASELINE_LIBRARY.length).toBe(BASELINE_SCENARIO_COUNT)
    expect(BASELINE_LIBRARY.length).toBeGreaterThanOrEqual(15)
  })

  it('gives every entry a scenario, title and steps', () => {
    for (const e of BASELINE_LIBRARY) {
      expect(e.scenario, JSON.stringify(e).slice(0, 80)).toBeTruthy()
      expect(e.title).toBeTruthy()
      expect(e.steps.length).toBeGreaterThan(0)
    }
  })

  it('has no duplicate scenarios — one baseline per scenario', () => {
    const seen = BASELINE_LIBRARY.map((e) => e.scenario)
    expect(new Set(seen).size).toBe(seen.length)
  })

  it('only uses scenarios the app offers', () => {
    for (const e of BASELINE_LIBRARY) {
      expect(RESCUE_SCENARIOS, e.scenario).toContain(e.scenario)
    }
  })

  it('assigns every step a known role, so a recalled plan resolves to real people', () => {
    const valid = new Set([...ERP_ROLE_KEYS, ALL_EMPLOYEES])
    for (const e of BASELINE_LIBRARY) {
      for (const s of e.steps) {
        expect(valid.has(s.responsible), `${e.scenario}: "${s.responsible}"`).toBe(true)
      }
    }
  })

  it('carries no organization-specific vocabulary', () => {
    const blob = JSON.stringify(BASELINE_LIBRARY)
    for (const term of ['Amazon', 'HYD3', 'Konexus', 'Lenel', 'RightCrowd', 'Centre Manager']) {
      expect(blob, term).not.toContain(term)
    }
  })

  it('names no country-specific helpline in step text', () => {
    // 112/999/911 differ by country; the site's own contacts carry real numbers.
    const blob = JSON.stringify(BASELINE_LIBRARY)
    for (const n of ['101/112', '102/108', '100/112']) {
      expect(blob, n).not.toContain(n)
    }
  })
})

describe('planLibraryDiff', () => {
  const lib = [
    { scenario: 'Fire / Explosion', title: 'Fire', steps: [{ action: 'a', responsible: 'CM' }] },
    { scenario: 'Medical Emergency', title: 'Medical', steps: [{ action: 'b', responsible: 'CM' }] },
  ]

  it('adds everything to an organization with no baselines yet', () => {
    const d = planLibraryDiff(lib, [], false)
    expect(d.toAdd).toHaveLength(2)
    expect(d.toUpdate).toHaveLength(0)
  })

  it('handles a null existing list', () => {
    expect(planLibraryDiff(lib, null, false).toAdd).toHaveLength(2)
  })

  it('adds only what is missing, leaving existing scenarios alone', () => {
    const d = planLibraryDiff(lib, [{ scenario: 'Fire / Explosion', id: 'x' }], false)
    expect(d.toAdd.map((e) => e.scenario)).toEqual(['Medical Emergency'])
    expect(d.toUpdate).toHaveLength(0)
  })

  it('never duplicates a scenario, so re-running is safe', () => {
    const existing = lib.map((e, i) => ({ scenario: e.scenario, id: `p${i}` }))
    const d = planLibraryDiff(lib, existing, false)
    expect(d.toAdd).toHaveLength(0)
    expect(d.toUpdate).toHaveLength(0)
  })

  it('only overwrites when replace is explicitly requested', () => {
    const existing = [{ scenario: 'Fire / Explosion', id: 'x', revision: 4 }]
    expect(planLibraryDiff(lib, existing, false).toUpdate).toHaveLength(0)
    const d = planLibraryDiff(lib, existing, true)
    expect(d.toUpdate.map((e) => e.scenario)).toEqual(['Fire / Explosion'])
    expect(d.toAdd.map((e) => e.scenario)).toEqual(['Medical Emergency'])
  })

  it('exposes the existing plan so a replace can bump its revision', () => {
    const d = planLibraryDiff(lib, [{ scenario: 'Fire / Explosion', id: 'x', revision: 4 }], true)
    expect(d.byScenario.get('Fire / Explosion').revision).toBe(4)
  })

  it('installs the real library cleanly into an empty organization', () => {
    const d = planLibraryDiff(BASELINE_LIBRARY, [], false)
    expect(d.toAdd).toHaveLength(BASELINE_LIBRARY.length)
  })
})

describe('baselinePlanFrom', () => {
  const built = baselinePlanFrom(BASELINE_LIBRARY[0])

  it('produces a baseline plan, not a site plan', () => {
    expect(built.kind).toBe('baseline')
    expect(built.siteId).toBe('')
  })

  it('numbers the steps in order', () => {
    expect(built.steps.map((s) => s.order)).toEqual(built.steps.map((_, i) => i + 1))
  })

  it('starts at revision 1 so later edits register as newer', () => {
    expect(built.revision).toBe(1)
  })

  it('creates unnamed team slots for the roles, filled in on recall', () => {
    for (const t of built.team) {
      expect(t.role).toBeTruthy()
      expect(t.name).toBe('')
    }
  })

  it('sets a review date a year out', () => {
    expect(built.nextReviewOn > built.reviewedOn).toBe(true)
  })
})
