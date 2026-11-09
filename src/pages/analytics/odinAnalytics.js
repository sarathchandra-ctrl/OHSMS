// ─────────────────────────────────────────────────────────────────────────────
// ODIN — the arithmetic, with no React and no network in it.
//
// The rows arrive already mapped onto a canonical shape by the server
// (stack/lib/metabase.js), so nothing here knows what a warehouse column is
// called. What it does know is the awkward middle: a Metabase question rarely
// carries coordinates, statuses come back in whatever words the source system
// uses, and a pass percentage averaged across sites of wildly different size is
// a number that reads as fact and is not one.
//
// Three rules run through all of it.
//
//   Nothing is silently dropped. A finding whose site cannot be placed on the
//   map is still counted in every bar; the map says how many it could not show.
//
//   Nothing is silently invented. An unrecognised status is not folded into
//   "Open" — it is counted separately and reported, because a chart nobody can
//   tell is wrong is worse than a chart with a caveat under it.
//
//   Percentages are weighted where the data allows it. Averaging "100% of 4
//   checks" with "50% of 400" gives 75%, and the honest answer is 50.5%.
// ─────────────────────────────────────────────────────────────────────────────
import { normSiteName, resolveOdinRows, SITE_CODE_FIELDS } from '../../../stack/lib/odinJoin.js'
import {
  auditPopulation,
  checksTotalOf,
  day0Of,
  hasPassData,
  n7Of,
  toDateOf,
} from '../../../stack/lib/auditScore.js'

// The join and the pass-rate readers live in functions/ so the site-lookup
// bot scores an audit with the same functions this tab does. Re-exported so
// every existing import of this file keeps working.
export {
  SITE_CODE_FIELDS,
  resolveOdinRows,
  auditPopulation,
  checksTotalOf,
  day0Of,
  hasPassData,
  n7Of,
  toDateOf,
}

// Mirrors STATUSES in stack/lib/metabase.js, which is the authority on the
// mapping. Duplicated rather than imported because functions/ is a separate
// package with its own node_modules and is not part of the browser bundle; the
// four keys are a contract between them, and odinAnalytics.test.js pins them.
export const STATUS_META = [
  { key: 'open', label: 'Open', color: '#ef4444' },
  { key: 'in_progress', label: 'In Progress', color: '#f59e0b' },
  { key: 'on_hold', label: 'On Hold', color: '#8b5cf6' },
  { key: 'closed', label: 'Closed', color: '#22c55e' },
  // Grey on purpose. Rejected is neither good news nor bad — it is a finding
  // somebody judged not to be one — and giving it a green or a red would put
  // an opinion on the chart that the data does not carry.
  { key: 'rejected', label: 'Rejected', color: '#78716c' },
]

/**
 * Statuses where nothing further is going to happen.
 *
 * Mirrors TERMINAL_STATUSES in stack/lib/metabase.js. A rejected ticket is
 * finished, so it is not part of any "still open" count — and it is not closed
 * either, so it must never be added to remediation figures. `status !==
 * 'closed'` was the old test everywhere and now quietly counts rejections as
 * outstanding work; this is what replaced it.
 */
export const TERMINAL_STATUSES = ['closed', 'rejected']
export const isTerminal = (status) => TERMINAL_STATUSES.includes(status)
export const isOutstanding = (status) => !isTerminal(status)
export const STATUS_KEYS = STATUS_META.map((s) => s.key)
export const STATUS_BY_KEY = Object.fromEntries(STATUS_META.map((s) => [s.key, s]))

/** A palette for sub-categories, which are free text and can be anything. */
const PALETTE = [
  '#0d9488', '#dc2626', '#2563eb', '#d97706', '#7c3aed', '#059669',
  '#db2777', '#0891b2', '#ca8a04', '#4f46e5', '#e11d48', '#65a30d',
]
export const paletteColor = (i) => PALETTE[i % PALETTE.length]

const isNum = (v) => typeof v === 'number' && Number.isFinite(v)
// The same folding the site join uses, so a city chart and an audit that
// named that city cannot disagree about a double space.
const norm = normSiteName

const UNPLACED = '(not stated)'

