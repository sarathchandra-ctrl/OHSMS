// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers for the org stats counter doc (organizations/{orgId}/meta/stats).
// Kept Firestore-free so they're unit-testable; data.js turns the delta
// objects into FieldValue.increment() writes inside each mutation batch.
//
// Stats track the ACTIVE fleet only (soft-deleted units are excluded), giving
// the dashboard exact structural totals fleet-wide regardless of the load cap.
// ─────────────────────────────────────────────────────────────────────────────
import { isDeleted } from './extinguisherLogic'

// Fields we bucket counts by.
const BUCKETS = ['byStatus', 'byType', 'byEntity', 'byRegion']

function bucketKeys(ext) {
  return {
    byStatus: ext.status || 'active',
    byType: ext.type || 'unknown',
    byEntity: ext.entity || 'unknown',
    byRegion: ext.region || 'unknown',
  }
}

/** A zeroed stats object. */
export function emptyStats() {
  return { total: 0, byStatus: {}, byType: {}, byEntity: {}, byRegion: {} }
}

/** Add ±1 for one extinguisher into the buckets of a flat delta map. */
function addToDelta(delta, ext, sign) {
  delta.total = (delta.total || 0) + sign
  const keys = bucketKeys(ext)
  for (const b of BUCKETS) {
    const k = keys[b]
    delta[b] = delta[b] || {}
    delta[b][k] = (delta[b][k] || 0) + sign
  }
  return delta
}

/**
 * Increment delta for a mutation. Pass the active-fleet view of each side:
 *   create:  before=null,  after=ext
 *   delete:  before=ext,   after=null   (soft-delete removes it from the fleet)
 *   restore: before=null,  after=ext
 *   edit:    before=old,   after=new    (only differing buckets net out)
 * A soft-deleted `after` is treated as null (leaves the active fleet); a
 * soft-deleted `before` is treated as null (was already out).
 * Returns a sparse delta object suitable for FieldValue.increment.
 */
export function statsDeltaFor(before, after) {
  const b = before && !isDeleted(before) ? before : null
  const a = after && !isDeleted(after) ? after : null
  const delta = {}
  if (b) addToDelta(delta, b, -1)
  if (a) addToDelta(delta, a, +1)
  return delta
}

/** Full recompute over a list (ignores soft-deleted). */
export function accumulate(list = []) {
  const s = emptyStats()
  for (const ext of list) {
    if (isDeleted(ext)) continue
    s.total += 1
    const keys = bucketKeys(ext)
    for (const b of BUCKETS) {
      const k = keys[b]
      s[b][k] = (s[b][k] || 0) + 1
    }
  }
  return s
}
