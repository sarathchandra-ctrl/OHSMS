// Who is told what, by mail: pure rules, so every one is tested without a
// server, a database or a mailer. stack/notify.mjs loads the data and sends.
//
// Two kinds of mail:
//   events   sent right after a save that should reach someone: a new
//            incident, a corrective action assigned, a permit awaiting
//            approval, audit findings sent / submitted / returned / closed,
//            training assigned;
//   digest   once a day, each person's own due and overdue work, and for a
//            manager what is due at the sites they look after.
//
// A mail carries a reference, a site, a date and a link back to the app. It
// never carries a narrative, an action's text, a name of someone hurt or
// anything medical: those fields are sealed at rest (src/shared/crypto/
// policy.js), a mailbox is not, and the link opens them for whoever may read
// them. Illness reports are medical throughout and are not mailed at all.

// One switch each in Admin → Organization settings, grouped by `module`.
// Every switch starts on: an organization that never opened the page gets all
// of it, and turning one off is a saved `false`.
export const NOTIFY_KINDS = [
  { key: 'incident', module: 'Incidents', label: 'New incidents', hint: 'To managers of the site, and the notification email' },
  { key: 'action', module: 'Incidents', label: 'Corrective actions assigned', hint: 'To the person the action is assigned to' },
  { key: 'permit', module: 'Permit to Work', label: 'Permits awaiting approval', hint: 'To the named approvers, or the site’s managers' },
  { key: 'audit', module: 'Internal Audit', label: 'Audit findings', hint: 'Sent to the auditee, submitted, returned and closed' },
  { key: 'training', module: 'Training', label: 'Training assigned', hint: 'To the person it is assigned to' },
  { key: 'digest', module: 'Daily summary', label: 'Daily summary email', hint: 'Each morning at 08:00: what is due or overdue, for each person. People can opt out under Security.' },
]

/** Which kinds are on: every kind unless the organization turned it off. */
export function notifySettings(org) {
  const saved = org?.notifications && typeof org.notifications === 'object' ? org.notifications : {}
  return Object.fromEntries(NOTIFY_KINDS.map((k) => [k.key, saved[k.key] !== false]))
}

const str = (v) => (v === undefined || v === null ? '' : String(v))
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const validEmail = (v) => EMAIL.test(str(v).trim())

const INCIDENT_TYPES = {
  near_miss: 'Near miss',
  first_aid: 'First aid injury',
  lost_time: 'Lost time injury',
  reportable: 'Reportable injury',
  property_damage: 'Property damage',
}

/** A person who can receive mail and use the app today. */
export function reachable(user) {
  return (
    Boolean(user) &&
    user.status === 'approved' &&
    user.mustChangePassword !== true &&
    validEmail(user.email)
  )
}

/** Sites a person looks after: every site for an admin, else their grants. */
export function sitesOf(user, sites = []) {
  if (!user) return new Set()
  if (user.role === 'admin') return new Set(sites.map((s) => String(s.id)))
  const a = user.access || {}
  const list = (v) => (Array.isArray(v) ? v : [])
  const ids = new Set(list(a.sites).map(String))
  if (user.siteId) ids.add(String(user.siteId))
  const regions = new Set(list(a.regions))
  const entities = new Set(list(a.entities))
  for (const s of sites) {
    if ((s.region && regions.has(s.region)) || (s.entity && entities.has(s.entity))) ids.add(String(s.id))
  }
  return ids
}

const isManagerRole = (u) => u?.role === 'admin' || u?.role === 'manager'

/** Managers and admins who look after a site ('' = organization level: admins). */
export function managersOf(siteId, users = [], sites = []) {
  return users.filter(
    (u) =>
      reachable(u) &&
      isManagerRole(u) &&
      (u.role === 'admin' || (siteId && sitesOf(u, sites).has(String(siteId))))
  )
}

const siteName = (siteId, sites, fallback = '') =>
  sites.find((s) => String(s.id) === String(siteId))?.name || fallback || 'your organization'

