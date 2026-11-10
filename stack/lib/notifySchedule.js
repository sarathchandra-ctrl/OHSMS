// Notifications that come from the clock rather than from a save: pure rules,
// tested without a server. stack/notify.mjs loads the data, decides which
// items are new (a claim per item, so nothing is told twice) and delivers.
//
//   every 6 hours   RCA still due on an incident; weather risk at a site
//   daily           extinguisher refill / pressure test and AED battery due;
//                   a risk assessment's yearly review
//   monthly (1st)   equipment uptime by entity
//
// Each person gets one notification per run listing everything for them,
// not one per record: twenty open RCAs are one message, not twenty.
//
// Who is told follows stack/lib/notify.js: a record's site managers and every
// administrator, plus the people the rule names.

import {
  allManagers,
  day,
  isManagerRole,
  managersOf,
  message,
  reachable,
  sitePeople,
  siteName,
  sitesOf,
  str,
} from './notify.js'
import { BAND_LABEL, assessWeather, levelOf } from './weatherRisk.js'

const DAY_MS = 24 * 60 * 60 * 1000
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10)
const plusDays = (today, n) => isoDay(Date.parse(`${today}T00:00:00Z`) + n * DAY_MS)
const live = (rows = []) => rows.filter((r) => r && !r.deletedAt)

/** Per-person grouping: Map uid → { user, rows: [] }. */
function collect() {
  const byUser = new Map()
  return {
    add(users, row) {
      for (const u of users) {
        if (!u || !reachable(u)) continue
        if (!byUser.has(u.id)) byUser.set(u.id, { user: u, rows: [] })
        const entry = byUser.get(u.id)
        if (!entry.rows.includes(row)) entry.rows.push(row)
      }
    },
    messages(kind, subjectFor, intro, origin, path) {
      return [...byUser.values()].map(({ user, rows }) =>
        message(
          user.email,
          kind,
          subjectFor(rows.length),
          [
            intro(rows.length),
            '',
            ...rows.slice(0, 25).map((r) => `  - ${r}`),
            rows.length > 25 ? `  - and ${rows.length - 25} more` : '',
          ].filter((l, i) => l !== '' || i === 1),
          origin,
          path,
          user.id
        )
      )
    },
  }
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

// ── RCA due (every 6 hours) ──────────────────────────────────────────────────

/**
 * An incident whose investigation (the RCA step: 5-why, fishbone…) is not
 * done yet, and that is not closed. There is no RCA due date in the record,
 * so "due" is "not done": the reminder runs until stagesDone.investigation.
 */
export const rcaOpen = (inc) =>
  Boolean(inc) &&
  !inc.deletedAt &&
  str(inc.lifecycle) !== 'closed' &&
  inc.stagesDone?.investigation !== true

export function rcaMessages({ incidents = [], users = [], sites = [], origin = '' } = {}) {
  const people = new Map(users.map((u) => [u.id, u]))
  const c = collect()
  for (const inc of incidents.filter(rcaOpen)) {
    const where = siteName(inc.siteId, sites, inc.site)
    const row = `${str(inc.refNo) || 'An incident'} at ${where}${inc.incidentDate ? `, ${day(inc.incidentDate)}` : ''}`
    c.add([people.get(inc.createdBy), ...managersOf(inc.siteId, users, sites)], row)
  }
  return c.messages(
    'rca',
    (n) => `RCA due on ${plural(n, 'incident')}`,
    (n) => `The root cause analysis is still to be done on ${plural(n, 'incident')}:`,
    origin,
    '/incidents'
  )
}

// ── Weather (every 6 hours) ──────────────────────────────────────────────────

/** Sites at "take precautions" or worse. `observations`: siteId → obs. */
export function weatherMessages({ observations = {}, users = [], sites = [], origin = '' } = {}) {
  const c = collect()
  for (const site of sites) {
    const obs = observations[site.id]
    if (!obs) continue
    const risk = assessWeather(obs)
    if (levelOf(risk.band) < levelOf('moderate')) continue
    const hazards = risk.hazards
      .filter((h) => levelOf(h.band) >= levelOf('moderate'))
      .map((h) => h.label)
      .join(', ')
    c.add(
      managersOf(site.id, users, sites),
      `${site.name || 'A site'}: ${BAND_LABEL[risk.band]}${hazards ? ` (${hazards})` : ''}`
    )
  }
  return c.messages(
    'weather',
    (n) => `Weather risk at ${plural(n, 'site')}`,
    () => 'Conditions now call for precautions at:',
    origin,
    '/weather'
  )
}

// ── Equipment due (daily) ────────────────────────────────────────────────────

/**
 * Each unit and date that is due, with the claim that makes it a one-time
 * notice: a refill or pressure test within 7 days (or past), an AED battery
 * expiring within 30. A new date (after the refill is done) is a new claim.
 */
export function equipmentDueItems({ extinguishers = [], aeds = [], today } = {}) {
  const items = []
  const due = (date, days) => {
    const d = str(date).slice(0, 10)
    return /^\d{4}-\d{2}-\d{2}$/.test(d) && d <= plusDays(today, days) ? d : ''
  }
  for (const e of live(extinguishers)) {
    if (e.status === 'closed') continue
    const name = `Extinguisher ${str(e.extId || e.serialNo) || e.id}`
    for (const [field, what] of [
      ['dateOfNextRefill', 'refill'],
      ['dateOfNextHPT', 'pressure test (HPT)'],
    ]) {
      const d = due(e[field], 7)
      if (d) {
        items.push({
          claim: `due:ext:${e.id}:${field}:${d}`,
          siteId: str(e.siteId),
          fallback: e.centerName || e.siteName,
          row: `${name}: ${what} ${d < today ? `overdue since ${day(d)}` : `due ${day(d)}`}`,
        })
      }
    }
  }
  for (const a of live(aeds)) {
    const d = due(a.batteryExpiry, 30)
    if (d) {
      items.push({
        claim: `due:aed:${a.id}:battery:${d}`,
        siteId: str(a.siteId),
        fallback: a.centerName,
        row: `AED ${str(a.assetId) || a.id}: battery ${d < today ? `expired ${day(d)}` : `expires ${day(d)}`}`,
      })
    }
  }
  return items
}

export function equipmentDueMessages(items = [], { users = [], sites = [], origin = '' } = {}) {
  const c = collect()
  for (const it of items) {
    const row = `${it.row} at ${siteName(it.siteId, sites, it.fallback)}`
    c.add([...managersOf(it.siteId, users, sites), ...sitePeople(it.siteId, users, sites)], row)
  }
  return c.messages(
    'equipmentDue',
    (n) => `Emergency equipment due: ${plural(n, 'item')}`,
    () => 'Emergency equipment needs attention:',
    origin,
    '/equipment/repository'
  )
}

// ── Risk assessment review (daily check, yearly notice) ─────────────────────

/**
 * Every active assessment is reviewed once a year from its assessment date
 * (the risk matrix's own guidance: "review annually"). One claim per year of
 * its life, so each anniversary is told once.
 */
export function reviewDueItems({ assessments = [], today } = {}) {
  const items = []
  for (const a of assessments) {
    if (!a || str(a.status).toUpperCase() === 'ARCHIVED') continue
    const start = str(a.assessmentDate).slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) continue
    let years = Number(today.slice(0, 4)) - Number(start.slice(0, 4))
    if (today.slice(5) < start.slice(5)) years -= 1
    if (years < 1) continue
    items.push({ claim: `review:${a.id}:${years}`, assessment: a, years })
  }
  return items
}

