// Who may read and write which records.
//
// This is the enforcement. The browser's /data calls reach the database only
// through stack/engine.mjs, which asks this module before every read and
// write and refuses anything it does not allow. It is a rule-for-rule port of
// the row-level security the app used to run on Postgres (each rule below
// names the policy it replaces), written as pure functions so every branch is
// tested on its own (stack/policy.test.js) as well as through the engine
// (src/shared/data/adapters/postgres.rls.test.js).
//
// Two shapes of mistake to keep out of this file — both shipped before:
//
//   Permissive union. A narrow "allow" next to a broad one restricts nothing.
//   Restrictions are written as separate checks that every operation must
//   ALSO pass (the RESTRICT_* functions), never as one more allow.
//
//   Post-state check. On an update, `next` is what the writer sent. A decision
//   about privilege reads the actor's stored profile and `prev`, never `next`.
//
// `ctx` is { uid, worker, profile }: the session's uid (empty when signed
// out), whether this is a server job (which skips the policies, as the bypass
// role did), and the caller's stored users/{uid} document, read in the same
// pass as the rows it judges.

// ── Path helpers ────────────────────────────────────────────────────────────

/** The collection a path names: its last segment ('permits/P1/events' -> events). */
export const collectionOf = (path) => String(path).split('/').pop()
/** The top-level collection ('permits/P1/events' -> permits). */
export const rootOf = (path) => String(path).split('/')[0]
export const isMedical = (path) => /^(injuries|illnesses)(\/|$)/.test(String(path))
/** Written and read only by the server. */
export const serverOnly = (path) => ['scimTokens', 'scimUsers', 'scimGroups'].includes(rootOf(path))
/** Documents with their own, narrower write rules. */
export const specialPath = (path) => ['users', 'organization', 'moduleEntitlements'].includes(path)
const isCryptoKey = (path, id) =>
  collectionOf(path) === 'cryptoKeys' || (collectionOf(path) === 'meta' && id === 'cryptoKeys')
const PUBLIC_MIRRORS = ['qr', 'permitQr', 'procedureQr']

// ── The caller ──────────────────────────────────────────────────────────────

const mustChange = (p) => p?.mustChangePassword === true
export const isApproved = (ctx) =>
  Boolean(ctx.profile) && ctx.profile.status === 'approved' && !mustChange(ctx.profile)
export const isWriter = (ctx) => isApproved(ctx) && (ctx.profile.role || '') !== 'auditor'
export const isManager = (ctx) => isApproved(ctx) && ['admin', 'manager'].includes(ctx.profile.role)
export const isAdmin = (ctx) => isApproved(ctx) && ctx.profile.role === 'admin'
const isAuditor = (ctx) => (ctx.profile?.role || '') === 'auditor'
/** password_ok(): no profile yet, or no temporary password still to replace. */
const passwordOk = (ctx) => !ctx.profile || !mustChange(ctx.profile)
const ownUser = (ctx, path, id) => path === 'users' && Boolean(ctx.uid) && id === ctx.uid

// ── Reading ─────────────────────────────────────────────────────────────────

/**
 * Which rows of `path` this caller may read:
 *   'all'                every row
 *   { onlyId }           just that one (a person's own profile)
 *   'none'               nothing
 * Every read rule depends on the path, not on the row's contents, which is
 * what lets a list be filtered in SQL rather than after a LIMIT.
 * (read_own_user, read_app, read_public; gate_password, gate_server_only,
 * gate_medical_read, gate_crypto_keys.)
 */
export function readScope(path, ctx) {
  if (ctx.worker) return 'all'
  if (serverOnly(path)) return 'none'
  if (isMedical(path) && !isManager(ctx)) return 'none'
  // gate_password: a temporary password reaches nothing but the person's own profile.
  if (!passwordOk(ctx)) return path === 'users' && ctx.uid ? { onlyId: ctx.uid } : 'none'
  if (isApproved(ctx) || PUBLIC_MIRRORS.includes(path)) {
    return collectionOf(path) === 'cryptoKeys'
      ? 'none'
      : collectionOf(path) === 'meta'
        ? 'all-but-crypto'
        : 'all'
  }
  if (path === 'users' && ctx.uid) return { onlyId: ctx.uid }
  return 'none'
}

export function canRead(path, id, ctx) {
  const scope = readScope(path, ctx)
  if (scope === 'all') return true
  if (scope === 'all-but-crypto') return !isCryptoKey(path, id)
  if (scope === 'none') return false
  return id === scope.onlyId
}

// ── Restrictions every write must also pass (the RESTRICTIVE policies) ──────

