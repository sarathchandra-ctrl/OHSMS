// A committee action names exactly one responsible party.
//
// Older rows stored only `owner`, the person's display name, and the form
// compared that string with the signed-in member. A row with no ownerKind is
// still that person. A department is a different field so a subject-access
// scan of `actions[].owner` does not treat a department name as a person.

export const OWNER_PERSON = 'person'
export const OWNER_DEPARTMENT = 'department'

export function actionOwnerKind(row) {
  return row?.ownerKind === OWNER_DEPARTMENT ? OWNER_DEPARTMENT : OWNER_PERSON
}

export function actionOwnerText(row) {
  if (!row) return ''
  const raw = actionOwnerKind(row) === OWNER_DEPARTMENT ? row.department : row.owner
  return typeof raw === 'string' ? raw.trim() : ''
}

/** The words a list, the minutes and the tracker show. */
export function actionOwnerDisplay(row) {
  const text = actionOwnerText(row)
  if (!text) return ''
  return actionOwnerKind(row) === OWNER_DEPARTMENT ? `Department · ${text}` : text
}

/**
 * The shape written on the action. The other side is cleared, so a row cannot
 * keep a person and a department at once.
 */
export function actionOwnerRecord(row = {}) {
  const kind = actionOwnerKind(row)
  if (kind === OWNER_DEPARTMENT) {
    return {
      ownerKind: OWNER_DEPARTMENT,
      department: typeof row.department === 'string' ? row.department.trim() : '',
      owner: '',
      ownerUid: '',
    }
  }
  return {
    ownerKind: OWNER_PERSON,
    owner: typeof row.owner === 'string' ? row.owner.trim() : '',
    // Who the server notifies (the name above is sealed and cannot be read there).
    ownerUid: typeof row.ownerUid === 'string' ? row.ownerUid : '',
    department: '',
  }
}

/** Status edits stay with the named person. A department is not that person. */
export function actionAssignedTo(row, session) {
  if (actionOwnerKind(row) !== OWNER_PERSON) return false
  const name = actionOwnerText(row)
  if (!name) return false
  return [session?.name, session?.email, session?.user].filter(Boolean).includes(name)
}

/**
 * The department a profile belongs to.
 *
 * Org Settings and the user form store it on `department`. Older profiles,
 * and the org-creation write, also have `dept` (often empty). `department`
 * wins when it is set; `dept` is only the fallback when `department` is blank.
 */
export function userDepartment(profile) {
  const primary = typeof profile?.department === 'string' ? profile.department.trim() : ''
  if (primary) return primary
  return typeof profile?.dept === 'string' ? profile.dept.trim() : ''
}

/**
 * Who may set a department action to Closed. An admin or a manager already
 * can. Anyone else must belong to that department. A person-owned row is not
 * this check.
 */
export function canCloseAction(row, session, { elevated = false } = {}) {
  if (elevated) return true
  if (actionOwnerKind(row) !== OWNER_DEPARTMENT) return false
  const mine = userDepartment(session)
  const theirs = actionOwnerText(row)
  return mine !== '' && theirs !== '' && mine === theirs
}

/** Status control: department rows use canCloseAction; person rows keep the old editor/assignee rule. */
export function canUpdateActionStatus(row, session, { elevated = false, canEditMeeting = false } = {}) {
  if (actionOwnerKind(row) === OWNER_DEPARTMENT) return canCloseAction(row, session, { elevated })
  if (elevated || canEditMeeting) return true
  return actionAssignedTo(row, session)
}

/** Meetings sheet plus one row per action, so the export names who owns it. */
export function meetingExportSheets(meetings, siteName) {
  const list = Array.isArray(meetings) ? meetings : []
  const nameOf = typeof siteName === 'function' ? siteName : () => ''
  return {
    meetings: list.map((m) => ({
      ID: m.docId,
      Site: nameOf(m.siteId),
      Date: m.date,
      Type: m.type,
      Subject: m.subject,
      Attendees: (m.attendees || []).length,
      Actions: (m.actions || []).length,
    })),
    actions: list.flatMap((m) =>
      (m.actions || []).map((a) => ({
        ID: m.docId,
        Site: nameOf(m.siteId),
        Action: a.action || '',
        Responsible: actionOwnerKind(a) === OWNER_DEPARTMENT ? 'Department' : 'Person',
        Owner: actionOwnerText(a),
        Due: a.due || '',
        Status: a.status || 'Open',
      })),
    ),
  }
}