/** Every value present in the data, for the filter bar. Never the filtered set. */
export function odinFacets(rows = []) {
  const regions = new Set()
  const entities = new Set()
  const subCategories = new Set()
  const months = new Set()
  // The dimensions an estate is actually cut by, beside the two this tab
  // started with. Gathered the same way and offered only where the data has
  // them — see `dimensionsPresent`.
  const cities = new Set()
  const ownerships = new Set()
  const businessLines = new Set()
  const centerTypes = new Set()
  const auditTypes = new Set()
  const priorities = new Set()
  let minDate = ''
  let maxDate = ''
  // Which Metabase instance each row came from. Only offered as a filter when
  // there is more than one — a picker with a single option is furniture.
  const sources = new Map()
  for (const r of rows) {
    if (r.region) regions.add(r.region)
    if (r.entity) entities.add(r.entity)
    if (r.subCategory) subCategories.add(r.subCategory)
    if (r.city) cities.add(r.city)
    if (r.ownership) ownerships.add(r.ownership)
    if (r.businessLine) businessLines.add(r.businessLine)
    if (r.centerType) centerTypes.add(r.centerType)
    if (r.auditType) auditTypes.add(r.auditType)
    if (r.priority) priorities.add(r.priority)
    if (r.auditDate) {
      months.add(r.auditDate.slice(0, 7))
      // The real span the data covers, so the date pickers can bound themselves
      // to it instead of offering a year that returns nothing.
      if (!minDate || r.auditDate < minDate) minDate = r.auditDate
      if (!maxDate || r.auditDate > maxDate) maxDate = r.auditDate
    }
    if (r.sourceId) sources.set(r.sourceId, r.sourceLabel || r.sourceId)
  }
  const sorted = (s) => [...s].sort((a, b) => a.localeCompare(b))
  return {
    regions: sorted(regions),
    entities: sorted(entities),
    subCategories: sorted(subCategories),
    months: sorted(months),
    cities: sorted(cities),
    ownerships: sorted(ownerships),
    businessLines: sorted(businessLines),
    centerTypes: sorted(centerTypes),
    auditTypes: sorted(auditTypes),
    priorities: sorted(priorities),
    minDate,
    maxDate,
    sources: [...sources.entries()]
      .map(([id, label]) => ({ id, label }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  }
}

/**
 * Apply the filter bar.
 *
 * A month range is inclusive at both ends and compares 'YYYY-MM' strings, which
 * sort chronologically — the same trick FilterBar uses everywhere else, so a
 * reader switching tabs gets the same behaviour from the same controls.
 *
 * A row with no date passes a date filter rather than being hidden by it. The
 * alternative silently removes findings from every total the moment anyone
 * touches the range, and an undated finding is a data-quality problem to be
 * seen, not one to be filtered away.
 */
export function filterOdinRows(rows = [], f = {}) {
  const {
    region = 'all', entity = 'all', status = 'all', subCategory = 'all', source = 'all', from = '', to = '',
    city = 'all', ownership = 'all', businessLine = 'all', centerType = 'all', auditType = 'all', priority = 'all',
  } = f
  // The range accepts a month ('YYYY-MM') or a day ('YYYY-MM-DD'). A month is
  // widened to cover itself at both ends, so the picker could move from month
  // dropdowns to real dates without every existing caller changing meaning.
  const lo = from ? (from.length === 7 ? `${from}-01` : from) : ''
  const hi = to ? (to.length === 7 ? `${to}-31` : to) : ''
  return rows.filter((r) => {
    if (source !== 'all' && r.sourceId !== source) return false
    if (region !== 'all' && r.region !== region) return false
    if (entity !== 'all' && r.entity !== entity) return false
    if (status !== 'all' && r.status !== status) return false
    if (subCategory !== 'all' && r.subCategory !== subCategory) return false
    if (city !== 'all' && r.city !== city) return false
    if (ownership !== 'all' && r.ownership !== ownership) return false
    if (businessLine !== 'all' && r.businessLine !== businessLine) return false
    if (centerType !== 'all' && r.centerType !== centerType) return false
    if (auditType !== 'all' && r.auditType !== auditType) return false
    if (priority !== 'all' && r.priority !== priority) return false
    const date = r.auditDate || ''
    if (date) {
      if (lo && date < lo) return false
      if (hi && date > hi) return false
    }
    return true
  })
}

/**
 * The dimensions this population can actually be grouped by, in the order the
 * picker offers them.
 *
 * Computed from the data rather than hard-coded: a tenant whose warehouse has
 * no city column should not be shown a "City" option that groups everything
 * under "(not stated)". Region and entity lead because they are the ones this
 * app's own site register fills in, so they work even when the question is
 * silent about them.
 */
export const GROUP_DIMS = [
  { key: 'region', label: 'Region' },
  { key: 'entity', label: 'Entity' },
  { key: 'city', label: 'City' },
  { key: 'businessLine', label: 'Business line' },
  { key: 'ownership', label: 'Ownership' },
  { key: 'centerType', label: 'Centre type' },
  { key: 'auditType', label: 'Audit type' },
  { key: 'auditor', label: 'Auditor' },
  { key: 'site', label: 'Centre' },
]

/**
 * Dimensions this app fills in itself, from the site register.
 *
 * Always offered and never filtered out, even when every row is currently
 * blank. They are the two an operator can FIX — by setting a region on a site,
 * or by giving it the centre ID that joins it to one — and hiding the option
 * because the data is missing removes the very control that says what is
 * missing. It also caused the concrete bug this guards: with no regions in the
 * register, "Region" vanished from the picker and the chart silently
 * re-grouped itself by city, which is a different question nobody asked.
 */
const ALWAYS_OFFERED = ['region', 'entity']

/** True when at least one row actually carries a value for this dimension. */
export const dimensionHasData = (rows = [], key) =>
  (rows || []).some((r) => r && String(r[key] || '').trim())

/**
 * The dimensions the picker offers.
 *
 * Region and entity always; everything else only where the warehouse supplies
 * it, so a tenant whose question has no city column is not offered a City
 * option that groups everything under "(not stated)".
 */
export const dimensionsPresent = (rows = []) =>
  GROUP_DIMS.filter((d) => ALWAYS_OFFERED.includes(d.key) || dimensionHasData(rows, d.key))

/**
 * The dimension to actually group by, given what the data supports.
 *
 * Region is the default, and on an estate whose warehouse says nothing about
 * regions — and whose sites are not in this app's register either — grouping by
 * it produces one bar labelled "(not stated)" beside a picker that does not
 * even offer Region. So the wanted dimension is honoured when it exists and
 * quietly falls back to the first one that does when it does not.
 */
export const resolveGroupBy = (dims = [], wanted = 'region') =>
  (dims.some((d) => d.key === wanted) ? wanted : dims[0]?.key || wanted)

const sum = (rows) => rows.reduce((n, r) => n + (isNum(r.count) ? r.count : 1), 0)

/** Totals per status, plus the unrecognised ones, which are reported not hidden. */
export function statusTotals(rows = []) {
  const out = Object.fromEntries(STATUS_KEYS.map((k) => [k, 0]))
  let unknown = 0
  const unknownLabels = new Set()
  for (const r of rows) {
    const n = isNum(r.count) ? r.count : 1
    if (out[r.status] === undefined) {
      unknown += n
      if (r.rawStatus) unknownLabels.add(r.rawStatus)
    } else {
      out[r.status] += n
    }
  }
  return { ...out, unknown, unknownLabels: [...unknownLabels].sort(), total: sum(rows) }
}

/**
 * One stacked bar per region: Open / In Progress / On Hold / Closed.
 *
 * Sorted by total descending — the region with the most open issues is the one
 * the meeting is about, and alphabetical order buries it. Regions the data does
 * not state are grouped under a named bucket rather than dropped, because
 * "eleven findings we cannot attribute to a region" is itself a finding.
 */
export function statusByRegion(rows = []) {
  const groups = new Map()
  for (const r of rows) {
    const key = r.region || UNPLACED
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(r)
  }
  return [...groups.entries()]
    .map(([region, list]) => ({ region, ...statusTotals(list) }))
    .sort((a, b) => b.total - a.total || a.region.localeCompare(b.region))
}

/**
 * Findings by sub-category, biggest first, coloured stably.
 *
 * `limit` folds the tail into "Other" for the pie, where twenty slices are a
 * colour wheel rather than a chart. The bar chart takes them all — it has a
 * vertical axis and can afford the rows.
 */
export function bySubCategory(rows = [], { limit = 0 } = {}) {
  const groups = new Map()
  for (const r of rows) {
    const key = r.subCategory || '(not stated)'
    groups.set(key, (groups.get(key) || 0) + (isNum(r.count) ? r.count : 1))
  }
  const all = [...groups.entries()]
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name))

  const shown = limit > 0 && all.length > limit ? all.slice(0, limit) : all
  const rest = limit > 0 && all.length > limit ? all.slice(limit) : []
  const out = shown.map((d, i) => ({ ...d, color: paletteColor(i) }))
  if (rest.length) {
    out.push({
      name: `Other (${rest.length} sub-categories)`,
      value: rest.reduce((n, d) => n + d.value, 0),
      color: '#94a3b8',
    })
  }
  return out
}

/**
 * One pin per site, with the mix of statuses on it.
 *
 * Returns the unplaceable ones too, as a count and a list of names. A map that
 * shows eleven of nineteen sites and says nothing is a map that will be read as
 * showing all nineteen.
 */
/**
 * One pin per CITY, placed at the mean of whatever coordinates that city has.
 *
 * The site-level map is honest but thin: coordinates come from the site
 * register, most partner gyms have never had a latitude put on them, and on a
 * real month it dropped 76 sites and 1,011 issues off the picture. City level
 * rescues nearly all of them, because a city needs only ONE located site to be
 * placeable and every city in this estate has several. `cityName` also comes
 * off the question itself rather than the register, so no row is ever missing
 * the grouping key the way it can be missing a region.
 *
 * The mean of member sites, not a gazetteer. A hardcoded table of city
 * coordinates would be another list to maintain and would quietly be wrong for
 * anyone whose "city" is a zone or a cluster rather than a place on a map.
 * Averaging what the register already knows needs no maintenance and lands the
 * pin among the sites it represents.
 */
export function cityPins(rows = []) {
  const groups = new Map()
  for (const r of rows) {
    const key = norm(r.city) || UNPLACED
    if (!groups.has(key)) groups.set(key, { key, city: r.city || UNPLACED, rows: [], lats: [], lngs: [] })
    const g = groups.get(key)
    g.rows.push(r)
    if (isNum(r.lat) && isNum(r.lng)) { g.lats.push(r.lat); g.lngs.push(r.lng) }
  }

  const mean = (xs) => xs.reduce((n, x) => n + x, 0) / xs.length
  const pins = []
  const unplaced = []
  for (const g of groups.values()) {
    const totals = statusTotals(g.rows)
    const entry = {
      id: g.key,
      site: g.city,
      city: g.city,
      // How many distinct sites the pin stands for, so a reader can tell one
      // busy centre from twenty quiet ones.
      sites: new Set(g.rows.map((r) => r.matchedSiteId || r.site)).size,
      region: '',
      entity: '',
      total: totals.total,
      byStatus: totals,
    }
    if (g.lats.length) pins.push({ ...entry, lat: mean(g.lats), lng: mean(g.lngs), placedFrom: 'city' })
    else unplaced.push(entry)
  }
  pins.sort((a, b) => b.total - a.total)
  unplaced.sort((a, b) => b.total - a.total)
  return { pins, unplaced }
}

/**
 * Every site in scope with its issue counts, busiest first.
 *
 * The list that replaced the map. A map can only show a site it has
 * coordinates for, and coordinates come from the site register — the tickets
 * question carries none — so on a real month it drew about 76 sites short and
 * had to caption itself with an apology naming the ones it had dropped. A list
 * has no such requirement: every site in scope appears, whether or not anyone
 * has ever put a latitude on it.
 *
 * Grouped on the same key as sitePins, so the two agree about what a site is.
 */
