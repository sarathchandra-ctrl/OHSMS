// ─────────────────────────────────────────────────────────────────────────────
// Permit status derivation — pure + deterministic (no React/Firestore) so it's
// unit-testable. Status is COMPUTED from the permit's approvals + time window
// everywhere it's shown; a copy is persisted as `storedStatus` only so queries
// and sorting work. This is what makes a permit auto-expire to "Not Closed"
// once its 8-hour window elapses, with no backend cron.
// ─────────────────────────────────────────────────────────────────────────────

// A permit is valid for 8 hours from its start unless an approved extension
// moves the end out.
export const PERMIT_WINDOW_MS = 8 * 60 * 60 * 1000

export const STATUS = {
  DRAFT: 'draft',
  APPROVED: 'approved',
  IN_PROGRESS: 'in_progress',
  EXTENDED: 'extended',
  EXTENDED_IN_PROGRESS: 'extended_in_progress',
  NOT_CLOSED: 'not_closed',
  OPEN_WITH_OBSERVATIONS: 'open_with_observations',
  CLOSED: 'closed',
  CLOSED_NONCOMPLIANCE: 'closed_noncompliance',
  // An electrical permit names a LOTO procedure (lotoProcedureId). Approved by
  // both teams, its work still may not start until every isolation point of
  // that procedure is locked out; closed by both teams, it is not closed until
  // the locks have come off.
  APPROVED_LOTO_PENDING: 'approved_loto_pending',
  CLOSED_LOTO_PENDING: 'closed_loto_pending',
}

export const STATUS_META = {
  [STATUS.DRAFT]: { label: 'Draft', color: '#64748b' },
  [STATUS.APPROVED]: { label: 'Approved', color: '#16a34a' },
  [STATUS.IN_PROGRESS]: { label: 'Approved & Work in Progress', color: '#2563eb' },
  [STATUS.EXTENDED]: { label: 'Extended', color: '#7c3aed' },
  [STATUS.EXTENDED_IN_PROGRESS]: { label: 'Extended & In Progress', color: '#7c3aed' },
  [STATUS.NOT_CLOSED]: { label: 'Not Closed / Expired', color: '#dc2626' },
  [STATUS.OPEN_WITH_OBSERVATIONS]: { label: 'Open — Unsafe Observation Raised', color: '#ea580c' },
  [STATUS.CLOSED]: { label: 'Closed', color: '#334155' },
  [STATUS.CLOSED_NONCOMPLIANCE]: { label: 'Closed — Non-Compliance at work location', color: '#991b1b' },
  [STATUS.APPROVED_LOTO_PENDING]: { label: 'Approved — LOTO pending', color: '#b45309' },
  [STATUS.CLOSED_LOTO_PENDING]: { label: 'Closed — LOTO pending', color: '#b45309' },
}

export function statusMeta(status) {
  return STATUS_META[status] || { label: status || 'Unknown', color: '#64748b' }
}

const ms = (iso) => {
  const t = iso ? Date.parse(iso) : NaN
  return Number.isNaN(t) ? null : t
}

const decided = (block, value) => block?.status === value

/** Both approving teams approved the top-level permit. */
export function bothApproved(permit) {
  return decided(permit?.engineering, 'approved') && decided(permit?.operations, 'approved')
}

/** Either team rejected (sends the permit back to Draft until re-submitted). */
export function isRejected(permit) {
  return decided(permit?.engineering, 'rejected') || decided(permit?.operations, 'rejected')
}

/** Closure approved by both teams. */
export function closureDone(permit) {
  const c = permit?.closure
  return Boolean(c && decided(c.engineering, 'approved') && decided(c.operations, 'approved'))
}

/** Extension approved by both teams. */
export function extensionApproved(permit) {
  const e = permit?.extension
  return Boolean(e && decided(e.engineering, 'approved') && decided(e.operations, 'approved'))
}

/**
 * Does this permit wait on a LOTO procedure? Then `lotoLockStatus` is that
 * procedure's live lock state ('unlocked' | 'partial' | 'locked'), joined on
 * by PermitContext and the public page from the procedure's public record;
 * it is not a stored field. Unknown counts as not done, both ways: a permit
 * whose isolation cannot be confirmed is not one to start, or to call closed.
 */
export const needsLoto = (permit) => Boolean(permit?.lotoProcedureId)
export const lotoLocked = (permit) => permit?.lotoLockStatus === 'locked'
export const lotoReleased = (permit) => permit?.lotoLockStatus === 'unlocked'

