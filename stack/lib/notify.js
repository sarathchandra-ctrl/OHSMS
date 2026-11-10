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
//
// "Managers" is always the managers who look after the record's site, with
// every administrator: a manager at another site cannot open the record the
// notification links to, and telling them of it would be another site's
// business in their inbox. Organization-level records (a baseline risk
// assessment) go to every manager.
export const NOTIFY_KINDS = [
  { key: 'incident', module: 'Incidents', label: 'New incidents', hint: 'To the site’s managers, administrators, the person who reported it, and the notification email' },
  { key: 'action', module: 'Incidents', label: 'Incident actions', hint: 'Each new action: to the person it is assigned to, the site’s managers and administrators' },
  { key: 'rca', module: 'Incidents', label: 'RCA due', hint: 'Every 6 hours until the investigation (RCA) is done: to the reporter, the site’s managers and administrators' },
  { key: 'hiraBaseline', module: 'Risk Assessment', label: 'Baseline risk assessments', hint: 'Each new baseline and each change: to every manager and administrator' },
  { key: 'hiraSite', module: 'Risk Assessment', label: 'Site risk assessments', hint: 'Each new assessment and each change: to the site’s managers, administrators and its author' },
  { key: 'hiraReview', module: 'Risk Assessment', label: 'Annual review due', hint: 'Once a year from the assessment date: to managers and administrators' },
  { key: 'defect', module: 'Emergency Equipment', label: 'Defects reported', hint: 'Extinguisher, AED and FAS defects: to the site’s managers, administrators and employees' },
  { key: 'equipmentDue', module: 'Emergency Equipment', label: 'Refill, HPT and AED battery due', hint: 'Extinguisher refill or pressure test within 7 days, AED battery expiring within 30: to the site’s managers, administrators and employees' },
  { key: 'uptime', module: 'Emergency Equipment', label: 'Monthly uptime', hint: 'On the 1st: extinguisher, AED, FAS and signage uptime by entity, to managers and administrators' },
  { key: 'drill', module: 'Mock Drills', label: 'New mock drills', hint: 'To the person who logged it, the site’s managers and administrators' },
  { key: 'drillAction', module: 'Mock Drills', label: 'Mock drill actions', hint: 'Each new action: to its assignees, the site’s managers and administrators' },
  { key: 'meeting', module: 'HSE Committee', label: 'New committee meetings', hint: 'To the person who recorded it, the site’s managers and administrators' },
  { key: 'meetingAction', module: 'HSE Committee', label: 'Committee meeting actions', hint: 'Each new action: to the person responsible, the site’s managers and administrators' },
  { key: 'weather', module: 'Weather', label: 'Weather risk', hint: 'Every 6 hours, all clear or not: each site’s weather band to its managers and administrators, sites needing precautions first' },
  { key: 'permit', module: 'Permit to Work', label: 'New permits', hint: 'To the site’s managers, administrators and the people on the permit' },
  { key: 'permitStatus', module: 'Permit to Work', label: 'Permit status changes', hint: 'Approved, closure or extension asked for or decided: same people' },
  { key: 'permitRejection', module: 'Permit to Work', label: 'Rejected permits', hint: 'A rejection of the opening or closure, with its comment, to the person who raised the permit; their answer, to the person who rejected it, for re-approval' },
  { key: 'audit', module: 'Internal Audit', label: 'Audit findings', hint: 'Sent to the auditee, submitted, returned and closed' },
  { key: 'training', module: 'Training', label: 'Training assigned', hint: 'To the person it is assigned to' },
  { key: 'digest', module: 'Daily summary', label: 'Daily summary email', hint: 'Each morning at 08:00: what is due or overdue, for each person. People can opt out under Security.' },
]

/** Which kinds are on: every kind unless the organization turned it off. */
export function notifySettings(org) {
  const saved = org?.notifications && typeof org.notifications === 'object' ? org.notifications : {}
  return Object.fromEntries(NOTIFY_KINDS.map((k) => [k.key, saved[k.key] !== false]))
}

export const str = (v) => (v === undefined || v === null ? '' : String(v))
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

export const isManagerRole = (u) => u?.role === 'admin' || u?.role === 'manager'