export function siteIssues(rows = []) {
  const groups = new Map()
  for (const r of rows) {
    const key = r.matchedSiteId || r.site || UNPLACED
    if (!groups.has(key)) {
      groups.set(key, {
        id: key,
        site: r.site || UNPLACED,
        region: r.region || '',
        entity: r.entity || '',
        city: r.city || '',
        rows: [],
      })
    }
    groups.get(key).rows.push(r)
  }

  const out = []
  for (const g of groups.values()) {
    const totals = statusTotals(g.rows)
    out.push({
      id: g.id,
      site: g.site,
      region: g.region,
      entity: g.entity,
      city: g.city,
      total: totals.total,
      // Rejected is neither closed nor outstanding — the same arithmetic the
      // KPI row uses, so the two cannot disagree.
      open: totals.total - totals.closed - totals.rejected,
      closed: totals.closed,
      breached: g.rows.reduce((n, r) => n + (isBreach(r.sla) ? (isNum(r.count) ? r.count : 1) : 0), 0),
    })
  }
  out.sort((a, b) => b.total - a.total || a.site.localeCompare(b.site))
  return out
}

export function sitePins(rows = []) {
  const groups = new Map()
  for (const r of rows) {
    const key = r.matchedSiteId || r.site || UNPLACED
    if (!groups.has(key)) groups.set(key, { key, site: r.site || UNPLACED, region: r.region, entity: r.entity, rows: [] })
    groups.get(key).rows.push(r)
  }

  const pins = []
  const unplaced = []
  for (const g of groups.values()) {
    const withCoords = g.rows.find((r) => isNum(r.lat) && isNum(r.lng))
    const totals = statusTotals(g.rows)
    const entry = {
      id: g.key,
      site: g.site,
      region: g.region || '',
      entity: g.entity || '',
      total: totals.total,
      byStatus: totals,
    }
    if (withCoords) pins.push({ ...entry, lat: withCoords.lat, lng: withCoords.lng, placedFrom: withCoords.placedFrom })
    else unplaced.push(entry)
  }
  pins.sort((a, b) => b.total - a.total)
  unplaced.sort((a, b) => b.total - a.total)
  return { pins, unplaced }
}

/** The status a pin is coloured by: the worst one it actually has. */
export const leadStatus = (byStatus) =>
  STATUS_KEYS.find((k) => byStatus[k] > 0) || 'closed'

// ── Pass and fail ────────────────────────────────────────────────────────────
//
// A warehouse states an audit result one of two ways, and ODIN accepts both:
// a percentage, or a pair of counts (how many checks passed, how many failed).
// The counts are the better input, because they carry the SIZE of the audit,
// and size is what separates a weighted pass rate from an average of
// percentages — see the basis note in passRates.
//
// The helpers below are the seam. Everything downstream asks them for "the
// pass rate of this row" and never has to know which shape the question used.

const pct = (n) => Math.round(n * 10) / 10

// ── Time buckets ─────────────────────────────────────────────────────────────
//
// Six grains, because "how are we doing" is a different question at a day than
// at a half-year and the same dashboard has to answer both: a daily view shows
// which audits ran, an annual one shows whether the estate is improving.
//
// Each grain returns a sortable `key` and a printable `label`, and the keys are
// built so plain string ordering is chronological ordering — no date parsing in
// the sort. Weeks start Monday: an audit week is a working week, and a Sunday
// boundary cuts every one of them in half.

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export const GRANULARITIES = [
  { key: 'day', label: 'Day' },
  { key: 'week', label: 'Week' },
  { key: 'month', label: 'Month' },
  { key: 'quarter', label: 'Quarter' },
  { key: 'half', label: 'Half year' },
  { key: 'year', label: 'Year' },
]
export const GRANULARITY_KEYS = GRANULARITIES.map((g) => g.key)

/**
 * The bucket a 'YYYY-MM-DD' falls in, or null when the row has no date.
 *
 * Null rather than a catch-all bucket: an undated row is a data-quality problem
 * and pooling it into "the earliest period" would draw it as a real spike in a
 * real month. Callers count what they had to leave out and say so.
 */
export function bucketOf(iso, gran = 'month') {
  const s = String(iso || '')
  if (!/^\d{4}-\d{2}-\d{2}/.test(s)) return null
  const [y, m, d] = [s.slice(0, 4), Number(s.slice(5, 7)), Number(s.slice(8, 10))]
  const yy = y.slice(2)
  switch (gran) {
    case 'day':
      return { key: s.slice(0, 10), label: `${d} ${MONTH_ABBR[m - 1]}` }
    case 'week': {
      // UTC throughout: a local-time Date would shift the Monday for anyone
      // east or west of the server and quietly move audits between weeks.
      const t = Date.UTC(Number(y), m - 1, d)
      const dow = (new Date(t).getUTCDay() + 6) % 7
      const mon = new Date(t - dow * 86400000)
      const key = mon.toISOString().slice(0, 10)
      return { key, label: `w/c ${mon.getUTCDate()} ${MONTH_ABBR[mon.getUTCMonth()]}` }
    }
    case 'quarter': {
      const q = Math.floor((m - 1) / 3) + 1
      return { key: `${y}-Q${q}`, label: `Q${q} ${yy}` }
    }
    case 'half': {
      const h = m <= 6 ? 1 : 2
      return { key: `${y}-H${h}`, label: `H${h} ${y}` }
    }
    case 'year':
      return { key: y, label: y }
    case 'month':
    default:
      return { key: s.slice(0, 7), label: `${MONTH_ABBR[m - 1]} ${yy}` }
  }
}

/**
 * Pass rate per bucket, all three readings, plus the counts behind them.
 *
 * The counts matter as much as the rate and are returned beside it: a bucket
 * holding two audits swings between 0% and 100% on one result, and a rate with
 * no denominator next to it is how that gets read as a collapse.
 *
 * Buckets with no audits are simply absent rather than zero — a week nobody
 * audited did not score zero.
 */
export function passTrend(auditRows = [], gran = 'month') {
  const buckets = new Map()
  let undated = 0
  for (const r of auditRows || []) {
    if (!r) continue
    const b = bucketOf(r.auditDate, gran)
    if (!b) { if (hasPassData(r)) undated += 1; continue }
    let g = buckets.get(b.key)
    if (!g) { g = { key: b.key, label: b.label, rows: [] }; buckets.set(b.key, g) }
    g.rows.push(r)
  }

  const rate = (list, read) => {
    const vals = list.map(read).filter(isNum)
    return vals.length ? { rate: pct(vals.filter((v) => v >= PASS_MARK).length / vals.length * 100), n: vals.length } : { rate: null, n: 0 }
  }

  const series = [...buckets.values()]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((g) => {
      const d0 = rate(g.rows, day0Of)
      const n7 = rate(g.rows, n7Of)
      return {
        key: g.key,
        label: g.label,
        audits: g.rows.length,
        day0: d0.rate, day0N: d0.n,
        n7: n7.rate, n7N: n7.n,
        // The verdict counts the bars are drawn from. Taken after the seven-day
        // window where there is one, so the chart under the rate is the same
        // measurement as the rate.
        pass: n7.n ? Math.round((n7.rate / 100) * n7.n) : 0,
        fail: n7.n ? n7.n - Math.round((n7.rate / 100) * n7.n) : 0,
      }
    })

  return { series, undated }
}

/**
 * The pass mark a score is judged against.
 *
 * Ninety is the FLS convention and the default here, but it is a constant with
 * a name rather than a literal buried in three places, because the next
 * organization to connect ODIN will have a different one.
 */
export const PASS_MARK = 90

/** Tickets per bucket, split by where they stand and whether SLA held. */
export function ticketTrend(rows = [], gran = 'month') {
  const buckets = new Map()
  let undated = 0
  for (const r of rows || []) {
    if (!r) continue
    const b = bucketOf(r.auditDate, gran)
    if (!b) { undated += 1; continue }
    let g = buckets.get(b.key)
    if (!g) { g = { key: b.key, label: b.label, total: 0, open: 0, closed: 0, rejected: 0, breached: 0 }; buckets.set(b.key, g) }
    const n = isNum(r.count) ? r.count : 1
    g.total += n
    // Three outcomes, not two. A rejected ticket is neither still open nor
    // remediated, and folding it into either overstates that half.
    if (r.status === 'closed') g.closed += n
    else if (r.status === 'rejected') g.rejected += n
    else g.open += n
    if (isBreach(r.sla)) g.breached += n
  }
  return {
    series: [...buckets.values()].sort((a, b) => a.key.localeCompare(b.key)),
    undated,
  }
}

