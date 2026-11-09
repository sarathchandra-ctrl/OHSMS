// ─────────────────────────────────────────────────────────────────────────────
// ODIN — the time-series and estate-dimension arithmetic.
//
// Separate from odinAnalytics.test.js because it covers a distinct surface:
// how rows are bucketed into periods, how a warehouse's centre id is joined to
// this app's own site register, and the remediation cuts a ticket dump makes
// possible. The aggregation those feed is tested next door.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect } from 'vitest'
import {
  bucketOf, passTrend, ticketTrend, countBy, toDateOf, isBreach,
  dimensionsPresent, dimensionHasData, resolveGroupBy, joinQuality, regionCoverage, resolveOdinRows, filterOdinRows,
  GRANULARITY_KEYS, PASS_MARK, recoveryStages, scoreBands, centreWatchlist, auditorMatrix,
  ticketAgeing, ticketTrend as trend, auditPopulation, ownerOf, observationsPerSite, isFls, flsCategories, quarterName, quarterOnQuarter, quarterSpans, quarterSeries,
} from './odinAnalytics'

/** The shape stack/lib/metabase.js hands back, with the fields these tests need. */
const row = (over = {}) => ({
  siteId: '', site: 'Plant 2', region: 'South', entity: 'Retail',
  status: 'open', rawStatus: 'Open', category: '', subCategory: '',
  city: '', ownership: '', businessLine: '', centerType: '', auditType: '', auditor: '',
  priority: '', sla: '', checkpoint: '', tatHours: null,
  auditDate: '2026-03-14', closedDate: '', lat: null, lng: null, count: 1,
  passPct: null, passPctN7: null, passPctToDate: null,
  checksPassed: null, checksTotal: null, extra: {},
  ...over,
})

const audit = (over = {}) => row({ status: 'closed', passPct: 90, passPctN7: 96, ...over })

// ── Time buckets ─────────────────────────────────────────────────────────────

describe('bucketOf', () => {
  it('offers the six grains the filter bar does', () => {
    expect(GRANULARITY_KEYS).toEqual(['day', 'week', 'month', 'quarter', 'half', 'year'])
  })

  it('puts a date in the right bucket at every grain', () => {
    const d = '2026-03-14'   // a Saturday
    expect(bucketOf(d, 'day')).toEqual({ key: '2026-03-14', label: '14 Mar' })
    expect(bucketOf(d, 'week')).toEqual({ key: '2026-03-09', label: 'w/c 9 Mar' })
    expect(bucketOf(d, 'month')).toEqual({ key: '2026-03', label: 'Mar 26' })
    expect(bucketOf(d, 'quarter')).toEqual({ key: '2026-Q1', label: 'Q1 26' })
    expect(bucketOf(d, 'half')).toEqual({ key: '2026-H1', label: 'H1 2026' })
    expect(bucketOf(d, 'year')).toEqual({ key: '2026', label: '2026' })
  })

  it('starts a week on Monday, including when the date already is one', () => {
    expect(bucketOf('2026-03-09', 'week').key).toBe('2026-03-09')
    expect(bucketOf('2026-03-15', 'week').key).toBe('2026-03-09')   // Sunday still belongs to it
    expect(bucketOf('2026-03-16', 'week').key).toBe('2026-03-16')   // the next Monday
  })

  it('keys sort chronologically as plain strings, which the charts rely on', () => {
    const keys = ['2026-01-05', '2025-11-30', '2026-10-02']
      .map((d) => bucketOf(d, 'quarter').key).sort()
    expect(keys).toEqual(['2025-Q4', '2026-Q1', '2026-Q4'])
  })

  it('refuses a row with no usable date rather than inventing a bucket', () => {
    expect(bucketOf('', 'month')).toBe(null)
    expect(bucketOf('not a date', 'month')).toBe(null)
    expect(bucketOf('2026-03', 'month')).toBe(null)
  })

  it('crosses a half-year and a year boundary on the right side', () => {
    expect(bucketOf('2026-06-30', 'half').key).toBe('2026-H1')
    expect(bucketOf('2026-07-01', 'half').key).toBe('2026-H2')
    expect(bucketOf('2025-12-31', 'year').key).toBe('2025')
  })
})

describe('passTrend', () => {
  it('rates each bucket against the pass mark and says how many audits it saw', () => {
    const { series } = passTrend([
      audit({ auditDate: '2026-03-02', passPctN7: 95 }),
      audit({ auditDate: '2026-03-20', passPctN7: 80 }),
      audit({ auditDate: '2026-04-04', passPctN7: 91 }),
    ], 'month')
    expect(series.map((s) => s.key)).toEqual(['2026-03', '2026-04'])
    expect(series[0]).toMatchObject({ n7: 50, n7N: 2, pass: 1, fail: 1, audits: 2 })
    expect(series[1]).toMatchObject({ n7: 100, n7N: 1, pass: 1, fail: 0 })
  })

  it('leaves a period with no audits out rather than drawing it as zero', () => {
    const { series } = passTrend([
      audit({ auditDate: '2026-01-10' }),
      audit({ auditDate: '2026-03-10' }),
    ], 'month')
    expect(series.map((s) => s.key)).toEqual(['2026-01', '2026-03'])
  })

  it('counts undated audits aside instead of bucketing them somewhere wrong', () => {
    const { series, undated } = passTrend([
      audit({ auditDate: '' }),
      audit({ auditDate: '2026-03-10' }),
    ], 'month')
    expect(series).toHaveLength(1)
    expect(undated).toBe(1)
  })

  it('treats a score exactly at the mark as a pass, matching the question', () => {
    expect(PASS_MARK).toBe(90)
    const { series } = passTrend([audit({ auditDate: '2026-03-10', passPctN7: PASS_MARK })], 'month')
    expect(series[0].n7).toBe(100)
  })

  it('carries both readings side by side', () => {
    const { series } = passTrend([
      audit({ auditDate: '2026-03-10', passPct: 80, passPctN7: 95, passPctToDate: 100 }),
    ], 'month')
    expect(series[0]).toMatchObject({ day0: 0, n7: 100 })
  })

  it('does NOT carry the to-date reading, whatever the row holds', () => {
    // The whole page is bounded by the dates the reader picked. passPctToDate
    // is the centre's score as of today: it credits remediation from after the
    // window and moves on every refresh, so on a chart of a chosen period it
    // answered a different question in identical visual language.
    const { series } = passTrend([
      audit({ auditDate: '2026-03-10', passPct: 80, passPctN7: 95, passPctToDate: 100 }),
    ], 'month')
    expect(series[0]).not.toHaveProperty('toDate')
    expect(series[0]).not.toHaveProperty('toDateN')
  })
})