/** Managers and admins who look after a site ('' = organization level: admins). */
export function managersOf(siteId, users = [], sites = []) {
  return users.filter(
    (u) =>
      reachable(u) &&
      isManagerRole(u) &&
      (u.role === 'admin' || (siteId && sitesOf(u, sites).has(String(siteId))))
  )
}

/** Every manager and administrator who can use the app today. */
export function allManagers(users = []) {
  return users.filter((u) => reachable(u) && isManagerRole(u))
}

/** People who work at or look after a site, whatever their role. */
export function sitePeople(siteId, users = [], sites = []) {
  if (!siteId) return []
  return users.filter(
    (u) => reachable(u) && u.role !== 'admin' && u.role !== 'auditor' && sitesOf(u, sites).has(String(siteId))
  )
}

export const siteName = (siteId, sites, fallback = '') =>
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
export function message(to, kind, subject, lines, origin, path, uid = '') {
  const link = path ? `${str(origin).replace(/\/$/, '')}${path}` : ''
  const text = [...lines, '', link ? `Open it: ${link}` : '', '', 'You are getting this from your safety management system.']
    .filter((l, i, all) => !(l === '' && all[i - 1] === ''))
    .join('\n')
    .trim()
  return { to: str(to).trim(), uid, kind, subject, summary: str(lines[0]), path: path || '', text }
}

const byId = (users) => new Map(users.map((u) => [u.id, u]))
const list = (v) => (Array.isArray(v) ? v.filter(Boolean) : [])

// Which permit fields say its state moved: the stored status, either
// approver's decision, and a closure or extension asked for or decided.
const permitState = (p) =>
  JSON.stringify([
    str(p?.storedStatus),
    str(p?.engineering?.status),
    str(p?.operations?.status),
    str(p?.closure?.requestedAt && 'closure'),
    str(p?.closure?.engineering?.status),
    str(p?.closure?.operations?.status),
    str(p?.extension?.requestedAt && 'extension'),
    str(p?.extension?.engineering?.status),
    str(p?.extension?.operations?.status),
  ])

// A rejection, and its answer (src/modules/ptw/lib/rejection.js). These two
// mails carry free text, which the rule above keeps out of mail, on purpose
// and only here: the owner asked for the rejection comment to reach the
// raiser and the answer to reach the rejector. Neither field is sealed at
// rest (src/shared/crypto/policy.js has no permits), each goes to one person
// who can already read it in the app, and the bell's summary, the first
// line, stays free of it.
const PERMIT_BLOCKS = [
  ['permit', 'engineering'],
  ['permit', 'operations'],
  ['closure', 'engineering'],
  ['closure', 'operations'],
]
const TEAM_LABEL = { engineering: 'Engineering', operations: 'Operations' }
const blockOf = (p, stage, team) => (stage === 'permit' ? p?.[team] : p?.closure?.[team])
const quoted = (v) => `"${str(v).replace(/\s+/g, ' ').trim().slice(0, 2000)}"`

/** Rejections made and rejections answered by this change. */
export function permitRejections(before, after) {
  const out = []
  for (const [stage, team] of PERMIT_BLOCKS) {
    const was = blockOf(before, stage, team)
    const now = blockOf(after, stage, team)
    if (str(now?.status) === 'rejected' && str(was?.status) !== 'rejected') {
      out.push({ kind: 'rejected', stage, team, block: now })
    } else if (str(was?.status) === 'rejected' && str(now?.status) === 'pending' && str(now?.reapprover)) {
      out.push({ kind: 'answered', stage, team, block: now })
    }
  }
  return out
}

const PERMIT_STATUS_LABEL = {
  draft: 'awaiting approval',
  approved: 'approved',
  in_progress: 'in progress',
  extended: 'extended',
  extended_in_progress: 'extended, in progress',
  not_closed: 'past its end, not closed',
  open_with_observations: 'open with observations',
  closed: 'closed',
  closed_noncompliance: 'closed for non-compliance',
}

const ASSET_COLLECTION = { aed: 'aeds', fas: 'fas', stretcher: 'stretchers' }
const ASSET_LABEL = { aed: 'AED', fas: 'Fire alarm', stretcher: 'Stretcher' }

/** The equipment record a defect report is about: [collection, id]. */
export function reportAsset(report) {
  if (report?.kind === 'defect' && report.extId) return ['extinguishers', str(report.extId)]
  if (report?.kind === 'asset_defect' && ASSET_COLLECTION[report.assetKind] && report.assetRefId) {
    return [ASSET_COLLECTION[report.assetKind], str(report.assetRefId)]
  }
  return null
}

