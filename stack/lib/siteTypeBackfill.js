// Fill an empty site type from the site's entity, once, from a map the
// organisation edits.
//
// site.entity is free text. The site form does not constrain it. The
// equipment module does: src/modules/fire/lib/constants.js ENTITIES is
// COCO, FOCO, FOFO, Marketplace, Fitso, EBO, Pilate. Those seven are
// REGISTERED_ENTITY_NAMES below. D2C is not one of them. It is still a row
// in the supplied default, because a site can store it anyway. Fitso and
// Pilate are registered and are not in that default, so they stay unmatched
// until an admin adds a row.
//
// Equipment upload still accepts 1P, 2P and 3P and rewrites them with
// normalizeEntity before the asset is stored. Linking the asset then copies
// the site's own entity, which is the exact one. A site whose entity field
// is still one of those exact labels is translated the same way here, so a
// leftover "1P" follows the COCO row. The translation is the approximate one
// documented on LEGACY_ENTITIES: 1P is usually COCO but sometimes FOFO, and
// 2P spans FOFO and FOCO. Only the exact labels are translated, same as
// normalizeEntity — "1p" is not "1P".
//
// The match is the whole entity string. Case, spaces and punctuation are
// ignored, so "Market Place", "Marketplace" and "market-place" are one name,
// and "D2C" matches "d2c". A longer name that merely contains a code
// ("Acme COCO Ltd") does not match COCO.
//
// Only a site with no site type is eligible. Running it again updates
// nothing. The supplied default is a list an admin loads; it is not applied
// to every organisation on its own.

import { canonicalFacility } from './weatherPrecautions.js'

// Kept in step with ENTITIES and LEGACY_ENTITIES. The SPA test compares them.
export const REGISTERED_ENTITY_NAMES = [
  'COCO',
  'FOCO',
  'FOFO',
  'Marketplace',
  'Fitso',
  'EBO',
  'Pilate',
]

export const LEGACY_ENTITY_LABELS = { '1P': 'COCO', '2P': 'FOFO', '3P': 'Marketplace' }

// Ownership model for sites recorded under these names. Indoor gyms for the
// franchise and marketplace formats, a shop for EBO, a warehouse for D2C.
export const CULT_OWNERSHIP_SITE_TYPES = [
  { entity: 'FOFO', siteType: 'Indoor gym' },
  { entity: 'FOCO', siteType: 'Indoor gym' },
  { entity: 'COCO', siteType: 'Indoor gym' },
  { entity: 'Marketplace', siteType: 'Indoor gym' },
  { entity: 'EBO', siteType: 'Retail store' },
  { entity: 'D2C', siteType: 'Warehouse' },
]

const MAX_ENTITY = 80

function cleanEntity(value) {
  return String(value ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, MAX_ENTITY)
}

/** Key two entity strings must share to be the same name. Empty when there is nothing to match. */
export function entityMatchKey(value) {
  const raw = String(value ?? '').trim()
  const translated = Object.prototype.hasOwnProperty.call(LEGACY_ENTITY_LABELS, raw)
    ? LEGACY_ENTITY_LABELS[raw]
    : raw
  return translated.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function asRows(mapping) {
  if (Array.isArray(mapping)) return mapping
  if (!mapping || typeof mapping !== 'object') return []
  return Object.entries(mapping).map(([entity, siteType]) => ({ entity, siteType }))
}

/**
 * Rows safe to store on the org. A blank entity or a blank site type is
 * dropped. Two rows that match the same name keep the first. The site type
 * is stored as the label the digest already understands.
 */
export function packSiteTypeByEntity(mapping, extraLabels = []) {
  const map = {}
  const rows = []
  const dropped = []
  const seen = new Set()
  for (const row of asRows(mapping)) {
    const entity = cleanEntity(row?.entity)
    const key = entityMatchKey(entity)
    const siteType = canonicalFacility(row?.siteType, extraLabels)
    if (!entity || !key || !siteType) continue
    if (seen.has(key)) {
      dropped.push(entity)
      continue
    }
    seen.add(key)
    map[entity] = siteType
    rows.push({ entity, siteType })
  }
  return { map, rows, dropped }
}

export function rowsFromSiteTypeByEntity(raw, extraLabels = []) {
  return packSiteTypeByEntity(raw, extraLabels).rows
}

function facilityEmpty(site) {
  return !String(site?.facility ?? '').trim()
}

/**
 * Dry run. `mapping` is the editor rows or the object stored on the org.
 * Nothing here writes. `updates` is only the sites whose type is still empty
 * and whose entity matches a row.
 */
export function planSiteTypeBackfill(sites, mapping, extraLabels = []) {
  const packed = packSiteTypeByEntity(mapping, extraLabels)
  const byKey = new Map(packed.rows.map((row) => [entityMatchKey(row.entity), row]))
  const updates = []
  const byEntity = new Map()
  const unmatched = new Map()
  let alreadySet = 0
  let emptyEntity = 0

  for (const site of sites || []) {
    if (!site?.id) continue
    if (!facilityEmpty(site)) {
      alreadySet += 1
      continue
    }
    const stored = cleanEntity(site.entity)
    const key = entityMatchKey(stored)
    if (!key) {
      emptyEntity += 1
      continue
    }
    const row = byKey.get(key)
    if (!row) {
      const prior = unmatched.get(key)
      unmatched.set(key, {
        entity: prior?.entity || stored,
        count: (prior?.count || 0) + 1,
      })
      continue
    }
    updates.push({
      id: site.id,
      name: site.name || site.id,
      entity: row.entity,
      facility: row.siteType,
    })
    const bucket = byEntity.get(key) || { entity: row.entity, siteType: row.siteType, count: 0 }
    bucket.count += 1
    byEntity.set(key, bucket)
  }

  const byEntityList = [...byEntity.values()].sort((a, b) => a.entity.localeCompare(b.entity))
  const unmatchedEntities = [...unmatched.values()].sort((a, b) => a.entity.localeCompare(b.entity))
  return {
    updates,
    byEntity: byEntityList,
    unmatchedEntities,
    dropped: packed.dropped,
    counts: {
      wouldUpdate: updates.length,
      alreadySet,
      unmatched: unmatchedEntities.reduce((sum, row) => sum + row.count, 0),
      emptyEntity,
    },
  }
}