describe('ticketTrend', () => {
  it('splits each bucket by where the ticket stands and whether SLA held', () => {
    const { series } = ticketTrend([
      row({ auditDate: '2026-03-02', status: 'open', sla: 'open-SLA-Breached' }),
      row({ auditDate: '2026-03-09', status: 'closed', sla: 'Closed- Within SLA' }),
      row({ auditDate: '2026-03-11', status: 'in_progress', sla: 'open-within-SLA' }),
    ], 'month')
    expect(series[0]).toMatchObject({ total: 3, open: 2, closed: 1, breached: 1 })
  })

  it('reads a breach out of whatever wording the warehouse used', () => {
    expect(isBreach('open-SLA-Breached')).toBe(true)
    expect(isBreach('Closed- SLA Breached')).toBe(true)
    expect(isBreach('Closed- Within SLA')).toBe(false)
    expect(isBreach('')).toBe(false)
  })
})

describe('countBy', () => {
  it('ranks a free-text column and counts what is still open beside it', () => {
    const out = countBy([
      row({ priority: 'Code_red', status: 'open' }),
      row({ priority: 'Code_red', status: 'closed' }),
      row({ priority: 'Low', status: 'open' }),
    ], 'priority')
    expect(out[0]).toEqual({ name: 'Code_red', value: 2, open: 1 })
    expect(out[1]).toEqual({ name: 'Low', value: 1, open: 1 })
  })

  it('names the blank rather than dropping those rows into nothing', () => {
    expect(countBy([row({ priority: '' })], 'priority')[0].name).toBe('(not stated)')
  })

  it('honours a limit, for a league table that has to fit on screen', () => {
    const rows = ['a', 'b', 'c'].map((c) => row({ checkpoint: c }))
    expect(countBy(rows, 'checkpoint', { limit: 2 })).toHaveLength(2)
  })
})

describe('toDateOf', () => {
  it('is only the to-date column, never inferred from the other two', () => {
    expect(toDateOf({ passPctToDate: 100 })).toBe(100)
    expect(toDateOf({ passPct: 90, passPctN7: 96 })).toBe(null)
  })
})

// ── Joining the warehouse to this app's own site register ────────────────────

describe('the centre-id join', () => {
  const CODED = [
    { id: 'abc123', name: 'Cult Pitampura', region: 'North', entity: 'Fitness', lat: 28.7, lng: 77.1, attributes: { centerId: '201' } },
    { id: 'def456', name: 'Fast Fit Gym', region: 'South', entity: 'Partner', code: '50' },
  ]

  it('matches the warehouse centre id against a code held in attributes', () => {
    const [r] = resolveOdinRows([row({ siteId: '201', site: 'CULT PITAMPURA (renamed)', region: '' })], CODED)
    expect(r.matchedBy).toBe('id')
    expect(r.region).toBe('North')
    expect(r.lat).toBe(28.7)
  })

  it('matches a code held on the site document itself', () => {
    expect(resolveOdinRows([row({ siteId: '50', site: '' })], CODED)[0].matchedBy).toBe('id')
  })

  it('matches a centre id that differs only by case, and does not guess between two', () => {
    const sites = [{ id: 's1', name: 'North', code: 'NP-001', region: 'North' }]
    const [hit] = resolveOdinRows([row({ siteId: 'np-001', site: '', region: '' })], sites)
    expect(hit.matchedBy).toBe('id')
    expect(hit.region).toBe('North')
    const both = [
      { id: 'a', name: 'One', code: 'NP-001', region: 'North' },
      { id: 'b', name: 'Two', code: 'np-001', region: 'South' },
    ]
    // The exact stored spelling still finds its own site.
    expect(resolveOdinRows([row({ siteId: 'np-001', site: '' })], both)[0].region).toBe('South')
    // A third casing matches neither document exactly, and both fold to it.
    const [miss] = resolveOdinRows([row({ siteId: 'Np-001', site: 'Nowhere' })], both)
    expect(miss.matchedBy).toBe('')
  })

  it('still falls back to the name when there is no code to match', () => {
    const [r] = resolveOdinRows([row({ siteId: '', site: 'Fast Fit Gym', entity: '' })], CODED)
    expect(r.matchedBy).toBe('name')
    expect(r.entity).toBe('Partner')
  })

  it('prefers the id over the name, because a name is not a key', () => {
    // The id says Pitampura, the name says Fast Fit. The id decides.
    const [r] = resolveOdinRows([row({ siteId: '201', site: 'Fast Fit Gym', region: '' })], CODED)
    expect(r.region).toBe('North')
  })

  it('reports how the estate joined, so a thin map is diagnosable', () => {
    const rows = resolveOdinRows([
      row({ siteId: '201', site: 'x' }),
      row({ siteId: '', site: 'Fast Fit Gym' }),
      row({ siteId: '999', site: 'Nowhere' }),
    ], CODED)
    expect(joinQuality(rows)).toEqual({ byId: 1, byName: 1, unmatched: 1, total: 3 })
  })

  it('matches a name that differs only by punctuation or spacing', () => {
    // A warehouse writes "Cult - Pitampura" and the register holds "Cult
    // Pitampura". Losing an audit to a hyphen is not a data problem anybody
    // can be asked to go and fix.
    const sites = [{ id: 's1', name: 'Cult Pitampura', region: 'North' }]
    const [r] = resolveOdinRows([row({ siteId: '', site: 'Cult - Pitampura', region: '' })], sites)
    expect(r.matchedBy).toBe('name~')
    expect(r.region).toBe('North')
  })

  it('prefers an exact name over the punctuation-insensitive one', () => {
    const sites = [
      { id: 's1', name: 'Cult HSR', region: 'South' },
      { id: 's2', name: 'Cult-HSR', region: 'West' },
    ]
    const [r] = resolveOdinRows([row({ siteId: '', site: 'Cult-HSR', region: '' })], sites)
    expect(r.matchedBy).toBe('name')
    expect(r.region).toBe('West')
  })

  it('refuses to guess when one loose name belongs to two sites', () => {
    // Attributing an audit to the wrong centre, silently, in a register the
    // reader trusts, is worse than leaving it unplaced and saying so.
    const sites = [
      { id: 's1', name: 'Cult H S R', region: 'South' },
      { id: 's2', name: 'Cult-HSR', region: 'West' },
    ]
    const [r] = resolveOdinRows([row({ siteId: '', site: 'CultHSR', region: '' })], sites)
    expect(r.matchedBy).toBe('')
    expect(r.region).toBe('')
  })

  it('still counts a loose name match as a join, not a failure', () => {
    const sites = [{ id: 's1', name: 'Cult Pitampura', region: 'North' }]
    const rows = resolveOdinRows([row({ siteId: '', site: 'Cult - Pitampura', region: '' })], sites)
    expect(joinQuality(rows)).toMatchObject({ byName: 1, unmatched: 0 })
  })
})

