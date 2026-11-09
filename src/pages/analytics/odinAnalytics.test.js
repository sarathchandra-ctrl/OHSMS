import { describe, it, expect } from 'vitest'
import {
  resolveOdinRows, odinFacets, filterOdinRows, statusTotals, statusByRegion,
  bySubCategory, sitePins, cityPins, siteIssues, leadStatus, passRates, odinAnalytics,
  STATUS_KEYS, TERMINAL_STATUSES, isTerminal, isOutstanding, paletteColor, day0Of, n7Of, checksTotalOf, passTotals, PASS_MARK,
  auditPopulation,
} from './odinAnalytics'
import { day0Of as sharedDay0, auditPopulation as sharedPop } from '../../../stack/lib/auditScore.js'
import { resolveOdinRows as sharedJoin } from '../../../stack/lib/odinJoin.js'

// The shape stack/lib/metabase.js hands back, with the fields a test needs.
const finding = (over = {}) => ({
  siteId: '', site: 'Plant 2', region: 'South', entity: 'Retail',
  status: 'open', rawStatus: 'Open', category: '', subCategory: 'Blocked fire exit',
  auditDate: '2026-03-14', closedDate: '', lat: null, lng: null, count: 1,
  passPct: null, passPctN7: null, checksPassed: null, checksTotal: null, extra: {},
  ...over,
})

const audit = (over = {}) => finding({ subCategory: '', status: 'closed', passPct: 90, passPctN7: 96, ...over })

const SITES = [
  { id: 's1', name: 'Plant 2', region: 'South', entity: 'Retail', lat: 12.97, lng: 77.59 },
  { id: 's2', name: 'Depot 7', region: 'North', entity: 'Logistics', lat: 28.61, lng: 77.21 },
  { id: 's3', name: 'No Coords Yard', region: 'West', entity: 'Retail' },
]

describe('the dashboard and the site lookup share one implementation', () => {
  it('re-exports the functions the bot scores with', () => {
    // A second copy is how two screens once disagreed about the same audits.
    // Identity, not a matching result, is what fails if someone pastes them back.
    expect(day0Of).toBe(sharedDay0)
    expect(auditPopulation).toBe(sharedPop)
    expect(resolveOdinRows).toBe(sharedJoin)
  })
})

describe('the statuses are a contract with the server', () => {
  it('is exactly the five the dashboard draws, in escalation order', () => {
    // stack/lib/metabase.js normalizes onto these keys. If either side
    // renames one, every bar for that status silently becomes zero.
    //
    // `rejected` is the fifth and was added late: on a real ticket dump it was
    // 853 of 31,282 rows, all landing in 'unknown' and drawn on no bar at all.
    expect(STATUS_KEYS).toEqual(['open', 'in_progress', 'on_hold', 'closed', 'rejected'])
  })

  it('agrees with the server on which statuses are finished', () => {
    // Terminal means nothing further happens. Rejected belongs here — it is
    // not open — while emphatically NOT being a closure, which would credit a
    // remediation that never took place.
    expect(TERMINAL_STATUSES).toEqual(['closed', 'rejected'])
    expect(isTerminal('rejected')).toBe(true)
    expect(isTerminal('closed')).toBe(true)
    expect(isOutstanding('open')).toBe(true)
    expect(isOutstanding('in_progress')).toBe(true)
    expect(isOutstanding('on_hold')).toBe(true)
    expect(isOutstanding('rejected')).toBe(false)
  })
})