// The site register is the organization's map: every scope, picker and
// grant resolves through it. Creating, editing and deleting sites is the
// Sites page's job (site.manage), and that is a manager's.
const MANAGER_ONLY_COLLECTIONS = ['sites']

// An employee creates, views and closes; deleting is a manager's. Two
// deletes are part of an employee's own flow rather than removing a record:
// defect locks are released when a defect is closed, and a person may
// withdraw their own training request (ownsRow).
const MEMBER_DELETABLE = ['defectLocks']
const MEMBER_WITHDRAWABLE = ['trainingRequests']

// Fields that name the person a row belongs to. Compared against the session
// uid, so a field holding a display name can never match.
const OWNER_FIELDS = ['createdBy', 'createdByUid', 'employeeUid']
const ownsRow = (prev, ctx) =>
  Boolean(ctx.uid) && OWNER_FIELDS.some((f) => typeof prev?.[f] === 'string' && prev[f] === ctx.uid)

// ── What an employee may edit ───────────────────────────────────────────────
// An employee creates, views and closes. Editing is limited to (owner's
// decision, 2026-11-10):
//   • rows they created (ownsRow) or that are theirs by id (alertReads/{uid});
//   • the equipment registers, where a routine check IS an edit to a unit
//     somebody else registered;
//   • reference counters (meta), which only ever move forward;
//   • a close: a status moving into a closed state, with only closing detail
//     beside it — so "close" cannot carry a rewrite of the record with it;
//   • the status of actions held in a record's list (an incident's CAPA, a
//     meeting's actions) — what the Action Tracker writes when an assignee
//     moves their action along. The text, owner and due date stay as they are.
// Without this, any employee could rewrite or blank out anyone's record with
// one `set` — a delete in all but name.
const FIELD_COLLECTIONS = [
  'extinguishers',
  'aeds',
  'fas',
  'firstAid',
  'stretchers',
  'signages',
  'cctvCameras',
  'cctvDvrs',
  'cctvMeraki',
  'qr',
  'defectLocks',
  'meta',
  // Carrying out isolation and permit work: technicians apply and remove
  // locks on permits others raised. Approving stays gated (DECISION_STATES).
  'lotoPermits',
  'locks',
  'lotoEvents',
  'lotoGroupNumbers',
  'permits',
  'permitQr',
]
const CLOSE_STATES = ['closed', 'Closed', 'resolved', 'completed', 'done']
const STATUS_FIELD = /^(status|lifecycle|approvalStatus)$/
const CLOSE_DETAIL = /^(clos|review|resol|complet|stagesDone$|updated|remarks$)/i
const ACTION_ITEM_FIELD = /^(status|clos|resol|complet|updated|remarks$)/i

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v)
/** Top-level keys whose value differs between two documents. */
function changedKeys(a, b) {
  const x = isObject(a) ? a : {}
  const y = isObject(b) ? b : {}
  return [...new Set([...Object.keys(x), ...Object.keys(y)])].filter(
    (k) => JSON.stringify(x[k] ?? null) !== JSON.stringify(y[k] ?? null)
  )
}

/** A status moves into a closed state, and nothing changes but closing detail. */
export function isClosing(prev, next) {
  const keys = changedKeys(prev, next)
  const closes = keys.some(
    (k) =>
      STATUS_FIELD.test(k) && CLOSE_STATES.includes(str(next?.[k])) && !CLOSE_STATES.includes(str(prev?.[k]))
  )
  return closes && keys.every((k) => STATUS_FIELD.test(k) || CLOSE_DETAIL.test(k))
}

/** Only the status (and closing detail) of items in a list changes; none added or removed. */
export function isActionStatusChange(prev, next) {
  const keys = changedKeys(prev, next)
  return (
    keys.length > 0 &&
    keys.every((k) => {
      const a = prev?.[k]
      const b = next?.[k]
      return (
        Array.isArray(a) &&
        Array.isArray(b) &&
        a.length === b.length &&
        a.every((item, i) => changedKeys(item, b[i]).every((f) => ACTION_ITEM_FIELD.test(f)))
      )
    })
  )
}

export function employeeMayEdit(path, id, prev, next, ctx) {
  return (
    FIELD_COLLECTIONS.includes(rootOf(path)) ||
    ownsRow(prev, ctx) ||
    (Boolean(ctx.uid) && id === ctx.uid) ||
    isClosing(prev, next) ||
    isActionStatusChange(prev, next)
  )
}

