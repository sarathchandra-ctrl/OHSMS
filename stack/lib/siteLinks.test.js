import { describe, it, expect } from 'vitest'
import {
  planSiteLinks,
  resolveSite,
  indexSites,
  LINKABLE_COLLECTIONS,
  MATCH_TIERS,
  SITE_NAME_OVERRIDES,
} from './siteLinks.js'

// Site names below are real values from the Cult site master and the Fire
// Marshal export, so the cases reflect the data the backfill will actually meet
// rather than invented shapes.
const site = (id, name) => ({ id, name })
const record = (collection, id, centerName, extra = {}) => ({ collection, id, centerName, ...extra })
const ext = (id, centerName, extra = {}) => record('extinguishers', id, centerName, extra)

const SITES = [
  site('s1', 'Cult Gym Ameerpet'),
  site('s2', 'Cult Gym Shaikpet'),
  site('s3', 'Cult neo gym Alwal'),
  site('s4', 'Stark Fitness Studio (Sainikpuri)'),
  site('s5', 'G8 Fitness'),
  site('s6', 'Stark Fitness Studio (Hydernagar)'),
  site('s7', 'Raptor Fitness (Addagutta)'),
  site('s8', 'Cult Gym Suchitra Road (Suchitra)'),
]

// The same building typed into the registry twice, once with the locality
// bracketed. Nothing in the app prevents this, and no amount of normalisation
// can tell which of the two documents a piece of equipment means.
const DUPLICATE_SITES = [...SITES, site('s9', 'Raptor Fitness Addagutta')]

// Every bucket planSiteLinks reports. Arrays hold rows, numbers are counts.
const BUCKETS = ['writes', 'ambiguous', 'conflicting', 'unmatched', 'noName', 'alreadyLinked', 'deleted']

const size = (v) => (Array.isArray(v) ? v.length : v)
const landedIn = (plan) => BUCKETS.filter((b) => size(plan[b]) > 0)

// ── The tables ───────────────────────────────────────────────────────────────
// Three of them, one per axis the module can grow along: the collections it
// covers, the tiers it matches on, and the buckets it sorts records into. Each
// is checked against the module's own exported list, so adding a collection or
// a match rule without adding a row here fails before anything else runs.

const COLLECTION_CASES = [
  { collection: 'extinguishers', id: 'e1' },
  { collection: 'aeds', id: 'a1' },
  { collection: 'fas', id: 'f1' },
]

const TIER_CASES = [
  // Character for character, as the registry holds it.
  { how: 'exact', centerName: 'Cult Gym Shaikpet', siteId: 's2' },
  // Casing only — the source export is inconsistent about it.
  { how: 'base', centerName: 'Cult Neo Gym Alwal', siteId: 's3' },
  // The registry brackets the locality; the equipment record does not.
  { how: 'alnum', centerName: 'Raptor Fitness Addagutta', siteId: 's7' },
  // "Gym" is the systematic difference between the two systems.
  { how: 'core', centerName: 'Cult Ameerpet', siteId: 's1' },
  // Same locality, different business: only a human-confirmed row gets this one
  // right, which is why the table exists.
  { how: 'override', centerName: 'G8 Fitness Studio - Sainikpuri', siteId: 's5' },
]

