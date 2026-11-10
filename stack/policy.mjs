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
// integrations holds third-party credentials (the Metabase API key): read
// and written by server jobs only, which strip the key before answering.
export const serverOnly = (path) =>
  ['scimTokens', 'scimUsers', 'scimGroups', 'weatherCache', 'integrations'].includes(rootOf(path))
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

// ── Module permission ───────────────────────────────────────────────────────
// Which module each collection belongs to (keys of src/shared/modules/
// registry.js), recovered from the map the Firestore rules carried. An
// employee whose profile lists `access.modules` reaches only those modules'
// collections, for reading and for writing; the app hides the rest
// (grantedModuleKeys in src/shared/auth/access.js), and this is what stops
// the same request sent from the console.
//
// Not listed, so open to every approved member: shared collections (sites,
// users, auditLogs, meta, the QR mirrors) and trainingAssignments, which is
// every employee's own "My training" on the portal whatever modules they have.
export const MODULE_OF_COLLECTION = {
  incidents: 'incidents',
  illnesses: 'incidents',
  injuries: 'incidents',
  assessments: 'hira',
  inspectionTemplates: 'inspections',
  inspectionRecords: 'inspections',
  audits: 'audit',
  auditPlans: 'audit',
  auditFindings: 'audit',
  capas: 'audit',
  findings: 'audit',
  permits: 'ptw',
  observations: 'ptw',
  procedures: 'loto',
  procedurePhotos: 'loto',
  locks: 'loto',
  technicians: 'loto',
  lotoPermits: 'loto',
  lotoEvents: 'loto',
  lotoGroupNumbers: 'loto',
  extinguishers: 'equipment',
  aeds: 'equipment',
  fas: 'equipment',
  signages: 'equipment',
  stretchers: 'equipment',
  firstAid: 'equipment',
  reports: 'equipment',
  defectClosures: 'equipment',
  mockDrills: 'drills',
  consultations: 'committee',
  trainingCourses: 'training',
  trainingRecords: 'training',
  trainingSessions: 'training',
  trainingRequests: 'training',
  documents: 'documents',
  erpContacts: 'emergency',
  erpLayouts: 'emergency',
  erpRescuePlans: 'emergency',
  objectives: 'objectives',
  cctvCameras: 'cctv',
  cctvDvrs: 'cctv',
  cctvMeraki: 'cctv',
  escalations: 'stakeholder',
  legalIssues: 'stakeholder',
}
// Admins, managers and auditors see every module. Anyone else — the Employee
// role, or a role this file does not know — is held to their list. A missing
// list means every module, so profiles saved before the field existed keep
// working; an empty list means none.
const ALL_MODULE_ROLES = ['admin', 'manager', 'auditor']

// Kept out of a module, an employee still sees what they created there, and
// may still REPORT: every worker can raise an incident from the portal
// whatever modules they hold, and the QR on a unit or a permit takes a
// report from anyone, signed in or not. Reading back what they sent is how
// the portal shows the reporter their reference number.
const REPORTABLE = ['incidents', 'injuries']
const publicReport = (path, d) =>
  ['reports', 'observations'].includes(path) &&
  d?.source === 'qr' &&
  d?.approvalStatus === 'pending'

/** Is this caller kept out of the module `path` belongs to? */
export function moduleBlocked(path, ctx) {
  if (ctx.worker) return false
  const key = MODULE_OF_COLLECTION[rootOf(path)]
  if (!key || !ctx.profile) return false
  if (ALL_MODULE_ROLES.includes(ctx.profile.role)) return false
  const granted = ctx.profile.access?.modules
  return Array.isArray(granted) && !granted.includes(key)
}

// ── Site scope ──────────────────────────────────────────────────────────────
// A person reaches the sites of their posting (profile.siteId) and of their
// grants (access.sites, and every site in access.regions / access.entities),
// the same reach as resolveAccessibleSites in src/shared/auth/access.js.
// Admins reach every site. `ctx.reach` is that set of site ids, computed by
// the engine from the site register; null means unrestricted.
//
// A record that names a site (siteId) is visible to, and writable by, only
// people who reach that site. A record that names none stays visible to
// whoever can see its module, as before: older records that identify their
// site only by name are given a siteId by the Maintenance job, and are
// restricted from then on. Hiding them before that would have taken records
// away from their own site's people.
//
// Not site records, so never filtered: the people directory (a user's siteId
// is their posting, and pickers need colleagues at other sites), the site
// register itself, the audit trail, counters, settings and the public QR
// mirrors (read by token). A document filed at a site but marked visible to
// everyone (visibility 'all') is visible to everyone.
const SITE_EXEMPT = [
  'users', 'sites', 'organization', 'auditLogs', 'meta', 'docSeq', 'qr', 'permitQr',
  'procedureQr', 'lotoSettings', 'moduleEntitlements', 'alertReads', 'weatherCache',
  'integrations',
]

