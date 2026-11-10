import { describe, it, expect } from 'vitest'
import {
  resolveAccessibleSites,
  regionsOf,
  entitiesOf,
  accessSummary,
  grantedModuleKeys,
  canUseModule,
  personalModuleMap,
  sitesInSelection,
  accessDetail,
  shortList,
} from './access'

const sites = [
  { id: 's1', name: 'North Plant', region: 'North', entity: 'Acme Mfg' },
  { id: 's2', name: 'North Depot', region: 'North', entity: 'Acme Logistics' },
  { id: 's3', name: 'South Whse', region: 'South', entity: 'Acme Mfg' },
]
const ids = (arr) => arr.map((s) => s.id).sort()

describe('resolveAccessibleSites — site/region/entity scoping', () => {
  it('site-only grants access to just that site', () => {
    const u = { role: 'member', access: { sites: ['s1'], regions: [], entities: [] } }
    expect(ids(resolveAccessibleSites(u, sites))).toEqual(['s1'])
  })

  it('region-only grants every site in the region', () => {
    const u = { role: 'member', access: { sites: [], regions: ['North'], entities: [] } }
    expect(ids(resolveAccessibleSites(u, sites))).toEqual(['s1', 's2'])
  })

  it('entity-only grants every site in the entity', () => {
    const u = { role: 'member', access: { sites: [], regions: [], entities: ['Acme Mfg'] } }
    expect(ids(resolveAccessibleSites(u, sites))).toEqual(['s1', 's3'])
  })

  it('multiple selections apply as a union', () => {
    const u = { role: 'member', access: { sites: ['s2'], regions: ['South'], entities: [] } }
    expect(ids(resolveAccessibleSites(u, sites))).toEqual(['s2', 's3'])
  })

  it('admins access every site regardless of grant', () => {
    const u = { role: 'admin', access: {} }
    expect(resolveAccessibleSites(u, sites)).toHaveLength(3)
  })

  it('no grant → no sites', () => {
    const u = { role: 'member', access: { sites: [], regions: [], entities: [] } }
    expect(resolveAccessibleSites(u, sites)).toHaveLength(0)
  })

  // Their own posting counts. Before this, a member mapped to a site resolved
  // to nothing and saw an empty portal — no counts, no pending work, nothing
  // about the place they stand in every day.
  it('a member reaches their own posting without any grant', () => {
    const u = { role: 'member', siteId: 's3', access: {} }
    expect(ids(resolveAccessibleSites(u, sites))).toEqual(['s3'])
  })

  it('their posting unions with whatever they were granted', () => {
    const u = { role: 'member', siteId: 's1', access: { sites: ['s2'], regions: [], entities: [] } }
    expect(ids(resolveAccessibleSites(u, sites))).toEqual(['s1', 's2'])
  })

  it('a posting that is not a real site grants nothing', () => {
    const u = { role: 'member', siteId: 'deleted-site', access: {} }
    expect(resolveAccessibleSites(u, sites)).toHaveLength(0)
  })

  it('no grant and no posting → still no sites', () => {
    const u = { role: 'member', access: { sites: [], regions: [], entities: [] } }
    expect(resolveAccessibleSites(u, sites)).toHaveLength(0)
  })

  it('dropdown option builders return distinct sorted values', () => {
    expect(regionsOf(sites)).toEqual(['North', 'South'])
    expect(entitiesOf(sites)).toEqual(['Acme Logistics', 'Acme Mfg'])
  })

  it('accessSummary describes the scope', () => {
    expect(accessSummary({ sites: ['s1'], regions: [], entities: [] }, sites)).toMatch(/1 site/)
    expect(accessSummary({ sites: [], regions: ['North'], entities: [] })).toMatch(/1 region/)
    expect(accessSummary({ sites: [], regions: [], entities: [] })).toBe('No access')
  })
})

describe('module permissions', () => {
  const map = { incidents: true, hira: true, loto: false }

  it('gives admins, managers and auditors every module the organization has', () => {
    for (const role of ['admin', 'manager', 'auditor']) {
      const u = { role, access: { modules: ['incidents'] } }
      expect(grantedModuleKeys(u)).toBe(null)
      expect(personalModuleMap(map, u)).toBe(map)
    }
  })

  it('limits an employee to the granted modules', () => {
    const u = { role: 'member', access: { modules: ['hira'] } }
    expect(canUseModule(u, 'hira')).toBe(true)
    expect(canUseModule(u, 'incidents')).toBe(false)
    expect(personalModuleMap(map, u)).toEqual({ incidents: false, hira: true, loto: false })
  })

  it('never grants a module the organization switched off', () => {
    const u = { role: 'member', access: { modules: ['loto'] } }
    expect(personalModuleMap(map, u).loto).toBe(false)
  })

  it('reads a missing list as every module, and an empty list as none', () => {
    expect(personalModuleMap(map, { role: 'member', access: {} })).toBe(map)
    expect(personalModuleMap(map, { role: 'member', access: { modules: [] } })).toEqual({
      incidents: false,
      hira: false,
      loto: false,
    })
  })

  it('treats an unknown role as an employee, not as a manager', () => {
    expect(canUseModule({ role: 'owner', access: { modules: [] } }, 'hira')).toBe(false)
  })
})

describe('sitesInSelection', () => {
  const list = [
    { id: 'a', region: 'North', entity: 'E1' },
    { id: 'b', region: 'North', entity: 'E2' },
    { id: 'c', region: 'South', entity: 'E1' },
  ]
  const ids = (sel) => sitesInSelection(list, sel).map((s) => s.id)

  it('returns everything when every field is All', () => {
    expect(ids({})).toEqual(['a', 'b', 'c'])
    expect(ids({ region: 'all', entity: 'all', siteId: 'all' })).toEqual(['a', 'b', 'c'])
  })

  it('narrows by region, entity and site together', () => {
    expect(ids({ region: 'North' })).toEqual(['a', 'b'])
    expect(ids({ entity: 'E1' })).toEqual(['a', 'c'])
    expect(ids({ region: 'North', entity: 'E1' })).toEqual(['a'])
    expect(ids({ region: 'South', siteId: 'a' })).toEqual([])
  })
})

describe('accessDetail / shortList', () => {
  const inventory = [
    { id: 's1', name: 'Valley Works' },
    { id: 's2', name: 'Harbour Depot' },
  ]

  it('names the regions, entities and sites of a scope, sorted', () => {
    expect(
      accessDetail({ regions: ['South', 'North'], entities: ['E1'], sites: ['s1', 's2'] }, inventory)
    ).toEqual({ regions: ['North', 'South'], entities: ['E1'], sites: ['Harbour Depot', 'Valley Works'] })
  })

  it('keeps a site that left the inventory visible by its id', () => {
    expect(accessDetail({ sites: ['gone'] }, inventory).sites).toEqual(['gone'])
  })

  it('is empty for no scope', () => {
    expect(accessDetail(undefined)).toEqual({ regions: [], entities: [], sites: [] })
  })

  it('caps a long list', () => {
    expect(shortList(['a', 'b'])).toBe('a, b')
    expect(shortList(['a', 'b', 'c', 'd', 'e'])).toBe('a, b, c +2 more')
  })
})