describe('resolveOdinRows', () => {
  it('places a site from the register when the question has no coordinates', () => {
    // Asking an organization to add lat/lng to their warehouse to see a map is
    // asking them to duplicate a register they already maintain here.
    const [r] = resolveOdinRows([finding()], SITES)
    expect(r.lat).toBeCloseTo(12.97)
    expect(r.placedFrom).toBe('register')
  })

  it('prefers an exact site id over a name', () => {
    const [r] = resolveOdinRows([finding({ siteId: 's2', site: 'Plant 2' })], SITES)
    expect(r.lat).toBeCloseTo(28.61)
  })

  it('matches a name regardless of case and stray spacing', () => {
    expect(resolveOdinRows([finding({ site: '  plant 2 ' })], SITES)[0].placedFrom).toBe('register')
  })

  it('keeps coordinates the question DID supply', () => {
    const [r] = resolveOdinRows([finding({ lat: 1, lng: 2 })], SITES)
    expect(r.lat).toBe(1)
    expect(r.placedFrom).toBe('query')
  })

  it('never overwrites a region the warehouse stated', () => {
    // The warehouse is the system of record for the finding. Quietly replacing
    // what it said with what our register believes is how two dashboards start
    // disagreeing with each other.
    const [r] = resolveOdinRows([finding({ region: 'Central' })], SITES)
    expect(r.region).toBe('Central')
  })

  it('fills a region the warehouse left blank', () => {
    expect(resolveOdinRows([finding({ region: '' })], SITES)[0].region).toBe('South')
  })

  it('leaves a row alone when nothing matches, rather than dropping it', () => {
    const [r] = resolveOdinRows([finding({ site: 'Somewhere Else' })], SITES)
    expect(r.site).toBe('Somewhere Else')
    expect(r.lat).toBe(null)
    expect(r.placedFrom).toBe('')
  })
})

describe('statusTotals', () => {
  it('counts the four, and respects a pre-grouped count column', () => {
    const t = statusTotals([
      finding({ status: 'open', count: 3 }),
      finding({ status: 'closed' }),
      finding({ status: 'on_hold', count: 2 }),
    ])
    expect(t.open).toBe(3)
    expect(t.closed).toBe(1)
    expect(t.on_hold).toBe(2)
    expect(t.total).toBe(6)
  })

  it('counts an unrecognised status separately and names it', () => {
    // Folding it into Open produces a chart that is confidently wrong, and a
    // chart nobody can tell is wrong is the worst thing this could produce.
    const t = statusTotals([finding({ status: 'unknown', rawStatus: 'Escalated to legal' })])
    expect(t.open).toBe(0)
    expect(t.unknown).toBe(1)
    expect(t.unknownLabels).toEqual(['Escalated to legal'])
  })
})

describe('statusByRegion', () => {
  const rows = [
    finding({ region: 'South', status: 'open' }),
    finding({ region: 'South', status: 'closed' }),
    finding({ region: 'North', status: 'on_hold' }),
    finding({ region: 'South', status: 'in_progress' }),
  ]

  it('gives each region its four counts', () => {
    const south = statusByRegion(rows).find((r) => r.region === 'South')
    expect(south).toMatchObject({ open: 1, in_progress: 1, on_hold: 0, closed: 1, total: 3 })
  })

  it('puts the busiest region first, because that is the meeting', () => {
    expect(statusByRegion(rows).map((r) => r.region)).toEqual(['South', 'North'])
  })

  it('keeps findings that name no region, under a bucket that says so', () => {
    // "Eleven findings we cannot attribute to a region" is itself a finding.
    const out = statusByRegion([...rows, finding({ region: '' })])
    expect(out.find((r) => r.region === '(not stated)').total).toBe(1)
  })
})

describe('bySubCategory', () => {
  const rows = [
    finding({ subCategory: 'Blocked fire exit' }),
    finding({ subCategory: 'Blocked fire exit' }),
    finding({ subCategory: 'Missing extinguisher' }),
    finding({ subCategory: '' }),
  ]

  it('ranks by count and colours stably', () => {
    const out = bySubCategory(rows)
    expect(out[0]).toMatchObject({ name: 'Blocked fire exit', value: 2, color: paletteColor(0) })
  })

  it('names the findings whose sub-category was never filled in', () => {
    expect(bySubCategory(rows).find((d) => d.name === '(not stated)').value).toBe(1)
  })

  it('folds the tail into one slice for the pie, without losing the count', () => {
    // Twenty slices is a colour wheel, not a chart. The bar chart takes them
    // all; only the pie is capped.
    const many = Array.from({ length: 12 }, (_, i) => finding({ subCategory: `Cat ${i}` }))
    const out = bySubCategory(many, { limit: 8 })
    expect(out).toHaveLength(9)
    expect(out.at(-1).name).toMatch(/^Other \(4 sub-categories\)$/)
    expect(out.reduce((n, d) => n + d.value, 0)).toBe(12)
  })
})