/** The site ids this profile reaches, or null for every site. */
export function reachOf(profile, sites = []) {
  if (!profile || profile.role === 'admin') return null
  const a = profile.access || {}
  const list = (v) => (Array.isArray(v) ? v : [])
  const ids = new Set(list(a.sites).map(String))
  if (profile.siteId) ids.add(String(profile.siteId))
  const regions = new Set(list(a.regions))
  const entities = new Set(list(a.entities))
  for (const site of sites) {
    if ((site.region && regions.has(site.region)) || (site.entity && entities.has(site.entity))) {
      ids.add(String(site.id))
    }
  }
  return ids
}

export const siteScoped = (path) => !SITE_EXEMPT.includes(rootOf(path))

/** Does this record name a site the caller does not reach? */
export function siteBlocked(path, row, ctx) {
  if (ctx.worker || !ctx.reach || !siteScoped(path)) return false
  if (rootOf(path) === 'documents' && row?.visibility === 'all') return false
  const site = str(row?.siteId)
  return Boolean(site) && !ctx.reach.has(site)
}

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
  if (moduleBlocked(path, ctx)) return ctx.uid ? { ownedBy: ctx.uid } : 'none'
  // gate_password: a temporary password reaches nothing but the person's own profile.
  if (!passwordOk(ctx)) return path === 'users' && ctx.uid ? { onlyId: ctx.uid } : 'none'
  // The public QR mirrors are read one at a time, by the token printed on the
  // sticker, and never listed — by anyone. The token is the capability: it is
  // what lets an anonymous defect report or permit observation through, so a
  // list would hand every token to whoever asked, signed in or not.
  if (PUBLIC_MIRRORS.includes(path)) return 'get-only'
  if (isApproved(ctx)) {
    return collectionOf(path) === 'cryptoKeys'
      ? 'none'
      : collectionOf(path) === 'meta'
        ? 'all-but-crypto'
        : 'all'
  }
  if (path === 'users' && ctx.uid) return { onlyId: ctx.uid }
  return 'none'
}

/** `row` is the stored document; with it, the site scope applies too. */
export function canRead(path, id, ctx, row) {
  if (row && siteBlocked(path, row, ctx)) return false
  const scope = readScope(path, ctx)
  if (scope === 'all') return true
  if (scope === 'all-but-crypto') return !isCryptoKey(path, id)
  if (scope === 'get-only') return true
  if (scope === 'none') return false
  if (scope.ownedBy) return ownedBy(row, scope.ownedBy)
  return id === scope.onlyId
}

/** Created by `uid`: the two creator fields the engine's SQL filter also reads. */
export const ownedBy = (row, uid) =>
  Boolean(uid) && (row?.createdBy === uid || row?.createdByUid === uid)

// ── Restrictions every write must also pass (the RESTRICTIVE policies) ──────

// The site register is the organization's map: every scope, picker and
// grant resolves through it. Creating, editing and deleting sites is the
// Sites page's job (site.manage), and that is a manager's.
const MANAGER_ONLY_COLLECTIONS = ['sites', 'lotoSettings']

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
  // Counters every new record draws its number from (src/shared/docId,
  // the LOTO permit sequence). Forward-only: see invariantProblem.
  'meta',
  'docSeq',
  // Carrying out isolation and permit work: technicians apply and remove
  // locks on permits others raised. Approving stays gated (DECISION_STATES).
  'lotoPermits',
  'locks',
  'lotoEvents',
  'lotoGroupNumbers',
  // Applying a lock writes the procedure's lock state, its public mirror and
  // the claim on the padlock number. Approving a procedure stays gated.
  'procedures',
  'procedurePhotos',
  'procedureQr',
  'lockClaims',
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

const STAMP_FIELD = /^updated/i

/**
 * Only the status (and closing detail) of items in a list changes; none added
 * or removed. An `updatedAt`-style stamp may change beside it — completing an
 * assigned inspection writes one.
 */
