// ─────────────────────────────────────────────────────────────────────────────
// Portal home aggregates.
//
// Every number on the home screen is scoped to the sites the viewer may see —
// which is the whole reason this is a separate, pure module. Scoping is the
// part that can be silently wrong: a count that quietly includes a site the
// person has no permission for is a data leak, and one that quietly excludes a
// site they own is a wrong answer they will act on.
//
// Assets resolve to a site through the same linkAssets used by the admin site
// rollup, so equipment counted here and equipment counted there cannot diverge.
// ─────────────────────────────────────────────────────────────────────────────
import { linkAssets } from '../admin/siteStats'

const norm = (s) => String(s ?? '').trim().toLowerCase()

/** Signage is compliant when its status is Deployed. Everything else is a finding. */
const SIGNAGE_OK = new Set(['deployed'])

/**
 * Which asset site-ids are in scope.
 * `siteId` of 'all' means every site the viewer can see; a list of ids is a
 * Region / Entity selection (still limited to sites the viewer can see).
 * Only 'all' counts records that carry no site at all — a narrowed view
 * must never show work that might belong somewhere else.
 */
export function scopeIds(sites = [], siteId = 'all') {
  if (siteId === 'all') return new Set(sites.map((s) => s.id))
  const wanted = new Set(Array.isArray(siteId) ? siteId : [siteId])
  return new Set(sites.filter((s) => wanted.has(s.id)).map((s) => s.id))
}

const inScope = (rec, links, ids) => {
  const linked = links.get(rec) || rec.siteId
  return !!linked && ids.has(linked)
}

/**
 * Incidents carry a siteId when raised from the portal, and free-text location
 * or site otherwise. The name fallback exists because most historical incidents
 * predate the site link entirely — without it a site's incident count reads
 * zero however many it actually had.
 */
function incidentInScope(inc, sites, ids) {
  if (inc.siteId) return ids.has(inc.siteId)
  const scoped = sites.filter((s) => ids.has(s.id))
  return scoped.some((s) => {
    const n = norm(s.name)
    return !!n && (norm(inc.location).includes(n) || norm(inc.site).includes(n))
  })
}

const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 100) : null)

/**
 * Everything the home screen shows, for one scope.
 *
 * Compliance percentages return null rather than 0 when there is nothing to
 * measure — "no signage recorded" and "all signage failing" are opposite
 * situations and must not render as the same number.
 */
/**
 * Records that name their site by text rather than by id — meetings, drills,
 * permits. They predate the site registry, so matching on the name is the only
 * link available; without it a site's drill count reads zero however many it
 * ran. Records with no site at all are excluded rather than counted for
 * everyone, which would show one viewer another site's activity.
 */
function namedSiteInScope(rec, sites, ids, fields) {
  if (rec.siteId) return ids.has(rec.siteId)
  const scoped = sites.filter((s) => ids.has(s.id))
  return scoped.some((s) => {
    const n = norm(s.name)
    if (!n) return false
    return fields.some((f) => {
      const v = norm(rec[f])
      return !!v && (v === n || v.includes(n) || n.includes(v))
    })
  })
}

export function portalStats({
  sites = [], siteId = 'all',
  extinguishers = [], aeds = [], fas = [], signages = [], incidents = [],
  assignments = [], users = [], meetings = [], drills = [], permits = [],
} = {}) {
  const ids = scopeIds(sites, siteId)
  const links = linkAssets([...extinguishers, ...aeds, ...fas, ...signages], sites)

  const alive = (r) => !r.deletedAt
  const mine = (list) => list.filter((r) => alive(r) && inScope(r, links, ids))

  const ext = mine(extinguishers)
  const aed = mine(aeds)
  const fasRows = mine(fas)
  const sig = mine(signages)
  const inc = incidents.filter((i) => alive(i) && incidentInScope(i, sites, ids))

  // Training is per person, not per asset, so it scopes through the employee's
  // own site rather than through linkAssets.
  const scopedUids = new Set(
    users.filter((u) => u.siteId && ids.has(u.siteId)).map((u) => u.uid).filter(Boolean)
  )
  // With nobody mapped to a site, scoping by person would report 0% for an org
  // that simply has not filled in siteId yet — so fall back to counting
  // everyone. That fallback is only safe when the viewer can see some site: for
  // someone with no sites at all it would answer a question about the whole org
  // to a person entitled to none of it.
  const relevant = scopedUids.size
    ? assignments.filter((a) => scopedUids.has(a.employeeUid))
    : ids.size ? assignments : []
  const live = relevant.filter((a) => a.status !== 'cancelled')
  const completed = live.filter((a) => a.status === 'completed')

  const signageOk = sig.filter((s) => SIGNAGE_OK.has(norm(s.status)))

  const meet = meetings.filter((m) => alive(m) && namedSiteInScope(m, sites, ids, ['site', 'siteName', 'centerName', 'location']))
  const drill = drills.filter((d) => alive(d) && namedSiteInScope(d, sites, ids, ['centerName', 'site', 'siteName']))
  const perm = permits.filter((p) => alive(p) && namedSiteInScope(p, sites, ids, ['site', 'siteName', 'jobLocation']))

  return {
    counts: {
      extinguishers: ext.length,
      aeds: aed.length,
      fas: fasRows.length,
      incidents: inc.length,
      meetings: meet.length,
      drills: drill.length,
    },
    // The scoped lists themselves, so a widget can ask a question this module
    // does not answer without re-deriving — and therefore re-risking — scope.
    scoped: { extinguishers: ext, aeds: aed, fas: fasRows, meetings: meet, drills: drill, permits: perm },
    trainingCompliance: pct(completed.length, live.length),
    trainingTotal: live.length,
    signageCompliance: pct(signageOk.length, sig.length),
    signageTotal: sig.length,
    incidentsByType: countBy(inc, (i) => i.type || 'unspecified'),
    equipmentBySite: equipmentBySite(sites, ids, links, { ext, aed, fas: fasRows }),
  }
}