const BUCKET_CASES = [
  {
    bucket: 'writes',
    centerName: 'Cult Gym Shaikpet',
    extra: {},
    check: (plan, { collection, id }) =>
      expect(plan.writes).toEqual([{ collection, id, siteId: 's2', matchedName: 'Cult Gym Shaikpet' }]),
  },
  {
    bucket: 'ambiguous',
    centerName: 'Raptor Fitness - Addagutta',
    extra: {},
    sites: DUPLICATE_SITES,
    check: (plan) => {
      expect(plan.ambiguous[0].siteIds).toEqual(['s7', 's9'])
      expect(plan.ambiguous[0].currentSiteId).toBeNull()
    },
  },
  {
    bucket: 'conflicting',
    centerName: 'Cult Gym Shaikpet',
    extra: { siteId: 's1' },
    check: (plan) => {
      expect(plan.conflicting[0].currentSiteId).toBe('s1')
      expect(plan.conflicting[0].resolvedSiteId).toBe('s2')
    },
  },
  {
    bucket: 'unmatched',
    centerName: 'Nowhere Fitness',
    extra: {},
    check: (plan) => expect(plan.unmatchedNames).toEqual(['Nowhere Fitness']),
  },
  {
    bucket: 'noName',
    centerName: '',
    extra: {},
    check: (plan, { collection, id }) => expect(plan.noName).toEqual([{ collection, id, centerName: '' }]),
  },
  {
    bucket: 'alreadyLinked',
    centerName: 'Cult Gym Shaikpet',
    extra: { siteId: 's2' },
    check: (plan) => expect(plan.alreadyLinked).toBe(1),
  },
  {
    bucket: 'deleted',
    centerName: 'Cult Gym Shaikpet',
    extra: { deletedAt: '2026-01-01T00:00:00Z' },
    check: (plan) => expect(plan.deleted).toBe(1),
  },
]

describe('the tables cover the module', () => {
  it('has a case for every linkable collection', () => {
    expect(COLLECTION_CASES.map((c) => c.collection)).toEqual(LINKABLE_COLLECTIONS)
  })

  it('has a case for every match tier, in the order they are tried', () => {
    expect(TIER_CASES.map((c) => c.how)).toEqual(MATCH_TIERS)
  })

  it('has a case for every bucket the plan reports', () => {
    // unmatchedNames is derived from unmatched, not a bucket of its own.
    const reported = Object.keys(planSiteLinks([], SITES)).filter((k) => k !== 'unmatchedNames')
    expect(reported.sort()).toEqual([...BUCKETS].sort())
    expect(BUCKET_CASES.map((c) => c.bucket).sort()).toEqual([...BUCKETS].sort())
  })
})

describe.each(COLLECTION_CASES)('planning $collection', (target) => {
  it.each(BUCKET_CASES)('files a record into $bucket', (c) => {
    const plan = planSiteLinks([{ ...target, centerName: c.centerName, ...c.extra }], c.sites || SITES)
    // Exactly one bucket, every time: a record that lands in none has been
    // dropped without a trace, and one that lands in two is counted twice in
    // the dry run a human reads before saying yes.
    expect(landedIn(plan)).toEqual([c.bucket])
    c.check(plan, target)
  })
})

describe('resolveSite tiers', () => {
  it.each(TIER_CASES)('matches "$centerName" at the $how tier', ({ how, centerName, siteId }) => {
    const hit = resolveSite(centerName, SITES)
    expect(hit.status).toBe('matched')
    expect(hit.site.id).toBe(siteId)
    expect(hit.how).toBe(how)
  })

  it('tries the override table last', () => {
    expect(MATCH_TIERS[MATCH_TIERS.length - 1]).toBe('override')
  })

  it.each([
    ['', 'an empty string'],
    ['   ', 'whitespace'],
    [null, 'null'],
    [undefined, 'a missing field'],
  ])('reports %s as having no name', (value) => {
    expect(resolveSite(value, SITES).status).toBe('noName')
  })

  it('returns unmatched rather than a best guess', () => {
    // Close enough that similarity scoring would offer it; not close enough to
    // write unattended.
    expect(resolveSite('Cult Gym Shaikpett', SITES).status).toBe('unmatched')
  })
})

