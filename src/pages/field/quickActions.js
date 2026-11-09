// Which buttons a scanned asset offers.
//
// The public sticker page lets anyone report a defect. This page is the
// signed-in one, so the buttons follow the same role matrix as the registers:
// a member can inspect and raise, a manager can also close, an auditor sees
// the unit and nothing they can press. A code whose mirror names another
// organisation offers nothing that writes — the mirror is world-readable, the
// asset is not theirs.

import { can } from '../../shared/auth/permissions'
import { isFutureDate } from '../../shared/lib/dates'
import {
  AED_STATUS,
  DEFECT_BY_KEY,
  FAS_STATUS,
  STATUS,
  STRETCHER_STATUS,
} from '../../modules/fire/lib/constants'

const KNOWN = new Set(['aed', 'fas', 'stretcher'])

export function assetKindOf(mirror) {
  const kind = mirror?.assetKind
  return KNOWN.has(kind) ? kind : 'extinguisher'
}

/** Document id the mirror points at. Empty when the sticker never recorded one. */
export function assetRecordId(mirror) {
  if (!mirror) return ''
  const id = assetKindOf(mirror) === 'extinguisher' ? mirror.extId : mirror.assetRefId
  return String(id || '').trim()
}

const FAULT_STATUS = {
  aed: AED_STATUS.OUT_OF_SERVICE,
  stretcher: STRETCHER_STATUS.OUT_OF_SERVICE,
  fas: FAS_STATUS.FAULTY,
}

export function hasOpenDefect(mirror) {
  if (!mirror || mirror.deletedAt) return false
  const kind = assetKindOf(mirror)
  if (kind === 'extinguisher') {
    return Array.isArray(mirror.physicalDefects) && mirror.physicalDefects.length > 0
  }
  return mirror.status === FAULT_STATUS[kind]
}

/**
 * @returns {{ state: 'missing'|'retired'|'unscoped'|'foreign'|'ready', kind?: string, actions: {key:string,label:string}[] }}
 */
export function fieldQuickActions(mirror, { role } = {}) {
  if (!mirror) return { state: 'missing', actions: [] }
  if (mirror.deletedAt) return { state: 'retired', actions: [] }
  // A mirror written before orgId existed cannot be proved to be this tenant.
  // Offering a write would aim it at whichever org the signed-in person is in.

  const kind = assetKindOf(mirror)
  const actions = []
  if (can(role, 'record.edit')) actions.push({ key: 'inspect', label: 'Inspect' })
  if (can(role, 'record.create')) actions.push({ key: 'defect', label: 'Raise defect' })
  if (
    kind === 'extinguisher' &&
    mirror.status === STATUS.IN_PROCESS_REFILLING &&
    can(role, 'record.edit')
  ) {
    actions.push({ key: 'receive', label: 'Mark received' })
  }
  if (hasOpenDefect(mirror) && can(role, 'record.close')) {
    actions.push({ key: 'close', label: 'Close defect' })
  }
  return { state: 'ready', kind, actions }
}

/** The next-due date an AED, FAS or stretcher inspection has to carry. */
export function validateNextDue(value, today) {
  const date = String(value || '').trim()
  if (!date) return 'Enter the next due date'
  if (!isFutureDate(date, today)) return 'The next due date must be after today'
  return ''
}

export function assetCard(mirror) {
  const kind = assetKindOf(mirror || {})
  const where = [mirror?.centerName, mirror?.location, mirror?.region, mirror?.entity]
    .filter(Boolean)
    .join(' · ')
  if (kind === 'aed') {
    return {
      kind,
      eyebrow: 'AED',
      title: [mirror?.brand, mirror?.model].filter(Boolean).join(' ') || mirror?.label || 'AED',
      subtitle: mirror?.label ? `Asset ${mirror.label}` : 'No asset ID recorded',
      where,
    }
  }
  if (kind === 'fas') {
    return {
      kind,
      eyebrow: 'Fire alarm system',
      title: mirror?.deviceType || mirror?.label || 'Fire alarm panel',
      subtitle: mirror?.label ? `Device ${mirror.label}` : 'No device ID recorded',
      where,
    }
  }
  if (kind === 'stretcher') {
    return {
      kind,
      eyebrow: 'Stretcher',
      title: mirror?.label || 'Stretcher',
      subtitle: '',
      where,
    }
  }
  return {
    kind: 'extinguisher',
    eyebrow: 'Fire extinguisher',
    title: [mirror?.type, mirror?.capacity].filter(Boolean).join(' · ') || 'Fire extinguisher',
    subtitle: mirror?.serialNo ? `Serial ${mirror.serialNo}` : 'No serial recorded',
    where,
    defects: (mirror?.physicalDefects || []).map((key) => DEFECT_BY_KEY[key]?.label || key),
  }
}