export function isActionStatusChange(prev, next) {
  const keys = changedKeys(prev, next)
  const lists = keys.filter((k) => !STAMP_FIELD.test(k))
  return (
    lists.length > 0 &&
    lists.every((k) => {
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
  // Writing a record into a site the writer does not reach (a new record, or
  // moving one there). Reaching the record's current site is canRead's.
  if ((op === 'insert' || op === 'update') && siteBlocked(path, next, ctx)) return 'site'
  if (
    moduleBlocked(path, ctx) &&
    !(op === 'insert' && (REPORTABLE.includes(rootOf(path)) || publicReport(path, next)))
  ) {
    return 'module'
  }
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

// ── The anonymous QR surface (S-14) ─────────────────────────────────────────
// A scanned token lets a stranger write one report, one observation or one
// defect lock. Each may carry only its own fields, every string bounded, so
// one sticker is not a megabyte-per-write channel into the approval queue.
// `max` is the longest each string may be; a field absent or null passes.
const ANON_SHAPES = {
  reports: {
    extId: 200, extLabel: 200, kind: 40, defectType: 200, newStatus: 60, note: 500,
    reportedBy: 40, reportedByName: 120, reporterRole: 60, source: 20, approvalStatus: 20,
    reportedAt: 0, createdAt: 0, token: 200, assetKind: 40, assetRefId: 200, assetLabel: 200,
    defect: 200,
  },
  observations: {
    permitId: 200, permitNo: 120, docId: 120, token: 200, type: 20, note: 500, observedBy: 40,
    observedByName: 120, observedByRole: 60, source: 20, approvalStatus: 20, at: 0,
  },
  defectLocks: { extId: 200, defectType: 200, createdAt: 0, token: 200 },
}

/** The first field an anonymous write may not carry, or may not carry that long, or ''. */
export function anonShapeProblem(path, d) {
  const shape = ANON_SHAPES[path]
  if (!shape) return ''
  for (const [k, v] of Object.entries(d || {})) {
    if (!(k in shape)) return k
    // 0: a timestamp, not text. Anything else is a string up to its cap.
    if (shape[k] === 0 || v === null || v === undefined) continue
    if (typeof v !== 'string' || v.length > shape[k]) return k
  }
  return ''
}

/**
 * May this caller create path/id with `data`? `lookup(path, id)` returns a
 * stored document (for the QR-token checks), read in the same pass.
 */
export function insertAllowed(path, id, data, ctx, lookup) {
  if (ctx.worker) return ''
  const restricted = restrictWrite('insert', path, id, ctx, { next: data })
  if (restricted) return restricted
  if (path === 'lotoPermits') {
    const window = lotoWindowProblem(data, lookup)
    if (window) return window
  }
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
  // The anonymous branches below each check their own token binding; the
  // shape and the lengths are the same check for all three.
  if (signedOut && anonShapeProblem(path, d)) return 'anon-shape'
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
  if (!canRead(path, id, ctx, prev)) return 'not-visible'
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
  if (!canRead(path, id, ctx, prev)) return 'not-visible'
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

// ── LOTO permits ────────────────────────────────────────────────────────────
// An isolation permit is the paper between a person and live energy. The
// Firestore rules held it to its lifecycle and to who may move it; this is
// the same table (PERMIT_TRANSITIONS in src/modules/loto/constants/permits.js
// drives the buttons, and must agree with it):
//
//   requested -> approved | rejected   an Admin (the LOTO module's approvers);
//                                      the requester only by recording that
//                                      nobody else could (selfApproved + a
//                                      reason), and never someone named on it
//   requested | approved -> withdrawn  the requester or an Admin
//   approved -> active                 someone the permit is about, or Admin
//   active -> returned                 someone the permit is about, or Admin
//   active -> emergency_removed        an Admin
//
// A closed permit (returned, rejected, withdrawn, emergency_removed) does not
// reopen. Extending an active permit (a later windowEnd) is an Admin's, by at
// most 24 hours at a time. A new permit starts as requested.
export const LOTO_TRANSITIONS = {
  requested: ['approved', 'rejected', 'withdrawn'],
  approved: ['active', 'withdrawn'],
  active: ['returned', 'emergency_removed'],
  returned: [],
  rejected: [],
  withdrawn: [],
  emergency_removed: [],
}
const LOTO_CLOSED = ['returned', 'rejected', 'withdrawn', 'emergency_removed']
// A stored timestamp is { __ohsms: 'ts', s, ns } (src/shared/data/adapters/
// postgresWire.js); a Firestore-shaped one carries `seconds`.
const millis = (v) => {
  if (v && typeof v === 'object' && v.__ohsms === 'ts') return v.s * 1000 + Math.floor((v.ns || 0) / 1e6)
  if (v && typeof v === 'object' && typeof v.seconds === 'number') return v.seconds * 1000
  const n = typeof v === 'number' ? v : Date.parse(v)
  return Number.isFinite(n) ? n : NaN
}

/** Why this lotoPermits write is refused, or ''. `prev` is undefined on create. */
export function lotoPermitProblem(prev, next, ctx) {
  const n = next || {}
  const uid = ctx.uid
  if (!prev) return str(n.status) === 'requested' ? '' : 'loto-new-not-requested'
  const from = str(prev.status)
  const to = str(n.status)
  const party =
    (Boolean(uid) && prev.requestedBy === uid) ||
    (Array.isArray(prev.personnelUids) && prev.personnelUids.includes(uid))
  if (from !== to) {
    if (!(LOTO_TRANSITIONS[from] || []).includes(to)) return 'loto-transition'
    if (to === 'approved' || to === 'rejected') {
      if (!isAdmin(ctx)) return 'loto-approver'
      if (str(n.approval?.by) !== uid) return 'loto-approver'
      const self = prev.requestedBy === uid
      const named = Array.isArray(prev.personnelUids) && prev.personnelUids.includes(uid)
      const sole = self && n.approval?.selfApproved === true && str(n.approval?.selfApprovalReason).trim()
      if (self ? !sole : named) return 'loto-self-approval'
    }
    if (to === 'emergency_removed' && !isAdmin(ctx)) return 'loto-emergency'
    if (to === 'withdrawn' && !(prev.requestedBy === uid || isAdmin(ctx))) return 'loto-withdraw'
    if ((to === 'active' || to === 'returned') && !(party || isAdmin(ctx))) return 'loto-party'
    return ''
  }
  if (LOTO_CLOSED.includes(from) && !isAdmin(ctx)) return 'loto-closed'
  if (JSON.stringify(prev.windowEnd ?? null) !== JSON.stringify(n.windowEnd ?? null)) {
    if (!isAdmin(ctx) || from !== 'active') return 'loto-extend'
    const before = millis(prev.windowEnd)
    const after = millis(n.windowEnd)
    if (!(after > before) || after - before > 24 * 60 * 60 * 1000) return 'loto-extend'
  }
  return ''
}

// The permit window is a shift, not two times somebody typed
// (src/modules/loto/utils/shiftWindow.js decides it for the form). A request
// opens REQUEST_LEAD minutes before the shift and closes when it ends. Once an
// Admin saves a site's shift clocks (lotoSettings/shifts), the window must
// start and end on those clocks in the site's zone; until then the default
// shifts' lengths apply: general 9 hours, A, B and C 8 hours.
const REQUEST_LEAD_MS = 30 * 60 * 1000
const DEFAULT_SHIFT_MS = { general: 9 * 3600e3, A: 8 * 3600e3, B: 8 * 3600e3, C: 8 * 3600e3 }
const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/

function onClock(ms, offsetMin, clock) {
  const m = CLOCK.exec(String(clock || ''))
  if (!m) return false
  const local = new Date(ms + offsetMin * 60000)
  return local.getUTCHours() === Number(m[1]) && local.getUTCMinutes() === Number(m[2])
}

/** Why a new permit's window is not an open shift, or ''. */
export function lotoWindowProblem(d, lookup = () => null, nowMs = Date.now()) {
  const start = millis(d?.windowStart)
  const end = millis(d?.windowEnd)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 'loto-window'
  if (start > nowMs + REQUEST_LEAD_MS || end <= nowMs) return 'loto-window-closed'
  const site = lookup('lotoSettings', 'shifts')?.sites?.[str(d.siteId)]
  if (site) {
    const shift = site.shifts?.[str(d.shift)]
    const offset = Number.isInteger(site.zoneOffsetMinutes) ? site.zoneOffsetMinutes : 0
    if (!shift || !onClock(start, offset, shift.start) || !onClock(end, offset, shift.end)) {
      return 'loto-window-shift'
    }
    return ''
  }
  const length = DEFAULT_SHIFT_MS[str(d.shift)]
  return length && end - start === length ? '' : 'loto-window-shift'
}

// Bounds, as LIMITS in src/modules/loto/constants/permits.js: no text over
// 2000 characters and no list over 100 entries anywhere on a permit, so a
// hostile client cannot make one unreadable or unprintable.
const LOTO_TEXT_MAX = 2000
const LOTO_LIST_MAX = 100
function oversized(v, depth = 0) {
  if (depth > 6) return true
  if (typeof v === 'string') return v.length > LOTO_TEXT_MAX
  if (Array.isArray(v)) return v.length > LOTO_LIST_MAX || v.some((x) => oversized(x, depth + 1))
  if (v && typeof v === 'object') return Object.values(v).some((x) => oversized(x, depth + 1))
  return false
}

// ── What a public mirror may carry ──────────────────────────────────────────
// qr, permitQr and procedureQr are read by anyone holding a token, without an
// account. Each may carry only the fields its builder writes (fire/lib/data.js
// mirror builders, ptw/lib/publicPermit.js, loto/utils/publicProcedure.js), so
// a writer cannot publish anything else — a name, a phone number, a note — to
// strangers. On an update, keys already on the document are tolerated so an
// old mirror can still be corrected; new ones are not. (S-27: the LOTO
// procedure mirror exists precisely to show isolation state without names.)
export const MIRROR_FIELDS = {
  qr: [
    'orgId', 'orgName', 'token', 'status', 'updatedAt', 'centerName', 'region', 'entity',
    'location', 'extId', 'serialNo', 'type', 'capacity', 'physicalDefects', 'deletedAt',
    'dateOfDeployment', 'dateOfNextRefill', 'dateOfNextHPT', 'assetKind', 'assetRefId', 'label',
    'brand', 'model', 'batteryExpiry', 'padExpiry', 'lastInspection', 'nextInspection',
    'deviceType', 'zone', 'lastService', 'nextService', 'amcVendor', 'stretcherType',
  ],
  permitQr: [
    'orgId', 'orgName', 'permitId', 'token', 'permitNo', 'docId', 'site', 'typeOfWork',
    'jobLocation', 'jobDescription', 'issuingDepartment', 'issuedToName', 'hazards', 'ppe',
    'precautions', 'jsa', 'participantCount', 'fireWatcherCount', 'hasConfinedWatcher',
    'withdrawn', 'storedStatus', 'engineering', 'operations', 'closure', 'extension',
    'closedDueToObservation', 'validFrom', 'validTo', 'updatedAt',
  ],
  procedureQr: [
    'orgId', 'procedureCode', 'title', 'equipment', 'site', 'status', 'revision', 'lockStatus',
    'lockedCount', 'pointCount', 'points', 'updatedAt',
  ],
}
const PROCEDURE_POINT_FIELDS = [
  'key', 'energySource', 'rating', 'isolationDetails', 'hazard', 'verification', 'device',
  'devices', 'locked',
]

/** The first field this mirror write may not carry, or ''. */
export function mirrorProblem(path, prev, next) {
  const allowed = MIRROR_FIELDS[path]
  if (!allowed) return ''
  const keep = new Set([...allowed, ...Object.keys(prev || {})])
  const extra = Object.keys(next || {}).find((k) => !keep.has(k))
  if (extra) return extra
  if (path === 'procedureQr') {
    const points = next?.points
    if (points !== undefined && (!Array.isArray(points) || points.length > 100)) return 'points'
    for (const p of points || []) {
      if (!p || typeof p !== 'object' || Array.isArray(p)) return 'points'
      const bad = Object.keys(p).find((k) => !PROCEDURE_POINT_FIELDS.includes(k))
      if (bad) return `points.${bad}`
    }
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
  if (!ctx.worker && mirrorProblem(path, prev, n)) return 'mirror-field'
  if (!ctx.worker && path === 'lotoPermits') {
    const loto = lotoPermitProblem(prev, n, ctx)
    if (loto) return loto
    if (oversized(n)) return 'loto-bounds'
  }
  if (prev && ['meta', 'docSeq'].includes(collectionOf(path)) && id !== 'cryptoKeys') {
    for (const k of ['nextSeq', 'permitSeq', 'n']) {
      if (num(prev[k]) > num(n[k])) return 'counter'
    }
  }
  if (!ctx.worker && !isManager(ctx) && decisionChanged(path, prev, n)) return 'manager-decision'
  return ''
}