describe('ambiguity is never resolved by guessing', () => {
  // The failure the app's index hides: indexSites in
  // src/modules/fire/lib/siteLink.js keeps the first site to claim a key, so
  // "Cult Gym X" and "Cult X" collapse and one wins on document order.
  const collapsing = [site('a', 'Cult Gym X'), site('b', 'Cult X')]

  it('keeps every site that shares a normalised name', () => {
    expect(indexSites(collapsing).get('core').get('cult x').map((s) => s.id)).toEqual(['a', 'b'])
  })

  it('makes EVERY record carrying that name ambiguous, and writes none of them', () => {
    const plan = planSiteLinks([ext('e1', 'Cult X Gym'), ext('e2', 'Cult X Gym')], collapsing)
    expect(plan.writes).toEqual([])
    expect(plan.ambiguous.map((a) => a.siteIds)).toEqual([['a', 'b'], ['a', 'b']])
    expect(plan.ambiguous[0].how).toBe('core')
    expect(plan.ambiguous[0].siteNames).toEqual(['Cult Gym X', 'Cult X'])
  })

  it('stops at the tier the ambiguity appeared in rather than loosening further', () => {
    // Both sites collide at alnum. Falling through to core would still find two
    // — but a rule that keeps loosening until exactly one answer survives is
    // choosing by luck, and the looser the rule the less that answer is worth.
    const plan = planSiteLinks([ext('e1', 'Raptor Fitness - Addagutta')], DUPLICATE_SITES)
    expect(plan.ambiguous[0].how).toBe('alnum')
    expect(plan.writes).toEqual([])
  })

  it('counts a record already linked to one of the candidates as done', () => {
    // Somebody has already made the choice this job refuses to make. Reporting
    // it every run trains the reader to skip the bucket that matters most.
    const plan = planSiteLinks([ext('e1', 'Raptor Fitness - Addagutta', { siteId: 's7' })], DUPLICATE_SITES)
    expect(plan.ambiguous).toEqual([])
    expect(plan.alreadyLinked).toBe(1)
  })

  it('still reports one linked to a site that is not a candidate', () => {
    const plan = planSiteLinks([ext('e1', 'Raptor Fitness - Addagutta', { siteId: 's2' })], DUPLICATE_SITES)
    expect(plan.ambiguous[0].currentSiteId).toBe('s2')
    expect(plan.ambiguous[0].siteIds).toEqual(['s7', 's9'])
    expect(plan.writes).toEqual([])
  })

  it('does not treat the same site listed twice as two candidates', () => {
    const s = site('a', 'Cult Gym X')
    const plan = planSiteLinks([ext('e1', 'Cult Gym X')], [s, s])
    expect(plan.ambiguous).toEqual([])
    expect(plan.writes).toHaveLength(1)
  })
})

describe('an existing siteId is never overwritten', () => {
  it('reports the disagreement and writes nothing', () => {
    // Somebody may have linked this by hand, correctly, and the stale text is
    // the wrong half. The job cannot tell which half is stale.
    const plan = planSiteLinks([ext('e1', 'Cult Gym Shaikpet', { siteId: 's1' })], SITES)
    expect(plan.writes).toEqual([])
    expect(plan.conflicting).toEqual([{
      collection: 'extinguishers',
      id: 'e1',
      centerName: 'Cult Gym Shaikpet',
      currentSiteId: 's1',
      resolvedSiteId: 's2',
      resolvedName: 'Cult Gym Shaikpet',
      how: 'exact',
    }])
  })

  it('leaves a linked record alone when its text names no site at all', () => {
    const plan = planSiteLinks([ext('e1', 'Gym That Closed', { siteId: 's2' })], SITES)
    expect(plan.unmatched).toEqual([])
    expect(plan.alreadyLinked).toBe(1)
  })

  it('leaves a linked record alone when it has no centre name', () => {
    const plan = planSiteLinks([ext('e1', '', { siteId: 's2' })], SITES)
    expect(plan.noName).toEqual([])
    expect(plan.alreadyLinked).toBe(1)
  })

  it('treats a blank siteId as no link at all', () => {
    for (const blank of ['', '   ', null, undefined]) {
      expect(planSiteLinks([ext('e1', 'Cult Gym Shaikpet', { siteId: blank })], SITES).writes).toHaveLength(1)
    }
  })
})

