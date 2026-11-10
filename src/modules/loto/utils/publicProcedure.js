/**
 * The public face of an isolation procedure.
 *
 * The QR printed on a procedure is stuck to a machine, and the person who scans
 * it is standing in front of that machine — often with no account and no reason
 * to have one. They need to know what to isolate, how, what will hurt them, how
 * to prove it is dead, and whether it is locked right now. They do not need to
 * know who locked it.
 *
 * That last point is why this file exists rather than a rule opening
 * /procedures/{id} to anyone with a scanned code: the procedure document
 * carries names, so publishing it would publish
 * lockState.techName, groupLock.members[].name, primaryTech and the approval
 * trail along with it. This mirrors the /qr and /permitQr pattern already used
 * for the equipment and permit codes.
 *
 * WHITELIST, never a blacklist. Every field published is named here explicitly,
 * so a field added to the procedure tomorrow stays private until someone
 * decides otherwise. A blacklist inverts that default, and the failure is
 * silent — the field is simply public one deploy later, with nothing to notice.
 */

/** Public mirror collection. Keyed by procedureId, because the codes already in
 *  the field encode /p/<procedureId> and re-keying would orphan every one. */
export const PUBLIC_COL = 'procedureQr'

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v))

/**
 * The safe subset of one isolation point.
 *
 * `p || {}` rather than a default parameter: a default only substitutes for
 * undefined, so a null entry in the array — which is what a partially-written
 * document gives you — sails past it and throws on the first field access. The
 * same distinction refused every QR defect report for a day when a rule called
 * .size() on a present-but-null value.
 */
function publicPoint(point) {
  const p = point || {}
  return {
    key: str(p.key),
    energySource: str(p.energySource),
    rating: str(p.rating),
    isolationDetails: str(p.isolationDetails),
    hazard: str(p.hazard),
    verification: str(p.verification),
    device: str(p.device),
    devices: Array.isArray(p.devices) ? p.devices.map(str) : [],
    // Whether, not who. The single fact that changes what a person standing at
    // the machine should do, carrying none of the identity attached to it.
    locked: Boolean(p.lockState?.locked),
  }
}

/**
 * Build the mirror document body from a procedure.
 *
 * Deliberately has no timestamp of its own: the caller adds serverTimestamp()
 * so this stays pure and testable, and so the mirror write can ride inside the
 * same batch or transaction as the procedure write.
 *
 * orgId IS published. It is not a secret — /orgIndex maps organization names to
 * ids for anyone — and the write rule needs it on the document to pin the
 * mirror to its owning tenant.
 */
export function publicProcedure(procedure = {}) {
  const points = Array.isArray(procedure.isolationPoints) ? procedure.isolationPoints : []
  const summary = procedure.lockSummary || {}
  return {
    procedureCode: str(procedure.procedureCode),
    title: str(procedure.title),
    equipment: str(procedure.equipment),
    site: str(procedure.site || procedure.siteName),
    status: str(procedure.status),
    revision: Number.isFinite(procedure.revision) ? procedure.revision : 0,
    lockStatus: str(summary.status),
    lockedCount: Number.isFinite(summary.lockedCount) ? summary.lockedCount : 0,
    pointCount: points.length,
    points: points.map(publicPoint),
  }
}

// There is deliberately no second, partial builder. Every writer already holds
// the whole procedure — the lock transactions read it, the status changes fetch
// it — so all of them rebuild the mirror in full. A partial "just the lock bits"
// variant would be a second definition of what is public, and the two would
// drift the first time a field is added to one and not the other.
//
// Rebuilding in full also self-heals: any lock or approval on a procedure that
// predates the mirror writes a complete one, so only untouched procedures need
// the backfill.