describe('sitePins', () => {
  it('is one pin per site, carrying its status mix', () => {
    const rows = resolveOdinRows([
      finding({ siteId: 's1', status: 'open' }),
      finding({ siteId: 's1', status: 'closed' }),
      finding({ siteId: 's2', status: 'on_hold' }),
    ], SITES)
    const { pins } = sitePins(rows)
    expect(pins).toHaveLength(2)
    expect(pins[0].total).toBe(2)
    expect(pins[0].byStatus.open).toBe(1)
  })

  it('reports the sites it could not place instead of dropping them', () => {
    // A map showing eleven of nineteen sites, saying nothing, is read as
    // showing all nineteen.
    const rows = resolveOdinRows([finding({ siteId: 's3', site: 'No Coords Yard' })], SITES)
    const { pins, unplaced } = sitePins(rows)
    expect(pins).toHaveLength(0)
    expect(unplaced[0]).toMatchObject({ site: 'No Coords Yard', total: 1 })
  })

  it('puts the site with the most findings first', () => {
    const rows = resolveOdinRows([
      finding({ siteId: 's2' }), finding({ siteId: 's1' }), finding({ siteId: 's1' }),
    ], SITES)
    expect(sitePins(rows).pins[0].id).toBe('s1')
  })
})

describe('cityPins', () => {
  it('places a city from the sites in it that DO have coordinates', () => {
    // The whole point: a site with no latitude still reaches the map through
    // its city, as long as one site in that city is located. On real data that
    // was the difference between dropping 76 sites and dropping almost none.
    const rows = resolveOdinRows([
      finding({ siteId: 's1', city: 'Bengaluru' }),                        // located
      finding({ siteId: 's3', site: 'No Coords Yard', city: 'Bengaluru' }), // not
    ], SITES)
    expect(sitePins(rows).unplaced).toHaveLength(1)
    const { pins, unplaced } = cityPins(rows)
    expect(unplaced).toHaveLength(0)
    expect(pins[0]).toMatchObject({ city: 'Bengaluru', total: 2, sites: 2 })
    expect(pins[0].lat).toBeCloseTo(12.97)
  })

  it('puts the pin at the mean of its located sites', () => {
    const rows = resolveOdinRows([
      finding({ siteId: 's1', city: 'Everywhere' }),
      finding({ siteId: 's2', city: 'Everywhere' }),
    ], SITES)
    const [pin] = cityPins(rows).pins
    expect(pin.lat).toBeCloseTo((12.97 + 28.61) / 2)
    expect(pin.lng).toBeCloseTo((77.59 + 77.21) / 2)
  })

  it('reports a city where nothing at all is located, rather than dropping it', () => {
    const rows = resolveOdinRows([finding({ siteId: 's3', site: 'No Coords Yard', city: 'Nowhere' })], SITES)
    const { pins, unplaced } = cityPins(rows)
    expect(pins).toHaveLength(0)
    expect(unplaced[0]).toMatchObject({ city: 'Nowhere', total: 1 })
  })

  it('groups case- and spacing-insensitively, so one city is one pin', () => {
    const rows = resolveOdinRows([
      finding({ siteId: 's1', city: 'Bengaluru' }),
      finding({ siteId: 's1', city: '  bengaluru ' }),
    ], SITES)
    expect(cityPins(rows).pins).toHaveLength(1)
    expect(cityPins(rows).pins[0].total).toBe(2)
  })

  it('busiest city first', () => {
    const rows = resolveOdinRows([
      finding({ siteId: 's2', city: 'Delhi' }),
      finding({ siteId: 's1', city: 'Bengaluru' }),
      finding({ siteId: 's1', city: 'Bengaluru' }),
    ], SITES)
    expect(cityPins(rows).pins.map((p) => p.city)).toEqual(['Bengaluru', 'Delhi'])
  })
})

