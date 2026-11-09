// ─────────────────────────────────────────────────────────────────────────────
// Per-site counts for the WhatsApp site lookup, ported from the app.
//
// functions/ is its own npm package and deploys only its own folder, so it
// cannot import src/. These are server copies of the definitions the app
// already shows, pinned to them by src/pages/admin/siteSummary.parity.test.js,
// which runs the browser helpers and these over the same fixtures. Without that
// test the number a site manager reads on WhatsApp and the number on
// Admin → Sites drift apart, and somebody notices at an audit.
//
//   extinguishers     siteStats().extinguishers (src/pages/admin/siteStats.js),
//                     attribution through linkAssets + matchEquip
//   hptOverdue        deriveStatus().flags.HPT_DUE on a unit that is not closed
//                     (src/modules/fire/lib/extinguisherLogic.js). This count is
//                     the date. Closing the defect row does not move the date,
//                     so a closed HPT stays overdue here until a test is recorded.
//   openDefects       the Defect Repository (src/modules/fire/DefectRepository.jsx):
//                     physicalOpen + derived HPT due / Empty + pending AED and
//                     fire-alarm QR reports. A closed HPT-due row (hptClosedFor
//                     equal to dateOfNextHPT) is omitted, matching
//                     hptSuppressed() in src/modules/fire/lib/defectClosure.js.
//                     The WhatsApp lookup reads the snapshot this builds.
//   firstAidBoxes     the declared number on the site document
//   actions           the Central Action Tracker (src/modules/actions/lib/sources.js)
//                     WITHOUT the equipment source (those are the defects above,
//                     counted once) and WITHOUT illness actions (at a small site a
//                     count can point at one person's health), and without the
//                     committee / escalation / legal sources, which carry no site
//   incidents         siteStats() matchIncident; open = lifecycle not closed or
//                     verified; last 90 days by incidentDate
//
// Only counts and statuses are read. Every one of them is plaintext under
// src/shared/crypto/policy.js, so nothing here needs a data key — and the
// function that calls this must not bind DATA_KEY_MASTER.
//
// Dates are compared as IST calendar days ('YYYY-MM-DD'). The app compares in
// the browser's local calendar, which for this tenant is IST; Cloud Functions
// run in UTC, so "today" is computed for Asia/Kolkata explicitly rather than
// taken from the runtime clock's local fields.
// ─────────────────────────────────────────────────────────────────────────────

// ── Site-name resolution, as the APP does it ─────────────────────────────────
// Deliberately the app's resolver (src/modules/fire/lib/siteLink.js), not the
// tiered refuse-when-ambiguous one in ./siteLinks.js. The counts here must equal
// the ones Admin → Sites shows, and that screen uses first-writer-wins indexing
// with the override table consulted first. ./siteLinks.js is right for an
// unattended WRITE; this is a read that has to agree with a screen.
import { SITE_NAME_OVERRIDES } from './siteLinks.js'

const base = (s) =>
  String(s ?? '')
    .trim()
    .toLowerCase()
    .replace(/[‐-―]/g, '-')
    .replace(/\s+/g, ' ')
const alnum = (s) =>
  base(s)
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
const core = (s) =>
  alnum(s)
    .split(' ')
    .filter((w) => w !== 'gym')
    .join(' ')

export function appIndexSites(sites = []) {
  const idx = new Map()
  for (const s of sites) {
    for (const f of [base, alnum, core]) {
      const k = f(s.name)
      if (k && !idx.has(k)) idx.set(k, s)
    }
  }
  return idx
}

export function appResolveSite(centerName, sites = [], idx = appIndexSites(sites)) {
  const raw = String(centerName ?? '').trim()
  if (!raw) return null
  if (Object.prototype.hasOwnProperty.call(SITE_NAME_OVERRIDES, raw)) {
    const mapped = SITE_NAME_OVERRIDES[raw]
    const site = sites.find((s) => base(s.name) === base(mapped))
    return site ? { site, how: 'override' } : null
  }
  const exact = sites.find((s) => s.name === raw)
  if (exact) return { site: exact, how: 'exact' }
  const hit = idx.get(base(raw)) || idx.get(alnum(raw)) || idx.get(core(raw))
  return hit ? { site: hit, how: 'normalised' } : null
}

// ── Calendar days in IST ─────────────────────────────────────────────────────
const IST_OFFSET_MS = 330 * 60 * 1000

/** 'YYYY-MM-DD' for an instant, on the Asia/Kolkata calendar. */
export function istDay(date = new Date()) {
  const d = new Date(date.getTime() + IST_OFFSET_MS)
  return d.toISOString().slice(0, 10)
}