/** Effective end-of-validity (ISO) — the extended end if an extension is approved. */
export function effectiveValidTo(permit) {
  return extensionApproved(permit) ? permit?.extension?.newValidTo || permit?.validTo : permit?.validTo
}

/**
 * Combine a date (YYYY-MM-DD) + time (HH:mm) into an ISO timestamp, and compute
 * the 8-hour validity window. Returns { validFrom, validTo } as ISO strings.
 */
export function computeWindow(date, time) {
  const start = new Date(`${date}T${time || '00:00'}`)
  if (Number.isNaN(start.getTime())) return { validFrom: null, validTo: null }
  const end = new Date(start.getTime() + PERMIT_WINDOW_MS)
  return { validFrom: start.toISOString(), validTo: end.toISOString() }
}

/**
 * Derive the live status of a permit at time `now` (ms epoch).
 * See the spec mapping in the file header.
 */
export function derivePermitStatus(permit, now = Date.now()) {
  if (!permit) return STATUS.DRAFT
  // An unsafe observation closes the permit for non-compliance — overrides all.
  if (permit.closedDueToObservation) return STATUS.CLOSED_NONCOMPLIANCE
  if (closureDone(permit)) {
    return needsLoto(permit) && !lotoReleased(permit) ? STATUS.CLOSED_LOTO_PENDING : STATUS.CLOSED
  }

  // An unsafe observation reported by QR scan does not close the permit — only
  // a signed-in decision does that — but it must be visible from the list
  // rather than only from the observations page. It outranks the lifecycle
  // states because a permit with an unanswered "this work is unsafe" against it
  // is the one to look at first, whatever else is true of it.
  //
  // `openUnsafeCount` is joined on by PermitContext from the observations
  // listener; it is not a stored field, so a permit read straight from
  // Firestore simply never has it and this is skipped.
  if (permit.openUnsafeCount > 0) return STATUS.OPEN_WITH_OBSERVATIONS

  if (!bothApproved(permit)) return STATUS.DRAFT

  const to = ms(effectiveValidTo(permit))
  const ext = extensionApproved(permit)

  // No usable window → treat an approved permit as open/in-progress.
  if (to == null) {
    if (needsLoto(permit) && !lotoLocked(permit)) return STATUS.APPROVED_LOTO_PENDING
    return ext ? STATUS.EXTENDED_IN_PROGRESS : STATUS.IN_PROGRESS
  }

  // Past the validity window → expired (Not Closed).
  if (now > to) return STATUS.NOT_CLOSED

  // Approved, but the equipment is not isolated yet: no work.
  if (needsLoto(permit) && !lotoLocked(permit)) return STATUS.APPROVED_LOTO_PENDING

  // Approved and still within its timeline → work may proceed, so it reads as
  // In Progress (there is no separate pre-start "Approved" holding state — an
  // open permit inside the timeline is In Progress).
  return ext ? STATUS.EXTENDED_IN_PROGRESS : STATUS.IN_PROGRESS
}

/**
 * Aggregate counts for the dashboard's headline buckets. Each permit lands in
 * exactly ONE bucket (a partition): an extended permit counts under "Extended"
 * only, never also under "In Progress".
 */
export function dashboardBuckets(permits = [], now = Date.now()) {
  const c = {
    open: 0, inProgress: 0, extended: 0,
    notClosed: 0, notClosedExtended: 0, notClosedPlain: 0,
    withObservations: 0, closed: 0, rejected: 0, lotoPending: 0,
  }
  for (const p of permits) {
    const s = derivePermitStatus(p, now)
    if (s === STATUS.CLOSED || s === STATUS.CLOSED_NONCOMPLIANCE) c.closed++
    // Approved or closed by both teams, waiting on the locks: its own bucket,
    // so it is counted neither as work in progress nor as done.
    else if (s === STATUS.APPROVED_LOTO_PENDING || s === STATUS.CLOSED_LOTO_PENDING) c.lotoPending++
    // Its own bucket. Falling through to `open` would count a permit with an
    // unanswered unsafe report as one merely awaiting approval.
    else if (s === STATUS.OPEN_WITH_OBSERVATIONS) c.withObservations++
    else if (s === STATUS.NOT_CLOSED) {
      // Segregate expired permits by whether they were extended before lapsing.
      c.notClosed++
      if (extensionApproved(p)) c.notClosedExtended++
      else c.notClosedPlain++
    }
    else if (s === STATUS.EXTENDED || s === STATUS.EXTENDED_IN_PROGRESS) c.extended++
    else if (s === STATUS.IN_PROGRESS) c.inProgress++
    else if (isRejected(p)) c.rejected++
    else c.open++ // draft (awaiting approval)
  }
  return c
}