describe('siteIssues', () => {
  it('includes a site with no coordinates — the whole reason it replaced the map', () => {
    // sitePins drops this site into `unplaced` and the map never draws it. The
    // list has no such requirement, and on real data that was 76 sites.
    const rows = resolveOdinRows([finding({ siteId: 's3', site: 'No Coords Yard' })], SITES)
    expect(sitePins(rows).pins).toHaveLength(0)
    expect(siteIssues(rows).map((r) => r.site)).toEqual(['No Coords Yard'])
  })

  it('ranks by issue count, because the question is where the work is', () => {
    const rows = resolveOdinRows([
      finding({ siteId: 's2' }), finding({ siteId: 's1' }), finding({ siteId: 's1' }),
    ], SITES)
    const out = siteIssues(rows)
    expect(out[0]).toMatchObject({ id: 's1', total: 2 })
    expect(out[1]).toMatchObject({ id: 's2', total: 1 })
  })

  it('counts rejected as neither open nor closed, matching the KPI row', () => {
    const rows = resolveOdinRows([
      finding({ siteId: 's1', status: 'open' }),
      finding({ siteId: 's1', status: 'closed' }),
      finding({ siteId: 's1', status: 'rejected' }),
    ], SITES)
    expect(siteIssues(rows)[0]).toMatchObject({ total: 3, open: 1, closed: 1 })
  })

  it('counts an SLA breach off whatever wording the warehouse used', () => {
    const rows = resolveOdinRows([
      finding({ siteId: 's1', sla: 'open-SLA-Breached' }),
      finding({ siteId: 's1', sla: 'Closed- Within SLA' }),
    ], SITES)
    expect(siteIssues(rows)[0].breached).toBe(1)
  })

  it('accounts for every row — no site is dropped for any reason', () => {
    const rows = resolveOdinRows([
      finding({ siteId: 's1' }), finding({ siteId: 's3', site: 'No Coords Yard' }),
      finding({ siteId: '', site: 'Not In The Register' }),
    ], SITES)
    expect(siteIssues(rows).reduce((n, r) => n + r.total, 0)).toBe(3)
  })
})

describe('leadStatus', () => {
  it('colours a pin by the worst status it actually has', () => {
    expect(leadStatus({ open: 1, in_progress: 5, on_hold: 0, closed: 9 })).toBe('open')
    expect(leadStatus({ open: 0, in_progress: 0, on_hold: 2, closed: 9 })).toBe('on_hold')
    expect(leadStatus({ open: 0, in_progress: 0, on_hold: 0, closed: 9 })).toBe('closed')
  })
})