/**
 * A stored date as an IST calendar day, or null.
 *
 * Strings beginning 'YYYY-MM-DD' are taken at face value: the app's parseISO
 * reads a date-only string as local midnight, i.e. that same calendar day.
 * Timestamps and Dates are converted to the IST day they fall on.
 */
export function dayOf(value) {
  if (!value) return null
  if (typeof value === 'string') {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim())
    if (m) return `${m[1]}-${m[2]}-${m[3]}`
    const d = new Date(value)
    return Number.isNaN(d.getTime()) ? null : istDay(d)
  }
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : istDay(value)
  if (typeof value === 'object' && typeof value.toDate === 'function') {
    try {
      const d = value.toDate()
      return d instanceof Date && !Number.isNaN(d.getTime()) ? istDay(d) : null
    } catch {
      return null
    }
  }
  if (typeof value === 'number') return istDay(new Date(value))
  return null
}

/** Whole days from `today` to `day` (both 'YYYY-MM-DD'); negative is past. */
function daysBetween(today, day) {
  return Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000)
}

// ── Equipment ────────────────────────────────────────────────────────────────
// Mirrors DEFECTS in src/modules/fire/lib/constants.js.
export const PHYSICAL_DEFECT_KEYS = ['pin', 'stand', 'hose_pipe', 'handle']
export const REFILL_DEFECT_KEYS = ['empty', 'over_pressurized']
const CLOSED = 'closed'

const norm = (s) => (s == null ? '' : String(s)).trim().toLowerCase()
const alive = (r) => r && !r.deletedAt

/** siteStats linkAssets: every asset to a site id, once per registry. */
export function linkAssets(assets = [], sites = [], idx = appIndexSites(sites)) {
  const links = new Map()
  if (!sites.length) return links
  for (const a of assets) {
    if (!a || a.deletedAt) continue
    if (a.siteId) {
      links.set(a, a.siteId)
      continue
    }
    const hit = appResolveSite(a.centerName, sites, idx)
    if (hit) links.set(a, hit.site.id)
  }
  return links
}

/** siteStats matchEquip. */
export function matchEquip(rec, site, links) {
  const linked = links?.get(rec) || rec.siteId
  if (linked) return linked === site.id
  const n = norm(site.name)
  if (!n) return false
  if (norm(rec.centerName) === n) return true
  const covered = rec.sitesCovered
  if (Array.isArray(covered)) return covered.some((c) => norm(c).includes(n))
  return norm(covered).includes(n) || norm(rec.site).includes(n) || norm(rec.location).includes(n)
}

/** siteStats matchIncident. */
export function matchIncident(inc, site) {
  if (inc.siteId && inc.siteId === site.id) return true
  const n = norm(site.name)
  if (!n) return false
  return norm(inc.location).includes(n) || norm(inc.site).includes(n)
}

/**
 * The Defect Repository suppresses an HPT-due row that was closed against the
 * due date the unit still carries. Copy of hptSuppressed() — functions/ cannot
 * import src/, and the parity test is what keeps the two copies the same.
 */
export function hptClosed(ext) {
  const forDate = ext?.hptClosedFor
  return typeof forDate === 'string' && forDate !== '' && forDate === (ext?.dateOfNextHPT || '')
}

/** deriveStatus().flags.HPT_DUE: the HPT date is today or past. */
export function isHptDue(ext, today) {
  const day = dayOf(ext?.dateOfNextHPT)
  return day !== null && daysBetween(today, day) <= 0
}

/**
 * The Defect Repository's rows, each tagged with the record that places it.
 * `{ kind: 'extinguisher'|'aed'|'fas', asset }` — `asset` is attributed to a
 * site the same way the asset itself is.
 */
