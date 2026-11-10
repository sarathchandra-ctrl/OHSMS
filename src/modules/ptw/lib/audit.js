// ─────────────────────────────────────────────────────────────────────────────
// Audit-log action constants + metadata (no Firestore here, so they're
// unit-testable). The Firestore write lives in data.js (logAudit).
// ─────────────────────────────────────────────────────────────────────────────

export const AUDIT = {
  PERMIT_CREATE: 'permit.create',
  PERMIT_EDIT: 'permit.edit',
  PERMIT_DELETE: 'permit.delete',
  APPROVE: 'permit.approve',
  REJECT: 'permit.reject',
  REJECTION_ANSWER: 'permit.rejectionAnswer',
  CLOSURE_REQUEST: 'permit.closureRequest',
  CLOSURE_DECISION: 'permit.closureDecision',
  EXTENSION_REQUEST: 'permit.extensionRequest',
  EXTENSION_SUGGESTION: 'permit.extensionSuggestion',
  EXTENSION_DECISION: 'permit.extensionDecision',
  OBSERVATION_SAFE: 'observation.safe',
  OBSERVATION_UNSAFE: 'observation.unsafe',
  USER_STATUS: 'user.status',
  USER_ROLE: 'user.role',
  ORG_SITES: 'org.sites',
}

export const AUDIT_META = {
  [AUDIT.PERMIT_CREATE]: { label: 'Permit created', color: '#16a34a' },
  [AUDIT.PERMIT_EDIT]: { label: 'Permit edited', color: '#6366f1' },
  [AUDIT.PERMIT_DELETE]: { label: 'Permit deleted', color: '#dc2626' },
  [AUDIT.APPROVE]: { label: 'Approved', color: '#16a34a' },
  [AUDIT.REJECT]: { label: 'Rejected', color: '#dc2626' },
  [AUDIT.REJECTION_ANSWER]: { label: 'Rejection answered', color: '#f59e0b' },
  [AUDIT.CLOSURE_REQUEST]: { label: 'Closure requested', color: '#f59e0b' },
  [AUDIT.CLOSURE_DECISION]: { label: 'Closure decision', color: '#0ea5e9' },
  [AUDIT.EXTENSION_REQUEST]: { label: 'Extension requested', color: '#a855f7' },
  [AUDIT.EXTENSION_SUGGESTION]: { label: 'Extension suggestion', color: '#7c3aed' },
  [AUDIT.EXTENSION_DECISION]: { label: 'Extension decision', color: '#7c3aed' },
  [AUDIT.OBSERVATION_SAFE]: { label: 'Safe observation', color: '#16a34a' },
  [AUDIT.OBSERVATION_UNSAFE]: { label: 'Unsafe — Non-compliance', color: '#991b1b' },
  [AUDIT.USER_STATUS]: { label: 'User status', color: '#f59e0b' },
  [AUDIT.USER_ROLE]: { label: 'User role', color: '#6366f1' },
  [AUDIT.ORG_SITES]: { label: 'Org sites', color: '#0891b2' },
}

export function auditMeta(action) {
  return AUDIT_META[action] || { label: action || 'Change', color: '#64748b' }
}