describe('passRates', () => {
  it('is the SHARE of audits at or above the mark, not the mean of their scores', () => {
    // The bug this replaced: eleven audits averaging 78% with one of them at or
    // above the mark drew a bar reading "78%" on a chart headed "Pass rate",
    // beside a table saying 1 of 11. Both numbers were right; only one of them
    // is a pass rate.
    const out = passRates([
      audit({ region: 'South', passPct: 95, passPctN7: 95 }),
      ...Array.from({ length: 10 }, () => audit({ region: 'South', passPct: 76, passPctN7: 76 })),
    ], 'region')
    expect(out[0].audits).toBe(11)
    expect(out[0].n7).toBe(9.1)          // 1 of 11 cleared 90
    expect(out[0].n7Avg).toBeCloseTo(77.7, 1)   // ...and the mean is ~78
  })

  it('agrees with the pass counts printed beside it', () => {
    const out = passRates([
      audit({ region: 'South', passPctN7: 95 }),
      audit({ region: 'South', passPctN7: 60 }),
    ], 'region')
    expect(out[0].n7).toBe(50)
    expect([out[0].auditsPassed, out[0].auditsFailed, out[0].n7Audits]).toEqual([1, 1, 2])
  })

  it('treats a score exactly at the mark as a pass', () => {
    expect(passRates([audit({ region: 'South', passPctN7: PASS_MARK })], 'region')[0].n7).toBe(100)
  })

  it('keeps the mean score alongside, because a pass rate flattens it', () => {
    // Eleven audits at 89 and eleven at 12 are both a 0% pass rate, and a
    // reader deciding where to send someone needs to tell those apart.
    const near = passRates([audit({ region: 'S', passPct: 89, passPctN7: 89 })], 'region')[0]
    const far = passRates([audit({ region: 'S', passPct: 12, passPctN7: 12 })], 'region')[0]
    expect([near.n7, far.n7]).toEqual([0, 0])
    expect([near.n7Avg, far.n7Avg]).toEqual([89, 12])
  })

  it('no longer weights by audit size — a pass rate counts audits, not checks', () => {
    // Weighting answers "what share of CHECKS passed", which is a third
    // measurement. The check counts are still carried for the tooltip.
    const out = passRates([
      audit({ region: 'South', passPct: 100, checksPassed: 4, checksTotal: 4, passPctN7: 100 }),
      audit({ region: 'South', passPct: 50, checksPassed: 200, checksTotal: 400, passPctN7: 60 }),
    ], 'region')
    expect(out[0].basis).toBe('share')
    expect(out[0].n7).toBe(50)                  // one of the two cleared the mark
    expect(out[0].checks).toBe(404)             // still there for the tooltip
  })

  it('reports what the seven days bought, in pass-rate points', () => {
    const out = passRates([
      audit({ region: 'South', passPct: 82, passPctN7: 94 }),
    ], 'region')
    // 0% cleared the mark on the day, 100% after seven days.
    expect(out[0].day0).toBe(0)
    expect(out[0].n7).toBe(100)
    expect(out[0].delta).toBe(100)
  })

  it('separates "not re-checked yet" from "re-checked and scored badly"', () => {
    // A group whose N+7 has not happened must not read as one that failed it.
    const out = passRates([
      audit({ region: 'South', passPct: 82, passPctN7: null }),
      audit({ region: 'South', passPct: 90, passPctN7: 95 }),
    ], 'region')
    expect(out[0].audits).toBe(2)
    expect(out[0].n7Audits).toBe(1)
    expect(out[0].n7).toBe(100)   // the one that WAS re-checked cleared the mark
  })

  it('groups by entity just as readily as by region', () => {
    const out = passRates([
      audit({ entity: 'Retail', passPct: 95 }),
      audit({ entity: 'Logistics', passPct: 60 }),
    ], 'entity')
    // Worst first: this list exists to be acted on from the top.
    expect(out.map((r) => r.name)).toEqual(['Logistics', 'Retail'])
  })

  it('names a group the data left blank rather than dropping its audits', () => {
    expect(passRates([audit({ region: '' })], 'region')[0].name).toBe('(not stated)')
  })
})

describe('filterOdinRows', () => {
  const rows = [
    finding({ region: 'South', entity: 'Retail', status: 'open', auditDate: '2026-01-10' }),
    finding({ region: 'North', entity: 'Logistics', status: 'closed', auditDate: '2026-03-10' }),
    finding({ region: 'South', entity: 'Retail', status: 'closed', auditDate: '' }),
  ]

  it('narrows on each dimension independently', () => {
    expect(filterOdinRows(rows, { region: 'South' })).toHaveLength(2)
    expect(filterOdinRows(rows, { status: 'closed' })).toHaveLength(2)
    expect(filterOdinRows(rows, { entity: 'Logistics' })).toHaveLength(1)
  })

  it('takes a month range inclusively at both ends', () => {
    expect(filterOdinRows(rows, { from: '2026-02', to: '2026-03' })).toHaveLength(2)
    expect(filterOdinRows(rows, { from: '2026-03', to: '2026-03' })).toHaveLength(2)
  })

  it('does not hide an undated finding behind a date filter', () => {
    // Filtering it away silently removes it from every total the moment anyone
    // touches the range. An undated finding is a problem to be seen.
    const out = filterOdinRows(rows, { from: '2026-03', to: '2026-03' })
    expect(out.some((r) => r.auditDate === '')).toBe(true)
  })
})

