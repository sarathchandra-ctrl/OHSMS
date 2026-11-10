import { describe, it, expect } from 'vitest'
import { isBehindBaseline, baselineFor } from './data'

const baseline = (over = {}) => ({ id: 'b1', kind: 'baseline', revision: 3, title: 'Fire evacuation', ...over })
const sitePlan = (over = {}) => ({
  id: 's1', kind: 'site', siteId: 'site1', baselineId: 'b1', baselineRevision: 3, ...over,
})

describe('baselineFor', () => {
  it('finds the baseline a site plan came from', () => {
    expect(baselineFor(sitePlan(), [baseline()]).id).toBe('b1')
  })

  it('returns null when the baseline was deleted', () => {
    expect(baselineFor(sitePlan(), [])).toBeNull()
  })
})

describe('isBehindBaseline', () => {
  it('is false when the site copy matches the baseline revision', () => {
    expect(isBehindBaseline(sitePlan(), [baseline()])).toBe(false)
  })

  it('is true once the baseline has been revised', () => {
    expect(isBehindBaseline(sitePlan({ baselineRevision: 2 }), [baseline({ revision: 3 })])).toBe(true)
  })

  it('treats a plan recalled before revisions existed as behind', () => {
    // Plans copied by the earlier version carry no baselineRevision at all.
    expect(isBehindBaseline(sitePlan({ baselineRevision: undefined }), [baseline({ revision: 1 })])).toBe(true)
  })

  it('is false for an un-revised baseline and an old copy — nothing to pull', () => {
    expect(isBehindBaseline(sitePlan({ baselineRevision: undefined }), [baseline({ revision: 0 })])).toBe(false)
  })

  it('is false for a baseline plan itself', () => {
    expect(isBehindBaseline(baseline(), [baseline({ revision: 9 })])).toBe(false)
  })

  it('is false for a site plan written from scratch, with no baseline link', () => {
    expect(isBehindBaseline(sitePlan({ baselineId: '' }), [baseline({ revision: 9 })])).toBe(false)
  })

  it('is false when the baseline no longer exists', () => {
    // A deleted baseline must not make every site plan look stale forever.
    expect(isBehindBaseline(sitePlan({ baselineRevision: 1 }), [])).toBe(false)
  })

  it('never reports behind when the site copy is somehow ahead', () => {
    expect(isBehindBaseline(sitePlan({ baselineRevision: 5 }), [baseline({ revision: 3 })])).toBe(false)
  })

  it('tolerates revisions stored as strings', () => {
    expect(isBehindBaseline(sitePlan({ baselineRevision: '2' }), [baseline({ revision: '4' })])).toBe(true)
  })
})