describe('regionCoverage', () => {
  it('separates "no such site" from "site has no region" — they need different fixes', () => {
    const sites = [{ id: 's1', name: 'Known', region: '' }]
    const rows = resolveOdinRows([
      row({ siteId: '', site: 'Known', region: '' }),      // in the register, no region on it
      row({ siteId: '', site: 'Unknown', region: '' }),    // not in the register at all
      row({ siteId: '', site: 'Known', region: '' }),
    ], sites)
    const cov = regionCoverage(rows)
    expect(cov).toMatchObject({ placed: 0, noRegion: 2, noSite: 1, missing: 3, total: 3 })
    expect(cov.noRegionCentres).toEqual(['Known'])
    expect(cov.noSiteCentres).toEqual(['Unknown'])
  })

  it('names each centre once, however many rows it has', () => {
    const rows = resolveOdinRows([row({ site: 'A', region: '' }), row({ site: 'A', region: '' }), row({ site: 'A', region: '' })], [])
    expect(regionCoverage(rows).noSiteCentres).toEqual(['A'])
    expect(regionCoverage(rows).noSite).toBe(3)
  })

  it('counts a row that states its own region as placed', () => {
    const rows = resolveOdinRows([row({ site: 'A', region: 'East' })], [])
    expect(regionCoverage(rows)).toMatchObject({ placed: 1, missing: 0 })
  })
})

describe('dimensionsPresent', () => {
  it('offers only the dimensions the data can actually be grouped by', () => {
    const keys = dimensionsPresent([row({ city: 'Pune', businessLine: '', ownership: '' })]).map((d) => d.key)
    expect(keys).toContain('region')
    expect(keys).toContain('city')
    expect(keys).not.toContain('businessLine')
    expect(keys).not.toContain('ownership')
  })
})

describe('filterOdinRows, on the estate dimensions', () => {
  const POP = [
    row({ city: 'Pune', ownership: 'COCO', businessLine: 'ELITE', auditDate: '2026-03-14' }),
    row({ city: 'Bangalore', ownership: 'FOFO', businessLine: 'PRO', auditDate: '2026-05-02' }),
  ]

  it('cuts by each of the new dimensions', () => {
    expect(filterOdinRows(POP, { city: 'Pune' })).toHaveLength(1)
    expect(filterOdinRows(POP, { ownership: 'FOFO' })[0].city).toBe('Bangalore')
    expect(filterOdinRows(POP, { businessLine: 'ELITE' })[0].city).toBe('Pune')
  })

  it('takes a day-precision range as well as the month it used to take', () => {
    expect(filterOdinRows(POP, { from: '2026-03-15' })).toHaveLength(1)
    expect(filterOdinRows(POP, { from: '2026-03', to: '2026-03' })).toHaveLength(1)
    expect(filterOdinRows(POP, { from: '2026-03-14', to: '2026-05-02' })).toHaveLength(2)
  })

  it('keeps an undated row rather than hiding it the moment a range is set', () => {
    expect(filterOdinRows([row({ auditDate: '' })], { from: '2026-01-01', to: '2026-01-31' })).toHaveLength(1)
  })
})

// ── The FLS dashboard's own arithmetic ───────────────────────────────────────