export function defectRows({ extinguishers = [], aeds = [], fas = [], reports = [] }, today) {
  const active = extinguishers.filter(alive)
  const byId = new Map(active.map((e) => [e.id, e]))
  const rows = []
  const seen = new Set()

  // physicalOpen: derivePhysicalDefectLog(reports, active).open
  for (const r of reports) {
    if (!r || r.approvalStatus !== 'approved' || r.kind !== 'defect') continue
    if (!PHYSICAL_DEFECT_KEYS.includes(r.defectType)) continue
    const ext = byId.get(r.extId)
    if (!ext) continue
    if (!Array.isArray(ext.physicalDefects) || !ext.physicalDefects.includes(r.defectType)) continue
    rows.push({ kind: 'extinguisher', asset: ext, defectType: r.defectType, report: r })
    seen.add(`${ext.id}:${r.defectType}`)
  }

  // deriveExtinguisherDefects: HPT due and Empty, for units not closed.
  for (const ext of active) {
    if (ext.status === CLOSED) continue
    const push = (key) => {
      const id = `${ext.id}:${key}`
      if (seen.has(id)) return
      seen.add(id)
      rows.push({ kind: 'extinguisher', asset: ext, defectType: key })
    }
    if (isHptDue(ext, today) && !hptClosed(ext)) push('hpt_due')
    const defects = Array.isArray(ext.physicalDefects) ? ext.physicalDefects : []
    if (defects.filter((k) => REFILL_DEFECT_KEYS.includes(k)).includes('empty')) push('empty')
  }

  // pendingReports of kind asset_defect, joined to the AED / FAS register.
  const deletedAed = new Set(aeds.filter((a) => a && a.deletedAt).map((a) => a.id))
  const deletedFas = new Set(fas.filter((a) => a && a.deletedAt).map((a) => a.id))
  const aedById = new Map(aeds.filter(alive).map((a) => [a.id, a]))
  const fasById = new Map(fas.filter(alive).map((a) => [a.id, a]))
  for (const r of reports) {
    if (!r || r.approvalStatus !== 'pending' || r.deletedAt || r.kind !== 'asset_defect') continue
    const isFas = r.assetKind === 'fas'
    if (r.assetKind === 'aed' && deletedAed.has(r.assetRefId)) continue
    if (isFas && deletedFas.has(r.assetRefId)) continue
    const asset = (isFas ? fasById : aedById).get(r.assetRefId)
    if (!asset) continue // no register row: the repository shows it with no site
    rows.push({ kind: isFas ? 'fas' : 'aed', asset, defectType: 'asset', report: r })
  }
  return rows
}

// Mirrors DEFECTS labels in src/modules/fire/lib/constants.js, plus the two
// derived rows the Defect Repository adds (HPT due, Empty).
export const EXT_DEFECT_LABELS = {
  pin: 'PIN',
  stand: 'Stand',
  hose_pipe: 'Hose Pipe Damage',
  handle: 'Handle Damage',
  empty: 'Empty',
  over_pressurized: 'Over Pressurized',
  hpt_due: 'HPT Due',
}

/** How many items per equipment type a reply lists; the rest are "+N more". */
export const DEFECT_ITEMS_MAX = 5

/**
 * One defect row as the Defect Repository labels it: `label` is the unit
 * (serial no. for an extinguisher, asset / device id or the QR label for an
 * AED or panel) and `where` its location; `defect` the defect text.
 */
export function defectItem(row) {
  const a = row.asset || {}
  const str = (v) => (typeof v === 'string' ? v.trim() : '')
  if (row.kind === 'extinguisher') {
    return {
      label: str(a.serialNo),
      where: str(a.location),
      defect: EXT_DEFECT_LABELS[row.defectType] || str(row.defectType),
    }
  }
  const r = row.report || {}
  return {
    label: str(row.kind === 'fas' ? a.deviceId : a.assetId) || str(r.assetLabel),
    where: str(a.location),
    defect: str(r.defect) || 'Reported defect',
  }
}

// ── Actions (Action Tracker, site-attributable sources only) ─────────────────
const incidentNorm = (s) => (s === 'closed' ? 'done' : s === 'in_progress' ? 'in_progress' : 'open')
const drillNorm = (s) => (s === 'Closed' ? 'done' : s === 'In Progress' ? 'in_progress' : 'open')
const auditNorm = (s) =>
  s === 'done' || s === 'Closed'
    ? 'done'
    : s === 'in_progress' || s === 'Submitted for Verification'
      ? 'in_progress'
      : 'open'

/** isOverdue from sources.js: not done, has a due date, due < today. */
export const isOverdue = (due, n, today) => n !== 'done' && !!due && String(due) < today

/**
 * Action items as the tracker flattens them, with the document they came from.
 * `{ source, doc, due, norm }`. Skips items without an id, as subscribeActions does.
 */
export function actionItems(
  { incidents = [], mockDrills = [], inspectionRecords = [], auditFindings = [] },
  modules = {}
) {
  const out = []
  const on = (key) => modules[key] !== false
  if (on('incidents')) {
    for (const d of incidents) {
      if (!alive(d)) continue
      for (const a of (d.capa || []).filter(Boolean)) {
        if (a.id === undefined || a.id === null) continue
        out.push({
          source: 'incidents',
          doc: d,
          due: a.dueDate || '',
          norm: incidentNorm(a.status || 'open'),
        })
      }
    }
  }
  if (on('drills')) {
    for (const d of mockDrills) {
      if (!alive(d)) continue
      ;(d.capa || []).forEach((c) => {
        out.push({
          source: 'drills',
          doc: d,
          due: c?.due || '',
          norm: drillNorm(c?.status || 'Open'),
        })
      })
    }
  }
  if (on('inspections')) {
    for (const d of inspectionRecords) {
      if (!alive(d)) continue
      for (const r of Object.values(d.responses || {})) {
        if (!r || r.answer !== 'Fail') continue
        out.push({
          source: 'inspections',
          doc: d,
          due: r.actionDue || '',
          norm: incidentNorm(r.actionStatus || 'open'),
        })
      }
    }
  }
  if (on('audit')) {
    for (const d of auditFindings) {
      if (!alive(d)) continue
      for (const f of (d.findings || []).filter(Boolean)) {
        if (f.id === undefined || f.id === null) continue
        out.push({
          source: 'audit',
          doc: d,
          due: f.auditeeDueDate || '',
          norm: auditNorm(f.status || d.status || 'Reported'),
        })
      }
    }
  }
  return out
}

