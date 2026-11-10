// Look a lock up in the register by its number or its tag. Pure.
//
// Trace used to answer "who holds this lock and where has it been" from the
// isolation permits. Those were removed from the app at the owner's request
// (2026-11-10); the owner kept Trace as a lookup of the lock itself.

const norm = (v) => String(v || '').trim().toLowerCase()

/**
 * The lock a typed or scanned code names: { kind: 'empty' } for nothing
 * typed, { kind: 'none' } for no match, { kind: 'lock', lock } otherwise.
 */
export function traceLock(raw, locks = []) {
  const q = norm(raw)
  if (!q) return { kind: 'empty' }
  const lock = (locks || []).find((l) => norm(l.lockNo) === q || (l.tagNo && norm(l.tagNo) === q))
  return lock ? { kind: 'lock', lock } : { kind: 'none' }
}