describe('recoveryStages', () => {
  it('counts the same audits twice as remediation is credited', () => {
    const r = recoveryStages([
      audit({ passPct: 80, passPctN7: 95, passPctToDate: 95 }),
      audit({ passPct: 95, passPctN7: 95, passPctToDate: 100 }),
      audit({ passPct: 40, passPctN7: 60, passPctToDate: 92 }),
    ])
    expect(r.total).toBe(3)
    // No third stage, even though every row carries a to-date score: it is
    // not bounded by the window the reader chose. See toDateOf.
    expect(r.stages.map((s) => [s.label, s.passed])).toEqual([
      ['Passed on the day', 1],
      ['Passed after 7 days', 2],
    ])
  })

  it('divides both stages by the same denominator', () => {
    // Dividing a later stage by its own smaller n would draw recovery that did
    // not happen — an audit missing an N+7 score still took place.
    const r = recoveryStages([
      audit({ passPct: 95, passPctN7: null }),
      audit({ passPct: 95, passPctN7: 95 }),
    ])
    expect(r.total).toBe(2)
    expect(r.stages.find((s) => s.label === 'Passed after 7 days').rate).toBe(50)
  })

  it('never adds a to-date stage, even when every row carries one', () => {
    const r = recoveryStages([audit({ passPct: 95, passPctN7: 95, passPctToDate: 100 })])
    expect(r.stages.map((s) => s.label)).toEqual(['Passed on the day', 'Passed after 7 days'])
  })

  it('is empty rather than zero when there are no scores at all', () => {
    expect(recoveryStages([]).total).toBe(0)
    expect(recoveryStages([row({ passPct: null, passPctN7: null })]).total).toBe(0)
  })
})

describe('scoreBands', () => {
  it('bands audits either side of the pass mark', () => {
    const { bands, scored } = scoreBands([
      audit({ passPctN7: 55 }), audit({ passPctN7: 88 }),
      audit({ passPctN7: 92 }), audit({ passPctN7: 99 }),
    ])
    expect(scored).toBe(4)
    const byName = Object.fromEntries(bands.map((b) => [b.name, b.value]))
    expect(byName['< 60']).toBe(1)
    expect(byName['85–90']).toBe(1)
    expect(byName['90–95']).toBe(1)
    expect(byName['95–100']).toBe(1)
  })

  it('marks which bands are passing, so the colours are not guessed', () => {
    const { bands } = scoreBands([audit({ passPctN7: 99 })])
    expect(bands.filter((b) => b.passing).map((b) => b.name)).toEqual(['90–95', '95–100'])
  })

  it('puts a perfect score in the top band rather than off the end', () => {
    const { bands } = scoreBands([audit({ passPctN7: 100 })])
    expect(bands.find((b) => b.name === '95–100').value).toBe(1)
  })

  it('falls back to the day-0 score when there is no N+7 one', () => {
    const { scored } = scoreBands([audit({ passPct: 70, passPctN7: null })])
    expect(scored).toBe(1)
  })
})

describe('centreWatchlist', () => {
  const at = (site, over = {}) => ({ ...row({ site, ...over }) })

  it('puts audits and tickets for one centre on one line', () => {
    const out = centreWatchlist(
      [at('Plant 2', { status: 'open', sla: 'open-SLA-Breached', priority: 'Code_red' })],
      [{ ...at('Plant 2'), passPctN7: 95 }],
    )
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ site: 'Plant 2', audits: 1, passed: 1, tickets: 1, open: 1, breached: 1, red: 1 })
  })

  it('rates the centre against the pass mark', () => {
    const out = centreWatchlist([], [
      { ...at('A'), passPctN7: 95 }, { ...at('A'), passPctN7: 50 },
    ])
    expect(out[0].passRate).toBe(50)
  })

  it('sorts worst pass rate first, and sinks the unaudited rather than floating them', () => {
    // A centre with no audit has a null rate, and null must not read as zero —
    // that would put every unaudited centre at the top of a watchlist.
    const out = centreWatchlist(
      [at('NoAudits')],
      [{ ...at('Good'), passPctN7: 99 }, { ...at('Bad'), passPctN7: 10 }],
    )
    expect(out.map((r) => r.site)).toEqual(['Bad', 'Good', 'NoAudits'])
  })

  it('joins on the matched site so two spellings do not become two rows', () => {
    const rows = resolveOdinRows(
      [at('plant 2'), { ...at('PLANT  2'), passPctN7: 95 }],
      [{ id: 's1', name: 'Plant 2' }],
    )
    expect(centreWatchlist([rows[0]], [rows[1]])).toHaveLength(1)
  })

  it('survives a population with neither audits nor tickets', () => {
    expect(centreWatchlist([], [])).toEqual([])
    expect(centreWatchlist()).toEqual([])
  })
})

describe("auditorMatrix folds a long tail", () => {
  const many = (n) => Array.from({ length: n }, (_, i) =>
    ({ ...row({ site: `S${i}`, city: `City ${i}`, auditor: "A" }), passPctN7: 95 }))

  it("keeps every group when there are few enough to colour", () => {
    const m = auditorMatrix(many(5), "city")
    expect(m.columns).toHaveLength(5)
    expect(m.columns.some((c) => /^Other/.test(c))).toBe(false)
  })

  it("pools the tail past the palette, because colour is the only cue a stack has", () => {
    const m = auditorMatrix(many(28), "city")
    expect(m.columns).toHaveLength(8)
    expect(m.columns.at(-1)).toBe("Other (21 groups)")
  })

  it("loses no audits to the fold", () => {
    const m = auditorMatrix(many(28), "city")
    const charted = m.rows.reduce((t, r) => t + Object.values(r.groups).reduce((a, b) => a + b, 0), 0)
    expect(charted).toBe(28)
    expect(m.total).toBe(28)
  })

  it("names the tail after the dimension when told what it is", () => {
    expect(auditorMatrix(many(28), "city", { otherLabel: "cities" }).columns.at(-1)).toBe("Other (21 cities)")
  })

  it("can be told not to fold at all", () => {
    expect(auditorMatrix(many(28), "city", { maxColumns: 0 }).columns).toHaveLength(28)
  })
})