/** 2026-11-12 → 12 Nov 2026, in UTC so the server's time zone does not move it. */
export function day(value) {
  const s = str(value)
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!m) return s
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${Number(m[3])} ${months[Number(m[2]) - 1]} ${m[1]}`
}

// `uid` and `path` are for the in-app bell (stack/notify.mjs writes one
// inbox item per message with a uid); `to` and `text` are for the mailbox.
// The notification email has no uid: it is mailed and never belled.
function message(to, kind, subject, lines, origin, path, uid = '') {
  const link = path ? `${str(origin).replace(/\/$/, '')}${path}` : ''
  const text = [...lines, '', link ? `Open it: ${link}` : '', '', 'You are getting this from your safety management system.']
    .filter((l, i, all) => !(l === '' && all[i - 1] === ''))
    .join('\n')
    .trim()
  return { to: str(to).trim(), uid, kind, subject, summary: str(lines[0]), path: path || '', text }
}

/** Everyone except the person who made the change, once each. */
function audience(users, actorUid) {
  const seen = new Set()
  return users.filter((u) => {
    if (!u || u.id === actorUid || seen.has(u.id)) return false
    seen.add(u.id)
    return true
  })
}

const byId = (users) => new Map(users.map((u) => [u.id, u]))

// ── Events ───────────────────────────────────────────────────────────────────

/**
 * The mail a set of committed changes calls for.
 * `changes` [{ path, id, before, after }] (engine.commit); `ctx` { users,
 * sites, org, origin, actorUid }. Users carry their id as `id`.
 */
export function eventMessages(changes = [], { users = [], sites = [], org = {}, origin = '', actorUid = '' } = {}) {
  const on = notifySettings(org)
  const people = byId(users)
  const out = []
  const to = (u, kind, subject, lines, path) => {
    if (reachable(u) && u.id !== actorUid) out.push(message(u.email, kind, subject, lines, origin, path, u.id))
  }

  for (const { path, id, before, after } of changes) {
    if (!after || after.deletedAt) continue

    if (path === 'incidents') {
      const ref = str(after.refNo) || 'An incident'
      const where = siteName(after.siteId, sites, after.site)
      if (!before && on.incident) {
        const lines = [
          `${ref} was reported at ${where}.`,
          `Type: ${INCIDENT_TYPES[after.type] || 'not set'} · Severity: ${str(after.severity) || 'not set'}`,
          after.incidentDate ? `Date: ${day(after.incidentDate)}` : '',
        ].filter(Boolean)
        for (const u of audience(managersOf(after.siteId, users, sites), actorUid)) {
          to(u, 'incident', `New incident ${ref} at ${where}`, lines, `/incidents/${id}`)
        }
        if (validEmail(org.notificationEmail)) {
          out.push(message(org.notificationEmail, 'incident', `New incident ${ref} at ${where}`, lines, origin, `/incidents/${id}`))
        }
      }
      if (on.action) {
        const was = new Map((before?.capa || []).filter(Boolean).map((a) => [a.id, a.ownerUid]))
        for (const a of (after.capa || []).filter(Boolean)) {
          if (!a.ownerUid || was.get(a.id) === a.ownerUid || a.status === 'closed') continue
          to(
            people.get(a.ownerUid),
            'action',
            `Corrective action assigned to you · ${ref}`,
            [`A corrective action on ${ref} at ${where} is assigned to you.`, a.dueDate ? `Due: ${day(a.dueDate)}` : ''].filter(Boolean),
            `/incidents/${id}`
          )
        }
      }
      continue
    }

    if (path === 'permits' && !before && on.permit) {
      const ref = str(after.permitNo) || 'A permit'
      const where = siteName(after.siteId, sites, after.site)
      const named = [after.assignedEngineer, after.assignedOperator].filter(Boolean).map((uid) => people.get(uid))
      const approvers = named.filter(Boolean).length ? named : managersOf(after.siteId, users, sites)
      for (const u of audience(approvers, actorUid)) {
        to(u, 'permit', `Permit ${ref} awaiting approval`, [`${ref} at ${where} needs approval before work starts.`, after.validFrom ? `From: ${day(after.validFrom)}` : ''].filter(Boolean), `/permits/${id}`)
      }
      continue
    }

    if (path === 'auditFindings' && on.audit) {
      const ref = str(after.docId) || 'An audit'
      const from = str(before?.status)
      const now = str(after.status)
      const auditee = people.get(after.auditeeUid)
      const auditor = people.get(after.createdByUid)
      if (!before && after.auditeeUid) {
        to(auditee, 'audit', `Audit findings for you to answer · ${ref}`, [`${ref} has findings for you to answer in the Auditee Workplace.`], '/audit?view=auditee')
      } else if (from === 'Reported' && now === 'Submitted for Verification') {
        to(auditor, 'audit', `Audit response submitted for verification · ${ref}`, [`The auditee answered ${ref}. It is waiting for your verification.`], '/audit?view=auditor')
      } else if (from === 'Submitted for Verification' && now === 'Reported') {
        to(auditee, 'audit', `Audit response returned · ${ref}`, [`The auditor returned your answer to ${ref} with a note. Open it in the Auditee Workplace.`], '/audit?view=auditee')
      } else if (from === 'Submitted for Verification' && now === 'Closed') {
        to(auditee, 'audit', `Audit verified and closed · ${ref}`, [`The auditor verified and closed ${ref}.`], '/audit?view=auditee')
      }
      continue
    }

    if (path === 'trainingAssignments' && !before && on.training && after.status === 'assigned') {
      to(
        people.get(after.employeeUid),
        'training',
        `Training assigned: ${str(after.courseName) || 'a course'}`,
        [`You have been assigned ${str(after.courseName) || 'a course'}.`, after.dueDate ? `Due: ${day(after.dueDate)}` : ''].filter(Boolean),
        '/training/my'
      )
    }
  }
  return out
}

// ── The daily summary ────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000
const iso = (ms) => new Date(ms).toISOString().slice(0, 10)

/** Overdue, due within `days`, or neither, for a YYYY-MM-DD against today. */
function dueState(date, today, days) {
  const d = str(date).slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return ''
  if (d < today) return 'overdue'
  if (d <= iso(Date.parse(`${today}T00:00:00Z`) + days * DAY_MS)) return 'due'
  return ''
}
const label = (state, date) => (state === 'overdue' ? `overdue since ${day(date)}` : `due ${day(date)}`)

/**
 * One person's summary, or null when there is nothing to say.
 * `data` { incidents, trainingAssignments, trainingRecords, auditFindings,
 * extinguishers, permits, documents, sites }.
 */
export function digestFor(user, data = {}, { today = iso(Date.now()), origin = '' } = {}) {
  if (!reachable(user) || user.digestOptOut === true) return null
  const sites = data.sites || []
  const sections = []
  const add = (title, rows) => {
    if (rows.length) sections.push([title, ...rows.slice(0, 15).map((r) => `  - ${r}`), rows.length > 15 ? `  - and ${rows.length - 15} more` : ''].filter(Boolean))
  }

  const mine = []
  for (const inc of data.incidents || []) {
    if (inc.deletedAt) continue
    for (const a of (inc.capa || []).filter(Boolean)) {
      if (a.ownerUid !== user.id || a.status === 'closed') continue
      const st = dueState(a.dueDate, today, 7)
      if (st) mine.push(`Corrective action on ${str(inc.refNo) || 'an incident'}: ${label(st, a.dueDate)}`)
    }
  }
  add('Your corrective actions', mine)

  const training = []
  for (const t of data.trainingAssignments || []) {
    if (t.employeeUid !== user.id || t.status !== 'assigned') continue
    const st = dueState(t.dueDate, today, 7)
    if (st) training.push(`${str(t.courseName) || 'A course'}: ${label(st, t.dueDate)}`)
  }
  const latest = new Map()
  for (const r of data.trainingRecords || []) {
    if (r.employeeUid !== user.id) continue
    const prev = latest.get(r.courseId)
    if (!prev || str(r.completedOn) > str(prev.completedOn)) latest.set(r.courseId, r)
  }
  for (const r of latest.values()) {
    const st = dueState(r.expiresOn, today, 30)
    if (st) training.push(`${str(r.courseName) || 'A certificate'}: certificate ${st === 'overdue' ? `expired ${day(r.expiresOn)}` : `expires ${day(r.expiresOn)}`}`)
  }
  add('Your training', training)

  const audits = []
  for (const f of data.auditFindings || []) {
    if (f.auditeeUid === user.id && f.status === 'Reported') audits.push(`${str(f.docId) || 'An audit'}: findings to answer`)
    if (f.createdByUid === user.id && f.status === 'Submitted for Verification') audits.push(`${str(f.docId) || 'An audit'}: response to verify`)
  }
  add('Your audits', audits)

  if (isManagerRole(user)) {
    const mySites = sitesOf(user, sites)
    const at = (siteId) => mySites.has(String(siteId))
    const where = (siteId, fallback) => siteName(siteId, sites, fallback)

    const equipment = []
    for (const e of data.extinguishers || []) {
      if (e.deletedAt || !at(e.siteId)) continue
      const id = str(e.extId || e.serialNo) || 'An extinguisher'
      const refill = dueState(e.dateOfNextRefill, today, 7)
      if (refill) equipment.push(`${id} at ${where(e.siteId, e.centerName)}: refill ${label(refill, e.dateOfNextRefill)}`)
      const hpt = dueState(e.dateOfNextHPT, today, 7)
      if (hpt) equipment.push(`${id} at ${where(e.siteId, e.centerName)}: pressure test ${label(hpt, e.dateOfNextHPT)}`)
    }
    add('Equipment at your sites', equipment)

    const permits = []
    for (const p of data.permits || []) {
      if (p.deletedAt || !at(p.siteId)) continue
      const waiting = str(p.engineering?.status || 'pending') === 'pending' || str(p.operations?.status || 'pending') === 'pending'
      if (str(p.storedStatus) === 'draft' && waiting) permits.push(`${str(p.permitNo) || 'A permit'} at ${where(p.siteId, p.site)}: awaiting approval`)
    }
    add('Permits awaiting approval', permits)

    const docs = []
    for (const d of data.documents || []) {
      if (d.deletedAt) continue
      const scoped = d.siteId ? at(d.siteId) : user.role === 'admin'
      if (!scoped) continue
      const st = dueState(d.reviewDate, today, 14)
      if (st) docs.push(`${str(d.title || d.name) || 'A document'}: review ${label(st, d.reviewDate)}`)
    }
    add('Document reviews', docs)
  }

  if (!sections.length) return null
  const count = sections.reduce((n, s) => n + s.length - 1, 0)
  const lines = [`Good morning${user.name ? `, ${str(user.name).split(' ')[0]}` : ''}. Here is what needs your attention.`, '']
  for (const s of sections) lines.push(...s, '')
  return message(user.email, 'digest', `Your safety summary: ${count === 1 ? '1 item needs' : `${count} items need`} attention`, lines, origin, '/portal', user.id)
}