describe('odinAnalytics', () => {
  it('draws every panel from one filtered population', () => {
    const rows = [
      finding({ siteId: 's1', region: 'South', status: 'open' }),
      finding({ siteId: 's2', region: 'North', status: 'closed' }),
    ]
    const a = odinAnalytics(rows, [], SITES, { region: 'South' })
    expect(a.totals.total).toBe(1)
    expect(a.byRegion).toHaveLength(1)
    expect(a.pins).toHaveLength(1)
  })

  it('does not let a status filter shrink the pass-rate population', () => {
    // Status is a property of a finding, not of an audit. Applying it to the
    // audits question would make the pass rate change every time somebody
    // clicked a status, for no reason a reader could work out.
    const audits = [audit({ region: 'South', passPct: 80 }), audit({ region: 'North', passPct: 60 })]
    const a = odinAnalytics([], audits, SITES, { status: 'open' })
    expect(a.auditCount).toBe(2)
    expect(a.passByRegion).toHaveLength(2)
  })

  it('still applies region and month to the audits, which they do share', () => {
    const audits = [audit({ region: 'South', passPct: 80 }), audit({ region: 'North', passPct: 60 })]
    expect(odinAnalytics([], audits, SITES, { region: 'South' }).auditCount).toBe(1)
  })
})

describe('odinFacets', () => {
  it('offers every value in the data, sorted, not the filtered set', () => {
    const out = odinFacets([
      finding({ region: 'South', entity: 'Retail', subCategory: 'B', auditDate: '2026-03-01' }),
      finding({ region: 'North', entity: 'Retail', subCategory: 'A', auditDate: '2026-01-01' }),
    ])
    expect(out.regions).toEqual(['North', 'South'])
    expect(out.entities).toEqual(['Retail'])
    expect(out.subCategories).toEqual(['A', 'B'])
    expect(out.months).toEqual(['2026-01', '2026-03'])
  })

  it('never offers a blank as a choice', () => {
    expect(odinFacets([finding({ region: '', entity: '', subCategory: '', auditDate: '' })])).toEqual({
      regions: [], entities: [], subCategories: [], months: [], sources: [],
      cities: [], ownerships: [], businessLines: [], centerTypes: [], auditTypes: [], priorities: [],
      minDate: '', maxDate: '',
    })
  })

  it('reports the span the data actually covers, for the date pickers', () => {
    const f = odinFacets([
      finding({ auditDate: '2026-03-14' }),
      finding({ auditDate: '2026-01-02' }),
      finding({ auditDate: '2026-07-30' }),
      finding({ auditDate: '' }),
    ])
    expect(f.minDate).toBe('2026-01-02')
    expect(f.maxDate).toBe('2026-07-30')
  })
})

describe('site scoping', () => {
  // `sites` is the list the viewer may SEE, not the whole register. A row that
  // matches none of them is either another region's or a spelling our register
  // does not carry, and from here the two are indistinguishable.
  const rows = [
    finding({ siteId: 's1' }),
    finding({ siteId: 'not-in-my-grant', site: 'Somewhere Else' }),
  ]

  it('keeps an unmatched row for someone who can see every site', () => {
    // For them it is a spelling mismatch, and dropping it loses a real finding
    // from every total on the page.
    expect(resolveOdinRows(rows, SITES, { keepUnplaced: true })).toHaveLength(2)
  })

  it('drops it for someone whose site list is a subset', () => {
    // Showing them another region's findings because a join failed is the
    // scoping mistake this page is most exposed to.
    const out = resolveOdinRows(rows, SITES, { keepUnplaced: false })
    expect(out).toHaveLength(1)
    expect(out[0].siteId).toBe('s1')
  })

  it('scopes the audits question the same way', () => {
    const audits = [
      audit({ siteId: 's1', passPct: 90 }),
      audit({ siteId: 'elsewhere', site: 'Somewhere Else', passPct: 10 }),
    ]
    expect(odinAnalytics([], audits, SITES, {}, { keepUnplaced: false }).auditCount).toBe(1)
  })

  it('defaults to keeping, so nothing silently narrows without being asked', () => {
    expect(resolveOdinRows(rows, SITES)).toHaveLength(2)
  })
})