describe("region is never swapped out from under the reader", () => {
  // The bug: with no regions in the register, "Region" was filtered out of the
  // picker and the chart silently re-grouped by city — a different question
  // nobody asked, presented as if it were the one they did.
  const noRegion = [row({ region: "", entity: "", city: "Pune" })]

  it("offers region even when nothing currently has one", () => {
    const keys = dimensionsPresent(noRegion).map((d) => d.key)
    expect(keys).toContain("region")
    expect(keys).toContain("entity")
  })

  it("still defaults to region rather than falling through to city", () => {
    expect(resolveGroupBy(dimensionsPresent(noRegion), "region")).toBe("region")
  })

  it("still hides a warehouse dimension the question does not carry", () => {
    // The other half of the rule: region and entity are ours to fill, so they
    // stay; a missing city column is the warehouse’s and is not offered.
    const keys = dimensionsPresent([row({ city: "", businessLine: "" })]).map((d) => d.key)
    expect(keys).not.toContain("city")
    expect(keys).not.toContain("businessLine")
  })

  it("reports emptiness so the page can say so instead of re-grouping", () => {
    expect(dimensionHasData(noRegion, "region")).toBe(false)
    expect(dimensionHasData(noRegion, "city")).toBe(true)
  })
})

describe("ticketAgeing", () => {
  const NOW = Date.parse("2026-03-31T00:00:00Z")

  it("measures a closed ticket by how long it took, in days", () => {
    // tat is hours in the warehouse; the panel talks in days.
    const a = ticketAgeing([row({ status: "closed", tatHours: 48 })], NOW)
    expect(a.closed).toEqual({ days: 2, n: 1 })
  })

  it("falls back to the two dates when the question has no tat column", () => {
    const a = ticketAgeing([
      row({ status: "closed", tatHours: null, auditDate: "2026-03-01", closedDate: "2026-03-11" }),
    ], NOW)
    expect(a.closed.days).toBe(10)
  })

  it("measures everything else by how long it has been WAITING", () => {
    const a = ticketAgeing([
      row({ status: "open", auditDate: "2026-03-01" }),        // 30 days
      row({ status: "open", auditDate: "2026-03-21" }),        // 10 days
    ], NOW)
    expect(a.ageing.find((x) => x.key === "open")).toMatchObject({ days: 20, n: 2 })
  })

  it("keeps the two clocks apart", () => {
    // A finished duration and a running age are different measurements. Pooled,
    // the average improves whenever an old ticket is abandoned rather than
    // closed, which is exactly backwards.
    const a = ticketAgeing([
      row({ status: "closed", tatHours: 24 }),
      row({ status: "open", auditDate: "2026-01-01" }),
    ], NOW)
    expect(a.closed).toEqual({ days: 1, n: 1 })
    expect(a.ageing.find((x) => x.key === "open").n).toBe(1)
  })

  it("ages a rejected ticket rather than counting it as closed", () => {
    const a = ticketAgeing([row({ status: "rejected", auditDate: "2026-03-01" })], NOW)
    expect(a.closed.n).toBe(0)
    expect(a.ageing.find((x) => x.key === "rejected")).toMatchObject({ days: 30, n: 1 })
  })

  it("lists the waiting statuses in the order the rest of the page uses", () => {
    const a = ticketAgeing([
      row({ status: "rejected", auditDate: "2026-03-01" }),
      row({ status: "open", auditDate: "2026-03-01" }),
      row({ status: "on_hold", auditDate: "2026-03-01" }),
    ], NOW)
    expect(a.ageing.map((x) => x.key)).toEqual(["open", "on_hold", "rejected"])
  })

  it("omits a status nothing is sitting in, rather than drawing a zero", () => {
    const a = ticketAgeing([row({ status: "open", auditDate: "2026-03-01" })], NOW)
    expect(a.ageing.map((x) => x.key)).toEqual(["open"])
  })

  it("refuses a negative age from a future-dated row", () => {
    const a = ticketAgeing([row({ status: "open", auditDate: "2027-01-01" })], NOW)
    expect(a.ageing).toEqual([])
  })

  it("pools Open with In Progress, and keeps On Hold apart", () => {
    // Open and In Progress are one thing to the person asking: a ticket
    // somebody still owes work on. On Hold is deliberately parked, so its age
    // measures a decision rather than a delay and must not flatter the queue
    // that is actually running late.
    const a = ticketAgeing([
      row({ status: "open", auditDate: "2026-03-21" }),         // 10 days
      row({ status: "in_progress", auditDate: "2026-03-11" }),  // 20 days
      row({ status: "on_hold", auditDate: "2026-01-31" }),      // 59 days
    ], NOW)
    expect(a.openInProgress).toEqual({ days: 15, n: 2 })
    expect(a.onHold).toEqual({ days: 59, n: 1 })
  })

  it("leaves rejected out of both pools — finished, and never remediated", () => {
    const a = ticketAgeing([row({ status: "rejected", auditDate: "2026-03-01" })], NOW)
    expect(a.openInProgress.n).toBe(0)
    expect(a.onHold.n).toBe(0)
  })
  it("is empty rather than NaN for nothing at all", () => {
    expect(ticketAgeing([], NOW)).toEqual({
      closed: { days: null, n: 0 },
      openInProgress: { days: null, n: 0 },
      onHold: { days: null, n: 0 },
      ageing: [],
    })
  })
})