/** Today as YYYY-MM-DD, so due dates compare as plain strings. */
export const todayISO = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/**
 * Soonest-due first, overdue ahead of everything, undated last.
 *
 * Undated last is the part that matters: an empty due date sorts ahead of every
 * real one as a string, so the naive comparison buries the genuinely urgent
 * items under work nobody has scheduled.
 */
const byUrgency = (a, b) => {
  if (a.overdue !== b.overdue) return a.overdue ? -1 : 1
  if (!a.due && !b.due) return 0
  if (!a.due) return 1
  if (!b.due) return -1
  return a.due < b.due ? -1 : 1
}

/**
 * The work closest to its due date across the viewer's sites, with who owns it.
 *
 * Deliberately not filtered to the signed-in person — "My actions" already
 * answers that. This answers the other question a supervisor opens the portal
 * for: what is about to slip, and whose is it.
 */
export function pendingWork({
  sites = [], siteId = 'all', actions = [], assignments = [], users = [], limit = 5, today = todayISO(),
} = {}) {
  const ids = scopeIds(sites, siteId)
  const byUid = new Map(users.map((u) => [u.uid, u]))

  // An action carries its own site; where it does not, it stays in scope only
  // when the viewer is looking at everything, so a site filter never shows work
  // that might belong somewhere else.
  const pendingActions = actions
    .filter((a) => a.norm !== 'done')
    .filter((a) => (a.siteId ? ids.has(a.siteId) : siteId === 'all' && ids.size > 0))
    .map((a) => ({
      key: a.key,
      title: a.title,
      owner: ownerName(a.owner) || 'Unassigned',
      source: a.sourceLabel,
      due: a.due || '',
      overdue: !!a.due && a.due < today,
    }))
    .sort(byUrgency)
    .slice(0, limit)

  const scopedUids = new Set(
    users.filter((u) => u.siteId && ids.has(u.siteId)).map((u) => u.uid).filter(Boolean)
  )
  const pendingTraining = assignments
    .filter((a) => a.status !== 'completed' && a.status !== 'cancelled')
    .filter((a) => (scopedUids.size ? scopedUids.has(a.employeeUid) : siteId === 'all' && ids.size > 0))
    .map((a) => ({
      key: a.id || `${a.courseId}:${a.employeeUid}`,
      title: a.courseName || 'Course',
      owner: a.employeeName || byUid.get(a.employeeUid)?.name || 'Unassigned',
      due: a.dueDate || '',
      overdue: !!a.dueDate && a.dueDate < today,
    }))
    .sort(byUrgency)
    .slice(0, limit)

  return { actions: pendingActions, training: pendingTraining }
}

/** Owners are free text in some modules and an object in others. */
function ownerName(owner) {
  if (!owner) return ''
  return typeof owner === 'object' ? owner.name || '' : String(owner)
}

function countBy(rows, key) {
  const m = new Map()
  for (const r of rows) m.set(key(r), (m.get(key(r)) || 0) + 1)
  return [...m.entries()].map(([k, value]) => ({ key: k, value })).sort((a, b) => b.value - a.value)
}

/**
 * Equipment per site, busiest first.
 *
 * Sites with no equipment at all are dropped: a bar chart whose bars are mostly
 * zero-height rows tells the reader nothing except that the list is long.
 */
function equipmentBySite(sites, ids, links, { ext, aed, fas }) {
  const rows = sites
    .filter((s) => ids.has(s.id))
    .map((s) => {
      const count = (list) => list.filter((r) => (links.get(r) || r.siteId) === s.id).length
      const e = count(ext)
      const a = count(aed)
      const f = count(fas)
      return { id: s.id, name: s.name, extinguishers: e, aeds: a, fas: f, total: e + a + f }
    })
    .filter((r) => r.total > 0)
    .sort((a, b) => b.total - a.total)
  return rows
}