/**
 * How long tickets take, in DAYS, split by where they ended up.
 *
 * Two different clocks, and conflating them is the trap this is shaped around.
 *
 *   A CLOSED ticket has a finished duration: raised to closed. The warehouse
 *   gives it directly as hours, and where it does not, the two dates do.
 *
 *   An OPEN one has no duration at all — it has an AGE, which grows every day
 *   nobody touches it. Averaging the two together produces a number that falls
 *   when a ticket is abandoned, because dropping the ancient ones out of the
 *   "open" pool and never closing them makes the average look better.
 *
 * So they are reported apart, each with the count behind it. Rejected gets an
 * age rather than a duration too: it was never remediated, and the honest
 * reading is how long it sat before somebody dismissed it — which the dump
 * does not record, so its age since raised is what there is.
 *
 * `asOf` is injectable so the tests are not a function of the day they run.
 */
/**
 * Who owns a ticket, read off the L1 tag.
 *
 * The warehouse states ownership as free text in the L1 tag, and states it
 * several ways: "Safety and Security" and "Safety & Security" are one team,
 * and "Center Manager", "Center Management" and "Center Manager SPOC" are all
 * the centre manager. Matching the literal strings would split one owner across
 * three bars, so the tag is flattened to letters and digits before it is read.
 *
 * Anything that matches none of them is 'other' and is COUNTED AND NAMED rather
 * than dropped. A tag nobody has mapped is a tag somebody should look at, and a
 * chart that quietly omits it hides the one row worth asking about.
 */
export const TICKET_OWNERS = [
  { key: 'sas', label: 'SAS', full: 'Safety & Security', color: '#2563eb' },
  { key: 'facility', label: 'Facility', full: 'Facility', color: '#d97706' },
  { key: 'cm', label: 'CM', full: 'Centre Manager', color: '#0d9488' },
  { key: 'other', label: 'Other', full: 'Unmapped L1 tag', color: '#78716c' },
]
export const TICKET_OWNER_KEYS = TICKET_OWNERS.map((o) => o.key)

export function ownerOf(row) {
  const flat = String(row?.category ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
  if (!flat) return 'other'
  if (flat.includes('safety') && flat.includes('security')) return 'sas'
  if (flat.includes('facility')) return 'facility'
  // "centermanager", "centremanagement", "centermanagerspoc" — and the SPOC
  // spelling on its own, which appears without the word "center" in front.
  if (/cent(er|re)manage/.test(flat) || flat.includes('cmspoc')) return 'cm'
  return 'other'
}

/**
 * Observations per site, and per site per owner.
 *
 * One row of the tickets question is one observation, so this is a count, not a
 * sum of anything — `count` is respected for a question that arrives already
 * grouped, the same way statusTotals does it.
 *
 * Sorted by total descending: the question this answers is "where is the work",
 * and that is a ranking. The per-owner counts ride along on each row so a
 * stacked bar and a table can be drawn from one pass.
 */
export function observationsPerSite(rows = []) {
  const bySite = new Map()
  const totals = Object.fromEntries(TICKET_OWNER_KEYS.map((k) => [k, 0]))
  let total = 0

  for (const r of rows || []) {
    if (!r) continue
    const key = r.matchedSiteId || r.site || UNPLACED
    if (!bySite.has(key)) {
      bySite.set(key, {
        id: key,
        site: r.site || UNPLACED,
        region: r.region || '',
        city: r.city || '',
        total: 0,
        ...Object.fromEntries(TICKET_OWNER_KEYS.map((k) => [k, 0])),
      })
    }
    const g = bySite.get(key)
    const n = isNum(r.count) ? r.count : 1
    const owner = ownerOf(r)
    g.total += n
    g[owner] += n
    totals[owner] += n
    total += n
  }

  const sites = [...bySite.values()].sort((a, b) => b.total - a.total || a.site.localeCompare(b.site))
  const per = (n) => (sites.length ? Math.round((n / sites.length) * 10) / 10 : null)
  return {
    sites,
    total,
    byOwner: totals,
    // Each owner's load per site, over the SAME denominator as the overall
    // figure — every site carrying observations, not just the ones carrying
    // that owner's. Dividing each by its own subset would make the three
    // averages incomparable and stop them summing to the total per site, which
    // is the first thing anybody checks.
    perSiteByOwner: Object.fromEntries(TICKET_OWNER_KEYS.map((k) => [k, per(totals[k])])),
    siteCount: sites.length,
    // The average is per SITE THAT HAS ONE, not per site in the register: a
    // register full of centres nobody audited would drag it toward zero and
    // make a busy estate look quiet.
    perSite: sites.length ? Math.round((total / sites.length) * 10) / 10 : null,
  }
}

// ── How long a ticket took, and how long it has been waiting ─────────────────
//
// Extracted so every panel that talks about days measures them the same way. A
// second copy of this arithmetic is how two figures on one page come to
// disagree about the same ticket.
const DAY_MS = 86_400_000
const meanDays = (xs) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null)

/** Days a CLOSED ticket took, or null if the row cannot say. */
export function closedDaysOf(row) {
  // The stated hours first — it is the warehouse's own measurement. The dates
  // are the fallback for a question that does not carry it.
  if (isNum(row?.tatHours)) return row.tatHours / 24
  const raised = Date.parse(`${row?.auditDate}T00:00:00Z`)
  const shut = Date.parse(`${row?.closedDate}T00:00:00Z`)
  return Number.isFinite(raised) && Number.isFinite(shut) && shut >= raised
    ? (shut - raised) / DAY_MS
    : null
}

/** Days an UNCLOSED ticket has been waiting, or null if the row cannot say. */
export function ageDaysOf(row, asOf = Date.now()) {
  const raised = Date.parse(`${row?.auditDate}T00:00:00Z`)
  if (!Number.isFinite(raised)) return null
  const age = (asOf - raised) / DAY_MS
  return age < 0 ? null : age    // a future-dated row is bad data, not a -3 day age
}

/**
 * Is this ticket an FLS one?
 *
 * Read off the L2 tag, which states them as "FLS", "FLS - Detection", "FLS -
 * Extinguisher", "FLS - Fire Detection", "FLS - General" and "FLS - Signage".
 *
 * startsWith rather than includes, deliberately. `includes('fls')` would also
 * match a category like "Baffles" — unlikely today, but the tag is free text
 * and a filter that quietly widens later is worse than one that misses a new
 * spelling loudly.
 */
export const isFls = (row) =>
  String(row?.subCategory ?? '').toLowerCase().replace(/[^a-z0-9]/g, '').startsWith('fls')

/**
 * The FLS L2 categories, each with where its tickets stand and how long they
 * have taken.
 *
 * Three counts and three ages per category, which is the shape somebody reads
 * across a row: how many are open, how many are moving, how many are done —
 * and for each of those, how long. Closed is time TAKEN; the other two are time
 * SO FAR, and they are different measurements sharing a unit, so the panel
 * labels them rather than leaving it to be inferred.
 *
 * On hold and rejected are counted into the total but get no column of their
 * own: this answers a question about the live FLS queue, and a category whose
 * numbers do not add to its total says so in the total column rather than by
 * growing two more columns nobody asked for.
 */
export function flsCategories(rows = [], asOf = Date.now()) {
  const byCat = new Map()

  for (const r of rows || []) {
    if (!r || !isFls(r)) continue
    const name = String(r.subCategory ?? '').trim() || UNPLACED
    if (!byCat.has(name)) {
      byCat.set(name, {
        name,
        total: 0,
        open: 0,
        in_progress: 0,
        closed: 0,
        other: 0,
        openAges: [],
        progressAges: [],
        closedDays: [],
      })
    }
    const g = byCat.get(name)
    const n = isNum(r.count) ? r.count : 1
    g.total += n

    if (r.status === 'closed') {
      g.closed += n
      const d = closedDaysOf(r)
      if (d !== null) g.closedDays.push(d)
      continue
    }
    if (r.status === 'open' || r.status === 'in_progress') {
      const bucket = r.status === 'open' ? 'openAges' : 'progressAges'
      g[r.status] += n
      const age = ageDaysOf(r, asOf)
      if (age !== null) g[bucket].push(age)
      continue
    }
    // On hold and rejected: in the total, in no column.
    g.other += n
  }

  const rowsOut = [...byCat.values()]
    .map((g) => ({
      name: g.name,
      total: g.total,
      open: g.open,
      inProgress: g.in_progress,
      closed: g.closed,
      other: g.other,
      openDays: meanDays(g.openAges),
      inProgressDays: meanDays(g.progressAges),
      closedDays: meanDays(g.closedDays),
    }))
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name))

  const sum = (k) => rowsOut.reduce((n, r) => n + r[k], 0)
  return {
    rows: rowsOut,
    total: sum('total'),
    open: sum('open'),
    inProgress: sum('inProgress'),
    closed: sum('closed'),
    categories: rowsOut.length,
  }
}