describe("ticketTrend accounts for rejected separately", () => {
  it("splits three ways so the parts add to the total", () => {
    const { series } = trend([
      row({ auditDate: "2026-03-02", status: "closed" }),
      row({ auditDate: "2026-03-03", status: "open" }),
      row({ auditDate: "2026-03-04", status: "rejected" }),
    ], "month")
    const b = series[0]
    expect(b).toMatchObject({ total: 3, closed: 1, open: 1, rejected: 1 })
    expect(b.closed + b.open + b.rejected).toBe(b.total)
  })

  it("does not count a rejection as still open", () => {
    const { series } = trend([row({ auditDate: "2026-03-02", status: "rejected" })], "month")
    expect(series[0].open).toBe(0)
  })
})

describe("auditPopulation — the audits, whichever question carried them", () => {
  const scored = (over) => row({ passPct: 80, passPctN7: 95, ...over })

  it("prefers the audits question when it has pass data", () => {
    const out = auditPopulation([scored({ site: "F" })], [scored({ site: "A" })])
    expect(out.source).toBe("audits")
    expect(out.rows[0].site).toBe("A")
  })

  it("falls back to the findings rows that carry a score", () => {
    // The real tenant this was found on: the audit question was configured
    // under `findings`, and the audits slot pointed at a card id that did not
    // exist. The N+7 tab drew 832 audits from this fallback while the Auditors
    // tab — which asked for `audits` directly — showed a 404.
    const out = auditPopulation([scored({ site: "F" }), row({ site: "ticket" })], [])
    expect(out.source).toBe("findings")
    expect(out.rows.map((r) => r.site)).toEqual(["F"])
  })

  it("takes only the findings rows that HAVE a score", () => {
    // A findings table where only failures are rows would otherwise report a
    // 0% pass rate with total confidence.
    expect(auditPopulation([row(), row()], []).source).toBe("none")
  })

  it("says none when neither question has anything", () => {
    expect(auditPopulation([], [])).toEqual({ rows: [], source: "none" })
    expect(auditPopulation()).toEqual({ rows: [], source: "none" })
  })

  it("gives the two tabs the same answer, which is the whole point", () => {
    const findings = [scored({ site: "A", auditor: "Asha" }), scored({ site: "B", auditor: "Dev" })]
    const out = auditPopulation(findings, [])
    // Whatever the N+7 tab counts, the Auditors tab attributes.
    expect(out.rows).toHaveLength(2)
    expect(auditorMatrix(out.rows, "region").total).toBe(2)
  })
})

// ── Observations per site, and who owns them ─────────────────────────────────

describe('ownerOf', () => {
  it('reads the three owners out of the L1 tag, however it is spelled', () => {
    // One team, three spellings in the warehouse. Matching literals would split
    // one owner across three bars.
    expect(ownerOf({ category: 'Safety and Security' })).toBe('sas')
    expect(ownerOf({ category: 'Safety & Security' })).toBe('sas')
    expect(ownerOf({ category: 'safety   &  security' })).toBe('sas')
    expect(ownerOf({ category: 'Facility' })).toBe('facility')
    expect(ownerOf({ category: 'Center Manager' })).toBe('cm')
    expect(ownerOf({ category: 'Center Management' })).toBe('cm')
    expect(ownerOf({ category: 'Center Manager SPOC' })).toBe('cm')
    expect(ownerOf({ category: 'Centre Manager' })).toBe('cm')
  })

  it('names an unmapped tag rather than dropping the ticket', () => {
    // A tag nobody has mapped is a tag somebody should look at.
    expect(ownerOf({ category: 'Projects' })).toBe('other')
    expect(ownerOf({ category: '' })).toBe('other')
    expect(ownerOf({})).toBe('other')
  })
})

describe('observationsPerSite', () => {
  const t = (over = {}) => row({ subCategory: '', ...over })

  it('counts observations per site, busiest first', () => {
    const out = observationsPerSite([
      t({ siteId: '', site: 'Alpha' }), t({ site: 'Alpha' }), t({ site: 'Beta' }),
    ])
    expect(out.sites.map((s) => [s.site, s.total])).toEqual([['Alpha', 2], ['Beta', 1]])
    expect(out.total).toBe(3)
    expect(out.siteCount).toBe(2)
  })

  it('splits each site by owner', () => {
    const out = observationsPerSite([
      t({ site: 'Alpha', category: 'Safety and Security' }),
      t({ site: 'Alpha', category: 'Facility' }),
      t({ site: 'Alpha', category: 'Center Manager SPOC' }),
      t({ site: 'Alpha', category: 'Something Else' }),
    ])
    expect(out.sites[0]).toMatchObject({ site: 'Alpha', total: 4, sas: 1, facility: 1, cm: 1, other: 1 })
    expect(out.byOwner).toEqual({ sas: 1, facility: 1, cm: 1, other: 1 })
  })

  it('respects a pre-grouped count column instead of counting rows', () => {
    const out = observationsPerSite([t({ site: 'Alpha', category: 'Facility', count: 5 })])
    expect(out.total).toBe(5)
    expect(out.sites[0].facility).toBe(5)
  })

  it('averages per site that HAS observations, not per site in the register', () => {
    // Dividing by the whole register would make a busy estate look quiet.
    const out = observationsPerSite([t({ site: 'Alpha' }), t({ site: 'Alpha' }), t({ site: 'Beta' })])
    expect(out.perSite).toBe(1.5)
  })

  it('names a site the data left blank rather than dropping its observations', () => {
    expect(observationsPerSite([t({ site: '', siteId: '' })]).sites[0].site).toBe('(not stated)')
  })
})

// ── FLS only, by L2 category ─────────────────────────────────────────────────

describe("isFls", () => {
  it("matches every FLS spelling the tag actually uses", () => {
    for (const v of ["FLS", "FLS - Detection", "FLS - Extinguisher", "FLS - Fire Detection", "FLS - General", "FLS - Signage"]) {
      expect(isFls({ subCategory: v }), v).toBe(true)
    }
  })

  it("does not match a category that merely contains the letters", () => {
    // startsWith, not includes: the tag is free text and a filter that widens
    // quietly later is worse than one that misses a new spelling loudly.
    expect(isFls({ subCategory: "Baffles" })).toBe(false)
    expect(isFls({ subCategory: "CCTV" })).toBe(false)
    expect(isFls({ subCategory: "" })).toBe(false)
  })
})

