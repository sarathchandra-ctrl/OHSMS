// ─────────────────────────────────────────────────────────────────────────────
// Audit-log action constants + pure helpers (no Firestore here, so they're
// unit-testable). The Firestore write itself lives in data.js (logAudit).
// ─────────────────────────────────────────────────────────────────────────────

export const AUDIT = {
  EXT_CREATE: 'extinguisher.create',
  EXT_UPDATE: 'extinguisher.update',
  EXT_DELETE: 'extinguisher.delete',
  EXT_BULK_CREATE: 'extinguisher.bulkCreate',
  EXT_BULK_UPSERT: 'extinguisher.bulkUpsert',
  EXT_BULK_DELETE: 'extinguisher.bulkDelete',
  EXT_RESTORE: 'extinguisher.restore',
  EXT_PURGE: 'extinguisher.purge',
  BACKUP: 'org.backup',
  WF_QUOTATION_SUBMITTED: 'workflow.quotationSubmitted',
  WF_HPT_SUBMITTED: 'workflow.hptSubmitted',
  WF_SENT_TO_VENDOR: 'workflow.sentToVendor',
  WF_RECEIVED: 'workflow.received',
  WF_REFILLED_CLOSED: 'workflow.refilledClosed',
  WF_RESOLVED_DEFECTS: 'workflow.resolvedDefects',
  DEFECT_CLOSE: 'defect.close',
  REPORT_CREATE: 'report.create',
  REPORT_APPROVE: 'report.approve',
  REPORT_REJECT: 'report.reject',
  USER_STATUS: 'user.status',
  USER_ROLE: 'user.role',
  ORG_SETTINGS: 'org.settings',
}

// Human label + color for each action (used by the audit table badge).
export const AUDIT_META = {
  [AUDIT.EXT_CREATE]: { label: 'Added extinguisher', color: '#16a34a' },
  [AUDIT.EXT_UPDATE]: { label: 'Edited extinguisher', color: '#6366f1' },
  [AUDIT.EXT_DELETE]: { label: 'Deleted extinguisher', color: '#dc2626' },
  [AUDIT.EXT_BULK_CREATE]: { label: 'Bulk added', color: '#16a34a' },
  [AUDIT.EXT_BULK_UPSERT]: { label: 'Bulk imported', color: '#0891b2' },
  [AUDIT.EXT_BULK_DELETE]: { label: 'Bulk deleted', color: '#dc2626' },
  [AUDIT.EXT_RESTORE]: { label: 'Restored extinguisher', color: '#16a34a' },
  [AUDIT.EXT_PURGE]: { label: 'Purged (permanent)', color: '#991b1b' },
  [AUDIT.BACKUP]: { label: 'Downloaded backup', color: '#0891b2' },
  [AUDIT.WF_QUOTATION_SUBMITTED]: { label: 'Quotation submitted', color: '#0891b2' },
  [AUDIT.WF_HPT_SUBMITTED]: { label: 'Hydrostatic test recorded', color: '#7c3aed' },
  [AUDIT.WF_SENT_TO_VENDOR]: { label: 'Sent to vendor', color: '#f59e0b' },
  [AUDIT.WF_RECEIVED]: { label: 'Received from vendor', color: '#16a34a' },
  [AUDIT.WF_REFILLED_CLOSED]: { label: 'Refilled & closed', color: '#0ea5e9' },
  [AUDIT.WF_RESOLVED_DEFECTS]: { label: 'Resolved defects', color: '#16a34a' },
  [AUDIT.DEFECT_CLOSE]: { label: 'Defect closed', color: '#16a34a' },
  [AUDIT.REPORT_CREATE]: { label: 'Report submitted', color: '#a855f7' },
  [AUDIT.REPORT_APPROVE]: { label: 'Report approved', color: '#16a34a' },
  [AUDIT.REPORT_REJECT]: { label: 'Report rejected', color: '#dc2626' },
  [AUDIT.USER_STATUS]: { label: 'User status', color: '#f59e0b' },
  [AUDIT.USER_ROLE]: { label: 'User role', color: '#6366f1' },
  [AUDIT.ORG_SETTINGS]: { label: 'Org settings', color: '#64748b' },

  // Safety signage
  'signage.create': { label: 'Added signage', color: '#16a34a' },
  'signage.update': { label: 'Edited signage', color: '#6366f1' },
  'signage.delete': { label: 'Deleted signage', color: '#dc2626' },
  // Mock drills
  'mockdrill.create': { label: 'Logged mock drill', color: '#16a34a' },
  'mockdrill.delete': { label: 'Deleted mock drill', color: '#dc2626' },
  // AED
  'aed.create': { label: 'Added AED', color: '#16a34a' },
  'aed.update': { label: 'Edited AED', color: '#6366f1' },
  'aed.service': { label: 'AED inspected', color: '#0ea5e9' },
  'aed.delete': { label: 'Deleted AED', color: '#dc2626' },
  'aed.restore': { label: 'Restored AED', color: '#16a34a' },
  'aed.purge': { label: 'Purged AED', color: '#991b1b' },
  'aed.bulk_create': { label: 'Bulk added AEDs', color: '#16a34a' },
  'aed.defect_approved': { label: 'AED defect approved', color: '#b45309' },
  'aed.defect_rejected': { label: 'AED defect dismissed', color: '#64748b' },
  // FAS
  'fas.create': { label: 'Added FAS device', color: '#16a34a' },
  'fas.qr_generate': { label: 'Generated FAS QR code', color: '#0891b2' },
  'fas.qr_backfill': { label: 'Generated missing FAS QR codes', color: '#0891b2' },
  'fas.update': { label: 'Edited FAS device', color: '#6366f1' },
  'fas.service': { label: 'FAS serviced', color: '#0ea5e9' },
  'fas.delete': { label: 'Deleted FAS device', color: '#dc2626' },
  'fas.restore': { label: 'Restored FAS device', color: '#16a34a' },
  'fas.purge': { label: 'Purged FAS device', color: '#991b1b' },
  'fas.bulk_create': { label: 'Bulk added FAS', color: '#16a34a' },
  'fas.defect_approved': { label: 'FAS defect approved', color: '#b45309' },
  'fas.defect_rejected': { label: 'FAS defect dismissed', color: '#64748b' },
}

export function auditMeta(action) {
  return AUDIT_META[action] || { label: action || 'Change', color: '#64748b' }
}

// Fields we report old→new changes for on an extinguisher edit.
const TRACKED_FIELDS = [
  'serialNo', 'type', 'capacity', 'entity', 'region', 'centerName',
  'dateOfDeployment', 'dateOfNextRefill', 'dateOfNextHPT', 'status',
]

function norm(v) {
  if (Array.isArray(v)) return v.join(', ')
  if (v === undefined || v === null) return ''
  return String(v)
}

/**
 * Build a concise "field: old → new" summary string from a before/after pair.
 * Pure + deterministic so it can be unit-tested. `after` may be a partial
 * (only changed keys); we compare each tracked field present in `after`.
 */
export function diffSummary(before = {}, after = {}) {
  const parts = []
  const keys = TRACKED_FIELDS.filter((k) => k in after)
  // physicalDefects handled separately (array)
  for (const k of keys) {
    const a = norm(before[k])
    const b = norm(after[k])
    if (a !== b) parts.push(`${k}: ${a || '—'} → ${b || '—'}`)
  }
  if ('physicalDefects' in after) {
    const a = norm(before.physicalDefects)
    const b = norm(after.physicalDefects)
    if (a !== b) parts.push(`defects: ${a || 'none'} → ${b || 'none'}`)
  }
  return parts.join('; ')
}