// ── Quarter on quarter ───────────────────────────────────────────────────────
//
// The quarters are the calendar ones, named the way the audit planner names
// them: JFM, AMJ, JAS, OND. Same boundaries as bucketOf's Q1..Q4 — only the
// label differs — so a reader moving between this panel and the trend chart is
// looking at the same three months under both names.
const QUARTER_NAMES = { 1: 'JFM', 2: 'AMJ', 3: 'JAS', 4: 'OND' }

/** '2026-Q3' → 'JAS 26', the name the planner uses. */
export function quarterName(key) {
  const m = /^(\d{4})-Q([1-4])$/.exec(String(key || ''))
  return m ? `${QUARTER_NAMES[Number(m[2])]} ${m[1].slice(2)}` : String(key || '')
}

/**
 * Every metric this tab reports, in one flat shape, so a quarter is comparable
 * to a quarter without each panel inventing its own comparison.
 *
 * `better` is what a MOVE means, and it is 'none' for every count on purpose.
 * More observations can mean a worse estate or simply more auditing, and this
 * page cannot tell those apart — colouring it green or red would assert
 * something the data does not carry. Only the ages get a direction: a ticket
 * waiting longer is worse whichever way the volume moved.
 */
export const QOQ_METRICS = [
  { key: 'observations', label: 'Observations', unit: 'count', better: 'none' },
  { key: 'perSite', label: 'Average per site', unit: 'count', better: 'none' },
  { key: 'sites', label: 'Sites with observations', unit: 'count', better: 'none' },
  { key: 'sas', label: 'SAS tickets', unit: 'count', better: 'none' },
  { key: 'facility', label: 'Facility tickets', unit: 'count', better: 'none' },
  { key: 'cm', label: 'CM tickets', unit: 'count', better: 'none' },
  { key: 'other', label: 'Other (unmapped L1)', unit: 'count', better: 'none' },
  { key: 'sasPerSite', label: 'SAS per site', unit: 'count', better: 'none' },
  { key: 'facilityPerSite', label: 'Facility per site', unit: 'count', better: 'none' },
  { key: 'cmPerSite', label: 'CM per site', unit: 'count', better: 'none' },
  { key: 'ageClosed', label: 'Avg time to close', unit: 'days', better: 'down' },
  { key: 'ageLive', label: 'Avg age, open & in progress', unit: 'days', better: 'down' },
  { key: 'ageHold', label: 'Avg age, on hold', unit: 'days', better: 'down' },
  { key: 'flsTotal', label: 'FLS observations', unit: 'count', better: 'none' },
  { key: 'flsOpen', label: 'FLS open', unit: 'count', better: 'none' },
  { key: 'flsInProgress', label: 'FLS in progress', unit: 'count', better: 'none' },
  { key: 'flsClosed', label: 'FLS closed', unit: 'count', better: 'none' },
]

/**
 * The two windows a quarter-on-quarter comparison uses: this quarter so far,
 * and the whole of the one before it.
 *
 * Each side is at most one quarter, which is what makes this possible at all:
 * two quarters of tickets is about 12MB against an 8MB response cap, so the
 * halves have to be fetched separately however they are sliced.
 *
 * The current quarter is necessarily partial until it ends, and the panel says
 * "to date" on that column rather than pretending otherwise. It is a real
 * caveat — a quarter three weeks old will look quiet next to a finished one —
 * but it is the comparison people mean by quarter on quarter, and the honest
 * fix is a label, not a different question.
 */
export function quarterSpans(now = Date.now(), count = 3) {
  const d = new Date(now)
  const today = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
  const iso = (t) => new Date(t).toISOString().slice(0, 10)

  // One quarter, `back` quarters before the current one. The end is the
  // quarter's own last day — derived as "day 0 of the next quarter, less one",
  // so February needs no special case and a leap year needs no table — except
  // for the quarter we are standing in, which ends today.
  const spanFor = (back) => {
    const qAbs = Math.floor(d.getUTCMonth() / 3) + d.getUTCFullYear() * 4 - back
    const y = Math.floor(qAbs / 4)
    const qIdx = ((qAbs % 4) + 4) % 4
    const start = Date.UTC(y, qIdx * 3, 1)
    const qEnd = Date.UTC(qIdx === 3 ? y + 1 : y, ((qIdx + 1) % 4) * 3, 1) - DAY_MS
    const end = Math.min(qEnd, today)
    const key = `${y}-Q${qIdx + 1}`
    return {
      from: iso(start), to: iso(end), key, name: quarterName(key),
      days: Math.round((end - start) / DAY_MS) + 1,
      partial: end < qEnd,
    }
  }

  // Oldest first, so the columns read left to right the way a trend does.
  const n = Math.max(1, count)
  const all = Array.from({ length: n }, (_, i) => spanFor(n - 1 - i))
  return {
    all,
    current: all[all.length - 1],
    previous: all.length > 1 ? all[all.length - 2] : null,
  }
}

/**
 * The comparison, from two row sets fetched over the spans above.
 *
 * Separate from quarterOnQuarter, which buckets whatever the reader's own
 * window happens to contain. This one is asked for deliberately and always has
 * both sides, so the panel is not at the mercy of where the date pickers land.
 */
export function quarterSeries(rowSets = [], spans, asOf = Date.now()) {
  const s = spans || quarterSpans(asOf)
  const quarters = s.all.map((span, i) => {
    const rows = rowSets[i] || []
    return { ...span, label: span.name, tickets: rows.length, values: quarterValues(rows, asOf) }
  })
  const latest = quarters[quarters.length - 1] || null
  const previous = quarters.length > 1 ? quarters[quarters.length - 2] : null
  // The change is the most recent step, not the span of the whole series: three
  // columns are there to show the shape, one number is there to be acted on.
  const changes = latest && previous
    ? Object.fromEntries(QOQ_METRICS.map((m) => {
      const was = previous.values[m.key]
      const now = latest.values[m.key]
      return [m.key, isNum(was) && isNum(now) ? Math.round((now - was) * 10) / 10 : null]
    }))
    : null
  return { quarters, latest, previous, changes, spans: s, undated: 0 }
}

/** One quarter's worth of every headline number, keyed by QOQ_METRICS. */
function quarterValues(rows, asOf) {
  const obs = observationsPerSite(rows)
  const age = ticketAgeing(rows, asOf)
  const fls = flsCategories(rows, asOf)
  return {
    observations: obs.total,
    perSite: obs.perSite,
    sites: obs.siteCount,
    sas: obs.byOwner.sas,
    facility: obs.byOwner.facility,
    cm: obs.byOwner.cm,
    other: obs.byOwner.other,
    sasPerSite: obs.perSiteByOwner.sas,
    facilityPerSite: obs.perSiteByOwner.facility,
    cmPerSite: obs.perSiteByOwner.cm,
    ageClosed: age.closed.days,
    ageLive: age.openInProgress.days,
    ageHold: age.onHold.days,
    flsTotal: fls.total,
    flsOpen: fls.open,
    flsInProgress: fls.inProgress,
    flsClosed: fls.closed,
  }
}

/**
 * The same metrics, quarter by quarter, with the change between the last two.
 *
 * Bucketed from the rows already fetched rather than by running the question
 * again for an earlier window. That keeps the one rule this tab now has — you
 * see the dates you asked for and nothing else — but it does mean a comparison
 * exists only when the chosen window spans two quarters. When it does not, the
 * panel says so instead of drawing a change against nothing.
 *
 * Ages are measured as of NOW even for an older quarter, because that is what
 * an unclosed ticket's age is: a ticket raised in AMJ and still open has been
 * waiting until today, not until the end of its quarter.
 */
