import { describe, expect, it } from 'vitest'
import { planSiteBackfill } from './siteBackfill.js'

const SITES = [
  { id: 's1', name: 'Harbour Depot' },
  { id: 's2', name: 'Ridge Plant' },
  { id: 's3', name: 'Ridge Plant' },
]

describe('planSiteBackfill', () => {
  it('names the one site a record\'s text matches, trying fields in order', () => {
    const plan = planSiteBackfill(
      {
        mockDrills: [{ id: 'd1', centerName: 'Harbour Depot' }],
        permits: [{ id: 'p1', site: '', jobLocation: 'harbour depot' }],
      },
      SITES
    )
    expect(plan.writes).toEqual([
      { collection: 'mockDrills', id: 'd1', siteId: 's1', siteName: 'Harbour Depot' },
      { collection: 'permits', id: 'p1', siteId: 's1', siteName: 'Harbour Depot' },
    ])
  })

  // A wrong siteId would hide the record from its own site's people.
  it('never picks between two sites with the same name', () => {
    const plan = planSiteBackfill({ incidents: [{ id: 'i1', site: 'Ridge Plant' }] }, SITES)
    expect(plan.writes).toEqual([])
    expect(plan.ambiguous).toEqual([{ collection: 'incidents', id: 'i1', text: 'Ridge Plant' }])
  })

  it('leaves records that already name a site, and reports text that matches nothing', () => {
    const plan = planSiteBackfill(
      { incidents: [{ id: 'i2', siteId: 's1', site: 'Ridge Plant' }, { id: 'i3', location: 'Car park' }] },
      SITES
    )
    expect(plan.sited).toBe(1)
    expect(plan.unmatched).toEqual([{ collection: 'incidents', id: 'i3', text: 'Car park' }])
  })
})
