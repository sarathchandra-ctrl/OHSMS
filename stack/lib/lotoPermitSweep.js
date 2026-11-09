// The two scheduled jobs behind LOTO permits.
//
//   sweepLotoPermits         every few minutes: flag active permits that are due
//                            or overdue against their window END, on the SERVER
//                            clock. The flags are what notifyLotoPermitLifecycle
//                            turns into mail, and what the app's badge defers to.
//   purgeClosedLotoPermits   nightly: delete permits closed more than a year ago,
//                            with their events, attachments and stored files.
//
// Planning is pure (planFlags, isPurgeable). The loops take their Firestore and
// Storage handles as arguments so they are tested without either, the same split
// retention.js uses.
//
// ── Why instants, not times of day ───────────────────────────────────────────
// A shift window is two absolute instants. A 22:00–06:00 permit is stored as
// 22:00 on one day and 06:00 on the next, so "overdue" is always
// `now >= windowEnd`. Nothing here ever compares a clock reading, so midnight
// cannot be a special case.

/** "Due" begins this long before the window end. Mirrors DUE_SOON_MINUTES in the app. */
export const DUE_SOON_MS = 30 * 60 * 1000

/** An overdue permit is mailed again this often until somebody returns or extends it. */
export const OVERDUE_REPEAT_MS = 30 * 60 * 1000

/** From this notice on, the mail is worded as an escalation. */
export const OVERDUE_ESCALATE_AT = 3

/** Closed permits are kept this long after closure (owner decision: 1 year). */
export const LOTO_PERMIT_RETENTION_DAYS = 365

/**
 * One run may delete at most this many permits. A mistake in the query then
 * costs one run's worth, not the table — the same argument as MAX_PURGES_PER_RUN.
 */
export const MAX_PERMIT_PURGES_PER_RUN = 500

export const CLOSED_STATUSES = ['returned', 'rejected', 'withdrawn', 'emergency_removed']

function ms(value) {
  if (typeof value === 'number') return value
  if (value instanceof Date) return value.getTime()
  if (typeof value?.toMillis === 'function') return value.toMillis()
  if (typeof value?._seconds === 'number') return value._seconds * 1000
  return Number.NaN
}

const EMPTY = (windowEnd) => ({
  windowEnd,
  dueAt: null,
  overdueSince: null,
  overdueCount: 0,
  lastOverdueAt: null,
})

/**
 * The flags this permit should carry at `nowMs`, or null when they are already
 * right (so a sweep that changes nothing writes nothing — every write would
 * wake the mail trigger).
 *
 * Only an ACTIVE permit has a clock: before it starts there is no equipment
 * locked to be late with, and after it closes nothing is outstanding. Flags are
 * keyed to the window end they were computed for, so an extension (a later end)
 * starts the count again from zero instead of inheriting the old deadline's
 * "overdue".
 */
export function planFlags(permit, nowMs) {
  if (!permit || permit.status !== 'active') return null
  const end = ms(permit.windowEnd)
  if (!Number.isFinite(end)) return null
  const current = permit.flags || {}
  const flags = current.windowEnd === end ? { ...EMPTY(end), ...current } : EMPTY(end)

  if (nowMs >= end) {
    const last = Number(flags.lastOverdueAt) || 0
    if (!flags.overdueCount) {
      flags.overdueCount = 1
      flags.overdueSince = end
      flags.lastOverdueAt = nowMs
    } else if (nowMs - last >= OVERDUE_REPEAT_MS) {
      flags.overdueCount += 1
      flags.lastOverdueAt = nowMs
    }
    // It was also due: a sweep that first sees the permit already past its end
    // (the job was down) still records that the due notice was owed.
    if (!flags.dueAt) flags.dueAt = nowMs
  } else if (nowMs >= end - DUE_SOON_MS && !flags.dueAt) {
    flags.dueAt = nowMs
  }

  // A permit that has never been flagged and still has nothing to flag stays
  // exactly as it is. Writing an empty flags map to every healthy permit on every
  // run would wake the mail trigger for nothing.
  if (!permit.flags && flags.dueAt == null && !flags.overdueCount) return null

  const same =
    current.windowEnd === flags.windowEnd &&
    (current.dueAt ?? null) === flags.dueAt &&
    (current.overdueSince ?? null) === flags.overdueSince &&
    (current.overdueCount ?? 0) === flags.overdueCount &&
    (current.lastOverdueAt ?? null) === flags.lastOverdueAt
  return same ? null : flags
}

/** Closed for more than the retention period, and never an open permit. */
export function isPurgeable(permit, nowMs, days = LOTO_PERMIT_RETENTION_DAYS) {
  if (!permit || !CLOSED_STATUSES.includes(permit.status)) return false
  const closed = ms(permit.closedAt)
  // No closure time: keep it. A permit we cannot date is not one we can prove
  // is a year old, and deletion is the irreversible direction.
  if (!Number.isFinite(closed)) return false
  return nowMs - closed >= days * 24 * 60 * 60 * 1000
}