describe('pass and fail as counts', () => {
  // The second shape a warehouse states an audit result in: not a percentage,
  // but how many checks passed and how many failed. It is the better input,
  // because it carries the SIZE of the audit.
  const counted = (over = {}) => finding({ subCategory: '', status: 'closed', ...over })

  it('reads a pass rate straight out of a pass/fail pair', () => {
    expect(day0Of(counted({ checksPassed: 8, checksFailed: 2, checksTotal: 10 }))).toBeCloseTo(80)
  })

  it('prefers a stated percentage over the counts, where both are given', () => {
    // The question said what it meant. Recomputing behind it would make ODIN
    // and Metabase disagree about the same audit.
    expect(day0Of(counted({ passPct: 91, checksPassed: 8, checksFailed: 2, checksTotal: 10 }))).toBe(91)
  })

  it('derives nothing from half a pair', () => {
    expect(checksTotalOf(counted({ checksPassed: 8 }))).toBe(null)
    expect(day0Of(counted({ checksPassed: 8 }))).toBe(null)
  })

  it('reads the N+7 re-check from counts too', () => {
    expect(n7Of(counted({ checksPassedN7: 9, checksFailedN7: 1, checksTotalN7: 10 }))).toBeCloseTo(90)
  })

  it('rates a group stated only as counts by how many audits cleared the mark', () => {
    // The check counts still ride along for the tooltip, but the BAR counts
    // audits: one of these two scored 100%, the other 50%.
    const out = passRates([
      counted({ region: 'South', checksPassed: 4, checksFailed: 0, checksTotal: 4 }),
      counted({ region: 'South', checksPassed: 200, checksFailed: 200, checksTotal: 400 }),
    ], 'region')
    expect(out[0].basis).toBe('share')
    expect(out[0].day0).toBe(50)
    expect(out[0].day0Avg).toBeCloseTo(75, 1)
    expect(out[0].passed).toBe(204)
    expect(out[0].failed).toBe(200)
    expect(out[0].checks).toBe(404)
  })

  it('carries the raw counts onto the bar, so a percentage can be checked', () => {
    const out = passRates([counted({ region: 'South', checksPassed: 412, checksFailed: 88, checksTotal: 500 })], 'region')
    expect(out[0]).toMatchObject({ passed: 412, failed: 88, checks: 500 })
    // 82.4% is the audit's SCORE, and it is below the mark, so 0% of the
    // group's audits passed. Both numbers are carried.
    expect(out[0].day0Avg).toBeCloseTo(82.4, 1)
    expect(out[0].day0).toBe(0)
  })

  it('rates a mixed group the same way, size or no size', () => {
    // Audit size no longer changes the bar at all, so a group where only some
    // audits carry check counts needs no special case and gets no caveat.
    const out = passRates([
      counted({ region: 'South', checksPassed: 4, checksFailed: 0, checksTotal: 4 }),
      counted({ region: 'South', passPct: 50 }),
    ], 'region')
    expect(out[0].basis).toBe('share')
    expect(out[0].day0).toBe(50)
    expect(out[0].day0Avg).toBe(75)
  })
})

describe('passTotals', () => {
  const a = (over = {}) => finding({ subCategory: '', status: 'closed', ...over })

  it('adds the checks up and reports the weighted rate', () => {
    const t = passTotals([
      a({ checksPassed: 412, checksFailed: 88, checksTotal: 500 }),
      a({ checksPassed: 90, checksFailed: 10, checksTotal: 100 }),
    ])
    expect(t).toMatchObject({ passed: 502, failed: 98, checks: 600, counted: 2, basis: 'weighted' })
    expect(t.pct).toBeCloseTo(83.7, 1)
  })

  it('infers the failures from the total when only the passes were given', () => {
    expect(passTotals([a({ checksPassed: 90, checksTotal: 100 })])).toMatchObject({ passed: 90, failed: 10 })
  })

  it('falls back to a mean of percentages when nothing carries counts', () => {
    const t = passTotals([a({ passPct: 80 }), a({ passPct: 60 })])
    expect(t).toMatchObject({ checks: 0, counted: 0, pct: 70, basis: 'mean' })
  })

  it('says how many audits had countable checks, so a partial denominator shows', () => {
    const t = passTotals([a({ checksPassed: 9, checksFailed: 1 }), a({ passPct: 50 })])
    expect(t.counted).toBe(1)
    expect(t.audits).toBe(2)
  })

  it('is empty rather than broken with nothing to add up', () => {
    expect(passTotals([])).toMatchObject({ passed: 0, failed: 0, checks: 0, pct: null })
  })
})