describe("flsCategories", () => {
  const NOW = Date.parse("2026-03-31T00:00:00Z")
  const t = (over = {}) => row({ subCategory: "FLS - Signage", ...over })

  it("keeps only FLS rows", () => {
    const out = flsCategories([t(), row({ subCategory: "CCTV" }), row({ subCategory: "Painting" })], NOW)
    expect(out.categories).toBe(1)
    expect(out.total).toBe(1)
  })

  it("counts open, in progress and closed per category", () => {
    const out = flsCategories([
      t({ status: "open" }), t({ status: "open" }),
      t({ status: "in_progress" }),
      t({ status: "closed", tatHours: 24 }),
    ], NOW)
    expect(out.rows[0]).toMatchObject({ name: "FLS - Signage", open: 2, inProgress: 1, closed: 1, total: 4 })
  })

  it("ages the open ones so far, and the closed one by how long it took", () => {
    const out = flsCategories([
      t({ status: "open", auditDate: "2026-03-21" }),        // 10 days so far
      t({ status: "in_progress", auditDate: "2026-03-11" }), // 20 days so far
      t({ status: "closed", tatHours: 48 }),                 // took 2 days
    ], NOW)
    expect(out.rows[0]).toMatchObject({ openDays: 10, inProgressDays: 20, closedDays: 2 })
  })

  it("counts on hold and rejected into the total but into no column", () => {
    // The three columns answer a question about the live queue. A category
    // whose columns do not add to its total says so in the total.
    const out = flsCategories([
      t({ status: "open" }), t({ status: "on_hold" }), t({ status: "rejected" }),
    ], NOW)
    expect(out.rows[0]).toMatchObject({ open: 1, inProgress: 0, closed: 0, other: 2, total: 3 })
  })

  it("splits by L2 category, busiest first", () => {
    const out = flsCategories([
      t({ subCategory: "FLS - Extinguisher" }), t({ subCategory: "FLS - Extinguisher" }),
      t({ subCategory: "FLS - Detection" }),
    ], NOW)
    expect(out.rows.map((r) => [r.name, r.total])).toEqual([["FLS - Extinguisher", 2], ["FLS - Detection", 1]])
  })

  it("measures days the same way the ageing panel does", () => {
    // One arithmetic, shared — two copies is how two figures on one page come
    // to disagree about the same ticket.
    const rows = [t({ status: "closed", tatHours: 72 }), t({ status: "open", auditDate: "2026-03-21" })]
    expect(flsCategories(rows, NOW).rows[0].closedDays).toBe(ticketAgeing(rows, NOW).closed.days)
  })
})

// ── Quarter on quarter ───────────────────────────────────────────────────────

describe("quarterName", () => {
  it("names the calendar quarters the way the audit planner does", () => {
    expect(quarterName("2026-Q1")).toBe("JFM 26")
    expect(quarterName("2026-Q2")).toBe("AMJ 26")
    expect(quarterName("2026-Q3")).toBe("JAS 26")
    expect(quarterName("2026-Q4")).toBe("OND 26")
  })

  it("hands back anything it does not recognise, rather than inventing one", () => {
    expect(quarterName("")).toBe("")
    expect(quarterName("2026-13")).toBe("2026-13")
  })
})

describe("quarterOnQuarter", () => {
  const NOW = Date.parse("2026-09-30T00:00:00Z")
  const t = (over = {}) => row({ subCategory: "FLS - Signage", ...over })

  it("buckets into calendar quarters, oldest first", () => {
    const out = quarterOnQuarter([
      t({ auditDate: "2026-08-10" }),   // JAS
      t({ auditDate: "2026-05-10" }),   // AMJ
    ], NOW)
    expect(out.quarters.map((q) => q.name)).toEqual(["AMJ 26", "JAS 26"])
  })

  it("compares the two most recent quarters", () => {
    const out = quarterOnQuarter([
      t({ auditDate: "2026-05-10", site: "A" }),
      t({ auditDate: "2026-08-10", site: "A" }),
      t({ auditDate: "2026-08-11", site: "B" }),
    ], NOW)
    expect(out.previous.name).toBe("AMJ 26")
    expect(out.latest.name).toBe("JAS 26")
    expect(out.changes.observations).toBe(1)   // 1 -> 2
  })

  it("has no comparison when the window covers one quarter, and says so", () => {
    // A change against a quarter that was never measured is worse than none.
    const out = quarterOnQuarter([t({ auditDate: "2026-08-10" })], NOW)
    expect(out.quarters).toHaveLength(1)
    expect(out.previous).toBe(null)
    expect(out.changes).toBe(null)
  })

  it("carries every headline metric into each quarter", () => {
    const out = quarterOnQuarter([
      t({ auditDate: "2026-08-10", status: "closed", tatHours: 48, category: "Facility" }),
      t({ auditDate: "2026-08-11", status: "open", category: "Safety and Security" }),
    ], NOW)
    const v = out.latest.values
    expect(v.observations).toBe(2)
    expect(v.facility).toBe(1)
    expect(v.sas).toBe(1)
    expect(v.ageClosed).toBe(2)
    expect(v.flsTotal).toBe(2)
    expect(v.flsClosed).toBe(1)
    expect(v.flsOpen).toBe(1)
  })

  it("ages an older quarter's open tickets up to NOW, not to its own end", () => {
    // A ticket raised in AMJ and still open has been waiting until today.
    const out = quarterOnQuarter([t({ auditDate: "2026-09-20", status: "open" })], NOW)
    expect(out.latest.values.ageLive).toBe(10)
  })

  it("counts undated tickets aside rather than into a quarter", () => {
    const out = quarterOnQuarter([t({ auditDate: "" }), t({ auditDate: "2026-08-10" })], NOW)
    expect(out.undated).toBe(1)
    expect(out.quarters).toHaveLength(1)
  })

  it("is empty, not broken, for no rows at all", () => {
    const out = quarterOnQuarter([], NOW)
    expect(out).toMatchObject({ quarters: [], latest: null, previous: null, changes: null, undated: 0 })
  })
})