function restrictWrite(op, path, id, ctx, { next, prev } = {}) {
  if (!passwordOk(ctx) && !ownUser(ctx, path, id)) return 'password'
  if (serverOnly(path)) return 'server-only'
  if (isCryptoKey(path, id)) return 'crypto-keys'
  if (op === 'insert' && isAuditor(ctx) && collectionOf(path) !== 'auditLogs') return 'auditor'
  if ((op === 'update' || op === 'delete') && isAuditor(ctx)) return 'auditor'
  if ((op === 'update' || op === 'delete') && collectionOf(path) === 'auditLogs') return 'audit-log'
  if (MANAGER_ONLY_COLLECTIONS.includes(path) && !isManager(ctx)) return 'manager-only'
  if (
    op === 'update' &&
    isWriter(ctx) &&
    !isManager(ctx) &&
    !specialPath(path) &&
    !employeeMayEdit(path, id, prev, next, ctx)
  ) {
    return 'employee-edit'
  }
  // Deleting is irreversible and the records are the evidence. Every delete
  // used to be open to any employee, for any record in any module — someone
  // else's incident, an approved permit, a site, the reference counters.
  if (
    op === 'delete' &&
    !isManager(ctx) &&
    !MEMBER_DELETABLE.includes(path) &&
    !(MEMBER_WITHDRAWABLE.includes(path) && ownsRow(prev, ctx))
  ) {
    return 'manager-delete'
  }
  return ''
}

// ── Inserting ───────────────────────────────────────────────────────────────

const str = (v) => (v === undefined || v === null ? '' : String(v))
const text = (v) => (typeof v === 'boolean' ? String(v) : str(v))

/**
 * May this caller create path/id with `data`? `lookup(path, id)` returns a
 * stored document (for the QR-token checks), read in the same pass.
 */
export function insertAllowed(path, id, data, ctx, lookup) {
  if (ctx.worker) return ''
  const restricted = restrictWrite('insert', path, id, ctx)
  if (restricted) return restricted
  const d = data || {}
  const signedOut = !ctx.uid

  // insert_writer
  if (isWriter(ctx) && !specialPath(path)) return ''
  // insert_entitlement
  if (path === 'moduleEntitlements' && id === 'organization' && isAdmin(ctx)) return ''
  // insert_member: an admin adds a non-admin who must change the password.
  if (
    path === 'users' &&
    isAdmin(ctx) &&
    text(d.role) !== 'admin' &&
    d.mustChangePassword === true
  ) {
    return ''
  }
  // insert_audit: anyone approved, auditors included, in their own name.
  if (
    collectionOf(path) === 'auditLogs' &&
    isApproved(ctx) &&
    str(d.actorUid) === ctx.uid &&
    ctx.uid
  ) {
    return ''
  }
  // insert_anon_report: signed out, token-bound to one asset.
  if (
    signedOut &&
    path === 'reports' &&
    d.source === 'qr' &&
    d.approvalStatus === 'pending' &&
    d.reportedBy === 'public'
  ) {
    const q = lookup('qr', str(d.token))
    if (q && !str(q.deletedAt)) {
      if (d.kind === 'defect' && str(d.extId) && str(q.extId) === str(d.extId)) return ''
      if (
        d.kind === 'asset_defect' &&
        str(d.assetRefId) &&
        str(q.assetKind) === str(d.assetKind) &&
        str(q.assetRefId) === str(d.assetRefId)
      ) {
        return ''
      }
    }
  }
  // insert_anon_lock: one lock per extinguisher and defect type.
  if (
    signedOut &&
    path === 'defectLocks' &&
    str(d.extId) &&
    str(d.defectType) &&
    id === `${d.extId}__${d.defectType}`
  ) {
    const q = lookup('qr', str(d.token))
    if (q && !str(q.deletedAt) && str(q.extId) === str(d.extId)) return ''
  }
  // insert_anon_observation: from the QR on a work permit.
  if (
    signedOut &&
    path === 'observations' &&
    d.source === 'qr' &&
    d.approvalStatus === 'pending' &&
    d.observedBy === 'public' &&
    ['safe', 'unsafe'].includes(d.type)
  ) {
    const q = lookup('permitQr', str(d.token))
    if (q && str(q.permitId) === str(d.permitId)) return ''
  }
  return 'denied'
}

// ── Updating ────────────────────────────────────────────────────────────────

/** May this caller change path/id from `prev` to `next`? (USING on prev, WITH CHECK on next.) */
export function updateAllowed(path, id, prev, next, ctx) {
  if (ctx.worker) return ''
  if (!canRead(path, id, ctx)) return 'not-visible'
  const restricted = restrictWrite('update', path, id, ctx, { next, prev })
  if (restricted) return restricted
  // update_writer
  if (isWriter(ctx) && !specialPath(path)) return ''
  // update_organization, update_entitlement
  if (path === 'organization' && id === 'profile' && isAdmin(ctx)) return ''
  if (path === 'moduleEntitlements' && id === 'organization' && isAdmin(ctx)) return ''
  // update_member, update_self
  if (path === 'users' && (isAdmin(ctx) || ownUser(ctx, path, id))) return ''
  return 'denied'
}

