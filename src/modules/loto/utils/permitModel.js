// ─────────────────────────────────────────────────────────────────────────────
// Building and checking a permit request. Pure — no Firestore — so the form's
// rules can be tested without a browser, and the same checks can be restated
// where they cannot be bypassed (firestore.rules).
// ─────────────────────────────────────────────────────────────────────────────
import { PROCEDURE_STATUS } from '../constants/procedures'
import { pointDeviceKeys } from '../constants/energySources'
import { numberIsolationPoints } from './codes'
import { LIMITS, MIN_REASON_LENGTH, SHIFT_PRESETS, workTypeByKey } from '../constants/permits'
import { groupProblems } from './groupLock'
import { shiftRequestProblem } from './shiftWindow'
import { windowProblem, toMs } from './permitWindow'

const clean = (v) => (typeof v === 'string' ? v.trim() : '')

/** '' when the technician can be named on a permit. licenceExp is a timestamp or ISO date. */
export function technicianLicenceProblem(tech, nowMs = Date.now()) {
  if (!tech?.licenceNo) return 'missing'
  const exp = toMs(tech.licenceExp)
  if (!Number.isFinite(exp) || exp <= nowMs) return 'expired'
  return ''
}

/** Stable key for "this piece of equipment at this site". */
export function equipmentKey(procedure) {
  const where = clean(procedure?.siteId) || clean(procedure?.site)
  return `${where}::${clean(procedure?.equipment).toLowerCase()}`
}

/**
 * The equipment a permit can be raised against: one row per (site, equipment)
 * across ALL procedures, with how many of them are APPROVED. Equipment with no
 * approved procedure is still listed — silently hiding it would read as "this
 * machine is not in the system" — but cannot be selected (`approved: 0`).
 */
export function equipmentOptions(procedures = []) {
  const map = new Map()
  for (const p of procedures) {
    if (!clean(p?.equipment)) continue
    const key = equipmentKey(p)
    const row = map.get(key) || {
      key,
      equipment: clean(p.equipment),
      site: clean(p.site),
      siteId: clean(p.siteId),
      approved: 0,
      total: 0,
    }
    row.total += 1
    if (p.status === PROCEDURE_STATUS.APPROVED) row.approved += 1
    map.set(key, row)
  }
  return [...map.values()].sort(
    (a, b) => a.equipment.localeCompare(b.equipment) || a.site.localeCompare(b.site),
  )
}

/**
 * ONLY the APPROVED procedures of that equipment. A draft, a procedure waiting
 * for approval and a rejected one are not isolation instructions anyone has
 * signed, so they never reach the dropdown (the decision this exists for).
 */
export function approvedProceduresFor(procedures = [], key) {
  return procedures
    .filter((p) => p?.status === PROCEDURE_STATUS.APPROVED && equipmentKey(p) === key)
    .sort((a, b) => clean(a.procedureCode).localeCompare(clean(b.procedureCode)))
}

/**
 * What the permit copies out of a procedure when it is raised: the identity
 * (so a later revision is detectable), the scope fields mail and rules use, and
 * the isolation points with the devices each needs. `devices` and `pointCount`
 * are the "auto-filled" values the requester sees.
 */
export function snapshotProcedure(procedure) {
  const points = numberIsolationPoints(procedure?.isolationPoints || []).map((p) => ({
    key: p.key,
    pointId: p.pointId,
    energySource: p.energySource || '',
    energyLabel: p.energyLabel || '',
    devices: pointDeviceKeys(p),
  }))
  const devices = [...new Set(points.flatMap((p) => p.devices))]
  return {
    procedureId: procedure.id,
    procedureCode: clean(procedure.procedureCode),
    procedureRevision: Number.isFinite(procedure.revision) ? procedure.revision : 0,
    equipment: clean(procedure.equipment),
    site: clean(procedure.site),
    siteId: clean(procedure.siteId),
    region: clean(procedure.region),
    entity: clean(procedure.entity),
    isolationPoints: points,
    pointKeys: points.map((p) => p.key),
    pointCount: points.length,
    devices,
  }
}