export function quarterOnQuarter(rows = [], asOf = Date.now()) {
  const byQ = new Map()
  let undated = 0
  for (const r of rows || []) {
    if (!r) continue
    const b = bucketOf(r.auditDate, 'quarter')
    if (!b) { undated += isNum(r.count) ? r.count : 1; continue }
    if (!byQ.has(b.key)) byQ.set(b.key, { key: b.key, label: b.label, name: quarterName(b.key), rows: [] })
    byQ.get(b.key).rows.push(r)
  }

  const quarters = [...byQ.values()]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((q) => ({ key: q.key, label: q.label, name: q.name, tickets: q.rows.length, values: quarterValues(q.rows, asOf) }))

  const latest = quarters.length ? quarters[quarters.length - 1] : null
  const previous = quarters.length > 1 ? quarters[quarters.length - 2] : null
  const changes = latest && previous
    ? Object.fromEntries(QOQ_METRICS.map((m) => {
      const was = previous.values[m.key]
      const now = latest.values[m.key]
      return [m.key, isNum(was) && isNum(now) ? Math.round((now - was) * 10) / 10 : null]
    }))
    : null

  return { quarters, latest, previous, changes, undated }
}

export function ticketAgeing(rows = [], asOf = Date.now()) {
  const mean = meanDays

  const closedDays = []
  const byStatus = new Map()

  for (const r of rows || []) {
    if (!r) continue
    if (r.status === 'closed') {
      const days = closedDaysOf(r)
      if (days !== null) closedDays.push(days)
      continue
    }
    // Everything not closed is ageing, rejected included.
    const age = ageDaysOf(r, asOf)
    if (age === null) continue
    if (!byStatus.has(r.status)) byStatus.set(r.status, [])
    byStatus.get(r.status).push(age)
  }

  // ── The three headline ages ────────────────────────────────────────────────
  //
  // Open and In Progress are pooled because they are one thing to the person
  // asking: a ticket somebody still owes work on. Splitting them puts the same
  // backlog behind two numbers that have to be added up mentally before either
  // means anything.
  //
  // On Hold is kept apart for the opposite reason. It is deliberately parked,
  // so its age measures a decision rather than a delay, and averaging it into
  // the live backlog would flatter the queue that is actually running late.
  //
  // Rejected is in neither: it is finished, and it was never remediated.
  const live = [...(byStatus.get('open') || []), ...(byStatus.get('in_progress') || [])]
  const held = byStatus.get('on_hold') || []

  return {
    closed: { days: mean(closedDays), n: closedDays.length },
    openInProgress: { days: mean(live), n: live.length },
    onHold: { days: mean(held), n: held.length },
    // In STATUS_META order, so this list reads the same way as every other
    // status list on the page.
    ageing: STATUS_META
      .filter((s) => s.key !== 'closed')
      .map((s) => ({ key: s.key, label: s.label, color: s.color, days: mean(byStatus.get(s.key) || []), n: (byStatus.get(s.key) || []).length }))
      .filter((s) => s.n > 0),
  }
}

/** Does this row's SLA verdict say the clock was missed? */
export const isBreach = (sla) => /breach/i.test(String(sla || ''))

/**
 * Counts by any free-text dimension, biggest first.
 *
 * Used for priority, SLA position and the checkpoint league table — three
 * panels that are the same arithmetic over a different column, and were three
 * near-identical loops before this.
 */
export function countBy(rows = [], key, { limit = 0, openOnly = false } = {}) {
  const out = new Map()
  for (const r of rows || []) {
    if (!r) continue
    const name = String(r[key] || '').trim() || UNPLACED
    let g = out.get(name)
    if (!g) { g = { name, value: 0, open: 0 }; out.set(name, g) }
    const n = isNum(r.count) ? r.count : 1
    g.value += n
    if (isOutstanding(r.status)) g.open += n
  }
  const list = [...out.values()]
    .filter((g) => !openOnly || g.open > 0)
    .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name))
  return limit > 0 ? list.slice(0, limit) : list
}

/**
 * The headline pass and fail figures across a set of audits.
 *
 * Counts where counts exist, because "412 checks passed, 88 failed" is a
 * sentence a safety meeting can act on in a way "83.4%" is not. Audits that
 * gave only a percentage contribute to `pct` and to nothing else — they have no
 * checks to count — and `counted` says how many did, so a partial denominator
 * cannot be mistaken for the whole estate.
 */
export function passTotals(rows = []) {
  let passed = 0
  let failed = 0
  let counted = 0
  const pcts = []
  for (const r of rows || []) {
    if (!r) continue
    const total = checksTotalOf(r)
    if (total && isNum(r.checksPassed)) {
      passed += r.checksPassed
      failed += isNum(r.checksFailed) ? r.checksFailed : total - r.checksPassed
      counted += 1
    }
    const d0 = day0Of(r)
    if (isNum(d0)) pcts.push(d0)
  }
  const checks = passed + failed
  return {
    passed,
    failed,
    checks,
    counted,
    audits: (rows || []).filter(Boolean).length,
    // Weighted when there are checks to weight by; otherwise the mean of the
    // percentages, which is the only thing those rows can support.
    pct: checks > 0 ? pct((passed / checks) * 100)
      : pcts.length ? pct(pcts.reduce((n, v) => n + v, 0) / pcts.length) : null,
    basis: checks > 0 ? 'weighted' : 'mean',
  }
}

/**
 * Pass rate on the day of the audit and at N+7, grouped by region or by entity.
 *
 * Two ways of aggregating, and which one ran is REPORTED rather than assumed,
 * because they can disagree by a lot:
 *
 *   weighted  when every audit in the group carries check counts. Sum the
 *             checks, divide once. This is the true pass rate for the group.
 *   mean      otherwise. The arithmetic mean of the audits' own percentages,
 *             which treats a four-point audit and a four-hundred-point audit as
 *             equals — sometimes what is wanted, never what should be assumed.
 *
 * N+7 is weighted by the audit's size when that is known, because the re-check
 * covers the same audit and so carries the same weight; it falls back to the
 * mean the same way. An audit with no N+7 figure yet contributes to neither —
 * `n7Audits` says how many did, so a group where the re-checks have not
 * happened cannot masquerade as one that scored badly.
 */
export function passRates(auditRows = [], key = 'region') {
  const groups = new Map()
  for (const r of auditRows || []) {
    if (!r) continue
    const name = String(r[key] || '').trim() || UNPLACED
    if (!groups.has(name)) groups.set(name, [])
    groups.get(name).push(r)
  }

  return [...groups.entries()]
    .map(([name, list]) => {
      const scored = list.map((r) => ({ row: r, d0: day0Of(r), n7: n7Of(r), size: checksTotalOf(r) }))
      const day0Rows = scored.filter((s) => isNum(s.d0))
      const n7Rows = scored.filter((s) => isNum(s.n7))

      // ── A pass rate, not an average score ────────────────────────────────
      //
      // These two used to be the MEAN of each audit's percentage, and that is a
      // different measurement wearing the same word. An auditor with eleven
      // audits averaging 78% — only one of which reached the 90 mark — read
      // "78%" on a chart headed "Pass rate by auditor", beside a table saying
      // 1 of 11. Both figures were right and they could not both be the pass
      // rate.
      //
      // Every other pass figure on this page is the share of audits at or above
      // the mark: the headline KPIs, the recovery ramp, the trend, the auditor
      // table. This is now that too, so the same word means the same thing
      // wherever it appears.
      //
      // The mean survives beside it as day0Avg/n7Avg — it is a real and useful
      // number, it just is not the pass rate, so it is named separately and
      // read out where there is room to say which is which.
      const share = (list2, read) =>
        list2.length ? pct((list2.filter((s) => read(s) >= PASS_MARK).length / list2.length) * 100) : null
      const mean = (list2, read) =>
        list2.length ? pct(list2.reduce((n, s) => n + read(s), 0) / list2.length) : null

      const day0 = share(day0Rows, (s) => s.d0)
      const n7 = share(n7Rows, (s) => s.n7)
      const day0Avg = mean(day0Rows, (s) => s.d0)
      const n7Avg = mean(n7Rows, (s) => s.n7)

      const totals = passTotals(list)
      return {
        name,
        day0,
        n7,
        // The mean of the scores themselves. Not the bar — see above — but the
        // answer to "how well did they do", which the pass rate alone flattens:
        // eleven audits at 89 and eleven at 12 are both a 0% pass rate.
        day0Avg,
        n7Avg,
        // The change is the point of putting the two side by side: it is what
        // the seven days of remediation bought.
        delta: isNum(day0) && isNum(n7) ? pct(n7 - day0) : null,
        audits: list.length,
        n7Audits: n7Rows.length,
        // ── How many AUDITS passed, not how many checks ───────────────────────
        //
        // `passed`/`failed` below are check counts, and a question that gives
        // only percentages has none of those — which is most of them, and every
        // panel that leaned on them read zero. These two are the count of
        // audits at or above the pass mark after the seven-day window, which is
        // what "how many passed" means to the person asking, and which exists
        // whichever way the question states its result.
        auditsPassed: n7Rows.filter((s) => s.n7 >= PASS_MARK).length,
        auditsFailed: n7Rows.filter((s) => s.n7 < PASS_MARK).length,
        // The raw counts behind the percentage, where the question gave them.
        // A tooltip reading "412 of 500 checks" is what makes a bar auditable.
        passed: totals.passed,
        failed: totals.failed,
        checks: totals.checks,
        // The bar is a count of audits over a count of audits, so there is no
        // weighting question left to answer and nothing for the panel to
        // caveat. Kept as a constant so the shape of the row does not change.
        basis: 'share',
      }
    })
    .sort((a, b) => (a.day0 ?? 101) - (b.day0 ?? 101) || a.name.localeCompare(b.name))
}