// ── Events ───────────────────────────────────────────────────────────────────

/**
 * The notifications a set of committed changes calls for.
 * `changes` [{ path, id, before, after }] (engine.commit); `ctx` { users,
 * sites, org, origin, actorUid, assets }. Users carry their id as `id`;
 * `assets` maps 'collection/id' to the equipment a defect report names.
 *
 * The person who made the change is not told of it, except where the rule
 * names them (the reporter of an incident, the author of an assessment, the
 * person who logged a drill or recorded a meeting): there it is the receipt.
 */
export function eventMessages(
  changes = [],
  { users = [], sites = [], org = {}, origin = '', actorUid = '', assets = {} } = {}
) {
  const on = notifySettings(org)
  const people = byId(users)
  const out = []
  // One message per person per change: a manager who is also the assignee
  // hears once.
  const tell = (recipients, kind, subject, lines, path, { receipt = [], throttle = '' } = {}) => {
    const seen = new Set()
    for (const u of recipients) {
      if (!u || seen.has(u.id) || !reachable(u)) continue
      if (u.id === actorUid && !receipt.includes(u.id)) continue
      seen.add(u.id)
      const m = message(u.email, kind, subject, lines.filter(Boolean), origin, path, u.id)
      out.push(throttle ? { ...m, throttle: `${throttle}:${u.id}` } : m)
    }
  }
  const managers = (siteId) => managersOf(siteId, users, sites)
  const who = (...uids) => uids.flat().filter(Boolean).map((uid) => people.get(uid))

  for (const { path, id, before, after } of changes) {
    if (!after || after.deletedAt) continue

    if (path === 'incidents') {
      const ref = str(after.refNo) || 'An incident'
      const where = siteName(after.siteId, sites, after.site)
      const link = `/incidents/${id}`
      if (!before && on.incident) {
        const lines = [
          `${ref} was reported at ${where}.`,
          `Type: ${INCIDENT_TYPES[after.type] || 'not set'} · Severity: ${str(after.severity) || 'not set'}`,
          after.incidentDate ? `Date: ${day(after.incidentDate)}` : '',
        ]
        tell([...who(after.createdBy), ...managers(after.siteId)], 'incident', `New incident ${ref} at ${where}`, lines, link, {
          receipt: [str(after.createdBy)],
        })
        if (validEmail(org.notificationEmail)) {
          out.push(message(org.notificationEmail, 'incident', `New incident ${ref} at ${where}`, lines.filter(Boolean), origin, link))
        }
      }
      if (on.action) {
        const was = new Map(list(before?.capa).map((a) => [a.id, a]))
        for (const a of list(after.capa)) {
          if (a.status === 'closed') continue
          const prev = was.get(a.id)
          const lines = [`A corrective action on ${ref} at ${where}.`, a.dueDate ? `Due: ${day(a.dueDate)}` : '']
          if (!prev) {
            // A new action: its owner, and the site's managers.
            tell([...who(a.ownerUid), ...managers(after.siteId)], 'action', `New action on ${ref}`, lines, link)
          } else if (a.ownerUid && prev.ownerUid !== a.ownerUid) {
            tell(who(a.ownerUid), 'action', `Corrective action assigned to you · ${ref}`, lines, link)
          }
        }
      }
      continue
    }

    if (path === 'assessments') {
      const baseline = after.kind === 'baseline'
      const key = baseline ? 'hiraBaseline' : 'hiraSite'
      if (!on[key]) continue
      // An edit that changed nothing anyone reads (a re-save) is not news.
      const content = (a) => JSON.stringify([a?.name, a?.status, a?.siteId, a?.location, a?.assessmentDate, a?.members, a?.activities])
      if (before && content(before) === content(after)) continue
      const name = str(after.refId || after.name) || 'A risk assessment'
      const what = baseline ? 'Baseline risk assessment' : 'Risk assessment'
      const where = baseline ? '' : ` at ${siteName(after.siteId, sites, after.siteName)}`
      const subject = `${what} ${before ? 'updated' : 'created'}: ${name}`
      const recipients = baseline ? allManagers(users) : [...who(after.createdBy), ...managers(after.siteId)]
      tell(recipients, key, subject, [`${what} ${name}${where} was ${before ? 'changed' : 'created'}.`], `/hira/assessment/${id}`, {
        receipt: baseline ? [] : [str(after.createdBy)],
        // An assessment is edited in many saves; one notice an hour each.
        throttle: before ? `hira:${id}` : '',
      })
      continue
    }

    if (path === 'reports' && !before && on.defect) {
      const target = reportAsset(after)
      if (!target) continue
      const asset = assets[`${target[0]}/${target[1]}`]
      const siteId = asset?.siteId || ''
      const where = siteName(siteId, sites, asset?.centerName || asset?.siteName)
      const unit =
        target[0] === 'extinguishers'
          ? `Extinguisher ${str(asset?.extId || asset?.serialNo || after.extLabel)}`.trim()
          : `${ASSET_LABEL[after.assetKind] || 'Equipment'} ${str(asset?.assetId || asset?.deviceId || after.assetLabel)}`.trim()
      const defect = str(after.defectType || after.defect).replace(/_/g, ' ')
      tell(
        [...managers(siteId), ...sitePeople(siteId, users, sites)],
        'defect',
        `Defect reported: ${unit} at ${where}`,
        [`${unit} at ${where} was reported${defect ? ` with: ${defect}` : ' defective'}.`, 'It waits for review in Defects.'],
        '/equipment/defects'
      )
      continue
    }

    if (path === 'mockDrills') {
      const where = siteName(after.siteId, sites, after.centerName)
      const ref = str(after.docId) || 'A mock drill'
      const what = str(after.eventType) || 'Mock drill'
      if (!before && on.drill) {
        tell([...who(after.createdByUid), ...managers(after.siteId)], 'drill', `${what} drill logged at ${where}`, [
          `${ref}: ${what} drill at ${where}.`,
          after.date ? `Held: ${day(after.date)}` : '',
        ], '/mock-drills', { receipt: [str(after.createdByUid)] })
      }
      if (on.drillAction) {
        const prev = list(before?.capa)
        list(after.capa).forEach((a, i) => {
          if (str(a.status).toLowerCase() === 'closed') return
          const assignees = list(a.assignees).map((x) => x.uid)
          const lines = [`An action from ${ref} (${what} drill at ${where}).`, a.due ? `Due: ${day(a.due)}` : '']
          // Rows have no id; the tracker keys them by position, and a new
          // one is appended. Removing a row shifts the rest, which reads as
          // new rows only past the old length, never as a reassignment.
          if (i >= prev.length) {
            tell([...who(assignees), ...managers(after.siteId)], 'drillAction', `New mock drill action · ${ref}`, lines, '/mock-drills')
          } else {
            const had = new Set(list(prev[i]?.assignees).map((x) => x.uid))
            tell(who(assignees.filter((u) => !had.has(u))), 'drillAction', `Mock drill action assigned to you · ${ref}`, lines, '/mock-drills')
          }
        })
      }
      continue
    }

    if (path === 'consultations') {
      const where = siteName(after.siteId, sites)
      const ref = str(after.docId) || 'A committee meeting'
      const what = str(after.type) || 'Committee meeting'
      if (!before && on.meeting) {
        tell([...who(after.createdByUid), ...managers(after.siteId)], 'meeting', `${what} recorded at ${where}`, [
          `${ref}: ${what} at ${where}.`,
          after.date ? `Held: ${day(after.date)}` : '',
        ], '/committee', { receipt: [str(after.createdByUid)] })
      }
      if (on.meetingAction) {
        const prev = list(before?.actions)
        list(after.actions).forEach((a, i) => {
          if (str(a.status).toLowerCase() === 'closed') return
          const lines = [`An action from ${ref} (${what} at ${where}).`, a.due ? `Due: ${day(a.due)}` : '']
          if (i >= prev.length) {
            tell([...who(a.ownerUid), ...managers(after.siteId)], 'meetingAction', `New committee action · ${ref}`, lines, '/committee')
          } else if (a.ownerUid && prev[i]?.ownerUid !== a.ownerUid) {
            tell(who(a.ownerUid), 'meetingAction', `Committee action assigned to you · ${ref}`, lines, '/committee')
          }
        })
      }
      continue
    }

    if (path === 'permits') {
      const ref = str(after.permitNo) || 'A permit'
      const where = siteName(after.siteId, sites, after.site)
      const involved = who(after.createdBy, after.assignedEngineer, after.assignedOperator)
      const link = `/permits/${id}`
      if (!before && on.permit) {
        tell([...involved, ...managers(after.siteId)], 'permit', `Permit ${ref} awaiting approval`, [
          `${ref}${after.typeOfWork ? ` (${str(after.typeOfWork)})` : ''} at ${where} needs approval before work starts.`,
          after.validFrom ? `From: ${day(after.validFrom)}` : '',
        ], link)
      }
      const rejections = before ? permitRejections(before, after) : []
      for (const { kind, stage, team, block } of on.permitRejection ? rejections : []) {
        const what = `${stage === 'closure' ? 'closure' : 'opening'} (${TEAM_LABEL[team]})`
        if (kind === 'rejected') {
          tell(who(after.createdBy), 'permitRejection', `Permit ${ref} rejected: your answer is needed`, [
            `${ref} at ${where}: the ${what} was rejected by ${str(block.byName) || 'an approver'}.`,
            str(block.note).trim() ? `Their comment: ${quoted(block.note)}` : 'No comment was given.',
            'Open the permit, answer the rejection and send it back to them for re-approval.',
          ], link)
        } else {
          tell(who(block.reapprover), 'permitRejection', `Permit ${ref} sent back for your re-approval`, [
            `${str(block.response?.byName) || 'The raiser'} answered your rejection of the ${what} of ${ref} at ${where}.`,
            `Their answer: ${quoted(block.response?.text)}`,
            block.rejection?.note ? `Your comment was: ${quoted(block.rejection.note)}` : '',
            'It now waits for your decision alone.',
          ], link)
        }
      }
      // A rejection and its answer have their own mail above, to one person
      // each. The status mail would tell the whole list the permit is
      // "awaiting approval" again, which is the department-wide re-approval
      // the answer replaces.
      if (!rejections.length && before && on.permitStatus && permitState(before) !== permitState(after)) {
        const status = PERMIT_STATUS_LABEL[str(after.storedStatus)] || str(after.storedStatus) || 'updated'
        const asked =
          after.extension?.requestedAt && !before.extension?.requestedAt
            ? 'An extension was requested.'
            : after.closure?.requestedAt && !before.closure?.requestedAt
              ? 'Closure was requested.'
              : ''
        tell([...involved, ...managers(after.siteId)], 'permitStatus', `Permit ${ref}: ${status}`, [
          `${ref} at ${where} is now ${status}.`,
          asked,
        ], link)
      }
      continue
    }

    if (path === 'auditFindings' && on.audit) {
      const ref = str(after.docId) || 'An audit'
      const from = str(before?.status)
      const now = str(after.status)
      const [auditee] = who(after.auditeeUid)
      const [auditor] = who(after.createdByUid)
      if (!before && after.auditeeUid) {
        tell([auditee], 'audit', `Audit findings for you to answer · ${ref}`, [`${ref} has findings for you to answer in the Auditee Workplace.`], '/audit?view=auditee')
      } else if (from === 'Reported' && now === 'Submitted for Verification') {
        tell([auditor], 'audit', `Audit response submitted for verification · ${ref}`, [`The auditee answered ${ref}. It is waiting for your verification.`], '/audit?view=auditor')
      } else if (from === 'Submitted for Verification' && now === 'Reported') {
        tell([auditee], 'audit', `Audit response returned · ${ref}`, [`The auditor returned your answer to ${ref} with a note. Open it in the Auditee Workplace.`], '/audit?view=auditee')
      } else if (from === 'Submitted for Verification' && now === 'Closed') {
        tell([auditee], 'audit', `Audit verified and closed · ${ref}`, [`The auditor verified and closed ${ref}.`], '/audit?view=auditee')
      }
      continue
    }

    if (path === 'trainingAssignments' && !before && on.training && after.status === 'assigned') {
      tell(who(after.employeeUid), 'training', `Training assigned: ${str(after.courseName) || 'a course'}`, [
        `You have been assigned ${str(after.courseName) || 'a course'}.`,
        after.dueDate ? `Due: ${day(after.dueDate)}` : '',
      ], '/training/my')
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