describe("quarterSpans", () => {
  const at = (iso) => Date.parse(iso + "T00:00:00Z")

  it("returns three quarters by default, oldest first, ending in this one", () => {
    const s = quarterSpans(at("2026-09-09"))
    expect(s.all.map((q) => q.name)).toEqual(["JFM 26", "AMJ 26", "JAS 26"])
    expect(s.current.name).toBe("JAS 26")
    expect(s.previous.name).toBe("AMJ 26")
  })

  it("ends past quarters on their own last day and the current one today", () => {
    const s = quarterSpans(at("2026-09-09"))
    expect(s.all[0]).toMatchObject({ from: "2026-01-01", to: "2026-03-31", partial: false })
    expect(s.all[1]).toMatchObject({ from: "2026-04-01", to: "2026-06-30", partial: false })
    expect(s.all[2]).toMatchObject({ from: "2026-07-01", to: "2026-09-09", partial: true })
  })

  it("steps back across the year boundary", () => {
    const s = quarterSpans(at("2026-01-15"))
    expect(s.all.map((q) => q.name)).toEqual(["JAS 25", "OND 25", "JFM 26"])
    expect(s.all[0]).toMatchObject({ from: "2025-07-01", to: "2025-09-30" })
  })

  it("ends a quarter on its real last day, leap years included", () => {
    // Derived as "day 0 of the next quarter, less one" rather than from month
    // lengths, so February needs no special case.
    expect(quarterSpans(at("2024-05-01")).previous).toMatchObject({ from: "2024-01-01", to: "2024-03-31", days: 91 })
    expect(quarterSpans(at("2026-05-01")).previous).toMatchObject({ from: "2026-01-01", to: "2026-03-31", days: 90 })
  })

  it("handles the first day of a quarter without going negative", () => {
    expect(quarterSpans(at("2026-07-01")).current).toMatchObject({ from: "2026-07-01", to: "2026-07-01", days: 1, partial: true })
  })

  it("marks a finished quarter as complete", () => {
    expect(quarterSpans(at("2026-12-31")).current.partial).toBe(false)
  })

  it("keeps every span inside one quarter, so each fits one response", () => {
    for (const day of ["2026-03-31", "2026-06-30", "2026-09-30", "2026-12-31"]) {
      for (const q of quarterSpans(at(day)).all) expect(q.days, day + " " + q.name).toBeLessThanOrEqual(92)
    }
  })

  it("takes a count, for a panel that wants more or fewer", () => {
    expect(quarterSpans(at("2026-09-09"), 1).all.map((q) => q.name)).toEqual(["JAS 26"])
    expect(quarterSpans(at("2026-09-09"), 4).all.map((q) => q.name)).toEqual(["OND 25", "JFM 26", "AMJ 26", "JAS 26"])
    expect(quarterSpans(at("2026-09-09"), 1).previous).toBe(null)
  })
})

describe("quarterSeries", () => {
  const NOW = Date.parse("2026-09-09T00:00:00Z")
  const t = (over = {}) => row({ subCategory: "FLS - Signage", ...over })

  it("always has every quarter, whatever the reader's window was", () => {
    const spans = quarterSpans(NOW)
    const out = quarterSeries([[t()], [t(), t()], [t(), t(), t()]], spans, NOW)
    expect(out.quarters.map((q) => [q.name, q.values.observations]))
      .toEqual([["JFM 26", 1], ["AMJ 26", 2], ["JAS 26", 3]])
  })

  it("changes against the most recent step, not across the whole series", () => {
    const out = quarterSeries([[t()], [t(), t()], [t(), t(), t()]], quarterSpans(NOW), NOW)
    expect(out.changes.observations).toBe(1)   // AMJ 2 -> JAS 3, not JFM 1 -> JAS 3
  })

  it("carries the partial flag through, so the column can say so", () => {
    const out = quarterSeries([[t()], [t()], [t()]], quarterSpans(NOW), NOW)
    expect(out.latest.partial).toBe(true)
    expect(out.previous.partial).toBe(false)
  })

  it("treats a quarter with no tickets as a real zero, not a gap", () => {
    const out = quarterSeries([[t()], [], [t()]], quarterSpans(NOW), NOW)
    expect(out.previous.values.observations).toBe(0)
    expect(out.changes.observations).toBe(1)
  })

  it("splits each quarter by owner, and per site", () => {
    const q = [
      t({ site: "A", category: "Safety and Security" }),
      t({ site: "A", category: "Facility" }),
      t({ site: "B", category: "Center Manager" }),
      t({ site: "B", category: "Facility" }),
    ]
    const out = quarterSeries([[], [], q], quarterSpans(NOW), NOW)
    const v = out.latest.values
    expect([v.sas, v.facility, v.cm]).toEqual([1, 2, 1])
    // Two sites, so each owner's per-site figure is its count over 2 — and the
    // three sum to the overall per-site figure.
    expect([v.sasPerSite, v.facilityPerSite, v.cmPerSite]).toEqual([0.5, 1, 0.5])
    expect(v.perSite).toBe(2)
  })
})