/**
 * Everything the ODIN tab draws, from one filtered population.
 *
 * One function so nothing on screen can disagree with anything else on screen —
 * the same contract every other analytics tab in this app holds to.
 */
export function odinAnalytics(rows = [], audits = [], sites = [], f = {}, { keepUnplaced = true } = {}) {
  const resolved = resolveOdinRows(rows, sites, { keepUnplaced })
  const filtered = filterOdinRows(resolved, f)
  const { pins, unplaced } = sitePins(filtered)

  // The audits question is filtered on the dimensions it shares with the
  // findings — region, entity, month. Status and sub-category are properties of
  // a finding, not of an audit, so applying them here would silently shrink the
  // pass-rate population every time somebody clicked a status.
  //
  // Site scoping DOES apply: an audit of a site this viewer cannot see is as
  // out of bounds as a finding at one.
  const auditsResolved = resolveOdinRows(audits, sites, { keepUnplaced })
  const auditsFiltered = filterOdinRows(auditsResolved, {
    region: f.region, entity: f.entity, source: f.source, from: f.from, to: f.to,
    // The estate dimensions belong to the SITE, so an audit has them just as a
    // finding does and they scope both. Status, sub-category and priority are
    // properties of a finding and are deliberately still left out.
    city: f.city, ownership: f.ownership, businessLine: f.businessLine,
    centerType: f.centerType, auditType: f.auditType,
  })

  // ── Where the pass rates come from ────────────────────────────────────────
  //
  // The audits question when it carries them. Otherwise the FINDINGS question,
  // if its rows carry pass/fail columns — plenty of warehouses hold one table
  // per checklist line, with the pass or fail on the same row as the finding,
  // and requiring a second saved question to unlock a chart the data already
  // supports is a configuration tax with nothing behind it.
  //
  // The fallback is narrowed to the rows that actually carry a pass figure, not
  // applied to all of them: a findings table where only the failures are rows
  // would otherwise report a 0% pass rate with total confidence.
  //
  // Which source ran is returned, because the two answer subtly different
  // questions — one is per audit, the other per checklist line — and a reader
  // comparing this month with last has to know if the basis moved under them.
  // Which dimension everything is grouped by. Resolved once, from what the
  // data actually carries, so the charts and the picker cannot disagree.
  const dimensions = dimensionsPresent([...filtered, ...auditsFiltered])
  const groupBy = resolveGroupBy(dimensions, f.groupBy)

  const population = auditPopulation(filtered, auditsFiltered)
  const passRows = population.rows
  const passSource = population.source

  return {
    rows: filtered,
    totals: statusTotals(filtered),
    byRegion: statusByRegion(filtered),
    bySubCategoryAll: bySubCategory(filtered),
    bySubCategoryTop: bySubCategory(filtered, { limit: 8 }),
    pins,
    unplaced,
    cities: cityPins(filtered),
    siteIssues: siteIssues(filtered),
    passByRegion: passRates(passRows, 'region'),
    passByEntity: passRates(passRows, 'entity'),
    passOverall: passTotals(passRows),
    passSource,
    passRowCount: passRows.length,
    auditCount: auditsFiltered.length,

    // ── Added for the FLS view ───────────────────────────────────────────────
    // Grouped by whichever dimension the reader picked, rather than the two
    // this tab used to hard-code — an estate of near-identical sites is cut by
    // city, brand and operating model, and none of those are "region".
    groupBy,
    passByGroup: passRates(passRows, groupBy),
    statusByGroup: statusByRegion(filtered.map((r) => ({ ...r, region: r[groupBy] || '' }))),
    dimensions,

    // The time series, at the grain the reader picked.
    trend: passTrend(passRows, f.gran || 'month'),
    tickets: ticketTrend(filtered, f.gran || 'month'),

    // Remediation cuts. Absent columns simply produce an empty list, which the
    // panels render as "your question does not carry this" rather than as zero.
    byPriority: countBy(filtered, 'priority'),
    bySla: countBy(filtered, 'sla'),
    byCheckpoint: countBy(filtered, 'checkpoint', { limit: 12 }),
    ageing: ticketAgeing(filtered),
    observations: observationsPerSite(filtered),
    fls: flsCategories(filtered),
    qoq: quarterOnQuarter(filtered),
    recovery: recoveryStages(passRows),
    distribution: scoreBands(passRows),
    watchlist: centreWatchlist(filtered, auditsFiltered),
    breached: filtered.reduce((n, r) => n + (isBreach(r.sla) ? (isNum(r.count) ? r.count : 1) : 0), 0),

    // How the warehouse rows found a site in this app's register. The map and
    // every region/entity chart depend on this join, so its quality is a
    // first-class number rather than something to infer from a thin map.
    join: joinQuality([...filtered, ...auditsFiltered]),

    // Region coverage, measured BEFORE the filter and kept per population.
    // Per population because the two tabs count different things and a caveat
    // that says "audits" while quoting a ticket count is worse than no caveat.
    coverage: {
      findings: regionCoverage(resolved),
      audits: regionCoverage(auditsResolved),
    },
  }
}

/**
 * Who audited what, cut by region (or any other dimension).
 *
 * Two questions in one table, and they are different questions: how much work
 * an auditor did, and how the sites they audited scored. The second is NOT a
 * performance measure and the tab says so — an auditor sent to the twenty worst
 * centres in the estate will post the worst pass rate on the page, and reading
 * that as a reflection on them is the single most likely way this table gets
 * misused.
 *
 * Returns the groups actually present as `columns`, so the caller can build a
 * stacked bar without knowing the estate's regions in advance.
 */
export function auditorMatrix(auditRows = [], dimKey = 'region', { maxColumns = 8, otherLabel = 'groups' } = {}) {
  const columns = new Set()
  const byAuditor = new Map()

  for (const r of auditRows || []) {
    if (!r) continue
    const who = String(r.auditor || '').trim() || UNPLACED
    const group = String(r[dimKey] || '').trim() || UNPLACED
    columns.add(group)

    let a = byAuditor.get(who)
    if (!a) { a = { name: who, total: 0, groups: {}, sites: new Set(), scored: 0, passed: 0, types: new Set() }; byAuditor.set(who, a) }
    a.total += 1
    a.groups[group] = (a.groups[group] || 0) + 1
    if (r.site) a.sites.add(r.site)
    if (r.auditType) a.types.add(r.auditType)
    // Judged after the seven-day window where there is one, falling back to the
    // day-of score, so the column means one thing down its whole length.
    const score = isNum(n7Of(r)) ? n7Of(r) : day0Of(r)
    if (isNum(score)) { a.scored += 1; if (score >= PASS_MARK) a.passed += 1 }
  }

  const rows = [...byAuditor.values()]
    .map((a) => ({
      name: a.name,
      total: a.total,
      groups: a.groups,
      sites: a.sites.size,
      scored: a.scored,
      passed: a.passed,
      passRate: a.scored ? pct((a.passed / a.scored) * 100) : null,
      auditTypes: [...a.types].sort((x, y) => x.localeCompare(y)),
    }))
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name))

  // Busiest group first, so the widest band of every stacked bar is the one
  // nearest the axis and the chart reads left to right by size.
  const volume = (g) => rows.reduce((t, r) => t + (r.groups[g] || 0), 0)
  const ranked = [...columns].sort((x, y) => volume(y) - volume(x) || x.localeCompare(y))

  // ── Why the tail is folded ─────────────────────────────────────────────────
  //
  // Split by city this returns twenty-eight groups, and the palette holds
  // twelve — so city one and city thirteen come out the same colour, in a
  // stacked bar where colour is the ONLY thing telling them apart. Past about
  // eight bands the chart has stopped being readable anyway: the slices are a
  // pixel wide and the legend is three rows deep.
  //
  // So the tail becomes one named band, the same way bySubCategory pools the
  // long tail for the pie. Nothing is lost — the count is still in the bar and
  // the table below still lists every group per auditor.
  let final = ranked
  if (maxColumns > 0 && ranked.length > maxColumns) {
    const keep = ranked.slice(0, maxColumns - 1)
    const tail = ranked.slice(maxColumns - 1)
    const label = `Other (${tail.length} ${otherLabel})`
    for (const r of rows) {
      let n = 0
      for (const g of tail) { n += r.groups[g] || 0; delete r.groups[g] }
      if (n) r.groups[label] = n
    }
    final = [...keep, label]
  }

  return {
    rows,
    columns: final,
    total: rows.reduce((n, r) => n + r.total, 0),
  }
}