// ── Deleting ────────────────────────────────────────────────────────────────

export function deleteAllowed(path, id, prev, ctx) {
  if (ctx.worker) return ''
  if (!canRead(path, id, ctx)) return 'not-visible'
  const restricted = restrictWrite('delete', path, id, ctx, { prev })
  if (restricted) return restricted
  // delete_member: broad on purpose; the auditor is removed by restrictWrite.
  if (isApproved(ctx) && !specialPath(path)) return ''
  // delete_user
  if (path === 'users' && isAdmin(ctx)) return ''
  return 'denied'
}

// ── What the triggers checked ───────────────────────────────────────────────

// Manager-only decisions (SECURITY.md S-02), ported from the decision map the
// Firestore rules carried and that the move to SQL dropped. A state in this
// list records a decision: moving a row INTO it, or OUT of it, is a manager's
// act. Asking is not deciding, so pending / draft / submitted are absent and
// an employee can still raise and submit. Both directions, because clearing
// an approval is as much the approver's act as granting it.
//
// Closing is NOT here. An employee creates, views and closes (owner's
// decision, 2026-11-10); the Firestore map also gated `closed`, and that is
// deliberately dropped. Verifying a closure stays a manager's.
const DECIDED = ['approved', 'rejected', 'declined']
const VERIFIED = ['verified']
export const DECISION_STATES = {
  permits: DECIDED,
  procedures: DECIDED,
  reports: DECIDED,
  observations: DECIDED,
  trainingRequests: DECIDED,
  erpRescuePlans: DECIDED,
  incidents: VERIFIED,
  illnesses: VERIFIED,
  capas: VERIFIED,
  findings: VERIFIED,
  audits: VERIFIED,
  injuries: VERIFIED,
  documents: ['active'],
}
// Where a decision is written. incidents and illnesses call it `lifecycle`;
// a permit also carries one per approver, and again for closure and extension.
const DECISION_FIELDS = [['status'], ['approvalStatus'], ['lifecycle']]
const PERMIT_DECISION_FIELDS = ['engineering', 'operations'].flatMap((who) => [
  [who, 'status'],
  ['closure', who, 'status'],
  ['extension', who, 'status'],
])
const at = (obj, keys) => keys.reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj)

/** The first decision field this write moves into or out of a decided state, or ''. */
export function decisionChanged(path, prev, next) {
  const states = DECISION_STATES[collectionOf(path)]
  if (!states) return ''
  const fields =
    collectionOf(path) === 'permits' ? [...DECISION_FIELDS, ...PERMIT_DECISION_FIELDS] : DECISION_FIELDS
  for (const keys of fields) {
    const before = str(at(prev, keys))
    const after = str(at(next, keys))
    if (before !== after && (states.includes(before) || states.includes(after))) return keys.join('.')
  }
  return ''
}

const num = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/**
 * The checks that held whatever the policy said (the Postgres triggers):
 *   users_keep_privilege   role, status, site, access, department change only
 *                          by an approved admin, judged on the STORED actor;
 *                          nobody but the server clears mustChangePassword
 *   meta_counters_forward  reference counters never move backwards
 *   manager_decisions      a decision (DECISION_STATES): managers only
 * `prev` is undefined for an insert.
 */
export function invariantProblem(path, id, prev, next, ctx) {
  const n = next || {}
  if (prev && path === 'users' && !ctx.worker) {
    if (prev.mustChangePassword === true && n.mustChangePassword !== true) return 'password-flag'
    const changed = (k) => JSON.stringify(prev[k] ?? null) !== JSON.stringify(n[k] ?? null)
    const changedText = (k) => str(prev[k]) !== str(n[k])
    const privileged =
      changed('role') ||
      changed('status') ||
      changedText('siteId') ||
      changed('access') ||
      changedText('department') ||
      changedText('dept')
    if (privileged && !isAdmin(ctx)) return 'privilege'
  }
  if (prev && collectionOf(path) === 'meta' && id !== 'cryptoKeys') {
    for (const k of ['nextSeq', 'permitSeq', 'n']) {
      if (num(prev[k]) > num(n[k])) return 'counter'
    }
  }
  if (!ctx.worker && !isManager(ctx) && decisionChanged(path, prev, n)) return 'manager-decision'
  return ''
}