/** Which site an action's source document belongs to, or null. */
export function actionSiteMatches(item, site, sites, idx) {
  const d = item.doc
  const explicit = d.siteId || d.taskDetails?.siteId || ''
  if (explicit) return explicit === site.id
  if (item.source === 'incidents') return matchIncident(d, site)
  const name =
    item.source === 'drills' ? d.centerName : item.source === 'inspections' ? d.siteName : ''
  if (!name) return false
  const hit = appResolveSite(name, sites, idx)
  return Boolean(hit && hit.site.id === site.id)
}

// ── The roll-up ──────────────────────────────────────────────────────────────
const OPEN_LIFECYCLE_EXCLUDED = new Set(['closed', 'verified'])

/**
 * Counts for every site in one pass over the org's data.
 *
 * @param data  { sites, extinguishers, aeds, fas, reports, incidents,
 *                mockDrills, inspectionRecords, auditFindings }
 * @param opts  { now: Date, modules: moduleEntitlements map }
 * @returns { [siteId]: counts }
 */
export function summariseSites(
  data = {},
  { now = new Date(), modules = {}, withItems = false } = {}
) {
  const sites = (data.sites || []).filter((s) => s && s.id)
  const today = istDay(now)
  const idx = appIndexSites(sites)
  const extinguishers = (data.extinguishers || []).filter(Boolean)
  const aeds = (data.aeds || []).filter(Boolean)
  const fas = (data.fas || []).filter(Boolean)
  const links = linkAssets([...extinguishers, ...aeds, ...fas], sites, idx)
  const defects = defectRows({ extinguishers, aeds, fas, reports: data.reports || [] }, today)
  const actions = actionItems(data, modules)
  const incidents = (data.incidents || []).filter(alive)
  const since = istDay(new Date(Date.parse(`${today}T00:00:00Z`) - 90 * 86400000))

  const out = {}
  for (const site of sites) {
    const exts = extinguishers.filter((x) => alive(x) && matchEquip(x, site, links))
    const siteDefects = defects.filter((r) => matchEquip(r.asset, site, links))
    const siteActions = actions.filter(
      (a) => actionSiteMatches(a, site, sites, idx) && a.norm !== 'done'
    )
    const inc = incidents.filter((i) => matchIncident(i, site))
    const siteAeds = aeds.filter((x) => alive(x) && matchEquip(x, site, links))
    out[site.id] = {
      extinguishers: exts.length,
      // siteStats().aeds — the Admin → Sites number; out of service counted apart.
      aeds: siteAeds.length,
      aedsOutOfService: siteAeds.filter((x) => x.status === 'out_of_service').length,
      hptOverdue: exts.filter((x) => x.status !== CLOSED && isHptDue(x, today)).length,
      openDefects: siteDefects.length,
      defectsByKind: {
        extinguisher: siteDefects.filter((r) => r.kind === 'extinguisher').length,
        aed: siteDefects.filter((r) => r.kind === 'aed').length,
        fas: siteDefects.filter((r) => r.kind === 'fas').length,
      },
      firstAidBoxes: Number(site.firstAidBoxes) || 0,
      pendingActions: siteActions.length,
      overdueActions: siteActions.filter((a) => isOverdue(a.due, a.norm, today)).length,
      incidentsTotal: inc.length,
      incidentsOpen: inc.filter((i) => !OPEN_LIFECYCLE_EXCLUDED.has(i.lifecycle)).length,
      incidents90d: inc.filter((i) => {
        const day = dayOf(i.incidentDate)
        return day !== null && day >= since && day <= today
      }).length,
    }
    if (withItems) {
      const pick = (kind) =>
        siteDefects
          .filter((r) => r.kind === kind)
          .slice(0, DEFECT_ITEMS_MAX)
          .map(defectItem)
      out[site.id].defectItems = {
        extinguisher: pick('extinguisher'),
        aed: pick('aed'),
        fas: pick('fas'),
      }
    }
  }
  return out
}