describe('the write itself', () => {
  it('carries siteId and nothing that could rename anything', () => {
    // The centre name on an extinguisher is stencilled on the extinguisher.
    // collection and id address the document, matchedName is for the dry-run
    // report, and siteId is the entire patch — there is nothing else here for a
    // caller to write by accident.
    const plan = planSiteLinks([ext('e1', 'Cult Ameerpet')], SITES)
    expect(Object.keys(plan.writes[0]).sort()).toEqual(['collection', 'id', 'matchedName', 'siteId'])
    for (const forbidden of ['centerName', 'siteName', 'entity', 'region', 'name', 'sourceCenterName']) {
      expect(plan.writes[0]).not.toHaveProperty(forbidden)
    }
  })

  it('writes nothing on a second run', () => {
    const records = [
      ext('e1', 'Cult Gym Shaikpet'),
      ext('e2', 'Cult Ameerpet'),
      ext('e3', 'Raptor Fitness Addagutta'),
    ]
    const first = planSiteLinks(records, SITES)
    expect(first.writes).toHaveLength(3)

    const applied = records.map((r) => {
      const w = first.writes.find((x) => x.id === r.id)
      return w ? { ...r, siteId: w.siteId } : r
    })
    const second = planSiteLinks(applied, SITES)
    expect(second.writes).toEqual([])
    expect(second.conflicting).toEqual([])
    expect(second.alreadyLinked).toBe(3)
  })

  it('emits one write when the same document is listed twice', () => {
    // Two writes to one path in a single batch is rejected outright, failing
    // the whole run over a duplicate in the caller's query.
    const plan = planSiteLinks([ext('e1', 'Cult Gym Shaikpet'), ext('e1', 'Cult Gym Shaikpet')], SITES)
    expect(plan.writes).toHaveLength(1)
  })

  it('treats the same id in two collections as two documents', () => {
    const plan = planSiteLinks([
      record('extinguishers', 'x1', 'Cult Gym Shaikpet'),
      record('aeds', 'x1', 'Cult Gym Shaikpet'),
    ], SITES)
    expect(plan.writes.map((w) => w.collection)).toEqual(['extinguishers', 'aeds'])
  })

  it('skips a deleted record even when it would otherwise conflict', () => {
    const plan = planSiteLinks(
      [ext('e1', 'Cult Gym Shaikpet', { siteId: 's1', deletedAt: '2026-01-01T00:00:00Z' })],
      SITES,
    )
    expect(plan.conflicting).toEqual([])
    expect(plan.deleted).toBe(1)
  })
})

describe('the override table', () => {
  it('only fires when this org actually has the site it names', () => {
    // The table is global. "Play Time Sport" maps to a Fitso site this org does
    // not run, and a missing target must not crash or half-match.
    expect(resolveSite('Play Time Sport', SITES).status).toBe('unmatched')
  })

  it('loses to a site the org has under its own name', () => {
    // Being tried last is what makes this safe for a tenant the table was not
    // written for: "Iron Fist Fitness" maps to "Iron Fist" for one customer,
    // but an org genuinely running a site of that exact name keeps it.
    const own = [site('own', 'Iron Fist Fitness'), site('other', 'Iron Fist')]
    const hit = resolveSite('Iron Fist Fitness', own)
    expect(hit.site.id).toBe('own')
    expect(hit.how).toBe('exact')
  })

  it('can be switched off by a caller running an unconfirmed tenant', () => {
    const plan = planSiteLinks([ext('e1', 'G8 Fitness Studio - Sainikpuri')], SITES, { overrides: {} })
    expect(plan.writes).toEqual([])
    expect(plan.unmatchedNames).toEqual(['G8 Fitness Studio - Sainikpuri'])
  })

  it.each(['__proto__', 'constructor', 'toString'])('does not read "%s" off Object.prototype', (name) => {
    const plan = planSiteLinks([ext('e1', name)], SITES)
    expect(plan.writes).toEqual([])
    expect(plan.unmatched).toHaveLength(1)
  })

  // Mirrors the checks on the app-side copy in
  // src/modules/fire/lib/siteLink.test.js. functions/ cannot import from src/,
  // so these guard the copy against a bad edit on this side of the boundary.
  it('never maps a name to itself — that would be a normalisation case', () => {
    for (const [from, to] of Object.entries(SITE_NAME_OVERRIDES)) {
      expect(typeof to, from).toBe('string')
      expect(from.toLowerCase(), from).not.toBe(to.toLowerCase())
    }
  })

  it('has no duplicate source names', () => {
    const keys = Object.keys(SITE_NAME_OVERRIDES)
    expect(new Set(keys.map((k) => k.toLowerCase())).size).toBe(keys.length)
  })
})

