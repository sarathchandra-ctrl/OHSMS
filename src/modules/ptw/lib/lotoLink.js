// ─────────────────────────────────────────────────────────────────────────────
// An electrical work permit and the LOTO procedure that isolates its equipment.
// Pure, so it is unit-testable.
//
// Raising an electrical permit asks which LOTO procedure applies, from the
// approved procedures at the permit's site. The permit then waits on that
// procedure's locks (permitStatus.js): Approved — LOTO pending until every
// isolation point is locked out, Closed — LOTO pending until the locks are off.
// ─────────────────────────────────────────────────────────────────────────────

export const LOTO_WORK_TYPES = ['Electrical Work']

/** Does this type of work need a LOTO procedure named on the permit? */
export const needsLotoProcedure = (typeOfWork) => LOTO_WORK_TYPES.includes(typeOfWork)

/**
 * The procedures a permit at this site may name: approved ones (a lock can be
 * applied only under an approved procedure), at this site, in code order.
 */
export function proceduresForSite(procedures = [], siteId = '') {
  if (!siteId) return []
  return (procedures || [])
    .filter((p) => p && p.siteId === siteId && p.status === 'approved')
    .sort((a, b) => String(a.procedureCode || a.equipment || '').localeCompare(String(b.procedureCode || b.equipment || ''), undefined, { numeric: true }))
}

/** How a procedure reads in the picker and on the permit. */
export const procedureLabel = (p) =>
  [p?.procedureCode, p?.equipment || p?.title].filter(Boolean).join(' — ') || 'Procedure'

/** The fields a permit stores about its procedure; all blank when none applies. */
export function lotoFields(procedure) {
  if (!procedure) return { lotoProcedureId: '', lotoProcedureCode: '', lotoEquipment: '' }
  return {
    lotoProcedureId: String(procedure.id || ''),
    lotoProcedureCode: String(procedure.procedureCode || ''),
    lotoEquipment: String(procedure.equipment || procedure.title || ''),
  }
}

/** How the live lock state reads on the permit. */
export function lockStateLabel(permit) {
  const s = permit?.lotoLockStatus
  const of = permit?.lotoPointCount ? ` (${permit.lotoLockedCount || 0} of ${permit.lotoPointCount} points)` : ''
  if (s === 'locked') return `Locked out${of}`
  if (s === 'partial') return `Partly locked${of}`
  if (s === 'unlocked') return `Not locked${of}`
  return 'Lock state not available'
}