/** A lock the requester may put on a point, from either register. */
export function lockChoices({ technicians = [], locks = [], inUse = new Set(), chosen = [] }) {
  const taken = new Set([...inUse, ...chosen.filter(Boolean)])
  const personal = technicians
    .filter((t) => t.active !== false && t.lockNo && !taken.has(t.lockNo))
    .map((t) => ({
      source: 'technician',
      id: `tech:${t.id}`,
      lockNo: t.lockNo,
      lockType: 'personal',
      techId: t.id,
      techName: t.name || '',
    }))
  const department = locks
    .filter((l) => l.active !== false && l.type === 'department' && l.lockNo && !taken.has(l.lockNo))
    .map((l) => ({
      source: 'register',
      id: `lock:${l.id}`,
      lockNo: l.lockNo,
      lockType: 'department',
      techId: null,
      techName: '',
    }))
  return { personal, department }
}

/**
 * Everything wrong with a draft, keyed by field. Empty object means it can be
 * submitted. `ctx.procedure` is the SELECTED, APPROVED procedure snapshot (or
 * null); `ctx.nowMs` makes the window check testable.
 */
export function validateDraft(draft, ctx = {}) {
  const errors = {}
  const type = workTypeByKey(draft?.workType)
  if (!type) errors.workType = 'Choose the type of work.'

  const snap = ctx.snapshot || null
  // Every permit isolates equipment. There is no tag-only work type.
  if (type) {
    if (!snap) errors.procedure = 'Choose the equipment and one of its approved procedures.'
    else if (!snap.pointCount) errors.procedure = 'That procedure has no isolation points.'
  }
  if (ctx.procedureStatus && ctx.procedureStatus !== PROCEDURE_STATUS.APPROVED) {
    errors.procedure = 'Only an approved procedure can be used for a permit.'
  }

  if (clean(draft?.reason).length < MIN_REASON_LENGTH) {
    errors.reason = `Describe the job (at least ${MIN_REASON_LENGTH} characters).`
  } else if (draft.reason.length > LIMITS.text) {
    errors.reason = `Keep the description under ${LIMITS.text} characters.`
  }

  // A chosen shift fixes the window. A draft that has not chosen one yet is
  // still checked as a plain span, so older callers keep working.
  if (draft?.shift) {
    const shiftErr = shiftRequestProblem({
      shiftId: draft.shift,
      shifts: ctx.shifts || SHIFT_PRESETS,
      nowMs: ctx.nowMs,
      windowStartMs: draft.windowStartMs,
      windowEndMs: draft.windowEndMs,
      leadMinutes: ctx.leadMinutes,
      zoneOffsetMinutes: ctx.zoneOffsetMinutes ?? null,
    })
    if (shiftErr) errors.window = shiftErr
  } else {
    const win = windowProblem(draft?.windowStartMs, draft?.windowEndMs, { nowMs: ctx.nowMs })
    if (win) errors.window = win
  }

  const internal = Array.isArray(draft?.internalPersonnel) ? draft.internalPersonnel : []
  const vendors = Array.isArray(draft?.vendorWorkers) ? draft.vendorWorkers : []
  if (internal.length + vendors.length === 0) {
    errors.personnel = 'Name at least one person doing the work.'
  }
  if (internal.length + vendors.length > LIMITS.workers) errors.personnel = 'Too many people on one permit.'
  if (vendors.some((v) => !clean(v?.name) || !clean(v?.company))) {
    errors.vendorWorkers = 'Each contractor needs a name and a company.'
  } else if (vendors.some((v) => v?.competent !== true)) {
    errors.vendorWorkers = 'Each contractor needs a competence confirmation.'
  } else if (vendors.some((v) => /@/.test(String(v?.contact || '')))) {
    errors.vendorWorkers = 'Contractors are not emailed. Use a phone number, not an email address.'
  }

  const needed = snap?.pointCount || 0
  if (needed > 0) {
    const locks = Array.isArray(draft?.locks) ? draft.locks : []
    const byPoint = new Map(locks.map((l) => [l.pointKey, l]))
    const missing = snap.pointKeys.filter((k) => !clean(byPoint.get(k)?.lockNo))
    if (missing.length) errors.locks = 'Choose or register a lock for every isolation point.'
    else {
      const nos = snap.pointKeys.map((k) => String(byPoint.get(k).lockNo).trim().toLowerCase())
      if (new Set(nos).size !== nos.length) errors.locks = 'Each isolation point needs its own lock number.'
      else if (needed > 1 && snap.pointKeys.some((k) => byPoint.get(k).lockType !== 'department')) {
        // Mirrors setPointLock: one personal lock cannot hold several points.
        errors.locks = 'Several isolation points need a Department lock on each one.'
      } else {
        const blocked = snap.pointKeys
          .map((k) => byPoint.get(k))
          .filter((l) => l?.techId)
          .map((l) => technicianLicenceProblem((ctx.technicians || []).find((t) => t.id === l.techId), ctx.nowMs))
          .find(Boolean)
        if (blocked === 'missing') errors.locks = 'A named technician needs a wireman licence number and expiry.'
        if (blocked === 'expired') errors.locks = 'A named technician’s wireman licence has expired.'
      }
    }
  }
  if (draft?.group) {
    const groupErr = groupProblems(draft.group, {
      personnelUids: internal.map((p) => p.uid).filter(Boolean),
    })
    if (groupErr.length) errors.group = groupErr[0]
  }
  return errors
}

