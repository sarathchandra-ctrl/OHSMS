// Presign decision. The bearer token is not the authority for a delete: it
// stays valid after a suspension (S-19). This reads the profile the caller
// passes in from a live query. mayDeleteFile is the same predicate the
// deleteOrgFile job uses.

import { mayDeleteFile, isAppFilePath } from './lib/fileDelete.js'

const MEDICAL = '/medical-records/'

function approved(profile) {
  return Boolean(profile) && profile.status === 'approved' && profile.mustChangePassword !== true
}

/**
 * @param {{ op: string, path: string, profile: object | null }} input
 * `profile` is the live row. A role stamped on the token is not an argument.
 */
export function decidePresign({ op, path, profile }) {
  if (op !== 'put' && op !== 'delete' && op !== 'get') return { ok: false, reason: 'op' }
  if (!approved(profile)) return { ok: false, reason: 'profile' }
  const p = String(path || '')
  if (!isAppFilePath(p)) return { ok: false, reason: 'path' }
  if (op === 'delete') return mayDeleteFile(profile, p)
  // A fresh download link, for a signed-in, approved person. Medical files
  // only for the people who may read the medical records they belong to.
  if (op === 'get') {
    const medical = [MEDICAL, '/illness-files/'].some((m) => p.includes(m))
    if (medical && profile.role !== 'admin' && profile.role !== 'manager') {
      return { ok: false, reason: 'medical' }
    }
    return { ok: true }
  }
  if (profile.role === 'auditor') return { ok: false, reason: 'role' }
  if (p.includes(MEDICAL) && profile.role !== 'admin' && profile.role !== 'manager') {
    return { ok: false, reason: 'medical' }
  }
  return { ok: true }
}

/** May this live profile read stored files at all? */
export function mayReadFiles(profile) {
  return approved(profile)
}