/** Is this Storage path inside the org? (Same test as index.js ownedByOrg.) */
export function ownedByOrg(path, orgId) {
  const p = String(path || '')
  return p.startsWith(`orgs/${orgId}/`) && !p.includes('..')
}

/**
 * Flag every active permit of every org. Returns { checked, flagged, failures }.
 * A permit that fails to update is reported, not fatal: the next run covers it.
 */
export async function sweepLotoPermits({ db, nowMs, logger }) {
  const failures = []
  let checked = 0
  let flagged = 0
  const orgs = await db.collection('organizations').get()
  for (const org of orgs.docs) {
    try {
      const snap = await db
        .collection('organizations')
        .doc(org.id)
        .collection('lotoPermits')
        .where('status', '==', 'active')
        .get()
      for (const d of snap.docs) {
        checked += 1
        const flags = planFlags(d.data(), nowMs)
        if (!flags) continue
        try {
          await d.ref.update({ flags })
          flagged += 1
        } catch (e) {
          failures.push({
            kind: 'flag-failed',
            orgId: org.id,
            docId: d.id,
            error: e?.message || String(e),
          })
        }
      }
    } catch (e) {
      failures.push({ kind: 'org-failed', orgId: org.id, error: e?.message || String(e) })
    }
  }
  logger?.info?.('loto permits: sweep complete', { checked, flagged, failures: failures.length })
  return { checked, flagged, failures }
}

async function deletePermitFile(store, orgId, docId, path, failures) {
  if (!path) return 0
  if (!ownedByOrg(path, orgId)) {
    failures.push({ kind: 'foreign-file-path', orgId, docId, path })
    return 0
  }
  try {
    await store.file(path).delete({ ignoreNotFound: true })
    return 1
  } catch (e) {
    failures.push({
      kind: 'file-left-behind',
      orgId,
      docId,
      path,
      error: e?.message || String(e),
    })
    return 0
  }
}

/**
 * Delete closed permits older than the retention period, subcollections and
 * stored files first (a pointer must not outlive its file, nor the parent its
 * children). Returns { purged, files, failures }.
 */
export async function purgeClosedLotoPermits({
  db,
  store,
  nowMs,
  logger,
  days = LOTO_PERMIT_RETENTION_DAYS,
}) {
  const failures = []
  let purged = 0
  let files = 0
  const cutoff = new Date(nowMs - days * 24 * 60 * 60 * 1000)
  const orgs = await db.collection('organizations').get()
  for (const org of orgs.docs) {
    if (purged >= MAX_PERMIT_PURGES_PER_RUN) break
    try {
      const col = db.collection('organizations').doc(org.id).collection('lotoPermits')
      // closedAt alone is a single-field query (no composite index); the status
      // and the age are re-checked by isPurgeable, which is the actual guarantee.
      const snap = await col.where('closedAt', '<=', cutoff).limit(MAX_PERMIT_PURGES_PER_RUN).get()
      for (const d of snap.docs) {
        if (purged >= MAX_PERMIT_PURGES_PER_RUN) break
        if (!isPurgeable(d.data(), nowMs, days)) continue
        try {
          for (const sub of ['events', 'attachments']) {
            const kids = await d.ref.collection(sub).get()
            for (const kid of kids.docs) {
              const path = String(kid.data()?.path || '').trim()
              // The path is client-writable and this runs with Admin privileges
              // that ignore storage.rules: confine it to the org's own prefix.
              if (path && ownedByOrg(path, org.id)) {
                try {
                  await store.file(path).delete({ ignoreNotFound: true })
                  files += 1
                } catch (e) {
                  failures.push({
                    kind: 'file-left-behind',
                    orgId: org.id,
                    docId: d.id,
                    path,
                    error: e?.message || String(e),
                  })
                }
              } else if (path) {
                failures.push({ kind: 'foreign-file-path', orgId: org.id, docId: d.id, path })
              }
              await kid.ref.delete()
            }
          }
          await d.ref.delete()
          const lockPath = String(d.data()?.lockPhoto?.path || '').trim()
          if (lockPath) {
            files += await deletePermitFile(store, org.id, d.id, lockPath, failures)
          }
          const photoRef = db.collection('procedurePhotos').doc(`permitlock_${d.id}`)
          const photoSnap = await photoRef.get()
          if (photoSnap.exists && photoSnap.data()?.orgId === org.id) {
            const nested = String(photoSnap.data()?.photos?.lock?.path || '').trim()
            if (nested && nested !== lockPath) {
              files += await deletePermitFile(store, org.id, d.id, nested, failures)
            }
            await photoRef.delete()
          }
          purged += 1
        } catch (e) {
          failures.push({
            kind: 'permit-failed',
            orgId: org.id,
            docId: d.id,
            error: e?.message || String(e),
          })
        }
      }
    } catch (e) {
      failures.push({ kind: 'org-failed', orgId: org.id, error: e?.message || String(e) })
    }
  }
  logger?.info?.('loto permits: purge complete', { purged, files, failures: failures.length })
  return { purged, files, failures }
}
