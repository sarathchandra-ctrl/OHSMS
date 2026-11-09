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

function restrictWrite(op, path, id, ctx, { next } = {}) {
  if (!passwordOk(ctx) && !ownUser(ctx, path, id)) return 'password'
  if (serverOnly(path)) return 'server-only'
  if (isCryptoKey(path, id)) return 'crypto-keys'
  if (op === 'insert' && isAuditor(ctx) && collectionOf(path) !== 'auditLogs') return 'auditor'
  if ((op === 'update' || op === 'delete') && isAuditor(ctx)) return 'auditor'
  if ((op === 'update' || op === 'delete') && collectionOf(path) === 'auditLogs') return 'audit-log'
  void next
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
  const restricted = restrictWrite('update', path, id, ctx, { next })
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
  const restricted = restrictWrite('delete', path, id, ctx)
  if (restricted) return restricted
  // delete_member: broad on purpose; the auditor is removed by restrictWrite.
  if (isApproved(ctx) && !specialPath(path)) return ''
  // delete_user
  if (path === 'users' && isAdmin(ctx)) return ''
  return 'denied'
}

// ── What the triggers checked ───────────────────────────────────────────────

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
 *   manager_decisions      verifying an injury, closing an illness: managers
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
  const oldStatus = str(prev?.status)
  const newStatus = str(n.status)
  if (
    collectionOf(path) === 'injuries' &&
    newStatus === 'verified' &&
    oldStatus !== 'verified' &&
    !isManager(ctx)
  ) {
    return 'manager-decision'
  }
  if (
    collectionOf(path) === 'illnesses' &&
    ['closed', 'verified'].includes(newStatus) &&
    oldStatus !== newStatus &&
    !isManager(ctx)
  ) {
    return 'manager-decision'
  }
  return ''
}