describe('where the pass rates come from', () => {
  const withPass = (over = {}) => finding({ checksPassed: 9, checksFailed: 1, checksTotal: 10, ...over })

  it('uses the audits question when it carries pass data', () => {
    const a = odinAnalytics([withPass()], [withPass({ region: 'North', passPct: 55 })], SITES, {})
    expect(a.passSource).toBe('audits')
    expect(a.passByRegion.map((r) => r.name)).toEqual(['North'])
  })

  it('falls back to the findings question when the audits one has none', () => {
    // Plenty of warehouses hold one row per checklist line, with the pass or
    // fail beside the finding. Demanding a second saved question to unlock a
    // chart the data already supports is a configuration tax.
    const a = odinAnalytics([withPass({ region: 'South' })], [], SITES, {})
    expect(a.passSource).toBe('findings')
    expect(a.passByRegion[0]).toMatchObject({ name: 'South', passed: 9, failed: 1 })
  })

  it('uses only the findings rows that actually carry a pass figure', () => {
    // A findings table where only the failures are rows would otherwise report
    // a 0% pass rate with total confidence.
    const a = odinAnalytics([withPass({ region: 'South' }), finding({ region: 'South' })], [], SITES, {})
    expect(a.passRowCount).toBe(1)
    // 90 is the score; the mark is 90, so that single audit passes -> 100%.
    expect(a.passByRegion[0].day0).toBe(100)
    expect(a.passByRegion[0].day0Avg).toBe(90)
  })

  it('says there is no source rather than drawing an empty chart', () => {
    const a = odinAnalytics([finding()], [], SITES, {})
    expect(a.passSource).toBe('none')
    expect(a.passByRegion).toEqual([])
  })

  it('gives the overall pass and fail totals alongside the breakdowns', () => {
    const a = odinAnalytics([withPass({ region: 'South' }), withPass({ region: 'North' })], [], SITES, {})
    expect(a.passOverall).toMatchObject({ passed: 18, failed: 2, checks: 20, pct: 90 })
  })
})

describe('rows from several Metabase instances', () => {
  const from = (sourceId, sourceLabel, over = {}) => finding({ sourceId, sourceLabel, ...over })
  const rows = [
    from('grp', 'Group', { region: 'South' }),
    from('grp', 'Group', { region: 'South' }),
    from('acq', 'Acquired region', { region: 'North' }),
  ]

  it('offers each instance as a filter, by the name it was given', () => {
    expect(odinFacets(rows).sources).toEqual([
      { id: 'acq', label: 'Acquired region' },
      { id: 'grp', label: 'Group' },
    ])
  })

  it('offers nothing when the rows carry no instance — one Metabase needs no picker', () => {
    expect(odinFacets([finding()]).sources).toEqual([])
  })

  it('narrows to one instance', () => {
    expect(filterOdinRows(rows, { source: 'grp' })).toHaveLength(2)
  })

  it('merges every instance by default, which is the point of configuring several', () => {
    const a = odinAnalytics(rows, [], SITES, {})
    expect(a.totals.total).toBe(3)
    expect(a.byRegion.map((r) => r.region)).toEqual(['South', 'North'])
  })

  it('applies the instance filter to the audits question too', () => {
    const audits = [
      from('grp', 'Group', { passPct: 90 }),
      from('acq', 'Acquired region', { passPct: 50, site: 'Depot 7' }),
    ]
    expect(odinAnalytics([], audits, SITES, { source: 'grp' }).auditCount).toBe(1)
  })
})
