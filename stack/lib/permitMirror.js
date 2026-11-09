// ─────────────────────────────────────────────────────────────────────────────
// Withdrawing the public detail of permits nobody came back to close.
//
// `/permitQr/{token}` is a world-readable mirror of a work permit, so the person
// standing at the barrier can scan the code and see that the work is authorised,
// what it is, what the hazards are and until when. The crew is already published
// as COUNTS rather than names (src/modules/ptw/lib/publicPermit.js), and a
// permit that reaches Closed has its describing fields actively blanked.
//
// ── Why a scheduled job is needed on top of that ────────────────────────────
//
// Withdrawal happens on WRITE. `mirrorDisplayFields` decides live-or-withdrawn
// each time the mirror is updated, which covers every permit somebody closes,
// extends or touches.
//
// It covers nothing about a permit nobody touches again — and that is the whole
// at-risk population. A permit that lapses at 18:00 and is never formally closed
// gets no further writes, so its job description, location, hazards and the name
// it was issued to stay on an unauthenticated URL indefinitely. The old
// behaviour therefore selected precisely for neglect: close a permit properly
// and it was withdrawn; forget it and it was published forever.
//
// Expiry is deliberately NOT immediate grounds for withdrawal — a permit that
// lapsed while work carried on is the one somebody should still be able to read
// and challenge. That reasoning holds for days, not years. This closes the
// "years" half and leaves the challenge window intact.
//
// ── Conservative by construction ────────────────────────────────────────────
//
// This runs unattended with Admin SDK privileges over a collection shared by
// every tenant, and its effect is to remove information from a SAFETY page. So
// every ambiguity resolves toward keeping the detail:
//
//   · the LATER of validTo and any extension date is used, and the extension's
//     approval state is not consulted — a pending extension still delays
//     withdrawal rather than being ignored
//   · a mirror with no usable end date is never withdrawn
//   · a mirror already withdrawn is skipped rather than rewritten
//
// Pure. index.js reads and writes; this only decides.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The challenge window, in days, after a permit's effective end.
 *
 * ⚠️ Duplicated from `STALE_AFTER_DAYS` in
 * `src/modules/ptw/lib/publicPermit.js`, because the two live in different npm
 * packages and no import crosses that seam. It is one number and both sides
 * name each other; if they drift, the write path and the sweep disagree about
 * when a permit goes quiet, which shows up as a mirror that flips between
 * withdrawn and live.
 */
export const STALE_AFTER_DAYS = 7

/** How many mirrors one run may withdraw. Same reasoning as the retention cap. */
export const MAX_WITHDRAWALS_PER_RUN = 500

/** Millisecond timestamp from whatever shape the field arrived in. */
export function toMillis(value) {
  if (value == null) return null
  if (typeof value === 'object') {
    if (typeof value.toMillis === 'function') return value.toMillis()
    if (typeof value.seconds === 'number') return value.seconds * 1000
    if (value instanceof Date) return value.getTime()
    return null
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const t = Date.parse(String(value))
  return Number.isNaN(t) ? null : t
}

/**
 * The effective end of a mirrored permit.
 *
 * The LATER of `validTo` and `extension.newValidTo`, and deliberately without
 * checking whether the extension was approved. An unapproved extension only
 * ever delays withdrawal, which is the safe direction for a page whose job is
 * to let somebody challenge live work.
 */
export function effectiveEnd(mirror = {}) {
  const base = toMillis(mirror.validTo)
  const ext = toMillis(mirror.extension?.newValidTo)
  if (base == null) return ext
  if (ext == null) return base
  return Math.max(base, ext)
}

/**
 * Should this mirror's describing fields be withdrawn now?
 *
 * Returns `{ withdraw, reason }` — the reason is for the log, because a job
 * that removes information from a safety page should be able to say why it
 * removed each one.
 */
export function shouldWithdraw(mirror = {}, now = Date.now(), days = STALE_AFTER_DAYS) {
  if (!mirror) return { withdraw: false, reason: 'no-mirror' }
  // Already done. Skipping keeps the run idempotent and keeps a large backlog
  // from being rewritten every night.
  if (mirror.withdrawn === true) return { withdraw: false, reason: 'already-withdrawn' }

  const end = effectiveEnd(mirror)
  // Nothing says when this permit ends, so nothing says it has expired. The app
  // treats such a permit as in progress; withdrawing it would take a barrier
  // check away from work the system still considers live.
  if (end == null) return { withdraw: false, reason: 'no-end-date' }

  if (now <= end + days * 24 * 60 * 60 * 1000) return { withdraw: false, reason: 'within-window' }
  return { withdraw: true, reason: 'stale' }
}

/**
 * The fields to write over a stale mirror.
 *
 * Must stay identical to `withdrawnFields()` in
 * `src/modules/ptw/lib/publicPermit.js` — the second half of the duplication
 * warned about above. Blanked rather than deleted, and the permit number, site,
 * type and status survive: a scan afterwards should say "this permit is over",
 * not 404, which reads as a wrong code and sends somebody hunting for a permit
 * that did its job.
 */
export function withdrawnFields() {
  return {
    jobDescription: '',
    jobLocation: '',
    issuingDepartment: '',
    issuedToName: '',
    hazards: [],
    ppe: [],
    precautions: [],
    jsa: [],
    participantCount: 0,
    fireWatcherCount: 0,
    hasConfinedWatcher: false,
    withdrawn: true,
  }
}

/**
 * Plan a run over a batch of mirrors.
 *
 * Returns the tokens to withdraw and, for the log, why each one was left alone.
 * Capped for the same reason the retention sweep is: an unattended job whose
 * blast radius is every tenant should cost one run's worth of damage if its
 * query is wrong, not the whole collection.
 */
export function planWithdrawals(mirrors = [], { now = Date.now(), days = STALE_AFTER_DAYS, max = MAX_WITHDRAWALS_PER_RUN } = {}) {
  const withdraw = []
  const skipped = []
  for (const m of mirrors || []) {
    if (!m) continue
    const { withdraw: yes, reason } = shouldWithdraw(m, now, days)
    if (!yes) { skipped.push({ token: m.token || m.id, reason }); continue }
    if (withdraw.length >= max) { skipped.push({ token: m.token || m.id, reason: 'over the per-run cap' }); continue }
    withdraw.push(m.token || m.id)
  }
  return { withdraw, skipped, capped: skipped.some((s) => s.reason === 'over the per-run cap') }
}