export function reviewMessages(items = [], { users = [], sites = [], origin = '' } = {}) {
  const c = collect()
  for (const { assessment: a, years } of items) {
    const name = str(a.refId || a.name) || 'A risk assessment'
    const baseline = a.kind === 'baseline'
    const where = baseline ? 'baseline' : siteName(a.siteId, sites, a.siteName)
    const row = `${name} (${where}): ${plural(years, 'year')} since ${day(a.assessmentDate)}`
    c.add(baseline ? allManagers(users) : managersOf(a.siteId, users, sites), row)
  }
  return c.messages(
    'hiraReview',
    (n) => `Annual risk assessment review due: ${plural(n, 'assessment')}`,
    () => 'These risk assessments are due their yearly review:',
    origin,
    '/hira/repository'
  )
}

// ── Uptime by entity (monthly) ───────────────────────────────────────────────

// The same tests the Objectives scorecard uses (src/modules/objectives/lib/
// kpis.js): an extinguisher with no open physical defect, a FAS device that is
// operational (missing status counts as operational), a signage that is
// deployed. An AED is up when it is ready.
const UP = {
  Extinguishers: (u) => !(Array.isArray(u.physicalDefects) && u.physicalDefects.length),
  AED: (u) => str(u.status || 'ready') === 'ready',
  FAS: (u) => str(u.status || 'operational') === 'operational',
  Signage: (u) => str(u.status) === 'Deployed',
}

const pct = (up, all) => (all ? `${Math.round((up / all) * 1000) / 10}%` : '—')

/** Uptime per entity and equipment type: { entity: { type: [up, all] } }. */
export function uptimeByEntity({
  extinguishers = [],
  aeds = [],
  fas = [],
  signages = [],
  sites = [],
} = {}) {
  const entityOf = (u) =>
    str(u.entity) ||
    str(sites.find((s) => String(s.id) === String(u.siteId))?.entity) ||
    'No entity'
  const table = {}
  for (const [type, units] of [
    ['Extinguishers', live(extinguishers).filter((u) => u.status !== 'closed')],
    ['AED', live(aeds)],
    ['FAS', live(fas)],
    ['Signage', live(signages).filter((u) => u.status !== 'Removed')],
  ]) {
    for (const u of units) {
      const e = entityOf(u)
      table[e] ||= {}
      table[e][type] ||= [0, 0]
      table[e][type][1] += 1
      if (UP[type](u)) table[e][type][0] += 1
    }
  }
  return table
}

export function uptimeMessages(
  data = {},
  { users = [], sites = [], origin = '', month = '' } = {}
) {
  const table = uptimeByEntity({ ...data, sites })
  const entities = Object.keys(table).sort()
  if (!entities.length) return []
  const out = []
  for (const u of users) {
    if (!reachable(u) || !isManagerRole(u)) continue
    // An administrator sees every entity; a manager the entities of their sites.
    const mine = sitesOf(u, sites)
    const theirs =
      u.role === 'admin'
        ? entities
        : entities.filter((e) =>
            sites.some((s) => mine.has(String(s.id)) && str(s.entity || 'No entity') === e)
          )
    if (!theirs.length) continue
    const lines = [`Equipment uptime by entity${month ? ` for ${month}` : ''}:`, '']
    for (const e of theirs) {
      const row = Object.entries(table[e])
        .map(([type, [up, all]]) => `${type} ${pct(up, all)} (${up}/${all})`)
        .join(' · ')
      lines.push(`  - ${e}: ${row}`)
    }
    out.push(
      message(
        u.email,
        'uptime',
        `Monthly equipment uptime${month ? ` · ${month}` : ''}`,
        lines,
        origin,
        '/equipment/dashboard',
        u.id
      )
    )
  }
  return out
}