describe('the whole estate at once', () => {
  const ESTATE = [
    ext('e1', 'Cult Gym Shaikpet'),                                  // writes
    record('aeds', 'a1', 'Cult Ameerpet'),                           // writes
    record('fas', 'f1', 'Raptor Fitness - Addagutta'),               // ambiguous
    ext('e2', 'Cult Gym Shaikpet', { siteId: 's1' }),                // conflicting
    ext('e3', 'Zeta Fitness'),                                       // unmatched
    ext('e4', 'Alpha Fitness'),                                      // unmatched
    ext('e5', 'Zeta Fitness'),                                       // unmatched
    ext('e6', ''),                                                   // noName
    ext('e7', 'Cult Gym Shaikpet', { siteId: 's2' }),                // alreadyLinked
    ext('e8', 'Cult Gym Shaikpet', { deletedAt: '2026-01-01' }),     // deleted
  ]

  it('files every record into exactly one bucket', () => {
    // A record in no bucket has been dropped silently; a record in two is
    // counted twice in the report someone approves the run from.
    const plan = planSiteLinks(ESTATE, DUPLICATE_SITES)
    expect(BUCKETS.reduce((n, b) => n + size(plan[b]), 0)).toBe(ESTATE.length)
  })

  it('does not let one unresolvable record stop the rest', () => {
    const plan = planSiteLinks(ESTATE, DUPLICATE_SITES)
    expect(plan.writes.map((w) => w.id)).toEqual(['e1', 'a1'])
    expect(plan.ambiguous).toHaveLength(1)
    expect(plan.conflicting).toHaveLength(1)
    expect(plan.alreadyLinked).toBe(1)
    expect(plan.deleted).toBe(1)
  })

  it('reports unmatched centre names once each, sorted', () => {
    // Hundreds of rows collapse to a couple of dozen names, and a name is what
    // a person can actually go and fix.
    const plan = planSiteLinks(ESTATE, DUPLICATE_SITES)
    expect(plan.unmatched).toHaveLength(3)
    expect(plan.unmatchedNames).toEqual(['Alpha Fitness', 'Zeta Fitness'])
  })
})

describe('degenerate inputs', () => {
  it('survives empty and missing collections', () => {
    for (const [equipment, sites] of [[[], []], [undefined, undefined], [null, null]]) {
      expect(planSiteLinks(equipment, sites).writes).toEqual([])
    }
  })

  it('skips a record with no id — there is nothing to address', () => {
    const plan = planSiteLinks([{ collection: 'extinguishers', centerName: 'Cult Gym Shaikpet' }, null], SITES)
    expect(BUCKETS.reduce((n, b) => n + size(plan[b]), 0)).toBe(0)
  })

  it('skips a site with no name', () => {
    // Already invisible to the app: subscribeSites orders by name and Firestore
    // drops documents missing the ordered field.
    const idx = indexSites([site('a', ''), site('b', undefined), site('c', 'Real Site')])
    expect(idx.get('base').size).toBe(1)
    expect(idx.get('base').get('real site').map((s) => s.id)).toEqual(['c'])
  })

  it('does not list signages among the linkable collections', () => {
    // cleanSignage never copies siteId, so a link written there would be a
    // field no writer maintains and no reader consults.
    expect(LINKABLE_COLLECTIONS).not.toContain('signages')
  })
})
