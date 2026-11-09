import { describe, expect, it } from 'vitest'
import {
  CULT_OWNERSHIP_SITE_TYPES,
  LEGACY_ENTITY_LABELS,
  REGISTERED_ENTITY_NAMES,
  entityMatchKey,
  packSiteTypeByEntity,
  planSiteTypeBackfill,
} from './siteTypeBackfill.js'

const cult = CULT_OWNERSHIP_SITE_TYPES

function site(id, entity, facility = '') {
  return { id, name: id, entity, facility }
}

describe('entity match key', () => {
  it('treats case, spaces and punctuation as the same name, and nothing else', () => {
    expect(entityMatchKey('Marketplace')).toBe(entityMatchKey('Market Place'))
    expect(entityMatchKey('market-place')).toBe('marketplace')
    expect(entityMatchKey('D2C')).toBe(entityMatchKey('d2c'))
    expect(entityMatchKey('D 2 C')).toBe('d2c')
    expect(entityMatchKey('FOFO')).toBe(entityMatchKey('fofo'))
    expect(entityMatchKey('Acme COCO Ltd')).not.toBe(entityMatchKey('COCO'))
    expect(entityMatchKey('  ')).toBe('')
  })

  it('translates only the exact legacy equipment labels', () => {
    expect(entityMatchKey('1P')).toBe(entityMatchKey('COCO'))
    expect(entityMatchKey('2P')).toBe(entityMatchKey('FOFO'))
    expect(entityMatchKey('3P')).toBe(entityMatchKey('Marketplace'))
    expect(entityMatchKey('1p')).toBe('1p')
    expect(LEGACY_ENTITY_LABELS).toEqual({ '1P': 'COCO', '2P': 'FOFO', '3P': 'Marketplace' })
  })
})

describe('ownership-model backfill', () => {
  const sites = [
    site('coco', 'COCO'),
    site('fofo', 'fofo'),
    site('foco', 'FOCO'),
    site('market', 'Market Place'),
    site('ebo', 'EBO'),
    site('d2c', 'd2c'),
    site('typed', 'COCO', 'Office'),
    site('fitso', 'Fitso'),
    site('pilate', 'Pilate'),
    site('company', 'Acme Mfg Pvt Ltd'),
    site('blank', ''),
    site('spaces', '   '),
    site('legacy', '1P'),
    site('whitespace-type', 'EBO', '  '),
  ]

  it('maps the supplied ownership model and leaves a set type alone', () => {
    const plan = planSiteTypeBackfill(sites, cult)
    expect(plan.counts).toEqual({
      wouldUpdate: 8,
      alreadySet: 1,
      unmatched: 3,
      emptyEntity: 2,
    })
    const filled = Object.fromEntries(plan.updates.map((row) => [row.id, row.facility]))
    expect(filled).toEqual({
      coco: 'Indoor gym',
      fofo: 'Indoor gym',
      foco: 'Indoor gym',
      market: 'Indoor gym',
      ebo: 'Retail store',
      d2c: 'Warehouse',
      legacy: 'Indoor gym',
      'whitespace-type': 'Retail store',
    })
    expect(plan.updates.map((row) => row.id)).not.toContain('typed')
    expect(plan.unmatchedEntities.map((row) => row.entity).sort()).toEqual([
      'Acme Mfg Pvt Ltd',
      'Fitso',
      'Pilate',
    ])
  })

  it('is idempotent: a second run against the filled sites updates nothing', () => {
    const plan = planSiteTypeBackfill(sites, cult)
    const filled = sites.map((row) => {
      const update = plan.updates.find((item) => item.id === row.id)
      return update ? { ...row, facility: update.facility } : row
    })
    const again = planSiteTypeBackfill(filled, cult)
    expect(again.counts.wouldUpdate).toBe(0)
    expect(again.updates).toEqual([])
    expect(again.counts.alreadySet).toBe(plan.counts.alreadySet + plan.counts.wouldUpdate)
  })

  it('uses the organisation’s own map instead of the supplied default', () => {
    const plan = planSiteTypeBackfill(sites, [
      { entity: 'COCO', siteType: 'Office' },
      { entity: 'Fitso', siteType: 'indoor pool' },
    ])
    const filled = Object.fromEntries(plan.updates.map((row) => [row.id, row.facility]))
    expect(filled.coco).toBe('Office')
    expect(filled.legacy).toBe('Office')
    expect(filled.fitso).toBe('Indoor pool')
    expect(filled.market).toBeUndefined()
    expect(filled.d2c).toBeUndefined()
  })

  it('keeps a custom site type the organisation has configured', () => {
    const plan = planSiteTypeBackfill(
      [site('cold', 'D2C')],
      [{ entity: 'D2C', siteType: 'Cold store' }],
      ['Cold store']
    )
    expect(plan.updates[0].facility).toBe('Cold store')
  })

  it('collapses two rows that are the same name after matching', () => {
    const packed = packSiteTypeByEntity([
      { entity: 'Marketplace', siteType: 'Indoor gym' },
      { entity: 'Market Place', siteType: 'Warehouse' },
      { entity: '', siteType: 'Office' },
      { entity: 'EBO', siteType: '' },
    ])
    expect(packed.rows).toEqual([{ entity: 'Marketplace', siteType: 'Indoor gym' }])
    expect(packed.dropped).toEqual(['Market Place'])
    expect(packed.map).toEqual({ Marketplace: 'Indoor gym' })
  })

  it('names the registered entities the default does not cover', () => {
    const covered = new Set(cult.map((row) => entityMatchKey(row.entity)))
    expect(REGISTERED_ENTITY_NAMES.filter((name) => !covered.has(entityMatchKey(name)))).toEqual([
      'Fitso',
      'Pilate',
    ])
    expect(covered.has(entityMatchKey('D2C'))).toBe(true)
    expect(REGISTERED_ENTITY_NAMES).not.toContain('D2C')
  })
})