/**
 * The same audits counted twice: passing on the day, and passing once the
 * seven-day window is credited.
 *
 * An ordered progression rather than two groups, which is why the tab draws it
 * as one ramp. The denominator is shared and stated, because "2,157 passed"
 * means nothing without the 3,242 it is out of.
 *
 * A third stage used to sit on the end — "Passed to date", from the centre's
 * score as of today. It came off because it is not bounded by the reader's
 * dates: it credits remediation that happened after the window and moves on
 * every refresh, so it answered a different question than the two beside it
 * while looking identical. See toDateOf.
 */
export function recoveryStages(rows = []) {
  const count = (read) => {
    let n = 0
    let p = 0
    for (const r of rows || []) {
      const v = read(r)
      if (!isNum(v)) continue
      n++
      if (v >= PASS_MARK) p++
    }
    return { n, p }
  }
  const d0 = count(day0Of)
  const n7 = count(n7Of)
  // The denominator is the largest of the three: an audit carrying a day-0
  // score but no to-date one still happened, and dividing the later stages by
  // their own smaller n would draw recovery that did not occur.
  const total = Math.max(d0.n, n7.n)
  const stage = (label, c) => ({ label, passed: c.p, scored: c.n, rate: total ? pct((c.p / total) * 100) : null })
  return {
    total,
    stages: [
      stage('Passed on the day', d0),
      stage('Passed after 7 days', n7),
    ],
  }
}

/**
 * Audits by score band, judged after the seven-day window.
 *
 * Banded either side of the pass mark rather than evenly, because a near miss
 * and a collapse are different problems with different fixes and an even
 * ten-band histogram hides which one you have.
 */
export function scoreBands(rows = []) {
  const bands = [
    { name: '< 60', lo: 0, hi: 60 },
    { name: '60–75', lo: 60, hi: 75 },
    { name: '75–85', lo: 75, hi: 85 },
    { name: `85–${PASS_MARK}`, lo: 85, hi: PASS_MARK },
    { name: `${PASS_MARK}–95`, lo: PASS_MARK, hi: 95 },
    { name: '95–100', lo: 95, hi: 100.01 },
  ].map((b) => ({ ...b, value: 0, passing: b.lo >= PASS_MARK }))

  let scored = 0
  for (const r of rows || []) {
    const v = isNum(n7Of(r)) ? n7Of(r) : day0Of(r)
    if (!isNum(v)) continue
    scored++
    const b = bands.find((x) => v >= x.lo && v < x.hi)
    if (b) b.value += 1
  }
  return { bands, scored }
}

/**
 * One row per centre, audits and tickets side by side.
 *
 * A table on purpose. Six measures across hundreds of centres is past what any
 * colour scale can carry, and this is the artefact somebody takes into a review
 * — sorted worst-first, because that is the order the meeting runs in.
 *
 * The two questions are joined on the site each row already resolved to, so a
 * centre the register knows by one name and the warehouse by another still
 * lands on one line.
 */
export function centreWatchlist(findingRows = [], auditRows = []) {
  const byKey = new Map()
  const keyOf = (r) => r.matchedSiteId || norm(r.site) || UNPLACED
  const get = (r) => {
    const k = keyOf(r)
    let g = byKey.get(k)
    if (!g) {
      g = { key: k, site: r.site || UNPLACED, region: r.region || '', city: r.city || '', audits: 0, passed: 0, scored: 0, tickets: 0, open: 0, breached: 0, red: 0 }
      byKey.set(k, g)
    }
    if (!g.site || g.site === UNPLACED) g.site = r.site || g.site
    if (!g.region) g.region = r.region || ''
    if (!g.city) g.city = r.city || ''
    return g
  }

  for (const r of auditRows || []) {
    if (!r) continue
    const g = get(r)
    g.audits += 1
    const v = isNum(n7Of(r)) ? n7Of(r) : day0Of(r)
    if (isNum(v)) { g.scored += 1; if (v >= PASS_MARK) g.passed += 1 }
  }
  for (const r of findingRows || []) {
    if (!r) continue
    const g = get(r)
    const n = isNum(r.count) ? r.count : 1
    g.tickets += n
    if (isOutstanding(r.status)) g.open += n
    if (isBreach(r.sla)) g.breached += n
    if (/red/i.test(String(r.priority || ''))) g.red += n
  }

  return [...byKey.values()]
    .map((g) => ({ ...g, passRate: g.scored ? pct((g.passed / g.scored) * 100) : null }))
    // Worst pass rate first; centres with no audit at all sort to the bottom
    // rather than to the top, where a null would otherwise read as zero.
    .sort((a, b) => (a.passRate ?? 1e3) - (b.passRate ?? 1e3) || b.open - a.open || a.site.localeCompare(b.site))
}

/** How many rows matched a site by id, by name, or not at all. */
export function joinQuality(rows = []) {
  let byId = 0, byName = 0, unmatched = 0
  for (const r of rows || []) {
    if (!r) continue
    if (r.matchedBy === 'id') byId += 1
    // 'name~' is the punctuation-insensitive pass — still a name match, and
    // counting it as unmatched would report a join failure that did not happen.
    else if (r.matchedBy === 'name' || r.matchedBy === 'name~') byName += 1
    else unmatched += 1
  }
  return { byId, byName, unmatched, total: byId + byName + unmatched }
}

/**
 * How many rows can be placed in a REGION, and precisely why the rest cannot.
 *
 * This exists because of the most confusing thing this dashboard does. The
 * audits question carries no region column — it has a city and a centre id and
 * nothing else — so every region on this page comes from THIS APP's site
 * register, reached through the centre id. A row that cannot make that trip has
 * no region, and the moment somebody picks a region it disappears, with nothing
 * on screen to say it ever existed. Metabase says eighty, the dashboard says
 * sixty, and both are right about different populations.
 *
 * The two ways it fails need DIFFERENT fixes, so they are counted separately
 * rather than totalled into one unhelpful "unmatched":
 *
 *   noSite   — the centre id matched nothing in the register. Add that id to
 *              the site, or add the site.
 *   noRegion — it matched a site, and that site has no region recorded. Fill
 *              the region in on the site itself.
 *
 * Computed on the UNFILTERED population deliberately. Measuring it after the
 * filter would report zero every time somebody picked a region, which is the
 * one moment the number matters.
 */
export function regionCoverage(rows = []) {
  const noSite = new Map()
  const noRegion = new Map()
  let placed = 0
  for (const r of rows || []) {
    if (!r) continue
    if (String(r.region || '').trim()) { placed += 1; continue }
    // Named, not just counted. "Twenty audits have no region" is a fact nobody
    // can act on; "Cult Jubilee Hills and three others" is a morning's work.
    const label = String(r.site || '').trim() || (r.siteId ? `centre ${r.siteId}` : '(unnamed centre)')
    const bucket = r.inScope ? noRegion : noSite
    bucket.set(label, (bucket.get(label) || 0) + 1)
  }
  const size = (m) => [...m.values()].reduce((s, n) => s + n, 0)
  const names = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k)
  return {
    placed,
    noSite: size(noSite),
    noRegion: size(noRegion),
    missing: size(noSite) + size(noRegion),
    total: placed + size(noSite) + size(noRegion),
    noSiteCentres: names(noSite),
    noRegionCentres: names(noRegion),
  }
}
