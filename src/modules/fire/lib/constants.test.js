import { describe, it, expect } from 'vitest'
import {
  ASSET_DEFECTS, ENTITIES, ENTITY_COLORS, LEGACY_ENTITIES, normalizeEntity,
  OTHER_DEFECT, REGIONS, REGION_COLORS, TYPES, TYPE_COLORS,
} from './constants'

// The "By Entity" chart colours its bars by looking each entity up in
// ENTITY_COLORS. When the entity vocabulary moved from 1P/2P/3P to the site
// registry's COCO/FOCO/FOFO/... the palette was left behind, so five of seven
// bars fell through to an undefined fill and rendered in Recharts' default
// colour — the chart stopped segregating anything. These tests pin the palette
// to the vocabulary so the two cannot drift apart again.
describe('chart palettes cover their vocabularies', () => {
  it('gives every entity its own colour', () => {
    for (const en of ENTITIES) expect(ENTITY_COLORS[en], `no colour for entity ${en}`).toBeTruthy()
  })

  it('never reuses a colour between two entities', () => {
    const used = ENTITIES.map((en) => ENTITY_COLORS[en])
    expect(new Set(used).size).toBe(ENTITIES.length)
  })

  it('colours legacy entity labels as whatever they normalise to', () => {
    for (const [legacy, current] of Object.entries(LEGACY_ENTITIES)) {
      expect(normalizeEntity(legacy)).toBe(current)
      expect(ENTITY_COLORS[legacy], `no colour for legacy label ${legacy}`).toBe(ENTITY_COLORS[current])
    }
  })

  it('covers regions and types too', () => {
    for (const rg of REGIONS) expect(REGION_COLORS[rg], `no colour for region ${rg}`).toBeTruthy()
    for (const t of TYPES) expect(TYPE_COLORS[t], `no colour for type ${t}`).toBeTruthy()
  })
})

// These sheets are reached from a public QR scan, so the server checks what
// they produce (stack/policy.mjs): assetKind must match the scanned code, and
// defect must be a string of at most 200 chars.
// A list that drifts outside those bounds fails at submit time, on a phone, for
// a member of the public — which is the worst place to find out.
describe('asset defect sheets stay within what the rules accept', () => {
  const KINDS_ALLOWED_BY_RULES = ['aed', 'fas', 'stretcher']

  it('defines a sheet for exactly the kinds the rules admit', () => {
    expect(Object.keys(ASSET_DEFECTS).sort()).toEqual([...KINDS_ALLOWED_BY_RULES].sort())
  })

  it('offers non-empty, unique options within the 200-char rule limit', () => {
    for (const [kind, sheet] of Object.entries(ASSET_DEFECTS)) {
      expect(sheet.length, `${kind} sheet is empty`).toBeGreaterThan(0)
      expect(new Set(sheet).size, `${kind} sheet repeats an option`).toBe(sheet.length)
      for (const d of sheet) {
        expect(typeof d, `${kind}: ${d} is not a string`).toBe('string')
        expect(d.trim(), `${kind} has a blank option`).not.toBe('')
        expect(d.length, `${kind}: "${d}" exceeds the 200-char rule limit`).toBeLessThanOrEqual(200)
      }
    }
  })

  it('ends every sheet with the shared catch-all', () => {
    for (const [kind, sheet] of Object.entries(ASSET_DEFECTS)) {
      expect(sheet[sheet.length - 1], `${kind} sheet has no catch-all`).toBe(OTHER_DEFECT)
    }
  })
})
