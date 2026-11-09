// ─────────────────────────────────────────────────────────────────────────────
// Evidence attached to an escalation: CCTV footage, and an ethics report.
//
// CCTV is the awkward one. A useful clip is video, and the app's upload ceiling
// is 2 MB — most exports blow through that before the first minute. Refusing
// them would mean the footage that settles a dispute is the one thing not on
// the record, so an attachment here can be EITHER an uploaded file OR a
// reference: where the footage lives, which camera, and when.
//
// The reference is not a lesser option. Naming the camera and the timestamp
// means the clip can still be pulled off the DVR months later, whereas a link
// to someone's drive rots the day they leave. Both are kept.
// ─────────────────────────────────────────────────────────────────────────────

import { safeHref } from '../../../shared/safeUrl'

export const ATTACHMENT_KINDS = {
  cctv: {
    key: 'cctv',
    label: 'CCTV footage',
    // Video, images and the containers a DVR exports to.
    accept: 'video/*,image/*,.mp4,.avi,.mkv,.mov,.dav,.h264',
    hint: 'A clip, a still, or a reference to where the footage is held.',
    allowsReference: true,
  },
  ethics: {
    key: 'ethics',
    label: 'Ethics report',
    accept: 'application/pdf,image/*,.doc,.docx',
    hint: 'The report as filed, if one was raised.',
    allowsReference: false,
  },
}

const clean = (v) => String(v ?? '').trim()
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)

/** Shape one attachment for storage. Firestore rejects undefined. */
export function attachmentShape(a = {}) {
  return {
    id: clean(a.id) || `att-${Math.random().toString(36).slice(2, 10)}`,
    // 'file' carries a stored object; 'reference' points at footage held
    // elsewhere and has no bytes of its own.
    mode: a.mode === 'reference' ? 'reference' : 'file',
    name: clean(a.name),
    url: clean(a.url),
    path: clean(a.path),
    size: num(a.size),
    contentType: clean(a.contentType),
    // Reference-only fields. Kept on file attachments too (always defaulted) so
    // the shape never varies and a reader never has to branch on mode to read.
    location: clean(a.location),
    cameraRef: clean(a.cameraRef),
    recordedAt: clean(a.recordedAt),
    note: clean(a.note),
    addedAt: clean(a.addedAt),
    addedBy: clean(a.addedBy),
  }
}

export const shapeAttachments = (list) =>
  (Array.isArray(list) ? list : []).map(attachmentShape).filter(isUsable)

/**
 * Is this attachment worth keeping?
 *
 * A file row with no url is a failed upload and would render as a dead link; a
 * reference with nothing identifying it cannot lead anyone to the footage. Both
 * are dropped rather than stored as decoration.
 */
export function isUsable(a) {
  if (!a) return false
  if (a.mode === 'reference') return Boolean(a.location || a.cameraRef || a.note)
  return Boolean(a.url)
}

/**
 * Where a reference actually points, if anywhere safe.
 *
 * Run through the same scheme allow-list as every other stored URL — this one
 * is typed by hand, which is exactly the field a javascript: URL arrives in.
 */
export const referenceHref = (a) => (a?.location ? safeHref(a.location) : undefined)

/**
 * A one-line description of a reference, for a list that has no room for rows.
 *
 * Camera first: it is the part that still works when the link does not.
 */
export function describeReference(a = {}) {
  const parts = [clean(a.cameraRef), clean(a.recordedAt), clean(a.location) && 'link'].filter(Boolean)
  return parts.length ? parts.join(' · ') : clean(a.note) || 'Reference'
}

/** Counts for a list row, without loading anything. */
export function attachmentSummary(escalation = {}) {
  const att = escalation.attachments || {}
  const cctv = Array.isArray(att.cctv) ? att.cctv : []
  const ethics = Array.isArray(att.ethics) ? att.ethics : []
  return {
    cctv: cctv.length,
    ethics: ethics.length,
    total: cctv.length + ethics.length,
    // Worth distinguishing on a list: "we hold the clip" and "we know where it
    // is" are different levels of readiness for a dispute.
    cctvFiles: cctv.filter((a) => a.mode !== 'reference').length,
    cctvReferences: cctv.filter((a) => a.mode === 'reference').length,
  }
}