/**
 * The permit document (without server-assigned fields). Timestamps are carried
 * as epoch ms here and converted by the service, so this stays testable.
 */
export function buildPermit({ user, draft, snapshot }) {
  const internalPersonnel = (draft.internalPersonnel || []).map((p) => ({
    uid: clean(p.uid),
    name: clean(p.name),
  }))
  const vendorWorkers = (draft.vendorWorkers || []).map((v) => ({
    name: clean(v.name),
    company: clean(v.company),
    contact: clean(v.contact),
    competent: v.competent === true,
    certificatePath: clean(v.certificatePath),
  }))
  const pointKeys = snapshot?.pointKeys || []
  const locks = snapshot
    ? snapshot.isolationPoints.map((p) => {
        const l = (draft.locks || []).find((x) => x.pointKey === p.key) || {}
        return {
          pointKey: p.key,
          pointId: p.pointId,
          lockNo: clean(String(l.lockNo ?? '')),
          lockType: l.lockType === 'department' ? 'department' : 'personal',
          techId: l.techId || null,
          techName: clean(l.techName),
        }
      })
    : []
  return {
    workType: draft.workType,
    reason: clean(draft.reason),
    workOrder: clean(draft.workOrder),
    shift: clean(draft.shift),
    windowStartMs: draft.windowStartMs,
    windowEndMs: draft.windowEndMs,
    requestedBy: user.id,
    requestedByName: user.displayName || '',
    internalPersonnel,
    // The uids as a plain list: a rule or a query cannot look inside the sealed,
    // named objects above, but can ask "is this person on the crew" of this.
    personnelUids: [...new Set(internalPersonnel.map((p) => p.uid).filter(Boolean))],
    vendorWorkers,
    // Procedure-derived. Empty when no procedure was chosen; rules refuse that
    // create, and the form does not offer it.
    procedureId: snapshot?.procedureId || '',
    procedureCode: snapshot?.procedureCode || '',
    procedureRevision: snapshot?.procedureRevision ?? 0,
    equipment: snapshot?.equipment || '',
    site: snapshot?.site || '',
    siteId: snapshot?.siteId || '',
    region: snapshot?.region || '',
    entity: snapshot?.entity || '',
    isolationPoints: snapshot?.isolationPoints || [],
    pointKeys,
    pointCount: snapshot?.pointCount || 0,
    devices: snapshot?.devices || [],
    locks,
    ...(draft.group
      ? {
          groupLock: {
            active: true,
            method: draft.group.method === 'hasp' ? 'hasp' : 'box',
            groupNo: clean(draft.group.groupNo),
            primaryUid: draft.group.primaryUid,
            members: (draft.group.members || []).map((m) => ({
              uid: clean(m.uid),
              name: clean(m.name),
              lockNo: clean(m.lockNo),
            })),
          },
        }
      : {}),
  }
}

/**
 * Why this equipment should not be isolated again right now, or ''.
 *
 * A warning, not a block: the requester can still file the permit, and Start
 * is what the rules refuse while another permit holds the procedure. Hiding
 * the fact that the machine is already locked is how two crews end up on it.
 */
export function equipmentLockWarning(procedures = [], key) {
  if (!key) return ''
  const rows = procedures.filter((p) => equipmentKey(p) === key)
  const held = rows.find((p) => p?.activePermit)
  if (held) {
    const no = held.activePermit.permitNo || held.activePermit.id
    return `This equipment is already isolated under permit ${no}.`
  }
  const locked = rows.find(
    (p) =>
      p?.groupLock?.active ||
      p?.lockSummary?.status === 'locked' ||
      p?.lockSummary?.status === 'partial',
  )
  if (!locked) return ''
  const how = locked.lockSummary?.status === 'partial' ? 'partially locked' : 'locked out'
  return `This equipment is already ${how}.`
}
